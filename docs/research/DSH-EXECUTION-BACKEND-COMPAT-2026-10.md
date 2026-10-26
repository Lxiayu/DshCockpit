# DeepSeek dsh 执行后端兼容性盘点（2026-10）

> 状态：**只读盘点 + 最小适配骨架**（2026-10-22，多阶段 Harness 纵向批量开发 阶段 5）。
> 2026-10-26 按 v0.6 校正：`artifact` 缺口由壳侧 materializer 注入覆盖（未注入时仍在
> `unsupportedEventTypes` 里显式声明）；`crash` 缺口由 WP1 的 "流耗尽而无终态" 合成覆盖；
> 端口层 `unsupported` 只剩 `recover`。本文其余数字与判断保持 2026-10-22 的盘点口径。
> 方法：**只读**检查当前仓库代码与既有测试；不启动真实运行时、不凭猜测填写。
> 代码：`src/team/runtime/dsh-execution-backend.js`（映射表与缺口清单是该文件的**常量**，
> 由 `test/dsh-execution-backend.test.js` 断言"每条来源引用真实存在且行号在范围内"）。
> 目标契约：[`docs/architecture/WORKER-EXECUTION-CONTRACT-v0.md`](../architecture/WORKER-EXECUTION-CONTRACT-v0.md) §9。
> 上游契约：[`HARNESS-RUNTIME-CONTRACT-v0.md`](../architecture/HARNESS-RUNTIME-CONTRACT-v0.md)（本层不修改它）。

## 0. 结论摘要

1. **可映射**：turn 的开始/结束（completed / failed / blocked / 未知 / aborted 等）、
   cancel 的 RPC 回执、子代理生命周期、审批请求、run 身份派生 —— 共 10 项，每项都有仓库内的现成映射位置。
2. **不可映射（缺来源，2026-10-26 已收敛）**：`artifact`（dsh 无产物事件）改由壳侧注入
   `artifactFor` materializer 补齐；`crash/reconnect` 由后端在"流耗尽且无终态"时合成
   `execution/crashed(stream-ended)`。两项仍**不属于 dsh 原生能力**，只是执行层补的事实来源。
3. **P0 不兼容**：dsh **没有**"按 Role 起一个会话"的原语 ⇒ 骨架要求宿主注入 `sessionFor`，
   否则 fail-closed。**这一条决定了本轮不能接真实网络**：把"用哪个会话跑哪个 Role"交给执行层，
   等于让执行层生成 prompt（违反契约 §2 与任务书 §9.3）。
4. **本轮未实现真实连接**（明确声明，不包装成已完成）：只交付接口形状 + 事件映射 +
   注入 transport + 无网络单测 + 明确 unsupported 清单。v0.6 增加 `resume` 与 `progress`
   两个端口能力（§17），仍不改变"联网由宿主注入 transport"这一边界。

---

## 1. 检查过的范围（只读）

| 文件 | 检查内容 |
|---|---|
| `src/runtime-mux.js` | 连接状态机（`idle` / `connecting` / `live` / `reconnecting`）、`onItem(streamId, value)`、`call()`、重连退避（`reconnectMs: 3000`、`maxBackoffMs: 60000`）、`{type:'cancel'}` 帧 |
| `src/main.js` | mux 装配（`startMuxEventsFeed`，4258-4274）、`$events` 与 `session/follow` 两条流、journal→adapter 翻译层（4746-4828）、回填（4713 / 4907）、`controlRequest` 注入（316-332）、审批（5018-5045）、`officeBoundSessionIds`（4471-4483）、runtime-health（1556-1574） |
| `src/harness-rpc.js` | `session/list`、`session/create`、`session/prompt`、`session/cancel`、`session/page`、`session/follow`、`session/control`（slash 与 legacy 双栈）；超时 15s/10s；401 自愈 |
| `src/office/runtime/runtime-adapter.js` | canonical envelope（`eventId` / `sessionEpoch` / `pairingHandle` / `sequence`）、`mapEnvelope` 的 fact 允许集合（449-561）、`deriveRunProxy`、`noteCancelAcknowledged` |
| `src/office/runtime/subagent-wiring.js` | 子代理 start/end 配对（`childId` 账本、`runId↔memberSeq`） |
| `src/office/office-module.js` | 窄入口（`ingestTeamProjectionFact`，2102-2350）、cancel 合成（3992-3995）、`releaseTerminalNow`、`currentRootHandle` |
| `src/office/runtime/employee-registry.js` | 终态证据集合（`TERMINAL_STOP_REASONS`、`NON_TERMINAL_EVIDENCE`、`evidenceTypeFrom`）、`verifyRunId` |
| `src/runtime-supervisor.js` / `src/runtime-health.js` | 崩溃记录（`recordCrash`）、健康信号（feedback / 托盘 / 通知），**与 office 无耦合** |

