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
//   downstream facts as its raw value. The adapter derives a stable redacted
//   proxy `run-sha256:<16 hex>` (SHA-256 over the raw runId) ONCE, at first
//   ingest of the raw event, and stores it on the canonical envelope as the
//   adapter-derived `pairingHandle` field. That is what makes start/end pairing
//   survive every replay path: `runtime/subagent-start|end` facts read
//   `envelope.pairingHandle` and NEVER re-derive from the (possibly redacted)
//   rawData — so a buffered event drained later, or a canonical envelope
//   replayed through an office:runtime-snapshot `eventsSince` list, pairs
//   exactly like a live one. Non-identifier-looking runIds (whitespace, proven
//   secrets, >255 chars) fail closed to `null`, and a `null` handle never
//   tracks or closes a run (the run simply stays untracked rather than
//   ingesting PII).
//
//   Why the handle lives on the envelope and not in a buffer sidecar: a sidecar
//   only covers the events THIS adapter buffered. It cannot help when the
//   adapter restarts, or when the only thing available is a canonical envelope
//   list from another producer (the `eventsSince` contract). Putting the
//   derived handle on the envelope makes pairing a property of the canonical
//   record itself, so there is no second class of replay that still loses it.

const crypto = require('node:crypto');

const { createPrivacyRedactor } = require('./privacy-redactor.js');
const snapshotModule = require('./runtime-snapshot.js');
// P1 运行时体检：tool/call 的工具名提取与 main.js 的 live 翻译共用同一实现
// （0.1.5 `data.name` / pre-0.1.5 `data.tool` 双形状，见 mapEnvelope tool/call）。
const { toolNameOfJournalData } = require('./tool-phrases.js');

// v2: the canonical envelope gained the adapter-derived `pairingHandle` field
// (replay-safe subagent pairing). The envelope `schemaVersion` stays 1: the
// field is additive with a fail-closed default (absent/null = unpairable), so a
// v1 envelope stays valid and degrades safely instead of hard-failing.
const ADAPTER_VERSION = 'task6-runtime-adapter-2';
const EPOCH_PREFIX = 'adapter-';
const EVENT_ID_PREFIX = 'sha256:';

