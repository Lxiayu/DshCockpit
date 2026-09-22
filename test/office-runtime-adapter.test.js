'use strict';

// Task 6 / SPEC-05 — Harness Office State Adapter.
// RED: src/office/runtime/runtime-adapter.js does not exist yet.
//
// Contracts under test:
// - raw {type,seq,time,data} AND session.history-wrapped {event:{...}} both ingest
// - canonical envelope: schemaVersion/eventId/sessionId/sessionEpoch/sequence/
//   eventType/payload/sequenceSource/receivedAt
// - payload passes the shared privacy redactor BEFORE hashing; cyclic, oversized
//   and non-JSON-able payloads are rejected
// - Harness seq wins (sequenceSource=upstream); without seq the adapter hashes
//   sessionEpoch+sessionId+seq-or-empty+eventType+canonicalJson(payload) and only
//   then assigns its own counter (sequenceSource=adapter)
// - eventId/sessionEpoch are adapter-derived and marked as such (never Harness facts)
// - per (sessionId,sessionEpoch) event-ID LRU: 4096 entries, 10-minute TTL
// - sequence watermark beats duplicate hashes; last+1 applies immediately;
//   forward gaps buffer at most 64 events or 2 seconds with sync=resyncing
// - retry policy 250/500/1000ms then capped exponential, max 5 attempts, then
//   stale with the pending buffer discarded and NO guessed runtime state
// - snapshot acceptance requires request/session/epoch match, valid sequence,
//   same-epoch strictly-increasing eventsSince all > snapshot sequence
// - epoch rotation clears buffer/dedupe/watermark; old epochs cannot pollute
// - turn/end and subagent/end map by reason/stopReason; unknown -> attention
//   with the coarse reason preserved; cancel acknowledgement is never terminal
// - capability gating: only probe-proven controls are true; pause/resume are
//   forced false; Office urgent preempt is NOT a native Harness capability
// - sync=stale/resyncing never fabricate offline or terminal/runtime/local facts

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const adapterModule = require('../src/office/runtime/runtime-adapter.js');

const { createRuntimeAdapter } = adapterModule;

const T0 = 1_700_000_000_000; // fixed fake epoch ms

function createHarness() {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advance = (ms) => { nowMs += ms; };
  const build = (overrides = {}) => {
    const emitted = [];
    const messages = [];
    const adapter = createRuntimeAdapter({
      sessionId: 'sess-fixture',
      clock,
      onEvent: (output) => emitted.push(output),
      onMessage: (message) => messages.push(message),
      ...overrides,
    });
    return { adapter, emitted, messages, clock, advance };
  };
  return { build, clock, advance };
}

function raw(seq, type, data, time) {
  return { type, seq, time: time === undefined ? 1000 + seq : time, data };
}

function expectedRunProxy(rawRunId) {
  return 'run-sha256:' + crypto.createHash('sha256').update(String(rawRunId), 'utf8').digest('hex').slice(0, 16);
}

function canonicalEnvelope(sequence, epoch, sessionId, eventType, payload) {
  return {
    schemaVersion: 1,
    eventId: 'sha256:' + String(sequence % 100).padStart(2, '0').repeat(32),
    sessionId,
    sessionEpoch: epoch,
    sequence,
    eventType,
    payload,
    sequenceSource: 'upstream',
    receivedAt: new Date(T0).toISOString(),
  };
}

// --- 1. Bare and wrapped event unwrapping + canonical envelope --------------

test('bare harness events canonicalize with upstream sequence and marked epoch', () => {
  const { build } = createHarness();
  const { adapter } = build();
  const verdict = adapter.ingest(raw(17, 'tool/call', { tool: 'bash' }));
  assert.equal(verdict.status, 'accepted');
  const env = verdict.envelope;
  assert.deepEqual(Object.keys(env), [
    'schemaVersion', 'eventId', 'sessionId', 'sessionEpoch', 'sequence',
    'eventType', 'payload', 'sequenceSource', 'receivedAt',
  ]);
  assert.equal(env.schemaVersion, 1);
  assert.match(env.eventId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(env.sessionId, 'sess-fixture');
  assert.match(env.sessionEpoch, /^adapter-/);
  assert.equal(env.sequence, 17);
  assert.equal(env.eventType, 'tool/call');
  assert.deepEqual(env.payload, { tool: 'bash' });
  assert.equal(env.sequenceSource, 'upstream');
  assert.equal(env.receivedAt, new Date(T0).toISOString());
  assert.ok(Object.isFrozen(env));
});

test('session.history wrapped events ({event:{...}}) unwrap to the same envelope', () => {
  const { build } = createHarness();
  const a = build();
  const bare = a.adapter.ingest(raw(5, 'turn/end', { reason: 'completed' }));
  const b = build({ epoch: a.adapter.state().sessionEpoch });
  const wrapped = b.adapter.ingest({ event: raw(5, 'turn/end', { reason: 'completed' }) });
  assert.equal(wrapped.status, 'accepted');
  assert.equal(b.emitted.length, 1);
  assert.equal(bare.envelope.eventId, wrapped.envelope.eventId);
  assert.deepEqual(bare.envelope.payload, wrapped.envelope.payload);
  assert.equal(wrapped.envelope.sequenceSource, 'upstream');
});

test('mixed bare and wrapped delivery of the same event deduplicates to one emission', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  assert.equal(adapter.ingest(raw(3, 'agent/status', { status: 'running' })).status, 'accepted');
  assert.equal(adapter.ingest({ event: raw(3, 'agent/status', { status: 'running' }) }).status, 'duplicate');
  assert.equal(emitted.length, 1);
});

test('research-report wrapped session.history fixture replays end to end', () => {
  // Task 1 evidence: real Harness session.history may wrap events as
  // { event: { type, seq, time, data } }. Every fixture event must ingest.
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const wrappedFixture = [
    { event: { type: 'agent/status', seq: 1, time: 0, data: { status: 'idle' } } },
    { event: { type: 'tool/call', seq: 2, time: 1, data: { tool: 'bash', args: { command: 'x' } } } },
    { event: { type: 'tool/result', seq: 3, time: 2, data: { output: 'y', tokens: 42 } } },
    { event: { type: 'turn/end', seq: 4, time: 3, data: { reason: 'completed' } } },
    { event: { type: 'subagent/start', seq: 5, time: 4, data: { runId: 'run-1', id: 'sess-child', provider: 'deepseek', local: false } } },
    { event: { type: 'subagent/end', seq: 6, time: 5, data: { runId: 'run-1', stopReason: 'completed' } } },
  ];
  for (const wrapped of wrappedFixture) {
    assert.equal(adapter.ingest(wrapped).status, 'accepted');
  }
  assert.equal(emitted.length, 6);
  assert.deepEqual(emitted.map((e) => e.envelope.sequence), [1, 2, 3, 4, 5, 6]);
});

