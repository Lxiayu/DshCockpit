'use strict';

// test/office-render-foreground-recovery.test.js — 2026-09-24 latch fix.
//
// Regressions for the release-blocker bug: "the office scene is permanently
// latched into the static diagnostic mode by the FPS monitor".
//
// Root cause (measured, /tmp/office-e2e/raf-cadence.json): while the harness
// is the active main-area view, syncShellViews() removeChildView()s the office
// view. The view keeps its rAF pump (backgroundThrottling:false) but only
// presents at 7.9 -> 1.3 fps. The SPEC-07 presentation-rate observer counted
// those frames; 150 of them (5 windows x 30 frames @1.3fps, ~2 minutes of
// harness time) latched LOW_FPS_PERSISTENT, destroyed the Pixi app and left
// the scene static FOREVER (no recovery), so switching back showed a dead
// diagnostic scene.
//
// Fixed by (a) gating the frame pump on the office:visibility `active` flag
// (renderer.setVisible), (b) resetting the monitor's measurement window at
// the foreground transition, (c) ONE bounded rebuild attempt per re-activation
// (3 per session, LOW_FPS_PERSISTENT only — hard failures are never retried),
// (d) renderer mode/code changes reaching the shell log over the EXISTING
// office:visibility invoke + office:diagnostics response (no new channel).
//
// Everything here drives the REAL modules with a stub PIXI and an injected
// clock/rAF: no real timers, no wall-clock reads, no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeLayout = require('../src/office/runtime/office-layout.js');
const officePage = require('../src/office/office-page.js');
const officeModule = require('../src/office/office-module.js');

const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Stub PIXI: enough surface for the renderer, with application-level init
// failure control (`failInitFrom`: 0-based application index from which BOTH
// the webgl and the canvas preference fail — the hard-failure case). Records
// every application so tests can count rebuilds exactly.
// ---------------------------------------------------------------------------

function makeStubPixi(options = {}) {
  const failInitFrom = Number.isInteger(options.failInitFrom) ? options.failInitFrom : Infinity;
  // Applications with index >= initGateFrom wait on the shared gate before
  // init() settles — used to interleave destroy() with an in-flight rebuild.
  const initGateFrom = Number.isInteger(options.initGateFrom) ? options.initGateFrom : Infinity;
  let gateResolve = null;
  const gate = new Promise((resolve) => { gateResolve = resolve; });
  const record = { applications: [], destroyedApplications: [], destroyedTextures: 0, stateChanges: [], releaseInit: () => gateResolve() };

  class Observable {
    constructor(kind) {
      this.__kind = kind;
      this.__destroyed = false;
      this.children = [];
      this.parent = null;
      this.x = 0;
      this.y = 0;
      this.visible = true;
      this.alpha = 1;
      this.zIndex = 0;
      this.sortableChildren = false;
      this.eventMode = 'auto';
      this.cursor = 'default';
      this.hitArea = null;
      this.texture = null;
    }
    on() { return this; }
    addChild(...kids) {
      for (const kid of kids) {
        if (kid.parent) kid.parent.removeChild(kid);
        this.children.push(kid);
        kid.parent = this;
      }
      return kids[0];
    }
    removeChild(kid) {
      const i = this.children.indexOf(kid);
      if (i >= 0) this.children.splice(i, 1);
      if (kid) kid.parent = null;
      return kid;
    }
    sortChildren() {}
    destroy(opts) {
      this.__destroyed = true;
      for (const child of [...this.children]) {
        if (child && typeof child.destroy === 'function') child.destroy(opts);
      }
      this.children.length = 0;
      if (this.parent) this.parent.removeChild(this);
    }
  }

  class Container extends Observable {
    constructor() { super('Container'); }
  }
  class Sprite extends Observable {
    constructor(texture) { super('Sprite'); this.texture = texture || null; this.anchor = { set() {} }; this.scale = { set() {} }; }
  }
  class Graphics extends Observable {
    constructor() {
      super('Graphics');
      const chain = () => proxy;
      const proxy = new Proxy(this, { get(t, prop) { return prop in t ? t[prop] : chain; } });
      this.__proxy = proxy;
      return proxy;
    }
  }
  class Text extends Observable {
    constructor(text) { super('Text'); this.text = String(text); this.style = {}; this.anchor = { set() {} }; this.scale = { set() {} }; }
  }
  class Texture {
    constructor(id) { this.__id = id; this.width = 100; this.height = 100; }
    destroy() { record.destroyedTextures += 1; }
  }
  class Ticker {
    constructor() { this.started = false; }
    add() {}
    remove() {}
    start() { this.started = true; }
    stop() { this.started = false; }
  }
  class Application {
    constructor() {
      this.stage = new Container();
      this.ticker = new Ticker();
      this.renderer = { width: 0, height: 0, resize() {}, extract: { base64: async () => null } };
      this.canvas = { tagName: 'CANVAS', style: {}, parentNode: null };
      this.__destroyed = false;
      record.applications.push(this);
    }
    async init(opts) {
      const index = record.applications.indexOf(this);
      if (index >= initGateFrom) await gate;
      if (index >= failInitFrom) {
        throw new Error(`stub init failure for application #${index} (${opts.preference})`);
      }
      this.renderer.width = opts.width;
      this.renderer.height = opts.height;
    }
    destroy() { this.__destroyed = true; record.destroyedApplications.push(this); }
  }

  const PIXI = {
    Application, Container, Sprite, Graphics, Text, Texture, Ticker,
    VERSION: '8.5.2-stub',
  };
  return { PIXI, record };
}

