// test/mission-desk-empty-acceptance.test.js — P4 空状态验收探针的离线守卫。
//
// 第一性原理：这个探针要防的假通过
//
//   空状态最容易"看起来做了"但实际是死路：
//     · 文案写了但渲染在 display:none 里
//     · 按钮写了但点击无反应
//     · 有五段引导文案（等于没引导）
//
//   所以探针必须：真渲染、真点击、数字按钮数量。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'mission-desk-empty-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('empty acceptance: it starts from ZERO missions (that is the new-user first screen)', () => {
  assert.match(src, /missionCount === 0/, 'the probe must exercise the true zero state');
});

test('empty acceptance: it performs a REAL click on the primary action', () => {
  assert.match(src, /\.click\(\)/, 'a button that has never been clicked is unverified');
});

test('empty acceptance: it verifies the create form actually becomes VISIBLE', () => {
  // 点击后表单必须真的出现——这是"按钮是活的"的唯一证据。
  assert.match(src, /offsetParent !== null/, 'visibility must be measured, not assumed');
  assert.match(src, /真的打开新建表单|opens the create form/);
});

test('empty acceptance: it checks there is exactly ONE primary action', () => {
  // 五个引导=没引导。
  assert.match(src, /button\.primary/);
  assert.match(src, /ONE visible primary action|一个可见主按钮/);
});

test('empty acceptance: it exercises explainFailure with FOUR kinds of input', () => {
  // 只测一种输入会漏掉分支（本轮踩过）。
  assert.match(src, /mapped:/);
  assert.match(src, /unmapped:/);
  assert.match(src, /nothing:/);
});

test('empty acceptance: it asserts the code is KEPT in the message', () => {
  assert.match(src, /DELIVERABLE_INVALID/);
  assert.match(src, /SOME_NEW_CODE/);
});

test('empty acceptance: it screenshots the empty state for visual review', () => {
  assert.match(src, /mission-desk-empty\.png/);
});

test('empty acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('empty acceptance: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
