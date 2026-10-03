# Borrow Next Door · 成员 A 前端

## 运行

需要 Node.js，无需安装 npm 依赖。在此目录运行 `npm start`，访问 http://localhost:5173 。也可直接打开 `web/index.html`；推荐本地服务器，便于同源标签页演示。

## 需求分析与设计

PDF 赛题要求：以邮编为中心帮助邻居改善环境，展示空气、绿地和电力信息，鼓励共同参与；更多居民加入后产品更有用是 stretch goal。专题评分为 Innovation / Fit to brief / Quality / Interactivity 各 10，Teamwork / Presentation 各 5。

根据分工 Markdown，A 负责页面框架、社区首页、工具列表与发布、我的借入借出、状态提示及整合入口。B 的共享后端、C 的真实环境与地理信息、D 的正式任务模块仍由对应成员实现。

设计采用英文本地社区产品语气，奶油白与森林绿、低饱和工具插画、清晰的大按钮及移动端布局。插画由内联 SVG 构成，没有远程图片依赖。Google Fonts 不可用时自动回退系统字体。

三个视图：
- `#community`：邮编格式检查、社区内工具筛选和搜索、发布工具、环境卡及地图嵌入区。
- `#task`：四个任务模板、工具需求槽、匹配与缺口、自备确认、借用申请与独立成果记录；由 `web/task-module.js` 驱动。
- `#loans`：借入 / 借出、接受 / 拒绝、交接、确认归还、待处理申请取消。

## 已实现与边界

本版是**浏览器本地交互原型**。localStorage 保存样例数据，storage 事件同步同源标签页。不是共享后端，不证明不同设备协作，也没有并发原子性、认证、服务端权限或可信统计。Alice / Bob 只是演示身份。前端状态检查必须由 B 的服务端再次执行。

邮编只检查大致格式，不保证真实存在。默认 EH8 9YL 是样例社区。环境信息显示未连接，不伪造实时空气、电力或真实绿地结果。不同邮编有独立工具筛选；无工具时显示空状态。地图区域是有意保留的空位。

已区分发现工具、pending、accepted、on_loan、returned 与任务完成。归还不自动完成任务；任务成果允许发起者独立自报，完成后借还记录仍保留。成果面板按 6 个互相独立的指标计数，标注 recorded / self-reported，未采集的显示「Not collected yet」，不估算减碳。

## B：接口交接建议

当前对象保存在 `web/app.js` 的 `state` 中；API 路径为建议，需团队确认。接入时把 `persist` 及直接 state 修改替换为异步 API，请求期间禁用提交按钮、显示 loading；失败保留表单内容并显示服务端错误，成功重新获取工具、任务、本人请求。**尚未实现 HTTP 数据适配器与网络 loading 状态**，因为 B 的接口未提供。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/tools?postcode=… | 工具列表 |
| POST | /api/tools | name, category, description, postcode；owner 由服务端身份决定 |
| GET | /api/loans | 当前用户借入与借出记录 |
| POST | /api/loans | tool_id, task_id, requirement_id；原子保留 available 工具 |
| PATCH | /api/loans/:id | status；校验身份及合法转换 |
| GET / POST | /api/tasks | 用户任务读取与创建 |
| PATCH | /api/tasks/:id | 地点、自备确认、独立成果提交 |

Tool: `id, owner_id, name, category, description, status, postcode`。
LoanRequest: `id, tool_id, borrower_id, task_id, requirement_id, status, created_at, returned_at`。
Task: `id, creator_id, template_id, postcode, place_name, latitude, longitude, status, requirements[], outcome_note, impact{}, completed_at?`。
TaskRequirement: `id, task_id, category, quantity, slot, slot_total, source_type, loan_request_id`（见下方成员 D 一节）。
工具类别：`picker, gloves, spade, watering, rake`。模板：`cleanup, garden, street_trees, spring_bulbs`。

