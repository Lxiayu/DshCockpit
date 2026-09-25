// test/runtime-hardening.test.js — 容器加固三件套（2026-09-23）的接线与呈现：
//   A1/A3 托盘 tooltip/菜单的降级呈现（真 tray-menu + 假 Electron 对象）
//   A1    设置页运行时区的降级呈现与 i18n 键覆盖（静态检查）
//   A2    main.js ↔ supervisor ↔ runtime-manager 的自动回滚接线（静态检查）
// 状态机本身的契约在 test/runtime-health.test.js；持久计数与回滚策略在
// test/runtime-manager-unit.test.js；supervisor 的调用时机在
// test/runtime-supervisor.test.js（真 spawn）。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createTrayMenu } = require('../src/tray-menu.js');
const { t } = require('../src/i18n.js');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ------------------------------------------------------------------- tray fake

function trayFixture(initialHealth) {
  const menus = [];
  const tooltips = [];
  let health = initialHealth;
  const tray = {
    isDestroyed: () => false,
    setContextMenu: (menu) => menus.push(menu),
    setToolTip: (text) => tooltips.push(text),
    on: () => {},
  };
  const trayMenu = createTrayMenu({
    Tray: function TrayFake() { return tray; },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    nativeImage: { createFromPath: () => ({ resize: () => ({ setTemplateImage: () => {} }) }) },
    app: { relaunch: () => {}, exit: () => {} },
    iconPath: () => '/tmp/icon.png',
    noTray: false,
    appName: 'DshCockpit',
    lang: () => 'zh',
    t,
    runtimeInfo: () => ({ activeVersion: '0.1.5-rc.2', pendingVersion: null, installed: [{ version: '0.1.5-rc.2' }, { version: '0.1.1-rc.2' }] }),
    runtimeHealth: () => health,
    // mirrors main.js: the tooltip baseline carries the runtime URL; the
    // degraded marker is appended, never replacing it
    baseTooltip: () => 'DshCockpit — http://127.0.0.1:64382',
    settingsGet: () => ({}),
    peakWindowsOf: () => null,
    costPeakStatus: () => ({ peak: false, allDayOffPeak: false }),
    quickAskAccelerator: () => 'Ctrl+Alt+Space',
    isMainWindowAlive: () => true,
    toggleDevTools: () => {},
    quittingFlag: () => false,
    setQuitting: () => {},
    notify: () => {},
    log: () => {},
    actions: {
      showMain: () => {}, openSettingsWindow: () => {}, openQuickAsk: () => {},
      runUpdateCheck: async () => {}, applyPendingUpdate: async () => {}, doRollback: async () => {},
      restartRuntime: () => {}, restartApp: () => {}, checkShellUpdate: () => {}, setWorkspace: () => {},
    },
  });
  trayMenu.createTray(); // builds the first menu too
  return {
    trayMenu,
    setHealth: (h) => { health = h; trayMenu.updateTray(); },
    labels: () => menus[menus.length - 1].template.map((i) => i.label || '').join('\n'),
    tooltip: () => tooltips[tooltips.length - 1],
  };
}

const healthy = Object.freeze({ degraded: false, reasons: Object.freeze([]), feedLive: true, muxState: 'live', feedFailStreak: 0, authFailStreak: 0, feedLostForMs: 0 });

test('tray shows no degraded affordance while the event surface is healthy', () => {
  const tray = trayFixture(healthy);
  const labels = tray.labels();
  assert.ok(!labels.includes('运行时降级'), 'healthy state renders no degraded line');
  assert.strictEqual(tray.tooltip(), 'DshCockpit — http://127.0.0.1:64382', 'tooltip stays the plain baseline (runtime url)');
  assert.ok(labels.includes('运行时 0.1.5-rc.2'), 'the version line still renders');
});

test('tray menu + tooltip surface the degraded posture with a reason line (A1)', () => {
  const tray = trayFixture(Object.freeze({
    ...healthy,
    degraded: true,
    reasons: Object.freeze(['feed-fail-streak']),
    feedLive: false,
    feedFailStreak: 3,
  }));
  const labels = tray.labels();
  assert.ok(labels.includes('⚠ 运行时降级'), 'degraded title rendered');
  assert.ok(labels.includes('实时事件面多次连接失败'), 'the reason itself is user-visible');
  assert.ok(labels.includes('壳与 Harness 页面仍可正常使用'), 'the non-blocking hint is attached');
  assert.strictEqual(tray.tooltip(), 'DshCockpit — http://127.0.0.1:64382 — ⚠ 运行时降级',
    'the degraded marker is appended to the existing tooltip, never replacing it');
});

test('the disconnect reason (A3) renders its own copy on the tray', () => {
  const tray = trayFixture(Object.freeze({
    ...healthy,
    degraded: true,
    reasons: Object.freeze(['feed-disconnected']),
    feedLive: false,
    feedLostForMs: 42_000,
  }));
  assert.ok(tray.labels().includes('实时事件流已断开'), 'disconnect copy rendered');
});

