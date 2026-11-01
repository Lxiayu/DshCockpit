// test/mission-desk-attention-acceptance.test.js — 待办/离开期间/双主题探针的离线守卫。
//
// 第一性原理：这个探针要防的假通过
//
//   · 只查"有没有 .att 元素" → CSS 没生效也算通过
//   · 只查一个主题 → 浅色主题下不可见也发现不了
//   · 不实测对比度 → "能渲染"和"能读"是两件事
//   · fixture 自相矛盾 → 本轮真踩到：attention 说 0 待办但 live 说 1 个待审批
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'mission-desk-attention-acceptance.js');
const raw = fs.readFileSync(PROBE, 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('attention acceptance: it measures REAL contrast in BOTH themes', () => {
  // "能渲染"和"能读"是两件事。浅色主题下浅色字几乎不可见。
  assert.match(src, /function contrast/, 'must compute real luminance ratio');
  assert.match(src, /contrast\('dark'\)/, 'dark theme must be measured');
  assert.match(src, /contrast\('light'\)/, 'light theme must be measured');
  assert.match(src, /4\.5/, 'AA threshold must be asserted');
});

test('attention acceptance: it asserts the block is ABOVE the fold', () => {
  assert.match(src, /inViewport/, 'being first in DOM is not the same as being visible');
});

test('attention acceptance: it asserts high risk sorts FIRST', () => {
  // 顺序本身承载语义：一个高风险审批比十个低风险提问更急。
  assert.match(src, /high risk is listed FIRST/);
});

test('attention acceptance: it clicks a button and checks the REAL channel payload', () => {
  // 只显示不能点 = 用户还得去别处找。
  assert.match(src, /b\.click\(\)/, 'must actually click');
  assert.match(src, /office:pending/, 'and observe the real IPC channel');
});

test('attention acceptance: it verifies the answer payload shape {action,id,value}', () => {
  // office-module 严格校验键序；shape 错会被判 PAYLOAD_INVALID。
  assert.match(src, /the answer uses the REAL payload shape/);
});

test('attention acceptance: zero todos is a SIGNAL, not blank', () => {
  assert.match(src, /团队运行正常/);
  assert.match(src, /att-clear/);
});

test('attention acceptance: the zero-todo fixture is self-consistent', () => {
  // 本轮踩到的坑：attention 报 0 待办，但 live 还说着 1 个待审批，
  // 页面于是显示"数据不一致"而不是"运行正常"——页面是对的，fixture 错了。
  assert.match(src, /DELETE_LIVE_PENDING/, 'the fixture must also clear live counts');
});

test('attention acceptance: never-seen means NO timeline, not an empty box', () => {
  assert.match(src, /never-seen means NO timeline/);
});

test('attention acceptance: the exit code reflects pass/fail', () => {
  assert.match(src, /app\.exit\(failed === 0 \? 0 : 1\)/);
});

test('attention acceptance: the probe stays out of the CI test glob', () => {
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});
