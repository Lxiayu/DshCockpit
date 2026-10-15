'use strict';

// studio/lib/preview/runner.js — the preview runner (P7, brief §7G).
//
// The studio's preview embeds the REAL office page, and this runner hands that page a
// snapshot produced by the REAL office module — the same file the product boots
// (src/office/office-module.js), driven from the main process. Nothing is re-implemented
// and nothing is mocked: the employees you watch walk are the product's own state
// machine, on its own 16ms logical clock, with its own scheduler, movement controller,
// dialogue engine and transition controller.
//
//   const runner = createPreviewRunner({ repoRoot, contentDir, charactersRoot });
//   runner.play({ speed: 2 });            // wall-clock loop, logical ticks inside
//   runner.inject({ type: 'agent/status', sessionId: 'sess-a', seq: 1, data: { status: 'running' } });
//   runner.snapshot();                    // what the page renders
//   runner.diagnostics();                 // sync + employees + activity + diagnostics
//
// Determinism: the logical clock only ever advances by TICK_MS × ticks, and the module is
// seeded, so a scenario script replayed twice produces the same snapshots (the test
// hashes them). Wall-clock pacing is presentation, never simulation.

const path = require('node:path');
const fs = require('node:fs');

const officeModule = require(path.join(__dirname, '..', '..', '..', 'src', 'office', 'office-module.js'));
const assetPack = require(path.join(__dirname, '..', '..', '..', 'src', 'office', 'runtime', 'asset-pack.js'));
const privacyRedactor = require(path.join(__dirname, '..', '..', '..', 'src', 'office', 'runtime', 'privacy-redactor.js'));
const scan = require('../scan.js');

const TICK_MS = officeModule.TICK_MS;
const PACK_ID = 'deepseek-default';
const SNAPSHOT_PUSH_MS = 100;

