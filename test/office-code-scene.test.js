'use strict';

// test/office-code-scene.test.js — P3.1 场景代码化（纯几何 + 渲染器开关）。
//
// 判据：
//   - 描述由 scene 尺寸 + layout 预留区决定，输入相同则输出逐字段相同；
//   - 地砖完整覆盖地板带、越界处被裁切、棋盘交替确定；
//   - 主题/强调色是闭集，未知值回退到 light/indigo；
//   - 渲染器默认关闭（历史外观不变），启用后地板来自描述而非单块色带。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { describeCodeScene, THEMES, ACCENTS, FLOOR_TOP_RATIO } = require('../src/office/render/code-scene.js');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeLayout = require('../src/office/runtime/office-layout.js');

const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);

function layout() {
  return officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
}

// ---------------------------------------------------------------------------
// 纯描述
// ---------------------------------------------------------------------------

test('code scene: 1280x840 produces a complete, clipped tile grid', () => {
  const d = describeCodeScene({ scene: { width: 1280, height: 840 }, layout: layout() });
  assert.equal(d.theme, 'light');
  assert.equal(d.accent, 'indigo');
  assert.equal(d.floor.y, Math.round(840 * FLOOR_TOP_RATIO));
  assert.equal(d.floor.w, 1280);
  assert.equal(d.floor.h, 840 - d.floor.y);
  assert.ok(d.tilePx >= 32 && d.tilePx <= 96);

  const perRow = Math.ceil(1280 / d.tilePx);
  assert.equal(d.floor.columns, perRow);
  assert.equal(d.floor.rows, Math.ceil(d.floor.h / d.tilePx));
  assert.equal(d.floor.tiles.length, perRow * d.floor.rows);
  assert.equal(d.stats.tileCount, d.floor.tiles.length);

  // Every tile stays inside the floor band and the canvas.
  for (const tile of d.floor.tiles) {
    assert.ok(tile.x >= 0 && tile.x + tile.w <= 1280);
    assert.ok(tile.y >= d.floor.y && tile.y + tile.h <= 840);
    assert.ok(tile.w > 0 && tile.h > 0);
  }
  // The last tile of a row is clipped to the remaining width.
  const last = d.floor.tiles[d.floor.tiles.length - 1];
  assert.ok(last.x + last.w <= 1280);

  // Deterministic checker: neighbours in a row alternate.
  const firstRow = d.floor.tiles.slice(0, perRow);
  assert.equal(firstRow[0].fill, THEMES.light.floorA);
  assert.equal(firstRow[1].fill, THEMES.light.floorB);
  assert.equal(firstRow[2].fill, THEMES.light.floorA);
});

test('code scene: identical input produces an identical description (no hidden state)', () => {
  const a = describeCodeScene({ scene: { width: 1000, height: 700 }, layout: layout() });
  const b = describeCodeScene({ scene: { width: 1000, height: 700 }, layout: layout() });
  assert.deepEqual(a, b);
});

test('code scene: walls, window and the weakened reception belong to the description', () => {
  const d = describeCodeScene({ scene: { width: 1280, height: 840 }, layout: layout() });
  assert.equal(d.walls.bands.length, 3, 'the wall reads in three light steps');
  const wallBottom = d.walls.bands.reduce((sum, band) => sum + band.h, 0);
  assert.ok(wallBottom <= d.floor.y, 'the wall bands never spill onto the floor');
  assert.ok(d.walls.window.x >= 0 && d.walls.window.x + d.walls.window.w <= 1280);
  assert.ok(d.walls.window.y >= 0 && d.walls.window.y + d.walls.window.h <= d.floor.y);
  assert.equal(d.walls.window.mullions.length, 2);
  assert.ok(d.walls.window.glow.h > 0, 'the window casts a light pool on the floor');

  // Approved "keep but weaken": one low counter inside the reserve zone,
  // never a tall wall.
  assert.ok(d.reception, 'the reception counter exists');
  assert.equal(d.stats.hasReception, true);
  assert.ok(d.reception.h <= 20, `counter stays low (${d.reception.h}px)`);
  assert.ok(d.reception.y + d.reception.h <= d.floor.y + d.floor.h);
});

