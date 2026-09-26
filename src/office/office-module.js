'use strict';

// src/office/office-module.js — Task 7 / SPEC-07.
//
// The single main-process Office composition root. It composes the Task 3/4/5
// pure runtime (movement, scheduler, registry/queue, reducer, transition) and
// the Task 6 adapter into ONE simulation with ONE logical clock, and exposes a
// privacy-redacted snapshot plus the `office:*` IPC channels (eight since P3:
// `office:pending` answers pending requests through the shared runtime answer
// path and fetches their spec §4 detailRef payloads).
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
// - Control buttons are REALLY wired since the 2026-09-25 UX must-fix (B1/G1):
//   main.js injects a `controlRequest` seam (same injection pattern as
//   `answerRequest`) that reuses the IM-proven Harness RPCs — cancel →
//   `session/cancel`, followup → `session/prompt` mode 'steer'. Interrupt has
//   NO 0.1.5 counterpart: it is honestly refused (CONTROL_UNWIRED, capability
//   false) instead of pretending. A failed RPC never produces the badge /
//   timeline line — feedback must match facts.
// - Visibility pauses the logical clock; resume continues from the current
//   logical position and never replays time.
// - Two office views consume this one module: one snapshot, one clock.
//
// P4 (spec §3 block 5 / §8 P4 行): the snapshot carries a per-employee
// `record` — the selected employee's 今日工作记录 — aggregated from the
// module's own real sources (activity-log kinds, the P2 per-turn usage
// attribution, the M5 tool facts) and scoped to the real UTC+8 calendar day
// through a main.js-injected realClock. It adds no collection and no new IPC
// channel; without the injection the record degrades to a session window
// (dayKey null) and the panel never labels it 今日.

const fs = require('node:fs');
const path = require('node:path');
// P1 运行时体检（2026-09-26）：仿真时钟节流归因。monitorEventLoopDelay / ELU /
// GC 记录都是主进程级观测（不是仿真状态），只服务 start() 驱动器的诊断块；
// 仿真本身仍然只吃 logicalMs（固定步进），绝不读墙钟。
const perfHooks = (() => { try { return require('node:perf_hooks'); } catch { return null; } })();

const profiles = require('./runtime/employee-profile.js');
const { createMovementController } = require('./runtime/movement-controller.js');
const { createBehaviorScheduler, DEFAULT_CONFIG: SCHEDULER_DEFAULTS } = require('./runtime/behavior-scheduler.js');
const { createDialogueEngine } = require('./runtime/dialogue-engine.js');
const { createEmployeeRegistry } = require('./runtime/employee-registry.js');
const { createOfficeState, reduceOfficeState } = require('./runtime/state-reducer.js');
const { createTransitionController } = require('./runtime/transition-controller.js');
const { resolveAnimation } = require('./runtime/animation-controller.js');
const { createRuntimeAdapter, deriveRunProxy } = require('./runtime/runtime-adapter.js');
const { CLASSIFIED_SEATS: CLASSIFIED_SUBAGENT_SEATS } = require('./runtime/subagent-classifier.js');
const snapshotModule = require('./runtime/runtime-snapshot.js');
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
const { toolPhraseZhOf, toolPhraseKeyOf, questionSummaryZh } = require('./runtime/tool-phrases.js');
// P4 (spec §3 block 5 / §8 P4 行): the selected employee's 今日工作记录 aggregates
// the module's own real sources (activity log, per-turn usage attribution, tool
// facts) scoped to a real calendar day. The day key comes from the SAME pure
// billing-day helper the shell's usage block uses (UTC+8), so "今日" can never
// mean two different days in one panel.
const { billingDayKey } = require('./runtime/usage-snapshot.js');

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
// P1 运行时体检（2026-09-26，性能专项实测缺陷）：性能专项测得仿真时钟只跑到
// 实时 0.83x——start() 的 setInterval 每 16ms 只推进 1 步，主进程事件循环被
// 其它工作（IPC/GC/窗口）拖慢时 fire 间隔变长，logicalMs 增长恒为 16ms/fire，
// 慢掉的 fire 不补 → 员工移动/动画比设计慢约 17%。修复策略（诊断先行，补步
// 有界）：
//   - 驱动器补步：每次 fire 按"落后量"最多多跑 CLOCK_MAX_CATCH_UP_TICKS 步
//     （默认 2 → 单次 fire 至多 3 步 = 48ms 仿真 / 16ms 墙钟，3x 瞬时恢复力），
//     每次补步批次只 push 一次快照（IPC 频率不随补步上升）。
//   - 绝不追陈账：落后超过补步容量的部分直接丢弃（驱动器锚点重置到当前
//     墙钟）——长时间停顿（显示器休眠/进程挂起）唤醒后只补一小步，绝不
//     爆发式追赶；代价是持续重载下仍可能 <1.0x，由诊断块如实呈现。
//   - 仿真语义不变：advanceOneTick 恒定 +16ms logicalMs，纯逻辑时序（测试、
//     手动单步 tickOnce）完全不受补步影响——补步只存在于 start() 的墙钟驱动器。
//   - 可配：工厂 options.clockMaxCatchUpTicks（0 = 关闭补步，回到旧 1 步/fire；
//     上限 8，防burst）。
const CLOCK_MAX_CATCH_UP_TICKS = 2;
const CLOCK_MAX_CATCH_UP_TICKS_CAP = 8;
// 迟到判定阈值：fire 实际间隔超过 1.5×TICK_MS 记一次 late fire（24ms）。
const CLOCK_LATE_FACTOR = 1.5;
// 诊断日志节流：clock 块最多每 30s 一行 [office] clock 日志。
const CLOCK_LOG_INTERVAL_MS = 30_000;
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
// M4.1h: the congestion patience ladder. A task-bound walker keeps the original
// 700ms (a task must reach its desk promptly). A ROAMER walking to the left rest
// area is on a ~20-30s mission across the whole floor: abandoning it after 700ms
// of congestion sent the furthest seats (desk-1/desk-2 on the top row) back to
// the right half over and over — measured: the top-row residents never got past
// 9% left-roaming time while the bottom-row seats reached 68%. The longer
// patience is the "耐心预算" the assessment asked for, applied to the module's
// own ladder, and it stays bounded (a stale route is still dropped).
const ROAM_MISSION_PATIENCE_MS = 2000;
const ROAM_MISSION_REPLAN_MS = 1500;
const ACTIVITY_LOG_LIMIT = 200;
// P1 运行时体检（2026-09-26，长稳实测缺陷）：ROUTE_UNAVAILABLE 曾以每 tick 一条
// （16ms）的速度刷满 100 条诊断环（stepMovement 每 tick 重试路径预留，失败即
// noteDiagnostic——62.5 条/s，1.6s 环即全满），其它低频诊断（BINDING_FAILED、
// SYNC_STALE、RESYNC_* 等）全被挤出窗口，诊断环失去可观测性。策略（对全部
// 诊断码统一生效，不点名 ROUTE_UNAVAILABLE）：
//   - 窗口合并：同一 code 在窗口内只占一个环位。窗口内第一次出现**立刻入环**
//     （首现绝不丢），后续重复不再推入，只在原条目上累加 count。
//   - 折叠摘要：环条目携带 {count, lastAtMs}（count=1 时无 lastAtMs）——一条
//     "被折叠的刷屏"就是一个可读的频次摘要，低频诊断各占各的环位、互不挤占。
//   - 阈值可配：工厂 options.diagnosticsDedupWindowMs（0 = 关闭去重，回到旧行为；
//     上限 60_000），默认 DIAGNOSTICS_DEDUP_WINDOW_MS。这是进程内构造参数，
//     不是持久化设置——刷屏治理不属于用户可调的观感项。
const DIAGNOSTICS_DEDUP_WINDOW_MS = 5000;
const DIAGNOSTICS_DEDUP_WINDOW_MAX_MS = 60_000;
// 2026-09-25 收尾状态修复：绑定释放点（result 提交 / 取消释放）之后员工不得
// 再停在任务态 activity——这四个值都来自 runtime 事实而非本地行为，释放后
// 必须回到 LOCAL_ACTIVITIES（roaming/chatting/resting/sleeping）之一。
const TASK_ACTIVITIES = Object.freeze(['working', 'thinking', 'waiting', 'celebrating']);
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
// P3 (spec §4 detailRef / §8 P3 行): the harness outcome vocabulary
// (dsh-user-approval: "Only one-shot grants exist — the outcome vocabulary has
// `allowed-once` but no `allow-always`"). The panel therefore offers exactly
// 批准 = allowed-once and 拒绝 = rejected — no "always allow" exists to offer.
const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected']);
// The pending DETAIL (spec §4 `detailRef: 'office:pending-detail'`): the
// approval request itself carries no tool arguments (dsh-user-approval Known
// Limitations), so the command text / question body are resolved by main.js
// from the session's journal (same-turn tool/call by callId, with a
// session/page fallback) and handed to the module through an injected
// resolver. The detail is NEVER part of the pushed snapshot: it is fetched per
// user action (opening the danger modal / the question form) and normalized
// through the allowlist below — same boundary philosophy as the pending items.
const PENDING_DETAIL_MAX_CHARS = 4000;
const PENDING_DETAIL_ALLOWLIST = Object.freeze([
  'id', 'kind', 'toolName', 'reason', 'preset', 'command', 'commandSource',
  'targetPath', 'requestedSandboxMode', 'questions', 'atMs', 'noToolArguments',
]);

// P3: the EIGHTH office:* channel. The six legacy ones plus the P1-era seven
// carried no way to ACT on a pending request; the inline approve/reject and the
// detailRef fetch are the first office actions that talk to the runtime
// (answering through the shared respondToRuntime $events/result path), so they
// need their own whitelisted channel — mirroring the office:settings action
// discriminator instead of inventing one channel per action.
const OFFICE_IPC_CHANNELS = Object.freeze([
  'office:state',
  'office:dispatch',
  'office:cancel',
  'office:interrupt',
  'office:settings',
  'office:diagnostics',
  'office:visibility',
  'office:pending',
]);

const PROVEN_CAPABILITIES = Object.freeze({
  cancel: true,
  // 2026-09-25 UX 必修（B1/G1）：0.1.5 没有与"中断"对应的 RPC（session/cancel
  // 就是唯一的停止原语）。false 让面板把「请求中断」停用并在 tooltip 明示
  // "暂未接入"，而不是保留一个只记本地事实的安慰剂按钮。
  interrupt: false,
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
  // ---- M4.1h (2026-09-24 巡游/休息区): the roaming / rest-area knobs ----------
  // The user-facing contract is "巡游时在左半区的时间占比 40%~50%" and "任务来了
  // 立刻回工位". These are the documented controls for that behavior; the
  // defaults are mirrored from the scheduler's DEFAULT_CONFIG so the settings
  // schema can never drift from the behavior constants. They are session-scoped
  // (applied live at the next decision, like chatDurationMs) and are NOT part of
  // the persisted settings set (office-persistence bounds) — see the assessment
  // doc "已实施" section.
  leftRoamBias: 0.42,
  leftRetryAttempts: 2,
  leftRetryMs: 1500,
  restAreaAttraction: 0.6,
  restAreaDwellMs: 12000,
  restDwellMs: 6000,
  leftRoamDwellMs: 18000,
  midRouteRerouteChance: 0.12,
  detourChance: 0.15,
  personality: true,
  leftFairnessWindowMs: 180000,
  leftFairnessMaxShare: 0.5,
  leftFairnessMinDecisions: 6,
  leftCrowdLimit: 3,
  leftAfterVisitCooldownMs: 0,
  // M4.1h round 2 (2026-09-24 个体公平性): the per-employee left-time budget
  // that keeps EVERY whale-girl inside a personal band over the long window
  // (window ≈ 60 min of decayed roaming time) while the office aggregate stays
  // in 40%..50%. Defaults mirror the scheduler constants (load-time drift check).
  leftQuotaEnabled: true,
  leftQuotaWindowMs: 480000,
  leftQuotaFloor: 0.30,
  leftQuotaCeiling: 1,
  leftQuotaMinRoamMs: 60000,
  leftQuotaCatchUpChance: 0.9,
  leftQuotaAggregateFloor: 0.4,
  leftQuotaClaimTtlMs: 90000,
  // M4.1h r3: left intents are planned with corridor passage priority (see
  // behavior-scheduler.leftCorridorPriority). DEFAULT true.
  leftCorridorPriority: true,
  // Widen that priority from under-served walkers to EVERY left mission.
  // DEFAULT false (measured: widening saturates the wing, pooled share 0.516).
  leftCorridorPriorityAll: false,
  // Opt-in runtime half of the corridor priority: a left mission may release an
  // ORDINARY roam leg ahead of it at the moment it is blocked (never a task or
  // a chat pair). DEFAULT false — see hasWalkPriority.
  leftWalkPriority: false,
  // M4.1h r2: cooldown after a corridor yield breaks a chat pair (see
  // behavior-scheduler preemptLocal). DEFAULT 0 = OFF (opt-in livelock guard).
  chatBreakCooldownMs: 0,
});

