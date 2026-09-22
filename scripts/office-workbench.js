'use strict';

// scripts/office-workbench.js — Workbench M0 shell (npm run office:workbench).
//
// One Electron window, three panes:
//   left   = content/ resource tree (workbench renderer page)
//   center = PREVIEW FIELD: the real office page (office.html, ?editor=1)
//            embedded as a SAME-ORIGIN iframe — workbench://local/preview/
//            office.html, a tool-served copy of the product page (only its
//            CSP origin reference is rewritten for this copy). Its
//            "saved layout" route is answered with content/scenes/flat/
//            layout.json through a READ-ONLY store so the preview shows the
//            approved flat baseline and the baseline can never be written
//            back (D1/D5). The subframe receives the REAL office bridge —
//            this window's preload requires src/office/office-preload.js
//            verbatim.
//   right  = property inspector surface: geometry report, asset validator,
//            golden gallery with pixel/geometry diff.
//
// Boundaries this launcher enforces (docs/notes/office-workbench-m0.md §3):
// - ISOLATED userData: .workbench-data/ in the repo — the real user profile
//   AND .office-editor-data/ are never read or written.
// - The workbench WRITES only content/build/** (gallery, reports).
//   content/scenes/flat/layout.json is read-only.
// - office:* IPC stays the launcher stub set (empty snapshot); the seven
//   channel semantics and the office preload whitelist are untouched.
// - The gallery renders through the REAL runtime renderer (pixi-office-
//   renderer via office.html) — read-only reuse, no renderer changes.
// - Window titles stay distinguishable: product `Agent Office`, probes
//   `PROBE 临时数据（可关闭）`, this shell `Office Workbench`.
//
// stdout contract: `OFFICE_WORKBENCH_READY` once both pages report ready —
// evidence probes wait on this line. Failures print
// `OFFICE_WORKBENCH_BOOT_FAILED <CODE>` to stderr and exit non-zero.
//
// Evidence mode: WORKBENCH_EVIDENCE_DIR=<dir> automates a full M0 sweep
// (screenshots, reports, two gallery runs with diff) into that directory and
// exits — used by the M0 verification, harmless otherwise.

const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? path.resolve(process.env.WORKBENCH_DATA_DIR)
  : path.join(REPO_ROOT, '.workbench-data');
const CONTENT_DIR = path.join(REPO_ROOT, 'content');
const SOURCE_PACK_DIR = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default');
const GALLERY_SIZES = Object.freeze([[1582, 955], [1280, 840], [1100, 760]]);
const GALLERY_ZOOMS = Object.freeze([1, 2]);
const STRIP_FRAME_PX = 352; // the character canvas
const STRIP_GAP_PX = 16;

const libs = {
  geometry: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'character-geometry.js')),
  assets: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'asset-validator.js')),
  content: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'content-validator.js')),
  png: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js')),
  // M1 action editor: pure model, import normalizer, publish kernel
  model: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-model.js')),
  normalizer: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'normalizer.js')),
  publisher: require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js')),
};

const EVIDENCE_DIR = process.env.WORKBENCH_EVIDENCE_DIR ? path.resolve(process.env.WORKBENCH_EVIDENCE_DIR) : null;
const M1_EVIDENCE_DIR = process.env.WORKBENCH_M1_EVIDENCE_DIR ? path.resolve(process.env.WORKBENCH_M1_EVIDENCE_DIR) : null;
const M1_EVIDENCE_PHASE = process.env.WORKBENCH_M1_PHASE === '2' ? 2 : 1;
const CHARACTERS_ROOT = path.join(REPO_ROOT, 'resources', 'characters');

// Privileged scheme declarations must precede app ready (same privileges as
// the cockpit and the standalone editor register).
protocol.registerSchemesAsPrivileged([
  { scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'workbench', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// userData isolation happens BEFORE app ready so no Electron service ever
// touches the real profile (or the office editor's data directory).
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);

function fail(code, error) {
  console.error(`OFFICE_WORKBENCH_BOOT_FAILED ${code}${error ? ` ${error}` : ''}`);
  app.exit(1);
}

// ---- read-only content layout store ----------------------------------------
//
// The office page fetches ./office-layout.v1.json for its "saved layout"
// boot source. Inside the workbench that route answers with the APPROVED
// baseline content/scenes/flat/layout.json — read-only: a 保存布局 PUT (the
// office editor's production-save path) answers a stable failure so the
// baseline can never be written back from the preview, and DELETE (恢复
// 默认) is a no-op that keeps the baseline.

function createContentLayoutStore() {
  return {
    loadSavedLayout() {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'scenes', 'flat', 'layout.json'), 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
          return { ok: false, missing: false, code: 'OFFICE_LAYOUT_SAVED_INVALID', draft: null };
        }
        return { ok: true, missing: false, code: null, draft: parsed };
      } catch (error) {
        if (error && error.code === 'ENOENT') return { ok: false, missing: true, code: null, draft: null };
        return { ok: false, missing: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT', draft: null };
      }
    },
    saveSavedLayout() {
      return Promise.resolve({ ok: false, code: 'OFFICE_WORKBENCH_LAYOUT_READONLY' });
    },
    deleteSavedLayout() {
      return Promise.resolve({ ok: true });
    },
  };
}

// ---- workbench:// protocol (the shell's own pages + read-only mounts) ------

const MIME_TABLE = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

