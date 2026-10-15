# 虚拟场景创作工作台（Office Studio）· 情况说明

> 交接对象：接手**页面逻辑重构**的 AI。
> 仓库：`/Users/xia/program/dsh/DshCockpit-s1`（分支 `feature/s1-office`），工具在 `studio/`，界面在 `src/workbench/`。
> 本文写完时的 HEAD：`8fb6e27`。**不要 push**（用户主代理负责推送）。

---

## 1. 它是什么

一个本地的内容创作工作台（Electron）：把"办公室"这类 2D 场景的**内容**（角色动画、家具摆放、行为规则、对话文案）做出来、校验、并能看到它**真的跑起来**。产品运行时（`src/office/**`）是**只读**依赖：工具可以 import 它，产品绝不能 import 工具。

```bash
cd studio
npm run studio     # 打开工作台（自己的用户目录 .studio-data/）
npm test           # studio 套件（纯 Node + 1 个真壳启动测试）
```

---

## 2. 目录地图（先读这一节，别把"文档"当成"制作目录"）

### 2.1 工作台本体 —— 重构只动这里

| 目录 | 是什么 | 谁写 | git |
|---|---|---|---|
| **`src/workbench/`** | 界面与工具内核：`workbench.html` · `workbench.css` · `workbench.js`（外壳渲染器，3339 行）· `i18n.js` · `workbench-preload.js`（contextBridge）· `app/`（`services.js` 共享服务层 · `ipc.js` 频道注册 · `gallery.js` 金样 · `boot.js` 两个入口共用的引导）· `lib/`（动作模型 · 角色几何 · 归一化 · 发布内核 · 内容校验）· `gallery-strip.js` | 我们 | **20 文件，跟踪** |
| **`studio/`** | 独立工具包：`main.js`（Electron 入口 + `studio:*` IPC + **真壳证据探针**）· `lib/**`（项目/`.dshpack` · 场景 · 动作 · 流水线 P4 · 行为图 · 图集 · 语料 · 预览运行器 · 护照 · 扫描）· `bin/**`（9 个 CLI）· `test/**`（16 个测试文件）· `package.json`（`dependencies` 为空） | 我们 | **跟踪** |
| **`scripts/office-workbench.js`** | 旧入口（薄壳，与 studio 共用同一套实现），`npm run office:workbench` | 我们 | 跟踪 |

### 2.2 内容（工具**只经校验事务**写，产品只读编译产物）

| 目录 | 是什么 | git |
|---|---|---|
| **`content/`** | 内容工程：`characters/<id>/**`（98 文件：动作文档 + 帧素材 + 语料 + 溯源）· `scenes/flat/{layout,scene,zones}.json` · `graphs/*.vgraph.json` · `shared/dialogue/**` · `project.json` | **跟踪** |
| `content/build/` | 工具的**再生成产物**：QC 报告 · 备份 · 金样截图 · 内容包 · 诊断包 | **IGNORED** |
| **`resources/`** | 生产包（运行时读的来源）：`office/flat/*.png`（57 件家具）· `characters/<pack>/**`（110 文件）。**只有"发布"动作会写它**，且先备份 + 记 provenance | 跟踪 |
| `photo/` | 历史源素材（277 文件），**只读引用**，新素材另存 | 跟踪 |

### 2.3 产品运行时 —— 工具的只读依赖，**重构不许改**

| 目录 | 是什么 | git |
|---|---|---|
| `src/office/` | 产品运行时：`office-module.js` · 调度器 · Pixi 渲染器 · `runtime/**` · `behavior-graph/**`（解释器放在产品树里，好让产品与工具用同一份）· `office.html` | 74 文件，跟踪 |
| `src/main.js` 等产品入口 | **依赖图里不得出现 `src/workbench/**` 或 `content/**`**（根套件 M0 boundary 测试拦） | 跟踪 |

改 `src/office/**` 的语义＝动产品，必须走"RED 测试 + 复审"，不属于本次页面重构范围。

### 2.4 文档 —— 和"制作目录"完全是两回事

| 目录 | 是什么 | git |
|---|---|---|
| **`studio/docs/`** | 工具的正式文档：`architecture.md`（分层/边界/各阶段接口事实）· `contracts.md`（数据契约 + 画布窗口）· `providers.md`（模型×密钥×许可）· `provenance.md` · `generation-loop.md`（生成段闭环命令链契约）· `main-product-integration.md` | **6 文件，跟踪** |
| `studio/README.md` | 工具说明书（怎么跑、三条纪律、诚实边界） | 跟踪 |
| **`docs/notes/`** | **本地开发笔记，不在 git 里**（`.gitignore` 第 28 行，0 跟踪）：设计稿 `office-workbench-design.md`、M0 契约 `office-workbench-m0.md`、编辑器笔记、交接记录 | **IGNORED** |
| `docs/specs/` · `docs/research/` · `docs/superpowers/` · `docs/compat/` · `docs/legacy/` | 规格 / 研究 / 计划 / 兼容 / 历史（**被测试读取**，别删别挪） | 跟踪（88 文件总量） |

