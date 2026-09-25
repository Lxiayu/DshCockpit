'use strict';

// src/office/runtime/runtime-adapter.js — Task 6 / SPEC-05.
//
// Harness Office State Adapter: converts Harness raw SessionEvents
// `{ type, seq, time, data }` (including the Task-1 observed session.history
// wrap `{ event: { type, seq, time, data } }`) into versioned, deduplicated,
// replayable Office canonical envelopes with sequence watermarks, forward-gap
// buffering, DshCockpit-internal resync and capability gating.
//
// Pure CommonJS: no Electron/Pixi/DOM/fs/network/Harness import. Every time
// value comes from the injected fake clock; the adapter never uses
// Date.now()/setTimeout as business facts. The renderer never subscribes to
// Harness directly: it consumes this adapter's output only.
//
// Adapter boundaries (SPEC-05 / research evidence):
// - eventId and sessionEpoch are ADAPTER-DERIVED (never Harness facts) and
//   marked as such: epoch prefix "adapter-", sequenceSource "adapter" for
//   adapter-sequenced events, eventId is a local SHA-256 fingerprint.
// - payload passes the shared privacy redactor BEFORE hashing/emission;
//   cyclic, oversized, non-JSON-able payloads are rejected.
// - cancel/interrupt acknowledgement is never terminal evidence; only
//   turn/end cancelled reasons or subagent/end terminal stopReasons release.
// - snapshot `facts` surface ONLY through the whitelist sanitizer in
//   runtime-snapshot.js (currently a single `runtime` key with the frozen
//   runtime vocabulary); accepted snapshots emit them as
//   `{ envelope: null, facts, diagnostics }` outputs — never as fabricated
//   Harness envelopes. Unknown values/keys degrade to stable diagnostics,
//   never to guessed state, and never invalidate an otherwise valid snapshot.
// - sync=stale/resyncing only changes sync: it never fabricates offline,
//   never ends local behavior, never guesses runtime/activity/binding/
//   terminal state.
// - pause/resume are unproven (forced false); Office urgent preempt is a
//   queue-controller composition, never a native Harness operation.
// - subagent runId is an internal pairing handle ONLY: it never reaches
//   downstream facts as its raw value. A stable redacted proxy
//   `run-sha256:<16 hex>` (SHA-256 over the raw runId) is used as the
//   technical identifier in `runtime/subagent-start|end` facts and in the
//   activeRuns open-run set; start/end of the same Harness run share the
//   proxy. Non-identifier-looking runIds (whitespace, proven secrets,
//   >255 chars) fail closed to `null`, and a `null` proxy never tracks or
//   closes a run.

const crypto = require('node:crypto');

const { createPrivacyRedactor } = require('./privacy-redactor.js');
const snapshotModule = require('./runtime-snapshot.js');

const ADAPTER_VERSION = 'task6-runtime-adapter-1';
const EPOCH_PREFIX = 'adapter-';
const EVENT_ID_PREFIX = 'sha256:';

const DEDUPE_CAPACITY = 4096;
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_EVENTS = 64;
const BUFFER_TTL_MS = 2 * 1000; // 2 seconds
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Research-report proven Harness Agent controls. pause/resume are forced
// false (unproven). 'preempt' is never a native Harness operation.
const PROVEN_CONTROLS = Object.freeze(['cancel', 'interrupt', 'followup', 'steer', 'inject']);
const UNPROVEN_CONTROLS = Object.freeze(['pause', 'resume']);