// --- 2. Privacy redaction before hashing ------------------------------------

test('payloads pass the shared privacy redactor before hashing and emission', () => {
  const { build } = createHarness();
  const { adapter } = build();
  const verdict = adapter.ingest(raw(9, 'tool/call', {
    tool: 'bash',
    apiKey: 'sk-ABCDEFGH123456',
    prompt: 'secret user prompt text',
    cwd: '/Users/someone/secret',
    tokens: 987654,
  }));
  assert.equal(verdict.status, 'accepted');
  const payload = verdict.envelope.payload;
  assert.equal(payload.apiKey, '[REDACTED:secret]');
  assert.equal(payload.prompt, '[REDACTED:text]');
  assert.equal(payload.cwd, '[REDACTED:path]');
  assert.equal(payload.tokens, '[REDACTED:token-count]');
  assert.equal(payload.tool, 'bash');
});

test('eventId is computed over the redacted payload, not the raw payload', () => {
  const { build } = createHarness();
  const first = build({ epoch: 'adapter-test-epoch' });
  first.adapter.ingest(raw(4, 'tool/result', { output: 'SECRET-ONE' }));
  const second = build({ epoch: 'adapter-test-epoch' });
  const verdict = second.adapter.ingest(raw(4, 'tool/result', { output: 'SECRET-TWO' }));
  // Both redact to { output: '[REDACTED:text]' }, so the fingerprints match.
  assert.equal(second.emitted[0].envelope.eventId, first.emitted[0].envelope.eventId);
  assert.equal(verdict.status, 'accepted');
});

// --- 3. eventId stability and epoch marking ---------------------------------

test('eventId is stable for identical input under the same injected epoch', () => {
  const { build } = createHarness();
  const a = build({ epoch: 'adapter-stable' });
  const b = build({ epoch: 'adapter-stable' });
  a.adapter.ingest(raw(11, 'user/message', { text: 'hello' }));
  b.adapter.ingest(raw(11, 'user/message', { text: 'hello' }));
  assert.equal(a.emitted[0].envelope.eventId, b.emitted[0].envelope.eventId);
});

test('eventId binds the sessionEpoch; a different epoch yields a different id', () => {
  const { build } = createHarness();
  const a = build({ epoch: 'adapter-epoch-one' });
  const b = build({ epoch: 'adapter-epoch-two' });
  a.adapter.ingest(raw(2, 'turn/start', {}));
  b.adapter.ingest(raw(2, 'turn/start', {}));
  assert.notEqual(a.emitted[0].envelope.eventId, b.emitted[0].envelope.eventId);
});

test('adapter marks eventId/sessionEpoch as adapter-derived, never Harness facts', () => {
  const { build } = createHarness();
  const { adapter } = build();
  const description = adapter.describe();
  assert.ok(description.derivedFields.includes('eventId'));
  assert.ok(description.derivedFields.includes('sessionEpoch'));
  assert.equal(description.epochPrefix, 'adapter-');
  const state = adapter.state();
  assert.match(state.sessionEpoch, /^adapter-/);
});

// --- 4. Duplicates and sequence watermark -----------------------------------

test('duplicate ingestion of the same raw event is dropped once', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  assert.equal(adapter.ingest(raw(8, 'tool/call', { tool: 'read' })).status, 'accepted');
  const again = adapter.ingest(raw(8, 'tool/call', { tool: 'read' }));
  assert.equal(again.status, 'duplicate');
  assert.equal(again.code, 'EVENT_DUPLICATE');
  assert.equal(emitted.length, 1);
});

test('watermark wins over hashes: a different payload reusing a sequence is dropped', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(6, 'tool/call', { tool: 'a' }));
  const conflicting = adapter.ingest(raw(6, 'tool/call', { tool: 'b' }));
  assert.equal(conflicting.status, 'duplicate');
  assert.equal(conflicting.code, 'STALE_SEQUENCE');
  assert.equal(emitted.length, 1);
});

test('sequences at or below the watermark never rewind it', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(2, 'tool/call', { tool: 'a' }));
  assert.equal(adapter.ingest(raw(2, 'tool/call', { tool: 'again' })).status, 'duplicate');
  assert.equal(adapter.ingest(raw(1, 'turn/start', { replay: true })).status, 'duplicate');
  assert.equal(adapter.state().watermark, 2);
  assert.equal(emitted.length, 2);
});

// --- 5. In-order application, forward gaps and buffer caps ------------------

test('last+1 applies immediately and drains the buffer in strict order', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  // forward gaps 2..5 buffered
  assert.equal(adapter.ingest(raw(4, 'tool/call', { tool: 'd' })).status, 'buffered');
  assert.equal(adapter.ingest(raw(5, 'tool/result', { output: 'e' })).status, 'buffered');
  assert.equal(adapter.state().sync, 'resyncing');
  assert.equal(adapter.state().bufferDepth, 2);
  // last+1 still applies immediately even while resyncing
  assert.equal(adapter.ingest(raw(2, 'tool/call', { tool: 'b' })).status, 'accepted');
  assert.equal(adapter.state().bufferDepth, 2);
  // the missing 3 arrives: 3 applied, 4,5 drained in order
  const verdict = adapter.ingest(raw(3, 'step/start', {}));
  assert.equal(verdict.status, 'accepted');
  assert.deepEqual(emitted.filter((e) => e.envelope).map((e) => e.envelope.sequence), [1, 2, 3, 4, 5]);
  assert.equal(adapter.state().watermark, 5);
  assert.equal(adapter.state().bufferDepth, 0);
  assert.equal(adapter.state().sync, 'healthy');
});

test('a forward gap enters resyncing and emits one office:runtime-resync-request', () => {
  const { build } = createHarness();
  const { adapter, messages } = build();
  adapter.ingest(raw(10, 'turn/start', {}));
  adapter.ingest(raw(12, 'tool/call', { tool: 'a' }));
  assert.equal(adapter.state().sync, 'resyncing');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    type: 'office:runtime-resync-request',
    requestId: messages[0].requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    fromSequence: 11,
  });
  assert.equal(typeof messages[0].requestId, 'string');
  assert.ok(messages[0].requestId.length > 0);
});

test('buffer holds at most 64 forward events; the 65th is dropped', () => {
  const { build } = createHarness();
  const { adapter } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  for (let s = 3; s <= 66; s += 1) {
    const verdict = adapter.ingest(raw(s, 'tool/call', { tool: `t${s}` }));
    assert.equal(verdict.status, 'buffered', `seq ${s}`);
  }
  const overflow = adapter.ingest(raw(67, 'tool/call', { tool: 't67' }));
  assert.equal(overflow.status, 'dropped');
  assert.equal(overflow.code, 'BUFFER_FULL');
  assert.equal(adapter.state().bufferDepth, 64);
  assert.equal(adapter.state().sync, 'resyncing');
});

