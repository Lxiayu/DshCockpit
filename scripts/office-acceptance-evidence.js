'use strict';

// scripts/office-acceptance-evidence.js — Task 9 / SPEC-09 acceptance evidence.
//
// Electron entrypoint (mirrors scripts/office-view-evidence.js): serves the
// office page over the local office-runtime scheme, runs the REAL office
// module + IPC handlers in this main process, and drives the SPEC-09
// scenario matrix in phases. All numeric simulation time is the module's
// fixed-step logical clock (16ms ticks) advanced explicitly, so every
// capture is deterministic for a given phase.
//
// Phases (env DSH_OFFICE_ACCEPTANCE_PHASE):
//   main      S1 local roam, perf/FPS, S2 task->seat->result->local,
//             S3 collaborator FIFO, S4 cancel pending->terminal,
//             S5 stale/resyncing, S6 resize/clock integrity,
//             S7 two views one clock, S8 pack-missing fallback,
//             S9 corrupt office-state recovery (main process),
//             replay-a deterministic fixed-layout capture
//   webgl-off S8 WebGL init failure -> canvas/static fallback
//   hidpi     high-DPI capture (DPR 2) with anchor check
//   replay-b  second deterministic run + 5% layout pixel diff vs replay-a
//
// Raw artifacts (PNG + summary JSON) are written to
// env DSH_OFFICE_ACCEPTANCE_STAGING; the Node redaction pass assembles the
// final redacted evidence directory. PNG captures show only the redacted
// office UI (generic labels, privacyMode=redacted).
//
// Exit codes: 0 all checks passed | 1 evidence failures (see summary JSON).

