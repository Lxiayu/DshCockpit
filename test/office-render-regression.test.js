'use strict';

// 2026-09-25 渲染回归钉子（用户实测四症状）：
//   ① 连续多帧渲染下 角色↔椅子 的 z 序单调/稳定（不得来回翻）——回归 3bea20e 的
//      "排序结果与上次挂载序相同就跳过重排" 缺陷：跳过本身没错，错在同函数里还有
//      一个**无条件**的"角色-only addChild 前置循环"把所有角色摘到家具之上，而跳过
//      又阻止了 merged 循环恢复穿插序。修复后：层的实际 children 序必须**恒等于**
//      计算的 painter 序（actual == computed 是每一推的不变量）。
//   ② 快照带 bubble 时标签必被绘制（即使其它可视量未变）。
//   ③ 任务结束 → 员工在呈现窗口后离开工作态，且渲染侧贴图/位置跟着走
//      （office-module 状态机 + pixi-office-renderer 的集成）。
//   ④ 静态场景零重绘（保住 3bea20e 的性能收益，paintCount 可测计数）。
//   ⑤ prop 重挂"迭代到不动点"的行为钉住（两层支撑链：水吧→茶几→电话机）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeLayout = require('../src/office/runtime/office-layout.js');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeModule = require('../src/office/office-module.js');

const PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation/anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation/animations.json'), 'utf8')),
}).pack;

const FLAT_LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
);
const CANONICAL_LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);
const VIEWPORT = { width: 1280, height: 840 };

// 与 test/office-renderer.test.js 同源的 stub PIXI（addChild=摘下再挂上，正是
// Pixi 对在册子节点的语义——z 序回归就是靠它复现的）。
function stubPIXI() {
  const created = { applications: [] };
  class Observable {
    constructor() { this.children = []; this.parent = null; this.x = 0; this.y = 0; this.visible = true; this.alpha = 1; }
    addChild(...kids) { for (const k of kids) { if (k.parent) k.parent.removeChild(k); this.children.push(k); k.parent = this; } return kids[0]; }
    removeChild(k) { const i = this.children.indexOf(k); if (i >= 0) this.children.splice(i, 1); if (k) k.parent = null; return k; }
    destroy() { for (const c of [...this.children]) c && c.destroy && c.destroy(); this.children.length = 0; if (this.parent) this.parent.removeChild(this); }
  }
  class Container extends Observable { constructor() { super(); this.__kind = 'Container'; } }
  class Sprite extends Observable {
    constructor(t) { super(); this.__kind = 'Sprite'; this.texture = t || null; this.anchor = { set() {} }; this.scale = { x: 1, y: 1, set(x, y) { this.x = x; this.y = y === undefined ? x : y; } }; }
    destroy() { this.__destroyed = true; this.children.length = 0; }
  }
  class Graphics extends Observable {
    constructor() { super(); this.__kind = 'Graphics'; this.__ops = []; }
    rect() { this.__ops.push(['rect']); return this; } circle() { this.__ops.push(['circle']); return this; }
    roundRect() { this.__ops.push(['roundRect']); return this; } fill() { this.__ops.push(['fill']); return this; }
    stroke() { this.__ops.push(['stroke']); return this; } clear() { this.__ops.push(['clear']); return this; }
  }
  class Text extends Observable { constructor(t) { super(); this.__kind = 'Text'; this.text = String(t); this.style = {}; this.anchor = { set() {} }; } }
  class Texture { constructor(id) { this.__id = id; this.width = 100; this.height = 100; } destroy() {} }
  class Ticker { constructor() { this.started = false; } add() {} remove() {} start() { this.started = true; } stop() { this.started = false; } }
  class Application {
    constructor() { this.stage = new Container(); this.ticker = new Ticker(); this.renderer = { resize() {}, width: 0, height: 0 }; this.canvas = { tagName: 'CANVAS' }; created.applications.push(this); }
    async init(opts) { this.renderer.width = opts.width; this.renderer.height = opts.height; }
    render() { this.__renderCalls = (this.__renderCalls || 0) + 1; }
    destroy() {}
  }
  return { Application, Container, Sprite, Graphics, Text, Texture, Ticker, VERSION: 'stub', __created: created };
}

