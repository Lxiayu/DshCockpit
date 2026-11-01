// test/mission-desk-acceptance.test.js — Mission Desk 真机验收脚本的离线守卫。
//
// 第一性原理：为什么给一个"不能在这里运行"的脚本写测试
//
//   scripts/acceptance/mission-desk-acceptance.js 需要真实图形会话，
//   CI 跑不了。但它有三个容易悄悄坏掉的地方：
//     1. 引用的 HTML/preload 路径写错（重命名文件后不会有人发现）
//     2. 它验证的 DOM 选择器与页面实际结构脱节（页面改了，探针还在查旧 class）
//     3. 它偷偷写用户的真实工作区（验收绝不能污染生产数据）
//
//   这些都能离线静态检查。真机只负责"渲染是否正确"，不负责"探针是否还对得上"。
//   这是 AGENTS.md §4「真机分层」的具体实践：headless 测试 ≠ 真机验收，
//   但**探针本身的正确性**必须能被 headless 验证。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'mission-desk-acceptance.js');
const PAGE = path.join(ROOT, 'src', 'mission-desk.html');
const PRELOAD = path.join(ROOT, 'src', 'settings-preload.js');

const probeSrc = fs.readFileSync(PROBE, 'utf8');
const pageSrc = fs.readFileSync(PAGE, 'utf8');

// ------------------------------------------------------------------ 存在性

test('acceptance: the probe targets files that actually exist', () => {
  assert.ok(fs.existsSync(PROBE));
  assert.ok(fs.existsSync(PAGE), 'the page the probe loads must exist');
  assert.ok(fs.existsSync(PRELOAD), 'the preload the probe injects must exist');
});

test('acceptance: the probe loads the real page and the real preload by name', () => {
  assert.match(probeSrc, /mission-desk\.html/);
  assert.match(probeSrc, /settings-preload\.js/);
});

// ------------------------------------------------- 探针与页面结构不能脱节

test('acceptance: every DOM selector the probe queries exists in the page', () => {
  // 探针查 #list .card / .badge / .live —— 页面必须真的产出这些结构，
  // 否则真机跑出来全是 FAIL，而根因是"探针过时"而不是"页面坏了"。
  const required = [
    ['#list .card', /class: 'card'/],
    ['.badge', /class: 'badge ' \+ m\.status/],
    ['.live', /class: 'live'/],
    ['header h1', /<h1>Mission Desk<\/h1>/],
  ];
  for (const [selector, pagePattern] of required) {
    assert.ok(probeSrc.includes(selector), `the probe queries ${selector}`);
    assert.match(pageSrc, pagePattern, `the page must actually produce ${selector}`);
  }
});

test('acceptance: the probe checks for the ABSENCE of a focused badge (matching the page)', () => {
  assert.match(probeSrc, /\.badge\.focused/);
  assert.doesNotMatch(pageSrc, /\.badge\.focused/, 'the page must not style a focused badge');
});

test('acceptance: the probe asserts the honest "unavailable" wording used by the page', () => {
  assert.match(probeSrc, /不可用/, 'the probe must look for the same wording the page renders');
  assert.match(pageSrc, /实时状态不可用/, 'and the page must actually render it');
});

// ------------------------------------------------------------- 隔离与安全

test('acceptance: the probe NEVER touches the user workspace', () => {
  // 验收探针写用户数据 = 用"验证"污染生产，比没验证更糟。
  assert.match(probeSrc, /mkdtempSync/, 'it must create its own temp workspace');
  assert.doesNotMatch(probeSrc, /homedir\(\)/, 'it must not resolve the user home as a workspace');
  assert.doesNotMatch(probeSrc, /settings\.effective/, 'it must not read the real settings');
});

test('acceptance: the probe cleans up its temp workspace', () => {
  assert.match(probeSrc, /rmSync/, 'a temp workspace must be removed');
});

test('acceptance: the probe hardens the window it creates', () => {
  // 如果验收窗口是宽松配置，验证"加固生效"就没有意义。
  assert.match(probeSrc, /contextIsolation: true/);
  assert.match(probeSrc, /nodeIntegration: false/);
  assert.match(probeSrc, /sandbox: true/);
});

// --------------------------------------------------------------- 报告质量

test('acceptance: results are persisted as JSON for post-mortem', () => {
  assert.match(probeSrc, /results\.json/);
  assert.match(probeSrc, /writeFileSync/);
});

test('acceptance: a screenshot is captured (visual review is part of acceptance)', () => {
  assert.match(probeSrc, /capturePage/);
  assert.match(probeSrc, /\.png/);
});

test('acceptance: the exit code reflects pass/fail (never a silent success)', () => {
  assert.match(probeSrc, /app\.exit\(code\)/);
  assert.match(probeSrc, /failed === 0 \? 0 : 1/);
});

test('acceptance: every check records a name and a status (no untracked silent checks)', () => {
  // record() 是唯一的检查入口，确保每个检查都能在报告里被看到。
  const recordCalls = (probeSrc.match(/\brecord\(/g) || []).length;
  assert.ok(recordCalls >= 10, `expected a thorough check list, found ${recordCalls} record() calls`);
  assert.doesNotMatch(probeSrc, /console\.log\('PASS/,
    'checks must go through record(), not ad-hoc console.log');
});

// ------------------------------------------------------- 不可在 CI 中运行

test('acceptance: the probe is NOT wired into the CI test glob', () => {
  // 它在 scripts/ 下而不是 test/，且需要图形会话。
  // 若有人把它挪进 test/，CI 会在无显示环境上挂掉。
  assert.ok(PROBE.startsWith(path.join(ROOT, 'scripts')), 'the probe must stay out of test/');
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/, 'and must not be named as a test file');
});
