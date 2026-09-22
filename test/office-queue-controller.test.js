'use strict';

// Task 5 / SPEC-04 — task queue controller.
// RED: src/office/runtime/queue-controller.js does not exist yet.
//
// Contracts under test:
// - queue item schema: queueItemId/requestedAt/requestedBy/employeeId/
//   sessionId/taskSummary/priority/status
// - status machine: queued | dispatching | running | cancelled | completed |
//   failed
// - idle direct dispatch creates binding=pending in one reducer transaction
// - busy dispatches FIFO-queue without touching the active binding
// - waiting count and ordered summaries are queryable for the details UI
// - one session never occupies two employee queues
// - the collaborator queue is a global singleton FIFO
// - urgent may request cancel/interrupt but never skips terminal evidence,
//   never teleports, never reuses old path reservations, never jumps the
//   collaborator FIFO
// - cancel/interrupt keeps the binding until terminal evidence, then releases
//   atomically and starts the next queued item (no task is lost)
// - queue and binding stay consistent: released binding + next dispatch is one
//   atomic transaction

const { test } = require('node:test');
const assert = require('node:assert/strict');

const queueController = require('../src/office/runtime/queue-controller.js');

const SEATS = ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'];

function createQueue(overrides = {}) {
  return queueController.createQueueController({
    seats: SEATS,
    collaboratorId: 'collaborator',
    ...overrides,
  });
}

test('module exposes the queue factory and status vocabulary', () => {
  assert.equal(typeof queueController.createQueueController, 'function');
  assert.deepEqual(queueController.QUEUE_ITEM_STATUS, [
    'queued',
    'dispatching',
    'running',
    'cancelled',
    'completed',
    'failed',
  ]);
  assert.deepEqual(queueController.PRIORITIES, ['normal', 'urgent']);
});

test('idle direct dispatch becomes a single dispatching transaction', () => {
  const queue = createQueue();
  const result = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'coder',
    sessionId: 'session-1',
    taskSummary: 'fix the login race',
    priority: 'normal',
    nowMs: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.item.status, 'dispatching');
  assert.equal(result.item.employeeId, 'coder');
  assert.equal(result.item.requestedAt, 100);
  assert.equal(result.item.requestedBy, 'user');
  assert.equal(result.item.priority, 'normal');
  // one transaction: dispatch-started AND binding-pending effects together
  const types = result.effects.map((e) => e.type);
  assert.deepEqual(types, ['dispatch-started', 'binding-pending']);
  const pending = result.effects.find((e) => e.type === 'binding-pending');
  assert.equal(pending.employeeId, 'coder');
  assert.equal(pending.sessionId, 'session-1');
});

test('busy employees queue work FIFO without touching the active binding', () => {
  const queue = createQueue();
  queue.enqueue({
    requestedBy: 'user',
    employeeId: 'coder',
    sessionId: 'session-1',
    taskSummary: 'first',
    nowMs: 0,
  });
  const second = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'coder',
    sessionId: 'session-2',
    taskSummary: 'second',
    nowMs: 10,
  });
  assert.equal(second.ok, true);
  assert.equal(second.item.status, 'queued');
  const active = queue.activeItem('coder');
  assert.equal(active.sessionId, 'session-1', 'active binding unchanged');
  assert.equal(queue.waitingCount('coder'), 1);
});

test('waiting items are ordered and queryable', () => {
  const queue = createQueue();
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'a', nowMs: 0 });
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-2', taskSummary: 'b', nowMs: 10 });
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'coder', sessionId: 's-3', taskSummary: 'c', nowMs: 20 });
  assert.equal(queue.waitingCount('coder'), 2);
  const items = queue.waitingItems('coder');
  assert.deepEqual(
    items.map((item) => item.taskSummary),
    ['b', 'c']
  );
  for (const item of items) {
    assert.ok(item.queueItemId);
    assert.equal(item.status, 'queued');
  }
});

test('one session cannot occupy two employee queues', () => {
  const queue = createQueue();
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-dup', taskSummary: 'x', nowMs: 0 });
  const clash = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'researcher',
    sessionId: 's-dup',
    taskSummary: 'y',
    nowMs: 10,
  });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'SESSION_ALREADY_QUEUED');
  assert.equal(queue.waitingCount('researcher'), 0);
});

test('the collaborator queue is a global singleton FIFO', () => {
  const queue = createQueue();
  for (let i = 1; i <= 3; i += 1) {
    const result = queue.enqueue({
      requestedBy: 'runtime',
      employeeId: 'collaborator',
      sessionId: `sub-${i}`,
      taskSummary: `work ${i}`,
      nowMs: i,
    });
    assert.equal(result.ok, true);
  }
  assert.equal(queue.waitingCount('collaborator'), 2);
  assert.deepEqual(
    queue.waitingItems('collaborator').map((item) => item.sessionId),
    ['sub-2', 'sub-3']
  );
  // only one collaborator queue exists across all seats
  const snapshot = queue.snapshot();
  const collaboratorQueues = snapshot.queues.filter((entry) => entry.employeeId === 'collaborator');
  assert.equal(collaboratorQueues.length, 1);
});

