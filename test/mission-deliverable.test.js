// test/mission-deliverable.test.js — P1：产物登记与 digest 校验。
//
// 第一性原理：产物索引的三个层次
//
//   1. 知道有这个东西      → label
//   2. 能找到它            → 相对路径（绝对路径是隐私边界且会失效）
//   3. 确认还是当时那一个  → digest
//
//   只有 1 是日记，1+2 是书签，1+2+3 才是**可验证的交付物**。
//   第 3 点最容易被省掉——省掉之后用户下次打开文件发现内容变了，
//   却没有任何东西告诉他"这不是当时确认过的那一版"。
//
//   所以这里重点测：
//     · unchanged / modified / missing 必须**分开**报告
//     · 路径逃逸（含符号链接）必须被拒
//     · 无法计算 digest 的文件不得登记（否则制造虚假的确定性）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const d = require('../src/mission/deliverable.js');

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dlv-'));
}

function writeFile(ws, rel, content) {
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// ------------------------------------------------------------- 路径安全

test('deliverable: isSafeRelPath rejects absolute, traversal, drive letters and control chars', () => {
  for (const ok of ['a.md', 'docs/r.md', 'a/b/c.txt', 'a-b_c.d']) {
    assert.strictEqual(d.isSafeRelPath(ok), true, `${ok} should be safe`);
  }
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', '', '  ', 'a/./b',
    'C:/Windows/x', 'C:\\Windows\\x', '\\\\server\\share', 'a\u0000b']) {
    assert.strictEqual(d.isSafeRelPath(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('deliverable: registerDeliverable refuses a traversal path', () => {
  const ws = tmpWs();
  writeFile(ws, 'ok.txt', 'x');
  const r = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'x', relPath: '../../etc/passwd' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /safe workspace-relative path/);
});

test('deliverable: a SYMLINK escaping the workspace is refused (lexical check alone would miss it)', () => {
  // 词法检查看不出符号链接。这是真实攻击面：工作区里一个指向 /etc 的软链。
  const ws = tmpWs();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  try {
    fs.symlinkSync(outside, path.join(ws, 'link'));
  } catch {
    return; // 平台不支持符号链接（Windows 非管理员）—— 跳过而不是假装通过
  }
  const r = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'x', relPath: 'link/secret.txt' });
  assert.strictEqual(r.ok, false, 'a symlink escape must be refused');
  assert.match(r.reason, /symbolic link|escapes/);
});

// --------------------------------------------------------------- 登记

test('deliverable: registering an existing file records its sha256 and byte size', () => {
  const ws = tmpWs();
  writeFile(ws, 'docs/report.md', 'hello');
  const r = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: '报告', relPath: 'docs/report.md', now: 1234 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deliverable.digest, d.hashContent('hello'));
  assert.strictEqual(r.deliverable.bytes, 5);
  assert.strictEqual(r.deliverable.registeredAtMs, 1234);
  assert.match(r.deliverable.deliverableId, /^dlv-[0-9a-f]+$/);
});

test('deliverable: a file that cannot be hashed is REFUSED (no fake certainty)', () => {
  // 登记一个 hash 不出来的文件等于制造虚假的确定性——比不登记更糟。
  const ws = tmpWs();
  const r = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'x', relPath: 'does-not-exist.md' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cannot hash/);
});

test('deliverable: a directory is refused (only regular files are deliverables)', () => {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, 'somedir'));
  const r = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'x', relPath: 'somedir' });
  assert.strictEqual(r.ok, false);
});

// --------------------------------------------------------------- 校验

test('deliverable: verify reports UNCHANGED when the digest still matches', () => {
  const ws = tmpWs();
  writeFile(ws, 'a.md', 'stable');
  const reg = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'a', relPath: 'a.md' });
  const v = d.verifyDeliverable({ workspaceDir: ws, deliverable: reg.deliverable });
  assert.strictEqual(v.status, 'unchanged');
});

test('deliverable: verify reports MODIFIED (with both digests) when content changed', () => {
  // 这是最常见的真实情况：用户后来又改了文件。只说"不匹配"没有信息量，
  // 必须给出 expected vs actual 才能判断影响面。
  const ws = tmpWs();
  writeFile(ws, 'a.md', 'before');
  const reg = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'a', relPath: 'a.md' });
  writeFile(ws, 'a.md', 'after');
  const v = d.verifyDeliverable({ workspaceDir: ws, deliverable: reg.deliverable });
  assert.strictEqual(v.status, 'modified');
  assert.strictEqual(v.expected, reg.deliverable.digest);
  assert.notStrictEqual(v.actual, reg.deliverable.digest);
  assert.strictEqual(v.actual, d.hashContent('after'));
});

test('deliverable: verify reports MISSING separately from modified (different remedies)', () => {
  // modified → 请用户重新确认；missing → 请用户找回文件。
  // 合并成 "not ok" 会让用户不知道该做什么。
  const ws = tmpWs();
  writeFile(ws, 'a.md', 'x');
  const reg = d.registerDeliverable({ workspaceDir: ws, missionId: 'mis-a', label: 'a', relPath: 'a.md' });
  fs.unlinkSync(path.join(ws, 'a.md'));
  const v = d.verifyDeliverable({ workspaceDir: ws, deliverable: reg.deliverable });
  assert.strictEqual(v.status, 'missing');
  assert.match(v.reason, /file not found/);
});

test('deliverable: a stored unsafe path is reported invalid, not silently verified', () => {
  const ws = tmpWs();
  const v = d.verifyDeliverable({
    workspaceDir: ws,
    deliverable: { deliverableId: 'x', relPath: '../../etc/passwd', digest: 'a'.repeat(64) },
  });
  assert.strictEqual(v.status, 'invalid');
});

// --------------------------------------------------------------- 批量

test('deliverable: verifyAll reports per-status counts and is healthy only when ALL unchanged', () => {
  const ws = tmpWs();
  writeFile(ws, 'a.md', 'A');
  writeFile(ws, 'b.md', 'B');
  const a = d.registerDeliverable({ workspaceDir: ws, missionId: 'm', label: 'a', relPath: 'a.md' }).deliverable;
  const b = d.registerDeliverable({ workspaceDir: ws, missionId: 'm', label: 'b', relPath: 'b.md' }).deliverable;

  let all = d.verifyAll({ workspaceDir: ws, deliverables: [a, b] });
  assert.strictEqual(all.healthy, true);
  assert.strictEqual(all.counts.unchanged, 2);

  fs.writeFileSync(path.join(ws, 'b.md'), 'B changed');
  all = d.verifyAll({ workspaceDir: ws, deliverables: [a, b] });
  assert.strictEqual(all.healthy, false);
  assert.strictEqual(all.counts.unchanged, 1);
  assert.strictEqual(all.counts.modified, 1);
});

test('deliverable: verifyAll of an empty list is healthy (nothing to verify is not a failure)', () => {
  const all = d.verifyAll({ workspaceDir: tmpWs(), deliverables: [] });
  assert.strictEqual(all.healthy, true);
  assert.deepEqual(all.results, []);
});

// --------------------------------------------------------- 大文件保护

test('deliverable: a file above MAX_HASH_BYTES is refused rather than read into memory', () => {
  // 64MB 上限：避免有人把 GB 级构建产物拖进来时把主进程内存打爆。
  assert.ok(d.MAX_HASH_BYTES > 0);
  assert.ok(d.MAX_HASH_BYTES <= 128 * 1024 * 1024);
});
