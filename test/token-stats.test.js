// test/token-stats.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ts = require('../src/token-stats');

function makeSessionLog(lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-'));
  const dir = path.join(home, 'sessions', 'proj', 'sess1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.join('\n') + '\n');
  return home;
}

const EVENTS = [
  { type: 'user/message', data: {} },
  { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 } } },
  { type: 'assistant/message', data: { usage: { inputTokens: 30, outputTokens: 10 } } },
  { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 } } } },
];

test('sums usage from assistant/message and usage chunks', async () => {
  const home = makeSessionLog(EVENTS.map((e) => JSON.stringify(e)));
  const r = await ts.collect(home);
  assert.strictEqual(r.sessionCount, 1);
  assert.strictEqual(r.current.input, 137);
  assert.strictEqual(r.current.output, 63);
  assert.strictEqual(r.current.cacheRead, 21);
  assert.strictEqual(r.current.cacheWrite, 5);
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    assert.strictEqual(r.totals[k], r.current[k], `totals.${k} === current.${k}`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('collect handles empty and malformed lines', async () => {
  const home = makeSessionLog(['not-json{', '', '{"type":"unknown"}', JSON.stringify(EVENTS[1])]);
  const r = await ts.collect(home);
  assert.strictEqual(r.sessionCount, 1);
  assert.strictEqual(r.current.input, 100);
  fs.rmSync(home, { recursive: true, force: true });
});

test('empty home yields zero totals', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-empty-'));
  const r = await ts.collect(home);
  assert.strictEqual(r.sessionCount, 0);
  assert.strictEqual(r.current, null);
  assert.strictEqual(r.totals.input, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('cache: re-collect does not double count and re-parses on change', async () => {
  const home = makeSessionLog(EVENTS.map((e) => JSON.stringify(e)));
  const r1 = await ts.collect(home);
  const r2 = await ts.collect(home);
  assert.strictEqual(r1.current.input, r2.current.input, 'cached identical result');
  // append one event -> size changes -> re-parse
  fs.appendFileSync(path.join(home, 'sessions', 'proj', 'sess1', 'session.jsonl'), JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 9, outputTokens: 1 } } }) + '\n');
  const r3 = await ts.collect(home);
  assert.strictEqual(r3.current.input, 146);
  fs.rmSync(home, { recursive: true, force: true });
});

test('fmt formats compactly', () => {
  assert.strictEqual(ts.fmt(0), '0');
  assert.strictEqual(ts.fmt(999), '999');
  assert.strictEqual(ts.fmt(1234), '1.2k');
  assert.strictEqual(ts.fmt(1500000), '1.5M');
});

// ---- peak/off-peak bucketing + incremental parsing ------------------------
const WIN = [[9, 12], [14, 18]];
// Beijing = UTC+8: UTC 1:30 = Beijing 9:30 (peak); UTC 20:00 = Beijing 4:00 next day (off-peak)
const T_PEAK = Date.UTC(2026, 0, 1, 1, 30);
const T_OFF = Date.UTC(2026, 0, 1, 20, 0);

test('collect buckets usage events by event time; no-time events go off-peak', async () => {
  const home = makeSessionLog([
    JSON.stringify({ type: 'assistant/message', time: T_PEAK, data: { usage: { inputTokens: 100, outputTokens: 10 } } }),
    JSON.stringify({ type: 'assistant/message', time: T_OFF, data: { usage: { inputTokens: 50, outputTokens: 5 } } }),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 1 } } }), // no time -> off-peak
  ]);
  const r = await ts.collect(home, { windows: WIN });
  assert.strictEqual(r.totals.input, 157);
  assert.strictEqual(r.totals.peak.input, 100);
  assert.strictEqual(r.totals.peak.output, 10);
  assert.strictEqual(r.totals.offPeak.input, 57);
  assert.strictEqual(r.totals.offPeak.output, 6);
  assert.strictEqual(r.sessions[0].usage.peak.input, 100);
  assert.strictEqual(r.sessions[0].usage.offPeak.input, 57);
  fs.rmSync(home, { recursive: true, force: true });
});

