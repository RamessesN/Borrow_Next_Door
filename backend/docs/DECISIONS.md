# 技术决策记录 — Borrow Next Door 后端

日期：2026-10-03。本文件记录地基与认证阶段的技术选择、契约摘要与已知限制。代码与字段名保持英文。

## 1. 技术栈与实际版本

后端建在团队仓库 `backend/` 子目录，独立 venv（`.venv`，Python 3.13.12，Homebrew）。
以下为 `pip freeze` 的实际安装版本（见 `requirements.lock.txt`）：

| 包 | 实际版本 |
|---|---|
| fastapi | 0.142.2 |
| starlette | 1.7.0 |
| pydantic | 2.13.5 |
| pydantic-core | 2.46.5 |
| uvicorn | 0.54.0 |
| httpx | 0.28.1 |
| pytest | 9.1.1 |

- 数据库：Python 自带 `sqlite3`，单文件 `./var/borrow-next-door.sqlite3`（相对 backend/），运行时创建 `var/`。
- 事务：连接 `isolation_level=None`，业务写用 `BEGIN IMMEDIATE → COMMIT`（异常 `ROLLBACK`）；初始化时启用 WAL；每连接 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；每请求独立连接，无进程全局共享连接。
- 端口 8000，单 uvicorn worker（`scripts/dev_server.sh`）。
- 版本号以 venv 内实际安装结果为准，`requirements.txt` 只写区间约束，精确版本在 `requirements.lock.txt`。

## 2. APP_MODE=production 拒绝启动的原因

规格 4.1：「未实现真实认证时，`APP_MODE=production` 应拒绝启动，不能偷偷沿用演示身份。」
当前只有无门禁的演示会话（种子用户 alice/bob/carol），没有密码/注册/OAuth 等真实认证。若允许 production 模式启动，任何人即可冒充任意演示身份，等同于无认证。因此 `app/config.py` 在 `APP_MODE=production` 时抛 `SettingsError`，`app/main.py` 启动即失败并给出明确信息。接入真实认证后应移除此开关并补充相应测试。

> 变更（2026-10-03）：原「`DEMO_ACCESS_CODE` 缺失/占位/过短即启动失败」的校验已随访问码功能一并删除，见第 10 节。`APP_MODE=production` 拒绝启动这一条保留。

## 3. 演示身份不是真实注册

- `POST /api/v1/demo/sessions` 只接受已存在于种子数据的 alias（alice / bob / carol），客户端不能传任意 `user_id` 创建身份。
- `users` 表不存密码；会话表只存 token 的 SHA-256 摘要 + 创建/到期/注销时间。token 为 `secrets.token_urlsafe(32)`（≥32 随机字节）。
- 演示账号仅用于比赛演示，任何界面/文档标注 "demo account"，不代表已验证居民身份。
- （已废止，见第 10 节）~~访问码由运行时环境变量注入（见 `.env.example`），不写入源码、不写入种子数据。~~ 演示访问码已于 2026-10-03 移除，登录不再需要任何访问码。

## 4. 共享契约摘要（所有并行任务必须遵守）

### 4.1 Envelope

成功：`{"data": <obj|list>, "meta": {"request_id": "...", ...(limit/offset/total for lists)}}`。
列表默认 limit=20（1–100）、offset≥0，`meta.total` 按相同筛选条件计算。
错误：`{"error": {"code", "message", "details"}, "meta": {"request_id"}}`。
每个请求生成/透传 `X-Request-Id`（UUID），写入 `request.state.request_id` 并进所有响应 meta。
Pydantic 校验错误统一转成 422 `VALIDATION_ERROR`，details 只含字段名与消息，禁止回显 `access_code`、`Authorization`。

### 4.2 错误码

`app/errors.py` 定义规格 8.5 全表：每个码带默认 HTTP 状态（400/401/403/404/409/422/429/503/500）。
`AppError(code, message?, http_status?, details?)` 由全局处理器输出信封；
`sqlite3.IntegrityError` → 409；`OperationalError: database is locked` → 503 `DATABASE_BUSY` + `Retry-After: 1`；
未捕获异常 → 500 `INTERNAL_ERROR`，响应不含堆栈、SQL 或磁盘路径。

### 4.3 幂等

业务写（除登录/注销）要求 `Idempotency-Key`（UUID）：
`require_idempotency_key` 缺失→400、格式错→400；`compute_fingerprint` = method + 规范化 path + canonical JSON 的 SHA-256；
同 actor/key 相同 fingerprint → 重放原状态与 data（响应头 `Idempotency-Replayed: true`，request_id 用当前请求）；
不同 fingerprint → 409 `IDEMPOTENCY_KEY_REUSED`；记录与业务写同事务，仅记录 2xx（`app/idempotency.py` 原语供各写路由调用）。