test('invalid input is rejected with stable codes', () => {
  const queue = createQueue();
  assert.equal(queue.enqueue({ requestedBy: 'user', employeeId: 'ghost', sessionId: 's', taskSummary: 'x', nowMs: 0 }).code, 'UNKNOWN_EMPLOYEE');
  assert.equal(queue.enqueue({ requestedBy: 'robot', employeeId: 'coder', sessionId: 's', taskSummary: 'x', nowMs: 0 }).code, 'INVALID_REQUESTED_BY');
  assert.equal(queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's', taskSummary: 'x', priority: 'asap', nowMs: 0 }).code, 'INVALID_PRIORITY');
  assert.equal(queue.waitingCount('ghost'), 0);
});

test('urgent dispatch on a busy seat requests cancel but never skips terminal evidence', () => {
  const queue = createQueue();
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-run', taskSummary: 'running work', nowMs: 0 });
  const urgent = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'coder',
    sessionId: 's-urgent',
    taskSummary: 'urgent work',
    priority: 'urgent',
    nowMs: 10,
  });
  assert.equal(urgent.ok, true);
  assert.equal(urgent.item.status, 'queued');
  const types = urgent.effects.map((e) => e.type);
  assert.ok(types.includes('preempt-requested'), 'urgent asks for cancel/interrupt');
  assert.ok(types.includes('send-control'), 'urgent sends a cancel control');
  assert.equal(types.includes('dispatch-started'), false, 'urgent does NOT start before terminal evidence');
  assert.equal(queue.activeItem('coder').sessionId, 's-run', 'old binding unchanged');

  // even after the cancel request, dispatch requires terminal evidence
  const acked = queue.noteCancelAcknowledged({ queueItemId: queue.activeItem('coder').queueItemId, nowMs: 20 });
  assert.equal(acked.ok, true);
  assert.equal(queue.activeItem('coder').sessionId, 's-run', 'cancel ack never releases');
  assert.equal(queue.waitingItems('coder')[0].sessionId, 's-urgent');
});

test('cancellation marks the queue item cancelled and keeps terminal separation', () => {
  const queue = createQueue();
  const first = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-x', taskSummary: 'x', nowMs: 0 });
  const cancel = queue.requestCancel({ queueItemId: first.item.queueItemId, nowMs: 10 });
  assert.equal(cancel.ok, true);
  // status stays dispatching until terminal evidence (cancel request alone
  // must not declare a cancelled outcome)
  assert.ok(['dispatching', 'running'].includes(queue.getItem(first.item.queueItemId).status));
});

test('urgent cannot jump the collaborator FIFO', () => {
  const queue = createQueue();
  queue.enqueue({ requestedBy: 'user', employeeId: 'collaborator', sessionId: 'c-run', taskSummary: 'running', nowMs: 0 });
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'collaborator', sessionId: 'c-1', taskSummary: 'first', nowMs: 10 });
  const urgent = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'collaborator',
    sessionId: 'c-urgent',
    taskSummary: 'urgent',
    priority: 'urgent',
    nowMs: 20,
  });
  assert.equal(urgent.ok, true);
  assert.deepEqual(
    queue.waitingItems('collaborator').map((item) => item.sessionId),
    ['c-1', 'c-urgent'],
    'collaborator FIFO order is strict, urgent stays behind'
  );
});

test('cancel/interrupt waits for terminal evidence, then releases and starts the next item atomically', () => {
  const queue = createQueue();
  const first = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'one', nowMs: 0 });
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-2', taskSummary: 'two', nowMs: 10 });

  const cancel = queue.requestCancel({ queueItemId: first.item.queueItemId, nowMs: 20 });
  assert.equal(cancel.ok, true);
  const cancelTypes = cancel.effects.map((e) => e.type);
  assert.ok(cancelTypes.includes('send-control'));
  assert.equal(queue.activeItem('coder').sessionId, 's-1', 'binding kept after cancel request');
  assert.ok(
    ['dispatching', 'running'].includes(queue.getItem(first.item.queueItemId).status),
    'item stays active until terminal evidence'
  );

  // terminal evidence for the cancelled item: atomic release + next dispatch
  const evidence = queue.noteTerminalEvidence({
    queueItemId: first.item.queueItemId,
    evidenceType: 'turn-end',
    outcome: 'cancelled',
    nowMs: 30,
  });
  assert.equal(evidence.ok, true);
  const evidenceTypes = evidence.effects.map((e) => e.type);
  assert.ok(evidenceTypes.includes('release-binding'));
  assert.ok(evidenceTypes.includes('dispatch-started'));
  assert.ok(evidenceTypes.includes('binding-pending'));
  assert.equal(queue.activeItem('coder').sessionId, 's-2');
  assert.equal(queue.activeItem('coder').status, 'dispatching');
  assert.equal(queue.waitingCount('coder'), 0);
  const done = queue.getItem(first.item.queueItemId);
  assert.equal(done.status, 'cancelled');
});

