'use strict';

// Task 3 / SPEC-03 — pure asset resolver over the Task 2 normalized pack
// schema. RED: src/office/runtime/asset-pack.js does not exist yet.
//
// Contracts under test:
// - in-memory manifest/anchors/animations input only (module never reads files)
// - dedicated -> static pose -> directional pose -> programmatic emphasis
// - explicit ANIMATION_CAPABILITY_MISSING results (never a silent null)
// - stable diagnostics for malformed metadata (no thrown errors)
// - visibleHeight = clamp(64, sceneHeight * 0.11, 180) shared by all states
// - Task 2 fixture pack and deepseek-default fallback pack both resolve

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { existsSync, mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createLayoutEditor } = require('../src/office/layout-editor.js');

const assetPack = require('../src/office/runtime/asset-pack.js');
const { normalizeWorkstationDraft } = require('../src/office/runtime/workstation-layout.js');

const WORKSTATION_DRAFT = require('./fixtures/office-layout-draft.json');
const CANONICAL_OFFICE_LAYOUT = require('../src/office/fixtures/office-layout.json');

function cloneDraft() {
  return JSON.parse(JSON.stringify(WORKSTATION_DRAFT));
}

function assertNear(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
}

test('normalizes six complete nearest-desk groups in row-major order', () => {
  const normalized = normalizeWorkstationDraft(cloneDraft());

  assert.deepEqual(normalized.instances.map((instance) => instance.deskId), [
    'desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6',
  ]);
  assert.deepEqual(normalized.instances.map((instance) => instance.position), [
    { x: 0.525342, y: 0.22824 },
    { x: 0.724977, y: 0.21912 },
    { x: 0.517953, y: 0.538004 },
    { x: 0.719966, y: 0.529816 },
    { x: 0.512399, y: 0.815917 },
    { x: 0.710907, y: 0.808513 },
  ]);
  for (const instance of normalized.instances) {
    assert.equal(instance.seat.id, instance.deskId);
    assert.equal(instance.approach.id, `${instance.deskId}-approach`);
    assert.equal(instance.approach.nodeId, `${instance.deskId}-approach`);
    assert.equal(instance.leave.id, `${instance.deskId}-leave`);
    assert.equal(instance.leave.nodeId, `${instance.deskId}-leave`);
    assert.ok(instance.approach.position.x > instance.seat.position.x, 'approach is right of seat');
    assert.ok(instance.approach.position.y > instance.seat.position.y, 'approach is below seat');
    assert.ok(instance.leave.position.y >= instance.approach.position.y, 'leave continues toward the aisle');
  }
});

test('derives one averaged workstation template from the measured draft offsets', () => {
  const { template } = normalizeWorkstationDraft(cloneDraft());

  assert.deepEqual(template.desk, {
    assetId: 'prop-desk-back-right-top',
    offset: { x: 0, y: 0 },
    scale: 1,
    layer: 'back-furniture',
  });
  assert.equal(template.monitor.assetId, 'prop-monitor-back-right-top');
  assert.equal(template.monitor.scale, 1);
  assert.equal(template.monitor.layer, 'back-furniture');
  assert.equal(template.chair.assetId, 'prop-chair-front-left-top');
  assert.equal(template.chair.scale, 1);
  assert.equal(template.chair.layer, 'back-furniture');
  assertNear(template.monitor.offset.x, 0.0027061666666666575);
  assertNear(template.monitor.offset.y, -0.09263600000000001);
  assertNear(template.chair.offset.x, 0.07433716666666668);
  assertNear(template.chair.offset.y, -0.038946);
  assertNear(template.seat.offset.x, 0.05471883333333335);
  assertNear(template.seat.offset.y, -0.10325133333333335);
});

test('rejects incomplete, duplicate, and ambiguous nearest-desk groups', () => {
  const missing = cloneDraft();
  missing.items = missing.items.filter((item) => item.id !== 'draft-5');
  assert.throws(() => normalizeWorkstationDraft(missing), /WORKSTATION_MEMBER_MISSING/);

  const duplicate = cloneDraft();
  duplicate.items.push({ ...duplicate.items.find((item) => item.id === 'draft-5'), id: 'extra-monitor' });
  assert.throws(() => normalizeWorkstationDraft(duplicate), /WORKSTATION_MEMBER_DUPLICATE/);

  const ambiguous = cloneDraft();
  const desks = ambiguous.items.filter((item) => item.kind === 'desk').sort((a, b) => a.position.x - b.position.x);
  const monitor = ambiguous.items.find((item) => item.id === 'draft-5');
  monitor.position = {
    x: (desks[0].position.x + desks[1].position.x) / 2,
    y: (desks[0].position.y + desks[1].position.y) / 2,
  };
  assert.throws(() => normalizeWorkstationDraft(ambiguous), /WORKSTATION_MEMBER_AMBIGUOUS/);
});

test('rejects duplicate item IDs before grouping', () => {
  const duplicateId = cloneDraft();
  duplicateId.items[1].id = duplicateId.items[0].id;
  assert.throws(() => normalizeWorkstationDraft(duplicateId), /DRAFT_ITEM_ID_DUPLICATE/);
});

test('calibration characters define seat anchors but are excluded from furniture', () => {
  const normalized = normalizeWorkstationDraft(cloneDraft());
  assert.deepEqual(Object.keys(normalized.template), ['desk', 'monitor', 'chair', 'seat']);
  assert.equal(JSON.stringify(normalized).includes('whale-girl-front'), false);
  assert.equal(normalized.instances.every((instance) => !Object.hasOwn(instance, 'character')), true);
});

test('the canonical workstation block is the deterministic normalized draft output', () => {
  assert.deepEqual(normalizeWorkstationDraft(cloneDraft()), {
    template: CANONICAL_OFFICE_LAYOUT.workstations.template,
    instances: CANONICAL_OFFICE_LAYOUT.workstations.instances,
  });
});

const FIXTURE_ROOT = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
const DEFAULT_ROOT = path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default');
const REMOVE_BG_SCRIPT = path.join(__dirname, '..', 'scripts', 'remove-bg.py');

const FIXTURE = {
  manifest: require(path.join(FIXTURE_ROOT, 'manifest.json')),
  anchors: require(path.join(FIXTURE_ROOT, 'animation', 'anchors.json')),
  animations: require(path.join(FIXTURE_ROOT, 'animation', 'animations.json')),
};

const DEFAULT_PACK = {
  manifest: require(path.join(DEFAULT_ROOT, 'manifest.json')),
  anchors: require(path.join(DEFAULT_ROOT, 'animation', 'anchors.json')),
  animations: require(path.join(DEFAULT_ROOT, 'animation', 'animations.json')),
};

function makePack({ manifest, anchors, animations } = {}) {
  const result = assetPack.createAssetPack({
    manifest: manifest || FIXTURE.manifest,
    anchors: anchors || FIXTURE.anchors,
    animations: animations || FIXTURE.animations,
  });
  assert.ok(result.ok, `test pack must build: ${JSON.stringify(result.errors || [])}`);
  return result.pack;
}

const minimalAnchors = {
  schemaVersion: 1,
  sourceCanvas: { width: 64, height: 64 },
  outputCanvas: { width: 64, height: 64 },
  outputScale: 1,
  anchor: { x: 32, y: 60 },
  visibleBounds: { x: 22, y: 12, width: 21, height: 49 },
  frames: {},
};

function minimalManifest(overrides) {
  return {
    schemaVersion: 1,
    id: 'test-pack',
    version: '1.0.0',
    author: 'test',
    license: 'test-license',
    runtimeCompatibility: { schema: 1 },
    geometry: 'animation/anchors.json',
    animations: 'animation/animations.json',
    fallback: { allowStaticPose: true, allowProgrammaticEmphasis: true },
    ...overrides,
  };
}

function animationsWith(entries, defaults) {
  return {
    schemaVersion: 1,
    defaultFrameDurationMs: 1000,
    ...(defaults || {}),
    animations: entries,
  };
}

test('resolves the dedicated walk animation from the Task 2 fixture pack', () => {
  const pack = makePack();
  const result = pack.resolve({ state: 'walk', direction: 'left' });
  assert.equal(result.code, 'RESOLVED');
  assert.equal(result.resource, 'walk-left');
  assert.equal(result.frameCount, 4);
  assert.equal(result.loop, true);
  assert.equal(result.fallbackReason, null);
  assert.deepEqual(result.capabilityMissing, []);
});

test('falls back to the static idle pose for a missing optional state', () => {
  const pack = makePack();
  const result = pack.resolve({ state: 'sleeping' });
  assert.equal(result.code, 'RESOLVED');
  assert.equal(result.resource, 'idle');
  assert.equal(result.fallbackReason, 'STATIC_POSE_FALLBACK');
  assert.deepEqual(result.capabilityMissing, ['sleeping']);
});

test('returns ANIMATION_CAPABILITY_MISSING when fallbacks are disabled', () => {
  const pack = makePack({
    manifest: minimalManifest({ fallback: { allowStaticPose: false, allowProgrammaticEmphasis: false } }),
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'assets/expressions/idle.png', durationMs: null }] },
      'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [{ file: 'assets/walk/left.png', durationMs: null }] },
      'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [{ file: 'assets/walk/right.png', durationMs: null }] },
      'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [{ file: 'assets/walk/up.png', durationMs: null }] },
      'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [{ file: 'assets/walk/down.png', durationMs: null }] },
      working: { state: 'working', direction: 'none', loop: false, frames: [{ file: 'assets/expressions/working.png', durationMs: null }] },
    }),
  });
  const result = pack.resolve({ state: 'sleeping' });
  assert.equal(result.code, 'ANIMATION_CAPABILITY_MISSING');
  assert.equal(result.resource, null);
  assert.equal(result.fallbackReason, 'ANIMATION_CAPABILITY_MISSING');
  assert.deepEqual(result.capabilityMissing, ['sleeping']);
});

test('uses the compatible directional pose when no static fallback exists', () => {
  const pack = makePack({
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'assets/expressions/idle.png', durationMs: null }] },
      'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [{ file: 'assets/walk/left.png', durationMs: null }] },
      'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [{ file: 'assets/walk/right.png', durationMs: null }] },
      'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [{ file: 'assets/walk/up.png', durationMs: null }] },
      'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [{ file: 'assets/walk/down.png', durationMs: null }] },
      'side-back': { state: 'side', direction: 'none', loop: false, frames: [{ file: 'assets/side-back.png', durationMs: null }] },
    }),
  });
  const result = pack.resolve({ state: 'thinking' });
  assert.equal(result.code, 'RESOLVED');
  assert.equal(result.resource, 'side-back');
  assert.equal(result.fallbackReason, 'DIRECTIONAL_POSE_FALLBACK');
  assert.deepEqual(result.capabilityMissing, ['thinking']);
});

test('applies declared programmatic emphasis after pose fallbacks fail', () => {
  const pack = makePack({
    manifest: minimalManifest({ fallback: { allowStaticPose: false, allowProgrammaticEmphasis: true } }),
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'assets/expressions/idle.png', durationMs: null }] },
      'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [{ file: 'assets/walk/left.png', durationMs: null }] },
      'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [{ file: 'assets/walk/right.png', durationMs: null }] },
      'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [{ file: 'assets/walk/up.png', durationMs: null }] },
      'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [{ file: 'assets/walk/down.png', durationMs: null }] },
      working: { state: 'working', direction: 'none', loop: false, frames: [{ file: 'assets/expressions/working.png', durationMs: null }] },
    }),
  });
  const result = pack.resolve({ state: 'failed' });
  assert.equal(result.code, 'RESOLVED');
  assert.equal(result.resource, null);
  assert.equal(result.emphasis, 'shake');
  assert.equal(result.fallbackReason, 'PROGRAMMATIC_EMPHASIS_FALLBACK');

  const disallowed = makePack({
    manifest: minimalManifest({ fallback: { allowStaticPose: false, allowProgrammaticEmphasis: false } }),
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'assets/expressions/idle.png', durationMs: null }] },
      'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [{ file: 'assets/walk/left.png', durationMs: null }] },
      'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [{ file: 'assets/walk/right.png', durationMs: null }] },
      'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [{ file: 'assets/walk/up.png', durationMs: null }] },
      'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [{ file: 'assets/walk/down.png', durationMs: null }] },
      working: { state: 'working', direction: 'none', loop: false, frames: [{ file: 'assets/expressions/working.png', durationMs: null }] },
    }),
  });
  assert.equal(disallowed.resolve({ state: 'failed' }).code, 'ANIMATION_CAPABILITY_MISSING');
});

test('never resolves the offline state even when the pack declares it', () => {
  const pack = makePack();
  const result = pack.resolve({ state: 'offline' });
  assert.equal(result.code, 'ANIMATION_CAPABILITY_MISSING');
  assert.equal(result.resource, null);
});

test('reports a stable diagnostic for malformed geometry instead of throwing', () => {
  const result = assetPack.createAssetPack({
    manifest: minimalManifest(),
    anchors: {
      ...minimalAnchors,
      anchor: { x: 999, y: 999 },
    },
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'a.png', durationMs: null }] },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PACK_GEOMETRY_INVALID');
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test('reports a stable diagnostic for malformed animation metadata', () => {
  const result = assetPack.createAssetPack({
    manifest: minimalManifest(),
    anchors: minimalAnchors,
    animations: animationsWith({
      idle: { state: 'idle', direction: 'diagonal', loop: true, frames: [{ file: 'a.png', durationMs: null }] },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PACK_MANIFEST_INVALID');
});

test('reports a stable diagnostic for an invalid manifest', () => {
  const result = assetPack.createAssetPack({
    manifest: minimalManifest({ license: '' }),
    anchors: minimalAnchors,
    animations: animationsWith({
      idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'a.png', durationMs: null }] },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PACK_MANIFEST_INVALID');
});

test('missing required capabilities invalidate the pack, optional ones do not', () => {
  const missingRequired = assetPack.createAssetPack({
    manifest: minimalManifest(),
    anchors: minimalAnchors,
    animations: animationsWith({
      working: { state: 'working', direction: 'none', loop: false, frames: [{ file: 'w.png', durationMs: null }] },
    }),
  });
  assert.equal(missingRequired.ok, false);
  assert.equal(missingRequired.code, 'PACK_ASSET_MISSING');

  const missingOptional = makePack();
  assert.equal(missingOptional.resolve({ state: 'walk', direction: 'up' }).code, 'RESOLVED');
});

test('computeVisibleHeight clamps to [64, 180]', () => {
  assert.equal(assetPack.computeVisibleHeight(400), 64);
  assert.equal(assetPack.computeVisibleHeight(1000), 110);
  assert.equal(assetPack.computeVisibleHeight(2000), 180);
  assert.equal(assetPack.computeVisibleHeight(10000), 180);
  assert.equal(assetPack.computeVisibleHeight(0), 64);
});

test('all animation states share one computed visible height per employee', () => {
  const pack = makePack();
  const sceneHeight = 800;
  const height = assetPack.computeVisibleHeight(sceneHeight);
  assert.equal(height, 88);
  const scaleFor = () => assetPack.computeSpriteScale(pack.geometry, height);
  for (const request of [
    { state: 'walk', direction: 'left' },
    { state: 'working' },
    { state: 'sleeping' },
    { state: 'celebrating' },
  ]) {
    const selection = pack.resolve(request);
    assert.equal(selection.code, 'RESOLVED');
    assert.equal(assetPack.computeSpriteScale(pack.geometry, height), scaleFor());
  }
});

test('frameGeometry resolves normalized anchors from anchors.json', () => {
  const pack = makePack();
  const frame = pack.frameGeometry('walk-left', 0);
  assert.equal(frame.file, 'assets/animations/walk/left/walk-left-01.png');
  assert.deepEqual(frame.outputAnchor, { x: 178, y: 296 });
  assert.deepEqual(frame.sourceAnchor, { x: 141, y: 247 });
  assert.equal(frame.outputScale, 1.375);
  assert.deepEqual(frame.outputCanvas, { width: 352, height: 352 });
  assert.deepEqual(frame.visibleBounds, { x: 37, y: 49, width: 256, height: 256 });

  assert.equal(pack.frameGeometry('walk-left', 4).code, 'FRAME_INDEX_OUT_OF_RANGE');
  assert.equal(pack.frameGeometry('nope', 0).code, 'ANIMATION_NOT_FOUND');
});

test('deepseek-default fallback pack resolves dedicated and fallback states', () => {
  const pack = makePack(DEFAULT_PACK);
  // the whale pack has no dedicated completed pose: the stable static chain
  // lands on `finished` and reports the missing capability explicitly
  const completed = pack.resolve({ state: 'completed' });
  assert.equal(completed.code, 'RESOLVED');
  assert.equal(completed.resource, 'finished');
  assert.equal(completed.fallbackReason, 'STATIC_POSE_FALLBACK');

  const celebrating = pack.resolve({ state: 'celebrating' });
  assert.equal(celebrating.resource, 'finished');
  assert.equal(celebrating.fallbackReason, 'STATIC_POSE_FALLBACK');
  assert.deepEqual(celebrating.capabilityMissing, ['celebrating']);

  const attention = pack.resolve({ state: 'attention' });
  assert.equal(attention.resource, 'warning', 'the warning pose covers attention on the static chain');
  assert.equal(attention.fallbackReason, 'STATIC_POSE_FALLBACK');
});

test('deepseek-default top-level anchors apply to every frame', () => {
  const pack = makePack(DEFAULT_PACK);
  for (const resource of ['idle', 'walk-left', 'walk-right', 'walk-up', 'walk-down', 'working']) {
    const frame = pack.frameGeometry(resource, 0);
    assert.deepEqual(frame.outputAnchor, pack.geometry.anchor, `${resource} shares the pack foot anchor`);
    assert.deepEqual(frame.outputCanvas, pack.geometry.outputCanvas, `${resource} shares the pack canvas`);
    const bounds = frame.visibleBounds;
    assert.ok(bounds.x >= 0 && bounds.y >= 0
      && bounds.x + bounds.width <= frame.outputCanvas.width
      && bounds.y + bounds.height <= frame.outputCanvas.height, `${resource} visibleBounds stay inside the canvas`);
    // the canvas matches the real normalized PNG bytes on disk
    const file = path.join(DEFAULT_ROOT, frame.file);
    const png = fs.readFileSync(file);
    assert.equal(png.readUInt32BE(16), pack.geometry.outputCanvas.width, `${resource} png width`);
    assert.equal(png.readUInt32BE(20), pack.geometry.outputCanvas.height, `${resource} png height`);
  }
});

test('fixture pack reports exactly the Task 2 missing capabilities', () => {
  const pack = makePack();
  assert.deepEqual(pack.missingCapabilities(), [
    'sleeping',
    'completed',
    'failed',
    'attention',
    'thinking',
    'waiting',
    'celebrating',
    'chatting',
  ]);
});

test('resolver output is deterministic and frozen', () => {
  const pack = makePack();
  const a = pack.resolve({ state: 'walk', direction: 'left' });
  const b = pack.resolve({ state: 'walk', direction: 'left' });
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true);
});

test('remove-bg keeps canvas corners transparent while preserving the subject', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-remove-bg-'));
  const inputDir = path.join(tempRoot, 'input');
  const outputDir = path.join(tempRoot, 'output');
  const inputPath = path.join(inputDir, 'prop-fixture.png');
  const outputPath = path.join(outputDir, 'prop-fixture.png');
  mkdirSync(inputDir);

  execFileSync('python3', [
    '-c',
    [
      'from PIL import Image',
      'image = Image.new("RGB", (9, 9), "white")',
      'for y in range(3, 6):',
      '    for x in range(3, 6):',
      '        image.putpixel((x, y), (20, 80, 160))',
      `image.save(${JSON.stringify(inputPath)})`,
    ].join('\n'),
  ]);
  execFileSync('python3', [REMOVE_BG_SCRIPT, inputDir, outputDir]);

  const alpha = JSON.parse(execFileSync('python3', [
    '-c',
    [
      'import json, sys',
      'from PIL import Image',
      'alpha = Image.open(sys.argv[1]).convert("RGBA").getchannel("A")',
      'print(json.dumps({',
      '    "corners": [alpha.getpixel((0, 0)), alpha.getpixel((8, 0)), alpha.getpixel((0, 8)), alpha.getpixel((8, 8))],',
      '    "center": alpha.getpixel((4, 4)),',
      '}))',
    ].join('\n'),
    outputPath,
  ], { encoding: 'utf8' }));

  assert.deepEqual(alpha.corners, [0, 0, 0, 0]);
  assert.equal(alpha.center, 255);
});

test('remove-bg processes working animation candidates', () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-remove-bg-working-'));
  const inputDir = path.join(tempRoot, 'input');
  const outputDir = path.join(tempRoot, 'output');
  const inputPath = path.join(inputDir, 'working-fixture.png');
  const outputPath = path.join(outputDir, 'working-fixture.png');
  mkdirSync(inputDir);

  execFileSync('python3', [
    '-c',
    'from PIL import Image; import sys; Image.new("RGB", (3, 3), "white").save(sys.argv[1])',
    inputPath,
  ]);
  execFileSync('python3', [REMOVE_BG_SCRIPT, inputDir, outputDir]);

  assert.equal(existsSync(outputPath), true);
});

test('layout editor adds and moves draft items in normalized scene coordinates', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const item = editor.add({ kind: 'desk', asset: 'prop-desk-front', x: 0.4, y: 0.5 });
  assert.equal(item.id, 'draft-1');
  assert.deepEqual(item.position, { x: 0.4, y: 0.5 });

  const moved = editor.move(item.id, 120, -80);
  assert.deepEqual(moved.position, { x: 0.52, y: 0.4 });
  assert.deepEqual(editor.selected(), moved);
});

test('layout editor supports undo and redo without mutating returned drafts', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const item = editor.add({ kind: 'character', asset: 'whale-girl', x: 0.2, y: 0.3 });
  editor.move(item.id, 100, 0);
  assert.equal(editor.undo().position.x, 0.2);
  assert.equal(editor.redo().position.x, 0.3);
  const draft = editor.toJSON();
  draft.items[0].position.x = 0;
  assert.equal(editor.toJSON().items[0].position.x, 0.3);
});

test('layout editor groups a continuous drag into one undo step', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  const item = editor.add({ kind: 'chair', asset: 'prop-chair-front', x: 0.2, y: 0.3 });
  editor.move(item.id, 10, 0);
  editor.move(item.id, 10, 0, { recordHistory: false });
  editor.move(item.id, 0, 10, { recordHistory: false });
  editor.undo();
  assert.deepEqual(editor.selected().position, { x: 0.2, y: 0.3 });
});

test('layout editor clamps positions and removes selected items', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  const item = editor.add({ kind: 'monitor', asset: 'prop-monitor-front', x: 2, y: -1 });
  assert.deepEqual(item.position, { x: 1, y: 0 });
  assert.equal(editor.remove(item.id).id, item.id);
  assert.deepEqual(editor.toJSON().items, []);
});

test('layout editor asset catalog exposes every approved direction with existing PNG files', () => {
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  const counts = Object.fromEntries(['desk', 'chair', 'monitor', 'character', 'prop'].map((kind) => [
    kind,
    LAYOUT_ASSETS.filter((asset) => asset.kind === kind).length,
  ]));
  // Task E2c: the catalog gains the 10 single-image environment props
  // (kind 'prop') beside the directional furniture entries and 4 frames.
  // Task E3a: the flat-2D pilot adds one desk/monitor/chair each (+1/+1/+1).
  // Task E3e: the flat-2D left-half batch adds 20 more single-image 'prop'
  // entries (pantry / plants / lounge / vending variants / desk phone).
  // Task E4.6: the 8-direction isometric family (24 entries) is retired from
  // the palette — the visible catalog keeps one entry per furniture kind.
  assert.deepEqual(counts, { desk: 1, chair: 1, monitor: 1, character: 4, prop: 30 });
  assert.equal(new Set(LAYOUT_ASSETS.map((asset) => asset.id)).size, LAYOUT_ASSETS.length);
  for (const asset of LAYOUT_ASSETS) {
    // Task 8: character frames resolve from the PRODUCTION pack over the
    // managed characters/ route — the fixture tree stays test-only.
    // Task E2c: environment props live at the ./office-assets/ root.
    // Task E3a: the flat-2D pilot lives under the ./office-assets/flat/ namespace.
    // E3e: the flat batch keeps the flat/ namespace but its filenames are
    // flat-<name>.png, so the managed-URL shape allows both prefixes.
    assert.match(asset.src, /^\.\/(office-assets\/(layout-editor\/)?prop-|office-assets\/flat\/(prop|flat)-|characters\/deepseek-default\/).+\.png$/);
    const diskPath = asset.src.startsWith('./office-assets/')
      ? path.join(__dirname, '..', 'resources', 'office', asset.src.slice('./office-assets/'.length))
      : path.join(__dirname, '..', 'resources', asset.src.slice(2));
    assert.equal(existsSync(diskPath), true, `missing layout asset ${asset.id}: ${diskPath}`);
  }
});

