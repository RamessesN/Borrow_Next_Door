# Borrow Next Door 后端接口样例（API_SAMPLES）

本文档按规格 8.2 接口清单、8.4 请求示例与 8.5 错误码表整理，供 A（前端）集成时复制使用。

> **状态说明**：tools / loans / tasks / community 端点正在由并行任务实现中。本文档按规格契约编写，**实际响应以 OpenAPI 为准**（http://127.0.0.1:8000/openapi.json），实现落地后核对一次即可。
>
> 文中 UUID（资源 ID、Idempotency-Key）均为示例；实际调用必须使用上一步响应中返回的真实 ID。

## 通用约定

### Base URL 与 token

```bash
BASE=http://127.0.0.1:8000
# 第 1 步登录后，从响应 data.access_token 取得：
TOKEN=<登录返回的 access_token>
# 第 8–10 步（接受/交接/归还）切换为工具所有者 bob 的 token：
BOB_TOKEN=<bob 登录返回的 access_token>
```

### 成功与错误信封

成功：`{"data": <对象|数组>, "meta": {"request_id": "...", ...}}`；列表的 `meta` 另含 `limit`、`offset`、`total`（默认 limit=20，范围 1–100）。

错误：`{"error": {"code": "...", "message": "...", "details": {}}, "meta": {"request_id": "..."}}`。完整错误码表见附录 B。

### Idempotency-Key

- 除登录/注销外的所有业务写请求（POST/PUT）要求 `Idempotency-Key` 头，格式为 UUID。
- **一次用户意图生成一个 UUID；网络重试复用同一个 key**。同 actor/key 相同请求返回原结果（响应头 `Idempotency-Replayed: true`）；同 key 不同意图返回 409 `IDEMPOTENCY_KEY_REUSED`。
- 登录与注销不要求该头（认证接口不参与业务幂等存储）。

### 时间与距离

- 所有时间字段为 ISO 8601 UTC（`Z` 结尾），如 `2026-10-03T10:00:00Z`。
- `distance_m` 是**邮编中心点直线距离估计**（Haversine），不是住所距离或步行距离；无参照社区时为 `null`，不填 0 冒充已计算。

---

## 用户故事主线（按顺序）

### 1. 登录（demo 会话）

只需要 `user_alias`，**不需要访问码**（演示访问码已按用户决策移除，见
DECISIONS.md「移除演示访问码」）。旧客户端仍可传 `access_code`：该字段为可选、
直接被忽略（不会 422，也不参与任何校验）。

```bash
curl -s -X POST "$BASE/api/v1/demo/sessions" \
  -H "Content-Type: application/json" \
  -d '{ "user_alias": "alice" }'
```

成功（201）：

```json
{
  "data": {
    "access_token": "<opaque bearer token>",
    "token_type": "bearer",
    "expires_at": "2026-10-03T21:15:00Z",
    "user": {
      "id": "u1111111-1111-4111-8111-111111111111",
      "alias": "alice",
      "display_name": "Alice",
      "community_id": "c1111111-1111-4111-8111-111111111111"
    }
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（401 `UNAUTHENTICATED`：alias 不存在或未激活；同一 IP 每分钟超过 60 次
登录请求后 429 `RATE_LIMITED` 的宽松防刷限制）：

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication required.",
    "details": {}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 2. 当前用户

```bash
curl -s "$BASE/api/v1/me" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：

```json
{
  "data": {
    "id": "u1111111-1111-4111-8111-111111111111",
    "display_name": "Alice",
    "community": {
      "id": "c1111111-1111-4111-8111-111111111111",
      "postcode": "EH8 9AB",
      "outcode": "EH8",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "country": "Scotland",
      "source": "fixture",
      "source_kind": "fixture",
      "fetched_at": "2026-10-03T09:00:00Z"
    },
    "mode": "demo"
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（401 `UNAUTHENTICATED`，token 缺失/无效/过期/已注销）。

### 3. 任务模板

```bash
curl -s "$BASE/api/v1/task-templates" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：

