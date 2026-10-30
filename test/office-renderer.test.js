'use strict';

// Task 7 / SPEC-07 — Pixi Office renderer + layout fixture tests.
// RED: src/office/runtime/office-layout.js, src/office/fixtures/office-layout.json
// and src/office/render/pixi-office-renderer.js do not exist yet.
//
// Automatic acceptance under test (SPEC-07 / plan Task 7 Step 1):
// - six-desk 2x3 layout shifted slightly right/down with a left-top reserve
// - nodes declare id/position/footprint/safeRadius/tags/capacity
// - fixed layer order Background -> Back Furniture -> Ground Entities ->
//   Front Occluders -> Effects/Labels; ground entities sort stably by
//   (footY, layer, entityType, id)
// - ONE Pixi Application per renderer; ONE persistent node per employee —
//   status/selection refresh never recreates or destroys character nodes
// - foot-anchor + shared visibleHeight contract
//   (clamp(64px, sceneHeight * 0.11, 180px)) across states and resize
// - anchor-preserving resize (logical positions reproject, never re-measured)
// - pause/resume stops the ticker without replaying time
// - WebGL init failure falls back to Canvas, then to a static diagnostic
//   presentation with a stable code, without crashing
// - queue badge, selection ring and hit testing on the Effects/labels layer
// - destroy() releases this view's owned textures and application
// - the renderer never imports Harness/IPC modules (snapshot consumer only)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeLayout = require('../src/office/runtime/office-layout.js');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const employeeProfiles = require('../src/office/runtime/employee-profile.js');

// P5 (2026-09-24): the module-level pack is the SHIPPED production pack
// (resources/characters/deepseek-default). The retired first-generation fixture
// pack was byte-equivalent for everything this file asserts (working.png /
// idle.png sha256-identical, same anchors subset: anchor {178,296},
// visibleBounds {6,41,319,277}, outputCanvas 352²), so every assertion below is
// unchanged — it now pins the art and geometry that actually ship.
const PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);

const VIEWPORT = { width: 1280, height: 840 };

// ---------------------------------------------------------------------------
// Stub PIXI: just enough surface for the renderer. Every constructor records
// its instances so tests can assert lifecycle facts (count, destroy order).
// ---------------------------------------------------------------------------

function stubPIXI(options = {}) {
  const created = { applications: [], sprites: [], graphics: [], texts: [], containers: [], tickers: [] };
  const failInit = options.failInit || null; // 'webgl' | 'canvas' | 'all'

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
      created[kind === 'Sprite' ? 'sprites' : kind === 'Graphics' ? 'graphics' : kind === 'Text' ? 'texts' : 'containers'].push(this);
    }
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
    constructor(texture) {
      super('Sprite');
      this.texture = texture || null;
      this.anchor = { set() {} };
      // records applied transforms so tests can assert resize behavior
      this.scale = {
        x: 1,
        y: 1,
        set(x, y) { this.x = x; this.y = y === undefined ? x : y; },
      };
    }
    destroy(opts) { this.__destroyed = true; this.__destroyOpts = opts; this.children.length = 0; }
  }

  class Graphics extends Observable {
    constructor() { super('Graphics'); this.__ops = []; }
    rect(x, y, w, h) { this.__ops.push(['rect', x, y, w, h]); return this; }
    circle(x, y, r) { this.__ops.push(['circle', x, y, r]); return this; }
    roundRect(x, y, w, h, r) { this.__ops.push(['roundRect', x, y, w, h, r]); return this; }
    fill(style) { this.__ops.push(['fill', style]); return this; }
    stroke(style) { this.__ops.push(['stroke', style]); return this; }
    clear() { this.__ops.push(['clear']); return this; }
  }

  class Text extends Observable {
    constructor(text) {
      super('Text');
      this.text = String(text);
      this.style = {};
      this.anchor = { set() {} };
    }
  }

  class Texture {
    constructor(id, width = 100, height = 100) {
      this.__id = id;
      this.width = width;
      this.height = height;
      this.__destroyed = false;
    }
    destroy() { this.__destroyed = true; }
  }

  class Ticker {
    constructor() {
      this.started = false;
      this.addCalls = 0;
      created.tickers.push(this);
    }
    add() { this.addCalls += 1; }
    remove() { this.addCalls = Math.max(0, this.addCalls - 1); }
    start() { this.started = true; }
    stop() { this.started = false; }
  }

  class Application {
    constructor() {
      this.stage = new Container();
      this.ticker = new Ticker();
      this.renderer = {
        resize(w, h) { this.width = w; this.height = h; },
        width: 0,
        height: 0,
      };
      this.canvas = { tagName: 'CANVAS' };
      this.__destroyed = false;
      created.applications.push(this);
    }
    async init(opts) {
      this.__initOpts = opts;
      if (failInit === 'all' || (opts.preference === 'webgl' && failInit === 'webgl')) {
        const err = new Error(`stub ${opts.preference} init failure`);
        throw err;
      }
      this.renderer.width = opts.width;
      this.renderer.height = opts.height;
    }
    destroy() { this.__destroyed = true; this.stage.__destroyed = true; }
  }

  return { __created: created, Application, Container, Sprite, Graphics, Text, Texture, Ticker, VERSION: '8.5.2-stub' };
}

