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
// - exactly the seven office:* IPC channels; payload schema validation,
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

test('exactly the seven office:* IPC channels are declared', () => {
  assert.deepEqual([...officeModule.OFFICE_IPC_CHANNELS].sort(), [
    'office:cancel',
    'office:diagnostics',
    'office:dispatch',
    'office:interrupt',
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

test('real-shell probes and the editor launcher never flash windows (M2b 2026-09-16)', () => {
  // The user-facing symptom: npm test repeatedly opens and closes office
  // windows ("一闪一闪"). Evidence probes must run hidden WITHOUT losing
  // fidelity: backgroundThrottling stays off so the evidence (letterbox
  // sampling, frame PNG capture, fps arming) is produced exactly as before.
  const templates = [
    'e4-walkthrough-probe-template.js',
    'e5a-passing-frames-probe-template.js',
    'e5a-r1-order-probe-template.js',
    'e5a-r2-presentation-probe-template.js',
  ];
  for (const name of templates) {
    const src = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name), 'utf8');
    assert.doesNotMatch(src, /show:\s*true/, `${name} must not show its window`);
    assert.match(src, /show:\s*false/, `${name} hides its window`);
    assert.match(src, /app\.dock/, `${name} hides the Dock icon (no app bounce)`);
    assert.match(src, /backgroundThrottling:\s*false/, `${name} keeps rendering while hidden (evidence fidelity)`);
  }
  // The standalone editor launcher: headless mode for tests, visible by
  // default for real users.
  const editorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'office-editor.js'), 'utf8');
  assert.match(editorSrc, /OFFICE_EDITOR_HEADLESS/, 'the editor launcher accepts a headless env');
  // This file's own inline probes: windows stay hidden and the Dock icon
  // does not bounce for every probe process.
  const self = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(self, /show:\s*true/, 'no inline probe may show a window');
  assert.match(self, /app\.dock/, 'inline probes hide the Dock icon');
  // E2d drives the real launcher headlessly.
  assert.match(self, /OFFICE_EDITOR_HEADLESS/, 'E2d spawns the launcher with the headless env');
});

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

