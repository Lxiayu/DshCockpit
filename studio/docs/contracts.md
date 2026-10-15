# Studio 数据契约（schemaVersion 1）

> 本文件是**事实源的可机读形状**的说明：所有 `schemaVersion: 1` 的内容文件、它们的必填字段、
> 单位与不变量，以及校验它们的代码位置。**契约为先**：任何新增字段都必须先在这里写明，
> 再让校验器接受它（`content-validator` / `layout-schema` / 动作模型三者是执行者）。

单位约定（全局）：坐标一律**归一化 [0,1]**，原点在场景左上；像素值只在画布内（352²）出现；
时间一律毫秒（`durationMs`）；`null` 表示"继承默认值"，绝不写 0 表示继承。

## 1. 角色工程 `content/characters/<id>/character.json`

由 `scripts/workbench-export-character.js` 从生产包导出（**生成物，不手改**）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schemaVersion` | 1 | 固定 |
| `id` | string | 角色 id（`whale-girl`） |
| `label` | string | 展示名 |
| `pack.canvas` | number | 画布边长（352） |
| `pack.anchor` | {x,y} | 脚点锚（178, 296）——**归一化中心用非透明像素 x 中位数定，不用质心** |
| `pack.footLine` | number | 鞋线 y（296） |
| `pack.unionVisibleBounds` | {x,y,w,h} | 全帧可见并集（319×277），供防裁剪断言 |
| `facing` | string[] | `front\|back\|left\|right`（产品边界：四方向，不做 8 向/3D） |
| `defaults.frameDurationMs` | number | 帧时长默认（1000） |
| `defaults.scale` | number | 默认缩放 |
| `actions` | array | 每个动作的 `{id, loop, direction, frames[], geometry}`（见 §2） |
| `provenance` | object | `{generatedBy, sourcePack, sourcePackVersion, sourcePackId, frameRoot, measurement}` |

不变量：`frames[i].file` 相对 `provenance.sourcePack` 解析；`frameRoot: 'sourcePack'` 表示**包是字节源**。

## 2. 动作 `content/characters/<id>/actions/<actionId>.json`

**帧序在数组里（数据），文件名不参与排序**——这是 E5a-R1 用一次生产事故换来的教训。

### 2.1 v1（运行时契约，v1 文档仍然有效）

```json
{ "schemaVersion": 1, "id": "walk-left", "loop": true, "direction": "left",
  "frames": [ { "file": "assets/animations/walk/left/walk-left-b01.png", "durationMs": null } ],
  "geometry": { "footLine": 296, "tolerancePx": 1 } }
```

- `durationMs`：`null`（继承包默认）或 **50–5000** 之间的整数；越界 = 发布失败。
- `geometry.footLine`：该动作的鞋线期望值；发布时逐帧实测，**±1px** 外即拒。
- 可见高度：同动作内**±2px**（对中位数），超差即拒。
- 发布（`src/workbench/lib/action-publisher.js`）是**唯一**写包路径：fail-closed、写前备份
  `content/build/backups/<ISO>/`、只改目标条目、`anchors.json` 的 frames 键序 = 元数据序、追加护照记录；无变更不记录。

### 2.2 v2（创作契约，P3；`studio/lib/actions/schema.js`）

v1 是 v2 的子集（`pingPong:false`、`tags:[]`、`events:[]`），因此**旧文档无需改写即可被读**；
`studio/bin/actions.js migrate` 一次性升级（先备份、无变更不落盘）。

| 字段 | 类型 | 语义 |
|---|---|---|
| `pingPong` | bool | 播放模式：审片台正放→倒放；**周期 = 2×总时长 − 首帧 − 末帧**（3 帧 100ms = 400ms，不是 600ms）。**不可发布**（见 §2.3） |
| `tags` | string[] | 货架/行为图用的标签（kebab-case，**不自动去重**：重复是作者的错，报错而不是悄悄修） |
| `events` | [{frame,name,data?}] | **帧号锚定**事件（`frame` 是元数据下标，**不是文件名**）：脚步/眨眼/道具出现… |

### 2.3 发布契约（v2 元数据随包走）— 2026-09-28 更新

**原来的结论已作废**（当时包校验器是严格白名单）：本轮把 `ANIMATION_FIELDS` 扩成
`['state','direction','loop','frames','tags','pingPong','events']`，并把 `buildPackEntry` 与 `compileDown`
一起改为**存在即携带**——所以：

- v2 元数据（tags / pingPong / events）**随包发布**，装配器（`asset-pack.js`）只读它需要的字段，**运行时行为不变**；
- **v1 文档仍然逐字节不变**（不发明空键）——"无变更不记录"的 noop 判定已把元数据纳入比较，所以"只改标签"会被正确识别为**需要发布**；
- 校验器仍然拒绝**形状错误**的元数据（非 kebab 标签、非布尔 pingPong、越界事件帧），RED 测试锁定（`test/office-action-v2-metadata.test.js`）；
- `pingPong` 保留一条恒真的注意事项：包里存的是**标志位**，帧序列仍是正向序（`anchors.frames` 以文件路径为键，同一文件不能出现两次），
  消费方若要用 ping-pong 需自行反转。

真资产落地（2026-09-28）：8 个动作文档迁移到 v2（备份在 `content/build/backups/actions/`），
四条行走动作标上事实性标签 `walk` 并**已发布进生产包**（每条都有备份 + provenance 记录），严格校验器复验通过。

### 2.4 审片批注（sidecar，P3）

`content/characters/<id>/actions/<actionId>.notes.json`：
`{schemaVersion:1, actionId, notes:[{id, frame, file, severity:'note'|'fix'|'praise', text, createdAt, resolved?}]}`

- **独立文件**：动作文档保持可发布的干净契约，包校验器不受影响；批注随内容走、发布不丢。
- `frame` 是**帧号锚定**；同时记下当时那一帧的文件名，**帧序一变即标 `stale`**（不静默重指）。
- 导出（`exportNotes`）带上帧映射（index/file/durationMs），可直接交给下一轮生成或人工精修。

### 2.5 能力缺口（P3）

`studio/lib/actions/gaps.js` 的能力矩阵读**真实库存**（content 动作 + 包动画），逐项给
`complete / partial / missing / not-produced` 与**怎么补**。现状：必需项全齐；
`turn`（转向专用动画）与 `talk`（说话帧）为 `not-produced`（对话目前用气泡文本）。

## 3. 场景 `content/scenes/<sceneId>/scene.json`

`{schemaVersion, id, label, logical:{width,height}, groundLine, depthBands:{background:[0,10], floor:[10,20], furniture:[20,40], character:[45], foreground:[50,60]}, tokens:{palette[], outline}}`

- `logical` 是**逻辑坐标系**（1280×840）；窗口尺寸变化由等比例 letterbox 适配，不重排内容。
- `depthBands` 定义带内深度取值范围，运行时按它决定绘制顺序；**带 + 带内 z 才是完整顺序**。
- 布局三层的顺序契约（编辑器合成、运行时必须一致）：`desk < monitor < character < chair`。

## 4. 区域与导航 `content/scenes/<sceneId>/zones.json`（P2 已实现）

```json
{ "schemaVersion": 1, "scene": "flat",
  "walkable": [ { "kind": "rect", "rect": [0.06, 0.06, 0.88, 0.86] } ],
  "obstacles": [ { "id": "desk-1-back", "kind": "rect", "rect": [0.4835, 0.1753, 0.1154, 0.1168], "workstation": "desk-1" },
                 { "id": "draft-53",    "kind": "rect", "rect": [0.0205, 0.1302, 0.2166, 0.1738], "workstation": null } ],
  "graph": { "derive": "auto", "aisleWidth": 0.06 },
  "validation": { "sampleStep": 0.005, "moverRadius": 0.02, "exemptSameStation": true },
  "regions": [], "entries": [] }