function makeTextures(files) {
  const PIXI = stubPIXI();
  const textures = new Map();
  for (const file of files) textures.set(file, new PIXI.Texture(file));
  return { PIXI, textures };
}

const ALL_FRAME_FILES = [
  'assets/expressions/idle.png',
  'assets/expressions/working.png',
  'assets/expressions/finished.png',
  'assets/expressions/error.png',
  'assets/expressions/warning.png',
  'assets/animations/side/none/side-back.png',
  'assets/animations/side/none/side-left.png',
  'assets/animations/side/none/side-right.png',
  'assets/animations/walk/down/walk-down-01.png',
  'assets/animations/walk/up/walk-up-01.png',
  'assets/animations/walk/left/walk-left-01.png',
  'assets/animations/walk/right/walk-right-01.png',
];

function employeeSnapshot(overrides) {
  return {
    employeeId: 'coder',
    displayName: '编码员',
    role: '编码、文件、命令',
    presence: 'present',
    runtime: 'unbound',
    activity: 'roaming',
    movement: 'stationary',
    position: { x: 0.5, y: 0.6 },
    facing: 'down',
    seatNodeId: 'desk-3',
    binding: null,
    queueCount: 0,
    waiting: [],
    taskLabel: null,
    lastResult: null,
    marker: null,
    animation: { resource: 'idle', frameIndex: 0, fallbackReason: null },
    ...overrides,
  };
}

function baseSnapshot(employees, extra) {
  return {
    schemaVersion: 1,
    simulatedAtMs: 1234,
    sync: 'healthy',
    scene: { referenceWidth: VIEWPORT.width, referenceHeight: VIEWPORT.height },
    employees,
    activityLog: [],
    diagnostics: [],
    capabilities: { cancel: true, interrupt: true, followup: true, steer: true, inject: true, pause: false, resume: false, preempt: false },
    ...extra,
  };
}

async function createRenderer(PIXI, overrides = {}) {
  return officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    scene: { ...VIEWPORT },
    snapshot: baseSnapshot([
      employeeSnapshot(),
      employeeSnapshot({ employeeId: 'orchestrator', displayName: '调度员', role: '任务编排与分发', seatNodeId: 'desk-1', position: { x: 0.36, y: 0.495 } }),
      employeeSnapshot({ employeeId: 'researcher', displayName: '研究员', role: '资料检索与分析', seatNodeId: 'desk-2', position: { x: 0.56, y: 0.495 } }),
      employeeSnapshot({ employeeId: 'reviewer', displayName: '评审员', role: '代码与结果评审', seatNodeId: 'desk-4', position: { x: 0.36, y: 0.755 } }),
      employeeSnapshot({ employeeId: 'collaborator', displayName: '协作者', role: '动态协作者席位', seatNodeId: 'desk-5', position: { x: 0.56, y: 0.755 } }),
    ]),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// layout fixture (office-layout.json + office-layout.js)
// ---------------------------------------------------------------------------

test('canonical layout has exactly two rounded x columns and three y rows in row-major desk order', () => {
  assert.equal(LAYOUT_FIXTURE.schemaVersion, 1);
  assert.deepEqual(LAYOUT_FIXTURE.layout.grid, { columns: 2, rows: 3 });
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const desks = layout.desks();
  assert.equal(desks.length, 6, 'six workstations');
  for (let i = 0; i < 6; i += 1) assert.equal(desks[i].id, `desk-${i + 1}`);
  const xs = new Set(desks.map((desk) => Math.round(desk.position.x * 10)));
  const ys = new Set(desks.map((desk) => Math.round(desk.position.y * 10)));
  assert.equal(xs.size, 2);
  assert.equal(ys.size, 3);
  for (let index = 0; index < desks.length; index += 2) {
    assert.ok(desks[index].position.x < desks[index + 1].position.x, `row ${index / 2 + 1} is left to right`);
    if (index > 0) assert.ok(desks[index - 2].position.y < desks[index].position.y, 'rows are top to bottom');
  }
  // left-top extension reserve stays free of desks
  const reserve = layout.reserveZone();
  for (const desk of desks) {
    const inside = desk.position.x >= reserve.x && desk.position.x <= reserve.x + reserve.width
      && desk.position.y >= reserve.y && desk.position.y <= reserve.y + reserve.height;
    assert.ok(!inside, `${desk.id} must not intrude the left-top reserve zone`);
  }
});

test('canonical workstation anchors resolve to graph nodes and task routes reach connected leave aisles', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const workstations = layout.workstations();
  assert.equal(workstations.instances.length, 6);
  const adjacency = new Map(layout.nodes().map((node) => [node.id, []]));
  for (const edge of layout.edges().filter((candidate) => candidate.behaviors.includes('task'))) {
    adjacency.get(edge.from).push(edge.to);
    if (edge.bidirectional) adjacency.get(edge.to).push(edge.from);
  }
  const route = (from, to) => {
    const queue = [[from]];
    const seen = new Set([from]);
    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];
      if (current === to) return path;
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
      }
    }
    return null;
  };

  const roamingIds = layout.nodes().filter((node) => node.tags.includes('roaming') && /^roam-/.test(node.id)).map((node) => node.id);
  for (const instance of workstations.instances) {
    const seat = layout.nodeById(instance.seat.id);
    const approach = layout.nodeById(instance.approach.nodeId);
    const leave = layout.nodeById(instance.leave.nodeId);
    assert.ok(seat && approach && leave, `${instance.deskId} anchor references resolve`);
    assert.deepEqual(seat.position, instance.seat.position, `${instance.deskId} seat position is authoritative`);
    assert.deepEqual(approach.position, instance.approach.position, `${instance.deskId} approach position is authoritative`);
    assert.deepEqual(leave.position, instance.leave.position, `${instance.deskId} leave is a graph node, not a teleport point`);
    assert.ok(route(approach.id, leave.id), `${instance.deskId} task route reaches its leave aisle`);
    for (const roamingId of roamingIds) {
      const approachRoute = route(roamingId, approach.id);
      assert.ok(approachRoute, `${roamingId} reaches ${approach.id} using task edges`);
      assert.equal(
        approachRoute.some((nodeId) => /^desk-[1-6]$/.test(nodeId)),
        false,
        `${roamingId} reaches ${approach.id} before entering any seat`
      );
    }
  }
});

