'use strict';

// Task 3 / SPEC-03 — four-layer Office state model and authority rules.
// RED: src/office/runtime/state-reducer.js does not exist yet.
//
// Contracts under test:
// - presence/sync/runtime/activity layers plus movement/control/binding/queue
// - Harness events are the only source of running/attention/completed/failed
//   and tool facts; local behavior may only change roaming/chatting/resting/
//   sleeping; user commands cannot fabricate Runtime results
// - runtime priority above local behavior; sync=stale/resyncing never ends
//   local behavior or a bound task
// - cancellation keeps the binding until terminal evidence; the cancel
//   acknowledgement alone is not terminal evidence
// - unsupported pause/resume/preempt stay capability-gated with no fake states
// - presence is always present; offline is not a resident state
// - queue and binding invariants; no eventId/sessionEpoch handling here

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stateReducer = require('../src/office/runtime/state-reducer.js');

function create(options) {
  return stateReducer.createOfficeState(options);
}

function reduce(state, event) {
  return stateReducer.reduceOfficeState(state, event);
}

function effectTypes(effects) {
  return effects.map((e) => e.type);
}

function effectCodes(effects) {
  return effects.map((e) => e.code);
}

test('initial state freezes the four-layer and operational vocabulary', () => {
  const state = create();
  assert.equal(state.presence, 'present');
  assert.equal(state.sync, 'healthy');
  assert.equal(state.runtime, 'unbound');
  assert.equal(state.activity, 'roaming');
  assert.equal(state.movement, 'stationary');
  assert.equal(state.control, 'none');
  assert.equal(state.binding, 'unbound');
  assert.equal(state.queue, 'empty');
  assert.equal(state.lastResult, null);
  assert.equal(Object.isFrozen(state), true);
});

test('runtime facts map to running, activity and binding', () => {
  let state = create();
  let result = reduce(state, { type: 'runtime/fact', fact: 'running' });
  assert.equal(result.state.runtime, 'running');
  assert.equal(result.state.activity, 'working');
  assert.ok(effectTypes(result.effects).includes('interrupt-local-behavior'));

  result = reduce(result.state, { type: 'runtime/fact', fact: 'running', reason: 'thinking' });
  assert.equal(result.state.activity, 'thinking');
  result = reduce(result.state, { type: 'runtime/fact', fact: 'running', reason: 'waiting' });
  assert.equal(result.state.activity, 'waiting');

  const dispatch = reduce(create(), { type: 'control/dispatch' });
  assert.equal(dispatch.state.control, 'dispatchPending');
  assert.equal(dispatch.state.binding, 'pending');
  const bound = reduce(dispatch.state, { type: 'runtime/fact', fact: 'running' });
  assert.equal(bound.state.binding, 'bound');
  assert.equal(bound.state.control, 'none');
});

test('attention facts never leave a resident sleeping', () => {
  let state = create();
  state = reduce(state, { type: 'local/activity', activity: 'sleeping' }).state;
  const result = reduce(state, { type: 'runtime/fact', fact: 'attention', reason: 'blocked' });
  assert.equal(result.state.runtime, 'attention');
  assert.equal(result.state.activity, 'working');
});

test('completion and failure latch lastResult and release the binding', () => {
  let state = create();
  state = reduce(state, { type: 'control/dispatch' }).state;
  state = reduce(state, { type: 'binding/bound', sessionId: 's-1' }).state;
  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;

  const completed = reduce(state, { type: 'runtime/fact', fact: 'completed', reason: 'completed' });
  assert.equal(completed.state.runtime, 'completed');
  assert.equal(completed.state.binding, 'releasing');
  assert.equal(completed.state.lastResult.outcome, 'completed');
  assert.ok(effectTypes(completed.effects).includes('result-presentation'));

  const failed = reduce(completed.state, { type: 'runtime/fact', fact: 'failed', reason: 'error' });
  assert.equal(failed.state.runtime, 'failed');
  assert.equal(failed.state.lastResult.outcome, 'failed');
});

test('local behavior events cannot create Runtime facts', () => {
  let state = create();
  const local = reduce(state, { type: 'local/activity', activity: 'working' });
  assert.deepEqual(effectCodes(local.effects), ['LOCAL_ACTIVITY_UNSUPPORTED']);
  assert.equal(local.state.activity, 'roaming');

  state = reduce(local.state, { type: 'local/activity', activity: 'chatting' }).state;
  assert.equal(state.activity, 'chatting');

  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;
  const rejected = reduce(state, { type: 'runtime/fact', fact: 'running', source: 'local' });
  assert.equal(rejected.state.runtime, 'running');

  const localWhileRunning = reduce(state, { type: 'local/activity', activity: 'roaming' });
  assert.deepEqual(effectCodes(localWhileRunning.effects), ['runtime-priority']);
  assert.equal(localWhileRunning.state.activity, 'working');
});

