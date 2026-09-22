'use strict';

// Task 4 — golden workstation task transition loop (office-module integration).
//
// RED: office-module.js still routes tasks straight to the desk node and
// collapses arrive/sit/work inside arriveAtNode. These tests pin the
// clock-driven phase path:
//   route-to-approach -> approach-to-seat (anchor interpolation) -> work
//   -> result -> seat-to-approach (anchor interpolation) -> route-to-leave
// plus preTask capture-once semantics, workstation reservation ownership,
// reduced-motion zero durations and stable degradation.

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

const LAYOUT = officeLayout.createOfficeLayout(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8'))
);

function makeModule(config = {}, seed = 'office-transition-loop-seed') {
  return officeModule.createOfficeModule({
    pack: PACK,
    seed,
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160, ...config },
  });
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

function emp(state, id = 'orchestrator') {
  return state.employees.find((candidate) => candidate.employeeId === id);
}

function startTask(module, sessionId, seq = 1) {
  return module.ingestHarnessEvent({
    sessionId,
    type: 'agent/status',
    seq,
    time: seq,
    data: { status: 'running' },
  });
}

function tickUntilRoamingAwayFromDesk(module) {
  const roamNodes = module.layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id));
  // the employee must DWELL at a roam node (not merely pass by): only then is
  // its current graph node a roam node, which becomes the preTask origin
  const parked = tickUntil(module, (state) => {
    const employee = emp(state);
    return employee
      && employee.movement === 'stationary'
      && roamNodes.some((node) => Math.hypot(employee.position.x - node.position.x, employee.position.y - node.position.y) < 0.02);
  }, 240000);
  assert.equal(parked, true, 'orchestrator dwells at a roaming node before the task starts');
}

function runUntilWork(module, sessionId = 'sess-loop') {
  tickUntilRoamingAwayFromDesk(module);
  startTask(module, sessionId);
  const sitting = tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.segment && employee.segment.kind === 'approach-to-seat';
  });
  assert.equal(sitting, true, 'route-to-approach completes into the approach-to-seat segment');
  const working = tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.transition && employee.transition.phase === 'work';
  });
  assert.equal(working, true, 'sit completes into the work phase');
}

test('task route ends at the workstation approach and preTask origin is captured once', () => {
  const module = makeModule();
  tickUntilRoamingAwayFromDesk(module);
  const before = emp(module.state());
  startTask(module, 'sess-approach');

  const started = emp(module.state());
  assert.equal(started.transition && started.transition.kind, 'task-start');
  assert.equal(started.transition.phase, 'move', 'stop/turn advance with zero duration into move');
  assert.ok(started.preTaskNodeId && started.preTaskNodeId.startsWith('roam-'), 'non-desk preTask node captured');
  assert.ok(started.workstation && started.workstation.deskId === 'desk-1');

  const sitting = tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.segment && employee.segment.kind === 'approach-to-seat';
  });
  assert.equal(sitting, true);
  const atApproach = emp(module.state());
  const approach = LAYOUT.nodeById('desk-1-approach');
  assert.deepEqual(atApproach.position, { x: approach.position.x, y: approach.position.y }, 'route ends exactly on the approach anchor');
  assert.equal(atApproach.transition.phase, 'sit');
  assert.equal(atApproach.preTaskNodeId, started.preTaskNodeId, 'preTask survives phase advances');

  // a repeated running fact must not restart the route or recapture preTask
  startTask(module, 'sess-approach', 5);
  const again = emp(module.state());
  assert.equal(again.transition.phase, 'sit', 'repeated task events never restart the active transition');
  assert.equal(again.preTaskNodeId, started.preTaskNodeId, 'preTask origin is captured exactly once');
  assert.deepEqual(again.position, atApproach.position);
});

test('approach-to-seat interpolates to the exact seat anchor without jumps and holds the workstation', () => {
  const module = makeModule();
  runUntilWork(module, 'sess-sit');
  const working = emp(module.state());
  const seat = LAYOUT.nodeById('desk-1');
  assert.deepEqual(working.position, { x: seat.position.x, y: seat.position.y }, 'sit lands exactly on the seat anchor');
  assert.equal(working.workstation !== null, true, 'workstation reservation held through work');
  assert.equal(working.segment, null);
  assert.equal(working.movement, 'stationary');
});

test('completed task presents the result, stands, then leaves back to the preTask node', () => {
  const module = makeModule();
  tickUntilRoamingAwayFromDesk(module);
  startTask(module, 'sess-complete');
  tickUntil(module, (state) => emp(state).transition && emp(state).transition.phase === 'work');
  const preTaskNodeId = emp(module.state()).preTaskNodeId;

  module.ingestHarnessEvent({
    sessionId: 'sess-complete', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' },
  });
  const presenting = emp(module.state());
  assert.equal(presenting.transition.phase, 'result');
  assert.equal(presenting.lastResult && presenting.lastResult.outcome, 'completed');
  const frozen = presenting.position;
  tickFor(module, 200);
  assert.deepEqual(emp(module.state()).position, frozen, 'result presentation holds the position (no early stand)');

  const standing = tickUntil(module, (state) => emp(state).segment && emp(state).segment.kind === 'seat-to-approach');
  assert.equal(standing, true, 'stand is the reversed seat-to-approach interpolation');
  const leaving = tickUntil(module, (state) => emp(state).transition && emp(state).transition.phase === 'leave');
  assert.equal(leaving, true);
  const atLeave = emp(module.state());
  assert.equal(atLeave.workstation, null, 'workstation reservation released only after stand reached approach + leave route acquired');
  assert.equal(atLeave.preTaskNodeId, preTaskNodeId, 'preTask clears only after leave completes');

  const done = tickUntil(module, (state) => emp(state).transition === null);
  assert.equal(done, true, 'leave completes and releases the transition');
  const finished = emp(module.state());
  assert.equal(finished.preTaskNodeId, null, 'preTask cleared after leave completes');
  const leaveNode = LAYOUT.nodeById(
    module.layout.nodes().find((node) => node.id === preTaskNodeId).id
  );
  assert.deepEqual(finished.position, { x: leaveNode.position.x, y: leaveNode.position.y }, 'leave ends at the original preTask node');
  const resumed = tickUntil(module, (state) => ['roaming', 'chatting', 'resting', 'sleeping'].includes(emp(state).activity));
  assert.equal(resumed, true, 'local behavior resumes only after the leave arrival');
});

test('failed task presents the failed result with the error animation state', () => {
  const module = makeModule();
  runUntilWork(module, 'sess-failed');
  module.ingestHarnessEvent({
    sessionId: 'sess-failed', type: 'turn/end', seq: 2, time: 2, data: { reason: 'failed' },
  });
  const presenting = emp(module.state());
  assert.equal(presenting.transition.phase, 'result');
  assert.equal(presenting.lastResult && presenting.lastResult.outcome, 'failed');
  assert.equal(presenting.animation.resource, 'error', 'failed result resolves the error expression');
});