test('canonical workstation assets are represented by furniture and calibration characters are absent', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const workstations = layout.workstations();
  const assetIds = new Set(layout.furniture().map((item) => item.assetId).filter(Boolean));
  assert.equal(assetIds.has(workstations.template.desk.assetId), true);
  assert.equal(assetIds.has(workstations.template.monitor.assetId), true);
  assert.equal(assetIds.has(workstations.template.chair.assetId), true);
  assert.equal(layout.furniture().some((item) => item.kind === 'character'), false);
  // per-instance furniture offsets are covered by the Task 7A propagation
  // test (the approved desk-1 calibration applies to every workstation)
});

test('legacy schema-v1 fixtures without workstations keep structural validation', () => {
  const legacy = JSON.parse(JSON.stringify(LAYOUT_FIXTURE));
  delete legacy.workstations;
  legacy.layout.grid = { columns: 6, rows: 1 };
  assert.equal(officeLayout.validateOfficeLayout(legacy).ok, true);
});

test('desk assignments remain stable across the canonical layout migration', () => {
  assert.deepEqual(employeeProfiles.listResidentProfiles().map((profile) => profile.defaultSeat), [
    'desk-1', 'desk-2', 'desk-3', 'desk-4',
  ]);
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  for (const deskId of ['desk-1', 'desk-2', 'desk-3', 'desk-4']) {
    assert.ok(layout.nodeById(deskId).tags.includes('sleeping'));
  }
  assert.ok(layout.nodeById('desk-5').tags.includes('collaborator'));
  assert.ok(layout.nodeById('desk-6').tags.includes('spare'));
});

test('current layout contains no non-workstation furniture beyond the reserve marker', () => {
  const nonDeskFurniture = LAYOUT_FIXTURE.furniture.filter((item) => !item.id.startsWith('desk-'));
  assert.deepEqual(nonDeskFurniture.map((item) => item.id), ['reserve-zone-marker']);
});

test('every layout node declares position, footprint, safeRadius, tags and capacity', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  for (const node of layout.nodes()) {
    assert.ok(typeof node.id === 'string' && node.id, 'node id');
    assert.ok(node.position && node.position.x >= 0 && node.position.x <= 1, `${node.id} x in [0,1]`);
    assert.ok(node.position.y >= 0 && node.position.y <= 1, `${node.id} y in [0,1]`);
    assert.ok(node.footprint && node.footprint.width > 0 && node.footprint.height > 0, `${node.id} footprint`);
    assert.ok(typeof node.safeRadius === 'number' && node.safeRadius >= 0, `${node.id} safeRadius`);
    assert.ok(Array.isArray(node.tags) && node.tags.length > 0, `${node.id} tags`);
    assert.ok(Number.isInteger(node.capacity) && node.capacity >= 1, `${node.id} capacity`);
  }
  // resident desks sleep at their own seats; collaborator seat exists; desk-6 spare
  const tagsOf = (id) => layout.nodeById(id).tags;
  for (const id of ['desk-1', 'desk-2', 'desk-3', 'desk-4']) {
    assert.ok(tagsOf(id).includes('desk') && tagsOf(id).includes('sleeping'), `${id} desk+sleeping`);
  }
  assert.ok(tagsOf('desk-5').includes('collaborator'));
  assert.ok(tagsOf('desk-6').includes('spare'));
});

