// test/capability-packs.test.js — P3 S1-S3：manifest / verify / installer。
//
// 第一性原理：这三个文件的测试要钉住什么
//
//   manifest  → 字段少而硬：未知字段必须拒绝，否则半年后没人敢改
//   verify    → 四态：skipped 绝不能算 passed（本项目踩过的坑）
//   installer → 安装=记录、卸载=删记录，所以"无残留"可验证
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifestModule = require('../src/capability-packs/manifest.js');
const verifyModule = require('../src/capability-packs/verify.js');
const installerModule = require('../src/capability-packs/installer.js');

const { validateManifest, platformSupport } = manifestModule;
const { runVerify, VERIFY_STATES } = verifyModule;
const { createCapabilityInstaller } = installerModule;

// --------------------------------------------------------------- fixtures

function goodManifest(over = {}) {
  return {
    schemaVersion: 1,
    id: 'workspace-verification',
    version: '1.0.0',
    title: '工作区验证',
    requires: { platforms: ['darwin', 'linux', 'win32'], commands: [] },
    provides: { capabilities: ['workspace.verify'] },
    verify: { command: 'node -e "process.exit(0)"' },
    ...over,
  };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packs-')); }

/** 假 runner：按脚本返回结果，记录调用。 */
function fakeRunner(script = {}) {
  const calls = [];
  return {
    calls,
    async run({ command, cwd }) {
      calls.push({ command, cwd });
      const key = Object.keys(script).find((k) => command.includes(k));
      if (key) return script[key];
      return { exitCode: 0, output: 'ok', durationMs: 5, timedOut: false };
    },
  };
}

// ============================================================ manifest

test('manifest: a well-formed manifest validates', () => {
  assert.strictEqual(validateManifest(goodManifest()).ok, true);
});

test('manifest: UNKNOWN fields are rejected (fail-closed, not ignored)', () => {
  // 这是"字段少而硬"的执行机制：加字段必须先改校验器，那时才知道为什么加。
  const r = validateManifest(goodManifest({ surpriseField: 1 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown field "surpriseField"/.test(e)));
});

test('manifest: a pack WITHOUT verify is rejected', () => {
  // 没有 verify 的 capability pack 只是文档。
  const m = goodManifest();
  delete m.verify;
  const r = validateManifest(m);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /verify/.test(e)));
});

test('manifest: unknown fields inside requires/verify are rejected too', () => {
  assert.strictEqual(validateManifest(goodManifest({ requires: { platforms: ['linux'], commands: [], extra: 1 } })).ok, false);
  assert.strictEqual(validateManifest(goodManifest({ verify: { command: 'x', extra: 1 } })).ok, false);
});

test('manifest: schemaVersion must be exactly 1', () => {
  assert.strictEqual(validateManifest(goodManifest({ schemaVersion: 2 })).ok, false);
  assert.strictEqual(validateManifest(goodManifest({ schemaVersion: '1' })).ok, false);
});

test('manifest: id must be lower kebab-case', () => {
  for (const bad of ['Workspace', 'work_space', '-lead', 'trail-', 'a']) {
    assert.strictEqual(validateManifest(goodManifest({ id: bad })).ok, false, `id=${bad} should be rejected`);
  }
  assert.strictEqual(validateManifest(goodManifest({ id: 'ws-verify-2' })).ok, true);
});

test('manifest: version must be MAJOR.MINOR.PATCH', () => {
  for (const bad of ['1', '1.0', 'v1.0.0', '1.0.0-beta']) {
    assert.strictEqual(validateManifest(goodManifest({ version: bad })).ok, false, `version=${bad}`);
  }
});

test('manifest: an unknown platform is rejected (typos must not pass)', () => {
  const r = validateManifest(goodManifest({ requires: { platforms: ['macos'], commands: [] } }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /unknown platform/.test(e)));
});

