'use strict';

// Task 6 / SPEC-05 — office:runtime-snapshot schema and merge contract.
// RED: src/office/runtime/runtime-snapshot.js does not exist yet.
//
// Contracts under test (DshCockpit-only messages, SPEC-05):
//   request  { type:"office:runtime-resync-request", requestId, sessionId,
//              sessionEpoch, fromSequence }
//   response { type:"office:runtime-snapshot", requestId, sessionId,
//              sessionEpoch, sequence, facts, eventsSince }
// - request/session/epoch must all match; eventsSince same epoch, strictly
//   increasing and all > snapshot sequence
// - snapshot sequence becomes the new contiguous watermark; buffered events
//   <= snapshot are discarded; same-epoch remainder replays strictly in order
// - all time math runs on the injected fake clock (no Date.now/setTimeout)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const snapshotModule = require('../src/office/runtime/runtime-snapshot.js');

const T0 = 1_700_000_000_000;

function createHarness() {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  return { clock, advance: (ms) => { nowMs += ms; } };
}

function envelope(sequence, epoch, sessionId = 'sess-fixture', eventType = 'tool/call') {
  return {
    schemaVersion: 1,
    eventId: 'sha256:' + String(sequence % 100).padStart(2, '0').repeat(32),
    sessionId,
    sessionEpoch: epoch,
    sequence,
    eventType,
    payload: { tool: 't' + sequence },
    sequenceSource: 'upstream',
    receivedAt: new Date(T0 + sequence).toISOString(),
  };
}

function snapshotMessage({ requestId, sessionId, sessionEpoch, sequence, facts, eventsSince }) {
  return {
    type: 'office:runtime-snapshot',
    requestId,
    sessionId,
    sessionEpoch,
    sequence,
    facts: facts === undefined ? {} : facts,
    eventsSince: eventsSince === undefined ? [] : eventsSince,
  };
}

// --- Request construction -----------------------------------------------------

test('createResyncRequest builds the DshCockpit-only request shape', () => {
  const request = snapshotModule.createResyncRequest({
    requestId: 'resync-1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', fromSequence: 12,
  });
  assert.deepEqual(Object.keys(request).sort(), ['fromSequence', 'requestId', 'sessionEpoch', 'sessionId', 'type']);
  assert.equal(request.type, 'office:runtime-resync-request');
  assert.equal(request.requestId, 'resync-1');
  assert.equal(request.sessionId, 'sess-fixture');
  assert.equal(request.sessionEpoch, 'adapter-e1');
  assert.equal(request.fromSequence, 12);
});

test('createResyncRequest requires an explicit requestId', () => {
  assert.throws(
    () => snapshotModule.createResyncRequest({ sessionId: 's', sessionEpoch: 'e', fromSequence: 1 }),
    /requestId/
  );
});

test('createResyncRequest requires integer fromSequence', () => {
  assert.throws(
    () => snapshotModule.createResyncRequest({ requestId: 'r', sessionId: 's', sessionEpoch: 'e', fromSequence: 1.5 }),
    /fromSequence/
  );
});

test('createSnapshotResponse builds the DshCockpit-only response shape', () => {
  const epoch = 'adapter-e1';
  const response = snapshotModule.createSnapshotResponse({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: epoch, sequence: 4,
    facts: { runtime: 'running' }, eventsSince: [envelope(5, epoch)],
  });
  assert.deepEqual(Object.keys(response).sort(), [
    'eventsSince', 'facts', 'requestId', 'sequence', 'sessionEpoch', 'sessionId', 'type',
  ]);
  assert.equal(response.type, 'office:runtime-snapshot');
  assert.equal(response.sequence, 4);
  assert.deepEqual(response.facts, { runtime: 'running' });
  assert.equal(response.eventsSince.length, 1);
});

// --- Validation ---------------------------------------------------------------

test('validateSnapshotMessage accepts a structurally valid snapshot', () => {
  const epoch = 'adapter-e1';
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: epoch, sequence: 4,
    facts: { runtime: 'running' },
    eventsSince: [envelope(5, epoch), envelope(6, epoch)],
  });
  const verdict = snapshotModule.validateSnapshotMessage(snapshot);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, null);
});

