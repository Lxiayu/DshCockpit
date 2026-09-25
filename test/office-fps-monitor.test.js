'use strict';

// test/office-fps-monitor.test.js — Blocker B / SPEC-07 regression tests.
//
// RED: src/office/render/fps-monitor.js does not exist yet.
//
// Contract under test (SPEC-07 performance/degradation contract, Task 9
// blocker B): a presentation-rate observer that distinguishes a runtime FPS
// drop from WebGL init failure. It is NOT a simulation ticker: it only
// counts frames and reads an injected clock; it can never advance movement,
// animation or any office state. Sustained FPS below the threshold for the
// configured number of consecutive windows latches a degraded state exactly
// once; recovery windows reset the counter. No wall-clock reads, no real
// timers — fully injectable now() and frame counts.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFpsMonitor } = require('../src/office/render/fps-monitor.js');

// Drives `frames` frames at the given fps through the monitor using an
// injectable fake clock; returns the monitor for assertions.
function drive({ fps, frames, thresholdFps = 30, windowFrames = 30, lowWindowLimit = 5, onDegrade = null }) {
  let nowMs = 0;
  const monitor = createFpsMonitor({
    thresholdFps,
    windowFrames,
    lowWindowLimit,
    now: () => nowMs,
    onDegrade,
  });
  const intervalMs = 1000 / fps;
  for (let i = 0; i < frames; i += 1) {
    nowMs += intervalMs;
    monitor.frame();
  }
  return { monitor, nowMs };
}

test('normal fps (60) never degrades, even after many windows', () => {
  let degradedCalls = 0;
  const { monitor } = drive({ fps: 60, frames: 60 * 30, onDegrade: () => { degradedCalls += 1; } });
  assert.equal(monitor.degraded(), false);
  assert.equal(degradedCalls, 0);
});

test('sustained low fps (20) degrades exactly once after lowWindowLimit windows', () => {
  const degradeEvents = [];
  const { monitor } = drive({
    fps: 20,
    frames: 20 * 8, // 8 windows worth of frames at 20 fps
    windowFrames: 30,
    lowWindowLimit: 5,
    onDegrade: (code) => degradeEvents.push(code),
  });
  assert.equal(monitor.degraded(), true);
  assert.equal(degradeEvents.length, 1);
  assert.equal(degradeEvents[0], 'LOW_FPS_PERSISTENT');
});

test('a few low windows followed by recovery resets and never degrades', () => {
  let nowMs = 0;
  const monitor = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs });
  // 4 low windows (20 fps)
  for (let i = 0; i < 30 * 4; i += 1) { nowMs += 50; monitor.frame(); }
  // 6 healthy windows (60 fps) reset the streak
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 16.6; monitor.frame(); }
  assert.equal(monitor.degraded(), false);
  // low again: the streak restarts from zero, so 4 more low windows must NOT degrade
  for (let i = 0; i < 30 * 4; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), false);
  // the 5th consecutive low window crosses the limit
  for (let i = 0; i < 30 * 1; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), true);
});

test('degraded state latches: further frames never clear it', () => {
  let nowMs = 0;
  const monitor = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 2, now: () => nowMs });
  for (let i = 0; i < 30 * 3; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), true);
  for (let i = 0; i < 30 * 10; i += 1) { nowMs += 16.6; monitor.frame(); }
  assert.equal(monitor.degraded(), true);
});

test('threshold is injectable: 45 fps degrades against a 50 threshold but not against 30', () => {
  const strict = drive({ fps: 45, frames: 45 * 10, thresholdFps: 50, windowFrames: 45, lowWindowLimit: 5 });
  assert.equal(strict.monitor.degraded(), true);
  const lenient = drive({ fps: 45, frames: 45 * 10, thresholdFps: 30, windowFrames: 45, lowWindowLimit: 5 });
  assert.equal(lenient.monitor.degraded(), false);
});

