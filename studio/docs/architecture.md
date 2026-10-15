# Studio 架构（P0）

> 状态：**活跃**。P0 已落地；P1–P8 的落点写在每节的"阶段"标注里。
> 边界铁律：**工具不进发行版**；**产品只被只读引用**；**运行时语义冻结**。

## 1. 两个入口，一套实现

| 入口 | 命令 | userData | stdout 契约 | 附加能力 |
|---|---|---|---|---|
| 旧工作台 | `npm run office:workbench`（仓库根） | `.workbench-data/` | `OFFICE_WORKBENCH_READY` | 无（M0/M1 原样） |
| Studio | `npm run studio`（`studio/` 内） | `.studio-data/` | `STUDIO_READY` | `studio:*` IPC（P0：素材护照 + 参数台账） |

两条入口共用 `src/workbench/app/**`（详见 §3），差异只在四件事：userData 目录、窗口标题、stdout 契约、附加 IPC。新增面板/服务默认只写一份，两个入口同时获得。

窗口标题词表保持三档可分：产品 `Agent Office`、探针 `PROBE 临时数据（可关闭）`、工具 `Office Workbench` / `Office Studio`。`STUDIO_EVIDENCE_DIR` 存在时 studio 用探针标题并自动退出（证据纪律）。

## 2. 分层

```
studio/                        工作台应用（工具；可提交）
  package.json                 npm run studio / npm test / npm run provenance
  main.js                      应用入口：boot + studio:* IPC（唯一）
  lib/
    studio-services.js         能力域服务（P0：info + 护照 + 参数台账）
    provenance.js              五段式素材护照引擎（从主仓 scripts/asset-provenance.js 移植）
    scan.js                    导出边界密钥形状扫描（fail-closed）
  bin/provenance.js            护照 CLI：report / verify / index / lost / record
  test/*.test.js               独立测试套件（不进仓库根 npm test 的 glob）
  docs/                        本目录（架构 / 契约 / provider / 护照）
  build/                       可再生产物（gitignored）

src/workbench/**               工作台内核（工具；被两个入口共用）
  app/services.js              纯 Node 服务层：content 树、几何报表、目录校验、动作时间轴、发布内核
  app/ipc.js                   workbench:* 通道注册（唯一）
  app/gallery.js               金样图库（唯一的 Electron 依赖：离屏 BrowserWindow）
  app/boot.js                  应用引导：scheme、协议、IPC、窗口、ready 握手
  lib/*.js                     纯算法内核（几何/归一化/校验/发布/PNG/动作模型）
  workbench.html|css|js        三栏外壳（左=内容树，中=预览，右=校验面板）
  workbench-preload.js         外壳桥（同时是产品 office-preload 的 verbatim 载体）

content/**                     内容工程（角色工程 / 场景 / 区域 / 语料）——工具写入，运行时只读编译产物
resources/**                  生产包与家具素材——发布动作的同步目标
photo/**                      本机开发私有素材树（gitignored，只读引用）
src/office/**                  产品运行时——工具只读 import，绝不修改
```

## 3. 为什么把服务层抽出来（P0 的核心改动）

抽层前：`scripts/office-workbench.js`（1415 行）同时是入口、协议处理器、服务层、金样图库与两套证据模式；studio 若要用同一套能力只能复制一遍。

抽层后：

- `app/services.js` — 每个面板操作、报表、发布调用**只有一份实现**（纯 Node，可单测）；
- `app/ipc.js` — `workbench:*` 通道名的唯一声明处（`CHANNELS` 常量 + 注册函数），渲染端桥必须与它完全一致（边界测试断言双向相等）；
- `app/boot.js` — 引导只认四个参数（userData / 标题 / ready token / 附加 IPC），因此两个入口的行为不可能悄悄漂移；
- `scripts/office-workbench.js` — 596 行，只剩旧入口的词表常量 + 两套证据模式（逐字节保留）。