// ---------------------------------------------------------------------------
// Task 3 — managed furniture textures for the golden workstation
// ---------------------------------------------------------------------------

test('canonical workstation furniture assets resolve to managed PNGs with renderer metadata', () => {
  const { layoutAssetById } = require('../src/office/layout-assets.js');
  const furnitureAssetIds = [...new Set(
    CANONICAL_OFFICE_LAYOUT.furniture.map((item) => item.assetId).filter(Boolean)
  )];
  assert.deepEqual(furnitureAssetIds.sort(), [
    'prop-chair-front-left-top',
    'prop-desk-back-right-top',
    'prop-monitor-back-right-top',
  ]);
  for (const assetId of furnitureAssetIds) {
    const asset = layoutAssetById(assetId);
    assert.ok(asset, `${assetId} is declared by the shared manifest`);
    assert.ok(['desk', 'chair', 'monitor'].includes(asset.kind), `${assetId} kind`);
    assert.ok(typeof asset.direction === 'string' && asset.direction.length > 0, `${assetId} direction metadata`);
    assert.equal(asset.layer, 'back-furniture', `${assetId} default layer matches the runtime furniture layer`);
    assert.equal(asset.scale, 1, `${assetId} default scale`);
    assert.ok(asset.anchor && Number.isFinite(asset.anchor.x) && Number.isFinite(asset.anchor.y), `${assetId} anchor metadata`);
    assert.match(asset.src, /^\.\/office-assets\/layout-editor\/prop-[a-z-]+\.png$/, `${assetId} managed relative URL`);
    assert.doesNotMatch(asset.src, /photo\/|artifacts\/|Downloads|\/Users\//, `${assetId} never points at personal or forbidden trees`);
    const diskPath = path.join(__dirname, '..', 'resources', 'office', asset.src.slice('./office-assets/'.length));
    assert.equal(existsSync(diskPath), true, `${assetId} exists under resources/office/layout-editor: ${diskPath}`);
  }
  assert.equal(layoutAssetById('prop-sofa-front'), null, 'unknown asset ids resolve to a stable null miss, never a guessed URL');
});

// ---------------------------------------------------------------------------
// Task 2 — layout editor schema-v1 round trip (load/scale/layer/group/undo)
// ---------------------------------------------------------------------------

function miniEditorDraft() {
  return {
    schemaVersion: 1,
    scene: { width: 1000, height: 800 },
    items: [
      { id: 'desk-a', kind: 'desk', asset: 'prop-desk-back-right-top', position: { x: 0.3, y: 0.3 }, scale: 1, direction: 'back-right-top' },
      { id: 'monitor-a', kind: 'monitor', asset: 'prop-monitor-back-right-top', position: { x: 0.31, y: 0.21 }, scale: 1, direction: 'back-right-top' },
      { id: 'chair-a', kind: 'chair', asset: 'prop-chair-front-left-top', position: { x: 0.37, y: 0.26 }, scale: 1, direction: 'front-left-top' },
      { id: 'hero-a', kind: 'character', asset: 'whale-girl-front', position: { x: 0.35, y: 0.2 }, scale: 1, direction: 'front' },
      { id: 'desk-b', kind: 'desk', asset: 'prop-desk-back-right-top', position: { x: 0.7, y: 0.3 }, scale: 1, direction: 'back-right-top' },
      { id: 'monitor-b', kind: 'monitor', asset: 'prop-monitor-back-right-top', position: { x: 0.71, y: 0.21 }, scale: 1, direction: 'back-right-top' },
    ],
    selectedId: 'desk-a',
  };
}

test('layout editor imports the committed raw draft with stable workstation groups', () => {
  const editor = createLayoutEditor({ scene: { width: 1280, height: 840 } });
  const result = editor.load(cloneDraft());
  assert.equal(result.ok, true);
  const draft = editor.toJSON();
  assert.equal(draft.items.length, 24);
  assert.equal(draft.selectedId, 'draft-24', 'a valid selectedId survives the import');
  const desks = draft.items.filter((item) => item.kind === 'desk');
  assert.deepEqual(desks.map((desk) => desk.id), ['draft-4', 'draft-6', 'draft-9', 'draft-13', 'draft-17', 'draft-21']);
  assert.equal(new Set(desks.map((desk) => Math.round(desk.position.x * 10))).size, 2, 'two desk columns');
  assert.equal(new Set(desks.map((desk) => Math.round(desk.position.y * 10))).size, 3, 'three desk rows');
  const memberCounts = new Map();
  for (const item of draft.items) {
    memberCounts.set(item.groupId, (memberCounts.get(item.groupId) || 0) + 1);
    if (item.kind === 'desk') continue;
    const nearest = desks.reduce((best, desk) => {
      const distance = (item.position.x - desk.position.x) ** 2 + (item.position.y - desk.position.y) ** 2;
      return !best || distance < best.distance ? { id: desk.id, distance } : best;
    }, null);
    assert.equal(item.groupId, nearest.id, `${item.id} joins its nearest desk group`);
  }
  for (const desk of desks) {
    assert.equal(memberCounts.get(desk.id), 4, `${desk.id} group holds desk+monitor+chair+character`);
  }
});

test('layout editor import defaults missing layer by kind and infers group ids from the nearest desk', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  assert.equal(editor.load(miniEditorDraft()).ok, true);
  const byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assert.equal(byId.get('desk-a').layer, 40);
  assert.equal(byId.get('monitor-a').layer, 10);
  assert.equal(byId.get('chair-a').layer, 20);
  assert.equal(byId.get('hero-a').layer, 30);
  assert.equal(byId.get('desk-a').groupId, 'desk-a', 'a desk owns its own group');
  assert.equal(byId.get('monitor-a').groupId, 'desk-a');
  assert.equal(byId.get('chair-a').groupId, 'desk-a');
  assert.equal(byId.get('hero-a').groupId, 'desk-a');
  assert.equal(byId.get('monitor-b').groupId, 'desk-b');
  assert.ok(byId.get('desk-a').layer > byId.get('chair-a').layer, 'larger layer draws in front');
});

test('layout editor import rejects malformed drafts with stable codes', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const cases = [
    ['DRAFT_SCHEMA_UNSUPPORTED', (draft) => { draft.schemaVersion = 2; }],
    ['DRAFT_SCENE_INVALID', (draft) => { draft.scene.width = 0; }],
    ['DRAFT_ITEMS_INVALID', (draft) => { draft.items = 'nope'; }],
    ['DRAFT_ITEM_ID_DUPLICATE', (draft) => { draft.items[1].id = draft.items[0].id; }],
    ['DRAFT_ITEM_ASSET_UNKNOWN', (draft) => { draft.items[0].asset = 'prop-sofa-back'; }],
    ['DRAFT_ITEM_KIND_MISMATCH', (draft) => { draft.items[0].kind = 'chair'; }],
    ['DRAFT_ITEM_POSITION_INVALID', (draft) => { draft.items[0].position.x = 1.5; }],
    ['DRAFT_ITEM_SCALE_INVALID', (draft) => { draft.items[0].scale = 0; }],
    ['DRAFT_ITEM_DIRECTION_INVALID', (draft) => { draft.items[0].direction = 'front'; }],
    ['DRAFT_ITEM_LAYER_INVALID', (draft) => { draft.items[0].layer = 'top'; }],
    ['DRAFT_GROUP_NO_DESK', (draft) => { draft.items = draft.items.filter((item) => item.kind !== 'desk'); }],
    ['DRAFT_GROUP_AMBIGUOUS', (draft) => {
      draft.items[1].position = {
        x: (draft.items[0].position.x + draft.items[4].position.x) / 2,
        y: (draft.items[0].position.y + draft.items[4].position.y) / 2,
      };
    }],
  ];
  for (const [code, mutate] of cases) {
    const draft = miniEditorDraft();
    mutate(draft);
    const result = editor.load(draft);
    assert.equal(result.ok, false, `${code} must be rejected`);
    assert.equal(result.code, code);
  }
  assert.equal(editor.load({ schemaVersion: 1, scene: { width: 10, height: 10 }, items: [] }).code, 'DRAFT_GROUP_NO_DESK');
});

test('a failed import leaves the current draft, selection and history untouched', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const added = editor.add({ kind: 'chair', asset: 'prop-chair-front', x: 0.2, y: 0.3 });
  editor.move(added.id, 50, 0);
  const before = editor.toJSON();
  const bad = miniEditorDraft();
  bad.items[0].asset = 'not-in-catalog';
  assert.equal(editor.load(bad).ok, false);
  assert.deepEqual(editor.toJSON(), before, 'a rejected import never partially replaces the draft');
  assert.equal(editor.selected().id, added.id);
  assert.equal(editor.undo().position.x, 0.2, 'history still works on the previous draft');
});

test('layout editor imports invalid or missing selectedId as null', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const missing = miniEditorDraft();
  delete missing.selectedId;
  editor.load(missing);
  assert.equal(editor.toJSON().selectedId, null);
  const invalid = miniEditorDraft();
  invalid.selectedId = 'ghost';
  editor.load(invalid);
  assert.equal(editor.toJSON().selectedId, null);
  const valid = miniEditorDraft();
  valid.selectedId = 'desk-a';
  editor.load(valid);
  assert.equal(editor.toJSON().selectedId, 'desk-a');
});

test('setScale and moveGroup compose with undo and redo', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  assert.equal(editor.load(miniEditorDraft()).ok, true);

  assert.equal(editor.setScale('desk-a', 1.5).scale, 1.5);
  assert.equal(editor.setScale('desk-a', -1), null, 'invalid scale is rejected');
  assert.equal(editor.setScale('ghost', 2), null, 'unknown id is rejected');
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').scale, 1.5, 'rejected calls do not mutate');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').scale, 1);
  editor.redo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').scale, 1.5);

  const before = editor.toJSON().items.filter((item) => item.groupId === 'desk-a').map((item) => item.position);
  const moved = editor.moveGroup('desk-a', 10, 20);
  assert.equal(moved.length, 4, 'the whole group moves');
  editor.undo();
  assert.deepEqual(
    editor.toJSON().items.filter((item) => item.groupId === 'desk-a').map((item) => item.position),
    before
  );
  editor.redo();
  // continuous drag: the first event records, the rest of the drag does not —
  // one undo returns to exactly the pre-drag position
  const dragStart = editor.toJSON().items.find((item) => item.id === 'desk-a').position;
  editor.moveGroup('desk-a', 5, 0);
  editor.moveGroup('desk-a', 5, 0, { recordHistory: false });
  assert.notDeepEqual(editor.toJSON().items.find((item) => item.id === 'desk-a').position, dragStart);
  editor.undo();
  assert.deepEqual(
    editor.toJSON().items.find((item) => item.id === 'desk-a').position,
    dragStart,
    'a continuous group drag stays one undo unit'
  );
});

test('group moves preserve member offsets and clamp to the scene', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  editor.load(miniEditorDraft());
  const moved = editor.moveGroup('desk-a', 5, 5);
  const movedById = new Map(moved.map((item) => [item.id, item.position]));
  for (const item of miniEditorDraft().items) {
    if (!movedById.has(item.id)) continue;
    assertNear(movedById.get(item.id).x - item.position.x, 0.05);
    assertNear(movedById.get(item.id).y - item.position.y, 0.05);
  }
  const edge = editor.moveGroup('desk-b', 40, 50);
  for (const item of edge) {
    assert.ok(item.position.x <= 1 && item.position.y <= 1, 'group members clamp to the scene');
  }
  const edgeById = new Map(edge.map((item) => [item.id, item.position]));
  assertNear(edgeById.get('desk-b').y, 0.8);
  assertNear(edgeById.get('monitor-b').y - 0.21, 0.5);
  assert.equal(editor.moveGroup('missing-group', 5, 5), null);
});

test('layer order operations swap one position, keep layer values and no-op at the edges', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  editor.load(miniEditorDraft());
  const order = () => editor.toJSON().items.map((item) => item.id);
  const layerOf = (id) => editor.toJSON().items.find((item) => item.id === id).layer;
  const initial = order();

  assert.equal(editor.bringForward('monitor-b').id, 'monitor-b', 'the forward edge returns the item');
  assert.deepEqual(order(), initial, 'the forward edge is a no-op');
  assert.equal(editor.sendBackward('desk-a').id, 'desk-a');
  assert.deepEqual(order(), initial, 'the backward edge is a no-op');

  editor.bringForward('desk-a');
  assert.deepEqual(order(), ['monitor-a', 'desk-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b']);
  assert.equal(layerOf('desk-a'), 40, 'ordering never rewrites layer values');
  assert.equal(layerOf('monitor-a'), 10);
  editor.sendBackward('desk-a');
  assert.deepEqual(order(), initial);

  // the edge no-ops recorded no history: one undo reverts exactly the last swap
  editor.undo();
  assert.deepEqual(order(), ['monitor-a', 'desk-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b']);
  editor.redo();
  assert.deepEqual(order(), initial);
});

test('layout editor exports whitelist fields and deep copies the state', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const draft = miniEditorDraft();
  draft.note = 'private scribble';
  draft.items[0].color = '#fff';
  assert.equal(editor.load(draft).ok, true);
  const exported = editor.toJSON();
  assert.equal(exported.schemaVersion, 1);
  assert.deepEqual(Object.keys(exported).sort(), ['groupNames', 'items', 'rigidGroups', 'scene', 'schemaVersion', 'selectedId', 'selectedIds'], 'unknown top-level fields are dropped (selectedIds E2a, groupNames E2e, rigidGroups E3b)');
  for (const item of exported.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['asset', 'direction', 'groupId', 'hidden', 'id', 'kind', 'layer', 'locked', 'name', 'position', 'scale'],
      'unknown item fields are dropped (locked/hidden/name join the whitelist in E2c)'
    );
  }
  exported.items[0].position.x = 0.9;
  exported.items[0].scale = 9;
  exported.selectedId = 'hacked';
  assert.equal(editor.toJSON().items[0].position.x, 0.3, 'exports are deep copies');
  assert.equal(editor.toJSON().items[0].scale, 1);
  assert.notEqual(editor.toJSON().selectedId, 'hacked');
});

test('auto-generated ids continue past imported draft-N ids', () => {
  const editor = createLayoutEditor({ scene: { width: 1280, height: 840 } });
  editor.load(cloneDraft());
  const importedIds = new Set(editor.toJSON().items.map((item) => item.id));
  const added = editor.add({ kind: 'desk', asset: 'prop-desk-front', x: 0.1, y: 0.1 });
  assert.equal(importedIds.has(added.id), false);
  assert.equal(added.id, 'draft-25');
});

// ---------------------------------------------------------------------------
// Task 2 review fixes — group bounds integrity and explicit groupId validation
// ---------------------------------------------------------------------------

function boundsDraft(x, y) {
  return {
    schemaVersion: 1,
    scene: { width: 100, height: 100 },
    items: [
      { id: 'edge-desk', kind: 'desk', asset: 'prop-desk-back-right-top', position: { x, y }, scale: 1, direction: 'back-right-top' },
      { id: 'edge-monitor', kind: 'monitor', asset: 'prop-monitor-back-right-top', position: { x: x + 0.05, y: y + 0.05 }, scale: 1, direction: 'back-right-top' },
    ],
  };
}

test('group moves shrink the whole-group delta at bounds instead of clamping members', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });

  editor.load(boundsDraft(0.9, 0.5));
  const right = editor.moveGroup('edge-desk', 20, 0);
  assert.deepEqual(right.map((item) => item.position), [
    { x: 0.95, y: 0.5 },
    { x: 1, y: 0.55 },
  ], 'the whole group shares one effective dx at the right wall');

  editor.load(boundsDraft(0.05, 0.5));
  const left = editor.moveGroup('edge-desk', -20, 0);
  assert.deepEqual(left.map((item) => item.position), [
    { x: 0, y: 0.5 },
    { x: 0.05, y: 0.55 },
  ], 'the whole group shares one effective dx at the left wall');

  editor.load(boundsDraft(0.5, 0.9));
  const down = editor.moveGroup('edge-desk', 0, 20);
  assert.deepEqual(down.map((item) => item.position), [
    { x: 0.5, y: 0.95 },
    { x: 0.55, y: 1 },
  ], 'the whole group shares one effective dy at the bottom wall');

  editor.load(boundsDraft(0.5, 0.05));
  const up = editor.moveGroup('edge-desk', 0, -20);
  assert.deepEqual(up.map((item) => item.position), [
    { x: 0.5, y: 0 },
    { x: 0.55, y: 0.05 },
  ], 'the whole group shares one effective dy at the top wall');
});

test('edge-truncated group moves keep offsets, stay one undo unit and no-op at the wall', () => {
  const editor = createLayoutEditor({ scene: { width: 100, height: 100 } });
  const positions = () => editor.toJSON().items.map((item) => item.position);
  editor.load(boundsDraft(0.9, 0.5));
  const original = positions();

  const moved = editor.moveGroup('edge-desk', 20, 0);
  assertNear(moved[1].position.x - moved[0].position.x, 0.05);

  // dragging further into the wall moves nothing and records no history
  const atEdge = positions();
  const extra = editor.moveGroup('edge-desk', 20, 0);
  assert.deepEqual(extra.map((item) => item.position), atEdge, 'the clamped drag does not move anything');
  editor.undo();
  assert.deepEqual(positions(), original, 'the edge drag left no history: one undo reverts the real move');
  editor.redo();
  assert.deepEqual(positions(), moved.map((item) => item.position), 'redo restores the boundary move exactly');
});

test('blank explicit group ids are rejected without touching the current draft', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft());
  const before = editor.toJSON();
  for (const groupId of ['', '   ']) {
    const draft = miniEditorDraft();
    draft.items[1].groupId = groupId;
    const result = editor.load(draft);
    assert.equal(result.ok, false, `blank groupId ${JSON.stringify(groupId)} must be rejected`);
    assert.equal(result.code, 'DRAFT_ITEM_GROUP_INVALID');
  }
  assert.deepEqual(editor.toJSON(), before, 'rejected imports never mutate the editor state');
});

test('null or missing group ids still infer from the nearest desk; custom ids survive', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });

  const nullCase = miniEditorDraft();
  nullCase.items[1].groupId = null;
  assert.equal(editor.load(nullCase).ok, true);
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'desk-a');

  const missing = miniEditorDraft();
  delete missing.items[1].groupId;
  assert.equal(editor.load(missing).ok, true);
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'desk-a');

  const custom = miniEditorDraft();
  custom.items[1].groupId = 'lobby-set';
  assert.equal(editor.load(custom).ok, true);
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'lobby-set');
});

// ---------------------------------------------------------------------------
// Task 4 — working frame inventory and validation report
// ---------------------------------------------------------------------------

const WORKING_FRAME_SCRIPT = path.join(__dirname, '..', 'scripts', 'office-assets', 'inventory-working-frames.py');
const WORKING_FRAME_REPORT = path.join(
  __dirname, '..', 'resources', 'characters', 'deepseek-default', 'assets', 'animations', 'working', 'front-3q', 'validation-report.json'
);
const WORKING_FRAME_SOURCES = [
  'working-front-3q-01.png',
  'working-front-3q-02.png',
  'working-front-3q-03.png',
  'working-front-3q-04.png',
];

test('working frame inventory classifies the four tracked sources as present-unconnected', () => {
  // 依赖 s1 私有树 photo/ / docs/notes/，主仓不迁移：源图缺失时整条跳过（视为通过）。
  if (!fs.existsSync(path.join(__dirname, '..', 'photo', 'output_nobg'))) return;
  const stdout = execFileSync('python3', [WORKING_FRAME_SCRIPT, '--inventory'], { encoding: 'utf8' });
  const inventory = JSON.parse(stdout);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.frames.length, 4);
  assert.deepEqual(inventory.frames.map((frame) => frame.file), WORKING_FRAME_SOURCES);
  const { createHash } = require('node:crypto');
  for (const frame of inventory.frames) {
    assert.equal(frame.verdict, 'present-unconnected', `${frame.file} is present-unconnected, never missing`);
    assert.equal(frame.width, 1254);
    assert.equal(frame.height, 1254);
    assert.equal(frame.alpha, true);
    assert.ok(frame.visibleBounds && frame.visibleBounds.width > 0 && frame.visibleBounds.height > 0);
    assert.ok(frame.opaqueRatio > 0 && frame.opaqueRatio <= 1);
    const disk = fs.readFileSync(path.join(__dirname, '..', 'photo', 'output_nobg', frame.file));
    assert.equal(createHash('sha256').update(disk).digest('hex'), frame.sha256, `${frame.file} hash matches the source of record`);
  }
  assert.ok(inventory.frameToFrame, 'frame-to-frame stability evidence recorded');
});

test('the committed validation report records geometry-rejected verdicts without deriving files', () => {
  const report = JSON.parse(fs.readFileSync(WORKING_FRAME_REPORT, 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.verdict, 'geometry-rejected');
  assert.ok(Array.isArray(report.reasons) && report.reasons.length >= 2, 'rejection reasons recorded');
  assert.ok(report.runtimeVisibility.startsWith('authoring-only'), 'the report is authoring evidence only');
  for (const frame of report.frames) {
    assert.equal(frame.verdict, 'geometry-rejected');
    assert.ok(Array.isArray(frame.reasons) && frame.reasons.length > 0);
    assert.ok(frame.sha256 && frame.width === 1254 && frame.alpha === true);
  }
  // geometry-rejected sources must NOT produce derived production PNGs
  const derivedDir = path.dirname(WORKING_FRAME_REPORT);
  const derived = fs.readdirSync(derivedDir).filter((name) => name.endsWith('.png'));
  assert.deepEqual(derived, [], 'rejected frames never produce derived files');
  // provenance: source hashes in the report match the immutable sources
  const { createHash } = require('node:crypto');
  // 依赖 s1 私有树 photo/ / docs/notes/，主仓不迁移：源图缺失时只跳过哈希比对（报告本体断言保留）。
  if (fs.existsSync(path.join(__dirname, '..', 'photo', 'output_nobg'))) {
    for (const frame of report.frames) {
      const disk = fs.readFileSync(path.join(__dirname, '..', 'photo', 'output_nobg', frame.file));
      assert.equal(createHash('sha256').update(disk).digest('hex'), frame.sha256);
    }
  }
});

test('runtime asset resolver never reads the working-frame validation report', () => {
  const assetPackSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'runtime', 'asset-pack.js'), 'utf8');
  assert.equal(/validation-report/i.test(assetPackSource), false);
  assert.equal(/working\/front-3q/.test(assetPackSource), false);
  // and the production pack metadata never references the photo tree
  const builtin = path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default');
  for (const file of ['manifest.json', 'animation/anchors.json', 'animation/animations.json']) {
    const text = fs.readFileSync(path.join(builtin, file), 'utf8');
    assert.equal(/photo\//.test(text), false, `${file} must not reference the photo tree`);
  }
});

// ---------------------------------------------------------------------------
// Task 8 — production-page-safe asset sources + editor schema validation API
// ---------------------------------------------------------------------------

