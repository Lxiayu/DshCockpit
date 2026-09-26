'use strict';

// src/office/office-page.js — Task 7 / SPEC-07.
//
// Headless controller for the Office HTML page: it owns the derived view
// model (details hierarchy, overview counts, queue badges, activity log),
// the keyboard/pointer selection model and the reduced-motion/visibility
// plumbing (2026-09-24: the office:visibility payload's `active` flag gates
// the renderer's frame pump and triggers its bounded recovery). Pure
// CommonJS with an injected `bridge` — the page passes the office-preload
// bridge, tests pass a stub. No DOM, Pixi, Electron or Harness access in
// here; the renderer consumes snapshots from the same source (office:state),
// never the other way around.
//
// Privacy contract (decision 35 / SPEC-07): the details view model is built
// from a FIXED whitelist of snapshot fields. Task summaries, session ids,
// token counts, tool arguments/results and raw error text are structurally
// absent — extra snapshot fields are ignored, not rendered.
//
// P2 (right-panel rework, spec §3): the controller also shapes the six-block
// panel view models — usageView (today's usage), staffRows (status badge +
// de-identified 任务 #N title + current tool phrase + 需要你), pendingSummary
// (inbox container + count) and the timeline rows with their per-turn token
// attribution (turnUsage/turnCost/turnDurationMs, stamped by the module from
// first-hand provider usage records).
//
// P3 (spec §3 block 3 actions): pendingSummary gains its ACTIONS — the
// controller exposes answerPending (inline approve/reject + the danger modal's
// 仅本次批准/拒绝, through the same office:pending → respondToRuntime
// ($events/result) path the IM channel uses), pendingDetail (the spec §4
// detailRef fetch) and pendingModalModel (the pure danger-modal / question-form
// view model). None of it touches the pushed snapshot: the answers route
// through the shared answer channel, the details through the per-action fetch.
//
// P4 (spec §3 block 5 / §8 P4 行): the controller exposes recordFor() — the
// selected employee's 今日工作记录 view model over the module's `record`
// snapshot projection (day-scoped counts, the per-turn usage attribution, the
// tool-phrase tally and the recent activity kinds) — plus formatClock(), the
// local wall-clock renderer the record rows and the timeline now share.
//
// P1 English pass (2026-09-25): every display-text field of the view models is
// produced through an injected `localize(key, fallback, vars)` function — the
// page builds one over the SHARED src/i18n.js dictionary (office.* families)
// and the current shell language. Every text field also carries its STABLE
// label key (`statusKey` / `nameKey` / `roleKey` / dim-field `key` / log
// `kind` / record-tools `key` / pending `summaryKey`), so the page can render
// per language without re-deriving anything. Without a localize function the
// historical zh tables below are the verbatim fallback — that keeps the
// existing consumers (and their tests) byte-identical.

const ACTIVITY_LABELS = Object.freeze({
  roaming: '漫游中',
  chatting: '交流中',
  resting: '休息中',
  sleeping: '小憩中',
  working: '工作中',
  thinking: '思考中',
  waiting: '等待中',
  celebrating: '庆祝中',
  // 配对成立、双双入座前的走位中间态（与模块快照 chatPhase:'walking' 对应）:
  // 面板在入座前不得宣布「交流中/闲聊」——那时画面还没有气泡。
  'chat-walking': '前往交流',
});

const RUNTIME_LABELS = Object.freeze({
  unbound: '空闲（未绑定）',
  idle: '空闲',
  running: '任务执行中',
  attention: '需要注意',
  completed: '已完成',
  failed: '未完成',
});

const SYNC_LABELS = Object.freeze({
  healthy: '同步正常',
  stale: '同步滞后',
  resyncing: '正在重新同步',
});

// snapshot sync state → office.sync.* dictionary key (the dictionary spells
// them ok / late / reconnecting).
const SYNC_KEY_OF = Object.freeze({ healthy: 'ok', stale: 'late', resyncing: 'reconnecting' });

const BINDING_SOURCE_LABELS = Object.freeze({
  manual: '手动绑定',
  'root-default': '根会话默认',
  heuristic: '自动归类',
});

const CONTROL_LABELS = Object.freeze({
  none: '—',
  dispatchPending: '派遣待确认',
  cancellationPending: '取消已请求',
  preemptPending: '抢占已请求',
});

const ACTIVITY_LOG_LABELS = Object.freeze({
  'chat-started': '开始交流',
  'chat-ended': '交流结束',
  'task-started': '开始任务',
  'task-arrived': '到达工位',
  'result-completed': '任务完成',
  'result-failed': '任务未完成',
  'result-cancelled': '任务已取消',
  queued: '任务排队',
  'sleep-started': '开始小憩',
  'sleep-ended': '小憩结束',
  'control-cancel': '请求取消',
  'control-interrupt': '请求中断',
  'dispatch-followup': '追加任务请求',
});

const OUTCOME_LABELS = Object.freeze({
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
});

// P2 staff status badges (spec §3 block 2): short office-semantics labels.
// The coarse activities map to 工作/巡游/闲聊/小憩; anything unknown falls
// back to the activity label above. 'chat-walking' is the intermediate phase
// keyed off the snapshot's chatPhase:'walking' — the walk TO the chat seats.
const STAFF_STATUS_LABELS = Object.freeze({
  working: '工作',
  roaming: '巡游',
  chatting: '闲聊',
  resting: '休息',
  sleeping: '小憩',
  thinking: '思考',
  waiting: '等待',
  celebrating: '庆祝',
  'chat-walking': '前往闲聊',
});

