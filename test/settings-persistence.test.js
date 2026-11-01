// test/settings-persistence.test.js — Issue #19：Settings 数据保护。
//
// 第一性原理：这些测试守护的是"数据不丢"，不是"功能可用"
//
//   审审计发现的三个会静默毁数据的缺陷（TD-02/03/05）：
//     1. 没有 schemaVersion → 无法判断文件版本，也就无法迁移
//     2. 损坏时 `catch {}` 静默回落默认值 → 用户丢 53 个设置毫不知情，
//        且下一次 save() 直接覆盖原文件，**原数据永久消失**
//     3. 没有 .bak → 发现了也回不去
//
//   用户明确要求：「先保护现有数据，不要因为计划使用 SQLite，就一次性迁移
//   全部旧设置」「制定独立、可回滚的数据迁移方案」。
//
//   所以这里测的不是"能不能存设置"，而是：
//     - 损坏时数据还在吗？（另存 .corrupt，不覆盖）
//     - 能从备份恢复吗？（.bak 链三层）
//     - 迁移会改坏数据吗？（纯函数、可回滚）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persistence = require('../src/settings-persistence.js');
const { SettingsStore, DEFAULTS } = require('../src/settings-store.js');

function tmpDir(prefix = 'dsh-settings-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------- 原子写

test('atomicWrite: writes via a unique temp file then renames (no fixed .tmp collision)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  persistence.atomicWrite(file, '{"a":1}\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  // 目录里不应残留 tmp
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp file may be left behind');
});

test('atomicWrite: concurrent writes to the SAME file never interleave (unique temp names)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  // 两个不同的 pid+ts 组合 → 两个不同的 tmp 名。这里用同一进程模拟连续写，
  // 关键断言是"最后一次完整覆盖前一次"，而不是内容交错。
  persistence.atomicWrite(file, 'A'.repeat(1000));
  persistence.atomicWrite(file, 'B'.repeat(1000));
  const got = fs.readFileSync(file, 'utf8');
  assert.strictEqual(got, 'B'.repeat(1000), 'the last write wins atomically');
});

// ---------------------------------------------------------------- 分层回退

test('readSettings: a healthy file is read from the primary and reports source=primary', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, language: 'en' }));
  const r = persistence.readSettings(file);
  assert.strictEqual(r.source, 'primary');
  assert.strictEqual(r.data.language, 'en');
  assert.strictEqual(r.corruptPath, null);
});

test('readSettings: a CORRUPT file is preserved (never silently overwritten) and recovery is reported', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ this is not json');
  const r = persistence.readSettings(file);

  assert.notStrictEqual(r.source, 'primary', 'a broken file must not be trusted');
  assert.ok(r.corruptPath, 'the corrupt file must be preserved under a .corrupt-* name');
  assert.ok(fs.existsSync(r.corruptPath), 'and that preserved copy must actually exist');
  assert.strictEqual(fs.readFileSync(r.corruptPath, 'utf8'), '{ this is not json',
    'the preserved copy must contain the ORIGINAL bytes (evidence for the user)');
  assert.ok(r.warnings.some((w) => /损坏/.test(w)), 'the user must be told what happened');
});

test('readSettings: falls back to .bak when the primary is unreadable', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'garbage');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ schemaVersion: 1, language: 'zh' }));
  const r = persistence.readSettings(file);
  assert.strictEqual(r.source, 'backup');
  assert.strictEqual(r.backupIndex, 0);
  assert.strictEqual(r.data.language, 'zh', 'the recovered settings must be the backup contents');
});

test('readSettings: walks the whole .bak chain (.bak → .bak.1 → .bak.2)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'garbage');
  fs.writeFileSync(`${file}.bak`, 'also garbage');
  fs.writeFileSync(`${file}.bak.1`, 'garbage too');
  fs.writeFileSync(`${file}.bak.2`, JSON.stringify({ schemaVersion: 1, language: 'ja' }));
  const r = persistence.readSettings(file);
  assert.strictEqual(r.source, 'backup');
  assert.strictEqual(r.backupIndex, 2, 'must reach the third backup');
  assert.strictEqual(r.data.language, 'ja');
});

test('readSettings: non-object top-level JSON is rejected (an array is not settings)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '[1,2,3]');
  const r = persistence.readSettings(file);
  assert.notStrictEqual(r.source, 'primary');
  assert.ok(r.corruptPath, 'an array payload must be treated as corrupt, not merged into settings');
});

test('readSettings: a missing file reports source=none without throwing', () => {
  const dir = tmpDir();
  const r = persistence.readSettings(path.join(dir, 'settings.json'));
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.data, null);
  assert.ok(r.error, 'the caller needs a reason to distinguish first-run from corruption');
});

