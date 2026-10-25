'use strict';

// test/first-paint-decouple.test.js — v0.6 WP3：首帧解耦（源级顺序断言）。
//
// 背景（2026-10-25 冗余调查）：办公室是默认视图且不依赖 dsh runtime，却曾陪
// runtime 走完整条启动链（安装检查 → spawn → 健康探测 → onRuntimeHealthy →
// 才建窗）——这是启动第一帧延迟的最大来源。断言方式与 gate/接线测试同款：
// 对真实源码做顺序/存在性检查（不启动 Electron）。
//
//   W1 主窗口与办公室视图在 `await ensureRuntimeWithGuide()` **之前**创建；
//   W2 延迟服务由 onRuntimeHealthy 触发（不再挂在 harness 视图 paint 上）；
//   W3 runtime 永远起不来时 45s 兜底仍会启动服务（保活职责迁移到壳侧）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const WM = fs.readFileSync(path.join(ROOT, 'src', 'window-manager.js'), 'utf8');

test('first-paint W1: the main window and the office view are created BEFORE awaiting the runtime', () => {
  // 启动块（splash 之后）：早开窗 → 办公室上屏 → 才 await ensureRuntimeWithGuide。
  const splashAt = MAIN.indexOf("try { createLoadingWindow(); }");
  const earlyWindowAt = MAIN.indexOf("createWindow('about:blank')", splashAt);
  const officeAt = MAIN.indexOf('openOfficeView();', splashAt);
  const awaitAt = MAIN.indexOf('const runtimeReady = await ensureRuntimeWithGuide();', splashAt);
  assert.ok(splashAt > -1, 'splash creation must exist');
  assert.ok(earlyWindowAt > -1, 'the early main window creation must exist');
  assert.ok(officeAt > -1, 'the early office view open must exist');
  assert.ok(awaitAt > -1, 'the runtime ensure await must exist');
  assert.ok(earlyWindowAt < awaitAt, 'the main window must open before awaiting the runtime');
  assert.ok(officeAt < awaitAt, 'the office view must open before awaiting the runtime');
  // 早开窗失败时仍保留 M15 的退出钳制（防 window-all-closed 在 runtime 启动期退出）。
  assert.match(MAIN, /if \(!mainWindowsUp\) setMainWindowPending\(true\);/,
    'the M15 quit-hold must survive for the early-window-failure path');
  // harness 视图占位是 about:blank（真 URL 由 onRuntimeHealthy 的已存在分支换上）。
  const earlyWindowLine = MAIN.slice(earlyWindowAt - 40, earlyWindowAt + 40);
  assert.match(earlyWindowLine, /createWindow\('about:blank'\)/);
});

test('first-paint W2: deferred services start on runtime-healthy, not on the harness view paint', () => {
  // showMainWhenReady 只负责显示（不再启动服务）。
  const showFn = WM.slice(WM.indexOf('const showMainWhenReady = () => {'), WM.indexOf('did-first-visually-non-empty-paint'));
  assert.ok(showFn.includes('mainWindow.show()'), 'showMainWhenReady must still show the window');
  assert.equal(showFn.includes('startDeferredServices'), false,
    'paint must NOT start deferred services anymore (the office default view paints on about:blank)');
  // onRuntimeHealthy 先启动服务（幂等），再开/换窗。
  const healthyFn = WM.slice(WM.indexOf('function onRuntimeHealthy(bootUrl) {'), WM.indexOf('function onRuntimeHealthy(bootUrl) {') + 700);
  assert.ok(healthyFn.includes('startDeferredServices();'), 'runtime-healthy must start the deferred services');
  assert.ok(healthyFn.indexOf('startDeferredServices();') < healthyFn.indexOf('createWindow(bootUrl)'),
    'services start before the window branch');
  // 壳侧兜底：45 秒后无论如何启动一次（幂等）。
  assert.match(MAIN, /setTimeout\(startDeferredServices, 45_000\);/,
    'the shell-side fallback timer must keep services alive when the runtime never becomes healthy');
});

test('first-paint W3: the harness view keeps its real-URL gate (runtime healthy), the office keeps OFFICE-first semantics', () => {
  // onRuntimeHealthy 的"窗口已存在"分支：给 harness 视图换真 URL + 开 cockpit
  //（这条分支在 v0.4 就有 —— WP3 只是让窗口先行后它成为主路径）。
  const healthyFn = WM.slice(WM.indexOf('function onRuntimeHealthy(bootUrl) {'), WM.indexOf('function onRuntimeHealthy(bootUrl) {') + 700);
  assert.ok(healthyFn.includes('harnessView.webContents.loadURL(bootUrl)'), 'the harness view still gets the runtime URL on healthy');
  assert.ok(healthyFn.includes('createCockpitWindow()'), 'the cockpit still follows runtime health');
  // 早开办公室尊重 DSH_DESKTOP_OPEN_OFFICE=0（工作台优先的调试回退不被破坏）。
  const earlyOfficeLine = MAIN.slice(MAIN.indexOf('openOfficeView();', MAIN.indexOf("try { createLoadingWindow(); }")) - 200,
    MAIN.indexOf('openOfficeView();', MAIN.indexOf("try { createLoadingWindow(); }")) + 20);
  assert.match(earlyOfficeLine, /DSH_DESKTOP_OPEN_OFFICE !== '0'/,
    'the early office open must respect the workbench-first fallback switch');
});