```

- **区域而非线条**：可行走性 = 可走区 − 障碍（带半径）；**导航图派生**（`studio/lib/scene/waypoints.js`）：
  `aisleWidth` 网格 + `moverRadius` 过滤 + 4 邻接连通（**按运行时采样器的 1/200 粒度**判定），
  标签优先级 = 声明 `regions` → 工位区（desk 艺术框外扩 `aisleWidth`，标 `work`）→ `roaming`；
  入口 = 声明 `entries`（可多入口）或自动取可走边界格；`components/isolated` 如实上报。
- **障碍与布局必须同步**：障碍由布局派生（`studio/lib/scene/zone-sync.js`），
  匹配按**几何**（id 两套词表：工位家具 `desk-N-role`、道具用 draft id），容差 `MATCH_TOLERANCE_PX=8` / `SIZE_TOLERANCE_PX=12`。
  本仓 `content/scenes/flat/zones.json` 的 32 条障碍与当前布局**逐字节一致**（测试锁定）；重建一键可做（试算 → 写入 → 自动备份）。

**冲突码（`studio/lib/scene/conflicts.js`；red = 阻断，yellow = 提示）**

| 码 | 级 | 触发 | 修法 |
|---|---|---|---|
| `SCENE_DRAFT_INVALID` | red | 草稿不满足 schema v1 | 修草稿 |
| `SCENE_WORKSTATION_INCOMPLETE` | red | 某工位缺 desk/monitor/character/chair（工位按**位置**派生，非 groupId） | 补齐 |
| `SCENE_WORKSTATION_FLOATING` | red | 座位在可行走区外 / 站在他人家具里（按**实际艺术框**判定占用）/ 离自己的桌子超过 `SUPPORT_RADIUS_RATIO=0.14`（≈118px）/ 附近无自由格 / **角色不属于任何工位** | 拖回工位或重建障碍 |
| `SCENE_WORKSTATION_UNREACHABLE` | red | 座位格无法到达任何入口 | 检查入口与通道 |
| `SCENE_FURNITURE_OVERLAP` | red（**两个不同工位**的家具相撞）/ yellow（道具叠放，如岛上放碗） | 艺术框相交面积 > `25px²` | 挪开 |
| `SCENE_ENTRY_BLOCKED` | red | 声明入口落在家具里 / 无自由格 / 孤立 | 挪入口或清通道 |
| `SCENE_EDGE_BLOCKED` | red | 派生边穿过**声明障碍**（用**运行时 `sampleEdgeConflicts`**、按 `zones.validation.moverRadius` 采样）→ 派生 bug 的守卫 | 修派生 |
| `SCENE_EDGE_CLEARANCE_TIGHT` | yellow | 边净距小于**运行时默认** mover radius（`MOVER_RADIUS_RATIO=0.04`） | 提高 `moverRadius` 或加宽通道 |
| `SCENE_OBSTACLE_UNDECLARED` | red | 家具有艺术框但没有对应障碍 → 走位会穿过去 | 重建障碍 |
| `SCENE_OBSTACLE_STALE` | red | 障碍对不上任何当前家具 → 绕开幽灵 | 重建障碍 |
| `SCENE_ITEM_OUT_OF_BOUNDS` | yellow | 艺术框越出逻辑画布 | 挪回 |
| `SCENE_ZONES_SPLIT` | yellow | 自由空间分成多个连通块 | 查封死通道 |

**语义对齐**：座位脚点投影与运行时编译器**逐像素一致**（测试用编译产物 `office-layout-flat.json` 的 desk 节点锁定）；
站号按**行优先**排序（`desk-1..N` 的既有词表），因此派生的障碍 id 与原文件相同。

## 5. 布局草稿 `content/scenes/<sceneId>/layout.json`

`{schemaVersion, scene, items:[{id, kind, asset, position:{x,y}, scale, direction, layer, groupId, locked?, hidden?, name?}], selectedId?, selectedIds?, groupNames?, rigidGroups?}`

- `asset` 是**素材目录 id**（`flat-desk`），方向由 `direction` 在族内换 id，`scale` 为等比缩放（**无旋转字段**：烘焙美术不得旋转）。
- 校验器：`src/workbench/lib/content-validator.js` + 布局 schema（P2 起 studio 内带 `layout-schema.js` 副本，主仓为准）。

## 6. 语料 `content/shared/dialogue/base.json` + `content/characters/<id>/dialogue/character.json`（P7 已实现）

```json
{ "schemaVersion": 1, "topics": { "greeting": [ { "id": "g-01", "text": "早", "weight": 3, "if": {"timeOfDay":"morning"} } ] } }
```

角色覆盖层：`{schemaVersion, characterId, overrides:{<topic>:[entry]}}`——**角色覆盖优先，缺失 topic 回落基础库**（`resolveTopic()`）。

**守卫（`studio/lib/dialogue/corpus.js::validateCorpus`，红＝拒绝保存；黄＝提醒 + 修法）**

| 码 | 级 | 触发 |
|---|---|---|
| `corpus.entry-id` / `corpus.entry-id-duplicate` | red | id 非 kebab-case，或在**同一文件内**重复（编辑器与守卫同规则：`addEntry` 整层查重） |
| `corpus.entry-text` | red | 空文本 |
| `corpus.weight` | red | 权重非整数或不在 [1, 20] |
| `corpus.replyTo` / `corpus.if-shape` | red | 引用/条件形状错误 |
| `corpus.text-identifier` / `corpus.text-path` / `corpus.text-secret-shape` | red | **隐私红线**：会话/run id、文件路径、密钥形状（形状扫描用 `scan.js`） |
| `corpus.text-long` | yellow | 超过 60 字（气泡读不完） |
| `corpus.text-duplicate` | yellow | 同文件内文本重复 |
| `corpus.placeholder-unknown` | yellow | `{xxx}` 不在白名单 `{name}{peer}{topic}{seat}{task}{count}` |
| `corpus.if-unknown-key` | yellow | `if.<key>` 不在运行时条件白名单（timeOfDay/peerActivity/taskActive/activity/phase/taskOutcome/scene/zone/weather）——真实语料里就有 1 条（`nearProp`） |
| `corpus.override-only-topic` | yellow | 角色层的 topic 在基础库没有对应项（不会回落） |

- CSV 导入：`id,topic,text,weight[,if.xxx]`，列序自由、大小写不敏感匹配、`if.` 后缀保留原样；引号与逗号安全。
- 抽签：`pickEntry({entries, seed, context})` —— 条件先过滤（未知键视为不约束）、权重决定分布、**同 seed 必然同结果**（面板/CLI 的"说一遍"用同一个实现）。
- 保存：红即拒（**文件字节不变、不产生备份**）、成功则**字节备份**、无变更 no-op；编辑器在**暂存阶段**就用同一守卫（红台词根本进不了文档）。
- 发布：`resources/dialogue/**` 是内容树的发布副本，测试锁定两者**逐字节一致**。

## 7. 素材护照 `content/characters/<id>/provenance/**`

五段链：**生成 generation → 抠像 matting → 归一化 normalize → 发布 publish → 在盘校验 on-disk**，
状态词表：`traceable | traceable-in-history | lost | not-recorded`（诚实规则：不能证明就写 `not-recorded`，绝不伪造）。

| 文件 | 段 | 谁写 |
|---|---|---|
| `provenance/generation/<actionId>.params.json` | 生成 | 生成链（P4）经 `studio/bin/provenance.js record` |
| `provenance/<ISO>-<actionId>.json` | 发布 | `action-publisher.publishAction` |
| `character.json.provenance` | 归一化/导出 | `workbench-export-character.js` |

生成参数台账（**P0 补上的断点**）：

```json
{ "schemaVersion": 1, "actionId": "walk-left",
  "records": [ { "recordedAt": "…", "kind": "image|video|frame-sheet", "provider": "dashscope",
                 "model": "qwen-image-edit", "promptHash": "<sha256>", "prompt": "<仅显式要求时存>",
                 "params": {…}, "seed": 42, "references": [{"path": "…", "sha256": "…"}],
                 "outputs": [{"path": "…", "sha256": "…"}], "command": "…", "tool": "…" } ] }
```

- 默认**只存 `promptHash`**（提示词是版本化资产，不是每次调用的流水）；`storePromptText: true` 才存原文。
- 追加写、不重写历史；`report()` 只有在台账存在**且**其 `outputs[].sha256` 能在盘上对上时，`generation` 段才 `traceable`。
- 出口规则：任何导出物（`.dshpack`/诊断包/报告）写盘前过 `studio/lib/scan.js`（`sk-` / `Bearer` / `token=` / cookie / key 赋值），命中即 **fail-closed**。

## 8. 项目 `project.json`（P1 已实现）

项目 = 文件夹。`project.json` 落在项目根，**声明各域在哪**（不强制新布局）：

```json
{ "schemaVersion": 1, "id": "whale-office", "label": "鲸鱼娘办公室", "kind": "scene-authoring",
  "createdAt": "2026-09-27T00:00:00.000Z",
  "layout": {
    "characters": [{ "id": "whale-girl", "path": "characters/whale-girl" }],
    "scenes":     [{ "id": "flat", "path": "scenes/flat" }],
    "graphs":     [],
    "dialogues":  ["shared/dialogue", "characters/whale-girl/dialogue"],
    "provenance": ["characters/whale-girl/provenance"]
  } }
```

- 本仓现存内容树**按原样被采纳**：`content/project.json` 就是上表（`content/` 即项目根）。
- 校验（`studio/lib/project.js`）：`schemaVersion===1`、`id` kebab-case、`label/kind` 非空、各域数组、
  内部相对路径（禁绝对路径与 `..`）；**声明了但盘上没有的路径会被如实报出**（`missingPaths`），不静默忽略。
- 工具产物（`build/`、`.DS_Store`、`*.tmp`、`*.log`）**永不入包**。

## 9. 资产包 `.dshpack`（P1 已实现）

zip 容器（自研最小实现 `studio/lib/zip.js`，`node:zlib`，无第三方依赖；写 65535 条上限、无 zip64、
固定时间戳），内含 `manifest.json` + 项目全部文件：

```json
{ "schemaVersion": 1, "kind": "scene-authoring", "id": "whale-office", "label": "鲸鱼娘办公室",
  "createdAt": "…", "studioVersion": "0.1.0",
  "layout": { …同 project.json… },
  "contents": { "files": 100, "totalBytes": 5800000, "bySuffix": {".png": 65, ".json": 20},
                "digest": "<内容 digest>", "counts": {"characters":1,"scenes":1,"actions":8,…} },
  "files": [ { "path": "characters/whale-girl/assets/…png", "bytes": 12345, "sha256": "…" } ] }
```

**三条性质（代码强制，测试锁定）**：

1. **内容派生**：`files[].sha256` 覆盖每个条目；`digest = sha256("path:sha256\n…")`（与时间/遍历顺序无关）。
   zip 时间戳固定 1980-01-01 → 同内容 + 同 `createdAt` ⇒ **包字节完全一致**。
2. **密钥形状 fail-closed**：文本条目（`.json/.md/.txt/.csv/.js/.css/.html/.svg`）导出前过 `scan.js`，
   命中即整包拒绝（`PACK_SECRET_SHAPE_REFUSED`，什么都不写，报告只含指纹）。
3. **友好失败**（稳定 code，面板/CLI 直接展示）：`PACK_FILE_MISSING` / `PACK_NOT_ARCHIVE` / `PACK_TRUNCATED` /
   `PACK_UNSAFE_PATH` / `PACK_MANIFEST_MISSING` / `PACK_MANIFEST_UNPARSEABLE` / `PACK_SCHEMA_UNSUPPORTED`（版本不匹配，
   先于哈希噪音报出）/ `PACK_PROBLEMS`（含 `pack.entry-missing`、`pack.entry-unexpected`、`pack.hash-mismatch`，
   每条都指名路径）/ `IMPORT_TARGET_NOT_EMPTY`（目标已有 `project.json`，需显式 `overwrite`）。
   任何一次校验不过 = **一个字节都不写**。

**往返不变量**（P1 验收）：真鲸鱼娘资产 `content/**` → 导出 → 导入 → 逐文件 `sha256` 与导出前 **完全相同**
（100 文件 / 5.5 MB；`beforeDigest === afterDigest`）。一键入口：面板「往返校验」按钮、
`node studio/bin/dshpack.js roundtrip`、`studioServices.packRoundTrip()`。

## 10. 流水线契约（P4）

| 段 | 输入 → 输出 | 缓存键包含 | 现状 |
|---|---|---|---|
| S0 参考图规范 | 参考 PNG → 事实（尺寸/绿幕占比/alpha/宽高比） | 参考图字节 | 本地可跑 |
| S1 三视图 | 参考图 → 转身基准图 | 参考图 + prompt 配方 + 模型 | **provider 门禁**：缺 key 即拒（计划可缓存） |
| S2 方向基准 | 三视图 → 四/两方向基准 | 同上 | 同上 |
| S3 动作生成 | 参考图 + 驱动视频 → 动作视频 | 同上 + 驱动视频 | 同上 |
| S4 抠像后处理 | 帧 → 清洗帧 | 帧字节 + 参数（顺序写死在代码里） | 本地可跑（见下） |
| S5 自动 QC | 帧/视频 → 红黄绿报告 + 修法 | 上游产物 + 阈值 | 本地可跑（帧 + ffmpeg 视频） |
| S6 归一化 | 清洗帧 → 规范帧 | 帧字节 + 目标高/鞋线/画布/锚点 | 本地可跑 |
| S7 alpha 视频 | 帧 → VP9-alpha WebM | 帧字节 + 编码参数 | 本地可跑 + **实测 alpha 平面**（见 §11） |
| S8 入包 | 规范帧 + QC 报告 → 包条目 + provenance | 上游 + 动作文档 | 本地可跑；**红灯报告在盘上即拒绝入包** |

- **缓存**：键 = `sha256(段名 | 工具版本 | 参数 | 每个输入的字节 sha256)`，数组输入逐元素按**内容**哈希；
  目录 `<项目>/.studio-cache/<段>-<段名>/<key>/`，条目含 `meta.json`（参数、输出 sha256、时间、chain）与产物副本；
  命中时**校验产物哈希**（被改过的条目算 miss）。命中/未命中只影响耗时，不影响结果。
  **参数按段过滤**：每段声明 `paramKeys`，键里只有它读的参数（改 `packCanvas` 只失效 S6 及其下游）。
  **命中即恢复链**：S4/S6 命中时其产物从缓存条目回到 ctx，下游键与当初逐字节一致（换进程第二次跑 = 零执行）。
- **编排**：QC 红灯 → 按 `FIX_TABLE` 改一个参数并**回退到修法所在的段**重跑（修法常不在报错那段上：QC 看见残留，抠像清掉它）；
  每个失败段最多 `1 + maxRetries` 次执行（默认 3 ⇒ 至多 4 次）→ 仍红则进**人工分诊队列**（带证据），
  下游段标记 `blocked` 不再运行，绝不无限重试、绝不静默放行。
  `plan`（只打印会跑哪些/哪些命中/为什么）与 `run` 走**同一个解析器**，plan 就是 run 的预告。
- **接收（intake）**：交付物进链前过门禁——命名（纯文件名，拒 `-x.mp4` 这类选项注入）、包含性（拒符号链接越界）、
  类型（视频 mp4/mov/webm/mkv、帧 png）、大小（视频 ≤64MiB/图像 ≤8MiB）、尺寸（短边 ≥240、长边 ≤4096）、
  时长/帧率（2–20s、12–60fps）。红项 ⇒ 挂分诊队列并停链。`lib/pipeline/intake.js` 与 `bin/agent.js` 共用同一套纯函数。
- **分诊队列**：`content/build/triage/<actionId>.triage.json`，两态 `open → resolved`（resolve 必须带 note）；
  同 (stage, code) 再失败长在同一条上；该关后来过了自动关闭（auto 注明）。CLI：`pipeline triage list|show|resolve`。
- **参数入账**：每次生成/转换调用落一份 `.params.json`（tool + toolVersion + agent + command + params + seed +
  inputs/outputs 的内容哈希 + 时间），同 tool+版本+参数+输入输出哈希的调用去重；
  **写盘前跑密钥形状扫描**（`sk-`/`Bearer`/`token=`/cookie…），命中即 `SECRET_SHAPE_REFUSED` 拒绝写盘。
  转换段产物落内容寻址暂存目录 `content/build/pipeline/<action>/<段>-<key前12位>/`（旧记录的输出哈希永远对得上自己那份字节）。
  详见 `studio/docs/generation-loop.md`。

### 10.1 抠像后处理的顺序（代码强制）

`unpremultiply → harden → removeNearBlack` 是**契约顺序**（brief §3），`studio/lib/pipeline/matting.js` 用 `STEP_ORDER` 写死并进缓存键。
第四个步骤 `trimBelowSoles` 排在三步之后：**在鞋线以下清空一切**——实测 gen-1 素材在鞋线下有 8–9 行 α≈102 的全宽水洗带，
逐像素的 halo 规则清不掉（每个像素都有邻居），只有"鞋线以下不留东西"能清干净。它只做减法：量到的鞋线不变，可见高只会**缩短**被水洗虚增的那几行。

### 10.2 视频 QC（ffmpeg）

`blackdetect=d=0.1:pix_th=0.10` · `freezedetect=n=-60dB:d=0.3` · `ffprobe` 读 codec/尺寸/fps/时长/帧数/像素格式；
可选期望：`{fps, durationSec, alpha, maxWidth}`。**没有 ffmpeg 时返回 `unavailable`**（不是 pass）。
**容器的 `alpha_mode=1` 标签不是证据**：S7 会解码一帧、数透明像素，只有真实存在才通过（本机 ffmpeg 会出现"标签说有、平面没有"的情况，见 §11）。

## 11. 视频轨（P5，2026-09-28）

- 编码配方（本机验证）：`-framerate F -i frame%04d.png -vf scale=W:H:flags=lanczos,format=yuva420p`
  `-c:v libvpx-vp9 -crf 40 -b:v 0 -pix_fmt yuva420p -r F -an out.webm`（640×360 / 24fps）。
- **alpha 必须解码验证**：容器标签会说谎（`alpha_mode=1` 可能没有对应平面），**ffmpeg 的默认解码器也会漏掉 alpha**——
  必须把 **libvpx 解码器显式指定为输入解码器**（`-c:v libvpx-vp9 -i clip.webm`）才能看见平面；
  Chromium（`studio/lib/pipeline/alpha-probe.js`，把视频画到 canvas 数 alpha）是**权威**，两者读数应完全一致。
- A/B（真行走循环，15 帧）：帧轨 1,028 KiB vs 视频轨 90 KiB → **11.5×**；两轨节奏都 60fps（抖动 ≤0.3ms）；
  alpha 两路读数一致（190,286 透明像素）。**判定**：帧轨仍是默认主轨（逐帧几何可测量、可门禁），
  视频轨用于"逐帧几何不是重点"的场合（高光动作、源本就是视频的动作）。
- 轨选择规则在 `studio/lib/video/action-video.js: planTrack()`（带理由），`bin/video.js plan/encode/probe/ab`。

## 12. 行为图 `.vgraph`（P6）

`{ schemaVersion: 1, id, meta, variables[], nodes[], edges[] }` —— **放在 `src/office/behavior-graph/`**，
工作台预览器与产品**引用同一份代码**（这是"工作台里调好的行为进程序一模一样"的结构保证）。

- **闭集**：节点类型（trigger/condition/wait/parallel/join/loop/subgraph/variable/action/dialogue/emotion/feel）、
  动作白名单（`walk.to`/`sit`/`stand`/`animation.set`/`video.play`/`bubble.show`/`task.accept`/`task.release`/
  `transition.start`/`transition.cancel`/`activity.set`）、比较运算（`== != < <= > >= exists in`）——未知值一律校验失败。
- **端口有类型**：每个节点声明端口（`flow`），`condition` 有 `true/false`，`loop` 有 `out/exit`（有界循环必须走 exit 收尾）。
  接错端口 = 校验失败（不是运行时惊喜）。
- **环检测**：允许的环必须经过 `wait`/`loop`/`trigger`（时间能推进）；裸环报错。
- **确定性**：时间来自 `tick(dtMs)`、随机来自注入 seed 的 `xmur3+mulberry32`（与 `behavior-scheduler.js` 同一对算法，
  测试锁定常量），节点状态**每个实例私有**（不共享调用方的对象）。同一 (图, seed, 事件脚本, dt 序列) ⇒ 轨迹/效果/变量完全一致。
- **纯模块**：无 DOM/Electron/文件系统/`Date.now()`；动作只产出**效果数据**（`{type, employeeId, target, resource...}`），
  由调用方（运行时适配器）施加。
- **调试**：`setBreakpoint`（token 被**停住而不是丢弃**，`resume()` 后结果与不打断完全一致）、`watch`、`trace()`、
  `state()`（含 `randomState`，可核对随机流）、事件注入、子图嵌套（效果带 `viaSubgraph`）。
- **差异报告**：`diff.diffStreams({scheduled, graphed})` 比较调度器与图在同一 seed/事件脚本下的活动流；
  调度器的 `continue`（"保持现状"哨兵）在归一化时丢弃，序列/直方图/节奏（最大时长差 > 容差）分别报告。

## 13. 预览运行器与诊断（P7）

- **真模块**：`studio/lib/preview/runner.js` 在主进程创建 `src/office/office-module.js`（产品的仿真本体），
  布局走产品解析链（`loadRuntimeLayoutFixture`），包用生产 pack。**没有 mock、没有重写**。
- **确定性**：逻辑时钟只按 `TICK_MS(16ms) × ticks` 前进；墙钟只决定 tick 频率。暂停/倍速/机器卡顿不改变结局
  （测试：同 seed 同脚本两遍逐字节一致）。
- **事件注入**：`inject({type, sessionId, seq, data})` → `ingestHarnessEvent`；脚本库 `SCENARIOS`
  （`task-complete` / `task-failed` / `approval-wait`）按逻辑时钟重放。
- **页面接线**：studio 入口把 `office:state` 从 boot 的空 stub 换成**运行器快照**，`office:dispatch/cancel/interrupt`
  映射到模块控制——预览 iframe 因此渲染真员工（页面侧 `window.__office.api.snapshot()` 可自证）。
- **诊断包**：`exportBundle()` 用产品脱敏器（结构化 `redactValue`）+ 出口形状扫描；字段
  `status/sync/scene/employees/queue/reservations/rootHandles/diagnostics/activityLog/settings`。
- **热重载与页面侧遥测已补**（P8 后半，见 §16）；仍**未做**：用行为图替换调度器行为（引擎变更）。

## 14. 图集打包（P8）

- 只打**被播放**的帧（`animation/animations.json` 的顺序即数据）；按 alpha 边界裁剪；确定性 shelf 排布；输出 PixiJS spritesheet JSON（含 `spriteSourceSize`/`sourceSize`/**`pivot`**/`outputAnchor`），保留原画布与包锚点，渲染方按旧方式摆位不会移位。
- 实测（deepseek-default，74 帧 / 17 动作）：图集 2043×2071，PNG 与散帧**体积持平**（1.04×），**纹理数 74 → 1**；**WebP 无损 3.54 MiB = 1.52× 更小**（Chromium 原生解码）——字节收益来自格式，不是来自"打成一个文件"。
- 入口：`studio/bin/atlas.js pack [--format png|webp]`；无 ffmpeg 时 WebP 分支给出稳定跳过码。
- **未接入运行时**：让 Pixi 用图集渲染属引擎侧改动，未做。

