'use strict';

// src/office/runtime/runtime-snapshot.js — Task 6 / SPEC-05.
//
// Office snapshot / resync schema and merge contract. Pure CommonJS: no
// Electron/Pixi/DOM/fs/network/Harness import, no Date.now()/setTimeout as
// business facts — every time value comes from the injected clock.
//
// These are DshCockpit-internal messages (office:* namespace). Harness does
// NOT provide snapshot/resync natively (see
// docs/research/HARNESS-RUNTIME-EVIDENCE-2026-08.md); the snapshot is composed
// from session.follow/page/control by the wiring layer, never synthesized
// from guessed state.
//
// Acceptance rules (SPEC-05):
// - requestId/sessionId/sessionEpoch must match the pending request
// - sequence must be a valid integer >= 0 and not stale
//   (not below the current watermark, not below request.fromSequence-1)
// - eventsSince must be same-epoch, same-session canonical envelopes,
//   strictly increasing, and all > snapshot.sequence
// - on accept the snapshot sequence becomes the new contiguous watermark,
//   buffered events <= sequence are discarded, and only the same-epoch
//   remainder replays in strict order

const SCHEMA_VERSION = 1;
const RESYNC_REQUEST_TYPE = 'office:runtime-resync-request';
const SNAPSHOT_TYPE = 'office:runtime-snapshot';

// Fixed exponential retry timeline: 250/500/1000/2000/4000ms; continuation is
// exponential capped at 5000ms; max 5 attempts, then the adapter goes stale.
const RESYNC_RETRY_SCHEDULE_MS = Object.freeze([250, 500, 1000, 2000, 4000]);
const RESYNC_MAX_ATTEMPTS = 5;
const RESYNC_RETRY_CAP_MS = 5000;

// A pending resync request lives long enough to span the full retry timeline
// (~7.75s) plus slack; after the TTL a late answer is rejected as
// NO_PENDING_REQUEST.
const RESYNC_REQUEST_TTL_MS = 10_000;

// Snapshot `facts` whitelist (canonical mapping — arbitrary objects are never
// passed through into Office state):
// - `runtime`: runtime presentation at the snapshot sequence. Values limited
//   to the frozen 3-layer runtime vocabulary of SPEC-00/03 that the Office
//   may learn without a per-event terminal reason: running, idle, completed,
//   failed, attention. Unknown values degrade to the stable diagnostic code
//   below; unknown keys degrade to SNAPSHOT_FACTS_UNSUPPORTED_KEY.
const SNAPSHOT_FACT_KEYS = Object.freeze(['runtime']);
const SNAPSHOT_RUNTIME_VALUES = Object.freeze(['running', 'idle', 'completed', 'failed', 'attention']);
// Privacy floor: unknown fact VALUES never echo back into diagnostics. A
// dropped runtime value yields `null` here; the ONLY information the
// diagnostic carries is the fixed code itself (no key/value substring).
const DROPPED_RUNTIME_VALUE = null;

// Maps the whitelisted subset of an office:runtime-snapshot `facts` object to
// canonical Office facts. Returns null for non-object input (shape boundary),
// otherwise { facts, diagnostics }: facts are canonical `runtime/fact` entries
// only; diagnostics are stable codes for every dropped unknown key/value.
function sanitizeSnapshotFacts(facts) {
  if (!isPlainObject(facts)) return null;
  const mapped = [];
  const diagnostics = [];
  for (const key of Object.keys(facts)) {
    if (!SNAPSHOT_FACT_KEYS.includes(key)) {
      diagnostics.push(Object.freeze({ code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key }));
      continue;
    }
    const value = facts[key];
    if (!SNAPSHOT_RUNTIME_VALUES.includes(value)) {
      diagnostics.push(Object.freeze({
        code: 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE',
        runtime: DROPPED_RUNTIME_VALUE,
      }));
      continue;
    }
    mapped.push(Object.freeze({ type: 'runtime/fact', fact: value }));
  }
  return Object.freeze({
    facts: Object.freeze(mapped),
    diagnostics: Object.freeze(diagnostics),
  });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(code) {
  return Object.freeze({ ok: false, code, replay: Object.freeze([]), leftover: Object.freeze([]) });
}

function valid(code = null) {
  return Object.freeze({ ok: code === null, code });
}

// The delay BEFORE the (attemptIndex+1)-th send. Index 0..4 follow the frozen
// schedule; continuation doubles 250ms * 2^index capped at RESYNC_RETRY_CAP_MS;
// beyond RESYNC_MAX_ATTEMPTS * 2 the cycle is exhausted and returns null.
function nextResyncDelayMs(attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) return null;
  if (attemptIndex >= RESYNC_MAX_ATTEMPTS * 2) return null;
  if (attemptIndex < RESYNC_RETRY_SCHEDULE_MS.length) {
    return RESYNC_RETRY_SCHEDULE_MS[attemptIndex];
  }
  return RESYNC_RETRY_CAP_MS;
}

