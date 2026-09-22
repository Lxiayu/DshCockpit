'use strict';

// Task 4 / SPEC-06 — Animation Playground fixture runner tests.
// RED: src/office/playground-page.js, the fixtures and the main.js dev
// command do not exist yet.
//
// Automatic acceptance thresholds under test (SPEC-06):
// - click projects to the nearest allowed waypoint (tag + reachability)
// - fake clock animation frame boundaries within ±16ms
// - animation ticker and movement ticker are independent
// - one second of reference-viewport movement within ±5%
// - four-direction mapping and deterministic turning
// - foot anchor drift <= 1 CSS px across frames and directions
// - Walk -> Work, Work -> Thinking, Work/Thinking -> Result,
//   Result -> Stand -> Leave
// - resize logical position error <= 0.005, arrival error <= 0.01
// - reduced-motion arrives instantly yet still advances logical state
// - missing animations fall back with no blank sprite
// - non-square viewport keeps position, speed and anchor honest
// - replay determinism (same seed + events -> identical diagnostics)
// - exactly one Pixi Application / one character Sprite (stub PIXI)
// - main.js keeps officePlaygroundEnabled default-false and dev-gated

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const playground = require('../src/office/playground-page.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const GRAPH = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'waypoints.json'), 'utf8'));
const EVENTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'events.json'), 'utf8'));

const VIEWPORT = { width: 1280, height: 840 };

function makeHarness(overrides) {
  return playground.createPlaygroundHarness({
    pack: PACK,
    graph: GRAPH,
    scene: { ...VIEWPORT },
    seed: 'playground-test-seed',
    startNodeId: 'roam-1',
    ...overrides,
  });
}

function makeGraph(nodes, edges) {
  return { schemaVersion: 1, nodes, edges };
}

// ---------------------------------------------------------------------------
// fake clock
// ---------------------------------------------------------------------------

test('fake clock supports pause, step, reset and never reads wall time', () => {
  const clock = playground.createFakeClock({ initialMs: 100 });
  assert.equal(clock.nowMs(), 100);
  clock.advanceMs(50);
  assert.equal(clock.nowMs(), 150);
  clock.pause();
  clock.advanceMs(999);
  assert.equal(clock.nowMs(), 150, 'paused clock does not advance');
  clock.stepMs(16);
  assert.equal(clock.nowMs(), 166, 'step advances even while paused');
  clock.resume();
  clock.advanceMs(34);
  assert.equal(clock.nowMs(), 200);
  clock.reset();
  assert.equal(clock.nowMs(), 100);
});

// ---------------------------------------------------------------------------
// click projection and direct target
// ---------------------------------------------------------------------------

test('click projects to the nearest allowed waypoint', () => {
  const harness = makeHarness();
  // 1280x840: roam-2 sits at (0.75, 0.30) -> (960, 252). A click there snaps
  // to roam-2 and routes from roam-1.
  const hit = harness.clickToWaypoint(960, 252, 'roaming');
  assert.ok(hit, 'click must project to a waypoint');
  assert.equal(hit.nodeId, 'roam-2');
  assert.ok(Array.isArray(hit.route) && hit.route[0] === 'roam-1' && hit.route.at(-1) === 'roam-2');
  assert.deepEqual(harness.target().point, { x: 0.75, y: 0.3 });
});

test('click skips nearer waypoints whose tags are not allowed', () => {
  const harness = makeHarness();
  // desk-1 at (0.62, 0.52) is nearer to this click than roam-2 (0.75, 0.30),
  // but only roaming-tagged waypoints are allowed here.
  const hit = harness.clickToWaypoint(0.66 * 1280, 0.45 * 840, 'roaming');
  assert.ok(hit);
  assert.notEqual(hit.nodeId, 'desk-1');
  assert.ok(GRAPH.nodes.find((n) => n.id === hit.nodeId).tags.includes('roaming'));
});

