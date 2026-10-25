'use strict';

// test/harness-runtime-kernel-probe.test.js — 第 0 步工程任务 / Phase 3.
//
// 无 UI 内核探针（Harness Runtime Kernel Probe）。
//
// 目的：在不启动 Electron / DOM / Pixi 的前提下，证明现有 office runtime 的
// 纯模块（adapter / snapshot / reducer / registry / wiring / classifier）**已经**
// 可以作为一个无 UI、可测试、可复用的 Harness Runtime 内核被驱动，并把它的
// 契约行为钉死。契约文本见 docs/specs/HARNESS-RUNTIME-CONTRACT-v0.md。
//
// 边界（本文件刻意不做的事）：
//   - 不 require electron / pixi / DOM / office.html；不 require office-module.js
//     （它是 Electron 组合根，允许 node:fs）。依赖边界由
//     test/office-runtime-boundary.test.js 单独门禁。
//   - 不使用真实墙钟或随机数：所有时间来自注入的 fake clock。
//   - 不断言日志文本：所有结论来自**结构化摘要**（digest），可比较、可 JSON 往返。
//   - 不复刻 office-module 的表现层编排（resultUntilMs 呈现窗口、行走/落座动画、
//     气泡、工位预留）。那些是表现层，由 office-transition-loop.test.js /
//     office-task-end-recovery.test.js 覆盖。本探针只复刻**权威操作**：
//     绑定创建/释放、reducer 事件、队列交接。
//
// 探针里唯一"复刻"生产代码的部分是 0.1.5 journal → adapter 词表的翻译层
// （main.js 的 ingestOfficeJournalEvent）。理由：main.js 是 Electron 壳，不能
// 被无 UI 探针 require。翻译层因此被显式复刻并**在边界门禁里对 main.js 做源级
// 契约钉住**，防止两边漂移。工具名提取直接复用生产模块 tool-phrases.js 的
// toolNameOfJournalData（与 main.js 同一个实现），子代理信号复用生产模块
// subagent-wiring.js。
//
// 本探针钉住的契约性质（收尾阶段已修复，断言全部是**正确行为**断言）：
//   P0. 子代理配对 handle 由 adapter 在首次 raw ingest 时派生一次，并随 canonical
//       envelope 的 `pairingHandle` 字段传递 —— 因此 live 投递、buffer 补发
//       （drainBuffer）与 canonical eventsSince 重放三条路径配对结果一致；缺失
//       handle 时 fail-closed（不猜、不释放错误 binding）。
//   P2. `runtime/cancelled` 的 evidence 是**来源限定的单前缀**值（`turn/end:<reason>`），
//       下游原样消费，不再重复拼接。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  KERNEL_VERSION,
  KERNEL_SCHEMA_VERSION,
  createRuntimeAdapter,
  deriveRunProxy,
  createOfficeState,
  reduceOfficeState,
  createEmployeeRegistry,
  createSubagentWiring,
  createPrivacyRedactor,
  settlementStopReason,
} = require('../src/office/runtime/index.js');
const snapshotModule = require('../src/office/runtime/runtime-snapshot.js');
const { toolNameOfJournalData } = require('../src/office/runtime/tool-phrases.js');

const T0 = 1_700_000_000_000; // fixed fake epoch ms
const SESSION = 'sess-kernel';
const WORK_SEATS = Object.freeze(['researcher', 'coder', 'reviewer']);
// 任务态 activity（与 office-module 的 TASK_ACTIVITIES 同义）。取消/终态路径用它
// 判断"是否需要把 activity 归位到本地行为"。
const TASK_ACTIVITIES = Object.freeze(['working', 'thinking', 'waiting', 'celebrating']);
// 这些 fact 是命令/诊断回执，不是状态事实：摘要把它们的**顺序**折掉（它们的
// 顺序按设计就是顺序相关的——例如 resync 期间必然出现 resyncing→healthy），
// 只保留最终 sync。它们的顺序敏感性由专门的断言覆盖。
const DIAGNOSTIC_FACT_TYPES = Object.freeze(['sync/status', 'control/cancel-ack', 'send-control']);

// ---------------------------------------------------------------------------
// 0.1.5 journal → adapter 词表（main.js ingestOfficeJournalEvent 的显式复刻）
// ---------------------------------------------------------------------------

function translateJournalEvent(event, data) {
  if (event.type === 'turn/start') {
    return { type: 'agent/status', data: { status: 'running' } };
  }
  if (event.type === 'turn/end') {
    const reason = data.reason && typeof data.reason === 'object' && typeof data.reason.kind === 'string'
      ? data.reason.kind
      : (typeof data.reason === 'string' && data.reason ? data.reason : null);
    return { type: 'turn/end', data: reason ? { turn: data.turn, reason } : { turn: data.turn } };
  }
  if (event.type === 'tool/call') {
    // 只有工具名是事实；参数原文永不进入办公室（隐私边界 + 64KB payload 上限）。
    return { type: 'tool/call', data: { tool: toolNameOfJournalData(data) } };
  }
  if (event.type === 'assistant/message') {
    const usage = data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage) ? data.usage : null;
    if (!usage) return null;
    const nonNegInt = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
    const bucket = {
      input: nonNegInt(usage.inputTokens),
      output: nonNegInt(usage.outputTokens),
      cacheRead: nonNegInt(usage.cacheReadTokens),
      cacheWrite: nonNegInt(usage.cacheWriteTokens),
    };
    const total = bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite;
    if (total <= 0) return null;
    return {
      type: 'turn/usage',
      data: {
        turn: Number.isFinite(Number(data.turn)) ? Number(data.turn) : null,
        usage: bucket,
        // 成本由壳按本地费率估算；探针只验证它是非负有限数，不依赖费率表。
        cost: 0.0125,
      },
    };
  }
  return null; // 不由翻译层拥有：交给 subagent-wiring 或通用 ingest
}

// ---------------------------------------------------------------------------
// 内核探针：只用纯模块组装一个无 UI runtime
// ---------------------------------------------------------------------------

