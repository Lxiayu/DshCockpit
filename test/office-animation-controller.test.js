'use strict';

// Task 3 / SPEC-03 — animation selection with an independent frame clock.
// RED: src/office/runtime/animation-controller.js does not exist yet.
//
// Contracts under test:
// - animation time advances frames independently from movement
// - exact frame-boundary behavior is deterministic
// - duration precedence: user override > per-frame durationMs >
//   animation frameDurationMs > pack defaultFrameDurationMs > 1000ms
// - loop and non-loop handling with metadata frame counts (never assumed 4)
// - deterministic direction mapping and missing-state fallback reasons
// - repeated calls with identical inputs return identical results

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const assetPack = require('../src/office/runtime/asset-pack.js');
const animationController = require('../src/office/runtime/animation-controller.js');

const FIXTURE_ROOT = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
const FIXTURE = {
  manifest: require(path.join(FIXTURE_ROOT, 'manifest.json')),
  anchors: require(path.join(FIXTURE_ROOT, 'animation', 'anchors.json')),
  animations: require(path.join(FIXTURE_ROOT, 'animation', 'animations.json')),
};

const REQUIRED_BASE = {
  idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'a.png', durationMs: null }] },
  'walk-left': { state: 'walk', direction: 'left', loop: true, frames: [{ file: 'wl.png', durationMs: null }] },
  'walk-right': { state: 'walk', direction: 'right', loop: true, frames: [{ file: 'wr.png', durationMs: null }] },
  'walk-up': { state: 'walk', direction: 'up', loop: true, frames: [{ file: 'wu.png', durationMs: null }] },
  'walk-down': { state: 'walk', direction: 'down', loop: true, frames: [{ file: 'wd.png', durationMs: null }] },
};

function buildPack(animations, defaults) {
  const result = assetPack.createAssetPack({
    manifest: {
      schemaVersion: 1,
      id: 'test-pack',
      version: '1.0.0',
      author: 'test',
      license: 'test-license',
      runtimeCompatibility: { schema: 1 },
      geometry: 'animation/anchors.json',
      animations: 'animation/animations.json',
      fallback: { allowStaticPose: true, allowProgrammaticEmphasis: true },
    },
    anchors: {
      schemaVersion: 1,
      sourceCanvas: { width: 64, height: 64 },
      outputCanvas: { width: 64, height: 64 },
      outputScale: 1,
      anchor: { x: 32, y: 60 },
      visibleBounds: { x: 22, y: 12, width: 21, height: 49 },
      frames: {},
    },
    animations: {
      schemaVersion: 1,
      defaultFrameDurationMs: 1000,
      ...(defaults || {}),
      animations: { ...REQUIRED_BASE, ...animations },
    },
  });
  assert.ok(result.ok, `test pack must build: ${JSON.stringify(result.errors || [])}`);
  return result.pack;
}

const fixturePack = () => {
  const result = assetPack.createAssetPack(FIXTURE);
  assert.ok(result.ok);
  return result.pack;
};

function resolveWalk(pack, elapsedMs, override) {
  return animationController.resolveAnimation({
    state: 'walk',
    direction: 'left',
    elapsedMs,
    pack,
    userFrameDurationOverrideMs: override === undefined ? null : override,
  });
}

test('frames advance on the independent animation clock', () => {
  const pack = fixturePack();
  assert.deepEqual(pick(resolveWalk(pack, 0)), { frameIndex: 0, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, 999)), { frameIndex: 0, frameElapsedMs: 999 });
  assert.deepEqual(pick(resolveWalk(pack, 1000)), { frameIndex: 1, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, 2500)), { frameIndex: 2, frameElapsedMs: 500 });
  assert.deepEqual(pick(resolveWalk(pack, 3999)), { frameIndex: 3, frameElapsedMs: 999 });
  assert.deepEqual(pick(resolveWalk(pack, 4000)), { frameIndex: 0, frameElapsedMs: 0 });
});

function pick(result) {
  return { frameIndex: result.frameIndex, frameElapsedMs: result.frameElapsedMs };
}

