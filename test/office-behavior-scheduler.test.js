'use strict';

// Task 5 / SPEC-04 — local behavior scheduler (roaming/resting/chatting/sleeping).
// RED: src/office/runtime/behavior-scheduler.js does not exist yet.
//
// Contracts under test:
// - local behavior runs with zero Harness traffic and only ever produces
//   roaming/resting/chatting/sleeping (never running/attention/completed/
//   failed/tool facts or a runtime transcript)
// - injected fake clock and stable seed: identical seed + event sequences
//   replay identically; no Date.now()/Math.random()
// - default probabilities roaming 60% / resting 25% / chatting 15%
// - minimum dwell time and cooldown support
// - target selection goes through the movement controller's waypoint/
//   reservation contract; unavailable targets pick a same-tag candidate or a
//   short wait; never a teleport
// - at most one chat pair: chat-a/chat-b reserved atomically, any single
//   failure cancels both, fixed facing/seats, non-text icon/ellipsis marker
//   with accessibility label only
// - sleeping after the configurable idle threshold (default 300000 ms),
//   defaulting to the personal desk; blocked by unfinished bindings and by
//   sync=stale/resyncing
// - trusted running/attention facts or explicit commands interrupt local
//   behavior immediately and release both chat reservations; sync=stale/
//   resyncing never ends local behavior

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const movementController = require('../src/office/runtime/movement-controller.js');
const schedulerModule = require('../src/office/runtime/behavior-scheduler.js');
const idleDirector = require('../src/office/runtime/idle-director.js');

function makeGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-2', position: { x: 0.4, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-3', position: { x: 0.6, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-4', position: { x: 0.8, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'roam-1', position: { x: 0.25, y: 0.7 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'roam-2', position: { x: 0.5, y: 0.8 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'roam-3', position: { x: 0.85, y: 0.85 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'rest-1', position: { x: 0.15, y: 0.45 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
      { id: 'rest-2', position: { x: 0.7, y: 0.65 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
      { id: 'quiet-room', position: { x: 0.1, y: 0.9 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'chat-a', position: { x: 0.35, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
      { id: 'chat-b', position: { x: 0.45, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
    ],
    edges: [
      { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'desk-2', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'desk-3', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'desk-4', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'roam-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'roam-2', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'roam-3', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'chat-a', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'chat-b', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
      { from: 'hall', to: 'rest-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting', 'resting'], bidirectional: true },
      { from: 'hall', to: 'rest-2', behaviors: ['roaming', 'task', 'sleeping', 'chatting', 'resting'], bidirectional: true },
      // quiet-room is reachable for roaming only: chatting routes from it are
      // unreachable, which exercises the no-teleport chat fallback
      { from: 'hall', to: 'quiet-room', behaviors: ['roaming'], bidirectional: true },
    ],
  };
}

function createMovement(graph) {
  return movementController.createMovementController({ graph, clock: { nowMs: () => 0 } });
}

function makeScheduler(overrides = {}) {
  const graph = overrides.graph || makeGraph();
  const movement = overrides.movement || createMovement(graph);
  return schedulerModule.createBehaviorScheduler({
    graph,
    movement,
    clock: overrides.clock || { nowMs: () => 0 },
    seed: overrides.seed || 'office-seed-1',
    config: overrides.config || undefined,
  });
}

test('module exposes the scheduler factory and frozen config', () => {
  assert.equal(typeof schedulerModule.createBehaviorScheduler, 'function');
  assert.equal(schedulerModule.DEFAULT_SLEEP_AFTER_MS, 300000);
  assert.deepEqual(schedulerModule.DEFAULT_PROBABILITIES, {
    roaming: 0.6,
    resting: 0.25,
    chatting: 0.15,
  });
});

test('M4.1e: target selection keeps personal space — a crowded candidate loses to a free one', () => {
  // M4.1h note: this contract is pinned with the left-rest-area preference OFF
  // (`leftRoamBias: 0`). With the preference ON (the default) a left draw may
  // legitimately DEFER the walk instead of taking a crowded left node — that
  // deferral has its own test below; the keep-away ordering this test pins is
  // unchanged for every non-left draw.
  // Peers parked on roam-1 / roam-3 / quiet-room; only roam-2 stays free, so
  // every roaming decision must land on roam-2 while the peers stand there.
  // A fresh scheduler per sample: one live reservation per decision, so the
  // candidate pool is not emptied by the previous sample's own reservation.
  const graph = makeGraph();
  const peers = [
    { employeeId: 'peer-a', position: { x: 0.25, y: 0.7 } },
    { employeeId: 'peer-b', position: { x: 0.85, y: 0.85 } },
    { employeeId: 'peer-c', position: { x: 0.1, y: 0.9 } },
  ];
  const residentIds = ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'];
  let roaming = 0;
  for (let i = 0; i < 60; i += 1) {
    const decision = makeScheduler({ graph, config: { leftRoamBias: 0 } }).decide({
      employeeId: residentIds[i % residentIds.length],
      nowMs: 60000 + i * 45000,
      fromNodeId: 'hall',
      bindingActive: false,
      sync: 'healthy',
      peers,
    });
    if (decision.activity !== 'roaming' || !decision.target) continue;
    roaming += 1;
    assert.equal(decision.target.nodeId, 'roam-2',
      `roaming target ${decision.target.nodeId} must avoid the peers' personal space`);
  }
  assert.ok(roaming > 5, `the sample actually produced roaming decisions (${roaming})`);
  // Peers parked at every roaming spot: the preference degrades to the old
  // behavior instead of stalling (liveness).
  const crowded = [
    { employeeId: 'peer-a', position: { x: 0.25, y: 0.7 } },
    { employeeId: 'peer-b', position: { x: 0.5, y: 0.8 } },
    { employeeId: 'peer-c', position: { x: 0.85, y: 0.85 } },
    { employeeId: 'peer-d', position: { x: 0.1, y: 0.9 } },
  ];
  let stillTargeted = 0;
  for (let i = 0; i < 60; i += 1) {
    const decision = makeScheduler({ graph, config: { leftRoamBias: 0 } }).decide({
      employeeId: residentIds[i % residentIds.length],
      nowMs: 60000 + i * 45000,
      fromNodeId: 'hall',
      bindingActive: false,
      sync: 'healthy',
      peers: crowded,
    });
    if (decision.activity === 'roaming' && decision.target) stillTargeted += 1;
  }
  assert.ok(stillTargeted > 5,
    `a fully crowded office still produces roaming targets (${stillTargeted})`);
});

test('office open: first decision produces local behavior with zero harness events', () => {
  const scheduler = makeScheduler();
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    bindingActive: false,
    sync: 'healthy',
  });
  assert.ok(decision, 'a decision is produced without any harness event');
  assert.ok(['roaming', 'resting', 'chatting', 'sleeping'].includes(decision.activity));
  assert.equal('runtime' in decision, false);
  assert.equal('tool' in decision, false);
  if (decision.activity === 'roaming') {
    assert.ok(decision.target, 'roaming decisions carry a graph target');
    assert.ok(decision.target.nodeId);
  }
});

test('decisions are always local-only across many employees and ticks', () => {
  const scheduler = makeScheduler();
  const local = new Set(['roaming', 'resting', 'chatting', 'sleeping', 'continue']);
  for (let i = 0; i < 40; i += 1) {
    for (const employeeId of ['orchestrator', 'researcher', 'coder', 'reviewer']) {
      const decision = scheduler.decide({
        employeeId,
        nowMs: i * 5000,
        fromNodeId: 'hall',
        bindingActive: false,
        sync: 'healthy',
      });
      assert.ok(local.has(decision.activity), `activity ${decision.activity} must be local-only`);
      const json = JSON.stringify(decision);
      assert.equal(/"(runtime|transcript|tool|completed|failed|attention)"/.test(json), false);
    }
  }
});

test('same seed and event sequence reproduce identical decisions', () => {
  function replay() {
    const scheduler = makeScheduler();
    const out = [];
    for (let i = 0; i < 10; i += 1) {
      for (const employeeId of ['orchestrator', 'researcher', 'coder', 'reviewer']) {
        out.push(scheduler.decide({ employeeId, nowMs: i * 5000, fromNodeId: 'hall' }));
      }
    }
    return JSON.stringify(out);
  }
  assert.equal(replay(), replay());
});

test('different seeds produce different decision streams', () => {
  function replay(seed) {
    const scheduler = makeScheduler({ seed });
    const out = [];
    for (let i = 0; i < 10; i += 1) {
      for (const employeeId of ['orchestrator', 'researcher', 'coder', 'reviewer']) {
        out.push(scheduler.decide({ employeeId, nowMs: i * 5000, fromNodeId: 'hall' }));
      }
    }
    return JSON.stringify(out);
  }
  assert.notEqual(replay('seed-a'), replay('seed-b'));
});

test('the runtime source avoids Date.now and Math.random', () => {
  const files = [
    'src/office/runtime/behavior-scheduler.js',
    'src/office/runtime/idle-director.js',
    'src/office/runtime/employee-registry.js',
    'src/office/runtime/employee-profile.js',
    'src/office/runtime/queue-controller.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /Math\.random|Date\.now/);
  }
});

test('default activity probabilities stay 60/25/15', () => {
  const scheduler = makeScheduler();
  const counts = { roaming: 0, resting: 0, chatting: 0 };
  const draws = 3000;
  for (let i = 0; i < draws; i += 1) {
    const roll = scheduler.rollActivity('probability-probe');
    counts[roll] += 1;
  }
  assert.ok(Math.abs(counts.roaming / draws - 0.6) < 0.05, `roaming ${counts.roaming / draws}`);
  assert.ok(Math.abs(counts.resting / draws - 0.25) < 0.05, `resting ${counts.resting / draws}`);
  assert.ok(Math.abs(counts.chatting / draws - 0.15) < 0.05, `chatting ${counts.chatting / draws}`);
});

test('minimum dwell time suppresses rapid re-decisions', () => {
  const scheduler = makeScheduler();
  const first = scheduler.decide({ employeeId: 'coder', nowMs: 0, fromNodeId: 'hall' });
  assert.notEqual(first.activity, 'continue');
  const early = scheduler.decide({ employeeId: 'coder', nowMs: 1000, fromNodeId: 'hall' });
  assert.equal(early.activity, 'continue');
  assert.equal(early.current.activity, first.activity);
  const later = scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' });
  assert.notEqual(later.activity, 'continue');
});

test('roaming targets route through the movement controller reservation contract', () => {
  const scheduler = makeScheduler();
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    forceActivity: 'roaming',
  });
  assert.equal(decision.activity, 'roaming');
  assert.ok(decision.target.nodeId);
  assert.ok(Array.isArray(decision.target.route), 'target carries a route');
  const reservations = scheduler.reservations();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].owner, 'coder');
  assert.equal(reservations[0].nodeId, decision.target.nodeId);
});