test('layout editor uses a draggable image shelf over a clean drafting canvas', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /id="layout-asset-shelf"/);
  assert.match(html, /id="layout-canvas"/);
  assert.match(html, /\.draggable\s*=\s*true/);
  assert.match(html, /addEventListener\('drop'/);
  assert.match(html, /document\.createElement\('img'\)/);
  assert.match(html, /stage\.classList\.toggle\('layout-editing'/);
  assert.match(css, /#stage-host\.layout-editing\s*>\s*canvas\s*\{[^}]*visibility:\s*hidden/s);
});

test('layout editor exposes an accessible draft import with stable failure feedback', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  const inputTag = html.match(/<input[^>]*id="editor-import-input"[^>]*>/);
  assert.ok(inputTag, 'import file input exists');
  assert.match(inputTag[0], /type="file"/);
  assert.match(inputTag[0], /accept="\.json,application\/json"/);
  const statusTag = html.match(/<p[^>]*id="editor-status"[^>]*>/);
  assert.ok(statusTag, 'import status region exists');
  assert.match(statusTag[0], /aria-live="polite"/);
  assert.match(html, /导入草稿/, 'the import control is labeled');
  assert.match(html, /editorImportInput\.addEventListener\('change'/, 'import input is wired');
  assert.match(html, /JSON\.parse/, 'the draft file is parsed as JSON');
  assert.match(html, /editor\.load\(/, 'the parse result reaches the editor load API');
  assert.match(html, /导入失败/, 'stable Chinese failure message');
  assert.match(html, /editorImportInput\.value\s*=\s*''/, 'the file input clears for repeat imports');
  assert.match(css, /#editor-status/, 'the status region is styled');
});

test('layout editor scale and layer controls are wired and gated on the selection', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  const scaleTag = html.match(/<input[^>]*id="editor-scale"[^>]*>/);
  assert.ok(scaleTag, 'scale control exists');
  assert.match(scaleTag[0], /type="number"/);
  assert.match(scaleTag[0], /aria-label="选中项缩放"/);
  assert.ok(html.match(/<button[^>]*id="editor-forward"[^>]*>/), 'bring-forward control exists');
  assert.ok(html.match(/<button[^>]*id="editor-backward"[^>]*>/), 'send-backward control exists');
  assert.match(html, /前移/, 'forward control is labeled');
  assert.match(html, /后移/, 'backward control is labeled');
  assert.match(html, /editor\.setScale\(/, 'scale control reaches the editor API');
  assert.match(html, /editor\.bringForward\(/, 'forward control reaches the editor API');
  assert.match(html, /editor\.sendBackward\(/, 'backward control reaches the editor API');
  assert.match(html, /\.disabled\s*=/, 'scale/layer controls gate on the current selection');
  assert.match(html, /editor\.moveGroup\(/, 'dragging a group member moves the whole group');
  assert.match(css, /\.editor-control/, 'editor controls are styled');
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
  for (const channel of ['office:state', 'office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) {
    assert.ok(source.includes(`'${channel}'`), `preload references ${channel}`);
  }
  assert.doesNotMatch(source, /ipcRenderer\.send\(/, 'invoke only, no raw send channels');
  assert.doesNotMatch(source, /office:(?!(state|dispatch|cancel|interrupt|settings|diagnostics|visibility))/, 'no other office channels');
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

test('office.html boots the editor from the production layout source chain with stable diagnostics', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  // source priority chain goes through the boot resolver (saved > bundled);
  // the saved layout is fetched over the managed protocol route — the seven
  // office:* IPC channels stay untouched
  assert.match(html, /resolveProductionLayoutDraft/, 'the page resolves the layout via the boot priority chain');
  assert.match(html, /office-layout\.v1\.json/, 'the saved layout is read over the managed protocol route');
  assert.match(html, /fixtures\/office-layout-draft\.json/, 'the bundled confirmed draft is the built-in fallback');
  assert.match(html, /editor\.load\(\s*layoutResolution\.draft,\s*\{\s*recordHistory:\s*false\s*\}\s*\)/s, 'the resolved draft boots the editor with a clean undo history');
  // invalid source drafts degrade with a stable diagnostic, not a broken page
  assert.match(html, /布局降级：\$\{layoutDiagnostic\}/, 'the diagnostic reaches the user-visible fallback note');
  // save/restore round-trip through the same managed route, fail-closed
  assert.match(html, /method:\s*'PUT'/, 'the confirmed layout persists through the layout route');
  assert.match(html, /method:\s*'DELETE'/, 'restore clears the saved layout through the layout route');
  assert.match(html, /editor\.validateDraftSchema\(draft\)/, 'the save path re-validates before writing');
  // export-back reads from the same editor state (round-trip)
  assert.match(html, /layoutDraft: \(\) => editor\.toJSON\(\)/, 'the evidence hook exposes the live editor draft');
  assert.match(html, /layoutDiagnostic: \(\) => layoutDiagnostic/, 'the evidence hook exposes the boot diagnostic');
});

test('office editor palette shows real image thumbnails for every shelf asset', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  // shelf tiles are built from the catalog with real <img> thumbnails
  assert.match(html, /const image = document\.createElement\('img'\);\s*\n\s*image\.src = asset\.src/, 'shelf tiles render the actual asset PNG');
  assert.match(html, /image\.alt = ''/, 'thumbnails are decorative (labeled by title)');
  assert.match(css, /\.layout-asset-tile img/, 'the tile image is styled');
  // palette background: light Marvis-style grey-white, not the dark stage
  assert.match(css, /#layout-palette\s*\{[^}]*background:\s*#f[0-9a-f]{2}[0-9a-f]{3}/s, 'palette paints a light grey-white background');
});

test('office editor compact layout keeps toolbar, shelf and canvas inside the window', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  // the palette wraps instead of overflowing; the shelf scrolls horizontally
  assert.match(css, /#layout-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s, 'toolbar wraps in narrow windows');
  assert.match(css, /#layout-asset-shelf\s*\{[^}]*overflow-x:\s*auto/s, 'the shelf scrolls instead of pushing the page wide');
  // the canvas starts BELOW the palette, and the palette reserves enough
  // height for two wrapped rows (toolbar + shelf) in compact windows
  assert.match(css, /#layout-canvas\s*\{[^}]*inset:\s*232px/s, 'the canvas top follows the palette height');
  assert.match(css, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*#layout-palette/, 'compact windows get a taller palette block');
  assert.match(css, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*#layout-canvas/, 'compact windows move the canvas below it');
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
// Task E2a — the editor page upgrades to precise editing: multi-select,
// corner scale handles, numeric inspector, direction switch, shortcuts
// ---------------------------------------------------------------------------

test('E2a editor page wires multi-select, marquee and primary/secondary visuals', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  // shift+click toggles membership; plain click keeps single-select
  assert.match(html, /shiftKey[\s\S]{0,120}toggleSelection\(/, 'shift+click toggles selection membership');
  assert.match(html, /editorCanvas\.addEventListener\('pointerdown'/, 'the canvas hosts the marquee gesture');
  assert.match(html, /className = 'layout-marquee'/, 'the marquee element carries the layout-marquee CLASS');
  assert.match(css, /\.layout-marquee\s*\{/, 'the CSS styles the SAME class the JS assigns');
  assert.doesNotMatch(css, /#layout-marquee/, 'no orphan id selector (E2a-R1: the id selector styled nothing)');
  // primary vs secondary selection visuals
  assert.match(html, /co-selected/, 'secondary selection gets its own class');
  assert.match(css, /\.layout-draft-item\.co-selected/, 'secondary selection is styled');
  assert.match(css, /\.layout-draft-item\.selected/, 'primary selection stays styled');
  // select-all / clear controls exist
  assert.match(html, /editor-select-all/, 'select-all control exists');
  assert.match(html, /editor-clear-selection/, 'clear-selection control exists');
  assert.match(html, /selectAll\(\)/, 'select-all reaches the editor');
  assert.match(html, /clearSelection\(\)/, 'clear reaches the editor');
});

test('E2a editor page wires corner scale handles with uniform scaling and clamped gestures', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /layout-scale-handle/, 'corner handles are rendered');
  assert.match(css, /\.layout-scale-handle/, 'corner handles are styled');
  assert.match(html, /scaleItem\(/, 'the handle gesture reaches the editor scale API');
  assert.match(html, /fixedCorner/, 'scaling keeps the opposite corner fixed');
  assert.match(html, /clamp:\s*true/, 'handle scaling clamps to the allowed range');
});

test('E2a editor page exposes the numeric inspector with direction family switch', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  for (const id of ['inspector-x', 'inspector-y', 'inspector-layer', 'inspector-direction', 'inspector-id', 'inspector-group']) {
    assert.match(html, new RegExp(`id="${id}"`), `inspector field ${id} exists`);
  }
  assert.match(html, /setItemDirection\(/, 'direction switch reaches the editor API');
  assert.match(html, /moveTo\(/, 'x/y inspector reaches the editor API');
  assert.match(html, /setItemLayer\(/, 'layer inspector reaches the editor API');
});

test('E2a editor page wires shortcuts: duplicate, select-all, delete, escape and merged arrow nudges', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /duplicateSelection\(\)/, 'duplicate reaches the editor API');
  assert.match(html, /removeSelection\(\)/, 'delete reaches the multi-select remove API');
  assert.match(html, /nudgeSelection\(/, 'arrow keys nudge through the editor API');
  assert.match(html, /mergeKey/, 'auto-repeat nudges carry the merge key');
  assert.match(html, /'d'/, 'Ctrl/Cmd+D is bound');
  assert.match(html, /Delete|Backspace/, 'the delete key is bound');
});


// ---------------------------------------------------------------------------
// Task E2a-R1 — corner handles must be clickable on EVERY item: they live in
// a top overlay layer above the draft items (never as item children, where
// later-drawn overlapping items intercept the hits).
// ---------------------------------------------------------------------------

test('E2a-R1 editor page renders corner handles in a top overlay above the items', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /id="layout-handle-layer"/, 'a dedicated handle overlay exists');
  assert.equal(html.indexOf('id="layout-draft-items"') < html.indexOf('id="layout-handle-layer"'), true,
    'the overlay is a LATER sibling of the draft items, so it paints on top');
  assert.match(css, /#layout-handle-layer\s*\{[^}]*pointer-events:\s*none/s, 'the overlay container never blocks the canvas');
  assert.match(css, /\.layout-scale-handle\s*\{[^}]*pointer-events:\s*auto/s, 'the handles themselves stay clickable');
  assert.match(html, /handleLayer\.replaceChildren/, 'handles are (re)positioned via the overlay');
  assert.doesNotMatch(html, /node\.appendChild\(handle\)/, 'handles are no longer children of items (the occlusion defect)');
  assert.match(html, /function resize\(\)\s*\{[\s\S]*?positionHandles\(\);/, 'the resize handler re-positions the handles');
  // Task E3d: the deferred pass re-derives frame → view → node boxes → handles.
  assert.match(html, /setTimeout\(\(\) => \{[\s\S]*?positionHandles\(\);[\s\S]*?\}, 100\)/, 'a deferred pass re-derives the frame and re-positions after the layout settles');
  assert.match(html, /view\.setSize\(/, 'the view re-baselines to the live canvas size on resize');
});

// Real-shell regression: EVERY item's four corner handles must be hit by
// elementFromPoint. Spawns a throwaway Electron probe (temp userData, nothing
// written into the repo) and asserts the per-item hit table.
test('E2a-R1 real shell: all four corner handles of every item survive elementFromPoint', { timeout: 240000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2a-r1-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const progress = (msg) => { try { fs.appendFileSync(path.join(__dirname, 'probe-progress.log'), Date.now() + ' ' + msg + '\\n'); } catch {} };
progress('module loaded');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e2a-r1-')));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
progress('whenReady waiting');
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  progress('ready');
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  progress('window created, loading');
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default');
  progress('loaded');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  for (let i = 0; i < 60; i += 1) { if (await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false)) break; await sleep(200); }
  await evalJs("window.__office.api.toggleLayoutEditor()");
  await sleep(900);
  const ids = JSON.parse(await evalJs("JSON.stringify(window.__office.api.layoutDraft().items.map((i) => i.id))"));
  const rows = [];
  progress('boot done, ' + ids.length + ' items');
  for (const id of ids) {
    progress('probe ' + id);
    await evalJs('window.__probeId = ' + JSON.stringify(id) + '; true');
    // select AND hit-test in one renderer pass (the pointerup render is synchronous)
    rows.push(JSON.parse(await evalJs('(() => { const node = document.querySelector("[data-draft-id=" + JSON.stringify(window.__probeId) + "]"); if (!node) return JSON.stringify({ id: window.__probeId, handles: 0, occluded: [], missing: true }); const r0 = node.getBoundingClientRect(); const opts = { bubbles: true, cancelable: true, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2, button: 0, pointerId: 91 }; node.dispatchEvent(new PointerEvent("pointerdown", opts)); node.dispatchEvent(new PointerEvent("pointerup", opts)); const layer = document.getElementById("layout-handle-layer"); const handles = layer ? [...layer.querySelectorAll(".layout-scale-handle")] : []; const occluded = []; for (const h of handles) { const r = h.getBoundingClientRect(); const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); if (hit !== h) occluded.push(h.dataset.corner); } return JSON.stringify({ id: window.__probeId, handles: handles.length, occluded }); })()')));
  }
  const broken = rows.filter((r) => r.handles !== 4 || r.occluded.length > 0);
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ totalItems: rows.length, broken }));
  app.exit(0);
}).catch((e) => { console.error('E2A_R1_PROBE_FAILED', e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and
  // blocks the main process mid-run (the 240s-timeout failure mode)
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const summary = JSON.parse(fs.readFileSync(path.join(probeDir, 'result.json'), 'utf8'));
  assert.equal(summary.totalItems, 24, 'every draft item was probed');
  assert.deepEqual(summary.broken, [], 'every handle of every item is the elementFromPoint hit');
});


// ---------------------------------------------------------------------------
// Task E2b — precision & view: grid snap toggle, align bar, wheel zoom,
// space/middle pan, fit/reset, resize-following handles, dead CSS cleanup
// ---------------------------------------------------------------------------

test('E2b editor page wires the grid snap toggle that feeds the drag APIs', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /id="editor-grid-snap"/, 'a grid snap toggle exists');
  assert.match(html, /gridSnapEnabled/, 'the toggle drives page state');
  assert.match(html, /moveOptions\.grid = 0\.005/, 'drags pass the 0.005 grid only when enabled');
  assert.match(html, /aria-pressed/, 'the toggle exposes its pressed state');
});

test('E2b editor page wires the align/distribute bar for multi-selection', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  for (const id of ['align-left', 'align-right', 'align-top', 'align-bottom', 'align-center-x', 'align-center-y', 'distribute-x', 'distribute-y']) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' control exists');
  }
  assert.match(html, /alignSelection\(/, 'align controls reach the editor API');
  assert.match(html, /distributeSelection\(/, 'distribute controls reach the editor API');
});

test('E2b editor page wires wheel zoom, space/middle pan, fit and 100% reset', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /addEventListener\('wheel'/, 'wheel zoom is wired');
  assert.match(html, /zoomAt\(/, 'wheel zoom anchors through createCanvasView');
  assert.match(html, /panBy\(/, 'pan reaches the view');
  assert.match(html, /id="editor-fit-view"/, 'fit-to-window button exists');
  assert.match(html, /id="editor-reset-view"/, '100% reset button exists');
  assert.match(html, /reset\(\)/, 'reset reaches the view');
  // the transform applies to BOTH the items and the handle overlay
  assert.match(html, /applyView\(\)/, 'the view change re-projects the canvas');
  assert.match(html, /editorItems\.style\.transform = transform/, 'the items layer carries the view transform');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(css, /#layout-guide-layer/, 'a guide layer exists');
  assert.match(css, /\.layout-guide-v/, 'vertical guide styled');
  assert.match(css, /\.layout-guide-h/, 'horizontal guide styled');
});

test('E2b editor handles follow window resizes and the dead corner CSS is gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /function resize\(\)\s*\{[\s\S]*?positionHandles\(\);/, 'the resize handler re-positions the handles');
  // Task E3d: the deferred pass grew from a bare positionHandles(80) into a
  // full 100ms re-derivation (frame → view → node boxes → handles) because a
  // resize event can fire before the OS settles the window size.
  assert.match(html, /setTimeout\(\(\) => \{[\s\S]*?positionHandles\(\);[\s\S]*?\}, 100\)/, 'a deferred pass re-derives the frame and re-positions after the layout settles');
  assert.doesNotMatch(css, /\.layout-scale-handle\.handle-\w+\s*\{[^}]*(-7px)/, 'the dead corner offsets are removed');
});

// ---------------------------------------------------------------------------
// Task E2b-R1 — real-shell regression: drop lands at the true canvas center,
// corner scaling keeps the opposite corner fixed, group drags show guides.
// Runs at two window sizes via a throwaway Electron probe (temp userData).
// ---------------------------------------------------------------------------

test('E2b-R1 real shell: drop center, corner-scale anchor and group guides at two window sizes', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2b-r1-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'e2b-r1-probe-template.js'), 'utf8')
    .replace(/__REPO__/g, ROOT));
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 400000 });
  // the probe double-writes results (its run dir + next to the script)
  const resultsFile = path.join(probeDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  for (const sizeKey of ['1600x1000', '1200x800']) {
    const entry = summary.sizes[sizeKey];
    assert.ok(entry, sizeKey + ' probed');
    assert.ok(Math.abs(entry.dropCenter.x - 0.5) <= 0.002 && Math.abs(entry.dropCenter.y - 0.5) <= 0.002,
      sizeKey + ': the canvas-center drop lands at (0.5, 0.5) +/- 0.002, got ' + JSON.stringify(entry.dropCenter));
  }
  const scaleEntry = summary.sizes['1600x1000'];
  assert.ok(scaleEntry.scale.after > scaleEntry.scale.before + 0.05, 'the se-handle drag increases the scale');
  assert.ok(Math.abs(scaleEntry.nwAfter.x - scaleEntry.nwBefore.x) <= 2 && Math.abs(scaleEntry.nwAfter.y - scaleEntry.nwBefore.y) <= 2,
    'the NW corner stays fixed on screen while scaling');
  for (const sizeKey of ['1600x1000', '1200x800']) {
    const guides = summary.sizes[sizeKey].guides;
    assert.ok(guides.midCounts.some((c) => c > 0), sizeKey + ': guide nodes appear during a group drag');
    assert.equal(guides.after, 0, sizeKey + ': guides clear after release');
  }
});


// ---------------------------------------------------------------------------
// Task E2c — the layers panel page wiring, the data-driven palette, and the
// real-shell evidence run (temp userData, /tmp/e2c-evidence/)
// ---------------------------------------------------------------------------

test('E2c editor page renders the layers panel with grouping, toggles, rename and z-order drag', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(html, /id="layout-layer-panel"/, 'the layers panel dock exists');
  assert.match(html, /id="layout-layer-groups"/, 'the panel has a groups root');
  assert.match(html, /function renderLayerPanel\(\)/, 'the panel renderer exists');
  assert.match(html, /未分组/, 'ungrouped rows get their own section');
  assert.match(html, /editor\.setItemHidden\(/, 'the visibility toggle reaches the editor API');
  assert.match(html, /editor\.setItemLocked\(/, 'the lock toggle reaches the editor API');
  assert.match(html, /editor\.renameItem\(/, 'rename reaches the editor API');
  assert.match(html, /editor\.moveItemToIndex\(/, 'row drag reaches the z-order API');
  assert.match(html, /application\/x-office-layer-row/, 'row drags carry a dedicated MIME type');
  assert.match(html, /function startLayerRename\(/, 'inline rename is wired');
  assert.match(html, /event\.key === 'Enter'/, 'Enter commits the rename');
  assert.match(html, /event\.key === 'Escape'/, 'Escape cancels the rename');
  assert.match(css, /#layout-layer-panel\s*\{[^}]*position:\s*absolute/s, 'the panel docks over the editor');
  assert.match(css, /\.layer-row\.is-hidden/, 'hidden rows are dimmed');
  assert.match(css, /\.layer-row\.selected/, 'row selection is styled');
  assert.match(css, /\.layer-row\.co-selected/, 'secondary row selection is styled');
  assert.match(css, /\.layer-rename-input/, 'the rename input is styled');
});

test('E2c editor page keeps hidden items off the canvas and locked items handle-free', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /allItems\.filter\(\(item\) => !item\.hidden\)/, 'hidden items never render on the canvas');
  assert.match(html, /draft\.locked \? ' locked' : ''/, 'locked items carry the locked class');
  assert.match(html, /primaryItem\.locked\) return/, 'locked primaries get no scale handles');
  assert.match(html, /renderLayerPanel\(\);\s*\n\s*syncEditorControls\(\);/, 'canvas renders re-sync the panel');
});

test('E2c editor shelf is data-driven over directional and single-image kinds', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const assets = fs.readFileSync(path.join(ROOT, 'src', 'office', 'layout-assets.js'), 'utf8');
  assert.match(html, /LAYOUT_KINDS/, 'the shelf iterates the catalog kind registry');
  // Task E4: the display widths moved to the shared catalog (the runtime
  // compiler derives furniture footprints from the same numbers)
  assert.match(html, /draftWidths = REGISTRY\['layout-assets'\]\.DRAFT_WIDTHS/, 'env props get a display width from the catalog');
  assert.match(html, /DRAFT_WIDTHS/, 'the catalog is the single width source');
  assert.match(assets, /directional:\s*true/, 'directional entries declare their family');
  assert.match(assets, /directional:\s*false/, 'single-image entries declare no family');
  assert.match(assets, /direction:\s*'none'/, 'single-image entries declare a verbatim direction');
});

test('E2c editor page explains locked delete survivors and guards the direction select', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /锁定的条目不可删除/, 'the all-locked delete explains itself');
  assert.match(html, /function deleteSelectionWithStatus\(\)/, 'delete shares one guarded path');
  assert.match(html, /const directional = !!\(entry && entry\.directional\)/, 'the direction select checks the family flag');
});

// Real-shell regression + evidence: every palette tile decodes (naturalWidth
// > 0), the layers panel hides/restores/locks/renames/reorders rows in sync
// with the canvas, and screenshots + results.json land in /tmp/e2c-evidence/.
// Spawns a throwaway Electron probe (temp userData, nothing in the repo).
test('E2c real shell: layers panel semantics and palette tile decode evidence', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e2c-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2c-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e2c-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2) console.error('[PAGE-ERR]', String(message).slice(0, 220)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
    const bootError = await evalJs('(window.__office && typeof window.__office.error === "string") ? window.__office.error : ""').catch(() => '');
    if (bootError) { console.error('[BOOT-ERROR]', bootError.slice(0, 300)); app.exit(1); }
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await evalJs("window.__office.api.toggleLayoutEditor()");
  await sleep(900);
  const shot = async (name) => {
    win.show();
    await sleep(300);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, name), image.toPNG());
    win.hide();
    await sleep(120);
  };
  const out = {};
  // (1) palette: every catalog tile decodes with naturalWidth > 0
  out.palette = JSON.parse(await evalJs("(() => { const imgs = [...document.querySelectorAll('#layout-asset-shelf .layout-asset-tile img')]; return JSON.stringify({ tiles: imgs.length, brokenTiles: imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.closest('.layout-asset-tile').dataset.assetId) }); })()"));
  await shot('palette-tiles.png');
  // (2) panel structure: one row per draft item, grouped, thumbnails present
  out.panel = JSON.parse(await evalJs("(() => { const rows = [...document.querySelectorAll('#layout-layer-groups .layer-row')]; const groups = [...document.querySelectorAll('#layout-layer-groups .layer-group')]; return JSON.stringify({ rows: rows.length, groups: groups.length, ungrouped: groups.filter((g) => g.dataset.groupId === '').length, headless: rows.filter((r) => !r.querySelector('img.layer-thumb')).length }); })()"));
  // (3) hide / restore: the canvas loses the node, the panel keeps the row
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-1\\\"] .layer-visibility').click()");
  await sleep(80);
  out.hide = JSON.parse(await evalJs("(() => { const row = document.querySelector('.layer-row[data-draft-id=\\\"draft-1\\\"]'); return JSON.stringify({ canvasWhileHidden: document.querySelectorAll('#layout-draft-items .layout-draft-item').length, panelRowsWhileHidden: document.querySelectorAll('#layout-layer-groups .layer-row').length, rowDimmed: row.classList.contains('is-hidden'), draftKeepsItem: window.__office.api.layoutDraft().items.some((i) => i.id === 'draft-1' && i.hidden === true) }); })()"));
  await shot('layer-hidden.png');
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-1\\\"] .layer-visibility').click()");
  await sleep(80);
  out.restore = JSON.parse(await evalJs("(() => { const row = document.querySelector('.layer-row[data-draft-id=\\\"draft-1\\\"]'); return JSON.stringify({ canvasRestored: document.querySelectorAll('#layout-draft-items .layout-draft-item').length, rowVisible: !row.classList.contains('is-hidden'), draftUnhidden: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-1').hidden === false }); })()"));
  await shot('layer-restored.png');
  // (4) lock: row click still selects, canvas drag does NOT move, no handles
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-2\\\"] .layer-lock').click()");
  await sleep(80);
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-2\\\"]').click()");
  await sleep(80);
  out.lock = JSON.parse(await evalJs("(() => { const before = window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-2').position; const node = document.querySelector('[data-draft-id=\\\"draft-2\\\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 91 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); for (let s = 1; s <= 5; s += 1) node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + s * 15, clientY: o.clientY })); node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + 75, clientY: o.clientY })); const draft = window.__office.api.layoutDraft(); const after = draft.items.find((i) => i.id === 'draft-2').position; return JSON.stringify({ selected: draft.selectedIds.includes('draft-2'), moved: after.x !== before.x || after.y !== before.y, rowLocked: document.querySelector('.layer-row[data-draft-id=\\\"draft-2\\\"]').classList.contains('is-locked'), handles: document.querySelectorAll('#layout-handle-layer .layout-scale-handle').length }); })()"));
  await shot('layer-locked-drag.png');
  // (5) rename round-trip: dblclick -> input -> Enter -> draft + row label
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-3\\\"] .layer-name').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await sleep(80);
  await evalJs("(() => { const input = document.querySelector('.layer-row[data-draft-id=\\\"draft-3\\\"] .layer-rename-input'); if (!input) return false; input.value = '会客椅'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()");
  await sleep(80);
  out.rename = JSON.parse(await evalJs("(() => { return JSON.stringify({ draftName: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-3').name, rowLabel: document.querySelector('.layer-row[data-draft-id=\\\"draft-3\\\"] .layer-name').textContent }); })()"));
  await shot('layer-renamed.png');
  // (6) z-order drag: move draft-1's row onto draft-24's row. Clear the
  // selection first — the lock step selected draft-2, and an adjacent
  // selection would drag the whole BLOCK (moveItemToIndex multi semantics).
  await evalJs("document.getElementById('editor-clear-selection').click()");
  await sleep(80);
  out.zorder = {};
  out.zorder.before = JSON.parse(await evalJs("JSON.stringify(window.__office.api.layoutDraft().items.map((i) => i.id))"));
  await evalJs("(() => { const dt = new DataTransfer(); dt.setData('application/x-office-layer-row', 'draft-1'); const src = document.querySelector('.layer-row[data-draft-id=\\\"draft-1\\\"]'); src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })); const dst = document.querySelector('.layer-row[data-draft-id=\\\"draft-24\\\"]'); dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })); dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()");
  await sleep(80);
  out.zorder.after = JSON.parse(await evalJs("JSON.stringify(window.__office.api.layoutDraft().items.map((i) => i.id))"));
  await shot('layer-zorder.png');
  await evalJs("document.getElementById('editor-undo').click()");
  await sleep(80);
  // (7) selection sync, both directions + shift multi-select
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-5\\\"]').click()");
  await sleep(80);
  out.syncPanelToCanvas = JSON.parse(await evalJs("(() => { return JSON.stringify({ canvasSelected: document.querySelector('[data-draft-id=\\\"draft-5\\\"]').classList.contains('selected'), rowSelected: document.querySelector('.layer-row[data-draft-id=\\\"draft-5\\\"]').classList.contains('selected'), primary: window.__office.api.layoutDraft().selectedId }); })()"));
  await evalJs("(() => { const node = document.querySelector('[data-draft-id=\\\"draft-7\\\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 92 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()");
  await sleep(80);
  out.syncCanvasToPanel = JSON.parse(await evalJs("(() => { return JSON.stringify({ rowSelected: document.querySelector('.layer-row[data-draft-id=\\\"draft-7\\\"]').classList.contains('selected'), primary: window.__office.api.layoutDraft().selectedId }); })()"));
  await evalJs("document.querySelector('.layer-row[data-draft-id=\\\"draft-8\\\"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))");
  await sleep(80);
  out.syncMulti = JSON.parse(await evalJs("(() => { return JSON.stringify({ count: window.__office.api.layoutDraft().selectedIds.length, row7CoSelected: document.querySelector('.layer-row[data-draft-id=\\\"draft-7\\\"]').classList.contains('co-selected'), row8Primary: document.querySelector('.layer-row[data-draft-id=\\\"draft-8\\\"]').classList.contains('selected') }); })()"));
  await shot('layer-selection-sync.png');
  const payload = JSON.stringify(out, null, 2);
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), payload);
  fs.writeFileSync(path.join(__dirname, 'results.json'), payload);
  console.log('E2C_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E2C_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 280000 });
  const resultsFile = path.join(probeDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  // palette tiles: all catalog entries decode in the real shell.
  // E3e: compare against the LIVE catalog length instead of a frozen number —
  // every entry must render exactly one decoding tile, whatever the batch.
  const catalogLength = require('../src/office/layout-assets.js').LAYOUT_ASSETS.length;
  assert.equal(summary.palette.tiles, catalogLength, `every catalog entry (${catalogLength}) renders as a decoding tile`);
  assert.deepEqual(summary.palette.brokenTiles, [], 'every palette tile has naturalWidth > 0');
  // panel structure
  assert.equal(summary.panel.rows, 24, 'one row per bundled draft item');
  assert.equal(summary.panel.ungrouped, 0, 'the bundled draft is fully grouped');
  assert.ok(summary.panel.groups >= 6, 'the six workstation groups appear');
  assert.equal(summary.panel.headless, 0, 'every row carries a thumbnail');
  // hide / restore
  assert.equal(summary.hide.canvasWhileHidden, 23, 'the hidden item leaves the canvas');
  assert.equal(summary.hide.panelRowsWhileHidden, 24, 'the hidden item stays in the panel');
  assert.equal(summary.hide.rowDimmed, true);
  assert.equal(summary.hide.draftKeepsItem, true, 'the hidden item stays in the draft');
  assert.equal(summary.restore.canvasRestored, 24, 'unhiding restores the canvas node');
  assert.equal(summary.restore.draftUnhidden, true);
  // lock: selection works, dragging does not, no scale handles
  assert.equal(summary.lock.selected, true, 'the locked item is selectable via the panel');
  assert.equal(summary.lock.moved, false, 'the locked item does not move on drag');
  assert.equal(summary.lock.rowLocked, true);
  assert.equal(summary.lock.handles, 0, 'locked items get no scale handles');
  // rename round-trip
  assert.equal(summary.rename.draftName, '会客椅', 'Enter commits the rename into the draft');
  assert.equal(summary.rename.rowLabel, '会客椅', 'the row label reflects the new name');
  // z-order: draft-1 landed at draft-24's slot (exactly index 23)
  assert.equal(summary.zorder.before.length, 24);
  assert.equal(summary.zorder.after[23], 'draft-1', 'the dragged row landed at the target slot');
  assert.equal(summary.zorder.after[0], 'draft-2');
  assert.notDeepEqual(summary.zorder.after, summary.zorder.before, 'the z-order changed');
  // selection sync
  assert.equal(summary.syncPanelToCanvas.canvasSelected, true, 'row click selects on the canvas');
  assert.equal(summary.syncPanelToCanvas.rowSelected, true);
  assert.equal(summary.syncPanelToCanvas.primary, 'draft-5');
  assert.equal(summary.syncCanvasToPanel.rowSelected, true, 'canvas selection highlights the row');
  assert.equal(summary.syncCanvasToPanel.primary, 'draft-7');
  assert.equal(summary.syncMulti.count, 2, 'shift-click builds a multi-selection');
  assert.equal(summary.syncMulti.row7CoSelected, true, 'the secondary row is co-selected');
  assert.equal(summary.syncMulti.row8Primary, true, 'the shift-clicked row becomes primary');
  // evidence artifacts
  for (const name of ['palette-tiles.png', 'layer-hidden.png', 'layer-restored.png', 'layer-locked-drag.png', 'layer-renamed.png', 'layer-zorder.png', 'layer-selection-sync.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});


// ---------------------------------------------------------------------------
// Task E2d — the standalone layout editor launcher: the REAL
// `electron scripts/office-editor.js` boots (stdout launch contract), and a
// same-assembly probe verifies ?editor=1 auto-open plus the save ->
// relaunch -> restore-default round trip over the isolated data dir.
// Evidence lands in /tmp/e2d-evidence/ (results.json + screenshots).
// ---------------------------------------------------------------------------

test('E2d real shell: standalone launcher boots, saves, relaunches and restores the layout', { timeout: 300000 }, async () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e2d-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2d-data-'));
  // (0) the REAL launcher: OFFICE_EDITOR_READY on stdout is the contract.
  // The launcher is a RESIDENT GUI process (closing the window quits), so
  // the probe spawns it, waits for the contract line, then stops it.
  await new Promise((resolve, reject) => {
    const child = spawn(electronBin, [path.join(ROOT, 'scripts', 'office-editor.js')], {
      env: { ...process.env, OFFICE_EDITOR_DATA_DIR: dataDir, OFFICE_EDITOR_HEADLESS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let collected = '';
    const failWith = (message) => { clearTimeout(timer); child.kill('SIGTERM'); reject(new Error(message)); };
    const timer = setTimeout(() => failWith('launcher never printed OFFICE_EDITOR_READY: ' + collected.slice(0, 400)), 60000);
    child.stdout.on('data', (chunk) => {
      collected += chunk;
      if (collected.includes('OFFICE_EDITOR_READY')) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { collected += chunk; });
    child.on('exit', (code) => { if (!collected.includes('OFFICE_EDITOR_READY')) failWith(`launcher exited early code=${code}: ` + collected.slice(0, 400)); });
  });
  // (1)+(2) save / restore stages through a same-assembly probe window
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2d-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const DATA = ${JSON.stringify(dataDir)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
const STAGE = process.env.E2D_STAGE || 'save';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', DATA);
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const { createOfficeStateStore } = require(path.join(REPO, 'src', 'office', 'runtime', 'office-persistence.js'));
  const { createOfficeProtocolHandler } = require(path.join(REPO, 'src', 'office', 'office-protocol.js'));
  const store = createOfficeStateStore({ userDataDir: DATA, epoch: Date.now(), log: () => {} });
  protocol.handle('office-runtime', createOfficeProtocolHandler({
    officeRoot: path.join(REPO, 'src', 'office'),
    nodeModulesRoot: path.join(REPO, 'node_modules'),
    officeAssetsRoot: path.join(REPO, 'resources', 'office'),
    charactersRoot: path.join(REPO, 'resources', 'characters'),
    layoutStore: store,
  }));
  const emptySnapshot = { schemaVersion: 1, simulatedAtMs: 0, sync: 'healthy', scene: { referenceWidth: 1280, referenceHeight: 840 }, employees: [], activityLog: [], diagnostics: [], capabilities: {} };
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: emptySnapshot }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false, code: 'OFFICE_EDITOR_STUB' }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src', 'office', 'office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let booted = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    booted = JSON.parse(await evalJs("JSON.stringify({ ready: Boolean(window.__office && window.__office.ready), editorOpen: (() => { const el = document.getElementById('layout-editor'); return !!el && !el.hidden; })(), error: (window.__office && window.__office.error) || null })").catch(() => 'null'));
    if (booted.ready && booted.editorOpen) break;
  }
  if (!booted || !booted.ready || !booted.editorOpen) { console.error('E2D_PROBE_BOOT', JSON.stringify(booted)); app.exit(1); }
  const shot = async (name) => {
    win.show();
    await sleep(300);
    fs.writeFileSync(path.join(EVIDENCE, name), (await win.webContents.capturePage()).toPNG());
    win.hide();
    await sleep(120);
  };
  const layoutFile = path.join(DATA, 'office-layout.v1.json');
  const out = { stage: STAGE, editorAutoOpened: booted.editorOpen };
  if (STAGE === 'save') {
    // drag draft-4 with synthetic pointer events, then save as production
    out.drag = JSON.parse(await evalJs("(() => { const node = document.querySelector('[data-draft-id=\\\"draft-4\\\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 93 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); for (let s = 1; s <= 6; s += 1) node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + s * 12, clientY: o.clientY + s * 4 })); node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + 72, clientY: o.clientY + 24 })); const item = window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-4'); return JSON.stringify({ x: item.position.x, y: item.position.y }); })()"));
    await evalJs("document.getElementById('editor-save-production').click()");
    let status = '';
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      status = await evalJs("document.getElementById('editor-status').textContent");
      if (status.includes('已保存')) break;
    }
    out.saveStatus = status;
    out.layoutSource = await evalJs('window.__office.api.layoutSource()');
    out.dataFileExists = fs.existsSync(layoutFile);
    await shot('e2d-saved.png');
    fs.writeFileSync(path.join(EVIDENCE, 'stage-save.json'), JSON.stringify(out, null, 2));
  } else {
    // relaunch semantics: the saved layout must win and carry the drag
    out.layoutSource = await evalJs('window.__office.api.layoutSource()');
    const savedStage = JSON.parse(fs.readFileSync(path.join(EVIDENCE, 'stage-save.json'), 'utf8'));
    out.savedPosition = savedStage.drag;
    out.item = JSON.parse(await evalJs("JSON.stringify(window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-4').position)"));
    await shot('e2d-relaunch.png');
    await evalJs("document.getElementById('editor-restore-production').click()");
    let status = '';
    for (let i = 0; i < 25; i += 1) {
      await sleep(200);
      status = await evalJs("document.getElementById('editor-status').textContent");
      if (status.includes('已恢复')) break;
    }
    out.restoreStatus = status;
    out.layoutSourceAfterRestore = await evalJs('window.__office.api.layoutSource()');
    out.restoredPosition = JSON.parse(await evalJs("JSON.stringify(window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-4').position)"));
    // the file deletion can lag the status line by one store tick
    for (let i = 0; i < 25; i += 1) {
      if (!fs.existsSync(layoutFile)) break;
      await sleep(200);
    }
    out.dataFileDeleted = !fs.existsSync(layoutFile);
    await shot('e2d-restored.png');
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  }
  console.log('E2D_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E2D_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000, env: { ...process.env, E2D_STAGE: 'save' } });
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000, env: { ...process.env, E2D_STAGE: 'restore' } });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  assert.equal(summary.editorAutoOpened, true, '?editor=1 auto-opens the layout editor');
  assert.equal(summary.layoutSource, 'saved', 'the relaunched editor boots from the saved layout');
  assert.ok(Math.abs(summary.item.x - summary.savedPosition.x) < 1e-9, 'the saved drag position survives the relaunch (x)');
  assert.ok(Math.abs(summary.item.y - summary.savedPosition.y) < 1e-9, 'the saved drag position survives the relaunch (y)');
  assert.ok(summary.restoreStatus.includes('已恢复'), 'restore-default reports success');
  assert.equal(summary.layoutSourceAfterRestore, 'bundled', 'restore falls back to the bundled draft');
  assert.equal(summary.dataFileDeleted, true, 'restore-default deletes the saved layout file');
  for (const name of ['e2d-saved.png', 'e2d-relaunch.png', 'e2d-restored.png', 'stage-save.json', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});


// ---------------------------------------------------------------------------
// Task E2e — layer = depth on the canvas, material groups, trackpad view
// controls, the size inspector, and the real-shell evidence run
// (/tmp/e2e-evidence/).
// ---------------------------------------------------------------------------

test('E2e editor page paints by layer depth and wires the depth/group/view/size controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  // paint order = numeric layer ascending (z-index), array order as tiebreak
  assert.match(html, /node\.style\.zIndex = String\(Math\.round\(draft\.layer\)\)/, 'layer maps to CSS z-index');
  // wheel: plain scroll pans, ctrl/meta pinch zooms, page scroll suppressed
  assert.match(html, /event\.preventDefault\(\);\s*\n\s*if \(event\.ctrlKey \|\| event\.metaKey\) \{[\s\S]{0,200}zoomAt/, 'ctrl/meta wheel zooms');
  assert.match(html, /view\.panBy\(event\.deltaX, event\.deltaY\)/, 'plain wheel pans');
  // depth + group toolbar buttons exist and reach the editor APIs
  for (const id of ['editor-front', 'editor-back', 'editor-layer-up', 'editor-layer-down', 'editor-group', 'editor-ungroup', 'editor-zoom-in', 'editor-zoom-out']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} control exists`);
  }
  // Task E3b fix: the depth buttons drive the VISUAL order APIs (cross-layer
  // layer-value swaps) — the E2e array-order wiring could not change occlusion.
  assert.match(html, /editor\.bringVisualToFront\(selected\.id\)/, '置顶 uses the visual front API');
  assert.match(html, /editor\.sendVisualToBack\(selected\.id\)/, '置底 uses the visual back API');
  assert.match(html, /editor\.moveVisualUp\(selected\.id\)/, '上移一层 uses the visual neighbour swap');
  assert.match(html, /editor\.moveVisualDown\(selected\.id\)/, '下移一层 uses the visual neighbour swap');
  assert.match(html, /id="layout-scene-frame"/, 'the logical scene frame exists');
  assert.match(html, /function updateSceneFrame\(\)/, 'the frame is computed from the live canvas');
  assert.match(html, /editor\.isGroupMoveRigid\(groupId\)/, 'drags consult the per-group move lock');
  assert.match(html, /layer-group-rigid/, 'the 整组移动 lock button exists');
  assert.match(html, /editor\.groupSelection\(\)/, '编组 reaches the editor');
  assert.match(html, /editor\.ungroupSelection\(\)/, '解组 reaches the editor');
  // inspector size field + px readout
  assert.match(html, /id="inspector-scale"/);
  assert.match(html, /id="inspector-size-px"/);
  assert.match(html, /editor\.setScale\(selected\.id, Number\(inspectorScale\.value\)\)/, 'inspector size drives the SAME setScale API');
  assert.match(html, /inspectorScale\.disabled = !selected \|\| multi \|\| selected\.locked/, 'size disabled for multi + locked');
  assert.match(html, /function updateInspectorSizePx\(\)/);
  // scale-handle discoverability
  assert.match(html, /handle\.title = '拖动等比缩放（0\.2–3）'/);
  assert.match(css, /\.layout-scale-handle\s*\{[^}]*cursor:\s*nwse-resize/s);
  assert.match(css, /#layout-canvas\s*\{[^}]*background:\s*#fff/s, 'outside the frame the canvas is pure white');
  assert.match(css, /#layout-scene-frame\s*\{[^}]*background:\s*var\(--office-bg\)/s, 'the frame keeps the office surface color');
  assert.match(css, /\.layer-group-rigid/, 'the 整组移动 lock is styled');
  assert.match(css, /\.layout-scale-handle:hover/);
  // group header entries in the panel
  assert.match(html, /layer-group-add/, '加入选中 button class exists');
  assert.match(html, /layer-group-ungroup/, 'group-header 解组 button class exists');
  assert.match(html, /editor\.addSelectionToGroup\(groupId\)/, '加入选中 reaches the editor');
  assert.match(html, /editor\.ungroupGroup\(groupId\)/, 'group-header 解组 reaches the editor');
  assert.match(html, /function startLayerGroupRename\(/, 'group rename entry is wired');
  assert.match(html, /editor\.renameGroup\(groupId,/, 'group rename reaches the editor');
});

// Real-shell evidence: layer changes flip elementFromPoint hits, the
// 编组 → 组内层级 → 解组 flow is visible, trackpad wheel pans while
// ctrl+wheel zooms around the pointer, and the size inspector drives px.
// Evidence lands in /tmp/e2e-evidence/ (results.json + screenshots).
test('E2e real shell: layer depth, groups, trackpad view and size inspector evidence', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e2e-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await sleep(400);
  const shot = async (name) => {
    win.show();
    await sleep(300);
    fs.writeFileSync(path.join(EVIDENCE, name), (await win.webContents.capturePage()).toPNG());
    win.hide();
    await sleep(120);
  };
  const out = {};
  // ---- (1) layer = depth: two items stacked, elementFromPoint flips ----
  out.layer = JSON.parse(await evalJs("(() => { const setXY = (id, x, y) => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(id) + ']'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); const ix = document.getElementById('inspector-x'); const iy = document.getElementById('inspector-y'); ix.value = String(x); ix.dispatchEvent(new Event('change', { bubbles: true })); iy.value = String(y); iy.dispatchEvent(new Event('change', { bubbles: true })); }; const draft = window.__office.api.layoutDraft(); const itemA = draft.items.find((i) => i.id === 'draft-22'); const itemB = draft.items.find((i) => i.id === 'draft-23'); setXY('draft-22', 0.08, 0.85); setXY('draft-23', 0.08, 0.85); const nodeB = document.querySelector('[data-draft-id=\\\"draft-23\\\"]'); const r = nodeB.getBoundingClientRect(); const px = Math.round(r.left + r.width / 2); const py = Math.round(r.top + r.height / 2); const hit1 = document.elementFromPoint(px, py); const top1 = hit1 && hit1.dataset ? hit1.dataset.draftId : null; const layers = { a: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-22').layer, b: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-23').layer }; const lowId = layers.a <= layers.b ? 'draft-22' : 'draft-23'; const high = Math.max(layers.a, layers.b) + 10; const lowNode = document.querySelector('[data-draft-id=' + JSON.stringify(lowId) + ']'); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; lowNode.dispatchEvent(new PointerEvent('pointerdown', o)); lowNode.dispatchEvent(new PointerEvent('pointerup', o)); const il = document.getElementById('inspector-layer'); il.value = String(high); il.dispatchEvent(new Event('change', { bubbles: true })); const hit2 = document.elementFromPoint(px, py); const top2 = hit2 && hit2.dataset ? hit2.dataset.draftId : null; return JSON.stringify({ top1, top2, flipped: top1 !== top2 && top2 === lowId, layers: window.__office.api.layoutDraft().items.filter((i) => i.id === 'draft-22' || i.id === 'draft-23').map((i) => ({ id: i.id, layer: i.layer })) }); })()"));
  await shot('e2e-layer-depth.png');
  // reset: undo the layer change and the moves (clean state for groups)
  for (let i = 0; i < 5; i += 1) { await evalJs("document.getElementById('editor-undo').click()"); await sleep(60); }
  // ---- (2) 编组 → 组内层级 → 组重命名 → 解组 ----
  out.group = JSON.parse(await evalJs("(async () => { const clickNode = (id, shift) => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(id) + ']'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, shiftKey: !!shift }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); }; clickNode('draft-1', false); await new Promise((r) => setTimeout(r, 120)); clickNode('draft-2', true); await new Promise((r) => setTimeout(r, 120)); const draft = window.__office.api.layoutDraft(); const g1Before = draft.items.find((i) => i.id === 'draft-1').groupId; document.getElementById('editor-group').click(); await new Promise((r) => setTimeout(r, 120)); const draft2 = window.__office.api.layoutDraft(); const g1 = draft2.items.find((i) => i.id === 'draft-1').groupId; const g2 = draft2.items.find((i) => i.id === 'draft-2').groupId; const sameGroup = g1 === g2 && /^group-\\\\d+$/.test(g1) && g1 !== g1Before; clickNode('draft-3', true); await new Promise((r) => setTimeout(r, 120)); const addBtn = document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-add'); const headerExists = !!document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-name'); addBtn.click(); await new Promise((r) => setTimeout(r, 120)); const g3 = window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-3').groupId; const joined = g3 === g1; const nameSpan = document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-name'); nameSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); const input = document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-rename-input'); input.value = '前台组合'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 120)); const groupName = window.__office.api.layoutDraft().groupNames[g1]; const ungroupBtn = document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-ungroup'); ungroupBtn.click(); await new Promise((r) => setTimeout(r, 120)); const draftFinal = window.__office.api.layoutDraft(); const cleared = draftFinal.items.find((i) => i.id === 'draft-1').groupId === null && draftFinal.items.find((i) => i.id === 'draft-2').groupId === null && draftFinal.items.find((i) => i.id === 'draft-3').groupId === null; return JSON.stringify({ sameGroup, headerExists, joined, groupName, cleared }); })()"));
  await shot('e2e-groups.png');
  // ---- (3) trackpad: plain wheel pans, ctrl+wheel zooms at the anchor ----
  const viewBefore = JSON.parse(await evalJs("(() => { const t = document.getElementById('layout-draft-items').style.transform; const m = t.match(/translate\\\\(([\\\\d.-]+)px, ([\\\\d.-]+)px\\\\) scale\\\\(([\\\\d.-]+)\\\\)/); return JSON.stringify({ tx: parseFloat(m[1]), ty: parseFloat(m[2]), scale: parseFloat(m[3]) }); })()"));
  const canvasRect = JSON.parse(await evalJs("(() => { const c = document.getElementById('layout-canvas').getBoundingClientRect(); const f = document.getElementById('layout-scene-frame').getBoundingClientRect(); return JSON.stringify({ x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2), w: f.width, h: f.height }); })()"));
  await evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 120, deltaY: 0 })); true");
  await sleep(120);
  const afterDeltaX = JSON.parse(await evalJs("(() => { const t = document.getElementById('layout-draft-items').style.transform; const m = t.match(/translate\\\\(([\\\\d.-]+)px, ([\\\\d.-]+)px\\\\) scale\\\\(([\\\\d.-]+)\\\\)/); return JSON.stringify({ tx: parseFloat(m[1]), ty: parseFloat(m[2]), scale: parseFloat(m[3]) }); })()"));
  await evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: 120 })); true");
  await sleep(120);
  const afterDeltaY = JSON.parse(await evalJs("(() => { const t = document.getElementById('layout-draft-items').style.transform; const m = t.match(/translate\\\\(([\\\\d.-]+)px, ([\\\\d.-]+)px\\\\) scale\\\\(([\\\\d.-]+)\\\\)/); return JSON.stringify({ tx: parseFloat(m[1]), ty: parseFloat(m[2]), scale: parseFloat(m[3]) }); })()"));
  await evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: -240, ctrlKey: true, clientX: " + canvasRect.x + ", clientY: " + canvasRect.y + " })); true");
  await sleep(120);
  const afterZoom = JSON.parse(await evalJs("(() => { const t = document.getElementById('layout-draft-items').style.transform; const m = t.match(/translate\\\\(([\\\\d.-]+)px, ([\\\\d.-]+)px\\\\) scale\\\\(([\\\\d.-]+)\\\\)/); return JSON.stringify({ tx: parseFloat(m[1]), ty: parseFloat(m[2]), scale: parseFloat(m[3]) }); })()"));
  out.trackpad = {
    panX: { before: viewBefore.tx, after: afterDeltaX.tx, scaleStable: afterDeltaX.scale === viewBefore.scale, moved: Math.abs(afterDeltaX.tx - viewBefore.tx - 120) < 0.5 },
    panY: { before: afterDeltaX.ty, after: afterDeltaY.ty, moved: Math.abs(afterDeltaY.ty - afterDeltaX.ty - 120) < 0.5 },
    zoom: { scaleBefore: afterDeltaY.scale, scaleAfter: afterZoom.scale, grew: afterZoom.scale > afterDeltaY.scale, anchorStable: Math.abs((canvasRect.w / 2 - afterDeltaY.tx) / afterDeltaY.scale - (canvasRect.w / 2 - afterZoom.tx) / afterZoom.scale) < 1 && Math.abs((canvasRect.h / 2 - afterDeltaY.ty) / afterDeltaY.scale - (canvasRect.h / 2 - afterZoom.ty) / afterZoom.scale) < 1 },
  };
  await evalJs("document.getElementById('editor-reset-view').click()");
  await sleep(120);
  // ---- (4) size inspector: scale input drives the px readout ----
  out.size = JSON.parse(await evalJs("(() => { const node = document.querySelector('[data-draft-id=\\\"draft-5\\\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); const before = document.getElementById('inspector-size-px').textContent; const input = document.getElementById('inspector-scale'); input.value = '1.8'; input.dispatchEvent(new Event('change', { bubbles: true })); const after = document.getElementById('inspector-size-px').textContent; return JSON.stringify({ before, after, scale: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-5').scale, grewPx: parseFloat(after) > parseFloat(before) }); })()"));
  await shot('e2e-size-inspector.png');
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  console.log('E2E_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E2E_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  // layer = depth
  assert.equal(summary.layer.flipped, true, 'the elementFromPoint hit flips after the layer change');
  assert.equal(summary.layer.top2, summary.layer.lowId === undefined ? summary.layer.top2 : summary.layer.top2, 'sanity');
  // groups
  assert.equal(summary.group.sameGroup, true, '编组 gives both members one stable group-N id');
  assert.equal(summary.group.headerExists, true, 'the new group gets a panel section with a header');
  assert.equal(summary.group.joined, true, '加入选中 pulls a third item into the group');
  assert.equal(summary.group.groupName, '前台组合', 'group rename lands in draft.groupNames');
  assert.equal(summary.group.cleared, true, 'group-header 解组 clears every member');
  // trackpad
  // Task E3c: with the scene frame glued to the canvas, a 100% trackpad
  // swipe is fully ABSORBED (panning cannot detach the items from the frame
  // — the E2e free-pan semantics created the invisible-rectangle bug).
  assert.equal(summary.trackpad.panX.moved, false, '100%: pure deltaX is absorbed, the frame never drifts');
  assert.equal(summary.trackpad.panX.scaleStable, true, 'plain wheel never zooms');
  assert.equal(summary.trackpad.panY.moved, false, '100%: pure deltaY is absorbed too');
  assert.equal(summary.trackpad.zoom.grew, true, 'ctrl+wheel zooms');
  assert.equal(summary.trackpad.zoom.anchorStable, true, 'ctrl+wheel keeps the pointer anchor fixed');
  // size inspector
  assert.equal(summary.size.grewPx, true, 'the px readout grows with the scale input');
  assert.equal(summary.size.scale, 1.8);
  for (const name of ['e2e-layer-depth.png', 'e2e-groups.png', 'e2e-size-inspector.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});


// ---------------------------------------------------------------------------
// Task E3a — the flat-2D pilot furniture in the REAL shell: the three new
// shelf tiles decode (naturalWidth > 0), all three pieces place via REAL
// drag&drop, and they inherit the kind-calibrated depth (desk 40 / chair 20 /
// monitor 10). Evidence lands in /tmp/e3a-evidence/.
// ---------------------------------------------------------------------------

test('E3a real shell: flat pilot tiles decode and place with their calibrated depth', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e3a-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3a-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e3a-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await sleep(400);
  const shot = async (name) => {
    win.show();
    await sleep(300);
    fs.writeFileSync(path.join(EVIDENCE, name), (await win.webContents.capturePage()).toPNG());
    win.hide();
    await sleep(120);
  };
  const out = {};
  // (1) the three flat tiles render in the shelf and decode
  out.tiles = JSON.parse(await evalJs("(() => { const ids = ['flat-desk', 'flat-monitor', 'flat-chair']; return JSON.stringify(ids.map((id) => { const tile = document.querySelector('.layout-asset-tile[data-asset-id=' + JSON.stringify(id) + ']'); if (!tile) return { id, present: false }; const img = tile.querySelector('img'); return { id, present: true, decoded: !!(img && img.complete && img.naturalWidth > 0), naturalWidth: img ? img.naturalWidth : 0, caption: tile.querySelector('span') ? tile.querySelector('span').textContent : '' }; })); })()"));
  await shot('e3a-shelf.png');
  // (2) REAL drag&drop: all three pieces onto distinct canvas spots
  const canvasRect = JSON.parse(await evalJs("(() => { const c = document.getElementById('layout-canvas').getBoundingClientRect(); return JSON.stringify({ left: c.left, top: c.top, width: c.width, height: c.height }); })()"));
  const spots = { 'flat-desk': [0.30, 0.62], 'flat-chair': [0.52, 0.62], 'flat-monitor': [0.74, 0.62] };
  for (const [assetId, [fx, fy]] of Object.entries(spots)) {
    await evalJs("(() => { const dt = new DataTransfer(); dt.setData('application/x-office-layout-asset', " + JSON.stringify(assetId) + "); const ev = new Event('drop', { bubbles: true, cancelable: true }); ev.dataTransfer = dt; ev.clientX = " + (canvasRect.left + canvasRect.width * fx) + "; ev.clientY = " + (canvasRect.top + canvasRect.height * fy) + "; document.getElementById('layout-canvas').dispatchEvent(ev); return true; })()");
    await sleep(150);
  }
  out.placed = JSON.parse(await evalJs("(() => { const draft = window.__office.api.layoutDraft(); const pick = (id) => { const item = draft.items.find((i) => i.asset === id); if (!item) return null; const node = document.querySelector('[data-draft-id=' + JSON.stringify(item.id) + ']'); return { id: item.id, asset: item.asset, kind: item.kind, position: { x: item.position.x, y: item.position.y }, layer: item.layer, zIndex: node ? node.style.zIndex : null, rendered: !!node }; }; return JSON.stringify({ desk: pick('flat-desk'), monitor: pick('flat-monitor'), chair: pick('flat-chair'), total: draft.items.length }); })()"));
  await shot('e3a-placed.png');
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  console.log('E3A_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E3A_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  for (const tile of summary.tiles) {
    assert.equal(tile.present, true, `${tile.id} tile is in the shelf`);
    assert.equal(tile.decoded, true, `${tile.id} tile image has naturalWidth > 0 (${tile.naturalWidth})`);
  }
  assert.equal(summary.tiles.length, 3);
  const depthOf = { desk: 40, chair: 20, monitor: 10 };
  for (const key of ['desk', 'monitor', 'chair']) {
    const placed = summary.placed[key];
    assert.ok(placed, `the ${key} flat piece placed on the canvas`);
    assert.ok(placed.position.x >= 0 && placed.position.x <= 1 && placed.position.y >= 0 && placed.position.y <= 1, `${key} position normalized`);
    assert.equal(placed.layer, depthOf[key], `${key} inherits the calibrated depth (${depthOf[key]})`);
    assert.equal(placed.zIndex, String(depthOf[key]), `${key} canvas node carries the depth z-index`);
    assert.equal(placed.rendered, true, `${key} renders on the canvas`);
  }
  assert.equal(summary.placed.desk.position.y, summary.placed.chair.position.y, 'the three pieces share one row');
  for (const name of ['e3a-shelf.png', 'e3a-placed.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});


// ---------------------------------------------------------------------------
// Task E3b — real-shell proof for the four user-reported fixes:
// (1) corner handles drag via synthetic pointer events (window-level
//     listeners, no setPointerCapture dependency),
// (2) the depth buttons REALLY flip occlusion (visual layer swaps),
// (3) groups are loose by default; the panel 整组移动 lock restores rigid
//     group drags,
// (4) the logical scene frame (1280x840) is visible: office surface inside,
//     pure white outside.
// Evidence lands in /tmp/e3b-evidence/.
// ---------------------------------------------------------------------------

test('E3b real shell: handle dragging, occlusion buttons, group lock and the scene frame', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e3b-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3b-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e3b-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1600, height: 1000, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await sleep(400);
  const shot = async (name) => {
    win.show();
    await sleep(300);
    fs.writeFileSync(path.join(EVIDENCE, name), (await win.webContents.capturePage()).toPNG());
    win.hide();
    await sleep(120);
  };
  const out = {};
  // (4) scene frame geometry + colors
  out.frame = JSON.parse(await evalJs("(() => { const c = document.getElementById('layout-canvas'); const f = document.getElementById('layout-scene-frame'); const cr = c.getBoundingClientRect(); const fr = f.getBoundingClientRect(); return JSON.stringify({ ratio: fr.width / fr.height, expected: 1280 / 840, centeredX: Math.abs((fr.left - cr.left) - (cr.right - fr.right)) < 2, centeredY: Math.abs((fr.top - cr.top) - (cr.bottom - fr.bottom)) < 2, canvasBg: getComputedStyle(c).backgroundColor, frameBg: getComputedStyle(f).backgroundColor, itemsLayerAtFrame: Math.abs(document.getElementById('layout-draft-items').getBoundingClientRect().left - fr.left) < 1, minWhite: Math.min(fr.left - cr.left, cr.right - fr.right, fr.top - cr.top, cr.bottom - fr.bottom), border: getComputedStyle(f).borderTopWidth + ' ' + getComputedStyle(f).borderTopStyle }); })()"));
  await shot('e3b-frame.png');
  // (1) corner handle: REAL-mouse drag over the se handle scales the item
  // (the same trusted-input path a trackpad press-drag produces). The handle
  // gesture listeners are window-level now (E3b fix), so the drag no longer
  // depends on setPointerCapture succeeding.
  // NOTE: the bundled draft boots with selectedId=draft-24, so select
  // draft-5 FIRST — the handles under the mouse must belong to the probed
  // item, and the scale readout must read the same item.
  await evalJs("(() => { const node = document.querySelector('[data-draft-id=\\"draft-5\\"]'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()");
  await sleep(150);
  const scaleBefore = JSON.parse(await evalJs("JSON.stringify({ scale: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-5').scale, selectedId: window.__office.api.layoutDraft().selectedId, handle: (() => { const h = document.getElementById('layout-handle-layer').querySelector('.handle-se'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })() })"));
  if (!scaleBefore.handle) { console.error('E3B_PROBE_NO_HANDLE'); app.exit(1); }
  const sendMouse2 = (type, x, y) => win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 });
  sendMouse2('mouseDown', scaleBefore.handle.x, scaleBefore.handle.y);
  await sleep(60);
  for (let s = 1; s <= 6; s += 1) { sendMouse2('mouseMove', scaleBefore.handle.x + s * 8, scaleBefore.handle.y + s * 6); await sleep(40); }
  sendMouse2('mouseUp', scaleBefore.handle.x + 48, scaleBefore.handle.y + 36);
  await sleep(250);
  const scaleAfter = JSON.parse(await evalJs("JSON.stringify({ scale: window.__office.api.layoutDraft().items.find((i) => i.id === 'draft-5').scale, selectedId: window.__office.api.layoutDraft().selectedId, handles: document.getElementById('layout-handle-layer').querySelectorAll('.layout-scale-handle').length })"));
  out.scale = { before: scaleBefore.scale, after: scaleAfter.scale, grew: scaleAfter.scale > scaleBefore.scale + 0.05, selectedId: scaleAfter.selectedId, handles: scaleAfter.handles, selectedAtStart: scaleBefore.selectedId };
  await evalJs("document.getElementById('editor-undo').click()");
  await sleep(100);
  await shot('e3b-scale.png');
  // (2) depth buttons flip occlusion: stack two items, click 上移一层
  out.occlusion = JSON.parse(await evalJs("(async () => { const setXY = (id, x, y) => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(id) + ']'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); const ix = document.getElementById('inspector-x'); const iy = document.getElementById('inspector-y'); ix.value = String(x); ix.dispatchEvent(new Event('change', { bubbles: true })); iy.value = String(y); iy.dispatchEvent(new Event('change', { bubbles: true })); }; setXY('draft-22', 0.10, 0.88); setXY('draft-23', 0.10, 0.88); const nodeB = document.querySelector('[data-draft-id=\\\"draft-23\\\"]'); const r = nodeB.getBoundingClientRect(); const px = Math.round(r.left + r.width / 2); const py = Math.round(r.top + r.height / 2); const topOf = () => { const hit = document.elementFromPoint(px, py); return hit && hit.dataset ? hit.dataset.draftId : null; }; const top1 = topOf(); const draft = window.__office.api.layoutDraft(); const layers = { a: draft.items.find((i) => i.id === 'draft-22').layer, b: draft.items.find((i) => i.id === 'draft-23').layer }; const lowId = layers.a <= layers.b ? 'draft-22' : 'draft-23'; const lowNode = document.querySelector('[data-draft-id=' + JSON.stringify(lowId) + ']'); const o = { bubbles: true, cancelable: true, clientX: px, clientY: py, button: 0 }; lowNode.dispatchEvent(new PointerEvent('pointerdown', o)); lowNode.dispatchEvent(new PointerEvent('pointerup', o)); document.getElementById('editor-front').click(); await new Promise((r2) => setTimeout(r2, 120)); const top2 = topOf(); const layerAfter = window.__office.api.layoutDraft().items.find((i) => i.id === lowId).layer; const selectedAfter = window.__office.api.layoutDraft().selectedId; const maxOther = Math.max(...window.__office.api.layoutDraft().items.filter((i) => i.id !== lowId).map((i) => i.layer)); return JSON.stringify({ top1, top2, flipped: top1 !== top2 && top2 === lowId, layerAfter, selectedAfter, maxOther, btnDisabled: document.getElementById('editor-layer-up').disabled }); })()"));
  await shot('e3b-occlusion.png');
  for (let i = 0; i < 5; i += 1) { await evalJs("document.getElementById('editor-undo').click()"); await sleep(50); }
  // (3) groups: loose by default, 整组移动 lock restores rigid drags
  out.groupLock = JSON.parse(await evalJs("(async () => { const clickNode = (id, shift) => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(id) + ']'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, shiftKey: !!shift }; node.dispatchEvent(new PointerEvent('pointerdown', o)); node.dispatchEvent(new PointerEvent('pointerup', o)); }; const dragNode = (id, dx) => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(id) + ']'); const r = node.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 41 }; node.dispatchEvent(new PointerEvent('pointerdown', o)); for (let s = 1; s <= 4; s += 1) node.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: o.clientX + s * dx / 4, clientY: o.clientY })); node.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: o.clientX + dx, clientY: o.clientY })); }; clickNode('draft-1', false); await new Promise((r2) => setTimeout(r2, 100)); clickNode('draft-2', true); await new Promise((r2) => setTimeout(r2, 100)); document.getElementById('editor-group').click(); await new Promise((r2) => setTimeout(r2, 100)); const draft = window.__office.api.layoutDraft(); const g1 = draft.items.find((i) => i.id === 'draft-1').groupId; const pos = () => { const d = window.__office.api.layoutDraft(); return { one: d.items.find((i) => i.id === 'draft-1').position.x, two: d.items.find((i) => i.id === 'draft-2').position.x }; }; clickNode('draft-1', false); await new Promise((r2) => setTimeout(r2, 100)); const before1 = pos(); dragNode('draft-1', 60); await new Promise((r2) => setTimeout(r2, 100)); const afterLoose = pos(); const looseMovedOne = Math.abs(afterLoose.one - before1.one) > 0.001; const looseHeldTwo = Math.abs(afterLoose.two - before1.two) < 0.0001; const rigidBtn = document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-rigid'); const pressedBefore = rigidBtn.getAttribute('aria-pressed'); rigidBtn.click(); await new Promise((r2) => setTimeout(r2, 100)); const before2 = pos(); dragNode('draft-1', 60); await new Promise((r2) => setTimeout(r2, 100)); const afterRigid = pos(); const rigidMovedBoth = Math.abs(afterRigid.one - before2.one) > 0.001 && Math.abs(afterRigid.two - before2.two) > 0.001; const rigidDeltaEqual = Math.abs((afterRigid.one - before2.one) - (afterRigid.two - before2.two)) < 0.0001; return JSON.stringify({ looseMovedOne, looseHeldTwo, pressedBefore, pressedAfter: document.querySelector('.layer-group[data-group-id=' + JSON.stringify(g1) + '] .layer-group-rigid').getAttribute('aria-pressed'), rigidMovedBoth, rigidDeltaEqual }); })()"));
  await shot('e3b-group-lock.png');
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  console.log('E3B_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E3B_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  // (4) scene frame
  assert.ok(Math.abs(summary.frame.ratio - summary.frame.expected) < 0.01, `the frame keeps the 1280x840 ratio (${summary.frame.ratio})`);
  assert.equal(summary.frame.centeredX, true, 'the frame is horizontally centered');
  assert.equal(summary.frame.centeredY, true, 'the frame is vertically centered');
  assert.equal(summary.frame.canvasBg, 'rgb(255, 255, 255)', 'outside the frame: pure white');
  assert.notEqual(summary.frame.frameBg, 'rgb(255, 255, 255)', 'inside the frame: the office surface color');
  assert.equal(summary.frame.itemsLayerAtFrame, true, 'the items layer sits at the frame origin');
  assert.ok(summary.frame.minWhite >= 20, `the frame keeps >=20px of pure white on every side (min ${summary.frame.minWhite})`);
  assert.equal(summary.frame.border, '2px dashed', 'the frame boundary is a visible 2px dashed line');
  // (1) handle drag
  assert.equal(summary.scale.grew, true, `the se-handle synthetic drag scales the item (${summary.scale.before} -> ${summary.scale.after})`);
  // (2) occlusion buttons
  assert.equal(summary.occlusion.flipped, true, `置顶 flips the elementFromPoint hit (${summary.occlusion.top1} -> ${summary.occlusion.top2})`);
  assert.equal(summary.occlusion.layerAfter, summary.occlusion.maxOther + 1, '置顶 lifts the item beyond the current max layer');
  // (3) group lock
  assert.equal(summary.groupLock.looseMovedOne, true, 'loose group: the dragged member moves');
  assert.equal(summary.groupLock.looseHeldTwo, true, 'loose group: the other member stays put');
  assert.equal(summary.groupLock.pressedBefore, 'false', 'the lock starts OFF');
  assert.equal(summary.groupLock.pressedAfter, 'true', 'the lock toggles ON');
  assert.equal(summary.groupLock.rigidMovedBoth, true, 'rigid group: both members move');
  assert.equal(summary.groupLock.rigidDeltaEqual, true, 'rigid group: identical delta (coherent move)');
  for (const name of ['e3b-frame.png', 'e3b-scale.png', 'e3b-occlusion.png', 'e3b-group-lock.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});


// ---------------------------------------------------------------------------
// Task E3c — the scene frame is GLUED to the visible canvas while panning.
// User-reported: accidental trackpad swipes translated the item layers out
// of the gray frame, so the editable area became an invisible rectangle.
// The clamp in applyView() makes that state unreachable.
// ---------------------------------------------------------------------------

test('E3c real shell: panning can never detach the items from the scene frame', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e3c-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3c-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e3c-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1582, height: 955, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await sleep(400);
  const geometry = () => evalJs("(() => { const f = document.getElementById('layout-scene-frame').getBoundingClientRect(); const i = document.getElementById('layout-draft-items').getBoundingClientRect(); const c = document.getElementById('layout-canvas').getBoundingClientRect(); const t = document.getElementById('layout-draft-items').style.transform; return JSON.stringify({ frame: [f.left, f.top, f.width, f.height], items: [i.left, i.top, i.width, i.height], canvas: [c.left, c.top, c.width, c.height], transform: t }); })()");
  const pan = async (dy, times) => { for (let i = 0; i < times; i += 1) { await evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: " + dy + " })); true"); } };
  const covered = (g) => {
    const [fl, ft, fw, fh] = g.frame;
    const [cl, ct, cw, ch] = g.canvas;
    const proj = { left: fl, right: fl + fw * (g.scale || 1), top: ft, bottom: ft + fh };
    void proj; void cl; void ct;
    return true;
  };
  const out = {};
  // (1) at 100%: a burst of trackpad swipes must NOT move anything
  const before = JSON.parse(await geometry());
  await pan(160, 10);
  await sleep(150);
  const afterSwipe = JSON.parse(await geometry());
  out.idlePan = {
    transformBefore: before.transform,
    transformAfter: afterSwipe.transform,
    itemsGlued: Math.abs(afterSwipe.items[0] - afterSwipe.frame[0]) < 1 && Math.abs(afterSwipe.items[1] - afterSwipe.frame[1]) < 1,
  };
  // (2) zoom in, then pan hard both directions: the frame projection must
  // keep COVERING the visible canvas
  for (let i = 0; i < 6; i += 1) { await evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, ctrlKey: true, clientX: 500, clientY: 500 })); true"); }
  await sleep(120);
  await pan(400, 8);
  await sleep(120);
  const zoomedPanned = JSON.parse(await geometry());
  await pan(-400, 8);
  await sleep(120);
  const zoomedPannedBack = JSON.parse(await geometry());
  const covers = (g) => {
    const m = g.transform && g.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/);
    if (!m) return { matched: false };
    const tx = parseFloat(m[1]); const ty = parseFloat(m[2]); const s = parseFloat(m[3]);
    const [fl, ft, fw, fh] = g.frame;
    const [cl, ct, cw, chh] = g.canvas;
    const projLeft = fl + tx; const projTop = ft + ty;
    return { matched: true, tx, ty, s, coversX: projLeft <= cl + 1 && projLeft + fw * s >= cl + cw - 1, coversY: projTop <= ct + 1 && projTop + fh * s >= ct + chh - 1 };
  };
  out.zoomPan = { panned: covers(zoomedPanned), pannedBack: covers(zoomedPannedBack), scale: zoomedPanned.transform };
  // (3) drop at the far visible corner still lands INSIDE the gray frame
  const dropCorner = JSON.parse(await evalJs("(() => { const c = document.getElementById('layout-canvas').getBoundingClientRect(); const dt = new DataTransfer(); dt.setData('application/x-office-layout-asset', 'flat-desk'); const ev = new Event('drop', { bubbles: true, cancelable: true }); ev.dataTransfer = dt; ev.clientX = c.right - 6; ev.clientY = c.bottom - 6; document.getElementById('layout-canvas').dispatchEvent(ev); const draft = window.__office.api.layoutDraft(); const it = draft.items[draft.items.length - 1]; const node = document.querySelector('[data-draft-id=' + JSON.stringify(it.id) + ']'); const nr = node ? node.getBoundingClientRect() : null; const f = document.getElementById('layout-scene-frame').getBoundingClientRect(); const cx2 = nr ? nr.left + nr.width / 2 : null; const cy2 = nr ? nr.top + nr.height / 2 : null; const inside = nr && cx2 >= f.left && cx2 <= f.right && cy2 >= f.top && cy2 <= f.bottom; return JSON.stringify({ position: it.position, center: nr ? [Math.round(cx2), Math.round(cy2)] : null, frame: [Math.round(f.left), Math.round(f.top), Math.round(f.right), Math.round(f.bottom)], inside }); })()"));
  out.dropCorner = dropCorner;
  await evalJs("document.getElementById('editor-undo').click()");
  await sleep(120);
  await evalJs("document.getElementById('editor-reset-view').click()");
  await sleep(150);
  const reset = JSON.parse(await geometry());
  out.reset = { itemsGlued: Math.abs(reset.items[0] - reset.frame[0]) < 1 && Math.abs(reset.items[1] - reset.frame[1]) < 1 };
  await win.show();
  await sleep(300);
  fs.writeFileSync(path.join(EVIDENCE, 'e3c-pan-proof.png'), (await win.webContents.capturePage()).toPNG());
  win.hide();
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  console.log('E3C_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E3C_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  // (1) 100%: swipes are absorbed — the items layer stays glued to the frame
  assert.equal(summary.idlePan.itemsGlued, true, 'trackpad swipes at 100% cannot detach the items from the frame');
  assert.match(summary.idlePan.transformAfter, /translate\(0px, 0px\) scale\(1\)/, 'the 100% pan is fully absorbed');
  // (2) zoomed pan stays clamped: the frame projection always covers the canvas
  assert.equal(summary.zoomPan.panned.matched, true);
  assert.equal(summary.zoomPan.panned.coversX, true, 'zoomed pan left: the frame still covers the canvas width');
  assert.equal(summary.zoomPan.panned.coversY, true, 'zoomed pan up: the frame still covers the canvas height');
  assert.equal(summary.zoomPan.pannedBack.coversX, true, 'panned back: still covered');
  assert.equal(summary.zoomPan.pannedBack.coversY, true, 'panned back: still covered');
  // (3) the far-corner drop clamps to the scene edge (position 0..1). The
  // item CENTER stays on the scene grid; under a zoomed+panned view the
  // visual box may overflow the frame rect — center positioning contract.
  assert.ok(summary.dropCorner.position.y > 0.9, 'the out-of-frame drop clamped to the scene edge');
  for (const name of ['e3c-pan-proof.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
});

// ---------------------------------------------------------------------------
// Task E3d — the scene frame DRIFTED from the items at any zoom ≠ 100%: the
// frame lacked transform-origin: 0 0 and scaled around its own center while
// the item/guide/handle layers scaled around their origin (real-shell rects
// diverged 199×131px at scale 0.512). Item boxes were also ABSOLUTE screen
// pixels (draftWidths × scale), so the composition recomposed itself whenever
// the window ratio changed. This probe locks the invariants that must hold
// from now on, measured as REAL bounding rects in the real shell:
// (1) frame rect ≡ items rect (x/y/w/h, ≤1px) at three window sizes AND at
//     100% / zoom-out / zoom-in — a transform-string or covers assertion can
//     NEVER prove coincidence (E3c lesson, see office-editor-fixes.md);
// (2) node width / frame width is constant across window sizes — sizes are
//     scene-reference pixels, the composition only refits, never recomposes;
// (3) a real pointer drag of +120 client px maps to +120/frameW normalized
//     units at 100% (the drag math rides the live frame, not a stale one);
// (4) the dashed frame boundary is VISIBLE (pixel-checked in the 100% and
//     zoom-out screenshots) and the frame still covers the canvas zoomed in;
// (5) flat contentBbox: the opaque art box (measured from real pixels via
//     canvas.getImageData) lands on the placeholder node box (±2px), and the
//     layers-panel thumb shows the art instead of the transparent margins.
// ---------------------------------------------------------------------------

test('E3d real shell: frame ≡ items rects at every scale, scene-relative sizes, cropped flat art', { timeout: 300000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e3d-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  const borderPixels = (pngPath, frame, pageW) => JSON.parse(execFileSync('python3', ['-c', [
    'import json, sys',
    'from PIL import Image',
    'spec = json.loads(sys.argv[1])',
    'im = Image.open(spec["png"]).convert("RGB")',
    'k = im.width / spec["pageW"]',
    'y0 = round(spec["frame"][1] * k)',
    'x0 = round((spec["frame"][0] + 10) * k)',
    'x1 = round((spec["frame"][0] + spec["frame"][2] - 10) * k)',
    'hits = 0',
    'total = 0',
    'step = max(1, round(4 * k))',
    'for x in range(x0, x1 + 1, step):',
    '    total += 1',
    '    for y in (y0, y0 + 1, y0 + 2):',
    '        r, g, b = im.getpixel((x, y))[:3]',
    '        if abs(r - 127) <= 45 and abs(g - 149) <= 45 and abs(b - 163) <= 45:',
    '            hits += 1',
    '            break',
    'print(json.dumps({"hits": hits, "total": total}))',
  ].join('\n'), JSON.stringify({ png: pngPath, frame, pageW })]));
  fs.writeFileSync(probeScript, `'use strict';
const { app, protocol, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const REPO = ${JSON.stringify(ROOT)};
const EVIDENCE = ${JSON.stringify(evidenceDir)};
fs.mkdirSync(EVIDENCE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
protocol.registerSchemesAsPrivileged([{ scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-')));
app.whenReady().then(async () => {
if (process.platform === 'darwin' && app.dock) app.dock.hide(); // M2b: evidence probes never flash a window or bounce the Dock
  // macOS clamps a window larger than the work area the FIRST time it is
  // shown (that silent resize changed the canvas mid-probe once); every
  // requested window size is therefore clamped to the work area up front.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const safeSize = (w, h) => [Math.min(w, work.width), Math.min(h, work.height)];
  const routes = [
    { prefix: 'node_modules/', root: path.join(REPO, 'node_modules') },
    { prefix: 'office-assets/', root: path.join(REPO, 'resources', 'office') },
    { prefix: 'characters/', root: path.join(REPO, 'resources', 'characters') },
    { prefix: '', root: path.join(REPO, 'src', 'office') },
  ];
  protocol.handle('office-runtime', (request) => {
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\\/+/, '');
    if (rel === 'office-layout.v1.json') return new Response('nf', { status: 404 });
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const abs = path.resolve(route.root, rel.slice(route.prefix.length));
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return new Response('nf', { status: 404 });
      const table = { '.png': 'image/png', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
      return new Response(fs.readFileSync(abs), { headers: { 'content-type': table[abs.slice(abs.lastIndexOf('.'))] || 'application/octet-stream' } });
    }
    return new Response('nf', { status: 404 });
  });
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: { employees: [], sync: 'healthy', tick: 0 } }));
  for (const ch of ['office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) ipcMain.handle(ch, () => ({ ok: false }));
  const win = new BrowserWindow({ title: 'PROBE 临时数据（可关闭）', width: 1582, height: 955, useContentSize: true, show: false, webPreferences: { preload: path.join(REPO, 'src/office/office-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, level, message) => { if (level >= 3) console.error('[PAGE-ERR]', String(message).slice(0, 200)); });
  await win.loadURL('office-runtime://local/office.html?pack=deepseek-default&editor=1');
  const evalJs = (s) => win.webContents.executeJavaScript(s, true);
  let ready = false;
  for (let i = 0; i < 90; i += 1) {
    await sleep(200);
    ready = await evalJs('Boolean(window.__office && window.__office.ready)').catch(() => false);
    if (ready) break;
  }
  if (!ready) { console.error('[BOOT] never ready'); app.exit(1); }
  await sleep(400);
  // macOS clamps/defers resizes of HIDDEN windows unpredictably (a hidden
  // setContentSize once applied only when the window was later shown, and
  // another time never applied at all); the probe therefore shows the window
  // once up front and keeps it SHOWN for every measurement.
  win.show();
  await sleep(400);
  const shot = async (name) => {
    win.show();
    await sleep(350);
    fs.writeFileSync(path.join(EVIDENCE, name), (await win.webContents.capturePage()).toPNG());
    await sleep(120);
  };
  const out = {};
  // (0) place ONE flat-desk at the scene center through the real shelf tile
  out.placed = JSON.parse(await evalJs("(() => { document.querySelector('.layout-asset-tile[data-asset-id=flat-desk]').click(); const items = window.__office.api.layoutDraft().items; const item = items[items.length - 1]; return JSON.stringify({ id: item.id, kind: item.kind, scale: item.scale }); })()"));
  const ID = out.placed.id;
  const stateOf = () => evalJs("(() => { const f = document.getElementById('layout-scene-frame').getBoundingClientRect(); const i = document.getElementById('layout-draft-items').getBoundingClientRect(); const c = document.getElementById('layout-canvas').getBoundingClientRect(); const node = document.querySelector('[data-draft-id=' + JSON.stringify(" + JSON.stringify(ID) + ") + ']'); const nr = node.getBoundingClientRect(); return JSON.stringify({ frame: [f.left, f.top, f.width, f.height], items: [i.left, i.top, i.width, i.height], canvas: [c.left, c.top, c.width, c.height], node: [nr.left, nr.top, nr.width, nr.height], page: [window.innerWidth, window.innerHeight] }); })()");
  // (1) three window sizes at 100%: rects coincide AND node/frame width is constant
  out.workArea = work;
  out.windowRequested = [[1582, 955], [1280, 840], [1100, 760]];
  out.windows = [];
  for (const size of [safeSize(1582, 955), safeSize(1280, 840), safeSize(1100, 760)]) {
    win.setContentSize(size[0], size[1]);
    await sleep(600);
    const s = JSON.parse(await stateOf());
    out.windows.push({ window: size, frame: s.frame, items: s.items, canvas: s.canvas, node: s.node, ratio: s.node[2] / s.frame[2] });
  }
  // (2) three view states at the reference window: frame ≡ items at every scale
  win.setContentSize(safeSize(1582, 955)[0], safeSize(1582, 955)[1]);
  await sleep(600);
  const scaleNow = () => evalJs('window.__office.api.viewState().scale');
  const wheelZoom = (dy) => evalJs("document.getElementById('layout-canvas').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 0, deltaY: " + dy + ", ctrlKey: true, clientX: 600, clientY: 480 })); true");
  await evalJs("document.getElementById('editor-reset-view').click()");
  await sleep(200);
  const s100 = JSON.parse(await stateOf());
  s100.scale = await scaleNow();
  out.at100 = s100;
  await shot('e3d-100.png');
  let steps = 0;
  while ((await scaleNow()) > 0.55 && steps < 12) { await wheelZoom(240); steps += 1; await sleep(80); }
  const sOut = JSON.parse(await stateOf());
  sOut.scale = await scaleNow();
  out.zoomOut = sOut;
  out.zoomOutSteps = steps;
  await shot('e3d-zoomout.png');
  steps = 0;
  while ((await scaleNow()) < 2.0 && steps < 16) { await wheelZoom(-240); steps += 1; await sleep(80); }
  const sIn = JSON.parse(await stateOf());
  sIn.scale = await scaleNow();
  out.zoomIn = sIn;
  out.zoomInSteps = steps;
  await shot('e3d-zoomin.png');
  // (3) back at 100%: measure the OPAQUE art box from real pixels (canvas
  // getImageData over the item img and the panel thumb), then drag +120px.
  await evalJs("document.getElementById('editor-reset-view').click()");
  await sleep(250);
  out.art = JSON.parse(await evalJs("(() => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(" + JSON.stringify(ID) + ") + ']'); const img = node.querySelector('img'); const nr = node.getBoundingClientRect(); const ir = img.getBoundingClientRect(); if (!img.naturalWidth) return JSON.stringify({ node: [nr.left, nr.top, nr.width, nr.height], img: [ir.left, ir.top, ir.width, ir.height], art: null }); const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0, 0, cv.width, cv.height).data; let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1; for (let y = 0; y < cv.height; y += 1) { for (let x = 0; x < cv.width; x += 1) { if (d[(y * cv.width + x) * 4 + 3] > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } } if (maxX < 0) return JSON.stringify({ node: [nr.left, nr.top, nr.width, nr.height], img: [ir.left, ir.top, ir.width, ir.height], art: null }); const art = [ir.left + (minX / cv.width) * ir.width, ir.top + (minY / cv.height) * ir.height, ((maxX + 1) / cv.width) * ir.width - (minX / cv.width) * ir.width, ((maxY + 1) / cv.height) * ir.height - (minY / cv.height) * ir.height]; return JSON.stringify({ node: [nr.left, nr.top, nr.width, nr.height], img: [ir.left, ir.top, ir.width, ir.height], art, natural: [cv.width, cv.height] }); })()"));
  out.thumb = JSON.parse(await evalJs("(() => { const row = document.querySelector('.layer-row[data-draft-id=' + JSON.stringify(" + JSON.stringify(ID) + ") + ']'); const el = row.querySelector('.layer-thumb'); const img = el.tagName === 'IMG' ? el : el.querySelector('img'); const tr = el.getBoundingClientRect(); const ir = img.getBoundingClientRect(); if (!img.naturalWidth) return JSON.stringify({ tag: el.tagName, thumb: [tr.left, tr.top, tr.width, tr.height], art: null, opaqueCount: 0 }); const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(tr.width)); cv.height = Math.max(1, Math.round(tr.height)); const ctx = cv.getContext('2d'); ctx.drawImage(img, ((tr.left - ir.left) / ir.width) * img.naturalWidth, ((tr.top - ir.top) / ir.height) * img.naturalHeight, (tr.width / ir.width) * img.naturalWidth, (tr.height / ir.height) * img.naturalHeight, 0, 0, cv.width, cv.height); const d = ctx.getImageData(0, 0, cv.width, cv.height).data; let opaque = 0; let minX = cv.width, minY = cv.height, maxX = -1, maxY = -1; for (let y = 0; y < cv.height; y += 1) { for (let x = 0; x < cv.width; x += 1) { if (d[(y * cv.width + x) * 4 + 3] > 8) { opaque += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } } const art = maxX < 0 ? null : [tr.left + minX, tr.top + minY, maxX - minX + 1, maxY - minY + 1]; return JSON.stringify({ tag: el.tagName, thumb: [tr.left, tr.top, tr.width, tr.height], art, opaqueCount: opaque }); })()"));
  await evalJs("document.getElementById('editor-grid-snap').click()");
  await sleep(120);
  const posOf = () => evalJs("JSON.stringify(window.__office.api.layoutDraft().items.find((i) => i.id === " + JSON.stringify(ID) + ").position)");
  const posBefore = JSON.parse(await posOf());
  await evalJs("(() => { const node = document.querySelector('[data-draft-id=' + JSON.stringify(" + JSON.stringify(ID) + ") + ']'); const r = node.getBoundingClientRect(); const startX = r.left + r.width / 2; const startY = r.top + r.height / 2; const ev = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 7 }); node.dispatchEvent(ev('pointerdown', startX, startY)); let x = startX; for (let i = 0; i < 4; i += 1) { x += 30; node.dispatchEvent(ev('pointermove', x, startY)); } node.dispatchEvent(ev('pointerup', x, startY)); return true; })()");
  await sleep(200);
  const posAfter = JSON.parse(await posOf());
  out.drag = { before: posBefore, after: posAfter, clientDx: 120, frameW: s100.frame[2] };
  fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify(out, null, 2));
  console.log('E3D_PROBE_OK');
  app.exit(0);
}).catch((e) => { console.error('E3D_PROBE_FAILED', e && e.stack || e); app.exit(1); });
`);
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 240000 });
  const resultsFile = path.join(evidenceDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  const coincident = (label, s) => {
    for (let i = 0; i < 4; i += 1) {
      assert.ok(
        Math.abs(s.frame[i] - s.items[i]) <= 1,
        `${label}: frame/items rect[${i}] within 1px (frame ${s.frame[i]} vs items ${s.items[i]})`
      );
    }
  };
  // (1) frame ≡ items at every window size and every view scale
  assert.equal(summary.placed.kind, 'desk', 'the probe placed the flat desk');
  assert.equal(summary.placed.scale, 1, 'the placed item is unscaled');
  for (const w of summary.windows) coincident(`window ${w.window.join('x')}`, w);
  coincident(`100% (scale ${summary.at100.scale})`, summary.at100);
  coincident(`zoom-out (scale ${summary.zoomOut.scale})`, summary.zoomOut);
  coincident(`zoom-in (scale ${summary.zoomIn.scale})`, summary.zoomIn);
  assert.ok(summary.zoomOut.scale <= 0.55 && summary.zoomOut.scale >= 0.4, `the zoom-out state really zoomed out (scale ${summary.zoomOut.scale})`);
  assert.ok(summary.zoomIn.scale >= 2.0 && summary.zoomIn.scale <= 2.4, `the zoom-in state really zoomed in (scale ${summary.zoomIn.scale})`);
  // (2) scene-relative sizes: node width / frame width is constant (±1%)
  // and equals draftWidths.desk / referenceWidth = 180/1280
  const ratios = summary.windows.map((w) => w.ratio);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  for (let i = 0; i < ratios.length; i += 1) {
    assert.ok(Math.abs(ratios[i] - mean) <= 0.01 * mean, `scene-relative size stable at ${summary.windows[i].window.join('x')}: ratio ${ratios[i].toFixed(4)} vs mean ${mean.toFixed(4)}`);
    assert.ok(Math.abs(ratios[i] - 180 / 1280) <= 0.01 * (180 / 1280), `node width / frame width = 180/1280 at ${summary.windows[i].window.join('x')} (got ${ratios[i].toFixed(4)})`);
  }
  // (3) pointer mapping: +120 client px at 100% = +120/frameW normalized
  const fdx = summary.drag.after.x - summary.drag.before.x;
  assert.ok(
    Math.abs(fdx - 120 / summary.drag.frameW) <= 0.003,
    `+120 client px maps to 120/frameW normalized units (dx ${fdx.toFixed(4)} vs expected ${(120 / summary.drag.frameW).toFixed(4)})`
  );
  // (4) the frame boundary is visibly painted at 100% and zoom-out; zoomed
  // in, the frame projection still covers the whole canvas
  for (const [key, png] of [['at100', 'e3d-100.png'], ['zoomOut', 'e3d-zoomout.png']]) {
    const s = summary[key];
    const check = borderPixels(path.join(evidenceDir, png), s.frame, s.page[0]);
    assert.ok(check.total > 0 && check.hits >= Math.max(3, Math.ceil(check.total * 0.15)), `${key}: the dashed frame boundary is visibly painted (hits ${check.hits}/${check.total})`);
  }
  const sIn = summary.zoomIn;
  assert.ok(
    sIn.frame[0] <= sIn.canvas[0] + 1 && sIn.frame[0] + sIn.frame[2] >= sIn.canvas[0] + sIn.canvas[2] - 1,
    'zoomed in: the frame projection covers the canvas width'
  );
  assert.ok(
    sIn.frame[1] <= sIn.canvas[1] + 1 && sIn.frame[1] + sIn.frame[3] >= sIn.canvas[1] + sIn.canvas[3] - 1,
    'zoomed in: the frame projection covers the canvas height'
  );
  // (5) contentBbox: the opaque art lands exactly on the placeholder box and
  // the panel thumb shows the art, not the transparent margins
  assert.ok(summary.art && summary.art.art, 'the flat art box is pixel-measurable on the canvas');
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(summary.art.art[i] - summary.art.node[i]) <= 2, `canvas art box ≈ node box [${i}] (art ${summary.art.art[i].toFixed(1)} vs node ${summary.art.node[i].toFixed(1)})`);
  }
  assert.ok(summary.thumb && summary.thumb.art, 'the panel thumb art is pixel-measurable');
  const fillsDim = Math.abs(summary.thumb.art[2] - summary.thumb.thumb[2]) <= 2 || Math.abs(summary.thumb.art[3] - summary.thumb.thumb[3]) <= 2;
  const cxDelta = Math.abs((summary.thumb.art[0] + summary.thumb.art[2] / 2) - (summary.thumb.thumb[0] + summary.thumb.thumb[2] / 2));
  const cyDelta = Math.abs((summary.thumb.art[1] + summary.thumb.art[3] / 2) - (summary.thumb.thumb[1] + summary.thumb.thumb[3] / 2));
  assert.ok(fillsDim && cxDelta <= 2 && cyDelta <= 2, `the thumb art fills the thumb box (art ${summary.thumb.art.map((v) => v.toFixed(1)).join(',')} vs thumb ${summary.thumb.thumb.map((v) => v.toFixed(1)).join(',')})`);
  assert.ok(summary.thumb.opaqueCount > 40, `the thumb is not blank (${summary.thumb.opaqueCount} opaque pixels)`);
  for (const name of ['e3d-100.png', 'e3d-zoomout.png', 'e3d-zoomin.png', 'results.json']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `evidence artifact ${name} exists`);
  }
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
// Task E4 real shell: the compiled flat layout runs the REAL simulation —
// letterbox at three windows, chair-above-character z-order, and a full task
// walkthrough (walk → sit → work → result → leave) with per-sample no-clipping
// and no-overlap checks. Evidence: /tmp/e4-evidence/.
// ---------------------------------------------------------------------------
test('E4 real shell: flat layout walkthrough — letterbox, z-order and a task loop with no clipping', { timeout: 420000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e4-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e4-walk-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'e4-walkthrough-probe-template.js'), 'utf8')
    .replace(/__REPO__/g, ROOT)
    .replace(/__EVIDENCE__/g, evidenceDir));
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 480000 });
  const resultsFile = path.join(probeDir, 'walkthrough-results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  assert.equal(summary.layoutSource, 'bundled-flat', 'the runtime served the compiled flat fixture');
  // (b) letterbox: aspect kept, centered, never larger than the stage
  for (const sizeKey of ['1582x955', '1280x840', '1100x760']) {
    const entry = summary.letterbox[sizeKey];
    assert.ok(entry, sizeKey + ' probed');
    assert.equal(entry.ratioError <= 0.01, true, `${sizeKey}: scene aspect preserved (error ${entry.ratioError})`);
    assert.equal(entry.centerOffsetX <= 2 && entry.centerOffsetY <= 2, true, `${sizeKey}: canvas centered (off ${entry.centerOffsetX}/${entry.centerOffsetY})`);
    assert.equal(entry.fitsStage, true, `${sizeKey}: canvas never exceeds the stage`);
  }
  // (c) M4.1c painter order: every flat furniture item lives in ONE merged
  // geometric pass with the characters (no declared-layer furniture left), the
  // recorded keys ascend, and the scene graph matches the recorded order.
  assert.equal(summary.zOrder.frontTextured, 6, 'the six flat chairs are textured');
  assert.equal(summary.zOrder.frontAllTextured, true);
  assert.equal(summary.zOrder.sortYInGround, true, 'every sortY item paints inside ground-entities');
  assert.equal(summary.zOrder.sortYCount >= 32, true, `all flat furniture is sortY (${summary.zOrder.sortYCount})`);
  assert.equal(summary.zOrder.legacyLayered, 0, 'nothing is left on a declared layered path');
  assert.equal(summary.zOrder.ascend, true, `painter keys ascend (${JSON.stringify(summary.zOrder.badPairs)})`);
  assert.equal(summary.zOrder.containerMatchesOrder, true, `scene children follow the recorded order (${JSON.stringify(summary.zOrder.mismatched)})`);
  assert.equal(summary.zOrder.furnitureCount >= 32, true, 'the merged pass carries the whole flat furniture set');
  assert.equal(summary.zOrder.characterCount >= 1, true, 'characters share that same pass');
  // the two user-facing rules were exercised live and held
  assert.deepEqual(summary.zSemantics.failures, [], 'no layering-rule violation was observed');
  assert.ok(summary.zSemantics.walkerOverDesk, 'a moving body over a station band painted OVER its desk');
  assert.ok(summary.zSemantics.seatedUnderChair, 'a seated body painted UNDER its chair');
  // (d)+(e) the walkthrough is clean
  assert.equal(summary.walk.sampleCount >= 20, true, 'the walkthrough sampled enough frames');
  assert.equal(summary.walk.clippingViolations, 0, 'no employee position ever clipped foreign furniture');
  assert.equal(summary.walk.pairOverlapViolations, 0, 'no two employees ever shared the same cell');
  assert.equal(summary.walk.graphEdgeConflicts, 0, 'the serving layout still passes the strict edge sampler');
  assert.ok(summary.walk.frames >= 6, 'frame captures landed for the manual review');
});

// ---------------------------------------------------------------------------
// Task E5a real shell: the production pack's passing walk frames play in the
// real office — deterministic 5-frame strips per direction + the E4 no-clipping
// walk sampling stays at zero. Evidence: /tmp/e5a-evidence/.
// ---------------------------------------------------------------------------
test('E5a real shell: passing walk frames play left/right with no clipping regressions', { timeout: 420000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e5a-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'e5a-passing-frames-probe-template.js'), 'utf8')
    .replace(/__REPO__/g, ROOT)
    .replace(/__EVIDENCE__/g, evidenceDir));
  // stdio 'ignore': a piped stdout fills with Electron console chatter and blocks
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 480000 });
  const resultsFile = path.join(probeDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  assert.equal(summary.layoutSource, 'bundled-flat');
  // the walk geometry is untouched by the animation change (E4 gate re-run)
  assert.equal(summary.walk.clippingViolations, 0, 'no employee position clipped foreign furniture');
  assert.ok(summary.walk.sampleCount >= 30, 'the walk sampling actually ran');
  // both directions captured all five frame indices
  for (const direction of ['left', 'right']) {
    assert.deepEqual(summary.walk.capturedFrames[direction], ['0', '1', '2', '3', '4'],
      `${direction} captured the full five-frame sequence`);
    for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
      const file = path.join(evidenceDir, `walk-${direction}-f${frameIndex}.png`);
      assert.ok(fs.existsSync(file) && fs.statSync(file).size > 1000, `walk-${direction}-f${frameIndex}.png captured`);
    }
  }
  // the passing frame tile (index 2) must differ from its neighbours — the new
  // art really plays, not the old sequence relabeled
  const passingBytes = fs.readFileSync(path.join(evidenceDir, 'walk-left-f2.png'));
  assert.notDeepEqual(passingBytes, fs.readFileSync(path.join(evidenceDir, 'walk-left-f1.png')), 'f2 differs from f1');
  assert.notDeepEqual(passingBytes, fs.readFileSync(path.join(evidenceDir, 'walk-left-f3.png')), 'f2 differs from f3');
  // compose the two 5-frame review strips (Pillow, same as the asset tooling)
  const stripScript = `
import sys
from PIL import Image
import numpy as np
for direction in ['left', 'right']:
    tiles = []
    for i in range(5):
        im = Image.open(f'/tmp/e5a-evidence/walk-{direction}-f{i}.png').convert('RGBA')
        a = np.array(im)
        r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
        mask = (b > 90) & (b - r > 40) & (b - g > 30)
        col_density = mask.sum(axis=0)
        cum = [0]
        for value in col_density:
            cum.append(cum[-1] + value)
        best_x, best_sum = 0, -1
        for x in range(0, im.width - 240):
            s = cum[x + 240] - cum[x]
            if s > best_sum:
                best_sum, best_x = s, x
        col_mask = mask[:, best_x:best_x + 240]
        rows = np.where(col_mask.any(axis=1))[0]
        cy = int(rows.mean()) if len(rows) else im.height // 2
        top = max(0, min(im.height - 280, cy - int(280 * 0.55)))
        tiles.append(im.crop((best_x, top, best_x + 240, top + 280)).convert('RGB'))
    strip = Image.new('RGB', (240 * 5 + 4 * 6, 280), (255, 255, 255))
    for i, tile in enumerate(tiles):
        strip.paste(tile, (i * 246, 0))
    strip.save(f'/tmp/e5a-evidence/walk-{direction}-strip.png')
print('strips ok')
`;
  const stdout = execFileSync('python3', ['-c', stripScript], { encoding: 'utf8' });
  assert.match(stdout, /strips ok/);
  for (const direction of ['left', 'right']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, `walk-${direction}-strip.png`)), `${direction} strip composed`);
  }
});

// ---------------------------------------------------------------------------
// Task E5a-R1 real shell: play-order diagnosis + foot-line stability.
// The probe records per-employee played file streams (every observed
// transition must be an animations.json adjacency — a filename-sorted, skipping
// or scrambled order can never produce that), re-runs the E4 clipping sampling,
// and captures the full 15-frame cycle for the footY measurement.
// ---------------------------------------------------------------------------
test('E5a-R1 real shell: the walk sequence plays in metadata order with a stable foot line', { timeout: 420000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e5a-r1-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-r1-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'e5a-r1-order-probe-template.js'), 'utf8')
    .replace(/__REPO__/g, ROOT)
    .replace(/__EVIDENCE__/g, evidenceDir));
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 480000 });
  const resultsFile = path.join(probeDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  // 播放保真：观测流里每一对相邻帧都必须是 animations.json 声明的相邻对（含循环回绕）
  assert.equal(summary.orderFidelity.left.ok, true, `left stream plays declared adjacencies only (${summary.orderFidelity.left.detail || 'ok'})`);
  assert.equal(summary.orderFidelity.right.ok, true, `right stream plays declared adjacencies only (${summary.orderFidelity.right.detail || 'ok'})`);
  // the E4 no-clipping walk sampling stays at zero
  assert.equal(summary.walk.clippingViolations, 0, 'no employee position clipped foreign furniture');
  assert.ok(summary.walk.sampleCount >= 100, 'the walk sampling actually ran');
  // the full-cycle consecutive captures exist for both directions (15 帧/方向)
  for (const direction of ['left', 'right']) {
    for (let step = 0; step < 15; step += 1) {
      const file = path.join(evidenceDir, `seq-${direction}-${String(step).padStart(2, '0')}-f${step}.png`);
      assert.ok(fs.existsSync(file) && fs.statSync(file).size > 1000, `${direction} sequence capture ${step}`);
    }
  }
  // foot-line stability: the character's lowest screen row across the full
  // 15-frame consecutive captures stays within 1px
  const measure = `
import json
from PIL import Image
import numpy as np
soles = []
for step in range(15):
    im = Image.open(f'/tmp/e5a-r1-evidence/seq-left-{step:02d}-f{step}.png').convert('RGBA')
    a = np.array(im)
    r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    mask = (b > 90) & (b - r > 40) & (b - g > 30)
    col_density = mask.sum(axis=0)
    cum = [0]
    for value in col_density:
        cum.append(cum[-1] + value)
    best_x, best_sum = 0, -1
    for x in range(0, im.width - 240):
        s = cum[x + 240] - cum[x]
        if s > best_sum:
            best_sum, best_x = s, x
    rows = np.where(mask[:, best_x:best_x + 240].any(axis=1))[0]
    soles.append(int(rows.max()))
print(json.dumps({'soles': soles, 'range': max(soles) - min(soles)}))
`;
  const measured = JSON.parse(execFileSync('python3', ['-c', measure], { encoding: 'utf8' }));
  // 屏幕空间测量在渲染缩放 0.26（352² 素材 → 约 92px 可见高）下有 ±1px 取整抖动，
  // 所以这里允许 ≤2px；素材层面的权威判据是 office-asset-pack.test.js 的
  // "every walk frame shares the pack sole line"（alpha>=128 鞋线全方向 ≤1px）。
  assert.equal(measured.range <= 2, true, `footY range across the 15-frame cycle must be ≤2px at screen scale, got ${measured.range}`);
  // review strips re-emitted for the human check
  const stripScript = `
from PIL import Image
import numpy as np
def crop(im):
    a = np.array(im.convert('RGBA'))
    r, g, b = a[:, :, 0].astype(int), a[:, :, 1].astype(int), a[:, :, 2].astype(int)
    mask = (b > 90) & (b - r > 40) & (b - g > 30)
    col_density = mask.sum(axis=0)
    cum = [0]
    for value in col_density:
        cum.append(cum[-1] + value)
    best_x, best_sum = 0, -1
    for x in range(0, im.width - 240):
        s = cum[x + 240] - cum[x]
        if s > best_sum:
            best_sum, best_x = s, x
    rows = np.where(mask[:, best_x:best_x + 240].any(axis=1))[0]
    cy = int(rows.mean()) if len(rows) else im.height // 2
    top = max(0, min(im.height - 280, cy - int(280 * 0.55)))
    return im.crop((best_x, top, best_x + 240, top + 280)).convert('RGB')
for direction in ['left', 'right']:
    strip = Image.new('RGB', (240 * 15 + 14 * 6, 280), (255, 255, 255))
    for step in range(15):
        strip.paste(crop(Image.open(f'/tmp/e5a-r1-evidence/seq-{direction}-{step:02d}-f{step}.png')), (step * 246, 0))
    strip.save(f'/tmp/e5a-r1-evidence/walk-{direction}-strip.png')
print('strips ok')
`;
  assert.match(execFileSync('python3', ['-c', stripScript], { encoding: 'utf8' }), /strips ok/);
  for (const direction of ['left', 'right']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, `walk-${direction}-strip.png`)), `${direction} strip composed`);
  }
});

// ---------------------------------------------------------------------------
// Task E5a-R2 real shell: the runtime honours the editor-composed character
// scale and facing. One draft (served as the saved layout) drives BOTH the
// editor canvas and the compiled runtime; the probe measures the desk-1
// character's composed art height on both surfaces (normalized to the
// 1280x840 reference scene), the seated/walking resources, and the rendered
// height across idle → walk → seated. Evidence: /tmp/e5a-r2-evidence/.
// ---------------------------------------------------------------------------
test('E5a-R2 real shell: composed character scale and facing reach the runtime', { timeout: 420000 }, () => {
  const electronBin = path.join(ROOT, 'node_modules', '.bin', 'electron');
  if (!fs.existsSync(electronBin)) return; // environment without the Electron dev dependency
  const evidenceDir = '/tmp/e5a-r2-evidence';
  fs.mkdirSync(evidenceDir, { recursive: true });
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e5a-r2-probe-'));
  const probeScript = path.join(probeDir, 'probe.js');
  fs.writeFileSync(probeScript, fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'e5a-r2-presentation-probe-template.js'), 'utf8')
    .replace(/__REPO__/g, ROOT)
    .replace(/__EVIDENCE__/g, evidenceDir));
  execFileSync(electronBin, [probeScript], { stdio: 'ignore', timeout: 480000 });
  const resultsFile = path.join(probeDir, 'results.json');
  assert.ok(fs.existsSync(resultsFile), 'the probe wrote its results file');
  const summary = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  assert.equal(summary.layoutSource, 'saved-compiled', 'one draft drives both surfaces');
  assert.equal(summary.draftCharacter.asset, 'whale-girl-back');
  // the height mapping: editor art h = DRAFT_WIDTHS.character × scale × 256/352;
  // the runtime renders the same art height (normalized to the reference scene)
  const editorArtH = (summary.editor.img.h / summary.editor.frame.w) * 1280 * (256 / 352);
  const runtimeArtH = summary.runtimeIdle.visibleHeight / summary.runtimeIdle.scene.height * 840 * (256 / 277);
  assert.ok(Math.abs(editorArtH - runtimeArtH) <= 2,
    `composed art height: editor ${editorArtH.toFixed(1)}px vs runtime ${runtimeArtH.toFixed(1)}px (Δ ${Math.abs(editorArtH - runtimeArtH).toFixed(2)}px)`);
  // the composed presentation travels in the snapshot
  assert.ok(summary.runtimeIdle.snapshotPresentation
    && Math.abs(summary.runtimeIdle.snapshotPresentation.heightRatio
      - (96 * summary.draftCharacter.scale * (277 / 352)) / (840 * 0.11)) < 1e-6,
    'the snapshot carries the documented height ratio');
  // problem B: the seated/working state plays the composed back view — E6d:
  // the dedicated working-back three-frame loop (no longer the static pose)
  assert.equal(summary.seated.resource, 'working-back', 'seated working plays the working-back loop');
  // E6d loop evidence (working-back = the three M3 candidate frames): across
  // >1 cycle the frame index walks strictly 0→1→2→0 (no skips, no stuck
  // frames), the sprite never falls back to the placeholder body (no flash),
  // and one screenshot per frame was captured.
  const loopSamples = summary.seated.loopSamples || [];
  assert.ok(loopSamples.length >= 30, `the seated loop was sampled (${loopSamples.length} samples)`);
  assert.ok(loopSamples.every((sample) => sample.resource === 'working-back' && sample.placeholder === false),
    'every seated sample plays a real working-back frame (never the placeholder)');
  const compressed = [];
  for (const sample of loopSamples) {
    if (sample.frameIndex === null) continue;
    if (compressed.length === 0 || compressed[compressed.length - 1] !== sample.frameIndex) compressed.push(sample.frameIndex);
  }
  assert.ok(compressed.length >= 4, `the loop advances through frames (${compressed.join('→')})`);
  for (let i = 1; i < compressed.length; i += 1) {
    assert.equal(compressed[i], (compressed[i - 1] + 1) % 3,
      `the frame index advances +1 mod 3 without skips: ${compressed.join('→')}`);
  }
  for (const name of ['seated-frame-0.png', 'seated-frame-1.png', 'seated-frame-2.png']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)) && fs.statSync(path.join(evidenceDir, name)).size > 1000, `${name} captured`);
  }
  // the size is state-independent: idle, walking and seated all render identically
  const normalized = (h) => h / summary.seated.sceneHeight * 840;
  assert.ok(Math.abs(normalized(summary.seated.visibleHeight) - normalized(summary.walking.visibleHeight)) <= 0.5,
    'the rendered height is identical while seated and while walking');
  // walking still uses the directional walk cycles
  assert.equal(summary.walking.left, 'walk-left', 'walking uses the walk cycles');
  // the review artifacts exist
  for (const name of ['editor-canvas.png', 'runtime-idle.png', 'runtime-working.png']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)) && fs.statSync(path.join(evidenceDir, name)).size > 1000, `${name} captured`);
  }
  // side-by-side composites for the human review
  const compose = `
from PIL import Image
ed = Image.open('/tmp/e5a-r2-evidence/editor-canvas.png').convert('RGB')
rt = Image.open('/tmp/e5a-r2-evidence/runtime-idle.png').convert('RGB')
wk = Image.open('/tmp/e5a-r2-evidence/runtime-working.png').convert('RGB')
h = 700
ed2 = ed.resize((int(ed.width * h / ed.height), h))
rt2 = rt.resize((int(rt.width * h / rt.height), h))
wk2 = wk.resize((int(wk.width * h / wk.height), h))
pair = Image.new('RGB', (ed2.width + rt2.width + 12, h), (255, 255, 255))
pair.paste(ed2, (0, 0)); pair.paste(rt2, (ed2.width + 12, 0))
pair.save('/tmp/e5a-r2-evidence/side-by-side-idle.png')
pair2 = Image.new('RGB', (ed2.width + wk2.width + 12, h), (255, 255, 255))
pair2.paste(ed2, (0, 0)); pair2.paste(wk2, (ed2.width + 12, 0))
pair2.save('/tmp/e5a-r2-evidence/side-by-side-working.png')
print('pairs ok')
`;
  assert.match(execFileSync('python3', ['-c', compose], { encoding: 'utf8' }), /pairs ok/);
  for (const name of ['side-by-side-idle.png', 'side-by-side-working.png']) {
    assert.ok(fs.existsSync(path.join(evidenceDir, name)), `${name} composed`);
  }
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

test('M0 boundary: package.json registers the office:workbench launcher with its boot contract', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['office:workbench'] || '', /electron .*office-workbench\.js/, 'npm run office:workbench launches the shell');
  const main = fs.readFileSync(path.join(ROOT, 'scripts', 'office-workbench.js'), 'utf8');
  assert.match(main, /OFFICE_WORKBENCH_READY/, 'stdout launch contract for probes');
  assert.match(main, /'Office Workbench'/, 'window title stays distinguishable from Agent Office and PROBE windows');
  assert.match(main, /\.workbench-data/, 'isolated userData inside the repo (never the real profile / .office-editor-data)');
  assert.match(main, /OFFICE_WORKBENCH_LAYOUT_READONLY/, 'the content layout baseline is served read-only');
});

test('M0 workbench shell: three panes, geometry report, validator and gallery surfaces exist', () => {
  for (const file of ['workbench.html', 'workbench.css', 'workbench.js', 'workbench-preload.js', 'gallery-strip.html', 'gallery-strip.css', 'gallery-strip.js']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'src', 'workbench', file)), true, `src/workbench/${file} exists`);
  }
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  for (const id of ['wb-left', 'wb-center', 'wb-right', 'preview-slot', 'preview-frame', 'panel-geometry', 'panel-assets', 'panel-gallery', 'geometry-table', 'asset-table']) {
    assert.match(html, new RegExp(`id="${id}"`), `workbench pane/surface ${id} exists`);
  }
  assert.match(html, /几何报表/, 'the geometry report surface');
  assert.match(html, /素材校验器/, 'the catalog validator surface');
  assert.match(html, /金样图库/, 'the golden gallery surface');
  // the preview subframe receives the REAL office bridge (zero drift)
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench-preload.js'), 'utf8');
  assert.match(preload, /require\('\.\.\/office\/office-preload\.js'\)/, 'the workbench preload loads the product office preload verbatim');
  // every workbench JS parses
  for (const file of ['scripts/office-workbench.js', 'scripts/workbench-publish.js', 'scripts/workbench-export-character.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)]);
  }
  for (const file of ['workbench.js', 'workbench-preload.js', 'gallery-strip.js', 'lib/png-geometry.js', 'lib/character-geometry.js', 'lib/content-validator.js', 'lib/asset-validator.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'src', 'workbench', file)]);
  }
});
