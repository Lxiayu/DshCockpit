// test/mission-projections-cache.test.js — 投影的短期缓存。
//
// 第一性原理：为什么需要缓存，以及为什么 TTL 必须很短
//
//   右栏轮询每 4 秒一次，一轮里调用四个 action：
//     workStatus / attention / sessionProjections / sinceLastSeen
//   而它们**都需要同一份团队投影**。不缓存就是一轮向运行时请求 4 次。
//   实测（修复前）：一轮 4 次 → 每分钟 60 次，其中 45 次是纯重复。
//
//   TTL 取 1500ms 是刻意的：
//     · 远小于轮询间隔（4s）→ **不会让数据变陈旧**
//     · 大到足以覆盖"同一轮里的四次调用"（几乎同时发出）
//   换句话说，它消掉的是**同一时刻的重复**，不是"延后读到的数据"。
//
//   这与本项目"不让界面显示过期状态"的原则不冲突：
//   我们消的是并发重复，不是把旧数据当新数据用。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function setup({ clockStart = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cache-'));
  const handlers = new Map();
  const state = { calls: 0, now: clockStart };
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => state.now,
      log: () => {},
      snapshotOf: () => null,
      ensureSession: async () => ({ ok: true, sessionId: 'sess-1' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => {
        state.calls += 1;
        return { ok: true, value: { values: { agentTeam: { members: [], tasks: [] } } } };
      },
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, state };
}

async function pollRound(invoke, missionId) {
  await invoke(null, 'workStatus', { missionId });
  await invoke(null, 'attention', { missionId });
  await invoke(null, 'sessionProjections', { missionId });
  await invoke(null, 'sinceLastSeen', { missionId });
}

test('cache: one poll round hits the runtime ONCE, not four times', async () => {
  const { invoke, dir, state } = setup();
  try {
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 'x' });
    state.calls = 0;
    await pollRound(invoke, c.missionId);
    assert.equal(state.calls, 1,
      `a single poll round must share one projection fetch, got ${state.calls}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: an empty sessionId resolves to the bound session (same cache key)', async () => {
  // 实测踩到的坑：sessionProjections 不传 id 时用 '' 当键，
  // 而 workStatus 传绑定会话 id —— 两个键，于是请求两次。
  const { invoke, dir, state } = setup();
  try {
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 'x' });
    state.calls = 0;
    // 不传 sessionId —— 归一化需要 missionId 才能找到绑定会话，
    // 这正是右栏的真实调用方式（它总知道自己看的是哪个 Mission）。
    await invoke(null, 'sessionProjections', { missionId: c.missionId });
    await invoke(null, 'workStatus', { missionId: c.missionId });
    assert.equal(state.calls, 1,
      'omitting the sessionId must resolve to the bound session, not a separate key');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: it EXPIRES — the next poll round sees fresh data', async () => {
  // 这是最关键的一条：缓存不能跨轮。
  // 若 TTL 比轮询间隔长，界面就会显示 4 秒前的数据 —— 那正是我们前几轮修掉的问题。
  const { invoke, dir, state } = setup();
  try {
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 'x' });
    state.calls = 0;
    await pollRound(invoke, c.missionId);
    assert.equal(state.calls, 1);

    // 时间推进到下一轮（4 秒后）
    state.now += 4000;
    await pollRound(invoke, c.missionId);
    assert.equal(state.calls, 2, 'the next round must NOT be served from the old cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache: the TTL is shorter than the poll interval', () => {
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc-mission.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');
  const ttl = Number((ipc.match(/const PROJECTIONS_TTL_MS = (\d+);/) || [])[1]);
  const pollMs = Number((html.match(/const PROGRESS_POLL_MS = (\d+);/) || [])[1]);
  assert.ok(Number.isFinite(ttl) && Number.isFinite(pollMs), 'both constants must exist');
  assert.ok(ttl < pollMs,
    `TTL (${ttl}ms) must be shorter than the poll interval (${pollMs}ms), `
    + 'otherwise the rail would serve stale data by design');
});

test('cache: a failing projection is not cached as a poison value', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cache-'));
  const handlers = new Map();
  let calls = 0;
  let now = 1_000_000;
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir, clock: () => now, log: () => {}, snapshotOf: () => null,
      ensureSession: async () => ({ ok: true, sessionId: 'sess-1' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => {
        calls += 1;
        if (calls === 1) throw new Error('runtime hiccup');
        return { ok: true, value: { values: { agentTeam: { members: [], tasks: [] } } } };
      },
    },
  );
  try {
    const invoke = handlers.get('mission:invoke');
    const c = await invoke(null, 'create', { title: 't', intent: 'i' });
    await invoke(null, 'startWork', { missionId: c.missionId, task: 'x' });
    calls = 0;
    // 第一次失败
    const r1 = await invoke(null, 'sessionProjections', { missionId: c.missionId });
    assert.equal(r1.ok, true, 'a failing projection degrades, never throws');
    // 缓存过期后应该能恢复
    now += 4000;
    const r2 = await invoke(null, 'sessionProjections', { missionId: c.missionId });
    assert.equal(calls, 2, 'the failure must not be cached forever');
    assert.equal(r2.available, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
