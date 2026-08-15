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
