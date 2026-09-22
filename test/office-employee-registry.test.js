'use strict';

// Task 5 / SPEC-04 — binding and employee registry.
// RED: src/office/runtime/employee-registry.js does not exist yet.
//
// Contracts under test:
// - binding fields: sessionId/employeeId/bindingSource/confidence/boundAt/
//   releasedAt
// - priority manual > root-default > heuristic
// - session IDs are globally unique; one session cannot bind two employees
// - one employee cannot hold two active bindings (extra work goes to a queue)
// - root sessions default-bind to orchestrator
// - child runId/session registration keeps parentId relations
// - subagent/end only releases after terminal evidence
// - cancel acknowledgement never releases a binding
// - released bindings keep a redacted last task/result
// - no offline state is ever produced; presence stays present

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/office/runtime/employee-registry.js');
const { createQueueController } = require('../src/office/runtime/queue-controller.js');

const ALL_SEATS = ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'];

function createRegistry(overrides) {
  return registry.createEmployeeRegistry(overrides);
}

// Explicit dependency wiring: the registry and the test share ONE
// queue-controller instance, proving a single source of truth.
function createWiredRegistry() {
  const queue = createQueueController({
    seats: ALL_SEATS,
    collaboratorId: 'collaborator',
  });
  const reg = registry.createEmployeeRegistry({ queueController: queue });
  return { queue, reg };
}

test('createEmployeeRegistry builds the four residents plus singleton collaborator', () => {
  const reg = createRegistry();
  const employees = reg.listEmployees();
  assert.deepEqual(
    employees.map((e) => e.employeeId),
    ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator']
  );
  for (const employee of employees) {
    assert.equal(employee.presence, 'present');
    assert.equal(employee.state.activity !== 'offline', true);
  }
  assert.equal(reg.listEmployees().length, 5);
});

test('binding record exposes the full SPEC-04 field set', () => {
  const reg = createRegistry();
  const binding = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-a',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 1000,
  });
  assert.equal(binding.ok, true);
  assert.equal(binding.binding.sessionId, 'session-a');
  assert.equal(binding.binding.employeeId, 'coder');
  assert.equal(binding.binding.bindingSource, 'manual');
  assert.equal(binding.binding.confidence, 1);
  assert.equal(binding.binding.boundAt, 1000);
  assert.equal(binding.binding.releasedAt, null);
});

test('binding priority: manual > root-default > heuristic', () => {
  const reg = createRegistry();
  const weak = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-w',
    bindingSource: 'heuristic',
    confidence: 0.3,
    nowMs: 0,
  });
  assert.equal(weak.ok, true);

  // heuristic may upgrade to root-default
  const upgraded = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-w',
    bindingSource: 'root-default',
    confidence: 0.8,
    nowMs: 10,
  });
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.binding.bindingSource, 'root-default');

  // root-default may upgrade to manual
  const manual = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-w',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 20,
  });
  assert.equal(manual.ok, true);
  assert.equal(manual.binding.bindingSource, 'manual');

  // heuristic may NOT downgrade a manual/root-default binding
  const downgraded = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-w',
    bindingSource: 'heuristic',
    confidence: 0.9,
    nowMs: 30,
  });
  assert.equal(downgraded.ok, false);
  assert.equal(downgraded.code, 'BINDING_PRIORITY_INSUFFICIENT');
  assert.equal(reg.getBindingForSession('session-w').bindingSource, 'manual');
});