**回归防线**：旧的 `test/office-ui.test.js` 会 grep 启动器的 `OFFICE_WORKBENCH_READY` / `'Office Workbench'` / `.workbench-data` / `OFFICE_WORKBENCH_LAYOUT_READONLY` 与 `node --check`，这些字面量仍在启动器内；`studio/test/boundary.test.js` 追加断言"入口不得自行 `protocol.handle` / `ipcMain.handle('workbench:`"。

## 4. 边界（谁可以 import 谁）

| 方向 | 允许？ | 由什么强制 |
|---|---|---|
| 工具 → 运行时（`src/office/**`） | ✅ 只读 | 协议处理器只读挂载 |
| 运行时 → 工具（`src/workbench/**`、`content/**`、`studio/**`） | ❌ | `src/main.js` 依赖图遍历（studio 版边界测试） |
| 工具测试 → 工具内核 | ✅ | `test/office-asset-runtime.test.js` 明确允许 |
| 工具 → 产品预加载（`office-preload.js`） | ✅ verbatim | `workbench-preload.js` require 同一文件 |
| 工具 → 网络 | ❌ P0–P3 | 生成链在 P4 才引入 provider（见 `providers.md`） |

## 5. 内容交付单元（CDU）

一次内容变更 = `content/**` 的 diff + 编译产物。工具侧的写路径只有三条：
1. 动作文档（`content/characters/<id>/actions/*.json`）——经纯动作模型写入，无变更不落盘；
2. 发布内核（`src/workbench/lib/action-publisher.js`）——校验不过 fail-closed、写前备份到 `content/build/backups/<ts>/`、只改目标条目、追加护照记录；
3. 可再生产物（`content/build/**`、`studio/build/**`）——随时可删。

## 6. 阶段落点（P1–P8 往哪里长）

| 阶段 | 落在哪 | 状态 |
|---|---|---|
| P0 骨架与移植 | `studio/{main.js,lib,bin,docs,test}` + `src/workbench/app/**`（共享应用层）+ `content/project.json` | **完成** |
| P1 项目与资产 | `studio/lib/{project.js,dshpack.js,zip.js}`（项目=文件夹 + `.dshpack` 往返 + 密钥出口扫描）+ 右栏「护照」面板 | **完成** |
| P2 场景校验与航点图 | `studio/lib/layout-schema.js`（主仓副本）+ `studio/lib/scene/{geometry,zones,waypoints,conflicts,zone-sync,index}.js` + 外壳「场景」面板 + `bin/scene.js` | **完成** |
| UI #1 场景画布（2026-09-28） | `studio/lib/scene/edit.js`（编辑事务：改布局 → 重建 zones → 校验 → 备份写盘）+ 画布面板 | **完成** |
| P3 角色与动作 | `studio/lib/actions/{schema,notes,gaps,service}.js` + 外壳「审片台」面板 + `bin/actions.js`（v2 创作、编译降级、帧号批注、能力缺口）；**跟进（2026-09-28）**：v2 元数据随包发布（校验器 + 发布内核放宽，真资产已迁移并发布） | **完成** |
| P4 生成流水线 | `studio/lib/pipeline/**`（S0–S8 + 内容寻址缓存 + QC 电池 + 编排/分诊）+ `studio/lib/providers.js` + `bin/pipeline.js` | **完成**（面板留到 P5 与视频通道一起做） |
| P5 视频直用 | `studio/lib/video/{action-video,ab-probe}.js` + `studio/lib/pipeline/alpha-probe.js` + `bin/video.js` | **完成**（A/B 数据：视频轨 11.5× 更小、alpha 双路一致、节奏同 60fps；帧轨仍为默认主轨） |
| P6 行为图 | 解释器在 `src/office/behavior-graph/**`（**产品可复用同一份**）：schema/纯净解释器/手感层/差异报告 + `bin/graph.js` + 示例图 `content/graphs/local-behaviour.vgraph.json` | **完成**（图形编辑器面板未做，见下） |
| P7 语料与预览 | `studio/lib/dialogue/corpus.js`（两层 + 守卫 + CSV + "说一遍"）、`studio/lib/preview/runner.js`（真 office 模块 + 事件注入 + 诊断包）、「语料」「预览」两个面板 | **完成**（热重载与页面侧遥测留待下一步） |
| P8 图集与打磨 | 图集打包 + 双语 + 对比度 + 空态 + 主产品接入说明 | 待做 |