## 16. 工作台外壳（P8 后半）

- **命令面板 = 命令表**：`commands()` 表同时驱动面板与快捷键映射；过滤匹配 `标签 + id + 分组`，
  Enter 执行的是**选中项**（探针断言：⌘K 打开 → 过滤 `tab:` → ↓ 移动选中 → Enter 切到该标签并关闭）。
- **分栏宽度**：`WIDTH_LIMITS = {left:[200,460], right:[320,620]}`；拖动/方向键（Shift 大步）/双击复位；
  宽度与主题/语言/标签/收起状态同存 `localStorage['wb-shell-state-v1']`。界面偏好**不写内容树**。
- **键盘映射**：⌘/Ctrl+K·P 面板 · B 左栏 · J 右栏 · R 重读内容 · 1–0 切标签（`0` = 第 10 个）；
  Esc 关面板。标签条自身也响应 ←/→。
- **热重载**：主进程 `fs.watch(recursive)` 两个根（`content/**`、`resources/characters/deepseek-default/**`，
  跳过 `build/`），400ms 去抖后 `studio:content-changed` 推给窗口；渲染端重读面板。
  **绝不静默替换正在运行的仿真**：预览需手动「重开」，状态行明说。
- **页面遥测**：`studio:preview-telemetry` 由主进程注入的读取器在预览 iframe 内取事实
  （后端 / 画布 / 空闲 rAF / 页面布局源 / 员工数 / 诊断），可随诊断包导出（`rendererTelemetry` 字段），
  导出路径仍过脱敏与密钥形状扫描（探针：`hits: []`）。
