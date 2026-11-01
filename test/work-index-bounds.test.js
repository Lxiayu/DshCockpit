// test/work-index-bounds.test.js — TD-04：索引上限与归档。
//
// 第一性原理：为什么"归档"而不是"截断"
//
//   index.json 每次变更都全量重写（saveIndex → writeJsonAtomic），
//   所以写入量与历史长度成正比，累计 O(n²)。加个上限就能解决性能问题——
//   但**直接截断等于销毁用户的 WorkItem 历史**，那比 O(n²) 严重得多。
//
//   所以超限条目被移到 archives/*.json，索引只保留最近的（热数据），
//   旧数据仍可按 id 找回（findArchived）。
//
// 三条硬约束：
//   1. 保留**最新**的，归档**最旧**的（反过来就是把有用的丢掉）
//   2. 归档写失败时**不改索引**（宁可继续大，也不能丢数据）
//   3. 归档后的数据必须真的能找回来（否则"归档"只是"删除"的委婉说法）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/work/workspace-store.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-td04-'));
}

function buildIndex(itemCount, artifactCount, workspaceId = 'ws-1') {
  const index = { schemaVersion: 1, workspaceId, items: [], artifacts: [] };
  for (let i = 0; i < itemCount; i += 1) {
    index.items.push({ workItemId: `item-${String(i).padStart(5, '0')}`, artifactRefs: [] });
  }
  for (let i = 0; i < artifactCount; i += 1) {
    index.artifacts.push({ key: `artifact-${String(i).padStart(5, '0')}`, relPath: `out/a-${i}.txt` });
  }
  return index;
}

// ------------------------------------------------------------------ 阈值

test('td04: the limits are explicit constants (not magic numbers buried in logic)', () => {
  assert.strictEqual(typeof store.MAX_INDEX_ITEMS, 'number');
  assert.strictEqual(typeof store.MAX_INDEX_ARTIFACTS, 'number');
  assert.ok(store.MAX_INDEX_ITEMS > 0 && store.MAX_INDEX_ITEMS <= 10000);
  assert.ok(store.MAX_INDEX_ARTIFACTS > 0 && store.MAX_INDEX_ARTIFACTS <= 50000);
});

test('td04: an index under the limits is returned unchanged (no archive written)', () => {
  const root = tmpRoot();
  const index = buildIndex(10, 10);
  const out = store.enforceBounds(root, index);
  assert.strictEqual(out.index, index, 'the same object is returned');
  assert.strictEqual(out.archivedItems, 0);
  assert.strictEqual(out.archivedArtifacts, 0);
  assert.strictEqual(out.archiveFile, null);
  assert.deepStrictEqual(store.listArchives(root), [], 'no archive should be created');
});

// ------------------------------------------------- 保留最新 / 归档最旧

test('td04: overflow archives the OLDEST entries and keeps the NEWEST', () => {
  // 反过来就是把最有用的丢掉——这是最容易写反的一步。
  const root = tmpRoot();
  const index = buildIndex(store.MAX_INDEX_ITEMS + 5, 0);
  const out = store.enforceBounds(root, index);

  assert.strictEqual(out.archivedItems, 5);
  assert.strictEqual(out.index.items.length, store.MAX_INDEX_ITEMS);
  assert.strictEqual(out.index.items[0].workItemId, 'item-00005', 'the window slides forward');
  assert.strictEqual(out.index.items[out.index.items.length - 1].workItemId,
    `item-${String(store.MAX_INDEX_ITEMS + 4).padStart(5, '0')}`, 'the newest entry survives');

  const archived = JSON.parse(fs.readFileSync(out.archiveFile, 'utf8'));
  assert.strictEqual(archived.items.length, 5);
  assert.strictEqual(archived.items[0].workItemId, 'item-00000', 'the oldest went to the archive');
});

test('td04: artifacts are bounded independently from items', () => {
  const root = tmpRoot();
  const index = buildIndex(5, store.MAX_INDEX_ARTIFACTS + 3);
  const out = store.enforceBounds(root, index);
  assert.strictEqual(out.archivedItems, 0, 'items are under their own limit');
  assert.strictEqual(out.archivedArtifacts, 3);
  assert.strictEqual(out.index.items.length, 5, 'items untouched');
});

