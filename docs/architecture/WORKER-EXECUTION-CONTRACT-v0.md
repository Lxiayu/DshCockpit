# Worker Execution Contract v0（执行端口 / ExecutionEvent / Team 调度接入）

> 状态：**v0 草案**（2026-10-22，多阶段 Harness 纵向批量开发）。
> 事实来源：当前实现 `src/team/runtime/{execution-schema,execution-port,fake-executor,team-execution-controller,dsh-execution-backend}.js` + 本仓库既有内核契约。
> 上游契约（**本契约不修改它们**，只在 Team 层之下新增一层）：
> [`TEAM-RUNTIME-CONTRACT-v0.md`](./TEAM-RUNTIME-CONTRACT-v0.md)、[`HARNESS-RUNTIME-CONTRACT-v0.md`](./HARNESS-RUNTIME-CONTRACT-v0.md)。
> 开工前审查：`WORKER-EXECUTION-PRE-REVIEW-2026-10.md`（本地归档 `docs/archive/reports/`，不入库）。
> dsh 兼容性盘点：[`docs/research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md`](../research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md)。
> 校验：`test/worker-execution-contract.test.js`（契约）、`test/team-execution-fake.test.js`（隔离组）、
> `test/office-team-execution.test.js`（组合组）、`test/dsh-execution-backend.test.js`（阶段 5）。

## 0. 范围

**是**：一个**足够窄**的执行端口（`WorkerExecutor`）、它的最小事件集合（`execution/*`）、
一个确定性的 `FakeExecutor`、一个**唯一**的转换窄层（`TeamExecutionController`）、
以及 DeepSeek dsh 后端的最小适配骨架（形状 + 映射 + 注入 transport）。

**不是**（任务书 §5.1 的明确禁止清单）：plugin marketplace、supervisor、dynamic planner、
任意 DAG、memory system、distributed scheduler、provider-specific options；
也**不是**真实生产接入（阶段 5 只做到接口形状 + 映射 + 离线单测）。

**为什么需要这一层**：Team Runtime 已能编排（常量 plan + 依赖 + 产物引用 + 终态证据），但它
**不知道执行方是谁**。执行后端又不应知道 Team 的座位/收敛。中间必须有且只有一层做转换，
否则会出现"两套事实作者"。本契约干的就是这件事。

---

## 1. 目标链路与禁止链路

```
Execution Backend / Worker                  ← ExecutionEvent 的唯一作者
      │  execution/*
      ▼
Team Command / Validator                     ← controller：唯一转换点
      │  team commands
      ▼
Team Fact Log                                ← Team Runtime：唯一作者
      │  job/* run/* artifact/*
      ▼
Team Projection Fact                         ← team-office-adapter：无状态纯函数
      ▼
Office Runtime → Snapshot                    ← office：只消费
      ▼
Renderer
```

**禁止的链路**（每一行都有对应门禁或测试）：

| 禁止 | 为什么 | 本仓库的强制点 |
|---|---|---|
| Renderer → Team | 渲染不能成为事实来源 | `office-page.js` 零 require；`test/office-team-execution.test.js` 的 renderer/page 断言 |
| Office tick → Worker execution | Office 关闭时 Team 必须仍能跑 | 执行层无 `setTimeout`/`Date.now`（契约测试）；`withOffice:false` 等价性测试 |
| Animation → terminal fact | 动画不是执行证据 | 终态只来自 `noteRunTerminal` + evidence |
| Office snapshot → Worker state | 快照是输出，不是输入 | 执行层不 import office（契约测试静态断言） |
| Team → raw dsh journal | Team 不得依赖 provider 专有字段 | Team 契约 §10；本契约 §9 |
| Executor → Team command | 会摧毁"Team fact 是执行证据的函数"这一性质 | **M14**：`fake-executor.js` / `dsh-execution-backend.js` 不 require team-runtime、无 Team 命令调用点 |

---

## 2. 四层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| **Execution Backend**（`fake-executor` / `dsh-execution-backend`） | 启动、观察、取消、执行证据（`ExecutionEvent`） | Team root 收敛、座位、动画、Team 状态 |
| **Controller**（`team-execution-controller`） | 找 ready run、绑 handle、消费事件流、**转换**、错误结构化、投影订阅 | 直接更新 Office、写 renderer、读 dsh journal、生成 prompt、改 Team 内部状态、无证据制造完成 |
| **Team Runtime**（`team-runtime`，既有） | plan、依赖、run、artifact、attention、terminal、root convergence | 模型 SDK、Pixi、座位坐标、执行后端协议 |
| **Office Runtime**（既有） | Team projection、binding、movement、activity、animation | Worker 是否成功、依赖是否满足 |

**身份边界**：`Execution Identity ≠ Team Identity ≠ Office Identity`。

| 身份 | 形状 | 谁持有 | 是否跨界 |
|---|---|---|---|
| raw `sessionId` / raw `runId` | provider 原始值 | executor（闭包内）/ `main.js` | **否** |
| `exec-job:<16hex>` / `exec-run:<16hex>` | 派生 | ExecutionEvent（公开字段） | 只在执行↔控制层 |
| `exec-handle:<16hex>` | 派生（= executionRef 的前缀替换） | controller 的绑定 key | 只在控制层 |
| `team-job-sha256:` / `team-run-sha256:` | 派生 | adapter（既有） | 只在 Team→Office 映射层 |
| office 绑定 key | 派生 handle | office registry（既有） | **不进快照** |

Team fact **不得**暴露：raw prompt、raw tool payload、raw file path、raw secret、raw sessionId、
raw provider-specific event、artifact 全文内容（继承 Team 契约 §9-2）。

---

## 3. WorkerExecutor 端口（冻结形状）

```js
const executor = {
  startRun({ jobId, runId, role, attempt, inputArtifacts, signal }) => ExecutionHandle,
  observe(executionHandle) => AsyncIterable<ExecutionEvent>,
  cancel(executionHandle) => Promise<CancelAck>,
  recover(executionHandle) => Promise<ExecutionHandle>,   // 边界保留
};
```

第一批**真正支持**：`startRun` / `observe` / `cancel`。

`recover` 的规则（`execution-port.assertExecutorPort`）：

- 要么是函数；
- 要么**必须显式声明** `unsupported: ['recover']`；
- **静默缺失** → `EXEC_PORT_SHAPE_INVALID`。理由：静默缺失会让"崩溃后能不能恢复"变成不可知，
  而恢复能力恰恰是崩溃策略的前提。

可选接缝（确定性，不是必需）：

| 接缝 | 形状 | 作用 |
|---|---|---|
| `pendingCount(handle)` | `() => number\|null` | 确定性宿主探针：controller 的 `run()` 只消费"当前已缓冲"的事件，因此**确定性且不会挂住**。FakeExecutor 提供；真实流式后端**不提供**（那时的语义就是 `await`）。 |
| `resume(handle)` | `() => {ok, code}` | attention 显式恢复的执行侧入口（Team 侧仍由 `startRun` 权威）。 |

### 3.1 ExecutionHandle（执行层私有）

```js
{
  handleId:       'exec-handle:<16hex>',   // 派生；唯一的绑定 key
  jobRef:         'exec-job:<16hex>',
  executionRef:   'exec-run:<16hex>',      // (jobId|runId|attempt) 派生
  role:           <Role>,
  attempt:        <int >= 1>,
  startedAtMs:    <injected clock>,
  supportsRecover:<boolean>,               // 显式能力声明
}
```

- 字段集合**冻结**（`HANDLE_FIELDS`）；任何额外字段（`sessionId`、`provider` 对象…）→ `EXEC_HANDLE_UNKNOWN`。
- `handleId` 必须与 `executionRef` 一致（不能自造一个与身份无关的 handle）。
- **一个 Team run 只能关联一个 handle**：`attempt` 参与派生，因此"同一 run 的第二次尝试"必然是第二个 handle —— v0 不实现重试，所以同一 handle 的重复 `startRun` 直接 `EXEC_ALREADY_BOUND`（**绝不**启动第二个 Worker）。

---

## 4. ExecutionEvent 最小集合