test('session IDs are globally unique: one session cannot bind two employees', () => {
  const reg = createRegistry();
  const first = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-dup',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  assert.equal(first.ok, true);

  const second = reg.bindSession({
    employeeId: 'researcher',
    sessionId: 'session-dup',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 10,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'SESSION_ALREADY_BOUND');
  assert.equal(reg.getBindingForSession('session-dup').employeeId, 'coder');
});

test('a released session cannot be rebound or create a duplicate queue item', () => {
  const { queue, reg } = createWiredRegistry();
  const first = reg.bindSession({
    employeeId: 'coder',
    sessionId: 'session-released',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  assert.equal(first.ok, true);

  const released = reg.releaseBinding({
    sessionId: 'session-released',
    evidence: 'turn/end completed',
    nowMs: 10,
  });
  assert.equal(released.ok, true);
  const before = queue.snapshot();

  const rebound = reg.bindSession({
    employeeId: 'researcher',
    sessionId: 'session-released',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 20,
  });
  assert.equal(rebound.ok, false);
  assert.equal(rebound.code, 'SESSION_BINDING_RELEASED');
  assert.equal(reg.getBindingForSession('session-released').employeeId, 'coder');
  assert.notEqual(reg.getBindingForSession('session-released').releasedAt, null);
  assert.deepEqual(queue.snapshot(), before, 'rebind must not create a duplicate queue item');
});

test('an employee cannot hold two active bindings; second goes to queue', () => {
  const reg = createRegistry();
  const first = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-1',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  assert.equal(first.ok, true);

  const second = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-2',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 10,
  });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
  assert.ok(second.queueItemId);
  // the active binding is unchanged
  assert.equal(reg.getBindingForSession('s-1').employeeId, 'coder');
  assert.equal(reg.getBindingForSession('s-2'), null);
});

test('root sessions default-bind to orchestrator (root-default source)', () => {
  const reg = createRegistry();
  const binding = reg.bindRootSession({ sessionId: 'root-1', nowMs: 0 });
  assert.equal(binding.ok, true);
  assert.equal(binding.binding.employeeId, 'orchestrator');
  assert.equal(binding.binding.bindingSource, 'root-default');
  assert.ok(binding.binding.confidence > 0.5);

  const second = reg.bindRootSession({ sessionId: 'root-2', nowMs: 10 });
  // root-2 has no free orchestrator: queued for orchestrator
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
});

test('child runId/session registration preserves parentId relations', () => {
  const reg = createRegistry();
  reg.bindRootSession({ sessionId: 'root-1', nowMs: 0 });

  const child = reg.registerChildSession({
    parentSessionId: 'root-1',
    childSessionId: 'child-1',
    runId: 'run-11',
    nowMs: 100,
  });
  assert.equal(child.ok, true);
  assert.equal(child.child.parentSessionId, 'root-1');
  assert.equal(child.child.childSessionId, 'child-1');
  assert.equal(child.child.runId, 'run-11');

  const children = reg.listChildSessions('root-1');
  assert.deepEqual(
    children.map((c) => c.childSessionId),
    ['child-1']
  );
  assert.equal(reg.getParentOf('child-1'), 'root-1');
});

test('unclassified subagents enter the singleton collaborator FIFO queue', () => {
  const reg = createRegistry();
  const result = reg.registerUnclassifiedSubagent({
    sessionId: 'sub-unknown',
    runId: 'run-u1',
    taskSummary: 'unclassified work',
    nowMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(result.employeeId, 'collaborator');
  assert.equal(reg.getCollaboratorQueueLength(), 1);

  const second = reg.registerUnclassifiedSubagent({
    sessionId: 'sub-unknown-2',
    runId: 'run-u2',
    taskSummary: 'more work',
    nowMs: 10,
  });
  assert.equal(second.queued, true);
  assert.equal(reg.getCollaboratorQueueLength(), 2);

  // FIFO order preserved
  const head = reg.peekCollaboratorQueue();
  assert.equal(head.sessionId, 'sub-unknown');
});

test('subagent/end releases only after terminal evidence', () => {
  const reg = createRegistry();
  reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-end',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  reg.registerChildSession({
    parentSessionId: 's-end',
    childSessionId: 'child-end',
    runId: 'run-e1',
    nowMs: 10,
  });

  // end WITHOUT terminal evidence: binding stays
  const soft = reg.subagentEnd({ sessionId: 's-end', runId: 'run-e1', stopReason: 'unknown', nowMs: 20 });
  assert.equal(soft.released, false);
  assert.equal(reg.getBindingForSession('s-end').releasedAt, null);

  // end WITH terminal evidence: binding releases
  const hard = reg.subagentEnd({
    sessionId: 's-end',
    runId: 'run-e1',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 30,
  });
  assert.equal(hard.released, true);
  const binding = reg.getBindingForSession('s-end');
  assert.equal(binding.releasedAt, 30);
  assert.ok(binding.lastTask !== undefined);
});

test('cancel acknowledgement never releases the binding', () => {
  const reg = createRegistry();
  reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-cancel',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  const ack = reg.cancelAcknowledged({ sessionId: 's-cancel', nowMs: 10 });
  assert.equal(ack.released, false);
  const binding = reg.getBindingForSession('s-cancel');
  assert.equal(binding.releasedAt, null);
  assert.equal(binding.employeeId, 'coder');
});

test('released bindings keep redacted last task and result', () => {
  const reg = createRegistry();
  reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-redact',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
    taskSummary: 'refactor the login flow using password hash secret-value-123',
  });
  const released = reg.releaseBinding({
    sessionId: 's-redact',
    nowMs: 100,
    evidence: 'turn/end completed',
    outcome: 'completed',
    resultSummary: 'success with secret-token-456',
  });
  assert.equal(released.ok, true);
  const binding = reg.getBindingForSession('s-redact');
  assert.equal(binding.releasedAt, 100);
  assert.ok(binding.lastTask.length > 0);
  assert.ok(binding.lastResult.length > 0);
  // redaction: secrets do not survive
  assert.equal(binding.lastTask.includes('secret-value-123'), false);
  assert.equal(binding.lastResult.includes('secret-token-456'), false);
  assert.equal(JSON.stringify(binding).includes('secret'), false);
});