const SETTINGS_SCHEMA = Object.freeze({
  reducedMotion: { type: 'boolean' },
  resultPresentationMs: { type: 'int', min: 1000, max: 30000 },
  sceneMinDimensionPerSecond: { type: 'number', min: 0.02, max: 0.6 },
  userFrameDurationOverrideMs: { type: 'intOrNull', min: 60, max: 2000 },
  sleepAfterMs: { type: 'int', min: 60000, max: 24 * 60 * 60 * 1000 },
  chatDurationMs: { type: 'int', min: 3000, max: 10 * 60 * 1000 },
  privacyMode: { type: 'enum', values: ['redacted', 'full'] },
  // M4.1h roaming / rest-area knobs (see DEFAULT_SETTINGS).
  leftRoamBias: { type: 'number', min: 0, max: 1 },
  leftRetryAttempts: { type: 'int', min: 0, max: 10 },
  leftRetryMs: { type: 'int', min: 100, max: 10000 },
  restAreaAttraction: { type: 'number', min: 0, max: 1 },
  restAreaDwellMs: { type: 'int', min: 2000, max: 120000 },
  restDwellMs: { type: 'int', min: 2000, max: 120000 },
  leftRoamDwellMs: { type: 'int', min: 2000, max: 120000 },
  midRouteRerouteChance: { type: 'number', min: 0, max: 0.5 },
  detourChance: { type: 'number', min: 0, max: 0.5 },
  personality: { type: 'boolean' },
  leftFairnessWindowMs: { type: 'int', min: 10000, max: 600000 },
  leftFairnessMaxShare: { type: 'number', min: 0.1, max: 1 },
  leftFairnessMinDecisions: { type: 'int', min: 1, max: 40 },
  leftCrowdLimit: { type: 'int', min: 0, max: 5 },
  leftAfterVisitCooldownMs: { type: 'int', min: 0, max: 300000 },
  // M4.1h r2 per-employee fairness budget (see DEFAULT_SETTINGS).
  leftQuotaEnabled: { type: 'boolean' },
  leftQuotaWindowMs: { type: 'int', min: 60000, max: 3600000 },
  leftQuotaFloor: { type: 'number', min: 0, max: 0.5 },
  leftQuotaCeiling: { type: 'number', min: 0.2, max: 1 },
  leftQuotaMinRoamMs: { type: 'int', min: 5000, max: 600000 },
  leftQuotaCatchUpChance: { type: 'number', min: 0, max: 1 },
  leftQuotaAggregateFloor: { type: 'number', min: 0, max: 0.6 },
  leftQuotaClaimTtlMs: { type: 'int', min: 10000, max: 600000 },
  leftCorridorPriority: { type: 'boolean' },
  leftCorridorPriorityAll: { type: 'boolean' },
  leftWalkPriority: { type: 'boolean' },
  chatBreakCooldownMs: { type: 'int', min: 0, max: 60000 },
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

// M4.1h: the settings keys that are forwarded to the behavior scheduler (as
// creation config AND as live `configure()` updates). Kept as one list so a new
// knob can never be wired into only one of the two paths.
const SCHEDULER_TUNING_KEYS = Object.freeze([
  'leftRoamBias',
  'leftRetryAttempts',
  'leftRetryMs',
  'restAreaAttraction',
  'restAreaDwellMs',
  'restDwellMs',
  'leftRoamDwellMs',
  'midRouteRerouteChance',
  'detourChance',
  'personality',
  'leftFairnessWindowMs',
  'leftFairnessMaxShare',
  'leftFairnessMinDecisions',
  'leftCrowdLimit',
  'leftAfterVisitCooldownMs',
  'leftQuotaEnabled',
  'leftQuotaWindowMs',
  'leftQuotaFloor',
  'leftQuotaCeiling',
  'leftQuotaMinRoamMs',
  'leftQuotaCatchUpChance',
  'leftQuotaAggregateFloor',
  'leftQuotaClaimTtlMs',
  'leftCorridorPriority',
  'leftCorridorPriorityAll',
  'chatBreakCooldownMs',
]);
// The schema defaults are asserted against the scheduler's own DEFAULT_CONFIG
// at module load: a drift between the two is a programming error, not a
// runtime surprise (the same guard style main.js uses for its perf invariants).
for (const key of SCHEDULER_TUNING_KEYS) {
  if (SCHEDULER_DEFAULTS[key] !== DEFAULT_SETTINGS[key]) {
    throw new Error(`office settings drift: ${key} default ${DEFAULT_SETTINGS[key]} != scheduler ${SCHEDULER_DEFAULTS[key]}`);
  }
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
    // P4 (spec §3 block 5): an OPTIONAL real wall-clock reader, injected by
    // main.js (`() => Date.now()`). It is metadata-only: the simulation, the
    // movement controller and every date-math consumer keep using the logical
    // counter above, and the module itself never reads a wall clock. Its ONLY
    // uses are stamping activity-log entries with the real event instant
    // (`realMs`) and scoping the per-employee day record to a real UTC+8
    // calendar day. Omitted (unit tests, deterministic probes) → realMs is
    // null everywhere and the day record aggregates without a day boundary
    // (documented fallback: a session-window record, never labelled "today").
    realClock = null,
    // P1 运行时体检：诊断环退避窗口（见 DIAGNOSTICS_DEDUP_WINDOW_MS 上的注释）。
    diagnosticsDedupWindowMs = DIAGNOSTICS_DEDUP_WINDOW_MS,
    // P1 运行时体检：墙钟驱动器补步上限（见 CLOCK_MAX_CATCH_UP_TICKS 注释）。
    clockMaxCatchUpTicks = CLOCK_MAX_CATCH_UP_TICKS,
  } = options || {};

  const layout = layoutFixture
    ? createOfficeLayout(layoutFixture)
    : createOfficeLayout(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'office-layout.json'), 'utf8')));

  // Task 7 keeps the simulation in the fixture's logical reference scene; the
  // renderer reprojects the snapshot to the live window size.
  const referenceScene = layout.scene();
  const scene = { width: referenceScene.referenceWidth, height: referenceScene.referenceHeight };

  // The ONLY clock: a fixed-step logical counter. No wall-clock reads.
  // (P1 运行时体检 2026-09-26：start() 的墙钟驱动器为节流诊断/有界补步读墙钟，
  // 但仿真时间本身仍只由 advanceOneTick 的 +TICK_MS 推进——补步是"多跑几个
  // 固定步"，不是"改步长"。行为时序对补步不可见：每个 tick 看到的世界与
  // 从前完全一致。)
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
      // M4.1h: the roaming / rest-area knobs travel as one object so the
      // settings keys and the scheduler's DEFAULT_CONFIG keys stay in lockstep.
      ...SCHEDULER_TUNING_KEYS.reduce((acc, key) => {
        if (cfg[key] !== undefined) acc[key] = cfg[key];
        return acc;
      }, {}),
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
  // M4.1h r2: identity of the CURRENT conversation, so a new conversation can
  // clear the corpus per-pair cooldown (see the bubble block).
  let dialogueConversationKey = null;
  let dialogueConversationStartedAt = null;
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

  // ---- P1 运行时体检：仿真时钟节流诊断（start() 驱动器专属） ----------------
  // 墙钟读取：优先注入的 realClock（main.js 提供），缺省回落 Date.now——这只
  // 服务驱动器/诊断，仿真时间仍是纯 logicalMs。
  const wallNow = () => (typeof realClock === 'function' ? realClock() : Date.now());
  const clockMaxCatchUp = Number.isInteger(clockMaxCatchUpTicks)
    && clockMaxCatchUpTicks >= 0 && clockMaxCatchUpTicks <= CLOCK_MAX_CATCH_UP_TICKS_CAP
    ? clockMaxCatchUpTicks : CLOCK_MAX_CATCH_UP_TICKS;
  // 累计统计（自 start() 起）：fires/ticks 计数、落后量分布、tick 体重、被丢弃
  // 的陈账。全部是观测数据，不参与任何行为决策。
  const clockStats = {
    running: false,
    startedAtWallMs: null,
    fires: 0,
    ticks: 0,
    catchUpTicks: 0, // 补步跑出的"多出来的"步数（不含每次 fire 的常规 1 步）
    catchUpBatches: 0,
    lateFires: 0,
    maxBehindMs: 0,
    behindSumMs: 0,
    maxIntervalMs: 0,
    droppedDebtMs: 0,
    tickBodyMaxMs: 0,
    tickBodySumMs: 0,
    lastLogAtWallMs: 0,
  };
  let lastTickWallMs = null;
  // 主进程级归因探针：事件循环延迟分位 + ELU + GC 停顿。lazy 创建（start 时），
  // stop 时关闭。进程级观测，进程里其它工作（IPC/窗口/GC）的忙碌度都在这里。
  let loopDelayMonitor = null;
  let gcObserver = null;
  let lastElu = null;
  const gcStats = { count: 0, totalPauseMs: 0, maxPauseMs: 0 };

  function startClockProbes() {
    if (!perfHooks) return;
    try {
      if (!loopDelayMonitor) {
        loopDelayMonitor = perfHooks.monitorEventLoopDelay({ resolution: 4 });
        loopDelayMonitor.enable();
      }
    } catch { loopDelayMonitor = null; }
    try {
      if (!gcObserver && typeof perfHooks.PerformanceObserver === 'function') {
        gcObserver = new perfHooks.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // GC entry.duration 单位 ms（perf_hooks 对 gc 条目已折算）。
            gcStats.count += 1;
            gcStats.totalPauseMs += entry.duration;
            if (entry.duration > gcStats.maxPauseMs) gcStats.maxPauseMs = entry.duration;
          }
        });
        gcObserver.observe({ entryTypes: ['gc'] });
      }
    } catch { gcObserver = null; }
  }

  function stopClockProbes() {
    if (loopDelayMonitor) { try { loopDelayMonitor.disable(); } catch { /* gone */ } }
    if (gcObserver) { try { gcObserver.disconnect(); } catch { /* gone */ } }
  }

  /** start() 每 fire 调用一次：墙钟节奏（补步决策）+ 节流诊断。 */
  function clockFire() {
    const fireStart = wallNow();
    if (clockStats.startedAtWallMs === null) clockStats.startedAtWallMs = fireStart;
    clockStats.fires += 1;
    if (perfHooks && perfHooks.performance && typeof perfHooks.performance.eventLoopUtilization === 'function') {
      try { lastElu = perfHooks.performance.eventLoopUtilization(lastElu); } catch { /* unavailable */ }
    }

    let steps = 1;
    let owed = 0;
    if (lastTickWallMs !== null) {
      const interval = fireStart - lastTickWallMs;
      if (interval > clockStats.maxIntervalMs) clockStats.maxIntervalMs = interval;
      const behind = Math.max(0, interval - TICK_MS);
      clockStats.behindSumMs += behind;
      if (interval > TICK_MS * CLOCK_LATE_FACTOR) clockStats.lateFires += 1;
      if (behind > clockStats.maxBehindMs) clockStats.maxBehindMs = behind;
      if (behind > 0 && clockMaxCatchUp > 0) {
        // 补步：落后每满一个整步多跑一步，容量封顶 clockMaxCatchUp。
        owed = Math.min(Math.floor(behind / TICK_MS), clockMaxCatchUp);
        if (owed > 0) {
          steps += owed;
          clockStats.catchUpBatches += 1;
          clockStats.catchUpTicks += owed;
        }
      }
      // 陈账：落后超过本次补步容量的部分直接丢弃（锚点重置到当前墙钟），
      // 绝不爆发式追赶。默认 2 步容量下单次 fire 至多追回 48ms。
      clockStats.droppedDebtMs += Math.max(0, behind - steps * TICK_MS);
    }
    // 批内只推进不推送：补步不放大 IPC（pushSnapshot 在批末统一调一次）。
    const tickStart = perfHooks && perfHooks.performance ? perfHooks.performance.now() : fireStart;
    let ran = 0;
    for (let i = 0; i < steps; i += 1) {
      const advanced = advanceOneTick();
      if (advanced === null) break; // 暂停（窗口全隐藏）：不空转、不计步
      ran += 1;
      clockStats.ticks += 1;
    }
    const tickEnd = perfHooks && perfHooks.performance ? perfHooks.performance.now() : fireStart;
    const bodyMs = Math.max(0, tickEnd - tickStart);
    clockStats.tickBodySumMs += bodyMs;
    if (bodyMs > clockStats.tickBodyMaxMs) clockStats.tickBodyMaxMs = bodyMs;
    if (ran > 0) pushSnapshot();
    // 锚点重置（丢陈账）：下一次 fire 的"落后量"从当前墙钟重新计量。
    lastTickWallMs = wallNow();

    if (clockStats.lastLogAtWallMs === 0) clockStats.lastLogAtWallMs = fireStart;
    else if (fireStart - clockStats.lastLogAtWallMs >= CLOCK_LOG_INTERVAL_MS) {
      clockStats.lastLogAtWallMs = fireStart;
      const diag = clockDiagnostics();
      log(`[office] clock fires=${clockStats.fires} ticks=${clockStats.ticks} `
        + `catchUp=${clockStats.catchUpTicks} late=${clockStats.lateFires} `
        + `maxBehind=${Math.round(clockStats.maxBehindMs)}ms droppedDebt=${Math.round(clockStats.droppedDebtMs)}ms `
        + `tickBody(max/mean)=${clockStats.tickBodyMaxMs.toFixed(1)}/`
        + `${(clockStats.ticks ? clockStats.tickBodySumMs / clockStats.ticks : 0).toFixed(2)}ms`
        + `${diag.simulatedPerWall !== null ? ` simPerWall=${diag.simulatedPerWall.toFixed(2)}x` : ''}`);
    }
  }

  /** P1 运行时体检：时钟诊断块（rides office:diagnostics，不加通道）。 */
  function clockDiagnostics() {
    const wallElapsed = clockStats.startedAtWallMs === null ? null : Math.max(1, wallNow() - clockStats.startedAtWallMs);
    const simulated = clockStats.ticks * TICK_MS;
    const delay = loopDelayMonitor;
    let eventLoop = null;
    if (delay && delay.count > 0) {
      const round2 = (v) => Math.round(v * 100) / 100;
      eventLoop = {
        delayMeanMs: round2(delay.mean / 1e6),
        delayP50Ms: round2(delay.percentile(50) / 1e6),
        delayP99Ms: round2(delay.percentile(99) / 1e6),
        delayMaxMs: round2(delay.max / 1e6),
        elu: lastElu ? Math.round(lastElu.utilization * 1000) / 1000 : null,
      };
    }
    return Object.freeze({
      running: clockStats.running,
      tickMs: TICK_MS,
      maxCatchUpTicks: clockMaxCatchUp,
      fires: clockStats.fires,
      ticks: clockStats.ticks,
      catchUpTicks: clockStats.catchUpTicks,
      catchUpBatches: clockStats.catchUpBatches,
      lateFires: clockStats.lateFires,
      maxIntervalMs: Math.round(clockStats.maxIntervalMs),
      meanBehindMs: clockStats.fires > 1 ? Math.round((clockStats.behindSumMs / (clockStats.fires - 1)) * 10) / 10 : null,
      maxBehindMs: Math.round(clockStats.maxBehindMs),
      droppedDebtMs: Math.round(clockStats.droppedDebtMs),
      tickBodyMaxMs: Math.round(clockStats.tickBodyMaxMs * 100) / 100,
      tickBodyMeanMs: clockStats.ticks ? Math.round((clockStats.tickBodySumMs / clockStats.ticks) * 100) / 100 : null,
      // 实测核心指标：仿真时间 / 墙钟时间（性能专项测得 0.83x 的直接复现位）。
      simulatedPerWall: wallElapsed === null || clockStats.ticks === 0
        ? null : Math.round((simulated / wallElapsed) * 100) / 100,
      eventLoop,
      gc: gcStats.count > 0
        ? Object.freeze({
            count: gcStats.count,
            totalPauseMs: Math.round(gcStats.totalPauseMs * 10) / 10,
            maxPauseMs: Math.round(gcStats.maxPauseMs * 10) / 10,
          })
        : Object.freeze({ count: 0, totalPauseMs: 0, maxPauseMs: 0 }),
    });
  }

  const activityLog = [];
  const diagnostics = [];
  // P1 运行时体检：code -> 最近一次入环条目（同一对象引用，见 noteDiagnostic）。
  const diagLedger = new Map();

  // P4 (spec §3 block 5 / §8 P4 行): the selected employee's 今日工作记录.
  // One bounded counter set per employee, aggregated from the module's own
  // REAL sources — never estimated, never carried across a day boundary:
  //   tasks/completed/failed/cancelled — the task-started / result-* activity
  //     log kinds (state transitions driven by runtime facts);
  //   usage {input,output,cacheRead,total,cost} + durationMs — the per-turn
  //     provider usage attribution finalizeTurnUsage() stamps (P2; first-hand
  //     assistant/message `data.usage` records translated by main.js);
  //   tools — the runtime/tool facts (M5 tool/call journal events), tallied as
  //     the fixed zh phrase family (office.staff.currentTool.*). Tool ARGUMENTS
  //     and task text structurally never enter this record.
  // Day scoping: `dayKey` is the real UTC+8 calendar day (billingDayKey, the
  // same rule the usage block uses) when a realClock is injected; a day
  // rollover resets the counters. Without a realClock the record keeps
  // dayKey=null and accumulates for the module's lifetime — the page then
  // labels it as the session record, not 今日 (see recordViewModel note).
  const DAY_RECORD_TOOL_KINDS_CAP = 8;
  const DAY_RECORD_TOOL_ROWS_CAP = 5;
  const DAY_RECORD_RECENT_CAP = 6;
  const dayRecords = new Map(); // employeeId -> record state (see emptyDayRecord)
  function emptyDayRecord() {
    return {
      dayKey: null,
      tasks: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      usage: { input: 0, output: 0, cacheRead: 0, total: 0 },
      cost: 0,
      durationMs: 0,
      tools: new Map(), // toolKind -> count (bounded by DAY_RECORD_TOOL_KINDS_CAP)
      toolsTotal: 0,
      // Last DAY_RECORD_RECENT_CAP logged kinds for this employee (the record
      // timeline rows). Bounded ring; a day rollover drops it with the record.
      recentRing: [],
    };
  }
  function dayRecordFor(employeeId) {
    let record = dayRecords.get(employeeId);
    if (!record) {
      record = emptyDayRecord();
      record.employeeId = employeeId;
      dayRecords.set(employeeId, record);
    }
    return record;
  }
  /** The record's current real day key, or null without a realClock. */
  function currentDayKey() {
    return realClock ? billingDayKey(realClock()) : null;
  }
  /** Reset the record when the real calendar day rolled over (midnight). A no-op
   * without a realClock (dayKey stays null — the session-window fallback). */
  function rollDayRecordIfNeeded(record) {
    const key = currentDayKey();
    if (key !== null && record.dayKey !== null && record.dayKey !== key) {
      const fresh = emptyDayRecord();
      fresh.employeeId = record.employeeId;
      fresh.dayKey = key;
      dayRecords.set(record.employeeId, fresh);
      return fresh;
    }
    if (key !== null && record.dayKey === null) record.dayKey = key;
    return record;
  }
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
  // 2026-09-25 UX 必修（A1）：最近一次"运行时重启 → 遗留 pending 全部失效"的
  // 标记（显式布尔位 + 逻辑钟/真实钟时间戳——时间戳可能为 0，不能只靠真值判断）。
  // 非 null 时面板显示失效说明行；新的 pending 到达即清除。只是呈现字段，永不
  // 携带会话信息。
  let pendingInvalid = false;
  let pendingInvalidAtMs = null;
  let pendingInvalidRealMs = null;
  // P2 timeline token attribution (spec §3 block 4). One open turn per active
  // binding handle: `runtime/usage` facts (main.js translated the 0.1.5
  // assistant/message `data.usage` provider record into them — a first-hand
  // per-turn source, never a day-bucket difference) accrue here and are
  // attached to the turn's task-started and result activity-log entries when
  // it ends. Keyed by the turn-scoped binding handle, so concurrent sessions
  // can never mix their accounting.
  const turnUsage = new Map(); // handle -> {employeeId, usage, cost, startedAtMs, startEntry}
  const TURN_USAGE_CAP = 32;

  /** Open one turn's accumulator when the employee sits down for a task. */
  function openTurnUsage(handle, employeeId, startEntry) {
    if (typeof handle !== 'string' || handle === '') return;
    while (turnUsage.size >= TURN_USAGE_CAP) {
      const oldest = turnUsage.keys().next().value;
      turnUsage.delete(oldest);
    }
    turnUsage.set(handle, {
      employeeId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      startedAtMs: logicalMs,
      startEntry: startEntry || null,
    });
  }

  /** Add one translated provider usage bucket (numbers only). */
  function accrueTurnUsage(handle, employeeId, usage, cost) {
    if (typeof handle !== 'string' || handle === '') return;
    let entry = turnUsage.get(handle);
    if (!entry) {
      openTurnUsage(handle, employeeId, null);
      entry = turnUsage.get(handle);
    }
    const u = entry.usage;
    u.input += Number.isFinite(Number(usage && usage.input)) ? Math.max(0, Math.round(Number(usage.input))) : 0;
    u.output += Number.isFinite(Number(usage && usage.output)) ? Math.max(0, Math.round(Number(usage.output))) : 0;
    u.cacheRead += Number.isFinite(Number(usage && usage.cacheRead)) ? Math.max(0, Math.round(Number(usage.cacheRead))) : 0;
    u.cacheWrite += Number.isFinite(Number(usage && usage.cacheWrite)) ? Math.max(0, Math.round(Number(usage.cacheWrite))) : 0;
    entry.cost += Number.isFinite(Number(cost)) && Number(cost) > 0 ? Number(cost) : 0;
  }

  /**
   * Close one turn's accumulator and stamp its attribution onto the turn's
   * activity-log entries (the task-started row and the result row). A turn
   * with no provider accounting stays unattributed — no invented numbers.
   * @returns {object|null} the attribution, or null when there is nothing.
   */
  function finalizeTurnUsage(handle, resultEntry) {
    const entry = turnUsage.get(handle);
    if (!entry) return null;
    turnUsage.delete(handle);
    const u = entry.usage;
    const total = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (total <= 0) return null;
    const stamp = {
      turnUsage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, total },
      turnCost: Math.round(entry.cost * 1e4) / 1e4,
      turnDurationMs: Math.max(0, logicalMs - entry.startedAtMs),
    };
    // P4 (spec §3 block 5): accrue the same first-hand per-turn attribution
    // into the employee's day record — the panel's 累计 token/金额/用时 rows
    // are exactly this sum, never a day-bucket difference.
    accrueDayRecordUsage(entry.employeeId, stamp);
    if (entry.startEntry && entry.startEntry.turnUsage === undefined) {
      Object.assign(entry.startEntry, stamp);
    }
    if (resultEntry) Object.assign(resultEntry, stamp);
    return stamp;
  }

  /** P4: add one finalized turn's attribution to an employee's day record. */
  function accrueDayRecordUsage(employeeId, stamp) {
    if (!employeeId || !stamp) return;
    const record = rollDayRecordIfNeeded(dayRecordFor(employeeId));
    const u = stamp.turnUsage || {};
    record.usage.input += Number.isFinite(Number(u.input)) ? Number(u.input) : 0;
    record.usage.output += Number.isFinite(Number(u.output)) ? Number(u.output) : 0;
    record.usage.cacheRead += Number.isFinite(Number(u.cacheRead)) ? Number(u.cacheRead) : 0;
    record.usage.total += Number.isFinite(Number(u.total)) ? Number(u.total) : 0;
    record.cost += Number.isFinite(Number(stamp.turnCost)) ? Number(stamp.turnCost) : 0;
    record.durationMs += Number.isFinite(Number(stamp.turnDurationMs)) ? Number(stamp.turnDurationMs) : 0;
  }

  function noteLog(kind, employeeId, detail) {
    const entry = detail
      ? { atMs: logicalMs, employeeId, kind, ...detail }
      : { atMs: logicalMs, employeeId, kind };
    // P4: the REAL event instant (main.js-injected clock) beside the logical
    // one. null when no realClock was injected — the day record and the
    // record timeline then fall back to the session-window behaviour and the
    // page never labels them 今日.
    entry.realMs = realClock ? realClock() : null;
    if (employeeId) {
      const record = rollDayRecordIfNeeded(dayRecordFor(employeeId));
      bumpDayRecordCount(record, kind);
      record.recentRing.push({ kind, atMs: entry.atMs, realMs: entry.realMs });
      while (record.recentRing.length > DAY_RECORD_RECENT_CAP) record.recentRing.shift();
    }
    activityLog.push(entry);
    if (activityLog.length > ACTIVITY_LOG_LIMIT) activityLog.splice(0, activityLog.length - ACTIVITY_LOG_LIMIT);
    return entry;
  }

  /** P4: count one activity-log kind into an employee's day record. Only the
   * four task-outcome kinds are counted; everything else (sleep / chat /
   * control) stays in the log and the record timeline. */
  function bumpDayRecordCount(record, kind) {
    const field = {
      'task-started': 'tasks',
      'result-completed': 'completed',
      'result-failed': 'failed',
      'result-cancelled': 'cancelled',
    }[kind];
    if (field) record[field] += 1;
  }

  /** P4: tally one runtime/tool fact (M5 tool/call journal event) into the
   * employee's day record, as the fixed zh phrase family — the 常用工具 row.
   * Bounded: at most DAY_RECORD_TOOL_KINDS_CAP distinct kinds per day, and a
   * day rollover resets the tally with the rest of the record. */
  function tallyDayRecordTool(employeeId, toolKind) {
    if (!employeeId || typeof toolKind !== 'string' || toolKind === '') return;
    const record = rollDayRecordIfNeeded(dayRecordFor(employeeId));
    if (!record.tools.has(toolKind) && record.tools.size >= DAY_RECORD_TOOL_KINDS_CAP) return;
    record.tools.set(toolKind, (record.tools.get(toolKind) || 0) + 1);
    record.toolsTotal += 1;
  }

  // P1 运行时体检：退避窗口参数。非法/越界值回落默认——构造参数坏值绝不改变
  // 诊断环的容量语义（DIAGNOSTICS_LIMIT 仍然封顶整个环）。
  const diagDedupWindowMs = Number.isInteger(diagnosticsDedupWindowMs)
    && diagnosticsDedupWindowMs >= 0 && diagnosticsDedupWindowMs <= DIAGNOSTICS_DEDUP_WINDOW_MAX_MS
    ? diagnosticsDedupWindowMs : DIAGNOSTICS_DEDUP_WINDOW_MS;

  function noteDiagnostic(code) {
    // 同码窗口合并：窗口内重复不推入，只在原条目上累加（环里其它 code 的
    // 条目不受影响——去重永远按 code 分桶，关键诊断不会被别人的刷屏吃掉）。
    if (diagDedupWindowMs > 0) {
      const previous = diagLedger.get(code);
      if (previous && logicalMs - previous.atMs < diagDedupWindowMs) {
        previous.count += 1;
        previous.lastAtMs = logicalMs;
        return;
      }
    }
    const entry = { atMs: logicalMs, code, count: 1 };
    diagnostics.push(entry);
    diagLedger.set(code, entry);
    if (diagnostics.length > DIAGNOSTICS_LIMIT) {
      // 被裁掉的旧条目同步清账，避免账本引用已经离开环的条目（窗口判定会
      // 因此误判"窗口内还有同码条目"）。
      for (const removed of diagnostics.splice(0, diagnostics.length - DIAGNOSTICS_LIMIT)) {
        if (diagLedger.get(removed.code) === removed) diagLedger.delete(removed.code);
      }
    }
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
    if (!acquired.ok && hasWalkPriority(rec)) {
      // M4.1h priority: a task route outranks ROAM traffic — release the roam
      // legs this leg conflicts with and retry once. Roamers re-acquire per
      // leg immediately when still clear, so nothing is starved.
      const conflicts = movementLib.findConflictingReservations({
        reservations: allReservations(rec),
        segments,
        scene,
        employeeId: rec.employeeId,
      });
      // M4.1h r3: a left-rest mission is a weaker claim than a task or a chat
      // pair (both carry a hard deadline), so its priority may clear only
      // ORDINARY roam traffic — never a chat pair walking to its reserved seats
      // (measured: releasing those halves the chat seeds' bubbles).
      const leftMissionOnly = !isTaskBound(rec)
        && !(rec.state.activity === 'chatting' && !!rec.route);
      let released = false;
      for (const conflicting of conflicts) {
        const ownerRec = employees.get(conflicting.owner);
        if (ownerRec && ownerRec.pathReservation && conflicting.id === ownerRec.pathReservation.id && !isTaskBound(ownerRec)) {
          if (leftMissionOnly && ownerRec.state.activity !== 'roaming') continue;
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

  // M4.1h: which local walkers may claim the corridor ahead of ordinary roam
  // traffic. A task route always could. The M4.1h left-roam traffic made the
  // corridor busy enough that a CHAT pair regularly failed to reach its
  // reserved seats before chatDurationMs expired (measured: bubble ticks per
  // 120s seed window fell 40-100% versus the pre-M4.1h build on the same
  // seeds), and a chat is a 15s appointment with two reserved seats — it earns
  // the same priority. The yield reason stays honest ('corridor-congestion'
  // for a chat, 'task-priority' only for a task).
  function hasWalkPriority(rec) {
    return isTaskBound(rec)
      || (rec.state.activity === 'chatting' && !!rec.route)
      // M4.1h r3: a left-rest mission carrying corridor priority may also clear
      // ORDINARY roam traffic ahead of it (never a task or a chat pair — see the
      // release-scope guard in tryAcquirePathReservation). Off by default:
      // measurement showed the planning-side priority (scheduler
      // leftCorridorPriority) plus the existing 2s mission patience/yield
      // already lift the left floor, while releasing peers' legs at runtime on
      // top of that cost the chat seeds' bubbles. Kept as an opt-in knob.
      || (settings.leftWalkPriority === true
        && !!rec.route
        && scheduler.hasLeftCorridorPriority(rec.employeeId));
  }

  // M4.1h: re-plan a blocked CHAT walk to the pair's own reserved seat.
  function replanChatRoute(rec, at) {
    const pair = scheduler.activeChatPair();
    if (!pair || (pair.a !== rec.employeeId && pair.b !== rec.employeeId)) return false;
    const seatId = pair.a === rec.employeeId ? pair.seatA : pair.seatB;
    if (typeof seatId !== 'string' || !nodesById.has(seatId)) return false;
    const fromNodeId = nearestNodeId(rec.position);
    const route = movement.findRoute({
      fromNodeId,
      toNodeId: seatId,
      behavior: 'chatting',
      reservations: scheduler.reservations(),
      nowMs: at,
      employeeId: rec.employeeId,
    });
    if (!Array.isArray(route)) return false;
    rec.replanChatAt = (rec.replanChatAt || 0) + 1;
    planRoute(rec, route, seatId, at);
    return true;
  }

  // M4.1h: is this walker's CURRENT target inside the left rest area? (The
  // scheduler owns the pool; the module only reads it to pick a patience.)
  function isLeftAreaTarget(rec) {
    const leftIds = scheduler.leftAreaNodeIds;
    if (!Array.isArray(leftIds) || leftIds.length === 0) return false;
    if (typeof rec.targetNodeId === 'string' && leftIds.includes(rec.targetNodeId)) return true;
    return false;
  }

  function isTaskBound(rec) {    // any phase in which the employee is WALKING for a task: the outbound
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

  // 2026-09-24 resync fix: per-session sync transitions are logged as they
  // happen (the shell log used to show NOTHING about office sync degradation —
  // the same blind spot the renderer-latch fix covered for the view side).
  // The adapter is the authority; this only mirrors its transitions. The
  // attempt count survives enterStale() (which clears the live resync state)
  // so the stale line still reports how many attempts were exhausted.
  const lastAdapterSync = new Map(); // raw sessionId -> last logged sync value
  const lastResyncAttempts = new Map(); // raw sessionId -> last seen attempt count
  function noteAdapterSyncTransitions() {
    for (const [sessionId, adapter] of adapters) {
      const state = adapter.state();
      // Tracked on every call: the attempt count grows inside a single
      // 'resyncing' stretch (no transition fires between retries), so the
      // stale line must report the LAST count, not the first.
      if (state.resync) lastResyncAttempts.set(sessionId, state.resync.attempts);
      if (lastAdapterSync.get(sessionId) === state.sync) continue;
      lastAdapterSync.set(sessionId, state.sync);
      const attempts = state.resync ? state.resync.attempts : (lastResyncAttempts.get(sessionId) || 0);
      const detail = [];
      if (attempts > 0) detail.push(`attempts=${attempts}`);
      if (state.bufferDepth > 0) detail.push(`buffer=${state.bufferDepth}`);
      log(`[office] sync ${state.sync} (${sessionId.slice(0, 8)}`
        + (detail.length ? `, ${detail.join(', ')}` : '') + ')');
    }
  }

  function recomputeGlobalSync() {
    let next = 'healthy';
    for (const adapter of adapters.values()) {
      const sync = adapter.state().sync;
      if (sync === 'stale') { next = 'stale'; break; }
      if (sync === 'resyncing') next = 'resyncing';
    }
    noteAdapterSyncTransitions();
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
    beginTaskTransition(rec, binding.sessionId);
    scheduler.markTaskStarted({ employeeId: rec.employeeId, nowMs: logicalMs });
    // P2: the de-identified task title (任务 #N — a per-employee counter, never
    // runtime text) and this turn's token-attribution accumulator both open
    // here; the entry is stamped when the turn ends.
    rec.taskSeq = (rec.taskSeq || 0) + 1;
    openTurnUsage(binding.sessionId, rec.employeeId, noteLog('task-started', rec.employeeId));
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
  function beginTaskTransition(rec, handle) {
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
          // 2026-09-25 收尾状态修复（用户实测"任务结束后员工不回状态"）：上一轮
          // 的 result 呈现窗口（pendingTerminal/resultUntilMs）还挂着时，同一座
          // 位又来了一条 running/attention——同一会话的下一个 turn（长稳实测里
          // 是子代理 settlement 触发的父会话续 turn）。旧时序里这条 running 把
          // activity 拉回 working、绑定却仍停在 releasing，随后过期的呈现_timer
          // 在新 turn 中途释放绑定（transition/complete 因 runtime=running 被减
          // 少器拒绝），座位就此卡在 working/未绑定，且该 turn 的 turn/end 因
          // "无活动绑定"被整体丢弃（实测卡约 50s，movement 还是 moving）。这里
          // 先走既有提交路径把过期呈现收尾（释放绑定 + transition/complete 回本
          // 地行为——此刻 runtime 仍是 completed/failed，减少器接受），再让新
          // turn 通过 ensureRootBinding 全新绑定。release 的 effects 若带出排队
          // 任务（另一会话在等座），dispatch 在此生效，随后的 running 事实按
          // "座位忙"正常排队，不会双重绑定。
          const supersededHandle = currentRootHandle(rawSessionId);
          if (supersededHandle) {
            const supersededBinding = registry.getBindingForSession(supersededHandle);
            if (supersededBinding) supersedeStalePresentation(employees.get(supersededBinding.employeeId));
          }
          const binding = ensureRootBinding(rawSessionId);
          if (!binding) return;
          const rec = employees.get(binding.employeeId);
          if (!rec.transition || rec.transition.kind !== 'task-start') beginTaskTransition(rec, binding.sessionId);
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
        // P4 (spec §3 block 5): the SAME first-hand tool/call fact feeds the
        // day record's 常用工具 tally (a bounded per-day count per fixed zh
        // phrase; the tool name/arguments never leave this counter set).
        tallyDayRecordTool(resolved.binding.employeeId, rec.toolKind);
        reduce(rec, { type: 'runtime/tool', tool: fact.tool || null });
        break;
      }
      case 'runtime/usage': {
        // P2 timeline attribution: the provider usage record translated by
        // main.js from the 0.1.5 assistant/message event (first-hand; the
        // adapter already dropped everything but the numbers). Without a live
        // binding there is no employee to attribute the turn to.
        const resolved = resolveActiveRootBinding(rawSessionId);
        if (!resolved) return;
        accrueTurnUsage(resolved.handle, resolved.binding.employeeId, fact.usage, fact.cost);
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
        if (runProxy) runsByProxy.set(runProxy, { childSessionId: rawChildId, parentSessionId: rawSessionId });
        // Classified seat (the shell matched bounded subagent metadata to one
        // of the three resident WORK seats): bind the child straight to that
        // seat — a free seat dispatches, a busy one queues FIFO. `orchestrator`
        // is never a classified seat, so a root session and its subagents can
        // still hold their seats concurrently.
        if (fact.role && CLASSIFIED_SUBAGENT_SEATS.includes(fact.role)) {
          const placed = registry.registerClassifiedSubagent({
            sessionId: rawChildId,
            runId: runProxy,
            employeeId: fact.role,
            nowMs: logicalMs,
          });
          if (placed.ok) {
            const rec = employees.get(placed.employeeId);
            if (placed.binding) {
              onBindingCreated(placed.binding, placed.effects);
            } else if (rec) {
              reduce(rec, { type: 'queue/enqueue' });
            }
            // The root path gets its 'running' fact from the session's
            // turn/start; a subagent has no followed child session, so the
            // seat is put into the same running state here (exactly the reduce
            // the root branch applies), keeping runtime/activity/binding
            // consistent with the work transition onBindingCreated started.
            // 2026-09-25 收尾状态修复：这条强制 running 与 applyFact 共用同一
            // 过期呈现收口——上一任子代理的呈现窗口还挂着时先收尾（其 release
            // 的 effects 正好把排队中的本任子代理派上座），再落 running。
            if (rec) supersedeStalePresentation(rec);
            if (rec) reduce(rec, { type: 'runtime/fact', fact: 'running', reason: null });
            if (!placed.binding) noteLog('queued', placed.employeeId);
            pushSnapshot();
          } else {
            noteDiagnostic(placed.code || 'CLASSIFIED_SUBAGENT_REJECTED');
          }
          break;
        }
        // Unclassified subagents keep the documented single collaborator FIFO.
        const enqueued = registry.registerUnclassifiedSubagent({
          sessionId: rawChildId,
          runId: runProxy,
          nowMs: logicalMs,
        });
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

  // 2026-09-25 收尾状态修复的共用收口：一个座位的上一轮 result 呈现窗口还挂着
  // （pendingTerminal/resultUntilMs 未消费）而新的 running 事实又要落到它时，
  // 必须先把过期呈现按既有提交路径收尾（releaseBinding + transition/complete，
  // 此刻 runtime 仍是 completed/failed，减少器接受），否则过期 _timer 会在新
  // turn 中途释放绑定、把座位钉死在 working/未绑定。applyFact（父座位与被
  // follow 的子会话座位共用）与 classified 子代理派座两条路都走这里。
  function supersedeStalePresentation(rec) {
    if (rec && rec.pendingTerminal && rec.resultUntilMs !== null) {
      noteLog('result-superseded', rec.employeeId, { by: 'new-turn' });
      commitReleasedTerminal(rec, logicalMs);
    }
  }

  function beginResultPresentation(rec, { outcome, evidence, sessionId, release }) {
    if (!rec || rec.pendingTerminal) return;
    // 2026-09-25 修复（celebrating × moving 并存，长稳实测 09:31:10 采样）：
    // 一个在走回工位途中就结束的短 turn（实测：settlement ack 轮）会让 result
    // 呈现叠在 task-start 的移动相位上——移动循环在 result 相位仍在推进旧
    // route，于是出现"边走边庆祝"。这里就地停走（清 route/segment、释放路径
    // 预留、movement 归位 stationary），在员工站立处呈现结果；commit 路径对
    // reachedSeat=false 本就降级为直接清理（无幻影起立），契约不变。
    if (rec.transition && rec.transition.kind === 'task-start') {
      rec.route = null;
      rec.routeIndex = 0;
      rec.targetNodeId = null;
      releasePathReservation(rec);
      rec.segment = null;
      rec.arrivedNodeId = null;
      if (rec.state.movement !== 'stationary') {
        reduce(rec, { type: 'movement/status', movement: 'stationary' });
      }
    }
    rec.pendingTerminal = { outcome, evidence, release, sessionId: sessionId || null };
    const ended = transitionCtl.beginTaskEnd({ outcome, task: {}, nowMs: logicalMs, previous: rec.transition });
    rec.transition = ended.transition;
    rec.resultUntilMs = logicalMs + settings.resultPresentationMs;
    rec.lastResult = { outcome, atMs: logicalMs };
    reduce(rec, { type: 'runtime/fact', fact: outcome, reason: outcome });
    // P2: stamp this turn's provider usage onto its start and result rows.
    finalizeTurnUsage(sessionId, noteLog(outcome === 'completed' ? 'result-completed' : 'result-failed', rec.employeeId));
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
      // 2026-09-25 修复（bound=False ⇒ activity 不得停在任务态）：取消路径的
      // 旧实现只落 runtime=idle，不触碰 activity——任务中被取消的员工会以
      // working 的样子站到下一个 tick 才被 decide 循环救回。host 侧直接中止时
      // 没有 shell 侧的 cancel 请求，减少器的 CANCEL_EVIDENCE_WITHOUT_REQUEST
      // 权威规则会让 binding 停在 bound（快照的绑定来自 registry，已释放），
      // 所以这里不看 reducer 的 binding，只看 runtime 已 idle → local/activity
      // 必然被接受，同步归位漫游。
      if (TASK_ACTIVITIES.includes(rec.state.activity)) {
        reduce(rec, { type: 'local/activity', activity: 'roaming', reason: 'task-released' });
      }
      scheduler.markTaskReleased({ employeeId: rec.employeeId, nowMs: logicalMs });
      releasePathReservation(rec);
      // P2: the cancelled turn's provider usage still belongs to its rows.
      finalizeTurnUsage(handle, noteLog('result-cancelled', rec.employeeId));
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
    // M4.1h: a roam mission to the left rest area gets the longer patience (see
    // ROAM_MISSION_PATIENCE_MS); tasks and ordinary roam traffic keep 700ms.
    const onMission = !isTaskBound(rec) && (isLeftAreaTarget(rec) || rec.state.activity === 'chatting');
    const patienceMs = onMission ? ROAM_MISSION_PATIENCE_MS : 700;
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
    const replanMs = onMission ? ROAM_MISSION_REPLAN_MS : 1000;
    if (!isTaskBound(rec) && at - rec.blockedSinceMs >= patienceMs
        && at - (rec.replanAskedAt || 0) >= replanMs) {
      rec.replanAskedAt = at;
      // M4.1h: a CHAT pair member must be able to recover its walk to the
      // reserved seat. Dropping the route was terminal for it — the scheduler's
      // next decision for a pair member is always 'continue' (the pair owns
      // both members), so nothing ever planned a new chat route and the pair
      // simply stood where the block caught it until chatDurationMs expired.
      // Re-planning here is the missing end of the M4.1d chain.
      if (rec.state.activity === 'chatting' && replanChatRoute(rec, at)) return;
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
        // M4.1h "允许中途换点": at a real waypoint (never mid-leg — a straight
        // step from mid-air would cut across the furniture) a local walker may
        // drop the rest of its route and let the next decision pick a fresh
        // target. Task-bound walkers are exempt: their route is protected.
        if (!isTaskBound(rec) && rec.state.activity === 'roaming' && Array.isArray(rec.route)) {
          const abandoned = scheduler.maybeAbandonRoute({
            employeeId: rec.employeeId,
            atMs: at,
            hopsRemaining: rec.route.length - 1 - rec.routeIndex,
          });
          if (abandoned && abandoned.abandon === true) {
            rec.route = null;
            rec.routeIndex = 0;
            rec.targetNodeId = null;
            releasePathReservation(rec);
            rec.debugRetargets = (rec.debugRetargets || 0) + 1;
          }
        }
      } else {
        arriveAtNode(rec, nextNodeId, at);
      }
    }
  }

  function tickOnce() {
    return advanceOneTick();
  }

  function advanceOneTick() {
    // 2026-09-25（性能专项，用户实测长时间挂机发热）：窗口隐藏/最小化时**不要构建
    // 快照**。旧实现是 `return state()`——暂停期间每个 tick（16ms）都全量装配一次
    // （员工循环 + registry/binding 查询 + activityLog/diagnostics 尾部 + pending
    // 排序），而调用方（start() 的 setInterval）根本不用返回值，pushSnapshot 又因
    // logicalMs 冻结而必然 no-op：100% 纯浪费。"暂停"的语义只是"不推进时间"，
    // 不要求产出快照；恢复可见后下一个 tick 会照常推进并推送。
    if (isPaused()) return null;
    logicalMs += TICK_MS;
    const at = logicalMs;

    for (const adapter of adapters.values()) adapter.tick();
    // The resync retry timeline lives inside the adapters: an exhausted cycle
    // (retries unanswered → sync=stale) happens HERE, between events, so the
    // aggregate + the per-session log line must be recomputed after the tick
    // (2026-09-24 resync fix — otherwise a stale transition could sit
    // unmirrored until the next unrelated event arrived).
    recomputeGlobalSync();

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
    // M4.1h r2 bubble visibility fix. The corpus per-pair cooldown (30 s in the
    // shipped corpus) is a gate BETWEEN conversations, but the module only had
    // the ALTERNATION counter to decide "inside a conversation" — so the FIRST
    // line of every conversation was gated, and because a pair re-forms every
    // ~20 s (chatDurationMs 15 s + scheduler chat cooldown 5 s) the cooldown
    // outlived the whole conversation: a real, seated 15 s conversation emitted
    // ZERO bubbles (measured: 6 seeds / 30 min, bubble ticks 41891 vs 68942
    // with the gate removed — every seated tick carries a bubble). A NEW
    // conversation now starts with a clean slate; the gap between two
    // conversations of the same pair is the scheduler's chatCooldownMs, which
    // is enforced before the pair can even re-form.
    if (dialogueEngine && chatPair) {
      const pairKey = [chatPair.a, chatPair.b].sort().join('|');
      if (dialogueConversationKey !== pairKey || dialogueConversationStartedAt !== chatPair.startedAt) {
        dialogueConversationKey = pairKey;
        dialogueConversationStartedAt = chatPair.startedAt;
        if (typeof dialogueEngine.clearCooldown === 'function') dialogueEngine.clearCooldown(pairKey);
      }
    } else {
      dialogueConversationKey = null;
      dialogueConversationStartedAt = null;
    }
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
  // presentation fields. P2 extends the whitelist (never bypasses the
  // redactor): `toolPhrase` is a fixed i18n-family phrase (office.staff.
  // currentTool.*, zh value of the shared tool-phrases module) and `taskSeq`
  // a per-employee counter — the de-identified task title (任务 #N). Neither
  // carries runtime text.
  // P4 extends it again the same way (spec §3 block 5): `record` is the
  // selected employee's 今日工作记录 projection below — counts, the turn
  // attribution numbers, fixed zh tool phrases and controlled activity-log
  // kinds with timestamps. It carries NO session id, task text, tool name or
  // arguments (the 常用工具 row shows the phrase family, not the raw tool name).
  // P1 English pass (2026-09-25): `chatPhase` is the FIXED chat-pair phase
  // vocabulary ('walking' | 'seated') that lets the panel show 「前往闲聊」
  // during the walk and 「闲聊」 only once BOTH members are seated — the exact
  // moment canvas bubbles appear (语义对齐: the badge must never announce a
  // conversation that is not on screen yet). `phraseKey` rides the pending
  // items: the fixed office.staff.currentTool.* key behind `summary`, so the
  // panel can render the summary in the current language without re-deriving
  // anything from the raw tool name.
  const PRESENTATION_ALLOWLIST = Object.freeze(['displayName', 'role', 'taskLabel', 'marker', 'bubble', 'toolPhrase', 'toolPhraseKey', 'taskSeq', 'record', 'chatPhase']);

  // P1 pending items (spec §4). Every field is either app-controlled
  // vocabulary (kind / risk / toolName / summary / detailRef / employeeId), a
  // monotonic timestamp (createdAtMs), or the shell-owned answer-routing
  // handles (id / eventId / clientId) the panel needs in order to address the
  // shared answer channel. None of them are session identifiers, prompt text
  // or tool arguments — task text structurally never enters an item. The
  // projection mirrors the employees presentation allowlist above.
  const PENDING_ALLOWLIST = Object.freeze([
    'id', 'kind', 'employeeId', 'toolName', 'summary', 'summaryKey', 'detailRef', 'risk',
    'createdAtMs', 'eventId', 'clientId',
  ]);

  function safePendingItem(item) {
    const out = {};
    for (const field of PENDING_ALLOWLIST) {
      out[field] = item[field] === undefined ? null : item[field];
    }
    return out;
  }

  /**
   * P4 (spec §3 block 5): project one employee's day record for the snapshot.
   * Returns null when the record holds nothing at all (an idle employee on a
   * fresh day shows no record rows rather than zeros — no fabricated data).
   *
   * Shape (all numbers / fixed vocabularies; `dayKey` is the real UTC+8 day
   * when a realClock is injected, else null):
   *   { dayKey, tasks, completed, failed, cancelled,
   *     usage: { input, output, cacheRead, total, cost } | null,   // no turn
   *       carried a provider usage record → null, never zeros
   *     durationMs, tools: [{ phrase, count }],                     // zh phrases
   *     recent: [{ kind, atMs, realMs }] }                          // today only
   */
  function safeDayRecord(employeeId) {
    const record = rollDayRecordIfNeeded(dayRecordFor(employeeId));
    const hasCounts = record.tasks > 0 || record.completed > 0 || record.failed > 0 || record.cancelled > 0;
    // An employee whose only events today were naps / chats still has a record
    // (the 今日动态 rows) — the null gate is "nothing logged at all today".
    if (!hasCounts && record.usage.total <= 0 && record.toolsTotal === 0 && record.recentRing.length === 0) return null;
    const recent = record.dayKey === null
      // No realClock (tests / deterministic probes): the record covers the
      // module's whole session window — the page must NOT label it 今日.
      ? record.recentRing.slice()
      : record.recentRing.filter((row) => typeof row.realMs === 'number' && billingDayKey(row.realMs) === record.dayKey);
    return {
      dayKey: record.dayKey,
      tasks: record.tasks,
      completed: record.completed,
      failed: record.failed,
      cancelled: record.cancelled,
      usage: record.usage.total > 0
        ? {
            input: record.usage.input,
            output: record.usage.output,
            cacheRead: record.usage.cacheRead,
            total: record.usage.total,
            cost: Math.round(record.cost * 1e4) / 1e4,
          }
        : null,
      durationMs: record.durationMs,
      // De-identified 常用工具 rows: the fixed zh phrase family + count only —
      // the raw tool NAME (e.g. 'bash') is deliberately not projected, the
      // phrase is the presentation vocabulary the staff rows already use.
      // `key` is the stable office.staff.currentTool.* label key (P1 English
      // pass): the page renders the phrase per language from the key, the zh
      // phrase stays the fallback.
      tools: [...record.tools.entries()]
        .map(([toolName, count]) => ({ phrase: toolPhraseZhOf(toolName), key: toolPhraseKeyOf(toolName), count }))
        .sort((a, b) => b.count - a.count || a.phrase.localeCompare(b.phrase))
        .slice(0, DAY_RECORD_TOOL_ROWS_CAP),
      recent: recent.slice(-DAY_RECORD_RECENT_CAP),
    };
  }

  /** The answer-value vocabulary per pending kind (harness outcome words; a
   * question rides an AskUserQuestionAnswer-style batch, same shape the IM
   * dispatcher answers with). */
  function isAnswerValueForKind(kind, value) {
    if (kind === 'question') {
      if (!isPlainObject(value) || !Array.isArray(value.answers) || value.answers.length === 0) return false;
      return value.answers.every((answer) => isPlainObject(answer)
        && typeof answer.id === 'string' && answer.id !== ''
        && (Array.isArray(answer.selected) || typeof answer.custom === 'string'));
    }
    return typeof value === 'string' && APPROVAL_OUTCOMES.includes(value);
  }

  /** Normalize one main.js-supplied detailRef payload. Every field is capped:
   * strings are clipped (never thrown — a truncated command still shows), the
   * question batch is size-bounded, and ONLY allowlisted presentation fields
   * cross. Unknown fields are dropped exactly like the pending item
   * projection, so a resolver bug can never widen the boundary. */
  function safePendingDetail(raw, fallbackId) {
    if (!isPlainObject(raw)) return null;
    const str = (value, max) => {
      if (typeof value !== 'string' || value === '') return null;
      return value.length > max ? `${value.slice(0, max)}…` : value;
    };
    const kind = PENDING_KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;
    const out = { id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : (fallbackId || null), kind };
    out.toolName = str(raw.toolName, 64);
    out.reason = str(raw.reason, PENDING_DETAIL_MAX_CHARS);
    out.preset = str(raw.preset, 64);
    out.command = str(raw.command, PENDING_DETAIL_MAX_CHARS);
    out.commandSource = str(raw.commandSource, 32);
    out.targetPath = str(raw.targetPath, 512);
    out.requestedSandboxMode = str(raw.requestedSandboxMode, 64);
    out.noToolArguments = raw.noToolArguments === true;
    out.atMs = Number.isFinite(Number(raw.atMs)) ? Number(raw.atMs) : null;
    if (kind === 'question') {
      const list = Array.isArray(raw.questions) ? raw.questions.slice(0, 4) : [];
      out.questions = list.map((q) => {
        const question = isPlainObject(q) ? q : {};
        const options = Array.isArray(question.options) ? question.options.slice(0, 6) : [];
        return {
          id: str(question.id, 64) || '',
          question: str(question.question, PENDING_DETAIL_MAX_CHARS) || '',
          options: options.map((o) => ({ label: str(isPlainObject(o) ? o.label : o, 200) || '' })).filter((o) => o.label),
        };
      }).filter((q) => q.id && q.question);
    } else {
      out.questions = null;
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
      // 2026-09-25 UX 必修（A1）：pending 失效说明（运行时重启后 pendingInvalid
      // 为 true，新 pending 到达即清）。呈现字段；显式写法过 tdz-guard 的
      // shorthand 扫描。
      pendingInvalid: pendingInvalid,
      pendingInvalidAtMs: pendingInvalidAtMs,
      pendingInvalidRealMs: pendingInvalidRealMs,
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
        // P1 语义对齐 (2026-09-25, user-reported): the reducer's
        // activity:'chatting' covers the WHOLE pair episode (walk + talk), but
        // the canvas bubbles only appear once BOTH members stand at their chat
        // seats. The fixed-vocabulary phase ('walking' | 'seated' | null) lets
        // the panel show 「前往闲聊/Heading to chat」 during the walk and
        // 「闲聊/Chatting」 only when the conversation is actually on screen —
        // the panel can never disagree with the picture again.
        chatPhase: pair && (pair.a === rec.employeeId || pair.b === rec.employeeId)
          ? ((rec.state.movement === 'stationary' && rec.currentNodeId === (pair.a === rec.employeeId ? pair.seatA : pair.seatB))
            ? 'seated'
            : 'walking')
          : null,
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
        // P2 staff row: the current tool as the shared zh phrase (tool-phrases
        // module → §6 i18n family; '其他' for unknown tools) and the
        // de-identified task title counter. Both are presentation fields.
        // P1 English pass: `toolPhraseKey` is the stable office.staff.
        // currentTool.* key behind the phrase — the page renders per language
        // from the key (the module owns the vocabulary; office-page.js stays
        // require-free).
        toolPhraseKey: rec.toolKind ? toolPhraseKeyOf(rec.toolKind) : null,
        toolPhrase: rec.toolKind ? toolPhraseZhOf(rec.toolKind) : null,
        taskSeq: rec.taskSeq || 0,
        // P4 (spec §3 block 5): the selected employee's 今日工作记录 (null when
        // the record is empty — see safeDayRecord).
        record: safeDayRecord(rec.employeeId),
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
   *          toolName?: string, preset?: string, sandboxWidening?: boolean,
   *          atMs?: number}} request
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
      // text and must never reach the snapshot. `summaryKey` is the fixed
      // office.staff.currentTool.* key behind the phrase (stable label key for
      // the panel's per-language rendering).
      summary: kind === 'question' ? questionSummaryZh() : toolPhraseZhOf(toolName),
      summaryKey: toolPhraseKeyOf(toolName),
      detailRef: PENDING_DETAIL_REF,
      // §5 判据输入: toolName + preset (+ the sandbox-widening flag main.js
      // derives from the harness escalation reason). The command-shape seams
      // stay empty here — the raw arguments never enter the snapshot; they are
      // fetched per user action through the detailRef channel instead.
      risk: classifyRisk({ toolName, preset, sandboxWidening: request.sandboxWidening === true }),
      createdAtMs: Number.isFinite(Number(request.atMs)) ? Number(request.atMs) : clock.nowMs(),
      eventId,
      clientId: typeof request.clientId === 'string' && request.clientId !== '' ? request.clientId : null,
    });
    pendingItems.set(id, item);
    pendingRoutes.set(id, { rpcId: rpcId || eventId });
    // 新请求到达：失效说明行完成使命（A1）。
    pendingInvalid = false;
    pendingInvalidAtMs = null;
    pendingInvalidRealMs = null;
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
   * The value is gated against the harness outcome vocabulary per kind:
   * approvals accept exactly `allowed-once` / `rejected` (there is no
   * `allow-always` to offer — dsh-user-approval Known Limitations), questions
   * accept an AskUserQuestionAnswer-style `{answers:[…]}` batch.
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
    const item = pendingItems.get(request.id);
    if (item && !isAnswerValueForKind(item.kind, request.value)) {
      return Object.freeze({ ok: false, reason: 'unsupported answer value' });
    }
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

  /** Resolve the spec §4 detailRef for a pending id. The data comes from the
   * main-process resolver main.js injects (journal correlation / session/page
   * / the question payload); this function is the boundary: unknown ids are a
   * no-op, and the payload is normalized through PENDING_DETAIL_ALLOWLIST so
   * only the presentation fields the modal needs can cross. */
  async function resolvePendingDetail(id) {
    if (typeof id !== 'string' || id === '') {
      return Object.freeze({ ok: false, code: 'DETAIL_ID_MISSING' });
    }
    const known = pendingItems.has(id)
      || [...pendingItems.values()].some((item) => item.eventId === id
        || (pendingRoutes.get(item.id) || {}).rpcId === id
        || id === `legacy:${(pendingRoutes.get(item.id) || {}).rpcId}`);
    if (!known) return Object.freeze({ ok: false, code: 'UNKNOWN_PENDING_ID' });
    if (typeof options.pendingDetail !== 'function') {
      return Object.freeze({ ok: false, code: 'DETAIL_UNAVAILABLE' });
    }
    let raw = null;
    try {
      // awaited: the main-process resolver may be async (the session/page
      // fallback is an RPC), and a promise must never reach the normalizer.
      raw = await options.pendingDetail(id);
    } catch {
      raw = null;
    }
    const detail = safePendingDetail(raw, id);
    if (!detail) return Object.freeze({ ok: false, code: 'DETAIL_UNAVAILABLE' });
    return Object.freeze({ ok: true, detail });
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

  /**
   * 2026-09-25 UX 必修（A1）：运行时重启/事件流停止后，遗留的审批/提问卡的旧
   * rpcId/eventId 已死——它们永远无法被回答，也永远不该继续冒充"待你处理"。
   * main.js 在 stopEventsFeed() 调用本入口（模块内部路径，无新 office:* 通道）：
   * 清空全部卡片，在快照留下失效说明字段（面板据此显示"运行时已重启，之前的
   * 待处理请求已失效"），新的 pending 到达时说明自动消失。
   * @returns {{ok: true, expired: number}}
   */
  function expirePendingFromRuntime() {
    const expired = pendingItems.size;
    pendingItems.clear();
    pendingRoutes.clear();
    // 只有真的清掉了卡片才标记失效：说明行的语义是"刚才那些卡为什么不见了"，
    // 没有卡片丢失（如启动期的空 stop）就不该打扰用户。
    if (expired > 0) {
      noteDiagnostic('PENDING_EXPIRED_RUNTIME_RESTART');
      pendingInvalid = true;
      pendingInvalidAtMs = logicalMs;
      pendingInvalidRealMs = typeof options.realClock === 'function' ? options.realClock() : null;
    }
    pushSnapshot();
    return Object.freeze({ ok: true, expired });
  }

  function activeSessionIdFor(employeeId) {
    // 2026-09-25（性能专项）：不再经 registry.snapshot()（整表复制+冻结）。
    // 该函数在 state() 的每员工循环里被调用，而 state() 每 tick（16ms）都要构建一次。
    const binding = registry.activeBindingForEmployee(employeeId);
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
    // 2026-09-25 收尾状态修复（长稳实测"一边走动一边显示工作中"）：task-start
    // 的移动/落座/工作相位是"工作中"没错；但 task-end 的 stand/leave 相位发生
    // 在绑定释放之后——reducer 的 transition/complete 已把 activity 归位
    // roaming，旧映射却把"任何 transition"都盖成 working，于是每个任务结束后
    // 起身/走回的几秒里面板都是"工作中/未绑定"。离场相位回落到 reducer 的
    // 本地行为。
    if (rec.transition && rec.transition.kind === 'task-start') return 'working';
    return rec.state.activity;
  }

  // ---- public control surface ------------------------------------------------

  // The adapter's onEvent fires synchronously inside ingest(); correlating
  // facts with the CURRENT raw event (not the adapter-creation event) is what
  // keeps raw session/run handles aligned per event.
  let currentRawEvent = null;

  // 2026-09-24 resync fix: the DshCockpit-internal resync cycle now has a
  // REAL answerer. The adapter asks for a baseline whenever a forward gap
  // opens; the request is recorded (bounded, latest per session) and forwarded
  // to the shell, which owns the durable-log re-read (session/page). The shell
  // answers through ingestHarnessSnapshot() below. Before this fix the request
  // died as a diagnostic string, the adapter exhausted its 5 attempts and went
  // stale — freezing the employee on its last known phase (the reported
  // 「工作中·任务执行中 + 同步滞后」 symptom).
  const RESYNC_REQUESTS_CAP = 32;
  const resyncRequests = new Map(); // raw sessionId -> latest office:runtime-resync-request
  let baselineHealing = 0; // >0 while the module answers its own requests (baseline restart)

  function handleAdapterMessage(sessionId, message) {
    const isResync = !!message && message.type === snapshotModule.RESYNC_REQUEST_TYPE;
    noteDiagnostic(isResync ? 'RESYNC_REQUESTED' : 'RESYNC_MESSAGE');
    if (!isResync) return;
    while (resyncRequests.size >= RESYNC_REQUESTS_CAP) {
      resyncRequests.delete(resyncRequests.keys().next().value);
    }
    resyncRequests.set(sessionId, message);
    if (baselineHealing > 0) {
      // The module is mid-baseline-restart for this session: it answers its
      // own (auto-started / mid-replay) requests itself — forwarding them to
      // the shell would only trigger a duplicate durable-log re-read.
      return;
    }
    if (typeof options.onResyncRequest !== 'function') return;
    try {
      options.onResyncRequest({ sessionId, request: message });
    } catch (e) {
      log(`[office] resync request forward failed (${sessionId.slice(0, 8)}): ${e && e.message || e}`);
    }
  }

  function ensureAdapter(sessionId) {
    let adapter = adapters.get(sessionId);
    if (!adapter) {
      adapter = createRuntimeAdapter({
        sessionId,
        clock,
        onEvent: (output) => handleAdapterOutput(output, currentRawEvent),
        onMessage: (message) => handleAdapterMessage(sessionId, message),
      });
      adapters.set(sessionId, adapter);
    }
    return adapter;
  }

  function ingestHarnessEvent(rawEvent) {
    if (!isPlainObject(rawEvent) || typeof rawEvent.sessionId !== 'string' || rawEvent.sessionId === '') {
      return Object.freeze({ status: 'rejected', code: 'EVENT_SHAPE_INVALID' });
    }
    const adapter = ensureAdapter(rawEvent.sessionId);
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

  // Normalizes session/page / session/follow records ({type:'event',
  // event:{type,seq,time,data}}) into ascending raw events. Returns null when
  // any record is malformed: a broken record inside the window would break the
  // replay chain, so the whole window is refused (the adapter keeps retrying
  // and the shell re-reads) instead of half-applying it.
  function normalizeJournalRecords(records) {
    if (!Array.isArray(records)) return null;
    const out = [];
    for (const record of records) {
      if (!isPlainObject(record) || !isPlainObject(record.event)) return null;
      const event = record.event;
      if (typeof event.type !== 'string' || event.type === '') return null;
      if (!Number.isInteger(event.seq) || event.seq < 0) return null;
      if (typeof event.time !== 'number' || !Number.isFinite(event.time)) return null;
      if (!isPlainObject(event.data)) return null;
      out.push({ type: event.type, seq: event.seq, time: event.time, data: event.data });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /**
   * 2026-09-24 resync fix — the backfill end of the DshCockpit-internal resync
   * cycle. `records` is a RE-READ of the durable session log (a session/follow
   * opening window or a session/page backwards page), which the shell supplies
   * in answer to the adapter's office:runtime-resync-request.
   *
   * Two shapes, decided by the re-read against the live watermark (the module
   * owns the watermark knowledge; the shell only supplies records):
   * - continuation: the window starts at or below watermark+1, so it fills the
   *   gap directly. Records are ingested incrementally; the adapter's
   *   watermark/dedupe absorbs the overlap and drainBuffer() replays the
   *   events it had buffered for the gap. No epoch churn.
   * - baseline restart: the window starts ABOVE watermark+1 (a follow stream
   *   re-open whose opening window jumped the module's watermark — exactly the
   *   reported defect), or the adapter already exhausted its retries (stale,
   *   whose only reset is rotateEpoch). The adapter's sequence state is reset
   *   (rotateEpoch), the rotation's own auto-started request is answered with
   *   a bare baseline snapshot (no facts — the records carry them), and the
   *   window is replayed from the first record above the OLD watermark
   *   (already-applied records are never replayed — no double facts). A
   *   mid-replay rejection (e.g. an over-cap payload) rotates once more so the
   *   floor absorbs the rejected seq and the tail keeps its facts; the
   *   rejection is diagnosed, never silently skipped.
   *
   * Never guesses state: everything replayed comes from real journal records.
   */
  function ingestHarnessSnapshot(request) {
    if (!isPlainObject(request) || typeof request.sessionId !== 'string' || request.sessionId === '') {
      return Object.freeze({ ok: false, code: 'REQUEST_INVALID' });
    }
    const sessionId = request.sessionId;
    const records = normalizeJournalRecords(request.records);
    if (records === null) return Object.freeze({ ok: false, code: 'RECORDS_INVALID' });
    if (records.length === 0) return Object.freeze({ ok: false, code: 'RECORDS_EMPTY' });
    // Diagnostic codes this call produced, mirrored into the bounded module
    // diagnostics stream AND returned — the snapshot diagnostics tail is
    // lossy, so an honest drop (superseded range, rejected record) must also
    // be observable at the API boundary.
    const noted = [];
    const note = (code) => { noted.push(code); noteDiagnostic(code); };

    const existing = adapters.get(sessionId);
    if (!existing) {
      // First window for this session: no gap is possible — the adapter's
      // floor logic takes the first record's seq as the baseline.
      const adapter = ensureAdapter(sessionId);
      let accepted = 0;
      for (const event of records) {
        currentRawEvent = { sessionId, type: event.type, seq: event.seq, time: event.time, data: event.data };
        const res = adapter.ingest(event);
        if (res.status === 'accepted') accepted += 1;
        else if (res.status !== 'duplicate') note(`RESYNC_REPLAY_${res.code}`);
      }
      currentRawEvent = null;
      recomputeGlobalSync();
      pushSnapshot();
      return Object.freeze({
        ok: true, mode: 'initial', replayed: accepted,
        watermark: adapter.state().watermark, sync: adapter.state().sync,
        diagnostics: Object.freeze([...noted]),
      });
    }

    const before = existing.state();
    const firstSeq = records[0].seq;
    // The continuation route is only valid while the adapter still has a live
    // resync cycle: sync=stale has no drain-based recovery (drainBuffer and
    // acceptSnapshot both only clear 'resyncing'), so a stale adapter MUST take
    // the baseline-restart route — rotateEpoch is its documented reset.
    if (firstSeq <= before.watermark + 1 && before.sync !== 'stale') {
      // Continuation: the re-read reaches the gap (or is entirely history).
      // Records at or below the watermark dedupe as STALE_SEQUENCE; the first
      // record above it is exactly watermark+1 (the window is contiguous), so
      // the gap closes and the buffered tail drains.
      let accepted = 0;
      let duplicates = 0;
      for (const event of records) {
        currentRawEvent = { sessionId, type: event.type, seq: event.seq, time: event.time, data: event.data };
        const res = existing.ingest(event);
        if (res.status === 'accepted') accepted += 1;
        else if (res.status === 'duplicate') duplicates += 1;
        else note(`RESYNC_REPLAY_${res.code}`);
      }
      currentRawEvent = null;
      recomputeGlobalSync();
      pushSnapshot();
      const after = existing.state();
      log(`[office] resync continuation applied (${sessionId.slice(0, 8)}): `
        + `watermark ${before.watermark} -> ${after.watermark}, replayed ${accepted}, `
        + `duplicate ${duplicates}, sync ${after.sync}`);
      return Object.freeze({
        ok: true, mode: 'continuation', replayed: accepted, duplicate: duplicates,
        watermark: after.watermark, sync: after.sync,
        diagnostics: Object.freeze([...noted]),
      });
    }

    // Baseline restart (stream-restart semantics: the re-read window is the new
    // baseline, never an increment onto the old watermark).
    baselineHealing += 1;
    let rotated = null;
    let replayed = 0;
    let skipped = 0;
    let rejected = 0;
    let answerFailed = false;
    try {
      // rotateEpoch() resets the adapter's sequence state (watermark 0, sync
      // resyncing) and emits exactly one office:runtime-resync-request. That
      // request is answered HERE with a bare baseline at sequence 0 — no facts,
      // because the records themselves carry every fact. The answer restores
      // sync=healthy and watermark=0, which is what lets the floor logic take
      // the first replayed record's seq as the new baseline floor.
      const answerBare = () => {
        const pending = resyncRequests.get(sessionId);
        if (!pending || !rotated || pending.sessionEpoch !== rotated.sessionEpoch) {
          // Unreachable by construction (rotateEpoch always emits one request);
          // if it ever happens, abort the replay and let the retry cycle re-ask.
          note('RESYNC_ANSWER_UNANSWERED');
          answerFailed = true;
          return false;
        }
        const bare = snapshotModule.createSnapshotResponse({
          requestId: pending.requestId,
          sessionId,
          sessionEpoch: rotated.sessionEpoch,
          sequence: 0,
          facts: {},
          eventsSince: [],
        });
        const merged = existing.acceptSnapshot(bare);
        if (!merged.ok) {
          note(`RESYNC_ANSWER_${merged.code}`);
          answerFailed = true;
          return false;
        }
        return true;
      };

      rotated = existing.rotateEpoch();
      if (answerBare()) {
        let index = 0;
        while (index < records.length) {
          const event = records[index];
          if (event.seq <= before.watermark) {
            // Already applied before the gap: replaying it would double-apply
            // facts (tool tallies, usage attribution, terminal evidence).
            skipped += 1;
            index += 1;
            continue;
          }
          currentRawEvent = { sessionId, type: event.type, seq: event.seq, time: event.time, data: event.data };
          const res = existing.ingest(event);
          if (res.status === 'accepted') {
            replayed += 1;
            index += 1;
            continue;
          }
          if (res.status === 'duplicate') { index += 1; continue; }
          // A rejected record (over-cap payload, bad shape) breaks the chain:
          // everything after it would buffer behind the hole. Rotate once more
          // so the floor logic absorbs the rejected seq, then replay from the
          // NEXT record — the tail keeps its facts and sync stays healthy. The
          // rejected record is diagnosed, never silently skipped.
          rejected += 1;
          note(`RESYNC_REPLAY_${res.code}`);
          rotated = existing.rotateEpoch();
          if (!answerBare()) break;
          index += 1;
        }
      }
      currentRawEvent = null;
      if (firstSeq > before.watermark + 1) {
        // The re-read could not reach the gap start (log start / page bound):
        // the events in between are superseded by this baseline, not replayed.
        note('RESYNC_BASELINE_PARTIAL');
      }
    } finally {
      baselineHealing = Math.max(0, baselineHealing - 1);
    }
    recomputeGlobalSync();
    pushSnapshot();
    const after = existing.state();
    if (answerFailed) {
      log(`[office] resync baseline FAILED to answer (${sessionId.slice(0, 8)}): `
        + `sync ${after.sync}, buffer ${after.bufferDepth} — the retry cycle re-asks`);
      return Object.freeze({
        ok: false, code: 'RESYNC_ANSWER_FAILED', sync: after.sync,
        diagnostics: Object.freeze([...noted]),
      });
    }
    log(`[office] resync baseline applied (${sessionId.slice(0, 8)}): `
      + `watermark ${before.watermark} -> ${after.watermark}, replayed ${replayed}, `
      + `skipped ${skipped}, rejected ${rejected}, sync ${after.sync}`);
    return Object.freeze({
      ok: true, mode: 'baseline', replayed, skipped, rejected,
      watermark: after.watermark, sync: after.sync,
      sessionEpoch: rotated ? rotated.sessionEpoch : null,
      diagnostics: Object.freeze([...noted]),
    });
  }

  // 2026-09-25 UX 必修（B1/G1）：三个控制按钮从"安慰剂"改为真接线。main.js 注入
  // `controlRequest` seam（与 answerRequest 同一注入模式），复用 IM 已验证的同一批
  // harness RPC，不另起第二套实现：
  //   - cancel    → session/cancel（IM /stop 同款，已实证能真取消运行）
  //   - followup  → session/prompt mode:'steer'（IM 绑定会话注入同款路径；需要任务文本）
  //   - interrupt → 0.1.5 无对应接口：诚实拒绝（CONTROL_UNWIRED），不发 fact、
  //                 不记时间线、不点亮徽标——没有任何假反馈。
  // RPC 失败同样不产生"取消已请求"式假成功：徽标、cancel-ack fact 与时间线记录
  // 只在运行时真正接受之后才出现（反馈与事实一致）。
  async function controlIntent(employeeId, control, text) {
    if (!EMPLOYEE_IDS.includes(employeeId)) return Object.freeze({ ok: false, code: 'UNKNOWN_EMPLOYEE' });
    if (control === 'interrupt') return Object.freeze({ ok: false, code: 'CONTROL_UNWIRED' });
    const sessionId = activeSessionIdFor(employeeId);
    if (!sessionId) return Object.freeze({ ok: false, code: 'NOT_BOUND' });
    const adapter = adapters.get(sessionId.split('#')[0]);
    if (!adapter) return Object.freeze({ ok: false, code: 'NOT_BOUND' });
    if (typeof options.controlRequest !== 'function') {
      // 无注入（纯模块装配）：拒绝而不是假装"已记录"。
      return Object.freeze({ ok: false, code: 'CONTROL_UNAVAILABLE' });
    }
    if (control === 'followup') {
      // 追加任务必须有正文（session/prompt 的内容）；空文本在调用运行时之前拒绝。
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) return Object.freeze({ ok: false, code: 'TEXT_REQUIRED' });
      text = trimmed;
    }
    let res = null;
    try {
      res = await options.controlRequest({ sessionId, control, text: typeof text === 'string' ? text.trim() : '' });
    } catch (error) {
      res = { ok: false, code: 'RUNTIME_ERROR', reason: error && error.message };
    }
    if (!res || !res.ok) {
      // 诚实失败路径：面板上不出现任何"取消已请求/已派遣"式假状态。
      noteDiagnostic('CONTROL_RPC_FAILED');
      return Object.freeze({
        ok: false,
        code: (res && res.code) || 'RUNTIME_ERROR',
        reason: (res && res.reason) || null,
      });
    }
    if (control === 'cancel') {
      const rec = employees.get(employeeId);
      const requested = adapter.requestControl({ control });
      if (!requested.ok) return Object.freeze({ ok: false, code: requested.code });
      reduce(rec, { type: 'control/cancel' });
      adapter.noteCancelAcknowledged();
      registry.cancelAcknowledged({ sessionId, nowMs: logicalMs });
      noteLog('control-cancel', employeeId);
    } else if (control === 'followup') {
      const requested = adapter.requestControl({ control });
      if (!requested.ok) return Object.freeze({ ok: false, code: requested.code });
      noteLog('dispatch-followup', employeeId);
    } else {
      return Object.freeze({ ok: false, code: 'CONTROL_UNSUPPORTED' });
    }
    pushSnapshot();
    return Object.freeze({ ok: true, control });
  }

  function noteVisibility({ viewId, visible, renderer } = {}) {
    if (typeof viewId !== 'string' || viewId === '') return Object.freeze({ ok: false, code: 'VIEW_ID_REQUIRED' });
    visibilityNoted = true;
    if (visible === true) visibleViews.add(viewId);
    else visibleViews.delete(viewId);
    noteRendererState(viewId, renderer);
    return Object.freeze({ ok: true, paused: isPaused() });
  }

  // 2026-09-24 latch fix: the view reports its renderer mode / diagnostic code
  // (and the bounded-recovery attempt count) on the EXISTING office:visibility
  // invoke — no new channel. The shell log used to show nothing at all about
  // renderer degradation (the static latch was only found by experiment); now
  // every change is logged as it happens and the latest state rides the
  // office:diagnostics response.
  let lastRendererState = null;
  function noteRendererState(viewId, renderer) {
    const normalized = normalizeRendererReport(renderer);
    if (!normalized) return;
    // P2 诊断包: fps/renderProfile are pure telemetry — they must update the
    // stored state (the office:diagnostics response should carry fresh fps)
    // WITHOUT producing a log line per jitter. The log dedup stays on the
    // (mode, code, attempts) tuple exactly as the 2026-09-24 latch fix pinned.
    const tupleUnchanged = !!lastRendererState
      && lastRendererState.mode === normalized.mode
      && lastRendererState.diagnosticCode === normalized.diagnosticCode
      && lastRendererState.recoveryAttempts === normalized.recoveryAttempts;
    const telemetryUnchanged = !!lastRendererState
      && lastRendererState.fps === normalized.fps
      && lastRendererState.renderProfile === normalized.renderProfile;
    if (tupleUnchanged && telemetryUnchanged) return; // unchanged: no log line
    if (!tupleUnchanged) {
      log(`[office] renderer mode=${normalized.mode} code=${normalized.diagnosticCode || 'ok'} `
        + `recoveryAttempts=${normalized.recoveryAttempts} (view ${viewId})`);
    }
    lastRendererState = normalized;
  }

  function isPaused() {
    return visibilityNoted && visibleViews.size === 0;
  }

  function start() {
    if (autoTimer) return;
    // P1 运行时体检：驱动器启动即开归因探针 + 清零节流观测（累计口径 =
    // 本次 start 起的一段时间，与 diagnosticsSnapshot.clock 的语义一致）。
    clockStats.running = true;
    clockStats.startedAtWallMs = null;
    clockStats.fires = 0;
    clockStats.ticks = 0;
    clockStats.catchUpTicks = 0;
    clockStats.catchUpBatches = 0;
    clockStats.lateFires = 0;
    clockStats.maxBehindMs = 0;
    clockStats.behindSumMs = 0;
    clockStats.maxIntervalMs = 0;
    clockStats.droppedDebtMs = 0;
    clockStats.tickBodyMaxMs = 0;
    clockStats.tickBodySumMs = 0;
    clockStats.lastLogAtWallMs = 0;
    lastTickWallMs = null;
    lastElu = null;
    gcStats.count = 0;
    gcStats.totalPauseMs = 0;
    gcStats.maxPauseMs = 0;
    startClockProbes();
    autoTimer = setInterval(() => {
      clockFire();
    }, TICK_MS);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
  }
  function stop() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    clockStats.running = false;
    lastTickWallMs = null;
    stopClockProbes();
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
    // M4.1h: the roaming / rest-area knobs are live too — they are read through
    // the scheduler's `knob()` at every decision, so a settings change lands on
    // the next decision without rebuilding the scheduler.
    if (SCHEDULER_TUNING_KEYS.some((key) => normalized[key] !== undefined)) {
      scheduler.configure(SCHEDULER_TUNING_KEYS.reduce((acc, key) => {
        if (normalized[key] !== undefined) acc[key] = normalized[key];
        return acc;
      }, {}));
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
      // 2026-09-24 latch fix: the VIEW-side renderer state as last reported
      // over office:visibility (null before the first report). Mode/code/
      // recoveryAttempts mirror the page's pixi-office-renderer diagnostics.
      renderer: lastRendererState ? { ...lastRendererState } : null,
      // P1 运行时体检（2026-09-26）：仿真时钟节流归因块。累计口径 = 当前
      // start() 起；riding the existing office:diagnostics channel — no new
      // office:* channel（保持恰好 8 个）。
      clock: clockDiagnostics(),
    });
  }

  function destroy() {
    stop();
    listeners.clear();
    adapters.clear();
    resyncRequests.clear();
    lastAdapterSync.clear();
    lastResyncAttempts.clear();
    turnUsage.clear();
    visibleViews.clear();
  }

  return Object.freeze({
    tickOnce,
    advanceOneTick,
    start,
    stop,
    state,
    ingestHarnessEvent,
    // 2026-09-24 resync fix: the backfill end of the resync cycle. main.js
    // answers the adapter's office:runtime-resync-request with a re-read of
    // the durable log (session/page or a follow opening window) through this
    // entry; the module owns the watermark decision (continuation vs baseline
    // restart) and never guesses state the records do not carry.
    ingestHarnessSnapshot,
    // P1 data pipeline surface (spec §4): usage injection + pending lifecycle +
    // the shared answer entry the panel and the IM channel both call.
    setUsageSnapshot,
    notePendingRequest,
    resolvePending,
    pendingRoute,
    answerPending,
    // P3: the spec §4 detailRef gate (main-process resolver injected at
    // creation as the `pendingDetail` option; unknown ids are a no-op).
    resolvePendingDetail,
    dispatch: ({ employeeId, text } = {}) => controlIntent(employeeId, 'followup', text),
    cancel: ({ employeeId } = {}) => controlIntent(employeeId, 'cancel'),
    interrupt: ({ employeeId } = {}) => controlIntent(employeeId, 'interrupt'),
    // 2026-09-25 UX 必修（A1）：运行时重启/事件流停止后的 pending 失效清理入口
    //（main.js stopEventsFeed 调用；模块内部路径，无新 office:* 通道）。
    expirePendingFromRuntime,
    noteVisibility,
    isPaused,
    getSettings,
    validateSettings,
    updateSettings,
    diagnostics: diagnosticsSnapshot,
    // P1 运行时体检：时钟节流归因块的直读入口（诊断/单测用，不新增 IPC）。
    clockDiagnostics,
    // P1 运行时体检：单次墙钟 fire 的手动驱动（诊断/单测用——确定性补步断言
    // 不依赖真实 setInterval 节奏）。
    debugClockFire: clockFire,
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
      targetNodeId: rec.targetNodeId || null,
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
      // M4.1h: how many times this walker dropped a live roam route at an
      // intermediate waypoint and re-targeted ("允许中途换点").
      retargets: rec.debugRetargets || 0,
    })),
    // M4.1h r2: the per-employee left-time budget (read-only observability for
    // the fairness regression test / headless harness). Never an IPC channel.
    debugQuota: () => (scheduler.quotaSnapshot ? scheduler.quotaSnapshot() : null),
    // M4.1h r3: why left draws were skipped (gate counters). Read-only.
    debugLeftDraw: () => (scheduler.leftDebug ? scheduler.leftDebug() : null),
  });
}

// ---- IPC payload validation ---------------------------------------------------

// 2026-09-24 latch fix: normalizes the optional view-side renderer report on
// the office:visibility invoke. Returns undefined when the field is absent
// (optional), null when present but malformed, else the normalized
// { mode, diagnosticCode, recoveryAttempts }.
// P2 诊断包（2026-09-26）：报告追加两个可选遥测字段（仍走同一 visibility
// invoke，无新通道）——`fps`（最后一次实测帧率，0–240，保留 1 位小数）与
// `renderProfile`（渲染档位枚举 id：full / low-cost）。两者都只在页面带上
// 时才出现在归一化产物里，旧载荷的产物形状逐字节不变（深比较测试不破）。
const RENDERER_REPORT_PROFILES = new Set(['full', 'low-cost']);
function normalizeRendererReport(renderer) {
  if (renderer === undefined || renderer === null) return undefined;
  if (!isPlainObject(renderer)) return null;
  const keys = Object.keys(renderer);
  if (!keys.every((key) => key === 'mode' || key === 'diagnosticCode' || key === 'recoveryAttempts'
    || key === 'fps' || key === 'renderProfile')) return null;
  if (typeof renderer.mode !== 'string' || renderer.mode.length === 0 || renderer.mode.length > 32) return null;
  const diagnosticCode = renderer.diagnosticCode === undefined ? null : renderer.diagnosticCode;
  if (diagnosticCode !== null && (typeof diagnosticCode !== 'string' || diagnosticCode.length === 0 || diagnosticCode.length > 64)) return null;
  const attempts = renderer.recoveryAttempts === undefined ? 0 : renderer.recoveryAttempts;
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > 1000) return null;
  const normalized = { mode: renderer.mode, diagnosticCode, recoveryAttempts: attempts };
  // fps: optional, bounded, one-decimal. Absent/malformed = simply not carried
  // (the report stays valid — telemetry must never break the visibility call).
  if (renderer.fps !== undefined) {
    if (typeof renderer.fps !== 'number' || !Number.isFinite(renderer.fps)
      || renderer.fps < 0 || renderer.fps > 240) return null;
    normalized.fps = Math.round(renderer.fps * 10) / 10;
  }
  // renderProfile: optional coarse enum id (pixi-office-renderer RENDER_PROFILES).
  if (renderer.renderProfile !== undefined) {
    if (typeof renderer.renderProfile !== 'string' || !RENDERER_REPORT_PROFILES.has(renderer.renderProfile)) return null;
    normalized.renderProfile = renderer.renderProfile;
  }
  return normalized;
}

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
      // 2026-09-25 UX 必修（B1）：office:dispatch 允许可选 `text`（追加任务正文，
      // 经 session/prompt steer 注入绑定的会话）——仍是原通道，无新增 office:* 通道。
      if (channel === 'office:dispatch' && keys.length === 2 && keys.includes('text')) {
        if (typeof payload.employeeId !== 'string' || !EMPLOYEE_IDS.includes(payload.employeeId)) {
          return { ok: false, code: 'PAYLOAD_INVALID' };
        }
        if (typeof payload.text !== 'string' || payload.text.trim() === '' || payload.text.length > 2000) {
          return { ok: false, code: 'PAYLOAD_INVALID' };
        }
        return { ok: true, value: { employeeId: payload.employeeId, text: payload.text } };
      }
      if (keys.length !== 1 || keys[0] !== 'employeeId' || typeof payload.employeeId !== 'string') {
        return { ok: false, code: 'PAYLOAD_INVALID' };
      }
      if (!EMPLOYEE_IDS.includes(payload.employeeId)) return { ok: false, code: 'PAYLOAD_INVALID' };
      return { ok: true, value: { employeeId: payload.employeeId } };
    }
    case 'office:visibility': {
      // 2026-09-24 latch fix: `renderer` is the view-side renderer state the
      // page attaches on the EXISTING invoke (mode / diagnosticCode /
      // recoveryAttempts). It is validated exactly like the other keys — no
      // new channel, no raw pass-through.
      const ok = keys.every((key) => key === 'visible' || key === 'viewId' || key === 'renderer')
        && typeof payload.visible === 'boolean'
        && (payload.viewId === undefined || (typeof payload.viewId === 'string' && payload.viewId.length <= 64))
        && normalizeRendererReport(payload.renderer) !== null;
      if (!ok) return { ok: false, code: 'PAYLOAD_INVALID' };
      return {
        ok: true,
        value: {
          visible: payload.visible,
          viewId: payload.viewId || 'page-default',
          renderer: normalizeRendererReport(payload.renderer) || undefined,
        },
      };
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
    // P3 待你处理 actions: answering a pending request (inline approve/reject +
    // the danger modal) and fetching its detailRef payload. The answer value is
    // either a harness outcome word (approval) or an answers batch (question) —
    // the module's answerPending re-gates it per kind; the size guard above is
    // the transport bound.
    case 'office:pending': {
      if (payload.action === 'detail') {
        if (keys.length !== 2 || keys[1] !== 'id' || typeof payload.id !== 'string'
          || payload.id === '' || payload.id.length > 128) {
          return { ok: false, code: 'PAYLOAD_INVALID' };
        }
        return { ok: true, value: { action: 'detail', id: payload.id } };
      }
      if (payload.action === 'answer') {
        if (keys.length !== 3 || keys[2] !== 'value') return { ok: false, code: 'PAYLOAD_INVALID' };
        if (typeof payload.id !== 'string' || payload.id === '' || payload.id.length > 128) {
          return { ok: false, code: 'PAYLOAD_INVALID' };
        }
        const valueIsWord = typeof payload.value === 'string' && payload.value.length > 0 && payload.value.length <= 64;
        if (!valueIsWord && !isPlainObject(payload.value)) return { ok: false, code: 'PAYLOAD_INVALID' };
        return { ok: true, value: { action: 'answer', id: payload.id, value: payload.value } };
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
          // P3 待你处理: answer → the shared respondToRuntime path (module.answerPending);
          // detail → the main.js resolver behind the spec §4 detailRef.
          case 'office:pending':
            return validation.value.action === 'detail'
              ? module.resolvePendingDetail(validation.value.id)
              : module.answerPending(validation.value);
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
  APPROVAL_OUTCOMES,
  PENDING_DETAIL_REF,
  PENDING_DETAIL_ALLOWLIST,
  MAX_IPC_PAYLOAD_BYTES,
  TICK_MS,
  EMPLOYEE_IDS,
};