**两条最容易搞混的**：
1. **`studio/docs/` 与仓库根的 `docs/` 是两个不同的文档树**；`docs/notes/**` 只有本地文件、提交不上去。
2. **`studio/` 下不该有内容树**：`.gitignore` 里有 `studio/content/` 作为防线（曾经有个探针把输出路径解析到了进程 cwd，写到了 `studio/content/` 里）。**内容树永远是仓库根的 `content/`**；`studio/content/` 现在磁盘上不存在，出现了就是 bug。

### 2.5 运行期数据目录（IGNORED，都不是内容，删掉只花时间不丢数据）

`.studio-data/`（studio 的 Electron userData）· `.workbench-data/` · `.studio-cache/`（内容寻址阶段缓存）· `studio/build/`（工具输出）· `.office-editor-data/`（旧编辑器草稿）· `content/build/`。

### 2.6 不属于工作台

`output/` · `website/`（含未跟踪的 `website/design/`）· `tools/opencode-orchestrator/` · `artifacts/**`（74 文件跟踪；里面是**发布门禁台账**，别动）· `node_modules/`。
**证据不在仓库里**：`evidence/studio-<阶段>/`（截图 + `results.json` + README + 复跑命令）。

---

## 3. 现在的窗口结构（上一轮 R1 刚重做，改的就是这个）

```
┌ 顶栏 标题 · 状态行 · 主题 · 语言 · 左右栏开合 ─────────────────────────────┐
│ 素材库（57 件家具，可拖）      │  画布（stage）            │  检查器（一次一个工具）│
│ ────────────────           │  ┌ 工具条：编辑/运行·适应/缩放/复位·保存/重载·播放/单步/重开/倍速
│ 内容树（可拖文件出来）        │  ├ 视口：#stage-world（1280×840，同一坐标系）
│                            │  │   编辑层 #scene-canvas  运行层 #preview-frame
│                            │  └ 状态行 #canvas-status / #preview-status / #canvas-selection
└────────────────────────────┴──────────────────────────────┴──────────────────────┘
```

- **画布两层同一坐标系**：`编辑`＝布局（可拖、可从素材库拖家具进来、可从内容树拖文件进来），`运行`＝产品真实运行时视图（真 office 模块驱动）。可见性**只有一个来源**：`#stage[data-mode]` 的 CSS 规则（曾经因为给层加 `hidden` 属性导致运行模式全空）。
- **工具一次只开一个**：10 个工具按用途分四组（画布 / 素材与动作 / 行为 / 报告）。`tabs` 表的顺序 = 切换器 = 右侧轨道 = 数字快捷键 = 命令面板（四处同源）。
- **画布操作住在画布工具条**：`stageSetMode()` 内部先 `stageFit()`，所以"切到运行"永远落在能看见的画面里。

---

## 4. 硬约束（重构不许破；破了测试会红）

1. **工具/产品边界**：`src/workbench/**`、`content/**`、`studio/**` 不得出现在产品入口的依赖图里 —— 根套件 `test/office-ui.test.js` 的 M0 boundary 测试 + `studio/test/boundary.test.js` 双重强制。**不要改 `src/office/**` 的语义**。
2. **元素 id 是契约**：界面是被**真壳探针**驱动验收的（`studio/main.js` 里点这些 id、读它们的文本）。重构要么保留下列 id，要么在**同一个提交**里同步改测试与探针，且断言必须仍然有意义：
   - 三栏：`wb-left` `wb-center` `wb-right` `preview-slot` `wb-rail-left/right` `btn-toggle-left/right`
   - 工具：`#wb-tabs` 与 `#tab-<x>`（**必须保持 `class="wb-tab"` 原样**，测试按这个属性选择）、`#panel-<x>`（标记里**只有一个不带 `hidden`**＝默认工具）、每个 `#tab-x` 都要有对应的 `.wb-rail-tab[data-tab="tab-x"]`、`#wb-inspector-head` `#inspector-tool` `.wb-tab-group`
   - 画布：`stage` `stage-toolbar` `stage-viewport` `stage-world` `stage-scene-layer` `stage-empty` `stage-statusbar` `stage-zoom` `scene-canvas` `preview-frame` `btn-stage-fit/zoom-in/zoom-out/reset/mode-edit/mode-run` `btn-canvas-save/reload/remove/smaller/bigger/hide` `btn-preview-play/step/restart` `preview-speed` `canvas-status` `preview-status` `canvas-selection` `preview-scenario-result`
   - 左栏：`tree-root` `tree-filter` `tree-summary` `btn-tree-collapse/expand` `tree-hint` `library-root` `library-summary`
   - 其它：`wb-palette` `wb-palette-input` `wb-palette-list` `wb-palette-hint` `wb-splitter-left/right`（`role="separator"` + `tabindex="0"`）`geometry-table` `asset-table` `bench-timeline` `timeline-*` `preview-telemetry` `btn-preview-telemetry` `btn-theme` `btn-lang` `wb-status` `wb-title`