---

## 2. 映射表（任务书 §9.1）

| dsh 事实 | 当前来源（仓库内） | 可映射到 ExecutionEvent | 缺口 |
|---|---|---|---|
| session start (`turn/start`) | `src/main.js:4760-4762` 翻成 `agent/status{running}` → `runtime-adapter.js:449-462` | `execution/started` | — |
| turn end completed (`data.reason.kind === 'completed'`) | `src/main.js:4764-4772`（`data.reason.kind`）→ `runtime-adapter.js:466-467` | `execution/completed` | — |
| turn end failed (`error` \| `failed`) | 同上 → `runtime-adapter.js:468-469` | `execution/failed` | — |
| turn end blocked | 同上 → `runtime-adapter.js:472-473` | `execution/attention` | — |
| turn end 未知/缺失 reason | `runtime-adapter.js:474-476`（**有意**降级为 attention） | `execution/attention` | 原因粒度粗 |
| turn end aborted / interrupted / cancelled | 同上 → `runtime-adapter.js:470-471` | `execution/cancelled` | — |
| cancel ack | `office-module.js:3992-3995` 在 cancel RPC 成功后**合成** → `runtime-adapter.js:721-724` | `execution/cancel-acknowledged` | dsh **无** journal ack 事件（见 §3.3） |
| child session lifecycle (`subagent/catalog`、`tool-workflow/agent-start\|agent-end`、`user/message(source.kind='subagent-settled')`) | `src/office/runtime/subagent-wiring.js:170-246` | execution identity（哪次 run） | — |
| approval request（mux `waterfall`） | `src/main.js:5018-5045` → `officeNotePending` | `execution/attention` | 与 blocked 同义的上游 |
| run identity (raw sessionId / raw runId) | raw 只在 `src/main.js`（315）与 `office-module`（1486-1487）内部 | 派生 `exec-job:<16hex>` / `exec-run:<16hex>`（**不进事件**） | — |
| **artifact** | **无来源**：journal / follow 流不产生产物引用事件 | `execution/artifact` | **P1** `DSH_NO_ARTIFACT_EVENT` |
| **crash / reconnect** | **无 office 事实来源**（见 §3.4） | `execution/crashed` | **P1** `DSH_NO_CRASH_FACT` |

**未映射的 journal 事件不产任何 fact**（只 canonical 化）：
`tool/call`、`assistant/message`、`turn/usage`、`subagent/*`、`user/message`、
`tool-workflow/*` 以及任何未来类型。这与 adapter 的默认分支
（`runtime-adapter.js:559-560`：`default: break; // unmapped types canonicalize without invented facts`）
是同一立场。

**跳过 ≠ 流结束**：`mapDshJournalEvent([type]) => {type: null}` 表示"这条事件不产事实"，
但 journal 流必须继续读到真正的 `turn/end`。
（实现期实测踩到：早期 `observe` 在遇到一次跳过时就判 `done`，于是一次 `tool/call`
就让整次执行"看起来结束"、Team 停在 `running`。现由 `test/dsh-execution-backend.test.js`
的"full journal sequence"用例钉住。）

---

## 3. 逐项盘点（关键发现）

### 3.1 `turn/end` 的 reason 是最可靠的事实来源