test('cancel-ack evidence is not terminal evidence', () => {
  const queue = createQueue();
  const first = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'one', nowMs: 0 });
  const bad = queue.noteTerminalEvidence({
    queueItemId: first.item.queueItemId,
    evidenceType: 'cancel-ack',
    outcome: 'cancelled',
    nowMs: 10,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'TERMINAL_EVIDENCE_REQUIRED');
  assert.equal(queue.activeItem('coder').sessionId, 's-1');
});

test('queue switching never loses tasks', () => {
  const queue = createQueue();
  const a = queue.enqueue({ requestedBy: 'user', employeeId: 'researcher', sessionId: 'r-1', taskSummary: 'A', nowMs: 0 });
  const b = queue.enqueue({ requestedBy: 'user', employeeId: 'researcher', sessionId: 'r-2', taskSummary: 'B', nowMs: 10 });
  const c = queue.enqueue({ requestedBy: 'user', employeeId: 'researcher', sessionId: 'r-3', taskSummary: 'C', nowMs: 20 });

  queue.noteTerminalEvidence({ queueItemId: a.item.queueItemId, evidenceType: 'turn-end', outcome: 'completed', nowMs: 30 });
  assert.equal(queue.activeItem('researcher').sessionId, 'r-2');

  queue.requestCancel({ queueItemId: b.item.queueItemId, nowMs: 40 });
  queue.noteTerminalEvidence({ queueItemId: b.item.queueItemId, evidenceType: 'turn-end', outcome: 'cancelled', nowMs: 50 });
  assert.equal(queue.activeItem('researcher').sessionId, 'r-3', 'C survived two switches');
  assert.equal(queue.getItem(a.item.queueItemId).status, 'completed');
  assert.equal(queue.getItem(b.item.queueItemId).status, 'cancelled');
  assert.equal(queue.getItem(c.item.queueItemId).status, 'dispatching');
});

test('terminal evidence with an empty queue releases the binding and returns to local behavior', () => {
  const queue = createQueue();
  const only = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-only', taskSummary: 'solo', nowMs: 0 });
  const result = queue.noteTerminalEvidence({
    queueItemId: only.item.queueItemId,
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 10,
  });
  assert.equal(result.ok, true);
  const types = result.effects.map((e) => e.type);
  assert.deepEqual(types, ['release-binding', 'resume-local-behavior']);
  assert.equal(queue.activeItem('coder'), null);
  assert.equal(queue.waitingCount('coder'), 0);
});

test('urgent preemption follows cancel -> terminal evidence -> release -> next', () => {
  const queue = createQueue();
  const old = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-old', taskSummary: 'old', nowMs: 0 });
  const urgent = queue.enqueue({
    requestedBy: 'user',
    employeeId: 'coder',
    sessionId: 's-urgent',
    taskSummary: 'urgent',
    priority: 'urgent',
    nowMs: 10,
  });
  assert.equal(queue.activeItem('coder').sessionId, 's-old');

  queue.noteTerminalEvidence({ queueItemId: old.item.queueItemId, evidenceType: 'turn-end', outcome: 'cancelled', nowMs: 20 });
  assert.equal(queue.activeItem('coder').sessionId, 's-urgent');
  assert.equal(queue.getItem(old.item.queueItemId).status, 'cancelled');
  const started = queue.activeItem('coder');
  assert.equal(started.priority, 'urgent');
  assert.equal(started.status, 'dispatching');
});

test('dispatch always requires a fresh path: no teleport or stale reservations', () => {
  const queue = createQueue();
  const direct = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'x', nowMs: 0 });
  const started = direct.effects.find((e) => e.type === 'dispatch-started');
  assert.equal(started.requireFreshPath, true);

  const queued = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-2', taskSummary: 'y', priority: 'urgent', nowMs: 10 });
  const evidence = queue.noteTerminalEvidence({
    queueItemId: direct.item.queueItemId,
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 20,
  });
  const next = evidence.effects.find((e) => e.type === 'dispatch-started');
  assert.ok(next, 'the queued item dispatched after terminal evidence');
  assert.equal(next.requireFreshPath, true, 'no stale path reservation reuse');
  assert.equal(next.sessionId, queued.item.sessionId);
});

