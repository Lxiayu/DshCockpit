// src/window-manager.js — A1 step 5: main window + Cockpit rail + Settings
// center window management (moved verbatim from main.js). Owns all window
// singletons and their state; main.js consumes the accessor/delegator
// surface returned by createWindowManager().
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createWindowManager(deps) {
  const {
    BrowserWindow, WebContentsView, screen,
    appName, iconPath, themeBackground, resolvedTheme,
    windowState, windowStateFile, officeWindowStateFile,
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
  // M4.2 shell composition: the main window hosts a left rail view plus one
  // of two main-area views (harness / office). The window itself loads nothing.
  let railView = null;
  let harnessView = null;
  let officeShellView = null;
  let activeMainView = 'harness';
  let shellSyncTimer = null;
  let mainWindowPending = false;
  let windowStateSaveTimer = null;
  let cockpitSyncTimer = null;
  let cockpitMode = 'rail';
  let cockpitOffset = { x: 0, y: 0 };
  let returnToCockpitPending = false;
  let cockpitHiddenForAuxWindow = false;
  let cockpitSnapshotCache = { at: 0, snapshot: null };

  // ------------------------------------------ office shell view (M4.2)
  // The office stopped being an independent window: it is a WebContentsView
  // in the main window's right area, swapped with the harness view. Hiding
  // it KEEPS the page alive (the main-process simulation keeps pushing), so
  // switching back is instant and the office keeps living in the background.
  let officeShellOnVisibility = null;
  let officeShellVisibleFlag = 'false|false';

  function officeShellViewId() {
    return officeShellView ? 'office-shell-1' : null;
  }

  function notifyOfficeShellVisibility() {
    // 2026-09-22 修正（用户实测：永远看不到对话气泡）：办公室在 M4.2 就是"后台活着"的
    // 设计——切到 harness 页不该冻结它的仿真，否则闲聊/走位永远积累不到（无头模拟里首聊
    // 约需 2 分钟）。因此：**只有窗口隐藏/最小化才暂停仿真**；`active`（办公室是否为当前
    // 主视图）随载荷下发，供页面做"仅在用户注视时"的节流/提示用。
    const windowVisible = !!(mainWindow && !mainWindow.isDestroyed()
      && mainWindow.isVisible() && !mainWindow.isMinimized());
    const active = !!(officeShellView && activeMainView === 'office');
    const signature = `${windowVisible}|${active}`;
    if (signature === officeShellVisibleFlag) return;
    officeShellVisibleFlag = signature;
    if (typeof officeShellOnVisibility === 'function') {
      try { officeShellOnVisibility(officeShellViewId(), windowVisible); } catch { /* module errors never break the view */ }
    }
    if (officeShellView) {
      try { officeShellView.webContents.send('office:visibility', { viewId: officeShellViewId(), visible: windowVisible, active }); } catch { /* closing */ }
    }
  }

  function showOfficeShellView({ url, onVisibility = null } = {}) {
    if (!url) return null;
    if (typeof onVisibility === 'function') officeShellOnVisibility = onVisibility;
    if (!officeShellView) {
      officeShellView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // The office page stays ALIVE in the background (the simulation
          // keeps pushing): throttling its timers would stall its boot and
          // its snapshot pump exactly when it is hidden.
          backgroundThrottling: false,
          preload: path.join(__dirname, 'office', 'office-preload.js'),
        },
      });
      officeShellView.webContents.on('will-navigate', (e) => e.preventDefault());
      officeShellView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      officeShellView.webContents.loadURL(url);
      log('[office] shell view created (main-area office)');
    }
    activeMainView = 'office';
    syncShellViews();
    notifyOfficeShellVisibility();
    notifyOfficeViewsChanged();
    return officeShellView;
  }

  function hideOfficeShellView() {
    activeMainView = 'harness';
    syncShellViews();
    notifyOfficeShellVisibility();
    notifyOfficeViewsChanged();
  }

  function isOfficeViewActive() {
    return !!(officeShellView && activeMainView === 'office');
  }

  function closeOfficeShellView() {
    if (!officeShellView) return;
    try {
      mainWindow && !mainWindow.isDestroyed() && mainWindow.contentView.removeChildView(officeShellView);
      officeShellView.webContents.close();
    } catch { /* already gone */ }
    officeShellView = null;
    officeShellVisibleFlag = false;
    activeMainView = 'harness';
    notifyOfficeViewsChanged();
  }

  // The module pushes snapshots to whatever office surface exists; the page
  // consumes them whether it is the active view or alive in the background.
  function broadcastToOfficeViews(channel, payload) {
    if (!officeShellView) return;
    try { officeShellView.webContents.send(channel, payload); } catch { /* closing */ }
  }

  function officeViewCount() {
    return officeShellView ? 1 : 0;
  }

  // ---------------------------------------- left function rail (M4.2)
  // The rail is a slim icon strip on the window's left edge (the M4 floating
  // window is retired; the follow-up removed the collapse control — 44px of
  // icons is already the minimal dock). Its page keeps the same preload
  // bridge and IPC channels, plus the shell theme push.
  const OFFICE_RAIL_WIDTH = 44;

  function createRailView() {
    if (railView || !mainWindow || mainWindow.isDestroyed()) return railView;
    railView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'office-rail-preload.js'),
      },
    });
    railView.webContents.loadFile(path.join(__dirname, 'office-rail.html'));
    railView.webContents.on('will-navigate', (e) => e.preventDefault());
    railView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.contentView.addChildView(railView);
    log('[office] left rail view created (in-window shell)');
    return railView;
  }

  function broadcastToOfficeRail(channel, payload) {
    if (!railView) return;
    try { railView.webContents.send(channel, payload); } catch { /* closing */ }
  }

  // Shell-level pushes (theme in particular) must reach the VIEWS: they are
  // not BrowserWindows, so main.js's broadcastTheme loop cannot see them.
  function broadcastToShellViews(channel, payload) {
    broadcastToOfficeRail(channel, payload);
    if (officeShellView) {
      try { officeShellView.webContents.send(channel, payload); } catch { /* closing */ }
    }
  }

  function notifyOfficeViewsChanged() {
    broadcastToOfficeRail('office-rail:office-state', { open: isOfficeViewActive(), count: officeViewCount() });
    broadcastToOfficeRail('office-rail:view-state', { active: activeMainView });
  }

  // ---------------------------------------------- shell view geometry
  // The rail owns the left band at full content height; the ACTIVE main-area
  // view owns everything to its right. The inactive view is detached (its
  // page stays alive) and gets the same main-area bounds for the switch back.
  function syncShellViews() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const content = mainWindow.getContentBounds();
    if (railView) {
      railView.setBounds({ x: 0, y: 0, width: OFFICE_RAIL_WIDTH, height: content.height });
    }
    const mainArea = {
      x: OFFICE_RAIL_WIDTH,
      y: 0,
      width: Math.max(0, content.width - OFFICE_RAIL_WIDTH),
      height: content.height,
    };
    if (harnessView) harnessView.setBounds(mainArea);
    if (officeShellView) officeShellView.setBounds(mainArea);
    const contentView = mainWindow.contentView;
    const attached = (view) => {
      try { return contentView.children.includes(view); } catch { return false; }
    };
    if (activeMainView === 'office' && officeShellView) {
      if (harnessView && attached(harnessView)) contentView.removeChildView(harnessView);
      if (!attached(officeShellView)) contentView.addChildView(officeShellView);
    } else {
      if (officeShellView && attached(officeShellView)) contentView.removeChildView(officeShellView);
      if (harnessView && !attached(harnessView)) contentView.addChildView(harnessView);
    }
  }

  function scheduleShellSync() {
    clearTimeout(shellSyncTimer);
    shellSyncTimer = setTimeout(() => { shellSyncTimer = null; syncShellViews(); }, 16);
  }

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

    mainWindow.on('show', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); syncShellViews(); notifyOfficeShellVisibility(); });
    mainWindow.on('restore', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); syncShellViews(); notifyOfficeShellVisibility(); });
    mainWindow.on('hide', () => { hideCockpit(); notifyOfficeShellVisibility(); });
    mainWindow.on('minimize', () => { hideCockpit(); notifyOfficeShellVisibility(); });
    mainWindow.on('maximize', () => { syncCockpitBounds(); scheduleShellSync(); });
    mainWindow.on('unmaximize', () => { syncCockpitBounds(); scheduleShellSync(); });
    mainWindow.on('enter-full-screen', () => { hideCockpit(); setTimeout(() => { syncCockpitBounds(); showCockpitInactive(); scheduleShellSync(); }, 80); });
    mainWindow.on('leave-full-screen', () => { setTimeout(() => { syncCockpitBounds(); showCockpitInactive(); scheduleShellSync(); notifyOfficeShellVisibility(); }, 80); });

    // M4.2: the window itself loads NOTHING — the harness page lives in a
    // WebContentsView on the right of the rail, preload.js moves with it, and
    // the office view can later swap into the same main area. The rail view is
    // attached last so it always owns the left band on top.
    harnessView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    mainWindow.contentView.addChildView(harnessView);
    createRailView();
    syncShellViews();
    harnessView.webContents.loadURL(url);
    // Show + start deferred services when the page is truly paintable (no white
    // flash). ready-to-show is a BrowserWindow event tied to ITS webContents,
    // so the shell listens on the harness view's first non-empty paint. The
    // timeout fallback covers Windows GPU / older-Electron combos that never
    // emit the paint event, and a did-fail-load retry recovers transient load
    // failures. Without the fallback a stuck main window would leave deferred
    // services (token poll, scheduler, balance, compaction, …) disabled forever.
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
    harnessView.webContents.once('did-first-visually-non-empty-paint', showMainWhenReady);
    harnessView.webContents.once('dom-ready', () => { setTimeout(showMainWhenReady, 120); });
    mainShowFallbackTimer = setTimeout(() => {
      if (!mainShown) {
        log('[shell] main window paint timed out; forcing show');
        showMainWhenReady();
      }
    }, 15_000);
    let mainLoadRetries = 0;
    harnessView.webContents.on('did-fail-load', (_event, code, description) => {
      if (code === -3) return; // ERR_ABORTED: superseded navigation, not a real failure
      log(`[shell] main window failed to load (${code}): ${description}`);
      if (mainLoadRetries < 2 && harnessView && !harnessView.webContents.isDestroyed()) {
        mainLoadRetries += 1;
        setTimeout(() => { if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.loadURL(url); }, 1_000);
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
    mainWindow.on('closed', () => {
      mainWindow = null;
      railView = null;
      harnessView = null;
      officeShellView = null; // child views die with the window's contents
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // persist window bounds (debounced)
    const saveBounds = () => {
      if (mainWindow && !mainWindow.isDestroyed()) windowState.save(windowStateFile(), mainWindow.getBounds());
    };
    mainWindow.on('resize', () => {
      scheduleCockpitSync();
      scheduleShellSync();
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = setTimeout(saveBounds, 500);
    });
    mainWindow.on('move', () => {
      scheduleCockpitSync();
      scheduleShellSync();
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
    if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.reload();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }
  function toggleMainDevTools() {
    if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.toggleDevTools();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools();
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
      control: ['cost', 'tasks', 'runtime', 'remote', 'plugins', 'mcp', 'skills', 'channels', 'longsession'],
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
    // M4.2: the harness VIEW is what main.js used to call "the main window's
    // webContents" — same page, same preload, now hosted in a view.
    if (harnessView && !harnessView.webContents.isDestroyed()) return harnessView.webContents;
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
      if (harnessView && !harnessView.webContents.isDestroyed()) harnessView.webContents.loadURL(bootUrl);
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
    broadcastToOfficeViews, officeViewCount, closeOfficeShellView,
    showOfficeShellView, hideOfficeShellView, isOfficeViewActive,
    broadcastToOfficeRail, broadcastToShellViews,
    syncShellViews, getActiveMainView: () => activeMainView,
    onRuntimeHealthy, hasTray,
  };
}

module.exports = { createWindowManager };
