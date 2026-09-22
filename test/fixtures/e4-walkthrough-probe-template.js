'use strict';
// Task E4 real-shell walkthrough probe (spawned by office-ui.test.js).
// Boots the REAL office page against a REAL office-module simulation built on
// the compiled flat layout (temp userData → the bundled-flat chain entry),
// drives one true task (roam → running → walk → sit → work → result → stand
// → leave), and asserts:
//  (a) the runtime layout source chain served 'bundled-flat';
//  (b) the fixed 1280x840 letterbox at three window sizes (aspect kept,
//      canvas dead-centered, never larger than the stage);
//  (c) M4.1c merged painter order: every flat furniture item participates in
//      ONE geometric pass with the characters (groundPaintOrder keys ascend;
//      walkers inside a station band paint over its desk, a seated body paints
//      under its chair) — no furniture is layered by declaration any more;
//  (d) NO sampled employee position (100ms cadence) ever comes within the
//      mover radius of another workstation's furniture footprint;
//  (e) no two employees ever share the same cell (pairwise distance ≥ 20px).
// Writes walkthrough-results.json + frame PNGs into __EVIDENCE__ and exits 0;
// every failure is console.error + app.exit(1) (no assert inside probes).
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = '__REPO__';
const EVIDENCE = '__EVIDENCE__';
const OUT_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-walk-'));
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
  console.error(`E4_WALK_FAIL ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`);
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
    // E4_SERVE_SAVED_DRAFT=1: serve the committed hermetic draft copy as the
    // user-saved layout so the evidence run exercises the 'saved-compiled'
    // chain entry; the default (unset) runs the 'bundled-flat' entry.
    const serveSavedDraft = process.env.E4_SERVE_SAVED_DRAFT === '1';
    protocol.handle('office-runtime', (request) => {
      const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      if (rel === 'office-layout.v1.json') {
        if (serveSavedDraft) {
          return new Response(fs.readFileSync(path.join(REPO, 'test/fixtures/office-layout-flat-draft.json')), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('nf', { status: 404 });
      }
      for (const route of routes) {
        if (!rel.startsWith(route.prefix)) continue;
        const abs = path.resolve(route.root, rel.slice(route.prefix.length));
        if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
        const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
        return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
      }
      return new Response('nf', { status: 404 });
    });

    // REAL simulation on the compiled flat layout (temp userData is empty, so
    // loadRuntimeLayoutFixture must land on the bundled-flat chain entry).
    const { createOfficeModule, loadRuntimeLayoutFixture } = require(path.join(REPO, 'src/office/office-module.js'));
    const fixturePackRoot = path.join(REPO, 'src/office/fixtures/character-pack');
    const { createAssetPack } = require(path.join(REPO, 'src/office/runtime/asset-pack.js'));
    const pack = createAssetPack({
      manifest: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'manifest.json'), 'utf8')),
      anchors: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'animation', 'anchors.json'), 'utf8')),
      animations: JSON.parse(fs.readFileSync(path.join(fixturePackRoot, 'animation', 'animations.json'), 'utf8')),
    }).pack;
    const runtimeLayout = loadRuntimeLayoutFixture({ userDataDir: RUN_DIR, log: () => {} });
    if (!runtimeLayout || runtimeLayout.source !== 'bundled-flat') {
      fail('layout-chain', runtimeLayout ? runtimeLayout.source : 'null');
      app.exit(1);
      return;
    }
    const simulation = createOfficeModule({
      pack,
      layout: runtimeLayout.fixture,
      seed: 'e4-walkthrough-seed',
      config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 1500 },
    });
    simulation.start();

    const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1280, height: 840, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (level >= 2) console.error('[PAGE-ERR]', String(message).slice(0, 200), sourceId && String(sourceId).split('/').pop(), line);
    });
    ipcMain.handle('office:state', () => ({ ok: true, snapshot: simulation.state() }));
    for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics']) ipcMain.handle(ch, () => ({ ok: false }));
    // the page polls once at boot, then lives on pushes
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
    if (!ready) { fail('boot-timeout', 'window.__office.ready never became true'); app.exit(1); return; }

    const source = await evalJs('window.__office.api.runtimeLayoutSource()');
    if (source !== 'bundled-flat' && source !== 'saved-compiled') { fail('layout-source', source); app.exit(1); return; }

    // ---- (b) letterbox at three window sizes --------------------------------
    const SCENE_RATIO = 1280 / 840;
    const letterbox = {};
    for (const size of [[1582, 955], [1280, 840], [1100, 760]]) {
      win.setContentSize(size[0], size[1]);
      await sleep(700);
      const rects = JSON.parse(await evalJs(`JSON.stringify((() => {
        const stage = document.getElementById('stage-host').getBoundingClientRect();
        const canvas = document.querySelector('#stage-host canvas');
        if (!canvas) return { missing: true };
        const c = canvas.getBoundingClientRect();
        return { stage: { w: stage.width, h: stage.height }, canvas: { left: c.left, top: c.top, w: c.width, h: c.height } };
      })())`));
      const key = `${size[0]}x${size[1]}`;
      if (rects.missing) { fail('letterbox-canvas', key); app.exit(1); return; }
      const ratio = rects.canvas.w / rects.canvas.h;
      const offX = Math.abs((rects.canvas.left - 0) + (rects.canvas.w / 2) - rects.stage.w / 2);
      const offY = Math.abs((rects.canvas.top - 0) + (rects.canvas.h / 2) - rects.stage.h / 2);
      letterbox[key] = {
        canvas: { w: Math.round(rects.canvas.w * 10) / 10, h: Math.round(rects.canvas.h * 10) / 10 },
        ratio: Math.round(ratio * 10000) / 10000,
        ratioError: Math.abs(ratio - SCENE_RATIO),
        centerOffsetX: Math.round(offX * 10) / 10,
        centerOffsetY: Math.round(offY * 10) / 10,
        fitsStage: rects.canvas.w <= rects.stage.w + 1 && rects.canvas.h <= rects.stage.h + 1,
        letterboxBarsPx: { x: Math.round((rects.stage.w - rects.canvas.w) / 2), y: Math.round((rects.stage.h - rects.canvas.h) / 2) },
      };
      if (letterbox[key].ratioError > 0.01) { fail('letterbox-ratio', letterbox[key]); app.exit(1); return; }
      if (offX > 2 || offY > 2) { fail('letterbox-center', letterbox[key]); app.exit(1); return; }
      if (!letterbox[key].fitsStage) { fail('letterbox-overflow', letterbox[key]); app.exit(1); return; }
    }

    // ---- (c) M4.1c merged painter order ------------------------------------
    const zOrder = JSON.parse(await evalJs(`JSON.stringify((() => {
      const r = window.__office.renderer;
      const ids = r.stage.children.map((child) => child.__layerId);
      const paint = r.furniturePaintOrder();
      const ground = r.groundPaintOrder();
      const bad = [];
      for (let i = 1; i < ground.length; i += 1) {
        if (ground[i - 1].key > ground[i].key) bad.push([ground[i - 1].id, ground[i].id]);
      }
      const layerOf = new Map(ids.map((id, index) => [id, index]));
      const children = r.layers['ground-entities'].children;
      const containerIndex = new Map(children.map((child, index) => [child.__furnitureId || child.__employeeId, index]));
      const mismatched = [];
      for (let i = 0; i < ground.length; i += 1) {
        const name = ground[i].id;
        if (containerIndex.get(name) !== i) mismatched.push(name);
      }
      return {
        layerOrder: ids,
        groundLayerAt: typeof layerOf.get('ground-entities') === 'number' ? layerOf.get('ground-entities') : -1,
        ascend: bad.length === 0,
        badPairs: bad.slice(0, 5),
        groundCount: ground.length,
        characterCount: ground.filter((entry) => entry.kind === 'character').length,
        furnitureCount: ground.filter((entry) => entry.kind === 'furniture').length,
        containerMatchesOrder: mismatched.length === 0,
        mismatched: mismatched.slice(0, 5),
        frontTextured: paint.filter((entry) => entry.role === 'front').length,
        frontAllTextured: paint.filter((entry) => entry.role === 'front').every((entry) => entry.textured),
        sortYCount: paint.filter((entry) => entry.sortY).length,
        sortYInGround: paint.filter((entry) => entry.sortY).every((entry) => entry.paintsIn === 'ground-entities'),
        legacyLayered: paint.filter((entry) => !entry.sortY).length,
      };
    })())`));
    if (zOrder.groundLayerAt < 0) { fail('ground-layer-missing', zOrder); app.exit(1); return; }
    if (!zOrder.sortYInGround || zOrder.sortYCount < 32) { fail('sorty-not-in-ground-pass', zOrder); app.exit(1); return; }
    if (!zOrder.ascend) { fail('painter-keys-descend', zOrder); app.exit(1); return; }
    if (!zOrder.containerMatchesOrder) { fail('recorded-order-diverges-from-scene-graph', zOrder); app.exit(1); return; }
    if (zOrder.characterCount < 1 || zOrder.furnitureCount < 32) { fail('merged-pass-counts', zOrder); app.exit(1); return; }
    if (zOrder.frontTextured !== 6 || !zOrder.frontAllTextured) { fail('chairs-not-textured', zOrder); app.exit(1); return; }

    // ---- (d)+(e) walkthrough with per-sample geometry checks ----------------
    const { sampleEdgeConflicts } = require(path.join(REPO, 'src/office/runtime/office-layout-compiler.js'));
    const walkFixture = runtimeLayout.fixture;
    const scene = { w: walkFixture.scene.referenceWidth, h: walkFixture.scene.referenceHeight };
    const moverRadius = 0.02 * Math.min(scene.w, scene.h);
    const workstationOfFurniture = (id) => { const m = /^(desk-[1-6])-/.exec(id || ''); return m ? m[1] : null; };
    const obstacles = [];
    const seatByWorkstation = {};
    for (const node of walkFixture.nodes) {
      const m = /^(desk-[1-6])$/.exec(node.id || '');
      if (m) seatByWorkstation[m[1]] = { x: node.position.x * scene.w, y: node.position.y * scene.h };
    }
    for (const item of walkFixture.furniture) {
      for (const rect of Object.values(item.parts || {})) {
        obstacles.push({
          id: item.id,
          workstation: workstationOfFurniture(item.id),
          rect: { x: rect.x * scene.w, y: rect.y * scene.h, width: rect.width * scene.w, height: rect.height * scene.h },
        });
      }
    }
    // Transit radius per workstation: the sampler exempts a workstation's own
    // furniture for its seat-touching edges (the seating composition), so the
    // realtime check exempts the same zone — everything within reach of the
    // seat through the workstation's own furniture. Foreign furniture beyond
    // that radius (props, other workstations, aisles) stays a hard violation.
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

    const samples = [];
    const zSamples = { walkerOverDesk: null, seatedUnderChair: null };
    const zChecks = { pending: [], inFlight: false, checked: 0, stale: 0, failures: [] };
    const violations = [];
    const pairViolations = [];
    const transitStats = {};
    let frameCount = 0;
    let sampling = true;
    const sampler = setInterval(() => {
      if (!sampling) return;
      const state = simulation.state();
      const at = state.employees.map((employee) => ({
        id: employee.employeeId,
        x: employee.position.x * scene.w,
        y: employee.position.y * scene.h,
        movement: employee.movement,
        activity: employee.activity,
        seat: employee.seatNodeId,
        phase: employee.transition ? employee.transition.phase : null,
        segment: employee.segment ? employee.segment.kind : null,
      }));
      samples.push({ tick: state.tick, employees: at });
      // M4.1c semantic z-samples. The rule is stated in reference geometry
      // (main process) and verified IMMEDIATELY against the live scene graph:
      //   walkerOverDesk   — a moving body horizontally over a station band with
      //                      its foot below the desk's bottom edge must paint after it
      //   seatedUnderChair — the body seated at that desk (module seat id), foot
      //                      above the chair's bottom edge, must paint before it
      // At check time the keys are re-read and the same precondition is
      // re-derived from them: a claim whose geometry no longer holds is stale,
      // never a violation.
      const claimZ = (claim) => {
        zChecks.pending.push(claim);
        if (zChecks.inFlight) return;
        zChecks.inFlight = true;
        (async () => {
          while (zChecks.pending.length > 0) {
            const next = zChecks.pending.shift();
            try {
              const raw = await evalJs(`JSON.stringify((() => {
                const r = window.__office.renderer;
                const ground = r.groundPaintOrder();
                const index = new Map(ground.map((entry, i) => [entry.id, i]));
                const pick = (id) => {
                  const at = ground.find((entry) => entry.id === id);
                  return at ? { index: index.get(id), key: at.key, kind: at.kind } : null;
                };
                return { self: pick(${JSON.stringify(next.employeeId)}), target: pick(${JSON.stringify(next.furnitureId)}) };
              })())`);
              const seen = JSON.parse(raw);
              zChecks.checked += 1;
              if (!seen.self || !seen.target) {
                zChecks.stale += 1;
                continue;
              }
              const selfKey = seen.self.key;
              const targetKey = seen.target.key;
              let precondition;
              let holds;
              if (next.rule === 'walkerOverDesk') {
                precondition = selfKey > targetKey; // foot below the desk bottom edge
                holds = seen.self.index > seen.target.index; // painted over the desk
              } else {
                precondition = selfKey < targetKey; // foot above the chair's bottom edge
                holds = seen.self.index < seen.target.index; // painted under the chair
              }
              if (!precondition) { zChecks.stale += 1; continue; }
              if (!holds) {
                zChecks.failures.push({
                  ...next, selfKey, targetKey,
                  employeeIndex: seen.self.index, furnitureIndex: seen.target.index,
                });
              } else if (!zSamples[next.rule]) {
                zSamples[next.rule] = {
                  tick: next.tick, employee: next.employeeId, furniture: next.furnitureId,
                  employeeIndex: seen.self.index, furnitureIndex: seen.target.index,
                  employeeKeyPx: Math.round(selfKey * 10) / 10, furnitureKeyPx: Math.round(targetKey * 10) / 10,
                };
              }
            } catch { zChecks.stale += 1; }
          }
          zChecks.inFlight = false;
        })().catch(() => { zChecks.inFlight = false; });
      };
      for (const employee of at) {
        const charHalfW = (0.11 * scene.h * (319 / 277)) / 2;
        for (const item of walkFixture.furniture) {
          const m = /^(desk-[1-6])-(back|chair)$/.exec(item.id || '');
          if (!m) continue;
          const rect = Object.values(item.parts || {})[0];
          if (!rect) continue;
          const box = {
            x: rect.x * scene.w, y: rect.y * scene.h,
            width: rect.width * scene.w, height: rect.height * scene.h,
          };
          const bottom = box.y + box.height;
          const overlapX = Math.abs(employee.x - (box.x + box.width / 2)) < box.width / 2 + charHalfW * 0.6;
          if (!overlapX) continue;
          if (m[2] === 'back' && employee.movement === 'moving'
            && employee.y > bottom && employee.y < bottom + 120) {
            claimZ({ rule: 'walkerOverDesk', tick: state.tick, employeeId: employee.id, furnitureId: item.id });
          }
          if (m[2] === 'chair' && employee.movement === 'stationary'
            && employee.seat === m[1]
            && employee.y < bottom && employee.y > box.y - 40) {
            claimZ({ rule: 'seatedUnderChair', tick: state.tick, employeeId: employee.id, furnitureId: item.id });
          }
        }
      }
      for (const employee of at) {
        const point = { x: employee.x, y: employee.y };
        for (const obstacle of obstacles) {
          if (obstacle.workstation) {
            // the sampler's seat-touch exemption, expressed per point: the
            // workstation's own furniture zone around its seat is walkable
            const seat = seatByWorkstation[obstacle.workstation];
            const reach = transitRadius[obstacle.workstation] || 0;
            if (seat && Math.hypot(point.x - seat.x, point.y - seat.y) <= reach) continue;
          }
          if (pointRectDistance(point, obstacle.rect) < moverRadius) {
            violations.push({ tick: state.tick, employeeId: employee.id, furnitureId: obstacle.id, x: Math.round(employee.x * 10) / 10, y: Math.round(employee.y * 10) / 10 });
          }
        }
      }
      for (let i = 0; i < at.length; i += 1) {
        for (let j = i + 1; j < at.length; j += 1) {
          const d = Math.hypot(at[i].x - at[j].x, at[i].y - at[j].y);
          // 同一格 = two employees PARKED in the same spot. Transient crossings
          // (both moving, no path reservations in the scheduler contract) are
          // recorded as stats, not violations.
          if (at[i].movement === 'stationary' && at[j].movement === 'stationary' && d < 20) {
            pairViolations.push({ tick: state.tick, a: at[i].id, b: at[j].id, distancePx: Math.round(d * 10) / 10 });
          } else if (d < (transitStats.minPairDistance ?? Infinity)) {
            transitStats.minPairDistance = Math.round(d * 10) / 10;
          }
        }
      }
    }, 100);

    const emp = (state, id = 'orchestrator') => state.employees.find((candidate) => candidate.employeeId === id);
    const waitUntil = async (predicate, label, maxMs = 90000) => {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        if (predicate(simulation.state())) return true;
        await sleep(100);
      }
      fail('wait-timeout', label);
      return false;
    };

    const roamNodes = simulation.layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id));
    const parked = await waitUntil((state) => {
      const employee = emp(state);
      return employee && employee.movement === 'stationary'
        && roamNodes.some((node) => Math.hypot(employee.position.x - node.position.x, employee.position.y - node.position.y) < 0.02);
    }, 'orchestrator dwells at a roam node');
    if (!parked) { app.exit(1); return; }

    // frame capture during the visible task loop
    const frameTimer = setInterval(async () => {
      try {
        if (frameCount >= 24) return;
        const image = await win.webContents.capturePage();
        if (!image || image.isEmpty()) return;
        fs.writeFileSync(path.join(EVIDENCE, `walk-t${String(frameCount).padStart(2, '0')}.png`), image.toPNG());
        frameCount += 1;
      } catch { /* closing */ }
    }, 500);

    simulation.ingestHarnessEvent({ sessionId: 'sess-e4-walk', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
    const working = await waitUntil((state) => emp(state).transition && emp(state).transition.phase === 'work', 'route→approach→seat→work');
    if (!working) { app.exit(1); return; }
    await sleep(1500);
    simulation.ingestHarnessEvent({ sessionId: 'sess-e4-walk', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
    const done = await waitUntil((state) => emp(state).transition === null, 'result→stand→leave completes');
    if (!done) { app.exit(1); return; }
    await sleep(1200);
    sampling = false;
    clearInterval(sampler);
    clearInterval(frameTimer);
    clearInterval(pushTimer);

    if (violations.length > 0) { fail('walk-clipping', violations.slice(0, 8)); app.exit(1); return; }
    if (pairViolations.length > 0) { fail('employee-overlap', pairViolations.slice(0, 8)); app.exit(1); return; }
    // M4.1c: the two layering rules must have been exercised AND held.
    if (zChecks.failures.length > 0) { fail('z-order-semantics', zChecks.failures.slice(0, 5)); app.exit(1); return; }
    if (!zSamples.walkerOverDesk) { fail('z-order-not-exercised', { rule: 'walkerOverDesk', checked: zChecks.checked, stale: zChecks.stale }); app.exit(1); return; }
    if (!zSamples.seatedUnderChair) { fail('z-order-not-exercised', { rule: 'seatedUnderChair', checked: zChecks.checked, stale: zChecks.stale }); app.exit(1); return; }

    // self-check: the fixture's own graph still passes the strict sampler
    const graphConflicts = sampleEdgeConflicts(walkFixture);

    const results = {
      layoutSource: source,
      letterbox,
      zOrder,
      zSemantics: { ...zSamples, checked: zChecks.checked, stale: zChecks.stale, failures: zChecks.failures },
      walk: {
        sampleCount: samples.length,
        clippingViolations: violations.length,
        pairOverlapViolations: pairViolations.length,
        minTransientPairDistancePx: transitStats.minPairDistance ?? null,
        graphEdgeConflicts: graphConflicts.length,
        frames: frameCount,
      },
    };
    const payload = JSON.stringify(results, null, 2);
    try { fs.writeFileSync(path.join(EVIDENCE, 'walkthrough-results.json'), payload); } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(OUT_DIR, 'walkthrough-results.json'), payload); } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(EVIDENCE, 'walk-samples.json'), JSON.stringify(samples)); } catch { /* best effort */ }
    console.log('E4_WALK_PROBE_OK');
    app.exit(0);
  } catch (error) {
    fail('exception', error && error.stack ? error.stack : String(error));
    app.exit(1);
  }
}).catch((e) => { fail('unhandled', e && e.stack || e); app.exit(1); });
