// test/mission-desk-poll-backoff.test.js — 轮询退避不得让"我要拍板什么"失明。
//
// 第一性原理：为什么退避必须降频而不是停止
//
//   第 42 轮把 attention 刷新放进了轮询，修了"审批卡在后台无人知"。
//   但轮询里原本有一个退避：连续 60 秒没变化就 stopProgressPoll()。
//
//   那是**纯进度轮询**时代的合理设计（省电）。
//   可现在这个循环还承担着「我要拍板什么」的实时刷新 ——
//   而**团队安静的时刻，恰恰是最可能突然发来审批的时刻**。
//
//   两者放在一起就出现了新的失效：
//     团队安静 60 秒 → 轮询停止 → 团队发来审批 → 永远不会自动显示
//   而界面上写着"团队运行正常"。这比不刷新更糟：
//   用户以为一切正常，团队一直在等。
//
//   修法：安静后退避到 15 秒一次（降频），**不停止**。
//   代价是安静时每分钟 4 次轻量 IPC —— 相比"漏掉一个审批让团队卡住"，
//   这个代价完全值得。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');

test('backoff: idling does NOT stop the poll (it only slows down)', () => {
  // ⚠️ 断言必须检查**代码结构**，不能只查字面字符串。
  //   第一版写的是 doesNotMatch(/if \(progressIdleTicks >= 15\) stopProgressPoll\(\)/)，
  //   结果把常量改成 IDLE_BACKOFF_TICKS 的变异完全绕过去了 —— 测试全绿，
  //   而缺陷（退避时停止轮询）已经修回来了。
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const body = poll.slice(0, 6000);
  // 剥掉注释：注释里会提到 stopProgressPoll，干扰判断
  const code = body.split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n');

  // 退避分支里**不允许**出现 stopProgressPoll() —— 只能降频
  const backoffIdx = code.indexOf('IDLE_BACKOFF_TICKS &&');
  assert.ok(backoffIdx !== -1, 'there must be an idle-backoff branch');
  const backoffBranch = code.slice(backoffIdx, backoffIdx + 400);
  assert.doesNotMatch(backoffBranch, /stopProgressPoll\(\)/,
    'the idle branch must NOT stop the poll — that would blind the rail to new approvals');
  assert.match(backoffBranch, /IDLE_INTERVAL_MS/,
    'the idle branch must switch to a slower interval');
  assert.match(backoffBranch, /restartProgressPoll\(\)/,
    'the poll interval must be re-armed when slowing down');
});

test('backoff: an attention change also resets the idle counter', () => {
  // 否则会出现：待办变了但进度没变 → 仍被算作 idle → 继续往停止退。
  // 同上去注释，避免注释里的措辞让断言失真。
  const at = HTML.indexOf('state.attention = fresh;');
  assert.ok(at !== -1, 'the attention assignment must exist');
  const after = HTML.slice(at);
  // 取这条赋值所在的代码块（到下一个空行为止）
  const block = after.split('\n').slice(0, 12).join('\n');
  const code = block.split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n');
  assert.match(code, /progressIdleTicks = 0/,
    'a pending-item change is a change too — it must reset the idle counter');
  assert.match(code, /attentionChangedThisTick = true/,
    'and it must mark the tick as "changed" so the idle branch is skipped');
});

test('backoff: the idle branch is skipped when attention changed', () => {
  assert.match(HTML, /else if \(!attentionChangedThisTick\)/,
    'the idle counter must not increment on a tick where attention moved');
});

test('backoff: no path in the poll can stop it when a session is bound', () => {
  // 只有"没有 id / 没有绑定会话"才允许停。
  // 任何基于"空闲"的 stop 都会让审批失明。
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const body = poll.slice(0, 6000);
  const code = body.split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n');
  const stops = [...code.matchAll(/stopProgressPoll\(\)/g)];
  // 允许的 stop：!id、!bound && !bound.bound 这两处（在函数开头）
  assert.ok(stops.length <= 2,
    `only the "no session" guards may stop the poll, found ${stops.length} stop calls`);
  for (const m of stops) {
    const around = code.slice(Math.max(0, m.index - 120), m.index);
    assert.match(around, /!id|!bound|!bound\.bound/,
      'a stop call must be justified by "no mission selected" or "no bound session"');
  }
});

test('backoff: the idle interval is slow but finite', () => {
  const m = HTML.match(/const IDLE_INTERVAL_MS = (\d+);/);
  assert.ok(m, 'IDLE_INTERVAL_MS must be defined');
  const ms = Number(m[1]);
  assert.ok(ms > 4000, 'idle polling must actually be slower than active polling');
  assert.ok(ms <= 30000, 'but it must not be so slow that a waiting team stalls for minutes');
});

test('backoff: the active interval is unchanged (4s)', () => {
  assert.match(HTML, /const PROGRESS_POLL_MS = 4000;/,
    'the active cadence must stay at 4s — slowing it would hurt responsiveness');
});

test('backoff: re-entrancy guard survives the refactor', () => {
  // 抽成 tickProgressPoll 后，防重入逻辑必须一起搬过去。
  assert.match(HTML, /async function tickProgressPoll\(\)/);
  const fn = HTML.slice(HTML.indexOf('async function tickProgressPoll()'));
  const body = fn.slice(0, 800);
  assert.match(body, /if \(progressBusy\) return;/);
  assert.match(body, /progressBusy = false;/);
});

test('backoff: restart does not resurrect a stopped poll', () => {
  // 用户切走 / 无绑定会话时轮询本来就该停。
  // 如果 restartProgressPoll 会无条件启动，就再也停不下来了。
  const fn = HTML.slice(HTML.indexOf('function restartProgressPoll()'));
  const body = fn.slice(0, 400);
  assert.match(body, /if \(!progressTimer\) return;/,
    'restart must not start a poll that was intentionally stopped');
});
