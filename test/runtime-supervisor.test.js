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
  // last recorded crash was 10s ago; jump past the 60s window from it
  f.tick(61_000);
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

// ---- runtime URL line (dsh 0.1.2+ prints the authenticated URL) -------------

test('parseRuntimeUrl keeps the launch token and derives the clean origin', () => {
  const { parseRuntimeUrl, URL_LINE_RE } = require('../src/runtime-supervisor');
  // the LAN suffix is a separate whitespace-delimited token — never swallowed
  const line = 'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://192.168.1.5:3080/?token=abc123)';
  const m = line.match(URL_LINE_RE);
  assert.ok(m, 'URL line matches');
  const parsed = parseRuntimeUrl(m[1]);
  assert.strictEqual(parsed.origin, 'http://127.0.0.1:3080');
  assert.strictEqual(parsed.authUrl, 'http://127.0.0.1:3080/?token=abc123');
});

test('parseRuntimeUrl accepts a token-less (pre-0.1.2) line unchanged', () => {
  const { parseRuntimeUrl } = require('../src/runtime-supervisor');
  const legacy = parseRuntimeUrl('http://127.0.0.1:3081');
  assert.strictEqual(legacy.origin, 'http://127.0.0.1:3081');
  assert.strictEqual(legacy.authUrl, 'http://127.0.0.1:3081/');
});

test('parseRuntimeUrl rejects non-loopback or non-http URLs', () => {
  const { parseRuntimeUrl } = require('../src/runtime-supervisor');
  for (const bad of ['http://0.0.0.0:3080', 'http://example.com:3080/?token=x', 'ftp://127.0.0.1:3080', 'not-a-url', '', null]) {
    assert.strictEqual(parseRuntimeUrl(bad), null, `${bad} must be rejected`);
  }
  // trailing punctuation from a wrapped log line is tolerated
  assert.strictEqual(parseRuntimeUrl('http://127.0.0.1:3080/?token=x).').origin, 'http://127.0.0.1:3080');
});
