# 《主产品接入说明》— DshCockpit 主仓如何接入 studio 的产出

> 面向：主仓（`/Users/xia/program/dsh/DshCockpit`）的维护者。
> 前提：**主仓本轮全程只读**，本说明只是"要接的时候怎么做"。所有路径以 s1（`DshCockpit-s1`）为准。
> 日期：2026-09-27。状态：P0–P4、P6 已落地并有证据；P5/P7 未做（见 §6）。

---

## 1. 一句话

studio 产出的东西分三类，**只有第三类需要主仓动手**：

| 类别 | 产物 | 主仓要不要改 |
|---|---|---|
| 内容 | `content/**`（动作文档 v2、场景/区域/布局、语料、护照与参数台账） | 不用改代码；按现有"发布"路径同步到 `resources/**` |
| 数据契约 | `.dshpack`（zip：manifest + 内容 + 哈希） | 不用改；如果要让产品直接认识它，见 §4 |
| **可复用代码** | `src/office/behavior-graph/**`（行为图 schema + 纯解释器 + 手感层 + 差异报告） | **建议复制这一份目录**（见 §3） |

---

## 2. 内容侧：已经能用的（不需要主仓改代码）

- 动作文档 schema v2（`tags` / `pingPong` / `events`）在**内容层**，发布时经 `compileDown()` **显式降级**为运行时 v1 条目
  （`{direction, frames[{file,durationMs}], loop}`），被舍弃的字段带原因上报（`runtime.dropped`）。
  主仓的包校验器（`ANIMATION_FIELDS` 严格白名单）因此**不会被 v2 字段污染**——s1 的真发布 + 严格校验已被测试锁定。
- 场景侧：`zones.json` 的障碍与布局**逐字节一致**（`studio/bin/scene.js sync-zones` 可试算/重建），
  冲突校验（工作位悬空/家具重叠/入口被堵/障碍漂移）在发布前拦下。
- 资产护照：`content/characters/<id>/provenance/**`（含 P0 补上的**生成参数台账** `generation/<actionId>.params.json`）。
  主仓若已有 `scripts/asset-provenance.js`，读同一批文件即可；状态词表一致
  （`traceable | traceable-in-history | lost | not-recorded`）。

## 3. 代码侧：建议接入的唯一一份（行为图解释器）

**位置**：s1 `src/office/behavior-graph/`（`schema.js` / `interpreter.js` / `feel.js` / `diff.js` / `index.js`，约 1,300 行，零依赖）。

**为什么值得接**：它是"工作台里调好的行为"与"程序里跑的行为"**同一份代码**的结构保证；产品侧的接入点是纯函数，不碰 DOM。

```js
const { validateGraph, createInterpreter, feel, diff } = require('./behavior-graph');

// 1) 落盘前必须校验（未校验的图不许存）
const check = validateGraph(graph);
if (!check.ok) throw new Error(JSON.stringify(check.violations));

// 2) 运行：时间与随机全部注入，因此可复现
const interpreter = createInterpreter({
  graph,
  seed: 'office-seed',                 // 与 behavior-scheduler 同一种子 ⇒ 随机流同源
  clock: () => adapter.nowMs(),        // 产品用自己的时钟
  employees: employeeIds,
  onEffect: (effect) => adapter.apply(effect),   // 效果是数据，由适配器施加
});
interpreter.start();                   // 激活入口触发器
interpreter.inject({ name: 'task/assigned', payload: { ... } });

// 3) 每帧推进（与现有 tick 同一节奏）
interpreter.tick(deltaMs);
```

**接入工作量与风险**（诚实评级）：

| 事项 | 量级 | 风险 |
|---|---|---|
| 复制 `src/office/behavior-graph/**` + 其测试 | S（1 小时） | 低：模块无依赖，测试纯 Node |
| 写运行时适配器（`effect` → 现有 `movement-controller` / `animation-controller` / 气泡） | M–L | **中高**：这是"引擎变更"，必须 RED 测试 + 复审（brief §2 红线） |
| 用图替换 `behavior-scheduler` 的局部行为 | L | 高：FIFO/预约/终局保留/身份绑定这些语义是十几轮修复换来的，**建议先并存、用差异报告比对，不要直接替换** |

**建议路径**：先接"图 → 效果 → 适配器"的只读通道（跑图但不驱动画面，用 `diff.diffStreams` 与现有调度器对照），
攒够"同一 seed 下差异可解释"的证据后，再挑一条低风险行为（例如休息区选择）真正切换。

## 4. 资产包 `.dshpack`（可选接入）

- 格式：zip（自研实现，`node:zlib`，无第三方依赖）+ `manifest.json`（每个文件 `bytes` + `sha256`，内容 digest）。
- 主仓若要让产品"直接读包"，需要的是：解包 → 按 `manifest.layout` 落地 → 交给现有 `asset-pack` 构建流程。
  **今天产品仍读 `resources/**`**（发布动作的同步目标），`.dshpack` 定位是"内容工程的搬运容器"，不是运行时格式。
- 包字节可复现：同内容 + 同 `createdAt` ⇒ 完全一致的 zip（时间戳固定 1980-01-01）；可用于缓存与复现校验。

## 5. 行为图文件 `.vgraph` 与现有代码的关系

- 图是**新东西**，与 `resources/office/fixtures/*.json`（布局+导航图）不冲突：布局图描述"哪里能走"，行为图描述"怎么动"。
- 图的 `action` 节点用的是闭集动作名（`walk.to` / `sit` / `animation.set` / `video.play` / `bubble.show` / `activity.set` …），
  与运行时能力一一对应；**没实现的动作不会被图凭空创造**。
- 差异报告（`diff.diffStreams`）就是给主仓用的：它把"图 vs 调度器"的活动流按**序列 / 直方图 / 节奏**三类差异报出来。

## 6. 当前**不要**指望的（诚实边界）

1. **VP9-alpha 视频轨**：本机 ffmpeg（Lavc61 / libvpx-vp9）写不出 alpha 平面（容器打 `alpha_mode=1` 但解码无透明像素），
   studio 已把"解码验证 alpha"做成门禁（`S7_ALPHA_PLANE_MISSING`）。产品侧接入视频轨前，**先确认编码环境能产出 alpha**（或用帧轨）。
2. **生成链没有真调用**：provider 门禁、请求计划（按秒节拍 + 护栏 + 负面清单）、参数台账、内容寻址缓存都已就位，
   但 S1/S2/S3 的 HTTP 调用**故意未实现**（缺 key 即拒、`allowNetwork` 显式开关）。要跑通"一图 → 整套"需要填 provider 配置。
3. **语料与预览诊断（P7）未做**：语料的运行时消费路径（`resources/dialogue/**`）已存在，studio 侧的语料编辑/一致性守卫/预览运行器未实现。
4. **图形编辑器（场景画布、行为图画布、时间轴回放）未做**：数据层与 CLI 齐备，UI 只到"校验/审片/护照/场景"四个面板。

## 7. 交接清单（要接的时候按这个顺序）

1. `git log` 看 s1 `feature/s1-office` 的 6 个 studio 提交（P0 fd850a9 … P6 eda653e），逐个看 commit message——每个都写了"改了什么/证据在哪"。
2. 复制 `src/office/behavior-graph/**` 与其测试（`test/office-behavior-graph.test.js`，测试自带台账条目）。
3. 跑 `npm test`（s1 为 1228/1228 + studio 套件 121/121）。
4. 接入时先只读：图跑起来 → `diff.diffStreams` 对照现有调度器 → 攒证据 → 再谈切换。
5. 任何"让图驱动真实画面"的改动都按引擎变更走：RED 测试 + 复审。
