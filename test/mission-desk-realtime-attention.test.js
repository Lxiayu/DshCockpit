// test/mission-desk-realtime-attention.test.js — "我要拍板什么"必须实时。
//
// 第一性原理：右栏第一大问题是「我要拍板什么」
//
//   团队在后台跑着，随时可能发起一个新的审批或提问 ——
//   那正是用户最需要**立刻**知道的事。
//
//   而实测发现（第 42 轮）：attention 在整个会话里只被调用**一次**
//   （页面加载时）。之后无论团队发起什么，界面都不会变。
//
//   后果很直接：审批卡在后台没人处理，团队一直等着，
//   而界面上写着"团队运行正常"。
//
//   这个文件守的是机制，不是排版：
//     · 轮询必须同时刷新 attention
//     · 必须按"内容签名"判断是否需要重绘（不能每轮都重绘）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'mission-desk.html'), 'utf8');

test('realtime: the poll loop refreshes attention (not only workStatus)', () => {
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const body = poll.slice(0, 3000);
  assert.match(body, /api\('attention'\)/,
    'the poll must fetch attention — otherwise new approvals never reach the user');
});

test('realtime: attention is refreshed AFTER the stale-selection guard', () => {
  // 否则会把旧 Mission 的待办画到新 Mission 上。
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const guardAt = poll.indexOf('state.selectedId !== id');
  // 用实际调用语句定位，不用裸字符串 —— 注释里也会提到 attention，
  // 用裸字符串会把注释的位置当成代码位置（本测试第一次就踩了这个）。
  const attAt = poll.indexOf("await api('attention')");
  assert.ok(guardAt !== -1 && attAt !== -1, 'both must exist');
  assert.ok(guardAt < attAt,
    'the attention fetch must come after the guard that discards stale responses');
});

test('realtime: the repaint only happens when the content actually changed', () => {
  // 直接每轮重绘会打断用户：输入框失焦、菜单合上、滚动跳动。
  assert.match(HTML, /function attentionSignature\(a\)/,
    'a content signature is needed to decide whether to repaint');
  assert.match(HTML, /const before = attentionSignature\(state\.attention\)/);
  assert.match(HTML, /if \(before !== afterSig\)/,
    'the rail must only repaint when the signature changed');
});

test('realtime: the signature ignores volatile fields (no whole-object stringify)', () => {
  const fn = HTML.slice(HTML.indexOf('function attentionSignature(a)'));
  const body = fn.slice(0, 900);
  assert.doesNotMatch(body, /JSON\.stringify\(\s*a\s*\)/,
    'hashing the whole object would repaint every tick because timestamps change');
  assert.match(body, /\.sort\(\)/,
    'item order must be normalized so a reorder does not count as a change');
});

test('realtime: the repaint is local (does not rebuild the whole rail)', () => {
  // 整页重建会抢走焦点、丢失滚动位置 —— 第 33-35 轮踩过的坑。
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const body = poll.slice(0, 4000);
  assert.match(body, /querySelector\('\.att'\)/,
    'the repaint must target the attention block specifically');
  assert.match(body, /replaceWith\(renderAttention\(\)\)/);
  assert.doesNotMatch(body, /loadDetail\(|renderDetail\(\)/,
    'the poll must not rebuild the entire detail pane');
});

test('realtime: a failing attention fetch does not break the progress poll', () => {
  const poll = HTML.slice(HTML.indexOf('async function pollProgressOnce()'));
  const body = poll.slice(0, 4000);
  // attention 那段必须在自己的 try 里
  const attBlock = body.slice(Math.max(0, body.indexOf("api('attention')") - 200));
  assert.match(attBlock.slice(0, 900), /catch/,
    'a dead attention call must not kill the progress poll');
});
