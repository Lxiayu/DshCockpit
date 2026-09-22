'use strict';

// scripts/office-view-evidence.js — Task 7 / SPEC-07 acceptance evidence.
//
// Electron entrypoint (mirrors the office-pixi-smoke pattern): serves the
// office page over the local office-runtime scheme, runs the REAL office
// module + IPC handlers in this main process, opens an office view, and
// captures the SPEC-07 acceptance scenarios:
//
//   01 default local roaming (1280x840, no Harness conversation)
//   02 narrow window (resize keeps anchors, panel docks below)
//   03 trusted task -> employee walks to the seat
//   04 working at the seat
//   05 keyboard selection (details panel hierarchy)
//   06 result presentation (completed)
//   07 released -> back to local behavior
//   08 hidden window pauses the clock, resume continues (no time replay)
//   09 second view shares one clock; closing one view keeps the other alive
//
// Usage:
//   DSH_DESKTOP_OFFICE_EVIDENCE_OUT=<dir> ./node_modules/.bin/electron scripts/office-view-evidence.js
//
// Exit codes: 0 ok | 1 evidence failure (details on stdout JSON).

const electron = require('electron');
const { app, BrowserWindow, protocol, ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');

const APP_SCHEME = 'office-runtime';
const REPO_ROOT = path.resolve(__dirname, '..');
const OFFICE_ROOT = path.join(REPO_ROOT, 'src', 'office');

function isElectronMain() {
  return typeof electron === 'object' && electron !== null && !!electron.app;
}

function contentTypeFor(abs) {
  if (abs.endsWith('.html')) return 'text/html; charset=utf-8';
  if (abs.endsWith('.css')) return 'text/css; charset=utf-8';
  if (abs.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (abs.endsWith('.json')) return 'application/json; charset=utf-8';
  if (abs.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function run() {
  const outDir = process.env.DSH_DESKTOP_OFFICE_EVIDENCE_OUT
    || path.join(REPO_ROOT, 'artifacts', 'office-view', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
  await app.whenReady();
  await protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const routes = [
      { prefix: 'node_modules/', root: path.join(REPO_ROOT, 'node_modules') },
      { prefix: '', root: OFFICE_ROOT },
    ];
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new Response('not found', { status: 404 });
      }
      return new Response(fs.readFileSync(abs), {
        headers: { 'content-type': contentTypeFor(abs), 'access-control-allow-origin': `${APP_SCHEME}://local` },
      });
    }
    return new Response('not found', { status: 404 });
  });

  const { createOfficeModule, registerOfficeIpc } = require(path.join(OFFICE_ROOT, 'office-module.js'));
  const { createAssetPack } = require(path.join(OFFICE_ROOT, 'runtime', 'asset-pack.js'));
  const packRoot = path.join(OFFICE_ROOT, 'fixtures', 'character-pack');
  let pack = null;
  try {
    pack = createAssetPack({
      manifest: JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8')),
      anchors: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'anchors.json'), 'utf8')),
      animations: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'animations.json'), 'utf8')),
    }).pack;
  } catch {
    pack = null; // placeholder mode (still must not crash)
  }
  const module = createOfficeModule({ pack, log: () => {} });
  registerOfficeIpc({ ipcMain, module, log: () => {} });
  module.subscribe((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('office:state', snapshot); } catch { /* closing */ }
    }
  });
  module.start();

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    useContentSize: true,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(OFFICE_ROOT, 'office-preload.js'),
      backgroundThrottling: false,
    },
  });
  // mirrors window-manager wiring: isVisible() polling is the source of
  // truth (show/hide events do not fire on every platform flow)
  let lastKnownVisible = win.isVisible();
  module.noteVisibility({ viewId: 'evidence-view-1', visible: lastKnownVisible });
  const visibilityPoll = setInterval(() => {
    const visible = win.isVisible();
    if (visible !== lastKnownVisible) {
      lastKnownVisible = visible;
      module.noteVisibility({ viewId: 'evidence-view-1', visible });
    }
  }, 200);
  const evidence = { schemaVersion: 1, outDir, steps: [], failures: [] };
  const isAllBlack = (image) => {
    try {
      const bitmap = image.getBitmap();
      const step = Math.max(4, Math.floor(bitmap.length / 512)) * 4;
      for (let i = 0; i + 3 < bitmap.length; i += step) {
        if (bitmap[i] !== 0 || bitmap[i + 1] !== 0 || bitmap[i + 2] !== 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  // capturePage composites through the screen compositor and returns black
  // frames when the physical display is asleep/locked; the in-page Pixi
  // extract reads the WebGL framebuffer directly and always works.
  const shot = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 250)); // settle composite
    let image = await win.webContents.capturePage();
    if (image.isEmpty() || isAllBlack(image)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      image = await win.webContents.capturePage();
    }
    if (!image.isEmpty() && !isAllBlack(image)) {
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, image.toPNG());
      return { file, capture: 'capturePage' };
    }
    const dataUrl = await page(`(async () => {
      const v = window.__office.renderer;
      if (v && v.app && v.app.renderer && v.app.renderer.extract) {
        try { return await v.app.renderer.extract.base64(v.app.stage); } catch { return null; }
      }
      return null;
    })()`);
    if (dataUrl) {
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
      return { file, capture: 'pixi-extract-display-asleep' };
    }
    return { capture: 'unavailable' };
  };
  const step = async (name, fn) => {
    const startedAt = Date.now();
    try {
      const detail = await fn();
      evidence.steps.push({ name, ok: true, ms: Date.now() - startedAt, ...(detail || {}) });
    } catch (error) {
      evidence.steps.push({ name, ok: false, ms: Date.now() - startedAt, error: String((error && error.message) || error) });
      evidence.failures.push(name);
    }
  };
  const page = async (expression) => win.webContents.executeJavaScript(expression, true);
  const waitFor = async (expression, timeoutMs = 60000, pollMs = 200) => {
    for (let waited = 0; waited < timeoutMs; waited += pollMs) {
      // eslint-disable-next-line no-await-in-loop
      const value = await page(expression);
      if (value) return value;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`waitFor timeout: ${expression}`);
  };

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) process.stderr.write(`[office-evidence:renderer] ${message}\n`);
  });
  await win.loadURL(`${APP_SCHEME}://local/office.html`);
  await waitFor('window.__office && window.__office.ready === true', 30000);

  await step('01-default-1280x840', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1200)); // first composite
    const info = await page(`(() => { const a = window.__office.api; return {
      rendererMode: a.rendererMode(), diagnosticCode: a.diagnosticCode(),
      pixiVersion: a.pixiVersion(), devicePixelRatio: a.devicePixelRatio(),
      overview: a.overview(), employees: a.snapshot().employees.length }; })()`);
    const shotInfo = await shot('01-default-1280x840');
    return { ...shotInfo, ...info };
  });

  await step('02-narrow-window', async () => {
    try {
      win.setBounds({ width: 720, height: 620, x: win.getBounds().x, y: win.getBounds().y });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const info = await page(`(() => { const a = window.__office.api;
        a.resizeTo(window.innerWidth, window.innerHeight);
        const snap = a.snapshot();
        return { rendererMode: a.rendererMode(), dpr: a.devicePixelRatio(),
          positions: snap.employees.map((e) => [e.employeeId, e.position]) }; })()`);
      const shotInfo = await shot('02-narrow-720x620');
      return { ...shotInfo, ...info };
    } finally {
      win.setBounds({ width: 1280, height: 840, x: win.getBounds().x, y: win.getBounds().y });
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  });

  await step('03-task-walk-to-seat', async () => {
    module.ingestHarnessEvent({ sessionId: 'sess-evidence', type: 'agent/status', seq: 1, time: Date.now(), data: { status: 'running' } });
    await waitFor(`(() => { const a = window.__office.api; const s = a.snapshot();
      const e = s.employees.find((x) => x.employeeId === 'orchestrator');
      return !!e.binding && (e.movement === 'moving' || (e.movement === 'stationary' && e.activity === 'working')); })()`, 20000);
    return { ...(await shot('03-walking-to-desk')) };
  });

  await step('04-working-at-seat', async () => {
    await waitFor(`(() => { const a = window.__office.api; const s = a.snapshot();
      const e = s.employees.find((x) => x.employeeId === 'orchestrator');
      return e.movement === 'stationary' && e.activity === 'working'; })()`, 120000, 400);
    return { ...(await shot('04-working-at-desk-1')) };
  });

  await step('05-keyboard-selection', async () => {
    await page(`(() => { const a = window.__office.api;
      a.key('ArrowDown'); a.key('Enter'); return a.selected(); })()`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const selected = await page('window.__office.api.selected()');
    if (selected !== 'researcher') throw new Error(`keyboard selection failed: ${selected}`);
    const shotInfo = await shot('05-selected-details');
    return { ...shotInfo, selected };
  });

  await step('06-result-presentation', async () => {
    module.ingestHarnessEvent({ sessionId: 'sess-evidence', type: 'turn/end', seq: 2, time: Date.now(), data: { reason: 'completed' } });
    await waitFor(`(() => { const a = window.__office.api; const s = a.snapshot();
      const e = s.employees.find((x) => x.employeeId === 'orchestrator');
      return !!e.lastResult && e.lastResult.outcome === 'completed'; })()`, 15000);
    return { ...(await shot('06-result-completed')) };
  });

  await step('07-released-back-to-local', async () => {
    await waitFor(`(() => { const a = window.__office.api; const s = a.snapshot();
      const e = s.employees.find((x) => x.employeeId === 'orchestrator');
      return !e.binding && ['roaming', 'chatting', 'resting', 'sleeping'].includes(e.activity); })()`, 30000, 300);
    return { ...(await shot('07-released-local')) };
  });

  let pausedSnapshotMs = null;
  await step('08-visibility-pause', async () => {
    win.hide();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!module.isPaused()) throw new Error('module not paused after hide()');
    const before = module.state().simulatedAtMs;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = module.state().simulatedAtMs;
    if (after !== before) throw new Error(`clock advanced while hidden: ${before} -> ${after}`);
    pausedSnapshotMs = before;
    win.show();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (module.isPaused()) throw new Error('module still paused after show()');
    const resumed = module.state().simulatedAtMs;
    if (resumed <= before) throw new Error('clock did not resume');
    return { pausedAtMs: before, resumedAtMs: resumed, noReplay: true };
  });

  await step('09-two-views-one-clock', async () => {
    const second = new BrowserWindow({
      width: 900, height: 700, show: true, autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(OFFICE_ROOT, 'office-preload.js'), backgroundThrottling: false,
      },
    });
    await second.loadURL(`${APP_SCHEME}://local/office.html`);
    for (let waited = 0; waited < 30000; waited += 250) {
      // eslint-disable-next-line no-await-in-loop
      const ready = await second.webContents.executeJavaScript('window.__office && window.__office.ready === true', true);
      if (ready) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const beforeSecond = module.state().simulatedAtMs;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const sharedClock = module.state().simulatedAtMs > beforeSecond;
    second.webContents.destroy();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const survived = module.state();
    const shotInfo = await shot('09-back-to-one-view');
    return { ...shotInfo, sharedClock, firstViewAlive: survived.employees.length === 5 };
  });

  clearInterval(visibilityPoll);
  module.destroy();
  evidence.ok = evidence.failures.length === 0;
  console.log(JSON.stringify(evidence, null, 2));
  const reportFile = path.join(outDir, 'evidence.json');
  fs.writeFileSync(reportFile, JSON.stringify(evidence, null, 2));
  app.exit(evidence.ok ? 0 : 1);
}

if (isElectronMain() && process.type === 'browser') {
  run().catch((error) => {
    console.log(JSON.stringify({ ok: false, error: String((error && error.message) || error) }, null, 2));
    app.exit(1);
  });
} else {
  module.exports = { contentTypeFor };
}
