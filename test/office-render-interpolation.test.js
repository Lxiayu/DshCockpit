'use strict';

// test/office-render-interpolation.test.js — P3.0 呈现时钟接入渲染器。
//
// 判据（P3 计划 §4 P3.0）：
//   - 两次推送之间，角色位置由渲染层的帧泵按真实时间插值，不再"一推一跳"；
//   - 插值只读快照；没有新快照时收敛到最新样本，绝不自走；
//   - 断点（超长间隔/暂停/模拟时间回退）直接吸附；
//   - 门控（前台/呈现/暂停/destroy）能停泵，停泵后不再出帧；
//   - 关闭 presentation 时回到历史行为（只在推送时画）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeLayout = require('../src/office/runtime/office-layout.js');

const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Stub PIXI with a real `position` point (the interpolation pump translates
// whole nodes instead of redrawing them).
// ---------------------------------------------------------------------------
function makeStubPixi() {
  class Observable {
    constructor(kind) {
      this.__kind = kind;
      this.children = [];
      this.parent = null;
      this.x = 0;
      this.y = 0;
      this.visible = true;
      this.alpha = 1;
      this.texture = null;
      this.anchor = { set() {} };
      this.scale = { set() {} };
      this.position = {
        x: 0,
        y: 0,
        set: (x, y) => { this.x = x; this.y = y; this.position.x = x; this.position.y = y; },
      };
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
      for (const child of [...this.children]) {
        if (child && typeof child.destroy === 'function') child.destroy(opts);
      }
      this.children.length = 0;
      if (this.parent) this.parent.removeChild(this);
    }
  }
  class Container extends Observable { constructor() { super('Container'); } }
  class Sprite extends Observable { constructor(texture) { super('Sprite'); this.texture = texture || null; } }
  class Graphics extends Observable {
    constructor() {
      super('Graphics');
      const chain = () => proxy;
      const proxy = new Proxy(this, { get(t, prop) { return prop in t ? t[prop] : chain; } });
      return proxy;
    }
  }
  class Text extends Observable {
    constructor(text) { super('Text'); this.text = String(text); this.style = {}; }
  }
  class Texture {
    constructor() { this.width = 100; this.height = 100; }
    destroy() {}
  }
  class Ticker { start() {} stop() {} add() {} remove() {} }
  class Application {
    constructor() {
      this.stage = new Container();
      this.ticker = new Ticker();
      this.renderer = { width: 0, height: 0, resize() {}, extract: { base64: async () => null } };
      this.canvas = { tagName: 'CANVAS', style: {}, parentNode: null };
    }
    async init(opts) { this.renderer.width = opts.width; this.renderer.height = opts.height; }
    destroy() {}
  }
  return { Application, Container, Sprite, Graphics, Text, Texture, Ticker, VERSION: '8.5.2-stub' };
}

function makeFramePump() {
  const pump = {
    pending: null,
    handle: 0,
    scheduleFrame(cb) { pump.handle += 1; pump.pending = { handle: pump.handle, cb }; return pump.handle; },
    cancelFrame(handle) { if (pump.pending && pump.pending.handle === handle) pump.pending = null; },
    /** Deliver exactly one scheduled frame at `atMs`. */
    fire(clock, atMs) {
      clock.nowMs = atMs;
      const frame = pump.pending;
      if (!frame) return false;
      pump.pending = null;
      frame.cb();
      return true;
    },
  };
  return pump;
}

function snapshotAt(simulatedAtMs, positions, extra) {
  return {
    schemaVersion: 1,
    simulatedAtMs,
    paused: false,
    sync: 'healthy',
    scene: { referenceWidth: 1280, referenceHeight: 840 },
    employees: Object.entries(positions).map(([employeeId, position]) => ({
      employeeId,
      displayName: employeeId,
      position: { x: position[0], y: position[1] },
      activity: 'roaming',
      movement: 'moving',
      facing: 'down',
      animation: { resource: 'idle', frameIndex: 0 },
      queueCount: 0,
      marker: null,
    })),
    activityLog: [],
    diagnostics: [],
    capabilities: {},
    ...(extra || {}),
  };
}

async function createView({ snapshot, pump, clock, presentation }) {
  return officeRenderer.createOfficeRenderer({
    PIXI: makeStubPixi(),
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot,
    devicePixelRatio: 1,
    presentation: {
      enabled: true,
      now: () => clock.nowMs,
      scheduleFrame: pump.scheduleFrame,
      cancelFrame: pump.cancelFrame,
      ...(presentation || {}),
    },
  });
}

function footOf(view, employeeId) {
  const record = view.entities.get(employeeId);
  return record ? record.__footPx : null;
}

function containerOffsetOf(view, employeeId) {
  const record = view.entities.get(employeeId);
  return record && record.container ? { x: record.container.position.x, y: record.container.position.y } : null;
}

// ---------------------------------------------------------------------------
// 插值
// ---------------------------------------------------------------------------

test('interpolation: a push paints at the previous sample, then eases to the newest', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({
    pump,
    clock,
    snapshot: snapshotAt(16, { a: [0.2, 0.4] }),
  });
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnostics().presentation.enabled, true);
  assert.equal(pump.pending, null, 'a single sample never arms the pump');

  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.4, 0.4] }));

  // alpha = 0 -> the picture still shows the previous sample (0.2), so the
  // container is offset by (0.2 - 0.4) * 1280 = -256px.
  const start = containerOffsetOf(view, 'a');
  assert.ok(Math.abs(start.x + 256) < 1e-6, `expected -256, got ${start.x}`);
  assert.ok(Math.abs(start.y) < 1e-6);
  assert.equal(view.diagnostics().presentation.scheduled, true);
  assert.equal(view.diagnostics().presentation.interpolating, true);

  // Midpoint of the arrival interval (arrived at 16, previous at 0): alpha 0.5.
  assert.equal(pump.fire(clock, 24), true);
  const mid = containerOffsetOf(view, 'a');
  assert.ok(Math.abs(mid.x + 128) < 1e-6, `expected -128 at the midpoint, got ${mid.x}`);

  // After the interval elapsed the entity sits exactly on the newest sample.
  assert.equal(pump.fire(clock, 32), true);
  const settled = containerOffsetOf(view, 'a');
  assert.ok(Math.abs(settled.x) < 1e-6);
  const foot = footOf(view, 'a');
  assert.ok(Math.abs(foot.x - 0.4 * 1280) < 1e-6, 'hit-test foot point follows the drawing');
  assert.equal(pump.pending, null, 'the pump stops once the segment is settled');
  assert.equal(view.diagnostics().presentation.interpolating, false);
});

