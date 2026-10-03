# B · 旧模型 → B 契约映射表

> **一句话：一页对照表。** 左边是 D 早期交接文档（旧模型）里的词汇，右边是 B 后端已交付契约（`/api/v1`）的事实。字段级细节见 `B-data-layer.md`，接口样例见 `backend/docs/API_SAMPLES.md`。

## 1. 路径与鉴权

| 旧模型 | B 契约 |
|---|---|
| 路径前缀 `/api`（A 建议，待团队确认） | `/api/v1`（已交付） |
| 无认证（前端 localStorage 演示） | `Authorization: Bearer <access_token>`；`POST /api/v1/demo/sessions` 登录 |
| 无幂等 | 写请求带 `Idempotency-Key`（UUID），重试复用同 key |
| 裸 JSON 响应 | 信封 `{data, meta}` / `{error:{code,message,details}, meta}` |

## 2. 冻结枚举

| 旧模型 | B 契约 |
|---|---|
| 类别 `picker` / `gloves` / `spade` / `watering` / `rake`（5 个） | `litter_picker` / `reusable_gloves` / `watering_can` / `hand_trowel`（4 个） |
| 模板 `cleanup` / `garden` / `street_trees` / `spring_bulbs`（4 个） | `park_cleanup`（litter_picker + reusable_gloves）/ `flowerbed_care`（watering_can + hand_trowel）（2 个） |
| Tool `status`：`available` / `reserved` / `on_loan`（存储字段） | Tool `availability`：`available` / `reserved` / `on_loan` / `archived`（**计算字段**，另有 `is_archived`） |
| Task `status`：`planning` / `completed` | Task `status`：`open` / `completed` |
| Loan `status`：`pending` / `accepted` / `on_loan` / `returned` / `rejected` / `cancelled` | 同左（未变） |

## 3. 对象字段

| 旧模型 | B 契约 |
|---|---|
| `Task.self: ["gloves"]`（类别数组） | `Task.requirements[]`（每类一行） |
| `Task.impact: {bags_collected, participant_minutes, would_have_bought_new}` | `Task.outcome: {note, bags_collected, volunteer_minutes, verification: "self_reported"}`；`would_have_bought_new` **已移除**，`participant_minutes` 改名 `volunteer_minutes` |
| `TaskRequirement.slot` / `slot_total`（槽位编号） | 删除槽位编号；每类需求一行，`quantity` 恒为 1 |
| `TaskRequirement.source_type: "loan" \| "self"` | `TaskRequirement.self_supplied: bool` |
| `TaskRequirement.loan_request_id`（反范式指针，双写） | `TaskRequirement.active_loan_id`（服务端派生，仅权限内可见） |
| 无任务级派生标记 | `Task.coordination_ready` / `Task.completion_eligible`（服务端派生布尔） |
| 无需求级派生状态 | `TaskRequirement.state`：`self_supplied` / `pending` / `confirmed` / `in_use` / `fulfilled` / `match_available` / `missing` |
| 无候选工具 | `TaskRequirement.candidate_tool_ids`（≤5，2000m 内可申请工具） |
| `Task.place_name` + 散坐标 | `Task.place: {name, latitude, longitude, source, source_id}`；坐标距社区中心 ≤2000m |
| Tool 坐标可选、由 C 塞进对象 | Tool 响应内嵌 `community`（含中心点与 `source_kind`）+ `distance_m`（服务端计算） |
| `LoanRequest.requirement_id`（旧模型已有） | `Loan.requirement_id`（保留；允许 `null` = 独立借用） |

## 4. 状态机与动作

| 旧模型 | B 契约 |
|---|---|
| `PATCH /api/loans/{id}` 改 status | 动作端点 `POST /api/v1/loans/{id}/accept\|reject\|cancel\|hand-over\|return` |
| 工具状态由前端联动 | `availability` 由服务端按借用 / 归档派生 |
| 任务完成 = 改 status | `POST /api/v1/tasks/{id}/complete`（body `outcome_note` / `bags_collected` / `volunteer_minutes`），任务仍 `open` 且创建者本人提交即可；工具清单不参与判定（2026-10-03 决定，原 `TASK_NOT_READY` 检查已移除） |
| 自备 = 改 `source_type` | `PUT /api/v1/tasks/{id}/requirements/{rid}/self-supply`（body `{"self_supplied": bool}`） |
| 并发靠前端拦 | 服务端部分唯一索引：409 `TOOL_UNAVAILABLE` / `REQUIREMENT_OCCUPIED` |

## 5. 权限与可见性

| 旧模型 | B 契约 |
|---|---|
| 前端演示无权限 | 他人私有资源 404 `NOT_FOUND`；越权 403 `FORBIDDEN` / `SELF_BORROW_FORBIDDEN` |
| `GET /api/loans` 返回「我的」 | `GET /api/v1/loans?role=borrower\|owner`（本人视角） |
| 缺口板需要全量任务 | `GET /api/v1/tasks?scope=community&community_id=<id>`（社区公开摘要，含 `requirements[].state` 与 `candidate_tool_ids`） |
| 工具列表按 postcode 过滤 | `GET /api/v1/tools?community_id=<id>&radius_m=2000`（服务端放宽 + 排序 + `distance_m`） |

## 6. 序列化

| 旧模型 | B 契约 |
|---|---|
| 时间格式自定 | ISO 8601 UTC（`Z` 结尾） |
| 未填值口径不一 | 未填一律 `null`；`null` ≠ `0`（未采集 vs 填了 0） |
| 距离文案自定 | `distance_m` 为邮编中心点直线估计；无参照社区为 `null`，不填 0 |
