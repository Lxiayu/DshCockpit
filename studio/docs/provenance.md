# 素材复现链（asset provenance）— studio 模块

`studio/lib/provenance.js`（引擎，纯 Node）+ `studio/bin/provenance.js`（CLI）。
移植自主仓 `DshCockpit/scripts/asset-provenance.js`，按 s1 的真实树改写，并**补上主仓的最大缺口**：
segment 1「生成调用参数」在主仓里从未被记录在任何地方。

回答一个问题：**这一帧/这张贴图从哪来、怎么变成现在这份，能不能复现。**

---

## 1. 五段链（五 segment）

| # | segment | 权威 / 证据来源 | s1 里的位置 |
|---|---------|----------------|-------------|
| 1 | `generation` 生成 | 逐动作参数台账 `.params.json`（本模块新增） | `content/characters/<id>/provenance/generation/<actionId>.params.json` |
| 2 | `matting` 抠像 | 脚本在盘 + git 历史复核（逐次调用参数 = 脚本常量） | `scripts/remove-bg.py`、`photo/video-matting-kit/`（只读） |
| 3 | `normalize` 归一化 | 归一化工具在盘 + 几何/帧序权威 | `scripts/office-assets/normalize-character.py`、`resources/characters/<pack>/animation/anchors.json`（几何唯一权威）、`animations.json`（帧/时序唯一权威） |
| 4 | `publish` 发布 | 发布台账（只追加）+ 发布内核在盘 | `content/characters/whale-girl/provenance/<ISO>-<actionId>.json`、`src/workbench/lib/action-publisher.js`；办公室资产 = `src/office/layout-assets.js` 目录表（权威，只读不改） |
| 5 | `on-disk` 在盘校验 | 帧/贴图存在性 + sha256 + anchors 覆盖 + content↔pack 镜像比对 | `resources/characters/deepseek-default/**`、`resources/office/**` |

每个 segment 的判定是**事实核查**：工具/文件在盘 → `traceable`；不在盘但 git 历史里提交过 → `traceable-in-history`；都不行 → `lost`。git 复核用 `execFileSync('git', ['-C', root, ...])`（显式数组参数，绝不拼 shell），git 不可用时按"无法复核"处理，**不假装能找回**。

## 2. 四种状态（`STATUSES`，除此之外引擎不会输出别的词）

```
traceable | traceable-in-history | lost | not-recorded
```

- `traceable`：链路当前可复现（台账/权威/字节对得上）。
- `traceable-in-history`：只能从历史证明"跑过一次"，当前字节未必是那次调用的产物。
  例：台账在但 `outputs[].sha256` 对不上任何在盘字节；或台账缺失而**发布台账**证明该动作被重发布过。
- `lost`：在盘、git 历史都找不到（文件缺失、工具被删且历史里也没有）。
- `not-recorded`：没有任何记录能证明这环节发生过（例如 `flat/` 平面贴图没有生成器、某动作没有发布台账条目）。

`report()` 的 `reproducible` 是红绿灯汇总：任一段 `lost` 或任一 red finding → `red`；有 `traceable-in-history`/`not-recorded` 或 yellow finding → `yellow`；全绿 → `green`。
`verify()` 的 `status` 列是"该资产五段链的最差值"（`lost > not-recorded > traceable-in-history > traceable`）——**任何一段跑不出来就把整条链降级，绝不挑最好的一段报喜**。

## 3. `.params.json` 台账（本模块关掉的缺口）

位置（`PARAMS_DIR_RELATIVE = 'provenance/generation'`）：

```
content/characters/<characterId>/provenance/generation/<actionId>.params.json
```

形状（`schemaVersion: 1`，`records` 只追加，绝不改写既有记录）：

```json
{
  "schemaVersion": 1,
  "actionId": "walk-left",
  "records": [
    {
      "recordedAt": "2026-09-27T15:00:00.000Z",
      "kind": "frame-sheet",
      "provider": "openai-compatible",
      "model": "gpt-image-2",
      "promptHash": "…sha256 of the prompt text…",
      "params": { "grid": "3x1", "mode": "edit", "tolerance": 15 },
      "seed": 4242,
      "inputs":    [{ "path": "photo/output/walk-left-01.png", "sha256": "…", "role": "source-frames" }],
      "outputs":   [{ "path": "resources/characters/deepseek-default/assets/animations/walk/left/walk-left-b01.png", "sha256": "…", "role": "cleaned-frames" }],
      "command": "node studio/bin/pipeline.js run walk-left --only S6 --params {\"footLine\":296}",
      "tool": "studio/lib/pipeline/stages.js#S6",
      "toolVersion": "dsh-studio@0.1.0",
      "agent": "codex-cli"
    }
  ]
}
```

- `kind` ∈ `image | video | frame-sheet`。
- **R4 补的入账维度**：`toolVersion`（工具名会腐烂，版本才能比）、`agent`（执行者身份，
  `--agent` / `STUDIO_AGENT_ID`，默认 `studio-cli`）、`inputs`（输入文件哈希，`role` 说明角色；
  老调用方只给 `references`，读取侧按 `inputs || references` 取）、`command`（**一键复现命令**，
  `report` 原样打印）。`lib/pipeline/params.js` 的 `REQUIRED_CALL_FIELDS` 把这套字段定为必备，缺一即拒。
