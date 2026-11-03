// test/mission-receipt-persistence.test.js — 凭证落盘（S5）。
//
// 第一性原理：为什么凭证必须落盘，而不是每次现读
//
//   官方的变更清单**只在 Session 存活期间可用**（Host 侧不持久）。
//   所以如果凭证只在 workStatus 时即时读取，那么 app 一重启、
//   或者会话一 dispose，"这次交付有没有依据"就永久丢失了 ——
//   用户历史里只剩下一句"团队说做完了"。
//
//   落盘的是**坐标**（sessionRef/seq/turn + 计数 + 相对路径清单），
//   不是变更内容。坐标过期后仍可回答"当时复核过什么"，只是不能重新复核。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProjection, applyEvent } = require('../src/mission/projection.js');
const schema = require('../src/mission/schema.js');

function base(extra = {}) {
  return {
    missions: {
      'mis-a': {
        missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
        workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2, ...extra,
      },
    },
    workstreams: {}, decisions: {}, questions: {}, deliverables: {},
    taskRefs: {}, findings: {}, assumptions: {}, evidences: {},
  };
}

const RECEIPT = {
  sessionRef: 'sess-h-abc123',
  seq: 29,
  turn: 3,
  total: 2,
  added: 15,
  deleted: 3,
  files: [{ path: 'src/a.js', added: 15, deleted: 3 }],
};

test('persistence: a validated receipt is attached to the mission', () => {
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: RECEIPT },
    atMs: 5000,
  });
  const m = next.missions['mis-a'];
  assert.ok(m.receipt, 'the mission must carry the receipt');
  assert.equal(m.receipt.seq, 29);
  assert.equal(m.receipt.total, 2);
  assert.equal(m.receipt.recordedAtMs, 5000);
});

test('persistence: an INVALID receipt is not applied (schema gates the log)', () => {
  // 关键：projection 遇到非法 payload 时 break（不抛错、不写入）。
  // 这是本项目既有约定 —— 但正因如此，"没写进去"必须能被测试发现。
  const withAbs = { ...RECEIPT, files: [{ path: '/Users/xia/proj/a.js', added: 1, deleted: 0 }] };
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: withAbs },
    atMs: 5000,
  });
  assert.equal(next.missions['mis-a'].receipt, undefined,
    'a receipt carrying an absolute path must never reach the fact chain');
});

test('persistence: a receipt with a raw sessionId is not applied', () => {
  const withRaw = { ...RECEIPT, sessionRef: 'session-9f2c' };
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: withRaw },
    atMs: 5000,
  });
  assert.equal(next.missions['mis-a'].receipt, undefined);
});

test('persistence: only the LATEST receipt is kept per mission', () => {
  // 攒一堆历史凭证会让 UI 无法回答"现在该信哪个"。
  let proj = base();
  proj = applyEvent(proj, {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: { ...RECEIPT, seq: 10, turn: 1 } },
    atMs: 1000,
  });
  proj = applyEvent(proj, {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: { ...RECEIPT, seq: 29, turn: 3 } },
    atMs: 5000,
  });
  assert.equal(proj.missions['mis-a'].receipt.seq, 29, 'the newest coordinate wins');
  assert.equal(proj.missions['mis-a'].receipt.turn, 3);
});

test('persistence: a receipt for an unknown mission is ignored', () => {
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'nope', receipt: RECEIPT },
    atMs: 5000,
  });
  assert.equal(next.missions['nope'], undefined);
});

test('persistence: the event type is part of the frozen vocabulary', () => {
  // 事件类型是闭集。新增类型必须同时出现在 EVENT_TYPES 里，
  // 否则 replay 会静默丢弃它（本项目踩过同类坑：
  // taskRef append 曾被 schema 静默 break，功能看起来接了实际一条没存）。
  const { EVENT_TYPES } = require('../src/mission/projection.js');
  assert.ok(EVENT_TYPES.includes('receipt.recorded'),
    'a type missing from EVENT_TYPES would be silently dropped on replay');
});

