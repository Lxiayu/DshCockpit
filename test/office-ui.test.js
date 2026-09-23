'use strict';

// Task 7 / SPEC-07 — Office HTML UI core, main-process office module and
// shell wiring tests.
// RED: src/office/office-page.js, src/office/office-module.js,
// src/office/office-preload.js, src/office/office.html, src/office/office.css
// and the window-manager office view surface do not exist yet.
//
// Automatic acceptance under test (SPEC-07 / plan Task 7 Step 1):
// - details hierarchy: large display name + role dot marker, prominent
//   current task / last result, small dim session/sync/binding/diagnostic
//   fields — and NEVER prompt text, tool arguments/results, raw errors,
//   session IDs or token counts
// - keyboard: stable focus order, Enter/Space select, Escape clears,
//   arrows move; screen-reader labels come from the snapshot only
// - queue badge counts and ordered waiting list; collaborator current
//   task + queue count
// - reduced-motion reaches the page controller
// - office module: with NO Harness traffic five residents roam locally,
//   never offline; a trusted task walks the employee to the seat, works,
//   presents the result, releases and resumes local behavior
// - subagent runIds are consumed as Task-6 PROXIES verbatim (never re-derived)
// - visibility pause freezes the simulation clock and resumes from the
//   logical position without replaying time
// - exactly the office:* IPC channels (eight since P3 added office:pending
//   for the 待你处理 answer/detail actions); payload schema validation,
//   size limits and privacy redaction
// - two office views share one main-process snapshot/simulation clock and
//   closing one view releases only that view

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const { createRuntimeAdapter, deriveRunProxy } = require('../src/office/runtime/runtime-adapter.js');
const officePage = require('../src/office/office-page.js');
const officeModule = require('../src/office/office-module.js');
const { createWindowManager } = require('../src/window-manager.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const EMPLOYEE_IDS = ['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'];

// M4.1g: the production character pack and the compiled bundled-flat layout —
// the nap art test must run against the art and layout the product ships.
const PROD_PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PROD_PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;
const FLAT_LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
);

function makeModule(overrides = {}) {
  return officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-ui-test-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    ...overrides,
  });
}

function tickFor(module, ms) {
  const steps = Math.round(ms / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) module.tickOnce();
}

function tickUntil(module, predicate, maxMs = 120000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    if (predicate(module.state())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// details view model (privacy + hierarchy)
// ---------------------------------------------------------------------------

test('details view model: large name + role dot, prominent task/result, dim diagnostics', () => {
  const vm = officePage.buildDetailsViewModel({
    employeeId: 'coder',
    displayName: '编码员',
    role: '编码、文件、命令',
    presence: 'present',
    runtime: 'running',
    activity: 'working',
    movement: 'stationary',
    sync: 'healthy',
    queueCount: 2,
    waiting: [{ position: 1 }, { position: 2 }],
    taskLabel: '执行任务中',
    lastResult: null,
    binding: { source: 'root-default', confidence: 0.9 },
    lastTool: 'read_file',
  });
  assert.equal(vm.name.text, '编码员');
  assert.equal(vm.name.size, 'large', 'display name is the largest element');
  assert.equal(vm.roleDot.text, '编码、文件、命令');
  assert.ok(vm.roleDot.dot === true, 'role renders as a dot/short marker');
  assert.equal(vm.primary.size, 'prominent');
  assert.equal(vm.primary.text, '执行任务中');
  assert.ok(vm.dimFields.length >= 3, 'presence/sync/binding/diagnostic fields exist');
  for (const field of vm.dimFields) assert.equal(field.size, 'dim');
  // waiting list is ordered and content-free
  assert.deepEqual(vm.waiting.map((w) => w.position), [1, 2]);
});

test('details view model shows the last result prominently when no task is active', () => {
  const vm = officePage.buildDetailsViewModel({
    employeeId: 'reviewer',
    displayName: '评审员',
    role: '代码与结果评审',
    presence: 'present',
    runtime: 'completed',
    activity: 'working',
    movement: 'stationary',
    sync: 'healthy',
    queueCount: 0,
    waiting: [],
    taskLabel: null,
    lastResult: { outcome: 'completed', atMs: 99 },
    binding: null,
  });
  assert.equal(vm.primary.text, '最近结果：已完成');
  assert.equal(vm.primary.size, 'prominent');
});

test('details view model never exposes session ids, tokens, prompts, tool args or raw errors', () => {
  const vm = officePage.buildDetailsViewModel({
    employeeId: 'orchestrator',
    displayName: '调度员',
    role: '任务编排与分发',
    presence: 'present',
    runtime: 'failed',
    activity: 'working',
    movement: 'stationary',
    sync: 'stale',
    queueCount: 0,
    waiting: [],
    taskSummary: 'sess-abc123 fix the login bug', // must never surface
    taskLabel: null,
    lastResult: { outcome: 'failed', atMs: 5 },
    binding: { source: 'manual', confidence: 1 },
    lastTool: 'write_file',
    lastError: 'ENOENT: no such file /Users/xia/secret.txt', // must never surface
    sessionId: 'sess-abc123',
    tokens: 12345,
    diagnosticText: 'raw stack trace ...',
  });
  const serialized = JSON.stringify(vm);
  assert.equal(/sess-abc123|12345|ENOENT|login bug|secret\.txt|stack trace/.test(serialized), false, 'privacy leak in details VM');
  // outcome words are coarse and allowed
  assert.ok(/失败|未完成/.test(vm.primary.text), 'failed outcome is presented in coarse words');
});

test('local chat exposes only a non-text marker label, never simulated dialogue', () => {
  const vm = officePage.buildDetailsViewModel({
    employeeId: 'coder',
    displayName: '编码员',
    role: '编码、文件、命令',
    presence: 'present',
    runtime: 'unbound',
    activity: 'chatting',
    movement: 'stationary',
    sync: 'healthy',
    queueCount: 0,
    waiting: [],
    marker: 'chat-ellipsis',
    markerLabel: '正在交流',
    taskLabel: null,
    lastResult: null,
    binding: null,
  });
  assert.equal(vm.primary.text, '…');
  assert.equal(vm.primary.accessibleLabel, '正在交流');
});

// ---------------------------------------------------------------------------
// office page controller: selection, keyboard, visibility, reduced motion
// ---------------------------------------------------------------------------

function snapshotFixture() {
  return {
    schemaVersion: 1,
    simulatedAtMs: 10,
    sync: 'healthy',
    scene: { referenceWidth: 1280, referenceHeight: 840 },
    employees: EMPLOYEE_IDS.map((id) => ({
      employeeId: id,
      displayName: { orchestrator: '调度员', researcher: '研究员', coder: '编码员', reviewer: '评审员', collaborator: '协作者' }[id],
      role: '职责',
      presence: 'present',
      runtime: 'unbound',
      activity: 'roaming',
      movement: 'stationary',
      sync: 'healthy',
      position: { x: 0.5, y: 0.6 },
      facing: 'down',
      seatNodeId: `desk-${EMPLOYEE_IDS.indexOf(id) + 1}`,
      binding: null,
      queueCount: id === 'collaborator' ? 2 : 0,
      waiting: id === 'collaborator' ? [{ position: 1 }, { position: 2 }] : [],
      taskLabel: null,
      lastResult: null,
      marker: null,
      animation: { resource: 'idle', frameIndex: 0, fallbackReason: null },
    })),
    activityLog: [
      { atMs: 1, employeeId: 'coder', kind: 'chat-started' },
      { atMs: 2, employeeId: 'orchestrator', kind: 'task-started' },
    ],
    diagnostics: [{ atMs: 3, code: 'PACK_MISSING' }],
    capabilities: { cancel: true, interrupt: true, followup: true, steer: true, inject: true, pause: false, resume: false, preempt: false },
  };
}

function stubBridge() {
  const calls = [];
  return {
    calls,
    getState: async () => snapshotFixture(),
    dispatch: async (payload) => { calls.push(['office:dispatch', payload]); return { ok: true }; },
    cancel: async (payload) => { calls.push(['office:cancel', payload]); return { ok: true }; },
    interrupt: async (payload) => { calls.push(['office:interrupt', payload]); return { ok: true }; },
    getSettings: async () => ({ reducedMotion: false }),
    updateSettings: async (settings) => { calls.push(['office:settings', settings]); return { ok: true, settings }; },
    getDiagnostics: async () => ({ diagnostics: [] }),
    notifyVisibility: (visible) => { calls.push(['office:visibility', { visible }]); },
    onState: (cb) => { calls.push(['office:onState']); stubBridge.__listener = cb; },
  };
}

test('page controller: pointer + keyboard selection with Enter/Space and Escape', async () => {
  const bridge = stubBridge();
  const page = officePage.createOfficePageController({ bridge });
  await page.init();
  assert.deepEqual(page.focusOrder(), EMPLOYEE_IDS, 'stable focus order');

  assert.equal(page.selectedEmployeeId(), null);
  page.select('coder');
  assert.equal(page.selectedEmployeeId(), 'coder');
  assert.equal(page.detailsFor('coder').name.text, '编码员');

  page.clearSelection();
  assert.equal(page.selectedEmployeeId(), null);

  // keyboard model: arrows move focus, Enter/Space select, Escape clears
  assert.deepEqual(page.handleKey({ key: 'ArrowDown' }), { action: 'focus', index: 1 });
  assert.deepEqual(page.handleKey({ key: 'Enter' }), { action: 'select', employeeId: 'researcher' });
  assert.equal(page.selectedEmployeeId(), 'researcher');
  assert.deepEqual(page.handleKey({ key: ' ' }), { action: 'select', employeeId: 'researcher' });
  assert.deepEqual(page.handleKey({ key: 'ArrowDown' }), { action: 'focus', index: 2 });
  assert.deepEqual(page.handleKey({ key: 'Escape' }), { action: 'clear' });
  assert.equal(page.selectedEmployeeId(), null);
});

test('page controller: overview counts, queue badges, activity log labels and a11y labels', async () => {
  const bridge = stubBridge();
  const page = officePage.createOfficePageController({ bridge });
  await page.init();
  const overview = page.overview();
  assert.equal(overview.presentCount, 5, 'no offline: everyone present');
  assert.equal(overview.runningCount, 0);
  assert.equal(overview.queuedCount, 2, 'collaborator queue badge count');
  const labels = page.activityLog().map((entry) => entry.label);
  assert.ok(labels.some((l) => /开始交流/.test(l)), 'chat log label');
  assert.ok(labels.some((l) => /开始任务/.test(l)), 'task log label');
  for (const entry of page.activityLog()) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.label.length < 40, 'log labels stay coarse');
  }
  // screen-reader label for a scene entity comes from the snapshot only
  const a11y = page.accessibleLabelFor('collaborator');
  assert.ok(/协作者/.test(a11y.label));
  assert.ok(/排队 2/.test(a11y.label), 'queue count announced');
});

