// test/mission-confirm-dispatch-action.test.js — confirmDispatch action 的集成契约。
//
// 第一性原理：这个 action 存在的唯一理由是"填上一条看不见的缝"
//
//   我们没有 remote 写表面（D11），派发 = 发指令让模型自己调工具。
//   "下令成功"与"事情发生"之间隔着模型的自由意志。
//
//   如果这个 action 只能返回"是/否"，它就等于没做事——因为
//   "还没建好"和"永远建不好"在用户看来完全不同。
//   所以它返回四态，并且**必须真的去读投影**，不能靠 turns 之类的间接信号推断。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');

function setup({ team = null, bound = true, clock = () => 5000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-confirmdp-'));
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
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock,
      log: () => {},
      snapshotOf: () => null,
      projectionsOf: async () => ({
        ok: true,
        value: { values: team === null ? {} : { agentTeam: team } },
      }),
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir };
}

function teamWith(tasks) {
  return { members: [{ id: 'm1', name: 'lead', role: 'lead', phase: 'active' }], tasks };
}

test('confirmDispatch: a task carrying our key → confirmed, with a task summary', async () => {
  const KEY = 'k-xyz';
  const { invoke, dir } = setup({
    team: teamWith([{ id: 'task-1', subject: `实现 [${KEY}]`, status: 'pending', ready: true }]),
  });
  try {
    const r = await invoke(null, 'confirmDispatch', { missionId: 'mis-a', dispatchKey: KEY });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'confirmed');
    assert.equal(r.task.id, 'task-1');
    assert.equal(r.task.ready, true);
    // 隐私：不回传 description 正文
    assert.equal(Object.prototype.hasOwnProperty.call(r.task, 'description'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: no matching task → pending, and the wording does NOT say failed', async () => {
  const { invoke, dir } = setup({
    team: teamWith([{ id: 'task-9', subject: '模型自己想的任务', status: 'pending' }]),
  });
  try {
    const r = await invoke(null, 'confirmDispatch', {
      missionId: 'mis-a', dispatchKey: 'k-missing', startedAtMs: 4000,
    });
    assert.equal(r.state, 'pending');
    assert.doesNotMatch(r.description, /失败/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: past the timeout → unconfirmed, never failed', async () => {
  // 说"失败"会让用户重复派发，凭空多出一支团队。
  // clock 必须远超默认 timeout（120s），否则正确的 pending 会被误当成 bug。
  const { invoke, dir } = setup({ team: teamWith([]), clock: () => 200000 });
  try {
    const r = await invoke(null, 'confirmDispatch', {
      missionId: 'mis-a', dispatchKey: 'k-late', startedAtMs: 0,
    });
    assert.equal(r.state, 'unconfirmed');
    assert.doesNotMatch(r.description, /失败/);
    assert.match(r.description, /不要重复派发/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: an unreadable team projection → unconfirmed (not a guess)', async () => {
  // 读不到 ≠ 没有。不能因为读不到就说"没建好"，更不能说"建好了"。
  const { invoke, dir } = setup({ team: null, clock: () => 200000 });
  try {
    const r = await invoke(null, 'confirmDispatch', {
      missionId: 'mis-a', dispatchKey: 'k-x', startedAtMs: 0,
    });
    assert.equal(r.state, 'unconfirmed');
    assert.match(r.reason, /读不到/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: an explicit runtime rejection → rejected', async () => {
  const { invoke, dir } = setup({ team: null });
  try {
    const r = await invoke(null, 'confirmDispatch', {
      missionId: 'mis-a', dispatchKey: 'k-r', promptRejected: true,
    });
    assert.equal(r.state, 'rejected');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: unbound mission still answers honestly', async () => {
  // 没绑定会话就没有团队投影可读——但 action 不该报错。
  // 用超时后的 clock，因为"未绑定"永远不可能确认，最终必然是 unconfirmed。
  const { invoke, dir } = setup({ bound: false, clock: () => 200000 });
  try {
    const r = await invoke(null, 'confirmDispatch', {
      missionId: 'mis-a', dispatchKey: 'k-u', startedAtMs: 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.state, 'unconfirmed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('confirmDispatch: missing dispatchKey is a clear error, not a silent success', async () => {
  const { invoke, dir } = setup({});
  try {
    const r = await invoke(null, 'confirmDispatch', { missionId: 'mis-a' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'DISPATCH_KEY_REQUIRED');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
