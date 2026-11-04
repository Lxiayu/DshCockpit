// test/mission-save-contract.test.js — 派发合同保存（D3）。
//
// 第一性原理：为什么合同要先存再派
//
//   直觉做法：面板填完直接发 prompt。但那样"这次到底要求做到什么"
//   只存在于 prompt 文本里 —— 而 prompt 不进事实链（隐私规则），
//   于是事后无法回答"当初答应做什么"。
//
//   所以合同先作为实体存进 Mission，派发时再从它渲染指令，
//   验收标准也从合同来，而不是从 Agent 的自述来。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');
const grantModule = require('../src/mission/grant.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-'));
  const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
  s.append('mission.created', {
    missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
    workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
  });
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    { workspaceDirOf: () => dir, clock: () => 5000, log: () => {}, snapshotOf: () => null },
  );
  // ⚠️ 必须每次重新打开 store：setup 里那个实例是**写入前**的状态，
  //    它的 projection 不会自动看到后面 append 的事件。
  //    早期测试直接用 s 读，导致四条断言全红 —— 而代码本身是对的。
  const reopen = () => createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
  return { invoke: handlers.get('mission:invoke'), dir, store: s, view: () => reopen() };
}

function ACC(over = {}) {
  return { id: 'a1', text: 'npm test 全绿', kind: 'command', command: 'npm test', ...over };
}

test('contract: a valid contract is saved and readable from missionView', async () => {
  const { invoke, dir, view } = setup();
  try {
    const r = await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: { acceptance: [ACC()], constraints: [{ text: '不改官方代码' }] },
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.contract.status, 'draft');

    const mv = view().missionView('mis-a');
    assert.ok(mv.mission.contract, 'the contract must be persisted on the mission');
    assert.equal(mv.mission.contract.acceptance[0].command, 'npm test');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: an EMPTY acceptance list is refused (cannot decide when work is done)', async () => {
  // 「一条都没有」不是"还没填"，而是"这份合同无法判定完成"。
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'CONTRACT_INVALID');
    assert.match(r.reason, /acceptance/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: acceptance kind=command REQUIRES a command (a kind alone is not a test)', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: { acceptance: [{ id: 'a1', text: '通过', kind: 'command' }] },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /command is required/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: a grant reference must point at a REAL, ACTIVE grant', async () => {
  // 指向不存在的授权，派发时才发现就太晚了 —— 那时用户已以为一切就绪。
  const { invoke, dir } = setup();
  try {
    const missing = await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [ACC()], grantId: 'gr-nope' },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'GRANT_NOT_FOUND');

    // 建一条再撤销，然后尝试引用
    const created = await invoke(null, 'createGrant', { access: 'write' });
    await invoke(null, 'revokeGrant', { grantId: created.grant.grantId });
    const revoked = await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: { acceptance: [ACC()], grantId: created.grant.grantId },
    });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.code, 'GRANT_REVOKED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: an ACTIVE grant reference is accepted', async () => {
  const { invoke, dir } = setup();
  try {
    const created = await invoke(null, 'createGrant', { access: 'write' });
    const r = await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: { acceptance: [ACC()], grantId: created.grant.grantId },
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.contract.grantId, created.grant.grantId);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: the contract NEVER carries a directory path (privacy §2.4)', async () => {
  // 合同只存 grantId 引用。目录只活在 Grant 表里。
  const { invoke, dir, view } = setup();
  try {
    const created = await invoke(null, 'createGrant', { access: 'write' });
    await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: {
        acceptance: [ACC()],
        grantId: created.grant.grantId,
        workspaceDir: '/Users/xia/secret/path',  // 面板误传的字段
      },
    });
    const persisted = view().missionView('mis-a').mission.contract;
    assert.equal(Object.prototype.hasOwnProperty.call(persisted, 'workspaceDir'), false,
      'unknown fields must be dropped, not persisted');
    assert.equal(JSON.stringify(persisted).includes('/Users/xia/secret'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: saving twice REPLACES the contract (drafts are edited, not versioned)', async () => {
  const { invoke, dir, view } = setup();
  try {
    await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [ACC({ text: '第一版' })] },
    });
    await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [ACC({ text: '第二版' })] },
    });
    const c = view().missionView('mis-a').mission.contract;
    assert.equal(c.acceptance[0].text, '第二版');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: budget and maxMembers survive the round trip', async () => {
  const { invoke, dir, view } = setup();
  try {
    await invoke(null, 'saveContract', {
      missionId: 'mis-a',
      contract: {
        acceptance: [ACC()],
        budget: { maxTokens: 50000 },
        maxMembers: 3,
      },
    });
    const c = view().missionView('mis-a').mission.contract;
    assert.equal(c.budget.maxTokens, 50000);
    assert.equal(c.maxMembers, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: a negative budget is refused (0 is allowed, negative is not)', async () => {
  const { invoke, dir } = setup();
  try {
    const neg = await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [ACC()], budget: { maxTokens: -1 } },
    });
    assert.equal(neg.ok, false);
    const zero = await invoke(null, 'saveContract', {
      missionId: 'mis-a', contract: { acceptance: [ACC()], budget: { maxTokens: 0 } },
    });
    assert.equal(zero.ok, true, 'zero means "spend nothing" — a legitimate limit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('contract: a missing mission fails clearly', async () => {
  const { invoke, dir } = setup();
  try {
    const r = await invoke(null, 'saveContract', {
      missionId: 'mis-none', contract: { acceptance: [ACC()] },
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'MISSION_NOT_FOUND');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