test('buffered events older than 2 seconds are evicted by tick', () => {
  const { build } = createHarness();
  const { adapter, advance, messages } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' }));
  assert.equal(adapter.state().bufferDepth, 1);
  advance(1999);
  assert.equal(adapter.tick().diagnostics.length, 0);
  assert.equal(adapter.state().bufferDepth, 1);
  advance(2); // total 2001ms after buffering
  const result = adapter.tick();
  assert.ok(result.diagnostics.some((d) => d.code === 'BUFFER_EXPIRED'));
  assert.equal(adapter.state().bufferDepth, 0);
  // still resyncing: no guessed runtime state, retry cycle continues
  assert.equal(adapter.state().sync, 'resyncing');
  assert.ok(messages.length >= 1, 'resync cycle still pending');
});

// --- 6. Resync retry timeline (fake clock only) ------------------------------

test('retry timeline: 250/500/1000/2000/4000ms, 5 attempts, then stale', () => {
  const { build } = createHarness();
  const { adapter, messages, advance } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' })); // gap at t0 -> attempt 1
  assert.equal(messages.length, 1);
  const requestIds = [messages[0].requestId];

  advance(249); adapter.tick();
  assert.equal(messages.length, 1, 'no retry before 250ms');
  advance(1); adapter.tick();
  assert.equal(messages.length, 2, 'retry 1 at +250ms');
  requestIds.push(messages[1].requestId);

  advance(499); adapter.tick();
  assert.equal(messages.length, 2);
  advance(1); adapter.tick();
  assert.equal(messages.length, 3, 'retry 2 at +750ms');
  requestIds.push(messages[2].requestId);

  advance(999); adapter.tick();
  assert.equal(messages.length, 3);
  advance(1); adapter.tick();
  assert.equal(messages.length, 4, 'retry 3 at +1750ms');
  requestIds.push(messages[3].requestId);

  advance(1999); adapter.tick();
  assert.equal(messages.length, 4);
  advance(1); adapter.tick();
  assert.equal(messages.length, 5, 'retry 4 at +3750ms');
  requestIds.push(messages[4].requestId);

  advance(3999); adapter.tick();
  assert.equal(adapter.state().sync, 'resyncing', 'still waiting within the final window');
  advance(1); adapter.tick();
  assert.equal(messages.length, 5, 'max 5 attempts, no 6th request');
  assert.equal(adapter.state().sync, 'stale', 'final failure enters stale');
  assert.equal(adapter.state().bufferDepth, 0, 'pending buffer discarded on stale');
  assert.equal(adapter.state().resync, null);
  assert.deepEqual(new Set(requestIds).size, 5, 'each attempt uses a fresh requestId');
});

test('after stale no further resync requests are emitted and state is not guessed', () => {
  const { build } = createHarness();
  const { adapter, messages, advance, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' }));
  advance(60_000);
  adapter.tick(); // exhaust all attempts (tick drains every due retry)
  assert.equal(adapter.state().sync, 'stale');
  const count = messages.length;
  advance(60_000);
  adapter.tick();
  assert.equal(messages.length, count, 'stale stops the retry cycle');
  // sync transitions never fabricate runtime/activity/binding/terminal facts
  const syncFacts = emitted.filter((e) => e.facts.some((f) => f.type === 'sync/status'));
  assert.ok(syncFacts.length >= 2);
  const nonSyncFacts = emitted.flatMap((e) => e.facts).filter((f) => f.type !== 'sync/status');
  assert.deepEqual(nonSyncFacts, []);
});

test('a snapshot answering an exhausted/unknown request is rejected', () => {
  const { build } = createHarness();
  const { adapter, messages, advance } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' }));
  advance(60_000);
  adapter.tick();
  assert.equal(adapter.state().sync, 'stale');
  const late = {
    type: 'office:runtime-snapshot',
    requestId: messages[0].requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3,
    facts: {},
    eventsSince: [],
  };
  const result = adapter.acceptSnapshot(late);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PENDING_REQUEST');
});

// --- 7. Snapshot acceptance via the adapter ----------------------------------

function snapshotMessage({ requestId, sessionId, sessionEpoch, sequence, facts, eventsSince }) {
  return {
    type: 'office:runtime-snapshot',
    requestId,
    sessionId,
    sessionEpoch,
    sequence,
    facts: facts || {},
    eventsSince: eventsSince || [],
  };
}

test('valid snapshot becomes the contiguous watermark and replays the remainder', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(5, 'tool/call', { tool: 'a' })); // gap 2..4 buffered
  adapter.ingest(raw(6, 'tool/result', { output: 'r' })); // buffered
  const requestId = messages[messages.length - 1].requestId;
  const epoch = adapter.state().sessionEpoch;
  const snapshot = snapshotMessage({
    requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: epoch,
    sequence: 4,
    facts: { runtime: 'running' },
    eventsSince: [canonicalEnvelope(5, epoch, 'sess-fixture', 'tool/call', { tool: 'a' })],
  });
  const result = adapter.acceptSnapshot(snapshot);
  assert.equal(result.ok, true);
  // eventsSince 5 dedupes the locally buffered 5, then buffered 6 replays.
  assert.deepEqual(emitted.filter((e) => e.envelope).map((e) => e.envelope.sequence), [1, 5, 6]);
  assert.equal(adapter.state().watermark, 6);
  assert.equal(adapter.state().bufferDepth, 0);
  assert.equal(adapter.state().sync, 'healthy');
});

test('snapshot replays buffered events beyond the snapshot in strict order', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' }));
  adapter.ingest(raw(5, 'tool/result', { output: 'r' }));
  const requestId = messages[messages.length - 1].requestId;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId, sessionId: 'sess-fixture', sessionEpoch: adapter.state().sessionEpoch, sequence: 3,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(emitted.filter((e) => e.envelope).map((e) => e.envelope.sequence), [1, 4, 5]);
  assert.equal(adapter.state().watermark, 5);
  assert.equal(adapter.state().sync, 'healthy');
  assert.equal(adapter.state().bufferDepth, 0);
});

test('snapshot with duplicate coverage applies each sequence exactly once', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' })); // buffered locally
  const requestId = messages[messages.length - 1].requestId;
  const epoch = adapter.state().sessionEpoch;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId, sessionId: 'sess-fixture', sessionEpoch: epoch, sequence: 3,
    eventsSince: [canonicalEnvelope(4, epoch, 'sess-fixture', 'tool/call', { tool: 'a' })],
  }));
  assert.equal(result.ok, true);
  const fours = emitted.filter((e) => e.envelope && e.envelope.sequence === 4);
  assert.equal(fours.length, 1, 'buffered and eventsSince copies merge to one');
  assert.equal(adapter.state().watermark, 4);
});

