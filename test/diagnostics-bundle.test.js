// test/diagnostics-bundle.test.js — P2 运维能力：一键导出诊断包的收集/脱敏契约。
//
// 验证三件事：
//   1) 白名单内容：包内只出现枚举过的文件，字段不含会话 id / 员工 id /
//      显示名 / 路径 / prompt 正文（结构上不采集 + 投影断言）；
//   2) 脱敏：launch-token URL、dsh-auth-* cookie、各类 key、Bearer/JWT/
//      私钥块、家目录路径在日志行与崩溃记录里都被抹掉；
//   3) fail-closed 终扫：写入后全文扫描，任何残留密钥形状使整个导出失败
//      并删除包目录（宁可不导出，绝不留下带密钥的包）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDiagnosticsBundle,
  redactLogLine,
  scanTextForSecrets,
  BUNDLE_PREFIX,
} = require('../src/diagnostics-bundle.js');

const HOME = os.homedir();

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeDeps(overrides = {}) {
  return {
    appVersion: () => '0.4.0-test',
    runtimeVersion: () => '0.1.1-rc.2',
    runtimeState: () => 'running',
    logDir: () => overrides.logDir || null,
    crashDir: () => overrides.crashDir || null,
    officeDiagnostics: () => overrides.officeDiagnostics || null,
    officeEmployees: () => overrides.officeEmployees || [],
    locale: () => 'zh-CN',
    home: () => HOME,
    now: () => new Date('2026-09-26T08:00:00.000Z'),
    log: () => {},
    ...overrides.deps,
  };
}

// --- line redactor -------------------------------------------------------------

test('redactLogLine: launch-token URLs lose the token but keep the shape', () => {
  const line = '2026-09-26T08:00:00Z [shell] runtime URL: http://127.0.0.1:54870/?token=super-secret-launch-token-abc123 (authenticated)';
  const out = redactLogLine(line, HOME);
  assert.ok(out.includes('http://127.0.0.1:54870/?token=[REDACTED]'), `token redacted in place: ${out}`);
  assert.ok(!out.includes('super-secret-launch-token'), 'raw token is gone');
});

test('redactLogLine: dsh-auth cookies, api keys, Bearer, JWT and PEM blocks are redacted', () => {
  const cookie = redactLogLine('sent header: dsh-auth-x9=signature-value-1; Path=/', HOME);
  assert.ok(cookie.includes('dsh-auth-x9=[REDACTED]'), cookie);
  assert.ok(!cookie.includes('signature-value'), cookie);
  const key = redactLogLine('config apikey=sk-abcdefgh123456 loaded', HOME);
  assert.ok(key.includes('apikey=[REDACTED]'), key);
  assert.ok(!key.includes('sk-abcdefgh'), key);
  const bearer = redactLogLine('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhYmMiIn0.sig-part', HOME);
  assert.ok(!bearer.includes('eyJhbGciOiJIUzI1NiI'), bearer);
  const pem = redactLogLine('-----BEGIN PRIVATE KEY-----MIIEvQIBADAN', HOME);
  assert.ok(!pem.includes('MIIEvQ'), pem);
});

test('redactLogLine: home directory paths collapse to ~ (no username leak)', () => {
  const out = redactLogLine(`[shell] dsh home ${HOME}/.dsh sessions ok`, HOME);
  assert.ok(!out.includes(HOME), `home path gone: ${out}`);
  assert.ok(out.includes('~/.dsh'), out);
  const generic = redactLogLine('reading /Users/alice/secret.txt', HOME);
  assert.ok(!generic.includes('/Users/alice'), generic);
});

test('redactLogLine: a line whose secret survives the rewrite pass is dropped entirely (fail-closed)', () => {
  // a JWT glued to a preceding word char dodges the rewrite pass (its \b can
  // never fire mid-word) — the residual shape check must drop the whole line.
  const hostile = 'leak xeyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload end';
  const out = redactLogLine(hostile, HOME);
  assert.equal(out, '[REDACTED]:line');
});

// --- final scan -----------------------------------------------------------------

test('scanTextForSecrets: finds residual secrets and ignores [REDACTED] markers', () => {
  const clean = 'runtime URL: http://127.0.0.1:54870/?token=[REDACTED]\ncookie dsh-auth-x9=[REDACTED] ok\n';
  assert.deepEqual(scanTextForSecrets(clean), []);
  const dirty = 'still leaking ?token=abcdef123456 here\n';
  const findings = scanTextForSecrets(dirty);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'token-url');
  assert.equal(findings[0].line, 1);
});

// --- bundle build ---------------------------------------------------------------

