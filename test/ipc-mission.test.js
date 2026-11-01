// test/ipc-mission.test.js — P1：Mission Core 的 IPC 接线。
//
// 第一性原理：为什么是"一个通道 + action 判别式"
//
//   本仓库有两条先例：
//     · office:*  冻结通道集合 + action 判别式（9 通道覆盖 20+ 操作）
//     · shell:*   每操作一个通道（74 个，是 main.js 过载主因，TD-01）
//
//   Mission 有 14 个 action。若每个开一个通道，会立刻复制 shell:* 的问题。
//   走 office:* 那条路：单一 `mission:invoke` + `{action, payload}`。
//   额外好处：通道集合冻结后，新增 action 不需要改契约快照，不会产生假红。
//
// 第二性原理：IPC 层必须是薄壳
//
//   它只做三件事：参数形状校验、错误转成 {ok:false}、不泄露异常。
//   所有语义在 src/mission/** 里（可纯 Node 测试）。这样换传输时不用重写业务。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc, MISSION_IPC_CHANNELS, ACTIONS } = require('../src/ipc-mission.js');

function tmpWs() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-misipc-'));
}

function harness(opts = {}) {
  const ipcMain = {
    handlers: new Map(),
    handle(channel, fn) {
      if (this.handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      this.handlers.set(channel, fn);
    },
  };
  let tick = 1000;
  const logs = [];
  registerMissionIpc(ipcMain, {
    workspaceDirOf: opts.workspaceDirOf || (() => opts.ws || '/tmp/nonexistent-ws'),
    snapshotOf: opts.snapshotOf || (() => null),
    clock: () => (tick += 10),
    log: (m) => logs.push(m),
  });
  return {
    invoke: (action, payload) => ipcMain.handlers.get('mission:invoke')({}, action, payload),
    channels: () => [...ipcMain.handlers.keys()],
    logs,
  };
}

// ------------------------------------------------------------- 通道形态

test('mission-ipc: exposes exactly ONE frozen channel (not one per action)', () => {
  const h = harness({ ws: tmpWs() });
  assert.deepEqual(h.channels(), ['mission:invoke']);
  assert.deepEqual([...MISSION_IPC_CHANNELS], ['mission:invoke'],
    'adding an action must not require adding a channel');
});

test('mission-ipc: all declared actions are actually handled', async () => {
  const h = harness({ ws: tmpWs() });
  assert.ok(ACTIONS.length >= 10, 'Mission has a substantial action surface');
  for (const action of ACTIONS) {
    const out = await h.invoke(action, {});
    // 每个 action 都必须返回结构化结果，而不是 undefined
    assert.equal(typeof out, 'object', `action ${action} must return an object`);
    assert.ok('ok' in out, `action ${action} must answer with an ok flag`);
    // 不允许出现 ACTION_UNKNOWN —— 那说明 ACTIONS 列表与 handlers 不一致
    assert.notEqual(out.code, 'ACTION_UNKNOWN', `action ${action} is declared but not handled`);
  }
});

test('mission-ipc: an unknown action FAILS loudly (never an empty success)', async () => {
  // 静默返回 {} 会让 UI 显示空列表，让人以为"没有数据"。
  const h = harness({ ws: tmpWs() });
  const out = await h.invoke('nonsense', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'ACTION_UNKNOWN');
  assert.match(out.reason, /unknown action: nonsense/);
});

test('mission-ipc: a missing action is rejected', async () => {
  const h = harness({ ws: tmpWs() });
  const out = await h.invoke('', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'ACTION_REQUIRED');
});

// ------------------------------------------------------------ 工作区边界

test('mission-ipc: no workspace yields a clear failure, not a crash', async () => {
  const h = harness({ workspaceDirOf: () => '' });
  const out = await h.invoke('list');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /no workspace selected/);
});

test('mission-ipc: a throwing workspaceDirOf is converted to {ok:false}', async () => {
  const h = harness({ workspaceDirOf: () => { throw new Error('settings unavailable'); } });
  const out = await h.invoke('list');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /cannot resolve workspace/);
});

