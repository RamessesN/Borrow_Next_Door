# AGENTS.md

4 人 hackathon 项目（AdaHack 2026 · Greener by Postcode）：邻居共享工具 + 社区环境数据。
`web/` 是无构建步骤的原生 JS 前端，`backend/` 是 FastAPI + SQLite，两套测试各自独立。

分工与截止纪律见 `docs/Borrow_Next_Door_项目方案与四人分工.md`；各文件头部注释也标了 owner：
A = 前端外壳与集成（`web/app.js`、`web/index.html`、`web/styles.css`）、B = 后端与数据契约（`backend/`）、
C = 环境数据适配器（`backend/app/adapters/`）、D = 任务匹配与成果（`web/task-module.js`）。
跨 owner 改动请在同一条 PR 里说明，不要顺手重写别人的模块。

## 命令

```bash
./start.sh                     # 一键：建 venv + 建库 + 同起后端 :8000 与前端 :5173
./start.sh --reset             # 重建演示数据库（清空任务/借还记录）
./start.sh --help              # 端口/选项
(cd backend && .venv/bin/pytest -q)                                    # 后端全部（写这份时 210 项）
(cd backend && .venv/bin/pytest -q tests/test_me_community.py -k invalid)  # 单文件 / 单测试
(cd backend && ./scripts/dev_server.sh)   # 只起后端；注意它会删库重建（见"坑"）
(cd backend && ./scripts/check_api.sh)    # 对运行中的服务做 health + demo 登录冒烟
node --test test/*.test.cjs    # 前端全部（89 项；自带 mock 后端，不需要起服务）
node --test --test-name-pattern="own postcode" test/community-environment.test.cjs  # 单条前端测试
npm test                       # 前端全部 + smoke-test.cjs（后端没起时它打印 SKIP 并 exit 0）
npm run check                  # 对 6 个 JS 文件跑 node --check
```

没有 lint / 格式化 / 类型检查配置，也没有 CI：`npm run check` + 上面两个测试套件就是全部门禁。

## 坑

- **会删库**：`backend/scripts/reset_db.py` 与 `dev_server.sh` 都删除 `backend/var/*.sqlite3` 再 migrate+seed（`dev_server.sh` 每次启动都做）。只有不带 `--reset` 的 `./start.sh` 保留现有数据。
- **前端端口写死**：`server.cjs` 固定监听 5173，`FRONTEND_PORT` 不生效（用 `./start.sh` 传它会让就绪检查失败）；后端 `BACKEND_PORT` 正常。
- **没有打包器、没有 npm 依赖**：`web/index.html` 的 `<script>` 顺序就是依赖顺序（task-module → map-module → api → integrations → app），`app.js` 在 `BND_TASK` / `BND_MAP` / `BND_API` 缺失时直接 throw。
- **新增前端模块要登记 3 处**：`web/index.html` 的 script 标签、`package.json` 的 `check` 列表、`test/harness.cjs` 的 vm 加载处（并挂到 `window.BND_*`）。
- **测试替身不是空壳**：前端测试在 `test/harness.cjs`（最小 DOM + mock 后端 + vm）里跑真实 `app.js`，它复刻 B 的信封、错误码与 Idempotency-Key，所以断言是端到端行为而不是纯函数。后端 `tests/conftest.py` 顶部写明"只加测试文件、不要改这个文件"；用它的 fixture（`client`、`alice_token`、`auth_headers()`、`new_idem_key()`），数据库是真实临时 SQLite 文件而非 `:memory:`。
- **写请求都要 `Idempotency-Key`**（UUID，登录/注销除外）：同 key 重放，同 key 换 body → 409。
- **没有访问码**：demo 登录 `POST /api/v1/demo/sessions` 只传 `user_alias`（`alice`/`bob`/`carol` 在 EH8 9AB，`dora`/`eve` 在 EH14 4AS）；不要重新引入 `DEMO_ACCESS_CODE`（`start.sh` 会 unset、`conftest.py` 会 pop），`APP_MODE=production` 拒绝启动。
- **输入邮编 = 真的搬家**：只有 `POST /api/v1/me/community` 会写 `users.community_id`（`services/community.py:move_user_community`）。双窗口演示前两人必须在同一街区，否则 Bob 的工具超出 2 km，借用报 `OUT_OF_RANGE`。

## 契约与语义（改错会连带出问题）

- `docs/handoff/B-data-layer.md` 是 B 端 API 的冻结契约（路径、`{data,meta}` / `{error,meta}` 信封、错误码、状态机）；`backend/docs/API_SAMPLES.md` 是可复制 curl。
- 冻结枚举：4 个工具类别、2 个任务模板，定义在 `backend/app/constants.py`，`web/task-module.js` 镜像一份——改一处必须同步另一处。
- 环境数据语义：air 是 Open-Meteo ~11 km 网格、carbon 是 NESO 区域电网分区，所以**相邻邮编数值相同是正确的**；绿地按坐标查，应当不同。`source_kind === 'fixture'` 必须标注为演示数据，不能与实时结果混淆。
- `Postcode green context score` 是区域公共数据背景：三项来源齐全才出总分、缺失不当 0、不能算作项目成果、也不能进入 D 的成果面板（`impactPanel`）。
- `web/task-module.js`（`BND_TASK`）与 `web/map-module.js`（`BND_MAP`）是纯函数模块：不加网络、存储、DOM。

## 团队约定

- `main` 是集成分支且多人同时在推；PR 按成员前缀命名（`b-` / `d-` …），**允许自行 merge**——但 merge 前必须自己跑通 `npm run check` + 两个测试套件，merge 后 main 必须保持绿。
- 描述语言跟随你改动的模块：README 已转英文并由 B 维护，`docs/handoff/*` 与 plan 文档仍是中文。
- 文档里的数字与行为经常滞后（`docs/handoff/*` 仍写着 156 项测试、已删除的 browse 行为）：**以命令输出和代码为准**，改行为时顺手修掉你碰到的过期段落。
- 比赛简报明确"不鼓励过度依赖 AI，疑似过度依赖可能扣分"（见 `docs/Borrow_Next_Door_项目方案与四人分工.md` §11）：改动要能被队友解释，不要提交无法说明来由的大段生成代码。
