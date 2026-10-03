# Borrow Next Door 后端测试报告（B 后端）

> 本报告只记录**本次实际执行过**的检查。每条结论后面附执行命令与原始输出摘要；未执行的检查不写「通过」。

## 1. 概览

| 项 | 值 |
|---|---|
| 日期 | 2026-10-03 |
| 范围 | B 后端（Borrow Next Door backend，波 2 四模块：tools / loans / tasks / community） |
| 技术栈 | Python 3.13.12、FastAPI 0.142.2、Starlette 1.7.0、Pydantic 2.13.5、httpx 0.28.1、pytest 9.1.1、uvicorn 0.54.0 |
| 数据库 | SQLite 文件库（python sqlite3 3.53.4），`PRAGMA foreign_keys=ON`，迁移/初始化时启用 `journal_mode=WAL`（`app/db.py`） |
| 运行环境 | `.venv`（`backend/.venv`），macOS（Darwin 27.0.0） |

版本取值来源（本次执行）：

```
$ .venv/bin/python -V
Python 3.13.12
$ .venv/bin/python -c "import fastapi,starlette,pydantic,httpx;print(...)"
fastapi 0.142.2
starlette 1.7.0
pydantic 2.13.5
httpx 0.28.1
$ .venv/bin/python -c "import sqlite3;print('sqlite3',sqlite3.sqlite_version)"
sqlite3 3.53.4
$ .venv/bin/python -m pytest --version
pytest 9.1.1
$ grep uvicorn requirements.lock.txt
uvicorn==0.54.0
```

## 2. 测试套件汇总

全量执行（工作目录 `backend/`）：

```
$ .venv/bin/pytest -q
156 passed, 1 warning in 2.92s
```

（warning 为 `fastapi/testclient.py:1 StarletteDeprecationWarning: Using httpx with starlette.testclient is deprecated`，与业务断言无关。）

各测试文件计数（逐文件单独执行 `pytest <file> -q`，末行输出）：

| 测试文件 | 结果 |
|---|---|
| `tests/test_health_auth.py` | 19 passed |
| `tests/test_loans.py` | 46 passed |
| `tests/test_tasks.py` | 38 passed |
| `tests/test_tools.py` | 27 passed |
| `tests/test_community.py` | 9 passed |
| `tests/test_environment.py` | 9 passed |
| `tests/test_impact.py` | 5 passed |
| `tests/test_loans_concurrency.py` | 3 passed |
| **合计** | **156 passed / 0 failed** |

## 3. 验收清单（对照规格 0.3）

### 3.1 两个独立会话完成一次发布和借还（Alice / Bob 双会话）

执行命令（独立脚本 `/tmp/bnd_flow.py`，TestClient 双会话，临时文件库）：

```
$ rm -f /tmp/bnd-verify.sqlite3
$ PYTHONPATH=<backend> DEMO_ACCESS_CODE=test-only-access-code-0001 APP_MODE=demo \
  DATABASE_PATH=/tmp/bnd-verify.sqlite3 .venv/bin/python /tmp/bnd_flow.py
```

原始输出摘要：

```
== 1. dual-session publish + borrow round trip ==
POST /tools (bob) -> 201 95e469d8-4ebe-4e36-935e-db31da40871f
POST /tasks (alice) -> 201 ea0a6eba-c596-49be-b1c5-8ccde343e0b8
POST /loans (alice applies) -> 201 pending
   requirement_id: a023642d-3ab5-4585-b4ce-5e6442afd648 task_id: ea0a6eba-...
POST /loans/{id}/accept (bob) -> 200 accepted
POST /loans/{id}/hand-over (bob) -> 200 on_loan
POST /loans/{id}/return (bob) -> 200 returned
GET /tools/{id} after return -> 200 availability = available
GET /tasks/{id} requirement state -> ['fulfilled', 'match_available']
ALL FLOW CHECKS PASSED
```

结论：**通过**（bob 发布工具 → alice 建任务 → alice 申请并挂接任务需求 → bob 接受 → bob 交接 → bob 归还 → 工具 `availability` 回到 `available`，任务需求状态变为 `fulfilled`）。

### 3.2 同一工具并发申请最多一条有效借用

执行命令与原始输出：

