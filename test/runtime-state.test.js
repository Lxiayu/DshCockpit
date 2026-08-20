'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RUNTIME_STATES, createRuntimeStateController } = require('../src/runtime-state');

test('runtime state controller accepts only lifecycle states and suppresses duplicates', () => {
  const seen = [];
  const controller = createRuntimeStateController({ initial: 'starting', onState: (state) => seen.push(state) });
  assert.deepEqual(RUNTIME_STATES, ['starting', 'healthy', 'restarting', 'offline']);
  assert.equal(controller.transition('starting'), false);
  assert.equal(controller.transition('healthy'), true);
  assert.equal(controller.transition('healthy'), false);
  assert.equal(controller.transition('unknown'), false);
  assert.deepEqual(seen, ['healthy']);
});

test('state changes invalidate the snapshot before broadcasting the new state', () => {
  const order = [];
  const controller = createRuntimeStateController({
    onInvalidate: () => order.push('invalidate'),
    onBroadcast: (snapshot) => order.push(`broadcast:${snapshot.state}`),
  });
  controller.transition('healthy');
  assert.deepEqual(order, ['invalidate', 'broadcast:healthy']);
});

test('delayed callbacks from an older generation cannot replace a newer runtime', () => {
  const controller = createRuntimeStateController();
  const generation1 = controller.begin('starting');
  const generation2 = controller.begin('restarting');
  assert.notEqual(generation1, generation2);
  assert.equal(controller.transition('healthy', generation1), false);
  assert.equal(controller.transition('healthy', generation2), true);
  assert.deepEqual(controller.snapshot(), { state: 'healthy', generation: generation2 });
});

test('controller handles startup, manual restart, crash recovery, and crash-loop offline transitions', () => {
  const states = [];
  const controller = createRuntimeStateController({ onState: (state) => states.push(state) });
  const g1 = controller.begin('starting');
  controller.transition('healthy', g1);
  const g2 = controller.begin('restarting');
  controller.transition('offline', g2);
  const g3 = controller.begin('starting');
  controller.transition('healthy', g3);
  controller.transition('offline', g3);
  assert.deepEqual(states, ['starting', 'healthy', 'restarting', 'offline', 'starting', 'healthy', 'offline']);
});
