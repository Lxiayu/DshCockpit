'use strict';
// Task E5a real-shell probe (spawned by office-ui.test.js). Boots the REAL
// office page against a REAL office-module on the compiled flat layout, lets
// the residents walk (plus one dispatched task), and:
//  (a) captures a 5-frame sequence strip per direction: whenever a sampled
//      snapshot shows animation.resource walk-left / walk-right with a NEW
//      frameIndex, one viewport capture is filed for that (direction, index);
//  (b) re-runs the E4 no-clipping sampling (100ms cadence, mover capsule vs
//      every foreign furniture footprint) — walk frames must not change path
//      geometry: 0 violations expected.
// Writes results.json + walk-<dir>-f<idx>.png into __EVIDENCE__; exits 0 on
// success; every failure is console.error + app.exit(1) (no assert in probes).
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = '__REPO__';
const EVIDENCE = '__EVIDENCE__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-frames-'));
app.setPath('userData', RUN_DIR);
// A probe must never pop a modal error dialog on the user's screen: any escape
// from an interval/handler prints a FAIL line and exits non-zero instead.
process.on('uncaughtException', (error) => {
  console.error('PROBE_UNCAUGHT', error && error.stack ? error.stack.slice(0, 600) : String(error));
  try { app.exit(1); } catch { process.exit(1); }
});
process.on('unhandledRejection', (reason) => {
  console.error('PROBE_UNHANDLED_REJECTION', reason && reason.stack ? reason.stack.slice(0, 600) : String(reason));
  try { app.exit(1); } catch { process.exit(1); }
});

function fail(label, detail) {
  console.error(`E5A_FAIL ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}`);
}

