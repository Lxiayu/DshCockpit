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

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
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

test('placeholder furniture is drawn from fixture geometry into declared layers', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  const backOps = view.layers.backFurniture.children.filter((c) => c.__kind === 'Graphics');
  const frontOps = view.layers.frontOccluders.children.filter((c) => c.__kind === 'Graphics');
  assert.ok(backOps.length >= 6, 'desk backs drawn in back furniture');
  assert.ok(frontOps.length >= 6, 'desk fronts drawn as explicit occluders');
  // deterministic: same fixture -> same op count
  const first = backOps[0].__ops.length;
  view.destroy();
  const PIXI2 = stubPIXI();
  const view2 = await createRenderer(PIXI2);
  assert.equal(view2.layers.backFurniture.children.filter((c) => c.__kind === 'Graphics')[0].__ops.length, first);
  view2.destroy();
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

test('M4.1c: flat furniture and characters share one painter order — walkers pass over stations, seated bodies sit behind', async () => {
  const PIXI = stubPIXI();
  const flat = (overrides = {}) => officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    officeTextures: flatOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
    ...overrides,
  });
  const deskRect = FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === 'desk-1-back').parts.back;
  const chairRect = FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === 'desk-1-chair').parts.front;
  const deskBottom = deskRect.y + deskRect.height;
  const chairBottom = chairRect.y + chairRect.height;
  const view = await flat();
  view.applySnapshot(baseSnapshot([
    // a walker in the corridor BELOW the desk row (footY beyond the bottom edge)
    employeeSnapshot({ employeeId: 'orchestrator', position: { x: 0.6, y: Math.min(0.99, deskBottom + 0.08) } }),
    // a seated body at the desk, ABOVE the chair's bottom edge (chair occludes)
    employeeSnapshot({ employeeId: 'researcher', position: { x: 0.6, y: Math.max(0.05, chairBottom - 0.05) } }),
  ]));
  const ground = view.layers.groundEntities;
  const order = ground.children.map((child) => child.__furnitureId || child.__employeeId);
  const deskAt = order.indexOf('desk-1-back');
  const chairAt = order.indexOf('desk-1-chair');
  const walkerAt = order.indexOf('orchestrator');
  const seatedAt = order.indexOf('researcher');
  assert.ok(deskAt !== -1 && chairAt !== -1 && walkerAt !== -1 && seatedAt !== -1, `all four present (${order.join(',')})`);
  assert.ok(walkerAt > deskAt, 'the corridor walker draws AFTER the desk (on top of the station)');
  assert.ok(seatedAt < chairAt, 'the seated body draws BEFORE the chair (occluded by the chair back)');
  // The painted sequence itself is the invariant: one ascending key list in
  // scene px (furniture bottom edge / character foot y).
  const paint = view.groundPaintOrder();
  assert.equal(paint.length, ground.children.length, 'the recorded order is the real children order');
  for (let i = 1; i < paint.length; i += 1) {
    assert.ok(paint[i - 1].key <= paint[i].key, `painter keys ascend: ${paint[i - 1].id} <= ${paint[i].id}`);
  }
  assert.equal(paint.filter((entry) => entry.kind === 'character').length, 2, 'both characters are in the merged pass');
  assert.ok(paint.filter((entry) => entry.kind === 'furniture').length >= 32,
    `all flat furniture is in the merged pass (${paint.filter((entry) => entry.kind === 'furniture').length})`);
  const charKeys = paint.filter((entry) => entry.kind === 'character').map((entry) => entry.id);
  assert.deepEqual(charKeys, ['researcher', 'orchestrator'], 'characters interleave by foot y, not by insertion order');
  view.destroy();
});

