# B · 后端已交付契约（数据层）

> **一句话：本文档是 B 后端已交付的事实契约，不是任务书。** A / C / D 按本文档对接；与旧交接模型的差异见 §8，逐字段映射见 `docs/handoff/B-backend-contract.md`。
>
> 证据：`backend/docs/API_SAMPLES.md`（可复制 curl 全表 + 错误码表）、`backend/docs/TEST_REPORT.md`（156 项测试全绿）。

## 1. 通用约定

### 1.1 路径与鉴权

- 所有业务路径前缀 `/api/v1`，Base URL `http://127.0.0.1:8000`。
- 鉴权头：`Authorization: Bearer <access_token>`。
- 登录：`POST /api/v1/demo/sessions`，body `{"user_alias": "alice", "access_code": "<DEMO_ACCESS_CODE>"}`。演示账号 `alice` / `bob` / `carol` 是 **demo account**（非真实注册，不存密码）。访问码由团队运行时配置（环境变量 `DEMO_ACCESS_CODE`，≥16 字符），不写入源码与文档。
- 除 `GET /health/live`、`GET /health/ready` 与 demo 登录外，所有端点要求 Bearer token；缺失 / 无效 / 过期 / 已注销一律 401 `UNAUTHENTICATED`。

### 1.2 成功与错误信封

- 成功：`{"data": <对象|数组>, "meta": {"request_id": "...", ...}}`；列表的 `meta` 另含 `limit` / `offset` / `total`（默认 limit=20，范围 1–100）。
- 错误：`{"error": {"code": "...", "message": "...", "details": {}}, "meta": {"request_id": "..."}}`。错误码全表见 `backend/docs/API_SAMPLES.md` 附录 B。

### 1.3 幂等（Idempotency-Key）

- 除登录 / 注销外的所有业务写请求（POST/PUT）要求 `Idempotency-Key` 头，格式为 UUID。
- **一次用户意图生成一个 UUID；网络重试复用同一个 key。** 同 actor/key 相同请求返回原结果（响应头 `Idempotency-Replayed: true`）；同 key 不同意图返回 409 `IDEMPOTENCY_KEY_REUSED`。
- 缺失或格式不符：400 `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`。

### 1.4 时间与距离

- 所有时间字段为 ISO 8601 UTC（`Z` 结尾），如 `2026-10-03T10:05:00Z`。
- `distance_m` 是**邮编中心点直线距离估计**（Haversine），不是住所距离或步行距离；无参照社区时为 `null`，不填 0 冒充已计算。

## 2. 冻结枚举（不可改名）

### 2.1 工具类别（4 个）

`litter_picker`、`reusable_gloves`、`watering_can`、`hand_trowel`。

### 2.2 任务模板（2 个）

| 模板 id | 需求 |
|---|---|
| `park_cleanup` | `litter_picker` ×1、`reusable_gloves` ×1 |
| `flowerbed_care` | `watering_can` ×1、`hand_trowel` ×1 |

模板与需求由服务端冻结，客户端创建任务时不能传需求。`GET /api/v1/task-templates` 返回模板清单。

### 2.3 状态集合

| 对象 | 取值 |
|---|---|
| Tool `availability`（计算字段） | `available` / `reserved` / `on_loan` / `archived` |
| Task `status` | `open` / `completed` |
| Requirement `state`（服务端派生） | `self_supplied` / `pending` / `confirmed` / `in_use` / `fulfilled` / `match_available` / `missing` |
| Loan `status` | `pending` / `accepted` / `on_loan` / `returned` / `rejected` / `cancelled` |

## 3. 对象字段表

### 3.1 Tool