```
$ .venv/bin/pytest tests/test_loans_concurrency.py -v
tests/test_loans_concurrency.py::test_two_borrowers_race_for_one_tool PASSED [ 33%]
tests/test_loans_concurrency.py::test_two_tools_race_for_one_requirement PASSED [ 66%]
tests/test_loans_concurrency.py::test_self_supply_and_loan_race PASSED   [100%]
========================= 3 passed, 1 warning in 0.17s =========================
```

（依赖迁移中的部分唯一索引 `uq_loans_one_active_tool` / `uq_loans_one_active_requirement`，真实文件库 + 独立连接。）

结论：**通过**。

### 3.3 第三人不能接受 / 取消 / 归还他人的借用

执行命令 A（测试）：

```
$ .venv/bin/pytest "tests/test_loans.py::test_third_party_gets_404_everywhere" \
    "tests/test_loans.py::test_borrower_cannot_run_owner_actions" -v
tests/test_loans.py::test_third_party_gets_404_everywhere PASSED         [ 10%]
tests/test_loans.py::test_borrower_cannot_run_owner_actions[pending-accept] PASSED
...（共 9 个参数化用例）
======================== 10 passed, 1 warning in 0.32s =========================
```

执行命令 B（原始状态码与 error.code，同一次 `/tmp/bnd_flow.py` 执行）：

```
== 3. third party cannot accept / cancel / return someone else's loan ==
pending loan id: 62e8a9de-... status: pending
carol POST /loans/{id}/accept    -> 404 NOT_FOUND
carol POST /loans/{id}/cancel    -> 404 NOT_FOUND
carol POST /loans/{id}/return    -> 404 NOT_FOUND
carol POST /loans/{id}/hand-over -> 404 NOT_FOUND
carol POST /loans/{id}/reject    -> 404 NOT_FOUND
carol GET  /loans/{id}           -> 404 NOT_FOUND
carol GET  /loans/{id}/events    -> 404 NOT_FOUND
```

结论：**通过**（第三方对他人借用既看不到也改不了，统一 404 `NOT_FOUND`，即规格 4.2 的不可见语义）。同批次还验证了借方不能执行出借方动作（`test_borrower_cannot_run_owner_actions` 9 例全绿）。

### 3.4 后端重启后数据保留

执行方式：先用官方重置脚本在**临时文件库**上重建，再由**进程 1** 通过 API 写数据后退出，**进程 2**（全新进程、全新 `create_app()` 实例）读回。

```
$ DATABASE_PATH=/tmp/bnd-persist.sqlite3 .venv/bin/python scripts/reset_db.py
=== reset_db summary ===
database_path : /tmp/bnd-persist.sqlite3
migrations_run: ['0001_initial']
seed_inserted : {'communities': 2, 'users': 3, 'templates': 2, 'requirements': 4, 'tools': 3}
counts        : communities=2 users=3 templates=2 tools=3
ready         : True

--- process 1 (写) ---
$ .venv/bin/python /tmp/bnd_persist_write.py
WROTE {"tool_id": "28d335ee-4ad6-49ab-b615-cc804e88ca63", "task_id": "c569ae7b-d005-471b-b6ab-b0e3570e090a"}
process 1 (writer) exiting

--- process 2 (新进程读回) ---
$ .venv/bin/python /tmp/bnd_persist_read.py
GET /tools/{id} after restart -> 200 Persisted drill available
GET /tasks/{id} after restart -> 200 Park cleanup
GET /tools listing contains persisted tool -> True
PERSISTENCE ACROSS PROCESS RESTART: PASS
```

结论：**通过**（SQLite 文件库 + WAL，跨进程重建 app 实例后数据可读回；`scripts/reset_db.py` 幂等可用）。说明：本次未对默认开发库 `./var/borrow-next-door.sqlite3` 执行删除重建，避免破坏工作区数据，重置验证在 `DATABASE_PATH` 指向的临时库上完成。

### 3.5 环境 API 不可用时借还正常

三个 C 侧适配器（carbon / air / greenspace）当前为 `not_implemented` 空壳，借还流程照常完成。执行命令同 3.1（`/tmp/bnd_flow.py` 一次执行内先完成借还、再读环境端点）：

```
== 2. environment API unavailable (C adapters not_implemented) ==
GET /communities/{id}/environment -> 200 overall status = unavailable
    postcode => ok
    carbon_intensity => not_implemented
    air_quality => not_implemented
    greenspace => not_implemented
   loan flow above already completed while these were not_implemented: PASS
```