test('repeated terminal evidence cannot double-present or restart the result', () => {
  const module = makeModule();
  runUntilWork(module, 'sess-dup');
  module.ingestHarnessEvent({ sessionId: 'sess-dup', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const first = emp(module.state()).lastResult;
  module.ingestHarnessEvent({ sessionId: 'sess-dup', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  assert.deepEqual(emp(module.state()).lastResult, first, 'duplicate terminal evidence is ignored');
});

test('cancellation clears the workstation, transition and preTask without a result', () => {
  const module = makeModule();
  runUntilWork(module, 'sess-cancel');
  module.ingestHarnessEvent({
    sessionId: 'sess-cancel', type: 'turn/end', seq: 2, time: 2, data: { reason: 'cancelled' },
  });
  const released = emp(module.state());
  assert.equal(released.transition, null, 'cancelled terminal releases immediately');
  assert.equal(released.workstation, null, 'workstation reservation released by the explicit cleanup');
  assert.equal(released.preTaskNodeId, null, 'cancellation clears the preTask state');
  assert.equal(released.lastResult && released.lastResult.outcome, 'cancelled');
  assert.equal(released.presence, 'present', 'the employee stays visible');
  const resumed = tickUntil(module, (state) => ['roaming', 'chatting', 'resting', 'sleeping'].includes(emp(state).activity), 30000);
  assert.equal(resumed, true);
});

test('reduced motion collapses every phase duration to zero', () => {
  const module = makeModule({ reducedMotion: true });
  tickFor(module, 64);
  startTask(module, 'sess-reduced');
  tickFor(module, 96);
  const working = emp(module.state());
  assert.equal(working.transition && working.transition.phase, 'work', 'route + sit complete with zero durations');
  assert.deepEqual(working.position, { x: LAYOUT.nodeById('desk-1').position.x, y: LAYOUT.nodeById('desk-1').position.y });
  module.ingestHarnessEvent({
    sessionId: 'sess-reduced', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' },
  });
  const done = tickUntil(module, (state) => emp(state).transition === null && emp(state).workstation === null, 4000);
  assert.equal(done, true, 'result/stand/leave complete without presentation delay');
  assert.equal(emp(module.state()).preTaskNodeId, null);
});

test('task started at the own desk leaves to the nearest reachable roaming node', () => {
  const module = makeModule();
  // orchestrator still sits at desk-1: preTaskNodeId must stay null (desk nodes are never preTask origins)
  startTask(module, 'sess-desk');
  const started = emp(module.state());
  assert.equal(started.preTaskNodeId, null, 'desk nodes are never captured as preTask origins');
  tickUntil(module, (state) => emp(state).transition && emp(state).transition.phase === 'work');
  module.ingestHarnessEvent({
    sessionId: 'sess-desk', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' },
  });
  const done = tickUntil(module, (state) => emp(state).transition === null);
  assert.equal(done, true);
  const final = emp(module.state()).position;
  const roamNodes = module.layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id));
  const landed = roamNodes.find((node) => node.position.x === final.x && node.position.y === final.y);
  assert.ok(landed, `leave ends on a roaming node, got ${JSON.stringify(final)}`);
  // nearest reachable roam node from desk-1-approach by the documented metric
  const approach = LAYOUT.nodeById('desk-1-approach');
  const scene = module.layout.scene();
  const expected = officeModule.resolveLeaveNodeId({
    nodes: roamNodes,
    fromPosition: approach.position,
    scene: { width: scene.referenceWidth, height: scene.referenceHeight },
    isReachable: () => true,
  });
  assert.equal(landed.id, expected, 'fallback leave target is the nearest roaming node');
});

test('resolveLeaveNodeId breaks distance ties with the stable node id', () => {
  const pick = officeModule.resolveLeaveNodeId;
  const nodes = [
    { id: 'roam-b', position: { x: 0.4, y: 0.6 }, tags: ['roaming'] },
    { id: 'roam-a', position: { x: 0.6, y: 0.6 }, tags: ['roaming'] },
    { id: 'roam-far', position: { x: 0.9, y: 0.9 }, tags: ['roaming'] },
  ];
  assert.equal(
    pick({ nodes, fromPosition: { x: 0.5, y: 0.6 }, scene: { width: 100, height: 100 }, isReachable: () => true }),
    'roam-a',
    'equidistant candidates resolve by stable node id'
  );
  assert.equal(
    pick({ nodes, fromPosition: { x: 0.41, y: 0.6 }, scene: { width: 100, height: 100 }, isReachable: () => true }),
    'roam-b',
    'the strictly nearer candidate wins'
  );
  assert.equal(
    pick({ nodes, fromPosition: { x: 0.5, y: 0.6 }, scene: { width: 100, height: 100 }, isReachable: (id) => id !== 'roam-a' }),
    'roam-b',
    'unreachable candidates are excluded'
  );
  assert.equal(
    pick({ nodes, fromPosition: { x: 0.5, y: 0.6 }, scene: { width: 100, height: 100 }, isReachable: () => false }),
    null,
    'no reachable candidate resolves to null'
  );
});

test('replacement tasks keep the original preTask origin', () => {
  const module = makeModule();
  tickUntilRoamingAwayFromDesk(module);
  startTask(module, 'sess-replace');
  tickUntil(module, (state) => emp(state).transition && emp(state).transition.phase === 'work');
  const originalPreTask = emp(module.state()).preTaskNodeId;
  module.ingestHarnessEvent({ sessionId: 'sess-replace', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  // replacement task arrives while the employee stands/leaves
  const leaving = tickUntil(module, (state) => emp(state).transition && emp(state).transition.phase === 'leave');
  assert.equal(leaving, true);
  startTask(module, 'sess-replace', 3); // next seq: a gap would buffer the event in the adapter
  const replaced = emp(module.state());
  assert.equal(replaced.transition.kind, 'task-start', 'the replacement task takes over');
  assert.equal(replaced.preTaskNodeId, originalPreTask, 'the original pre-task origin is kept');
});

test('a running clock pushes throttled snapshots to subscribers so the view stays live', async () => {
  const module = makeModule({ reducedMotion: false });
  const pushes = [];
  const unsubscribe = module.subscribe((snapshot) => pushes.push(snapshot.simulatedAtMs));
  module.start();
  // no harness events at all: the pure simulation must still deliver the
  // clock-driven snapshot stream, otherwise the office view freezes between
  // event bursts
  await new Promise((resolve) => setTimeout(resolve, 400));
  module.stop();
  unsubscribe();
  assert.ok(pushes.length >= 2, `expected periodic pushes, got ${pushes.length}`);
  const uniqueTicks = new Set(pushes);
  assert.ok(uniqueTicks.size >= 2, 'pushes carry advancing simulated time');
});

test('a running clock pushes one snapshot per tick so the view paints at tick rate (M2 2026-09-16)', async () => {
  const module = makeModule({ reducedMotion: false });
  const pushes = [];
  const unsubscribe = module.subscribe((snapshot) => pushes.push(snapshot.simulatedAtMs));
  module.start();
  // 320ms at TICK_MS=16 is ~20 due ticks. The renderer paints on snapshot
  // pushes (its Pixi ticker is stopped by contract), so the push cadence IS
  // the view frame rate: the old 100ms throttle quantized walking to ~10fps.
  // >= 12 keeps a wide margin on both sides: RED under the 100ms throttle
  // (~3 pushes), GREEN under per-tick pushes (~20).
  await new Promise((resolve) => setTimeout(resolve, 320));
  module.stop();
  unsubscribe();
  assert.ok(pushes.length >= 12, `expected per-tick pushes (~20 in 320ms), got ${pushes.length}`);
  const deltas = pushes.slice(1).map((at, i) => at - pushes[i]);
  assert.ok(deltas.every((d) => d > 0), 'pushed simulated time strictly advances');
});

test('both task-capable seats complete concurrent transitions at their own workstations', () => {
  const module = makeModule();
  tickFor(module, 500);
  // a root task (orchestrator -> desk-1) spawns a subagent task
  // (collaborator -> desk-5): both seats run concurrently
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'subagent/start', seq: 3, time: 3, data: { id: 'sess-c-child', runId: 'run-c' } });

  const emp = (state, id) => state.employees.find((x) => x.employeeId === id);
  const bothAtWork = tickUntil(module, (state) => {
    const o = emp(state, 'orchestrator');
    const c = emp(state, 'collaborator');
    return o.transition && o.transition.phase === 'work'
      && Math.abs(o.position.x - module.layout.nodeById('desk-1').position.x) < 0.01
      && c.transition && c.transition.phase === 'work'
      && Math.abs(c.position.x - module.layout.nodeById('desk-5').position.x) < 0.01;
  }, 240000);
  assert.equal(bothAtWork, true, 'orchestrator works at desk-1 while the collaborator works at desk-5 concurrently');

  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'subagent/end', seq: 4, time: 4, data: { id: 'sess-c-child', runId: 'run-c', stopReason: 'completed' } });
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } });
  const bothReleased = tickUntil(module, (state) => {
    return emp(state, 'orchestrator').transition === null && emp(state, 'collaborator').transition === null;
  }, 240000);
  assert.equal(bothReleased, true, 'both seats finish stand/leave and release');
  assert.equal(emp(module.state(), 'orchestrator').binding, null);
  assert.equal(emp(module.state(), 'collaborator').binding, null);
});