test('release makes the employee free again for a new binding', () => {
  const reg = createRegistry();
  reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-cycle',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  const busy = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-next',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 10,
  });
  assert.equal(busy.queued, true);

  reg.releaseBinding({ sessionId: 's-cycle', nowMs: 100, evidence: 'turn/end completed', outcome: 'completed' });
  const freed = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-next',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 110,
  });
  assert.equal(freed.ok, true);
  assert.ok(!freed.queued, 'direct bind after release, not queued');
});

test('offline is never produced; presence stays present', () => {
  const reg = createRegistry();
  for (const employee of reg.listEmployees()) {
    assert.equal(employee.presence, 'present');
  }
  const snapshot = JSON.stringify(reg.listEmployees());
  assert.equal(snapshot.includes('offline'), false);
});

test('registry state is frozen and JSON-replayable', () => {
  const reg = createRegistry();
  reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-replay',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 5,
  });
  const a = JSON.stringify(reg.snapshot());
  const b = JSON.stringify(reg.snapshot());
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.equal(parsed.employees.length, 5);
  assert.equal(Object.isFrozen(reg.snapshot()), true);
});

test('collaborator releases its binding before the next FIFO item is assigned', () => {
  const reg = createRegistry();
  reg.registerUnclassifiedSubagent({ sessionId: 'c-1', runId: 'r1', taskSummary: 'a', nowMs: 0 });
  reg.registerUnclassifiedSubagent({ sessionId: 'c-2', runId: 'r2', taskSummary: 'b', nowMs: 10 });

  const assigned = reg.assignNextCollaboratorItem({ nowMs: 20 });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.item.sessionId, 'c-1');
  assert.equal(reg.getBindingForSession('c-1').employeeId, 'collaborator');
  assert.equal(reg.getCollaboratorQueueLength(), 1);

  // release is atomic with assigning the next item
  const next = reg.releaseCollaboratorAndAssignNext({
    sessionId: 'c-1',
    evidence: 'subagent/end completed',
    nowMs: 30,
  });
  assert.equal(next.ok, true);
  assert.equal(next.item.sessionId, 'c-2');
  assert.equal(reg.getBindingForSession('c-1').releasedAt, 30);
  assert.equal(reg.getBindingForSession('c-2').employeeId, 'collaborator');
  assert.equal(reg.getCollaboratorQueueLength(), 0);
});

// ---- Review round: D. the queue-controller is the single source of truth ----

test('busy resident requests are queued in the single injected queue-controller', () => {
  const { queue, reg } = createWiredRegistry();
  const first = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-1',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
  });
  assert.equal(first.ok, true);
  assert.equal(first.queued, false);

  const second = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-2',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 10,
    taskSummary: 'queued work',
  });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
  // the returned queueItemId is REAL and lives in the injected queue
  const item = queue.getItem(second.queueItemId);
  assert.ok(item, 'queue item exists in the shared queue-controller');
  assert.equal(item.sessionId, 's-2');
  assert.equal(item.status, 'queued');
  assert.equal(queue.waitingCount('coder'), 1);
  assert.deepEqual(
    queue.waitingItems('coder').map((entry) => entry.sessionId),
    ['s-2']
  );
  // no duplicate session: a second request for the same queued session fails
  const dup = reg.bindSession({
    employeeId: 'coder',
    sessionId: 's-2',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 20,
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'SESSION_ALREADY_QUEUED');
});

test('consecutive unclassified subagents share the collaborator FIFO in the queue-controller', () => {
  const { queue, reg } = createWiredRegistry();
  const results = [];
  const sessions = ['u-1', 'u-2', 'u-3'];
  for (const [index, sessionId] of sessions.entries()) {
    const result = reg.registerUnclassifiedSubagent({
      sessionId,
      runId: `run-${index}`,
      taskSummary: `work ${index}`,
      nowMs: index * 10,
    });
    assert.equal(result.ok, true);
    assert.equal(result.queued, true);
    assert.equal(result.employeeId, 'collaborator');
    results.push(result);
  }
  // distinct, real queue item ids readable from the shared queue
  assert.equal(new Set(results.map((r) => r.queueItemId)).size, 3);
  for (const result of results) {
    assert.ok(queue.getItem(result.queueItemId));
  }
  assert.equal(queue.waitingCount('collaborator'), 3);
  assert.deepEqual(
    queue.waitingItems('collaborator').map((entry) => entry.sessionId),
    ['u-1', 'u-2', 'u-3'],
    'registry view and queue-controller FIFO agree'
  );
  assert.equal(reg.getCollaboratorQueueLength(), 3);
  assert.equal(reg.peekCollaboratorQueue().sessionId, 'u-1');
  // duplicate session cannot enter the FIFO twice
  const dup = reg.registerUnclassifiedSubagent({ sessionId: 'u-2', runId: 'run-x', nowMs: 40 });
  assert.equal(dup.ok, false);
});