- **结果行与状态行分离**：`#preview-scenario-result` 只承载"脚本跑完的结果"，
  `#preview-status` 是活信息（每次刷新重写）——两者混用会让结果被下一次刷新抹掉（真缺陷，已被探针锁死）。

## 17. 画布窗口与拖放（R1）

- **stage 契约**：世界尺寸 = 场景逻辑尺寸（`scene.json.logical`，1280×840）；`stageAnnounce()` 是唯一入口，
  场景草稿载入后调用。变换 = `translate(x,y) scale(z)`，`transform-origin: 0 0`；缩放范围 0.15–4；
  `stageFit()` = 居中 + 留 16px 边距。滚轮缩放以光标为锚点。
- **模式**：`edit`（布局层）| `run`（产品运行时层），写在 `#stage[data-mode]`；播放/单步/重开都会切到 `run` 再适应。
- **拖放路由表**（`handleStageDrop` / `DOCUMENT_TOOLS`）：
  | 拖入 | 去处 | 是否写内容 |
  |---|---|---|
  | 素材库家具（`application/x-wb-furniture`） | 场景布局 `add` | **是**（试算 → 写，先备份） |
  | 动作帧 PNG（`assets/actions/<id>/…`） | 动作检查（选中该动作） | 否 |
  | `scenes/<id>/{layout,scene,zones}.json` | 场景工具 | 否 |
  | `graphs/*.vgraph.json` | 行为图（选中该文件） | 否 |
  | `actions/*.json` · `dialogue/*.{json,csv}` · `character.json` · `project.json` | 对应工具 | 否 |
  | 其它 | 拒绝：`DROP_UNSUPPORTED` + 可拖类型清单 | 否 |
