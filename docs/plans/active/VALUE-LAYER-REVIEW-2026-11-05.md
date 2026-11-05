# 价值层重构 · 本地复检报告（2026-11-05）

> **复检对象**：`docs/plans/active/VALUE-LAYER-REFACTOR-2026-11-05.md`（已批准）
> **复检依据**：**本仓库代码与实测**。GPT 是云端模型，看不到本地文件；它的意见只作为"被检验的假设"，
> 与本地证据冲突时**一律以本地证据为准**（本次冲突 3 处，见 §2.6）。
> **可重跑**：本报告每条结论都附了命令（§7），任何数字都可当场复算。
>
> **一句话结论**：四阶段框架成立、方向不需要推翻；但有 **6 处事实偏差会让实施方写出"能跑但错"的代码**，
> 必须在动工前修掉——这是本报告存在的唯一理由。
>
> **处置状态（2026-11-05 晚更新）**：6 处偏差对应的**三项决策已由用户拍板**并回填计划 §2.8——
> 记忆实体折叠（只加 `lesson`）· SDK 同树供给 + 宿主进程（897MB/精确锁版/`process.execPath` 硬编码三条新证据）·
> 基线 T0/T1 动手转绿。本报告降级为**决策依据存档**，当前口径以计划 §2.8 为准。

---

## 0. 结论摘要

| 计划部分 | 复检结论 | 需要动作 |
|---|---|---|
| §0 架构原则（Mission Core 是资产 / SDK 是可替换层） | **成立**，且与代码结构一致（`src/mission/` 已是零 Electron 依赖的纯逻辑层） | 无 |
| §2 拍板 D4（上 0.2.2-rc.1） | **成立**，但没接到既有的运行时供给链路上 | 补 §3.3（见 §2.4） |
| §2.7 Phase 0.5 契约验证 | **成立，且应该做**；范围需加 2 项 | 补"SDK 供给方案""基线归因" |
| §3 Phase 1 SDK 桥接 | 方向成立、选项面已对；**"SDK 装在哪"没定义** | **必须补** |
| §4 Phase 2 Mission Memory | 方向成立；**事件命名约定不符 + 与已有三实体重叠 + 真删除能力不存在** | **必须改** |
| §5 Phase 3 检查器 | 成立；**新契约名与现有模块撞车** | **必须改名** |
| §6/§7/§8 退出条件与测试策略 | 成立；但"全绿基线"这条前提是假的 | **必须改口径** |

---

## 1. 事实核验表

