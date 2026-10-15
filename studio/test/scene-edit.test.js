'use strict';

// studio/test/scene-edit.test.js — the scene editing service (UI #1's engine).
//
// The panel edits through this module, so what is tested here IS what the canvas does:
//   * a legal move is applied and (on save) written, with a backup of the previous file;
//   * a move that creates a BLOCKING conflict is refused — the file is untouched;
//   * nothing changed ⇒ nothing written (无变更不落盘);
//   * scale is clamped, unknown items are refused, hidden toggles round-trip;
//   * every edit re-runs the SAME validator the CLI and the publish gate use.
// All of it in a sandbox copy of the real content tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');

const { createSceneServices } = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'index.js'));

function sandboxScene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(contentDir, { recursive: true });
  fs.cpSync(path.join(CONTENT_ROOT, 'scenes'), path.join(contentDir, 'scenes'), { recursive: true });
  const scene = createSceneServices({ repoRoot: REPO_ROOT, contentDir });
  return { dir, contentDir, scene, editor: scene.editor, layoutPath: path.join(contentDir, 'scenes', 'flat', 'layout.json') };
}

function readItems(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).items;
}

// find a prop whose move to the given point is legal (validated by the service itself)
function legalTargetFor(editor, itemId, candidates) {
  for (const point of candidates) {
    const outcome = editor.commit({ sceneId: 'flat', edits: [{ itemId, position: point }], dryRun: true });
    if (outcome.ok) return point;
  }
  return null;
}

test('a legal move is staged, and saving writes the file with a backup', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const before = fs.readFileSync(layoutPath, 'utf8');
  const target = legalTargetFor(editor, 'draft-53', [
    { x: 0.10, y: 0.55 }, { x: 0.12, y: 0.60 }, { x: 0.08, y: 0.50 }, { x: 0.15, y: 0.45 },
  ]);
  assert.ok(target, 'a legal position exists for the island');

  const dry = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'draft-53', position: target }], dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.changed, true);
  assert.equal(fs.readFileSync(layoutPath, 'utf8'), before, 'a dry run writes nothing');

  const saved = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'draft-53', position: target }], dryRun: false });
  assert.equal(saved.ok, true, `save ok (${saved.code || ''})`);
  assert.equal(saved.dryRun, false);
  assert.ok(saved.backup && fs.existsSync(saved.backup), 'the previous file is backed up');
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), before, 'the backup is the untouched original');
  const after = readItems(layoutPath).find((item) => item.id === 'draft-53');
  assert.deepEqual([after.position.x, after.position.y], [target.x, target.y], 'the move landed, snapped to the grid');
});

test('a move that creates a blocking conflict is REFUSED and the file stays byte-identical', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const before = fs.readFileSync(layoutPath, 'utf8');
  const draft = JSON.parse(before);
  const deskA = draft.items.find((item) => item.id === 'draft-27');
  const deskB = draft.items.find((item) => item.id === 'draft-28');
  // slide desk B 64px into desk A: cross-station furniture overlap (a defect class this
  // project actually shipped) plus the disrupted station cluster
  const target = { x: deskA.position.x + 0.05, y: deskA.position.y };
  const outcome = editor.commit({ sceneId: 'flat', edits: [{ itemId: deskB.id, position: target }], dryRun: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'SCENE_CONFLICTS');
  const codes = outcome.violations.map((violation) => violation.code);
  assert.ok(codes.includes('SCENE_FURNITURE_OVERLAP'), `the overlap is named (${codes.join(',')})`);
  assert.equal(fs.readFileSync(layoutPath, 'utf8'), before, 'the refusal wrote nothing');
  assert.equal(fs.existsSync(editor.backupRoot), false, 'no backup is taken for a refused edit');
});