test('unavailable roaming targets fall back to same-tag candidates, then a short wait', () => {
  const graph = makeGraph();
  const movement = createMovement(graph);
  const reserved = [];
  function reserve(employeeId, nodeId) {
    const acquired = movement.acquireReservation({
      employeeId,
      purpose: 'roaming',
      nodeId,
      reservations: reserved,
      nowMs: 0,
      ttlMs: 60000,
      safeRadius: 0.02,
    });
    assert.equal(acquired.ok, true, `${employeeId} reserves ${nodeId}`);
    reserved.push(acquired.reservation);
  }
  // fill roam-1 and roam-2 to capacity (1 each); roam-3 stays free.
  // quiet-room is roaming-tagged too, so it is blocked as well to keep
  // roam-3 the only same-tag fallback candidate.
  reserve('visitor-1a', 'roam-1');
  reserve('visitor-2a', 'roam-2');
  reserve('visitor-qa', 'quiet-room');

  // M4.1h: pinned with the left preference OFF — with it on (the default) a
  // left draw that finds its pool fully reserved DEFERS the walk (see the
  // "silently reversing" test below) instead of falling back to roam-3. This
  // test keeps pinning the same-tag fallback for non-left draws.
  const scheduler = makeScheduler({ graph, movement, config: { leftRoamBias: 0 } });
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    forceActivity: 'roaming',
    externalReservations: reserved,
  });
  assert.equal(decision.activity, 'roaming');
  assert.ok(decision.target);
  assert.equal(decision.target.nodeId, 'roam-3', 'same-tag fallback selects the only free node');

  reserve('visitor-3a', 'roam-3');
  const blocked = scheduler.decide({
    employeeId: 'researcher',
    nowMs: 0,
    fromNodeId: 'hall',
    forceActivity: 'roaming',
    externalReservations: reserved,
  });
  assert.equal(blocked.target, null);
  assert.ok(blocked.wait);
  assert.ok(blocked.wait.waitMs > 0);
});