// ---------------------------------------------------------------------------
// rAF emulation: the injected scheduleFrame/cancelFrame the renderer uses as
// its frame pump. `pumpAt` fires the pending pump callback while advancing the
// injected clock at the requested fps — exactly what the page's request-
// AnimationFrame delivery would do.
// ---------------------------------------------------------------------------

function makeRaf() {
  // The hooks live on the SAME object as the bookkeeping, so tests can read
  // raf.pending / raf.fired / raf.canceled directly.
  const raf = {
    pending: null,
    handle: 0,
    fired: 0,
    canceled: 0,
    scheduleFrame(cb) {
      raf.handle += 1;
      raf.pending = { handle: raf.handle, cb };
      return raf.handle;
    },
    cancelFrame(handle) {
      raf.canceled += 1;
      if (raf.pending && raf.pending.handle === handle) raf.pending = null;
    },
  };
  return raf;
}

function makeClock() {
  return { nowMs: 0, now() { return this.nowMs; } };
}

function pumpAt(raf, clock, fps, frames) {
  const intervalMs = 1000 / fps;
  for (let i = 0; i < frames; i += 1) {
    clock.nowMs += intervalMs;
    const pending = raf.pending;
    if (pending) {
      raf.pending = null;
      raf.fired += 1;
      pending.cb();
    }
  }
}