test('click falls through to the next reachable allowed waypoint', () => {
  // Block the first hop of the direct route so the nearest candidate is
  // unreachable; the projection must pick the next nearest reachable one.
  const graph = makeGraph(
    [
      { id: 's', position: { x: 0.1, y: 0.5 }, tags: ['roaming'], capacity: 2, safeRadius: 0.01 },
      { id: 't', position: { x: 0.9, y: 0.5 }, tags: ['roaming'], capacity: 1, safeRadius: 0.01 },
      { id: 'b', position: { x: 0.8, y: 0.8 }, tags: ['roaming'], capacity: 2, safeRadius: 0.01 },
    ],
    [
      { from: 's', to: 't', behaviors: ['roaming'], bidirectional: true },
      { from: 's', to: 'b', behaviors: ['roaming'], bidirectional: true },
      { from: 'b', to: 't', behaviors: ['roaming'], bidirectional: true },
    ]
  );
  const harness = makeHarness({ graph, startNodeId: 's' });
  const blocked = playground.movementTestAdapter
    ? null
    : null; // no adapter needed: harness receives reservations via click
  const hit = harness.clickToWaypoint(0.88 * 1280, 0.5 * 840, 'roaming', [
    {
      id: 'res-block-t',
      owner: 'employee-2',
      purpose: 'node:t',
      nodeId: 't',
      segments: [],
      safeRadius: 0.01,
      acquiredAt: 0,
      expiresAt: 60000,
      ttlMs: 60000,
      lastRenewedAt: 0,
      renewalCount: 0,
    },
  ]);
  assert.ok(hit, 'projection must fall through to a reachable waypoint');
  assert.equal(hit.nodeId, 'b', 'target t is capacity-full, b is next nearest reachable');
});

test('direct-target clicks are accepted only when the debug switch is on', () => {
  const harness = makeHarness();
  assert.equal(harness.clickToTarget(0.4 * 1280, 0.4 * 840), null, 'disabled by default');
  harness.setDirectTargetEnabled(true);
  const hit = harness.clickToTarget(0.4 * 1280, 0.4 * 840);
  assert.ok(hit);
  assert.deepEqual(hit.point, { x: 0.4, y: 0.4 });
  assert.equal(hit.route, null, 'direct targets move straight without a route');
});

// ---------------------------------------------------------------------------
// fake ticker frame boundaries and ticker independence
// ---------------------------------------------------------------------------

test('animation frame boundaries stay within ±16ms on the fake ticker', () => {
  const harness = makeHarness();
  harness.setFrameDurationMs(1000);
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  const changes = [];
  let lastFrame = harness.animation().frameIndex;
  for (let i = 0; i < 300; i += 1) {
    harness.tick(16);
    const frame = harness.animation().frameIndex;
    if (frame !== lastFrame) {
      changes.push({ atMs: harness.clock.nowMs(), from: lastFrame, to: frame });
      lastFrame = frame;
    }
    if (changes.length >= 4) break;
  }
  assert.ok(changes.length >= 4, 'frames must advance while walking');
  for (const change of changes) {
    const boundary = Math.round(change.atMs / 1000) * 1000;
    assert.ok(
      Math.abs(change.atMs - boundary) <= 16,
      `frame change at ${change.atMs}ms must be within ±16ms of ${boundary}ms`
    );
  }
});

test('animation ticker and movement ticker are independent', () => {
  const harness = makeHarness();
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  const before = { position: harness.position(), frameIndex: harness.animation().frameIndex, elapsed: harness.animationElapsedMs() };

  harness.tickMovement(1000);
  assert.ok(harness.position().x > before.position.x, 'movement tick advances position');
  assert.equal(harness.animation().frameIndex, before.frameIndex, 'movement tick does not advance frames');
  assert.equal(harness.animationElapsedMs(), before.elapsed);

  harness.tickAnimation(1000);
  assert.deepEqual(harness.position(), harness.position(), 'sanity');
  assert.notEqual(
    harness.animationElapsedMs(),
    before.elapsed + 1000 === harness.animationElapsedMs() ? before.elapsed : -1,
    'animation tick advances the animation clock'
  );
  assert.ok(harness.animationElapsedMs() > before.elapsed, 'animation elapsed advanced');
  const movedPosition = harness.position();
  harness.tickAnimation(2000);
  assert.deepEqual(harness.position(), movedPosition, 'animation tick never moves the character');
});

test('movement speed is independent of animation frame duration', () => {
  const fast = makeHarness();
  const slow = makeHarness();
  fast.setFrameDurationMs(250);
  slow.setFrameDurationMs(4000);
  fast.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  slow.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  for (let i = 0; i < 50; i += 1) {
    fast.tick(100);
    slow.tick(100);
  }
  const dx = Math.abs(fast.position().x - slow.position().x);
  assert.ok(
    dx <= 0.005,
    `same movement time must cover the same distance regardless of frame duration (dx=${dx})`
  );
  assert.notEqual(fast.animation().frameIndex, slow.animation().frameIndex, 'frame clocks diverge by design');
});