- **提示词默认只存 sha256**（`promptHash`）。原文只有在调用方显式传 `{ storePromptText: true }`（CLI `--store-prompt-text`）时才落盘。
  理由（提示词库卫生）：提示词是**被版本化的资产**，属于 `scripts/gen-frames.js` 的 `ACTION_PHRASES`/提示词库那一层；逐次调用重复抄全文会让台账变成噪声，也会把提示词从它真正的编辑点稀释出去。哈希足够回答"这次用的是哪一版提示词"——比对时重算哈希即可；真要原文，去提示词库里按哈希找回。
- `inputs`/`outputs`/`references` 只给 `path` 时，引擎会**当场算哈希**（文件不存在就不写哈希，绝不编）；
  `lib/pipeline/params.js` 的更严：只给路径而文件不在 ⇒ **拒绝入账**（一次调用不可能消耗不存在的字节）。
  相对路径按 `process.cwd()` 解析，绝对路径原样记录。
- `writeParamsRecord` 追加、自动建目录，返回 `{ ok, file, record }`；台账损坏时**拒绝写入并报错**（宁可失败也不覆盖历史）；
  `actionId` 必须是安全单段标识（`../../etc/passwd` 之类直接拒）。
- **密钥红线**：写盘前对即将落盘的字节跑形状扫描（`sk-`/`Bearer`/`token=`/cookie/api_key 赋值…）。
  命中 ⇒ `{ ok:false, code:'SECRET_SHAPE_REFUSED' }`，一个字节都不写，报错只给指纹。
- `readParamsLedger` 台账不存在时返回 `{ ok:false, exists:false, records:[] }`——不凭空造一个空台账。

### segment 1 的判定规则（report）

| 情况 | 状态 |
|------|------|
| 有台账，且至少一条 `outputs[].sha256` 与某个在盘字节相同 | `traceable` |
| 有台账，但没有任何一条 output 对得上在盘字节 | `traceable-in-history`（+ yellow finding `generation-outputs-not-on-disk`） |
| 有台账，某条 output 的**路径在盘但内容哈希不一致**（字节被改过） | 段状态照上述规则，另记 **red finding `generation-output-tampered`**（链断了，`reproducible` 转红，`verify` 计数 `tampered`） |
| 无台账，但发布台账里有该动作的发布记录 | `traceable-in-history`（发布记录证明跑过一次，但不含调用参数） |
| 无台账、无发布记录 | `not-recorded` |
| 台账文件存在但解析失败 | 记 red finding `generation-ledger-unreadable`，段状态不会升到 `traceable` |

`verify()` 的返回里新增 `hashChain`（台账条数 / 记录的输出总数 / matched / tampered / unresolved）与
`counts.tampered`：**篡改一个已入账的输出文件，verify 立刻变红**（退出码 1）。
"路径不在盘"（搬走/替换）是黄；"路径在盘但字节不对"是红——两者分开报，因为含义不同。
为了让"同路径不同字节"只意味着篡改，流水线转换段的产物落在内容寻址暂存目录
（`content/build/pipeline/<action>/<段>-<key前12位>/`，参数不同落不同目录），见 `generation-loop.md` §6。

## 4. CLI

```bash
# 单资产五段链（office 资产 id 与角色动作 id 同一套解析）
node studio/bin/provenance.js report walk-left          # 角色动作（JSON）
node studio/bin/provenance.js report walk-left --text   # 人读：最近一次调用的参数/输入输出哈希/一键复现命令/红黄绿
node studio/bin/provenance.js report working-back
node studio/bin/provenance.js report idle-lunch
node studio/bin/provenance.js report flat-desk          # office 目录资产（flat/ 平面家具）
node studio/bin/provenance.js report prop-plant         # office 环境道具
node studio/bin/provenance.js report prop-desk-front    # ARCHIVED（等轴家族，仍可解析）

# 全量校验（--json 的 stdout 只有 JSON，可管道给 jq；含台账哈希链）
node studio/bin/provenance.js verify
node studio/bin/provenance.js verify --json | head -40

# 重建索引（默认 studio/build/provenance-index.json）
node studio/bin/provenance.js index
node studio/bin/provenance.js index --out /tmp/prov-index.json --json

# 断点清单（每条都带找回锚点）
node studio/bin/provenance.js lost
node studio/bin/provenance.js lost --json

# 补一条生成参数记录（segment 1 的唯一写入口；追加，绝不覆盖；写盘前跑密钥形状扫描）
node studio/bin/provenance.js record --action walk-left --kind frame-sheet \
  --provider openai-compatible --model gpt-image-2 \
  --prompt "Walk-cycle sheet: side view facing left" \
  --params '{"grid":"3x1","mode":"edit"}' --seed 4242 \
  --reference photo/output/walk-left-01.png \
  --output resources/characters/deepseek-default/assets/animations/walk/left/walk-left-b01.png \
  --command "node scripts/gen-frames.js --action walk-left --mode edit" \
  --agent codex-cli --tool-version dsh-studio@0.1.0
# 提示词默认只存哈希；确需原文时加 --store-prompt-text
# 参数里出现 sk-/Bearer/token=/cookie 形状 ⇒ 拒绝写盘（SECRET_SHAPE_REFUSED，只报指纹）
# 全局参数：--repo <dir>（换一棵树，测试用它指向沙箱夹具）
```