// ---------------------------------------------------------------- 写入与轮转

test('writeSettings: injects schemaVersion and rotates the previous file into .bak', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  // 第一份
  persistence.writeSettings(file, { language: 'en' });
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(first.schemaVersion, persistence.SETTINGS_SCHEMA_VERSION);
  assert.strictEqual(first.language, 'en');

  // 第二份：第一份必须被轮转进 .bak
  persistence.writeSettings(file, { language: 'zh' });
  assert.ok(fs.existsSync(`${file}.bak`), 'previous content must be kept as .bak');
  const bak = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.strictEqual(bak.language, 'en', '.bak must hold the PREVIOUS valid content');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).language, 'zh');
});

test('writeSettings: keeps a bounded backup chain (BACKUP_DEPTH), dropping the oldest', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  for (let i = 0; i < persistence.BACKUP_DEPTH + 2; i += 1) {
    persistence.writeSettings(file, { marker: i });
  }
  const backups = persistence.backupCandidates(file).filter((p) => fs.existsSync(p));
  assert.strictEqual(backups.length, persistence.BACKUP_DEPTH,
    `exactly ${persistence.BACKUP_DEPTH} backups must be retained, got ${backups.length}`);
  // 最新的备份是倒数第二次写入
  const newest = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
  assert.strictEqual(newest.marker, persistence.BACKUP_DEPTH);
});

// ---------------------------------------------------------------- 迁移

test('migrate: a versionless (v0) file is upgraded to the current schema', () => {
  const r = persistence.migrate({ language: 'en', keepVersions: 2 });
  assert.strictEqual(r.from, 0);
  assert.strictEqual(r.to, persistence.SETTINGS_SCHEMA_VERSION);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.data.schemaVersion, persistence.SETTINGS_SCHEMA_VERSION);
  assert.strictEqual(r.data.language, 'en', 'migration must not drop user values');
});

test('migrate: an already-current file reports changed=false (idempotent)', () => {
  const cur = { schemaVersion: persistence.SETTINGS_SCHEMA_VERSION, language: 'en' };
  const r = persistence.migrate(cur);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.from, persistence.SETTINGS_SCHEMA_VERSION);
});

test('migrate: is a pure function (does not mutate its input)', () => {
  const input = { language: 'en' };
  const snapshot = JSON.stringify(input);
  persistence.migrate(input);
  assert.strictEqual(JSON.stringify(input), snapshot, 'migration must not mutate the caller\'s object');
});

// ------------------------------------------------------- SettingsStore 集成

test('SettingsStore: a corrupt settings.json is recovered from .bak and the status says so', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ schemaVersion: 1, language: 'en', keepVersions: 4 }));
  fs.writeFileSync(file, 'CORRUPT');

  const store = new SettingsStore(dir);
  const st = store.status();
  assert.strictEqual(st.recoveredFromBackup, true, 'the store must report that it recovered');
  assert.strictEqual(store.get().language, 'en', 'recovered values must win over defaults');
  assert.strictEqual(store.get().keepVersions, 4);
  assert.ok(st.warnings.length > 0, 'the user must be able to see what happened');
});

test('SettingsStore: a legacy file without schemaVersion is migrated and values survive', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ language: 'en', keepVersions: 3 })); // v0
  const store = new SettingsStore(dir);
  assert.strictEqual(store.get().language, 'en');
  assert.strictEqual(store.get().keepVersions, 3);
  assert.strictEqual(store.status().migratedFrom, 0, 'the status must record the migration source version');
});

test('SettingsStore: save() writes a versioned file and keeps a .bak of the prior state', () => {
  const dir = tmpDir();
  const store = new SettingsStore(dir);
  store.patch({ language: 'en' });
  // 再存一次，产生 .bak
  store.patch({ language: 'zh' });

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(onDisk.schemaVersion, persistence.SETTINGS_SCHEMA_VERSION,
    'the file on disk must carry a schema version');
  assert.strictEqual(onDisk.language, 'zh');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json.bak')), 'a .bak must exist after the second save');
});

test('SettingsStore: the schemaVersion never leaks into get() (it is file metadata, not a setting)', () => {
  const dir = tmpDir();
  const store = new SettingsStore(dir);
  store.patch({ language: 'en' });
  assert.ok(!('schemaVersion' in store.get()),
    'schemaVersion is persistence metadata; exposing it as a setting would let patch() try to validate it');
  assert.ok('language' in store.get());
});

test('SettingsStore: defaults still apply when there is no file at all (first run unaffected)', () => {
  const dir = tmpDir();
  const store = new SettingsStore(dir);
  assert.strictEqual(store.get().language, DEFAULTS.language);
  assert.strictEqual(store.status().source, 'none');
});
