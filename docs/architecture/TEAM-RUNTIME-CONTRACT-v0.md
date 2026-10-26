# Team Runtime 契约 v0（Headless / 单根任务纵向闭环）

> 状态：**v0 草案冻结**（2026-10-18，Team v0 第一阶段）。
> 事实来源：当前实现 `src/team/runtime/{team-schema,team-runtime}.js` + 本仓库既有内核契约。
> 调研依据：[`docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md`](../research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md)（**第二版，2026-10-18 重做**：实测 **58 个** Agent Team / 多代理团队 / bot 类仓库的元数据，主线短名单 20 项 + 6 个深度对象 + 博客/文章/教程 5 篇；口径说明见报告 §0）。
> 上游契约：[`HARNESS-RUNTIME-CONTRACT-v0.md`](./HARNESS-RUNTIME-CONTRACT-v0.md)（本契约不修改它，只在其之上建立 Team 层）。
> 校验：`test/team-runtime-v0.test.js`（headless）+ 既有边界门禁。

## 0. 范围

**是**：一个**无 UI、纯 Node、可测试**的 Team Runtime：一个 root Job、两种角色（researcher / reviewer）、一条固定依赖（reviewer 依赖 researcher）、artifact 的产出与消费、显式终态证据、幂等与确定性。

**不是**：Team UI、五代理 DAG、自动 Planner、LLM 调用、prompt 模板、新 provider、文件系统写入、Electron/DOM/Pixi 依赖、把 Team 状态写进 office 的 `runtime` 枚举或 `office-module.js`。

**阶段边界**：v0 只做**纵向闭环 + 契约**。办公室消费 Team facts 属于**第二阶段**，本契约只声明责任矩阵与消费前提。

---

## 1. 术语与命名边界（含已存在的命名冲突）

| 术语 | 含义 | 不得与之混淆 |
|---|---|---|
| **Role** | Team 的任务角色（`researcher` / `reviewer`），Job 内的职责标签 | **不是**办公室座位（Seat）。office 的 `researcher/coder/reviewer/collaborator` 是**物理座位**（表现层）；Role 是任务层。v0 二者**互不写入**。 |
| **Job** | 一次编排实例（一个 root 任务及其角色图） | **不是** office 的 session/turn；也不是 Harness 的 session。 |
| **WorkerRun** | 一个 Role 在 Job 内的一次执行尝试 | **不是** office 的 binding，也不是 Harness 的 subagent run（后者只作为终态证据来源）。 |
| **ArtifactRef** | 角色间**唯一**的产物通道（引用，非内容） | **不是**文件、路径或 prompt。 |
| **Seat** | 办公室的物理座位（office 层概念） | Team Runtime v0 完全不引用它。 |

### 1.1 命名冲突（已实测，显式声明不覆盖）

1. **`team/*` 已被 Harness 占用**：Harness 的 `SessionEventMap` 含 `team/*` 事件域（见 `docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md:63`）。**DshCockpit 的 Team Runtime 不占用 `team/*`**——内部消息命名沿用仓库既有的 `office:*` 内部命名空间风格（如 `team:runtime-*`），Team 事实类型使用本契约 §4 定义的 `job/*`、`run/*`、`artifact/*` 前缀（与 Harness 的 `turn/*`、`tool/*`、`subagent/*` 无重叠）。
2. **`src/team/` 目录不存在**（实测），可安全新建；`team` 一词在 `src/` 中只出现于无关位置（`mcp-registry.js` 的 `SLACK_TEAM_ID`、`settings.html` 的提示词模板）。
3. **`queue` 维度不扩张**：office 的 `state-reducer.QUEUE_STATES` 只有 `empty|queued`，**Team 不得扩张它**（§10 责任矩阵）。

---

## 2. 数据模型

### 2.1 Role（v0 冻结枚举）

```js
'researcher' | 'reviewer'
```

v0 **只有这两个**。`orchestrator`/`coder`/`collaborator` 是 office 座位概念，Team v0 不使用。Role 是**固定枚举**，不来自模型、不来自 Harness、不可运行时注册（禁止自动拆解）。

### 2.2 Job

```js
{
  jobId:      <opaque non-empty string>,   // 调用方提供；Team 不生成随机 id
  plan:       [{ role, dependsOn: [role…], produces: [kind…], consumes: [kind…] }],
  status:     <JobStatus>,
  createdAtMs:<fake clock>,
  endedAtMs:  <fake clock> | null,          // 仅终态时设置
  terminalEvidence: { source, reason, atMs } | null,
  runs:       { [role]: WorkerRun },        // 每个 role 至多一个 v0 活跃 run
}
```