| # | 计划里的表述 | 本地实际（2026-11-05 实测） | 判定 |
|---|---|---|---|
| 1 | `src/runtime-mux.js` 是 journal 尾随链路 | 存在，374 行，`/api/remote.mux` 客户端 | ✅ 一致 |
| 2 | `src/team/runtime/**` 为旧 Team Runtime | 存在，10 个模块（execution-port / controller / office-bridge …） | ✅ 一致 |
| 3 | Mission 事件存在 append-only `events.jsonl` | `src/mission/event-log.js` 提供 encode/decode/append/needsArchive/detectTruncation | ✅ 一致 |
| 4 | `missionPromptSession` 是派发入口 | `src/main.js:2609`，经 `ipc-mission` 暴露为 `promptSession` | ✅ 一致 |
| 5 | 幂等可对齐 `seqForMissionSession` | `src/main.js:5837` 存在 | ✅ 一致 |
| 6 | 事件 adapter 对接 `ingestHarnessEvent` | `src/office/office-module.js:3902` 导出 | ✅ 一致 |
| 7 | 隐私字段黑名单 `PRIVACY_FORBIDDEN_FIELDS` | `src/mission/schema.js:96`，且 2026-11-04 起**真正执行**（此前只定义未使用） | ✅ 一致（计划未提"已生效"这点） |
| 8 | `confirmDispatch` 可挂"派发前检查" | `src/ipc-mission.js:2542` 存在 | ✅ 一致 |
| 9 | 新增 `memory/attempt` 等 4 类事件 | 现有事件命名是 **`entity.action`**（`finding.recorded` / `decision.superseded`），无 `a/b` 形状 | ❌ **不符**（§2.1） |
| 10 | 记忆层是新领域 | 已有 `finding` / `assumption` / `evidence` 三类 Shared Context 实体 | ⚠ **重叠**（§2.2） |
| 11 | Phase 3 引入 `HarnessHistoryReader` | `src/mission/harness-reader.js` **已存在**，但语义是"实时快照归一化" | ❌ **撞车**（§2.3） |
| 12 | 真删除用"墓碑 + 物理压实" | `event-log.js` 只有归档判定，**无 compaction**；`store.js` 有备份轮转 | ❌ **能力不存在**（§2.5） |
| 13 | `CI=1 npm test` 全绿基线 | 3476 项 / **3468 pass / 7 fail / 1 skip**（改造前为 3474/3466） | ❌ **不成立**（§2.6） |
| 14 | SDK 包装入后即可用 | `@deepseek-ai/dsh-sdk-client` **不在** `package.json`；仓库 `node_modules/@deepseek-ai/` 为空 | ❌ **未定义**（§2.4） |
| 15 | 运行时版本对齐 0.2.2 | `package.json.runtimeVersion` = **0.1.5-rc.2**（打包 seed 的唯一来源） | ❌ **滞后 4 个 minor** |
| 16 | 测试规模 254 套件 / 3400 项 | 265 个 `test/*.test.js` / 3474 项 | ⚠ 数字过时 |
| 17 | Mission IPC 18 action | `ACTIONS` 实际 **43 项** | ⚠ 数字过时 |
| 18 | `src/mission/` 8 个模块 | 实际 **25 个** `.js` | ⚠ 数字过时 |

---

## 2. 六项必修偏差（按"会不会让实施方写出错代码"排序）

### 2.1 事件命名约定不符 —— 会让记忆事件"写进去了但永远看不见"

**证据**

- `src/mission/projection.js` 的 fold 是 `entity.action` 形状：`mission.created`、`finding.recorded`、
  `decision.superseded`、`taskRef.linked`、`receipt.recorded`……
- `src/mission/schema.js:690` 的 `validateEntity` 按实体名分派，**未知类型直接返回失败**（fail-closed）。

**后果**：照 `memory/attempt` 这个写法实施，有两条路，两条都错：

1. 走 `validateEntity` → 写入被拒，功能直接不可用；
2. 绕过校验直接 append → 事件躺在 `events.jsonl` 里，**projection 的 `default` 分支静默忽略**。
   这是本仓库最怕的失效模式：数据在、UI 永远看不到、日志里也不报错。

**修订**：统一为 `attempt.recorded` / `lesson.recorded` / `gotcha.recorded`，并同时改三处，
缺一处就是半成品：`ENTITY_TYPES` → `validateEntity` 分派 → `projection.js` fold。

### 2.2 与已有 Shared Context 三实体职责重叠 —— 会造出第二套记法

**证据**：`ENTITY_TYPES` 已含 `finding`（`unverified/verified/refuted`）、`assumption`
（`holding/violated/expired`）、`evidence`（`file/commit/url/command/observation`）。
计划要加的 `lesson`（教训）与 `gotcha`（坑位）跟 `finding` 的重叠度很高：
"X 在 Y 条件下会崩"既可记成 `finding`，也可记成 `gotcha`。

**后果**：同一件事两种记法 → 半年后没人知道该查哪张表 → 违反铁律 1（一条事实一条来源）。

**修订（二选一，必须拍板，不能留给实施方临场决定）**：

- **方案 A（推荐，归并不新增）**：`gotcha` = `finding` 的一个 `kind`（`hazard`）；
  `lesson` = `decision` 的派生视图（不落新实体）。改动最小，语义最干净。