test('accepted snapshot SURFACES its facts as canonical runtime facts (gap fix)', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' })); // gap
  const requestId = messages[messages.length - 1].requestId;
  emitted.length = 0;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3,
    facts: { runtime: 'running' },
  }));
  assert.equal(result.ok, true);
  // The snapshot fact must surface as an explicit canonical runtime fact.
  const factOutputs = emitted.filter((e) => e.envelope === null);
  const runtimeFacts = factOutputs.flatMap((e) => e.facts).filter((f) => f.type === 'runtime/fact');
  assert.deepEqual(runtimeFacts, [{ type: 'runtime/fact', fact: 'running' }]);
  // The carrying output must not fabricate a Harness envelope/event.
  const carrier = factOutputs.find((e) => e.facts.some((f) => f.type === 'runtime/fact'));
  assert.ok(carrier);
  assert.equal(carrier.envelope, null);
  assert.deepEqual(Object.keys(carrier).sort(), ['diagnostics', 'envelope', 'facts']);
  // Existing behavior is untouched: watermark advances by replay (3 -> 4),
  // sync heals, and the buffered sequence replays in strict order.
  assert.equal(adapter.state().watermark, 4);
  assert.equal(adapter.state().sync, 'healthy');
  assert.deepEqual(emitted.filter((e) => e.envelope).map((e) => e.envelope.sequence), [4]);
});

test('snapshot facts only map whitelisted runtime values; unknowns degrade to a stable diagnostic', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' }));
  const requestId = messages[messages.length - 1].requestId;
  emitted.length = 0;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3,
    facts: { runtime: 'sleepwalking', prompt: 'SECRET TEXT', random: { x: 1 } },
  }));
  assert.equal(result.ok, true, 'unknown facts must not invalidate the snapshot');
  const factlessOutputs = emitted.filter((e) => e.envelope === null);
  const runtimeFacts = factlessOutputs.flatMap((e) => e.facts).filter((f) => f.type === 'runtime/fact');
  assert.deepEqual(runtimeFacts, [], 'unknown runtime value never enters state');
  const diagnostics = factlessOutputs.flatMap((e) => e.diagnostics);
  assert.deepEqual(diagnostics, [
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_RUNTIME_VALUE', runtime: null },
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'prompt' },
    { code: 'SNAPSHOT_FACTS_UNSUPPORTED_KEY', key: 'random' },
  ], 'only fixed codes; the raw value never appears');
  assert.ok(!JSON.stringify(emitted).includes('sleepwalking'), 'no value echo');
  assert.ok(!JSON.stringify(emitted).includes('SECRET TEXT'), 'no raw passthrough of arbitrary fact values');
});

test('snapshot facts reject non-object facts via the shape boundary', () => {
  const { build } = createHarness();
  const { adapter, messages } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' }));
  const requestId = messages[messages.length - 1].requestId;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3,
    facts: 'not-an-object',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SNAPSHOT_FACTS_INVALID');
  assert.equal(adapter.state().sync, 'resyncing');
});

test('snapshot facts are emitted even when eventsSince is empty', () => {
  const { build } = createHarness();
  const { adapter, messages, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' })); // gap, buffered
  const requestId = messages[messages.length - 1].requestId;
  emitted.length = 0;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId,
    sessionId: 'sess-fixture',
    sessionEpoch: adapter.state().sessionEpoch,
    sequence: 3, // absorbs the buffered 3; no eventsSince needed
    facts: { runtime: 'idle' },
    eventsSince: [],
  }));
  assert.equal(result.ok, true);
  const runtimeFacts = emitted.filter((e) => e.envelope === null)
    .flatMap((e) => e.facts)
    .filter((f) => f.type === 'runtime/fact');
  assert.deepEqual(runtimeFacts, [{ type: 'runtime/fact', fact: 'idle' }]);
  assert.equal(adapter.state().watermark, 3);
  assert.equal(adapter.state().sync, 'healthy');
  assert.equal(adapter.state().bufferDepth, 0, 'no leftover events needing replay');
});

test('snapshot rejections keep the buffer and stay resyncing', () => {
  const { build } = createHarness();
  const { adapter, messages } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(4, 'tool/call', { tool: 'a' }));
  const epoch = adapter.state().sessionEpoch;
  const requestId = messages[messages.length - 1].requestId;
  const base = { requestId, sessionId: 'sess-fixture', sessionEpoch: epoch, sequence: 3 };

  const goodEventsSince = (fromSeq) => [canonicalEnvelope(fromSeq, epoch, 'sess-fixture', 'tool/call', {})];

  const cases = [
    { ...base, requestId: 'resync-stale-request', code: 'REQUEST_MISMATCH' },
    { ...base, sessionId: 'sess-other', code: 'SESSION_MISMATCH' },
    { ...base, sessionEpoch: 'adapter-old', code: 'EPOCH_MISMATCH' },
    { ...base, sequence: -1, code: 'SNAPSHOT_SEQUENCE_INVALID' },
    { ...base, sequence: 1.5, code: 'SNAPSHOT_SEQUENCE_INVALID' },
    { ...base, sequence: 0, code: 'SNAPSHOT_SEQUENCE_STALE' },
    { ...base, facts: 'nope', code: 'SNAPSHOT_FACTS_INVALID' },
    { ...base, eventsSince: 'nope', code: 'EVENTS_SINCE_INVALID' },
    { ...base, eventsSince: [...goodEventsSince(4), ...goodEventsSince(4)], code: 'EVENTS_SINCE_NOT_INCREASING' },
    { ...base, eventsSince: goodEventsSince(3), code: 'EVENTS_SINCE_BELOW_SNAPSHOT' },
  ];
  for (const message of cases) {
    const { eventsSince, code, ...rest } = message;
    const snapshot = snapshotMessage({ ...rest, eventsSince: eventsSince || [] });
    const result = adapter.acceptSnapshot(snapshot);
    assert.equal(result.ok, false, code);
    assert.equal(result.code, code);
  }
  assert.equal(adapter.state().sync, 'resyncing', 'still resyncing after rejections');
  assert.equal(adapter.state().bufferDepth, 1, 'pending buffer retained');
});

