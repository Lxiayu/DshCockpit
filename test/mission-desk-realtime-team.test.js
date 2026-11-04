// test/mission-desk-realtime-team.test.js — 「进展 / 团队成员」必须实时。
//
// 第一性原理：显示**看起来真实但已经过期**的状态，比不显示更糟
//
//   右栏说「进展 1/4」「团队成员 coder」—— 用户信这句话去做判断。
//   但实测发现（第 44 轮）：sessionProjections 在整个会话里
//   只被调用**一次**（loadDetails 时）。之后团队新增成员、
//   任务从 pending 变 in_progress，界面**永远显示旧数据**。
//
//   后果具体：用户看到"coder 还没开始"决定去催，
//   而 coder 可能已经做完了。他会基于错误信息做一个无用的动作。
//
//   这正是"事实作者唯一"的延伸：既然我们的数据和 Harness 是同一份事实，
//   就不能让界面停留在某个历史快照上假装它还是现在。
'use strict';

const { test } = require('node:test');
const { stripComments } = require('./helpers/source-scan.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');

function pollBody() {
  const i = HTML.indexOf('async function pollProgressOnce()');
  return HTML.slice(i, i + 8000);
}

test('realtime team: the poll refreshes sessionProjections (not only workStatus)', () => {
  const body = pollBody();
  const code = stripComments(body);
  assert.match(code, /await api\('sessionProjections'\)/,
    'the poll must refresh the team projection — otherwise the rail shows a stale roster');
});

test('realtime team: the projection refresh sits after the stale-selection guard', () => {
  const body = pollBody();
  const guardAt = body.indexOf('state.selectedId !== id');
  const projAt = body.indexOf("await api('sessionProjections')");
  assert.ok(guardAt !== -1 && projAt !== -1, 'both must exist');
  assert.ok(guardAt < projAt,
    'a stale response must be discarded before it can touch the new mission');
});

test('realtime team: the repaint targets the REAL container classes', () => {
  // 第一版我猜了 `.team-tasks` / `.members`，两个都不存在 —— 重绘静默失效。
  // 这条断言直接对着 render 函数产出的根 class 校验，防止再猜错。
  assert.match(HTML, /el\('section', \{ class: 'team' \}\)/,
    'renderTeamTasks must still produce section.team');
  assert.match(HTML, /el\('section', \{ class: 'entity-section members-section' \}\)/,
    'renderTeamMembers must still produce section.members-section');
  const body = pollBody();
  assert.match(body, /querySelector\('section\.team'\)/,
    'the repaint must use the real class for the task block');
  assert.match(body, /querySelector\('section\.members-section'\)/,
    'the repaint must use the real class for the roster');
});

test('realtime team: the repaint only happens when the content changed', () => {
  const body = pollBody();
  assert.match(body, /const beforeSig = teamSignature\(state\.projections\)/);
  assert.match(body, /if \(beforeSig !== afterSigP\)/,
    'repainting every tick would steal clicks and scroll position');
});

test('realtime team: the signature covers what the user can actually see', () => {
  const fn = HTML.slice(HTML.indexOf('function teamSignature(proj)'));
  const body = fn.slice(0, 900);
  // 成员：id + phase
  assert.match(body, /m\.id/);
  assert.match(body, /m\.phase/);
  // 任务：id + revision + status + owner
  assert.match(body, /x\.revision/, 'a revision change means the task was edited');
  assert.match(body, /x\.status/, 'a status change is exactly what "进展" shows');
  assert.match(body, /x\.ownerName/, 'a reassignment changes who is doing what');
});

test('realtime team: a failing projection fetch does not break the poll', () => {
  const body = pollBody();
  const code = stripComments(body);
  const idx = code.indexOf("await api('sessionProjections')");
  assert.ok(idx !== -1);
  const around = code.slice(idx, idx + 900);
  assert.match(around, /catch/,
    'a dead projection call must not kill the progress poll');
});

test('realtime team: the whole rail is NOT rebuilt by the poll', () => {
  // 整页重建会抢焦点、丢滚动位置（第 33-35 轮的教训）。
  const body = pollBody();
  const code = stripComments(body);
  assert.doesNotMatch(code, /loadDetail\(/,
    'the poll must not reload the whole detail');
});