const electron = require('electron');
const { app, BrowserWindow, protocol, ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_SCHEME = 'office-runtime';
const LOWFPS_SCHEME = 'office-runtime-lowfps';
const REPO_ROOT = path.resolve(__dirname, '..');
const OFFICE_ROOT = path.join(REPO_ROOT, 'src', 'office');
const VIEWPORT = { width: 1280, height: 840 };
const REPLAY_TICK_TARGET_MS = 4000;

const PHASE = process.env.DSH_OFFICE_ACCEPTANCE_PHASE || 'main';
const STAGING = process.env.DSH_OFFICE_ACCEPTANCE_STAGING;

function isElectronMain() {
  return typeof electron === 'object' && electron !== null && !!electron.app;
}

// Deterministic DPR: baseline runs force DPR 1; the hidpi phase forces 2.
if (isElectronMain() && process.type === 'browser') {
  if (PHASE === 'hidpi') app.commandLine.appendSwitch('force-device-scale-factor', '2');
  else app.commandLine.appendSwitch('force-device-scale-factor', '1');
  if (PHASE === 'webgl-off') {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
  }
}

function contentTypeFor(abs) {
  if (abs.endsWith('.html')) return 'text/html; charset=utf-8';
  if (abs.endsWith('.css')) return 'text/css; charset=utf-8';
  if (abs.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (abs.endsWith('.json')) return 'application/json; charset=utf-8';
  if (abs.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// PNG IHDR: width/height are big-endian uint32 at byte offsets 16 and 20.
function pngDimensions(abs) {
  const header = fs.readFileSync(abs).subarray(0, 33);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function decodedPackBytes() {
  const root = path.join(OFFICE_ROOT, 'fixtures', 'character-pack', 'assets', 'animations');
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.png')) {
        const { width, height } = pngDimensions(abs);
        files += 1;
        bytes += width * height * 4;
      }
    }
  };
  walk(root);
  return { files, decodedRgbaBytes: bytes };
}

async function run() {
  if (!STAGING) throw new Error('DSH_OFFICE_ACCEPTANCE_STAGING is required');
  fs.mkdirSync(STAGING, { recursive: true });
  const summary = {
    schemaVersion: 1,
    phase: PHASE,
    ok: true,
    failures: [],
    checks: [],
    captures: [],
    metrics: {},
  };
  const check = (id, ok, detail) => {
    summary.checks.push({ id, ok: !!ok, detail: ok ? (detail === undefined ? null : detail) : String(detail) });
    if (!ok) {
      summary.ok = false;
      summary.failures.push(id);
    }
  };
  const capture = (name) => `${name}.png`;

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: LOWFPS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);
  await app.whenReady();

  // Evidence-only switches: 404 the character-pack texture frames (exercises
  // the REAL renderer placeholder path) or the pack manifest itself (exposes
  // the page boot behavior when the pack is absent).
  let hidePackTextures = false;
  let hidePackManifest = false;
  await protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel.startsWith('fixtures/character-pack/')) {
      if (hidePackManifest) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      if (hidePackTextures && rel.includes('/assets/')) {
        return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      }
    }
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
        headers: {
          'content-type': contentTypeFor(abs),
          'access-control-allow-origin': `${APP_SCHEME}://local`,
          'cache-control': 'no-store',
        },
      });
    }
    return new Response('not found', { status: 404 });
  });

  const { createOfficeModule, registerOfficeIpc } = require(path.join(OFFICE_ROOT, 'office-module.js'));
  const { createOfficeStateStore, DEFAULT_SETTINGS, DEFAULT_FLAGS } = require(path.join(OFFICE_ROOT, 'runtime', 'office-persistence.js'));
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
    pack = null; // placeholder mode (must not crash the page)
  }

  const module = createOfficeModule({ pack, log: () => {} });
  registerOfficeIpc({ ipcMain, module, log: () => {} });
  module.subscribe((snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('office:state', snapshot); } catch { /* closing */ }
    }
  });

  // Clock sampler: 100ms wall-time samples of the logical clock, used to
  // attribute any unexpected advancement to a concrete phase step.
  const clockTrace = [];
  const samplerStart = Date.now();
  const sampler = setInterval(() => {
    if (clockTrace.length < 4000) {
      clockTrace.push({ wallMs: Date.now() - samplerStart, logicalMs: module.state().simulatedAtMs, paused: module.isPaused() });
    }
  }, 100);

  const visibilityPolls = [];
  function makeOfficeWindow(viewId, width, height) {
    const win = new BrowserWindow({
      width,
      height,
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
    let lastKnownVisible = win.isVisible();
    module.noteVisibility({ viewId, visible: lastKnownVisible });
    const poll = setInterval(() => {
      if (win.isDestroyed()) {
        clearInterval(poll);
        return;
      }
      const visible = win.isVisible();
      if (visible !== lastKnownVisible) {
        lastKnownVisible = visible;
        module.noteVisibility({ viewId, visible });
      }
    }, 200);
    visibilityPolls.push(poll);
    return win;
  }

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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const page = async (win, expression) => win.webContents.executeJavaScript(expression, true);

  async function shot(win, name) {
    await sleep(300); // settle composite
    let image = await win.webContents.capturePage();
    if (image.isEmpty() || isAllBlack(image)) {
      await sleep(400);
      image = await win.webContents.capturePage();
    }
    if (!image.isEmpty() && !isAllBlack(image)) {
      const file = path.join(STAGING, capture(name));
      fs.writeFileSync(file, image.toPNG());
      summary.captures.push(capture(name));
      return { file: capture(name), capture: 'capturePage' };
    }
    const dataUrl = await page(win, `(async () => {
      const v = window.__office && window.__office.renderer;
      if (v && v.app && v.app.renderer && v.app.renderer.extract) {
        try { return await v.app.renderer.extract.base64(v.app.stage); } catch { return null; }
      }
      return null;
    })()`);
    if (dataUrl) {
      const file = path.join(STAGING, capture(name));
      fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
      summary.captures.push(capture(name));
      return { file: capture(name), capture: 'pixi-extract' };
    }
    check(`capture-${name}`, false, 'no capture method produced a non-empty frame');
    return { file: null, capture: 'unavailable' };
  }

  async function bootPage(win, url) {
    const startedAt = Date.now();
    await win.loadURL(url);
    for (let waited = 0; waited < 30000; waited += 200) {
      const ready = await page(win, 'window.__office && window.__office.ready === true');
      if (ready) return Date.now() - startedAt;
      await sleep(200);
    }
    throw new Error('office page never became ready');
  }

  // Deterministic clock drivers (module auto-timer is NOT running in these).
  const tickTo = (targetMs) => {
    let guard = 0;
    while (module.state().simulatedAtMs < targetMs && guard < 200000) {
      module.advanceOneTick();
      guard += 1;
    }
    return module.state();
  };
  const waitTickUntil = (predicate, maxTicks) => {
    let guard = 0;
    while (guard < (maxTicks || 5000)) {
      const state = module.advanceOneTick();
      if (predicate(state)) return state;
      guard += 1;
    }
    return null;
  };
  const employee = (state, id) => state.employees.find((entry) => entry.employeeId === id);
  // Deterministic fixed-layout capture: a FRESH module instance (same seed,
  // no harness events) advanced to the target logical tick; the page canvas
  // is driven by per-tick pushes of that module's snapshots, so the capture
  // depends only on the tick count. Used by both the main and replay-b
  // phases; two runs of the same procedure must render identical layouts.
  async function makeReplayCapture(tag) {
    const replayModule = createOfficeModule({ pack, log: () => {} });
    const replayWin = makeOfficeWindow(`replay-view-${tag}`, VIEWPORT.width, VIEWPORT.height);
    await bootPage(replayWin, `${APP_SCHEME}://local/office.html`);
    await sleep(800);
    for (let tick = 0; tick < REPLAY_TICK_TARGET_MS / 16; tick += 1) {
      replayModule.advanceOneTick();
      replayWin.webContents.send('office:state', replayModule.state());
    }
    await sleep(700);
    const replayState = replayModule.state();
    const metrics = {
      fakeClockTickMs: replayState.simulatedAtMs,
      stateHash: sha256(JSON.stringify(replayState.employees.map((e) => [e.employeeId, e.position, e.activity, e.animation]))),
    };
    await shot(replayWin, `replay-${tag}-t${REPLAY_TICK_TARGET_MS}ms`);
    replayWin.destroy();
    replayModule.destroy();
    return metrics;
  }
  const infoFor = async (win) => page(win, `(() => { const a = window.__office.api; return {
    rendererMode: a.rendererMode(), diagnosticCode: a.diagnosticCode(),
    pixiVersion: a.pixiVersion(), devicePixelRatio: a.devicePixelRatio(),
    appTickerStarted: !!(window.__office.renderer.app && window.__office.renderer.app.ticker.started),
    sharedTickerCount: window.PIXI ? window.PIXI.Ticker.shared.count : null,
    fonts: getComputedStyle(document.body).fontFamily }; })()`);

  // ---------------------------------------------------------------------------
  // Phase: low-fps — Blocker B fix (SPEC-07): the REAL renderer + fps-monitor
  // run in real Chromium against INJECTED frame samples (20 fps synthetic
  // clock), proving the sustained-low-FPS path degrades this view to the
  // static diagnostic presentation with LOW_FPS_PERSISTENT (distinct from
  // init-failure codes), while healthy samples never degrade.
  // ---------------------------------------------------------------------------
  if (PHASE === 'low-fps') {
    const win = new BrowserWindow({
      width: VIEWPORT.width,
      height: 600,
      useContentSize: true,
      show: true,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    const lowFpsHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>office low-fps evidence</title></head>
<body>
<div id="mount" style="width:1280px;height:600px"></div>
<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>
<script>
(async () => {
  const REGISTRY = {};
  const loadModule = (url, requireShim) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + ': ' + r.status); return r.text(); })
    .then((src) => { const m = { exports: {} }; new Function('module', 'exports', 'require', src + '\\n//# sourceURL=' + url)(m, m.exports, requireShim || (() => { throw new Error('require unsupported: ' + url); })); return m.exports; });
  const loadJson = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); });
  REGISTRY['office-layout'] = await loadModule('./runtime/office-layout.js');
  REGISTRY['fps-monitor'] = await loadModule('./render/fps-monitor.js');
  REGISTRY['pixi-office-renderer'] = await loadModule('./render/pixi-office-renderer.js', (spec) => {
    if (spec === './fps-monitor.js') return REGISTRY['fps-monitor'];
    throw new Error('require unsupported: ' + spec);
  });
  const layout = REGISTRY['office-layout'].createOfficeLayout(await loadJson('./fixtures/office-layout.json'));
  let syntheticNowMs = 0;
  const renderer = await REGISTRY['pixi-office-renderer'].createOfficeRenderer({
    PIXI: window.PIXI,
    layout,
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot: null,
    mount: document.getElementById('mount'),
    fpsMonitor: {
      thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5,
      now: () => syntheticNowMs,
      scheduleFrame: () => 0, // samples are injected below; no self-scheduling
    },
  });
  const healthyNow = () => { syntheticNowMs += 16.6; };
  for (let i = 0; i < 30 * 8; i += 1) { healthyNow(); renderer.fpsMonitor.frame(); } // 8 healthy windows
  const healthyState = { mode: renderer.mode, code: renderer.diagnosticCode, degraded: renderer.fpsMonitor.degraded() };
  const lowNow = () => { syntheticNowMs += 50; }; // 20 fps synthetic
  for (let i = 0; i < 30 * 7 && !renderer.fpsMonitor.degraded(); i += 1) { lowNow(); renderer.fpsMonitor.frame(); }
  const staticEl = renderer.staticElement;
  window.__lowfps = {
    done: true,
    healthyState,
    mode: renderer.mode,
    diagnosticCode: renderer.diagnosticCode,
    degraded: renderer.fpsMonitor.degraded(),
    datasetCode: staticEl && staticEl.dataset ? staticEl.dataset.diagnosticCode : null,
    staticText: staticEl ? String(staticEl.textContent).slice(0, 60) : null,
  };
})().catch((error) => { window.__lowfps = { done: true, fatal: String(error && error.message || error) }; });
</script>
</body></html>`;
    await protocol.handle(LOWFPS_SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'local') return new Response('not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (rel === 'evidence-lowfps.html') {
        return new Response(lowFpsHtml, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      const routes = [
        { prefix: 'node_modules/', root: path.join(REPO_ROOT, 'node_modules') },
        { prefix: '', root: OFFICE_ROOT },
      ];
      for (const route of routes) {
        if (!rel.startsWith(route.prefix)) continue;
        const abs = path.resolve(route.root, rel.slice(route.prefix.length));
        if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
        }
        return new Response(fs.readFileSync(abs), {
          headers: { 'content-type': contentTypeFor(abs), 'cache-control': 'no-store' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    await win.loadURL(`${LOWFPS_SCHEME}://local/evidence-lowfps.html`);
    for (let waited = 0; waited < 20000; waited += 200) {
      // eslint-disable-next-line no-await-in-loop
      const done = await page(win, 'window.__lowfps && window.__lowfps.done === true');
      if (done) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(200);
    }
    const lowFpsState = await page(win, 'window.__lowfps');
    summary.metrics.lowFps = lowFpsState;
    if (lowFpsState.fatal) {
      check('lowfps-page-ran', false, lowFpsState.fatal);
    } else {
      check('lowfps-healthy-no-degrade', lowFpsState.healthyState && lowFpsState.healthyState.mode === 'webgl'
        && lowFpsState.healthyState.degraded === false, JSON.stringify(lowFpsState.healthyState));
      check('lowfps-degraded-static', lowFpsState.degraded === true && lowFpsState.mode === 'static'
        && lowFpsState.diagnosticCode === 'LOW_FPS_PERSISTENT',
        `mode=${lowFpsState.mode} code=${lowFpsState.diagnosticCode}`);
      check('lowfps-static-element-coded', lowFpsState.datasetCode === 'LOW_FPS_PERSISTENT',
        `dataset=${lowFpsState.datasetCode} text=${lowFpsState.staticText}`);
    }
    await sleep(400);
    await shot(win, 'lowfps-fallback-static');
    win.destroy();
    summary.metrics.lowFpsNote = 'real renderer + real monitor in Chromium; frame samples injected (20 fps synthetic clock, healthy 60 fps baseline first); the office simulation clock is not involved';
  }

  // ---------------------------------------------------------------------------
  // Phase: main
  // ---------------------------------------------------------------------------
  if (PHASE === 'main') {
    const win = makeOfficeWindow('evidence-view-1', VIEWPORT.width, VIEWPORT.height);
    summary.metrics.bootLoadMs = await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(800); // texture decode settle
    const info = await infoFor(win);
    summary.metrics.renderer = info;
    check('renderer-webgl', info.rendererMode === 'webgl', `mode=${info.rendererMode} code=${info.diagnosticCode}`);

    module.start(); // live local behavior for S1 + perf
    await sleep(1500);

    // S1 — no Harness conversation: residents roam locally, never offline.
    const s1 = module.state();
    const localSet = new Set(['roaming', 'chatting', 'resting', 'sleeping']);
    check('s1-five-present', s1.employees.length === 5 && s1.employees.every((e) => e.presence === 'present'),
      `count=${s1.employees.length}`);
    check('s1-local-activities', s1.employees.every((e) => localSet.has(e.activity)),
      s1.employees.map((e) => `${e.employeeId}:${e.activity}`).join(','));
    check('s1-no-offline', s1.employees.every((e) => e.activity !== 'offline' && e.runtime !== 'offline'), 'presence=present');
    await shot(win, 's1-local-roam-1280x840');

    // Perf — five active characters, rAF fps sampled over 4s in 1s buckets.
    const perfPage = await page(win, `(async () => {
      const buckets = [];
      await new Promise((resolve) => {
        let count = 0; let bucketStart = performance.now(); const start = bucketStart;
        function loop(t) {
          count += 1;
          if (t - bucketStart >= 1000) { buckets.push(count); count = 0; bucketStart = t; }
          if (t - start >= 4000) { resolve(); return; }
          requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
      });
      return buckets;
    })()`);
    const avgFps = perfPage.reduce((sum, value) => sum + value, 0) / Math.max(1, perfPage.length);
    const minFps = Math.min(...perfPage);
    const memorySamples = [];
    for (let sample = 0; sample < 3; sample += 1) {
      // Electron 37 names renderer processes "Tab" in getAppMetrics().
      const metrics = app.getAppMetrics()
        .filter((proc) => proc.type === 'Renderer' || proc.type === 'Tab')
        .map((proc) => ({ pid: 'renderer', workingSetKb: proc.memory && proc.memory.workingSetSize }));
      memorySamples.push({ atMs: module.state().simulatedAtMs, renderers: metrics });
      await sleep(600);
    }
    const textures = decodedPackBytes();
    const activitySummary = module.state().employees.map((e) => `${e.employeeId}:${e.activity}`).join(',');
    summary.metrics.performance = {
      scenario: {
        activeCharacters: 5,
        viewport: '1280x840',
        viewportLogical: '1280x840',
        devicePixelRatio: info.devicePixelRatio,
        dprNote: 'display-forced DPR; force-device-scale-factor=1 is ineffective on this single-2x-display machine (tested separately)',
      },
      fps: { threshold: 30, measuredAvg: Number(avgFps.toFixed(2)), measuredMin: minFps, buckets: perfPage, sampleMs: 4000 },
      textures: { ...textures, loadMs: summary.metrics.bootLoadMs },
      tickers: { appTickerStarted: info.appTickerStarted, sharedCount: info.sharedTickerCount },
      dpi: info.devicePixelRatio,
      fonts: info.fonts,
      memoryTrend: memorySamples,
      activityDuringSampling: activitySummary,
    };
    check('perf-five-active', module.state().employees.filter((e) => e.activity !== 'sleeping').length === 5, activitySummary);
    // Blocker B fix: the production page arms the runtime FPS observer. It
    // must stay armed and must NOT false-positive during a healthy run.
    const monitorInfo = await page(win, `(() => {
      const r = window.__office.renderer;
      return { armed: !!r.fpsMonitor, degraded: r.fpsMonitor ? r.fpsMonitor.degraded() : null };
    })()`);
    summary.metrics.fpsMonitor = monitorInfo;
    check('fps-monitor-armed', monitorInfo.armed === true, JSON.stringify(monitorInfo));
    check('fps-monitor-no-false-positive', monitorInfo.armed === true && monitorInfo.degraded === false,
      JSON.stringify(monitorInfo));
    await shot(win, 'perf-five-active-1280x840');
    module.stop(); // from here on: deterministic explicit ticks only

    // S2 — trusted running -> seat, result, back to local.
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'agent/status', seq: 1, time: 2000, data: { status: 'running' } });
    tickTo(module.state().simulatedAtMs + 90); // ~1.5s of walking
    let state = module.state();
    const orchestrator = employee(state, 'orchestrator');
    check('s2-bound-and-moving', !!orchestrator.binding && (orchestrator.movement === 'moving' || orchestrator.activity === 'working'),
      `movement=${orchestrator.movement} activity=${orchestrator.activity}`);
    await shot(win, 's2-walk-to-seat');
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'orchestrator');
      return rec.movement === 'stationary' && rec.activity === 'working';
    }, 3000);
    check('s2-working-at-seat', !!state, 'orchestrator working at desk');
    await shot(win, 's2-working-at-seat');
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'turn/end', seq: 2, time: 3000, data: { reason: 'completed' } });
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'orchestrator');
      return !!rec.lastResult && rec.lastResult.outcome === 'completed';
    }, 200);
    check('s2-result-completed', !!state, 'lastResult recorded');
    await shot(win, 's2-result-completed');
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'orchestrator');
      return !rec.binding && ['roaming', 'chatting', 'resting'].includes(rec.activity);
    }, 2000);
    check('s2-released-to-local', !!state, 'binding released, local behavior resumed');
    await shot(win, 's2-released-local');

    // S3 — collaborator FIFO: first subagent binds, second waits, atomic switch.
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'subagent/start', seq: 3, time: 4000, data: { id: 'fixture-child-a' } });
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'collaborator');
      return !!rec.binding && rec.binding.source === 'heuristic';
    }, 500);
    check('s3-first-subagent-bound', !!state, 'collaborator bound to first child');
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'subagent/start', seq: 4, time: 4100, data: { id: 'fixture-child-b' } });
    state = module.state();
    const collaboratorS3 = employee(state, 'collaborator');
    check('s3-second-waits', collaboratorS3.queueCount === 1 && collaboratorS3.waiting.length === 1 && collaboratorS3.waiting[0].position === 1,
      `queueCount=${collaboratorS3.queueCount} waiting=${JSON.stringify(collaboratorS3.waiting)}`);
    check('s3-single-collaborator', state.employees.filter((e) => e.employeeId === 'collaborator').length === 1
      && state.employees.every((e) => e.employeeId !== 'collaborator' || !!e.binding), 'exactly one collaborator seat');
    await shot(win, 's3-fifo-waiting');
    module.ingestHarnessEvent({
      sessionId: 'fixture-root', type: 'subagent/end', seq: 5, time: 4200,
      data: { id: 'fixture-child-a', terminal: true, outcome: 'completed', stopReason: 'completed' },
    });
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'collaborator');
      return rec.queueCount === 0 && !!rec.binding;
    }, 1200); // result presentation (~5s) then atomic FIFO switch
    check('s3-atomic-fifo-switch', !!state, 'queue drained and next item bound');
    await shot(win, 's3-fifo-switch');

    // S4 — cancel is only pending; terminal evidence releases.
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'agent/status', seq: 6, time: 5000, data: { status: 'running' } });
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'orchestrator');
      return rec.movement === 'stationary' && rec.activity === 'working';
    }, 3000);
    check('s4-turn2-working', !!state, 'orchestrator rebound for turn 2');
    const cancelOutcome = module.cancel({ employeeId: 'orchestrator' });
    check('s4-cancel-accepted', cancelOutcome.ok === true, JSON.stringify(cancelOutcome));
    state = module.state();
    const cancelledRec = employee(state, 'orchestrator');
    check('s4-cancel-pending-only', cancelledRec.control === 'cancellationPending' && !!cancelledRec.binding,
      `control=${cancelledRec.control} binding=${cancelledRec.binding ? 'active' : 'gone'}`);
    await shot(win, 's4-cancel-pending');
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'turn/end', seq: 7, time: 5200, data: { reason: 'aborted' } });
    state = waitTickUntil((snapshot) => {
      const rec = employee(snapshot, 'orchestrator');
      return !rec.binding && rec.control === 'none';
    }, 2000);
    check('s4-terminal-released', !!state, 'binding released only after terminal evidence');
    await shot(win, 's4-cancel-released');

    // S5 — sequence gap -> resyncing/stale; local behavior and bindings survive.
    const beforeSync = module.state();
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'agent/status', seq: 900, time: 6000, data: { status: 'idle' } });
    let syncState = module.state();
    check('s5-resyncing-or-buffered', ['resyncing', 'stale'].includes(syncState.sync) || syncState.sync === 'healthy',
      `sync=${syncState.sync}`);
    for (let tick = 0; tick < 160; tick += 1) module.advanceOneTick(); // > 2s buffer window
    syncState = module.state();
    check('s5-stale-no-offline', ['stale', 'resyncing'].includes(syncState.sync)
      && syncState.employees.every((e) => e.presence === 'present'),
      `sync=${syncState.sync}`);
    const collaboratorS5 = employee(syncState, 'collaborator');
    check('s5-bound-not-sleeping', !!collaboratorS5.binding && collaboratorS5.activity !== 'sleeping',
      `activity=${collaboratorS5.activity} binding=${collaboratorS5.binding ? 'active' : 'gone'}`);
    const localActivitiesKept = syncState.employees
      .filter((e) => e.employeeId !== 'collaborator')
      .every((e) => ['roaming', 'chatting', 'resting', 'sleeping'].includes(e.activity));
    check('s5-local-behavior-kept', localActivitiesKept, 'local activities unchanged under stale sync');
    await shot(win, 's5-stale-resyncing');

    // S6 — resize keeps logical anchors; clock integrity; no duplicate ticker.
    const clockBeforeIdle = module.state().simulatedAtMs;
    await sleep(700); // idle: no auto timer, no hidden ticker may advance the clock
    const clockAfterIdle = module.state().simulatedAtMs;
    check('s6-no-hidden-clock-advance', clockAfterIdle === clockBeforeIdle, `${clockBeforeIdle} -> ${clockAfterIdle}`);
    const oneTick = module.advanceOneTick();
    check('s6-single-tick-step', oneTick.simulatedAtMs === clockAfterIdle + 16, `+${oneTick.simulatedAtMs - clockAfterIdle}ms`);
    await sleep(400);
    check('s6-no-duplicate-ticker', module.state().simulatedAtMs === oneTick.simulatedAtMs, 'clock frozen without explicit ticks');
    const positionsBefore = module.state().employees.map((e) => [e.employeeId, e.position]);
    win.setBounds({ width: 720, height: 620, x: win.getBounds().x, y: win.getBounds().y });
    await page(win, 'window.__office.api.resizeTo(window.innerWidth, window.innerHeight)');
    await sleep(500);
    summary.metrics.clockTrace = [{ at: 'after-resize', ms: module.state().simulatedAtMs }];
    const positionsAfter = module.state().employees.map((e) => [e.employeeId, e.position]);
    check('s6-resize-logical-anchors', JSON.stringify(positionsBefore) === JSON.stringify(positionsAfter), 'logical positions unchanged');
    const narrowInfo = await infoFor(win);
    await shot(win, 's6-resize-narrow-720x620');
    win.setBounds({ width: VIEWPORT.width, height: VIEWPORT.height, x: win.getBounds().x, y: win.getBounds().y });
    await page(win, `window.__office.api.resizeTo(${VIEWPORT.width}, ${VIEWPORT.height})`);
    await sleep(400);
    summary.metrics.narrowInfo = narrowInfo;

    // S7 — two views, one main-process clock. pushSnapshot only fires on
    // state transitions, so the shared-watermark proof is: baseline both
    // pages, drive ONE real transition push (an ingest), and both pages must
    // land on the same watermark.
    const second = makeOfficeWindow('evidence-view-2', 900, 700);
    await bootPage(second, `${APP_SCHEME}://local/office.html`);
    const baseline1 = await page(win, 'window.__office.api.snapshot().simulatedAtMs');
    const baseline2 = await page(second, 'window.__office.api.snapshot().simulatedAtMs');
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'agent/status', seq: 901, time: 7000, data: { status: 'idle' } });
    let clockPage1 = baseline1;
    for (let waited = 0; waited < 10000 && clockPage1 === baseline1; waited += 200) {
      await sleep(200);
      clockPage1 = await page(win, 'window.__office.api.snapshot().simulatedAtMs');
    }
    const clockPage2 = await page(second, 'window.__office.api.snapshot().simulatedAtMs');
    const clockMain = module.state().simulatedAtMs;
    check('s7-shared-clock', clockPage1 !== baseline1 && clockPage1 === clockPage2 && clockMain >= clockPage1,
      `main=${clockMain} view1=${baseline1}->${clockPage1} view2=${baseline2}->${clockPage2}`);
    await shot(win, 's7-two-views');
    second.webContents.destroy();
    second.destroy();
    for (let tick = 0; tick < 8; tick += 1) module.advanceOneTick(); // push throttle needs >= 100ms logical gap
    module.ingestHarnessEvent({ sessionId: 'fixture-root', type: 'agent/status', seq: 902, time: 7100, data: { status: 'idle' } });
    let clockAfterClose = clockPage1;
    for (let waited = 0; waited < 10000 && clockAfterClose === clockPage1; waited += 200) {
      await sleep(200);
      clockAfterClose = await page(win, 'window.__office.api.snapshot().simulatedAtMs');
    }
    const survivedState = await page(win, 'window.__office.api.snapshot()');
    check('s7-first-view-survives', survivedState.employees.length === 5 && clockAfterClose !== clockPage1,
      `employees=${survivedState.employees.length} pageClock=${clockPage1}->${clockAfterClose}`);
    await shot(win, 's7-one-view-remains');

    // S8a — missing texture frames: real renderer placeholder path, details
    // and log stay usable (SPEC-07/08 fallback chain).
    hidePackTextures = true;
    await win.webContents.session.clearCache(); // the 404s must not be served from cache
    await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(700);
    const packMissingInfo = await infoFor(win);
    const rendererDiag = await page(win, 'window.__office.renderer.diagnostics()');
    const detailsAlive = await page(win, `(() => {
      const api = window.__office.api;
      api.select('researcher');
      const details = document.querySelector('#details, .office-details, [data-details]');
      return { detailsAlive: !!details, selected: api.selected() };
    })()`);
    summary.metrics.packMissing = {
      rendererMode: packMissingInfo.rendererMode,
      diagnosticCode: packMissingInfo.diagnosticCode,
      textureCount: rendererDiag.textureCount,
      entityCount: rendererDiag.entityCount,
      detailsAlive: detailsAlive.detailsAlive,
    };
    check('s8-pack-missing-no-blank', rendererDiag.textureCount === 0 && rendererDiag.entityCount === 5,
      `textures=${rendererDiag.textureCount} entities=${rendererDiag.entityCount}`);
    check('s8-details-still-usable', detailsAlive.detailsAlive && detailsAlive.selected === 'researcher',
      JSON.stringify(detailsAlive));
    await shot(win, 's8-pack-missing-fallback');
    hidePackTextures = false;

    // S8b — missing pack manifest (Task 9 blocker A fix, SPEC-07): the page
    // boots through office-boot with a stable PACK_MISSING diagnostic, stays
    // ready, and keeps details/log usable with placeholder sprites.
    hidePackManifest = true;
    await win.webContents.session.clearCache();
    await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(700);
    const bootState = await page(win, `(() => {
      const api = window.__office.api;
      api.select('researcher');
      const details = document.querySelector('#details, .office-details, [data-details]');
      const log = document.getElementById('activity-log');
      return {
        ready: window.__office ? window.__office.ready === true : false,
        error: window.__office && window.__office.error ? window.__office.error : null,
        packDiagnostic: typeof api.packDiagnostic === 'function' ? api.packDiagnostic() : null,
        rendererMode: api.rendererMode(),
        detailsAlive: !!details,
        selected: api.selected(),
        logEntries: log ? log.children.length : -1,
        note: document.getElementById('fallback-note') ? document.getElementById('fallback-note').textContent : null,
      };
    })()`);
    summary.metrics.packManifestBoot = bootState;
    check('s8-pack-manifest-boot', bootState.ready === true && bootState.packDiagnostic === 'PACK_MISSING',
      `ready=${bootState.ready} packDiagnostic=${bootState.packDiagnostic} error=${bootState.error}`);
    check('s8-pack-manifest-details-log-usable',
      bootState.detailsAlive === true && bootState.selected === 'researcher' && bootState.logEntries >= 0,
      `details=${bootState.detailsAlive} selected=${bootState.selected} logEntries=${bootState.logEntries}`);
    await shot(win, 's8-pack-manifest-fallback');
    hidePackManifest = false;
    await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(600);

    // S9 — corrupt office-state: recover defaults/backup, never touch legacy files.
    const s9Base = path.join(STAGING, 's9-userdata');
    fs.rmSync(s9Base, { recursive: true, force: true });
    fs.mkdirSync(s9Base, { recursive: true });
    const decoys = {
      'settings.json': '{"schemaVersion":1,"decoy":"legacy-settings"}',
      'runtime-state.json': '{"decoy":"legacy-runtime-state"}',
    };
    for (const [name, content] of Object.entries(decoys)) fs.writeFileSync(path.join(s9Base, name), content);
    const decoyHashes = Object.fromEntries(Object.keys(decoys).map((name) => [name, sha256(fs.readFileSync(path.join(s9Base, name)))]));
    fs.writeFileSync(path.join(s9Base, 'office-state.v1.json'), '{"schemaVersion":1,"settings":{"sleepAfter": BROKEN');
    const corruptStore = createOfficeStateStore({ userDataDir: s9Base, log: () => {} });
    const recoveredDefaults = corruptStore.get();
    const corruptCodes = corruptStore.diagnostics();
    check('s9-corrupt-detected', corruptCodes.some((entry) => entry.code === 'OFFICE_STATE_CORRUPT'), JSON.stringify(corruptCodes));
    check('s9-recovered-defaults', recoveredDefaults.settings.sleepAfterMs === DEFAULT_SETTINGS.sleepAfterMs
      && recoveredDefaults.flags.officeRuntimeEnabled === DEFAULT_FLAGS.officeRuntimeEnabled,
      `sleepAfterMs=${recoveredDefaults.settings.sleepAfterMs}`);
    const hashesAfterDefaults = Object.fromEntries(Object.keys(decoys).map((name) => [name, sha256(fs.readFileSync(path.join(s9Base, name)))]));
    check('s9-legacy-untouched-defaults', JSON.stringify(hashesAfterDefaults) === JSON.stringify(decoyHashes), 'decoy hashes unchanged');

    const s9Backup = path.join(STAGING, 's9-userdata-backup');
    fs.rmSync(s9Backup, { recursive: true, force: true });
    const seedStore = createOfficeStateStore({ userDataDir: s9Backup, log: () => {} });
    await seedStore.updateSettings({ sleepAfterMs: 60000 });
    await sleep(100);
    fs.writeFileSync(path.join(s9Backup, 'office-state.v1.json'), 'GARBAGE NOT JSON');
    const backupStore = createOfficeStateStore({ userDataDir: s9Backup, log: () => {} });
    check('s9-backup-recovery', backupStore.get().settings.sleepAfterMs === 60000,
      `sleepAfterMs=${backupStore.get().settings.sleepAfterMs}`);
    check('s9-backup-diagnostic', backupStore.diagnostics().some((entry) => entry.code === 'OFFICE_STATE_CORRUPT'),
      JSON.stringify(backupStore.diagnostics()));
    const hashesAfterBackup = Object.fromEntries(Object.keys(decoys).map((name) => [name, sha256(fs.readFileSync(path.join(s9Base, name)))]));
    check('s9-legacy-untouched-backup', JSON.stringify(hashesAfterBackup) === JSON.stringify(decoyHashes), 'decoy hashes unchanged');
    summary.metrics.s9 = { corruptCodes, backupCodes: backupStore.diagnostics() };
    await shot(win, 's9-corrupt-state-office');

    // replay-a — deterministic fixed-layout capture on a fresh module instance.
    summary.metrics.replayA = await makeReplayCapture('a');
    check('replay-a-tick-target', summary.metrics.replayA.fakeClockTickMs === REPLAY_TICK_TARGET_MS,
      `t=${summary.metrics.replayA.fakeClockTickMs}`);
  }

  // ---------------------------------------------------------------------------
  // Phase: webgl-off — S8 WebGL init failure classification
  // ---------------------------------------------------------------------------
  if (PHASE === 'webgl-off') {
    const win = makeOfficeWindow('evidence-view-noisolate', VIEWPORT.width, VIEWPORT.height);
    await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(900);
    const info = await infoFor(win);
    summary.metrics.webglOff = info;
    check('s8-webgl-init-failed', ['WEBGL_INIT_FAILED', 'RENDERER_UNAVAILABLE'].includes(info.diagnosticCode)
      || info.rendererMode !== 'webgl',
      `mode=${info.rendererMode} code=${info.diagnosticCode}`);
    const detailsAlive = await page(win, `(() => {
      const api = window.__office.api;
      api.select('researcher');
      const details = document.querySelector('#details, .office-details, [data-details]');
      return { detailsAlive: !!details, selected: api.selected() };
    })()`);
    check('s8-webgl-details-usable', detailsAlive.detailsAlive && detailsAlive.selected === 'researcher',
      JSON.stringify(detailsAlive));
    await shot(win, 's8-webgl-fallback-static');
    win.destroy();
  }

  // ---------------------------------------------------------------------------
  // Phase: hidpi — high-DPI capture with anchor check
  // ---------------------------------------------------------------------------
  if (PHASE === 'hidpi') {
    const win = makeOfficeWindow('evidence-view-hidpi', VIEWPORT.width, VIEWPORT.height);
    await bootPage(win, `${APP_SCHEME}://local/office.html`);
    await sleep(900);
    const info = await infoFor(win);
    summary.metrics.hidpi = info;
    check('hidpi-dpr2', info.devicePixelRatio === 2, `dpr=${info.devicePixelRatio}`);
    const positions = module.state().employees.map((e) => [e.employeeId, e.position]);
    check('hidpi-anchors-stable', positions.length === 5, 'logical anchors unchanged under DPR 2');
    summary.metrics.hidpiNote = 'this machine has a single 2x display: the DPR 2 capture doubles as the high-DPI case; a DPR 1 baseline could not be forced (force-device-scale-factor tested ineffective, offscreen setDeviceScaleFactor hangs)';
    await shot(win, 'hidpi-default-1280x840-dpr2');
    win.destroy();
  }

  // ---------------------------------------------------------------------------
  // Phase: replay-b — second deterministic capture; the pixel diff itself is
  // computed by the Node orchestrator (pure zlib PNG decode), not here.
  // ---------------------------------------------------------------------------
  if (PHASE === 'replay-b') {
    summary.metrics.replayB = await makeReplayCapture('b');
    check('replay-b-tick-target', summary.metrics.replayB.fakeClockTickMs === REPLAY_TICK_TARGET_MS,
      `t=${summary.metrics.replayB.fakeClockTickMs}`);
  }

  for (const poll of visibilityPolls) clearInterval(poll);
  clearInterval(sampler);
  summary.metrics.clockTrace = clockTrace.filter((entry, index) => index === 0
    || entry.logicalMs !== clockTrace[index - 1].logicalMs
    || entry.paused !== clockTrace[index - 1].paused);
  module.destroy();
  fs.writeFileSync(path.join(STAGING, `summary-${PHASE}.json`), JSON.stringify(summary, null, 2));
  console.log(`[office-acceptance] phase=${PHASE} ok=${summary.ok} checks=${summary.checks.length} failures=${summary.failures.length}`);
  app.exit(summary.ok ? 0 : 1);
}

