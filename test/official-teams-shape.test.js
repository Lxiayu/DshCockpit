// test/official-teams-shape.test.js — Issue #23：官方 Agent Teams 字段形状。
//
// 第一性原理：这个模块存在的唯一理由
//
//   官方 projection 的字段一旦变化，适配层会**静默读到 undefined**。
//   后果不是报错，是 Office 里少了一个员工——没人会立刻发现。
//
//   所以本文件的重点不是"能解析正常数据"，而是：
//     1. 缺字段要**报错**（不能静默继续）
//     2. 多字段要**容忍**（官方加字段不该让我们崩）
//     3. 未知枚举要**降级**（显示"未知"，而不是让成员消失）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const shape = require('../src/official-teams-shape.js');
const {
  validateTeamProjection, toOfficeTeamFacts,
  TEAM_MEMBER_FIELDS, TEAM_TASK_FIELDS, TEAM_PROJECTION_FIELDS,
  TEAM_MEMBER_PHASES, TEAM_TASK_STATUSES, TEAM_MEMBER_ROLES,
} = shape;

function projection(over = {}) {
  return {
    members: [
      { id: 'sess-1', name: 'Lead', role: 'lead', phase: 'active' },
      { id: 'sess-2', name: 'worker', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      { id: 't1', revision: 1, subject: 'A', description: 'd', status: 'completed',
        blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] },
    ],
    ...over,
  };
}

// ============================================ 常量与官方定义一致

test('teams shape: the constants match the official 0.2.1 type definitions', () => {
  // 这些值来自 @deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts
  assert.deepStrictEqual([...TEAM_PROJECTION_FIELDS], ['members', 'tasks', 'failure']);
  assert.deepStrictEqual([...TEAM_MEMBER_FIELDS], ['id', 'name', 'role', 'phase', 'error']);
  assert.deepStrictEqual([...TEAM_MEMBER_PHASES], ['provisioning', 'active', 'failed']);
  assert.deepStrictEqual([...TEAM_TASK_STATUSES], ['pending', 'in_progress', 'completed', 'deleted']);
  assert.deepStrictEqual([...TEAM_MEMBER_ROLES], ['lead', 'teammate']);
});

test('teams shape: TeamTaskView includes the runtime-enriched fields', () => {
  // ownerName / ready / writeScopeWarnings 是 runtime 增强的，不是持久化字段。
  for (const f of ['ownerName', 'ready', 'writeScopeWarnings']) {
    assert.ok(TEAM_TASK_FIELDS.includes(f), `${f} must be part of the task view contract`);
  }
});

// ============================================ 缺字段必须报错

test('teams shape: a projection missing members/tasks arrays is REJECTED', () => {
  assert.strictEqual(validateTeamProjection({}).ok, false);
  assert.strictEqual(validateTeamProjection({ members: [], tasks: 'x' }).ok, false);
});

test('teams shape: a member missing a required field is REJECTED (no silent undefined)', () => {
  // 这是本模块存在的核心理由。
  for (const missing of ['id', 'name', 'role', 'phase']) {
    const m = { id: 's', name: 'n', role: 'lead', phase: 'active' };
    delete m[missing];
    const r = validateTeamProjection({ members: [m], tasks: [] });
    assert.strictEqual(r.ok, false, `a member without "${missing}" must be rejected`);
    assert.ok(r.errors.some((e) => e.includes(missing)));
  }
});

test('teams shape: a task missing id/subject/status is REJECTED', () => {
  for (const missing of ['id', 'subject', 'status']) {
    const t = { id: 't', subject: 's', status: 'pending' };
    delete t[missing];
    assert.strictEqual(validateTeamProjection({ members: [], tasks: [t] }).ok, false);
  }
});

// ============================================ 多字段要容忍

test('teams shape: EXTRA fields from a future runtime are tolerated, not fatal', () => {
  // 官方加字段不该让适配层崩。
  const p = projection();
  p.members[0].futureField = 1;
  p.newTopLevel = true;
  assert.strictEqual(validateTeamProjection(p).ok, true);
});

// ============================================ 未知枚举要降级

test('teams shape: an unknown phase degrades to "unknown" (member does NOT disappear)', () => {
  const r = validateTeamProjection({
    members: [{ id: 's', name: 'n', role: 'teammate', phase: 'zombie' }], tasks: [],
  });
  assert.strictEqual(r.ok, true, 'an unknown enum must not break parsing');
  assert.strictEqual(r.value.members[0].phase, 'unknown');
  assert.ok(r.warnings.length > 0, 'it must warn, not stay silent');
});

test('teams shape: an unknown task status degrades to "unknown"', () => {
  const r = validateTeamProjection({
    members: [], tasks: [{ id: 't', subject: 's', status: 'archived' }],
  });
  assert.strictEqual(r.value.tasks[0].status, 'unknown');
});

test('teams shape: the optional `failure` field is surfaced, not swallowed', () => {
  const r = validateTeamProjection(projection({ failure: 'rejected persisted record' }));
  assert.strictEqual(r.value.failure, 'rejected persisted record');
});

// ============================================ 隐私投影

test('teams shape: office facts carry NO raw session ids (privacy boundary)', () => {
  // product-principles §2.4：raw sessionId 不进 Office 快照。
  const f = toOfficeTeamFacts(projection()).facts;
  const json = JSON.stringify(f);
  assert.ok(!json.includes('sess-1'), 'member ids must not leak into office facts');
  assert.ok(!json.includes('Lead'), 'member names must not leak into office facts');
});

test('teams shape: office facts are counts only (that is all Office needs)', () => {
  const f = toOfficeTeamFacts(projection({ failure: 'boom' })).facts;
  assert.strictEqual(f.memberCount, 2);
  assert.strictEqual(f.phaseCounts.active, 2);
  assert.strictEqual(f.taskCounts.completed, 1);
  assert.strictEqual(f.hasFailure, true, 'a failure is what Office should surface as "needs you"');
});

test('teams shape: invalid input yields no facts (never partial data)', () => {
  const r = toOfficeTeamFacts({ members: 'nope', tasks: [] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.facts, null);
});

test('teams shape: an empty team is valid and yields zero counts', () => {
  const r = toOfficeTeamFacts({ members: [], tasks: [] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.facts.memberCount, 0);
  assert.strictEqual(r.facts.hasFailure, false);
});