test('a transiently blocked task route retries until the approach is reachable', () => {
  const module = makeModule();
  // let the other residents start roaming so their path reservations are live
  for (let i = 0; i < 63; i += 1) module.tickOnce();
  // a concurrent root task is already running (its workstation + path
  // reservations are live) when the collaborator task arrives
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-o', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'agent/status', seq: 3, time: 3, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'subagent/start', seq: 4, time: 4, data: { id: 'sess-c-child', runId: 'run-c' } });
  const emp = (state) => state.employees.find((x) => x.employeeId === 'collaborator');
  const arrived = tickUntil(module, (state) => {
    const e = emp(state);
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(arrived, true, 'the blocked route recovers and the collaborator reaches work');
  const seat = module.layout.nodeById('desk-5').position;
  const atSeat = tickUntil(module, (state) => {
    const e = emp(state);
    return Math.abs(e.position.x - seat.x) < 0.01 && Math.abs(e.position.y - seat.y) < 0.01;
  });
  assert.equal(atSeat, true, 'the collaborator lands on its own seat');
});

// ---------------------------------------------------------------------------
// Task 7B — terminal outcomes for QUEUED tasks (never lost, never phantom-run)
// ---------------------------------------------------------------------------

function enqueueQueuedRootTask(module, sessionId) {
  // a second root session while the orchestrator seat is busy -> queued
  const first = module.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  void first;
  // the turn/end below flushes the buffered running fact and applies the
  // terminal in one adapter pass; emit a second running fact first so the
  // queued state is observable before the terminal arrives
  module.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
}

function queuedRootScenario(outcome) {
  const module = makeModule();
  // task A: orchestrator walks to desk-1 and works
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const aWorking = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(aWorking, true, 'precondition: task A is running at the desk');

  // task B arrives while the seat is busy -> queued
  enqueueQueuedRootTask(module, 'sess-b');
  const queued = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.queueCount === 1;
  }, 240000);
  assert.equal(queued, true, 'precondition: task B is queued (queueCount 1)');

  // task B's terminal arrives BEFORE B is dispatched
  module.ingestHarnessEvent({ sessionId: 'sess-b', type: 'turn/end', seq: 3, time: 3, data: { reason: outcome } });
  const drained = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.queueCount === 0;
  }, 240000);
  assert.equal(drained, true, `queued ${outcome} closes the queue item immediately`);

  // task A finishes normally
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(released, true, 'task A still completes and releases');

  // B must never phantom-run: no work phase after A released
  let phantomWork = false;
  for (let i = 0; i < 6000; i += 1) {
    module.tickOnce();
    const e = module.state().employees.find((x) => x.employeeId === 'orchestrator');
    if (e.transition && e.transition.phase === 'work' && e.binding) { phantomWork = true; break; }
  }
  assert.equal(phantomWork, false, `the closed ${outcome} task never dispatches into work`);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 0, 'the queue stays empty');
  return module;
}

test('root queued completed closes safely and never phantom-runs', () => {
  const module = queuedRootScenario('completed');
  // A presented completed; B was closed without presenting
  const results = [];
  for (const entry of module.state().activityLog) {
    if (entry.kind.includes('queued')) results.push(entry.kind);
  }
  assert.ok(results.length >= 1, 'the queued close is observable in the activity log');
});

test('root queued failed closes safely and never phantom-runs', () => {
  queuedRootScenario('failed');
});

test('root queued cancelled leaves the queue immediately without walking', () => {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  enqueueQueuedRootTask(module, 'sess-b');
  tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.queueCount === 1;
  }, 240000);
  const positionBefore = { ...module.state().employees.find((x) => x.employeeId === 'orchestrator').position };
  module.ingestHarnessEvent({ sessionId: 'sess-b', type: 'turn/end', seq: 3, time: 3, data: { reason: 'cancelled' } });
  const removed = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.queueCount === 0;
  }, 240000);
  assert.equal(removed, true, 'the cancelled queued item leaves the waiting queue immediately');
  const after = module.state().employees.find((x) => x.employeeId === 'orchestrator');
  assert.deepEqual(after.position, positionBefore, 'no walk starts for a cancelled queued task');
  assert.equal(after.transition && after.transition.phase, 'work', 'task A is undisturbed');
});

test('subagent queued outcomes close safely on the collaborator FIFO', () => {
  const module = makeModule();
  tickFor(module, 300);
  let seq = 3;
  // subagent A works on the collaborator seat
  module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'subagent/start', seq: 2, time: 2, data: { id: 'c-child-a', runId: 'run-a' } });
  const aWorking = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.transition && c.transition.phase === 'work';
  }, 240000);
  assert.equal(aWorking, true, 'precondition: subagent A works');

  for (const [childId, runId, outcome] of [
    ['c-child-b', 'run-b', 'completed'],
    ['c-child-c', 'run-c', 'failed'],
    ['c-child-d', 'run-d', 'cancelled'],
  ]) {
    module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'subagent/start', seq: seq++, time: seq, data: { id: childId, runId } });
    const enqueued = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'collaborator').queueCount === (outcome === 'completed' ? 1 : outcome === 'failed' ? 1 : 1), 240000);
    assert.equal(enqueued, true, `${childId} queued`);
    module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'subagent/end', seq: seq++, time: seq, data: { id: childId, runId, stopReason: outcome } });
    const closed = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'collaborator').queueCount === 0, 240000);
    assert.equal(closed, true, `${childId} ${outcome} closed from the FIFO before dispatch`);
  }

  // subagent A finishes normally and releases
  module.ingestHarnessEvent({ sessionId: 'sess-c-root', type: 'subagent/end', seq: seq++, time: seq, data: { id: 'c-child-a', runId: 'run-a', stopReason: 'completed' } });
  const released = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.transition === null && c.binding === null;
  }, 240000);
  assert.equal(released, true, 'subagent A completes and releases');
  let phantom = false;
  for (let i = 0; i < 6000; i += 1) {
    module.tickOnce();
    const c = module.state().employees.find((x) => x.employeeId === 'collaborator');
    if (c.transition && c.transition.phase === 'work' && c.binding) { phantom = true; break; }
  }
  assert.equal(phantom, false, 'no closed subagent dispatches into work afterwards');
});

test('duplicate queued terminals are idempotent and preserve FIFO order', () => {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  // two queued tasks B then C
  enqueueQueuedRootTask(module, 'sess-b');
  module.ingestHarnessEvent({ sessionId: 'sess-a', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1);
  module.ingestHarnessEvent({ sessionId: 'sess-c', type: 'agent/status', seq: 10, time: 10, data: { status: 'running' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 2);
  // C's terminal arrives first: only C closes, B stays at the FIFO head
  module.ingestHarnessEvent({ sessionId: 'sess-c', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1);
  // duplicate terminal for the already-closed C: ignored
  module.ingestHarnessEvent({ sessionId: 'sess-c', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  tickFor(module, 100);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 1, 'B remains the FIFO head exactly once');
  // B's terminal closes B
  module.ingestHarnessEvent({ sessionId: 'sess-b', type: 'turn/end', seq: 3, time: 3, data: { reason: 'failed' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 0);
});

test('a stale terminal from an old turn never closes a new turn of the same session', () => {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  enqueueQueuedRootTask(module, 'sess-t');
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1);
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 3, time: 3, data: { reason: 'cancelled' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  // a NEW turn of the same raw session queues again and runs normally
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } });
  const finished = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(finished, true, 'the new turn runs and completes normally');
});

test('a transiently blocked collaborator route retries and its terminal still completes', () => {
  // seed task7a deterministically blocks the collaborator route while the
  // orchestrator path reservation is live (reproduced: ROUTE_UNAVAILABLE)
  const module = makeModule({}, 'task7a');
  for (let i = 0; i < 63; i += 1) module.tickOnce();
  module.ingestHarnessEvent({ sessionId: 'sess-r', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-r', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-r', type: 'subagent/start', seq: 3, time: 3, data: { id: 'c-child-x', runId: 'run-x' } });

  // the collaborator keeps its task-start transition alive (move phase
  // route retry) instead of degrading into a lost task
  const kept = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.transition && c.transition.kind === 'task-start' && c.transition.phase === 'move';
  }, 240000);
  assert.equal(kept, true, 'the collaborator holds the task through the transient block');

  // its terminal arrives during the retry window
  module.ingestHarnessEvent({ sessionId: 'sess-r', type: 'subagent/end', seq: 4, time: 4, data: { id: 'c-child-x', runId: 'run-x', stopReason: 'completed' } });
  const presented = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.lastResult && c.lastResult.outcome === 'completed';
  }, 5000);
  assert.equal(presented, true, 'the result presents immediately, not after the retry budget');
  const released = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.transition === null && c.binding === null;
  }, 5000);
  assert.equal(released, true, 'released well inside the retry budget (no 10s hang)');
  // idempotent duplicate terminal: no second presentation
  module.ingestHarnessEvent({ sessionId: 'sess-r', type: 'subagent/end', seq: 5, time: 5, data: { id: 'c-child-x', runId: 'run-x', stopReason: 'completed' } });
  tickFor(module, 1000);
  const c = module.state().employees.find((x) => x.employeeId === 'collaborator');
  assert.equal(c.lastResult && c.lastResult.outcome, 'completed');
  assert.equal(c.transition, null);
});

