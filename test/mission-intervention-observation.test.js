// test/mission-intervention-observation.test.js — 干预效果的观测（S6）。
//
// 第一性原理：为什么这里没有 'stopped' 这个状态
//
//   官方 `interrupt_agent` **不改变 `phase`**（phase 是生命周期，不是"在不在跑"）。
//   所以"它停了吗"协议层没有答案。能用的只有间接信号：任务 revision 还在变吗。
//
//   但同一个信号有两种解释：
//     revision 不变 → 停了？还是它在思考、等审批、已经结束？
//     revision 在变 → 没停（这一条确定）
//
//   所以只输出三态，且**故意没有 'stopped'**：那是我们验证不了的断言。
//   把"看起来停了"说成"已停止"，会让用户以为安全了 ——
//   这正是 receipt.js 里"verified 是人的判断"的同一条底线。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const obs = require('../src/mission/intervention-observation.js');

function snap(tasks) { return { atMs: 1000, tasks }; }
function t(id, revision, status = 'in_progress') { return { id, revision, status }; }

test('observation: a changed revision means it is STILL MOVING (this one is certain)', () => {
  const r = obs.observeIntervention({
    before: snap([t('task-1', 1)]),
    after: snap([t('task-1', 3)]),
  });
  assert.equal(r.state, 'still-moving');
  assert.equal(r.changed.length, 1);
  assert.match(r.reason, /可能还没停下/);
});

test('observation: an unchanged revision is only "quiet", NEVER "stopped"', () => {
  const r = obs.observeIntervention({
    before: snap([t('task-1', 1)]),
    after: snap([t('task-1', 1)]),
  });
  assert.equal(r.state, 'quiet');
  assert.notEqual(r.state, 'stopped');
  const text = obs.describeObservation(r);
  assert.match(text, /看起来停了/);
  assert.match(text, /不是确认/);
  assert.doesNotMatch(text, /已停止|已中断/);
});

test('observation: the state vocabulary is closed and has NO "stopped"', () => {
  assert.deepEqual([...obs.OBSERVATION_STATES], ['still-moving', 'quiet', 'unknown']);
  assert.equal(obs.OBSERVATION_STATES.includes('stopped'), false,
    'we cannot verify "stopped" — claiming it would be a lie');
});

test('observation: a status change also counts as movement', () => {
  const r = obs.observeIntervention({
    before: snap([t('task-1', 1, 'pending')]),
    after: snap([t('task-1', 1, 'in_progress')]),
  });
  assert.equal(r.state, 'still-moving');
});

test('observation: a disappeared task is movement, not stillness', () => {
  const r = obs.observeIntervention({
    before: snap([t('task-1', 1)]),
    after: snap([]),
  });
  assert.equal(r.state, 'still-moving');
  assert.equal(r.changed[0].reason, 'task-disappeared');
});

test('observation: no tasks before the intervention means UNKNOWN, not "stopped"', () => {
  // 这个成员本来就没任务 —— "任务没变化"在这里毫无信息量。
  const r = obs.observeIntervention({ before: snap([]), after: snap([]) });
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /没有负责任务/);
});

test('observation: missing snapshots are UNKNOWN with distinct reasons', () => {
  assert.equal(obs.observeIntervention({ before: null, after: snap([]) }).state, 'unknown');
  assert.equal(obs.observeIntervention({ before: snap([]), after: null }).state, 'unknown');
  assert.match(obs.observeIntervention({ before: snap([t('a', 1)]), after: null }).reason, /读不到/);
});

test('observation: newly appeared tasks do not count as this intervention changing things', () => {
  // 新任务可能是别的成员建的，与这次干预无关。
  const r = obs.observeIntervention({
    before: snap([t('task-1', 1)]),
    after: snap([t('task-1', 1), t('task-new', 1)]),
  });
  assert.equal(r.state, 'quiet', 'a brand-new task must not be read as "it moved"');
});

test('observation: the wording for still-moving tells the user what to DO', () => {
  const r = obs.observeIntervention({ before: snap([t('a', 1)]), after: snap([t('a', 2)]) });
  const text = obs.describeObservation(r);
  assert.match(text, /再等一下|查看/);
});

test('observation: degenerate input never throws', () => {
  assert.doesNotThrow(() => obs.observeIntervention());
  assert.doesNotThrow(() => obs.observeIntervention({ before: {}, after: {} }));
  assert.doesNotThrow(() => obs.describeObservation(null));
  assert.equal(obs.describeObservation(null), '');
});
