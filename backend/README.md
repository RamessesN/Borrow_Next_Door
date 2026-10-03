# Borrow Next Door 后端

邻里工具共享应用的服务端。本仓库面向团队内部集成：为 A（前端）、C（外部数据适配）、D（任务界面与演示）提供 HTTP 接口、数据库与契约，不是对外宣传项目。

## 技术栈与实际版本

独立 venv（`.venv`，Python 3.13.12）。以下为 venv 内实际安装版本（`pip freeze` 快照见 `requirements.lock.txt`）：

| 组件 | 实际版本 |
|---|---|
| Python | 3.13.12 |
| FastAPI | 0.142.2 |
| Uvicorn | 0.54.0 |
| Pydantic | 2.13.5 |
| httpx | 0.28.1 |
| pytest | 9.1.1 |

- 数据库：Python 自带 `sqlite3`，单文件 `./var/borrow-next-door.sqlite3`（相对 `backend/`，运行时自动创建 `var/`）。
- 事务：连接 `isolation_level=None`，业务写用显式 `BEGIN IMMEDIATE → COMMIT`（异常 `ROLLBACK`）；WAL 模式；每连接 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；每请求独立连接。
- 端口 8000，单 Uvicorn worker。
- `requirements.txt` 只写区间约束，精确版本以 `requirements.lock.txt` 与 venv 实际安装为准。

## 目录结构

```text
backend/
├── app/
│   ├── main.py              # FastAPI 应用工厂 + uvicorn 入口
│   ├── config.py            # 环境变量设置（启动即校验，失败拒绝启动）
│   ├── auth.py              # demo 会话、Bearer 校验、登录失败频率限制
│   ├── db.py                # sqlite 连接、显式事务、时间工具
│   ├── errors.py            # 规格 8.5 错误码表 + 全局错误处理
│   ├── idempotency.py       # Idempotency-Key 原语
│   ├── geo.py               # Haversine 距离（邮编中心点估计）
│   ├── constants.py         # 冻结的类别 / 模板 / 状态常量
│   ├── migrations.py        # 版本化数据库迁移
│   ├── seed.py              # 幂等种子数据
│   ├── schemas_common.py    # 信封与共享响应模型
│   ├── adapters/
│   │   └── base.py          # C 的外部数据适配器协议（待 C 实现）
│   └── routers/
│       ├── health.py        # /health/live、/health/ready
│       ├── auth.py          # demo 登录/注销、/me
│       ├── tools.py         # 工具端点（实现中）
│       ├── loans.py         # 借还端点（实现中）
│       ├── tasks.py         # 任务端点（实现中）
│       └── community.py     # 社区/环境端点（实现中）
├── scripts/
│   ├── dev_server.sh        # 一键启动开发服务器（端口 8000，单 worker）
│   ├── reset_db.py          # 删除并重建演示数据库（迁移 + 种子）
│   └── check_api.sh         # 接口冒烟检查（健康检查 + demo 登录）
├── tests/                   # pytest 契约测试（httpx TestClient）
├── docs/
│   ├── API_SAMPLES.md       # 可复制 curl 接口样例（规格 8.2/8.4/8.5）
│   └── DECISIONS.md         # 技术决策记录
├── var/                     # sqlite 文件所在目录（运行时创建，不入库）
├── requirements.txt         # 依赖区间约束
├── requirements.lock.txt    # 精确版本锁定（pip freeze）
└── .env.example             # 环境变量名清单（不含真实值）
```

## 安装与启动

### 1. 创建 venv 并安装依赖

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. 配置环境变量

复制 `.env.example` 到你的 shell / 进程管理器并按需填值。**不需要任何访问码**
（演示访问码已按用户决策移除，见 `docs/DECISIONS.md` 第 10 节）：`DEMO_ACCESS_CODE`
不存在于配置中，即使环境里残留该变量也会被后端忽略，不会导致启动失败。

### 3. 启动服务器

```bash
./scripts/dev_server.sh
```

