# Borrow Next Door · 成员 A 前端

## 运行

需要 Node.js，无需安装 npm 依赖。在此目录运行 `npm start`，访问 http://localhost:5173 。也可直接打开 `web/index.html`；推荐本地服务器，便于同源标签页演示。

## 需求分析与设计

PDF 赛题要求：以邮编为中心帮助邻居改善环境，展示空气、绿地和电力信息，鼓励共同参与；更多居民加入后产品更有用是 stretch goal。专题评分为 Innovation / Fit to brief / Quality / Interactivity 各 10，Teamwork / Presentation 各 5。

根据分工 Markdown，A 负责页面框架、社区首页、工具列表与发布、我的借入借出、状态提示及整合入口。B 的共享后端、C 的真实环境与地理信息、D 的正式任务模块仍由对应成员实现。

设计采用英文本地社区产品语气，奶油白与森林绿、低饱和工具插画、清晰的大按钮及移动端布局。插画由内联 SVG 构成，没有远程图片依赖。Google Fonts 不可用时自动回退系统字体。

三个视图：
- `#community`：邮编格式检查、社区内工具筛选和搜索、发布工具、环境卡及地图嵌入区。
- `#task`：两个任务模板、需求清单、自备确认、借用请求与成果记录；为 D 提供替换位置。
- `#loans`：借入 / 借出、接受 / 拒绝、交接、确认归还、待处理申请取消。

## 已实现与边界

本版是**浏览器本地交互原型**。localStorage 保存样例数据，storage 事件同步同源标签页。不是共享后端，不证明不同设备协作，也没有并发原子性、认证、服务端权限或可信统计。Alice / Bob 只是演示身份。前端状态检查必须由 B 的服务端再次执行。

邮编只检查大致格式，不保证真实存在。默认 EH8 9YL 是样例社区。环境信息显示未连接，不伪造实时空气、电力或真实绿地结果。不同邮编有独立工具筛选；无工具时显示空状态。地图区域是有意保留的空位。

已区分发现工具、pending、accepted、on_loan、returned 与任务完成。归还不自动完成任务；任务成果允许发起者独立自报，完成后借还记录仍保留。成果面板只统计本地 returned 记录和完成任务，不估算减碳。

## B：接口交接建议

当前对象保存在 `web/app.js` 的 `state` 中；API 路径为建议，需团队确认。接入时把 `persist` 及直接 state 修改替换为异步 API，请求期间禁用提交按钮、显示 loading；失败保留表单内容并显示服务端错误，成功重新获取工具、任务、本人请求。**尚未实现 HTTP 数据适配器与网络 loading 状态**，因为 B 的接口未提供。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/tools?postcode=… | 工具列表 |
| POST | /api/tools | name, category, description, postcode；owner 由服务端身份决定 |
| GET | /api/loans | 当前用户借入与借出记录 |
| POST | /api/loans | tool_id, task_id；原子保留 available 工具 |
| PATCH | /api/loans/:id | status；校验身份及合法转换 |
| GET / POST | /api/tasks | 用户任务读取与创建 |
| PATCH | /api/tasks/:id | 地点、自备确认、独立成果提交 |

Tool: `id, owner_id, name, category, description, status, postcode`。
LoanRequest: `id, tool_id, borrower_id, task_id, status, created_at, returned_at`。
Task: `id, creator_id, template_id, postcode, place_name, status, self[], outcome_note, completed_at?`。
工具类别：`picker, gloves, spade, watering, rake`。模板：`cleanup, garden`。`self` 存自备类别，后续可以转换为正式 TaskRequirement。

请求：`pending → accepted → on_loan → returned`；pending 可 rejected 或 cancelled。
工具：申请时 available → reserved；接受后仍 reserved；实际交接变 on_loan；拒绝、取消、归还恢复 available。
工具出借者可接受、拒绝、交接、确认归还；申请人可取消 pending 请求。B 必须用数据库事务保证一个工具只有一个有效请求。

## C / D：嵌入与组件位置

在 `web/integrations.js` 配置受信任的 URL，即可替换空位：

| key | 位置 | 负责人 |
|---|---|---|
| map | 首页右侧地图区 | C |
| air | 空气卡 | C |
| electricity | 电力卡 | C |
| tasks | 任务需求清单区 | D |
| outcomes | 成果统计区 | D |

iframe 默认 `sandbox="allow-scripts allow-forms allow-popups"`，不允许同源权限。需要 cookies、存储或认证的工具可能不可用；优先使用独立部署的嵌入页，评估信任后再修改 sandbox。对方服务必须允许 iframe，不能有阻止嵌入的 CSP / X-Frame-Options。当前 iframe 只提供显示位置，**没有身份 / 邮编 / 任务状态通信协议**；真正整合推荐直接替换 `slot()` 对应组件，或双方约定并严格验证 origin 的 postMessage。

C 返回数据建议包含 `status, value, source, timestamp, scope`。空气、电力、绿地分别加载与失败降级。D 可以替换 taskPage 与 requirementStatus，并复用 B 的真实状态。不要把可申请标为已落实，不能把区域环境变化归因于应用行动。

## 演示步骤

1. Alice 进入 Make a difference，选择清理绿地；垃圾夹缺失。
2. 切换 Bob，在首页 Lend a tool 发布 Litter picker。
3. 切回 Alice，任务清单出现可申请垃圾夹；申请后是 awaiting confirmation。
4. 切回 Bob → My borrowing → I’m lending，Accept request。
5. 实际交接后 Confirm handover，归还后 Confirm returned。
6. Alice 在任务页独立填写 outcome 并记录完成，查看两种独立计数。
7. 要重置，在浏览器控制台运行 `localStorage.removeItem('bnd-demo-v1'); location.reload()`，只清除本项目数据。

## 检查

`npm run check` 检查 JavaScript 语法。浏览器验收时检查桌面 / 手机布局、键盘导航、无效邮编、空工具列表、发布、双身份状态流转、刷新持久化和任务成果独立计数。共享后端接入后还需要跨设备及并发预约测试。
