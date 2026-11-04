// test/mission-team-reconcile.test.js — 合同 ↔ 团队任务板对账。
//
// 第一性原理：为什么需要它，尽管两侧各自都"有数据"
//
//   合同说"要做 A、B、C 三条验收"，团队任务板上可能只有 1 条。
//   两边都不报错 —— 但合起来意味着**团队只承诺了一件、漏了两件**。
//   用户看到的是一支"在忙"的团队，而没人告诉他承诺与执行对不上。
//
//   所以这里把两个事实源摆在一起，**只陈述差异、不判定对错**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rec = require('../src/mission/reconcile.js');

function contract(...texts) {
  return { status: 'dispatching', acceptance: texts.map((t, i) => ({ id: 'a' + i, text: t, kind: 'manual' })) };
}
function team(tasks, members = [{ id: 'm0', name: 'lead', role: 'lead', phase: 'active' }]) {
  return { members, tasks };
}

test('reconcile: every acceptance covered by some task', () => {
  const r = rec.reconcileTeam({
    contract: contract('实现派发确认', '写文档'),
    team: team([
      { id: 't1', subject: '实现派发确认', status: 'completed' },
      { id: 't2', subject: '写文档', status: 'in_progress' },
    ]),
  });
  assert.equal(r.available, true);
  assert.equal(r.acceptance.total, 2);
  assert.equal(r.acceptance.covered, 2);
  assert.deepEqual(r.acceptance.missing, []);
  assert.deepEqual(r.orphanTasks, []);
});

test('reconcile: an acceptance with NO matching task is reported as missing, not "done"', () => {
  const r = rec.reconcileTeam({
    contract: contract('实现派发确认', '写文档', '写测试'),
    team: team([{ id: 't1', subject: '实现派发确认', status: 'in_progress' }]),
  });
  assert.equal(r.acceptance.covered, 1);
  assert.equal(r.acceptance.missing.length, 2);
  assert.deepEqual(r.acceptance.missing.map((m) => m.text), ['写文档', '写测试']);
  // 措辞不得暗示已完成
  const text = rec.describeTeamReconcile(r);
  assert.match(text, /没有对应任务/);
  assert.match(text, /不是"已完成"/);
});

test('reconcile: matching is literal and whitespace/case insensitive', () => {
  const r = rec.reconcileTeam({
    contract: contract('  NPM   Test 全绿 '),
    team: team([{ id: 't1', subject: 'npm test 全绿', status: 'pending' }]),
  });
  assert.equal(r.acceptance.covered, 1, 'whitespace and case must not break the match');
});

test('reconcile: a task NOT in the contract is listed as orphan (not judged as wrong)', () => {
  // 探索性工作、或跑偏了 —— 我们只陈述"它不在合同的验收里"，不判定对错。
  const r = rec.reconcileTeam({
    contract: contract('实现功能'),
    team: team([
      { id: 't1', subject: '实现功能', status: 'completed' },
      { id: 't2', subject: '顺手重构了日志', status: 'in_progress' },
    ]),
  });
  assert.equal(r.orphanTasks.length, 1);
  assert.equal(r.orphanTasks[0].subject, '顺手重构了日志');
});

test('reconcile: deleted tasks are ignored', () => {
  const r = rec.reconcileTeam({
    contract: contract('x'),
    team: team([
      { id: 't1', subject: 'x', status: 'deleted' },
      { id: 't2', subject: 'y', status: 'pending' },
    ]),
  });
  assert.equal(r.taskCount, 1, 'deleted tasks are not part of the picture');
});

test('reconcile: an UNREADABLE team projection is distinct from "no tasks"', () => {
  // 把"读不到"说成"没有任务"会让用户以为团队什么都没做。
  const r = rec.reconcileTeam({ contract: contract('x'), team: null });
  assert.equal(r.available, false);
  assert.match(r.reason, /读不到/);
  assert.equal(rec.describeTeamReconcile(r), r.reason);
});

test('reconcile: a contract with no acceptance says so plainly', () => {
  const r = rec.reconcileTeam({
    contract: { status: 'draft', acceptance: [] },
    team: team([{ id: 't1', subject: '随便做点什么', status: 'pending' }]),
  });
  assert.equal(r.available, true);
  assert.equal(r.acceptance.total, 0);
  const text = rec.describeTeamReconcile(r);
  assert.match(text, /还没有验收条件/);
});

test('reconcile: matching is conservative — no fuzzy false positives', () => {
  // 模糊匹配会产生"看起来覆盖了"的假阳性，那比漏报更糟（用户以为有保护）。
  const r = rec.reconcileTeam({
    contract: contract('实现完整的派发确认机制'),
    team: team([{ id: 't1', subject: '派发', status: 'pending' }]),
  });
  assert.equal(r.acceptance.covered, 0, 'a short task title must not count as covering a long criterion');
});

test('reconcile: matching also looks at the task description', () => {
  const r = rec.reconcileTeam({
    contract: contract('退出码 0'),
    team: team([{ id: 't1', subject: '跑测试', description: '要求 npm test 退出码 0', status: 'in_progress' }]),
  });
  assert.equal(r.acceptance.covered, 1);
});

test('reconcile: degenerate input never throws', () => {
  assert.doesNotThrow(() => rec.reconcileTeam());
  assert.doesNotThrow(() => rec.reconcileTeam({ contract: null, team: null }));
  assert.doesNotThrow(() => rec.reconcileTeam({ contract: {}, team: {} }));
  assert.doesNotThrow(() => rec.describeTeamReconcile(null));
  const r = rec.reconcileTeam({ contract: { acceptance: [null, {}, { text: '  ' }] }, team: team([]) });
  assert.equal(r.acceptance.total, 0, 'blank criteria are not real criteria');
});