test('exactly one chat pair exists and seats are reserved atomically', () => {
  const scheduler = makeScheduler();
  const pair = scheduler.beginChat({ employeeId: 'coder', partnerId: 'researcher', fromNodeId: 'hall', partnerNodeId: 'roam-1', nowMs: 0 });
  assert.equal(pair.ok, true);
  assert.deepEqual(
    pair.seats.map((seat) => seat.nodeId),
    ['chat-a', 'chat-b']
  );
  assert.equal(pair.facing.coder, 'right');
  assert.equal(pair.facing.researcher, 'left');
  assert.equal(scheduler.activeChatPair().a, 'coder');
  assert.equal(scheduler.activeChatPair().b, 'researcher');
  assert.equal(scheduler.reservations().length, 2);

  const second = scheduler.beginChat({ employeeId: 'reviewer', partnerId: 'orchestrator', nowMs: 1 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'CHAT_PAIR_EXISTS');
  assert.equal(scheduler.reservations().length, 2, 'no extra reservations leaked');
});

test('a failed chat reservation cancels the whole pair', () => {
  const graph = makeGraph();
  const movement = createMovement(graph);
  const foreign = movement.acquireReservation({
    employeeId: 'visitor',
    purpose: 'chatting',
    nodeId: 'chat-b',
    reservations: [],
    nowMs: 0,
    ttlMs: 60000,
    safeRadius: 0.02,
  });
  assert.equal(foreign.ok, true);
  const scheduler = makeScheduler({ graph, movement });
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'hall',
    partnerNodeId: 'roam-1',
    nowMs: 0,
    externalReservations: [foreign.reservation],
  });
  // the occupied chat-b leg is unreachable under the reservation contract:
  // the pair is cancelled and no partial reservation survives
  assert.equal(pair.ok, false);
  assert.equal(pair.code, 'CHAT_ROUTES_UNAVAILABLE');
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0, 'no partial chat reservation survives');
});

test('a seat reservation failure after routing cancels the pair cleanly', () => {
  const graph = makeGraph();
  const movement = createMovement(graph);
  // the initiator already stands on chat-a; a foreign reservation fills its
  // single capacity. Routing trivially succeeds (same node) but the seat
  // acquisition fails — nothing may be left behind.
  const foreign = movement.acquireReservation({
    employeeId: 'visitor',
    purpose: 'chatting',
    nodeId: 'chat-a',
    reservations: [],
    nowMs: 0,
    ttlMs: 60000,
    safeRadius: 0.02,
  });
  assert.equal(foreign.ok, true);
  const scheduler = makeScheduler({ graph, movement });
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'chat-a',
    partnerNodeId: 'roam-1',
    nowMs: 0,
    externalReservations: [foreign.reservation],
  });
  assert.equal(pair.ok, false);
  assert.equal(pair.code, 'CHAT_SEATS_UNAVAILABLE');
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0);
});

test('chat exposes only a non-text marker with an accessibility label', () => {
  const scheduler = makeScheduler();
  const pair = scheduler.beginChat({ employeeId: 'coder', partnerId: 'researcher', fromNodeId: 'hall', partnerNodeId: 'roam-1', nowMs: 0 });
  assert.equal(pair.presentation.marker, 'chat-ellipsis');
  assert.ok(typeof pair.presentation.accessibleLabel === 'string');
  assert.ok(pair.presentation.accessibleLabel.length > 0);
  const json = JSON.stringify(pair.presentation);
  assert.equal(/"(text|message|transcript|reply|content)"/.test(json), false);
  assert.equal(Object.keys(pair.presentation).includes('messages'), false);
});

test('chat end applies cooldowns and returns both employees to local decisions', () => {
  const scheduler = makeScheduler({
    config: { probabilities: { roaming: 0, resting: 0, chatting: 1 } },
  });
  const started = scheduler.beginChat({ employeeId: 'coder', partnerId: 'researcher', fromNodeId: 'hall', partnerNodeId: 'roam-1', nowMs: 0 });
  assert.equal(started.ok, true);
  const ended = scheduler.endChat({ nowMs: 100 });
  assert.equal(ended.ok, true);
  assert.deepEqual([...ended.employees].sort(), ['coder', 'researcher']);
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0);

  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 200,
    fromNodeId: 'chat-a',
    chatCandidates: [{ employeeId: 'researcher', nodeId: 'chat-b' }],
  });
  assert.equal(decision.activity, 'roaming', 'cooling-down partner cannot re-chat immediately');
  assert.ok(decision.target);
});

test('sleeping unlocks after the configurable idle threshold and targets the desk', () => {
  const scheduler = makeScheduler();
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  const before = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 299999 });
  assert.equal(before.eligible, false);
  assert.deepEqual(before.blockers, ['below-threshold']);

  const at = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 300000 });
  assert.equal(at.eligible, true);
  assert.equal(at.idleMs, 300000);
  assert.equal(at.thresholdMs, 300000);

  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 300000,
    fromNodeId: 'hall',
    forceActivity: 'sleeping',
  });
  assert.equal(decision.activity, 'sleeping');
  assert.equal(decision.target.nodeId, 'desk-3', 'sleep defaults to the personal desk');
  assert.ok(Array.isArray(decision.target.route));
});

test('sleep threshold is injectable via config', () => {
  const scheduler = makeScheduler({ config: { sleepAfterMs: 60000 } });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  assert.equal(scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 59999 }).eligible, false);
  assert.equal(scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 60000 }).eligible, true);
});

test('unfinished bindings and stale sync block sleeping', () => {
  const scheduler = makeScheduler();
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });

  const bound = scheduler.evaluateSleep({
    employeeId: 'coder',
    nowMs: 300000,
    bindingActive: true,
  });
  assert.equal(bound.eligible, false);
  assert.deepEqual(bound.blockers, ['binding-active']);

  const stale = scheduler.evaluateSleep({
    employeeId: 'coder',
    nowMs: 300000,
    sync: 'stale',
  });
  assert.equal(stale.eligible, false);
  assert.deepEqual(stale.blockers, ['sync']);

  const resyncing = scheduler.decide({
    employeeId: 'coder',
    nowMs: 300000,
    fromNodeId: 'hall',
    sync: 'resyncing',
    forceActivity: 'sleeping',
  });
  assert.equal(
    resyncing.activity === 'sleeping',
    false,
    'resyncing never triggers sleeping'
  );
  assert.ok(
    ['roaming', 'resting'].includes(resyncing.activity),
    'the blocked sleeper stays awake in a local activity'
  );
});

