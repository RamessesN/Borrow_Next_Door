# Borrow Next Door 后端测试报告（B 后端）

> 本报告只记录**本次实际执行过**的检查。每条结论后面附执行命令与原始输出摘要；未执行的检查不写「通过」。

## 1. 概览

| 项 | 值 |
|---|---|
| 日期 | 2026-10-03 |
| 范围 | 当前后端契约与前端整合回归；历史验收记录另行标注 |
| 技术栈 | Python 3.13.12、FastAPI 0.142.2、Starlette 1.7.0、Pydantic 2.13.5、httpx 0.28.1、pytest 9.1.1、uvicorn 0.54.0 |
| 数据库 | SQLite 文件库（python sqlite3 3.53.4），`PRAGMA foreign_keys=ON`，迁移/初始化时启用 `journal_mode=WAL`（`app/db.py`） |
| 运行环境 | `.venv`（`backend/.venv`），macOS（Darwin 27.0.0） |

版本取值来源（本次执行）：

```
$ .venv/bin/python -V
Python 3.13.12
$ .venv/bin/python -c "import fastapi,starlette,pydantic,httpx; [print(m.__name__,m.__version__) for m in (fastapi,starlette,pydantic,httpx)]"
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

## 2. 当前测试套件汇总

全量执行（工作目录 `backend/`，本轮实测）：

```
$ .venv/bin/pytest -q
203 passed, 1 warning in 3.22s
$ .venv/bin/pytest --collect-only -q
203 tests collected in 0.02s
```

warning 为 Starlette TestClient 对 httpx 的弃用提示，不是业务失败。
下表是实际 `pytest --collect-only -q -q` 输出的逐文件收集数；通过结论来自上述全量执行，未伪称逐文件都单独运行。

| 测试文件 | 实际收集数 |
|---|---:|
| `tests/test_adapters_live_shapes.py` | 26 |
| `tests/test_community.py` | 22 |
| `tests/test_environment.py` | 16 |
| `tests/test_health_auth.py` | 20 |
| `tests/test_impact.py` | 5 |
| `tests/test_loans.py` | 46 |
| `tests/test_loans_concurrency.py` | 3 |
| `tests/test_tasks.py` | 38 |
| `tests/test_tools.py` | 27 |
| **合计** | **203（全量 203 passed / 0 failed）** |

前端最终 `npm test` 为 **80 passed / 0 failed**，另有临时真实后端 smoke 通过；首轮 66 项后因并行地图 UI 接线增加 3 项。Node/mock DOM 测试与真实 HTTP smoke 分开记载，完整证据见第 7 节。

## 3. 历史验收清单（早期波 2，对照规格 0.3）

以下是已有代理留下的历史原始记录，本轮未重新执行这些临时脚本，不作为本轮新验收。历史数据量、访问码、适配器空壳描述反映当时状态；当前实现及本轮实测以第 2、7 节为准。

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
4. **环境适配器已整合**：carbon / air / greenspace / postcode 已有真实 HTTP 实现，非第 3.5 节历史记录中的空壳。解析形状、故障、缓存与 fixture 回落由 mock 上游测试覆盖；真实后端 smoke 的环境端点本轮返回 200/status=ok，但未逐 provider 检查 source_kind，不能据此宣称所有上游已 live 联调通过。
5. **演示访问码已移除**（2026-10-03 用户决策）：后端与启动/检查脚本不再要求访问码，登录只传 `user_alias`；历史命令里的访问码变量保留为原始记录，不是当前使用要求。`APP_MODE=production` 仍拒绝启动。当前脚本实测见第 7 节。
6. **地图与评分不是实测影响**：地图用邮编中心点/合成网格估算路线，不是真实道路导航；context score 是区域上下文，不是借还或行动造成的改善。成果记录是 self-reported。

## 5. 未覆盖范围

- 逐个真实外部 provider 的 live 数据真实性/时效联调；mock 与 fixture 通过不替代此项
- 真实浏览器双窗口操作、视觉布局与真实浏览器地图交互；本轮已覆盖 mock DOM/API 集成与真实后端 HTTP smoke，但未宣称浏览器验收
- 负载 / 性能 / 压测、长时间稳定性
- 真实注册与真实令牌体系（MVP 仅 demo 会话，规格已声明限制）

## 6. 移除演示访问码阶段实测记录（历史，2026-10-03）

本节为前一代理的原始记录；202 passed 是该阶段数字，不是当前总数。本轮重跑见第 7 节。

用户明确覆盖规格 4.1：**彻底移除 DEMO_ACCESS_CODE**，登录只需 `user_alias`。
以下三项均为本次真实执行的原始输出。

### 6.1 无 DEMO_ACCESS_CODE 环境变量下 uvicorn 启动并登录（201）

```
$ cd backend && env -u DEMO_ACCESS_CODE -u APP_MODE APP_MODE=demo \
    DATABASE_PATH=./var/borrow-next-door.sqlite3 \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8077 &