// P2 usage block (spec §3 block 1 / §6 i18n): the zh texts mirror the shell
// dictionary keys office.usage.* (the page keeps its historical zh-only
// convention — the shared tool phrase already rides the snapshot through the
// same family). pricingBasis markers are the §4 contract vocabulary.
// P1 English pass: the snapshot marker `api-key` maps to the dictionary's
// camelCase key `office.usage.basis.apiKey` (the §4 marker keeps its
// historical hyphen; the dictionary predates it).
const USAGE_BASIS_LABELS = Object.freeze({
  'api-key': '按 API Key 用量估算（本地速率）',
  subscription: '订阅套餐（金额仅供参考）',
});

// §4 pricing-basis marker → office.usage.basis.* dictionary key.
const BASIS_KEY_OF = Object.freeze({ 'api-key': 'apiKey', subscription: 'subscription' });

// P3 待你处理 (spec §3 block 3 / §5 / §6): the danger modal + the inline
// approve/reject actions. The page keeps its historical zh-only convention;
// every string below mirrors an office.pending.* dictionary key (the i18n
// contract tests pin the key sets in both dictionaries).
//
// P4-R1 AXIS CORRECTION (user-verified, first-hand on the installed
// 0.1.5-rc.2): `agentPreset` (session/list projections + the waterfall frame)
// is the AGENT composition preset id (dsh-agent-presets; the real value is
// `standard`) — a DIFFERENT axis from the permission presets
// (dsh-permission-presets: read-only / workspace-write / danger-full-access).
// That axis's `sandboxMode` is a mount-time composition property the harness
// does NOT project onto sessions, so the panel can never read a session's
// current sandbox mode. Consequences:
//   - the value is shown verbatim under 「Agent 预设」 and is never relabelled
//     "unknown" (`standard` is a legal value on its own axis);
//   - the impact line can speak about the sandbox only on a REAL widening
//     request (the approval reason) — never inferred from the agent preset.
const PENDING_MODAL_TEXT = Object.freeze({
  title: '高危操作 · 批准请求',
  questionTitle: '提问',
  tool: '工具',
  agentPreset: 'Agent 预设',
  steps: '将要执行',
  impact: '影响范围',
  command: '命令原文',
  target: '目标路径',
  reversible: '可否撤销',
  reversibleUnknown: 'harness 未提供撤销路径，请按不可逆操作对待',
  noArgs: 'harness 未暴露该工具的参数',
  noAlways: '本版本不支持记住此类授权（harness 仅提供一次性批准）',
  blocked: '审批等待期间，面板操作已阻塞；不回答不会自动继续',
  reason: '原因',
  customPlaceholder: '自定义回答…',
  submit: '提交回答',
  close: '关闭',
  escalate: (mode) => `批准后本次调用可按 ${mode} 运行（沙箱放宽请求，仅本次有效）`,
  // P4 polish ④: the "将要执行" steps (and the 命令原文 block) are the
  // harness's own ENGLISH text — mark them so they are never mistaken for
  // panel UI copy. Mirrors the office.pending.modal.raw dictionary key.
  rawTag: 'harness 原文',
  // P4-R1: the sandbox mode is not projected onto sessions (see the axis note
  // above) — the impact line states that plainly instead of guessing a tier
  // from the agent preset. Mirrors office.pending.modal.sandbox.unprojected.
  sandboxUnprojected: '沙箱模式：harness 未投影（仅在放宽请求时可见），影响范围无法预先界定',
});

// 2026-09-25 UX 必修（B2）：审批/提问回答失败时，内部英文 reason 不再原样渲染。
// 这张表把主进程/模块的已知 reason（respondToRuntime 与 answerPending 的失败词）
// 映射到 office.pending.fail.* 词典键；不在表内的未知 reason 兜底
// office.pending.answerFailed（中性中文）+ 原文进可展开的技术详情。键值两侧
// （本表 + src/i18n.js）同改。
const PENDING_FAIL_KEY_OF = Object.freeze({
  'runtime offline': 'office.pending.fail.runtimeOffline',
  'runtime event feed offline': 'office.pending.fail.feedOffline',
  'no rpc id': 'office.pending.fail.unroutable',
  'missing pending id': 'office.pending.fail.unroutable',
  'unknown pending id': 'office.pending.fail.unroutable',
  'unsupported answer value': 'office.pending.fail.unsupported',
  'answer channel unavailable': 'office.pending.fail.channelUnavailable',
  'already-answering': 'office.pending.fail.alreadyAnswering',
});

/** Resolve one failure reason into { key, unknown, detail }:
 *  - `key` is the mapped office.pending.fail.* dictionary key (null when the
 *    reason is unknown — the caller then falls back to answerFailed);
 *  - `detail` is the RAW reason (never localized) for the expandable technical
 *    details disclosure; null when there is nothing beyond the localized text. */
function pendingFailureView(reason) {
  const raw = String(reason === null || reason === undefined ? '' : reason).trim();
  const key = PENDING_FAIL_KEY_OF[raw.toLowerCase()] || null;
  return {
    key,
    unknown: !key,
    detail: raw || null,
  };
}