### P1 的接口事实（写代码前先读这一段）

- 项目根默认 = `content/`（`content/project.json` 声明各域位置）；`studioServices.projectInfo()` 返回
  `{id,label,layout,missing,digest,totalBytes,counts,fileCount}`，`missing` 永远如实列出声明了但盘上没有的路径。
- 包 = zip + `manifest.json`；**出口密钥扫描在写盘之前**，命中即整包拒绝；导入前先 `inspectPack`（哈希/缺件/多件），
  任何问题 = 一个字节都不写；版本不匹配先报 `PACK_SCHEMA_UNSUPPORTED`。
- zip 自研（`studio/lib/zip.js`）：无第三方依赖、无 zip64、写 65535 条上限、固定时间戳 → 同内容同 `createdAt`
  的包字节完全一致（P4 的缓存/复现要靠这条）。
- 面板与 CLI 走**同一批服务**（`studio/lib/studio-services.js`）：点按钮和跑命令行不会给出不同答案。

### P2 的接口事实

- **摆放仍用产品编辑器**（中间预览场里的那个：拖拽/吸附/层级/多选都是它的既有能力）；studio 拥有的是
  **校验 + 航点图 + 障碍重建**——一份编辑器，不造第二份（§2 的"不要重造"）。
- 冲突校验的判定空间：座位用**脚点**（不是物品中心），占用用**实际艺术框**（不是声明障碍），
  站号用**行优先**，边采样用**运行时的函数**。四个"用运行时同一套规则"的决定都在测试里锁着。
- `sceneSyncZones({write:false})` 是试算（返回 changes），`{write:true}` 才写盘且先备份到
  `content/build/backups/zones/`；无变更不落盘。`bin/scene.js report` 有阻断项时 **exit 1**（可做前置门禁）。

### P3 的接口事实

- **两个 schema 各司其职**：内容 = v2（标签/ping-pong/事件帧/批注），包 = 运行时 v1。发布路径 = `compileDown()`
  显式降级，`runtime.dropped` 带原因上抛；`src/workbench/lib/action-model.js` 的解析器接受 v1|v2（publish 内核只有一份）。
- **工具依赖 vs 项目数据**：`character-geometry` / `png-geometry` / `action-publisher` / 家具 catalog 从
  **studio 所在仓库**（`TOOL_ROOT`）解析；`content/**`、`scenes/**`、动作文档从项目根解析。指向一个导出项目时，
  工具仍用自己安装的那一份（沙盒测试锁定：沙盒项目不因缺产品树而崩）。
- **批注与文档分离**：批注进 sidecar，动作文档保持可发布契约；帧序变化把旧批注标 `stale` 而不是重指。
- 审片台只读 + 有限写：切动作/看帧/洋葱皮/叠加线是只读；写只发生在「批注/标签/事件/ping-pong/迁移/发布」六个明确动作上。

### P4 的接口事实

- **缓存键必须是内容寻址**，数组输入逐元素哈希：只写路径会让"改了一帧却不重跑"（P4 验收测试一开始就抓到这个 bug）。
- **段的输入来自上一段的产物**（S4→S5→S6 串起来），所以改一帧只重跑受影响的那一段，改参考图只重跑参考段。
- **门禁即数据**：QC 报告落 `content/build/qc/<action>.qc.json`，S8 读盘上报告，红灯即拒（跨进程也成立）。
- **provider 缺配置 = 拒绝，不是跳过**：S1/S2/S3 无 key 时返回 `PROVIDER_KEY_MISSING` 并把**请求计划**（按秒节拍 + 护栏 + 负面清单）缓存下来，界面/CLI 可离线评审提示词。
- **alpha 只能靠解码验证**：容器标签会说谎（本机 ffmpeg 即为反例），S7 解码一帧数透明像素才算过。