test('eventsSince from a foreign epoch is rejected whole', () => {
  const { build } = createHarness();
  const { adapter, messages } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' }));
  const requestId = messages[messages.length - 1].requestId;
  const result = adapter.acceptSnapshot(snapshotMessage({
    requestId, sessionId: 'sess-fixture', sessionEpoch: adapter.state().sessionEpoch, sequence: 2,
    eventsSince: [canonicalEnvelope(3, 'adapter-foreign', 'sess-fixture', 'tool/call', {})],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVENTS_SINCE_INVALID');
  assert.equal(adapter.state().watermark, 1, 'watermark untouched by rejected snapshot');
});

// --- 8. Epoch rotation --------------------------------------------------------

test('epoch rotation clears buffer, dedupe and watermark; new epoch is marked', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' })); // buffered
  const before = adapter.state();
  const rotation = adapter.rotateEpoch();
  assert.match(rotation.sessionEpoch, /^adapter-/);
  assert.notEqual(rotation.sessionEpoch, before.sessionEpoch);
  const after = adapter.state();
  assert.equal(after.sessionEpoch, rotation.sessionEpoch);
  assert.equal(after.bufferDepth, 0, 'old epoch buffer dropped');
  assert.equal(after.dedupeSize, 0, 'old epoch dedupe dropped');
  assert.equal(after.watermark, 0, 'old epoch watermark dropped');
  assert.equal(after.sync, 'resyncing');
  // the old buffered event must not leak into the new epoch
  assert.equal(emitted.filter((e) => e.envelope && e.envelope.sequence === 3).length, 0);
});

test('old-epoch events and snapshots cannot pollute the new epoch', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const oldEpoch = adapter.state().sessionEpoch;
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.rotateEpoch();
  // late snapshot from the old epoch
  const oldSnapshot = snapshotMessage({
    requestId: 'resync-any', sessionId: 'sess-fixture', sessionEpoch: oldEpoch, sequence: 50,
    eventsSince: [canonicalEnvelope(51, oldEpoch, 'sess-fixture', 'tool/call', {})],
  });
  const result = adapter.acceptSnapshot(oldSnapshot);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EPOCH_MISMATCH');
  assert.equal(adapter.state().watermark, 0);
  const newEpochOutputs = emitted
    .filter((e) => e.envelope)
    .filter((e) => e.envelope.sessionEpoch === adapter.state().sessionEpoch);
  assert.equal(newEpochOutputs.length, 0, 'no old-epoch event polluted the new epoch');
});

// --- 9. Adapter-sequenced events (no upstream seq) ----------------------------

test('events without seq hash first and then receive the adapter counter', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const first = adapter.ingest({ type: 'tool/call', time: 1, data: { tool: 'a' } });
  assert.equal(first.status, 'accepted');
  assert.equal(first.envelope.sequenceSource, 'adapter');
  assert.equal(first.envelope.sequence, 1);
  // identical content -> identical hash -> duplicate before a counter is spent
  const duplicate = adapter.ingest({ type: 'tool/call', time: 1, data: { tool: 'a' } });
  assert.equal(duplicate.status, 'duplicate');
  const second = adapter.ingest({ type: 'tool/call', time: 2, data: { tool: 'b' } });
  assert.equal(second.envelope.sequence, 2, 'duplicate did not consume a counter step');
  assert.equal(second.envelope.sequenceSource, 'adapter');
  assert.equal(emitted.length, 2);
});

// --- 10. 4096-entry, 10-minute event-ID LRU -----------------------------------

test('dedupe LRU refreshes on hit and evicts the least recently used beyond 4096', () => {
  const { build } = createHarness();
  const { adapter } = build();
  const noSeq = (tool) => ({ type: 'tool/call', time: 1, data: { tool } });
  for (let i = 0; i < 4096; i += 1) {
    assert.equal(adapter.ingest(noSeq(`tool-${i}`)).status, 'accepted');
  }
  assert.equal(adapter.state().dedupeSize, 4096);
  // hit refreshes recency of tool-0
  assert.equal(adapter.ingest(noSeq('tool-0')).status, 'duplicate');
  // one more insert evicts tool-1 (LRU), not tool-0 (refreshed)
  assert.equal(adapter.ingest(noSeq('tool-4096')).status, 'accepted');
  assert.equal(adapter.state().dedupeSize, 4096);
  assert.equal(adapter.ingest(noSeq('tool-1')).status, 'accepted', 'evicted entry is forgotten');
  assert.equal(adapter.ingest(noSeq('tool-0')).status, 'duplicate', 'refreshed entry survives');
});

test('dedupe LRU expires entries after the 10-minute TTL', () => {
  const { build } = createHarness();
  const { adapter, advance } = build();
  assert.equal(adapter.ingest({ type: 'tool/call', time: 1, data: { tool: 'x' } }).status, 'accepted');
  advance(600_000 - 1);
  assert.equal(adapter.ingest({ type: 'tool/call', time: 1, data: { tool: 'x' } }).status, 'duplicate');
  advance(1); // TTL reached since creation
  assert.equal(adapter.ingest({ type: 'tool/call', time: 1, data: { tool: 'x' } }).status, 'accepted');
});

// --- 11. Payload safety --------------------------------------------------------

test('cyclic payloads are rejected without emission', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const data = { tool: 'a' };
  data.self = data;
  const verdict = adapter.ingest(raw(2, 'tool/call', data));
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'PAYLOAD_NOT_SERIALIZABLE');
  assert.equal(emitted.length, 0);
});

test('non-JSON-able payloads (functions, BigInt, class instances) are rejected', () => {
  const { build } = createHarness();
  const { adapter } = build();
  assert.equal(adapter.ingest(raw(2, 'tool/call', { fn: () => {} })).code, 'PAYLOAD_NOT_SERIALIZABLE');
  assert.equal(adapter.ingest(raw(3, 'tool/call', { n: BigInt(1) })).code, 'PAYLOAD_NOT_SERIALIZABLE');
  class Weird { }
  assert.equal(adapter.ingest(raw(4, 'tool/call', { w: new Weird() })).code, 'PAYLOAD_NOT_SERIALIZABLE');
});

test('oversized payloads are rejected', () => {
  const { build } = createHarness();
  const { adapter } = build({ maxPayloadBytes: 64 });
  const verdict = adapter.ingest(raw(2, 'tool/call', { blob: 'x'.repeat(200) }));
  assert.equal(verdict.status, 'rejected');
  assert.equal(verdict.code, 'PAYLOAD_TOO_LARGE');
});