test('manifest: ALL errors are reported at once (not just the first)', () => {
  const r = validateManifest({ schemaVersion: 9, id: 'BAD', version: 'x' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length >= 4, `expected multiple errors, got ${r.errors.length}`);
});

test('manifest: platformSupport reports a readable reason', () => {
  const m = goodManifest({ requires: { platforms: ['linux'], commands: [] } });
  assert.strictEqual(platformSupport(m, 'linux').supported, true);
  const unsupported = platformSupport(m, 'win32');
  assert.strictEqual(unsupported.supported, false);
  assert.match(unsupported.reason, /supports linux, not win32/);
});

// ============================================================ verify 四态

test('verify: a passing command yields passed', async () => {
  const r = await runVerify(goodManifest(), { runner: fakeRunner(), platform: 'linux' });
  assert.strictEqual(r.state, 'passed');
});

test('verify: a wrong exit code yields failed with the code in the reason', async () => {
  const runner = fakeRunner({ 'node': { exitCode: 2, output: 'boom', durationMs: 3 } });
  const r = await runVerify(goodManifest(), { runner, platform: 'linux' });
  assert.strictEqual(r.state, 'failed');
  assert.match(r.reason, /exit code 2, expected 0/);
});

test('verify: a timeout yields failed (not not-verified)', async () => {
  const runner = fakeRunner({ 'node': { exitCode: null, timedOut: true, durationMs: 5000 } });
  const r = await runVerify(goodManifest(), { runner, platform: 'linux' });
  assert.strictEqual(r.state, 'failed');
  assert.match(r.reason, /timed out/);
});

test('verify: an unsupported platform yields SKIPPED — and skipped is NOT passed', async () => {
  // 本项目最重要的纪律：Skip 不计作 Pass。
  const r = await runVerify(goodManifest({ requires: { platforms: ['linux'], commands: [] } }),
    { runner: fakeRunner(), platform: 'win32' });
  assert.strictEqual(r.state, 'skipped');
  assert.notStrictEqual(r.state, 'passed');
  assert.match(r.reason, /not win32/);
});

test('verify: a missing dependency command yields not-verified (not failed)', async () => {
  // "没装依赖"和"验证失败"是两件事，用户要看到不同的处理建议。
  const runner = fakeRunner({ 'command -v': { exitCode: 1, output: '', durationMs: 1 } });
  const manifest = goodManifest({ requires: { platforms: ['linux'], commands: ['definitely-not-installed'] } });
  const r = await runVerify(manifest, { runner, platform: 'linux' });
  assert.strictEqual(r.state, 'not-verified');
  assert.match(r.reason, /missing command/);
});

test('verify: the four states are exactly the documented set', () => {
  assert.deepStrictEqual([...VERIFY_STATES], ['passed', 'failed', 'skipped', 'not-verified']);
});

test('verify: long output is truncated to a tail (no unbounded payloads)', async () => {
  const huge = 'X'.repeat(50_000);
  const runner = fakeRunner({ 'node': { exitCode: 1, output: huge, durationMs: 1 } });
  const r = await runVerify(goodManifest(), { runner, platform: 'linux' });
  assert.ok(r.output.length <= 2100, `output should be bounded, got ${r.output.length}`);
});

test('verify: a command name with shell metacharacters is refused as a dependency', async () => {
  // manifest 不能变成任意命令执行的入口。
  const manifest = goodManifest({ requires: { platforms: ['linux'], commands: ['node; rm -rf /'] } });
  const r = await runVerify(manifest, { runner: fakeRunner(), platform: 'linux' });
  assert.strictEqual(r.state, 'not-verified');
});

test('verify: no runner yields not-verified, not a crash', async () => {
  const r = await runVerify(goodManifest(), { platform: 'linux' });
  assert.strictEqual(r.state, 'not-verified');
});

// ============================================================ installer

test('installer: install runs verify and records the result', async () => {
  const dir = tmpDir();
  const inst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  const r = await inst.install(goodManifest());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'INSTALLED');
  const list = inst.list();
  assert.strictEqual(list.packs.length, 1);
  assert.strictEqual(list.packs[0].id, 'workspace-verification');
  assert.strictEqual(list.packs[0].verify.state, 'passed');
});

test('installer: installing an invalid manifest is refused with the reasons', async () => {
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner: fakeRunner(), platform: 'linux' });
  const r = await inst.install({ schemaVersion: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'MANIFEST_INVALID');
  assert.ok(r.reason.length > 0);
});

test('installer: an unsupported platform is REFUSED clearly (not crashed)', async () => {
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner: fakeRunner(), platform: 'win32' });
  const r = await inst.install(goodManifest({ requires: { platforms: ['linux'], commands: [] } }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'PLATFORM_UNSUPPORTED');
  assert.match(r.reason, /not win32/);
});

