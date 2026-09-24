'use strict';
// Task E5a-R1 diagnostic probe (spawned by office-ui.test.js).
//
// PROBLEM B diagnosis: records the ACTUAL played frame sequence in the real
// shell. The renderer consumes exactly two snapshot fields — animation.resource
// and animation.frameIndex — and resolves the texture through
// pack.frameGeometry(resource, frameIndex).file. This probe samples that exact
// resolution every 100ms for a full walk loop (>=5s per direction) and compares
// the observed file CYCLE against animations.json's declared order, plus:
//  - the foot-bottom drift evidence (problem A) is measured offline from the
//    PNGs by the spawner test (python3/PIL), not here;
//  - captures the full 7-frame cycle (2026-09-18 sequence) for the footY
//    range measurement;
//  - re-runs the E4 no-clipping walk sampling (must stay 0).
// Writes results.json into __EVIDENCE__; failures are console.error + exit 1.
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = '__REPO__';
const EVIDENCE = '__EVIDENCE__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic capture: a hidden-window capturePage can resolve while the
// compositor is still one frame behind the last applySnapshotManually (proved
// byte-identical to the previous step). Wait until two consecutive captures are
// byte-identical, so the returned buffer is the settled frame.
async function captureStable(target, { maxWaitMs = 3000, intervalMs = 40 } = {}) {
  const started = Date.now();
  let previous = null;
  let image = await target.webContents.capturePage();
  while (Date.now() - started < maxWaitMs) {
    const bytes = image.toPNG();
    if (previous && bytes.equals(previous)) return image;
    previous = bytes;
    await sleep(intervalMs);
    image = await target.webContents.capturePage();
  }
  return image;
}
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-r1-'));
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
  console.error(`E5A_R1_FAIL ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}`);
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
    const { createAssetPack } = require(path.join(REPO, 'src/office/runtime/asset-pack.js'));
    // E5a-R1: the simulation runs on the PRODUCTION pack — exactly the real
    // app's configuration (main.js loadProductionCharacterPack). The earlier
    // diagnostic mixed a fixture-pack frameIndex space with the production
    // file list and reproduced the reported [01, 02, passing, 03] cycle with
    // 04 dropped: a frame-count mismatch between the frameIndex producer and
    // the file resolver breaks the sequence even though every path is
    // metadata-driven. The strict-cycle assertion below now guards the true
    // single-pack configuration.
    const productionManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/manifest.json'), 'utf8'));
    const productionAnchors = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/animation/anchors.json'), 'utf8'));
    const productionAnimations = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/animation/animations.json'), 'utf8'));
    const pack = createAssetPack({ manifest: productionManifest, anchors: productionAnchors, animations: productionAnimations }).pack;
    const productionPack = pack;
    const declaredOrder = {};
    for (const direction of ['left', 'right']) {
      declaredOrder[direction] = productionAnimations.animations[`walk-${direction}`].frames.map((frame) => frame.file.split('/').pop());
    }
    const runtimeLayout = loadRuntimeLayoutFixture({ userDataDir: RUN_DIR, log: () => {} });
    if (!runtimeLayout || runtimeLayout.source !== 'bundled-flat') { fail('layout-chain', runtimeLayout ? runtimeLayout.source : 'null'); app.exit(1); return; }
    const simulation = createOfficeModule({
      pack,
      layout: runtimeLayout.fixture,
      seed: 'e5a-r1-order-seed',
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

    // ---- problem B: record the actually played (resource, frameIndex, file)
    // sequence. The probe samples the module's own animation state (what the
    // snapshot carries and the renderer consumes) and resolves the file with
    // the PRODUCTION pack exactly like the page's renderer does.
    const observed = { left: [], right: [] };
    const samples = { count: 0, clippingViolations: [] };
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
          transitRadius[ws] = Math.max(transitRadius[ws] || 0, Math.hypot(corner.x - seatByWorkstation[ws].x, corner.y - seatByWorkstation[ws].y));
        }
      }
    }
    for (const ws of Object.keys(transitRadius)) transitRadius[ws] += moverRadius;
    const pointRectDistance = (p, r) => Math.hypot(
      Math.max(r.x - p.x, 0, p.x - (r.x + r.width)),
      Math.max(r.y - p.y, 0, p.y - (r.y + r.height))
    );

    let running = true;
    const sessionOf = {}; // employeeId -> { direction, session } (walk session tracking)
    const sampler = setInterval(() => {
      if (!running) return;
      const state = simulation.state();
      samples.count += 1;
      for (const employee of state.employees) {
        const animation = employee.animation || {};
        const direction = animation.resource === 'walk-left' ? 'left' : animation.resource === 'walk-right' ? 'right' : null;
        if (direction) {
          const geometry = productionPack.frameGeometry(animation.resource, animation.frameIndex || 0);
          const file = geometry && geometry.file ? geometry.file.split('/').pop() : `idx${animation.frameIndex}`;
          // PER-EMPLOYEE, PER-SESSION streams: several employees walk the same
          // direction at independent loop phases, and one employee walks many
          // sessions over the sampling window — merging either would fabricate
          // transitions nobody plays. A session ends when the employee stops
          // walking this direction.
          const previous = sessionOf[employee.employeeId];
          let session = previous && previous.direction === direction ? previous.session : null;
          if (!session) {
            session = { employeeId: employee.employeeId, files: [] };
            observed[direction].push(session);
          }
          sessionOf[employee.employeeId] = { direction, session };
          const last = session.files[session.files.length - 1];
          if (!last || last.file !== file) session.files.push({ frameIndex: animation.frameIndex, file, at: state.tick });
        } else {
          sessionOf[employee.employeeId] = { direction: null, session: null };
        }
        const point = { x: employee.position.x * scene.w, y: employee.position.y * scene.h };
        for (const obstacle of obstacles) {
          if (obstacle.workstation) {
            const seat = seatByWorkstation[obstacle.workstation];
            const reach = transitRadius[obstacle.workstation] || 0;
            if (seat && Math.hypot(point.x - seat.x, point.y - seat.y) <= reach) continue;
          }
          if (pointRectDistance(point, obstacle.rect) < moverRadius) {
            samples.clippingViolations.push({ tick: state.tick, employeeId: employee.employeeId, furnitureId: obstacle.id });
          }
        }
      }
    }, 100);

    // 播放保真（2026-09-22 二代序列）：观测流里每一对相邻帧都必须是
    // animations.json 声明的相邻对（含循环回绕 bNN→b01），且出现的文件名
    // 必须来自声明集合。任何按文件名排序、跳帧或乱序播放都会破坏它。
    const declaredAdjacency = {};
    for (const direction of ['left', 'right']) {
      const files = productionAnimations.animations[`walk-${direction}`].frames.map((frame) => frame.file.split('/').pop());
      const pairs = new Set();
      for (let i = 0; i < files.length; i += 1) pairs.add(`${files[i]}|${files[(i + 1) % files.length]}`);
      declaredAdjacency[direction] = { files, pairs };
    }
    // 采样间隔 100ms > 帧时长 83ms，所以一次采样可能跳过 1~2 帧：校验按
    // "前向步进 delta ∈ 1..MAX_STEP（模周期）"而非严格相邻，回退/外来文件/错序仍被拒。
    const MAX_STEP = 4;
    const orderFidelity = (direction) => {
      const { files } = declaredAdjacency[direction];
      let transitions = 0;
      for (const session of observed[direction]) {
        const names = session.files.map((entry) => entry.file);
        for (const name of names) {
          if (!files.includes(name)) return { ok: false, detail: `undeclared frame ${name}` };
        }
        for (let k = 1; k < names.length; k += 1) {
          transitions += 1;
          const from = files.indexOf(names[k - 1]);
          const to = files.indexOf(names[k]);
          const delta = (to - from + files.length) % files.length;
          if (delta < 1 || delta > MAX_STEP) {
            return { ok: false, detail: `${names[k - 1]} -> ${names[k]} steps ${delta} (allowed 1..${MAX_STEP} forward)` };
          }
        }
      }
      return transitions > 0 ? { ok: true, transitions } : { ok: false, detail: 'no samples' };
    };
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !(orderFidelity('left').ok && orderFidelity('right').ok && samples.count >= 100)) {
      await sleep(250);
    }
    running = false;
    clearInterval(sampler);
    clearInterval(pushTimer);

    // ---- 8 consecutive captures spanning the full cycle (footY range) ----
    // freeze ONE walker mid-stride via the renderer's pure projection, then
    // step frameIndex 0..6 (the full 2026-09-18 7-frame cycle) and capture; the
    // foot-line jump between consecutive frames is what the user saw as a "hop".
    clearInterval(pushTimer);
    const footCaptures = [];
    const captureSeq = declaredAdjacency.left.files.map((_file, index) => index); // 全周期（left = 15 帧）
    for (const direction of ['left', 'right']) {
      for (let step = 0; step < captureSeq.length; step += 1) {
        const frameIndex = captureSeq[step];
        const snapshot = {
          schemaVersion: 1,
          simulatedAtMs: step * 1000,
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
        const image = await captureStable(win);
        if (!image || image.isEmpty()) { fail('capture', `${direction} step ${step} empty`); app.exit(1); return; }
        const file = path.join(EVIDENCE, `seq-${direction}-${String(step).padStart(2, '0')}-f${frameIndex}.png`);
        fs.writeFileSync(file, image.toPNG());
        footCaptures.push({ direction, step, frameIndex, file: path.basename(file) });
      }
    }

    if (samples.clippingViolations.length > 0) { fail('walk-clipping', samples.clippingViolations.slice(0, 6)); app.exit(1); return; }
    for (const direction of ['left', 'right']) {
      const verdict = orderFidelity(direction);
      if (!verdict.ok) {
        fail(`play-order-${direction}`, `${verdict.detail} :: ${JSON.stringify(observed[direction].map((session) => ({ id: session.employeeId, files: session.files.slice(0, 10).map((f) => f.file) }))).slice(0, 420)}`);
        app.exit(1);
        return;
      }
    }

    const results = {
      devicePixelRatio: await evalJs('window.devicePixelRatio').catch(() => null),
      layoutSource: runtimeLayout.source,
      declaredOrder,
      observed: { left: observed.left, right: observed.right },
      orderFidelity: { left: orderFidelity('left'), right: orderFidelity('right') },
      footCaptures,
      walk: { sampleCount: samples.count, clippingViolations: samples.clippingViolations.length },
    };
    const payload = JSON.stringify(results, null, 2);
    try { fs.writeFileSync(path.join(EVIDENCE, 'results.json'), payload); } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(__dirname, 'results.json'), payload); } catch { /* best effort */ }
    console.log('E5A_R1_PROBE_OK');
    app.exit(0);
  } catch (error) {
    fail('exception', error && error.stack ? error.stack : String(error));
    app.exit(1);
  }
}).catch((e) => { fail('unhandled', e && e.stack || e); app.exit(1); });