- **方案 B（并存）**：新增 `attempt` / `lesson` / `gotcha` 三个实体，但必须写清与 `finding` 的分工判据
  （例如"可复现的现象 → finding；一次性踩坑经验 → gotcha"），并加一条投影层互斥测试。

### 2.3 `HarnessHistoryReader` 与现有 `harness-reader.js` 撞车 —— 会让人改错文件

**证据**：`src/mission/harness-reader.js` 已存在，做的是"实时快照归一化 + 强制 `observedAtMs`"，
刻意**不**持有历史。计划 §5.2 要的却是"按 execution 分页读事件"的历史读取器。

**后果**：实施方看到同名文件，很可能直接在它上面加方法 —— 于是"实时快照"和"历史分页"混成一个模块，
两种生命周期（毫秒级刷新 vs 大文件分页）互相污染。

**修订**：新契约改名 `src/mission/execution-history.js`（`ExecutionHistoryReader`），
并在两边文件头互相写一句"我不是谁"。

### 2.4 SDK 供给位置未定义 —— 最可能返工的一项

**证据（三条，缺一不可）**

1. `package.json` 的 `dependencies` / `devDependencies` 里**没有** `@deepseek-ai/*`；
2. 运行时不是普通依赖，而是 `scripts/prepare-runtime.js` 按 `package.json.runtimeVersion` 从 registry
   装成 `vendor/runtime`（打包进 `extraResources`），或由 `src/runtime-manager.js` 用 arborist
   物化到 `userData/runtime/<version>/node_modules`；
3. `package.json.runtimeVersion` = **0.1.5-rc.2**，而现役运行时是 0.2.1-rc.5、D4 目标是 0.2.2-rc.1。

**后果**：如果实施方顺手 `npm i @deepseek-ai/dsh-sdk-client`，会得到两套 cordis 树
（仓库一套、运行时目录一套），而 `cordis` 代际必须与 dsh 代际配对（0.2.1→`~4.0.5`，0.2.2→`~4.1.0`），
混装即崩。这类崩溃的报错是 `plugin loader null entry`，**完全指不到根因**。

**修订**：Phase 0.5 加一项"SDK 供给方案"，必须回答四个问题：

| 问题 | 判据 |
|---|---|
| SDK 装进哪棵树？ | 必须与 `dshBin` 同树，或显式声明两树互不解析 |
| `dshBin` 指向哪？ | 打包后是 `resources/runtime/...`，开发态是 `userData/runtime/<v>` |
| asar 内能否 require？ | 不能则需 `asarUnpack`，且要写进 `electron-builder.js` |
| Node 22 主进程能否加载？ | 该包未声明 `engines`，属推断，**必须实测** |

同时把 `runtimeVersion` 从 `0.1.5-rc.2` 升到目标版本的步骤写进计划（含 compat ledger 回写，
`npm run check:compat-ledger` 会校验）。

### 2.5 "真删除 = 墓碑 + 物理压实" 把新能力写成了既有能力

**证据**：`src/mission/event-log.js` 导出 `MAX_BYTES / MAX_LINES / encodeEvent / decodeEvent / readLog /
appendEvents / logBytes / needsArchive / detectTruncation / nextSeq` —— **没有任何重写或压实函数**。
`needsArchive` 只是"该归档了"的判定，归档是另存一份，不是删除。

**后果**：计划读起来像"我们有 compaction，调用即可"，实施方会低估工作量，并漏掉三个真正的难点：

1. 压实要重写 `events.jsonl` → 必须重新分配 seq 或保留原 seq，否则 `detectTruncation` 会报"不单调"；
2. `store.js` 有 `backupCandidates` / `rotateBackups`，压实必须与备份策略协同，否则备份里还留着"已删除"的内容；
3. 投影索引（`projection.js` 的 fold 结果）必须同步重建，否则 UI 里还在。

**修订**：§4.2.2 标注"**新增能力**（当前不存在）"，并补一条风险：
"压实期间进程崩溃 → 日志半写 → 需先写临时文件再原子 rename"。

### 2.6 基线不绿 —— "全绿基线"这个前提是假的