test('every layout asset resolves from managed production resources, never test-only trees', () => {
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  for (const asset of LAYOUT_ASSETS) {
    // Task E2c: environment props live at the ./office-assets/ root beside
    // the layout-editor/ directional family; Task E3a adds the flat/ namespace.
    assert.match(asset.src, /^\.\/office-assets\/(layout-editor\/)?prop-|^\.\/office-assets\/flat\/(prop|flat)-|^\.\/characters\/deepseek-default\//, `${asset.id} managed URL: ${asset.src}`);
    assert.doesNotMatch(asset.src, /fixtures|photo\/|artifacts|test/, `${asset.id} never points into a test-only tree`);
    const diskPath = asset.src.startsWith('./office-assets/')
      ? path.join(__dirname, '..', 'resources', 'office', asset.src.slice('./office-assets/'.length))
      : path.join(__dirname, '..', 'resources', asset.src.slice('./'.length));
    assert.equal(existsSync(diskPath), true, `missing production layout asset ${asset.id}: ${diskPath}`);
  }
  // the production character frames the shelf needs actually exist
  const characterSrcs = LAYOUT_ASSETS.filter((asset) => asset.kind === 'character').map((asset) => asset.src);
  assert.equal(new Set(characterSrcs).size, 4, 'four distinct production character frames');
});

test('editor exposes validateDraftSchema for the production boot priority chain', () => {
  const editor = createLayoutEditor({ scene: { width: 1280, height: 840 } });
  assert.equal(typeof editor.validateDraftSchema, 'function', 'validateDraftSchema is exported');
  const valid = editor.validateDraftSchema(WORKSTATION_DRAFT);
  assert.equal(valid.ok, true);
  assert.equal(valid.count, 24, 'the user draft validates');
  assert.equal(valid.code, null);
  const broken = cloneDraft();
  broken.items[3].asset = 'prop-sofa-front';
  const invalid = editor.validateDraftSchema(broken);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.count, 0);
  assert.equal(invalid.code, 'DRAFT_ITEM_ASSET_UNKNOWN');
  assert.equal(editor.validateDraftSchema({ schemaVersion: 2 }).code, 'DRAFT_SCHEMA_UNSUPPORTED');
  assert.equal(editor.validateDraftSchema(null).code, 'DRAFT_INVALID');
});

test('editor.load returns the stable failure code without mutating the current draft', () => {
  const editor = createLayoutEditor({ scene: { width: 1280, height: 840 } });
  assert.equal(editor.load(cloneDraft()).ok, true);
  const before = editor.toJSON();
  const broken = cloneDraft();
  broken.items[5].direction = 'front'; // desk declares back-right-top
  const result = editor.load(broken);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRAFT_ITEM_DIRECTION_INVALID', 'stable machine-readable code');
  assert.equal(typeof result.code, 'string');
  assert.deepEqual(editor.toJSON(), before, 'the failed import leaves the draft untouched');
});

// ---------------------------------------------------------------------------
// Task E2a — precise editing core: multi-select, corner scale, inspector,
// duplicate, direction family switch, nudge merge, undo coverage, schema
// ---------------------------------------------------------------------------

function e2aSelection(ids) {
  return JSON.parse(JSON.stringify(ids));
}

test('E2a selection model: setSelection/toggle/selectAll/clear with primary tracking', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['monitor-b', 'desk-a']);
  assert.deepEqual(editor.selection().ids, ['monitor-b', 'desk-a']);
  assert.equal(editor.selection().primaryId, 'desk-a', 'the last id becomes primary');
  assert.equal(editor.selected().id, 'desk-a', 'selected() keeps returning the primary');
  editor.toggleSelection('chair-a');
  assert.deepEqual(editor.selection().ids, ['monitor-b', 'desk-a', 'chair-a']);
  editor.toggleSelection('desk-a');
  assert.deepEqual(editor.selection().ids, ['monitor-b', 'chair-a'], 'toggling a member removes it');
  editor.selectAll();
  assert.equal(editor.selection().ids.length, 6);
  editor.clearSelection();
  assert.deepEqual(editor.selection().ids, []);
  assert.equal(editor.selected(), null);
  // unknown ids are dropped, selection never contains ghosts
  editor.setSelection(['desk-a', 'ghost']);
  assert.deepEqual(editor.selection().ids, ['desk-a']);
});

test('E2a multi-select move: bounding-box truncation preserves relative offsets and zero-delta records nothing', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-b', 'monitor-b']);
  const before = editor.selection().items.map((item) => item.position);
  const moved = editor.moveSelection(500, 0); // huge: truncates at the right wall
  assert.equal(moved.length, 2);
  const dx = moved[0].position.x - before[0].x;
  assertNear(moved[1].position.x - before[1].x, dx);
  assert.ok(dx > 0 && dx < 0.5, 'the delta was truncated by the shared bounding box');
  const atWall = editor.moveSelection(500, 0, { recordHistory: false });
  assert.equal(atWall, null, 'a fully truncated move is a no-op');
  const zero = editor.moveSelection(0, 0);
  assert.equal(zero, null, 'zero-delta move records nothing');
  const units = editor.toJSON(); // sanity: undo stack untouched by no-ops
  editor.undo();
  editor.undo();
  assert.notDeepEqual(editor.toJSON().items, units.items, 'only the real move was one undo unit');
});

test('E2a duplicate: new ids, one new group per source group, +0.01 offset, clones selected, one undo unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.selectAll();
  const before = editor.toJSON();
  const clones = editor.duplicateSelection();
  assert.equal(clones.length, 6, 'every selected item cloned');
  const originalIds = new Set(before.items.map((item) => item.id));
  for (const clone of clones) {
    assert.equal(originalIds.has(clone.id), false, 'clone ids are fresh');
  }
  // +0.01/+0.01 offset per clone (by matching kind+asset pairs in order)
  const bySource = (index) => before.items[index];
  clones.forEach((clone, index) => {
    const origin = bySource(index);
    assert.equal(clone.kind, origin.kind);
    assertNear(clone.position.x - origin.position.x, 0.01);
    assertNear(clone.position.y - origin.position.y, 0.01);
  });
  // group mapping: clones of desk-a's group share one NEW group id, distinct from desk-b's
  const cloneGroups = new Set(clones.map((clone) => clone.groupId));
  assert.equal(cloneGroups.size, 2, 'one new group per source group');
  assert.equal(clones[0].groupId.startsWith('copy-of-'), true, 'copied group ids are marked copies');
  // clones are the new selection
  assert.deepEqual(editor.selection().ids, clones.map((clone) => clone.id));
  // exactly one undo unit
  editor.undo();
  assert.equal(editor.toJSON().items.length, 6, 'one undo removes the whole duplicate');
  editor.redo();
  assert.equal(editor.toJSON().items.length, 12);
  // duplicating again never collides on the copied group id
  editor.duplicateSelection();
  const groups = editor.toJSON().items.map((item) => item.groupId);
  const groupsOfFirstClones = groups.filter((gid) => gid === clones[0].groupId);
  assert.equal(groupsOfFirstClones.length, 4, 'the second duplicate gets its own group id (no shared drag target)');
});

function originalX(before, clone) {
  const origin = before.items.find((item) => item.kind === clone.kind && item.asset === clone.asset);
  return origin ? origin.position.x : clone.position.x;
}

test('E2a removeSelection deletes every selected item in one undo unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-a', 'monitor-a']);
  const removed = editor.removeSelection();
  assert.deepEqual(removed.map((item) => item.id).sort(), ['desk-a', 'monitor-a']);
  assert.equal(editor.toJSON().items.length, 4);
  assert.deepEqual(editor.selection().ids, [], 'selection cleared after removal');
  editor.undo();
  assert.equal(editor.toJSON().items.length, 6, 'one undo restores all');
});

test('E2a multi-select layer ops move the selection as a block in one unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const order = () => editor.toJSON().items.map((item) => item.id);
  editor.setSelection(['desk-a', 'hero-a']);
  editor.bringForwardSelection();
  assert.deepEqual(order(), ['monitor-a', 'desk-a', 'chair-a', 'desk-b', 'hero-a', 'monitor-b'],
    'each selected block swaps one step forward, intra-selection order kept');
  editor.undo();
  assert.deepEqual(order(), ['desk-a', 'monitor-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b'], 'one undo reverts the block op');
  editor.setSelection(['chair-a', 'hero-a']);
  editor.sendBackwardSelection();
  assert.deepEqual(order(), ['desk-a', 'chair-a', 'hero-a', 'monitor-a', 'desk-b', 'monitor-b'], 'block backward swaps past the nearest non-selected');
  // at the edge: no swap, no history — one undo reaches the previous REAL op
  const current = order();
  assert.equal(editor.selectAll() && editor.sendBackwardSelection(), null, 'a fully-selected backward edge op is a no-op');
  assert.equal(editor.bringForwardSelection(), null, 'a fully-selected forward edge op is a no-op');
  assert.deepEqual(order(), current, 'the blocked edge ops moved nothing');
  editor.undo();
  assert.deepEqual(order(), ['desk-a', 'monitor-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b'],
    'the blocked edge op recorded nothing: undo lands on the previous real op directly');
});

test('E2a scale handles: position scales around the fixed corner, clamp [0.2,3], canvas extent constraint', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 1000 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const corner = { x: 0.2, y: 0.2 };
  const scaled = editor.scaleItem('desk-a', 2, { fixedCorner: corner, clamp: true, recordHistory: false });
  assert.equal(scaled.scale, 2);
  assertNear(scaled.position.x, 0.4);
  assertNear(scaled.position.y, 0.4);
  assert.equal(editor.scaleItem('desk-a', 0.05, { clamp: true }).scale, 0.2, 'low clamp');
  assert.equal(editor.scaleItem('desk-a', 99, { clamp: true }).scale, 3, 'high clamp');
  assert.equal(editor.scaleItem('desk-a', 5, { clamp: false }), null, 'strict mode rejects out-of-range');
  assert.equal(editor.scaleItem('desk-a', 'x'), null, 'non-numeric rejected');
  // uniform scale never stretches: the item keeps ONE scale value by construction
  // extent keeps the scaled box inside the canvas
  const bounded = editor.scaleItem('desk-a', 3, {
    fixedCorner: { x: 0, y: 0 }, clamp: true, extent: { x: 0.05, y: 0.05 }, recordHistory: false,
  });
  assert.ok(bounded.position.x >= 0.05 && bounded.position.x <= 0.95, 'x center clamped by extent');
  assert.ok(bounded.position.y >= 0.05 && bounded.position.y <= 0.95, 'y center clamped by extent');
  // same-value scale records nothing
  const stable = editor.toJSON();
  const same = editor.scaleItem(bounded.id, bounded.scale, { fixedCorner: corner, clamp: true });
  assert.equal(same.scale, bounded.scale);
  assert.deepEqual(editor.toJSON(), stable, 'the no-change scale recorded nothing');
});

test('E2a inspector: moveTo/setItemLayer absolute sets with clamp, validation and no-change guards', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const moved = editor.moveTo('desk-a', 0.9, 1.4);
  assertNear(moved.position.x, 0.9);
  assertNear(moved.position.y, 1);
  assert.equal(editor.moveTo('desk-a', 'x', 0.2), null, 'non-numeric rejected');
  const layered = editor.setItemLayer('desk-a', 55);
  assert.equal(layered.layer, 55);
  assert.equal(editor.setItemLayer('desk-a', -1), null, 'negative layer rejected');
  const stable = editor.toJSON();
  editor.moveTo('desk-a', 0.9, 1);
  editor.setItemLayer('desk-a', 55);
  assert.deepEqual(editor.toJSON(), stable, 'no-change inspector edits record nothing');
  editor.undo(); // only the layer change
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').layer, 40, 'the default layer returns');
});

test('E2a direction switch: same family rewrites asset+direction together, kind and group untouched', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const turned = editor.setItemDirection('desk-a', 'front');
  assert.equal(turned.asset, 'prop-desk-front');
  assert.equal(turned.direction, 'front');
  assert.equal(turned.kind, 'desk');
  assert.equal(turned.groupId, 'desk-a', 'group untouched');
  const hero = editor.setItemDirection('hero-a', 'back');
  assert.equal(hero.asset, 'whale-girl-back', 'character family switch works too');
  assert.equal(hero.kind, 'character');
  // catalog boundary: whale-girl has no top-down directions
  assert.equal(editor.setItemDirection('hero-a', 'front-left-top'), null, 'missing family asset rejected');
  assert.equal(editor.toJSON().items.find((item) => item.id === 'hero-a').direction, 'back', 'rejected switch leaves the item untouched');
  const stable = editor.toJSON();
  editor.setItemDirection('hero-a', 'back');
  assert.deepEqual(editor.toJSON(), stable, 'same-direction switch records nothing');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'hero-a').asset, 'whale-girl-front', 'the switch is one undo unit');
});

test('E2a nudge merge: same-key auto-repeat within 300ms is ONE undo unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-a']);
  const start = editor.toJSON().items.find((item) => item.id === 'desk-a').position;
  const t0 = 100000;
  editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: t0 });
  editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: t0 + 150 });
  editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: t0 + 290 });
  const merged = editor.toJSON().items.find((item) => item.id === 'desk-a').position;
  assertNear(merged.x - start.x, 0.003);
  editor.undo();
  assertNear(editor.toJSON().items.find((item) => item.id === 'desk-a').position.x, start.x);
  editor.redo();
  // window expiry: a later repeat is a NEW unit
  editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: t0 + 900 });
  editor.undo();
  assertNear(editor.toJSON().items.find((item) => item.id === 'desk-a').position.x, start.x + 0.003);
  // a different key starts a fresh unit even inside the window, while the
  // same key inside the window still merges into the running unit
  editor.redo();
  editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: t0 + 1000 });
  editor.nudgeSelection(0, 0.001, { mergeKey: 'ArrowUp', now: t0 + 1100 });
  editor.undo();
  const afterUndo = editor.toJSON().items.find((item) => item.id === 'desk-a').position;
  assertNear(afterUndo.x, start.x + 0.005, 0.000001);
  assertNear(afterUndo.y, start.y, 0.000001);
  editor.undo();
  const afterSecondUndo = editor.toJSON().items.find((item) => item.id === 'desk-a').position;
  assertNear(afterSecondUndo.x, start.x + 0.003, 0.000001);
});

test('E2a undo/redo restores the selection state across operation types', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-b', 'monitor-a']);
  editor.moveSelection(10, 10);
  editor.duplicateSelection();
  editor.setSelection(['desk-a']);
  editor.setScale('desk-a', 2);
  editor.undo();
  assert.deepEqual(editor.selection().ids, ['desk-a'], 'undo restores the selection at that step');
  editor.undo();
  editor.undo();
  assert.deepEqual(editor.selection().ids, ['desk-b', 'monitor-a'], 'the pre-gesture selection returns');
  editor.redo();
  editor.redo();
  editor.redo();
  assert.deepEqual(editor.selection().ids, ['desk-a'], 'redo replays selection too');
});

test('E2a schema: selectedIds is optional, validated, and survives the parseDraft->toJSON round-trip', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  // legacy draft without selectedIds: derives from selectedId, still validates
  const legacy = miniEditorDraft();
  assert.equal(editor.load(legacy).ok, true);
  assert.deepEqual(editor.selection().ids, ['desk-a']);
  let exported = editor.toJSON();
  assert.deepEqual(exported.selectedIds, ['desk-a'], 'toJSON emits the defaulted selectedIds');
  // explicit multi-selection round-trips
  const multi = miniEditorDraft();
  multi.selectedIds = ['monitor-b', 'desk-a'];
  assert.equal(editor.load(multi).ok, true);
  assert.deepEqual(editor.selection().ids, ['monitor-b', 'desk-a']);
  assert.equal(editor.selected().id, 'desk-a', 'primary is the last entry');
  exported = editor.toJSON();
  assert.deepEqual(exported.selectedIds, ['monitor-b', 'desk-a'], 'round-trip keeps the multi-selection');
  assert.equal(exported.selectedId, 'desk-a');
  // ghost entries dropped, duplicates deduped, empty array means empty selection
  const messy = miniEditorDraft();
  messy.selectedIds = ['desk-a', 'ghost', 'desk-a'];
  assert.equal(editor.load(messy).ok, true);
  assert.deepEqual(editor.selection().ids, ['desk-a']);
  const empty = miniEditorDraft();
  empty.selectedIds = [];
  assert.equal(editor.load(empty).ok, true);
  assert.deepEqual(editor.selection().ids, []);
  assert.equal(editor.toJSON().selectedId, null);
});

test('E2a multi-select move expands to whole groups: workstation coherence like the single drag', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-b']);
  const before = editor.selection().items.map((item) => item.position);
  const monitorBefore = editor.toJSON().items.find((item) => item.id === 'monitor-b').position;
  const moved = editor.moveSelection(50, 0); // 50px on a 1000px scene = 0.05 normalized
  assert.equal(moved.length, 2, 'the whole desk-b group moves');
  const movedById = new Map(moved.map((item) => [item.id, item.position]));
  assertNear(movedById.get('monitor-b').x - monitorBefore.x, 0.05);
  // selection itself stays the strict user selection (desk-b), expansion is internal
  assert.deepEqual(editor.selection().ids, ['desk-b']);
  editor.undo();
  const restored = editor.toJSON().items.find((item) => item.id === 'monitor-b').position;
  assertNear(restored.x, monitorBefore.x, 0.000001);
});

test('E2a dragging a member of a live multi-selection keeps the selection (selectKeeping)', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['desk-a', 'desk-b']);
  editor.selectKeeping('desk-b');
  assert.deepEqual(editor.selection().ids, ['desk-a', 'desk-b'], 'the multi-selection survives');
  assert.equal(editor.selected().id, 'desk-b', 'the pressed member becomes primary');
  editor.selectKeeping('monitor-a');
  assert.deepEqual(editor.selection().ids, ['desk-a', 'desk-b', 'monitor-a'], 'an unselected member joins');
  // both members of the mixed selection move as groups/blocks through moveSelection
  editor.moveSelection(50, 0);
  const byId = new Map(editor.toJSON().items.map((item) => [item.id, item.position]));
  assertNear(byId.get('desk-b').x, 0.75);
  assertNear(byId.get('chair-a').x - 0.37, 0.05, 0.000001);
  editor.undo();
  const restored = new Map(editor.toJSON().items.map((item) => [item.id, item.position]));
  assertNear(restored.get('desk-b').x, 0.7, 0.000001);
});

test('E2a-R1 removing the primary keeps a consistent primary over the remaining selection', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['chair-a', 'hero-a', 'desk-b']);
  assert.deepEqual(editor.selection().ids, ['chair-a', 'hero-a', 'desk-b']);
  assert.equal(editor.selected().id, 'desk-b', 'primary is the last entry');
  editor.remove('desk-b'); // removing the PRIMARY must not orphan the rest
  assert.deepEqual(editor.selection().ids, ['chair-a', 'hero-a']);
  assert.equal(editor.selected().id, 'hero-a', 'primary falls back to the last remaining selected item');
  assert.notEqual(editor.selected(), null, 'never ids-nonempty with primary=null');
  editor.remove('chair-a');
  editor.remove('hero-a');
  assert.deepEqual(editor.selection().ids, []);
  assert.equal(editor.selected(), null);
});

// ---------------------------------------------------------------------------
// Task E2b — precision editing: grid snap, smart guides, align/distribute,
// and the canvas view transform math
// ---------------------------------------------------------------------------

test('E2b grid snap: effective drag deltas snap to the grid; snap off keeps floats; nudge ignores grid', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 1000 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  // single drag: +3px = 0.003 -> snaps to the 0.005 grid
  const snapped = editor.move('desk-b', 3, 0, { grid: 0.005, recordHistory: false });
  assertNear(snapped.position.x - 0.7, 0.005);
  // snap off (grid absent): exact float displacement
  const exact = editor.move('desk-b', 2, 0, { recordHistory: false });
  assertNear(exact.position.x - 0.7, 0.007);
  // group drag: one snapped delta for the whole group, offsets kept
  const beforeGroup = editor.toJSON().items.filter((item) => item.groupId === 'desk-a').map((item) => item.position);
  const groupMoved = editor.moveGroup('desk-a', 7, 0, { grid: 0.005, recordHistory: false });
  assert.equal(groupMoved.length, 4);
  for (let i = 0; i < 4; i += 1) assertNear(groupMoved[i].position.x - beforeGroup[i].x, 0.005);
  assertNear(groupMoved[0].position.x - groupMoved[1].position.x, beforeGroup[0].x - beforeGroup[1].x, 0.000001);
  // multi-select: shared snapped delta keeps offsets
  editor.setSelection(['monitor-a', 'desk-b']);
  const beforeById = new Map(editor.toJSON().items.map((item) => [item.id, item.position]));
  const movedSet = editor.moveSelection(11, 0, { grid: 0.005, recordHistory: false }); // 0.011 -> 0.01
  assert.equal(movedSet.length, 6, 'group expansion moves both whole workstations');
  for (const movedItem of movedSet) {
    assertNear(movedItem.position.x - beforeById.get(movedItem.id).x, 0.01, 0.000001);
  }
  // nudge NEVER snaps: 0.001 stays 0.001 even with a grid passed
  editor.clearSelection();
  editor.setSelection(['desk-a']);
  const nudgeStartX = editor.selected().position.x;
  const nudged = editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: 5000 });
  assertNear(nudged[0].position.x - nudgeStartX, 0.001, 0.000001);
});

test('E2b smart guides: the nearest other-item line within the threshold snaps and is reported', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 1000 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  // desk-b (0.7, half extent 0.03): its LEFT edge (x - 0.03 = 0.67) dragged
  // toward desk-a's RIGHT edge (0.3 + 0.03 = 0.33): delta -0.3385 lands the
  // left edge at 0.3315 -> 0.0015 from the line, inside the 0.004 threshold
  // -> snaps exactly onto 0.33 (desk-b x = 0.36).
  editor.setSelection(['desk-b']);
  const dragged = editor.moveSelection(-338.5, 0, {
    recordHistory: false,
    guides: true,
    guideThreshold: 0.004,
    extents: { 'desk-b': { x: 0.03, y: 0.03 }, 'desk-a': { x: 0.03, y: 0.03 }, 'monitor-a': { x: 0.015, y: 0.015 }, 'chair-a': { x: 0.015, y: 0.015 }, 'hero-a': { x: 0.015, y: 0.015 } },
  });
  const deskB = dragged.find((item) => item.id === 'desk-b');
  assertNear(deskB.position.x, 0.36);
  const guides = editor.dragGuides();
  // the moving selection's CENTER lands exactly on hero-a's right edge
  // (0.35 + 0.015 = 0.365): the smallest-diff line within the threshold
  assert.deepEqual(guides.vertical, [0.365], 'the matched vertical line is reported for display');
  assert.deepEqual(guides.horizontal, [], 'no horizontal line matched within the threshold');
  // out of range: no line nearby -> no snap, no guides
  editor.setSelection(['desk-b']);
  const free = editor.moveSelection(-100, 0, { recordHistory: false, guides: true, guideThreshold: 0.004 });
  const freeB = free.find((item) => item.id === 'desk-b');
  assert.deepEqual(editor.dragGuides().vertical, [], 'no guides far from any line');
  assert.ok(freeB.position.x < 0.41);
  editor.undo(); // the free move was a real unit; undo it for cleanliness
});

test('E2b align: left/right/top/bottom/centerX/centerY align in one unit; no-change records nothing', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['monitor-a', 'chair-a', 'desk-b']); // x: 0.31 / 0.37 / 0.7, y: 0.21 / 0.26 / 0.3
  editor.alignSelection('left');
  let byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assertNear(byId.get('monitor-a').position.x, 0.31);
  assertNear(byId.get('chair-a').position.x, 0.31);
  assertNear(byId.get('desk-b').position.x, 0.31);
  editor.undo();
  editor.alignSelection('right');
  byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assertNear(byId.get('monitor-a').position.x, 0.7);
  assertNear(byId.get('desk-b').position.x, 0.7);
  editor.undo();
  editor.alignSelection('centerX');
  byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assertNear(byId.get('monitor-a').position.x, 0.505, 0.000001);
  editor.undo();
  editor.alignSelection('top'); // y: 0.21 min
  byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assertNear(byId.get('desk-b').position.y, 0.21);
  editor.undo();
  // no-change: aligned again -> records nothing
  editor.alignSelection('top');
  const before = editor.toJSON();
  editor.alignSelection('top');
  assert.deepEqual(editor.toJSON(), before, 'an already-aligned call records nothing');
});

test('E2b distribute: horizontal and vertical equidistant for >=3, rejected below 3, one unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['monitor-a', 'chair-a', 'desk-b']); // x: 0.31, 0.37, 0.7
  const distributed = editor.distributeSelection('x');
  const byId = new Map(distributed.map((item) => [item.id, item.position.x]));
  assertNear(byId.get('monitor-a'), 0.31);
  assertNear(byId.get('chair-a'), 0.505, 0.000001);
  assertNear(byId.get('desk-b'), 0.7);
  editor.undo();
  assertNear(editor.toJSON().items.find((item) => item.id === 'chair-a').position.x, 0.37, 0.000001);
  // below 3 items: rejected
  editor.setSelection(['monitor-a', 'chair-a']);
  assert.equal(editor.distributeSelection('x'), null);
  // vertical works on y
  editor.setSelection(['monitor-a', 'chair-a', 'desk-b']);
  editor.distributeSelection('y');
  const ys = editor.selection().items.map((item) => item.position.y).sort((a, b) => a - b);
  assertNear(ys[1] - ys[0], ys[2] - ys[1], 0.000001);
});