test('validateSnapshotMessage rejects wrong message type or missing fields', () => {
  assert.equal(snapshotModule.validateSnapshotMessage(null).ok, false);
  assert.equal(snapshotModule.validateSnapshotMessage({ type: 'other' }).code, 'MESSAGE_TYPE_INVALID');
  assert.equal(
    snapshotModule.validateSnapshotMessage(snapshotMessage({ requestId: 'r', sessionId: '', sessionEpoch: 'e', sequence: 1 })).code,
    'MESSAGE_FIELD_INVALID'
  );
  assert.equal(
    snapshotModule.validateSnapshotMessage(snapshotMessage({ requestId: 'r', sessionId: 's', sessionEpoch: '', sequence: 1 })).code,
    'MESSAGE_FIELD_INVALID'
  );
  assert.equal(
    snapshotModule.validateSnapshotMessage(snapshotMessage({ requestId: 'r', sessionId: 's', sessionEpoch: 'e', sequence: 1.5 })).code,
    'SNAPSHOT_SEQUENCE_INVALID'
  );
});

test('validateSnapshotMessage rejects non-object facts and invalid eventsSince', () => {
  const epoch = 'adapter-e1';
  const bad = (fields) => snapshotModule.validateSnapshotMessage(snapshotMessage({
    requestId: 'r', sessionId: 'sess-fixture', sessionEpoch: epoch, sequence: 1, ...fields,
  }));
  assert.equal(bad({ facts: 'no' }).code, 'SNAPSHOT_FACTS_INVALID');
  assert.equal(bad({ facts: null }).code, 'SNAPSHOT_FACTS_INVALID');
  assert.equal(bad({ eventsSince: 'no' }).code, 'EVENTS_SINCE_INVALID');
  assert.equal(bad({ eventsSince: [null] }).code, 'EVENTS_SINCE_INVALID');
  assert.equal(bad({ eventsSince: [envelope(2, epoch), envelope(2, epoch)] }).code, 'EVENTS_SINCE_NOT_INCREASING');
  assert.equal(bad({ eventsSince: [envelope(0, epoch)] }).code, 'EVENTS_SINCE_BELOW_SNAPSHOT');
});

test('validateSnapshotMessage rejects eventsSince from a foreign epoch or session', () => {
  const epoch = 'adapter-e1';
  const snapshot = snapshotMessage({
    requestId: 'r', sessionId: 's', sessionEpoch: epoch, sequence: 1,
    eventsSince: [envelope(2, 'adapter-other')],
  });
  assert.equal(snapshotModule.validateSnapshotMessage(snapshot).code, 'EVENTS_SINCE_INVALID');
  const foreignSession = snapshotMessage({
    requestId: 'r', sessionId: 's', sessionEpoch: epoch, sequence: 1,
    eventsSince: [envelope(2, epoch, 'sess-other')],
  });
  assert.equal(snapshotModule.validateSnapshotMessage(foreignSession).code, 'EVENTS_SINCE_INVALID');
});

// --- Envelope validation -------------------------------------------------------

test('validateEnvelope requires the full canonical shape', () => {
  const epoch = 'adapter-e1';
  assert.equal(snapshotModule.validateEnvelope(envelope(3, epoch)).ok, true);
  const broken = { ...envelope(3, epoch), eventType: 42 };
  assert.equal(snapshotModule.validateEnvelope(broken).code, 'ENVELOPE_SHAPE_INVALID');
  const noId = { ...envelope(3, epoch), eventId: 'not-a-hash' };
  assert.equal(snapshotModule.validateEnvelope(noId).code, 'ENVELOPE_SHAPE_INVALID');
  const wrongEpoch = { ...envelope(3, epoch), sessionEpoch: 'adapter-zzz' };
  assert.equal(snapshotModule.validateEnvelope(wrongEpoch, { sessionEpoch: 'adapter-e1' }).code, 'ENVELOPE_EPOCH_MISMATCH');
});

// --- Snapshot facts whitelist -------------------------------------------------

test('sanitizeSnapshotFacts maps whitelisted runtime states only', () => {
  for (const runtime of ['running', 'idle', 'completed', 'failed', 'attention']) {
    const result = snapshotModule.sanitizeSnapshotFacts({ runtime });
    assert.deepEqual(result, { facts: [{ type: 'runtime/fact', fact: runtime }], diagnostics: [] }, runtime);
  }
});

test('sanitizeSnapshotFacts drops unknown runtime values with a stable diagnostic', () => {
  const result = snapshotModule.sanitizeSnapshotFacts({ runtime: 'sleepwalking' });
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.diagnostics, [
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE', runtime: null },
  ]);
});