- `plan` 由调用方**显式给出**（v0 只接受 `TEAM_V0_PLAN`，见 §5.1）；Runtime **不推导**计划。
- `jobId` 不生成、不哈希、不进任何对外输出（它是内部句柄）。

### 2.3 WorkerRun

```js
{
  runId:      `${jobId}:${role}:${attempt}`,  // 确定性派生
  jobId:      <string>,
  role:       <Role>,
  attempt:    <int >= 1>,                     // 重试次数；v0 恒为 1（见 §7 幂等 vs 重试）
  status:     <RunStatus>,
  dependsOn:  [role…],                        // 从 plan 复制，运行时只读
  dispatchedAtMs: <fake clock> | null,
  startedAtMs:    <fake clock> | null,
  endedAtMs:      <fake clock> | null,
  cancelRequestedAtMs: <fake clock> | null,   // 请求 ≠ 终态
  consumedArtifactIds: [artifactId…],
  producedArtifactIds: [artifactId…],
  terminalEvidence: { source, reason, atMs } | null,
  attention:  { reason, atMs } | null,        // 非终态
}
```

### 2.4 ArtifactRef

```js
{
  artifactId:   'art:<16 hex>',   // 确定性派生：sha256(jobId|runId|kind).slice(0,16)
  jobId:        <string>,
  kind:         <ArtifactKind>,   // v0 固定枚举
  producerRunId:<string>,         // 生产者 run（由 artifactId 的派生式隐含，且显式携带以便校验）
  producerRole: <Role>,
  digest:       'art-sha256:<16 hex>',  // 形状标记；v0 不承载真实内容哈希（§8 隐私）
  availableAtMs:<fake clock>,
  consumedBy:   [runId…],
}
```

`ArtifactKind`（v0 固定枚举）：`research-notes`（researcher 产出）、`review-findings`（reviewer 产出）。

**关键约束**：`ArtifactRef` **只携带引用**——不含内容、不含路径、不含 prompt、不含工具参数。它对应调研中 Argo 的 `outputs.artifacts` 引用形状 + REAPI 的 Digest 形状，但**不引入 CAS**（§8）。

---

## 3. status 枚举

```js
RunStatus = 'pending' | 'dispatched' | 'running' | 'attention' | 'completed' | 'failed' | 'cancelled'
JobStatus = 'pending' | 'running' | 'attention' | 'completed' | 'failed' | 'cancelled'
TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled']
TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled']
```

规则：
- `attention` **不是终态**（Temporal/Argo 的终态都是"不可再变"的；attention 可回到 `running`）。
- `dispatched` 与 `running` **分开**：`dispatched` = 已交给执行方，`running` = 执行方已确认开始。这直接继承调研里 Temporal `ActivityTaskScheduled` → `ActivityTaskStarted` 与 REAPI `QUEUED` → `EXECUTING` 的分离。
- **`ready` 不是状态**，而是**派生查询** `readyRoles()`：一个 `pending` run 当且仅当 §5 的依赖条件全部满足时才是 ready。这样"依赖未满足"天然表现为"不在 readyRoles 里"，而不是一个新状态。

---

## 4. 事件（fact log）

Team Runtime 是**纯函数 fold**：`state = fold(facts)`，`facts` 是 append-only 日志，状态**不独立存储**。这与调研结论一致（Temporal 的 Event History、DeepSeek Harness 的 durable session log、LangGraph 的不可变 checkpoint）。

每条 fact：

```js
{ jobId, seq, type, atMs, ...payload }
```

`seq` 由 Runtime 单调分配（从 1 开始，每 job 独立），**调用方不能指定**——因此"乱序输入"不可能重排事实（Runtime 是事实的唯一作者）。

