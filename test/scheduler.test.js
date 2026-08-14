// test/scheduler.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { Scheduler, parseTime, ensureNextRun } = require('../src/scheduler');

test('parseTime validates HH:MM', () => {
  assert.deepStrictEqual(parseTime('09:30'), { h: 9, min: 30 });
  assert.strictEqual(parseTime('25:00'), null);
  assert.strictEqual(parseTime('9:60'), null);
  assert.strictEqual(parseTime('abc'), null);
});

test('every tasks get a next run at now + interval', () => {
  const task = { kind: 'every', everySeconds: 3600 };
  const next = ensureNextRun(task, 1_000_000);
  assert.ok(next >= 1_000_000 + 3_600_000 - 1000);
  assert.strictEqual(ensureNextRun(task, 2_000_000), next); // stable once set
});

test('every tasks missed by more than one interval are skipped, not run', () => {
  const now = Date.now();
  const task = { kind: 'every', everySeconds: 60, nextRunAt: now - 120_000 }; // missed 2 intervals
  const next = ensureNextRun(task, now);
  assert.ok(next > now, 'rescheduled to the future, skipped');
});

test('daily tasks schedule today or tomorrow at HH:MM (local time)', () => {
  const local = (iso, h, m) => { const d = new Date(iso); d.setHours(h, m, 0, 0); return d.getTime(); };
  const task = { kind: 'daily', dailyTime: '23:59' };
  const now = Date.parse('2026-01-01T00:00:00Z');
  const next = ensureNextRun(task, now);
  assert.strictEqual(next, local('2026-01-01T00:00:00Z', 23, 59));
  // when past today's time, roll to tomorrow
  const task2 = { kind: 'daily', dailyTime: '00:01' };
  const next2 = ensureNextRun(task2, Date.parse('2026-01-01T12:00:00Z'));
  assert.strictEqual(next2, local('2026-01-01T12:00:00Z', 0, 1) + 86_400_000);
});

test('Scheduler dispatches due tasks and recomputes nextRunAt', () => {
  const s = new Scheduler(() => {});
  try {
    const fired = [];
    const tasks = [{ id: 't1', name: 't', prompt: 'p', kind: 'every', everySeconds: 60, enabled: true, nextRunAt: Date.now() - 10 }];
    s.start(tasks, (t) => fired.push(t.id)); // start() runs check() -> t1 fires
    assert.deepStrictEqual(fired, ['t1']);
    assert.strictEqual(tasks[0].nextRunAt, undefined, 'recompute after firing');
    // a later check schedules the next occurrence without firing
    s.check();
    assert.ok(tasks[0].nextRunAt > Date.now());
  } finally {
    s.stop();
  }
});
