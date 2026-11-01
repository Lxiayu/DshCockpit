// src/aux-windows.js — A1 extraction: the three self-contained auxiliary
// windows (Quick Ask, session search, boot loading splash). Each keeps a
// singleton, restores the cockpit rail on close, and never navigates.
// Cockpit/settings/main-window coordination stays in main.js via injected
// callbacks (prepareCockpitForAuxWindow / restoreCockpitRail).
'use strict';

const path = require('node:path');
const { hardenWebContents } = require('./window-hardening');

/**
 * @param {object} deps
 * @param {new (o: object) => object} deps.BrowserWindow
 * @param {() => string} deps.themeBackground   resolved theme background color
 * @param {() => void} deps.prepareCockpitForAuxWindow
 * @param {() => void} deps.restoreCockpitRail
 * @param {() => string} [deps.appVersion]      shown on the splash meta line
 * @param {(code: number, description: string) => void} [deps.onLoadingError]
 *        loading page failed to load (main.js renders the localized message)
 * @param {(line: string) => void} [deps.log]
 */
function createAuxWindows(deps) {
  const {
    BrowserWindow,
    themeBackground,
    prepareCockpitForAuxWindow = () => {},
    restoreCockpitRail = () => {},
    appVersion = () => '',
    onLoadingError = () => {},
    log = () => {},
    // P2.4：定位常驻小窗到工作区右下角。可选注入——
    // 单元测试拿不到 Electron 的 screen，缺省时跳过低定位（用默认位置）。
    screen = null,
  } = deps;

  let quickAskWindow = null;
  let searchWindow = null;
  let missionDeskWindow = null;
  // P2.4：常驻小窗（独立窗口，不随主窗口销毁）
  let companionWindow = null;
  let loadingWindow = null;
  let pendingLoadingText = null;

  // ------------------------------------------------------------- quick ask
  function createQuickAsk() {
    if (quickAskWindow && !quickAskWindow.isDestroyed()) {
      quickAskWindow.show();
      quickAskWindow.focus();
      return quickAskWindow;
    }
    quickAskWindow = new BrowserWindow({
      width: 460,
      height: 190,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: themeBackground(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'quickask-preload.js'),
      },
    });
    quickAskWindow.loadFile(path.join(__dirname, 'quickask.html'));
    hardenWebContents(quickAskWindow.webContents, { label: 'quick ask' });
    quickAskWindow.once('ready-to-show', () => quickAskWindow.show());
    quickAskWindow.on('closed', () => {
      quickAskWindow = null;
      restoreCockpitRail();
    });
    return quickAskWindow;
  }

  function openQuickAsk() {
    prepareCockpitForAuxWindow();
    return createQuickAsk();
  }

  function closeQuickAsk() { if (quickAskWindow) quickAskWindow.close(); }

  // ----------------------------------------------------------------- search
  function createSearchWindow() {
    if (searchWindow && !searchWindow.isDestroyed()) {
      searchWindow.show();
      searchWindow.focus();
      return searchWindow;
    }
    searchWindow = new BrowserWindow({
      width: 520,
      height: 420,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: themeBackground(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'search-preload.js'),
      },
    });
    searchWindow.loadFile(path.join(__dirname, 'search.html'));
    hardenWebContents(searchWindow.webContents, { label: 'search' });
    searchWindow.once('ready-to-show', () => searchWindow.show());
    searchWindow.on('closed', () => {
      searchWindow = null;
      restoreCockpitRail();
    });
    return searchWindow;
  }

  function openSearchWindow() {
    prepareCockpitForAuxWindow();
    return createSearchWindow();
  }

  function closeSearchWindow() { if (searchWindow) searchWindow.close(); }
  function hasQuickAsk() { return !!quickAskWindow && !quickAskWindow.isDestroyed(); }
  function hasSearch() { return !!searchWindow && !searchWindow.isDestroyed(); }

  // ---------------------------------------------------------- loading splash
  function createLoadingWindow() {
    if (loadingWindow && !loadingWindow.isDestroyed()) { loadingWindow.focus(); return loadingWindow; }
    loadingWindow = new BrowserWindow({
      width: 480,
      height: 260,
      frame: false,
      resizable: false,
      show: false,
      backgroundColor: themeBackground(), // cover the first paint; the page bg matches
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'loading-preload.js'),
      },
    });
    loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
    hardenWebContents(loadingWindow.webContents, { label: 'loading splash' });
    loadingWindow.once('ready-to-show', () => {
      if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.show();
    });
    loadingWindow.webContents.on('did-fail-load', (_event, code, description) => {
      log(`[shell] loading window failed to load (${code}): ${description}`);
      onLoadingError(code, description);
    });
    // re-send the latest text once the page is ready (setLoading may have been
    // called before the renderer registered its IPC listener)
    loadingWindow.webContents.once('did-finish-load', () => {
      if (loadingWindow && !loadingWindow.isDestroyed()) {
        if (pendingLoadingText) loadingWindow.webContents.send('loading:progress', pendingLoadingText);
        loadingWindow.webContents.send('loading:meta', { version: appVersion() });
        // `ready-to-show` is the normal path; this fallback covers older
        // Electron/Windows GPU combinations that never emit it for a frameless
        // window even though the document is fully loaded.
        if (!loadingWindow.isVisible()) loadingWindow.show();
      }
    });
    loadingWindow.on('closed', () => { loadingWindow = null; pendingLoadingText = null; });
    return loadingWindow;
  }

  function setLoading(text) {
    pendingLoadingText = text;
    try {
      if (loadingWindow && !loadingWindow.isDestroyed() && !loadingWindow.webContents.isDestroyed()) {
        loadingWindow.webContents.send('loading:progress', text);
      }
    } catch (err) {
      log(`[shell] loading progress delivery skipped: ${err.message}`);
    }
  }

  /** Close / show helpers used by createWindow's ready & failure paths. */
  function closeLoading() {
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  }
  function showLoadingOnError() {
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.show();
  }

  // P1 Mission Desk（Issue #12）：项目级连续性的主界面。
  // 独立窗口而不是塞进 settings.html —— 后者已 5918 行（TD-31），
  // 再往里加只会让那个文件继续膨胀。
  function createMissionDesk() {
    if (missionDeskWindow && !missionDeskWindow.isDestroyed()) {
      missionDeskWindow.show();
      missionDeskWindow.focus();
      return missionDeskWindow;
    }
    missionDeskWindow = new BrowserWindow({
      width: 1040,
      height: 720,
      minWidth: 720,
      minHeight: 480,
      show: false,
      backgroundColor: themeBackground(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 复用 settings-preload：Mission Desk 只需要 mission 桥，
        // 但那个 preload 已经是最全的一个，且新增一个 preload 意味着
        // 多一处需要同步的 surface。这里刻意复用。
        preload: path.join(__dirname, 'settings-preload.js'),
      },
    });
    missionDeskWindow.loadFile(path.join(__dirname, 'mission-desk.html'));
    hardenWebContents(missionDeskWindow.webContents, { label: 'mission desk' });
    missionDeskWindow.once('ready-to-show', () => missionDeskWindow.show());
    missionDeskWindow.on('closed', () => { missionDeskWindow = null; });
    return missionDeskWindow;
  }

  function openMissionDesk() { return createMissionDesk(); }
  function hasMissionDesk() { return !!missionDeskWindow && !missionDeskWindow.isDestroyed(); }

  // ---------------------------------------------------------------- P2.4 Companion
  //
  // 第一性原理：为什么是独立 BrowserWindow，不是主窗口的子视图
  //
  //   验收标准要求「把办公室收成常驻小窗」，且主窗口收起后它仍在。
  //   子视图（WebContentsView）随主窗口销毁 —— 做不到。
  //
  //   代价是多一个渲染进程，但它加载的是**极简页面**（一个点 + 一行字），
  //   不加载 PixiJS。常驻成本可控。
  //
  // 窗口特性（每一条都有理由）：
  //   · frameless      —— 常驻小窗不该有标题栏
  //   · alwaysOnTop    —— 否则切到别的应用就看不见了，"常驻"失去意义
  //   · skipTaskbar    —— 它是一个挂件，不是主任务
  //   · resizable:false—— 内容只有一行字，改大小没有意义
  function createCompanion() {
    if (companionWindow && !companionWindow.isDestroyed()) {
      companionWindow.show();
      return companionWindow;
    }
    companionWindow = new BrowserWindow({
      width: 220,
      height: 44,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#181a20',
      // 贴右下角：最不挡事的位置
      x: undefined,
      y: undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'companion-preload.js'),
      },
    });
    companionWindow.loadFile(path.join(__dirname, 'companion.html'));
    hardenWebContents(companionWindow.webContents, { label: 'companion' });
    // 定位到工作区右下角（用 screen 的 workArea，避开任务栏/Dock）
    if (screen && typeof screen.getPrimaryDisplay === 'function') {
      try {
        const { workArea } = screen.getPrimaryDisplay();
        companionWindow.setPosition(
          workArea.x + workArea.width - 220 - 24,
          workArea.y + workArea.height - 44 - 24,
        );
      } catch { /* 定位失败不阻塞创建，Electron 会给默认位置 */ }
    }
    companionWindow.once('ready-to-show', () => companionWindow.show());
    companionWindow.on('closed', () => { companionWindow = null; });
    return companionWindow;
  }

  /** 推状态给小窗（主进程调用；派生在 companion-state.js 里已做完）。 */
  function pushCompanionState(state) {
    if (!companionWindow || companionWindow.isDestroyed()) return false;
    try { companionWindow.webContents.send('companion:state', state); return true; }
    catch { return false; }
  }

  function closeCompanion() {
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.close();
    companionWindow = null;
  }

  function hasCompanion() { return !!companionWindow && !companionWindow.isDestroyed(); }
  function setCompanionVisible(visible) {
    if (!companionWindow || companionWindow.isDestroyed()) return;
    if (visible) companionWindow.show(); else companionWindow.hide();
  }

  return {
    createQuickAsk, openQuickAsk, closeQuickAsk, hasQuickAsk,
    openSearchWindow, closeSearchWindow, hasSearch,
    openMissionDesk, hasMissionDesk,
    createCompanion, pushCompanionState, closeCompanion, hasCompanion, setCompanionVisible,
    createLoadingWindow, setLoading, closeLoading, showLoadingOnError,
  };
}

module.exports = { createAuxWindows };
