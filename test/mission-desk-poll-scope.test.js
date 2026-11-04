// test/mission-desk-poll-scope.test.js — 轮询该刷什么、不该刷什么。
//
// 第一性原理：右栏的数据有两种
//
//   「会变的当前事实」→ 必须轮询刷新，否则界面显示过期状态骗人。
//   「历史 / 用户意图」→ **不能**轮询刷新，否则会把记录本身弄坏。
//
//   第 42-45 轮连续修了四处"只读一次导致过期"：
//     attention / 团队投影 / 任务板 / 离开期间
//   它们都是同一个根因：轮询最初只被设计成"刷新进度"，
//   而不是"让右栏与事实保持同步"。
//
//   这个文件把"什么该刷、什么不该刷"固定下来，
//   并且特别守住 **markSeen 不能进轮询** ——
//   那条一旦被"顺手优化"加进去，「你离开期间」就永远是空的。
'use strict';

const { test } = require('node:test');
const { stripComments } = require('./helpers/source-scan.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');

function pollCode() {
  const i = HTML.indexOf('async function pollProgressOnce()');
  const j = HTML.indexOf('// 页面重新可见时');
  // 用共享实现：它同时剔行注释、**行尾注释、块注释**，并跳过字符串里的 //。
  // 各文件自己写的版本只剔整行 //，块注释里提到的名字会被当成代码（第 50 轮实测）。
  return stripComments(HTML.slice(i, j === -1 ? i + 12000 : j));
}

const SHOULD_REFRESH = ['workStatus', 'attention', 'sessionProjections', 'sinceLastSeen'];

test('poll scope: every "changes over time" source IS refreshed', () => {
  const code = pollCode();
  for (const a of SHOULD_REFRESH) {
    assert.match(code, new RegExp(`api\\('${a}'`),
      `the poll must refresh ${a} — otherwise the rail shows a stale state`);
  }
});

test('poll scope: markSeen must NEVER be in the poll', () => {
  // 这是最危险的一条：markSeen 的语义是"用户看到了"。
  // 如果轮询每 4 秒自动标记一次，「你离开期间」会永远是空的 ——
  // 因为"上次查看"被不断刷新成"刚刚"。
  // 这个功能的全部价值就在于**用户没看的时候发生的事**。
  const code = pollCode();
  assert.doesNotMatch(code, /api\('markSeen'/,
    'markSeen in the poll would destroy the "what happened while you were away" feature');
});

test('poll scope: Brief is not refreshed (it only changes when the user edits it)', () => {
  const code = pollCode();
  assert.doesNotMatch(code, /api\('getBrief'/,
    'the brief is a document the user writes — polling it wastes calls');
  assert.doesNotMatch(code, /api\('briefSyncState'/);
});

test('poll scope: the mission record itself is not re-fetched by the poll', () => {
  // get 会返回整个 Mission 视图（含所有决策/发现/证据）。
  // 每 4 秒拉一遍是显著浪费，而这些只由用户动作改变。
  const code = pollCode();
  assert.doesNotMatch(code, /api\('get'/,
    're-fetching the whole mission view every 4s is wasteful — user actions drive it');
});

test('poll scope: the decision is documented in code, not just in a test', () => {
  // 半年后有人想"顺手把 markSeen 加进轮询"时，
  // 注释是唯一能拦住他的东西 —— 测试只会在 CI 里红，而他可能不看。
  const i = HTML.indexOf('轮询应该刷新什么');
  assert.ok(i !== -1, 'the poll scope must be explained at the call site');
  const block = HTML.slice(i, i + 1400);
  assert.match(block, /markSeen/);
  assert.match(block, /永远/);
});

test('poll scope: each refresh has its own try/catch (one failure must not kill the poll)', () => {
  const code = pollCode();
  // 四个刷新点，至少三段独立的保护
  const catches = (code.match(/catch\s*(\([^)]*\))?\s*\{/g) || []).length;
  assert.ok(catches >= 3,
    `each data source needs its own guard, found only ${catches} catch blocks`);
});

test('poll scope: every refresh is gated by the stale-selection guard', () => {
  const code = pollCode();
  // 每次写 state 之前都要确认 mission 没变
  const guards = (code.match(/state\.selectedId === id/g) || []).length;
  assert.ok(guards >= 3,
    `each late-arriving response must be discarded if the user switched missions, found ${guards} guards`);
});