### 4.4 认证

业务接口一律 `Authorization: Bearer <token>`；不接受 `X-User-Id`、JSON 内 owner_id/borrower_id 或昵称作为身份。
`get_current_user` 同时校验摘要、未过期、未注销、用户 `is_active`，任一失败统一 401 `UNAUTHENTICATED`。
登录失败：同 IP 每分钟 ≥10 次失败后 429 `RATE_LIMITED`（进程内计数）。

## 5. availability 是计算字段，不存在 tools.status 列（规格 5.3）

`tools` 表**没有** `status` 列。工具的可借状态 `availability` 是响应字段，按以下优先级从 loan 派生计算：

1. `is_archived=1` → `archived`
2. 存在 `status=on_loan` 的 loan → `on_loan`
3. 存在 `status=pending/accepted` 的 loan → `reserved`
4. 其余 → `available`

所有工具列表、详情、匹配与统计必须复用同一计算规则，禁止另存一份 tool.status 造成双写不一致。
A 前端读 `availability`；Loan 仍读自己的 `status`。唯一并发保护来自部分唯一索引
`uq_loans_one_active_tool` / `uq_loans_one_active_requirement`（规格 5.2，迁移中原样创建）。

## 6. 本阶段范围

- 已实现：健康检查、demo 登录/注销、`/me`、数据库迁移、种子数据、错误/信封/幂等/geo/constants 共享模块、空壳路由（tools/loans/tasks/community 留给后续任务）。
- 未实现（后续任务）：工具发布与列表、借还状态机、任务与需求状态、社区/环境数据、真实外部适配器（`app/adapters/base.py` 只定义协议与 envelope，未发任何外部 HTTP）。

## 7. 文档交付（2026-10-03）

B 本轮交付三份后端集成文档，与 A/C/D 的分界如下：

- `README.md`（新）：面向 A/C/D 集成的启动与边界说明——技术栈实际版本、安装启动、环境变量、数据库重置、演示账号、健康检查与 OpenAPI 地址、测试方法，以及给 A/C/D 的接口边界一句话。
- `docs/API_SAMPLES.md`（新）：按规格 8.2 全部端点、以用户故事排序的可复制 curl 样例（含 Authorization 与 Idempotency-Key 头、示例 UUID、成功 envelope 与关键错误），并整理规格 8.4 请求示例与 8.5 错误码表为附录。
- `docs/DECISIONS.md`（本文件，追加）：技术决策记录。

不在本文档范围：前端页面与整合入口（A）、外部数据适配实现（C）、演示叙事/汇报材料/任务界面文案（D）。`scripts/check_api.sh` 是 B 自用的接口冒烟检查脚本，同样不属于 A/C/D 交付。

API_SAMPLES 按规格契约编写；tools/loans/tasks/community 端点由并行任务实现中，文档已标注「以实际 OpenAPI 为准」，实现落地后核对一次。

## 8. 未认证响应统一为 401（2026-10-03，主会话裁决）

早期为通过地基测试「裸请求 → 404」的约定，`tools` / `loans` / `community` 的集合路由和 `tasks` 的
`require_task_viewer` 各自实现了「无 Authorization（且无 query / 仅带 X-User-Id）→ 404」的兼容分支。
真实端点落地后，该分支与规格 8.5「token 缺失/无效/过期/注销 → 401 UNAUTHENTICATED」冲突。

裁决：**规格优先**。删除上述兼容分支，任何业务端点未认证一律经 `get_current_user` 返回
401 `UNAUTHENTICATED`，与是否携带 `X-User-Id`、是否携带 query 无关。防伪造意图保持不变：
`X-User-Id` 从不作为身份依据（鉴权入口不读它）。

连带修正的测试语义（同一裁决）：
- `tests/test_health_auth.py::test_shell_route_has_no_data_for_spoofed_header`：期望 404 → 401，
  并补断言 `error.code == UNAUTHENTICATED`、响应体无 `data`（伪造头与裸请求两种情形）。
- `tests/test_tasks.py::test_spoofed_user_id_header_unlocks_nothing`：伪造头分支 404 → 401。
- `tests/test_loans.py::test_loans_require_authentication`：裸 `GET /api/v1/loans` 404 → 401 并断言错误码。

