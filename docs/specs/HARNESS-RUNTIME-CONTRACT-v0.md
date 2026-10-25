# Harness Runtime Kernel 契约 v0（边界冻结）

> 状态：**v0 冻结 + 收尾加固完成**（2026-10-17，第 0 步工程任务 + 收尾阶段 Runtime Kernel Hardening）。
> 事实来源：**当前代码**。本文档描述的不是"应该是什么"，而是"现在是什么"——所有条目都指向具体实现文件与行号，并由两个新测试门禁持续校验：
> - `test/harness-runtime-kernel-probe.test.js`（无 UI 内核探针）
> - `test/office-runtime-boundary.test.js`（依赖边界门禁）
>
> 阅读顺序建议：§1 事实链 → §2 模块边界 → §3 字段分类 → §4–§14 契约细则 → §15 不承诺项 → §16 审计发现（含已闭环项）→ §17 剩余缺口。

## 0. 本文档的范围

**是**：冻结 Harness 事件 → 办公室渲染这条链上每个模块的输入、输出、事实所有权和依赖边界；冻结 canonical envelope、runtime facts 允许集合、权威矩阵、sync 语义、cancel/terminal 区别、snapshot/resync/replay 规则、隐私边界、capability gating 和版本兼容策略。

**不是**：不改事件命名、不改状态枚举、不改 UI 行为、不新增 provider、不实现 Team DAG / 自动任务规划 / 多代理产品 UI、不承诺 pause/resume。

v0 的含义：**契约边界**冻结（谁产出什么、谁不能产出什么、什么不许越过哪条线）。字段级增补、Team 编排、跨设备协作属于 v1+，不在本文件承诺范围。

---

## 1. 事实链（journal → render）

```
[dsh Harness 0.1.5-rc.2]
  持久 session journal（append-only，{type,seq,time,data}）
  + /api/remote.mux（WS 多路复用；$events 全局流 / session/follow 每会话流 / session/page 单次 RPC）
        │
        ▼
[1] src/runtime-mux.js                      纯 Node（ws 可注入）。重连/退避/流重开。
        │  onItem(streamId, value) / call('session/page', args)
        ▼
[2] src/main.js（Electron 主进程 = 组合根，持有 raw sessionId）
    ├─ ingestOfficeFollowFrame(sessionId, value)        {type:'event'} → [2a]；{type:'snapshot',records} → [2c]
    ├─ [2a] ingestOfficeJournalEvent(sessionId, event)  **0.1.5 journal → adapter 词表的翻译层**
    ├─ [2b] officeSubagentWiring.handleEvent(...)       真实持久子代理信号 → subagent/start|end
    ├─ [2c] ingestHarnessSnapshot({sessionId, records}) → office-module（水位决策）
    └─ officeAnswerResync(sessionId, request)           session/page 反向翻页 → [2c]
        │  mod.ingestHarnessEvent({sessionId,type,seq,time,data})
        ▼
[3] src/office/office-module.js（组合根，Task 7）
    ├─ ensureAdapter(sessionId).ingest(...)             adapter onEvent → handleAdapterOutput → applyFact
    ├─ applyFact(fact, envelope, rawEvent)              facts → registry（绑定/队列）+ 每员工 reducer
    └─ reduce(rec, event) → reduceOfficeState           + transition/movement/scheduler 编排
        │  state()（白名单 + 共享脱敏器）
        ▼
[4] office:state IPC（main.js broadcastToOfficeViews）
        ▼
[5] src/office/office-page.js（require-free 视图模型） → src/office/render/pixi-office-renderer.js（applySnapshot）
```

**纯内核边界**（无 UI、无 IO、可测试、可复用）= 步骤 [3] 内部的 `src/office/runtime/**` 纯模块集合（见 §2.3）。步骤 [2] 是**壳**（Electron 主进程），步骤 [5] 是**表现层**。

### 1.1 翻译层的关键事实（[2a]）

adapter 说的是 **0.1.x wire 词表**，而 0.1.5 journal 形状不同；`main.js` 负责翻译，且**只翻译粗粒度事实**：

| 0.1.5 journal 事件 | 翻译后交给 adapter | 被丢弃的部分 |
|---|---|---|
| `turn/start` | `agent/status` + `data:{status:'running'}` | 其余全部 |
| `turn/end`（`data.reason` 是 `{kind}` 对象） | `turn/end` + `data:{turn, reason: reason.kind}` | 原始 reason 对象 |
| `tool/call`（`data.name` / `data.arguments`） | `tool/call` + `data:{tool: toolNameOfJournalData(data)}` | **`arguments` 原文永不进入办公室** |
| `assistant/message`（含 `data.usage`） | `turn/usage` + `data:{turn, usage:{input,output,cacheRead,cacheWrite}, cost}` | 消息正文、step、其余字段 |
| `subagent/catalog`、`tool-workflow/*`、`user/message(source.kind='subagent-settled')` | 经 `subagent-wiring.js` → `subagent/start|end` | label/phase 之外的一切；**任务正文从不被读取** |
| 其它任何类型 | 原样 `ingestHarnessEvent({type, seq, time, data})` | 无（adapter 映射不到就不产生 fact） |

两条硬约束：
- 翻译后的 envelope **必须沿用 journal 原始 `seq`**，否则 adapter 的严格水位会开出假断档（`subagent-wiring.js` 的 seq 契约；只有 `flushDeferred` 的迟到 start 用 `seq:null` 让 adapter 自行编号）。
- `assistant-stream`（进程内增量帧）**故意不转发**给 office-module（正文是模型原文，违反隐私边界）。

---

## 2. 模块边界

### 2.1 输入 / 输出 / 事实所有权

| # | 模块 | 输入 | 输出 | 事实所有权 | 依赖边界 |
|---|---|---|---|---|---|
| 1 | `src/runtime-mux.js` | baseUrl + auth + 注入的 WS/fetch | `onItem(streamId, value)`、`call()` 结果、状态机 | 无业务事实（只拥有连接/流生命周期） | 纯 Node；`ws` 可注入 |
| 2 | `src/main.js` | mux 帧 + 会话列表 + 用户意图 | `ingestHarnessEvent` / `ingestHarnessSnapshot` 调用 | **raw sessionId 在壳侧的唯一来源**（office-module 内部也持有 raw handle，但从不外泄到快照）；journal→wire 翻译；P3 detailRef 参数存储 | Electron 主进程；shell |
| 2b | `runtime/subagent-wiring.js` | 一条 journal 事件 | `emit(sessionId, {type,seq,time,data})` + `true/false` | 子代理 start/end 的**配对**（childId 账本、runId↔memberSeq） | **纯**：无 electron/DOM/Pixi/fs/网络/时钟/随机 |
| 3 | `office-module.js` | `ingestHarnessEvent` / `ingestHarnessSnapshot` / 控制意图 / 设置 | `state()` 快照、IPC 通道、诊断 | 每员工 `rec`（state/transition/position/toolKind/…）、`globalSync` 聚合、座位归属编排 | 组合根：允许 `node:fs`（fixtures/布局）；不得被纯模块反向 import |
| 3a | `runtime/runtime-adapter.js` | raw `{type,seq,time,data}`（含 `{event:{…}}` 包装） | `{envelope, facts, diagnostics}`；`office:*resync-request` 消息 | **canonical envelope**、去重账本、水位、buffer、resync 周期、activeRuns、runId→proxy | 纯（+ `node:crypto`）；**唯一的 Runtime 事实入口** |
| 3b | `runtime/runtime-snapshot.js` | resync request / snapshot message / merge state | 校验裁决、`{replay, leftover, facts, factsDiagnostics}` | `office:runtime-*` 消息 schema、facts 白名单、合并语义 | 纯（零 require） |
| 3c | `runtime/privacy-redactor.js` | 任意值 / 事件 | 脱敏值 / 占位符 | 脱敏词表与形状启发式 | 纯（零 require） |
| 3d | `runtime/state-reducer.js` | `(state, event)` | `{state, effects}` | 8 维状态与**权威规则** | 纯（零 require） |
| 3e | `runtime/employee-registry.js` | 绑定/子会话/终态请求 | 绑定记录 + 队列 effects | 绑定账本（session↔employee、优先级、childSessions、classification） | 纯；队列事实**全部委托**给 queue-controller |
| 3f | `runtime/queue-controller.js` | enqueue / 终态证据 | 队列项 + 原子切换 effects | **唯一的队列事实源**（FIFO、activeItem、dispatch） | 纯 |
| 3g | `runtime/transition-controller.js` | transition 记录 + 阶段事件 | 新 transition + 清理 effects | 过渡相位（stop→turn→move→arrive→sit→work / result→stand→leave） | 纯；不碰 sprite/坐标/runtime fact |
| 3h | `runtime/subagent-classifier.js` | 有界结构化元数据 `{label,phase,mode,provider}` | `{employeeId, classified, rule, mode}` | 座位分类（只读元数据，fail-closed → collaborator） | 纯；不读任务正文、无 LLM |
| 3i | `runtime/animation-controller.js` | `{state,direction,elapsedMs,pack,override}` | `{resource,frameIndex,loop,fallbackReason}` | 动画资源/帧选择 | 纯 |
| 3j | `runtime/movement-controller.js` | 位置/目标/图/预留/dt | 新位置/方向/预留动作 | 位置、方向、path 预留 | 纯 |
| 4 | `render/pixi-office-renderer.js` | `applySnapshot(snapshot)` | 像素 | **无**（只消费） | 只 require `./fps-monitor.js`、`../layout-assets.js` |
| 5 | `office-page.js` | 注入的 `bridge` + 快照 | 视图模型 | **无**（只消费） | **零 require**（契约） |