test('queued terminal flows leak no raw session or run identifiers into the snapshot', () => {
  const RAW_SESSION = 'sess-privacy-queued-9f2';
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-privacy-root', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-privacy-root', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  enqueueQueuedRootTask(module, RAW_SESSION);
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  module.ingestHarnessEvent({ sessionId: RAW_SESSION, type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  const serialized = JSON.stringify(module.state());
  assert.equal(serialized.includes(RAW_SESSION), false, 'no raw queued session id in the snapshot');
  assert.equal(serialized.includes('sess-privacy'), false, 'no session-shaped identifiers at all');
});

// ---------------------------------------------------------------------------
// Task 7B-R1 — queued turn identity (raw session -> queued turn handle)
// ---------------------------------------------------------------------------

test('P1: a re-queued root turn keeps ONE queue item, closes on terminal and never phantom-runs', () => {
  const module = makeModule();
  // step 1: raw session S completes an old turn and fully releases
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const sWork = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(sWork, true, 'precondition: S works its first turn');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const sReleased = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(sReleased, true, 'precondition: S fully released after the old turn');

  // step 2: another root session T occupies the orchestrator seat
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const tBound = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return !!e.binding && e.binding.source !== null;
  }, 240000);
  assert.equal(tBound, true, 'precondition: T occupies the orchestrator seat');

  // step 3: S starts a new turn with two consecutive running facts
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } });

  // step 4: exactly ONE queued item for S's new turn
  const oneItem = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  assert.equal(oneItem, true, 'exactly one queued item for the new turn');
  tickFor(module, 200);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 1, 'the repeated running fact never inflates the queue');

  // step 5: S turn/end arrives before dispatch
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 6, time: 6, data: { reason: 'completed' } });
  const closed = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  assert.equal(closed, true, 'the terminal closes the queued turn item');

  // step 6: T releases; S must not enter work
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 20, data: { reason: 'completed' } });
  const tReleased = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.binding === null;
  }, 240000);
  assert.equal(tReleased, true, 'T releases');
  let phantom = false;
  for (let i = 0; i < 9000; i += 1) {
    module.tickOnce();
    const e = module.state().employees.find((x) => x.employeeId === 'orchestrator');
    if (e.transition && e.transition.phase === 'work' && e.binding) { phantom = true; break; }
  }
  assert.equal(phantom, false, 'S never phantom-runs the closed queued turn');
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 0);
});

test('subagent queued terminal identity: missing runId stays queued, mismatch stays queued, match closes', () => {
  const module = makeModule();
  tickFor(module, 300);
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/start', seq: 2, time: 2, data: { id: 'c-a', runId: 'run-good' } });
  const aWork = tickUntil(module, (state) => {
    const c = state.employees.find((x) => x.employeeId === 'collaborator');
    return c.transition && c.transition.phase === 'work';
  }, 240000);
  assert.equal(aWork, true, 'precondition: subagent A works');

  // three queued children
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/start', seq: 3, time: 3, data: { id: 'c-b-norun', runId: 'run-b' } });
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/start', seq: 4, time: 4, data: { id: 'c-c-wrong', runId: 'run-c' } });
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/start', seq: 5, time: 5, data: { id: 'c-d-ok', runId: 'run-d' } });
  const allQueued = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'collaborator').queueCount === 3, 240000);
  assert.equal(allQueued, true, 'precondition: three queued subagent items');

  // missing runId: fails closed, item stays queued, stable internal diagnostic
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/end', seq: 6, time: 6, data: { id: 'c-b-norun', stopReason: 'completed' } });
  tickFor(module, 100);
  const afterMissing = module.state().employees.find((x) => x.employeeId === 'collaborator');
  assert.equal(afterMissing.queueCount, 3, 'missing runId keeps the item queued');
  const missingDiag = module.diagnostics().diagnostics.some((d) => d.code === 'RUN_ID_UNVERIFIED');
  assert.equal(missingDiag, true, 'stable RUN_ID_UNVERIFIED diagnostic');

  // mismatched runId: fails closed, item stays queued
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/end', seq: 7, time: 7, data: { id: 'c-c-wrong', runId: 'run-WRONG', stopReason: 'completed' } });
  tickFor(module, 100);
  const afterMismatch = module.state().employees.find((x) => x.employeeId === 'collaborator');
  assert.equal(afterMismatch.queueCount, 3, 'mismatched runId keeps the item queued');
  const mismatchDiag = module.diagnostics().diagnostics.some((d) => d.code === 'RUN_ID_MISMATCH');
  assert.equal(mismatchDiag, true, 'stable RUN_ID_MISMATCH diagnostic');

  // matching runId: closes exactly its own item
  module.ingestHarnessEvent({ sessionId: 'c-root', type: 'subagent/end', seq: 8, time: 8, data: { id: 'c-d-ok', runId: 'run-d', stopReason: 'completed' } });
  tickFor(module, 100);
  const afterMatch = module.state().employees.find((x) => x.employeeId === 'collaborator');
  assert.equal(afterMatch.queueCount, 2, 'the matching terminal closes exactly its own item');
});

// ---------------------------------------------------------------------------
// Task 7B-R2 — derived queued turn dispatch promotion (controlled reverse map)
// ---------------------------------------------------------------------------

test('P1 dispatch: queued derived turn promotes, works and completes via the raw terminal', () => {
  const module = makeModule();
  // 1. S completes turn 1 and fully releases
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const sWork = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(sWork, true, 'S works turn 1');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const sReleased = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(sReleased, true, 'S fully releases turn 1');

  // 2. T occupies the orchestrator seat
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const tBound = tickUntil(module, (state) => !!state.employees.find((x) => x.employeeId === 'orchestrator').binding, 240000);
  assert.equal(tBound, true, 'T occupies the seat');

  // 3. S new turn queues (no S terminal — it must dispatch later)
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } });
  const queued1 = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  assert.equal(queued1, true, 'exactly one queued item for the derived turn');
  const counts = module.debugRootHandleCounts();
  assert.equal(counts.queued, 1, 'the queued handle map holds exactly the derived turn');
  assert.equal(counts.pendingReverse, 1, 'the controlled reverse map holds the raw lookup');

  // 5/6. T completes and fully releases -> the queued derived turn (S#tN)
  // dispatches immediately into work on the same seat
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const promoted = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work' && e.queueCount === 0;
  }, 240000);
  assert.equal(promoted, true, 'the queued derived turn dispatches into work');
  assert.equal(module.debugRootHandleCounts().queued, 0, 'no queued mapping dangles after promotion');
  assert.equal(module.debugRootHandleCounts().pendingReverse, 0, 'no reverse mapping dangles after promotion');

  // 8. the RAW session terminal completes the whole lifecycle
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 6, time: 6, data: { reason: 'completed' } });
  const presented = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.lastResult && e.lastResult.outcome === 'completed';
  }, 240000);
  assert.equal(presented, true, 'the raw terminal presents the result');
  const released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.binding === null && e.transition === null;
  }, 240000);
  assert.equal(released, true, 'stand/leave complete and the binding releases');
  // duplicate terminal: never restarts the result
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 7, time: 7, data: { reason: 'completed' } });
  tickFor(module, 1000);
  const final = module.state().employees.find((x) => x.employeeId === 'orchestrator');
  assert.equal(final.lastResult && final.lastResult.outcome, 'completed');
  assert.equal(final.binding, null);
  assert.equal(final.transition, null);
  assert.equal(final.queueCount, 0);
});

test('promoted derived turn: repeated running facts never re-queue, next turn still works', () => {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const t1Work = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(t1Work, true, 'S works turn 1 directly');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.binding === null && e.transition === null;
  }, 240000);
  assert.equal(released, true, 'turn 1 releases');

  // T occupies while S queues a derived turn, then T releases -> S dispatches
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const tBound = tickUntil(module, (state) => !!state.employees.find((x) => x.employeeId === 'orchestrator').binding, 240000);
  assert.equal(tBound, true, 'T occupies the seat');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } });
  const queued = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  assert.equal(queued, true, 'S queues behind T');
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const promoted = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work' && e.queueCount === 0;
  }, 240000);
  assert.equal(promoted, true, 'S dispatches into work after T releases');

  // repeated running facts for the SAME turn: never re-queue
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 6, time: 6, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 7, time: 7, data: { status: 'running' } });
  tickFor(module, 500);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 0, 'no re-queue during the active turn');
  assert.equal(module.debugRootHandleCounts().queued, 0);
  assert.equal(module.debugRootHandleCounts().pendingReverse, 0);

  // the raw session can still start its NEXT turn afterwards
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 8, time: 8, data: { reason: 'completed' } });
  const t2Released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(t2Released, true, 'turn 2 releases');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 9, time: 9, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 10, time: 10, data: { status: 'running' } });
  const t3Work = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(t3Work, true, 'the next turn of the same raw session works normally');
});