$ for i in $(seq 1 40); do curl -sf http://127.0.0.1:8077/health/ready >/dev/null 2>&1 && { echo READY; break; }; sleep 0.5; done
READY
$ curl -s http://127.0.0.1:8077/health/ready
{"data":{"status":"ready"},"meta":{"request_id":"67a277ba-e972-4f65-b5d3-bb71159f0912",...}}

$ curl -s -o /tmp/login_resp.json -w "HTTP %{http_code}\n" -X POST \
    http://127.0.0.1:8077/api/v1/demo/sessions \
    -H "Content-Type: application/json" -d '{"user_alias":"alice"}'
HTTP 201
{"data":{"access_token":"7-UPE6WvuXNdcMCwg9jVKkSSsF3fXJTxtuJuQ2zOKWM","token_type":"bearer",
 "expires_at":"2026-10-04T01:08:30Z","user":{"id":"u1111111-1111-4111-8111-111111111111",
 "alias":"alice","display_name":"Alice","community_id":"c1111111-1111-4111-8111-111111111111"}},
 "meta":{"request_id":"a00fd30a-7752-4088-830a-b4517a98e095",...}}
```

附带实测（同一进程）：带无关注键 `access_code` 的旧客户端请求同样 201（字段被忽略），
未知 alias 仍 401：

```
$ curl -s -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:8077/api/v1/demo/sessions \
    -H "Content-Type: application/json" -d '{"user_alias":"bob","access_code":"whatever"}'
HTTP 201   # data.user.alias = "bob"
$ curl -s -w "HTTP %{http_code}\n" -X POST http://127.0.0.1:8077/api/v1/demo/sessions \
    -H "Content-Type: application/json" -d '{"user_alias":"mallory"}'
{"error":{"code":"UNAUTHENTICATED","message":"Authentication required.","details":{}},...}HTTP 401
$ tail -5 /tmp/uv_acc_test.log
INFO:     Uvicorn running on http://127.0.0.1:8077 (Press CTRL+C to quit)
INFO:     127.0.0.1:49678 - "POST /api/v1/demo/sessions HTTP/1.1" 201 Created
INFO:     127.0.0.1:49679 - "POST /api/v1/demo/sessions HTTP/1.1" 201 Created
INFO:     127.0.0.1:49680 - "POST /api/v1/demo/sessions HTTP/1.1" 401 Unauthorized
```

### 6.2 全量测试套件

```
$ .venv/bin/pytest -q
202 passed, 1 warning in 3.14s
```

（改动前基线为 `201 passed`；删除访问码相关用例、新增无访问码/被忽略字段/宽松限流用例后
净增 1 个。warning 仍是与业务无关的 `starlette.testclient` 弃用提示。）

### 6.3 `./start.sh --help`

```
$ ./start.sh --help
Borrow Next Door — one-command demo launcher

Starts the backend (FastAPI :8000) and the frontend (:5173) together,
prepares everything from a fresh clone and opens the app in your browser.
Ctrl+C stops both. No access code is required to sign in.

  ./start.sh            # normal start (creates venv/DB on first run)
  ./start.sh --reset    # also rebuild the demo database
  ./start.sh --help

Windows: run inside WSL/Git-Bash, or start the two processes manually
(see README.md).
```

`start.sh` 已删除访问码的生成、长度校验与横幅打印（原「Demo access code: …」一行）；
启动横幅现在只提示用 alice / bob / carol 登录，无访问码行。

## 7. 本轮变更实测（文档与脚本收尾，2026-10-03）

### 7.1 脚本语法与访问码残留核对

根目录实际执行（命令使用绝对路径，以下展示等价仓库相对路径便于复制）：

```bash
bash -n backend/scripts/dev_server.sh && bash -n backend/scripts/check_api.sh
grep -n 'DEMO_ACCESS_CODE' backend/scripts/dev_server.sh backend/scripts/check_api.sh backend/README.md backend/.env.example
```

原始输出（grep 无匹配返回 1；外层校验据此打印确认，不是脚本失败）：

```text
bash -n: both scripts PASS
grep DEMO_ACCESS_CODE: no matches (scripts/backend README/.env.example)
```

`check_api.sh` 登录 JSON 只含 `user_alias`；开发脚本的数据库重建与单 worker 启动行为未改。未直接运行开发脚本，避免它重置工作区数据库；只验证语法与真实服务上的检查脚本。

### 7.2 临时库重建、EH14 种子与真实无访问码登录 201

实际用 `backend/.venv/bin/python` heredoc 驱动子进程：设置 `APP_MODE=demo`，删除访问码环境变量，`DATABASE_PATH` 指向 `tempfile.TemporaryDirectory`，执行 `scripts/reset_db.py`，再启动独立 uvicorn（端口 50764）。未改动默认开发库；finally 终止服务，临时目录自动清理。

重建与 SQLite 分组查询的原始输出摘要：

```text
removed_files : none (fresh build)
migrations_run: ['0001_initial']
versions      : ['0001_initial']
seed_inserted : {'communities': 3, 'users': 5, 'templates': 2, 'requirements': 4, 'tools': 7}
counts        : communities=3 users=5 templates=2 tools=7
ready         : True
seed: EH14 4AS: 4 tools; owners=eve,dora
seed: EH16 5AA: 0 tools; owners=None
seed: EH8 9AB: 3 tools; owners=alice,bob
alias-only login: HTTP 201; alias=alice; no access-code environment variable
```

登录是实际 HTTP `POST /api/v1/demo/sessions`，body 为 `{"user_alias":"alice"}`；不记录完整 token。

同一临时真实服务上实际调用 `bash scripts/check_api.sh` 两次：一次访问码变量不存在，一次残留短值 `short`。两次均不受变量影响，原始输出：

```text
check_api.sh: legacy variable absent
== Borrow Next Door API smoke check ==
base_url: http://127.0.0.1:50764
PASS health/live (HTTP 200)
PASS health/ready (HTTP 200)
POST /api/v1/demo/sessions (HTTP 201)
PASS GET /api/v1/me (HTTP 200)
== result: 4 passed, 0 failed ==
check_api.sh: legacy variable short (ignored)
== Borrow Next Door API smoke check ==
base_url: http://127.0.0.1:50764
PASS health/live (HTTP 200)
PASS health/ready (HTTP 200)
POST /api/v1/demo/sessions (HTTP 201)
PASS GET /api/v1/me (HTTP 200)
== result: 4 passed, 0 failed ==
```

### 7.3 前端全量与真实后端邮编浏览 smoke

首轮根目录 `npm test`（默认 :8000 没有服务）为 66 passed，随后 smoke 明确 SKIP，不算通过。并行地图 UI 接线新增 3 例之后，实际给子进程设置 `BND_API_BASE=http://127.0.0.1:50764` 再执行 `npm test`；最终原始输出摘要：