### 2.2 不允许的依赖方向（门禁强制）

- 纯内核模块**不得** require：`electron`、`pixi.js`、任何 DOM/UI 文件、`office-module.js`、`render/**`、网络模块、`node:fs`（唯一允许的内建是纯计算的 `node:crypto`）。
- `render/**` 与 `office-page.js` **不得**成为 Harness 事实来源：它们不订阅 Harness、不 import adapter、只消费 `state()` 快照。
- `office-module.js`（组合根）**不得**被 `src/office/runtime/**` 反向 import（防循环）。
- **纯内核当前没有任何壳边**（`GUARDED_SHELL_EDGES` 为空数组）。收尾阶段把 `tool-phrases.js` 需要的 9 条 zh 短语下沉进内核自带的冻结词表后，`tool-phrases.js` 已是零依赖模块，内核的 require 闭包完全落在 `src/office/runtime/**` 内 —— 门禁同时断言"零例外"与"闭包不越界"。机制（登记表）保留：未来若确有必要的例外，必须显式登记 `allows` 与理由。

### 2.3 纯内核模块清单（冻结）

`src/office/runtime/` 下 23 个纯模块（`KERNEL_MODULES`，定义在 `src/office/runtime/index.js`）：

`animation-controller`、`approval-risk`、`asset-pack`、`behavior-scheduler`、`dialogue-engine`、`employee-profile`、`employee-registry`、`follow-address`、`idle-director`、`movement-controller`、`office-layout`、`office-layout-compiler`、`pending-mirror`、`privacy-redactor`、`queue-controller`、`runtime-adapter`、`runtime-snapshot`、`state-reducer`、`subagent-classifier`、`subagent-wiring`、`tool-phrases`、`transition-controller`、`workstation-layout`

**显式 IO 边界模块**（`IO_BOUNDARY_MODULES`，同属产品代码但不属于纯内核）：

| 模块 | 允许的 IO | 理由 |
|---|---|---|
| `office-persistence.js` | `node:fs`、`node:path` | SPEC-08 存储单写者（`office-state.v1.json`） |
| `character-pack-installer.js` | `node:fs/path/zlib/crypto` | 角色包安装器 |
| `validate-character-pack.js` | `node:fs`、`node:path` | 角色包校验（CLI/安装期） |
| `usage-snapshot.js` | 经 `../../cost.js` 传递 | 只用到纯 `billingDayKey`，但静态边拖入 shell 的 fs |

> `src/office/behavior-graph/**` 是**开发期工具树**（创作工作台），已从 electron-builder 产物中排除（`electron-builder.js:56`），不属于产品内核。

---

## 3. 字段分类

### 3.1 raw（只允许存在于壳内）

| 字段 | 位置 | 说明 |
|---|---|---|
| `data.arguments`（工具参数） | `tool/call` | 只被 main.js 的 P3 detailRef 存储消费；**不进 adapter payload** |
| `data.content` / prompt 正文 | `user/message`、`assistant/message` | 不转发；`assistant-stream` 整帧不转发 |
| 原始 `runId` | `subagent/*` | 只用于内部配对与派生 proxy（§6.3） |
| raw `sessionId` | 全链 | 只在 `main.js` / `office-module` 内部；快照不含 |
| 完整路径、密钥、token 计数 | 任意 payload | 被脱敏器替换 |

### 3.2 redacted（进入 canonical payload 的形态）

adapter 在**哈希与发射之前**调用 `redactor.redactValue(raw.data)`（`runtime-adapter.js:298`）。`redacted` 模式下：
- 文本/参数/错误 → `[REDACTED:text]`；路径 → `[REDACTED:path]`；密钥 → `[REDACTED:secret]`；会话形状 → `[REDACTED:session-id]`；token 计数 → `[REDACTED:token-count]`
- 粗粒度枚举（状态、reason、activity、movement、currency、risk…）与**短枚举 token**（`^[a-z][a-z0-9_/-]{0,31}$`，如 `tool/call`、`bash`）原样保留
- 日历日 `YYYY-MM-DD`（billing day key）原样保留
- 数字原样保留（除非 key 命中 `/token/i`）

### 3.3 derived（adapter 派生，**绝不是 Harness 原生事实**）

| 字段 | 派生公式 | 位置 |
|---|---|---|
| `eventId` | `'sha256:' + sha256(sessionEpoch + sessionId + (seq ?? '') + eventType + canonicalJson(redactedPayload))` | `runtime-adapter.js` |
| `sessionEpoch` | `options.epoch`（仅第 0 代且显式提供）否则 `'adapter-' + counter + '-' + atMs.toString(36)` | `runtime-adapter.js` |
| `pairingHandle` | **首次 raw ingest 时**对 `subagent/start\|end` 的 `data.runId` 求 `deriveRunProxy`，结果写进 canonical envelope；其余事件恒为 `null`。**重放路径不再重新派生**（见 §6.3 / §11.6） | `runtime-adapter.js` |
| `sequenceSource` | `'upstream'`（有 `seq`）\| `'adapter'`（无 `seq`，用 adapterCounter） | `runtime-adapter.js` |
| `sequence` / `watermark` | 见 §6.4 | — |
| runId proxy | `'run-sha256:' + sha256(rawRunId).slice(0,16)` | `deriveRunProxy()` |
| `receivedAt` | 注入 fake clock 的 ISO 字符串 | `runtime-adapter.js` |
| `snapshot` / `resync` 消息 | DshCockpit 内部 `office:*` 命名空间 | `runtime-snapshot.js` |

**事件身份的输出面（Phase B，2026-10-18）**：adapter 的每次输出都携带 `sessionId`（恒存在）与 `envelope`（标识产出该 fact 的事件，无对应事件时为 `null`）；子会话的 **raw child handle** 通过 `adapter.rawChildHandleFor(envelope)` 按 **envelope 身份**反查。因此消费者**不再需要**"当前正在 ingest 哪条 raw 事件"这一位置性假设（见 §8.1-4）。