function employeeSnapshot(overrides) {
  return {
    employeeId: 'coder', displayName: '编码员', role: '编码', presence: 'present', runtime: 'unbound',
    activity: 'working', movement: 'stationary', position: { x: 0.5, y: 0.6 }, facing: 'down',
    seatNodeId: 'desk-3', binding: null, queueCount: 0, waiting: [], taskLabel: null, lastResult: null,
    marker: null, animation: { resource: 'working', frameIndex: 0, fallbackReason: null }, bubble: null,
    ...overrides,
  };
}
function baseSnapshot(employees) {
  return { schemaVersion: 1, simulatedAtMs: 1234, sync: 'healthy',
    scene: { referenceWidth: VIEWPORT.width, referenceHeight: VIEWPORT.height }, employees };
}
function flatOfficeTextures(PIXI) {
  const officeTextures = new Map();
  for (const assetId of [...new Set(FLAT_LAYOUT_FIXTURE.furniture.map((item) => item.assetId))]) {
    officeTextures.set(assetId, new PIXI.Texture(assetId, 1024, 1024));
  }
  return officeTextures;
}
async function createFlatRenderer(PIXI, overrides = {}) {
  return officeRenderer.createOfficeRenderer({
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
}
const childIds = (view) => view.layers.groundEntities.children.map((c) => c.__furnitureId || c.__employeeId || '?');
const computedIds = (view) => view.groundPaintOrder().map((entry) => entry.id);

// ---------------------------------------------------------------------------
// ① z 序稳定：坐姿工作循环（只有动画帧在变）+ 走动跨越家具键，每一推都必须
//    actual == computed；坐姿角色必须一直在自己椅子之前（M4.1h 契约不被任何
//    一推破坏）。
// ---------------------------------------------------------------------------
test('M4.1h-R: ground layer actual child order equals the computed painter order on EVERY push (no z-order flip-flop)', async () => {
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI);
  const layout = officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE);
  const seat = layout.nodeById('desk-3');

  const pushAndCheck = (employee, label) => {
    view.applySnapshot(baseSnapshot([employee]));
    const actual = childIds(view);
    const computed = computedIds(view);
    assert.deepEqual(actual, computed, `${label}: actual ground-children order must equal the computed painter order`);
    const charAt = actual.indexOf(employee.employeeId);
    const chairAt = actual.indexOf(`${employee.seatNodeId}-chair`);
    return { charAt, chairAt };
  };

  // 坐姿工作动画循环：位置不变，只有 frameIndex 变（旧缺陷在这必现：第 2 推起
  // 角色被摘到全家具之上且不再恢复——node-repro-prefix.txt 的 4/4 推错序）。
  for (let frame = 0; frame < 8; frame += 1) {
    const { charAt, chairAt } = pushAndCheck(employeeSnapshot({
      position: { ...seat.position },
      animation: { resource: 'working', frameIndex: frame, fallbackReason: null },
    }), `seated work frame ${frame}`);
    assert.ok(charAt < chairAt, `seated body stays behind her chair on frame ${frame} (${charAt} < ${chairAt})`);
  }

  // 走动：从座位向下穿过工位带到走廊（位置每推都在变，跨越家具键）。
  for (let step = 0; step <= 24; step += 1) {
    const y = Math.min(0.98, seat.position.y + step * 0.012);
    const { charAt, chairAt } = pushAndCheck(employeeSnapshot({
      activity: 'roaming',
      animation: { resource: 'walk-down', frameIndex: step % 4, fallbackReason: null },
      position: { x: seat.position.x, y },
    }), `walk step ${step}`);
    if (charAt < chairAt === false) {
      // 走出工位带后越过椅子键是合法的（她在椅子下方=更近处）；非法的是"实际序
      // 与计算序不一致"，上面已逐推断言。这里只记录越过后必然保持越过。
      assert.ok(charAt > chairAt, `after passing the chair the walker stays in front (step ${step})`);
    }
  }
  view.destroy();
});

test('M4.1h-R2: repeated pushes with UNCHANGED geometry never re-order the layer (monotonic, no paint-order churn)', async () => {
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI);
  const layout = officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE);
  const seat = layout.nodeById('desk-2');
  const mk = (frameIndex) => employeeSnapshot({
    position: { ...seat.position },
    animation: { resource: 'working', frameIndex, fallbackReason: null },
  });
  view.applySnapshot(baseSnapshot([mk(0)]));
  const baseline = childIds(view);
  let reorderSignals = 0;
  for (let frame = 1; frame <= 10; frame += 1) {
    view.applySnapshot(baseSnapshot([mk(frame)]));
    const current = childIds(view);
    assert.deepEqual(current, baseline, `unchanged geometry keeps the exact same child order (frame ${frame})`);
    assert.deepEqual(current, computedIds(view), 'actual == computed on every unchanged push');
    if (current.some((id, i) => baseline[i] !== id)) reorderSignals += 1;
  }
  assert.equal(reorderSignals, 0, 'no re-order at all while geometry is unchanged');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ② 气泡：快照带 bubble.text 时，即使其它可视量完全未变，也必须重画且气泡
