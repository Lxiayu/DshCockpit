'use strict';

// scripts/office-pixi-smoke.js — Task 1 / SPEC-01 Pixi smoke probe.
//
// Electron entrypoint (never a plain Node WebGL program):
//   ./node_modules/.bin/electron scripts/office-pixi-smoke.js [--headless]
//
// Creates exactly one BrowserWindow (visible normally; hidden + offscreen with
// --headless), one PIXI.Application, and one Sprite whose texture comes from a
// locally generated canvas fixture (zero network). Waits for one rendered
// frame, verifies a non-blank pixel, then destroys Sprite -> Application ->
// Window in reverse order. Prints one JSON report on stdout. Exit codes:
//   0 ok | 1 PIXI_INIT_FAILED / PIXI_BLANK_RENDER
//   5 PIXI_NETWORK_REQUEST | 6 PIXI_DESTROY_LEAK
//
// All resources load through the local office-probe:// app scheme; there is no
// CDN, no remote URL and no bundler. node --test requires this file only for
// SMOKE_SCHEMA_KEYS / buildSmokeReport / ERROR_CODES (Electron API calls are
// guarded so plain Node never touches them).

const electron = require('electron');
// Destructuring from the npm 'electron' package under plain Node yields
// undefined members (harmless); under Electron these are the real APIs.
const { app, BrowserWindow, protocol, session: electronSession } = electron;
const fs = require('node:fs');
const path = require('node:path');

const APP_SCHEME = 'office-probe';
const SMOKE_SCHEMA_KEYS = Object.freeze([
  'destroyed',
  'electronVersion',
  'estimatedRgbaBytes',
  'loadMs',
  'networkRequests',
  'pixiVersion',
  'renderer',
  'schemaVersion',
  'textureHeight',
  'textureWidth',
]);
const ERROR_CODES = Object.freeze({
  INIT_FAILED: 'PIXI_INIT_FAILED',
  BLANK_RENDER: 'PIXI_BLANK_RENDER',
  NETWORK_REQUEST: 'PIXI_NETWORK_REQUEST',
  DESTROY_LEAK: 'PIXI_DESTROY_LEAK',
  VERSION_DRIFT: 'PIXI_VERSION_DRIFT',
});
const EXIT_CODES = Object.freeze({
  ok: 0,
  PIXI_INIT_FAILED: 1,
  PIXI_BLANK_RENDER: 1,
  PIXI_VERSION_DRIFT: 1,
  PIXI_NETWORK_REQUEST: 5,
  PIXI_DESTROY_LEAK: 6,
});

// The exact Pixi checkout this probe must load (package.json pins 8.5.2).
// Requiring the CJS entry here also documents the renderer dependency for the
// repository dependency guard: pixi.js is consumed locally, never from a CDN.
// (The CJS entry is import-safe in plain Node: constructing a renderer would
// need a DOM, but the top-level module only registers extensions.)
const INSTALLED_PIXI_VERSION = require('pixi.js').VERSION;
const RENDER_TIMEOUT_MS = 30000;
const OVERALL_TIMEOUT_MS = 60000;

function isElectronMain() {
  return typeof electron === 'object' && electron !== null && !!electron.app;
}

function buildSmokeReport(input) {
  const report = {
    schemaVersion: 1,
    pixiVersion: input.pixiVersion === undefined ? null : input.pixiVersion,
    electronVersion: input.electronVersion === undefined ? null : input.electronVersion,
    renderer: input.renderer === undefined ? null : input.renderer,
    textureWidth: input.textureWidth === undefined ? null : input.textureWidth,
    textureHeight: input.textureHeight === undefined ? null : input.textureHeight,
    estimatedRgbaBytes: input.estimatedRgbaBytes === undefined ? null : input.estimatedRgbaBytes,
    loadMs: input.loadMs === undefined ? null : input.loadMs,
    destroyed: input.destroyed || { sprite: false, application: false },
    networkRequests: input.networkRequests === undefined ? 0 : input.networkRequests,
  };
  if (input.error) report.error = String(input.error).slice(0, 300);
  let ok = true;
  let code = null;
  if (
    report.pixiVersion === null ||
    report.renderer === null ||
    report.textureWidth === null ||
    report.textureHeight === null ||
    report.estimatedRgbaBytes === null
  ) {
    ok = false;
    code = ERROR_CODES.INIT_FAILED;
  } else if (report.networkRequests !== 0) {
    ok = false;
    code = ERROR_CODES.NETWORK_REQUEST;
  } else if (!report.destroyed.sprite || !report.destroyed.application) {
    ok = false;
    code = ERROR_CODES.DESTROY_LEAK;
  }
  return { ok, code, report };
}