function createWorkbenchProtocolHandler() {
  const mounts = [
    // the PREVIEW iframe is a tool-served copy of the product office page on
    // the SAME origin as the shell (same renderer process → the composition
    // actually paints/captures everywhere, unlike an out-of-line child view):
    // its relative URLs resolve through these preview/ mounts, and the saved
    // layout route answers with the read-only content baseline.
    { prefix: 'preview/node_modules/', root: path.join(REPO_ROOT, 'node_modules') },
    { prefix: 'preview/office-assets/', root: path.join(REPO_ROOT, 'resources', 'office') },
    { prefix: 'preview/characters/', root: path.join(REPO_ROOT, 'resources', 'characters') },
    { prefix: 'preview/', root: path.join(REPO_ROOT, 'src', 'office'), rewriteOfficeCsp: true },
    { prefix: 'content/', root: CONTENT_DIR },
    { prefix: 'pack/', root: SOURCE_PACK_DIR },
    { prefix: '', root: path.join(REPO_ROOT, 'src', 'workbench') },
  ];
  return (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // the office page's saved-layout route, served READ-ONLY from the
    // content baseline (see createContentLayoutStore above)
    if (rel === 'preview/office-layout.v1.json') {
      const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      const store = createContentLayoutStore();
      if (request.method === 'GET' || request.method === 'HEAD') {
        const loaded = store.loadSavedLayout();
        if (loaded.ok) return new Response(JSON.stringify(loaded.draft), { headers: jsonHeaders });
        return new Response('not found', { status: 404, headers: jsonHeaders });
      }
      if (request.method === 'PUT') {
        return request.text().then(() => new Response(JSON.stringify({ ok: false, code: 'OFFICE_WORKBENCH_LAYOUT_READONLY' }), { status: 500, headers: jsonHeaders }));
      }
      if (request.method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
      return new Response('method not allowed', { status: 405, headers: jsonHeaders });
    }
    // M1 STAGED PREVIEW OVERLAY — preview-only, production bytes untouched:
    // while the action panel plays a draft, the preview iframe boots from
    // content/build/preview-pack/{animations,anchors}.json (the EDITED play
    // order) instead of the production pack files, and frame files that only
    // exist as content assets (imported, not yet published) are served from
    // content/characters/whale-girl/assets/. Everything below serves the real
    // pack files exactly as before.
    if (rel.startsWith('preview/characters/')) {
      const packPrefix = `preview/characters/${libs.publisher.PACK_ID}/`;
      if (rel.startsWith(packPrefix)) {
        const packRel = rel.slice(packPrefix.length);
        const safePackRel = packRel.replace(/\\/g, '/');
        if (!safePackRel.split('/').includes('..')) {
          const stagedNames = ['animation/animations.json', 'animation/anchors.json'];
          if (stagedNames.includes(safePackRel)) {
            const staged = path.join(CONTENT_DIR, 'build', 'preview-pack', path.basename(safePackRel));
            if (fs.existsSync(staged)) {
              return new Response(fs.readFileSync(staged), {
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
              });
            }
          }
          const packAbs = path.join(REPO_ROOT, 'resources', 'characters', libs.publisher.PACK_ID, safePackRel);
          if (!fs.existsSync(packAbs)) {
            const contentAsset = path.join(CONTENT_DIR, 'characters', 'whale-girl', 'assets', safePackRel);
            if (fs.existsSync(contentAsset)) {
              return new Response(fs.readFileSync(contentAsset), {
                headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
              });
            }
          }
        }
      }
    }
    for (const mount of mounts) {
      if (!rel.startsWith(mount.prefix)) continue;
      const abs = path.resolve(mount.root, rel.slice(mount.prefix.length));
      if (!abs.startsWith(path.resolve(mount.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new Response('not found', { status: 404 });
      }
      let body = fs.readFileSync(abs);
      // The product office page pins its CSP to the office-runtime origin.
      // The tool-served preview copy runs on workbench://local, so the CSP
      // scheme reference is rewritten for THIS COPY ONLY — the product file
      // and every product entry point stay byte-identical.
      if (mount.rewriteOfficeCsp && abs.endsWith('.html')) {
        body = Buffer.from(body.toString('utf8').replaceAll('office-runtime://local', 'workbench://local'), 'utf8');
      }
      const headers = { 'content-type': MIME_TABLE[path.extname(abs).toLowerCase()] || 'application/octet-stream' };
      if (!mount.rewriteOfficeCsp) {
        // The shell pages are the workbench's own surface; scripts load from
        // this scheme only, frames embed the same-origin preview copy.
        headers['content-security-policy'] = "default-src 'none'; script-src workbench:; style-src workbench: 'unsafe-inline'; img-src workbench: data:; connect-src workbench:; frame-src workbench:; font-src 'none'";
      }
      return new Response(body, { headers });
    }
    return new Response('not found', { status: 404 });
  };
}

// ---- geometry / report services (shared by panel, gallery and evidence) ----

function readCharacterJson() {
  return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'characters', 'whale-girl', 'character.json'), 'utf8'));
}

function resolveFramePath(character, frame) {
  // M0: frame bytes resolve against the provenance source pack (D4).
  const packRoot = character.provenance && character.provenance.sourcePack
    ? path.join(REPO_ROOT, character.provenance.sourcePack)
    : path.dirname(path.join(CONTENT_DIR, 'characters', 'whale-girl'));
  return path.join(packRoot, frame.file);
}

function walkGeometryReport() {
  return libs.geometry.buildWalkGeometryReport({
    character: readCharacterJson(),
    resolveFramePath,
  });
}

function catalogEntryById(assetId) {
  const { LAYOUT_ASSETS } = require(path.join(REPO_ROOT, 'src', 'office', 'layout-assets.js'));
  return LAYOUT_ASSETS.find((asset) => asset.id === assetId) || null;
}

function entryGeometryForAsset(assetId) {
  const asset = catalogEntryById(assetId);
  if (!asset) return { ok: false, code: 'ASSET_UNKNOWN' };
  const abs = libs.assets.resolveCatalogAssetPath(REPO_ROOT, asset.src);
  return {
    ok: true,
    asset: { id: asset.id, kind: asset.kind, label: asset.label, src: asset.src, direction: asset.direction, anchor: asset.anchor, contentBbox: asset.contentBbox || null },
    geometry: libs.geometry.measureEntry({ absPath: abs, anchor: asset.anchor, contentBbox: asset.contentBbox || null }),
  };
}

function listContentTree() {
  const walk = (dir, rel) => {
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'build') continue; // workbench-owned output, not content source
      const abs = path.join(dir, item.name);
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) entries.push({ path: childRel, type: 'dir', children: walk(abs, childRel) });
      else if (item.isFile()) {
        let stat = null;
        try { stat = fs.statSync(abs); } catch { /* vanished mid-walk */ }
        entries.push({ path: childRel, type: 'file', bytes: stat ? stat.size : null });
      }
    }
    return entries;
  };
  return walk(CONTENT_DIR, '');
}

// ---- M1 action editor services (the session lives on disk) ------------------
//
// Every panel op goes through the pure action model and autosaves the action
// doc when (and only when) it reports changed — "无变更不记录". Frame URLs
// resolve content assets first, then the provenance pack — mirroring the
// editor's resolution order (imported frames are editable before publishing).

function readJsonIfExists(absPath) {
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(absPath, 'utf8')) };
  } catch (error) {
    return { exists: fs.existsSync(absPath), value: null, error };
  }
}

function m1Paths() {
  return libs.publisher.createPaths({ contentDir: CONTENT_DIR, charactersRoot: CHARACTERS_ROOT });
}

function readPackAnimationDefaults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'characters', 'whale-girl', 'character.json'), 'utf8'));
    return {
      packCanvas: parsed.pack && parsed.pack.canvas ? parsed.pack.canvas : 352,
      packAnchor: parsed.pack && parsed.pack.anchor ? parsed.pack.anchor : { x: 178, y: 296 },
      packFootLine: parsed.pack && parsed.pack.footLine ? parsed.pack.footLine : 296,
    };
  } catch {
    return { packCanvas: 352, packAnchor: { x: 178, y: 296 }, packFootLine: 296 };
  }
}

function m1FrameUrl(paths, file) {
  const contentAsset = path.join(paths.assetsDir, file);
  return fs.existsSync(contentAsset)
    ? `workbench://local/content/characters/whale-girl/assets/${file}`
    : `workbench://local/pack/${file}`;
}

function m1ReadDoc(paths, actionId) {
  const abs = path.join(paths.actionsDir, `${actionId}.json`);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    return { ok: false, code: 'ACTION_DOC_MISSING', message: `actions/${actionId}.json missing or unparseable (${error.message})` };
  }
  const parsed = libs.model.parseActionDoc(raw);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  return { ok: true, doc: parsed.action, abs };
}

function m1PanelRead(actionId) {
  const paths = m1Paths();
  const loaded = m1ReadDoc(paths, actionId);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const validation = libs.publisher.validateForPublish(paths, doc).validation;
  const packAnimations = readJsonIfExists(paths.animationsPath);
  const defaults = readPackAnimationDefaults();
  return {
    ok: true,
    doc,
    frames: doc.frames.map((frame, index) => ({
      index,
      file: frame.file,
      basename: frame.file.split('/').pop(),
      url: m1FrameUrl(paths, frame.file),
      durationMs: frame.durationMs === undefined ? null : frame.durationMs,
    })),
    validation,
    defaults: {
      ...defaults,
      footLine: doc.geometry && Number.isInteger(doc.geometry.footLine) ? doc.geometry.footLine : defaults.packFootLine,
      direction: doc.direction,
      defaultFrameDurationMs: packAnimations.exists && packAnimations.value && typeof packAnimations.value.defaultFrameDurationMs === 'number'
        ? packAnimations.value.defaultFrameDurationMs
        : libs.model.DEFAULT_FRAME_DURATION_MS,
    },
  };
}

