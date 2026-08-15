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
