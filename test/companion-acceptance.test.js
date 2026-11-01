// test/companion-acceptance.test.js — Companion 真机验收脚本的离线守卫。
//
// 第一性原理：常驻小窗最容易犯的三个错都有"离线看不出来"的特性
//
//   1. 红点该亮没亮 / 不该亮却亮了 → 只有 getComputedStyle 能验证
//   2. 窗口太大挡事 → 只有真机 innerWidth/Height 能验证
//   3. 断线显示成"0 待办" → 只有初始态渲染能验证
//
//   本守卫确保探针本身不会悄悄退化。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'companion-acceptance.js');
const rawSrc = fs.readFileSync(PROBE, 'utf8');
// 断言只看代码：注释里提到 API 名不等于代码在用它。
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('companion acceptance: the probe loads the real page and preload', () => {
  assert.match(src, /companion\.html/);
  assert.match(src, /companion-preload\.js/);
});

test('companion acceptance: the probe uses the REAL window config, not a copy', () => {
  // 若探针自己造一份宽松配置，就不是在验收产品窗口。
  assert.match(src, /frame:\s*false/);
  assert.match(src, /alwaysOnTop:\s*true/);
  assert.match(src, /skipTaskbar:\s*true/);
});

test('companion acceptance: the probe measures the dot COLOUR (not just a class)', () => {
  // class 在 DOM 里 ≠ CSS 生效。
  assert.match(src, /getComputedStyle\(document\.getElementById\('dot'\)\)/);
  assert.match(src, /rgb\(255, 92, 92\)/, 'it asserts the actual alarm red');
});

test('companion acceptance: the probe asserts zero-pending does NOT show alarm red', () => {
  // 产品纪律：永远亮红 = 被无视 = 真告警失效。
  assert.match(src, /NEVER shows the alarm red/);
  assert.match(src, /dotColor !== 'rgb\(255, 92, 92\)'/);
});

test('companion acceptance: the probe asserts working is amber (not alarm red)', () => {
  assert.match(src, /rgb\(255, 207, 122\)/);
});

test('companion acceptance: the probe asserts the disconnected initial state', () => {
  // 断线显示"0 待办"会让用户以为一切正常。
  assert.match(src, /disconnected/);
  assert.match(src, /未连接/);
});

test('companion acceptance: the probe asserts the widget is small', () => {
  assert.match(src, /innerWidth/);
  assert.match(src, /w <= 260/);
});

test('companion acceptance: the probe verifies click → expand', () => {
  assert.match(src, /companion:expand/);
  assert.match(src, /expandCalls/);
});

test('companion acceptance: the probe screenshots the needs-you state', () => {
  assert.match(src, /companion-needs-you\.png/);
});

test('companion acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('companion acceptance: the probe stays out of the CI test glob', () => {
  assert.ok(PROBE.startsWith(path.join(ROOT, 'scripts')));
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