test('replayed stale turn/end events from a previous turn never close the next turn', () => {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const t1Work = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(t1Work, true, 'turn 1 works');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.binding === null && e.transition === null;
  }, 240000);
  assert.equal(released, true, 'turn 1 releases');
  // turn 2 starts
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } });
  const t2Work = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(t2Work, true, 'turn 2 works');
  // replay turn 1's LOW-sequence terminal: the adapter dedups it
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  tickFor(module, 500);
  const during = module.state().employees.find((x) => x.employeeId === 'orchestrator');
  assert.equal(during.transition && during.transition.phase, 'work', 'the replayed stale terminal never closes turn 2');
  assert.equal(during.binding !== null, true, 'turn 2 binding retained');
});

// ---------------------------------------------------------------------------
// Task 7B-R2-R1 — a queued root terminal must close BOTH identity maps
// (queuedRootHandles forward AND rootHandleByDerived reverse) on every
// terminal path; a failed retain must never consume any mapping
// ---------------------------------------------------------------------------

// Real derived-turn scenario: raw session S finishes turn 1 and fully
// releases, T occupies the orchestrator seat, S starts a new turn that
// queues under a derived S#tN handle. Returns the module with the queue
// established and debugRootHandleCounts() === {queued:1, promoted:1,
// pendingReverse:1}.
function derivedQueuedTurnScenario() {
  const module = makeModule();
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 2, time: 2, data: { status: 'running' } });
  const sWork = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work';
  }, 240000);
  assert.equal(sWork, true, 'precondition: S works turn 1');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const sReleased = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition === null && e.binding === null;
  }, 240000);
  assert.equal(sReleased, true, 'precondition: S fully released turn 1');

  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const tBound = tickUntil(module, (state) => !!state.employees.find((x) => x.employeeId === 'orchestrator').binding, 240000);
  assert.equal(tBound, true, 'precondition: T occupies the orchestrator seat');

  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 4, time: 4, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 5, time: 5, data: { status: 'running' } });
  const queued = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  assert.equal(queued, true, 'precondition: the derived turn queues');
  assert.deepEqual(
    module.debugRootHandleCounts(),
    { queued: 1, promoted: 1, pendingReverse: 1 },
    'precondition: exactly one forward and one reverse identity mapping for the derived turn'
  );
  return module;
}

for (const [label, reason] of [['completed', 'completed'], ['failed', 'failed'], ['cancelled', 'cancelled']]) {
  test(`queued derived turn terminal (${label}) clears both identity maps before dispatch`, () => {
    const module = derivedQueuedTurnScenario();
    module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 6, time: 6, data: { reason } });
    const closed = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
    assert.equal(closed, true, `the queued ${label} terminal closes the item before dispatch`);
    const after = module.debugRootHandleCounts();
    assert.equal(after.queued, 0, 'no forward mapping dangles after the pre-dispatch terminal');
    assert.equal(after.pendingReverse, 0, 'no reverse mapping dangles after the pre-dispatch terminal');
    assert.equal(after.promoted, 1, 'T stays bound');

    // T releases: the closed turn must never phantom-run
    module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 20, data: { reason: 'completed' } });
    const tReleased = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').binding === null, 240000);
    assert.equal(tReleased, true, 'T releases');
    let phantom = false;
    for (let i = 0; i < 6000; i += 1) {
      module.tickOnce();
      const e = module.state().employees.find((x) => x.employeeId === 'orchestrator');
      if (e.transition && e.transition.phase === 'work' && e.binding) { phantom = true; break; }
    }
    assert.equal(phantom, false, 'S never phantom-runs the closed derived turn');
    assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 0, pendingReverse: 0 }, 'no identity mapping dangles at the end');
  });
}

test('a failed retain (SESSION_NOT_QUEUED) never consumes the queued derived mappings', () => {
  const module = derivedQueuedTurnScenario();
  // a terminal for a session that is neither active nor queued fails retain
  // closed (SESSION_NOT_QUEUED); the queued derived turn's identity mappings
  // must be preserved so the turn can still dispatch when the seat frees
  module.ingestHarnessEvent({ sessionId: 'sess-ghost', type: 'turn/end', seq: 1, time: 7, data: { reason: 'completed' } });
  tickFor(module, 200);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 1, 'the queued item survives the unrelated failed retain');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 1, promoted: 1, pendingReverse: 1 }, 'the failed retain consumes no mapping');

  // the untouched derived turn still dispatches and completes normally
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 8, data: { reason: 'completed' } });
  const promoted = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.transition && e.transition.phase === 'work' && e.queueCount === 0;
  }, 240000);
  assert.equal(promoted, true, 'the derived turn still dispatches after the failed retain');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 1, pendingReverse: 0 }, 'successful promotion consumes both mappings');
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 6, time: 9, data: { reason: 'completed' } });
  const released = tickUntil(module, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e.binding === null && e.transition === null;
  }, 240000);
  assert.equal(released, true, 'the promoted turn completes and releases');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 0, pendingReverse: 0 });
});

test('after a pre-dispatch close the next turn requeues with exactly one fresh mapping and duplicate terminals stay inert', () => {
  const module = derivedQueuedTurnScenario();
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 6, time: 6, data: { reason: 'completed' } });
  const closed = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  assert.equal(closed, true, 'the queued derived turn closes on its terminal');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 1, pendingReverse: 0 }, 'both mappings cleared on close');

  // duplicate terminal: retain now fails (SESSION_NOT_QUEUED) and must stay
  // completely inert — no resurrection, no disturbance
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 7, time: 7, data: { reason: 'completed' } });
  tickFor(module, 200);
  assert.equal(module.state().employees.find((x) => x.employeeId === 'orchestrator').queueCount, 0, 'the duplicate terminal re-queues nothing');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 1, pendingReverse: 0 }, 'the duplicate failed retain leaves the maps untouched');

  // the next turn of the SAME raw session queues again with exactly ONE new
  // mapping pair (a stale residue would inflate pendingReverse to 2)
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 8, time: 8, data: { status: 'running' } });
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'agent/status', seq: 9, time: 9, data: { status: 'running' } });
  const requeued = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 1, 240000);
  assert.equal(requeued, true, 'the next turn of the same raw session queues behind T');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 1, promoted: 1, pendingReverse: 1 }, 'exactly one fresh forward+reverse mapping, no stale residue');

  // and that fresh queued turn still closes cleanly on its own terminal
  module.ingestHarnessEvent({ sessionId: 'sess-s', type: 'turn/end', seq: 10, time: 10, data: { reason: 'failed' } });
  const closed2 = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').queueCount === 0, 240000);
  assert.equal(closed2, true, 'the fresh queued turn closes on its terminal');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 1, pendingReverse: 0 }, 'the fresh mapping clears on close too');

  // T releases: neither closed turn may phantom-run
  module.ingestHarnessEvent({ sessionId: 'sess-t', type: 'turn/end', seq: 2, time: 30, data: { reason: 'completed' } });
  const tReleased = tickUntil(module, (state) => state.employees.find((x) => x.employeeId === 'orchestrator').binding === null, 240000);
  assert.equal(tReleased, true, 'T releases');
  let phantom = false;
  for (let i = 0; i < 6000; i += 1) {
    module.tickOnce();
    const e = module.state().employees.find((x) => x.employeeId === 'orchestrator');
    if (e.transition && e.transition.phase === 'work' && e.binding) { phantom = true; break; }
  }
  assert.equal(phantom, false, 'no phantom work after either close');
  assert.deepEqual(module.debugRootHandleCounts(), { queued: 0, promoted: 0, pendingReverse: 0 });
});

// ---------------------------------------------------------------------------
// Task E5a-R2 — the runtime honours the editor-composed scale and facing.
// The compiled flat layout carries per-workstation character data (scale +
// direction from the user's draft items); the module turns it into a
// presentation height ratio and resolves the seated/idle states to the
// composed back pose (side-back — the pack has no back-facing working frames,
// and the front-facing static working would contradict the composition).
// ---------------------------------------------------------------------------

const FLAT_LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
);

// M4.1g: the production pack carries the dedicated sleeping nap art that the
// fixture pack lacks.
const PROD_PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PROD_PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

