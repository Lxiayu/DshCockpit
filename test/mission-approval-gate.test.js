// test/mission-approval-gate.test.js — 提案-批准闸门（S5）。
//
// 第一性原理：这组测试守的是三个具体漏洞
//
//   危险动作的流程是"模型提议 → 人批准 → 执行"。它有三个容易漏的洞：
//
//   1. 批准的是哪一份？
//      模型提议了 A，人正在读；模型又提取议了 B；人点"批准"——
//      批准必须绑定**人看见的那份内容**的 hash，否则 B 会顶替 A 被执行。
//
//   2. 三天后还能批吗？
//      一份永远有效的提案，会在没人记得的上下文里被执行。要有 TTL。
//
//   3. 重试会变成两张卡片吗？
//      模型重试同一次提议不该生成第二张待批准事项。
//
//   这三条各自对应下面的一组测试。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gate = require('../src/mission/approval-gate.js');

function makeGate(startMs = 1000) {
  let t = startMs;
  const g = gate.createApprovalGate({ now: () => t, ttlMs: 1000 });
  return { g, advance: (ms) => { t += ms; } };
}

test('gate: a proposal starts awaiting review and is NOT executed by proposing', () => {
  const { g } = makeGate();
  const r = g.propose({ kind: 'command.run', payload: { cmd: 'npm test' }, title: '运行 npm test' });
  assert.equal(r.ok, true);
  assert.equal(r.proposal.status, 'awaiting_review');
  assert.equal(g.pending().length, 1);
});

test('gate: an unknown kind is refused (the vocabulary is closed)', () => {
  const { g } = makeGate();
  assert.equal(g.propose({ kind: 'rm-rf-everything' }).ok, false);
  assert.equal(g.propose({}).code, 'UNKNOWN_PROPOSAL_KIND');
});

test('gate: approving with a stale hash is REFUSED — this is the whole point', () => {
  // 漏洞 1：人读的是 A 的 hash，但提案已经变成 B。
  const { g } = makeGate();
  const proposal = g.propose({
    kind: 'command.run', payload: { cmd: 'npm test' },
  }).proposal;
  // 模拟"内容变了、hash 也变了"：用一个不同的 hash 去批准
  const r = g.decide({ id: proposal.id, hash: 'deadbeef', decision: 'approve' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROPOSAL_CHANGED');
  assert.equal(g.get(proposal.id).status, 'awaiting_review',
    'a failed approval must leave the proposal undecided');
});

test('gate: the same content always hashes the same, different content does not', () => {
  const a = gate.proposalHash({ kind: 'command.run', payload: { cmd: 'npm test', env: { A: '1' } } });
  const b = gate.proposalHash({ kind: 'command.run', payload: { env: { A: '1' }, cmd: 'npm test' } });
  assert.equal(a, b, 'key order must not change the hash (stable stringify)');

  const c = gate.proposalHash({ kind: 'command.run', payload: { cmd: 'rm -rf /' } });
  assert.notEqual(a, c);
});

test('gate: approving with the correct hash succeeds exactly once', () => {
  const { g } = makeGate();
  const p = g.propose({ kind: 'file.write', payload: { path: 'a.txt' } }).proposal;
  const r1 = g.decide({ id: p.id, hash: p.hash, decision: 'approve' });
  assert.equal(r1.ok, true);
  assert.equal(r1.proposal.status, 'approved');

  // 再批一次：幂等返回，不改变状态
  const r2 = g.decide({ id: p.id, hash: p.hash, decision: 'deny' });
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyDecided, true);
  assert.equal(r2.proposal.status, 'approved', 'a decided proposal must never flip');
});

test('gate: deny is recorded as denied and cannot later be approved', () => {
  const { g } = makeGate();
  const p = g.propose({ kind: 'message.send', payload: { to: 'x' } }).proposal;
  assert.equal(g.decide({ id: p.id, hash: p.hash, decision: 'deny' }).proposal.status, 'denied');
  assert.equal(g.decide({ id: p.id, hash: p.hash, decision: 'approve' }).proposal.status, 'denied');
});

test('gate: a proposal expires and can no longer be approved', () => {
  // 漏洞 2：三天后翻到旧卡片点批准 = 在没人记得的上下文里执行。
  const { g, advance } = makeGate(1000);
  const p = g.propose({ kind: 'command.run', payload: { cmd: 'deploy' } }).proposal;
  advance(1001); // ttl=1000
  const r = g.decide({ id: p.id, hash: p.hash, decision: 'approve' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROPOSAL_EXPIRED');
  assert.equal(g.get(p.id).status, 'expired');
  assert.equal(g.pending().length, 0, 'expired proposals must leave the pending list');
});

test('gate: expiry is a recorded state, not a computed guess', () => {
  const { g, advance } = makeGate(1000);
  const p = g.propose({ kind: 'command.run', payload: {} }).proposal;
  advance(5000);
  // get() 自己不"推算"，它把状态落下来
  assert.equal(g.get(p.id).status, 'expired');
  // 再次读取仍然是 expired（稳定）
  assert.equal(g.get(p.id).status, 'expired');
});

test('gate: the same idempotency key returns the same proposal (no duplicate cards)', () => {
  // 漏洞 3：模型重试不该让用户看到两张一样的卡片。
  const { g } = makeGate();
  const a = g.propose({ kind: 'task.create', payload: { subject: 'x' }, idempotencyKey: 'k1' });
  const b = g.propose({ kind: 'task.create', payload: { subject: 'x' }, idempotencyKey: 'k1' });
  assert.equal(a.proposal.id, b.proposal.id);
  assert.equal(b.duplicate, true);
  assert.equal(g.size(), 1);
});

test('gate: different idempotency keys produce different proposals', () => {
  const { g } = makeGate();
  const a = g.propose({ kind: 'task.create', payload: {}, idempotencyKey: 'k1' });
  const b = g.propose({ kind: 'task.create', payload: {}, idempotencyKey: 'k2' });
  assert.notEqual(a.proposal.id, b.proposal.id);
  assert.equal(g.size(), 2);
});

test('gate: the proposal title is capped and never carries payload back out', () => {
  // 提案对象本身会进 UI。payload 留在这里是为了执行时用，
  // 但 title 是给人看的那一句，必须短。
  const { g } = makeGate();
  const long = 'x'.repeat(500);
  const p = g.propose({ kind: 'command.run', payload: { cmd: 'a' }, title: long }).proposal;
  assert.equal(p.title.length, 200);
});

test('gate: degenerate input never throws', () => {
  const { g } = makeGate();
  assert.doesNotThrow(() => g.propose());
  assert.doesNotThrow(() => g.decide());
  assert.doesNotThrow(() => g.get('nope'));
  assert.equal(g.get('nope'), null);
  assert.equal(g.decide().code, 'PROPOSAL_NOT_FOUND');
});

test('gate: vocabularies are closed and exported', () => {
  assert.deepEqual([...gate.PROPOSAL_STATES], ['awaiting_review', 'approved', 'denied', 'expired']);
  assert.ok(gate.PROPOSAL_KINDS.includes('command.run'));
  assert.equal(gate.DEFAULT_TTL_MS, 30 * 60 * 1000);
});
