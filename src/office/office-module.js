'use strict';

// src/office/office-module.js — Task 7 / SPEC-07.
//
// The single main-process Office composition root. It composes the Task 3/4/5
// pure runtime (movement, scheduler, registry/queue, reducer, transition) and
// the Task 6 adapter into ONE simulation with ONE logical clock, and exposes a
// privacy-redacted snapshot plus the seven `office:*` IPC channels.
//
// Boundaries (SPEC-00/05/07):
// - Renderer/UI consume ONLY `state()` snapshots; they never subscribe to
//   Harness and never receive session IDs, prompts, tool arguments or raw
//   errors. The snapshot is whitelist-built AND passed through the shared
//   privacy redactor as a safety net.
// - P1 exception (authorized by docs/strategy/2026-09-23-office-right-panel-
//   spec.md §4): the snapshot carries an AGGREGATE `usage` block (today's
//   token counts + money estimate, assembled by main.js from the shell's own
//   caches) and a `pending` list of approval/question requests. Neither
//   carries task text, per-session/per-task token attribution or session ids;
//   pending ids are the waterfall event handles the shared answer channel
//   needs to address a request.
// - Raw Harness session/run ids stay INSIDE the main process as registry
//   handles only. Subagent runIds are consumed as Task-6 PROXIES verbatim
//   (`fact.runId`, already `run-sha256:*`); this module never re-hashes a
//   proxy and only ever calls deriveRunProxy() on a raw id seen in raw
//   Harness history (never on a fact).
// - cancel/interrupt acknowledgements are never terminal evidence. There is
//   no live Harness RPC wiring in Task 7: control intents are recorded as
//   `cancellationPending` with a CONTROL_UNWIRED diagnostic until the
//   harness subscription lands.
// - Visibility pauses the logical clock; resume continues from the current
//   logical position and never replays time.
// - Two office views consume this one module: one snapshot, one clock.

const fs = require('node:fs');
const path = require('node:path');

const profiles = require('./runtime/employee-profile.js');
const { createMovementController } = require('./runtime/movement-controller.js');
const { createBehaviorScheduler } = require('./runtime/behavior-scheduler.js');
const { createDialogueEngine } = require('./runtime/dialogue-engine.js');
const { createEmployeeRegistry } = require('./runtime/employee-registry.js');
const { createOfficeState, reduceOfficeState } = require('./runtime/state-reducer.js');
const { createTransitionController } = require('./runtime/transition-controller.js');
const { resolveAnimation } = require('./runtime/animation-controller.js');
const { createRuntimeAdapter, deriveRunProxy } = require('./runtime/runtime-adapter.js');
const { createPrivacyRedactor } = require('./runtime/privacy-redactor.js');
const { createOfficeLayout } = require('./runtime/office-layout.js');
const { resolveRuntimeLayout } = require('./runtime/office-layout-compiler.js');
const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require('./layout-assets.js');
const { SETTINGS_BOUNDS: PERSISTED_SETTINGS_BOUNDS } = require('./runtime/office-persistence.js');
// P1 data pipeline (docs/strategy/2026-09-23-office-right-panel-spec.md §4/§5):
// the approval risk table and the tool phrase vocabulary live beside the other
// pure office runtime modules so the panel, the pending cards and main.js
// share one implementation.
const { classifyRisk, RISK_ORDER } = require('./runtime/approval-risk.js');
const { toolPhraseZhOf, questionSummaryZh } = require('./runtime/tool-phrases.js');

const TICK_MS = 16;
// M2 (2026-09-16): the renderer paints on snapshot pushes (its Pixi ticker is
// stopped by contract — "rendering happens on snapshot pushes, not on a
// clock"), so the push cadence IS the view frame rate. The old 100ms throttle
// quantized walking to ~10fps; per-tick pushes restore ~60fps while the
// renderer stays a pure snapshot projection (no interpolation, single clock).
// IPC cost is one small structured-clone per open view per tick — bounded by
// the two-view limit, and nothing is pushed while every view is hidden (the
// paused clock stops advancing, so the due check never fires).
const PUSH_INTERVAL_MS = TICK_MS;
// Task 7A: a task route can be TRANSIENTLY blocked by another employee's
// crossing path reservation. The move phase retries the route plan before the
// permanent in-place degradation, so one crossing never loses a whole task.
// M4.1g: how long a resident WALKING TO ITS DESK to nap waits for a blocked
// corridor before giving the nap up. The walk is a mission (the seat is
// reserved), so it is not abandoned on the first block — but it is bounded, so
// no walker stands still with a live route indefinitely (M4.1e stall bound).
const NAP_WALK_WAIT_MAX_MS = 6000;
const ROUTE_RETRY_DELAY_MS = 250;
const ROUTE_RETRY_BUDGET_MS = 10000;
const ACTIVITY_LOG_LIMIT = 200;
const DIAGNOSTICS_LIMIT = 100;
const SNAPSHOT_LOG_TAIL = 50;
const SNAPSHOT_DIAGNOSTICS_TAIL = 20;
const MAX_IPC_PAYLOAD_BYTES = 8 * 1024;
// P1 pending block (spec §4): the office module is the runtime bridge for
// waterfall requests (approval/request, user-questions/request). `id` is the
// waterfall eventId when the runtime supplies one (0.1.5 mux), else a derived
// handle for the 0.1.1 server-request rpcId — both are stored so the shared
// answer path can resolve either. Duplicate deliveries of one event are
// idempotent (the eventId IS the key), and a long-unanswered backlog is capped
// so the snapshot stays bounded (oldest first).
const PENDING_LIMIT = 50;
const PENDING_DETAIL_REF = 'office:pending-detail';
const PENDING_KINDS = Object.freeze(['approval', 'question']);

const OFFICE_IPC_CHANNELS = Object.freeze([
  'office:state',
  'office:dispatch',
  'office:cancel',
  'office:interrupt',
  'office:settings',
  'office:diagnostics',
  'office:visibility',
]);

const PROVEN_CAPABILITIES = Object.freeze({
  cancel: true,
  interrupt: true,
  followup: true,
  steer: true,
  inject: true,
  pause: false,
  resume: false,
  preempt: false,
});

// SPEC-08 persistence contract: the canonical persisted/IPC settings name is
// `userFrameDurationOverrideMs`. The Task 7 name `frameDurationOverrideMs` is
// accepted ONLY as a one-way inbound compatibility alias (see
// normalizeSettingsPartial); it is never stored, returned or persisted.
const DEFAULT_SETTINGS = Object.freeze({
  reducedMotion: false,
  resultPresentationMs: 5000,
  // 2026-09-22 步频匹配：二代行走素材（方案B）每循环隐含前进约 48px
  // （左右走两鞋最大间距 63/70px @352² × 92.4/256 ≈ 23~25px/步 × 2 步），
  // 循环 1245ms → 约 38.6px/s → 38.6 / 840 ≈ 0.046。取 0.12 时脚底打滑约 2.6 倍。
  // 该值有持久化设置与校验区间（0.02~0.6），后续仍可按观感微调。
  sceneMinDimensionPerSecond: 0.046,
  userFrameDurationOverrideMs: null,
  sleepAfterMs: 300000,
  chatDurationMs: 15000,
  privacyMode: 'redacted',
  // Task 4 internal pacing for the anchor interpolation segments
  // (approach-to-seat / seat-to-approach). Reduced motion forces 0.
  workstationAnchorSegmentMs: 600,
});

const SETTINGS_SCHEMA = Object.freeze({
  reducedMotion: { type: 'boolean' },
  resultPresentationMs: { type: 'int', min: 1000, max: 30000 },
  sceneMinDimensionPerSecond: { type: 'number', min: 0.02, max: 0.6 },
  userFrameDurationOverrideMs: { type: 'intOrNull', min: 60, max: 2000 },
  sleepAfterMs: { type: 'int', min: 60000, max: 24 * 60 * 60 * 1000 },
  chatDurationMs: { type: 'int', min: 3000, max: 10 * 60 * 1000 },
  privacyMode: { type: 'enum', values: ['redacted', 'full'] },
});

// One-way legacy alias mapping (Task 7 IPC payload -> SPEC-08 contract). The
// canonical key always wins when both are present; the legacy key never
// appears in module state, snapshots or persistence.
const LEGACY_SETTINGS_ALIASES = Object.freeze({
  frameDurationOverrideMs: 'userFrameDurationOverrideMs',
});

function normalizeSettingsPartial(partial) {
  if (!isPlainObject(partial)) return partial;
  const out = {};
  for (const [key, value] of Object.entries(partial)) {
    const canonical = LEGACY_SETTINGS_ALIASES[key];
    if (canonical) {
      if (!(canonical in partial)) out[canonical] = value;
      continue; // the legacy key itself is dropped here
    }
    out[key] = value;
  }
  return out;
}

const EMPLOYEE_IDS = Object.freeze([
  ...profiles.RESIDENT_EMPLOYEE_IDS,
  profiles.COLLABORATOR_ID,
]);

// Pure leave-target selection over the roaming roster: nearest reachable
// roaming node by screen distance with a stable node-id tie-break.
// Exported for deterministic tests; the module supplies isReachable from the
// movement controller.
function resolveLeaveNodeId({ nodes, fromPosition, scene, isReachable } = {}) {
  const candidates = (Array.isArray(nodes) ? nodes : [])
    .filter((node) => node && Array.isArray(node.tags) && node.tags.includes('roaming') && /^roam-/.test(node.id))
    .filter((node) => !isReachable || isReachable(node.id));
  let best = null;
  let bestDistance = Infinity;
  for (const node of candidates) {
    const distance = Math.hypot(
      (node.position.x - fromPosition.x) * scene.width,
      (node.position.y - fromPosition.y) * scene.height
    );
    if (distance < bestDistance || (distance === bestDistance && best !== null && node.id < best)) {
      best = node.id;
      bestDistance = distance;
    }
  }
  return best;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

// Module-level so IPC payload validation enforces the SAME bounds before any
// value ever reaches the module instance.
function validateSettingsPartial(rawPartial) {
  const partial = normalizeSettingsPartial(rawPartial);
  if (!isPlainObject(partial)) return { ok: false, code: 'SETTINGS_INVALID' };
  for (const key of Object.keys(partial)) {
    const rule = SETTINGS_SCHEMA[key];
    const value = partial[key];
    if (!rule) return { ok: false, code: 'SETTINGS_INVALID' };
    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, code: 'SETTINGS_INVALID' };
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(value)) return { ok: false, code: 'SETTINGS_INVALID' };
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max) {
        return { ok: false, code: 'SETTINGS_INVALID' };
      }
    } else if (rule.type === 'int') {
      if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
        return { ok: false, code: 'SETTINGS_INVALID' };
      }
    } else if (rule.type === 'intOrNull') {
      if (value !== null && (!Number.isInteger(value) || value < rule.min || value > rule.max)) {
        return { ok: false, code: 'SETTINGS_INVALID' };
      }
    }
  }
  return { ok: true };
}

