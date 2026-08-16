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
