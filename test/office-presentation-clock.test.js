'use strict';

// test/office-presentation-clock.test.js — P3.0 呈现时钟（纯模块）。
//
// 判据：插值只发生在同一段模拟时间线的两次快照之间；暂停/回退/超长间隔/
// 实体新增或消失一律吸附，不产生渲染层事实。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPresentationClock,
  DEFAULT_MAX_GAP_MS,
} = require('../src/office/render/presentation-clock.js');

function snap(simulatedAtMs, employees, extra) {
  return {
    schemaVersion: 1,
    simulatedAtMs,
    paused: false,
    employees: employees.map(([employeeId, x, y]) => ({ employeeId, position: { x, y } })),
    ...(extra || {}),
  };
}

function byId(samples) {
  return new Map(samples.map((s) => [s.employeeId, s]));
}

test('presentation clock: empty until the first capture', () => {
  const clock = createPresentationClock();
  assert.deepEqual(clock.sample(0), []);
  assert.equal(clock.interpolating(0), false);
  assert.deepEqual(clock.stats(), { hasPrevious: false, hasCurrent: false, employeeCount: 0 });
});

test('presentation clock: a single capture samples exactly and never animates', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.2, 0.3]]), 100);
  const [only] = clock.sample(100);
  assert.equal(only.x, 0.2);
  assert.equal(only.y, 0.3);
  assert.equal(only.interpolated, false);
  assert.equal(clock.interpolating(100), false);
  assert.equal(clock.interpolating(1050), false, 'a lone sample never drifts on its own');
});

test('presentation clock: interpolates prev -> curr on the arrival timeline', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.10, 0.10]]), 1000);
  clock.capture(snap(32, [['a', 0.20, 0.30]]), 1016);

  const start = byId(clock.sample(1016)).get('a');
  assert.equal(start.x, 0.10, 'at the newest arrival the picture still shows the previous sample');
  assert.equal(start.y, 0.10);

  const mid = byId(clock.sample(1024)).get('a');
  assert.ok(Math.abs(mid.x - 0.15) < 1e-9);
  assert.ok(Math.abs(mid.y - 0.20) < 1e-9);
  assert.equal(mid.interpolated, true);

  const end = byId(clock.sample(1032)).get('a');
  assert.equal(end.x, 0.20);
  assert.equal(end.y, 0.30);
  assert.equal(end.interpolated, false);

  const later = byId(clock.sample(9000)).get('a');
  assert.equal(later.x, 0.20, 'clamped: never extrapolates past the newest fact');
  assert.equal(clock.interpolating(9000), false);
  assert.equal(clock.interpolating(1024), true);
});

test('presentation clock: alpha never goes negative on clock skew', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
  clock.capture(snap(32, [['a', 0.3, 0.1]]), 1016);
  assert.equal(clock.alphaAt(900), 0);
  assert.equal(clock.sample(900)[0].x, 0.1);
});

test('presentation clock: a long arrival gap is a discontinuity, not an animation', () => {
  const clock = createPresentationClock({ maxGapMs: 100 });
  clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
  clock.capture(snap(32, [['a', 0.9, 0.9]]), 1101); // 101ms > 100ms
  assert.equal(clock.sample(1101)[0].x, 0.9, 'snaps to the newest sample');
  assert.equal(clock.interpolating(1101), false);
  assert.equal(clock.stats().hasPrevious, false);
  assert.ok(DEFAULT_MAX_GAP_MS >= 100);
});

test('presentation clock: paused / frozen / rewound simulation never interpolates', () => {
  for (const nextSimulatedAtMs of [16, 10, 0]) {
    const clock = createPresentationClock();
    clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
    clock.capture(snap(nextSimulatedAtMs, [['a', 0.5, 0.5]]), 1016);
    assert.equal(clock.sample(1016)[0].x, 0.5, `simulatedAtMs=${nextSimulatedAtMs} must snap`);
    assert.equal(clock.interpolating(1020), false);
  }
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
  clock.capture(snap(32, [['a', 0.5, 0.5]], { paused: true }), 1016);
  assert.equal(clock.sample(1016)[0].x, 0.5, 'paused snapshots snap');
  assert.equal(clock.interpolating(1020), false);
});

test('presentation clock: newcomers appear at their own position; leavers disappear', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
  clock.capture(snap(32, [['a', 0.2, 0.2], ['b', 0.7, 0.7]]), 1016);
  const samples = byId(clock.sample(1016));
  assert.equal(samples.get('a').x, 0.1);
  assert.equal(samples.has('b'), true);
  assert.equal(samples.get('b').x, 0.7, 'never interpolated from an implicit 0,0');
  assert.equal(samples.get('b').interpolated, false);

  clock.capture(snap(48, [['b', 0.8, 0.8]]), 1032);
  const after = byId(clock.sample(1032));
  assert.equal(after.has('a'), false, 'a removed employee leaves no ghost sample');
  assert.equal(after.get('b').x, 0.7);
});

test('presentation clock: malformed input is refused, valid entries survive', () => {
  const clock = createPresentationClock();
  assert.equal(clock.capture(null, 1000), false);
  assert.equal(clock.capture({ simulatedAtMs: 16 }, 1000), false, 'missing employees array');
  assert.equal(clock.capture(snap(16, []), NaN), false, 'missing arrival time');

  clock.capture({
    simulatedAtMs: 16,
    employees: [
      { employeeId: 'ok', position: { x: 0.5, y: 0.5 } },
      { employeeId: '', position: { x: 0.1, y: 0.1 } },
      { employeeId: 'no-position' },
      { employeeId: 'bad', position: { x: NaN, y: 0.2 } },
      { employeeId: 'bad2', position: { x: 0.2, y: '0.3' } },
      null,
    ],
  }, 1000);
  assert.deepEqual(clock.sample(1000).map((s) => s.employeeId), ['ok']);
  assert.equal(clock.stats().employeeCount, 1);
});

test('presentation clock: identical samples settle immediately', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.4, 0.4]]), 1000);
  clock.capture(snap(32, [['a', 0.4, 0.4]]), 1016);
  assert.equal(clock.interpolating(1016), false, 'no distance means no frame pump');
  assert.equal(clock.sample(1020)[0].x, 0.4);
});

test('presentation clock: reset drops both buffers', () => {
  const clock = createPresentationClock();
  clock.capture(snap(16, [['a', 0.1, 0.1]]), 1000);
  clock.capture(snap(32, [['a', 0.2, 0.2]]), 1016);
  clock.reset();
  assert.deepEqual(clock.sample(1016), []);
  assert.equal(clock.interpolating(1016), false);
  assert.deepEqual(clock.stats(), { hasPrevious: false, hasCurrent: false, employeeCount: 0 });
});
