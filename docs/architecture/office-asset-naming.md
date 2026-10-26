# 办公室素材接入规范（平面 2D，现行）

> 状态：**现行约定**（2026-10-27 从 s1 时代编辑器笔记中提取并升级为活跃文档）。
> 动机：`test/office-asset-runtime.test.js` 的 E2e / E3a 两条门禁要校验"文档承诺 = 目录现实"，
> 而被校验的原文在 `docs/archive/`（本地保险箱，不入库）——门禁在 CI 上会静默跳过。
> 因此把**规则**提到这里，测试直接读本文件；完整的编辑器操作说明仍留在本地归档
> `docs/archive/notes/office-editor.md`（历史记录，含 E4.6 退役说明）。

## 1. 单一声明面

图片放 `resources/office/`，声明只改一个地方：`src/office/layout-assets.js`。
**禁止**引用 `fixtures/`、`photo/`、构建产物或绝对路径。

## 2. 两种形态

### 2.1 单图道具（当前主形态）

- 文件：`resources/office/prop-<name>.png`（生产面）。
- 声明：`environmentPropAssets` 表加一行（`id` / 中文标签 / 遮挡说明）。
- 方向字段固定 `'none'`；`parseDraft` 拒绝其他值（单图道具不提供方向切换）。

### 2.2 方向型道具（8 方向；E4.6 起为**归档保留**）

- 文件：`resources/office/layout-editor/prop-<kind>-<direction>.png`，8 方向齐全即自动入列。
- 该家族已从素材栏退役（`ARCHIVED_LAYOUT_ASSETS`，24 条）：文件保留、`layoutAssetById` 仍可解析，
  等距兜底渲染与旧草稿导入不受影响。
- 新增方向型 kind 时：`KIND_LABELS` 加 `<kind>: '中文标签'`，并把 kind 加进 `DIRECTIONAL_KINDS`。

## 3. 平面试点（`flat/` 命名空间）

- 文件放 `resources/office/flat/`，文件名与 `photo/` 源一致（如 `prop-desk-front.png`）。
- 在 `layout-assets.js` 的 `flatFurnitureAssets` 表注册；id 用 `flat-<名>`。
- 现有试点：`flat-desk`（桌子·平面）、`flat-monitor`（显示器·平面）、`flat-chair`（椅子·平面·背视）。
- 每个 `flat-*` 条目声明 `contentBbox`（PNG 内不透明区域的归一化包围盒，按 alpha 阈值 8 实测一次）；
  渲染器只裁剪边距，**不改 PNG 字节**。

## 4. 场景与深度

- 逻辑场景 **1280×840**，归一化坐标 `[0,1]` 与之对应；运行时等比 letterbox 居中。
- 地面线约在画面高度 **35%** 处。
- **layer 即深度：数值越大越靠前**（back → front）；编辑器按 `(layer, 数组顺序)` 绘制。
- 分层带宽：**家具 20–40、角色 45、前景 50+**。内置默认值：monitor 10 / chair 20 / prop 25 /
  character 30 / desk 40（`DEFAULT_LAYER_BY_KIND`）；新素材不得自造带宽外的默认值。

## 5. 校验

| 门禁 | 断言 |
|---|---|
| `test/office-asset-runtime.test.js` E2e | 本文的命名/目录/声明面/场景尺寸/深度语义与 catalog 现实一致 |
| 同上 E3a | `flat/` 命名空间与 `flat-*` id 的文件全部存在 |
| 同上 E3d | `contentBbox` 与新测量的 alpha 包围盒一致（防漂移） |

改名或新增规则时：**先改本文件，再改测试与 catalog**（测试读本文，跑一次就知道是否同步）。