test('malformed events are rejected with stable codes', () => {
  const { build } = createHarness();
  const { adapter } = build();
  assert.equal(adapter.ingest(null).code, 'EVENT_SHAPE_INVALID');
  assert.equal(adapter.ingest('nope').code, 'EVENT_SHAPE_INVALID');
  assert.equal(adapter.ingest({ seq: 1, time: 1, data: {} }).code, 'EVENT_SHAPE_INVALID');
  assert.equal(adapter.ingest(raw(1.5, 'tool/call', {})).code, 'SEQUENCE_INVALID');
  assert.equal(adapter.ingest(raw(-1, 'tool/call', {})).code, 'SEQUENCE_INVALID');
  assert.equal(adapter.ingest({ type: 'tool/call', seq: 1, time: 'late', data: {} }).code, 'EVENT_SHAPE_INVALID');
  assert.equal(adapter.ingest({ event: null }).code, 'EVENT_SHAPE_INVALID');
});

// --- 12. Runtime mapping -------------------------------------------------------

test('agent/status maps running, and idle only when no subagent activity is open', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'agent/status', { status: 'running' }));
  assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/fact', fact: 'running' }]);

  adapter.ingest(raw(2, 'subagent/start', { runId: 'run-1', id: 'sess-child', provider: 'deepseek' }));
  const startFact = emitted.at(-1).facts[0];
  assert.equal(startFact.type, 'runtime/subagent-start');
  assert.match(startFact.runId, /^run-sha256:[0-9a-f]{16}$/, 'start fact carries the redacted run proxy');
  assert.equal(startFact.runId, expectedRunProxy('run-1'));
  assert.ok(!JSON.stringify(startFact).includes('run-1'), 'raw runId never leaks into facts');
  const idleSuppressed = adapter.ingest(raw(3, 'agent/status', { status: 'idle' }));
  assert.equal(idleSuppressed.status, 'accepted');
  assert.ok(idleSuppressed.diagnostics.some((d) => d.code === 'IDLE_SUPPRESSED_ACTIVE_SUBAGENTS'));
  assert.equal(emitted.at(-1).facts.length, 0, 'idle is not mapped while a subagent is open');

  adapter.ingest(raw(4, 'subagent/end', { runId: 'run-1', stopReason: 'completed' }));
  adapter.ingest(raw(5, 'agent/status', { status: 'idle' }));
  assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/fact', fact: 'idle' }]);
});

test('subagent runId pairing uses one stable redacted proxy across start and end', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'subagent/start', { runId: 'run-private-9', id: 'sess-child', provider: 'deepseek' }));
  adapter.ingest(raw(2, 'subagent/end', { runId: 'run-private-9', stopReason: 'completed' }));
  const facts = emitted.flatMap((e) => e.facts);
  const start = facts.find((f) => f.type === 'runtime/subagent-start');
  const end = facts.find((f) => f.type === 'runtime/subagent-end');
  assert.equal(start.runId, end.runId, 'stable proxy pairs start and end');
  assert.match(start.runId, /^run-sha256:[0-9a-f]{16}$/);
  assert.equal(start.runId, expectedRunProxy('run-private-9'));
  // The proxy is deterministic across adapters in the same epoch.
  const { adapter: second, emitted: otherEmitted } = build({ epoch: adapter.state().sessionEpoch });
  second.ingest(raw(1, 'subagent/start', { runId: 'run-private-9', id: 'sess-child', provider: 'deepseek' }));
  const otherStart = otherEmitted.flatMap((e) => e.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(otherStart.runId, start.runId);
  assert.ok(!JSON.stringify(otherEmitted).includes('run-private-9'));
});

test('unpairable runIds fail closed: no open-run tracking, end carries null proxy', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  // Prose/whitespace runIds fail closed: they never enter activeRuns.
  adapter.ingest(raw(1, 'subagent/start', { runId: 'has spaces', id: 'sess-child', provider: 'deepseek' }));
  const start = emitted.flatMap((e) => e.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(start.runId, null);
  const idle = adapter.ingest(raw(2, 'agent/status', { status: 'idle' }));
  assert.equal(idle.diagnostics.length, 0, 'no open run is tracked for a failed proxy');
  assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/fact', fact: 'idle' }]);
});

test('turn/end maps by reason including attention fallback with coarse reason', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const cases = [
    ['completed', { type: 'runtime/fact', fact: 'completed', reason: 'completed' }],
    ['error', { type: 'runtime/fact', fact: 'failed', reason: 'error' }],
    ['failed', { type: 'runtime/fact', fact: 'failed', reason: 'failed' }],
    ['blocked', { type: 'runtime/fact', fact: 'attention', reason: 'blocked' }],
  ];
  let seq = 0;
  for (const [reason, expected] of cases) {
    seq += 1;
    emitted.length = 0;
    adapter.ingest(raw(seq, 'turn/end', { reason }));
    assert.deepEqual(emitted.at(-1).facts, [expected], reason);
  }
  // aborted/interrupted/cancelled are cancellation terminal evidence
  for (const reason of ['aborted', 'interrupted', 'cancelled']) {
    seq += 1;
    emitted.length = 0;
    adapter.ingest(raw(seq, 'turn/end', { reason }));
    assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/cancelled', evidence: `turn/end:${reason}` }], reason);
  }
  // unknown reasons: attention + coarse reason preserved (e.g. proven max-tokens)
  for (const reason of ['max-tokens', 'wombat']) {
    seq += 1;
    emitted.length = 0;
    adapter.ingest(raw(seq, 'turn/end', { reason }));
    assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/fact', fact: 'attention', reason }], reason);
  }
  seq += 1;
  emitted.length = 0;
  adapter.ingest(raw(seq, 'turn/end', {}));
  assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/fact', fact: 'attention', reason: null }]);
});

test('subagent/end maps by stopReason, never by event type alone', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'subagent/start', { runId: 'run-1', id: 'child-a', provider: 'deepseek' }));
  const expect = [
    ['completed', 'completed', true],
    ['error', 'failed', true],
    ['failed', 'failed', true],
    ['aborted', 'cancelled', true],
    ['interrupted', 'cancelled', true],
    ['blocked', 'attention', false],
    ['mystery', 'attention', false],
  ];
  let seq = 1;
  for (const [stopReason, outcome, terminal] of expect) {
    seq += 1;
    emitted.length = 0;
    adapter.ingest(raw(seq, 'subagent/end', { runId: 'run-1', stopReason }));
    const fact = emitted.at(-1).facts[0];
    assert.equal(fact.type, 'runtime/subagent-end', stopReason);
    assert.equal(fact.outcome, outcome, stopReason);
    assert.equal(fact.terminal, terminal, stopReason);
    assert.equal(fact.stopReason, stopReason, 'coarse stop reason preserved');
    // runId is a redacted pairing proxy, never the raw Harness runId.
    assert.match(fact.runId, /^run-sha256:[0-9a-f]{16}$/);
    assert.equal(fact.runId, expectedRunProxy('run-1'));
    assert.ok(!JSON.stringify(fact).includes('run-1'));
    // re-open for the next case
    if (terminal) {
      seq += 1;
      adapter.ingest(raw(seq, 'subagent/start', { runId: 'run-1', id: 'child-a', provider: 'deepseek' }));
    }
  }
});