test('collect without windows keeps buckets zero and totals unchanged', async () => {
  const home = makeSessionLog(EVENTS.map((e) => JSON.stringify(e)));
  const r = await ts.collect(home);
  assert.strictEqual(r.totals.input, 137);
  assert.strictEqual(r.totals.peak.input, 0);
  assert.strictEqual(r.totals.offPeak.input, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('incremental parse: appended events counted once, partial lines held back', async () => {
  const home = makeSessionLog([
    JSON.stringify({ type: 'assistant/message', time: T_PEAK, data: { usage: { inputTokens: 100, outputTokens: 10 } } }),
  ]);
  const logFile = path.join(home, 'sessions', 'proj', 'sess1', 'session.jsonl');
  const r1 = await ts.collect(home, { windows: WIN });
  assert.strictEqual(r1.totals.input, 100);
  assert.strictEqual(r1.totals.peak.input, 100);
  // append one complete event -> incremental add, no double counting
  fs.appendFileSync(logFile, JSON.stringify({ type: 'assistant/message', time: T_OFF, data: { usage: { inputTokens: 9, outputTokens: 2 } } }) + '\n');
  const r2 = await ts.collect(home, { windows: WIN });
  assert.strictEqual(r2.totals.input, 109);
  assert.strictEqual(r2.totals.peak.input, 100);
  assert.strictEqual(r2.totals.offPeak.input, 9);
  // append a partial (no trailing newline) line -> not counted yet
  const line = JSON.stringify({ type: 'assistant/message', time: T_PEAK, data: { usage: { inputTokens: 1000, outputTokens: 0 } } });
  fs.appendFileSync(logFile, line.slice(0, 20));
  const r3 = await ts.collect(home, { windows: WIN });
  assert.strictEqual(r3.totals.input, 109);
  // complete the line -> counted exactly once
  fs.appendFileSync(logFile, line.slice(20) + '\n');
  const r4 = await ts.collect(home, { windows: WIN });
  assert.strictEqual(r4.totals.input, 1109);
  assert.strictEqual(r4.totals.peak.input, 1100);
  fs.rmSync(home, { recursive: true, force: true });
});

test('incremental parse: concurrent collects must not double-count shared new bytes (P1-1)', async () => {
  const home = makeSessionLog([
    JSON.stringify({ type: 'assistant/message', time: T_PEAK, data: { usage: { inputTokens: 100, outputTokens: 10 } } }),
  ]);
  const logFile = path.join(home, 'sessions', 'proj', 'sess1', 'session.jsonl');
  await ts.parseSessionLogAsync(logFile, WIN); // warm the cache
  fs.appendFileSync(logFile, JSON.stringify({ type: 'assistant/message', time: T_OFF, data: { usage: { inputTokens: 9, outputTokens: 2 } } }) + '\n');

  // two collects interleave inside the same growth window: both stat the same
  // old cache entry, both read the same new bytes — the old in-place
  // accumulation added them twice and left the cache poisoned
  const [a, b] = await Promise.all([
    ts.parseSessionLogAsync(logFile, WIN),
    ts.parseSessionLogAsync(logFile, WIN),
  ]);
  assert.strictEqual(a.totals.input, 109, 'first concurrent parse counts the new bytes once');
  assert.strictEqual(b.totals.input, 109, 'second concurrent parse must not double count');
  assert.strictEqual(a.totals.peak.input, 100);
  assert.strictEqual(b.totals.offPeak.input, 9);

  // the cache must not be poisoned either — a follow-up parse reads 109
  const c = await ts.parseSessionLogAsync(logFile, WIN);
  assert.strictEqual(c.totals.input, 109, 'cache stays consistent after the race');
  fs.rmSync(home, { recursive: true, force: true });
});

test('integration: parses the real live session log if present (zstd, small only)', async () => {
  const realHome = path.join(require('node:os').homedir(), '.dsh');
  const root = path.join(realHome, 'sessions');
  if (!fs.existsSync(root)) {
    console.log('  (skip: no real DSH_HOME sessions on this machine)');
    return;
  }
  let total = 0;
  try {
    for (const f of fs.readdirSync(root, { recursive: true })) {
      try { total += fs.statSync(path.join(root, f)).size; } catch { /* ignore */ }
    }
  } catch { return; }
  if (total > 15 * 1024 * 1024) {
    console.log('  (skip: real session log too large for a unit test)');
    return;
  }
  const r = await ts.collect(realHome);
  assert.ok(r.sessionCount >= 0);
  if (r.sessionCount > 0) {
    assert.ok(r.totals.input >= 0 && r.totals.output >= 0);
  }
});

// ---- session format V3: generation-aware file discovery --------------------

test('V3 generation: the highest session.vN file wins over a stale v0 sibling', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-v3-'));
  const dir = path.join(home, 'sessions', 'proj', 'sess-v3');
  fs.mkdirSync(dir, { recursive: true });
  const line = (n) => JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: n } } });
  // the v0 generation keeps the pre-migration numbers; v3 carries the current ones
  fs.writeFileSync(path.join(dir, 'session.jsonl'), line(1) + '\n');
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl'), line(42) + '\n');
  const r = await ts.collect(home);
  assert.strictEqual(r.sessionCount, 1, 'one session directory yields exactly one log');
  assert.strictEqual(r.current.input, 42, 'reads the v3 generation, not the stale v0 sibling');
  fs.rmSync(home, { recursive: true, force: true });
});