test('sanitizeSnapshotFacts never passes arbitrary keys or values through', () => {
  const result = snapshotModule.sanitizeSnapshotFacts({
    runtime: 'running',
    prompt: 'SECRET TEXT',
    args: { command: 'rm -rf /' },
    nested: { deep: true },
  });
  assert.deepEqual(result.facts, [{ type: 'runtime/fact', fact: 'running' }]);
  assert.deepEqual(result.diagnostics, [{ code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'prompt' },
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'args' },
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'nested' }]);
  const json = JSON.stringify(result);
  assert.ok(!json.includes('SECRET TEXT') && !json.includes('rm -rf'), 'no raw passthrough');
});

test('sanitizeSnapshotFacts rejects non-object input', () => {
  assert.equal(snapshotModule.sanitizeSnapshotFacts('nope'), null);
  assert.equal(snapshotModule.sanitizeSnapshotFacts(null), null);
  assert.equal(snapshotModule.sanitizeSnapshotFacts([]), null);
  assert.deepEqual(snapshotModule.sanitizeSnapshotFacts({}), { facts: [], diagnostics: [] });
});

// --- Snapshot facts privacy floor ------------------------------------------------

const SENSITIVE_SAMPLES = [
  'SECRET TEXT',
  'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  'xoxb-1234567890-abcdefghijkl',
  '/Users/alice/secret-project/.env',
  '/home/bob/private/keys/id_rsa',
  'a very long sensitive narrative that describes an internal conversation about a private customer engagement with detailed paragraphs of private information '.repeat(4),
];

test('unknown runtime VALUES never leak into sanitizeSnapshotFacts output', () => {
  for (const value of SENSITIVE_SAMPLES) {
    const result = snapshotModule.sanitizeSnapshotFacts({ runtime: value });
    assert.deepEqual(result.facts, [], `no fact for ${value.slice(0, 24)}…`);
    assert.deepEqual(result.diagnostics, [
      { code: 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE', runtime: null },
    ], `unknown value must be replaced by null for ${value.slice(0, 24)}…`);
    assert.ok(!JSON.stringify(result).includes(value.slice(0, 48)), 'value must not be echoed');
  }
});

test('unknown KEYS never leak their values through diagnostics', () => {
  for (const value of SENSITIVE_SAMPLES) {
    const result = snapshotModule.sanitizeSnapshotFacts({
      runtime: 'running',
      secretPayload: value,
      args: { command: value },
      note: value,
    });
    assert.deepEqual(result.facts, [{ type: 'runtime/fact', fact: 'running' }]);
    assert.deepEqual(result.diagnostics, [
      { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'secretPayload' },
      { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'args' },
      { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'note' },
    ]);
    assert.ok(!JSON.stringify(result).includes(value.slice(0, 48)), 'key diagnostic must not echo the value');
  }
});

test('adapter-level snapshot flow keeps sensitive facts out of all emitted output', () => {
  const { createRuntimeAdapter } = require('../src/office/runtime/runtime-adapter.js');
  let nowMs = 1_700_000_000_000;
  const emitted = [];
  const messages = [];
  const adapter = createRuntimeAdapter({
    sessionId: 'sess-privacy', clock: { nowMs: () => nowMs },
    onEvent: (o) => emitted.push(o), onMessage: (m) => messages.push(m),
  });
  adapter.ingest({ type: 'turn/start', seq: 1, time: 1, data: {} });
  adapter.ingest({ type: 'tool/call', seq: 4, time: 2, data: { tool: 'bash' } }); // gap
  const requestId = messages[messages.length - 1].requestId;
  const secret = SENSITIVE_SAMPLES[4];
  const result = adapter.acceptSnapshot({
    type: 'office:runtime-snapshot',
    requestId, sessionId: 'sess-privacy', sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3,
    facts: { runtime: secret, prompt: secret },
    eventsSince: [],
  });
  assert.equal(result.ok, true, 'snapshot itself is valid; only the facts are degraded');
  const blob = JSON.stringify(emitted);
  assert.ok(!blob.includes(secret), 'no emitted output contains the sensitive value');
  const diagnostics = emitted.filter((e) => e.envelope === null).flatMap((e) => e.diagnostics);
  assert.ok(diagnostics.some((d) => d.code === 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE'));
  assert.ok(diagnostics.some((d) => d.code === 'SNAPSHOT_FACTS_UNSUPPORTED_KEY'));
});

// --- Merge ---------------------------------------------------------------------

function mergeHarness() {
  const { clock, advance } = createHarness();
  const state = snapshotModule.createSnapshotMergeState({ watermark: 0, sessionEpoch: 'adapter-e1', clock });
  return { clock, advance, state };
}

function trackedRequest(state, overrides = {}) {
  const request = snapshotModule.createResyncRequest({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', fromSequence: 2, ...overrides,
  });
  snapshotModule.trackResyncRequest(state, request);
  return request;
}

test('merge surfaces sanitized snapshot facts back to the caller', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
    facts: { runtime: 'running' },
  });
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.facts, [{ type: 'runtime/fact', fact: 'running' }]);
  assert.deepEqual(result.factsDiagnostics, []);
});