| 事件 | 触发命令 | payload | 状态影响 |
|---|---|---|---|
| `job/created` | `createJob` | `{plan}` | job `pending`，所有 run `pending` |
| `run/dispatched` | `dispatchRun` | `{runId, role}` | run → `dispatched`；job → `running` |
| `run/started` | `startRun` | `{runId, consumedArtifactIds}` | run → `running` |
| `artifact/available` | `noteArtifact` | `{artifactId, kind, producerRunId, producerRole, digest}` | 记录到 producer 的 `producedArtifactIds` |
| `run/completed` | `noteRunTerminal({outcome:'completed'})` | `{runId, evidence}` | run → `completed`（终态） |
| `run/failed` | `noteRunTerminal({outcome:'failed'})` | `{runId, evidence}` | run → `failed`（终态） |
| `run/cancelled` | `noteRunTerminal({outcome:'cancelled'})` | `{runId, evidence}` | run → `cancelled`（终态） |
| `run/attention` | `noteRunAttention` | `{runId, reason}` | run → `attention`（**非终态**） |
| `run/cancel-requested` | `requestCancel` | `{runId}` | **不改 status**；记 `cancelRequestedAtMs` |
| `run/cancel-acknowledged` | `noteCancelAcknowledged` | `{runId}` | **不改 status**（仅回执） |
| `job/completed` / `job/failed` / `job/cancelled` / `job/attention` | 由 fold 自动收敛 | `{evidence}` | job → 对应终态 / attention |

> **注意**：`job/*` 收敛事件由 Runtime 在 fold 时**自动派生**并追加（不是调用方命令），这样 root 终态永远是"所有子 run 的事实"的函数，而不是某人可以声明的。

---

## 5. dependsOn 规则

### 5.1 v0 计划（唯一被接受的形状）

```js
TEAM_V0_PLAN = [
  { role: 'researcher', dependsOn: [],            produces: ['research-notes'],  consumes: [] },
  { role: 'reviewer',   dependsOn: ['researcher'], produces: ['review-findings'], consumes: ['research-notes'] },
]
```

**任何其它 plan 一律 fail-closed 拒绝**（`PLAN_UNSUPPORTED`）。这是"禁止任意任务自动拆解"在契约层的落点：v0 的图是**常量**，不是输入。

### 5.2 依赖满足判定（`readyRoles()`）

一个 `pending` run 是 ready，当且仅当**同时**满足：

1. **每个 `dependsOn` 的 run 都是 `completed`**（不是 failed / cancelled / attention / dispatched / running / pending）；
2. **每个 `consumes` 的 kind，都存在一个 `ArtifactRef`，其 `producerRole` ∈ 该 run 的 `dependsOn`**（即产物必须来自被依赖的角色）。

规则 1 是**有意比 Argo 更严**的：Argo 的默认 `dependencies` 语义是 `(Succeeded || Skipped || Daemoned)`——"上游没失败就放行"；本契约要求上游**必须成功**，因为任务明确要求"researcher failed/cancelled 时 reviewer 不得启动"。这对应 Argo 自己区分开的 `Fulfilled`（完成或跳过/省略）与 `Completed`（真正完成）——我们只认后者。

`dispatchRun` 对非 ready 的 run **fail-closed 拒绝**（`DEPENDENCIES_UNSATISFIED`），且**不追加任何事实**。

### 5.3 plan 就是 handoff contract；effort budget 是常量

调研结论直接决定了这两条（见调研报告 §3「博客/文章」）：
- **"Handoff contracts in writing. Artifacts passed between roles follow a schema."** → 本契约把
  `plan[].produces` / `plan[].consumes` 定义为**交接 schema**，并在运行时**双向强制**（§6-4/§6-5）：
  只声明不校验等于没有契约。
- **"Effort scaling rules 必须写死在配置里，不能留给 agent 自行决定"**（Anthropic 工程文）
  且多代理成本约为单代理对话的 **15 倍**、"结构比规模重要" → v0 把预算写成常量
  `TEAM_V0_BUDGET = { maxRuns: 2, maxArtifacts: 2, maxFacts: 4096 }`，并由测试断言它与 plan
  形状一致：**plan 变宽而不改预算会让测试失败**。这是"禁止任意自动拆解"的第二道锁
  （第一道是 §5.1 只接受常量 plan）。

### 5.4 边与产物的粒度

v0 的依赖边是 **role → role**（`dependsOn`），产物契约是 **kind → kind**（`produces`/`consumes`）。
这是有意比 CrewAI 的 `Task.context`（指名"哪些 task 的输出作为上下文"）更粗的一档：v0 每个角色
只有一次 run、每种产物只有一个槽位，因此 role/kind 粒度已无歧义。v1 若要一对多或并行扇出，
必须先给边加上具体的 artifactId 绑定（并升 `schemaVersion`）。

---

