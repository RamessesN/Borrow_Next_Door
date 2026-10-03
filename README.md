# Borrow Next Door · 集成运行指南

## 项目简介

以邮编为中心的邻里工具共享应用：借一件邻居的工具，组织一次公园清洁或花坛养护，再记录归还与行动成果。本仓库包含前端（`web/`）、后端（`backend/`，FastAPI + SQLite）、对接文档与测试。工具、任务、借还记录由后端保存，不靠浏览器假数据替代多人协作。

这是本地比赛演示，不是真实居民注册服务。**登录无需任何访问码**，演示身份只需选择账号；没有密码，也不代表已验证居民身份。后端演示登录限流为每 IP 每分钟 60 次请求，未实现真实认证前 `APP_MODE=production` 拒绝启动。

## 怎么用（从零开始）

### 1. 打开终端，运行 `./start.sh`

先安装 Python 3.11+ 和 Node.js，再在终端进入下载好的项目文件夹（能看到本文件与 `start.sh`）：

```bash
cd /你的路径/GREENER_BY_POSTCODE
./start.sh
```

脚本会创建 `backend/.venv`、安装后端依赖、首次初始化演示数据库，并同时启动后端 :8000 与前端 :5173。**无需生成、填写或传递任何访问码**。保留这个终端窗口；演示结束后按 `Ctrl+C`，两个服务会一起停止。

Windows 用户可在 WSL / Git-Bash 中运行，或参考下方手动启动命令。

### 2. 在浏览器打开页面

脚本会尝试自动打开浏览器。若没有打开，手动访问 http://localhost:5173 。后端接口文档在 http://127.0.0.1:8000/docs 。打不开时先看终端是否报错，确保服务仍在运行。

### 3. 选择 Alice / Bob / Carol 登录

在登录面板选择一个 **demo account**，点击登录即可，不需要访问码。三位用户的 home 社区都是 `EH8 9AB`。全新种子里这里有 3 件工具：Alice 的浇水壶、手铲，以及 Bob 的可重复使用手套。

第二个有工具的演示街区是 `EH14 4AS`，由 Dora / Eve 持有 4 件工具：长柄垃圾夹、备用手套、铜浇水壶、宽手铲。Dora / Eve 不在前端登录选择器中，用邮编浏览即可看到他们的工具。

### 4. 三个页签分别做什么

- **社区首页（The neighbourhood，`#community`）**：看邮编环境卡、`Postcode green context score`、工具列表；筛选/搜索工具，点击 `Lend a tool` 发布工具，或申请借用。
- **社区行动（Make a difference，`#task`）**：选择 `Park cleanup` 或 `Flowerbed care` 模板，为每类需求借工具或勾选自带，查看进度；实际开展行动后填写成果说明、垃圾袋数与志愿分钟数。
- **借入借出（My borrowing，`#loans`）**：`I’m borrowing` 查看自己借入的工具，`I’m lending` 查看借出的工具；出借方依次确认接受、交接和归还。发送申请、接受预约、交接与归还是不同状态。

### 5. 输入邮编，搬家到另一个街区

在首页邮编输入框中输入 `EH14 4AS`，点击 `Check a postcode`。这一次是**真的搬家**：前端调用 `POST /api/v1/me/community`，把当前 demo 账号的 home 社区切到该邮编；随后环境卡、工具列表、任务与发布工具都从这一个 home 上下文刷新，你应看到 EH14 4AS 的工具（Dora / Eve 的 4 件工具），而不是 EH8 的工具。

首页邮编框下方会出现提示条：`You moved to EH14 4AS (EH14). Your previous street is EH8 9AB.`，并带一个 **`Back to my previous street`** 按钮（点击后提示 `Back to your street: EH8 9AB.`）。也可以在输入框里重新输入 `EH8 9AB` 回去。

**搬家会持久化**：写入的是服务端账号的 home 社区（以 `GET /api/v1/me` 为准），刷新页面后仍在新街区；而“回到上一条街”这个入口也**能跨刷新保留**——前端只把上一个邮编当作 UI 提示存在 `localStorage`（键 `bnd.previousHomePostcode`），账号的权威社区始终来自服务端 /me。想恢复种子的 `EH8 9AB`，运行 `./start.sh --reset`。

