# 虚拟办公室工作台 · 页面使用逻辑深度整改报告

> 交接对象：接手**页面使用逻辑重构**的 AI。
> 仓库：`/Users/xia/program/dsh/DshCockpit-s1`（分支 `feature/s1-office`），界面在 `src/workbench/`，工具内核在 `studio/`。
> 依据：情况说明 `evidence/studio-workbench-handover.md`（HEAD `8fb6e27`）+ 对 `src/workbench/**`、`studio/**`、`src/office/**` 的逐层代码勘察 + R1 证据截图逐张核对。
> **不要 push**（用户主代理负责推送）。**不要改 `src/office/**` 的语义**。一个阶段一个提交。

---

## 0. 一句话结论与目标形态

**现状的病根不是"功能不够"，而是"结构错了"**：十个工具被当成十个"属性面板"塞进右栏一条 440px 的窄列（`workbench.css:111`），而它们实际是**六种完全不同的制作任务**（摆场景 / 做动作 / 画行为 / 写文案 / 跑仿真 / 看报告）。任务不同，需要的空间形态就不同——表格要宽度、画布要面积、时间轴要横向、报告要全屏——窄列全部装不下，于是全部挤在一起。

**目标形态：IDE 式工作台**（对齐 Codex / Trae 的使用直觉）：

```
┌ 活动栏 │ 顶栏（项目名 · 保存状态 · ⌘K · 主题 · 语言）───────────────────────────┐
│  ▦ 场景 │                                                                    │
│  ▤ 动作 │         主工作区（按页面切换 = 制作任务切换）                        │
│  ⌥ 行为 │         页面 A：大画布 / 大时间轴 / 全宽表格 / 报告视图              │
│  ❝ 语料 │                                                                    │
│  ✓ 质检 │────────────────────────────────────────────────────────────────────│
│  ◉ 观测 │  可折叠底部面板：问题列表（校验结果）· 运行日志 · 批注               │
│         │────────────────────────────────────────────────────────────────────│
│  （左栏 │  运行坞（常驻）：实时仿真缩略视图 —— 切任何页面都不消失、不重载      │
│   可选）│                                                                    │
└─────────┴────────────────────────────────────────────────────────────────────┘
   右侧检查器随页面出现：只显示"当前选中对象"的属性（一次一个对象）
```

**"不丢运行时"是硬需求，本报告给出机制保证**（§2.3、T1/T2/T5）：运行时预览常驻运行坞；修掉今天真正丢运行时的两条路径（推送断链、iframe 重载）；页面切换**只改 CSS 布局区域，绝不摘除/重载 iframe**。

---

## 1. 现状诊断（问题 → 证据 → 定位）

### 1.1 视觉拥挤的直接证据

R1 证据截图（`evidence/studio-R1-stage/`）：

| 截图 | 看到的问题 |
|---|---|
| `studio-shell.png` | 行为图画布被压进 ~400px 窄列，节点文字不可读；标题「行为图（拖动只改画布位置…）」竖着折行；「重新载入」按钮被挤成竖排三字 |
| `studio-bench-panel.png` | 时间轴控制按钮「播放/下一帧/回到0」全部竖排折行；帧条缩略图横排被截断；下方批注表单被拦腰切断 |
| `studio-preview-runner.png` | 员工表 6 列被截断（位置列只显示一半）；脚本按钮 + 事件注入 + 员工表 + 遥测 + 诊断包 5 个区块串行堆叠，一屏看不完 |
| `studio-stage-run.png` | 右栏「场景检查」同屏刷出 12 条 `SCENE_FURNITURE_OVERLAP` 重复行，把有价值的摘要（工位 6 · 座位 6 · 障碍 32）顶出视野；左栏素材库+文件树上下对半挤，各自只剩约 3 行可见 |

根因代码定位：

