'use strict';

// P5/B-1 — the extracted schema-v1 surface (src/office/layout-schema.js).
//
// This file pins three things the extraction must not break:
//  1. the module's contract (parseDraft / validateDraftSchema / ASSET_BY_ID),
//     including the exact stable codes the production diagnostics rely on;
//  2. its purity (no DOM / Electron / Pixi / fs / network — the production
//     boot chain loads it before any UI exists);
//  3. the production boot chain end-to-end through the REAL validator:
//     office-boot.resolveProductionLayoutDraft still prefers a valid saved
//     layout, still rejects corrupt/invalid saved layouts with the same
//     stable codes, and still degrades to the bundled draft.
//
// The editor core (layout-editor.js) now requires this module (single source
// of truth); the editor API keeps the same validateDraftSchema behaviour.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const layoutSchema = require('../src/office/layout-schema.js');
const layoutEditor = require('../src/office/layout-editor.js');
const boot = require('../src/office/office-boot.js');

const BUNDLED_DRAFT_PATH = path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-draft.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bundledDraft() {
  return JSON.parse(fs.readFileSync(BUNDLED_DRAFT_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. module contract
// ---------------------------------------------------------------------------

test('layout-schema exports the production-required surface', () => {
  assert.equal(typeof layoutSchema.parseDraft, 'function', 'parseDraft is exported');
  assert.equal(typeof layoutSchema.validateDraftSchema, 'function', 'validateDraftSchema is a free function');
  assert.ok(layoutSchema.ASSET_BY_ID instanceof Map, 'ASSET_BY_ID is exported as a Map');
  assert.equal(layoutSchema.SCHEMA_VERSION, 1, 'schema-v1');
  assert.equal(layoutSchema.DEFAULT_LAYER_BY_KIND.prop, 25, 'layer defaults travel with the module');
});

test('layout-schema is pure: layout-assets is its only dependency', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'office', 'layout-schema.js'), 'utf8');
  const requires = [...src.matchAll(/require\(([^)]+)\)/g)].map((m) => m[1].trim());
  assert.deepEqual(requires, ["'./layout-assets.js'"], 'the only require is the catalog');
  assert.doesNotMatch(src, /document\.|window\.|PIXI|electron|node:fs|node:net|process\./, 'no DOM/Electron/Pixi/fs/network references');
});

test('parseDraft validates and normalizes the bundled schema-v1 draft', () => {
  const parsed = layoutSchema.parseDraft(bundledDraft());
  assert.ok(Array.isArray(parsed.items) && parsed.items.length > 0, 'items parse');
  assert.ok(parsed.items.every((item) => typeof item.groupId === 'string'), 'every item gets a group id');
  assert.ok(parsed.items.every((item) => typeof item.layer === 'number'), 'layer defaults applied');
  // desks own their group; non-desk items are never their own group here
  for (const item of parsed.items) {
    if (item.kind === 'desk') assert.equal(item.groupId, item.id, 'a desk owns a group named after itself');
  }
});