test('local behavior is rejected during result presentation', () => {
  let state = create();
  state = reduce(state, { type: 'runtime/fact', fact: 'completed' }).state;
  const local = reduce(state, { type: 'local/activity', activity: 'roaming' });
  assert.deepEqual(effectCodes(local.effects), ['result-presentation']);
  assert.equal(local.state.activity, 'roaming');
});

test('tool facts only exist while running', () => {
  let state = create();
  const idle = reduce(state, { type: 'runtime/tool', tool: 'search' });
  assert.deepEqual(effectCodes(idle.effects), ['TOOL_FACT_WITHOUT_RUNNING']);

  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;
  const running = reduce(state, { type: 'runtime/tool', tool: 'search' });
  assert.equal(running.state.lastTool, 'search');
  assert.ok(effectTypes(running.effects).includes('tool-fact'));
});

test('sync=stale or resyncing never ends local behavior or a bound task', () => {
  let state = create();
  state = reduce(state, { type: 'local/activity', activity: 'chatting' }).state;
  const stale = reduce(state, { type: 'sync/status', sync: 'stale' });
  assert.equal(stale.state.sync, 'stale');
  assert.equal(stale.state.activity, 'chatting');
  assert.equal(stale.state.runtime, 'unbound');

  state = reduce(stale.state, { type: 'sync/status', sync: 'resyncing' }).state;
  assert.equal(state.sync, 'resyncing');
  assert.equal(state.activity, 'chatting');

  state = reduce(state, { type: 'control/dispatch' }).state;
  state = reduce(state, { type: 'binding/bound', sessionId: 's-2' }).state;
  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;
  state = reduce(state, { type: 'runtime/tool', tool: 'bash' }).state;
  const staleWhileRunning = reduce(state, { type: 'sync/status', sync: 'stale' });
  assert.equal(staleWhileRunning.state.runtime, 'running');
  assert.equal(staleWhileRunning.state.lastTool, 'bash');
  assert.equal(staleWhileRunning.state.binding, 'bound');

  const healthy = reduce(staleWhileRunning.state, { type: 'sync/status', sync: 'healthy' });
  assert.equal(healthy.state.sync, 'healthy');
});

test('cancellation retains the binding until terminal evidence', () => {
  let state = create();
  state = reduce(state, { type: 'control/dispatch' }).state;
  state = reduce(state, { type: 'binding/bound', sessionId: 's-3' }).state;
  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;

  const cancel = reduce(state, { type: 'control/cancel' });
  assert.equal(cancel.state.control, 'cancellationPending');
  assert.equal(cancel.state.binding, 'bound');
  assert.ok(effectTypes(cancel.effects).includes('send-control'));

  const ack = reduce(cancel.state, { type: 'control/cancel-ack' });
  assert.equal(ack.state.control, 'cancellationPending');
  assert.equal(ack.state.binding, 'bound');
  assert.ok(effectTypes(ack.effects).includes('awaiting-terminal-evidence'));

  const terminal = reduce(ack.state, { type: 'runtime/cancelled', evidence: 'turn-end-aborted' });
  assert.equal(terminal.state.control, 'none');
  assert.equal(terminal.state.binding, 'releasing');
  assert.equal(terminal.state.runtime, 'idle');
  assert.equal(terminal.state.lastResult.outcome, 'cancelled');
});

test('cancel evidence without a pending request is rejected', () => {
  const state = create();
  const result = reduce(state, { type: 'runtime/cancelled', evidence: 'turn-end-aborted' });
  assert.deepEqual(effectCodes(result.effects), ['CANCEL_EVIDENCE_WITHOUT_REQUEST']);
  assert.equal(result.state.binding, 'unbound');
});

test('dispatch queues while busy and pends while free', () => {
  let state = create();
  const free = reduce(state, { type: 'control/dispatch' });
  assert.equal(free.state.control, 'dispatchPending');
  assert.equal(free.state.binding, 'pending');
  assert.equal(free.state.queue, 'empty');

  state = reduce(free.state, { type: 'binding/bound', sessionId: 's-4' }).state;
  assert.equal(state.binding, 'bound');
  assert.equal(state.control, 'none');

  const busy = reduce(state, { type: 'runtime/fact', fact: 'running' });
  const queued = reduce(busy.state, { type: 'control/dispatch' });
  assert.equal(queued.state.queue, 'queued');
  assert.equal(queued.state.binding, 'bound');
  assert.equal(queued.state.control, 'none');
});