test('mission-ipc: switching workspace switches the store (no stale cache)', async () => {
  // 缓存必须按 resolved 路径失效，否则切换工作区后看不到新 Mission。
  const wsA = tmpWs();
  const wsB = tmpWs();
  let current = wsA;
  const h = harness({ workspaceDirOf: () => current });

  const a = await h.invoke('create', { title: 'A 项目', intent: 'IA' });
  assert.strictEqual(a.ok, true);

  let listA = await h.invoke('list');
  assert.strictEqual(listA.missions.length, 1);

  current = wsB;
  const listB = await h.invoke('list');
  assert.strictEqual(listB.missions.length, 0, 'a different workspace must not see the first one\'s missions');

  const b = await h.invoke('create', { title: 'B 项目', intent: 'IB' });
  assert.strictEqual(b.ok, true);

  current = wsA;
  const backToA = await h.invoke('list');
  assert.strictEqual(backToA.missions.length, 1, 'switching back must find the original data');
  assert.strictEqual(backToA.missions[0].title, 'A 项目');
});

// --------------------------------------------------------------- 创建

test('mission-ipc: create requires title and intent (schema is enforced at the boundary)', async () => {
  const h = harness({ ws: tmpWs() });
  const noIntent = await h.invoke('create', { title: 'T' });
  assert.strictEqual(noIntent.ok, false);
  assert.strictEqual(noIntent.code, 'MISSION_INVALID');
  assert.match(noIntent.reason, /intent is required/);
});

test('mission-ipc: create assigns a mission id and persists', async () => {
  const ws = tmpWs();
  const h = harness({ ws });
  const out = await h.invoke('create', { title: '项目', intent: '目标' });
  assert.strictEqual(out.ok, true);
  assert.match(out.missionId, /^mis-[0-9a-f]+$/);

  const list = await h.invoke('list');
  assert.strictEqual(list.missions.length, 1);
  assert.strictEqual(list.missions[0].missionId, out.missionId);
  assert.ok(fs.existsSync(path.join(ws, '.dsh', 'mission', 'events.jsonl')));
});

test('mission-ipc: MULTIPLE active missions are allowed (user requirement)', async () => {
  const h = harness({ ws: tmpWs() });
  for (const t of ['A', 'B', 'C']) {
    const r = await h.invoke('create', { title: t, intent: `i-${t}` });
    assert.strictEqual(r.ok, true);
  }
  const list = await h.invoke('list');
  assert.strictEqual(list.activeCount, 3, 'no global-unique-active constraint may exist');
});

// ------------------------------------------------------------- 状态变更

test('mission-ipc: status changes reject "focused" (it is a UI concept)', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('updateStatus', { missionId: c.missionId, to: 'focused' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'STATUS_INVALID');
  assert.match(out.reason, /UI concept/);
});

test('mission-ipc: status changes go through statusChanged, and update() cannot change status', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });

  await h.invoke('updateStatus', { missionId: c.missionId, to: 'paused' });
  let got = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(got.view.mission.status, 'paused');

  // update() 只带 title，不该影响 status
  await h.invoke('update', { missionId: c.missionId, title: '新标题' });
  got = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(got.view.mission.title, '新标题');
  assert.strictEqual(got.view.mission.status, 'paused', 'update() must not touch status');
});

test('mission-ipc: get on a missing mission fails with MISSION_NOT_FOUND', async () => {
  const h = harness({ ws: tmpWs() });
  const out = await h.invoke('get', { missionId: 'mis-ghost' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'MISSION_NOT_FOUND');
});

// -------------------------------------------------- Decision / Question

test('mission-ipc: a decision without rationale is rejected (the WHY is mandatory)', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('recordDecision', { missionId: c.missionId, text: '决定了' });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'DECISION_INVALID');
  assert.match(out.reason, /rationale is required/);
});

test('mission-ipc: a full decision round-trips with its rationale', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const d = await h.invoke('recordDecision', {
    missionId: c.missionId, text: '用能力探测', rationale: '版本号不是判据', decidedBy: 'user',
  });
  assert.strictEqual(d.ok, true);
  const got = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(got.view.decisions.length, 1);
  assert.strictEqual(got.view.decisions[0].rationale, '版本号不是判据');
});

test('mission-ipc: answering a question requires a non-empty answer', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const q = await h.invoke('openQuestion', { missionId: c.missionId, text: '要不要升级?' });
  assert.strictEqual(q.ok, true);

  const empty = await h.invoke('answerQuestion', { questionId: q.questionId, answer: '   ' });
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.code, 'ANSWER_REQUIRED');

  const ok = await h.invoke('answerQuestion', { questionId: q.questionId, answer: '要' });
  assert.strictEqual(ok.ok, true);
});

// ------------------------------------------------------------ Deliverable