1. **右栏宽 440px（可调上限 620px）**——`workbench.css:111` `--wb-right-w: 440px`；`workbench.js:97` `WIDTH_LIMITS = { left: [200, 460], right: [320, 620] }`。行为图画布本身是 `1280×720`（`workbench.html:417`），时间轴帧条、几何表 9 列、员工表 6 列都需要 ≥700px 才舒展。**结构性矛盾：面板需要的空间形态 ≠ 它被给予的空间形态。**
2. **十个工具 = 一个 `tabs` 表 + 十个 `<section>` 全在同一 `<aside id="wb-right">`**（`workbench.html:116-516`）。切换器（4 组 × 10 chip）本身占右栏顶部约 280px 垂直空间。
3. **每个面板内部是「表单堆叠」**：以 `panel-actions`（`workbench.html:161-212`）为例，一个面板里塞了：动作选择器 + 新建表单 + 播放工具条 + 时间轴 + 导入区 + 校验表 + 发布结果，共 7 个区块串行排列，全部同权重呈现，无主次、无折叠。

### 1.2 任务结构错位：十个工具其实是六类任务

| 制作任务 | 现在散落在 | 该任务真正需要的空间形态 |
|---|---|---|
| 摆场景 | tab-scene + 画布 + 左栏拖放 | 大画布 + 选中物件属性面板 + 问题列表 |
| 做动作（帧） | tab-actions **和** tab-bench（两个 tab 都在管帧！各有一条自己的时间轴） | 大时间轴 + 帧条 + 逐帧检查（视频剪辑器形态） |
| 画行为 | tab-graph（1280×720 画布被塞进窄列） | 全宽图编辑器 + 节点属性面板 |
| 写文案 | tab-dialogue（表格式数据被塞进窄列） | 全宽表格 + 条目编辑器 |
| 跑仿真 | tab-preview + 画布运行层 + 画布工具条（控制按钮分散两处） | 大画面 + 员工表 + 事件/脚本面板 |
| 看报告 | tab-assets / tab-geometry / tab-gallery / tab-passport（4 个只读报告） | 全宽报告页（表格/图集要宽度） |

**「动作」和「动作检查」是同一任务被拆成两个 tab**，各自维护一条时间轴（`#action-timeline` vs `#bench-timeline`）、一套播放控制（`btn-action-play/step/stop` vs `btn-timeline-play/step/reset`）——使用门槛高的典型：用户要先理解「我在哪一个动作界面」。

### 1.3 运行时被「丢掉」的真实原因（技术勘察结论，含一个断链 bug）

用户要求「切换页面不丢运行时」。勘察发现**今天运行时本来就在丢，而且丢得比页面切换更严重**：

1. **【断链】实时仿真从未推送到预览画面**。链路设计是产品侧的：`src/office/office.html:1873-1877` 启动时 `bridge.getState()` 拉一次，之后 `bridge.onState(...)` 等推送；产品主进程确实在推（`src/main.js:308-310` `officeModuleInstance.subscribe(... → broadcastToOfficeViews('office:state', snapshot))`）。**但 studio 主进程只注册了 `office:state` 的 pull handler（`studio/main.js:1151-1155`），从不 `webContents.send('office:state', ...)`；`runner.subscribe`（`studio/lib/preview/runner.js:210-213`）全仓 0 次调用**。结果：运行模式画面是**启动时的静止快照**——仿真其实在主进程里跑（面板 600ms 轮询的员工表在动，`workbench.js:3221-3234`），但**画面不动**。用户感觉「运行时不对/像丢了」，一半来自这里。
2. **【重载】动作编辑器会重载整个预览 iframe**。`reloadPreviewForDraft()`（`workbench.js:1192-1210`）直接 `win.location.reload()`；只要帧序/时长/循环任一变化，`ensureDraftPreview`（`workbench.js:1215-1230`）就触发重载——iframe 里的页面状态（选择、聚焦、Pixi 实体、布局草稿）全部销毁重建。动作预览（木偶 `pushPuppet`，`workbench.js:1161-1175`）和产品运行视图**共用同一个 `#preview-frame`**，互相抢占。
3. **【全局重载】shell 重载无任何持久化钩子**。全仓无 `beforeunload`/`pagehide` 处理：scene 的 `pending`（未保存摆放）、graph 的 `dirty`、dialogue 的 `dirty` 都是 `workbench.js` 单体 IIFE 里的闭包变量（`workbench.js:2038-2041, 2725-2727, 3007-3008`），shell 一刷新全丢。
4. **热重载会主动丢弃未保存改动**：`reloadContent` 的刷新器 `scene pending.clear()`（`workbench.js:2082`）、`loadGraph` 整体替换 `graphState`（`workbench.js:2840`）、`loadDialogue` 替换 `dialogueState`（`workbench.js:3091`）。
5. **切 tab 本身不丢状态**（好消息）：`activateTab`（`workbench.js:322-342`）只翻 `hidden` 属性，预览 iframe 挂在中间画布、与 tab 无关；主进程 runner 也随进程存活。**「切页面不丢运行时」的架构基础是有的**，缺的是推送接线、iframe 生命周期纪律和草稿持久化。