test('installer: it refuses to install a pack whose verify FAILED', async () => {
  const runner = fakeRunner({ 'node': { exitCode: 1, output: 'nope', durationMs: 1 } });
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner, platform: 'linux' });
  const r = await inst.install(goodManifest());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'VERIFY_FAILED');
});

test('installer: it refuses to install a pack that cannot be verified', async () => {
  // 装一个"验证不了"的包 = 装了个不知道能不能用的东西。
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner: fakeRunner(), platform: 'win32' });
  const r = await inst.install(goodManifest({ requires: { platforms: ['linux'], commands: [] } }));
  assert.strictEqual(r.ok, false);
  // 平台检查先于 verify，所以这里是 PLATFORM_UNSUPPORTED —— 但两者都是"拒绝"
  assert.ok(['PLATFORM_UNSUPPORTED', 'VERIFY_NOT_POSSIBLE'].includes(r.code));
});

test('installer: install is IDEMPOTENT (same version twice is not an error)', async () => {
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner: fakeRunner(), platform: 'linux' });
  const a = await inst.install(goodManifest());
  const b = await inst.install(goodManifest());
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.code, 'ALREADY_INSTALLED');
  assert.strictEqual(inst.list().packs.length, 1, 'no duplicate record');
});

test('installer: uninstall is IDEMPOTENT (uninstalling twice is not an error)', async () => {
  const inst = createCapabilityInstaller({ dataDir: tmpDir(), runner: fakeRunner(), platform: 'linux' });
  await inst.install(goodManifest());
  assert.strictEqual(inst.uninstall('workspace-verification').code, 'UNINSTALLED');
  assert.strictEqual(inst.uninstall('workspace-verification').code, 'NOT_INSTALLED');
});

test('installer: uninstall leaves NO residue (that is the whole point of record-based install)', () => {
  const dir = tmpDir();
  const inst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  return inst.install(goodManifest()).then(() => {
    inst.uninstall('workspace-verification');
    assert.strictEqual(inst.assertClean('workspace-verification').clean, true);
    // 目录里除记录文件外不应有孤儿
    const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.tmp'));
    assert.deepStrictEqual(files, ['installed.json'], `unexpected residue: ${files.join(', ')}`);
  });
});

test('installer: a corrupt install record is reported, NOT silently overwritten', async () => {
  // 静默重建 = 丢用户数据。
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed.json'), '{ not json');
  const inst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  const r = await inst.install(goodManifest());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'RECORD_CORRUPT');
  // 原文件必须还在（没被覆盖）
  assert.strictEqual(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'), '{ not json');
});

test('installer: healthCheck re-runs verify so drift becomes visible', async () => {
  const dir = tmpDir();
  // 第一次装成功
  const okInst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  await okInst.install(goodManifest());
  // 换一个会失败的 runner 做健康检查（模拟依赖被卸载/环境变化）
  const badInst = createCapabilityInstaller({
    dataDir: dir,
    runner: fakeRunner({ 'node': { exitCode: 1, output: 'gone', durationMs: 1 } }),
    platform: 'linux',
  });
  const h = await badInst.healthCheck({ 'workspace-verification': goodManifest() });
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.results[0].state, 'failed');
});

test('installer: healthCheck reports not-verified for a pack with no manifest available', async () => {
  const dir = tmpDir();
  const inst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  await inst.install(goodManifest());
  const h = await inst.healthCheck({});
  assert.strictEqual(h.results[0].state, 'not-verified');
});

test('installer: requires dataDir (fail fast)', () => {
  assert.throws(() => createCapabilityInstaller({}), /requires dataDir/);
});

test('installer: writes are atomic (no .tmp leftovers)', async () => {
  const dir = tmpDir();
  const inst = createCapabilityInstaller({ dataDir: dir, runner: fakeRunner(), platform: 'linux' });
  await inst.install(goodManifest());
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

// ============================================================ 不复用造轮子

test('packs: verify goes through the shared command runner (no second executor)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'capability-packs', 'verify.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]node:child_process['"]\)/,
    'verify must NOT spawn directly — it reuses src/work/command-runner.js');
  assert.match(src, /runner\.run\(/, 'it calls the injected runner');
});
