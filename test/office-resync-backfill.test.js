'use strict';

// test/office-resync-backfill.test.js — 2026-09-24 office resync backfill fix.
//
// User-reported symptom (first-hand): after one normal conversation completed,
// the dispatcher stayed on 「工作中·任务执行中」 and the panel showed
// 「同步滞后」 forever. Root cause: a forward seq gap (a follow stream re-open
// whose opening window starts above the adapter's watermark, or a dropped
// journal record) buffered the tail and raised a DshCockpit-internal
// office:runtime-resync-request that NOTHING answered — five attempts later
// the adapter went sync=stale, and the contract ("sync changes only; never
// guess runtime/activity/binding/terminal state") froze the employee on its
// last known phase.
//
// These tests use the REAL office module (real runtime adapters inside) and
// pin the fix end to end:
//   1. a forward gap is healed by the re-read answer (sync back to healthy)
//      and the employee completes the turn (result presentation → idle),
//      never stuck at working/执行任务中;
//   2. the same healing works AFTER the retry timeline exhausted — the exact
//      user-visible stale state;
//   3. a follow re-open whose opening window jumps the watermark is handled
//      as a stream-restart BASELINE: no gap, no resync request, healthy sync;
//   4. buffered events follow the contract: replayed exactly once, in order,
//      never silently dropped (a rejected mid-chain record is diagnosed and
//      the tail keeps its facts);
//   5. the shell log carries the sync/resync transitions (the observability
//      half of the fix — the log used to show nothing at all).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const officeLayout = require('../src/office/runtime/office-layout.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

function makeModule() {
  const logLines = [];
  const resyncRequests = [];
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-resync-backfill-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: (line) => logLines.push(line),
    onResyncRequest: ({ sessionId, request }) => {
      resyncRequests.push({ sessionId, ...request });
    },
  });
  return { module, logLines, resyncRequests };
}

function emp(state, id = 'orchestrator') {
  return state.employees.find((candidate) => candidate.employeeId === id);
}

function tickFor(module, ms) {
  const steps = Math.round(ms / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) module.tickOnce();
}

function tickUntil(module, predicate, maxMs = 240000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    if (predicate(module.state())) return true;
  }
  return false;
}

/** One durable journal record in the exact session/follow + session/page
 * shape ({type:'event', event:{type,seq,time,data}}). */
function journalRecord(seq, type, data) {
  return { type: 'event', event: { type, seq, time: 1000 + seq, data } };
}

/** Park the employee away from the desk, run a turn to the work phase, and
 * return the module-state employee (the 「工作中·任务执行中」 symptom state). */
function runUntilWorking(module, sessionId) {
  const roamNodes = module.layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id));
  assert.equal(tickUntil(module, (state) => {
    const employee = emp(state);
    return employee
      && employee.movement === 'stationary'
      && roamNodes.some((node) => Math.hypot(employee.position.x - node.position.x, employee.position.y - node.position.y) < 0.02);
  }), true, 'orchestrator dwells at a roaming node before the task starts');
  assert.equal(module.ingestHarnessEvent({
    sessionId, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' },
  }).status, 'accepted');
  assert.equal(tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.transition && employee.transition.kind === 'task-start' && employee.transition.phase === 'work';
  }), true, 'the employee reaches the work phase');
  const working = emp(module.state());
  assert.equal(working.runtime, 'running');
  assert.equal(working.activity, 'working');
  assert.equal(working.taskLabel, '执行任务中');
  return working;
}

/** After a healed turn: the result presentation runs, the employee stands,
 * leaves and returns to idle/roaming — never stuck at 执行任务中. */
function assertTurnCompleted(module, label) {
  assert.equal(tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.transition && employee.transition.kind === 'task-end' && employee.transition.phase === 'result';
  }), true, `${label}: the result presentation starts`);
  assert.equal(tickUntil(module, (state) => emp(state).transition === null), true,
    `${label}: the leave transition completes and releases`);
  const done = emp(module.state());
  assert.equal(done.lastResult && done.lastResult.outcome, 'completed', `${label}: completed result recorded`);
  assert.equal(done.taskLabel, null, `${label}: 任务执行中 label cleared`);
  assert.notEqual(done.activity, 'working', `${label}: no longer 工作中`);
  assert.notEqual(done.runtime, 'running', `${label}: runtime is no longer running`);
}

// ---------------------------------------------------------------------------
// 1. The reported symptom: forward gap → resync request → answer → healed
// ---------------------------------------------------------------------------