`main.js:4764-4772` 把 0.1.5 的 `data.reason` **对象**（`{kind}`）扁平化成字符串
（兼容 pre-0.1.5 的裸字符串）；`runtime-adapter.js:464-478` 是唯一的判定表。
本层的 `mapDshJournalEvent` **复刻同一判定**（不是重新发明）：

| reason | adapter 判定（既有） | 本层映射 |
|---|---|---|
| `completed` | `runtime/fact completed` | `execution/completed` |
| `error` / `failed` | `runtime/fact failed` | `execution/failed` |
| `blocked` | `runtime/fact attention reason='blocked'` | `execution/attention` |
| `aborted` / `interrupted` / `cancelled` | `runtime/cancelled`（evidence `turn/end:<reason>`） | `execution/cancelled` |
| 其它 / 缺失 | `runtime/fact attention`（**粗粒度 reason 保留**） | `execution/attention` reason=`unknown-reason` |

**重要**：未知 reason 一律降级为 `attention`，**绝不猜 failed**（继承既有立场；
`max-tokens` 属此类，实测在既有实现的 super-set 里被显式记录为 `attention`）。

本层只读 `data.reason`，**不读** `data.content` / `data.arguments` / `data.text` / `data.prompt`
（结构性断言）。因此"把日志文本正则匹配成 completed"这条路在实现上不存在。

### 3.2 工具失败没有 per-tool 粒度（P2）

`tool/call` 的翻译只保留**工具名**（`src/main.js:4774-4782` 用共享提取器
`toolNameOfJournalData(data)`，`src/office/runtime/tool-phrases.js:121-126`）；
`data.arguments` **永不进办公室**（契约 §3.1）。因此"某个工具失败"只能体现为
`turn/end` 的粗粒度 reason，无法给出 per-tool 失败原因。→ `DSH_NO_TOOL_FAILURE_DETAIL`（P2）。

### 3.3 cancel：**没有 journal ack**，ack 是合成的

`harness-rpc.js:386-388` 的 `session/cancel` 是一个**一元 RPC**（`{request:{sessionId}}`）；
`main.js:316-332` 的 `controlRequest` 在 RPC 成功后直接返回 `{ok:true}`，
**不 await 任何 ack 事件**。ack 事实由 office 组合根**合成**：
`office-module.js:3992-3995` 调 `reduce(control/cancel)` + `adapter.noteCancelAcknowledged()` +
`registry.cancelAcknowledged()`；`runtime-adapter.js:721-724` 的
`noteCancelAcknowledged` 只发 `{type:'control/cancel-ack'}`，注释明确
"only proves delivery. It is never a release"。

**对执行层的影响**：`execution/cancel-acknowledged` 的来源是
"RPC 一元响应成功"，**不是** journal 事件。本层照此实现（`transport.cancel()` 成功后产回执），
**不伪造终态**：`execution/cancelled` 仍然只能来自后续 `turn/end`。

**顺序规则**（实现期实测）：回执必须**排在已交付的 journal 事件之后**，否则
`cancel-requested` 会插到 `execution/started` 之前，下游顺序校验会把 `started`
当乱序。本层的 `cancel()` 只把回执**入队**（不立刻分配 `seq`），
交付顺序由 `pullEvents` 决定。

### 3.4 crash / reconnect：**刻意没有 office 事实**

- `mux` 有完整的连接状态机（`runtime-mux.js`：`idle`/`connecting`/`live`/`reconnecting`），
  但 `main.js:4249-4257` 的 `onFeedError` 只做 `runtimeHealth.noteFeedFailure(err)` + 日志；
  `runtime-health`（`1556-1574`）把降级原因（含 `feed-disconnected`）送到托盘/设置页/通知，
  **从不产生 office fact**。
- `officeFollowSyncTick`（`4608`）与 `officeAnswerResync`（`4853`）在 `mux.state !== 'live'`
  时**提前返回**并注释"the office keeps its local behavior… the shell must not wobble"。
- `runtime-supervisor.recordCrash`（`main.js:842`；崩溃 JSON 写于 `3864`）记录崩溃，
  但 `grep office src/runtime-supervisor.js` 为空 —— **零 office 耦合**。
