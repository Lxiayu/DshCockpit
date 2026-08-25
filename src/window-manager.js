// src/window-manager.js — A1 step 5: main window + Cockpit rail + Settings
// center window management (moved verbatim from main.js). Owns all window
// singletons and their state; main.js consumes the accessor/delegator
// surface returned by createWindowManager().
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createWindowManager(deps) {
  const {
    BrowserWindow, screen,
    appName, iconPath, themeBackground, resolvedTheme,
    windowState, windowStateFile,
    log, t, lang,
    settingsGet,
    noTray = false,
    isQuitting = () => false,
    getRuntimeUrl, getRuntimeChild,
    traySetTooltip = () => {},
    closeLoading,
    startDeferredServices,
    computeCockpitBounds,
    getCockpitRuntimeState,
    getUsageCache, costSnapshot,
    getScheduledRunning, getRemoteStatus,
    appVersion, dshHomeOf,
    hasQuickAsk = () => false, hasSearch = () => false,
    hasTray = () => false, setLoading = () => {},
    COCKPIT_SNAPSHOT_TTL_MS = 250,
    buildSnapshot, runtimeInfo,
  } = deps;

  let mainWindow = null;
  let settingsWindow = null;
  let cockpitWindow = null;
  let mainWindowPending = false;
  let windowStateSaveTimer = null;
  let cockpitSyncTimer = null;
  let cockpitMode = 'rail';
  let cockpitOffset = { x: 0, y: 0 };
  let returnToCockpitPending = false;
  let cockpitHiddenForAuxWindow = false;
  let cockpitSnapshotCache = { at: 0, snapshot: null };

  // ------------------------------------------------------------- main window
  function createWindow(url) {
    mainWindowPending = false; // the main window is (about to be) open
    const saved = windowState.load(windowStateFile());
    const bounds = safeBounds(saved) || { width: 1280, height: 840 };
    mainWindow = new BrowserWindow({
      ...bounds,
      backgroundColor: themeBackground(), // match the splash: no white flash before the web UI paints
      title: appName,
      show: false,
      autoHideMenuBar: true,
      icon: iconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    mainWindow.on('show', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); });
    mainWindow.on('restore', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); });
    mainWindow.on('hide', () => hideCockpit());
    mainWindow.on('minimize', () => hideCockpit());
    mainWindow.on('maximize', () => syncCockpitBounds());
    mainWindow.on('unmaximize', () => syncCockpitBounds());
    mainWindow.on('enter-full-screen', () => { hideCockpit(); setTimeout(() => { syncCockpitBounds(); showCockpitInactive(); }, 80); });
    mainWindow.on('leave-full-screen', () => { setTimeout(() => { syncCockpitBounds(); showCockpitInactive(); }, 80); });

    mainWindow.loadURL(url);
    // Show + start deferred services when the page is truly paintable (no white
    // flash). A timeout fallback covers Windows GPU / older-Electron combos that
    // never emit ready-to-show even after a successful load, and a did-fail-load
    // retry recovers transient load failures. Without the fallback a stuck main
    // window would leave deferred services (token poll, scheduler, balance,
    // compaction, …) disabled forever.
    let mainShown = false;
    let mainShowFallbackTimer = null;
    const createT0 = Date.now();
    const showMainWhenReady = () => {
      if (mainShown || !mainWindow || mainWindow.isDestroyed()) return;
      mainShown = true;
      clearTimeout(mainShowFallbackTimer);
      mainWindow.show();
      closeLoading();
      log(`[perf] main window paintable in ${Date.now() - createT0}ms`);
      startDeferredServices();
    };
    mainWindow.once('ready-to-show', showMainWhenReady);
    mainShowFallbackTimer = setTimeout(() => {
      if (!mainShown) {
        log('[shell] main window ready-to-show timed out; forcing show');
        showMainWhenReady();
      }
    }, 15_000);
    let mainLoadRetries = 0;
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      if (code === -3) return; // ERR_ABORTED: superseded navigation, not a real failure
      log(`[shell] main window failed to load (${code}): ${description}`);
      if (mainLoadRetries < 2 && mainWindow && !mainWindow.isDestroyed()) {
        mainLoadRetries += 1;
        setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(url); }, 1_000);
      } else {
        setLoading(t(lang(), 'loading.failed', { msg: description || code }));
        showLoadingOnError();
      }
    });
    mainWindow.on('close', (e) => {
      if (!isQuitting() && !noTray && settingsGet().trayOnClose && hasTray()) {
        e.preventDefault();
        mainWindow.hide();
      }
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // persist window bounds (debounced)
    const saveBounds = () => {
      if (mainWindow && !mainWindow.isDestroyed()) windowState.save(windowStateFile(), mainWindow.getBounds());
    };
    mainWindow.on('resize', () => {
      scheduleCockpitSync();
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = setTimeout(saveBounds, 500);
    });
    mainWindow.on('move', () => {
      scheduleCockpitSync();
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = setTimeout(saveBounds, 500);
    });
    mainWindow.on('close', saveBounds);

    traySetTooltip(`${appName} — ${getRuntimeUrl() || 'starting…'}`);
    setTimeout(() => { createCockpitWindow(); showCockpitInactive(); }, 0);
  }

  function showMain() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function reloadMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }
  function toggleMainDevTools() {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
  }
  function pickDialogParent() { return settingsWindow || mainWindow; }
  function isMainWindowPending() { return mainWindowPending; }

  // ------------------------------------------------------- cockpit (rail UI)
  function cockpitDisplay() {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try { return screen.getDisplayMatching(mainWindow.getBounds()); } catch { return screen.getPrimaryDisplay(); }
  }

  function syncCockpitBounds() {
    if (!cockpitWindow || cockpitWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
    const display = cockpitDisplay();
    if (!display) return;
    const bounds = computeCockpitBounds(mainWindow.getBounds(), display.workArea, cockpitMode, undefined, cockpitOffset);
    cockpitWindow.setBounds(bounds, false);
  }

  function scheduleCockpitSync() {
    clearTimeout(cockpitSyncTimer);
    cockpitSyncTimer = setTimeout(() => { cockpitSyncTimer = null; syncCockpitBounds(); }, 40);
  }

  function showCockpitInactive() {
    if (!cockpitWindow || cockpitWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
    // Never place the rail over an active auxiliary or configuration window.
    if (settingsWindow && !settingsWindow.isDestroyed()) return;
    if (hasQuickAsk()) return;
    if (hasSearch()) return;
    syncCockpitBounds();
    try { cockpitWindow.showInactive(); } catch { cockpitWindow.show(); }
  }

  function hideCockpit() {
    if (cockpitWindow && !cockpitWindow.isDestroyed()) cockpitWindow.hide();
  }

  function prepareCockpitForAuxWindow() {
    // Auxiliary windows temporarily own the foreground. Remember only cases
    // where the visible main window can safely receive the rail back later.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()
        && !(settingsWindow && !settingsWindow.isDestroyed())) {
      cockpitHiddenForAuxWindow = true;
    }
    cockpitMode = 'rail';
    hideCockpit();
  }

  function restoreCockpitRail() {
    if (!cockpitHiddenForAuxWindow) return;
    // Do not reveal the rail underneath another auxiliary or settings window.
    if (settingsWindow && !settingsWindow.isDestroyed()) return;
    if (hasQuickAsk()) return;
    if (hasSearch()) return;
    cockpitHiddenForAuxWindow = false;
    cockpitMode = 'rail';
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) return;
    createCockpitWindow();
    showCockpitInactive();
  }

  function createCockpitWindow() {
    if (cockpitWindow && !cockpitWindow.isDestroyed()) return cockpitWindow;
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    cockpitWindow = new BrowserWindow({
      parent: mainWindow,
      modal: false,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      focusable: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'cockpit-preload.js'),
      },
    });
    cockpitWindow.loadFile(path.join(__dirname, 'cockpit.html'));
    cockpitWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    cockpitWindow.on('will-move', (_event, nextBounds) => {
      const display = cockpitDisplay();
      if (!display || !nextBounds) return;
      const base = computeCockpitBounds(mainWindow.getBounds(), display.workArea, cockpitMode);
      cockpitOffset = { x: nextBounds.x - base.x, y: nextBounds.y - base.y };
    });
    cockpitWindow.on('moved', () => {
      const display = cockpitDisplay();
      if (!display || !mainWindow || mainWindow.isDestroyed()) return;
      const base = computeCockpitBounds(mainWindow.getBounds(), display.workArea, cockpitMode);
      const current = cockpitWindow.getBounds();
      cockpitOffset = { x: current.x - base.x, y: current.y - base.y };
    });
    cockpitWindow.on('blur', () => {
      if (cockpitMode !== 'rail' && cockpitMode !== 'onboarding') {
        cockpitMode = 'rail';
        cockpitWindow.webContents.send('cockpit:mode', 'rail');
        syncCockpitBounds();
      }
    });
    cockpitWindow.on('closed', () => { cockpitWindow = null; cockpitMode = 'rail'; });
    syncCockpitBounds();
    return cockpitWindow;
  }

  function cockpitNavigate(mode, page, intent) {
    const allowed = {
      control: ['cost', 'tasks', 'runtime', 'remote', 'plugins', 'skills', 'channels', 'longsession'],
      settings: ['general', 'models', 'runtime', 'remote', 'channels', 'data', 'update', 'about'],
    };
    const m = mode === 'control' || mode === 'settings' ? mode : 'settings';
    const p = allowed[m].includes(page) ? page : (m === 'control' ? 'tasks' : 'general');
    const safeIntent = m === 'control' && p === 'tasks' && intent === 'new-task' ? 'new-task' : '';
    const route = safeIntent === 'new-task'
      ? { mode: m, page: p, intent: 'new-task' }
      : { mode: m, page: p, intent: '' };
    createSettingsWindow(route);
    hideCockpit();
  }

  // ------------------------------------------------------ cockpit snapshot
  async function buildCockpitSnapshot() {
    const now = Date.now();
    if (cockpitSnapshotCache.snapshot && now - cockpitSnapshotCache.at < deps.COCKPIT_SNAPSHOT_TTL_MS) {
      return cockpitSnapshotCache.snapshot;
    }
    const cfg = settingsGet();
    const runtime = deps.runtimeInfo();
    let usage = null;
    let costData = null;
    try { usage = getUsageCache(); } catch { /* no-op */ }
    try { costData = usage ? await costSnapshot(usage) : null; } catch { /* no-op */ }
    const tasks = cfg.scheduledTasks || [];
    const history = cfg.scheduledHistory || [];
    const snapshot = deps.buildSnapshot({
      runtime: { state: getCockpitRuntimeState(), child: !!getRuntimeChild(), url: getRuntimeUrl(), restarting: getCockpitRuntimeState() === 'restarting', version: runtime.activeVersion, activeVersion: runtime.activeVersion },
      usage,
      contextWindow: cfg.contextWindow,
      cost: costData,
      monthlyBudget: cfg.monthlyBudget,
      tasks,
      history,
      running: getScheduledRunning(),
      remote: getRemoteStatus(),
      shell: { version: deps.appVersion, language: lang(), theme: resolvedTheme(), needsSetup: !fs.existsSync(path.join(deps.dshHomeOf(), '.credentials.yaml')), onboardingComplete: !!cfg.cockpitOnboarded },
    });
    cockpitSnapshotCache = { at: now, snapshot };
    return snapshot;
  }

  function invalidateCockpitSnapshot() {
    cockpitSnapshotCache.at = 0;
  }

  async function broadcastCockpitSnapshot() {
    if (!cockpitWindow || cockpitWindow.isDestroyed()) return;
    try { cockpitWindow.webContents.send('cockpit:snapshot', await buildCockpitSnapshot()); } catch { /* ignore */ }
  }

  // ------------------------------------------------------ settings (center)
  function createSettingsWindow(route) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (route && route.mode) settingsWindow.webContents.send('center:navigate', { mode: route.mode, page: route.page || '', intent: route.intent === 'new-task' ? 'new-task' : '' });
      settingsWindow.focus();
      return settingsWindow;
    }
    settingsWindow = new BrowserWindow({
      // 16:10-ish landscape: room for the planned sidebar (208px) + content
      // column (~680px) per UI-REDESIGN-RESEARCH.md §4.3, instead of the old
      // narrow tall strip.
      width: 960,
      height: 720,
      minWidth: 760,
      minHeight: 560,
      backgroundColor: themeBackground(),
      title: t(lang(), 'settings.title', { name: appName }),
      icon: iconPath(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'settings-preload.js'),
      },
    });
    const query = route && route.mode ? `?mode=${encodeURIComponent(route.mode)}&page=${encodeURIComponent(route.page || '')}${route.intent === 'new-task' ? '&intent=new-task' : ''}` : '';
    settingsWindow.loadFile(path.join(__dirname, 'settings.html'), { search: query });
    settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
      const returnPanel = returnToCockpitPending;
      returnToCockpitPending = false;
      cockpitMode = returnPanel ? 'panel' : 'rail';
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        createCockpitWindow();
        showCockpitInactive();
      }
    });
    settingsWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) log(`[settings:console] ${message} (${sourceId}:${line})`);
    });
    log('[shell] settings window opened');
    return settingsWindow;
  }

  function closeSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  }
  function returnToCockpit() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      returnToCockpitPending = true;
      settingsWindow.close();
    } else {
      returnToCockpitPending = false;
    }
  }
  function returnToCockpit(mode = 'rail') {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      returnToCockpitPending = true;
      settingsWindow.close();
    } else {
      returnToCockpitPending = false;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    cockpitMode = mode;
    if (cockpitWindow && !cockpitWindow.isDestroyed()) cockpitWindow.webContents.send('cockpit:mode', mode);
    showCockpitInactive();
  }
  function getMainWindowWebContents() {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  }
  function getSettingsWindowWebContents() {
    return settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow.webContents : null;
  }
  function hasVisibleMainWindow() {
    return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
  }
  function setMainWindowPending(v) { mainWindowPending = !!v; }
  function setCockpitMode(mode) {
    cockpitMode = ['rail', 'peek', 'taskpeek', 'panel', 'onboarding'].includes(mode) ? mode : 'rail';
    return { ok: true, mode: cockpitMode };
  }
  function moveCockpitOffset(x, y) {
    cockpitOffset = { x: Math.max(-2000, Math.min(2000, cockpitOffset.x + x)), y: Math.max(-1200, Math.min(1200, cockpitOffset.y + y)) };
    return { ok: true, offset: cockpitOffset };
  }

  /** Runtime just became healthy: open/refresh the main window + cockpit. */
  function onRuntimeHealthy(bootUrl) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(bootUrl);
      createCockpitWindow();
      showCockpitInactive();
    } else {
      createWindow(bootUrl);
    }
  }

  // safeBounds needs screen; kept private
  function safeBounds(saved) {
    if (!saved) return null;
    const ok = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 40 && saved.y < a.y + a.height - 40
        && saved.x + saved.width > a.x + 40 && saved.y + saved.height > a.y + 40;
    });
    return ok ? saved : null;
  }

  function setLoadingText(text) { setLoading(text); }
  function showLoadingOnError() { deps.showLoadingOnError(); }

  return {
    createWindow, showMain, reloadMainWindow, toggleMainDevTools, pickDialogParent,
    isMainWindowPending, setMainWindowPending, getMainWindowWebContents, getSettingsWindowWebContents,
    hasVisibleMainWindow,
    createCockpitWindow, showCockpitInactive, hideCockpit,
    prepareCockpitForAuxWindow, restoreCockpitRail, syncCockpitBounds, scheduleCockpitSync,
    cockpitNavigate,
    buildCockpitSnapshot, invalidateCockpitSnapshot, broadcastCockpitSnapshot,
    createSettingsWindow, closeSettingsWindow, returnToCockpit,
    setCockpitMode, moveCockpitOffset,
    onRuntimeHealthy, hasTray,
  };
}

module.exports = { createWindowManager };
