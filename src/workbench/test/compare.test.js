'use strict';

// src/workbench/test/compare.test.js — the edit/run comparison model
// (workbench UX rectification, gap #3: 运行层可观测性).
//
// The overlay's promise is that what it draws lines up with the runtime picture:
// normalized coordinates → the scene's own pixel space, every mark inside the
// world, and an edge whose endpoint is missing dropped rather than guessed. The
// second half of the acceptance is that the DERIVED half is real: the test builds
// the model from the real scene's own waypoint graph (read-only, through the
// studio scene services) and asserts the overlay has something to draw.
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { SCENE_FALLBACK, buildCompareModel } = require('../app/compare.js');

test('normalized positions become pixels in the scene\'s own space', () => {
  const model = buildCompareModel({
    nodes: [{ id: 'a', position: { x: 0.5, y: 0.25 } }],
    width: 1280,
    height: 840,
  });
  assert.deepEqual(model.nodes, [{ id: 'a', x: 640, y: 210 }]);
  assert.equal(model.width, 1280);
  assert.equal(model.height, 840);
});

test('coordinates are clamped into the world, never drawn outside it', () => {
  const model = buildCompareModel({
    nodes: [{ id: 'a', position: { x: 1.4, y: -0.2 } }, { id: 'b', position: { x: 0.5, y: 0.5 } }],
    employees: [{ employeeId: 'e', position: { x: 2, y: -1 } }],
    stations: [{ id: 's', position: { x: -0.5, y: 1.5 } }],
    width: 1000,
    height: 500,
  });
  assert.deepEqual(model.nodes[0], { id: 'a', x: 1000, y: 0 });
  assert.deepEqual(model.nodes[1], { id: 'b', x: 500, y: 250 });
  assert.deepEqual(model.employees[0], { id: 'e', x: 1000, y: 0 });
  assert.deepEqual(model.stations[0], { id: 's', x: 0, y: 500 });
});

test('an edge is dropped when either endpoint is missing', () => {
  const model = buildCompareModel({
    nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'a' }],
    width: 10,
    height: 10,
  });
  assert.equal(model.edges.length, 1, 'the edge to a known node survives');
  assert.deepEqual(model.edges[0], { from: 'a', to: 'a', x1: 0, y1: 0, x2: 0, y2: 0 });
});

test('a missing size falls back to the flat scene instead of dividing by zero', () => {
  const model = buildCompareModel({ nodes: [{ id: 'a', position: { x: 0.5, y: 0.5 } }] });
  assert.deepEqual(SCENE_FALLBACK, { width: 1280, height: 840 });
  assert.deepEqual(model.nodes[0], { id: 'a', x: 640, y: 420 });
  const zero = buildCompareModel({ nodes: [{ id: 'a', position: { x: 0.5, y: 0.5 } }], width: 0, height: 0 });
  assert.deepEqual(zero.nodes[0], { id: 'a', x: 640, y: 420 }, 'a zero size is not a size');
});

test('junk inputs produce an empty model, not a crash', () => {
  const model = buildCompareModel({ nodes: null, edges: 'nope', stations: 42, employees: undefined });
  assert.deepEqual(model.summary(), { nodes: 0, edges: 0, stations: 0, employees: 0 });
});

test('the REAL scene\'s derived graph fills the overlay', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
  const { createSceneServices } = require(path.join(REPO_ROOT, 'studio', 'lib', 'scene', 'index.js'));
  const scene = createSceneServices({ repoRoot: REPO_ROOT, contentDir: path.join(REPO_ROOT, 'content') });
  const graph = scene.waypoints({ sceneId: 'flat' });
  assert.equal(graph.ok, true, `the real waypoint graph loads (${graph.code || ''})`);
  const draft = scene.boxes({ sceneId: 'flat' });
  assert.equal(draft.ok, true);
  const stations = (draft.items || []).filter((item) => item.kind === 'desk').map((item) => ({ id: item.id, position: item.position }));

  const model = buildCompareModel({
    nodes: graph.nodes,
    edges: graph.edges,
    stations,
    employees: [{ employeeId: 'orchestrator', position: { x: 0.5, y: 0.5 } }],
    width: 1280,
    height: 840,
  });
  const counts = model.summary();
  assert.ok(counts.nodes > 0, `the derived graph has walk points (${counts.nodes})`);
  assert.ok(counts.edges > 0, `and edges (${counts.edges})`);
  assert.ok(counts.stations >= 6, `and the flat scene's six desks are workstations (${counts.stations})`);
  assert.equal(counts.employees, 1);
  // every mark is inside the scene
  for (const node of model.nodes) {
    assert.ok(node.x >= 0 && node.x <= 1280 && node.y >= 0 && node.y <= 840, `${node.id} is inside the world`);
  }
});
