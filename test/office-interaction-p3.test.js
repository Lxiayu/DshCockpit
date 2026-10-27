'use strict';

// test/office-interaction-p3.test.js — P3.3 交互（悬停钉住 / 拖拽回位 / 双击联动）。
//
// 边界：交互只改变"画在哪"与"看哪个成员的产物"，**不产生事实**——
//   - 拖拽不写快照、不发 dispatch/interrupt：模拟位置在拖拽期间继续前进；
//   - 松手后角色缓动回模拟位置（不是用户放下的位置）；
//   - 双击只发一个座位 id（shell:office-focus），工作坞自己从 Work/Team 取事实；
//   - office:* 仍是 8 个通道，新增通道属于 shell 命名空间。

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

function makeStubPixi() {
  class Observable {
    constructor(kind) {
      this.__kind = kind;
      this.children = [];
      this.parent = null;
      this.x = 0; this.y = 0;
      this.visible = true; this.alpha = 1;
      this.texture = null;
      this.anchor = { set() {} };
      this.scale = { set() {} };
      this.position = { x: 0, y: 0, set: (x, y) => { this.x = x; this.y = y; this.position.x = x; this.position.y = y; } };
    }
    on() { return this; }
    addChild(...kids) { for (const k of kids) { if (k.parent) k.parent.removeChild(k); this.children.push(k); k.parent = this; } return kids[0]; }
    removeChild(kid) { const i = this.children.indexOf(kid); if (i >= 0) this.children.splice(i, 1); if (kid) kid.parent = null; return kid; }
    sortChildren() {}
    destroy() { this.children.length = 0; if (this.parent) this.parent.removeChild(this); }
  }
  class Container extends Observable { constructor() { super('Container'); } }
  class Sprite extends Observable { constructor(t) { super('Sprite'); this.texture = t || null; } }
  class Graphics extends Observable {
    constructor() {
      super('Graphics');
      const chain = () => proxy;
      const proxy = new Proxy(this, { get(t, p) { return p in t ? t[p] : chain; } });
      return proxy;
    }
  }
  class Text extends Observable { constructor(t) { super('Text'); this.text = String(t); this.style = {}; } }
  class Texture { constructor() { this.width = 100; this.height = 100; } destroy() {} }
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

function snapshotAt(simulatedAtMs, x, y) {
  return {
    schemaVersion: 1,
    simulatedAtMs,
    paused: false,
    sync: 'healthy',
    scene: { referenceWidth: 1280, referenceHeight: 840 },
    employees: [{
      employeeId: 'coder',
      displayName: 'coder',
      position: { x, y },
      activity: 'working',
      movement: 'moving',
      facing: 'down',
      animation: { resource: 'idle', frameIndex: 0 },
      queueCount: 0,
      marker: null,
    }],
    activityLog: [],
    diagnostics: [],
    capabilities: {},
  };
}

async function createView({ pump, clock, enabled = true }) {
  return officeRenderer.createOfficeRenderer({
    PIXI: makeStubPixi(),
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot: snapshotAt(16, 0.2, 0.4),
    devicePixelRatio: 1,
    presentation: {
      enabled,
      now: () => clock.nowMs,
      scheduleFrame: pump.scheduleFrame,
      cancelFrame: pump.cancelFrame,
    },
  });
}

function footOf(view) {
  return view.entities.get('coder').__footPx;
}

// ---------------------------------------------------------------------------
// 拖拽：只改绘制位置
// ---------------------------------------------------------------------------

test('drag: the drawn character follows the pointer and freezes while the simulation keeps moving', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, 0.4, 0.4));

  const base = view.beginDrag('coder');
  assert.deepEqual(base, { x: 0.2 * 1280, y: 0.4 * 840 }, 'the grab starts where the character is drawn');
  assert.equal(view.isDragging(), true);

  clock.nowMs = 17;
  view.dragTo(100, 50);
  assert.deepEqual(footOf(view), { x: 356, y: 386 }, 'drawn foot = grab point + pointer delta');

  // The simulation keeps walking underneath: positions must not affect the
  // dragged drawing, and the snapshot itself must stay untouched.
  clock.nowMs = 32;
  const next = snapshotAt(48, 0.6, 0.4);
  const frozenCopy = JSON.parse(JSON.stringify(next));
  view.applySnapshot(next);
  assert.deepEqual(footOf(view), { x: 356, y: 386 }, 'a push during the drag never moves the dragged character');
  assert.deepEqual(JSON.parse(JSON.stringify(next)), frozenCopy, 'the renderer never mutates the snapshot');
  assert.equal(view.entities.get('coder').__snapshot.position.x, 0.6, 'the fact is the simulation position');

  // Hit testing follows the drawing, not the snapshot.
  assert.equal(view.hitTest(356, 386), 'coder');
  assert.equal(view.hitTest(0.6 * 1280, 0.4 * 840), null, 'the simulation spot is empty while dragging');

  view.destroy();
});