function createPreviewRunner({
  repoRoot,
  contentDir,
  charactersRoot,
  seed = 'studio-preview-seed',
  config = null,
  layoutFixture = null,
  pack = null,
  onSnapshot = null,
}) {
  const packRoot = path.join(charactersRoot, PACK_ID);
  const resolvedPack = pack || assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(packRoot, 'animation', 'animations.json'), 'utf8')),
  }).pack;
  // The layout comes from the PRODUCT's own resolution chain (saved draft → bundled flat
  // → isometric) via office-module.loadRuntimeLayoutFixture, so the preview runs exactly
  // what the app would boot with. No userData is passed: the studio previews the shipped
  // baseline, while the scene canvas validates draft edits separately.
  // NOTE: createOfficeModule takes the RAW fixture and builds the layout itself; handing
  // it a createOfficeLayout() result throws SCENE_INVALID/DESK_MISSING (the shape is
  // already resolved) — the smoke test caught exactly that.
  let layoutSource = 'provided';
  let layoutFixtureValue = layoutFixture;
  if (!layoutFixtureValue) {
    const resolution = officeModule.loadRuntimeLayoutFixture({ userDataDir: null, log: () => {} });
    if (!resolution || !resolution.fixture) {
      return {
        ok: false,
        code: (resolution && resolution.code) || 'OFFICE_LAYOUT_UNAVAILABLE',
        message: 'the runtime layout could not be resolved (see office-module.loadRuntimeLayoutFixture)',
      };
    }
    layoutFixtureValue = resolution.fixture;
    layoutSource = resolution.source;
  }

  const office = officeModule.createOfficeModule({
    layout: layoutFixtureValue,
    pack: resolvedPack,
    seed,
    config: { ...(config || {}) },
    log: () => {},
  });

  let playing = false;
  let speed = 1;
  let timer = null;
  let lastPushMs = 0;
  let logicalMs = 0;
  let ticks = 0;
  const injections = [];      // the injected script (for the evidence + repeatability)
  const listeners = new Set();

  function snapshot() {
    return office.state();
  }

  function stepLogical(ticksToRun = 1) {
    for (let index = 0; index < ticksToRun; index += 1) {
      office.advanceOneTick();
      ticks += 1;
      logicalMs += TICK_MS;
    }
    return { ticks, logicalMs };
  }

  // Wall-clock loop: real time decides HOW OFTEN we tick, never how far the simulation
  // moves per tick — so pausing, throttling or a slow machine cannot change the outcome.
  function startLoop() {
    if (timer) return;
    const intervalMs = 16;
    timer = setInterval(() => {
      const ticksPerInterval = Math.max(1, Math.round(speed * (intervalMs / TICK_MS)));
      stepLogical(ticksPerInterval);
      // A LISTENER is a sink too. The original guard was `if (onSnapshot && …)`, so a
      // subscriber that passed no onSnapshot callback never received anything — which is
      // exactly how the studio's runtime view ended up frozen at its boot snapshot.
      const hasSink = Boolean(onSnapshot) || listeners.size > 0;
      if (hasSink && Date.now() - lastPushMs >= SNAPSHOT_PUSH_MS) {
        lastPushMs = Date.now();
        const payload = office.state();
        for (const listener of listeners) listener('snapshot', payload);
        if (onSnapshot) onSnapshot(payload);
      }
    }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function play({ speed: nextSpeed = speed } = {}) {
    speed = Math.min(8, Math.max(0.25, Number(nextSpeed) || 1));
    playing = true;
    startLoop();
    return status();
  }

  function pause() {
    playing = false;
    if (timer) clearInterval(timer);
    timer = null;
    return status();
  }

  function inject(event) {
    const normalized = {
      sessionId: String(event.sessionId || 'sess-preview'),
      type: String(event.type || 'agent/status'),
      seq: Number.isInteger(event.seq) ? event.seq : injections.length + 1,
      time: Number.isInteger(event.time) ? event.time : logicalMs,
      data: event.data && typeof event.data === 'object' ? event.data : {},
    };
    injections.push(normalized);
    const result = office.ingestHarnessEvent(normalized);
    if (onSnapshot) onSnapshot(office.state());
    return { ok: result && result.status !== 'rejected', result, event: normalized };
  }

  function control(kind, employeeId) {
    if (kind === 'followup') return office.dispatch({ employeeId });
    if (kind === 'cancel') return office.cancel({ employeeId });
    if (kind === 'interrupt') return office.interrupt({ employeeId });
    return { ok: false, code: 'CONTROL_UNKNOWN' };
  }

  function status() {
    return { playing, speed, ticks, logicalMs, injections: injections.length, tickMs: TICK_MS, seed };
  }

  function employeesSummary() {
    const state = office.state();
    return (state.employees || []).map((employee) => ({
      employeeId: employee.employeeId,
      name: (employee.profile && employee.profile.name) || employee.employeeId,
      activity: employee.activity || null,
      // the animation state lives on employee.animation.resource (the product's own
      // shape) — reading `resource` alone showed 'working' while the phase was already
      // 'result', which the failed-branch test caught
      resource: (employee.animation && employee.animation.resource) || employee.resource || null,
      phase: employee.transition ? employee.transition.phase : null,
      outcome: employee.lastResult ? employee.lastResult.outcome : null,
      segment: employee.segment ? employee.segment.kind : null,
      preTaskNodeId: employee.preTaskNodeId || null,
      position: employee.position ? { x: Number(employee.position.x.toFixed(4)), y: Number(employee.position.y.toFixed(4)) } : null,
      bubble: employee.bubble ? { text: employee.bubble.text, topic: employee.bubble.topic || null } : null,
    }));
  }

  function diagnostics() {
    const state = office.state();
    return {
      ok: true,
      status: status(),
      sync: state.sync || null,
      scene: state.scene || null,
      employees: employeesSummary(),
      queue: office.debugRegistrySnapshot ? (office.debugRegistrySnapshot().queue || null) : null,
      reservations: office.debugReservations ? office.debugReservations() : null,
      rootHandles: office.debugRootHandleCounts ? office.debugRootHandleCounts() : null,
      diagnostics: (state.diagnostics || []).slice(-20),
      activityLog: (state.activityLog || []).slice(-20),
      settings: office.getSettings ? office.getSettings() : null,
    };
  }

  // The diagnostics bundle a support request sends: everything above, REDACTED, and
  // refused if any secret shape survived the redactor.
  function exportBundle({ extra = {} } = {}) {
    // The PRODUCT's own redactor walks the structure (redactText only substitutes a whole
    // blob — using it produced a 15-byte "bundle", caught by the smoke test). Same policy
    // as the app's diagnostics export, so a bundle from the studio and one from the app
    // carry the same fields with the same redaction.
    const redactor = privacyRedactor.createPrivacyRedactor({ mode: 'redacted' });
    const raw = { exportedAt: new Date().toISOString(), source: 'studio-preview-runner', layoutSource, seed, ...diagnostics(), ...extra };
    const redactedValue = typeof redactor.redactValue === 'function' ? redactor.redactValue(raw) : raw;
    const text = JSON.stringify(redactedValue, null, 2);
    const scanOutcome = scan.scanForSecrets(text);
    return { ok: scanOutcome.ok, text, hits: scanOutcome.hits, injections: injections.length, bytes: text.length };
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function destroy() {
    pause();
    listeners.clear();
    if (office.destroy) office.destroy();
  }

  return {
    TICK_MS,
    ok: true,
    layoutSource,
    control,
    destroy,
    diagnostics,
    employeesSummary,
    exportBundle,
    inject,
    layout: office.layout,
    office,
    pause,
    play,
    seed,
    snapshot,
    status,
    step: (count = 1) => ({ ...stepLogical(count), ...status() }),
    subscribe,
  };
}

// ---- the scenario scripts the panel/CLI can replay ---------------------------
//
// A script is a list of {after: ms, event} steps; replaying one twice produces the same
// snapshots (the test asserts it). These are the four session events the brief names.
const SCENARIOS = Object.freeze({
  'task-complete': [
    { afterMs: 0, event: { type: 'agent/status', data: { status: 'running' } } },
    { afterMs: 6000, event: { type: 'tool/call', data: { tool: 'read_file' } } },
    { afterMs: 14000, event: { type: 'turn/end', data: { reason: 'completed' } } },
  ],
  // the failed branch: the task must REACH the desk before the terminal arrives, and the
  // adapter's failed reason is 'failed' (not 'error' — that is the animation state)
  'task-failed': [
    { afterMs: 0, event: { type: 'agent/status', data: { status: 'running' } } },
    { afterMs: 16000, event: { type: 'turn/end', data: { reason: 'failed' } } },
  ],
  'approval-wait': [
    { afterMs: 0, event: { type: 'agent/status', data: { status: 'running' } } },
    { afterMs: 5000, event: { type: 'approval/asked', data: { tool: 'shell' } } },
    { afterMs: 12000, event: { type: 'approval/answered', data: { decision: 'allow' } } },
    { afterMs: 20000, event: { type: 'turn/end', data: { reason: 'completed' } } },
  ],
});

module.exports = { PACK_ID, SCENARIOS, SNAPSHOT_PUSH_MS, TICK_MS, createPreviewRunner };