test('fixed layer order and explicit front occluders are declared by the fixture', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  assert.deepEqual(layout.layers(), [
    'background',
    'back-furniture',
    'ground-entities',
    'front-occluders',
    'effects-labels',
  ]);
  const occluders = layout.furniture().filter((f) => f.layer === 'front-occluders');
  assert.ok(occluders.length > 0, 'at least one explicit front occluder (desk fronts)');
  for (const item of layout.furniture()) {
    assert.ok(layout.layers().includes(item.layer), `${item.id} layer declared`);
    assert.ok(item.footprint && item.footprint.width > 0, `${item.id} footprint`);
  }
});

test('layout validation rejects broken fixtures', () => {
  assert.equal(officeLayout.validateOfficeLayout(LAYOUT_FIXTURE).ok, true);
  const broken = { ...LAYOUT_FIXTURE, schemaVersion: 99 };
  assert.equal(officeLayout.validateOfficeLayout(broken).ok, false);
  const noCapacity = JSON.parse(JSON.stringify(LAYOUT_FIXTURE));
  delete noCapacity.nodes[0].capacity;
  assert.equal(officeLayout.validateOfficeLayout(noCapacity).ok, false);
});

test('ground entities sort stably by (footY, layer, entityType, id)', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const entities = [
    { footY: 0.7, layer: 0, entityType: 'employee', id: 'orchestrator' },
    { footY: 0.3, layer: 0, entityType: 'employee', id: 'coder' },
    { footY: 0.3, layer: 0, entityType: 'employee', id: 'collaborator' },
    { footY: 0.5, layer: 0, entityType: 'employee', id: 'researcher' },
  ];
  const sorted = layout.sortGroundEntities(entities);
  assert.deepEqual(sorted.map((e) => e.id), ['coder', 'collaborator', 'researcher', 'orchestrator']);
  // stable: original order preserved for fully equal keys
  const tied = [
    { footY: 0.4, layer: 0, entityType: 'employee', id: 'b' },
    { footY: 0.4, layer: 0, entityType: 'employee', id: 'a' },
    { footY: 0.4, layer: 0, entityType: 'employee', id: 'a' },
  ];
  assert.deepEqual(layout.sortGroundEntities(tied).map((e) => e.id), ['a', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// renderer scene structure
// ---------------------------------------------------------------------------

test('renderer creates exactly one Pixi Application with fixed layer order', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  assert.equal(PIXI.__created.applications.length, 1, 'one Application');
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnosticCode, null);
  const layerIds = view.stage.children.map((c) => c.__layerId);
  assert.deepEqual(layerIds, ['background', 'back-furniture', 'ground-entities', 'front-occluders', 'effects-labels']);
  view.destroy();
  assert.equal(PIXI.__created.applications[0].__destroyed, true);
});

test('each employee keeps ONE persistent node; refresh swaps content, never recreates', async () => {
  const { PIXI, textures } = makeTextures(ALL_FRAME_FILES);
  const view = await createRenderer(PIXI, { textures });
  const before = view.entities.get('coder');
  assert.ok(before, 'entity container exists');
  const spriteBefore = before.__sprite;
  const spriteCountBefore = PIXI.__created.sprites.length;

  const moved = employeeSnapshot({
    employeeId: 'coder',
    activity: 'working',
    runtime: 'running',
    position: { x: 0.76, y: 0.495 },
    animation: { resource: 'working', frameIndex: 0, fallbackReason: null },
  });
  view.applySnapshot(baseSnapshot([moved]));

  const after = view.entities.get('coder');
  assert.equal(after, before, 'same Container instance after refresh');
  assert.equal(after.__sprite, spriteBefore, 'same Sprite instance after refresh');
  assert.equal(PIXI.__created.sprites.length, spriteCountBefore, 'no new sprite allocated');
  assert.equal(after.__sprite.texture.__id, 'assets/expressions/working.png', 'texture swapped in place');

  // selection refresh also must not recreate
  view.setSelection('coder');
  assert.equal(view.entities.get('coder'), before);
  view.destroy();
});

test('ground entities re-sort by (footY, layer, entityType, id) inside the layer', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  const ground = view.layers.groundEntities;
  view.applySnapshot(baseSnapshot([
    employeeSnapshot({ employeeId: 'orchestrator', position: { x: 0.2, y: 0.8 } }),
    employeeSnapshot({ employeeId: 'collaborator', position: { x: 0.3, y: 0.3 } }),
    employeeSnapshot({ employeeId: 'coder', position: { x: 0.4, y: 0.3 } }),
  ]));
  // coder and collaborator tie at footY 0.3 -> id order wins ('coder' < 'collaborator')
  assert.deepEqual(
    ground.children.map((c) => c.__employeeId),
    ['coder', 'collaborator', 'orchestrator']
  );
  view.destroy();
});