### UI #1 的接口事实（场景画布）

- 编辑是**事务**：`applyEdits`（副本）→ `zoneSync.syncZones`（派生的障碍重建）→ 同一套冲突校验 → 通过才写；
  保存时**两个文件一起写、一起备份**（`content/build/backups/layout/<stamp>-<scene>-{layout,zones}.json`）。
- 面板与 CLI 同源：`sceneEdit`（`save:false` 试算 / `save:true` 落盘）；试算的结果**就是**保存时会被判定的结果。
- 两条"必须做对"的细节（都由真壳或测试抓出来）：报告形状要和渲染器一致（缺 `sceneId/scene` 会让表格清空）；
  备份必须是**字节拷贝**、写回**沿用原缩进**（否则一次移动就是 ~900 行 diff）。
- 画布只做等比缩放（烘焙美术不得旋转），删除/新增与参考线留给后续轮次。

### 编辑安全网的接口事实（R2-C，2026-09-29）

- **撤销是"整稿快照 + 事务重放"**：快照（38 件的小草稿）→ 差集 → `sceneEdit` 试算/校验/写。
  撤销因此**不可能**写出校验器不接受的状态，这条比"字节一致"更重要。
- **写盘 ≠ 字节拷贝**：事务写文件一定重新序列化；字节拷贝是**备份**的保证。断言"撤销后逐字节相同"是错的，
  契约是"解析后逐条相同"（本轮探针先按字节断言，被这条事实纠正，工程上留下记录）。
- **会话草稿必须在启动时 `restore()`**：store 的内存是空的，不 restore 就等于没有持久化——
  这个静默失败正是探针逼出来的（`pendingRestored` 先是 false）。
- **热重载让位给未保存改动**：`panelRefresh('tab-scene')` 在 `pending.size > 0` 时跳过刷新并提示，
  不再静默清空。这是 T5 与热重载的接口约定。

### 页面骨架的接口事实（R2-B2，2026-09-29）

- **六个页面 = 六类制作任务**，活动栏在左边缘；页面决定**工作区是什么**：画布页面（场景/观测）把工作区给
  `#stage`，其它页面显示自己的面板、把 `#stage` 压成底部**码头**（26vh，下限 170px）。
- **画布码头是同一个 DOM 节点**：切页面只改 CSS（`body[data-page]`），**从不摘除 iframe**——摘除即销毁
  browsing context（Chromium 行为），所以探针每次切页都断言运行帧的 `contentWindow` 仍存活。
- **`tabs` 表多了一列：页面**（`[tabId, panelId, i18nKey, page]`）。`activateTab()` 先切页面再显示面板；
  活动栏按钮记住每页上次的面板（`lastTabOfPage`）。十 chips 保留 id/class 契约，新增 `data-page`。
- **检查器是上下文相关的**：有检查器内容的页面（场景/观测）显示对应面板，其它页面显示一句说明
  （`body.wb-inspector-empty`）。
- **模块词法陷阱**：经典脚本共享一个全局词法作用域，第二个 `const api` 会让整个文件 SyntaxError；
  每个 app/ 模块用唯一导出名（`wb*Api`）。**同理，任何在启动期就会执行的函数不能引用后面声明的
  `const`**——`typeof` 对 TDZ 的 const 也会抛错（`let stage = null` 的由来）。

### 运行画面与草稿帧的接口事实（R2-A，2026-09-29）