test('V3 generation: a v3-only session (new session on dsh 0.1.5) is discovered', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-v3only-'));
  const dir = path.join(home, 'sessions', '_no-cwd', 'sess-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), '');
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl'),
    JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 5, outputTokens: 6 } } }) + '\n');
  fs.rmSync(path.join(dir, 'session.v3.jsonl.zstd')); // keep the fixture plain-JSONL readable
  const r = await ts.collect(home);
  assert.strictEqual(r.sessionCount, 1);
  assert.strictEqual(r.current.input, 5);
  assert.strictEqual(r.current.output, 6);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- M3 (windows-perf audit): session-tree walk cache TTL ------------------
//
// Defect being pinned: the walk cache TTL was 5s while the cockpit's
// collectStats result cache was 10s, so the walk cache had ALWAYS expired by
// the time a real recompute happened — every 10s re-walked the whole sessions
// tree (2N readdir + 1 stat per session dir; ~900 syscalls/10s at N=300
// sessions) while the app was idle. These tests assert the CACHE HIT, not just
// the returned numbers, so a TTL regression fails loudly.

test('M3: the walk cache stays warm across the 10s cost-cache cadence (one walk, many hits)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-walk-'));
  const line = (n) => JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: n } } });
  for (const [proj, sess, n] of [['proj-a', 's1', 10], ['proj-a', 's2', 20], ['proj-b', 's1', 30]]) {
    const dir = path.join(home, 'sessions', proj, sess);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), line(n) + '\n');
  }
  ts.resetWalkCache();
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: t0 });
  try {
    const base = ts.walkCacheStats();
    const r1 = await ts.collect(home);
    assert.strictEqual(r1.sessionCount, 3);
    assert.strictEqual(ts.walkCacheStats().walks - base.walks, 1, 'the first collect does exactly one walk');

    // The cockpit cadence: the 5s token poll runs 4 times (= 20s of idle), but
    // the 10s result cache means a real recompute lands every other tick. With
    // the old 5s walk TTL every one of these re-walked; now zero do.
    for (let i = 0; i < 4; i += 1) {
      t.mock.timers.tick(5_000);
      const r = await ts.collect(home);
      assert.strictEqual(r.sessionCount, 3);
    }
    const after = ts.walkCacheStats();
    assert.strictEqual(after.walks - base.walks, 1, '20s / 4 collect() calls later: still exactly ONE walk');
    assert.strictEqual(after.hits - base.hits, 4, 'every collect() after the first was served by the walk cache');
    assert.ok(ts.WALK_TTL_MS >= 10_000, 'the walk TTL must not be shorter than the cockpit cost-cache TTL (10s)');
  } finally {
    t.mock.timers.reset();
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('M3: forceWalk (turn-end accounting) still re-walks, and the cache does expire after the TTL', async (t) => {
  const home = makeSessionLog(EVENTS.map((e) => JSON.stringify(e)));
  ts.resetWalkCache();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const base = ts.walkCacheStats();
    await ts.collect(home);
    assert.strictEqual(ts.walkCacheStats().walks - base.walks, 1);
    await ts.collect(home);
    assert.strictEqual(ts.walkCacheStats().walks - base.walks, 1, 'a warm cache is reused');
    // The forced path must see a brand-new session immediately (freshness is
    // exactly what force=true buys) — so it bypasses the list cache.
    const fresh = path.join(home, 'sessions', 'proj', 'sess-new');
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, 'session.jsonl'),
      JSON.stringify({ type: 'assistant/message', data: { usage: { inputTokens: 999 } } }) + '\n');
    const forced = await ts.collect(home, { forceWalk: true });
    assert.strictEqual(ts.walkCacheStats().walks - base.walks, 2, 'forceWalk re-walks');
    assert.strictEqual(forced.sessionCount, 2, 'the brand-new session is visible on the forced path');
    // The poll path stays on the cached list until the TTL lapses...
    const cached = await ts.collect(home, { forceWalk: true });
    assert.strictEqual(cached.sessionCount, 2);
    // ...and picks it up after expiry without another force.
    t.mock.timers.tick(ts.WALK_TTL_MS + 1);
    const later = await ts.collect(home);
    assert.strictEqual(later.sessionCount, 2);
    assert.ok(ts.walkCacheStats().walks - base.walks >= 3, 'the cache expires after the TTL (not a permanent cache)');
  } finally {
    t.mock.timers.reset();
  }
  fs.rmSync(home, { recursive: true, force: true });
});
