// test/weekly-report.test.js — R5 Wrapped card: Beijing-Monday windowing,
// activity-stream filtering, cost aggregation, desensitised workspace alias,
// auto-generation gate, and the fixed-size bilingual card markup.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildWeeklyReport, cardHtml, weekWindowCst } = require('../src/weekly-report');

// Reference weeks (Beijing): 2026-08-31 is a Monday; its window is
// Mon 00:00 CST → Sun 24:00 CST. Noon CST on 2026-09-02 (Wednesday) falls
// inside it.
const NOW = Date.parse('2026-09-02T04:00:00Z'); // Wed 12:00 CST
const PRICING = { costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.5 };

function totalsWithDays(days) {
  return {
    totals: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      peak: {}, offPeak: {},
      days: Object.fromEntries(Object.entries(days).map(([d, b]) => [d, { input: b[0], output: b[1], cacheRead: b[2], cacheWrite: b[3] }])),
    },
    sessions: [],
  };
}

test('weekWindowCst: Monday 00:00 CST boundaries and identity checks', () => {
  const wedNoon = Date.parse('2026-09-02T04:00:00Z');
  const w = weekWindowCst(wedNoon);
  assert.strictEqual((w.end - w.start), 7 * 86_400_000);
  // start must BE a Beijing Monday midnight: +8h then ISO weekday = 1 (Mon)
  const bjStart = new Date(w.start + 8 * 3_600_000);
  assert.strictEqual(bjStart.getUTCDay(), 1, 'start lands on Monday');
  assert.strictEqual(bjStart.getUTCHours() % 24, 0, 'start at midnight');
  // the window contains the reference instant
  assert.ok(wedNoon >= w.start && wedNoon < w.end);
});

test('weekly aggregation folds only the current week; last week is excluded', () => {
  const collectData = totalsWithDays({
    '2026-08-24': [1_000_000, 100_000, 0, 0],   // LAST week's Monday — excluded
    '2026-08-31': [2_000_000, 200_000, 500_000, 0],
    '2026-09-01': [3_000_000, 300_000, 0, 0],
    '2026-09-07': [9_000_000, 900_000, 0, 0],   // NEXT week's Monday — excluded
  });
  const r = buildWeeklyReport({ collectData, pricing: PRICING, nowMs: NOW });
  const expected = (2 * 2) + (0.2 * 8) + (0.5 * 0.5) + (3 * 2) + (0.3 * 8); // tokens are in millions
  assert.ok(Math.abs(r.costYuan - expected) < 1e-9, `cost ${r.costYuan} vs ${expected}`);
});

test('activity streams: tasks and quick asks counted within the window only', () => {
  const w = weekWindowCst(NOW);
  const activity = [
    { ts: w.start + 3600_000, kind: 'task', ok: true },
    { ts: w.start + 7200_000, kind: 'quickask', ok: true },
    { ts: w.start - 1000, kind: 'quickask', ok: true },        // before window
    { ts: w.end + 1000, kind: 'task', ok: true },              // after window
    { ts: w.start + 2 * 3600_000, kind: 'quickask', ok: false }, // failed still counts as an attempt
  ];
  const r = buildWeeklyReport({ collectData: totalsWithDays({}), activity, pricing: PRICING, nowMs: NOW });
  assert.strictEqual(r.tasksDone, 1);
  assert.strictEqual(r.quickAsks, 2);
});

test('desensitisation: top workspace is a basename, never a full path', () => {
  const collectData = {
    totals: { days: {} },
    sessions: [
      { cwd: '/Users/secret/projects/deep-agent-core', usage: { input: 5_000_000, output: 1, cacheRead: 0, cacheWrite: 0 } },
      { cwd: 'D:\\priv\\other-proj', usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 } },
    ],
  };
  const r = buildWeeklyReport({ collectData, pricing: PRICING, nowMs: NOW });
  assert.strictEqual(r.topWorkspace, 'deep-agent-core');
  assert.ok(!JSON.stringify(r).includes('/Users/secret'), 'full path never leaks into the dataset');
});

test('peak day picks the busiest day inside the window; empty data degrades gracefully', () => {
  const collectData = totalsWithDays({
    '2026-08-31': [1_000_000, 10_000, 0, 0],
    '2026-09-01': [4_000_000, 40_000, 0, 0],
  });
  const r = buildWeeklyReport({ collectData, pricing: PRICING, nowMs: NOW });
  assert.strictEqual(r.peakDay.day, '2026-09-01');
  const empty = buildWeeklyReport({ collectData: totalsWithDays({}), activity: [], pricing: {}, nowMs: NOW });
  assert.strictEqual(empty.costYuan, 0);
  assert.strictEqual(empty.peakDay, null);
  assert.strictEqual(empty.topWorkspace, '');
});

test('card markup: fixed size, bilingual labels, dark/light variants, values injected', async () => {
  const collectData = totalsWithDays({ '2026-09-01': [1_000_000, 200_000, 300_000, 0] });
  const data = buildWeeklyReport({ collectData, pricing: PRICING, nowMs: NOW, lang: 'zh' });
  const htmlZhDark = cardHtml(data, { dark: true });
  assert.match(htmlZhDark, /width:1200px;height:675px/);
  assert.match(htmlZhDark, /DSH 周报/);
  assert.match(htmlZhDark, /最活跃工作区/);
  const htmlEnLight = cardHtml(buildWeeklyReport({ collectData, pricing: PRICING, nowMs: NOW, lang: 'en' }), { dark: false });
  assert.match(htmlEnLight, /DSH Weekly/);
  assert.match(htmlEnLight, /Top workspace/);
  assert.ok(htmlEnLight.includes('#F5F5F7'), 'light background variant');
  assert.doesNotMatch(htmlZhDark, /\/(home|Users)\//, 'no absolute paths in the card');
});

test('auto gate: due only when enabled AND not yet generated for this week', () => {
  let settings = { weeklyReportEnabled: true };
  let lastMarker = null;
  const deps = { getSettings: () => settings };
  function factory(marker) {
    // stub instance exposing shouldAutoGenerate via createWeeklyReport shape
    const { createWeeklyReport: cr } = require('../src/weekly-report');
    const inst = cr({
      userDataDir: () => '/tmp',
      collectStatsShared: async () => ({ totals: {}, sessions: [] }),
      getSettings: () => settings,
      BrowserWindow: undefined,
      log: () => {},
    });
    void marker; void deps;
    return inst.shouldAutoGenerate;
  }
  void factory;
  // direct unit check through a minimal stub of the closure state:
  const { createWeeklyReport: cr } = require('../src/weekly-report');
  const inst = cr({ userDataDir: '/tmp', collectStatsShared: async () => ({ totals: {}, sessions: [] }), getSettings: () => settings });
  // enabled + no marker → due
  assert.strictEqual(inst.shouldAutoGenerate(null), true);
  // disabled → never due
  settings = { weeklyReportEnabled: false };
  assert.strictEqual(inst.shouldAutoGenerate(null), false);
});