test('M4.1h: a seated character paints ABOVE her workstation desk body and BELOW its chair (user-reported desk-over-whale-girl bug)', async () => {
  // 用户实测（2026-09-22，真机截图）：鲸鱼娘坐在自己工位（working/sleeping 等坐姿）时，
  // 工位桌子的图层压在她上面（截图里中间排 desk-4 被整张桌子盖住）。根因：坐姿角色的
  // 排序键是脚点（座位锚点），而锚点恰好落在桌体底边附近——bundled-flat 布局里 desk-4
  // 的座位点甚至比桌体底边还高 3~5px，纯底边 painter 排序于是让不透明桌体盖住角色。
  // 修复（pixi-office-renderer.js sortGround，与 prop 的"支撑物+0.5"同一机制）：
  // 脚点落在工位带（桌体 x 跨度 × 桌体顶边→椅子底边）内的角色，按键重挂到该工位的
  // 堆叠键（桌体/显示器/桌面上家具底边最大值）+ 0.5，只升不降。本用例把六个工位全部
  // 坐满，逐个断言键序；pre-fix 代码在 desk-4 上必红（desk-4-back 键高于座位脚点）。
  const PIXI = stubPIXI();
  const flat = () => officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    officeTextures: flatOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
  });
  const layout = officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE);
  const seated = [
    { employeeId: 'orchestrator', deskId: 'desk-1' },
    { employeeId: 'researcher', deskId: 'desk-2' },
    { employeeId: 'coder', deskId: 'desk-3' },
    { employeeId: 'reviewer', deskId: 'desk-4' },
    { employeeId: 'collaborator', deskId: 'desk-5' },
    { employeeId: 'companion', deskId: 'desk-6' },
  ];
  const view = await flat();
  view.applySnapshot(baseSnapshot(seated.map(({ employeeId, deskId }, index) => employeeSnapshot({
    employeeId,
    seatNodeId: deskId,
    position: { ...layout.nodeById(deskId).position },
    activity: index % 2 === 0 ? 'working' : 'sleeping',
    animation: { resource: index % 2 === 0 ? 'working' : 'sleeping', frameIndex: 0, fallbackReason: null },
  }))));

  const paint = view.groundPaintOrder();
  const keyOf = (id) => {
    const entry = paint.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is in the merged geometric pass`);
    return entry.key;
  };
  // 断言①：坐姿角色的绘制键 > 自己工位桌体（与显示器）的键 —— 桌面/显示器不再盖住她。
  // 断言②：且 < 自己工位椅子的键 —— 椅背照旧遮住她的下半身（既有契约保持）。
  for (const { employeeId, deskId } of seated) {
    const charKey = keyOf(employeeId);
    const backKey = keyOf(`${deskId}-back`);
    const monitorKey = keyOf(`${deskId}-monitor`);
    const chairKey = keyOf(`${deskId}-chair`);
    assert.ok(charKey > backKey,
      `${employeeId}@${deskId} paints above her desk body (char ${charKey.toFixed(1)} > back ${backKey.toFixed(1)})`);
    assert.ok(charKey > monitorKey,
      `${employeeId}@${deskId} paints above her monitor (char ${charKey.toFixed(1)} > monitor ${monitorKey.toFixed(1)})`);
    assert.ok(charKey < chairKey,
      `${employeeId}@${deskId} still sits behind her chair back (char ${charKey.toFixed(1)} < chair ${chairKey.toFixed(1)})`);
    // 重挂只升不降：修好的键永远不会低于脚点本身。
    const footKey = layout.nodeById(deskId).position.y * VIEWPORT.height;
    assert.ok(charKey >= footKey - 1e-9,
      `${employeeId}@${deskId} re-key is raise-only (char ${charKey.toFixed(1)} >= foot ${footKey.toFixed(1)})`);
  }
  // 场景图顺序与记录键一致：角色在桌体之后、椅子之前（真正的 children 先后）。
  const order = view.layers.groundEntities.children.map((child) => child.__furnitureId || child.__employeeId);
  for (const { employeeId, deskId } of seated) {
    assert.ok(order.indexOf(employeeId) > order.indexOf(`${deskId}-back`),
      `${employeeId} mounts after ${deskId}-back in ground-entities`);
    assert.ok(order.indexOf(employeeId) < order.indexOf(`${deskId}-chair`),
      `${employeeId} mounts before ${deskId}-chair in ground-entities`);
  }
  // 记录的 painter 键严格递增（合并排序的不变量）。
  for (let i = 1; i < paint.length; i += 1) {
    assert.ok(paint[i - 1].key <= paint[i].key,
      `painter keys ascend: ${paint[i - 1].id}(${paint[i - 1].key.toFixed(1)}) <= ${paint[i].id}(${paint[i].key.toFixed(1)})`);
  }
  view.destroy();

  // 两条既有契约在同一张场景里复核：
  //  (a) 走廊行人（脚点在椅底更下方）仍盖住整张工位；
  //  (b) 从桌后绕行的角色（脚点在桌体顶边之上、桌体 x 跨度内）仍被桌子盖住。
  const view2 = await flat();
  const deskBack = FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === 'desk-1-back').parts.back;
  const chairRect = FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === 'desk-1-chair').parts.front;
  const walker = employeeSnapshot({
    employeeId: 'walker',
    position: { x: 0.6, y: Math.min(0.99, chairRect.y + chairRect.height + 0.08) },
  });
  const behindWalker = employeeSnapshot({
    employeeId: 'behind',
    position: { x: deskBack.x + deskBack.width / 2, y: Math.max(0.02, deskBack.y - 0.02) },
  });
  view2.applySnapshot(baseSnapshot([
    ...seated.map(({ employeeId, deskId }) => employeeSnapshot({
      employeeId,
      seatNodeId: deskId,
      position: { ...layout.nodeById(deskId).position },
      activity: 'working',
      animation: { resource: 'working', frameIndex: 0, fallbackReason: null },
    })),
    walker,
    behindWalker,
  ]));
  const paint2 = view2.groundPaintOrder();
  const order2 = view2.layers.groundEntities.children.map((child) => child.__furnitureId || child.__employeeId);
  const idx2 = (id) => {
    const at = order2.indexOf(id);
    assert.ok(at !== -1, `${id} present`);
    return at;
  };
  assert.ok(idx2('walker') > idx2('desk-1-back'),
    'the corridor walker still draws AFTER the desk (on top of the station)');
  assert.ok(idx2('behind') < idx2('desk-1-back'),
    'a body passing behind the desk row is still occluded by the desk body');
  for (const { employeeId, deskId } of seated) {
    assert.ok(idx2(employeeId) > idx2(`${deskId}-back`), `${employeeId} still above her desk body`);
    assert.ok(idx2(employeeId) < idx2(`${deskId}-chair`), `${employeeId} still below her chair`);
  }
  for (let i = 1; i < paint2.length; i += 1) {
    assert.ok(paint2[i - 1].key <= paint2[i].key, `painter keys ascend: ${paint2[i - 1].id} <= ${paint2[i].id}`);
  }
  view2.destroy();

  // 退化草稿复核：把 desk-4 的椅子底边抬到"座位脚点之上、桌体底边之下 1px"——
  // 此时 min(堆叠键 + 0.5, 椅子键 - 0.5) 必须贴椅子键 - 0.5 取值：角色仍然被抬升
  // （只升不降）、且恒 < 椅子键——"seated bodies sit behind"契约不依赖草稿摆得好不好。
  const degenerate = JSON.parse(JSON.stringify(FLAT_LAYOUT_FIXTURE));
  const dChair = degenerate.furniture.find((item) => item.id === 'desk-4-chair').parts.front;
  const dBack = degenerate.furniture.find((item) => item.id === 'desk-4-back').parts.back;
  dChair.y = dBack.y + dBack.height - dChair.height - 1 / VIEWPORT.height; // 底边 = 桌体底边 - 1px
  const degenerateLayout = officeLayout.createOfficeLayout(degenerate);
  const view3 = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: degenerateLayout,
    pack: PACK,
    textures: new Map(),
    officeTextures: flatOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
  });
  view3.applySnapshot(baseSnapshot([employeeSnapshot({
    employeeId: 'reviewer',
    seatNodeId: 'desk-4',
    position: { ...degenerateLayout.nodeById('desk-4').position },
    activity: 'working',
    animation: { resource: 'working', frameIndex: 0, fallbackReason: null },
  })]));
  const paint3 = view3.groundPaintOrder();
  const key3 = (id) => {
    const entry = paint3.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is in the merged geometric pass`);
    return entry.key;
  };
  const charKey3 = key3('reviewer');
  const backKey3 = key3('desk-4-back');
  const chairKey3 = key3('desk-4-chair');
  const footKey3 = degenerateLayout.nodeById('desk-4').position.y * VIEWPORT.height;
  assert.ok(Math.abs(charKey3 - (chairKey3 - 0.5)) < 1e-9,
    `a draft with the chair raised to the desk bottom binds the re-key to chair - 0.5 (char ${charKey3.toFixed(2)} == chair ${chairKey3.toFixed(2)} - 0.5)`);
  assert.ok(charKey3 < chairKey3, 'degenerate draft still keeps the seated body behind her chair');
  assert.ok(charKey3 >= footKey3, `degenerate re-key is raise-only (char ${charKey3.toFixed(2)} >= foot ${footKey3.toFixed(2)})`);
  assert.ok(chairKey3 < backKey3, 'the degenerate fixture really does place the chair above the desk bottom');
  view3.destroy();
});

