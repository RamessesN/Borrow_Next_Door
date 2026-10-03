# B · 数据层对接说明

> **一句话：你负责存，我负责算。** 你不需要理解工具匹配规则，只要按下面的字段存取，并让状态转换在服务端真的生效。

## 0. TL;DR — 你要做的三件事

1. 按 §2 建表 / 改 schema。相比 A 原来的契约只有 **3 处变化**（§3）。
2. `POST /api/loans` 接收 `requirement_id`，并在**一个事务里**完成「工具可用性检查 → 创建预约 → 工具置为 `reserved`」（§4.1）。
3. 服务端自己校验身份和状态转换，不信前端（§4.2–4.4）。

**必看**：§7 有一个会让多人流程悄悄算错的坑 —— `GET /api/loans` 不能只返回「当前用户的」请求。

## 1. 责任边界

| | 你（B） | 我（D） |
|---|---|---|
| 存什么 | 全部对象的持久化、身份、事务 | 什么都不存 |
| 算什么 | 无业务规则，只做校验 | 匹配、缺口、槽位状态、成果口径 |
| 状态转换 | 服务端执行并校验 | 只在前端提示，不作为安全边界 |
| 交付物 | `POST/PATCH` 接口 + DB | `web/task-module.js`（纯函数） |

## 2. 必须持久化的对象

### Tool

```json
{
  "id": "tool_1",
  "owner_id": "bob",
  "name": "The trusty watering can",
  "category": "watering",
  "description": "Green 5 litre can.",
  "status": "available",
  "postcode": "EH8 9YL",
  "latitude": 55.947687,
  "longitude": -3.187349
}
```

`category` 只能是：`picker` / `gloves` / `spade` / `watering` / `rake`。
`status` 只能是：`available` / `reserved` / `on_loan`。

`latitude` / `longitude` 是**可选**的，由 C 提供（出借者社区中心点）。缺了只是不显示距离，不会报错。

### Task

```json
{
  "id": "task_1",
  "creator_id": "alice",
  "template_id": "street_trees",
  "postcode": "EH8 9YL",
  "place_name": "Meadow by the path",
  "latitude": 55.947687,
  "longitude": -3.187349,
  "status": "planning",
  "outcome_note": "",
  "impact": {
    "bags_collected": null,
    "participant_minutes": null,
    "would_have_bought_new": null
  },
  "requirements": [ /* 见下 */ ],
  "created_at": "2026-10-03T09:00:00Z",
  "completed_at": null
}
```

`template_id` 只能是：`cleanup` / `garden` / `street_trees` / `spring_bulbs`（模板和需求由我定义，你只要能存字符串）。
`status` 只能是：`planning` / `completed`。

`impact` 三个字段都是**用户自报**，可以为 `null`（= 没填）。**`null` 和 `0` 意义完全不同**：`null` 表示没采集，面板显示 "Not collected yet"；`0` 表示填了 0。

### TaskRequirement

```json
{
  "id": "req_1",
  "task_id": "task_1",
  "category": "watering",
  "quantity": 1,
  "slot": 1,
  "slot_total": 2,
  "source_type": "loan",
  "loan_request_id": "loan_1"
}
```

- 一个槽位 = 一件实物。`street_trees` 要两个洒水壶 → 在同一个 task 下有两行 `category: "watering"`，`slot` 分别是 1 和 2，`slot_total` 都是 2。
- `quantity` 恒为 `1`（展开在 `buildRequirements()` 里做了），保留该字段是为了跟规划文档的字段表对齐。
- `source_type`：`loan`（要向邻居借）或 `self`（参与者自备）。用户勾选「I'll bring my own」时会从 `loan` 翻成 `self`。
- `loan_request_id`：**反范式指针**，跟 `LoanRequest.requirement_id` 同时写入。见 §4.2。

### LoanRequest