**输入自己当前的邮编是空操作**：不会改变账号，也不会向 `POST /api/v1/me/community` 发起写入，只会提示 `EH8 9AB is already your home street.`。

跨街区可见不等于可借，后端仍按距离与权限校验（借用范围是当前 home 街区 2 km 内）。

若旧数据库没有目标街区，先用 `./start.sh --reset` 重建（会清空已有业务记录）。

### 6. 双窗口 Alice / Bob 演示故事（7 步）

请用**两个独立浏览器会话**：例如普通窗口登录 Alice，无痕窗口登录 Bob，或两个浏览器/浏览器配置。不要只开同一浏览器的两个普通窗口，因为它们共享登录存储。双方操作后，另一窗口可刷新页面查看新状态（当前不是实时推送）。

> ⚠️ **两个窗口必须在同一条街**：输入邮编会真的搬家，所以如果 Alice 之前查看过 `EH14 4AS`（或 Bob 搬走了），两人就不再在同一个社区。开始本故事前请先让两人都回到 `EH8 9AB`，尤其是 **Alice 必须先回到 `EH8 9AB`**：点击 `Back to my previous street`，或在输入框重新输入 `EH8 9AB`，要么直接 `./start.sh --reset`。否则 Bob 的工具会落在 2 km 之外，第 4 步借用时按钮显示 `Too far to borrow`，强行调用则失败：`That tool is in another neighbourhood. Borrowing works within 2 km of your street.`（错误码 `OUT_OF_RANGE`）。

1. **分别登录**：窗口 A 选择 Alice，窗口 B 选择 Bob；两人都先回到自己的 `EH8 9AB` 首页。
2. **Bob 发布工具**：在 B 的社区首页点击 `Lend a tool`，填写名称（如 “Bob’s demo litter picker”）、选择 `Litter picker` 类别并填写描述，再点击 `Make it available`。
3. **Alice 建行动**：刷新 A，进入行动页，选择 `Park cleanup`。模板生成垃圾夹与手套两类需求；手套勾选自带（`self supplied`），这样只需演示借一件工具。
4. **Alice 申请借用**：在垃圾夹需求行选择刚发布的 Bob 工具，点击 `Request from Bob`。它变为待接受申请，工具被预留，不代表已交接。
5. **Bob 接受并交接**：刷新 B，进入借入借出页的 `I’m lending`，找到申请，点击 `Accept request`，再确认交接。状态依次为 `accepted`、`on_loan`；刷新 A 可查看行动需求进度。
6. **开展行动并归还**：假定两人已实际完成清洁，Alice 将工具交回；Bob 在 B 中确认归还。工具重新可借，借还记录为 `returned`，Alice 对应需求为 `fulfilled`。
7. **Alice 记录成果**：刷新 A，回行动页，填写成果说明、袋数和志愿分钟数并提交。查看行动完成、归还次数等指标；成果是 **self-reported**，不是外部核验，也不会当成区域环境改善的证明。

### 7. 地图卡片与最近可借工具路线

地图模块 `web/map-module.js` 为最近可借工具提供路线规划：用网格图构建候选路径，以 A* 计算每件候选工具的路径并按成本选最近者；模块同时提供 Dijkstra，单测用它核对 A* 的最短路径成本。地图卡片可显示候选工具、最近工具高亮、路径与估算距离；无工具或无有效坐标时显示空/降级状态，不虚构路线。

这是**邮编中心点与合成网格的算法演示**，不是真实道路、步行导航或实时 GPS；网格路径长度与直线距离是两种指标。可借状态、是否本人所有与借用权限仍以工具列表和后端校验为准。绿地列表则来自环境数据，按距邮编中心的直线距离排序，与借工具路线不是同一数据。

### 8. 常用命令

以下命令从项目根目录执行：

```bash
./start.sh              # 保留现有数据库启动，无访问码
./start.sh --reset      # 删除并重建演示数据，然后启动；会清空任务/借还记录
./start.sh --help       # 启动选项
(cd backend && .venv/bin/pytest -q)  # 后端测试
npm test               # 前端单测 + 尝试真实后端 smoke
npm run check          # 前端语法检查
```

2026-10-03 本轮最终实测：后端 **203 passed**，前端 Node 测试 **69 passed**（含地图接线新增测试）。指定临时真实后端的 smoke 已通过。`npm test` 在默认 :8000 无服务时会明确 **SKIP**，这不算通过；详见 `backend/docs/TEST_REPORT.md`。