test('no wall-clock reads: the injected now() is the only time source', () => {
  const originalNow = Date.now;
  let injectedReads = 0;
  let nowMs = 0;
  try {
    Date.now = () => { throw new Error('Date.now must not be used'); };
    const monitor = createFpsMonitor({
      thresholdFps: 30,
      windowFrames: 30,
      lowWindowLimit: 2,
      now: () => { injectedReads += 1; return nowMs; },
    });
    for (let i = 0; i < 30 * 3; i += 1) { nowMs += 50; monitor.frame(); }
    assert.equal(monitor.degraded(), true);
    assert.ok(injectedReads > 0, 'monitor must consult the injected clock');
  } finally {
    Date.now = originalNow;
  }
});

// ---------------------------------------------------------------------------
// reset() — the SPEC-07 contract correction (2026-09-24 latch fix).
//
// The monitor used to be latch-only ("no automatic recovery"). While the
// pump was gated on view foreground the observer can still legitimately
// latch (a real sustained low-fps foreground), and the view owner then
// re-arms it with reset() after a bounded recovery rebuild. reset() is the
// ONLY re-arm path: there is no timer, no wall-clock re-check and no
// self-recovery — an unattended degraded monitor stays degraded, exactly
// like before. These tests pin that contract.
// ---------------------------------------------------------------------------

test('reset() re-arms a latched monitor: the degraded state clears and new windows are measured fresh', () => {
  let nowMs = 0;
  const degradeEvents = [];
  const monitor = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 2, now: () => nowMs, onDegrade: (c) => degradeEvents.push(c) });
  for (let i = 0; i < 30 * 3; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), true);
  assert.equal(monitor.code(), 'LOW_FPS_PERSISTENT');
  assert.equal(degradeEvents.length, 1);

  monitor.reset();
  assert.equal(monitor.degraded(), false, 'reset() clears the latch');
  assert.equal(monitor.code(), null);
  // the fresh window needs the FULL lowWindowLimit consecutive low windows
  // again — one low window must not re-degrade immediately
  for (let i = 0; i < 30; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), false);
  assert.equal(degradeEvents.length, 1, 'no new degrade event yet');
  for (let i = 0; i < 30; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), true, 'the second consecutive low window re-latches');
  assert.equal(degradeEvents.length, 2);
});

test('reset() discards the in-flight window: partial progress never survives a re-arm', () => {
  let nowMs = 0;
  const monitor = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs });
  // 4 low windows, then a PARTIAL 5th window (20 of 30 frames at 20 fps)
  for (let i = 0; i < 30 * 4 + 20; i += 1) { nowMs += 50; monitor.frame(); }
  // the foreground transition re-arms: the partial window and the streak are gone
  monitor.reset();
  // 4 fresh low windows must NOT degrade — the streak restarted from zero
  for (let i = 0; i < 30 * 4; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), false);
  // the 5th consecutive low window of the NEW streak crosses the limit
  for (let i = 0; i < 30; i += 1) { nowMs += 50; monitor.frame(); }
  assert.equal(monitor.degraded(), true);
});

test('without reset(), a detached-rate window mix latches the monitor at ~150 frames (the 2026-09-24 bug)', () => {
  // Evidence for the bug this fix removes: fed continuously, a 1.3 fps
  // presentation rate (a detached view with backgroundThrottling:false)
  // completes 5 windows of 30 frames = 150 frames and latches. The renderer
  // now stops the pump while detached and resets on the way back, so those
  // frames are never delivered; this test pins the monitor-level arithmetic
  // that made the latch reachable in ~2 minutes of harness time.
  let nowMs = 0;
  const degradeEvents = [];
  const monitor = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, onDegrade: (c) => degradeEvents.push(c) });
  for (let i = 0; i < 149; i += 1) { nowMs += 1000 / 1.3; monitor.frame(); }
  assert.equal(monitor.degraded(), false, '4 windows are not enough');
  nowMs += 1000 / 1.3;
  monitor.frame();
  assert.equal(monitor.degraded(), true, 'the 150th frame (5th window) latches');
  assert.deepEqual(degradeEvents, ['LOW_FPS_PERSISTENT']);
});