```json
{
  "id": "t1111111-1111-4111-8111-111111111111",
  "name": "Galvanised watering can",
  "category": "watering_can",
  "description": "5 litre watering can, good for flowerbeds.",
  "owner": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
  "community": {
    "id": "c1111111-1111-4111-8111-111111111111", "postcode": "EH8 9AB", "outcode": "EH8",
    "latitude": 55.944703, "longitude": -3.187417, "country": "Scotland",
    "source": "fixture", "source_kind": "fixture", "fetched_at": "2026-10-03T09:00:00Z"
  },
  "availability": "available",
  "is_archived": false,
  "distance_m": 0.0,
  "created_at": "2026-10-03T09:00:00Z",
  "updated_at": "2026-10-03T09:00:00Z"
}
```

- **没有存储的 `status` 字段。** `availability` 是服务端计算字段：`is_archived` → `archived`；存在 `on_loan` 借用 → `on_loan`；存在 `pending` / `accepted` 借用 → `reserved`；否则 `available`。
- `owner` / `community` 由服务端从当前会话确定，创建时客户端不能传。
- `distance_m` 相对请求的 `community_id` 中心点计算；无参照社区时为 `null`。
- 归档：`POST /api/v1/tools/{id}/archive`（仅所有者；存在有效借用时 409 `ACTIVE_LOAN_EXISTS`）。归档后 `availability: "archived"`，历史可读但不可申请。

### 3.2 Task

```json
{
  "id": "55555555-5555-4555-8555-555555555555",
  "title": "Saturday neighbourhood clean-up",
  "creator": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
  "community_id": "c1111111-1111-4111-8111-111111111111",
  "template_id": "park_cleanup",
  "place": {"name": "Demo clean-up meeting point", "latitude": 55.944703,
            "longitude": -3.187417, "source": "manual", "source_id": null},
  "status": "open",
  "requirements": [ /* 见 3.3 */ ],
  "coordination_ready": false,
  "completion_eligible": false,
  "outcome": null,
  "created_at": "2026-10-03T10:00:00Z",
  "completed_at": null
}
```

- `status` 只有 `open` / `completed` 两态（旧模型的 `planning` 已废弃，见 §8）。
- `place`：`{name, latitude, longitude, source, source_id}`，`source` ∈ `osm` / `manual` / `fixture`。place 坐标距用户社区中心必须 ≤2000m，否则 422 `OUT_OF_RANGE`。
- `requirements` 由服务端从模板生成，创建任务时客户端不能传。
- `coordination_ready` / `completion_eligible` 为服务端派生布尔：
  - `coordination_ready`：全部需求 state ∈ {`self_supplied`, `confirmed`, `in_use`, `fulfilled`}。
  - `completion_eligible`：全部需求 state ∈ {`self_supplied`, `in_use`, `fulfilled`}——注意 `confirmed` 不算：预约已接受但尚未交接，任务尚不可完成。
- `outcome`：完成前为 `null`；完成后为 `{"note": "...", "bags_collected": 4, "volunteer_minutes": 90, "verification": "self_reported"}`。**没有 `would_have_bought_new` 字段**（旧模型问卷字段已移除）。`bags_collected` / `volunteer_minutes` 为创建者自报，未填为 `null`——**`null` ≠ `0`**：`null` 表示未采集（界面显示 "Not collected yet"），`0` 表示填了 0。

### 3.3 TaskRequirement

```json
{
  "id": "66666666-6666-4666-8666-666666666666",
  "category": "litter_picker",
  "quantity": 1,
  "self_supplied": false,
  "state": "missing",
  "active_loan_id": null,
  "candidate_tool_ids": []
}
```

- 每类需求一行，`quantity` 恒为 1（模板展开在服务端完成）。
- `self_supplied`：bool。创建者通过 `PUT /api/v1/tasks/{task_id}/requirements/{requirement_id}/self-supply`（body `{"self_supplied": true|false}`）勾选 / 取消自备。
- `state`：服务端派生（§4.3），客户端不要自行计算。
- `active_loan_id`：该需求当前有效借用（`pending` / `accepted` / `on_loan`）的 id；仅对任务创建者与借用双方可见，无关用户为 `null`。
- `candidate_tool_ids`：2000m 内可申请的可用工具 id，**最多 5 个**，按距离 / 时间稳定排序。

