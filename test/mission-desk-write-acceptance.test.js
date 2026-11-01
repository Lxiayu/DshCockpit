// test/mission-desk-write-acceptance.test.js — 写入验收探针的离线守卫。
//
// 第一性原理：探针本身会退化
//
//   这类探针最容易犯的错是"假通过"：
//     · 只断言按钮存在，不断言点击后真的落盘
//     · 用 stub 替掉真正会坏的那一环
//     · 选择器写错但测试仍然绿
//
//   本守卫确保探针始终在验**真实链路**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'mission-desk-write-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('write acceptance: the probe uses the REAL store, not a stub', () => {
  // 这是本轮最重要的教训：stub 掉被测对象 = 没验收。
  assert.match(src, /require\(path\.join\(REPO, 'src', 'mission', 'store\.js'\)\)/);
  assert.doesNotMatch(src, /store\s*=\s*\{\s*append/, 'the store must be the real implementation');
});

test('write acceptance: it asserts the write LANDED in the store (not just that a button exists)', () => {
  // decisions 是先取 view 再取字段；deliverables/workstreams 是链式。
  assert.match(src, /missionView\(missionId\)/);
  assert.match(src, /\.decisions/);
  assert.match(src, /\.deliverables/);
  assert.match(src, /\.workstreams/);
});

test('write acceptance: it performs REAL DOM clicks', () => {
  assert.match(src, /\.click\(\)/, 'it must click, not just query the DOM');
});

test('write acceptance: it verifies the UI redraws after writing', () => {
  // 写完不重绘 = 用户看不到自己刚写的内容。
  assert.match(src, /appears in the UI after writing/);
  assert.match(src, /document\.body\.innerText\.includes/);
});

test('write acceptance: it asserts a REAL sha256 (proves the file was read)', () => {
  assert.match(src, /\[0-9a-f\]\{64\}/, 'a real digest regex must be asserted');
});

test('write acceptance: it seeds a real file so registration can succeed', () => {
  assert.match(src, /writeFileSync\(filePath/, 'the probe must create the file it registers');
});

test('write acceptance: it targets the correct mission-card selector', () => {
  // 第一版用了 [data-mission-id]，那个属性不存在 → 8 项全失败。
  // 这个守卫防止选择器再次退化。
  assert.match(src, /\.card\[role="button"\]/, 'the card is div.card[role=button]');
});

test('write acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('write acceptance: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