const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeLayout = require('../src/office/runtime/office-layout.js');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);

function makeStubPIXI(options = {}) {
  // M1: `renders` counts app.render() calls so the low-cost render profile
  // (redraw coalescing + skip-unchanged) is measured, not assumed.
  const record = { applications: [], destroyed: [], renders: 0 };
  function makeObject(kind) {
    const target = {
      __kind: kind,
      __destroyed: false,
      children: [],
      position: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } },
      anchor: { set() {} },
      scale: { set() {} },
      zIndex: 0,
      sortableChildren: false,
      visible: true,
      eventMode: 'auto',
      cursor: 'default',
      hitArea: null,
      alpha: 1,
      texture: null,
      on() {},
      addChild(...c) { this.children.push(...c); return c[0]; },
      removeChildren() { this.children.length = 0; },
      sortChildren() {},
      destroy(...args) { target.__destroyed = true; record.destroyed.push({ kind, args }); },
    };
    const proxy = new Proxy(target, {
      get(t, prop) {
        if (prop in t) {
          const value = t[prop];
          return value;
        }
        return (...args) => proxy; // chained drawing helpers
      },
      set(t, prop, value) { t[prop] = value; return true; },
    });
    return proxy;
  }
  const PIXI = {
    Application: class {
      constructor() { this.stage = makeObject('stage'); this.ticker = { started: false, count: 0, stop() {}, start() {} }; this.canvas = { style: {} }; this.renderer = { extract: { base64: async () => null } }; record.applications.push(this); }
      render() { record.renders += 1; }
      async init() { if (options.failInit) { const e = new Error('init failed: ' + options.failInit); throw e; } }
      destroy(...args) { this.__destroyed = true; record.destroyed.push({ kind: 'application', args }); }
    },
    Container: class { constructor() { return makeObject('container'); } },
    Sprite: class { constructor(texture) { return makeObject('sprite'); } },
    Graphics: class { constructor() { return makeObject('graphics'); } },
    Text: class { constructor(text, style) { const o = makeObject('text'); o.text = text; return o; } },
    Texture: { EMPTY: { __empty: true } },
    Ticker: { shared: { count: 0 } },
  };
  return { PIXI, record };
}

const SNAPSHOT = {
  schemaVersion: 1,
  simulatedAtMs: 0,
  paused: false,
  sync: 'healthy',
  scene: { referenceWidth: 1280, referenceHeight: 840 },
  employees: [],
  activityLog: [],
  diagnostics: [],
  capabilities: {},
};

async function makeViewWithMonitor({ fpsConfig, stubOptions = {} }) {
  const { PIXI, record } = makeStubPIXI(stubOptions);
  const fallbackElements = [];
  const view = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot: SNAPSHOT,
    mount: null,
    createFallbackElement: () => {
      const el = { className: '', textContent: '', dataset: {}, setAttribute() {}, tagName: 'DIV' };
      fallbackElements.push(el);
      return el;
    },
    fpsMonitor: fpsConfig,
  });
  return { view, record, fallbackElements };
}

test('renderer + monitor (M1 ladder): the FIRST latch steps down to the low-cost render profile, only a SECOND latch goes static', async () => {
  let nowMs = 0;
  const { view, record } = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnosticCode, null);
  assert.equal(view.diagnostics().renderProfile, 'full');
  // 6 low windows worth of frames at 20 fps → the first latch
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.diagnostics().lowFpsEvents, 1, 'the first latch was observed');
  assert.equal(view.diagnostics().renderProfile, 'low-cost', 'the scene steps down instead of dying');
  assert.equal(view.mode, 'webgl', 'the scene is STILL LIVE after the first latch');
  assert.equal(view.diagnosticCode, null);
  assert.equal(record.destroyed.some((d) => d.kind === 'application'), false, 'no Pixi application is destroyed on a downgrade');
  assert.equal(view.fpsMonitor.degraded(), false, 'the downgraded profile gets a fresh measurement window');

  // The low-cost profile cannot help either: the SECOND latch settles in the
  // static diagnostic presentation, exactly like the historical contract.
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.diagnostics().lowFpsEvents, 2);
  assert.equal(view.mode, 'static', 'degraded to static presentation');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  assert.equal(view.staticElement && view.staticElement.dataset.diagnosticCode, 'LOW_FPS_PERSISTENT');
  const app = record.applications[0];
  assert.equal(app.__destroyed, true, 'the view-owned pixi application is destroyed');
  assert.equal(view.diagnostics().mode, 'static');
});