## 6. Artifact producer / consumer 规则

1. **只有 `running` 的 run 能产出 artifact**：`noteArtifact({runId, kind, digest})` 要求该 run 的 status 是 `running`，否则 `ARTIFACT_PRODUCER_NOT_RUNNING`（fail-closed，不追加事实）。
2. **`artifactId` 由 Runtime 派生**：`'art:' + sha256(jobId|runId|kind).slice(0,16)`。调用方**不能提供** artifactId——因此"伪造生产者"在结构上不可能：id 本身编码了生产者。
3. **kind 必须属于该 role 的 `produces`**：researcher 只能产出 `research-notes`，reviewer 只能产出 `review-findings`；否则 `ARTIFACT_KIND_NOT_OWNED`。
4. **消费必须来自被依赖的生产者**：`startRun({runId, consumedArtifactIds})` 中每个 id 必须
   (a) `available`（否则 `ARTIFACT_UNKNOWN`）、(b) `kind` ∈ 该角色 plan 声明的 `consumes`
   （否则 `ARTIFACT_NOT_CONSUMABLE` —— 这是 handoff schema 的方向一）、(c) `producerRole` ∈
   该 run 的 `dependsOn`、且 `producerRunId` 与派生式一致（否则 `ARTIFACT_NOT_CONSUMABLE`
   —— 生产者不可伪造）。
5. **交接必须完整（方向二）**：plan 声明要消费的**每个** kind 都必须真的出现在
   `consumedArtifactIds` 里，否则 `HANDOFF_INCOMPLETE`。没有这条，"依赖已满足"就能靠
   **只消费一部分**来伪造 —— 只校验"给的都在"而不校验"该给的都给了"是一个真实缺口
   （2026-10-18 依据调研补上）。
6. **同一 (runId, kind) 至多一个 artifact**：重复产出同一 kind → `duplicate`（幂等吸收），不产生第二条事实。
7. artifact **一旦 available 不可撤销、不可改写**（对应 REAPI 的内容寻址不可变性与 LangGraph 的 checkpoint 不可变）。

---

## 7. terminal evidence 规则

1. **终态只能由 `noteRunTerminal` 产生**，且必须携带 `evidence`：
   - `outcome` ∈ `{completed, failed, cancelled}`，否则 `INVALID_OUTCOME`；
   - `evidence` 必须是**来源限定的非空字符串**（`<source-event>:<reason>`，如 `turn/end:completed`、`subagent/end:completed`），复用 office 内核已冻结的 evidence 所有权规则（见上游契约 §10.1）。缺失/空串 → `TERMINAL_EVIDENCE_REQUIRED`（fail-closed）。
2. **每个 run 恰好一个终态事实**：已终态的 run 再收到终态 → `duplicate`（同 outcome）或 `ALREADY_TERMINAL`（不同 outcome，fail-closed 拒绝）。这对应 Temporal/Argo 的单一终态不变式。
3. **`cancel-ack` 绝不是终态证据**：`noteCancelAcknowledged` 只追加 `run/cancel-acknowledged`，**不改变 status**（继承上游契约 §10 与 `employee-registry.NON_TERMINAL_EVIDENCE` 的实证规则）。
4. **`attention` 不是终态，也不会自动变 completed**：`noteRunAttention` 只把 run 置 `attention`；从 attention 恢复必须由调用方显式 `startRun`（或 `noteRunTerminal` 带证据）。**没有任何路径能从 attention 直接到 completed。**

   **与"子代理自评估"的区别（必须记住，否则第二阶段会混淆）**：Anthropic 的 orchestrator-worker
   里，子代理会**自评估进度后继续**（"self-loop… without waiting for the lead agent to review"）——
   那是**不阻塞**的。本契约的 `attention` 是**阻塞**的审批闸（对应 OpenHands 的 confirmation
   mode：高风险动作在执行前必须拿到确认）。因此 `attention` 必须挂住 root、必须显式恢复，
   **不能**被"自评估通过"顶掉。
5. **root 终态只能由事实收敛**：
   - `job/completed`：**所有** role 的 run 都是 `completed`；
   - `job/failed`：任一 run `failed`；
   - `job/cancelled`：任一 run `cancelled`；
   - `job/attention`：无 failed/cancelled，但任一 run 是 `attention`；
   - 否则 job 保持 `pending`/`running`（**缺少可信终态时 root 绝不 completed**）。
   优先级：`failed` > `cancelled` > `attention` > `completed`（即"任一失败即失败"，不会被"其它都完成了"覆盖）。
