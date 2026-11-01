// test/companion-urgency-acceptance.test.js — 紧急度验收探针的离线守卫。
//
// 第一性原理：这个探针要防的假通过
//
//   离线测 `deriveUrgency` 返回 'urgent' 已经够了。
//   探针的价值只在**屏幕上的差异**。所以它必须：
//     · 真读 getComputedStyle 的颜色（不是查 class）
//     · 断言三条文案两两不同（不是"包含某个词"）
//     · 断言尺寸没变（加字之后可能溢出）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'companion-urgency-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('urgency acceptance: it measures REAL computed colours (not class names)', () => {
  assert.match(src, /getComputedStyle/, 'class presence is not the same as applied style');
});

test('urgency acceptance: it asserts the three labels are PAIRWISE different', () => {
  // "包含某个词"会让两个状态同时通过。两两不同才是真的分开了。
  assert.match(src, /new Set\(\[urgent\.label, normal\.label, later\.label\]\)\.size === 3/);
});

test('urgency acceptance: it checks the size stays 220x44 (adding words may overflow)', () => {
  assert.match(src, /innerWidth/);
  assert.match(src, /w <= 240|220x44/);
});

test('urgency acceptance: it verifies urgent has a glow that normal does not', () => {
  assert.match(src, /boxShadow/, 'the glow is a visual difference, not just a colour');
});

test('urgency acceptance: it verifies idle carries NO urgency', () => {
  assert.match(src, /an idle widget carries NO urgency/);
});

test('urgency acceptance: it captures all three states as screenshots', () => {
  assert.match(src, /companion-\$\{name\}\.png|companion-urgent\.png/);
});

test('urgency acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('urgency acceptance: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