公开端点不受影响：`/health/live`、`/health/ready`、`POST /api/v1/demo/sessions` 仍公开；
`POST /api/v1/sessions/logout` 无 token 仍 401。证据见 `docs/TEST_REPORT.md` 第 3.6 节。

## 9. 环境数据适配器整合（C → B，2026-10-03）

C 的独立环境服务（origin/main `services/`）已按 B 的结构与规范移植进适配器层，
对外路由 `/api/v1/communities/resolve`、`/{id}/environment`、`/{id}/impact` 的
请求/响应形状不变（`app/schemas_community.py` 契约保持），只换实现来源。

### 9.1 移植对照（C 的函数 → B 的适配器）

| C（origin/main services/environment_service.py） | B（backend/app/adapters/） |
|---|---|
| `EnvironmentService.get_carbon_intensity(outcode)` | `carbon.py`：NESO `regional/postcode/{outcode}`，clean-energy 占比 / top source / from-to 有效性窗口解析 |
| `EnvironmentService.get_air_quality(lat, lon)` | `air.py`：Open-Meteo `current=european_aqi,pm10,pm2_5`，C 的 AQI 分级阈值，按 model timestamp + interval 给出 validity |
| `EnvironmentService.get_nearby_green_spaces(lat, lon)` | `greenspace.py`：Overpass park/garden 1.5km 查询，C 的 haversine 距离、无名跳过、距离排序、top-5 截断 |
| `EnvironmentService.normalize_postcode` / `format_uk_postcode` | `postcode.py` 吸收，fetch 内部先归一化再请求上游 |
| `services/demo_cache.py`（DEMO_CACHE） | `c_demo_cache.py`（新）：EH14 4AS / EH1 1YZ / EH8 9YL 离线 fixture |
| `EnvironmentService.get_community_snapshot` 聚合 | 不移植：B 的聚合由 `services/environment.py` 的 per-provider envelope 编排承担 |

### 9.2 关键决策

- **HTTP 全部在适配器内、事务之外**：三个适配器统一用模块级 `_fetch_json(url)`
  （httpx，超时 3.5–4s，自定义 User-Agent），测试 monkeypatch 该 helper，不发真实
  网络请求。失败一律返回 `status="unavailable"`，不抛穿（base.py 协议）。
- **AdapterEnvelope 无 source_kind 字段**，因此 C 的 demo_cache 回落不放在适配器内，
  而由服务层标注：`environment.py` 在「适配器不 ok 且无 stale 缓存」时查
  `c_demo_cache.fixture_section()`，以 `source_kind="fixture"` 提供数据；
  `community.py` 的 resolve 在上游失败且无 verified cache 时，对 demo 邮编
  upsert `source_kind="fixture"` 的社区行。fixture 数据不写入 external_cache，
  绝不冒充 live。
- **source_url / attribution 用真实来源**：postcodes.io、Open-Meteo Air Quality
  API 文档、NESO Carbon Intensity API 文档、Overpass API（© OpenStreetMap
  contributors），无编造。
- **C 的 demo_cache 在 origin/main 只有 EH144AS / EH11YZ 两条数据**（docstring
  提到 EH8 9YL 但数据缺失）；按任务要求补齐 EH8 9YL（University of Edinburgh /
  George Square 区域，与种子 fixture EH8 9AB 同区），形状与 C 的条目一致。
- **C 的 urllib 实现改为 httpx**：与 B 现有 postcode 适配器一致，httpx 已在
  requirements 中；解析逻辑（阈值、haversine、clean-fuel 集合）逐行保留 C 的语义。
- **C 的 GIR0AA 特例**：C 的 `format_uk_postcode` 无 GIR 特例（"GIR0AA" →
  "GIR 0AA"，恰好正确）；B 的 `precheck` 已有 `_to_canonical` 特例，服务层
  行为不变，适配器只保留 C 的通用逻辑。

### 9.3 CORS（app/main.py）

前端 Vite 开发服务器（5173）跨域访问：`CORSMiddleware` 限定
`http://localhost:5173` 与 `http://127.0.0.1:5173` 两源，`allow_credentials=True`，
methods/headers 开放（覆盖 Authorization、Idempotency-Key、Content-Type），
`expose_headers=["X-Request-Id"]`。预检与响应头经 uvicorn + curl 实测（见
docs/TEST_REPORT.md 第 4 节）。

### 9.4 测试

- `tests/test_environment.py`：三个 provider 的 not_implemented 断言已按新实现
  改写——mock `_fetch_json` 断言 envelope 形状、失败降级（unavailable +
  非空 source/source_url/attribution）、live 解析形状、demo fixture 回落
  （source_kind="fixture" 且不写 external_cache）、缓存 fresh/stale/expired
  行为与 404/401 错误码；新增 CORS 预检/响应头断言。