- **场景事务新增两种编辑**（`studio/lib/scene/edit.js`）：`{add:{kind,asset,direction,layer,position,scale?}}`
  与 `{itemId, remove:true}`。新条目 id 沿用文件自身的 `draft-<n>` 约定（取现有最大号 +1），
  `groupId` = 自身 id，`layer` 默认 30；删除会同时清理 `groupNames/rigidGroups/selectedId/selectedIds` 里的悬挂引用。
  **试算也会返回 `applied`**，这样调用方在写盘前就知道新条目的 id。
- **`sceneFurniture()`**：产品 catalog（`src/office/layout-assets.js`）→ 拖放调色板行
  `{asset, kind, label, direction, file, url}`；`url` 与画布同一套解析（`./office-assets/flat/x.png` →
  `workbench://local/preview/office-assets/flat/x.png`）。目录缺失时返回 `SCENE_CATALOG_MISSING`，不抛异常。

## 18. 运行推送与草稿帧（R2-A）

- **推送契约**：`previewSubscribe(listener)`（`studioServices`，返回 `{ok, unsubscribe}`）→ 主进程订阅 →
  `sendToFrame([pid, rid], 'office:state', snapshot)`。节流由 runner 内部负责（`SNAPSHOT_PUSH_MS = 100`）。
  快照形状＝产品 `office.state()`（`schemaVersion/simulatedAtMs/employees/…`），与页面 `applySnapshot` 期望一致。