test('E2b canvas view: zoom keeps the pointer anchor fixed; pan shifts; coordinates round-trip; scale clamps', () => {
  const { createCanvasView } = require('../src/office/layout-editor.js');
  const view = createCanvasView(1280, 840);
  view.set({ scale: 2, tx: 100, ty: 50 });
  assert.deepEqual(view.get(), { scale: 2, tx: 100, ty: 50 });
  // toNormalized/toCanvas round-trip
  const canvasPoint = { x: 500, y: 400 };
  const normalized = view.toNormalized(canvasPoint.x, canvasPoint.y);
  const back = view.toCanvas(normalized.x, normalized.y);
  assertNear(back.x, canvasPoint.x, 0.000001);
  assertNear(back.y, canvasPoint.y, 0.000001);
  // zoom at the anchor: the point under the cursor stays put
  view.zoomAt(canvasPoint.x, canvasPoint.y, 2);
  const afterZoom = view.toNormalized(canvasPoint.x, canvasPoint.y);
  assertNear(afterZoom.x, normalized.x, 0.000001);
  assertNear(afterZoom.y, normalized.y, 0.000001);
  assert.equal(view.get().scale, 4);
  // clamp: zoom out past the floor floors at 0.2
  for (let i = 0; i < 20; i += 1) view.zoomAt(canvasPoint.x, canvasPoint.y, 0.1);
  assert.equal(view.get().scale, 0.2);
  // pan shifts the origin
  view.panBy(30, 20);
  assert.deepEqual({ tx: view.get().tx, ty: view.get().ty }, { tx: view.get().tx, ty: view.get().ty });
  const panned = view.toNormalized(0, 0);
  view.panBy(-30, -20);
  assert.notDeepEqual(view.toNormalized(0, 0), panned);
  view.reset();
  assert.deepEqual(view.get(), { scale: 1, tx: 0, ty: 0 });
});

// ---------------------------------------------------------------------------
// Task E2b-R1 — the canvas view must use the LIVE canvas size (not the scene
// reference), group drags gain smart guides, and no debug hooks remain.
// ---------------------------------------------------------------------------

test('E2b-R1 canvas view: setSize re-baselines coordinates to the live canvas size', () => {
  const { createCanvasView } = require('../src/office/layout-editor.js');
  // THE REVIEWED DEFECT: the page created the view with the SCENE REFERENCE
  // size (1280x840) while the real canvas at a 1200x800 window is 880x568 —
  // the canvas center then resolved to ~0.34 instead of 0.5.
  const view = createCanvasView(1280, 840);
  const wrong = view.toNormalized(440, 334); // the canvas center in canvas px
  assert.ok(Math.abs(wrong.x - 0.5) > 0.1, 'with the reference size the center mismatches (the defect being locked out)');
  // setSize re-baselines to the live canvas size
  view.setSize(880, 668);
  const center = view.toNormalized(440, 334);
  assertNear(center.x, 0.5, 0.000001);
  assertNear(center.y, 0.5, 0.000001);
  const back = view.toCanvas(0.5, 0.5);
  assertNear(back.x, 440, 0.000001);
  assertNear(back.y, 334, 0.000001);
  // zoom anchor stays consistent after setSize
  view.zoomAt(440, 334, 2);
  const after = view.toNormalized(440, 334);
  assertNear(after.x, 0.5, 0.000001);
  assertNear(after.y, 0.5, 0.000001);
  assert.equal(view.get().scale, 2);
  // invalid sizes are ignored (the previous size survives)
  view.setSize(0, -5);
  assertNear(view.toNormalized(440, 334).x, 0.5, 0.000001);
});

test('E2b-R1 moveGroup supports smart guides: nearest line snaps and dragGuides reports it', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 1000 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  // the desk-a group's maxX edge = chair-a (0.37); desk-b's LEFT edge line =
  // 0.7 - 0.03 = 0.67. A +298px drag lands maxX at 0.668 -> 0.002 from the
  // line, inside the 0.004 threshold -> snaps exactly onto 0.67.
  const moved = editor.moveGroup('desk-a', 298, 0, {
    recordHistory: false,
    guides: true,
    guideThreshold: 0.004,
    extents: { 'desk-b': { x: 0.03, y: 0.03 }, 'monitor-b': { x: 0.015, y: 0.015 } },
  });
  const chairA = moved.find((item) => item.id === 'chair-a');
  assertNear(chairA.position.x, 0.37 + 0.3, 0.000001, 'the group snapped the moving maxX edge onto the line');
  assertNear(moved[0].position.x - moved[1].position.x, 0.3 - 0.31, 0.000001, 'group offsets preserved through the snap');
  const guides = editor.dragGuides();
  assert.equal(guides.vertical.length, 1, 'exactly one matched vertical line');
  assertNear(guides.vertical[0], 0.67, 0.000001);
  // a follow-up move without guides resets the reported state
  editor.moveGroup('desk-a', -50, 0, { recordHistory: false });
  assert.deepEqual(editor.dragGuides().vertical, [], 'non-guide moves reset the guide state');
});

test('E2b-R1 layout-editor carries no debug hooks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'layout-editor.js'), 'utf8');
  assert.doesNotMatch(src, /E2B_DEBUG/, 'no E2B_DEBUG console hooks in the shipped editor core');
});

// ---------------------------------------------------------------------------
// Task E2c — layers panel core: locked/hidden/name schema fields, the panel
// APIs (setItemLocked/setItemHidden/renameItem/moveItemToIndex) and the
// hidden/locked semantic matrix.
//
// Semantic contract (deliberate choices, locked here):
// - hidden: NOT rendered, NOT canvas-pickable (click/marquee), NOT included
//   in select-all — but still in the draft + panel, still selectable through
//   the panel, and explicit selection keeps every operation working (move/
//   align/distribute/nudge treat it like any selected item; duplication
//   preserves the hidden flag).
// - locked: selectable (panel locate) but frozen where it matters physically:
//   no drag, no absolute move, no scale, no delete, no align/distribute, no
//   nudge/multi-drag. Group drags with ANY locked member refuse the WHOLE
//   group (coherence beats partial moves). Z-order, rename, lock/hide toggles
//   and duplication stay available (non-destructive panel operations).
// ---------------------------------------------------------------------------

test('E2c schema: locked/hidden/name are optional, strictly validated and round-trip; legacy drafts keep importing', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  // legacy draft without the fields: defaults false/false/null, still valid
  assert.equal(editor.load(miniEditorDraft()).ok, true);
  for (const item of editor.toJSON().items) {
    assert.equal(item.locked, false, 'locked defaults to false');
    assert.equal(item.hidden, false, 'hidden defaults to false');
    assert.equal(item.name, null, 'name defaults to null');
  }
  // explicit values survive the parseDraft -> toJSON round trip
  const explicit = miniEditorDraft();
  explicit.items[0].locked = true;
  explicit.items[1].hidden = true;
  explicit.items[1].name = '主屏';
  assert.equal(editor.load(explicit).ok, true);
  const byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assert.equal(byId.get('desk-a').locked, true);
  assert.equal(byId.get('monitor-a').hidden, true);
  assert.equal(byId.get('monitor-a').name, '主屏');
  assert.equal(editor.toJSON().schemaVersion, 1, 'schemaVersion untouched');
  // invalid values are rejected with stable codes (never coerced silently)
  const cases = [
    ['DRAFT_ITEM_LOCKED_INVALID', (draft) => { draft.items[0].locked = 'yes'; }],
    ['DRAFT_ITEM_HIDDEN_INVALID', (draft) => { draft.items[0].hidden = 1; }],
    ['DRAFT_ITEM_NAME_INVALID', (draft) => { draft.items[0].name = ''; }],
    ['DRAFT_ITEM_NAME_INVALID', (draft) => { draft.items[0].name = '   '; }],
    ['DRAFT_ITEM_NAME_INVALID', (draft) => { draft.items[0].name = 42; }],
  ];
  for (const [code, mutate] of cases) {
    const draft = miniEditorDraft();
    mutate(draft);
    const result = editor.load(draft);
    assert.equal(result.ok, false, `${code} must be rejected`);
    assert.equal(result.code, code);
  }
  // a rejected import still leaves the previous draft untouched
  const stable = editor.toJSON();
  const bad = miniEditorDraft();
  bad.items[2].locked = null;
  bad.items[2].name = '';
  assert.equal(editor.load(bad).ok, false);
  assert.deepEqual(editor.toJSON(), stable);
});

test('E2c panel metadata APIs: one undo unit per change, no-change records nothing, invalid args rejected', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  assert.equal(editor.setItemLocked('desk-a', true).locked, true);
  assert.equal(editor.setItemLocked('desk-a', 'x'), null, 'non-boolean locked rejected');
  assert.equal(editor.setItemLocked('ghost', true), null, 'unknown id rejected');
  assert.equal(editor.setItemHidden('monitor-a', true).hidden, true);
  assert.equal(editor.setItemHidden('monitor-a', 'x'), null, 'non-boolean hidden rejected');
  assert.equal(editor.renameItem('chair-a', '会客椅').name, '会客椅');
  assert.equal(editor.renameItem('chair-a', ''), null, 'blank name rejected');
  assert.equal(editor.renameItem('chair-a', '  '), null, 'whitespace name rejected');
  assert.equal(editor.renameItem('ghost', 'x'), null, 'unknown id rejected');
  assert.equal(editor.renameItem('hero-a', null).name, null, 'null name is a no-change call on an unnamed item');
  // exactly three real units so far: lock, hide, rename (the hero-a null
  // rename was a no-change and recorded nothing)
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'chair-a').name, null, 'undo #1 reverts the rename');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').hidden, false, 'undo #2 reverts the hide');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').locked, false, 'undo #3 reverts the lock');
  // no-change calls recorded nothing: the stack is now empty (load used recordHistory:false)
  const stable = editor.toJSON();
  editor.setItemLocked('desk-a', false);
  editor.setItemHidden('monitor-a', false);
  editor.renameItem('chair-a', null);
  assert.deepEqual(editor.toJSON(), stable, 'same-value metadata calls record nothing');
});

test('E2c rename round-trip: set, undo, redo keep the name stable across the whole draft', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.renameItem('desk-a', '会议桌主位');
  let exported = editor.toJSON().items.find((item) => item.id === 'desk-a');
  assert.equal(exported.name, '会议桌主位', 'toJSON carries the name');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').name, null);
  editor.redo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').name, '会议桌主位', 'redo restores the name');
});

test('E2c moveItemToIndex: absolute z-order with bounds rejection and no-op guards', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const order = () => editor.toJSON().items.map((item) => item.id);
  const initial = order();
  // forward: the anchor lands at the requested index
  editor.moveItemToIndex('desk-a', 2);
  assert.deepEqual(order(), ['monitor-a', 'chair-a', 'desk-a', 'hero-a', 'desk-b', 'monitor-b']);
  editor.undo();
  assert.deepEqual(order(), initial, 'one undo reverts the move');
  // to the very back
  editor.moveItemToIndex('monitor-b', 0);
  assert.deepEqual(order(), ['monitor-b', 'desk-a', 'monitor-a', 'chair-a', 'hero-a', 'desk-b']);
  editor.undo();
  // to the very front: the last index sends it to the end
  editor.moveItemToIndex('desk-a', 5);
  assert.deepEqual(order(), ['monitor-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b', 'desk-a']);
  editor.undo();
  // dropping onto the current position is a no-op that records nothing
  const stable = editor.toJSON();
  editor.moveItemToIndex('chair-a', 2);
  editor.moveItemToIndex('desk-a', 0);
  assert.deepEqual(editor.toJSON(), stable, 'self-index drops record nothing');
  // out-of-bounds and malformed targets are REJECTED, never clamped
  assert.equal(editor.moveItemToIndex('desk-a', -1), null, 'negative index rejected');
  assert.equal(editor.moveItemToIndex('desk-a', 6), null, 'index === length rejected');
  assert.equal(editor.moveItemToIndex('desk-a', 1.5), null, 'non-integer rejected');
  assert.equal(editor.moveItemToIndex('ghost', 0), null, 'unknown id rejected');
  assert.deepEqual(editor.toJSON(), stable, 'rejected calls record nothing');
});

test('E2c moveItemToIndex multi-select: the contiguous selected block moves as one unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const order = () => editor.toJSON().items.map((item) => item.id);
  // a contiguous selected block keeps its internal order; the anchor lands
  // at the requested index (clamped at the bottom edge so the block fits)
  editor.setSelection(['desk-a', 'monitor-a']); // block at 0,1
  editor.moveItemToIndex('desk-a', 4);
  assert.deepEqual(order(), ['chair-a', 'hero-a', 'desk-b', 'desk-a', 'monitor-a', 'monitor-b'],
    'the two-item block clamps up at the bottom edge so it fits whole, order kept');
  editor.undo();
  assert.deepEqual(order(), ['desk-a', 'monitor-a', 'chair-a', 'hero-a', 'desk-b', 'monitor-b']);
  // a NON-contiguous selection moves only the block containing the anchor
  editor.setSelection(['desk-a', 'desk-b']); // indexes 0 and 4
  editor.moveItemToIndex('desk-a', 3);
  // block = [desk-a] alone; the anchor lands at EXACTLY index 3
  assert.deepEqual(order(), ['monitor-a', 'chair-a', 'hero-a', 'desk-a', 'desk-b', 'monitor-b']);
});

test('E2c hidden semantics: select-all and the canvas never pick hidden items; panel selection still operates', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setItemHidden('monitor-a', true);
  editor.setItemHidden('chair-a', true);
  editor.selectAll();
  assert.deepEqual(editor.selection().ids.sort(), ['desk-a', 'desk-b', 'hero-a', 'monitor-b'],
    '全选 excludes hidden items');
  // the panel path still reaches them (the ONE way to select what the canvas
  // can never hit-test)
  editor.select('monitor-a');
  assert.deepEqual(editor.selection().ids, ['monitor-a'], 'panel row click selects a hidden item');
  // explicit selection keeps every operation working (uniform ops contract)
  const beforeX = editor.selected().position.x;
  editor.move('monitor-a', 10, 0);
  assert.ok(editor.selected().position.x > beforeX, 'an explicitly selected hidden item is still movable');
  editor.undo();
  // hidden items stay in the draft and keep their identity
  const draft = editor.toJSON();
  assert.equal(draft.items.length, 6, 'hidden items stay in the draft');
  assert.equal(draft.items.find((item) => item.id === 'monitor-a').hidden, true);
});

test('E2c hidden in align/distribute/duplicate: explicit selections keep working; clones inherit the flags', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setItemHidden('monitor-a', true);
  // align with a hidden member explicitly selected: uniform op (documented)
  editor.setSelection(['monitor-a', 'chair-a']);
  editor.alignSelection('left');
  let byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assertNear(byId.get('monitor-a').position.x, byId.get('chair-a').position.x, 0.000001, 'hidden member aligns like any selected item');
  editor.undo();
  // distribute likewise
  editor.setItemHidden('hero-a', true);
  editor.setSelection(['monitor-a', 'chair-a', 'hero-a']);
  editor.distributeSelection('x');
  byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  const xs = ['monitor-a', 'chair-a', 'hero-a'].map((id) => byId.get(id).position.x).sort((a, b) => a - b);
  assertNear(xs[1] - xs[0], xs[2] - xs[1], 0.000001, 'hidden members distribute like any selected item');
  editor.undo();
  // duplication: a hidden source yields a hidden clone with the same name
  editor.renameItem('monitor-a', '主屏');
  editor.setItemLocked('chair-a', true);
  editor.setSelection(['monitor-a', 'chair-a']);
  const clones = editor.duplicateSelection();
  assert.equal(clones.length, 2);
  assert.equal(clones[0].hidden, true, 'hidden flag clones');
  assert.equal(clones[0].name, '主屏', 'name clones');
  assert.equal(clones[1].locked, true, 'locked flag clones (duplication is non-destructive)');
  assert.notEqual(clones[0].id, 'monitor-a', 'clone ids stay fresh');
  editor.undo();
  assert.equal(editor.toJSON().items.length, 6, 'one undo removes the whole duplicate');
});

test('E2c locked semantics: drag/absolute-move/scale/delete/nudge rejected; selection still works', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setItemLocked('desk-a', true);
  // selectable — the panel-locate contract
  editor.select('desk-a');
  assert.deepEqual(editor.selection().ids, ['desk-a'], 'locked items are selectable');
  const stable = editor.toJSON();
  assert.equal(editor.move('desk-a', 50, 0), null, 'locked items are not draggable');
  assert.equal(editor.moveTo('desk-a', 0.9, 0.9), null, 'inspector position edits are dragging too');
  assert.equal(editor.setScale('desk-a', 2), null, 'typed scale rejected');
  assert.equal(editor.scaleItem('desk-a', 2, { fixedCorner: { x: 0.3, y: 0.3 } }), null, 'corner handles rejected');
  assert.equal(editor.remove('desk-a'), null, 'single delete rejected');
  assert.equal(editor.nudgeSelection(0.001, 0, { mergeKey: 'ArrowRight', now: 1000 }), null, 'arrow nudges rejected');
  editor.setSelection(['desk-a', 'desk-b']);
  assert.equal(editor.moveSelection(50, 0), null, 'a multi-drag containing a locked member is rejected atomically');
  assert.deepEqual(editor.toJSON().items, stable.items, 'rejected geometry calls record nothing');
});

test('E2c locked align/distribute rejected whole; group drag refuses entirely when any member is locked', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setItemLocked('monitor-a', true);
  const stable = editor.toJSON();
  editor.setSelection(['monitor-a', 'chair-a']);
  assert.equal(editor.alignSelection('left'), null, 'align with a locked member is rejected whole');
  editor.setSelection(['monitor-a', 'chair-a', 'hero-a']);
  assert.equal(editor.distributeSelection('x'), null, 'distribute with a locked member is rejected whole');
  assert.deepEqual(editor.toJSON().items, stable.items, 'rejected align/distribute record nothing');
  // SEMANTIC LOCK: one locked member refuses the WHOLE group drag — skipping
  // members would tear the workstation apart; partial moves never undo well.
  editor.setItemLocked('chair-a', true); // member of the desk-a group
  editor.setItemLocked('monitor-a', false);
  const groupBefore = editor.toJSON().items.filter((item) => item.groupId === 'desk-a').map((item) => item.position);
  assert.equal(editor.moveGroup('desk-a', 50, 0), null, '整组拒绝: any locked member refuses the whole group');
  assert.deepEqual(
    editor.toJSON().items.filter((item) => item.groupId === 'desk-a').map((item) => item.position),
    groupBefore,
    'no member of the locked group moved'
  );
  assert.equal(editor.moveSelection(50, 0), null, 'group expansion pulls the lock into multi-drags too');
  // unlocking restores everything
  editor.setItemLocked('chair-a', false);
  assert.equal(editor.moveGroup('desk-a', 50, 0).length, 4, 'unlocking restores the group drag');
});

test('E2c removeSelection skips locked members; locked survivors stay selected; all-locked is a no-op', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setItemLocked('monitor-a', true);
  editor.setSelection(['monitor-a', 'chair-a']);
  const removed = editor.removeSelection();
  assert.deepEqual(removed.map((item) => item.id), ['chair-a'], 'only the unlocked member is removed');
  assert.ok(editor.toJSON().items.some((item) => item.id === 'monitor-a'), 'the locked member survives');
  assert.deepEqual(editor.selection().ids, ['monitor-a'], 'the locked survivor stays selected');
  editor.undo();
  assert.ok(editor.toJSON().items.some((item) => item.id === 'chair-a'), 'one undo restores the removal');
  // all-locked selection: nothing deletable -> no-op, no history
  editor.setSelection(['monitor-a']);
  const stable = editor.toJSON();
  assert.deepEqual(editor.removeSelection(), [], 'an all-locked delete is an empty no-op');
  assert.deepEqual(editor.toJSON(), stable, 'the all-locked no-op records nothing');
});

// ---------------------------------------------------------------------------
// Task E2c — the data-driven catalog: single-image environment props
// ---------------------------------------------------------------------------

test('E2c catalog: 10 single-image env props with production root paths, Chinese labels and stable metadata', () => {
  const { LAYOUT_ASSETS, LAYOUT_KINDS, layoutAssetById } = require('../src/office/layout-assets.js');
  // E3e: scope to the root-directory env props; the flat/ batch is separate
  // and carries its own contract tests.
  const props = LAYOUT_ASSETS.filter((asset) => asset.kind === 'prop' && asset.src.startsWith('./office-assets/prop-'));
  assert.deepEqual(props.map((asset) => asset.id), [
    'prop-chair', 'prop-coffee-machine', 'prop-desk-monitor', 'prop-plant', 'prop-snacks',
    'prop-toilet', 'prop-treadmill', 'prop-water-bar', 'prop-water-cooler', 'prop-whiteboard',
  ], 'the ten root-directory environment props are all listed');
  for (const prop of props) {
    assert.equal(prop.directional, false, `${prop.id} declares no direction family`);
    assert.equal(prop.direction, 'none', `${prop.id} direction is declared verbatim`);
    assert.match(prop.src, /^\.\/office-assets\/prop-[a-z-]+\.png$/, `${prop.id} uses the production root path: ${prop.src}`);
    assert.doesNotMatch(prop.src, /layout-editor|fixtures|photo\/|artifacts|test|\/Users\//, `${prop.id} never points at forbidden trees`);
    assert.equal(prop.layer, 'back-furniture', `${prop.id} stays in the managed furniture band`);
    assert.equal(prop.scale, 1, `${prop.id} default scale`);
    assert.deepEqual(prop.anchor, { x: 0.5, y: 0.5 }, `${prop.id} center anchor`);
    assert.ok(typeof prop.label === 'string' && prop.label.length > 0, `${prop.id} carries a Chinese label`);
    const diskPath = path.join(__dirname, '..', 'resources', 'office', prop.src.slice('./office-assets/'.length));
    assert.equal(existsSync(diskPath), true, `${prop.id} exists on disk: ${diskPath}`);
  }
  // the directional families keep their exact ids and paths (no drift).
  // Task E4.6: the isometric furniture family is archived from the palette
  // (the character frames stay); layoutAssetById still resolves all of them.
  const directional = LAYOUT_ASSETS.filter((asset) => asset.directional === true);
  assert.equal(directional.length, 4, 'only the character frames stay palette-directional');
  const { ARCHIVED_LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  assert.equal(ARCHIVED_LAYOUT_ASSETS.length, 24, 'the 24 isometric entries are archived, not deleted');
  for (const asset of ARCHIVED_LAYOUT_ASSETS) {
    assert.equal(LAYOUT_ASSETS.some((entry) => entry.id === asset.id), false, `${asset.id} is off the palette`);
  }
  for (const kind of ['desk', 'chair', 'monitor']) {
    for (const [direction] of [['front'], ['back'], ['left'], ['right'], ['front-left-top'], ['front-right-top'], ['back-left-top'], ['back-right-top']]) {
      const entry = layoutAssetById(`prop-${kind}-${direction}`);
      assert.ok(entry, `prop-${kind}-${direction} survives the refactor`);
      assert.equal(entry.src, `./office-assets/layout-editor/prop-${kind}-${direction}.png`);
      assert.equal(entry.layer, 'back-furniture');
      assert.equal(entry.scale, 1);
      assert.deepEqual(entry.anchor, { x: 0.5, y: 0.5 });
    }
  }
  assert.equal(Object.isFrozen(layoutAssetById('whale-girl-front').anchor), true, 'frozen entries keep frozen anchors');
  assert.equal(layoutAssetById('prop-plant').directional, false, 'stable-miss lookup covers the new entries');
  // kind registry drives data-driven shelf order
  assert.deepEqual(LAYOUT_KINDS.map(([kind]) => kind), ['desk', 'chair', 'monitor', 'character', 'prop']);
});

test('E2c single-image direction contract: parseDraft enforces the declared direction and family switches are refused', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  const added = editor.add({ kind: 'prop', asset: 'prop-plant', direction: 'none', x: 0.5, y: 0.5 });
  assert.equal(added.direction, 'none', 'shelf adds carry the catalog direction');
  assert.equal(added.layer, 25, 'env props default between chairs (20) and characters (30)');
  assert.equal(added.locked, false);
  assert.equal(added.hidden, false);
  assert.equal(added.name, null);
  // a direction that contradicts the catalog declaration is rejected
  const bad = miniEditorDraft();
  bad.items.push({ id: 'plant', kind: 'prop', asset: 'prop-plant', position: { x: 0.5, y: 0.5 }, scale: 1, direction: 'front' });
  const result = editor.load(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRAFT_ITEM_DIRECTION_INVALID', 'existing parseDraft rule covers single-image entries');
  // the family switch API refuses single-image entries outright
  assert.equal(editor.setItemDirection(added.id, 'front'), null);
  assert.equal(editor.toJSON().items.find((item) => item.id === added.id).asset, 'prop-plant', 'rejected switches leave the item untouched');
  // directional entries keep switching inside their family
  assert.equal(editor.setItemDirection('desk-a', 'front').asset, 'prop-desk-front');
});

// ---------------------------------------------------------------------------
// Task E2e — material groups + the optional groupNames field. A group is
// ONLY the marquee/drag/panel-section unit: members keep painting by their
// own (layer, array order) depth, group drags stay rigid, and any locked
// member still refuses the whole group move. Every group op is exactly one
// undo unit; a no-change call records nothing.
// ---------------------------------------------------------------------------

test('E2e groups: groupSelection assigns one stable group-N id to the selection in a single undo unit', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['monitor-a', 'chair-a']);
  const grouped = editor.groupSelection();
  assert.ok(grouped, 'grouping a non-empty selection works');
  assert.equal(grouped.items.length, 2);
  assert.match(grouped.groupId, /^group-\d+$/, 'stable group-N id');
  const byId = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assert.equal(byId.get('monitor-a').groupId, grouped.groupId);
  assert.equal(byId.get('chair-a').groupId, grouped.groupId);
  assert.equal(byId.get('desk-a').groupId, 'desk-a', 'unselected members keep their groups');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'desk-a', 'one undo restores the previous group assignment');
  editor.redo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, grouped.groupId);
  // the next group never reuses the id (stable identity across the session)
  editor.setSelection(['hero-a']);
  const second = editor.groupSelection();
  assert.notEqual(second.groupId, grouped.groupId, 'a second group gets its own id');
  // empty selection: rejected without touching history
  editor.clearSelection();
  const stable = editor.toJSON();
  assert.equal(editor.groupSelection(), null);
  assert.deepEqual(editor.toJSON(), stable);
});