function createKernel({ startMs = T0, sessionId = SESSION } = {}) {
  let nowMs = startMs;
  const clock = { nowMs: () => nowMs };
  const advance = (ms) => { nowMs += ms; };

  const emitted = [];        // 每次 adapter 输出（envelope|null, facts, diagnostics）
  const resyncRequests = []; // office:runtime-resync-request（被壳回答前）
  const verdicts = [];       // 每次 ingest 的 verdict（计数用）
  const diagnostics = [];    // 模块级诊断码（本探针只收集 code）
  const recordsByEmployee = new Map(); // employeeId -> { state }

  const registry = createEmployeeRegistry({ clock });
  const redactor = createPrivacyRedactor({ mode: 'redacted' });

  const activeRootHandles = new Map(); // rawSessionId -> handle
  const queuedRootHandles = new Map(); // rawSessionId -> derived handle
  const turnCounters = new Map();      // employeeId -> derived-handle counter
  let globalSync = 'healthy';
  let currentRawEvent = null;
  let lastWireVerdict = null;
  let epochRotations = 0;

  const adapter = createRuntimeAdapter({
    sessionId,
    clock,
    redactor,
    onEvent: (output) => { emitted.push(output); applyOutput(output); },
    onMessage: (message) => { resyncRequests.push(message); },
  });

  const wiring = createSubagentWiring({
    emit: (sid, event) => { ingestWire(sid, event); },
    // 壳日志不属于内核边界（也不属于本探针的断言对象）。
    log: () => {},
  });

  // ---- 每员工 reducer 状态 -------------------------------------------------

  function recFor(employeeId) {
    let rec = recordsByEmployee.get(employeeId);
    if (!rec) {
      rec = { employeeId, state: createOfficeState() };
      recordsByEmployee.set(employeeId, rec);
    }
    return rec;
  }

  function reduce(rec, event) {
    const result = reduceOfficeState(rec.state, event);
    rec.state = result.state;
    return result.effects;
  }

  // ---- 绑定 handle（复刻 office-module 的 raw ↔ handle 映射语义） -----------

  function currentRootHandle(rawSessionId) {
    const mapped = activeRootHandles.get(rawSessionId);
    if (mapped) {
      const binding = registry.getBindingForSession(mapped);
      if (binding && binding.releasedAt === null) return mapped;
      activeRootHandles.delete(rawSessionId);
    }
    const direct = registry.getBindingForSession(rawSessionId);
    if (direct && direct.releasedAt === null) {
      activeRootHandles.set(rawSessionId, rawSessionId);
      return rawSessionId;
    }
    return null;
  }

  function resolveActiveRootBinding(rawSessionId) {
    const handle = currentRootHandle(rawSessionId);
    if (!handle) return null;
    const binding = registry.getBindingForSession(handle);
    if (!binding || binding.releasedAt !== null) return null;
    return { handle, binding };
  }

  function clearRootHandle(handle) {
    for (const [raw, mapped] of [...activeRootHandles]) {
      if (mapped === handle) activeRootHandles.delete(raw);
    }
  }

  function ensureRootBinding(rawSessionId) {
    const existing = currentRootHandle(rawSessionId);
    if (existing) return registry.getBindingForSession(existing);
    if (queuedRootHandles.has(rawSessionId)) return null;
    let bound = registry.bindRootSession({ sessionId: rawSessionId, nowMs: nowMs });
    let usedId = rawSessionId;
    if (!bound.ok && bound.code === 'SESSION_BINDING_RELEASED') {
      const next = (turnCounters.get('orchestrator') || 0) + 1;
      turnCounters.set('orchestrator', next);
      usedId = `${rawSessionId}#t${next}`;
      bound = registry.bindRootSession({ sessionId: usedId, nowMs: nowMs });
    }
    if (!bound.ok) { diagnostics.push('BINDING_FAILED'); return null; }
    if (bound.queued || !bound.binding) {
      if (usedId !== rawSessionId) queuedRootHandles.set(rawSessionId, usedId);
      return null;
    }
    activeRootHandles.set(rawSessionId, usedId);
    queuedRootHandles.delete(rawSessionId);
    onBindingCreated(bound.binding);
    return bound.binding;
  }

  // 新绑定创建时的 reducer 事务（复刻 onBindingCreated 的权威部分：control/dispatch）。
  function onBindingCreated(binding) {
    const rec = recFor(binding.employeeId);
    reduce(rec, { type: 'control/dispatch' });
  }

  function applyRegistryEffects(effects) {
    for (const effect of effects || []) {
      if (effect.type !== 'dispatch-started') continue;
      const binding = registry.getBindingForSession(effect.sessionId);
      if (!binding || binding.releasedAt !== null) continue;
      const rec = recFor(binding.employeeId);
      if (rec.state.queue === 'queued') reduce(rec, { type: 'queue/dequeue' });
      onBindingCreated(binding);
    }
  }

  // 终态收敛（复刻 commitReleasedTerminal 的 reducer 部分）。
  function commitReleasedTerminal(rec) {
    if (rec.state.binding === 'releasing') reduce(rec, { type: 'binding/released' });
    reduce(rec, { type: 'transition/complete' });
  }

  function releaseTerminalNow(rawSessionId, evidence, outcome) {
    const handle = currentRootHandle(rawSessionId) || queuedRootHandles.get(rawSessionId) || rawSessionId;
    const binding = registry.getBindingForSession(handle);
    if (!binding || binding.releasedAt !== null) {
      registry.retainQueuedTerminal({
        sessionId: handle,
        evidenceType: evidence.startsWith('subagent/') ? 'subagent-end' : 'session-end',
        outcome,
        nowMs: nowMs,
      });
      return;
    }
    const rec = recFor(binding.employeeId);
    const result = registry.releaseBinding({ sessionId: handle, nowMs: nowMs, evidence, outcome });
    if (!result.ok) { diagnostics.push('RELEASE_FAILED'); return; }
    clearRootHandle(handle);
    // 与 office-module 一致：reducer 的 cancelled 收敛**有** control 前置条件
    // （纵深防御），registry 的绑定释放则无条件（终态证据即权威）。
    if (rec.state.control === 'cancellationPending' || rec.state.control === 'preemptPending') {
      reduce(rec, { type: 'runtime/cancelled', evidence });
    }
    if (rec.state.binding === 'releasing') reduce(rec, { type: 'binding/released' });
    reduce(rec, { type: 'runtime/fact', fact: 'idle' });
    if (TASK_ACTIVITIES.includes(rec.state.activity)) {
      reduce(rec, { type: 'local/activity', activity: 'roaming', reason: 'task-released' });
    }
    applyRegistryEffects(result.effects);
  }

  // ---- facts → registry + reducer（复刻 office-module applyFact 的权威部分） --

  /** 复刻 office-module.correlatedChildId：fact 的配对 handle 必须与关联 raw 事件
   *  自己派生出的 handle 一致（含"两者都为 null"这一合法情形），否则 raw child id
   *  不可信（位置性关联已失效）。 */
  function correlatedChildId(rawEvent, pairingHandle) {
    const data = rawEvent && rawEvent.data && typeof rawEvent.data === 'object' ? rawEvent.data : null;
    if (!data || typeof data.id !== 'string' || data.id === '') return null;
    const expected = typeof pairingHandle === 'string' && pairingHandle !== '' ? pairingHandle : null;
    return deriveRunProxy(data.runId) === expected ? data.id : null;
  }

  function applyFact(fact, rawEvent) {
    const rawSessionId = rawEvent && rawEvent.sessionId ? rawEvent.sessionId : null;
    switch (fact.type) {
      case 'runtime/fact': {
        if (!rawSessionId) return;
        if (fact.fact === 'running' || fact.fact === 'attention') {
          const binding = ensureRootBinding(rawSessionId);
          if (!binding) return;
          const rec = recFor(binding.employeeId);
          reduce(rec, { type: 'runtime/fact', fact: fact.fact, reason: fact.reason || null });
        } else if (fact.fact === 'completed' || fact.fact === 'failed') {
          const resolved = resolveActiveRootBinding(rawSessionId);
          if (!resolved) {
            registry.retainQueuedTerminal({
              sessionId: queuedRootHandles.get(rawSessionId) || rawSessionId,
              evidenceType: 'turn-end',
              outcome: fact.fact,
              nowMs: nowMs,
            });
            return;
          }
          const rec = recFor(resolved.binding.employeeId);
          const evidence = `turn/end:${fact.reason || fact.fact}`;
          reduce(rec, { type: 'runtime/fact', fact: fact.fact, reason: fact.reason || null });
          // 呈现窗口（resultUntilMs）是表现层：探针立即执行等价释放。
          const released = registry.releaseBinding({
            sessionId: resolved.handle, nowMs: nowMs, evidence, outcome: fact.fact,
          });
          if (!released.ok) { diagnostics.push('RELEASE_FAILED'); return; }
          clearRootHandle(resolved.handle);
          commitReleasedTerminal(rec);
          applyRegistryEffects(released.effects);
        }
        break;
      }
      case 'runtime/cancelled': {
        if (!rawSessionId) return;
        // evidence 已由 adapter 构造成来源限定的完整值（`turn/end:<reason>`），
        // 原样消费；重复拼前缀会产出 `turn/end:turn/end:<reason>`（P2 已修）。
        releaseTerminalNow(rawSessionId, fact.evidence || 'turn/end:cancelled', 'cancelled');
        break;
      }
      case 'runtime/tool': {
        const resolved = resolveActiveRootBinding(rawSessionId);
        if (!resolved) return;
        const rec = recFor(resolved.binding.employeeId);
        reduce(rec, { type: 'runtime/tool', tool: fact.tool || null });
        break;
      }
      case 'runtime/usage': {
        const resolved = resolveActiveRootBinding(rawSessionId);
        if (!resolved) return;
        const rec = recFor(resolved.binding.employeeId);
        rec.lastUsage = { ...fact.usage, cost: fact.cost };
        break;
      }
      case 'runtime/subagent-start': {
        if (!rawSessionId) return;
        const rawChildId = correlatedChildId(rawEvent, fact.runId);
        if (!rawChildId) {
          // 复刻 office-module：fail closed + 可观测（不猜子会话、不静默）。
          diagnostics.push('SUBAGENT_IDENTITY_UNRESOLVED');
          return;
        }
        const runProxy = fact.runId || deriveRunProxy(rawEvent.data && rawEvent.data.runId);
        ensureRootBinding(rawSessionId);
        registry.registerChildSession({
          parentSessionId: rawSessionId, childSessionId: rawChildId, runId: runProxy, nowMs: nowMs,
        });
        if (fact.role && WORK_SEATS.includes(fact.role)) {
          const placed = registry.registerClassifiedSubagent({
            sessionId: rawChildId, runId: runProxy, employeeId: fact.role, nowMs: nowMs,
          });
          if (placed.ok) {
            const rec = recFor(placed.employeeId);
            if (placed.binding) onBindingCreated(placed.binding);
            else reduce(rec, { type: 'queue/enqueue' });
            reduce(rec, { type: 'runtime/fact', fact: 'running', reason: null });
          } else {
            diagnostics.push(placed.code || 'CLASSIFIED_SUBAGENT_REJECTED');
          }
          break;
        }
        registry.registerUnclassifiedSubagent({ sessionId: rawChildId, runId: runProxy, nowMs: nowMs });
        const collaborator = recFor('collaborator');
        reduce(collaborator, { type: 'queue/enqueue' });
        const assigned = registry.assignNextCollaboratorItem({ nowMs: nowMs });
        if (assigned.ok && assigned.binding) onBindingCreated(assigned.binding);
        // 与 office-module 一致：UNCLASSIFIED 分支**不**强制 running。协作者座位的
        // runtime 由该子会话自己的 follow 流（turn/start）驱动 —— 本探针只建模
        // 一个根会话，因此这里协作者停在 unbound（binding 已 active）。
        break;
      }
      case 'runtime/subagent-end': {
        // 身份以配对 handle 为准（replay 稳定）；raw id 只在关联可信时回落。
        const runProxy = fact.runId || deriveRunProxy(rawEvent && rawEvent.data && rawEvent.data.runId);
        const childSessionId = registry.childSessionIdForRunId(fact.runId)
          || correlatedChildId(rawEvent, fact.runId);
        if (!childSessionId) {
          diagnostics.push('SUBAGENT_IDENTITY_UNRESOLVED');
          return;
        }
        if (fact.terminal === true) {
          const outcome = fact.outcome === 'failed' ? 'failed' : fact.outcome === 'cancelled' ? 'cancelled' : 'completed';
          if (outcome === 'cancelled') {
            releaseTerminalNow(childSessionId, `subagent/end:${fact.stopReason || 'cancelled'}`, 'cancelled');
          } else {
            const binding = registry.getBindingForSession(childSessionId);
            if (!binding || binding.releasedAt !== null) {
              const retained = registry.retainQueuedTerminal({
                sessionId: childSessionId, evidenceType: 'subagent-end', outcome, runId: runProxy, nowMs: nowMs,
              });
              if (!retained.ok && retained.code && retained.code.startsWith('RUN_ID_')) diagnostics.push(retained.code);
              break;
            }
            const rec = recFor(binding.employeeId);
            const released = registry.subagentEnd({
              sessionId: childSessionId, runId: runProxy, stopReason: fact.stopReason, terminalEvidence: true, nowMs: nowMs,
            });
            if (!released.ok) { diagnostics.push(released.code || 'RELEASE_FAILED'); break; }
            reduce(rec, { type: 'runtime/fact', fact: outcome, reason: `subagent/end:${fact.stopReason}` });
            commitReleasedTerminal(rec);
            applyRegistryEffects(released.effects);
          }
        }
        break;
      }
      case 'sync/status':
      case 'control/cancel-ack':
      case 'send-control':
      default:
        // 与 office-module 一致：sync 由 recomputeGlobalSync 聚合，回执 fact 无动作。
        break;
    }
  }

  function recomputeGlobalSync() {
    const next = adapter.state().sync;
    if (next === globalSync) return;
    globalSync = next;
    for (const rec of recordsByEmployee.values()) reduce(rec, { type: 'sync/status', sync: next });
  }

  function applyOutput(output) {
    for (const fact of output.facts) applyFact(fact, currentRawEvent);
    for (const diag of output.diagnostics) diagnostics.push(diag.code || 'ADAPTER_DIAGNOSTIC');
    recomputeGlobalSync();
  }

  // ---- 摄入入口 ------------------------------------------------------------

  function ingestWire(sid, event) {
    currentRawEvent = { sessionId: sid, type: event.type, seq: event.seq, time: event.time, data: event.data };
    const verdict = adapter.ingest(event);
    currentRawEvent = null;
    lastWireVerdict = verdict;
    verdicts.push(verdict.status);
    recomputeGlobalSync();
    return verdict;
  }

  /** 一条 journal 记录：翻译层 → subagent-wiring → 通用 ingest（复刻 main.js）。
   *  同时接受 adapter 文档化的 `{event:{…}}` 包装形状（session.history 形态），
   *  与 parseRawEvent 的输入契约一致。 */
  function ingestJournal(event) {
    const unwrapped = event && event.type === undefined && event.event && typeof event.event === 'object'
      ? event.event
      : event;
    const data = unwrapped.data && typeof unwrapped.data === 'object' ? unwrapped.data : {};
    const translated = translateJournalEvent(unwrapped, data);
    if (translated) {
      return ingestWire(sessionId, {
        type: translated.type, seq: unwrapped.seq, time: unwrapped.time, data: translated.data,
      });
    }
    if (wiring.handleEvent(sessionId, unwrapped)) {
      // wiring 消费了这条记录：它已经 emit 了一个带原始 seq 的 office 事件，
      // 因此调用方**不能**再通用 ingest（否则水位会开出假断档）。
      return { status: 'accepted', via: 'wiring', envelope: lastWireVerdict ? lastWireVerdict.envelope : null };
    }
    return ingestWire(sessionId, {
      type: unwrapped.type, seq: unwrapped.seq, time: unwrapped.time, data: unwrapped.data,
    });
  }

  /** 用户控制（复刻 controlIntent 的 cancel 分支：capability → send-control →
   *  reducer control/cancel → adapter ack → registry ack）。 */
  function cancel() {
    const requested = adapter.requestControl({ control: 'cancel' });
    if (!requested.ok) return { ok: false, code: requested.code };
    const handle = currentRootHandle(sessionId) || queuedRootHandles.get(sessionId) || sessionId;
    const binding = registry.getBindingForSession(handle);
    if (!binding || binding.releasedAt !== null) return { ok: false, code: 'NOT_BOUND' };
    const rec = recFor(binding.employeeId);
    reduce(rec, { type: 'control/cancel' });
    adapter.noteCancelAcknowledged();
    registry.cancelAcknowledged({ sessionId: handle, nowMs: nowMs });
    return { ok: true, control: 'cancel' };
  }

  /** 壳的回填（复刻 ingestHarnessSnapshot 的三模式水位决策）。 */
  function ingestWindow(records) {
    const sorted = [...records].sort((a, b) => a.seq - b.seq);
    if (sorted.length === 0) return { ok: false, code: 'RECORDS_EMPTY' };
    const before = adapter.state();
    const firstSeq = sorted[0].seq;
    if (firstSeq <= before.watermark + 1 && before.sync !== 'stale') {
      // continuation：重叠部分被水位/去重吸收，缺口被填上后 buffer 自动 drain。
      for (const event of sorted) ingestJournal(event);
      return { ok: true, mode: 'continuation' };
    }
    // baseline restart：轮换 epoch，用裸 baseline（sequence 0、无 facts）回答
    // 轮换自己发出的请求，再从**旧水位之上**重放（≤旧水位的不重放，避免双记）。
    epochRotations += 1;
    adapter.rotateEpoch();
    const pending = resyncRequests[resyncRequests.length - 1];
    const bare = snapshotModule.createSnapshotResponse({
      requestId: pending.requestId,
      sessionId,
      sessionEpoch: pending.sessionEpoch,
      sequence: 0,
      facts: {},
      eventsSince: [],
    });
    const merged = adapter.acceptSnapshot(bare);
    if (!merged.ok) return { ok: false, code: `RESYNC_ANSWER_${merged.code}` };
    for (const event of sorted) {
      if (event.seq <= before.watermark) continue;
      ingestJournal(event);
    }
    return { ok: true, mode: 'baseline' };
  }

  /** 直接投递一份 office:runtime-snapshot（含 eventsSince 重放）。 */
  function acceptSnapshotMessage({ sequence, facts, eventsSince }) {
    const pending = resyncRequests[resyncRequests.length - 1];
    if (!pending) return { ok: false, code: 'NO_PENDING_REQUEST' };
    const message = snapshotModule.createSnapshotResponse({
      requestId: pending.requestId,
      sessionId,
      sessionEpoch: pending.sessionEpoch,
      sequence,
      facts: facts || {},
      eventsSince: eventsSince || [],
    });
    currentRawEvent = { sessionId, type: 'snapshot-replay', seq: null, time: nowMs, data: {} };
    const merged = adapter.acceptSnapshot(message);
    currentRawEvent = null;
    recomputeGlobalSync();
    return merged;
  }

  /** 用同一 epoch 的 scratch adapter 生成 canonical envelope（eventId 必须匹配）。 */
  function envelopeFor(event, epoch) {
    const scratch = createRuntimeAdapter({
      sessionId, clock, epoch, onEvent: () => {}, onMessage: () => {},
    });
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const translated = translateJournalEvent(event, data);
    const wire = translated
      ? { type: translated.type, seq: event.seq, time: event.time, data: translated.data }
      : { type: event.type, seq: event.seq, time: event.time, data };
    return scratch.ingest(wire).envelope;
  }

  // ---- 摘要（稳定、可比较、不依赖日志文本） --------------------------------

  function summarizeFact(fact) {
    if (DIAGNOSTIC_FACT_TYPES.includes(fact.type)) return null;
    switch (fact.type) {
      case 'runtime/fact':
        return `runtime:${fact.fact}${fact.reason ? `(${fact.reason})` : ''}`;
      case 'runtime/cancelled':
        return `runtime:cancelled(${fact.evidence})`;
      case 'runtime/tool':
        return `tool:${fact.tool === null ? 'null' : fact.tool}`;
      case 'runtime/usage': {
        const u = fact.usage || {};
        return `usage:${u.input || 0}/${u.output || 0}/${u.cacheRead || 0}/${u.cacheWrite || 0}`;
      }
      case 'runtime/subagent-start':
        // runId 只记录 proxy 的**形状**（不记录值，避免摘要成为身份旁路）。
        return `subagent-start:role=${fact.role || 'null'}:mode=${fact.mode || 'null'}`
          + `:run=${fact.runId === null ? 'null' : 'proxy'}`;
      case 'runtime/subagent-end':
        return `subagent-end:${fact.stopReason || 'null'}:${fact.outcome}:terminal=${fact.terminal}`;
      default:
        return `${fact.type}`;
    }
  }

  function stateSummary() {
    return [...recordsByEmployee.values()]
      .map((rec) => ({
        employeeId: rec.employeeId,
        presence: rec.state.presence,
        runtime: rec.state.runtime,
        activity: rec.state.activity,
        movement: rec.state.movement,
        control: rec.state.control,
        binding: rec.state.binding,
        queue: rec.state.queue,
        sync: rec.state.sync,
        lastResult: rec.state.lastResult
          ? { outcome: rec.state.lastResult.outcome, reason: rec.state.lastResult.reason }
          : null,
        lastTool: rec.state.lastTool,
        lastUsage: rec.lastUsage || null,
      }))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId));
  }

  function registrySummary() {
    const snap = registry.snapshot();
    return {
      // 只投影**形状**：员工、来源、是否已释放。raw sessionId/runId 绝不进摘要。
      bindings: snap.bindings
        .map((b) => ({ employeeId: b.employeeId, source: b.bindingSource, released: b.releasedAt !== null }))
        .sort((a, b) => `${a.employeeId}:${a.source}`.localeCompare(`${b.employeeId}:${b.source}`)),
      childSessions: snap.childSessions.length,
      classification: Object.entries(snap.classification)
        .map(([, v]) => v)
        .sort(),
    };
  }

  function counters() {
    const count = (status) => verdicts.filter((s) => s === status).length;
    return {
      accepted: count('accepted'),
      duplicate: count('duplicate'),
      buffered: count('buffered'),
      dropped: count('dropped'),
      rejected: count('rejected'),
    };
  }

  function digest() {
    return {
      kernel: { version: KERNEL_VERSION, schemaVersion: KERNEL_SCHEMA_VERSION },
      adapterVersion: adapter.describe().adapterVersion,
      derivedFields: adapter.describe().derivedFields,
      supports: adapter.capability().supports,
      terminalEvidence: adapter.capability().terminalEvidence,
      trace: emitted.flatMap((o) => o.facts.map(summarizeFact)).filter((s) => s !== null),
      finalSync: globalSync,
      epochRotations,
      states: stateSummary(),
      registry: registrySummary(),
      counters: counters(),
      diagnostics: [...new Set(diagnostics)].sort(),
    };
  }

  /** 用于"顺序等价性"比较的部分：事实轨迹 + 状态 + 账本（不含 epoch 轮换数与
   *  计数器——它们**按设计**可以随投递方式变化，由专门断言覆盖）。 */
  function comparable() {
    const d = digest();
    return { trace: d.trace, finalSync: d.finalSync, states: d.states, registry: d.registry };
  }

  return Object.freeze({
    sessionId,
    clock,
    advance,
    ingestJournal,
    ingestWire,
    ingestWindow,
    acceptSnapshotMessage,
    envelopeFor,
    cancel,
    tick: () => adapter.tick(),
    digest,
    comparable,
    adapterState: () => adapter.state(),
    adapterCapability: () => adapter.capability(),
    pendingResyncRequest: () => resyncRequests[resyncRequests.length - 1] || null,
    emitted,
    resyncRequests,
    diagnostics,
    registry,
    registrySnapshot: () => registry.snapshot(),
    stateOf: (employeeId) => (recordsByEmployee.get(employeeId) || { state: createOfficeState() }).state,
    reduceFor: (employeeId, event) => {
      const rec = recFor(employeeId);
      const effects = reduce(rec, event);
      return { state: rec.state, effects };
    },
  });
}