test('code scene: the dark theme is neutral gray (user 2026-10-27), not brown', () => {
  const dark = describeCodeScene({ scene: { width: 1280, height: 840 }, theme: 'dark' });
  const red = (value) => (value >> 16) & 0xff;
  const green = (value) => (value >> 8) & 0xff;
  const blue = (value) => value & 0xff;
  for (const key of ['floorA', 'floorB', 'wall', 'deskTop', 'chairSeat']) {
    const value = dark.colors[key];
    assert.ok(Math.abs(red(value) - blue(value)) <= 8, `${key} is neutral (r=${red(value)}, b=${blue(value)})`);
    assert.ok(Math.abs(red(value) - green(value)) <= 8, `${key} is neutral (r=${red(value)}, g=${green(value)})`);
  }
  assert.ok(blue(dark.colors.windowGlow) >= red(dark.colors.windowGlow), 'window light is cool, not amber');
});

test('code scene: the character scale is a clamped presentation ratio', () => {
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 } }).characterScale, 1);
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, characterScale: 1.18 }).characterScale, 1.18);
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, characterScale: 9 }).characterScale, 1.4);
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, characterScale: 0.1 }).characterScale, 0.9);
});

test('code scene: the reserve zone maps to a rect inside the floor band', () => {
  const d = describeCodeScene({ scene: { width: 1280, height: 840 }, layout: layout() });
  assert.equal(d.zones.length, 1);
  const [zone] = d.zones;
  const reserve = layout().reserveZone();
  assert.ok(Math.abs(zone.x - reserve.x * 1280) < 1e-9);
  assert.ok(Math.abs(zone.w - reserve.width * 1280) < 1e-9);
  assert.ok(zone.y >= d.floor.y, 'the zone never floats above the floor');
  assert.equal(zone.accent, ACCENTS.indigo);
  assert.ok(zone.h > 0 && zone.w > 0);
});

test('code scene: themes and accents are closed vocabularies with safe fallbacks', () => {
  const light = describeCodeScene({ scene: { width: 1280, height: 840 }, theme: 'light' });
  const dark = describeCodeScene({ scene: { width: 1280, height: 840 }, theme: 'dark' });
  assert.equal(dark.theme, 'dark');
  assert.notEqual(dark.colors.floorA, light.colors.floorA);
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, theme: 'neon' }).theme, 'light');
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, accent: 'teal' }).accent, 'teal');
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, accent: 'nope' }).accent, 'indigo');
  assert.equal(describeCodeScene({ scene: { width: 1280, height: 840 }, accent: 'nope' }).colors.accent, ACCENTS.indigo);
});

test('code scene: tiny scenes clamp the tile size instead of exploding the grid', () => {
  const d = describeCodeScene({ scene: { width: 200, height: 150 } });
  assert.ok(d.tilePx >= 32);
  assert.ok(d.stats.tileCount <= 8 * 5, `unexpected tile count ${d.stats.tileCount}`);
  assert.equal(d.zones.length, 0, 'no layout means no zones');
});

test('code scene: a malformed scene falls back to the reference size', () => {
  const d = describeCodeScene({ scene: { width: 0, height: -5 } });
  assert.equal(d.stats.width, 1280);
  assert.equal(d.stats.height, 840);
});

// ---------------------------------------------------------------------------
// 渲染器开关
// ---------------------------------------------------------------------------
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
      this.position = { x: 0, y: 0, set: (x, y) => { this.x = x; this.y = y; } };
    }
    on() { return this; }
    addChild(...kids) { for (const k of kids) { if (k.parent) k.parent.removeChild(k); this.children.push(k); k.parent = this; } return kids[0]; }
    removeChild(kid) { const i = this.children.indexOf(kid); if (i >= 0) this.children.splice(i, 1); if (kid) kid.parent = null; return kid; }
    sortChildren() {}
    destroy() { this.children.length = 0; }
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

async function createView(codeScene, scene, snapshot = null) {
  return officeRenderer.createOfficeRenderer({
    PIXI: makeStubPixi(),
    layout: layout(),
    pack: null,
    textures: new Map(),
    scene: scene || { width: 1280, height: 840 },
    snapshot,
    devicePixelRatio: 1,
    codeScene,
  });
}

const ONE_EMPLOYEE = {
  schemaVersion: 1,
  simulatedAtMs: 16,
  paused: false,
  sync: 'healthy',
  scene: { referenceWidth: 1280, referenceHeight: 840 },
  employees: [{
    employeeId: 'coder',
    displayName: 'coder',
    position: { x: 0.5, y: 0.6 },
    activity: 'working',
    movement: 'stationary',
    facing: 'down',
    animation: { resource: 'idle', frameIndex: 0 },
    queueCount: 0,
    marker: null,
  }],
  activityLog: [],
  diagnostics: [],
  capabilities: {},
};