生成段闭环的命令链（`pipeline run/plan/triage`）见 `generation-loop.md`；
`agent.js intake` 接收交付物时也会往同一本台账写生成调用记录（R5 交接路径）。

退出码：`0` 正常；`1` verify 发现 `lost`；`2` 用法错误 / 未知 id（错误走 stderr，stdout 保持机器可读）。

## 5. 诚实原则（本模块存在的理由）

- 跑不出来 / 没记录的环节如实标 `lost` / `not-recorded` / `traceable-in-history`，并给**找回锚点**：待补的台账路径、发布台账条目、photo 候选图、git 恢复命令、catalog 权威文件。没有锚点就直说"没有锚点：请人工确认该环节从未存在"。
- **绝不伪造"可复现"**：没有台账就不写 `traceable`；outputs 对不上字节就不算那次调用的产物；沙箱/git 不可用时不假装能从历史找回。
- 已知的真实断点（不要用"应该没问题"糊过去）：
  - `flat/` 与 `layout-editor/` 家具贴图：无生成脚本、无逐资产参数记录，目录表只登记批次标签与实测 `contentBbox` → `not-recorded`。
  - 根目录环境道具 `prop-*.png`：生成器 `scripts/gen-props.js` 在盘（能力可复现），但**这一张**当次用了什么提示词/尺寸没有记录 → 段状态 `traceable` + yellow finding。
  - 无发布台账条目的动作：字节可能直接来自归一化产物，无法证明经过 `publishAction` → 发布段 `not-recorded`。
  - 抠像：脚本在盘（参数权威 = 脚本常量），但逐次调用的阈值/容差/输入目录没有记录。
- 写权限边界：只写 `<content>/characters/<id>/provenance/generation/*.params.json` 与 `--out` 指定的索引文件。**测试只读真实树**，所有写操作都在 `os.tmpdir()` 沙箱里；`content/build/backups`、`photo/` 一律不碰（`photo/` 约 1.7GB，本机私有树，绝不进 git）。
- 密钥：本模块不读取、不打印任何 API key / secret；提示词以哈希落盘也是 Hygiene 的一部分。

## 6. API（其他模块依赖这个形状）

```js
const {
  createProvenance,      // ({ repoRoot, contentDir, charactersRoot, officeRoot, photoRoot, characterId, packId, catalog }) -> engine
  readParamsLedger,      // ({ repoRoot, characterId, actionId }) -> { ok, dir, file, exists, records: [...] }
  writeParamsRecord,     // ({ repoRoot, characterId, actionId, record }) -> { ok, file, record }（追加；建目录）
  PARAMS_DIR_RELATIVE,   // 'provenance/generation'
  STATUSES,              // ['traceable','traceable-in-history','lost','not-recorded']
  SEGMENTS,              // ['generation','matting','normalize','publish','on-disk']
} = require('./studio/lib/provenance.js');

engine.report(assetId)  // -> { ok, id, kind:'action'|'office-asset', segments:[{id,status,evidence,notes}], findings, reproducible }
engine.verify()         // -> { ok, counts:{traceable,traceableInHistory,lost,notRecorded}, rows:[{id,kind,status,detail}] }
engine.index({ out })   // -> { ok, out, entries:[...] }   默认 out: studio/build/provenance-index.json
engine.lost()           // -> { ok, entries:[{id,kind,status,segment,reason,anchors}] }
engine.record({ actionId, kind, provider, model, prompt, params, seed, references, outputs, command, createdAt })
                        // -> { ok, file, record }（委托 writeParamsRecord）
```

`assetId` 解析：角色动作 id（`walk-left`、`working-back`、`idle-lunch`…，来源 = `animations.json` + `content/**/actions/*.json` + 已有台账）与 office 目录 id（`flat-desk`、`prop-plant`…，来源 = `src/office/layout-assets.js` 的 `LAYOUT_ASSETS` / `ARCHIVED_LAYOUT_ASSETS`）。未知 id → `{ ok:false, error, known:[...] }`，绝不猜测。

## 7. 测试

```bash
node --test studio/test/provenance.test.js   # 23 个用例
node --check studio/lib/provenance.js && node --check studio/bin/provenance.js
```

测试纪律：写操作只在 `fs.mkdtempSync(os.tmpdir())` 沙箱、`t.after` 清理；对真实树只读，断言真实字节（如 `report('walk-left')` 返回 kind `action`、5 段、每帧 sha256 等于现场重算值）；涉及 git 历史的断言只接受 `lost` 或 `traceable-in-history` 两种诚实结论；已知真实树没有 segment 1 台账，测试就断言它 `not-recorded`/`traceable-in-history`，而不是把报告刷绿。