test('M4.1d: a chat pair speaks, expires, ends and cools down', () => {
  // The E5c-1 chain shipped its three ends (engine, corpus, renderer bubble
  // nodes) without the middle: nothing ever set `bubble` on an employee, and
  // nothing ever ended a chat — an undisturbed pair stood at the water cooler
  // forever. The contract now:
  //  * a SEATED pair shows one corpus line per member at a time, for the
  //    corpus bubbleMs, then it clears;
  //  * the chat ends by chatDurationMs (module settings) after it started;
  //  * the engine's per-pair cooldown keeps the same pair silent for
  //    cooldownMs between consecutive bubble episodes.
  const corpus = {
    topics: { greeting: [{ id: 'g-01', text: '咕噜~测试台词', weight: 1 }] },
    limits: { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 },
  };
  // Chat formation is probabilistic and the trajectory is chaotic — any
  // routing change reshuffles it. Scan a few seeds and take the first that
  // forms a pair (if the product ever stops forming chats, EVERY seed fails
  // and the assertion fires loudly).
  let module = null;
  for (const seed of ['m41d-chat-c', 'm41d-chat-a', 'm41d-chat-d', 'm41d-chat-e', 'm41d-chat-f', 'm41d-chat-g']) {
    const candidate = officeModule.createOfficeModule({
      pack: PACK,
      layout: FLAT_LAYOUT_FIXTURE,
      seed,
      config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
      dialogue: { base: corpus },
    });
    if (tickUntil(candidate, (state) => state.employees.some((employee) => employee.marker === 'chat-ellipsis'), 60000)) {
      module = candidate;
      break;
    }
  }
  assert.ok(module, 'a chat pair formed (no seed formed one)');

  // episode = a transition from "pair not showing" to "pair showing"
  const episodes = [];
  let showing = false;
  let showingPair = null;
  let lastLineKey = null;
  let lastPresentAtMs = -Infinity;
  let pairEndedAtMs = null;
  const steps = Math.round(120000 / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) { // full window: multi-line conversations may come after the first pair ends
    module.tickOnce();
    const state = module.state();
    const pairIds = state.employees.filter((employee) => employee.marker === 'chat-ellipsis').map((employee) => employee.employeeId).sort();
    const carrier = state.employees.find((employee) => employee.bubble && employee.bubble.text && pairIds.includes(employee.employeeId));
    const present = !!(carrier && pairIds.length === 2);
    // A LINE = the pair is showing a bubble AND (pair, speaker) changed since
    // the previous sample. The between-lines gap is one tick (~16ms) — far
    // below any honest sampling cadence — so transitions are detected by the
    // SPEAKER changing, not by catching the bubble-absent moment.
    const lineKey = present ? `${pairIds.join('|')}@${carrier.employeeId}` : null;
    if (lineKey && lineKey !== lastLineKey) {
      episodes.push({
        atMs: state.simulatedAtMs,
        pairKey: pairIds.join('|'),
        text: carrier.bubble.text,
        untilMs: carrier.bubble.untilMs,
        nowMs: state.simulatedAtMs,
        continues: showingPair === pairIds.join('|'),
      });
    }
    lastLineKey = lineKey;
    if (present) { lastPresentAtMs = state.simulatedAtMs; showingPair = pairIds.join('|'); }
    showing = present;
    if (episodes.length > 0 && pairEndedAtMs === null && pairIds.join('|') !== episodes[0].pairKey) pairEndedAtMs = state.simulatedAtMs;
  }
  const first = episodes[0];
  assert.ok(first, 'a seated chat pair produced a corpus bubble');
  assert.equal(first.text, '咕噜~测试台词', 'the bubble text comes from the corpus');
  assert.ok(first.untilMs - first.nowMs > 0 && first.untilMs - first.nowMs <= corpus.limits.bubbleMs,
    `the bubble lifetime follows the corpus limits (${first.untilMs - first.nowMs}ms)`);
  assert.ok(pairEndedAtMs !== null && pairEndedAtMs - first.atMs <= 16000 + corpus.limits.bubbleMs,
    `the chat ended within chatDurationMs of the first line (${pairEndedAtMs === null ? 'never' : `${Math.round((pairEndedAtMs - first.atMs) / 1000)}s`})`);
  // M4.1d follow-up (2026-09-18): lines now ALTERNATE INSIDE one conversation
  // (the corpus cooldown governs between conversations only — a 30s cooldown
  // inside a 15s chat used to cap every chat at a single line). Classify each
  // same-pair gap by whether the marker stayed continuously present.
  let withinConversation = 0;
  let acrossConversations = 0;
  for (let i = 1; i < episodes.length; i += 1) {
    if (episodes[i].pairKey !== episodes[i - 1].pairKey) continue;
    const gap = episodes[i].atMs - episodes[i - 1].atMs;
    const sameConversation = episodes[i].continues;
    if (sameConversation) {
      withinConversation += 1;
      assert.ok(gap >= corpus.limits.bubbleMs - 100,
        `inside one conversation lines follow the bubble cadence (gap ${Math.round(gap)}ms)`);
    } else {
      acrossConversations += 1;
      assert.ok(gap >= corpus.limits.cooldownMs - 100,
        `the same pair re-speaks only after the cooldown (gap ${Math.round(gap / 1000)}s)`);
    }
  }
  assert.ok(withinConversation >= 1,
    'a seated conversation shows more than one line (alternating speakers)');
});

test('M4.1d follow-up: chats form at a visible cadence (the office is not silent)', () => {
  // 2026-09-18 user report: "I never see two residents chat". Measured cause:
  // the plain 15% roll produced one pair per ~10-15 SIMULATED minutes. The
  // chat craving (idle + no active pair -> try the chat branch first) brings
  // that to roughly one pair every 2-6 minutes. Deterministic seeds.
  const corpus = {
    topics: { greeting: [{ id: 'g-01', text: '咕噜~聊两句', weight: 1 }] },
    limits: { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 },
  };
  let totalPairs = 0;
  for (const seed of ['chat-cadence-1', 'chat-cadence-2']) {
    const module = officeModule.createOfficeModule({
      pack: PACK,
      layout: FLAT_LAYOUT_FIXTURE,
      seed,
      dialogue: { base: corpus },
      config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    });
    let chats = 0;
    let lastPair = null;
    const steps = Math.round((20 * 60 * 1000) / officeModule.TICK_MS);
    for (let i = 0; i < steps; i += 1) {
      module.tickOnce();
      if (i % 20) continue;
      const pair = module.state().employees.filter((employee) => employee.marker === 'chat-ellipsis').map((employee) => employee.employeeId).sort().join('|');
      if (pair.length > 2 && pair !== lastPair) { chats += 1; lastPair = pair; }
      if (pair.length <= 2) lastPair = null;
    }
    assert.ok(chats >= 2, `a 20-minute simulation forms several chats (${seed}: ${chats})`);
    totalPairs += chats;
  }
  assert.ok(totalPairs >= 5, `both seeds together form a healthy number of chats (${totalPairs})`);
});

