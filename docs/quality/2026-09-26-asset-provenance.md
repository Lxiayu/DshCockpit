# 素材复现链归档（2026-09-26）

- 交付物：`scripts/asset-provenance.js`（CLI）+ `docs/strategy/2026-09-26-asset-provenance-index.json`（机读索引，CLI 生成）+ 本文档
- 定位：**只记录来源链与校验方法**，不重复在用判定。在用/孤儿/引用完整性见
  `docs/strategy/2026-09-22-assets-in-use.md`（2026-09-22 审计）；本 CLI 的 `verify`
  子命令把该文档 §5 的"反向缺口"方法固化为可重跑命令。
- 原则：跑不出来的环节如实标 `lost` / `not-recorded` / `traceable-in-history`，
  每个断点给找回锚点（git 提交 / s1 只读参照），**运行时用 `git cat-file` 复核**，
  绝不凭登记表断言"可复现"。

---

## 1. 用法

```bash
node scripts/asset-provenance.js report walk-up        # 角色动作：帧/几何/哈希/台账/链条
node scripts/asset-provenance.js report working-back
node scripts/asset-provenance.js report flat-desk      # 办公室贴图（catalog id）
node scripts/asset-provenance.js report prop-plant
node scripts/asset-provenance.js verify                # 全量在盘校验（pack 校验器+引用完整性+镜像比对）
node scripts/asset-provenance.js verify --json
node scripts/asset-provenance.js index                 # 重建 JSON 索引
node scripts/asset-provenance.js lost                  # 已知链断点清单（含 git 复核结果）
```

## 2. 链模型（五段）

| 段 | 角色 action | 办公室贴图 | 现状 |
|---|---|---|---|
| 1 生成 | `gen-img.js` / `gen-frames.js`（生图 API；key 只从 env 读，绝不打印） | `gen-props.js`（根目录道具）；flat/ 与 layout-editor/ **无脚本记录** | 工具在 P5-2 清出主仓（`ebf8e59`），git 44ed956 可找回；**逐资产调用参数从未入账** |
| 2 抠像 | `scripts/remove-bg.py`（在盘） | —（记录在 catalog 注释） | ✅ 可回溯 |
| 3 归一化 | `scripts/office-assets/normalize-character.py`（SPEC-02 整包归一化器，常量在脚本头） | contentBbox 由 catalog 实测记录（±0.002 测试锁） | ✅ 可回溯（逐帧几何以 anchors.json 为权威） |
| 4 发布 | `src/workbench/lib/action-publisher.js` `publishAction()`（唯一写生产字节路径）→ provenance 台账 + backup | `src/office/layout-assets.js` catalog 登记 | 发布内核在 P5 清出主仓（`2041757`）；**台账 9 条全在**（content/characters/whale-girl/provenance/） |
| 5 校验 | `src/office/runtime/validate-character-pack.js` + 本 CLI verify | 本 CLI verify + catalog 断言测试 | ✅ 现役 |

台账 9 条的 backup：1 条在主仓 `content/build/backups/2026-09-22T14-50-55-684Z`
（working-back），8 条记录的绝对路径在 **s1 仓**（`backupDir` 是当年仓地址）——
本 CLI 只读核对可达性（全部可达），**绝不写 s1**。

## 3. 无法回溯清单（本次盘点如实暴露）

1. **发布内核主仓缺失**：`src/workbench/lib/action-publisher.js` 已随 P5 清出
   （`2041757`）。当前主仓**无法重跑发布链**；找回锚点：
   `git show 2041757^:src/workbench/lib/action-publisher.js`（已复核存在）或
   `DshCockpit-s1/src/workbench/lib/`（只读）。
2. **生成工具主仓缺失**：`gen-img.js` / `gen-frames.js` / `gen-props.js` /
   `apply-walk-sequence.js`（`ebf8e59` 清出，git 44ed956 已复核可找回）。
   影响：expressions、两代 walk 帧、根目录 prop-*.png 的再生成要先找回工具。
3. **逐资产生成参数从未记录**（17 个角色动作全部）：单次生图调用的
   `--action/--grid/--ref/--start-index/prompt` 没有任何台账；脚本头注只记录
   调用形态。二代 walk b 系列（2026-09-21）只知道"再生成于该日"（台账时间戳），
   不知道提示词与参考图组合。**这是素材级复现的真实断点。**
4. **flat/ 平面贴图与 layout-editor/ 等轴贴图来源未记录**（23 张 flat + 24 张
   等轴，另加 4 张编辑器起草用角色图跟随 catalog）：无生成脚本、无作者/原图/
   批次台账；catalog 只记了批次标签（v6–v11）与实测 contentBbox。这 51 条的
   "生成"环节 = `not-recorded`（机读索引 lostChainSummary 逐条可查）。
5. **早期动作（idle/error/finished 等 expressions）无 publish 台账**：早于 M1
   发布内核，是原始归一化产物直接在盘；链上只有"生成→抠像→归一化"三段可回溯。

## 4. 怎么证明"跑的就是这一份"

- **角色帧**：运行时经 `office-protocol` 的 `characters/` 路由从
  `resources/characters/deepseek-default`（打包后 `process.resourcesPath`）读取；
  `asset-pack.js` 只认 `animations.json`（帧/时序）与 `anchors.json`（几何）。
  校验 = 把部署目录帧文件的 sha256 与 `report <id>` / 索引逐条比对；绕过发布链
  的手改会暴露为 `content.mirror` 不一致或台账缺失。
- **办公室贴图**：`office-assets/` 路由到 `resources/office`；catalog
  （`layout-assets.js`）与在盘文件一一对应由 catalog 测试钉住；校验 = 部署文件
  sha256 与 `report <id>` 比对 + `verify` 的反向缺口检查（引用了但缺失 = 立刻红）。
- 打包产物的核对：对 `dist/**/resources/{characters,office}` 内文件跑同一组
  sha256（`verify` 的哈希表即基准）。

## 5. 索引规模（2026-09-26 生成）

- 角色动作 17 个（74 播放帧全带 sha256 + outputAnchor）
- 办公室贴图 active 37 / archived 24（全部带 sha256；57/57 在盘，0 反向缺口）
- 链断点登记：`not-recorded` 51 条（23 张 flat + 24 张等轴 + 4 张起草角色图，均 office-texture）、
  `traceable-in-history` 44 条（生成 27 = 17 动作 + 10 根目录道具；发布 17 = 17 动作，git 复核可找回）
- `verify` 全绿：pack 校验器 ok、gaps 0、content↔pack 镜像 8 动作逐字节一致

## 6. 边界

- 本 CLI 与索引是**只读**工具：对主仓只写 `--out` 指定的索引文件；对 s1 零写入。
- git 复核只在主仓历史内做（`git cat-file -e`），不访问网络，不访问 s1 的 git。
- 与 assets-in-use 审计的分工：该文档回答"哪些在用/哪些孤儿"；本工具回答
  "在用的这份从哪来、怎么证明现在跑的就是它"。

---

*执行：2026-09-26，只读盘点 + 工具落地。未 commit、未删改任何素材字节、未写 s1。*