**10 种**（`EXECUTION_EVENT_TYPES`）。`execution/progress` 是第 10 种，v0.6 加入（§17）：早期"没有真实消费方就不加入"的前提，在办公室需要呈现员工当前在做什么时已不成立。它只携带闭集 `phase`，工具名/参数/正文结构性禁止。

| 事件 | 终态 | 需要 evidence | 可重复 | 必填字段 | 可选字段 |
|---|---|---|---|---|---|
| `execution/started` | 否 | — | 幂等吸收 | type / jobRef / executionRef / attempt / seq / atMs | reason |
| `execution/artifact` | 否 | — | 幂等吸收 | 同上 + **kind** | digest / locationRef |
| `execution/progress` | 否 | — | 连续同 phase 去重 | 同上 + **phase**（闭集 9 键） | — |
| `execution/attention` | 否 | — | 幂等吸收 | 同上 + **reason（必填）** | — |
| `execution/completed` | **是** | **是**（由 controller 构造） | 只有第一个生效 | 同上 | reason（默认 `ok`） |
| `execution/failed` | **是** | **是** | 只有第一个生效 | 同上 | reason（默认 `failed`） |
| `execution/cancel-requested` | 否 | — | 幂等吸收 | 同上 | reason（默认 `requested`） |
| `execution/cancel-acknowledged` | 否 | — | 幂等吸收 | 同上 | reason（默认 `acknowledged`） |
| `execution/cancelled` | **是** | **是** | 只有第一个生效 | 同上 | reason（默认 `cancelled`） |
| `execution/crashed` | 否（**视策略，见 §7**） | — | 幂等吸收 | 同上 + **reason（必填）** | — |

事件字段白名单（`EXECUTION_EVENT_FIELDS`，共 12 个）：
`type, schemaVersion, jobRef, executionRef, attempt, seq, atMs, reason, kind, digest, locationRef, phase`。
`phase` 只允许出现在 `execution/progress` 上（`PROGRESS_ONLY_FIELDS`），且必须是闭集键（`EXEC_PHASE_INVALID`）。

**这张白名单就是"执行方不能自带终态证据"的结构性保证**：
`evidence`、`outcome`、`artifactId`、`teamStatus`、`role`、`sessionId`、`prompt`、`content`、`arguments`
**全部不在**白名单里 → 一律 `EXEC_UNKNOWN_FIELD`。执行事件**不能**自称完成，也不能自带 Team 状态。

### 4.1 每种事件的判定细则

| 问题 | 答案 |
|---|---|
| **必填字段** | `type` / `jobRef` / `executionRef` / `attempt` / `seq` / `atMs`；`artifact` 还要 `kind`；`progress` 还要 `phase`；`attention` / `crashed` 还要 `reason`。 |
| **可选字段** | `reason`（有默认值的事件类型可省）、`digest`、`locationRef`（仅 artifact）。 |
| **允许的身份** | 只有派生句柄 `exec-job:` / `exec-run:`；raw jobId/runId **不可能**通过形状校验（`EXEC_IDENTITY_INVALID`）。 |
| **是否能产生 Team fact** | 每种都有一个 Team 动作（§5 转换表）。**未映射的 journal 事件不产生任何 Team fact**。 |
| **是否 terminal** | 只有 completed / failed / cancelled。control 回执与 attention / crash **绝不是**。 |
| **是否需要 evidence** | 只有终态需要，且 evidence **由 controller 构造一次**，执行事件从不携带。 |
| **是否可重复** | 终态"只有第一个生效"（第二个 → `EXEC_HANDLE_TERMINAL` / Team `duplicate`）；非终态重复由 seq 幂等吸收。 |
| **乱序时如何处理** | `seq` 必须单调递增：同 seq → `EXEC_DUPLICATE`；更小 → `EXEC_OUT_OF_ORDER`；前跳 → 合法 + `EXEC_SEQUENCE_GAP` 诊断。**两种情况都不产生 fact**。 |
| **未知事件如何 fail-closed** | 形状校验拒绝（`EXEC_EVENT_TYPE_UNKNOWN`）→ controller 记结构化拒绝 → **不追加任何 Team fact**。 |

### 4.2 校验是幂等的

`validateExecutionEvent` 对**已归一化**的事件再跑一次必须仍然合法。
这看起来是细节，实际是必需性质：controller 会先校验再传递，Team 侧边界可能再校验一次，
且"归一化补 `null`"（`kind`/`digest`/`locationRef`/`reason`）必须不改变判定结论。
（实现期实测踩到过这个坑：早期版本把归一化补的 `kind: null` 当"非 artifact 事件带 kind"而拒绝，
导致整条链静默失效。现已由测试钉住。）

---

## 5. ExecutionEvent → Team 命令 / fact（唯一转换表）

| ExecutionEvent | Team 命令 | 是否 terminal | Team fact |
|---|---|---|---|
| `execution/started` | `startRun({role, consumedArtifactIds})` | 否 | `run/started` |
| `execution/artifact` | `noteArtifact({role, kind})` | 否 | `artifact/available` |
| `execution/attention` | `noteRunAttention({role, reason})` | 否 | `run/attention` |
| `execution/completed` | `noteRunTerminal({role, outcome:'completed', evidence})` | **是** | `run/completed` |
| `execution/failed` | `noteRunTerminal({role, outcome:'failed', evidence})` | **是** | `run/failed` |
| `execution/cancel-requested` | `requestCancel({role})` | 否 | `run/cancel-requested` |
| `execution/cancel-acknowledged` | `noteCancelAcknowledged({role})` | 否 | `run/cancel-acknowledged` |
| `execution/cancelled` | `noteRunTerminal({role, outcome:'cancelled', evidence})` | **是** | `run/cancelled` |
| `execution/crashed` | `noteRunAttention({role, reason})`（**默认策略**） | 否 | `run/attention` |

**硬规则**：

1. **ExecutionEvent 绝不能直接改 Team state。** Team 的 `state` 在 `createTeamRuntime` 的闭包里，
   外部**不可触达** —— 这是结构性保证，不是约定。执行层只能走公开命令。
2. **evidence 由 controller 构造一次**：`evidence = 'execution/<outcome>:<reason>'`，
   例 `execution/completed:ok`、`execution/cancelled:cancelled`、`execution/failed:tool-error`。
   它命中 Team 契约的 `EVIDENCE_RE`
   （实测：`/^[a-z][a-z0-9_/-]{0,47}:[a-z][a-z0-9_-]{0,47}$/`），**因此不需要修改 Team 契约的证据形状**。
3. `reason` 只允许粗粒度 token，且与 Team 契约的 `ATTENTION_REASON_RE` **同口径**
   （测试断言二者正则 source 相等），因此执行层的 reason 一定能被 Team 接受。
4. **未知事件 fail-closed**：不产 fact、记稳定码。
5. **`consumedArtifactIds` 由 Team state 计算**（`dependsOn` 角色的 artifact），
   **不是**脚本硬编码 —— 因此 handoff 完整性由 Team 的既有校验强制。

---

## 6. FakeExecutor（确定性执行后端）

```js
createFakeExecutor({ scenario, script, scripts, clock, advanceClock, log })
```

- **场景是 role → 脚本** 的映射（researcher 产 `research-notes`、reviewer 产 `review-findings`）。
  同一个脚本不能给两个角色用 —— Team 的 `ARTIFACT_KIND_NOT_OWNED` 会拒绝，顺带证明 kind 归属校验是活的。
- 每步形状：`{op, reason?, kind?, digest?, locationRef?, advanceMs?}`。
  阻塞步 `wait-cancel` / `wait-resume` 让脚本停住、等外部输入（因此 cancel / attention 场景不会自己跑完）。
- **无 timers、无墙钟**：时间来自注入 clock，`advanceMs` 通过注入的 `advanceClock` 推进。
  引擎是 promise/microtask 驱动的（`observe` 是 pull 模型 + 投递唤醒）。
- 提供 `pendingCount(handle)` 确定性探针（见 §3）。

### 6.1 四个场景（+ 两个附加）

