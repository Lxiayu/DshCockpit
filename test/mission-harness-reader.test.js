// test/mission-harness-reader.test.js — P1：只读消费 Harness 状态。
//
// 第一性原理：为什么"只读"和"必须标注时间"是正确性要求，不是风格
//
//   Mission 拥有 status(active/paused/…)。Harness 拥有 running/awaitingUser。
//   如果 Mission 也维护一个 "running" 标志位，重启后两个作者会给出不同答案——
//   这就是"两个事实作者"的具体形态。
//
//   所以 Mission 只能**读** Harness 快照，而且必须标注**读到的时间**：
//     · 没有 observedAtMs，"running=true" 会被读成"现在正在跑"
//     · 有了它，UI 才能说"3 分钟前观察到有 Agent 在跑"
//
//   这里锁死：
//     1. 无时间戳的快照**不可用**（不是"降级使用"）
//     2. 快照只保留白名单字段（raw sessionId 等必须被丢弃）
//     3. 派生状态（stale / awaitingUser）不落盘，每次算
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const h = require('../src/mission/harness-reader.js');

function view(over = {}) {
  return {
    mission: {
      missionId: 'mis-a', title: 'T', status: 'active',
      updatedAtMs: 0, lastSessionRef: 'sess-h-abc', ...over,
    },
  };
}

// ------------------------------------------------------------- 时间戳

test('harness-reader: an UNTIMESTAMPED snapshot is refused entirely', () => {
  // 不是"降级使用"，是完全不可用：没有时间的 running=true 会被当成当前状态。
  const r = h.normalizeSnapshot({ hasRunningAgent: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /would be read as current truth/);
});

test('harness-reader: deriveLiveView without a snapshot says unavailable, not "not running"', () => {
  // "不可用"与"没有在跑"是两件事。混淆它们会让 UI 显示错误的确定信息。
  const live = h.deriveLiveView(view(), null);
  assert.strictEqual(live.available, false);
  assert.ok(!('hasRunningAgent' in live), 'must not fabricate a false value');
});

// --------------------------------------------------------------- 隐私

test('harness-reader: only whitelisted fields survive normalisation', () => {
  // 组合根可能不小心把 raw sessionId 塞进来——这层兜住。
  const r = h.normalizeSnapshot({
    hasRunningAgent: true,
    pendingApprovals: 1,
    pendingQuestions: 2,
    rawSessionId: 'session-abc123',
    prompt: '用户的私密内容',
    absolutePath: '/Users/xia/secret',
    goalPhase: 'active',
  }, 1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.snapshot.rawSessionId, undefined);
  assert.strictEqual(r.snapshot.prompt, undefined);
  assert.strictEqual(r.snapshot.absolutePath, undefined);
  assert.strictEqual(r.snapshot.goalPhase, 'active', 'whitelisted fields do survive');
});

test('harness-reader: a raw session id in activeSessionHandle is dropped (only sess-h-* allowed)', () => {
  const bad = h.normalizeSnapshot({ activeSessionHandle: 'session-abc123' }, 1);
  assert.strictEqual(bad.snapshot.activeSessionHandle, undefined);

  const good = h.normalizeSnapshot({ activeSessionHandle: 'sess-h-deadbeef' }, 1);
  assert.strictEqual(good.snapshot.activeSessionHandle, 'sess-h-deadbeef');
});

test('harness-reader: malformed counters degrade to 0 instead of NaN/negative', () => {
  const r = h.normalizeSnapshot({ pendingApprovals: -5, pendingQuestions: 'abc', teamMemberCount: 3.7 }, 1);
  assert.strictEqual(r.snapshot.pendingApprovals, 0);
  assert.strictEqual(r.snapshot.pendingQuestions, 0);
  assert.strictEqual(r.snapshot.teamMemberCount, 4, 'counts are rounded');
});

// ------------------------------------------------------------ 派生语义

test('harness-reader: awaitingUser is DERIVED from pending approvals/questions', () => {
  const snap = h.normalizeSnapshot({ pendingApprovals: 1, pendingQuestions: 0 }, 1000).snapshot;
  assert.strictEqual(h.deriveLiveView(view(), snap).awaitingUser, true);

  const none = h.normalizeSnapshot({ pendingApprovals: 0, pendingQuestions: 0 }, 1000).snapshot;
  assert.strictEqual(h.deriveLiveView(view(), none).awaitingUser, false);
});

test('harness-reader: missionActive and hasRunningAgent are reported as SEPARATE axes', () => {
  // domain-model §2.1.1：Active / Focused / Running 是三件不同的事。
  // 一个 active mission 可以没有 agent 在跑；一个 running agent 可能属于别的 mission。
  const paused = h.normalizeSnapshot({ hasRunningAgent: true }, 1000).snapshot;
  const live = h.deriveLiveView(view({ status: 'paused' }), paused);
  assert.strictEqual(live.missionActive, false);
  assert.strictEqual(live.hasRunningAgent, true, 'the two axes must not be conflated');
});

test('harness-reader: runningForThisMission requires a MATCHING session handle', () => {
  // Harness 不知道事件属于哪个 Mission，所以只有在会话句柄确实匹配时
  // 才敢说"为这个 Mission 而跑"。
  const match = h.normalizeSnapshot({ hasRunningAgent: true, activeSessionHandle: 'sess-h-abc' }, 1).snapshot;
  assert.strictEqual(h.deriveLiveView(view(), match).runningForThisMission, true);

  const other = h.normalizeSnapshot({ hasRunningAgent: true, activeSessionHandle: 'sess-h-xyz' }, 1).snapshot;
  assert.strictEqual(h.deriveLiveView(view(), other).runningForThisMission, false,
    'a different session must not be attributed to this mission');

  const noHandle = h.normalizeSnapshot({ hasRunningAgent: true }, 1).snapshot;
  assert.strictEqual(h.deriveLiveView(view(), noHandle).runningForThisMission, false,
    'without a handle we cannot attribute it');
});

// --------------------------------------------------------------- 派生 stale

test('harness-reader: staleness is DERIVED, never persisted', () => {
  const day = 24 * 60 * 60 * 1000;
  const fresh = h.staleness(view({ updatedAtMs: 10 * day }), 12 * day);
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.daysSinceUpdate, 2);

  const stale = h.staleness(view({ updatedAtMs: 0 }), 8 * day);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.daysSinceUpdate, 8);
  assert.strictEqual(stale.staleAfterDays, 7);
});