**实测**：`CI=1 npm test` → **3474 tests / 3466 pass / 7 fail / 1 skip**
（测量于本轮文档改造前；改造新增 2 条文档门禁后总量为 3476，**红项集合不变**，见 `repo-map.md` §5）。

| 红项 | 数量 | 根因 | 性质 |
|---|---|---|---|
| `resources/characters/**` 的 PNG alpha / 帧真实性 / remove-bg 校验 | 6 | 本机 `python3` **缺 Pillow**（`import PIL` 失败） | 环境缺失（E 级） |
| `test/mcp-verify-gate.test.js` 的 debounce 用例 | 1 | 全量并发下的时序偶发；**单跑 8/8 通过** | 已知偶发 |

**后果**：计划 §3.5 / §8 都写"现有测试全绿"作为退出条件。实施方第一次跑就会看到 7 个红，
然后只有两条路——去修与任务无关的红（违反 §10 范围控制），或者把红当正常（违反 §8 强制验证）。
两条都是我们不想看到的。

**修订**：把门禁口径改成 **"红项集合不扩大 + 新增红必须归因"**（已写进 `docs/architecture/repo-map.md` §5
与根 `AGENTS.md` §0.4）。这才是这个仓库真实可执行的判据。

---

## 3. 次要偏差（数字过时，会误导判断）

| 位置 | 计划/旧文档 | 实测 | 处理 |
|---|---|---|---|
| `src/main.js` | 7019 行 | **7083 行** | 已更新到 repo-map |
| `src/office/office-module.js` | 4798 行 / 预算 4850 | **4799 行 / 总行上限 5200、代码行 3400** | 已更新 |
| 测试规模 | 254 套件 / 3400 项 | **265 套件 / 3474 项** | 已更新 |
| `src/mission/` | 8 模块 | **25 模块** | 已更新 |
| Mission IPC | 18 action | **43 action** | 已更新 |
| `package.json.runtimeVersion` | （未提） | **0.1.5-rc.2** | 列入 §2.4 修订 |

> 这些数字不是洁癖：`main.js` 行数是 TD-01 的严重度依据，`office-module` 行数是逼近硬上限的预警。
> 写错会让人以为"还有余量"。

---

## 4. Phase 0.5 定性：这算开发，还是开发准备？

**直接回答：它是"开发"，但是基础设施开发，不是产品功能开发。**

判据（三选三才算"正式开发"）：

| 判据 | Phase 0.5 | 结论 |
|---|---|---|
| 产出物是否进仓库、进 CI、被后续阶段 import？ | 是（fixture、契约测试、provisioner 脚本） | 算开发 |
| 是否改变用户可见行为？ | 否（无 UI、无主链路、无 schema 变更） | 不算产品开发 |
| 失败是否会让用户受损？ | 否（最坏结果是"这段脚本不能用"） | 风险等级 = 准备 |

所以更准确的说法是：**Phase 0.5 是"把不确定性变成可执行断言"的开发准备阶段**。
它交付的不是功能，而是**后续四个阶段的地基判据**。

这对你的排期意味着什么：

- ✅ **适合交给 DeepSeek**：边界清晰（纯脚本 + fixture）、验收客观（测试能红能绿）、
  不需要产品判断、不需要真机 key（除个别项）。
- ⚠ **但必须先由我们把三件事钉死**，否则他会在"猜"上花掉大部分时间：
  1. 事件命名与实体归并（§2.1 / §2.2）——**这是决策，不是实现**；
  2. SDK 供给方案（§2.4）——**这是架构，不是编码**；
  3. 基线口径（§2.6）——**这是验收标准**。
- ❌ **不要让他做**：拍板类问题（依赖引入、schema 合并、隐私边界变更）、真机 key 相关验证、
  任何需要改门禁的事。

一句话：**我把"该做什么、做到什么算过"写完；他负责"写代码让它过"。**

---

## 5. 对主计划的修订清单（可直接照此 patch）