test('td04: both limits can overflow in the same call', () => {
  const root = tmpRoot();
  const index = buildIndex(store.MAX_INDEX_ITEMS + 2, store.MAX_INDEX_ARTIFACTS + 4);
  const out = store.enforceBounds(root, index);
  assert.strictEqual(out.archivedItems, 2);
  assert.strictEqual(out.archivedArtifacts, 4);
  assert.strictEqual(out.index.items.length, store.MAX_INDEX_ITEMS);
  assert.strictEqual(out.index.artifacts.length, store.MAX_INDEX_ARTIFACTS);
});

// ------------------------------------------------------ 归档可找回（关键）

test('td04: archived entries are RECOVERABLE (archive is not a euphemism for delete)', () => {
  const root = tmpRoot();
  const index = buildIndex(store.MAX_INDEX_ITEMS + 3, 0);
  store.enforceBounds(root, index);

  const found = store.findArchived(root, (x) => x.workItemId === 'item-00001');
  assert.ok(found, 'an archived item must be findable');
  assert.strictEqual(found.kind, 'item');
  assert.strictEqual(found.value.workItemId, 'item-00001');
  assert.ok(found.archive.endsWith('.json'), 'and the report says WHICH archive holds it');
});

test('td04: an entry still in the live index is NOT in the archive (no duplication)', () => {
  const root = tmpRoot();
  const index = buildIndex(store.MAX_INDEX_ITEMS + 3, 0);
  store.enforceBounds(root, index);
  const stillLive = `item-${String(store.MAX_INDEX_ITEMS + 2).padStart(5, '0')}`;
  assert.strictEqual(store.findArchived(root, (x) => x.workItemId === stillLive), null);
});

test('td04: multiple archives accumulate and stay listable', () => {
  const root = tmpRoot();
  store.enforceBounds(root, buildIndex(store.MAX_INDEX_ITEMS + 1, 0));
  store.enforceBounds(root, buildIndex(store.MAX_INDEX_ITEMS + 1, 0));
  const archives = store.listArchives(root);
  assert.ok(archives.length >= 1, 'archives are listed for auditing');
  for (const a of archives) {
    assert.ok(fs.existsSync(a.path));
  }
});

// --------------------------------------------- 归档失败不能丢数据（关键）

test('td04: a FAILED archive leaves the index untouched (never trade data for size)', () => {
  // 构造不可写的归档目录：把 .dsh/archives 变成一个**文件**而不是目录。
  const root = tmpRoot();
  const archivesPath = path.join(root, '.dsh', 'archives');
  fs.mkdirSync(path.join(root, '.dsh'), { recursive: true });
  fs.writeFileSync(archivesPath, 'not a directory');

  const index = buildIndex(store.MAX_INDEX_ITEMS + 5, 0);
  const out = store.enforceBounds(root, index);

  assert.strictEqual(out.index, index, 'the original index object is returned unchanged');
  assert.strictEqual(out.index.items.length, store.MAX_INDEX_ITEMS + 5, 'nothing was dropped');
  assert.strictEqual(out.archiveFile, null);
  assert.ok(out.archiveError, 'the failure must be reported, not swallowed');
});

// ------------------------------------------------------- 持久化语义

test('td04: the archive file records WHY entries were archived (auditable)', () => {
  const root = tmpRoot();
  const index = buildIndex(store.MAX_INDEX_ITEMS + 1, 0);
  const out = store.enforceBounds(root, index);
  const archived = JSON.parse(fs.readFileSync(out.archiveFile, 'utf8'));
  assert.ok(archived.reason.includes('MAX_INDEX_ITEMS'), 'the reason names the limit that was hit');
  assert.ok(archived.workspaceId, 'the archive is bound to a workspace');
  assert.ok(Number.isFinite(archived.archivedAtMs), 'and timestamped');
});

test('td04: an archive leaves no temp files behind (atomic write)', () => {
  const root = tmpRoot();
  store.enforceBounds(root, buildIndex(store.MAX_INDEX_ITEMS + 1, 0));
  const dir = path.join(root, '.dsh', 'archives');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);
});

test('td04: a corrupt archive does not break findArchived', () => {
  const root = tmpRoot();
  const out = store.enforceBounds(root, buildIndex(store.MAX_INDEX_ITEMS + 2, 0));
  // 再写一个坏归档（名字排序更靠前，会被先读）
  fs.writeFileSync(path.join(root, '.dsh', 'archives', 'zzz-broken.json'), '{ not json');
  const found = store.findArchived(root, (x) => x.workItemId === 'item-00000');
  assert.ok(found, 'one corrupt archive must not hide the others');
});
