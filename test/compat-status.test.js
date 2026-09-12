// test/compat-status.test.js — R2 upstream compatibility: app-side reader
// (live fetch / cache fallback / feature switch) and the report generator
// (ledger merge, latest-verified selection, badge + markdown rendering).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createCompatStatus } = require('../src/compat-status');
const report = require('../scripts/upstream-compat-report');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Standard payload mirroring docs/compat/compat-status.json. */
function payload(latestVerified = '0.1.0-rc.9') {
  return {
    schema: 1,
    updatedAt: '2026-08-23T00:00:00.000Z',
    latestVerified,
    runs: [{ version: latestVerified, date: '2026-08-23', ok: true, platforms: { 'win32-x64': 'pass' } }],
  };
}

function fixture({ data, enabled = true, now = () => 1_000_000 } = {}) {
  const userDataDir = tmpDir('dsh-compat-userdata-');
  let fetches = 0;
  const state = { failFetch: false };
  const cs = createCompatStatus({
    getSettings: () => ({ compatStatusEnabled: enabled }),
    getRuntimeVersion: () => '0.1.0-rc.9',
    userDataDir,
    statusUrl: 'https://example.invalid/compat-status.json',
    fetchImpl: async () => {
      fetches += 1;
      if (state.failFetch) throw new Error('ENETDOWN');
      return { ok: true, status: 200, json: async () => (typeof data === 'function' ? data() : data || payload()) };
    },
    now,
    log: () => {},
  });
  return { cs, userDataDir, fetches: () => fetches, state };
}

test('live fetch succeeds, marks source=live and writes the cache file', async () => {
  const f = fixture();
  const s = await f.cs.getStatus(true);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.source, 'live');
  assert.strictEqual(s.latestVerified, '0.1.0-rc.9');
  assert.strictEqual(s.compatible, true, 'active runtime equals latest verified version');
  assert.strictEqual(s.updatedAt, '2026-08-23T00:00:00.000Z');
  const cached = JSON.parse(fs.readFileSync(path.join(f.userDataDir, 'compat-cache.json'), 'utf8'));
  assert.strictEqual(cached.data.latestVerified, '0.1.0-rc.9');
});

test('fresh cache short-circuits the network; only force=true refetches', async () => {
  const f = fixture({ now: (() => { let t = 0; return () => { t += 1000; return t; }; })() });
  await f.cs.getStatus(); // populates cache
  assert.strictEqual(f.fetches(), 1);
  const s = await f.cs.getStatus(); // fresh within TTL → cache
  assert.strictEqual(s.source, 'cache');
  assert.strictEqual(f.fetches(), 1);
  await f.cs.getStatus(true); // forced → live again
  assert.strictEqual(f.fetches(), 2);
  assert.strictEqual((await f.cs.getStatus()).source, 'cache');
  assert.strictEqual(f.fetches(), 2);
});

test('stale cache + failed fetch degrades to the cached verdict (never blank)', async () => {
  const f = fixture({ now: (() => { let t = 0; return () => { t += 10 * 60 * 60 * 1000; return t; }; })() });
  await f.cs.getStatus(); // populate at t=10h
  f.state.failFetch = true;
  const s = await f.cs.getStatus(); // 10h later, cache is stale, network down
  assert.strictEqual(s.source, 'cache');
  assert.strictEqual(s.compatible, true);
});

test('no cache + failed fetch returns ok:false with a reason (and never throws)', async () => {
  const f = fixture();
  f.state.failFetch = true;
  const s = await f.cs.getStatus(true);
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /ENETDOWN/);
  assert.strictEqual(s.compatible, false);
});

test('the C-6 feature switch disables fetching entirely', async () => {
  const f = fixture({ enabled: false });
  const s = await f.cs.getStatus(true);
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(f.fetches(), 0);
  assert.strictEqual(fs.existsSync(path.join(f.userDataDir, 'compat-cache.json')), false);
});