test('M4.1e: roaming peers keep personal space and can never livelock', () => {
  // Two defects reproduced on 2026-09-17 with this exact scene:
  //  1. coder (roam-3) and collaborator (roam-5), 34px apart, each blocked the
  //     other's corridor leg and froze together for ~5 minutes — only task
  //     walkers could ask a peer to yield, and a route planned before the peer
  //     parked was never re-planned (enRoute suppresses re-decision).
  //  2. two parked bodies stacked at chat-b / roam-3 (32.6px) for minutes.
  // Contract: parked bodies never get closer than 30px, no close pair (<42px)
  // persists beyond 30s, and no walker with a live route stays stationary for
  // longer than the patience/re-plan ladder (~20s).
  const module = officeModule.createOfficeModule({
    pack: PACK,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'spacing-audit-2',
    config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });
  const scene = { w: FLAT_LAYOUT_FIXTURE.scene.referenceWidth, h: FLAT_LAYOUT_FIXTURE.scene.referenceHeight };
  const sampleEvery = 10; // ~160ms
  const closeSince = new Map();
  const longest = new Map();
  let minPair = Infinity;
  let minPairAt = null;
  const stalledSince = new Map();
  let worstStall = { employeeId: null, ms: 0, route: null };
  const steps = Math.round((12 * 60 * 1000) / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    const at = i * officeModule.TICK_MS;
    const state = module.state();
    if (i % sampleEvery === 0) {
      const parked = state.employees.filter((employee) => employee.movement === 'stationary');
      const active = new Set();
      for (let a = 0; a < parked.length; a += 1) {
        for (let b = a + 1; b < parked.length; b += 1) {
          const dx = (parked[a].position.x - parked[b].position.x) * scene.w;
          const dy = (parked[a].position.y - parked[b].position.y) * scene.h;
          const distance = Math.hypot(dx, dy);
          if (distance < minPair) {
            minPair = distance;
            minPairAt = { a: parked[a].employeeId, b: parked[b].employeeId, atNode: parked[a].seatNodeId, bNode: parked[b].seatNodeId };
          }
          if (distance < 42) {
            const key = [parked[a].employeeId, parked[b].employeeId].sort().join('|');
            active.add(key);
            const ms = (closeSince.get(key) || 0) + sampleEvery * officeModule.TICK_MS;
            closeSince.set(key, ms);
            if (ms > (longest.get(key) || 0)) longest.set(key, ms);
          }
        }
      }
      for (const key of [...closeSince.keys()]) if (!active.has(key)) closeSince.set(key, 0);
    }
    const reservations = module.debugReservations();
    const byId = new Map(state.employees.map((employee) => [employee.employeeId, employee]));
    for (const debug of reservations) {
      const employee = byId.get(debug.employeeId);
      if (!employee) continue;
      const route = debug.routeIds ? String(debug.routeIds).split('>') : [];
      const target = route.length > 0 ? route[route.length - 1] : null;
      const pending = !!target && target !== debug.currentNodeId;
      if (employee.movement === 'stationary' && pending) {
        if (!stalledSince.has(employee.employeeId)) stalledSince.set(employee.employeeId, at);
        const ms = at - stalledSince.get(employee.employeeId);
        if (ms > worstStall.ms) worstStall = { employeeId: employee.employeeId, ms, route: debug.routeIds };
      } else {
        stalledSince.delete(employee.employeeId);
      }
    }
  }
  const worstClose = [...longest.entries()].sort((a, b) => b[1] - a[1])[0] || ['-', 0];
  // The hard floor is the occupant gate's guarantee (OCCUPANT_SOCIAL_RADIUS
  // 0.03 normalized ≈ 25px in the tightest direction) — the QUALITY bounds are
  // the episode-duration limits below, not a bigger floor.
  assert.ok(minPair >= 24,
    `parked bodies never get closer than the social radius (min ${minPair.toFixed(1)}px ${JSON.stringify(minPairAt)})`);
  assert.ok(worstClose[1] <= 30000,
    `no close pair (<42px) persists beyond 30s (${worstClose[0]} stayed ${(worstClose[1] / 1000).toFixed(1)}s)`);
  assert.ok(worstStall.ms <= 20000,
    `${worstStall.employeeId} stayed stationary with a live route for ${(worstStall.ms / 1000).toFixed(1)}s (${worstStall.route})`);
});