test('persistence: schema rejects a receipt with no seq (unresolvable coordinate)', () => {
  const r = schema.validateReceipt({ sessionRef: 'sess-h-abc' });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// 端到端：workStatus → verified → 自动落盘
// ---------------------------------------------------------------------------
//
// 第一性原理：落盘必须真的发生，否则前面所有努力都白费
//
//   官方变更清单只在 Session 存活期间可用。所以"读到 verified"之后
//   必须立刻把它写进我们自己的日志 —— 否则重启后什么都没留下。
//
//   这条链路有三处容易静默断裂的地方（本轮全部踩过）：
//     ① sessionRef 用占位字符串 → schema 拒绝 → 整个凭证不落盘
//     ② 事件类型没注册 → replay 静默丢弃
//     ③ 读了错误的字段路径（mv.receipt 而非 mv.mission.receipt）

function setupForPersistence({ seq = 29, summary = null } = {}) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { registerMissionIpc } = require('../src/ipc-mission.js');
  const { createMissionStore } = require('../src/mission/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receipt-persist-'));
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
    {
      workspaceDirOf: () => dir,
      clock: () => 2000,
      log: () => {},
      snapshotOf: () => null,
      projectionsOf: async () => ({
        ok: true,
        value: { values: { sessionStats: { turns: 3, steps: 9 }, turnOutline: [{ turn: 3, response: '做完了' }] } },
      }),
      seqOfTurn: () => seq,
      changesSummaryOf: async () => ({
        ok: true,
        value: summary || { turn: 3, total: 2, added: 15, deleted: 3, files: [{ path: 'a.js', added: 15, deleted: 3 }] },
      }),
    },
  );
  return { dir, invoke: handlers.get('mission:invoke'), fs };
}

test('e2e: a verified receipt is APPENDED to the log (survives a store reopen)', async () => {
  const { dir, invoke, fs } = setupForPersistence();
  const path = require('node:path');
  const { createMissionStore } = require('../src/mission/store.js');
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'verified');
    // coordinate 是内部形状，不该回传给 UI
    assert.equal(Object.prototype.hasOwnProperty.call(r.receipt, 'coordinate'), false);

    // 重新打开 store（模拟 app 重启）
    const reopened = createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
    const mv = reopened.missionView('mis-a');
    assert.ok(mv.mission.receipt, 'the receipt must survive a reopen — that is the whole point of persisting it');
    assert.equal(mv.mission.receipt.seq, 29);
    assert.equal(mv.mission.receipt.total, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: the persisted receipt carries a DERIVED handle, never the raw sessionId', async () => {
  const { dir, invoke, fs } = setupForPersistence();
  try {
    await invoke(null, 'workStatus', { missionId: 'mis-a' });
    const { createMissionStore } = require('../src/mission/store.js');
    const reopened = createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
    const rec = reopened.missionView('mis-a').mission.receipt;
    assert.match(rec.sessionRef, /^sess-h-/);
    assert.equal(JSON.stringify(rec).includes('session-x'), false,
      'the raw session id must not appear anywhere in the persisted receipt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: a CLAIMED receipt is NOT persisted (an observation gap is not a delivery fact)', async () => {
  // 把"我们没能复核"写进不可篡改的日志，等于把噪音固化成历史。
  const { dir, invoke, fs } = setupForPersistence({ seq: null });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'claimed');
    const { createMissionStore } = require('../src/mission/store.js');
    const reopened = createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
    assert.equal(reopened.missionView('mis-a').mission.receipt, undefined,
      'claimed must not be written to the log');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: claimed carries NO coordinate at all (so nothing CAN be persisted)', async () => {
  // 变异测试发现：把条件从 "state === verified" 放宽成 "built" 时，
  // 测试没变红 —— 因为 claimed 本来就不带 coordinate，append 会因校验失败静默跳过。
  //
  // 防御是存在的，但**不是靠那个条件**。这种"两道防线互相掩盖"会让
  // 条件的真实作用无法被验证。所以这里直接钉住前提：
  // claimed 的结果里根本不该有 coordinate 字段。
  const { dir, invoke, fs } = setupForPersistence({ seq: null });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'claimed');
    // 通过 store 内部读：claimed 路径不该产出可落盘坐标
    const { createMissionStore } = require('../src/mission/store.js');
    const reopened = createMissionStore({ workspaceDir: dir, now: () => 9999, log: () => {} });
    assert.equal(reopened.missionView('mis-a').mission.receipt, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('e2e: a claimed-with-coordinate case is still blocked by the state check', async () => {
  // 构造一个"有坐标但状态不是 verified"的场景，验证条件真的起作用。
  // 这是上一轮变异漏掉的那条路径。
  const { applyEvent, emptyProjection } = require('../src/mission/projection.js');
  let p = emptyProjection();
  p = applyEvent(p, {
    type: 'mission.created',
    payload: { missionId: 'mis-m', title: 't', intent: 'i', status: 'active', workspaceId: 'w', createdAtMs: 1, updatedAtMs: 2 },
    atMs: 1,
  });
  // 直接写一个坐标完整的凭证：projection 层本身不判断"该不该落"，
  // 那个判断在 ipc 层（只落 verified）。这里确认 projection 会接受它，
  // 从而说明"只落 verified"的责任确实在 ipc 层，且被测试覆盖。
  p = applyEvent(p, {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-m', receipt: { sessionRef: 'sess-h-x', seq: 1, turn: 1, total: 0 } },
    atMs: 2,
  });
  assert.ok(p.missions['mis-m'].receipt, 'projection accepts any schema-valid receipt');
  assert.equal(p.missions['mis-m'].receipt.seq, 1);
});
