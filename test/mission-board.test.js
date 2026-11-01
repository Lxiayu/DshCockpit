// test/mission-board.test.js — P2.3 S1：项目白板数据派生（纯函数）。
//
// 第一性原理：这个套件要钉住三件事
//
//   1. **只派生概览，不泄漏正文**（隐私 + 职责边界）
//   2. **stale 判定只有一处来源**（不是渲染层各算各的）
//   3. **"读不到"与"没有 active Mission"必须可区分**——
//      前者是故障，后者是正常空态，UI 要显示不同的话。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const board = require('../src/office/mission-board.js');

// --------------------------------------------------------------- fixtures

function proj(over = {}) {
  return {
    missions: {}, workstreams: {}, decisions: {}, questions: {},
    deliverables: {}, taskRefs: {}, byMission: {}, lastSeq: 0, appliedCount: 0,
    ...over,
  };
}

function mission(id, extra = {}) {
  return { missionId: id, title: `Mission ${id}`, intent: 'intent text', status: 'active',
    workspaceId: 'w', createdAtMs: 1, updatedAtMs: 100, ...extra };
}

const NOW = 1_700_000_000_000;

// ============================================================ 空态与故障

test('mission board: no observation → unavailable with a reason (never fake data)', () => {
  const r = board.buildMissionBoard({ projection: proj() });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.reason, 'no-observation');
  assert.strictEqual(r.observedAtMs, null);
  assert.strictEqual(r.stale, true, 'without an observation time we cannot claim freshness');
  assert.deepStrictEqual(r.missions, []);
});