test('new tasks do not reset the idle clock wrongly and wake sleepers immediately', () => {
  const scheduler = makeScheduler();
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  scheduler.markTaskStarted({ employeeId: 'coder', nowMs: 100 });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 200 });
  const idle = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 200 + 300000 });
  assert.equal(idle.eligible, true);
  const tooEarly = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 200 + 299999 });
  assert.equal(tooEarly.eligible, false);
});

test('trusted runtime facts or explicit commands interrupt any local activity', () => {
  const scheduler = makeScheduler();
  scheduler.beginChat({ employeeId: 'coder', partnerId: 'researcher', fromNodeId: 'hall', partnerNodeId: 'roam-1', nowMs: 0 });
  const interrupted = scheduler.interruptForTask({
    employeeId: 'coder',
    reason: 'runtime-task',
    nowMs: 10,
  });
  assert.equal(interrupted.ok, true);
  const types = interrupted.effects.map((e) => e.type);
  assert.ok(types.includes('stop-movement'));
  assert.ok(types.includes('release-path-reservations'));
  assert.ok(types.includes('release-chat-lock'));
  assert.ok(types.includes('begin-task-transition'));
  const chatLock = interrupted.effects.find((e) => e.type === 'release-chat-lock');
  assert.deepEqual([...chatLock.employees].sort(), ['coder', 'researcher']);
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0);

  const syncInterrupt = scheduler.interruptForTask({
    employeeId: 'reviewer',
    reason: 'sync-stale',
    nowMs: 20,
  });
  assert.equal(syncInterrupt.ok, false);
  assert.equal(syncInterrupt.code, 'INTERRUPT_REASON_UNSUPPORTED');
});

test('explicit commands release both chat reservations immediately', () => {
  const scheduler = makeScheduler();
  scheduler.beginChat({ employeeId: 'coder', partnerId: 'researcher', fromNodeId: 'hall', partnerNodeId: 'roam-1', nowMs: 0 });
  const interrupted = scheduler.interruptForTask({
    employeeId: 'researcher',
    reason: 'explicit-command',
    nowMs: 5,
  });
  assert.equal(interrupted.ok, true);
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0);
});

test('sleeping employees wake immediately on trusted tasks', () => {
  const scheduler = makeScheduler();
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 300000,
    fromNodeId: 'hall',
    forceActivity: 'sleeping',
  });
  assert.equal(decision.activity, 'sleeping');
  const woken = scheduler.interruptForTask({
    employeeId: 'coder',
    reason: 'runtime-task',
    nowMs: 300100,
  });
  assert.equal(woken.ok, true);
  assert.ok(woken.effects.map((e) => e.type).includes('begin-task-transition'));
});

test('running task marks reset the idle clock and never produce runtime facts', () => {
  const scheduler = makeScheduler();
  scheduler.markTaskStarted({ employeeId: 'coder', nowMs: 100 });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 500 });
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 1000,
    fromNodeId: 'hall',
  });
  const json = JSON.stringify(decision);
  assert.equal(json.includes('"running"'), false);
  assert.equal(json.includes('"completed"'), false);
  assert.equal(json.includes('"failed"'), false);
  assert.equal(json.includes('transcript'), false);
});

// ---- state-reducer SPEC-04 guards (the reducer extension is authorized by
// ---- Task 5; these assertions live here to keep Task 3 test files frozen) --

const stateReducer = require('../src/office/runtime/state-reducer.js');

function reducerEffectCodes(effects) {
  return effects.map((e) => e.code);
}

test('reducer: local sleeping is rejected while a binding is active', () => {
  let state = stateReducer.createOfficeState();
  state = stateReducer.reduceOfficeState(state, { type: 'control/dispatch' }).state;
  state = stateReducer.reduceOfficeState(state, { type: 'binding/bound', sessionId: 's-sleep' }).state;
  const sleeping = stateReducer.reduceOfficeState(state, { type: 'local/activity', activity: 'sleeping' });
  assert.deepEqual(reducerEffectCodes(sleeping.effects), ['SLEEP_BLOCKED_BINDING']);
  assert.equal(sleeping.state.binding, 'bound');
  assert.equal(sleeping.state.activity, 'roaming');
});

test('reducer: local sleeping is rejected while sync is stale or resyncing', () => {
  let state = stateReducer.createOfficeState();
  state = stateReducer.reduceOfficeState(state, { type: 'sync/status', sync: 'stale' }).state;
  const stale = stateReducer.reduceOfficeState(state, { type: 'local/activity', activity: 'sleeping' });
  assert.deepEqual(reducerEffectCodes(stale.effects), ['SLEEP_BLOCKED_SYNC']);
  assert.equal(stale.state.activity, 'roaming');

  state = stateReducer.reduceOfficeState(state, { type: 'sync/status', sync: 'resyncing' }).state;
  const resyncing = stateReducer.reduceOfficeState(state, { type: 'local/activity', activity: 'sleeping' });
  assert.deepEqual(reducerEffectCodes(resyncing.effects), ['SLEEP_BLOCKED_SYNC']);
});

test('reducer: sleeping stays allowed for unbound, healthy residents and never means offline', () => {
  const state = stateReducer.createOfficeState();
  const sleeping = stateReducer.reduceOfficeState(state, { type: 'local/activity', activity: 'sleeping' });
  assert.equal(sleeping.state.activity, 'sleeping');
  assert.equal(sleeping.state.presence, 'present');
  assert.equal(JSON.stringify(sleeping.state).includes('offline'), false);
});

test('reducer: runtime facts always keep presence present', () => {
  for (const fact of ['running', 'attention', 'completed', 'failed']) {
    const state = stateReducer.createOfficeState();
    const result = stateReducer.reduceOfficeState(state, { type: 'runtime/fact', fact });
    assert.equal(result.state.presence, 'present');
  }
});

// ---- Review round: A. resting is a real behavior ---------------------------

test('resting is a real behavior routed through the movement contract', () => {
  const scheduler = makeScheduler();
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    forceActivity: 'resting',
  });
  assert.equal(decision.activity, 'resting', 'forced resting must not degrade to roaming');
  assert.ok(decision.target, 'resting carries a waypoint target');
  assert.equal(decision.target.route[0], 'hall');
  assert.equal(decision.target.route[decision.target.route.length - 1], decision.target.nodeId);
  assert.ok(decision.target.nodeId.startsWith('rest-'), 'target is a resting-tagged waypoint');
  const reservations = scheduler.reservations();
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].owner, 'coder');
  assert.equal(reservations[0].nodeId, decision.target.nodeId);
});