test('tool/call maps to a coarse runtime tool fact', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'tool/call', { tool: 'bash', args: { command: 'ls' } }));
  assert.deepEqual(emitted.at(-1).facts, [{ type: 'runtime/tool', tool: 'bash' }]);
});

test('unmapped harness event types still canonicalize without invented facts', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  const verdict = adapter.ingest(raw(1, 'assistant/chunk', { text: 'hello world' }));
  assert.equal(verdict.status, 'accepted');
  assert.deepEqual(emitted.at(-1).facts, []);
  assert.equal(verdict.envelope.eventType, 'assistant/chunk');
});

// --- 13. Cancel acknowledgement and control gating -----------------------------

test('cancel acknowledgement only produces awaiting evidence, never a release', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  const result = adapter.noteCancelAcknowledged();
  assert.equal(result.ok, true);
  const facts = emitted.flatMap((e) => e.facts);
  assert.deepEqual(facts.at(-1), { type: 'control/cancel-ack' });
  const factTypes = facts.map((f) => f.type);
  assert.ok(!factTypes.includes('runtime/cancelled'), 'ack is not terminal evidence');
  assert.ok(!factTypes.includes('binding/released'), 'ack never releases a binding');
});

test('proven controls dispatch; unproven pause/resume/preempt are hard-rejected', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  for (const control of ['cancel', 'interrupt', 'followup', 'steer', 'inject']) {
    const result = adapter.requestControl({ control });
    assert.equal(result.ok, true, control);
  }
  assert.deepEqual(
    emitted.flatMap((e) => e.facts).filter((f) => f.type === 'send-control').map((f) => f.control),
    ['cancel', 'interrupt', 'followup', 'steer', 'inject'],
  );
  for (const control of ['pause', 'resume', 'preempt']) {
    const result = adapter.requestControl({ control });
    assert.equal(result.ok, false, control);
    assert.equal(result.code, 'CONTROL_UNSUPPORTED', control);
  }
  assert.equal(emitted.flatMap((e) => e.facts).filter((f) => f.type === 'send-control' && f.control === 'pause').length, 0);
});

test('capability matrix: probe-proven controls true, pause/resume forced false', () => {
  const { build } = createHarness();
  const { adapter } = build({ runtimeVersion: '0.1.2-alpha.1', capabilities: { pause: true, resume: true, cancel: true } });
  const capability = adapter.capability();
  assert.equal(capability.adapterVersion, adapterModule.ADAPTER_VERSION);
  assert.equal(capability.runtimeVersion, '0.1.2-alpha.1');
  assert.deepEqual(capability.supports, {
    cancel: true, interrupt: true, followup: true, steer: true, inject: true,
    pause: false, resume: false,
  });
  assert.equal(capability.terminalEvidence, true);
});

test('capability degradation: proven controls can be disabled by probe overrides', () => {
  const { build } = createHarness();
  const { adapter } = build({ capabilities: { steer: false } });
  assert.equal(adapter.capability().supports.steer, false);
  assert.equal(adapter.requestControl({ control: 'steer' }).ok, false);
  assert.equal(adapter.requestControl({ control: 'cancel' }).ok, true);
});

// --- 14. Cross-module integration (Task 6 adapter -> Task 5 registry) -----------
// Chosen plan (b) contract:
//   Adapter emits `runtime/subagent-start|end` facts whose `runId` is the
//   adapter-owned `run-sha256:<16hex>` proxy. Task-5's registry receives that
//   proxy verbatim (opaque technical handle); raw Harness runIds never reach
//   the registry.
//   `deriveRunProxy` is the sole controlled mapping for outside consumers
//   that still hold a raw id (e.g. wiring-layer snapshot composition).
//
// Two integration paths are asserted here:
//   (i)  Adapter-only: natural end-to-end flow of raw Harness events through
//        the adapter proves start/end pairing uses the same proxy and no raw
//        id leaks into facts.
//   (ii) Cross-module bridge: simulated wiring-layer code extracts the proxy
//        from the raw envelope once via `deriveRunProxy`, registers the child
//        with the registry using the proxy, and then terminal-evidences the
//        adapter's `runtime/subagent-end` fact against it — the entire chain
//        must match without any raw id, epoch boundary or collision.

