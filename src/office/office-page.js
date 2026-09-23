'use strict';

// src/office/office-page.js — Task 7 / SPEC-07.
//
// Headless controller for the Office HTML page: it owns the derived view
// model (details hierarchy, overview counts, queue badges, activity log),
// the keyboard/pointer selection model and the reduced-motion/visibility
// plumbing. Pure CommonJS with an injected `bridge` — the page passes the
// office-preload bridge, tests pass a stub. No DOM, Pixi, Electron or
// Harness access in here; the renderer consumes snapshots from the same
// source (office:state), never the other way around.
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

const ACTIVITY_LABELS = Object.freeze({
  roaming: '漫游中',
  chatting: '交流中',
  resting: '休息中',
  sleeping: '小憩中',
  working: '工作中',
  thinking: '思考中',
  waiting: '等待中',
  celebrating: '庆祝中',
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
// back to the activity label above.
const STAFF_STATUS_LABELS = Object.freeze({
  working: '工作',
  roaming: '巡游',
  chatting: '闲聊',
  resting: '休息',
  sleeping: '小憩',
  thinking: '思考',
  waiting: '等待',
  celebrating: '庆祝',
});

// P2 usage block (spec §3 block 1 / §6 i18n): the zh texts mirror the shell
// dictionary keys office.usage.* (the page keeps its historical zh-only
// convention — the shared tool phrase already rides the snapshot through the
// same family). pricingBasis markers are the §4 contract vocabulary.
const USAGE_BASIS_LABELS = Object.freeze({
  'api-key': '按 API Key 用量估算（本地速率）',
  subscription: '订阅套餐（金额仅供参考）',
});

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

/** Compact token count: 千 / 万 (百万 rides 万), original value on hover. */
function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
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

function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] || '在岗';
}

/** P3: the danger-modal (and question-form) view model, built from the pending
 * card item plus its spec §4 detailRef payload. `item` is a pendingSummary()
 * row; `detail` is the office:pending {action:'detail'} response (or null when
 * the resolver found nothing). Every field is presentation-only — the raw
 * command/question text comes from the main-process detail resolver, which
 * normalizes it through the module allowlist; nothing here invents data: when
 * the harness exposed no tool arguments the model says so instead of
 * fabricating a command. */