- `tests/test_community.py`：保留全部既有断言（422/503/401 等），新增
  normalize/format 单元测试、上游全断时 demo 邮编 fixture 回落、非 demo 邮编
  仍 503、适配器归一化后请求上游 URL、网络错误降级。
- `tests/test_adapters_live_shapes.py`（新）：适配器层单元测试——NESO/Open-Meteo/
  Overpass 真实 payload 形状的解析、畸形 payload 与网络异常降级、AQI 分级
  边界、top-5 截断、haversine 参考值、postcode 200/404/500/异常路径。
- 全量 `.venv/bin/pytest -q`：201 passed（基线 156，总数未减少）。

## 10. 移除演示访问码（2026-10-03，用户决策，覆盖规格 4.1）

**决策**：用户明确要求彻底移除 `DEMO_ACCESS_CODE` 功能——登录不再需要任何访问码。
本条是对原规格 4.1 的明确覆盖，以用户说明为准。

**原 4.1 的设计意图与现在的位置**：

- 原设计意图是**防滥用 + 强制诚实的演示身份**——登录必须持有团队运行时空投的访问码，
  避免陌生人随手冒充演示身份，也避免把演示环境当成公开注册服务。
- 现在改为**本地演示无门禁**：项目在本机 `./start.sh` 下自用，访问码只增加摩擦
  （要生成、传递、印在横幅上），没有对应的真实防护价值；`web/` 侧与文档也无需再同步这个秘密。
- **演示身份仍然是 demo account，不是真实注册**：`users` 表不存密码、不能自助注册，
  只有种子 alias（alice / bob / carol），界面与文档仍须标注 "demo account"，不代表已验证居民身份。
  这一点与访问码是否存在无关，保持不变。
- `APP_MODE=production` 仍拒绝启动（真实认证未实现），保留。

**实现要点**：

- `app/config.py`：删除 `_PLACEHOLDER_CODES`、`MIN_ACCESS_CODE_LENGTH`、`_read_access_code()`
  与 `Settings.demo_access_code` 字段；缺失、空值、占位、过短都不再影响启动。
  仍校验 `APP_MODE` ∈ {demo, production}、`DATABASE_PATH` 非空、`SESSION_TTL_HOURS >= 1`。
- `app/routers/auth.py`：`DemoLoginRequest.access_code` 改为**可选字段并直接忽略**
  （`str | None = None`），兼容旧客户端不报 422；`extra="forbid"` 保持，未知键仍 422。
  成功仍 201 返回 `access_token / token_type / expires_at / user`。
- `app/auth.py`：删除 `verify_access_code()` 与常数时间比较；`create_demo_session(alias, ip)`
  只校验 alias 存在且激活。**限流改为对 demo 登录 POST 本身的宽松每 IP 限制：
  60 次/分钟**——取「宽松限流」这一选项，理由：访问码失败计数已失去语义（不再有凭证失败），
  而登录端点现在完全无门禁，保留一个远高于正常使用量的上限即可挡住廉价刷接口，
  同时不会误伤本地演示（正常一次会话只登录 1–2 次）。token 生成/哈希/会话/注销/
  `get_current_user` 逻辑不变。
- `start.sh`：删除访问码的生成、长度校验与横幅打印；启动流程其余不变
  （venv、依赖、数据库、双端、Ctrl+C），横幅只提示 alice / bob / carol。
- 测试：`conftest.py` 删除 `TEST_ACCESS_CODE`，`login()` 只传 `user_alias`；
  `tests/test_health_auth.py` 改写为「无 `DEMO_ACCESS_CODE` 也能启动与登录」
  「带无关注键 `access_code` 也成功」「未知 alias 仍 401」「注销后 401」「无 token 401」
  「`X-User-Id` 伪造无效」「60 次/分钟后 429」。
- 文档：`README.md`、`.env.example` 删除该环境变量条目；`API_SAMPLES.md` 登录示例
  只发 `user_alias` 并注明可选且被忽略；`TEST_REPORT.md` 追加本次实测记录。

**已知遗留（不在本次授权文件范围内，未改动）**：
`scripts/dev_server.sh`、`scripts/check_api.sh` 仍要求设置 `DEMO_ACCESS_CODE` 才能运行，
其发送的 `access_code` 现在会被后端忽略（check_api.sh 仍可跑通，但需先随手设一个值）。