test('frame changes never move the character and expose no movement fields', () => {
  const pack = fixturePack();
  const result = resolveWalk(pack, 1500);
  assert.equal('position' in result, false);
  assert.equal('x' in result, false);
  assert.equal('y' in result, false);
  assert.equal('progress' in result, false);
  assert.equal(result.resource, 'walk-left');
});

test('exact frame boundaries belong to the next frame deterministically', () => {
  const pack = buildPack({
    idle: { state: 'idle', direction: 'none', loop: true, frames: [{ file: 'a.png', durationMs: null }] },
    'walk-left': {
      state: 'walk', direction: 'left', loop: true,
      frames: [
        { file: 'l1.png', durationMs: 100 },
        { file: 'l2.png', durationMs: 200 },
      ],
    },
  });
  assert.deepEqual(pick(resolveWalk(pack, 99)), { frameIndex: 0, frameElapsedMs: 99 });
  assert.deepEqual(pick(resolveWalk(pack, 100)), { frameIndex: 1, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, 299)), { frameIndex: 1, frameElapsedMs: 199 });
  assert.deepEqual(pick(resolveWalk(pack, 300)), { frameIndex: 0, frameElapsedMs: 0 });
});

test('user frame duration override wins over every pack duration', () => {
  const pack = buildPack({
    'walk-left': {
      state: 'walk', direction: 'left', loop: true,
      frames: [
        { file: 'l1.png', durationMs: 500 },
        { file: 'l2.png', durationMs: 500 },
      ],
    },
  });
  assert.deepEqual(pick(resolveWalk(pack, 49, 100)), { frameIndex: 0, frameElapsedMs: 49 });
  assert.deepEqual(pick(resolveWalk(pack, 50, 100)), { frameIndex: 0, frameElapsedMs: 50 });
  assert.deepEqual(pick(resolveWalk(pack, 100, 100)), { frameIndex: 1, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, 150, 100)), { frameIndex: 1, frameElapsedMs: 50 });
});

test('per-frame durationMs beats animation-level and pack defaults', () => {
  const pack = buildPack({
    'walk-left': {
      state: 'walk', direction: 'left', loop: true,
      frames: [{ file: 'l1.png', durationMs: 300 }, { file: 'l2.png', durationMs: 600 }],
    },
  });
  assert.deepEqual(pick(resolveWalk(pack, 299)), { frameIndex: 0, frameElapsedMs: 299 });
  assert.deepEqual(pick(resolveWalk(pack, 300)), { frameIndex: 1, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, 899)), { frameIndex: 1, frameElapsedMs: 599 });
  assert.deepEqual(pick(resolveWalk(pack, 900)), { frameIndex: 0, frameElapsedMs: 0 });
});

test('animation-level frameDurationMs beats the pack default', () => {
  const pack = buildPack(
    {
      'walk-left': {
        state: 'walk', direction: 'left', loop: true, frameDurationMs: 250,
        frames: [{ file: 'l1.png', durationMs: null }, { file: 'l2.png', durationMs: null }],
      },
    },
    { defaultFrameDurationMs: 1000 }
  );
  assert.deepEqual(pick(resolveWalk(pack, 249)), { frameIndex: 0, frameElapsedMs: 249 });
  assert.deepEqual(pick(resolveWalk(pack, 250)), { frameIndex: 1, frameElapsedMs: 0 });
});

test('pack defaultFrameDurationMs applies when frames carry no durations', () => {
  const pack = buildPack(
    {
      'walk-left': {
        state: 'walk', direction: 'left', loop: true,
        frames: [{ file: 'l1.png', durationMs: null }, { file: 'l2.png', durationMs: null }],
      },
    },
    { defaultFrameDurationMs: 700 }
  );
  assert.deepEqual(pick(resolveWalk(pack, 699)), { frameIndex: 0, frameElapsedMs: 699 });
  assert.deepEqual(pick(resolveWalk(pack, 700)), { frameIndex: 1, frameElapsedMs: 0 });
});