// ---------------------------------------------------------------------------
// journal 夹具
// ---------------------------------------------------------------------------

function journal(seq, type, data) {
  return { type, seq, time: 1000 + seq, data };
}

/** 黄金 journal：一个完整 turn —— 开工 → 两次工具 → 子代理（分类到评审）→
 *  子代理终态 → 逐轮 usage → 回合完成。覆盖 running/tool/subagent/usage/completed。 */
function goldenTurn() {
  return [
    journal(1, 'turn/start', {}),
    journal(2, 'tool/call', { name: 'bash', arguments: { command: 'ls -la' } }),
    journal(3, 'subagent/catalog', { version: 1, childId: 'child-a', childCreatedAt: 1000, mode: 'one-shot', label: 'review the diff' }),
    journal(4, 'tool/call', { name: 'grep', arguments: { pattern: 'TODO' } }),
    journal(5, 'user/message', {
      content: [{ text: 'placeholder' }],
      source: { kind: 'subagent-settled', senderSessionId: 'child-a', summary: 'The subagent finished and will do no further work.' },
    }),
    journal(6, 'assistant/message', { turn: 1, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, cacheWriteTokens: 40 } }),
    journal(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

/** 不含子代理的纯 turn：用于**顺序等价性**断言（子代理的配对 handle 有一个
 *  已记录的偏差，见 B1，单独测试）。第 3 条 tool/result 是不产生 fact 的
 *  占位记录，用来验证 baseline restart 的"被取代记录不重放"语义。 */
function plainTurn() {
  return [
    journal(1, 'turn/start', {}),
    journal(2, 'tool/call', { name: 'bash' }),
    journal(3, 'tool/result', { output: 'x', tokens: 42 }),
    journal(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

function bySeqOf(events) {
  return new Map(events.map((e) => [e.seq, e]));
}

function runSequential(events) {
  const kernel = createKernel();
  for (const event of events) kernel.ingestJournal(event);
  return kernel;
}

// ===========================================================================
// 1. canonical envelope 与派生字段
// ===========================================================================

test('kernel: canonical envelope carries derived eventId/sessionEpoch and an upstream sequence', () => {
  const kernel = createKernel();
  const verdict = kernel.ingestJournal(journal(17, 'tool/call', { name: 'bash' }));
  assert.equal(verdict.status, 'accepted');
  const env = verdict.envelope;
  assert.deepEqual(Object.keys(env), [
    'schemaVersion', 'eventId', 'sessionId', 'sessionEpoch', 'pairingHandle', 'sequence',
    'eventType', 'payload', 'sequenceSource', 'receivedAt',
  ]);
  assert.equal(env.schemaVersion, 1);
  assert.match(env.eventId, /^sha256:[0-9a-f]{64}$/);
  assert.match(env.sessionEpoch, /^adapter-\d+-[0-9a-z]+$/);
  assert.equal(env.pairingHandle, null, 'non-subagent events carry no pairing handle');
  assert.equal(env.sequenceSource, 'upstream');
  assert.equal(env.sequence, 17);
  assert.equal(env.eventType, 'tool/call');
  // 派生字段被 adapter 自我声明，不冒充 Harness 事实。
  assert.deepEqual(kernel.adapterCapability().supports, {
    cancel: true, interrupt: true, followup: true, steer: true, inject: true,
    pause: false, resume: false,
  });
  assert.equal(kernel.adapterCapability().terminalEvidence, true);
  assert.deepEqual(kernel.digest().derivedFields, ['eventId', 'sessionEpoch', 'pairingHandle']);
});

test('kernel: an event without upstream seq gets an adapter sequence and is marked as such', () => {
  const kernel = createKernel();
  const verdict = kernel.ingestJournal({ type: 'tool/call', time: 5, data: { name: 'bash' } });
  assert.equal(verdict.status, 'accepted');
  assert.equal(verdict.envelope.sequenceSource, 'adapter');
  assert.equal(verdict.envelope.sequence, 1);
  assert.equal(kernel.adapterState().adapterSequence, 1);
});

// ===========================================================================
// 2. 完整 turn：running → tool → usage → completed
// ===========================================================================

test('kernel: a golden turn drives running, tools, usage and a settled completed state', () => {
  const kernel = runSequential(goldenTurn());
  const d = kernel.digest();

  assert.deepEqual(d.trace, [
    'runtime:running',
    'tool:bash',
    'subagent-start:role=reviewer:mode=one-shot:run=proxy',
    'tool:grep',
    'subagent-end:completed:completed:terminal=true',
    'usage:1200/300/800/40',
    'runtime:completed(completed)',
  ]);
  assert.equal(d.finalSync, 'healthy');

  const orchestrator = d.states.find((s) => s.employeeId === 'orchestrator');
  assert.equal(orchestrator.runtime, 'idle');
  assert.equal(orchestrator.activity, 'roaming');
  assert.equal(orchestrator.binding, 'unbound');
  assert.equal(orchestrator.control, 'none');
  assert.equal(orchestrator.presence, 'present');
  assert.deepEqual(orchestrator.lastResult, { outcome: 'completed', reason: 'completed' });
  assert.deepEqual(orchestrator.lastUsage, { input: 1200, output: 300, cacheRead: 800, cacheWrite: 40, cost: 0.0125 });

  // 分类子代理落在评审座位，并以自己的终态释放。
  const reviewer = d.states.find((s) => s.employeeId === 'reviewer');
  assert.equal(reviewer.runtime, 'idle');
  assert.equal(reviewer.binding, 'unbound');
  assert.equal(d.registry.childSessions, 1);
  assert.ok(d.registry.bindings.some((b) => b.employeeId === 'reviewer' && b.released === true));
  assert.ok(d.registry.bindings.some((b) => b.employeeId === 'orchestrator' && b.released === true));
});

test('kernel: a failed turn ends as failed; an unknown reason degrades to attention, never failed', () => {
  const failed = createKernel();
  failed.ingestJournal(journal(1, 'turn/start', {}));
  failed.ingestJournal(journal(2, 'turn/end', { turn: 1, reason: { kind: 'error' } }));
  assert.deepEqual(failed.digest().trace, ['runtime:running', 'runtime:failed(error)']);
  assert.equal(failed.stateOf('orchestrator').lastResult.outcome, 'failed');

  const unknown = createKernel();
  unknown.ingestJournal(journal(1, 'turn/start', {}));
  unknown.ingestJournal(journal(2, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }));
  assert.deepEqual(unknown.digest().trace, ['runtime:running', 'runtime:attention(max-tokens)']);
  // 降级为 attention：不得猜成 failed，也不得释放绑定。
  assert.equal(unknown.stateOf('orchestrator').runtime, 'attention');
  assert.equal(unknown.stateOf('orchestrator').binding, 'bound');
  assert.equal(unknown.registrySnapshot().bindings[0].releasedAt, null);
});

// ===========================================================================
// 3. 子代理：分类座位 + 代理 handle + 只有终态 stopReason 释放
// ===========================================================================

test('kernel: subagent start/end pair through one redacted proxy and only terminal stopReasons release', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  kernel.ingestJournal(journal(2, 'subagent/catalog', {
    version: 1, childId: 'child-b', childCreatedAt: 1, mode: 'one-shot', label: 'implement the parser',
  }));
  const startFact = kernel.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(startFact.role, 'coder');
  assert.match(startFact.runId, /^run-sha256:[0-9a-f]{16}$/);
  assert.equal(startFact.runId, deriveRunProxy('child-b'), 'catalog 无 runId 时以 childId 作为配对 handle');
  assert.equal(kernel.stateOf('coder').runtime, 'running');

  // 非终态 stopReason 不释放（adapter 只承认终态 stopReason 集合）。
  kernel.ingestJournal(journal(3, 'subagent/end', { id: 'child-b', runId: 'child-b', stopReason: 'paused' }));
  const attentionEnd = kernel.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-end');
  assert.equal(attentionEnd.terminal, false);
  assert.equal(attentionEnd.outcome, 'attention');
  assert.equal(kernel.stateOf('coder').runtime, 'running', '非终态不得释放座位');
  assert.equal(kernel.registrySnapshot().bindings.find((b) => b.employeeId === 'coder').releasedAt, null);

  // 终态释放。
  kernel.ingestJournal(journal(4, 'subagent/end', { id: 'child-b', runId: 'child-b', stopReason: 'completed' }));
  assert.equal(kernel.stateOf('coder').runtime, 'idle');
  assert.equal(kernel.stateOf('coder').binding, 'unbound');
  assert.notEqual(kernel.registrySnapshot().bindings.find((b) => b.employeeId === 'coder').releasedAt, null);
});

test('kernel: an unclassified subagent takes the single collaborator FIFO, never a work seat', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  kernel.ingestJournal(journal(2, 'subagent/catalog', {
    version: 1, childId: 'child-c', childCreatedAt: 1, mode: 'one-shot', label: 'summarize things',
  }));
  const fact = kernel.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(fact.role, null, 'classifier fail-closed: 未命中关键词 -> collaborator');
  assert.equal(kernel.registry.getCollaboratorQueueLength(), 0, '已派发：队列里没有等待项');
  const collaboratorBinding = kernel.registrySnapshot().bindings.find((b) => b.employeeId === 'collaborator');
  assert.ok(collaboratorBinding, '协作者拿到绑定');
  assert.equal(collaboratorBinding.bindingSource, 'heuristic', '未分类子代理的默认绑定来源');
  assert.equal(collaboratorBinding.releasedAt, null);
  // 已知残留（非 UI 可见）：派发路径只 reduce queue/enqueue，没有 queue/dequeue，
  // 因此 reducer 的 queue 维度停在 'queued'。快照不投影该维度，故不影响画面。
  assert.equal(kernel.stateOf('collaborator').queue, 'queued');
  // 未分类分支不强制 running：协作者的 runtime 由该子会话自己的 follow 流驱动，
  // 本探针只建模一个根会话，故此处停在 unbound（绑定已 active）。
  assert.equal(kernel.stateOf('collaborator').runtime, 'unbound');
  assert.equal(kernel.stateOf('collaborator').binding, 'pending');
  // 三个常驻工作座位没有被占用。
  for (const seat of WORK_SEATS) {
    assert.equal(kernel.registrySnapshot().bindings.some((b) => b.employeeId === seat), false);
  }
});

// ===========================================================================
// 4. cancel ack 不是 terminal evidence
// ===========================================================================

test('kernel: a cancel acknowledgement is never terminal evidence; the real turn/end releases', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  assert.equal(kernel.stateOf('orchestrator').runtime, 'running');

  const cancelled = kernel.cancel();
  assert.equal(cancelled.ok, true);
  // ack 之后：control 进入 cancellationPending，绑定**保留**，runtime 不变。
  assert.equal(kernel.stateOf('orchestrator').control, 'cancellationPending');
  assert.equal(kernel.stateOf('orchestrator').runtime, 'running');
  assert.equal(kernel.stateOf('orchestrator').binding, 'bound');
  assert.ok(kernel.registrySnapshot().bindings.some((b) => b.releasedAt === null), 'cancel ack 不得释放绑定');
  assert.ok(kernel.emitted.flatMap((o) => o.facts).some((f) => f.type === 'control/cancel-ack'));

  // 真实终态：turn/end aborted → runtime/cancelled → 释放。
  kernel.ingestJournal(journal(2, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }));
  assert.deepEqual(kernel.digest().trace.slice(-1), ['runtime:cancelled(turn/end:aborted)']);
  assert.equal(kernel.stateOf('orchestrator').runtime, 'idle');
  assert.equal(kernel.stateOf('orchestrator').control, 'none');
  assert.equal(kernel.stateOf('orchestrator').binding, 'unbound');
  assert.equal(kernel.registrySnapshot().bindings.every((b) => b.releasedAt !== null), true);
  // P2 修复后：evidence 是**来源限定的单前缀**值，下游原样消费。
  assert.deepEqual(kernel.stateOf('orchestrator').lastResult, {
    outcome: 'cancelled', reason: 'turn/end:aborted', taskId: null,
  });
  assert.equal(JSON.stringify(kernel.digest()).includes('turn/end:turn/end'), false,
    'evidence 不得出现重复前缀');
  // 同一规则也覆盖子代理终态路径（`subagent/end:<stopReason>`）。
  const sub = createKernel();
  sub.ingestJournal(journal(1, 'turn/start', {}));
  sub.ingestJournal(journal(2, 'subagent/catalog', {
    version: 1, childId: 'child-x', childCreatedAt: 1, mode: 'one-shot', label: 'review it',
  }));
  sub.ingestJournal(journal(3, 'subagent/end', { id: 'child-x', runId: 'child-x', stopReason: 'cancelled' }));
  const subEvidence = sub.registrySnapshot().bindings.find((b) => b.employeeId === 'reviewer').lastEvidence;
  assert.equal(subEvidence, 'subagent/end:cancelled', '单一来源限定前缀');
});