test('drag: release eases back to the simulation position (not the drop point)', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock });
  clock.nowMs = 16;
  view.applySnapshot(snapshotAt(32, 0.4, 0.4));
  view.beginDrag('coder');
  clock.nowMs = 17;
  view.dragTo(100, 50);
  clock.nowMs = 32;
  view.applySnapshot(snapshotAt(48, 0.6, 0.4));

  const from = view.endDrag();
  assert.deepEqual(from, { x: 356, y: 386 });
  assert.equal(view.dragOffset().releasing, true);
  assert.equal(pump.pending !== null, true, 'the return animation arms the presentation pump');

  // Mid-flight: strictly between the drop point and the live position.
  assert.equal(pump.fire(clock, 32 + 130), true);
  const mid = footOf(view);
  assert.ok(mid.x > 356 && mid.x < 0.6 * 1280, `expected an in-between x, got ${mid.x}`);

  // Settled: exactly on the simulation position, and the drag state is gone.
  assert.equal(pump.fire(clock, 32 + 400), true);
  assert.deepEqual(footOf(view), { x: 0.6 * 1280, y: 0.4 * 840 });
  assert.equal(view.isDragging(), false);
  assert.equal(view.dragOffset(), null);
  view.destroy();
});

test('drag: without a presentation pump the release snaps straight back', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock, enabled: false });
  view.beginDrag('coder');
  view.dragTo(80, 0);
  assert.deepEqual(footOf(view), { x: 256 + 80, y: 0.4 * 840 });
  view.endDrag();
  assert.equal(view.isDragging(), false);
  assert.deepEqual(footOf(view), { x: 0.2 * 1280, y: 0.4 * 840 });
  view.destroy();
});

test('drag: beginDrag refuses an unknown seat and destroy is safe mid-drag', async () => {
  const pump = makeFramePump();
  const clock = { nowMs: 0 };
  const view = await createView({ pump, clock });
  assert.equal(view.beginDrag('nobody'), null);
  view.beginDrag('coder');
  view.dragTo(10, 10);
  view.destroy();
  assert.equal(pump.pending, null, 'destroy cancels the return animation');
});

// ---------------------------------------------------------------------------
// 页面与通道边界（静态契约）
// ---------------------------------------------------------------------------

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('interaction boundary: drag and double-click never dispatch office actions', () => {
  const html = read('src/office/office.html');
  // The drag handlers only talk to the renderer (presentation).
  assert.match(html, /renderer\.beginDrag\(/);
  assert.match(html, /renderer\.dragTo\(/);
  assert.match(html, /renderer\.endDrag\(/);
  // The double-click handler sends exactly one seat id through the shell channel.
  const dbl = html.slice(html.indexOf("stage.addEventListener('dblclick'"));
  const dblBody = dbl.slice(0, dbl.indexOf('});') + 3);
  assert.match(dblBody, /bridge\.focusMember\(hit\)/);
  assert.doesNotMatch(dblBody, /bridge\.(dispatch|cancel|interrupt|pending)/, 'double-click never issues an office action');
});

test('interaction boundary: focus is a shell-owned channel and office:* stays at eight', () => {
  const preload = read('src/office/office-preload.js');
  const allowed = preload.match(/const ALLOWED_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(allowed, 'the channel whitelist is declared literally');
  assert.equal((allowed[1].match(/'office:[a-z]+'/g) || []).length, 8, 'office:* remains the frozen eight');
  assert.match(preload, /focusMember: \(employeeId\) => ipcRenderer\.invoke\('shell:office-focus'/);

  const main = read('src/main.js');
  assert.match(main, /ipcMain\.handle\('shell:office-focus'/);
  assert.match(main, /focusWorkMember/);
  // The payload carries a seat id and nothing else.
  assert.match(main, /const employeeId = payload && typeof payload === 'object' \? payload\.employeeId : null/);
});

test('interaction boundary: the work view only highlights existing artifacts', () => {
  const js = read('src/work/work.js');
  assert.match(js, /state\.focusEmployee/);
  assert.match(js, /classList\.toggle\('focus-match'/);
  assert.match(js, /\{ action: 'focus', employeeId: null \}/);
  // Every producer label still comes from Work facts.
  assert.match(js, /artifact\.producerRole/);
  const html = read('src/work/work.html');
  assert.match(html, /id="focusBanner"/);
  assert.match(html, /work\.focus\.clear/);
});

test('interaction boundary: the renderer exposes drag as presentation-only API', () => {
  const renderer = read('src/office/render/pixi-office-renderer.js');
  for (const method of ['beginDrag(', 'dragTo(', 'endDrag(', 'isDragging', 'dragOffset']) {
    assert.ok(renderer.includes(method), `renderer exposes ${method}`);
  }
  const dragSection = renderer.slice(renderer.indexOf('const dragState ='), renderer.indexOf('function resetEntityOffsets'));
  assert.doesNotMatch(dragSection, /dispatch|interrupt|ipcRenderer|snapshot\s*\.\s*position\s*=/, 'drag never writes facts');
});
