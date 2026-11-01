// test/office-inbox-acceptance.test.js — 收件箱真机验收脚本的离线守卫。
//
// 第一性原理：为什么收件箱需要真机验收（它已有 551 行离线测试）
//
//   `office-right-panel-p3.test.js` 覆盖的是**纯逻辑**：risk 分类、payload 校验、
//   answerPending 的接受/拒绝形状。它不会告诉你：
//     · 卡片在页面上真的渲染出来了吗
//     · 高/低风险的视觉标记真的不同吗
//     · 计数为 0 时徽标真的降为中性了吗（不制造"有东西待办"的错觉）
//     · 就地处理按钮真的在卡片里吗
//     · 运行时重启后的失效说明真的显示吗
//
//   这些只有真机能验证。本守卫确保探针本身不会悄悄退化。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'office-inbox-acceptance.js');
const rawSrc = fs.readFileSync(PROBE, 'utf8');
// 断言只看代码：注释里提到 API 名不等于代码在用它（本项目多次踩过）。
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('inbox acceptance: the probe reuses the real protocol handler and privileged scheme', () => {
  assert.match(src, /office-protocol\.js/);
  assert.match(src, /registerSchemesAsPrivileged/);
  assert.match(src, /standard:\s*true/);
});

test('inbox acceptance: the probe serves the shared i18n dictionary', () => {
  // 缺 shell:get-i18n → tr() 全返回空串，卡片文案全空（白板验收踩过）。
  assert.match(src, /'shell:get-i18n'/);
  assert.match(src, /STRINGS/);
});

test('inbox acceptance: the probe drives state through office:state, not hand injection', () => {
  // 页面订阅 bridge.onState，手动注入会被覆盖。
  assert.match(src, /'office:state'/);
  assert.doesNotMatch(src, /page\.applySnapshot\(/);
});

test('inbox acceptance: the probe seeds BOTH a high-risk and a low-risk item', () => {
  // 只放一条就测不出"风险分级在视觉上可区分"。
  assert.match(src, /risk: 'high'/);
  assert.match(src, /risk: 'low'/);
});

test('inbox acceptance: the probe asserts the count badge and per-card risk dataset', () => {
  assert.match(src, /pending-count/);
  assert.match(src, /dataset\.risk|\.risk ===/);
});

test('inbox acceptance: the probe requires in-place action buttons on the card', () => {
  // 验收标准：「能就地处理」——只有模态里能处理是不够的。
  assert.match(src, /querySelectorAll\('button'\)/);
  assert.match(src, /buttons\.length > 0/);
});

test('inbox acceptance: the probe covers the zero-count neutral badge', () => {
  // 计数为 0 必须是中性灰，不能用警示红制造"有东西待办"的错觉。
  assert.match(src, /need-zero/);
});

test('inbox acceptance: the probe covers the runtime-restart expiry note', () => {
  // 失效说明是"为什么刚才那些卡不见了"的唯一解释。
  assert.match(src, /pendingInvalid/);
  assert.match(src, /pending-expired/);
});

test('inbox acceptance: the probe captures a screenshot WITH the cards visible', () => {
  // 最终态截图会拍到"已失效"说明，看不到卡片 —— 所以要在卡片在场时先拍一张。
  assert.match(src, /office-inbox-with-cards\.png/);
  const shotAt = src.indexOf('office-inbox-with-cards.png');
  const emptyAt = src.indexOf('an empty inbox');
  assert.ok(shotAt !== -1 && emptyAt === -1 || shotAt < emptyAt,
    'the card screenshot must be taken before the inbox is emptied');
});

test('inbox acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('inbox acceptance: the probe stays out of the CI test glob', () => {
  assert.ok(PROBE.startsWith(path.join(ROOT, 'scripts')));
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
