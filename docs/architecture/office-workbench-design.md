# Office Workbench 设计讨论稿（v0.1，待讨论）

> 状态：**讨论稿**，不是实施计划。先定方向，再拆里程碑。
> 原则：**文档先行**；**工欲善其事，必先利其器**；工具与产品分离。
> 本文只描述"内容生产工具链"，不改变运行时语义。

---

## 1. 问题诊断（为什么现在慢）

不是"缺一个编辑器"，而是三处结构性摩擦：

| 摩擦 | 表现（近期实例） | 代价 |
|---|---|---|
| **反馈回路太长** | 改一帧/改一个尺寸 → 子代理实现 → `npm test`（约 2.5 min，含 8 个 Electron 真壳探针）→ 主代理复审 → 用户目检 | 一轮以小时/天计；而"观感"需要秒级迭代 |
| **契约散落在代码与测试里** | 帧序=元数据、锚点、鞋底线、可见高度、画布、contentBbox、层级带、可行走图、豁免语义……每次改动都要重新发现约束（passing 帧的帧序陷阱、E3 的场景框漂移、水洗线误判） | 每次改动先付"考古成本"，且错误只有真壳测试才发现 |
| **验收不可视** | 1154 个测试全绿，但"办公室看起来对不对"没有任何自动化的视觉基线；旧截图不留档、无法 diff | 每个视觉问题都要人肉找，且会重复出现 |

结论：**要做的是把这三处各修一条**，而不是堆更多功能。

---

## 2. 设计原则

1. **内容与引擎分离**：内容 = 数据（JSON + 素材）；引擎 = 代码。内容变更只跑"内容校验器"（秒级），不跑引擎测试套件。
2. **契约显式化**：散落在代码里的约束集中为**可机读规格 + 校验器面板**；违规即红、即阻（fail-closed）。
3. **归一化是一等公民**：导入素材必须经过"自动归一化预览 + 几何报表（锚点/鞋底线/可见高/比例）+ 一键接受或重试"，绝不裸放文件（passing 帧的教训）。
4. **区域而非线条**：可行走性 = 可走区域 + 障碍（带半径）→ 自动派生导航图 → 采样校验（复用 E4 编译器里的采样器）。手画折线只当提示，不作真相来源，建议不提供。
5. **行为是声明式规则，不是新引擎**：可视化编排**编译进现有状态机/调度器**（固定动作与守卫白名单），保住 FIFO/预约/终局保留/身份绑定这些用十几轮修复换来的语义。
6. **工具不进发行版**：`src/workbench/**` 永不被产品入口引用；构建配置排除。产品只带**编译产物**（packs + fixtures）。
7. **AI 只做草稿 + 机器校验 + 人工闸门**：不做"AI 生成即用"的承诺。

---

## 3. 分层与边界

```
content/                        ← 内容工程（可版本化，工具读写，运行时只读编译产物）
  characters/<id>/
    character.json              ← 角色工程：素材/动作/几何/朝向/比例
    actions/<actionId>.json     ← 动作：帧序列、时长、循环、朝向
    assets/…                    ← 该角色的全部素材（按角色分目录，符合现有 pack 契约）
    dialogue/<topicId>.json     ← 该角色的语料（角色库）
    behaviour/<ruleId>.json     ← 角色级行为规则（可选）
  scenes/<id>/
    scene.json                  ← 逻辑尺寸、地面线、层级带、风格令牌
    zones.json                  ← 可走区域 + 障碍 + 图派生参数
    layout.json                 ← 布局草稿（现编辑器格式，schema v1）
  shared/dialogue/…             ← 基础语料库（跨角色）
src/office/**                   ← 运行时（产品）。语义冻结：变更仍需 RED 测试 + 审查
src/workbench/**                ← 工作台（工具）。可 import 运行时；运行时禁止反向 import
scripts/office-workbench.js     ← 独立入口：npm run office:workbench（与 office:editor 合流）
dist 排除：src/workbench/**、content/**、photo/**（构建配置 + 静态检查测试强制）
```

**边界强制**：新增测试断言"产品入口的依赖图不含 `src/workbench/**` 与 `content/**`"。

---

## 4. 内容交付单元（CDU）——新的工作流

一次内容变更 = 一个 **CDU**（Content Delivery Unit）：

1. 在 workbench 里编辑（或由 AI 起草）；
2. 点"编译+校验"：跑内容校验器（帧几何/资产/路径/区域冲突/规则合法性/语料红线），输出**几何报表 + 视觉基线 diff**；
3. 你目检 diff（before/after 对比条）→ 接受 → 导出内容包；
4. 提交：**一个 CDU 一个 commit**，只含 `content/**` 与编译产物；不触发引擎测试套件；
5. 运行时只消费编译产物；引擎侧只在"工具/编译器需要改"时才回到"RED 测试 + 主代理复审"的老路。

这是消除拉锯的关键分工：**内容微调归你（工具秒级反馈），引擎变更归代理（严谨流程）**。

---

## 5. 工作台形态与面板

独立 Electron 工作台（本地优先，不联网即可用），三栏 + 底部：