```json
{
  "data": [
    {
      "id": "park_cleanup",
      "title": "Park cleanup",
      "description": "Collect litter at a local park. Bring bags; litter pickers and reusable gloves are borrowed from neighbours.",
      "requirements": [
        {"category": "litter_picker", "quantity": 1},
        {"category": "reusable_gloves", "quantity": 1}
      ]
    },
    {
      "id": "flowerbed_care",
      "title": "Flowerbed care",
      "description": "Water and weed a neighbourhood flowerbed. Borrow a watering can and hand trowel from nearby helpers.",
      "requirements": [
        {"category": "watering_can", "quantity": 1},
        {"category": "hand_trowel", "quantity": 1}
      ]
    }
  ],
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "limit": 20, "offset": 0, "total": 2}
}
```

关键错误（401 `UNAUTHENTICATED`）。

### 4. 创建任务

```bash
curl -s -X POST "$BASE/api/v1/tasks" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000001" \
  -d '{
    "template_id": "park_cleanup",
    "title": "Saturday neighbourhood clean-up",
    "place": {
      "name": "Demo clean-up meeting point",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "source": "manual",
      "source_id": null
    }
  }'
```

成功（201，服务端从模板生成需求，creator/community 由服务端确定）：

```json
{
  "data": {
    "id": "55555555-5555-4555-8555-555555555555",
    "title": "Saturday neighbourhood clean-up",
    "creator": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
    "community_id": "c1111111-1111-4111-8111-111111111111",
    "template_id": "park_cleanup",
    "place": {
      "name": "Demo clean-up meeting point",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "source": "manual",
      "source_id": null
    },
    "status": "open",
    "requirements": [
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "category": "litter_picker",
        "quantity": 1,
        "self_supplied": false,
        "state": "missing",
        "active_loan_id": null,
        "candidate_tool_ids": []
      },
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "category": "reusable_gloves",
        "quantity": 1,
        "self_supplied": false,
        "state": "match_available",
        "active_loan_id": null,
        "candidate_tool_ids": ["t3333333-3333-4333-8333-333333333333"]
      }
    ],
    "coordination_ready": false,
    "completion_eligible": false,
    "outcome": null,
    "created_at": "2026-10-03T10:00:00Z",
    "completed_at": null
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（422 `OUT_OF_RANGE`，place 坐标距用户社区中心超过 2000m；未知 `template_id` 为 422 `VALIDATION_ERROR`）：

```json
{
  "error": {
    "code": "OUT_OF_RANGE",
    "message": "A value is outside the allowed range.",
    "details": {"fields": [{"field": "place", "message": "place must be within 2000 m of the user's community"}]}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 5. 列工具

```bash
curl -s "$BASE/api/v1/tools?community_id=c1111111-1111-4111-8111-111111111111&radius_m=2000" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200，`availability` 为服务端计算字段；同社区优先，按距离、created_at、id 稳定排序）：

```json
{
  "data": [
    {
      "id": "t1111111-1111-4111-8111-111111111111",
      "name": "Galvanised watering can",
      "category": "watering_can",
      "description": "5 litre watering can, good for flowerbeds.",
      "owner": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
      "community": {
        "id": "c1111111-1111-4111-8111-111111111111",
        "postcode": "EH8 9AB",
        "outcode": "EH8",
        "latitude": 55.944703,
        "longitude": -3.187417,
        "country": "Scotland",
        "source": "fixture",
        "source_kind": "fixture",
        "fetched_at": "2026-10-03T09:00:00Z"
      },
      "availability": "available",
      "is_archived": false,
      "distance_m": 0.0,
      "created_at": "2026-10-03T09:00:00Z",
      "updated_at": "2026-10-03T09:00:00Z"
    }
  ],
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "limit": 20, "offset": 0, "total": 3}
}
```

关键错误（422 `VALIDATION_ERROR`，`community_id` 必填；`radius_m` 允许 100–2000）：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {"fields": [{"field": "community_id", "message": "field required"}]}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 6. 发布工具

```bash
curl -s -X POST "$BASE/api/v1/tools" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000002" \
  -d '{
    "name": "Neighbourhood litter picker",
    "category": "litter_picker",
    "description": "Reusable picker for a local clean-up."
  }'