- **运行画面靠推送**：产品页面只在启动 `getState()` 拉一次，之后只重绘 `office:state` 推送来的快照
  （`src/office/office.html`）。所以工具侧必须**推**：`runner.subscribe` → `webContents.sendToFrame([processId, routingId], 'office:state', snapshot)`。
  用 `webContents.send` 会广播给窗口里每个帧——包括草稿帧，那就成了两个视图抢同一张画面。
- **runner 的推送条件是"有出口"而不是"有回调"**：`hasSink = Boolean(onSnapshot) || listeners.size > 0`。
  写成 `if (onSnapshot && …)` 会让只订阅的消费者永远收不到——正是它让运行画面冻结在启动快照。
- **两个帧，两个 pack id**：运行层 `#preview-frame` 用 `?pack=deepseek-default`（永远读 `resources/**` 原件）；
  动作草稿 `#bench-frame` 用 `?pack=wb-staged`（协议层从 `content/build/preview-pack/**` 供给，未暂存的名字回落生产字节）。
  `boot.js` 的 `officeFrame()/benchFrame()` 按这个 mark 区分，查找不再有歧义。
- **画布三个模式**：`edit`（布局）· `run`（产品运行时）· `bench`（动作草稿，`stageSetMode('bench')` 同样先适应窗口）。
  动作编辑器的播放/单步只写草稿帧（`applySnapshotManually`），运行帧在这份代码里**没有任何重载路径**。

### 窗口形状的接口事实（R1，2026-09-28）

- **中间是画布，不是面板**：`#stage` 两层同坐标系——`#stage-scene-layer`（布局，`#scene-canvas` 可拖可编辑）
  与 `#preview-slot`（产品运行时视图，`#preview-frame`，由真 office 模块驱动）。**可见性只有一个来源**：
  `#stage[data-mode]` 的 CSS 规则。给层加 `hidden` 属性会让运行模式整块空白（探针当场抓到过）。
- **画布操作住在画布工具条**：模式 / 适应窗口 / 缩放 / 复位 / 保存布局 / 重新载入 / 播放 / 单步 / 重开 / 倍速。
  `stageSetMode()` 内部先 `stageFit()`——"切到运行"永远落在能看见的画面里。
- **一次一个工具**：右栏是检查器，`tabs` 表的顺序 = 切换器顺序 = 数字快捷键顺序 = 命令面板顺序（四处同源）。
  标记上只有 `panel-scene` 不带 `hidden`，`activateTab()` 负责切换并写好 `#inspector-tool` 的名字。
- **左侧是调色板**：素材库（产品 catalog 的 57 件家具，`studio.sceneFurniture()`）在上，内容树在下（自己滚动）。
- **拖放是一张路由表**：家具图 → `sceneEdit` 的 `add`（走同一事务）；动作帧 → 动作检查；文档 → 对应工具；
  其它 → 拒绝并列出可拖的类型（`DROP_UNSUPPORTED`）。
- **动作结果有 5 秒粘滞**：热重载会重读面板并重写"活信息"状态行，你刚做完的事不能被自己的刷新抹掉。

### 双语的接口事实（P8）

- 字典在 `src/workbench/i18n.js`（经典脚本，先于 `workbench.js` 加载），暴露 `window.wbI18n`；
  纯 Node 也能 `require`（测试用）。
- 键集是契约：`studio/test/i18n.test.js` **同时解析字典与 HTML/JS**——两边引用的键必须存在、每个键两种语言都不空、
  英文侧不许还是中文、未使用键不超过 1/3。加键忘了补英文 → 测试红。
- 语言偏好与主题一样进 shell 状态（跟随系统 / 中文 / English），跟随系统时读 `navigator.language`，未知语言回落中文。
- **范围**：只到外壳（标签/面板标题/按钮/空态）；面板内部的运行态文案仍是中文，属机械迁移。

### 工作台外壳的接口事实（P8 后半）