function createOfficeModule(options = {}) {
  const {
    layout: layoutFixture = null,
    pack = null,
    seed = 'office-seed',
    config = null,
    log = () => {},
  } = options || {};

  const layout = layoutFixture
    ? createOfficeLayout(layoutFixture)
    : createOfficeLayout(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'office-layout.json'), 'utf8')));

  // Task 7 keeps the simulation in the fixture's logical reference scene; the
  // renderer reprojects the snapshot to the live window size.
  const referenceScene = layout.scene();
  const scene = { width: referenceScene.referenceWidth, height: referenceScene.referenceHeight };

  // The ONLY clock: a fixed-step logical counter. No wall-clock reads.
  let logicalMs = 0;
  const clock = { nowMs: () => logicalMs };

  const cfg = {
    ...DEFAULT_SETTINGS,
    ...(normalizeSettingsPartial(config) || {}),
  };
  const settings = { ...cfg };

  const movement = createMovementController({
    graph: layout.waypointGraph(),
    config: { sceneMinDimensionPerSecond: cfg.sceneMinDimensionPerSecond },
    clock,
  });
  const transitionCtl = createTransitionController();
  const scheduler = createBehaviorScheduler({
    graph: layout.waypointGraph(),
    movement,
    clock,
    seed,
    config: {
      sleepAfterMs: cfg.sleepAfterMs,
      chatCooldownMs: Math.max(500, Math.round(cfg.chatDurationMs / 3)),
      // M4.1g: the nap cap/duration/refractory are behavior constants with
      // module-creation overrides (same shape as sleepAfterMs) so the frozen
      // office can be tuned without touching the scheduler source.
      ...(Number.isInteger(cfg.maxSleepers) && cfg.maxSleepers > 0 ? { maxSleepers: cfg.maxSleepers } : {}),
      ...(Number.isFinite(cfg.sleepDurationMs) && cfg.sleepDurationMs > 0 ? { sleepDurationMs: cfg.sleepDurationMs } : {}),
      ...(Number.isFinite(cfg.sleepRefractoryMs) && cfg.sleepRefractoryMs >= 0 ? { sleepRefractoryMs: cfg.sleepRefractoryMs } : {}),
    },
    employeeIds: [...EMPLOYEE_IDS],
  });
  const registry = createEmployeeRegistry({ clock });
  const queue = registry.queueController;

  // M4.1d: dialogue corpus is INJECTED (never read from content/** — the
  // product boundary lock). Missing corpus simply means no bubbles: the
  // module keeps running, nothing else changes.
  const dialogueBase = options.dialogue && isPlainObject(options.dialogue.base) ? options.dialogue.base : null;
  const dialogueLimits = Object.freeze({
    bubbleMs: (dialogueBase && dialogueBase.limits && Number.isFinite(dialogueBase.limits.bubbleMs))
      ? dialogueBase.limits.bubbleMs
      : 3200,
    maxConcurrent: (dialogueBase && dialogueBase.limits && Number.isFinite(dialogueBase.limits.maxConcurrent))
      ? dialogueBase.limits.maxConcurrent
      : 2,
  });
  const dialogueEngine = dialogueBase
    ? createDialogueEngine({
        base: dialogueBase,
        characterOverrides: (options.dialogue && isPlainObject(options.dialogue.characterOverrides)) ? options.dialogue.characterOverrides : {},
        cooldownMs: (dialogueBase.limits && Number.isFinite(dialogueBase.limits.cooldownMs)) ? dialogueBase.limits.cooldownMs : 30000,
      })
    : null;
  // speaker rotation per pair key: members alternate across consecutive picks
  const dialogueTurns = new Map();
  let redactor = createPrivacyRedactor({ mode: settings.privacyMode });

  const nodesById = new Map(layout.nodes().map((node) => [node.id, node]));

  // Task E5a-R2 — the editor-composed character presentation. The compiled
  // flat layout carries per-workstation character data from the user's draft
  // items (scale + direction). Mapping formula (documented in the renderer
  // too): the editor composes the character at node width
  // DRAFT_WIDTHS.character × itemScale scene px and the frame art fills
  // frameArtH / packCanvas of that box, so the composed ART height is
  //   editorArtH = DRAFT_WIDTHS.character × scale × frameArtH / packCanvasW.
  // The runtime renders the art at
  //   runtimeArtH = visibleHeight × frameArtH / unionH
  // (visibleHeight is measured on the pack's union visibleBounds), so equal
  // heights require
  //   visibleHeight(refScene) = DRAFT_WIDTHS.character × scale × unionH / packCanvasW,
  // delivered to the renderer as a RATIO over the linear default
  // (refH × 0.11) so it re-projects to any live scene size; the renderer
  // clamps the final height to the SPEC-02 band [64, 180] (extreme drafts
  // outside roughly scale [0.85, 2.38] at 840 hit the clamps).
  const composedPresentationByDesk = new Map();
  const composedWorkstations = layout.workstations();
  if (composedWorkstations && Array.isArray(composedWorkstations.instances)) {
    for (const instance of composedWorkstations.instances) {
      if (instance.character && Number.isFinite(instance.character.scale) && instance.character.scale > 0) {
        composedPresentationByDesk.set(instance.deskId, instance.character);
      }
    }
  }
  const composedHeightRatioByDesk = new Map();
  const composedBackResource = pack && typeof pack.animation === 'function' && pack.animation('side-back') ? 'side-back' : null;
  // Task E6d: the pack may carry a dedicated back-facing seated-work loop
  // (working-back, 3 frames). When present it replaces the static side-back
  // pose for the WORKING state of composed back views; every other steady
  // state keeps side-back, and packs without it degrade exactly as before.
  const composedWorkingBackResource = pack && typeof pack.animation === 'function' && pack.animation('working-back')
    ? 'working-back'
    : null;
  if (pack && pack.geometry && composedBackResource) {
    const unionH = pack.geometry.visibleBounds.height;
    const packCanvasW = pack.geometry.outputCanvas.width;
    for (const [deskId, composed] of composedPresentationByDesk) {
      const composedHeight = DRAFT_WIDTHS.character * composed.scale * (unionH / packCanvasW);
      composedHeightRatioByDesk.set(deskId, composedHeight / (scene.height * 0.11));
    }
  }

  // ---- per-employee records -------------------------------------------------

  const employees = new Map();
  for (const employeeId of EMPLOYEE_IDS) {
    const profile = profiles.getResidentProfile(employeeId) || profiles.getCollaboratorProfile();
    const seat = nodesById.get(profile.defaultSeat) || layout.desks()[0];
    employees.set(employeeId, {
      employeeId,
      displayName: profile.displayName,
      role: profile.role,
      seatNodeId: seat.id,
      position: { x: seat.position.x, y: seat.position.y },
      currentNodeId: seat.id,
      facing: 'down',
      route: null,
      routeIndex: 0,
      targetNodeId: null,
      pathReservation: null,
      transition: null,
      pendingTerminal: null,
      resultUntilMs: null,
      lastResult: null,
      toolKind: null,
      animationElapsedMs: 0,
      state: createOfficeState(),
      turnCounter: 0,
      // Task E5a-R2: the composed presentation (height ratio over the default
      // + the composed facing) — null when the layout composes nothing
      presentation: (() => {
        const ratio = composedHeightRatioByDesk.get(seat.id) || null;
        const composed = composedPresentationByDesk.get(seat.id) || null;
        if (!ratio) return null;
        return { heightRatio: ratio, facing: composed && composed.direction === 'back' ? 'back' : null };
      })(),
      // E5c: dialogue bubble — set when paired and stationary; renderer draws it
      bubble: null,
      // Task 4 golden-workstation transition state
      workstation: null, // { deskId, approachNodeId, seatAnchor, approachAnchor }
      workstationReservation: null,
      segment: null, // { kind: 'approach-to-seat' | 'seat-to-approach', from, to, startedAtMs, durationMs }
      preTaskNodeId: null,
      preTaskPosition: null,
      leaveTargetNodeId: null,
      reachedSeat: false,
      routeRetryAt: null,
      routeRetryDeadline: null,
      // SPEC-04 decision points: the node a finished local walk arrived at
      // (reported to the scheduler on the next tick, then cleared).
      arrivedNodeId: null,
      // M4.1g: when the current nap-to-desk walk started waiting for a
      // blocked corridor (bounded by NAP_WALK_WAIT_MAX_MS).
      napWalkWaitSinceMs: null,
    });
  }

  // ---- shared bookkeeping ---------------------------------------------------

  let globalSync = 'healthy';
  let visibilityNoted = false;
  const visibleViews = new Set();
  const listeners = new Set();
  let lastPushAtMs = null;
  let autoTimer = null;
  const activityLog = [];
  const diagnostics = [];
  const adapters = new Map(); // raw root sessionId -> adapter
  // Raw Harness root sessionId -> CURRENT active internal binding handle.
  // The registry keeps session ids single-use, so turn 2+ of the same raw
  // root session binds under a derived `raw#tN` handle; this map is the ONLY
  // bridge from incoming raw ids to the active handle. Cleared when the
  // mapped binding releases; internal handles never leave the main process.
  const activeRootHandles = new Map();
  // Task 7B-R1: raw root session -> queued turn handle (S -> S#tN). One
  // queued item per turn: repeated running facts reuse the queued handle
  // instead of deriving S#t(N+1); the mapping is consumed on retain
  // (terminal), dispatch, cancel and binding failure.
  const queuedRootHandles = new Map();
  // Task 7B-R2: derived queued handle -> raw root session. The CONTROLLED
  // reverse lookup used at dispatch promotion — raw ids are never recovered
  // by parsing derived handle strings.
  const rootHandleByDerived = new Map();
  // proxied subagent runId -> { childSessionId, parentSessionId }
  const runsByProxy = new Map();
  // P1 right-panel data blocks (spec §4). `usage` is assembled by main.js from
  // the shell's own caches (token-stats/cost/balance) and injected here; the
  // module never collects. `pending` is written from waterfall events
  // (approval/request, user-questions/request) and removed through the shared
  // answer path; pendingRoutes keeps the answer routing handle per item id
  // (never in the snapshot).
  let usageBlock = null;
  const pendingItems = new Map(); // id -> contract item (insertion ordered)
  const pendingRoutes = new Map(); // id -> { rpcId } — the runtime routing id

  function noteLog(kind, employeeId, detail) {
    activityLog.push(detail
      ? { atMs: logicalMs, employeeId, kind, ...detail }
      : { atMs: logicalMs, employeeId, kind });
    if (activityLog.length > ACTIVITY_LOG_LIMIT) activityLog.splice(0, activityLog.length - ACTIVITY_LOG_LIMIT);
  }

  function noteDiagnostic(code) {
    diagnostics.push({ atMs: logicalMs, code });
    if (diagnostics.length > DIAGNOSTICS_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_LIMIT);
  }

  function reduce(rec, event) {
    const result = reduceOfficeState(rec.state, event);
    rec.state = result.state;
    return result.effects;
  }

  function nearestNodeId(position) {
    let best = null;
    let bestDistance = Infinity;
    for (const node of nodesById.values()) {
      const distance = Math.hypot(node.position.x - position.x, node.position.y - position.y);
      if (distance < bestDistance) {
        best = node.id;
        bestDistance = distance;
      }
    }
    return best;
  }

  function allReservations(rec) {
    const shared = scheduler.reservations();
    const own = [rec.workstationReservation, rec.pathReservation, rec.parkReservation].filter(Boolean);
    // M4.1a (2026-09-17): OTHER employees' path/workstation reservations must
    // be visible too — without this the movement controller's cross-character
    // segment conflict check was unreachable at runtime (walkers passed
    // through each other; long-roam reproduction: 2331 overlapping ticks).
    const others = [];
    for (const other of employees.values()) {
      if (other === rec) continue;
      if (other.workstationReservation) others.push(other.workstationReservation);
      if (other.pathReservation) others.push(other.pathReservation);
    }
    return [...shared, ...others, ...own];
  }

  function releasePathReservation(rec) {
    if (!rec.pathReservation) return;
    movement.releaseReservation({ reservations: [], id: rec.pathReservation.id });
    rec.pathReservation = null;
  }

  // M4.1a: a walker that must stand still ON a node (waiting for its next leg)
  // claims that node so nobody else can walk INTO the spot it occupies —
  // releasing the leg alone would leave the parked body unprotected (the E4
  // probe's "two stationary employees on one spot" violation). The claim is
  // short-lived and renewed while parked, dropped the moment walking resumes.
  function releaseParkClaim(rec) {
    if (!rec.parkReservation) return;
    movement.releaseReservation({ reservations: [], id: rec.parkReservation.id });
    rec.parkReservation = null;
  }

  function ensureParkClaim(rec, at) {
    if (!rec.currentNodeId) return;
    if (rec.parkReservation && rec.parkReservation.nodeId === rec.currentNodeId
        && movement.isRenewalDue(rec.parkReservation, at)) {
      rec.parkReservation = movement.renewReservation({ reservation: rec.parkReservation, nowMs: at });
      return;
    }
    if (rec.parkReservation && rec.parkReservation.nodeId === rec.currentNodeId) return;
    releaseParkClaim(rec);
    const acquired = movement.acquireReservation({
      employeeId: rec.employeeId,
      purpose: 'park',
      nodeId: rec.currentNodeId,
      segments: [],
      reservations: allReservations(rec),
      nowMs: at,
      ttlMs: 2000,
      safeRadius: 0.03,
    });
    rec.parkReservation = acquired.ok ? acquired.reservation : null;
  }

  // The workstation reservation is NOT the generic node-arrival path's
  // business: it is acquired at task start and released only when the stand
  // segment has reached the approach AND the leave route is acquired (or by
  // explicit interruption cleanup).
  function releaseWorkstationReservation(rec) {
    if (!rec.workstationReservation) return;
    movement.releaseReservation({ reservations: [], id: rec.workstationReservation.id });
    rec.workstationReservation = null;
  }

  function anchorSegmentDurationMs() {
    if (settings.reducedMotion) return 0;
    const configured = Number(settings.workstationAnchorSegmentMs);
    return Number.isFinite(configured) && configured >= 0 ? configured : 600;
  }

  function facingFor(from, to) {
    const dx = (to.x - from.x) * scene.width;
    const dy = (to.y - from.y) * scene.height;
    if (dx === 0 && dy === 0) return 'down';
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  // Leave target resolution: the original preTaskNodeId when it still exists,
  // otherwise the nearest reachable roaming node (screen distance, stable id
  // tie-break). Pure helper exported below for deterministic tests.
  function nearestReachableRoamNodeId(rec, at) {
    return resolveLeaveNodeId({
      nodes: layout.nodes(),
      fromPosition: rec.position,
      scene,
      isReachable: (nodeId) => Array.isArray(movement.findRoute({
        fromNodeId: rec.workstation.approachNodeId,
        toNodeId: nodeId,
        behavior: 'task',
        reservations: scheduler.reservations(),
        nowMs: at,
        employeeId: rec.employeeId,
      })),
    });
  }

  // Plans a fresh route + path reservation. Stale paths never survive a new
  // target (SPEC-03 transition cleanup contract).
  // M4.1a: fail-closed PER-LEG walking. Nodes are parking spots, legs are
  // critical sections: a walker advances along its current leg only while a
  // segment reservation for that leg is live, re-acquires at every node, and
  // stands still (truthfully) whenever the corridor is taken. Whole-route
  // atomic holds serialized the whole floor behind one walker; walking
  // WITHOUT any reservation let two unreserved movers pass through each other.
  const movementLib = require('./runtime/movement-controller.js');

  function currentLegSegments(rec) {
    if (!rec.route || rec.route.length <= 1) return null;
    const fromId = rec.route[Math.min(rec.routeIndex, rec.route.length - 2)];
    const toId = rec.route[Math.min(rec.routeIndex + 1, rec.route.length - 1)];
    const a = nodesById.get(fromId);
    const b = nodesById.get(toId);
    if (!a || !b) return null;
    return [{ from: { ...a.position }, to: { ...b.position } }];
  }

  function tryAcquirePathReservation(rec, at) {
    const segments = currentLegSegments(rec);
    if (!segments) return true;
    const attempt = () => movement.acquireReservation({
      employeeId: rec.employeeId,
      purpose: 'path',
      nodeId: null,
      segments,
      reservations: allReservations(rec),
      nowMs: at,
      ttlMs: 10000, // a leg takes a few seconds; the ttl is a backstop only
      // social distance between walkers; 0.03 ≈ 25px still keeps bodies
      // clearly apart (the E4 probe's own detector trips below 20px) without
      // serialising the narrow corridors
      safeRadius: 0.03,
    });
    let acquired = attempt();
    if (!acquired.ok) {
      const blockers = movementLib.findConflictingReservations({
        reservations: allReservations(rec), segments, scene, employeeId: rec.employeeId,
      });
      rec.routeBlockedBy = blockers.map((b) => `${b.owner}:${b.purpose}`).join(',') || null;
    }
    if (!acquired.ok && isTaskBound(rec)) {
      // M4.1a priority: a task route outranks ROAM traffic — release the roam
      // legs this leg conflicts with and retry once. Roamers re-acquire per
      // leg immediately when still clear, so nothing is starved.
      const conflicts = movementLib.findConflictingReservations({
        reservations: allReservations(rec),
        segments,
        scene,
        employeeId: rec.employeeId,
      });
      let released = false;
      for (const conflicting of conflicts) {
        const ownerRec = employees.get(conflicting.owner);
        if (ownerRec && ownerRec.pathReservation && conflicting.id === ownerRec.pathReservation.id && !isTaskBound(ownerRec)) {
          releasePathReservation(ownerRec);
          released = true;
        }
      }
      rec.debugPreemptAttempts = (rec.debugPreemptAttempts || 0) + 1;
      if (released) {
        rec.debugPreempts = (rec.debugPreempts || 0) + 1;
        acquired = attempt();
        if (!acquired.ok) {
          rec.debugSecondBlockers = movementLib.findConflictingReservations({
            reservations: allReservations(rec), segments, scene, employeeId: rec.employeeId,
          }).map((b) => (b.owner || '?') + ':' + (b.purpose || '?')).join(',') || 'none';
        }
      }
    }
    rec.debugAcquireCode = acquired.ok ? null : (acquired.code || 'UNKNOWN');
    rec.debugAcquireBlockedBy = acquired.ok ? null : (movementLib.findConflictingReservations({
      reservations: allReservations(rec),
      segments,
      scene,
      employeeId: rec.employeeId,
    })[0] || {}).owner || null;
    rec.pathReservation = acquired.ok ? acquired.reservation : null;
    if (acquired.ok) rec.routeUnavailableAt = null;
    else {
      rec.routeUnavailableAt = at;
      noteDiagnostic('ROUTE_UNAVAILABLE');
    }
    return acquired.ok;
  }

  function isTaskBound(rec) {
    // any phase in which the employee is WALKING for a task: the outbound
    // move (task-start) AND the walk-out leave (task-end) — omitting either
    // lets roam legs deadlock a task route forever.
    const transition = rec.transition;
    if (!transition) return false;
    if (transition.kind === 'task-start' && ['stop', 'turn', 'move', 'arrive'].includes(transition.phase)) return true;
    if (transition.kind === 'task-end' && transition.phase === 'leave') return true;
    return false;
  }

  function planRoute(rec, route, targetNodeId, at) {
    releasePathReservation(rec);
    releaseParkClaim(rec);
    rec.route = Array.isArray(route) ? [...route] : null;
    rec.routeIndex = 0;
    rec.targetNodeId = targetNodeId || null;
    tryAcquirePathReservation(rec, at);
  }

  // ---- adapter composition ---------------------------------------------------

  function handleAdapterOutput(output, rawEvent) {
    for (const fact of output.facts) applyFact(fact, output.envelope, rawEvent);
    for (const diag of output.diagnostics) noteDiagnostic(diag.code || 'ADAPTER_DIAGNOSTIC');
    recomputeGlobalSync();
  }

  function recomputeGlobalSync() {
    let next = 'healthy';
    for (const adapter of adapters.values()) {
      const sync = adapter.state().sync;
      if (sync === 'stale') { next = 'stale'; break; }
      if (sync === 'resyncing') next = 'resyncing';
    }
    if (next === globalSync) return;
    globalSync = next;
    for (const rec of employees.values()) reduce(rec, { type: 'sync/status', sync: next });
    if (next === 'stale') noteDiagnostic('SYNC_STALE');
    pushSnapshot();
  }

  // Resolves the CURRENT active internal handle for a raw root session id.
  // Child/unclassified sessions pass through unchanged (direct active
  // binding). Returns null when no active binding exists.
  function currentRootHandle(sessionId) {
    const mapped = activeRootHandles.get(sessionId);
    if (mapped) {
      const mappedBinding = registry.getBindingForSession(mapped);
      if (mappedBinding && mappedBinding.releasedAt === null) return mapped;
      activeRootHandles.delete(sessionId); // stale mapping, re-derive below
    }
    const direct = registry.getBindingForSession(sessionId);
    if (direct && direct.releasedAt === null) {
      activeRootHandles.set(sessionId, sessionId);
      return sessionId;
    }
    return null;
  }

  function resolveActiveRootBinding(sessionId) {
    const handle = currentRootHandle(sessionId);
    if (!handle) return null;
    const binding = registry.getBindingForSession(handle);
    if (!binding || binding.releasedAt !== null) return null;
    return { handle, binding };
  }

  function clearRootHandle(handle) {
    rootHandleByDerived.delete(handle);
    for (const [raw, mapped] of [...activeRootHandles]) {
      if (mapped === handle) activeRootHandles.delete(raw);
    }
  }

  // Task 7B-R2-R1: consumes BOTH identity maps of a queued derived root turn
  // — the forward raw -> derived entry and its reverse derived -> raw entry.
  // Call ONLY after the queued item was actually closed (retainQueuedTerminal
  // returned ok): a failed retain (RUN_ID_UNVERIFIED, RUN_ID_MISMATCH,
  // SESSION_NOT_QUEUED, ...) must leave every mapping untouched.
  function clearQueuedRootHandle(rawSessionId) {
    const derived = queuedRootHandles.get(rawSessionId);
    if (derived === undefined) return;
    rootHandleByDerived.delete(derived);
    queuedRootHandles.delete(rawSessionId);
  }

  // Root sessions default to the orchestrator seat (SPEC-04). Turn 1 binds
  // the raw id directly; a released root session re-binds under a derived
  // turn-scoped handle and the raw->handle map is updated. Raw ids stay
  // inside the main process and never reach snapshots.
  function ensureRootBinding(rawSessionId) {
    const existingHandle = currentRootHandle(rawSessionId);
    if (existingHandle) return registry.getBindingForSession(existingHandle);
    // Task 7B-R1: a queued turn handle is REUSED for every running fact of
    // the same turn — one queue item per turn, no S#tN inflation.
    const queuedHandle = queuedRootHandles.get(rawSessionId);
    if (queuedHandle) return null;
    let bound = registry.bindRootSession({ sessionId: rawSessionId, nowMs: logicalMs });
    let usedId = rawSessionId;
    if (!bound.ok && bound.code === 'SESSION_BINDING_RELEASED') {
      const rec = employees.get('orchestrator');
      rec.turnCounter += 1;
      usedId = `${rawSessionId}#t${rec.turnCounter}`;
      bound = registry.bindRootSession({ sessionId: usedId, nowMs: logicalMs });
    }
    if (!bound.ok) {
      noteDiagnostic('BINDING_FAILED');
      // Task 7B-R2-R1: binding failure consumes both identity maps of any
      // queued derived turn for this raw session.
      clearQueuedRootHandle(rawSessionId);
      return null;
    }
    if (bound.queued || !bound.binding) {
      // Seat busy: the queue-controller owns the FIFO item and will dispatch
      // it through the release effects; no binding exists yet.
      noteLog('queued', 'orchestrator');
      if (usedId !== rawSessionId) {
        queuedRootHandles.set(rawSessionId, usedId);
        rootHandleByDerived.set(usedId, rawSessionId);
      }
      return null;
    }
    activeRootHandles.set(rawSessionId, usedId);
    queuedRootHandles.delete(rawSessionId);
    rootHandleByDerived.delete(usedId);
    onBindingCreated(bound.binding, bound.effects);
    return bound.binding;
  }

  // Applies the queue's verbatim dispatch transaction (dispatch-started +
  // binding-pending) for a freshly created binding: reducer pending state,
  // walk-to-seat transition, scheduler interrupt of any local activity.
  function onBindingCreated(binding, effects) {
    const rec = employees.get(binding.employeeId);
    if (!rec) return;
    // M4.1g: a trusted task also ends a nap — the log keeps the readable fact.
    const wasNapping = rec.state.activity === 'sleeping';
    reduce(rec, { type: 'control/dispatch' });
    scheduler.interruptForTask({ employeeId: rec.employeeId, reason: 'runtime-task', nowMs: logicalMs });
    if (wasNapping) noteLog('sleep-ended', rec.employeeId, { reason: 'task' });
    rec.marker = null;
    beginTaskTransition(rec);
    scheduler.markTaskStarted({ employeeId: rec.employeeId, nowMs: logicalMs });
    noteLog('task-started', rec.employeeId);
    for (const effect of effects || []) {
      if (effect.type === 'dispatch-started') queue.markRunning({ queueItemId: effect.queueItemId, nowMs: logicalMs });
    }
  }

  // Task 4 golden-workstation task start:
  // - preTaskNodeId (non-desk graph node only) and preTaskPosition are
  //   captured EXACTLY once — a replacement task keeps the original origin
  // - the workstation reservation is held from here until stand completes at
  //   the approach AND the leave route is acquired
  // - the graph route ends at the workstation APPROACH node; approach->seat
  //   is a separate anchor interpolation segment (never collapsed)
  // - repeated running facts on an active task-start never restart the route
  function beginTaskTransition(rec) {
    const seatNode = nodesById.get(rec.seatNodeId);
    const workstationTemplate = seatNode ? layout.workstation(rec.seatNodeId) : null;
    if (!seatNode || !workstationTemplate) {
      noteDiagnostic('WORKSTATION_MISSING');
      return;
    }
    const resumingTask = !!(rec.transition && rec.transition.kind === 'task-start');
    if (!resumingTask) {
      if (!rec.preTaskPosition) rec.preTaskPosition = { x: rec.position.x, y: rec.position.y };
      if (rec.preTaskNodeId === null) {
        const originNode = nodesById.get(rec.currentNodeId);
        rec.preTaskNodeId = originNode && !originNode.tags.includes('desk') ? originNode.id : null;
      }
      if (!rec.workstation) {
        rec.workstation = {
          deskId: rec.seatNodeId,
          approachNodeId: workstationTemplate.approach.nodeId,
          seatAnchor: { x: workstationTemplate.seat.position.x, y: workstationTemplate.seat.position.y },
          approachAnchor: { x: workstationTemplate.approach.position.x, y: workstationTemplate.approach.position.y },
        };
        const acquired = movement.acquireReservation({
          employeeId: rec.employeeId,
          purpose: 'workstation',
          nodeId: rec.workstation.approachNodeId,
          segments: [],
          reservations: scheduler.reservations(),
          nowMs: logicalMs,
          ttlMs: 120000,
          safeRadius: 0.03,
        });
        rec.workstationReservation = acquired.ok ? acquired.reservation : null;
        if (!acquired.ok) noteDiagnostic('WORKSTATION_RESERVATION_CONFLICT');
      }
    }
    rec.reachedSeat = false;
    rec.leaveTargetNodeId = null;
    // a replacement task cancels any in-flight anchor segment from the
    // previous task (stand/approach interpolation): otherwise the stale
    // segment completion would mis-advance the NEW transition
    rec.segment = null;
    const started = transitionCtl.beginTaskStart({
      fromActivity: rec.state.activity,
      task: {},
      target: { nodeId: rec.workstation.approachNodeId },
      nowMs: logicalMs,
      previous: resumingTask ? rec.transition : null,
    });
    rec.transition = started.transition;
    // stop/turn are zero-duration phases: advance into move immediately
    for (let i = 0; i < 2; i += 1) {
      const next = transitionCtl.advance({ transition: rec.transition, event: { type: 'phase-complete' }, nowMs: logicalMs }).transition;
      if (!next || next.kind !== 'task-start') break;
      rec.transition = next;
    }
    if (!planTaskRoute(rec, logicalMs)) {
      // transient block: keep the task-start transition and workstation
      // reservation alive and retry the route plan from the tick loop
      rec.routeRetryAt = logicalMs + ROUTE_RETRY_DELAY_MS;
      rec.routeRetryDeadline = logicalMs + ROUTE_RETRY_BUDGET_MS;
    }
  }

  // Plans the task route to the workstation approach. Returns false when the
  // route is currently unreachable (a transient reservation block).
  function planTaskRoute(rec, at) {
    const fromNodeId = nearestNodeId(rec.position);
    const route = movement.findRoute({
      fromNodeId,
      toNodeId: rec.workstation.approachNodeId,
      behavior: 'task',
      reservations: scheduler.reservations(),
      nowMs: at,
      employeeId: rec.employeeId,
    });
    if (!Array.isArray(route)) return false;
    planRoute(rec, route, rec.workstation.approachNodeId, at);
    return true;
  }

  // Full task teardown: reservation, workstation record, anchor segment and
  // preTask origin. Used by cancellation/interruption and by degraded ends.
  function finishTaskCleanup(rec, diagnostic) {
    if (diagnostic) noteDiagnostic(diagnostic);
    releaseWorkstationReservation(rec);
    rec.workstation = null;
    rec.segment = null;
    rec.leaveTargetNodeId = null;
    rec.preTaskNodeId = null;
    rec.preTaskPosition = null;
    rec.reachedSeat = false;
    rec.routeRetryAt = null;
    rec.routeRetryDeadline = null;
    rec.transition = null;
  }

  function applyFact(fact, envelope, rawEvent) {
    const rawSessionId = rawEvent && rawEvent.sessionId ? rawEvent.sessionId : null;
    switch (fact.type) {
      case 'runtime/fact': {
        if (!rawSessionId) return;
        if (fact.fact === 'running' || fact.fact === 'attention') {
          const binding = ensureRootBinding(rawSessionId);
          if (!binding) return;
          const rec = employees.get(binding.employeeId);
          if (!rec.transition || rec.transition.kind !== 'task-start') beginTaskTransition(rec);
          reduce(rec, { type: 'runtime/fact', fact: fact.fact, reason: fact.reason || null });
          const active = queue.activeItem(rec.employeeId);
          if (active) queue.markRunning({ queueItemId: active.queueItemId, nowMs: logicalMs });
          scheduler.markTaskStarted({ employeeId: rec.employeeId, nowMs: logicalMs });
        } else if (fact.fact === 'completed' || fact.fact === 'failed') {
          const resolved = resolveActiveRootBinding(rawSessionId);
          if (!resolved) {
            // Task 7B: the session may still be WAITING in the seat FIFO —
            // retain the terminal outcome so the item can never dispatch into
            // a phantom run after the real Harness run already ended.
            const retained = registry.retainQueuedTerminal({
              sessionId: queuedRootHandles.get(rawSessionId) || rawSessionId,
              evidenceType: 'turn-end',
              outcome: fact.fact,
              nowMs: logicalMs,
            });
            if (retained.ok) {
              // Task 7B-R2-R1: clear the forward map AND its reverse entry.
              clearQueuedRootHandle(rawSessionId);
              noteLog('queued-terminal-closed');
            }
            return;
          }
          beginResultPresentation(employees.get(resolved.binding.employeeId), {
            outcome: fact.fact,
            evidence: `turn/end:${fact.reason || fact.fact}`,
            sessionId: resolved.handle,
            release: (at) => registry.releaseBinding({
              sessionId: resolved.handle, nowMs: at, evidence: `turn/end:${fact.reason || fact.fact}`, outcome: fact.fact,
            }),
          });
        }
        break;
      }
      case 'runtime/cancelled': {
        if (!rawSessionId) return;
        releaseTerminalNow(rawSessionId, `turn/end:${fact.evidence || 'cancelled'}`, 'cancelled');
        break;
      }
      case 'runtime/tool': {
        const resolved = resolveActiveRootBinding(rawSessionId);
        if (!resolved) return;
        const rec = employees.get(resolved.binding.employeeId);
        rec.toolKind = fact.tool || null;
        reduce(rec, { type: 'runtime/tool', tool: fact.tool || null });
        break;
      }
      case 'runtime/subagent-start': {
        if (!rawSessionId) return;
        const rawChildId = rawEvent && rawEvent.data && typeof rawEvent.data.id === 'string' ? rawEvent.data.id : null;
        if (!rawChildId) return;
        // fact.runId is the Task-6 proxy: forwarded verbatim. Only when the
        // adapter failed to proxy (null) do we derive from the raw value.
        const runProxy = fact.runId || deriveRunProxy(rawEvent.data && rawEvent.data.runId);
        const parentBinding = ensureRootBinding(rawSessionId);
        registry.registerChildSession({
          parentSessionId: rawSessionId,
          childSessionId: rawChildId,
          runId: runProxy,
          nowMs: logicalMs,
        });
        const enqueued = registry.registerUnclassifiedSubagent({
          sessionId: rawChildId,
          runId: runProxy,
          nowMs: logicalMs,
        });
        if (runProxy) runsByProxy.set(runProxy, { childSessionId: rawChildId, parentSessionId: rawSessionId });
        const collaborator = employees.get(profiles.COLLABORATOR_ID);
        reduce(collaborator, { type: 'queue/enqueue' });
        noteLog('queued', profiles.COLLABORATOR_ID);
        if (enqueued.ok) {
          const assigned = registry.assignNextCollaboratorItem({ nowMs: logicalMs });
          if (assigned.ok && assigned.binding) {
            onBindingCreated(assigned.binding, assigned.effects);
            pushSnapshot();
          }
        }
        void parentBinding;
        break;
      }
      case 'runtime/subagent-end': {
        const rawChildId = rawEvent && rawEvent.data && typeof rawEvent.data.id === 'string' ? rawEvent.data.id : null;
        if (!rawChildId) return;
        const runProxy = fact.runId || deriveRunProxy(rawEvent.data && rawEvent.data.runId);
        if (fact.terminal === true) {
          const outcome = fact.outcome === 'failed' ? 'failed' : fact.outcome === 'cancelled' ? 'cancelled' : 'completed';
          if (outcome === 'cancelled') {
            const childBinding = registry.getBindingForSession(rawChildId);
            if (!childBinding || childBinding.releasedAt !== null) {
              // Task 7B: the subagent is still QUEUED — cancel the waiting
              // item immediately (never dispatches, never takes the seat).
              const retained = registry.retainQueuedTerminal({
                sessionId: rawChildId,
                evidenceType: 'subagent-end',
                outcome: 'cancelled',
                runId: runProxy,
                nowMs: logicalMs,
              });
              if (retained.ok) noteLog('queued-terminal-closed');
              else if (retained.code && retained.code.startsWith('RUN_ID_')) noteDiagnostic(retained.code);
              break;
            }
            releaseTerminalNow(rawChildId, `subagent/end:${fact.stopReason || 'cancelled'}`, 'cancelled');
          } else {
            const binding = registry.getBindingForSession(rawChildId);
            if (!binding || binding.releasedAt !== null) {
              // Task 7B: the subagent is still QUEUED — retain its terminal
              // outcome (runId verified fail closed by the registry).
              const retained = registry.retainQueuedTerminal({
                sessionId: rawChildId,
                evidenceType: 'subagent-end',
                outcome,
                runId: runProxy,
                nowMs: logicalMs,
              });
              if (retained.ok) noteLog('queued-terminal-closed');
              else if (retained.code && retained.code.startsWith('RUN_ID_')) noteDiagnostic(retained.code);
              break;
            }
            beginResultPresentation(employees.get(binding.employeeId), {
              outcome,
              evidence: `subagent/end:${fact.stopReason || outcome}`,
              sessionId: rawChildId,
              release: (at) => registry.subagentEnd({
                sessionId: rawChildId,
                runId: runProxy,
                stopReason: fact.stopReason,
                terminalEvidence: true,
                nowMs: at,
              }),
            });
          }
        }
        break;
      }
      case 'sync/status':
      case 'control/cancel-ack':
      case 'send-control':
      default:
        // sync is aggregated in recomputeGlobalSync; ack facts need no action.
        break;
    }
  }

  function beginResultPresentation(rec, { outcome, evidence, sessionId, release }) {
    if (!rec || rec.pendingTerminal) return;
    rec.pendingTerminal = { outcome, evidence, release, sessionId: sessionId || null };
    const ended = transitionCtl.beginTaskEnd({ outcome, task: {}, nowMs: logicalMs, previous: rec.transition });
    rec.transition = ended.transition;
    rec.resultUntilMs = logicalMs + settings.resultPresentationMs;
    rec.lastResult = { outcome, atMs: logicalMs };
    reduce(rec, { type: 'runtime/fact', fact: outcome, reason: outcome });
    noteLog(outcome === 'completed' ? 'result-completed' : 'result-failed', rec.employeeId);
    pushSnapshot();
  }

  // Cancelled terminal evidence: no result presentation, immediate release.
  function releaseTerminalNow(sessionId, evidence, outcome) {
    const queuedHandle = queuedRootHandles.get(sessionId);
    const handle = currentRootHandle(sessionId) || queuedHandle || sessionId;
    const binding = registry.getBindingForSession(handle);
    if (!binding || binding.releasedAt !== null) {
      // Task 7B: the session may still be WAITING in the seat FIFO — remove
      // it from the queue immediately so it can never dispatch or take the
      // seat for a run that already ended.
      const retained = registry.retainQueuedTerminal({
        sessionId: handle,
        evidenceType: evidence && evidence.startsWith('subagent/') ? 'subagent-end' : 'session-end',
        outcome,
        nowMs: logicalMs,
      });
      if (retained.ok) {
        // Task 7B-R2-R1: clear the forward map AND its reverse entry.
        clearQueuedRootHandle(sessionId);
        noteLog('queued-terminal-closed');
      }
      return;
    }
    const rec = employees.get(binding.employeeId);
    const result = registry.releaseBinding({ sessionId: handle, nowMs: logicalMs, evidence, outcome });
    if (!result.ok) {
      noteDiagnostic('RELEASE_FAILED');
      return;
    }
    clearRootHandle(handle);
    if (rec) {
      finishTaskCleanup(rec);
      rec.pendingTerminal = null;
      rec.resultUntilMs = null;
      rec.lastResult = { outcome, atMs: logicalMs };
      if (rec.state.control === 'cancellationPending' || rec.state.control === 'preemptPending') {
        reduce(rec, { type: 'runtime/cancelled', evidence });
      }
      if (rec.state.binding === 'releasing') reduce(rec, { type: 'binding/released' });
      reduce(rec, { type: 'runtime/fact', fact: 'idle' });
      scheduler.markTaskReleased({ employeeId: rec.employeeId, nowMs: logicalMs });
      releasePathReservation(rec);
      noteLog('result-cancelled', rec.employeeId);
    }
    applyRegistryEffects(result.effects);
    pushSnapshot();
  }

  // Applies the queue's verbatim post-release effects: the atomic FIFO switch
  // (dispatch-started -> binding already created by the registry) or the
  // resume of local behavior.
  function applyRegistryEffects(effects) {
    for (const effect of effects || []) {
      if (effect.type === 'dispatch-started') {
        // Task 7B-R2: a queued DERIVED root turn (S#tN) dispatches — promote
        // its controlled mapping so raw-session terminals resolve the active
        // handle. Dispatch failure clears both mappings (no dangling state).
        const derived = effect.sessionId;
        const rawOfDerived = rootHandleByDerived.get(derived);
        if (rawOfDerived !== undefined) {
          rootHandleByDerived.delete(derived);
          queuedRootHandles.delete(rawOfDerived);
        }
        const binding = registry.getBindingForSession(derived);
        if (binding && binding.releasedAt === null) {
          if (rawOfDerived !== undefined) activeRootHandles.set(rawOfDerived, derived);
          const rec = employees.get(binding.employeeId);
          if (rec && rec.state.queue === 'queued') reduce(rec, { type: 'queue/dequeue' });
          onBindingCreated(binding, [effect]);
        }
      } else if (effect.type === 'resume-local-behavior') {
        // handled by the caller via scheduler.markTaskReleased; the decide
        // loop picks the next local activity on the following tick.
      }
    }
  }

  function commitReleasedTerminal(rec, at) {
    const pending = rec.pendingTerminal;
    rec.pendingTerminal = null;
    rec.resultUntilMs = null;
    if (!pending) return;
    const result = pending.release(at);
    if (!result.ok) {
      noteDiagnostic('RELEASE_FAILED');
      finishTaskCleanup(rec);
      scheduler.markTaskReleased({ employeeId: rec.employeeId, nowMs: at });
      return;
    }
    if (pending.sessionId) clearRootHandle(pending.sessionId);
    if (rec.state.binding === 'releasing') reduce(rec, { type: 'binding/released' });
    const started = (result.effects || []).find((effect) => effect.type === 'dispatch-started');
    if (!started) reduce(rec, { type: 'transition/complete' });
    // result -> stand (the reversed seat-to-approach interpolation). An end
    // that arrived before the employee ever reached the seat degrades into a
    // direct cleanup instead of a phantom stand.
    if (rec.transition && rec.transition.kind === 'task-end' && rec.transition.phase === 'result'
        && rec.workstation && rec.reachedSeat) {
      rec.transition = transitionCtl.advance({ transition: rec.transition, event: { type: 'phase-complete' }, nowMs: at }).transition;
      rec.segment = {
        kind: 'seat-to-approach',
        from: { x: rec.workstation.seatAnchor.x, y: rec.workstation.seatAnchor.y },
        to: { x: rec.workstation.approachAnchor.x, y: rec.workstation.approachAnchor.y },
        startedAtMs: at,
        durationMs: anchorSegmentDurationMs(),
      };
    } else if (!started) {
      finishTaskCleanup(rec);
    }
    scheduler.markTaskReleased({ employeeId: rec.employeeId, nowMs: at });
    applyRegistryEffects(result.effects);
    pushSnapshot();
  }

  // ---- per-tick pipeline -------------------------------------------------------

  function freeEmployees() {
    const free = [];
    for (const rec of employees.values()) {
      const bindingActive = hasActiveBinding(rec.employeeId);
      if (!bindingActive && !rec.transition && !rec.pendingTerminal) free.push(rec);
    }
    return free;
  }

  function hasActiveBinding(employeeId) {
    const snapshot = registry.snapshot();
    return snapshot.bindings.some(
      (binding) => binding.employeeId === employeeId && binding.releasedAt === null
    );
  }

  function chatCandidates() {
    return freeEmployees().map((rec) => ({ employeeId: rec.employeeId, nodeId: rec.currentNodeId }));
  }

  // M4.1g: the OTHER employees' live path/workstation reservations, for the
  // scheduler's target selection. Without them the scheduler's BFS planned
  // straight through a task walker's leg, and the M4.1a priority release
  // below turned into a ping-pong: the task walker released the roamer's leg,
  // the roamer re-acquired the same leg on its next tick, forever.
  function externalReservationsFor(excludeId) {
    const out = [];
    for (const other of employees.values()) {
      if (other.employeeId === excludeId) continue;
      if (other.workstationReservation) out.push(other.workstationReservation);
      if (other.pathReservation) out.push(other.pathReservation);
    }
    return out;
  }

  // M4.1g: a nap can also end outside the scheduler's wake (a corridor yield or
  // a route re-plan evicts the napper). The log keeps the readable fact so the
  // "开始小憩" lines always pair up with a "醒来" fact.
  function noteNapPreempted(employeeId, reason) {
    const rec = employees.get(employeeId);
    if (rec && rec.state.activity === 'sleeping') noteLog('sleep-ended', employeeId, { reason });
  }

  // M4.1e: current positions of everyone else, for the scheduler's personal-
  // space preference (parked bodies must not be stacked on top of each other).
  function peerPositions(excludeId) {
    const peers = [];
    for (const rec of employees.values()) {
      if (rec.employeeId === excludeId) continue;
      peers.push({
        employeeId: rec.employeeId,
        position: { x: rec.position.x, y: rec.position.y },
        // A walker's DESTINATION is where its body will be in a moment: two
        // peers converging on neighbouring nodes must see each other's target
        // (the current position alone let roam-3/roam-5 fill up in the same
        // breath — they are only 34px apart).
        currentNodeId: rec.currentNodeId || null,
        targetNodeId: rec.targetNodeId || null,
        activity: activityFor(rec),
      });
    }
    return peers;
  }

  function applyDecision(rec, decision) {
    if (!decision || !decision.ok) return;
    if (decision.activity === 'continue') return;
    // The scheduler decision is the ONLY local-activity authority; the reducer
    // enforces the local vocabulary (never running/attention/completed).
    reduce(rec, { type: 'local/activity', activity: decision.activity, reason: decision.reason || null });
    if (decision.activity === 'chatting' && decision.chat) {
      // Both pair members walk to their reserved seats; the marker is set on
      // both. The scheduler owns the pair state and reservations.
      const targets = decision.chat.targets || {};
      const mine = targets[rec.employeeId];
      if (mine && Array.isArray(mine.route)) planRoute(rec, mine.route, mine.nodeId, logicalMs);
      const partnerRec = employees.get(decision.chat.partnerId);
      const partnerTarget = targets[decision.chat.partnerId];
      if (partnerRec && partnerTarget && Array.isArray(partnerTarget.route)) {
        planRoute(partnerRec, partnerTarget.route, partnerTarget.nodeId, logicalMs);
        partnerRec.facing = (decision.chat.facing || {})[partnerRec.employeeId] || partnerRec.facing;
      }
      rec.facing = (decision.chat.facing || {})[rec.employeeId] || rec.facing;
      const pairNow = scheduler.activeChatPair();
      if (pairNow && pairNow.startedAt === decision.chat.startedAt) noteLog('chat-started', rec.employeeId);
      // M4.1g: the pair's reducer state must cover BOTH members. The partner's
      // own decision returns 'continue' (pair member) and never re-reduces, so
      // without this the partner kept a stale activity (roaming/resting) while
      // walking to the water-cooler seats — the details view, the animation
      // state and every "is this employee chatting?" check disagreed with the
      // marker (and the partner lost the chat-walk protections keyed on it).
      if (partnerRec) {
        reduce(partnerRec, { type: 'local/activity', activity: 'chatting', reason: decision.reason || null });
      }
      return;
    }
    if (decision.target && Array.isArray(decision.target.route)) {
      planRoute(rec, decision.target.route, decision.target.nodeId, logicalMs);
    }
    // M4.1g: one "开始小憩" line per NAP CYCLE. The scheduler marks the single
    // decision that enters the cycle (an unfinished nap returns 'continue' and
    // never re-enters), so the dwell re-decisions that used to re-log every
    // second are structurally gone — no time-window dedup needed.
    if (decision.activity === 'sleeping' && decision.sleepEvent && decision.sleepEvent.phase === 'started') {
      noteLog('sleep-started', rec.employeeId);
    }
    // M4.1g: the wake is the readable counterpart — how long the nap lasted.
    if (decision.wokeFromSleep) {
      noteLog('sleep-ended', rec.employeeId, { sleptMs: decision.wokeFromSleep.sleptMs });
    }
  }

  function arriveAtNode(rec, nodeId, at) {
    const node = nodesById.get(nodeId);
    if (node) rec.position = { x: node.position.x, y: node.position.y };
    rec.currentNodeId = nodeId;
    rec.targetNodeId = null;
    rec.route = null;
    // SPEC-04: arriving at the target is a decision point — the scheduler
    // restarts the dwell there on the next tick.
    rec.arrivedNodeId = nodeId;

    const workstation = rec.workstation;
    if (workstation && rec.transition && rec.transition.kind === 'task-start'
        && rec.transition.phase === 'move' && nodeId === workstation.approachNodeId) {
      // Task arrival at the workstation APPROACH: the graph route ends here
      // and its path reservation releases (movement-controller governance),
      // but the workstation reservation is NOT the generic arrival's to
      // release. arrive->sit opens the anchor interpolation segment; work is
      // never collapsed into this moment.
      releasePathReservation(rec);
      reduce(rec, { type: 'movement/status', movement: 'stationary' });
      const arrived = transitionCtl.advance({ transition: rec.transition, event: { type: 'arrived' }, nowMs: at }).transition;
      rec.transition = transitionCtl.advance({ transition: arrived, event: { type: 'phase-complete' }, nowMs: at }).transition;
      rec.segment = {
        kind: 'approach-to-seat',
        from: { x: workstation.approachAnchor.x, y: workstation.approachAnchor.y },
        to: { x: workstation.seatAnchor.x, y: workstation.seatAnchor.y },
        startedAtMs: at,
        durationMs: anchorSegmentDurationMs(),
      };
      noteLog('task-arrived', rec.employeeId);
      return;
    }

    releasePathReservation(rec);
    reduce(rec, { type: 'movement/status', movement: 'stationary' });

    if (rec.transition && rec.transition.kind === 'task-end' && rec.transition.phase === 'leave'
        && nodeId === rec.leaveTargetNodeId) {
      // leave complete: the transition ends and the preTask origin clears NOW
      transitionCtl.advance({ transition: rec.transition, event: { type: 'phase-complete' }, nowMs: at });
      rec.transition = null;
      rec.leaveTargetNodeId = null;
      rec.preTaskNodeId = null;
      rec.preTaskPosition = null;
      rec.reachedSeat = false;
      noteLog('task-left', rec.employeeId);
    }
  }

  // Anchor interpolation segments complete here: approach-to-seat opens the
  // work phase; seat-to-approach (stand) acquires the leave route and only
  // THEN releases the workstation reservation.
  function completeSegment(rec, at) {
    const segment = rec.segment;
    rec.segment = null;
    rec.position = { x: segment.to.x, y: segment.to.y };
    reduce(rec, { type: 'movement/status', movement: 'stationary' });
    if (segment.kind === 'approach-to-seat') {
      rec.reachedSeat = true;
      rec.transition = transitionCtl.advance({ transition: rec.transition, event: { type: 'phase-complete' }, nowMs: at }).transition;
      return;
    }
    // stand complete: try the original preTaskNodeId first, then the nearest
    // reachable roaming node (distance, then stable node id)
    const candidates = [];
    if (rec.preTaskNodeId && nodesById.has(rec.preTaskNodeId)
        && rec.workstation && rec.preTaskNodeId !== rec.workstation.approachNodeId) {
      candidates.push(rec.preTaskNodeId);
    }
    if (rec.workstation) candidates.push(nearestReachableRoamNodeId(rec, at));
    let route = null;
    let target = null;
    for (const candidate of candidates) {
      if (candidate == null || candidate === target) continue;
      const found = movement.findRoute({
        fromNodeId: rec.workstation.approachNodeId,
        toNodeId: candidate,
        behavior: 'task',
        reservations: scheduler.reservations(),
        nowMs: at,
        employeeId: rec.employeeId,
      });
      if (Array.isArray(found)) {
        route = found;
        target = candidate;
        break;
      }
    }
    rec.transition = transitionCtl.advance({ transition: rec.transition, event: { type: 'phase-complete' }, nowMs: at }).transition;
    if (Array.isArray(route) && rec.workstation) {
      rec.leaveTargetNodeId = target;
      releaseWorkstationReservation(rec);
      rec.workstation = null;
      planRoute(rec, route, target, at);
    } else {
      finishTaskCleanup(rec, 'LEAVE_ROUTE_UNAVAILABLE');
    }
  }

  // M4.1e: one ladder for every way a walker can be stopped — leg acquisition
  // failure and step refusal. Report the wait truthfully, keep the current
  // parking claim, then:
  //   * ask a STANDING, non-task peer to yield after the patience window
  //     (a task-bound peer keeps priority, a moving peer clears by itself —
  //     the latter also stops two walkers from trading yield requests);
  //   * give up a stale route of our own so the next scheduler decision
  //     re-plans against the CURRENT reservations (findRoute's BFS then goes
  //     around the obstacle; task walkers are exempt — their route is
  //     protected by the yield above).
  function handleBlocked(rec, at, blockedByOwner) {
    if (blockedByOwner) rec.debugStepBlockedBy = blockedByOwner;
    else rec.debugStepBlockedBy = rec.debugStepBlockedBy || 'unknown';
    if (rec.state.movement === 'moving') reduce(rec, { type: 'movement/status', movement: 'stationary' });
    ensureParkClaim(rec, at);
    if (rec.blockedSinceMs === null) rec.blockedSinceMs = at;
    const patienceMs = 700;
    const blockerRec = blockedByOwner ? employees.get(blockedByOwner) : null;
    if (blockerRec && blockerRec !== rec
        && !isTaskBound(blockerRec)
        && blockerRec.state.movement === 'stationary'
        && at - rec.blockedSinceMs >= patienceMs && at - (rec.yieldAskedAt || 0) >= 3000) {
      rec.yieldAskedAt = at;
      noteNapPreempted(blockerRec.employeeId, isTaskBound(rec) ? 'task-priority' : 'corridor-congestion');
      try {
        scheduler.preemptLocal({ employeeId: blockerRec.employeeId, reason: isTaskBound(rec) ? 'task-priority' : 'corridor-congestion', nowMs: at, nodeId: blockerRec.currentNodeId });
        // apply the yield on the module side: the peer stops where it stands;
        // its next scheduler decision walks it away from here.
        blockerRec.route = null;
        blockerRec.routeIndex = 0;
        blockerRec.targetNodeId = null;
        blockerRec.blockedSinceMs = null;
        releasePathReservation(blockerRec);
        blockerRec.marker = null;
      } catch { /* scheduler stays optional */ }
    }
    const replanMs = 1000;
    if (!isTaskBound(rec) && at - rec.blockedSinceMs >= patienceMs
        && at - (rec.replanAskedAt || 0) >= replanMs) {
      rec.replanAskedAt = at;
      if (rec.state.activity === 'sleeping' && rec.route) {
        // M4.1g: a resident walking to its own desk to nap waits (bounded) for
        // the corridor to clear instead of abandoning the nap on the first
        // block — a 1-second "nap" read as the office stuttering.
        if (rec.napWalkWaitSinceMs === null) rec.napWalkWaitSinceMs = at;
        if (at - rec.napWalkWaitSinceMs <= NAP_WALK_WAIT_MAX_MS) return;
        rec.napWalkWaitSinceMs = null;
      }
      noteNapPreempted(rec.employeeId, 'route-replan');
      rec.route = null;
      rec.routeIndex = 0;
      rec.targetNodeId = null;
      releasePathReservation(rec);
      try {
        scheduler.preemptLocal({ employeeId: rec.employeeId, reason: 'route-replan', nowMs: at, nodeId: rec.currentNodeId });
      } catch { /* scheduler stays optional */ }
    }
  }

  function stepMovement(rec, at) {
    if (!rec.route || rec.route.length === 0) return;
    if (!rec.pathReservation && rec.route.length > 1) {
      tryAcquirePathReservation(rec, at);
      if (!rec.pathReservation) {
        // fail closed: stand still (truthfully) until the corridor frees up —
        // through the same patience ladder, so a leg that is blocked by a peer
        // PARKED on it cannot freeze the walker (M4.1e: this path used to have
        // no timer at all, and an enRoute walker never re-decided).
        handleBlocked(rec, at, rec.debugAcquireBlockedBy || null);
        return;
      }
    }
    const finalLeg = rec.routeIndex + 1 >= rec.route.length - 0;
    const nextNodeId = rec.route[Math.min(rec.routeIndex + 1, rec.route.length - 1)];
    const nextNode = nodesById.get(nextNodeId);
    if (!nextNode) {
      rec.route = null;
      return;
    }
    const step = movement.step({
      position: rec.position,
      target: { ...nextNode.position },
      targetNodeId: nextNodeId,
      reservations: allReservations(rec),
      occupants: [...employees.values()]
        .filter((other) => other !== rec)
        .map((other) => ({ id: other.employeeId, position: other.position, radius: 0.03 })),
      dtMs: TICK_MS,
      scene,
      employeeId: rec.employeeId,
      nowMs: at,
      route: rec.route,
    });
    if (step.reservationAction === 'wait') {
      rec.debugWaitDetail = JSON.stringify({ from: rec.position, to: nextNode.position, target: nextNodeId, mode: step.mode || null, kind: step.blockedBy && step.blockedBy.reservationId ? 'reservation' : 'occupant-or-node' });
      // M4.1a: drop the leg claim so the corridor stays available for movers
      // (a hold must never outlive actual progress — a node-blocked walker
      // keeping its leg would deadlock everyone behind it). M4.1e: the same
      // patience/re-plan ladder as the leg-acquisition path below.
      releasePathReservation(rec);
      handleBlocked(rec, at, step.blockedBy ? step.blockedBy.owner : null);
    } else if (step.moved) {
      rec.blockedSinceMs = null;
      rec.napWalkWaitSinceMs = null;
      releaseParkClaim(rec);
    }
    if (step.code !== 'OK' || (step.position && !step.arrived)) {
      rec.position = { x: step.position.x, y: step.position.y };
    }
    if (step.moved) {
      rec.facing = step.direction;
      if (rec.state.movement !== 'moving') reduce(rec, { type: 'movement/status', movement: 'moving' });
    }
    if (step.arrived) {
      if (!finalLeg && rec.routeIndex + 1 < rec.route.length - 0) {
        rec.routeIndex += 1;
        // M4.1a: intermediate arrival bookkeeping — a walker that parks here
        // (waiting for the next leg) is AT this node; both position and
        // identity must land on it (preTask origins / occupancy reads).
        const arrivedNode = nodesById.get(nextNodeId);
        if (arrivedNode) rec.position = { x: arrivedNode.position.x, y: arrivedNode.position.y };
        rec.currentNodeId = nextNodeId;
        releasePathReservation(rec);
        tryAcquirePathReservation(rec, at);
      } else {
        arriveAtNode(rec, nextNodeId, at);
      }
    }
  }

  function tickOnce() {
    return advanceOneTick();
  }

  function advanceOneTick() {
    if (isPaused()) return state(); // hidden/background: no time replay
    logicalMs += TICK_MS;
    const at = logicalMs;

    for (const adapter of adapters.values()) adapter.tick();

    // result presentation expiry -> FIFO release / local resume
    for (const rec of employees.values()) {
      if (rec.pendingTerminal && rec.resultUntilMs !== null && at >= rec.resultUntilMs) {
        commitReleasedTerminal(rec, at);
      }
    }

    // transient route-block retries (task-start move phase, no route yet)
    for (const rec of employees.values()) {
      if (rec.routeRetryAt === null || at < rec.routeRetryAt) continue;
      if (!rec.transition || rec.transition.kind !== 'task-start'
          || rec.transition.phase !== 'move') {
        rec.routeRetryAt = null;
        continue;
      }
      // M4.1g: the retry must also cover a STALE route. An employee whose local
      // walk was still in flight when the task arrived kept walking toward the
      // old target, and the old "a route exists" check abandoned the retry —
      // the task-start move phase then froze forever (observed: a subagent
      // task landing on a collaborator mid-roam never reached its seat). The
      // retry is abandoned only once the live route already targets the
      // workstation approach.
      if (rec.route && rec.workstation && rec.targetNodeId === rec.workstation.approachNodeId) {
        rec.routeRetryAt = null;
        continue;
      }
      if (at >= rec.routeRetryDeadline) {
        // permanent degradation: work in place, stay visible, stable diagnostic
        noteDiagnostic('ROUTE_UNAVAILABLE');
        finishTaskCleanup(rec);
        continue;
      }
      if (planTaskRoute(rec, at)) rec.routeRetryAt = null;
      else rec.routeRetryAt = at + ROUTE_RETRY_DELAY_MS;
    }

    // anchor interpolation segments (approach-to-seat / seat-to-approach):
    // single clock-driven phase advance — positions interpolate, never jump
    for (const rec of employees.values()) {
      if (!rec.segment) continue;
      const segment = rec.segment;
      const elapsed = at - segment.startedAtMs;
      const ratio = segment.durationMs > 0 ? Math.min(1, Math.max(0, elapsed / segment.durationMs)) : 1;
      rec.position = {
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      };
      rec.facing = facingFor(segment.from, segment.to);
      if (rec.state.movement !== 'moving') reduce(rec, { type: 'movement/status', movement: 'moving' });
      if (ratio >= 1) completeSegment(rec, at);
    }

    // local behavior decisions (scheduler owns dwell/cooldown/sleep gates)
    for (const rec of freeEmployees()) {
      if (settings.reducedMotion && rec.route) continue; // reduced motion resolves below
      // SPEC-04 decision points: the walk that finished last tick is reported
      // so the dwell restarts at the arrived target.
      const arrivedNodeId = rec.arrivedNodeId || null;
      rec.arrivedNodeId = null;
      const decision = scheduler.decide({
        employeeId: rec.employeeId,
        nowMs: at,
        fromNodeId: nearestNodeId(rec.position),
        bindingActive: false,
        sync: globalSync,
        chatCandidates: chatCandidates(),
        peers: peerPositions(rec.employeeId),
        externalReservations: externalReservationsFor(rec.employeeId),
        // M4.1b: a walker still on its route keeps its target until arrival
        enRoute: !!(rec.route && rec.route.length > 0),
        arrivedNodeId,
      });
      applyDecision(rec, decision);
    }

    // movement + reduced-motion snap
    for (const rec of employees.values()) {
      if (rec.workstationReservation && movement.isRenewalDue(rec.workstationReservation, at)) {
        rec.workstationReservation = movement.renewReservation({ reservation: rec.workstationReservation, nowMs: at });
      }
      if (settings.reducedMotion && rec.route) {
        const lastNode = nodesById.get(rec.route[rec.route.length - 1]);
        if (lastNode) arriveAtNode(rec, lastNode.id, at);
      } else if (!rec.segment) {
        stepMovement(rec, at);
      }
      // keep the chat pair marker fresh while seated
      const pair = scheduler.activeChatPair();
      rec.marker = pair && (pair.a === rec.employeeId || pair.b === rec.employeeId)
        ? 'chat-ellipsis'
        : rec.state.activity === 'sleeping' ? 'sleep-zzz' : null;
      // keep the reducer queue dim honest with the queue ledger
      const waiting = queue.waitingCount(rec.employeeId);
      if (waiting > 0 && rec.state.queue === 'empty') reduce(rec, { type: 'queue/enqueue' });
      if (waiting === 0 && rec.state.queue === 'queued') reduce(rec, { type: 'queue/dequeue' });
      rec.animationElapsedMs += TICK_MS;
    }

    // M4.1d — the dialogue middle end: while a chat pair is SEATED at its
    // chat seats, one member at a time shows a corpus line (engine pick,
    // per-pair cooldown enforced there). Bubbles expire by corpus bubbleMs,
    // and any bubble whose owner left the pair clears immediately.
    // A chat also ENDS after chatDurationMs — before M4.1d nothing ever called
    // endChat, so an undisturbed pair stood at the water cooler forever.
    let chatPair = scheduler.activeChatPair();
    if (chatPair && at - chatPair.startedAt >= settings.chatDurationMs) {
      try { scheduler.endChat({ nowMs: at }); } catch { /* scheduler stays optional */ }
      chatPair = scheduler.activeChatPair();
    }
    for (const rec of employees.values()) {
      const inPair = !!(chatPair && (chatPair.a === rec.employeeId || chatPair.b === rec.employeeId));
      if (rec.bubble && (!inPair || rec.bubble.untilMs <= at)) rec.bubble = null;
    }
    if (!chatPair) dialogueTurns.clear(); // no active pair: alternation state must not leak into the next conversation
    if (dialogueEngine && chatPair) {
      const a = employees.get(chatPair.a);
      const b = employees.get(chatPair.b);
      const seated = a && b
        && a.state.movement === 'stationary' && b.state.movement === 'stationary'
        && a.currentNodeId === chatPair.seatA && b.currentNodeId === chatPair.seatB;
      // Corpus limit: at most maxConcurrent bubbles office-wide. A pair never
      // stacks on itself (the engine's per-pair cooldown spans bubbleMs).
      const bubblesNow = [...employees.values()].filter((other) => other.bubble).length;
      // ONE bubble per pair at a time — speakers alternate, they never talk
      // over each other (maxConcurrent caps pairs office-wide, not lines).
      const pairShowing = (a.bubble ? 1 : 0) + (b.bubble ? 1 : 0);
      if (seated && pairShowing === 0 && bubblesNow < dialogueLimits.maxConcurrent) {
        // First line of a conversation goes through the per-pair cooldown gate
        // (the same pair stays silent for cooldownMs BETWEEN conversations);
        // only the ALTERNATING lines inside an ongoing conversation bypass it.
        const pairKey = [chatPair.a, chatPair.b].sort().join('|');
        const line = dialogueEngine.pick(chatPair.a, chatPair.b, at, undefined, { inConversation: dialogueTurns.has(pairKey) });
        if (line) {
          const turn = dialogueTurns.get(pairKey) || 0;
          dialogueTurns.set(pairKey, turn + 1);
          const speaker = (turn % 2 === 0 ? a : b);
          speaker.bubble = { text: line.text, topic: line.topic, untilMs: at + dialogueLimits.bubbleMs };
        }
      }
    }

    return state();
  }

  // ---- snapshot assembly (whitelist + redactor) --------------------------------

  function capabilitySnapshot() {
    const merged = { ...PROVEN_CAPABILITIES };
    for (const adapter of adapters.values()) {
      const capability = adapter.capability();
      for (const key of Object.keys(merged)) {
        merged[key] = merged[key] && capability.supports[key] === true;
      }
    }
    return merged;
  }

  // The snapshot is whitelist-built: no session identifiers, no prompt or
  // tool payload text, no token counts. As a second safety net every field
  // EXCEPT the small presentation allowlist below is passed through the
  // shared privacy redactor; the allowlisted fields are static profile/pack
  // data (display name, role label) and fixed presentation strings, never
  // runtime payload text.
  // `bubble` carries a STATIC corpus line (authored content, never runtime
  // payload), so it skips the value-shape redactor like the other allowlisted
  // presentation fields.
  const PRESENTATION_ALLOWLIST = Object.freeze(['displayName', 'role', 'taskLabel', 'marker', 'bubble']);

  // P1 pending items (spec §4). Every field is either app-controlled
  // vocabulary (kind / risk / toolName / summary / detailRef / employeeId), a
  // monotonic timestamp (createdAtMs), or the shell-owned answer-routing
  // handles (id / eventId / clientId) the panel needs in order to address the
  // shared answer channel. None of them are session identifiers, prompt text
  // or tool arguments — task text structurally never enters an item. The
  // projection mirrors the employees presentation allowlist above.
  const PENDING_ALLOWLIST = Object.freeze([
    'id', 'kind', 'employeeId', 'toolName', 'summary', 'detailRef', 'risk',
    'createdAtMs', 'eventId', 'clientId',
  ]);

  function safePendingItem(item) {
    const out = {};
    for (const field of PENDING_ALLOWLIST) {
      out[field] = item[field] === undefined ? null : item[field];
    }
    return out;
  }

  function redactSnapshot(snapshot) {
    const safeEmployees = snapshot.employees.map((employee) => {
      const presentation = {};
      for (const field of PRESENTATION_ALLOWLIST) {
        presentation[field] = employee[field] === undefined ? null : employee[field];
      }
      return { ...redactor.redactValue(employee), ...presentation };
    });
    // activityLog kinds and diagnostics codes are controlled enum vocabularies
    // (documented whitelist constants), so they skip the value-shape redactor
    // that would otherwise misread e.g. 'task-started' as a secret pattern.
    // The P1 usage block rides the redactor itself (extended coarse enums +
    // the calendar-day shape keep its numbers and markers); pending items are
    // projected through the allowlist above.
    const { employees, activityLog, diagnostics, usage, pending, ...rest } = snapshot;
    return {
      ...redactor.redactValue(rest),
      employees: safeEmployees,
      activityLog: snapshot.activityLog,
      diagnostics: snapshot.diagnostics,
      usage: usage ? redactor.redactValue(usage) : null,
      pending: Array.isArray(pending) ? pending.map(safePendingItem) : [],
    };
  }

  function state() {
    const pair = scheduler.activeChatPair();
    const snapshot = {
      schemaVersion: 1,
      simulatedAtMs: logicalMs,
      paused: isPaused(),
      sync: globalSync,
      scene: { referenceWidth: scene.width, referenceHeight: scene.height },
      employees: [],
      activityLog: activityLog.slice(-SNAPSHOT_LOG_TAIL),
      diagnostics: diagnostics.slice(-SNAPSHOT_DIAGNOSTICS_TAIL),
      capabilities: capabilitySnapshot(),
      // P1 data blocks (spec §4): usage is null until main.js injects the
      // shell's own caches; pending is the runtime waterfall list.
      usage: usageBlock,
      pending: pendingSnapshot(),
    };
    for (const rec of employees.values()) {
      const binding = registry.getBindingForSession(activeSessionIdFor(rec.employeeId));
      const waitingItems = queue.waitingItems(rec.employeeId);
      let animation = resolveAnimation({
        state: animationStateFor(rec),
        direction: rec.facing,
        elapsedMs: rec.animationElapsedMs,
        pack,
        userFrameDurationOverrideMs: settings.userFrameDurationOverrideMs,
      });
      // Task E5a-R2: the composed back-facing pose replaces the STEADY states
      // (idle / working). Transient result expressions (finished/error/warning)
      // and the directional walk cycles stay untouched. Task E6d: when the pack
      // carries the dedicated working-back loop, the WORKING state plays it
      // (frame indices advance with the animation clock through a full
      // resolveAnimation pass); the other steady states keep the static
      // side-back frame.
      const backState = animationStateFor(rec);
      // D1 (2026-09-18, user-reported): the back view belongs to being SEATED
      // at the workstation — the task phases sit/work — and to the walk-up
      // cycle; never to plain standing around. The old check asked only the
      // composed presentation, so any character that stopped walking fell back
      // to idle and kept showing her back. Result expressions
      // (finished/error/warning) stay untouched on purpose: they are transient
      // and meant to be seen.
      // M4.1g (2026-09-22, user-reported): sleeping was ALSO replaced here,
      // so the dedicated nap art (expressions/sleeping.png, a back-facing
      // sleeping pose) never played. It is removed from this set: the nap
      // state plays the pack's 'sleeping' resource (the art is already
      // back-facing, so the D1 intent is preserved).
      // "Seated at the workstation" means physically AT the own desk seat node
      // (that includes the startup pose and resting at the desk) or inside the
      // task's sit/work phases.
      const seatedAtWorkstation = (!!rec.transition && rec.transition.kind === 'task-start'
          && (rec.transition.phase === 'sit' || rec.transition.phase === 'work'))
        || (!!rec.seatNodeId && rec.currentNodeId === rec.seatNodeId);
      const backEligibleState = backState === 'working'
        || (backState === 'idle' && seatedAtWorkstation);
      if (
        rec.presentation && rec.presentation.facing === 'back' && composedBackResource
        && animation.resource && !animation.resource.startsWith('walk-')
        && backEligibleState
      ) {
        if (backState === 'working' && composedWorkingBackResource) {
          const seated = resolveAnimation({
            state: composedWorkingBackResource,
            direction: rec.facing,
            elapsedMs: rec.animationElapsedMs,
            pack,
            userFrameDurationOverrideMs: settings.userFrameDurationOverrideMs,
          });
          animation = seated.code === 'RESOLVED'
            ? seated
            : { ...animation, resource: composedBackResource, frameIndex: 0, frameCount: 1, loop: false };
        } else {
          animation = { ...animation, resource: composedBackResource, frameIndex: 0, frameCount: 1, loop: false };
        }
      }
      snapshot.employees.push({
        employeeId: rec.employeeId,
        displayName: rec.displayName,
        role: rec.role,
        presence: 'present',
        runtime: rec.state.runtime,
        activity: activityFor(rec),
        movement: rec.state.movement,
        control: rec.state.control,
        sync: globalSync,
        position: { x: rec.position.x, y: rec.position.y },
        facing: rec.facing,
        seatNodeId: rec.seatNodeId,
        binding: binding ? { source: binding.bindingSource, confidence: binding.confidence } : null,
        queueCount: waitingItems.length,
        waiting: waitingItems.map((item, index) => ({ position: index + 1, requestedAt: item.requestedAt })),
        taskLabel: binding && binding.releasedAt === null ? '执行任务中' : null,
        lastResult: rec.lastResult ? { ...rec.lastResult } : null,
        marker: pair && (pair.a === rec.employeeId || pair.b === rec.employeeId)
          ? 'chat-ellipsis'
          : rec.state.activity === 'sleeping' ? 'sleep-zzz' : null,
        toolKind: rec.toolKind,
        bubble: rec.bubble ? { text: rec.bubble.text, topic: rec.bubble.topic || null, untilMs: rec.bubble.untilMs } : null,
        animation: {
          resource: animation.resource,
          frameIndex: animation.frameIndex,
          fallbackReason: animation.fallbackReason,
        },
        presentation: rec.presentation ? { heightRatio: rec.presentation.heightRatio } : null,
        // Task 4 transition observability (coarse vocabulary only)
        transition: rec.transition
          ? { kind: rec.transition.kind, phase: rec.transition.phase, outcome: rec.transition.outcome || null }
          : null,
        segment: rec.segment ? { kind: rec.segment.kind } : null,
        preTaskNodeId: rec.preTaskNodeId,
        workstation: rec.workstation
          ? {
              deskId: rec.workstation.deskId,
              seatAnchor: { ...rec.workstation.seatAnchor },
              approachAnchor: { ...rec.workstation.approachAnchor },
            }
          : null,
      });
    }
    void pair;
    return redactSnapshot(snapshot);
  }

  // ---- P1 data pipeline: usage + pending blocks (spec §4) ---------------------

  /** Normalize (never trust) the main-process usage block into the exact
   * contract shape. A block missing the contract markers (billing day, token
   * or money buckets) is REJECTED rather than degraded to zeros — showing
   * ¥0/tokens 0 for data the shell never sent would be a lie. Unknown fields
   * are dropped and wrong-typed values neutralized. */
  function normalizeUsageBlock(raw) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey)) return null;
    if (!isPlainObject(raw.tokens) || !isPlainObject(raw.money)) return null;
    const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
    const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    const tokens = raw.tokens;
    const money = raw.money;
    const savings = isPlainObject(raw.savings) ? raw.savings : {};
    const budget = isPlainObject(raw.budget) ? raw.budget : {};
    return Object.freeze({
      dayKey: raw.dayKey,
      tokens: Object.freeze({
        input: nonNeg(tokens.input),
        output: nonNeg(tokens.output),
        cacheRead: nonNeg(tokens.cacheRead),
        total: nonNeg(tokens.total),
      }),
      money: Object.freeze({
        paid: nonNeg(money.paid),
        currency: typeof money.currency === 'string' && money.currency ? money.currency : 'CNY',
      }),
      savings: Object.freeze({
        cacheRead: nonNeg(savings.cacheRead),
        localModel: nonNeg(savings.localModel),
        localModelBasis: typeof savings.localModelBasis === 'string' && savings.localModelBasis
          ? savings.localModelBasis
          : 'cloud-equivalent',
      }),
      budget: Object.freeze({
        kind: oneOf(budget.kind, ['monthly', 'daily', 'none'], 'none'),
        limit: nonNeg(budget.limit),
        used: nonNeg(budget.used),
      }),
      pricingBasis: oneOf(raw.pricingBasis, ['api-key', 'subscription'], 'api-key'),
      staleAt: Number.isFinite(Number(raw.staleAt)) && Number(raw.staleAt) > 0 ? Number(raw.staleAt) : null,
    });
  }

  /** Inject the shell-assembled usage block (spec §4). main.js owns the data;
   * this module owns the snapshot shape. Returns {ok, code}. */
  function setUsageSnapshot(block) {
    const normalized = normalizeUsageBlock(block);
    if (!normalized) return Object.freeze({ ok: false, code: 'USAGE_INVALID' });
    usageBlock = normalized;
    return Object.freeze({ ok: true });
  }

  /** Employee currently bound to a raw session id (derived `raw#tN` handles
   * reduce to the raw id), or null when no live binding owns it. */
  function employeeIdForSession(rawSessionId) {
    if (typeof rawSessionId !== 'string' || rawSessionId === '') return null;
    const raw = rawSessionId.split('#')[0];
    const snapshot = registry.snapshot();
    for (const binding of (snapshot && snapshot.bindings) || []) {
      if (!binding || binding.releasedAt !== null) continue;
      if (typeof binding.sessionId !== 'string') continue;
      if (binding.sessionId.split('#')[0] === raw) return binding.employeeId;
    }
    return null;
  }

  /**
   * Record a runtime waterfall request (approval / user question) as a pending
   * item. Idempotent on the eventId: a re-delivery of the same event returns
   * the existing item with status 'duplicate' and never appends twice.
   *
   * @param {{eventId?: string, rpcId?: string, clientId?: string,
   *          kind: 'approval'|'question', sessionId?: string,
   *          toolName?: string, preset?: string, atMs?: number}} request
   * @returns {{ok: true, status: 'added'|'duplicate', id: string, item: object}
   *          |{ok: false, code: string}}
   */
  function notePendingRequest(request) {
    if (!isPlainObject(request)) return Object.freeze({ ok: false, code: 'REQUEST_INVALID' });
    const kind = PENDING_KINDS.includes(request.kind) ? request.kind : null;
    if (!kind) return Object.freeze({ ok: false, code: 'KIND_INVALID' });
    const eventId = typeof request.eventId === 'string' && request.eventId !== '' ? request.eventId : null;
    const rpcId = typeof request.rpcId === 'string' && request.rpcId !== '' ? request.rpcId : null;
    // The 0.1.5 mux waterfall carries the eventId; the 0.1.1 server-request
    // frame only carries the rpcId. One stable id either way.
    const id = eventId || (rpcId ? `legacy:${rpcId}` : null);
    if (!id) return Object.freeze({ ok: false, code: 'EVENT_ID_MISSING' });
    const existing = pendingItems.get(id);
    if (existing) {
      return Object.freeze({ ok: true, status: 'duplicate', id, item: existing });
    }
    const rawTool = typeof request.toolName === 'string' && request.toolName.trim() !== ''
      ? request.toolName.trim()
      : null;
    // A question pending is an ask_user_question by definition: normalizing it
    // here (not trusting the caller) is what keeps classifyRisk() on the spec
    // §5 low row for question cards.
    const toolName = kind === 'question' ? (rawTool || 'ask_user_question') : rawTool;
    const preset = typeof request.preset === 'string' && request.preset.trim() !== ''
      ? request.preset.trim()
      : null;
    const item = Object.freeze({
      id,
      kind,
      employeeId: employeeIdForSession(typeof request.sessionId === 'string' ? request.sessionId : ''),
      toolName,
      // 一句话摘要（工具名/意图，spec §4）: the tool phrase, never runtime text.
      // Question summaries state the intent only — the question body is task
      // text and must never reach the snapshot.
      summary: kind === 'question' ? questionSummaryZh() : toolPhraseZhOf(toolName),
      detailRef: PENDING_DETAIL_REF,
      risk: classifyRisk({ toolName, preset }),
      createdAtMs: Number.isFinite(Number(request.atMs)) ? Number(request.atMs) : clock.nowMs(),
      eventId,
      clientId: typeof request.clientId === 'string' && request.clientId !== '' ? request.clientId : null,
    });
    pendingItems.set(id, item);
    pendingRoutes.set(id, { rpcId: rpcId || eventId });
    while (pendingItems.size > PENDING_LIMIT) {
      const oldest = pendingItems.keys().next().value;
      pendingItems.delete(oldest);
      pendingRoutes.delete(oldest);
      noteDiagnostic('PENDING_BACKLOG_TRUNCATED');
    }
    return Object.freeze({ ok: true, status: 'added', id, item });
  }

  /** Remove a pending item (answered / revoked). Accepts any of the ids the
   * runtime uses: the waterfall eventId or the routing rpcId. Returns the
   * removed item, or null. */
  function resolvePending(idOrRpcId) {
    if (typeof idOrRpcId !== 'string' || idOrRpcId === '') return null;
    if (pendingItems.has(idOrRpcId)) {
      const item = pendingItems.get(idOrRpcId);
      pendingItems.delete(idOrRpcId);
      pendingRoutes.delete(idOrRpcId);
      return item;
    }
    for (const [id, item] of pendingItems) {
      if (item.eventId === idOrRpcId) {
        pendingItems.delete(id);
        pendingRoutes.delete(id);
        return item;
      }
      const route = pendingRoutes.get(id);
      if (route && route.rpcId === idOrRpcId) {
        pendingItems.delete(id);
        pendingRoutes.delete(id);
        return item;
      }
    }
    return null;
  }

  /** The answer routing handle for a pending id (main process only — never
   * part of the snapshot). Used by the shared answer surface. */
  function pendingRoute(id) {
    const route = pendingRoutes.get(id);
    return route ? Object.freeze({ ...route }) : null;
  }

  /**
   * Answer a pending request through the SHARED runtime answer path (the same
   * respondToRuntime($events/result) implementation the IM channel uses, so
   * the panel and IM can never double-answer with divergent logic). main.js
   * injects the transport; on success the pending item is removed here.
   *
   * @param {{id: string, value: any, what?: string}} request
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function answerPending(request) {
    if (!isPlainObject(request) || typeof request.id !== 'string' || request.id === '') {
      return Object.freeze({ ok: false, reason: 'missing pending id' });
    }
    const route = pendingRoute(request.id);
    if (!route) return Object.freeze({ ok: false, reason: 'unknown pending id' });
    if (typeof options.answerRequest !== 'function') {
      return Object.freeze({ ok: false, reason: 'answer channel unavailable' });
    }
    const res = await options.answerRequest({
      rpcId: route.rpcId,
      value: request.value,
      what: typeof request.what === 'string' && request.what !== ''
        ? request.what
        : `office pending answer (${request.id})`,
    });
    if (res && res.ok) resolvePending(request.id);
    return res;
  }

  /** Snapshot-ordered pending list: risk desc, then age asc (spec §3 sort). */
  function pendingSnapshot() {
    return [...pendingItems.values()].sort((a, b) => {
      const byRisk = RISK_ORDER[b.risk] - RISK_ORDER[a.risk];
      if (byRisk !== 0) return byRisk;
      if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  function activeSessionIdFor(employeeId) {
    const snapshot = registry.snapshot();
    const binding = snapshot.bindings.find(
      (entry) => entry.employeeId === employeeId && entry.releasedAt === null
    );
    return binding ? binding.sessionId : null;
  }

  function animationStateFor(rec) {
    if (rec.transition && rec.transition.kind === 'task-end' && rec.transition.phase === 'result') {
      return rec.transition.outcome === 'failed' ? 'error' : 'finished';
    }
    if (rec.segment) return 'walk'; // anchor interpolation walks by facing
    if (rec.state.movement === 'moving') return 'walk';
    if (rec.state.activity === 'sleeping') return 'sleeping';
    if (rec.transition && rec.transition.kind === 'task-start' && rec.transition.phase === 'work') return 'working';
    if (rec.state.runtime === 'running' || rec.state.runtime === 'attention') return 'working';
    if (rec.state.activity === 'chatting') return 'side';
    return 'idle';
  }

  function activityFor(rec) {
    if (rec.transition && rec.transition.kind === 'task-end' && rec.transition.phase === 'result') {
      return rec.transition.outcome === 'failed' ? 'working' : 'celebrating';
    }
    if (rec.transition) return 'working';
    return rec.state.activity;
  }

  // ---- public control surface ------------------------------------------------

  // The adapter's onEvent fires synchronously inside ingest(); correlating
  // facts with the CURRENT raw event (not the adapter-creation event) is what
  // keeps raw session/run handles aligned per event.
  let currentRawEvent = null;

  function ingestHarnessEvent(rawEvent) {
    if (!isPlainObject(rawEvent) || typeof rawEvent.sessionId !== 'string' || rawEvent.sessionId === '') {
      return Object.freeze({ status: 'rejected', code: 'EVENT_SHAPE_INVALID' });
    }
    let adapter = adapters.get(rawEvent.sessionId);
    if (!adapter) {
      adapter = createRuntimeAdapter({
        sessionId: rawEvent.sessionId,
        clock,
        onEvent: (output) => handleAdapterOutput(output, currentRawEvent),
        onMessage: (message) => noteDiagnostic(message && message.type === 'office:runtime-resync-request' ? 'RESYNC_REQUESTED' : 'RESYNC_MESSAGE'),
      });
      adapters.set(rawEvent.sessionId, adapter);
    }
    currentRawEvent = rawEvent;
    const result = adapter.ingest({
      type: rawEvent.type,
      seq: rawEvent.seq,
      time: typeof rawEvent.time === 'number' ? rawEvent.time : clock.nowMs(),
      data: isPlainObject(rawEvent.data) ? rawEvent.data : {},
    });
    recomputeGlobalSync();
    pushSnapshot();
    return result;
  }

  function controlIntent(employeeId, control) {
    if (!EMPLOYEE_IDS.includes(employeeId)) return Object.freeze({ ok: false, code: 'UNKNOWN_EMPLOYEE' });
    const sessionId = activeSessionIdFor(employeeId);
    if (!sessionId) return Object.freeze({ ok: false, code: 'NOT_BOUND' });
    const adapter = adapters.get(sessionId.split('#')[0]);
    if (!adapter) return Object.freeze({ ok: false, code: 'NOT_BOUND' });
    const requested = adapter.requestControl({ control });
    if (!requested.ok) return Object.freeze({ ok: false, code: requested.code });
    const rec = employees.get(employeeId);
    if (control === 'cancel' || control === 'interrupt') {
      reduce(rec, { type: 'control/cancel' });
      adapter.noteCancelAcknowledged();
      registry.cancelAcknowledged({ sessionId, nowMs: logicalMs });
      noteDiagnostic('CONTROL_UNWIRED');
      noteLog(control === 'cancel' ? 'control-cancel' : 'control-interrupt', employeeId);
    } else {
      noteLog('dispatch-followup', employeeId);
    }
    pushSnapshot();
    return Object.freeze({ ok: true, control });
  }

  function noteVisibility({ viewId, visible } = {}) {
    if (typeof viewId !== 'string' || viewId === '') return Object.freeze({ ok: false, code: 'VIEW_ID_REQUIRED' });
    visibilityNoted = true;
    if (visible === true) visibleViews.add(viewId);
    else visibleViews.delete(viewId);
    return Object.freeze({ ok: true, paused: isPaused() });
  }

  function isPaused() {
    return visibilityNoted && visibleViews.size === 0;
  }

  function start() {
    if (autoTimer) return;
    autoTimer = setInterval(() => {
      advanceOneTick();
      // the view consumes snapshots over office:state only: a running clock
      // pushes one snapshot per tick (PUSH_INTERVAL_MS == TICK_MS, M2), so
      // roaming and transition motion — and the view's paint rate — stay
      // live at tick resolution between harness events
      pushSnapshot();
    }, TICK_MS);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  }
  function stop() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  }

  function pushSnapshot() {
    const due = lastPushAtMs === null || logicalMs - lastPushAtMs >= PUSH_INTERVAL_MS;
    if (!due || listeners.size === 0) return;
    lastPushAtMs = logicalMs;
    const snapshot = state();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* listener errors never break the clock */ }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getSettings() {
    return Object.freeze({ ...settings });
  }

  function validateSettings(partial) {
    return validateSettingsPartial(partial);
  }

  function updateSettings(partial) {
    const validation = validateSettings(partial);
    if (!validation.ok) return Object.freeze({ ok: false, code: validation.code });
    const normalized = normalizeSettingsPartial(partial);
    Object.assign(settings, normalized);
    if (normalized.privacyMode !== undefined) {
      redactor = createPrivacyRedactor({ mode: settings.privacyMode });
    }
    if (normalized.sceneMinDimensionPerSecond !== undefined || normalized.sleepAfterMs !== undefined || normalized.chatDurationMs !== undefined || normalized.resultPresentationMs !== undefined) {
      // Delayed effect (SPEC-08): the new value is read at the NEXT
      // behavior/transition decision point; in-progress paths and result
      // presentations are never rewritten.
      noteDiagnostic('SETTINGS_APPLY_NEXT_DECISION');
    }
    return Object.freeze({ ok: true, settings: getSettings() });
  }

  function diagnosticsSnapshot() {
    return Object.freeze({
      schemaVersion: 1,
      simulatedAtMs: logicalMs,
      sync: globalSync,
      paused: isPaused(),
      employeeCount: employees.size,
      activityLogSize: activityLog.length,
      diagnostics: diagnostics.slice(-SNAPSHOT_DIAGNOSTICS_TAIL),
      packPresent: !!pack,
      adapterCount: adapters.size,
      seed,
    });
  }

  function destroy() {
    stop();
    listeners.clear();
    adapters.clear();
    visibleViews.clear();
  }

  return Object.freeze({
    tickOnce,
    advanceOneTick,
    start,
    stop,
    state,
    ingestHarnessEvent,
    // P1 data pipeline surface (spec §4): usage injection + pending lifecycle +
    // the shared answer entry the panel and the IM channel both call.
    setUsageSnapshot,
    notePendingRequest,
    resolvePending,
    pendingRoute,
    answerPending,
    dispatch: ({ employeeId } = {}) => controlIntent(employeeId, 'followup'),
    cancel: ({ employeeId } = {}) => controlIntent(employeeId, 'cancel'),
    interrupt: ({ employeeId } = {}) => controlIntent(employeeId, 'interrupt'),
    noteVisibility,
    isPaused,
    getSettings,
    validateSettings,
    updateSettings,
    diagnostics: diagnosticsSnapshot,
    debugRootHandleCounts: () => ({
      queued: queuedRootHandles.size,
      promoted: activeRootHandles.size,
      pendingReverse: rootHandleByDerived.size,
    }),
    subscribe,
    destroy,
    layout,
    TICK_MS,
    debugRegistrySnapshot: () => registry.snapshot(),
    debugReservations: () => [...employees.values()].map((rec) => ({
      employeeId: rec.employeeId,
      hasPath: !!rec.pathReservation,
      hasWorkstation: !!rec.workstationReservation,
      pathSegments: rec.pathReservation && Array.isArray(rec.pathReservation.segments) ? rec.pathReservation.segments.length : 0,
      currentNodeId: rec.currentNodeId || null,
      preTaskNodeId: rec.preTaskNodeId || null,
      routeBlockedBy: rec.routeBlockedBy || null,
      routeLen: rec.route ? rec.route.length : 0,
      routeIndex: rec.routeIndex,
      preemptAtt: rec.debugPreemptAttempts || 0,
      preempts: rec.debugPreempts || 0,
      secondBlockers: rec.debugSecondBlockers || null,
      routeIds: rec.route ? rec.route.join('>') : null,
      acquireCode: rec.debugAcquireCode || null,
      stepBlockedBy: rec.debugStepBlockedBy || null,
      waitDetail: rec.debugWaitDetail || null,
      yieldAskedAt: rec.yieldAskedAt || null,
    })),
  });
}

// ---- IPC payload validation ---------------------------------------------------

function validateOfficeIpcPayload(channel, payload) {
  if (!OFFICE_IPC_CHANNELS.includes(channel)) return { ok: false, code: 'CHANNEL_UNKNOWN' };
  if (payload === undefined) return { ok: true, value: {} };
  if (!isPlainObject(payload)) return { ok: false, code: 'PAYLOAD_INVALID' };
  let serialized = '';
  try { serialized = JSON.stringify(payload); } catch { return { ok: false, code: 'PAYLOAD_INVALID' }; }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_IPC_PAYLOAD_BYTES) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  }
  const keys = Object.keys(payload);
  switch (channel) {
    case 'office:state':
    case 'office:diagnostics':
      return keys.length === 0 ? { ok: true, value: {} } : { ok: false, code: 'PAYLOAD_INVALID' };
    case 'office:dispatch':
    case 'office:cancel':
    case 'office:interrupt': {
      if (keys.length !== 1 || keys[0] !== 'employeeId' || typeof payload.employeeId !== 'string') {
        return { ok: false, code: 'PAYLOAD_INVALID' };
      }
      if (!EMPLOYEE_IDS.includes(payload.employeeId)) return { ok: false, code: 'PAYLOAD_INVALID' };
      return { ok: true, value: { employeeId: payload.employeeId } };
    }
    case 'office:visibility': {
      const ok = keys.every((key) => key === 'visible' || key === 'viewId')
        && typeof payload.visible === 'boolean'
        && (payload.viewId === undefined || (typeof payload.viewId === 'string' && payload.viewId.length <= 64));
      if (!ok) return { ok: false, code: 'PAYLOAD_INVALID' };
      return { ok: true, value: { visible: payload.visible, viewId: payload.viewId || 'page-default' } };
    }
    case 'office:settings': {
      if (keys.length === 1 && payload.action === 'get') return { ok: true, value: { action: 'get' } };
      if (keys.length === 2 && payload.action === 'set' && isPlainObject(payload.settings)) {
        const settingsCheck = validateSettingsPartial(payload.settings);
        if (!settingsCheck.ok) return { ok: false, code: 'PAYLOAD_INVALID' };
        return { ok: true, value: { action: 'set', settings: payload.settings } };
      }
      return { ok: false, code: 'PAYLOAD_INVALID' };
    }
    default:
      return { ok: false, code: 'PAYLOAD_INVALID' };
  }
}

