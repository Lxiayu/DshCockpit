// test/cache-economics.test.js — R4 cache economics: per-day buckets from a
// synthetic session log through the REAL token-stats collect(), then savings
// aggregation (flat vs peak split, month filter, top sessions) with
// division-by-zero and no-cache-event edges.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collect } = require('../src/token-stats');
const { buildCacheEconomics, pricingFromSettings, hitRateOf } = require('../src/cache-economics');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cache-econ-')); }

/** Beijing-day helper: ms for 12:00 UTC+8 on YYYY-MM-DD. */
function bjNoon(day) { return Date.parse(`${day}T12:00:00+08:00`); }

/** Synthetic session: header line + usage events across two billing days. */
function makeSession(dirName, sessionId, events) {
  const proj = path.join(dirName, 'sessions', 'proj-a', sessionId);
  fs.mkdirSync(proj, { recursive: true });
  const header = JSON.stringify({ id: sessionId, cwd: `/home/user/${sessionId}-workspace` });
  const lines = [header, ...events.map((e) => JSON.stringify(e))];
  fs.writeFileSync(path.join(proj, 'session.jsonl'), lines.join('\n') + '\n');
}

function usageEvent(timeMs, input, cacheRead) {
  return { type: 'assistant/message', time: timeMs, data: { usage: { inputTokens: input, outputTokens: 10, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } };
}

// Beijing days chosen to straddle a month boundary: D1 = 2026-08-31, D2 = 2026-09-01
const D1 = '2026-08-31';
const D2 = '2026-09-01';

async function fixture() {
  const home = tmpDir();
  // day1: peak-time usage (12:00 UTC+8 = off-peak by default windows; force
  // peak by using 15:00 CST which IS inside default 9-12,14-18? 15:00 → yes)
  makeSession(home, 's-rich', [
    usageEvent(bjNoon(D1), 100_000, 900_000),          // 1M total, 90% hit
    usageEvent(bjNoon(D2), 200_000, 1_800_000),
  ]);
  makeSession(home, 's-poor', [
    usageEvent(bjNoon(D2) + 3_600_000, 500_000, 0),    // zero cache reads
  ]);
  return home;
}

test('end-to-end: real collect() produces per-day buckets aligned to the Beijing billing day', async () => {
  const home = await fixture();
  const data = await collect(home, {});
  assert.ok(data.totals.days[D1], `day bucket ${D1} present`);
  assert.ok(data.totals.days[D2], `day bucket ${D2} present`);
  assert.strictEqual(data.totals.days[D1].input, 100_000);
  assert.strictEqual(data.totals.days[D2].cacheRead, 1_800_000);
  // sessions carry their own buckets too (per-session drill-down source)
  const rich = data.sessions.find((s) => s.cwd.endsWith('s-rich-workspace'));
  assert.strictEqual(rich.usage.days[D1].cacheRead, 900_000);
});

test('aggregation: flat pricing saves = cacheRead × flat gap; month filter isolates September', async () => {
  const home = await fixture();
  const data = await collect(home, {});
  const pricing = { costInputPerM: 2, costCacheReadPerM: 0.5 };
  const r = buildCacheEconomics(data, pricingFromSettings(pricing));
  // overall: (900k + 1800k)/1M × 1.5 = ¥4.05
  assert.ok(Math.abs(r.overall.savedYuan - 4.05) < 1e-9, `overall saved ${r.overall.savedYuan}`);
  assert.ok(Math.abs(r.overall.hitRate - (2_700_000 / 3_500_000)) < 1e-9);
  // month = September → only day2 events
  const sep = buildCacheEconomics(data, pricingFromSettings(pricing), { month: '2026-09' });
  assert.ok(Math.abs(sep.month.savedYuan - (1_800_000 / 1e6) * 1.5) < 1e-9, `sep saved ${sep.month.savedYuan}`);
  const aug = buildCacheEconomics(data, pricingFromSettings(pricing), { month: '2026-08' });
  assert.ok(Math.abs(aug.month.savedYuan - (900_000 / 1e6) * 1.5) < 1e-9);
  assert.strictEqual(r.byDay.length, 2);
  assert.strictEqual(r.byDay[0].day, D1, 'byDay ascending');
});

test('peak split engages only with costPeakEnabled and uses the peak gaps on peak-bucketed tokens', async () => {
  const home = await fixture();
  const windows = [[9, 12], [14, 18]]; // hours, CST — cost.parseWindows shape
  const data = await collect(home, { windows });
  const off = buildCacheEconomics(data, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5 }));
  const on = buildCacheEconomics(data, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5, costPeakEnabled: true, costPeakInputPerM: 4, costPeakCacheReadPerM: 1 }));
  assert.strictEqual(on.overall.peakSavedYuan !== null, true);
  // noon CST is OFF-peak in the default windows → all tokens priced at the off-peak gap
  assert.ok(Math.abs(on.overall.savedYuan - off.overall.savedYuan) < 1e-9,
    'noon events stay off-peak: enabling the split must not change their price');
  // a genuine peak-time event (15:00 CST) is priced at the peak gap when enabled
  const home2 = tmpDir();
  makeSession(home2, 's-peak', [usageEvent(Date.parse(`${D2}T07:00:00Z`), 1_000_000, 1_000_000)]); // 15:00 CST
  const d2 = await collect(home2, { windows });
  const flat = buildCacheEconomics(d2, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5 }));
  const peakOn = buildCacheEconomics(d2, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5, costPeakEnabled: true, costPeakInputPerM: 4, costPeakCacheReadPerM: 1 }));
  assert.ok(peakOn.overall.savedYuan > flat.overall.savedYuan, 'peak gap (¥3/M) > flat gap (¥1.5/M)');
  assert.ok(Math.abs(peakOn.overall.savedYuan - 3) < 1e-9 && Math.abs(flat.overall.savedYuan - 1.5) < 1e-9);
});