// -----------------------------------------------------------------------------
// Message construction
// -----------------------------------------------------------------------------

function createResyncRequest({ requestId, sessionId, sessionEpoch, fromSequence } = {}) {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('createResyncRequest requires a non-empty requestId');
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('createResyncRequest requires a non-empty sessionId');
  }
  if (typeof sessionEpoch !== 'string' || sessionEpoch === '') {
    throw new Error('createResyncRequest requires a non-empty sessionEpoch');
  }
  if (!Number.isInteger(fromSequence) || fromSequence < 0) {
    throw new Error('createResyncRequest requires an integer fromSequence >= 0');
  }
  return Object.freeze({
    type: RESYNC_REQUEST_TYPE,
    requestId,
    sessionId,
    sessionEpoch,
    fromSequence,
  });
}

function createSnapshotResponse({
  requestId, sessionId, sessionEpoch, sequence, facts = {}, eventsSince = [],
} = {}) {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('createSnapshotResponse requires a non-empty requestId');
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('createSnapshotResponse requires a non-empty sessionId');
  }
  if (typeof sessionEpoch !== 'string' || sessionEpoch === '') {
    throw new Error('createSnapshotResponse requires a non-empty sessionEpoch');
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error('createSnapshotResponse requires an integer sequence >= 0');
  }
  if (!isPlainObject(facts)) {
    throw new Error('createSnapshotResponse requires plain object facts');
  }
  if (!Array.isArray(eventsSince)) {
    throw new Error('createSnapshotResponse requires an eventsSince array');
  }
  return Object.freeze({
    type: SNAPSHOT_TYPE,
    requestId,
    sessionId,
    sessionEpoch,
    sequence,
    facts: Object.freeze({ ...facts }),
    eventsSince: Object.freeze([...eventsSince]),
  });
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

// Validates one canonical envelope produced by the Office adapter. The
// envelope is an adapter-derived artifact (eventId/sessionEpoch are never
// Harness facts); validating shape here keeps snapshot merges honest.
function validateEnvelope(value, expected = {}) {
  if (!isPlainObject(value)) return valid('ENVELOPE_SHAPE_INVALID');
  if (value.schemaVersion !== SCHEMA_VERSION) return valid('ENVELOPE_SHAPE_INVALID');
  if (typeof value.eventId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value.eventId)) {
    return valid('ENVELOPE_SHAPE_INVALID');
  }
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return valid('ENVELOPE_SHAPE_INVALID');
  if (typeof value.sessionEpoch !== 'string' || value.sessionEpoch === '') return valid('ENVELOPE_SHAPE_INVALID');
  if (!Number.isInteger(value.sequence) || value.sequence < 0) return valid('ENVELOPE_SHAPE_INVALID');
  if (typeof value.eventType !== 'string' || value.eventType === '') return valid('ENVELOPE_SHAPE_INVALID');
  if (!isPlainObject(value.payload)) return valid('ENVELOPE_SHAPE_INVALID');
  if (value.sequenceSource !== 'upstream' && value.sequenceSource !== 'adapter') {
    return valid('ENVELOPE_SHAPE_INVALID');
  }
  if (typeof value.receivedAt !== 'string' || value.receivedAt === '') return valid('ENVELOPE_SHAPE_INVALID');
  if (expected.sessionEpoch !== undefined && value.sessionEpoch !== expected.sessionEpoch) {
    return valid('ENVELOPE_EPOCH_MISMATCH');
  }
  if (expected.sessionId !== undefined && value.sessionId !== expected.sessionId) {
    return valid('ENVELOPE_SESSION_MISMATCH');
  }
  return valid();
}

