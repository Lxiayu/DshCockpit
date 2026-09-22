'use strict';

// Task 3 / SPEC-03 — explicit transition phases without rendering.
// RED: src/office/runtime/transition-controller.js does not exist yet.
//
// Contracts under test:
// - task arrival interrupts roaming/chatting/resting/sleeping
// - explicit phase chains: stop -> turn -> move -> arrive -> sit -> work and
//   result -> stand -> leave (both completed and failed outcomes)
// - interruption records a reason, releases stale path reservations and chat
//   locks, and preserves the last trusted task
// - stale path/chat state cannot survive a new target
// - no sprite/visual operations and no fabricated Runtime results
// - decisions are deterministic from explicit input

const { test } = require('node:test');
const assert = require('node:assert/strict');

const transitionController = require('../src/office/runtime/transition-controller.js');

function create() {
  return transitionController.createTransitionController();
}

function effectTypes(effects) {
  return effects.map((e) => e.type);
}

test('task arrival interrupts local behavior with full cleanup', () => {
  const controller = create();
  const started = controller.beginTaskStart({
    fromActivity: 'chatting',
    task: { taskId: 't-1' },
    target: { nodeId: 'desk-coder' },
    nowMs: 1000,
  });
  assert.equal(started.transition.kind, 'task-start');
  assert.equal(started.transition.phase, 'stop');
  assert.equal(started.transition.reason, 'runtime-task');
  assert.equal(started.transition.fromActivity, 'chatting');
  assert.deepEqual(started.transition.target, { nodeId: 'desk-coder' });
  assert.equal(started.transition.cleanup.releaseReservations, true);
  assert.equal(started.transition.cleanup.releaseChatLock, true);
  assert.equal(started.transition.cleanup.clearPath, true);
  assert.equal(started.transition.interrupted.fromActivity, 'chatting');
  assert.equal(started.transition.lastTrustedTask.taskId, 't-1');
});

test('task start chain advances stop -> turn -> move -> arrive -> sit -> work', () => {
  const controller = create();
  let current = controller.beginTaskStart({ fromActivity: 'roaming', task: { taskId: 't-1' }, nowMs: 0 }).transition;
  const seen = ['stop'];
  for (let i = 0; i < 5; i += 1) {
    const next = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: i + 1 });
    current = next.transition;
    seen.push(current.phase);
  }
  assert.deepEqual(seen, ['stop', 'turn', 'move', 'arrive', 'sit', 'work']);

  const done = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 6 });
  assert.equal(done.transition, null);
  assert.deepEqual(effectTypes(done.effects), ['transition-complete']);
});

test('arrived event moves the move phase into arrive', () => {
  const controller = create();
  let current = controller.beginTaskStart({ fromActivity: 'roaming', nowMs: 0 }).transition;
  current = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 1 }).transition;
  current = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 2 }).transition;
  assert.equal(current.phase, 'move');

  const arrived = controller.advance({ transition: current, event: { type: 'arrived' }, nowMs: 3 });
  assert.equal(arrived.transition.phase, 'arrive');
});

test('terminal completed outcome presents the result then stands and leaves', () => {
  const controller = create();
  let current = controller.beginTaskStart({ fromActivity: 'roaming', task: { taskId: 't-1' }, nowMs: 0 }).transition;
  const atWork = controller.advance({ transition: current, event: { type: 'task-terminal', outcome: 'completed', result: { summary: 'ok' } }, nowMs: 1 });
  assert.equal(atWork.transition.kind, 'task-end');
  assert.equal(atWork.transition.phase, 'result');
  assert.equal(atWork.transition.outcome, 'completed');
  assert.deepEqual(effectTypes(atWork.effects), ['present-result']);
  assert.equal(atWork.transition.lastTrustedTask.taskId, 't-1');

  const stand = controller.advance({ transition: atWork.transition, event: { type: 'phase-complete' }, nowMs: 2 });
  assert.equal(stand.transition.phase, 'stand');

  const leave = controller.advance({ transition: stand.transition, event: { type: 'phase-complete' }, nowMs: 3 });
  assert.equal(leave.transition.phase, 'leave');
  assert.equal(leave.transition.cleanup.releaseReservations, true);

  const done = controller.advance({ transition: leave.transition, event: { type: 'phase-complete' }, nowMs: 4 });
  assert.equal(done.transition, null);
  assert.deepEqual(effectTypes(done.effects), ['transition-complete', 'resume-local-behavior']);
});