- **一个命令表驱动两处**：`commands()` 同时喂命令面板与快捷键映射（每个命令调用面板按钮调的同一个服务），
  所以"菜单里有、快捷键没有"这类不一致在结构上不可能出现。面板支持过滤（标签/id/分组）、
  ↑↓ 选择、Enter 执行、Esc 关闭，⌘/Ctrl+K 或 ⌘/Ctrl+P 开关。
- **分栏是可拖的，宽度进 shell 状态**：`role="separator"` 的两个分隔条支持指针拖动、←/→（Shift 大步）、
  双击复位，范围 `left 200–460 / right 320–620`，宽度随偏好一起写 `localStorage`（`wb-shell-state-v1`）。
- **热重载是"重读 + 刷新当前面板"，不是换掉正在跑的仿真**：`fs.watch(content/**, resources/characters/deepseek-default/**, recursive)`
  → 400ms 去抖 → `studio:content-changed` → 渲染端重读面板；**运行中的预览只在状态行提示"需点「重开」"**。
  探针证明的是**字节级无侵入**：把文件自己的字节写回，改动到达状态行，文件 sha256 前后一致。
- **两条被探针抓出来的竞态**（都不是"测试问题"，是产品缺陷）：
  1. `onContentChanged` 只在 `studioBridge` 上（共享 workbench bridge 没这个通道），可选调用把它**静默吃掉**——
     热重载看起来"接了"，其实从未到达界面；
  2. 预览面板的状态行是**活信息**，任何一次刷新都会重写它——运行脚本的结果写进去 1 秒内就被抹掉。
     结果因此改写到**独立的 `#preview-scenario-result` 行**（与状态行分离，语言切换也不会丢语义）。
- **页面侧遥测是"问渲染端"**：主进程向预览 iframe 要它自己的事实（渲染后端 `webgl2`、画布尺寸、空闲每秒重绘、
  页面布局源、页面员工数、页面诊断），既可单独读取，也随诊断包一起导出（导出前仍过密钥形状扫描）。
- **脚本回放按逻辑时钟验收**：`task-complete` 脚本跑完后，探针把墙上时钟停掉，用 `previewStep` 逐段推进逻辑时钟，
  记录"员工拿到终局结果"的 tick（本轮：tick 1500 / 24000ms，`outcome=completed`，动画相位 `result`）——
  这是确定性断言，不是"等它自己出现"。

### P6 的接口事实

- **解释器住在产品树里**（`src/office/behavior-graph/`），studio `require` 的是**工具树的那一份**；
  产品要用时 `require('./behavior-graph')` 即可 —— 同源，不是"两份实现保持同步"。
- **节点实例私有**：`createInterpreter` 深拷贝节点（环计数/下次触发时间/once 标记都挂在节点上），
  否则两次运行会互相污染，确定性就没了（P6 测试抓到过这个问题）。
- **`start()` 与 `inject()` 是两回事**：`start()` = 激活入口触发器（手动"跑这张图"、子图调用都用它）；
  `inject()` = 投递事件（含周期性 `every` 触发器由时钟驱动）。
- **手感参数有出处**：`feel.js` 的常量注明来自同行拆解（MIT 代码；素材与提示词未复制），
  `bin/graph.js feel` 可直接打印曲线与参数表供审阅。
- **未做**：图形化编辑器/时间轴回放面板（能力已进 `studioServices` 与 `studio:graph-*` IPC；编辑器需要一张画布，
  与 P8 的打磨一起排期），以及"自然语言 → 图"的 AI 起草。

## 7. 证据与进程纪律

- 证据放 `evidence/studio-<阶段>/`（截图 + JSON + README + 可复跑命令）。
- Electron 探针串行、自带清理（`app.exit` + 删临时目录）、窗口标题带 `PROBE` 前缀。
- 全量测试（仓库根 `npm test`）每阶段最多 1 次；studio 自己的套件（秒级 + 1 个 Electron 引导测试）可随改随跑。