test('blocked resting waypoints return resting with a short wait, never roaming', () => {
  const graph = makeGraph();
  const movement = createMovement(graph);
  const reserved = [];
  for (const nodeId of ['rest-1', 'rest-2']) {
    const acquired = movement.acquireReservation({
      employeeId: `visitor-${nodeId}`,
      purpose: 'resting',
      nodeId,
      reservations: reserved,
      nowMs: 0,
      ttlMs: 60000,
      safeRadius: 0.02,
    });
    assert.equal(acquired.ok, true, `visitor reserves ${nodeId}`);
    reserved.push(acquired.reservation);
  }
  const scheduler = makeScheduler({ graph, movement });
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    forceActivity: 'resting',
    externalReservations: reserved,
  });
  assert.equal(decision.activity, 'resting', 'stays resting while waiting');
  assert.equal(decision.target, null, 'no teleport, no fabricated target');
  assert.ok(decision.wait);
  assert.ok(decision.wait.waitMs > 0);
  // Task E4: resting IN PLACE keeps the current node reserved (the walkthrough
  // gate forbids another roamer parking on the same cell); the blocked
  // waypoints stay untouched.
  const kept = scheduler.reservations();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].owner, 'coder');
  assert.equal(kept[0].nodeId, 'hall');
});

// ---- Review round: B. distance-based partner selection ---------------------

test('chat partner selection is distance-based with a documented tie-break', () => {
  const scheduler = makeScheduler();
  // far candidate listed first, near candidate last: the near one must win
  const choice = scheduler.chooseChatPartner({
    employeeId: 'coder',
    fromNodeId: 'hall',
    nowMs: 0,
    candidates: [
      { employeeId: 'reviewer', nodeId: 'roam-3' },
      { employeeId: 'researcher', nodeId: 'roam-1' },
    ],
  });
  assert.equal(choice.employeeId, 'researcher', 'nearer candidate wins regardless of input order');

  // reversed input order selects the same near partner
  const reversed = scheduler.chooseChatPartner({
    employeeId: 'coder',
    fromNodeId: 'hall',
    nowMs: 0,
    candidates: [
      { employeeId: 'researcher', nodeId: 'roam-1' },
      { employeeId: 'reviewer', nodeId: 'roam-3' },
    ],
  });
  assert.equal(reversed.employeeId, 'researcher');

  // candidates with unknown nodes are excluded, not treated as distance zero
  const invalid = scheduler.chooseChatPartner({
    employeeId: 'coder',
    fromNodeId: 'hall',
    nowMs: 0,
    candidates: [
      { employeeId: 'reviewer', nodeId: 'ghost-node' },
      { employeeId: 'researcher', nodeId: 'roam-1' },
    ],
  });
  assert.equal(invalid.employeeId, 'researcher');

  // desk-1 and desk-4 are symmetric around hall: equal distance resolves by
  // the deterministic lexicographic employeeId tie-break
  const tie = scheduler.chooseChatPartner({
    employeeId: 'orchestrator',
    fromNodeId: 'hall',
    nowMs: 0,
    candidates: [
      { employeeId: 'reviewer', nodeId: 'desk-4' },
      { employeeId: 'researcher', nodeId: 'desk-1' },
    ],
  });
  assert.equal(tie.employeeId, 'researcher');
  const tieFlipped = scheduler.chooseChatPartner({
    employeeId: 'orchestrator',
    fromNodeId: 'hall',
    nowMs: 0,
    candidates: [
      { employeeId: 'researcher', nodeId: 'desk-1' },
      { employeeId: 'reviewer', nodeId: 'desk-4' },
    ],
  });
  assert.equal(tieFlipped.employeeId, 'researcher');
});

// ---- Review round: C. dual chat routes and consistent pair state -----------

test('chat plans real routes for both employees without any teleport path', () => {
  const scheduler = makeScheduler();
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'hall',
    partnerNodeId: 'roam-1',
    nowMs: 0,
  });
  assert.equal(pair.ok, true);
  assert.equal(pair.targets.coder.nodeId, 'chat-a');
  assert.equal(pair.targets.researcher.nodeId, 'chat-b');
  assert.equal(pair.targets.coder.route[0], 'hall');
  assert.equal(pair.targets.coder.route[pair.targets.coder.route.length - 1], 'chat-a');
  assert.equal(pair.targets.researcher.route[0], 'roam-1');
  assert.equal(pair.targets.researcher.route[pair.targets.researcher.route.length - 1], 'chat-b');
  assert.ok(pair.targets.coder.route.length >= 2, 'route is a waypoint walk, not a jump');
  assert.ok(pair.targets.researcher.route.length >= 2);
  // both employees share one consistent chatting state
  assert.equal(scheduler.activeChatPair().a, 'coder');
  assert.equal(scheduler.activeChatPair().b, 'researcher');
  assert.equal(scheduler.reservations().length, 2);
});

test('an unreachable partner route cancels the chat without partial reservations', () => {
  const scheduler = makeScheduler();
  // quiet-room has no chatting edges: the partner leg is UNREACHABLE
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'hall',
    partnerNodeId: 'quiet-room',
    nowMs: 0,
  });
  assert.equal(pair.ok, false);
  assert.equal(pair.code, 'CHAT_ROUTES_UNAVAILABLE');
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0, 'no seat reservation survives a failed leg');
});

test('unknown chat positions fail cleanly instead of teleporting', () => {
  const scheduler = makeScheduler();
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'ghost-node',
    partnerNodeId: 'roam-1',
    nowMs: 0,
  });
  assert.equal(pair.ok, false);
  assert.equal(pair.code, 'CHAT_ROUTES_UNAVAILABLE');
  assert.equal(scheduler.reservations().length, 0);
});