| 面板 | 作用 | 复用现有 |
|---|---|---|
| 资源树 | `content/` 浏览（角色/场景/动作/语料） | 新 |
| 预览场 | 实时渲染场景/角色（不重启、不跑测试） | 现有渲染器 + 页面 |
| 属性/检查器 | 位置/缩放/层级/朝向/帧时长 | 现有编辑器 |
| 时间轴 | 动作帧序列：拖拽排序、单帧时长、播放/逐帧、循环 | 新（帧序=数据，非文件名） |
| 几何报表 | 锚点/鞋底线/可见高/可见宽/比例偏差，超差即红 | 复用归一化管线 + 校验器 |
| 区域与图 | 涂可走区、涂障碍、派生图、冲突列表（边×家具） | 复用 E4 编译器采样器 |
| 行为规则 | 规则列表/流程视图（闭集动作与守卫），编译错误即红 | 新（编译到现有引擎） |
| 语料库 | 基础库 + 角色库，条目含 key/条件/权重/时长 | 新 |
| 校验与证据 | 一键跑全部校验器 + 生成金样截图与 diff | 复用现有探针 |
| 事件仿真台 | 手动/脚本注入任务事件（派发/终局/取消/排队），驱动任务环 | 复用 ingestHarnessEvent |

---

## 6. 关键数据契约（草案）

### 6.1 角色工程 `character.json`

```json
{
  "schemaVersion": 1,
  "id": "whale-girl",
  "label": "鲸鱼娘",
  "pack": { "canvas": 352, "anchor": { "x": 178, "y": 296 }, "footLine": 296, "unionVisibleBounds": { "x": 6, "y": 41, "w": 319, "h": 277 } },
  "facing": ["front", "back", "left", "right"],
  "defaults": { "frameDurationMs": 1000, "scale": 1 },
  "actions": ["idle", "walk-left", "walk-right", "walk-up", "walk-down", "working-back", "finished", "error"],
  "provenance": { "source": "generated", "model": "gpt-image", "promptHash": "…", "normalizedBy": "normalize-passing-frame.py@sha" }
}
```

### 6.2 动作 `actions/<id>.json`

```json
{
  "schemaVersion": 1,
  "id": "walk-left",
  "loop": true,
  "direction": "left",
  "frames": [
    { "file": "assets/actions/walk-left/01.png", "durationMs": null },
    { "file": "assets/actions/walk-left/02.png", "durationMs": null },
    { "file": "assets/actions/walk-left/passing.png", "durationMs": null },
    { "file": "assets/actions/walk-left/03.png", "durationMs": null },
    { "file": "assets/actions/walk-left/04.png", "durationMs": null }
  ],
  "geometry": { "footLine": 296, "visibleHeight": [256, 256, 257, 256, 256], "tolerancePx": 1 }
}
```

> 要点：**帧序在数组里**（数据），文件名不参与排序；几何偏差超 `tolerancePx` 即校验失败。

### 6.3 场景 `scene.json` + 区域 `zones.json`

```json
// scene.json
{ "schemaVersion": 1, "logical": { "width": 1280, "height": 840 }, "groundLine": 0.62,
  "depthBands": { "background": [0, 10], "floor": [10, 20], "furniture": [20, 40], "character": [45], "foreground": [50, 60] },
  "tokens": { "palette": ["#f6f7f8", "#e7ebee"], "outline": "#7f95a3" } }

// zones.json
{ "schemaVersion": 1,
  "walkable": [ { "kind": "rect", "rect": [0.06, 0.06, 0.88, 0.86] } ],
  "obstacles": [ { "id": "desk-3", "kind": "rect", "rect": [0.62, 0.44, 0.14, 0.10], "radius": 0.012 } ],
  "graph": { "derive": "auto", "aisleWidth": 0.06 },
  "validation": { "sampleStep": 0.005, "moverRadius": 0.02, "exemptSameStation": true } }
```

### 6.4 行为规则 `behaviour/<id>.json`（编译进现有引擎）

```json
{
  "schemaVersion": 1,
  "id": "task-work-cycle",
  "on": { "event": "task/assigned" },
  "guard": [{ "seat": "free" }, { "sync": "healthy" }],
  "steps": [
    { "do": "walk.to", "target": "approach", "until": { "distance": 0.01, "timeoutMs": 20000 } },
    { "do": "transition.start", "kind": "task-start" },
    { "do": "animation.set", "resource": "working", "facing": "auto" },
    { "do": "await", "event": "task/terminal" },
    { "do": "result.present", "ms": 1200 },
    { "do": "queue.release" }
  ],
  "onCancel": [{ "do": "transition.cancel" }],
  "next": "local-behaviour"
}
```

> **闭集白名单**：`do`/`guard`/`until` 只能取固定注册表里的值；未知值 = 编译失败。
> **不变式**：FIFO 原子派发、预约、终局保留、身份绑定、取消语义全部由引擎保证，规则不能绕过。

### 6.5 语料 `dialogue/<topic>.json`

