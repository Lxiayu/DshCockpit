'use strict';

// Task 3 / SPEC-03 — normalized movement and deterministic Waypoint Graph
// routing. RED: src/office/runtime/movement-controller.js does not exist yet.
//
// Contracts under test:
// - normalized [0,1] coordinates; screen distance hypot(dx*w, dy*h)
// - speed = sceneMinDimensionPerSecond × min(scene) px/s（办公场景默认 0.046，与行走步频匹配）
// - resize preserves logical position/target, recalculates distances
// - deterministic BFS preserving fixture edge order; directed vs bidirectional
// - behavior tag filtering, node capacity and safeRadius, expired reservations
// - crossing segments with overlapping safety radii wait for later movers
// - UNREACHABLE instead of teleport; arrival error <= 0.01 normalized
// - reservation acquire, half-life renewal, release on arrival, timeout
// - direction from the dominant segment axis with deterministic tie-break

const { test } = require('node:test');
const assert = require('node:assert/strict');

const movementController = require('../src/office/runtime/movement-controller.js');

function makeGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'roam-a', position: { x: 0.1, y: 0.5 }, tags: ['roaming'], capacity: 2, safeRadius: 0.02 },
      { id: 'roam-b', position: { x: 0.5, y: 0.2 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.5, y: 0.5 }, tags: ['desk'], capacity: 1, safeRadius: 0.05 },
      { id: 'desk-2', position: { x: 0.9, y: 0.5 }, tags: ['desk'], capacity: 1, safeRadius: 0.05 },
      { id: 'chat-a', position: { x: 0.3, y: 0.8 }, tags: ['chatting'], capacity: 1, safeRadius: 0.03 },
    ],
    edges: [
      { from: 'roam-a', to: 'desk-1', behaviors: ['roaming', 'task'], bidirectional: true },
      { from: 'roam-a', to: 'roam-b', behaviors: ['roaming'], bidirectional: true },
      { from: 'roam-b', to: 'desk-2', behaviors: ['task'], bidirectional: false },
      { from: 'desk-1', to: 'desk-2', behaviors: ['task'], bidirectional: true },
      { from: 'desk-1', to: 'chat-a', behaviors: ['chatting'], bidirectional: true },
    ],
  };
}

function createController(graph, config) {
  return movementController.createMovementController({ graph, config, clock: { nowMs: () => 0 } });
}

function nodeReservation(owner, nodeId, { acquiredAt = 0, ttlMs = 60000, safeRadius = 0.05 } = {}) {
  return {
    id: `res-${owner}-${nodeId}`,
    owner,
    purpose: `node:${nodeId}`,
    nodeId,
    segments: [],
    safeRadius,
    acquiredAt,
    expiresAt: acquiredAt + ttlMs,
    ttlMs,
    lastRenewedAt: acquiredAt,
    renewalCount: 0,
  };
}

function pathReservation(owner, from, to, { acquiredAt = 0, ttlMs = 60000, safeRadius = 0.05 } = {}) {
  return {
    id: `res-${owner}-path`,
    owner,
    purpose: 'path',
    nodeId: null,
    segments: [{ from, to }],
    safeRadius,
    acquiredAt,
    expiresAt: acquiredAt + ttlMs,
    ttlMs,
    lastRenewedAt: acquiredAt,
    renewalCount: 0,
  };
}

const SCENE = { width: 1000, height: 1000 };

function step(controller, overrides) {
  return controller.step({
    position: { x: 0.1, y: 0.5 },
    target: { x: 0.3, y: 0.5 },
    graph: makeGraph(),
    reservations: [],
    dtMs: 1000,
    scene: SCENE,
    config: null,
    employeeId: 'employee-1',
    nowMs: 0,
    ...overrides,
  });
}

test('horizontal movement follows the normalized speed', () => {
  const controller = createController(makeGraph());
  const result = step(controller, { position: { x: 0.1, y: 0.5 }, target: { x: 0.3, y: 0.5 } });
  assert.equal(result.code, 'OK');
  assert.ok(Math.abs(result.position.x - 0.22) < 1e-9);
  assert.equal(result.position.y, 0.5);
  assert.equal(result.direction, 'right');
  assert.equal(result.arrived, false);
  assert.ok(Math.abs(result.progress - 0.6) < 1e-9);
});