test('E2e groups: ungroup/rename/addToGroup/ungroupGroup semantics with no-change guards', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  // ungroupSelection with nothing grouped is a no-op that records nothing
  // (desk-a owns its own group per the nearest-desk contract, so it IS
  // grouped — reach the no-change state with an already-ungrouped member)
  editor.setSelection(['monitor-a']);
  editor.ungroupSelection();
  const stable = editor.toJSON();
  assert.equal(editor.ungroupSelection(), null, 'ungrouping an already-ungrouped selection records nothing');
  assert.deepEqual(editor.toJSON(), stable);
  editor.undo(); // monitor-a returns to desk-a before the mixed-selection case
  // ungroup moves the selected members out, exactly one undo unit
  editor.setSelection(['monitor-a', 'hero-a']); // both inside the desk-a group
  const removed = editor.ungroupSelection();
  assert.equal(removed.length, 2);
  const afterUngroup = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assert.equal(afterUngroup.get('monitor-a').groupId, null);
  assert.equal(afterUngroup.get('chair-a').groupId, 'desk-a', 'unselected members keep the group');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'desk-a');
  // addSelectionToGroup: target group must exist; members that actually
  // change groups are rewritten in one undo unit
  editor.setSelection(['hero-a', 'chair-a']);
  assert.equal(editor.addSelectionToGroup('no-such-group'), null, 'a non-existent target group is rejected');
  const added = editor.addSelectionToGroup('desk-b');
  assert.deepEqual(added.map((item) => item.id), ['chair-a', 'hero-a'], 'both members leave desk-a for desk-b (items order)');
  const afterAdd = new Map(editor.toJSON().items.map((item) => [item.id, item]));
  assert.equal(afterAdd.get('hero-a').groupId, 'desk-b');
  assert.equal(afterAdd.get('chair-a').groupId, 'desk-b');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'hero-a').groupId, 'desk-a');
  // already-member selections are a no-change no-op
  editor.setSelection(['chair-a']);
  const stableAfterAdd = editor.toJSON();
  assert.equal(editor.addSelectionToGroup('desk-a'), null, 'adding a member back into its own group records nothing');
  assert.deepEqual(editor.toJSON(), stableAfterAdd);
  // renameGroup: display-only, one undo unit, null clears, invalid rejected
  assert.equal(editor.renameGroup('desk-b', '窗边工位')['desk-b'], '窗边工位');
  assert.equal(editor.renameGroup('desk-b', ''), null, 'blank name rejected');
  assert.equal(editor.renameGroup('desk-b', '   '), null, 'whitespace name rejected');
  assert.equal(editor.renameGroup('', 'x'), null, 'empty groupId rejected');
  const same = editor.toJSON();
  editor.renameGroup('desk-b', '窗边工位');
  assert.deepEqual(editor.toJSON(), same, 'same-name rename records nothing');
  editor.undo();
  assert.equal(editor.toJSON().groupNames['desk-b'], undefined, 'undo clears the rename');
  editor.redo();
  assert.equal(editor.toJSON().groupNames['desk-b'], '窗边工位');
  editor.renameGroup('desk-b', null);
  assert.equal(editor.toJSON().groupNames['desk-b'], undefined, 'null clears the custom name');
  // ungroupGroup: the WHOLE group leaves, selection untouched
  editor.setSelection(['desk-a']);
  const ungroupedAll = editor.ungroupGroup('desk-a');
  assert.equal(ungroupedAll.length, 4, 'desk-a owns desk+monitor+chair+character');
  assert.deepEqual(editor.selection().ids, ['desk-a'], 'selection untouched by the group-level ungroup');
  assert.ok(editor.toJSON().items.every((item) => item.groupId !== 'desk-a'));
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, 'desk-a');
});

test('E2e groups: rigid drags and the locked-member refusal carry over to material groups', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  editor.setSelection(['monitor-a', 'chair-a']);
  const { groupId } = editor.groupSelection();
  // desk-a itself stays in its own group — dragging the NEW group moves only
  // its two members rigidly
  const before = editor.toJSON().items.find((item) => item.id === 'monitor-a').position;
  const moved = editor.moveGroup(groupId, 10, 0);
  assert.equal(moved.length, 2, 'the whole material group moves');
  assertNear(editor.toJSON().items.find((item) => item.id === 'monitor-a').position.x - before.x, 0.01);
  assert.equal(editor.toJSON().items.find((item) => item.id === 'desk-a').position.x, 0.3, 'the former group is untouched');
  // any locked member refuses the WHOLE material group (E2c semantic carries)
  editor.setItemLocked('chair-a', true);
  assert.equal(editor.moveGroup(groupId, 10, 0), null);
  editor.setSelection(['monitor-a']);
  assert.equal(editor.moveSelection(10, 0), null, 'group expansion pulls the lock into multi-drags too');
  editor.setItemLocked('chair-a', false);
  assert.equal(editor.moveGroup(groupId, 10, 0).length, 2, 'unlocking restores the drag');
  // groupId survives edits: group identity is never rewritten by moves
  editor.move('monitor-a', 5, 0);
  assert.equal(editor.toJSON().items.find((item) => item.id === 'monitor-a').groupId, groupId);
});

test('E2e groupNames: optional schema field round-trips, validates strictly, legacy drafts untouched', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  // legacy draft without groupNames still imports; toJSON emits an empty map
  assert.equal(editor.load(miniEditorDraft()).ok, true);
  assert.deepEqual(editor.toJSON().groupNames, {});
  // explicit names round-trip
  const named = miniEditorDraft();
  named.groupNames = { 'desk-a': '主工位' };
  assert.equal(editor.load(named).ok, true);
  assert.equal(editor.toJSON().groupNames['desk-a'], '主工位');
  assert.equal(editor.toJSON().schemaVersion, 1, 'schemaVersion untouched');
  // invalid shapes rejected with a stable code
  const cases = [
    ['DRAFT_GROUP_NAMES_INVALID', (draft) => { draft.groupNames = 'x'; }],
    ['DRAFT_GROUP_NAMES_INVALID', (draft) => { draft.groupNames = []; }],
    ['DRAFT_GROUP_NAMES_INVALID', (draft) => { draft.groupNames = { 'desk-a': '' }; }],
    ['DRAFT_GROUP_NAMES_INVALID', (draft) => { draft.groupNames = { 'desk-a': '  ' }; }],
    ['DRAFT_GROUP_NAMES_INVALID', (draft) => { draft.groupNames = { 'desk-a': 42 }; }],
  ];
  for (const [code, mutate] of cases) {
    const draft = miniEditorDraft();
    mutate(draft);
    const result = editor.load(draft);
    assert.equal(result.ok, false, `${code} must be rejected`);
    assert.equal(result.code, code);
  }
  // a rejected import leaves the current draft (and names) untouched
  const stable = editor.toJSON();
  const bad = miniEditorDraft();
  bad.groupNames = { 'desk-a': '' };
  assert.equal(editor.load(bad).ok, false);
  assert.deepEqual(editor.toJSON(), stable);
  // generated group-N ids continue past imported ones
  const withGroups = miniEditorDraft();
  withGroups.items[1].groupId = 'group-7';
  assert.equal(editor.load(withGroups).ok, true);
  editor.setSelection(['chair-a', 'hero-a']);
  assert.equal(editor.groupSelection().groupId, 'group-8', 'auto ids continue past imported group-N');
});

// ---------------------------------------------------------------------------
// Task E2e — catalog asset QA for the flat-2D rework: every declared asset
// decodes as a PNG with positive dimensions and a real alpha channel, and the
// 接入规范 document stays in sync with the catalog (no doc drift).
// ---------------------------------------------------------------------------

test('E2e catalog: every asset PNG decodes with positive width/height and an alpha channel', () => {
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  for (const asset of LAYOUT_ASSETS) {
    const diskPath = asset.src.startsWith('./office-assets/')
      ? path.join(__dirname, '..', 'resources', 'office', asset.src.slice('./office-assets/'.length))
      : path.join(__dirname, '..', 'resources', asset.src.slice('./'.length));
    const png = fs.readFileSync(diskPath);
    assert.equal(png.readUInt32BE(12), 0x49484452, `${asset.id} starts with an IHDR chunk (PNG signature)`);
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width > 0 && height > 0, `${asset.id} has positive dimensions (${width}x${height})`);
    // color type: 4 = grayscale+alpha, 6 = RGBA (palette transparency is NOT
    // accepted — flat 2D assets must ship real alpha)
    const colorType = png[25];
    assert.ok(colorType === 4 || colorType === 6, `${asset.id} carries an alpha channel (colorType ${colorType})`);
  }
});

test('E2e doc contract: the flat-asset 接入规范 stays in sync with the catalog reality', () => {
  // 依赖 s1 私有树 photo/ / docs/notes/，主仓不迁移：文档缺失时整条跳过（视为通过）。
  if (!fs.existsSync(path.join(__dirname, '..', 'docs', 'notes', 'office-editor.md'))) return;
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'notes', 'office-editor.md'), 'utf8');
  // naming + directory rules the doc promises
  assert.match(doc, /prop-<name>\.png/, 'the doc declares the single-image naming rule');
  assert.match(doc, /resources\/office\//, 'the doc points at the managed resource directory');
  assert.match(doc, /layout-assets\.js/, 'the doc names the single declaration surface');
  assert.match(doc, /1280×840/, 'the doc states the logical scene size');
  assert.match(doc, /越大越靠前/, 'the doc states the depth semantics of layer');
  assert.match(doc, /prop-<kind>-<direction>\.png/, 'the doc declares the directional naming rule');
  // reality check: every env prop id matches its file under resources/office,
  // and every directional id matches its file under resources/office/layout-editor
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  for (const asset of LAYOUT_ASSETS) {
    const rel = asset.src.startsWith('./office-assets/')
      ? asset.src.slice('./office-assets/'.length)
      : null;
    if (rel) {
      assert.equal(fs.existsSync(path.join(__dirname, '..', 'resources', 'office', rel)), true, `${asset.id} file matches the doc rule`);
    }
  }
  // the doc's layer-band guidance must not contradict the shipped defaults
  assert.match(doc, /20[–-]40/, 'the doc keeps the furniture band consistent with DEFAULT_LAYER_BY_KIND (chair 20 / prop 25 / desk 40)');
});

// ---------------------------------------------------------------------------
// Task E3a — the flat-2D pilot furniture (flat/ namespace). The three
// user-drawn PNGs are copied VERBATIM from photo/ (never processed); the
// catalog entries reuse the EXISTING kinds so they inherit the calibrated
// default depth (monitor 10 / chair 20 / desk 40) and shelf widths.
// ---------------------------------------------------------------------------

test('E3a catalog: the three flat pilot entries are registered with production flat/ paths', () => {
  const { LAYOUT_ASSETS, layoutAssetById } = require('../src/office/layout-assets.js');
  const expected = [
    ['flat-desk', 'prop-desk-front.png', 'desk', '桌子（平面）', 'front'],
    ['flat-monitor', 'prop-monitor-front.png', 'monitor', '显示器（平面）', 'front'],
    ['flat-chair', 'prop-chair-back.png', 'chair', '椅子（平面·背视）', 'back'],
  ];
  // E3e: later flat batches exist; this test pins the PILOT trio only.
  const pilotIds = new Set(expected.map(([id]) => id));
  assert.deepEqual(
    LAYOUT_ASSETS.filter((asset) => pilotIds.has(asset.id)).map((asset) => [asset.id, asset.src.slice('./office-assets/flat/'.length), asset.kind, asset.label, asset.direction]),
    expected,
    'the three flat pilot entries are listed exactly as specified'
  );
  for (const [id] of expected) {
    const asset = layoutAssetById(id);
    assert.equal(asset.directional, false, `${id} is single-image (no direction family)`);
    assert.equal(asset.layer, 'back-furniture', `${id} stays in the managed furniture band`);
    assert.deepEqual(asset.anchor, { x: 0.5, y: 0.5 }, `${id} center anchor`);
    assert.equal(asset.scale, 1, `${id} default scale`);
    assert.match(asset.src, /^\.\/office-assets\/flat\/prop-[a-z-]+\.png$/, `${id} production flat/ path: ${asset.src}`);
    assert.doesNotMatch(asset.src, /fixtures|photo\/|artifacts|test|\/Users\//, `${id} never points at forbidden trees`);
    const diskPath = path.join(__dirname, '..', 'resources', 'office', 'flat', asset.src.slice('./office-assets/flat/'.length));
    assert.equal(existsSync(diskPath), true, `${id} exists on disk: ${diskPath}`);
    // the copy is byte-identical to the photo/ source (no image processing)
    // 依赖 s1 私有树 photo/ / docs/notes/，主仓不迁移：源图缺失时只跳过逐字节比对（catalog 本体断言保留）。
    const sourcePath = path.join(__dirname, '..', 'photo', asset.src.slice('./office-assets/flat/'.length));
    if (existsSync(sourcePath)) {
      assert.equal(existsSync(sourcePath), true, `photo/ source ${sourcePath} is untouched`);
      assert.equal(
        fs.readFileSync(diskPath).equals(fs.readFileSync(sourcePath)),
        true,
        `${id} is a verbatim copy of the photo/ source (no crop/compress/deshadow)`
      );
    }
    // PNG quality gates: decodes, positive dimensions, real alpha channel
    const png = fs.readFileSync(diskPath);
    assert.equal(png.readUInt32BE(12), 0x49484452, `${id} has an IHDR chunk`);
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, `${id} positive dimensions`);
    assert.ok([4, 6].includes(png[25]), `${id} carries an alpha channel (colorType ${png[25]})`);
  }
  // single-image direction contract: family switches refused; adds carry the
  // declared direction (and inherit the kind's calibrated default depth)
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(miniEditorDraft(), { recordHistory: false });
  for (const [id, , kind, , direction] of expected) {
    const added = editor.add({ kind, asset: id, direction, x: 0.5, y: 0.5 });
    assert.equal(added.direction, direction, `${id} adds carry the declared direction`);
    assert.equal(editor.setItemDirection(added.id, direction === 'front' ? 'back' : 'front'), null, `${id} refuses family switches`);
    editor.remove(added.id);
  }
  // the legacy isometric/character entries are UNCHANGED (id/paths/layer/scale/anchor)
  for (const kind of ['desk', 'chair', 'monitor']) {
    for (const direction of ['front', 'back', 'left', 'right', 'front-left-top', 'front-right-top', 'back-left-top', 'back-right-top']) {
      const entry = layoutAssetById(`prop-${kind}-${direction}`);
      assert.equal(entry.src, `./office-assets/layout-editor/prop-${kind}-${direction}.png`, `prop-${kind}-${direction} path unchanged`);
      assert.equal(entry.layer, 'back-furniture');
      assert.equal(entry.scale, 1);
      assert.deepEqual(entry.anchor, { x: 0.5, y: 0.5 });
      assert.equal(entry.directional, true);
    }
  }
  assert.equal(layoutAssetById('whale-girl-front').src, './characters/deepseek-default/assets/expressions/idle.png', 'character frames unchanged');
  // schema-v1 import still validates drafts that reference the flat ids
  const draft = miniEditorDraft();
  draft.items[0].kind = 'desk';
  draft.items[0].asset = 'flat-desk';
  draft.items[0].direction = 'front';
  assert.equal(editor.load(draft).ok, true, 'a draft using flat-desk passes the full schema-v1 validation');
});

test('E3a doc contract: the flat/ namespace rule in the 接入规范 matches the catalog', () => {
  // 依赖 s1 私有树 photo/ / docs/notes/，主仓不迁移：文档缺失时整条跳过（视为通过）。
  if (!fs.existsSync(path.join(__dirname, '..', 'docs', 'notes', 'office-editor.md'))) return;
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'notes', 'office-editor.md'), 'utf8');
  assert.match(doc, /resources\/office\/flat\//, 'the doc declares the flat/ namespace directory');
  assert.match(doc, /flat-desk/, 'the doc names the flat pilot ids');
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  for (const asset of LAYOUT_ASSETS.filter((entry) => entry.id.startsWith('flat-'))) {
    const rel = asset.src.slice('./office-assets/'.length);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'resources', 'office', rel)), true, `${asset.id} file matches the documented directory`);
  }
});

// ---------------------------------------------------------------------------
// Task E3d — contentBbox: the flat pilot art ships inside a 1024×1024 PNG with
// large transparent margins (art occupies ~50–66% linearly), which made the
// canvas item read as "smaller than placed" and the layers-panel thumbnail
// read as almost blank. Each flat entry declares the OPAQUE-ART bounding box,
// normalized inside the PNG and measured from the alpha channel (threshold 8)
// exactly once; renderers crop the margins WITHOUT touching the PNG bytes.
// This test locks the declared values to a fresh measurement (anti-drift).
// contentBbox is catalog data only — the draft schema is NOT extended.
// ---------------------------------------------------------------------------