6. `job/*` 收敛事实由 Runtime 追加，`terminalEvidence.source` 记 `'team:convergence'`。

---

## 8. 幂等、乱序与重复事件规则

1. **命令幂等键**：每条命令由 Runtime 派生 `dedupeKey = sha256(jobId|runId|type|outcome|evidence|digest).slice(0,32)`（对 createJob 用 `jobId|created`）。同一 `dedupeKey` 的重复命令 → `{status:'duplicate'}`，**不追加事实、不改状态**。
2. **乱序输入**：`seq` 由 Runtime 分配，因此输入顺序**不能**重排事实。语义上：
   - 对 `pending`/未 dispatch 的 run 发终态 → `RUN_NOT_DISPATCHED`（fail-closed）；
   - 对未知 runId → `UNKNOWN_RUN`（fail-closed）；
   - 重复 `dispatchRun` → `duplicate`（**绝不第二次启动**，对应测试"out-of-order 不重复启动"）；
   - `startRun` 对非 `dispatched` 的 run → `RUN_NOT_DISPATCHED`。
3. **重放**：`replay(facts)` 必须产生与在线运行**逐字相同**的状态（`state()` 是 `fold(facts)` 的纯函数）。Runtime 不保留任何不在事实里的可变状态（唯一例外：`seq` 计数器与 `dedupeKey` 账本，二者都是 `fold` 可重建的）。
4. **不持久化**（v0 显式声明）：Runtime 是**内存态**；进程结束即丢失。这与 LangGraph 的 `exit` durability 档等价，属**有意的 v0 范围**，不是遗漏。持久化若加入必须升 `schemaVersion` 并先更新本契约。
5. **有界**：内部账本有上限（`FACTS_MAX`），超限 fail-closed 拒绝新命令而不是静默丢弃（避免"悄悄丢事实"）。

---

## 9. 隐私边界

1. Team facts **只允许**出现：固定枚举（role/kind/status/outcome）、确定性派生 id（runId/artifactId/digest）、来源限定 evidence 字符串、fake-clock 毫秒数、`jobId`。
2. **绝不允许**：prompt、任务文本、模型输出、文件路径、工具名/参数、token 计数、API key、raw session id、raw runId、cookie、任何 Harness 原始 payload。
3. Team Runtime **不接收也不转发** Harness 原始事件；它只接收调用方给出的**粗粒度命令**（终态证据字符串是唯一从 office 层透传的文本，且必须是 `<source>:<reason>` 形状、受长度上限约束）。
4. artifact **只传引用不传内容**——这是与 Argo（路径）/REAPI（CAS 内容）刻意不同的地方（§8.1 调研结论）。
5. 边界与上游一致：Team 事实**不进** office 快照（第二阶段若消费，必须走 office 的白名单 + 共享脱敏器，且不得引入原始标识）。

---

## 10. Team Runtime 与 Office Runtime 的责任矩阵

| 关注点 | Office Runtime（现有） | Team Runtime（v0 新增） |
|---|---|---|
| 事实来源 | Harness durable session log（唯一） | **调用方命令**（v0 不直接订阅 Harness） |
| 事实类型 | `runtime/*`、`sync/status`、`control/*` | `job/*`、`run/*`、`artifact/*` |
| 状态维度 | `presence/sync/runtime/activity/movement/control/binding/queue` | `JobStatus` / `RunStatus`（**独立维度，不写入 office**） |
| 座位/绑定 | `employee-registry`（Seat ↔ session） | **不使用 Seat**；Role 是任务标签 |
| 队列 | `queue-controller` 单 FIFO（`empty|queued`） | **不改动**；依赖图在 Team 内部判定 |
| 终态证据 | `turn/end` / `subagent/end` + `verifyRunId` | 复用同一 evidence 形状；`<source>:<reason>` |
| 取消 | `cancel ack ≠ terminal` | 同构（`run/cancel-acknowledged` 非终态） |
| 时间 | 注入 fake clock | 注入 fake clock（**无 timers**） |
| UI | 只消费快照（门禁强制） | **无 UI、无 Electron/DOM/Pixi/fs/网络** |
| 依赖方向 | office 不依赖 Team | Team **不 import office-module**；允许 import 纯内核工具（如 `deriveRunProxy` 的**形状**规则不复制） |