> 注意：`scripts/dev_server.sh` 与 `scripts/check_api.sh` 尚未同步本次改动，
> 仍会先检查 `DEMO_ACCESS_CODE` 是否设置（本次授权的文件范围不含这两个脚本）。
> 绕过办法：`DEMO_ACCESS_CODE=dummy ./scripts/dev_server.sh`（该值不会被后端读取）。
> 最省事的启动方式是仓库根目录的 `./start.sh`（已移除访问码相关逻辑）。

`scripts/dev_server.sh` 实际执行：切换到 `backend/` → 检查 `DEMO_ACCESS_CODE` 非空（遗留，值被后端忽略）→ 默认 `APP_MODE=demo`、`DATABASE_PATH=./var/borrow-next-door.sqlite3` → 运行 `scripts/reset_db.py`（幂等：迁移 + 种子）→ `exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1`。

也可以直接调用 uvicorn（数据库已存在时）：

```bash
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

启动后：

- Swagger UI：http://127.0.0.1:8000/docs
- OpenAPI JSON：http://127.0.0.1:8000/openapi.json

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `APP_MODE` | 否 | `demo` | 仅接受 `demo` / `production`。`production` 当前拒绝启动（真实认证未实现，规格 4.1）。 |
| `DATABASE_PATH` | 否 | `./var/borrow-next-door.sqlite3` | sqlite 文件路径，相对 `backend/` 或绝对路径。 |
| `SESSION_TTL_HOURS` | 否 | `12` | 演示会话有效期（小时），≥1。 |

## 数据库与重置

数据库文件默认在 `backend/var/borrow-next-door.sqlite3`（WAL 模式）。重置会删除该文件及 `-wal` / `-shm` 副作用文件并重建（迁移 + 种子），可重复运行：

```bash
.venv/bin/python scripts/reset_db.py
```

注意：重置会清空全部业务数据，仅用于演示环境。

## 演示账号

种子数据包含三个演示身份（均属于社区 `EH8 9AB`）：`alice`、`bob`、`carol`。

这些是**演示账号，不是真实注册**：不存密码，不代表已验证居民身份。登录方式是 `POST /api/v1/demo/sessions`，**只传 `user_alias`**，成功返回 Bearer token（服务端只存 SHA-256 摘要）。不需要访问码（已按用户决策移除）；旧客户端多传的 `access_code` 字段会被直接忽略。任何界面与文档都应标注 "demo account"。

## 健康检查与接口文档

- `GET /health/live`：进程存活，不访问数据库与外部 API。
- `GET /health/ready`：数据库可读且迁移完整才 200，否则 503（不暴露文件路径）。
- 除健康检查与 demo 登录外，所有业务接口要求 `Authorization: Bearer <token>`。
- 接口样例见 `docs/API_SAMPLES.md`（按用户故事排序的可复制 curl，含规格 8.4 示例与 8.5 错误码表）。

## 测试

```bash
.venv/bin/pytest -q
```

契约测试位于 `tests/`（pytest + httpx TestClient，`testpaths = ["tests"]`）。

## 给 A / C / D 的接口边界

- **A（前端）只调 HTTP**：`/api/v1` + Bearer token，不直接连接数据库。
- **C（外部数据）只填 adapters**：实现 `app/adapters/base.py` 的适配器协议，不发业务请求、不改契约。
- **D（任务界面与演示）只做任务界面与模板文案**：模板内容归 D，B 只存储与校验；演示叙事与汇报材料不在本仓库范围。

## 安全提示

- 演示登录**无访问码门禁**（`DEMO_ACCESS_CODE` 已移除，`.env.example` 中也无该条目）；本地演示按「无门禁」设计运行，接入真实认证前 `APP_MODE=production` 仍拒绝启动。
- 未知 / 未激活 alias 登录统一返回 401；同一 IP 每分钟超过 60 次登录请求返回 429 `RATE_LIMITED`（进程内计数的宽松防刷上限，替代原「10 次失败」限制）。
- Bearer token 为 ≥32 随机字节的 opaque 字符串，服务端只保存 SHA-256 摘要与到期/注销时间。
- 错误响应不回显 `Authorization` 或原始敏感输入，不含堆栈、SQL 或磁盘路径。