const SNAPSHOT = {
  schemaVersion: 1,
  simulatedAtMs: 0,
  paused: false,
  sync: 'healthy',
  scene: { referenceWidth: 1280, referenceHeight: 840 },
  employees: [
    { employeeId: 'orchestrator', displayName: '调度员', position: { x: 0.36, y: 0.495 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'researcher', displayName: '研究员', position: { x: 0.56, y: 0.495 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'coder', displayName: '编码员', position: { x: 0.5, y: 0.6 }, activity: 'working', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 1, marker: null },
    { employeeId: 'reviewer', displayName: '评审员', position: { x: 0.36, y: 0.755 }, activity: 'resting', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'collaborator', displayName: '协作者', position: { x: 0.56, y: 0.755 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 2, marker: null },
  ],
  activityLog: [],
  diagnostics: [],
  capabilities: {},
};

const FPS_CONFIG = { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5 };

async function createView({ PIXI, record, raf, clock, onStateChange = null, fpsConfig = FPS_CONFIG, mount = null, createFallbackElement = null }) {
  return officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot: SNAPSHOT,
    mount,
    createFallbackElement,
    devicePixelRatio: 1,
    onStateChange,
    fpsMonitor: {
      ...fpsConfig,
      now: () => clock.nowMs,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    },
  });
}

// Drives the REAL monitor instance of the view to the static LOW_FPS_PERSISTENT
// state: 5 windows of 30 frames at 20 fps (below the 30 fps threshold), exactly
// the SPEC-07 LOW_FPS_PERSISTENT path. M1 ladder: from the full profile the
// FIRST latch steps DOWN to the low-cost render profile (the scene stays live)
// and a SECOND latch settles in the static presentation; a view that is already
// on the low-cost profile (an automatic rebuild keeps the profile) reaches
// static with one latch. Every test that needs "the static LOW_FPS_PERSISTENT
// state" gets there the way production does.
function latchForReal(view, raf, clock) {
  const windowsPerLatch = FPS_CONFIG.windowFrames * FPS_CONFIG.lowWindowLimit;
  const before = view.diagnostics().lowFpsEvents;
  let steps = 0;
  if (view.diagnostics().renderProfile === 'full') {
    pumpAt(raf, clock, 20, windowsPerLatch);
    steps += 1;
    assert.equal(view.diagnostics().lowFpsEvents, before + steps, 'the first latch happened');
    assert.equal(view.diagnostics().renderProfile, 'low-cost', 'M1: the first latch downgrades the render profile');
    assert.equal(view.mode, 'webgl', 'M1: the scene is still LIVE after the first latch');
  }
  pumpAt(raf, clock, 20, windowsPerLatch);
  steps += 1;
  assert.equal(view.diagnostics().lowFpsEvents, before + steps, 'the static latch happened');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
}

// ---------------------------------------------------------------------------
// ① foreground gating — THE regression test for the latch bug
// ---------------------------------------------------------------------------

test('latch regression: a detached view feeds the monitor nothing — ~3 minutes of background-rate frames never lock the scene, switching back keeps webgl', async () => {
  const { PIXI } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, raf, clock });
  assert.equal(view.mode, 'webgl');
  assert.equal(raf.pending !== null, true, 'the pump is armed while foreground');

  // Foreground: four consecutive low windows — ONE more would latch.
  pumpAt(raf, clock, 20, 30 * 4);
  assert.equal(view.fpsMonitor.degraded(), false);

  // The user works in the harness: syncShellViews() removes the office view
  // from the window. Its rAF pump still fires (backgroundThrottling:false) at
  // the measured detached rate (7.9 -> 1.3 fps). We emulate 260 frames at
  // 1.3 fps (~3.3 minutes — far beyond the 150-frame latch threshold) and
  // assert the renderer delivers NONE of them to the observer.
  const outcome = await view.setVisible(false);
  assert.equal(outcome.recovery, 'none');
  const firedBefore = raf.fired;
  pumpAt(raf, clock, 1.3, 260);
  assert.equal(raf.fired, firedBefore, 'no pump callback is even scheduled while the view is detached');
  assert.equal(raf.canceled >= 1, true, 'setVisible(false) cancels the in-flight pump');
  assert.equal(view.fpsMonitor.degraded(), false, 'the monitor saw nothing while detached');

  // The user switches back: the measurement window RESETS, so the four
  // pre-detach low windows cannot carry into the foreground streak.
  await view.setVisible(true);
  assert.equal(raf.pending !== null, true, 'the pump is re-armed on the way back');
  pumpAt(raf, clock, 20, 30 * 4);
  assert.equal(view.mode, 'webgl', 'the scene is still LIVE after ~3 minutes in the harness (was: permanently static)');
  assert.equal(view.fpsMonitor.degraded(), false, 'the low-window streak was reset at the foreground transition');

  // The observer is still armed for a GENUINE foreground problem: the next
  // consecutive low window latches. M1 ladder: that first latch steps down to
  // the low-cost render profile (the scene stays live), and a SECOND latch on
  // the downgraded profile reaches the static presentation — the observer was
  // not weakened, it just no longer kills the scene on one latch.
  pumpAt(raf, clock, 20, 30);
  assert.equal(view.diagnostics().lowFpsEvents, 1);
  assert.equal(view.diagnostics().renderProfile, 'low-cost');
  assert.equal(view.mode, 'webgl', 'M1: one latch no longer kills the scene');
  pumpAt(raf, clock, 20, 30 * 5);
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  view.destroy();
});

test('setVisible(false) stops the pump and setVisible(true) re-arms it (no double-arming, no frames while inactive)', async () => {
  const { PIXI } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, raf, clock });
  assert.equal(raf.pending !== null, true);

  view.setVisible(false);
  assert.equal(raf.pending, null, 'the pending pump was canceled');
  assert.equal(raf.canceled, 1);

  // A stale rAF delivery (the page's callback was already dispatched when the
  // view was detached and the cancel missed it) must not count either: pump()
  // itself refuses to run while the view is not foreground, and never
  // re-schedules.
  for (let i = 0; i < 60; i += 1) {
    clock.nowMs += 1000; // one minute at 1 fps
    const stale = raf.pending;
    if (stale) {
      raf.pending = null;
      raf.fired += 1;
      stale.cb();
    }
  }
  assert.equal(raf.handle, 1, 'a detached pump never re-schedules, even via a stale callback');
  assert.equal(view.fpsMonitor.degraded(), false, 'stale deliveries feed the observer nothing');

  view.setVisible(true);
  assert.equal(raf.pending !== null, true, 'the pump is armed again');
  const armed = raf.handle;
  view.setVisible(true); // already foreground: no re-arm, no new handle
  assert.equal(raf.handle, armed, 'a redundant setVisible(true) never double-arms the pump');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ② bounded recovery — one attempt per activation, 3 per session, hard
//    failures never retried
// ---------------------------------------------------------------------------

