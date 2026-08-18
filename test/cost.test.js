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

// ---- peak/off-peak engine ------------------------------------------------
const WINDOWS = [[9, 12], [14, 18]];

test('parseWindows parses valid window strings', () => {
  assert.deepStrictEqual(cost.parseWindows('9-12,14-18'), [[9, 12], [14, 18]]);
  assert.deepStrictEqual(cost.parseWindows('9-12, 14-18'), [[9, 12], [14, 18]]);
  assert.deepStrictEqual(cost.parseWindows('9'), [[9, 10]]);
  assert.deepStrictEqual(cost.parseWindows('0-24'), [[0, 24]]);
});

test('parseWindows rejects invalid window strings', () => {
  for (const bad of ['', '   ', 'abc', '9-', '-12', '9-25', '25-26', '24', '12-9', '9-12,,14-18', '9.5-12', null, undefined]) {
    assert.strictEqual(cost.parseWindows(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('isPeakTime uses Beijing hours, left-closed right-open', () => {
  // Beijing = UTC+8: UTC 0:00 = Beijing 8:00, UTC 1:00 = Beijing 9:00, …
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 0, 0), WINDOWS), false); // Beijing 8:00
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 1, 0), WINDOWS), true);  // Beijing 9:00 (start incl.)
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 3, 30), WINDOWS), true); // Beijing 11:30
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 4, 0), WINDOWS), false); // Beijing 12:00 (end excl.)
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 6, 0), WINDOWS), true);  // Beijing 14:00
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 10, 0), WINDOWS), false);// Beijing 18:00 (end excl.)
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 1, 0), null), false);
  assert.strictEqual(cost.isPeakTime(Date.UTC(2026, 0, 1, 1, 0), []), false);
});

test('peakStatus reports state and minutes to the next boundary', () => {
  const at = (utcH, utcMin) => Date.UTC(2026, 0, 1, utcH, utcMin);
  let ps = cost.peakStatus(at(3, 30), WINDOWS); // Beijing 11:30 -> peak, window ends 12:00
  assert.strictEqual(ps.peak, true);
  assert.strictEqual(ps.hour, 11);
  assert.strictEqual(ps.nextChangeInMin, 30);
  ps = cost.peakStatus(at(4, 1), WINDOWS); // Beijing 12:01 -> off-peak, next peak 14:00
  assert.strictEqual(ps.peak, false);
  assert.strictEqual(ps.nextChangeInMin, 119);
  ps = cost.peakStatus(at(11, 0), WINDOWS); // Beijing 19:00 -> off-peak, next peak tomorrow 9:00
  assert.strictEqual(ps.peak, false);
  assert.strictEqual(ps.nextChangeInMin, 14 * 60);
  ps = cost.peakStatus(at(0, 0), null); // no windows -> inert status
  assert.strictEqual(ps.peak, false);
  assert.strictEqual(ps.nextChangeInMin, 0);
});

test('costOfSplit splits buckets, degrades without buckets or peak rates', () => {
  const rates = { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.5, cacheWritePerM: 2 };
  const peakRates = { inputPerM: 4, outputPerM: 16, cacheReadPerM: 1, cacheWritePerM: 4 };
  // 1) with peak/offPeak sub-buckets
  const split = cost.costOfSplit({
    peak: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  }, rates, peakRates);
  assert.strictEqual(split.peak, 4);
  assert.strictEqual(split.offPeak, 8);
  assert.strictEqual(split.total, 12);
  // 2) without sub-buckets everything is off-peak at flat rates
  const flat = cost.costOfSplit({ input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 }, rates, peakRates);
  assert.strictEqual(flat.peak, 0);
  assert.strictEqual(flat.offPeak, 6);
  assert.strictEqual(flat.total, 6);
  // 3) empty peakRates -> peak bucket priced at flat rates
  const noPeakRates = cost.costOfSplit({
    peak: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }, rates, null);
  assert.strictEqual(noPeakRates.peak, 2);
  assert.strictEqual(noPeakRates.total, 2);
});

test('updateHistory stores peakCost and summarize accumulates it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-')), 'h.json');
  cost.updateHistory(file, { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, sessions: 1, cost: 0.1, peakCost: 0.04 });
  cost.updateHistory(file, { input: 30, output: 40, cacheRead: 0, cacheWrite: 0, sessions: 2, cost: 0.3, peakCost: 0.12 });
  const h = cost.loadHistory(file);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].peakCost, 0.12);
  assert.strictEqual(cost.summarize(h, 1).peakCost, 0.12);
  // entries written before the field existed count as 0
  assert.strictEqual(cost.summarize([{ date: '2000-01-01', cost: 1 }], 1).peakCost, 0);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

// ---- official price matrix (C1, peak pricing effective 2026-08-17) --------