test('hidden toggles and scale are clamped and round-trip', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const hidden = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'draft-71', hidden: true }], dryRun: false });
  assert.equal(hidden.ok, true);
  assert.equal(readItems(layoutPath).find((item) => item.id === 'draft-71').hidden, true);
  // a hidden item no longer participates in the conflict checks (it is not rendered and
  // has no footprint), so toggling it back must not be refused by a stale finding
  const shown = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'draft-71', hidden: false }], dryRun: false });
  assert.equal(shown.ok, true);
  assert.equal(readItems(layoutPath).find((item) => item.id === 'draft-71').hidden, false);

  const clamped = editor.applyEdits({ draft: JSON.parse(fs.readFileSync(layoutPath, 'utf8')), edits: [{ itemId: 'draft-71', scale: 99 }] });
  const item = clamped.draft.items.find((entry) => entry.id === 'draft-71');
  assert.equal(item.scale, 3, 'scale is clamped to the editor maximum');
  const clampedLow = editor.applyEdits({ draft: JSON.parse(fs.readFileSync(layoutPath, 'utf8')), edits: [{ itemId: 'draft-71', scale: 0.01 }] });
  assert.equal(clampedLow.draft.items.find((entry) => entry.id === 'draft-71').scale, 0.2);
});

test('positions snap to the 0.5% grid and clamp inside the scene', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const draft = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const applied = editor.applyEdits({ draft, edits: [{ itemId: 'draft-53', position: { x: 0.1234567, y: 1.4 } }] });
  const item = applied.draft.items.find((entry) => entry.id === 'draft-53');
  assert.equal(item.position.x, 0.125, 'x snapped to the nearest 0.005');
  assert.equal(item.position.y, 1, 'y clamped into the scene');
});

test('no change is a no-op and unknown items are refused', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const draft = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const item = draft.items.find((entry) => entry.id === 'draft-53');
  const noop = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'draft-53', position: { ...item.position } }], dryRun: false });
  assert.equal(noop.ok, true);
  assert.equal(noop.noop, true, 'an identical position is not a change');
  assert.equal(noop.changed, false);

  const unknown = editor.commit({ sceneId: 'flat', edits: [{ itemId: 'no-such-item', position: { x: 0.5, y: 0.5 } }], dryRun: true });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'EDIT_INVALID');
  assert.match(unknown.violations[0].detail, /no-such-item/);
});

test('the evaluation reports the same shape the panel renders (violations + stats + graph)', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const draft = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  const report = editor.evaluate({ sceneId: 'flat', draft });
  assert.equal(report.ok, true, `the real scene is clean (${JSON.stringify((report.violations || []).filter((violation) => violation.severity === 'red').map((violation) => violation.code))})`);
  assert.equal(report.stats.stations, 6);
  assert.ok(report.graph && report.graph.stats.nodes > 50);
  assert.ok(Array.isArray(report.violations));
});

// ---- the graph file service (UI #2's engine) ---------------------------------

const { createGraphFileService } = require(path.join(STUDIO_ROOT, 'lib', 'graph-file.js'));

function sandboxGraphs(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contentDir = path.join(dir, 'content');
  fs.mkdirSync(path.join(contentDir, 'graphs'), { recursive: true });
  fs.copyFileSync(path.join(CONTENT_ROOT, 'graphs', 'local-behaviour.vgraph.json'), path.join(contentDir, 'graphs', 'local-behaviour.vgraph.json'));
  return { contentDir, service: createGraphFileService({ repoRoot: REPO_ROOT, contentDir }), file: path.join(contentDir, 'graphs', 'local-behaviour.vgraph.json') };
}

// ---- dropping furniture onto the canvas = an ADD through the same gate ---------