test('terminal failed outcome uses the same result -> stand -> leave chain', () => {
  const controller = create();
  let current = controller.beginTaskStart({ fromActivity: 'resting', task: { taskId: 't-2' }, nowMs: 0 }).transition;
  const atWork = controller.advance({ transition: current, event: { type: 'task-terminal', outcome: 'failed', result: { summary: 'boom' } }, nowMs: 1 });
  assert.equal(atWork.transition.phase, 'result');
  assert.equal(atWork.transition.outcome, 'failed');

  let phases = ['result'];
  current = atWork.transition;
  for (let i = 0; i < 2; i += 1) {
    const next = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 2 + i });
    current = next.transition;
    phases.push(current.phase);
  }
  assert.deepEqual(phases, ['result', 'stand', 'leave']);
});

test('interruption records the reason and releases stale path and chat state', () => {
  const controller = create();
  let current = controller.beginTaskStart({ fromActivity: 'chatting', task: { taskId: 't-1' }, nowMs: 0 }).transition;
  current = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 1 }).transition;
  current = controller.advance({ transition: current, event: { type: 'phase-complete' }, nowMs: 2 }).transition;
  assert.equal(current.phase, 'move');

  const interrupted = controller.advance({ transition: current, event: { type: 'interrupt', reason: 'user-dispatch' }, nowMs: 3 });
  assert.equal(interrupted.transition.kind, 'interrupted');
  assert.equal(interrupted.transition.phase, null);
  assert.equal(interrupted.transition.reason, 'user-dispatch');
  assert.deepEqual(interrupted.transition.interrupted, { reason: 'user-dispatch', fromPhase: 'move' });
  assert.equal(interrupted.transition.cleanup.releaseReservations, true);
  assert.equal(interrupted.transition.cleanup.releaseChatLock, true);
  assert.equal(interrupted.transition.cleanup.clearPath, true);
  assert.equal(interrupted.transition.lastTrustedTask.taskId, 't-1');
});

test('cancellation records a reason and preserves the last trusted task', () => {
  const controller = create();
  const current = controller.beginTaskStart({ fromActivity: 'roaming', task: { taskId: 't-9' }, nowMs: 0 }).transition;
  const cancelled = controller.advance({ transition: current, event: { type: 'cancel-request' }, nowMs: 5 });
  assert.equal(cancelled.transition.kind, 'interrupted');
  assert.equal(cancelled.transition.reason, 'cancellationRequested');
  assert.deepEqual(cancelled.transition.interrupted, { reason: 'cancellationRequested', fromPhase: 'stop' });
  assert.equal(cancelled.transition.lastTrustedTask.taskId, 't-9');
  assert.equal(cancelled.transition.cleanup.releaseReservations, true);
});

test('a new task target clears stale path and chat state from the old transition', () => {
  const controller = create();
  const first = controller.beginTaskStart({
    fromActivity: 'chatting',
    task: { taskId: 't-1' },
    target: { nodeId: 'desk-1' },
    nowMs: 0,
  }).transition;
  let moving = controller.advance({ transition: first, event: { type: 'phase-complete' }, nowMs: 1 }).transition;
  moving = controller.advance({ transition: moving, event: { type: 'phase-complete' }, nowMs: 2 }).transition;
  const restarted = controller.advance({
    transition: moving,
    event: { type: 'runtime-task', task: { taskId: 't-2' }, target: { nodeId: 'desk-2' }, fromActivity: null },
    nowMs: 10,
  });
  assert.equal(restarted.transition.kind, 'task-start');
  assert.equal(restarted.transition.phase, 'stop');
  assert.equal(restarted.transition.target.nodeId, 'desk-2');
  assert.equal(restarted.transition.interrupted.fromPhase, 'move');
  assert.equal(restarted.transition.cleanup.clearPath, true);
  assert.equal(restarted.transition.cleanup.releaseChatLock, true);
  assert.equal(restarted.transition.lastTrustedTask.taskId, 't-2');
});

test('unknown events are rejected without changing the transition', () => {
  const controller = create();
  const current = controller.beginTaskStart({ fromActivity: 'roaming', nowMs: 0 }).transition;
  const rejected = controller.advance({ transition: current, event: { type: 'teleport-now' }, nowMs: 1 });
  assert.equal(rejected.transition.phase, 'stop');
  assert.deepEqual(effectTypes(rejected.effects), ['rejected']);
});

test('transitions are deterministic from explicit input', () => {
  const controller = create();
  const a = controller.beginTaskStart({ fromActivity: 'sleeping', task: { taskId: 't-3' }, target: { nodeId: 'desk-x' }, nowMs: 42 });
  const b = controller.beginTaskStart({ fromActivity: 'sleeping', task: { taskId: 't-3' }, target: { nodeId: 'desk-x' }, nowMs: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.transition.phase, 'stop');
  assert.equal(a.transition.fromActivity, 'sleeping');
});

test('task start requires a terminal outcome for task-end transitions', () => {
  const controller = create();
  const bad = controller.beginTaskEnd({ outcome: 'cancelled', nowMs: 0 });
  assert.equal(bad.transition, null);
  assert.equal(bad.effects[0].code, 'INVALID_OUTCOME');
});
