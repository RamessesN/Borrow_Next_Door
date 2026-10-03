# A · 界面边界说明

> **一句话：整合已经完成，这里写清楚哪些是你的、哪些是我的，以及 3 条不能破的规则（回归测试会挂）。**

PR [#1](https://github.com/RamessesN/GREENER_BY_POSTCODE/pull/1) 已合并进 `Website-1`。我改的是你 `web/app.js` 里的 3 个函数和 2 个事件处理器，其余全是新增文件和文档。

## 1. 我改了你哪几处

| 位置 | 改动 | 你要注意的 |
|---|---|---|
| 顶部常量 | `categories` / `templates` 改成从 `D.CATEGORIES` / `D.TEMPLATE_LIST` 派生 | 多了两个模板（`street_trees`、`spring_bulbs`），模板的 `name` / `blurb` / `icon` 都从模块来 |
| `ensureTask()` | 改用 `D.createTask()`，并对老任务跑一次迁移 | 老 `self: []` 会变成 `requirements[]`，前端自动转并写回一次 |
| `requirementStatus()` | **删除** | 判定权交给 `D.describeTask()`。下面 §4 有替代写法 |
| `taskPage()` | 整段换成 D 的组件 | 见 §5 |
| `borrow()` | 多一个 `requirementId` 参数 | 不带该参数时走原来的按类别兜底，社区页的调用不用改 |
| click 处理器 | `data-borrow` 现在会带 `data-req`；`data-template` 走 `D.setTemplate()`；`complete-task` 改收自报字段 | — |
| change 处理器 | `data-self` 的值从**类别**变成**槽位 id**；新增 `#impact-bought-new` | 如果你别处也用了 `data-self`，要对齐 |
| input 处理器 | 新增 `#impact-bags` / `#impact-minutes` 的持久化 | — |
| `storage` 事件 + 初始化 | 加载时对全部任务跑一次迁移，有变动才写回 | — |

## 2. 文件归属

| 文件 | 负责人 | 说明 |
|---|---|---|
| `web/task-module.js` | **D** | 纯函数。**不要在这里加 DOM、`state`、`localStorage`、`fetch`** —— 它要能脱离浏览器跑测试 |
| `test/task-module.test.cjs` | D | 23 个纯函数用例 |
| `test/contract.test.cjs` | D | 5 个文档契约用例：守住这两份说明里承诺的字段名和函数名，改坏了会直接报错 |
| `test/e2e-demo.test.cjs` + `test/harness.cjs` | D | 在 vm 里加载 `task-module.js` + 你的 `app.js`，模拟真实事件跑完整演示故事 |
| `web/app.js` | **A** | 渲染层。随便改，但见 §3 和 §5 |
| `web/styles.css` / `web/index.html` | A | 我只在 `styles.css` 末尾追加了 D 相关的类（`.req-actions` / `.wanted-strip` / `.impact-metric` / `.outcomes` 的 grid 覆盖 / `.requirement.state-*`），在 `index.html` 加了一行 `<script src="task-module.js">` |
| `web/integrations.js` | A | `tasks` / `outcomes` 两个 key 现在**留空时走原生组件**，配了 URL 才走 iframe。你的扩展点没被拆掉 |
| `README.md` | 共有 | 我加了一节「D：任务匹配与成果模块」 |
| `docs/handoff/` | D | 给 B 和 C 的对接说明 |

## 3. 渲染层必须遵守的 3 条规则

这三条都有测试守着。破了 `npm test` 会挂。

### 3.1 渲染不创建数据

**不要在渲染路径里调 `ensureTask()`。**

我修掉了一个 bug：原来的 `taskPage()` 调了 `ensureTask()`，于是**任何人打开任务页都会凭空创建一条任务** —— 评委切到 Bob 看一眼，Bob 就多出一条任务进了共享数据，还上了缺口板。

现在没有 planning 任务时，任务页显示「Pick an action above」，只有选择模板 / 申请工具 / 勾选自备 / 提交成果时才写入。B 接后端时不需要为「页面被浏览」造一条记录。

### 3.2 借用完成 ≠ 任务完成

工具 `returned` 之后，槽位会退回 `available` / `missing`；任务状态**仍然是 `planning`**。任务成果只能由发起者单独提交。

`D.outcomeReadiness()` 只**警告**还有未归还的工具，不阻止提交。不要「顺手」在归还时把任务标成完成。

### 3.3 未采集的数据不能显示为 0

`impactReport()` 的每个指标都有 `available` 字段。`available: false` 时**必须**显示 "Not collected yet"，不能显示 `0`。

「清理袋数 = 0」和「没人填过清理袋数」是两件不同的事。简报里那段「缓存数据和示例数据的标注必须清楚」就是这个意思。

## 4. `requirementStatus()` 的替代写法

原来：

```js
const s = requirementStatus(task, category);
s.ready      // 是否已落实
s.label      // 文案
s.tool       // 可申请的工具
s.pending    // 是否已发出申请
```

现在：

```js
const ctx = taskContext(task);            // { tools, loans, names, viewerId, task }
const rows = D.describeTask(task, ctx);   // 每个槽位一行
const row  = rows.find(r => r.requirementId === reqId);

row.state        // 'confirmed' | 'pending' | 'available' | 'missing'
row.confirmed    // boolean
row.pending      // boolean
row.statusText   // 显示用文案（已经写好，直接 esc() 用）
row.tools        // 可申请的工具数组，[0] 是最近的一个
row.tools[0].distanceKm   // 数字或 null
row.tools[0].scope        // 'same_postcode' | 'nearby'
row.loans        // 该槽位已有的请求，含 stage / stageLabel
```

还有三个现成的聚合：

```js
D.taskProgress(task, ctx)   // { total, confirmed, pending, missing, percent, complete, rows, nextAction }
D.wantedBoard(tasks, ctx)   // [{ category, label, slots, taskCount }] —— 缺口板
D.impactReport(tasks, loans, { postcode, tools, names })   // { metrics[], disclaimer, scope }
```

**核心边界：不要在 `app.js` 里重新写「可申请 / 已落实」的判断。** 那正是我删掉 `requirementStatus()` 的原因 —— 两套判断一定会不一致。要什么取什么。

## 5. 如果你想重构任务页

可以。整段替换 `taskPage()` 我没意见，但**保留这几个钩子**，否则 `test/e2e-demo.test.cjs` 会挂：

| 钩子 | 值 | 用途 |
|---|---|---|
| `data-borrow` + `data-req` | 工具 id + **槽位 id** | 申请某一件工具填某个槽位 |
| `data-self` | **槽位 id**（不是类别） | 勾选「I'll bring my own」 |
| `data-template` | 模板 id | 选择 / 切换行动 |
| `#complete-task` | — | 提交成果 |
| `#outcome-note` | — | 成果叙述 |
| `#impact-bags` / `#impact-minutes` / `#impact-bought-new` | — | 自报数字与问卷 |
| `#place-name` | — | 任务地点 |

改钩子也可以，同步改 e2e 测试就行 —— 那个测试本来就是设计成「通过真实事件驱动你的 UI」的，所以它也是你重构时的安全网。改动前跑一次 `npm test`，改完再跑一次。

另外两个提醒：

- **`#impact-*` 输入框是即时持久化的**（`input` 事件里写 state）。如果你把面板改成受控组件或延迟提交，记得同步改那两个处理器。
- **不要在渲染里调 `ensureTask()`**（§3.1）。如果你需要「当前任务」用 `currentTask()`，它可能返回 `undefined`，要能处理空状态。

## 6. 提 PR 前

```bash
npm run check   # 语法
npm test        # 32 个用例 + 你原有的 smoke-test.cjs
```

`smoke-test.cjs` 我没动逻辑，只是加了一行「先加载 `task-module.js`」和一个断言。它现在会顺便验证模块被正确接进来了。

## 7. 以后我不会再动的地方

- `web/styles.css` 里你自己的规则。
- `index.html` 的结构。
- 除了 `taskPage()` / `requirementStatus()` / `borrow()` 之外，你 `app.js` 的其余函数（社区页、借入借出页、身份切换、发布表单）我一行都没改。

如果我以后需要再动 `app.js`，我会开新 PR 而不是直接推。
