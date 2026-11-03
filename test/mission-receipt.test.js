// test/mission-receipt.test.js — 工作凭证（Work Receipt，S5 基础）。
//
// 第一性原理：这组测试锁的是"凭证不能说谎"
//
//   凭证存在的唯一目的是让"完成"**可证伪**。它一旦说谎，比没有凭证更糟：
//   用户会以为自己验证过了。
//
//   所以这里锁三条：
//     1. 没有坐标 → 只能叫 "claimed"（团队声称），不能叫 verified
//     2. stale（Host 已读不到）绝不能显示成"已通过"
//     3. 凭证里**不允许出现文件内容**（只存坐标与计数）
//
//   测试数据取自 2026-11-04 真机探针的实际响应：
//   GET /api/changes.summary?sessionId=…&seq=29
//   → {"turn":1,"files":[{"path":"probe-s5.txt","display":"probe-s5.txt",
//      "added":1,"deleted":0}],"total":1,"added":1,"deleted":0}
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const receipt = require('../src/mission/receipt.js');

/** 真机探针拿到的原始 summary（原样）。 */
const OBSERVED_SUMMARY = {
  turn: 1,
  files: [{ path: 'probe-s5.txt', display: 'probe-s5.txt', added: 1, deleted: 0 }],
  total: 1,
  added: 1,
  deleted: 0,
};

test('receipt: a coordinate carries the official seq/session and never the file content', () => {
  const c = receipt.buildReceiptCoordinate({
    sessionRef: 'sess-h-abc123',
    seq: 29,
    turn: 1,
    summary: OBSERVED_SUMMARY,
  });
  assert.equal(c.sessionRef, 'sess-h-abc123');
  assert.equal(c.seq, 29);
  assert.equal(c.turn, 1);
  assert.equal(c.total, 1);
  assert.equal(c.added, 1);
  assert.equal(c.deleted, 0);
  assert.deepEqual(c.files, [{ path: 'probe-s5.txt', display: 'probe-s5.txt', added: 1, deleted: 0 }]);

  // 隐私：凭证里只能有这些 key。任何 "content"/"text"/"body" 都意味着
  // 我们把产物内容存进了 Mission，违反 AGENTS.md §2.4。
  const keys = Object.keys(c.files[0]).sort();
  assert.deepEqual(keys, ['added', 'deleted', 'display', 'path'],
    'a file entry may only carry path/display/counts — never content');
});

test('receipt: without a summary the counts stay null, not zero', () => {
  // 0 的含义是"确实改了 0 个文件"，与"还没读到"完全不同。
  // 把后者填成 0 会让 UI 显示"改了 0 个文件"——一个假事实。
  const c = receipt.buildReceiptCoordinate({ sessionRef: 'sess-h-x', seq: 3, turn: 2 });
  assert.equal(c.total, undefined, 'no summary → no total key (not 0)');
  assert.equal(c.files, undefined);
});

test('receipt: state is "claimed" when there is no addressable coordinate', () => {
  // 最弱但最诚实的状态：团队说做完了，但我们拿不出可复核的东西。
  assert.equal(receipt.deriveReceiptState({ receipt: null }), 'claimed');
  assert.equal(receipt.deriveReceiptState({ receipt: {} }), 'claimed');
  assert.equal(receipt.deriveReceiptState({ receipt: { sessionRef: 'sess-h-a' } }), 'claimed',
    'a ref without seq cannot be re-checked');
  assert.equal(receipt.deriveReceiptState({ receipt: { seq: 5 } }), 'claimed',
    'a seq without ref cannot be re-checked');
});

test('receipt: verified requires BOTH an addressable coordinate AND a successful re-check', () => {
  const coord = { sessionRef: 'sess-h-abc', seq: 29, turn: 1, total: 1, added: 1, deleted: 0 };
  assert.equal(receipt.deriveReceiptState({ receipt: coord, resolvable: true }), 'verified');
  // 坐标在，但 Host 读不到 → stale，**不是** verified
  assert.equal(receipt.deriveReceiptState({ receipt: coord, resolvable: false }), 'stale');
  assert.equal(receipt.deriveReceiptState({ receipt: coord }), 'stale',
    'an un-checked coordinate defaults to stale, never to verified');
});

