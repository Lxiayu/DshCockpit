// test/mission-rewrite-task.test.js — 改写/重分配团队任务（S6）。
//
// 第一性原理：为什么任务修改必须带 expectedRevision
//
//   S0 实测（D11）：agent-team 包只有 index.js + types，**没有 remote 表面**。
//   任务修改只能经 Lead 调 team_task_update。U-4 实测确认：
//   过期 revision 会被拒绝，状态完全不变。
//
//   用户看右栏读到的是**某个时刻**的任务状态。等他填好新内容点提交，
//   中间可能已过几秒 —— 成员可能已经改过。不带 revision 的话，
//   **用户的修改会静默覆盖成员的修改**，而没人知道。
//
//   所以：把 revision 写进指令，过期就让官方拒绝。那是正确行为，不是错误。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');

function setup({ bound = true, promptResult = { ok: true } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rwtask-'));
  const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
  s.append('mission.created', {
    missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
    workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
  });
  if (bound) {
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dsh', 'mission-sessions.json'),
      JSON.stringify({ version: 1, sessions: { 'mis-a': { sessionId: 'session-x', boundAtMs: 1 } } }),
    );
  }
  const prompts = [];
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir, clock: () => 5000, log: () => {},
      snapshotOf: () => null,
      promptSession: async (sid, text) => { prompts.push({ sid, text }); return promptResult; },
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, prompts };
}

test('rewriteTask: the expectedRevision is carried into the instruction (CAS)', async () => {
  const { invoke, dir, prompts } = setup();
  try {
    const r = await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'edit', taskId: 'task-1',
      expectedRevision: 7, subject: '新标题',
    });
    assert.equal(r.ok, true);
    assert.match(prompts[0].text, /team_task_update/);
    assert.match(prompts[0].text, /task-1/);
    assert.match(prompts[0].text, /expectedRevision: 7/,
      'the revision must be explicit — otherwise the user edit silently overwrites a member edit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: it explicitly tells the Lead NOT to retry on a stale revision', async () => {
  // 自动重试 = 替用户决定"谁赢"，那是产品越权。
  const { invoke, dir, prompts } = setup();
  try {
    await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'edit', taskId: 'task-1',
      expectedRevision: 7, subject: '新标题',
    });
    assert.match(prompts[0].text, /不要重试|已被别人改过/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: reassign carries the owner and says not to touch content', async () => {
  const { invoke, dir, prompts } = setup();
  try {
    const r = await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'reassign', taskId: 'task-2', expectedRevision: 3, owner: 'coder',
    });
    assert.equal(r.ok, true);
    assert.match(prompts[0].text, /reassign/);
    assert.match(prompts[0].text, /coder/);
    assert.match(prompts[0].text, /不要改写任务内容/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: a missing revision is stated as "use the latest you read", not guessed', async () => {
  const { invoke, dir, prompts } = setup();
  try {
    await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'edit', taskId: 'task-1', subject: 'x',
    });
    assert.match(prompts[0].text, /用你读到的最新值/,
      'without a revision we must not fabricate a number');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: the audit records the action but NEVER the old/new text', async () => {
  // 隐私铁律：审计记"改了什么动作"，不记"改成了什么内容"。
  const { invoke, dir } = setup();
  const secret = '这是不该出现在审计里的新描述 SECRET456';
  try {
    await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'edit', taskId: 'task-1',
      expectedRevision: 1, description: secret,
    });
    const h = await invoke(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].action, 'task.rewritten');
    assert.equal(h.entries[0].taskId, 'task-1');
    assert.equal(JSON.stringify(h).includes('SECRET456'), false,
      'the description text must never reach the audit');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: reassign audits as task.reassigned (distinct action)', async () => {
  const { invoke, dir } = setup();
  try {
    await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'reassign', taskId: 'task-2', owner: 'coder',
    });
    const h = await invoke(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(h.entries[0].action, 'task.reassigned');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: degraded paths fail clearly', async () => {
  const { invoke, dir } = setup({ bound: false });
  try {
    assert.equal((await invoke(null, 'rewriteTask', { missionId: 'mis-a', kind: 'nuke', taskId: 't' })).code, 'TASK_REWRITE_KIND_INVALID');
    assert.equal((await invoke(null, 'rewriteTask', { missionId: 'mis-a', kind: 'edit', taskId: '' })).code, 'TASK_ID_REQUIRED');
    assert.equal((await invoke(null, 'rewriteTask', { missionId: 'mis-a', kind: 'edit', taskId: 't' })).code, 'TASK_EDIT_EMPTY');
    assert.equal((await invoke(null, 'rewriteTask', { missionId: 'mis-a', kind: 'reassign', taskId: 't' })).code, 'TASK_OWNER_REQUIRED');
    assert.equal((await invoke(null, 'rewriteTask', { missionId: 'mis-a', kind: 'edit', taskId: 't', subject: 'x' })).code, 'SESSION_NOT_BOUND');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rewriteTask: a rejected prompt is a failure, not a soft success', async () => {
  const { invoke, dir } = setup({ promptResult: { ok: false, reason: 'runtime busy' } });
  try {
    const r = await invoke(null, 'rewriteTask', {
      missionId: 'mis-a', kind: 'edit', taskId: 't', subject: 'x',
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PROMPT_FAILED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