test('merge keeps unknown snapshot facts out but reports the degradation', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
    facts: { runtime: 'nope', weird: 1 },
  });
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered: [] });
  assert.equal(result.ok, true, 'unknown facts never invalidate a snapshot');
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.factsDiagnostics, [
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE', runtime: null },
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'weird' },
  ]);
});

test('merge rejects non-object facts', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
    facts: 'no',
  });
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_FACTS_INVALID');
});

test('accepted snapshot establishes the watermark and discards stale buffers', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
    eventsSince: [envelope(4, 'adapter-e1')],
  });
  const buffered = [envelope(2, 'adapter-e1'), envelope(3, 'adapter-e1'), envelope(4, 'adapter-e1'), envelope(5, 'adapter-e1')];
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered });
  assert.equal(result.ok, true);
  // buffered 2..3 are stale (<= snapshot 3); 4 dedupes eventsSince 4; 5 replays.
  assert.deepEqual(result.replay.map((e) => e.sequence), [4, 5]);
  assert.equal(state.watermark, 5);
  assert.deepEqual(result.leftover, []);
  assert.equal(state.pendingRequests.length, 0, 'request is consumed');
});

test('merge enforces request/session/epoch match and stable rejection codes', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const cases = [
    { requestId: 'rX', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 5, code: 'REQUEST_MISMATCH' },
    { requestId: 'r1', sessionId: 'sess-other', sessionEpoch: 'adapter-e1', sequence: 5, code: 'SESSION_MISMATCH' },
    { requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-old', sequence: 5, code: 'EPOCH_MISMATCH' },
    { requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 0, code: 'SNAPSHOT_SEQUENCE_STALE' },
    { requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 1.5, code: 'SNAPSHOT_SEQUENCE_INVALID' },
  ];
  for (const partial of cases) {
    const { code, ...snapshotFields } = partial;
    const result = snapshotModule.mergeSnapshot(state, { request, snapshot: snapshotMessage(snapshotFields), buffered: [] });
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
  }
  assert.equal(state.watermark, 0, 'rejected snapshots never move the watermark');
});

test('merge rejects snapshots answering a request from a different epoch', () => {
  const { state } = mergeHarness();
  const request = { requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-old', fromSequence: 2 };
  const result = snapshotModule.mergeSnapshot(state, {
    request, snapshot: snapshotMessage({ requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 5 }), buffered: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EPOCH_MISMATCH');
});

test('merge replays buffered remainder in strict order after eventsSince', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 4,
  });
  const buffered = [envelope(5, 'adapter-e1'), envelope(6, 'adapter-e1')];
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered });
  assert.equal(result.ok, true);
  assert.deepEqual(result.replay.map((e) => e.sequence), [5, 6]);
  assert.equal(state.watermark, 6);
});

test('merge keeps the first occurrence when sources collide on a sequence', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
    eventsSince: [envelope(4, 'adapter-e1')],
  });
  const variant = { ...envelope(4, 'adapter-e1'), eventId: 'sha256:' + 'f'.repeat(64) };
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered: [variant, envelope(5, 'adapter-e1')] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.replay.map((e) => e.sequence), [4, 5]);
  assert.equal(result.replay[0].eventId, envelope(4, 'adapter-e1').eventId, 'eventsSince wins the collision');
});

