'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUsage,
  normalizeCost,
  buildAutomationSummary,
  runtimeState,
  buildSnapshot,
} = require('../src/cockpit-snapshot');

const usage = {
  current: { input: 14800, output: 3400, cacheRead: 8100, cacheWrite: 0 },
  totals: { input: 14800, output: 3400, cacheRead: 8100, cacheWrite: 0 },
  sessionCount: 2,
};

test('normalizes usage pressure against a context window', () => {
  const out = normalizeUsage(usage, 64000);
  assert.equal(out.contextWindow, 64000);
  assert.equal(out.pressureTokens, 22900);
  assert.equal(out.pressurePct, 36);
  assert.equal(out.sessionCount, 2);
});

test('normalizes cost fields and budget status', () => {
  const out = normalizeCost({
    today: { cost: 0.82, input: 10, output: 4, cacheRead: 2, cacheWrite: 0, sessions: 1 },
    month: { cost: 82, input: 100, output: 40, cacheRead: 20, cacheWrite: 0, sessions: 4 },
    currency: '¥',
  }, 100);
  assert.equal(out.today.cost, 0.82);
  assert.equal(out.month.cost, 82);
  assert.equal(out.currency, '¥');
  assert.equal(out.budget, 100);
  assert.equal(out.budgetStatus, 'warn');
  assert.equal(normalizeCost(null, 100), null);
});

test('automation status prioritizes running and recent failure, converts timestamps, and caps items', () => {
  const now = Date.parse('2026-08-19T12:00:00Z');
  const tasks = [
    { id: 'running', name: 'Run', enabled: true, nextRunAt: now + 100000 },
    { id: 'failed', name: 'Fail', enabled: true, nextRunAt: now + 200000 },
    { id: 'scheduled', name: 'Later', enabled: true, nextRunAt: now + 300000 },
    { id: 'done', name: 'Done', enabled: true },
    { id: 'disabled', name: 'Off', enabled: false },
  ];
  const history = [
    { taskId: 'failed', name: 'Fail', ok: false, startedAt: '2026-08-19T11:00:00Z', finishedAt: '2026-08-19T11:01:00Z' },
    { taskId: 'done', name: 'Done', ok: true, startedAt: '2026-08-18T11:00:00Z', finishedAt: '2026-08-18T11:01:00Z' },
    { taskId: 'old-fail', name: 'Old', ok: false, startedAt: '2026-08-17T10:00:00Z', finishedAt: '2026-08-17T10:01:00Z' },
  ];
  const out = buildAutomationSummary(tasks, history, new Set(['running']), now, { limit: 5 });
  const byId = new Map(out.items.map((x) => [x.id, x]));
  assert.equal(out.running, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.scheduled, 1);
  assert.equal(out.completed, 1);
  assert.equal(byId.get('running').state, 'running');
  assert.equal(byId.get('failed').state, 'failed');
  assert.equal(byId.get('scheduled').state, 'scheduled');
  assert.equal(byId.get('done').state, 'completed');
  assert.equal(byId.get('failed').lastRunAt, Date.parse('2026-08-19T11:01:00Z'));
  assert.equal(byId.get('scheduled').nextRunAt, now + 300000);
  assert.equal(buildAutomationSummary(tasks, history, new Set(['running']), now).items.length, 3);
});

test('runtime state distinguishes starting, restarting, healthy, and offline', () => {
  assert.equal(runtimeState({ state: 'starting', child: false, url: null }), 'starting');
  assert.equal(runtimeState({ state: 'restarting', child: true, url: 'http://127.0.0.1:1' }), 'restarting');
  assert.equal(runtimeState({ state: 'healthy', child: false, url: null }), 'healthy');
  assert.equal(runtimeState({ state: 'offline', child: true, url: 'http://127.0.0.1:1' }), 'offline');
  assert.equal(runtimeState({ child: false, url: null, restarting: false }), 'offline');
  assert.equal(runtimeState({ child: true, url: null, restarting: false }), 'starting');
  assert.equal(runtimeState({ child: true, url: 'http://127.0.0.1:1', restarting: true }), 'restarting');
  assert.equal(runtimeState({ child: true, url: 'http://127.0.0.1:1', restarting: false }), 'healthy');
});

test('buildSnapshot isolates failed sections and includes shell identity', () => {
  const out = buildSnapshot({
    runtime: { child: false, url: null, restarting: false, version: null, activeVersion: null },
    usageError: true,
    usage: null,
    contextWindow: 64000,
    costError: true,
    cost: null,
    tasks: [],
    history: [],
    running: [],
    remote: null,
    shell: { version: '0.2.4', language: 'zh', theme: 'dark', needsSetup: true, onboardingComplete: false },
    now: Date.now(),
  });
  assert.equal(out.usage, null);
  assert.equal(out.cost, null);
  assert.deepEqual(out.remote, { enabled: false, running: false, publicMode: 'lan' });
  assert.equal(out.runtime.state, 'offline');
  assert.equal(out.shell.version, '0.2.4');
});