- **帧寻址**：窗口内可能有 `[4,1]`（外壳）、`[4,4]`（草稿，`pack=wb-staged`）、`[4,5]`（运行，`pack=deepseek-default`）。
  `officeFrame()` = 非 staged 的那个；`benchFrame()` = staged 的那个。
- **草稿包协议**：`preview/characters/wb-staged/**` → 先查 `content/build/preview-pack/**`，再查
  `content/characters/<id>/assets/**`（导入未发布的帧），都没有则回落 `resources/characters/<pack>/**`；
  路径含 `..` 一律拒绝。生产包路径**不再**有暂存覆盖。
- **动作预览写入方式**：`api.applySnapshotManually(snapshot)` —— 只作用于渲染器，不改页面级 `latestSnapshot`；
  因此真壳探针用**外壳的播放读数**（`#action-playback` 出现"播放中"＝`pushPuppet()` 返回过 true）作为"写入落地"的证据，
  而不是读 `api.snapshot()`。

## 19. 页面与码头（R2-B2）

- **页面**：`PAGES = ['scene','animation','behaviour','dialogue','quality','observe']`；`body[data-page]` 是唯一开关。
  页面容器 `#page-view-<page>`（`data-page-view`），`hidden` 由 `setPage()` 维护；画布页面的容器是空的（工作区归 `#stage`）。