`adapter.describe().derivedFields` 如实声明三者：`['eventId', 'sessionEpoch', 'pairingHandle']`。
`ADAPTER_VERSION` 为 `task6-runtime-adapter-2`（v2 = envelope 增加 `pairingHandle`）。

### 3.4 presentation-only（表现层，非事实）

`activity`（本地日常）、`movement`、`animation.{resource,frameIndex}`、`presentation.heightRatio`、`bubble`、`marker`、`chatPhase`、`toolPhrase`/`toolPhraseKey`、`taskSeq`、`record`、`queueCount`/`waiting`、`transition.{kind,phase,outcome}`、`segment.kind`、`position`/`facing`/`seatNodeId`、`workstation.*`。

这些字段可以影响画面，但**永远不能**成为 `runtime` 维度的证据（§8）。

---

## 4. raw event 最小输入契约

`adapter.ingest(event)` 接受两种形状（`parseRawEvent`，`runtime-adapter.js:278-290`）：

```js
{ type, seq, time, data }              // 裸事件
{ event: { type, seq, time, data } }   // session.history / follow 包装（只解一层）
```

| 字段 | 必填 | 约束 | 违约码 |
|---|---|---|---|
| `type` | ✅ | 非空字符串 | `EVENT_SHAPE_INVALID` |
| `seq` | ❌ | 缺省 → adapter 编号；给则必须是 `>= 0` 的整数 | `SEQUENCE_INVALID` |
| `time` | ✅ | 有限 number（Unix epoch ms） | `EVENT_SHAPE_INVALID` |
| `data` | ✅ | 普通对象（非 null / 非数组 / 非类实例） | `EVENT_SHAPE_INVALID` |

payload 额外校验（在脱敏之前）：`canonicalJson` 必须可序列化（拒绝循环引用、`BigInt`、函数、`undefined`、非有限数、类实例）→ `PAYLOAD_NOT_SERIALIZABLE`；UTF-8 字节数 ≤ 64 KiB → `PAYLOAD_TOO_LARGE`。

**时间事实规则**：所有时间来自注入的 `clock.nowMs()`；adapter **绝不**使用 `Date.now()` / `setTimeout` 作为业务事实。

---

## 5. canonical envelope

```js
{
  schemaVersion: 1,
  eventId:       'sha256:<64 hex>',   // derived（§3.3）
  sessionId:     <opaque string>,     // 壳注入
  sessionEpoch:  'adapter-…',         // derived（§3.3）
  pairingHandle: 'run-sha256:<16 hex>' | null,  // derived（§3.3 / §6.3）
  sequence:      <int >= 0>,
  eventType:     <raw.type>,          // 原样透传（不改名）
  payload:       <脱敏后的 data>,
  sequenceSource:'upstream' | 'adapter',
  receivedAt:    <ISO-8601 from fake clock>,
}
```

字段顺序与集合被 `test/office-runtime-adapter.test.js` 与无 UI 探针逐字钉住；`runtime-snapshot.js` 的 `validateEnvelope` 会重新校验 `eventId` 形状、`schemaVersion`、`sequenceSource`、`pairingHandle` 形状等，任何快照里的 envelope 都必须符合本契约。

**`pairingHandle` 的版本策略**：它是**加性**字段，envelope `schemaVersion` **保持 1**，不升版。理由：
1. 缺省语义是 **fail-closed** —— 字段缺失或 `null` 都表示"没有可配对的运行 handle"，消费端据此拒绝配对（而不是猜一个 proxy），所以旧/外来 envelope 会**安全降级**，不会误配对；
2. 升版会让所有既有 v1 envelope 直接失效（`validateEnvelope` 是等值比较），是更严格且无收益的破坏性变更；
3. 版本兼容策略（§14）要求"新字段必须声明来源/默认值/兼容行为/隐私级别"——已在本节与 §6.3 声明。`ADAPTER_VERSION` 从 `-1` 升到 `-2` 作为可观测的变更标记。

**关键约束**：`eventType` **原样透传**，adapter 不改事件命名。映射到 fact 是另一层（§7）。

---

## 6. 派生属性

### 6.1 eventId
- 用**脱敏后**的 canonical payload 计算 → 同一事件在 `redacted`/`full` 两种模式下可能得到不同 eventId（这是有意的：内容不同）。
- 绑定 `sessionEpoch` → epoch 轮换后同一 raw 事件得到不同 id（旧 epoch 不会污染新 epoch）。
- 相同输入 + 相同 epoch → 稳定（确定性）。

### 6.2 sessionEpoch
- 缺省形状 `adapter-<counter>-<base36(ms)>`；`counter` 只在 `rotateEpoch()` 时递增。
- 显式 `options.epoch` **只在第 0 代**生效（供测试/多 adapter 对齐使用）。
- 轮换时清空：`watermark=0`、`adapterCounter=0`、`buffer`、`dedupe`、`activeRuns`，并自动发起一次 resync。

### 6.3 runId proxy 与配对 handle（replay-safe）
- 唯一映射入口 `deriveRunProxy(rawRunId)`（模块导出）。
- 输出 `run-sha256:<16 hex>`；**确定性**（epoch 无关）、**单向**（不可反推）。
- fail-closed → `null`：非字符串/空串/>255 字符、含空白、看起来像密钥（`sk-`/`Bearer `/`xox`/`gh[pousr]_`）。`null` handle 永不登记也永不关闭一次运行。
- raw runId **永不**出现在 facts / activeRuns / diagnostics / 快照 / envelope 里。

**派生时机与载体（收尾加固的核心变更）**：handle 在**首次 raw ingest** 时由 adapter 计算一次，写进 canonical envelope 的 `pairingHandle`；`mapEnvelope` 的 `subagent/start|end` 分支**只读 `envelope.pairingHandle`**，不再从 `rawData` 重新派生。原因：重放路径（`drainBuffer`、`acceptSnapshot` 的 `eventsSince`）交给 fact 映射的 `rawData` 是**已脱敏**的 payload，从中重新派生会哈希 `[REDACTED:session-id]` 占位符，得到一个与 live 登记不同的 proxy —— 这正是收尾阶段修复的 P0 缺陷（§16 C10）。

因此三条路径的配对结果**恒等**：
| 路径 | rawData | handle 来源 | 结果 |
|---|---|---|---|
| live ingest | 原始 payload | envelope（首次派生） | 正确 |
| `drainBuffer` 补发 | 脱敏 payload | envelope（随 buffer 携带） | 与 live 一致 |
| `acceptSnapshot` 重放 | 脱敏 payload | envelope（随 eventsSince 携带） | 与 live 一致 |
| 缺失 / 非法 handle | — | `null` / 校验拒绝 | **fail-closed**（不配对、不猜） |

**为什么把 handle 放在 envelope 上而不是 buffer 的 sidecar**：sidecar 只能覆盖"本 adapter 自己缓冲过的事件"。adapter 重启、或只拿到另一生产者给的 canonical `eventsSince` 列表时，sidecar 不存在——那会留下第二类同类缺陷。把派生结果写进 canonical 记录本身，配对就成为记录的属性，任何重放路径都不会再丢失它（这也是"不能只做 sidecar"的直接理由）。

### 6.4 watermark 与 sequence
- 初始 `watermark = 0`。
- **第一条可信 upstream 事件建立地板**：`watermark = seq - 1`（更早的 seq 静默视为冗余历史 → `STALE_SEQUENCE`）。这是刻意的：它使"后到达但 seq 更大"的事件不会把已应用的历史挤掉。
- `seq === watermark + 1` → 立即应用，然后 `drainBuffer()` 严格按序补发。
- `seq <= watermark` → `duplicate` / `STALE_SEQUENCE`（**水位优先于哈希**：同 seq 不同 payload 也丢弃）。
- `seq > watermark + 1` → **前跳**：缓存（≤64 条 / 2s TTL）+ `sync=resyncing` + 发起 resync 周期。
- 无 `seq` 的事件 → `sequenceSource='adapter'`，用 adapterCounter，**不参与水位**（立即发射）。

