// test/mission-shared-context-entities.test.js — Finding / Assumption / Evidence
//
// 第一性原理：为什么这三个实体必须存在
//
//   Decision 只记"决定了什么"，记不住"为什么这么决定"。
//     · Finding    = 我们发现了什么   → 团队积累的实体
//     · Assumption = 暂时假设什么     → 未来会爆的地雷
//     · Evidence   = 凭什么相信       → 可信度的来源
//
//   没有它们，"跨会话连续性"只完成了 1/3。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schema = require('../src/mission/schema.js');
const { registerMissionIpc } = require('../src/ipc-mission.js');

/** 起一个真实 store 的 IPC 层（纯 Node，不碰 Electron）。 */
function makeIpc() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-entities-'));
  let handler = null;
  registerMissionIpc({ handle: (ch, fn) => { handler = fn; } }, {
    workspaceDirOf: () => ws, snapshotOf: () => null, log: () => {},
  });
  return { ws, call: (a, p) => handler(null, a, p) };
}

test('schema: the three entity types are registered', () => {
  for (const t of ['finding', 'assumption', 'evidence']) {
    assert.ok(schema.ENTITY_TYPES.includes(t), `${t} must be an entity type`);
  }
});

// ============================================ Finding

test('finding: a valid finding passes', () => {
  const r = schema.validateFinding({
    findingId: 'fnd-1', missionId: 'mis-a', text: 'X 会崩',
    status: 'unverified', confidence: 'medium', foundAtMs: 1, foundBy: 'model',
  });
  assert.deepStrictEqual(r.errors, []);
});

test('finding: confidence uses three levels, never fake precision', () => {
  // "73% 置信"是虚假精确——三档就够，且可解释。
  const bad = schema.validateFinding({
    findingId: 'fnd-1', missionId: 'mis-a', text: 'x',
    status: 'unverified', confidence: 73, foundAtMs: 1, foundBy: 'model',
  });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.errors.join(), /confidence must be one of low\|medium\|high/);
});

// ============================================ Assumption

test('assumption: a violated assumption MUST say why', () => {
  // 这是假设最重要的时刻：它被推翻了。没有理由就无法追溯。
  const r = schema.validateAssumption({
    assumptionId: 'asm-1', missionId: 'mis-a', text: '用户先登录',
    status: 'violated', assumedAtMs: 1, assumedBy: 'user',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /must say why/);
});

test('assumption: expiresAtMs cannot be before assumedAtMs', () => {
  const r = schema.validateAssumption({
    assumptionId: 'asm-1', missionId: 'mis-a', text: 'x', status: 'holding',
    assumedAtMs: 1000, assumedBy: 'user', expiresAtMs: 500,
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /must not be before/);
});

test('assumption: expiry is an EXPLICIT status, not derived from time', () => {
  // 关键设计：不靠"时间过了就自动过期"——那是推断，不是事实。
  assert.ok(schema.ASSUMPTION_STATUSES.includes('expired'),
    'expired must be a status the team can SET, not something the UI guesses');
});

// ============================================ Evidence

test('evidence: ref must be RELATIVE (absolute paths are a privacy boundary)', () => {
  const r = schema.validateEvidence({
    evidenceId: 'evd-1', missionId: 'mis-a', kind: 'file',
    ref: '/Users/someone/secret.md', claim: 'c', recordedAtMs: 1, recordedBy: 'user',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /privacy boundary/);
});

test('evidence: Windows absolute paths are rejected too', () => {
  const r = schema.validateEvidence({
    evidenceId: 'evd-1', missionId: 'mis-a', kind: 'file',
    ref: 'C:\\Users\\secret.md', claim: 'c', recordedAtMs: 1, recordedBy: 'user',
  });
  assert.strictEqual(r.ok, false);
});

test('evidence: a claim is REQUIRED (a bare link supports nothing)', () => {
  const r = schema.validateEvidence({
    evidenceId: 'evd-1', missionId: 'mis-a', kind: 'url',
    ref: 'https://example.com', recordedAtMs: 1, recordedBy: 'user',
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(), /evidence without a claim/);
});

// ============================================ 端到端

test('ipc: all three can be recorded and read back through a real store', async () => {
  const { call } = makeIpc();
  const c = await call('create', { title: 'T', intent: 'I', workspaceId: 'w1' });
  const mid = c.missionId;

  const f = await call('recordFinding', { missionId: mid, text: 'X 会崩', confidence: 'high' });
  assert.strictEqual(f.ok, true);
  const a = await call('recordAssumption', { missionId: mid, text: '用户先登录', verifyBy: '看日志' });
  assert.strictEqual(a.ok, true);
  const e = await call('recordEvidence', {
    missionId: mid, kind: 'commit', ref: 'abc123', claim: '修复了崩溃',
    targetKind: 'finding', targetId: f.findingId,
  });
  assert.strictEqual(e.ok, true);

  const v = await call('get', { missionId: mid });
  assert.strictEqual(v.view.findings.length, 1);
  assert.strictEqual(v.view.assumptions.length, 1);
  assert.strictEqual(v.view.evidences.length, 1);
  // 反向关联：证据挂到 finding 上
  assert.deepStrictEqual(v.view.findings[0].evidenceIds, [e.evidenceId]);
});

test('ipc: refuting a finding without a reason is REFUSED', async () => {
  const { call } = makeIpc();
  const c = await call('create', { title: 'T', intent: 'I', workspaceId: 'w1' });
  const f = await call('recordFinding', { missionId: c.missionId, text: 'X' });
  const r = await call('updateFindingStatus', { findingId: f.findingId, to: 'refuted' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'REFUTED_REASON_REQUIRED');
});

test('ipc: violating an assumption without a reason is REFUSED', async () => {
  const { call } = makeIpc();
  const c = await call('create', { title: 'T', intent: 'I', workspaceId: 'w1' });
  const a = await call('recordAssumption', { missionId: c.missionId, text: 'X' });
  const r = await call('updateAssumptionStatus', { assumptionId: a.assumptionId, to: 'violated' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'VIOLATED_REASON_REQUIRED');
});

test('ipc: the model cannot forge a user-authored finding', async () => {
  // 与 decision 同规则：来源未声明时按"模型"处理，不冒充用户结论。
  const { call } = makeIpc();
  const c = await call('create', { title: 'T', intent: 'I', workspaceId: 'w1' });
  const f = await call('recordFinding', { missionId: c.missionId, text: 'X' });
  const v = await call('get', { missionId: c.missionId });
  assert.strictEqual(v.view.findings[0].foundBy, 'model');
  assert.strictEqual(v.view.findings[0].findingId, f.findingId);
});

test('ipc: evidence with an absolute path never reaches the store', async () => {
  const { call } = makeIpc();
  const c = await call('create', { title: 'T', intent: 'I', workspaceId: 'w1' });
  const r = await call('recordEvidence', {
    missionId: c.missionId, kind: 'file', ref: '/etc/passwd', claim: 'x',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'EVIDENCE_INVALID');
  const v = await call('get', { missionId: c.missionId });
  assert.strictEqual(v.view.evidences.length, 0);
});
