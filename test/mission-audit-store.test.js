// test/mission-audit-store.test.js — 干预审计落盘（S6）。
//
// 第一性原理：为什么审计要独立文件，且必须**白名单**落盘
//
//   独立文件：审计不是 Mission 状态。混进 events.jsonl 会让 projection
//   要为它写 no-op 分支，还会污染日志的"永不删除"承诺。
//
//   白名单：审计记录的是"用户做了什么动作"，不是"用户说了什么"。
//   用户的自由文本（消息正文、原因说明）**不能**落盘 —— AGENTS.md §2.4。
//   白名单意味着"没在名单上的一律不写"，将来有人给 entry 加字段
//   也不会意外泄露；黑名单则相反，加字段就等于默认泄露。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/mission/audit-store.js');

function tmpWs() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-')); }

test('audit: an entry round-trips to disk and back', () => {
  const dir = tmpWs();
  try {
    const r = store.appendAudit(dir, {
      action: 'mission.paused', reason: 'user-request', atMs: 1000, missionId: 'mis-a',
    });
    assert.equal(r.ok, true);
    const back = store.readAudit(dir);
    assert.equal(back.total, 1);
    assert.equal(back.entries[0].action, 'mission.paused');
    assert.equal(back.entries[0].missionId, 'mis-a');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: free-text fields are NOT persisted (whitelist, not blacklist)', () => {
  // 这是本文件最重要的一条。
  const dir = tmpWs();
  try {
    store.appendAudit(dir, {
      action: 'member.messaged',
      reason: 'user-request',
      atMs: 1000,
      missionId: 'mis-a',
      memberName: 'coder',
      // 下面这些都是**不该落盘**的：用户内容
      message: '这是不该落盘的消息正文 ABC123',
      note: '自由文本备注',
      prompt: '原始提示词',
      extra: { nested: 'value' },
    });
    const raw = fs.readFileSync(path.join(dir, '.dsh', 'interventions.jsonl'), 'utf8');
    assert.equal(raw.includes('ABC123'), false, 'message body must never reach disk');
    assert.equal(raw.includes('自由文本备注'), false);
    assert.equal(raw.includes('原始提示词'), false);
    // 允许的字段在
    assert.ok(raw.includes('member.messaged'));
    assert.ok(raw.includes('coder'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: an entry without action or atMs is refused (not half-written)', () => {
  const dir = tmpWs();
  try {
    assert.equal(store.appendAudit(dir, { atMs: 1000 }).ok, false);
    assert.equal(store.appendAudit(dir, { action: 'mission.paused' }).ok, false);
    assert.equal(store.appendAudit(dir, null).ok, false);
    assert.equal(store.readAudit(dir).total, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: a corrupted line is skipped and counted, the rest survives', () => {
  // 一行坏了不该让整个审计史消失。
  const dir = tmpWs();
  try {
    store.appendAudit(dir, { action: 'mission.paused', atMs: 1 });
    fs.appendFileSync(path.join(dir, '.dsh', 'interventions.jsonl'), '{this is not json}\n', 'utf8');
    store.appendAudit(dir, { action: 'mission.resumed', atMs: 2 });
    const back = store.readAudit(dir);
    assert.equal(back.entries.length, 2, 'the two valid entries survive');
    assert.equal(back.badLines, 1, 'the corrupt line is reported, not silently swallowed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: no file yet is an empty result, not an error', () => {
  const dir = tmpWs();
  try {
    const back = store.readAudit(dir);
    assert.deepEqual(back.entries, []);
    assert.equal(back.badLines, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: reading respects the limit and returns the NEWEST entries', () => {
  const dir = tmpWs();
  try {
    for (let i = 1; i <= 10; i += 1) store.appendAudit(dir, { action: 'mission.paused', atMs: i });
    const back = store.readAudit(dir, { limit: 3 });
    assert.equal(back.entries.length, 3);
    assert.deepEqual(back.entries.map((e) => e.atMs), [8, 9, 10], 'newest last');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('audit: append never throws even when the workspace is unusable', () => {
  // 审计失败不该让用户的操作失败（他停了团队，不能因为审计写不进去而回滚）。
  assert.doesNotThrow(() => store.appendAudit('/nonexistent/definitely/not/here/x', { action: 'mission.paused', atMs: 1 }));
  assert.doesNotThrow(() => store.appendAudit(null, { action: 'mission.paused', atMs: 1 }));
  assert.equal(store.appendAudit(null, { action: 'mission.paused', atMs: 1 }).ok, false);
});

test('audit: the persisted field list is closed and contains no content fields', () => {
  assert.deepEqual([...store.PERSISTED_FIELDS].sort(),
    ['action', 'atMs', 'memberName', 'missionId', 'reason', 'taskId']);
  for (const forbidden of ['message', 'text', 'note', 'prompt', 'content', 'description']) {
    assert.equal(store.PERSISTED_FIELDS.includes(forbidden), false, `${forbidden} must never be persisted`);
  }
});

test('audit: a VALID-JSON-but-invalid entry is also counted as bad', () => {
  // 变异测试发现的盲区：原来的坏行用例用的是"非法 JSON"，
  // 它走 JSON.parse 的 catch 分支；而"合法 JSON 但字段不合法"
  // 走的是另一条分支（projectForDisk 返回 null）。
  // 两条分支必须分别被测到，否则其中一条可以静默失效。
  const dir = tmpWs();
  try {
    store.appendAudit(dir, { action: 'mission.paused', atMs: 1 });
    // 合法 JSON，但缺 atMs（不可落盘）→ 应该被算作坏行
    fs.appendFileSync(path.join(dir, '.dsh', 'interventions.jsonl'),
      JSON.stringify({ action: 'mission.paused' }) + '\n', 'utf8');
    const back = store.readAudit(dir);
    assert.equal(back.entries.length, 1);
    assert.equal(back.badLines, 1,
      'a structurally-valid JSON line that fails schema must be counted, not silently dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// 轮转（文件只增长是真隐患）
// ---------------------------------------------------------------------------
//
// 第一性原理：为什么轮转，而不是无限增长或直接截断
//
//   审计文件每次干预追加一行。如果不管，它会一直涨 —— 而"我刚才做了什么"
//   这个用途只关心最近一段，老数据只是占磁盘。
//
//   但直接截断也不好：它**删掉**最老的记录，用户翻上一轮工作时就找不到了。
//   轮转把老的挪到 .1，代价有界（最多保留 N 份）。

test('rotation: a file under the limit is left alone', () => {
  const dir = tmpWs();
  try {
    store.appendAudit(dir, { action: 'mission.paused', atMs: 1 });
    const r = store.rotateIfNeeded(path.join(dir, '.dsh', 'interventions.jsonl'), { maxBytes: 1024 * 1024 });
    assert.equal(r.rotated, false);
    assert.equal(fs.existsSync(path.join(dir, '.dsh', 'interventions.jsonl.1')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rotation: an oversized file is moved to .1 and writing continues in a fresh file', () => {
  const dir = tmpWs();
  const file = path.join(dir, '.dsh', 'interventions.jsonl');
  try {
    // 用很小的阈值触发轮转（不必写 512KB）。
    // 注意：阈值必须小于**单条记录**大小才会触发 —— 一条约 37 字节，
    // 所以用 30。早期写 200 时四条才 148 字节，从未触发（测试自己拿到过这个教训）。
    for (let i = 1; i <= 4; i += 1) {
      store.appendAudit(dir, { action: 'mission.paused', atMs: i }, { maxBytes: 30 });
    }
    assert.equal(fs.existsSync(`${file}.1`), true, 'the old file must be preserved as .1');
    // 轮转后新文件里只剩最近的记录（阈值 30 小于单条 37 字节，所以几乎每条都触发）
    const back = store.readAudit(dir);
    assert.ok(back.total >= 1, 'writing must continue after rotation');
    // 老记录没有消失：它们被挪进了 .1 / .2，而不是被删
    const backups = [`${file}.1`, `${file}.2`]
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('');
    assert.match(backups, /"atMs":\d/,
      'rotated files must still contain real entries (rotation moves, it does not delete)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rotation: only ROTATION_KEEP backups survive (disk usage stays bounded)', () => {
  // 第一性原理：轮转必须有界，否则"防止无限增长"的措施本身会无限增长。
  // 变异测试发现的盲区：原来的断言只检查 ".3 不存在"，但 .3 本来就不会被创建
  // （我们从 .2 往前挪），删不删最老备份都能通过。所以改为**数备份个数**。
  const dir = tmpWs();
  const base = path.join(dir, '.dsh', 'interventions.jsonl');
  try {
    for (let i = 1; i <= 40; i += 1) {
      store.appendAudit(dir, { action: 'mission.paused', atMs: i }, { maxBytes: 30 });
    }
    const backups = fs.readdirSync(path.join(dir, '.dsh'))
      .filter((f) => f.startsWith('interventions.jsonl.'));
    assert.equal(backups.length, store.ROTATION_KEEP,
      `expected exactly ${store.ROTATION_KEEP} rotated backups, found ${backups.length}: ${backups.join(', ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rotation: a rotation failure does not block the audit write', () => {
  // 轮转是维护动作，不该让用户的操作失败。
  const dir = tmpWs();
  try {
    // 传一个不可能的 maxBytes 让 statSync 路径异常也不该抛
    assert.doesNotThrow(() => {
      store.appendAudit(dir, { action: 'mission.paused', atMs: 1 }, { maxBytes: -5 });
    });
    const back = store.readAudit(dir);
    assert.equal(back.total, 1, 'the entry is still written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
