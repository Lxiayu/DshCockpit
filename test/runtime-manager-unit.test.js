// test/runtime-manager-unit.test.js — no-network unit tests for RuntimeManager.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore } = require('../src/settings-store');
const { RuntimeManager } = require('../src/runtime-manager');

function makeManager() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rm-unit-'));
  const settings = new SettingsStore(ud);
  const manager = new RuntimeManager({
    userDataDir: ud,
    settings,
    log: () => {},
    resolveNodeBin: () => ({ bin: process.execPath, runAsNode: false }),
  });
  return { ud, settings, manager };
}

function fakeInstall(dir, version) {
  const pkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), 'x');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version }));
}

test('entry() prefers managed over bootstrap', () => {
  const { ud, manager } = makeManager();
  const fake = path.join(ud, 'fake-install');
  fs.mkdirSync(fake, { recursive: true });
  fakeInstall(fake, '9.9.9');
  manager.bootstrapFrom(fake, '9.9.9');
  assert.strictEqual(manager.entry('9.9.9').source, 'bootstrap');
  manager.state.installed.push({ version: '9.9.9', path: path.join(ud, 'runtime', '9.9.9'), source: 'managed' });
  manager.saveState();
  assert.strictEqual(manager.entry('9.9.9').source, 'managed');
  assert.strictEqual(manager.isActiveManaged(), true);
  fs.rmSync(ud, { recursive: true, force: true });
});

test('installVersion returns the managed copy without re-installing', async () => {
  const { ud, manager } = makeManager();
  const fake = path.join(ud, 'fake-install');
  fs.mkdirSync(fake, { recursive: true });
  fakeInstall(fake, '9.9.9');
  manager.bootstrapFrom(fake, '9.9.9');
  // simulate a completed managed install
  const managedPath = path.join(ud, 'runtime', '9.9.9');
  fs.mkdirSync(managedPath, { recursive: true });
  fakeInstall(managedPath, '9.9.9');
  manager.state.installed.push({ version: '9.9.9', path: managedPath, source: 'managed' });
  manager.saveState();
  const entry = await manager.installVersion('9.9.9');
  assert.strictEqual(entry.source, 'managed'); // no arborist run, no network
  fs.rmSync(ud, { recursive: true, force: true });
});

test('resolveTarget skips malformed versions in the rc channel', () => {
  const { manager } = makeManager();
  const target = manager.resolveTarget({
    versions: {
      '0.1.0-rc.6': {},
      'not-a-version': {},
      '0.1.0-rc.7': {},
      '0.1.0-rc.9-beta': {},
    },
  });
  // highest *valid* prerelease wins; the malformed entry must not throw the sort
  assert.strictEqual(target, '0.1.0-rc.9-beta');
});

test('checkForUpdate refuses the target when engines.node is unsatisfied', async () => {
  const { manager } = makeManager();
  manager.state.activeVersion = '0.1.0-rc.5';
  manager.fetchPackument = async () => ({
    versions: {
      '0.1.0-rc.5': {},
      '0.1.0-rc.7': { engines: { node: '>=22.19.0' } },
    },
  });
  manager.detectNodeVersion = async () => '22.14.0'; // Electron 37's bundled Node
  const report = await manager.checkForUpdate();
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.available, true);
  assert.match(report.reason, /requires Node >=22\.19\.0, found v22\.14\.0/);
});

test('checkForUpdate proceeds when engines.node is satisfied', async () => {
  const { manager } = makeManager();
  manager.state.activeVersion = '0.1.0-rc.5';
  manager.fetchPackument = async () => ({
    versions: {
      '0.1.0-rc.5': {},
      '0.1.0-rc.7': { engines: { node: '>=22.19.0' } },
    },
  });
  manager.detectNodeVersion = async () => '24.1.0';
  const report = await manager.checkForUpdate();
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.target, '0.1.0-rc.7');
});

test('installVersion times out when arborist reify stalls', async () => {
  const { ud, manager } = makeManager();
  manager.installTimeoutMs = 40;
  // fake arborist whose reify never settles — mirrors a stalled registry/cache
  manager._arborist = class FakeArborist {
    constructor() {}
    async reify() { await new Promise(() => {}); }
  };
  const version = '0.1.0-rc.7';
  await assert.rejects(
    manager.installVersion(version),
    /install timed out after 0s/
  );
  // timeout must not leave a zombie install lock behind (retry is possible)
  assert.strictEqual(manager._installLocks.has(version), false);
  fs.rmSync(ud, { recursive: true, force: true });
});