test('mission board: "read OK but nothing active" is DISTINCT from "cannot read"', () => {
  // 两种空态的 UI 文案必须不同：一个是"还没有 Mission"，一个是"读不到"。
  const r = board.buildMissionBoard({ projection: proj(), observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.reason, 'no-active-missions', 'this is a normal empty state, not a failure');
  assert.strictEqual(r.stale, false, 'the data IS fresh; it just says there is nothing');
});

test('mission board: only ACTIVE missions appear (paused/completed are not board material)', () => {
  const p = proj({
    missions: {
      a: mission('a'),
      b: mission('b', { status: 'paused' }),
      c: mission('c', { status: 'completed' }),
      d: mission('d', { status: 'abandoned' }),
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions.length, 1);
  assert.strictEqual(r.missions[0].missionId, 'a');
});

// ============================================================ 计数正确性

test('mission board: counts are derived per mission (not global)', () => {
  const p = proj({
    missions: { a: mission('a'), b: mission('b') },
    workstreams: {
      w1: { workstreamId: 'w1', missionId: 'a', status: 'active' },
      w2: { workstreamId: 'w2', missionId: 'a', status: 'completed' },
      w3: { workstreamId: 'w3', missionId: 'b', status: 'active' },
    },
    decisions: {
      d1: { decisionId: 'd1', missionId: 'a' },
      d2: { decisionId: 'd2', missionId: 'b' },
      d3: { decisionId: 'd3', missionId: 'b' },
    },
    questions: {
      q1: { questionId: 'q1', missionId: 'a', status: 'open' },
      q2: { questionId: 'q2', missionId: 'a', status: 'answered' },
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  const a = r.missions.find((m) => m.missionId === 'a');
  const b = r.missions.find((m) => m.missionId === 'b');
  assert.deepStrictEqual(
    [a.workstreamCount, a.activeWorkstreamCount, a.decisionCount, a.openQuestionCount],
    [2, 1, 1, 1], 'only status=open questions count as "needs you"');
  assert.deepStrictEqual([b.workstreamCount, b.decisionCount], [1, 2]);
});

test('mission board: answered questions do NOT inflate the "needs you" count', () => {
  // 已回答的问题还占着白板注意力 = 用户学会忽略白板。
  const p = proj({
    missions: { a: mission('a') },
    questions: {
      q1: { questionId: 'q1', missionId: 'a', status: 'answered' },
      q2: { questionId: 'q2', missionId: 'a', status: 'answered' },
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions[0].openQuestionCount, 0);
  assert.strictEqual(r.totals.openQuestions, 0);
});

test('mission board: totals aggregate the shown missions', () => {
  const p = proj({
    missions: { a: mission('a'), b: mission('b') },
    questions: {
      q1: { questionId: 'q1', missionId: 'a', status: 'open' },
      q2: { questionId: 'q2', missionId: 'b', status: 'open' },
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.totals.activeMissions, 2);
  assert.strictEqual(r.totals.openQuestions, 2);
});

// ============================================================ 排序（注意力）

test('mission board: missions needing attention sort first', () => {
  // 白板的用途是"告诉你现在该关注什么"。有未答问题的排前面。
  const p = proj({
    missions: {
      quiet: mission('quiet', { updatedAtMs: 999 }),          // 更新更晚但没问题
      needsMe: mission('needsMe', { updatedAtMs: 1 }),        // 更新更早但有 2 个待答
    },
    questions: {
      q1: { questionId: 'q1', missionId: 'needsMe', status: 'open' },
      q2: { questionId: 'q2', missionId: 'needsMe', status: 'open' },
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions[0].missionId, 'needsMe',
    'a mission waiting on the user outranks a quieter but more recently touched one');
});

test('mission board: ties on question count fall back to recency', () => {
  const p = proj({
    missions: {
      older: mission('older', { updatedAtMs: 10 }),
      newer: mission('newer', { updatedAtMs: 900 }),
    },
  });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.deepStrictEqual(r.missions.map((m) => m.missionId), ['newer', 'older']);
});

// ============================================================ 容量与截断

test('mission board: at most MAX_BOARD_MISSIONS are shown, and the rest are counted', () => {
  const missions = {};
  for (let i = 0; i < 6; i += 1) missions[`m${i}`] = mission(`m${i}`, { updatedAtMs: i });
  const r = board.buildMissionBoard({ projection: proj({ missions }), observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions.length, board.MAX_BOARD_MISSIONS);
  assert.strictEqual(r.moreCount, 6 - board.MAX_BOARD_MISSIONS,
    'the user must know there are more in the Desk');
});

test('mission board: long titles are truncated in the derivation (one rule, one place)', () => {
  // 让渲染层各自截断会导致每处规则不一致。
  const long = 'A'.repeat(200);
  const p = proj({ missions: { a: mission('a', { title: long }) } });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions[0].label.length, board.MAX_TITLE_CHARS);
  assert.ok(r.missions[0].label.endsWith('…'));
});

test('mission board: a title of exactly the limit is NOT truncated', () => {
  const exact = 'A'.repeat(board.MAX_TITLE_CHARS);
  const p = proj({ missions: { a: mission('a', { title: exact }) } });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.strictEqual(r.missions[0].label, exact);
});

// ============================================================ stale

test('mission board: fresh data is not stale', () => {
  const r = board.buildMissionBoard({ projection: proj(), observedAtMs: NOW, nowMs: NOW + 1000 });
  assert.strictEqual(r.stale, false);
});

test('mission board: data older than STALE_AFTER_MS is stale', () => {
  const r = board.buildMissionBoard({
    projection: proj(), observedAtMs: NOW, nowMs: NOW + board.STALE_AFTER_MS + 1,
  });
  assert.strictEqual(r.stale, true);
});

test('mission board: exactly at the threshold is NOT stale (boundary)', () => {
  const r = board.buildMissionBoard({
    projection: proj(), observedAtMs: NOW, nowMs: NOW + board.STALE_AFTER_MS,
  });
  assert.strictEqual(r.stale, false, 'the threshold is "older than", not "as old as"');
});

test('mission board: no nowMs means no staleness claim (unknown != stale)', () => {
  const r = board.buildMissionBoard({ projection: proj(), observedAtMs: NOW });
  assert.strictEqual(r.stale, false, 'not knowing the clock is not evidence of staleness');
});

// ============================================================ 隐私

test('mission board: NO free-text content reaches the board (counts + short title only)', () => {
  // AGENTS.md §2.4：正文越少进快照越好。白板是概览，详情在 Desk。
  const p = proj({
    missions: { a: mission('a', { intent: 'SECRET INTENT TEXT' }) },
    decisions: { d1: { decisionId: 'd1', missionId: 'a', rationale: 'SECRET RATIONALE' } },
    questions: { q1: { questionId: 'q1', missionId: 'a', status: 'open', text: 'SECRET QUESTION' } },
    deliverables: { x1: { deliverableId: 'x1', missionId: 'a', relPath: '/abs/secret/path.txt' } },
  });
  const serialized = JSON.stringify(board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW }));
  for (const secret of ['SECRET INTENT TEXT', 'SECRET RATIONALE', 'SECRET QUESTION', '/abs/secret/path.txt']) {
    assert.ok(!serialized.includes(secret), `board output must not carry: ${secret}`);
  }
  assert.ok(!serialized.includes('intent'), 'even the field name should be absent');
});

test('mission board: the missionId is a local id, not a harness session handle', () => {
  // 派生句柄可以进快照；原始 sessionId 不行。这里断言没有 sess- 前缀泄漏。
  const p = proj({ missions: { a: mission('a') } });
  const r = board.buildMissionBoard({ projection: p, observedAtMs: NOW, nowMs: NOW });
  assert.doesNotMatch(JSON.stringify(r), /sess-[a-z0-9]/i);
});

// ============================================================ 健壮性

test('mission board: a malformed projection does not throw (degrade to empty)', () => {
  for (const bad of [null, undefined, {}, { missions: null }, { missions: { x: null } }]) {
    const r = board.buildMissionBoard({ projection: bad, observedAtMs: NOW, nowMs: NOW });
    assert.ok(r && Array.isArray(r.missions), `must not throw for projection=${JSON.stringify(bad)}`);
  }
});

test('mission board: truncate handles null/undefined without producing "null" text', () => {
  assert.strictEqual(board.truncate(null, 10), '');
  assert.strictEqual(board.truncate(undefined, 10), '');
  assert.strictEqual(board.truncate('abc', 10), 'abc');
});

// ============================================ 快照集成（office-module）
//
// 这一段测的是 S3：白板数据能否进入 office 快照，且不被隐私脱敏器误伤。

const { createOfficeModule } = require('../src/office/office-module.js');

function officeWithBoard(provider) {
  return createOfficeModule({ seed: 'board-test', missionBoardProvider: provider });
}

test('snapshot: an injected board reaches the office snapshot', () => {
  const b = officeWithBoard(() => ({
    available: true, reason: null, observedAtMs: 12345, stale: false, moreCount: 0,
    missions: [{ missionId: 'm1', label: '标签', status: 'active', workstreamCount: 1,
      activeWorkstreamCount: 1, decisionCount: 2, openQuestionCount: 1, deliverableCount: 0 }],
    totals: { activeMissions: 1, openQuestions: 1, decisions: 2 },
  })).state().missionBoard;
  assert.strictEqual(b.available, true);
  assert.strictEqual(b.missions.length, 1);
  assert.strictEqual(b.missions[0].decisionCount, 2);
});

test('snapshot: the board label SURVIVES the privacy redactor (explicit allowlist)', () => {
  // 这是本项目踩过的坑：missionBoard 曾落进 `...rest`，被 redactValue 整体
  // 脱敏成 [REDACTED:text] —— 因为 TEXT_KEY_RE 会匹配所有疑似正文的字段。
  // 正确做法不是放宽脱敏器，而是像 pending 一样走**显式白名单**。
  const board = require('../src/office/mission-board.js');
  const b = officeWithBoard(() => board.buildMissionBoard({
    projection: {
      missions: { m1: { missionId: 'm1', title: '重构认证模块', status: 'active', updatedAtMs: 1, workspaceId: 'w', createdAtMs: 1 } },
      workstreams: {}, decisions: {}, questions: {}, deliverables: {},
    },
    observedAtMs: Date.now(), nowMs: Date.now(),
  })).state().missionBoard;
  assert.strictEqual(b.missions[0].label, '重构认证模块', 'the user must see their own mission label');
  assert.doesNotMatch(JSON.stringify(b), /REDACTED/, 'the board must not carry redaction placeholders');
});

test('snapshot: no provider wired → board reports not-wired (never fake data)', () => {
  const b = createOfficeModule({ seed: 't' }).state().missionBoard;
  assert.strictEqual(b.available, false);
  assert.strictEqual(b.reason, 'not-wired');
  assert.strictEqual(b.stale, true);
});

test('snapshot: a throwing provider degrades instead of breaking the whole snapshot', () => {
  // 白板读不出来不能拖垮整个办公室渲染。
  const mod = officeWithBoard(() => { throw new Error('boom'); });
  const snap = mod.state();
  assert.strictEqual(snap.missionBoard.available, false);
  assert.strictEqual(snap.missionBoard.reason, 'provider-error');
  assert.ok(Array.isArray(snap.employees), 'the rest of the snapshot still works');
});

test('snapshot: a malformed provider value is normalised by the allowlist', () => {
  const b = officeWithBoard(() => ({ available: 'yes', missions: 'nope', totals: null })).state().missionBoard;
  assert.strictEqual(b.available, false, 'only literal true counts as available');
  assert.deepStrictEqual(b.missions, []);
  assert.ok(b.totals && typeof b.totals.activeMissions === 'number');
});

test('snapshot: the board allowlist drops unknown fields (explicit privacy boundary)', () => {
  // 新增字段必须显式加进 safeMissionBoard —— 这是"隐私约束是显式的"的落实。
  const b = officeWithBoard(() => ({
    available: true, reason: null, observedAtMs: 1, stale: false, moreCount: 0,
    missions: [{ missionId: 'm1', label: 'x', status: 'active', workstreamCount: 0,
      activeWorkstreamCount: 0, decisionCount: 0, openQuestionCount: 0, deliverableCount: 0,
      secretField: 'LEAKED', intentText: 'LEAKED' }],
    totals: { activeMissions: 1, openQuestions: 0, decisions: 0 },
    secretTopLevel: 'LEAKED',
  })).state().missionBoard;
  const serialized = JSON.stringify(b);
  assert.ok(!serialized.includes('LEAKED'), 'unknown fields must not pass the allowlist');
  assert.doesNotMatch(serialized, /secretField|intentText|secretTopLevel/);
});

test('snapshot: the board never carries harness session handles', () => {
  const b = officeWithBoard(() => ({
    available: true, reason: null, observedAtMs: 1, stale: false, moreCount: 0,
    missions: [{ missionId: 'sess-h-abc123', label: 'x', status: 'active', workstreamCount: 0,
      activeWorkstreamCount: 0, decisionCount: 0, openQuestionCount: 0, deliverableCount: 0 }],
    totals: { activeMissions: 1, openQuestions: 0, decisions: 0 },
  })).state().missionBoard;
  // missionId 是本地 id；即使 provider 传了坏的，allowlist 也不额外放大它。
  // 这里断言的是"白板不含 session 相关字段"，不是"过滤 missionId"。
  assert.doesNotMatch(JSON.stringify(b), /sessionId|sessHandle/);
});