test('PRICE_MATRIX holds the official v4 flash/pro peak/off-peak prices', () => {
  const m = cost.PRICE_MATRIX;
  assert.deepStrictEqual(m['deepseek-v4-flash'].offPeak, { inputPerM: 1.5, outputPerM: 4.5, cacheReadPerM: 0.05, cacheWritePerM: 0 });
  assert.deepStrictEqual(m['deepseek-v4-flash'].peak, { inputPerM: 3, outputPerM: 9, cacheReadPerM: 0.1, cacheWritePerM: 0 });
  assert.deepStrictEqual(m['deepseek-v4-pro'].offPeak, { inputPerM: 4.5, outputPerM: 13.5, cacheReadPerM: 0.15, cacheWritePerM: 0 });
  assert.deepStrictEqual(m['deepseek-v4-pro'].peak, { inputPerM: 9, outputPerM: 27, cacheReadPerM: 0.3, cacheWritePerM: 0 });
  // cache writes are never billed; peak is exactly 2x off-peak in every dimension
  for (const tiers of Object.values(m)) {
    for (const k of ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM']) {
      assert.strictEqual(tiers.peak[k], tiers.offPeak[k] * 2, `${k} peak must be 2x off-peak`);
    }
  }
});

test('modelRates normalizes legacy and unknown model names', () => {
  assert.strictEqual(cost.normalizeModel('deepseek-v4-flash'), 'deepseek-v4-flash');
  assert.strictEqual(cost.normalizeModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.strictEqual(cost.normalizeModel('DEEPSEEK-V4-PRO'), 'deepseek-v4-pro');
  assert.strictEqual(cost.normalizeModel('deepseek-chat'), 'deepseek-v4-flash'); // retired 2026-07-24
  assert.strictEqual(cost.normalizeModel('deepseek-reasoner'), 'deepseek-v4-flash');
  assert.strictEqual(cost.normalizeModel(''), 'deepseek-v4-flash');
  assert.strictEqual(cost.normalizeModel(undefined), 'deepseek-v4-flash');
  assert.strictEqual(cost.modelRates('deepseek-v4-pro', true).outputPerM, 27);
  assert.strictEqual(cost.modelRates('anything', false).inputPerM, 1.5);
});

test('turnCost: input = hit×hit价 + miss×miss价, output at output价, cache write free', () => {
  // flat (off-peak) totals on v4-flash: 1M miss + 1M hit + 1M out + 1M cacheWrite
  const tc = cost.turnCost(
    { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    'deepseek-v4-flash',
  );
  assert.ok(Math.abs(tc.cost - (1.5 + 0.05 + 4.5 + 0)) < 1e-9);
  // savings = hit tokens x (miss price - hit price)
  assert.ok(Math.abs(tc.saved - (1.5 - 0.05)) < 1e-9);
  assert.strictEqual(tc.inputTokens, 1_000_000);
  assert.strictEqual(tc.cacheReadTokens, 1_000_000);
  assert.strictEqual(tc.outputTokens, 1_000_000);
  // peak/off-peak sub-buckets price in their own window (v4-pro)
  const split = cost.turnCost({
    peak: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
  }, 'deepseek-v4-pro');
  assert.ok(Math.abs(split.cost - (9 + 13.5)) < 1e-9);
});

test('JSONL usage → turn cost caliber (inputTokens=miss, cacheReadTokens=hit, peak/off-peak by event time)', async () => {
  const tokenStats = require('../src/token-stats');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turn-'));
  const file = path.join(dir, 'session.jsonl');
  const peakTime = Date.UTC(2026, 7, 17, 1, 0); // Beijing 17 Aug 09:00 → peak
  const lines = [
    JSON.stringify({ id: 't', cwd: '/tmp' }),
    JSON.stringify({ type: 'assistant/message', time: peakTime, data: { usage: { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 400_000, cacheWriteTokens: 10_000 } } }),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0 } } }), // no time → off-peak
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const r = await tokenStats.parseSessionLogAsync(file, [[9, 12], [14, 18]]);
  assert.strictEqual(r.totals.peak.input, 100_000);
  assert.strictEqual(r.totals.peak.cacheRead, 400_000);
  assert.strictEqual(r.totals.offPeak.input, 100_000);
  const tc = cost.turnCost(r.totals, 'deepseek-v4-flash');
  // peak: (100k×3 + 400k×0.1 + 50k×9)/1e6 = 0.79 ; off-peak: (100k×1.5 + 50k×4.5)/1e6 = 0.375
  assert.ok(Math.abs(tc.cost - (0.79 + 0.375)) < 1e-9);
  // savings: 400k × (3 − 0.1)/1e6 = 1.16
  assert.ok(Math.abs(tc.saved - 1.16) < 1e-9);
  fs.rmSync(dir, { recursive: true, force: true });
});