test('validateDraftSchema answers ok/count/code without throwing (stable codes)', () => {
  const good = layoutSchema.validateDraftSchema(bundledDraft());
  assert.deepEqual(good.ok, true);
  assert.equal(good.code, null);
  assert.ok(good.count > 0);

  const cases = [
    [null, 'DRAFT_INVALID'],
    [{ schemaVersion: 2 }, 'DRAFT_SCHEMA_UNSUPPORTED'],
    [{ schemaVersion: 1 }, 'DRAFT_SCENE_INVALID'],
    [{ schemaVersion: 1, scene: { width: 1280, height: 840 } }, 'DRAFT_ITEMS_INVALID'],
  ];
  for (const [draft, code] of cases) {
    const result = layoutSchema.validateDraftSchema(draft);
    assert.deepEqual({ ok: result.ok, count: result.count, code: result.code },
      { ok: false, count: 0, code }, `stable code for ${JSON.stringify(draft)}`);
  }

  // item-level codes: unknown asset, kind mismatch, direction mismatch, bad position
  const base = bundledDraft();
  const unknownAsset = clone(base);
  unknownAsset.items[0].asset = 'nope-not-an-asset';
  assert.equal(layoutSchema.validateDraftSchema(unknownAsset).code, 'DRAFT_ITEM_ASSET_UNKNOWN');
  const badKind = clone(base);
  badKind.items[0].kind = badKind.items[0].kind === 'desk' ? 'chair' : 'desk';
  assert.equal(layoutSchema.validateDraftSchema(badKind).code, 'DRAFT_ITEM_KIND_MISMATCH');
  const badPosition = clone(base);
  badPosition.items[0].position = { x: 2, y: 0.5 };
  assert.equal(layoutSchema.validateDraftSchema(badPosition).code, 'DRAFT_ITEM_POSITION_INVALID');
  const noDesk = clone(base);
  noDesk.items = noDesk.items.filter((item) => item.kind !== 'desk');
  assert.equal(layoutSchema.validateDraftSchema(noDesk).code, 'DRAFT_GROUP_NO_DESK');
});