```json
{
  "id": "loan_1",
  "tool_id": "tool_1",
  "borrower_id": "alice",
  "task_id": "task_1",
  "requirement_id": "req_1",
  "status": "pending",
  "created_at": "2026-10-03T09:05:00Z",
  "returned_at": null
}
```

`status` 只能是：`pending` / `accepted` / `on_loan` / `returned` / `rejected` / `cancelled`。

## 3. 相比 A 原契约的 3 处变化

| 变化 | 原来 | 现在 | 为什么 |
|---|---|---|---|
| Task 的子结构 | `self: ["gloves"]`（类别数组） | `requirements: [TaskRequirement]` | 规划文档 §6 就要求正式 `TaskRequirement`；而且只有对象才能表达数量、槽位和「已落实」的依据 |
| LoanRequest | `{id, tool_id, borrower_id, task_id, status, created_at, returned_at}` | 多一个 `requirement_id` | 申请人选的是**哪个槽位**。只按类别匹配会让「两个洒水壶」无法区分，也会让两个并发申请撞在同一个槽位 |
| Task | 无成果字段 | 多一个 `impact: {bags_collected, participant_minutes, would_have_bought_new}` | 简报要求「清理袋数、参与时长」必须标注为自报，且必须和叙述性 `outcome_note` 分开 |

### 迁移

前端已经能自己处理老数据：加载时 `D.ensureRequirements(task)` 会把 `self: [...]` 转成 `requirements[]`（对应类别翻成 `source_type: "self"`），补上 `impact`，写回一次，之后不再重复。

所以：

- **如果你从 DB 读出来的还是老格式**，可以直接把它原样交给前端，前端会转。但**你写回去的时候请写新格式**，否则每次加载都要转一遍。
- **如果你在 DB 层做迁移**，就是：给每个 task 按 `template_id` 生成 requirements，把 `self` 里列出的类别对应的槽位 `source_type` 置为 `self`，删掉 `self` 字段。

## 4. 服务端必须自己保证的 4 条规则

前端已经会拦，但**前端拦不住并发，也拦不住直接调接口的人**。这 4 条是 Quality 那 10 分的检查点。

### 4.1 原子性：一个工具不能同时被两人预约成功

```
POST /api/loans { tool_id, task_id, requirement_id }
```

必须在一个事务 / 一条带条件的 UPDATE 里完成：

```
BEGIN
  tool = SELECT ... FOR UPDATE WHERE id = tool_id
  IF tool.status != 'available' THEN ROLLBACK, 409 tool_unavailable
  IF 该工具已有 status IN ('pending','accepted','on_loan') 的请求 THEN ROLLBACK, 409 already_requested
  INSERT loan (status='pending', requirement_id=...)
  UPDATE tool SET status='reserved'
COMMIT
```

返回 409 时前端会提示「This tool is no longer available to request.」——所以**请用 4xx，不要返回 200 + 错误文案**，否则前端会把这次失败当成成功。

### 4.2 一个槽位只有一个有效请求

- `requirement_id` 指向的槽位，不能有第二条 `status IN ('pending','accepted','on_loan')` 的请求。
- 同时把 `TaskRequirement.loan_request_id` 写成这个请求的 id（申请人创建时就写）。
- **`returned` / `rejected` / `cancelled` 时不要依赖这个指针来挡后续申请。** 前端已经做了：`D.slotIsClaimed()` 只把 `pending / accepted / on_loan` 当作占用，指针指向已结束的请求时不拦截。

  这一点很重要，因为**同一件工具被借第二次是简报里要计数的指标**（`completed_loans`）。如果按「指针非空就算占用」来挡，归还过的槽位就会永久锁死，用户看到「可申请」按钮但点了报错。见单测 `a finished request does not lock its slot forever` 和端到端测试 `the same tool can be borrowed again after it comes back`。

  你可以顺手在 `rejected` / `cancelled` 时清空指针（`returned` 时**保留**，因为需要历史），但**不要把它作为唯一防线**——服务端仍须按上一段的「有效请求」定义来校验。