### 6.5 去重
- 键 = `eventId`；每 epoch 一张 LRU，容量 **4096**，TTL **10 分钟**（从首次见到起算，命中只刷新 LRU 位置、不刷新创建时间）。
- 命中 → `{status:'duplicate', code:'EVENT_DUPLICATE'}`。

---

## 7. runtime facts 的允许集合（冻结）

adapter `mapEnvelope`（`runtime-adapter.js:339-459`）**只能**产出以下 fact 形状；其余 eventType 只做 canonical 化，不产生任何 fact。

> 子代理 fact 的 `runId` 恒等于 `envelope.pairingHandle`（**不**从 payload 重新派生）——这是重放安全的关键（§6.3）。

| fact | 触发 | 字段 |
|---|---|---|
| `{type:'runtime/fact', fact:'running'}` | `agent/status.status==='running'` | — |
| `{type:'runtime/fact', fact:'idle'}` | `agent/status.status==='idle'` **且** `activeRuns.size===0` | — |
| `{type:'runtime/fact', fact:'completed', reason}` | `turn/end.reason==='completed'` | `reason` |
| `{type:'runtime/fact', fact:'failed', reason}` | `turn/end.reason` ∈ `{error, failed}` | `reason` |
| `{type:'runtime/fact', fact:'attention', reason}` | `turn/end.reason==='blocked'`，或未知/缺失 reason | `reason`（粗粒度保留） |
| `{type:'runtime/cancelled', evidence}` | `turn/end.reason` ∈ `{aborted, interrupted, cancelled}` | `evidence = 'turn/end:'+reason` |
| `{type:'runtime/tool', tool}` | `tool/call` | `tool`（共享提取器 `toolNameOfJournalData`，可 `null`） |
| `{type:'runtime/usage', usage, cost}` | `turn/usage` 且总量 > 0 | `usage:{input,output,cacheRead,cacheWrite}`（非负整数）、`cost` |
| `{type:'runtime/subagent-start', runId, sessionId, provider, role, mode}` | `subagent/start` | `runId`=proxy\|null；`role` 只接受白名单 `{researcher,coder,reviewer}` 否则 null；`mode` ∈ `{one-shot,continuable}` 否则 null |
| `{type:'runtime/subagent-end', runId, stopReason, outcome, terminal}` | `subagent/end` | 终态 `stopReason` ∈ `{completed,error,failed}`→`outcome` completed\|failed、`terminal:true`；∈ `{aborted,interrupted,cancelled}`→`cancelled`、`terminal:true`；**其它 → `outcome:'attention', terminal:false`** |
| `{type:'sync/status', sync}` | sync 变化 | `healthy\|resyncing\|stale` |
| `{type:'control/cancel-ack'}` | `noteCancelAcknowledged()` | — |
| `{type:'send-control', control}` | `requestControl()` 且 capability 通过 | — |

diagnostics 码（稳定枚举）：`EVENT_SHAPE_INVALID`、`SEQUENCE_INVALID`、`PAYLOAD_NOT_SERIALIZABLE`、`PAYLOAD_TOO_LARGE`、`EVENT_DUPLICATE`、`STALE_SEQUENCE`、`BUFFER_FULL`、`BUFFER_EXPIRED`、`IDLE_SUPPRESSED_ACTIVE_SUBAGENTS`、`AGENT_STATUS_UNKNOWN`、`SNAPSHOT_FACTS_UNSUPPORTED_KEY`、`SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE`。

**永不产出**：`offline`、`paused`、`resumed`、猜测的 `running/completed/failed`。

---

## 8. 权威矩阵（谁有权写什么）

`reduceOfficeState`（`state-reducer.js`）是唯一执行点。

| 维度 | Harness（runtime facts） | 本地行为（scheduler/idle） | Movement | Animation | 用户控制 | 过渡控制器 |
|---|---|---|---|---|---|---|
| `presence` | — | — | — | — | 只能请求 `present`（其它值 → `PRESENCE_OFFLINE_UNSUPPORTED`） | — |
| `sync` | adapter 的 `sync/status`（经模块聚合成 `globalSync`） | — | — | — | — | — |
| `runtime` | ✅ **唯一**权威：`runtime/fact`(running/attention/completed/failed/idle)、`runtime/cancelled` | ❌ | ❌ | ❌ | ❌（`control/dispatch` 只写 control/binding/queue） | ❌（`transition/complete` 只把终态收敛回 idle/unbound） |
| `activity` | 间接：running→working/thinking/waiting；attention 把 sleeping 唤醒为 working | ✅ 只能写 `roaming/chatting/resting/sleeping`（`local/activity`） | ❌ | ❌ | ❌ | `transition/complete` → roaming |
| `movement` | ❌ | ❌ | ✅ 唯一权威（`movement/status`） | ❌ | ❌ | 只发 `stop-movement` effect |
| `animation` | ❌ | ❌ | ❌ | ✅ 但**不是 reducer 状态**：`animation/select` 只产生 `animation-not-reducer-state` effect，选择由 `animation-controller` 独立解析 | ❌ | ❌ |
| `control` | ❌ | ❌ | ❌ | ❌ | ✅ dispatch/cancel/cancel-ack/preempt；pause/resume → `CONTROL_UNSUPPORTED` | — |
| `binding` | 间接：running 使 pending→bound；completed/failed→releasing；idle 使 releasing→unbound | ❌ | ❌ | ❌ | `control/dispatch`→pending | `transition/complete`→unbound |
| `queue` | ❌ | ❌ | ❌ | ❌ | `control/dispatch`（座位忙）→queued | `transition/complete` 且 queued → 启动下一项 |

**关键不变量**（探针逐条断言）：
1. 除 `runtime/fact` 与 `runtime/cancelled` 外，**没有任何**事件能把 `runtime` 写成 `running/completed/failed/attention`。
2. `local/activity` 只接受四个本地活动；`working/thinking/waiting/celebrating` 不在本地活动集合里 → `LOCAL_ACTIVITY_UNSUPPORTED`。
3. runtime 为 `running`/`attention` 时 `local/activity` 被拒（`runtime-priority`）；为 `completed`/`failed` 时被拒（`result-presentation`）。
4. `runtime/tool` 在 runtime 不是 `running` 时被拒（`TOOL_FACT_WITHOUT_RUNNING`）。
5. `presence` 恒为 `present`；`offline` 不存在。
6. `sleeping` 需 binding 为 `unbound` 且 sync 为 `healthy`（`SLEEP_BLOCKED_BINDING` / `SLEEP_BLOCKED_SYNC`）。
7. sync 异常**只**改 sync：不结束本地行为、不改 runtime/binding/terminal。

### 8.1 组合根的模块级派生（必须显式记录，避免误认为 Harness 事实）

这两条**不是** adapter fact，而是 `office-module.js` 的编排结论；契约把它们单列，避免以后误以为 Harness 提供了它们：