test('1000ms is the final duration fallback', () => {
  const pack = buildPack(
    {
      'walk-left': {
        state: 'walk', direction: 'left', loop: true,
        frames: [{ file: 'l1.png', durationMs: null }, { file: 'l2.png', durationMs: null }],
      },
    },
    { defaultFrameDurationMs: null }
  );
  assert.deepEqual(pick(resolveWalk(pack, 999)), { frameIndex: 0, frameElapsedMs: 999 });
  assert.deepEqual(pick(resolveWalk(pack, 1000)), { frameIndex: 1, frameElapsedMs: 0 });
});

test('non-looping animations clamp to the last frame', () => {
  const pack = buildPack({
    finished: {
      state: 'finished', direction: 'none', loop: false,
      frames: [{ file: 'f1.png', durationMs: 100 }, { file: 'f2.png', durationMs: 100 }, { file: 'f3.png', durationMs: 100 }],
    },
  });
  const result = animationController.resolveAnimation({
    state: 'finished', direction: null, elapsedMs: 250, pack, userFrameDurationOverrideMs: null,
  });
  assert.equal(result.frameIndex, 2);
  assert.equal(result.frameElapsedMs, 50);
  assert.equal(result.loop, false);

  const stuck = animationController.resolveAnimation({
    state: 'finished', direction: null, elapsedMs: 5000, pack, userFrameDurationOverrideMs: null,
  });
  assert.equal(stuck.frameIndex, 2);
  assert.equal(stuck.frameElapsedMs, 100);
});

test('direction mapping is deterministic', () => {
  const pack = fixturePack();
  const left = resolveWalk(pack, 0);
  const up = animationController.resolveAnimation({
    state: 'walk', direction: 'up', elapsedMs: 0, pack, userFrameDurationOverrideMs: null,
  });
  assert.equal(left.resource, 'walk-left');
  assert.equal(up.resource, 'walk-up');
  assert.deepEqual(resolveWalk(pack, 0), resolveWalk(pack, 0));
});

test('walk without a direction falls back to the directional side pose', () => {
  const pack = fixturePack();
  const result = animationController.resolveAnimation({
    state: 'walk', direction: null, elapsedMs: 0, pack, userFrameDurationOverrideMs: null,
  });
  assert.equal(result.resource, 'side-back');
  assert.equal(result.fallbackReason, 'DIRECTIONAL_POSE_FALLBACK');
});

test('missing optional states expose fallback reason and capability diagnostics', () => {
  const pack = fixturePack();
  const result = animationController.resolveAnimation({
    state: 'sleeping', direction: null, elapsedMs: 0, pack, userFrameDurationOverrideMs: null,
  });
  assert.equal(result.resource, 'idle');
  assert.equal(result.fallbackReason, 'STATIC_POSE_FALLBACK');
  assert.deepEqual(result.capabilityMissing, ['sleeping']);
});

test('repeated calls with identical inputs return equal results', () => {
  const pack = fixturePack();
  const a = resolveWalk(pack, 1234);
  const b = resolveWalk(pack, 1234);
  assert.deepEqual(a, b);
});

test('negative or invalid elapsed time clamps to zero', () => {
  const pack = fixturePack();
  assert.deepEqual(pick(resolveWalk(pack, -50)), { frameIndex: 0, frameElapsedMs: 0 });
  assert.deepEqual(pick(resolveWalk(pack, Number.NaN)), { frameIndex: 0, frameElapsedMs: 0 });
});

test('invalid packs yield stable diagnostics instead of throwing', () => {
  const controller = animationController.createAnimationController();
  assert.equal(controller.resolve({ state: 'idle', direction: null, elapsedMs: 0, pack: null }).code, 'PACK_INVALID');
  assert.equal(
    controller.resolve({ state: 'idle', direction: null, elapsedMs: 0, pack: { ok: false, code: 'PACK_GEOMETRY_INVALID' } }).code,
    'PACK_GEOMETRY_INVALID'
  );
});

test('metadata frame counts are honored (never assumed four)', () => {
  const pack = buildPack({
    'walk-left': {
      state: 'walk', direction: 'left', loop: true,
      frames: [{ file: 'l1.png', durationMs: 50 }, { file: 'l2.png', durationMs: 50 }, { file: 'l3.png', durationMs: 50 }],
    },
  });
  const result = resolveWalk(pack, 125);
  assert.equal(result.frameIndex, 2);
  assert.equal(result.frameCount, 3);
});