手动启动（先按 `backend/README.md` 安装依赖）：

```bash
(cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1)
# 另一个终端，在根目录
npm start
```

已有数据库才可直接启动；需重建时用 `(cd backend && .venv/bin/python scripts/reset_db.py)`。`backend/scripts/dev_server.sh` 每次都会重建数据库，不能用它保留演示进度。

开发端口可用 `BACKEND_PORT=8100 FRONTEND_PORT=5200 ./start.sh` 改写；前端跨域来源/接口地址是否适配新端口需另行确认，默认 8000/5173 最稳妥。

## 数据来源与诚实标注

- 邮编与中心坐标：[postcodes.io](https://postcodes.io/)。种子坐标是 fixture，不等于用户精确住址。
- 区域电力与能源结构：[NESO Carbon Intensity API](https://carbonintensity.org.uk/)。区域数据不是该社区行动减少的碳排放。
- 空气质量：[Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)，为模型估算，不是现场传感器测量。
- 附近绿地：Overpass API / [OpenStreetMap](https://www.openstreetmap.org/)，© OpenStreetMap contributors；结果最多 5 个，距离为中心点直线估计，不是完整绿地覆盖率。
- 环境响应区分 live / cache / stale / fixture。外部服务不可用时可用离线演示快照（含 `EH8 9AB`、`EH14 4AS`），页面明确标注 demo snapshot；无数据则显示 pending/unavailable，不填零冒充实测。
- `Postcode green context score` 是公开区域数据的上下文估算；缺少所需 provider 时不显示总分，不与借还/行动成果指标混在一起。

## 完成范围与已知限制

**已完成**：无访问码演示登录、工具发布/浏览、后端借还状态机、任务模板与逐类需求、成果自报、社区环境适配与缓存/降级、绿地列表与区域评分卡、home/browse 邮编分离、两个有工具的演示街区、地图算法模块。模板切换复用已存在的开放任务并保留进度，不重复创建同模板任务。

**未做 / 暂缓**：

- 照片上传与成果照片存储。
- 同一类别多个工具槽位 / 多数量需求（目前模板每类 1 个需求，`quantity=1`）。
- `would_have_bought_new` 问卷与“避免购买新品”成果指标。
- 真实注册/居民验证、production 认证、真实道路导航、实时多人状态推送、负载与长时间稳定性验证。

外部网络会影响环境数据；借还业务不依赖外部环境 API 成功。地图 UI 接线由并行整合完成，本轮验证了模块单测与 mock DOM 地图接线测试，未进行真实浏览器地图操作验收。另保留 `EH16 5AA` 无工具 fixture 做距离边界测试，因此种子数据库共有 3 个社区，但面向演示的有工具街区是上述 2 个。

## 目录与对接文档

```text
backend/       # FastAPI + SQLite、脚本、pytest、后端文档
web/           # app.js / api.js / task-module.js / map-module.js / integrations.js
test/          # Node 单测、mock DOM/API 流程、文档契约
services/      # 队友原环境服务，后端适配器已整合其逻辑
docs/handoff/  # 团队接口与边界说明
server.cjs     # npm start，前端静态服务器
start.sh       # 一条命令启动前后端
```

| 文档 | 内容 |
|---|---|
| `backend/README.md` | 后端安装、配置、接口边界与安全说明 |
| `backend/docs/API_SAMPLES.md` | curl 接口样例（以实际 OpenAPI 为准） |
| `backend/docs/TEST_REPORT.md` | 真实测试命令、计数、通过/跳过边界 |
| `backend/docs/DECISIONS.md` | 技术选择及本轮整合决策 |
| `docs/handoff/B-data-layer.md` | 字段、状态机、幂等、权限与并发契约 |
| `docs/handoff/B-backend-contract.md` | 旧模型到 B 契约映射 |
| `docs/handoff/A-ui-boundary.md` | 前端边界与测试钩子 |
| `docs/handoff/C-location-data.md` | 位置数据与适配器层说明 |

业务接口（除登录/注销）写请求带 `Idempotency-Key`（UUID），由前端自动发送。直接调登录 API 时只需要 `{"user_alias":"alice"}`；成功返回 Bearer token，后续业务请求用 `Authorization: Bearer <token>`。