### 3.4 Loan

```json
{
  "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "tool_id": "t3333333-3333-4333-8333-333333333333",
  "tool_name": "Reusable gardening gloves",
  "owner_id": "u2222222-2222-4222-8222-222222222222",
  "borrower_id": "u1111111-1111-4111-8111-111111111111",
  "requirement_id": "77777777-7777-4777-8777-777777777777",
  "task_id": "55555555-5555-4555-8555-555555555555",
  "status": "pending",
  "note": "For our neighbourhood clean-up.",
  "created_at": "2026-10-03T10:10:00Z",
  "updated_at": "2026-10-03T10:10:00Z",
  "accepted_at": null,
  "handed_over_at": null,
  "returned_at": null,
  "rejected_at": null,
  "cancelled_at": null
}
```

- `requirement_id` 关联任务需求；允许 `null`（独立借用，不改变任务需求状态）。
- `owner_id` / `borrower_id` 由服务端身份决定，创建时客户端不能传。
- 各时间戳在对应动作发生时写入；未发生为 `null`。

## 4. 状态机与派生规则

### 4.1 Loan 状态机

```
pending ──accept──> accepted ──hand-over──> on_loan ──return──> returned
   │                   │
   ├──reject──> rejected
   └──cancel──> cancelled        accepted ──cancel──> cancelled
```

| 动作端点 | 合法前置 | 权限 |
|---|---|---|
| `POST /api/v1/loans/{id}/accept` | `pending` | 仅工具所有者 |
| `POST /api/v1/loans/{id}/reject` | `pending` | 仅工具所有者 |
| `POST /api/v1/loans/{id}/cancel` | `pending` / `accepted` | 借用双方 |
| `POST /api/v1/loans/{id}/hand-over` | `accepted` | 仅工具所有者 |
| `POST /api/v1/loans/{id}/return` | `on_loan` | 仅工具所有者 |

- 非法转换：409 `INVALID_TRANSITION`。
- 工具 `availability` 随借用状态联动：申请时 `available → reserved`；`accepted` 保持 `reserved`；`hand-over` 后 `on_loan`；`reject` / `cancel` / `return` 释放回 `available`。
- **`accepted` 只代表预约得到确认，`on_loan` 才是真的交出去了**——两个事实分开记录，界面不得合并成一句话。

### 4.2 Task 状态机

```
open ──POST /api/v1/tasks/{id}/complete──> completed
```

- 完成条件：`completion_eligible` 为 true（全部需求已落实：自备 / 已交接 / 已归还）。存在 `pending` / `accepted` 需求或需求未满足时 409 `TASK_NOT_READY`；重复完成 409 `TASK_ALREADY_COMPLETED`。
- 完成请求体：`{"outcome_note": "...", "bags_collected": 4, "volunteer_minutes": 90}`；服务端写入 `outcome` 并置 `verification: "self_reported"`。
- 归还工具**不会**自动完成任务——任务完成必须由创建者单独提交。

### 4.3 Requirement state 派生（服务端权威）

| state | 判定 |
|---|---|
| `pending` | 存在 `pending` 借用 |
| `confirmed` | 存在 `accepted` 借用 |
| `in_use` | 存在 `on_loan` 借用 |
| `fulfilled` | 无有效借用，但存在已交接后归还（`returned` 且 `handed_over_at` 非空）的历史 |
| `self_supplied` | 无借用历史且 `self_supplied: true` |
| `match_available` | 以上都不成立，但 2000m 内有可申请的可用工具 |
| `missing` | 以上都不成立 |

## 5. 权限与可见性

