// test/mission-rail-order.test.js — 右栏"需要你"的分级与排序（S7 数据层）。
//
// 第一性原理：右栏 380px 首屏只放得下 2-3 项，"哪几项占这几格"就是产品本身。
//
//   2026-11-03 诊断出的病根之一：「如果所有东西都标红，用户会学会无视红色」。
//   所以这里钉死两条：
//     1. 只有**阻塞团队**的事进"需要你"（decision 层）
//     2. 提醒（reminder 层）不能混进决策计数，否则第一层被稀释
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rail = require('../src/mission/rail-order.js');

function item(kind, over = {}) {
  return { kind, createdAtMs: 1000, risk: 'medium', ...over };
}

test('rail: only blocking kinds count as "needs you"', () => {
  assert.equal(rail.classifyAttentionItem(item('approval')), 'decision');
  assert.equal(rail.classifyAttentionItem(item('question')), 'decision');
  assert.equal(rail.classifyAttentionItem(item('plan-review')), 'decision');
  assert.equal(rail.classifyAttentionItem(item('conflict')), 'decision');
});

test('rail: non-blocking signals are reminders, NOT decisions', () => {
  // 这一条是"红色泛滥"的直接防线：inbox / blocked / stale-owner
  // 都不阻塞人，不能进决策计数。
  for (const kind of ['inbox', 'permission-risk', 'blocked', 'stale-owner']) {
    assert.equal(rail.classifyAttentionItem(item(kind)), 'reminder', kind);
  }
});

test('rail: an unknown kind is dropped, not guessed into a layer', () => {
  assert.equal(rail.classifyAttentionItem(item('some-future-kind')), null);
  assert.equal(rail.classifyAttentionItem(null), null);
  const r = rail.orderAttentionItems([item('approval'), item('mystery')]);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.dropped.length, 1, 'unknown kinds are surfaced to the caller, not silently shown');
});

test('rail: within decisions, risk beats age', () => {
  // 一个 high 风险的审批应该排在更早的 medium 提问之前：
  // 提问不会造成不可逆后果，高风险动作会。
  const oldMedium = item('question', { risk: 'medium', createdAtMs: 100 });
  const newHigh = item('approval', { risk: 'high', createdAtMs: 900 });
  const r = rail.orderAttentionItems([oldMedium, newHigh]);
  assert.equal(r.decisions[0].kind, 'approval');
  assert.equal(r.decisions[1].kind, 'question');
});

test('rail: same risk → older first (cost is accumulating)', () => {
  const older = item('question', { risk: 'medium', createdAtMs: 100 });
  const newer = item('question', { risk: 'medium', createdAtMs: 900 });
  const r = rail.orderAttentionItems([newer, older]);
  assert.equal(r.decisions[0].createdAtMs, 100);
});

test('rail: missing risk is treated as medium, never as low', () => {
  // 把"未知风险"当低风险会让它排到最后 —— 那是拿猜测当事实。
  const unknownRisk = { kind: 'approval', createdAtMs: 1000 };
  const high = item('approval', { risk: 'high', createdAtMs: 2000 });
  const r = rail.orderAttentionItems([unknownRisk, high]);
  assert.equal(r.decisions[0].risk, 'high', 'high still wins');
  // 未知风险与 medium 同级：应该按时间排在 high 之后、low 之前
  const low = item('approval', { risk: 'low', createdAtMs: 500 });
  const r2 = rail.orderAttentionItems([low, unknownRisk]);
  assert.equal(r2.decisions[0].createdAtMs, 1000, 'unknown-risk sorts ahead of explicit low');
});

test('rail: reminders sort by age only and never appear in decision counts', () => {
  const out = rail.assembleRailAttention({
    items: [item('inbox', { createdAtMs: 300 }), item('blocked', { createdAtMs: 100 })],
  });
  assert.equal(out.header.decisionCount, 0);
  assert.equal(out.header.reminderCount, 2);
  assert.equal(out.header.tone, 'calm', 'reminders alone are not a "blocked" state');
  assert.equal(out.visible.decisions.length, 0);
});

test('rail: tone is blocked only when a decision is pending', () => {
  const withDecision = rail.assembleRailAttention({ items: [item('approval')] });
  assert.equal(withDecision.header.tone, 'blocked');
});

test('rail: the first screen caps decisions and reports the overflow', () => {
  const items = Array.from({ length: 7 }, (_, i) => item('approval', { createdAtMs: i }));
  const out = rail.assembleRailAttention({ items, maxDecisions: 3 });
  assert.equal(out.visible.decisions.length, 3);
  assert.equal(out.overflow.decisions, 4, 'the hidden ones must be counted, not lost');
  assert.equal(out.header.decisionCount, 7, 'the header says the TRUE total');
});

test('rail: empty state appears ONLY when nothing at all is pending', () => {
  // "有提醒但不需要决策"不是空态 —— 说"团队运行正常"会掩盖提醒。
  const nothing = rail.assembleRailAttention({ items: [] });
  assert.ok(nothing.empty);
  assert.match(nothing.empty.text, /运行正常/);

  const reminderOnly = rail.assembleRailAttention({ items: [item('inbox')] });
  assert.equal(reminderOnly.empty, null, 'a reminder means "not nothing"');

  const decision = rail.assembleRailAttention({ items: [item('approval')] });
  assert.equal(decision.empty, null);
});

test('rail: a stopped/absent data source must not render as "all clear"', () => {
  // 这一条防的是最危险的空态：数据源没连上时显示"团队运行正常"。
  // 调用方传 null/undefined 表示"不知道"，此时不应产生 empty 文案。
  const unknown = rail.assembleRailAttention({ items: undefined });
  assert.equal(unknown.header.tone, 'unknown',
    'no data is not "calm" — the caller must render "未连接"');
  assert.equal(unknown.empty, null);
});

test('rail: degenerate items never throw', () => {
  assert.doesNotThrow(() => rail.orderAttentionItems(null));
  assert.doesNotThrow(() => rail.orderAttentionItems([null, 42, 'x']));
  assert.doesNotThrow(() => rail.assembleRailAttention());
  assert.deepEqual(rail.orderAttentionItems(null).decisions, []);
});

test('rail: vocabularies are closed and exported', () => {
  assert.deepEqual([...rail.DECISION_KINDS], ['approval', 'question', 'plan-review', 'conflict']);
  assert.deepEqual([...rail.REMINDER_KINDS], ['inbox', 'permission-risk', 'blocked', 'stale-owner']);
  // 两个集合不能有交集，否则同一条待办会有两种身份
  for (const k of rail.DECISION_KINDS) {
    assert.equal(rail.REMINDER_KINDS.includes(k), false, `${k} must not be in both layers`);
  }
});
