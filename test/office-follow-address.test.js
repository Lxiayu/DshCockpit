'use strict';

// test/office-follow-address.test.js — 子代理 follow/page 地址簿
// （src/office/runtime/follow-address.js）。运行时 0.1.5 的 validateAddress 拒绝
// 用根地址寻址子会话（session/agent-busy），正确形状是
// {kind:'subagent', parentSessionId, childSessionId, mode}；mode 必须与描述符一致。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFollowAddressBook, isSubagentMode } = require('../src/office/runtime/follow-address.js');

test('根会话用 root 地址，未知会话也按根会话处理', () => {
  const book = createFollowAddressBook();
  assert.deepEqual(book.addressOf('session-root-1'), { kind: 'session', sessionId: 'session-root-1' });
  assert.equal(book.isKnownChild('session-root-1'), false);
});

test('会话列表说"这是子会话"但 mode 未知时：地址为 null（必须先跳过，不许退回根地址）', () => {
  const book = createFollowAddressBook();
  assert.equal(book.noteChildSession('child-1', 'parent-1'), true);
  assert.equal(book.addressOf('child-1'), null);
  assert.equal(book.isKnownChild('child-1'), true);
});

test('父侧 journal 交代 parent + mode 后：给出 subagent 地址', () => {
  const book = createFollowAddressBook();
  book.noteChildSession('child-1', 'parent-1');
  assert.equal(book.noteChildAddress('child-1', 'parent-1', 'continuable'), true);
  assert.deepEqual(book.addressOf('child-1'), {
    kind: 'subagent', parentSessionId: 'parent-1', childSessionId: 'child-1', mode: 'continuable',
  });
});

test('mode 只认 continuable / one-shot：其它值（含 null）绝不上地址', () => {
  const book = createFollowAddressBook();
  assert.equal(isSubagentMode('continuable'), true);
  assert.equal(isSubagentMode('one-shot'), true);
  assert.equal(isSubagentMode('streaming'), false);
  assert.equal(isSubagentMode(null), false);
  assert.equal(book.noteChildAddress('child-1', 'parent-1', null), false);
  assert.equal(book.noteChildAddress('child-1', 'parent-1', 'weird'), false);
  // 无效 mode 一律不记账：该会话既不是"已知子会话"（没被标成孩子），也拿不到
  // subagent 地址——按根会话处理（由重开守卫兜底），绝不会拿半成品地址去打运行时。
  assert.deepEqual(book.addressOf('child-1'), { kind: 'session', sessionId: 'child-1' });
  assert.deepEqual(book.debugState().addressable, []);
});

test('parentSessionId 缺失或自指时不记账', () => {
  const book = createFollowAddressBook();
  assert.equal(book.noteChildAddress('child-1', '', 'continuable'), false);
  assert.equal(book.noteChildAddress('child-1', 'child-1', 'continuable'), false);
  assert.deepEqual(book.addressOf('child-1'), { kind: 'session', sessionId: 'child-1' });
});

test('forget 之后回到根会话地址（子会话结束时清账）', () => {
  const book = createFollowAddressBook();
  book.noteChildSession('child-1', 'parent-1');
  book.noteChildAddress('child-1', 'parent-1', 'one-shot');
  assert.equal(book.addressOf('child-1').kind, 'subagent');
  book.forget('child-1');
  assert.equal(book.isKnownChild('child-1'), false);
  assert.deepEqual(book.addressOf('child-1'), { kind: 'session', sessionId: 'child-1' });
});

test('账本有界：超过 cap 后淘汰最久未更新的条目', () => {
  const book = createFollowAddressBook({ cap: 2 });
  book.noteChildAddress('child-1', 'parent-1', 'continuable');
  book.noteChildAddress('child-2', 'parent-1', 'continuable');
  book.noteChildAddress('child-3', 'parent-1', 'continuable'); // 淘汰 child-1
  assert.equal(book.addressOf('child-1').kind, 'session'); // 已不在账本 → 当根会话（由重开守卫兜底）
  assert.equal(book.addressOf('child-2').kind, 'subagent');
  assert.equal(book.addressOf('child-3').kind, 'subagent');
  assert.deepEqual(book.debugState().children.sort(), ['child-2', 'child-3']);
});