test('the tray recovers automatically when the feed comes back (A3)', () => {
  const tray = trayFixture(Object.freeze({
    ...healthy, degraded: true, reasons: Object.freeze(['feed-disconnected']), feedLive: false,
  }));
  assert.ok(tray.labels().includes('⚠ 运行时降级'));
  tray.setHealth(healthy);
  assert.ok(!tray.labels().includes('⚠ 运行时降级'), 'recovered: degraded line gone');
  assert.ok(!tray.labels().includes('实时事件流已断开'), 'recovered: reason gone');
  assert.strictEqual(tray.tooltip(), 'DshCockpit — http://127.0.0.1:64382', 'tooltip restored to the baseline');
});

// --------------------------------------------------------- settings page (A1)

test('settings runtime page renders the health row + degraded warning (A1)', () => {
  const html = read('settings.html');
  for (const id of ['runtime-health-state', 'runtime-degraded']) {
    assert.ok(html.includes(`id="${id}"`), `settings.html is missing #${id}`);
  }
  // the degraded box lives inside the runtime page card, not somewhere else
  const runtimePage = html.slice(html.indexOf('id="page-runtime"'), html.indexOf('id="page-plugins"'));
  assert.ok(runtimePage.includes('id="runtime-health-state"'), 'the health row belongs to the runtime page');
  assert.ok(runtimePage.includes('id="runtime-degraded"'), 'the degraded warning belongs to the runtime page');
  assert.ok(html.includes("window.dshShell.onRuntimeHealth("), 'settings subscribes to the health push');
  const preload = read('settings-preload.js');
  assert.match(preload, /onRuntimeHealth:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('runtime:health'/, 'preload bridges runtime:health');
});

// ------------------------------------------------------------- main.js wiring

test('main.js wires the health monitor into every feed path and the 5s tick (A1/A3)', () => {
  const main = read('main.js');
  assert.match(main, /createRuntimeHealthMonitor\(\{ log \}\)/);
  assert.match(main, /runtimeHealth\.noteFeedStart\(\{ protocol: 'legacy' \}\)/);
  assert.match(main, /runtimeHealth\.noteFeedStart\(\{ protocol: 'mux' \}\)/);
  assert.match(main, /runtimeHealth\.noteFeedLive\(\)/);
  assert.match(main, /runtimeHealth\.noteFeedFailure\(err\)/);
  assert.match(main, /runtimeHealth\.reset\(\)/);
  assert.match(main, /setInterval\(runtimeHealthTick, 5_000\)/);
  // degraded transitions: diagnostics (knownIssues), notify, tray, broadcast
  assert.match(main, /knownIssues\[version\] = `event surface degraded: \$\{key\}`/);
  assert.match(main, /broadcastRuntimeHealth\(health\)/);
  assert.match(main, /ipcMain\.handle\('shell:runtime-info'[\s\S]*?health: runtimeHealth\.snapshot\(\)/);
  // the tray menu receives the snapshot as an injected dep
  assert.match(main, /runtimeHealth: \(\) => runtimeHealth\.snapshot\(\)/);
});

test('main.js wires the consecutive-startup-failure auto-rollback (A2)', () => {
  const main = read('main.js');
  assert.match(main, /onStartupFailure: \(reason\) => handleRuntimeStartupFailure\(reason\)/);
  assert.match(main, /function handleRuntimeStartupFailure\(reason\)/);
  assert.match(main, /manager\.recordStartupFailure\(reason\)/);
  assert.match(main, /manager\.maybeAutoRollback\(/);
  // a healthy boot clears the persisted streak
  assert.match(main, /manager\.recordStartupSuccess\(\)/);
  // user-visible texts exist in both languages (src/i18n.js is the tray/notify source)
  const { STRINGS } = require('../src/i18n.js');
  for (const key of ['notify.autoRollback', 'notify.autoRollbackBody', 'notify.runtimeDegraded',
    'runtime.degradedTitle', 'runtime.degradedFeed', 'runtime.degradedAuth', 'runtime.degradedDisconnected']) {
    assert.ok(STRINGS.zh[key], `zh missing ${key}`);
    assert.ok(STRINGS.en[key], `en missing ${key}`);
  }
});

test('runtime-supervisor records a generation that never became healthy (A2)', () => {
  const sup = read('runtime-supervisor.js');
  assert.match(sup, /let generationHealthy = false;/);
  assert.match(sup, /generationHealthy = true;/);
  assert.match(sup, /onStartupFailure = \(\) => null,/);
  // two failure surfaces: the health probe and the process exit
  assert.match(sup, /onStartupFailure\('runtime health probe failed/);
  assert.match(sup, /onStartupFailure\(`runtime exited before healthy/);
  // a scheduled rollback stands the supervisor's own auto-restart down
  assert.match(sup, /startupVerdict && startupVerdict\.rollbackScheduled/);
  // the boot watchdog never outlives its generation
  assert.match(sup, /const clearBootWatchdog = \(\) =>/);
});