test('cross-module: adapter facts pair with registry via the proxy only (plan b)', () => {
  const registryModule = require('../src/office/runtime/employee-registry.js');
  const { deriveRunProxy } = adapterModule;
  const { build } = createHarness();
  const { adapter, emitted } = build({ sessionId: 'sess-parent' });
  const registry = registryModule.createEmployeeRegistry({ clock: { nowMs: () => T0 } });

  // Adapter sees the raw Harness envelope; facts carry the proxy only.
  adapter.ingest(raw(1, 'turn/start', {})); // parent binding anchor
  const subStartRaw = raw(2, 'subagent/start', {
    runId: 'run-private-parent-1', id: 'sess-child-x', provider: 'deepseek', local: false,
  });
  adapter.ingest(subStartRaw);
  const startFact = emitted.flatMap((e) => e.facts).find((f) => f.type === 'runtime/subagent-start');
  const childHandle = startFact.runId;
  assert.match(childHandle, /^run-sha256:[0-9a-f]{16}$/);
  assert.notEqual(childHandle, 'run-private-parent-1');

  // Wiring-layer pattern: given a raw child id (e.g. from Harness history),
  // derive the proxy once. Then bind a parent session and register the child
  // with the registry using ONLY the proxy as the run handle.
  const proxyForRegistry = deriveRunProxy('run-private-parent-1');
  assert.equal(proxyForRegistry, childHandle, 'deriveRunProxy is the same mapping the adapter uses');
  assert.equal(registry.bindRootSession({ sessionId: 'sess-parent', nowMs: 0 }).ok, true);
  assert.equal(registry.registerChildSession({
    parentSessionId: 'sess-parent',
    childSessionId: 'sess-child-x',
    runId: proxyForRegistry,
    nowMs: 1,
  }).ok, true);

  // A second adapter observes the same raw harness envelope and produces the
  // SAME proxy — deterministic mapping, epoch-safe.
  const { adapter: secondAdapter, emitted: secondEmitted } = build({ epoch: adapter.state().sessionEpoch });
  secondAdapter.ingest(subStartRaw);
  const secondStart = secondEmitted.flatMap((e) => e.facts).find((f) => f.type === 'runtime/subagent-start');
  assert.equal(secondStart.runId, childHandle, 'epoch-stable: any adapter seeing the same raw id emits the same proxy');

  // Terminal evidence end-to-end: adapter ingests subagent/end (raw), emits a
  // `runtime/subagent-end` fact with the proxy; the registry accepts the proxy
  // for terminal release without ever touching the raw id.
  adapter.ingest(raw(3, 'subagent/end', { runId: 'run-private-parent-1', stopReason: 'completed' }));
  const endFact = emitted.flatMap((e) => e.facts).find((f) => f.type === 'runtime/subagent-end');
  assert.equal(endFact.runId, childHandle);
  assert.equal(endFact.terminal, true);
  assert.equal(endFact.outcome, 'completed');

  // The raw id never appears anywhere in the adapter's emitted facts.
  const factBlob = JSON.stringify(emitted);
  assert.ok(!factBlob.includes('run-private-parent-1'), 'raw runId must never leak into facts');

  // Registry-side validation: bind the child session to a seat (Task-5's
  // binding model — the registry itself holds the binding). A mismatched
  // proxy must never release the binding (fail-closed); the CORRECT proxy
  // releases it. This is the same verifyRunId path Task 5 exercises with raw
  // ids, now flowing through the adapter's proxy.
  assert.equal(registry.bindSession({
    employeeId: 'coder',
    sessionId: 'sess-child-x',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 2,
  }).ok, true);
  const bogus = registry.subagentEnd({ sessionId: 'sess-child-x', runId: 'run-sha256:0000000000000000', stopReason: 'completed', terminalEvidence: true, nowMs: 3 });
  assert.equal(bogus.ok, false);
  assert.equal(bogus.code, 'RUN_ID_MISMATCH');

  // Registry releases when the SAME proxy is presented (Task-5's documented
  // fail-closed path now flows over the adapter's proxy).
  const registryRelease = registry.subagentEnd({ sessionId: 'sess-child-x', runId: proxyForRegistry, stopReason: 'completed', terminalEvidence: true, nowMs: 4 });
  assert.equal(registryRelease.ok, true);
  assert.equal(registryRelease.released, true);
  assert.equal(registryRelease.binding.lastEvidence, 'subagent/end:completed');
  assert.equal(registryRelease.binding.lastOutcome, 'completed');
  // The childSessions record preserves the derived proxy, never the raw id.
  const snapshotAfter = registry.snapshot();
  const proxyRecord = snapshotAfter.childSessions.find((r) => r.childSessionId === 'sess-child-x');
  assert.equal(proxyRecord.runId, proxyForRegistry);
  assert.ok(!JSON.stringify(snapshotAfter).includes('run-private-parent-1'), 'registry persistence carries proxy only');
});

test('deriveRunProxy is the only mapping: it is deterministic, epoch-safe, fail-closed', () => {
  const { deriveRunProxy } = adapterModule;
  // Deterministic.
  assert.equal(deriveRunProxy('run-abc'), deriveRunProxy('run-abc'));
  // Distinct inputs never collide in the practical id-space.
  assert.notEqual(deriveRunProxy('run-a'), deriveRunProxy('run-b'));
  assert.match(deriveRunProxy('run-a'), /^run-sha256:[0-9a-f]{16}$/);
  // Epoch-safe: the raw input is all that feeds the hash (no epoch/sessionId
  // mixing) — the same harness runId yields the same proxy regardless of the
  // adapter's current epoch, which is exactly what Task-5 needs.
  assert.equal(deriveRunProxy('run-epoch-test'), deriveRunProxy('run-epoch-test'));
  // Fail-closed cases.
  assert.equal(deriveRunProxy(null), null);
  assert.equal(deriveRunProxy(undefined), null);
  assert.equal(deriveRunProxy(''), null);
  assert.equal(deriveRunProxy('has spaces'), null);
  assert.equal(deriveRunProxy('sk-ABCDEFGHIJKLMN'), null);
  assert.equal(deriveRunProxy('x'.repeat(256)), null);
});

test('wiring-layer safety: proxy is stored verbatim and never maps back to raw id', () => {
  const { deriveRunProxy } = adapterModule;
  const registryModule = require('../src/office/runtime/employee-registry.js');
  const registry = registryModule.createEmployeeRegistry({ clock: { nowMs: () => T0 } });
  const handle = deriveRunProxy('run-hidden');
  assert.equal(registry.bindRootSession({ sessionId: 'sess-parent', nowMs: 0 }).ok, true);
  assert.equal(registry.registerChildSession({
    parentSessionId: 'sess-parent',
    childSessionId: 'sess-x',
    runId: handle,
    nowMs: 1,
  }).ok, true);
  // Registry never sees the raw id.
  const snapshot = registry.snapshot();
  const blob = JSON.stringify(snapshot);
  assert.ok(blob.includes(handle));
  assert.ok(!blob.includes('run-hidden'), 'registry persistence carries proxy only');
});

// --- 15. Sync purity -----------------------------------------------------------

test('resyncing and stale never fabricate offline or terminal states', () => {
  const { build } = createHarness();
  const { adapter, emitted, advance } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' })); // resyncing
  assert.equal(adapter.state().sync, 'resyncing');
  advance(60_000);
  adapter.tick(); // stale
  const allFacts = emitted.flatMap((e) => e.facts);
  const factTypes = new Set(allFacts.map((f) => f.type));
  assert.ok(factTypes.has('sync/status'));
  for (const forbidden of ['offline', 'runtime/fact', 'runtime/cancelled', 'runtime/tool', 'local/activity']) {
    assert.ok(!allFacts.some((f) => f.fact === forbidden || f.type === forbidden || f.activity === forbidden), forbidden);
  }
  const syncValues = allFacts.filter((f) => f.type === 'sync/status').map((f) => f.sync);
  assert.deepEqual(syncValues, ['resyncing', 'stale']);
});

test('buffer drain back to healthy emits the sync recovery fact', () => {
  const { build } = createHarness();
  const { adapter, emitted } = build();
  adapter.ingest(raw(1, 'turn/start', {}));
  adapter.ingest(raw(3, 'tool/call', { tool: 'a' }));
  adapter.ingest(raw(2, 'step/start', {}));
  const syncValues = emitted.flatMap((e) => e.facts).filter((f) => f.type === 'sync/status').map((f) => f.sync);
  assert.deepEqual(syncValues, ['resyncing', 'healthy']);
  assert.equal(adapter.state().sync, 'healthy');
});

test('adapter state reports watermark, buffers and retry bookkeeping', () => {
  const { build } = createHarness();
  const { adapter } = build();
  const state = adapter.state();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.sessionId, 'sess-fixture');
  assert.equal(state.sync, 'healthy');
  assert.equal(state.watermark, 0);
  assert.equal(state.bufferDepth, 0);
  assert.equal(state.dedupeSize, 0);
  assert.equal(state.resync, null);
});