- **他人私有资源 404**：非借用双方查询他人借用（详情 / 事件 / 动作）一律 404 `NOT_FOUND`——不可见语义，不泄露存在性。
- **越权 403**：对可见资源执行不允许的动作（借自己的工具 403 `SELF_BORROW_FORBIDDEN`；非所有者接受 403 `FORBIDDEN`；非创建者改自备 403 `FORBIDDEN`）。
- 任务列表：`GET /api/v1/tasks?scope=mine`（默认）返回本人任务；`scope=community` 必填 `community_id`，返回社区公开摘要（不含他人借用详情）。
- 借用列表：`GET /api/v1/loans?role=borrower`（默认，本人借入）或 `role=owner`（本人拥有工具的借出）；`status` 可过滤。

## 6. 并发与唯一性

数据库迁移含部分唯一索引，保证同一工具 / 同一需求最多一条有效借用：

| 冲突 | 错误码 |
|---|---|
| 工具已被预留或借出 | 409 `TOOL_UNAVAILABLE` |
| 需求被另一借用占用 | 409 `REQUIREMENT_OCCUPIED` |
| 工具已归档 | 409 `TOOL_ARCHIVED` |
| 归档时存在有效借用 | 409 `ACTIVE_LOAN_EXISTS` |
| 需求存在有效借用或有借出历史时改自备 | 409 `REQUIREMENT_LOCKED` |
| 需求已自备再改回 | 409 `REQUIREMENT_ALREADY_FULFILLED` |

并发证据：`backend/docs/TEST_REPORT.md` §3.2（`tests/test_loans_concurrency.py` 3 项全绿）。