test('kernel: a host-side abort without a cancel request still releases the registry binding', () => {
  // 记录在案的不对称（契约 §10）：registry 释放只认终态证据；reducer 的
  // cancelled 收敛有 control 前置条件。这里没有 cancel 请求，因此 reducer 的
  // binding 停在 bound（releasing 不会被推进），而 registry 已经释放。
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  kernel.ingestJournal(journal(2, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }));
  assert.equal(kernel.registrySnapshot().bindings.every((b) => b.releasedAt !== null), true);
  assert.equal(kernel.stateOf('orchestrator').runtime, 'idle');
  assert.equal(kernel.stateOf('orchestrator').binding, 'bound', 'reducer 的 control 门是纵深防御');
});

// ===========================================================================
// 5. 顺序等价性：重复 / 乱序 / 前跳+回填 / 开窗重放
// ===========================================================================

test('kernel: duplicate delivery is idempotent (same comparable digest)', () => {
  const events = plainTurn();
  const sequential = runSequential(events);
  const duplicated = createKernel();
  for (const event of events) {
    duplicated.ingestJournal(event);
    duplicated.ingestJournal(event);        // 第二次必须是 duplicate
    duplicated.ingestJournal({ event });    // session.history 包装的同一事件也必须去重
  }
  assert.deepEqual(duplicated.comparable(), sequential.comparable());
  assert.ok(duplicated.digest().counters.duplicate >= events.length * 2);
  assert.equal(duplicated.digest().counters.accepted, sequential.digest().counters.accepted);
});