test('resize reprojects anchors and clamped visible height without touching logic', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI);
  const entity = view.entities.get('coder');
  const logical = { ...entity.__snapshot.position };
  const deskBackBefore = view.layers.backFurniture.children[0].__ops.slice();
  view.resize({ width: 640, height: 480 });
  const scale = entity.__layout.scale;
  const deskBackAfter = view.layers.backFurniture.children[0].__ops;
  assert.notDeepEqual(deskBackAfter, deskBackBefore, 'furniture reprojects to the new scene size');
  assert.ok(view.layers.backFurniture.children.length >= 6, 'furniture rebuilt after resize');
  const expectedHeight = Math.min(180, Math.max(64, 480 * 0.11));
  assert.equal(entity.__layout.visibleHeight, expectedHeight, 'clamped to 64px minimum');
  const footX = logical.x * 640;
  const footY = logical.y * 480;
  assert.ok(Math.abs(entity.__sprite.x + entity.__frameAnchor.x * scale - footX) < 1e-6);
  assert.ok(Math.abs(entity.__sprite.y + entity.__frameAnchor.y * scale - footY) < 1e-6);
  assert.equal(view.app.renderer.width, 640);
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

  const hit = view.hitTest(0.5 * VIEWPORT.width + 4, 0.6 * VIEWPORT.height + 4);
  assert.equal(hit, 'coder', 'hit near the coder foot resolves coder');
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

test('textured workstation renders sprite furniture with explicit back/main/front roles', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    officeTextures: makeOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1'],
  });
  const desk1Back = furnitureSprite(view, 'backFurniture', 'desk-1-back');
  const desk1Monitor = furnitureSprite(view, 'backFurniture', 'desk-1-monitor');
  const desk1Chair = furnitureSprite(view, 'backFurniture', 'desk-1-chair');
  const desk1Front = furnitureSprite(view, 'frontOccluders', 'desk-1-front');
  assert.equal(desk1Back.__kind, 'Sprite', 'desk-1 back is a real sprite');
  assert.equal(desk1Back.texture.__id, 'prop-desk-back-right-top');
  assert.equal(desk1Back.__furnitureRole, 'main');
  assert.equal(desk1Monitor.__kind, 'Sprite');
  assert.equal(desk1Monitor.texture.__id, 'prop-monitor-back-right-top');
  assert.equal(desk1Monitor.__furnitureRole, 'back');
  assert.equal(desk1Chair.__kind, 'Sprite');
  assert.equal(desk1Chair.texture.__id, 'prop-chair-front-left-top');
  assert.equal(desk1Chair.__furnitureRole, 'back');
  assert.equal(desk1Front.__kind, 'Sprite', 'desk-1 front occluder is a real sprite');
  assert.equal(desk1Front.texture.__id, 'prop-desk-back-right-top');
  assert.equal(desk1Front.__furnitureRole, 'front');
  assert.ok(
    Math.abs(desk1Front.x - desk1Back.x) < 1e-6 && Math.abs(desk1Front.y - desk1Back.y) < 1e-6,
    'the textured front occluder mirrors the desk body so the desk reads as one piece'
  );
  // un-calibrated workstations stay on the reversible placeholder path
  assert.equal(furnitureSprite(view, 'backFurniture', 'desk-2-back').__kind, 'Graphics');
  assert.equal(furnitureSprite(view, 'frontOccluders', 'desk-2-front').__kind, 'Graphics');

  // explicit paint order: desk body (main) under monitor/chair (back); occluders live in the front layer
  const paintOrder = view.furniturePaintOrder();
  assert.deepEqual(
    paintOrder.filter((entry) => entry.layer === 'back-furniture').map((entry) => entry.role),
    [...Array(6).fill('main'), ...Array(12).fill('back')]
  );
  for (const entry of paintOrder) {
    assert.equal(entry.role === 'front', entry.layer === 'front-occluders', `${entry.id} role matches its layer`);
  }
  assert.equal(paintOrder.filter((entry) => entry.role === 'front').length, 6);

  // sprite transforms: uniform scale from the rect width, texture center on
  // the rect center (aspect preserved, no squash)
  const item = LAYOUT_FIXTURE.furniture.find((candidate) => candidate.id === 'desk-1-monitor');
  const rect = item.parts.back;
  const expectedScale = (rect.width * VIEWPORT.width) / desk1Monitor.texture.width;
  assert.ok(Math.abs(desk1Monitor.x - (rect.x + rect.width / 2) * VIEWPORT.width) < 1e-6, 'sprite centered on the fixture rect x');
  assert.ok(Math.abs(desk1Monitor.y - (rect.y + rect.height / 2) * VIEWPORT.height) < 1e-6, 'sprite centered on the fixture rect y');
  assert.ok(Math.abs(desk1Monitor.scale.x - expectedScale) < 1e-9, 'uniform scale fits the rect width');
  assert.ok(Math.abs(desk1Monitor.scale.y - desk1Monitor.scale.x) < 1e-12, 'aspect is preserved');
  view.destroy();
});