test('foot anchor projection and shared visibleHeight follow SPEC-02/03', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  const heights = new Set();
  for (const [id, entity] of view.entities) {
    const snap = entity.__snapshot;
    const scale = entity.__layout.scale;
    const footX = snap.position.x * VIEWPORT.width;
    const footY = snap.position.y * VIEWPORT.height;
    assert.ok(Math.abs(entity.__sprite.x + entity.__frameAnchor.x * scale - footX) < 1e-6, `${id} foot x anchor`);
    assert.ok(Math.abs(entity.__sprite.y + entity.__frameAnchor.y * scale - footY) < 1e-6, `${id} foot y anchor`);
    heights.add(entity.__layout.visibleHeight);
  }
  assert.equal(heights.size, 1, 'all employees share one visible height');
  const expected = Math.min(180, Math.max(64, VIEWPORT.height * 0.11));
  assert.equal([...heights][0], expected);
  view.destroy();
});

test('M4.1d: a snapshot bubble draws the speech bubble and clears with it', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    snapshot: baseSnapshot([employeeSnapshot({ bubble: { text: '咕噜~测试台词', topic: 'greeting', untilMs: 999999 } })]),
  });
  const record = view.entities.get('coder');
  assert.equal(record.__bubbleText.text, '咕噜~测试台词', 'the bubble text renders');
  assert.equal(record.__bubbleText.visible, true);
  assert.equal(record.__bubbleBg.visible, true);
  view.applySnapshot(baseSnapshot([employeeSnapshot({ bubble: null })]));
  assert.equal(record.__bubbleText.visible, false, 'the bubble hides when the snapshot clears it');
  assert.equal(record.__bubbleBg.visible, false);
  view.destroy();
});

test('missing pack/textures degrade to placeholder visuals with a stable fallback reason', async () => {
  const PIXI = stubPIXI();
  const view = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { ...VIEWPORT },
    snapshot: baseSnapshot([employeeSnapshot()]),
  });
  const entity = view.entities.get('coder');
  assert.ok(entity.__placeholder, 'placeholder body drawn when pack missing');
  assert.equal(entity.__fallbackReason != null, true, 'fallback reason recorded');
  view.destroy();
});

// ---------------------------------------------------------------------------
// fallback chain
// ---------------------------------------------------------------------------

test('WebGL failure falls back to Canvas renderer with a stable diagnostic code', async () => {
  const PIXI = stubPIXI({ failInit: 'webgl' });
  const view = await createRenderer(PIXI);
  assert.equal(view.mode, 'canvas');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED');
  assert.equal(PIXI.__created.applications.length, 2, 'exactly one retry application');
  assert.equal(PIXI.__created.applications[0].__destroyed, true, 'failed application destroyed');
  view.destroy();
});

test('total Pixi failure enters static diagnostic mode and never throws', async () => {
  const PIXI = stubPIXI({ failInit: 'all' });
  let fallbackEl = null;
  const view = await createRenderer(PIXI, {
    createFallbackElement: () => {
      fallbackEl = {
        tagName: 'DIV',
        className: '',
        dataset: {},
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this[`__attr-${name}`] = value; },
      };
      return fallbackEl;
    },
  });
  assert.equal(view.mode, 'static');
  assert.equal(view.app, null);
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED');
  assert.ok(fallbackEl, 'static fallback element created');
  assert.equal(fallbackEl.dataset.diagnosticCode, 'WEBGL_INIT_FAILED');
  // snapshots still apply so HTML details/log stay alive without animation
  view.applySnapshot(baseSnapshot([employeeSnapshot({ activity: 'working' })]));
  assert.equal(view.entities.get('coder').__snapshot.activity, 'working');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ticker discipline
// ---------------------------------------------------------------------------

test('renderer adds no logic ticker of its own (single main-process clock)', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  assert.equal(view.app.ticker.addCalls, 0, 'renderer drives nothing per frame');
  view.pause();
  assert.equal(view.isPaused(), true);
  assert.equal(view.app.ticker.started, false, 'pixi ticker stopped while hidden');
  view.resume();
  assert.equal(view.isPaused(), false);
  assert.equal(view.app.ticker.started, true);
  view.destroy();
});

// ---------------------------------------------------------------------------
// badges, markers, selection, hit testing
// ---------------------------------------------------------------------------

test('queue badge shows the waiting count on the effects layer and hides at zero', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  view.applySnapshot(baseSnapshot([
    employeeSnapshot({ employeeId: 'coder', queueCount: 3, waiting: [{ position: 1 }, { position: 2 }, { position: 3 }] }),
    employeeSnapshot({ employeeId: 'collaborator', displayName: '协作者', queueCount: 0 }),
  ]));
  const coder = view.entities.get('coder');
  assert.equal(coder.__badge.visible, true);
  assert.equal(coder.__badge.text, '3');
  const collab = view.entities.get('collaborator');
  assert.equal(collab.__badge.visible, false);
  view.destroy();
});