test('one second of reference-viewport movement is within ±5%', () => {
  const harness = makeHarness();
  harness.setDirectTargetEnabled(true);
  harness.clickToTarget(0.6 * 1280, 0.35 * 840);
  const startX = harness.position().x;
  harness.tick(1000);
  const expected = (0.12 * 840) / 1280; // speed ratio * minDim / width
  const moved = harness.position().x - startX;
  assert.ok(
    Math.abs(moved - expected) <= expected * 0.05,
    `moved ${moved} but expected ${expected} (±5%)`
  );
});

// ---------------------------------------------------------------------------
// directions and anchor
// ---------------------------------------------------------------------------

test('four directions map to walk resources and turn deterministically', () => {
  const harness = makeHarness();
  harness.setDirectTargetEnabled(true);

  harness.clickToTarget(0.9 * 1280, 0.35 * 840); // right
  harness.tick(1000); // move well clear of the arrival tolerance
  assert.equal(harness.direction(), 'right');
  assert.equal(harness.animation().resource, 'walk-right');

  harness.clickToTarget(0.2 * 1280, 0.35 * 840); // left (turn around)
  harness.tick(16);
  assert.equal(harness.direction(), 'left');
  assert.equal(harness.animation().resource, 'walk-left');
  harness.tick(1000);

  harness.clickToTarget(0.2 * 1280, 0.8 * 840); // down
  harness.tick(16);
  assert.equal(harness.direction(), 'down');
  assert.equal(harness.animation().resource, 'walk-down');
  harness.tick(1000);

  harness.clickToTarget(0.2 * 1280, 0.1 * 840); // up
  harness.tick(16);
  assert.equal(harness.direction(), 'up');
  assert.equal(harness.animation().resource, 'walk-up');

  const turned = harness.position();
  harness.clickToTarget(0.8 * 1280, 0.8 * 840); // diagonal: dominant x on 1280x840
  harness.tick(16);
  assert.equal(harness.direction(), 'right');
  assert.ok(Math.abs(turned.x - harness.position().x) < 0.02, 'turning does not teleport');
});

test('foot anchor drift stays within 1 CSS px across frames and directions', () => {
  const harness = makeHarness();
  const layout = harness.spriteLayout();
  assert.equal(layout.visibleHeight, 92.4, 'visible height = clamp(64, 840*0.11, 180)');
  const offsets = [];
  for (const direction of ['left', 'right', 'up', 'down']) {
    const resolved = PACK.resolve({ state: 'walk', direction });
    assert.equal(resolved.code, 'RESOLVED');
    for (let frameIndex = 0; frameIndex < resolved.frameCount; frameIndex += 1) {
      const frame = harness.spriteLayoutFor(resolved.resource, frameIndex);
      offsets.push({ x: frame.anchor.x * frame.scale, y: frame.anchor.y * frame.scale });
    }
  }
  const maxX = Math.max(...offsets.map((o) => o.x)) - Math.min(...offsets.map((o) => o.x));
  const maxY = Math.max(...offsets.map((o) => o.y)) - Math.min(...offsets.map((o) => o.y));
  assert.ok(maxX <= 1, `anchor x drift ${maxX}px must be <= 1 CSS px`);
  assert.ok(maxY <= 1, `anchor y drift ${maxY}px must be <= 1 CSS px`);

  // View-level: the sprite keeps the foot point fixed while walk frames change.
  const stub = stubPixi();
  const textures = new Map();
  for (const id of ['walk-left', 'walk-right', 'walk-up', 'walk-down', 'idle', 'working']) {
    const anim = PACK.animation(id);
    for (const frame of anim.frames) textures.set(frame.file, stub.textureFor(frame.file));
  }
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming'); // walk so frames advance
  return playground
    .createPlaygroundView({ PIXI: stub.PIXI, harness, textures, packBaseUrl: 'pack' })
    .then((view) => {
      const offsets = [];
      const files = [];
      for (let i = 0; i < 4; i += 1) {
        view.refresh();
        const sprite = view.sprite;
        offsets.push({
          x: sprite.texture.__anchor.x * sprite.__scale,
          y: sprite.texture.__anchor.y * sprite.__scale,
        });
        files.push(sprite.texture.__file);
        harness.tick(1000); // advances movement + animation together
      }
      assert.equal(new Set(files).size, 4, 'all four walk frames are rendered');
      const footX = Math.max(...offsets.map((f) => f.x)) - Math.min(...offsets.map((f) => f.x));
      const footY = Math.max(...offsets.map((f) => f.y)) - Math.min(...offsets.map((f) => f.y));
      assert.ok(footX <= 1 && footY <= 1, `rendered foot drift (${footX}, ${footY}) must be <= 1 CSS px`);
      view.destroy();
    });
});

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