test('chat pair members keep returning pair state until endChat or interrupt', () => {
  const scheduler = makeScheduler();
  const pair = scheduler.beginChat({
    employeeId: 'coder',
    partnerId: 'researcher',
    fromNodeId: 'hall',
    partnerNodeId: 'roam-1',
    nowMs: 0,
  });
  assert.equal(pair.ok, true);

  // long after the dwell window: the partner must stay inside the pair
  const partnerState = scheduler.decide({ employeeId: 'researcher', nowMs: 60000, fromNodeId: 'chat-b' });
  assert.equal(partnerState.activity, 'continue', 'pair member is not re-decided into roaming/resting');
  assert.equal(partnerState.chat.partnerId, 'coder');
  assert.equal(partnerState.chat.seatNodeId, 'chat-b');
  assert.equal(scheduler.activeChatPair().b, 'researcher');
  assert.equal(scheduler.reservations().length, 2, 'pair reservations untouched');

  const initiatorState = scheduler.decide({ employeeId: 'coder', nowMs: 60001, fromNodeId: 'chat-a' });
  assert.equal(initiatorState.activity, 'continue');
  assert.equal(initiatorState.chat.seatNodeId, 'chat-a');
  assert.equal(scheduler.activeChatPair().a, 'coder');
  assert.equal(scheduler.reservations().length, 2);

  // interrupt still releases both seats and the pair
  const interrupted = scheduler.interruptForTask({
    employeeId: 'researcher',
    reason: 'runtime-task',
    nowMs: 60002,
  });
  assert.equal(interrupted.ok, true);
  assert.equal(scheduler.activeChatPair(), null);
  assert.equal(scheduler.reservations().length, 0);
});

test('decide-driven chats carry both routes and keep the pair consistent', () => {
  const scheduler = makeScheduler({
    config: { probabilities: { roaming: 0, resting: 0, chatting: 1 } },
  });
  const decision = scheduler.decide({
    employeeId: 'coder',
    nowMs: 0,
    fromNodeId: 'hall',
    chatCandidates: [{ employeeId: 'researcher', nodeId: 'roam-1' }],
  });
  assert.equal(decision.activity, 'chatting');
  assert.equal(decision.chat.partnerId, 'researcher');
  assert.equal(decision.target.nodeId, 'chat-a', 'initiator target is their chat seat');
  assert.ok(Array.isArray(decision.target.route));
  assert.equal(decision.chat.targets.researcher.nodeId, 'chat-b');
  assert.ok(Array.isArray(decision.chat.targets.researcher.route));
  assert.equal(scheduler.activeChatPair().b, 'researcher');
});

// Task E4 walkthrough gate: 两角色不重叠在同一格 — a node with spare CAPACITY
// is still unavailable to LOCAL parking while another employee's reservation
// occupies it. Capacity bounds how many MAY share a spot over time; the
// scheduler must simply never choose an occupied spot while a free one exists.
test('E4: local parking never shares a node with an active foreign reservation', () => {
  // single roam node with capacity 4: the second roamer must WAIT, not park
  const singleRoamGraph = {
    version: 1,
    nodes: [
      { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-2', position: { x: 0.4, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
    ],
    edges: [
      { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'sleeping'], bidirectional: true },
      { from: 'hall', to: 'desk-2', behaviors: ['roaming', 'sleeping'], bidirectional: true },
    ],
  };
  const scheduler = makeScheduler({ graph: singleRoamGraph });
  const first = scheduler.decide({
    employeeId: 'orchestrator', nowMs: 0, fromNodeId: 'desk-1', forceActivity: 'roaming',
  });
  assert.equal(first.activity, 'roaming');
  assert.equal(first.target.nodeId, 'hall');
  const second = scheduler.decide({
    employeeId: 'researcher', nowMs: 0, fromNodeId: 'desk-2', forceActivity: 'roaming',
  });
  assert.equal(second.target, null, 'the occupied spot is never re-parked');
  assert.equal(second.wait.reason, 'roam-target-unavailable');

  // with a free alternative, the second roamer takes the OTHER node
  const full = makeScheduler();
  const a = full.decide({ employeeId: 'orchestrator', nowMs: 0, fromNodeId: 'desk-1', forceActivity: 'roaming' });
  const b = full.decide({ employeeId: 'researcher', nowMs: 0, fromNodeId: 'desk-2', forceActivity: 'roaming' });
  assert.notEqual(b.target, null, 'a free roam node exists');
  assert.notEqual(b.target.nodeId, a.target.nodeId, 'parking spots never coincide');
});

// Task E4 walkthrough gate: resting IN PLACE (no resting-tagged waypoints in
// the layout) must keep the employee's spot reserved — releasing the node
// reservation while still standing there let another roamer legally park on
// the same cell (observed as distance-0 co-location in the real-shell run).
test('E4: resting in place keeps the current node reserved against other parkers', () => {
  const noRestGraph = {
    version: 1,
    nodes: [
      { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-2', position: { x: 0.4, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
    ],
    edges: [
      { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'sleeping'], bidirectional: true },
      { from: 'hall', to: 'desk-2', behaviors: ['roaming', 'sleeping'], bidirectional: true },
    ],
  };
  const scheduler = makeScheduler({ graph: noRestGraph });
  const rester = scheduler.decide({
    employeeId: 'orchestrator', nowMs: 0, fromNodeId: 'hall', forceActivity: 'resting',
  });
  assert.equal(rester.activity, 'resting');
  assert.equal(rester.target, null, 'no resting-tagged waypoints exist');
  assert.equal(scheduler.reservations().some((r) => r.owner === 'orchestrator' && r.nodeId === 'hall'), true,
    'the rested-in-place node stays reserved');
  const roamer = scheduler.decide({
    employeeId: 'researcher', nowMs: 0, fromNodeId: 'desk-2', forceActivity: 'roaming',
  });
  assert.equal(roamer.target, null, 'the roamer must not park on the rested-in-place cell');
  assert.equal(roamer.wait.reason, 'roam-target-unavailable');
});

// ---------------------------------------------------------------------------
// M4.1g — the frozen-office fix: nap concurrency cap, finite naps, no log spam,
// and a livelier idle director that uses the left rest area.
// ---------------------------------------------------------------------------

const OFFICE_IDS = ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'];