// P4 ⑤ 选中员工「今日工作记录」(spec §3 block 5). The zh strings mirror the
// office.record.* dictionary keys (same convention as the blocks above). Every
// row is a projection of module-side real data: counts of task-started /
// result-* log kinds, the per-turn usage attribution (first-hand provider
// usage), the day-scoped tool phrase tally and the recent activity kinds —
// never task text, never session ids.
const RECORD_TEXT = Object.freeze({
  title: '今日工作记录',
  empty: '今日暂无工作记录',
  tasks: '今日任务',
  completed: '完成',
  failed: '未完成',
  cancelled: '已取消',
  usage: '累计用量',
  duration: '用时',
  tools: '常用工具',
  timeline: '今日动态',
  note: '按 UTC+8 自然日聚合 · 仅计数与时间，不含任务内容',
  sessionNote: '本次办公室会话内的记录（未提供真实时钟，不标注为「今日」）',
});

/** Compact token count: 千 / 万 (百万 rides 万), original value on hover.
 * `lang` ('zh' | 'en') picks the unit family — the English panel shows K/M/B
 * instead of the zh 万/亿 units. The default keeps the historical zh form. */
function formatCount(value, lang = 'zh') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (lang === 'en') {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e5) return `${(n / 1e4).toFixed(0)} 万`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} 千`;
  return String(Math.round(n));
}

/** Money in CNY: two decimals below ¥100, tighter above. */
function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '¥0.00';
  if (n >= 1000) return `¥${n.toFixed(0)}`;
  if (n >= 100) return `¥${n.toFixed(1)}`;
  return `¥${n.toFixed(2)}`;
}

/** Turn duration ms -> "12s" / "3m 05s". */
function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
}

/** Wall-clock HH:MM:SS for the panel's real timestamps (P4). The office day
 * boundary is UTC+8 (billingDayKey), so real times are shown in the viewer's
 * LOCAL zone — the same zone a calendar "today" means to them. `fallbackAtMs`
 * is the module's logical stamp, used only while no real time exists (tests /
 * deterministic probes), keeping the historical UTC-of-logical display. */
function formatClock(realMs, fallbackAtMs) {
  const real = Number(realMs);
  if (Number.isFinite(real) && real > 0) {
    const d = new Date(real);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const n = Number(fallbackAtMs);
  if (fallbackAtMs === null || fallbackAtMs === undefined || !Number.isFinite(n) || n < 0) return '--:--:--';
  return new Date(n).toISOString().slice(11, 19);
}

/** P1 English pass: resolve display text through the injected localize
 * function (the page builds one over src/i18n.js + the current language).
 * Without one (legacy consumers / tests), the zh fallback is interpolated
 * verbatim — the historical presentation. */
function pickText(localize, key, fallback, vars) {
  if (typeof localize !== 'function') {
    let s = String(fallback);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    }
    return s;
  }
  const out = localize(key, fallback, vars);
  return out === undefined || out === null ? fallback : out;
}

/** The stable activity key for a snapshot employee. A chatting employee in
 * chatPhase 'walking' (pair formed, NOT both seated yet) keys to the
 * intermediate 'chat-walking' label — the panel and the picture (bubbles)
 * must never disagree about whether a conversation is happening. */
function activityKeyOf(employee) {
  if (employee.activity === 'chatting' && employee.chatPhase === 'walking') return 'chat-walking';
  return employee.activity || 'present';
}

function activityText(employee, localize) {
  const key = activityKeyOf(employee);
  return pickText(localize, `office.activity.${key}`, ACTIVITY_LABELS[key] || '在岗');
}

/** P3: the danger-modal (and question-form) view model, built from the pending
 * card item plus its spec §4 detailRef payload. `item` is a pendingSummary()
 * row; `detail` is the office:pending {action:'detail'} response (or null when
 * the resolver found nothing). Every field is presentation-only — the raw
 * command/question text comes from the main-process detail resolver, which
 * normalizes it through the module allowlist; nothing here invents data: when
 * the harness exposed no tool arguments the model says so instead of
 * fabricating a command.
 *
 * P1 English pass: the fixed modal copy resolves through `localize` over the
 * office.pending.modal.* dictionary family (zh fallback = PENDING_MODAL_TEXT);
 * harness-verbatim content (steps / command / question text) is NEVER
 * localized or rewritten. */
function buildPendingModalModel({ item, detail, localize = null } = {}) {
  const d = detail && typeof detail === 'object' ? detail : null;
  const approval = !item || item.kind !== 'question';
  const hasCommand = !!(d && typeof d.command === 'string' && d.command !== '');
  const noToolArguments = approval && !hasCommand;
  const steps = [];
  if (approval) {
    steps.push(d && typeof d.reason === 'string' && d.reason !== ''
      ? d.reason
      : pickText(localize, 'office.pending.modal.stepsFallback', `${(item && item.toolName) || 'harness'} 工具的执行请求`, { tool: (item && item.toolName) || 'harness' }));
  }
  let impact;
  if (d && typeof d.requestedSandboxMode === 'string' && d.requestedSandboxMode) {
    // The ONE place the sandbox axis is observable: a real widening request
    // names the target mode in its reason.
    impact = pickText(
      localize,
      'office.pending.modal.escalate',
      PENDING_MODAL_TEXT.escalate(d.requestedSandboxMode),
      { mode: d.requestedSandboxMode }
    );
  } else {
    // P4-R1: the agent preset is NOT a sandbox tier (different axis; see the
    // PENDING_MODAL_TEXT header). Guessing one from it is exactly the inaccuracy
    // this correction removes — the panel states that the sandbox mode is not
    // projected instead.
    impact = pickText(localize, 'office.pending.modal.sandbox.unprojected', PENDING_MODAL_TEXT.sandboxUnprojected);
  }
  const targetPath = d && typeof d.targetPath === 'string' && d.targetPath !== '' ? d.targetPath : null;
  return {
    approval,
    risk: item ? item.risk : null,
    title: approval
      ? pickText(localize, 'office.pending.modal.title', PENDING_MODAL_TEXT.title)
      : pickText(localize, 'office.pending.modal.question', PENDING_MODAL_TEXT.questionTitle),
    toolName: item ? item.toolName : null,
    summary: item ? item.summary : null,
    // P4-R1: the AGENT composition preset (agent-presets axis, e.g. `standard`)
    // — shown verbatim under the 「Agent 预设」 row; NOT a sandbox tier, never
    // mapped to one. Null when the session carries no agent preset (the row is
    // omitted).
    agentPreset: d && typeof d.preset === 'string' && d.preset !== '' ? d.preset : null,
    steps,
    impact,
    // 目标路径或命令原文（若有）: the REAL arguments when main.js correlated the
    // same-turn tool/call by callId; otherwise the honest "not exposed" note.
    command: hasCommand ? d.command : null,
    commandSource: d && typeof d.commandSource === 'string' ? d.commandSource : null,
    targetPath,
    noToolArguments,
    noArgsNote: noToolArguments ? pickText(localize, 'office.pending.modal.noArgs', PENDING_MODAL_TEXT.noArgs) : null,
    noAlwaysNote: approval ? pickText(localize, 'office.pending.modal.noAlways', PENDING_MODAL_TEXT.noAlways) : null,
    blockedNote: pickText(localize, 'office.pending.modal.blocked', PENDING_MODAL_TEXT.blocked),
    // 可否撤销: the harness seam carries no undo information (no such field in
    // the approval request), so the modal states that plainly rather than
    // guessing — the safe reading is "treat as irreversible".
    reversibleNote: pickText(localize, 'office.pending.modal.reversible.unknown', PENDING_MODAL_TEXT.reversibleUnknown),
    questions: !approval && d && Array.isArray(d.questions) ? d.questions : null,
  };
}

/**
 * P4 ⑤ 选中员工「今日工作记录」: the presentation view model over the
 * snapshot's `record` projection (module-side aggregation, see
 * office-module.safeDayRecord). `record` is null when the employee has nothing
 * recorded today — the page then shows the empty state instead of zeros.
 *
 * Sources (all real, none invented):
 *   tasks/completed/failed/cancelled — task-started / result-* activity kinds;
 *   usage — the per-turn provider usage attribution (null when no turn
 *     carried one; money is the same local-rate estimate the usage block uses);
 *   durationMs — the sum of attributed turn durations;
 *   tools — the day-scoped tool-phrase tally (fixed zh phrases, Top 5);
 *   recent — the employee's recent activity kinds (today only, ≤6).
 *
 * NOT shown, and why (no source exists):
 *   - a per-employee token/money DISPLAY beyond the attributed turns — the
 *     module only ever sees turns (runtime/usage facts); cache-only sessions
 *     and other employees' local behaviour carry no accounting;
 *   - tool ARGUMENTS, task text, session ids — structurally absent from the
 *     module's privacy boundary (same rule as the rest of the snapshot);
 *   - "效率/趋势" charts — derived from no first-hand source in this module.
 */
function buildRecordViewModel(record, localize = null) {
  if (!record || typeof record !== 'object') return null;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage : null;
  return {
    dayKey: typeof record.dayKey === 'string' ? record.dayKey : null,
    tasks: Number.isFinite(Number(record.tasks)) ? Number(record.tasks) : 0,
    completed: Number.isFinite(Number(record.completed)) ? Number(record.completed) : 0,
    failed: Number.isFinite(Number(record.failed)) ? Number(record.failed) : 0,
    cancelled: Number.isFinite(Number(record.cancelled)) ? Number(record.cancelled) : 0,
    usage: usage && Number(usage.total) > 0
      ? {
          input: Number(usage.input) || 0,
          output: Number(usage.output) || 0,
          cacheRead: Number(usage.cacheRead) || 0,
          total: Number(usage.total) || 0,
          cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : 0,
        }
      : null,
    durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : 0,
    // `key` is the stable office.staff.currentTool.* label key that rode the
    // module projection; `phrase` resolves per language (zh fallback = the
    // snapshot phrase). No raw tool name ever rides the row.
    tools: (Array.isArray(record.tools) ? record.tools : [])
      .filter((row) => row && typeof row.phrase === 'string' && row.phrase !== '')
      .map((row) => ({
        phrase: pickText(localize, typeof row.key === 'string' && row.key !== ''
          ? `office.staff.currentTool.${row.key}`
          : 'office.staff.currentTool.other', row.phrase),
        key: typeof row.key === 'string' ? row.key : null,
        count: Number(row.count) || 0,
      })),
    recent: (Array.isArray(record.recent) ? record.recent : []).map((row) => ({
      kind: typeof row.kind === 'string' ? row.kind : '',
      label: pickText(localize, `office.log.${row.kind}`, ACTIVITY_LOG_LABELS[row.kind] || row.kind || '—'),
      atMs: Number.isFinite(Number(row.atMs)) ? Number(row.atMs) : 0,
      realMs: Number.isFinite(Number(row.realMs)) ? Number(row.realMs) : null,
    })),
  };
}

// Builds the details view model. `employee` is one snapshot employee entry;
// every field read below is on the whitelist. Nothing else is copied.
// P1 English pass: every fixed label rides `localize` (zh fallback) and the VM
// carries the stable keys (`office.employee.<id>` / `office.role.<id>` names
// and roles, `office.details.*` dim fields, `office.outcome.*` results) so the
// page renders per language. Nothing here is derived from runtime text.
function buildDetailsViewModel(employee, localize = null) {
  const markerIsChat = employee.marker === 'chat-ellipsis';
  let primaryText = null;
  let primaryAccessibleLabel = null;
  if (employee.taskLabel) {
    primaryText = pickText(localize, 'office.details.taskActive', employee.taskLabel);
    primaryAccessibleLabel = pickText(localize, 'office.details.taskActiveA11y', '正在执行任务');
  } else if (markerIsChat) {
    primaryText = '…';
    primaryAccessibleLabel = employee.markerLabel
      || pickText(localize, 'office.details.chattingA11y', '正在交流');
  } else if (employee.lastResult) {
    const outcomeKey = employee.lastResult.outcome;
    const outcome = pickText(
      localize,
      `office.outcome.${outcomeKey}`,
      OUTCOME_LABELS[outcomeKey] || '已结束'
    );
    primaryText = pickText(localize, 'office.details.lastResult', '最近结果：{outcome}', { outcome });
    primaryAccessibleLabel = primaryText;
  } else {
    primaryText = activityText(employee, localize);
    primaryAccessibleLabel = primaryText;
  }

  const dimFields = [];
  dimFields.push({
    key: 'office.details.status',
    label: pickText(localize, 'office.details.status', '状态'),
    value: `${activityText(employee, localize)} · ${pickText(localize, `office.runtime.${employee.runtime}`, RUNTIME_LABELS[employee.runtime] || employee.runtime)}`,
    size: 'dim',
  });
  if (employee.lastTool) dimFields.push({ key: 'office.details.lastTool', label: pickText(localize, 'office.details.lastTool', '最近工具'), value: employee.lastTool, size: 'dim' });
  dimFields.push({
    key: 'office.details.binding',
    label: pickText(localize, 'office.details.binding', '绑定'),
    value: employee.binding
      ? pickText(localize, 'office.details.bindingValue', '{source}（置信 {n}）', {
          source: pickText(localize, `office.binding.${employee.binding.source}`, BINDING_SOURCE_LABELS[employee.binding.source] || employee.binding.source),
          n: (employee.binding.confidence ?? 0).toFixed(2),
        })
      : pickText(localize, 'office.details.unbound', '未绑定'),
    size: 'dim',
  });
  dimFields.push({ key: 'office.details.sync', label: pickText(localize, 'office.details.sync', '同步'), value: pickText(localize, `office.sync.${SYNC_KEY_OF[employee.sync] || employee.sync}`, SYNC_LABELS[employee.sync] || employee.sync), size: 'dim' });
  dimFields.push({ key: 'office.details.control', label: pickText(localize, 'office.details.control', '控制'), value: pickText(localize, `office.control.${employee.control}`, CONTROL_LABELS[employee.control] || employee.control), size: 'dim' });
  if (employee.lastResult) {
    dimFields.push({
      key: 'office.details.resultAt',
      label: pickText(localize, 'office.details.resultAt', '结果时间'),
      value: `第 ${Math.round((employee.lastResult.atMs || 0) / 1000)}s`,
      size: 'dim',
    });
  }

  return {
    employeeId: employee.employeeId,
    name: { text: employee.displayName, key: `office.employee.${employee.employeeId}`, size: 'large' },
    roleDot: { text: employee.role, key: `office.role.${employee.employeeId}`, dot: true },
    primary: { text: primaryText, size: 'prominent', accessibleLabel: primaryAccessibleLabel },
    dimFields,
    waiting: (employee.waiting || []).map((item) => ({ position: item.position })),
    queueCount: employee.queueCount || 0,
  };
}

function createOfficePageController({ bridge, onSnapshot = null, reducedMotion = false, renderer = null, localize = null } = {}) {
  if (!bridge || typeof bridge.getState !== 'function') {
    throw new TypeError('createOfficePageController requires a bridge with getState()');
  }

  let snapshot = null;
  let focusIndex = 0;
  let selectedId = null;
  let motionReduced = !!reducedMotion;

  // P1 English pass: the injected localize function (key, fallback, vars) over
  // the shared dictionary + current language. Null keeps the historical
  // zh-only presentation (legacy consumers / tests). The page re-reads the
  // CURRENT language on every call, so a live language switch re-localizes the
  // panel on the next ~10Hz render without rebuilding the controller.
  const L = (key, fallback, vars) => pickText(localize, key, fallback, vars);

  // 2026-09-24 latch fix: the view's renderer state as the module/shell log
  // needs it — mode, stable diagnostic code and the bounded-recovery attempt
  // count. Null when this controller has no renderer attached (legacy callers
  // keep the historical bare-boolean notifyVisibility shape).
  // P2 诊断包（2026-09-26）：追加两个可选遥测字段，ride 同一 visibility invoke，
  // 无新通道——`fps`（观测器最后一次实测帧率，1 位小数）与 `renderProfile`
  // （渲染档位枚举 id）。两者只在渲染器真的给出时才进报告（键不出现，而非
  // undefined 占位——旧调用方的 deepEqual 逐字节不变），坏值绝不打断上报。
  function rendererStateOf() {
    if (!renderer || typeof renderer.diagnostics !== 'function') return null;
    try {
      const diagnostics = renderer.diagnostics();
      const report = {
        mode: diagnostics.mode,
        diagnosticCode: diagnostics.diagnosticCode || null,
        recoveryAttempts: diagnostics.recoveryAttempts || 0,
      };
      if (diagnostics.renderProfile) {
        report.renderProfile = String(diagnostics.renderProfile);
      }
      const stats = diagnostics.fps;
      const lastFps = stats && typeof stats === 'object' ? stats.lastFps : stats;
      if (typeof lastFps === 'number' && Number.isFinite(lastFps) && lastFps >= 0 && lastFps <= 240) {
        report.fps = Math.round(lastFps * 10) / 10;
      }
      return report;
    } catch { return null; }
  }

  function applySnapshot(next) {
    if (!next || !Array.isArray(next.employees)) return;
    snapshot = next;
    if (selectedId && !next.employees.some((employee) => employee.employeeId === selectedId)) {
      selectedId = null;
    }
    focusIndex = Math.min(focusIndex, Math.max(0, next.employees.length - 1));
    if (onSnapshot) {
      try { onSnapshot(next); } catch { /* renderer errors never break the page */ }
    }
  }

  function employees() {
    return snapshot ? snapshot.employees : [];
  }

  function employeeById(id) {
    return employees().find((employee) => employee.employeeId === id) || null;
  }

  return {
    async init() {
      applySnapshot(await bridge.getState());
      return snapshot;
    },

    applySnapshot,

    snapshot: () => snapshot,

    focusOrder: () => employees().map((employee) => employee.employeeId),

    selectedEmployeeId: () => selectedId,

    select(employeeId) {
      if (!employeeById(employeeId)) return false;
      selectedId = employeeId;
      focusIndex = Math.max(0, employees().findIndex((employee) => employee.employeeId === employeeId));
      return true;
    },

    clearSelection() {
      selectedId = null;
      focusIndex = 0;
    },

    detailsFor(employeeId) {
      const employee = employeeById(employeeId);
      return employee ? buildDetailsViewModel(employee, localize) : null;
    },

    /** P4 (spec §3 block 5): the selected employee's 今日工作记录 view model
     * (null when the snapshot carries no record for them). */
    recordFor(employeeId) {
      const employee = employeeById(employeeId);
      return employee ? buildRecordViewModel(employee.record, localize) : null;
    },

    // Keyboard model over the fixed employee order: arrows move a roving
    // focus, Enter/Space select the focused employee, Escape clears.
    handleKey({ key } = {}) {
      const count = employees().length;
      if (count === 0) return { action: 'none' };
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        focusIndex = Math.min(count - 1, focusIndex + 1);
        return { action: 'focus', index: focusIndex };
      }
      if (key === 'ArrowUp' || key === 'ArrowLeft') {
        focusIndex = Math.max(0, focusIndex - 1);
        return { action: 'focus', index: focusIndex };
      }
      if (key === 'Home') {
        focusIndex = 0;
        return { action: 'focus', index: focusIndex };
      }
      if (key === 'End') {
        focusIndex = count - 1;
        return { action: 'focus', index: focusIndex };
      }
      if (key === 'Enter' || key === ' ') {
        const employee = employees()[focusIndex];
        if (!employee) return { action: 'none' };
        selectedId = employee.employeeId;
        return { action: 'select', employeeId: employee.employeeId };
      }
      if (key === 'Escape') {
        selectedId = null;
        return { action: 'clear' };
      }
      return { action: 'none' };
    },

    focusedIndex: () => focusIndex,

    overview() {
      const list = employees();
      return {
        presentCount: list.filter((employee) => employee.presence === 'present').length,
        runningCount: list.filter((employee) => employee.runtime === 'running' || employee.runtime === 'attention').length,
        queuedCount: list.reduce((sum, employee) => sum + (employee.queueCount || 0), 0),
      };
    },

    activityLog() {
      return (snapshot ? snapshot.activityLog : []).map((entry) => ({
        atMs: entry.atMs,
        // P4: the real event instant (null without an injected realClock) so
        // the timeline can show wall-clock times instead of logical ones.
        realMs: Number.isFinite(entry.realMs) ? entry.realMs : null,
        employeeId: entry.employeeId,
        kind: entry.kind,
        // The stable kind is the label key (office.log.<kind>); the zh table
        // stays the fallback.
        label: L(`office.log.${entry.kind}`, ACTIVITY_LOG_LABELS[entry.kind] || entry.kind),
        // P2 per-turn attribution: present only when the turn carried a
        // provider usage record (module-stamped; null otherwise — never
        // estimated). Numbers only; the money is the same local-rate
        // estimate the §4 usage block uses.
        turnUsage: entry.turnUsage ? { ...entry.turnUsage } : null,
        turnCost: Number.isFinite(entry.turnCost) ? entry.turnCost : null,
        turnDurationMs: Number.isFinite(entry.turnDurationMs) ? entry.turnDurationMs : null,
      }));
    },

    // P2 §3 block 1: today's usage view model. Null while the shell has no
    // usage data yet (the snapshot stays honest instead of showing zeros).
    usageView() {
      const usage = snapshot ? snapshot.usage : null;
      if (!usage) return null;
      return {
        dayKey: usage.dayKey,
        tokensTotal: usage.tokens.total,
        tokensInput: usage.tokens.input,
        tokensOutput: usage.tokens.output,
        tokensCacheRead: usage.tokens.cacheRead,
        moneyPaid: usage.money.paid,
        currency: usage.money.currency,
        savingsCacheRead: usage.savings.cacheRead,
        savingsLocalModel: usage.savings.localModel,
        savingsLocalModelBasis: usage.savings.localModelBasis,
        budgetKind: usage.budget.kind,
        budgetLimit: usage.budget.limit,
        budgetUsed: usage.budget.used,
        pricingBasis: usage.pricingBasis,
        pricingBasisLabel: L(`office.usage.basis.${BASIS_KEY_OF[usage.pricingBasis] || usage.pricingBasis}`, USAGE_BASIS_LABELS[usage.pricingBasis] || USAGE_BASIS_LABELS['api-key']),
        staleAt: usage.staleAt,
      };
    },

    // P2 §3 block 2: one view-model row per employee (snapshot whitelist
    // fields only). `needsYou` is the count of live pending items addressed
    // to this employee (the "需要你" badge).
    // P1 English pass: `statusKey` is the STABLE badge key (chatting employees
    // in chatPhase 'walking' key to the intermediate 'chat-walking' — 闲聊 only
    // once both members are seated, matching when bubbles appear); the name /
    // role keys are the fixed employee vocabulary (office.employee.* /
    // office.role.*); the task title and queue badge resolve per language.
    staffRows() {
      const pending = snapshot && Array.isArray(snapshot.pending) ? snapshot.pending : [];
      return employees().map((employee) => {
        const bound = !!employee.binding;
        const statusKey = activityKeyOf(employee);
        return {
          employeeId: employee.employeeId,
          nameKey: `office.employee.${employee.employeeId}`,
          roleKey: `office.role.${employee.employeeId}`,
          displayName: employee.displayName,
          role: employee.role,
          statusKey,
          statusLabel: L(`office.status.${statusKey}`, STAFF_STATUS_LABELS[statusKey] || activityText(employee, localize)),
          // De-identified title: a per-employee task counter (任务 #N),
          // visible only while a task is bound. Never runtime text.
          taskTitle: bound && employee.taskSeq > 0 ? L('office.staff.taskTitle', '任务 #{n}', { n: employee.taskSeq }) : null,
          // Current tool phrase (shared tool-phrases module via the
          // snapshot); shown only while a task is bound. The stable
          // office.staff.currentTool.* key rides the snapshot (toolPhraseKey,
          // module-computed) so the phrase renders per language.
          toolPhrase: bound && employee.toolPhrase
            ? L(employee.toolPhraseKey
                ? `office.staff.currentTool.${employee.toolPhraseKey}`
                : 'office.staff.currentTool.other', employee.toolPhrase)
            : null,
          queueCount: employee.queueCount || 0,
          needsYou: pending.filter((item) => item.employeeId === employee.employeeId).length,
          selected: employee.employeeId === selectedId,
        };
      });
    },

    // P2 §3 block 3: the "待你处理" inbox CONTAINER and its count. P3 adds the
    // actions below: inline approve/reject (low/medium), the danger modal
    // (high) and the question form — all answered through the shared
    // respondToRuntime ($events/result) path over office:pending.
    pendingSummary() {
      const pending = snapshot && Array.isArray(snapshot.pending) ? snapshot.pending : [];
      return {
        count: pending.length,
        items: pending.map((item) => ({
          id: item.id,
          kind: item.kind,
          employeeId: item.employeeId,
          toolName: item.toolName,
          summary: item.summary,
          // P1 English pass: the stable office.staff.currentTool.* key behind
          // the fixed summary phrase (module-projected); the page renders the
          // summary per language from it. Null for fixture items without one.
          summaryKey: typeof item.summaryKey === 'string' ? item.summaryKey : null,
          risk: item.risk,
          createdAtMs: item.createdAtMs,
        })),
      };
    },

    /** P3: answer a pending request through the shared runtime answer path
     * (office:pending {action:'answer'} → module.answerPending →
     * respondToRuntime → $events/result; the SAME implementation the IM
     * channel answers with). The value is the harness outcome word
     * ('allowed-once' | 'rejected') for approvals, or the answers batch for
     * questions. On success the item disappears from the next snapshot
     * (module-side removal), so the panel and IM can never disagree. */
    async answerPending(id, value) {
      if (typeof bridge.pending !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      return bridge.pending({ action: 'answer', id, value });
    },

    /** P3: fetch the spec §4 detailRef payload (real tool arguments /
     * question body resolved by main.js). Called when the user opens the
     * danger modal or the question form — never on the snapshot cadence. */
    async pendingDetail(id) {
      if (typeof bridge.pending !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      return bridge.pending({ action: 'detail', id });
    },

    /** P3: the danger-modal / question-form view model for one pending card. */
    pendingModalModel(item, detail) {
      return buildPendingModalModel({ item, detail, localize });
    },

    accessibleLabelFor(employeeId) {
      const employee = employeeById(employeeId);
      if (!employee) return { label: '' };
      // P2: the de-identified task title and the current tool phrase ride the
      // label (both are snapshot presentation fields — no runtime text).
      // P1 English pass: labels resolve per language; the list separator is a
      // dictionary key too (zh '，' vs en ', ').
      const parts = [
        L(`office.employee.${employee.employeeId}`, employee.displayName),
        activityText(employee, localize),
        employee.binding && employee.taskSeq > 0 ? L('office.staff.taskA11y', '任务 {n}', { n: employee.taskSeq }) : null,
        employee.binding && employee.toolPhrase
          ? L(employee.toolPhraseKey
              ? `office.staff.currentTool.${employee.toolPhraseKey}`
              : 'office.staff.currentTool.other', employee.toolPhrase)
          : null,
        employee.queueCount > 0 ? L('office.staff.queue', '排队 {n}', { n: employee.queueCount }) : null,
      ].filter(Boolean);
      return { label: `${parts.join(L('office.panel.listSep', '，'))}` };
    },

    capabilities: () => (snapshot ? snapshot.capabilities : null),

    sync: () => (snapshot ? snapshot.sync : 'healthy'),

    reducedMotion: () => motionReduced,

    async setReducedMotion(value) {
      motionReduced = !!value;
      if (typeof bridge.updateSettings === 'function') {
        await bridge.updateSettings({ reducedMotion: motionReduced });
      }
      return motionReduced;
    },

    // 2026-09-24 latch fix (SPEC-07 correction): the office:visibility payload
    // carries TWO different flags — `visible` (the window is visible and not
    // minimized) and `active` (the office is the current main-area view).
    //   - `visible` pauses the main-process simulation clock (unchanged);
    //   - `active` gates the renderer's frame pump and triggers the bounded
    //     LOW_FPS_PERSISTENT recovery: a detached view still presents frames,
    //     but only at background rate (~1.3-7.9 fps), which is exactly the
    //     state that used to latch the FPS monitor and kill the scene.
    // A bare boolean keeps the historical window-visibility-only semantics
    // (no `active` information available; the pump gate is left untouched).
    handleVisibility(visible) {
      const payload = visible !== null && typeof visible === 'object' ? visible : { visible: !!visible };
      const windowVisible = !!payload.visible;
      if (typeof payload.active === 'boolean' && renderer && typeof renderer.setVisible === 'function') {
        // setVisible may kick off an async bounded-recovery rebuild; it never
        // rejects, but the page does not await it either way.
        try { Promise.resolve(renderer.setVisible(payload.active)).catch(() => {}); } catch { /* renderer errors never break the page */ }
      }
      // 2026-09-25 唤醒自愈: the push payload's `presenting` flag (the
      // main-process powerMonitor lock/sleep/suspend signals, window-manager
      // relayed) drives the renderer's measurement gate AND the wake
      // auto-heal: while false the observer measures nothing and consumes no
      // budget; the false→true edge attempts one bounded rebuild if the view
      // sits in the LOW_FPS_PERSISTENT static diagnostic. Absent (legacy
      // callers) touches nothing — the same backward-compat rule as `active`.
      if (typeof payload.presenting === 'boolean' && renderer && typeof renderer.setPresenting === 'function') {
        try { Promise.resolve(renderer.setPresenting(payload.presenting)).catch(() => {}); } catch { /* renderer errors never break the page */ }
      }
      if (typeof bridge.notifyVisibility === 'function') {
        bridge.notifyVisibility(windowVisible, rendererStateOf());
      }
    },

    async dispatch(employeeId, text) {
      if (typeof bridge.dispatch !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      // 2026-09-25 UX 必修（B1）：追加任务带正文（session/prompt steer 的内容）。
      return bridge.dispatch({ employeeId, text });
    },

    async cancel(employeeId) {
      if (typeof bridge.cancel !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      return bridge.cancel({ employeeId });
    },

    async interrupt(employeeId) {
      if (typeof bridge.interrupt !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      return bridge.interrupt({ employeeId });
    },
  };
}

module.exports = {
  createOfficePageController,
  buildDetailsViewModel,
  buildRecordViewModel,
  buildPendingModalModel,
  PENDING_MODAL_TEXT,
  PENDING_FAIL_KEY_OF,
  pendingFailureView,
  RECORD_TEXT,
  ACTIVITY_LABELS,
  ACTIVITY_LOG_LABELS,
  STAFF_STATUS_LABELS,
  USAGE_BASIS_LABELS,
  formatCount,
  formatMoney,
  formatDuration,
  formatClock,
};