test('E3d catalog: flat pilot entries declare a contentBbox matching the PNG alpha bounds', () => {
  const { LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  const flatEntries = LAYOUT_ASSETS.filter((asset) => asset.id.startsWith('flat-'));
  // E3e: EVERY flat entry must declare a contentBbox matching its PNG alpha
  // (the pilot trio plus every later batch), not just the original three.
  assert.ok(flatEntries.length >= 3, 'flat entries declare contentBbox (pilot trio + later batches)');
  const measure = (pngPath) => JSON.parse(execFileSync('python3', ['-c', [
    'import json, sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGBA")',
    'a = im.getchannel("A").point(lambda v: 255 if v > 8 else 0)',
    'b = a.getbbox()',
    'w, h = im.size',
    'print(json.dumps([b[0] / w, b[1] / h, (b[2] - b[0]) / w, (b[3] - b[1]) / h]))',
  ].join('\n'), pngPath]));
  for (const asset of flatEntries) {
    const bbox = asset.contentBbox;
    assert.ok(bbox, `${asset.id} declares contentBbox`);
    for (const key of ['x', 'y', 'w', 'h']) {
      assert.ok(Number.isFinite(bbox[key]) && bbox[key] > 0 && bbox[key] <= 1, `${asset.id}.contentBbox.${key} is a normalized fraction in (0,1]`);
    }
    assert.ok(bbox.x + bbox.w <= 1 + 1e-6 && bbox.y + bbox.h <= 1 + 1e-6, `${asset.id}.contentBbox stays inside the PNG`);
    const measured = measure(path.join(__dirname, '..', 'resources', 'office', 'flat', asset.src.slice('./office-assets/flat/'.length)));
    for (const [index, key] of [[0, 'x'], [1, 'y'], [2, 'w'], [3, 'h']]) {
      assert.ok(
        Math.abs(bbox[key] - measured[index]) <= 0.002,
        `${asset.id}.contentBbox.${key}=${bbox[key]} matches the measured alpha bounds ${measured[index]} (±0.002)`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Task E3b — visual depth order + per-group move locks (user-reported fixes).
// The E2e array-order buttons could not change occlusion between items with
// different layers; the depth buttons now work on the VISUAL (layer, array)
// order, and groups are LOOSE by default with a per-group 整组移动 lock.
// ---------------------------------------------------------------------------

function e3bDepthDraft() {
  return {
    schemaVersion: 1,
    scene: { width: 1000, height: 800 },
    items: [
      { id: 'a', kind: 'desk', asset: 'prop-desk-back-right-top', position: { x: 0.3, y: 0.3 }, scale: 1, direction: 'back-right-top', layer: 20 },
      { id: 'b', kind: 'monitor', asset: 'prop-monitor-back-right-top', position: { x: 0.31, y: 0.21 }, scale: 1, direction: 'back-right-top', layer: 40 },
      { id: 'c', kind: 'chair', asset: 'prop-chair-front-left-top', position: { x: 0.35, y: 0.25 }, scale: 1, direction: 'front-left-top', layer: 30 },
      { id: 'd', kind: 'chair', asset: 'prop-chair-front-left-top', position: { x: 0.4, y: 0.25 }, scale: 1, direction: 'front-left-top', layer: 30 },
    ],
  };
}

test('E3b visual order: cross-layer moves SWAP the layer values so occlusion really flips', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(e3bDepthDraft(), { recordHistory: false });
  // a(20) moves up: nearest above is c(30) — the two layer VALUES swap
  let r = editor.moveVisualUp('a');
  assert.equal(r.item.layer, 30);
  assert.equal(r.neighbour.id, 'c');
  assert.equal(r.neighbour.layer, 20);
  let byId = new Map(editor.toJSON().items.map((item) => [item.id, item.layer]));
  assert.deepEqual([...byId.entries()].sort(), [['a', 30], ['b', 40], ['c', 20], ['d', 30]], 'only the pair swapped');
  // again: a(30) vs d(30, same layer, later in the array) → ARRAY swap only
  r = editor.moveVisualUp('a');
  assert.equal(r.item.layer, 30);
  assert.deepEqual(editor.toJSON().items.map((item) => item.id), ['d', 'b', 'c', 'a'], 'same-layer neighbour swaps the array positions, layers untouched');
  // again: a(30) vs b(40) → layer swap
  r = editor.moveVisualUp('a');
  assert.equal(r.item.layer, 40);
  assert.equal(r.neighbour.id, 'b');
  assert.equal(r.neighbour.layer, 30);
  // a is now the visual front: further up is a no-op with no history
  const stable = editor.toJSON();
  assert.equal(editor.moveVisualUp('a'), null, 'already at the visual front');
  assert.deepEqual(editor.toJSON(), stable);
  // and down walks back the same path
  r = editor.moveVisualDown('a');
  assert.equal(r.item.layer, 30);
  assert.equal(r.neighbour.id, 'b');
  editor.undo(); // undoes ONLY the down
  assert.equal(editor.toJSON().items.find((item) => item.id === 'a').layer, 40);
});

test('E3b visual order: front/back lift beyond the extremes and clamp at the edges', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  editor.load(e3bDepthDraft(), { recordHistory: false });
  const front = editor.bringVisualToFront('a');
  assert.equal(front.layer, 41, 'beyond the current max (40)');
  assert.deepEqual(editor.toJSON().items.map((item) => item.id), ['b', 'c', 'd', 'a'], 'also moves to the array end');
  assert.equal(editor.bringVisualToFront('a'), null, 'already front: no-op, no history');
  const back = editor.sendVisualToBack('a');
  assert.equal(back.layer, 29, 'below the current min of the OTHERS (30)');
  assert.deepEqual(editor.toJSON().items.map((item) => item.id), ['a', 'b', 'c', 'd'], 'also moves to the array start');
  assert.equal(editor.sendVisualToBack('a'), null, 'already back: no-op, no history');
  // one undo unit each
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'a').layer, 41, 'undo restores front state');
  editor.undo();
  assert.equal(editor.toJSON().items.find((item) => item.id === 'a').layer, 20, 'undo restores pre-front');
});

test('E3b rigidGroups: optional schema field, per-group lock semantics and legacy compatibility', () => {
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  // legacy draft: no rigidGroups → {} emitted, still valid
  assert.equal(editor.load(miniEditorDraft()).ok, true);
  assert.deepEqual(editor.toJSON().rigidGroups, {});
  // explicit locks round-trip
  const locked = miniEditorDraft();
  locked.rigidGroups = { 'desk-a': true };
  assert.equal(editor.load(locked).ok, true);
  assert.deepEqual(editor.toJSON().rigidGroups, { 'desk-a': true });
  // invalid shapes rejected with a stable code, draft untouched
  const cases = [
    (draft) => { draft.rigidGroups = 'x'; },
    (draft) => { draft.rigidGroups = []; },
    (draft) => { draft.rigidGroups = { 'desk-a': 'yes' }; },
    (draft) => { draft.rigidGroups = { 'desk-a': 1 }; },
  ];
  const stable = editor.toJSON();
  for (const mutate of cases) {
    const draft = miniEditorDraft();
    mutate(draft);
    const result = editor.load(draft);
    assert.equal(result.ok, false, 'DRAFT_RIGID_GROUPS_INVALID must be rejected');
    assert.equal(result.code, 'DRAFT_RIGID_GROUPS_INVALID');
    assert.deepEqual(editor.toJSON(), stable);
  }
  // lock semantics: set/clear through the API, one undo unit, no-change no-op
  editor.load(miniEditorDraft(), { recordHistory: false });
  assert.equal(editor.isGroupMoveRigid('desk-a'), false, 'groups are LOOSE by default');
  assert.equal(editor.setGroupMoveRigid('no-such-group', true), null, 'unknown group rejected');
  assert.equal(editor.setGroupMoveRigid('desk-a', 'x'), null, 'non-boolean rejected');
  assert.equal(editor.setGroupMoveRigid('desk-a', true)['desk-a'], true);
  const afterLock = editor.toJSON();
  const same = editor.setGroupMoveRigid('desk-a', true);
  assert.deepEqual(same, { 'desk-a': true }, 'same-value returns the current map');
  assert.deepEqual(editor.toJSON(), afterLock, 'same-value lock records nothing');
  // a locked group still refuses the whole move when a member is locked (E2c)
  editor.setItemLocked('chair-a', true);
  assert.equal(editor.moveGroup('desk-a', 10, 0), null, 'rigid + locked member still refuses the whole drag');
  editor.setItemLocked('chair-a', false);
  // NOTE: the LOOSE drag behaviour lives on the PAGE path (single-member
  // canvas drags call editor.move instead of moveGroup when the group is not
  // locked) — moveSelection keeps its E2a group-expansion semantics, which
  // the E2a tests lock.
  // rigidity is preserved across undo of unrelated ops (snapshot carries it)
  editor.setGroupMoveRigid('desk-a', true);
  editor.move('monitor-a', 5, 0);
  editor.undo();
  assert.equal(editor.isGroupMoveRigid('desk-a'), true, 'lock survives unrelated undo');
  editor.setGroupMoveRigid('desk-a', false);
  assert.equal(editor.isGroupMoveRigid('desk-a'), false);
  assert.deepEqual(editor.toJSON().rigidGroups, {}, 'cleared locks disappear from the export');
});

// ---------------------------------------------------------------------------
// Task E4 — draft → runtime layout compiler (office-layout-compiler.js).
//
// RED: src/office/runtime/office-layout-compiler.js does not exist yet.
//
// Contracts under test:
// - the approved flat editor draft (hermetic copy + provenance) compiles into
//   a runtime layout ISOMORPHIC to the canonical isometric fixture: same 27
//   node ids with preserved tags/capacity/safeRadius, same 40-edge topology,
//   same layer order, workstations desk-1..6 in row-major order
// - furniture derives from draft items: flat asset ids, contentBbox art-box
//   footprints (draftWidths × scale), draft depth preserved, chairs become
//   fixture-declared front occluders, hidden items are excluded entirely
// - compilation is DETERMINISTIC: two runs are byte-identical, and the
//   committed src/office/fixtures/office-layout-flat.json equals the
//   compilation of the committed draft byte-for-byte (never hand-edited)
// - failures are diagnosable: stable OFFICE_COMPILE_* codes + conflict detail
// - the no-clipping walk sampler: every edge sampled at 1/200 with the
//   character's mover radius must clear every furniture footprint, exempting
//   only the furniture of the workstation an edge endpoint belongs to (the
//   seated employee necessarily overlaps her own chair/desk). It PASSES on
//   the isometric fixture and on the compiled flat layout, and FAILS on the
//   un-reprojected intermediate state (isometric coordinates + flat
//   furniture), which is the proof that the re-projection is load-bearing.
// ---------------------------------------------------------------------------

const FLAT_DRAFT = require('./fixtures/office-layout-flat-draft.json');
const FLAT_DRAFT_PROVENANCE = require('./fixtures/office-layout-flat-draft.provenance.json');
const FLAT_RUNTIME_FIXTURE = require('../src/office/fixtures/office-layout-flat.json');
const {
  compileOfficeLayout,
  sampleEdgeConflicts,
} = require('../src/office/runtime/office-layout-compiler.js');
const { LAYOUT_ASSETS: E4_LAYOUT_ASSETS, CHARACTER_FOOT_RATIO } = require('../src/office/layout-assets.js');
const { validateOfficeLayout } = require('../src/office/runtime/office-layout.js');

const DRAFT_WIDTHS = { desk: 180, chair: 110, monitor: 105, character: 96, prop: 120 };

function compileFlatDraft(draft) {
  return compileOfficeLayout({
    draft: draft || FLAT_DRAFT,
    assets: E4_LAYOUT_ASSETS,
    draftWidths: DRAFT_WIDTHS,
    characterFoot: CHARACTER_FOOT_RATIO,
    // the waypoint topology (27 ids / 40 edges / tags / capacity) is inherited
    // from the canonical isometric fixture — never re-invented
    topology: { nodes: CANONICAL_OFFICE_LAYOUT.nodes, edges: CANONICAL_OFFICE_LAYOUT.edges },
    // the generation script records the real SHA-256 of the draft file here
    sourceDraftSha256: require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, 'fixtures', 'office-layout-flat-draft.json')))
      .digest('hex'),
  });
}

test('E4 provenance: the hermetic flat draft copy records the real source hash', () => {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'fixtures', 'office-layout-flat-draft.json'))).digest('hex');
  assert.equal(hash, FLAT_DRAFT_PROVENANCE.sha256);
  assert.equal(FLAT_DRAFT_PROVENANCE.workstationCount, 6);
  assert.equal(FLAT_DRAFT.items.length, 38);
});

test('E4 compiler: the approved flat draft compiles into a canonical isomorphic runtime layout', () => {
  const result = compileFlatDraft();
  assert.equal(result.ok, true, `compile failed: ${JSON.stringify(result)}`);
  const layout = result.layout;
  const validation = validateOfficeLayout(layout);
  assert.equal(validation.ok, true, `compiled layout invalid: ${JSON.stringify(validation.errors)}`);
  assert.equal(layout.schemaVersion, 1);
  assert.deepEqual(layout.layers, ['background', 'back-furniture', 'ground-entities', 'front-occluders', 'effects-labels']);
  assert.deepEqual(layout.scene, { referenceWidth: 1280, referenceHeight: 840 });
  // M4.1b (2026-09-17): the flat topology is the isometric topology PLUS the
  // left-wing extension (roam-8/roam-9 + their two roaming edges) — the
  // user's left wing has furniture (twelve props) but the isometric topology
  // never had a node there.
  // M4.1f (2026-09-18): the flat compile DROPS the 11 direct desk-N↔roam-X
  // edges (their isometric walk-behind semantics read as 穿模 in the flat
  // projection — the walk-out diagonal cuts through the workstation art) and
  // re-tags the approach/leave chain + roam↔roam corridors with the full
  // behavior set so egress/ingress always walks the chain.
  const LEFT_WING_IDS = ['roam-8', 'roam-9'];
  assert.equal(layout.nodes.length, 27 + LEFT_WING_IDS.length, 'isometric nodes + the left-wing extension');
  assert.equal(layout.edges.length, 40 + 2 - 11, 'isometric + left-wing − the 11 direct seat↔roam edges');
  const isSeatId = (id) => /^desk-[1-6]$/.test(id);
  const isCorridorNodeId = (id) => /^(roam|chat)-/.test(id);
  for (const edge of layout.edges) {
    assert.equal(isSeatId(edge.from) && isCorridorNodeId(edge.to), false,
      `no direct seat↔roam edge may survive: ${edge.from}>${edge.to}`);
    assert.equal(isSeatId(edge.to) && isCorridorNodeId(edge.from), false,
      `no direct seat↔roam edge may survive: ${edge.from}>${edge.to}`);
    if ([edge.from, edge.to].some((id) => /^desk-[1-6]-(approach|leave)$/.test(id))) {
      assert.deepEqual([...edge.behaviors].sort(), ['chatting', 'roaming', 'sleeping', 'task'],
        `chain edge ${edge.from}>${edge.to} carries all behaviors`);
    }
    if ([edge.from, edge.to].every((id) => /^roam-/.test(id))) {
      assert.ok(edge.behaviors.includes('sleeping') && edge.behaviors.includes('chatting'),
        `corridor edge ${edge.from}>${edge.to} lets nap and chat walks pass`);
    }
  }
  const isoById = new Map(CANONICAL_OFFICE_LAYOUT.nodes.map((node) => [node.id, node]));
  for (const node of layout.nodes) {
    if (LEFT_WING_IDS.includes(node.id)) {
      assert.deepEqual(node.tags, ['roaming'], `${node.id} is a roaming node`);
      assert.equal(node.capacity, 2);
      assert.equal(node.safeRadius, 0.03);
      assert.ok(node.position.x < 0.45, `${node.id} lives in the left wing`);
      continue;
    }
    const iso = isoById.get(node.id);
    assert.notEqual(iso, undefined, `unexpected node ${node.id}`);
    assert.deepEqual(node.tags, iso.tags, `${node.id} tags preserved`);
    assert.equal(node.capacity, iso.capacity, `${node.id} capacity preserved`);
    assert.equal(node.safeRadius, iso.safeRadius, `${node.id} safeRadius preserved`);
  }
  const flatEdgeKeys = layout.edges.map((edge) => `${edge.from}>${edge.to}`).sort();
  const extensionEdges = new Set(['roam-8>roam-9', 'roam-9>roam-6']);
  const isoEdgeKeys = CANONICAL_OFFICE_LAYOUT.edges
    .filter((edge) => !(isSeatId(edge.from) && isCorridorNodeId(edge.to))
      && !(isSeatId(edge.to) && isCorridorNodeId(edge.from)))
    .map((edge) => `${edge.from}>${edge.to}`).sort();
  assert.deepEqual(flatEdgeKeys.filter((key) => !extensionEdges.has(key)), isoEdgeKeys,
    'edge topology preserved verbatim outside the dropped direct pairings');
  assert.deepEqual(flatEdgeKeys.filter((key) => extensionEdges.has(key)), [...extensionEdges].sort(), 'the only new edges are the left-wing pair');
});

test('E4 compiler: six workstations map row-major with flat template parts and real anchors', () => {
  const { layout } = compileFlatDraft();
  const workstations = layout.workstations;
  assert.equal(workstations.schemaVersion, 1);
  assert.equal(workstations.template.desk.assetId, 'flat-desk');
  assert.equal(workstations.template.monitor.assetId, 'flat-monitor');
  assert.equal(workstations.template.chair.assetId, 'flat-chair');
  const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
  for (const instance of workstations.instances) {
    const seatNode = nodesById.get(instance.deskId);
    assert.equal(seatNode.tags.includes('desk'), true);
    assert.deepEqual(instance.seat.position, seatNode.position, 'seat anchor == desk node position');
    const approach = nodesById.get(instance.approach.nodeId);
    const leave = nodesById.get(instance.leave.nodeId);
    assert.deepEqual(instance.approach.position, approach.position);
    assert.deepEqual(instance.leave.position, leave.position);
    assert.deepEqual(instance.position, seatNode.position);
  }
  // row-major: desk-1/2 top, desk-3/4 middle, desk-5/6 bottom, left before right
  const seats = workstations.instances.map((instance) => instance.position);
  for (let index = 0; index < 6; index += 2) {
    assert.equal(seats[index].x < seats[index + 1].x, true, `row ${index / 2}: left seat must be left of right seat`);
    if (index > 0) assert.equal(seats[index - 2].y < seats[index].y, true, `row ${index / 2 - 1} must sit above row ${index / 2}`);
  }
});

test('E4 compiler: the seat anchor is the character foot point from the draft placement', () => {
  const { layout } = compileFlatDraft();
  // workstation desk-1 = top-left = desk draft-29 + group-1 (character draft-39)
  const char = FLAT_DRAFT.items.find((item) => item.id === 'draft-39');
  const nodeW = DRAFT_WIDTHS.character * char.scale;
  const expected = {
    x: char.position.x + (CHARACTER_FOOT_RATIO.x - 0.5) * nodeW / 1280,
    y: char.position.y + (CHARACTER_FOOT_RATIO.y - 0.5) * nodeW / 840,
  };
  const seat = layout.workstations.instances[0].seat.position;
  assert.ok(Math.abs(seat.x - expected.x) < 1e-9, `seat x ${seat.x} ~ ${expected.x}`);
  assert.ok(Math.abs(seat.y - expected.y) < 1e-9, `seat y ${seat.y} ~ ${expected.y}`);
});

test('E4 compiler: furniture derives flat art boxes with draft depth and occluder chairs', () => {
  const { layout } = compileFlatDraft();
  const furniture = layout.furniture;
  // 6 desks + 6 monitors + 6 chairs + 14 props; characters are NOT furniture
  assert.equal(furniture.length, 32);
  const chairs = furniture.filter((item) => item.assetId === 'flat-chair');
  assert.equal(chairs.length, 6);
  for (const chair of chairs) {
    assert.equal(chair.layer, 'front-occluders');
    assert.equal(chair.occluder, true, 'seated composition: the chair paints above the character');
  }
  const desks = furniture.filter((item) => item.assetId === 'flat-desk');
  assert.equal(desks.length, 6);
  for (const desk of desks) assert.equal(desk.kind, 'desk-back', 'desk bodies keep the main paint role');
  const props = furniture.filter((item) => item.assetId === 'flat-island');
  assert.equal(props.length, 1);
  // art box for the island: draftWidths.prop × scale wide, contentBbox aspect tall
  const island = FLAT_DRAFT.items.find((item) => item.asset === 'flat-island');
  const islandBox = props[0].parts.main;
  const boxW = DRAFT_WIDTHS.prop * island.scale / 1280;
  const bbox = E4_LAYOUT_ASSETS.find((asset) => asset.id === 'flat-island').contentBbox;
  const boxH = (boxW * 1280) * (bbox.h / bbox.w) / 840;
  assert.ok(Math.abs(islandBox.width - boxW) < 1e-9);
  assert.ok(Math.abs(islandBox.height - boxH) < 1e-9);
  assert.ok(Math.abs(islandBox.x + islandBox.width / 2 - island.position.x) < 1e-9, 'art box centered on the draft position');
  assert.ok(Math.abs(islandBox.y + islandBox.height / 2 - island.position.y) < 1e-9);
  for (const item of furniture) {
    assert.equal(typeof item.assetId, 'string', `${item.id} carries its managed asset id`);
    assert.equal(typeof item.depth, 'number', `${item.id} carries the draft depth`);
    assert.notEqual(item.hidden, true, 'hidden items never reach the runtime fixture');
  }
  // characters never become furniture (the live pack renders the employees)
  assert.equal(furniture.some((item) => item.kind === 'character'), false);
});

test('E4 compiler: hidden draft items are excluded from furniture and from the collision set', () => {
  const draft = JSON.parse(JSON.stringify(FLAT_DRAFT));
  const prop = draft.items.find((item) => item.asset === 'flat-coffee-table');
  prop.hidden = true;
  const result = compileFlatDraft(draft);
  assert.equal(result.ok, true);
  assert.equal(result.layout.furniture.length, 31, 'the hidden coffee table is not furniture');
  assert.equal(result.layout.furniture.some((item) => item.assetId === 'flat-coffee-table'), false);
  // and the walk graph must still verify (the sofa no longer collides)
  assert.deepEqual(sampleEdgeConflicts(result.layout), []);
});

test('E4 compiler: compilation is deterministic and equals the committed runtime fixture', () => {
  const first = compileFlatDraft();
  const second = compileFlatDraft();
  assert.equal(first.ok && second.ok, true);
  assert.equal(JSON.stringify(first.layout), JSON.stringify(second.layout), 'two compiles are identical');
  const serialized = `${JSON.stringify(first.layout, null, 2)}\n`;
  const committed = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8');
  assert.equal(serialized, committed, 'the committed fixture is exactly the compiler output (never hand-edited)');
});

test('E4 compiler: failures carry stable codes and name the offending items', () => {
  const cases = [
    ['not an object', () => compileFlatDraft('nope'), 'OFFICE_COMPILE_DRAFT_INVALID'],
    ['bad schema', () => compileFlatDraft({ ...FLAT_DRAFT, schemaVersion: 2 }), 'OFFICE_COMPILE_DRAFT_INVALID'],
    ['bad scene', () => compileFlatDraft({ ...FLAT_DRAFT, scene: { width: 0, height: 840 } }), 'OFFICE_COMPILE_DRAFT_INVALID'],
    ['items not array', () => compileFlatDraft({ ...FLAT_DRAFT, items: 'nope' }), 'OFFICE_COMPILE_DRAFT_INVALID'],
  ];
  for (const [label, run, code] of cases) {
    const result = run();
    assert.equal(result.ok, false, label);
    assert.equal(result.code, code, label);
  }
  const missingDesk = JSON.parse(JSON.stringify(FLAT_DRAFT));
  missingDesk.items = missingDesk.items.filter((item) => item.id !== 'draft-29');
  let result = compileFlatDraft(missingDesk);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OFFICE_COMPILE_WORKSTATION_COUNT');
  assert.equal(result.detail.deskCount, 5);

  const unknownAsset = JSON.parse(JSON.stringify(FLAT_DRAFT));
  unknownAsset.items.find((item) => item.asset === 'flat-coffee-table').asset = 'not-in-catalog';
  result = compileFlatDraft(unknownAsset);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OFFICE_COMPILE_ASSET_UNKNOWN');
  assert.match(result.detail.items.join(','), /draft-64|flat-coffee-table|not-in-catalog/);

  const missingChair = JSON.parse(JSON.stringify(FLAT_DRAFT));
  missingChair.items = missingChair.items.filter((item) => item.id !== 'draft-33');
  result = compileFlatDraft(missingChair);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OFFICE_COMPILE_WORKSTATION_MEMBER_MISSING');
  assert.equal(result.detail.memberKinds.includes('chair'), true);

  const badPosition = JSON.parse(JSON.stringify(FLAT_DRAFT));
  badPosition.items.find((item) => item.id === 'draft-27').position.x = 1.5;
  result = compileFlatDraft(badPosition);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OFFICE_COMPILE_ITEM_INVALID');
  assert.equal(result.detail.items.includes('draft-27'), true);
});

test('E4 sampler: the isometric fixture passes the no-clipping walk under its legacy semantics', () => {
  // The isometric projection elevates workstation furniture, so a foot point
  // inside a desk rect reads as walking BEHIND the desk (occlusion, not
  // clipping) — legacy-iso mode keeps only props/zone markers solid. The old
  // layout avoids every one of those.
  const conflicts = sampleEdgeConflicts(CANONICAL_OFFICE_LAYOUT, { mode: 'legacy-iso' });
  assert.deepEqual(conflicts, [], `isometric fixture walk conflicts: ${JSON.stringify(conflicts.slice(0, 4))}`);
  // Documented motivation for the flat rework's own gate: under the STRICT
  // flat semantics the old isometric walk graph really does cross other
  // workstations' furniture rects.
  assert.equal(sampleEdgeConflicts(CANONICAL_OFFICE_LAYOUT).length > 0, true);
});

test('E4 sampler: the compiled flat layout passes the strict no-clipping walk', () => {
  const conflicts = sampleEdgeConflicts(FLAT_RUNTIME_FIXTURE);
  assert.deepEqual(conflicts, [], `flat layout walk conflicts: ${JSON.stringify(conflicts.slice(0, 6))}`);
  assert.deepEqual(sampleEdgeConflicts(FLAT_RUNTIME_FIXTURE, { mode: 'legacy-iso' }), [],
    'the flat layout also satisfies the legacy semantics');
});

test('E4 sampler: un-reprojected isometric coordinates over flat furniture FAIL', () => {
  // the load-bearing intermediate state: same 27-node/40-edge topology, same
  // flat furniture, but the node coordinates were never re-projected
  const isoNodes = new Map(CANONICAL_OFFICE_LAYOUT.nodes.map((node) => [node.id, node.position]));
  const intermediate = JSON.parse(JSON.stringify(FLAT_RUNTIME_FIXTURE));
  for (const node of intermediate.nodes) node.position = { ...isoNodes.get(node.id) };
  const conflicts = sampleEdgeConflicts(intermediate);
  assert.equal(conflicts.length > 0, true, 'the intermediate state must violate the strict flat walk');
  assert.equal(sampleEdgeConflicts(intermediate, { mode: 'legacy-iso' }).length > 0, true,
    'the intermediate state must also violate the legacy walk (props are crossed too)');
  for (const conflict of conflicts) {
    assert.equal(typeof conflict.edge, 'string');
    assert.equal(typeof conflict.furnitureId, 'string');
    assert.equal(typeof conflict.point.x, 'number');
    assert.equal(typeof conflict.point.y, 'number');
  }
});

test('E4 character foot ratio matches the production pack calibration', () => {
  const anchors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default', 'animation', 'anchors.json'), 'utf8'));
  const frame = anchors.frames['assets/animations/side/none/side-back.png'];
  assert.equal(CHARACTER_FOOT_RATIO.x, frame.outputAnchor.x / 352);
  assert.equal(CHARACTER_FOOT_RATIO.y, frame.outputAnchor.y / 352);
});

