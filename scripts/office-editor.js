'use strict';

// scripts/office-editor.js — Task E2d: standalone layout editor launcher.
//
// Runs the office page OUTSIDE the cockpit: one BrowserWindow over the same
// office-runtime protocol (shared handler, src/office/office-protocol.js),
// the layout editor auto-opened via ?editor=1. Development-only by design:
// - NOT registered in the app menu or any production entry point; you run it
//   explicitly with `npm run office:editor`.
// - ISOLATED userData: every byte (the saved office-layout.v1.json and the
//   office-state store) lives in .office-editor-data/ (override with
//   OFFICE_EDITOR_DATA_DIR) — the real user userData is never read or
//   written. Delete the directory to reset the editor to factory state.
// - office:* IPC is a MINIMAL STUB set: office:state answers an empty
//   snapshot, everything else answers {ok:false}. No simulation clock, no
//   Harness, no cockpit services.
// - Closing the window quits; a failed boot prints a stable OFFICE_EDITOR_*
//   code to stderr and exits non-zero.
//
// Launch contract on stdout: `OFFICE_EDITOR_READY` once the page reports
// ready AND the layout editor is auto-opened.

const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.OFFICE_EDITOR_DATA_DIR
  ? path.resolve(process.env.OFFICE_EDITOR_DATA_DIR)
  : path.join(REPO_ROOT, '.office-editor-data');
const OFFICE_URL = 'office-runtime://local/office.html?pack=deepseek-default&editor=1';

// Privileged scheme declaration must precede app ready (same privileges as
// the cockpit registers).
protocol.registerSchemesAsPrivileged([
  { scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// userData isolation happens BEFORE app ready so no Electron service ever
// touches the real profile.
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

function fail(code, error) {
  console.error(`OFFICE_EDITOR_BOOT_FAILED ${code}${error ? ` ${error}` : ''}`);
  app.exit(1);
}

app.whenReady().then(async () => {
  if (process.env.OFFICE_EDITOR_HEADLESS === '1' && process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: no Dock bounce in test runs
  try {
    const { createOfficeStateStore } = require(path.join(REPO_ROOT, 'src', 'office', 'runtime', 'office-persistence.js'));
    const { createOfficeProtocolHandler } = require(path.join(REPO_ROOT, 'src', 'office', 'office-protocol.js'));
    // The editor's OWN state store over the isolated data dir — the saved
    // layout route (office-layout.v1.json) reads and writes ONLY here.
    const store = createOfficeStateStore({
      userDataDir: DATA_DIR,
      epoch: Date.now(),
      log: () => {}, // dev launcher: keep stdout to the launch contract
    });
    protocol.handle('office-runtime', createOfficeProtocolHandler({
      officeRoot: path.join(REPO_ROOT, 'src', 'office'),
      nodeModulesRoot: path.join(REPO_ROOT, 'node_modules'),
      officeAssetsRoot: path.join(REPO_ROOT, 'resources', 'office'),
      charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
      layoutStore: store,
    }));

    // office:* minimal stubs (the preload whitelist stays untouched): the
    // page boots from an empty snapshot; dispatch/cancel/interrupt/settings/
    // diagnostics/visibility answer {ok:false} — the editor drafts locally.
    const emptySnapshot = {
      schemaVersion: 1,
      simulatedAtMs: 0,
      sync: 'healthy',
      scene: { referenceWidth: 1280, referenceHeight: 840 },
      employees: [],
      activityLog: [],
      diagnostics: [],
      capabilities: {},
    };
    ipcMain.handle('office:state', () => ({ ok: true, snapshot: emptySnapshot }));
    for (const channel of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) {
      ipcMain.handle(channel, () => ({ ok: false, code: 'OFFICE_EDITOR_STUB' }));
    }

    const win = new BrowserWindow({
      // M2b: tests drive this launcher headlessly; real users get a visible window.
      ...(process.env.OFFICE_EDITOR_HEADLESS === '1' ? { show: false } : {}),
      width: 1600,
      height: 1000,
      useContentSize: true,
      title: 'Office 布局编辑器',
      webPreferences: {
        preload: path.join(REPO_ROOT, 'src', 'office', 'office-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // closing the window quits — no tray, no resident process
    win.on('closed', () => app.quit());
    win.webContents.on('did-fail-load', (_event, code, description) => {
      fail('OFFICE_EDITOR_PAGE_LOAD_FAILED', `${code} ${description}`);
    });

    await win.loadURL(OFFICE_URL);
    // Wait until the page is ready AND ?editor=1 auto-opened the editor —
    // the launch contract other tooling can wait on.
    let opened = false;
    for (let i = 0; i < 90; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const probe = JSON.parse(await win.webContents.executeJavaScript(
        "JSON.stringify({ ready: Boolean(window.__office && window.__office.ready), editorOpen: (() => { const el = document.getElementById('layout-editor'); return !!el && !el.hidden; })() })"
      ).catch(() => 'null'));
      if (probe && probe.ready && probe.editorOpen) { opened = true; break; }
    }
    if (!opened) return fail('OFFICE_EDITOR_PAGE_TIMEOUT');
    console.log('OFFICE_EDITOR_READY');
  } catch (error) {
    return fail('OFFICE_EDITOR_BOOT_ERROR', error && error.message);
  }
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (error) => fail('OFFICE_EDITOR_UNCAUGHT', error && error.message));
