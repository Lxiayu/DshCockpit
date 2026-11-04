// test/mission-since-team-snapshot.test.js — "我离开后团队发生了什么"。
//
// 第一性原理：右栏必须回答三个问题，这是第二个
//
//   三大问题：我要拍板什么 / 我能信什么 / **我离开后团队发生了什么**。
//
//   早期 sinceLastSeen 只统计 Mission 自己记录的东西
//   （决策/问题/工作流/交付物）。实际后果（实测确认）：
//   团队完成了一个任务，右栏「离开期间」显示的是**空** ——
//   用户会以为团队什么都没干。
//
//   而团队的任务在 Harness 那边，必须去 agentTeam 投影里取。
//
// 诚实边界（这条比功能本身更重要）：
//   官方 agentTeam 投影只给**当前状态**，不给"何时变成这个状态"的时间戳。
//   所以这里不能说"团队完成了 X"，只能说"团队现在的样子是 X"。
//   宁可说不知道什么时候，也不能编一个时间 —— 编出来的时间会被用户当成事实。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function setup({ team = null, bind = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-since-'));
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock: () => 1_000_000,
      log: () => {},
      snapshotOf: () => null,
      ensureSession: async () => ({ ok: true, sessionId: 's1' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => ({ ok: true, value: { values: { agentTeam: team } } }),
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir, bind };
}

async function makeSeen(invoke, dir, bind) {
  const c = await invoke(null, 'create', { title: 't', intent: 'i' });
  if (bind) await invoke(null, 'startWork', { missionId: c.missionId, task: '做事' });
  await invoke(null, 'markSeen', { missionId: c.missionId });
  return c.missionId;
}

function tasks(...list) { return { members: [{ id: 'm0', name: 'coder' }], tasks: list }; }
const T = (id, subject, status, extra = {}) => ({ id, subject, status, ready: true, blockedBy: [], ...extra });

test('since: a task the team finished shows up even when the Mission recorded nothing', async () => {
  const { invoke, dir, bind } = setup({ team: tasks(T('t1', '梳理调用点', 'completed')) });
  try {
    const id = await makeSeen(invoke, dir, bind);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    assert.equal(r.ok, true);
    assert.ok(r.teamSnapshot, 'the team snapshot must be present');
    assert.equal(r.teamSnapshot.done.length, 1);
    assert.equal(r.teamSnapshot.done[0].subject, '梳理调用点');
    // 没有 Mission 侧变化时 entries 是空的，但团队状态必须还在
    assert.deepEqual(r.entries, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: it distinguishes in-progress / done / blocked', async () => {
  const { invoke, dir, bind } = setup({
    team: tasks(
      T('t1', 'a', 'completed'),
      T('t2', 'b', 'in_progress'),
      T('t3', 'c', 'pending', { ready: false, blockedBy: ['t2'] }),
      T('t4', 'd', 'pending'),
    ),
  });
  try {
    const id = await makeSeen(invoke, dir, bind);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    const ts = r.teamSnapshot;
    assert.equal(ts.done.length, 1);
    assert.equal(ts.active.length, 1);
    assert.equal(ts.blocked.length, 1, 'only the not-ready task counts as blocked');
    assert.equal(ts.total, 4);
    assert.equal(ts.memberCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: it NEVER invents a completion time', async () => {
  // 投影里没有时间戳。如果我们在 entries 里塞一条带时间的"任务完成"，
  // 那就是**伪造事实** —— 用户会把它当成真的发生在那个时刻。
  const { invoke, dir, bind } = setup({ team: tasks(T('t1', 'a', 'completed')) });
  try {
    const id = await makeSeen(invoke, dir, bind);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    const taskEntries = (r.entries || []).filter((e) => e.kind === 'task');
    assert.deepEqual(taskEntries, [],
      'tasks must NOT appear as timestamped entries — the projection has no timestamps');
    // 它们只以"当前状态"出现
    assert.ok(r.teamSnapshot.done.length === 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: no tasks means no snapshot (not an empty one)', async () => {
  const { invoke, dir, bind } = setup({ team: tasks() });
  try {
    const id = await makeSeen(invoke, dir, bind);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    assert.equal(r.teamSnapshot, null, 'zero tasks is not a "team snapshot"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: an unbound mission reports no team snapshot instead of failing', async () => {
  const { invoke, dir } = setup({ team: tasks(T('t1', 'a', 'completed')), bind: false });
  try {
    const id = await makeSeen(invoke, dir, false);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    assert.equal(r.ok, true);
    assert.equal(r.teamSnapshot, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: a projection that throws does not break the whole回顾', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-since-'));
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir, clock: () => 1_000_000, log: () => {},
      snapshotOf: () => null,
      ensureSession: async () => ({ ok: true, sessionId: 's1' }),
      promptSession: async () => ({ ok: true }),
      projectionsOf: async () => { throw new Error('runtime down'); },
    },
  );
  try {
    const invoke = handlers.get('mission:invoke');
    const id = await makeSeen(invoke, dir, true);
    const r = await invoke(null, 'sinceLastSeen', { missionId: id });
    assert.equal(r.ok, true, 'a dead runtime must not kill the回顾');
    assert.equal(r.teamSnapshot, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('since: the UI renders the snapshot even when there are no Mission entries', () => {
  // 源码级断言：早期 `if (!entries.length) return null;` 会让整块消失。
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');
  assert.match(html, /const hasTeam = ts && Number\.isFinite\(ts\.total\)/,
    'the rail must consider the team snapshot when deciding whether to render');
  assert.match(html, /if \(!hasMissionEntries && !hasTeam\) return null;/,
    'it must only bail out when BOTH are missing');
  assert.match(html, /Harness 没有给时间戳，我们不猜/,
    'the UI must say that the timing is unknown — silence would read as "just now"');
});