test('vertical movement maps to up and down directions', () => {
  const controller = createController(makeGraph());
  const down = step(controller, { position: { x: 0.5, y: 0.2 }, target: { x: 0.5, y: 0.4 }, scene: { width: 500, height: 500 } });
  assert.ok(Math.abs(down.position.y - 0.32) < 1e-9);
  assert.equal(down.direction, 'down');

  const up = step(controller, { position: { x: 0.5, y: 0.4 }, target: { x: 0.5, y: 0.2 }, scene: { width: 500, height: 500 } });
  assert.equal(up.direction, 'up');
});

test('diagonal movement uses screen distance with a deterministic tie-break', () => {
  const controller = createController(makeGraph());
  const result = step(controller, { position: { x: 0, y: 0 }, target: { x: 1, y: 1 } });
  const expected = 120 / Math.hypot(1000, 1000);
  assert.ok(Math.abs(result.position.x - expected) < 1e-9);
  assert.ok(Math.abs(result.position.y - expected) < 1e-9);
  assert.equal(result.direction, 'right');
});

test('movement speed uses the minimum scene dimension', () => {
  const controller = createController(makeGraph());
  const result = step(controller, {
    position: { x: 0, y: 0.5 },
    target: { x: 1, y: 0.5 },
    scene: { width: 800, height: 400 },
  });
  assert.ok(Math.abs(result.position.x - 0.06) < 1e-9);
  assert.ok(Math.abs(result.progress - 0.06) < 1e-9);
});

test('screen distance honors non-square scenes', () => {
  const controller = createController(makeGraph());
  const result = step(controller, {
    position: { x: 0, y: 0 },
    target: { x: 0.5, y: 0.5 },
    scene: { width: 800, height: 400 },
  });
  const expected = 0.5 * (48 / Math.hypot(400, 200));
  assert.ok(Math.abs(result.position.x - expected) < 1e-9);
  assert.ok(Math.abs(result.position.y - expected) < 1e-9);
  assert.equal(result.direction, 'right');
});

test('resize preserves the logical position and target', () => {
  const controller = createController(makeGraph());
  const before = step(controller, { position: { x: 0.1, y: 0.5 }, target: { x: 0.3, y: 0.5 }, dtMs: 500 });
  assert.ok(Math.abs(before.position.x - 0.16) < 1e-9);

  const after = step(controller, {
    position: before.position,
    target: { x: 0.3, y: 0.5 },
    dtMs: 500,
    scene: { width: 1000, height: 500 },
  });
  assert.ok(Math.abs(after.position.x - 0.19) < 1e-9);
  assert.equal(after.arrived, false);
  assert.ok(Math.abs(after.position.x - 0.16) > 0.005, 'movement continues smoothly, no snap');
});

