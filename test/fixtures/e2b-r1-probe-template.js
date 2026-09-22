'use strict';
// Task E2b-R1 real-shell probe (spawned by office-ui.test.js). Asserts at two
// window sizes: (a) a drop at the canvas center lands at (0.5, 0.5),
// (b) the se-handle drag increases scale with the NW corner fixed on screen,
// (c) a group drag shows guide nodes mid-drag and none after release.
// Writes results.json next to itself and exits 0; throws/exits 1 on failure.
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = '__REPO__'; // substituted by the spawning test
const OUT_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2b-r1-'));
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
app.whenReady().then(async () => {
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
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[PAGE-ERR]', String(message).slice(0, 200), sourceId && String(sourceId).split('/').pop(), line);
  });
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 2) console.error('[PAGE-ERR]', String(message).slice(0, 220), sourceId && String(sourceId).split('/').pop(), line);
  });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  const evalJsCatch = (label, s) => win.webContents.executeJavaScript(s, true).catch((e) => { console.error('STEP-FAIL', label, String(e).slice(0, 160)); return null; });
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    // NEVER stringify the whole window.__office (page/renderer refs are
    // circular) — probe the boolean surface only, error text via its own hook
    const ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) { console.error('[BOOT] ready'); break; }
    const bootError = await evalJs('(window.__office && typeof window.__office.error === "string") ? window.__office.error : ""').catch(() => '');
    if (bootError) { console.error('[BOOT-ERROR]', bootError.slice(0, 300)); app.exit(1); }
  }
  const toggleEditor = async () => {
    for (let i = 0; i < 50; i += 1) {
      if (await evalJs('Boolean(window.__office && window.__office.api)').catch(() => false)) break;
      await sleep(200);
    }
    return evalJs("window.__office.api.toggleLayoutEditor()");
  };
  await toggleEditor();
  await sleep(900);
  const out = { sizes: {} };
  const sendMouse = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  for (const size of [[1600, 1000], [1200, 800]]) {
    win.setContentSize(size[0], size[1]);
    await sleep(700);
    const sizeKey = size[0] + 'x' + size[1];
    const canvas = JSON.parse(await evalJs("JSON.stringify((() => { const c = document.getElementById('layout-canvas').getBoundingClientRect(); return { left: c.left, top: c.top, width: c.width, height: c.height }; })())"));
    // (c) group drag shows guides mid-drag, none after release. Task E3b:
    // groups are LOOSE by default (members drag alone), so the group-drag
    // probe locks the desk group first via the evidence hook.
    await evalJsCatch('rigid', "window.__office.api.setGroupMoveRigid('draft-4', true)");
    const guideCounts = JSON.parse(await evalJsCatch('guides', "(() => { const node = document.querySelector('[data-draft-id=\"draft-4\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 91 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); const counts = []; for (let s = 1; s <= 6; s += 1) { node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + s * 12, clientY: o.clientY })); counts.push(document.getElementById('layout-guide-layer').querySelectorAll('.layout-guide-v, .layout-guide-h').length); } node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + 72, clientY: o.clientY })); return JSON.stringify({ midCounts: counts, after: document.getElementById('layout-guide-layer').querySelectorAll('.layout-guide-v, .layout-guide-h').length, moved: window.__office.api.layoutDraft().items.find((x) => x.id === 'draft-4').position.x }); })()"));
    out.sizes[sizeKey] = out.sizes[sizeKey] || {};
    out.sizes[sizeKey].guides = guideCounts;
    // (b) scale: select draft-24 via click, REAL-mouse drag the se handle +30px
    await evalJs("(() => { const node = document.querySelector('[data-draft-id=\"draft-24\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()");
    await sleep(250);
    const handleInfo = JSON.parse(await evalJsCatch('handleInfo', "(() => { const node = document.querySelector('[data-draft-id=\"draft-24\"]'); const handle = document.getElementById('layout-handle-layer').querySelector('.handle-se'); if (!node || !handle) return JSON.stringify({ missing: true }); const nr = node.getBoundingClientRect(); const hr = handle.getBoundingClientRect(); return JSON.stringify({ hx: Math.round(hr.left + hr.width / 2), hy: Math.round(hr.top + hr.height / 2), nwx: Math.round(nr.left), nwy: Math.round(nr.top), scale: window.__office.api.layoutDraft().items.find((x) => x.id === 'draft-24').scale }); })()"));
    if (!handleInfo.missing) {
      const scaleBefore = handleInfo.scale;
      sendMouse('mouseDown', handleInfo.hx, handleInfo.hy);
      await sleep(60);
      for (let s = 1; s <= 6; s += 1) { sendMouse('mouseMove', handleInfo.hx + s * 5, handleInfo.hy + s * 5); await sleep(40); }
      sendMouse('mouseUp', handleInfo.hx + 30, handleInfo.hy + 30);
      await sleep(250);
      const scaled = JSON.parse(await evalJsCatch('scaled', "(() => { const item = window.__office.api.layoutDraft().items.find((x) => x.id === 'draft-24'); const node = document.querySelector('[data-draft-id=\"draft-24\"]'); const r = node.getBoundingClientRect(); return JSON.stringify({ scale: item.scale, nw: { x: Math.round(r.left), y: Math.round(r.top) } }); })()"));
      out.sizes[sizeKey].scale = { before: scaleBefore, after: scaled.scale };
      out.sizes[sizeKey].nwBefore = { x: handleInfo.nwx, y: handleInfo.nwy };
      out.sizes[sizeKey].nwAfter = scaled.nw;
      await evalJs("document.getElementById('editor-undo').click()");
      await sleep(200);
    }
    // (c LAST) drop an asset at the exact canvas center
    const dropResult = JSON.parse(await evalJsCatch('drop', "(() => { const dt = new DataTransfer(); dt.setData('application/x-office-layout-asset', 'flat-desk'); const ev = new Event('drop', { bubbles: true, cancelable: true }); ev.dataTransfer = dt; ev.clientX = " + (canvas.left + canvas.width / 2) + "; ev.clientY = " + (canvas.top + canvas.height / 2) + "; document.getElementById('layout-canvas').dispatchEvent(ev); const draft = window.__office.api.layoutDraft(); const it = draft.items[draft.items.length - 1]; return JSON.stringify({ count: draft.items.length, position: it.position }); })()"));
    out.sizes[sizeKey].dropCenter = dropResult ? dropResult.position : null;
    out.sizes[sizeKey].dropCount = dropResult ? dropResult.count : null;
    await evalJsCatch('unrigid', "window.__office.api.setGroupMoveRigid('draft-4', false)");

  }
  // write into the run dir AND next to the script (the spawner reads the latter)
  const payload = JSON.stringify(out, null, 2);
  try { fs.writeFileSync(path.join(RUN_DIR, 'results.json'), payload); } catch { /* best effort */ }
  try { fs.writeFileSync(path.join(__dirname, 'results.json'), payload); } catch { /* best effort */ }
  console.log('E2B_R1_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E2B_R1_PROBE_FAILED', e && e.stack || e); app.exit(1); });