- **子视图 chips**：十个 `#tab-x.wb-tab[data-page]` 全部保留；CSS 只显示当前页的 chips。
  质检页有四个（素材校验/几何报表/视觉基线/素材溯源），动作页两个（动作/动作检查）。
- **码头**：`#wb-dock` 包着 `#stage`；`body:not([data-page="scene"|"observe"]) #wb-dock { flex: 0 0 26vh; min-height: 170px }`。
  切页**零 IPC、零重载**——画面不因导航而丢。
- **降噪约定**（T12）：UI 里不留"教学长句"常驻文案（改 title/空态）；障碍在编辑画布上是 1px 描边不填充；
  校验结果按代码聚合（`src/workbench/app/problems.js`：`set(source, findings)` → `groups` 按 (source,code,severity) 分组，
  severity 归一化 red/yellow/note，`summaryLine()` 给状态栏直接可用的一行）。

## 20. 撤销/重做与会话草稿（R2-C）

- **撤销栈是快照式的**（`app/history.js`）：`push({label, before, after, meta})`，`before/after` 是**整稿快照**
  （`sceneSnapshot()` = 每件的 id/kind/asset/direction/layer/hidden/position/scale）。上限 50，redo 分支在新 push 时清空。
- **回放 = 一次编辑**：`restoreScene(snapshot)` 先把快照与当前草稿做差集（改动 / {add} / {remove}），
  再走 `sceneEdit`（`save:false` 试算 → 校验 → `save:true` 写）。**撤销不许绕过校验器**。
- **写盘不是字节拷贝**：事务写文件一律重新序列化（缩进与键序保留）。字节拷贝是**备份**的保证，
  所以"撤销后逐字节相同"不是契约，"**解析后逐条相同**"才是。
- **记录点**：`rememberScene(label)` 必须在**写之前**调用（它捕获 before），返回的 commit 在写成功后调用。
  目前接了三个写入口：保存布局、放进家具、删除物件。
- **会话草稿**（`app/store.js`）：域 `scene/graph/dialogue/action`；`scene.pending` 是未保存改动的数组
  （Map 不能序列化，写入前转数组）。`restore()` 必须**在启动时**调用一次，否则 `get()` 永远返回默认值。
  脏标记只存在于内存；`clean(domain)` 在保存成功后调用；热重载刷新前先问 `dirty().any`——脏则跳过并提示。