test('E6d: the pack registers the working-back seated-work loop (the three M3 candidates)', () => {
  const packRoot = path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default');
  const animationsDoc = JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'animations.json'), 'utf8'));
  const anchorsDoc = JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'anchors.json'), 'utf8'));
  const entry = animationsDoc.animations['working-back'];
  assert.ok(entry, 'working-back is registered in animations.json');
  assert.equal(entry.state, 'working-back');
  assert.equal(entry.direction, 'none');
  assert.equal(entry.loop, true, 'the seated-work cycle loops');
  // 2026-09-17 用户最终定：只用 [04,05,06] 三帧（01/02 尺寸与稳定性顾虑，出列）
  assert.equal(entry.frames.length, 3, 'three seated-work frames');
  assert.deepEqual(entry.frames.map((f) => f.file.split('/').pop()),
    ['working-back-04.png', 'working-back-05.png', 'working-back-06.png']);
  const { decodePng, alphaBounds } = require('../src/workbench/lib/png-geometry.js');
  const { measureContact } = require('../src/workbench/lib/normalizer.js');
  const sideBackHeight = anchorsDoc.frames['assets/animations/side/none/side-back.png'].visibleBounds.height;
  for (const frame of entry.frames) {
    assert.match(frame.file, /^assets\/animations\/working\/back\/working-back-0[456]\.png$/);
    // 2026-09-22（用户实测"工作动画用错了"）：working-back 三帧此前 durationMs=null，
    // 落到 pack 默认的 1000ms/帧 → 三帧循环要 3 秒，看起来几乎静止。定稿为 350ms/帧
    // （3 帧 ≈ 1.05s 的坐姿小动作循环，可调）。
    assert.equal(frame.durationMs, 350, 'the seated-work loop runs at the 350ms per-frame pace');
    const declared = anchorsDoc.frames[frame.file];
    assert.ok(declared, `anchors.json declares ${frame.file}`);
    assert.deepEqual(declared.outputAnchor, { x: 178, y: 296 }, 'the declared foot contact is the pack anchor');
    const image = decodePng(fs.readFileSync(path.join(packRoot, frame.file)));
    assert.equal(image.width, 352, 'the frame lives on the 352-wide output canvas');
    assert.equal(image.height, 352, 'the frame lives on the 352-high output canvas');
    const contact = measureContact(image);
    assert.ok(contact && Math.abs(contact.x - 178) <= 2 && Math.abs(contact.y - 296) <= 1,
      `the measured contact (${contact && contact.x},${contact && contact.y}) stays on the pack geometry (y ±1px like the M1 pipeline, x ±2px for fractional medians)`);
    const bounds = alphaBounds(image, 8);
    assert.ok(
      Math.abs(bounds.x - declared.visibleBounds.x) <= 1
      && Math.abs(bounds.y - declared.visibleBounds.y) <= 1
      && Math.abs(bounds.w - declared.visibleBounds.width) <= 1
      && Math.abs(bounds.h - declared.visibleBounds.height) <= 1,
      `the declared visibleBounds match the PNG art (±1px): ${JSON.stringify(declared.visibleBounds)} vs ${JSON.stringify(bounds)}`
    );
    assert.ok(Math.abs(declared.visibleBounds.height - sideBackHeight) <= 2,
      'the seated art height matches the side-back pose (state-independent size)');
    assert.deepEqual(frame.visibleBounds, declared.visibleBounds, 'animations.json mirrors the anchors.json bounds');
  }
  // the extended pack still loads through the runtime resolver
  const manifest = JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8'));
  const resolved = assetPack.createAssetPack({ manifest, anchors: anchorsDoc, animations: animationsDoc });
  assert.equal(resolved.ok, true, 'the extended pack stays valid');
  const meta = resolved.pack.animation('working-back');
  assert.ok(meta, 'the resolver exposes the working-back animation');
  assert.equal(meta.frames.length, 3);
  assert.equal(meta.loop, true);
});

test('E4 resolver: the runtime layout source chain picks saved-compiled > bundled-flat > isometric', () => {
  const { resolveRuntimeLayout } = require('../src/office/runtime/office-layout-compiler.js');
  const validate = (fixture) => validateOfficeLayout(fixture);
  const shared = {
    flatFixture: FLAT_RUNTIME_FIXTURE,
    isometricFixture: CANONICAL_OFFICE_LAYOUT,
    validateLayout: validate,
    assets: E4_LAYOUT_ASSETS,
    draftWidths: DRAFT_WIDTHS,
    characterFoot: CHARACTER_FOOT_RATIO,
  };
  // 1. a valid saved draft compiles into the runtime layout
  let resolved = resolveRuntimeLayout({ ...shared, savedDraft: FLAT_DRAFT });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'saved-compiled');
  assert.deepEqual(sampleEdgeConflicts(resolved.layout), []);
  // 2. a present-but-uncompilable saved draft (e.g. an isometric-era draft
  // saved before the flat rework) degrades down the chain WITH its diagnostic
  const broken = JSON.parse(JSON.stringify(FLAT_DRAFT));
  broken.items = broken.items.filter((item) => item.id !== 'draft-29');
  resolved = resolveRuntimeLayout({ ...shared, savedDraft: broken });
  assert.equal(resolved.ok, true, 'a broken saved draft never blocks the boot');
  assert.equal(resolved.source, 'bundled-flat');
  assert.equal(resolved.code, 'OFFICE_LAYOUT_SAVED_INVALID');
  assert.equal(resolved.detail.compileCode, 'OFFICE_COMPILE_WORKSTATION_COUNT');
  // ...all the way to the isometric fallback when the flat fixture is broken too
  resolved = resolveRuntimeLayout({ ...shared, savedDraft: broken, flatFixture: { schemaVersion: 1 } });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'isometric-fallback');
  assert.equal(resolved.code, 'OFFICE_LAYOUT_SAVED_INVALID');
  // 3. no saved draft (normal first run) serves the bundled compiled fixture
  resolved = resolveRuntimeLayout({ ...shared, savedDraft: undefined });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'bundled-flat');
  // 4. a broken bundled flat fixture degrades to the isometric fallback
  resolved = resolveRuntimeLayout({ ...shared, savedDraft: undefined, flatFixture: { schemaVersion: 1 } });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.source, 'isometric-fallback');
  // 5. nothing available is a stable unavailable code (never a throw)
  resolved = resolveRuntimeLayout({ ...shared, savedDraft: undefined, flatFixture: null, isometricFixture: null });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, 'OFFICE_LAYOUT_UNAVAILABLE');
});

test('E4.6 archive: the isometric family stays resolvable for the fallback path and legacy drafts', () => {
  const { ARCHIVED_LAYOUT_ASSETS, layoutAssetById, LAYOUT_ASSETS } = require('../src/office/layout-assets.js');
  // the canonical isometric fixture's furniture keeps rendering in the
  // fallback chain: its asset ids must still resolve and point at real files
  for (const assetId of ['prop-desk-back-right-top', 'prop-monitor-back-right-top', 'prop-chair-front-left-top']) {
    const entry = layoutAssetById(assetId);
    assert.notEqual(entry, null, `${assetId} stays resolvable`);
    assert.equal(entry.src, `./office-assets/layout-editor/${assetId}.png`);
    const diskPath = path.join(__dirname, '..', 'resources', 'office', 'layout-editor', `${assetId}.png`);
    assert.equal(existsSync(diskPath), true, `${assetId}.png stays on disk`);
  }
  // the editor whitelist (ASSET_BY_ID) covers archived ids for legacy drafts
  const editor = createLayoutEditor({ scene: { width: 1000, height: 800 } });
  const legacyDraft = {
    schemaVersion: 1,
    scene: { width: 1000, height: 800 },
    items: [{ id: 'draft-1', kind: 'desk', asset: 'prop-desk-front', position: { x: 0.5, y: 0.5 }, scale: 1, direction: 'front', layer: 40, groupId: null }],
  };
  assert.equal(editor.load(legacyDraft).ok, true, 'a legacy draft referencing an archived asset still imports');
  assert.equal(LAYOUT_ASSETS.some((asset) => asset.id === 'prop-desk-front'), false);
});

test('E5a-R2: the compiler carries the composed character scale and direction into the runtime layout', () => {
  const { layout } = compileFlatDraft();
  for (const [index, instance] of layout.workstations.instances.entries()) {
    assert.ok(instance.character, `desk-${index + 1} carries composed character data`);
    assert.ok(Number.isFinite(instance.character.scale) && instance.character.scale > 0,
      `desk-${index + 1} carries a positive composed scale`);
    assert.equal(instance.character.direction, 'back', 'the composed seated pose is the back view');
  }
  // desk-1 = the top-left workstation = the draft-39 character item
  const char = FLAT_DRAFT.items.find((item) => item.id === 'draft-39');
  assert.ok(Math.abs(layout.workstations.instances[0].character.scale - char.scale) < 1e-9,
    `desk-1 scale === draft-39 scale (${char.scale})`);
  // schema-v1 compatibility: the validator tolerates the new instance field
  assert.equal(validateOfficeLayout(layout).ok, true, 'the compiled layout still validates');
});

// ---------------------------------------------------------------------------
// Task M0 — the content/** scaffold + the publish validator + the geometry
// report (docs/notes/office-workbench-m0.md §2/§4). The workbench tool libs
// (src/workbench/lib/*) are TOOL code — tests may import them; the product
// entry points must never (boundary test in office-ui.test.js).
// ---------------------------------------------------------------------------

test('M0 content scaffold: character.json carries the pack contract values', () => {
  const character = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'characters', 'whale-girl', 'character.json'), 'utf8'));
  assert.equal(character.schemaVersion, 1);
  assert.equal(character.id, 'whale-girl');
  assert.deepEqual(character.pack, {
    canvas: 352,
    anchor: { x: 178, y: 296 },
    footLine: 296,
    // 2026-09-22 二代行走（方案B）重标定：四个方向换成逐帧序列后，
    // 声明值同步到实测 union（该值仅被校验器消费，运行时不使用）
    unionVisibleBounds: { x: 36, y: 40, w: 289, h: 278 },
  });
  assert.equal(character.defaults.frameDurationMs, 1000, 'the frozen 1000ms/frame pace is documented');
  assert.equal(character.provenance.sourcePack, 'resources/characters/deepseek-default', 'provenance points at the generation source (D4)');
  const expectedWalkFrames = { 'walk-left': 15, 'walk-right': 15, 'walk-up': 14, 'walk-down': 15 };
  for (const actionId of ['walk-left', 'walk-right', 'walk-up', 'walk-down']) {
    const action = character.actions.find((entry) => entry.id === actionId);
    assert.ok(action, `${actionId} present`);
    assert.equal(action.frames.length, expectedWalkFrames[actionId], `${actionId} carries the 2026-09-22 sequence`);
    assert.equal(action.loop, true);
    const files = action.frames.map((frame) => frame.file);
    assert.ok(files.every((file) => /-b\d\d\.png$/.test(file)), `${actionId} plays the b01.. second-generation frames`);
    assert.equal(files.some((file) => file.includes('passing')), false, `${actionId} carries no legacy passing frame`);
  }
});

test('M0 geometry report: every walk frame is within ±1px shoe line / ±2px height of the direction median', () => {
  const { buildWalkGeometryReport } = require('../src/workbench/lib/character-geometry.js');
  const character = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'characters', 'whale-girl', 'character.json'), 'utf8'));
  const report = buildWalkGeometryReport({
    character,
    resolveFramePath: (charJson, frame) => path.join(__dirname, '..', charJson.provenance.sourcePack, frame.file),
  });
  assert.equal(report.totalFrames, 59, 'four walk directions × (15/15/14/15) frames measured');
  assert.equal(report.redFrames, 0, 'all frames green at the M0 tolerances');
  for (const row of report.rows) {
    assert.ok(row.measured.footLine !== null, `${row.file} shoe line measured (alpha>=128 lowest row)`);
    assert.ok(Math.abs(row.deviation.footLine) <= report.tolerance.footPx, `${row.file} shoe line Δ${row.deviation.footLine}px within ±1px`);
    assert.ok(Math.abs(row.deviation.visibleHeight) <= report.tolerance.heightPx, `${row.file} visible height Δ${row.deviation.visibleHeight}px within ±2px`);
  }
  // the declared per-frame geometry must still match the PNG bytes (anti-drift)
  for (const action of character.actions) {
    for (const frame of action.frames) {
      const measured = require('../src/workbench/lib/character-geometry.js').measureFrameFile(path.join(__dirname, '..', character.provenance.sourcePack, frame.file));
      assert.equal(measured.ok, true, `${frame.file} decodes`);
      assert.equal(frame.geometry.footLine, measured.footLine, `${frame.file} declared footLine matches the PNG`);
      assert.equal(frame.geometry.visibleHeight, measured.visibleHeight, `${frame.file} declared visibleHeight matches the PNG`);
    }
  }
});

test('M0 content scaffold: layout.json passes validateDraftSchema (the approved flat draft)', () => {
  const draft = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'scenes', 'flat', 'layout.json'), 'utf8'));
  assert.equal(draft.schemaVersion, 1);
  assert.deepEqual(draft.scene, { width: 1280, height: 840 });
  const editor = createLayoutEditor({ scene: { width: 1280, height: 840 } });
  const probe = editor.validateDraftSchema(draft);
  assert.equal(probe.ok, true, `layout.json validates (${probe.code || 'ok'})`);
  assert.equal(draft.items.filter((item) => item.kind === 'desk').length, 6, 'the approved six workstations');
});

test('M0 content scaffold: scene.json + zones.json carry the approved M0 values', () => {
  const scene = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'scenes', 'flat', 'scene.json'), 'utf8'));
  assert.equal(scene.schemaVersion, 1);
  assert.deepEqual(scene.logical, { width: 1280, height: 840 });
  assert.equal(scene.groundLine, 0.62);
  assert.deepEqual(scene.depthBands, {
    background: [0, 10],
    floor: [10, 20],
    furniture: [20, 40],
    character: [45],
    foreground: [50, 60],
  });
  const zones = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'scenes', 'flat', 'zones.json'), 'utf8'));
  assert.deepEqual(zones.walkable, [{ kind: 'rect', rect: [0.06, 0.06, 0.88, 0.86] }]);
  assert.equal(zones.graph.derive, 'auto');
  assert.equal(zones.validation.sampleStep, 0.005);
  assert.equal(zones.validation.moverRadius, 0.02);
  assert.equal(zones.validation.exemptSameStation, true);
  // the obstacles are the M0 initial value derived from layout.json through
  // the E4 compiler — recompile and compare (±0.002)
  const { compileOfficeLayout } = require('../src/office/runtime/office-layout-compiler.js');
  const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require('../src/office/layout-assets.js');
  const draft = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'scenes', 'flat', 'layout.json'), 'utf8'));
  const compiled = compileOfficeLayout({
    draft,
    assets: LAYOUT_ASSETS,
    draftWidths: DRAFT_WIDTHS,
    characterFoot: CHARACTER_FOOT_RATIO,
    topology: { nodes: CANONICAL_OFFICE_LAYOUT.nodes, edges: CANONICAL_OFFICE_LAYOUT.edges },
  });
  assert.equal(compiled.ok, true, 'the content layout compiles with the E4 compiler');
  assert.equal(zones.obstacles.length, compiled.layout.furniture.length, 'one obstacle per compiled furniture piece');
  for (const item of compiled.layout.furniture) {
    const obstacle = zones.obstacles.find((entry) => entry.id === item.id);
    assert.ok(obstacle, `obstacle present for ${item.id}`);
    const rect = Object.values(item.parts)[0];
    for (const [index, key] of [[0, 'x'], [1, 'y'], [2, 'width'], [3, 'height']]) {
      assert.ok(Math.abs(obstacle.rect[index] - rect[key]) <= 0.002, `${item.id}.${key} matches the compiled footprint`);
    }
  }
});

test('M0 publish validator: content/** validates green via the CLI and fails closed on a tampered copy', () => {
  // green: the real content tree passes and a report is written
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'workbench-publish.js')], { stdio: 'pipe' });
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'build', 'report.json'), 'utf8'));
  assert.equal(report.ok, true, 'every content entry validates');
  assert.ok(report.entries.some((entry) => entry.file.endsWith('character.json')));
  assert.ok(report.entries.some((entry) => entry.file.endsWith('layout.json')));
  // red: a tampered temp copy lists ALL violations and exits non-zero
  const tmp = mkdtempSync(path.join(tmpdir(), 'm0-publish-red-'));
  fs.cpSync(path.join(__dirname, '..', 'content'), tmp, { recursive: true });
  fs.rmSync(path.join(tmp, 'build'), { recursive: true, force: true });
  const scenePath = path.join(tmp, 'scenes', 'flat', 'scene.json');
  const scene = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
  scene.groundLine = 0.5;
  fs.writeFileSync(scenePath, JSON.stringify(scene, null, 2));
  const zonesPath = path.join(tmp, 'scenes', 'flat', 'zones.json');
  const zones = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));
  zones.validation.sampleStep = 0.05;
  fs.writeFileSync(zonesPath, JSON.stringify(zones, null, 2));
  let failed = false;
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'workbench-publish.js'), '--content-dir', tmp, '--report', path.join(tmp, 'build', 'report.json')], { stdio: 'pipe' });
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'tampered content must fail the publish validation');
  const redReport = JSON.parse(fs.readFileSync(path.join(tmp, 'build', 'report.json'), 'utf8'));
  assert.equal(redReport.ok, false);
  assert.ok(redReport.violations.some((violation) => violation.file.endsWith('scene.json') && violation.check === 'groundLine'), 'the groundLine violation is listed');
  assert.ok(redReport.violations.some((violation) => violation.file.endsWith('zones.json') && violation.check === 'validation.sampleStep'), 'the sampleStep violation is listed');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Task M1 — the Workbench ACTION EDITOR (successor of the M0 section above;
// docs/notes/office-workbench-design.md §6.2/§8). The workbench tool libs
// (src/workbench/lib/*) are TOOL code — tests may import them; the product
// entry points must never (boundary test in office-ui.test.js).
//
// Sections: content layer (D1: actions/*.json migrated verbatim from the
// pack), the pure action model (reorder/duration/loop + validation), the
// deterministic import normalizer, the canonical pack serializer and the
// publish kernel (D5: sync resources/** with backup + provenance, fail-closed,
// "no change records nothing").
// ---------------------------------------------------------------------------

const M1_CONTENT_DIR = path.join(__dirname, '..', 'content');
const M1_PACK_ROOT = path.join(__dirname, '..', 'resources', 'characters', 'deepseek-default');
const M1_CHARACTER_DIR = path.join(M1_CONTENT_DIR, 'characters', 'whale-girl');

function m1Lib(name) {
  const abs = path.join(__dirname, '..', 'src', 'workbench', 'lib', name);
  if (!existsSync(abs)) {
    throw new Error(`M1 lib missing: src/workbench/lib/${name} (not implemented yet)`);
  }
  return require(abs);
}

// Resolve an action frame file exactly like the editor does: content assets
// first (imported, not-yet-published frames), then the provenance pack.
function m1ResolveActionFrame(file) {
  const contentAsset = path.join(M1_CHARACTER_DIR, 'assets', file);
  if (existsSync(contentAsset)) return contentAsset;
  const packFile = path.join(M1_PACK_ROOT, file);
  if (existsSync(packFile)) return packFile;
  return null;
}

function m1ReadAction(actionId) {
  return JSON.parse(fs.readFileSync(path.join(M1_CHARACTER_DIR, 'actions', `${actionId}.json`), 'utf8'));
}

function m1Sandbox({ withBuild = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'm1-sandbox-'));
  const contentDir = path.join(root, 'content');
  const charactersRoot = path.join(root, 'characters');
  fs.mkdirSync(path.join(contentDir, 'characters', 'whale-girl'), { recursive: true });
  fs.mkdirSync(charactersRoot, { recursive: true });
  fs.cpSync(M1_CHARACTER_DIR, path.join(contentDir, 'characters', 'whale-girl'), { recursive: true });
  fs.cpSync(M1_PACK_ROOT, path.join(charactersRoot, 'deepseek-default'), { recursive: true });
  if (!withBuild) fs.rmSync(path.join(contentDir, 'build'), { recursive: true, force: true });
  // The sandbox clones a PRISTINE draft: workbench-owned output directories
  // (build/, and the publish kernel's append-only provenance/) are tool
  // outputs, not content source — excluded exactly like build/ above so the
  // sandbox is independent of prior real publish runs.
  fs.rmSync(path.join(contentDir, 'characters', 'whale-girl', 'provenance'), { recursive: true, force: true });
  return { root, contentDir, charactersRoot };
}

// --- content layer (D1) ------------------------------------------------------

test('M1 content: actions/walk-left.json + walk-right.json migrate the pack sequence verbatim', () => {
  const packAnimations = JSON.parse(fs.readFileSync(path.join(M1_PACK_ROOT, 'animation', 'animations.json'), 'utf8'));
  for (const actionId of ['walk-left', 'walk-right']) {
    const docPath = path.join(M1_CHARACTER_DIR, 'actions', `${actionId}.json`);
    assert.ok(existsSync(docPath), `${actionId}.json exists`);
    const doc = m1ReadAction(actionId);
    // the §6.2 contract: exactly these top-level keys
    assert.deepEqual(Object.keys(doc).sort(), ['direction', 'frames', 'geometry', 'id', 'loop', 'schemaVersion']);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.id, actionId);
    const packEntry = packAnimations.animations[actionId];
    assert.equal(doc.loop, packEntry.loop, 'loop matches the pack metadata');
    assert.equal(doc.direction, packEntry.direction, 'direction matches the pack metadata');
    assert.deepEqual(
      doc.frames.map((frame) => ({ file: frame.file, durationMs: frame.durationMs })),
      packEntry.frames.map((frame) => ({ file: frame.file, durationMs: frame.durationMs })),
      'frame order AND durations migrate verbatim (array order is the data, never file names)'
    );
    // footLine is written automatically from the same-action shoe-line median
    const { measureFrameFile, median } = m1Lib('character-geometry.js');
    const feet = doc.frames.map((frame) => measureFrameFile(m1ResolveActionFrame(frame.file)).footLine);
    // 8 帧序列（含 c 卡）的鞋线中位数可能落在 295.5；geometry.footLine 是整数契约
    assert.equal(doc.geometry.footLine, Math.round(median(feet)), `geometry.footLine is the measured shoe-line median rounded (${median(feet)})`);
    assert.equal(doc.geometry.tolerancePx, 1);
  }
});

// --- pure action model --------------------------------------------------------

test('M1 action model: reordering moves array entries (frame order = array order) and ignores no-ops', () => {
  const { moveFrame } = m1Lib('action-model.js');
  const action = m1ReadAction('walk-left');
  const base = action.frames.map((frame) => frame.file.split('/').pop());
  // 数组顺序即数据：把 index 2 上移一位 -> 相邻两项交换（与文件名无关）
  const expectedSwap = [...base];
  [expectedSwap[1], expectedSwap[2]] = [expectedSwap[2], expectedSwap[1]];
  const first = moveFrame({ ...action, frames: action.frames.slice() }, 2, 1);
  assert.equal(first.changed, true);
  assert.deepEqual(first.action.frames.map((frame) => frame.file.split('/').pop()), expectedSwap);
  // moving it back restores the pack order
  const back = moveFrame(first.action, 1, 2);
  assert.equal(back.changed, true);
  assert.deepEqual(back.action.frames.map((frame) => frame.file.split('/').pop()), base);
  // no-op moves change nothing
  assert.equal(moveFrame(back.action, 1, 1).changed, false);
  assert.equal(moveFrame(back.action, -1, 0).changed, false);
  assert.equal(moveFrame(back.action, 0, 99).changed, false);
  assert.deepEqual(back.action.frames.map((frame) => frame.file.split('/').pop()), base, 'no-op leaves the order untouched');
});

test('M1 action model: duration edits accept null or 50..5000ms, loop toggles', () => {
  const { setFrameDuration, setLoop, MIN_FRAME_MS, MAX_FRAME_MS } = m1Lib('action-model.js');
  assert.equal(MIN_FRAME_MS, 50);
  assert.equal(MAX_FRAME_MS, 5000);
  const action = m1ReadAction('walk-left');
  const edited = setFrameDuration({ ...action, frames: action.frames.slice() }, 0, 1200);
  assert.equal(edited.changed, true);
  assert.equal(edited.action.frames[0].durationMs, 1200);
  assert.equal(setFrameDuration(edited.action, 0, null).action.frames[0].durationMs, null, 'null inherits the pack default');
  assert.equal(setFrameDuration(edited.action, 0, null).changed, false, 'a repeated null edit is a no-op');
  for (const bad of [49, 5001, 0, -1, 12.5, 'x', Infinity]) {
    assert.throws(() => setFrameDuration({ ...action, frames: action.frames.slice() }, 0, bad), /FRAME_DURATION_INVALID/,
      `duration ${String(bad)} must be rejected`);
  }
  const looped = setLoop({ ...action }, false);
  assert.equal(looped.changed, true);
  assert.equal(looped.action.loop, false);
  assert.equal(setLoop(looped.action, false).changed, false, 'no-change loop toggle reports changed=false');
  assert.equal(setLoop(looped.action, true).action.loop, true);
});

test('M1 action model: frameIndexAt mirrors the runtime animation-controller timing', () => {
  const { frameIndexAt, DEFAULT_FRAME_DURATION_MS } = m1Lib('action-model.js');
  assert.equal(DEFAULT_FRAME_DURATION_MS, 1000, 'the frozen 1000ms/frame default is the model fallback');
  const frames = [{ durationMs: 1200 }, { durationMs: null }, { durationMs: null }];
  // duration precedence: frame.durationMs > the 1000ms default
  assert.deepEqual(frameIndexAt(frames, 0, true), { frameIndex: 0, frameElapsedMs: 0 });
  assert.equal(frameIndexAt(frames, 1199, true).frameIndex, 0);
  assert.equal(frameIndexAt(frames, 1200, true).frameIndex, 1, 'the boundary belongs to the NEXT frame');
  assert.equal(frameIndexAt(frames, 3200, true).frameIndex, 0, 'loops wrap to the first frame');
  assert.equal(frameIndexAt(frames, 4400, true).frameIndex, 1);
  assert.deepEqual(frameIndexAt(frames, 999999, false), { frameIndex: 2, frameElapsedMs: 1000 }, 'non-loop clamps to the last frame');
});