test('bounded recovery: a real LOW_FPS_PERSISTENT latch rebuilds exactly once on re-activation and restores the scene from the snapshot', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const events = [];
  const view = await createView({ PIXI, record, raf, clock, onStateChange: (s) => events.push({ ...s }) });
  assert.equal(view.mode, 'webgl');
  assert.equal(record.applications.length, 1);

  latchForReal(view, raf, clock);
  assert.equal(record.applications.length, 1, 'the degrade destroys the app; nothing is rebuilt yet');
  assert.equal(record.destroyedApplications.length, 1);
  assert.deepEqual(events.at(-1), { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 0 });

  await view.setVisible(false);
  const outcome = await view.setVisible(true);
  assert.equal(outcome.recovery, 'recovered');
  assert.equal(outcome.mode, 'webgl');
  assert.equal(view.mode, 'webgl', 'the view is live again');
  assert.equal(view.diagnosticCode, null);
  assert.equal(record.applications.length, 2, 'EXACTLY ONE rebuild');
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  // entities are restored from the pushed snapshot (degradeToStatic cleared them)
  assert.equal(view.entities.size, 5, 'the snapshot restored every employee');
  assert.equal(view.entities.get('coder').__snapshot.activity, 'working');
  // furniture/layers were rebuilt too (fresh stage children exist)
  assert.equal(view.layers['ground-entities'].children.length > 0, true, 'the rebuilt stage carries content');
  // the observer is re-armed with a fresh window
  assert.equal(view.fpsMonitor.degraded(), false);
  pumpAt(raf, clock, 60, 30 * 6);
  assert.equal(view.fpsMonitor.degraded(), false, 'healthy foreground frames never degrade again');
  // a redundant setVisible(true) (no de-activation in between) attempts nothing
  await view.setVisible(true);
  assert.equal(record.applications.length, 2, 'at most ONE attempt per activation');
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  // the re-armed observer can latch again (and that latch needs its own activation to recover)
  pumpAt(raf, clock, 20, 30 * 5);
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  assert.equal(record.applications.length, 2, 'the second latch rebuilds nothing by itself');
  assert.deepEqual(events.at(-1), { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 1 });
  view.destroy();
});

test('bounded recovery: the per-session cap (3) ends the rebuild loop — the 4th latch stays static and silent', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latchForReal(view, raf, clock);
    await view.setVisible(false);
    const outcome = await view.setVisible(true);
    assert.equal(outcome.recovery, 'recovered', `attempt ${attempt} recovers`);
    assert.equal(view.diagnostics().recoveryAttempts, attempt);
    assert.equal(record.applications.length, 1 + attempt);
  }

  // 4th latch: the session budget is spent — NO rebuild, stable static.
  latchForReal(view, raf, clock);
  await view.setVisible(false);
  const exhausted = await view.setVisible(true);
  assert.equal(exhausted.recovery, 'exhausted');
  assert.equal(exhausted.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT', 'the diagnostic stays stable, no flapping');
  assert.equal(record.applications.length, 4, 'the cap stopped the rebuild loop');
  assert.equal(view.diagnostics().recoveryAttempts, 3);

  // further activations stay silent too
  await view.setVisible(false);
  const again = await view.setVisible(true);
  assert.equal(again.recovery, 'exhausted');
  assert.equal(record.applications.length, 4);
  view.destroy();
});

test('bounded recovery: a rebuild that hits a hard WEBGL_INIT_FAILED stays static and is NEVER retried', async () => {
  // The boot application initializes; every REBUILD application fails both
  // preferences — the hard-failure class the recovery policy must not retry.
  const { PIXI, record } = makeStubPixi({ failInitFrom: 1 });
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  assert.equal(view.mode, 'webgl');

  latchForReal(view, raf, clock);
  await view.setVisible(false);
  const failed = await view.setVisible(true);
  assert.equal(failed.recovery, 'failed');
  assert.equal(failed.mode, 'static');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED', 'a failed rebuild is a hard failure code');
  assert.equal(record.applications.length, 3, 'one rebuild attempt: webgl + canvas application, both failed');

  // Re-activations do NOT retry a hard failure (the code changed away from
  // LOW_FPS_PERSISTENT, which is the only recoverable code).
  await view.setVisible(false);
  const second = await view.setVisible(true);
  assert.equal(second.recovery, 'none', 'hard failures are never retried');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED');
  assert.equal(record.applications.length, 3, 'no extra rebuild happened');
  assert.equal(view.diagnostics().recoveryAttempts, 1, 'the failed attempt still counts against the budget');
  view.destroy();
});

test('bounded recovery: RENDERER_UNAVAILABLE (no Pixi at all) is a hard failure and never rebuilt', async () => {
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI: null, raf, clock });
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'RENDERER_UNAVAILABLE');
  assert.equal(view.fpsMonitor, null, 'no observer is armed in this state');

  await view.setVisible(false);
  const outcome = await view.setVisible(true);
  assert.equal(outcome.recovery, 'none');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'RENDERER_UNAVAILABLE');
  view.destroy();
});

