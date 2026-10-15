'use strict';

// src/workbench/app/boot.js — the Electron bootstrap shared by every workbench
// entry point. An entry point decides four things — its userData directory, its
// window title, its stdout ready token and any extra IPC it wants to add — and
// everything else (scheme privileges, the tool:// protocol, the office-runtime
// protocol with the read-only content layout store, the office:* stub IPC, the
// tool IPC surface, the window and the preview-ready handshake) is identical.
//
// stdout contract: `<readyToken>` once the shell page AND the preview office
// frame are ready — evidence probes wait on that line. Failures print
// `<failToken> <CODE> [message]` and exit non-zero.

const path = require('node:path');
const fs = require('node:fs');
const { createToolServices } = require('./services.js');
const { registerToolIpc } = require('./ipc.js');
const { generateGallery, waitUntil } = require('./gallery.js');

const PREVIEW_FRAME_MATCH = '/preview/office.html';

// Privileged scheme declarations must precede app ready (same privileges as
// the cockpit and the standalone editor register).
function registerToolSchemes(protocol, scheme = 'workbench') {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
}

function createEmptyOfficeSnapshot() {
  return {
    schemaVersion: 1,
    simulatedAtMs: 0,
    sync: 'healthy',
    scene: { referenceWidth: 1280, referenceHeight: 840 },
    employees: [],
    activityLog: [],
    diagnostics: [],
    capabilities: {},
  };
}