| 场景 | 脚本 | 期望 |
|---|---|---|
| `happy` | researcher: started → artifact → completed；reviewer 同构 | root `completed`，reviewer 消费 researcher 的 artifact |
| `attention-resume` | reviewer: started → attention → **wait-resume** → artifact → completed | root 先 `attention`，**显式 resume** 后 `completed` |
| `failure` | researcher: started → artifact → failed | root `failed`，**reviewer 永不启动** |
| `cancel` | researcher: started → **wait-cancel** → cancelled | request/ack 都不释放，只有 cancelled 收敛 |
| `crash`（附加） | researcher: started → crashed | 默认 → `attention`（非终态）；宿主可 `finishCrashed` → `failed` |
| `happy`（reviewer 侧） | 上表两行都覆盖 | — |

### 6.2 绝不能复制 demo 的逻辑（红线）

`team-office-demo.js` 是**开发期固定体验 fixture**，它的 `applyDemoOp()` **直接调 Team 命令**
（`createJob → dispatch → start → noteArtifact → noteTerminal`）。把它复制到执行路径会让
"Team fact 的作者"退化成"controller 自己"，执行证据链直接断裂（**P0**）。

因此：

| 可以复用（思想） | 绝不能复制（代码/路径） |
|---|---|
| pump 原语与"定时器只做调度"的分离 | `applyDemoOp()` 直接调 Team 命令 |
| 声明式脚本形状（可 replay/断言） | 把 office 逻辑时钟当执行时钟（Office 关闭即冻结 Team） |
| "消费者只走 bridge + 窄入口" | 脚本硬编码 id / `DEMO_JOB_ID` 单例 |
| 时钟注入纪律 | 把 demo 描述成真实 Harness |

**强制点**：`fake-executor.js` / `team-execution-controller.js` / `dsh-execution-backend.js`
**不 require** `team-office-demo.js`（契约与隔离测试双向断言）。

### 6.3 Team 可在无 Office / 无 Electron / 无 renderer 环境完成

- 隔离组 `test/team-execution-fake.test.js`：**结构上不 import office**（断言自己的 require 集合），
  并在拦截 `electron`/`pixi.js` 后跑完整链。
- 组合组 `test/office-team-execution.test.js`：同一驱动代码跑 `withOffice: true/false` 两遍，
  断言 **Team 事实日志逐字相同**（`deepEqual(facts)`）。这条最有力：Office 在不在，
  Team 的事实完全一样。

---

## 7. TeamExecutionController（唯一窄转换层）

### 7.1 职责

从 Team state 找 ready run → `dispatchRun` → `executor.startRun` → 绑**唯一** handle →
消费 `observe` → 按 §5 转换 → 把新 Team fact 交给 `onFact` 订阅者（投影方向）。

**不做**：更新 Office、写 renderer、读 dsh journal、生成 prompt、改 Team reducer 内部状态、
无证据制造完成、用定时器/墙钟。

### 7.2 控制方向 vs 事实方向

```
控制：Team → Executor        （startRun / cancel / recover / resume）
事实：Executor → ExecutionEvent → Validator → Team command
表现：Team Projection → Office
```

严禁：`Office → Executor`、`Office → Team command`、`Renderer → Team`。

### 7.3 生命周期与幂等

| 性质 | 机制 | 测试 |
|---|---|---|
| 一个 run 一个 handle | `sessions` Map 按 role；已绑定且未终态 → `already-dispatched`，**不**再 `startRun` | `repeated dispatch never starts a second worker` |
| 重复 dispatch 不启动第二个 Worker | 双层：controller 的会话检查 + executor 的 `EXEC_ALREADY_BOUND` | 同上 + `the executor itself refuses a second startRun` |
| 事件必须校验 job/run/attempt 关联 | `assertExecutionIdentity(event, session.expected)` | `identity mismatch fails closed` |
| 已终态会话拒绝后续事件 | `session.terminal` → `EXEC_HANDLE_TERMINAL` | `duplicate execution/completed produces no second terminal` |
| controller 无 Office 依赖 | require 闭包门禁 | 契约测试静态断言 |
| controller 可注入 FakeExecutor | 端口注入（`assertExecutorPort` 在构造期 fail-closed） | 全部隔离组测试 |
| Team terminal 只由受信证据产生 | controller 构造 evidence → Team 的 `TERMINAL_EVIDENCE_REQUIRED` 二次校验 | `failure` / `cancel` 场景 |
| 运行失败能返回明确错误，不静默吞掉 | `bindExecution` catch → `{ok:false, code}` + ledger；`noteRejection` | `EXEC_TRANSPORT_UNAVAILABLE` 系列 |

### 7.4 开放的泵接口

- `start()`：建 job（幂等）+ 绑定所有 ready 角色。
- `dispatchReady()`：再扫一遍 ready（下游角色在上游 completed 后变成 ready）。
- `pumpOne()`：按 plan 顺序取**第一个**有缓冲事件的会话，应用它。（无 timers；"有没有事件"来自 executor 的确定性探针，或真实后端的流。）
- `run({maxSteps})`：跑到暂停点（没有缓冲事件 / job 已收敛）。
- `ingestExecutionEvent(role, event)`：**公开的**事实入口（真实后端的 push 模型、以及晚到/重复/乱序的验证路径都走它）。

### 7.5 crash 策略（显式决定，不是"视情况"）

```
execution/crashed → Team attention（非终态、可恢复）        ← 默认
宿主显式controller.finishCrashed(role)
    → Team failed，evidence = 'execution/crashed:unrecoverable'   ← 唯一收敛路径
```

理由：crash **不是**终态事件类型 → 它**不可能**自动变成 completed；
attention 是既有语义里唯一"阻塞且可显式恢复"的状态；
"崩溃 = 任务失败"是一个**业务判断**，不能由执行层代替宿主决定。

---

## 8. Evidence / Artifact / Attention / Cancel

### 8.1 Evidence

```js
{ source, outcome, reason, atMs, executionRef }   // Team 内部
evidence 字符串 = '<event>:<coarse-reason>'       // 例 'execution/completed:ok'
```

必须区分（四段式）：

```
ExecutionEvent ≠ Evidence      （执行事件不自带 evidence）
Evidence      ≠ Terminal Fact  （证据是终态事实的输入）
Terminal Fact ≠ Office Animation（动画不是终态证据）
```

- 每个 terminal Team fact 都有来源明确的证据（`terminalEvidence.source`）。
- `executionRef` **只**存在于 controller 的会话摘要与 ledger，**不进** Office snapshot。

### 8.2 Artifact

```js
{ artifactId, kind, producerRunId, digest, locationRef }   // Team 内部
```

- `artifactId` = `'art:' + sha256(jobId|runId|kind).slice(0,16)` —— **调用方不能提供**（Team 派生）。
- 执行侧的 `digest`（`exec-sha256:<16hex>`）与 `locationRef`（`ref:<token>`）
  **只在执行事件与 ledger**；Team 的 artifact digest 由 Team 自己派生（二者不互相冒充）。
- 跨角色交接只走合法 ArtifactRef，且 Team **双向强制**（已有的 `ARTIFACT_NOT_CONSUMABLE` + `HANDOFF_INCOMPLETE`）：

| 必须测的 | 由谁强制 | 证据 |
|---|---|---|
| producer 必须是当前 run | Team（artifactId 派生 + `ARTIFACT_PRODUCER_NOT_RUNNING`） | 既有 `team-runtime-v0` 测试 |
| reviewer 只能消费依赖角色的 artifact | Team（`dependsOn.includes(producerRole)`） | 同上 |
| artifact kind 不符合 contract → 失败 | Team（`ARTIFACT_KIND_NOT_OWNED`） | 同上；执行层另有 `EXEC_ARTIFACT_KIND_UNKNOWN` |
| artifact 缺失不能假完成 | Team（`HANDOFF_INCOMPLETE`；`startRun` 拒绝） | `failure` 场景：researcher 有 artifact 但 failed → reviewer 不放行 |
| artifact 内容不进 Office | adapter + office 窄入口（只有白名单 kind 计数） | 组合组隐私断言 |
| digest / ref 可 replay | 全部确定性派生 | `replay-stable` 测试 |

### 8.3 Attention（完整链）

```
Execution attention → Team attention → Office attention → 用户操作
   → Executor resume/cancel → Team terminal
```

