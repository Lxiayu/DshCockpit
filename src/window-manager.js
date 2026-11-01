// src/window-manager.js — A1 step 5: main window + Cockpit rail + Settings
// center window management (moved verbatim from main.js). Owns all window
// singletons and their state; main.js consumes the accessor/delegator
// surface returned by createWindowManager().
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hardenWebContents } = require('./window-hardening');

function createWindowManager(deps) {
  const {
    BrowserWindow, WebContentsView, screen,
    // TD-09: 外链交给系统浏览器。可选注入——没传时 harnessView 的外链
    // 只被 deny 而不转发（比"强行 require electron"更可控，也便于单测）。
    shell = null,
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
  // of the main-area views (harness / office / work). The window itself loads nothing.
  let railView = null;
  let harnessView = null;
  let officeShellView = null;
  // v0.7 P1: the work view is a third main-area view (task board + artifacts).
  // Like the office it stays alive when hidden; only one main view is attached.
  let workView = null;
  // v0.7 P1.5: the work dock lives at the right edge of the office view.
  // It is a separate sandboxed view (shell-owned) — the office page stays a
  // pure projection consumer; work controls never ride office:*.
  let workDockView = null;
  const WORK_DOCK_WIDTH = 380;
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
  // 2026-09-25 唤醒自愈：main 进程 powerMonitor（lock-screen/unlock-screen/
  // suspend/resume，src/office/power-presentation.js）把「屏幕未在呈现」聚合到
  // 这一个布尔。它参与 office:visibility 推送载荷（`presenting` 字段）与去重
  // 签名——页面用它在锁屏期间停掉渲染判据（节流帧不计入低帧率）、在唤醒沿
  // 自动自愈。没有新 IPC 通道。
  let officePresentationSuspended = false;

  function officeShellViewId() {
    return officeShellView ? 'office-shell-1' : null;
  }

  // 2026-10-30（用户报"鲸鱼娘之间从来没有触发过聊天"的最终真因）：
  // 这个函数有签名去重（signature === officeShellVisibleFlag 直接 return）。
  // 启动时序里它经常在**主窗口还没 isVisible() 之前**就被调用一次，
  // 于是唯一一次通知发的是 `visible=false`；等窗口真正显示后，`show` 事件
  // 若已经错过（或窗口早已可见、事件不再触发），就**永远不会有第二次通知**，
  // 主进程侧的 visibleViews 一直是空集 → isPaused() 恒 true →
  // advanceOneTick 恒返回 null → 整间办公室的模拟永久冻结。
  // 生产实测日志：`[wm-vis] false|true|true` 只打了一行，
  // `[office] clock fires=3434 ticks=0`，一天下来一次聊天都没有。
  //
  // forceNotifyOfficeShellVisibility(): 无视去重，强制重算并重发一次。
  function forceNotifyOfficeShellVisibility() {
    officeShellVisibleFlag = null;
    notifyOfficeShellVisibility();
  }

  function notifyOfficeShellVisibility() {
    // 2026-09-22 修正（用户实测：永远看不到对话气泡）：办公室在 M4.2 就是"后台活着"的
    // 设计——切到 harness 页不该冻结它的仿真，否则闲聊/走位永远积累不到（无头模拟里首聊
    // 约需 2 分钟）。因此：**只有窗口隐藏/最小化才暂停仿真**；`active`（办公室是否为当前
    // 主视图）随载荷下发，供页面做"仅在用户注视时"的节流/提示用。
    const windowVisible = !!(mainWindow && !mainWindow.isDestroyed()
      && mainWindow.isVisible() && !mainWindow.isMinimized());
    const active = !!(officeShellView && activeMainView === 'office');
    const presenting = !officePresentationSuspended;
    const signature = `${windowVisible}|${active}|${presenting}`;
    if (signature === officeShellVisibleFlag) return;
    officeShellVisibleFlag = signature;
    if (typeof officeShellOnVisibility === 'function') {
      try { officeShellOnVisibility(officeShellViewId(), windowVisible); } catch { /* module errors never break the view */ }
    }
    if (officeShellView) {
      try { officeShellView.webContents.send('office:visibility', { viewId: officeShellViewId(), visible: windowVisible, active, presenting }); } catch { /* closing */ }
    }
  }

  // 2026-09-25 唤醒自愈：powerMonitor 信号的唯一入口（src/office/power-presentation.js
  // 把事件映射到这里）。同值调用是 no-op，状态变化才推一次 office:visibility。
  function setOfficePresentationSuspended(suspended) {
    const next = !!suspended;
    if (next === officePresentationSuspended) return;
    officePresentationSuspended = next;
    notifyOfficeShellVisibility();
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
      hardenWebContents(officeShellView.webContents, { label: 'office view', log });
      // The dock may be created before the office page finishes booting; re-send
      // the layout once it can actually receive pushes.
      officeShellView.webContents.on('did-finish-load', () => {
        if (activeMainView === 'office') sendOfficeDockLayout(!!workDockView);
      });
      officeShellView.webContents.loadURL(url);
      // 页面加载完成后强制重发一次可见性：这一刻窗口一定已经就绪，
      // 是"世界该不该跑"最可靠的判定点（见 forceNotifyOfficeShellVisibility）。
      officeShellView.webContents.on('did-finish-load', () => {
        setTimeout(forceNotifyOfficeShellVisibility, 120);
      });
      log('[office] shell view created (main-area office)');
    }
    activeMainView = 'office';
    showWorkDock();
    syncShellViews();
    notifyOfficeShellVisibility();
    notifyOfficeViewsChanged();
    return officeShellView;
  }

  function hideOfficeShellView() {
    activeMainView = 'harness';
    sendOfficeDockLayout(false);
    syncShellViews();
    notifyOfficeShellVisibility();
    notifyOfficeViewsChanged();
  }

  function isOfficeViewActive() {
    return !!(officeShellView && activeMainView === 'office');
  }

  // ------------------------------------------ work shell view (v0.7 P1)
  function showWorkShellView() {
    if (!workView) {
      workView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // 产物读取与状态推送是事件驱动的；后台节流会让"切回来"看到旧状态。
          backgroundThrottling: false,
          preload: path.join(__dirname, 'work', 'work-preload.js'),
        },
      });
      hardenWebContents(workView.webContents, { label: 'work view', log });
      workView.webContents.loadFile(path.join(__dirname, 'work', 'work.html'));
      log('[work] shell view created (main-area workbench)');
    }
    activeMainView = 'work';
    syncShellViews();
    notifyOfficeShellVisibility();
    notifyOfficeViewsChanged();
    return workView;
  }

  function isWorkViewActive() {
    return !!(workView && activeMainView === 'work');
  }

  /** 工作坞：办公室右侧的壳视图（compact 工作台）。 */
  function showWorkDock() {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    if (!workDockView) {
      workDockView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          // Mission Desk 需要 mission 桥 —— settings-preload 是唯一同时提供
          // mission + shell 的那个（与独立 Mission Desk 窗口同源，见 aux-windows.js）。
          preload: path.join(__dirname, 'settings-preload.js'),
        },
      });
      hardenWebContents(workDockView.webContents, { label: 'mission desk dock', log });
      // 同一个 mission-desk.html，dock=1 切单列布局。
      // 为什么复用而不是新写一页：两份 UI 必然漂移（todo 列表、状态色、
      // 错误文案都要同步两处）。这里只让布局随尺寸变。
      workDockView.webContents.loadFile(path.join(__dirname, 'mission-desk.html'), { query: { dock: '1' } });
      log('[work] mission desk dock created (office right side)');
    }
    sendOfficeDockLayout(true);
    syncShellViews();
    return workDockView;
  }

  function sendOfficeDockLayout(dock) {
    if (!officeShellView) return;
    try {
      officeShellView.webContents.send('shell:office-layout', { dock: !!dock, width: WORK_DOCK_WIDTH });
    } catch { /* closing */ }
  }

  function sendToWorkView(channel, payload) {
    // dock 现在是 Mission Desk，不再消费 work:update —— 只推给 work 主视图。
    // 继续广播会往一个不监听的页面发消息（无害但误导）。
    if (!workView) return;
    try { workView.webContents.send(channel, payload); } catch { /* closing */ }
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
    hardenWebContents(railView.webContents, { label: 'office rail', log });
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
    for (const view of [workView, workDockView]) {
      if (!view) continue;
      try { view.webContents.send(channel, payload); } catch { /* closing */ }
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
    const dockActive = activeMainView === 'office' && !!workDockView;
    const officeWidth = dockActive ? Math.max(0, mainArea.width - WORK_DOCK_WIDTH) : mainArea.width;
    if (harnessView) harnessView.setBounds(mainArea);
    if (officeShellView) officeShellView.setBounds({ ...mainArea, width: officeWidth });
    if (workDockView) {
      workDockView.setBounds({
        x: mainArea.x + officeWidth,
        y: 0,
        width: Math.min(WORK_DOCK_WIDTH, mainArea.width),
        height: mainArea.height,
      });
    }
    if (workView) workView.setBounds(mainArea);
    const contentView = mainWindow.contentView;
    const attached = (view) => {
      try { return contentView.children.includes(view); } catch { return false; }
    };
    const active = activeMainView === 'office' ? officeShellView
      : activeMainView === 'work' ? workView
        : harnessView;
    const visible = [active, dockActive ? workDockView : null].filter(Boolean);
    for (const view of [harnessView, officeShellView, workDockView, workView]) {
      if (view && !visible.includes(view) && attached(view)) contentView.removeChildView(view);
    }
    for (const view of visible) {
      if (!attached(view)) contentView.addChildView(view);
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

    mainWindow.on('show', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); syncShellViews(); forceNotifyOfficeShellVisibility(); });
    mainWindow.on('restore', () => { createCockpitWindow(); syncCockpitBounds(); showCockpitInactive(); syncShellViews(); forceNotifyOfficeShellVisibility(); });
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
    // TD-09：harnessView 是**唯一加载第三方代码**的视图（dsh 自己的 Web UI）。
    // 它此前两个 handler 都没有——若 dsh UI 里有 window.open，
    // Electron 会按默认 webPreferences 派生子窗口（安全项不由我们决定）。
    hardenWebContents(harnessView.webContents, {
      label: 'harness view (third-party UI)',
      log,
      // 外链走系统浏览器；只放行 http/https（file://、javascript: 不传）
      onExternal: (href) => {
        if (shell && typeof shell.openExternal === 'function') {
          try { shell.openExternal(href); } catch { /* a failed external open must not break the view */ }
        }
      },
    });
    mainWindow.contentView.addChildView(harnessView);
    createRailView();
    syncShellViews();
    harnessView.webContents.loadURL(url);
    // Show the main window when the page is truly paintable (no white flash).
    // ready-to-show is a BrowserWindow event tied to ITS webContents,
    // so the shell listens on the harness view's first non-empty paint. The
    // timeout fallback covers Windows GPU / older-Electron combos that never
    // emit the paint event, and a did-fail-load retry recovers transient load
    // failures.
    // v0.6（WP3）：延迟服务**不再**由 paint 触发 —— 改由 onRuntimeHealthy
    //（runtime 健康是它们的真实前置；办公室默认视图下 harness 视图只是占位）。
    // "runtime 永远起不来"的服务保活兜底移到了壳侧（main.js 45s 定时器）。
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
      workView = null;
      workDockView = null;
    });
    hardenWebContents(mainWindow.webContents, { label: 'main window', log });

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
    hardenWebContents(cockpitWindow.webContents, { label: 'cockpit window', log });
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
    hardenWebContents(settingsWindow.webContents, { label: 'settings window', log });
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

  /** Runtime just became healthy: open/refresh the main window + cockpit.
   *  v0.6（WP3）：延迟服务在这里启动（runtime 健康是它们的真实前置）；
   *  startDeferredServices 幂等（deferredServicesStarted 守卫在壳侧）。 */
  function onRuntimeHealthy(bootUrl) {
    startDeferredServices();
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
    showWorkShellView, isWorkViewActive, sendToWorkView, showWorkDock,
    isWorkDockVisible: () => !!(workDockView && activeMainView === 'office'),
    setOfficePresentationSuspended,
    broadcastToOfficeRail, broadcastToShellViews,
    syncShellViews, getActiveMainView: () => activeMainView,
    onRuntimeHealthy, hasTray,
  };
}

module.exports = { createWindowManager };
