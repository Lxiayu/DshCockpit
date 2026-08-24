// test/runtime-supervisor.test.js — A1 supervision primitives: the rolling
// crash-loop guard (legacy main.js semantics preserved: every unexpected exit
// consumes an auto-restart slot, 60s window, max 3, healthy-boot reset).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createCrashLoopGuard } = require('../src/runtime-supervisor');

function fixture() {
  let t = 1_000_000;
  const guard = createCrashLoopGuard({ now: () => t });
  return { guard, tick: (ms) => { t += ms; } };
}

test('up to 3 crashes inside the window allow auto-restart; the 4th trips the loop guard', () => {
  const f = fixture();
  const a = f.guard.record();
  const b = f.guard.record();
  const c = f.guard.record();
  assert.deepStrictEqual([a.restart, b.restart, c.restart], [true, true, true]);
  assert.deepStrictEqual([a.attempt, b.attempt, c.attempt], [1, 2, 3]);
  const d = f.guard.record();
  assert.strictEqual(d.restart, false, '4th crash within 60s must trip the guard');
});

test('a clean exit still consumes an auto-restart slot (M9 legacy semantics)', () => {
  // M9: clean exits are not written to diagnostics but DO advance the guard
  const f = fixture();
  assert.strictEqual(f.guard.record().restart, true);
  assert.strictEqual(f.guard.record().restart, true);
  assert.strictEqual(f.guard.record().restart, true);
  assert.strictEqual(f.guard.record().restart, false);
});

test('crashes older than the 60s window fall out of the count', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) { f.guard.record(); f.tick(10_000); }
  f.tick(35_000); // first crash is now >60s old → window restarts
  const fresh = f.guard.record();
  assert.strictEqual(fresh.restart, true, 'window elapsed → fresh start');
  assert.strictEqual(fresh.attempt, 1);
});

test('reset() models a healthy boot clearing the guard', () => {
  const f = fixture();
  f.guard.record(); f.guard.record(); f.guard.record();
  f.guard.reset();
  const next = f.guard.record();
  assert.strictEqual(next.restart, true);
  assert.strictEqual(next.attempt, 1);
});