test('mission-ipc: registerDeliverable computes a digest and verify reports unchanged', async () => {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'r.md'), 'content');
  const h = harness({ ws });

  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const reg = await h.invoke('registerDeliverable', {
    missionId: c.missionId, label: '报告', relPath: 'docs/r.md',
  });
  assert.strictEqual(reg.ok, true);
  assert.match(reg.deliverable.digest, /^[0-9a-f]{64}$/);

  const ver = await h.invoke('verifyDeliverables', { missionId: c.missionId });
  assert.strictEqual(ver.ok, true);
  assert.strictEqual(ver.counts.unchanged, 1);
  assert.strictEqual(ver.healthy, true);
});

test('mission-ipc: a traversal path is refused at the IPC boundary', async () => {
  const ws = tmpWs();
  const h = harness({ ws });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('registerDeliverable', {
    missionId: c.missionId, label: 'x', relPath: '../../etc/passwd',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'DELIVERABLE_INVALID');
});

test('mission-ipc: verifyDeliverables surfaces MODIFIED separately (different remedy than missing)', async () => {
  const ws = tmpWs();
  fs.writeFileSync(path.join(ws, 'a.md'), 'v1');
  const h = harness({ ws });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  await h.invoke('registerDeliverable', { missionId: c.missionId, label: 'a', relPath: 'a.md' });

  fs.writeFileSync(path.join(ws, 'a.md'), 'v2');
  const ver = await h.invoke('verifyDeliverables', { missionId: c.missionId });
  assert.strictEqual(ver.counts.modified, 1);
  assert.strictEqual(ver.healthy, false);
});

// ---------------------------------------------------------------- Brief

test('mission-ipc: getBrief returns a bounded, non-empty brief', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: '转型项目', intent: '把产品转成 Agent-first' });
  const out = await h.invoke('getBrief', { missionId: c.missionId });
  assert.strictEqual(out.ok, true);
  assert.ok(out.brief.bytes > 0);
  assert.match(out.brief.text, /转型项目/);
  assert.match(out.brief.text, /Agent-first/);
});

test('mission-ipc: getBrief honours a custom maxBytes', async () => {
  const h = harness({ ws: tmpWs() });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('getBrief', { missionId: c.missionId, maxBytes: 80 });
  assert.ok(out.brief.bytes <= 80);
});

// ---------------------------------------------------------- Harness 快照

test('mission-ipc: without a Harness snapshot, live state is "unavailable" (not running=false)', async () => {
  // "不可用"与"没有在跑"是两件事。混淆它们会让 UI 显示错误的确定信息。
  const h = harness({ ws: tmpWs(), snapshotOf: () => null });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(out.live.available, false);
});

test('mission-ipc: a timestamped snapshot drives live state', async () => {
  const h = harness({
    ws: tmpWs(),
    snapshotOf: () => ({ observedAtMs: 5000, hasRunningAgent: true, pendingApprovals: 2 }),
  });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(out.live.available, true);
  assert.strictEqual(out.live.hasRunningAgent, true);
  assert.strictEqual(out.live.awaitingUser, true);
  assert.strictEqual(out.live.observedAtMs, 5000);
});

test('mission-ipc: a throwing snapshotOf degrades to unavailable, never crashes the IPC', async () => {
  const h = harness({ ws: tmpWs(), snapshotOf: () => { throw new Error('mux down'); } });
  const c = await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('get', { missionId: c.missionId });
  assert.strictEqual(out.ok, true, 'the mission read must still succeed');
  assert.strictEqual(out.live.available, false);
});

// ------------------------------------------------------------ diagnostics

test('mission-ipc: diagnostics reports log health, archive status and migration plan', async () => {
  const h = harness({ ws: tmpWs() });
  await h.invoke('create', { title: 'T', intent: 'I' });
  const out = await h.invoke('diagnostics');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.report.healthy, true);
  assert.strictEqual(out.report.eventCount, 1);
  assert.ok('needed' in out.archive);
  assert.ok('needsWrite' in out.migration);
  assert.ok(out.workspaceDir);
});

// -------------------------------------------------------- 异常不外泄

test('mission-ipc: a handler exception becomes {ok:false} and is logged, never thrown to the renderer', async () => {
  // 构造一个会抛的场景：workspaceDirOf 返回非字符串但 truthy
  const h = harness({ workspaceDirOf: () => ({ bad: true }) });
  const out = await h.invoke('list');
  assert.strictEqual(out.ok, false);
  assert.ok(typeof out.reason === 'string');
});

test('mission-ipc: every action tolerates an undefined payload', async () => {
  const h = harness({ ws: tmpWs() });
  for (const action of ACTIONS) {
    const out = await h.invoke(action, undefined);
    assert.equal(typeof out, 'object', `${action} must not throw on undefined payload`);
  }
});
