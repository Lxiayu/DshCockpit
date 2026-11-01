// test/office-mission-board.test.js — P2.3 S3：白板快照的隐私白名单。
//
// 第一性原理：为什么白名单必须被单独测试
//
//   这是本项目踩过的真实坑：missionBoard 曾放在快照的 `...rest` 里，
//   被 redactor.redactValue(rest) 整体脱敏 → 标签变成 [REDACTED:text]。
//
//   两个方向都错：
//     · 直接透传 → 未来 provider 加个 intentText 字段就泄漏正文
//     · 依赖脱敏器 → 用户看不到自己的 Mission 标签
//
//   白名单是唯一的正确形态：**能进快照的字段由一个可审查的列表决定**。
//   本套件钉住这个列表的两个性质：未知字段被丢弃、已知字段不被误伤。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const m = require('../src/office/office-mission-board.js');

// --------------------------------------------------------------- 形状

test('board allowlist: the field lists are frozen (a change must be deliberate)', () => {
  assert.ok(Object.isFrozen(m.ALLOWED_BOARD_FIELDS));
  assert.ok(Object.isFrozen(m.ALLOWED_MISSION_FIELDS));
  assert.ok(Object.isFrozen(m.EMPTY_BOARD));
});

test('board allowlist: a missing/malformed input yields the empty board', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const out = m.safeMissionBoard(bad);
    assert.strictEqual(out.available, false);
    assert.deepStrictEqual(out.missions, []);
    assert.strictEqual(out.stale, true);
  }
});

test('board allowlist: only literal true counts as available', () => {
  assert.strictEqual(m.safeMissionBoard({ available: 'yes' }).available, false);
  assert.strictEqual(m.safeMissionBoard({ available: 1 }).available, false);
  assert.strictEqual(m.safeMissionBoard({ available: true }).available, true);
});

// ------------------------------------------------- 未知字段必须被丢弃

test('board allowlist: unknown TOP-LEVEL fields are dropped', () => {
  const out = m.safeMissionBoard({
    available: true, reason: null, observedAtMs: 1, stale: false, moreCount: 0,
    missions: [], totals: { activeMissions: 0, openQuestions: 0, decisions: 0 },
    intentText: 'SECRET', rawPrompt: 'SECRET', absolutePath: '/secret',
  });
  const keys = Object.keys(out);
  for (const k of ['intentText', 'rawPrompt', 'absolutePath']) {
    assert.ok(!keys.includes(k), `${k} must not pass the allowlist`);
  }
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('board allowlist: unknown MISSION fields are dropped', () => {
  const out = m.safeMissionBoard({
    available: true, missions: [{
      missionId: 'm1', label: 'x', status: 'active',
      workstreamCount: 0, activeWorkstreamCount: 0, decisionCount: 0,
      openQuestionCount: 0, deliverableCount: 0,
      rationale: 'SECRET', sessionId: 'sess-h-abc', relPath: '/abs/secret',
    }],
  });
  const mission = out.missions[0];
  for (const k of ['rationale', 'sessionId', 'relPath']) {
    assert.ok(!(k in mission), `${k} must not pass the mission allowlist`);
  }
  assert.doesNotMatch(JSON.stringify(out), /sess-h-abc|SECRET/);
});

test('board allowlist: the top-level key set is EXACTLY the allowlist', () => {
  // 精确相等而不是"包含" —— 新增字段必须同时改这里和白名单，
  // 那正是"显式决定"的意义。
  const out = m.safeMissionBoard({ available: true, missions: [], totals: {} });
  assert.deepStrictEqual(Object.keys(out).sort(), [...m.ALLOWED_BOARD_FIELDS].sort());
});

test('board allowlist: the mission key set is EXACTLY the allowlist', () => {
  const out = m.safeMissionBoard({ available: true, missions: [{ missionId: 'm1' }], totals: {} });
  assert.deepStrictEqual(Object.keys(out.missions[0]).sort(), [...m.ALLOWED_MISSION_FIELDS].sort());
});

// ------------------------------------------------- 已知字段不被误伤

test('board allowlist: the label passes through intact (not redacted)', () => {
  // 这条是那个坑的直接回归保护。
  const out = m.safeMissionBoard({
    available: true, missions: [{ missionId: 'm1', label: '重构认证模块' }], totals: {},
  });
  assert.strictEqual(out.missions[0].label, '重构认证模块');
  assert.doesNotMatch(JSON.stringify(out), /REDACTED/);
});

test('board allowlist: numeric fields degrade to 0 (never NaN in the snapshot)', () => {
  const out = m.safeMissionBoard({
    available: true, moreCount: 'many',
    missions: [{ missionId: 'm1', workstreamCount: 'x', decisionCount: null }], totals: {},
  });
  assert.strictEqual(out.moreCount, 0);
  assert.strictEqual(out.missions[0].workstreamCount, 0);
  assert.strictEqual(out.missions[0].decisionCount, 0);
});

test('board allowlist: an over-long label is truncated again (defence in depth)', () => {
  const out = m.safeMissionBoard({
    available: true, missions: [{ missionId: 'm1', label: 'A'.repeat(500) }], totals: {},
  });
  assert.strictEqual(out.missions[0].label.length, m.MAX_LABEL_CHARS);
});

test('board allowlist: at most BOARD_MISSION_LIMIT missions pass through', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ missionId: `m${i}` }));
  const out = m.safeMissionBoard({ available: true, missions: many, totals: {} });
  assert.strictEqual(out.missions.length, m.BOARD_MISSION_LIMIT);
});

test('board allowlist: totals always has numeric fields (consumers can do math)', () => {
  for (const bad of [null, 'x', {}, { activeMissions: 'nope' }]) {
    const out = m.safeMissionBoard({ available: true, totals: bad });
    for (const k of ['activeMissions', 'openQuestions', 'decisions']) {
      assert.strictEqual(typeof out.totals[k], 'number', `totals.${k} must be a number`);
    }
  }
});

test('board allowlist: null/undefined label becomes an empty string, not "null"', () => {
  const out = m.safeMissionBoard({ available: true, missions: [{ missionId: 'm1', label: null }], totals: {} });
  assert.strictEqual(out.missions[0].label, '');
});