function m1ActionList() {
  const paths = m1Paths();
  let names = [];
  try {
    names = fs.readdirSync(paths.actionsDir).filter((name) => name.endsWith('.json'));
  } catch {
    names = [];
  }
  const actions = [];
  for (const name of names.sort()) {
    const loaded = m1ReadDoc(paths, name.slice(0, -'.json'.length));
    if (loaded.ok) {
      actions.push({ id: loaded.doc.id, frames: loaded.doc.frames.map((frame) => frame.file), loop: loaded.doc.loop, direction: loaded.doc.direction });
    }
  }
  return { actions };
}

function m1ActionOp(actionId, op, payload) {
  const paths = m1Paths();
  const loaded = m1ReadDoc(paths, actionId);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  let outcome;
  try {
    switch (op) {
      case 'move': outcome = libs.model.moveFrame(doc, Number(payload.from), Number(payload.to)); break;
      case 'insert': outcome = libs.model.insertFrame(doc, payload.index, String(payload.file), payload.durationMs === undefined ? null : payload.durationMs); break;
      case 'remove': outcome = libs.model.removeFrame(doc, Number(payload.index)); break;
      case 'duration': outcome = libs.model.setFrameDuration(doc, Number(payload.index), payload.value === undefined ? null : payload.value); break;
      case 'loop': outcome = libs.model.setLoop(doc, Boolean(payload.value)); break;
      default: return { ok: false, code: 'ACTION_OP_UNKNOWN', message: `unknown op ${op}` };
    }
  } catch (error) {
    return { ok: false, code: error.code || 'ACTION_OP_FAILED', message: error.message };
  }
  // 无变更不记录: a no-op op must not rewrite the draft.
  if (outcome.changed) libs.model.saveActionDoc(loaded.abs, outcome.action);
  return { ok: true, changed: outcome.changed, ...m1PanelRead(actionId) };
}

function m1ActionNew(id, direction) {
  const paths = m1Paths();
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.id', detail: 'id must be kebab-case [a-z0-9-]' }] };
  }
  if (!libs.model.DIRECTIONS.includes(direction)) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.direction', detail: `direction must be one of ${libs.model.DIRECTIONS.join('|')}` }] };
  }
  if (fs.existsSync(path.join(paths.actionsDir, `${id}.json`))) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.exists', detail: 'an action doc with this id already exists' }] };
  }
  const defaults = readPackAnimationDefaults();
  const doc = {
    schemaVersion: 1,
    id,
    loop: true,
    direction,
    frames: [],
    geometry: { footLine: defaults.packFootLine, tolerancePx: 1 },
  };
  libs.model.saveActionDoc(path.join(paths.actionsDir, `${id}.json`), doc);
  return { ok: true, id };
}

// The default pack-relative target path for an imported frame: the action's
// existing frame directory, or derived from the direction for empty actions.
function m1DefaultImportName(paths, doc) {
  let dir = null;
  if (doc.frames.length > 0) {
    dir = doc.frames[0].file.split('/').slice(0, -1).join('/');
  } else if (doc.id.startsWith('walk-') && ['left', 'right', 'up', 'down'].includes(doc.direction)) {
    dir = `assets/animations/walk/${doc.direction}`;
  } else {
    dir = 'assets/expressions';
  }
  const taken = new Set();
  for (const frame of doc.frames) taken.add(frame.file);
  for (let n = 1; n <= 999; n += 1) {
    const candidate = `${dir}/${doc.id}-${String(n).padStart(2, '0')}.png`;
    // never shadow an existing pack file or content asset (content resolves
    // FIRST in the editor — a collision would hijack the pack frame)
    if (taken.has(candidate)) continue;
    if (fs.existsSync(path.join(paths.assetsDir, candidate))) continue;
    if (fs.existsSync(path.join(paths.packRoot, candidate))) continue;
    return candidate;
  }
  return null;
}

function m1NormalizeForImport(paths, doc, sourcePath, requestedName) {
  const problems = [];
  let sourceBytes = null;
  try {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) problems.push({ file: sourcePath, check: 'source.exists', detail: 'source PNG not found' });
    else sourceBytes = fs.readFileSync(sourcePath);
  } catch (error) {
    problems.push({ file: sourcePath, check: 'source.readable', detail: error.message });
  }
  const defaults = readPackAnimationDefaults();
  // Target height = the same-action visible-height median (empty actions
  // target the pack's standard 256px frame height).
  let targetHeight = 256;
  if (doc.frames.length > 0) {
    const heights = [];
    for (const frame of doc.frames) {
      const abs = libs.publisher.resolveFramePath(paths, frame.file);
      if (!abs) continue;
      const m = libs.geometry.measureFrameFile(abs);
      if (m.ok) heights.push(m.visibleHeight);
    }
    if (heights.length > 0) targetHeight = libs.geometry.median(heights);
  }
  const footLine = doc.geometry && Number.isInteger(doc.geometry.footLine) ? doc.geometry.footLine : defaults.packFootLine;
  if (!sourceBytes) return { ok: false, violations: problems };
  const outcome = libs.normalizer.normalizeImportFrame({
    sourceBytes,
    targetHeight,
    footLine,
    packCanvas: defaults.packCanvas,
    packAnchor: defaults.packAnchor,
  });
  if (!outcome.ok) {
    return { ok: false, violations: [...problems, ...outcome.violations.map((violation) => ({ file: sourcePath, check: violation.check, detail: violation.detail }))] };
  }
  const name = typeof requestedName === 'string' && requestedName.trim() ? requestedName.trim().replace(/\\/g, '/') : m1DefaultImportName(paths, doc);
  if (!name || !libs.model.isSafeRelativePath(name) || !name.endsWith('.png')) {
    return { ok: false, violations: [{ file: name || '', check: 'target.name', detail: 'target file name must be a safe relative .png path' }] };
  }
  const targetAbs = path.join(paths.assetsDir, name);
  if (fs.existsSync(targetAbs)) {
    return { ok: false, violations: [{ file: name, check: 'target.name', detail: 'a content asset with this name already exists' }] };
  }
  return { ok: true, outcome, name, targetAbs, targetHeight, footLine };
}

function m1ImportPreview(actionId, sourcePath, requestedName) {
  const paths = m1Paths();
  const loaded = m1ReadDoc(paths, actionId);
  if (!loaded.ok) return loaded;
  const result = m1NormalizeForImport(paths, loaded.doc, String(sourcePath), requestedName);
  if (!result.ok) return result;
  return {
    ok: true,
    name: result.name,
    dataUrl: `data:image/png;base64,${result.outcome.png.toString('base64')}`,
    metrics: result.outcome.metrics,
    targetHeight: result.targetHeight,
    footLine: result.footLine,
  };
}

function m1ImportInsert(actionId, sourcePath, requestedName, index) {
  const paths = m1Paths();
  const loaded = m1ReadDoc(paths, actionId);
  if (!loaded.ok) return loaded;
  // Re-normalize on insert (deterministic — same bytes) so the file that gets
  // written is exactly the validated one.
  const result = m1NormalizeForImport(paths, loaded.doc, String(sourcePath), requestedName);
  if (!result.ok) return result;
  fs.mkdirSync(path.dirname(result.targetAbs), { recursive: true });
  fs.writeFileSync(result.targetAbs, result.outcome.png);
  const insert = m1ActionOp(actionId, 'insert', { index, file: result.name, durationMs: null });
  if (!insert.ok) {
    try { fs.unlinkSync(result.targetAbs); } catch { /* keep the asset; the doc rejected it */ }
    return insert;
  }
  return { ...insert, file: result.name };
}

