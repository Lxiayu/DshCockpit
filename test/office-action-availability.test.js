// test/office-action-availability.test.js — 动作按钮的可用性只能有一个判定处。
//
// 第一性原理：两处各算一遍，迟早漂移；而漂移的表现是"按钮看起来能点"
//
//   office.html 里原来有两套按钮禁用逻辑：
//     · renderDetails()：disabled = !bound || !capabilities.xxx   ← 正确
//     · setPanelActionsBlocked(false)：disabled = false            ← 无条件启用
//
//   于是出现这个序列：
//     1. 选中一个**没有绑定会话**的成员 -> 按钮禁用（正确）
//     2. 有一个审批弹窗开过、又关掉 -> setPanelActionsBlocked(false)
//     3. 按钮变成**可点**，但点下去什么也不会发生
//
//   危险的不是"多了一次无效点击"，而是**界面在说谎**：
//   它让用户以为这个成员可以被派发/取消，而能力根本不可用。
//
//   同理，capabilities.interrupt 是 false（0.1.5 没有中断 RPC），
//   按钮本该一直禁用；被无条件启用后，用户点它会得到一句失败提示 ——
//   那还不如一开始就不给点。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { stripComments } = require('./helpers/source-scan.js');
const CODE = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8'));

/** 取某个函数的函数体（按花括号配平）。 */
function fnBody(name) {
  const i = CODE.indexOf(`function ${name}(`);
  assert.ok(i !== -1, `${name} must exist`);
  const start = CODE.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < CODE.length; j += 1) {
    if (CODE[j] === '{') depth += 1;
    else if (CODE[j] === '}') {
      depth -= 1;
      if (depth === 0) return CODE.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('availability: there is exactly ONE place that decides button enablement', () => {
  assert.match(CODE, /function applyActionAvailability\(\)/,
    'the enablement rule must live in one named function');
  // 除了这个函数内部，别处不许直接写 btn-*.disabled =
  const outside = CODE.replace(fnBody('applyActionAvailability'), '');
  const direct = [...outside.matchAll(/getElementById\('(btn-[a-z-]+)'\)\.disabled\s*=/g)]
    .map((m) => m[1]);
  assert.deepEqual(direct, [],
    `these buttons get a second, independent enablement rule — the two will drift:\n  ${direct.join('\n  ')}`);
});

test('availability: the unified rule ANDs "blocked" with "capability available"', () => {
  const body = fnBody('applyActionAvailability');
  assert.match(body, /blocked/,
    'a temporarily blocked panel must disable the actions');
  assert.match(body, /capabilities\.(followup|cancel|interrupt)/,
    'an unavailable capability must disable its action');
  assert.match(body, /bound/,
    'an unbound employee must disable the actions');
});

test('availability: unblocking does NOT silently enable everything', () => {
  // 这是本次修的缺陷本体。
  const body = fnBody('setPanelActionsBlocked');
  assert.doesNotMatch(body, /\.disabled\s*=\s*blocked/,
    'setting disabled = blocked would re-enable buttons that are unbound/unsupported');
  assert.match(body, /applyActionAvailability\(\)/,
    'unblocking must re-run the unified rule, not force-enable');
});

test('availability: the blocked flag is NOT stored in pendingModalItem', () => {
  // pendingModalItem 装的是"哪一张卡"（item 对象）。
  // 拿它当布尔开关用会把 item 覆盖成 true —— 那是真 bug。
  const body = fnBody('setPanelActionsBlocked');
  assert.doesNotMatch(body, /pendingModalItem\s*=/,
    'pendingModalItem holds an item object; overwriting it with a boolean breaks the modal');
  assert.match(CODE, /let panelActionsBlocked\s*=\s*false/,
    'the blocked state needs its own boolean');
});

test('availability: the flag is declared before the function that reads it', () => {
  const declAt = CODE.indexOf('let panelActionsBlocked');
  const useAt = CODE.indexOf('function applyActionAvailability()');
  assert.ok(declAt !== -1 && useAt !== -1);
  assert.ok(declAt < useAt,
    'a `let` is not hoisted like a function — reading it before declaration would throw');
});

test('availability: every capability actually gates its own button', () => {
  const body = fnBody('applyActionAvailability');
  assert.match(body, /btn-dispatch[\s\S]{0,120}followup/);
  assert.match(body, /btn-cancel[\s\S]{0,120}cancel/);
  assert.match(body, /btn-interrupt[\s\S]{0,120}interrupt/);
});