test('a forward seq gap is healed by the re-read answer and the employee completes the turn', () => {
  const { module, logLines, resyncRequests } = makeModule();
  const sessionId = 'gap-1';
  runUntilWorking(module, sessionId);
  module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash' } });

  // The turn/end arrives with a HOLE before it (journal seqs 3..4 lost with
  // the stream): the adapter buffers it and asks for a baseline.
  const buffered = module.ingestHarnessEvent({
    sessionId, type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' },
  });
  assert.equal(buffered.status, 'buffered', 'the gapped event is buffered, never dropped');
  assert.equal(resyncRequests.length, 1, 'the adapter asked for a baseline exactly once');
  assert.equal(resyncRequests[0].type, 'office:runtime-resync-request');
  assert.equal(resyncRequests[0].sessionId, sessionId);
  assert.equal(resyncRequests[0].fromSequence, 3, 'the request asks from the watermark+1');
  const stuck = emp(module.state());
  assert.equal(stuck.sync, 'resyncing', 'the panel shows 同步滞后 while the gap is open');
  assert.equal(stuck.runtime, 'running', 'the employee is still 工作中 — the symptom state');

  // main.js's answer: the durable-log re-read returns the missing records
  // (seq 3..4) plus the buffered turn/end (seq 5).
  const answer = module.ingestHarnessSnapshot({
    sessionId,
    records: [
      journalRecord(3, 'tool/call', { tool: 'read' }),
      journalRecord(4, 'turn/usage', { turn: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
      journalRecord(5, 'turn/end', { reason: 'completed' }),
    ],
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'continuation', 'the re-read reached the gap: it continues the watermark');
  assert.equal(answer.sync, 'healthy', 'sync is healed');
  assert.equal(emp(module.state()).sync, 'healthy');
  assert.equal(answer.replayed, 2, 'the two missing records applied');
  assert.equal(answer.duplicate, 1, 'the buffered turn/end deduped against its re-read copy (exactly once)');

  // ③ buffered events follow the contract: the buffered turn/end was replayed
  // exactly once (its terminal evidence landed) and the watermark advanced.
  const healed = emp(module.state());
  assert.equal(healed.lastResult && healed.lastResult.outcome, 'completed', 'the buffered turn/end was applied');
  assert.equal(module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 6, time: 6, data: { tool: 'read' } }).status,
    'accepted', 'the watermark advanced past the replayed tail');
  assert.equal(module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } }).status,
    'duplicate', 'a re-delivered replayed event dedupes (never double-applied)');

  // ② the employee is no longer stuck at 工作中·任务执行中.
  assertTurnCompleted(module, 'gap heal');
  assert.equal(module.state().sync, 'healthy');

  // ⑤ observability: the sync transitions and the answer are in the log.
  assert.equal(logLines.some((line) => /\[office\] sync resyncing \(gap-1/.test(line)), true);
  assert.equal(logLines.some((line) => /\[office\] sync healthy \(gap-1/.test(line)), true);
  assert.equal(logLines.some((line) => /\[office\] resync continuation applied \(gap-1/.test(line)), true);
});

// ---------------------------------------------------------------------------
// 2. The same healing AFTER the retry timeline exhausted (the user-visible
//    stale state: 同步滞后 forever + frozen employee)
// ---------------------------------------------------------------------------

test('a late answer heals an exhausted (stale) adapter and completes the employee turn', () => {
  const { module, logLines, resyncRequests } = makeModule();
  const sessionId = 'stale-2';
  runUntilWorking(module, sessionId);
  module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash' } });
  module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } });

  // The shell never answered (mux down): the retry timeline (250ms…5s, 5
  // attempts ≈ 7.75s of module time) exhausts and the adapter goes stale.
  tickFor(module, 9_000);
  assert.equal(module.state().sync, 'stale', 'the reported 同步滞后 state');
  const frozen = emp(module.state());
  assert.equal(frozen.runtime, 'running', 'the employee is frozen on its last known phase');
  assert.equal(frozen.activity, 'working');
  assert.equal(frozen.taskLabel, '执行任务中');
  assert.equal(resyncRequests.length > 1, true, 'the adapter re-asked across the retry timeline');
  assert.equal(logLines.some((line) => /\[office\] sync stale \(stale-2, attempts=5/.test(line)), true,
    'the stale transition is logged with its attempt count');

  // The mux comes back and the shell answers with the re-read.
  const answer = module.ingestHarnessSnapshot({
    sessionId,
    records: [
      journalRecord(3, 'tool/call', { tool: 'read' }),
      journalRecord(4, 'turn/usage', { turn: 1, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
      journalRecord(5, 'turn/end', { reason: 'completed' }),
    ],
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'baseline', 'a stale adapter restarts from the baseline (rotateEpoch is its reset)');
  assert.equal(answer.sync, 'healthy', 'sync recovers from stale');
  assert.equal(module.state().sync, 'healthy');
  assert.equal(emp(module.state()).lastResult && emp(module.state()).lastResult.outcome, 'completed');
  assertTurnCompleted(module, 'stale heal');
  assert.equal(module.state().sync, 'healthy');
  assert.equal(logLines.some((line) => /\[office\] resync baseline applied \(stale-2/.test(line)), true);
});

// ---------------------------------------------------------------------------
// 3. Follow re-open: the opening window jumps the watermark → baseline, no gap
// ---------------------------------------------------------------------------

test('a follow re-open whose opening window jumps the watermark restarts from a baseline (no gap, no resync)', () => {
  const { module, logLines, resyncRequests } = makeModule();
  const sessionId = 'reopen-3';
  runUntilWorking(module, sessionId);
  assert.equal(resyncRequests.length, 0);

  // The mux reconnected (or the host ended the stream): the follow stream
  // re-opened and delivered a fresh opening window whose first record sits
  // ABOVE the adapter watermark (seq 3 > watermark 2). Feeding it as an
  // increment — the old shell behavior — manufactured the gap this fix
  // removes; as a baseline it simply continues the office state.
  const window = [
    journalRecord(3, 'tool/call', { tool: 'read' }),
    journalRecord(4, 'turn/end', { reason: 'completed' }),
  ];
  const answer = module.ingestHarnessSnapshot({ sessionId, records: window });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'baseline');
  assert.equal(answer.sync, 'healthy');
  assert.equal(resyncRequests.length, 0, 'no resync request reaches the shell: the module answered its own rotation');
  assert.equal(module.state().sync, 'healthy');
  assert.equal(answer.diagnostics.includes('RESYNC_REQUESTED'), false,
    'the baseline restart never opens a resync cycle');
  assert.equal(emp(module.state()).lastResult && emp(module.state()).lastResult.outcome, 'completed');
  assertTurnCompleted(module, 'reopen baseline');
  assert.equal(logLines.some((line) => /\[office\] resync baseline applied \(reopen-3/.test(line)), true);

  // The live stream continues after the window: gap-free by contract.
  assert.equal(module.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } }).status,
    'accepted', 'live events after the re-opened window flow without a gap');
  assert.equal(module.state().sync, 'healthy');
});