1. **分类子代理的 `running`**：`subagent/start` 带白名单 `role` 时，模块把该座位直接置 `running`（子代理没有可 follow 的子会话，拿不到自己的 `turn/start`）。见 `applyFact` 的 `runtime/subagent-start` 分支。
2. **`globalSync`**：所有 per-session adapter 的 sync 取**最坏值**（stale > resyncing > healthy），再广播成每员工的 `sync/status`。
3. **绑定 handle 的派生**：`sessionId` 是一次性的（`SESSION_BINDING_RELEASED` 之后同一 id 不能再绑定）。同一 raw 会话的下一个 turn 使用派生 handle `${rawSessionId}#tN`（N 为 orchestrator 的 turn 计数），映射表 `activeRootHandles` / `queuedRootHandles` / `rootHandleByDerived` 维护 raw ↔ handle 关系。因此**快照里的绑定 key 不是 raw sessionId**；`officeBoundSessionIds()` 统一用 `split('#')[0]` 归约回 raw id 去开 follow 流。
4. **子会话身份由事件身份驱动（Phase B，2026-10-18 定稿）**：两条来源都是身份驱动的，**没有任何位置性推断**：
   - `registry.childSessionIdForRunId(fact.runId)` —— 配对 handle → 子会话反查（replay 稳定）；
   - `adapter.rawChildHandleFor(envelope)` —— 按**该 fact 自己的 envelope 身份**反查 raw child id（覆盖"终态没有可配对 runId"的合法情形）。
   两条都拿不到 → fail-closed + `SUBAGENT_IDENTITY_UNRESOLVED` 诊断（不猜子会话、**不按当前座位强行关闭**）。

   历史（为什么必须去掉位置性假设）：adapter 的 `onEvent` 不携带"哪条 raw 事件产出了这条 fact"，旧实现因此依赖模块的 `currentRawEvent`（"正在 ingest 的那条"）。被 buffer 补发或被 canonical 重放的 fact 会在**另一条**事件的 ingest 期间同步触发，于是子会话身份会被错误归属。Phase B 删除了 `currentRawEvent`：身份只来自输出的 `sessionId`/`envelope` 与 identity-keyed 反查。门禁测试用**两个并发子代理**区分"身份驱动"与"位置驱动"（位置实现会把 A 的终态解析到 B）。

---

## 9. sync 语义：healthy / resyncing / stale

| 值 | 何时进入 | 允许的改变 | 禁止 |
|---|---|---|---|
| `healthy` | 初始；buffer 排空后（若此前是 resyncing）；resync 被接受且无 leftover | — | — |
| `resyncing` | 出现前跳并成功缓存 | 发 `office:runtime-resync-request`、`sync/status` | 猜任何 runtime/activity/binding/terminal 状态 |
| `stale` | 重试预算耗尽（5 次），或 buffer 超时清空 | **只**改 `sync` | 伪造 `offline`、结束本地行为、结束已绑定任务、猜终态 |

重试时间线（`runtime-snapshot.js:31-33`）：`250 / 500 / 1000 / 2000 / 4000 ms`，续延按指数封顶 **5000ms**，最多 **5** 次 → `stale`。请求 TTL **10s**（`RESYNC_REQUEST_TTL_MS`）。

`stale` 的**唯一**复位路径是 `rotateEpoch()`（模块在 `ingestHarnessSnapshot` 里对 stale 会话强制走 baseline restart）。

---

## 10. cancel ack 与 terminal evidence

这是契约里最容易出错的一条，分三层强制：

| 层 | 机制 | 位置 |
|---|---|---|
| fact 层 | `noteCancelAcknowledged()` 只发 `control/cancel-ack`；它**不是** `runtime/cancelled`。`runtime/cancelled` 只能由 `turn/end(aborted\|interrupted\|cancelled)` 产出 | `runtime-adapter.js:635-638` |
| registry 层 | `cancelAcknowledged()` 返回 `released:false` + `awaiting-terminal-evidence`；`releaseBinding`/`subagentEnd` 必须拿到**终态证据**，`NON_TERMINAL_EVIDENCE=['cancel-ack']` 永不释放 | `employee-registry.js:463-471, 623-688` |
| reducer 层 | `control/cancel` → `control='cancellationPending'`（保留 binding）；`control/cancel-ack` 只产生 `awaiting-terminal-evidence` effect、**不改状态**；`runtime/cancelled` 要求 `control` 已是 `cancellationPending`/`preemptPending`，否则 `CANCEL_EVIDENCE_WITHOUT_REQUEST` | `state-reducer.js:197-214, 134-144` |

**终态证据集合**（`employee-registry.js:56`）：`completed, error, failed, aborted, interrupted, cancelled`。子代理还额外要求 runId 与已登记关系匹配（`RUN_ID_MISMATCH` / `RUN_ID_UNVERIFIED`），否则 fail-closed。

### 10.1 evidence 字符串所有权（收尾加固）

规则：**evidence = `<source-event>:<coarse-reason>`，只在"同时知道来源事件类型与粗粒度原因"的那一层构造一次，下游永不重新限定。**

| fact | 构造层 | 形状 |
|---|---|---|
| `runtime/cancelled` | adapter（它把 `turn/end.reason` 映射成粗粒度原因） | `turn/end:<reason>`，如 `turn/end:aborted` |
| `runtime/subagent-end`（终态） | office-module（adapter 的 fact 暴露的是 `stopReason`，不是 evidence） | `subagent/end:<stopReason>` |
| `runtime/fact` completed/failed | office-module | `turn/end:<reason>` |

收尾阶段修掉的缺陷（§16 C11）：模块对 `runtime/cancelled` **又拼了一次** `turn/end:` 前缀，产出 `turn/end:turn/end:aborted`，污染 `lastResult.reason` 与 `binding.lastEvidence`。现在模块原样消费 `fact.evidence`。三条终态路径都由探针断言"单一来源限定前缀"。

**记录在案的不对称**（精确版）：`office-module.applyFact` 的 `runtime/cancelled` 分支走 `releaseTerminalNow()`，其中
- **registry 绑定释放是无条件的**（只要拿到终态 fact 就释放，不要求此前有过 cancel 请求）——权威是 **registry 的终态证据要求** + **fact 只能由真实终态原因产出**；
- **reducer 的 `runtime/cancelled` 收敛是有条件的**：仅当 `rec.state.control ∈ {cancellationPending, preemptPending}` 时才调用，否则保留 reducer 的 `CANCEL_EVIDENCE_WITHOUT_REQUEST` 语义（代码注释明确说明：host 侧直接中止时没有 shell 侧 cancel 请求，此时 reducer 的 binding 会停在 bound，而快照的绑定来自 registry、已经释放）。

因此 reducer 的 control 门是**纵深防御**，组合根的权威在 registry 层。探针分别断言两条路径（有 cancel 请求 / 无 cancel 请求的直接中止）。

---

## 11. snapshot / resync / replay 规则

### 11.1 消息形状（DshCockpit 内部，`office:*` 命名空间）

```js
// 请求
{ type:'office:runtime-resync-request', requestId, sessionId, sessionEpoch, fromSequence }
// 响应
{ type:'office:runtime-snapshot', requestId, sessionId, sessionEpoch, sequence, facts, eventsSince }
```

Harness **不**原生提供 snapshot/resync；它由壳基于 `session/page`（反向翻页）与 `session/follow` 开窗组合而成。

### 11.2 接受条件（`mergeSnapshot`）

1. `request.sessionEpoch === state.sessionEpoch`，且 `snapshot.sessionEpoch === state.sessionEpoch`（旧 epoch 响应**先于** request 匹配被拒，绝不允许污染新 epoch）。
2. `requestId` 必须命中当前 pending（新请求取代旧请求；迟到响应 → `NO_PENDING_REQUEST`）。
3. `sequence` 为 `>= 0` 整数，且不低于 `watermark` 与 `fromSequence-1`（否则 `SNAPSHOT_SEQUENCE_STALE`）。
4. `eventsSince` 必须同 session/同 epoch、严格递增、且全部 `> snapshot.sequence`。
5. `facts` 必须是普通对象（否则 `SNAPSHOT_FACTS_INVALID`）。

### 11.3 facts 白名单

