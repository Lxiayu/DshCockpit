# DeepSeek Harness Runtime 能力证据报告

> 目的：在 Virtual Office 进入 implementation plan 之前，区分 Harness 当前真实提供的 Runtime 能力与 DshCockpit Office State Adapter 需要自行派生的协议。
>
> 调研基线：`deepseek-ai/deepseek-harness`，commit `cd5ef8148158c3a752a658978873241fdf8e2bbc`（`dsh@0.1.2-alpha.1`），调研日期 2026-08-30。

## 结论摘要

Harness 是事件溯源的 Agent/Session Runtime。它真实提供 Session 事件日志、Agent 生命周期、子代理生命周期和 Session 控制/历史流；它不提供办公室语义的员工角色、`eventId`、`sessionEpoch`，也没有名为 `pause`、`resume`、`preempt` 的通用 Agent 操作。

因此 Office 采用两层边界：

```text
Harness 原生事实
  -> Office State Adapter（去重、代际、映射、快照）
  -> Character Runtime / Office UI
```

Office 适配层可以生成自己的 `eventId`、`sessionEpoch`、规范化信封和 resync 请求，但这些字段必须带 `sequenceSource=adapter` 或等价来源标记，不能在文档或 UI 中声称它们来自 Harness。

## 证据索引

以下路径均来自上述 commit，可通过 GitHub 固定 commit 直接复核：

- [`packages/core/session/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/session/src/types.ts)
- [`packages/core/agent/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/core/agent/src/types.ts)
- [`packages/subagent/subagent/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/types.ts)
- [`packages/subagent/subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/index.ts)
- [`packages/subagent/subagent/src/descriptor.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/subagent/subagent/src/descriptor.ts)
- [`packages/api/session-controller/src/client/sessions/session.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/cd5ef8148158c3a752a658978873241fdf8e2bbc/packages/api/session-controller/src/client/sessions/session.ts)

## Harness 原生事实

### 1. Session 事件信封与序号

`SessionEvent` 的核心字段是：

```ts
{
  type: SessionEventType
  seq: number
  time: number
  data: SessionEventMap[type]
}
```

源码明确说明：`seq` 是 Session 内单调连续序号，`time` 是 Unix epoch milliseconds。`Session.append()` 使用当前 log length 分配下一个 `seq`，事件日志是 append-only。

当前 commit 的核心 `SessionEvent` 没有原生 `eventId` 或 `sessionEpoch`。`sourceEventSeqs` 和 `surfaceOp` 只属于部分 surface 事件，不能当作全局事件 ID 或运行代际。

### 2. 可用于办公室映射的事件

`SessionEventMap` 明确定义了以下事件：

| 事件 | 可证明的用途 |
|---|---|
| `turn/start`, `turn/end` | 一轮模型处理开始/结束；`turn/end` 带 `TurnEndReason` |
| `step/start`, `step/end` | 一次模型请求步骤边界 |
| `user/message` | 用户或系统注入的模型可见消息 |
| `assistant/chunk`, `assistant/message` | 模型输出流与组装消息 |
| `tool/call`, `tool/result` | 工具调用、结果和工具错误字段 |
| `session/end-seed` | Session seed/继承历史的边界标记，不是存活信号 |
| `agent/inbox/*`、`team/*`、`goal/*`、`tool-workflow/*` | Agent 队列、协作和工作流扩展事件 |

这些事件可作为 Office Runtime 的事实来源，但 `finished`、`warning`、`error` 等办公室状态仍需要由适配层根据事件内容和终端原因派生。

`TurnEndReasonMap` 当前包含 `completed`、`aborted`（带 `AgentCancelCause`，例如 `user`、`parent`、`hook`、`disposed`）、`blocked`、`error`、`max-tokens` 和 `interrupted`。因此根 Session 的取消确认应以 `turn/end` 的 `aborted` 原因或后续 `agent/status=idle` 结合使用；不能把调用 `cancel()` 返回当成已终止。子代理还应等待配对的 `subagent/end`，其 `stopReason` 才是子代理运行的终态证据。

### 3. Agent 生命周期与控制

`packages/agent/src/types.ts` 定义：

```ts
type AgentStatus = 'idle' | 'running'
```

并提供 `agent/status` 事件。Agent 对象真实提供：

- `cancel(cause, { keepInbox })`：取消当前活动；可保留尚未开始的 inbox 工作。
- `followup(message)`：排队下一轮输入。
- `steer(message)`：在下一 step 边界导向当前 Agent。
- `inject(message)`：注入下一 step 的模型上下文。
- `whenIdle()`：等待当前整个 Agent 活动达到 quiescence。

当前公开类型没有通用 `pause()`、`resume()` 或 `preempt()`。子代理 Runtime 的 `interrupt()` 内部也是向目标 Agent 发出 `cancel(..., { keepInbox: true })`，并不会把一个新的“paused”事实写入 Session。

### 4. 子代理生命周期

`subagent/start` 与 `subagent/end` 是公开的 Runtime 事件。真实字段为：

```ts
// start
{ runId, provider, id, local }

// end
{ runId, provider, id, local, stopReason, lastAssistantMessage? }
```

这证明了子代理 Session ID、provider、run identity 和终止原因存在；没有业务角色、`eventId` 或 `sessionEpoch` 字段。`runId` 是一次子代理运行的配对标识，不是通用 Session 事件 ID。

### 5. 子代理 descriptor 与 Session Header