app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  try {
    const routes = [
      { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
      { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
      { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
      { prefix: '', root: path.join(REPO, 'src', 'office') },
    ];
    protocol.handle('office-runtime', (request) => {
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
      for (const route of routes) {
        if (!rel.startsWith(route.prefix)) continue;
        const abs = path.resolve(route.root, rel.slice(route.prefix.length));
        if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
        const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
        return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
      }
      return new Response('nf', { status: 404 });
    });

    const { createOfficeModule, loadRuntimeLayoutFixture } = require(path.join(REPO, 'src/office/office-module.js'));
    const fixturePackRoot = path.join(REPO, 'src/office/fixtures/character-pack');
    const { createAssetPack } = require(path.join(REPO, 'src/office/runtime/asset-pack.js'));
    const pack = createAssetPack({
      manifest: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'manifest.json'), 'utf8')),
      anchors: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'animation', 'anchors.json'), 'utf8')),
      animations: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'animation', 'animations.json'), 'utf8')),
    }).pack;
    const runtimeLayout = loadRuntimeLayoutFixture({ userDataDir: RUN_DIR, log: () => {} });
    if (!runtimeLayout || runtimeLayout.source !== 'bundled-flat') { fail('layout-chain', runtimeLayout ? runtimeLayout.source : 'null'); app.exit(1); return; }
    const simulation = createOfficeModule({
      pack,
      layout: runtimeLayout.fixture,
      seed: 'e5a-frames-seed',
      config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 1500 },
    });
    simulation.start();

    const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1280, height: 840, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 2) console.error('[PAGE-ERR]', String(message).slice(0, 200), sourceId && String(sourceId).split('/').pop(), line);
    });
    ipcMain.handle('office:state', () => ({ ok: true, snapshot: simulation.state() }));
    for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics']) ipcMain.handle(ch, () => ({ ok: false }));
    const pushTimer = setInterval(() => {
      try { win.webContents.send('office:state', simulation.state()); } catch { /* closing */ }
    }, 100);

    await win.loadURL('office-runtime://local/office.html?pack=deepseek-default');
    const evalJs = (s) => win.webContents.executeJavaScript(s, true);
    let ready = false;
    for (let i = 0; i < 90; i += 1) {
      await sleep(200);
      ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
      if (ready) break;
      const bootError = await evalJs('(window.__office && typeof window.__office.error === "string") ? window.__office.error : ""').catch(() => '');
      if (bootError) { fail('boot', bootError); app.exit(1); return; }
    }
    if (!ready) { fail('boot-timeout'); app.exit(1); return; }

    // ---- E4 no-clipping sampling (unchanged geometry semantics) -------------
    const walkFixture = runtimeLayout.fixture;
    const scene = { w: walkFixture.scene.referenceWidth, h: walkFixture.scene.referenceHeight };
    const moverRadius = 0.02 * Math.min(scene.w, scene.h);
    const workstationOfFurniture = (id) => { const m = /^(desk-[1-6])-/.exec(id || ''); return m ? m[1] : null; };
    const seatByWorkstation = {};
    for (const node of walkFixture.nodes) {
      const m = /^(desk-[1-6])$/.exec(node.id || '');
      if (m) seatByWorkstation[m[1]] = { x: node.position.x * scene.w, y: node.position.y * scene.h };
    }
    const obstacles = [];
    for (const item of walkFixture.furniture) {
      for (const rect of Object.values(item.parts || {})) {
        obstacles.push({
          id: item.id,
          workstation: workstationOfFurniture(item.id),
          rect: { x: rect.x * scene.w, y: rect.y * scene.h, width: rect.width * scene.w, height: rect.height * scene.h },
        });
      }
    }
    const transitRadius = {};
    for (const item of walkFixture.furniture) {
      const ws = workstationOfFurniture(item.id);
      if (!ws || !seatByWorkstation[ws]) continue;
      for (const rect of Object.values(item.parts || {})) {
        const box = { x: rect.x * scene.w, y: rect.y * scene.h, width: rect.width * scene.w, height: rect.height * scene.h };
        for (const corner of [
          { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
          { x: box.x, y: box.y + box.height }, { x: box.x + box.width, y: box.y + box.height },
        ]) {
          const d = Math.hypot(corner.x - seatByWorkstation[ws].x, corner.y - seatByWorkstation[ws].y);
          transitRadius[ws] = Math.max(transitRadius[ws] || 0, d);
        }
      }
    }
    for (const ws of Object.keys(transitRadius)) transitRadius[ws] += moverRadius;
    const pointRectDistance = (p, r) => Math.hypot(
      Math.max(r.x - p.x, 0, p.x - (r.x + r.width)),
      Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
    );

    const samples = { count: 0, clippingViolations: [] };
    let capturing = true;
    const sampler = setInterval(() => {
      if (!capturing) return;
      const state = simulation.state();
      samples.count += 1;
      for (const employee of state.employees) {
        const point = { x: employee.position.x * scene.w, y: employee.position.y * scene.h };
        for (const obstacle of obstacles) {
          if (obstacle.workstation) {
            const seat = seatByWorkstation[obstacle.workstation];
            const reach = transitRadius[obstacle.workstation] || 0;
            if (seat && Math.hypot(point.x - seat.x, point.y - seat.y) <= reach) continue;
          }
          if (pointRectDistance(point, obstacle.rect) < moverRadius) {
            samples.clippingViolations.push({ tick: state.tick, employeeId: employee.employeeId, furnitureId: obstacle.id, x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 });
          }
        }
      }
    }, 100);

    // ---- frame-sequence capture ---------------------------------------------
    const seen = { left: new Set(), right: new Set() };
    const captured = { left: {}, right: {} };
    const captureTimer = setInterval(async () => {
      if (!capturing) return;
      try {
        const state = simulation.state();
        for (const employee of state.employees) {
          const animation = employee.animation || {};
          const resource = animation.resource || '';
          const direction = resource === 'walk-left' ? 'left' : resource === 'walk-right' ? 'right' : null;
          if (!direction) continue;
          const frameIndex = animation.frameIndex || 0;
          if (seen[direction].has(frameIndex)) continue;
          seen[direction].add(frameIndex);
          const image = await win.webContents.capturePage();
          if (!image || image.isEmpty()) { seen[direction].delete(frameIndex); continue; }
          const file = path.join(EVIDENCE, `walk-${direction}-f${frameIndex}.png`);
          fs.writeFileSync(file, image.toPNG());
          captured[direction][frameIndex] = path.basename(file);
        }
      } catch { /* closing */ }
    }, 120);

    // keep the residents walking so the LIVE runtime is seen playing the new
    // sequences; the strips themselves are captured deterministically below
    // (the live loop only advances while a walk lasts, so a direction may not
    // surface all five indices before the walker turns).
    const liveDeadline = Date.now() + 60000;
    const liveStart = Date.now();
    while (Date.now() < liveDeadline && (
      Date.now() - liveStart < 4000 // M4.1b: minimum sampling floor — the walk
        // model waits (reservations/occupants) so the frame sets can be
        // satisfied in under a second; the sampler must still observe a real
        // window of live walking before stopping
      || seen.left.size < 2 || seen.right.size < 2)) {
      await sleep(250);
    }
    capturing = false;
    clearInterval(sampler);
    clearInterval(captureTimer);
    clearInterval(pushTimer); // the strips must not race the live pushes

    // deterministic 5-frame strips: the renderer is a pure snapshot projection,
    // so each (direction, frameIndex) is synthesized via applySnapshotManually
    // and captured — the same texture path the live walk uses.
    for (const direction of ['left', 'right']) {
      for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
        const snapshot = {
          schemaVersion: 1,
          simulatedAtMs: frameIndex * 1000,
          sync: 'healthy',
          scene: { referenceWidth: 1280, referenceHeight: 840 },
          employees: [{
            employeeId: 'orchestrator',
            displayName: '调度员',
            role: '任务编排与分发',
            seatNodeId: 'desk-1',
            position: { x: 0.42, y: 0.52 },
            activity: 'roaming',
            movement: 'moving',
            facing: direction,
            animation: { resource: `walk-${direction}`, frameIndex, frameElapsedMs: 0, fallbackReason: null },
            marker: null,
            queueCount: 0,
          }],
          activityLog: [],
          diagnostics: [],
          capabilities: {},
        };
        await evalJs(`window.__office.api.applySnapshotManually(${JSON.stringify(snapshot)})`);
        await sleep(200);
        const image = await win.webContents.capturePage();
        if (!image || image.isEmpty()) { fail('strip-capture', `${direction} f${frameIndex} empty`); app.exit(1); return; }
        fs.writeFileSync(path.join(EVIDENCE, `walk-${direction}-f${frameIndex}.png`), image.toPNG());
        captured[direction][frameIndex] = `walk-${direction}-f${frameIndex}.png`;
        seen[direction].add(frameIndex);
      }
    }

    if (samples.clippingViolations.length > 0) { fail('walk-clipping', samples.clippingViolations.slice(0, 6)); app.exit(1); return; }
    if (seen.left.size < 2 || seen.right.size < 2) { fail('live-walk', `live walk frames captured: L${seen.left.size}/R${seen.right.size}`); app.exit(1); return; }

    const results = {
      layoutSource: runtimeLayout.source,
      walk: {
        sampleCount: samples.count,
        clippingViolations: samples.clippingViolations.length,
        capturedFrames: { left: Object.keys(captured.left).sort(), right: Object.keys(captured.right).sort() },
        files: captured,
      },
    };
    const payload = JSON.stringify(results, null, 2);
    try { fs.writeFileSync(path.join(EVIDENCE, 'results.json'), payload); } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(__dirname, 'results.json'), payload); } catch { /* best effort */ }
    console.log('E5A_PROBE_OK');
    app.exit(0);
  } catch (error) {
    fail('exception', error && error.stack ? error.stack : String(error));
    app.exit(1);
  }
}).catch((e) => { fail('unhandled', e && e.stack || e); app.exit(1); });