test('bounded recovery: the degraded canvas leaves the mount and the rebuild mounts exactly one canvas', async () => {
  const mount = {
    tagName: 'DIV',
    children: [],
    appendChild(el) { this.children.push(el); el.parentNode = this; },
    removeChild(el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; },
  };
  const fallbackElements = [];
  const createFallbackElement = () => {
    const el = {
      tagName: 'DIV', className: '', textContent: '', dataset: {}, parentNode: null,
      setAttribute() {},
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    };
    fallbackElements.push(el);
    return el;
  };
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock, mount, createFallbackElement });
  assert.equal(view.mode, 'webgl');
  assert.deepEqual(mount.children.map((el) => el.tagName), ['CANVAS'], 'the boot canvas is mounted');

  latchForReal(view, raf, clock);
  assert.equal(mount.children.includes(record.applications[0].canvas), false, 'the destroyed canvas left the DOM');
  assert.equal(mount.children.length, 1, 'only the static fallback remains');
  assert.equal(mount.children[0], fallbackElements[0]);

  await view.setVisible(false);
  await view.setVisible(true);
  assert.equal(view.mode, 'webgl');
  assert.equal(mount.children.includes(fallbackElements[0]), false, 'the static fallback was removed');
  assert.equal(mount.children.length, 1, 'EXACTLY ONE canvas after the rebuild');
  assert.equal(mount.children[0], record.applications[1].canvas);
  view.destroy();
});

test('bounded recovery: a snapshot push landing mid-rebuild (static-mode records) cannot corrupt the rebuild', async () => {
  // The office:state pushes keep flowing at ~100ms while the rebuild awaits
  // Pixi init; the page applies them with mode still 'static', which used to
  // create container-less entity records that then broke the rebuild's own
  // applySnapshot (half-rebuilt "webgl" view, latched monitor, no recovery).
  const { PIXI, record } = makeStubPixi({ initGateFrom: 1 });
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  latchForReal(view, raf, clock);
  await view.setVisible(false);
  const pending = view.setVisible(true); // rebuild starts, waits inside init()
  view.applySnapshot(SNAPSHOT); // the push that lands mid-rebuild
  record.releaseInit();
  const outcome = await pending;
  assert.equal(outcome.recovery, 'recovered', 'the rebuild completes despite the mid-flight push');
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnosticCode, null);
  assert.equal(view.entities.size, 5);
  for (const [id, entity] of view.entities) {
    assert.ok(entity.container, `${id} has real Pixi nodes after the rebuild`);
    assert.ok(entity.__sprite && entity.__badge && entity.__marker && entity.__selectionRing, `${id} has its effects nodes`);
  }
  assert.equal(view.fpsMonitor.degraded(), false, 'the monitor was re-armed');
  assert.equal(raf.pending !== null, true, 'the pump is armed again');
  view.destroy();
});

test('bounded recovery: destroy() during an in-flight rebuild is safe — no resurrect, no leaked application', async () => {
  const { PIXI, record } = makeStubPixi({ initGateFrom: 1 });
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  latchForReal(view, raf, clock);
  await view.setVisible(false);
  const pending = view.setVisible(true); // rebuild starts and waits inside init()
  view.destroy();
  record.releaseInit();
  const outcome = await pending;
  assert.equal(outcome.recovery, 'failed');
  assert.equal(view.__destroyed, true, 'the view stays terminal');
  assert.equal(record.applications.length, 2, 'one rebuild application was constructed');
  assert.equal(record.destroyedApplications.length, 2, 'the half-built application was discarded, not leaked');
  assert.equal(view.mode, 'static');
});

// ---------------------------------------------------------------------------
// ③ page controller wiring — `active` gates, `visible` pauses
// ---------------------------------------------------------------------------

test('page controller: handleVisibility gates the renderer on `active` and reports the renderer state on the existing bridge call', async () => {
  const bridge = {
    calls: [],
    getState: async () => SNAPSHOT,
    notifyVisibility: (visible, renderer) => { bridge.calls.push([visible, renderer]); },
  };
  const setVisibleCalls = [];
  const renderer = {
    setVisible: (visible) => { setVisibleCalls.push(visible); return Promise.resolve({ mode: 'webgl', diagnosticCode: null, recovery: 'none' }); },
    diagnostics: () => ({ mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }),
  };
  const page = officePage.createOfficePageController({ bridge, renderer });
  await page.init();

  // window visible, office NOT the active main view (the bug's state)
  page.handleVisibility({ visible: true, active: false });
  assert.deepEqual(setVisibleCalls, [false], 'the pump gate follows `active`, not `visible`');
  assert.deepEqual(bridge.calls.at(-1), [true, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }],
    'the renderer state rides the SAME office:visibility invoke (no new channel)');

  // back to the foreground: the pump re-arms (and a latched view would recover)
  renderer.diagnostics = () => ({ mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 });
  page.handleVisibility({ visible: true, active: true });
  assert.deepEqual(setVisibleCalls, [false, true]);
  assert.deepEqual(bridge.calls.at(-1), [true, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }]);

  // window hidden while the office stays the active view: the module pauses
  // the simulation, the pump gate is untouched.
  page.handleVisibility({ visible: false, active: true });
  assert.deepEqual(setVisibleCalls, [false, true, true]);
  assert.deepEqual(bridge.calls.at(-1), [false, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }]);

  // legacy bare-boolean form: historical window-visibility-only semantics (no
  // `active` information, so the pump gate is left untouched); the renderer
  // state still rides along whenever a renderer is attached.
  page.handleVisibility(false);
  assert.equal(setVisibleCalls.length, 3, 'a bare boolean carries no `active` information');
  assert.deepEqual(bridge.calls.at(-1), [false, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }]);
});

