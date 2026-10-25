# 第 0 步：Runtime Kernel Boundary Freeze + Hardening — 实现说明

> 日期：2026-10-17 · 分支：`develop` · 基线：`1d4f5f9`
> 契约正文：[`HARNESS-RUNTIME-CONTRACT-v0.md`](./HARNESS-RUNTIME-CONTRACT-v0.md)

## 阶段一（Boundary Freeze）

在不改变任何现有行为的前提下，把"Harness journal → 办公室渲染"这条链的**边界**
从"注释里的约定"变成"可执行的约束"，并证明现有 office runtime 已经是一个无 UI、
可测试、可复用的内核。

新增：`docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md`、`test/harness-runtime-kernel-probe.test.js`、
`test/office-runtime-boundary.test.js`、`src/office/runtime/index.js`。

## 阶段二（Runtime Kernel Hardening）

只修复阶段一审计发现的问题，并把第 0 步变成可提交、可进入下一阶段的稳定基线。
**没有**开始 Team DAG / 自动规划 / 共享上下文 / 五代理编排 / 新 UI。

### P0：replay 路径的子代理配对丢失（真实缺陷，已修）

**根因**：adapter 的 live ingest 从**原始** `runId` 派生配对 proxy，但 `drainBuffer`
与 `acceptSnapshot` 重放时交给 fact 映射的 `rawData` 是**已脱敏**的 payload ——
重新派生会哈希 `[REDACTED:session-id]`，得到一个与 live 登记不同的 proxy，
registry 以 `RUN_ID_MISMATCH` 失败关闭，座位停在 running/bound（用户可见的"卡住"）。

**方案选择**：比较了
- **方案 A（buffer sidecar）**：额外保存内部 rawData。**否决**：只能覆盖"本 adapter
  自己缓冲过的事件"；adapter 重启、或只拿到另一生产者给的 canonical `eventsSince`
  列表时 sidecar 不存在 —— 会留下第二类同类缺陷（任务书明确要求排除）。
- **方案 B（envelope 携带 adapter-derived handle）**：**采纳**。handle 在首次 raw
  ingest 时派生一次，写进 canonical envelope 的 `pairingHandle`；`mapEnvelope` 的
  `subagent/start|end` **只读该字段**。配对因此成为 canonical 记录自身的属性，任何
  重放路径都不再丢失它。

**配套（否则端到端仍会卡住）**：raw child id 只存在于 raw 事件路径上，而 fact↔raw 的
关联是**位置性**的（adapter 的 `onEvent` 不携带生产者）。因此：
- `registry.childSessionIdForRunId(handle)` —— handle → 子会话的反查（新增，纯查表）；
- `correlatedChildId(rawEvent, handle)` —— 一致性判据：fact 的 handle 必须等于关联
  raw 事件自身派生出的 handle，否则该 raw id 不可信；
- 两者都拿不到 → fail-closed + `SUBAGENT_IDENTITY_UNRESOLVED` 诊断（不猜子会话、
  **不按当前座位强行关闭**）。

**版本策略**：`pairingHandle` 是**加性**字段，envelope `schemaVersion` **保持 1**。
缺省（缺失/`null`）= fail-closed 的"不可配对"，所以旧/外来 envelope 安全降级而不是
误配对；升版会让所有既有 v1 envelope 直接失效，是更严格且无收益的破坏性变更。
`ADAPTER_VERSION` 升到 `task6-runtime-adapter-2` 作为可观测标记。
`validateEnvelope` 只放行 `run-sha256:<16hex>`，原始 runId 无法经快照重放混入。

**禁止项全部遵守**：没有放宽 `verifyRunId`；没有按当前座位强制关闭；没有把 raw runId
作为下游事实；没有测试专用分支。

### P1：移除纯内核对壳 i18n/Electron 的静态依赖

把 `tool-phrases.js` 需要的 9 条 zh 短语下沉为内核自带的冻结词表 `PHRASE_ZH`；
`tool-phrases.js` 变为**零依赖**。i18n 字典**未改动**（UI 仍按 key 渲染多语言），
一致性由 `test/office-right-panel-p1.test.js` 的漂移钉（`PHRASE_ZH[key] === STRINGS.zh[key]`）
保证。`GUARDED_SHELL_EDGES` 清空；门禁改为断言"**零例外** + 闭包不越界"。

### P2：诊断字段修复

1. **`runtimeVersion` 注入**：`main.js`（`activeRuntimeVersion()`，回落内置版本）→
   `createOfficeModule({ runtimeVersion })` → `ensureAdapter` → `createRuntimeAdapter`。
   `capability().runtimeVersion` 如实报告；未注入时保持 `null`。可观测入口
   `module.debugAdapterCapability()`（与既有 debug 模式一致，无新 IPC 通道）。