3. **双语键集等价**：文案走 `src/workbench/i18n.js` 字典（`data-i18n` / `-title` / `-placeholder` / `-aria-label`）；`studio/test/i18n.test.js` 会解析字典与 HTML 两侧，缺键或英文侧还是中文即红。**面板内部**的运行态字符串目前仍是中文（已知欠账）。
4. **对比度**：`studio/test/contrast.test.js` 解析真实 CSS 变量算 WCAG（13 对 × 4 主题变体）。新增颜色必须走 token（`:root` / 深色 / `body[data-theme]`）。
5. **内容写入只走既有事务**：布局改动走 `studio/lib/scene/edit.js`（副本 → 重建碰撞区 → 冲突校验 → 备份 → 写），语料/动作/发布各有内核。**不要直接写 `content/**`**。改动先试算（`save:false`）再写（`save:true`）。
6. **探针纪律**：任何改动内容的探针必须**从它自己产生的备份还原**并断言**字节一致**；`content/**` 的字节扫描（`sk-` / `Bearer` / `token=` / cookie）与"密钥绝不入库/入日志/入导出物"是红线。
7. **不新增 npm 依赖**（`studio/package.json` 的 `dependencies` 为空）；Electron 从 `../../node_modules` 解析。
8. **一个阶段一个提交**；全量测试每阶段最多跑一次；证据放 `evidence/studio-<阶段>/`。

---

## 5. 已有功能（别重复造）

**画布**：编辑/运行双层、适应窗口/缩放/滚轮以光标为锚点/平移/复位、保存布局（校验红则拒绝）、重新载入、删除物件、选中物件的 ±缩放/隐藏、显示开关（行走点/障碍/坐席）；**从素材库拖家具＝放进布局**（试算→校验→备份→写）；从内容树拖文件的分流（动作帧→动作检查；layout/scene/zones→场景；`.vgraph`→行为图；文档→对应工具；其它→拒绝并说明）。

**十个工具**：场景（检查·行走点图·重建碰撞区）· 运行（脚本·手动事件·员工表·遥测·诊断包）· 动作（帧序编辑·导入归一化·发布校验）· 动作检查（逐帧·脚线/质心·上一帧残影·时间轴回放·按帧批注·能力缺口）· 素材校验（catalog 逐条 + 发布校验）· 行为图（画布·校验/运行/差异报告·自动排版）· 对话文案（两层语料·12 类守卫·CSV 导入·试说一句）· 几何报表（逐帧鞋线/可见框/漂移）· 视觉基线（金样截图 diff）· 素材溯源（五段护照·参数台账·`.dshpack` 往返）。

**外壳**：命令面板（⌘K，一张命令表同时驱动面板与快捷键）· 可拖分栏（宽度记忆）· 主题（跟随系统/浅/深）· 双语 · 热重载（400ms 去抖，**绝不静默换掉正在跑的仿真**）· 空态与提示。

**主进程侧**（`studio/lib/**`）：项目/`.dshpack`、场景校验与图、动作 v2 与发布内核、流水线 S0–S8（QC/抠像/缓存/provider 门禁/编排）、行为图解释器、图集打包、对话语料、预览运行器（真的 `office-module.js`）、护照与台账。**很多能力只有 CLI/IPC，没有界面**（见 §6）。

---

## 6. 缺口（按"挡不挡事"排序，含定位）