// Five desks so all five residents (including the collaborator) CAN nap.
function makeFiveDeskGraph() {
  const nodes = [{ id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 8, safeRadius: 0.02 }];
  const edges = [];
  for (let i = 1; i <= 5; i += 1) {
    const x = 0.12 + (i - 1) * 0.18;
    nodes.push({ id: `desk-${i}`, position: { x, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 });
    nodes.push({ id: `roam-${i}`, position: { x, y: 0.8 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 });
    edges.push({ from: 'hall', to: `desk-${i}`, behaviors: ['roaming', 'sleeping'], bidirectional: true });
    edges.push({ from: 'hall', to: `roam-${i}`, behaviors: ['roaming'], bidirectional: true });
  }
  return { version: 1, nodes, edges };
}

// The compiled bundled-flat layout (what the real product runs on).
function flatLayoutGraph() {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
  );
  return { version: 1, nodes: fixture.nodes, edges: fixture.edges };
}

test('M4.1g: at most two residents nap at once (configurable cap, default 2)', () => {
  const graph = makeFiveDeskGraph();
  const scheduler = makeScheduler({ graph, config: { sleepAfterMs: 1000 } });
  assert.equal(scheduler.config.maxSleepers, 2, 'the cap defaults to 2');
  assert.equal(schedulerModule.DEFAULT_CONFIG.maxSleepers, 2);

  for (const employeeId of OFFICE_IDS) scheduler.markTaskReleased({ employeeId, nowMs: 0 });
  const picks = {};
  let sleeping = 0;
  for (const employeeId of OFFICE_IDS) {
    const decision = scheduler.decide({ employeeId, nowMs: 5000, fromNodeId: 'hall' });
    picks[employeeId] = decision.activity;
    if (decision.activity === 'sleeping') sleeping += 1;
  }
  assert.ok(sleeping >= 1 && sleeping <= 2, `at most two residents nap, got ${sleeping}`);
  for (const employeeId of OFFICE_IDS) {
    if (picks[employeeId] === 'sleeping') continue;
    assert.ok(['roaming', 'resting', 'chatting'].includes(picks[employeeId]),
      `${employeeId} stays awake in a local activity, got ${picks[employeeId]}`);
  }
});

test('M4.1g: the nap cap is configurable (maxSleepers 1 allows a single nap)', () => {
  const scheduler = makeScheduler({
    graph: makeFiveDeskGraph(),
    config: { sleepAfterMs: 1000, maxSleepers: 1 },
  });
  for (const employeeId of OFFICE_IDS) scheduler.markTaskReleased({ employeeId, nowMs: 0 });
  let sleeping = 0;
  for (const employeeId of OFFICE_IDS) {
    const decision = scheduler.decide({ employeeId, nowMs: 5000, fromNodeId: 'hall' });
    if (decision.activity === 'sleeping') sleeping += 1;
  }
  assert.equal(sleeping, 1, 'a cap of one allows exactly one nap');
});

test('M4.1g: a nap is finite — the sleeper wakes after the duration and can nap again later', () => {
  const scheduler = makeScheduler({
    graph: makeFiveDeskGraph(),
    config: { sleepAfterMs: 1000, sleepDurationMs: 10000, sleepRefractoryMs: 60000 },
  });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  const nap = scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' });
  assert.equal(nap.activity, 'sleeping');
  assert.equal(nap.sleepEvent.phase, 'started');
  assert.equal(nap.sleepEvent.startedAt, 5000);
  assert.equal(nap.sleepEvent.wakeAtMs, 15000);
  assert.equal(nap.sleepEvent.durationMs, 10000);

  // An unfinished nap CONTINUES — never a fresh cycle (the old code restarted
  // the sleep every dwell window, which is what froze the office).
  for (const at of [6000, 10000, 14999]) {
    const mid = scheduler.decide({ employeeId: 'coder', nowMs: at, fromNodeId: 'desk-3' });
    assert.equal(mid.activity, 'continue', `nap continues at ${at}`);
    assert.equal(mid.current.activity, 'sleeping');
  }

  // Past the duration the resident WAKES exactly once, into a local activity.
  const woke = scheduler.decide({ employeeId: 'coder', nowMs: 15000, fromNodeId: 'desk-3' });
  assert.notEqual(woke.activity, 'sleeping');
  assert.ok(['roaming', 'resting', 'chatting'].includes(woke.activity), `awake activity ${woke.activity}`);
  assert.equal(woke.wokeFromSleep.sleptMs, 10000);
  assert.equal(woke.wokeFromSleep.startedAt, 5000);
  assert.equal(woke.wokeFromSleep.endedAt, 15000);
  assert.equal(scheduler.decide({ employeeId: 'coder', nowMs: 15001, fromNodeId: 'desk-3' }).activity, 'continue');

  // A fresh nap needs the idle threshold AND the post-nap refractory to pass.
  const refractory = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 20000 });
  assert.equal(refractory.eligible, false);
  assert.ok(refractory.blockers.includes('nap-refractory'));
  const later = scheduler.evaluateSleep({ employeeId: 'coder', nowMs: 15000 + 60000 });
  assert.equal(later.eligible, true, 'the resident may nap again after the refractory');
});

test('M4.1g: nap durations are random inside the configured range', () => {
  const durations = new Set();
  for (let i = 0; i < 24; i += 1) {
    const scheduler = makeScheduler({ graph: makeFiveDeskGraph(), seed: `nap-range-${i}`, config: { sleepAfterMs: 1000 } });
    scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
    const nap = scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' });
    assert.equal(nap.activity, 'sleeping');
    durations.add(nap.sleepEvent.durationMs);
  }
  for (const duration of durations) {
    assert.ok(duration >= 60000 && duration <= 180000, `nap duration ${duration} stays inside 60-180s`);
  }
  assert.ok(durations.size >= 5, `the duration is a random draw (${durations.size} distinct values)`);

  // The range is configurable: a fixed duration wins over the random draw.
  const fixed = makeScheduler({ graph: makeFiveDeskGraph(), config: { sleepAfterMs: 1000, sleepDurationMs: 7000 } });
  fixed.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  assert.equal(fixed.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' }).sleepEvent.durationMs, 7000);
});

test('M4.1g: a woken sleeper frees the nap slot for the next resident', () => {
  const scheduler = makeScheduler({
    graph: makeFiveDeskGraph(),
    config: { sleepAfterMs: 1000, sleepDurationMs: 10000, sleepRefractoryMs: 0 },
  });
  for (const employeeId of OFFICE_IDS) scheduler.markTaskReleased({ employeeId, nowMs: 0 });
  assert.equal(scheduler.decide({ employeeId: 'orchestrator', nowMs: 5000, fromNodeId: 'hall' }).activity, 'sleeping');
  assert.equal(scheduler.decide({ employeeId: 'researcher', nowMs: 5000, fromNodeId: 'hall' }).activity, 'sleeping');
  const blocked = scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' });
  assert.notEqual(blocked.activity, 'sleeping', 'the third idle resident stays awake');

  const woke = scheduler.decide({ employeeId: 'orchestrator', nowMs: 15000, fromNodeId: 'desk-1' });
  assert.notEqual(woke.activity, 'sleeping');
  const promoted = scheduler.decide({ employeeId: 'coder', nowMs: 15000, fromNodeId: 'hall' });
  assert.equal(promoted.activity, 'sleeping', 'the freed slot goes to a waiting resident');
});

test('M4.1g: a trusted task interrupts a nap and frees its slot immediately', () => {
  const scheduler = makeScheduler({ graph: makeFiveDeskGraph(), config: { sleepAfterMs: 1000 } });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'hall' });
  scheduler.decide({ employeeId: 'researcher', nowMs: 5000, fromNodeId: 'hall' });
  const interrupted = scheduler.interruptForTask({ employeeId: 'coder', reason: 'runtime-task', nowMs: 6000 });
  assert.equal(interrupted.ok, true);
  const third = scheduler.decide({ employeeId: 'reviewer', nowMs: 6000, fromNodeId: 'hall' });
  assert.equal(third.activity, 'sleeping', 'the interrupted nap slot is reusable');
});