test('walk transitions to work after arrival', () => {
  const harness = makeHarness();
  harness.applyEvent({ type: 'dispatch', targetNodeId: 'desk-1' });
  assert.equal(harness.transition().kind, 'task-start');
  assert.equal(harness.transition().phase, 'stop');
  let guard = 0;
  while (harness.transition() && harness.transition().phase !== 'work' && guard < 2000) {
    harness.tick(100);
    guard += 1;
  }
  assert.ok(harness.transition(), 'transition stays in work while bound');
  assert.equal(harness.transition().phase, 'work');
  assert.equal(harness.reducerState().runtime, 'running');
  assert.equal(harness.reducerState().activity, 'working');
  assert.equal(harness.animation().resource, 'working');
  assert.ok(harness.position().x !== 0.2 || harness.position().y !== 0.35, 'character walked to the desk');
  assert.ok(
    Math.hypot(
      (harness.position().x - 0.62) * 1280,
      (harness.position().y - 0.52) * 840
    ) <= 0.01 * 840,
    'arrival error within 0.01 normalized (min-dimension metric)'
  );
});

test('work transitions to thinking and then to result', () => {
  const harness = makeHarness();
  harness.applyEvent({ type: 'dispatch', targetNodeId: 'desk-1' });
  let guard = 0;
  while (harness.transition() && harness.transition().phase !== 'work' && guard < 2000) {
    harness.tick(100);
    guard += 1;
  }
  harness.applyEvent({ type: 'runtime/fact', fact: 'running', reason: 'thinking' });
  assert.equal(harness.reducerState().activity, 'thinking');
  assert.equal(harness.animation().resource, 'side-back', 'thinking falls back to the directional pose');
  assert.equal(harness.animation().fallbackReason, 'DIRECTIONAL_POSE_FALLBACK');

  harness.applyEvent({ type: 'task-terminal', outcome: 'completed', result: { summary: 'fixture' } });
  assert.equal(harness.transition().kind, 'task-end');
  assert.equal(harness.transition().phase, 'result');
  assert.equal(harness.reducerState().runtime, 'completed');
  assert.equal(harness.reducerState().binding, 'releasing');
  assert.equal(harness.animation().resource, 'finished', 'completed falls back to finished on this pack');
});

test('result advances stand then leave and returns to local behavior', () => {
  const harness = makeHarness();
  harness.applyEvent({ type: 'dispatch', targetNodeId: 'desk-1' });
  let guard = 0;
  while (harness.transition() && harness.transition().phase !== 'work' && guard < 2000) {
    harness.tick(100);
    guard += 1;
  }
  harness.applyEvent({ type: 'task-terminal', outcome: 'failed', result: { summary: 'fixture' } });
  assert.equal(harness.animation().resource, 'error', 'failed falls back to error on this pack');

  harness.applyEvent({ type: 'phase-complete' });
  assert.equal(harness.transition().phase, 'stand');
  assert.equal(harness.animation().resource, 'idle');

  harness.applyEvent({ type: 'phase-complete' });
  assert.equal(harness.transition().phase, 'leave', 'stand advances into leave');

  harness.applyEvent({ type: 'phase-complete' });
  assert.equal(harness.transition(), null, 'leave completes the task-end chain');
  assert.equal(harness.reducerState().runtime, 'idle');
  assert.equal(harness.reducerState().binding, 'unbound');
  assert.equal(harness.reducerState().activity, 'roaming');
});

// ---------------------------------------------------------------------------
// resize, arrival, reduced motion
// ---------------------------------------------------------------------------