// ---------------------------------------------------------------------------
// 4. Contract honesty: buffered/replayed events, partial baselines, rejected
//    mid-chain records — nothing is silently dropped
// ---------------------------------------------------------------------------

test('buffered events are replayed exactly once, in order, through the continuation answer', () => {
  const { module, resyncRequests } = makeModule();
  const sessionId = 'buffer-4';
  runUntilWorking(module, sessionId);
  module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash' } });
  // Two events buffer behind the gap; the turn/end is the LAST of them.
  assert.equal(module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 4, time: 4, data: { tool: 'read' } }).status, 'buffered');
  assert.equal(module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } }).status, 'buffered');
  assert.equal(resyncRequests.length, 1);

  const answer = module.ingestHarnessSnapshot({
    sessionId,
    records: [
      journalRecord(3, 'tool/call', { tool: 'grep' }),
      journalRecord(4, 'tool/call', { tool: 'read' }),
      journalRecord(5, 'turn/end', { reason: 'completed' }),
    ],
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.replayed, 1, 'only the record the gap actually missed applies');
  assert.equal(answer.duplicate, 2, 'the two buffered events dedupe against their re-read copies');
  assert.equal(answer.watermark, 5, 'the watermark lands on the last replayed seq');
  assert.equal(answer.sync, 'healthy');
  // The replayed tool facts reached the employee (the last tool in order).
  assert.equal(emp(module.state()).toolKind, 'read');
  assert.equal(emp(module.state()).lastResult && emp(module.state()).lastResult.outcome, 'completed');
  assertTurnCompleted(module, 'buffer drain');
});

test('a re-read that cannot reach the gap start adopts a partial baseline and diagnoses it', () => {
  const { module, resyncRequests } = makeModule();
  const sessionId = 'partial-5';
  runUntilWorking(module, sessionId);
  module.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash' } });
  module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } });
  assert.equal(resyncRequests.length, 1);

  // The log start (or the page bound) was reached before the gap: the re-read
  // only covers seq 5..6. The baseline supersedes the unreachable 3..4.
  const answer = module.ingestHarnessSnapshot({
    sessionId,
    records: [
      journalRecord(5, 'turn/end', { reason: 'completed' }),
      journalRecord(6, 'agent/status', { status: 'running' }),
    ],
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'baseline');
  assert.equal(answer.sync, 'healthy', 'the office still recovers to healthy');
  assert.equal(answer.diagnostics.includes('RESYNC_BASELINE_PARTIAL'), true,
    'the superseded range is diagnosed, never silent');
  assert.equal(emp(module.state()).lastResult && emp(module.state()).lastResult.outcome, 'completed');
});