test('edges: zero cache events → zero savings and 0% hit rate (no NaN); empty data tolerated', async () => {
  const home = tmpDir();
  makeSession(home, 's-none', [usageEvent(bjNoon(D1), 500_000, 0)]);
  const data = await collect(home, {});
  const r = buildCacheEconomics(data, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5 }));
  assert.strictEqual(r.overall.savedYuan, 0);
  assert.strictEqual(r.overall.hitRate, 0);
  assert.strictEqual(hitRateOf(null), 0);
  assert.strictEqual(hitRateOf({}), 0);
  const empty = buildCacheEconomics({ totals: {}, sessions: [] }, pricingFromSettings({}));
  assert.strictEqual(empty.overall.savedYuan, 0);
  assert.deepStrictEqual(empty.topSessions, []);
});

test('top sessions: sorted desc by savings, capped at 10, cwd reduced to basename alias', async () => {
  const home = tmpDir();
  for (let i = 0; i < 12; i++) {
    makeSession(home, `ws-${i}`, [usageEvent(bjNoon(D1), 100_000, i * 100_000)]);
  }
  const data = await collect(home, {});
  const r = buildCacheEconomics(data, pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5 }));
  assert.strictEqual(r.topSessions.length, 10, 'capped at 10');
  for (let i = 1; i < r.topSessions.length; i++) {
    assert.ok(r.topSessions[i - 1].savedYuan >= r.topSessions[i].savedYuan, 'descending');
  }
  assert.strictEqual(r.topSessions[0].alias, 'ws-11-workspace', 'richest session first');
  for (const t of r.topSessions) {
    assert.ok(!t.alias.includes('/') && !t.alias.includes('\\'), `alias is basename only (${t.alias})`);
  }
});

test('pricingFromSettings mirrors settings keys and tolerates missing values', () => {
  const p = pricingFromSettings({ costInputPerM: 2, costCacheReadPerM: 0.5, costPeakEnabled: true, costPeakInputPerM: 4, costPeakCacheReadPerM: 1 });
  assert.deepStrictEqual(p, { inputPerM: 2, cacheReadPerM: 0.5, peakEnabled: true, peakInputPerM: 4, peakCacheReadPerM: 1 });
  const bare = pricingFromSettings({});
  assert.strictEqual(bare.inputPerM, 0);
  assert.strictEqual(bare.peakEnabled, false);
});