// ---------------------------------------------------------------------------
// ④ module observability — changes reach the shell log over office:visibility
// ---------------------------------------------------------------------------

function makeLoggingModule() {
  const lines = [];
  const module = officeModule.createOfficeModule({ seed: 'latch-observability', log: (line) => lines.push(line) });
  return { module, lines };
}

test('module: renderer mode/code/attempt changes ride office:visibility, are logged, and ride the office:diagnostics response', () => {
  const { module, lines } = makeLoggingModule();

  const first = module.noteVisibility({
    viewId: 'office-shell-1',
    visible: true,
    renderer: { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 },
  });
  assert.equal(first.ok, true);
  assert.equal(lines.filter((l) => l.includes('[office] renderer')).length, 1, 'the first report is the logged baseline');
  assert.match(lines.at(-1), /\[office\] renderer mode=webgl code=ok recoveryAttempts=0 \(view office-shell-1\)/);

  // the latch (what used to be invisible in the log)
  module.noteVisibility({ viewId: 'office-shell-1', visible: true, renderer: { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 0 } });
  assert.match(lines.at(-1), /mode=static code=LOW_FPS_PERSISTENT/);

  // the bounded recovery rebuild
  module.noteVisibility({ viewId: 'office-shell-1', visible: true, renderer: { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1 } });
  assert.match(lines.at(-1), /mode=webgl code=ok recoveryAttempts=1/);

  // unchanged tuples are not re-logged (the page reports on every visibility event)
  const before = lines.length;
  module.noteVisibility({ viewId: 'office-shell-1', visible: true, renderer: { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1 } });
  assert.equal(lines.length, before, 'no duplicate log line for an unchanged state');

  // office:diagnostics now carries the view-side renderer state
  const diagnostics = module.diagnostics();
  assert.deepEqual(diagnostics.renderer, { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1 });
});

test('module: the office:visibility renderer report is validated like every other payload key', async () => {
  const { module } = makeLoggingModule();
  const good = { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 };
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true }).ok, true, 'the renderer field stays optional');
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true, renderer: good }).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true, renderer: { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT' } }).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true, renderer: { mode: 5 } }).ok, false, 'mode must be a string');
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true, renderer: { mode: 'webgl', evil: 1 } }).ok, false, 'unknown renderer keys rejected');
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true, renderer: { diagnosticCode: null } }).ok, false, 'mode is required when the report is present');
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: 'yes' }).ok, false, 'legacy validation unchanged');

  const handles = new Map();
  officeModule.registerOfficeIpc({ ipcMain: { handle: (channel, handler) => handles.set(channel, handler) }, module });
  const answered = await handles.get('office:visibility')({}, { visible: true, viewId: 'office-shell-1', renderer: { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 0 } });
  assert.equal(answered.ok, true);
  assert.deepEqual(module.diagnostics().renderer, { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 0 });
});

// ---------------------------------------------------------------------------
// ⑤ office.html wiring — the page source is the integration point
// ---------------------------------------------------------------------------