//    Text/Graphics 可见、文字正确；气泡消失时必须隐藏。
// ---------------------------------------------------------------------------
test('E5c-R: a snapshot bubble forces a repaint and the bubble nodes paint even when nothing else changed', async () => {
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI);
  const layout = officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE);
  const seat = layout.nodeById('desk-5');
  const mk = (bubble) => employeeSnapshot({
    position: { ...seat.position },
    animation: { resource: 'working', frameIndex: 2, fallbackReason: null },
    bubble,
  });
  view.applySnapshot(baseSnapshot([mk(null)]));
  const paintsAt = (app) => app.__renderCalls || 0;

  const app = PIXI.__created.applications.at(-1);
  const before = paintsAt(app);
  view.applySnapshot(baseSnapshot([mk({ text: '这条线必须被画出来', topic: null, untilMs: 99999 })]));
  assert.equal(paintsAt(app), before + 1, 'a bubble appearing on an otherwise unchanged employee still repaints');

  const bubbleTexts = view.layers.effectsLabels.children.filter((c) => c.__kind === 'Text' && c.text === '这条线必须被画出来');
  assert.equal(bubbleTexts.length, 1, 'exactly one bubble text node carries the line');
  assert.equal(bubbleTexts[0].visible, true, 'the bubble text is visible');
  const bubbleBgs = view.layers.effectsLabels.children.filter((c) => c.__kind === 'Graphics' && c.visible && c.__ops.some((op) => op[0] === 'roundRect'));
  assert.ok(bubbleBgs.length >= 1, 'the bubble background is visible');

  // 消失：气泡清空必须隐藏（同样是"其它量未变"的一推）。
  const beforeHide = paintsAt(app);
  view.applySnapshot(baseSnapshot([mk(null)]));
  assert.equal(paintsAt(app), beforeHide + 1, 'a bubble clearing repaints too');
  assert.equal(bubbleTexts[0].visible, false, 'the bubble text hides when the snapshot bubble clears');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ③ 任务结束 → 离座：office-module 状态机走完 result→stand→leave，渲染侧的