只允许键 `runtime`，值 ∈ `{running, idle, completed, failed, attention}` → 映射为 `{type:'runtime/fact', fact:value}`。
未知**键** → `SNAPSHOT_FACTS_UNSUPPORTED_KEY`（带 key）；未知**值** → `SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE`，且诊断里 **value 恒为 `null`**（不回声，隐私底线）。未知值/键**不**阻断合并——降级为稳定诊断。

### 11.4 合并语义

- snapshot sequence 成为**新的连续水位**；缓冲中 `<= sequence` 的事件被吸收（不重放）。
- `eventsSince` 与缓冲同 seq 冲突时 **eventsSince 胜出**。
- 排序后只有 `=== watermark+1` 的连续前缀进入 `replay`；其余进 `leftover`（**永不猜洞**）。
- 调用方必须先发 sanitized facts（描述 snapshot 时刻的状态），再按严格序发 replay —— 且 facts 走 `{envelope:null, facts, diagnostics}` 通道，**绝不伪造成 Harness envelope**（不编造 eventId/sequence/eventType）。

### 11.5 模块级三种回填模式（`ingestHarnessSnapshot`）

| 模式 | 判定 | 行为 |
|---|---|---|
| `initial` | 该会话还没有 adapter | 记录逐条 ingest；第一条 seq 建立地板 |
| `continuation` | `records[0].seq <= watermark+1` 且 `sync !== 'stale'` | 增量 ingest；重叠部分去重；`drainBuffer()` 补发 |
| `baseline` | 开窗起点高于 `watermark+1`，或 adapter 已 stale | `rotateEpoch()` 重置；用**裸 baseline（sequence 0、无 facts）**回答轮换自己发出的请求；从**旧水位之上**的第一条记录重放（≤旧水位的不重放，避免双记）；中途被拒则再轮换一次吸收该 seq；无法到达断档起点时记 `RESYNC_BASELINE_PARTIAL` |

**顺序等价性**（探针断言）：同一组 journal 记录，(a) 顺序投递、(b) 把后一条提前投递（落在 buffer 窗口内再补前一条）、(c) 每条重复投递、(d) 作为开窗 baseline 重放 —— 四种方式的**归一化事实摘要必须一致**。

### 11.6 `acceptSnapshot(eventsSince)` 的重放语义（收尾加固后）

`mergeSnapshot` 完整实现了 `eventsSince` 重放（严格序、同 epoch、递增、事件序冲突以 eventsSince 为准、残洞留在 leftover）。生产调用点仍只有一个，且传的是**裸 baseline**：

```
office-module.ingestHarnessSnapshot → answerBare() → createSnapshotResponse({ sequence:0, facts:{}, eventsSince:[] })
```

即：壳的回填**一律走"原始 journal 记录逐条 `adapter.ingest()`"**（`initial` / `continuation` / `baseline` 三种模式）。`eventsSince` 是一条**已实现、契约化、被测试覆盖**的重放通道，当前不由产品路径驱动。

**重放安全性（本次加固的核心结论）**：

| 事实类别 | eventsSince 重放 | 说明 |
|---|---|---|
| `turn/end`、`tool/call`、`turn/usage` 等 | ✅ 与 live 等价 | 只读脱敏安全的字段（`reason` / `tool` / usage 数字） |
| `subagent/start\|end` 的**配对 handle** | ✅ 与 live 等价 | handle 随 envelope 携带，重放不再重新派生（§6.3） |
| `subagent/end` 的**子会话身份** | ✅ 当 handle 在 registry 有对应子会话时（即 start 走过 raw 路径） | 由 `registry.childSessionIdForRunId()` 反查 |
| 只有 canonical 重放的 `subagent/start` | ❌ **fail-closed**（可观测） | 没有 raw child id 可登记子会话；不猜、不伪造 |

**envelope 校验（隐私门）**：`validateEnvelope` 只接受 `pairingHandle` 为 `undefined` / `null` / `run-sha256:<16hex>`；任何其它值（例如被塞进重放列表的**原始 runId**）会让整个 envelope 被拒绝（`EVENTS_SINCE_INVALID`），因此 raw runId 不可能经由快照重放进入下游事实。

**残留边界（记录在案）**：一条只以 canonical 形式重放的 `subagent/start` 无法登记子会话（缺 raw child id），模块以 `SUBAGENT_IDENTITY_UNRESOLVED` 诊断 fail-closed。若 v1 要让该路径也完整工作，需要让 envelope 额外携带一个**不含原始标识**的子会话配对键（而不是把 raw session id 放进 envelope —— 那会破坏隐私边界）。

---

## 12. 隐私脱敏边界

- 默认 `privacyMode='redacted'`。同一个 `privacy-redactor.js` 服务：adapter 哈希前的 payload、快照、诊断、持久化、探针。
- **脱敏发生在哈希之前**（否则哈希会泄漏原文的可枚举性）。
- 快照是**白名单构建**的：员工对象只投影 `PRESENTATION_ALLOWLIST`（`displayName, role, taskLabel, marker, bubble, toolPhrase, toolPhraseKey, taskSeq, record, chatPhase`），其余字段过脱敏器；`activityLog`/`diagnostics` 是受控枚举词表，跳过形状启发式；`pending` 过 `PENDING_ALLOWLIST`。
- **原始 runId 从不出现在** facts / activeRuns / diagnostics / 快照 / canonical envelope —— 只有 proxy。envelope 上的 `pairingHandle` 是**已派生**的 proxy，不是原始值；`validateEnvelope` 只放行 `run-sha256:<16hex>` 形状，因此原始 runId 也无法经由快照重放混入（§11.6）。
- **明确允许进入快照的"技术标识"**：工具**名字**（如 `bash`，作为短枚举 token 与 zh 短语/`office.staff.currentTool.*` key 呈现）。工具**参数**永不进入。
- 已知脆弱点（记录在案，未修改）：脱敏器的形状启发式会把 `task-started` 这类受控 kind 误判为 `sk-` 密钥形状；模块通过"受控枚举词表跳过形状脱敏"绕过。任何新增受控枚举都要检查是否撞上 `SECRET_VALUE_RE`。
- **脱敏器的短 token 边界 —— 完整口径（2026-10-18 实测并逐条测试钉住，见 `test/office-privacy-redactor.test.js` 的 `boundary:` 系列）**：

  判定顺序是 **①值形状 → ②key 名清单 → ③枚举形状**：
  | 类别 | 结果 | 例 |
  |---|---|---|
  | 值形状命中（secret / UUID / 长 hex / `sess-`\|`run-`\|`agent-`\|`rpc-` 前缀 / 路径） | 脱敏（与 key 名无关） | `sess-child-y`、`run-abc12345`、UUID、`0123456789abcdef0123` → 占位符 |
  | key 名命中 session 清单（`session`\|`runid`\|`run_id`\|`agentid`\|`agent_id`\|`conversation`） | 脱敏（即使值是短 token） | `sessionId`/`runId`/`agentId`/`producerRunId` → 占位符 |
  | 枚举形状 `^[a-z][a-z0-9_/-]{0,31}$`（≤32 字符） | **原样保留** | `bash`、`tool/call`、`completed`、`one-shot`、`2026-10-18` |
  | 以上都不命中 | `[REDACTED:text]` | 33+ 字符的无形状串、含 `:` 的派生 id |

  **已记录的缺口**：`id` / `childId` / `child_id` **不在** session key 清单里，因此**短小写不透明 id 会原样保留** —— 而这正是 subagent payload 里子会话 id 所在的位置（`{id:'child-y'}` 保留；`{id:'sess-child-y'}` 脱敏）。同一规则也是"工具名可见"的原因，**是有意设计而非遗漏**。

  **为什么现在不改（决定 + 理由）**：`eventId = sha256(… + canonicalJson(**脱敏后** payload))`，即**脱敏规则是事件指纹的输入**。改脱敏 → 改 eventId → 改去重/水位行为（对进行中的会话尤其敏感），且会影响 adapter 哈希、快照、持久化、诊断与探针五处。因此它必须是**独立的、单独评估指纹影响**的变更，不能搭在 Team 接入里顺手做。候选修法（留给独立任务）：(a) 把 `id`/`childId` 加入 session key 清单（最小，但会让 `{id:'<enum>'}` 这类无意义字段一起脱敏）；(b) 引入**按字段语义**的规则（如"名为 `*Id` 且值不是已知枚举 → 脱敏"），需要同时定义"已知枚举"的判据。

  **给新字段的工程规则**：任何新的身份字段必须用**带前缀或 UUID 形状**（`art:<hex>` 这类含 `:` 的派生 id 既不属于枚举形状也不属于 session 形状，会被判为 `[REDACTED:text]`）。若第二阶段要把 Team 的 `artifactId` / `pairingHandle` 放进办公室快照，必须先做一次**显式的词表变更**（按字段语义放行），而不是指望形状规则放行。v0 的立场是"快照只放计数与摘要、不放 id"，因此当前无需变更。

