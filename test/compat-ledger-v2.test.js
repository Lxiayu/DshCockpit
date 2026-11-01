// test/compat-ledger-v2.test.js — Issue #21：兼容性账本 schema 2 的契约与防复发门禁。
//
// 背景：账本曾停在 0.1.5 三个月，而 CI 天天验证 0.2.1 全绿。设置页却显示
// "已是最新已验证版本"——因为读取端只做 `current === latestVerified`，
// 而陈旧账本恰好满足这个等式。信息链断裂了，没有任何机制发现。
//
// 本套件锁死三件事：
//   1. 四级结论（Installed/Healthy/Compatible/Supported）不可越级推导
//   2. Verified（事实，不随时间变）/ Fresh（会衰减）/ Compatible（两者皆满足）
//   3. 账本自洽性检查必须能抓住"把没验证的写成验证通过"
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/compat-policy.js');
const report = require('../scripts/upstream-compat-report');
const ledgerCheck = require('../scripts/check-compat-ledger.js');
const { createCompatStatus } = require('../src/compat-status');

const DAY = 86400000;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A CI-shaped platform entry: install + healthCheck pass, protocol never exercised. */
function ciPlatform(platform = 'darwin-arm64') {
  const entry = {
    platform,
    install: { result: 'pass', ms: 100, reason: '' },
    healthCheck: { result: 'pass', ms: 200, reason: '' },
    // CI does NOT exercise these; they must stay unknown/not-run
    protocol: { result: 'unknown', reason: 'CI does not exercise mux/RPC' },
    endToEnd: { result: 'not-run', reason: '' },
    teamIntegration: { result: 'not-run', reason: '' },
  };
  entry.verdict = policy.verdictFor(entry);
  return entry;
}

// --------------------------------------------------------------- verdictFor

test('verdictFor: a CI run proves healthy, never compatible', () => {
  assert.strictEqual(policy.verdictFor(ciPlatform()), 'healthy');
});

test('verdictFor: explicit gate failure wins over everything (negative signal first)', () => {
  const p = ciPlatform();
  p.healthCheck = { result: 'fail', reason: 'boot timeout' };
  assert.strictEqual(policy.verdictFor(p), 'failed');
});

test('verdictFor: install-only stops at installed', () => {
  const p = ciPlatform();
  p.healthCheck = { result: 'not-run' };
  assert.strictEqual(policy.verdictFor(p), 'installed');
});

test('verdictFor: compatible requires the protocol gate to actually pass', () => {
  const p = ciPlatform();
  p.protocol = { result: 'pass' };
  assert.strictEqual(policy.verdictFor(p), 'compatible');
});

test('verdictFor: unknown / not-run are NEVER treated as pass', () => {
  // Build an entry where every gate is unknown/not-run
  const p = {
    platform: 'x',
    install: { result: 'unknown' },
    healthCheck: { result: 'unknown' },
    protocol: { result: 'unknown' },
    endToEnd: { result: 'not-run' },
    teamIntegration: { result: 'not-run' },
  };
  const v = policy.verdictFor(p);
  assert.ok(!policy.atLeast(v, 'installed'), `unknown gates must not reach installed (got ${v})`);
});

test('atLeast: level ordering is monotonic', () => {
  assert.strictEqual(policy.atLeast('compatible', 'healthy'), true);
  assert.strictEqual(policy.atLeast('healthy', 'compatible'), false);
  assert.strictEqual(policy.atLeast('failed', 'installed'), false);
  assert.strictEqual(policy.atLeast('supported', 'supported'), true);
});

// ------------------------------------------------------- freshness / channel

