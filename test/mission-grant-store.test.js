// test/mission-grant-store.test.js — Grant 的持久化（D10）。
//
// 第一性原理：为什么 Grant 存在独立文件，而不是 Mission 的 events.jsonl
//
//   Grant 是**工作区级**授权，不是某个 Mission 的状态：
//     · 一个 Grant 可被多个 Mission 使用
//     · 撤销时所有引用它的 Mission 都受影响
//     · 删除某个 Mission 不该让授权失效
//
//   混进 Mission 日志会制造"这条 Grant 属于哪个 Mission"的伪问题。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const grant = require('../src/mission/grant.js');

function tmpWs() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-grant-')); }

function G(over = {}) {
  return {
    grantId: 'gr-abc123', grantedBy: 'user', access: 'write',
    workspaceDir: '/Users/xia/proj', createdAtMs: 1000, ...over,
  };
}

test('store: grants round-trip through disk', () => {
  const dir = tmpWs();
  try {
    const r = grant.saveGrants(dir, [G(), G({ grantId: 'gr-def456', access: 'read' })]);
    assert.equal(r.ok, true);
    const back = grant.loadGrants(dir);
    assert.equal(back.grants.length, 2);
    assert.equal(back.grants[0].grantId, 'gr-abc123');
    assert.equal(back.grants[1].access, 'read');
    assert.equal(back.bad, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: an invalid grant is refused at WRITE time (never persisted)', () => {
  const dir = tmpWs();
  try {
    const r = grant.saveGrants(dir, [G({ grantedBy: 'lead' })]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /grantedBy|only the user/i);
    // 表没被写：之前没有文件，现在也不该有
    assert.equal(fs.existsSync(grant.grantsFilePath(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: a corrupt file yields an empty table with a reason, never a throw', () => {
  const dir = tmpWs();
  try {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(grant.grantsFilePath(dir), '{not json', 'utf8');
    const back = grant.loadGrants(dir);
    assert.deepEqual(back.grants, []);
    assert.equal(back.bad, true);
    assert.match(back.reason, /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: one invalid entry in an otherwise-good file is dropped, the rest survive', () => {
  // 一条坏数据不该毁掉整张授权表 —— 否则用户要重新授权所有目录。
  const dir = tmpWs();
  try {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(grant.grantsFilePath(dir), JSON.stringify({
      version: 1,
      grants: [G(), { grantId: 'bogus', grantedBy: 'lead', access: 'admin' }, G({ grantId: 'gr-ok999' })],
    }), 'utf8');
    const back = grant.loadGrants(dir);
    assert.equal(back.grants.length, 2, 'the two valid grants survive');
    assert.equal(back.bad, true, 'the drop is reported, not silent');
    assert.match(back.reason, /1 invalid grant/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: no file yet is an empty table, not an error', () => {
  const dir = tmpWs();
  try {
    const back = grant.loadGrants(dir);
    assert.deepEqual(back.grants, []);
    assert.equal(back.bad, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: the table size is bounded (grants cannot grow without limit)', () => {
  const dir = tmpWs();
  try {
    const many = [];
    for (let i = 0; i < grant.MAX_GRANTS + 1; i += 1) {
      many.push(G({ grantId: `gr-x${i}` }));
    }
    const r = grant.saveGrants(dir, many);
    assert.equal(r.ok, false);
    assert.match(r.reason, /too many grants/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: writes are ATOMIC — the target file is replaced, never appended/truncated in place', () => {
  // 第一性原理：为什么这条测试要看 inode 而不是内容
  //
  //   "崩溃时不损坏"无法在测试里真的模拟（不能杀进程在写的中间）。
  //   但原子写的**可观测特征**是：目标文件是被 replace 的，不是原地覆写。
  //   实测特征就是 inode 变化 —— 直接 fs.writeFileSync 不会改 inode，
  //   而 写临时文件 + rename 会。
  //
  //   变异测试发现原来的断言（内容正确 + 无 .tmp 残留）在"直接写"下也通过，
  //   所以那条测试并没有真的守住原子性。
  const dir = tmpWs();
  try {
    grant.saveGrants(dir, [G()]);
    const file = grant.grantsFilePath(dir);
    const inoBefore = fs.statSync(file).ino;
    grant.saveGrants(dir, [G(), G({ grantId: 'gr-second1' })]);
    const inoAfter = fs.statSync(file).ino;
    assert.notEqual(inoAfter, inoBefore,
      'an atomic write replaces the file (new inode); in-place writes keep the same inode');
    assert.equal(fs.existsSync(`${file}.tmp`), false, 'the temp file must be consumed by the rename');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store: newGrantId produces unique, well-formed ids', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = grant.newGrantId();
    assert.match(id, grant.GRANT_ID_RE);
    assert.equal(seen.has(id), false, 'ids must not collide');
    seen.add(id);
  }
  // 只由小写字母与数字组成（不含路径分隔符、不含大写）
  assert.match(grant.newGrantId(), /^gr-[a-z0-9]{10}$/);
});