test('M1 ladder: the low-cost profile keeps the art — no rebuild, entities and textures survive the downgrade', async () => {
  // makeViewWithMonitor passes no packs, but the ladder must not clear what the
  // view owns: degradeToStatic is the only stage that destroys resources.
  let nowMs = 0;
  const { view, record } = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.diagnostics().renderProfile, 'low-cost');
  assert.equal(record.applications.length, 1, 'the downgrade never boots a second Pixi application');
  assert.equal(view.staticElement, null, 'no static fallback element is mounted for a downgrade');
  assert.equal(view.diagnostics().entityCount, 0, 'the snapshot had no employees; the point is that nothing was cleared by force');
  // A snapshot pushed after the downgrade still reaches the stage (the profile
  // only changes how often pixels are produced).
  view.applySnapshot({ ...SNAPSHOT, employees: [{ employeeId: 'coder', displayName: 'coder', position: { x: 0.5, y: 0.5 }, activity: 'working', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null }] });
  assert.equal(view.diagnostics().entityCount, 1);
  assert.equal(view.mode, 'webgl');
});

test('renderer + monitor: normal fps never degrades and the diagnostic code stays null', async () => {
  let nowMs = 0;
  const { view } = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  for (let i = 0; i < 30 * 30; i += 1) { nowMs += 16.6; view.fpsMonitor.frame(); }
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnosticCode, null);
});

test('LOW_FPS_PERSISTENT is a classification distinct from WebGL init failure', async () => {
  let nowMs = 0;
  const lowFps = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  const cfg = { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 };
  // M1: two latch rounds (low-cost profile, then static) reach the same final
  // LOW_FPS_PERSISTENT classification.
  for (let i = 0; i < 30 * 12; i += 1) { nowMs += 50; lowFps.view.fpsMonitor.frame(); }
  assert.equal(lowFps.view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  assert.equal(lowFps.view.diagnostics().renderProfile, 'low-cost');
  assert.equal(lowFps.view.diagnostics().lowFpsEvents, 2);
  assert.equal(lowFps.view.mode, 'static');

  const { view: webglFailed } = await makeViewWithMonitor({
    fpsConfig: cfg,
    stubOptions: { failInit: 'all' },
  });
  assert.equal(webglFailed.mode, 'static');
  assert.equal(webglFailed.diagnosticCode, 'WEBGL_INIT_FAILED');
  assert.notEqual(webglFailed.diagnosticCode, lowFps.view.diagnosticCode);
});

test('destroy() with an armed monitor cancels the frame loop; frames after destroy are inert', async () => {
  let nowMs = 0;
  let scheduled = 0;
  let canceled = 0;
  const { view } = await makeViewWithMonitor({
    fpsConfig: {
      thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs,
      scheduleFrame: () => { scheduled += 1; return scheduled; },
      cancelFrame: () => { canceled += 1; },
    },
  });
  view.destroy();
  assert.equal(canceled >= 1, true, 'the scheduled frame loop is canceled');
  assert.equal(view.__destroyed, true);
  // frames after destroy must be inert (no throw, no resurrect)
  for (let i = 0; i < 100; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.mode, 'webgl', 'destroy() does not rewrite the recorded mode; the view is terminal via __destroyed');
});

// ---------------------------------------------------------------------------
// M1 (windows-perf audit 2026-09-24) — the judgement rewrite.
//
// Old shape: thresholdFps 30 / 30-frame windows / 5 windows. A machine that
// renders 25 fps closed a 30-frame window every 1.2s, counted 5 low windows in
// 6.0s and the office went permanently static — on Windows (integrated GPU,
// hi-dpi, AV resident) that is the reported "办公室卡住不动".
// New shape: 20 fps / 3s wall-time windows / 4 windows. Counting is in wall
// time, so a steady-but-slow machine closes one window per 3s and needs 12s of
// sustained sub-20fps before anything happens at all — and a rate at or above
// the threshold on average never accumulates.
// The renderer's ladder + static floor then decide what "degrade" means
// (handled in office-render-foreground-recovery.test.js).
// ---------------------------------------------------------------------------

const officeHtmlSource = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'src', 'office', 'office.html'), 'utf8'
);