test('staleThresholdDays: prerelease 7 days, stable 30 days', () => {
  assert.strictEqual(policy.staleThresholdDays('0.2.1-rc.5'), 7);
  assert.strictEqual(policy.staleThresholdDays('0.2.2-alpha.2'), 7);
  assert.strictEqual(policy.staleThresholdDays('0.2.0'), 30);
  // ledger policy can override
  const custom = { freshness: { prerelease: { staleAfterDays: 3 }, stable: { staleAfterDays: 60 } } };
  assert.strictEqual(policy.staleThresholdDays('0.2.1-rc.5', custom), 3);
  assert.strictEqual(policy.staleThresholdDays('0.2.0', custom), 60);
});

test('evaluateFreshness: unknown timestamp is treated as unknown, not as epoch-zero', () => {
  const fr = policy.evaluateFreshness({ version: '1.0.0-rc.1', verifiedAt: '', nowMs: 0 });
  assert.strictEqual(fr.fresh, false);
  assert.strictEqual(fr.ageDays, Infinity);
});

test('evaluateLedger: a stale ledger keeps `verified` true but `compatible` false', () => {
  const ledger = { schema: 1, updatedAt: '2026-08-23T00:00:00.000Z', latestVerified: '0.1.0-rc.9' };
  const now = Date.parse('2026-11-01T00:00:00.000Z'); // ~70 days later
  const ev = policy.evaluateLedger({ currentVersion: '0.1.0-rc.9', ledger, nowMs: now });

  assert.strictEqual(ev.verified, true, 'historical verification is a FACT and must survive staleness');
  assert.strictEqual(ev.fresh, false);
  assert.strictEqual(ev.stale, true);
  assert.strictEqual(ev.compatible, false, 'a stale conclusion must not be advertised as "on latest verified"');
  assert.strictEqual(ev.verifiedButStale, true);
  assert.strictEqual(ev.staleThresholdDays, 7);
});

test('evaluateLedger: MUTATION GUARD — verified must not depend on freshness', () => {
  // If someone "simplifies" verified into `versionMatches && !stale`, this fails.
  const ledger = { schema: 1, updatedAt: '2020-01-01T00:00:00.000Z', latestVerified: '0.1.0-rc.9' };
  const ev = policy.evaluateLedger({ currentVersion: '0.1.0-rc.9', ledger, nowMs: Date.now() });
  assert.strictEqual(ev.fresh, false, 'sanity: the ledger really is ancient');
  assert.strictEqual(ev.verified, true, 'verified is about history, not recency');
});

test('evaluateLedger: version mismatch is neither compatible nor verifiedButStale', () => {
  const ledger = { schema: 2, updatedAt: new Date().toISOString(), latestVerified: '0.2.1-rc.5' };
  const ev = policy.evaluateLedger({ currentVersion: '0.1.5-rc.2', ledger, nowMs: Date.now() });
  assert.strictEqual(ev.compatible, false);
  assert.strictEqual(ev.verifiedButStale, false);
  assert.match(ev.reason, /differs/);
});

// ------------------------------------------------------------ ledger builder

test('buildEntry: records channel and version as separate dimensions', () => {
  const results = [{
    schema: 2, version: '0.2.1-rc.5', platform: 'darwin-arm64',
    resolveTag: 'next', resolvedVia: 'dist-tag:next',
    startedAt: '2026-10-31T09:05:09Z', finishedAt: '2026-10-31T09:06:13Z',
    gates: { install: { ok: true, ms: 1 }, dumpConfig: { ok: true, ms: 1 }, healthCheck: { ok: true, ms: 1 } },
  }];
  const entry = report.buildEntry({ results, trigger: 'schedule', nowIso: '2026-10-31T00:00:00.000Z' });
  assert.strictEqual(entry.runtimeVersion, '0.2.1-rc.5');
  assert.strictEqual(entry.releaseChannel, 'next', 'channel is "next", NOT the version string');
  assert.strictEqual(entry.resolvedVia, 'dist-tag:next');
  assert.strictEqual(entry.platforms[0].verdict, 'healthy');
  assert.strictEqual(entry.platforms[0].protocol.result, 'unknown', 'protocol must stay unknown when CI cannot exercise it');
  assert.ok(Array.isArray(entry.unverified) && entry.unverified.length > 0, 'unverified list must be explicit');
});