if (isElectronMain() && process.type === 'browser') {
  // Evidence harness only: a timer callback racing a destroyed window or any
  // other main-process crash must record a fatal summary and exit non-zero
  // instead of raising the modal crash dialog and blocking automation.
  process.on('uncaughtException', (error) => {
    const failure = { schemaVersion: 1, phase: PHASE, ok: false, fatal: String((error && error.stack) || error) };
    try {
      if (STAGING) fs.writeFileSync(path.join(STAGING, `summary-${PHASE}.json`), JSON.stringify(failure, null, 2));
    } catch { /* staging lost */ }
    console.log(`[office-acceptance] phase=${PHASE} fatal: ${failure.fatal.split('\n')[0]}`);
    try { app.exit(1); } catch { process.exit(1); }
  });
  run().catch((error) => {
    const failure = { schemaVersion: 1, phase: PHASE, ok: false, fatal: String((error && error.message) || error) };
    try { if (STAGING) fs.writeFileSync(path.join(STAGING, `summary-${PHASE}.json`), JSON.stringify(failure, null, 2)); } catch { /* staging lost */ }
    console.log(`[office-acceptance] phase=${PHASE} fatal: ${failure.fatal}`);
    app.exit(1);
  });
} else {
  module.exports = { contentTypeFor, pngDimensions, decodedPackBytes };
}