test('office.html: the visibility payload’s `active` flag reaches the renderer gate and the footer names the specific code', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /createOfficePageController\(\{\s*\n\s*bridge,\s*\n\s*renderer,/s, 'the page controller receives the renderer');
  assert.match(html, /let officeActive = true;/, 'the office opens as the active main view');
  assert.match(html, /bridge\.onVisibilityPush\(\(payload\) => \{\s*\n\s*officeActive = !![^\n]*payload\.active/, 'the push payload updates the active flag');
  assert.match(html, /visibility\(\{ visible: [^\n]*active: officeActive \}\)/, 'window events keep carrying the active flag');
  assert.match(html, /page\.handleVisibility\(\{ visible: document\.visibilityState === 'visible', active: officeActive \}\)/, 'renderer state changes are reported through the controller');
  assert.match(html, /onStateChange: \(\) => \{ syncRendererDegradeNote\(\); reportRendererState\(\); \}/, 'renderer mode changes update the dot and the shell report');
  assert.match(html, /渲染降级：\$\{diagnostics\.diagnosticCode \|\| 'RENDERER_UNAVAILABLE'\}/, 'the footer dot names the SPECIFIC stable code');
  assert.match(html, /diagnostics\.mode !== 'webgl'/, 'any non-webgl mode (canvas fallback or static) degrades the dot');
  assert.match(html, /rendererDegradeNote = null;/, 'a successful recovery clears the footer note');
  assert.match(html, /rendererDiagnostics: \(\) => renderer\.diagnostics\(\)/, 'the evidence hook exposes the full renderer diagnostics');
});

// ---------------------------------------------------------------------------
// ⑥ M1 (windows-perf audit 2026-09-24) — the degrade ladder, the stall
//    watchdog, and the visible manual retry entry.
// ---------------------------------------------------------------------------

const OFFICE_POLICY = require('../src/office/render/fps-monitor.js').OFFICE_LOW_FPS_POLICY;

// A minimal DOM good enough for the renderer's static fallback: the page owns
// the real one; here we only need createElement/appendChild/addEventListener so
// the retry entry can be built and clicked.
function makeFakeDom() {
  function makeElement(tag) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      type: '',
      disabled: false,
      dataset: {},
      children: [],
      listeners: {},
      appendChild(child) { node.children.push(child); return child; },
      setAttribute() {},
      remove() { node.removed = true; },
      querySelector() { return null; },
      addEventListener(type, cb) { node.listeners[type] = cb; },
      click() { if (node.listeners.click) node.listeners.click(); },
    };
    return node;
  }
  const doc = { createElement: (tag) => makeElement(tag) };
  return { doc, makeElement };
}

// Injectable timers for the stall watchdog.
function makeFakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    scheduled: 0,
    setTimeout(cb, ms) { id += 1; pending.set(id, { cb, ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    pendingCount: () => pending.size,
    fireAll() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.cb();
    },
  };
}