test('migrateRunsToEntries: legacy runs can only ever reach healthy', () => {
  const entries = report.migrateRunsToEntries([{
    schema: 1, version: '0.1.5-rc.2', date: '2026-09-16', ok: true,
    platforms: { 'darwin-arm64': 'pass' },
    detail: { 'darwin-arm64': { install: { ok: true, ms: 1 }, dumpConfig: { ok: true, ms: 1 }, healthCheck: { ok: true, ms: 1 } } },
  }]);
  assert.strictEqual(entries.length, 1);
  const p = entries[0].platforms[0];
  assert.strictEqual(p.verdict, 'healthy', 'legacy data proves install+health only');
  assert.strictEqual(p.protocol.result, 'unknown', 'legacy never verified the protocol');
  assert.notStrictEqual(p.verdict, 'compatible');
});

// ------------------------------------------------------------- ledger checker

function writeLedgerDir({ ledger, badge }) {
  const dir = tmpDir('dsh-ledger-check-');
  fs.writeFileSync(path.join(dir, 'compat-status.json'), JSON.stringify(ledger, null, 2));
  if (badge !== undefined) fs.writeFileSync(path.join(dir, 'badge.json'), JSON.stringify(badge, null, 2));
  return dir;
}

function goodLedger(overrides = {}) {
  const platform = ciPlatform();
  const entry = {
    releaseChannel: 'next',
    runtimeVersion: '0.2.1-rc.5',
    resolvedVia: 'dist-tag:next',
    resolvedAt: '2026-10-31T09:05:09Z',
    platforms: [platform],
    verifiedCommit: 'ec7e5bc',
    verifiedAt: new Date().toISOString(),
    verifiedBy: 'ci:upstream-compat',
    runId: '41187195013',
    unverified: ['mux protocol'],
    ok: true,
  };
  return {
    schema: 2,
    updatedAt: new Date().toISOString(),
    latestVerified: '0.2.1-rc.5',
    runs: [],
    policy: {
      freshness: { prerelease: { staleAfterDays: 7 }, stable: { staleAfterDays: 30 } },
      revalidateOn: policy.DEFAULT_POLICY.revalidateOn.slice(),
    },
    recommended: {
      version: '0.2.1-rc.5',
      channel: 'next',
      supportedLevel: 'healthy',
      since: new Date().toISOString().slice(0, 10),
    },
    entries: [entry],
    ...overrides,
  };
}

function goodBadge() {
  return { schemaVersion: 2, label: 'upstream', message: '✅ rc.5 (healthy)', color: 'brightgreen' };
}

test('check: a well-formed schema 2 ledger passes', () => {
  const dir = writeLedgerDir({ ledger: goodLedger(), badge: goodBadge() });
  const r = ledgerCheck.check({ dir });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

test('check: CATCHES a verdict that claims compatible without protocol evidence', () => {
  const ledger = goodLedger();
  ledger.entries[0].platforms[0].verdict = 'compatible'; // lie: protocol is still unknown
  const dir = writeLedgerDir({ ledger, badge: goodBadge() });
  const r = ledgerCheck.check({ dir });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /protocol gate/.test(e) || /不自洽/.test(e)),
    `expected a protocol/self-consistency error, got: ${JSON.stringify(r.errors)}`);
});

test('check: CATCHES latestVerified / recommended divergence (the original incident)', () => {
  const ledger = goodLedger({ latestVerified: '0.1.5-rc.2' }); // stale pointer
  const dir = writeLedgerDir({ ledger, badge: goodBadge() });
  const r = ledgerCheck.check({ dir });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /latestVerified/.test(e)), `got: ${JSON.stringify(r.errors)}`);
});