test('resize keeps furniture sprite identity and only updates transforms', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    officeTextures: makeOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1'],
  });
  const spriteBefore = furnitureSprite(view, 'backFurniture', 'desk-1-monitor');
  const xBefore = spriteBefore.x;
  const scaleXBefore = spriteBefore.scale.x;
  const spriteCountBefore = PIXI.__created.sprites.length;
  view.resize({ width: 640, height: 480 });
  const spriteAfter = furnitureSprite(view, 'backFurniture', 'desk-1-monitor');
  assert.equal(spriteAfter, spriteBefore, 'same sprite node after resize');
  assert.equal(PIXI.__created.sprites.length, spriteCountBefore, 'resize allocates no new furniture sprites');
  assert.notEqual(spriteAfter.x, xBefore, 'position reprojects');
  assert.ok(spriteAfter.scale.x < scaleXBefore, 'scale reprojects');
  view.destroy();
});

test('missing office textures keep placeholders and report OFFICE_TEXTURE_MISSING', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    officeTextures: new Map(),
    texturedWorkstations: ['desk-1'],
    officeTextureErrors: [
      { assetId: 'prop-desk-back-right-top', code: 'OFFICE_TEXTURE_MISSING', reason: 'IMAGE_DECODE_FAILED' },
    ],
  });
  const desk1Back = furnitureSprite(view, 'backFurniture', 'desk-1-back');
  assert.equal(desk1Back.__kind, 'Graphics', 'diagnostic fallback, never a blank-texture sprite');
  const diagnostics = view.officeDiagnostics();
  assert.equal(diagnostics.code, 'OFFICE_TEXTURE_MISSING');
  const entry = diagnostics.missing.find((candidate) => candidate.furnitureId === 'desk-1-back');
  assert.ok(entry, 'desk-1-back reported missing');
  assert.equal(entry.code, 'OFFICE_TEXTURE_MISSING');
  assert.equal(entry.assetId, 'prop-desk-back-right-top');
  assert.equal(entry.reason, 'IMAGE_DECODE_FAILED', 'loader failure reasons surface');
  view.destroy();

  const plainPIXI = stubPIXI();
  const plain = await createRenderer(plainPIXI);
  assert.equal(plain.officeDiagnostics().code, null, 'intentional placeholders are not texture failures');
  plain.destroy();
});

test('blank office textures are rejected as missing instead of rendering empty sprites', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    officeTextures: makeOfficeTextures(PIXI, { 'prop-desk-back-right-top': [0, 0] }),
    texturedWorkstations: ['desk-1'],
  });
  const desk1Back = furnitureSprite(view, 'backFurniture', 'desk-1-back');
  assert.equal(desk1Back.__kind, 'Graphics');
  const entry = view.officeDiagnostics().missing.find((candidate) => candidate.furnitureId === 'desk-1-back');
  assert.equal(entry.reason, 'TEXTURE_INVALID');
  view.destroy();
});

test('destroying one office view leaves another view’s furniture textures and sprites valid', async () => {
  const pixiA = stubPIXI();
  const pixiB = stubPIXI();
  const texturesA = makeOfficeTextures(pixiA);
  const texturesB = makeOfficeTextures(pixiB);
  const viewA = await createRenderer(pixiA, { officeTextures: texturesA, texturedWorkstations: ['desk-1'] });
  const viewB = await createRenderer(pixiB, { officeTextures: texturesB, texturedWorkstations: ['desk-1'] });
  const spriteB = furnitureSprite(viewB, 'backFurniture', 'desk-1-back');

  viewA.destroy();
  for (const texture of texturesA.values()) {
    assert.equal(texture.__destroyed, true, `view A released ${texture.__id}`);
  }
  for (const texture of texturesB.values()) {
    assert.equal(texture.__destroyed, false, `view B keeps ${texture.__id}`);
  }
  assert.equal(spriteB.__destroyed, false, 'view B sprite untouched');
  assert.ok(spriteB.parent, 'view B sprite still mounted');
  assert.equal(spriteB.texture.__destroyed, false);
  viewB.applySnapshot(baseSnapshot([employeeSnapshot({ employeeId: 'coder' })]));
  assert.equal(viewB.entities.get('coder').__snapshot.employeeId, 'coder', 'view B still renders snapshots');
  viewB.destroy();
  for (const texture of texturesB.values()) {
    assert.equal(texture.__destroyed, true, `view B releases ${texture.__id} on its own destroy`);
  }
});

