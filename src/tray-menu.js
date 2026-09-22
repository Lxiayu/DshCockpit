// src/tray-menu.js — A1 extraction: tray icon + context menu (moved verbatim
// from main.js). All actions arrive as injected callbacks; the module owns the
// Tray instance and rebuilds the menu on every updateTray() call.
'use strict';

// 容器加固（2026-09-23）：降级原因码 → i18n 键（main.js 的
// RUNTIME_DEGRADED_REASON_KEYS 同款；托盘与设置页共用一份措辞）。
const RUNTIME_DEGRADED_REASON_KEYS = Object.freeze({
  'feed-fail-streak': 'runtime.degradedFeed',
  'auth-fail-streak': 'runtime.degradedAuth',
  'feed-disconnected': 'runtime.degradedDisconnected',
});

function createTrayMenu(deps) {
  const {
    Tray, Menu, nativeImage, app,
    iconPath,                 // () => image path
    noTray = false,
    appName,
    lang,
    t,
    runtimeInfo,              // () => manager.getInfo()
    runtimeHealth = () => null, // () => runtime-health snapshot (容器加固)
    // () => base tooltip (window-manager's `AppName — <runtime url>`); the
    // degraded marker is APPENDED so an existing tooltip is never clobbered.
    baseTooltip = null,
    settingsGet,              // () => settings snapshot
    peakWindowsOf,            // (cfg) => windows|null
    costPeakStatus,           // cost.peakStatus
    quickAskAccelerator,      // () => string
    isMainWindowAlive,        // () => boolean (mainWindow && !destroyed)
    toggleDevTools,           // () => void
    quittingFlag,             // () => boolean
    setQuitting,              // (v: boolean) => void
    notify,                   // (title, body) => void — user-visible failures
    log = () => {},
    actions = {},
  } = deps;
  const {
    showMain,
    openSettingsWindow,
    openQuickAsk,
    runUpdateCheck,
    applyPendingUpdate,
    doRollback,
    restartRuntime,
    restartApp,
    checkShellUpdate,
    setWorkspace,
  } = actions;

  let tray = null;

  /** 用户可读的降级原因（i18n，与设置页同源）。 */
  function degradedReasonsText(health, L) {
    const reasons = (health && Array.isArray(health.reasons)) ? health.reasons : [];
    return reasons.map((r) => t(L, RUNTIME_DEGRADED_REASON_KEYS[r] || 'runtime.degradedTitle')).join('；');
  }

  function updateTray() {
    if (!tray) return;
    const L = lang();
    const info = runtimeInfo();
    const pending = info.pendingVersion;
    const canRollback = info.installed && info.installed.length > 1;
    // 容器加固（2026-09-23）：事件面/鉴权降级时，托盘 tooltip 与菜单都要显式
    // 标注（"看着正常其实没数据"是这次要消灭的形态）。非阻塞、只读呈现；降级
    // 标记追加在既有 tooltip（运行时 URL）之后，不覆盖已有信息。
    const health = runtimeHealth();
    const degraded = !!(health && health.degraded);
    const base = typeof baseTooltip === 'function' ? (baseTooltip() || appName) : appName;
    tray.setToolTip(degraded ? `${base} — ${t(L, 'runtime.degradedTitle')}` : base);
    const degradedItems = degraded ? [
      {
        label: `${t(L, 'runtime.degradedTitle')}：${degradedReasonsText(health, L)}`,
        enabled: false,
      },
      { label: t(L, 'runtime.degradedHint'), enabled: false },
      { type: 'separator' },
    ] : [];
    // peak/off-peak status line (only when split pricing is enabled)
    const cfg = settingsGet();
    const windows = peakWindowsOf(cfg);
    const peakItems = [];
    if (windows) {
      const ps = costPeakStatus(Date.now(), windows);
      const flatOut = cfg.costOutputPerM || 0;
      const peakOut = cfg.costPeakOutputPerM || 0;
      const hasPeakRate = !!(cfg.costPeakInputPerM || cfg.costPeakOutputPerM || cfg.costPeakCacheReadPerM || cfg.costPeakCacheWritePerM);
      const rate = ps.peak ? (hasPeakRate ? peakOut : flatOut) : flatOut;
      peakItems.push({
        label: ps.allDayOffPeak
          ? t(L, 'tray.peakWeekend', { r: rate })
          : ps.peak
            ? t(L, 'tray.peakOn', { r: rate, m: ps.nextChangeInMin })
            : t(L, 'tray.peakOff', { r: rate, m: ps.nextChangeInMin }),
        enabled: false,
      });
    }
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t(L, 'tray.open'), click: () => showMain() },
      ...peakItems,
      { label: t(L, 'tray.settings'), click: () => openSettingsWindow() },
      { label: t(L, 'tray.quickAsk'), accelerator: quickAskAccelerator(), click: () => openQuickAsk() },
      { type: 'separator' },
      ...degradedItems,
      {
        label: t(L, 'tray.checkUpdates'),
        click: async () => { await runUpdateCheck(true); },
      },
      {
        label: pending ? `${t(L, 'tray.applyUpdate')}（${info.activeVersion} → ${pending}）` : t(L, 'tray.applyUpdate'),
        enabled: !!pending,
        click: async () => {
          try { await applyPendingUpdate(); } catch (err) { notify(t(L, 'notify.applyFailed'), err.message); }
        },
      },
      {
        label: t(L, 'tray.rollback'),
        enabled: canRollback,
        click: async () => {
          try { await doRollback(); } catch (err) { notify(t(L, 'notify.rollbackFailed'), err.message); }
        },
      },
      { type: 'separator' },
      { label: t(L, 'tray.restartRuntime'), click: restartRuntime },
      {
        // R1: full app restart (window state is persisted by window-state.js)
        label: t(L, 'tray.restartApp'),
        click: () => { setQuitting(true); log('[shell] app relaunch requested'); app.relaunch(); app.exit(0); },
      },
      {
        label: t(L, 'tray.checkShellUpdate'),
        click: () => checkShellUpdate(true),
      },
      {
        label: t(L, 'tray.workspaces'),
        submenu: (settingsGet().recentWorkspaces || []).filter(Boolean).length
          ? settingsGet().recentWorkspaces.filter(Boolean).map((ws) => ({
              label: ws,
              type: 'checkbox',
              checked: settingsGet().workspace === ws,
              click: () => setWorkspace(ws),
            }))
          : [{ label: t(L, 'tray.noWorkspaces'), enabled: false }],
      },
      { label: t(L, 'tray.devtools'), click: () => { if (isMainWindowAlive()) toggleDevTools(); } },
      { type: 'separator' },
      {
        label: t(L, 'tray.runtime', { v: info.activeVersion || '—' })
          + (degraded ? ` · ${t(L, 'runtime.degradedTitle')}` : ''),
        enabled: false,
      },
      { label: t(L, 'tray.quit'), click: () => { setQuitting(true); app.quit(); } },
    ]));
  }

  function createTray() {
    if (noTray) return;
    const baseImage = nativeImage.createFromPath(iconPath());
    if (process.platform === 'darwin') {
      // macOS menu bar icon. The bundled icon.png is a 512x512 RGBA app icon
      // with an opaque background — using it as a template image renders it as
      // a solid block. Show it colored at the standard 22x22 menubar size.
      const resized = baseImage.resize({ width: 22, height: 22 });
      resized.setTemplateImage(false);
      tray = new Tray(resized);
    } else {
      tray = new Tray(baseImage.resize({ width: 16, height: 16 }));
    }
    tray.setToolTip(appName);
    tray.on('click', () => showMain());
    updateTray();
  }

  function hasTray() { return !!tray && !tray.isDestroyed(); }
  function setTooltip(text) { if (hasTray()) tray.setToolTip(text); }

  return { createTray, updateTray, hasTray, setTooltip };
}

module.exports = { createTrayMenu };