test('pause, resume and preempt are capability-gated without fake states', () => {
  let state = create();
  const pause = reduce(state, { type: 'control/pause' });
  assert.deepEqual(effectCodes(pause.effects), ['CONTROL_UNSUPPORTED']);
  assert.equal(pause.state.control, 'none');
  const resume = reduce(state, { type: 'control/resume' });
  assert.deepEqual(effectCodes(resume.effects), ['CONTROL_UNSUPPORTED']);
  const preempt = reduce(state, { type: 'control/preempt' });
  assert.deepEqual(effectCodes(preempt.effects), ['CONTROL_UNSUPPORTED']);
  assert.equal(preempt.state.control, 'none');

  state = create({ capabilities: { preempt: true } });
  state = reduce(state, { type: 'control/dispatch' }).state;
  state = reduce(state, { type: 'binding/bound', sessionId: 's-5' }).state;
  state = reduce(state, { type: 'runtime/fact', fact: 'running' }).state;
  const allowed = reduce(state, { type: 'control/preempt' });
  assert.equal(allowed.state.control, 'preemptPending');
  assert.ok(effectTypes(allowed.effects).includes('send-control'));
});

test('transition completion resumes local behavior or starts the queued task', () => {
  let state = create();
  state = reduce(state, { type: 'runtime/fact', fact: 'completed' }).state;
  const done = reduce(state, { type: 'transition/complete' });
  assert.equal(done.state.runtime, 'idle');
  assert.equal(done.state.binding, 'unbound');
  assert.equal(done.state.activity, 'roaming');
  assert.ok(effectTypes(done.effects).includes('resume-local-behavior'));

  state = reduce(done.state, { type: 'runtime/fact', fact: 'failed' }).state;
  state = reduce(state, { type: 'queue/enqueue' }).state;
  const next = reduce(state, { type: 'transition/complete' });
  assert.equal(next.state.binding, 'pending');
  assert.equal(next.state.control, 'dispatchPending');
  assert.ok(effectTypes(next.effects).includes('start-queued-task'));
});

test('transition completion outside a result presentation is rejected', () => {
  const state = create();
  const result = reduce(state, { type: 'transition/complete' });
  assert.deepEqual(effectCodes(result.effects), ['TRANSITION_COMPLETE_NOT_APPLICABLE']);
});

test('binding transitions are invariant-guarded', () => {
  let state = create();
  const badBound = reduce(state, { type: 'binding/bound', sessionId: 's-6' });
  assert.deepEqual(effectCodes(badBound.effects), ['BINDING_INVALID_TRANSITION']);

  state = reduce(state, { type: 'control/dispatch' }).state;
  const bound = reduce(state, { type: 'binding/bound', sessionId: 's-6' });
  assert.equal(bound.state.binding, 'bound');

  const badRelease = reduce(bound.state, { type: 'binding/released' });
  assert.deepEqual(effectCodes(badRelease.effects), ['BINDING_INVALID_TRANSITION']);

  state = reduce(bound.state, { type: 'runtime/fact', fact: 'completed' }).state;
  assert.equal(state.binding, 'releasing');
  const released = reduce(state, { type: 'binding/released' });
  assert.equal(released.state.binding, 'unbound');
});

test('movement and animation events stay inside their authority', () => {
  let state = create();
  const movement = reduce(state, { type: 'movement/status', movement: 'moving' });
  assert.equal(movement.state.movement, 'moving');
  assert.equal(movement.state.activity, 'roaming');
  assert.equal(movement.state.runtime, 'unbound');

  const animation = reduce(movement.state, { type: 'animation/select', resource: 'walk-left', frameIndex: 2 });
  assert.equal(animation.state.activity, 'roaming');
  assert.equal(animation.state.movement, 'moving');
  assert.equal(animation.state.runtime, 'unbound');
  assert.ok(effectTypes(animation.effects).includes('animation-not-reducer-state'));
});

test('offline is never a resident state', () => {
  const state = create();
  const result = reduce(state, { type: 'presence/set', presence: 'offline' });
  assert.deepEqual(effectCodes(result.effects), ['PRESENCE_OFFLINE_UNSUPPORTED']);
  assert.equal(result.state.presence, 'present');
  assert.equal(JSON.stringify(result.state).includes('offline'), false);
});

test('queue dequeue and unknown events behave deterministically', () => {
  let state = create();
  const emptyDequeue = reduce(state, { type: 'queue/dequeue' });
  assert.deepEqual(effectCodes(emptyDequeue.effects), ['QUEUE_EMPTY']);

  state = reduce(state, { type: 'queue/enqueue' }).state;
  assert.equal(state.queue, 'queued');
  state = reduce(state, { type: 'queue/dequeue' }).state;
  assert.equal(state.queue, 'empty');

  const unknown = reduce(state, { type: 'harness/raw', payload: {} });
  assert.deepEqual(effectCodes(unknown.effects), ['UNKNOWN_EVENT']);
});

test('reducer is pure: inputs are never mutated and repeats are equal', () => {
  const state = create();
  const snapshot = JSON.stringify(state);
  const event = { type: 'runtime/fact', fact: 'completed', reason: 'completed' };
  const first = reduce(state, event);
  assert.equal(JSON.stringify(state), snapshot);
  const second = reduce(state, event);
  assert.deepEqual(first, second);
});