2. **evidence 重复前缀**：规则改为"**evidence = `<source-event>:<coarse-reason>`，只在
   同时知道来源与粗粒度原因的那一层构造一次，下游永不重新限定**"。模块原样消费
   adapter 的 `runtime/cancelled.evidence`（`turn/end:aborted`），不再产出
   `turn/end:turn/end:aborted`。**不是**只改 UI 文案：修的是 `lastResult.reason` 与
   `binding.lastEvidence` 的产出点，三条终态路径都由测试钉住。

## 验证

```bash
node --test test/harness-runtime-kernel-probe.test.js      # 29 pass / 0 fail
node --test test/office-runtime-boundary.test.js           # 16 pass / 0 fail
node --test test/office-runtime-adapter.test.js            # 61 pass / 0 fail
node --test test/office-runtime-snapshot.test.js           # 32 pass / 0 fail
node --test test/office-resync-backfill.test.js            #  8 pass / 0 fail
node --test test/office-subagent-wiring.test.js            # 12 pass / 0 fail
node --test test/office-task-end-recovery.test.js          #  8 pass / 0 fail
npm test                                                   # 1571 pass / 0 fail（≈120s）
```

基线（本阶段开始前）：`npm test` = 1554 pass / 0 fail。本阶段净增 17 条测试。

**变异验证**（证明新测试不是空断言）：
- 把 `mapEnvelope` 改回"从 rawData 派生 handle" → 探针的 `P0-A` / `P0-B` / `P0-D` 与
  `office-runtime-checkup.test.js` 的 P0 端到端测试**同时失败**（座位不释放）；恢复后通过。
- 往 `src/office/runtime/` 塞一个未登记文件 → 边界门禁失败。
- 给某个内核模块加一行 `require('electron')` → 3 条门禁测试失败。

## 仍需主代理处理的 Git staging

`docs/` 被仓库既有约定整体忽略（`.gitignore:8`），以下两个文件需要
**`git add -f`** 才能入库（本任务未扩大 `docs/` 的入库范围，也未改 `.gitignore`）：

```bash
git add -f docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md
git add -f docs/specs/HARNESS-RUNTIME-KERNEL-STEP0-NOTES.md
```

其余改动都是 `src/` 与 `test/` 下的普通文件，按常规 `git add` 即可。

---

## 阶段三（2026-10-18）：event identity 关联（Phase B）

**问题**：`office-module.applyFact(fact, envelope, rawEvent)` 靠模块自己的 `currentRawEvent`
（"正在 ingest 的那条 raw 事件"）关联 fact 与原始输入。被 buffer 补发或被 canonical
重放（`eventsSince`）的 fact 会在**另一条**事件的 ingest 期间同步触发，于是 raw child
identity 会被错误归属 —— 这是一个位置性假设。

**修复**（不破坏 adapter 契约；旧 envelope/replay 行为保持兼容）：
1. adapter 的**每次输出**都带 `sessionId`（恒存在）+ `envelope`（产出事件身份，无对应
   事件时为 `null`）→ 消费者不再需要推断 session。
2. 新增 `adapter.rawChildHandleFor(envelope)`：**按 envelope 的 eventId** 反查该事件在
   首次 raw ingest 时记下的 raw child id（有界 LRU，512 条，主进程内，`state()` 只暴露
   计数）。identity-keyed，因此 live / buffer 补发 / 重复投递解析到同一子会话；canonical-only
   重放（从未见过原始输入）解析为 `null` → fail-closed + `SUBAGENT_IDENTITY_UNRESOLVED`。
3. `office-module` **删除** `currentRawEvent` 与 `correlatedChildId()`；子会话身份改由
   `registry.childSessionIdForRunId(fact.runId)` + `rawChildHandleFor(envelope)` 两条身份
   驱动来源解析；`deriveRunProxy` 在模块内不再被调用（import 已移除）。

**不变量保持不变**：raw prompt / 路径 / 工具参数 / raw runId 不进下游事实；
`pairingHandle` 仍只能是 adapter-derived proxy；原始 session id 不进 envelope
（`validateEnvelope` 仍只放行 `run-sha256:<16hex>`）。

**区分性验证**：门禁用**两个并发子代理**区分"身份驱动"与"位置驱动"——把
`rawChildHandleFor` 变异成"返回最近记住的 handle"（位置语义）后，3 条测试立刻失败
（含模块级 fail-closed 测试）；恢复后全通。

**实测发现的边界（记录在案，未修改）**：脱敏器的 `SHORT_ENUM_TOKEN_RE` 会把**短小写
不透明 id** 当粗粒度枚举放行 —— `child-y` 不被脱敏，`sess-child-y` 才被脱敏。真实
Harness id 都是带前缀/UUID 形状，故实际暴露面小；但新标识字段必须用带前缀形状。
详见契约 §12。
