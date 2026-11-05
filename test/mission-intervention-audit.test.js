// test/mission-intervention-audit.test.js — 人类干预审计（S6 基础）。
//
// 第一性原理：这组测试守的是"审计日志不能变成泄露面"
//
//   干预是产品里权力最不对称的动作（点一下就能停掉整支团队）。
//   它必须留痕，否则出事时无法回答"谁/何时/停之前团队在做什么"。
//
//   但留痕有两种做法，只有一种对：
//     ✗ 记内容和上下文 → 审计本身变成泄露面（违反 repo-map.md §2.4）
//     ✓ 记动作 + 目标 + 闭集原因 + 时间 → 足够追责，不可能泄露正文
//
//   所以这里除了测功能，更要测**拒绝**：闭集之外的动作/原因必须被拒，
//   自由文本字段必须不存在。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const audit = require('../src/mission/intervention-audit.js');

test('audit: an allowed action produces only closed-set fields', () => {
  const e = audit.buildAuditEntry({
    action: 'member.interrupted',
    reason: 'drift-suspected',
    missionId: 'mis-a',
    memberName: 'researcher',
    taskId: 'task-3',
    atMs: 1000,
  });
  assert.ok(e);
  assert.equal(e.action, 'member.interrupted');
  assert.equal(e.reason, 'drift-suspected');
  assert.equal(e.memberName, 'researcher');
  assert.equal(e.taskId, 'task-3');
  // 字段白名单：不允许出现任何内容型字段
  const keys = Object.keys(e).sort();
  assert.deepEqual(keys, ['action', 'atMs', 'memberName', 'missionId', 'reason', 'taskId']);
});

test('audit: an unknown action is REJECTED, not recorded with a warning', () => {
  // 闭集是硬约束：新增动作要走代码评审，不能靠调用方自觉。
  assert.equal(audit.buildAuditEntry({ action: 'mission.deleted-everything' }), null);
  assert.equal(audit.buildAuditEntry({}), null);
  assert.equal(audit.buildAuditEntry({ action: '' }), null);
});

test('audit: an unknown reason is rejected — free text cannot sneak in as a reason', () => {
  // 这条防的是"用 reason 当备注栏"：
  // 一旦允许任意字符串，迟早有人把任务描述塞进来。
  const bad = audit.buildAuditEntry({
    action: 'member.interrupted',
    reason: '因为模型说要把 src/auth.js 改成 JWT',
  });
  assert.equal(bad, null, 'free-text reason must be refused');
});

test('audit: there is no free-text field at all', () => {
  // 结构性保证：即使调用方传了 note/text/message，也不会被存下来。
  const e = audit.buildAuditEntry({
    action: 'member.messaged',
    note: '这是任务正文，不该被记录',
    text: '更多正文',
    message: '消息全文',
  });
  assert.ok(e);
  const serialized = JSON.stringify(e);
  assert.equal(serialized.includes('任务正文'), false);
  assert.equal(serialized.includes('更多正文'), false);
  assert.equal(serialized.includes('消息全文'), false);
});

test('audit: reason is optional but action is mandatory', () => {
  const e = audit.buildAuditEntry({ action: 'mission.paused' });
  assert.ok(e);
  assert.equal(e.reason, undefined, 'omitted reason stays absent, not "other"');
});

test('audit: the log accepts valid entries and rejects invalid ones without throwing', () => {
  const log = audit.createInterventionLog();
  assert.equal(log.record({ action: 'mission.paused', missionId: 'mis-a' }).ok, true);
  const rejected = log.record({ action: 'not-a-real-action' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'INTERVENTION_NOT_ALLOWED');
  assert.equal(log.recent().length, 1, 'a rejected entry must not be stored');
});

test('audit: the ring buffer is bounded and counts what it dropped', () => {
  const log = audit.createInterventionLog({ cap: 3 });
  for (let i = 0; i < 5; i += 1) {
    log.record({ action: 'mission.paused', missionId: 'mis-a', atMs: i });
  }
  const stats = log.stats();
  assert.equal(stats.size, 3);
  assert.equal(stats.cap, 3);
  assert.equal(stats.dropped, 2, 'dropping must be counted, not silent');
  assert.deepEqual(log.recent(3).map((e) => e.atMs), [2, 3, 4], 'newest entries survive');
});

test('audit: forMission filters to one mission only', () => {
  const log = audit.createInterventionLog();
  log.record({ action: 'mission.paused', missionId: 'mis-a' });
  log.record({ action: 'mission.resumed', missionId: 'mis-b' });
  log.record({ action: 'mission.stopped', missionId: 'mis-a' });
  assert.equal(log.forMission('mis-a').length, 2);
  assert.equal(log.forMission('mis-b').length, 1);
  assert.equal(log.forMission('mis-none').length, 0);
});

test('audit: descriptions use closed labels and never echo user content', () => {
  const e = audit.buildAuditEntry({
    action: 'member.interrupted', memberName: 'coder', missionId: 'mis-a',
  });
  const text = audit.describeIntervention(e);
  assert.match(text, /中断了成员/);
  assert.match(text, /coder/);
  // 未知 action 只回显 action 本身（调用方本来就有），不编造文案
  assert.equal(audit.describeIntervention({ action: 'x' }), 'x');
  assert.equal(audit.describeIntervention(null), '');
});

test('audit: the closed vocabularies are exported for UI use', () => {
  assert.ok(audit.INTERVENTION_ACTIONS.includes('member.interrupted'));
  assert.ok(audit.INTERVENTION_REASONS.includes('drift-suspected'));
  assert.equal(audit.INTERVENTION_ACTIONS.length, 9);
  assert.equal(audit.MAX_AUDIT_ENTRIES, 200);
});

test('audit: degenerate input never throws', () => {
  assert.doesNotThrow(() => audit.buildAuditEntry());
  assert.doesNotThrow(() => audit.describeIntervention());
  assert.doesNotThrow(() => audit.createInterventionLog({ cap: -5 }).record({ action: 'mission.paused' }));
});