// The page is generated in-memory and served through the local app scheme.
// It imports Pixi from the local node_modules checkout (no CDN) and creates
// one Application, one locally generated fixture texture and one Sprite.
const PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${APP_SCHEME}://local 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${APP_SCHEME}://local data: blob:; connect-src 'none'">
<title>office-pixi-smoke</title>
</head>
<body>
<script>
window.__PIXI_SMOKE_RESULT__ = null;
window.addEventListener('error', (event) => {
  window.__PIXI_SMOKE_RESULT__ = {
    ok: false,
    code: 'PIXI_INIT_FAILED',
    data: {},
    error: String((event && event.message) || 'page error'),
  };
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  window.__PIXI_SMOKE_RESULT__ = {
    ok: false,
    code: 'PIXI_INIT_FAILED',
    data: {},
    error: String((reason && reason.message) || reason || 'unhandled rejection'),
  };
});
</script>
<script src="./node_modules/pixi.js/dist/pixi.min.js"></script>
<script src="./node_modules/pixi.js/dist/packages/unsafe-eval.js"></script>
<script>
// dist/pixi.min.js is a self-contained IIFE build that exposes the global
// PIXI namespace — no bare imports, no bundler, no CDN.
window.__PIXI_SMOKE_RESULT__ = null;
window.__destroyProbe = () => {
  const flags = { sprite: false, application: false };
  try {
    window.__PIXI_SMOKE_SPRITE__.destroy(true);
    flags.sprite = window.__PIXI_SMOKE_SPRITE__.destroyed === true;
  } catch (error) { /* already destroyed */ }
  try {
    const hadRenderer = !!window.__PIXI_SMOKE_APP__.renderer;
    window.__PIXI_SMOKE_APP__.destroy(true, { children: true, texture: false });
    flags.application = hadRenderer && window.__PIXI_SMOKE_APP__.renderer === null;
  } catch (error) { /* already destroyed */ }
  return flags;
};
(async () => {
  const { VERSION, Application, Sprite, Texture } = window.PIXI;
  const result = { ok: false, code: null, data: {}, error: null };
  try {
    const start = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff8800';
  ctx.fillRect(0, 0, 8, 8);
  ctx.fillStyle = '#0044ff';
  ctx.fillRect(2, 2, 2, 2);
  const app = new Application();
  await app.init({
    width: 64,
    height: 64,
    backgroundAlpha: 0,
    preference: 'webgl',
    preserveDrawingBuffer: true,
    autoDensity: false,
    resolution: 1,
  });
  document.body.appendChild(app.canvas);
  const texture = Texture.from(canvas);
  const sprite = new Sprite(texture);
  app.stage.addChild(sprite);
  window.__PIXI_SMOKE_APP__ = app;
  window.__PIXI_SMOKE_SPRITE__ = sprite;
  app.renderer.render(app.stage);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const isWebGL = app.renderer.type === 1;
  let pixels = null;
  if (isWebGL) {
    const gl = app.canvas.getContext('webgl2') || app.canvas.getContext('webgl');
    pixels = new Uint8Array(64 * 64 * 4);
    // GL reads from the bottom-left corner; scan the whole frame so sprite
    // placement does not matter.
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } else {
    pixels = app.canvas.getContext('2d').getImageData(0, 0, 64, 64).data;
  }
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 1) sum += pixels[i];
  const nonBlank = sum > 0;
  result.data = {
    pixiVersion: String(VERSION || 'unknown'),
    renderer: String(app.renderer.name || (app.renderer.type === 1 ? 'webgl' : 'canvas')),
    textureWidth: texture.width,
    textureHeight: texture.height,
    estimatedRgbaBytes: texture.width * texture.height * 4,
    loadMs: Math.round(performance.now() - start),
    nonBlank,
  };
  result.ok = nonBlank === true;
  if (!nonBlank) result.code = 'PIXI_BLANK_RENDER';
  } catch (error) {
    result.ok = false;
    result.code = 'PIXI_INIT_FAILED';
    result.error = String(error && error.message ? error.message : error);
  }
  window.__PIXI_SMOKE_RESULT__ = result;
})();
</script>
</body>
</html>
`;

async function runSmoke() {
  const headless = process.argv.includes('--headless');
  const repoRoot = path.resolve(__dirname, '..');

  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);

  await app.whenReady();

  await protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    if (rel === 'index.html') {
      return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (rel.startsWith('node_modules/')) {
      const abs = path.join(repoRoot, rel);
      if (!abs.startsWith(path.join(repoRoot, 'node_modules')) || !fs.existsSync(abs)) {
        return new Response('not found', { status: 404 });
      }
      const type = abs.endsWith('.mjs') || abs.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(fs.readFileSync(abs), {
        headers: { 'content-type': type, 'access-control-allow-origin': `${APP_SCHEME}://local` },
      });
    }
    return new Response('not found', { status: 404 });
  });

  const networkRequests = { count: 0 };
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const scheme = String(details.url || '').slice(0, 40);
    if (!scheme.startsWith(`${APP_SCHEME}:`) && !scheme.startsWith('devtools:')) {
      networkRequests.count += 1;
    }
    callback({});
  });

  const win = new BrowserWindow({
    width: 128,
    height: 128,
    show: !headless,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: headless,
      backgroundThrottling: false,
    },
  });
  if (headless) win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) process.stderr.write(`[pixi-smoke:renderer] ${message}\n`);
  });

  const finish = (exitCode, payload) => {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
    console.log(JSON.stringify(payload, null, 2));
    app.exit(exitCode);
  };
  const watchdog = setTimeout(() => {
    finish(1, {
      schemaVersion: 1,
      pixiVersion: null,
      electronVersion: process.versions.electron,
      renderer: null,
      textureWidth: null,
      textureHeight: null,
      estimatedRgbaBytes: null,
      loadMs: null,
      destroyed: { sprite: false, application: false },
      networkRequests: networkRequests.count,
      error: 'PIXI_INIT_FAILED: render result timeout (offscreen/headless may be unsupported here; retry with a visible window)',
    });
  }, OVERALL_TIMEOUT_MS);

  try {
    await win.loadURL(`${APP_SCHEME}://local/index.html`);

    let result = null;
    for (let waited = 0; waited < RENDER_TIMEOUT_MS; waited += 250) {
      // eslint-disable-next-line no-await-in-loop
      result = await win.webContents.executeJavaScript('window.__PIXI_SMOKE_RESULT__ || null', true);
      if (result) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!result) {
      clearTimeout(watchdog);
      finish(1, {
        schemaVersion: 1,
        pixiVersion: null,
        electronVersion: process.versions.electron,
        renderer: null,
        textureWidth: null,
        textureHeight: null,
        estimatedRgbaBytes: null,
        loadMs: null,
        destroyed: { sprite: false, application: false },
        networkRequests: networkRequests.count,
        error: 'PIXI_INIT_FAILED: renderer never reported a result',
      });
      return;
    }

    if (!result.ok) {
      clearTimeout(watchdog);
      const report = buildSmokeReport({
        electronVersion: process.versions.electron,
        networkRequests: networkRequests.count,
        error: `${result.code}: ${result.error || 'non-blank pixel check failed'}`,
      });
      finish(EXIT_CODES[report.code] || 1, report.report);
      return;
    }

    if (result.data.pixiVersion !== INSTALLED_PIXI_VERSION) {
      clearTimeout(watchdog);
      const verdict = buildSmokeReport({
        electronVersion: process.versions.electron,
        networkRequests: networkRequests.count,
        error: `${ERROR_CODES.VERSION_DRIFT}: renderer loaded pixi ${result.data.pixiVersion} but package.json pins ${INSTALLED_PIXI_VERSION}`,
      });
      finish(EXIT_CODES[verdict.code || 'ok'], verdict.report);
      return;
    }

    const destroyed = await win.webContents.executeJavaScript('window.__destroyProbe()', true);
    clearTimeout(watchdog);
    const verdict = buildSmokeReport({
      pixiVersion: result.data.pixiVersion,
      electronVersion: process.versions.electron,
      renderer: result.data.renderer,
      textureWidth: result.data.textureWidth,
      textureHeight: result.data.textureHeight,
      estimatedRgbaBytes: result.data.estimatedRgbaBytes,
      loadMs: result.data.loadMs,
      destroyed,
      networkRequests: networkRequests.count,
    });
    finish(EXIT_CODES[verdict.code || 'ok'], verdict.report);
  } catch (error) {
    clearTimeout(watchdog);
    const verdict = buildSmokeReport({
      electronVersion: process.versions.electron,
      networkRequests: networkRequests.count,
      error: `${ERROR_CODES.INIT_FAILED}: ${error && error.message}`,
    });
    finish(EXIT_CODES[verdict.code || 'ok'], verdict.report);
  }
}

// Electron wraps entry scripts, so require.main === module is false there;
// detect the Electron main process via process.type instead.
if (isElectronMain() && process.type === 'browser') {
  runSmoke().catch((error) => {
    const verdict = buildSmokeReport({
      electronVersion: process.versions.electron,
      error: `${ERROR_CODES.INIT_FAILED}: ${error && error.message}`,
    });
    console.log(JSON.stringify(verdict.report, null, 2));
    app.exit(EXIT_CODES[verdict.code || 'ok']);
  });
} else {
  module.exports = { SMOKE_SCHEMA_KEYS, buildSmokeReport, ERROR_CODES };
}