// Structural + expectation validation for office:runtime-snapshot.
// `expected` may carry requestId/sessionId/sessionEpoch (the pending
// request), `watermark` (current contiguous watermark) and `minSequence`
// (request.fromSequence - 1).
function validateSnapshotMessage(message, expected = {}) {
  if (!isPlainObject(message)) return valid('MESSAGE_TYPE_INVALID');
  if (message.type !== SNAPSHOT_TYPE) return valid('MESSAGE_TYPE_INVALID');
  if (typeof message.requestId !== 'string' || message.requestId === '' ||
      typeof message.sessionId !== 'string' || message.sessionId === '' ||
      typeof message.sessionEpoch !== 'string' || message.sessionEpoch === '') {
    return valid('MESSAGE_FIELD_INVALID');
  }
  if (!Number.isInteger(message.sequence) || message.sequence < 0) {
    return valid('SNAPSHOT_SEQUENCE_INVALID');
  }
  if (!isPlainObject(message.facts)) return valid('SNAPSHOT_FACTS_INVALID');
  if (!Array.isArray(message.eventsSince)) return valid('EVENTS_SINCE_INVALID');
  let previousSequence = null;
  for (const element of message.eventsSince) {
    const envelopeCheck = validateEnvelope(element);
    if (!envelopeCheck.ok) return valid('EVENTS_SINCE_INVALID');
    if (element.sessionId !== message.sessionId || element.sessionEpoch !== message.sessionEpoch) {
      return valid('EVENTS_SINCE_INVALID');
    }
    if (previousSequence !== null && element.sequence <= previousSequence) {
      return valid('EVENTS_SINCE_NOT_INCREASING');
    }
    if (element.sequence <= message.sequence) {
      return valid('EVENTS_SINCE_BELOW_SNAPSHOT');
    }
    previousSequence = element.sequence;
  }
  if (expected.requestId !== undefined && message.requestId !== expected.requestId) {
    return valid('REQUEST_MISMATCH');
  }
  if (expected.sessionId !== undefined && message.sessionId !== expected.sessionId) {
    return valid('SESSION_MISMATCH');
  }
  if (expected.sessionEpoch !== undefined && message.sessionEpoch !== expected.sessionEpoch) {
    return valid('EPOCH_MISMATCH');
  }
  if (Number.isInteger(expected.minSequence) && message.sequence < expected.minSequence) {
    return valid('SNAPSHOT_SEQUENCE_STALE');
  }
  if (Number.isInteger(expected.watermark) && message.sequence < expected.watermark) {
    return valid('SNAPSHOT_SEQUENCE_STALE');
  }
  return valid();
}

// -----------------------------------------------------------------------------
// Merge state
// -----------------------------------------------------------------------------

function createSnapshotMergeState({ watermark = 0, sessionEpoch, clock } = {}) {
  if (typeof sessionEpoch !== 'string' || sessionEpoch === '') {
    throw new Error('createSnapshotMergeState requires a non-empty sessionEpoch');
  }
  const now = clock && typeof clock.nowMs === 'function' ? clock.nowMs : () => 0;
  return { watermark, sessionEpoch, pendingRequests: [], now };
}

// New attempts supersede older pending requests: at most one request is
// answerable at a time, so a late response to a stale attempt can never
// apply (it resolves to NO_PENDING_REQUEST).
function trackResyncRequest(state, request) {
  const entry = Object.freeze({
    requestId: request.requestId,
    sessionId: request.sessionId,
    sessionEpoch: request.sessionEpoch,
    fromSequence: request.fromSequence,
    requestedAtMs: state.now(),
  });
  state.pendingRequests = [entry];
  return entry;
}

function pruneResyncRequests(state) {
  const now = state.now();
  state.pendingRequests = state.pendingRequests.filter(
    (entry) => now - entry.requestedAtMs < RESYNC_REQUEST_TTL_MS
  );
}