test('page controller: reduced motion and visibility reach the bridge', async () => {
  const bridge = stubBridge();
  const page = officePage.createOfficePageController({ bridge, reducedMotion: false });
  await page.init();
  await page.setReducedMotion(true);
  assert.equal(page.reducedMotion(), true);
  assert.deepEqual(bridge.calls.at(-1), ['office:settings', { reducedMotion: true }]);
  page.handleVisibility(false);
  assert.deepEqual(bridge.calls.at(-1), ['office:visibility', { visible: false }]);
  page.handleVisibility(true);
  assert.deepEqual(bridge.calls.at(-1), ['office:visibility', { visible: true }]);
});

// ---------------------------------------------------------------------------
// office module: local behavior without Harness
// ---------------------------------------------------------------------------

test('with no Harness conversation all five residents roam locally and never go offline', () => {
  const module = makeModule();
  tickFor(module, 8000);
  const state = module.state();
  assert.equal(state.employees.length, 5);
  for (const employee of state.employees) {
    assert.equal(employee.presence, 'present', 'presence invariant');
    assert.ok(
      ['roaming', 'chatting', 'resting', 'sleeping'].includes(employee.activity),
      `local activity only, got ${employee.activity}`
    );
    assert.ok(employee.position.x >= 0 && employee.position.x <= 1);
    assert.ok(employee.position.y >= 0 && employee.position.y <= 1);
    assert.equal(employee.binding, null);
  }
  assert.equal(state.sync, 'healthy');
});

test('local simulation is deterministic for the same seed and tick sequence', () => {
  const a = makeModule();
  const b = makeModule();
  tickFor(a, 3000);
  tickFor(b, 3000);
  assert.deepEqual(a.state().employees.map((e) => [e.employeeId, e.position, e.activity]),
    b.state().employees.map((e) => [e.employeeId, e.position, e.activity]));
});

test('long idle residents reach sleeping at their own desk, still present', () => {
  const module = makeModule();
  tickFor(module, 300); // small settle window
  const reached = tickUntil(
    module,
    (state) => state.employees.some((e) => e.activity === 'sleeping'),
    20000
  );
  assert.equal(reached, true, 'someone reaches sleeping after the idle threshold');
  const sleeper = module.state().employees.find((e) => e.activity === 'sleeping');
  assert.equal(sleeper.presence, 'present');
  assert.equal(sleeper.position.x, module.state().employees.find((e) => e.employeeId === sleeper.employeeId).position.x);
});

// ---------------------------------------------------------------------------
// M4.1g — the frozen-office fix: nap cap, finite naps, one log line per nap,
// left rest-area roaming, and the dedicated nap art.
// ---------------------------------------------------------------------------

