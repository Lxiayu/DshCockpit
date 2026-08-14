// test/cost.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cost = require('../src/cost');

const RATES = { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5, cacheWritePerM: 2 };

test('costOf converts tokens to money', () => {
  const c = cost.costOf({ input: 1_000_000, output: 500_000, cacheRead: 200_000, cacheWrite: 0 }, RATES);
  assert.strictEqual(Math.round(c * 100) / 100, 2 + 4 + 0.1); // 6.1
});

test('updateHistory upserts today and prunes old', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-')), 'h.json');
  cost.updateHistory(file, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, sessions: 1, cost: 0.1 });
  cost.updateHistory(file, { input: 30, output: 40, cacheRead: 0, cacheWrite: 0, sessions: 2, cost: 0.3 });
  const h = cost.loadHistory(file);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].input, 30);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('summarize sums the last N days', () => {
  const today = cost.todayKey();
  const d1 = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const history = [
    { date: d1, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, sessions: 1, cost: 1 },
    { date: today, input: 50, output: 50, cacheRead: 0, cacheWrite: 0, sessions: 1, cost: 0.5 },
  ];
  const one = cost.summarize(history, 1);
  assert.strictEqual(one.input, 50);
  const two = cost.summarize(history, 2);
  assert.strictEqual(two.input, 150);
});

test('budgetStatus levels', () => {
  assert.strictEqual(cost.budgetStatus(10, 0), null);
  assert.strictEqual(cost.budgetStatus(70, 100), null);
  assert.strictEqual(cost.budgetStatus(85, 100), 'warn');
  assert.strictEqual(cost.budgetStatus(100, 100), 'exceed');
});