test('kernel: out-of-order delivery inside the buffer window yields the same comparable digest', () => {
  const events = plainTurn();
  const sequential = runSequential(events);
  const bySeq = bySeqOf(events);
  const shuffled = createKernel();
  // 1,2 建立水位；4 先到（前跳 -> buffer + resync），3 补上后 drain 4。
  for (const seq of [1, 2, 4, 3]) shuffled.ingestJournal(bySeq.get(seq));
  assert.deepEqual(shuffled.comparable(), sequential.comparable());
  assert.equal(shuffled.digest().finalSync, 'healthy');
  assert.equal(shuffled.adapterState().watermark, 4);
  assert.equal(shuffled.adapterState().bufferDepth, 0);
});

test('kernel: a forward gap healed by a raw-record backfill yields the same comparable digest', () => {
  const events = plainTurn();
  const sequential = runSequential(events);
  const bySeq = bySeqOf(events);
  const healed = createKernel();
  healed.ingestJournal(bySeq.get(1));
  healed.ingestJournal(bySeq.get(2));
  // 丢掉 3，先投 4 -> 前跳：buffer + resync 请求
  healed.ingestJournal(bySeq.get(4));
  assert.equal(healed.adapterState().sync, 'resyncing');
  assert.equal(healed.adapterState().bufferDepth, 1);
  const pending = healed.pendingResyncRequest();
  assert.equal(pending.type, snapshotModule.RESYNC_REQUEST_TYPE);
  assert.equal(pending.fromSequence, 3);

  // 壳回答：重新读持久日志，把缺口记录交给 continuation 路径。
  const backfill = healed.ingestWindow([bySeq.get(3)]);
  assert.equal(backfill.mode, 'continuation');
  assert.equal(healed.adapterState().sync, 'healthy');
  assert.equal(healed.adapterState().watermark, 4);
  assert.equal(healed.adapterState().bufferDepth, 0);
  assert.deepEqual(healed.comparable(), sequential.comparable());
});

