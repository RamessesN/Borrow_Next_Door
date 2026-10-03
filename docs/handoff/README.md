# 对接说明 · 索引

成员 D 的任务匹配与成果模块（`web/task-module.js`）已经合并进 `Website-1`。这份目录写给需要跟它对接的人。

| 文档 | 谁读 | 一句话 |
|---|---|---|
| [B · 数据层](B-data-layer.md) | 成员 B | 你负责存，我负责算。3 处 schema 变化 + 4 条服务端必须自己保证的规则。**有一个坑必须看 §7：`GET /api/loans` 不能只返回「我的」请求。** |
| [C · 位置数据](C-location-data.md) | 成员 C | 我只要 4 个数字字段和 1 个可选数组，你不用写新代码。两个接口我已经实测过了。 |
| [A · 界面边界](A-ui-boundary.md) | 成员 A | 整合已完成，这里写清楚哪些是你的、哪些是我的，以及 3 条不能破的规则（回归测试会挂）。 |

## 为什么 D 的模块不卡任何人

`web/task-module.js` 是纯函数：**零网络请求、零 URL、零 API key、零存储**。它只接收数组和对象，返回新的对象。

```bash
$ grep -nE "fetch|XMLHttpRequest|https?://|api\." web/task-module.js
NONE
```

所有外部数据（邮编坐标、绿地、工具、借用记录）都由 B 和 C 通过参数喂进来。所以：

- **B 还没建库时**：A 的 localStorage 演示数据就能跑，`npm test` 里那个端到端测试就是这么跑的。
- **C 还没接 API 时**：坐标缺失只会让「约 X km 直线距离」不显示，其他功能一律正常。

## 当前状态

- PR [#1](https://github.com/RamessesN/GREENER_BY_POSTCODE/pull/1) 已合并，`d-task-module` 分支已删除。
- `npm test`：32 个用例（23 个纯函数 + 4 个端到端演示 + 5 个文档契约）全绿。`node smoke-test.cjs` 照旧通过。
- 详细字段和规则见 `README.md` 的「D：任务匹配与成果模块」一节。