// ---------------------------------------------------------------------------
// Task 6 — golden workstation composition calibration (desk-1 only)
// ---------------------------------------------------------------------------
//
// The working pose carries a baked-in desk + laptop. The calibration moves
// the REAL desk-1 furniture so the desktop surface replaces the baked desk
// (no second desktop), the seated character's lower body is occluded by the
// desk front, and the chair is tucked beside her. Template offsets, graph
// nodes and the seat anchor stay untouched; desks 2-6 keep the reversible
// placeholder path and the exact template-derived furniture rects.

const REFERENCE = { width: 1280, height: 840 };

// content px box of a width-fitted furniture sprite at the reference scene
function furnitureContentBox(item) {
  const rect = Object.values(item.parts)[0];
  const assetId = item.assetId;
  const NATURAL = { 'prop-desk-back-right-top': 1024, 'prop-monitor-back-right-top': 1024, 'prop-chair-front-left-top': 1024 };
  const CONTENT = {
    'prop-desk-back-right-top': { width: 754, height: 714 },
    'prop-monitor-back-right-top': { width: 646, height: 672 },
    'prop-chair-front-left-top': { width: 473, height: 872 },
  };
  const scale = (rect.width * REFERENCE.width) / NATURAL[assetId];
  const centerX = (rect.x + rect.width / 2) * REFERENCE.width;
  const centerY = (rect.y + rect.height / 2) * REFERENCE.height;
  const w = CONTENT[assetId].width * scale;
  const h = CONTENT[assetId].height * scale;
  return { left: centerX - w / 2, right: centerX + w / 2, top: centerY - h / 2, bottom: centerY + h / 2 };
}

// content px box of the seated working pose at the seat anchor (renderer math)
function workingContentBox() {
  const workstations = officeLayout.createOfficeLayout(LAYOUT_FIXTURE).workstations();
  const seat = workstations.instances[0].seat.position;
  const geometry = PACK.geometry;
  const scale = Math.min(180, Math.max(64, REFERENCE.height * 0.11)) / geometry.visibleBounds.height;
  const footX = seat.x * REFERENCE.width;
  const footY = seat.y * REFERENCE.height;
  const frame = PACK.frameGeometry('working', 0);
  const left = footX - frame.outputAnchor.x * scale;
  const top = footY - frame.outputAnchor.y * scale;
  const b = frame.visibleBounds;
  return { left: left + b.x * scale, right: left + (b.x + b.width) * scale, top: top + b.y * scale, bottom: top + (b.y + b.height) * scale };
}

// dense brown-desktop bbox inside the working art (measured, immutable)
const WORKING_BAKED_DESK_ART = { x: 68, y: 134, width: 223, height: 162 };

function bakedDeskBox() {
  const geometry = PACK.geometry;
  const scale = Math.min(180, Math.max(64, REFERENCE.height * 0.11)) / geometry.visibleBounds.height;
  const workstations = officeLayout.createOfficeLayout(LAYOUT_FIXTURE).workstations();
  const seat = workstations.instances[0].seat.position;
  const frame = PACK.frameGeometry('working', 0);
  const left = seat.x * REFERENCE.width - frame.outputAnchor.x * scale;
  const top = seat.y * REFERENCE.height - frame.outputAnchor.y * scale;
  const b = WORKING_BAKED_DESK_ART;
  return { left: left + b.x * scale, right: left + (b.x + b.width) * scale, top: top + b.y * scale, bottom: top + (b.y + b.height) * scale };
}

// upper-body centroid of the working pose art (measured, immutable)
const WORKING_BODY_CENTER_ART = { x: 199, y: 138 };

function workingBodyCenterPx() {
  const scale = Math.min(180, Math.max(64, REFERENCE.height * 0.11)) / PACK.geometry.visibleBounds.height;
  const workstations = officeLayout.createOfficeLayout(LAYOUT_FIXTURE).workstations();
  const seat = workstations.instances[0].seat.position;
  const frame = PACK.frameGeometry('working', 0);
  return {
    x: seat.x * REFERENCE.width - frame.outputAnchor.x * scale + WORKING_BODY_CENTER_ART.x * scale,
    y: seat.y * REFERENCE.height - frame.outputAnchor.y * scale + WORKING_BODY_CENTER_ART.y * scale,
  };
}