test('evaluate(): exact version match required (prefix/suffix versions are not compatible)', async () => {
  const cs = createCompatStatus({
    getSettings: () => ({}),
    getRuntimeVersion: () => '',
    userDataDir: tmpDir('dsh-compat-x-'),
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.deepStrictEqual(cs.evaluate('0.1.0-rc.9', payload('0.1.0-rc.9')).compatible, true);
  assert.strictEqual(cs.evaluate('0.1.0-rc.8', payload('0.1.0-rc.9')).compatible, false);
  assert.strictEqual(cs.evaluate('', payload('0.1.0-rc.9')).compatible, false);
  assert.strictEqual(cs.evaluate('0.1.0-rc.9', null).compatible, false);
});

// ------------------------------------------------- report generator helpers

test('mergeRuns(): dedupes version+date, newest first, capped at 30 entries', () => {
  const existing = [{ version: '0.1.0-rc.7', date: '2026-08-20', ok: true }];
  const run = { version: '0.1.0-rc.9', date: '2026-08-23', ok: true };
  let runs = report.mergeRuns(existing, run);
  assert.deepStrictEqual(runs.map((r) => r.version), ['0.1.0-rc.9', '0.1.0-rc.7']);
  // same run twice → single entry
  runs = report.mergeRuns(runs, run);
  assert.strictEqual(runs.length, 2);
  // cap
  let many = [];
  for (let i = 0; i < 40; i += 1) many = report.mergeRuns(many, { version: `0.1.0-rc.${i}`, date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, ok: true });
  assert.ok(many.length <= 30, `cap respected (got ${many.length})`);
});

test('pickLatestVerified(): highest semver among fully-passing runs only', () => {
  const runs = [
    { version: '0.1.0-rc.10', date: '2026-08-25', ok: false, platforms: { win: 'fail' } },
    { version: '0.1.0-rc.9', date: '2026-08-24', ok: true, platforms: { win: 'pass', mac: 'pass' } },
    { version: '0.1.0-rc.8', date: '2026-08-23', ok: true, platforms: { win: 'pass', mac: 'pass' } },
    { version: '0.2.0', date: '2026-08-22', ok: true, platforms: {} }, // no platforms → not verifiable
  ];
  assert.strictEqual(report.pickLatestVerified(runs), '0.1.0-rc.9');
  assert.strictEqual(report.pickLatestVerified([]), null);
  assert.strictEqual(report.pickLatestVerified([{ version: '0.1.0-rc.10', ok: true, platforms: { win: 'pass' } }]), '0.1.0-rc.10');
});

test('badge flips green ✅ verified ↔ red ❌ failed with compact rc labels', () => {
  const good = report.renderBadge({ ok: true, version: '0.1.0-rc.9' });
  assert.deepStrictEqual(good, { schemaVersion: 1, label: 'upstream', message: '✅ rc.9 verified', color: 'brightgreen' });
  const bad = report.renderBadge({ ok: false, version: '0.1.0-rc.10' });
  assert.strictEqual(bad.color, 'red');
  assert.match(bad.message, /❌ rc\.10 failed/);
});

test('markdown report annotates failing gates with their reasons automatically', () => {
  const failedRun = {
    schema: 1, version: '0.1.0-rc.10', date: '2026-08-24', ok: false, trigger: 'schedule',
    platforms: { 'win32-x64': 'fail', 'darwin-arm64': 'pass' },
    detail: {
      'win32-x64': {
        install: { ok: true, ms: 1, reason: '' },
        dumpConfig: { ok: false, ms: 2, reason: '--dump-config exited 1: unknown option --dump-config' },
        healthCheck: { ok: false, ms: 3, reason: 'URL line never appeared (boot timed out)' },
      },
      'darwin-arm64': {
        install: { ok: true, ms: 1, reason: '' },
        dumpConfig: { ok: true, ms: 1, reason: '' },
        healthCheck: { ok: true, ms: 1, reason: '' },
      },
    },
  };
  const md = report.renderMarkdown(failedRun);
  assert.match(md, /❌ 0\.1\.0-rc\.10 冒烟未通过/);
  assert.match(md, /## 失败摘要/);
  assert.match(md, /win32-x64\/dumpConfig.*unknown option/s);
  assert.match(md, /win32-x64\/healthCheck.*boot timed out/s);
  assert.doesNotMatch(md, /darwin-arm64\/install.*：[^\n]*failed/);
  // passing run renders the green conclusion without a failure section
  const okRun = { ...failedRun, ok: true, platforms: { 'darwin-arm64': 'pass' }, detail: { 'darwin-arm64': failedRun.detail['darwin-arm64'] } };
  const mdOk = report.renderMarkdown(okRun);
  assert.match(mdOk, /✅ 0\.1\.0-rc\.10 验证通过/);
  assert.ok(!mdOk.includes('失败摘要'));
});

test('end-to-end: the CLI aggregates smoke artifacts into status/badge/markdown/discussion files', () => {
  const work = tmpDir('dsh-compat-e2e-');
  const artDir = path.join(work, 'artifacts');
  const outDir = path.join(work, 'docs', 'compat');
  fs.mkdirSync(artDir, { recursive: true });
  const mkArtifact = (platform, ok) => JSON.stringify({
    schema: 1, package: '@deepseek-ai/dsh', version: '0.1.0-rc.11', platform, ok,
    startedAt: '2026-08-23T00:00:00Z', finishedAt: '2026-08-23T00:05:00Z',
    gates: {
      install: { ok, ms: 1, reason: ok ? '' : 'prepare-runtime exited 1' },
      dumpConfig: { ok, ms: 1, reason: ok ? '' : '--dump-config exited 1' },
      healthCheck: { ok: true, ms: 1, reason: '' },
    },
    reason: ok ? '' : `${platform}: --dump-config exited 1`,
  }, null, 2);
  fs.writeFileSync(path.join(artDir, 'result-windows-latest.json'), mkArtifact('win32-x64', true));
  fs.writeFileSync(path.join(artDir, 'result-macos-latest.json'), mkArtifact('darwin-arm64', true));
  fs.writeFileSync(path.join(artDir, 'garbage.json'), '{ not json');

  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'upstream-compat-report.js'),
    '--in', artDir, '--out', outDir,
  ], { encoding: 'utf8' });

  const status = JSON.parse(fs.readFileSync(path.join(outDir, 'compat-status.json'), 'utf8'));
  assert.strictEqual(status.latestVerified, '0.1.0-rc.11');
  assert.strictEqual(status.runs[0].ok, true);
  assert.deepStrictEqual(status.runs[0].platforms, { 'win32-x64': 'pass', 'darwin-arm64': 'pass' });

  const badge = JSON.parse(fs.readFileSync(path.join(outDir, 'badge.json'), 'utf8'));
  assert.strictEqual(badge.message, '✅ rc.11 verified');

  const mdFiles = fs.readdirSync(outDir).filter((n) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(n));
  assert.strictEqual(mdFiles.length, 1, `dated markdown report written (${mdFiles.join(',')})`);
  const discussion = fs.readFileSync(path.join(outDir, 'discussion-body.md'), 'utf8');
  assert.match(discussion, /✅ DshCockpit 已验证 @deepseek-ai\/dsh \*\*0\.1\.0-rc\.11\*\*/);

  // a failing rerun on the same day updates the ledger and flips the badge red
  fs.writeFileSync(path.join(artDir, 'result-windows-latest.json'), mkArtifact('win32-x64', false));
  fs.writeFileSync(path.join(artDir, 'result-macos-latest.json'), mkArtifact('darwin-arm64', true));
  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'upstream-compat-report.js'),
    '--in', artDir, '--out', outDir,
  ], { encoding: 'utf8' });
  const after = JSON.parse(fs.readFileSync(path.join(outDir, 'compat-status.json'), 'utf8'));
  assert.strictEqual(after.runs.length, 1, 'same-day rerun replaces the run entry instead of duplicating it');
  assert.strictEqual(after.runs[0].ok, false);
  assert.match(after.runs[0].reason, /--dump-config exited 1/, 'failure summary carried into the ledger');
  assert.strictEqual(after.latestVerified, null, 'no fully-passing run remains → nothing verified');
  const badBadge = JSON.parse(fs.readFileSync(path.join(outDir, 'badge.json'), 'utf8'));
  assert.strictEqual(badBadge.color, 'red');
});