test('installVersion reports live progress frames (preparing/installing/finalizing)', async () => {
  const { ud, manager } = makeManager();
  const frames = [];
  manager._arborist = class FakeArb {
    constructor() {}
    async reify() {
      const nm = path.join(ud, 'runtime', '0.1.0-rc.7', 'node_modules');
      fs.mkdirSync(nm, { recursive: true });
      for (const p of ['@a/one', '@a/two', 'three']) fs.mkdirSync(path.join(nm, p), { recursive: true });
      await new Promise((r) => setTimeout(r, 700)); // let the 500ms liveness probe fire
    }
  };
  const entry = await manager.installVersion('0.1.0-rc.7', (p) => frames.push(p));
  assert.strictEqual(entry.source, 'managed');
  assert.ok(frames.some((f) => f.stage === 'preparing'), 'preparing frame emitted');
  const inst = frames.find((f) => f.stage === 'installing');
  assert.ok(inst && inst.pkgCount >= 2, `liveness frame reports resolved packages (got ${inst && inst.pkgCount})`);
  assert.strictEqual(frames[frames.length - 1].stage, 'finalizing');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('state round-trips to disk', () => {
  const { ud, manager } = makeManager();
  const fake = path.join(ud, 'fake-install');
  fs.mkdirSync(fake, { recursive: true });
  fakeInstall(fake, '9.9.9');
  manager.bootstrapFrom(fake, '9.9.9');
  manager.state.knownIssues['9.9.9'] = 'user rolled back';
  manager.saveState();
  const m2 = new RuntimeManager({
    userDataDir: ud,
    settings: new SettingsStore(ud),
    log: () => {},
    resolveNodeBin: () => ({ bin: process.execPath, runAsNode: false }),
  });
  assert.strictEqual(m2.state.activeVersion, '9.9.9');
  assert.strictEqual(m2.state.knownIssues['9.9.9'], 'user rolled back');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('revalidate drops stale entries but keeps the active pointer', () => {
  const { ud, manager } = makeManager();
  // stale bundled entry (moved app dir) + live bootstrap entry
  const dead = path.join(ud, 'dead-app', 'resources', 'runtime', '1.2.3');
  const live = path.join(ud, 'live-install');
  fs.mkdirSync(live, { recursive: true });
  fakeInstall(live, '1.2.3');
  manager.state.activeVersion = '1.2.3';
  manager.state.installed.push(
    { version: '1.2.3', path: dead, source: 'bundled' },
    { version: '1.2.3', path: live, source: 'bootstrap' }
  );
  manager.saveState();
  manager.revalidate();
  assert.strictEqual(manager.state.installed.length, 1, 'stale entry dropped');
  assert.strictEqual(manager.state.installed[0].path, live, 'live entry kept');
  assert.strictEqual(manager.state.activeVersion, '1.2.3', 'active pointer preserved');
  assert.strictEqual(manager.entry('1.2.3').path, live);
  fs.rmSync(ud, { recursive: true, force: true });
});

test('registerBundled replaces a stale bundled entry (moved app dir)', () => {
  const { ud, manager } = makeManager();
  const stalePath = path.join('C:\\Program Files\\DshCockpit', 'resources', 'runtime', '1.2.3');
  manager.state.activeVersion = '1.2.3';
  manager.state.installed.push({ version: '1.2.3', path: stalePath, source: 'bundled' });
  manager.saveState();
  const bundlePath = path.join(ud, 'bundle', 'resources', 'runtime', '1.2.3');
  fakeInstall(bundlePath, '1.2.3');
  const entry = manager.registerBundled({ version: '1.2.3', path: bundlePath });
  assert.ok(entry, 'bundle registered');
  assert.strictEqual(entry.path, bundlePath, 'path points at the bundle');
  assert.strictEqual(entry.source, 'bundled');
  assert.strictEqual(manager.state.activeVersion, '1.2.3', 'active unchanged (same version)');
  assert.strictEqual(manager.state.installed.length, 1, 'no duplicate entries');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('registerBundled repoints active when it has no live entry (version mismatch)', () => {
  const { ud, manager } = makeManager();
  // previous install's active version is gone; bundle is a different version
  manager.state.activeVersion = '0.9.9';
  manager.state.installed.push({ version: '0.9.9', path: path.join('C:\\nope', '0.9.9'), source: 'managed' });
  manager.saveState();
  const bundlePath = path.join(ud, 'bundle', 'resources', 'runtime', '1.2.3');
  fakeInstall(bundlePath, '1.2.3');
  const entry = manager.registerBundled({ version: '1.2.3', path: bundlePath });
  assert.ok(entry, 'bundle registered');
  assert.strictEqual(manager.state.activeVersion, '1.2.3', 'active repointed to the bundle');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('registerBundled upgrades a bootstrap reference to the bundled seed', () => {
  const { ud, manager } = makeManager();
  const npx = path.join(ud, 'npx-cache', 'node_modules');
  fakeInstall(npx, '1.2.3');
  manager.bootstrapFrom(npx, '1.2.3');
  assert.strictEqual(manager.entry('1.2.3').source, 'bootstrap');
  const bundlePath = path.join(ud, 'bundle', 'resources', 'runtime', '1.2.3');
  fakeInstall(bundlePath, '1.2.3');
  const entry = manager.registerBundled({ version: '1.2.3', path: bundlePath });
  assert.strictEqual(entry.source, 'bundled', 'bootstrap upgraded to bundled');
  assert.strictEqual(manager.state.installed.length, 1, 'no duplicate entries');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('registerBundled keeps a live managed copy', () => {
  const { ud, manager } = makeManager();
  const managedPath = path.join(ud, 'runtime', '1.2.3');
  fakeInstall(managedPath, '1.2.3');
  manager.state.installed.push({ version: '1.2.3', path: managedPath, source: 'managed' });
  manager.state.activeVersion = '1.2.3';
  manager.saveState();
  const bundlePath = path.join(ud, 'bundle', 'resources', 'runtime', '1.2.3');
  fakeInstall(bundlePath, '1.2.3');
  const entry = manager.registerBundled({ version: '1.2.3', path: bundlePath });
  assert.strictEqual(entry.source, 'managed', 'managed wins');
  assert.strictEqual(manager.state.installed.length, 1, 'bundle not added');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('registerBundled rejects a broken bundle (no bin.js)', () => {
  const { ud, manager } = makeManager();
  const bundlePath = path.join(ud, 'bundle', 'resources', 'runtime', '1.2.3');
  fs.mkdirSync(path.join(bundlePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  const entry = manager.registerBundled({ version: '1.2.3', path: bundlePath });
  assert.strictEqual(entry, null, 'no entry for broken bundle');
  assert.strictEqual(manager.state.installed.length, 0, 'state untouched');
  assert.strictEqual(manager.state.activeVersion, null, 'active untouched');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('copyTreePruningNodeModules skips node_modules (junction farm)', () => {
  const { ud, manager } = makeManager();
  const src = path.join(ud, 'dsh-home', 'profiles');
  const web = path.join(src, 'web');
  const nm = path.join(src, 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(web, { recursive: true });
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(web, 'cordis.yml'), 'x');
  fs.writeFileSync(path.join(nm, 'index.js'), 'y');
  const dest = path.join(ud, 'snap');
  manager.copyTreePruningNodeModules(src, dest);
  assert.ok(fs.existsSync(path.join(dest, 'web', 'cordis.yml')), 'profile file copied');
  assert.strictEqual(fs.existsSync(path.join(dest, 'node_modules')), false, 'node_modules pruned');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('snapshotDshHome excludes profiles/node_modules', async () => {
  const { ud, manager } = makeManager();
  const dshHome = path.join(ud, 'dsh-home');
  const nm = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'index.js'), 'y');
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), 's');
  // simulate a junction farm: a symlink dir that would blow up a naive copy
  const big = path.join(ud, 'big-target');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(big, 'file-' + i), 'x');
  try {
    fs.symlinkSync(big, path.join(dshHome, 'profiles', 'node_modules', 'sharp'), 'junction');
  } catch { /* junction creation may fail on some systems; test still valid */ }
  manager.state.activeVersion = '1.0.0';
  manager.snapshotDshHome();
  const snap = manager.state.lastSnapshot;
  assert.ok(snap && fs.existsSync(snap), 'snapshot taken');
  assert.strictEqual(fs.existsSync(path.join(snap, 'profiles', 'node_modules')), false, 'node_modules not in snapshot');
  assert.ok(fs.existsSync(path.join(snap, 'settings.yaml')), 'settings copied');
  fs.rmSync(ud, { recursive: true, force: true });
});

// -------------------------------------------------- update failure/timeout

const { EventEmitter } = require('node:events');

/** Spawn stub with a controllable child (mirrors node:child_process). */
function fakeChild({ exitCode = null, error = null, stdout = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  if (stdout) setImmediate(() => child.stdout.emit('data', Buffer.from(stdout)));
  if (exitCode !== null) setImmediate(() => child.emit('close', exitCode));
  if (error) setImmediate(() => child.emit('error', error));
  return child;
}

test('checkForUpdate swallows registry failures into ok:false (no throw)', async () => {
  const { manager } = makeManager();
  manager.fetchPackument = async () => { throw new Error('network down'); };
  const report = await manager.checkForUpdate();
  assert.strictEqual(report.ok, false);
  assert.strictEqual(report.available, false);
  assert.strictEqual(report.reason, 'network down');
});

test('checkForUpdate reports no version for channel when the packument is empty', async () => {
  const { manager } = makeManager();
  manager.fetchPackument = async () => ({ versions: {}, 'dist-tags': {} });
  const report = await manager.checkForUpdate();
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.available, false);
  assert.match(report.reason, /no version for channel/);
});

test('detectNodeVersion resolves null when the probe errors', async () => {
  const { manager } = makeManager();
  manager._spawn = () => fakeChild({ error: new Error('ENOENT') });
  assert.strictEqual(await manager.detectNodeVersion(), null);
});

test('detectNodeVersion resolves null on non-version output', async () => {
  const { manager } = makeManager();
  manager._spawn = () => fakeChild({ exitCode: 0, stdout: 'not a version\n' });
  assert.strictEqual(await manager.detectNodeVersion(), null);
});

test('detectNodeVersion times out (probe hangs) and resolves null', async () => {
  const { manager } = makeManager();
  manager.nodeProbeTimeoutMs = 20;
  manager._spawn = () => fakeChild(); // never closes, no output
  assert.strictEqual(await manager.detectNodeVersion(), null);
});

test('detectNodeVersion parses vX.Y.Z from stdout', async () => {
  const { manager } = makeManager();
  manager._spawn = () => fakeChild({ exitCode: 0, stdout: 'v22.19.0\n' });
  assert.strictEqual(await manager.detectNodeVersion(), '22.19.0');
});

test('installVersion rejects (and clears the lock) when arborist reify fails', async () => {
  const { ud, manager } = makeManager();
  manager._arborist = class FakeArb {
    constructor() {}
    async reify() { throw new Error('registry auth failed'); }
  };
  const version = '0.1.0-rc.7';
  await assert.rejects(manager.installVersion(version), /registry auth failed/);
  assert.strictEqual(manager._installLocks.has(version), false, 'lock released after failure');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('smokeTest fails fast when lib/bin.js is missing', async () => {
  const { manager } = makeManager();
  const r = await manager.smokeTest({ path: path.join(os.tmpdir(), 'dsh-nope-xyz'), version: '1.0.0' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /missing lib\/bin\.js/);
});

test('smokeTest reports a non-zero exit as failure with the exit code', async () => {
  const { ud, manager } = makeManager();
  const p = path.join(ud, 'runtime', '0.2.0');
  fakeInstall(p, '0.2.0');
  manager._spawn = () => fakeChild({ exitCode: 1 });
  const r = await manager.smokeTest({ path: p, version: '0.2.0' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.exitCode, 1);
  fs.rmSync(ud, { recursive: true, force: true });
});

test('smokeTest times out when the child never exits', async () => {
  const { ud, manager } = makeManager();
  const p = path.join(ud, 'runtime', '0.2.0');
  fakeInstall(p, '0.2.0');
  manager.smokeTimeoutMs = 20;
  manager._spawn = () => fakeChild(); // never closes
  const r = await manager.smokeTest({ path: p, version: '0.2.0' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timeout');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('activate records broken + knownIssues and throws when the smoke test fails', async () => {
  const { ud, manager } = makeManager();
  const p = path.join(ud, 'runtime', '0.2.0');
  fakeInstall(p, '0.2.0');
  manager.state.installed.push({ version: '0.2.0', path: p, source: 'managed' });
  manager._spawn = () => fakeChild({ exitCode: 1 });
  await assert.rejects(manager.activate('0.2.0'), /smoke test failed/);
  assert.ok(manager.state.broken.includes('0.2.0'), 'marked broken');
  assert.ok(manager.state.knownIssues['0.2.0'], 'issue recorded');
  // smoke-failed activation must NOT have switched the active pointer
  assert.notStrictEqual(manager.state.activeVersion, '0.2.0');
  fs.rmSync(ud, { recursive: true, force: true });
});

test('rollback throws when there is no previous version to return to', async () => {
  const { manager } = makeManager();
  manager.state.activeVersion = '0.2.0';
  manager.state.previousVersion = null;
  await assert.rejects(manager.rollback(), /no previous version/);
});