**v0 的硬边界**：Team Runtime 不 import `office-module.js`、不写 office 状态、不改 `state-reducer` 的任何枚举、不新增 `office:*` IPC 通道。第二阶段（办公室消费 Team facts）必须通过**显式注入**（与 `answerRequest`/`controlRequest` 同一注入模式）而不是反向依赖。

---

## 11. 当前明确不承诺的能力

1. **自动 Planner / 任意任务拆解**：plan 是常量 `TEAM_V0_PLAN`，其它形状一律拒绝。
2. **五代理 DAG**：v0 只有 2 个角色、1 条依赖边；无并行、无扇入扇出、无条件分支、无循环。
3. **跨设备协作**：无分布式状态、无远程 run、无多进程。
4. **Team UI**：无渲染、无 IPC、无快照投影（第二阶段）。
5. **重试**：`attempt` 字段已预留（调研结论 §5-1），但 v0 **不实现**自动重试——`attempt` 恒为 1；重复事件走幂等吸收而非重试。
6. **持久化 / 恢复**：内存态（§8-4）。
7. **LLM / prompt 模板 / 新 provider**：无。
8. **artifact 内容**：只传引用（§8 隐私）。
9. **超时**：无 timers；`attention` 不会因超时自动升级。

---

## 12. 版本兼容策略

| 常量 | 值 | 位置 |
|---|---|---|
| `TEAM_SCHEMA_VERSION` | `1` | `team-schema.js` |
| `TEAM_RUNTIME_VERSION` | `'team-runtime-1'` | `team-runtime.js` |
| plan 形状 | `TEAM_V0_PLAN`（冻结常量，即 handoff schema） | `team-schema.js` |
| effort budget | `TEAM_V0_BUDGET`（与 plan 形状断言一致） | `team-schema.js` |
| status / outcome / kind 枚举 | 只增不改 | `team-schema.js` |

- 新增字段/枚举必须：更新本契约 → 更新测试 → 实现 → 补证据（继承 SPEC-00 的变更顺序）。
- `attempt > 1`、持久化、`eventsSince` 式 Team 重放都属于**升版**事项。
- Team 事实**不复用** Harness 的 `team/*` 命名空间（§1.1）。

---

## 13. 第二阶段：Team → Office 白名单映射（最小事实消费闭环）

> 本节是第二阶段第 5 项（Team-to-Office Adapter）的契约。**先列现有 Office 入口，再编码**。

### 13.1 现有 Office 入口清单（复用，不新造）

| 类别 | 现有入口 | 位置 |
|---|---|---|
| 状态权威（唯一 reducer） | `reduceOfficeState(state, event)`：`runtime/fact`(running\|idle\|attention\|completed\|failed)、`runtime/tool`、`runtime/cancelled`、`control/dispatch`、`control/cancel`、`control/cancel-ack`、`binding/*`、`transition/complete`、`local/activity`、`movement/status`、`sync/status` | `src/office/runtime/state-reducer.js` |
| 座位绑定 | `registry.bindSession({employeeId, sessionId, bindingSource, confidence})`（任意座位；忙则 FIFO 排队）；`registry.releaseBinding({sessionId, evidence, outcome})`（终态释放，evidence 必须来源限定） | `src/office/runtime/employee-registry.js` |
| 非终态 | `registry.cancelAcknowledged({sessionId})`（**不释放**）；reducer 的 `control/cancel` → `cancellationPending` | 同上 |
| 组合根编排 | `onBindingCreated(binding, effects)`（control/dispatch + 任务过渡 + 调度器）；`beginResultPresentation(rec, {outcome, evidence, sessionId, release})`（结果呈现窗口 → 到期提交）；`releaseTerminalNow(sessionId, evidence, outcome)`（取消的立即释放）；`applyRegistryEffects(effects)`；`noteDiagnostic(code)`；`pushSnapshot()` | `src/office/office-module.js` |
| 表现层 | 快照 `employees[].{runtime,activity,taskLabel,queueCount,transition,...}`、`activityLog[]`、`diagnostics[]` | 既有 `state()` |

**禁止**：新造平行 reducer、扩张 `state-reducer` 的 `runtime` 枚举、新增 activity-log kind（`office-page.js` 的 `ACTIVITY_LOG_LABELS` 是禁止修改文件，未知 kind 会以原始英文串渲染）、把 Team 状态塞进 office 的 `queue`/`control` 维度。

