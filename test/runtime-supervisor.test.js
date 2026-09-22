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

// ---- consecutive startup failure accounting (2026-09-23 容器加固, A2) --------
// A fake "dsh" bin is a real node script the test controls: it can print the
// `dsh web:` URL line and serve a health endpoint, print the URL and stay
// silent (health probe fails), or die immediately (never healthy).

function harness() {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const { createRuntimeSupervisor } = require('../src/runtime-supervisor');
  const { createRuntimeStateController } = require('../src/runtime-state');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sup-')));
  const bin = path.join(dir, 'fake-dsh.js');
  fs.writeFileSync(bin, [
    "const http = require('node:http');",
    "const args = process.argv.slice(2);",
    "const port = Number(args[args.indexOf('--port') + 1]);",
    "const mode = process.env.FAKE_RUNTIME_MODE || 'ok';",
    "const announce = (p) => console.log('dsh web: http://127.0.0.1:' + p + '/?token=fake');",
    "if (mode === 'crash') process.exit(1);",
    "if (mode === 'silent') { announce(port); setTimeout(() => {}, 120000); return; }",
    // --port 0 means OS-assigned: announce the REAL listening port, like the
    // real harness does (supervisor parses the printed line, not the CLI flag)
    "http.createServer((req, res) => { res.writeHead(302, { location: '/' }); res.end(); })",
    "  .listen(port, '127.0.0.1', function () { announce(this.address().port); });",
  ].join('\n'));

  const failures = [];
  const healthy = [];
  const stateController = createRuntimeStateController({ initial: 'starting' });
  let quitting = false;
  const supervisor = createRuntimeSupervisor({
    app: { quit: () => {} },
    dialog: { showErrorBox: () => {}, showMessageBox: async () => ({ response: 1 }) },
    log: () => {},
    t: (_l, k) => k,
    lang: () => 'zh',
    appName: 'test',
    stateController,
    resolveDshBin: () => bin,
    describeDshBin: () => ({ version: '9.9.9' }),
    nodeCandidates: () => [{ bin: process.execPath, runAsNode: false }],
    effectiveSettings: () => ({ port: 0, dshHome: dir, workspace: dir }),
    selfHealProfile: () => {},
    ensureLogDir: () => dir,
    resolveNodeBin: () => ({ bin: process.execPath, runAsNode: false }),
    onRemoteUrl: () => {},
    startEventsFeed: () => {},
    stopEventsFeed: () => {},
    resetEventsFeedLiveFlag: () => {},
    onHealthy: () => healthy.push(Date.now()),
    hasMainWindow: () => true,
    isQuitting: () => quitting,
    recordCrash: () => {},
    enterSafeMode: () => {},
    upgradeDialog: () => {},
    isCredentialFormatIssue: () => false,
    bootTimingFile: () => path.join(dir, 'boot-timing.json'),
    notify: () => {},
    envExtras: () => null,
    healthTimeoutMs: 400,
    onStartupFailure: (reason) => { failures.push(reason); return { rollbackScheduled: true }; },
  });
  return {
    supervisor, dir, failures, healthy,
    stop: () => { quitting = true; try { supervisor.killRuntime(); } catch { /* ignore */ } },
  };
}

function waitFor(cond, what, timeoutMs = 5_000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for: ${what}`));
      setTimeout(poll, 50);
    })();
  });
}

test('a runtime that never becomes healthy is recorded as a startup failure; the auto-restart is skipped when a rollback is scheduled', async () => {
  const h = harness();
  process.env.FAKE_RUNTIME_MODE = 'crash';
  h.supervisor.spawnRuntime();
  await waitFor(() => h.failures.length > 0, 'startup failure recorded');
  assert.match(h.failures[0], /exited before healthy/);
  // the handler reported rollbackScheduled → the supervisor must NOT also
  // schedule its own auto-restart (one recovery path, never two)
  await new Promise((r) => setTimeout(r, 2_500));
  assert.strictEqual(h.failures.length, 1, 'no second spawn happened (no auto-restart)');
  h.stop();
  delete process.env.FAKE_RUNTIME_MODE;
});

test('a runtime that becomes healthy records no startup failure', async () => {
  const h = harness();
  process.env.FAKE_RUNTIME_MODE = 'ok';
  h.supervisor.spawnRuntime();
  await waitFor(() => h.healthy.length > 0, 'healthy boot');
  assert.deepStrictEqual(h.failures, []);
  assert.strictEqual(h.supervisor.getRuntimeUrl().startsWith('http://127.0.0.1:'), true);
  h.stop();
  delete process.env.FAKE_RUNTIME_MODE;
});

test('a failing health probe is recorded as a startup failure too', async () => {
  const h = harness();
  process.env.FAKE_RUNTIME_MODE = 'silent';
  h.supervisor.spawnRuntime();
  await waitFor(() => h.failures.length > 0, 'health-probe failure recorded');
  assert.match(h.failures[0], /health probe failed/);
  h.stop();
  delete process.env.FAKE_RUNTIME_MODE;
});