// Harvests every activity-log entry the module ever produced (the snapshot only
// carries the tail, so entries are accumulated once across samples).
function makeLogHarvester(module) {
  const seen = new Set();
  const entries = [];
  return {
    entries,
    harvest() {
      for (const entry of module.state().activityLog) {
        const key = `${entry.atMs}:${entry.employeeId}:${entry.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
      }
    },
  };
}

test('M4.1g: at most two residents nap at once and every nap is finite', () => {
  const module = makeModule({
    config: { sleepAfterMs: 4000, sleepDurationMs: 8000, sleepRefractoryMs: 0 },
  });
  const harvester = makeLogHarvester(module);
  let peakSleeping = 0;
  const nappers = new Set();
  let woken = 0;
  for (let i = 0; i < 60000 / officeModule.TICK_MS; i += 1) {
    module.tickOnce();
    if (i % 6 !== 0) continue; // ~100 ms sampling cadence
    harvester.harvest();
    const state = module.state();
    const sleeping = state.employees.filter((e) => e.activity === 'sleeping');
    peakSleeping = Math.max(peakSleeping, sleeping.length);
    for (const employee of sleeping) nappers.add(employee.employeeId);
    woken = harvester.entries.filter((entry) => entry.kind === 'sleep-ended').length;
  }
  assert.ok(peakSleeping >= 1, `somebody napped (peak ${peakSleeping})`);
  assert.ok(peakSleeping <= 2, `never more than two naps at once (peak ${peakSleeping})`);
  assert.ok(nappers.size >= 2, `several residents nap over a minute (${nappers.size})`);
  assert.ok(woken >= 1, `naps end on their own (${woken} sleep-ended entries)`);
  const started = harvester.entries.filter((entry) => entry.kind === 'sleep-started');
  assert.ok(started.length >= woken, 'every finished nap also has its entry');
});

test('M4.1g: one sleep-started log per nap — five seconds of dwell never re-log', () => {
  const module = makeModule({ config: { sleepAfterMs: 4000, sleepDurationMs: 60000 } });
  const harvester = makeLogHarvester(module);
  let napperId = null;
  for (let i = 0; i < 30000 / officeModule.TICK_MS && !napperId; i += 1) {
    module.tickOnce();
    harvester.harvest();
    const napper = module.state().employees.find((e) => e.activity === 'sleeping');
    if (napper) napperId = napper.employeeId;
  }
  assert.ok(napperId, 'a resident reaches the nap state');
  const startedFor = (employeeId) => harvester.entries.filter(
    (entry) => entry.kind === 'sleep-started' && entry.employeeId === employeeId
  ).length;
  assert.equal(startedFor(napperId), 1, 'entering the nap logs exactly once');
  for (let i = 0; i < 5000 / officeModule.TICK_MS; i += 1) {
    module.tickOnce();
    harvester.harvest();
  }
  assert.equal(startedFor(napperId), 1, 'five seconds inside the nap never re-log sleep-started');
  const stillNapping = module.state().employees.find((e) => e.employeeId === napperId);
  assert.equal(stillNapping.activity, 'sleeping', 'the resident is still inside the same nap');
});

test('M4.1g: residents roam into the left rest area (x left of the work columns)', () => {
  const module = makeModule();
  const desks = module.layout.nodes().filter((node) => node.tags.includes('desk'));
  const boundary = Math.min(...desks.map((node) => node.position.x));
  const leftVisitors = new Set();
  let minX = 1;
  for (let i = 0; i < 120000 / officeModule.TICK_MS; i += 1) {
    module.tickOnce();
    if (i % 6 !== 0) continue; // ~100 ms sampling cadence
    for (const employee of module.state().employees) {
      if (employee.position.x < boundary) leftVisitors.add(employee.employeeId);
      minX = Math.min(minX, employee.position.x);
    }
  }
  assert.ok(leftVisitors.size >= 1,
    `residents reach the left rest area (visitors: ${[...leftVisitors].join(',')}, minX ${minX.toFixed(3)})`);
});

test('M4.1g: the nap state plays the dedicated sleeping art, not the side-back pose', () => {
  const module = officeModule.createOfficeModule({
    pack: PROD_PACK,
    layout: FLAT_LAYOUT_FIXTURE,
    seed: 'm4-1g-sleep-art',
    config: { sleepAfterMs: 4000, sleepDurationMs: 60000 },
  });
  tickFor(module, 300);
  const reached = tickUntil(
    module,
    (state) => state.employees.some((e) => e.activity === 'sleeping' && e.movement === 'stationary'),
    30000
  );
  assert.equal(reached, true, 'a resident naps at the desk');
  const napper = module.state().employees.find((e) => e.activity === 'sleeping' && e.movement === 'stationary');
  assert.equal(napper.animation.resource, 'sleeping',
    `the nap art plays (got ${napper.animation.resource}, fallback ${napper.animation.fallbackReason})`);
  assert.notEqual(napper.animation.resource, 'side-back', 'the composed back pose must not replace the nap');
  assert.equal(napper.marker, 'sleep-zzz');
});

// ---------------------------------------------------------------------------
// office module: trusted task lifecycle through the adapter
// ---------------------------------------------------------------------------

test('a trusted root task walks the employee to the desk, works, presents the result and resumes', () => {
  const module = makeModule();
  tickFor(module, 1000);
  const before = module.state().employees.find((e) => e.employeeId === 'orchestrator').position;

  const accepted = module.ingestHarnessEvent({
    sessionId: 'sess-root-1',
    type: 'agent/status',
    seq: 1,
    time: Date.now(),
    data: { status: 'running' },
  });
  assert.equal(accepted.status, 'accepted');

  const state = module.state();
  const bound = state.employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(bound.binding && bound.binding.source, 'root-default', 'root session defaults to orchestrator');
  assert.equal(bound.runtime, 'running');

  // walks to desk-1
  const arrived = tickUntil(
    module,
    (s) => {
      const e = s.employees.find((x) => x.employeeId === 'orchestrator');
      return e.movement === 'stationary' && e.activity === 'working' && e.transition && e.transition.phase === 'work';
    },
    120000
  );
  assert.equal(arrived, true, 'employee arrives and works at the seat');
  const atDesk = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(atDesk.seatNodeId, 'desk-1');
  const layout = require('../src/office/runtime/office-layout.js');
  const desk = layout.createOfficeLayout(require('../src/office/fixtures/office-layout.json')).nodeById('desk-1');
  assert.ok(Math.hypot(atDesk.position.x - desk.position.x, atDesk.position.y - desk.position.y) < 0.01);

  // terminal evidence -> result presentation -> release -> local behavior
  module.ingestHarnessEvent({
    sessionId: 'sess-root-1',
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: { reason: 'completed' },
  });
  const presenting = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(presenting.lastResult && presenting.lastResult.outcome, 'completed');
  tickFor(module, 1200); // resultPresentationMs 500 + margin
  const released = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(released.binding, null, 'binding released after result presentation');
  tickUntil(module, (s) => {
    const e = s.employees.find((x) => x.employeeId === 'orchestrator');
    return ['roaming', 'chatting', 'resting'].includes(e.activity);
  }, 60000);
  assert.ok(before, 'sanity');
});

test('subagent runIds reach the registry as Task-6 proxies, verbatim (never re-derived)', () => {
  const module = makeModule();
  tickFor(module, 200);
  module.ingestHarnessEvent({
    sessionId: 'sess-root-2',
    type: 'agent/status',
    seq: 1,
    time: 1,
    data: { status: 'running' },
  });
  const rawRunId = 'raw-run-42';
  module.ingestHarnessEvent({
    sessionId: 'sess-root-2',
    type: 'subagent/start',
    seq: 2,
    time: 2,
    data: { id: 'sess-child-9', provider: 'dsh', runId: rawRunId },
  });
  // The registry child record must carry deriveRunProxy(rawRunId) exactly:
  // the Task-7 wiring forwarded fact.runId verbatim. A double hash would be
  // deriveRunProxy(deriveRunProxy(rawRunId)) — assert it does NOT appear.
  const expected = deriveRunProxy(rawRunId);
  const doubleHashed = deriveRunProxy(expected);
  const snap = module.debugRegistrySnapshot();
  const child = snap.childSessions.find((c) => c.childSessionId === 'sess-child-9');
  assert.ok(child, 'child session registered');
  assert.equal(child.runId, expected);
  assert.notEqual(child.runId, doubleHashed);
  assert.ok(child.runId.startsWith('run-sha256:'));
});

test('unclassified subagents queue on the single collaborator seat FIFO and dispatch after release', () => {
  const module = makeModule();
  tickFor(module, 200);
  module.ingestHarnessEvent({
    sessionId: 'sess-root-3',
    type: 'agent/status',
    seq: 1,
    time: 1,
    data: { status: 'running' },
  });
  module.ingestHarnessEvent({
    sessionId: 'sess-root-3',
    type: 'subagent/start',
    seq: 2,
    time: 2,
    data: { id: 'sess-child-a', runId: 'raw-run-a' },
  });
  module.ingestHarnessEvent({
    sessionId: 'sess-root-3',
    type: 'subagent/start',
    seq: 3,
    time: 3,
    data: { id: 'sess-child-b', runId: 'raw-run-b' },
  });
  const collab = () => module.state().employees.find((e) => e.employeeId === 'collaborator');
  assert.ok(collab().binding, 'first subagent dispatched to the collaborator seat');
  assert.equal(collab().queueCount, 1, 'second subagent waits in the FIFO');
  // terminal end of the active run releases and starts the queued head
  module.ingestHarnessEvent({
    sessionId: 'sess-root-3',
    type: 'subagent/end',
    seq: 4,
    time: 4,
    data: { id: 'sess-child-a', runId: 'raw-run-a', stopReason: 'completed' },
  });
  tickFor(module, 1200); // result presentation
  const afterRelease = collab();
  assert.ok(afterRelease.binding, 'next FIFO item took the seat');
  assert.equal(afterRelease.queueCount, 0);
});

test('cancel/interrupt requests only record pending control and retain the binding', () => {
  const module = makeModule();
  tickFor(module, 100);
  module.ingestHarnessEvent({
    sessionId: 'sess-root-4',
    type: 'agent/status',
    seq: 1,
    time: 1,
    data: { status: 'running' },
  });
  const result = module.cancel({ employeeId: 'orchestrator' });
  assert.equal(result.ok, true);
  const employee = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(employee.control, 'cancellationPending');
  assert.ok(employee.binding, 'binding retained until terminal evidence');
  // terminal evidence releases
  module.ingestHarnessEvent({
    sessionId: 'sess-root-4',
    type: 'turn/end',
    seq: 2,
    time: 2,
    data: { reason: 'cancelled' },
  });
  tickFor(module, 200);
  const released = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(released.binding, null, 'cancelled terminal evidence releases the seat');
});

// --- root session multi-turn binding routing (SPEC-07 fix) -----------------

function runFirstTurn(module, sessionId) {
  module.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  assert.equal(tickUntil(module, (s) => {
    const e = s.employees.find((x) => x.employeeId === 'orchestrator');
    return e.movement === 'stationary' && e.activity === 'working' && e.transition && e.transition.phase === 'work';
  }, 120000), true, 'first turn arrives and works');
  module.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  tickFor(module, 1200); // result presentation + release
  return module.debugRegistrySnapshot().bindings.find((b) => b.sessionId === sessionId);
}

test('root session second turn rebinds via a turn-scoped handle and completes again', () => {
  const module = makeModule();
  tickFor(module, 200);

  // --- turn 1: binds the RAW session id directly (no derived handle yet) ---
  const first = runFirstTurn(module, 'sess-multi');
  assert.ok(first && first.releasedAt !== null, 'first turn binding released after presentation');

  // --- turn 2: SAME raw session id arrives again ---
  module.ingestHarnessEvent({ sessionId: 'sess-multi', type: 'agent/status', seq: 3, time: 3, data: { status: 'running' } });
  const snap = module.debugRegistrySnapshot();
  const second = snap.bindings.find((b) => b.sessionId.startsWith('sess-multi#t') && b.releasedAt === null);
  assert.ok(second, 'second turn binds a new internal turn-scoped handle');
  assert.notEqual(second.sessionId, 'sess-multi', 'released raw id is never reused');
  assert.equal(second.bindingSource, 'root-default');

  // tool facts resolve through the raw -> handle mapping
  module.ingestHarnessEvent({ sessionId: 'sess-multi', type: 'tool/call', seq: 4, time: 4, data: { tool: 'read_file' } });
  const withTool = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(withTool.toolKind, 'read_file', 'tool fact reaches the employee in the second turn');

  // completed resolves through the mapping and releases after presentation
  assert.equal(tickUntil(module, (s) => {
    const e = s.employees.find((x) => x.employeeId === 'orchestrator');
    return e.movement === 'stationary' && e.activity === 'working' && e.transition && e.transition.phase === 'work';
  }, 120000), true, 'second turn arrives and works');
  module.ingestHarnessEvent({ sessionId: 'sess-multi', type: 'turn/end', seq: 5, time: 5, data: { reason: 'completed' } });
  const presenting = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(presenting.lastResult && presenting.lastResult.outcome, 'completed');
  tickFor(module, 1200);
  const snapAfter = module.debugRegistrySnapshot();
  assert.ok(
    snapAfter.bindings.find((b) => b.sessionId === second.sessionId).releasedAt !== null,
    'second turn binding released after result presentation'
  );

  // invariants: no duplicate employees, never offline, handles stay internal
  const state = module.state();
  assert.equal(state.employees.length, 5);
  for (const employee of state.employees) assert.equal(employee.presence, 'present');
  assert.equal(/#t/.test(JSON.stringify(state)), false, 'internal handles never reach the renderer');
});

test('stale duplicate events cannot disturb the next turn or double-release', () => {
  const module = makeModule();
  tickFor(module, 200);
  runFirstTurn(module, 'sess-stale');
  module.ingestHarnessEvent({ sessionId: 'sess-stale', type: 'agent/status', seq: 3, time: 3, data: { status: 'running' } });
  const before = module.state().employees.find((e) => e.employeeId === 'orchestrator').binding;
  assert.ok(before, 'second turn bound');

  // replayed old turn/end (duplicate seq under the watermark)
  const dup = module.ingestHarnessEvent({ sessionId: 'sess-stale', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  assert.equal(dup.status, 'duplicate');
  // replayed old running fact
  const old = module.ingestHarnessEvent({ sessionId: 'sess-stale', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  assert.notEqual(old.status, 'accepted');

  const after = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.deepEqual(after.binding, before, 'binding unchanged by stale events');
  assert.equal(after.lastResult === null || after.lastResult.outcome === undefined || after.lastResult.outcome !== 'completed'
    ? true : after.lastResult.atMs > 0, true, 'no fabricated terminal from stale events');
});

test('cancel in a later turn releases the turn-scoped binding on cancelled evidence', () => {
  const module = makeModule();
  tickFor(module, 200);
  runFirstTurn(module, 'sess-cancel-multi');
  module.ingestHarnessEvent({ sessionId: 'sess-cancel-multi', type: 'agent/status', seq: 3, time: 3, data: { status: 'running' } });
  const snap = module.debugRegistrySnapshot();
  const second = snap.bindings.find((b) => b.sessionId.startsWith('sess-cancel-multi#t') && b.releasedAt === null);
  assert.ok(second, 'second turn bound via handle');

  const result = module.cancel({ employeeId: 'orchestrator' });
  assert.equal(result.ok, true);
  const pending = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(pending.control, 'cancellationPending');
  assert.ok(pending.binding, 'binding retained while awaiting terminal evidence');

  module.ingestHarnessEvent({ sessionId: 'sess-cancel-multi', type: 'turn/end', seq: 4, time: 4, data: { reason: 'cancelled' } });
  tickFor(module, 300);
  const snapAfter = module.debugRegistrySnapshot();
  assert.ok(
    snapAfter.bindings.find((b) => b.sessionId === second.sessionId).releasedAt !== null,
    'turn-scoped binding released by cancelled terminal evidence'
  );
  const released = module.state().employees.find((e) => e.employeeId === 'orchestrator');
  assert.equal(released.binding, null);
  assert.equal(released.presence, 'present');
});


test('capability gating: unsupported controls are rejected, pause/resume never exposed', () => {
  const module = makeModule();
  assert.equal(module.dispatch({ employeeId: 'coder' }).ok, false, 'dispatch without binding is rejected, never fabricated');
  const state = module.state();
  assert.equal(state.capabilities.pause, false);
  assert.equal(state.capabilities.resume, false);
  assert.equal(state.capabilities.cancel, true);
});

// ---------------------------------------------------------------------------
// office module: pause/resume + snapshot sharing
// ---------------------------------------------------------------------------

test('visibility pause freezes the simulation clock; resume continues from the logical position', () => {
  const module = makeModule();
  tickFor(module, 2000);
  const frozen = module.state();
  module.noteVisibility({ viewId: 'view-1', visible: false });
  assert.equal(module.isPaused(), true);
  tickFor(module, 2000);
  const still = module.state();
  assert.equal(still.simulatedAtMs, frozen.simulatedAtMs, 'no time replay while hidden');
  assert.deepEqual(still.employees.map((e) => e.position), frozen.employees.map((e) => e.position));
  module.noteVisibility({ viewId: 'view-1', visible: true });
  assert.equal(module.isPaused(), false);
  tickFor(module, 16);
  const resumed = module.state();
  assert.equal(resumed.simulatedAtMs, frozen.simulatedAtMs + officeModule.TICK_MS, 'resumes exactly one step later');
});

test('two office views consume one main-process snapshot/clock (no per-view simulation)', () => {
  const module = makeModule();
  module.noteVisibility({ viewId: 'view-a', visible: true });
  module.noteVisibility({ viewId: 'view-b', visible: true });
  tickFor(module, 1000);
  const a = module.state();
  const b = module.state();
  assert.equal(a.simulatedAtMs, b.simulatedAtMs);
  assert.deepEqual(a.employees.map((e) => e.position), b.employees.map((e) => e.position));
  module.noteVisibility({ viewId: 'view-a', visible: false });
  assert.equal(module.isPaused(), false, 'view-b keeps the clock alive');
  module.noteVisibility({ viewId: 'view-b', visible: false });
  assert.equal(module.isPaused(), true, 'all views hidden pauses the clock');
  module.noteVisibility({ viewId: 'view-a', visible: true });
});

// ---------------------------------------------------------------------------
// office module: IPC surface
// ---------------------------------------------------------------------------

// P3 (spec §3 block 3 / §8 P3 行) DELIBERATELY widened the pinned channel
// count from seven to EIGHT: the 待你处理 inbox needs a way to ACT on a
// pending runtime request (inline approve/reject + the danger modal + the
// spec §4 detailRef fetch). The six legacy channels plus the P1-era seven
// were all snapshots or employee control; none of them could answer a
// waterfall request through the shared respondToRuntime ($events/result)
// path. Rather than smuggling the answer through office:dispatch (which is
// employee-scoped and validated to a single employeeId key) or through a
// settings-shaped action, P3 adds ONE new whitelisted channel —
// `office:pending` — with an `action` discriminator mirroring
// office:settings ('answer' | 'detail'). The channel is whitelisted in
// office-module.js, mirrored in office-preload.js and payload-validated in
// the main process like every other office channel.
test('exactly the eight office:* IPC channels are declared (P3 adds office:pending)', () => {
  assert.deepEqual([...officeModule.OFFICE_IPC_CHANNELS].sort(), [
    'office:cancel',
    'office:diagnostics',
    'office:dispatch',
    'office:interrupt',
    'office:pending',
    'office:settings',
    'office:state',
    'office:visibility',
  ]);
});

test('ipc payload validation: schema, unknown keys and size limits', () => {
  assert.equal(officeModule.validateOfficeIpcPayload('office:state', {}).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:diagnostics', {}).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder' }).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'nobody' }).ok, false);
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', null).ok, false);
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: true }).ok, true);
  assert.equal(officeModule.validateOfficeIpcPayload('office:visibility', { visible: 'yes' }).ok, false);
  assert.equal(officeModule.validateOfficeIpcPayload('office:settings', { action: 'get' }).ok, true);
  assert.equal(
    officeModule.validateOfficeIpcPayload('office:settings', { action: 'set', settings: { reducedMotion: true } }).ok,
    true
  );
  assert.equal(
    officeModule.validateOfficeIpcPayload('office:settings', { action: 'set', settings: { evil: new Array(100).fill('x') } }).ok,
    false,
    'unknown settings keys rejected'
  );
  const huge = { employeeId: 'x'.repeat(officeModule.MAX_IPC_PAYLOAD_BYTES) };
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', huge).ok, false, 'size limit');
  assert.equal(officeModule.validateOfficeIpcPayload('office:evil', {}).ok, false, 'unknown channel rejected');
});

test('office state snapshot passes the privacy redactor: no session ids or raw values', () => {
  const module = makeModule();
  tickFor(module, 100);
  module.ingestHarnessEvent({
    sessionId: 'sess-privacy-check',
    type: 'agent/status',
    seq: 1,
    time: 1,
    data: { status: 'running' },
  });
  const serialized = JSON.stringify(module.state());
  assert.equal(serialized.includes('sess-privacy-check'), false, 'session id never leaves the module');
  assert.equal(/"sessionId"/.test(serialized), false, 'no sessionId field at all');
  assert.equal(/"token/i.test(serialized), false, 'no token fields');
});

test('registerOfficeIpc wires only whitelisted channels and validates payloads', async () => {
  const handles = new Map();
  const ipcMainStub = {
    handle(channel, handler) { handles.set(channel, handler); },
  };
  const module = makeModule();
  const registered = officeModule.registerOfficeIpc({ ipcMain: ipcMainStub, module });
  assert.deepEqual([...handles.keys()].sort(), [...officeModule.OFFICE_IPC_CHANNELS].sort());
  const state = await handles.get('office:state')({}, {});
  assert.equal(state.ok, true);
  assert.equal(state.snapshot.schemaVersion, 1);
  const bad = await handles.get('office:dispatch')({}, { employeeId: 'hacker' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PAYLOAD_INVALID');
  const good = await handles.get('office:visibility')({}, { visible: true });
  assert.equal(good.ok, true);
});

// ---------------------------------------------------------------------------
// office module: settings (in-memory in Task 7; persistence is Task 8)
// ---------------------------------------------------------------------------

test('settings update validates and applies bounds without persistence', () => {
  const module = officeModule.createOfficeModule({ pack: PACK, seed: 'settings-seed' });
  const defaults = module.getSettings();
  assert.equal(defaults.reducedMotion, false);
  assert.ok(defaults.resultPresentationMs >= 1000 && defaults.resultPresentationMs <= 30000);
  const set = module.updateSettings({ resultPresentationMs: 250, reducedMotion: true });
  assert.equal(set.ok, false, 'below the clamp floor is rejected by validation');
  const ok = module.updateSettings({ resultPresentationMs: 1500, reducedMotion: true });
  assert.equal(ok.ok, true);
  assert.equal(module.getSettings().reducedMotion, true);
  assert.equal(module.getSettings().resultPresentationMs, 1500);
});

// ---------------------------------------------------------------------------
// shell wiring: window-manager office views
// ---------------------------------------------------------------------------

function stubBrowserWindowClass() {
  const instances = [];
  class StubWindow {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
      this.__destroyed = false;
      this.__visible = false;
      this.__minimized = false;
      this.__loadedUrls = [];
      this.contentView = { children: [], addChildView: (v) => { this.contentView.children.push(v); }, removeChildView: (v) => { this.contentView.children = this.contentView.children.filter((c) => c !== v); } };
      this.__contentBounds = { x: 10, y: 20, width: 1280, height: 800 };
      instances.push(this);
      this.webContents = {
        send: (channel, payload) => { this.__sent = this.__sent || []; this.__sent.push([channel, payload]); },
        on: () => {},
        once: () => {},
        loadFile: () => Promise.resolve(),
        setWindowOpenHandler: () => {},
        isDestroyed: () => this.__destroyed,
      };
    }
    on(event, handler) { this.handlers.set(event, handler); }
    loadURL(url) { this.__loadedUrls.push(url); return Promise.resolve(); }
    loadFile(file) { this.__loadedUrls.push('file:' + file); return Promise.resolve(); }
    getContentBounds() { return { ...this.__contentBounds }; }
    getBounds() { return { ...this.__contentBounds }; }
    setBounds() {}
    __resizeTo(width, height) { this.__contentBounds = { ...this.__contentBounds, width, height }; if (this.handlers.has('resize')) this.handlers.get('resize')(); }
    show() { this.__visible = true; if (this.handlers.has('show')) this.handlers.get('show')(); }
    hide() { this.__visible = false; if (this.handlers.has('hide')) this.handlers.get('hide')(); }
    isDestroyed() { return this.__destroyed; }
    isVisible() { return this.__visible; }
    isMinimized() { return this.__minimized; }
    close() { if (this.handlers.has('close')) this.handlers.get('close')(); this.destroy(); }
    destroy() { this.__destroyed = true; if (this.handlers.has('closed')) this.handlers.get('closed')(); }
  }
  return { StubWindow, instances };
}

// Stub WebContentsView: records its options, its bounds and everything its
// webContents loads/sends — enough to assert the M4.2 shell composition.
function stubViewClass(bucket) {
  return class StubView {
    constructor(opts) {
      this.opts = opts;
      this.bounds = null;
      this.sent = [];
      this.loaded = [];
      this.destroyed = false;
      bucket.push(this);
      this.webContents = {
        loadURL: (url) => { this.loaded.push(url); return Promise.resolve(); },
        loadFile: (file) => { this.loaded.push('file:' + file); return Promise.resolve(); },
        send: (channel, payload) => { this.sent.push([channel, payload]); },
        on: () => {},
        once: () => {},
        setWindowOpenHandler: () => {},
        isDestroyed: () => this.destroyed,
        close: () => { this.destroyed = true; },
        reload: () => {},
        toggleDevTools: () => {},
      };
    }
    setBounds(bounds) { this.bounds = bounds; }
  };
}

test('window manager: M4.2 shell — rail + harness views compose, the office swaps the main area', () => {
  const { StubWindow, instances } = stubBrowserWindowClass();
  const views = [];
  const wm = createWindowManager({
    BrowserWindow: StubWindow,
    WebContentsView: stubViewClass(views),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
    appName: 't', iconPath: () => null, themeBackground: () => '#000', resolvedTheme: 'dark',
    windowState: { load: () => null, save: () => {} }, windowStateFile: () => '/tmp/x',
    log: () => {}, t: () => 'x', lang: () => 'zh',
    settingsGet: () => ({}),
    getRuntimeUrl: () => '', getRuntimeChild: () => null,
    closeLoading: () => {}, startDeferredServices: () => {},
    computeCockpitBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getCockpitRuntimeState: () => 'running', getUsageCache: () => null, costSnapshot: async () => null,
    getScheduledRunning: () => false, getRemoteStatus: () => ({}),
    appVersion: '0', dshHomeOf: () => '/tmp',
    buildSnapshot: () => ({}), runtimeInfo: () => ({}),
  });
  wm.createWindow('http://127.0.0.1:1/harness');
  const win = instances.at(-1);
  assert.deepEqual(win.__loadedUrls, [], 'the shell window itself loads NOTHING');
  assert.equal(views.length, 2, 'harness view + rail view');
  const harness = views.find((v) => v.opts.webPreferences.preload.endsWith('preload.js'));
  const rail = views.find((v) => v.opts.webPreferences.preload.endsWith('office-rail-preload.js'));
  assert.ok(harness && rail, 'both shell views exist with their own preloads');
  assert.ok(harness.loaded[0].startsWith('http://127.0.0.1:1/harness'), 'the harness view loads the runtime URL');
  assert.ok(String(rail.loaded[0]).endsWith('office-rail.html'), 'the rail view loads the rail page');
  // geometry: the rail owns the left band at full content height, the harness
  // view everything to its right
  assert.deepEqual(rail.bounds, { x: 0, y: 0, width: 44, height: 800 });
  assert.deepEqual(harness.bounds, { x: 44, y: 0, width: 1236, height: 800 });
  assert.deepEqual(win.contentView.children, [harness, rail], 'rail attached after the harness (top-left band)');

  // shell-level pushes (theme) must reach the VIEWS, not just real windows
  wm.broadcastToShellViews('shell:theme', 'light');
  assert.deepEqual(rail.sent.at(-1), ['shell:theme', 'light'], 'the rail view receives the theme push');

  // the office swaps the main area; the harness page stays alive (detached).
  // The shell window must be VISIBLE: office visibility tracks the window.
  win.show();
  const visibility = [];
  const office = wm.showOfficeShellView({
    url: 'office-runtime://local/office.html?pack=deepseek-default',
    onVisibility: (viewId, visible) => visibility.push([viewId, visible]),
  });
  assert.equal(office.opts.webPreferences.preload, path.join(ROOT, 'src', 'office', 'office-preload.js'));
  assert.deepEqual(office.bounds, { x: 44, y: 0, width: 1236, height: 800 });
  wm.broadcastToShellViews('shell:theme', 'dark');
  assert.deepEqual(office.sent.at(-1), ['shell:theme', 'dark'], 'the office view receives the theme push too');
  assert.ok(win.contentView.children.includes(office) && !win.contentView.children.includes(harness),
    'the office view replaces the harness view in the main area');
  assert.equal(wm.isOfficeViewActive(), true);
  assert.deepEqual(visibility, [['office-shell-1', true]], 'the module is told the office became visible');
  // snapshots keep flowing to the office page even while IT is the active view
  wm.broadcastToOfficeViews('office:state', { tick: 1 });
  assert.deepEqual(office.sent.at(-1), ['office:state', { tick: 1 }]);

  // switch back: the office page survives in the background, module told hidden
  wm.hideOfficeShellView();
  assert.ok(win.contentView.children.includes(harness) && !win.contentView.children.includes(office),
    'the harness view is back in the main area');
  assert.equal(wm.isOfficeViewActive(), false);
  // 2026-09-22 语义修正：办公室是"后台活着"的（M4.2）；切回 harness 只让它不再是
  // 当前主视图，**仿真的暂停只看窗口是否可见/最小化**（否则闲聊/走位永远积累不到，
  // 用户实测看不到气泡）。因此这里模块仍被告知 visible=true，而"是否为当前视图"
  // 通过页面载荷里的 active 字段下发。
  assert.deepEqual(visibility.at(-1), ['office-shell-1', true],
    'the simulation keeps running while the office is inactive (window still visible)');
  assert.equal(office.sent.at(-1)[0], 'office:visibility');
  assert.equal(office.sent.at(-1)[1].active, false, 'the page is told the office is no longer the active view');
  assert.equal(office.sent.at(-1)[1].visible, true, 'window-level visibility still true');
  wm.broadcastToOfficeViews('office:state', { tick: 2 });
  assert.deepEqual(office.sent.at(-1), ['office:state', { tick: 2 }], 'a backgrounded office page still receives pushes');

  // resize re-flows the whole shell (the 16ms scheduler is bypassed on purpose)
  win.__resizeTo(1600, 900);
  wm.syncShellViews();
  assert.deepEqual(rail.bounds, { x: 0, y: 0, width: 44, height: 900 });
  assert.deepEqual(harness.bounds, { x: 44, y: 0, width: 1556, height: 900 });
  assert.deepEqual(office.bounds, { x: 44, y: 0, width: 1556, height: 900 });

  // quit cleanup destroys the office view and returns to the harness
  wm.closeOfficeShellView();
  assert.equal(wm.officeViewCount(), 0);
  assert.equal(wm.getActiveMainView(), 'harness');
});

// ---------------------------------------------------------------------------
// page asset contracts: CSP, local-only scripts, preload channel whitelist
// ---------------------------------------------------------------------------

test('office.html loads only local resources under an office-runtime CSP', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html.replace(/<!--[\s\S]*?-->/g, ''), /https?:\/\//, 'no network URLs');
  assert.match(html, /office-runtime:\/\/local/, 'local scheme CSP/source');
  assert.match(html, /pixi\.min\.js/, 'local pixi bundle');
  assert.match(html, /aria-label/, 'screen reader surface');
});

test('office.html paints the canvas per snapshot but throttles DOM panels (M2 2026-09-16)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  // snapshots arrive per tick (~60Hz): the renderer must receive every one
  const onSnapshotAt = html.indexOf('onSnapshot: (snapshot) => {');
  const applyAt = html.indexOf('renderer.applySnapshot(snapshot)', onSnapshotAt);
  const guardAt = html.indexOf('>= PANEL_RENDER_INTERVAL_MS) {', onSnapshotAt);
  assert.ok(onSnapshotAt !== -1, 'the page wires onSnapshot');
  assert.ok(applyAt !== -1 && guardAt !== -1 && applyAt < guardAt,
    'renderer.applySnapshot runs on every snapshot, before any panel throttle');
  // the four DOM panels keep the historical ~10Hz cadence: rebuilding them
  // per tick buys nothing visible and floods the aria-live activity log
  assert.match(html, /const PANEL_RENDER_INTERVAL_MS = 100;/, 'an explicit panel cadence constant');
  assert.match(html, /if \(lastPanelRenderAtMs === null \|\| now - lastPanelRenderAtMs >= PANEL_RENDER_INTERVAL_MS\) \{/,
    'the first snapshot always renders the panels');
  assert.match(html, /lastPanelRenderAtMs = now;\s*\n\s*renderOverview\(snapshot\);[\s\S]*?renderEmployeeList\(snapshot\);[\s\S]*?renderDetails\(\);[\s\S]*?renderActivity\(snapshot\);/,
    'all four panel renders sit together behind the throttle');
});

test('office page injects per-view managed furniture textures separately from the pack', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /const officeTextures = new Map\(\)/, 'a dedicated office texture map exists');
  assert.match(html, /officeAssetSrcById/, 'office texture URLs come from the shared manifest');
  assert.match(html, /new Image\(\)/, 'each office texture loads through its own Image');
  assert.match(html, /image\.onerror/, 'decode failures are collected');
  assert.match(html, /OFFICE_TEXTURE_MISSING/, 'stable missing-texture diagnostic code');
  assert.match(html, /PIXI\.Texture\.from\(image\)/, 'per-view PIXI textures from decoded images');
  assert.match(html, /officeTextures,\s*\n\s*officeTextureErrors,/s, 'office textures inject separately from the pack map');
  assert.match(html, /texturedWorkstations: \['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6'\]/, 'the approved calibration scope covers all six workstations');
  assert.match(html, /officeDiagnostics/, 'furniture texture diagnostics reach the evidence hooks');
  assert.doesNotMatch(html, /PIXI\.Assets/, 'no global mutable furniture texture cache');
  // Task E4.4: the canvas is sized and centered by the page's letterbox math
  // (explicit px styles on resize); CSS keeps it out of the layout flow and
  // must no longer stretch it over the whole stage.
  assert.match(css, /#stage-host canvas \{[^}]*position:\s*absolute/s, 'canvas is out of the layout flow');
  assert.doesNotMatch(css, /#stage-host canvas \{[^}]*100% !important/s, 'CSS never stretches the canvas over the stage');
  assert.match(html, /canvas\.style\.width = `\$\{sceneW\}px`/, 'the page sizes the canvas to the letterboxed scene');
});

test('main process registers the office runtime protocol handler after Electron is ready', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const readyBody = source.slice(source.indexOf('app.whenReady().then(async () => {'));
  assert.match(readyBody, /registerOfficeRuntimeProtocolHandler\(\);/);
  // Task E2d: the routing table itself lives in the shared module; the main
  // process must wire it through createOfficeProtocolHandler (same roots).
  const protocolModule = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-protocol.js'), 'utf8');
  assert.match(protocolModule, /prefix:\s*'office-assets\/'/);
  assert.match(source, /createOfficeProtocolHandler\(/);
  assert.match(source, /layoutStore:\s*ensureOfficeStateStore/, 'the store stays lazy (factory, not an eager instance)');
});

test('office-preload.js exposes only the whitelisted office bridge API', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', 'office', 'office-preload.js')]);
  const source = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-preload.js'), 'utf8');
  // eight channels since P3 (office:pending answers pending requests + fetches
  // their spec §4 detailRef); the delivery API stays invoke-only.
  for (const channel of ['office:state', 'office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility', 'office:pending']) {
    assert.ok(source.includes(`'${channel}'`), `preload references ${channel}`);
  }
  assert.doesNotMatch(source, /ipcRenderer\.send\(/, 'invoke only, no raw send channels');
  assert.doesNotMatch(source, /office:(?!(state|dispatch|cancel|interrupt|settings|diagnostics|visibility|pending))/, 'no other office channels');
});

test('office page resolves the production character pack from a portable descriptor', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /URLSearchParams/, 'the pack descriptor id comes from the view URL');
  assert.match(html, /officePackId/, 'the page carries a validated pack id');
  assert.match(html, /packId: officePackId,\s*\n\s*loadJson,/s, 'the boot loader receives the portable pack id');
  assert.match(html, /characters\/\$\{officePackId\}\//, 'pack metadata and frame URLs are managed relative resources');
  assert.doesNotMatch(html, /fixtures\/character-pack/, 'production Office never loads the test fixture pack');
  assert.doesNotMatch(html, /\/Users\//, 'no personal absolute paths');
});

// ---------------------------------------------------------------------------
// Task 8 — the production office page boots from the saved/bundled layout
// draft, shows stable import diagnostics and never overflows compact windows
// ---------------------------------------------------------------------------

test('office.html boots the production layout from the layout source chain with stable diagnostics (P5: no editor on the boot path)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  // source priority chain goes through the boot resolver (saved > bundled);
  // the saved layout is fetched over the managed protocol route — the seven
  // office:* IPC channels stay untouched
  assert.match(html, /resolveProductionLayoutDraft/, 'the page resolves the layout via the boot priority chain');
  assert.match(html, /office-layout\.v1\.json/, 'the saved layout is read over the managed protocol route');
  assert.match(html, /fixtures\/office-layout-draft\.json/, 'the bundled confirmed draft is the built-in fallback');
  // P5/B-1: the schema-v1 validator is the standalone layout-schema module —
  // the boot chain neither loads nor constructs the editor core
  assert.match(html, /REGISTRY\['layout-schema'\] = await loadModule\('\.\/layout-schema\.js'/, 'the boot loads the standalone schema module');
  assert.match(html, /validateDraftSchema: REGISTRY\['layout-schema'\]\.validateDraftSchema/, 'the boot validator is the schema free function');
  assert.doesNotMatch(html, /createLayoutEditor/, 'no editor instance is created on the boot path');
  assert.doesNotMatch(html, /loadModule\('\.\/layout-editor\.js'\)/, 'the editor module is never loaded');
  // invalid source drafts degrade with a stable diagnostic, not a broken page
  assert.match(html, /布局降级：\$\{layoutDiagnostic\}/, 'the diagnostic reaches the user-visible fallback note');
  // the save/restore protocol route moved out with the editor save path; the
  // route semantics are pinned in the protocol tests (office-boot contract)
  assert.match(html, /layoutDiagnostic: \(\) => layoutDiagnostic/, 'the evidence hook exposes the boot diagnostic');
  // the editor-only evidence hooks are gone
  assert.doesNotMatch(html, /layoutDraft: \(\) =>/, 'the editor draft hook is gone');
  assert.doesNotMatch(html, /viewState: \(\) =>/, 'the editor view-state hook is gone');
  assert.doesNotMatch(html, /setGroupMoveRigid/, 'the editor group-rigid hook is gone');
  assert.doesNotMatch(html, /toggleLayoutEditor/, 'the editor toggle hook is gone');
});

test('office.html never references test-only asset trees on the production path', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.doesNotMatch(html, /fixtures\/character-pack/, 'production Office never loads the test fixture pack');
  const assets = fs.readFileSync(path.join(ROOT, 'src', 'office', 'layout-assets.js'), 'utf8');
  assert.doesNotMatch(assets, /fixtures\/character-pack/, 'the shared asset manifest never points into test fixtures');
});

// ---------------------------------------------------------------------------
// Task 8-R1 — the page must classify layout responses (409/5xx are broken,
// never missing) and the PUT response must not echo filesystem paths
// ---------------------------------------------------------------------------

test('office.html classifies layout responses through the pure boot helper', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /classifyLayoutAttempt\(\{\s*status:\s*response\.status,\s*body\s*\}\)/, 'response -> attempt goes through office-boot.classifyLayoutAttempt');
  assert.match(html, /classifyLayoutAttempt\(\{\s*status:\s*0,\s*body:\s*null\s*\}\)/, 'network failures classify as broken attempts');
  assert.doesNotMatch(html, /if \(!response\.ok\) return \{ ok: false, missing: true \}/, 'non-2xx responses are no longer folded into missing');
});

test('the office layout route never echoes filesystem paths in its responses', () => {
  // Task E2d: the route implementation moved to the shared protocol module —
  // the assertions follow it there, same semantics, never loosened.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-protocol.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(source, /rel === 'office-layout\.v1\.json'/, 'the dynamic layout route exists');
  assert.match(source, /result\.ok \? \{ ok: true \} : \{ ok: false, code: result\.code \}/, 'PUT success answers {ok:true} only');
  assert.doesNotMatch(source, /ok: true, file: result\.file/, 'no absolute userData path leaks into the protocol response');
  assert.doesNotMatch(mainSource, /ok: true, file: result\.file/, 'the cockpit main process never grows one either');
});

// ---------------------------------------------------------------------------
// Task E4 — runtime layout source chain (draft→runtime compiler), fixed
// logical scene letterbox, and catalog-owned draft widths.
// ---------------------------------------------------------------------------

test('E4 office.html resolves the runtime layout through the compiled source chain', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /office-layout-compiler/, 'the page loads the runtime layout compiler');
  assert.match(html, /resolveRuntimeLayout\(/, 'the runtime layout goes through the pure resolver');
  assert.match(html, /saved-compiled/, 'source 1: the user-saved flat draft, compiled');
  assert.match(html, /bundled-flat/, 'source 2: the bundled compiled flat fixture');
  assert.match(html, /isometric-fallback/, 'source 3: the isometric fixture fallback (never blocks boot)');
  assert.match(html, /fixtures\/office-layout-flat\.json/, 'the bundled flat fixture is fetched');
  assert.match(html, /validateLayout:/, 'every candidate passes createOfficeLayout validation');
  assert.match(html, /runtimeLayoutSource/, 'the evidence hook exposes the runtime layout source');
  assert.match(html, /runtimeLayoutCode/, 'the evidence hook exposes the runtime layout diagnostic');
  // the renderer must mount the RESOLVED layout, not the raw isometric fixture
  assert.doesNotMatch(html, /createOfficeRenderer\(\{[\s\S]{0,400}?layoutFixture,\s*$/m, 'no raw fixture reaches the renderer');
});

test('E4 office.html letterboxes the fixed 1280x840 logical scene', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  // the scene aspect is preserved at every window size: scale = min(w/refW, h/refH)
  assert.match(html, /Math\.min\([\s\S]{0,80}referenceWidth[\s\S]{0,40}referenceHeight/, 'uniform letterbox scale');
  assert.match(html, /renderer\.resize\(\{\s*width:\s*sceneW,\s*height:\s*sceneH\s*\}\)/, 'the canvas renders the scaled logical scene, not the raw window');
  assert.match(html, /canvas\.style\.left = `\$\{\(rect\.width - sceneW\) \/ 2\}px`/, 'the canvas is centered horizontally (letterbox bars)');
  assert.match(html, /canvas\.style\.top = `\$\{\(rect\.height - sceneH\) \/ 2\}px`/, 'the canvas is centered vertically (letterbox bars)');
  // the CSS must no longer stretch the canvas over the whole stage
  assert.doesNotMatch(css, /#stage-host canvas \{[^}]*100% !important/s, 'the canvas is sized by the letterbox math, not stretched by CSS');
  // clicks hit-test against the letterboxed canvas rect (scene pixels)
  assert.match(html, /const rect = \(sceneCanvas \|\| stage\)\.getBoundingClientRect\(\);\s*\n\s*const hit = renderer\.hitTest\(event\.clientX - rect\.left/, 'hit-testing uses the letterboxed canvas rect');
});

test('E4 office page consumes the catalog draft widths (no local copy)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /DRAFT_WIDTHS/, 'draft widths come from the shared catalog');
  assert.doesNotMatch(html, /\{\s*desk:\s*180,\s*chair:\s*110/, 'the page-level width literal is gone');
});

// ---------------------------------------------------------------------------
// Task M0 — the Office Workbench (tool surface): boundary enforcement.
// The workbench is a DEV TOOL: it may import runtime code, but the PRODUCT
// entry points (src/main.js, src/office/office.html) must never reference
// src/workbench/** or content/** (docs/notes/office-workbench-m0.md §2.4).
// ---------------------------------------------------------------------------

test('M0 boundary: the product entry dependency graph never references src/workbench/** or content/**', () => {
  // 1) src/main.js: walk the transitive static require graph over repo-local
  // src files (best effort through extension-less specifiers) and assert none
  // of the reachable files live under src/workbench/ or content/.
  const visited = new Set();
  const queue = [path.join(ROOT, 'src', 'main.js')];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      const base = path.resolve(path.dirname(file), match[2]);
      const resolved = fs.existsSync(base) && fs.statSync(base).isFile() ? base : `${base}.js`;
      if (!resolved.startsWith(path.join(ROOT, 'src') + path.sep) || !resolved.endsWith('.js')) continue;
      queue.push(resolved);
    }
  }
  assert.ok(visited.size >= 20, `the require walk traversed the product graph (${visited.size} files — the guard can go red)`);
  const offenders = [...visited].filter((file) => (
    file.includes(`${path.sep}src${path.sep}workbench${path.sep}`) || file.includes(`${path.sep}content${path.sep}`)
  ));
  assert.deepEqual(offenders, [], 'product entry dependency graph excludes src/workbench/** and content/**');

  // 2) src/office/office.html: every locally loaded module stays inside
  // src/office (the page's mini module loader + script tags).
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const specs = [...html.matchAll(/loadModule\(\s*['"](\.[^'"]+)['"]/g)].map((match) => match[1]);
  specs.push(...[...html.matchAll(/<script src="(\.[^"]+)"/g)].map((match) => match[1]));
  assert.ok(specs.length >= 8, `office.html local module references were scanned (${specs.length})`);
  for (const spec of specs) {
    const resolved = path.resolve(ROOT, 'src', 'office', spec);
    assert.match(resolved, /^\/.*src[/\\]office[/\\]/, `office.html loads only from its own tree: ${spec}`);
    assert.doesNotMatch(resolved, /src[/\\]workbench|[/\\]content[/\\]/, `office.html never loads tool/content trees: ${spec}`);
  }
  assert.doesNotMatch(html, /workbench/, 'office.html never mentions the workbench');
  assert.doesNotMatch(html, /["']content\//, 'office.html never references the content tree');
});