---

## 13. capability gating

```js
capability() → { adapterVersion, runtimeVersion, supports:{…}, terminalEvidence:true }
```

- adapter 侧 `PROVEN_CONTROLS = ['cancel','interrupt','followup','steer','inject']`；`UNPROVEN_CONTROLS = ['pause','resume']`。
- `capabilityFor(name)`：proven → 默认 `true`，override **只能降级为 false**；unproven/未知 → **恒 false**。
- 模块侧 `PROVEN_CAPABILITIES` 再把 `interrupt` 降为 `false`（0.1.5 没有与"中断"对应的 RPC；`session/cancel` 是唯一停止原语）。快照 `capabilities` = 模块值与所有 adapter 值**逐键 AND**。
- 因此快照能力矩阵当前为：`cancel:true, interrupt:false, followup:true, steer:true, inject:true, pause:false, resume:false, preempt:false`。
- **`runtimeVersion`（收尾加固）**：壳把 ACTIVE 运行时版本（回落内置版本）经 `main.js → createOfficeModule({ runtimeVersion }) → ensureAdapter → createRuntimeAdapter` 注入，`capability().runtimeVersion` 因此如实报告所连运行时；未注入（纯模块装配/单测）时保持 `null` —— 不猜版本。它只服务诊断/体检，不进快照、不参与状态判定。可观测入口：`module.debugAdapterCapability()`（与 `debugRegistrySnapshot` 同一调试模式，无新 IPC 通道）。
- `requestControl({control})` 对未证明的控制返回 `CONTROL_UNSUPPORTED`；模块 `controlIntent` 对 `interrupt` 直接返回 `CONTROL_UNWIRED`，**不**产生任何 fact / 时间线 / 徽标（诚实失败，无安慰剂）。
- Office 的"紧急抢占"是 queue-controller 的组合动作（cancel → 等终态 → 派发下一项），**不是**原生 Harness 操作。

---

## 14. 版本兼容策略

| 版本常量 | 值 | 位置 |
|---|---|---|
| envelope / snapshot / 快照 `schemaVersion` | `1` | `runtime-adapter.js:315`、`runtime-snapshot.js:25`、`office-module.state()` |
| `ADAPTER_VERSION` | `task6-runtime-adapter-1` | `runtime-adapter.js:52` |
| 内核聚合版本 | `KERNEL_VERSION` / `KERNEL_SCHEMA_VERSION` | `src/office/runtime/index.js`（本次新增） |
| Harness 运行时版本 | `package.json.runtimeVersion`（`0.1.5-rc.2`） | 由壳持有 |

策略：
1. **事件命名不改**：`eventType` 原样透传；新增映射只加 `case`，不改已有枚举语义。
2. **状态枚举冻结**：8 维状态的取值集合只增不改（`PRESENCE_STATES` 等常量导出，测试钉住）。
3. **未知输入降级而非猜测**：未知 reason/stopReason → `attention`（保留粗粒度 reason）；未知 facts 键/值 → 稳定诊断；未知 eventType → 只 canonical 化、不产 fact。
4. **schemaVersion 变更必须走**：更新 SPEC → 更新契约测试 → 实现 → 验收证据（SPEC-00 的固定顺序）。
5. 旧 epoch 的事件与快照**永不**能改变当前状态（`EPOCH_MISMATCH` / 校验拒绝）。
6. 磁盘上的持久化 schema（`office-state.v1.json`）与内存 envelope schema 是**两个独立版本轴**，各自演进。

---

## 15. 当前明确不承诺的能力

1. **pause / resume**：无原生 RPC 与确认事件 → capability 恒 `false`，UI 不渲染；不得伪造 `paused` runtime 状态。`followup/steer` **不能**冒充"恢复同一运行态"。
2. **通用多代理编排**：现有子代理能力仅限"按有界元数据把子代理分到 3 个常驻工作座位 + 1 个协作者 FIFO"。**没有** Team DAG、任务依赖、跨代理结果聚合。
3. **跨设备协作**：无跨进程/跨设备状态同步、无分布式 epoch、无冲突合并。
4. **自动任务规划**：办公室不做规划/拆解/调度决策；`queue` 只是单 FIFO 的"排队/空"状态，不是规划器。
5. 此外不承诺：原生 `eventId`/`sessionEpoch`（永远是 adapter 派生）、Harness 原生 snapshot/resync、原生 preempt、离线态。

---

## 16. 审计发现：与现有文档/测试/实现的冲突

> 原则：发现冲突先记录差异，**不**默默重设计。