const DEDUPE_CAPACITY = 4096;
const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BUFFER_MAX_EVENTS = 64;
const BUFFER_TTL_MS = 2 * 1000; // 2 seconds
const MAX_PAYLOAD_BYTES = 64 * 1024;
// Bounded identity-keyed raw-handle ledger (see rawChildHandleFor). Same
// discipline as the dedupe LRU: bounded, in-memory, main-process only.
const RAW_HANDLE_CAPACITY = 512;

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

  // Identity-keyed raw child handles: `eventId -> raw child session id`, written
  // ONCE when an envelope is built from raw input (subagent lifecycle events
  // only) and read back through rawChildHandleFor(envelope).
  //
  // Why identity-keyed instead of "the raw event being ingested right now": the
  // consumer's fact-application runs synchronously inside ingest(), so a
  // buffered event drained later — or a replayed envelope — would be correlated
  // with whichever raw event happens to be in flight. Keying by the envelope's
  // own eventId makes correlation a property of the FACT'S identity, so
  // live / drained / duplicated delivery all resolve the same child, and a
  // canonical-only replay (never seen raw) resolves to null (fail-closed).
  //
  // Privacy: raw session ids stay inside this adapter (main process). They are
  // never written to a fact, an envelope, diagnostics, the snapshot or state() —
  // only the count is observable (state().rawHandleSize).
  const rawChildHandles = new Map();

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

  // Emission helpers.
  //
  // Every output carries `sessionId` (the adapter's own identity) so a consumer
  // NEVER has to ask "which raw event is in flight" — the envelope identifies the
  // producing event when there is one, and envelope-less facts (sync/status,
  // snapshot facts, control receipts) still carry a trustworthy session.
  //
  // `rawData` is the payload the fact mapper reads for REDACTION-SAFE fields
  // (tool/call's tool name, present in both the raw 0.1.5 `{name}` shape and the
  // redacted `{tool}` shape). It is deliberately NOT used for anything that only
  // exists in the raw input — the subagent pairing handle travels on the
  // envelope, and the raw child handle is looked up by event identity
  // (rawChildHandleFor), so the live path and every replay path produce
  // identical facts.
  function buildOutput(envelope, rawData) {
    const { facts, diagnostics } = mapEnvelope(envelope, rawData);
    return Object.freeze({
      envelope,
      sessionId,
      facts: Object.freeze(facts.map((fact) => Object.freeze(fact))),
      diagnostics: Object.freeze(diagnostics.map((diag) => Object.freeze(diag))),
    });
  }

  function emitFacts(facts) {
    onEvent(Object.freeze({
      envelope: null,
      sessionId,
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

  // Derives the adapter-owned pairing handle for ONE raw event, ONCE, at first
  // ingest. Only the subagent lifecycle events carry a pairable run handle; every
  // other event (and every unpairable runId) resolves to `null`, which downstream
  // treats as "no pairing" — fail-closed, never a guess.
  function pairingHandleOf(raw) {
    if (raw.type !== 'subagent/start' && raw.type !== 'subagent/end') return null;
    const data = isPlainObject(raw.data) ? raw.data : {};
    return deriveRunProxy(data.runId);
  }

  // Remembers the RAW child session id for one envelope, keyed by the envelope's
  // own eventId. Written only for subagent lifecycle events that actually carry a
  // raw child id (regardless of whether the runId was pairable — an end with no
  // runId still needs its child identity so the registry can apply its own
  // fail-closed runId verification).
  function rememberRawChildHandle(envelope, raw) {
    if (raw.type !== 'subagent/start' && raw.type !== 'subagent/end') return;
    const data = isPlainObject(raw.data) ? raw.data : {};
    if (typeof data.id !== 'string' || data.id === '') return;
    rawChildHandles.set(envelope.eventId, data.id);
    if (rawChildHandles.size > RAW_HANDLE_CAPACITY) {
      rawChildHandles.delete(rawChildHandles.keys().next().value);
    }
  }

  /**
   * The RAW child session id for a canonical envelope, or null.
   *
   * Identity-keyed (by `envelope.eventId`), never positional: a consumer holding
   * an output can resolve the producing event's raw child handle without
   * knowing (or guessing) which raw event is currently in flight. Returns null
   * for an envelope this adapter never built from raw input — e.g. one arriving
   * through a canonical `eventsSince` replay — which is the documented
   * fail-closed path.
   */
  function rawChildHandleFor(envelope) {
    if (!envelope || typeof envelope.eventId !== 'string') return null;
    const handle = rawChildHandles.get(envelope.eventId);
    return typeof handle === 'string' && handle !== '' ? handle : null;
  }

  function buildEnvelope(raw, payloadInfo, eventId, sequence, sequenceSource, atMs) {
    const envelope = Object.freeze({
      schemaVersion: 1,
      eventId,
      sessionId,
      sessionEpoch,
      // Adapter-derived (never a Harness fact). Carried on the envelope so the
      // pairing survives buffered drain and canonical `eventsSince` replay; see
      // the module header.
      pairingHandle: pairingHandleOf(raw),
      sequence,
      eventType: raw.type,
      payload: Object.freeze(isPlainObject(payloadInfo.redactedPayload)
        ? { ...payloadInfo.redactedPayload } : payloadInfo.redactedPayload),
      sequenceSource,
      receivedAt: new Date(atMs).toISOString(),
    });
    // The raw child handle is remembered HERE (build time, from raw input) so it
    // is available no matter when the fact is actually applied (immediately,
    // after a buffered drain, or never).
    rememberRawChildHandle(envelope, raw);
    return envelope;
  }

  // -- Runtime mapping -------------------------------------------------------------

  // Maps one canonical envelope into Office runtime facts. Runtime facts read
  // the redacted payload only, EXCEPT the subagent pairing handle: it is read
  // from the envelope's adapter-derived `pairingHandle` field (computed once at
  // first raw ingest), NEVER re-derived from rawData — a replayed envelope's
  // rawData is its already-redacted payload, so re-deriving would hash the
  // redaction placeholder and break start/end pairing (see module header).
  // Only proven Harness semantics become facts; unknown reasons degrade to
  // attention with the coarse reason preserved. Never produces offline or
  // terminal guesses.
  function mapEnvelope(envelope, rawData) {
    const facts = [];
    const diagnostics = [];
    const payload = isPlainObject(envelope.payload) ? envelope.payload : {};
    const raw = isPlainObject(rawData) ? rawData : {};
    // Absent (a v1/foreign envelope) and null both mean "no pairable handle".
    const pairingHandle = typeof envelope.pairingHandle === 'string' ? envelope.pairingHandle : null;
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
        // P1 运行时体检（2026-09-26，子代理座位工具短语核对缺陷）：两条投递路径
        // 的工具名形状不同——live 事件由 main.js 预翻译成 0.1.x wire 的
        // `{tool}`，而 session/follow 开窗与 resync 回放（ingestHarnessSnapshot）
        // 把 0.1.5 journal 原始记录原样交给适配器（`{callId, name, arguments}`）。
        // 旧映射只认 `data.tool` → 回放路径把每次工具调用都映射成 tool:null 的
        // runtime/tool 事实：座位 toolKind 被清空、开窗里的工具调用永远不亮
        // toolPhrase。统一走共享提取器（name 优先、tool 兼容），两条路径同义。
        facts.push({ type: 'runtime/tool', tool: toolNameOfJournalData(raw) });
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
        const runId = pairingHandle;
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
        const runId = pairingHandle;
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
    // the standard { envelope: null, sessionId, facts, diagnostics } channel —
    // never a fabricated Harness envelope (no eventId/eventType/sequence), but
    // still carrying the session identity so the consumer never has to infer it.
    if (result.facts.length > 0 || result.factsDiagnostics.length > 0) {
      onEvent(Object.freeze({
        envelope: null,
        sessionId,
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
      derivedFields: Object.freeze(['eventId', 'sessionEpoch', 'pairingHandle']),
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
      // COUNT only — the raw child handles themselves are never observable.
      rawHandleSize: rawChildHandles.size,
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
    // Identity-keyed raw-handle lookup (Phase B): the consumer resolves a
    // fact's raw child handle from the FACT'S OWN envelope identity instead of
    // guessing which raw event is in flight.
    rawChildHandleFor,
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