test('code scene renderer: off by default — the historical look is untouched', async () => {
  const view = await createView(null);
  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.codeScene.enabled, false);
  assert.equal(diagnostics.codeScene.tileCount, undefined, 'no geometry is built when disabled');
  view.destroy();
});

test('code scene renderer: enabled builds the described floor and reports it', async () => {
  const view = await createView({ enabled: true, theme: 'light', accent: 'teal' });
  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.codeScene.enabled, true);
  assert.equal(diagnostics.codeScene.theme, 'light');
  assert.equal(diagnostics.codeScene.accent, 'teal');
  assert.ok(diagnostics.codeScene.tileCount > 0);
  assert.equal(diagnostics.codeScene.zoneCount, 1);

  // Resize reprojects the description with the new geometry.
  const before = diagnostics.codeScene.tileCount;
  view.resize({ width: 640, height: 420 });
  const after = view.diagnostics().codeScene;
  assert.ok(after.tileCount > 0);
  assert.ok(after.tileCount < before, `a smaller scene uses fewer tiles (${after.tileCount} < ${before})`);
  view.destroy();
});

test('code scene renderer: dark theme is reported and fully paints the canvas', async () => {
  const view = await createView({ enabled: true, theme: 'dark' });
  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.codeScene.theme, 'dark');
  assert.ok(diagnostics.codeScene.tileCount > 0);
  view.destroy();
});

test('page loader resolves the P3 renderer modules through its require shim', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /REGISTRY\['presentation-clock'\] = await loadModule\('\.\/render\/presentation-clock\.js'\)/);
  assert.match(html, /REGISTRY\['code-scene'\] = await loadModule\('\.\/render\/code-scene\.js'\)/);
  assert.match(html, /if \(spec === '\.\/presentation-clock\.js'\) return REGISTRY\['presentation-clock'\]/);
  assert.match(html, /if \(spec === '\.\/code-scene\.js'\) return REGISTRY\['code-scene'\]/);
  // Accepted 2026-10-27: the scene is on by default and follows the shell
  // theme; `?codeScene=0` is the rollback lever.
  assert.match(html, /enabled: codeSceneParam !== '0'/);
  assert.match(html, /theme: sceneThemeOverride \|\| initialTheme/);
  assert.match(html, /renderer\.setSceneTheme\(next\)/);
  assert.match(html, /codeScene: codeSceneOptions/);
});

test('code scene renderer: characters use the approved 1.18x, furniture keeps its art', async () => {
  const view = await createView({
    enabled: true, theme: 'dark', accent: 'clay', characterScale: 1.18, generatedFurniture: true,
  }, null, ONE_EMPLOYEE);
  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.codeScene.characterScale, 1.18);
  assert.equal(diagnostics.codeScene.generatedDesks, 6, 'the generated layout covers all six seats');
  assert.equal(diagnostics.codeScene.generatedFurniture, true);
  assert.equal(diagnostics.codeScene.generatedLounge, true);
  assert.equal(diagnostics.codeScene.generatedKitchen, true);
  const record = view.entities.get('coder');
  const expected = Math.round(840 * 0.11 * 100) / 100 * 1.18;
  assert.ok(Math.abs(record.__layout.visibleHeight - expected) < 0.01,
    `visible height ${record.__layout.visibleHeight} should be ${expected}`);
  view.destroy();
});

test('code scene renderer: the accepted look keeps the textured furniture (no generated layout)', async () => {
  const view = await createView({ enabled: true }, null, ONE_EMPLOYEE);
  const diagnostics = view.diagnostics();
  assert.equal(diagnostics.codeScene.generatedFurniture, false);
  assert.equal(diagnostics.codeScene.generatedDesks, 0);
  view.destroy();
});

test('code scene renderer: the shipping look keeps the frozen 92.4px character band', async () => {
  const view = await createView(null, null, ONE_EMPLOYEE);
  assert.equal(view.diagnostics().codeScene.characterScale, 1);
  assert.equal(view.diagnostics().codeScene.generatedDesks, 0);
  assert.equal(view.entities.get('coder').__layout.visibleHeight, Math.round(840 * 0.11 * 100) / 100);
  view.destroy();
});