// ---- golden gallery ---------------------------------------------------------
//
// One run produces 7 deterministic artifacts under content/build/gallery/:
//   layout-<w>x<h>.png       the compiled flat layout through the REAL
//                            renderer at three window sizes
//   walk-<dir>-frames-<z>x.png  walk-left/right 5-frame strips at 1x/2x
//   geometry.json            the geometry report of THIS run
// and compares them against the PREVIOUS run (current/ → previous/):
// per-image pixel diff (+ red overlay maps) and a per-frame geometry diff,
// written to gallery/diff-report.json. The second run must be able to
// compare against the first — the first run simply records the baseline.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripWindowSize(zoom) {
  const frames = 5;
  return {
    width: STRIP_FRAME_PX * zoom * frames + STRIP_GAP_PX * (frames - 1) + STRIP_GAP_PX * 2,
    height: STRIP_FRAME_PX * zoom + STRIP_GAP_PX * 2 + 34,
  };
}

async function waitUntil(evaluate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate().catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// capturePage can transiently fail ("Current display surface not available")
// right after offscreen runs or occlusion changes — request a repaint and
// retry instead of failing the whole run.
async function capturePageWithRetry(webContents, label, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const image = await webContents.capturePage().catch(() => null);
    if (image && !image.isEmpty()) return image;
    if (typeof webContents.invalidate === 'function') webContents.invalidate();
    await sleep(400);
  }
  throw new Error(`empty capture: ${label}`);
}

function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

function diffGalleryDirs(previousDir, currentDir) {
  const names = fs.readdirSync(currentDir).filter((name) => name.endsWith('.png')).sort();
  const rows = [];
  const overlays = [];
  for (const name of names) {
    const current = libs.png.decodePngFile(path.join(currentDir, name));
    const previousPath = path.join(previousDir, name);
    if (!fs.existsSync(previousPath)) {
      rows.push({ image: name, baseline: false });
      continue;
    }
    const previous = libs.png.decodePngFile(previousPath);
    const diff = libs.png.diffImages(previous, current);
    if (!diff.comparable) {
      rows.push({ image: name, comparable: false, reason: diff.reason });
      continue;
    }
    rows.push({ image: name, comparable: true, changedPixels: diff.changedPixels, totalPixels: diff.totalPixels, diffRatio: Math.round(diff.diffRatio * 1000000) / 1000000, maxDelta: diff.maxDelta });
    overlays.push({ name, overlay: diff.overlay, width: diff.width, height: diff.height });
  }
  let geometry = null;
  const prevGeoPath = path.join(previousDir, 'geometry.json');
  const curGeoPath = path.join(currentDir, 'geometry.json');
  if (fs.existsSync(prevGeoPath) && fs.existsSync(curGeoPath)) {
    const prevGeo = JSON.parse(fs.readFileSync(prevGeoPath, 'utf8'));
    const curGeo = JSON.parse(fs.readFileSync(curGeoPath, 'utf8'));
    const prevByFile = new Map(prevGeo.rows.map((row) => [row.file, row]));
    geometry = {
      frames: curGeo.rows.map((row) => {
        const before = prevByFile.get(row.file);
        return {
          file: row.file,
          footLine: { before: before ? before.measured.footLine : null, after: row.measured.footLine },
          visibleHeight: { before: before ? before.measured.visibleHeight : null, after: row.measured.visibleHeight },
          changed: !!before && (before.measured.footLine !== row.measured.footLine || before.measured.visibleHeight !== row.measured.visibleHeight),
        };
      }),
      changedFrames: 0,
    };
    geometry.changedFrames = geometry.frames.filter((frame) => frame.changed).length;
  }
  return { rows, geometry, overlays };
}

