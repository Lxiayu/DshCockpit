// test/mission-desk-dock-acceptance.test.js — 右栏 Mission Desk 验收探针的离线守卫。
//
// 第一性原理：这个探针要防的假通过
//
//   1. 用假字段名（本轮真踩到：decision 的字段是 text，我写成 summary，
//      结果页面渲染出 "undefined已接受"，而断言因为也用了假字段而"通过"）
//   2. 只看 detail 文本（标题在 picker 里，不在 detail）
//   3. 不验布局（380px 下双栏被压扁也算"渲染成功"）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'mission-desk-dock-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('dock acceptance: the fixture uses the REAL decision field name (text, not summary)', () => {
  // 本轮真实踩到的坑：页面渲染出 "undefined已接受"。
  // 因为 schema 是 { text, rationale }，我写成了 { summary }。
  const SCHEMA = fs.readFileSync(path.join(ROOT, 'src', 'mission', 'schema.js'), 'utf8');
  assert.match(SCHEMA, /text is required \(what was decided\)/, 'schema says decisions carry text');
  assert.match(src, /text: '暂不引入第二套 Harness'/, 'the fixture must use text');
  assert.doesNotMatch(src, /summary: '暂不引入第二套 Harness'/,
    'using `summary` makes the page render "undefined"');
});

test('dock acceptance: it measures the LAYOUT, not just the text', () => {
  // 380px 下"双栏被压扁"也会渲染出全部文本，但视觉是坏的。
  assert.match(src, /getBoundingClientRect/, 'must measure real geometry');
  assert.match(src, /detailTop/);
  assert.match(src, /overflowX/);
});

test('dock acceptance: it verifies the detail pane is BELOW the picker', () => {
  assert.match(src, /detail pane sits BELOW the picker/);
});

test('dock acceptance: it asserts the OLD task panel is gone', () => {
  // 如果页面还是 work.html，这些文案会命中。
  assert.match(src, /先选一个工作区/);
  assert.match(src, /一句话说明你想完成的工作/);
});

test('dock acceptance: it checks a Mission is auto-selected', () => {
  // 右栏打开就该有内容，不该要求用户先点一下。
  assert.match(src, /a Mission is auto-selected/);
});

test('dock acceptance: it runs at the real dock width', () => {
  assert.match(src, /const DOCK_WIDTH = 380/);
  assert.match(src, /width: DOCK_WIDTH/);
});

test('dock acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('dock acceptance: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