test('harness-reader: staleness with missing timestamps reports "cannot compute", not false', () => {
  const r = h.staleness({ mission: {} }, 1000);
  assert.strictEqual(r.daysSinceUpdate, null);
  assert.match(r.reason, /cannot compute/);
});

test('harness-reader: a custom stale threshold is honoured', () => {
  const day = 24 * 60 * 60 * 1000;
  assert.strictEqual(h.staleness(view({ updatedAtMs: 0 }), 4 * day, 3).stale, true);
  assert.strictEqual(h.staleness(view({ updatedAtMs: 0 }), 4 * day, 10).stale, false);
});

// --------------------------------------------------------------- 批量

test('harness-reader: deriveWorkspaceLive handles a list of missions', () => {
  const snap = h.normalizeSnapshot({ hasRunningAgent: true, pendingApprovals: 1 }, 1000).snapshot;
  const rows = h.deriveWorkspaceLive(
    [view({ missionId: 'mis-a' }), view({ missionId: 'mis-b', status: 'paused' })],
    snap, 1000,
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].missionId, 'mis-a');
  assert.strictEqual(rows[0].live.awaitingUser, true);
  assert.strictEqual(rows[1].live.missionActive, false);
});

test('harness-reader: deriveWorkspaceLive tolerates null entries (no crash on partial data)', () => {
  const rows = h.deriveWorkspaceLive([view(), null, undefined], null, 1000);
  assert.strictEqual(rows.length, 1);
});