```text
> borrow-next-door-frontend@1.0.0 test
> node --test test/*.test.cjs && node smoke-test.cjs
ℹ tests 80
ℹ suites 0
ℹ pass 80
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 160.221667
PASS: GET http://127.0.0.1:50764/health/live -> {"status":"live","time":"2026-10-03T13:52:28Z"}
PASS: POST /api/v1/demo/sessions (unknown alias) -> 401 UNAUTHENTICATED
PASS: GET /api/v1/me -> Alice in EH8 9AB
PASS: GET /api/v1/tasks?scope=mine -> 0 task(s), total=0
PASS: GET /api/v1/tools (home EH8) -> 3 tool(s), total=3
PASS: GET /api/v1/communities/resolve?postcode=EH14 4AS -> EH14 4AS (EH14)
PASS: GET /api/v1/communities/{id}/environment -> status=ok
PASS: GET /api/v1/tools (browsed EH14) -> 4 tool(s), total=4
PASS: POST /api/v1/sessions/logout -> {"revoked":true}
SMOKE PASS: health + alias login + me + lists + postcode browse + logout against the real backend.
```

另用 `node` heredoc 调 `test/harness.cjs::createApp` 驱动实际 `app.js`：Alice 登录 → 设置 `#postcode` 为 EH14 4AS → submit → 断言 browse 环境/工具切换且 home ID 不变 → 点击 `back-home` → 断言 browse 清空、home 恢复、其他社区工具不再显示。mock 使用自己的 Dana/1 件工具，与真实 Dora/Eve 种子不是同一数据，不能混用计数。

原始输出：

```text
mock DOM postcode switch: EH14 4AS tool list + environment + Back to my street; home unchanged: PASS
mock DOM Back to my street: home context restored: PASS
```

### 7.4 地图模块、队友绿地/评分卡与模板回归

实际执行：

```bash
node --test test/map-module.test.cjs
node --test test/community-environment.test.cjs
node --test --test-name-pattern='action templates switch' test/e2e-demo.test.cjs
```

原始输出摘要（分别对应上述三个命令）：

```text
ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms 108.409708

ℹ tests 17
ℹ pass 17
ℹ fail 0
ℹ duration_ms 129.935834

✔ action templates switch both ways and preserve existing progress without duplicate tasks (21.165917ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ duration_ms 83.364125
```

覆盖：A*/Dijkstra 成本一致、最近工具排序、路径端点、空输入/同坐标/无效输入、50 工具性能；地图 UI 的路线 SVG/最近 pin、无工具降级、browse 与筛选重算；真实绿地名称与直线排序、provider 缺失、context score 缺数据不当零、fixture 标签、2km 边界与最多 5 个来源说明；模板双向切换保留已有开放任务进度且不重复创建。

后端定向执行：

```bash
.venv/bin/pytest \
  tests/test_environment.py::test_environment_home_community_has_offline_fixture_fallback \
  tests/test_health_auth.py::test_demo_login_without_access_code_env \
  tests/test_health_auth.py::test_login_rate_limited_after_soft_cap -v
```

原始输出：

```text
tests/test_environment.py::test_environment_home_community_has_offline_fixture_fallback PASSED [ 33%]
tests/test_health_auth.py::test_demo_login_without_access_code_env PASSED [ 66%]
tests/test_health_auth.py::test_login_rate_limited_after_soft_cap PASSED [100%]
========================= 3 passed, 1 warning in 0.19s =========================
```

EH8 离线环境 fixture 与每 IP 60 次/分钟上限已实测。以上定向测试是全量套件的子集，不再加进 203/69 总数。