test('the editor core and the schema module share one validator (B-1 single source of truth)', () => {
  const editorSrc = fs.readFileSync(path.join(ROOT, 'src', 'office', 'layout-editor.js'), 'utf8');
  assert.match(editorSrc, /require\('\.\/layout-schema\.js'\)/, 'the editor requires the schema module');
  assert.doesNotMatch(editorSrc, /require\('\.\/layout-assets\.js'\)/, 'the editor no longer requires the catalog directly');
  assert.doesNotMatch(editorSrc, /function parseDraft\(/, 'parseDraft is not re-implemented in the editor');

  const editor = layoutEditor.createLayoutEditor({ scene: { width: 1, height: 1 } });
  const good = bundledDraft();
  assert.deepEqual(editor.validateDraftSchema(good), layoutSchema.validateDraftSchema(good),
    'the editor API answers identically for a valid draft');
  const bad = clone(good);
  bad.items[0].asset = 'nope-not-an-asset';
  assert.deepEqual(editor.validateDraftSchema(bad), layoutSchema.validateDraftSchema(bad),
    'the editor API answers identically for an invalid draft');
});

// ---------------------------------------------------------------------------
// 2. the production boot chain through the REAL validator (Task 8 + P5/B-1)
// ---------------------------------------------------------------------------

// Build the exact attempt shapes the page produces (fetch -> classify), then
// run the REAL resolveProductionLayoutDraft with the REAL validator — the same
// wiring office.html performs: REGISTRY['layout-schema'].validateDraftSchema.
function resolve({ saved, bundled }) {
  return boot.resolveProductionLayoutDraft({
    saved: saved === undefined ? boot.classifyLayoutAttempt({ status: 404 }) : saved,
    bundled: bundled === undefined ? boot.classifyLayoutAttempt({ status: 200, body: bundledDraft() }) : bundled,
    validateDraftSchema: layoutSchema.validateDraftSchema,
  });
}

test('boot chain: a valid saved layout still wins over the bundled draft (real validator)', () => {
  const savedDraft = bundledDraft();
  savedDraft.selectedIds = []; // a user-visible edit that still validates
  const outcome = resolve({ saved: boot.classifyLayoutAttempt({ status: 200, body: savedDraft }) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'saved');
  assert.equal(outcome.code, null);
  assert.equal(outcome.draft, savedDraft, 'the saved draft is handed to the boot untouched');
});

test('boot chain: a corrupt saved layout (non-JSON/5xx) still degrades to the bundled draft with the stable diagnostic', () => {
  const outcome = resolve({ saved: boot.classifyLayoutAttempt({ status: 500, body: null }) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'bundled');
  assert.equal(outcome.code, 'OFFICE_LAYOUT_SAVED_INVALID');
  assert.deepEqual(outcome.draft.items.length, bundledDraft().items.length, 'the bundled draft is used');
});

test('boot chain: a parseable but schema-invalid saved layout is still rejected the same way', () => {
  const broken = bundledDraft();
  broken.items[0].asset = 'nope-not-an-asset'; // parses as JSON, fails schema-v1
  const outcome = resolve({ saved: boot.classifyLayoutAttempt({ status: 200, body: broken }) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'bundled');
  assert.equal(outcome.code, 'OFFICE_LAYOUT_SAVED_INVALID',
    'a present-but-invalid saved layout is a diagnostic, exactly as before the extraction');
});

test('boot chain: no saved layout is still the silent first-run case', () => {
  const outcome = resolve({ saved: boot.classifyLayoutAttempt({ status: 404 }) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'bundled');
  assert.equal(outcome.code, null, 'a missing saved layout raises no diagnostic');
});

test('boot chain: when even the bundled draft fails validation the boot still fails closed', () => {
  const brokenBundled = bundledDraft();
  brokenBundled.items[0].direction = 'not-a-direction';
  const outcome = resolve({
    saved: boot.classifyLayoutAttempt({ status: 404 }),
    bundled: boot.classifyLayoutAttempt({ status: 200, body: brokenBundled }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.draft, null);
  assert.equal(outcome.code, 'OFFICE_LAYOUT_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// 3. the editor surface is gone from the production page (P5 static pins)
// ---------------------------------------------------------------------------

test('office.html no longer carries the editor surface (P5 A-3)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.doesNotMatch(html, /id="layout-editor"/, 'the editor DOM is gone');
  assert.doesNotMatch(html, /id="layout-canvas"/, 'the editor canvas DOM is gone');
  assert.doesNotMatch(html, /id="layout-palette"/, 'the editor palette DOM is gone');
  assert.doesNotMatch(html, /btn-layout-editor/, 'the footer chip is gone');
  assert.doesNotMatch(html, /布局编辑/, 'the editor entry label is gone');
  assert.doesNotMatch(html, /createLayoutEditor|createCanvasView/, 'no editor instance or canvas view is constructed');
  assert.doesNotMatch(html, /toggleLayoutEditor|layoutDraft|viewState|setGroupMoveRigid/, 'the editor evidence hooks are gone');
  assert.doesNotMatch(html, /loadModule\('\.\/layout-editor\.js'\)/, 'the editor module is not loaded by the boot');
  assert.doesNotMatch(html, /editor\s*=\s*1|get\('editor'\)/, 'the ?editor=1 entry point is gone');
  // the production boot chain runs on the standalone schema module instead
  assert.match(html, /REGISTRY\['layout-schema'\] = await loadModule\('\.\/layout-schema\.js'/, 'the boot loads layout-schema.js');
  assert.match(html, /validateDraftSchema: REGISTRY\['layout-schema'\]\.validateDraftSchema/, 'the boot validator is the schema free function');
});

test('office.css no longer carries the editor styles (P5 A-4)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  for (const selector of ['#layout-editor', '#layout-palette', '#layout-toolbar', '#layout-canvas',
    '#layout-asset-shelf', '#layout-scene-frame', '#layout-draft-items', '#layout-guide-layer',
    '#layout-handle-layer', '#layout-align-bar', '#layout-inspector', '#layout-layer-panel',
    '.layout-asset-tile', '.layout-draft-item', '.layout-scale-handle', '.layout-marquee',
    '.editor-control', '.editor-note', '.layer-group', '.layer-row', '.layer-thumb',
    '#btn-layout-editor', 'layout-editing']) {
    assert.doesNotMatch(css, new RegExp(selector.replace(/[.#]/g, '\\$&')), `${selector} rules are gone`);
  }
  // the production rules that shared the region survive
  assert.match(css, /\.checkbox\s*\{/, 'the footer reduced-motion checkbox keeps its styles');
  assert.match(css, /@media \(max-width: 760px\)/, 'the production responsive block survives');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'the reduced-motion block survives');
  assert.match(css, /#footer-tools\s*\{/, 'the footer tools container survives');
});
