// test/companion-state.test.js — P2.4 S1：Companion Mode 状态派生（纯函数）。
//
// 第一性原理：这个小窗最容易犯的三个错
//
//   1. **0 待办还亮红点** → 用户两天内学会无视它，真告警也失效
//   2. **"读不到"显示成"0 待办"** → 用户以为一切正常，实际是断线
//   3. **把 running 当成"需要你"** → 小窗永远在打扰
//
//   这三条都不是"实现难度"问题，是**产品判断**问题。所以它们必须被
//   测试钉死，而不是留给后来的实现者重新想一遍。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { deriveCompanionState, companionSummary } = require('../src/companion-state.js');

function snap(over = {}) {
  return { pending: [], employees: [], ...over };
}

// ============================================================ 断线 vs 安静

test('companion: no snapshot is DISCONNECTED, not "0 items"', () => {
  // 这是最危险的误报形态：断线时显示 0 会让用户以为没有待办。
  const s = deriveCompanionState(null);
  assert.strictEqual(s.available, false);
  assert.strictEqual(s.reason, 'no-snapshot');
  assert.strictEqual(companionSummary(s).kind, 'disconnected');
});

test('companion: an empty-but-healthy snapshot is IDLE (not disconnected)', () => {
  const s = deriveCompanionState(snap());
  assert.strictEqual(s.available, true);
  assert.strictEqual(s.pendingCount, 0);
  assert.strictEqual(companionSummary(s).kind, 'idle');
});

test('companion: a malformed snapshot degrades to disconnected', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    assert.strictEqual(deriveCompanionState(bad).available, false);
  }
});

// ============================================================ 计数

test('companion: pending count comes from the real pending list', () => {
  const s = deriveCompanionState(snap({ pending: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  assert.strictEqual(s.pendingCount, 3);
});

test('companion: running count counts only runtime==="running"', () => {
  // attention 也算"在忙"，但那条信息由 pendingCount 承载；
  // 两边都数会导致小窗永远高亮。
  const s = deriveCompanionState(snap({
    employees: [
      { runtime: 'running' }, { runtime: 'running' },
      { runtime: 'attention' }, { runtime: 'idle' },
      { runtime: 'completed' }, { runtime: 'failed' }, { runtime: 'unbound' },
    ],
  }));
  assert.strictEqual(s.runningCount, 2);
});

test('companion: a null/malformed employee entry does not crash the derivation', () => {
  const s = deriveCompanionState(snap({ employees: [null, undefined, { runtime: 'running' }, 'x'] }));
  assert.strictEqual(s.runningCount, 1);
});

test('companion: non-array pending/employees are treated as empty', () => {
  const s = deriveCompanionState(snap({ pending: 'nope', employees: {} }));
  assert.strictEqual(s.pendingCount, 0);
  assert.strictEqual(s.runningCount, 0);
  assert.strictEqual(s.available, true);
});

// ====================================== 0 待办不告警（产品纪律）

test('companion: zero pending NEVER raises attention', () => {
  // 一个永远亮红点的常驻图标 = 一个被无视的图标。
  for (const employees of [[], [{ runtime: 'running' }], [{ runtime: 'failed' }]]) {
    const s = deriveCompanionState(snap({ pending: [], employees }));
    assert.strictEqual(s.hasAttention, false, 'attention must come only from real pending work');
  }
});

test('companion: running work does NOT count as "needs you" (no false alarm)', () => {
  const s = deriveCompanionState(snap({ employees: [{ runtime: 'running' }], pending: [] }));
  assert.strictEqual(s.hasAttention, false);
  assert.strictEqual(companionSummary(s).kind, 'working', 'running is reassurance, not a call to action');
});

test('companion: any pending item DOES raise attention', () => {
  const s = deriveCompanionState(snap({ pending: [{ id: 'a' }] }));
  assert.strictEqual(s.hasAttention, true);
  assert.strictEqual(companionSummary(s).kind, 'needs-you');
});

// ============================================================ summary 优先级

test('companion: "needs you" outranks "working"', () => {
  // 有待办时先说要办的事，而不是"它还在跑"。
  const s = deriveCompanionState(snap({
    pending: [{ id: 'a' }],
    employees: [{ runtime: 'running' }, { runtime: 'running' }],
  }));
  const sm = companionSummary(s);
  assert.strictEqual(sm.kind, 'needs-you');
  assert.strictEqual(sm.pendingCount, 1);
  assert.strictEqual(sm.runningCount, 2, 'running info is still available, just not the headline');
});

test('companion: summary carries the numbers the UI needs (no UI-side recomputation)', () => {
  // 渲染层不算数——它只显示。这样小窗和面板永远一致。
  const s = deriveCompanionState(snap({ pending: [{ id: 'a' }, { id: 'b' }] }));
  const sm = companionSummary(s);
  assert.strictEqual(typeof sm.pendingCount, 'number');
  assert.strictEqual(typeof sm.runningCount, 'number');
  assert.ok(['idle', 'working', 'needs-you', 'disconnected'].includes(sm.kind));
});

// ============================================================ 纯函数

test('companion: the same snapshot always yields the same state (form does not reset data)', () => {
  // 「不丢状态」的第三层含义：派生是纯函数，窗口形态变化不影响数据。
  const s = snap({ pending: [{ id: 'a' }], employees: [{ runtime: 'running' }] });
  const a = deriveCompanionState(s);
  const b = deriveCompanionState(s);
  assert.deepStrictEqual(a, b);
});

test('companion: it does not mutate the input snapshot', () => {
  const s = snap({ pending: [{ id: 'a' }], employees: [{ runtime: 'running' }] });
  const frozen = JSON.stringify(s);
  deriveCompanionState(s);
  assert.strictEqual(JSON.stringify(s), frozen);
});