test('chat marker is a non-text ellipsis icon; sleeping shows the zzz marker', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  view.applySnapshot(baseSnapshot([
    employeeSnapshot({ employeeId: 'coder', activity: 'chatting', marker: 'chat-ellipsis' }),
    employeeSnapshot({ employeeId: 'researcher', displayName: '研究员', activity: 'sleeping', marker: 'sleep-zzz' }),
  ]));
  assert.equal(view.entities.get('coder').__marker.visible, true);
  assert.equal(view.entities.get('coder').__marker.text, '…');
  assert.equal(view.entities.get('researcher').__marker.text, 'Zzz');
  view.destroy();
});

test('selection ring is exclusive and hit testing resolves the nearest employee', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  view.setSelection('coder');
  for (const [id, entity] of view.entities) {
    assert.equal(entity.__selectionRing.visible, id === 'coder', `${id} ring state`);
  }
  view.setSelection(null);
  assert.equal(view.entities.get('coder').__selectionRing.visible, false);

  // 2026-10-30（用户："把脚下圆形交互区改成鲸鱼娘全身，不超过身体边界"）：
  // 命中判定从"以脚点为圆心的圆"改成"角色立绘的身体矩形"。
  // 这里验证三件事：脚部命中、**头部命中**（新能力）、身体外不命中。
  const coder = view.entities.get('coder');
  const box = coder.__bodyBox;
  assert.ok(box, 'the renderer records a body box per entity');
  const cx = (box.x0 + box.x1) / 2;
  assert.equal(view.hitTest(cx, box.y1 - 2), 'coder', 'hit at the feet resolves coder');
  assert.equal(view.hitTest(cx, (box.y0 + box.y1) / 2), 'coder', 'hit at mid-body resolves coder');
  assert.equal(view.hitTest(cx, box.y0 + 3), 'coder', 'hit at the HEAD resolves coder (new behaviour)');
  assert.equal(view.hitTest(box.x0 - 6, (box.y0 + box.y1) / 2), null, 'just outside the body edge misses');
  assert.equal(view.hitTest(box.x1 + 6, (box.y0 + box.y1) / 2), null, 'just outside the other edge misses');
  const miss = view.hitTest(2, 2);
  assert.equal(miss, null, 'far corner hits nobody');
  view.destroy();
});

// ---------------------------------------------------------------------------
// resource lifecycle
// ---------------------------------------------------------------------------

test('destroy releases view-owned textures and the application exactly once', async () => {
  const { PIXI, textures } = makeTextures(ALL_FRAME_FILES);
  const view = await createRenderer(PIXI, { textures });
  const sprite = view.entities.get('coder').__sprite;
  view.destroy();
  assert.equal(view.__destroyed, true);
  for (const texture of textures.values()) {
    assert.equal(texture.__destroyed, true, `texture ${texture.__id} released`);
  }
  assert.equal(sprite.__destroyed, true, 'entity sprite destroyed');
  // double destroy is a safe no-op
  view.destroy();
});

