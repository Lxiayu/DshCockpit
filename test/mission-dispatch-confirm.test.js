// test/mission-dispatch-confirm.test.js — 派发确认（S2）。
//
// 第一性原理：这组测试守的是"不要把不确定说成失败"
//
//   我们没有 remote 写表面（D11），派发 = 给 Lead 发指令，让模型自己调工具。
//   于是出现了以前不存在的状态：**指令已下达，但不知道有没有被执行**。
//
//   把它简化成"成功/失败"会造成两种伤害，方向相反：
//     说成失败 → 用户重复派发 → 凭空多出一支团队/一批任务
//     说成成功 → 用户以为在跑，实际什么都没发生
//
//   所以这里有四种状态，判据只有一个：投影里有没有出现我们那个 key。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dc = require('../src/mission/dispatch-confirm.js');

const KEY = 'k-abc123';

function teamWith(tasks) {
  return { members: [{ id: 'm1', name: 'lead', role: 'lead', phase: 'active' }], tasks };
}

test('confirm: a task carrying our dispatch key confirms the dispatch', () => {
  const team = teamWith([{ id: 'task-1', subject: `实现 X [${KEY}]`, status: 'pending' }]);
  assert.ok(dc.findDispatchedTask(team, KEY));
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team, startedAtMs: 0, nowMs: 1000 });
  assert.equal(r.state, 'confirmed');
  assert.equal(r.task.id, 'task-1');
});

test('confirm: the key may appear in the description instead of the subject', () => {
  // 模型不一定会把 key 放进 subject；description 里也算 —— 判据是"这个 key 存在"，
  // 不是"它在哪个字段"。
  const team = teamWith([{ id: 'task-2', subject: '实现 X', description: `dispatch ${KEY}`, status: 'pending' }]);
  assert.ok(dc.findDispatchedTask(team, KEY));
});

test('confirm: a task WITHOUT our key does not confirm anything', () => {
  // 模型可能建了别的任务（理解偏了）。那不是"我们这次派发的成功"。
  const team = teamWith([{ id: 'task-9', subject: '模型自己想到的任务', status: 'pending' }]);
  assert.equal(dc.findDispatchedTask(team, KEY), null);
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team, startedAtMs: 0, nowMs: 1000, timeoutMs: 5000 });
  assert.equal(r.state, 'pending');
});

test('confirm: a deleted task never confirms', () => {
  const team = teamWith([{ id: 'task-3', subject: `[${KEY}]`, status: 'deleted' }]);
  assert.equal(dc.findDispatchedTask(team, KEY), null);
});

test('confirm: past the timeout it is "unconfirmed", NEVER "failed"', () => {
  // 这是本文件最重要的一条。说"失败"会让用户重复派发，制造重复任务。
  const r = dc.evaluateDispatch({
    dispatchKey: KEY, team: teamWith([]), startedAtMs: 0, nowMs: 200000, timeoutMs: 120000,
  });
  assert.equal(r.state, 'unconfirmed');
  assert.notEqual(r.state, 'rejected');
  const text = dc.describeDispatchState(r.state, r.reason);
  assert.doesNotMatch(text, /失败/, 'unconfirmed must not be described as failure');
  assert.match(text, /不要重复派发/, 'the wording must actively prevent duplicate dispatch');
});

test('confirm: an unreadable projection is also "unconfirmed", with its own wording', () => {
  // 读不到投影 ≠ 投影里没有。两者都不能叫成功，但措辞要区分。
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team: null, startedAtMs: 0, nowMs: 200000, timeoutMs: 120000 });
  assert.equal(r.state, 'unconfirmed');
  assert.match(r.reason, /读不到/);
});

test('confirm: only an explicit runtime rejection counts as "rejected"', () => {
  // "失败"这个判断必须来自运行时的明确拒绝，不能由超时推断。
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team: teamWith([]), promptRejected: true });
  assert.equal(r.state, 'rejected');
  // 即使此时投影里恰好有 key，明确拒绝也优先（运行时说的是权威）
  const r2 = dc.evaluateDispatch({
    dispatchKey: KEY, promptRejected: true,
    team: teamWith([{ id: 't', subject: `[${KEY}]`, status: 'pending' }]),
  });
  assert.equal(r2.state, 'rejected', 'an explicit rejection outranks a coincidental key match');
});

test('confirm: within the timeout it stays pending (do not rush to a verdict)', () => {
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team: teamWith([]), startedAtMs: 0, nowMs: 1000, timeoutMs: 120000 });
  assert.equal(r.state, 'pending');
});

test('confirm: missing timing info is treated as pending, not as expired', () => {
  // 没有时间戳就无法判断超时。默认"还在等"比默认"超时了"安全。
  const r = dc.evaluateDispatch({ dispatchKey: KEY, team: teamWith([]) });
  assert.equal(r.state, 'pending');
});

test('confirm: the four states are closed and each has user-facing wording', () => {
  assert.deepEqual([...dc.DISPATCH_STATES], ['pending', 'confirmed', 'unconfirmed', 'rejected']);
  for (const s of dc.DISPATCH_STATES) {
    const text = dc.describeDispatchState(s);
    assert.ok(typeof text === 'string' && text.length > 0, `${s} needs wording`);
  }
  // confirmed 与 rejected 的措辞必须不同，否则 UI 无法区分
  assert.notEqual(dc.describeDispatchState('confirmed'), dc.describeDispatchState('rejected'));
});

test('confirm: degenerate input never throws and never confirms', () => {
  assert.doesNotThrow(() => dc.findDispatchedTask(null, KEY));
  assert.doesNotThrow(() => dc.findDispatchedTask(teamWith([]), ''));
  assert.doesNotThrow(() => dc.evaluateDispatch());
  assert.equal(dc.evaluateDispatch().state, 'pending');
  assert.equal(dc.findDispatchedTask(teamWith([]), ''), null, 'an empty key must not match everything');
  assert.equal(dc.findDispatchedTask(null, KEY), null);
});