// Registers the seven office:* handlers on the injected ipcMain. Dependency
// injection keeps this module free of any Electron import (pure Node tests).
function registerOfficeIpc({ ipcMain, module, log = () => {}, enabled = true }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('registerOfficeIpc requires ipcMain');
  if (!module) throw new TypeError('registerOfficeIpc requires an office module');
  for (const channel of OFFICE_IPC_CHANNELS) {
    ipcMain.handle(channel, async (_event, payload) => {
      if (!enabled) return { ok: false, code: 'OFFICE_DISABLED' };
      const validation = validateOfficeIpcPayload(channel, payload);
      if (!validation.ok) {
        return { ok: false, code: validation.code === 'PAYLOAD_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'PAYLOAD_INVALID' };
      }
      try {
        switch (channel) {
          case 'office:state':
            return { ok: true, snapshot: module.state() };
          case 'office:dispatch':
            return module.dispatch(validation.value);
          case 'office:cancel':
            return module.cancel(validation.value);
          case 'office:interrupt':
            return module.interrupt(validation.value);
          case 'office:settings':
            return validation.value.action === 'get'
              ? { ok: true, settings: module.getSettings() }
              : module.updateSettings(validation.value.settings);
          case 'office:diagnostics':
            return { ok: true, diagnostics: module.diagnostics() };
          case 'office:visibility':
            return module.noteVisibility(validation.value);
          default:
            return { ok: false, code: 'CHANNEL_UNKNOWN' };
        }
      } catch (error) {
        log(`[office] ipc ${channel} failed: ${error && error.message}`);
        return { ok: false, code: 'OFFICE_INTERNAL' };
      }
    });
  }
  return { channels: [...OFFICE_IPC_CHANNELS] };
}

// ---- persisted settings facade ---------------------------------------------------

// SPEC-08 IPC contract: persist FIRST, then apply to the live module. A
// failed write surfaces as { ok:false, code:'OFFICE_STATE_WRITE_FAILED' } and
// leaves the in-memory settings untouched (no memory/disk divergence). Only
// keys in the office-state.v1.json schema reach the store; runtime-only
// settings (e.g. chatDurationMs) are applied to the module but never
// persisted. Legacy aliases are normalized one-way before both steps.
async function persistOfficeSettings(module, store, partial) {
  const validation = module.validateSettings(partial);
  if (!validation.ok) return Object.freeze({ ok: false, code: validation.code });
  const normalized = normalizeSettingsPartial(partial);
  const persistable = {};
  for (const key of Object.keys(normalized)) {
    if (key in PERSISTED_SETTINGS_BOUNDS) persistable[key] = normalized[key];
  }
  try {
    const persisted = await store.updateSettings(persistable);
    if (!persisted.ok) {
      return Object.freeze({ ok: false, code: persisted.code || 'OFFICE_STATE_WRITE_FAILED' });
    }
  } catch {
    return Object.freeze({ ok: false, code: 'OFFICE_STATE_WRITE_FAILED' });
  }
  return module.updateSettings(normalized);
}

// ---- Task E4: runtime layout fixture source chain (main process) ------------

// Resolves the SIMULATION's layout fixture with the same chain the office
// page uses, so the walkable graph, the furniture and the rendered scene can
// never diverge:
//   1. the user-saved flat draft (userData/office-layout.v1.json), compiled
//      by office-layout-compiler against the isometric topology;
//   2. the bundled compiled flat fixture (office-layout-flat.json);
//   3. the canonical isometric fixture (never blocks startup).
// Never throws: any failure degrades down the chain and is logged with a
// stable code. The envelope check mirrors office-persistence.loadSavedLayout.
function loadRuntimeLayoutFixture({ userDataDir = null, log = () => {} } = {}) {
  const readJsonOrNull = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const isometricFixture = readJsonOrNull(path.join(__dirname, 'fixtures', 'office-layout.json'));
  const flatFixture = readJsonOrNull(path.join(__dirname, 'fixtures', 'office-layout-flat.json'));
  let savedDraft;
  if (userDataDir) {
    const saved = readJsonOrNull(path.join(userDataDir, 'office-layout.v1.json'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && saved.schemaVersion === 1) {
      savedDraft = saved;
    } else if (saved) {
      log('[office] layout: OFFICE_LAYOUT_SAVED_INVALID (envelope); using the bundled chain');
    }
  }
  const resolution = resolveRuntimeLayout({
    savedDraft,
    flatFixture,
    isometricFixture,
    validateLayout: (fixture) => {
      // createOfficeLayout throws on invalid fixtures — translate to the
      // resolver's { ok } contract so a broken bundled fixture degrades
      // down the chain instead of failing the boot.
      try { createOfficeLayout(fixture); return { ok: true }; } catch { return { ok: false }; }
    },
    assets: LAYOUT_ASSETS,
    draftWidths: DRAFT_WIDTHS,
    characterFoot: CHARACTER_FOOT_RATIO,
  });
  if (!resolution.ok || !resolution.layout) {
    log(`[office] layout: ${resolution.code || 'OFFICE_LAYOUT_UNAVAILABLE'}`);
    return null;
  }
  if (resolution.code) log(`[office] layout: ${resolution.code}`);
  log(`[office] layout source: ${resolution.source}`);
  return { fixture: resolution.layout, source: resolution.source, code: resolution.code };
}

module.exports = {
  createOfficeModule,
  validateOfficeIpcPayload,
  registerOfficeIpc,
  normalizeSettingsPartial,
  persistOfficeSettings,
  loadRuntimeLayoutFixture,
  resolveLeaveNodeId,
  OFFICE_IPC_CHANNELS,
  MAX_IPC_PAYLOAD_BYTES,
  TICK_MS,
  EMPLOYEE_IDS,
};
