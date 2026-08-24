// src/aux-windows.js — A1 extraction: the three self-contained auxiliary
// windows (Quick Ask, session search, boot loading splash). Each keeps a
// singleton, restores the cockpit rail on close, and never navigates.
// Cockpit/settings/main-window coordination stays in main.js via injected
// callbacks (prepareCockpitForAuxWindow / restoreCockpitRail).
'use strict';

const path = require('node:path');

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
  } = deps;

  let quickAskWindow = null;
  let searchWindow = null;
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
    quickAskWindow.webContents.on('will-navigate', (e) => e.preventDefault());
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
    searchWindow.webContents.on('will-navigate', (e) => e.preventDefault());
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
    loadingWindow.webContents.on('will-navigate', (e) => e.preventDefault());
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

  return {
    createQuickAsk, openQuickAsk, closeQuickAsk, hasQuickAsk,
    openSearchWindow, closeSearchWindow, hasSearch,
    createLoadingWindow, setLoading, closeLoading, showLoadingOnError,
  };
}

module.exports = { createAuxWindows };