请求：`pending → accepted → on_loan → returned`；pending 可 rejected 或 cancelled。
工具：申请时 available → reserved；接受后仍 reserved；实际交接变 on_loan；拒绝、取消、归还恢复 available。
工具出借者可接受、拒绝、交接、确认归还；申请人可取消 pending 请求。B 必须用数据库事务保证一个工具只有一个有效请求。

## C / D：嵌入与组件位置

在 `web/integrations.js` 配置受信任的 URL，即可替换空位：

| key | 位置 | 负责人 |
|---|---|---|
| map | 首页右侧地图区 | C |
| air | 空气卡 | C |
| electricity | 电力卡 | C |
| tasks | 任务需求清单区 | D（已内置实现，仅作覆盖用） |
| outcomes | 成果统计区 | D（已内置实现，仅作覆盖用） |

iframe 默认 `sandbox="allow-scripts allow-forms allow-popups"`，不允许同源权限。需要 cookies、存储或认证的工具可能不可用；优先使用独立部署的嵌入页，评估信任后再修改 sandbox。对方服务必须允许 iframe，不能有阻止嵌入的 CSP / X-Frame-Options。当前 iframe 只提供显示位置，**没有身份 / 邮编 / 任务状态通信协议**。

D 的任务模块（`web/task-module.js`）**已直接内置**，`tasks` / `outcomes` 两个 key 留空时会渲染原生组件；只有在配置了 URL 时才会改为 iframe。A 的 `taskPage()` 只负责排版，不再自己判断“可申请 / 已落实”。

C 返回数据建议包含 `status, value, source, timestamp, scope`。空气、电力、绿地分别加载与失败降级。不要把可申请标为已落实，不能把区域环境变化归因于应用行动。

## D：任务匹配与成果模块

成员 D 交付 `web/task-module.js`（纯函数，无 DOM / 无存储 / 无网络）与 `test/` 下的测试；A 的 `taskPage()` 只负责把它的返回值渲染成 HTML。B 只需持久化数据结构，不需要理解匹配规则。

`web/task-module.js` 同时以 `<script>`（`window.BND_TASK`）和 CommonJS 方式导出，可以单独跑测试。

### 任务模板与需求槽

模板自带需求，`quantity: 2` 会展开成两个槽位，所以「2 个洒水壶，只凑到 1 个」在界面上可见。

| 模板 id | 名称 | 需求 | 耗材（只展示，不进入借还状态机） |
|---|---|---|---|
| `cleanup` | Clean up a green space | picker ×1, gloves ×1 | Rubbish bags |
| `garden` | Care for a community garden | spade ×1, gloves ×1, watering ×1 | Seeds or plants |
| `street_trees` | Water young street trees | watering ×2, gloves ×1 | — |
| `spring_bulbs` | Plant spring bulbs by the path | spade ×1, rake ×1, gloves ×1 | Bulbs |

`TaskRequirement` 每个槽位代表一件实物，`quantity` 固定为 1，`slot`/`slot_total` 表示它在第几件。`source_type` 为 `loan`（借）或 `self`（自备）。

### 借用请求与槽位的对应关系

权威链接是 `LoanRequest.requirement_id`（申请人选的是哪个槽位）；`TaskRequirement.loan_request_id` 同时写入一份，便于按规划文档的字段直接查询。`claimLoans()` 先读 `requirement_id`，对没有该字段的历史请求，按 `created_at` 顺序确定性地分配到同类别的空槽，绝不重复占用同一槽位。**B 的 `POST /api/loans` 需要接收并保存 `requirement_id`。**

### 槽位状态（界面文案的唯一来源）

| state | 含义 | 判定依据 |
|---|---|---|
| `confirmed` | 已落实 | 该槽位 `source_type='self'`，或存在 status 为 `accepted` / `on_loan` 的请求 |
| `pending` | 已发出申请，等出借者回应 | 存在 status 为 `pending` 的请求 |
| `available` | 可申请 | 同邮编（或 C 明确给出的附近邮编）有 `available` 的工具 |
| `missing` | 还缺工具 | 以上都不成立 |