// -----------------------------------------------------------------------------
// Merge
// -----------------------------------------------------------------------------

// Applies office:runtime-snapshot to the merge state. `buffered` are the
// caller's currently buffered canonical envelopes (already same-epoch unless
// the caller made an error; still filtered defensively).
//
// Returns { ok:true, replay, leftover } — replay is the strict-order prefix
// the caller MUST deliver (in order), leftover is what stays buffered past a
// residual gap. The caller never fabricates the gap itself.
function mergeSnapshot(state, { request, snapshot, buffered = [] } = {}) {
  if (!request || typeof request !== 'object') {
    return fail('NO_PENDING_REQUEST');
  }
  if (request.sessionEpoch !== state.sessionEpoch) {
    return fail('EPOCH_MISMATCH');
  }
  // Old-epoch responses are rejected before any request matching: they must
  // never contaminate the current epoch regardless of which requestId they
  // claim to answer.
  if (!snapshot || snapshot.sessionEpoch !== state.sessionEpoch) {
    return fail('EPOCH_MISMATCH');
  }
  const pending = state.pendingRequests.find((entry) => entry.requestId === request.requestId);
  if (!pending) {
    return fail('NO_PENDING_REQUEST');
  }
  const verdict = validateSnapshotMessage(snapshot, {
    requestId: request.requestId,
    sessionId: request.sessionId,
    sessionEpoch: request.sessionEpoch,
    watermark: state.watermark,
    minSequence: (Number.isInteger(request.fromSequence) ? request.fromSequence : 0) - 1,
  });
  if (!verdict.ok) return fail(verdict.code);

  // Facts pass the whitelist/shape boundary BEFORE any merge succeeds: an
  // unknown value or key never blocks the merge (it degrades to a stable
  // diagnostic), while a non-object facts shape still rejects the snapshot.
  const facts = sanitizeSnapshotFacts(snapshot.facts);
  if (facts === null) return fail('SNAPSHOT_FACTS_INVALID');

  const snapshotSequence = snapshot.sequence;
  const bySequence = new Map();
  for (const env of snapshot.eventsSince) {
    bySequence.set(env.sequence, env);
  }
  for (const env of buffered) {
    if (!env || typeof env !== 'object') continue;
    if (env.sessionEpoch !== state.sessionEpoch) continue;
    if (env.sessionId !== request.sessionId) continue;
    if (!Number.isInteger(env.sequence) || env.sequence <= snapshotSequence) continue;
    if (bySequence.has(env.sequence)) continue; // eventsSince copy wins the collision
    bySequence.set(env.sequence, env);
  }
  const ordered = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const replay = [];
  const leftover = [];
  let watermark = snapshotSequence;
  for (const env of ordered) {
    if (env.sequence === watermark + 1) {
      replay.push(env);
      watermark = env.sequence;
    } else {
      leftover.push(env);
    }
  }
  state.watermark = watermark;
  state.pendingRequests = state.pendingRequests.filter((entry) => entry.requestId !== request.requestId);
  return Object.freeze({
    ok: true,
    code: null,
    replay: Object.freeze(replay),
    leftover: Object.freeze(leftover),
    // Sanitized (whitelist-mapped) canonical facts for the caller to surface;
    // these are NOT envelopes and carry no eventId/sequence/eventType.
    facts: facts.facts,
    factsDiagnostics: facts.diagnostics,
  });
}

module.exports = {
  SCHEMA_VERSION,
  RESYNC_REQUEST_TYPE,
  SNAPSHOT_TYPE,
  RESYNC_RETRY_SCHEDULE_MS,
  RESYNC_MAX_ATTEMPTS,
  RESYNC_RETRY_CAP_MS,
  RESYNC_REQUEST_TTL_MS,
  nextResyncDelayMs,
  createResyncRequest,
  createSnapshotResponse,
  validateEnvelope,
  validateSnapshotMessage,
  sanitizeSnapshotFacts,
  SNAPSHOT_FACT_KEYS,
  SNAPSHOT_RUNTIME_VALUES,
  createSnapshotMergeState,
  trackResyncRequest,
  pruneResyncRequests,
  mergeSnapshot,
};