test('release then dispatch next reads the same queue FIFO without losing tasks', () => {
  const { queue, reg } = createWiredRegistry();
  reg.registerUnclassifiedSubagent({ sessionId: 'c-1', runId: 'r1', taskSummary: 'a', nowMs: 0 });
  reg.registerUnclassifiedSubagent({ sessionId: 'c-2', runId: 'r2', taskSummary: 'b', nowMs: 10 });

  const assigned = reg.assignNextCollaboratorItem({ nowMs: 20 });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.item.sessionId, 'c-1');
  assert.equal(queue.activeItem('collaborator').sessionId, 'c-1', 'active item tracked in the queue');
  assert.equal(queue.waitingCount('collaborator'), 1, 'head left the shared FIFO');
  assert.equal(reg.getBindingForSession('c-1').employeeId, 'collaborator');

  const next = reg.releaseCollaboratorAndAssignNext({
    sessionId: 'c-1',
    evidence: 'subagent/end completed',
    nowMs: 30,
  });
  assert.equal(next.ok, true);
  assert.equal(next.item.sessionId, 'c-2', 'next FIFO item dispatched atomically');
  assert.equal(queue.activeItem('collaborator').sessionId, 'c-2');
  assert.equal(reg.getBindingForSession('c-1').releasedAt, 30);
  assert.equal(reg.getBindingForSession('c-2').employeeId, 'collaborator');
  assert.equal(queue.waitingCount('collaborator'), 0);
});

test('resident release atomically dispatches the next queued item from the same FIFO', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'r-1', bindingSource: 'manual', confidence: 1, nowMs: 0, taskSummary: 'first' });
  reg.bindSession({ employeeId: 'coder', sessionId: 'r-2', bindingSource: 'manual', confidence: 1, nowMs: 10, taskSummary: 'second' });
  assert.equal(queue.waitingCount('coder'), 1);
  assert.equal(queue.activeItem('coder').sessionId, 'r-1');

  const released = reg.releaseBinding({
    sessionId: 'r-1',
    nowMs: 20,
    evidence: 'turn/end completed',
    outcome: 'completed',
  });
  assert.equal(released.ok, true);
  // atomic switch inside the SAME queue-controller state
  assert.equal(queue.activeItem('coder').sessionId, 'r-2');
  assert.equal(queue.activeItem('coder').status, 'dispatching');
  assert.equal(reg.getBindingForSession('r-1').releasedAt, 20);
  assert.equal(reg.getBindingForSession('r-2').employeeId, 'coder');
  assert.equal(queue.waitingCount('coder'), 0);
  assert.ok(!released.binding.lastResult.includes('secret'), 'redaction contract holds');
});

test('privacy redaction flows through the shared queue items', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({
    employeeId: 'researcher',
    sessionId: 'p-1',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 0,
    taskSummary: 'search for secret-value-42',
  });
  reg.bindSession({
    employeeId: 'researcher',
    sessionId: 'p-2',
    bindingSource: 'manual',
    confidence: 1,
    nowMs: 10,
    taskSummary: 'search for secret-value-99',
  });
  const waiting = queue.waitingItems('researcher');
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].taskSummary, '[redacted]');
  assert.equal(JSON.stringify(queue.snapshot()).includes('secret'), false);
});

test('unmappable evidence never releases a binding or closes a queue item', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'e-1', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  const result = reg.releaseBinding({ sessionId: 'e-1', nowMs: 10, evidence: 'cancel-ack' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TERMINAL_EVIDENCE_REQUIRED');
  assert.equal(reg.getBindingForSession('e-1').releasedAt, null, 'binding retained');
  assert.equal(queue.activeItem('coder').sessionId, 'e-1', 'queue item also retained');
});

// ---- Review round 2: effects propagation, intent metadata, runId, desync ----

test('releaseBinding propagates the real queue-controller effects chain', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'one', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 'two', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  assert.equal(queue.activeItem('coder').sessionId, 'one');

  const released = reg.releaseBinding({ sessionId: 'one', evidence: 'turn/end completed', nowMs: 20 });
  assert.equal(released.ok, true);
  assert.deepEqual(
    released.effects.map((effect) => effect.type),
    ['release-binding', 'dispatch-started', 'binding-pending'],
    'the queue-controller effects chain is returned verbatim and in order'
  );
  const [rb, ds, bp] = released.effects;
  assert.equal(rb.sessionId, 'one');
  assert.equal(rb.employeeId, 'coder');
  assert.ok(rb.queueItemId);
  assert.equal(rb.outcome, 'completed');
  assert.equal(ds.employeeId, 'coder');
  assert.equal(ds.sessionId, 'two');
  assert.ok(ds.queueItemId);
  assert.equal(ds.requireFreshPath, true, 'no stale path reuse on the switched task');
  assert.equal(bp.employeeId, 'coder');
  assert.equal(bp.sessionId, 'two');
  // registry and queue agree after the switch
  assert.equal(reg.getBindingForSession('two').employeeId, 'coder');
  assert.equal(queue.activeItem('coder').sessionId, 'two');
});