test('a rejected mid-chain record is diagnosed and the replay tail keeps its facts', () => {
  const { module, resyncRequests } = makeModule();
  const sessionId = 'reject-6';
  runUntilWorking(module, sessionId);
  module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 6, time: 6, data: { reason: 'completed' } });
  assert.equal(resyncRequests.length, 1);

  // A record over the adapter's 64KB payload cap breaks the chain; the fix
  // rotates once more so the floor absorbs the rejected seq and the tail
  // (including the turn/end) still replays. The rejection is diagnosed.
  const huge = 'x'.repeat(70 * 1024);
  const answer = module.ingestHarnessSnapshot({
    sessionId,
    records: [
      journalRecord(3, 'tool/call', { tool: 'bash' }),
      journalRecord(4, 'note/oversize', { text: huge }),
      journalRecord(5, 'turn/end', { reason: 'completed' }),
    ],
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.mode, 'baseline');
  assert.equal(answer.rejected, 1, 'the over-cap record is counted as rejected');
  assert.equal(answer.sync, 'healthy');
  assert.equal(answer.diagnostics.includes('RESYNC_REPLAY_PAYLOAD_TOO_LARGE'), true,
    'the rejected record is diagnosed with its adapter code');
  assert.equal(emp(module.state()).lastResult && emp(module.state()).lastResult.outcome, 'completed',
    'the tail past the rejected record still applied');
  assertTurnCompleted(module, 'rejected mid-chain');
});

// ---------------------------------------------------------------------------
// 5. Module boundary validation
// ---------------------------------------------------------------------------

test('ingestHarnessSnapshot refuses malformed requests and records without touching state', () => {
  const { module, resyncRequests } = makeModule();
  const sessionId = 'invalid-7';
  runUntilWorking(module, sessionId);
  const before = emp(module.state());
  assert.equal(module.ingestHarnessSnapshot(null).code, 'REQUEST_INVALID');
  assert.equal(module.ingestHarnessSnapshot({ sessionId: '' }).code, 'REQUEST_INVALID');
  assert.equal(module.ingestHarnessSnapshot({ sessionId, records: 'nope' }).code, 'RECORDS_INVALID');
  assert.equal(module.ingestHarnessSnapshot({ sessionId, records: [{ type: 'event', event: { type: 'x' } }] }).code,
    'RECORDS_INVALID', 'a record without a valid seq refuses the whole window');
  assert.equal(module.ingestHarnessSnapshot({ sessionId, records: [] }).code, 'RECORDS_EMPTY');
  assert.equal(resyncRequests.length, 0);
  const after = emp(module.state());
  assert.equal(after.runtime, before.runtime);
  assert.equal(after.activity, before.activity);
  assert.equal(module.state().sync, 'healthy');
});

// ---------------------------------------------------------------------------
// 6. main.js wiring — static contract pins (the shell half of the fix)
// ---------------------------------------------------------------------------

test('main.js answers resync requests and routes follow windows as baselines', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // the module is told to forward its resync requests to the shell
  assert.ok(src.includes('onResyncRequest: ({ sessionId, request }) => {'),
    'the office module forwards office:runtime-resync-request to main.js');
  assert.ok(src.includes('officeAnswerResync(sessionId, request);'),
    'main.js answers the request');
  // the answer re-reads the durable log through session/page (backwards pages)
  assert.ok(src.includes("mux.call('session/page', args)"),
    'the answer re-reads the durable log via session/page');
  assert.ok(src.includes('mod.ingestHarnessSnapshot({ sessionId, records })'),
    'the re-read is handed to the module backfill entry');
  // opening windows are baselines, never increments
  assert.ok(src.includes('const res = mod.ingestHarnessSnapshot({ sessionId, records });'),
    'follow opening windows go through the baseline entry');
  // the follow reconcile only opens/closes on real changes
  assert.ok(src.includes('} else if (typeof mux.isStreamOpen === \'function\' && !mux.isStreamOpen(streamId)) {'),
    'a stream is only re-opened when the host actually ended it');
  assert.ok(!/mux\.openStream\(streamId, 'session\/follow'[\s\S]{0,200}?\n\s{4}\}$[\s\S]{0,80}?for \(const \[sessionId, entry\]/.test(src)
    || src.includes('follow reopen'), 'the every-tick unconditional re-open is gone (reopen is logged explicitly)');
  assert.ok(src.includes('log(`[office] follow reopen (${sessionId.slice(0, 8)})`);'),
    'a real re-open is logged as a reopen, distinct from the first open');
});