### 13.2 Team fact → Office fact 白名单映射表

| Team fact | Office 事实（kind） | 复用的现有入口 | 说明 |
|---|---|---|---|
| `job/created` | — | — | root 不是座位；不产生 office 效果 |
| `run/dispatched` | — | — | **`dispatched` ≠ running**：office 只对 `run/started` 反应，避免发明"已派遣"这个 office 状态 |
| `run/started` | `run-started` | `registry.bindSession` + `onBindingCreated` + `reduce(runtime/fact running)` | 座位忙则 FIFO 排队（既有行为），不双绑 |
| `artifact/available` | `artifact-available` | `noteDiagnostic('TEAM_ARTIFACT_AVAILABLE')` | 只做**粗粒度阶段提示**；kind 只留在 adapter 摘要里，不传 id/内容/路径 |
| `run/attention` | `run-attention` | `reduce(runtime/fact attention, reason)` | **非终态**：不释放、不 completed |
| `run/completed` | `run-terminal`(completed) | `beginResultPresentation` → 窗口到期 `registry.releaseBinding` | 复用结果呈现 + 站立离场收尾 |
| `run/failed` | `run-terminal`(failed) | 同上（outcome=failed → error 表情） | 绝不触发 completed 动画 |
| `run/cancelled` | `run-terminal`(cancelled) | `releaseTerminalNow(..., 'cancelled')` | 立即释放路径 |
| `run/cancel-requested` | `cancel-requested` | `reduce(control/cancel)` | **不释放**：进入 `cancellationPending` |
| `run/cancel-acknowledged` | `cancel-acknowledged` | `reduce(control/cancel-ack)` | **不改变任何状态**（只产生 `awaiting-terminal-evidence` 效果） |
| `job/completed\|failed\|cancelled\|attention` | `job-status` | `noteDiagnostic('TEAM_JOB_<STATUS>')` | root **只作汇总/诊断**，不新增 office runtime 枚举 |

### 13.3 Role → Seat 显式映射（4.4）

```js
TEAM_ROLE_TO_SEAT = Object.freeze({ researcher: 'researcher', reviewer: 'reviewer' });
```

- **静态、冻结、受测试保护**；**不**从 label / prompt / 自然语言摘要推断；**不**在缺项时回退成"role 名当座位"（缺项 → `TEAM_SEAT_UNMAPPED` fail-closed）。
- 表是**唯一权威**：把 `researcher` 改映射到别的座位，adapter 就绑那个座位（有测试证明"表决定，而非名字决定"）。
- 座位值在运行时校验 ∈ office 的 `EMPLOYEE_IDS`（`orchestrator|researcher|coder|reviewer|collaborator`）；未知座位 → `TEAM_SEAT_UNKNOWN`。
- root Job **不占座位**（只作汇总），因此"一个 Team WorkerRun 不能同时绑两个座位""一个座位不能被两个 Run 错误占用"由 registry 的既有不变式（一会话一绑定、一员工一活跃绑定）保证。

### 13.3.1 开发期 demo 的定位（统一表述）

`team-office-demo`（`src/team/runtime/team-office-demo.js`）是**开发期固定脚本 fixture**。
它使用 Office logical clock 作为演示时间来源，使用独立 unref pump 定时器检查到期脚本操作。
**生产 Team 不依赖 Office 是否打开、是否可见、renderer 是否运行或 Office 是否 tick。**
真实生产接入必须来自真实 Worker / Harness execution evidence。

因此：demo **不是**生产 Harness 输入，不是 Team 执行器，不得被描述成真实 Harness；
它的唯一用途是让已通过 headless 验证的 Team→Office 闭环在 Electron 里可被肉眼观察。

### 13.4 身份关联（4.2）

每个 office 事实携带结构化 `identity`，**不依赖位置性关联**：

```js
identity: {
  jobHandle,      // 'team-job-sha256:<16hex>'（派生；raw jobId 不离开 adapter）
  runHandle,      // 'team-run-sha256:<16hex>'（派生；同时是 office 的绑定 key）
  role,           // 固定枚举
  seq,            // Team fact 的 seq（事实身份）
  factType,       // 源 Team fact 类型（如 'run/started'）
  statusSource,   // 恒为 'team-runtime'
}
```

