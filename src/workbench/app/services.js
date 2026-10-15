'use strict';

// src/workbench/app/services.js — the tool service layer, shared by every
// workbench entry point (scripts/office-workbench.js = `npm run office:workbench`
// and studio/main.js = `npm run studio`).
//
// This module is PURE Node (fs/path only, no electron): every panel op, report
// and publish call the renderer makes is implemented here once, so the two
// entry points can never drift. Electron-specific concerns (protocol
// registration, windows, ready tokens) live in ./boot.js; the golden gallery
// renders through real BrowserWindows and lives in ./gallery.js.
//
// Boundaries (docs/notes/office-workbench-m0.md §3, office-workbench-design.md §3):
// - content/** is the authoring tree; the tool writes only content/build/** and
//   content/characters/** through the publish kernel.
// - content/scenes/flat/layout.json is read-only for the preview (the
//   saved-layout route answers the approved baseline and refuses writes).
// - The product runtime is imported read-only; the product never imports this.

const path = require('node:path');
const fs = require('node:fs');

const MIME_TABLE = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const DEFAULT_CHARACTER_ID = 'whale-girl';

// ---- read-only content layout store ----------------------------------------
//
// The office page fetches ./office-layout.v1.json for its "saved layout" boot
// source. Inside the tool that route answers with the APPROVED baseline
// content/scenes/flat/layout.json — read-only: a 保存布局 PUT (the office
// editor's production-save path) answers a stable failure so the baseline can
// never be written back from the preview, and DELETE (恢复默认) is a no-op
// that keeps the baseline.

// The draft pack the action editor boots from: a separate id, so staging a draft can
// never change what the runtime frame reads (see the staged-pack block in the handler).
const STAGED_PACK_ID = 'wb-staged';