async function generateGallery() {
  const galleryRoot = path.join(CONTENT_DIR, 'build', 'gallery');
  const staging = path.join(galleryRoot, `.staging-${process.pid}`);
  const current = path.join(galleryRoot, 'current');
  const previous = path.join(galleryRoot, 'previous');
  const baselineExisted = fs.existsSync(current);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let renderWindow = null;
  try {
    // 1) flat layout × 3 window sizes through the REAL office page (the
    // content layout is served read-only at the saved-layout route, so the
    // page compiles exactly the approved baseline).
    renderWindow = new BrowserWindow({
      width: GALLERY_SIZES[0][0],
      height: GALLERY_SIZES[0][1],
      useContentSize: true,
      // OFFSCREEN rendering: shown windows are clamped to the visible frame
      // by macOS (probed: a 1582×955 window collapses to the 1470×815
      // workarea), which would crop the golden shots. Offscreen captures are
      // exact at any size and keep WebGL compositing (rendererMode probed
      // 'webgl'), so the golden images stay true to the product renderer.
      show: false,
      title: 'Office Workbench · 金样渲染',
      webPreferences: {
        preload: path.join(REPO_ROOT, 'src', 'office', 'office-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    renderWindow.on('page-title-updated', (event) => event.preventDefault());
    await renderWindow.loadURL('office-runtime://local/office.html?pack=deepseek-default');
    await waitUntil(() => renderWindow.webContents.executeJavaScript('Boolean(window.__office && window.__office.ready)', true), 60000, 'gallery office page boot');
    const layoutSource = await renderWindow.webContents.executeJavaScript('window.__office.api.runtimeLayoutSource()', true);
    for (const [w, h] of GALLERY_SIZES) {
      renderWindow.setContentSize(w, h);
      await sleep(700); // letterbox + deferred resize pass settle
      const image = await capturePageWithRetry(renderWindow.webContents, `layout ${w}x${h}`);
      fs.writeFileSync(path.join(staging, `layout-${w}x${h}.png`), image.toPNG());
    }
    renderWindow.destroy();
    renderWindow = null;

    // 2) walk-left/right 5-frame strips ×2 zooms, composed by the workbench
    // strip page from the pack frames + the character.json foot line.
    for (const direction of ['left', 'right']) {
      for (const zoom of GALLERY_ZOOMS) {
        const { width, height } = stripWindowSize(zoom);
        const stripWindow = new BrowserWindow({
          width, height, useContentSize: true, show: false,
          title: 'Office Workbench · 金样渲染',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
        });
        stripWindow.on('page-title-updated', (event) => event.preventDefault());
        try {
          await stripWindow.loadURL(`workbench://local/gallery-strip.html?dir=${direction}&zoom=${zoom}`);
          await waitUntil(() => stripWindow.webContents.executeJavaScript(
            'Boolean(window.__stripReady === true && document.querySelectorAll("#strip img").length === 5 && document.querySelectorAll("#strip img[data-error]").length === 0)',
            true
          ), 30000, `strip ${direction} ${zoom}x`);
          const stripError = await stripWindow.webContents.executeJavaScript('window.__stripError || null', true);
          if (stripError) throw new Error(`strip data failed: ${stripError}`);
          await sleep(250);
          const image = await capturePageWithRetry(stripWindow.webContents, `strip ${direction} ${zoom}x`);
          fs.writeFileSync(path.join(staging, `walk-${direction}-frames-${zoom}x.png`), image.toPNG());
        } finally {
          stripWindow.destroy();
        }
      }
    }

    // 3) this run's geometry snapshot (the geometry diff source of truth)
    writeJson(path.join(staging, 'geometry.json'), walkGeometryReport());

    // 4) promote: current → previous, staging → current, then diff.
    if (baselineExisted) {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(current, previous);
    }
    fs.renameSync(staging, current);
    const diffResult = baselineExisted ? diffGalleryDirs(previous, current) : { rows: [], geometry: null, overlays: [] };
    const diff = { rows: diffResult.rows, geometry: diffResult.geometry };
    const report = {
      generatedAt: new Date().toISOString(),
      baselineExisted,
      layoutSource,
      sizes: GALLERY_SIZES.map(([w, h]) => `layout-${w}x${h}.png`),
      strips: GALLERY_ZOOMS.flatMap((zoom) => ['left', 'right'].map((direction) => `walk-${direction}-frames-${zoom}x.png`)),
      diff,
    };
    writeJson(path.join(galleryRoot, 'diff-report.json'), report);
    // diff overlays live OUTSIDE current/ so they never join the golden set
    const diffDir = path.join(galleryRoot, 'diff');
    fs.rmSync(diffDir, { recursive: true, force: true });
    if (baselineExisted) {
      fs.mkdirSync(diffDir, { recursive: true });
      for (const entry of diff.rows) {
        const overlay = diffResult.overlays.find((candidate) => candidate.name === entry.image);
        if (overlay) fs.writeFileSync(path.join(diffDir, entry.image), libs.png.encodePng(overlay.overlay, overlay.width, overlay.height));
      }
    }
    return { ok: true, baselineExisted, report };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, code: 'OFFICE_WORKBENCH_GALLERY_FAILED', message: String((error && error.message) || error) };
  } finally {
    if (renderWindow) renderWindow.destroy();
  }
}

// ---- boot -------------------------------------------------------------------

let mainWindow = null;
let lastSelectionJson = '';
let selectionTimer = null;

// The preview office page runs in a SAME-ORIGIN subframe of the shell
// (workbench://local/preview/office.html) — the workbench protocol serves it
// with the saved-layout route answered from the read-only content baseline.
function officeFrame() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return mainWindow.webContents.mainFrame.framesInSubtree.find((frame) => frame.url.includes('/preview/office.html')) || null;
  } catch {
    return null;
  }
}

async function pollPreviewSelection() {
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
}

async function runEvidenceMode() {
  const results = { mode: 'evidence', startedAt: new Date().toISOString(), repoHead: null };
  const note = (step, value) => {
    results[step] = value;
    try { writeJson(path.join(EVIDENCE_DIR, 'results.json'), results); } catch { /* best effort */ }
  };
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    note('userData', DATA_DIR);
    // preview ready + editor auto-opened + panel data settled
    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    await sleep(3500);
    const previewFrame = officeFrame();
    if (!previewFrame) throw new Error('preview frame not found');
    const previewState = await previewFrame.executeJavaScript(`JSON.stringify({
      ready: Boolean(window.__office && window.__office.ready),
      runtimeLayoutSource: window.__office.api.runtimeLayoutSource(),
      layoutSource: window.__office.api.layoutSource(),
      editorOpen: (() => { const el = document.getElementById('layout-editor'); return !!el && !el.hidden; })(),
      draftItems: window.__office.api.layoutDraft().items.length,
      rendererMode: window.__office.api.rendererMode(),
    })`, true);
    note('preview', JSON.parse(previewState));

    // geometry + validators (the same services the panel consumes)
    const geometry = walkGeometryReport();
    note('geometry', {
      totalFrames: geometry.totalFrames,
      redFrames: geometry.redFrames,
      tolerance: geometry.tolerance,
      medians: geometry.actions.map((action) => ({ id: action.id, medians: action.medians })),
      rows: geometry.rows.map((row) => ({ action: row.action, file: row.file, measured: row.measured, deviation: row.deviation, red: row.red })),
    });
    const assetRows = libs.assets.catalogAssetRows(REPO_ROOT);
    note('assets', { total: assetRows.length, ok: assetRows.filter((row) => row.ok).length, bad: assetRows.filter((row) => !row.ok).map((row) => row.id) });
    const publish = libs.content.validateContentTree({ repoRoot: REPO_ROOT, contentDir: CONTENT_DIR });
    note('publish', { ok: publish.ok, filesScanned: publish.filesScanned, violations: publish.violations });

    // screenshots: the SAME-ORIGIN preview iframe composites into the shell
    // frame, so ONE capture carries the three panes (taken BEFORE the
    // offscreen gallery runs, which can transiently starve the compositor).
    // The preview crop doubles as the preview-field shot.
    await sleep(1200);
    const shellImage = await capturePageWithRetry(mainWindow.webContents, 'workbench shell');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-shell.png'), shellImage.toPNG());
    const iframeRect = await mainWindow.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('preview-frame');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`, true);
    if (iframeRect && iframeRect.width > 10) {
      const shell = libs.png.decodePng(shellImage.toPNG());
      const scale = shell.width / mainWindow.getContentSize()[0];
      const px = {
        x: Math.round(iframeRect.x * scale),
        y: Math.round(iframeRect.y * scale),
        w: Math.round(iframeRect.width * scale),
        h: Math.round(iframeRect.height * scale),
      };
      if (px.w > 0 && px.h > 0 && px.x + px.w <= shell.width && px.y + px.h <= shell.height) {
        const crop = cropImage(shell, px.x, px.y, px.w, px.h);
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-preview.png'), libs.png.encodePng(crop.data, crop.width, crop.height));
      }
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-three-pane.png'), shellImage.toPNG());
    }

    // right-panel tab shot: the validator red/green table (+ a publish run
    // through the panel button so the result block is populated)
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-assets').click()");
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-publish').click()");
    await sleep(2500);
    const assetsImage = await capturePageWithRetry(mainWindow.webContents, 'workbench assets tab');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-assets.png'), assetsImage.toPNG());

    // two gallery runs driven through the REAL panel button (the user path —
    // the panel refreshes itself from the button's outcome):
    // run 1 lays the baseline, run 2 diffs against it.
    const readDiffReport = () => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'build', 'gallery', 'diff-report.json'), 'utf8'));
    const buttonReady = "!document.getElementById('btn-generate-gallery').disabled";
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-gallery').click()");
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-generate-gallery').click()");
    await waitUntil(() => mainWindow.webContents.executeJavaScript(buttonReady, true), 300000, 'gallery run 1 (panel button)');
    note('galleryRun1', readDiffReport());
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-generate-gallery').click()");
    await waitUntil(() => mainWindow.webContents.executeJavaScript(buttonReady, true), 300000, 'gallery run 2 (panel button)');
    note('galleryRun2', readDiffReport());

    // gallery tab now shows the updated diff report
    await sleep(600);
    const galleryImage = await capturePageWithRetry(mainWindow.webContents, 'workbench gallery tab');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-gallery.png'), galleryImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-geometry').click()");
    await sleep(300);

    // gallery artifacts copied into the evidence dir
    const galleryCurrent = path.join(CONTENT_DIR, 'build', 'gallery', 'current');
    if (fs.existsSync(galleryCurrent)) {
      fs.cpSync(galleryCurrent, path.join(EVIDENCE_DIR, 'gallery'), { recursive: true });
      const diffReport = path.join(CONTENT_DIR, 'build', 'gallery', 'diff-report.json');
      if (fs.existsSync(diffReport)) fs.copyFileSync(diffReport, path.join(EVIDENCE_DIR, 'gallery', 'diff-report.json'));
    }
    note('finishedAt', new Date().toISOString());
    console.log('OFFICE_WORKBENCH_EVIDENCE_OK');
    app.exit(0);
  } catch (error) {
    results.error = String((error && error.stack) || error);
    note('finishedAt', new Date().toISOString());
    console.error('OFFICE_WORKBENCH_EVIDENCE_FAILED', results.error);
    app.exit(1);
  }
}

// crop a rect out of an RGBA image (evidence preview crop)
function cropImage(image, x, y, w, h) {
  const out = libs.png.createImage(w, h, [24, 26, 30, 255]);
  for (let row = 0; row < h; row += 1) {
    const srcRow = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * w * 4, srcRow, srcRow + w * 4);
  }
  return out;
}

// ---- M1 evidence mode -------------------------------------------------------
//
// WORKBENCH_M1_EVIDENCE_DIR=<dir> (+ WORKBENCH_M1_PHASE=1|2) drives the REAL
// action panel through a full M1 verification sweep and exits:
//   phase 1 — timeline ops through the panel buttons, publish through the
//             panel button, before/after production pack snapshots;
//   phase 2 — persistence after a restart (the timeline must still show the
//             edited order), frame-stepped preview strips through the REAL
//             renderer, then the revert + re-publish (byte-identical restore)
//             and the backup-rollback verification.
// Probe discipline: temp userData is set by the launcher, results go to
// files, failures throw into the catch → console.error + app.exit(1); no
// assert inside the probe.

function m1Click(selector) {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    el.click();
    return 'ok';
  })()`, true);
}

