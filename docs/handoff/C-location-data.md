# C · 位置数据对接说明

> **一句话：我只要 4 个数字字段和 1 个可选数组，你不用写任何新代码。**

我的模块不会调用你的任何接口。它只是读别人放进对象里的 `latitude` / `longitude`。你把值填进去，任务清单上的「约 X km 直线距离」就出来了；不填，就只是不显示这一行，**其他功能一律正常，不会报错**。

## 1. 我需要的全部

| 字段 | 挂在哪 | 值从哪来 | 用途 | 缺失时 |
|---|---|---|---|---|
| `latitude` | `Task`（D 创建任务时写入） | 用户选的绿地坐标 | 距离基准点 | 该任务不显示距离 |
| `longitude` | `Task` | 同上 | 同上 | 同上 |
| `latitude` | `Tool`（= 出借者的社区中心点） | 出借者邮编的中心点 | 距离终点 | 该工具不显示距离 |
| `longitude` | `Tool` | 同上 | 同上 | 同上 |
| `nearbyPostcodes` | 传给 D 的 ctx（不是存在对象上） | 你决定，见 §3 | 同邮编没有工具时放宽到附近 | 只按同邮编匹配 |

就这些。**其余 API（空气、电力、EPC）跟我的模块没有关系**，见我给你的那封说明 · §5。

## 2. 两个接口我已经实测过了

以下都是 2026-10-03 实际请求的真实返回，不是文档抄来的。

### 2.1 邮编 → 中心点：Postcodes.io

```bash
curl https://api.postcodes.io/postcodes/EH89YL
```

```json
{
  "status": 200,
  "result": {
    "postcode": "EH8 9YL",
    "latitude": 55.947687,
    "longitude": -3.187349,
    "outcode": "EH8",
    "country": "Scotland",
    "admin_district": "City of Edinburgh",
    "codes": { "admin_district": "S12000036" }
  }
}
```

- **不需要 key、不需要注册。** 这是我推荐的做法。
- `latitude` / `longitude` 直接照抄到 `tool` / `task` 上就行。
- 注意 `country` 是 `"Scotland"`：**默认演示邮编 EH8 9YL 在苏格兰**，所以英格兰威尔士口径的数据集（比如 EPC）在这里没有数据。

### 2.2 附近邮编：用 outcode，不要自己算

```bash
curl https://api.postcodes.io/outcodes/EH8/nearest
```

```json
{
  "status": 200,
  "result": [
    { "outcode": "EH8", "latitude": 55.94878, "longitude": -3.16441 },
    { "outcode": "EH7", "latitude": 55.96032, "longitude": -3.16520 }
  ]
}
```

返回按距离排序的邻近 outcode，自带各自的中心点。**把它里面除自己以外的 outcode 拼成数组传给我**：

```js
nearbyPostcodes: ["EH7", "EH9", "EH1"]   // 我接受 outcode，也接受完整邮编
```

> 我刚补了这个能力：`nearbyPostcodes` 以前只认完整邮编（`EH7 4AB`），现在也认 outcode（`EH7`）。因为 outcode 才是你手上天然有的东西 —— 见 `web/task-module.js` 的 `outwardCode()` 和单测 `nearbyPostcodes accepts an outcode as well as a full postcode`。

### 2.3 绿地：OSM Overpass

```bash
# Overpass 必须带 User-Agent，并且 POST 时要用 data= 前缀，否则会收到 406
curl -A "BorrowNextDoor/1.0 (AdaHack 2026)" \
     --data-urlencode "data@query.txt" \
     https://overpass-api.de/api/interpreter
```

`query.txt`：

```overpassql
[out:json][timeout:25];
(
  way["leisure"~"^(park|garden|common|recreation_ground)$"](around:800,55.947687,-3.187349);
  node["leisure"~"^(park|garden|common|recreation_ground)$"](around:800,55.947687,-3.187349);
);
out center tags 5;
```

真实返回（半径 800 m 内 5 个绿地）：

| 名称 | 类型 | center.lat, center.lon |
|---|---|---|
| George Square Gardens | garden | 55.9436411, -3.1888138 |
| East Princes Street Gardens | park | 55.9514082, -3.1936119 |
| Dunbar's Close Garden | garden | 55.9521546, -3.1789428 |
| Bauks View | park | 55.9460502, -3.1799761 |
| Hill Square | garden | 55.9465352, -3.1840511 |

要点：

- `out center;` 让面要素（way）返回 `center.lat` / `center.lon` —— 这就是我要写进 `task.latitude/longitude` 的值。node 类型的要素直接在 `lat` / `lon` 上。
- **一定要带 User-Agent**，否则 Overpass 返回 406（我第一次就被拒了）。
- `[timeout:25]` 是查询自己的超时上限，和 HTTP 超时是两件事，两个都要设。
- Overpass 是公益服务、会限流。**请服务端缓存**，不要每次页面刷新都打一次。

## 3. 加进 app.js 的两处接线（不是你的文件）

这两处是 `web/app.js` 里的，我可以帮你接，也可以你来。你需要知道的是「数据从哪进来」：

**① `taskContext()` 要透传 `nearbyPostcodes`**

```js
function taskContext(task){
  return { tools:state.tools, loans:state.loans, names, viewerId:user, task };
  //                                          ↑ 需要加 nearbyPostcodes: nearby
}
```

`nearbyPostcodes` 是 ctx 上的可选字段，不是存在对象上的。现在没传，所以匹配只在同邮编内进行。

**② 写入工具时要带上坐标**

```js
// 现在：只有 postcode
state.tools.unshift({ id, owner_id:user, name, description, category, status:'available', postcode });

// 需要：加上出借者邮编的中心点
state.tools.unshift({ …, postcode, latitude, longitude });
```