| # | 缺什么 | 证据 / 定位 | 性质 |
|---|---|---|---|
| 1 | **撤销/重做**（⌘Z/⇧⌘Z）。现在改错了只能"删除物件"或"重新载入"（后者丢掉全部待保存改动） | `workbench.js` 里 `撤销\|undo` 命中 0 | 工具侧，**最高优先** |
| 2 | **选中物件的数值属性**：只有 ±缩放/隐藏/删除，改不了坐标、**层级（深度带）**、名字 | 同上，`btn-canvas-*` 共 6 个 | 工具侧 |
| 3 | **复制 / 多选 / 对齐辅助线 / 吸附开关** | `duplicate\|multiSelect\|对齐辅助\|snap` 命中 1 | 工具侧 |
| 4 | **拖拽落点预览**（半透明幽灵 + 会不会违规的预示色）；现在是松手才知道校验结果 | `stageDropFurniture` | 工具侧，观感 |
| 5 | **运行层可观测性**：跟着某个员工看它跑完一个任务、编辑层与运行层对照、在运行画面上叠加派生导航图/工位 | 运行层只有全景视图 | 工具侧，**很实用** |
| 6 | ~~**流水线（S0–S8）没有界面**~~ **已接上（R5）**：「生成」页 + 「流水线」子视图，阶段表/缓存视图/QC 报告/人工分诊/计划与执行/护照跳转，全部经 `studio:pipeline-*` 服务消费引擎（`resolvePlan`/`runPipeline`/triage）。证据 `evidence/studio-R5-pipeline-panel/` | `workbench.js` 里 `pipeline` 命中 0 → 现有 `app/pipeline-model.js` + 面板块 | 工具侧，**最大空白面** |
| 7 | **新建角色工程**流程（新增一个角色：素材+动作+行为+语料） | `studio/bin/` 无 character 入口 | 工具侧，中等 |
| 8 | 面板内部文案双语（外壳已双语） | `i18n.js` 注释里已声明为欠账 | 机械活 |
| 9 | 障碍框太抢戏（默认实心粉块 33 个）；选中态没有手柄；模式切换是硬切 | `workbench.css` 场景层绘制 | 观感 |
| 10 | 自由摆放的**参考图图层**（现在只允许"放进布局"这一条有校验的路，故意的） | — | **等用户拍板** |
| 11 | **行为图驱动运行时**（brief 的 M3） | `src/office/runtime/**` 不引用 `behavior-graph` | **引擎侧**，要 RED 测试 + 复审 |
| 12 | **图集接进运行时**（纹理 74→1、体积 1.52×） | P8 只产图集 + 清单 | **引擎侧** |
| 13 | AI 起草（规则/语料/图）、真实生成（S1/S2/S3） | 缺 key 即拒 + 计划可离线评审 | **要用户配 key** |
| 14 | 角色动画缺口：转向（东张西望）、说话（口型） | `node studio/bin/actions.js gaps` 自报，均为可选 | 要生成 |

**重构时建议保留的**：事务模型（试算→校验→备份→写）、探针驱动的验收、`stageFit()` 与模式耦合、`tabs` 表四处同源。

---

## 7. 怎么验证你有没有改坏

```bash
cd studio && npm test                     # 现在 182/182（含真壳启动测试）
cd /Users/xia/program/dsh/DshCockpit-s1 && npm test   # 产品侧 1244/1244（含 M0 边界测试）
```

真壳证据（一条命令，约 20 秒，出截图 + `results.json`）：

```bash
cd studio
STUDIO_EVIDENCE_DIR=../evidence/studio-<你的阶段> npm run studio
# 成功＝stdout 出现 STUDIO_EVIDENCE_OK；失败＝STUDIO_EVIDENCE_FAILED <原因> 且退出码非 0
```

它顺带复验全部既有面（场景画布/行为图/审片台/语料/护照/主题/双语/热重载/遥测）并断言**内容字节无侵入**。改动界面时，请把新断言加进同一个探针，别只靠"看着对"。

---

## 8. 已有的证据基线与文档

- `evidence/studio-P8-ux/` —— 命令面板/分栏/热重载/遥测（123 字段）
- `evidence/studio-R1-stage/` —— 画布窗口重做（135 字段，17 张截图）
- `evidence/studio-R5-pipeline-panel/` —— 流水线面板接真引擎（计划=引擎干走 / 强制执行 / 二跑全缓存 / 改参数只重跑 S6 / QC 必挂进分诊并 resolve / 护照跳转 / 键盘路径，7 张截图 + README）
- 工具文档（**在 `studio/docs/`，跟踪**）：`architecture.md` · `contracts.md` · `providers.md` · `provenance.md` · `generation-loop.md` · `main-product-integration.md`
- 本地笔记（**在 `docs/notes/`，不在 git**）：`office-workbench-design.md`（设计稿）· `office-workbench-m0.md`（M0 契约）