test('M1 policy: office.html arms exactly the exported OFFICE_LOW_FPS_POLICY', () => {
  const { OFFICE_LOW_FPS_POLICY, OFFICE_STALL_POLL_MS } = require('../src/office/render/fps-monitor.js');
  const block = officeHtmlSource.match(/fpsMonitor:\s*\{([\s\S]*?)\}/);
  assert.ok(block, 'office.html still arms a fpsMonitor config');
  const literal = {};
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*(\d+)/g)) literal[key] = Number(value);
  assert.deepEqual(literal, { ...OFFICE_LOW_FPS_POLICY }, 'the page config and the exported policy must not drift apart');
  assert.equal(OFFICE_LOW_FPS_POLICY.stallMs, OFFICE_STALL_POLL_MS, 'the watchdog period is the policy value');
  assert.ok(OFFICE_STALL_POLL_MS <= OFFICE_LOW_FPS_POLICY.windowMs, 'the watchdog must poll at least once per window');
  assert.ok(OFFICE_LOW_FPS_POLICY.windowFrames / (OFFICE_LOW_FPS_POLICY.windowMs / 1000) >= 60,
    'windowFrames is only an upper bound: it must allow >= 60 fps inside a full window');
});

// Drives a fixed presentation rate for `seconds` through a monitor with the
// given policy and returns the time (seconds) of the first latch, or null.
function timeToFirstLatch(policy, fps, seconds) {
  let nowMs = 0;
  const at = [];
  const monitor = createFpsMonitor({ ...policy, now: () => nowMs, onDegrade: () => at.push(nowMs) });
  const intervalMs = 1000 / fps;
  let next = intervalMs;
  while (next <= seconds * 1000 && at.length === 0) {
    nowMs = next;
    monitor.frame();
    next += intervalMs;
  }
  return at.length ? at[0] / 1000 : null;
}

test('M1 behaviour table: the old 30/30/5 policy kills the scene, the new one tolerates "usable but slow"', () => {
  const { OFFICE_LOW_FPS_POLICY } = require('../src/office/render/fps-monitor.js');
  const OLD = { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, windowMs: 0 };
  const table = [];
  for (const fps of [60, 30, 25, 20, 18, 15, 10, 9, 5]) {
    table.push({
      fps,
      oldLatchS: timeToFirstLatch(OLD, fps, 60),
      newLatchS: timeToFirstLatch(OFFICE_LOW_FPS_POLICY, fps, 60),
    });
  }
  const byFps = new Map(table.map((row) => [row.fps, row]));
  const near = (actual, expected, label) => {
    assert.ok(actual !== null && Math.abs(actual - expected) < 0.2, `${label}: ${actual} ~= ${expected}`);
  };
  // 25 fps — the Windows integrated-GPU band that triggered the report: the old
  // policy killed the scene in 6.0s, the new policy never latches at all.
  near(byFps.get(25).oldLatchS, 6.0, 'old 25 fps');
  assert.equal(byFps.get(25).newLatchS, null, '25 fps is "slow", not "broken"');
  // 20 fps is exactly the threshold: the comparison is strict (<), so it lives.
  assert.equal(byFps.get(20).newLatchS, null);
  // 15 fps: old 10s (the audit's number), new 12.5s (4 x 3s windows of 15 fps).
  near(byFps.get(15).oldLatchS, 10.0, 'old 15 fps');
  near(byFps.get(15).newLatchS, 12.5, 'new 15 fps');
  // A genuinely bad 5 fps still latches (the observer was not disabled).
  near(byFps.get(5).newLatchS, 12.8, 'new 5 fps');
  // And the healthy rates never latch under either policy.
  for (const fps of [60, 30]) {
    assert.equal(byFps.get(fps).newLatchS, null);
    assert.equal(byFps.get(fps).oldLatchS, null);
  }
});