test('kernel: an opening window whose floor jumps the watermark restarts from a baseline', () => {
  const events = plainTurn();
  const sequential = runSequential(events);
  const bySeq = bySeqOf(events);
  const restarted = createKernel();
  restarted.ingestJournal(bySeq.get(1));
  restarted.ingestJournal(bySeq.get(2));
  // follow 流重开：开窗从 seq 4 起（高于 watermark+1），必须走 baseline restart；
  // 已经应用过的 1..2 不得重放（否则工具/终态会被双记）。
  const window = restarted.ingestWindow([bySeq.get(4)]);
  assert.equal(window.mode, 'baseline');
  assert.equal(restarted.digest().epochRotations, 1);
  assert.equal(restarted.adapterState().sync, 'healthy');
  assert.equal(restarted.adapterState().watermark, 4);
  // 被开窗取代的 seq 3 不产生 fact（tool/result 未映射），因此事实轨迹与顺序
  // 投递一致。epoch 轮换与计数器**按设计**不同，故比较 comparable 部分。
  assert.deepEqual(restarted.comparable(), sequential.comparable());
});

test('kernel: an office:runtime-snapshot with eventsSince replays non-pairing facts identically', () => {
  // eventsSince 重放对**不携带配对 handle** 的事实是等价的（契约 §11.6）。
  const events = plainTurn();
  const sequential = runSequential(events);
  const bySeq = bySeqOf(events);
  const replayed = createKernel();
  replayed.ingestJournal(bySeq.get(1));
  replayed.ingestJournal(bySeq.get(4)); // 前跳 -> buffer + resync
  assert.equal(replayed.adapterState().sync, 'resyncing');

  const epoch = replayed.adapterState().sessionEpoch;
  const envelopes = [2, 3, 4].map((seq) => replayed.envelopeFor(bySeq.get(seq), epoch));
  const merged = replayed.acceptSnapshotMessage({ sequence: 1, facts: {}, eventsSince: envelopes });
  assert.equal(merged.ok, true);
  assert.equal(merged.replay.length, 3);
  assert.equal(merged.leftover.length, 0);
  assert.equal(replayed.adapterState().sync, 'healthy');
  assert.equal(replayed.adapterState().watermark, 4);
  assert.deepEqual(replayed.comparable(), sequential.comparable());
});