test('dispatching items become running only via explicit binding confirmation', () => {
  const queue = createQueue();
  const item = queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'x', nowMs: 0 });
  assert.equal(queue.activeItem('coder').status, 'dispatching');
  const marked = queue.markRunning({ queueItemId: item.item.queueItemId, nowMs: 10 });
  assert.equal(marked.ok, true);
  assert.equal(queue.activeItem('coder').status, 'running');
});

test('snapshot exposes waiting counts and ordered summaries for the details UI', () => {
  const queue = createQueue();
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'one', nowMs: 0 });
  queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-2', taskSummary: 'two', nowMs: 10 });
  const snapshot = queue.snapshot('coder');
  assert.equal(snapshot.employeeId, 'coder');
  assert.equal(snapshot.waitingCount, 1);
  assert.equal(snapshot.active.sessionId, 's-1');
  assert.deepEqual(
    snapshot.waiting.map((item) => item.taskSummary),
    ['two']
  );
});

test('queue state is deterministic and JSON-replayable', () => {
  function replay() {
    const queue = createQueue();
    queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-1', taskSummary: 'one', nowMs: 0 });
    queue.enqueue({ requestedBy: 'user', employeeId: 'coder', sessionId: 's-2', taskSummary: 'two', priority: 'urgent', nowMs: 10 });
    queue.noteTerminalEvidence({ queueItemId: 'queue-000001', evidenceType: 'turn-end', outcome: 'completed', nowMs: 20 });
    return JSON.stringify(queue.snapshot());
  }
  assert.equal(replay(), replay());
});

// ---------------------------------------------------------------------------
// Task 7B — terminal evidence for QUEUED items (safe close, never dispatch)
// ---------------------------------------------------------------------------

test('closeQueuedItem safely closes a queued item while the seat is busy', () => {
  const queue = queueController.createQueueController({ seats: ['orchestrator'] });
  // head item: dispatched (seat busy)
  queue.enqueue({ requestedBy: 'user', employeeId: 'orchestrator', sessionId: 'q-active', nowMs: 1 });
  queue.dispatchNext({ employeeId: 'orchestrator', nowMs: 2 });
  // queued behind it
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'orchestrator', sessionId: 'q-queued-completed', nowMs: 3 });
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'orchestrator', sessionId: 'q-queued-failed', nowMs: 4 });
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'orchestrator', sessionId: 'q-queued-cancelled', nowMs: 5 });
  assert.equal(queue.waitingCount('orchestrator'), 3);

  for (const [sessionId, outcome] of [
    ['q-queued-completed', 'completed'],
    ['q-queued-failed', 'failed'],
    ['q-queued-cancelled', 'cancelled'],
  ]) {
    const closed = queue.closeQueuedItem({ sessionId, evidenceType: 'turn-end', outcome, nowMs: 6 });
    assert.equal(closed.ok, true, `${sessionId} closes`);
    assert.equal(closed.item.status, outcome);
    assert.equal(closed.item.sessionId, sessionId);
  }
  assert.equal(queue.waitingCount('orchestrator'), 0, 'all three left the waiting queue');
  // the seat's active item is untouched by queued closes
  assert.equal(queue.activeItem('orchestrator').sessionId, 'q-active');
  assert.equal(queue.activeItem('orchestrator').status, 'dispatching');
});

test('closeQueuedItem fails closed for unknown, non-queued and duplicate sessions', () => {
  const queue = queueController.createQueueController({ seats: ['orchestrator'] });
  queue.enqueue({ requestedBy: 'user', employeeId: 'orchestrator', sessionId: 'q-active', nowMs: 1 });
  queue.dispatchNext({ employeeId: 'orchestrator', nowMs: 2 });
  queue.enqueue({ requestedBy: 'runtime', employeeId: 'orchestrator', sessionId: 'q-queued', nowMs: 3 });
  queue.closeQueuedItem({ sessionId: 'q-queued', evidenceType: 'turn-end', outcome: 'completed', nowMs: 4 });

  for (const sessionId of ['q-queued', 'q-unknown']) {
    const again = queue.closeQueuedItem({ sessionId, evidenceType: 'turn-end', outcome: 'completed', nowMs: 5 });
    assert.equal(again.ok, false, `${sessionId} cannot close twice`);
    assert.equal(again.code, 'SESSION_NOT_QUEUED');
  }
  const badOutcome = queue.closeQueuedItem({ sessionId: 'q-unknown', evidenceType: 'turn-end', outcome: 'nope', nowMs: 5 });
  assert.equal(badOutcome.ok, false);
  assert.equal(badOutcome.code, 'INVALID_OUTCOME');
  // the active item survived every failed close
  assert.equal(queue.activeItem('orchestrator').sessionId, 'q-active');
});