- 唯一被 `main.js` 转成 office 效果的运行时生命周期信号是 **feed 拆除**：
  `stopEventsFeed`（4351-4385）调 `expirePendingFromRuntime()`（失效死掉的审批卡）。

**结论**：把"连接抖动"变成 Team crash 需要**先在壳侧新增一条受信的崩溃事实来源**——
这是一项独立变更（因为它会改变 office 的既有立场："sync 异常只改 sync"）。→
`DSH_NO_CRASH_FACT`（P1）。

### 3.5 身份：raw 只在壳内，且已有派生纪律

- raw sessionId 是 `main.js` 里所有映射表的 key（`officeFollowStreams` / cursors / known /
  removed / `imCommandBindings` / `officeToolCallArgs` 等）；
  第二次绑定时派生 `${rawSessionId}#tN`（`office-module.js:1488-1502`），
  壳侧用 `split('#')[0]` 归约回 raw 去开 follow 流（`main.js:4479`）。
- 渲染层零 sessionId（快照从不携带；`main.js:315` 注释与 `office-module.js:1486-1487` 同述）。
- `deriveRunProxy`（`runtime-adapter.js:815-820`）是"raw runId → `run-sha256:<16hex>`"
  **唯一**映射入口，且 fail-closed（空白 / `sk-` / `Bearer ` / `xox` / `gh[pousr]_` / >255 → `null`）。

本层的做法一致：**自己的命名空间、自己的派生、不共享 raw**。

---

## 4. 不兼容与缺口清单（fail-closed）

代码位置：`src/team/runtime/dsh-execution-backend.js` 的 `DSH_BACKEND_GAPS`（冻结常量）。

| 码 | 能力 | 级别 | 说明 |
|---|---|---|---|
| `DSH_SESSION_ROLE_BINDING_UNDECIDED` | `startRun` | **P0** | dsh 没有"按 Role 起一个会话"的原语：session 由用户/壳决定（`session/create` 只建空会话，`session/prompt` 需要既有 sessionId）。骨架要求宿主注入 `sessionFor({jobId,runId,role})`；未注入 → `EXEC_TRANSPORT_UNAVAILABLE`。**把它交给本层等于让执行层生成 prompt**（违反契约 §2 / 任务书 §9.3）。**这是本轮不接真实网络的首要原因。** |
| `DSH_NO_ARTIFACT_EVENT` | `execution/artifact` | P1 | dsh journal / follow 流没有任何"产物可用"事件；角色间 handoff 在 dsh 侧无原生表达。接入前必须先定稿"**谁有权声明 artifact 已可用**"——**不能是模型输出文本**（那会同时击穿隐私边界与"生产者不可伪造"）。 |
| `DSH_NO_CRASH_FACT` | `execution/crashed` | P1 | 见 §3.4。需要先在壳侧新增受信崩溃事实来源，且必须同时更新 `HARNESS-RUNTIME-CONTRACT-v0.md §9`（sync 异常只改 sync 的既有立场）。 |
| `DSH_NO_TOOL_FAILURE_DETAIL` | `execution/failed` 原因粒度 | P2 | 见 §3.2。 |

**另有两条"不是缺口但必须写清"的边界**：

1. **没有原生 approval 的"恢复同一运行态"**：`turn/end blocked` 之后的唯一继续方式是
   `session/prompt(mode:'steer'|'followup')`（`harness-rpc.js:381-385`），
   而 `pause`/`resume` 在既有 capability 里**恒为 false**（`runtime-adapter.js:81-84,167-175`）。
   因此 Team 的 attention 恢复在 dsh 侧只能走"新 prompt"，不能声称"恢复同一运行态"。
2. **`followup` / `steer` 不是终态证据**：它们只产生 `send-control` fact；
   终态仍然只能来自 `turn/end`。执行层的 `execution/cancel-acknowledged` 同理。

---

## 5. 已实现能力（本轮）

