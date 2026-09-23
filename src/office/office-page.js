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
// (inbox container + count only; inline actions are P3) and the timeline rows
// with their per-turn token attribution (turnUsage/turnCost/turnDurationMs,
// stamped by the module from first-hand provider usage records).

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

function activityLabel(activity) {
  return ACTIVITY_LABELS[activity] || '在岗';
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

    // P2 §3 block 3: the "待你处理" inbox CONTAINER and its count only —
    // inline approve/reject and the danger modal are P3 (spec §8).
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
  ACTIVITY_LABELS,
  ACTIVITY_LOG_LABELS,
  STAFF_STATUS_LABELS,
  USAGE_BASIS_LABELS,
  formatCount,
  formatMoney,
  formatDuration,
};