test('kernel: snapshot facts are surfaced as canonical runtime facts, not fabricated envelopes', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  kernel.ingestJournal(journal(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
  const merged = kernel.acceptSnapshotMessage({ sequence: 2, facts: { runtime: 'running', unknownKey: 'x' }, eventsSince: [] });
  assert.equal(merged.ok, true);
  // facts 走 {envelope:null} 通道：不编造 eventId/sequence/eventType。
  const factOutputs = kernel.emitted.filter((o) => o.envelope === null);
  assert.ok(factOutputs.length > 0);
  assert.ok(factOutputs.some((o) => o.facts.some((f) => f.type === 'runtime/fact' && f.fact === 'running')));
  assert.deepEqual(kernel.digest().diagnostics, ['SNAPSHOT_FACTS_UNSUPPORTED_KEY']);
});

// ===========================================================================
// 6. P0：子代理配对在 live / buffer 补发 / canonical 重放三条路径上一致
// ===========================================================================

/** 子代理 journal：开工 → catalog（分类到评审）→ settlement（终态）→ 回合结束。 */
function subagentTurn() {
  return [
    journal(1, 'turn/start', {}),
    journal(2, 'subagent/catalog', {
      version: 1, childId: 'child-e', childCreatedAt: 1, mode: 'one-shot', label: 'review the patch',
    }),
    journal(3, 'user/message', {
      content: [{ text: 'placeholder' }],
      source: { kind: 'subagent-settled', senderSessionId: 'child-e', summary: 'The subagent finished and will do no further work.' },
    }),
    journal(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
}

test('P0-A: a buffered subagent end pairs with the live start after drain and releases the seat', () => {
  // 前跳断档：end 先到并被 buffer 吸收，start 后到并立即应用，drain 时重放 end。
  // 修复前这里以 RUN_ID_MISMATCH 失败关闭、座位卡在 running/bound。
  const events = subagentTurn();
  const bySeq = bySeqOf(events);
  const live = runSequential(events);
  const buffered = createKernel();
  buffered.ingestJournal(bySeq.get(1));
  buffered.ingestJournal(bySeq.get(3)); // 前跳 -> 缓冲（catalog 还没到）
  buffered.ingestJournal(bySeq.get(2)); // 补上 -> drain 重放 seq 3
  buffered.ingestJournal(bySeq.get(4));
  assert.equal(buffered.adapterState().watermark, 4);
  assert.equal(buffered.adapterState().bufferDepth, 0);
  // 座位正常释放，且没有 fail-closed 诊断。
  assert.equal(buffered.stateOf('reviewer').runtime, 'idle');
  assert.equal(buffered.registrySnapshot().bindings.find((b) => b.employeeId === 'reviewer').releasedAt !== null, true);
  assert.deepEqual(buffered.digest().diagnostics, []);
  // 与顺序 live 投递完全一致。
  assert.deepEqual(buffered.comparable(), live.comparable());
});

test('P0-B: a live start + a canonical eventsSince end replay pairs and releases the seat', () => {
  // 场景：start 走 live（有 raw child id，可登记子会话），end 只以 canonical
  // envelope 形式到达。配对 handle 随 envelope 传递 + registry 的 handle→子会话
  // 反查，使这条路径也能正常释放 —— 修复前这里会因占位符 proxy 而卡住座位。
  const events = subagentTurn();
  const bySeq = bySeqOf(events);

  // 生产者：拿到 seq 3（settlement → subagent/end）与 seq 4 的 canonical envelope。
  const producer = createKernel();
  const endEnvelope = producer.ingestJournal(bySeq.get(3)).envelope;
  const turnEndEnvelope = producer.ingestJournal(bySeq.get(4)).envelope;

  const consumer = createKernel();
  consumer.ingestJournal(bySeq.get(1)); // live：开工
  consumer.ingestJournal(bySeq.get(2)); // live：catalog -> 评审座位 running
  const liveStart = consumer.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(consumer.stateOf('reviewer').runtime, 'running');
  assert.match(liveStart.runId, /^run-sha256:[0-9a-f]{16}$/);

  consumer.ingestJournal(bySeq.get(4)); // 前跳：seq 3 缺失 -> buffer + resync
  assert.equal(consumer.adapterState().sync, 'resyncing');
  const merged = consumer.acceptSnapshotMessage({
    sequence: 2,
    facts: {},
    eventsSince: [endEnvelope, turnEndEnvelope],
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.leftover.length, 0);
  const replayedEnd = consumer.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-end');
  assert.equal(replayedEnd.runId, liveStart.runId, '重放的 end 与 live start 配对');
  assert.equal(replayedEnd.terminal, true);
  // 座位按真实终态释放，且没有 fail-closed 诊断。
  assert.equal(consumer.stateOf('reviewer').runtime, 'idle');
  assert.equal(consumer.registrySnapshot().bindings.find((b) => b.employeeId === 'reviewer').releasedAt !== null, true);
  assert.deepEqual(consumer.digest().diagnostics, []);
  assert.deepEqual(consumer.comparable(), runSequential(events).comparable());
});

test('P0-C: a canonical-only replay cannot invent a child identity — it fails closed, observably', () => {
  // 场景：start 与 end 都只以 canonical envelope 到达（例如 adapter 重启后只拿到
  // eventsSince）。start 没有 raw child id 可登记子会话，end 的 handle 在 registry
  // 里也没有对应项 —— 必须 fail closed：不猜子会话、不释放任何 binding，但**留下
  // 一条稳定诊断**（fail-closed 不等于静默）。
  const events = subagentTurn();
  const bySeq = bySeqOf(events);
  const producer = createKernel();
  const envelopes = new Map();
  for (const event of events) {
    const verdict = producer.ingestJournal(event);
    if (verdict && verdict.envelope) envelopes.set(event.seq, verdict.envelope);
  }

  const consumer = createKernel();
  consumer.ingestJournal(bySeq.get(1));
  consumer.ingestJournal(bySeq.get(4));
  const merged = consumer.acceptSnapshotMessage({
    sequence: 1,
    facts: {},
    eventsSince: [envelopes.get(2), envelopes.get(3), envelopes.get(4)],
  });
  assert.equal(merged.ok, true);
  // adapter 层照常产出 fact（并正确配对），但模块层无法解析身份 -> 不落账。
  const facts = consumer.emitted.flatMap((o) => o.facts);
  assert.equal(facts.find((f) => f.type === 'runtime/subagent-start').runId,
    facts.find((f) => f.type === 'runtime/subagent-end').runId, 'adapter 层配对正确');
  assert.equal(consumer.registrySnapshot().childSessions.length, 0, '没有登记任何子会话');
  assert.equal(consumer.registrySnapshot().bindings.some((b) => b.employeeId === 'reviewer'), false,
    '没有为无法解析的身份创建座位绑定');
  assert.equal(consumer.adapterState().activeRuns.length, 0, 'start/end 都在重放里 -> open-run 已闭合');
  assert.deepEqual(consumer.digest().diagnostics, ['SUBAGENT_IDENTITY_UNRESOLVED'], 'fail-closed 但不静默');
  // 摘要里不出现任何伪造的 proxy 身份。
  assert.equal(JSON.stringify(consumer.registrySnapshot()).includes('run-sha256:'), false);
});

test('P0-C: a replayed end whose handle resolves nothing never releases an unrelated binding', () => {
  // 更强的 fail-closed：座位上已经有**另一个**子代理的活跃绑定，此时来一条配对
  // handle 无法解析的 end —— 绝不能按"当前座位"把它关掉。
  const events = subagentTurn();
  const bySeq = bySeqOf(events);
  const consumer = createKernel();
  consumer.ingestJournal(bySeq.get(1));
  consumer.ingestJournal(bySeq.get(2)); // 评审座位被 child-e 占用
  const otherBindingBefore = consumer.registrySnapshot().bindings.find((b) => b.employeeId === 'reviewer');
  assert.equal(otherBindingBefore.releasedAt, null);

  // 一条 handle 指向未知运行的 end（伪造/外来 envelope）。envelope 必须来自
  // 真实的生产路径（wiring 把 settlement 翻译成 subagent/end），再替换 handle。
  const producer = createKernel();
  const genuineEnd = producer.ingestJournal(bySeq.get(3)).envelope;
  const foreignEnd = Object.freeze({
    ...genuineEnd,
    pairingHandle: deriveRunProxy('run-some-other-run'),
  });
  assert.equal(genuineEnd.eventType, 'subagent/end');
  consumer.ingestJournal(bySeq.get(4));
  const merged = consumer.acceptSnapshotMessage({ sequence: 2, facts: {}, eventsSince: [foreignEnd] });
  assert.equal(merged.ok, true);
  const after = consumer.registrySnapshot().bindings.find((b) => b.employeeId === 'reviewer');
  assert.equal(after.releasedAt, null, '不得按当前座位强行关闭无关绑定');
  assert.equal(consumer.stateOf('reviewer').runtime, 'running', '座位状态不受影响');
  assert.deepEqual(consumer.digest().diagnostics, ['SUBAGENT_IDENTITY_UNRESOLVED']);
});

test('P0-D: the full golden turn (subagents included) is order-equivalent on every raw-data path', () => {
  const events = goldenTurn();
  const sequential = runSequential(events);
  const bySeq = bySeqOf(events);

  // 重复投递（含 session.history 包装）
  const duplicated = createKernel();
  for (const event of events) {
    duplicated.ingestJournal(event);
    duplicated.ingestJournal(event);
    duplicated.ingestJournal({ event });
  }
  assert.deepEqual(duplicated.comparable(), sequential.comparable(), 'duplicates');

  // buffer 窗口内乱序
  const shuffled = createKernel();
  for (const seq of [1, 2, 4, 5, 3, 6, 7]) shuffled.ingestJournal(bySeq.get(seq));
  assert.deepEqual(shuffled.comparable(), sequential.comparable(), 'out-of-order');

  // 前跳 + 原始记录回填（continuation）：这是生产里真正走的 resync 回放路径。
  const healed = createKernel();
  healed.ingestJournal(bySeq.get(1));
  healed.ingestJournal(bySeq.get(2));
  healed.ingestJournal(bySeq.get(6));
  healed.ingestJournal(bySeq.get(7));
  assert.equal(healed.adapterState().sync, 'resyncing');
  healed.ingestWindow([bySeq.get(3), bySeq.get(4), bySeq.get(5)]);
  assert.equal(healed.adapterState().sync, 'healthy');
  assert.deepEqual(healed.comparable(), sequential.comparable(), 'forward gap + raw backfill');
  assert.deepEqual(healed.digest().diagnostics, [], '回填路径不留 fail-closed 诊断');
});

test('P0-E: the raw runId never reaches the envelope, facts, diagnostics, state or digest', () => {
  const RAW_RUN_ID = 'run-RAW-P0-FIXTURE-9';
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  const verdict = kernel.ingestJournal(journal(2, 'subagent/start', {
    runId: RAW_RUN_ID, id: 'child-raw', provider: 'deepseek', mode: 'one-shot', role: 'coder',
  }));
  kernel.ingestJournal(journal(3, 'subagent/end', { runId: RAW_RUN_ID, id: 'child-raw', stopReason: 'completed' }));

  // envelope：只有 proxy 形状的 handle。
  assert.match(verdict.envelope.pairingHandle, /^run-sha256:[0-9a-f]{16}$/);
  assert.equal(verdict.envelope.pairingHandle, deriveRunProxy(RAW_RUN_ID));
  for (const blob of [
    JSON.stringify(kernel.emitted),
    JSON.stringify(kernel.digest()),
    JSON.stringify(kernel.adapterState()),
    JSON.stringify(kernel.registrySnapshot()),
  ]) {
    assert.equal(blob.includes(RAW_RUN_ID), false, 'raw runId must never appear downstream');
  }
  // 快照层（registry）只携带 proxy。
  const child = kernel.registrySnapshot().childSessions[0];
  assert.equal(child.runId, deriveRunProxy(RAW_RUN_ID));
});

// ===========================================================================
// 7. 隐私：raw prompt / 路径 / token / secret / 原始 runId 不进入任何输出
// ===========================================================================

const SENTINELS = Object.freeze([
  'FIXTURE-PROMPT-tell-me-everything',
  '/Users/someone/secret-project',
  'sk-FIXTURESECRET0123456789',
  'run-RAW-FIXTURE-RUNID-1',
  'sess-RAW-FIXTURE-SESSION-1',
]);

test('kernel: raw prompt, path, secret, token count and raw runId never reach payload/facts/diagnostics', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  // tool/call 的参数被翻译层丢弃（只有工具名是事实）——这条断言的是翻译层。
  kernel.ingestJournal(journal(2, 'tool/call', {
    name: 'bash',
    arguments: { command: `cat ${SENTINELS[1]}/notes.md`, apiKey: SENTINELS[2] },
    tokens: 987654,
    prompt: SENTINELS[0],
  }));
  // 未被翻译层拥有的类型原样进入 adapter：由脱敏器负责。
  kernel.ingestJournal(journal(3, 'tool/result', {
    prompt: SENTINELS[0],
    cwd: SENTINELS[1],
    apiKey: SENTINELS[2],
    tokens: 987654,
    arguments: { command: `cat ${SENTINELS[1]}/notes.md`, apiKey: SENTINELS[2] },
  }));
  kernel.ingestJournal(journal(4, 'user/message', { content: [{ text: SENTINELS[0] }] }));
  kernel.ingestJournal(journal(5, 'subagent/start', {
    runId: SENTINELS[3], id: SENTINELS[4], provider: 'deepseek', mode: 'one-shot',
  }));
  kernel.ingestJournal(journal(6, 'subagent/end', {
    runId: SENTINELS[3], id: SENTINELS[4], stopReason: 'completed',
  }));
  kernel.ingestJournal(journal(7, 'assistant/message', {
    turn: 1, usage: { inputTokens: 1, outputTokens: 1 }, text: SENTINELS[0],
  }));
  kernel.ingestJournal(journal(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));

  // 1) adapter 输出的全部内容（canonical payload / facts / diagnostics）不含任何哨兵。
  const adapterBlob = JSON.stringify(kernel.emitted);
  for (const sentinel of SENTINELS) {
    assert.equal(adapterBlob.includes(sentinel), false, `adapter output leaked: ${sentinel}`);
  }
  // 2) 原始 runId 不在 facts 里；只有 proxy 形状。
  const startFact = kernel.emitted.flatMap((o) => o.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.match(startFact.runId, /^run-sha256:[0-9a-f]{16}$/);
  assert.equal(startFact.runId, deriveRunProxy(SENTINELS[3]));
  // 3) 稳定摘要也不含哨兵（摘要不能成为旁路）。
  const digestBlob = JSON.stringify(kernel.digest());
  for (const sentinel of SENTINELS) {
    assert.equal(digestBlob.includes(sentinel), false, `digest leaked: ${sentinel}`);
  }
  // 4) adapter 内部状态（去重账本/水位/activeRuns）不含原始 id。
  const stateBlob = JSON.stringify(kernel.adapterState());
  for (const sentinel of SENTINELS) {
    assert.equal(stateBlob.includes(sentinel), false, `adapter state leaked: ${sentinel}`);
  }
  // 5) 翻译层只放行工具名；参数原文根本不进 payload。
  const toolEnv = kernel.emitted.find((o) => o.envelope && o.envelope.eventType === 'tool/call').envelope;
  assert.deepEqual(toolEnv.payload, { tool: 'bash' });
  // 6) 未经翻译层的事件被脱敏：文本/路径/密钥/token 计数都变占位符。
  const resultEnv = kernel.emitted.find((o) => o.envelope && o.envelope.eventType === 'tool/result').envelope;
  assert.equal(resultEnv.payload.prompt, '[REDACTED:text]');
  assert.equal(resultEnv.payload.cwd, '[REDACTED:path]');
  assert.equal(resultEnv.payload.apiKey, '[REDACTED:secret]');
  assert.equal(resultEnv.payload.tokens, '[REDACTED:token-count]');
  assert.equal(resultEnv.payload.arguments.command, '[REDACTED:path]');
  assert.equal(resultEnv.payload.arguments.apiKey, '[REDACTED:secret]');
  // 7) 诊断码是稳定枚举，不回声任何值。
  for (const code of kernel.digest().diagnostics) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `diagnostic code must be a stable enum, got ${code}`);
  }
});

test('kernel: a non-serializable payload is rejected without emitting anything', () => {
  const kernel = createKernel();
  const cyclic = { name: 'bash' };
  cyclic.self = cyclic;
  const rejected = kernel.ingestJournal(journal(1, 'tool/result', cyclic));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'PAYLOAD_NOT_SERIALIZABLE');
  assert.equal(kernel.emitted.length, 0);
  assert.deepEqual(kernel.digest().counters, {
    accepted: 0, duplicate: 0, buffered: 0, dropped: 0, rejected: 1,
  });
});

test('kernel: an oversized payload is rejected at the 64 KiB boundary', () => {
  const kernel = createKernel();
  const oversized = { name: 'bash', blob: 'x'.repeat(70 * 1024) };
  const rejected = kernel.ingestJournal(journal(1, 'tool/result', oversized));
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(kernel.emitted.length, 0);
});

// ===========================================================================
// 8. 本地行为 / 动画 / 移动 / 用户控制不能伪造 runtime 事实
// ===========================================================================

test('kernel: local activity, animation, movement and user control cannot fabricate runtime facts', () => {
  const kernel = createKernel();
  const read = () => kernel.stateOf('coder');

  // 1) 本地行为只能写四个本地活动；'working' 不是本地活动。
  const working = kernel.reduceFor('coder', { type: 'local/activity', activity: 'working' });
  assert.equal(working.state.runtime, 'unbound');
  assert.deepEqual(working.effects, [{ type: 'rejected', code: 'LOCAL_ACTIVITY_UNSUPPORTED', activity: 'working' }]);
  const roaming = kernel.reduceFor('coder', { type: 'local/activity', activity: 'roaming' });
  assert.equal(roaming.state.activity, 'roaming');
  assert.equal(roaming.state.runtime, 'unbound', '本地行为永远不产生 runtime 事实');

  // 2) 动画事件不是 reducer 状态。
  const animation = kernel.reduceFor('coder', { type: 'animation/select', resource: 'walk-left-01' });
  assert.deepEqual(animation.effects, [{ type: 'animation-not-reducer-state', resource: 'walk-left-01' }]);
  assert.equal(animation.state.runtime, 'unbound');
  assert.equal(animation.state.activity, 'roaming');

  // 3) 移动事件只能写 movement。
  const movement = kernel.reduceFor('coder', { type: 'movement/status', movement: 'moving' });
  assert.equal(movement.state.movement, 'moving');
  assert.equal(movement.state.runtime, 'unbound');

  // 4) 用户控制不能创建 runtime 事实。
  const dispatch = kernel.reduceFor('coder', { type: 'control/dispatch' });
  assert.equal(dispatch.state.control, 'dispatchPending');
  assert.equal(dispatch.state.binding, 'pending');
  assert.equal(dispatch.state.runtime, 'unbound', 'dispatch 只是意图，不是运行事实');
  assert.equal(kernel.reduceFor('coder', { type: 'control/cancel' }).state.runtime, 'unbound');

  // 5) pause/resume 没有词表：硬拒。
  for (const type of ['control/pause', 'control/resume']) {
    const verdict = kernel.reduceFor('coder', { type });
    assert.equal(verdict.state.runtime, 'unbound');
    assert.equal(verdict.effects[0].code, 'CONTROL_UNSUPPORTED');
  }

  // 6) presence 只有 present；offline 不存在。
  assert.equal(kernel.reduceFor('coder', { type: 'presence/set', presence: 'offline' }).effects[0].code,
    'PRESENCE_OFFLINE_UNSUPPORTED');
  assert.equal(read().presence, 'present');

  // 7) 任务态存在时本地行为被拒；runtime 不是 running 时 tool 事实被拒。
  const busy = createKernel();
  busy.ingestJournal(journal(1, 'turn/start', {}));
  assert.equal(busy.stateOf('orchestrator').runtime, 'running');
  assert.equal(busy.reduceFor('orchestrator', { type: 'local/activity', activity: 'roaming' }).effects[0].code,
    'runtime-priority');
  assert.equal(busy.reduceFor('researcher', { type: 'runtime/tool', tool: 'bash' }).effects[0].code,
    'TOOL_FACT_WITHOUT_RUNNING');

  // 8) sleeping 是本地活动（不是 offline），但有未完成绑定或 sync 异常时进不去。
  const sleepy = createKernel();
  assert.equal(sleepy.reduceFor('coder', { type: 'local/activity', activity: 'sleeping' }).effects[0].code,
    undefined, '无绑定且 sync healthy 时 sleeping 是允许的本地活动');
  assert.equal(sleepy.stateOf('coder').activity, 'sleeping');
  assert.equal(sleepy.stateOf('coder').presence, 'present', 'sleeping 绝不是 offline');
  // 有未完成绑定 -> SLEEP_BLOCKED_BINDING
  sleepy.reduceFor('coder', { type: 'local/activity', activity: 'roaming' });
  sleepy.reduceFor('coder', { type: 'control/dispatch' }); // binding -> pending
  assert.equal(sleepy.reduceFor('coder', { type: 'local/activity', activity: 'sleeping' }).effects[0].code,
    'SLEEP_BLOCKED_BINDING');
  // sync 异常 -> SLEEP_BLOCKED_SYNC
  const stale = createKernel();
  stale.reduceFor('coder', { type: 'sync/status', sync: 'stale' });
  assert.equal(stale.reduceFor('coder', { type: 'local/activity', activity: 'sleeping' }).effects[0].code,
    'SLEEP_BLOCKED_SYNC');
});

test('kernel: sync degradation only changes sync and never ends local behavior or the binding', () => {
  const kernel = createKernel();
  kernel.ingestJournal(journal(1, 'turn/start', {}));
  kernel.ingestJournal(journal(2, 'tool/call', { name: 'bash' }));
  // 制造前跳 -> resyncing
  kernel.ingestJournal(journal(9, 'tool/call', { name: 'grep' }));
  assert.equal(kernel.digest().finalSync, 'resyncing');
  const st = kernel.stateOf('orchestrator');
  assert.equal(st.sync, 'resyncing');
  assert.equal(st.runtime, 'running', 'sync 异常不得结束已绑定任务');
  assert.equal(st.activity, 'working');
  assert.equal(st.binding, 'bound');
  // 重试预算耗尽 -> stale，同样只改 sync。
  for (let i = 0; i < 5; i += 1) { kernel.advance(5000); kernel.tick(); }
  assert.equal(kernel.adapterState().sync, 'stale');
  assert.equal(kernel.stateOf('orchestrator').runtime, 'running');
  assert.equal(kernel.stateOf('orchestrator').binding, 'bound');
  assert.equal(kernel.registrySnapshot().bindings.every((b) => b.releasedAt === null), true);
  assert.equal(kernel.digest().finalSync, 'stale');
});

// ===========================================================================
// 9. 摘要稳定性
// ===========================================================================

test('kernel: the digest is deterministic, JSON-round-trippable and independent of wall clock', () => {
  const a = runSequential(goldenTurn());
  const b = runSequential(goldenTurn());
  assert.deepEqual(a.digest(), b.digest(), '同一输入必须产生逐字相同的摘要');
  assert.deepEqual(JSON.parse(JSON.stringify(a.digest())), a.digest(), '摘要必须可 JSON 往返');
  assert.deepEqual(Object.keys(a.digest()), [
    'kernel', 'adapterVersion', 'derivedFields', 'supports', 'terminalEvidence',
    'trace', 'finalSync', 'epochRotations', 'states', 'registry', 'counters', 'diagnostics',
  ]);
  // 摘要里没有墙钟时间戳（时间事实只来自注入的 fake clock）。
  const blob = JSON.stringify(a.digest());
  assert.equal(/\d{4}-\d{2}-\d{2}T/.test(blob), false, '摘要不得包含墙钟 ISO 时间戳');
});

test('kernel: a different fake-clock start does not change the digest', () => {
  const events = goldenTurn();
  const early = createKernel({ startMs: T0 });
  const late = createKernel({ startMs: T0 + 86_400_000 });
  for (const event of events) { early.ingestJournal(event); late.ingestJournal(event); }
  assert.deepEqual(early.digest(), late.digest(), '逻辑结果不得依赖墙钟起点');
});

test('kernel: the settlement template table is the only source of subagent terminal reasons', () => {
  assert.equal(settlementStopReason('The subagent finished and will do no further work.'), 'completed');
  assert.equal(settlementStopReason('It ran out of room before it finished.'), 'failed');
  assert.equal(settlementStopReason('It was stopped before it finished.'), 'cancelled');
  assert.equal(settlementStopReason('something entirely unknown'), null, '未识别的模板绝不猜终态');
  assert.equal(settlementStopReason(''), null);
  assert.equal(settlementStopReason(undefined), null);
});

test('kernel: the probe never loads electron, DOM or Pixi (headless by construction)', () => {
  // 本文件从加载到运行都不 require electron/pixi：证明内核可无 UI 驱动。
  for (const spec of ['electron', 'pixi.js']) {
    assert.equal(Boolean(require.cache[require.resolve(spec)]), false, `${spec} must not be loaded`);
  }
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
});