test('build: whitelist contents, manifest with hashes, README privacy manifest', async () => {
  const target = tmpDir('dsh-diag-test-');
  const logDir = tmpDir('dsh-diag-logs-');
  fs.writeFileSync(path.join(logDir, 'runtime-2026-09-26T01-00-00-000Z.log'),
    `${HOME}/.dsh log line with ?token=abc123def456\nplain line\n`);
  fs.writeFileSync(path.join(logDir, 'runtime-2026-09-26T02-00-00-000Z.log'), 'newer plain line\n');
  // raw runtime .out output must NEVER be collected, even sitting next to logs
  fs.writeFileSync(path.join(logDir, 'runtime-2026-09-26T02-00-00-000Z.out'), 'token=leaked-raw-stdout\n');
  const crashDir = tmpDir('dsh-diag-crash-');
  fs.writeFileSync(path.join(crashDir, 'crash-42.json'), JSON.stringify({
    ts: '2026-09-26T07:00:00.000Z', code: 1, signal: null,
    activeVersion: '0.1.1-rc.2', logPath: `${HOME}/Library/Logs/x.log`,
    logTail: 'tail line ?token=zzz-secret-999\n',
  }));

  const officeDiagnostics = {
    schemaVersion: 1,
    simulatedAtMs: 123456,
    sync: 'healthy',
    paused: false,
    employeeCount: 5,
    activityLogSize: 40,
    packPresent: true,
    adapterCount: 5,
    seed: 'office-shell',
    renderer: { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1, fps: 59.8, renderProfile: 'full' },
    clock: { running: true, ticks: 100, simulatedPerWall: 0.98, eventLoop: { delayP99Ms: 3.2 } },
    diagnostics: [{ atMs: 100, code: 'PACK_MISSING_RESOURCE', count: 2 }],
    activityLog: [{ kind: 'SHOULD-NOT-APPEAR' }],
    usage: { SHOULD: 'NOT-APPEAR' },
  };
  const officeEmployees = [
    { role: '工程师', activity: 'working', movement: 'stationary', bound: true, bindingSource: 'root', queueCount: 1, employeeId: 'e3', displayName: '不应出现' },
    { role: '设计师', activity: 'idle', movement: 'stationary', bound: false, bindingSource: null, queueCount: 0, employeeId: 'e4', displayName: '不应出现2' },
  ];

  const bundle = createDiagnosticsBundle(makeDeps({ logDir, crashDir, officeDiagnostics, officeEmployees }));
  const result = await bundle.build(target);

  assert.equal(result.ok, true, `export should succeed: ${result.error || ''}`);
  assert.ok(result.path.startsWith(target));
  assert.ok(path.basename(result.path).startsWith(BUNDLE_PREFIX));
  const names = result.files.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'README.txt',
    'crashes.json',
    'environment.json',
    'logs/runtime-2026-09-26T01-00-00-000Z.log',
    'logs/runtime-2026-09-26T02-00-00-000Z.log',
    'manifest.json',
    'office-diagnostics.json',
    'runtime-summary.json',
  ]);
  assert.ok(result.bytes > 0);
  assert.match(result.bytesHuman, /^([\d.]+ (B|KB|MB))$/, `human size present: ${result.bytesHuman}`);

  const root = result.path;
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  // manifest: hashes present, one entry per written file
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.kind, 'dsh-cockpit-diagnostics');
  assert.equal(manifest.generatedAt, '2026-09-26T08:00:00.000Z');
  for (const entry of manifest.files) {
    assert.ok(entry.sha256 && /^[0-9a-f]{64}$/.test(entry.sha256), `sha256 recorded for ${entry.name}`);
    assert.equal(entry.bytes, fs.statSync(path.join(root, entry.name)).size);
  }

  // environment: versions/platform yes; hostname/user/home NO
  const env = JSON.parse(read('environment.json'));
  assert.equal(env.shellVersion, '0.4.0-test');
  assert.equal(env.runtimeVersion, '0.1.1-rc.2');
  assert.equal(env.platform, process.platform);
  assert.equal(JSON.stringify(env).includes(os.hostname()), false, 'no hostname');
  assert.equal(JSON.stringify(env).includes(HOME), false, 'no home path');

  // runtime-summary: render/sync/session counts + roles; ids/names absent
  const summary = JSON.parse(read('runtime-summary.json'));
  assert.deepEqual(summary.render, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1, fps: 59.8, renderProfile: 'full' });
  assert.equal(summary.sync, 'healthy');
  assert.equal(summary.sessions.boundCount, 1);
  assert.deepEqual(summary.sessions.roles, ['工程师']);
  const summaryText = read('runtime-summary.json');
  assert.equal(summaryText.includes('e3'), false, 'no employee id');
  assert.equal(summaryText.includes('不应出现'), false, 'no display name');

  // office-diagnostics: diagnostics ring codes survive, activity/usage never
  const office = JSON.parse(read('office-diagnostics.json'));
  assert.deepEqual(office.diagnostics, [{ atMs: 100, code: 'PACK_MISSING_RESOURCE', count: 2 }]);
  assert.equal(JSON.stringify(office).includes('SHOULD-NOT-APPEAR'), false, 'activity log content excluded');
  assert.equal(JSON.stringify(office).includes('NOT-APPEAR'), false, 'usage block excluded');

  // logs: redacted + tail-capped; .out files never collected
  const logText = read('logs/runtime-2026-09-26T01-00-00-000Z.log');
  assert.ok(!logText.includes('abc123def456'), 'log token redacted');
  assert.ok(logText.includes('?token=[REDACTED]'), logText);
  assert.ok(!logText.includes(HOME), 'log home path folded');
  assert.equal(fs.existsSync(path.join(root, 'logs/runtime-2026-09-26T02-00-00-000Z.out')), false, '.out never in the bundle');

  // crashes: logTail re-redacted, logPath dropped
  const crashes = JSON.parse(read('crashes.json'));
  assert.equal(crashes.count, 1);
  assert.equal(crashes.records[0].logPath, undefined, 'no crash log path');
  assert.ok(!crashes.records[0].logTail.includes('zzz-secret-999'), 'crash tail redacted');
  assert.ok(crashes.records[0].logTail.includes('?token=[REDACTED]'));

  // README names the privacy contract
  const readme = read('README.txt');
  assert.match(readme, /包内字段清单/);
  assert.match(readme, /不含什么/);
  assert.match(readme, /runtime-\.out|\.out/);

  // final scan agrees the bundle is clean
  for (const f of manifest.files) {
    assert.deepEqual(scanTextForSecrets(fs.readFileSync(path.join(root, f.name), 'utf8')), [], `${f.name} is secret-free`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(crashDir, { recursive: true, force: true });
});