test('renderer module consumes snapshots only: no Harness, ipcRenderer or fetch imports', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'office', 'render', 'pixi-office-renderer.js'), 'utf8');
  assert.equal(/require\((['"]).*(harness|electron|ipc|http).*\1\)/.test(source), false, 'no harness/electron/ipc imports');
  assert.equal(/\bfetch\s*\(/.test(source), false, 'no network fetch');
  assert.equal(/XMLHttpRequest/.test(source), false, 'no XHR');
  assert.equal(/https?:\/\//.test(source.replace(/\/\/[^\n]*/g, '')), false, 'no hard-coded network URLs');
});

// ---------------------------------------------------------------------------
// Task 3 — golden workstation: managed furniture textures
// ---------------------------------------------------------------------------

const OFFICE_ASSET_IDS = ['prop-desk-back-right-top', 'prop-monitor-back-right-top', 'prop-chair-front-left-top'];

function makeOfficeTextures(PIXI, sizes = {}) {
  const officeTextures = new Map();
  for (const assetId of OFFICE_ASSET_IDS) {
    const [width, height] = sizes[assetId] || [640, 360];
    officeTextures.set(assetId, new PIXI.Texture(assetId, width, height));
  }
  return officeTextures;
}

function furnitureSprite(view, layer, id) {
  return view.layers[layer].children.find((child) => child.__furnitureId === id);
}

test('the approved desk-1 calibration propagates to every workstation', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const workstations = layout.workstations();
  const instance = workstations.instances[0];
  // calibrated offsets are derived from the approved desk-1 rects themselves
  const calibrated = {};
  for (const kind of ['monitor', 'chair']) {
    const rect = Object.values(layout.furniture().find((c) => c.id === `desk-1-${kind}`).parts)[0];
    calibrated[kind] = {
      dx: rect.x + rect.width / 2 - instance.position.x,
      dy: rect.y + rect.height / 2 - instance.position.y,
      width: rect.width,
    };
  }
  for (const inst of workstations.instances.slice(1)) {
    for (const kind of ['monitor', 'chair']) {
      const rect = Object.values(layout.furniture().find((c) => c.id === `${inst.deskId}-${kind}`).parts)[0];
      const dx = rect.x + rect.width / 2 - inst.position.x;
      const dy = rect.y + rect.height / 2 - inst.position.y;
      assert.ok(Math.abs(dx - calibrated[kind].dx) < 1e-9, `${inst.deskId}-${kind} x offset matches the approved calibration`);
      assert.ok(Math.abs(dy - calibrated[kind].dy) < 1e-9, `${inst.deskId}-${kind} y offset matches the approved calibration`);
      assert.equal(rect.width, calibrated[kind].width, `${inst.deskId}-${kind} shares the calibrated scale`);
    }
  }
});

test('every workstation ships complete furniture and resolvable anchors', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  for (const deskId of ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6']) {
    for (const part of ['back', 'front', 'monitor', 'chair']) {
      const item = layout.furniture().find((candidate) => candidate.id === `${deskId}-${part}`);
      assert.ok(item, `${deskId}-${part} furniture exists`);
      const rect = Object.values(item.parts)[0];
      assert.ok(rect.x >= 0 && rect.x + rect.width <= 1 && rect.y >= 0 && rect.y + rect.height <= 1, `${deskId}-${part} inside the scene`);
    }
    const instance = layout.workstation(deskId);
    assert.ok(layout.nodeById(instance.seat.id), `${deskId} seat resolves`);
    assert.ok(layout.nodeById(instance.approach.nodeId), `${deskId} approach resolves`);
    assert.ok(layout.nodeById(instance.leave.nodeId), `${deskId} leave resolves`);
  }
});

test('every front occluder mirrors its own desk back and covers only its own seat', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const workstations = layout.workstations();
  for (const instance of workstations.instances) {
    const back = layout.furniture().find((c) => c.id === `${instance.deskId}-back`);
    const front = layout.furniture().find((c) => c.id === `${instance.deskId}-front`);
    assert.equal(front.parts.front.x, back.parts.back.x, `${instance.deskId} front mirrors back x`);
    assert.ok(Math.abs(front.parts.front.y - (back.parts.back.y + 0.035)) < 1e-9, `${instance.deskId} front band follows back`);
    // own seat inside the occluder box, other seats outside
    const rect = front.parts.front;
    const own = layout.nodeById(instance.seat.id).position;
    assert.ok(own.x >= rect.x && own.x <= rect.x + rect.width, `${instance.deskId} covers its own seat x`);
    for (const other of workstations.instances) {
      if (other.deskId === instance.deskId) continue;
      const seat = layout.nodeById(other.seat.id).position;
      const coversOther = seat.x >= rect.x && seat.x <= rect.x + rect.width
        && seat.y >= rect.y - 0.06 && seat.y <= rect.y + rect.height + 0.06;
      assert.equal(coversOther, false, `${instance.deskId} front must not cover ${other.deskId} seat`);
    }
  }
});

test('selection ring lives on the topmost interaction layer, never under desk fronts', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  const ring = view.entities.get('coder').__selectionRing;
  assert.equal(ring.parent && ring.parent.__layerId, 'effects-labels',
    'the selection ring is an interaction-overlay node on the TOP layer — desk-front occluders must never paint over it');
  view.setSelection('coder');
  assert.equal(ring.visible, true, 'ring still tracks selection on the top layer');
  view.destroy();
});