async function startToolApp({
  app,
  protocol,
  ipcMain,
  BrowserWindow,
  config,
  extend = null,
}) {
  const {
    repoRoot,
    dataDir,
    scheme = 'workbench',
    windowTitle,
    readyToken,
    failToken,
    shellPage = 'workbench.html',
    characterId,
    packId = 'deepseek-default',
    windowSize = { width: 1582, height: 955 },
    extendWindowPreferences = null,
    renderTitle,
    stubCode = 'OFFICE_WORKBENCH_STUB',
    onConsole = null,
  } = config;

  const fail = (code, error) => {
    console.error(`${failToken} ${code}${error ? ` ${error}` : ''}`);
    app.exit(1);
  };

  // userData isolation happens BEFORE app ready so no Electron service ever
  // touches the real profile (or the office editor's data directory).
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);

  let mainWindow = null;
  let lastSelectionJson = '';
  let selectionTimer = null;

  // Two frames can serve the office page now: the runtime layer (#preview-frame, the real
  // simulation) and the action editor's DRAFT layer (#bench-frame, the staged pack). They
  // are told apart by the pack id in the URL, so a lookup is never ambiguous.
  const STAGED_PACK_MARK = 'pack=wb-staged';
  const officeFrames = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    try {
      return mainWindow.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.includes(PREVIEW_FRAME_MATCH));
    } catch {
      return [];
    }
  };
  const officeFrame = () => officeFrames().find((frame) => !frame.url.includes(STAGED_PACK_MARK)) || null;
  const benchFrame = () => officeFrames().find((frame) => frame.url.includes(STAGED_PACK_MARK)) || null;

  const pollPreviewSelection = async () => {
    const frame = officeFrame();
    if (!frame) return;
    try {
      const raw = await frame.executeJavaScript(`(() => {
        try {
          const node = document.querySelector('#layout-draft-items .layout-draft-item.selected');
          const row = document.querySelector('#layout-layer-groups .layer-row.selected');
          const selectedId = node ? node.dataset.draftId : (row ? row.dataset.draftId : null);
          const ready = Boolean(window.__office && window.__office.ready);
          const draft = ready ? window.__office.api.layoutDraft() : null;
          const item = draft && selectedId ? draft.items.find((entry) => entry.id === selectedId) || null : null;
          return JSON.stringify({ ready, selectedId, item });
        } catch (error) {
          return JSON.stringify({ ready: false, error: String(error) });
        }
      })()`, true);
      if (raw === lastSelectionJson) return;
      lastSelectionJson = raw;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('workbench:preview-selection', JSON.parse(raw));
      }
    } catch {
      /* preview navigating or closed — retry on the next tick */
    }
  };

  await app.whenReady();
  try {
    const { createOfficeProtocolHandler } = require(path.join(repoRoot, 'src', 'office', 'office-protocol.js'));
    const services = createToolServices({
      repoRoot,
      contentDir: path.join(repoRoot, 'content'),
      charactersRoot: path.join(repoRoot, 'resources', 'characters'),
      characterId,
      scheme,
    });
    services.generateGallery = () => generateGallery({
      BrowserWindow,
      repoRoot,
      contentDir: services.ctx.contentDir,
      scheme,
      packId,
      renderTitle: renderTitle || `${windowTitle} · 金样渲染`,
      libs: services.libs,
      walkGeometryReport: services.walkGeometryReport,
    });

    protocol.handle('office-runtime', createOfficeProtocolHandler({
      officeRoot: path.join(repoRoot, 'src', 'office'),
      nodeModulesRoot: path.join(repoRoot, 'node_modules'),
      officeAssetsRoot: path.join(repoRoot, 'resources', 'office'),
      charactersRoot: path.join(repoRoot, 'resources', 'characters'),
      layoutStore: services.contentLayoutStore(),
    }));
    protocol.handle(scheme, services.protocolHandler());

    // office:* IPC: the same minimal stub set as the standalone editor —
    // the page boots from an empty snapshot and drafts locally. The seven
    // channel names/semantics stay exactly the whitelisted ones.
    const emptySnapshot = createEmptyOfficeSnapshot();
    ipcMain.handle('office:state', () => ({ ok: true, snapshot: emptySnapshot }));
    for (const channel of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) {
      ipcMain.handle(channel, () => ({ ok: false, code: stubCode }));
    }

    registerToolIpc({ ipcMain, services, getWindow: () => mainWindow });

    // ---- main window (three panes; the center hosts the preview iframe) ----
    // sandbox: false + nodeIntegrationInSubFrames: true is what lets the
    // tool-served preview subframe receive the REAL office bridge (this
    // preload requires src/office/office-preload.js verbatim). The window
    // only ever loads repo-local content under the two repo schemes.
    const webPreferences = {
      preload: path.join(repoRoot, 'src', 'workbench', 'workbench-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      sandbox: false,
      backgroundThrottling: false,
    };
    if (extendWindowPreferences) Object.assign(webPreferences, extendWindowPreferences);
    mainWindow = new BrowserWindow({
      width: windowSize.width,
      height: windowSize.height,
      useContentSize: true,
      title: windowTitle,
      show: true,
      webPreferences,
    });
    mainWindow.on('page-title-updated', (event) => event.preventDefault());
    mainWindow.on('closed', () => {
      mainWindow = null;
      if (selectionTimer) clearInterval(selectionTimer);
    });
    if (onConsole) mainWindow.webContents.on('console-message', onConsole);
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => fail(`${failToken}_PAGE_LOAD_FAILED`, `${code} ${description}`));

    // The extension callback registers extra IPC (e.g. the studio's) BEFORE the
    // page loads: the shell's renderer calls its bridge during startup, so a
    // handler registered after loadURL would answer "no handler registered"
    // for exactly those first calls.
    let extension = null;
    if (extend) {
      extension = await extend({ services, ipcMain, mainWindow, officeFrame, benchFrame, waitUntil, fail });
    }

    await mainWindow.loadURL(`${scheme}://local/${shellPage}`);

    selectionTimer = setInterval(pollPreviewSelection, 1000);

    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    console.log(readyToken);
    return { mainWindow, services, officeFrame, benchFrame, extension };
  } catch (error) {
    return fail(`${failToken}_BOOT_ERROR`, error && error.message);
  }
}

module.exports = {
  PREVIEW_FRAME_MATCH,
  createEmptyOfficeSnapshot,
  registerToolSchemes,
  startToolApp,
};