// The only seats a classified subagent may take: the three resident WORK seats.
// `orchestrator` is reserved for root sessions and `collaborator` is the
// fail-closed default, so neither is ever assigned through a `role` field.
const CLASSIFIED_SEAT_WHITELIST = Object.freeze(new Set(['researcher', 'coder', 'reviewer']));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function coarse(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// Deterministic canonical JSON (sorted keys, no whitespace). Returns null for
// cyclic, BigInt/function/undefined, non-finite number or class instances.
function canonicalJson(value) {
  const seen = new Set();
  const visit = (node) => {
    if (node === null) return 'null';
    const type = typeof node;
    if (type === 'boolean') return node ? 'true' : 'false';
    if (type === 'number') return Number.isFinite(node) ? String(node) : null;
    if (type === 'string') return JSON.stringify(node);
    if (type !== 'object') return null; // undefined/function/symbol/bigint
    if (Array.isArray(node)) {
      if (seen.has(node)) return null;
      seen.add(node);
      let out = '[';
      for (let i = 0; i < node.length; i += 1) {
        const part = visit(node[i]);
        if (part === null) return null;
        out += (i ? ',' : '') + part;
      }
      seen.delete(node);
      return `${out}]`;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return null; // class instances etc.
    if (seen.has(node)) return null;
    seen.add(node);
    const keys = Object.keys(node).sort();
    let out = '{';
    let first = true;
    for (const key of keys) {
      const part = visit(node[key]);
      if (part === null) return null;
      out += `${first ? '' : ','}${JSON.stringify(key)}:${part}`;
      first = false;
    }
    seen.delete(node);
    return `${out}}`;
  };
  return visit(value);
}

function createRuntimeAdapter(options = {}) {
  const sessionId = coarse(options.sessionId);
  if (!sessionId) throw new Error('createRuntimeAdapter requires a non-empty sessionId');
  const clock = options.clock && typeof options.clock.nowMs === 'function' ? options.clock : { nowMs: () => 0 };
  const now = () => clock.nowMs();
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : () => {};
  const redactor = options.redactor || createPrivacyRedactor({ mode: 'redacted' });
  const runtimeVersion = typeof options.runtimeVersion === 'string' ? options.runtimeVersion : null;

  const config = {
    dedupeCapacity: Number.isInteger(options.dedupeCapacity) && options.dedupeCapacity > 0
      ? options.dedupeCapacity : DEDUPE_CAPACITY,
    dedupeTtlMs: Number.isFinite(options.dedupeTtlMs) && options.dedupeTtlMs > 0
      ? options.dedupeTtlMs : DEDUPE_TTL_MS,
    bufferMaxEvents: Number.isInteger(options.bufferMaxEvents) && options.bufferMaxEvents > 0
      ? options.bufferMaxEvents : BUFFER_MAX_EVENTS,
    bufferTtlMs: Number.isFinite(options.bufferTtlMs) && options.bufferTtlMs > 0
      ? options.bufferTtlMs : BUFFER_TTL_MS,
    maxPayloadBytes: Number.isInteger(options.maxPayloadBytes) && options.maxPayloadBytes > 0
      ? options.maxPayloadBytes : MAX_PAYLOAD_BYTES,
  };

  const capabilityOverrides = isPlainObject(options.capabilities) ? options.capabilities : {};
  function capabilityFor(name) {
    // Only probe-proven controls may be true. pause/resume and unknown names
    // are always false; overrides may only downgrade proven controls.
    if (PROVEN_CONTROLS.includes(name)) {
      return Object.prototype.hasOwnProperty.call(capabilityOverrides, name)
        ? capabilityOverrides[name] === true : true;
    }
    return false;
  }

  // -- Live state --------------------------------------------------------------
  let watermark = 0;
  let adapterCounter = 0;
  let sync = 'healthy';
  let buffer = new Map(); // sequence -> envelope
  let bufferSinceMs = null; // fake-clock instant of the first gap
  let resync = null; // { attempts, lastAttemptAtMs }
  const activeRuns = new Set(); // open subagent runIds (no terminal end yet)

  // Event-ID LRU: insertion-ordered Map; a hit refreshes recency (delete+set)
  // but NOT the creation time, so the 10-minute TTL is measured from the
  // first sighting, not the last hit.
  const dedupe = new Map();

  function deriveEpoch(counterValue, atMs) {
    if (counterValue === 0 && coarse(options.epoch)) return options.epoch;
    return `${EPOCH_PREFIX}${counterValue}-${atMs.toString(36)}`;
  }

  let epochCounter = 0;
  let sessionEpoch = deriveEpoch(0, now());
  const mergeState = snapshotModule.createSnapshotMergeState({ watermark: 0, sessionEpoch, clock });

  // -- Dedupe helpers ------------------------------------------------------------

  function dedupeLookup(eventId, atMs) {
    const entry = dedupe.get(eventId);
    if (!entry) return false;
    if (atMs - entry.createdAtMs >= config.dedupeTtlMs) {
      dedupe.delete(eventId);
      return false;
    }
    dedupe.delete(eventId);
    dedupe.set(eventId, entry); // LRU recency bump
    return true;
  }

  function dedupeInsert(eventId, atMs) {
    dedupe.set(eventId, { createdAtMs: atMs });
    if (dedupe.size > config.dedupeCapacity) {
      dedupe.delete(dedupe.keys().next().value); // evict least-recently-used
    }
  }

  // -- Emission helpers ----------------------------------------------------------

  function buildOutput(envelope, rawData) {
    const { facts, diagnostics } = mapEnvelope(envelope, rawData);
    return Object.freeze({
      envelope,
      facts: Object.freeze(facts.map((fact) => Object.freeze(fact))),
      diagnostics: Object.freeze(diagnostics.map((diag) => Object.freeze(diag))),
    });
  }

  function emitFacts(facts) {
    onEvent(Object.freeze({
      envelope: null,
      facts: Object.freeze(facts.map((fact) => Object.freeze(fact))),
      diagnostics: Object.freeze([]),
    }));
  }

  function setSync(value) {
    sync = value;
    emitFacts([{ type: 'sync/status', sync: value }]);
  }

  // -- Resync cycle --------------------------------------------------------------

  function clearResync() {
    resync = null;
    mergeState.pendingRequests = [];
  }

  function sendOneResyncRequest(atMs) {
    const request = snapshotModule.createResyncRequest({
      requestId: `req-${sessionEpoch}-${resync.attempts}-${atMs.toString(36)}`,
      sessionId,
      sessionEpoch,
      fromSequence: watermark + 1,
    });
    snapshotModule.trackResyncRequest(mergeState, request);
    onMessage(request);
  }

  function enterStale() {
    buffer.clear();
    bufferSinceMs = null;
    clearResync();
    // Never guess runtime/activity/binding/terminal state; change sync only.
    setSync('stale');
  }

  // Fires every retry that is due by the fake clock (anchored, looping), then
  // enters stale once the max attempt count is exhausted.
  function pumpResync(atMs) {
    if (!resync) return;
    for (;;) {
      const deadline = resync.lastAttemptAtMs + snapshotModule.nextResyncDelayMs(resync.attempts - 1);
      if (atMs < deadline) return;
      if (resync.attempts >= snapshotModule.RESYNC_MAX_ATTEMPTS) {
        enterStale();
        return;
      }
      resync = { attempts: resync.attempts + 1, lastAttemptAtMs: deadline };
      sendOneResyncRequest(deadline);
    }
  }

  function startResync(atMs) {
    resync = { attempts: 1, lastAttemptAtMs: atMs };
    setSync('resyncing');
    sendOneResyncRequest(atMs);
  }

  // -- Event shaping -------------------------------------------------------------

  // Accepts bare {type,seq,time,data} and the session.history wrap
  // {event:{type,seq,time,data}} (one level).
  function parseRawEvent(event) {
    if (!isPlainObject(event)) return { code: 'EVENT_SHAPE_INVALID' };
    let raw = event;
    if (event.type === undefined && isPlainObject(event.event)) raw = event.event;
    if (!isPlainObject(raw)) return { code: 'EVENT_SHAPE_INVALID' };
    if (!coarse(raw.type)) return { code: 'EVENT_SHAPE_INVALID' };
    if (raw.seq !== undefined && (!Number.isInteger(raw.seq) || raw.seq < 0)) {
      return { code: 'SEQUENCE_INVALID' };
    }
    if (typeof raw.time !== 'number' || !Number.isFinite(raw.time)) return { code: 'EVENT_SHAPE_INVALID' };
    if (!isPlainObject(raw.data)) return { code: 'EVENT_SHAPE_INVALID' };
    return { raw };
  }

  function redactPayload(raw) {
    if (canonicalJson(raw.data) === null) return { code: 'PAYLOAD_NOT_SERIALIZABLE' };
    if (Buffer.byteLength(canonicalJson(raw.data), 'utf8') > config.maxPayloadBytes) {
      return { code: 'PAYLOAD_TOO_LARGE' };
    }
    // Redacted BEFORE hashing and emission, per SPEC-01/05 privacy contract.
    const redactedPayload = redactor.redactValue(raw.data);
    const canonical = canonicalJson(redactedPayload);
    if (canonical === null) return { code: 'PAYLOAD_NOT_SERIALIZABLE' };
    return { redactedPayload, canonical };
  }

  // Computes the SPEC-05 fingerprint: SHA-256 over
  // sessionEpoch + sessionId + seq-or-empty + eventType + canonicalJson(payload).
  function fingerprintEventId(raw, payloadInfo) {
    const upstreamSeq = Number.isInteger(raw.seq) ? raw.seq : null;
    const seqSlot = upstreamSeq === null ? '' : String(upstreamSeq);
    const fingerprint = sessionEpoch + sessionId + seqSlot + raw.type + payloadInfo.canonical;
    return EVENT_ID_PREFIX + crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
  }

  function buildEnvelope(raw, payloadInfo, eventId, sequence, sequenceSource, atMs) {
    return Object.freeze({
      schemaVersion: 1,
      eventId,
      sessionId,
      sessionEpoch,
      sequence,
      eventType: raw.type,
      payload: Object.freeze(isPlainObject(payloadInfo.redactedPayload)
        ? { ...payloadInfo.redactedPayload } : payloadInfo.redactedPayload),
      sequenceSource,
      receivedAt: new Date(atMs).toISOString(),
    });
  }

  // -- Runtime mapping -------------------------------------------------------------

  // Maps one canonical envelope into Office runtime facts. Runtime facts read
  // the redacted payload only, EXCEPT the subagent runId pairing handle: the
  // raw runId is consumed internally to derive a stable redacted proxy
  // (`run-sha256:<16 hex>`, SHA-256 over the raw value), which is what the
  // downstream facts and activeRuns set actually carry — the raw Harness
  // runId never leaves the adapter in a fact.
  // Only proven Harness semantics become facts; unknown reasons degrade to
  // attention with the coarse reason preserved. Never produces offline or
  // terminal guesses.
  function mapEnvelope(envelope, rawData) {
    const facts = [];
    const diagnostics = [];
    const payload = isPlainObject(envelope.payload) ? envelope.payload : {};
    const raw = isPlainObject(rawData) ? rawData : {};
    switch (envelope.eventType) {
      case 'agent/status': {
        const status = coarse(payload.status);
        if (status === 'running') {
          facts.push({ type: 'runtime/fact', fact: 'running' });
        } else if (status === 'idle') {
          if (activeRuns.size > 0) {
            diagnostics.push({ code: 'IDLE_SUPPRESSED_ACTIVE_SUBAGENTS' });
          } else {
            facts.push({ type: 'runtime/fact', fact: 'idle' });
          }
        } else {
          diagnostics.push({ code: 'AGENT_STATUS_UNKNOWN', status });
        }
        break;
      }
      case 'turn/end': {
        const reason = coarse(payload.reason);
        if (reason === 'completed') {
          facts.push({ type: 'runtime/fact', fact: 'completed', reason });
        } else if (reason === 'error' || reason === 'failed') {
          facts.push({ type: 'runtime/fact', fact: 'failed', reason });
        } else if (reason === 'aborted' || reason === 'interrupted' || reason === 'cancelled') {
          facts.push({ type: 'runtime/cancelled', evidence: `turn/end:${reason}` });
        } else if (reason === 'blocked') {
          facts.push({ type: 'runtime/fact', fact: 'attention', reason: 'blocked' });
        } else {
          // unknown or missing reason -> attention, coarse reason preserved
          facts.push({ type: 'runtime/fact', fact: 'attention', reason });
        }
        break;
      }
      case 'tool/call': {
        facts.push({ type: 'runtime/tool', tool: coarse(payload.tool) });
        break;
      }
      // P2 timeline attribution: main.js's ingestOfficeJournalEvent already
      // translated the 0.1.5 assistant/message `data.usage` (TokenUsage) into
      // the §4-shaped bucket {input, output, cacheRead, cacheWrite} + a
      // per-turn money estimate. Only non-negative integers pass here — the
      // redacted payload carries no text. A zero bucket is dropped (a turn
      // with no provider accounting simply gets no attribution).
      case 'turn/usage': {
        const usage = isPlainObject(payload.usage) ? payload.usage : {};
        const bucket = {};
        let total = 0;
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          const n = Number(usage[key]);
          bucket[key] = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
          total += bucket[key];
        }
        const cost = Number(payload.cost);
        if (total > 0) {
          facts.push({
            type: 'runtime/usage',
            usage: bucket,
            cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
          });
        }
        break;
      }
      case 'subagent/start': {
        const runId = runProxy(raw.runId);
        if (runId) activeRuns.add(runId);
        // `id` is the child session id. `role` is the candidate seat computed
        // by the shell's subagent classifier from structured metadata only and
        // whitelisted here, so an unexpected value can never invent a seat.
        // `mode` is the catalog descriptor mode ('one-shot'|'continuable').
        const role = CLASSIFIED_SEAT_WHITELIST.has(payload.role) ? payload.role : null;
        facts.push({
          type: 'runtime/subagent-start',
          runId,
          sessionId: coarse(payload.id),
          provider: coarse(payload.provider),
          role,
          mode: payload.mode === 'one-shot' || payload.mode === 'continuable' ? payload.mode : null,
        });
        break;
      }
      case 'subagent/end': {
        const runId = runProxy(raw.runId);
        const stopReason = coarse(payload.stopReason);
        if (stopReason === 'completed' || stopReason === 'error' || stopReason === 'failed') {
          if (runId) activeRuns.delete(runId);
          facts.push({
            type: 'runtime/subagent-end', runId, stopReason,
            outcome: stopReason === 'completed' ? 'completed' : 'failed',
            terminal: true,
          });
        } else if (stopReason === 'aborted' || stopReason === 'interrupted' || stopReason === 'cancelled') {
          if (runId) activeRuns.delete(runId);
          facts.push({
            type: 'runtime/subagent-end', runId, stopReason,
            outcome: 'cancelled', terminal: true,
          });
        } else {
          // unknown stop reasons are never terminal evidence
          facts.push({
            type: 'runtime/subagent-end', runId, stopReason,
            outcome: 'attention', terminal: false,
          });
        }
        break;
      }
      default:
        break; // unmapped types canonicalize without invented facts
    }
    return { facts, diagnostics };
  }

  // Derives the STABLE REDACTED PROXY used as the technical pairing handle
  // for subagent runs. The raw Harness runId never appears in downstream
  // facts, in the open-run set, or in diagnostics: the proxy is
  // `run-sha256:<16 lower hex>` = sha256(rawRunId) truncated.
  //
  // Delegated to module-level deriveRunProxy() so Task 5/parent wiring can
  // compute the exact same handle for its child-session registration.
  // Design notes (SPEC-05 + privacy boundary):
  // - Deterministic: identical raw runIds always produce the same proxy, so
  //   paired start/end (and Task 5's registered handle) stay matched.
  // - Correlation-safe: SHA-256 over a short identifier cannot be reversed
  //   into the raw value without a preimage search; Office facts carry ONLY
  //   the proxy.
  // - Fail-closed: whitespace-bearing, oversized, or proven-secret-looking
  //   ids return `null`; a `null` proxy never registers or closes a run
  //   (the run simply stays untracked rather than ingesting PII).
  function runProxy(value) {
    return deriveRunProxy(value);
  }

  // -- Buffer helpers --------------------------------------------------------------

  function drainBuffer() {
    for (;;) {
      const next = buffer.get(watermark + 1);
      if (!next) break;
      buffer.delete(next.sequence);
      watermark = next.sequence;
      onEvent(buildOutput(next, next.payload));
    }
    if (buffer.size === 0) {
      bufferSinceMs = null;
      if (sync === 'resyncing') {
        clearResync();
        setSync('healthy');
      }
    }
    mergeState.watermark = watermark;
  }

  // -- Public API --------------------------------------------------------------------

  function ingest(event) {
    const parsed = parseRawEvent(event);
    if (parsed.code) return Object.freeze({ status: 'rejected', code: parsed.code });
    const payloadInfo = redactPayload(parsed.raw);
    if (payloadInfo.code) return Object.freeze({ status: 'rejected', code: payloadInfo.code });
    const atMs = now();
    // Hash BEFORE any counter assignment so duplicated adapter-sequenced
    // events never consume counter steps.
    const eventId = fingerprintEventId(parsed.raw, payloadInfo);
    // Per-epoch event-ID LRU (4096 entries, 10-minute TTL).
    if (dedupeLookup(eventId, atMs)) {
      return Object.freeze({ status: 'duplicate', code: 'EVENT_DUPLICATE' });
    }

    if (!Number.isInteger(parsed.raw.seq)) {
      adapterCounter += 1;
      const envelope = buildEnvelope(parsed.raw, payloadInfo, eventId, adapterCounter, 'adapter', atMs);
      dedupeInsert(eventId, atMs);
      onEvent(buildOutput(envelope, parsed.raw.data));
      return Object.freeze({ status: 'accepted', envelope, diagnostics: [] });
    }

    const envelope = buildEnvelope(parsed.raw, payloadInfo, eventId, parsed.raw.seq, 'upstream', atMs);
    // Upstream sequencing: the watermark is the authority for sequence
    // duplicates with conflicting payloads (watermark beats hashes).
    if (envelope.sequence <= watermark) {
      dedupeInsert(eventId, atMs);
      return Object.freeze({ status: 'duplicate', code: 'STALE_SEQUENCE' });
    }
    dedupeInsert(eventId, atMs);
    if (watermark === 0 && buffer.size === 0 && sync === 'healthy') {
      // First trusted Harness fact: the Harness seq of the very first event
      // establishes the floor; anything older is silently redundant history.
      watermark = envelope.sequence - 1;
    }
    if (envelope.sequence === watermark + 1) {
      watermark = envelope.sequence;
      const output = buildOutput(envelope, parsed.raw.data);
      onEvent(output);
      mergeState.watermark = watermark;
      drainBuffer();
      return Object.freeze({
        status: 'accepted',
        envelope,
        diagnostics: Object.freeze(output.diagnostics),
      });
    }
    // Forward jump: expire an aged buffer, then buffer (64 events / 2 s max)
    // and run the resync cycle; never guess the missing state.
    if (bufferSinceMs !== null && atMs - bufferSinceMs >= config.bufferTtlMs) {
      buffer.clear();
      bufferSinceMs = null;
    }
    if (buffer.size >= config.bufferMaxEvents) {
      return Object.freeze({ status: 'dropped', code: 'BUFFER_FULL' });
    }
    buffer.set(envelope.sequence, envelope);
    if (bufferSinceMs === null) bufferSinceMs = atMs;
    if (sync !== 'resyncing') startResync(atMs);
    return Object.freeze({ status: 'buffered', envelope, diagnostics: [] });
  }

  function acceptSnapshot(message) {
    snapshotModule.pruneResyncRequests(mergeState);
    const pending = mergeState.pendingRequests[0] || {
      requestId: null, sessionId, sessionEpoch, fromSequence: watermark + 1,
    };
    const result = snapshotModule.mergeSnapshot(mergeState, {
      request: pending,
      snapshot: message,
      buffered: [...buffer.values()],
    });
    if (!result.ok) return result;
    // Surface sanitized snapshot facts FIRST (they describe the Office state
    // AT the snapshot sequence; eventsSince replay follows). The output is
    // the standard { envelope: null, facts, diagnostics } channel — never a
    // fabricated Harness envelope (no eventId/eventType/sequence).
    if (result.facts.length > 0 || result.factsDiagnostics.length > 0) {
      onEvent(Object.freeze({
        envelope: null,
        facts: result.facts,
        diagnostics: result.factsDiagnostics,
      }));
    }
    for (const env of result.replay) {
      onEvent(buildOutput(Object.freeze(env), env.payload));
    }
    // The snapshot sequence is the new contiguous watermark even when the
    // replay list is empty (buffered events <= snapshot.sequence are absorbed,
    // not replayed). mergeState.watermark already carries snapshot.sequence +
    // replayed prefix from mergeSnapshot.
    watermark = mergeState.watermark;
    buffer = new Map(result.leftover.map((env) => [env.sequence, env]));
    bufferSinceMs = result.leftover.length ? now() : null;
    if (result.leftover.length === 0) {
      const wasResyncing = sync === 'resyncing';
      clearResync();
      if (wasResyncing) setSync('healthy');
    }
    return result;
  }

  function rotateEpoch() {
    epochCounter += 1;
    sessionEpoch = deriveEpoch(epochCounter, now());
    mergeState.sessionEpoch = sessionEpoch;
    watermark = 0;
    mergeState.watermark = 0;
    adapterCounter = 0;
    buffer.clear();
    bufferSinceMs = null;
    dedupe.clear();
    activeRuns.clear();
    startResync(now());
    return Object.freeze({ sessionEpoch });
  }

  function tick() {
    const atMs = now();
    const diagnostics = [];
    if (bufferSinceMs !== null && atMs - bufferSinceMs >= config.bufferTtlMs) {
      buffer.clear();
      bufferSinceMs = null;
      diagnostics.push({ code: 'BUFFER_EXPIRED' });
      mergeState.watermark = watermark;
    }
    pumpResync(atMs);
    return Object.freeze({ diagnostics: Object.freeze(diagnostics.map((d) => Object.freeze(d))) });
  }

  // A cancel/interrupt acknowledgement only proves delivery. It is never a
  // release: the binding is retained until terminal evidence arrives.
  function noteCancelAcknowledged() {
    emitFacts([{ type: 'control/cancel-ack' }]);
    return Object.freeze({ ok: true, code: null });
  }

  function requestControl({ control } = {}) {
    if (!capabilityFor(control)) {
      return Object.freeze({ ok: false, code: 'CONTROL_UNSUPPORTED' });
    }
    emitFacts([{ type: 'send-control', control }]);
    return Object.freeze({ ok: true, code: null });
  }

  function capability() {
    const supports = {};
    for (const name of [...PROVEN_CONTROLS, ...UNPROVEN_CONTROLS]) {
      supports[name] = capabilityFor(name);
    }
    return Object.freeze({
      adapterVersion: ADAPTER_VERSION,
      runtimeVersion,
      supports: Object.freeze(supports),
      terminalEvidence: true,
    });
  }

  function describe() {
    return Object.freeze({
      adapterVersion: ADAPTER_VERSION,
      derivedFields: Object.freeze(['eventId', 'sessionEpoch']),
      epochPrefix: EPOCH_PREFIX,
    });
  }

  function state() {
    return Object.freeze({
      schemaVersion: 1,
      sessionId,
      sessionEpoch,
      sync,
      watermark,
      adapterSequence: adapterCounter,
      bufferDepth: buffer.size,
      dedupeSize: dedupe.size,
      activeRuns: Object.freeze([...activeRuns]),
      resync: resync ? Object.freeze({ ...resync }) : null,
    });
  }

  return Object.freeze({
    ingest,
    acceptSnapshot,
    rotateEpoch,
    tick,
    noteCancelAcknowledged,
    requestControl,
    capability,
    describe,
    state,
  });
}

// Task 6 ⇄ Task 5 runId contract — chosen plan (b), documented:
//   The adapter owns the ONLY mapping raw Harness runId -> proxy. Its
//   `runtime/subagent-start|end` facts already carry ONLY the proxy (Task 6
//   fix commit). External consumers (Task-5 registry, future Task-7 wiring)
//   handle the proxy string verbatim as an opaque technical handle; they
//   never see, register, match, or persist the raw runId.
//   `deriveRunProxy` is the controlled internal mapping interface for any
//   outside code that still holds a raw id (e.g. a wiring layer iterating
//   raw Harness history for snapshot composition). Office wiring code MUST
//   call this function — never derive a proxy by other means, and never
//   bypass it with the raw id.
//
//   Lifecycle & isolation (why plan (b) is sufficient):
//   - Determinism: sha256(raw) is epoch-agnostic, but the adapter's
//     activeRuns set clears on every epoch rotation, and each adapter emits
//     facts under its own sessionEpoch — the proxy only ever has meaning
//     within the epoch of the adapter that produced it.
//   - Collision surface: 16 lower-hex chars (64-bit). For any realistic
//     Office epoch (few hundred concurrent subagent runs), collision risk
//     is vanishingly small; plan (a)/(b) require no registry changes, which
//     keeps the Task-5 boundary untouched.
//   - Privacy: the proxy is one-way. A Registry or UI consumer holding the
//     proxy cannot recover the raw runId without brute force.
//   - Task 7: must NOT convert raw ids. It forwards fact.runId (already
//     proxied) to Task 5 verbatim. If it ever synthesizes from raw Harness
//     history, it calls deriveRunProxy() and stores only the proxy.
function deriveRunProxy(rawRunId) {
  if (typeof rawRunId !== 'string' || rawRunId === '' || rawRunId.length > 255) return null;
  if (/\s/.test(rawRunId)) return null;
  if (/^(sk-|Bearer\s|xox|gh[pousr]_)/.test(rawRunId)) return null;
  return `run-sha256:${crypto.createHash('sha256').update(rawRunId, 'utf8').digest('hex').slice(0, 16)}`;
}

module.exports = {
  createRuntimeAdapter,
  ADAPTER_VERSION,
  EPOCH_PREFIX,
  canonicalJson,
  deriveRunProxy,
  DEDUPE_CAPACITY,
  DEDUPE_TTL_MS,
  BUFFER_MAX_EVENTS,
  BUFFER_TTL_MS,
};