test('desk-1 chair is centered under the seated character, not a side prop', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const chair = layout.furniture().find((item) => item.id === 'desk-1-chair');
  const rect = chair.parts.back;
  const chairCenter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const body = workingBodyCenterPx();
  const bodyNormalized = { x: body.x / REFERENCE.width, y: body.y / REFERENCE.height };
  assert.ok(Math.abs(chairCenter.x - bodyNormalized.x) <= 0.012, `chair x ${chairCenter.x} vs body x ${bodyNormalized.x}`);
  assert.ok(Math.abs(chairCenter.y - bodyNormalized.y) <= 0.018, `chair y ${chairCenter.y} vs body y ${bodyNormalized.y}`);
  assert.equal(rect.width, 0.065, 'the chair is scaled up to read as her chair');
  // the chair backrest rises behind her torso instead of floating beside it
  const chairBox = furnitureContentBox(chair);
  const bodyBox = workingContentBox();
  const overlapLeft = Math.max(chairBox.left, bodyBox.left);
  const overlapRight = Math.min(chairBox.right, bodyBox.right);
  assert.ok(overlapRight > overlapLeft, 'the chair overlaps the seated silhouette');
});

test('desk-1 desktop surface replaces the working pose baked desk (no second desktop)', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const deskItem = layout.furniture().find((item) => item.id === 'desk-1-back');
  assert.equal(deskItem.parts.back.width, 0.119, 'the desktop is uniformly scaled up for full baked-desk coverage');
  const deskBox = furnitureContentBox(deskItem);
  const baked = bakedDeskBox();
  const tolerance = 4;
  assert.ok(baked.left >= deskBox.left - tolerance && baked.right <= deskBox.right + tolerance, 'baked desk hidden behind the real desktop');
  // the baked desk's far edge may peek above the desktop by a sliver (reads as
  // the far edge of her desk behind the front panel); the bulk stays covered
  assert.ok(baked.top >= deskBox.top - 10, 'baked desk far edge peeks at most a sliver');
  assert.ok(baked.bottom <= deskBox.bottom + tolerance, 'baked desk front face covered');
  // aspect robustness: on a wider, shorter stage the height-fit character and
  // width-fit furniture drift apart — the desktop must still cover the baked desk
  const wideStage = { width: 1150, height: 815 };
  const charScale = Math.min(180, Math.max(64, wideStage.height * 0.11)) / PACK.geometry.visibleBounds.height;
  const workstations = officeLayout.createOfficeLayout(LAYOUT_FIXTURE).workstations();
  const seat = workstations.instances[0].seat.position;
  const frame = PACK.frameGeometry('working', 0);
  const bakedWide = {
    left: seat.x * wideStage.width - frame.outputAnchor.x * charScale + WORKING_BAKED_DESK_ART.x * charScale,
    right: seat.x * wideStage.width - frame.outputAnchor.x * charScale + (WORKING_BAKED_DESK_ART.x + WORKING_BAKED_DESK_ART.width) * charScale,
  };
  const deskScaleWide = (deskItem.parts.back.width * wideStage.width) / 1024;
  const deskCenterWideX = (deskItem.parts.back.x + deskItem.parts.back.width / 2) * wideStage.width;
  const deskContentWide = { left: deskCenterWideX - (754 * deskScaleWide) / 2, right: deskCenterWideX + (754 * deskScaleWide) / 2 };
  assert.ok(bakedWide.left >= deskContentWide.left - tolerance && bakedWide.right <= deskContentWide.right + tolerance, 'baked desk stays covered on the wide aspect');
  // the character's seated torso stays visible above the desktop edge
  const seated = workingContentBox();
  assert.ok(seated.top < deskBox.top, 'head and shoulders remain above the desktop');
});

test('desk-1 front occluder covers the seated lower body down to the desk body', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const front = layout.furniture().find((item) => item.id === 'desk-1-front');
  const back = layout.furniture().find((item) => item.id === 'desk-1-back');
  const frontRect = front.parts.front;
  const backRect = back.parts.back;
  assert.equal(frontRect.x, backRect.x, 'front mirrors the back x (one desktop)');
  assert.ok(Math.abs(frontRect.y - (backRect.y + 0.035)) < 1e-9, 'front band follows the legacy split');
  const frontBox = furnitureContentBox({ ...front, parts: { front: backRect }, assetId: back.assetId });
  const seat = layout.nodeById('desk-1').position;
  const seatPx = { x: seat.x * REFERENCE.width, y: seat.y * REFERENCE.height };
  assert.ok(seatPx.x >= frontBox.left && seatPx.x <= frontBox.right, 'seat anchor inside the occluder coverage');
  assert.ok(seatPx.y >= frontBox.top && seatPx.y <= frontBox.bottom, 'occluder spans the seated lower body');
});

test('desk-1 monitor stands at desktop height to the left of the seated character', () => {
  const layout = officeLayout.createOfficeLayout(LAYOUT_FIXTURE);
  const monitor = layout.furniture().find((item) => item.id === 'desk-1-monitor');
  const monitorBox = furnitureContentBox(monitor);
  const deskBox = furnitureContentBox(layout.furniture().find((item) => item.id === 'desk-1-back'));
  // the screen stands ON the desktop: its top lands near the desktop back edge
  assert.ok(monitorBox.top >= deskBox.top - 2 && monitorBox.top <= deskBox.top + 14, 'the monitor stands on the desktop surface');
  const baseDepth = monitorBox.right - deskBox.left;
  assert.ok(baseDepth > 0 && baseDepth <= (monitorBox.right - monitorBox.left) * 0.5, 'the monitor base stays in desktop depth');
  const seated = workingContentBox();
  assert.ok(monitorBox.right <= seated.left + 8, 'the monitor clears the seated character face');
  assert.ok(Math.abs((monitorBox.left + monitorBox.right) / 2 - 0.5325 * REFERENCE.width) <= 6, 'calibrated monitor x beside the seated character');
});