function createContentLayoutStore({ contentDir }) {
  return {
    loadSavedLayout() {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(contentDir, 'scenes', 'flat', 'layout.json'), 'utf8'));
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

// ---- the tool:// protocol handler (shell pages + read-only mounts) ----------
//
// One scheme serves both the shell's own pages and the preview copy of the
// product office page (SAME ORIGIN, so the shell can reach into the frame).
// The office page's CSP origin reference is rewritten for the tool-served
// copy only; the product file stays byte-identical.

function createWorkbenchProtocolHandler(ctx) {
  const { repoRoot, contentDir, sourcePackDir, libs, scheme, workbenchRoot } = ctx;
  const mounts = [
    // the PREVIEW iframe is a tool-served copy of the product office page on
    // the SAME origin as the shell (same renderer process → the composition
    // actually paints/captures everywhere, unlike an out-of-line child view):
    // its relative URLs resolve through these preview/ mounts, and the saved
    // layout route answers with the read-only content baseline.
    { prefix: 'preview/node_modules/', root: path.join(repoRoot, 'node_modules') },
    { prefix: 'preview/office-assets/', root: path.join(repoRoot, 'resources', 'office') },
    { prefix: 'preview/characters/', root: path.join(repoRoot, 'resources', 'characters') },
    { prefix: 'preview/', root: path.join(repoRoot, 'src', 'office'), rewriteOfficeCsp: true },
    { prefix: 'content/', root: contentDir },
    { prefix: 'pack/', root: sourcePackDir },
    { prefix: '', root: workbenchRoot },
  ];
  return (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // the office page's saved-layout route, served READ-ONLY from the
    // content baseline (see createContentLayoutStore above)
    if (rel === 'preview/office-layout.v1.json') {
      const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
      const store = createContentLayoutStore({ contentDir });
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
    // STAGED DRAFT PACK — preview-only, production bytes untouched.
    //
    // The action editor stages the EDITED play order into
    // content/build/preview-pack/{animations,anchors}.json and boots its own frame from
    // `?pack=wb-staged`, so the draft is reachable at preview/characters/wb-staged/**.
    // Frames that only exist as content assets (imported, not yet published) come from
    // content/characters/<id>/assets/; anything else falls through to the production pack.
    //
    // Why a separate pack id instead of the old global overlay: the overlay used to
    // replace the PRODUCTION pack files for every reader, so a draft played in the action
    // editor leaked into the runtime view on its next load. Two frames, two pack ids, no
    // leak — the runtime frame always reads resources/characters/<pack>/** verbatim.
    if (rel.startsWith('preview/characters/')) {
      const stagedPrefix = `preview/characters/${STAGED_PACK_ID}/`;
      const packPrefix = `preview/characters/${libs.publisher.PACK_ID}/`;
      const stagedRequest = rel.startsWith(stagedPrefix);
      if (stagedRequest || rel.startsWith(packPrefix)) {
        const packRel = rel.slice((stagedRequest ? stagedPrefix : packPrefix).length);
        const safePackRel = packRel.replace(/\\/g, '/');
        if (!safePackRel.split('/').includes('..')) {
          if (stagedRequest) {
            const stagedNames = ['animation/animations.json', 'animation/anchors.json'];
            if (stagedNames.includes(safePackRel)) {
              const staged = path.join(contentDir, 'build', 'preview-pack', path.basename(safePackRel));
              if (fs.existsSync(staged)) {
                return new Response(fs.readFileSync(staged), {
                  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
                });
              }
            }
            // an imported frame lives in the content tree until it is published
            const contentAsset = path.join(contentDir, 'characters', ctx.characterId, 'assets', safePackRel);
            if (fs.existsSync(contentAsset)) {
              return new Response(fs.readFileSync(contentAsset), {
                headers: { 'content-type': MIME_TABLE[path.extname(contentAsset).toLowerCase()] || 'image/png', 'cache-control': 'no-store' },
              });
            }
            // nothing staged under that name: fall through to the production pack, so a
            // half-staged draft still boots instead of showing broken frames
            const fallback = path.join(repoRoot, 'resources', 'characters', libs.publisher.PACK_ID, safePackRel);
            if (!fs.existsSync(fallback)) return new Response('not found', { status: 404 });
          }
          const packAbs = path.join(repoRoot, 'resources', 'characters', libs.publisher.PACK_ID, safePackRel);
          if (!fs.existsSync(packAbs)) {
            const contentAsset = path.join(contentDir, 'characters', ctx.characterId, 'assets', safePackRel);
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
      // The tool-served preview copy runs on the tool scheme, so the CSP
      // scheme reference is rewritten for THIS COPY ONLY — the product file
      // and every product entry point stay byte-identical.
      if (mount.rewriteOfficeCsp && abs.endsWith('.html')) {
        body = Buffer.from(body.toString('utf8').replaceAll('office-runtime://local', `${scheme}://local`), 'utf8');
      }
      const headers = { 'content-type': MIME_TABLE[path.extname(abs).toLowerCase()] || 'application/octet-stream' };
      if (!mount.rewriteOfficeCsp) {
        // The shell pages are the tool's own surface; scripts load from this
        // scheme only, frames embed the same-origin preview copy.
        headers['content-security-policy'] = `default-src 'none'; script-src ${scheme}:; style-src ${scheme}: 'unsafe-inline'; img-src ${scheme}: data:; connect-src ${scheme}:; frame-src ${scheme}:; font-src 'none'`;
      }
      return new Response(body, { headers });
    }
    return new Response('not found', { status: 404 });
  };
}

// ---- geometry / report services (shared by panel, gallery and evidence) ----

function characterJsonPath(ctx, characterId = ctx.characterId) {
  return path.join(ctx.contentDir, 'characters', characterId, 'character.json');
}

function readCharacterJson(ctx, characterId = ctx.characterId) {
  return JSON.parse(fs.readFileSync(characterJsonPath(ctx, characterId), 'utf8'));
}

function resolveFramePath(ctx, character, frame) {
  // M0: frame bytes resolve against the provenance source pack (D4).
  const packRoot = character.provenance && character.provenance.sourcePack
    ? path.join(ctx.repoRoot, character.provenance.sourcePack)
    : path.dirname(path.dirname(characterJsonPath(ctx)));
  return path.join(packRoot, frame.file);
}

function walkGeometryReport(ctx) {
  const character = readCharacterJson(ctx);
  return ctx.libs.geometry.buildWalkGeometryReport({
    character,
    resolveFramePath: (ch, frame) => resolveFramePath(ctx, ch, frame),
  });
}

function catalogEntryById(ctx, assetId) {
  const { LAYOUT_ASSETS } = require(path.join(ctx.repoRoot, 'src', 'office', 'layout-assets.js'));
  return LAYOUT_ASSETS.find((asset) => asset.id === assetId) || null;
}

function entryGeometryForAsset(ctx, assetId) {
  const asset = catalogEntryById(ctx, assetId);
  if (!asset) return { ok: false, code: 'ASSET_UNKNOWN' };
  const abs = ctx.libs.assets.resolveCatalogAssetPath(ctx.repoRoot, asset.src);
  return {
    ok: true,
    asset: { id: asset.id, kind: asset.kind, label: asset.label, src: asset.src, direction: asset.direction, anchor: asset.anchor, contentBbox: asset.contentBbox || null },
    geometry: ctx.libs.geometry.measureEntry({ absPath: abs, anchor: asset.anchor, contentBbox: asset.contentBbox || null }),
  };
}

function listContentTree(ctx) {
  const walk = (dir, rel) => {
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries = [];
    for (const item of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === 'build') continue; // tool-owned output, not content source
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
  return walk(ctx.contentDir, '');
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

function m1Paths(ctx) {
  // The publish kernel is pack-id keyed and currently pinned to the whale-girl
  // character project (content/characters/whale-girl). Multi-character projects
  // arrive with the P1 project model, which threads the character id through
  // createPaths instead of patching the shape here.
  return ctx.libs.publisher.createPaths({ contentDir: ctx.contentDir, charactersRoot: ctx.charactersRoot });
}

function readPackAnimationDefaults(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(characterJsonPath(ctx), 'utf8'));
    return {
      packCanvas: parsed.pack && parsed.pack.canvas ? parsed.pack.canvas : 352,
      packAnchor: parsed.pack && parsed.pack.anchor ? parsed.pack.anchor : { x: 178, y: 296 },
      packFootLine: parsed.pack && parsed.pack.footLine ? parsed.pack.footLine : 296,
    };
  } catch {
    return { packCanvas: 352, packAnchor: { x: 178, y: 296 }, packFootLine: 296 };
  }
}

function m1FrameUrl(ctx, paths, file) {
  const contentAsset = path.join(paths.assetsDir, file);
  return fs.existsSync(contentAsset)
    ? `${ctx.scheme}://local/content/characters/${ctx.characterId}/assets/${file}`
    : `${ctx.scheme}://local/pack/${file}`;
}

function m1ReadDoc(ctx, paths, actionId) {
  const abs = path.join(paths.actionsDir, `${actionId}.json`);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    return { ok: false, code: 'ACTION_DOC_MISSING', message: `actions/${actionId}.json missing or unparseable (${error.message})` };
  }
  const parsed = ctx.libs.model.parseActionDoc(raw);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  return { ok: true, doc: parsed.action, abs };
}

function m1PanelRead(ctx, actionId) {
  const paths = m1Paths(ctx);
  const loaded = m1ReadDoc(ctx, paths, actionId);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const validation = ctx.libs.publisher.validateForPublish(paths, doc).validation;
  const packAnimations = readJsonIfExists(paths.animationsPath);
  const defaults = readPackAnimationDefaults(ctx);
  return {
    ok: true,
    doc,
    frames: doc.frames.map((frame, index) => ({
      index,
      file: frame.file,
      basename: frame.file.split('/').pop(),
      url: m1FrameUrl(ctx, paths, frame.file),
      durationMs: frame.durationMs === undefined ? null : frame.durationMs,
    })),
    validation,
    defaults: {
      ...defaults,
      footLine: doc.geometry && Number.isInteger(doc.geometry.footLine) ? doc.geometry.footLine : defaults.packFootLine,
      direction: doc.direction,
      defaultFrameDurationMs: packAnimations.exists && packAnimations.value && typeof packAnimations.value.defaultFrameDurationMs === 'number'
        ? packAnimations.value.defaultFrameDurationMs
        : ctx.libs.model.DEFAULT_FRAME_DURATION_MS,
    },
  };
}

function m1ActionList(ctx) {
  const paths = m1Paths(ctx);
  let names = [];
  try {
    names = fs.readdirSync(paths.actionsDir).filter((name) => name.endsWith('.json'));
  } catch {
    names = [];
  }
  const actions = [];
  for (const name of names.sort()) {
    const loaded = m1ReadDoc(ctx, paths, name.slice(0, -'.json'.length));
    if (loaded.ok) {
      actions.push({ id: loaded.doc.id, frames: loaded.doc.frames.map((frame) => frame.file), loop: loaded.doc.loop, direction: loaded.doc.direction });
    }
  }
  return { actions };
}

function m1ActionOp(ctx, actionId, op, payload) {
  const paths = m1Paths(ctx);
  const loaded = m1ReadDoc(ctx, paths, actionId);
  if (!loaded.ok) return loaded;
  const doc = loaded.doc;
  const model = ctx.libs.model;
  let outcome;
  try {
    switch (op) {
      case 'move': outcome = model.moveFrame(doc, Number(payload.from), Number(payload.to)); break;
      case 'insert': outcome = model.insertFrame(doc, payload.index, String(payload.file), payload.durationMs === undefined ? null : payload.durationMs); break;
      case 'remove': outcome = model.removeFrame(doc, Number(payload.index)); break;
      case 'duration': outcome = model.setFrameDuration(doc, Number(payload.index), payload.value === undefined ? null : payload.value); break;
      case 'loop': outcome = model.setLoop(doc, Boolean(payload.value)); break;
      // gap #1 (undo/redo): put a WHOLE-DOCUMENT snapshot back. This is the replay
      // half of the history stack — an action edit autosaves, so undoing one is a
      // write, and it goes through the SAME writer and the SAME parseActionDoc
      // validation every op uses. A snapshot that fails to parse is refused, never
      // written: 撤销 = 用上一份快照走既有事务重放，仍必须过校验，不许绕过.
      case 'restore': {
        const snapshot = payload && payload.doc;
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
          return { ok: false, code: 'ACTION_RESTORE_INVALID', message: 'restore expects { doc }: a whole action document' };
        }
        if (String(snapshot.id) !== String(actionId)) {
          return { ok: false, code: 'ACTION_RESTORE_MISMATCH', message: `snapshot belongs to ${snapshot.id}, not ${actionId}` };
        }
        // 无变更不记录: an identical snapshot must not rewrite the draft
        if (JSON.stringify(doc) === JSON.stringify(snapshot)) {
          return { ok: true, changed: false, ...m1PanelRead(ctx, actionId) };
        }
        model.saveActionDoc(loaded.abs, snapshot);   // re-parses; throws on an invalid doc
        outcome = { changed: true, action: snapshot };
        break;
      }
      default: return { ok: false, code: 'ACTION_OP_UNKNOWN', message: `unknown op ${op}` };
    }
  } catch (error) {
    return { ok: false, code: error.code || 'ACTION_OP_FAILED', message: error.message };
  }
  // 无变更不记录: a no-op op must not rewrite the draft.
  if (outcome.changed) model.saveActionDoc(loaded.abs, outcome.action);
  return { ok: true, changed: outcome.changed, ...m1PanelRead(ctx, actionId) };
}

function m1ActionNew(ctx, id, direction) {
  const paths = m1Paths(ctx);
  const model = ctx.libs.model;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.id', detail: 'id must be kebab-case [a-z0-9-]' }] };
  }
  if (!model.DIRECTIONS.includes(direction)) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.direction', detail: `direction must be one of ${model.DIRECTIONS.join('|')}` }] };
  }
  if (fs.existsSync(path.join(paths.actionsDir, `${id}.json`))) {
    return { ok: false, violations: [{ file: `actions/${id}.json`, check: 'action.exists', detail: 'an action doc with this id already exists' }] };
  }
  const defaults = readPackAnimationDefaults(ctx);
  const doc = {
    schemaVersion: 1,
    id,
    loop: true,
    direction,
    frames: [],
    geometry: { footLine: defaults.packFootLine, tolerancePx: 1 },
  };
  model.saveActionDoc(path.join(paths.actionsDir, `${id}.json`), doc);
  return { ok: true, id };
}

// The default pack-relative target path for an imported frame: the action's
// existing frame directory, or derived from the direction for empty actions.
function m1DefaultImportName(ctx, paths, doc) {
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

function m1NormalizeForImport(ctx, paths, doc, sourcePath, requestedName) {
  const problems = [];
  let sourceBytes = null;
  try {
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) problems.push({ file: sourcePath, check: 'source.exists', detail: 'source PNG not found' });
    else sourceBytes = fs.readFileSync(sourcePath);
  } catch (error) {
    problems.push({ file: sourcePath, check: 'source.readable', detail: error.message });
  }
  const defaults = readPackAnimationDefaults(ctx);
  // Target height = the same-action visible-height median (empty actions
  // target the pack's standard 256px frame height).
  let targetHeight = 256;
  if (doc.frames.length > 0) {
    const heights = [];
    for (const frame of doc.frames) {
      const abs = ctx.libs.publisher.resolveFramePath(paths, frame.file);
      if (!abs) continue;
      const m = ctx.libs.geometry.measureFrameFile(abs);
      if (m.ok) heights.push(m.visibleHeight);
    }
    if (heights.length > 0) targetHeight = ctx.libs.geometry.median(heights);
  }
  const footLine = doc.geometry && Number.isInteger(doc.geometry.footLine) ? doc.geometry.footLine : defaults.packFootLine;
  if (!sourceBytes) return { ok: false, violations: problems };
  const outcome = ctx.libs.normalizer.normalizeImportFrame({
    sourceBytes,
    targetHeight,
    footLine,
    packCanvas: defaults.packCanvas,
    packAnchor: defaults.packAnchor,
  });
  if (!outcome.ok) {
    return { ok: false, violations: [...problems, ...outcome.violations.map((violation) => ({ file: sourcePath, check: violation.check, detail: violation.detail }))] };
  }
  const name = typeof requestedName === 'string' && requestedName.trim() ? requestedName.trim().replace(/\\/g, '/') : m1DefaultImportName(ctx, paths, doc);
  if (!name || !ctx.libs.model.isSafeRelativePath(name) || !name.endsWith('.png')) {
    return { ok: false, violations: [{ file: name || '', check: 'target.name', detail: 'target file name must be a safe relative .png path' }] };
  }
  const targetAbs = path.join(paths.assetsDir, name);
  if (fs.existsSync(targetAbs)) {
    return { ok: false, violations: [{ file: name, check: 'target.name', detail: 'a content asset with this name already exists' }] };
  }
  return { ok: true, outcome, name, targetAbs, targetHeight, footLine };
}

function m1ImportPreview(ctx, actionId, sourcePath, requestedName) {
  const paths = m1Paths(ctx);
  const loaded = m1ReadDoc(ctx, paths, actionId);
  if (!loaded.ok) return loaded;
  const result = m1NormalizeForImport(ctx, paths, loaded.doc, String(sourcePath), requestedName);
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

function m1ImportInsert(ctx, actionId, sourcePath, requestedName, index) {
  const paths = m1Paths(ctx);
  const loaded = m1ReadDoc(ctx, paths, actionId);
  if (!loaded.ok) return loaded;
  // Re-normalize on insert (deterministic — same bytes) so the file that gets
  // written is exactly the validated one.
  const result = m1NormalizeForImport(ctx, paths, loaded.doc, String(sourcePath), requestedName);
  if (!result.ok) return result;
  fs.mkdirSync(path.dirname(result.targetAbs), { recursive: true });
  fs.writeFileSync(result.targetAbs, result.outcome.png);
  const insert = m1ActionOp(ctx, actionId, 'insert', { index, file: result.name, durationMs: null });
  if (!insert.ok) {
    try { fs.unlinkSync(result.targetAbs); } catch { /* keep the asset; the doc rejected it */ }
    return insert;
  }
  return { ...insert, file: result.name };
}

// ---- the service bundle ------------------------------------------------------

function createToolServices({ repoRoot, contentDir, charactersRoot, characterId = DEFAULT_CHARACTER_ID, scheme = 'workbench' }) {
  const libs = {
    geometry: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'character-geometry.js')),
    assets: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'asset-validator.js')),
    content: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'content-validator.js')),
    png: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'png-geometry.js')),
    // M1 action editor: pure model, import normalizer, publish kernel
    model: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'action-model.js')),
    normalizer: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'normalizer.js')),
    publisher: require(path.join(repoRoot, 'src', 'workbench', 'lib', 'action-publisher.js')),
  };
  const ctx = {
    repoRoot,
    contentDir,
    charactersRoot,
    characterId,
    scheme,
    workbenchRoot: path.join(repoRoot, 'src', 'workbench'),
    sourcePackDir: path.join(charactersRoot, libs.publisher.PACK_ID || 'deepseek-default'),
    libs,
  };
  return {
    ctx,
    libs,
    scheme,
    contentLayoutStore: () => createContentLayoutStore(ctx),
    protocolHandler: () => createWorkbenchProtocolHandler(ctx),
    characterJsonPath: (id) => characterJsonPath(ctx, id),
    readCharacterJson: (id) => readCharacterJson(ctx, id),
    resolveFramePath: (character, frame) => resolveFramePath(ctx, character, frame),
    walkGeometryReport: () => walkGeometryReport(ctx),
    catalogEntryById: (assetId) => catalogEntryById(ctx, assetId),
    entryGeometryForAsset: (assetId) => entryGeometryForAsset(ctx, assetId),
    listContentTree: () => listContentTree(ctx),
    validateContentTree: () => libs.content.validateContentTree({ repoRoot, contentDir }),
    catalogAssetRows: () => libs.assets.catalogAssetRows(repoRoot),
    // M1 action editor surface
    actionList: () => m1ActionList(ctx),
    actionRead: (actionId) => m1PanelRead(ctx, actionId),
    actionOp: (actionId, op, payload) => m1ActionOp(ctx, actionId, op, payload),
    actionNew: (id, direction) => m1ActionNew(ctx, id, direction),
    importPreview: (actionId, sourcePath, name) => m1ImportPreview(ctx, actionId, sourcePath, name),
    importInsert: (actionId, sourcePath, name, index) => m1ImportInsert(ctx, actionId, sourcePath, name, index),
    stageAction: (actionId) => libs.publisher.stagePreviewPack({ contentDir, charactersRoot, actionId }),
    publishAction: (actionId) => libs.publisher.publishAction({ contentDir, charactersRoot, actionId }),
  };
}

module.exports = {
  DEFAULT_CHARACTER_ID,
  MIME_TABLE,
  createContentLayoutStore,
  createWorkbenchProtocolHandler,
  createToolServices,
  // individual services (exported for tests and for entry points that need one)
  characterJsonPath,
  readCharacterJson,
  resolveFramePath,
  walkGeometryReport,
  listContentTree,
  entryGeometryForAsset,
  m1PanelRead,
  m1ActionList,
  m1ActionOp,
};