test('resize preserves the logical position within 0.005', () => {
  const harness = makeHarness();
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  harness.tick(1000);
  const before = harness.position();
  harness.setScene({ width: 640, height: 480 });
  assert.deepEqual(harness.position(), before, 'logical position is preserved exactly');
  const after = harness.screenPositionOf(before);
  assert.ok(Math.abs(after.x - before.x * 640) <= 0.005 * 1280 + 1e-9, 'screen position reprojects');
  harness.tick(500);
  assert.ok(harness.position().x > before.x, 'movement continues smoothly after resize');
  assert.equal(harness.target().nodeId, 'roam-2', 'target survives resize');
});

test('arrival error stays within 0.01', () => {
  const harness = makeHarness();
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming');
  let guard = 0;
  while (!harness.arrived() && guard < 5000) {
    harness.tick(50);
    guard += 1;
  }
  assert.ok(harness.arrived(), 'must arrive');
  const target = harness.target().point;
  const error = Math.hypot(
    (harness.position().x - target.x) * 1280,
    (harness.position().y - target.y) * 840
  ) / 840;
  assert.ok(error <= 0.01, `arrival error ${error} must be <= 0.01`);
});

test('reduced-motion arrives instantly and still advances logical state', () => {
  const harness = makeHarness();
  harness.setReducedMotion(true);
  harness.applyEvent({ type: 'dispatch', targetNodeId: 'desk-1' });
  harness.tick(16);
  assert.equal(harness.arrived(), true, 'reduced motion reaches the target on the first tick');
  assert.deepEqual(harness.position(), harness.target().point);
  harness.tick(16);
  harness.tick(16);
  assert.equal(harness.transition().phase, 'work', 'transition phases still advance');
  assert.equal(harness.reducerState().activity, 'working', 'reducer still records the running fact');
  assert.equal(harness.reducerState().movement, 'stationary');
});

// ---------------------------------------------------------------------------
// fallback, non-square viewport, determinism
// ---------------------------------------------------------------------------

test('missing animations fall back through the chain without a blank sprite', () => {
  const harness = makeHarness();
  for (const [state, expectedResource, expectedReason] of [
    ['sleeping', 'idle', 'STATIC_POSE_FALLBACK'],
    ['completed', 'finished', 'STATIC_POSE_FALLBACK'],
    ['thinking', 'side-back', 'DIRECTIONAL_POSE_FALLBACK'],
    ['working', 'working', null],
  ]) {
    harness.setState(state);
    const animation = harness.animation();
    assert.equal(animation.resource, expectedResource, `state ${state} resolves ${expectedResource}`);
    assert.equal(animation.fallbackReason, expectedReason);
    assert.ok(animation.resource !== null, 'a fallback resource always exists (never blank)');
  }
});

test('non-square viewport keeps position, speed and anchor honest', () => {
  const harness = makeHarness({ scene: { width: 1280, height: 720 } });
  assert.equal(harness.spriteLayout().visibleHeight, 79.2, 'clamp(64, 720*0.11, 180)');
  harness.setDirectTargetEnabled(true);
  harness.clickToTarget(0.5 * 1280, 0.5 * 720); // diagonal on a wide viewport
  harness.tick(16);
  assert.equal(harness.direction(), 'right', 'dominant screen axis wins (640px vs 360px)');
  const startX = harness.position().x;
  harness.tick(1000);
  const moved = harness.position().x - startX;
  const expected = (0.12 * 720) / 1280;
  assert.ok(Math.abs(moved - expected) <= expected * 0.05, `wide viewport speed ${moved} ~ ${expected}`);
  const layout = harness.spriteLayout();
  assert.equal(layout.visibleHeight, 79.2, 'visible height follows the resized scene');
});

test('same seed and events replay to identical diagnostics', () => {
  const replay = () => {
    const harness = makeHarness({ events: EVENTS.events });
    harness.replay();
    return harness.diagnostics();
  };
  const first = replay();
  const second = replay();
  assert.deepEqual(first, second);
  assert.equal(first.seed, 'playground-test-seed');
  assert.ok(first.log.length > 0, 'replay records a deterministic event log');
});

test('events fixture drives dispatch, thinking, result, stand and leave', () => {
  const harness = makeHarness({ events: EVENTS.events });
  harness.replay();
  const diag = harness.diagnostics();
  assert.equal(diag.reducer.activity, 'roaming', 'the fixture ends back in local behavior');
  assert.equal(diag.reducer.runtime, 'idle');
  assert.ok(diag.log.some((entry) => entry.type === 'dispatch'));
});