test('receipt: a stale receipt is never described as passed', () => {
  // 这是本文件最重要的一条断言：措辞层面的"不许撒谎"。
  const coord = { sessionRef: 'sess-h-abc', seq: 29, turn: 1, total: 3, added: 10, deleted: 2 };
  const text = receipt.describeReceipt({ receipt: coord, resolvable: false });
  assert.match(text, /失效/);
  assert.doesNotMatch(text, /已通过|已完成|通过/,
    `a stale receipt must not claim success, got: ${text}`);
});

test('receipt: verified wording includes the turn and change counts (facts, not praise)', () => {
  const coord = { sessionRef: 'sess-h-abc', seq: 29, turn: 1, total: 1, added: 1, deleted: 0 };
  const text = receipt.describeReceipt({ receipt: coord, resolvable: true });
  assert.match(text, /已复核/);
  assert.match(text, /第 1 轮/);
  assert.match(text, /1 个文件/);
  assert.match(text, /\+1/);
});

test('receipt: the claimed wording says "claimed", never "done"', () => {
  const text = receipt.describeReceipt({ receipt: null });
  assert.match(text, /声称/);
  assert.doesNotMatch(text, /已完成|通过/);
});

test('receipt: binary and oversized files are preserved as flags (no fake line counts)', () => {
  // 官方对二进制/超大文件给 added=0/deleted=0，但那不是"改了 0 行"。
  // 必须带上 flag，否则 UI 会显示"0 行改动"这种误导信息。
  const c = receipt.buildReceiptCoordinate({
    sessionRef: 'sess-h-b', seq: 7, turn: 3,
    summary: {
      turn: 3,
      files: [
        { path: 'logo.png', display: 'logo.png', added: 0, deleted: 0, binary: true },
        { path: 'big.bin', display: 'big.bin', added: 0, deleted: 0, oversized: true },
      ],
      total: 2, added: 0, deleted: 0,
    },
  });
  assert.equal(c.files[0].binary, true);
  assert.equal(c.files[1].oversized, true);
});

test('receipt: degenerate input never throws', () => {
  assert.doesNotThrow(() => receipt.buildReceiptCoordinate());
  assert.doesNotThrow(() => receipt.buildReceiptCoordinate({ summary: 'nonsense' }));
  assert.doesNotThrow(() => receipt.isReceiptAddressable(null));
  assert.doesNotThrow(() => receipt.describeReceipt());
  assert.equal(receipt.isReceiptAddressable(undefined), false);
});

test('receipt: the state vocabulary is closed and exported', () => {
  assert.deepEqual([...receipt.RECEIPT_STATES], ['claimed', 'verified', 'stale']);
});

// ---------------------------------------------------------------------------
// 集成：workStatus 真的会带上凭证（不是只有纯函数对）
// ---------------------------------------------------------------------------
//
// 第一性原理：用户看 workStatus 真正想问的是"我该不该信"，不是"跑了几轮"。
// turns/steps 只证明有人在动，不证明做完了。
// 而"有回复"和"有凭证"是两件事：一个 turn 正常结束，完全可能什么都没改。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMissionStore } = require('../src/mission/store.js');
const { registerMissionIpc } = require('../src/ipc-mission.js');

function setupBoundMission({ turns = 3, response = '完成了' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receipt-int-'));
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
        value: { values: { sessionStats: { turns, steps: 9 }, turnOutline: [{ turn: turns, response }] } },
      }),
    },
  );
  return { dir, invoke: handlers.get('mission:invoke') };
}

