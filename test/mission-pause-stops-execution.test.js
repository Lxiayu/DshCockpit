// test/mission-pause-stops-execution.test.js — 暂停必须真的刹车（S6）。
//
// 第一性原理：这是本轮修的一个真实缺陷
//
//   在此之前 updateStatus 只改 Mission 的状态字段，**不动正在跑的会话**。
//   用户点"暂停"，界面显示 paused，团队却还在写文件。
//
//   这比没有暂停按钮更糟：他以为自己已经安全了。
//   状态字段不能替代刹车。
//
//   所以这里锁三件事：
//     1. paused / abandoned 会真的调用 cancelSession
//     2. cancel 失败时**如实回报**（stopped='cancel-failed'），不假装成功
//     3. active / completed 不会误停正在跑的执行
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');
const { createMissionStore } = require('../src/mission/store.js');

function setup({ cancel = async () => ({ ok: true }), bound = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pause-'));
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
  const calls = [];
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 5000,
      log: () => {},
      snapshotOf: () => null,
      cancelSession: async (sid) => { calls.push(sid); return cancel(sid); },
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, calls };
}

test('pause: changing status to paused REALLY cancels the running session', async () => {
  const { invoke, dir, calls } = setup();
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'paused');
    assert.equal(r.stopped, 'cancelled', 'the UI must be told the brake was applied');
    assert.deepEqual(calls, ['session-x'], 'cancelSession must be called with the bound session');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('abandon: also stops execution (it is a stronger pause)', async () => {
  const { invoke, dir, calls } = setup();
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'abandoned' });
    assert.equal(r.stopped, 'cancelled');
    assert.equal(calls.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: a FAILED cancel is reported honestly, never as success', async () => {
  // 这是最重要的一条：界面不能因为"状态改了"就宣布"已停止"。
  const { invoke, dir } = setup({ cancel: async () => ({ ok: false, reason: 'runtime offline' }) });
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    assert.equal(r.ok, true, 'the status change itself still succeeds');
    assert.equal(r.stopped, 'cancel-failed', 'but the brake failure must be visible');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: no cancel wiring is reported as "not-wired", not silently ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pause-nw-'));
  try {
    const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s.append('mission.created', {
      missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
      workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
    });
    fs.mkdirSync(path.join(dir, '.dsh'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.dsh', 'mission-sessions.json'),
      JSON.stringify({ version: 1, sessions: { 'mis-a': { sessionId: 'session-x', boundAtMs: 1 } } }),
    );
    const handlers = new Map();
    registerMissionIpc(
      { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
      { workspaceDirOf: () => dir, clock: () => 5000, log: () => {}, snapshotOf: () => null },
    );
    const r = await handlers.get('mission:invoke')(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    assert.equal(r.stopped, 'not-wired',
      'without cancel wiring the UI must know execution may continue');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: an unbound mission has nothing to stop (not a failure)', async () => {
  const { invoke, dir, calls } = setup({ bound: false });
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    assert.equal(r.stopped, 'not-running');
    assert.equal(calls.length, 0, 'nothing bound → nothing to cancel');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: resuming to active does NOT cancel anything', async () => {
  // 反向保护：把"恢复"也当成刹车会打断用户刚启动的工作。
  const { invoke, dir, calls } = setup();
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'active' });
    assert.equal(r.stopped, null);
    assert.equal(calls.length, 0, 'active must never trigger a cancel');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: completing a mission does not cancel (work finished normally)', async () => {
  const { invoke, dir, calls } = setup();
  try {
    const r = await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'completed' });
    assert.equal(r.stopped, null);
    assert.equal(calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pause: the intervention is audited (and readable back)', async () => {
  const { invoke, dir } = setup();
  try {
    await invoke(null, 'updateStatus', { missionId: 'mis-a', to: 'paused' });
    const h = await invoke(null, 'interventionHistory', { missionId: 'mis-a' });
    assert.equal(h.ok, true);
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0].action, 'mission.paused');
    assert.equal(h.entries[0].reason, 'user-request');
    assert.match(h.entries[0].description, /暂停了团队/);
    // 隐私：审计条目里不许出现任何内容字段
    assert.equal(Object.prototype.hasOwnProperty.call(h.entries[0], 'text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(h.entries[0], 'note'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