- attention **不是终态**：不释放绑定（组合组断言 `binding` 仍在）。
- **attention 不会被动画/定时器/自评估改成 completed**：组合组推进 office 逻辑时钟 60 tick，
  断言座位仍是 `attention`（M16）。
- 恢复必须**显式**：`controller.resume(role)` → Team `startRun`（Team 是权威）→ executor `resume`。

### 8.4 Cancel（完整链）

```
Team cancel request → Executor.cancel → execution cancel-requested
   → execution cancel-acknowledged → Team control state → execution cancelled
   → Team terminal cancelled
```

- **不能把 ack 当作 cancelled**（M17）：request 与 ack 都**不**改 Team run status；
  office 侧绑定保留且 `control='cancellationPending'`。只有真实的 `execution/cancelled` 收敛。
- 组合组逐条 pump 三次，分别断言 ack 前 / ack 后 / 终态后的状态。

---

## 9. DeepSeek dsh 后端边界（阶段 5）

**本轮不接真实网络。** 只做：接口形状 + 事件映射 + 注入 transport + 无网络单测 + 明确 unsupported。

### 9.1 映射表（逐条有来源；完整版见兼容性报告）

| dsh 事实 | 当前来源 | 映射到 | 缺口 |
|---|---|---|---|
| session start (`turn/start`) | `src/main.js:4760-4762` → `runtime-adapter.js:449-462` | `execution/started` | — |
| turn end completed | `src/main.js:4764-4772` → `runtime-adapter.js:466-467` | `execution/completed` | — |
| turn end failed (`error`/`failed`) | 同上 → `runtime-adapter.js:468-469` | `execution/failed` | — |
| turn end blocked | 同上 → `runtime-adapter.js:472-473` | `execution/attention` | — |
| turn end 未知/缺失 reason | `runtime-adapter.js:474-476`（**有意**降级 attention） | `execution/attention` | — |
| turn end aborted/interrupted/cancelled | 同上 → `runtime-adapter.js:470-471` | `execution/cancelled` | — |
| cancel ack（RPC 一元成功，**无 journal 事件**） | `office-module.js:3992-3995` 合成 → `runtime-adapter.js:721-724` | `execution/cancel-acknowledged` | — |
| child session lifecycle | `src/office/runtime/subagent-wiring.js:170-246` | execution identity（哪次 run） | — |
| approval request | `src/main.js:5018-5045` → `officeNotePending` | `execution/attention` | — |
| run identity (raw sessionId/runId) | `src/main.js:315`；`office-module.js:1486-1487` | 派生 `exec-job:`/`exec-run:`（不进事件） | — |
| **artifact** | **无来源**：dsh journal / follow 流不产生产物引用事件 | `execution/artifact` | **P1** `DSH_NO_ARTIFACT_EVENT` |
| **crash / reconnect** | **无 office 事实来源**：`main.js:4249-4257`、`1537-1574` 只走 runtime-health 与托盘；`recordCrash` 只写崩溃 JSON（`main.js:3864`） | `execution/crashed` | **P1** `DSH_NO_CRASH_FACT` |

**未映射的 journal 事件不产任何 fact**（`tool/call`、`assistant/message`、`turn/usage`、
`subagent/*`、`user/message`…）：只 canonical 化。这是与 adapter 默认分支同一立场。
并且**跳过不等于流结束**（实现期实测：早期版本一次工具调用就让整次执行"看起来结束"）。

### 9.2 不兼容与缺口（fail-closed 的能力）

| 码 | 能力 | 级别 | 说明 |
|---|---|---|---|
| `DSH_SESSION_ROLE_BINDING_UNDECIDED` | `startRun` | **P0** | dsh **没有**"按 Role 起一个会话"的原语：session 由用户/壳决定。因此骨架要求宿主注入 `sessionFor({jobId,runId,role})`；未注入 → `EXEC_TRANSPORT_UNAVAILABLE`。**把它交给本层等于让执行层生成 prompt**，违反 §2 与任务书 §9.3。 |
| `DSH_NO_ARTIFACT_EVENT` | `execution/artifact` | P1 | 角色间 handoff 在 dsh 侧无原生表达。接入前必须先定稿"谁有权声明 artifact 已可用"（**不能**是模型输出文本）。 |
| `DSH_NO_CRASH_FACT` | `execution/crashed` | P1 | 崩溃/重连是壳级健康信号，`main.js` 刻意只走 runtime-health（避免把"连接抖动"变成任务终态）。要映射成 Team crash 必须先在壳侧新增**受信的**崩溃事实来源。 |
| `DSH_NO_TOOL_FAILURE_DETAIL` | `execution/failed` 原因粒度 | P2 | `tool/call` 翻译只保留工具名（`src/main.js:4774-4782`，参数原文永不进办公室），因此工具失败只能是 turn/end 的粗粒度 reason。 |

### 9.3 禁止为了"看起来接通"而做的事（任务书 §9.3）