//    脚点/贴图/绘制序每一推都跟着最新快照（无渲染滞留）。
// ---------------------------------------------------------------------------
test('M4.1h-R3: after the task ends the employee leaves the work state and the renderer follows every snapshot', async () => {
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'render-regression-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
  });
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI);
  const TICK = officeModule.TICK_MS;
  const emp = () => module.state().employees.find((c) => c.employeeId === 'orchestrator');
  const tickUntil = (predicate, maxMs = 240000) => {
    const steps = Math.round(maxMs / TICK);
    for (let i = 0; i < steps; i += 1) {
      module.tickOnce();
      view.applySnapshot(module.state()); // 渲染侧吃下每一推（真产品同路径）
      if (predicate()) return true;
    }
    return false;
  };

  // 先让 orch 车位到漫游点（preTask 原点），再派任务。
  const roamNodes = module.layout.nodes().filter((n) => n.tags.includes('roaming') && /^roam-/.test(n.id));
  assert.equal(tickUntil(() => {
    const e = emp();
    return e.movement === 'stationary' && roamNodes.some((n) => Math.hypot(e.position.x - n.position.x, e.position.y - n.position.y) < 0.02);
  }), true, 'orchestrator parks at a roam node first');

  module.ingestHarnessEvent({ sessionId: 'sess-render-reg', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  assert.equal(tickUntil(() => emp().activity === 'working' && emp().segment === null), true, 'task runs to the work phase');
  // 等她**真的坐进座位**（task-start 路线被堵时的设计是"原地工作"降级——那种场景
  // 的 turn/end 按契约直接清理、不表演起身；本用例要覆盖的是"到座→离座"主线）。
  assert.equal(tickUntil(() => {
    const e = emp();
    return !!(e.workstation && e.movement === 'stationary' && e.segment === null
      && Math.hypot(e.position.x - e.workstation.seatAnchor.x, e.position.y - e.workstation.seatAnchor.y) < 0.005);
  }), true, 'employee reaches and holds her seat before the turn ends');
  const seatAnchor = emp().workstation && emp().workstation.seatAnchor;

  module.ingestHarnessEvent({ sessionId: 'sess-render-reg', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  assert.equal(emp().transition && emp().transition.phase, 'result', 'result presentation opens');
  const presenting = emp();
  const record = view.entities.get('orchestrator');
  assert.ok(record && record.__snapshot, 'the renderer holds the employee record');
  // 呈现窗口内渲染侧必须仍画在座位上（result 不早站）。
  assert.ok(Math.abs(record.__footPx.x - presenting.position.x * VIEWPORT.width) < 1.5
    && Math.abs(record.__footPx.y - presenting.position.y * VIEWPORT.height) < 1.5,
    'during the presentation the painted foot stays at the desk');

  // 状态机：呈现 → 起身 → 离座 → 回到本地行为。
  assert.equal(tickUntil((() => {
    let sawStand = false;
    return () => {
      const e = emp();
      if (e.segment && e.segment.kind === 'seat-to-approach') sawStand = true;
      return sawStand && e.workstation === null && ['roaming', 'resting', 'chatting', 'sleeping'].includes(e.activity);
    };
  })()), true, 'employee stands, releases the workstation and resumes local behavior');

  // 渲染侧：最后一推之后，画的脚点必须等于最终快照位置（绝不停留在座位）。
  const finalEmp = emp();
  assert.ok(Math.abs(record.__footPx.x - finalEmp.position.x * VIEWPORT.width) < 1.5
    && Math.abs(record.__footPx.y - finalEmp.position.y * VIEWPORT.height) < 1.5,
    `painted foot follows the final snapshot (${JSON.stringify(record.__footPx)} vs ${JSON.stringify(finalEmp.position)})`);
  assert.equal(record.__snapshot.activity, finalEmp.activity, 'painted activity follows the final snapshot');
  assert.notEqual(record.__footPx.y, seatAnchor.y * VIEWPORT.height, 'the painted foot has physically LEFT the seat anchor');
  assert.deepEqual(childIds(view), computedIds(view), 'actual order still equals computed after the whole lifecycle');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ④ 静态零重绘 + 动态量必画（paintCount 可测计数）。
// ---------------------------------------------------------------------------
test('perf-R: identical snapshot pushes paint NOTHING; every visible change (position/frame/marker/bubble/queue/selection) paints', async () => {
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI);
  const layout = officeLayout.createOfficeLayout(FLAT_LAYOUT_FIXTURE);
  const seatA = layout.nodeById('desk-1');
  const base = employeeSnapshot({ position: { ...seatA.position }, animation: { resource: 'working', frameIndex: 0, fallbackReason: null } });
  view.applySnapshot(baseSnapshot([base]));

  const paints = () => view.diagnostics().paintCount;
  const pushSame = () => view.applySnapshot(baseSnapshot([{ ...base }]));

  // 静态：300 推零重绘（性能收益的可测钉子）。
  const p0 = paints();
  for (let i = 0; i < 300; i += 1) pushSame();
  assert.equal(paints() - p0, 0, '300 identical pushes paint nothing');

  // 每种动态量单独变化：都恰好触发一次重画。
  const cases = [
    ['position', (e) => ({ ...e, position: { x: e.position.x + 0.01, y: e.position.y } })],
    ['animation frame', (e) => ({ ...e, animation: { ...e.animation, frameIndex: 1 } })],
    ['animation resource', (e) => ({ ...e, animation: { resource: 'walk-down', frameIndex: 0, fallbackReason: null } })],
    ['marker', (e) => ({ ...e, marker: 'chat-ellipsis' })],
    ['bubble', (e) => ({ ...e, bubble: { text: '变化必画', topic: null, untilMs: 1 } })],
    ['queueCount', (e) => ({ ...e, queueCount: 2 })],
  ];
  let current = base;
  for (const [name, mutate] of cases) {
    current = mutate(current);
    const before = paints();
    view.applySnapshot(baseSnapshot([{ ...current }]));
    assert.equal(paints() - before, 1, `a ${name} change paints exactly once`);
    // 之后回到静止：同一状态再推不再画。
    const settled = paints();
    view.applySnapshot(baseSnapshot([{ ...current }]));
    assert.equal(paints() - settled, 0, `the settled ${name} state paints nothing again`);
  }

  // 选中态：selection 在 sig 里——setSelection 立即翻选环可见性，**下一推**（即使
  // 场景其余完全没变）必须恰好补画一次；清除选中同样如此。
  const ring = view.layers.effectsLabels.children.find((c) => c.__role === 'selection-ring');
  assert.ok(ring, 'selection ring node exists');
  view.setSelection('coder');
  assert.equal(ring.visible, true, 'the ring becomes visible immediately at setSelection');
  const beforeSel = paints();
  view.applySnapshot(baseSnapshot([{ ...current }]));
  assert.equal(paints() - beforeSel, 1, 'the push after a selection change paints exactly once (selection is in the visual signature)');
  view.setSelection(null);
  assert.equal(ring.visible, false, 'the ring hides immediately at clearSelection');
  const beforeClear = paints();
  view.applySnapshot(baseSnapshot([{ ...current }]));
  assert.equal(paints() - beforeClear, 1, 'the push after clearing the selection paints exactly once');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ⑤ prop 重挂不动点：两层支撑链（水吧 → 茶几 → 电话机）必须收敛为严格递增，
//    且实际挂载序一致（"只跑一遍"的实现会让电话机落在茶几之下）。
// ---------------------------------------------------------------------------
test('M4.1c-R: nested prop chains re-key to a FIXED POINT (prop on prop on support)', async () => {
  const draft = JSON.parse(JSON.stringify(FLAT_LAYOUT_FIXTURE));
  // 三层几何（scene 归一化坐标）：
  //   水吧 draft-55：x 0.55..0.75，y 0.40..0.52（底边键 = 0.52 * 840 = 436.8）
  //   茶几 draft-53：x 0.66..0.80（footX 0.73 落在水吧跨度内），y 0.42..0.51
  //     —— 原始键 428.4 < 水吧键，被重挂抬到 436.8 + 0.5 = 437.3；
  //   电话 draft-58：x 0.755..0.795（footX 0.775 在茶几跨度内、**在水吧跨度外**），
  //     y 0.455..0.485 —— 原始键 407.4，必须跟着茶几**最终**键走到 437.8。
  // 只跑一遍的实现会让电话停在 428.9（茶几第一轮的旧键之下）→ 电话被茶几盖住。
  const bar = draft.furniture.find((item) => item.id === 'draft-55');
  bar.parts.main = { x: 0.55, y: 0.40, width: 0.20, height: 0.12 };
  const tea = draft.furniture.find((item) => item.id === 'draft-53');
  tea.parts.main = { x: 0.66, y: 0.42, width: 0.14, height: 0.09 };
  const phone = draft.furniture.find((item) => item.id === 'draft-58');
  phone.parts.main = { x: 0.755, y: 0.455, width: 0.04, height: 0.03 };
  const PIXI = stubPIXI();
  const view = await createFlatRenderer(PIXI, { layout: officeLayout.createOfficeLayout(draft) });
  const keys = new Map(view.groundPaintOrder().map((entry) => [entry.id, entry.key]));
  for (const id of ['draft-55', 'draft-53', 'draft-58']) assert.ok(keys.has(id), `${id} is in the merged pass`);
  assert.ok(keys.get('draft-55') < keys.get('draft-53'), `tea table paints after its support (bar ${keys.get('draft-55').toFixed(1)} < tea ${keys.get('draft-53').toFixed(1)})`);
  assert.ok(keys.get('draft-53') < keys.get('draft-58'), `phone paints after the tea table it rests on (tea ${keys.get('draft-53').toFixed(1)} < phone ${keys.get('draft-58').toFixed(1)})`);
  assert.ok(Math.abs(keys.get('draft-53') - 437.3) < 0.6, `tea re-keyed onto the bar (${keys.get('draft-53').toFixed(1)} ≈ 437.3)`);
  // 只跑一遍的实现会把电话停在第一轮的旧值 428.9（茶几抬升前的键）→ 电话被茶几
  // 盖住；不动点实现必须让电话的最终键**严格高于**茶几的最终键（电话随后被更近
  // 处的下一支撑物（desk-4 桌体）接走也是算法的既定语义——键只增不减）。
  assert.ok(keys.get('draft-58') > 437.3 + 0.25,
    `phone followed the tea table's FINAL key (${keys.get('draft-58').toFixed(1)} > tea-final 437.3; the broken single pass left it at 428.9)`);
  assert.deepEqual(childIds(view), computedIds(view), 'actual children order equals the computed painter order');
  // 不动点：再推同场景（动画帧变化强制重算），键不再漂移。
  view.applySnapshot(baseSnapshot([employeeSnapshot({
    employeeId: 'coder',
    position: { x: 0.10, y: 0.90 },
    animation: { resource: 'working', frameIndex: 1, fallbackReason: null },
  })]));
  const keys2 = new Map(view.groundPaintOrder().map((entry) => [entry.id, entry.key]));
  assert.equal(keys2.get('draft-58'), keys.get('draft-58'), 'phone key is stable at the fixed point across pushes');
  view.destroy();
});
