'use strict';

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function epoch(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function usageTotals(value) {
  const v = value || {};
  return {
    input: number(v.input),
    output: number(v.output),
    cacheRead: number(v.cacheRead),
    cacheWrite: number(v.cacheWrite),
  };
}

function normalizeUsage(value, contextWindow) {
  if (!value) return null;
  const current = value.current ? usageTotals(value.current) : null;
  const totals = usageTotals(value.totals);
  const window = Math.max(1, number(contextWindow, 128000));
  const pressureSource = value.current && value.current.lastUsage ? usageTotals(value.current.lastUsage) : current;
  const pressureTokens = pressureSource
    ? pressureSource.input + pressureSource.cacheRead + pressureSource.cacheWrite
    : 0;
  return {
    current,
    totals,
    contextWindow: window,
    pressureTokens,
    pressurePct: Math.min(100, Math.max(0, Math.round((pressureTokens / window) * 100))),
    sessionCount: Math.max(0, Math.floor(number(value.sessionCount))),
  };
}

function summary(value) {
  const v = value || {};
  return {
    cost: number(v.cost),
    input: number(v.input),
    output: number(v.output),
    cacheRead: number(v.cacheRead),
    cacheWrite: number(v.cacheWrite),
    sessions: Math.max(0, Math.floor(number(v.sessions))),
  };
}

function normalizeCost(value, budget) {
  if (!value) return null;
  const month = summary(value.month);
  const configured = Math.max(0, number(budget));
  let budgetStatus = 'disabled';
  if (configured > 0) budgetStatus = month.cost >= configured ? 'exceed' : month.cost >= configured * 0.8 ? 'warn' : 'ok';
  return {
    today: summary(value.today),
    month,
    currency: typeof value.currency === 'string' && value.currency ? value.currency : '¥',
    budget: configured,
    budgetStatus,
  };
}

function latestHistoryByTask(history) {
  const latest = new Map();
  for (const raw of Array.isArray(history) ? history : []) {
    if (!raw || typeof raw.taskId !== 'string') continue;
    const finishedAt = epoch(raw.finishedAt) ?? epoch(raw.startedAt) ?? 0;
    const prev = latest.get(raw.taskId);
    if (!prev || finishedAt >= prev.finishedAt) latest.set(raw.taskId, { ...raw, finishedAt });
  }
  return latest;
}

function buildAutomationSummary(tasks, history, runningIds, now = Date.now(), options) {
  const latest = latestHistoryByTask(history);
  const running = runningIds instanceof Set ? runningIds : new Set(runningIds || []);
  const rows = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const id = String(task.id || '');
    const last = latest.get(id) || null;
    const recentFailure = !!(last && last.ok === false && now - last.finishedAt <= 86_400_000);
    let state;
    if (running.has(id)) state = 'running';
    else if (recentFailure) state = 'failed';
    else if (task.enabled !== false && epoch(task.nextRunAt) != null && epoch(task.nextRunAt) > now) state = 'scheduled';
    else if (last && last.ok === true) state = 'completed';
    else state = 'disabled';
    return {
      id,
      name: typeof task.name === 'string' && task.name ? task.name : id,
      state,
      nextRunAt: epoch(task.nextRunAt),
      lastRunAt: last ? last.finishedAt : epoch(task.lastRunAt),
    };
  });
  const rank = { running: 0, failed: 1, scheduled: 2, completed: 3, disabled: 4 };
  rows.sort((a, b) => rank[a.state] - rank[b.state]
    || ((a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER))
    || a.name.localeCompare(b.name));
  const failed = rows.filter((r) => r.state === 'failed').length;
  const completed = rows.filter((r) => r.state === 'completed').length;
  const limit = Number.isFinite(options && options.limit) ? Math.max(0, options.limit) : 3;
  return {
    running: rows.filter((r) => r.state === 'running').length,
    scheduled: rows.filter((r) => r.state === 'scheduled').length,
    completed,
    failed,
    items: rows.slice(0, limit),
  };
}

function runtimeState(value) {
  const v = value || {};
  if (['starting', 'healthy', 'restarting', 'offline'].includes(v.state)) return v.state;
  if (v.restarting) return 'restarting';
  if (!v.child) return 'offline';
  if (!v.url) return 'starting';
  return 'healthy';
}

function buildSnapshot(input) {
  const v = input || {};
  const now = number(v.now, Date.now());
  return {
    runtime: {
      state: runtimeState(v.runtime),
      version: v.runtime && typeof v.runtime.version === 'string' ? v.runtime.version : null,
      activeVersion: v.runtime && typeof v.runtime.activeVersion === 'string' ? v.runtime.activeVersion : null,
    },
    usage: v.usageError ? null : normalizeUsage(v.usage, v.contextWindow),
    cost: v.costError ? null : normalizeCost(v.cost, v.monthlyBudget),
    automation: buildAutomationSummary(v.tasks, v.history, new Set(v.running || []), now),
    remote: v.remote && typeof v.remote === 'object'
      ? { enabled: !!v.remote.enabled, running: !!v.remote.running, publicMode: ['lan', 'tailscale', 'cloudflare'].includes(v.remote.publicMode) ? v.remote.publicMode : 'lan' }
      : { enabled: false, running: false, publicMode: 'lan' },
    shell: {
      version: String(v.shell && v.shell.version || ''),
      language: v.shell && v.shell.language === 'en' ? 'en' : 'zh',
      theme: v.shell && v.shell.theme === 'light' ? 'light' : 'dark',
      needsSetup: !!(v.shell && v.shell.needsSetup),
      onboardingComplete: !!(v.shell && v.shell.onboardingComplete),
    },
  };
}

module.exports = {
  normalizeUsage,
  normalizeCost,
  buildAutomationSummary,
  runtimeState,
  buildSnapshot,
};