`subagent/descriptor` 当前版本为 `3`，主要字段包括：`version`、`mode`（`one-shot | continuable`）、`provider`、`label`、可选 `agentProvider`、`agentModel`、`agentReasoningEffort`、`persona`、`toolFilter`。

Session Header 真实字段包括：`version`、`id`、`createdAt`、可选 `cwd`、`parentSession`、`seedLength`、`origin='subagent'`、`delegationDepth`、`agentPreset`。这些字段可以支持 Office 的 Session 归属、父子关系和展示标签，但不等同于办公室角色配置。

### 6. 客户端控制、跟随和分页流

Session Controller/Client 公开三类能力：

- `session.control()`：先发送完整 baseline，再发送后续 delta，用于主机级队列、projection 和 jobs 的实时控制流。
- `session.follow()`：打开带 opening snapshot 的 Session journal，随后接收 append/change。
- `session.page({ throughSeq })`：按序号分页读取历史。

客户端事件窗口以连续 `seq` 判断相邻事件（`right === left + 1`）。这些能力可以作为 Office 适配器的输入和重连依据，但返回的 baseline/projection 不是 Office 的 `office:runtime-snapshot`；后者仍是 DshCockpit 自己定义的跨层契约。

## 明确未证明的能力

下列内容在当前 commit 的公开核心类型中没有被证明存在，第一版不得当成 Harness 原生事实：

| 能力 | 处理方式 |
|---|---|
| 全局 `eventId` | Adapter 用规范化 payload + Session/epoch/seq 指纹派生 |
| `sessionEpoch` / 重连代际 | Adapter 在连接/重启时生成并管理；不能从旧快照推断 |
| Office Runtime snapshot/resync | Adapter 基于 `session.follow/page/control` 组合实现 |
| `pause` / `resume` | 不在第一版 UI 暴露；除非实际接线验证出明确 RPC 和确认事件 |
| `preempt` | Office 队列策略；当前只能“cancel 当前 + 等待终止确认 + 再派发” |
| 固定编码/搜索/审查业务角色 | 由 DshCockpit Employee Profile 定义，不能从 provider 推断 |

## Office 适配层契约

适配层仍可向状态机提供统一信封：

```json
{
  "eventId": "adapter-fingerprint-or-upstream-id",
  "sessionId": "session-...",
  "sessionEpoch": "adapter-epoch-...",
  "sequence": 17,
  "eventType": "tool/call",
  "payload": {},
  "sequenceSource": "upstream | adapter",
  "receivedAt": "2026-08-30T00:00:00.000Z"
}
```

适配器规则：

1. 优先使用 Harness `seq` 作为 Session 内序号；不存在时才使用 `(sessionId, sessionEpoch)` 范围内的 Adapter 计数器。
2. 当前 Harness 没有事件 ID，因此默认用 `sessionEpoch + sessionId + seq/type/payload` 的 SHA-256 指纹去重；同一序号重复到达时以序号水位为权威。
3. 连接重启或检测到新 Runtime 实例时生成新 epoch；旧 epoch 事件永远不能改变当前绑定。
4. `follow/page/control` 的 baseline 只能作为 resync 输入。Office snapshot 请求/响应必须使用 `office:*` 命名空间，并由 Adapter 校验 request/session/epoch。
5. 缺口、超时和拒绝只改变 `sync=stale|resyncing` 与诊断，不猜测 `running/completed/failed`。

## 用户控制降级矩阵

| Office 命令 | 当前可用 Harness 映射 | 第一版产品行为 |
|---|---|---|
| cancel | `Agent.cancel()`；子代理可用 `subagent.interrupt()` | 暴露；进入 `cancellationPending`，保留 binding，直到根 Session 的 `turn/end(aborted)`、子代理 `subagent/end` 或等价的可证明终止事件。API 返回只代表取消已发出，不代表已 quiescent |
| preempt | 无原生 preempt；可组合 cancel + Office FIFO | 仅作为队列策略；先取消并等待旧 Session 终止，再启动下一项 |
| pause | 未发现原生 pause RPC/事件 | 默认不暴露；不得伪造 paused Runtime 状态。未来若接线证明能力，再增加 adapter capability |
| resume | 未发现与 pause 配对的原生 resume | 默认不暴露；不能用 `followup/steer` 冒充恢复同一运行态 |
| steer | `Agent.steer()` | 仅在明确目标 Session 且语义允许时使用；显示为“引导”而非暂停/恢复 |
| followup | `Agent.followup()` / continuable subagent followup | 作为新的输入排队，不改变上一条 Runtime 事实 |
| inject | `Agent.inject()` | 作为下一 step 上下文注入，不直接改变办公室状态 |

控制超时、RPC 不可用或终止原因未知时，UI 显示待确认/同步诊断；不把超时渲染成完成、失败或离线。

## 实机验证门

本报告证明的是官方源码契约，不替代当前 DshCockpit 所连接的具体 Harness 版本验证。进入 implementation plan 前，必须用目标运行时做一次只读兼容探针：

1. 订阅 `session.follow()` 或等价事件流，记录事件原样 envelope、`seq` 连续性和断线重连行为。
2. 触发一次工具调用、一次取消和一次子代理 start/end，保存脱敏日志。
3. 验证 DshCockpit 当前 RPC 层能否定位 Session 并调用 cancel/interrupt；若版本不同，更新本报告的“目标运行时差异”小节。
4. 验证 baseline、delta 和 page 是否足以实现 Office resync；不足时只扩展 Adapter，不修改 Harness。

探针只读或使用可取消的测试 Session，不写入生产会话，不把密钥或完整任务内容提交到仓库。
