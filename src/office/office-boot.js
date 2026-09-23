'use strict';

// src/office/office-boot.js — Task 9 blocker A / SPEC-07 boot policy for the
// character pack on the office page. Pure deterministic CommonJS: injectable
// loadJson + createAssetPack, no DOM, no Electron, no fs.
//
// Contract (regression-tested in test/office-boot.test.js): a missing,
// unreadable, corrupt or invalid pack MUST NOT reject the page boot. The
// page calls loadOfficePack() before touching the renderer; whatever this
// resolves, the page continues with pack=null and surfaces the returned
// stable diagnostic code (SPEC-02 vocabulary), so the renderer falls back to
// diagnostic placeholders (fallbackReason PACK_MISSING) while the details
// panel, employee list and activity log stay usable.

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEFAULT_PACK_ID = 'deepseek-default';

function isJsonParseError(error) {
  return error instanceof SyntaxError || (error && error.name === 'SyntaxError');
}

// Portable pack descriptor: a pack ID plus RELATIVE managed-resource URLs.
// Production Office never receives or passes an absolute local path, and the
// view URL is the only main->renderer transport (the seven office:* channels
// stay untouched).
function packDescriptor(packId) {
  const rootUrl = `./characters/${packId}/`;
  return Object.freeze({
    id: packId,
    rootUrl,
    manifestUrl: `${rootUrl}manifest.json`,
    anchorsUrl: `${rootUrl}animation/anchors.json`,
    animationsUrl: `${rootUrl}animation/animations.json`,
  });
}

// Resolves { ok, pack, code, descriptor, manifest, anchors, animations } —
// never rejects. code is null on success, otherwise PACK_ID_INVALID (unsafe
// pack id, nothing is loaded), PACK_MISSING (manifest unavailable),
// PACK_MANIFEST_INVALID (manifest not valid JSON),
// PACK_ASSET_MISSING (anchors/animations unavailable or not valid JSON),
// or the upstream validator code from createAssetPack (e.g.
// PACK_GEOMETRY_INVALID), passed through unchanged.
async function loadOfficePack({ packId = DEFAULT_PACK_ID, loadJson, createAssetPack } = {}) {
  if (typeof loadJson !== 'function') throw new TypeError('loadOfficePack requires loadJson(url)');
  if (typeof createAssetPack !== 'function') throw new TypeError('loadOfficePack requires createAssetPack');

  if (typeof packId !== 'string' || !PACK_ID_PATTERN.test(packId)) {
    return Object.freeze({
      ok: false,
      pack: null,
      code: 'PACK_ID_INVALID',
      descriptor: null,
      manifest: null,
      anchors: null,
      animations: null,
    });
  }
  const descriptor = packDescriptor(packId);

  let manifest = null;
  try {
    manifest = await loadJson(descriptor.manifestUrl);
  } catch (error) {
    return Object.freeze({
      ok: false,
      pack: null,
      code: isJsonParseError(error) ? 'PACK_MANIFEST_INVALID' : 'PACK_MISSING',
      descriptor,
      manifest: null,
      anchors: null,
      animations: null,
    });
  }

  let anchors = null;
  let animations = null;
  try {
    anchors = await loadJson(descriptor.anchorsUrl);
    animations = await loadJson(descriptor.animationsUrl);
  } catch (error) {
    return Object.freeze({
      ok: false,
      pack: null,
      code: 'PACK_ASSET_MISSING',
      descriptor,
      manifest,
      anchors: null,
      animations: null,
    });
  }

  try {
    const result = createAssetPack({ manifest, anchors, animations });
    if (result && result.ok) {
      return Object.freeze({ ok: true, pack: result.pack, code: null, descriptor, manifest, anchors, animations });
    }
    return Object.freeze({
      ok: false,
      pack: null,
      code: (result && result.code) || 'PACK_LOAD_FAILED',
      descriptor,
      manifest,
      anchors,
      animations,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      pack: null,
      code: 'PACK_LOAD_FAILED',
      descriptor,
      manifest,
      anchors,
      animations,
    });
  }
}

// Task 8-R1 — response -> attempt classification for the production layout
// sources. The protocol layout route answers: 200 with the draft JSON, 404
// when nothing was saved (the normal first run), 409/422 with a stable code
// when the saved file is corrupt or envelope-invalid, 5xx on write failure.
// Collapsing ANY non-2xx into `missing` (the Task 8 page bug) made the
// corrupt-layout diagnostics unreachable — only a 404 may be `missing`.
function classifyLayoutAttempt({ status, body } = {}) {
  if (status === 200 && body !== null && body !== undefined) {
    return Object.freeze({ ok: true, draft: body, missing: false, code: null });
  }
  if (status === 404) {
    return Object.freeze({ ok: false, draft: null, missing: true, code: null });
  }
  const code = body && typeof body === 'object' && typeof body.code === 'string' && body.code
    ? body.code
    : 'OFFICE_LAYOUT_SAVED_INVALID';
  return Object.freeze({ ok: false, draft: null, missing: false, code });
}

// Task 8 — production layout draft source priority (saved > built-in > none).
// saved/bundled are tolerant fetch attempts shaped
// { ok: true, draft } | { ok: false, code?, missing? }; validateDraftSchema is
// the layout-schema schema-v1 probe (full asset-whitelist/kind/position rules)
// injected for purity — P5/B-1 moved it out of the editor core so the boot
// chain carries no editor code. A present-but-invalid saved layout degrades to
// the built-in draft with a stable diagnostic instead of failing the boot; an
// absent saved layout is the normal first run and raises NO diagnostic.
function resolveProductionLayoutDraft({ saved, bundled, validateDraftSchema } = {}) {
  if (typeof validateDraftSchema !== 'function') {
    throw new TypeError('resolveProductionLayoutDraft requires validateDraftSchema(draft)');
  }
  const savedAttempt = saved || { ok: false, missing: true };
  const bundledAttempt = bundled || { ok: false, missing: true };
  const savedValid = savedAttempt.ok && savedAttempt.draft
    && validateDraftSchema(savedAttempt.draft).ok === true;
  if (savedValid) {
    return Object.freeze({ ok: true, draft: savedAttempt.draft, source: 'saved', code: null });
  }
  const bundledValid = bundledAttempt.ok && bundledAttempt.draft
    && validateDraftSchema(bundledAttempt.draft).ok === true;
  // A saved attempt that exists but failed (corrupt file, invalid schema,
  // failed validation) is a real diagnostic; a merely missing one is not.
  const savedBroken = !savedAttempt.missing;
  if (bundledValid) {
    return Object.freeze({
      ok: true,
      draft: bundledAttempt.draft,
      source: 'bundled',
      code: savedBroken ? 'OFFICE_LAYOUT_SAVED_INVALID' : null,
    });
  }
  return Object.freeze({
    ok: false,
    draft: null,
    source: null,
    code: savedBroken ? 'OFFICE_LAYOUT_SAVED_INVALID' : 'OFFICE_LAYOUT_UNAVAILABLE',
  });
}

module.exports = {
  loadOfficePack,
  packDescriptor,
  resolveProductionLayoutDraft,
  classifyLayoutAttempt,
  DEFAULT_PACK_ID,
  PACK_ID_PATTERN,
};