test('M4.1e: findRoute routes around a node with a standing body', () => {
  // Reproduced 2026-09-17: a capacity-2 corridor node legally holds a second
  // reservation, so reservation checks alone planned routes straight through a
  // parked body and the step refused forever. A body-occupied node must never
  // serve as a waypoint — not even as the route TARGET.
  const controller = createController({
    version: 1,
    nodes: [
      { id: 'A', position: { x: 0.0, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'B', position: { x: 0.5, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'E', position: { x: 0.5, y: 0.0 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'D', position: { x: 1.0, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
    ],
    edges: [
      { from: 'A', to: 'B', behaviors: ['roaming'], bidirectional: true },
      { from: 'B', to: 'D', behaviors: ['roaming'], bidirectional: true },
      { from: 'A', to: 'E', behaviors: ['roaming'], bidirectional: true },
      { from: 'E', to: 'D', behaviors: ['roaming'], bidirectional: true },
    ],
  });
  assert.deepEqual(controller.findRoute({ fromNodeId: 'A', toNodeId: 'D', behavior: 'roaming', reservations: [] }),
    ['A', 'B', 'D'], 'without a body the short leg wins');
  assert.deepEqual(controller.findRoute({ fromNodeId: 'A', toNodeId: 'D', behavior: 'roaming', reservations: [], occupiedNodeIds: ['B'] }),
    ['A', 'E', 'D'], 'an occupied waypoint forces the alternate leg');
  assert.deepEqual(controller.findRoute({ fromNodeId: 'A', toNodeId: 'D', behavior: 'roaming', reservations: [], occupiedNodeIds: ['B', 'E'] }),
    { code: 'UNREACHABLE' }, 'all paths blocked through bodies');
  assert.deepEqual(controller.findRoute({ fromNodeId: 'A', toNodeId: 'D', behavior: 'roaming', reservations: [], occupiedNodeIds: ['D'] }),
    { code: 'UNREACHABLE' }, 'an occupied TARGET is unreachable too');
  assert.deepEqual(controller.findRoute({ fromNodeId: 'A', toNodeId: 'D', behavior: 'roaming', reservations: [], occupiedNodeIds: ['A'] }),
    ['A', 'B', 'D'], "the walker's own node never blocks it");
});

test('findRoute respects directed versus bidirectional edges', () => {
  const directed = createController({
    version: 1,
    nodes: [
      { id: 'A', position: { x: 0, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'B', position: { x: 0.5, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
    ],
    edges: [{ from: 'A', to: 'B', behaviors: ['roaming'], bidirectional: false }],
  });
  assert.deepEqual(directed.findRoute({ fromNodeId: 'A', toNodeId: 'B', behavior: 'roaming', reservations: [] }), ['A', 'B']);
  assert.deepEqual(directed.findRoute({ fromNodeId: 'B', toNodeId: 'A', behavior: 'roaming', reservations: [] }), {
    code: 'UNREACHABLE',
  });

  const controller = createController(makeGraph());
  assert.deepEqual(controller.findRoute({ fromNodeId: 'roam-b', toNodeId: 'roam-a', behavior: 'roaming', reservations: [] }), [
    'roam-b',
    'roam-a',
  ]);
});

test('BFS route order is deterministic and follows fixture edge order', () => {
  const baseNodes = [
    { id: 'S', position: { x: 0, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
    { id: 'A', position: { x: 0.5, y: 0.4 }, tags: [], capacity: 2, safeRadius: 0.01 },
    { id: 'B', position: { x: 0.5, y: 0.6 }, tags: [], capacity: 2, safeRadius: 0.01 },
    { id: 'T', position: { x: 1, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
  ];
  const edgesFirstA = [
    { from: 'S', to: 'A', behaviors: ['roaming'], bidirectional: true },
    { from: 'S', to: 'B', behaviors: ['roaming'], bidirectional: true },
    { from: 'A', to: 'T', behaviors: ['roaming'], bidirectional: true },
    { from: 'B', to: 'T', behaviors: ['roaming'], bidirectional: true },
  ];
  const first = createController({ version: 1, nodes: baseNodes, edges: edgesFirstA });
  assert.deepEqual(first.findRoute({ fromNodeId: 'S', toNodeId: 'T', behavior: 'roaming', reservations: [] }), ['S', 'A', 'T']);

  const edgesFirstB = [edgesFirstA[1], edgesFirstA[0], edgesFirstA[2], edgesFirstA[3]];
  const second = createController({ version: 1, nodes: baseNodes, edges: edgesFirstB });
  assert.deepEqual(second.findRoute({ fromNodeId: 'S', toNodeId: 'T', behavior: 'roaming', reservations: [] }), ['S', 'B', 'T']);
});

test('edges are filtered by behavior tags', () => {
  const controller = createController(makeGraph());
  assert.deepEqual(controller.findRoute({ fromNodeId: 'roam-a', toNodeId: 'desk-1', behavior: 'task', reservations: [] }), [
    'roam-a',
    'desk-1',
  ]);
  assert.deepEqual(controller.findRoute({ fromNodeId: 'roam-a', toNodeId: 'desk-1', behavior: 'chatting', reservations: [] }), {
    code: 'UNREACHABLE',
  });
});

test('node capacity forces an alternate route or UNREACHABLE', () => {
  const controller = createController(makeGraph());
  const reserved = [nodeReservation('employee-2', 'desk-1')];
  assert.deepEqual(controller.findRoute({ fromNodeId: 'roam-a', toNodeId: 'desk-2', reservations: reserved }), [
    'roam-a',
    'roam-b',
    'desk-2',
  ]);

  const both = [...reserved, nodeReservation('employee-3', 'roam-b')];
  assert.deepEqual(controller.findRoute({ fromNodeId: 'roam-a', toNodeId: 'desk-2', reservations: both }), {
    code: 'UNREACHABLE',
  });
});

test('expired reservations are ignored during routing', () => {
  const controller = createController(makeGraph());
  const expired = [
    nodeReservation('employee-2', 'desk-1', { acquiredAt: 0, ttlMs: 1000 }),
    nodeReservation('employee-3', 'roam-b', { acquiredAt: 0, ttlMs: 1000 }),
  ];
  assert.deepEqual(
    controller.findRoute({ fromNodeId: 'roam-a', toNodeId: 'desk-2', behavior: 'task', reservations: expired, nowMs: 2000 }),
    ['roam-a', 'desk-1', 'desk-2']
  );
});

test('safeRadius zones block nearby nodes for routing', () => {
  const controller = createController({
    version: 1,
    nodes: [
      { id: 's', position: { x: 0.4, y: 0.5 }, tags: [], capacity: 5, safeRadius: 0.01 },
      { id: 'near-a', position: { x: 0.5, y: 0.5 }, tags: [], capacity: 5, safeRadius: 0.05 },
      { id: 'near-b', position: { x: 0.53, y: 0.5 }, tags: [], capacity: 5, safeRadius: 0.06 },
      { id: 't', position: { x: 0.6, y: 0.5 }, tags: [], capacity: 5, safeRadius: 0.01 },
    ],
    edges: [
      { from: 's', to: 'near-a', behaviors: ['roaming'], bidirectional: true },
      { from: 'near-a', to: 't', behaviors: ['roaming'], bidirectional: true },
      { from: 'near-b', to: 't', behaviors: ['roaming'], bidirectional: true },
      { from: 's', to: 'near-b', behaviors: ['roaming'], bidirectional: true },
    ],
  });
  const none = controller.findRoute({ fromNodeId: 's', toNodeId: 't', behavior: 'roaming', reservations: [] });
  assert.deepEqual(none, ['s', 'near-a', 't']);

  const nearBOnly = controller.findRoute({
    fromNodeId: 's',
    toNodeId: 't',
    behavior: 'roaming',
    reservations: [nodeReservation('employee-2', 'near-b', { safeRadius: 0.06 })],
  });
  assert.deepEqual(nearBOnly, ['s', 'near-b', 't']);

  const both = controller.findRoute({
    fromNodeId: 's',
    toNodeId: 't',
    behavior: 'roaming',
    reservations: [
      nodeReservation('employee-2', 'near-a', { safeRadius: 0.05 }),
      nodeReservation('employee-3', 'near-b', { safeRadius: 0.06 }),
    ],
  });
  assert.deepEqual(both, { code: 'UNREACHABLE' });
});

test('self reservations do not block routing', () => {
  const controller = createController(makeGraph());
  const mine = [nodeReservation('employee-1', 'desk-1')];
  const self = controller.findRoute({
    fromNodeId: 'desk-2',
    toNodeId: 'chat-a',
    behavior: null,
    reservations: mine,
    employeeId: 'employee-1',
  });
  assert.deepEqual(self, ['desk-2', 'desk-1', 'chat-a']);

  const other = controller.findRoute({
    fromNodeId: 'desk-2',
    toNodeId: 'chat-a',
    behavior: null,
    reservations: [nodeReservation('employee-2', 'desk-1')],
  });
  assert.deepEqual(other, { code: 'UNREACHABLE' });
});

test('crossing segments with overlapping safety radii make the later mover wait', () => {
  const controller = createController(makeGraph());
  const crossing = pathReservation('employee-2', { x: 0, y: 0.25 }, { x: 1, y: 0.25 });
  const result = step(controller, {
    position: { x: 0.5, y: 0 },
    target: { x: 0.5, y: 0.5 },
    reservations: [crossing],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(result.code, 'OK');
  assert.deepEqual(result.position, { x: 0.5, y: 0 });
  assert.equal(result.moved, false);
  assert.equal(result.reservationAction, 'wait');
  assert.equal(result.blockedBy.owner, 'employee-2');
  assert.equal(result.arrived, false);

  const expiredCrossing = pathReservation('employee-2', { x: 0, y: 0.25 }, { x: 1, y: 0.25 }, { ttlMs: 500 });
  const proceeds = step(controller, {
    position: { x: 0.5, y: 0 },
    target: { x: 0.5, y: 0.5 },
    reservations: [expiredCrossing],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(proceeds.moved, true);
});

test('the earlier reservation proceeds while a later one waits', () => {
  const controller = createController(makeGraph());
  const later = pathReservation('employee-1', { x: 0, y: 0.25 }, { x: 1, y: 0.25 }, { acquiredAt: 500 });
  const mine = pathReservation('employee-2', { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }, { acquiredAt: 0 });
  const result = step(controller, {
    position: { x: 0.5, y: 0 },
    target: { x: 0.5, y: 0.5 },
    reservations: [later, mine],
    employeeId: 'employee-2',
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(result.moved, true);
});

test('node reservations gate ARRIVALS at the parking radius and pass-throughs at the social radius', () => {
  const controller = createController(makeGraph());
  // chat-a sits at (0.3, 0.8); its parking radius is 0.03 + mover 0.02 = 0.05
  const nearNode = nodeReservation('employee-2', 'chat-a', { safeRadius: 0.03 });

  const far = step(controller, {
    position: { x: 0.3, y: 0.5 },
    target: { x: 0.3, y: 0.6 },
    reservations: [nearNode],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(far.moved, true);

  // M4.1b (2026-09-17): ARRIVING at the reserved node keeps the full parking
  // radius — a segment ending 0.04 away (inside 0.05) waits.
  const arriving = step(controller, {
    position: { x: 0.3, y: 0.74 },
    target: { x: 0.3, y: 0.76 },
    targetNodeId: 'chat-a',
    reservations: [nearNode],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(arriving.moved, false, 'the target gate blocks the arrival');
  assert.equal(arriving.reservationAction, 'wait');

  // MERELY PASSING the same geometry only keeps the social distance (0.03):
  // 0.04 away is free (the parking radius would deadlock every compiled edge
  // that legitimately runs within it).
  const passing = step(controller, {
    position: { x: 0.3, y: 0.74 },
    target: { x: 0.3, y: 0.76 },
    targetNodeId: 'desk-1',
    reservations: [nearNode],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(passing.moved, true, 'passing outside the social circle is free');

  // passing WITHIN the social circle still waits
  const brushing = step(controller, {
    position: { x: 0.3, y: 0.765 },
    target: { x: 0.3, y: 0.778 },
    targetNodeId: 'desk-1',
    reservations: [nearNode],
    dtMs: 500,
    nowMs: 1000,
  });
  assert.equal(brushing.moved, false, 'the social circle still blocks brushing past a body');
  assert.equal(brushing.reservationAction, 'wait');
});

test('UNREACHABLE routes never teleport the character', () => {
  const controller = createController(makeGraph());
  const result = step(controller, {
    position: { x: 0.5, y: 0.2 },
    target: { x: 0.9, y: 0.5 },
    route: { code: 'UNREACHABLE' },
    dtMs: 1000,
  });
  assert.equal(result.code, 'UNREACHABLE');
  assert.deepEqual(result.position, { x: 0.5, y: 0.2 });
  assert.equal(result.arrived, false);
  assert.equal(result.moved, false);
});

test('arrival lands exactly on the target within tolerance', () => {
  const controller = createController(makeGraph());
  const withinTolerance = step(controller, { position: { x: 0.5, y: 0.498 }, target: { x: 0.5, y: 0.5 } });
  assert.equal(withinTolerance.arrived, true);
  assert.deepEqual(withinTolerance.position, { x: 0.5, y: 0.5 });
  assert.equal(withinTolerance.progress, 1);

  const overshoot = step(controller, { position: { x: 0, y: 0.5 }, target: { x: 0.2, y: 0.5 }, dtMs: 5000 });
  assert.equal(overshoot.arrived, true);
  assert.deepEqual(overshoot.position, { x: 0.2, y: 0.5 });

  const zeroDt = step(controller, { dtMs: 0 });
  assert.equal(zeroDt.moved, false);
  assert.deepEqual(zeroDt.position, { x: 0.1, y: 0.5 });
});

test('arrival releases the mover reservation; renewal fires at half-life', () => {
  const controller = createController(makeGraph());
  const mine = nodeReservation('employee-1', 'desk-1', { acquiredAt: 0, ttlMs: 10000 });
  const arrived = step(controller, {
    position: { x: 0.5, y: 0.498 },
    target: { x: 0.5, y: 0.5 },
    reservations: [mine],
    employeeId: 'employee-1',
    nowMs: 1000,
  });
  assert.equal(arrived.reservationAction, 'release');

  const before = step(controller, {
    position: { x: 0.5, y: 0.5 },
    target: { x: 0.7, y: 0.5 },
    reservations: [mine],
    employeeId: 'employee-1',
    nowMs: 4999,
  });
  assert.equal(before.reservationAction, 'none');

  const due = step(controller, {
    position: { x: 0.5, y: 0.5 },
    target: { x: 0.7, y: 0.5 },
    reservations: [mine],
    employeeId: 'employee-1',
    nowMs: 5000,
  });
  assert.equal(due.reservationAction, 'renew');

  const renewed = controller.renewReservation({ reservation: mine, nowMs: 5000 });
  assert.equal(renewed.expiresAt, 15000);
  assert.equal(renewed.lastRenewedAt, 5000);
  assert.equal(renewed.renewalCount, 1);
  assert.equal(controller.isRenewalDue(renewed, 9999), false);
  assert.equal(controller.isRenewalDue(renewed, 10000), true);
});

test('acquireReservation enforces capacity, safe radius and conflicts', () => {
  const graph = makeGraph();
  const controller = createController(graph);
  const first = controller.acquireReservation({
    employeeId: 'employee-1',
    purpose: 'node:desk-1',
    nodeId: 'desk-1',
    reservations: [],
    nowMs: 0,
    ttlMs: 10000,
    graph,
  });
  assert.equal(first.ok, true);
  assert.equal(first.reservation.owner, 'employee-1');
  assert.equal(first.reservation.purpose, 'node:desk-1');
  assert.equal(first.reservation.acquiredAt, 0);
  assert.equal(first.reservation.expiresAt, 10000);
  assert.ok(Array.isArray(first.reservation.segments));

  const second = controller.acquireReservation({
    employeeId: 'employee-2',
    purpose: 'node:desk-1',
    nodeId: 'desk-1',
    reservations: [first.reservation],
    nowMs: 1000,
    ttlMs: 10000,
    graph,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'RESERVATION_CAPACITY');

  const crossing = controller.acquireReservation({
    employeeId: 'employee-2',
    purpose: 'path',
    segments: [{ from: { x: 0, y: 0.5 }, to: { x: 1, y: 0.5 } }],
    reservations: [pathReservation('employee-1', { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { safeRadius: 0.05 })],
    nowMs: 1000,
    ttlMs: 10000,
    graph,
  });
  assert.equal(crossing.ok, false);
  assert.equal(crossing.code, 'RESERVATION_CONFLICT');

  const released = controller.releaseReservation({ reservations: [first.reservation], id: first.reservation.id });
  assert.equal(released.reservations.length, 0);
  assert.equal(released.released, 1);

  const afterRelease = controller.acquireReservation({
    employeeId: 'employee-2',
    purpose: 'node:desk-1',
    nodeId: 'desk-1',
    reservations: released.reservations,
    nowMs: 2000,
    ttlMs: 10000,
    graph,
  });
  assert.equal(afterRelease.ok, true);
});

test('routeId is derived from the provided route deterministically', () => {
  const controller = createController(makeGraph());
  const result = step(controller, { route: ['roam-a', 'desk-1', 'desk-2'] });
  assert.equal(result.routeId, 'roam-a>desk-1>desk-2');
  assert.equal(step(controller, {}).routeId, null);
});

test('invalid movement input yields a stable diagnostic', () => {
  const controller = createController(makeGraph());
  const bad = step(controller, { position: { x: Number.NaN, y: 0.5 } });
  assert.equal(bad.code, 'MOVEMENT_INVALID_INPUT');
  assert.equal(bad.arrived, false);
  assert.equal(bad.moved, false);
});

test('target node capacity full makes the route UNREACHABLE', () => {
  const controller = createController(makeGraph());
  const reserved = [nodeReservation('employee-2', 'desk-2')];
  assert.deepEqual(
    controller.findRoute({ fromNodeId: 'desk-1', toNodeId: 'desk-2', behavior: 'task', reservations: reserved }),
    { code: 'UNREACHABLE' }
  );

  const expired = [nodeReservation('employee-2', 'desk-2', { acquiredAt: 0, ttlMs: 1000 })];
  assert.deepEqual(
    controller.findRoute({ fromNodeId: 'desk-1', toNodeId: 'desk-2', behavior: 'task', reservations: expired, nowMs: 1000 }),
    ['desk-1', 'desk-2']
  );

  const selfReserved = [nodeReservation('employee-1', 'desk-2')];
  assert.deepEqual(
    controller.findRoute({
      fromNodeId: 'desk-1',
      toNodeId: 'desk-2',
      behavior: 'task',
      reservations: selfReserved,
      employeeId: 'employee-1',
    }),
    ['desk-1', 'desk-2']
  );
});

test('target inside another reservation safeRadius is not routable', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 'a', position: { x: 0.4, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'blocker', position: { x: 0.93, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.03 },
      { id: 't', position: { x: 0.9, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.05 },
    ],
    edges: [{ from: 'a', to: 't', behaviors: ['roaming'], bidirectional: true }],
  };
  const controller = createController(graph);
  assert.deepEqual(controller.findRoute({ fromNodeId: 'a', toNodeId: 't', behavior: 'roaming', reservations: [] }), ['a', 't']);
  assert.deepEqual(
    controller.findRoute({
      fromNodeId: 'a',
      toNodeId: 't',
      behavior: 'roaming',
      reservations: [nodeReservation('employee-2', 'blocker', { safeRadius: 0.03 })],
    }),
    { code: 'UNREACHABLE' }
  );
});

test('path reservation safeRadius covers every segment when routing', () => {
  const graph = {
    version: 1,
    nodes: [
      { id: 's', position: { x: 0.1, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
      { id: 'x', position: { x: 0.5, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.05 },
      { id: 't', position: { x: 0.9, y: 0.5 }, tags: [], capacity: 2, safeRadius: 0.01 },
    ],
    edges: [
      { from: 's', to: 'x', behaviors: ['roaming'], bidirectional: true },
      { from: 'x', to: 't', behaviors: ['roaming'], bidirectional: true },
    ],
  };
  const controller = createController(graph);
  assert.deepEqual(controller.findRoute({ fromNodeId: 's', toNodeId: 't', behavior: 'roaming', reservations: [] }), [
    's',
    'x',
    't',
  ]);

  // First segment stays far from node x; the SECOND segment's end approaches
  // x within its safe radius. The check must consider every segment.
  const twoSegmentPath = {
    id: 'res-employee-2-path',
    owner: 'employee-2',
    purpose: 'path',
    nodeId: null,
    segments: [
      { from: { x: 0, y: 0.2 }, to: { x: 0.4, y: 0.2 } },
      { from: { x: 0.4, y: 0.2 }, to: { x: 0.5, y: 0.48 } },
    ],
    safeRadius: 0.05,
    acquiredAt: 0,
    expiresAt: 60000,
    ttlMs: 60000,
    lastRenewedAt: 0,
    renewalCount: 0,
  };
  assert.deepEqual(
    controller.findRoute({
      fromNodeId: 's',
      toNodeId: 't',
      behavior: 'roaming',
      reservations: [twoSegmentPath],
    }),
    { code: 'UNREACHABLE' }
  );

  // The same all-segment rule guards acquire: a node near the second segment
  // conflicts even though the first segment is far away.
  const acquire = controller.acquireReservation({
    employeeId: 'employee-3',
    purpose: 'node:x',
    nodeId: 'x',
    reservations: [twoSegmentPath],
    nowMs: 0,
    ttlMs: 60000,
    graph,
  });
  assert.equal(acquire.ok, false);
  assert.equal(acquire.code, 'RESERVATION_CONFLICT');
});

test('an unrelated older node reservation does not grant crossing priority', () => {
  const controller = createController(makeGraph());
  const crossing = pathReservation('employee-2', { x: 0, y: 0.25 }, { x: 1, y: 0.25 }, { acquiredAt: 1000 });
  const unrelatedOldNode = nodeReservation('employee-1', 'chat-a', { acquiredAt: 0 });
  const result = step(controller, {
    position: { x: 0.5, y: 0 },
    target: { x: 0.5, y: 0.5 },
    reservations: [crossing, unrelatedOldNode],
    employeeId: 'employee-1',
    dtMs: 500,
    nowMs: 2000,
  });
  assert.equal(result.moved, false);
  assert.equal(result.reservationAction, 'wait');
  assert.equal(result.blockedBy.owner, 'employee-2');
  assert.deepEqual(result.position, { x: 0.5, y: 0 });
});

test('an unrelated older path reservation does not grant crossing priority', () => {
  const controller = createController(makeGraph());
  const crossing = pathReservation('employee-2', { x: 0, y: 0.25 }, { x: 1, y: 0.25 }, { acquiredAt: 1000 });
  const unrelatedOldPath = pathReservation('employee-1', { x: 0.9, y: 0.9 }, { x: 1, y: 1 }, { acquiredAt: 0 });
  const result = step(controller, {
    position: { x: 0.5, y: 0 },
    target: { x: 0.5, y: 0.5 },
    reservations: [crossing, unrelatedOldPath],
    employeeId: 'employee-1',
    dtMs: 500,
    nowMs: 2000,
  });
  assert.equal(result.moved, false);
  assert.equal(result.reservationAction, 'wait');
  assert.equal(result.blockedBy.owner, 'employee-2');
  assert.deepEqual(result.position, { x: 0.5, y: 0 });
});

// M4.1a (2026-09-17): body awareness — step() refuses to advance into the
// social circle of an occupant, whatever the reservation bookkeeping says.
test('M4.1a: an occupant blocks a step that would enter its social circle', () => {
  const movement = createController(makeGraph(), {});
  const scene = { width: 1000, height: 800 };
  const from = { x: 0.2, y: 0.5 };
  const target = { x: 0.8, y: 0.5 };
  const occupant = { id: 'peer', position: { x: 0.5, y: 0.5 }, radius: 0.05 };
  const blocked = movement.step({
    position: from, target, reservations: [], occupants: [occupant], dtMs: 16, scene, employeeId: 'me', nowMs: 0, route: null,
  });
  assert.equal(blocked.moved, false, 'the step stops short of the occupant');
  assert.equal(blocked.reservationAction, 'wait');
  assert.equal(blocked.blockedBy.owner, 'peer');
  // without the occupant the very same step moves
  const free = movement.step({
    position: from, target, reservations: [], occupants: [], dtMs: 16, scene, employeeId: 'me', nowMs: 0, route: null,
  });
  assert.equal(free.moved, true, 'no occupant, no block');
  // an occupant BEHIND the mover (outside the segment's capsule) never blocks
  const behind = movement.step({
    position: from, target, reservations: [], occupants: [{ id: 'peer', position: { x: 0.05, y: 0.5 }, radius: 0.05 }],
    dtMs: 16, scene, employeeId: 'me', nowMs: 0, route: null,
  });
  assert.equal(behind.moved, true, 'distant occupants are irrelevant');
});