async function m1WaitFor(expression, timeoutMs, label) {
  await waitUntil(async () => mainWindow.webContents.executeJavaScript(expression, true).catch(() => false), timeoutMs, label);
}

async function m1TimelineState() {
  return JSON.parse(await mainWindow.webContents.executeJavaScript(`JSON.stringify({
    action: document.getElementById('action-select') ? document.getElementById('action-select').value : null,
    files: [...document.querySelectorAll('.action-frame')].map((card) => card.dataset.file),
    loop: document.getElementById('action-loop') ? document.getElementById('action-loop').checked : null,
    summary: document.getElementById('action-summary') ? document.getElementById('action-summary').textContent : '',
  })`, true));
}

async function m1Screenshot(webContents, dir, name) {
  const image = await capturePageWithRetry(webContents, name);
  fs.writeFileSync(path.join(dir, name), image.toPNG());
  return image;
}

// Split a canonical animations.json into top-level entry blocks (indent-4
// `"id": {` … closing line) — the "其余动作逐字不动" check works on raw text.
function m1AnimationEntryBlocks(text) {
  const blocks = new Map();
  const lines = text.split('\n');
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const start = /^    "([^"]+)": \{/.exec(line);
    if (start && current === null) {
      current = start[1];
      buffer = [line];
      continue;
    }
    if (current !== null) {
      buffer.push(line);
      if (line === '    },' || line === '    }') {
        blocks.set(current, buffer.join('\n'));
        current = null;
      }
    }
  }
  return blocks;
}

