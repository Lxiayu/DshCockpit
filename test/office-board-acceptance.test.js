// test/office-board-acceptance.test.js — 白板真机验收脚本的离线守卫。
//
// 第一性原理：这个探针的价值不在"它通过"，而在**它踩过的 4 个坑**
//
//   上一轮我把它做失败了，并给出一个错误诊断（"latestSnapshot 有三份副本"）。
//   真相是数据流一直通，失败全在探针环境缺件。这 4 层如果不写进守卫，
//   下一个人会重新踩一遍：
//     1. 自定义协议需 registerSchemesAsPrivileged（否则 CSP 拒 CSS/JS）
//     2. office 页启动要 office:state / office:visibility
//     3. **页面订阅 bridge.onState()，会覆盖手动注入的快照** ← 误判根源
//     4. **tr() 走 officeBridge.i18n.t()，缺 shell:get-i18n 则文案全空** ← 误判根源
//
//   第 3/4 条是我给出错误诊断的原因：我以为渲染坏了，其实是探针没喂对。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'office-mission-board-acceptance.js');
const rawSrc = fs.readFileSync(PROBE, 'utf8');
// 断言必须只看**代码**：注释里提到某个 API 名不等于代码在用它。
// 本项目已经多次因为这个误报（office.html 的设计注释、i18n 的说明文字…）。
const src = rawSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('board acceptance: the probe loads the real office page and preload', () => {
  assert.match(src, /office\.html/);
  assert.match(src, /office-preload\.js/);
  assert.match(src, /office-protocol\.js/, 'it must reuse the real protocol handler');
});

test('board acceptance: the scheme is registered as privileged (CSP depends on it)', () => {
  assert.match(src, /registerSchemesAsPrivileged/);
  assert.match(src, /standard:\s*true/);
  assert.match(src, /secure:\s*true/);
});

test('board acceptance: the probe provides the channels the page needs to boot', () => {
  // 缺 office:state / office:visibility → __office.ready=false，整页不渲染。
  assert.match(src, /'office:state'/);
  assert.match(src, /'office:visibility'/);
});

test('board acceptance: the probe serves the shared i18n dictionary', () => {
  // 缺 shell:get-i18n → tr() 全部返回空串，白板标题和计数都是空的。
  // 这是我上一轮误判的直接原因之一。
  assert.match(src, /'shell:get-i18n'/);
  assert.match(src, /STRINGS/, 'it must use the real dictionary (i18n.STRINGS), not a hand-made map');
});

test('board acceptance: the probe does NOT inject snapshots by hand', () => {
  // 页面订阅 bridge.onState()，每次推送都 applySnapshot，会覆盖手动注入。
  // 正确做法是让 stub 的 office:state 直接返回带白板的数据，走真实链路。
  assert.doesNotMatch(src, /feedSnapshot/, 'no hand-injection hook — the probe must exercise the real startup path');
  assert.doesNotMatch(src, /page\.applySnapshot\(/, 'injecting via applySnapshot is overwritten by onState pushes');
});

test('board acceptance: the probe asserts the rendered CONTENT, not just presence', () => {
  // 只查 `!!document.getElementById('board-list')` 会漏掉"元素在但没内容"——
  // 那正是我上一轮看到的假失败形态。
  assert.match(src, /rows === 1/);
  assert.match(src, /重构认证模块/);
  assert.match(src, /条工作线/);
  assert.match(src, /条决策/);
  assert.match(src, /个待回答/);
});

test('board acceptance: the probe checks the needs-you highlight is actually applied', () => {
  assert.match(src, /needs-you/);
  assert.match(src, /getComputedStyle/, 'a class in the DOM is not proof the CSS applied');
});

test('board acceptance: the probe captures a screenshot and writes results.json', () => {
  assert.match(src, /capturePage/);
  assert.match(src, /results\.json/);
  assert.match(src, /\.png/);
});

test('board acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('board acceptance: the probe stays out of the CI test glob', () => {
  assert.ok(PROBE.startsWith(path.join(ROOT, 'scripts')));
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