补充的套件证据：

```
$ .venv/bin/pytest tests/test_environment.py -q
9 passed, 1 warning in 0.21s
```

（其中 `test_environment_envelope_shape_and_not_implemented_sections` 断言三个适配器均为 `not_implemented` 且整体 `status == "unavailable"`，端点仍返回 200 带完整 envelope。）

结论：**通过**（环境数据全部不可用不影响借还；借还流程在同一次执行中已全通）。

### 3.6 未认证响应统一 401（本轮裁决，规格 8.5）

裸请求（不带任何头）与只带伪造 `X-User-Id` 的请求，四个业务集合路由一律 401 `UNAUTHENTICATED`，且响应体不含 `data`：

```
no header        GET /api/v1/tools                -> 401 {"error":{"code":"UNAUTHENTICATED","message":"Authentication required.","details":{}},"meta":{"request_id":"1e14c2d5-..."}}
X-User-Id only   GET /api/v1/tools                -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
no header        GET /api/v1/loans                -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
X-User-Id only   GET /api/v1/loans                -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
no header        GET /api/v1/tasks                -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
X-User-Id only   GET /api/v1/tasks                -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
no header        GET /api/v1/communities/resolve  -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
X-User-Id only   GET /api/v1/communities/resolve  -> 401 {"error":{"code":"UNAUTHENTICATED",...}}
no token POST /api/v1/sessions/logout -> 401 UNAUTHENTICATED
GET /health/live -> 200
GET /health/ready -> 200
POST /api/v1/demo/sessions (public) -> 201
```

结论：**通过**。公开端点仍可用（`/health/live`、`/health/ready` 200，demo 登录 201），`POST /api/v1/sessions/logout` 无 token 仍 401。

## 4. 已知偏差与边界

1. **种子 ID 为助记形式**：种子数据使用 `t1111111-1111-4111-8111-111111111111` 这类助记 ID（并非随机 UUID）。为让请求体里的种子 ID 通过校验，`app/schemas_loans.py` 的 `_ID_PATTERN` 放宽为 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`（1–64 位字母/数字/`_`/`-` 的 ID 形态字符串，比严格 UUID 语法宽）；未知但格式合法的 ID 在 service 层仍返回 404。路径参数（`/loans/{id}`、`/tasks/{id}` 等）为普通字符串，由 service 层判定存在性。
2. **非列表响应的 meta**：`EnvelopeMeta` 中 `limit/offset/total` 为 `int | None = None`；单对象与错误 envelope 只填 `request_id`，三个分页字段在运行时省略（等价于 null），列表 envelope 才填实值。
3. **事件 action 词表与 id 形态**：`loan_events.action` 使用规格 6.1 的过去式事件词（`accepted` / `rejected` / `cancelled` / `handed_over` / `returned`），与请求端点动作名（`accept` / `reject` / `cancel` / `hand-over` / `return`）一一对应；事件 id 由 `new_event_id()` 生成 UUIDv7 形态（48 位毫秒时间戳 + 14 位单调序列），原因是规格 8.2 要求事件按 `(created_at, id)` 排序而 `created_at` 只有秒级分辨率，id 必须自带时间序。
4. **C 的三个适配器是空壳**：`app/adapters/carbon.py`、`air.py`、`greenspace.py` 返回 `status="not_implemented"` 且**从不发外部 HTTP**，真实外呼未经本次测试（见 3.5）。`app/adapters/postcode.py` 为 B 侧最小实现/固定 fixture 路径，真实 postcodes.io 联调未测。
5. **DEMO_ACCESS_CODE 为运行时配置**：源码与本报告均不含任何访问码；本次所有验证使用测试值 `test-only-access-code-0001`（仅测试环境，`APP_MODE=demo`）。生产模式启动会被 `app.config` 拒绝。

## 5. 未覆盖范围

- 真实外部 API 联调（postcodes.io、Carbon Intensity、Open-Meteo、Overpass 等，C 适配器落地后再测）
- 前端集成（A 侧）与跨模块联调
- 负载 / 性能 / 压测、长时间稳定性
- 真实注册与真实令牌体系（MVP 仅 demo 会话，规格已声明限制）
