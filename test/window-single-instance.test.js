// test/window-single-instance.test.js — 主窗口必须唯一（关窗/托盘/Dock 激活都不能造出第二个）。
//
// 第一性原理：这是"判断口径错了"，不是"创建逻辑坏了"
//
//   用户症状（真机，2026-11-04）：
//     1. 第一次点关闭 → 窗口正常关（隐藏到托盘）
//     2. 再次打开程序 → 又点关闭 → 卡住，程序坞里出现**两个窗口**
//     3. 关掉其中一个 → 另一个卡住；最小化再恢复 → **其中一个变白**
//
//   病根在两处，都源于同一个混淆：**"窗口活着" vs "窗口可见"**
//
//   （a）`app.on('activate')` 用 `hasVisibleMainWindow()` 判断要不要建窗。
//       而 trayOnClose=true（默认）时，关窗 = **隐藏**，不是销毁。
//       隐藏 → hasVisibleMainWindow() 返回 false → 走 else 分支 createWindow()
//       → 造出第二个主窗口。
//
//   （b）`createWindow()` 自己**不做去重**，直接 `new BrowserWindow()`。
//       于是任何调用方判断错一次，就真的多一个窗口。
//
//   修法分两层，缺一不可：
//     · 判断口径：有没有**活着的**窗口（hasLiveMainWindow）
//     · 副作用处兜底：createWindow 幂等 —— 已有活窗口就唤醒它，不新建
//
//   为什么两层都要：只在调用方改，将来新增调用点还会错；
//   只在 createWindow 改，会掩盖调用方的判断错误。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { stripComments } = require('./helpers/source-scan.js');
const WM = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'window-manager.js'), 'utf8'));
const MAIN = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8'));

test('single-instance: createWindow is idempotent (a live window short-circuits it)', () => {
  const i = WM.indexOf('function createWindow(');
  assert.ok(i !== -1, 'createWindow must exist');
  const body = WM.slice(i, i + 900);
  assert.match(body, /if \(hasLiveMainWindow\(\)\)/,
    'createWindow must bail out when a live main window already exists');
  assert.match(body, /showMain\(\)/,
    'and it must wake that window instead of leaving it hidden');
  assert.match(body, /return mainWindow/,
    'callers expect the (existing) window back');
});

test('single-instance: "live" is checked on the real BrowserWindow, not on visibility', () => {
  const i = WM.indexOf('function hasLiveMainWindow()');
  assert.ok(i !== -1, 'hasLiveMainWindow must exist');
  const body = WM.slice(i, i + 300);
  assert.match(body, /!mainWindow\.isDestroyed\(\)/,
    'a live window means "exists and not destroyed" — visibility is a different question');
  assert.doesNotMatch(body, /isVisible\(\)/,
    'visible-only detection is exactly the bug: hidden windows are still alive');
});

test('single-instance: Dock activation uses the LIVE check, not the visible one', () => {
  const i = MAIN.indexOf("app.on('activate'");
  assert.ok(i !== -1, "the activate handler must exist");
  const body = MAIN.slice(i, i + 900);
  assert.match(body, /hasLiveMainWindow\(\)/,
    'activate must ask "is there a window at all", not "is it currently visible"');
  assert.doesNotMatch(body, /hasVisibleMainWindow\(\)/,
    'using the visible check here is what created the second window');
});

test('single-instance: closing to tray hides rather than destroys (the design assumption)', () => {
  // 幂等修复的前提是：trayOnClose 时关窗是 hide。
  // 如果哪天改成 destroy，这条会提醒重新审视上面的判断。
  const i = WM.indexOf("mainWindow.on('close'");
  assert.ok(i !== -1);
  const body = WM.slice(i, i + 400);
  assert.match(body, /trayOnClose/, 'the close handler must consult trayOnClose');
  assert.match(body, /e\.preventDefault\(\)/, 'and prevent the actual close when hiding to tray');
  assert.match(body, /mainWindow\.hide\(\)/, 'then hide it — so it stays alive');
});

test('single-instance: the window reference is cleared only on real destruction', () => {
  // 如果 'closed' 里没清 mainWindow，hasLiveMainWindow 会永远 true，永远唤不醒新窗口；
  // 如果清得太早（hide 时），又会造出第二个。所以只在 'closed' 清。
  const i = WM.indexOf("mainWindow.on('closed'");
  assert.ok(i !== -1);
  const body = WM.slice(i, i + 400);
  assert.match(body, /mainWindow = null/, "the reference must be cleared when the window is really destroyed");
  // 精确到 close 处理块内部判断：'hide' 之后紧跟着 '});' 就是 handler 结束，
  // 下一行已经是 'closed' 处理。用固定宽度窗口会跨过去（第一版就是这样误报的）。
  const closeAt = WM.indexOf("mainWindow.on('close'");
  const closedAt = WM.indexOf("mainWindow.on('closed'");
  assert.ok(closeAt !== -1 && closedAt !== -1);
  const closeBlock = WM.slice(closeAt, closedAt);
  assert.match(closeBlock, /mainWindow\.hide\(\)/, 'the close handler must hide');
  assert.doesNotMatch(closeBlock, /mainWindow = null/,
    'hiding must NOT clear the reference — that is what made activate think there was no window');
});
