'use strict';
// Task E5a-R2 reproduction/evidence probe (spawned by office-ui.test.js).
// Boots the REAL office page with the user's flat draft served as the saved
// layout, so the RUNTIME office renders exactly that draft. Measures, for
// the desk-1 character (draft-39, whale-girl-back):
//  - runtime: the renderer entity's visibleHeight (its __layout record) and
//    the live scene height;
//  - the animation resource while seated-working and while walking
//    (walk-left / walk-right), from the module snapshots;
//  - the pack geometry numbers the mapping formula uses.
// Captures runtime (idle + working) screenshots for the side-by-side
// evidence. Writes results.json into __EVIDENCE__; failures are
// console.error + app.exit(1) (no assert inside probes).
// P5 note: the editor-side measurement (toggleLayoutEditor + layoutDraft)
// left with the editor UI; the draft character facts are read from the
// served draft file in Node instead, and the height cross-check moved to
// the documented formula (see office-module.js).
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = '__REPO__';
const EVIDENCE = '__EVIDENCE__';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-r2-'));
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
  console.error(`E5A_R2_FAIL ${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 500)}`);
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
      if (rel === 'office-layout.v1.json') {
        // serve the committed flat draft as the user-saved layout: the page
        // compiles it into the runtime layout — one draft, the real surface
        return new Response(fs.readFileSync(path.join(REPO, 'test/fixtures/office-layout-flat-draft.json')), { headers: { 'content-type': 'application/json' } });
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

    const { createOfficeModule, loadRuntimeLayoutFixture } = require(path.join(REPO, 'src/office/office-module.js'));
    const { createAssetPack } = require(path.join(REPO, 'src/office/runtime/asset-pack.js'));
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/manifest.json'), 'utf8'));
    const anchors = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/animation/anchors.json'), 'utf8'));
    const animations = JSON.parse(fs.readFileSync(path.join(REPO, 'resources/characters/deepseek-default/animation/animations.json'), 'utf8'));
    const pack = createAssetPack({ manifest, anchors, animations }).pack;
    // P5: the draft character facts used to be read through the editor's
    // layoutDraft hook; the editor is gone, so read the same draft file the
    // page resolves (schema-v1 normalization only touches layer/group, the
    // asset/scale/direction fields are read verbatim either way).
    const flatDraft = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/office-layout-flat-draft.json'), 'utf8'));
    const draftItem = flatDraft.items.find((item) => item.id === 'draft-39') || null;
    const draftCharacter = draftItem
      ? { id: draftItem.id, kind: draftItem.kind, asset: draftItem.asset, scale: draftItem.scale, direction: draftItem.direction }
      : null;
    // the module reads the saved layout from the userData FILE (the page reads
    // it over the protocol) — seed both with the same committed draft
    fs.writeFileSync(path.join(RUN_DIR, 'office-layout.v1.json'), fs.readFileSync(path.join(REPO, 'test/fixtures/office-layout-flat-draft.json')));
    const runtimeLayout = loadRuntimeLayoutFixture({ userDataDir: RUN_DIR, log: () => {} });
    if (!runtimeLayout || runtimeLayout.source !== 'saved-compiled') { fail('layout-chain', runtimeLayout ? runtimeLayout.source : 'null'); app.exit(1); return; }
    const simulation = createOfficeModule({
      pack,
      layout: runtimeLayout.fixture,
      seed: 'e5a-r2-seed',
      config: { sleepAfterMs: 24 * 60 * 60 * 1000, resultPresentationMs: 1500 },
    });
    simulation.start();

    const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
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

    // ---- runtime idle measurement (editor closed) ---------------------------
    await sleep(800);
    const runtimeIdle = JSON.parse(await evalJs(`JSON.stringify((() => {
      const entity = window.__office.renderer.entities.get('orchestrator');
      if (!entity) return { missing: true };
      const layout = entity.__layout || {};
      return {
        visibleHeight: layout.visibleHeight ?? null,
        scene: window.__office.renderer.diagnostics().scene,
        snapshotPresentation: (window.__office.api.snapshot().employees.find((e) => e.employeeId === 'orchestrator') || {}).presentation ?? null,
        idleResource: (window.__office.api.snapshot().employees.find((e) => e.employeeId === 'orchestrator') || {}).animation,
      };
    })())`));
    const idleShot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'runtime-idle.png'), idleShot.toPNG());

    // ---- task loop: seated-working resource + walking resources -------------
    const readEntityLayout = async () => {
      try {
        return JSON.parse(await evalJs(`JSON.stringify((() => {
          const entity = window.__office.renderer.entities.get('orchestrator');
          return entity && entity.__layout ? { h: entity.__layout.visibleHeight, scene: window.__office.renderer.diagnostics().scene.height } : null;
        })())`));
      } catch { return null; }
    };
    const roamNodes = simulation.layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id));
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const state = simulation.state();
      const employee = state.employees.find((candidate) => candidate.employeeId === 'orchestrator');
      if (employee && employee.movement === 'stationary'
        && roamNodes.some((node) => Math.hypot(employee.position.x - node.position.x, employee.position.y - node.position.y) < 0.02)) break;
      await sleep(200);
    }
    simulation.ingestHarnessEvent({ sessionId: 'sess-e5a-r2', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
    let workDeadline = Date.now() + 90000;
    let seated = null;
    const walking = { left: null, right: null, visibleHeight: null, sceneHeight: null };
    let lastWalkResource = null;
    while (Date.now() < workDeadline) {
      const state = simulation.state();
      const employee = state.employees.find((candidate) => candidate.employeeId === 'orchestrator');
      const animation = employee ? employee.animation || {} : {};
      // the size must be state-independent: record the rendered height mid-walk
      if ((animation.resource === 'walk-left' || animation.resource === 'walk-right') && walking.visibleHeight === null) {
        const viaApi = await readEntityLayout();
        if (viaApi && viaApi.h) { walking.visibleHeight = viaApi.h; walking.sceneHeight = viaApi.scene; }
      }
      if (animation.resource !== lastWalkResource && (animation.resource === 'walk-left' || animation.resource === 'walk-right')) {
        walking[animation.resource === 'walk-left' ? 'left' : 'right'] = animation.resource;
        lastWalkResource = animation.resource;
      }
      if (employee && employee.transition && employee.transition.phase === 'work') {
        const viaApi = await readEntityLayout();
        seated = {
          resource: animation.resource,
          frameIndex: animation.frameIndex,
          fallbackReason: animation.fallbackReason,
          visibleHeight: viaApi ? viaApi.h : null,
          sceneHeight: viaApi ? viaApi.scene : null,
        };
        break;
      }
      await sleep(100);
    }
    // E6d: while seated, record the working-back LOOP — frame indices sampled
    // across more than one full cycle (must advance strictly 0→1→2→0 with no
    // skips and no placeholder flash) plus one screenshot per frame.
    if (seated) {
      // > one full cycle from ANY phase offset: the worst case (sampling
      // starts at the beginning of a frame window) needs >4s to observe four
      // index transitions, so sample 5.2s.
      // working-back 循环 3 帧 @1000ms（整循环 3s）；窗口覆盖 >1 个完整循环
      // （0→1→2→0 至少 4 个节拍）
      const SAMPLE_SPAN_MS = 5200;
      const sampleDeadline = Date.now() + SAMPLE_SPAN_MS;
      let lastFrameIndex = null;
      let shotCount = 0;
      const samples = [];
      while (Date.now() < sampleDeadline) {
        const state = simulation.state();
        const employee = state.employees.find((candidate) => candidate.employeeId === 'orchestrator');
        const animation = employee ? employee.animation || {} : {};
        const placeholder = await evalJs(`(() => {
          const entity = window.__office.renderer.entities.get('orchestrator');
          return entity ? entity.__placeholder === true : null;
        })()`).catch(() => null);
        samples.push({
          atMs: SAMPLE_SPAN_MS - (sampleDeadline - Date.now()),
          resource: animation.resource || null,
          frameIndex: typeof animation.frameIndex === 'number' ? animation.frameIndex : null,
          placeholder,
        });
        if (animation.frameIndex !== lastFrameIndex) {
          const shot = await win.webContents.capturePage().catch(() => null);
          if (shot && shotCount < 4) {
            fs.writeFileSync(path.join(EVIDENCE, `seated-frame-${animation.frameIndex}.png`), shot.toPNG());
            shotCount += 1;
          }
          lastFrameIndex = animation.frameIndex;
        }
        await sleep(100);
      }
      seated.loopSamples = samples;
    }
    const workingShot = seated ? (await win.webContents.capturePage()) : null;
    if (workingShot) fs.writeFileSync(path.join(EVIDENCE, 'runtime-working.png'), workingShot.toPNG());
    simulation.ingestHarnessEvent({ sessionId: 'sess-e5a-r2', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
    await sleep(800);
    clearInterval(pushTimer);

    if (!seated) { fail('never-seated', 'the orchestrator never reached the work phase'); app.exit(1); return; }

    const results = {
      layoutSource: runtimeLayout.source,
      packGeometry: {
        visibleBounds: pack.geometry.visibleBounds,
        outputCanvas: anchors.outputCanvas,
        anchor: anchors.anchor,
      },
      draftCharacter: draftCharacter,
      runtimeIdle: runtimeIdle,
      seated: seated,
      walking: walking,
    };
    const payload = JSON.stringify(results, null, 2);
    try { fs.writeFileSync(path.join(EVIDENCE, 'results.json'), payload); } catch { /* best effort */ }
    try { fs.writeFileSync(path.join(__dirname, 'results.json'), payload); } catch { /* best effort */ }
    console.log('E5A_R2_PROBE_OK');
    app.exit(0);
  } catch (error) {
    fail('exception', error && error.stack ? error.stack : String(error));
    app.exit(1);
  }
}).catch((e) => { fail('unhandled', e && e.stack || e); app.exit(1); });
