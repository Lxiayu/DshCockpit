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