```json
{ "schemaVersion": 1, "id": "pantry-smalltalk", "scope": "shared|character",
  "trigger": { "kind": "pair-chat", "topics": ["pantry", "coffee"] },
  "entries": [
    { "id": "a-01", "speaker": "any", "text": "今天算力够用吗？", "weight": 2, "if": { "taskActive": false } },
    { "id": "b-01", "speaker": "whale-girl", "text": "够，米缸还有半缸。", "weight": 1, "replyTo": "a-01" }
  ],
  "limits": { "bubbleMs": 3200, "maxConcurrent": 2, "cooldownMs": 30000 } }
```

> 红线：语料文本必须过隐私校验（无 session/run id、无路径、无密钥样式字符串），运行时只用本地库。

---

## 7. AI 接入的分层（明确边界）

| 层 | 例子 | 自动化程度 | 闸门 |
|---|---|---|---|
| L1 确定性变换 | 归一化、锚点/鞋底线对齐、打包、图派生 | 全自动，不需 AI | 几何报表（超差即红） |
| L2 素材生成 | 由基础图生成行走帧/坐姿工作帧 | AI 生成草稿 | 机器一致性校验（剪影/高度/鞋底线/主色/比例）+ 你一键接受或重试 |
| L3 规则与语料起草 | "给这个角色加一段喝水行为"、"写 20 条茶水间闲聊" | AI 出草稿 | 编译进闭集 DSL + 校验 + 你确认；**不在发行版里跑 AI** |

---

## 8. 里程碑（每个里程碑以"你能独立完成某件事"验收）

| 里程碑 | 内容 | 验收（不碰代码） |
|---|---|---|
| **M0 秒级反馈 + 视觉基线**（1 周） | workbench 壳；搬入场景预览 / 布局编辑器 / 素材校验器；新增几何报表与金样图库（固定场景 × 窗口档位 × 每动作逐帧 + 上一版 diff） | 你改一个素材 → 30 秒内看到几何报表与 diff 图 |
| **M1 动作编辑器** | 帧序拖拽、单帧时长、循环、播放/逐帧；导入即归一化预览；帧序/几何校验 | 你独立把一次"4 帧行走 → 5 帧 + 调序"在 10 分钟内做完 |
| **M2 区域与图** | 涂可走区/障碍、派生导航图、冲突列表（复用 E4 采样器） | 你移动一张桌子 → 工具报出受影响边 → 你确认或调区 |
| **M3 行为规则编辑器** | 规则列表/流程视图（闭集动作/守卫 → 编译进引擎）+ 事件仿真台 | 你不改代码，让角色"排队 → 派发 → 工作 → 结果 → 离开"换一套顺序 |
| **M4 语料与角色工程 + AI 助手** | 基础/角色语料库、气泡上限与冷却；AI 起草规则/语料/素材帧 | 你新增一个角色（素材+动作+行为+语料）不需要代理介入 |

---

## 9. 纪律（防止"工具变成产品"）

1. **任务牵引**：任何工具功能必须由一条"在办的内容任务"牵引；没有任务不开发。
2. **两周未用即降级/删除**：每月回顾一次使用记录。
3. **不动运行时语义**：工具只能让内容变更变快；引擎语义变更仍走 RED 测试 + 复审。
4. **每个里程碑必须可停**：做完 M0 就停下来实用；不许"等功能齐了再用"。
5. **量化收益**：每里程碑记录"完成同一件事的耗时（工具 vs 旧流程）"。

---

## 10. 待拍板的问题

1. 工作台形态：Electron 独立 entry（与 `office:editor` 合流）还是本地 Web 版？
2. 内容工程目录 `content/` 是否入库（我建议入库：内容即资产，且有 diff 与回滚）？
3. 行为规则：接受"闭集动作/守卫 + 编译器校验"？（强烈建议）
4. 区域/图：接受"涂区域 → 派生图 + 采样校验"，不提供手画折线？
5. 视觉基线：金样图库的判定阈值（布局 5% 像素差？几何 1px？），以及是否纳入 CI？
6. L2 素材生成的一致性闸门选哪些指标（鞋底线/高度/剪影 IoU/主色距离）？
7. 是否允许工具直接改写 `resources/**` 生产素材（我建议：工具只写 `content/**`，由"发布"动作同步到 `resources/**` 并留 provenance）？
8. 现有 `resources/characters/deepseek-default` 是否迁移到 `content/characters/whale-girl`（我建议迁移，旧包保留为编译产物）？
9. 发行版排除：接受"构建配置 + 静态检查测试"双重强制？
10. 内容变更的提交粒度：一个 CDU 一个 commit（不跑引擎套件）是否接受？
11. M0 是否加"事件仿真台"的最小版（只有 4 个按钮：派发/终局/取消/排队）？

---

## 11. 与现有系统的兼容

- **不改**运行时语义、布局草稿 schema v1 的既有字段、E4 编译器契约、E5a 的帧几何契约、发布门禁台账规则。
- **复用**：`office-layout-compiler.js`（编译+采样）、`layout-editor.js`（编辑模型）、`pixi-office-renderer.js`（预览）、`normalize-*.py`（归一化管线）、真壳探针模板（证据与金样）。
- **迁移路径**：内容工程目录先与现状并存（读取现有 pack 生成 `character.json`），M4 再切换为唯一来源。