test('desk-1 monitor carries a light contrast outline so it reads on the light background', async () => {
  const PIXI = stubPIXI();
  const view = await createRenderer(PIXI, {
    officeTextures: makeOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1'],
  });
  const monitor = view.layers.backFurniture.children.find((child) => child.__furnitureId === 'desk-1-monitor');
  assert.equal(monitor.__kind, 'Sprite');
  const outline = monitor.children.find((child) => child.__role === 'monitor-contrast');
  assert.ok(outline && outline.__kind === 'Graphics', 'a light contrast outline rides the monitor sprite');
  assert.ok(monitor.children.every((child) => child.__role !== 'shadow'), 'no dark-theme styling is introduced');
  view.destroy();
});

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

test('a missing shared texture degrades only that asset across workstations', async () => {
  const PIXI = stubPIXI();
  const officeTextures = makeOfficeTextures(PIXI);
  officeTextures.delete('prop-chair-front-left-top');
  const view = await createRenderer(PIXI, {
    officeTextures,
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
  });
  const diagnostics = view.officeDiagnostics();
  assert.equal(diagnostics.code, 'OFFICE_TEXTURE_MISSING');
  assert.equal(diagnostics.missing.length, 6, 'one missing entry per workstation chair');
  assert.ok(diagnostics.missing.every((entry) => entry.assetId === 'prop-chair-front-left-top'));
  for (const deskId of ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6']) {
    assert.equal(furnitureSprite(view, 'backFurniture', `${deskId}-chair`).__kind, 'Graphics', `${deskId} chair degrades`);
    assert.equal(furnitureSprite(view, 'backFurniture', `${deskId}-monitor`).__kind, 'Sprite', `${deskId} monitor unaffected`);
  }
  view.destroy();
});

// ---------------------------------------------------------------------------
// Task 9 — production composition locks: interaction overlay placement and
// per-desk occluder isolation
// ---------------------------------------------------------------------------

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

test('flat furniture renders contentBbox-fitted sprites: the art box fills the fixture rect', async () => {
  const PIXI = stubPIXI();
  const view = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    officeTextures: flatOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
  });
  const desk = view.layers.groundEntities.children.find((child) => child.__furnitureId === 'desk-1-back');
  assert.equal(desk.__kind, 'Sprite', 'flat desk renders as a sprite');
  assert.equal(desk.texture.__id, 'flat-desk');
  const rect = FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === 'desk-1-back').parts.back;
  const bbox = E4_LAYOUT_ASSETS.find((asset) => asset.id === 'flat-desk').contentBbox;
  // artScale fits the OPAQUE ART (bbox.w × texW) onto the rect width
  const artScale = (rect.width * VIEWPORT.width) / (bbox.w * 1024);
  assert.ok(Math.abs(desk.scale.x - artScale) < 1e-9, `scale ${desk.scale.x} ~ ${artScale}`);
  // sprite center shifted so the art bbox center lands on the rect center
  const expectedX = (rect.x + rect.width / 2) * VIEWPORT.width - (bbox.x + bbox.w / 2 - 0.5) * 1024 * artScale;
  const expectedY = (rect.y + rect.height / 2) * VIEWPORT.height - (bbox.y + bbox.h / 2 - 0.5) * 1024 * artScale;
  assert.ok(Math.abs(desk.x - expectedX) < 1e-6, `x ${desk.x} ~ ${expectedX}`);
  assert.ok(Math.abs(desk.y - expectedY) < 1e-6, `y ${desk.y} ~ ${expectedY}`);
  // environment props render from the catalog too (never placeholders)
  const island = view.layers.groundEntities.children.find((child) => child.__furnitureId === 'draft-53');
  assert.equal(island.__kind, 'Sprite', 'flat prop renders as a sprite');
  assert.equal(island.texture.__id, 'flat-island');
  // the flat monitor does NOT carry the isometric contrast outline
  const monitor = view.layers.groundEntities.children.find((child) => child.__furnitureId === 'desk-1-monitor');
  assert.equal(monitor.children.length, 0, 'flat monitor needs no isometric contrast outline');
  // M4.1c: flat chairs are no longer hard front-occluders — they join the
  // geometric pass and cover the seated body by bottom-edge order instead.
  const chair = view.layers.groundEntities.children.find((child) => child.__furnitureId === 'desk-1-chair');
  assert.equal(chair.__kind, 'Sprite');
  assert.equal(chair.texture.__id, 'flat-chair');
  assert.equal(view.layers['front-occluders'].children.some((child) => child.__furnitureId === 'desk-1-chair'), false,
    'the flat chair is not double-drawn on the front-occluders layer');
  view.destroy();
});

