// test/backup.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupNow, backupInfo } = require('../src/backup');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-src-'));
  fs.mkdirSync(path.join(home, 'sessions', 'proj', 'sess1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'proj', 'sess1', 'session.jsonl'), '{"type":"assistant/message"}\n');
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'key: value\n');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'apiKey: secret\n');
  return home;
}

test('backupNow copies sessions and settings, never credentials', () => {
  const home = makeHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-dst-'));
  const dest = backupNow({ dshHome: home, backupDir: dir, keep: 3, log: () => {} });
  assert.ok(fs.existsSync(path.join(dest, 'sessions', 'proj', 'sess1', 'session.jsonl')));
  assert.ok(fs.existsSync(path.join(dest, 'settings.yaml')));
  assert.ok(!fs.existsSync(path.join(dest, '.credentials.yaml')), 'credentials must not be backed up');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupNow prunes beyond keep', async () => {
  const home = makeHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-prune-'));
  for (let i = 0; i < 4; i += 1) backupNow({ dshHome: home, backupDir: dir, keep: 2, log: () => {} });
  const info = await backupInfo(dir);
  assert.strictEqual(info.count, 2, 'only keep newest 2');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backupInfo reports latest and size', async () => {
  const home = makeHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-info-'));
  backupNow({ dshHome: home, backupDir: dir, keep: 3, log: () => {} });
  const info = await backupInfo(dir);
  assert.strictEqual(info.count, 1);
  assert.ok(info.latest);
  assert.ok(info.sizeMB >= 0);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