test('M1 time windows: one bad second inside a 3s window cannot latch a 24 fps machine', () => {
  const { OFFICE_LOW_FPS_POLICY } = require('../src/office/render/fps-monitor.js');
  let nowMs = 0;
  const latches = [];
  const monitor = createFpsMonitor({ ...OFFICE_LOW_FPS_POLICY, now: () => nowMs, onDegrade: () => latches.push(nowMs) });
  // 60s of 24 fps with a 1s freeze (4 fps) every 10s: a 3s window absorbs the
  // hiccup (its average stays above 20), where a 30-frame window would have
  // counted the freeze as a whole low window.
  for (let t = 0; t < 60_000; t += 1_000 / 24) {
    nowMs = t;
    monitor.frame();
    if (Math.floor(t / 1000) % 10 === 0 && (t % 1000) < 250) { nowMs += 200; monitor.frame(); }
  }
  assert.deepEqual(latches, [], 'jitter never latches the new policy');
  assert.ok(monitor.stats().windows >= 15, 'windows really were measured');
});

test('M1 poll(): a renderer that presents NO frame still latches (the old shape could never see this)', () => {
  const { OFFICE_LOW_FPS_POLICY } = require('../src/office/render/fps-monitor.js');
  let nowMs = 0;
  const latches = [];
  const monitor = createFpsMonitor({ ...OFFICE_LOW_FPS_POLICY, now: () => nowMs, onDegrade: () => latches.push(nowMs) });
  // No frame() call at all — only the view owner's watchdog polls.
  for (let i = 0; i < 3; i += 1) { nowMs += 3_000; assert.equal(monitor.poll(), false); }
  nowMs += 3_000;
  assert.equal(monitor.poll(), true, '4 zero-frame windows = 12s of nothing presented');
  assert.deepEqual(latches, [12_000]);
  assert.equal(monitor.stats().lastFps, 0, '0 frames is 0 fps by construction');
});

test('M1 poll(): inert for the legacy frame-count shape and for a window that is not overdue', () => {
  // legacy (windowMs = 0): poll() must never do anything
  let nowMs = 0;
  const legacy = createFpsMonitor({ thresholdFps: 30, windowFrames: 30, lowWindowLimit: 2, now: () => nowMs });
  nowMs = 10 * 60_000;
  assert.equal(legacy.poll(), false);
  assert.equal(legacy.degraded(), false);
  // time window, but only 1s into a 3s window: not overdue yet
  let t = 0;
  const fresh = createFpsMonitor({ thresholdFps: 20, windowFrames: 240, windowMs: 3_000, lowWindowLimit: 4, now: () => t });
  t = 1_000;
  assert.equal(fresh.poll(), false);
  // drive at 60 fps until the first window closes
  while (fresh.stats().windows === 0) { t += 16.6; fresh.frame(); }
  assert.equal(fresh.stats().windows, 1);
  assert.equal(fresh.poll(), false, 'the watchdog does not re-close a window that just closed');
  assert.equal(fresh.stats().windows, 1);
  t += 2_999;
  assert.equal(fresh.poll(), false, 'not overdue yet');
  t += 1; // exactly windowMs with ZERO frames in it
  assert.equal(fresh.poll(), false, 'one low window is not a latch');
  assert.equal(fresh.stats().windows, 2, 'an overdue window with no frames is a measured window (0 fps)');
  assert.equal(fresh.stats().lowWindows, 1);
  assert.equal(fresh.stats().consecutiveLowWindows, 1);
});