test('interpolation: the pump never drifts without a new push', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.3, 0.4] }));
  assert.equal(pump.fire(clock, 24), true);
  assert.equal(pump.fire(clock, 32), true);
  assert.equal(pump.pending, null);
  const settled = containerOffsetOf(view, 'a');
  assert.ok(Math.abs(settled.x) < 1e-6, 'clamps at the newest fact');
  for (let t = 100; t < 5000; t += 500) {
    assert.equal(pump.fire(clock, t), false, `no frame is armed at t=${t}`);
  }
  assert.ok(Math.abs(containerOffsetOf(view, 'a').x) < 1e-6);
});

test('interpolation: a long arrival gap or a paused snapshot snaps instead of gliding', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });

  clock.nowMs = 5000; // page was throttled / window suspended
  view.applySnapshot(snapshotAt(32, { a: [0.6, 0.4] }));
  assert.equal(pump.pending, null, 'a discontinuity arms no frames');
  assert.ok(Math.abs(containerOffsetOf(view, 'a').x) < 1e-6, 'drawn exactly at the newest sample');

  clock.nowMs = 5016;
  view.applySnapshot(snapshotAt(48, { a: [0.8, 0.4] }, { paused: true }));
  assert.equal(pump.pending, null, 'paused snapshots never interpolate');
  assert.ok(Math.abs(containerOffsetOf(view, 'a').x) < 1e-6);
});

test('interpolation: a newcomer is drawn at its own position, never from 0,0', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.2, 0.4], b: [0.7, 0.6] }));
  assert.ok(Math.abs(containerOffsetOf(view, 'b').x) < 1e-6);
  const foot = footOf(view, 'b');
  assert.ok(Math.abs(foot.x - 0.7 * 1280) < 1e-6);
});

// ---------------------------------------------------------------------------
// 门控
// ---------------------------------------------------------------------------

test('interpolation: setPresenting(false) cancels the pump; the wake edge re-arms it', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.4, 0.4] }));
  assert.equal(pump.pending !== null, true);

  await view.setPresenting(false);
  assert.equal(pump.pending, null, 'the presentation pump stops while the screen is not presented');

  await view.setPresenting(true);
  assert.equal(pump.pending !== null, true, 'the wake edge resumes the unfinished segment');
  view.destroy();
  assert.equal(pump.pending, null, 'destroy cancels the pump');
});

test('interpolation: setVisible(false) stops the pump and never arms it while detached', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });
  await view.setVisible(false);
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.4, 0.4] }));
  assert.equal(pump.pending, null, 'a detached view draws on pushes only');
  await view.setVisible(true);
  assert.equal(pump.pending !== null, true, 'returning to the foreground resumes the segment');
  view.destroy();
});

test('interpolation: pause() stops the pump and resume() restarts it', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, snapshot: snapshotAt(16, { a: [0.2, 0.4] }) });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.4, 0.4] }));
  view.pause();
  assert.equal(pump.pending, null);
  view.resume();
  assert.equal(pump.pending !== null, true);
  view.destroy();
});

// ---------------------------------------------------------------------------
// 关闭开关 = 历史行为
// ---------------------------------------------------------------------------

test('interpolation: presentation.enabled=false keeps the paint-on-push behaviour', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({
    pump,
    clock,
    snapshot: snapshotAt(16, { a: [0.2, 0.4] }),
    presentation: { enabled: false },
  });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, { a: [0.4, 0.4] }));
  assert.equal(view.diagnostics().presentation.enabled, false);
  assert.equal(pump.pending, null, 'no frame pump is created at all');
  assert.ok(Math.abs(containerOffsetOf(view, 'a').x) < 1e-6, 'every push paints the exact sample');
});