| 能力 | 位置 | 说明 |
|---|---|---|
| `WorkerExecutor` 端口形状 | `dsh-execution-backend.js` + `execution-port.js` | 满足端口契约：`startRun` / `observe` / `cancel`；`recover` 显式 `unsupported`（不是静默缺失） |
| 事件映射（纯函数） | `mapDshJournalEvent` / `coarseReasonOf` | 只读 `data.reason`，所以无 I/O、可离线单测 |
| fake / injected transport | `createInjectedTransport` | 内存事件数组 + cancel ack；**不发任何网络请求** |
| 无网络单元测试 | `test/dsh-execution-backend.test.js` | 18 项：映射逐条、来源 file:line 存在性、缺口清单、fail-closed、离线端到端（journal→controller→Team fact）、隐私、无网络双向证明 |
| 明确 unsupported | `capability()` + `unsupported` | artifact / crashed / recover 三项在能力自述里列为不可产出 |
| 离线端到端 | 测试内组装 | `createInjectedTransport(journal) → createDshExecutionBackend → controller → Team facts`，最终 `run/completed` 且证据 `execution/completed:ok` |

**端到端隐私实测**：注入的 journal 里带
`tool/call{name:'bash', arguments:{secret:'sk-x'}}` 与 `assistant/message{content:'model text'}`，
测试断言最终 Team 事实序列里**不含** `sk-x` / `secret` / `model text` / `bash` /
`tool/call` / `assistant/message` / `sess-host-provided`。

---

## 6. 未实现（明确声明）

| 未实现 | 为什么 |
|---|---|
| **真实 dsh session 启动** | P0 缺口 `DSH_SESSION_ROLE_BINDING_UNDECIDED` 未定稿（谁决定 Role↔Session）。 |
| **真实 follow 流消费** | 真实流由壳侧 `main.js` 持有（`runtimeMux.onItem`，测试断言它仍在壳里）；本层只做事件映射，**不**新增第二套 journal parser。 |
| **真实 transport（网络）** | 未实现；`createInjectedTransport` 是唯一的 transport 实现，`network: false`。 |
| **artifact / crash 事件** | 无来源（P1 缺口），能力自述里列为不可产出。 |
| **recover** | dsh 后端显式 `unsupported`。 |

**报告口径**：本轮 = headless 验证（离线、注入 transport）+ 无网络单测；
**不包含** GUI 验证与真实 dsh 接入（两者都未做，不得声称）。

---

## 7. 接入真实 dsh 的前置条件（下一阶段建议，不扩范围）

按依赖顺序：

1. **定稿 `sessionFor` 的所有权**（P0）：决定"Role ↔ Session"由谁指派。
   推荐：由**壳**（`main.js`）在收到 Team dispatch 时指派，并把 sessionId 只用于 transport 调用
   （不进 ExecutionEvent）——这与既有 `controlRequest` 注入模式同构。
2. **为 artifact 定一个受信来源**（P1）：必须是**结构化**信号（例如某个工具调用的**结果引用**），
   而不是模型文本。同时决定 `digest` 的真实语义（本轮是形状标记）。
3. **为 crash 定一个受信来源**（P1）：需要在壳侧新增事实，并同步更新
   `HARNESS-RUNTIME-CONTRACT-v0.md §9`（"sync 异常只改 sync"）。
4. **把 `main.js` 的翻译层与 `mapDshJournalEvent` 对齐**：两者判定的 reason 词表必须一致
   （既有测试已对 `main.js` 做源级漂移检测；新增 `execution` 来源后应加一条对等断言）。
5. **真实 transport 落地后再做 GUI 验证**：目前"办公室里的 Team 任务"只有 demo 路径可肉眼观察。

---

## 8. 如何复现本盘点

```bash
cd DshCockpit
node --test test/dsh-execution-backend.test.js        # 映射表 / 来源 / 缺口 / fail-closed / 离线端到端
node -e "console.log(require('./src/team/runtime/dsh-execution-backend.js').DSH_EXECUTION_MAPPING)"
node -e "console.log(require('./src/team/runtime/dsh-execution-backend.js').DSH_BACKEND_GAPS)"
```

映射表与缺口清单是**代码常量**，因此不会随文档腐烂：任何"来源"里的 `src/....js:NNN`
都会被测试断言"文件存在且行号在范围内"。