- **探针纪律（写死在这里）**：会写内容的探针必须（a）在第一次写之前记录目标文件的字节，
  （b）结束时**无条件**按基线还原，（c）失败路径也要还原（`contentBaseline` 登记表）。
  "用最新备份还原"是错的——最新备份可能已经不是干净状态。

## 21. 生成交接（R5）

- **主路径**：生成由**用户的 AI 代理**完成（工作台不持有视频 key、不绑定模型协议）；
  工作台只负责**给配方 → 收交付 → 校验 → 接着做**。
- **配方来源**：`buildPromptPlan`（`studio/lib/pipeline/stages.js`）—— 护栏/分秒节拍/负面词都在这里；
  `node bin/agent.js prompts` 把它组装成一段可照抄的提示词；
  `studio/skills/workbench/reference/generation-handoff.md` 由同一个来源生成（测试比对，防漂移）。
- **交付契约**：纯绿幕原片、固定机位、无纵深措辞、双脚锁锚点、首尾同站姿、道具闭环、四周 ≥10% 边距、
  640×360 级 ~24fps 10 秒级；放在 `content/incoming/<动作>/`（gitignore）。
- **接收**：`node bin/agent.js intake` 探测 spec + 分析首尾帧（绿幕占比 / 主体占比 / 边距 / 脚线），
  红项即退出码 1 且**不算接收**；通过则把生成参数写入素材台账
  `content/characters/<id>/provenance/generation/<action>.params.json`（`source: agent-intake`），
  接收记录写 `content/build/intake/<action>.json`。
- **备用路径**：在工作台内直连 provider（模型↔key 严格对应，缺 key 即拒）仍然可用，见 `providers.md`。

## 15. 执行者索引（谁校验什么）

| 契约 | 执行者 |
|---|---|
| 动作文档字段/时长/帧序 | `src/workbench/lib/action-model.js`（`parseActionDoc` / 发布校验） |
| 帧几何（鞋线 ±1、可见高 ±2、防裁剪） | `src/workbench/lib/character-geometry.js` + `action-publisher` |
| 导入归一化（等比缩放 + 整数平移，不改美术） | `src/workbench/lib/normalizer.js` |
| 布局草稿 schema v1 | `src/workbench/lib/content-validator.js`（P2 起 + studio 的 `layout-schema.js` 副本） |
| 包完整性（缺帧 / 键序 / 锚点） | `scripts/office-assets/validate-character-pack.js`（发布门禁） |
| 项目声明与文件清单 | `studio/lib/project.js` |
| `.dshpack` 容器 / 清单 / 往返 | `studio/lib/dshpack.js` + `studio/lib/zip.js` |
| 护照五段链 | `studio/lib/provenance.js` |
| 导出密钥形状 | `studio/lib/scan.js` |
| 帧 QC（鞋线/高度/抖屏/水洗/边距/重帧/跳帧） | `studio/lib/pipeline/qc-frames.js` |
| 视频 QC（黑帧/冻结/alpha/时长/fps） | `studio/lib/pipeline/qc-video.js` |
| 抠像后处理顺序 | `studio/lib/pipeline/matting.js`（`STEP_ORDER`） |
| 阶段缓存与编排 | `studio/lib/pipeline/{cache,orchestrate,stages}.js` |
| 模型↔密钥门禁 | `studio/lib/providers.js` |
| 行为图校验 / 解释器 / 差异 | `src/office/behavior-graph/{schema,interpreter,diff}.js`（产品可复用） |
| 手感参数（挤压/镜像/淡入/位移） | `src/office/behavior-graph/feel.js` |
| 视频轨编码与 alpha 验证 | `studio/lib/video/action-video.js` + `studio/lib/pipeline/alpha-probe.js` |
| v2 元数据随包发布 | `scripts/office-assets/validate-character-pack.js` + `src/workbench/lib/action-publisher.js` |
| 预览仿真与诊断包 | `studio/lib/preview/runner.js`（真 office 模块） |
| 语料两层的读写/守卫/CSV/抽签 | `studio/lib/dialogue/corpus.js` |
| 图集打包与清单 | `studio/lib/atlas/pack.js` |
| 浅/深主题对比度 | `studio/test/contrast.test.js`（解析真实 CSS 变量算 WCAG） |
| 双语键集等价 | `src/workbench/i18n.js` 字典 + `studio/test/i18n.test.js`（解析字典与 HTML/JS 两侧引用） |
| 命令表 / 分栏 / 快捷键 / 热重载 / 遥测 | `src/workbench/workbench.js` + `studio/main.js`（真壳探针断言） |
| 内容变化的字节无侵入 | `studio/main.js` 的 P8 探针（写回原字节 → 状态行变化 + sha256 不变） |
| 画布视图（适应/缩放/平移/复位） | `src/workbench/workbench.js` 的 `stage*` 函数 + R1 真壳探针 |
| 页面清单与码头高度 | `src/workbench/workbench.js` 的 `PAGES`/`setPage` + `workbench.css` 的 `body[data-page]` 规则 |
| 问题聚合（按代码） | `src/workbench/app/problems.js` + `studio/test/problems.test.js` |
| 撤销栈 / 会话存储 | `src/workbench/app/history.js`（11 测）· `src/workbench/app/store.js`（18 测）+ 渲染端的 `rememberScene`/`persistSceneDraft` |
| 运行推送 / 帧寻址 / 草稿包隔离 | `studio/lib/preview/runner.js`（推送条件）+ `studio/main.js`（订阅与投递）+ `src/workbench/app/{services,boot}.js` |
| 拖放路由与"放进布局" | `handleStageDrop` / `stageDropFurniture` + `studio/lib/scene/edit.js`（add/remove） |
| 家具调色板 | `studio/lib/studio-services.js` 的 `sceneFurniture()` |