test('subagentEnd terminal path propagates the same effects chain', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'se-one', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 'se-two', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  reg.registerChildSession({ parentSessionId: 'se-one', childSessionId: 'se-child', runId: 'run-1', nowMs: 5 });

  const result = reg.subagentEnd({
    sessionId: 'se-one',
    runId: 'run-1',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.deepEqual(
    result.effects.map((effect) => effect.type),
    ['release-binding', 'dispatch-started', 'binding-pending']
  );
  assert.equal(result.effects[0].sessionId, 'se-one');
  assert.equal(result.effects[1].sessionId, 'se-two');
  assert.equal(result.effects[1].requireFreshPath, true);
  assert.equal(reg.getBindingForSession('se-two').employeeId, 'coder');
  assert.equal(queue.activeItem('coder').sessionId, 'se-two');
});

test('releaseCollaboratorAndAssignNext propagates the queue effects chain', () => {
  const { reg } = createWiredRegistry();
  reg.registerUnclassifiedSubagent({ sessionId: 'u-1', runId: 'r1', taskSummary: 'a', nowMs: 0 });
  reg.registerUnclassifiedSubagent({ sessionId: 'u-2', runId: 'r2', taskSummary: 'b', nowMs: 10 });
  reg.assignNextCollaboratorItem({ nowMs: 20 });

  const next = reg.releaseCollaboratorAndAssignNext({
    sessionId: 'u-1',
    evidence: 'subagent/end completed',
    nowMs: 30,
  });
  assert.equal(next.ok, true);
  assert.deepEqual(
    next.effects.map((effect) => effect.type),
    ['release-binding', 'dispatch-started', 'binding-pending']
  );
  assert.equal(next.effects[0].sessionId, 'u-1');
  assert.equal(next.effects[1].sessionId, 'u-2');
  assert.equal(next.effects[1].requireFreshPath, true);
  assert.equal(next.item.sessionId, 'u-2');
});

test('queued sessions keep their binding intent and restore it on dispatch', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'm-free', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  const m = reg.bindSession({ employeeId: 'coder', sessionId: 'm-busy', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  const r = reg.bindSession({ employeeId: 'coder', sessionId: 'r-busy', bindingSource: 'root-default', confidence: 0.9, nowMs: 20 });
  const h = reg.bindSession({ employeeId: 'coder', sessionId: 'h-busy', bindingSource: 'heuristic', confidence: 0.4, nowMs: 30 });
  for (const result of [m, r, h]) {
    assert.equal(result.queued, true);
  }
  assert.equal(queue.waitingCount('coder'), 3);

  // the pending intent metadata carries ONLY source/confidence — it is
  // classification metadata, not a second queue (no order/status/item ids)
  const intents = reg.snapshot().pendingBindingIntents;
  assert.deepEqual(Object.keys(intents).sort(), ['h-busy', 'm-busy', 'r-busy']);
  for (const intent of Object.values(intents)) {
    assert.deepEqual(Object.keys(intent).sort(), ['bindingSource', 'confidence']);
  }

  reg.releaseBinding({ sessionId: 'm-free', evidence: 'turn/end completed', nowMs: 40 });
  let binding = reg.getBindingForSession('m-busy');
  assert.equal(binding.employeeId, 'coder');
  assert.equal(binding.bindingSource, 'manual', 'manual intent restored, not degraded to heuristic');
  assert.equal(binding.confidence, 1);

  reg.releaseBinding({ sessionId: 'm-busy', evidence: 'turn/end completed', nowMs: 50 });
  binding = reg.getBindingForSession('r-busy');
  assert.equal(binding.bindingSource, 'root-default');
  assert.equal(binding.confidence, 0.9);

  reg.releaseBinding({ sessionId: 'r-busy', evidence: 'turn/end completed', nowMs: 60 });
  binding = reg.getBindingForSession('h-busy');
  assert.equal(binding.bindingSource, 'heuristic');
  assert.equal(binding.confidence, 0.4);

  // consumed intents disappear once bound
  assert.deepEqual(reg.snapshot().pendingBindingIntents, {});
});

test('unclassified collaborator items dispatch with the heuristic default', () => {
  const { reg } = createWiredRegistry();
  reg.registerUnclassifiedSubagent({ sessionId: 'u-def', runId: 'r1', taskSummary: 'a', nowMs: 0 });
  const assigned = reg.assignNextCollaboratorItem({ nowMs: 10 });
  assert.equal(assigned.ok, true);
  assert.equal(assigned.binding.bindingSource, 'heuristic');
  assert.equal(assigned.binding.confidence, 0.4);
});

test('subagent end with a mismatched runId never releases the binding', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-run', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 's-run', childSessionId: 'child-run', runId: 'run-42', nowMs: 5 });

  const mismatch = reg.subagentEnd({
    sessionId: 's-run',
    runId: 'run-99',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 10,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'RUN_ID_MISMATCH');
  assert.equal(reg.getBindingForSession('s-run').releasedAt, null, 'binding retained');
  assert.equal(queue.activeItem('coder').sessionId, 's-run', 'queue item untouched');

  const verified = reg.subagentEnd({
    sessionId: 's-run',
    runId: 'run-42',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.released, true);
  assert.equal(reg.getBindingForSession('s-run').releasedAt, 20);
});

test('runId verifies against the child-session form as well', () => {
  const { reg } = createWiredRegistry();
  reg.bindRootSession({ sessionId: 'root-1', nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 'root-1', childSessionId: 'child-1', runId: 'run-11', nowMs: 5 });
  reg.bindSession({ employeeId: 'researcher', sessionId: 'child-1', bindingSource: 'heuristic', confidence: 0.4, nowMs: 10 });

  const mismatch = reg.subagentEnd({
    sessionId: 'child-1',
    runId: 'run-xx',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'RUN_ID_MISMATCH');
  assert.equal(reg.getBindingForSession('child-1').releasedAt, null);

  const verified = reg.subagentEnd({
    sessionId: 'child-1',
    runId: 'run-11',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 30,
  });
  assert.equal(verified.released, true);
});

test('a runId with no verifiable relation fails closed as RUN_ID_UNVERIFIED', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-norel', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  const result = reg.subagentEnd({
    sessionId: 's-norel',
    runId: 'run-ghost',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 10,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUN_ID_UNVERIFIED');
  assert.equal(reg.getBindingForSession('s-norel').releasedAt, null);
  assert.equal(queue.activeItem('coder').sessionId, 's-norel');
});

test('session-level end without runId keeps the compatible semantics', () => {
  const { reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-compat', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  const soft = reg.subagentEnd({ sessionId: 's-compat', stopReason: 'unknown', nowMs: 10 });
  assert.equal(soft.released, false);
  const hard = reg.subagentEnd({ sessionId: 's-compat', stopReason: 'completed', terminalEvidence: true, nowMs: 20 });
  assert.equal(hard.released, true);
  assert.equal(reg.getBindingForSession('s-compat').releasedAt, 20);
});

test('releaseBinding fails closed when the queue item is no longer active', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'd-one', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 'd-two', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  // simulate desync: the queue item is closed behind the registry's back
  const direct = queue.noteTerminalEvidence({
    queueItemId: queue.activeItem('coder').queueItemId,
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 15,
  });
  assert.equal(direct.ok, true);

  const result = reg.releaseBinding({ sessionId: 'd-one', evidence: 'turn/end completed', nowMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUEUE_ITEM_DESYNC');
  assert.equal(reg.getBindingForSession('d-one').releasedAt, null, 'binding stays active (fail-closed)');
});

test('a failing queue close keeps the registry binding active', () => {
  const real = createQueueController({ seats: ALL_SEATS, collaboratorId: 'collaborator' });
  const failingQueue = Object.freeze({
    ...real,
    noteTerminalEvidence: () => Object.freeze({ ok: false, code: 'INJECTED_FAILURE' }),
  });
  const reg = registry.createEmployeeRegistry({ queueController: failingQueue });
  reg.bindSession({ employeeId: 'coder', sessionId: 'f-one', bindingSource: 'manual', confidence: 1, nowMs: 0 });

  const result = reg.releaseBinding({ sessionId: 'f-one', evidence: 'turn/end completed', nowMs: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INJECTED_FAILURE');
  assert.equal(reg.getBindingForSession('f-one').releasedAt, null, 'ledger not moved before queue confirms');
});

test('collaborator release fails closed when the queue item is missing', () => {
  const { queue, reg } = createWiredRegistry();
  reg.registerUnclassifiedSubagent({ sessionId: 'u-desync', runId: 'r1', taskSummary: 'a', nowMs: 0 });
  reg.assignNextCollaboratorItem({ nowMs: 10 });
  queue.noteTerminalEvidence({
    queueItemId: queue.activeItem('collaborator').queueItemId,
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 15,
  });

  const result = reg.releaseCollaboratorAndAssignNext({
    sessionId: 'u-desync',
    evidence: 'subagent/end completed',
    nowMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUEUE_ITEM_DESYNC');
  assert.equal(reg.getBindingForSession('u-desync').releasedAt, null);
});

test('subagentEnd fails closed when the queue item is not active', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'sd-one', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 'sd-one', childSessionId: 'sd-child', runId: 'run-1', nowMs: 5 });
  queue.noteTerminalEvidence({
    queueItemId: queue.activeItem('coder').queueItemId,
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 10,
  });

  const result = reg.subagentEnd({
    sessionId: 'sd-one',
    runId: 'run-1',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'QUEUE_ITEM_DESYNC');
  assert.equal(reg.getBindingForSession('sd-one').releasedAt, null);
});

// ---- Review round 3: runId verification across multiple child agents -------

test('a parent with several registered children accepts any registered runId', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'p-multi', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 'p-multi', childSessionId: 'c-1', runId: 'run-1', nowMs: 5 });
  reg.registerChildSession({ parentSessionId: 'p-multi', childSessionId: 'c-2', runId: 'run-2', nowMs: 6 });

  // the SECOND registered child's runId verifies (previously only the first
  // child's runId was consulted)
  const viaSecond = reg.subagentEnd({
    sessionId: 'p-multi',
    runId: 'run-2',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 10,
  });
  assert.equal(viaSecond.ok, true);
  assert.equal(viaSecond.released, true);
  assert.equal(reg.getBindingForSession('p-multi').releasedAt, 10);
  assert.equal(queue.activeItem('coder'), null, 'empty queue: seat fully released');
});

test('an unknown runId against a multi-child parent is rejected fail-closed', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 'p-miss', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 'p-miss', childSessionId: 'c-1', runId: 'run-1', nowMs: 5 });
  reg.registerChildSession({ parentSessionId: 'p-miss', childSessionId: 'c-2', runId: 'run-2', nowMs: 6 });

  const mismatch = reg.subagentEnd({
    sessionId: 'p-miss',
    runId: 'run-unknown',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 10,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'RUN_ID_MISMATCH');
  assert.equal(reg.getBindingForSession('p-miss').releasedAt, null, 'binding untouched');
  assert.equal(queue.activeItem('coder').sessionId, 'p-miss', 'queue item untouched');

  // a later correct runId still releases
  const verified = reg.subagentEnd({
    sessionId: 'p-miss',
    runId: 'run-1',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.released, true);
  assert.equal(reg.getBindingForSession('p-miss').releasedAt, 20);
});

test('child-session runId form verifies independently of parent siblings', () => {
  const { reg } = createWiredRegistry();
  reg.bindRootSession({ sessionId: 'root-multi', nowMs: 0 });
  reg.registerChildSession({ parentSessionId: 'root-multi', childSessionId: 'child-a', runId: 'run-a', nowMs: 5 });
  reg.registerChildSession({ parentSessionId: 'root-multi', childSessionId: 'child-b', runId: 'run-b', nowMs: 6 });
  reg.bindSession({ employeeId: 'researcher', sessionId: 'child-b', bindingSource: 'heuristic', confidence: 0.4, nowMs: 10 });

  const wrong = reg.subagentEnd({
    sessionId: 'child-b',
    runId: 'run-a',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 20,
  });
  assert.equal(wrong.ok, false, 'a sibling runId does not verify a different child session');
  assert.equal(wrong.code, 'RUN_ID_MISMATCH');
  assert.equal(reg.getBindingForSession('child-b').releasedAt, null);

  const right = reg.subagentEnd({
    sessionId: 'child-b',
    runId: 'run-b',
    stopReason: 'completed',
    terminalEvidence: true,
    nowMs: 30,
  });
  assert.equal(right.released, true);
  assert.equal(reg.getBindingForSession('child-b').releasedAt, 30);
});

// ---------------------------------------------------------------------------
// Task 7B — retainQueuedTerminal: terminal evidence for QUEUED sessions
// ---------------------------------------------------------------------------

test('retainQueuedTerminal closes a queued session with its terminal outcome', () => {
  const { queue, reg } = createWiredRegistry();
  // seat busy: s-head dispatched, s-queued waiting
  reg.bindSession({ employeeId: 'coder', sessionId: 's-head', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  const enqueued = reg.bindSession({ employeeId: 'coder', sessionId: 's-queued', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  assert.equal(enqueued.queued, true);

  for (const [outcome, evidenceType] of [['completed', 'turn-end'], ['failed', 'turn-end'], ['cancelled', 'turn-end']]) {
    const enq = reg.bindSession({ employeeId: 'coder', sessionId: `s-q-${outcome}`, bindingSource: 'manual', confidence: 1, nowMs: 20 });
    assert.equal(enq.queued, true);
    const retained = reg.retainQueuedTerminal({ sessionId: `s-q-${outcome}`, evidenceType, outcome, nowMs: 30 });
    assert.equal(retained.ok, true, `${outcome} retained`);
    assert.equal(retained.closed, true);
    assert.equal(retained.outcome, outcome);
    assert.equal(retained.dispatched, false);
  }
  // every retained session left the waiting queue; the head item is untouched
  assert.deepEqual(
    queue.waitingItems('coder').map((entry) => entry.sessionId),
    ['s-queued']
  );
});

test('retainQueuedTerminal consumes the binding intent of the retained session', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-head', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 's-queued-root', bindingSource: 'root-default', confidence: 0.9, nowMs: 10 });
  const retained = reg.retainQueuedTerminal({ sessionId: 's-queued-root', evidenceType: 'turn-end', outcome: 'cancelled', nowMs: 20 });
  assert.equal(retained.ok, true);
  assert.equal(queue.waitingCount('coder'), 0, 'cancelled retention removes the waiting item immediately');
});

test('retainQueuedTerminal keeps strict FIFO: closing a later item never touches the head', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-head', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 's-first', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  reg.bindSession({ employeeId: 'coder', sessionId: 's-second', bindingSource: 'manual', confidence: 1, nowMs: 20 });
  // the LATER item's terminal closes only the later item
  const retained = reg.retainQueuedTerminal({ sessionId: 's-second', evidenceType: 'turn-end', outcome: 'failed', nowMs: 30 });
  assert.equal(retained.ok, true);
  assert.deepEqual(
    queue.waitingItems('coder').map((entry) => entry.sessionId),
    ['s-first'],
    'the FIFO head item is untouched'
  );
});

test('retainQueuedTerminal verifies subagent runIds fail closed', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'collaborator', sessionId: 'c-head', bindingSource: 'heuristic', confidence: 0.4, nowMs: 0 });
  reg.registerUnclassifiedSubagent({ sessionId: 'c-queued-child', runId: 'run-sha256:good', nowMs: 10 });
  const mismatch = reg.retainQueuedTerminal({
    sessionId: 'c-queued-child', evidenceType: 'subagent-end', outcome: 'completed', runId: 'run-sha256:evil', nowMs: 20,
  });
  assert.equal(mismatch.ok, false, 'runId mismatch fails closed');
  assert.equal(mismatch.code, 'RUN_ID_MISMATCH');
  assert.equal(queue.waitingCount('collaborator'), 1, 'the queued item is NOT closed by a mismatched run');

  const verified = reg.retainQueuedTerminal({
    sessionId: 'c-queued-child', evidenceType: 'subagent-end', outcome: 'completed', runId: 'run-sha256:good', nowMs: 30,
  });
  assert.equal(verified.ok, true, 'the matching runId closes the queued subagent');
  assert.equal(queue.waitingCount('collaborator'), 0);
});

test('retainQueuedTerminal fails closed for sessions that are not queued', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-active', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  // active (dispatched) session: the caller must use the active-binding path
  const active = reg.retainQueuedTerminal({ sessionId: 's-active', evidenceType: 'turn-end', outcome: 'completed', nowMs: 10 });
  assert.equal(active.ok, false);
  assert.equal(active.code, 'SESSION_NOT_QUEUED');
  // unknown session: same stable failure
  const unknown = reg.retainQueuedTerminal({ sessionId: 's-ghost', evidenceType: 'turn-end', outcome: 'completed', nowMs: 10 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'SESSION_NOT_QUEUED');
  assert.equal(queue.waitingCount('coder'), 0);
});

test('closeQueuedItem rejects queueItemId/sessionId mismatch fail closed', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'coder', sessionId: 's-head', bindingSource: 'manual', confidence: 1, nowMs: 0 });
  reg.bindSession({ employeeId: 'coder', sessionId: 's-queued', bindingSource: 'manual', confidence: 1, nowMs: 10 });
  const queuedItem = queue.waitingItems('coder')[0];
  const mismatch = queue.closeQueuedItem({
    queueItemId: queuedItem.queueItemId,
    sessionId: 's-OTHER',
    evidenceType: 'turn-end',
    outcome: 'completed',
    nowMs: 20,
  });
  assert.equal(mismatch.ok, false, 'queueItemId/sessionId mismatch fails closed');
  assert.equal(mismatch.code, 'QUEUE_ITEM_SESSION_MISMATCH');
  assert.equal(queue.waitingCount('coder'), 1, 'the mismatched close never removes the item');
});