// ---------------------------------------------------------------------------
// debug controls: speed / direction / loop (Task 4 control-fix round)
// ---------------------------------------------------------------------------

test('speed control changes movement distance within the normalized speed contract', () => {
  const slow = makeHarness();
  const fast = makeHarness();
  slow.setSpeed(0.06);
  fast.setSpeed(0.12);
  assert.equal(slow.diagnostics().speedRatio, 0.06, 'diagnostics record the active speed');
  for (const harness of [slow, fast]) {
    harness.setDirectTargetEnabled(true);
    harness.clickToTarget(0.6 * VIEWPORT.width, 0.35 * VIEWPORT.height);
  }
  slow.tick(1000);
  fast.tick(1000);
  const slowMoved = slow.position().x - 0.2;
  const fastMoved = fast.position().x - 0.2;
  const slowExpected = (0.06 * 840) / 1280;
  const fastExpected = (0.12 * 840) / 1280;
  assert.ok(slowMoved < fastMoved, `speed 0.06 (${slowMoved}) must move less than 0.12 (${fastMoved})`);
  assert.ok(Math.abs(slowMoved - slowExpected) <= slowExpected * 0.05, `slow ${slowMoved} ~ ${slowExpected} (±5%)`);
  assert.ok(Math.abs(fastMoved - fastExpected) <= fastExpected * 0.05, `fast ${fastMoved} ~ ${fastExpected} (±5%)`);
});

test('direction override changes facing resources without touching position or routing', () => {
  const harness = makeHarness();
  const before = harness.position();
  harness.setDirection('left');
  assert.equal(harness.animation().resource, 'side-left', 'idle + override uses the directional pose');
  harness.setDirection('right');
  assert.equal(harness.animation().resource, 'side-right');
  harness.setDirection('up');
  assert.equal(harness.animation().resource, 'side-back');
  harness.setDirection('down');
  assert.equal(harness.animation().resource, 'side-back');
  assert.deepEqual(harness.position(), before, 'override never moves the character');
  assert.equal(harness.target(), null, 'override never sets a target');

  harness.setDirection('up');
  harness.clickToWaypoint(0.75 * VIEWPORT.width, 0.3 * VIEWPORT.height, 'roaming');
  assert.ok(harness.target(), 'moving with an override still routes');
  harness.tick(16);
  assert.equal(harness.animation().resource, 'walk-up', 'moving animation faces the override');
  harness.tick(1000);
  assert.ok(harness.position().x > before.x, 'movement distance/direction still follow the route');

  harness.setDirection(null);
  assert.equal(harness.animation().resource, 'walk-right', 'override cleared: auto dominant-axis facing resumes');
  const auto = makeHarness();
  auto.clickToWaypoint(0.75 * VIEWPORT.width, 0.3 * VIEWPORT.height, 'roaming');
  auto.tick(16);
  assert.equal(auto.animation().resource, 'walk-right', 'auto mode keeps the dominant-axis direction');
});

test('loop override controls frame wrapping and keeps the frame clock independent', () => {
  const harness = makeHarness();
  harness.clickToWaypoint(0.75 * VIEWPORT.width, 0.3 * VIEWPORT.height, 'roaming');
  harness.tick(16); // start walking: roam-1 -> roam-2 heads right, cycle 4000ms
  assert.equal(harness.animation().resource, 'walk-right');
  harness.setLoop(false);
  harness.tickAnimation(3500); // elapsed 3516 -> last frame window (3000..4000)
  assert.deepEqual(
    { index: harness.animation().frameIndex, elapsed: harness.animation().frameElapsedMs },
    { index: 3, elapsed: 516 },
    'non-loop clamps to the last frame'
  );
  const positionBefore = harness.position();
  harness.tickAnimation(5000);
  assert.equal(harness.animation().frameIndex, 3, 'stays on the last frame');
  assert.deepEqual(harness.position(), positionBefore, 'tickAnimation never moves the character');
  assert.equal(harness.isMoving(), true, 'movement state is owned by the movement ticker');

  const looping = makeHarness();
  looping.clickToWaypoint(0.75 * VIEWPORT.width, 0.3 * VIEWPORT.height, 'roaming');
  looping.tick(16);
  looping.setLoop(true);
  looping.tickAnimation(4500); // elapsed 4516; 4516 % 4000 = 516 -> frame 0
  assert.deepEqual(
    { index: looping.animation().frameIndex, elapsed: looping.animation().frameElapsedMs },
    { index: 0, elapsed: 516 },
    'loop=true returns to the first frame past the total duration'
  );
});

