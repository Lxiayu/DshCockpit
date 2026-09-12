// test/settings-store.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SettingsStore, DEFAULTS } = require('../src/settings-store');

function tmpUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-test-'));
}

test('defaults are applied on first run', () => {
  const s = new SettingsStore(tmpUserData());
  assert.strictEqual(s.get().channel, 'rc');
  assert.strictEqual(s.get().language, 'system');
  assert.strictEqual(s.get().backupKeep, 5);
  assert.strictEqual(s.get().remoteControl, false);
  assert.strictEqual(s.get().remoteCompat, true); // scanner compat is opt-out
  assert.ok(Array.isArray(s.get().recentWorkspaces));
});

test('remoteCompat patches and round-trips as a boolean', () => {
  const dir = tmpUserData();
  const s = new SettingsStore(dir);
  s.patch({ remoteCompat: false });
  assert.strictEqual(s.get().remoteCompat, false);
  s.patch({ remoteCompat: 'yes' }); // truthy string coerces like other boolean keys
  assert.strictEqual(s.get().remoteCompat, true);
  assert.strictEqual(new SettingsStore(dir).get().remoteCompat, true);
});

test('patch persists to disk and load merges', () => {
  const dir = tmpUserData();
  const s = new SettingsStore(dir);
  s.patch({ channel: 'pinned', pinnedVersion: '0.1.0-rc.6', backupKeep: 3 });
  const s2 = new SettingsStore(dir);
  assert.strictEqual(s2.get().channel, 'pinned');
  assert.strictEqual(s2.get().pinnedVersion, '0.1.0-rc.6');
  assert.strictEqual(s2.get().backupKeep, 3);
  assert.strictEqual(s2.get().language, 'system'); // untouched default survives
});

test('effective() applies env overrides', () => {
  process.env.DSH_DESKTOP_WORKSPACE = 'C:\\env-ws';
  process.env.DSH_DESKTOP_PORT = '1234';
  const s = new SettingsStore(tmpUserData());
  s.patch({ workspace: 'C:\\cfg-ws', port: 99 });
  const eff = s.effective();
  assert.strictEqual(eff.workspace, 'C:\\env-ws'); // env wins
  assert.strictEqual(eff.port, 1234);
  delete process.env.DSH_DESKTOP_WORKSPACE;
  delete process.env.DSH_DESKTOP_PORT;
});

test('recentWorkspaces patch round-trips', () => {
  const dir = tmpUserData();
  const s = new SettingsStore(dir);
  s.patch({ recentWorkspaces: ['C:\\a', 'C:\\b'] });
  assert.deepStrictEqual(new SettingsStore(dir).get().recentWorkspaces, ['C:\\a', 'C:\\b']);
});

test('DEFAULTS exposes all fields', () => {
  for (const k of ['channel', 'pinnedVersion', 'registry', 'keepVersions', 'workspace', 'dshHome',
    'port', 'trayOnClose', 'autoStart', 'checkUpdatesOnStartup', 'nodeBin', 'dshBin',
    'language', 'backupOnQuit', 'backupKeep', 'quickAskHotkey', 'recentWorkspaces',
    'remoteControl', 'remoteCompat', 'remotePort']) {
    assert.ok(k in DEFAULTS, `missing default: ${k}`);
  }
  assert.equal('tokenWidget' in DEFAULTS, false);
});

test('legacy tokenWidget is dropped when settings are loaded', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ tokenWidget: true, quickAskHotkey: '' }));
  const s = new SettingsStore(dir);
  assert.equal('tokenWidget' in s.get(), false);
  assert.equal(s.get().quickAskHotkey, '');
  s.save();
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal('tokenWidget' in persisted, false);
  assert.equal(persisted.quickAskHotkey, '');
});

test('quickAskHotkey accepts only supported presets including disabled', () => {
  const dir = tmpUserData();
  const s = new SettingsStore(dir);
  s.patch({ quickAskHotkey: 'CommandOrControl+Shift+Space' });
  assert.equal(s.get().quickAskHotkey, 'CommandOrControl+Shift+Space');
  s.patch({ quickAskHotkey: '' });
  assert.equal(s.get().quickAskHotkey, '');
  s.patch({ quickAskHotkey: 'Alt+F4' });
  assert.equal(s.get().quickAskHotkey, '');
});

// ---- V4.1 migration (DeepSeek model line-up, effective 2026-09-10) ---------

test('defaults reflect the V4.1 model line (1M window, Flash rates)', () => {
  assert.strictEqual(DEFAULTS.contextWindow, 1000000);
  assert.strictEqual(DEFAULTS.costInputPerM, 1);
  assert.strictEqual(DEFAULTS.costOutputPerM, 4);
  assert.strictEqual(DEFAULTS.costCacheReadPerM, 0.02);
  assert.strictEqual(DEFAULTS.costPeakInputPerM, 2);
  assert.strictEqual(DEFAULTS.costPeakOutputPerM, 8);
  assert.strictEqual(DEFAULTS.costPeakCacheReadPerM, 0.04);
});

test('untouched pre-V4.1 defaults migrate to the 1M window and Flash rates', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    contextWindow: 128000,
    costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.5,
    costPeakInputPerM: 4, costPeakOutputPerM: 16, costPeakCacheReadPerM: 1,
  }));
  const s = new SettingsStore(dir).get();
  assert.strictEqual(s.contextWindow, 1000000);
  assert.strictEqual(s.costInputPerM, 1);
  assert.strictEqual(s.costOutputPerM, 4);
  assert.strictEqual(s.costCacheReadPerM, 0.02);
  assert.strictEqual(s.costPeakInputPerM, 2);
  assert.strictEqual(s.costPeakOutputPerM, 8);
  assert.strictEqual(s.costPeakCacheReadPerM, 0.04);
});

test('user-customized values are never migrated', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    contextWindow: 64000, costInputPerM: 3, monthlyBudget: 50, costPeakEnabled: true,
  }));
  const s = new SettingsStore(dir).get();
  assert.strictEqual(s.contextWindow, 64000);
  assert.strictEqual(s.costInputPerM, 3);
  assert.strictEqual(s.monthlyBudget, 50);
  assert.strictEqual(s.costPeakEnabled, true);
});

test('the migration re-applies on reload and persists on the next save', () => {
  const dir = tmpUserData();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ contextWindow: 128000 }));
  const first = new SettingsStore(dir);
  assert.strictEqual(first.get().contextWindow, 1000000);
  first.save();
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(persisted.contextWindow, 1000000);
  assert.strictEqual(new SettingsStore(dir).get().contextWindow, 1000000);
});