| # | 冲突 | 判定 | 处置 |
|---|---|---|---|
| C1 | 任务书要求阅读仓库根 `AGENTS.md`，但**根目录不存在** `AGENTS.md`（也无 `CLAUDE.md`）。仅 `studio/AGENTS.md` 存在，属开发期创作工具、不在产品范围 | 文档缺口 | 记录；本契约以代码为唯一事实来源。建议 v1 补一份根 `AGENTS.md` 或明确"以 SPEC-00..09 + 本契约为准" |
| C2 | `docs/superpowers/specs/2026-08-30-office-spec-00-boundaries.md:27-37` 冻结的目录布局（`src/office/ui/`、`test/office/`、`scripts/office-assets/`、`scripts/office-probes/`）与现状不符：页面/preload/html/css 直接位于 `src/office/`，office 测试是扁平 `test/office-*.test.js`，脚本目录已内化（见 `test/office-packaging-boundary.test.js` 的 P5 说明） | **superseded**（该布局段） | 标记为历史布局；本契约按**实际**布局冻结。SPEC-00 的状态词汇、来源契约、变更顺序仍然有效 |
| C3 | SPEC-05 正文只列 `250/500/1000ms`，实现是 `250/500/1000/2000/4000`（封顶 5000，最多 5 次） | 散文不精确，非契约冲突（SPEC 同时写了"封顶 5s""最多 5 次"） | 本契约以实现的冻结时间线为准 |
| C4 | 研究文档的 `TurnEndReasonMap` 为 `completed/aborted/blocked/error/max-tokens/interrupted`；实现额外接受 `failed` 与 `cancelled`，且 `max-tokens` → `attention`（不是 failed） | 实现是超集且降级更保守 | 记录为**有意**：未知/未列原因一律降级 `attention`，绝不猜 failed |
| C5 | 研究文档称 `agent/status` 是原生事件；实现里 0.1.5 journal 已无该事件，`turn/start` 由壳翻译成 `agent/status{running}` | 版本差异，已被壳吸收 | 记录：adapter 词表保留 0.1.x 形状，翻译层在 `main.js` |
| C6 | 分类子代理的 `running` 与 `globalSync` 不在 adapter facts 允许集合里（§7），但确实驱动办公室状态 | 组合根派生，非契约违背 | §8.1 显式单列，避免误认为 Harness 事实 |
| C7 | `adapter.capability().runtimeVersion` 在实现里**恒为 `null`**：`ensureAdapter` 从不注入 `runtimeVersion`（尽管 main.js 持有 `manager.getInfo().activeVersion`） | 真实缺口（非冲突） | §17-2，建议 v1 接线；本任务不改行为 |
| C8 | `runtime/tool-phrases.js` 静态可达 `electron`（经 `../../i18n.js`，但 `i18n.js` 的 electron require 是函数内 try/catch 惰性） | 边界"静默污染"风险 | ✅ **已修复**（收尾阶段 P1）：9 条 zh 短语下沉为内核自带的冻结词表 `PHRASE_ZH`，`tool-phrases.js` 变为零依赖；`GUARDED_SHELL_EDGES` 清空，门禁改为断言"零例外 + 闭包不越界"。i18n 字典未改动，双语一致性由 `office-right-panel-p1.test.js` 的漂移钉保证 |
| C9 | 脱敏器形状启发式会把 `task-started` 误判成 `sk-` 密钥形状 | 已知脆弱点，已有绕过 | §12 记录；新增受控枚举需自检 |
| **C10** | **`drainBuffer` 与 `acceptSnapshot` 重放时把已脱敏 payload 当作 rawData**，于是 `runId` 会退化成占位符的哈希：**被缓冲的子代理 `end` 无法释放由 live `start` 登记的绑定**（registry 以 `RUN_ID_MISMATCH` 失败关闭，座位停在 running/bound，只留下一条诊断） | **真实缺陷**（已定位：replay 路径重新派生配对 handle） | ✅ **已修复**（收尾阶段 P0）：handle 首次派生后写入 envelope 的 `pairingHandle`，重放只读该字段；子会话身份改由 `registry.childSessionIdForRunId()` 反查 + `correlatedChildId()` 一致性判据；无法解析时 fail-closed + `SUBAGENT_IDENTITY_UNRESOLVED`。见 §6.3 / §8.1-4 / §11.6 |
| **C11** | `runtime/cancelled` 的 evidence 被拼成 `turn/end:turn/end:<reason>`（adapter 的 fact 已自带前缀，组合根又加一次） | 输出污染（`lastResult.reason` / `binding.lastEvidence`） | ✅ **已修复**（收尾阶段 P2）：模块原样消费 adapter 的来源限定 evidence；所有权规则见 §10.1 |
| C12 | `office-module.js` 的 `runsByProxy` 只写不读（proxy → childSession 的映射从未被消费，也不随 `destroy()` 清理） | 死状态 + 无界增长 | ✅ **已修复**（2026-10-18 收尾）：静态确认全仓仅"声明 + 1 处写入、0 处读取、不暴露、无测试引用"后**删除**；子会话身份的权威反查只由 `registry.childSessionIdForRunId()` 承担（不再有两个映射表都声称负责身份关联） |

**无冲突的确认项**：`FEATURES.md` 声明的 1514 项测试与实测一致（1514 pass / 0 fail）；`office:*` 通道恰好 8 个；快照 schemaVersion 1；四个常驻 + 单协作者；`eventId`/`sessionEpoch` 从未被任何活跃文档声称为 Harness 原生。

---

## 17. 已知缺口与 v1 建议（本次收尾**未**实现的部分）

> 收尾阶段已闭环的三项（P0 重放配对、P1 内核壳边、P2 诊断字段）见 §16 C8/C10/C11。以下是**剩余**项。

1. **只以 canonical 形式重放的 `subagent/start` 无法登记子会话（P1）**：见 §11.6 的"残留边界"。要让该路径完整工作，需要给 envelope 增加一个**不含原始标识**的子会话配对键；**不要**把 raw session id 放进 envelope。当前行为是 fail-closed + `SUBAGENT_IDENTITY_UNRESOLVED` 诊断。
2. ~~**fact ↔ raw 事件关联是位置性的**~~ → ✅ **已闭环**（2026-10-18 Phase B）：adapter 的每次输出携带 `sessionId`（恒存在）与 `envelope`（产出事件身份），raw child handle 由 `rawChildHandleFor(envelope)` 按身份反查；模块的 `currentRawEvent` 已**删除**。见 §3.3 / §8.1-4。
3. ~~**`runsByProxy` 死状态**~~ → ✅ **已闭环**（2026-10-18 收尾）：已删除（见 §16 C12）。
4. **`runtime/cancelled` 绕过 reducer control 门（P3）**：当前由 registry 终态证据兜底。若 v1 要收紧，建议在 `applyFact` 的 cancelled 分支也校验 `control`，但需先评估"cancel 请求因 RPC 失败未记录 control 却收到真实终态"的合法场景，避免把真实终态误拒。
5. **单 FIFO 的 `queue` 维度**：`queue` 只有 `empty|queued`，不含位置/优先级；且协作者派发路径只 reduce `queue/enqueue` 而没有 `queue/dequeue`，该维度会停在 `queued`（快照不投影它，故不影响画面）。Team 编排落地前不应扩张该枚举。
6. **`subagent-wiring` 的 label 日志**：`boundedLogLabel` 把模型生成的 label 写进壳日志（截断 80 字符）。它是结构化元数据而非任务正文，但仍是唯一进入日志的模型文本；v1 若收紧隐私，应改为只记长度/命中规则。

---

## 18. 本契约如何被持续校验

| 校验 | 文件 | 覆盖 |
|---|---|---|
| 无 UI 内核探针 | `test/harness-runtime-kernel-probe.test.js` | 全链（running/tool/subagent/usage/完成/取消/失败/断档/resync replay）、顺序等价性、隐私不泄漏、本地行为与动画不能伪造 runtime 事实、稳定摘要，以及 P0 的三条配对路径（`P0-A` buffer 补发 / `P0-B` live start + canonical end 重放 / `P0-C` 无法解析身份时 fail-closed）与 P2 的单一 evidence 前缀 |
| 依赖边界门禁 | `test/office-runtime-boundary.test.js` | 内核模块清单与实际目录**集合相等**、无 electron/DOM/Pixi/UI/网络/fs 越界、**零壳边**（`GUARDED_SHELL_EDGES` 为空 + 闭包不越界）、renderer/page 只消费不生产、无循环依赖、main.js 翻译契约未漂移 |
| 组合根回归 | `test/office-runtime-checkup.test.js` | P2 的 `runtimeVersion` 注入链路、P0 的"缓冲终态经回填补发后释放座位"（真实 office-module 端到端）、身份无法解析时的 fail-closed + 诊断 |
| 事件身份（Phase B） | `test/office-runtime-adapter.test.js` 的 `B:` 系列 | 每次输出都带 `sessionId`；raw child handle 按 envelope 身份反查（含**两个并发子代理**的区分性用例）；duplicate 不携带 envelope 且不扰动身份账本；canonical-only 重放解析为 null（fail-closed、无泄漏） |
| 既有契约测试 | `test/office-runtime-adapter.test.js`、`office-runtime-snapshot.test.js`、`office-state-reducer.test.js`、`office-privacy.test.js`、`office-resync-backfill.test.js`、`office-subagent-wiring.test.js`、`office-task-end-recovery.test.js`、`office-transition-loop.test.js`、`office-five-workers-positions.test.js`、`office-right-panel-p1.test.js`、`office-doc-contract.test.js` | 逐条细节（本契约是它们的**汇总视图**，不取代它们）；`office-right-panel-p1.test.js` 另有内核 `PHRASE_ZH` ≡ i18n zh 字典的漂移钉 |

契约变更流程（继承 SPEC-00）：更新本文件 → 更新对应测试 → 改实现 → 补证据。三者任一未同步，视为契约漂移。