function buildPendingModalModel({ item, detail }) {
  const d = detail && typeof detail === 'object' ? detail : null;
  const approval = !item || item.kind !== 'question';
  const hasCommand = !!(d && typeof d.command === 'string' && d.command !== '');
  const noToolArguments = approval && !hasCommand;
  const steps = [];
  if (approval) {
    steps.push(d && typeof d.reason === 'string' && d.reason !== ''
      ? d.reason
      : `${(item && item.toolName) || 'harness'} 工具的执行请求`);
  }
  let impact;
  if (d && typeof d.requestedSandboxMode === 'string' && d.requestedSandboxMode) {
    // The ONE place the sandbox axis is observable: a real widening request
    // names the target mode in its reason.
    impact = PENDING_MODAL_TEXT.escalate(d.requestedSandboxMode);
  } else {
    // P4-R1: the agent preset is NOT a sandbox tier (different axis; see the
    // PENDING_MODAL_TEXT header). Guessing one from it is exactly the inaccuracy
    // this correction removes — the panel states that the sandbox mode is not
    // projected instead.
    impact = PENDING_MODAL_TEXT.sandboxUnprojected;
  }
  const targetPath = d && typeof d.targetPath === 'string' && d.targetPath !== '' ? d.targetPath : null;
  return {
    approval,
    risk: item ? item.risk : null,
    title: approval ? PENDING_MODAL_TEXT.title : PENDING_MODAL_TEXT.questionTitle,
    toolName: item ? item.toolName : null,
    summary: item ? item.summary : null,
    // P4-R1: the AGENT composition preset (agent-presets axis, e.g. `standard`)
    // — shown verbatim as 「Agent 预设」; NOT a sandbox tier, never mapped to
    // one. Null when the session carries no agent preset (the row is omitted).
    agentPreset: d && typeof d.preset === 'string' && d.preset !== '' ? d.preset : null,
    steps,
    impact,
    // 目标路径或命令原文（若有）: the REAL arguments when main.js correlated the
    // same-turn tool/call by callId; otherwise the honest "not exposed" note.
    command: hasCommand ? d.command : null,
    commandSource: d && typeof d.commandSource === 'string' ? d.commandSource : null,
    targetPath,
    noToolArguments,
    noArgsNote: noToolArguments ? PENDING_MODAL_TEXT.noArgs : null,
    noAlwaysNote: approval ? PENDING_MODAL_TEXT.noAlways : null,
    blockedNote: PENDING_MODAL_TEXT.blocked,
    // 可否撤销: the harness seam carries no undo information (no such field in
    // the approval request), so the modal states that plainly rather than
    // guessing — the safe reading is "treat as irreversible".
    reversibleNote: PENDING_MODAL_TEXT.reversibleUnknown,
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
function buildRecordViewModel(record) {
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
    tools: (Array.isArray(record.tools) ? record.tools : [])
      .filter((row) => row && typeof row.phrase === 'string' && row.phrase !== '')
      .map((row) => ({ phrase: row.phrase, count: Number(row.count) || 0 })),
    recent: (Array.isArray(record.recent) ? record.recent : []).map((row) => ({
      kind: typeof row.kind === 'string' ? row.kind : '',
      label: ACTIVITY_LOG_LABELS[row.kind] || row.kind || '—',
      atMs: Number.isFinite(Number(row.atMs)) ? Number(row.atMs) : 0,
      realMs: Number.isFinite(Number(row.realMs)) ? Number(row.realMs) : null,
    })),
  };
}

// Builds the details view model. `employee` is one snapshot employee entry;
// every field read below is on the whitelist. Nothing else is copied.
function buildDetailsViewModel(employee) {
  const markerIsChat = employee.marker === 'chat-ellipsis';
  let primaryText = null;
  let primaryAccessibleLabel = null;
  if (employee.taskLabel) {
    primaryText = employee.taskLabel;
    primaryAccessibleLabel = '正在执行任务';
  } else if (markerIsChat) {
    primaryText = '…';
    primaryAccessibleLabel = employee.markerLabel || '正在交流';
  } else if (employee.lastResult) {
    const outcome = OUTCOME_LABELS[employee.lastResult.outcome] || '已结束';
    primaryText = `最近结果：${outcome}`;
    primaryAccessibleLabel = primaryText;
  } else {
    primaryText = activityLabel(employee.activity);
    primaryAccessibleLabel = primaryText;
  }

  const dimFields = [];
  dimFields.push({ label: '状态', value: `${activityLabel(employee.activity)} · ${RUNTIME_LABELS[employee.runtime] || employee.runtime}`, size: 'dim' });
  if (employee.lastTool) dimFields.push({ label: '最近工具', value: employee.lastTool, size: 'dim' });
  dimFields.push({
    label: '绑定',
    value: employee.binding ? `${BINDING_SOURCE_LABELS[employee.binding.source] || employee.binding.source}（置信 ${(employee.binding.confidence ?? 0).toFixed(2)}）` : '未绑定',
    size: 'dim',
  });
  dimFields.push({ label: '同步', value: SYNC_LABELS[employee.sync] || employee.sync, size: 'dim' });
  dimFields.push({ label: '控制', value: CONTROL_LABELS[employee.control] || employee.control, size: 'dim' });
  if (employee.lastResult) {
    dimFields.push({ label: '结果时间', value: `第 ${Math.round((employee.lastResult.atMs || 0) / 1000)}s`, size: 'dim' });
  }

  return {
    employeeId: employee.employeeId,
    name: { text: employee.displayName, size: 'large' },
    roleDot: { text: employee.role, dot: true },
    primary: { text: primaryText, size: 'prominent', accessibleLabel: primaryAccessibleLabel },
    dimFields,
    waiting: (employee.waiting || []).map((item) => ({ position: item.position })),
    queueCount: employee.queueCount || 0,
  };
}

function createOfficePageController({ bridge, onSnapshot = null, reducedMotion = false } = {}) {
  if (!bridge || typeof bridge.getState !== 'function') {
    throw new TypeError('createOfficePageController requires a bridge with getState()');
  }

  let snapshot = null;
  let focusIndex = 0;
  let selectedId = null;
  let motionReduced = !!reducedMotion;

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
      return employee ? buildDetailsViewModel(employee) : null;
    },

    /** P4 (spec §3 block 5): the selected employee's 今日工作记录 view model
     * (null when the snapshot carries no record for them). */
    recordFor(employeeId) {
      const employee = employeeById(employeeId);
      return employee ? buildRecordViewModel(employee.record) : null;
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
        label: ACTIVITY_LOG_LABELS[entry.kind] || entry.kind,
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
        pricingBasisLabel: USAGE_BASIS_LABELS[usage.pricingBasis] || USAGE_BASIS_LABELS['api-key'],
        staleAt: usage.staleAt,
      };
    },

    // P2 §3 block 2: one view-model row per employee (snapshot whitelist
    // fields only). `needsYou` is the count of live pending items addressed
    // to this employee (the "需要你" badge).
    staffRows() {
      const pending = snapshot && Array.isArray(snapshot.pending) ? snapshot.pending : [];
      return employees().map((employee) => {
        const bound = !!employee.binding;
        return {
          employeeId: employee.employeeId,
          displayName: employee.displayName,
          role: employee.role,
          statusLabel: STAFF_STATUS_LABELS[employee.activity] || activityLabel(employee.activity),
          statusKey: employee.activity,
          // De-identified title: a per-employee task counter (任务 #N),
          // visible only while a task is bound. Never runtime text.
          taskTitle: bound && employee.taskSeq > 0 ? `任务 #${employee.taskSeq}` : null,
          // Current tool phrase (shared tool-phrases module via the
          // snapshot); shown only while a task is bound.
          toolPhrase: bound && employee.toolPhrase ? employee.toolPhrase : null,
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
      return buildPendingModalModel({ item, detail });
    },

    accessibleLabelFor(employeeId) {
      const employee = employeeById(employeeId);
      if (!employee) return { label: '' };
      // P2: the de-identified task title and the current tool phrase ride the
      // label (both are snapshot presentation fields — no runtime text).
      const parts = [
        employee.displayName,
        activityLabel(employee.activity),
        employee.binding && employee.taskSeq > 0 ? `任务 ${employee.taskSeq}` : null,
        employee.binding && employee.toolPhrase ? employee.toolPhrase : null,
        employee.queueCount > 0 ? `排队 ${employee.queueCount}` : null,
      ].filter(Boolean);
      return { label: `${parts.join('，')}` };
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

    handleVisibility(visible) {
      if (typeof bridge.notifyVisibility === 'function') bridge.notifyVisibility(!!visible);
    },

    async dispatch(employeeId) {
      if (typeof bridge.dispatch !== 'function') return { ok: false, code: 'BRIDGE_MISSING' };
      return bridge.dispatch({ employeeId });
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