- **我读的时候以 `LoanRequest.requirement_id` 为准**，`loan_request_id` 只作为历史请求的兜底。所以两个都写最稳，只写 `requirement_id` 也能工作。

### 4.3 谁能改哪个状态

| 转换 | 谁有权限 |
|---|---|
| `pending → accepted` | 工具出借者 |
| `pending → rejected` | 工具出借者 |
| `pending → cancelled` | 申请人 |
| `accepted → on_loan` | 工具出借者（实际交接后） |
| `on_loan → returned` | 工具出借者 |

规则：**`accepted` 只代表预约得到确认，`on_loan` 才是真的交出去了。** 这两个必须分开记，简报明确要求「预约得到确认」和「实际借出」是两件事，演示脚本要在两个窗口里分别展示。

工具状态随请求状态联动：

```
申请时          available → reserved
accepted        reserved  → reserved   （不动）
on_loan         reserved  → on_loan
rejected/cancelled/returned  →  available
```

`returned` 时必须写 `returned_at`（ISO 8601 UTC）。

### 4.4 不要信前端

- `owner_id` / `borrower_id` 由服务端身份决定，**不要从请求体里读**。
- 非法转换返回 4xx，不要静默忽略。
- 前端 `transition()` 里的权限判断只是 UX（防止按钮点了没反应），不是安全边界。

## 5. 序列化约定

| 项 | 约定 | 原因 |
|---|---|---|
| `postcode` | **存归一化后的值**：去空格、转大写、补成 `EH8 9YL` 形式 | 我在内存里会归一化，但存两种写法会让「同邮编」匹配漏掉邻居 |
| 时间戳 | ISO 8601 UTC 字符串（`2026-10-03T09:05:00Z`） | 我用字符串比较做「最旧优先」的确定性槽位分配，格式不一致会排错 |
| 数字 | 用 JSON number，不要用字符串 | `bags_collected: "3"` 我会转成 3，但 `participant_minutes: "90 min"` 会变成 `null` |
| 没填的值 | 用 `null`，**不要用 `""` 或 `0`** | `""` 会被当成「没填」，`0` 会被当成「填了 0」。这两个在成果面板上显示完全不同 |
| id | 字符串 | 我不关心格式 |

## 6. 接口清单

沿用 A 在 README 里定的路径。★ 是相对于原表新增的字段。

| 方法 | 路径 | 关键字段 | 谁用 |
|---|---|---|---|
| GET | `/api/tools?postcode=…` | 全部状态，不要只返回 available | A 的社区页 + 我的匹配 |
| POST | `/api/tools` | name, category, description, postcode；owner 由服务端定 | A |
| GET | `/api/loans` | 当前用户借入与借出 | A 的借入借出页 |
| ★ GET | `/api/tasks/:id/loans` | **该任务的全部请求**（所有人） | 我 — 见 §7 |
| POST | `/api/loans` | tool_id, task_id, ★ requirement_id | A 的按钮 + 我 |
| PATCH | `/api/loans/:id` | status；校验身份与合法转换 | A |
| GET | `/api/tasks?postcode=…` | 该邮编的全部任务 | 我的缺口板与成果面板 — 见 §7 |
| POST | `/api/tasks` | template_id, postcode, place_name, lat/lng, requirements[] | 我（A 代为提交） |
| PATCH | `/api/tasks/:id` | place_name / requirements（自备）/ outcome_note / impact / status | 我 |

## 7. ⚠️ 必须看：别把 loans 和 tasks 做成「只返回我的」

这是最容易悄悄算错的地方。

`web/app.js` 现在这样组装上下文：

```js
function taskContext(task){
  return { tools: state.tools, loans: state.loans, names, viewerId: user, task };
}
D.wantedBoard(state.tasks, ctx);
D.impactReport(state.tasks, state.loans, { postcode, tools: state.tools, names });
```

它传的是**整个邮编下的全量数据**。我的函数依赖这一点：

