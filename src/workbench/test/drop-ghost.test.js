'use strict';

// src/workbench/test/drop-ghost.test.js — the drag landing preview's box maths
// (workbench UX rectification, gap #5: 拖拽落点预览).
//
// The ghost is a promise about what the transaction will place, so its box must
// be the transaction's box: `draftWidth * scale` wide, height from the asset's
// content bbox ratio, centred on the drop point (studio/lib/scene/geometry.js
// artBoxPx). The catalog is the single source for the two numbers — this module
// takes them as arguments, so a test can pin the maths without a catalog.
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCENE_FALLBACK, ghostBoxFor } = require('../lib/drop-ghost.js');

test('the box is centred on the drop point, in scene pixels', () => {
  const box = ghostBoxFor({
    draftWidth: 120,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    position: { x: 0.5, y: 0.5 },
    scene: { width: 1280, height: 840 },
  });
  assert.deepEqual(box, { x: 640 - 60, y: 420 - 60, width: 120, height: 120 });
});

test('the height comes from the asset\'s content bbox ratio', () => {
  // a 1024×1024 pilot PNG whose opaque art covers only the top half
  const box = ghostBoxFor({
    draftWidth: 180,
    bbox: { x: 0.1, y: 0.2, w: 0.8, h: 0.4 },
    position: { x: 0, y: 0 },
    scene: { width: 1000, height: 500 },
  });
  assert.equal(box.width, 180, 'the width is the catalog draft width, not the image size');
  assert.equal(box.height, 90, 'the height is width * bbox.h/bbox.w');
  assert.equal(box.x, -90, 'at position 0,0 the box hangs off the top-left corner, centred on the point');
  assert.equal(box.y, -45);
});

test('scale widens the box the way the transaction scales it', () => {
  const base = ghostBoxFor({ draftWidth: 110, bbox: null, position: { x: 0.5, y: 0.5 }, scale: 1, scene: { width: 1280, height: 840 } });
  const big = ghostBoxFor({ draftWidth: 110, bbox: null, position: { x: 0.5, y: 0.5 }, scale: 2, scene: { width: 1280, height: 840 } });
  assert.equal(base.width, 110);
  assert.equal(big.width, 220, 'a 2× ghost is a 2× box');
  assert.equal(big.height, base.height * 2);
});

test('a missing bbox or width degrades to a sane box, never NaN', () => {
  const noBbox = ghostBoxFor({ draftWidth: 105, position: { x: 0.25, y: 0.75 }, scene: { width: 800, height: 600 } });
  assert.deepEqual(noBbox, { x: 200 - 52.5, y: 450 - 52.5, width: 105, height: 105 });
  const noWidth = ghostBoxFor({ draftWidth: null, bbox: { w: 2, h: 1 }, position: { x: 0.5, y: 0.5 }, scene: { width: 100, height: 100 } });
  assert.equal(noWidth.width, 120, 'a missing draft width falls back to the prop shelf width');
  assert.equal(noWidth.height, 60);
  const noScene = ghostBoxFor({ draftWidth: 120, bbox: null, position: { x: 0.5, y: 0.5 } });
  assert.deepEqual(SCENE_FALLBACK, { width: 1280, height: 840 });
  assert.equal(noScene.x, 640 - 60, 'a missing scene size uses the flat scene\'s, not zero');
});

test('the catalog\'s own numbers reproduce the transaction\'s box for a placed item', () => {
  // cross-check against the real scene: an existing item's box (from sceneDraft)
  // must equal what ghostBoxFor computes from the catalog for the same asset,
  // scale and position — that is the whole promise of the ghost
  const path = require('node:path');
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
  const { createSceneServices } = require(path.join(REPO_ROOT, 'studio', 'lib', 'scene', 'index.js'));
  const scene = createSceneServices({ repoRoot: REPO_ROOT, contentDir: path.join(REPO_ROOT, 'content') });
  const draft = scene.boxes({ sceneId: 'flat' });
  assert.equal(draft.ok, true);
  const layoutAssets = require(path.join(REPO_ROOT, 'src', 'office', 'layout-assets.js'));
  const item = (draft.items || []).find((entry) => entry.box && entry.kind !== 'character');
  assert.ok(item, 'the flat scene has a placed furniture item');
  const asset = layoutAssets.layoutAssetById(item.asset);
  const ghost = ghostBoxFor({
    draftWidth: layoutAssets.DRAFT_WIDTHS[item.kind],
    bbox: asset && asset.contentBbox,
    position: item.position,
    scale: item.scale,
    scene: draft.scene,
  });
  assert.ok(Math.abs(ghost.width - item.box.width) < 0.5, `the ghost width matches the placed box (${ghost.width} vs ${item.box.width})`);
  assert.ok(Math.abs(ghost.height - item.box.height) < 0.5, `the ghost height matches the placed box (${ghost.height} vs ${item.box.height})`);
  assert.ok(Math.abs(ghost.x - item.box.x) < 0.5, 'and so does the position');
});