| 位置 | 现状 | 改为 |
|---|---|---|
| §2.7 范围 | 5 项 | 增第 6 项「SDK 供给方案」、第 7 项「基线归因清单」 |
| §2.7 退出条件 | 五项各有结论 | 七项各有结论；并注明"基线红项集合已记录" |
| §3.1 profile 供给 | 只说用 `sdk-minimal` + 补丁 | 增"SDK 包与 dsh 必须同树解析"与 `dshBin` 指向规则 |
| §3.3 | 独立 Runtime Lockfile | 增"`package.json.runtimeVersion` 是现有唯一供给源，升版本须同步 prepare-runtime + compat ledger" |
| §4.2 事件表 | `memory/attempt` 等 | 改 `attempt.recorded` / `lesson.recorded` / `gotcha.recorded`；并附"三处必改"清单 |
| §4.2 前置 | 直接新增 4 类事件 | 增"**先与 finding/assumption/evidence 归并决策**（方案 A/B 二选一）" |
| §4.2.2 | "采用墓碑 + 物理压实" | 改"**新增** compaction 能力"，并补三条实现难点与原子写要求 |
| §5.2 | `HarnessHistoryReader` | 改 `ExecutionHistoryReader` / `execution-history.js`，注明与 `harness-reader.js` 的区别 |
| §3.5 / §8 | "现有测试全绿" | 改"红项集合不扩大 + 新增红可归因" |
| §7 风险 | R1–R10 | 增 R11（压实半写）、R12（SDK 与运行时双 cordis 树） |

---

## 6. 建议的执行顺序（给交接用）

```
S0  基线归因（0.5 天）        记录 7 红的环境成因，写进 repo-map；不改代码
S1  两个决策（人拍板）        事件命名 + 三实体归并；SDK 供给方案
S2  契约 fixture（Phase 0.5） 六族事件形状固定 + 契约测试进 CI（无 key 可跑）
S3  provisioner               RuntimeProfileManager 原型：profile/patch/plugin 三步可复现
S4  中断方案                  进程级中断 + resume 续跑 vs ACP 中止，二选一定稿
S5  Electron 集成面实测        Node 22 主进程加载 SDK / asar 解析 / 打包后可执行
```

S0–S1 不写产品代码，**必须在我们这侧完成**；S2–S5 是可交付给 DeepSeek 的代码任务。

---

## 7. 复检可重跑命令

```bash
cd <repo>

# 基线（约 2 分钟；输出 3476/3468/7/1 属当前已知状态）
CI=1 npm test

# 红项归因
node --test test/mcp-verify-gate.test.js        # 单跑应 8/8 通过（并发偶发）
python3 -c "import PIL"                          # 失败 = 那 6 个图片类红项的根因

# 行数与模块数
wc -l src/main.js src/office/office-module.js src/runtime-mux.js
ls src/mission/*.js | wc -l

# 事件命名约定（应为 entity.action 形状）
grep -n "case '" src/mission/projection.js | head -20

# 真删除能力是否存在（应无 compaction 相关导出）
grep -n "module.exports" -A 14 src/mission/event-log.js

# SDK 是否已声明为依赖（应无输出）
grep -n "deepseek-ai" package.json

# 打包 seed 版本（当前 0.1.5-rc.2）
node -e "console.log(require('./package.json').runtimeVersion)"
```

---

## 8. 本报告没有做的事（诚实边界）

- **没有**重新真机跑 SDK（0.2.2 真机证据来自 `docs/research/memory-and-sdk-validation-2026-11-05.md` §4.6，
  本轮没有新烧 key）。
- **没有**验证 SDK 在 Electron 主进程（Node 22）内的可加载性 —— 这属于 §2.7 第 4 项，待 Phase 0.5。
- **没有**验证 compaction 方案的可行性 —— 目前只确认"能力不存在"，实现方案待设计。
- **没有**对 GPT 的架构建议做全面重审，只裁决了 3 处与本地代码冲突的事实（§2.1 / §2.3 / §2.5）。