test('each desk-front occluder locks to the RENDERED rect: only its own character box is covered (no cross-desk occlusion)', () => {
  // Task 9-R1: the occluder rect must come from the RENDERER's source —
  // layoutFurniture draws a *-front item at `record.mirrorRect || record.rect`
  // (pixi-office-renderer.js layoutFurniture), i.e. the CORRESPONDING -back
  // parts rect, never parts.front. The character box is the pack's real
  // projected content box: pack-level visibleBounds scaled by
  // visibleHeight / visibleBounds.height and positioned from the seat point
  // via the frame outputAnchor (sprite top-left = foot - anchor * scale,
  // content offset += visibleBounds.xy * scale — the renderer's exact
  // updateEntity projection).
  const packRoot = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
  const productionPack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'animations.json'), 'utf8')),
  });
  assert.equal(productionPack.ok, true, 'production pack geometry loads');
  const visibleBounds = productionPack.pack.geometry.visibleBounds; // {x:6, y:41, width:319, height:277}
  const anchor = productionPack.pack.geometry.anchor; // {x:178, y:296}

  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const furnitureById = new Map(layout.furniture().map((item) => [item.id, item]));
  const seats = [...layout.nodes().filter((node) => node.tags.includes('desk'))];
  assert.equal(seats.length, 6, 'six seat nodes');

  const SCENE = { width: LAYOUT_FIXTURE.scene.referenceWidth, height: LAYOUT_FIXTURE.scene.referenceHeight };
  const visibleHeight = Math.min(180, Math.max(64, Math.round(SCENE.height * 0.11 * 100) / 100)); // computeVisibleHeight
  const charScale = visibleHeight / visibleBounds.height;

  // renderer character content box for a character whose foot sits at the seat point
  const characterBoxAt = (node) => ({
    x: node.position.x * SCENE.width + (visibleBounds.x - anchor.x) * charScale,
    y: node.position.y * SCENE.height + (visibleBounds.y - anchor.y) * charScale,
    width: visibleBounds.width * charScale,
    height: visibleBounds.height * charScale,
  });
  const px = (rect) => ({
    x: rect.x * SCENE.width,
    y: rect.y * SCENE.height,
    width: rect.width * SCENE.width,
    height: rect.height * SCENE.height,
  });
  const intersects = (a, b) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  const perDesk = {};
  for (let deskIndex = 1; deskIndex <= 6; deskIndex += 1) {
    const deskId = `desk-${deskIndex}`;
    const frontItem = furnitureById.get(`${deskId}-front`);
    const backItem = furnitureById.get(`${deskId}-back`);
    assert.ok(frontItem && backItem, `${deskId} declares both -back and -front items`);

    // THE rect the renderer actually draws the occluder sprite at: the -back
    // parts rect (mirrorRect source). Guard the source: the -back rect must
    // genuinely differ from parts.front, otherwise this test could silently
    // degrade back to testing the wrong rect.
    assert.ok(backItem.parts.back, `${deskId}-back declares a back part rect`);
    assert.ok(frontItem.parts.front, `${deskId}-front declares a front part rect`);
    assert.notDeepEqual(backItem.parts.back, frontItem.parts.front,
      `${deskId}: the -back rect genuinely differs from parts.front — the source guard has teeth`);

    const occluderRect = px(backItem.parts.back);
    const ownBox = characterBoxAt(seats.find((node) => node.id === deskId));
    const ownOverlap = intersects(occluderRect, ownBox);
    const crossIds = [];
    for (const node of seats) {
      if (node.id === deskId) continue;
      if (intersects(occluderRect, characterBoxAt(node))) crossIds.push(node.id);
    }
    assert.equal(ownOverlap, true,
      `${deskId}-front (drawn at the -back rect) occludes its OWN character box (occlusion mechanism exists)`);
    assert.deepEqual(crossIds, [],
      `${deskId}-front must never overlap any other workstation's character box`);
    perDesk[deskId] = {
      occluderRectPx: { x: Math.round(occluderRect.x), y: Math.round(occluderRect.y), w: Math.round(occluderRect.width), h: Math.round(occluderRect.height) },
      ownCharBoxPx: { x: Math.round(ownBox.x), y: Math.round(ownBox.y), w: Math.round(ownBox.width), h: Math.round(ownBox.height) },
      ownIntersects: ownOverlap,
      crossIntersections: crossIds,
    };
  }
  assert.equal(Object.keys(perDesk).length, 6, 'all six desks evaluated with per-desk evidence');
});

// ---------------------------------------------------------------------------
// Task E4 — flat layout furniture rendering (contentBbox viewport fit, draft
// depth order, props textured from the shared catalog).
//
// RED: the renderer still fits every sprite by texture center and ignores
// the draft depth; the flat fixture's items carry assetId/parts.main/depth.
// ---------------------------------------------------------------------------

const FLAT_LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
);
const { LAYOUT_ASSETS: E4_LAYOUT_ASSETS } = require('../src/office/layout-assets.js');

function flatOfficeTextures(PIXI) {
  const officeTextures = new Map();
  for (const assetId of [...new Set(FLAT_LAYOUT_FIXTURE.furniture.map((item) => item.assetId))]) {
    officeTextures.set(assetId, new PIXI.Texture(assetId, 1024, 1024));
  }
  return officeTextures;
}

test('E5a-R2: the renderer honours the composed character height ratio with clamps', async () => {
  const PIXI = stubPIXI();
  const composed = await createRenderer(PIXI, {
    snapshot: baseSnapshot([employeeSnapshot({ presentation: { heightRatio: 1.6201 } })]),
  });
  const entity = composed.entities.get('coder');
  assert.ok(entity, 'the composed entity exists');
  const expected = Math.min(180, Math.max(64, 92.4 * 1.6201));
  assert.ok(Math.abs(entity.__layout.visibleHeight - expected) < 0.01,
    `visibleHeight ${entity.__layout.visibleHeight} ~ ${expected}`);
  composed.destroy();

  const clampedUp = await createRenderer(PIXI, {
    snapshot: baseSnapshot([employeeSnapshot({ presentation: { heightRatio: 4 } })]),
  });
  assert.equal(clampedUp.entities.get('coder').__layout.visibleHeight, 180, 'the upper clamp holds');
  clampedUp.destroy();

  const clampedDown = await createRenderer(PIXI, {
    snapshot: baseSnapshot([employeeSnapshot({ presentation: { heightRatio: 0.2 } })]),
  });
  assert.equal(clampedDown.entities.get('coder').__layout.visibleHeight, 64, 'the lower clamp holds');
  clampedDown.destroy();

  const plain = await createRenderer(PIXI);
  assert.ok(Math.abs(plain.entities.get('coder').__layout.visibleHeight - 92.4) < 0.01,
    'no presentation means the default height');
  plain.destroy();
});