test('normal dispatch and release cycles leave no queued identity records', () => {
  const { queue, reg } = createWiredRegistry();
  reg.bindSession({ employeeId: 'collaborator', sessionId: 'c-head', bindingSource: 'heuristic', confidence: 0.4, nowMs: 0 });
  // the module classifies the spawning root session before subagent flows
  reg.bindSession({ employeeId: 'orchestrator', sessionId: 'c-root', bindingSource: 'root-default', confidence: 0.9, nowMs: 2 });
  // release the head so each cycle dispatches its own queued run
  reg.subagentEnd({ sessionId: 'c-head', stopReason: 'completed', terminalEvidence: true, nowMs: 5 });
  for (let cycle = 0; cycle < 6; cycle += 1) {
    reg.registerUnclassifiedSubagent({ sessionId: `c-run-${cycle}`, runId: `run-sha256:${cycle}`, nowMs: 10 + cycle });
    // the module registers the child relation as well (Task 6 proxy contract)
    reg.registerChildSession({ parentSessionId: 'c-root', childSessionId: `c-run-${cycle}`, runId: `run-sha256:${cycle}`, nowMs: 15 + cycle });
    const assigned = reg.assignNextCollaboratorItem({ nowMs: 20 + cycle });
    assert.equal(assigned.ok, true, `cycle ${cycle} dispatches`);
    const released = reg.subagentEnd({
      sessionId: `c-run-${cycle}`, runId: `run-sha256:${cycle}`, stopReason: 'completed',
      terminalEvidence: true, nowMs: 30 + cycle,
    });
    assert.equal(released.ok, true, `cycle ${cycle} releases`);
  }
  assert.equal(reg.identityLedgerCount(), 0, 'no identity records survive normal dispatch/release cycles');
});
