# Borrow Next Door · 集成运行指南

以邮编为中心的邻里工具共享应用。本仓库包含前端（`web/`）、B 后端（`backend/`，FastAPI + SQLite）、对接文档（`docs/handoff/`）与测试（`test/`、`backend/tests/`）。

## 目录结构

```text
├── backend/            # B 后端（已交付）：FastAPI + SQLite，端口 8000
│   ├── app/            # 路由、服务、适配器（C 的外部数据适配器在此层）
│   ├── scripts/        # dev_server.sh / reset_db.py / check_api.sh
│   ├── tests/          # pytest 契约测试（156 项）
│   ├── docs/           # API_SAMPLES.md（curl 全表）/ TEST_REPORT.md / DECISIONS.md
│   └── var/            # sqlite 文件（运行时创建）
├── web/                # A 前端：app.js / task-module.js（D）/ integrations.js
├── docs/handoff/       # 对接说明：B 已交付契约、旧模型映射表、C 位置数据、A 界面边界
├── test/               # 前端测试：纯函数 / 端到端 / 文档契约 / 冒烟
├── server.cjs          # 前端静态服务器（npm start，端口 5173）
└── package.json
```

## 启动后端（端口 8000）

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

后端需要环境变量 `DEMO_ACCESS_CODE`（团队运行时配置的演示访问码，≥16 字符；空值、占位值或短于 16 字符会拒绝启动）。两种启动方式：

```bash
# 方式一：一键脚本（校验环境变量 → 重置数据库 → 启动 uvicorn :8000）
DEMO_ACCESS_CODE=<团队访问码> ./scripts/dev_server.sh

# 方式二：直接启动 uvicorn（数据库已存在时）
DEMO_ACCESS_CODE=<团队访问码> .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

启动后：Swagger UI http://127.0.0.1:8000/docs ，OpenAPI JSON http://127.0.0.1:8000/openapi.json 。

重置演示数据库（删除并重建，迁移 + 种子，可重复运行）：

```bash
.venv/bin/python scripts/reset_db.py
```

## 演示账号（demo account）

种子数据包含三个演示身份：`alice`、`bob`、`carol`（均属于社区 `EH8 9AB`）。**这些是 demo account，不是真实注册**：不存密码，不代表已验证居民身份。任何界面与文档都应标注 "demo account"。

登录方式：

```bash
curl -s -X POST "http://127.0.0.1:8000/api/v1/demo/sessions" \
  -H "Content-Type: application/json" \
  -d '{"user_alias": "alice", "access_code": "<DEMO_ACCESS_CODE>"}'
# 成功返回 data.access_token，之后所有请求带 Authorization: Bearer <access_token>
```

## 启动前端（端口 5173）

在仓库根目录：

```bash
npm start          # node server.cjs，访问 http://localhost:5173
```

需要 Node.js，无需安装 npm 依赖。也可直接打开 `web/index.html`；推荐本地服务器，便于同源标签页演示。

## 两窗口演示路径

B 契约的核心是多人协作，**必须在两个浏览器窗口（或两台设备）中验证**，同一窗口的假数据证明不了多人流程：

1. 窗口 A 以 `alice` 登录，窗口 B 以 `bob` 登录（各自 `POST /api/v1/demo/sessions` 取 token）。
2. 一方在社区页发布工具（`POST /api/v1/tools`，类别限 `litter_picker` / `reusable_gloves` / `watering_can` / `hand_trowel`）。
3. 另一方创建任务（`POST /api/v1/tasks`，模板限 `park_cleanup` / `flowerbed_care`），对需求申请借用（`POST /api/v1/loans`，带 `requirement_id`）。
4. 工具所有者在借入借出页依次接受（`/loans/{id}/accept`）、交接（`/loans/{id}/hand-over`）、确认归还（`/loans/{id}/return`）。
5. 任务创建者独立提交成果（`POST /api/v1/tasks/{id}/complete`，自报 `outcome_note` / `bags_collected` / `volunteer_minutes`）。

所有写请求（除登录 / 注销）带 `Idempotency-Key` 头（UUID）。完整 curl 样例与错误码表见 `backend/docs/API_SAMPLES.md`，字段与状态机细节见 `docs/handoff/B-data-layer.md`。

## 测试

```bash
# 后端（在 backend/ 目录）：156 项契约测试
backend/.venv/bin/pytest -q

# 前端（在根目录）：纯函数 + 端到端演示 + 文档契约 + 冒烟
npm test

# 前端语法检查
npm run check
```

## 对接文档

| 文档 | 内容 |
|---|---|
| `docs/handoff/B-data-layer.md` | B 已交付契约：字段表、状态机、幂等、权限、并发错误码、端点全表 |
| `docs/handoff/B-backend-contract.md` | 旧模型 → B 契约一页映射表 |
| `docs/handoff/A-ui-boundary.md` | 前端界面边界与回归测试守护的钩子 |
| `docs/handoff/C-location-data.md` | 位置数据与 B 适配器层的关系 |
| `backend/docs/API_SAMPLES.md` | 可复制 curl 接口样例（按用户故事排序） |
| `backend/docs/TEST_REPORT.md` | 后端测试执行记录（156 项全绿） |