同一件事也适用于 `POST /api/tools` 之后由 B 写入的 tool 对象 —— 所以这条**也要告诉 B**，让他在建工具记录时把坐标一起存下来（否则每次读取都要重新查一次 Postcodes.io）。

`task.latitude` / `task.longitude` 已经在 `D.createTask()` 里支持了，只要在创建任务时把绿地坐标传进去：

```js
D.createTask({ creatorId, templateId, postcode, placeName, latitude, longitude })
```

## 4. 两条禁止

### 4.1 不要把直线距离说成步行距离

`matchTools()` 算的是**两点之间的大圆距离**。界面上我写的是：

```
about 1.1 km away, straight line
```

简报明确要求：「展示中心点直线距离时注明『约』和『直线距离』，不要称为步行路程」。所以：

- ❌ 不要显示「步行 15 分钟」、不要接 rounting API 假装是路程。
- ❌ 不要显示精确到米的数字 —— 邮编中心点本身就有几百米的误差。
- ✅ 如果要显示，一律「约 X km，直线距离」。这个文案我已经写在渲染层里了（`web/app.js` 的 `requirementRow()`），有单测守着。

### 4.2 OSM 只能说明「这里被标注为绿地」

Overpass 返回的是**已映射**的绿地，不能拿来推断：

- ❌ 「这里有垃圾」/「这里需要维护」/「这里缺人照顾」——OSM 的 `leisure=park` 只说明有人把它填成了公园。
- ❌ 「这个绿地属于某个邮编」——我是拿**半径**查的，不是行政边界。真要做归属，用 `addr:postcode` 标签或 Postcodes.io 的反查，并且注明是近似。

另一条同类的：OSM 返回**空**不代表没有绿地，可能只是没人画。空结果要显示「附近没有已映射的绿地」，不要显示「这里没有绿地」。

## 5. 空气 / 电力 / EPC 与我的模块无关

我的成果面板**不吃任何环境数据**，这是刻意的。简报要求不能把区域空气或电力变化当成本次行动的实测成果，所以：

| API | 归属 | 与 D 的关系 |
|---|---|---|
| Postcodes.io | C | ✅ 坐标，见 §2.1 / §2.2 |
| OSM Overpass | C | ✅ 绿地名称 + 坐标 → 任务地点 |
| Open-Meteo Air Quality | C | ❌ 只在社区首页当区域背景卡 |
| NESO Carbon Intensity（`api.carbonintensity.org.uk`，文档在 `carbon-intensity.github.io/api-definitions`） | C | ❌ 同上。注意那个 github.io 链接是**文档站**，不是 API |
| EPC（`get-energy-performance-data.communities.gov.uk`） | 新增 | ❌ 建议不做，见下 |

关于 EPC 的三个坑，供你判断：

1. **只覆盖英格兰和威尔士。默认演示邮编 EH8 9YL 是苏格兰**（Postcodes.io 的 `country` 字段就写着 `Scotland`），所以它对演示地点没有数据。
2. 批量 CSV 下载需要 **GOV.UK One Login 登录**；开发者在老站 `epc.opendatacommunities.org` 上也需要登录。而且 MHCLG 在 2026-07 又公告了新的 Open Data Communities 服务，**路径和鉴权方式是移动靶**。我核实了「需要登录」和「覆盖英格兰威尔士」，但 **API key 的具体形式和 rate limit 我没能确认** —— 别假设它像 Postcodes.io 一样开箱即用。
3. 它是**按房产的证书**数据（2008 年起约 3000 万份，可能已过期），不是邮编级聚合，要自己下载 CSV 再聚合；而且建筑能效是静态的，**不能归因于邻居借了一把耙子**。

结论：Fit to brief 那 10 分已经被「邮编 + 绿地 + 空气 + 电力」覆盖了。除非你还有余力**并且**把演示邮编换成英格兰的，否则不建议做。

## 6. 环境卡片的返回格式（A 的 `envCard` 需要）

空气、电力、绿地**各自独立加载、各自独立失败**，一个源挂了不能影响借还流程。`impactReport()` 不需要这些数据，但 A 的 `envCard` 需要你的返回里带来源标注：

```js
{
  status: "ok" | "unavailable" | "cached",
  value: 42,                        // 数值或对象
  unit: "μg/m³" | "gCO2/kWh",
  source: "Open-Meteo Air Quality",
  timestamp: "2026-10-03T09:00:00Z",
  scope: "regional prediction, ~11 km grid",
  cached: false
}
```

要点：**`scope` 不能省。** 空气是约 11 km 网格预测、电力是区域值，界面上必须显示成「区域信息」而不是「你家门口的实测值」。失败时给 `status: "unavailable"` 加最后成功时间，不要给 `null` 让 A 猜。

如果用了演示缓存，`status: "cached"` 并显示采集时间。用了示例绿地，界面上要明确标注是示例 —— 这跟演示数据的诚信要求有关。

## 7. 验收清单

- [ ] `POST /api/...` 之外，任何工具和任务对象上，坐标要么是数字要么是 `null`，**不要出现 `"55.947687"` 这种字符串**（我会当无效值丢掉）。
- [ ] 同一个邮编的两个工具，坐标一致（都来自邮编中心点）。**不要**给同一邮编的工具不同的坐标再期望我区分它们。
- [ ] 坐标缺失时页面不报错，「约 X km」那一行只是不出现。
- [ ] 距离文案里有「about」和「straight line」，没有任何地方出现「walk」「minute」。
- [ ] 无效邮编 / 空结果有明确提示，页面可以恢复操作。
- [ ] 把 Postcodes.io 断网（改 hosts 或断 wifi）后，任务清单、申请、借还流程**全部照常可用**。
- [ ] Overpass 请求带了 User-Agent，且结果有服务端缓存。