- `jobHandle`/`runHandle` 是**派生内部句柄**：`team-job-sha256:` / `team-run-sha256:` 前缀 + 16 hex。它们只作为 office 的**内部绑定 key**，**绝不进入快照**（快照的 `binding` 只有 `{source, confidence}`，`activityLog`/`diagnostics` 不含 id）。
- 因此本阶段**不依赖**通用 token 脱敏规则放行 `art:` / `run-sha256:` —— 这些 id 压根不进快照。
- adapter 是**无状态纯函数**（`mapFact(teamFact) → officeFacts`），所以 replay/duplicate/乱序的映射结果天然一致；幂等由 office 侧的既有不变式保证（重复 start → 已活跃绑定则不重绑；重复 terminal → 已释放则 no-op）。

#### 13.4.1 两层身份校验（adapter 一次，office 窄入口再一次）

这不是重复设计，而是**两个不同边界的职责**：adapter 负责"翻译"，office 窄入口负责"拒绝任何绕过 adapter 的伪造输入"。

| 层 | 校验内容 | 失败码 |
|---|---|---|
| adapter（`team-office-adapter.js`） | 生成派生 handle、校验 role/kind/outcome/evidence/reason | `TEAM_*`（映射层） |
| office 窄入口（`office-module.js` 的 `ingestTeamProjectionFact`） | **独立**校验 handle 形状与身份字段 | `TEAM_IDENTITY_REQUIRED` / `TEAM_IDENTITY_INVALID` |

office 侧**自带**一份接受契约常量（`TEAM_RUN_HANDLE_RE`、`TEAM_JOB_HANDLE_RE`、`TEAM_STATUS_SOURCE`、`TEAM_ROLES`、`TEAM_FACT_TYPES`、`TEAM_SEAT_SCOPED_KINDS`），**不 import `src/team/*`**。两个理由：
1. **分层方向**：office 是下层，不得反向依赖 Team 层（有测试断言 `office-module.js` 不 require `../../team/`）；
2. **边界解耦**：若复用 adapter 的常量，adapter 一改就会静默改变 office 的接受标准，两个边界就合并成一个了。

硬规则：
- `runHandle` 必须匹配 `^team-run-sha256:[0-9a-f]{16}$`；**座位范围的事实必须带**，非座位范围（`job-status` 是关于 Job 的，本就没有 run）允许为 `null`，但**只要出现**就必须是合法形状；
- `jobHandle` 若存在必须匹配 `^team-job-sha256:[0-9a-f]{16}$`；
- `identity.statusSource` 必须恒为 `'team-runtime'`；
- `identity.role` 必须是允许的 Team Role（座位范围的事实不得为 `null`）；
- `identity.factType` 必须是已知 Team fact 类型（14 个）；
- `identity.seq` 若存在必须是整数；
- **不**把 raw jobId / raw runId 当兼容格式放行；
- **不**依赖 adapter 一定先被调用（外部调用者可以绕过 adapter 直接构造）。

office 侧可能发出的全部稳定拒绝码集中在 `TEAM_REJECTION_CODES`（11 个，含新增的 `TEAM_IDENTITY_INVALID` 与 `TEAM_SEAT_CONFLICT`）；`adapter-rejected` 通道只接受 adapter 白名单内的码，未知码回落为 `TEAM_FACT_SHAPE_INVALID`（绝不让任意字符串进诊断环）。

### 13.5 生命周期规则（与 §7 对齐）

1. `cancel-requested` 不释放；2. `cancel-acknowledged` 不释放；3. 只有 `completed|failed|cancelled` + 来源限定 evidence 才终态；4. `attention` 不被动画/定时器/UI 自动改成 completed；5. Team Runtime 的终态证据是唯一依据；6. 重复 terminal 幂等；7. replay/duplicate/out-of-order 不重复绑定或释放；8. 一个 Run 不绑两个座位；9. 一个座位不被两个 Run 错误占用；10. Role 结束后的本地移动/动画收尾仍由 office runtime 负责，**动画不反向产生 Team fact**。

### 13.6 隐私边界（不传递清单）

**禁止**进入 office 快照/facts/diagnostics/日志：raw prompt、任务正文、模型输出、文件路径、工具参数、token 计数、API key/cookie、raw Harness session id、raw Harness runId、artifact 内容、artifact 路径、raw Team jobId/runId。

**允许**：固定 role/status/outcome、白名单粗粒度 reason、**派生**安全 handle（仅内部）、有界计数、fake-clock 时间、白名单 artifact kind（仅 adapter 摘要）。
