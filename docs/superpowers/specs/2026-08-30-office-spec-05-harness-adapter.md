# Office SPEC-05：Harness State Adapter、Resync 与控制

> Status: Draft

## 目标与非目标

目标是把 Harness 原始事件转换成版本化、去重、可重放的 Office canonical envelope，并在丢包/重连时安全 resync。非目标：修改 Harness 协议、凭空添加全局 event ID/epoch、把 cancel 返回当 terminal、实现未证明的 pause/resume/preempt。

## 前置阅读与边界

先读 handoff、索引、plan、`HARNESS-RUNTIME-EVIDENCE-2026-08.md`、SPEC-01、SPEC-03、SPEC-04。允许修改 `src/office/runtime/runtime-adapter.js`、`runtime-snapshot.js`、必要的 `src/harness-rpc.js` 适配和测试；禁止 Renderer 直接订阅 Harness、禁止写 sessions/旧 runtime-state。

## 输入与 envelope

原始输入固定为 `{type,seq,time,data}`。输出为：

```json
{
  "schemaVersion":1, "eventId":"sha256:...", "sessionId":"opaque",
  "sessionEpoch":"adapter-...", "sequence":17, "eventType":"tool/call",
  "payload":{}, "sequenceSource":"upstream|adapter", "receivedAt":"ISO-8601"
}
```

`eventId` 与 `sessionEpoch` 是 Adapter 派生字段，不得写成 Harness 原生事实。无 upstream sequence 时，对 `sessionEpoch + sessionId + seq-or-empty + eventType + canonicalJson(payload)` 做 SHA-256，再分配该范围内 adapter counter。payload 必须先过 privacy redactor，拒绝循环、超大或不可 JSON 化值。

## 去重、乱序与 resync

每个 `(sessionId,sessionEpoch)` 使用 4096 条、TTL 10 分钟 LRU；sequence watermark 优先于重复 hash。`last+1` 立即应用；前跳最多缓存 64 条或 2 秒并置 `sync=resyncing`。新 epoch 清空 buffer/pending/dedupe；超时或无效响应丢弃 buffer、置 `stale`，不猜测运行时状态。sync 变化不影响本地漫游、聊天、休息或最后可信任务表现。

请求：`{type:"office:runtime-resync-request",requestId,sessionId,sessionEpoch,fromSequence}`。响应：`{type:"office:runtime-snapshot",requestId,sessionId,sessionEpoch,sequence,facts,eventsSince}`。Adapter 可组合 `session.follow/page/control` 获取，但只有 request/session/epoch 全匹配才接受；snapshot sequence 成为 watermark；eventsSince 必须同 epoch、严格递增且大于 snapshot sequence。重试 250/500/1000ms，封顶 5s，最多 5 次后 stale。

## Runtime 映射与控制

`agent/status=running` -> runtime running；`idle` 仅无活动。`turn/end.reason` 和 `subagent/end.stopReason` 必须按值映射 completed/error/blocked/aborted/interrupted/cancelled，未知值为 `attention` 并保留 coarse reason。`cancel`/`interrupt` 的返回只生成 `control=cancellationPending`；terminal evidence 到达才清 binding。

capability 为 `{adapterVersion,runtimeVersion,supports,terminalEvidence}`。`followup/steer/inject` 保留原语义；pause/resume/native preempt 未证明则 false，UI 不渲染。Office urgent preempt 是组合动作，不伪装成一个原生调用。

## 实现步骤、测试与验收

1. 写 fixture replay 的失败测试：重复、乱序、gap、epoch、LRU、snapshot 合并、重试、terminal reason、cancel pending、unsupported control。
2. 运行 `node --test test/office-runtime-adapter.test.js test/office-runtime-snapshot.test.js`，预期失败。
3. 实现 canonicalization、hash/LRU、buffer/resync、capability mapper；所有时间由注入 clock 提供。
4. 回放研究报告 fixture 和探针实际 fixture，检查 canonical JSON 稳定性与隐私。

验收：重复不产生二次任务，乱序不倒退 watermark，gap 不猜状态，旧 epoch 不污染新状态，terminal reason 正确，stale 不产生 offline。发现 Harness 事实不足时只降级 capability 并记录，不扩展输入契约。

## 交接报告、交付与停止条件

交付报告列出输入/输出 schema、hash 算法、LRU 参数、重试时间线、能力矩阵、fixture 和测试结果。若需要修改 Harness 原语、无法获得 terminal evidence、或 resync 响应没有稳定序列，停止并请求主代理更新研究报告/契约。
