// test/settings-packs-acceptance.test.js — 角色包真机验收脚本的离线守卫。
//
// 第一性原理：这个探针发现了两个离线测试**根本看不到**的缺陷
//
//   1. `#page-office` 不可达（PAGES 白名单漏了 'office'）——
//      页面的**可到达性**是运行时属性，静态测试只查"字符串是否存在"。
//   2. `.setting-info` 的 `flex: 1 1 220px` 在 column 容器里变成
//      `height: 220px`，撑出 220px 空白——**只有截图能看出来**。
//
//   两次都是"离线全绿、真机才红"。所以探针本身必须被守卫：
//   它坏了的话，我们就又回到"以为验证过了"的状态。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'scripts', 'acceptance', 'settings-packs-acceptance.js');
const probeSrc = fs.readFileSync(PROBE, 'utf8');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'src', 'settings.html'), 'utf8');

test('packs acceptance: the probe targets files that exist', () => {
  assert.ok(fs.existsSync(PROBE));
  assert.match(probeSrc, /settings\.html/);
  assert.match(probeSrc, /settings-preload\.js/);
});

test('packs acceptance: the probe checks the office page is REACHABLE', () => {
  // 这是它抓到的第一个真实缺陷。若探针不再查这个，
  // 白名单回归就没人守了。
  assert.match(probeSrc, /page-office/);
  assert.match(probeSrc, /classList\.contains\('active'\)/, 'it must assert the page actually became active');
  assert.match(probeSrc, /PAGES whitelist/, 'and name the failure mode');
});

test('packs acceptance: the probe asserts the list is POPULATED (not just present)', () => {
  // rows >= 2 —— 只查 `!!document.getElementById('packs-list')` 会漏掉
  // "元素在但没渲染"的情况，那正是第一版的失败形态。
  assert.match(probeSrc, /list\.children\.length/);
  assert.match(probeSrc, /listInfo\.rows >= 2/);
});

test('packs acceptance: the probe scrolls the section into view before capturing', () => {
  // 首版截图拍到了空白区域——因为 office 页较长而 capturePage 只拍 viewport。
  assert.match(probeSrc, /scrollIntoView/);
  const scrollAt = probeSrc.indexOf('scrollIntoView');
  // 注意：capturePage 在注释里先出现过一次，要取**实际调用**那处
  const captureAt = probeSrc.lastIndexOf('webContents.capturePage()');
  assert.ok(scrollAt !== -1 && captureAt !== -1);
  assert.ok(scrollAt < captureAt, 'scroll must happen before capture');
});

test('packs acceptance: i18n is checked on VISIBLE text, not attributes', () => {
  // data-i18n 属性本身含 key；用 body.textContent 整串匹配会误报。
  assert.match(probeSrc, /innerText|visible/);
  assert.match(probeSrc, /packs_\[a-zA-Z\]/, 'it looks for a leaked raw key pattern');
});

test('packs acceptance: the probe is NOT wired into the CI test glob', () => {
  assert.ok(PROBE.startsWith(path.join(ROOT, 'scripts')));
  assert.doesNotMatch(path.basename(PROBE), /\.test\.js$/);
});

// -------------------------------------------- 被探针发现的缺陷的回归保护

test('packs acceptance: the office page stays in the PAGES whitelist (regression)', () => {
  // 探针发现的既有缺陷：page-office 的 DOM 与导航按钮都存在，
  // 但 PAGES 白名单漏了 'office' → showPage 回退到 general。
  const pagesLine = settingsHtml.match(/const PAGES = \[[^\]]+\]/);
  assert.ok(pagesLine, 'PAGES must exist');
  assert.match(pagesLine[0], /'office'/, 'office must stay whitelisted — otherwise the page is unreachable');
});

test('packs acceptance: the office page stays in SETTINGS_PAGES (regression)', () => {
  const line = settingsHtml.match(/const SETTINGS_PAGES = new Set\(\[[^\]]+\]\)/);
  assert.ok(line);
  assert.match(line[0], /'office'/);
});

test('packs acceptance: .packs-section resets the inherited flex-basis (regression)', () => {
  // 探针发现的第二个缺陷：.setting-info 的 flex: 1 1 220px 在 column 容器里
  // 变成 height: 220px，撑出大片空白。修复是显式重置。
  assert.match(settingsHtml, /\.packs-section > \.setting-info \{ flex: 0 0 auto; \}/,
    'without this reset the section grows a 220px hole');
});

test('packs acceptance: the packs section does NOT reuse the .setting flex layout', () => {
  // .setting 是 space-between 的两栏布局；复用它会再次引入布局 bug。
  const sectionStart = settingsHtml.indexOf('class="packs-section"');
  assert.ok(sectionStart !== -1);
  const before = settingsHtml.slice(Math.max(0, sectionStart - 400), sectionStart);
  assert.doesNotMatch(before, /class="setting"[^>]*flex-direction:column/,
    'the packs block must use its own container, not a hacked .setting');
});