### 1.4 其它拉高使用门槛的细节（handover §6 已列，此处补定位与归属）

- **没有撤销/重做**（⌘Z 命中 0）——正常人类肌肉记忆第一条就落空；改错只能「重新载入」（丢掉全部待保存改动）。
- **选中物件只能 ±缩放/隐藏/删除**，改不了坐标、层级（深度带）、名字（`btn-canvas-*` 共 6 个按钮，`workbench.html:308-314`）。
- **提示文案过载**：左栏 2 条常驻 hint、画布状态行 3 条常驻文案、每个面板 1–2 段说明性 `<p class="wb-hint">`——教学文案常驻 UI，挤占制作空间，第二遍就没人看了。
- **障碍框默认实心粉块 33 个**（`studio-stage-edit.png` 满屏粉色半透明矩形），抢走对家具本身的注意力。
- **顶栏常驻长句**「内容写在 content/**，『发布』同步 resources/**（先备份 + 溯源）」（`workbench.html:14`）——这是给开发者的纪律说明，不是给制作人的界面文案。

### 1.5 代码结构根因

`workbench.js` 单文件 3339 行、单 IIFE：外壳 + 命令面板 + 树 + 画布 + 10 个面板的全部逻辑与状态混在一起。后果：任何页面级重构牵一发动全身；面板状态都是闭包变量（§1.3-3）无法被统一持久化/撤销管理。`panelRefresh` 注册只有 7 个面板（`workbench.js:894, 897, 2382, 2706, 2991, 3152, 3314`），动作面板连注册都没有（靠磁盘回读兜底）。

---

## 2. 目标形态设计（IDE 式）

### 2.1 布局骨架

```
┌活动栏┬──────────── 顶栏 ────────────────────────────────────────────────┐
│      │ 项目名 · 脏标记 · ⌘K 命令面板 · 主题 · 语言 · 面板开合            │
│ 场景 ├──────────────────────────────────────────────┬───────────────────┤
│ 动作 │  主工作区（页面 = 制作任务，一次一个）        │ 检查器（选中对象   │
│ 行为 │                                              │ 的属性，一次一个） │
│ 语料 │  每页自带：主画布/时间轴/表格/报告视图       │                   │
│ 质检 │  + 页面内工具条（只放该任务的操作）          │ 随页面隐藏/出现    │
│ 观测 │                                              │                   │
│      ├──────────────────────────────────────────────┴───────────────────┤
│ 设置 │  底部面板（可折叠，默认只留「问题」一栏）：问题列表 · 日志 · 批注   │
│      ├──────────────────────────────────────────────────────────────────┤
│      │  运行坞（常驻，默认约 180px 高，可放大/收起）：实时仿真小窗        │
└──────┴──────────────────────────────────────────────────────────────────┘
```

活动栏 6 个页面 = 六类制作任务：

| 页面 | 承载（现 tab 归并） | 主视图 | 检查器 |
|---|---|---|---|
| **场景** | tab-scene | 编辑层大画布（拖放摆放） | 选中物件属性（新增数值编辑，T6） |
| **动作** | tab-actions + tab-bench **合并** | 时间轴 + 帧条 + 逐帧预览 | 帧属性（时长/事件/批注） |
| **行为** | tab-graph | 全宽行为图画布 | 节点/边字段 |
| **语料** | tab-dialogue | 全宽条目表格 | 条目编辑（台词/权重/条件） |
| **质检** | tab-assets + tab-geometry + tab-gallery + tab-passport 归并为页内子视图（segmented） | 全宽报告/表格/金样图集 | — |
| **观测** | tab-preview | 运行坞放大视图 + 员工表 + 事件/脚本/遥测/诊断 | 员工详情 |

底部面板「问题」栏聚合所有校验结果（场景检查、发布校验、行为图检查、语料守卫、能力缺口）——**结果汇总在底部，不在右栏**（Problems 面板的位置，人眼习惯扫那里）。每条问题可点击跳转到对应页面与对象。

### 2.2 交互原则（降门槛）

1. **一屏一任务**：进入页面只看到该任务的主视图与主操作；次要操作（导入、CSV、迁移、往返校验）默认收进 `⋯` 菜单或折叠段。
2. **主操作在主视图旁**：保存/校验/播放永远在主画布或时间轴的工具条上，不进二级面板（R1 已对画布这么做，保持并推广）。
3. **教学文案出 UI**：常驻 hint 全部移除，换成（a）空态引导（只在空的时候出现），（b）控件 tooltip，（c）状态栏一句话。顶栏纪律说明移到「设置/关于」。
4. **问题可视化**：校验结果贴着对象显示（画布点选物件 → 检查器顶部显示它的违规），表格只是汇总。
5. **撤销覆盖一切编辑动作**（场景摆放/缩放/删除、行为图移动、语料增删、帧序调整）；⌘S 统一保存当前页。
6. **默认值取向新手**：障碍框默认只描边不填充（或默认关闭，工具条一键开）；运行坞默认收起为一条状态（「仿真运行中 · tick 1234」），点击展开。

### 2.3 运行坞与「不丢运行时」的机制保证（硬规则）

1. **`#preview-frame` 永远挂在 DOM 里**。页面切换只改变祖先容器的 grid 区域/`display`（`display:none` 不销毁 iframe browsing context；**摘除 DOM 或 `appendChild` 换父级会销毁重载**——Chromium 行为，禁止用 JS 搬运 iframe 节点）。需要「放大到观测页」时用 CSS 让运行坞覆盖主工作区（`position:fixed` + 尺寸过渡），**不移动节点**。
2. **推送接线修复**（T1）后，运行坞与放大视图是同一画面，天然一致。
3. **动作草稿预览与运行视图解耦**（T2）后，做动作不会再弄丢运行时。
4. **页面切换零 IPC、零重读**：页面切换等价物只翻 class；面板数据只在（a）进入页面时若脏则跳过刷新、（b）内容热重载事件、（c）用户手动刷新 三种时机更新。

---

## 3. 整改清单（按优先级；每条：现状 → 改法 → 验收）

### P0（不修这些，页面重构只是换了个好看的壳）

**T1. 接通实时仿真推送（修断链）。**
现状：`runner.subscribe` 0 次调用；`office:state` 只有 pull；画面静止（§1.3-1）。
改法：`studio-services` 暴露 `previewSubscribe(fn)`（转发 `previewRunner.subscribe`）；`studio/main.js` 的 extend 里订阅并 `officeFrame().webContents.send('office:state', payload)`（runner 已内置 `SNAPSHOT_PUSH_MS` 节流，`studio/lib/preview/runner.js:108-114`，直接复用）；iframe 侧零改动（`office-preload.js:61, 80` 的 `onState` 已就绪）。
验收：真壳探针新增断言——`previewPlay` 后连续两次（间隔 > 节流窗口）读 `window.__office.api.snapshot().simulatedAtMs` / `ticks` **必须增长**。

**T2. 动作草稿预览与运行视图解耦。**
现状：`reloadPreviewForDraft` 重载共用 iframe（§1.3-2）。
改法：新增独立 `#bench-frame`（同源加载 `preview/office.html?pack=…&bench=1`，挂 `#bench-slot`，只给动作页用，允许随时重载/重建）；`#preview-frame` 专供运行坞/观测页，**任何代码路径禁止对其 `location.reload()`**（加注释 + 探针断言其 `contentWindow` 对象身份跨页面切换不变）。`pushPuppet`/`pushEmptyScene` 改打到 bench-frame。
注意：id 契约里 `preview-slot`/`preview-frame` 的邻接断言（`boundary.test.js` 1200 字符内）**保留不动**——`preview-frame` 还是原来那个，只是不再被动作编辑器借用。
验收：探针——起仿真 → 切到动作页播放草稿 → 切回观测页，断言仿真 `ticks` 全程单调递增（期间未重开）。

**T3. 撤销/重做（⌘Z / ⇧⌘Z）。**
改法：布局编辑走「整稿快照」撤销栈（layout.json 草稿很小，快照 ≤50 份无压力）：每次 `sceneEdit(save:true)` 前压栈；行为图/语料/帧序同样在各自编辑入口压栈。撤销 = 用上一份快照走既有事务重放（**仍必须过校验事务，不许绕过**）。栈放新模块 `src/workbench/app/history.js`。
验收：探针——拖入家具 → ⌘Z → 画布 `canvas-status` 回到改动前、布局字节与备份一致；重做恢复。

**T4. 页面骨架（活动栏 + 6 页面 + 底部面板 + 运行坞）。**
现状：三栏 + 右栏 10 面板（§1.1）。
改法：按 §2.1 重组 DOM。**id 契约迁移策略见 §4.3**——所有既有 id 保留（新容器包旧节点），`tabs` 表改为「页面表」但 `tab-*`/`panel-*` id 与 `class="wb-tab"` 原样保留（chip 可移进页面内工具条作为「子视图切换」）；四处同源（切换器/rail/快捷键/命令面板）机制保留。
验收：全套 182 + 1244 测试绿；探针复跑全字段通过（允许字段值变，字段集合不减）。

**T5. 未保存草稿持久化。**
现状：闭包变量 + 无 beforeunload + 热重载主动丢（§1.3-3/4）。
改法：`src/workbench/app/store.js` 统一持有 scene/graph/dialogue/action 的会话状态；变更（防抖 500ms）写 `sessionStorage`（或 `.studio-data/` 走 IPC，同 `shellState` 先例 `workbench.js:39-53`）；shell 启动时恢复并显示「已恢复未保存改动」；热重载刷新前先比对脏标记，**脏则跳过刷新并提示**（改掉 `pending.clear()`/整体替换的三处行为）。
验收：探针——拖动未保存 → 模拟重载 shell → 断言改动仍在 + 状态行有恢复提示。

### P1（页面重构的主体价值）

**T6. 场景页：选中物件数值属性。** 检查器显示 x/y/缩放/层级（深度带）/名字/隐藏，可直接键入；改数值走 `sceneEdit` 事务（试算→校验→备份→写）。多选/复制/对齐辅助线可延后，但**属性面板本阶段必做**（没有它，「精准摆放」永远靠手感拖）。

**T7. 动作页：合并动作编辑器与动作检查，统一时间轴。** 一条时间轴组件（保留 `#bench-timeline`/`#timeline-*` id 为实现载体），帧条、逐帧残影/脚线/质心、批注、导入、发布校验成为动作页内的折叠段/底部面板；删除 `#action-timeline` 的重复时间轴（同步改 `scripts/office-workbench.js` 探针引用，见 §4.3）。发布/迁移等「写生产」操作放页内危险操作区（红色按钮 + 确认）。

**T8. 行为页：全宽图编辑器。** `graph-canvas` 出窄列进主工作区（放大 `graph-canvas-wrap` 画布，缩放/平移沿用 stage 交互）；节点字段进检查器；检查/运行/差异结果进底部面板；「自动排版」留工具条。补**节点创建/连线**最小实现（现在只能拖动已有节点——`graphMoveNode` 有、创建/删边无，属于该页可用性缺口；至少给「命令面板加节点」入口）。

**T9. 语料页：全宽表格。** 话题列表左侧窄栏、条目表主区、条目编辑进检查器；CSV 导入收进 `⋯`；「试说一句」的气泡直接叠加在运行坞小窗上（说到谁脸上就看见谁）。

**T10. 质检页：四报告归并。** 素材校验/几何报表/视觉基线/素材溯源成为页内 segmented 子视图（全宽表格/图集）；「运行发布校验」一键跑全部并把结果汇入底部问题栏；溯源的 `.dshpack` 往返/导入导出收进 `⋯`。**保留 `geometry-table`/`asset-table` 等 id 原名**。

**T11. 观测页：仿真观测。** 运行坞放大 + 员工表（全宽）+ 一键脚本/手动事件/遥测/诊断包分段；播放/单步/重开/倍速**只留一处**（运行坞工具条），画布工具条的 `btn-preview-play/step/restart`/`preview-speed` 迁移为同一组控件的宿主（id 保留，位置挪进运行坞——探针按 id 找，不断言位置）。可选：员工表行点「跟随」（handover §6-5，可放 P2）。

**T12. 降噪。** 移除常驻 hint（左栏 2 条、状态行 3 条、面板说明段）→ tooltip/空态；顶栏长句移入设置；障碍框改默认描边（CSS 一处）+ 显示开关挪到场景页工具条；场景检查 12 条重复 `SCENE_FURNITURE_OVERLAP` 改为「按代码聚合 + 展开看明细」。

**T13. 左栏改为上下文资源栏。** 场景页显示素材库（拖放）+ 内容树；其它页面只显示内容树（或整栏收起）；素材库/内容树用小切换而不是上下对半挤。**保留 `library-root`/`tree-root` 全套 id 与类名**。

### P2（后续阶段，按 handover §6 顺延）

- T14 面板内文案 i18n 补全（已知欠账，机械活；新页面文案一律进 `i18n.js` 字典）。
- T15 拖拽落点预览（半透明幽灵 + 违规预示色）。
- T16 多选/复制/对齐辅助线/吸附开关。
- T17 运行层对照视图（编辑层叠加派生导航图/工位）、跟随员工。
- T18 流水线 S0–S8 面板（为质检页预留「流水线」子视图位）；新建角色工程向导（预留「项目/设置」页入口）。
- T19 角色动画缺口（转向/口型）与真实生成（key 门控）——不属于页面重构。

---

## 4. 代码层重构方案

### 4.1 模块拆分（`workbench.js` 3339 行 → 页面模块）

```
src/workbench/
  workbench.js            薄壳：引导 + 页面注册表 + 全局快捷键（保留文件名，见 §4.3）
  app/
    store.js              会话状态（选中/脏标记/草稿）+ sessionStorage 持久化
    history.js            撤销/重做栈（快照式）
    runtime-dock.js       运行坞：iframe 生命周期纪律（唯一允许触碰 preview-frame 的模块）
    pages/
      scene.js  animation.js  behaviour.js  dialogue.js  qa.js  observe.js
    …（boot.js / services.js / ipc.js / gallery.js 原样保留）
```

拆分纪律：**每个页面模块只拿自己的 DOM 子树与状态**；跨页共享的只有 store、history、runtime-dock、i18n、命令表。执行分两步：第一步「平移不改行为」（把 10 个面板代码搬到 pages/，行为零变化、测试全绿），第二步再做 §2 的界面重组——**平移与重组分两个提交**，出问题好定位。

### 4.2 状态模型

- `store.state = { selection: {…}, drafts: { scene, graph, dialogue, action }, dirty: {…} }`——单一出口，页面订阅。
- 撤销条目：`{ page, before, after, label }`（label 用于撤销菜单显示「撤销：拖入电饭煲」）。
- 帧播放时钟（`playback`/`playheadMs`）**不进撤销、不持久化**，但跨页面切换要存活（跟随 runtime-dock 生命周期，不随页面模块卸载）。

### 4.3 id 契约与测试迁移策略（不破 handover §4 硬约束）

界面由真壳探针（`studio/main.js`）驱动验收，契约密度很高。规则：

1. **id 不删、不改名**（handover §4-2 全表 + `boundary.test.js`/`i18n.test.js`/`office-ui.test.js` 断言清单）：重组 DOM 时把旧 id 节点**搬进新容器**，不重命名。`class="wb-tab"`、`role="separator"`、`role="slider"`、`tabindex` 等属性原样保留。
2. **允许同提交改测试**的情况只有两种：(a) 断言的「形状」随布局变了但意义不变（如 tab chip 从右栏顶部搬到页面工具条——需同步改探针里「点 chip」的路径）；(b) 删除了重复实现（如 `#action-timeline` 并入 `#bench-timeline`——需同步改 `scripts/office-workbench.js` 与 `studio/main.js` 里对旧 id 的引用）。**同提交内测试与探针必须跟着改且断言仍有意义**，绝不许「注释掉断言」。
3. **两个「字面量陷阱」提前知悉**：`boundary.test.js` 钉死了 CSS 的精确行文本（`#stage[data-mode="edit"] #preview-slot { display: none; }` 等）与 JS 的模板字符串（`paddingLeft = \`${2 + depth * 12}px\`` 等）——重组样式时保持这些规则行原样，或同提交更新为等价断言；`i18n.test.js:52-53` 要求**恰好十个** `id="tab-*" class="wb-tab"` 且同标签带 `data-i18n`——页面化后若 chip 数量变化，同提交改该断言。
4. **探针扩展**：本次新增行为都要进探针（T1 的 ticks 增长、T2 的 iframe 身份不变、T3 的撤销、T5 的草稿恢复），放进同一个 `runStudioEvidence`，字段名追加不改旧字段。
5. **红线不动**：工具/产品边界（M0 boundary 双测试）、内容写入只走事务（试算→校验→备份→写）、`stageFit()` 与模式耦合、`#stage[data-mode]` 单一可见性来源、密钥扫描、双语键集等价、对比度 token、不新增 npm 依赖。

### 4.4 每阶段验证命令（照 handover §7）

```bash
cd studio && npm test                  # 182 起，只增不减
cd .. && npm test                      # 1244 起（含 M0 边界）
cd studio
STUDIO_EVIDENCE_DIR=../evidence/studio-<阶段名> npm run studio
# 成功＝STUDIO_EVIDENCE_OK；证据含截图 + results.json
```

---

## 5. 分阶段实施（一个阶段一个提交，各阶段独立可验收）

> **执行进度（2026-09-29，实施者记录）**
> - ✅ **R2-A**（T1+T2）· 提交 `01765ff` · 证据 `evidence/studio-R2-A/`
> - ✅ **R2-B1**（模块拆分 + 探针失败路径修复）· `01a2cbb`；**R2-B2**（T4+T12+T13 页面骨架）· `bd1c791` · 证据 `evidence/studio-R2-B2/`
> - ✅ **R2-C**（T3+T5）· `3aef345` · 证据 `evidence/studio-R2-C/`
> - ✅ **R2-D1**（T6 选中物件属性面板）· 证据 `evidence/studio-R2-D1-item-props/`
> - ✅ **R2-D2**（T12 收尾：底部问题栏，按代码聚合 + 点击跳转）· 证据 `evidence/studio-R2-D2-problems/`
> - ✅ **R2-D3**（T7 动作页合并为一条时间轴 + 危险操作区）· 证据 `evidence/studio-R2-D3-one-timeline/`
> - ✅ **R2-D4**（T8 行为页全宽图编辑器 + 建节点/连线 + 字段进检查器）· 证据 `evidence/studio-R2-D4-behaviour/`
> - ✅ **R2-D5**（T10 质检页归并四报告 + 一键跑全部 + `.dshpack` 收进 ⋯）· 证据 `evidence/studio-R2-D5-quality/`
> - ✅ **R2-D6**（T9 语料页：话题左栏 + 检查器条目编辑 + CSV 收进 ⋯ + 气泡叠运行坞）· 证据 `evidence/studio-R2-D6-dialogue/`
> - ✅ **R2-D7**（T11 观测页：全宽员工表 + 跟随员工 + 播放控件只留一处）· 证据 `evidence/studio-R2-D7-observe/`
> - **R2 整改到此全部完成**（R2-A → R2-E，14 个提交）。报告 §6 的红线逐条遵守；
>   下面明确记为可选/延后的条目（多选复制、对齐辅助线、员工详情检查器、图节点重命名/复制、图编辑撤销、缩略图）保持未做。
>   与 R2-E（T14 i18n 补全 + 提示体系 + 探针补断言）。报告的结构前提（页面骨架、画布码头、检查器）
>   已经落地，剩下的每页深化可以按页推进、互不阻塞。
> - 证据根已按用户要求从桌面移入仓库：`evidence/<阶段>/`（`.gitignore` 里，不占仓库体积）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **R2-A 断链与生命周期** | T1 + T2 + 探针新断言 | 运行画面实时动；做动作不丢仿真；全套测试绿 |
| **R2-B 页面骨架** | T4（含 §4.1 第一步平移）+ T12 降噪 + T13 左栏 | 六页面可用、id 契约全数通过、探针全字段 |
| **R2-C 状态与撤销** | T3 + T5 | ⌘Z 可用；未保存草稿跨刷新存活 |
| **R2-D 页面深化** | T6 + T7 + T8 + T9 + T10 + T11 | 每页主视图到位（时间轴合一、全宽画布/表格、报告归并） |
| **R2-E 收尾** | T14 i18n 补全 + 提示体系（空态/tooltip）+ 探针补断言 | 双语键集等价；新老证据对照归档 |

每阶段结束跑 §4.4 全套；证据目录 `studio-R2-A` … `studio-R2-E`。阶段内如需中间截图，放同目录但以最终证据为准。

---

## 6. 红线（重构期间禁止）

1. 不改 `src/office/**` 语义（产品运行时是只读依赖；需要产品侧配合的改动走 RED 测试 + 复审，不属本次范围）。
2. 不直接写 `content/**`；一切写入走既有事务（试算 `save:false` → 写 `save:true`）。
3. 不 push、不合并、不删 `artifacts/**` 门禁台账、不动 `docs/specs|research|superpowers|compat|legacy`（被测试读取）。
4. 不新增 npm 依赖；`studio/package.json` dependencies 保持为空。
5. 不在探针/日志/导出物里出现密钥（`sk-`/`Bearer`/`token=`/cookie 扫描是红线）；探针改动内容后必须从自产备份还原并断言字节一致。
6. 不用「注释掉测试/断言」的方式让套件变绿。
7. 顺手发现的产品侧问题**只记录进报告/提交信息**，不动手。

---

## 7. 附录：关键定位索引

| 事实 | 定位 |
|---|---|
| 右栏 440px / 上限 620px | `workbench.css:111`；`workbench.js:97` |
| 10 面板同 aside | `workbench.html:116-516` |
| tabs 表（四处同源） | `workbench.js:310-321` |
| activateTab（只翻 hidden） | `workbench.js:322-342` |
| iframe 重载销毁页状态 | `workbench.js:1192-1210`（`win.location.reload()` 在 1198） |
| 草稿暂存触发重载 | `workbench.js:1215-1230` |
| 木偶快照直推画面 | `workbench.js:1161-1175`（`applySnapshotManually`） |
| 产品侧推送先例 | `src/main.js:308-310` |
| studio 只 pull 未 push | `studio/main.js:1151-1155`；`runner.subscribe` `studio/lib/preview/runner.js:210-213`（0 调用） |
| 页启动拉一次 + 等推送 | `src/office/office.html:1873-1877` |
| 600ms 面板轮询（只刷表） | `workbench.js:3221-3234` |
| 热重载丢弃未保存改动 | `workbench.js:2082, 2840, 3091` |
| 面板状态闭包变量 | `workbench.js:2038-2041`（scene）, `2725-2727`（graph）, `3007-3008`（dialogue）, `1106-1113`（action） |
| 双时间轴重复实现 | `#action-timeline` `workbench.html:188` vs `#bench-timeline` `workbench.html:377` |
| i18n 恰好十 tab 断言 | `studio/test/i18n.test.js:52-53` |
| CSS/JS 字面量断言 | `studio/test/boundary.test.js:145-397` |
| M0 边界与外壳断言 | `test/office-ui.test.js:2936-3009` |
| iframe 搬运会重载（技术约束） | Chromium：iframe 从 DOM 摘除即销毁 browsing context；保持存活只能用 CSS 显隐/定位 |
| 空快照 schema | `src/workbench/app/boot.js:31-42`（`createEmptyOfficeSnapshot`） |
| runner 节流推送 | `studio/lib/preview/runner.js:108-114`（`SNAPSHOT_PUSH_MS`） |

—— 报告完。执行顺序建议：先读 handover §2 目录地图与 §4 硬约束，再按 §5 阶段推进；每阶段提交信息里注明「改了哪些 id/测试、为什么仍有意义」。