| 我需要的 | 用来做什么 | 如果只给「我的」会怎样 |
|---|---|---|
| 该邮编**全部**工具（含 reserved / on_loan） | `matchTools()` 判断「可申请」 | 会向用户推荐已经被别人预约的工具 |
| 该任务**全部**借用请求（所有人） | `claimLoans()` 判断槽位是否已落实 | 槽位明明被 Bob 预约了，Alice 的页面还是显示「可申请」/「还缺工具」——**正是简报点名要区分的场景会算错** |
| 该邮编**全部**任务 | `wantedBoard()` 缺口板；`actions_with_tools_confirmed` 指标 | 缺口板变成「我一个人的缺口」，那句「邻居越多越有用」的演示就不成立了 |

### 两个选择，任选一个

**方案 1（推荐，改动小）**：新增 `GET /api/tasks/:id/loans`，返回该任务的全部请求。字段只给渲染需要的、不含隐私的部分：

```json
[{ "id":"loan_1", "tool_id":"tool_1", "borrower_id":"alice",
   "task_id":"task_1", "requirement_id":"req_1",
   "status":"accepted", "created_at":"…", "returned_at":null }]
```

然后 `GET /api/tasks?postcode=…` 返回该邮编的全部任务（含 requirements）。

**方案 2（B 只肯给「我的」）**：那我就必须降级。具体是：

- 缺口板和成果面板改成只统计**当前用户**的记录，并在界面上写明 scope 变成「your activity only」——`impactReport()` 已经支持这个，只要不传 `postcode` 或改成传 `creatorId`。
- 「已落实」判断改成只信服务端返回的 `TaskRequirement.loan_request_id`，不再靠 `claimLoans()` 推断。

**告诉我你选哪个**，方案 2 我要改 `impactReport()` 的 scope 参数和面板文案，大概 20 行。

## 8. 验收清单

跑通这 6 条就说明对接成功。前 4 条和第 6 条**必须在两个浏览器窗口 / 两台设备**上做，同一窗口的假数据证明不了多人流程。

- [ ] Alice 选一个行动，Bob 在另一台设备发布一件它缺的工具；**不刷新页面**（或操作后刷新）Alice 就能看到「Available to request」。
- [ ] Alice 申请后，Bob 那一侧的请求状态是 `pending`，且这个工具在 Alice 的社区页显示为 `Reserved`，**不能再被第三个人申请**。
- [ ] 两个人**同时**申请同一件工具，只有一个成功，另一个收到 4xx。
- [ ] Bob 接受后，Alice 页面从「可申请」变成「已落实（Reservation accepted）」，但**不是**「已借出」；Bob 点交接后才变成 `on_loan`。
- [ ] Bob 确认归还后，工具回到 `available`，可以再次被申请；**任务状态仍然是 `planning`**（归还不等于任务完成）。
- [ ] Alice 提交成果后刷新页面，`impact.note`、`bags_collected`、`participant_minutes`、`would_have_bought_new` 和 `status: "completed"` 都还在。

## 9. 还没建库时怎么先跑起来

不用等。`web/app.js` 的 `seed()` + localStorage 已经是能跑的假后端，`npm test` 里的端到端测试就走这条路。

如果你想先做个最小 HTTP 后端给前端换，只要让三个 GET 返回**上面 §2 的 JSON 形状**、让 `POST /api/loans` 按 §4.1 校验，其余可以先返回假数据 —— 我的模块不区分数据来自 localStorage 还是 HTTP。

## 10. 我不需要的东西

- 我不做认证、不做权限（那是你的）。
- 我不需要你实现匹配规则。**请不要在服务端「帮我」算好「可申请 / 已落实」再发给我** —— 两套实现一定会不一致。把原始的工具、请求、任务给我就行。
- 我不需要你存任何计算结果的快照。`wantedBoard()` / `impactReport()` 每次都从原始数据重算，这也是它们能保证一致的原因。