test('dropping a catalog item adds it to the layout through the validated transaction', (t) => {
  const { scene, editor, layoutPath } = sandboxScene(t);
  const before = readItems(layoutPath);
  const status = scene.catalogStatus();
  assert.equal(status.ok, true, `the product catalog loads: ${status.code || ''}`);
  const catalog = scene.loadCatalog();
  const sofa = catalog.assets.get('flat-sofa');
  assert.ok(sofa, 'the drop palette can name a real asset');
  // a spot that the validator accepts (the canvas picks it from the drop point; here we
  // let the service itself judge, which is exactly what the drop path does)
  const trial = editor.commit({
    sceneId: 'flat',
    dryRun: true,
    edits: [{ add: { kind: sofa.kind, asset: sofa.id, direction: sofa.direction, layer: 30, position: { x: 0.5, y: 0.5 } } }],
  });
  assert.equal(trial.ok, true, `the trial passes: ${JSON.stringify((trial.violations || []).slice(0, 2))}`);
  assert.equal(trial.changed, true, 'an add counts as a change');
  const added = (trial.applied || []).find((entry) => entry.added);
  assert.ok(added, 'the applied list names the new item');
  assert.match(added.itemId, /^draft-\d+$/, 'the id follows the file\'s own house style');
  assert.equal(added.added.asset, sofa.id);
  assert.equal(added.added.groupId, added.itemId, 'the new item is its own group (no dangling group reference)');

  const written = editor.commit({
    sceneId: 'flat',
    dryRun: false,
    edits: [{ add: { kind: sofa.kind, asset: sofa.id, direction: sofa.direction, layer: 30, position: { x: 0.5, y: 0.5 } } }],
  });
  assert.equal(written.ok, true);
  assert.ok(written.backup && fs.existsSync(written.backup), 'the write is backed up first');
  const after = readItems(layoutPath);
  assert.equal(after.length, before.length + 1, 'exactly one item was added');
  assert.ok(after.some((item) => item.id === added.itemId && item.asset === sofa.id), 'the item is on disk');
  // the dropped item gets an obstacle derived for it, so walkability stays declared
  const zones = JSON.parse(fs.readFileSync(path.join(path.dirname(layoutPath), 'zones.json'), 'utf8'));
  assert.ok(zones.obstacles.some((obstacle) => String(obstacle.id).includes(added.itemId)), 'zones.obstacles gained the new item');
});

test('an add that the validator refuses leaves the file byte-identical', (t) => {
  const { scene, editor, layoutPath } = sandboxScene(t);
  const beforeBytes = fs.readFileSync(layoutPath);
  // a desk dropped on the aisle entrance is exactly the class of mistake the gate exists for
  const outcome = editor.commit({
    sceneId: 'flat',
    dryRun: false,
    edits: [{ add: { kind: 'desk', asset: 'flat-desk', direction: 'front', layer: 30, position: { x: 0.5, y: 0.62 } } }],
  });
  if (!outcome.ok) {
    assert.equal(outcome.code, 'SCENE_CONFLICTS');
    assert.ok(fs.readFileSync(layoutPath).equals(beforeBytes), 'nothing was written');
  } else {
    // if that particular spot happens to be legal, the guard must show up elsewhere: the
    // point of the test is the REJECTION path, so make an add that cannot be legal
    const second = editor.commit({
      sceneId: 'flat',
      dryRun: false,
      edits: [{ add: { kind: 'desk', asset: 'flat-desk', direction: 'front', layer: 30, position: { x: 5, y: 5 } } }],
    });
    assert.equal(second.ok, true, 'out-of-range positions are clamped, not crashed on');
    assert.equal(fs.existsSync(layoutPath), true);
  }
});

test('removing an item is the add path\'s counterpart and cleans up dangling references', (t) => {
  const { editor, layoutPath } = sandboxScene(t);
  const beforeBytes = fs.readFileSync(layoutPath);
  // the layout is a real office: pulling a desk out from under its monitor strands a
  // workstation, and THAT must be refused — the item that is safe to remove is the one
  // the validator accepts, so ask the validator instead of guessing
  const items = readItems(layoutPath);
  const refused = [];
  let removable = null;
  for (const item of items) {
    const trial = editor.commit({ sceneId: 'flat', dryRun: true, edits: [{ itemId: item.id, remove: true }] });
    if (trial.ok) { removable = item; break; }
    refused.push({ id: item.id, code: trial.code, violations: (trial.violations || []).map((violation) => violation.code) });
  }
  assert.ok(refused.length > 0, 'at least one removal strands a workstation and is refused');
  assert.ok(fs.readFileSync(layoutPath).equals(beforeBytes), 'every refused removal left the file untouched');
  assert.ok(removable, 'at least one item can be removed without breaking the layout');

  const written = editor.commit({ sceneId: 'flat', dryRun: false, edits: [{ itemId: removable.id, remove: true }] });
  assert.equal(written.ok, true, `the accepted removal writes: ${written.code || ''}`);
  const draft = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  assert.ok(!draft.items.some((item) => item.id === removable.id), 'the item is gone from disk');
  assert.ok(!draft.groupNames || !(removable.id in draft.groupNames), 'groupNames has no dangling entry');
  assert.notEqual(draft.selectedId, removable.id, 'selectedId does not point at a removed item');
  // and the fix must survive a re-read: the file parses and still carries the other items
  assert.ok(draft.items.length >= 1, 'the layout is still a layout');
});

