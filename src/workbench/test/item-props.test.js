'use strict';

// src/workbench/test/item-props.test.js — the inspector's typed values, at the
// transaction level (workbench UX rectification, gap #2: 选中物件的数值属性).
//
// The property panel (workbench.html #panel-item) sends 应用 through stageEdit →
// studio.sceneEdit, the SAME validated transaction the CLI and the drop use. This
// test drives that transaction directly — the real editor over a sandbox copy of
// the flat scene — and pins what the panel relies on:
//   * a typed coordinate and layer reach the file and read back exactly
//     (position snapped to the canvas grid, layer verbatim);
//   * the panel's clamps are the transaction's clamps (x/y ∈ 0..1, scale 0.2..3);
//   * a dry run writes nothing, and a red result refuses the write and leaves the
//     file byte-identical.
// The NAME is deliberately absent: sceneDraft does not return `name` and sceneEdit
// has no name patch (studio/**, out of this round's file scope), which is why the
// panel's name field stays read-only with its note. Recorded, not hidden.
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const { createSceneServices } = require(path.join(REPO_ROOT, 'studio', 'lib', 'scene', 'index.js'));

// The real scene, copied: the catalog still comes from the product tree (the
// editor needs the real furniture assets to derive boxes and stations), while
// every write lands in the sandbox.
function sandboxScene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'item-props-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  fs.cpSync(path.join(REPO_ROOT, 'content', 'scenes'), path.join(contentDir, 'scenes'), { recursive: true });
  const scene = createSceneServices({ repoRoot: REPO_ROOT, contentDir });
  return {
    contentDir,
    layoutPath: path.join(contentDir, 'scenes', 'flat', 'layout.json'),
    read: () => JSON.parse(fs.readFileSync(path.join(contentDir, 'scenes', 'flat', 'layout.json'), 'utf8')),
    commit: (edits, dryRun = false) => scene.editor.commit({ sceneId: 'flat', edits, dryRun }),
  };
}

// A free-standing prop (flat-island): it belongs to no workstation, so typing a
// coordinate cannot trip the station checks the way moving a desk would — the
// red-refusal test below moves a desk on purpose.
function island(sandbox) {
  const item = sandbox.read().items.find((entry) => entry.kind === 'prop' && entry.asset === 'flat-island');
  assert.ok(item, 'the flat scene has the island prop');
  return item;
}

test('a typed coordinate and layer reach the file and read back exactly', (t) => {
  const sandbox = sandboxScene(t);
  const item = island(sandbox);
  const before = sandbox.read();

  const outcome = sandbox.commit([{ itemId: item.id, position: { x: 0.15, y: 0.25 }, layer: 33 }]);
  assert.equal(outcome.ok, true, `the edit was accepted (${outcome.code || ''})`);
  assert.equal(outcome.dryRun, false);

  const edited = sandbox.read().items.find((entry) => entry.id === item.id);
  assert.deepEqual(edited.position, { x: 0.15, y: 0.25 }, 'the coordinate is stored (0.15/0.25 are on the 0.005 grid)');
  assert.equal(edited.layer, 33, 'the layer is stored verbatim');
  // everything else about the item is untouched
  assert.equal(edited.scale, item.scale);
  assert.equal(edited.asset, item.asset);
  assert.equal(sandbox.read().items.length, before.items.length);
  // the write is auditable: a byte backup of the replaced file exists
  const backups = fs.readdirSync(path.join(sandbox.contentDir, 'build', 'backups', 'layout'));
  assert.ok(backups.length > 0, 'a backup landed before the file was replaced');
});

test('the typed coordinate is snapped to the canvas grid, not stored raw', (t) => {
  const sandbox = sandboxScene(t);
  const item = island(sandbox);
  const outcome = sandbox.commit([{ itemId: item.id, position: { x: 0.54321, y: 0.12345 } }]);
  assert.equal(outcome.ok, true);
  const edited = sandbox.read().items.find((entry) => entry.id === item.id);
  assert.equal(edited.position.x, 0.545, 'x snaps to the 0.005 grid');
  assert.equal(edited.position.y, 0.125, 'y snaps to the 0.005 grid');
});

test('the clamps are the editor\'s own: position 0..1, scale 0.2..3', (t) => {
  const sandbox = sandboxScene(t);
  const item = island(sandbox);
  const outcome = sandbox.commit([{ itemId: item.id, position: { x: 1.7, y: -0.3 }, scale: 99 }]);
  assert.equal(outcome.ok, true);
  const edited = sandbox.read().items.find((entry) => entry.id === item.id);
  assert.equal(edited.position.x, 1, 'x is clamped into the scene');
  assert.equal(edited.position.y, 0, 'y is clamped into the scene');
  assert.equal(edited.scale, 3, 'scale is clamped to the editor maximum');
  const shrunk = sandbox.commit([{ itemId: item.id, scale: 0.01 }]);
  assert.equal(shrunk.ok, true);
  assert.equal(sandbox.read().items.find((entry) => entry.id === item.id).scale, 0.2, 'scale is clamped to the editor minimum');
});

test('a dry run writes nothing — the panel sees the verdict before the file moves', (t) => {
  const sandbox = sandboxScene(t);
  const item = island(sandbox);
  const bytes = fs.readFileSync(sandbox.layoutPath);
  const outcome = sandbox.commit([{ itemId: item.id, position: { x: 0.35, y: 0.75 } }], true);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.dryRun, true);
  assert.ok(fs.readFileSync(sandbox.layoutPath).equals(bytes), 'the file is untouched by a dry run');
  assert.equal(sandbox.read().items.find((entry) => entry.id === item.id).position.x, item.position.x);
});

test('a red result refuses the write and leaves the file byte-identical', (t) => {
  const sandbox = sandboxScene(t);
  const bytes = fs.readFileSync(sandbox.layoutPath);
  const draft = sandbox.read();
  const desks = draft.items.filter((entry) => entry.kind === 'desk');
  assert.ok(desks.length >= 2, 'the flat scene has at least two desks');
  // stack one desk exactly onto another: the conflict validator must refuse it
  const outcome = sandbox.commit([{ itemId: desks[1].id, position: { ...desks[0].position } }]);
  assert.equal(outcome.ok, false, 'an overlapping placement is refused');
  assert.equal(outcome.code, 'SCENE_CONFLICTS');
  assert.ok((outcome.violations || []).some((violation) => violation.severity === 'red'), 'the refusal carries red findings');
  assert.ok(fs.readFileSync(sandbox.layoutPath).equals(bytes), 'the refused edit left the file byte-identical');
});

test('an edit that changes nothing is a no-op (无变更不落盘)', (t) => {
  const sandbox = sandboxScene(t);
  const item = island(sandbox);
  const bytes = fs.readFileSync(sandbox.layoutPath);
  const outcome = sandbox.commit([{ itemId: item.id, position: { ...item.position } }]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.noop, true);
  assert.ok(fs.readFileSync(sandbox.layoutPath).equals(bytes), 'a no-op does not rewrite the file');
});

test('an unknown item id is an edit violation, not a silent drop', (t) => {
  const sandbox = sandboxScene(t);
  const outcome = sandbox.commit([{ itemId: 'draft-9999', position: { x: 0.5, y: 0.5 } }]);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'EDIT_INVALID');
  assert.ok((outcome.violations || []).some((violation) => String(violation.detail).includes('draft-9999')));
});
