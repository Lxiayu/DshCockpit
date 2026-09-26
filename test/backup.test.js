// test/backup.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupNow, backupDeltaNow, backupInfo } = require('../src/backup');

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

// ------------- windows-perf P1 #3: quit backup leaves the quit path

function richHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-rich-'));
  for (let i = 1; i <= 8; i += 1) {
    const d = path.join(home, 'sessions', 'proj', `sess-${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'session.jsonl'), `{"turn":${i}}\n`.repeat(20));
  }
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'keep: value\n');
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'apiKey: NEVER\n');
  return home;
}

const walkFiles = (root, prefix = '') => {
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.name === 'index.json') continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, prefix ? `${prefix}/${e.name}` : e.name));
    else out.push(prefix ? `${prefix}/${e.name}` : e.name);
  }
  return out;
};

test('REGRESSION #3 (integrity): after a delta quit backup every CURRENT source file is in the backup, byte-equal', async () => {
  const home = richHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-delta-'));
  backupNow({ dshHome: home, backupDir: dir, keep: 5, log: () => {} });
  // mutate: append to one session, add a brand-new one, delete one
  fs.appendFileSync(path.join(home, 'sessions', 'proj', 'sess-3', 'session.jsonl'), '{"turn":31}\n');
  fs.mkdirSync(path.join(home, 'sessions', 'proj', 'sess-new'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', 'proj', 'sess-new', 'session.jsonl'), '{"turn":1}\n');
  fs.rmSync(path.join(home, 'sessions', 'proj', 'sess-7'), { recursive: true, force: true });

  const r = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 5, log: () => {} });
  assert.strictEqual(r.mode, 'delta');
  assert.strictEqual(r.copied, 2, `only the appended + the new file are copied (got ${r.copied})`);

  const latest = backupInfoAfterDelta(dir);
  const src = walkFiles(home).filter((f) => f !== '.credentials.yaml');
  for (const rel of src) {
    const inBackup = path.join(latest, ...rel.split('/'));
    assert.ok(fs.existsSync(inBackup), `backup still holds ${rel}`);
    assert.strictEqual(
      fs.readFileSync(inBackup, 'utf8'),
      fs.readFileSync(path.join(home, ...rel.split('/')), 'utf8'),
      `${rel} is byte-identical to the source (complete backup at quit)`,
    );
  }
  // deleted in the source → retained in the backup (a backup never deletes)
  assert.ok(fs.existsSync(path.join(latest, 'sessions', 'proj', 'sess-7', 'session.jsonl')), 'removed session retained in backup');
  // credentials never enter the backup, not even via delta
  assert.ok(!fs.existsSync(path.join(latest, '.credentials.yaml')));
  assert.strictEqual(fs.readFileSync(path.join(latest, 'index.json'), 'utf8').includes('NEVER'), false, 'index leaks no content');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function backupInfoAfterDelta(dir) {
  const sub = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).sort();
  return path.join(dir, sub[sub.length - 1]);
}

test('REGRESSION #3 (bounded): an unchanged tree copies 0 files and never rewrites existing backup files', async () => {
  const home = richHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-quiet-'));
  backupNow({ dshHome: home, backupDir: dir, keep: 5, log: () => {} });
  const latest = backupInfoAfterDelta(dir);
  const untouched = path.join(latest, 'sessions', 'proj', 'sess-1', 'session.jsonl');
  const mtimeBefore = fs.statSync(untouched).mtimeMs;

  const r1 = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 5, log: () => {} });
  assert.strictEqual(r1.mode, 'delta');
  assert.strictEqual(r1.copied, 0, 'nothing changed → nothing copied (quit path does no content I/O)');
  assert.strictEqual(fs.statSync(untouched).mtimeMs, mtimeBefore, 'existing backup files are not rewritten (no full cpSync at quit)');

  // one appended file → exactly that file is copied, the rest stay untouched
  fs.appendFileSync(path.join(home, 'sessions', 'proj', 'sess-2', 'session.jsonl'), '{"turn":21}\n');
  const r2 = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 5, log: () => {} });
  assert.strictEqual(r2.copied, 1);
  assert.strictEqual(fs.statSync(untouched).mtimeMs, mtimeBefore, 'untouched backup file still not rewritten');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('REGRESSION #3: delta prunes to keep and upgrades an index-less backup dir with one full copy', async () => {
  const home = richHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-upgrade-'));
  // legacy dir without index.json (older shell version)
  fs.mkdirSync(path.join(dir, '2020-01-01T00-00-00-000Z'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2020-01-01T00-00-00-000Z', 'marker.txt'), 'legacy');
  const r1 = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 2, log: () => {} });
  assert.strictEqual(r1.mode, 'full', 'no readable index → one full backup, then deltas');
  const r2 = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 2, log: () => {} });
  assert.strictEqual(r2.mode, 'delta');
  fs.appendFileSync(path.join(home, 'settings.yaml'), 'more: 1\n');
  const r3 = backupDeltaNow({ dshHome: home, backupDir: dir, keep: 2, log: () => {} });
  assert.strictEqual(r3.mode, 'delta');
  const info = await backupInfo(dir);
  assert.strictEqual(info.count, 2, 'prune still keeps the newest 2');
  const newest = backupInfoAfterDelta(dir);
  assert.strictEqual(fs.readFileSync(path.join(newest, 'settings.yaml'), 'utf8').endsWith('more: 1\n'), true, 'delta updated the newest copy');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