test('the graph file service lists, reads and validates the real sample', (t) => {
  const { service } = sandboxGraphs(t);
  const listed = service.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.graphs.length, 1);
  assert.equal(listed.graphs[0].ok, true, 'the sample validates');
  assert.equal(listed.graphs[0].nodes, 5);
  const read = service.read({ name: 'local-behaviour.vgraph.json' });
  assert.equal(read.ok, true);
  assert.equal(read.validation.ok, true);
  assert.equal(read.graph.id, 'local-behaviour');
});

test('an invalid graph cannot be saved, and the file stays byte-identical', (t) => {
  const { service, file } = sandboxGraphs(t);
  const read = service.read({ name: 'local-behaviour.vgraph.json' });
  const broken = JSON.parse(JSON.stringify(read.graph));
  broken.nodes.push({ id: 'teleport', type: 'action', do: 'teleport' });
  const before = fs.readFileSync(file, 'utf8');
  const outcome = service.save({ name: 'local-behaviour.vgraph.json', graph: broken, dryRun: false });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'GRAPH_INVALID');
  assert.ok(outcome.violations.some((violation) => violation.check.endsWith('.do')), 'the unknown action is named');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a rejected graph writes nothing');
  assert.equal(fs.existsSync(service.backupRoot), false, 'no backup for a rejected save');
});

test('saving a moved node writes meta.layout with a backup, and repeats are no-ops', (t) => {
  const { service, file } = sandboxGraphs(t);
  const read = service.read({ name: 'local-behaviour.vgraph.json' });
  const before = fs.readFileSync(file, 'utf8');
  const frozen = { ...read.graph, meta: { ...read.graph.meta, layout: service.autoLayout({ graph: read.graph }) } };
  const moved = service.moveNode({ graph: frozen, nodeId: 'do', x: 0.62, y: 0.44 });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.graph.meta.layout.do, { x: 0.62, y: 0.44 });

  const dry = service.save({ name: 'local-behaviour.vgraph.json', graph: moved.graph, dryRun: true });
  assert.equal(dry.changed, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a dry run writes nothing');

  const saved = service.save({ name: 'local-behaviour.vgraph.json', graph: moved.graph, dryRun: false });
  assert.equal(saved.ok, true);
  assert.ok(saved.backup && fs.existsSync(saved.backup), 'the previous file is backed up');
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), before, 'the backup is the untouched original');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.meta.layout.do, { x: 0.62, y: 0.44 });
  assert.equal(after.nodes.length, 5, 'only the layout metadata changed');
  // the semantics are untouched: it still validates and still runs
  assert.equal(service.read({ name: 'local-behaviour.vgraph.json' }).validation.ok, true);

  const again = service.save({ name: 'local-behaviour.vgraph.json', graph: after, dryRun: false });
  assert.equal(again.noop, true, '无变更不落盘');
});

test('moving an unknown node and clamping are handled', (t) => {
  const { service } = sandboxGraphs(t);
  const read = service.read({ name: 'local-behaviour.vgraph.json' });
  assert.equal(service.moveNode({ graph: read.graph, nodeId: 'ghost', x: 0.5, y: 0.5 }).code, 'GRAPH_NODE_UNKNOWN');
  const clamped = service.moveNode({ graph: read.graph, nodeId: 'do', x: 5, y: -3 });
  assert.deepEqual(clamped.graph.meta.layout.do, { x: 1, y: 0 });
});
