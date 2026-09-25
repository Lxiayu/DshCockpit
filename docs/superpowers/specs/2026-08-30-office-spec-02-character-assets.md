# Office SPEC-02：角色资产、校准与安装

> 本分册只定义可验证的角色包，不定义角色行为或办公室布局。DeepSeek 娘和社区角色必须能脱离 Core 单独安装、禁用和回退。
>
> Status: Draft

## 目标与非目标

目标是把 PNG 资产归一化为共享画布、共享脚底锚点和声明式动画 metadata，并提供安全安装、验证和 fallback。非目标：在代码中补帧、用 CSS 修正漂移、把某个角色硬编码进 Runtime、v1 强制使用 Atlas、GitHub 下载或执行包内脚本。

## 前置阅读、允许修改与禁止修改

先读 handoff、索引、plan、`character-animation-architecture.md`、`character-asset-spec.md` 和 `OFFICE-ASSETS.md`。允许修改 `scripts/office-assets/normalize-character.py`、`validate-character-pack.js`、`src/office/runtime/character-pack-installer.js`、fixture 角色包、测试和本分册。未经用户明确批准不得覆盖 `photo/` 或现有原始素材；`resources/characters/whale-girl` 只读作输入 fixture。

## 输入/输出契约：包目录与 schema

```text
pack/
  manifest.json
  animation/anchors.json
  animation/animations.json
  assets/animations/<state>/<direction>/<frame>.png
  assets/expressions/<state>.png
  LICENSE
  NOTICE
```

`manifest.json` 最小字段为：`schemaVersion=1`、`id`、`version`、`author`、`license`、`runtimeCompatibility`、`geometry`、`animations`、`fallback`。`anchors.json` 是几何唯一来源；`animations.json` 是帧顺序/时长唯一来源。重复 inline 字段、未知顶层字段或路径绝对化均拒绝。

每个动画声明：`state`、`direction`（可为 `none`）、`frames[]`、`loop`、`defaultFrameDurationMs`。帧项为 `{file,durationMs|null,visibleBounds,anchor}`，但 `visibleBounds/anchor` 必须与 anchors report 一致，冲突即 `PACK_GEOMETRY_CONFLICT`。

## 几何与质量契约

归一化记录 `sourceCanvas/outputCanvas/outputScale/sourceAnchor/outputAnchor/visibleBounds`。透明边界使用固定 alpha 阈值；所有帧输出同一画布，禁止 trim/rotate。四方向脚底误差必须 `<=1px`，可见高度由 `clamp(64px, sceneHeight*0.11, 180px)` 决定，不能按透明画布尺寸直接缩放。每个状态都使用同一 foot anchor；无法对齐的素材退回美术，不在 Runtime 加单帧偏移。

v1 默认 `frameDurationMs=1000`，帧时钟与移动更新独立；未来可用 Atlas，但必须保留归一化帧坐标，且 Playground 先通过。

## 校准工具与安装安全

`normalize-character.py` 使用 Pillow 11.3.0 或兼容的已记录版本，输出 PNG、metadata 和不可由 Runtime 改写的 `validation-report.json`。`validate-character-pack.js` 不执行包内容，检查 schema、license、路径、PNG 解码尺寸/像素上限、alpha、anchor、trim/rotate、必需状态和 fallback。

导入状态：`discovered -> validated -> installed -> active`。文件夹/ZIP 先进入临时目录；拒绝 `..` 穿越、绝对路径、symlink/hardlink、ZIP bomb、单文件/总解压超限、可执行扩展名和 manifest 外文件。验证后使用同文件系统原子 rename；失败保留旧 active 版本并返回稳定错误码。安装器不能调用网络。

## Fallback 与错误码

包级失败禁用整包：`PACK_MANIFEST_INVALID`、`PACK_GEOMETRY_INVALID`、`PACK_GEOMETRY_CONFLICT`、`PACK_ASSET_MISSING`、`PACK_ASSET_TOO_LARGE`、`PACK_UNSAFE_ARCHIVE`、`PACK_LOAD_FAILED`。可选状态缺失仅为 `ANIMATION_CAPABILITY_MISSING`。加载顺序：用户 active 包 -> 固定版本 `resources/characters/deepseek-default/` -> 诊断 placeholder Sprite；任何一步都要在 diagnostics 中标明来源和错误，不得静默空白。

## 实现步骤与测试

1. 写失败测试：alpha 边界、统一画布、anchor `±1px`、schema 冲突、license、恶意 ZIP、原子安装、fallback 和报告不可变。
2. 运行 `node --test test/office-asset-pack.test.js test/office-character-pack-installer.test.js`，预期缺少实现而失败。
3. 实现 normalizer、validator、installer；先处理临时目录和安全限制，再处理 rename。
4. 运行 `python3 scripts/office-assets/normalize-character.py <input> --out <fixture>`，再运行 `node scripts/office-assets/validate-character-pack.js <fixture>` 和 focused tests。
5. 人工在 Playground 检查 Contact/Passing/重心；自然度不合格时记录素材缺口，禁止代码补偿。

## 验收、交付与停止条件

验收必须有 passed validation report、恶意输入拒绝证据、失败更新保留旧版本证据和 fallback 截图。交付报告列出输入资产（不复制原图）、输出包版本、anchor 统计、错误码、测试命令/结果和未通过帧。

发现素材版权不明、输出画布不一致、脚底误差超限、包包含可执行内容或安装会覆盖用户文件时立即停止并请求主代理处理；不得删除或重写原始素材。

### 交接报告

必须说明输入资产来源、输出包路径/版本、validation report、安装安全测试和 fallback 证据；不要把原始图片复制进报告。