test('check: CATCHES a badge that no longer matches the ledger', () => {
  const dir = writeLedgerDir({ ledger: goodLedger(), badge: goodBadge() });
  fs.writeFileSync(path.join(dir, 'badge.json'), JSON.stringify(
    { schemaVersion: 2, label: 'upstream', message: '✅ rc.9 verified', color: 'brightgreen' }, null, 2));
  const r = ledgerCheck.check({ dir });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /badge/.test(e)), `got: ${JSON.stringify(r.errors)}`);
});

test('check: WARNs (not fails) on a stale ledger by default; --strict-fresh makes it fail', () => {
  const ledger = goodLedger({ updatedAt: '2020-01-01T00:00:00.000Z' });
  const dir = writeLedgerDir({ ledger, badge: goodBadge() });
  const soft = ledgerCheck.check({ dir });
  assert.strictEqual(soft.ok, true, 'staleness alone is a freshness problem, not a malformed ledger');
  assert.ok(soft.warnings.some((w) => /未更新/.test(w)));

  const strict = ledgerCheck.check({ dir, strictFresh: true });
  assert.strictEqual(strict.ok, false);
});

test('check: policy requires prerelease threshold < stable threshold', () => {
  const ledger = goodLedger();
  ledger.policy = { freshness: { prerelease: { staleAfterDays: 40 }, stable: { staleAfterDays: 30 } } };
  const dir = writeLedgerDir({ ledger, badge: goodBadge() });
  const r = ledgerCheck.check({ dir });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /prerelease/.test(e)));
});

test('check: an unreachable/absent directory fails loudly instead of passing silently', () => {
  const r = ledgerCheck.check({ dir: path.join(os.tmpdir(), 'dsh-does-not-exist-' + Date.now()) });
  assert.strictEqual(r.ok, false);
});

// ------------------------------------------------------ reader end-to-end

test('reader: getStatus surfaces verifiedButStale for a stale ledger (no false "all good")', async () => {
  const userDataDir = tmpDir('dsh-compat-reader-');
  const stale = {
    schema: 2,
    updatedAt: '2026-08-23T00:00:00.000Z',
    latestVerified: '0.1.0-rc.9',
    recommended: { version: '0.1.0-rc.9', channel: 'next', supportedLevel: 'healthy' },
    entries: [],
    runs: [],
  };
  const cs = createCompatStatus({
    getSettings: () => ({ compatStatusEnabled: true }),
    getRuntimeVersion: () => '0.1.0-rc.9',
    userDataDir,
    statusUrl: 'https://example.invalid/x.json',
    fetchImpl: async () => ({ ok: true, json: async () => stale }),
    now: () => Date.parse('2026-11-01T00:00:00.000Z'),
    log: () => {},
  });
  const s = await cs.getStatus(true);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.compatible, false, 'stale ledger must not report compatibility');
  assert.strictEqual(s.verified, true, 'but the historical verification is still reported as fact');
  assert.strictEqual(s.verifiedButStale, true);
  assert.strictEqual(s.ledgerStale, true, 'ledger-level staleness is surfaced separately');
});

test('reader: fresh ledger with matching version still reports compatible', async () => {
  const userDataDir = tmpDir('dsh-compat-reader2-');
  const nowIso = new Date().toISOString();
  const fresh = {
    schema: 2, updatedAt: nowIso, latestVerified: '0.2.1-rc.5',
    recommended: { version: '0.2.1-rc.5', channel: 'next', supportedLevel: 'healthy' },
    entries: [], runs: [],
  };
  const cs = createCompatStatus({
    getSettings: () => ({ compatStatusEnabled: true }),
    getRuntimeVersion: () => '0.2.1-rc.5',
    userDataDir,
    statusUrl: 'https://example.invalid/x.json',
    fetchImpl: async () => ({ ok: true, json: async () => fresh }),
    log: () => {},
  });
  const s = await cs.getStatus(true);
  assert.strictEqual(s.compatible, true);
  assert.strictEqual(s.verifiedButStale, false);
  assert.strictEqual(s.ledgerStale, false);
});