`rejected` / `cancelled` 的请求完全忽略；`returned` 的请求保留为历史，但**不再算已落实**（工具已经不在手上了）。四个阶段分别有名字：`Request sent` → `Reservation accepted` → `Handed over` → `Returned`，界面上按阶段显示，不会被合并成一句话。

`wantedBoard()` 汇总所有未完成任务里 `missing` 的槽位——这就是「邻居越多，产品越有用」的直接体现：有人发布一件工具，缺口立刻消失，不需要任何人先借用。

### 成果面板

`impactReport(tasks, loans, {postcode, tools, names})` 返回 6 个互相独立的指标，每个都带 `source` / `basis`（`recorded` 或 `self-reported`）/ `scope` / `caveat`，并且带 `available` 字段：**没有采集过的数据返回 `available:false`，界面显示「Not collected yet」，而不是一个会被误读为 0 的数字。**

| key | 含义 | 来源 |
|---|---|---|
| `completed_loans` | 完成借用次数 | status 为 `returned` 的借用记录 |
| `actions_with_tools_confirmed` | 所需工具全部落实的任务数 | 已接受预约 + 自备确认（含已归还） |
| `completed_actions` | 完成社区行动数 | 发起者提交的任务完成记录 |
| `bags_collected` | 清理袋数 | 参与者自报 |
| `participant_minutes` | 参与时长（分钟） | 参与者自报 |
| `potential_avoided_purchases` | 潜在避免购买次数 | 问卷回答「借不到会买新品」且确实借到了工具 |

自报数字写在 `Task.impact = {bags_collected, participant_minutes, would_have_bought_new}`，叙述写在 `Task.outcome_note`，两者分开保存。同一把工具借十次只算十次借用，不会被说成少生产了十件新品。

### 两条明确的规则

- **借用完成不等于任务完成。** 归还会把槽位退回 `available` / `missing`；任务完成必须由发起者单独提交，提交时只警告还有未归还的工具，不阻止提交。
- **渲染不创建数据。** 打开任务页不会创建任务；只有选择模板、申请工具、勾选自备或提交成果时才会写入。B 接后端时不需要为「页面被浏览」造一条记录。

### 测试

`npm test` 运行 `test/task-module.test.cjs`（21 个纯函数用例）与 `test/e2e-demo.test.cjs`（用 `test/harness.cjs` 在 vm 里加载 `task-module.js` + `app.js`，模拟点击 / 勾选 / 提交，跑完整演示故事并断言落盘结果）。`node smoke-test.cjs` 是 A 原有的冒烟测试，仍会执行。

## 演示步骤

1. Alice 进入 Make a difference，选择清理绿地；垃圾夹缺失。
2. 切换 Bob，在首页 Lend a tool 发布 Litter picker。
3. 切回 Alice，任务清单出现可申请垃圾夹；申请后是 awaiting confirmation。
4. 切回 Bob → My borrowing → I’m lending，Accept request。
5. 实际交接后 Confirm handover，归还后 Confirm returned。
6. Alice 在任务页独立填写 outcome、袋数与时长并记录完成，查看 6 个互相独立的计数。
7. 演示前后可切换模板或勾选「I'll bring my own」，观察进度与「NEIGHBOURS NEEDED」缺口列表变化。
8. 要重置，在浏览器控制台运行 `localStorage.removeItem('bnd-demo-v1'); location.reload()`，只清除本项目数据。

## 检查

`npm run check` 检查 JavaScript 语法，`npm test` 运行纯函数测试与端到端演示测试。浏览器验收时检查桌面 / 手机布局、键盘导航、无效邮编、空工具列表、发布、双身份状态流转、刷新持久化、模板切换、自备勾选和任务成果独立计数。共享后端接入后还需要跨设备及并发预约测试。