test('merge leaves a residual gap in leftover instead of guessing', () => {
  const { state } = mergeHarness();
  const request = trackedRequest(state);
  const snapshot = snapshotMessage({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 3,
  });
  const buffered = [envelope(5, 'adapter-e1'), envelope(6, 'adapter-e1')]; // 4 still missing
  const result = snapshotModule.mergeSnapshot(state, { request, snapshot, buffered });
  assert.equal(result.ok, true);
  assert.deepEqual(result.replay, []);
  assert.deepEqual(result.leftover.map((e) => e.sequence), [5, 6]);
  assert.equal(state.watermark, 3);
});

test('merge is a no-op against a watermark at or above the snapshot', () => {
  const { state } = mergeHarness();
  state.watermark = 7;
  const request = trackedRequest(state, { fromSequence: 2 });
  const result = snapshotModule.mergeSnapshot(state, {
    request, snapshot: snapshotMessage({ requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 5 }), buffered: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_SEQUENCE_STALE');
  assert.equal(state.watermark, 7);
});

test('pending requests expire by the fake clock and never answer late', () => {
  const { state, clock, advance } = mergeHarness();
  const request = snapshotModule.createResyncRequest({
    requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', fromSequence: 2,
  });
  snapshotModule.trackResyncRequest(state, request);
  advance(1);
  assert.equal(state.pendingRequests.length, 1);
  advance(snapshotModule.RESYNC_REQUEST_TTL_MS);
  snapshotModule.pruneResyncRequests(state);
  assert.equal(state.pendingRequests.length, 0);
  const result = snapshotModule.mergeSnapshot(state, {
    request,
    snapshot: snapshotMessage({ requestId: 'r1', sessionId: 'sess-fixture', sessionEpoch: 'adapter-e1', sequence: 5 }),
    buffered: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PENDING_REQUEST');
});

// --- Retry schedule constants ---------------------------------------------------

test('RESYNC_RETRY_SCHEDULE_MS is the frozen exponential timeline capped at 5s', () => {
  assert.deepEqual(snapshotModule.RESYNC_RETRY_SCHEDULE_MS, [250, 500, 1000, 2000, 4000]);
  assert.equal(snapshotModule.RESYNC_MAX_ATTEMPTS, 5);
  assert.equal(snapshotModule.RESYNC_RETRY_CAP_MS, 5000);
  assert.ok(Object.isFrozen(snapshotModule.RESYNC_RETRY_SCHEDULE_MS));
});

test('nextResyncDelayMs follows the schedule then the cap, and stops after max attempts', () => {
  assert.equal(snapshotModule.nextResyncDelayMs(0), 250);
  assert.equal(snapshotModule.nextResyncDelayMs(1), 500);
  assert.equal(snapshotModule.nextResyncDelayMs(2), 1000);
  assert.equal(snapshotModule.nextResyncDelayMs(3), 2000);
  assert.equal(snapshotModule.nextResyncDelayMs(4), 4000);
  assert.equal(snapshotModule.nextResyncDelayMs(5), 5000);
  assert.equal(snapshotModule.nextResyncDelayMs(9), 5000);
  assert.equal(snapshotModule.nextResyncDelayMs(10), null, 'max attempts reached');
});

// --- Harness RPC stream transports (additive, SPEC-05) --------------------------

test('harness wire client exposes the probe-proven session stream transports', async () => {
  const { createHarnessRpcWire } = require('../src/harness-rpc.js');
  const calls = [];
  const wire = createHarnessRpcWire('http://127.0.0.1:1', {
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ result: { ok: true, value: { events: [] } } }) };
    },
  });
  assert.equal(typeof wire.follow, 'function');
  assert.equal(typeof wire.page, 'function');
  assert.equal(typeof wire.control, 'function');
  assert.equal(typeof wire.cancel, 'function', 'cancel stays available (compat-proven)');
  await wire.follow('sess-1');
  await wire.page('sess-1', 42);
  await wire.control('sess-1', { op: 'ping' });
  assert.equal(calls[0].url, 'http://127.0.0.1:1/api/session.follow');
  assert.deepEqual(calls[0].body.payload, { sessionId: 'sess-1' });
  assert.equal(calls[1].url, 'http://127.0.0.1:1/api/session.page');
  assert.deepEqual(calls[1].body.payload, { sessionId: 'sess-1', throughSeq: 42 });
  assert.equal(calls[2].url, 'http://127.0.0.1:1/api/session.control');
  assert.deepEqual(calls[2].body.payload, { sessionId: 'sess-1', payload: { op: 'ping' } });
});