test('M1 stall watchdog: a renderer that presents NO frame walks the ladder and reaches static', async () => {
  // The page arms the production policy, which includes stallMs. No rAF
  // callback ever fires (a dead pump / lost context): the ONLY thing that
  // measures is the watchdog's poll(), and it alone must reach the ladder.
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const timers = makeFakeTimers();
  const view = await createView({
    PIXI, record, raf, clock,
    fpsConfig: {
      ...OFFICE_POLICY,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
  });
  assert.equal(view.mode, 'webgl');
  assert.equal(timers.pendingCount(), 1, 'the watchdog is armed while the pump is armed');

  const windowMs = OFFICE_POLICY.windowMs;
  const perLatch = OFFICE_POLICY.lowWindowLimit;
  for (let i = 0; i < perLatch; i += 1) { clock.nowMs += windowMs; timers.fireAll(); }
  assert.equal(view.diagnostics().lowFpsEvents, 1, 'N zero-frame windows latch the observer');
  assert.equal(view.diagnostics().renderProfile, 'low-cost', 'the ladder steps down first');
  assert.equal(view.mode, 'webgl', 'the scene is still live');
  for (let i = 0; i < perLatch; i += 1) { clock.nowMs += windowMs; timers.fireAll(); }
  assert.equal(view.diagnostics().lowFpsEvents, 2, 'one latch per ladder step (a stall poll must not double-handle)');
  assert.equal(view.mode, 'static', '0 fps is below the static floor: the honest answer is the static diagnostic');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
  assert.equal(timers.pendingCount(), 0, 'no watchdog survives the terminal degrade');
  view.destroy();
});

test('M1 stall watchdog: armed only for the time-window policy, and cleared while the view is detached', async () => {
  const { PIXI } = makeStubPixi();
  const timers = makeFakeTimers();
  // legacy frame-count policy: nothing to poll, nothing scheduled
  const legacy = await createView({ PIXI, raf: makeRaf(), clock: makeClock(), fpsConfig: { ...FPS_CONFIG, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } });
  assert.equal(timers.pendingCount(), 0, 'the legacy shape schedules no watchdog');
  legacy.destroy();

  const view = await createView({
    PIXI, raf: makeRaf(), clock: makeClock(),
    fpsConfig: { ...OFFICE_POLICY, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
  });
  assert.equal(timers.pendingCount(), 1);
  await view.setVisible(false);
  assert.equal(timers.pendingCount(), 0, 'a detached view is not measured (the 2026-09-24 rule)');
  await view.setVisible(true);
  assert.equal(timers.pendingCount(), 1, 're-activation re-arms the watchdog');
  view.destroy();
  assert.equal(timers.pendingCount(), 0, 'destroy() clears it');
});

test('M1 static floor: a slow-but-alive scene (>= floor fps) keeps the low-cost profile instead of going static', async () => {
  // 12 fps: below the 20 fps threshold (so it latches) but above the 10 fps
  // floor — the picture must stay alive with the full art.
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({
    PIXI, record, raf, clock,
    fpsConfig: { ...OFFICE_POLICY, now: undefined },
  });
  // One latch = lowWindowLimit consecutive time windows = 4 x 3s. The
  // frame-count formula does NOT apply to the time-window policy.
  // 13s of frames per step: 4 windows (12s) close and latch, the 5th (15s) does not.
  const latchFrames = Math.ceil(12 * (OFFICE_POLICY.lowWindowLimit * OFFICE_POLICY.windowMs / 1000 + 1));
  pumpAt(raf, clock, 12, latchFrames);
  assert.equal(view.diagnostics().lowFpsEvents, 1);
  assert.equal(view.diagnostics().renderProfile, 'low-cost');
  pumpAt(raf, clock, 12, latchFrames);
  assert.equal(view.diagnostics().lowFpsEvents, 2, 'the second latch happened');
  assert.equal(view.mode, 'webgl', '12 fps >= the 10 fps static floor: "slow" is not "broken"');
  assert.equal(view.diagnosticCode, null);
  assert.equal(record.destroyedApplications.length, 0, 'no application was thrown away');
  pumpAt(raf, clock, 12, latchFrames);
  assert.equal(view.diagnostics().lowFpsEvents, 3);
  assert.equal(view.mode, 'webgl', 'and it stays live as long as it keeps presenting ~12 fps');
  view.destroy();
});

test('M1 manual retry: the static fallback carries a visible 重试渲染 entry that rebuilds the scene', async () => {
  const { PIXI, record } = makeStubPixi();
  const { doc, makeElement } = makeFakeDom();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({
    PIXI, record, raf, clock,
    createFallbackElement: () => { const el = makeElement('div'); el.ownerDocument = doc; return el; },
  });
  latchForReal(view, raf, clock);
  assert.equal(view.mode, 'static');
  const fallback = view.staticElement;
  assert.ok(fallback, 'the static element exists');
  const row = fallback.children[0];
  assert.ok(row, 'the retry row is part of the static presentation');
  const button = row.children[0];
  assert.equal(button.textContent, '重试渲染', 'the entry is labelled for the user');
  assert.equal(button.disabled, false, 'LOW_FPS_PERSISTENT is retryable');
  assert.match(row.children[1].textContent, /本会话最多 3 次/, 'the hint states the budget');

  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.mode, 'webgl', 'the click brought the scene back');
  assert.equal(view.diagnosticCode, null);
  assert.equal(record.applications.length, 2, 'exactly one rebuild');
  assert.equal(view.diagnostics().manualRetryAttempts, 1);
  assert.equal(view.diagnostics().recoveryAttempts, 0, 'a manual retry never consumes the automatic budget');
  assert.equal(view.diagnostics().renderProfile, 'full', 'the user asked for the full-quality scene');
  view.destroy();
});

test('M1 manual retry: its own 3-per-session budget, independent of the automatic policy', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latchForReal(view, raf, clock);
    assert.equal(view.mode, 'static');
    assert.equal(await view.retryRendering(), 'recovered', `manual attempt ${attempt}`);
    assert.equal(view.mode, 'webgl');
    assert.equal(view.diagnostics().manualRetryAttempts, attempt);
    assert.equal(view.diagnostics().recoveryAttempts, 0, 'the automatic budget is untouched');
  }
  latchForReal(view, raf, clock);
  assert.equal(await view.retryRendering(), 'exhausted');
  assert.equal(view.mode, 'static', 'the 4th manual retry is refused, the static state stays stable');
  assert.equal(record.applications.length, 4, 'the boot app + exactly 3 manual rebuilds');
  view.destroy();
});

test('M1 manual retry: a hard WEBGL_INIT_FAILED is never offered as retryable', async () => {
  const { PIXI } = makeStubPixi({ failInitFrom: 0 }); // every application fails to init
  const { doc, makeElement } = makeFakeDom();
  const view = await createView({
    PIXI, raf: makeRaf(), clock: makeClock(),
    createFallbackElement: () => { const el = makeElement('div'); el.ownerDocument = doc; return el; },
  });
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED');
  const button = view.staticElement.children[0].children[0];
  assert.equal(button.disabled, true, 'a rebuild would fail exactly the same way');
  assert.equal(button.textContent, '无法重试渲染');
  assert.equal(await view.retryRendering(), 'none');
  assert.equal(view.mode, 'static');
  view.destroy();
});

test('M1 manual retry: does nothing while the scene is live', async () => {
  const { PIXI, record } = makeStubPixi();
  const view = await createView({ PIXI, record, raf: makeRaf(), clock: makeClock() });
  assert.equal(view.mode, 'webgl');
  assert.equal(await view.retryRendering(), 'none');
  assert.equal(record.applications.length, 1);
  view.destroy();
});
