// test/storage-debt-fixes.test.js — TD-03 与 TD-05 的真实修复验证。
//
// 第一性原理：为什么这两条"已修复"是假的
//
//   技术债文档把 TD-03（work 索引无 .bak）和 TD-05（备份只覆盖 2 个 key）
//   都标成了 ✅，并给了同一句理由："新增 settings-persistence 并接入 SettingsStore"。
//
//   但那是**另一件事**：
//     · TD-03 讲的是 `work/workspace-store.js` 的 index.json
//     · TD-05 讲的是 `backup.js` 的备份范围
//   两者都不在 settings-store 里。所以那个修复一行都没碰到它们。
//
//   危害：如果有人按"存储已安全"去做 Mission 迁移，会丢用户数据。
//   所以本文件的断言是"**真的能做**"：能从 .bak 恢复、备份真的包含新范围。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ============================================ TD-03：索引的 .bak 链

function freshWorkspace() {
  const { createWorkspaceStore } = require(path.join(ROOT, 'src/work/workspace-store.js'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws03-'));
  const store = createWorkspaceStore({ homeDir: home, log: () => {} });
  const ws = store.open({ create: 'testws' });
  return { store, ws, home, indexPath: path.join(ws.path, '.dsh', 'index.json') };
}

test('TD-03: writing the index creates a .bak of the previous version', () => {
  const { store, ws, indexPath } = freshWorkspace();
  store.flush(ws);                       // 第一次写：没有上一版
  store.flush(ws);                       // 第二次写：应产生 .bak
  assert.ok(fs.existsSync(indexPath), 'index must exist');
  assert.ok(fs.existsSync(`${indexPath}.bak`), 'the previous version must be kept as .bak');
});

test('TD-03: a CORRUPT index is recovered from .bak (data is not lost)', () => {
  // 这是本修复的核心价值：以前损坏 = 数据永久丢失，只有 fail-closed 报错。
  const { store, ws, home, indexPath } = freshWorkspace();
  store.flush(ws);
  store.flush(ws);
  fs.writeFileSync(indexPath, '{ this is not json');

  const { createWorkspaceStore } = require(path.join(ROOT, 'src/work/workspace-store.js'));
  const logs = [];
  const store2 = createWorkspaceStore({ homeDir: home, log: (m) => logs.push(m) });
  const ws2 = store2.open({ path: ws.path });
  assert.ok(ws2, 'opening must succeed via .bak recovery');
  assert.ok(logs.some((l) => /recovered from/.test(l)), 'the recovery must be logged, not silent');
});

test('TD-03: corrupt index WITH a corrupt .bak stays fail-closed (no silent rebuild)', () => {
  // 回退必须只在真的能回退时发生。否则就变成"静默丢数据"。
  const { store, ws, home, indexPath } = freshWorkspace();
  store.flush(ws);
  store.flush(ws);
  fs.writeFileSync(indexPath, '{ corrupt');
  fs.writeFileSync(`${indexPath}.bak`, 'also corrupt');

  const { createWorkspaceStore } = require(path.join(ROOT, 'src/work/workspace-store.js'));
  const store2 = createWorkspaceStore({ homeDir: home, log: () => {} });
  assert.throws(() => store2.open({ path: ws.path }), /WORK_INDEX_INVALID|not valid JSON/,
    'with no usable .bak it must refuse, not silently rebuild');
});

test('TD-03: only ONE .bak is kept (bounded, no unbounded growth)', () => {
  const { store, ws, indexPath } = freshWorkspace();
  for (let i = 0; i < 5; i += 1) store.flush(ws);
  const dir = path.dirname(indexPath);
  const baks = fs.readdirSync(dir).filter((n) => n.includes('.bak'));
  assert.strictEqual(baks.length, 1, `exactly one .bak must exist, got ${baks.join(',')}`);
});

// ============================================ TD-05：备份范围

function fixtureHome() {
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh05-'));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud05-'));
  fs.mkdirSync(path.join(dshHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'sessions', 's1.json'), '{}');
  fs.writeFileSync(path.join(dshHome, 'settings.yaml'), 'a: 1');
  fs.writeFileSync(path.join(userDataDir, 'settings.json'), '{"b":2}');
  fs.writeFileSync(path.join(userDataDir, 'office-state.v1.json'), '{"c":3}');
  return { dshHome, userDataDir, backupDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bk05-')) };
}

test('TD-05: the backup includes userData shell state, not just 2 keys', () => {
  const { backupNow } = require(path.join(ROOT, 'src/backup.js'));
  const f = fixtureHome();
  const dest = backupNow({ dshHome: f.dshHome, backupDir: f.backupDir, userDataDir: f.userDataDir, log: () => {} });
  const index = JSON.parse(fs.readFileSync(path.join(dest, 'index.json'), 'utf8'));
  const keys = Object.keys(index.files);
  assert.ok(keys.includes('sessions/s1.json'), 'sessions must still be backed up');
  assert.ok(keys.some((k) => k.includes('office-state.v1.json')), 'office-state must be backed up (TD-05)');
  assert.ok(keys.some((k) => k.startsWith('userdata/')), 'userData keys must be namespaced to avoid collisions');
});

test('TD-05: credentials are NEVER backed up (privacy invariant)', () => {
  const { backupNow } = require(path.join(ROOT, 'src/backup.js'));
  const f = fixtureHome();
  fs.writeFileSync(path.join(f.userDataDir, 'model-keys.json'), 'SECRET-BLOB');
  const dest = backupNow({ dshHome: f.dshHome, backupDir: f.backupDir, userDataDir: f.userDataDir, log: () => {} });
  const index = JSON.parse(fs.readFileSync(path.join(dest, 'index.json'), 'utf8'));
  assert.ok(!Object.keys(index.files).some((k) => k.includes('model-keys')),
    'credential vaults must never enter a backup');
});

test('TD-05: resolveSourcePath maps userdata/ back to the right root', () => {
  // 扩范围时最容易漏的一步：复制阶段如果还硬编码 dshHome，
  // 新加的文件会**静默漏掉**（copied 少几个，没人注意）。
  const { resolveSourcePath } = require(path.join(ROOT, 'src/backup.js'));
  const ctx = { dshHome: '/dsh', userDataDir: '/ud' };
  assert.strictEqual(resolveSourcePath('sessions/a.json', ctx), path.join('/dsh', 'sessions', 'a.json'));
  assert.strictEqual(resolveSourcePath('userdata/settings.json', ctx), path.join('/ud', 'settings.json'));
});

test('TD-05: the delta pass copies userData files too (not just indexes them)', () => {
  const { backupNow, backupDeltaNow } = require(path.join(ROOT, 'src/backup.js'));
  const f = fixtureHome();
  backupNow({ dshHome: f.dshHome, backupDir: f.backupDir, userDataDir: f.userDataDir, log: () => {} });
  // 改一个 userData 文件，跑增量
  fs.writeFileSync(path.join(f.userDataDir, 'settings.json'), '{"b":999}');
  const r = backupDeltaNow({ dshHome: f.dshHome, backupDir: f.backupDir, userDataDir: f.userDataDir, log: () => {} });
  assert.strictEqual(r.mode, 'delta');
  assert.ok(r.copied >= 1, 'the changed userData file must actually be copied');
  const copied = path.join(r.dest, 'userdata', 'settings.json');
  assert.ok(fs.existsSync(copied), 'the file must exist in the backup, not just in the index');
  assert.match(fs.readFileSync(copied, 'utf8'), /999/);
});

// ============================================ 防"假 ✅"的门禁

test('debt inventory: a "fixed" claim must name the file it actually changed', () => {
  // 这次的假 ✅ 是这么产生的：只写"新增了 settings-persistence"，
  // 没写"它接到了哪个文件"。下一个人无法核对，就默认它修好了。
  //
  // 规则：标 ✅ 的债条目必须在**同一条目内**点名被改的文件路径。
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'quality', 'tech-debt-inventory.md'), 'utf8');
  const sections = doc.split(/^### /m).slice(1);
  const noFile = [];
  for (const sec of sections) {
    const title = sec.split('\n')[0];
    if (!/✅/.test(sec)) continue;
    // 只有"仍存在"的章节才需要这个保证；标题里带 TD- 编号的才是债条目
    if (!/TD-\d+/.test(title)) continue;
    // 必须在正文里出现一个 src/ 或 docs/ 路径
    if (!/src\/[a-zA-Z0-9_\-/]+\.js|docs\/[a-zA-Z0-9_\-/]+\.md/.test(sec)) {
      noFile.push(title.trim());
    }
  }
  assert.deepEqual(noFile, [],
    `a "fixed" debt entry must name the file it changed: ${noFile.join(' | ')}`);
});

test('debt inventory: TD-03 and TD-05 name their REAL files (not settings-persistence)', () => {
  // 反向确认：两条都指向真正被改的文件。
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'quality', 'tech-debt-inventory.md'), 'utf8');
  const td03 = doc.slice(doc.indexOf('### TD-03'), doc.indexOf('### TD-04'));
  const td05 = doc.slice(doc.indexOf('### TD-05'), doc.indexOf('### TD-06'));
  assert.match(td03, /workspace-store\.js/, 'TD-03 must name the file it actually fixed');
  assert.match(td05, /backup\.js/, 'TD-05 must name the file it actually fixed');
});