test('D1: the back view belongs to the desk and to walking up — a walker that stops shows her front', () => {
  // User-reported 2026-09-18: after walking a leg the character stopped and
  // kept showing her back. The old back-pose gate only asked the composed
  // presentation (which is 'back' for everyone), so idle/working/sleeping all
  // rendered the back sheet. The contract now:
  //   * idle / resting / chatting  → FRONT (the standing view)
  //   * task phases sit / work     → back (the seated-at-desk view)
  //   * sleeping (only at the own desk) → the dedicated sleeping art, which is
  //     itself a back-facing pose (user decision 2026-09-22; supersedes the
  //     2026-09-17 "keep the side-back sheet" call)
  //   * walk-up keeps the up-cycle; stopping after it returns to the front
  const module = officeModule.createOfficeModule({
    pack: PACK,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'd1-facing-seed',
    config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });
  const orchestrator = emp(module.state());
  assert.equal(orchestrator.animation.resource, 'side-back',
    'the startup pose AT THE OWN DESK renders the back view (user follow-up: opening the office showed front-facing desks)');

  // walk a leg (a task's outbound route) and sample the walk cycle + the stop
  startTask(module, 'sess-d1');
  let sawWalk = false;
  let sawBackWhileWalking = false;
  const walking = tickUntil(module, (state) => {
    const employee = emp(state);
    const resource = employee.animation.resource || '';
    if (employee.transition && employee.transition.phase === 'move') {
      if (resource.startsWith('walk-')) sawWalk = true;
      if (resource === 'side-back') sawBackWhileWalking = true;
    }
    return employee.transition && employee.transition.phase === 'work';
  });
  assert.equal(walking, true, 'the task reaches the work phase');
  assert.equal(sawWalk, true, 'the outbound route plays a walk cycle');
  assert.equal(sawBackWhileWalking, false, 'walking NEVER renders the static back sheet');
  assert.equal(emp(module.state()).animation.resource, 'side-back',
    'seated work renders the back view (this pack has no working-back loop, so side-back)');

  // the walk back out (task-end leave) returns to the walk cycle, and once the
  // task is over she stands ROAMING/RESTING — front-facing again, never back.
  module.ingestHarnessEvent({ sessionId: 'sess-d1', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const done = tickUntil(module, (state) => emp(state).transition === null, 60000);
  assert.equal(done, true, 'the task ends');
  const after = tickUntil(module, (state) => {
    const employee = emp(state);
    return employee.movement === 'stationary' && ['idle', 'roaming'].includes(employee.activity);
  }, 30000);
  assert.equal(after, true, 'she settles into a local activity after the task');
  const settled = emp(module.state());
  const settledAtDesk = settled.currentNodeId === settled.seatNodeId;
  if (!settledAtDesk) {
    assert.equal(settled.animation.resource === 'side-back', false,
      `a walker that stopped AWAY from her desk must show her front, not the back sheet (${settled.animation.resource})`);
  }

  // M4.1g (2026-09-22, user decision — supersedes the 2026-09-17 "打盹维持
  // 背向"): the nap state now plays the pack's dedicated sleeping art (which
  // is itself a back-facing sleeping pose), so the composed side-back sheet no
  // longer replaces it. The fixture pack has no sleeping capability, so this
  // runs against the production pack.
  const sleepy = officeModule.createOfficeModule({
    pack: PROD_PACK,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'd1-facing-sleep',
    config: { sleepAfterMs: 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });
  const fellAsleep = tickUntil(sleepy, (state) => state.employees.some((employee) => employee.activity === 'sleeping'
    && employee.movement === 'stationary'), 30000);
  assert.equal(fellAsleep, true, 'with a 1s sleep threshold somebody falls asleep and settles at the own desk');
  const sleeping = sleepy.state().employees.find((employee) => employee.activity === 'sleeping');
  assert.equal(sleeping.animation.resource, 'sleeping',
    'the nap plays the dedicated sleeping art (user decision 2026-09-22; mid-walk samples may still show walk-up)');
});

test('E5a-R2: the module serves the composed height ratio and the back-facing seated pose', () => {
  const flatModule = officeModule.createOfficeModule({
    pack: PACK,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'e5a-r2-seed',
    config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });
  const orchestrator = flatModule.state().employees.find((candidate) => candidate.employeeId === 'orchestrator');
  assert.ok(orchestrator.presentation, 'the composed presentation reaches the snapshot');
  // mapping: ratio = DRAFT_WIDTHS.character × scale × (unionH / packCanvas) / (refH × 0.11)
  const packGeometry = PACK.geometry;
  const expectedRatio = (96 * 1.981668243649236 * (packGeometry.visibleBounds.height / packGeometry.outputCanvas.width))
    / (840 * 0.11);
  assert.ok(Math.abs(orchestrator.presentation.heightRatio - expectedRatio) < 1e-9,
    `heightRatio ${orchestrator.presentation.heightRatio} ~ ${expectedRatio}`);
  // D1 (2026-09-18): standing AT THE OWN DESK renders the back view (the
  // startup pose); only stopping away from the desk is front-facing.
  assert.equal(orchestrator.animation.resource, 'side-back', 'the desk pose renders the back view');

  // the seated working phase keeps the composed back pose and the same ratio
  startTask(flatModule, 'sess-e5a-r2');
  const working = tickUntil(flatModule, (state) => {
    const employee = emp(state);
    return employee.transition && employee.transition.phase === 'work';
  });
  assert.equal(working, true, 'the task reaches the work phase');
  const atWork = emp(flatModule.state());
  assert.equal(atWork.animation.resource, 'side-back', 'seated working renders the composed back view');
  assert.equal(atWork.presentation.heightRatio, orchestrator.presentation.heightRatio,
    'the composed size is state-independent (idle === working)');

  // walking stays on the directional walk cycles (never the composed pose)
  flatModule.ingestHarnessEvent({ sessionId: 'sess-e5a-r2', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  // M4.1a: sample WHILE the leave walk runs — the walk can complete before the
  // transition record clears, so "wait, then sample" could miss it entirely
  let sawWalk = false;
  for (let i = 0; i < 2000 && !sawWalk; i += 1) {
    flatModule.tickOnce();
    const employee = emp(flatModule.state());
    if (employee.animation && employee.animation.resource && employee.animation.resource.startsWith('walk-')) sawWalk = true;
  }
  assert.equal(sawWalk, true, 'walking still resolves the directional walk cycles');

  // the isometric fallback fixture (no composed character data) stays default
  const isoModule = officeModule.createOfficeModule({ pack: PACK, seed: 'e5a-r2-iso' });
  const isoEmployee = isoModule.state().employees.find((candidate) => candidate.employeeId === 'orchestrator');
  assert.equal(isoEmployee.presentation, null, 'no composed data means the default presentation');
  assert.equal(isoEmployee.animation.resource, 'idle', 'the fallback keeps the plain idle pose');
});

// ---------------------------------------------------------------------------
// Task E6d — the pack gains a dedicated back-facing seated-work animation
// (working-back, 3 frames, loop). For composed back views the seated WORKING
// state now plays that loop; the other steady states keep the side-back pose,
// walking keeps the directional cycles and result expressions stay untouched.
// The fixture pack itself stays front-only (the E5a-R2 degradation above must
// keep its coverage), so this test synthesizes the working-back capability.
// ---------------------------------------------------------------------------

test('E6d: the composed back working state plays the working-back three-frame loop', () => {
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8'));
  const fixtureAnchors = JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8'));
  const animationsWithWorkingBack = JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8'));
  animationsWithWorkingBack.animations['working-back'] = {
    direction: 'none',
    state: 'working-back',
    loop: true,
    frames: [
      { file: 'assets/animations/walk/left/walk-left-01.png', durationMs: null, anchor: null, visibleBounds: { x: 37, y: 49, width: 256, height: 256 } },
      { file: 'assets/animations/walk/left/walk-left-02.png', durationMs: null, anchor: null, visibleBounds: { x: 46, y: 49, width: 256, height: 256 } },
      { file: 'assets/animations/walk/left/walk-left-03.png', durationMs: null, anchor: null, visibleBounds: { x: 45, y: 49, width: 256, height: 256 } },
    ],
  };
  const packWithWorkingBack = assetPack.createAssetPack({
    manifest: fixtureManifest,
    anchors: fixtureAnchors,
    animations: animationsWithWorkingBack,
  }).pack;

  const flatModule = officeModule.createOfficeModule({
    pack: packWithWorkingBack,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'e6d-seed',
    config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });

  // D1: standing at the own desk keeps the back pose; the back view belongs
  // to the desk (and walking up), not to stopping mid-corridor
  const idle = emp(flatModule.state());
  assert.equal(idle.animation.resource, 'side-back', 'the desk pose renders the back view');

  startTask(flatModule, 'sess-e6d');
  const working = tickUntil(flatModule, (state) => {
    const employee = emp(state);
    return employee.transition && employee.transition.phase === 'work';
  });
  assert.equal(working, true, 'the task reaches the work phase');

  // seated working resolves the dedicated working-back loop: over one full
  // cycle (3 × 1000ms default frame duration) all three frame indices play
  const seenResources = new Set();
  const seenFrameIndices = new Set();
  for (let i = 0; i < 260; i += 1) { // ~4.16s > one 3s loop
    flatModule.tickOnce();
    const animation = emp(flatModule.state()).animation;
    seenResources.add(animation.resource);
    if (animation.resource === 'working-back') seenFrameIndices.add(animation.frameIndex);
  }
  assert.deepEqual([...seenResources].sort(), ['working-back'],
    `seated working plays ONLY working-back (saw ${[...seenResources].sort().join(',')})`);
  assert.deepEqual([...seenFrameIndices].sort(), [0, 1, 2], 'all three frames of the loop play');

  // the finished result expression is untouched (never working-back/side-back)
  flatModule.ingestHarnessEvent({ sessionId: 'sess-e6d', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const finished = tickUntil(flatModule, (state) => {
    const employee = emp(state);
    return employee.animation && employee.animation.resource === 'finished';
  });
  assert.equal(finished, true, 'the finished result expression still plays');
});

// ---------------------------------------------------------------------------
// M4.1a (2026-09-17) — the movement model: fail-closed per-leg reservations,
// cross-employee visibility, truthful waiting. Reproduction of the user's
// "两个鲸鱼娘走着走着重叠" report, plus the model's invariants.
// ---------------------------------------------------------------------------

test('M4.1a: roaming residents never pass through — reservations gate every leg', () => {
  const module = makeModule();
  const CLEARANCE_PX = 0.045 * 840 - 6; // slack under the 0.045 social distance
  const positions = new Map();
  let violations = 0;
  let waitingEvents = 0;
  let worst = Infinity;
  for (let i = 0; i < 20000; i += 1) {
    for (const e of module.state().employees) positions.set(e.employeeId, { ...e.position });
    module.tickOnce();
    const state = module.state();
    const moved = state.employees.filter((e) => {
      const b = positions.get(e.employeeId);
      return b && Math.hypot((e.position.x - b.x) * 1280, (e.position.y - b.y) * 840) > 0.5;
    });
    for (let a = 0; a < moved.length; a += 1) {
      for (let b = a + 1; b < moved.length; b += 1) {
        const dist = Math.hypot(
          (moved[a].position.x - moved[b].position.x) * 1280,
          (moved[a].position.y - moved[b].position.y) * 840
        );
        worst = Math.min(worst, dist);
        if (dist < CLEARANCE_PX) violations += 1;
      }
    }
    const idlers = state.employees.filter((e) => !moved.some((m) => m.employeeId === e.employeeId));
    for (const m of moved) {
      for (const s of idlers) {
        if (Math.hypot((m.position.x - s.position.x) * 1280, (m.position.y - s.position.y) * 840) < 100) waitingEvents += 1;
      }
    }
  }
  assert.equal(violations, 0,
    `no two true movers closer than ${CLEARANCE_PX.toFixed(0)}px (violations=${violations}, worst=${worst.toFixed(1)}px)`);
  assert.ok(waitingEvents > 0, `the gate engaged: someone waited while another passed nearby (events=${waitingEvents})`);
});

test('M4.1a: walking without a live leg reservation is impossible (fail-closed)', () => {
  const module = makeModule();
  let unreservedMoves = 0;
  for (let i = 0; i < 12000; i += 1) {
    const before = new Map(module.state().employees.map((e) => [e.employeeId, { ...e.position }]));
    module.tickOnce();
    const holders = new Map(module.debugReservations().map((r) => [r.employeeId, r.hasPath]));
    for (const e of module.state().employees) {
      const b = before.get(e.employeeId);
      const delta = b ? Math.hypot((e.position.x - b.x) * 1280, (e.position.y - b.y) * 840) : 0;
      // scope: REAL travel only. One tick at the gait speed is ~1.6px; larger
      // single-tick jumps are arrival snaps (the body is anchored exactly onto
      // the node), and anchor-segment motion (approach/stand) is covered by
      // the workstation reservation, not a path leg.
      const covered = holders.get(e.employeeId) || e.segment;
      if (delta > 0.8 && delta < 4 && e.movement === 'moving' && !covered) unreservedMoves += 1;
    }
  }
  assert.equal(unreservedMoves, 0, `every moving tick held a leg reservation (unreserved=${unreservedMoves})`);
});

test('M4.1a: a walker parked mid-route stands AT its recorded node (identity stays true)', () => {
  const module = makeModule();
  let checked = 0;
  for (let i = 0; i < 12000; i += 1) {
    const before = new Map(module.state().employees.map((e) => [e.employeeId, { ...e.position }]));
    module.tickOnce();
    const reservations = module.debugReservations();
    for (const e of module.state().employees) {
      const b = before.get(e.employeeId);
      const delta = b ? Math.hypot((e.position.x - b.x) * 1280, (e.position.y - b.y) * 840) : 0;
      if (delta > 0.5) continue; // only parked ticks
      const info = reservations.find((r) => r.employeeId === e.employeeId);
      if (!info || !info.currentNodeId) continue;
      // only ticks where the body actually stands ON a node are in scope; a
      // mid-leg waiter legitimately keeps the id of the node it last left
      const nearest = module.layout.nodes().reduce((best, node) => {
        const d = Math.hypot((e.position.x - node.position.x) * 1280, (e.position.y - node.position.y) * 840);
        return d < best.d ? { id: node.id, d } : best;
      }, { id: null, d: Infinity });
      if (nearest.d >= 6) continue;
      assert.equal(info.currentNodeId, nearest.id,
        `parked ${e.employeeId} identity matches its body position (body@${nearest.id}, identity=${info.currentNodeId})`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, `the invariant was exercised (checked=${checked} parked ticks)`);
});
