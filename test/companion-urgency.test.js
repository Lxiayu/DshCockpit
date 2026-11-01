// test/companion-urgency.test.js — Companion 的紧急度派生（P4）。
//
// 第一性原理：这个字段的唯一价值是"帮用户决定要不要中断当前工作"
//
//   如果它只是"数量多就急"，那它就是**编造状态**——
//   因为 3 件低风险提问和 1 件高风险审批的紧急程度完全相反。
//
//   所以本文件最重要的一条是：**urgent 必须来自 high risk，而不是数量**。
//   以及反直觉但同样重要的一条：**"later" 比 "urgent" 更有价值**——
//   "紧急"用户自己看得见红点，"可以稍后"是他自己判断不出来的。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  deriveCompanionState, companionSummary, deriveUrgency, URGENCIES, LATER_AFTER_MS,
} = require('../src/companion-state.js');

const NOW = 1_800_000_000_000; // 固定时间，避免测试随真实时钟漂移
const snap = (over = {}) => ({ pending: [], employees: [], ...over });

// ============================================ urgent 来自 risk，不来自数量

test('urgency: a HIGH risk pending makes it urgent', () => {
  assert.strictEqual(deriveUrgency([{ risk: 'high', createdAtMs: NOW }], NOW), 'urgent');
});

test('urgency: MANY low-risk items are NOT urgent (count is not urgency)', () => {
  // 这条是本设计的核心：如果按数量判，10 件低风险会被误报成紧急。
  const many = Array.from({ length: 10 }, () => ({ risk: 'low', createdAtMs: NOW }));
  assert.strictEqual(deriveUrgency(many, NOW), 'normal');
});

test('urgency: one high risk among many low ones still wins', () => {
  const list = [
    { risk: 'low', createdAtMs: NOW }, { risk: 'low', createdAtMs: NOW },
    { risk: 'high', createdAtMs: NOW },
  ];
  assert.strictEqual(deriveUrgency(list, NOW), 'urgent');
});

// ============================================ later：最有价值的一档

test('urgency: old low-risk items are marked "later" (permission to not interrupt)', () => {
  // 用户看不到 risk 与等待时长。告诉他"可以放着"是这个功能的主要价值。
  const old = [{ risk: 'low', createdAtMs: NOW - LATER_AFTER_MS - 1000 }];
  assert.strictEqual(deriveUrgency(old, NOW), 'later');
});

test('urgency: fresh low-risk items are NOT "later" yet', () => {
  // 刚来的东西标"可以稍后"是误导——用户可能正想处理。
  const fresh = [{ risk: 'low', createdAtMs: NOW - 1000 }];
  assert.strictEqual(deriveUrgency(fresh, NOW), 'normal');
});

test('urgency: a mixed set with any medium does NOT become "later"', () => {
  // "later" 是强判断（建议用户别管），只允许在全是低风险时才下。
  const mixed = [
    { risk: 'low', createdAtMs: NOW - LATER_AFTER_MS - 1000 },
    { risk: 'medium', createdAtMs: NOW - LATER_AFTER_MS - 1000 },
  ];
  assert.strictEqual(deriveUrgency(mixed, NOW), 'normal');
});

test('urgency: "later" uses the OLDEST item, not the newest', () => {
  // 一批里有一条等了很久，整体就该算久——用 min/max 判断错了会误导。
  const list = [
    { risk: 'low', createdAtMs: NOW - 1000 },              // 刚来
    { risk: 'low', createdAtMs: NOW - LATER_AFTER_MS - 1 }, // 等了很久
  ];
  assert.strictEqual(deriveUrgency(list, NOW), 'later');
});

// ============================================ null / normal

test('urgency: no pending → null (not "normal" — there is nothing to judge)', () => {
  assert.strictEqual(deriveUrgency([], NOW), null);
  assert.strictEqual(deriveUrgency(null, NOW), null);
  assert.strictEqual(deriveUrgency('nope', NOW), null);
});

test('urgency: missing timestamps degrade to normal (never crash, never guess)', () => {
  // 拿不到时间就不能判"等了很久"——不确定时宁可中性，不要编造。
  assert.strictEqual(deriveUrgency([{ risk: 'low' }], NOW), 'normal');
});

test('urgency: the three values are exactly what the UI expects', () => {
  assert.deepStrictEqual([...URGENCIES], ['urgent', 'normal', 'later']);
});

// ============================================ 与 state 的整合

test('urgency: deriveCompanionState carries urgency through', () => {
  const st = deriveCompanionState(snap({ pending: [{ risk: 'high', createdAtMs: NOW }] }), NOW);
  assert.strictEqual(st.urgency, 'urgent');
  assert.strictEqual(companionSummary(st).urgency, 'urgent');
});

test('urgency: it is null when there is nothing pending', () => {
  const st = deriveCompanionState(snap(), NOW);
  assert.strictEqual(st.urgency, null);
  assert.strictEqual(companionSummary(st).urgency, null);
});

test('urgency: a disconnected widget has no urgency (it does not know anything)', () => {
  const st = deriveCompanionState(null);
  assert.strictEqual(st.urgency, null);
  assert.strictEqual(companionSummary(st).urgency, null);
});

test('urgency: it never overrides the four-state kind', () => {
  // data-kind 决定颜色语义；urgency 只是强度。两者不能互相覆盖。
  const working = deriveCompanionState(snap({ employees: [{ runtime: 'running' }] }), NOW);
  assert.strictEqual(working.urgency, null, 'running work is not "needs you"');
  assert.strictEqual(companionSummary(working).kind, 'working');
});

// ============================================ 派生是纯函数

test('urgency: same snapshot + same clock → same answer', () => {
  const s = snap({ pending: [{ risk: 'low', createdAtMs: NOW - 1 }] });
  assert.strictEqual(
    deriveCompanionState(s, NOW).urgency,
    deriveCompanionState(s, NOW).urgency,
  );
});