test('flat furniture paint order follows the draft depth inside each role', async () => {
  const PIXI = stubPIXI();
  const view = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    officeTextures: flatOfficeTextures(PIXI),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
  });
  const backs = view.furniturePaintOrder().filter((entry) => entry.layer === 'back-furniture');
  const depthOf = (id) => FLAT_LAYOUT_FIXTURE.furniture.find((item) => item.id === id).depth;
  // role paint order is main (desk bodies) then back (monitors/props); within
  // the back role the draft depth ascends (layer 升序, fixture order tie-break)
  const backDepths = backs.filter((entry) => entry.role === 'back').map((entry) => depthOf(entry.id));
  assert.deepEqual(backDepths, [...backDepths].sort((a, b) => a - b),
    `back role paints in draft depth order: ${backDepths}`);
  assert.equal(backs.filter((entry) => entry.role === 'main').length, 6, 'six desk bodies paint first');
  // workstation stacks keep desk below monitor (same workstation)
  for (let index = 1; index <= 6; index += 1) {
    const deskIndex = backs.findIndex((entry) => entry.id === `desk-${index}-back`);
    const monitorIndex = backs.findIndex((entry) => entry.id === `desk-${index}-monitor`);
    assert.equal(deskIndex < monitorIndex, true, `desk-${index} paints under its monitor`);
  }
  // M4.1c: the DECLARED order above is draft metadata; the real paint order is
  // the merged geometric pass — every sortY node lives in ground-entities and
  // the children are ordered by *effective* key ascending (farthest first).
  // 2026-09-22 fix: items resting ON another item (rice bowls/cooker on the
  // island, the desk phone on the coffee table) re-key to their supporter's
  // bottom edge + 0.5, so the declared bottom edge is no longer the painter key
  // for those props — assert on groundPaintOrder's recorded keys instead.
  const groundIds = view.layers.groundEntities.children
    .map((child) => child.__furnitureId).filter(Boolean);
  assert.ok(groundIds.length >= 32, `all flat furniture painted in the merged pass (${groundIds.length})`);
  const groundPaint = view.groundPaintOrder().filter((entry) => entry.kind === 'furniture');
  assert.deepEqual(groundPaint.map((entry) => entry.id), groundIds, 'recorded keys describe the real children order');
  for (let i = 1; i < groundPaint.length; i += 1) {
    assert.ok(groundPaint[i - 1].key <= groundPaint[i].key,
      `ground pass effective keys ascend: ${groundPaint[i - 1].id}(${groundPaint[i - 1].key.toFixed(1)}) <= ${groundPaint[i].id}(${groundPaint[i].key.toFixed(1)})`);
  }
  // the fix itself: any prop whose foot rests inside another item's span must
  // paint above the nearest such item below it (its supporter). Independent of
  // ids: re-derive supporter candidates from the draft rects, then assert the
  // prop's recorded key is greater than that supporter's recorded key.
  const keyOf = (id) => {
    const entry = groundPaint.find((candidate) => candidate.id === id);
    return entry ? entry.key : undefined;
  };
  const rectOf = (id) => {
    const item = FLAT_LAYOUT_FIXTURE.furniture.find((entry) => entry.id === id);
    if (!item) return null;
    return item.parts.back || item.parts.main || item.parts.front || null;
  };
  const props = ['draft-57', 'draft-58', 'draft-59', 'draft-60', 'draft-63'];
  let checked = 0;
  for (const propId of props) {
    const propRect = rectOf(propId);
    const propKey = keyOf(propId);
    if (!propRect || propKey === undefined) continue;
    const footX = propRect.x + propRect.width / 2;
    const footY = propRect.y + propRect.height;
    let supporter = null;
    for (const other of FLAT_LAYOUT_FIXTURE.furniture) {
      if (other.id === propId) continue;
      const rect = rectOf(other.id);
      if (!rect) continue;
      const bottom = (rect.y + rect.height) * VIEWPORT.height;
      if (bottom <= footY * VIEWPORT.height + 0.5) continue;
      if (footX < rect.x || footX > rect.x + rect.width) continue;
      if (footY < rect.y - 0.02) continue;
      if (!supporter || bottom < supporter.bottom) supporter = { id: other.id, bottom, key: keyOf(other.id) };
    }
    if (!supporter || supporter.key === undefined) continue;
    checked += 1;
    assert.ok(propKey > supporter.key,
      `${propId} paints above its supporter ${supporter.id} (${propKey.toFixed(1)} > ${supporter.key.toFixed(1)})`);
  }
  assert.ok(checked >= 3, `the resting-prop invariant was actually exercised (${checked} props)`);
  for (const entry of view.furniturePaintOrder()) {
    assert.equal(entry.paintsIn, entry.sortY ? 'ground-entities' : entry.layer,
      `${entry.id} paints in its contracted container`);
  }
  view.destroy();
});

test('flat furniture missing textures degrade to placeholders with diagnostics', async () => {
  const PIXI = stubPIXI();
  const view = await officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE),
    pack: PACK,
    textures: new Map(),
    officeTextures: new Map(),
    texturedWorkstations: ['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'],
    scene: { ...VIEWPORT },
    snapshot: null,
    mount: null,
  });
  const diagnostics = view.officeDiagnostics();
  assert.equal(diagnostics.code, 'OFFICE_TEXTURE_MISSING');
  assert.equal(diagnostics.missing.length > 0, true);
  const desk = view.layers.groundEntities.children.find((child) => child.__furnitureId === 'desk-1-back');
  assert.equal(desk.__kind, 'Graphics', 'missing flat texture falls back to the placeholder path');
  view.destroy();
});

// ---------------------------------------------------------------------------
// Task E5a-R2 — the runtime honours the editor-composed character scale.
// Mapping (documented in the module): the composed art height in the editor is
//   editorArtH = DRAFT_WIDTHS.character × itemScale × (frameArtH / packCanvas)
// and the runtime art height is
//   runtimeArtH = visibleHeight × (frameArtH / unionH)
// so equal heights require visibleHeight = DRAFT_WIDTHS.character × itemScale
// × unionH / packCanvas, delivered to the renderer as a height RATIO over the
// default computeVisibleHeight(referenceHeight). The final visible height is
// clamped to the SPEC-02 band [64, 180] so extreme drafts can never render a
// giant or a dot (draft scales outside ~[0.85, 2.38] hit the clamps).
// ---------------------------------------------------------------------------

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
