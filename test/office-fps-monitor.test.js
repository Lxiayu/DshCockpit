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
  const record = { applications: [], destroyed: [] };
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

test('renderer + monitor: sustained low fps degrades this view to static with LOW_FPS_PERSISTENT', async () => {
  let nowMs = 0;
  const { view, record } = await makeViewWithMonitor({
    fpsConfig: { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5, now: () => nowMs, scheduleFrame: () => 0 },
  });
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnosticCode, null);
  // 6 low windows worth of frames at 20 fps
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; view.fpsMonitor.frame(); }
  assert.equal(view.fpsMonitor.degraded(), true);
  assert.equal(view.mode, 'static', 'degraded to static presentation');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  assert.equal(view.staticElement && view.staticElement.dataset.diagnosticCode, 'LOW_FPS_PERSISTENT');
  const app = record.applications[0];
  assert.equal(app.__destroyed, true, 'the view-owned pixi application is destroyed');
  assert.equal(view.diagnostics().mode, 'static');
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
  for (let i = 0; i < 30 * 6; i += 1) { nowMs += 50; lowFps.view.fpsMonitor.frame(); }
  assert.equal(lowFps.view.diagnosticCode, 'LOW_FPS_PERSISTENT');

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