## 7. 端点全表

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/demo/sessions` | 登录（公开） |
| POST | `/api/v1/sessions/logout` | 注销 |
| GET | `/api/v1/me` | 当前用户 |
| GET | `/api/v1/task-templates` | 模板清单（2 个冻结模板） |
| GET | `/api/v1/tasks?scope=mine\|community[&community_id=]` | 任务列表 |
| POST | `/api/v1/tasks` | 创建任务（`template_id`, `title`, `place`） |
| GET | `/api/v1/tasks/{id}` | 任务详情（含需求派生状态） |
| PUT | `/api/v1/tasks/{id}/requirements/{rid}/self-supply` | 标记 / 取消自备（body `{"self_supplied": bool}`） |
| POST | `/api/v1/tasks/{id}/complete` | 完成任务（`outcome_note`, `bags_collected`, `volunteer_minutes`） |
| GET | `/api/v1/tools?community_id=&radius_m=` | 工具列表（`radius_m` 允许 100–2000） |
| POST | `/api/v1/tools` | 发布工具（`name`, `category`, `description`） |
| GET | `/api/v1/tools/{id}` | 工具详情 |
| POST | `/api/v1/tools/{id}/archive` | 归档（仅所有者） |
| GET | `/api/v1/loans?role=borrower\|owner[&status=]` | 借用列表 |
| POST | `/api/v1/loans` | 申请借用（`tool_id`, `requirement_id`, `note?`） |
| GET | `/api/v1/loans/{id}` | 借用详情 |
| GET | `/api/v1/loans/{id}/events` | 借用事件 |
| POST | `/api/v1/loans/{id}/accept` | 接受（所有者） |
| POST | `/api/v1/loans/{id}/reject` | 拒绝（所有者） |
| POST | `/api/v1/loans/{id}/cancel` | 取消（双方，`pending` / `accepted`） |
| POST | `/api/v1/loans/{id}/hand-over` | 交接（所有者） |
| POST | `/api/v1/loans/{id}/return` | 确认归还（所有者） |
| GET | `/api/v1/communities/resolve?postcode=` | 邮编解析 |
| GET | `/api/v1/communities/{id}/environment` | 环境卡（各 provider 独立 envelope） |
| GET | `/api/v1/communities/{id}/impact` | 社区 impact |
| GET | `/health/live`、`/health/ready` | 健康检查（公开） |

所有写请求（除登录 / 注销）带 `Idempotency-Key`。完整 curl 样例见 `backend/docs/API_SAMPLES.md`。

## 8. 与旧交接模型的差异

旧模型（D 早期交接文档中的词汇）与 B 已交付契约的逐字段映射见 `docs/handoff/B-backend-contract.md`。要点：

| 旧模型 | B 契约 | 说明 |
|---|---|---|
| 类别 `picker` / `gloves` / `spade` / `watering` / `rake` | `litter_picker` / `reusable_gloves` / `watering_can` / `hand_trowel` | 4 个冻结 slug |
| 模板 `cleanup` / `garden` / `street_trees` / `spring_bulbs` | `park_cleanup` / `flowerbed_care` | 2 个冻结模板 |
| Task `status: planning` | `status: open` | 两态：`open` / `completed` |
| `impact: {bags_collected, participant_minutes, would_have_bought_new}` | `outcome: {note, bags_collected, volunteer_minutes, verification}` | 问卷字段 `would_have_bought_new` 已移除；`participant_minutes` 改名 `volunteer_minutes` |
| `TaskRequirement.slot` / `slot_total` | 单需求行（每类一行，无槽位编号） | 旧「一个槽位 = 一件实物」的编号机制删除 |
| `TaskRequirement.source_type: loan\|self` | `self_supplied: bool` | 自备是布尔标记 |
| `TaskRequirement.loan_request_id` 反范式指针 | `active_loan_id`（派生，权限内可见） | 不再双写指针 |
| Tool 存储 `status` | 计算字段 `availability`（+ `is_archived`） | 状态由借用与归档派生 |
| `GET /api/tools`、`PATCH /api/loans/{id}` | `GET /api/v1/tools?community_id=`、动作端点 `POST /api/v1/loans/{id}/accept\|reject\|cancel\|hand-over\|return` | 路径前缀 `/api/v1`；状态变更走专用动作端点 |

## 9. 「已落实 vs 可申请」的权威答案（旧 §7 精神的解法）

旧交接文档 §7 担心「只返回我的数据」会让多人流程悄悄算错。B 契约的解法：

1. **社区范围任务列表**：`GET /api/v1/tasks?scope=community&community_id=<id>` 返回该社区全部任务的公开摘要，其中 `requirements[].state` 与 `candidate_tool_ids` 是服务端派生的公开字段——「已落实」（`confirmed` / `in_use` / `fulfilled` / `self_supplied`）与「可申请」（`match_available` + `candidate_tool_ids`）的区分由服务端直接给出，前端不需要自己推断。
2. **个人视角**：`GET /api/v1/tasks?scope=mine` 返回本人任务（含 `active_loan_id` 等权限内字段）；`GET /api/v1/loans?role=borrower|owner` 分别返回本人借入与借出。
3. **工具列表**：`GET /api/v1/tools?community_id=<id>&radius_m=2000` 返回社区内全部工具（含 `reserved` / `on_loan` / `archived`），`availability` 为服务端计算——前端不会向用户推荐已被别人预约的工具。

前端（D 的模块）应直接消费 `state` / `candidate_tool_ids` / `availability`，不要在客户端重算匹配规则。

## 10. 验收清单

- [ ] 两个浏览器窗口分别登录 alice / bob（demo 账号），完成一次「发布 → 建任务 → 申请 → 接受 → 交接 → 归还」全流程，工具 `availability` 回到 `available`。
- [ ] 两人同时申请同一件工具：只有一个成功，另一个收到 409 `TOOL_UNAVAILABLE`。
- [ ] 归还后任务状态仍是 `open`；创建者提交成果后 `status: "completed"`，`outcome.note` / `bags_collected` / `volunteer_minutes` 持久化。
- [ ] 他人借用详情对第三方 404；越权动作 403。
- [ ] 全部 156 项后端测试见 `backend/docs/TEST_REPORT.md`。