test('debugState 是只读快照：外部改动不影响内部账本', () => {
  const book = createFollowAddressBook();
  book.noteChildAddress('child-1', 'parent-1', 'continuable');
  const snapshot = book.debugState();
  snapshot.addressable[0].mode = 'tampered';
  snapshot.children.push('child-9');
  assert.equal(book.addressOf('child-1').mode, 'continuable');
  assert.equal(book.addressOf('child-9').kind, 'session');
});

test('forgetAll 清空整个账本（feed 停止时调用）', () => {
  const book = createFollowAddressBook();
  book.noteChildAddress('child-1', 'parent-1', 'continuable');
  book.noteChildSession('child-2', 'parent-1');
  book.forgetAll();
  assert.equal(book.isKnownChild('child-1'), false);
  assert.equal(book.isKnownChild('child-2'), false);
  assert.deepEqual(book.debugState().children, []);
});

// ---------------------------------------------------------------------------
// 壳接线（静态钉住）：main.js 不可 require（app 入口），按本仓既有做法用源码断言
// 钉住"子代理会话不得用根地址寻址"这条契约的两半——地址簿接线 + 有界重开守卫。
// ---------------------------------------------------------------------------

test('main.js 用地址簿构造 follow/page 地址，并在不可寻址时跳过', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(src.includes("require('./office/runtime/follow-address.js')"), '壳加载地址簿模块');
  assert.ok(src.includes('const address = officeFollowAddressOf(sessionId);'), 'follow 请求走地址簿');
  assert.ok(src.includes('if (!address) return null;'), '不可寻址（子会话 mode 未知）→ 返回 null');
  assert.ok(src.includes('if (!request) continue;'), 'tick 对 null 地址跳过，不退回根地址');
  assert.ok(src.includes('address: officeFollowAddressOf(sessionId) || { kind: \'session\', sessionId },'),
    'resync 的 session/page 与 follow 同源地址');
  assert.ok(!/function officeFollowRequest\(sessionId\) \{\s*const request = \{ address: \{ kind: 'session', sessionId \} \};/.test(src),
    '旧的"一律根地址"实现已消失');
  // 父侧 journal 的 subagent/start 把 parent+mode 记进地址簿
  assert.ok(src.includes('officeFollowAddresses.noteChildAddress(data.id, sessionId, data.mode)'),
    'wiring 的 emit 缝把子会话地址记进地址簿');
  // 会话列表的 summary（origin/parentSessionId）只作早期信号
  assert.ok(src.includes('officeFollowAddresses.noteChildSession(sessionId, childOf)'),
    'api-session/added 的 summary 记下"这是子会话"');
});

test('main.js 有有界重开守卫：连开 N 次 0 帧即停（防地址被拒的错误风暴）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(src.includes('const OFFICE_FOLLOW_MAX_REOPENS = 3;'), '重开次数有上限');
  assert.ok(src.includes('if (entry.reopens >= OFFICE_FOLLOW_MAX_REOPENS && entry.frames === 0) {'),
    '连开 N 次且零帧 → 判不可寻址');
  assert.ok(src.includes('officeFollowUnfollowable.add(sessionId);'), '记入不可寻址集合');
  assert.ok(src.includes('if (officeFollowUnfollowable.has(sessionId)) continue;'), '后续 tick 不再重试');
  assert.ok(src.includes('officeFollowUnfollowable.delete(data.id);'), '地址补齐后解除标记');
  assert.ok(src.includes('officeFollowUnfollowable.clear();'), 'feed 停止时清空');
});