| 禁止 | 本契约的强制点 |
|---|---|
| 伪造 raw session | 未注入 `sessionFor` → `EXEC_TRANSPORT_UNAVAILABLE`（测试断言 message 含 `never generates prompts`） |
| 直接把 dsh raw event 当 Team fact | 只有 10 种 execution/* 能过 schema；journal type 永不成为 Team fact |
| 复用 Office demo 脚本冒充真实 backend | 结构性：backend 不 require demo |
| 把 prompt 内容作为 artifact | artifact 事件只有 `kind`/`digest`/`locationRef`；无 content 字段 |
| 把日志文本正则匹配成 completed | `mapDshJournalEvent` 只读 `data.reason`（结构性断言：不读 content/arguments/text/prompt）；无正则匹配 |
| 在没有 terminal evidence 时强制完成 | 终态必须经 controller 构造 evidence + Team 校验 |
| 让主进程直接修改 Team 内部 state | Team state 在闭包里，外部不可触达 |
| 新增第二套 dsh journal parser | 本层**不**解析 journal 流，只做事件映射；真实流由壳侧 `main.js` 持有（测试断言 `runtimeMux.onItem` 仍在壳里） |

### 9.4 放行结论

- dsh 事件映射**有来源**（每条带 `file:line`，且有测试断言这些引用真实存在且行号在范围内）；
- 不兼容点**被明确列出**（代码常量 `DSH_BACKEND_GAPS`，含级别与可执行说明）；
- 不支持能力 **fail-closed**（未注入 transport / sessionFor → 明确码）；
- Team **不依赖** dsh 专有字段（事件里没有 journal type / raw identity）；
- **无网络**测试可以验证事件转换（端到端离线：注入 journal → controller → Team fact）；
- **未完成的真实接入没有被包装成已完成**（报告 §7 明确写"未实现真实连接"）。

---

## 10. 复杂度审查（任务书 §10.1，逐问回答）

| # | 问题 | 结论 |
|---|---|---|
| 1 | 是否新增了第二套事实日志？ | **没有**。执行事件不是事实日志：无 append-only 账本、无 seq 权威、无自己的终态状态机。controller 的 `ledger` 是**有界诊断环**（≤128 条、只含枚举/计数），不是事实源。 |
| 2 | 是否新增了第二套 terminal 规则？ | **没有**。终态只由 `noteRunTerminal` + evidence 产生；执行层只有一个静态映射表，且 `crash` **不是**终态。 |
| 3 | 是否让 Office 知道了 Execution 细节？ | **没有**。adapter 白名单未扩张，只有 artifact **kind 计数**进诊断；组合组断言快照不含任何执行句柄。 |
| 4 | 是否让 Team 知道了 renderer 细节？ | **没有**。Team 层零 UI 依赖（既有门禁）；新增层也不 import renderer/page。 |
| 5 | 是否让 controller 变成了第二个 orchestrator？ | **没有**。它不判断依赖（问 `readyRoles()`）、不推导计划（用 Team 的常量 plan）、不决定终态（只转换）。 |
| 6 | 是否让 demo 和 production 路径混淆？ | **没有**。demo 仍是唯一直接调 Team 命令的模块；FakeExecutor 只产事件；两者无 require 边。 |
| 7 | 是否增加了必须跨层传递的 identity 数量？ | **净增 1 个域**（执行域），且每层各自派生、**不共享 raw**：raw → exec-* → team-* → office 绑定 key。每段都是前缀化派生，任一段泄漏都会被形状校验挡住。 |
| 8 | 是否引入了无法 replay 的异步副作用？ | **没有**。执行层无 timers/墙钟/网络；FakeExecutor 是确定性脚本 + 注入时钟；`replay(facts)` 与在线状态逐字相同（测试）。 |
| 9 | 是否让一个 run 可以有多个不清晰的 executionHandle？ | **没有**。handle 由 `(jobId, runId, attempt)` 派生 → 与 run 一一对应；重复 `startRun` 双层拒绝。 |
| 10 | 是否把 provider-specific 设计泄露到 Team Contract？ | **没有**。Team 契约零改动（除一处 P2 修正，见 §12）；evidence 用 `execution/*` 而非 `turn/end:*`；dsh 映射全部在 backend 内。 |

---

## 11. 版本兼容策略

| 常量 | 值 | 位置 |
|---|---|---|
| `EXECUTION_SCHEMA_VERSION` | `1` | `execution-schema.js` |
| `CONTROLLER_VERSION` | `'team-execution-controller-1'` | `team-execution-controller.js` |
| `DSH_BACKEND_VERSION` | `'dsh-execution-backend-0'` | `dsh-execution-backend.js` |
| `TEAM_RUNTIME_VERSION` | `'team-runtime-1'`（**未变**） | `team-runtime.js` |
| `TEAM_SCHEMA_VERSION` | `1`（**未变**） | `team-schema.js` |
| Team 事实类型集合 | **未变**（14 个） | 契约测试断言 |
| 事件类型 / 码 / 诊断 | 只增不改 | `execution-schema.js` |
| crash 策略 | `'attention'`（常量） | `execution-schema.js` |

策略：
1. 新增事件类型必须：更新本契约 → 更新契约测试 → 实现 → 补证据。
2. 新增 `reason` / `kind` 值属于枚举扩张，必须走同一顺序。
3. Team 契约 / Harness 契约的既有枚举**一字未改**（唯一例外是 §12 的加性证据来源）。
4. `attempt > 1`（重试）、持久化、真实 dsh 接线都属于**升版**事项。

---

## 12. 本次改动对既有契约的**加性**影响（必须记录）

### 12.1 office 内核：新增第四个受信终态证据来源 `execution`（P0 修复）

**现象**（实测发现，见报告 §3 与 P0-1）：Team 完成一个 run 后，office 座位**永远不释放**，
停在 `bound` / `completed`，诊断环出现 `RELEASE_FAILED` ×2。

**根因**（跨契约缺陷）：office 内核的受信终态证据来源白名单只有
`turn-end` / `subagent-end` / `session-end`
（`employee-registry.evidenceTypeFrom` + `queue-controller.TERMINAL_EVIDENCE_TYPES`）。
Team 终态事实的 evidence 来自调用方，因此可以是任何 `<source>:<reason>` 形状 ——
本仓库既有的 demo 与阶段 2 测试一直用 `turn/end:completed`（因为它恰好落在白名单里），
**从未**触发这条路径。一旦实际的执行来源用 `execution/*` 命名（契约要求，见下），
`releaseBinding` 就返回 `TERMINAL_EVIDENCE_REQUIRED`，组合根记 `RELEASE_FAILED` 并保留绑定。

**为什么不能靠"把证据写成 `turn/end:*`"绕过**：那会把 dsh 的 provider 词表
（`turn/end` 是 Harness 0.1.5 journal 的事件名）泄漏进 Team/执行层，
而本任务明确要求 `Team 不依赖 dsh 专有字段`（任务书 §9.4）。因此修法是给**本仓库自己的**
执行层命名空间开一个受信来源，而不是复用 provider 的事件名。

**修法**（加性，两处，一字不删既有语义）：

| 文件 | 改动 |
|---|---|
| `src/office/runtime/employee-registry.js` | `evidenceTypeFrom` 末尾新增 `if (lowered.includes('execution/')) return 'execution';` |
| `src/office/runtime/queue-controller.js` | `TERMINAL_EVIDENCE_TYPES` 加 `'execution'`（`['turn-end','subagent-end','session-end','execution']`） |

**为什么安全**：

1. **只增不改**：既有三个来源的判定分支一字未动。
2. `NON_TERMINAL_EVIDENCE = ['cancel-ack']` 仍然先于 `execution/` 判定 → 执行层的
   control 回执证据 `execution/cancel-acknowledged:acknowledged` 含 `cancel-ack`，
   **依然** fail-closed（ack 绝不能释放绑定，这是本任务的核心不变式之一）。
3. 新增来源仍然要求**终态证据串**：`execution/` 只有终态事件会构造 evidence
   （`evidenceForExecutionEvent` 对非终态返回 `null`），因此"execution 前缀"本身就等价于
   "这条事实是终态事实"。
4. 由 `test/office-team-execution.test.js` 的 P0-1 回归测试与"不削弱既有三个来源"测试双向钉住。

> **给未来接入者的提醒**：Team 契约允许调用方提供任意 `<source>:<reason>` 形状的 evidence，
> 但 office 内核只信任**已登记**的来源。新增一个执行后端来源（除 `execution/` 之外）时，
> 必须按 SPEC 顺序同时更新这两个白名单与契约测试，否则会出现"Team 已完成、座位永久占用"
> 这种**静默**错乱（没有报错，只有一个诊断码）。

### 12.2 Team Runtime：修正 `dispatchRun` 的返回字段错位（P2）

`team-runtime.js` 的 `dispatchRun` 成功分支原为 `applied(null, fact)` —— `fact` 落到了
`convergence` 字段、`fact` 为 `null`（语义互换）。实测确认**无任何调用方**读 `.fact` / `.convergence`
（全仓 grep），因此不影响行为；本次修正为 `applied(fact)`，避免误导新消费者。

### 12.3 文档缺口（记录，不改）

- Task 书要求的根 `AGENTS.md` **不存在**（Team 契约 §16 C1 已记录；仅 `studio/AGENTS.md` 存在）。
- `HARNESS-RUNTIME-CONTRACT-v0.md` 的版本表仍写 `ADAPTER_VERSION = task6-runtime-adapter-1`，
  实现已是 `-2`（`runtime-adapter.js:68`）。属文档漂移，本次**不**顺手改（避免扩大范围）。

### 12.3 依赖/纯度门禁的注释剥离器**静默失效**（P1 级工具缺陷，已修）

**现象**（负向变异 M13 实测）：把 `require('../../office/office-module.js')` 注入
`src/team/runtime/team-schema.js` 之后，`test/team-runtime-v0.test.js` 的
"team runtime is pure — no Electron, DOM, Pixi, fs, network or office import" 断言
**依然通过**，office 边界门禁（`test/office-runtime-boundary.test.js`）同样无感。

**根因**：两个门禁的 `stripComments` 都是"**正则先删块注释、再删行注释**"：

```js
source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
```

而本仓库的模块头注释会写 `team/*`、`job/*`、`turn/*`（命名空间边界说明）。
**行注释里的 `/*`** 被正则当成**块注释开始**，于是从该处到源码中第一个 `*/`
之间的**真实代码被整段吞掉**。实测受害文件：
`team-schema.js`（吞掉 `require('node:crypto')`）与 `execution-schema.js`。
对 `team-schema.js` 而言，被吞掉之后的**全部** require 都不可见 ——
因此"注入一个 office require"完全不会被发现。**断言变成空断言。**

**影响范围（已实测界定，未扩大）**：
- `src/office/runtime/**` 的 23 个纯内核模块：**0 个**受影响（旧剥离器与正确剥离器
  得到的 require 集合一致）→ **office 内核门禁本身是有效的**；
- `src/office/office-page.js`、`src/office/render/pixi-office-renderer.js`、`src/main.js`：
  两版剥离结果一致（无 `/*` 出现在行注释里）；
- `src/team/runtime/**` 的 2 个文件受影响（`team-schema.js`、`execution-schema.js`）。

**修法**（单遍词法扫描，识别字符串字面量）：

- `test/team-runtime-v0.test.js`、`test/office-runtime-boundary.test.js`：替换 `stripComments`
  为单遍扫描实现（并让内联的重复剥离逻辑改用该函数）；
- 新增契约测试：
  - `the comment stripper used by the purity gates is not blind (regression)` —— 用一个含
    `// ... team/* ...` 的样本文本断言"行注释里的 `/*` 不会吞代码"，并对真实模块断言
    `require('node:crypto')` 可见；
  - `an office import injected into ANY team module is caught by the purity gate (M13)` ——
    对**每个** team 模块逐个注入 office require 并断言门禁能看见它。

**为什么这是 P1 而不是 P3**：门禁的存在意义就是"让契约可执行"。一个静默变成空断言的
门禁比没有门禁更危险 —— 它会让"边界已冻结"这句话失去证据支撑。这也是本次任务
"主动做负向变异"的直接价值：**只有变异才能发现一个门禁是否真的在工作**。

> 教训（给后续任务）：**任何"剥注释后做静态断言"的门禁都必须自带一条"剥离器不吞代码"的
> 自证测试**；否则门禁的失效与代码的合规在观测上完全同形。

---

## 13. 本契约如何被持续校验

| 校验 | 文件 | 覆盖 |
|---|---|---|
| 执行契约 | `test/worker-execution-contract.test.js` | 词表/身份派生/事件 schema（含幂等）/未知 fail-closed/白名单字段/顺序/身份关联/evidence 只属终态/转换表/端口形状/handle 白名单/取消回执/纯度/manifest |
| Team 隔离组 | `test/team-execution-fake.test.js` | 四场景 + crash + duplicate/late/out-of-order/identity-mismatch + 幂等 + replay 稳定 + 无 Office/Electron/DOM/网络 |
| 组合组 | `test/office-team-execution.test.js` | 投影/隐私/attention 不自动完成/cancel ack 不释放/失败不伪完成/Office 关闭等价/投影重放幂等/**P0-1 回归** |
| dsh 后端 | `test/dsh-execution-backend.test.js` | 映射表逐条来源（含 file:line 存在性）/缺口清单/journal 纯映射/fail-closed/离线端到端/隐私/无网络双向证明 |
| 既有回归 | `team-runtime-v0` / `office-team-*` / `office-runtime-boundary` / `harness-runtime-kernel-probe` | 见最终报告 |

契约变更流程（继承 SPEC-00）：更新本文件 → 更新对应测试 → 改实现 → 补证据。
三者任一未同步，视为契约漂移。

---

## 14. 开发入口：FakeExecutor 可见闭环（Harness v0.3 工作包 A）

### 14.1 为什么有第二个开发入口

v0 阶段已有 `team-office-demo.js`（固定脚本 **直接调用 Team 命令**）用于肉眼观察。它的问题不是"看起来旧"，
而是**事实来源不对**：Team fact 的作者是 fixture 自己，而不是执行证据 —— 这正是本契约要消除的东西。
因此新入口用**同一条生产语义链**重做一次可见闭环：

```
FakeExecutor（execution/*）→ TeamExecutionController（唯一转换）→ Team fact
  → team-office-bridge → office.ingestTeamProjectionFact → 快照 → renderer
```

`src/team/runtime/team-executor-demo.js` 与旧 demo 的**三处结构差异**：

| 维度 | 旧 `team-office-demo.js` | 新 `team-executor-demo.js` |
|---|---|---|
| 事实来源 | 固定脚本 **直接调 Team 命令**（`applyDemoOp`） | FakeExecutor 的 **ExecutionEvent** |
| 转换层 | 无（脚本自己就是命令表） | **TeamExecutionController**（唯一转换点） |
| 投影 | bridge + 窄入口 | **同一个** bridge + 窄入口（因此"Office 只是消费者"同样成立） |

**边界（红线，逐条有测试）**：
1. 两个 fixture **互不 import**（双向隔离）；
2. 由**各自独立的**环境变量门控，且**互斥**（见 §14.3）；
3. 开发期 fixture：**不是**生产 Harness 输入、**不是** Team 执行器；
4. 生产语义保持"**Office 是否打开，不决定 Team 是否运行**"（§14.5 用逐字相同的事实日志证明）。

### 14.2 新入口的能力

| 能力 | 说明 |
|---|---|
| 场景目录 | `happy` / `attention-resume` / `cancel` / `failure`（冻结白名单；未知场景按名拒绝，无静默回落） |
| 驱动钩子 | 只做两件事：attention 的**显式** resume、cancel 请求。时间来自演示时钟；是否该动作由 **Team 状态**决定（不猜、不看 UI） |
| 演示时钟 | **基准时钟 + 本地偏移**：基准在 Electron 里取 office 逻辑时钟（开发便利），在测试里可注入；本地偏移由每次 pump 的 `DEMO_TICK_MS` 与执行侧 `advanceMs` 累加。**无墙钟、无真实等待** |
| 节奏 | 每 pump 最多消费 `eventsPerPump` 条事件（默认 1）→ 中间态肉眼可见（例如 cancel 的"ack 后仍占座"） |
| 泵原语 | `pump()` 是原语；`attach()` 只把 pump 挂到一个 unref 定时器上（异步 pump 有重入守卫） |
| 无 Office 模式 | `office: null` → 不建 bridge、不投影（headless 对照用） |

### 14.3 门控（默认关闭，互斥）

> **已退役（v0.6 WP5，2026-10-26）**：两个 demo 门与 fixture 已从源码移除，模块/测试归档到
> `archive/team-demos/`（本地保险箱）。本节保留为历史设计记录；现行入口只有
> `DSH_DESKTOP_OFFICE_TEAM_REAL=1`（§15.4）。

| 门 | 语义 | 默认 |
|---|---|---|
| `DSH_DESKTOP_OFFICE_TEAM_DEMO=1` | 旧：固定脚本直接调 Team 命令 | 关闭 |
| `DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO=1` | 新：FakeExecutor → Controller → Team → Office | 关闭 |

**两个门互斥**：同时打开时拒绝新入口并记 `OFFICE_TEAM_DEMO_CONFLICT`
（拒绝在懒 require **之前**，因此连模块都不加载；不抛错、不影响普通启动）。
理由：两个 fixture 同时 attach 到同一办公室时，无法分辨**谁**在写事实 —— 这与"唯一事实作者"直接冲突。

可选用 `DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_SCENARIO` 选场景（不设则 `happy`；未知值按名拒绝）。
普通启动时：不 require 新模块、不创建 FakeExecutor/controller/timer、不影响现有 Office、**不新增 IPC**
（`office:*` 通道仍为 8 个，有测试钉住）。

### 14.4 四种场景的期望终态

| 场景 | Team root | 可观察点 |
|---|---|---|
| `happy` | `completed` | researcher → artifact → completed → **只有依赖完成后** reviewer 才出现 → completed |
| `attention-resume` | `completed` | reviewer attention → office 显示 attention 且**仍占座** → **显式** resume → completed |
| `cancel` | `cancelled` | request → ack（**仍占座**、`control='cancellationPending'`）→ execution cancelled → 释放 |
| `failure` | `failed` | researcher failed → **reviewer 永不启动**；座位显示 failed（**从不是 completed**） |

### 14.5 无 Office / 有 Office 对照（核心断言）

同一驱动代码、同一场景、同一注入时钟，跑 `withOffice: true/false` 两遍，
断言 **Team 事实日志逐字相同**（`deepEqual`）。这比"两套实现各自通过"更强：
它证明 Office 是**可替换的消费者**，而不是执行链的隐含依赖。

### 14.6 校验

| 校验 | 文件 |
|---|---|
| 新入口（门控/生命周期/四场景/无 Office 对照/隐私/边界/时钟/新旧不混用/可 replay） | `test/office-team-executor-demo.test.js` |
| **真实 main.js attach 路径**（不启动 Electron，抽取 gate/attach/detach 真函数体 + 假 office 组合根） | headless 接线验证（见最终报告 §7.4） |
| 负向变异 | N1（默认开启）/ N4（Office 不存在无法完成）/ N9（两门同时 attach）等 |

### 14.7 人工 GUI 验证（**未做**，如实声明）

无显示环境，因此本报告区分三层验证：
- **headless**：✅ 已完成（真实接线路径 + 四场景 + 全量测试）；
- **GUI 代码接线**：✅ 已完成（`main.js` 的 gate/attach/detach + will-quit 清理，经真函数体验证）；
- **人工视觉验收**：❌ **未做**。有显示环境时应运行
  `DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO=1 npm start`（该门已在 v0.6 WP5 退役，命令仅作历史记录）并按 A5 的观察点逐条核对
  （researcher 是否出现 / reviewer 是否只在依赖完成后出现 / attention 是否 warning /
  resume 是否回 working / failed 是否不显示 completed / cancel ack 是否不提前离场 /
  Office 隐藏是否不改变 Team facts / renderer 是否没有新增事实写入路径）。
---

## 15. Harness v0.4（阶段1）：真实 dsh 会话后端最小接入（2026-10-25）

> 用户三项拍板（2026-10-25）：① v0.4 主线 = 阶段0 收口 + 真实 dsh 最小接入；
> ② 任务文本来源（U3）= **用户输入研究主题** + 固定模板（执行层绝不生成 prompt）；
> ③ 第一版 Artifact 来源 = **本地 materializer**（壳把会话最终产出物化为文件，digest=sha256）。

### 15.1 阶段0 收口（已完成）

| 项 | 改动 |
|---|---|
| `ingestTeamFact` → `ingestTeamProjectionFact` | 硬改名（13 文件 34 处，无别名）——第一性原理拆解 P1 的"投影语义"落地。Office 窄入口的名字现在就说明它收的是**投影**，不是 Team 本体。 |
| office-module.js 冻结门禁 | require 说明符集合冻结 + 4800 行上限（`test/office-runtime-boundary.test.js` §7）。往组合根塞新依赖/新行数变成显式决定。 |

### 15.2 transport v1（后端与壳的契约）

```js
transport = {
  resolveSession({ jobId, runId, role, attempt, inputArtifacts, produces, consumes })
      => sessionId | null | Promise<...>,   // 壳：建会话 + 发任务文本（raw 只回传给 transport 调用线）
  follow(sessionId)  => AsyncIterable<journalEvent>,   // 壳的 tee 流（顺便捕获 assistant 正文）
  cancel(sessionId)  => Promise<{ok}>,
  artifactFor({ sessionId, role, kind }) => {kind, digest, locationRef} | null,  // 壳：本地 materializer
};
```

配套变更：
- **`startRun` 可返回 `Promise<Handle>`**（controller `await`；真实后端要建会话，网络是异步的——这是 v0.4 唯一的端口形状修订）。
- controller 向 `startRun` 透传 `produces` / `consumes`（来自 Team 常量 plan，provider 中立）。
- **artifact 顺序不变式**：`execution/artifact` **必须**先于它的 `execution/completed` 交付（Team 要求 producer 处于 running）。后端用**有序发射队列**保证。
- **session-unavailable → Team attention**（设计 B §4.9）：`resolveSession` 返回 null / 抛 `EXEC_TRANSPORT_UNAVAILABLE` 时，controller 转 `noteRunAttention({role, reason:'session-unavailable'})` —— 不是 failed（没有执行证据）、不是静默 pending（root 会悬空）。

### 15.3 壳侧实现（`src/team-shell-transport.js`，**有意不在** `src/team/runtime/**`）

- 位置理由：那个目录是纯内核（门禁禁 node:fs）；transport 是壳侧基础设施（设计 B 方案 A）。
- `resolveSession` = `rpc.createSession()` + `rpc.prompt(冻结模板+用户主题, mode:'steer')`。reviewer 的模板**内联**上游笔记（按 plan 声明的 `consumes` 定位，**不**做 artifactId 反查——Team 的派生式不属于壳），内联上限 8000 字符。
- `follow` = 对壳已有 journal 流的 **tee**：只记"最后一条 assistant 正文"（materializer 的唯一内容来源；不做通用 journal 解析）。
- `artifactFor` = 把正文物化为 `artifactDir/<jobId>/<kind>.md`；`digest='exec-sha256:'+sha256(字节).slice(0,16)`；`locationRef='ref:<role>-<kind>'`（受限 token，无路径）；幂等。
- **fail-closed**：没捕获到正文 → 不物化 → 后端不产 artifact 事件 → Team 的 `HANDOFF_INCOMPLETE` 让下游挂起（宁可挂，不伪造交接）。
- 未知角色 → 不生成 prompt（防悄悄扩角色）。

### 15.4 真实接入门控（main.js）

| 门 | 语义 | 默认 |
|---|---|---|
| `DSH_DESKTOP_OFFICE_TEAM_DEMO=1` | 旧：固定脚本直调 Team 命令 | 关 |
| `DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO=1` | v0.3：FakeExecutor 链路 fixture | 关 |
| `DSH_DESKTOP_OFFICE_TEAM_REAL=1` + `DSH_DESKTOP_OFFICE_TEAM_TOPIC="<主题>"` | **v0.4：真实 dsh 执行链路** | 关 |

**三方互斥**（任意两个同开 → 拒绝真实入口 / executor fixture，稳定码 `OFFICE_TEAM_GATE_CONFLICT`；拒绝在懒 require 之前）。主题必填（缺 → `TEAM_TOPIC_REQUIRED`，同样在任何 require 之前）。

真实驱动：`drive()` 是**唯一**驱动者（await 驱动——事件到达才推进，无轮询无定时器）；`whenDone` 暴露完成承诺。**不要**在外面并发泵同一迭代器（两个消费者会互相抢事件——离线测试实测抓到）。v0.6 起 attention **可以**续跑：`shell:team` 的 `resume` 走 controller 两条路径（无会话 → 重新 bind；有会话 → `executor.resume` 续跟同一会话），失败回滚到 attention（`resume-failed`）。详见 §17。

### 15.5 验证层级（如实声明）

| 层 | 状态 |
|---|---|
| headless 离线（真实模块 + 注入 fake rpc/stream/fs） | ✅ `test/team-shell-transport.test.js`（14）、`test/office-team-real-wiring.test.js`（10，抽取 main.js **真函数体**） |
| 真实 GUI / 真实 dsh | ❌ **未运行** —— 需在有显示与运行时的设备上：`DSH_DESKTOP_OFFICE_TEAM_REAL=1 DSH_DESKTOP_OFFICE_TEAM_TOPIC="…" npm start` |

### 15.6 校验

| 套件 | 覆盖 |
|---|---|
| `test/dsh-execution-backend.test.js` | transport v1 契约 / artifact 先于 completed / 无物化不伪造 / failure·blocked 不触发 materializer / 端到端交接 / session-unavailable→attention |
| `test/team-shell-transport.test.js` | 建会话+发文本 / tee 捕获最后正文 / 物化+digest 可验证 / 无正文拒绝物化 / 隐私（summary 无 raw id/正文/路径）/ **真实实现端到端**（含 blocked→attention） |
| `test/office-team-real-wiring.test.js` | main.js 真函数：三门互斥 / 主题必填 / 端到端 / failure / blocked / 会话失败→attention / detach 幂等 / follow 流帧抽取（snapshot+event+end；assistant-stream 忽略） |

### 15.7 v0.4 批次结果（2026-10-25 收尾记录）

| 项 | 结果 |
|---|---|
| 全量测试 | **1790 pass / 0 fail / exit 0**（v0.3 基线 1757，净增 **33**） |
| 新增套件 | `team-shell-transport`(14) + `office-team-real-wiring`(10)；扩展 `dsh-execution-backend`(+6)、`office-runtime-boundary`(+3)、`worker-execution-contract`(+2) |
| 负向变异 R1–R10 | **全部 DETECTED**（含 R6 重试：组合根塞 team require） |
| 阶段0 改名 | `ingestTeamProjectionFact`（13 文件 34 处，无别名；有防走私门禁） |
| 组合根冻结 | require 集合冻结 + 4800 行上限（office-module.js 现为 4530 行，未增） |
| 实现期抓到并修复的缺陷 | ① backend `startRun` 同步拿到 Promise 被当 sessionId 拒（→ 端口允许 `Promise<Handle>`）；② follow 流唤醒全部 waiter 导致第二个消费者拿到假 `done`（→ 一对一交付）；③ `attach` 内部 drive 与外部泵并发抢事件（→ `whenDone` 单一驱动者）；④ tdz-guard 惰性正则吞块误报（→ return 用限定名） |
| 验证层级 | headless 离线 ✅；**真实 GUI / 真实 dsh ❌ 未运行**（指引见 §15.5 命令） |

---

## 16. Harness v0.5（首次体验最小版）：办公室 Team 任务发起入口（2026-10-25）

> 用户拍板：v0.5 主线 = 首次体验最小版（增长计划"5 分钟首次体验"的第一块）。

### 16.1 形态

办公室右栏最上方新增**团队任务卡**（默认隐藏，总门开启且 status 报 enabled 才显示）：
输入研究主题（用户唯一文本，U3）→ 开始 → 卡片显示粗粒度状态；attention 时出现「继续」按钮。

```
office.html 卡片 → officeBridge.team() → shell:team IPC → main.js 处理器
  → startTeamRealWithTopic（v0.4 核心，单实例） / controller.resume
  → Team → bridge → office.ingestTeamProjectionFact → 快照 → renderer
```

### 16.2 关键决定

| 决定 | 理由 |
|---|---|
| 通道是 **`shell:team`**（shell 自有命名空间，与 shell:theme 同模式） | office:\* 通道集合已冻结为 8 个；"发起/恢复任务"是壳的**控制**，不是办公室投影。注册在 main.js，office-module.js **零改动**（哈希未变） |
| 第四个门 `DSH_DESKTOP_OFFICE_TEAM_UI=1`（默认关） | 不与三个既有门产生事实作者冲突——它只是 startTeamRealWithTopic 的第二入口；与 env REAL 路径共享**同一个单实例守卫**（同一时刻只允许一个真实 Team；守卫先于任何会话创建） |
| 卡片状态来自 `shell:team status`（控制面），**不来自快照** | 快照只含投影；团队活动是壳的控制面状态。**渲染绝不伪造状态对象**（U10 变异钉住——假"运行中"正是本产品最忌讳的"动画伪装执行"） |
| status 返回**没有 topic 字段**（结构级） | 值级断言在 env 主题为空时会漏检（U6 教训）；用户文本只存在于 prompt 与用户自己的输入框 |
| 载荷校验 fail-closed：`status/start/resume` 三 action；主题 trim + 上限 2000（壳侧与页面侧**双端一致**） | 与 office-module 的 validateOfficeIpcPayload 同纪律 |
| resume 只在"某 run 恰在 attention"时放行 | 控制语义与 Team 契约对齐：attention 恢复必须显式且唯一 |

### 16.3 校验

`test/office-team-ui-entry.test.js`（15 项）：通道冻结 / 四门独立 / office-module 零改动 / 载荷校验全矩阵 / start 全链（真 main.js 处理器 + 注入 deps）/ 四种拒绝（门关、env REAL 同开、office 未就绪、已有实例且**零会话创建**）/ resume 仅 attention / 隐私三层（事实/无 topic 字段/快照）/ 页面控制器形状与 cancel 同构 / 卡片骨架与 i18n 双语 / 卡片不伪造状态。

负向变异 **U1–U10 全部 DETECTED**（首轮 U4/U6/U10 未检出 → 暴露三个测试写得不狠 → 加固后全绿，教训已写入契约）。

### 16.4 使用

```bash
DSH_DESKTOP_OFFICE_TEAM_UI=1 npm start
```

（真实 GUI 人工视觉验收仍未做——headless 已全绿；env REAL 路径与 UI 路径互斥，同一时刻只有一个真实 Team。）


## 17. Harness v0.6：续跑闭环 / 过程可见性 / 启动与运行时瘦身（2026-10-26）

计划：`docs/plans/completed/HARNESS-V0.6-PLAN-2026-10-25.md`。五个工作包各自独立 commit（可单独回退）。

### 17.1 契约增量（执行层）

| 增量 | 语义 | 依据 |
|------|------|------|
| `execution/crashed(stream-ended)` | journal 流耗尽而无终态 → 恰一条合成 crashed（幂等）→ crash 默认策略 attention（非终态） | 洞 B：旧实现流耗尽静默停 running |
| `resume(handle)`（后端可选方法） | attention 后对**同一会话**重挂 follow；重放由 journal 单调 seq 去重吸收 | follow 无 resume cursor（重开即重放） |
| `execution/progress`（第 10 类型） | 只携带闭集 `phase`（9 键 = office tool-phrases PHRASE_KEYS，漂移钉绑定）；连续相同 phase 去重；工具名/参数/正文结构性禁止 | v0.5 前"无消费方不加入"的前提消失 |
| `phaseForTool` 注入 | 工具名 → phase 的映射由**壳注入**（内核零 office 依赖）；未注入则 tool/call 保持跳过 | 层纯度门的直接后果 |

### 17.2 控制器/Team 增量

- `resume` 两条路径：无会话（bind 阶段失败）→ Team startRun + **重试绑定**；有会话 → startRun + `executor.resume`。执行器续跑失败 → 诚实回滚 attention（reason `resume-failed`）。终态会话拒绝 resume。
- Team 新事实 `run/progress`（只存最新 phase；重复 phase 幂等）；`run.progress = {phase, atMs}`。
- 壳：驱动循环可重启（attention 退场 → `resumeTeam()` → controller.resume → startDrive）；IPC resume 走 `instance.resumeTeam`。

### 17.3 门与通道（v0.6 后现状）

| 门 | 状态 |
|----|------|
| `DSH_DESKTOP_OFFICE_TEAM_UI=1` | 保留（UI 入口） |
| `DSH_DESKTOP_OFFICE_TEAM_REAL=1` + `..._TOPIC` | 保留（env 入口） |
| `DSH_DESKTOP_OFFICE_TEAM_DEMO` / `..._EXECUTOR_DEMO` | **退役**（fixture 归档到 archive/team-demos/） |

`shell:team` 通道与载荷校验不变（status/start/resume；主题 trim + 2000 上限双端一致）。status 面新增 `progressPhase`（闭集键或 null；renderer 只呈现不推断）。

### 17.4 校验与变异

- 新增套件：`test/team-execution-resume.test.js`（7）、`test/team-execution-progress.test.js`（8）、`test/first-paint-decouple.test.js`（3）、`test/office-snapshot-push-skip.test.js`（5）；既有套件按新规格更新。
- 变异：**M-V1…M-V8 全 DETECTED**（resume/崩溃/去重/驱动重启/IPC 路由）；**M-V9…M-V12 全 DETECTED**（原始工具名当 phase / 去重移除 / 闭集校验移除 ×2）；**M-W1…M-W3 全 DETECTED**（窗口推迟 / paint 启动服务 / 去兜底）；M-W4、M-W5' DETECTED；**M-W5/M-W6 被冗余捕捉者掩蔽**（diagnostics 环与调度器有机变化本身在签名里——它们替团队挡住了变异，如实记录而非强称检出）。
- 全量：1802 pass / 0 fail（归档的 38 个 demo 期测试不再运行）。

### 17.5 真机验收脚本（交用户）

1. 团队卡发任务 → researcher 座位实时显示工具短语（WP2）；
2. dsh 运行中杀掉进程 → 办公室出现 attention（reason stream-ended）→ 重启 dsh → 点继续 → completed（WP1b）；
3. dsh 停着发任务 → attention（session-unavailable）→ 起 dsh → 点继续 → completed（WP1a）；
4. 冷启动：splash 后办公室立即可交互，harness 视图随后自动就绪（WP3）；
5. 静置观察主进程 CPU 占用下降（WP4；夜间/无人走动时 62 次/秒 → ≤5 次/秒）。

### 17.6 已知限制（v0.6 未做）

- `recover()`（attempt+1 重开新执行）仍留端口边界；crash→failed 的宿主裁决（`finishCrashed`）无 UI；
- bind-attention 的**取消**入口仍缺（单实例守卫下只能继续或重启 app —— 卡片加取消按钮时一并做宿主级 detach）；
- blocked-turn attention 的"再发一条 steer"续跑语义（dsh 需要人工应答的场景）属阶段 2；
- durable store / app 重启后团队存活（阶段 5）。