test('integration: workStatus reports a receipt, and "has a reply" is NOT "verified"', async () => {
  const { dir, invoke } = setupBoundMission({ turns: 3, response: '我把事做完了' });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.ok, true);
    assert.equal(r.turns, 3);
    assert.equal(r.hasResponse, true, 'the team did reply');

    assert.ok(r.receipt, 'workStatus must carry a receipt');
    // 核心断言：有回复 ≠ 有凭证。没有可复核的变更坐标就只能叫 claimed。
    assert.equal(r.receipt.state, 'claimed',
      'a reply without a change coordinate is a claim, not a verification');
    // S5 之后文案更精确：能区分"没观测到变更事件"，而不是笼统的"尚未绑定"
    assert.match(r.receipt.reason, /还没有观测到这一轮的变更事件|尚未绑定可复核/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: an unbound mission still answers honestly (no fake receipt)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receipt-unbound-'));
  try {
    const s = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s.append('mission.created', {
      missionId: 'mis-z', title: 't', intent: 'i', status: 'active',
      workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2,
    });
    const handlers = new Map();
    registerMissionIpc(
      { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
      { workspaceDirOf: () => dir, clock: () => 2000, log: () => {}, snapshotOf: () => null },
    );
    const r = await handlers.get('mission:invoke')(null, 'workStatus', { missionId: 'mis-z' });
    assert.equal(r.ok, true);
    assert.equal(r.bound, false);
    assert.equal(r.receipt, undefined, 'nothing ran → no receipt at all (not a fake "claimed")');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S5：凭证走真实两步读取（seq → 变更清单）
// ---------------------------------------------------------------------------
//
// 第一性原理：凭证的价值在于"可复核"，不在于"看起来完成了"
//
//   上一版把 resolvable 写死 false，所以永远只能 claimed —— 用户等不到 verified。
//   现在走两步：取 seq，再按 seq 读官方变更清单。
//
//   这里锁的是**降级路径的诚实性**：两步任何一步失败都不能变成 verified，
//   也不能假装"没有变更"。

function setupWithReceiptWiring({ seq = null, summary = null, readError = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-receipt-s5-'));
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
      changesSummaryOf: async () => {
        if (readError) return { ok: false, reason: readError };
        return { ok: true, value: summary };
      },
    },
  );
  return { dir, invoke: handlers.get('mission:invoke') };
}

test('S5: a readable change list makes the receipt VERIFIED (the whole point)', async () => {
  const { dir, invoke } = setupWithReceiptWiring({
    seq: 29,
    summary: { turn: 1, total: 2, added: 15, deleted: 3, files: [{ path: 'a.js', added: 15, deleted: 3 }] },
  });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'verified');
    assert.equal(r.receipt.total, 2);
    assert.match(r.receipt.reason, /已复核/);
    assert.doesNotMatch(r.receipt.reason, /尚未|读不到/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5: zero files changed is still VERIFIED (a question was answered, nothing edited)', async () => {
  // 关键区分：total=0 是"复核过且确实没变"，不是"没能复核"。
  // 把这两者混起来会让用户以为出了问题。
  const { dir, invoke } = setupWithReceiptWiring({
    seq: 30, summary: { turn: 1, total: 0, added: 0, deleted: 0, files: [] },
  });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'verified');
    assert.match(r.receipt.reason, /没有文件变更/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5: no seq yet → claimed, and the wording says we did not OBSERVE it', async () => {
  // "没观测到" ≠ "没变更"。前者是我们的观测缺口，后者是事实。
  const { dir, invoke } = setupWithReceiptWiring({ seq: null });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'claimed');
    assert.match(r.receipt.reason, /还没有观测到/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5: a seq that cannot be read → claimed, and the reason names the read failure', async () => {
  // 官方清单只在 Session 存活期间可用。Session dispose 后 404 是正常情况，
  // 但我们必须说清楚"是读取失败"，而不是"没有变更"。
  const { dir, invoke } = setupWithReceiptWiring({ seq: 29, readError: 'HTTP 404' });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'claimed');
    assert.match(r.receipt.reason, /读取失败/);
    assert.match(r.receipt.reason, /404/);
    assert.equal(r.receipt.total, undefined, 'no invented file count when the read failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S5: a non-numeric seq is treated as absent, not coerced', async () => {
  const { dir, invoke } = setupWithReceiptWiring({ seq: '29' });
  try {
    const r = await invoke(null, 'workStatus', { missionId: 'mis-a' });
    assert.equal(r.receipt.state, 'claimed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