```

成功（201，owner/community 由服务端从当前会话确定，客户端不能传）：

```json
{
  "data": {
    "id": "44444444-4444-4444-8444-444444444444",
    "name": "Neighbourhood litter picker",
    "category": "litter_picker",
    "description": "Reusable picker for a local clean-up.",
    "owner": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
    "community": {
      "id": "c1111111-1111-4111-8111-111111111111",
      "postcode": "EH8 9AB",
      "outcode": "EH8",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "country": "Scotland",
      "source": "fixture",
      "source_kind": "fixture",
      "fetched_at": "2026-10-03T09:00:00Z"
    },
    "availability": "available",
    "is_archived": false,
    "distance_m": null,
    "created_at": "2026-10-03T10:05:00Z",
    "updated_at": "2026-10-03T10:05:00Z"
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（422 `VALIDATION_ERROR`，category 不在冻结枚举 `litter_picker` / `reusable_gloves` / `watering_can` / `hand_trowel` 内）：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": {"fields": [{"field": "category", "message": "unexpected value; permitted: 'litter_picker', 'reusable_gloves', 'watering_can', 'hand_trowel'"}]}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 7. 申请借用

alice 申请借用 bob 的 reusable_gloves（`t3333333-3333-4333-8333-333333333333`），并关联到 park_cleanup 任务的需求 `77777777-7777-4777-8777-777777777777`：

```bash
curl -s -X POST "$BASE/api/v1/loans" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000003" \
  -d '{
    "tool_id": "t3333333-3333-4333-8333-333333333333",
    "requirement_id": "77777777-7777-4777-8777-777777777777",
    "note": "For our neighbourhood clean-up."
  }'
```

成功（201，状态 `pending`；不传 `borrower_id`/`status`，由服务端确定）：

```json
{
  "data": {
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
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（409 `TOOL_UNAVAILABLE`，工具已被预留或借出；借自己的工具为 403 `SELF_BORROW_FORBIDDEN`；需求被另一借用占用为 409 `REQUIREMENT_OCCUPIED`）：

```json
{
  "error": {
    "code": "TOOL_UNAVAILABLE",
    "message": "This tool is already reserved or on loan.",
    "details": {}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 8. 接受申请（工具所有者 bob）

```bash
curl -s -X POST "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/accept" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000004"
```

成功（200，状态 `accepted`）：

```json
{
  "data": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "tool_id": "t3333333-3333-4333-8333-333333333333",
    "tool_name": "Reusable gardening gloves",
    "owner_id": "u2222222-2222-4222-8222-222222222222",
    "borrower_id": "u1111111-1111-4111-8111-111111111111",
    "requirement_id": "77777777-7777-4777-8777-777777777777",
    "task_id": "55555555-5555-4555-8555-555555555555",
    "status": "accepted",
    "note": "For our neighbourhood clean-up.",
    "created_at": "2026-10-03T10:10:00Z",
    "updated_at": "2026-10-03T10:12:00Z",
    "accepted_at": "2026-10-03T10:12:00Z",
    "handed_over_at": null,
    "returned_at": null,
    "rejected_at": null,
    "cancelled_at": null
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（409 `INVALID_TRANSITION`，借用不在 `pending`；非所有者操作为 403 `FORBIDDEN`）：

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "The loan is not in a state that allows this action.",
    "details": {}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 9. 交接借出（工具所有者 bob）

```bash
curl -s -X POST "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/hand-over" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000005"
```

成功（200，状态 `on_loan`）：

```json
{
  "data": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "tool_id": "t3333333-3333-4333-8333-333333333333",
    "tool_name": "Reusable gardening gloves",
    "owner_id": "u2222222-2222-4222-8222-222222222222",
    "borrower_id": "u1111111-1111-4111-8111-111111111111",
    "requirement_id": "77777777-7777-4777-8777-777777777777",
    "task_id": "55555555-5555-4555-8555-555555555555",
    "status": "on_loan",
    "note": "For our neighbourhood clean-up.",
    "created_at": "2026-10-03T10:10:00Z",
    "updated_at": "2026-10-03T10:20:00Z",
    "accepted_at": "2026-10-03T10:12:00Z",
    "handed_over_at": "2026-10-03T10:20:00Z",
    "returned_at": null,
    "rejected_at": null,
    "cancelled_at": null
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（409 `INVALID_TRANSITION`，借用不在 `accepted`）。

### 10. 确认归还（工具所有者 bob）

```bash
curl -s -X POST "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/return" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000006"
```

成功（200，状态 `returned`，工具释放）：

```json
{
  "data": {
    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "tool_id": "t3333333-3333-4333-8333-333333333333",
    "tool_name": "Reusable gardening gloves",
    "owner_id": "u2222222-2222-4222-8222-222222222222",
    "borrower_id": "u1111111-1111-4111-8111-111111111111",
    "requirement_id": "77777777-7777-4777-8777-777777777777",
    "task_id": "55555555-5555-4555-8555-555555555555",
    "status": "returned",
    "note": "For our neighbourhood clean-up.",
    "created_at": "2026-10-03T10:10:00Z",
    "updated_at": "2026-10-03T11:00:00Z",
    "accepted_at": "2026-10-03T10:12:00Z",
    "handed_over_at": "2026-10-03T10:20:00Z",
    "returned_at": "2026-10-03T11:00:00Z",
    "rejected_at": null,
    "cancelled_at": null
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（409 `INVALID_TRANSITION`，例如从 `pending` 直接 return；借用者不能替出借者确认归还）。

### 11. 标记自备（任务创建者 alice）

```bash
curl -s -X PUT "$BASE/api/v1/tasks/55555555-5555-4555-8555-555555555555/requirements/66666666-6666-4666-8666-666666666666/self-supply" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000007" \
  -d '{"self_supplied": true}'
```

成功（200，返回更新后的任务；该需求状态变为 `self_supplied`）：

```json
{
  "data": {
    "id": "55555555-5555-4555-8555-555555555555",
    "title": "Saturday neighbourhood clean-up",
    "creator": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
    "community_id": "c1111111-1111-4111-8111-111111111111",
    "template_id": "park_cleanup",
    "place": {
      "name": "Demo clean-up meeting point",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "source": "manual",
      "source_id": null
    },
    "status": "open",
    "requirements": [
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "category": "litter_picker",
        "quantity": 1,
        "self_supplied": true,
        "state": "self_supplied",
        "active_loan_id": null,
        "candidate_tool_ids": []
      },
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "category": "reusable_gloves",
        "quantity": 1,
        "self_supplied": false,
        "state": "fulfilled",
        "active_loan_id": null,
        "candidate_tool_ids": []
      }
    ],
    "coordination_ready": true,
    "completion_eligible": true,
    "outcome": null,
    "created_at": "2026-10-03T10:00:00Z",
    "completed_at": null
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（409 `REQUIREMENT_LOCKED`，需求存在 pending/accepted/on_loan 借用或有实际借出历史；非创建者操作为 403 `FORBIDDEN`）：

```json
{
  "error": {
    "code": "REQUIREMENT_LOCKED",
    "message": "This requirement cannot be changed in its current state.",
    "details": {}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 12. 完成任务（任务创建者 alice）

```bash
curl -s -X POST "$BASE/api/v1/tasks/55555555-5555-4555-8555-555555555555/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000008" \
  -d '{
    "outcome_note": "Collected litter around the park benches.",
    "bags_collected": 4,
    "volunteer_minutes": 90
  }'
```

成功（200，状态 `completed`；成果为创建者自报）：

```json
{
  "data": {
    "id": "55555555-5555-4555-8555-555555555555",
    "title": "Saturday neighbourhood clean-up",
    "creator": {"id": "u1111111-1111-4111-8111-111111111111", "display_name": "Alice"},
    "community_id": "c1111111-1111-4111-8111-111111111111",
    "template_id": "park_cleanup",
    "place": {
      "name": "Demo clean-up meeting point",
      "latitude": 55.944703,
      "longitude": -3.187417,
      "source": "manual",
      "source_id": null
    },
    "status": "completed",
    "requirements": [
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "category": "litter_picker",
        "quantity": 1,
        "self_supplied": true,
        "state": "self_supplied",
        "active_loan_id": null,
        "candidate_tool_ids": []
      },
      {
        "id": "77777777-7777-4777-8777-777777777777",
        "category": "reusable_gloves",
        "quantity": 1,
        "self_supplied": false,
        "state": "fulfilled",
        "active_loan_id": null,
        "candidate_tool_ids": []
      }
    ],
    "coordination_ready": true,
    "completion_eligible": true,
    "outcome": {
      "note": "Collected litter around the park benches.",
      "bags_collected": 4,
      "volunteer_minutes": 90,
      "verification": "self_reported"
    },
    "created_at": "2026-10-03T10:00:00Z",
    "completed_at": "2026-10-03T11:30:00Z"
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（**工具清单不影响完成**：任务仍 `open` 时创建者总可以提交；重复完成且内容不同为 409 `TASK_ALREADY_COMPLETED`）：

```json
{
  "error": {
    "code": "TASK_ALREADY_COMPLETED",
    "message": "The task is already completed.",
    "details": {}
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

### 13. 社区 impact

```bash
curl -s "$BASE/api/v1/communities/c1111111-1111-4111-8111-111111111111/impact" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：

```json
{
  "data": {
    "active_tools_count": 4,
    "returned_loans_count": 1,
    "completed_tasks_count": 1,
    "as_of": "2026-10-03T11:35:00Z"
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（404 `NOT_FOUND`，社区不存在）。

### 14. 环境卡

```bash
curl -s "$BASE/api/v1/communities/c1111111-1111-4111-8111-111111111111/environment" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200，扁平 provider 键，各 provider 独立 envelope，总状态 `ok`/`partial`/`unavailable`；任一 provider 失败不影响其他节）：

```json
{
  "data": {
    "status": "ok",
    "postcode": {
      "provider": "postcodes_io",
      "status": "ok",
      "source_kind": "fixture",
      "source": "postcodes.io",
      "source_url": "https://postcodes.io/",
      "attribution": "Powered by postcodes.io",
      "data": {"postcode": "EH8 9AB", "outcode": "EH8", "latitude": 55.944703, "longitude": -3.187417, "country": "Scotland"}
    },
    "carbon_intensity": {
      "provider": "carbon_intensity",
      "status": "ok",
      "source_kind": "live",
      "source": "NESO Carbon Intensity API (National Grid ESO)",
      "source_url": "https://carbon-intensity.github.io/api-definitions/",
      "attribution": "UK carbon intensity data from National Grid ESO",
      "data": {"index": "moderate", "forecast": 156, "unit": "gCO2/kWh"}
    },
    "air_quality": {
      "provider": "air_quality",
      "status": "ok",
      "source_kind": "live",
      "source": "Open-Meteo Air Quality",
      "source_url": "https://open-meteo.com/en/docs/air-quality-api",
      "attribution": "European air quality index from Open-Meteo",
      "data": {"status": "Fair", "aqi": 26, "pm2_5": 6.4, "pm10": 11.9}
    },
    "greenspace": {
      "provider": "greenspace",
      "status": "unavailable",
      "source": "OpenStreetMap Overpass API",
      "source_url": "https://overpass-api.de/api/interpreter",
      "attribution": "Green space data © OpenStreetMap contributors",
      "data": null
    }
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

说明：顶层键为**扁平的 provider 名**（`postcode` / `carbon_intensity` / `air_quality` / `greenspace`），不是 `providers.*` 包一层；各 provider 独立 envelope，任一失败不影响其他节；`greenspace` 在 Overpass 超时/失败时为 `unavailable` 属正常降级。服务端还可能给出 `source_kind="cached"`（读缓存）或 `"fixture"`（演示回落），前端须如实展示。

关键错误（404 `NOT_FOUND`，社区不存在）。

### 14. 环境卡

```bash
curl -s "$BASE/api/v1/communities/c1111111-1111-4111-8111-111111111111/environment" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200，各 provider 独立 envelope，总状态 `ok`/`partial`/`unavailable`；C 的适配器未就绪时对应 provider 返回 `not_implemented`，不影响其他 provider）：

```json
{
  "data": {
    "status": "partial",
    "providers": {
      "postcode": {
        "status": "ok",
        "source_kind": "fixture",
        "attribution": "postcodes.io (fixture snapshot)"
      },
      "air_quality": {"status": "unavailable", "error": "not_implemented"},
      "carbon": {"status": "unavailable", "error": "not_implemented"},
      "greenspace": {"status": "unavailable", "error": "not_implemented"}
    }
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

关键错误（404 `NOT_FOUND`，社区不存在；邮编初始化上游故障且无缓存为 503 `UPSTREAM_UNAVAILABLE`）。

### 15. 切换 home 社区（demo 搬家）

```bash
curl -s -X POST "$BASE/api/v1/me/community" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000012" \
  -d '{"postcode": "EH14 4AS"}'
```

成功（200，返回与 `GET /me` 相同的 `MeResponse`；服务端解析/校验邮编后只把调用者的 `users.community_id` 指向该社区，后续 `GET /me`、工具列表、任务与借还都跟随新的 home 社区）：

```json
{
  "data": {
    "id": "u1111111-1111-4111-8111-111111111111",
    "display_name": "Alice",
    "community": {
      "id": "c2222222-2222-4222-8222-222222222222",
      "postcode": "EH14 4AS",
      "outcode": "EH14",
      "latitude": 55.9041,
      "longitude": -3.2489,
      "country": "Scotland",
      "source": "fixture",
      "source_kind": "fixture",
      "fetched_at": "2026-10-03T09:00:00Z"
    },
    "mode": "demo"
  },
  "meta": {"request_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}
}
```

说明：请求体为 `{"postcode": "<UK postcode>"}`（大小写与空格会被归一化）。`POST /api/v1/me/community` 是 demo 里**唯一**会改写 `users.community_id` 的写操作；`GET /communities/resolve` 只解析邮编，从不改账号。邮编无法解析时为 422 `INVALID_POSTCODE`，此时账号不变。

关键错误：

- 400 `IDEMPOTENCY_KEY_REQUIRED`：缺少 `Idempotency-Key`（业务写均要求）。
- 400 `IDEMPOTENCY_KEY_INVALID`：key 不是 UUID。
- 401 `UNAUTHENTICATED`：token 缺失/无效/过期/已注销。
- 409 `IDEMPOTENCY_KEY_REUSED`：同一个 key 用于不同邮编的不同意图。
- 422 `INVALID_POSTCODE`：邮编无法解析，账号保持不变。
- 503 `UPSTREAM_UNAVAILABLE`：邮编无缓存且上游故障，账号保持不变。

重放：同一 actor 用同一 `Idempotency-Key` 重复相同请求，服务端直接返回首次记录的结果（响应头 `Idempotency-Replayed: true`），不会再次搬家。

---

## 其余端点（规格 8.2 剩余）

### 注销

```bash
curl -s -X POST "$BASE/api/v1/sessions/logout" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`{"data": {"revoked": true}, "meta": {"request_id": "..."}}`。注销后该 token 再次使用返回 401。注销不要求 Idempotency-Key。

关键错误（401 `UNAUTHENTICATED`，token 缺失/无效/已注销）。

### 邮编解析

```bash
curl -s "$BASE/api/v1/communities/resolve?postcode=EH8%209AB" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`CommunityResponse`（id、postcode、outcode、latitude、longitude、country、source、source_kind、fetched_at）。

关键错误（422 `INVALID_POSTCODE`，邮编无法解析；无缓存且上游故障为 503 `UPSTREAM_UNAVAILABLE`）。

### 工具详情

```bash
curl -s "$BASE/api/v1/tools/t3333333-3333-4333-8333-333333333333" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`ToolResponse`（归档历史工具仍可读，但不能申请）。

关键错误（404 `NOT_FOUND`，工具不存在）。

### 归档工具（所有者）

```bash
curl -s -X POST "$BASE/api/v1/tools/t3333333-3333-4333-8333-333333333333/archive" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000009"
```

成功（200）：更新后的 `ToolResponse`，`is_archived: true`，`availability: "archived"`。

关键错误（409 `ACTIVE_LOAN_EXISTS`，存在有效借用；非所有者为 403 `FORBIDDEN`）。

### 借用列表

```bash
curl -s "$BASE/api/v1/loans?role=borrower&status=pending" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`data` 为 `LoanResponse` 数组，只返回本人借入（`role=borrower`，默认）或本人拥有工具的借出（`role=owner`）的记录；`meta` 含 limit/offset/total。

关键错误（401 `UNAUTHENTICATED`）。

### 借用详情

```bash
curl -s "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`LoanResponse`。

关键错误（404 `NOT_FOUND`，非借用双方查询他人借用一律 404）。

### 借用事件

```bash
curl -s "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`data` 为事件数组（id、loan_id、actor_id、action、from_status、to_status、created_at），按 created_at、id 排序。

关键错误（404 `NOT_FOUND`，非借用双方不可见）。

### 拒绝申请（所有者）

```bash
curl -s -X POST "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/reject" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000010"
```

成功（200）：`LoanResponse`，`status: "rejected"`，`rejected_at` 非空，工具占用释放。

关键错误（409 `INVALID_TRANSITION`，借用不在 `pending`）。

### 取消申请（借用双方）

```bash
curl -s -X POST "$BASE/api/v1/loans/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: a0000000-0000-4000-8000-000000000011"
```

成功（200）：`LoanResponse`，`status: "cancelled"`，`cancelled_at` 非空，工具占用释放。

关键错误（409 `INVALID_TRANSITION`，已借出后必须走归还流程，不能取消）。

### 任务列表

```bash
curl -s "$BASE/api/v1/tasks?scope=mine" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`data` 为任务摘要数组；`scope=mine`（默认）返回本人任务，`scope=community` 必填 `community_id`，公开社区摘要不含借用详情。

关键错误（422 `VALIDATION_ERROR`，`scope=community` 缺少 `community_id`）。

### 任务详情

```bash
curl -s "$BASE/api/v1/tasks/55555555-5555-4555-8555-555555555555" \
  -H "Authorization: Bearer $TOKEN"
```

成功（200）：`TaskResponse`（含需求派生状态）；`active_loan_id` 只对创建者或相应借用双方显示，无关用户为 `null`。

关键错误（404 `NOT_FOUND`，任务不存在）。

---

## 附录 A：规格 8.4 请求示例（原文）

发布工具：

```json
{
  "name": "Neighbourhood litter picker",
  "category": "litter_picker",
  "description": "Reusable picker for a local clean-up."
}
```

创建任务：

```json
{
  "template_id": "park_cleanup",
  "title": "Saturday neighbourhood clean-up",
  "place": {
    "name": "Demo clean-up meeting point",
    "latitude": 55.944703,
    "longitude": -3.187417,
    "source": "manual",
    "source_id": null
  }
}
```

申请借用：

```json
{
  "tool_id": "2222222-2222-4222-8222-222222222222",
  "requirement_id": "33333333-3333-4333-8333-333333333333",
  "note": "For our neighbourhood clean-up."
}
```

> 规格 8.4 说明：place 坐标为手动演示地点，不声称是已核验的某个公园；place 坐标必须有限且合法，距离用户社区中心 ≤2000m；`source=osm` 时 `source_id` 须能在服务器缓存的该社区绿地结果中查到。`requirement_id` 允许 null（独立借用，不改变任务需求状态）。UUID 仅示意，实际调用必须使用上一步响应中的真实 ID。

## 附录 B：规格 8.5 错误码表

| HTTP | code | 使用情形 |
|---:|---|---|
| 400 | IDEMPOTENCY_KEY_REQUIRED / IDEMPOTENCY_KEY_INVALID | 业务写缺少或不符合格式的 key |
| 401 | UNAUTHENTICATED | 登录失败、token 缺失/无效/过期/注销 |
| 403 | FORBIDDEN / SELF_BORROW_FORBIDDEN | 对可见资源执行不允许动作，或借自己的工具 |
| 404 | NOT_FOUND | 不存在或无权查看的私有对象 |
| 409 | TOOL_UNAVAILABLE / TOOL_ARCHIVED / ACTIVE_LOAN_EXISTS | 工具已占用、归档或不允许归档 |
| 409 | REQUIREMENT_OCCUPIED / REQUIREMENT_LOCKED / REQUIREMENT_ALREADY_FULFILLED | 需求被占用、自备/使用状态冲突 |
| 409 | INVALID_TRANSITION / TASK_ALREADY_COMPLETED | 状态不允许该动作，或任务已记录过 |
| 409 | IDEMPOTENCY_KEY_REUSED | 同用户 key 被用于不同意图 |
| 422 | VALIDATION_ERROR / INVALID_POSTCODE / CATEGORY_MISMATCH / OUT_OF_RANGE | 输入、邮编、类别或范围不符合 |
| 429 | RATE_LIMITED | 演示登录或外部查询频率限制 |
| 503 | DATABASE_BUSY / UPSTREAM_UNAVAILABLE | DB 锁等待超时；邮编初始化上游失败且无缓存 |
| 500 | INTERNAL_ERROR | 未预料服务异常，响应不含堆栈 |