test('M1 action model: validation flags geometry drift, unsafe files and bad durations (fail-closed rows)', () => {
  const { validateActionForPublish } = m1Lib('action-model.js');
  const { measureFrameFile } = m1Lib('character-geometry.js');
  // the lib contract: resolveFramePath(file) -> abs path, measureFrame(abs) -> metrics
  const measure = (absPath) => measureFrameFile(absPath);

  const green = validateActionForPublish(m1ReadAction('walk-left'), { resolveFramePath: m1ResolveActionFrame, measureFrame: measure });
  assert.equal(green.ok, true, JSON.stringify(green.checks.filter((c) => !c.ok)));
  assert.equal(green.rows.length, m1ReadAction('walk-left').frames.length);
  for (const row of green.rows) {
    assert.equal(row.red, false, `${row.file} must be green: ${JSON.stringify(row)}`);
    assert.ok(Math.abs(row.dFoot) <= 1, `shoe line within ±1px of geometry.footLine (${row.dFoot})`);
    assert.ok(Math.abs(row.dHeight) <= 2, `visible height within ±2px of the action median (${row.dHeight})`);
  }

  // shoe-line drift: declared footLine 300 vs measured 295 -> red row
  const drifted = validateActionForPublish(
    { ...m1ReadAction('walk-left'), geometry: { ...m1ReadAction('walk-left').geometry, footLine: 300 } },
    { resolveFramePath: m1ResolveActionFrame, measureFrame: measure }
  );
  assert.equal(drifted.ok, false);
  assert.ok(drifted.rows.every((row) => row.red), 'every frame drifts ±4px from the declared foot line');

  // a frame file that resolves nowhere
  const missing = validateActionForPublish(
    { ...m1ReadAction('walk-left'), frames: [...m1ReadAction('walk-left').frames, { file: 'assets/animations/walk/left/ghost.png', durationMs: null }] },
    { resolveFramePath: m1ResolveActionFrame, measureFrame: measure }
  );
  assert.equal(missing.ok, false);
  assert.ok(missing.checks.some((check) => check.check === 'frames.resolve' && !check.ok));
  assert.equal(missing.rows[missing.rows.length - 1].red, true, 'the unresolvable frame is red');

  // duration out of the editor band
  const timed = validateActionForPublish(
    { ...m1ReadAction('walk-left'), frames: m1ReadAction('walk-left').frames.map((frame, index) => (index === 1 ? { ...frame, durationMs: 10 } : frame)) },
    { resolveFramePath: m1ResolveActionFrame, measureFrame: measure }
  );
  assert.equal(timed.ok, false);
  assert.ok(timed.checks.some((check) => check.check === 'frames.durations' && !check.ok));
});

// --- deterministic import normalizer -----------------------------------------

// deterministic RGBA sprite: opaque body block between bodyTop..footY around
// footX (alpha 255), optional semi-opaque wash row, transparent elsewhere.
function m1MakeSource({ width = 512, height = 512, bodyTop = 201, footY = 500, footX = 300, halfWidth = 80, alpha = 255, washRow = null, washAlpha = 70 } = {}) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (washRow !== null && y === washRow) {
        rgba[o + 3] = washAlpha;
      } else if (y >= bodyTop && y <= footY && Math.abs(x - footX) <= halfWidth) {
        rgba[o] = 40; rgba[o + 1] = 90; rgba[o + 2] = 200; rgba[o + 3] = alpha;
      }
    }
  }
  const { encodePng } = m1Lib('png-geometry.js');
  return encodePng(rgba, width, height);
}

test('M1 normalizer: an imported frame is uniformly scaled, foot-line aligned and height-matched', () => {
  const { normalizeImportFrame } = m1Lib('normalizer.js');
  const { measureFrameFile, median } = m1Lib('character-geometry.js');
  const action = m1ReadAction('walk-left');
  const targetHeight = median(action.frames.map((frame) => measureFrameFile(m1ResolveActionFrame(frame.file)).visibleHeight));
  // 512x512 source, visible height 300 (rows 201..500), foot at row 500
  const source = m1MakeSource({ width: 512, height: 512, bodyTop: 201, footY: 500, footX: 300 });
  const outcome = normalizeImportFrame({
    sourceBytes: source,
    targetHeight,
    footLine: action.geometry.footLine,
    packCanvas: 352,
    packAnchor: { x: 178, y: 296 },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.violations || outcome.code));
  const decoded = require('../src/workbench/lib/png-geometry.js').decodePng(outcome.png);
  assert.equal(decoded.width, 352, 'output canvas is 352x352');
  assert.equal(decoded.height, 352);
  assert.equal(decoded.colorType, 6, 'RGBA PNG (pack contract)');
  // measure the OUTPUT bytes through the same kernel used everywhere
  const tmpPng = path.join(mkdtempSync(path.join(tmpdir(), 'm1-norm-')), 'out.png');
  fs.writeFileSync(tmpPng, outcome.png);
  const m = require('../src/workbench/lib/character-geometry.js').measureFrameFile(tmpPng);
  assert.equal(m.ok, true);
  assert.ok(Math.abs(m.footLine - action.geometry.footLine) <= 1, `shoe line ${m.footLine} aligned to ${action.geometry.footLine} ±1px`);
  assert.ok(Math.abs(m.visibleHeight - targetHeight) <= 2, `visible height ${m.visibleHeight} within ±2px of the target ${targetHeight}`);
  assert.ok(m.visibleWidth <= 352);
  // uniform scale: scaledWidth / scaledHeight === sourceWidth / sourceHeight (±1px rounding)
  const expectedScale = targetHeight / 300;
  assert.ok(Math.abs(outcome.entry.sourceScale - expectedScale) < 0.01, `sourceScale recorded (${outcome.entry.sourceScale})`);
  // the anchors-style entry carries the pack anchor and pipeline detection
  assert.deepEqual(outcome.entry.outputAnchor, { x: 178, y: 296 });
  assert.ok(outcome.entry.detection && outcome.entry.detection.contactRule, 'detection provenance recorded');
});

test('M1 normalizer: an unnormalizable import is rejected with violations and never inserted', () => {
  const { normalizeImportFrame } = m1Lib('normalizer.js');
  // a very wide body: after scaling to the target height the width cannot fit 352
  const wide = m1MakeSource({ width: 800, height: 400, bodyTop: 100, footY: 399, footX: 400, halfWidth: 380 });
  const rejected = normalizeImportFrame({
    sourceBytes: wide,
    targetHeight: 256,
    footLine: 296,
    packCanvas: 352,
    packAnchor: { x: 178, y: 296 },
  });
  assert.equal(rejected.ok, false, 'the scaled frame does not fit the output canvas');
  assert.ok((rejected.violations || []).length > 0 || rejected.code, 'rejections carry violations');
  // an empty (fully transparent) source has no geometry at all
  const empty = m1MakeSource({ width: 64, height: 64, bodyTop: 90, footY: 40 });
  const noBody = normalizeImportFrame({
    sourceBytes: empty,
    targetHeight: 256,
    footLine: 296,
    packCanvas: 352,
    packAnchor: { x: 178, y: 296 },
  });
  assert.equal(noBody.ok, false, 'a source without visible pixels is rejected');
});

// --- canonical pack serializer ------------------------------------------------

test('M1 pack serializer: canonical dumps reproduce both pack files byte-identically and preserve the anchors frames order', () => {
  const { canonicalPackJson } = m1Lib('pack-json.js');
  const animationsText = fs.readFileSync(path.join(M1_PACK_ROOT, 'animation', 'animations.json'), 'utf8');
  const anchorsText = fs.readFileSync(path.join(M1_PACK_ROOT, 'animation', 'anchors.json'), 'utf8');
  assert.equal(`${canonicalPackJson(JSON.parse(animationsText))}\n`, animationsText, 'animations.json is canonical (sorted keys)');
  assert.equal(`${canonicalPackJson(JSON.parse(anchorsText))}\n`, anchorsText, 'anchors.json is canonical EXCEPT the frames map order');
  // the frames map keeps INSERTION order (metadata order), unlike every other map
  const anchors = JSON.parse(anchorsText);
  const keys = Object.keys(anchors.frames);
  const animations = JSON.parse(animationsText);
  const declared = animations.animations['walk-left'].frames.map((frame) => frame.file);
  // 活跃帧的唯一键必须按元数据（播放）序插入 anchors map（E5a-R1 的规范序）
  const activeInMap = keys.filter((key) => declared.includes(key));
  assert.deepEqual(activeInMap, [...new Set(declared)], 'anchors active keys follow the unique metadata order');
  // 二代命名 b01..bNN 下字典序与元数据序重合，额外抽查首尾以防"整块被挪位"：
  assert.match(activeInMap[0], /walk-left-b01\.png$/, 'the active block starts at b01');
  assert.match(activeInMap[activeInMap.length - 1], /walk-left-b15\.png$/, 'the active block ends at b15');
});

// --- publish kernel (D5) ------------------------------------------------------

function m1LineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  // classic LCS table is fine at ~400 lines
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const changed = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { changed.push({ kind: 'removed', line: i + 1, text: a[i] }); i += 1; }
    else { changed.push({ kind: 'added', line: j + 1, text: b[j] }); j += 1; }
  }
  while (i < m) { changed.push({ kind: 'removed', line: i + 1, text: a[i] }); i += 1; }
  while (j < n) { changed.push({ kind: 'added', line: j + 1, text: b[j] }); j += 1; }
  return changed;
}

test('M1 publish: a sandbox publish rewrites ONLY the target action, repairs anchors order, backs up and records provenance', () => {
  const { publishAction } = m1Lib('action-publisher.js');
  const sandbox = m1Sandbox();
  const animationsPath = path.join(sandbox.charactersRoot, 'deepseek-default', 'animation', 'animations.json');
  const anchorsPath = path.join(sandbox.charactersRoot, 'deepseek-default', 'animation', 'anchors.json');
  const beforeAnimations = fs.readFileSync(animationsPath, 'utf8');
  const beforeAnchors = fs.readFileSync(anchorsPath, 'utf8');

  // edit: passing (index 2) moves up one; frame 0 gets an explicit duration
  const { moveFrame, setFrameDuration } = m1Lib('action-model.js');
  const edited = setFrameDuration(moveFrame(m1ReadAction('walk-left'), 2, 1).action, 0, 1200).action;
  const { saveActionDoc } = m1Lib('action-model.js');
  saveActionDoc(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json'), edited);

  const outcome = publishAction({
    contentDir: sandbox.contentDir,
    charactersRoot: sandbox.charactersRoot,
    actionId: 'walk-left',
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.violations || outcome.error || ''));
  assert.equal(outcome.noop, false);

  // animations.json: only the walk-left entry changed; every other entry is
  // byte-identical (the diff touches only walk-left lines)
  const afterAnimations = fs.readFileSync(animationsPath, 'utf8');
  const animationsDoc = JSON.parse(afterAnimations);
  const beforeDoc = JSON.parse(beforeAnimations);
  assert.notDeepEqual(animationsDoc.animations['walk-left'].frames.map((f) => f.file), beforeDoc.animations['walk-left'].frames.map((f) => f.file), 'the target entry changed');
  assert.equal(animationsDoc.animations['walk-left'].frames[0].durationMs, 1200, 'the edited duration landed');
  for (const [id, entry] of Object.entries(beforeDoc.animations)) {
    if (id === 'walk-left') continue;
    assert.deepEqual(animationsDoc.animations[id], entry, `${id} untouched`);
    assert.ok(!m1LineDiff(beforeAnimations, afterAnimations).some((change) => change.text.includes(`"${id}"`)), `${id} has no diff lines`);
  }
  assert.equal(animationsDoc.defaultFrameDurationMs, 1000, 'the pack-wide 1000ms default is untouched');

  // anchors.json: the edited direction's keys follow the NEW metadata order;
  // every other key keeps its relative order
  const afterAnchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  const declared = animationsDoc.animations['walk-left'].frames.map((frame) => frame.file);
  // 2026-09-17：序列可含刻意的重复帧（walk-left-03 出现两次），anchors map
  // 的键天然唯一——不变式按“活跃帧的唯一键元数据序”比较（发布内核同语义）
  const declaredUnique = [...new Set(declared)];
  const anchorKeys = Object.keys(afterAnchors.frames).filter((file) => declaredUnique.includes(file));
  assert.deepEqual(anchorKeys, declaredUnique, 'anchors keys follow the unique metadata order (E5a-R1)');
  const beforeAnchorKeys = Object.keys(JSON.parse(beforeAnchors).frames);
  assert.deepEqual(
    Object.keys(afterAnchors.frames).filter((file) => !file.includes('/walk/left/')),
    beforeAnchorKeys.filter((file) => !file.includes('/walk/left/')),
    'other anchors keys keep their relative order'
  );

  // backup: the PRE-publish bytes of both rewritten pack files
  assert.ok(outcome.summary.backupDir, 'provenance carries the backup dir');
  const backupAnimations = fs.readFileSync(path.join(outcome.summary.backupDir, 'animations.json'));
  const backupAnchors = fs.readFileSync(path.join(outcome.summary.backupDir, 'anchors.json'));
  assert.ok(backupAnimations.equals(Buffer.from(beforeAnimations)), 'animations.json backup = pre-publish bytes');
  assert.ok(backupAnchors.equals(Buffer.from(beforeAnchors)), 'anchors.json backup = pre-publish bytes');

  // provenance entry under content/characters/whale-girl/provenance/
  const provenanceDir = path.join(sandbox.contentDir, 'characters', 'whale-girl', 'provenance');
  const provenanceFiles = fs.readdirSync(provenanceDir).filter((name) => name.endsWith('.json'));
  assert.equal(provenanceFiles.length, 1, 'exactly one provenance entry recorded');
  const provenance = JSON.parse(fs.readFileSync(path.join(provenanceDir, provenanceFiles[0]), 'utf8'));
  assert.equal(provenance.actionId, 'walk-left');
  assert.ok(provenance.publishedAt, 'the entry carries the publish time');
  assert.equal(provenance.backupDir, outcome.summary.backupDir, 'the entry carries the backup path');

  // character.json: the edited action entry rebuilt, everything else equal
  const character = JSON.parse(fs.readFileSync(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'character.json'), 'utf8'));
  const charAction = character.actions.find((entry) => entry.id === 'walk-left');
  assert.deepEqual(charAction.frames.map((frame) => frame.file), declared, 'character.json walk-left follows the new order');
  for (const frame of charAction.frames) {
    const m = require('../src/workbench/lib/character-geometry.js').measureFrameFile(path.join(sandbox.charactersRoot, 'deepseek-default', frame.file));
    assert.equal(frame.geometry.footLine, m.footLine, 'declared footLine matches the published PNG');
    assert.equal(frame.geometry.visibleHeight, m.visibleHeight, 'declared visibleHeight matches the published PNG');
  }
  const beforeCharacter = JSON.parse(fs.readFileSync(path.join(M1_CHARACTER_DIR, 'character.json'), 'utf8'));
  for (const entry of beforeCharacter.actions) {
    if (entry.id === 'walk-left') continue;
    assert.deepEqual(character.actions.find((candidate) => candidate.id === entry.id), entry, `character action ${entry.id} untouched`);
  }

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

test('M1 publish: no-change publish records nothing (no backup, no provenance, no write)', () => {
  const { publishAction } = m1Lib('action-publisher.js');
  const sandbox = m1Sandbox();
  const animationsPath = path.join(sandbox.charactersRoot, 'deepseek-default', 'animation', 'animations.json');
  const beforeBytes = fs.readFileSync(animationsPath);

  const first = publishAction({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(first.ok, true);
  assert.equal(first.noop, true, 'an unchanged action publishes as a no-op');
  assert.ok(beforeBytes.equals(fs.readFileSync(animationsPath)), 'animations.json bytes untouched');
  const backupsRoot = path.join(sandbox.contentDir, 'build', 'backups');
  assert.equal(existsSync(backupsRoot), false, 'no backup recorded');
  const provenanceDir = path.join(sandbox.contentDir, 'characters', 'whale-girl', 'provenance');
  assert.equal(existsSync(provenanceDir), false, 'no provenance recorded');

  // a SECOND publish after one real change records exactly one provenance entry
  const { moveFrame, saveActionDoc } = m1Lib('action-model.js');
  saveActionDoc(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json'), moveFrame(m1ReadAction('walk-left'), 2, 1).action);
  const real = publishAction({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(real.ok, true);
  assert.equal(real.noop, false, 'the reorder is a real change');
  const repeat = publishAction({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(repeat.ok, true);
  assert.equal(repeat.noop, true, 'the repeat publish is a no-op again');
  const provenanceFiles = fs.readdirSync(provenanceDir).filter((name) => name.endsWith('.json'));
  assert.equal(provenanceFiles.length, 1, 'exactly one provenance entry (the real change)');
  const backupDirs = fs.readdirSync(backupsRoot);
  assert.equal(backupDirs.length, 1, 'exactly one backup (the real change)');

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

test('M1 publish: a failing action publishes NOTHING (fail-closed) and anchors-key-order repair alone still publishes', () => {
  const { publishAction } = m1Lib('action-publisher.js');
  const { saveActionDoc } = m1Lib('action-model.js');
  const sandbox = m1Sandbox();
  const animationsPath = path.join(sandbox.charactersRoot, 'deepseek-default', 'animation', 'animations.json');
  const anchorsPath = path.join(sandbox.charactersRoot, 'deepseek-default', 'animation', 'anchors.json');
  const beforeAnimations = fs.readFileSync(animationsPath);
  const beforeAnchors = fs.readFileSync(anchorsPath);

  // (a) invalid action: a frame file that resolves nowhere -> publish refuses
  const broken = { ...m1ReadAction('walk-left'), frames: [...m1ReadAction('walk-left').frames, { file: 'assets/animations/walk/left/ghost.png', durationMs: null }] };
  saveActionDoc(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json'), broken);
  const refused = publishAction({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(refused.ok, false, 'the publish is refused');
  assert.ok(refused.violations.length > 0, 'the violations are listed for the UI');
  assert.ok(beforeAnimations.equals(fs.readFileSync(animationsPath)), 'animations.json untouched');
  assert.ok(beforeAnchors.equals(fs.readFileSync(anchorsPath)), 'anchors.json untouched');
  assert.equal(existsSync(path.join(sandbox.contentDir, 'build', 'backups')), false, 'no backup on a refused publish');
  assert.equal(existsSync(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'provenance')), false, 'no provenance on a refused publish');

  // (b) a tampered anchors key order (block out of metadata order) is repaired by publish
  saveActionDoc(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json'), m1ReadAction('walk-left'));
  const anchors = JSON.parse(beforeAnchors.toString('utf8'));
  const leftKeys = Object.keys(anchors.frames).filter((file) => file.includes('/walk/left/'));
  // 把 left 块整体错序重插（末帧挪到最前）：任何与元数据（播放）序不一致的
  // 插入顺序都必须被发布内核修回——旧测试用"字典序把 passing 排到最后"制造
  // 同样的隐患；二代命名 b01..bNN 下字典序与元数据序重合，所以改用显式错序。
  const scrambled = [leftKeys[leftKeys.length - 1], ...leftKeys.slice(0, -1)];
  const reordered = {};
  for (const [key, value] of Object.entries(anchors.frames)) {
    if (key.includes('/walk/left/')) continue;
    reordered[key] = value;
    if (key.includes('/walk/right/walk-right-b04.png')) {
      for (const key2 of scrambled) reordered[key2] = anchors.frames[key2];
    }
  }
  anchors.frames = reordered;
  fs.writeFileSync(anchorsPath, `${JSON.stringify(anchors, null, 2)}\n`);
  const repaired = publishAction({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(repaired.ok, true, JSON.stringify(repaired.violations || ''));
  assert.equal(repaired.noop, false, 'the key-order repair is a real publish');
  const afterAnchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  const animationsDoc = JSON.parse(fs.readFileSync(animationsPath, 'utf8'));
  {
    const declared = animationsDoc.animations['walk-left'].frames.map((frame) => frame.file);
    const declaredUnique = [...new Set(declared)];
    assert.deepEqual(
      Object.keys(afterAnchors.frames).filter((file) => declaredUnique.includes(file)),
      declaredUnique,
      'the anchors active keys follow the unique metadata order again'
    );
  }
  assert.ok(beforeAnimations.equals(fs.readFileSync(animationsPath)), 'animations.json bytes untouched by the repair');

  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// --- staged preview pack ------------------------------------------------------

test('M1 staged preview pack: the staged pack carries the edited order and loads through the real pack loader', () => {
  const { stagePreviewPack } = m1Lib('action-publisher.js');
  const { moveFrame, saveActionDoc } = m1Lib('action-model.js');
  const sandbox = m1Sandbox();
  const edited = moveFrame(m1ReadAction('walk-left'), 2, 1).action;
  saveActionDoc(path.join(sandbox.contentDir, 'characters', 'whale-girl', 'actions', 'walk-left.json'), edited);

  const staged = stagePreviewPack({ contentDir: sandbox.contentDir, charactersRoot: sandbox.charactersRoot, actionId: 'walk-left' });
  assert.equal(staged.ok, true, JSON.stringify(staged.violations || ''));
  assert.deepEqual(staged.frames, edited.frames.map((frame) => frame.file), 'the staged play order is the EDITED order');
  const stagedAnimations = JSON.parse(fs.readFileSync(path.join(sandbox.contentDir, 'build', 'preview-pack', 'animations.json'), 'utf8'));
  const stagedAnchors = JSON.parse(fs.readFileSync(path.join(sandbox.contentDir, 'build', 'preview-pack', 'anchors.json'), 'utf8'));
  assert.deepEqual(stagedAnimations.animations['walk-left'].frames.map((frame) => frame.file), staged.frames);
  assert.deepEqual(
    Object.keys(stagedAnchors.frames).filter((file) => [...new Set(staged.frames)].includes(file)),
    [...new Set(staged.frames)],
    'staged anchors keys follow the edited unique order'
  );
  // the REAL pack loader accepts the staged pack (product contract)
  const pack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(sandbox.charactersRoot, 'deepseek-default', 'manifest.json'), 'utf8')),
    anchors: stagedAnchors,
    animations: stagedAnimations,
  });
  assert.equal(pack.ok, true, JSON.stringify((pack.errors || []).slice(0, 3)));
  assert.deepEqual(pack.pack.animation('walk-left').frames.map((frame) => frame.file), staged.frames);
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// M4.1d — the bundled dialogue corpus must be a faithful copy of the content
// sources: content/** stays the authoring area (product entries never require
// it — see office-ui boundary lock), resources/dialogue/** is what ships.
// ---------------------------------------------------------------------------

test('M4.1d: the packaging config ships every resource root the office reads in a build', () => {
  const config = require('../electron-builder.js');
  const extra = config.extraResources || [];
  const shipped = new Set(extra.map((entry) => entry.from));
  for (const root of ['resources/office', 'resources/characters', 'resources/dialogue']) {
    assert.equal(shipped.has(root), true,
      `${root} must ship via extraResources — main.js reads it from process.resourcesPath when packaged (${[...shipped].join(', ')})`);
  }
});

test('M4.1d: resources/dialogue is a faithful copy of the content corpus', () => {
  const baseSource = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'shared', 'dialogue', 'base.json'), 'utf8'));
  const baseBundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'dialogue', 'base.json'), 'utf8'));
  assert.deepEqual(baseBundled, baseSource, 'base.json copy matches the content source');
  // The overlay ships under the ACTIVE PACK id (builtin deepseek-default plays
  // the whale-girl character) — see resources/dialogue/README.md.
  const overlaySource = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'characters', 'whale-girl', 'dialogue', 'character.json'), 'utf8'));
  const overlayBundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'dialogue', 'characters', 'deepseek-default.json'), 'utf8'));
  assert.deepEqual(overlayBundled, overlaySource, 'the whale-girl overlay copy matches the content source');
});