// ---------------------------------------------------------------------------
// Pixi view wiring (stub PIXI: real rendering is verified by evidence capture)
// ---------------------------------------------------------------------------

function stubPixi() {
  const created = { applications: [], sprites: [], graphics: [] };
  class Container {
    constructor() { this.children = []; this.visible = true; this.destroyed = false; }
    addChild(child) { this.children.push(child); return child; }
    destroy() { this.destroyed = true; }
  }
  class Sprite extends Container {
    constructor(texture) {
      super();
      this.texture = texture;
      this.x = 0;
      this.y = 0;
      this.__scale = 1;
      this.anchor = { set() {} };
      this.scale = { set() {} };
      created.sprites.push(this);
    }
    destroy() { this.destroyed = true; }
  }
  class Graphics extends Container {
    constructor() { super(); created.graphics.push(this); }
    rect() { return this; }
    circle() { return this; }
    moveTo() { return this; }
    lineTo() { return this; }
    fill() { return this; }
    stroke() { return this; }
    clear() { return this; }
  }
  class Application {
    constructor() { created.applications.push(this); this.stage = new Container(); this.canvas = {}; this.ticker = { add() {}, stop() {}, start() {} }; this.renderer = { resize() {}, destroy() {} }; }
    async init(options) { this.initOptions = options; }
    destroy() { this.destroyed = true; }
  }
  const textureFor = (file) => ({ __file: file, __anchor: { x: 178, y: 296 }, width: 352, height: 352 });
  return {
    created,
    textureFor,
    PIXI: { Application, Sprite, Graphics, Container, Texture: { from: (img) => textureFor(img.__file || 'unknown') } },
  };
}

test('view wiring creates exactly one Pixi Application and one character Sprite', async () => {
  const harness = makeHarness();
  const stub = stubPixi();
  const textures = new Map();
  for (const id of ['walk-left', 'walk-right', 'walk-up', 'walk-down', 'idle', 'working', 'finished', 'error', 'side-back']) {
    const anim = PACK.animation(id);
    for (const frame of anim.frames) textures.set(frame.file, stub.textureFor(frame.file));
  }
  const view = await playground.createPlaygroundView({
    PIXI: stub.PIXI,
    harness,
    textures,
    packBaseUrl: 'pack',
  });
  harness.clickToWaypoint(0.75 * 1280, 0.3 * 840, 'roaming'); // walk so frames advance
  assert.equal(stub.created.applications.length, 1, 'exactly one Pixi Application');
  assert.equal(stub.created.sprites.length, 1, 'exactly one character Sprite');
  assert.ok(stub.created.graphics.length >= 4, 'overlay Graphics for anchor/bounds/footprint/route');

  view.refresh();
  const firstTexture = view.sprite.texture;
  harness.tick(1000); // movement + animation advance together on the fake clock
  view.refresh();
  assert.equal(stub.created.sprites.length, 1, 'frame changes never recreate the sprite');
  assert.notEqual(view.sprite.texture, firstTexture, 'texture switches per frame');

  view.setArtVisible(false);
  assert.equal(view.sprite.visible, false, 'art-hidden debug toggle works');
  view.setArtVisible(true);
  assert.equal(view.sprite.visible, true);

  view.destroy();
  assert.equal(view.app.destroyed, true, 'application destroyed with the view');
});

// ---------------------------------------------------------------------------
// main.js dev-only command contract
// ---------------------------------------------------------------------------

test('main.js keeps the playground command development-only and default-off', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /officePlaygroundEnabled/);
  assert.match(main, /const OFFICE_PLAYGROUND_ENABLED = false/, 'frozen default is false');
  assert.match(main, /DSH_DESKTOP_OFFICE_PLAYGROUND/, 'dev override env name for evidence runs');
  assert.match(main, /office-playground/, 'local app scheme for the playground page');
  assert.match(main, /supportFetchAPI: true/);
  assert.doesNotMatch(main, /officePlaygroundEnabled\s*=\s*true/);
});
