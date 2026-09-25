'use strict';

// src/office/runtime/subagent-wiring.js — real durable subagent journal ->
// office module vocabulary.
//
// Pure CommonJS (no Electron/Pixi/DOM/fs/network/Harness import, no clock, no
// randomness). The shell owns the mux and calls `handleEvent` for every
// journal event; this module decides whether the event is one of the REAL
// durable subagent signals and, if so, translates it into the event the office
// module's adapter understands (`subagent/start` / `subagent/end`).
//
// Why this exists (first-hand, dsh-0.1.5-rc.2):
// - The adapter's `subagent/start|end` branches are fed by `@deepseek-ai/dsh-
//   subagent`'s PROCESS-LOCAL lifecycle events. Those names are absent from
//   `dsh-session`'s KNOWN_SESSION_EVENT_TYPES, so `session/follow` never
//   carries them: in production the branch was dead code.
// - The REAL durable parent-session signals are:
//     * `subagent/catalog`  {version, childId, childCreatedAt, mode, label?}
//       — appended once per child at creation (a `subagent`-tool child carries
//       the model-authored `description` as `label`; a workflow child carries
//       NO label).
//     * `tool-workflow/run-start|agent-start|agent-end` — the workflow tool's
//       records. `agent-start` carries {runId, seq, label, phase?, childId};
//       `agent-end` carries {runId, seq, outcome} and NO childId, so ends are
//       paired through the (runId, member seq) key recorded at start.
//     * `user/message` whose `source.kind === 'subagent-settled'` — the
//       universal settlement notice for EVERY subagent (one-shot and
//       continuable); `source.senderSessionId` is the child id.
//
// Seat selection is delegated to the pure classifier
// (`subagent-classifier.js`): bounded structured metadata only, fail-closed to
// collaborator. This module never inspects a prompt/task body.
//
// Sequencing contract: every consumed event is emitted with the ORIGINAL
// journal `seq`, so the adapter's strict per-session watermark never opens a
// gap. Events this module does not own return `false` and the shell performs
// its generic ingest (tracking-only records like run-start/run-end are handled
// for side effects AND return false so they still advance the watermark).

const { classifySubagent } = require('./subagent-classifier.js');

const DEFAULT_LEDGER_CAP = 256;

// Fixed harness settlement templates -> terminal stop reason. The notice is
// harness-generated English boilerplate (dsh-subagent `settlementSummary`);
// only these opening clauses are matched — never the child's task text.
// Anything unrecognized returns null so no terminal fact is invented.
const SETTLEMENT_TEMPLATES = Object.freeze([
  Object.freeze({ marker: 'finished and will do no further work', stopReason: 'completed' }),
  Object.freeze({ marker: 'ran out of room before it finished', stopReason: 'failed' }),
  Object.freeze({ marker: 'declined the task', stopReason: 'failed' }),
  Object.freeze({ marker: 'failed before it finished', stopReason: 'failed' }),
  Object.freeze({ marker: 'ended abnormally', stopReason: 'failed' }),
  Object.freeze({ marker: 'was stopped before it finished', stopReason: 'cancelled' }),
]);

function settlementStopReason(summary) {
  if (typeof summary !== 'string' || summary === '') return null;
  for (const { marker, stopReason } of SETTLEMENT_TEMPLATES) {
    if (summary.includes(marker)) return stopReason;
  }
  return null;
}