test('M1 stats(): window telemetry is exposed for diagnostics/probes and never affects the decision', () => {
  const { OFFICE_LOW_FPS_POLICY } = require('../src/office/render/fps-monitor.js');
  let nowMs = 0;
  const monitor = createFpsMonitor({ ...OFFICE_LOW_FPS_POLICY, now: () => nowMs });
  for (let i = 0; i < 240; i += 1) { nowMs += 1000 / 60; monitor.frame(); }
  const stats = monitor.stats();
  assert.equal(stats.thresholdFps, 20);
  assert.equal(stats.windowMs, 3_000);
  assert.equal(stats.lowWindowLimit, 4);
  assert.equal(stats.lowWindows, 0);
  assert.ok(stats.windows >= 1);
  assert.ok(stats.lastFps > 20);
  assert.equal(stats.degraded, false);
});

test('M1 low-cost profile: redraw coalescing and skip-unchanged are MEASURED (render call counts)', async () => {
  let nowMs = 0;
  const { view, record } = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  const employee = (x) => ({
    employeeId: 'coder', displayName: '编码员', position: { x, y: 0.5 },
    activity: 'working', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null,
  });
  const snapshot = (x) => ({ ...SNAPSHOT, employees: [employee(x)] });

  // 2026-09-25（**有意更新**，性能专项）：full 档不再"每推必画"——可视签名没变
  // 的那一推画出来是同样的像素（62.5Hz 重复重绘是实测 CPU/GPU 的主要来源之一）。
  // full 与 low-cost 的唯一区别现在只剩"不设频率上限"。见
  // docs/strategy/2026-09-25-v0.4.0-release-verification.md「性能专项」。
  // （boot 的 applySnapshot 已经画过一次。）
  const bootRenders = record.renders;
  assert.equal(bootRenders, 1, 'the initial snapshot painted at boot');
  // 这一推把实体集合从 5 人变成 1 人（其余被移除）——集合变化同样是可见变化
  view.applySnapshot(snapshot(0.5));
  assert.equal(record.renders, bootRenders + 1, 'a changed entity set paints once');
  view.applySnapshot(snapshot(0.5)); // 连位置/动画都一样 → 同样的像素
  assert.equal(record.renders, bootRenders + 1, 'full profile: an unchanged push paints nothing');
  const beforeChange = record.renders;
  view.applySnapshot(snapshot(0.51)); // 位置变了 → 必须画
  assert.equal(record.renders, beforeChange + 1, 'full profile: a visible change paints exactly once');
  view.applySnapshot(snapshot(0.51));
  assert.equal(record.renders, beforeChange + 1, 'and a repeat of the same visible state paints nothing');

  // Latch once → low-cost profile (the scene stays live).
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.diagnostics().renderProfile, 'low-cost');
  assert.equal(view.mode, 'webgl');

  nowMs += 1_000;
  const afterSwitch = record.renders;
  for (let i = 0; i < 10; i += 1) view.applySnapshot(snapshot(0.5));
  assert.equal(record.renders, afterSwitch + 1,
    'the first push after the downgrade repaints once (to record the signature); the other nine paint nothing');

  const before = record.renders;
  nowMs += 1_000;
  view.applySnapshot(snapshot(0.6));
  assert.equal(record.renders, before + 1, 'a visible change paints exactly once');

  // Same instant (same injected clock): 20 further changes are coalesced.
  for (let i = 0; i < 20; i += 1) view.applySnapshot(snapshot(0.6 + i * 0.0001));
  assert.equal(record.renders, before + 1, 'pushes inside the coalescing slot paint nothing');

  nowMs += 100; // past the 33ms slot at 30 Hz
  view.applySnapshot(snapshot(0.7));
  assert.equal(record.renders, before + 2, 'the accumulated state paints on the next allowed slot');
});