test('build: log tail cap keeps at most the newest 2000 lines per file', async () => {
  const target = tmpDir('dsh-diag-test-');
  const logDir = tmpDir('dsh-diag-logs-');
  const lines = [];
  for (let i = 0; i < 2500; i += 1) lines.push(`line-${i}`);
  fs.writeFileSync(path.join(logDir, 'runtime-2026-09-26T03-00-00-000Z.log'), `${lines.join('\n')}\n`);
  const bundle = createDiagnosticsBundle(makeDeps({ logDir }));
  const result = await bundle.build(target);
  assert.equal(result.ok, true, result.error);
  const kept = fs.readFileSync(path.join(result.path, 'logs/runtime-2026-09-26T03-00-00-000Z.log'), 'utf8').trim().split('\n');
  assert.equal(kept.length, 2000);
  assert.equal(kept[0], 'line-500', 'oldest lines dropped, newest kept');
  assert.equal(kept[1999], 'line-2499');
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(logDir, { recursive: true, force: true });
});

test('build: secret scan failure deletes the whole bundle and reports the reason', async () => {
  const target = tmpDir('dsh-diag-test-');
  // hostile payload through a projection path that structurally copies an
  // object (the office clock block is carried whole for numeric telemetry):
  // the line redactor never sees JSON — the final full-text scan must catch
  // it and fail the export. This is the exact regression the scan exists for.
  const bundle = createDiagnosticsBundle(makeDeps({
    officeDiagnostics: {
      schemaVersion: 1, sync: 'healthy', paused: false, employeeCount: 0,
      activityLogSize: 0, packPresent: true, adapterCount: 0, seed: 'x',
      renderer: null,
      clock: { running: true, ticks: 1, note: 'password: supersecret123' },
      diagnostics: [],
    },
  }));
  const result = await bundle.build(target);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SECRET_SCAN_FAILED');
  assert.ok(Array.isArray(result.findings) && result.findings.length >= 1);
  assert.ok(result.findings.some((f) => f.kind === 'secret-assignment'));
  // the bundle directory is gone — nothing leaky stays on disk
  const leftovers = fs.readdirSync(target).filter((n) => n.startsWith(BUNDLE_PREFIX));
  assert.deepEqual(leftovers, [], 'no bundle directory remains after a failed scan');
  fs.rmSync(target, { recursive: true, force: true });
});

test('build: missing log/crash dirs and no office module degrade gracefully', async () => {
  const target = tmpDir('dsh-diag-test-');
  const bundle = createDiagnosticsBundle(makeDeps({ logDir: path.join(target, 'does-not-exist'), crashDir: path.join(target, 'nope') }));
  const result = await bundle.build(target);
  assert.equal(result.ok, true, result.error);
  const crashes = JSON.parse(fs.readFileSync(path.join(result.path, 'crashes.json'), 'utf8'));
  assert.equal(crashes.count, 0);
  const office = JSON.parse(fs.readFileSync(path.join(result.path, 'office-diagnostics.json'), 'utf8'));
  assert.equal(office, null, 'office block is null without the module');
  const summary = JSON.parse(fs.readFileSync(path.join(result.path, 'runtime-summary.json'), 'utf8'));
  assert.equal(summary.render, null);
  assert.equal(summary.sessions.boundCount, 0);
  fs.rmSync(target, { recursive: true, force: true });
});
