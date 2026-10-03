# 对接说明 · 索引

成员 D 的任务匹配与成果模块（`web/task-module.js`）已经合并进 `Website-1`。这份目录写给需要跟它对接的人。

| 文档 | 谁读 | 一句话 |
|---|---|---|
| [B · 后端已交付契约](B-data-layer.md) | 成员 A / C / D | **B 后端已交付，本文档是事实契约（不是任务书）**：`/api/v1` 路径、Bearer 鉴权、`Idempotency-Key`、冻结枚举（4 类别 / 2 模板）、字段表、状态机、权限、并发错误码、端点全表。 |
| [B · 旧模型映射表](B-backend-contract.md) | 成员 A / D | 一页「旧模型 → B 契约」对照：`slot`→单需求、`impact`→`outcome`、`planning`→`open`、`tool.status`→`availability`、类别 / 模板映射。 |
| [C · 位置数据](C-location-data.md) | 成员 C / D | 我只要 4 个数字字段；这些字段现在由 B 的适配器层（`backend/app/adapters/`）经 API 提供。Postcodes.io / Overpass 实测记录是适配器实现参考。 |
| [A · 界面边界](A-ui-boundary.md) | 成员 A | 整合已完成；已按 B 契约更新：鉴权、`Idempotency-Key`、loading / 错误态要求，以及不能破的 3 条规则（回归测试会挂）。 |

## 为什么 D 的模块不卡任何人

`web/task-module.js` 是纯函数：**零网络请求、零 URL、零 API key、零存储**。它只接收数组和对象，返回新的对象。

```bash
$ grep -nE "fetch|XMLHttpRequest|https?://|api\." web/task-module.js
NONE
```

所有外部数据（邮编坐标、绿地、工具、借用记录）都由 B 和 C 通过参数喂进来。所以：

- **B 已交付**：`/api/v1` + Bearer token 即可对接，契约见 `B-data-layer.md`。
- **C 的适配器已移植进 `backend/app/adapters/`**：坐标缺失只会让「约 X km 直线距离」不显示，其他功能一律正常。

## 当前状态

- PR [#1](https://github.com/RamessesN/GREENER_BY_POSTCODE/pull/1) 已合并，`d-task-module` 分支已删除。
- B 后端已交付：`backend/`（FastAPI + SQLite），156 项测试全绿（`backend/docs/TEST_REPORT.md`）。
- 本文档目录已按 B 契约更新：`B-data-layer.md` 重写为已交付契约，`A-ui-boundary.md` 更新 token 与数据形状，`C-location-data.md` 轻改去除与适配器层的冲突。
- 集成运行方式见根 `README.md`（前后端启动、演示账号、测试命令）。