test('M4.1g: roaming targets can land in the left rest area (x below the corridor mid)', () => {
  const graph = flatLayoutGraph();
  const left = new Set(idleDirector.resolveLeftAreaNodeIds(graph));
  // M4.1h: the compiled flat layout now DECLARES its break area (rest-area
  // tags on the six left-column nodes), so the explicit declaration replaces
  // the old geometric "wing + corridor-left" guess — the corridor nodes roam-6/
  // roam-7 are no longer part of the pool (they are right of the left half and
  // were never a break area; they only leaked in through the geometric rule).
  assert.deepEqual([...left].sort(), ['roam-10', 'roam-11', 'roam-12', 'roam-13', 'roam-15', 'roam-16'],
    'the compiled flat layout break area is the six tagged left-column nodes');
  for (const id of left) {
    const node = graph.nodes.find((entry) => entry.id === id);
    assert.ok(node.position.x < 0.5, `${id} lives in the left half`);
  }
  const boundary = idleDirector.corridorBoundaryX(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  // A roaming-only director (no napping, no resting/chatting) over the real
  // graph: the left wing must be reachable, and non-left nodes must stay
  // reachable too (the preference is seeded, never a hard rule).
  const scheduler = makeScheduler({
    graph,
    config: {
      sleepAfterMs: 24 * 60 * 60 * 1000,
      probabilities: { roaming: 1, resting: 0, chatting: 0 },
    },
  });
  const targets = new Set();
  for (let i = 0; i < 40; i += 1) {
    const decision = scheduler.decide({
      employeeId: OFFICE_IDS[i % OFFICE_IDS.length],
      nowMs: i * 6000,
      fromNodeId: 'roam-6',
    });
    if (decision.activity !== 'roaming' || !decision.target) continue;
    targets.add(decision.target.nodeId);
  }
  const leftTargets = [...targets].filter((id) => left.has(id));
  assert.ok(leftTargets.length >= 1,
    `roaming reaches the left rest area (targets: ${[...targets].sort().join(',')})`);
  for (const id of leftTargets) {
    assert.ok(nodeById.get(id).position.x < boundary, `${id} sits left of the corridor mid`);
  }
  assert.ok([...targets].some((id) => !left.has(id) && nodeById.get(id).position.x > boundary),
    'right-side roaming nodes stay reachable — the left bias is a preference');
  // the wing itself (x far left) is reachable through the corridor gateway
  assert.ok([...targets].some((id) => nodeById.get(id).position.x < 0.45),
    'the far-left wing nodes are reachable targets');
});

test('M4.1g: the idle director is wired into the scheduler decisions', () => {
  const scheduler = makeScheduler({ graph: makeFiveDeskGraph(), config: { sleepAfterMs: 24 * 60 * 60 * 1000 } });
  const picks = [];
  for (let i = 0; i < 60; i += 1) {
    // 6s cadence: inside every cooldown, so resting cannot repeat back to back
    const decision = scheduler.decide({ employeeId: 'coder', nowMs: i * 6000, fromNodeId: 'hall' });
    if (decision.activity === 'continue') continue;
    picks.push(decision.activity);
  }
  assert.ok(picks.length > 10, `decisions are produced (${picks.length})`);
  for (let i = 1; i < picks.length; i += 1) {
    assert.ok(!(picks[i] === 'resting' && picks[i - 1] === 'resting'), 'no resting twice in a row');
  }
  assert.ok(picks.some((activity) => activity === 'roaming'), 'roaming stays in the mix');
});

test('M4.1g: a napping resident is never recruited into a chat pair', () => {
  const scheduler = makeScheduler({ config: { sleepAfterMs: 1000, sleepDurationMs: 60000 } });
  scheduler.markTaskReleased({ employeeId: 'coder', nowMs: 0 });
  const nap = scheduler.decide({ employeeId: 'coder', nowMs: 5000, fromNodeId: 'desk-3' });
  assert.equal(nap.activity, 'sleeping', 'the coder naps at its own desk');

  // the napper is not an eligible chat partner (an awake one still is)
  const choice = scheduler.chooseChatPartner({
    employeeId: 'researcher',
    fromNodeId: 'hall',
    nowMs: 5000,
    candidates: [
      { employeeId: 'coder', nodeId: 'desk-3' },
      { employeeId: 'reviewer', nodeId: 'desk-4' },
    ],
  });
  assert.ok(choice, 'an awake candidate is still eligible');
  assert.notEqual(choice.employeeId, 'coder', 'the napper is not a chat candidate');

  // a direct beginChat with a napping partner fails cleanly (no silent nap
  // destruction — the old code overwrote the nap cycle and the pair died)
  const pair = scheduler.beginChat({
    employeeId: 'researcher',
    partnerId: 'coder',
    fromNodeId: 'hall',
    partnerNodeId: 'desk-3',
    nowMs: 5000,
  });
  assert.equal(pair.ok, false);
  assert.equal(pair.code, 'CHAT_PARTNERS_UNAVAILABLE');
  assert.equal(scheduler.activeChatPair(), null, 'no pair was created');
  const stillNapping = scheduler.decide({ employeeId: 'coder', nowMs: 6000, fromNodeId: 'desk-3' });
  assert.equal(stillNapping.activity, 'continue', 'the nap survives untouched');
});