function coarseString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function createSubagentWiring(options = {}) {
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const classify = typeof options.classify === 'function' ? options.classify : classifySubagent;
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : DEFAULT_LEDGER_CAP;

  const workflowRuns = new Map(); // sessionId -> Set(runId)
  const agentChild = new Map(); // `${sessionId}\u0000${runId}\u0000${memberSeq}` -> childId
  const started = new Set(); // childIds already translated to a start
  const closed = new Set(); // childIds already translated to an end
  const deferredCatalogs = new Map(); // sessionId -> Map(childId -> {mode,label,seq,time})

  function ledgerInsert(set, key) {
    set.add(key);
    while (set.size > cap) set.delete(set.keys().next().value);
  }

  function runKey(sessionId, runId, memberSeq) {
    return `${sessionId}\u0000${runId}\u0000${memberSeq}`;
  }

  function liveRunCount(sessionId) {
    const runs = workflowRuns.get(sessionId);
    return runs ? runs.size : 0;
  }

  function resolveRole({ label, mode, phase }) {
    const verdict = classify({ label, mode: mode || 'one-shot', phase });
    return verdict && verdict.classified ? verdict.employeeId : null;
  }

  function emitStart(sessionId, { childId, mode, label, phase, seq, time }) {
    if (started.has(childId)) return false;
    ledgerInsert(started, childId);
    const role = resolveRole({ label, mode, phase });
    emit(sessionId, {
      type: 'subagent/start',
      seq,
      time,
      // `id` = child session handle (the binding key). `runId` falls back to
      // the child id when the journal has no run id (catalog has only childId)
      // so start/end still pair deterministically through deriveRunProxy.
      data: { id: childId, runId: childId, mode: mode || null, role },
    });
    log(`[office] subagent start (${childId.slice(0, 8)}) role=${role || 'collaborator'}`
      + ` mode=${mode || 'unknown'}`);
    return true;
  }

  function emitEnd(sessionId, { childId, stopReason, seq, time, source }) {
    if (closed.has(childId)) return false;
    ledgerInsert(closed, childId);
    emit(sessionId, {
      type: 'subagent/end',
      seq,
      time,
      data: { id: childId, runId: childId, stopReason },
    });
    log(`[office] subagent end (${childId.slice(0, 8)}) reason=${stopReason || 'unknown'} via=${source}`);
    return true;
  }

  function flushDeferred(sessionId) {
    const pending = deferredCatalogs.get(sessionId);
    if (!pending || pending.size === 0) return;
    deferredCatalogs.delete(sessionId);
    for (const [childId, info] of pending) {
      if (started.has(childId)) continue;
      log(`[office] subagent catalog flushed (${childId.slice(0, 8)}): run ended without agent-start`);
      // The deferred catalog's own seq was already ingested (generic, no facts)
      // when it arrived, so reusing it would be a stale duplicate. `seq: null`
      // makes the adapter assign an adapter sequence for this late start.
      emitStart(sessionId, { childId, mode: info.mode, label: info.label, seq: null, time: info.time });
    }
  }

  /**
   * Translate one journal event. Returns true ONLY when an office event was
   * emitted for this call (so the caller must NOT also ingest it generically —
   * the emitted event carries the journal seq and advances the watermark).
   * Returns false whenever nothing was emitted: the caller owns the generic
   * ingest, which is what keeps the adapter's per-session watermark contiguous.
   */
  function handleEvent(sessionId, event) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return false;
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    if (event.type === 'subagent/catalog') {
      const childId = coarseString(data.childId);
      if (!childId) return false;
      const mode = data.mode === 'one-shot' || data.mode === 'continuable' ? data.mode : null;
      const label = typeof data.label === 'string' ? data.label : null;
      if (liveRunCount(sessionId) > 0 && label === null) {
        // A workflow child carries no label on its catalog; its seat is decided
        // at agent-start. Hold it (bounded) and flush as unclassified at
        // run-end if nothing claims it. No office event yet -> generic ingest.
        let pending = deferredCatalogs.get(sessionId);
        if (!pending) { pending = new Map(); deferredCatalogs.set(sessionId, pending); }
        pending.set(childId, { mode, label, seq: event.seq, time: event.time });
        log(`[office] subagent catalog deferred (${childId.slice(0, 8)}): workflow run active`);
        return false;
      }
      return emitStart(sessionId, { childId, mode, label, seq: event.seq, time: event.time });
    }

    if (event.type === 'tool-workflow/run-start' || event.type === 'tool-workflow/run-end') {
      const runId = coarseString(data.runId);
      if (runId) {
        let runs = workflowRuns.get(sessionId);
        if (event.type === 'tool-workflow/run-start') {
          if (!runs) { runs = new Set(); workflowRuns.set(sessionId, runs); }
          runs.add(runId);
          log(`[office] workflow run start (${runId.slice(0, 8)}): ${runs.size} live`);
        } else if (runs) {
          runs.delete(runId);
          if (runs.size === 0) workflowRuns.delete(sessionId);
          if (liveRunCount(sessionId) === 0) flushDeferred(sessionId);
        }
      }
      return false; // tracking only; the caller ingests it (watermark)
    }

    if (event.type === 'tool-workflow/agent-start') {
      const runId = coarseString(data.runId);
      const childId = coarseString(data.childId);
      const memberSeq = Number.isInteger(data.seq) ? data.seq : null;
      if (!runId || !childId || memberSeq === null) return false;
      agentChild.set(runKey(sessionId, runId, memberSeq), childId);
      const deferred = deferredCatalogs.get(sessionId);
      if (deferred) deferred.delete(childId); // claimed by a real agent-start
      return emitStart(sessionId, {
        childId,
        mode: 'one-shot',
        label: typeof data.label === 'string' ? data.label : null,
        phase: typeof data.phase === 'string' ? data.phase : null,
        seq: event.seq,
        time: event.time,
      });
    }

    if (event.type === 'tool-workflow/agent-end') {
      const runId = coarseString(data.runId);
      const memberSeq = Number.isInteger(data.seq) ? data.seq : null;
      if (!runId || memberSeq === null) return false;
      const key = runKey(sessionId, runId, memberSeq);
      const childId = agentChild.get(key);
      agentChild.delete(key);
      if (!childId) return false;
      const outcome = data.outcome === 'completed' || data.outcome === 'failed' || data.outcome === 'cancelled'
        ? data.outcome : 'completed';
      return emitEnd(sessionId, { childId, stopReason: outcome, seq: event.seq, time: event.time, source: 'tool-workflow/agent-end' });
    }

    if (event.type === 'user/message') {
      const source = data.source && typeof data.source === 'object' ? data.source : null;
      const senderChildId = source && source.kind === 'subagent-settled' ? coarseString(source.senderSessionId) : null;
      if (!senderChildId) return false;
      const summary = typeof source.summary === 'string' ? source.summary
        : (Array.isArray(data.content) && data.content[0] && typeof data.content[0].text === 'string'
          ? data.content[0].text : '');
      const stopReason = settlementStopReason(summary);
      if (!stopReason) return false; // unrecognized template: never guess
      return emitEnd(sessionId, { childId: senderChildId, stopReason, seq: event.seq, time: event.time, source: 'subagent-settled' });
    }

    return false;
  }

  function reset() {
    workflowRuns.clear();
    agentChild.clear();
    started.clear();
    closed.clear();
    deferredCatalogs.clear();
  }

  function debugState() {
    return Object.freeze({
      liveWorkflowRuns: Object.freeze([...workflowRuns].map(([sessionId, runs]) => [sessionId, runs.size])),
      startedCount: started.size,
      closedCount: closed.size,
      deferredCount: [...deferredCatalogs.values()].reduce((sum, map) => sum + map.size, 0),
      pairedAgents: agentChild.size,
    });
  }

  return Object.freeze({
    handleEvent: Object.freeze(handleEvent),
    reset: Object.freeze(reset),
    debugState: Object.freeze(debugState),
  });
}

module.exports = { createSubagentWiring, settlementStopReason, SETTLEMENT_TEMPLATES };