function m1PreviewRect() {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('preview-frame');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`, true);
}

// The office STAGE canvas rect in SHELL coordinates (iframe rect + the
// canvas rect inside the same-origin office page) — the strip evidence crops
// exactly the rendered scene, not the surrounding panels.
async function m1StageRect() {
  const iframe = await m1PreviewRect();
  if (!iframe) return null;
  const inner = await officeFrame().executeJavaScript(`(() => {
    const canvas = document.querySelector('#stage-host canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`, true).catch(() => null);
  if (!inner) return iframe;
  return { x: iframe.x + inner.x, y: iframe.y + inner.y, width: inner.width, height: inner.height };
}

// Hide the in-preview layout editor so the stage fills the preview (the strip
// shows the scene, not the editor panels). Idempotent.
async function m1HidePreviewEditor() {
  const frame = officeFrame();
  if (!frame) return;
  await frame.executeJavaScript(`(() => {
    const el = document.getElementById('layout-editor');
    const api = window.__office && window.__office.api;
    if (el && !el.hidden && api && api.toggleLayoutEditor) { api.toggleLayoutEditor(); return 'hidden'; }
    return 'already';
  })()`, true).catch(() => null);
}

async function m1PreviewStrip(dir, name, steps) {
  const rect = await m1StageRect();
  const shellSize = mainWindow.getContentSize();
  const frames = [];
  for (const image of steps) {
    const shell = libs.png.decodePng(image.toPNG());
    const scale = shell.width / shellSize[0];
    const px = {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      w: Math.round(rect.width * scale),
      h: Math.round(rect.height * scale),
    };
    frames.push(cropImage(shell, px.x, px.y, px.w, px.h));
  }
  const gap = 8;
  const strip = libs.png.createImage(frames.reduce((sum, frame) => sum + frame.width + gap, gap), Math.max(...frames.map((frame) => frame.height)) + gap * 2, [24, 26, 30, 255]);
  let cursorX = gap;
  for (const frame of frames) {
    libs.png.blit(strip, frame, cursorX, gap);
    cursorX += frame.width + gap;
  }
  fs.writeFileSync(path.join(dir, name), libs.png.encodePng(strip.data, strip.width, strip.height));
}

async function runM1EvidenceMode() {
  const dir = M1_EVIDENCE_DIR;
  const phase = M1_EVIDENCE_PHASE;
  const results = { mode: 'm1-evidence', phase, startedAt: new Date().toISOString(), userData: DATA_DIR };
  const note = (step, value) => {
    results[step] = value;
    try { writeJson(path.join(dir, `results-phase${phase}.json`), results); } catch { /* best effort */ }
  };
  const animationsPath = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'animation', 'animations.json');
  const anchorsPath = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'animation', 'anchors.json');
  const copyProduction = (sub) => {
    const out = path.join(dir, sub);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(animationsPath, path.join(out, 'animations.json'));
    fs.copyFileSync(anchorsPath, path.join(out, 'anchors.json'));
    return out;
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    await sleep(3000);
    await m1WaitFor(`document.getElementById('tab-actions') !== null`, 15000, 'actions tab');
    await m1Click('#tab-actions');
    await m1WaitFor(`document.querySelectorAll('.action-frame').length > 0`, 20000, 'action timeline render');
    await sleep(1200);

    if (phase === 1) {
      // 1) timeline before/after through the REAL panel buttons
      const before = await m1TimelineState();
      note('timelineBefore', before);
      await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-before.png');
      // move the passing frame (index 2) up one — the exact op of the M1 story
      await m1Click('.action-frame[data-index="2"] .action-frame-ops button:nth-child(1)');
      await sleep(1200);
      const after = await m1TimelineState();
      note('timelineAfter', after);
      if (JSON.stringify(after.files) === JSON.stringify(before.files)) throw new Error('timeline reorder did not change the card order');
      await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-after.png');

      // 2) publish through the panel button; capture production before/after
      const beforeDir = copyProduction('production-before');
      note('productionBeforeDir', beforeDir);
      await m1Click('#btn-action-publish');
      await m1WaitFor(`/已发布|无变更|被拒绝/.test(document.getElementById('action-publish-result').textContent)`, 60000, 'publish completion');
      await sleep(800);
      const publishText = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-publish-result').textContent`, true);
      note('publishResult', publishText);
      if (!publishText.includes('已发布')) throw new Error(`publish did not succeed: ${publishText}`);
      const afterDir = copyProduction('production-after');
      note('productionAfterDir', afterDir);

      // 3) diff proof: ONLY the target action entry changed
      const beforeText = fs.readFileSync(animationsPath, 'utf8');
      const beforeBlocks = m1AnimationEntryBlocks(fs.readFileSync(path.join(beforeDir, 'animations.json'), 'utf8'));
      const afterBlocks = m1AnimationEntryBlocks(beforeText);
      const changedIds = [...afterBlocks.keys()].filter((id) => beforeBlocks.get(id) !== afterBlocks.get(id));
      const missingIds = [...beforeBlocks.keys()].filter((id) => !afterBlocks.has(id));
      note('animationsDiff', { changedIds, missingIds, expectedOnly: ['walk-left'] });
      if (JSON.stringify(changedIds) !== JSON.stringify(['walk-left']) || missingIds.length > 0) {
        throw new Error(`unexpected animations.json changes: ${JSON.stringify({ changedIds, missingIds })}`);
      }
      const beforeAnchors = JSON.parse(fs.readFileSync(path.join(beforeDir, 'anchors.json'), 'utf8'));
      const afterAnchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
      const declared = JSON.parse(beforeText).animations['walk-left'].frames.map((frame) => frame.file);
      const leftKeys = Object.keys(afterAnchors.frames).filter((file) => file.includes('/walk/left/'));
      note('anchorsOrder', { leftKeys, declared, match: JSON.stringify(leftKeys) === JSON.stringify(declared) });
      if (JSON.stringify(leftKeys) !== JSON.stringify(declared)) throw new Error('anchors key order does not follow the new metadata order');

      // 4) backups + provenance on disk
      const backupsRoot = path.join(CONTENT_DIR, 'build', 'backups');
      const backupDirs = fs.readdirSync(backupsRoot).sort();
      const provenanceDir = path.join(CONTENT_DIR, 'characters', 'whale-girl', 'provenance');
      const provenanceFiles = fs.readdirSync(provenanceDir).filter((name) => name.endsWith('.json')).sort();
      note('backups', { dirs: backupDirs, provenanceFiles });
      if (backupDirs.length === 0 || provenanceFiles.length === 0) throw new Error('publish did not record backup/provenance');
      const latestBackup = path.join(backupsRoot, backupDirs[backupDirs.length - 1]);
      const backupAnimations = fs.readFileSync(path.join(latestBackup, 'animations.json'));
      const preAnimations = fs.readFileSync(path.join(beforeDir, 'animations.json'));
      note('backupMatchesPrePublish', backupAnimations.equals(preAnimations));
      if (!backupAnimations.equals(preAnimations)) throw new Error('the backup is not the pre-publish bytes');
      const provenance = JSON.parse(fs.readFileSync(path.join(provenanceDir, provenanceFiles[provenanceFiles.length - 1]), 'utf8'));
      note('provenanceEntry', provenance);

      await m1Screenshot(mainWindow.webContents, dir, 'm1-publish-result.png');
      note('finishedAt', new Date().toISOString());
      console.log('OFFICE_WORKBENCH_M1_EVIDENCE_OK');
      app.exit(0);
      return;
    }

    // ---- phase 2: persistence + preview playback + revert + rollback proof --
    const phase1 = JSON.parse(fs.readFileSync(path.join(dir, 'results-phase1.json'), 'utf8'));
    const persisted = await m1TimelineState();
    const match = JSON.stringify(persisted.files) === JSON.stringify(phase1.timelineAfter.files);
    note('persistenceCheck', { expected: phase1.timelineAfter.files, actual: persisted.files, match });
    if (!match) throw new Error('the edited sequence did not survive the workbench restart');
    await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-after-restart.png');

    // the strips show the SCENE: hide the in-preview layout editor
    await m1HidePreviewEditor();
    await sleep(800);

    // frame-stepped preview strips through the REAL renderer (staged draft pack).
    // The FIRST step click stages the draft pack and reloads the preview iframe
    // (which auto-reopens the layout editor via ?editor=1) — hide the editor
    // only AFTER that reload so the strip shows the scene itself.
    async function stripFor(action, name) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        const select = document.getElementById('action-select');
        select.value = ${JSON.stringify(action)};
        select.dispatchEvent(new Event('change'));
        return select.value;
      })()`, true);
      await sleep(1500);
      const steps = [];
      for (let index = 0; index < 5; index += 1) {
        await m1Click('#btn-action-step');
        await sleep(900); // staging + (first) staged reload + snapshot push settle
        if (index === 0) {
          await m1HidePreviewEditor();
          await sleep(600);
        }
        steps.push(await capturePageWithRetry(mainWindow.webContents, `${name} step ${index + 1}`));
      }
      await m1PreviewStrip(dir, name, steps);
      const playbackText = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-playback').textContent`, true);
      const stageRect = await m1StageRect();
      note(`strip_${action}`, { playback: playbackText, stageRect, frames: steps.length });
      await m1Click('#btn-action-stop');
      await sleep(400);
    }
    await stripFor('walk-left', 'm1-preview-play-walk-left.png');

    // live playback shot (the clock-driven path)
    await m1Click('#btn-action-play');
    await sleep(1600);
    await m1Screenshot(mainWindow.webContents, dir, 'm1-preview-playing.png');
    await m1Click('#btn-action-stop');
    await sleep(400);

    await stripFor('walk-right', 'm1-preview-play-walk-right.png');

    // revert through the panel — idempotent: only when the edited order is live
    await mainWindow.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('action-select');
      select.value = 'walk-left';
      select.dispatchEvent(new Event('change'));
      return select.value;
    })()`, true);
    await sleep(1200);
    const beforeRevert = await m1TimelineState();
    let revertedNow = JSON.stringify(beforeRevert.files) === JSON.stringify(phase1.timelineAfter.files);
    if (revertedNow) {
      await m1Click('.action-frame[data-index="1"] .action-frame-ops button:nth-child(2)');
      await sleep(1200);
    }
    const reverted = await m1TimelineState();
    note('timelineReverted', { files: reverted.files, revertedNow });
    if (JSON.stringify(reverted.files) !== JSON.stringify(phase1.timelineBefore.files)) {
      throw new Error(`revert did not restore the original order: ${JSON.stringify(reverted.files)}`);
    }

    // re-publish → the production pack must be byte-identical to the ORIGINAL
    let revertPublishResult = 'skipped — the draft already matches the original order';
    if (revertedNow) {
      await m1Click('#btn-action-publish');
      await m1WaitFor(`/已发布|无变更|被拒绝/.test(document.getElementById('action-publish-result').textContent)`, 60000, 'revert publish completion');
      await sleep(800);
      revertPublishResult = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-publish-result').textContent`, true);
      if (!revertPublishResult.includes('已发布')) throw new Error(`revert publish did not succeed: ${revertPublishResult}`);
    }
    note('revertPublishResult', revertPublishResult);
    const restoredAnimations = fs.readFileSync(animationsPath);
    const originalAnimations = fs.readFileSync(path.join(dir, 'production-before', 'animations.json'));
    const restoredAnchors = fs.readFileSync(anchorsPath);
    const originalAnchors = fs.readFileSync(path.join(dir, 'production-before', 'anchors.json'));
    note('rollbackVerification', {
      animationsByteIdentical: restoredAnimations.equals(originalAnimations),
      anchorsByteIdentical: restoredAnchors.equals(originalAnchors),
    });
    if (!restoredAnimations.equals(originalAnimations) || !restoredAnchors.equals(originalAnchors)) {
      throw new Error('the re-publish did not restore the original production bytes');
    }
    // the FIRST backup still holds the original bytes — the manual rollback path
    const backupsRoot = path.join(CONTENT_DIR, 'build', 'backups');
    const backupDirs = fs.readdirSync(backupsRoot).sort();
    const firstBackupAnimations = fs.readFileSync(path.join(backupsRoot, backupDirs[0], 'animations.json'));
    note('backups', { dirs: backupDirs, firstBackupHoldsOriginalBytes: firstBackupAnimations.equals(originalAnimations) });
    if (!firstBackupAnimations.equals(originalAnimations)) throw new Error('the first backup does not hold the original bytes');

    await m1Screenshot(mainWindow.webContents, dir, 'm1-final-state.png');
    note('finishedAt', new Date().toISOString());
    console.log('OFFICE_WORKBENCH_M1_EVIDENCE_OK');
    app.exit(0);
  } catch (error) {
    results.error = String((error && error.stack) || error);
    note('finishedAt', new Date().toISOString());
    console.error('OFFICE_WORKBENCH_M1_EVIDENCE_FAILED', results.error);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  try {
    const { createOfficeProtocolHandler } = require(path.join(REPO_ROOT, 'src', 'office', 'office-protocol.js'));
    protocol.handle('office-runtime', createOfficeProtocolHandler({
      officeRoot: path.join(REPO_ROOT, 'src', 'office'),
      nodeModulesRoot: path.join(REPO_ROOT, 'node_modules'),
      officeAssetsRoot: path.join(REPO_ROOT, 'resources', 'office'),
      charactersRoot: path.join(REPO_ROOT, 'resources', 'characters'),
      layoutStore: createContentLayoutStore(),
    }));
    protocol.handle('workbench', createWorkbenchProtocolHandler());

    // office:* IPC: the same minimal stub set as the standalone editor —
    // the page boots from an empty snapshot and drafts locally. The seven
    // channel names/semantics stay exactly the whitelisted ones.
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
      ipcMain.handle(channel, () => ({ ok: false, code: 'OFFICE_WORKBENCH_STUB' }));
    }

    // ---- workbench renderer IPC ----
    ipcMain.handle('workbench:content-tree', () => listContentTree());
    ipcMain.handle('workbench:geometry-report', () => walkGeometryReport());
    ipcMain.handle('workbench:asset-report', () => libs.assets.catalogAssetRows(REPO_ROOT));
    ipcMain.handle('workbench:entry-geometry', (_event, assetId) => entryGeometryForAsset(String(assetId)));
    ipcMain.handle('workbench:file-geometry', (_event, relPath) => {
      const clean = String(relPath).replace(/\\/g, '/');
      const abs = path.resolve(CONTENT_DIR, clean);
      if (!abs.startsWith(CONTENT_DIR + path.sep)) return { ok: false, code: 'PATH_ESCAPES_CONTENT' };
      if (clean.endsWith('.png')) return { ok: true, file: clean, geometry: libs.geometry.measureEntry({ absPath: abs }) };
      if (clean.endsWith('.json')) {
        try {
          const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
          return { ok: true, file: clean, json: { schemaVersion: parsed.schemaVersion ?? null, keys: Object.keys(parsed) } };
        } catch (error) {
          return { ok: false, code: 'JSON_UNPARSEABLE', message: error.message };
        }
      }
      return { ok: true, file: clean, text: true };
    });
    ipcMain.handle('workbench:publish', () => libs.content.validateContentTree({ repoRoot: REPO_ROOT, contentDir: CONTENT_DIR }));
    ipcMain.handle('workbench:gallery-status', () => {
      const galleryRoot = path.join(CONTENT_DIR, 'build', 'gallery');
      const status = { galleryRoot, hasCurrent: fs.existsSync(path.join(galleryRoot, 'current')), hasPrevious: fs.existsSync(path.join(galleryRoot, 'previous')), diffReport: null };
      const diffPath = path.join(galleryRoot, 'diff-report.json');
      if (fs.existsSync(diffPath)) status.diffReport = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
      return status;
    });
    ipcMain.on('workbench:report-preview-rect', () => { /* deprecated no-op: the preview is a same-origin iframe now */ });
    ipcMain.handle('workbench:generate-gallery', async (event) => {
      const windowWebContents = mainWindow ? mainWindow.webContents : null;
      const progress = (step) => {
        if (windowWebContents && !windowWebContents.isDestroyed() && event.sender === windowWebContents) {
          windowWebContents.send('workbench:gallery-progress', { step });
        }
      };
      progress('rendering');
      const outcome = await generateGallery();
      progress(outcome.ok ? 'done' : 'failed');
      return outcome;
    });

    // ---- M1 action editor IPC ----
    ipcMain.handle('workbench:action-list', () => m1ActionList());
    ipcMain.handle('workbench:action-read', (_event, actionId) => m1PanelRead(String(actionId)));
    ipcMain.handle('workbench:action-op', (_event, actionId, op, payload) => {
      try {
        return m1ActionOp(String(actionId), String(op), payload || {});
      } catch (error) {
        return { ok: false, code: 'ACTION_OP_FAILED', message: String((error && error.message) || error) };
      }
    });
    ipcMain.handle('workbench:action-new', (_event, id, direction) => m1ActionNew(id, direction));
    ipcMain.handle('workbench:action-import-preview', (_event, actionId, sourcePath, name) => {
      try {
        return m1ImportPreview(String(actionId), String(sourcePath), typeof name === 'string' ? name : '');
      } catch (error) {
        return { ok: false, violations: [{ file: String(sourcePath), check: 'import.failed', detail: String((error && error.message) || error) }] };
      }
    });
    ipcMain.handle('workbench:action-import-insert', (_event, actionId, sourcePath, name, index) => {
      try {
        return m1ImportInsert(String(actionId), String(sourcePath), String(name), Number.isInteger(index) ? index : null);
      } catch (error) {
        return { ok: false, violations: [{ file: String(sourcePath), check: 'import.failed', detail: String((error && error.message) || error) }] };
      }
    });
    ipcMain.handle('workbench:action-stage', (_event, actionId) => {
      try {
        return libs.publisher.stagePreviewPack({ contentDir: CONTENT_DIR, charactersRoot: CHARACTERS_ROOT, actionId: String(actionId) });
      } catch (error) {
        return { ok: false, violations: [{ file: `actions/${actionId}.json`, check: 'stage.failed', detail: String((error && error.message) || error) }] };
      }
    });
    ipcMain.handle('workbench:action-publish', (_event, actionId) => {
      try {
        return libs.publisher.publishAction({ contentDir: CONTENT_DIR, charactersRoot: CHARACTERS_ROOT, actionId: String(actionId) });
      } catch (error) {
        return { ok: false, violations: [{ file: `actions/${actionId}.json`, check: 'publish.failed', detail: String((error && error.message) || error) }] };
      }
    });

    // ---- main window (three panes; the center hosts the preview iframe) ----
    // sandbox: false + nodeIntegrationInSubFrames: true is what lets the
    // tool-served preview subframe receive the REAL office bridge (this
    // preload requires src/office/office-preload.js verbatim). The window
    // only ever loads repo-local content under the two repo schemes.
    mainWindow = new BrowserWindow({
      width: 1582,
      height: 955,
      useContentSize: true,
      // evidence/probe runs mark the window per the probe discipline (临时数据,
      // 可关闭); the interactive tool keeps its 'Office Workbench' title —
      // the three title vocabularies stay distinguishable (M0 §2).
      title: EVIDENCE_DIR || M1_EVIDENCE_DIR ? 'PROBE 临时数据（可关闭）' : 'Office Workbench',
      show: true,
      webPreferences: {
        preload: path.join(REPO_ROOT, 'src', 'workbench', 'workbench-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    mainWindow.on('page-title-updated', (event) => event.preventDefault());
    mainWindow.on('closed', () => {
      mainWindow = null;
      if (selectionTimer) clearInterval(selectionTimer);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => fail('OFFICE_WORKBENCH_PAGE_LOAD_FAILED', `${code} ${description}`));
    await mainWindow.loadURL('workbench://local/workbench.html');

    selectionTimer = setInterval(pollPreviewSelection, 1000);

    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    console.log('OFFICE_WORKBENCH_READY');
    if (EVIDENCE_DIR) {
      // give the renderer's first report fetch + editor auto-open a beat
      setTimeout(() => runEvidenceMode(), 1500);
    } else if (M1_EVIDENCE_DIR) {
      // M1 evidence sweep (WORKBENCH_M1_PHASE=1 edit+publish, 2 persist+play+revert)
      setTimeout(() => runM1EvidenceMode(), 1500);
    }
  } catch (error) {
    return fail('OFFICE_WORKBENCH_BOOT_ERROR', error && error.message);
  }
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (error) => fail('OFFICE_WORKBENCH_UNCAUGHT', error && error.message));
