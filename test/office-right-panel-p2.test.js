'use strict';

// test/office-right-panel-p2.test.js — P2 structure rework contract tests
// for the office right-panel rework (docs/strategy/
// 2026-09-23-office-right-panel-spec.md §3 信息架构 / §4 数据契约 / §7 测试
// 计划 / §8 P2 行).
//
// Covers, module-layer only (no Electron):
//   - per-turn token attribution: the 0.1.5 assistant/message `data.usage`
//     record (first-hand provider usage) translated through main.js +
//     runtime-adapter into `runtime/usage` facts, accrued per turn in the
//     office module and stamped onto the turn's task-started + result
//     activity-log entries (tokens + money estimate + duration). A turn with
//     no provider accounting stays unattributed; concurrent sessions never
//     mix accounting (keyed by the turn-scoped binding handle).
//   - the adapter maps turn/usage -> runtime/usage with ONLY the numbers
//     (the payload survives the shared privacy redactor).
//   - main.js translation layer: assistant/message -> turn/usage, message
//     text never forwarded, zero buckets dropped, cost priced at the same
//     local rates as the §4 usage block (priceUsageAt).
//   - employee snapshot presentation whitelist: toolPhrase (shared
//     tool-phrases module) + taskSeq (de-identified 任务 #N).
//   - page controller view models: staffRows (status badge / de-identified
//     title / tool phrase / 需要你), pendingSummary (container count),
//     usageView, activityLog turn passthrough, formatters.
//   - static source contracts: the six IA blocks in office.html, the removed
//     development-period texts, the throttle ordering, the preload theme
//     surface and the dark-theme CSS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const officeModule = require('../src/office/office-module.js');
const { createRuntimeAdapter } = require('../src/office/runtime/runtime-adapter.js');
const { createPrivacyRedactor } = require('../src/office/runtime/privacy-redactor.js');
const { buildOfficeUsage, priceUsageAt } = require('../src/office/runtime/usage-snapshot.js');
const officePage = require('../src/office/office-page.js');
const phrases = require('../src/office/runtime/tool-phrases.js');
const { STRINGS } = require('../src/i18n.js');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function makeModule(overrides = {}) {
  return officeModule.createOfficeModule({
    seed: 'office-right-panel-p2-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    ...overrides,
  });
}

/** Drive one full turn: running -> tool call -> usage -> completed. */
function driveTurn(mod, sessionId, { tool = 'bash', usage, cost = 0, startSeq = 1 }) {
  mod.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: startSeq, time: startSeq, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: startSeq + 1, time: startSeq + 1, data: { tool } });
  if (usage) {
    mod.ingestHarnessEvent({
      sessionId, type: 'turn/usage', seq: startSeq + 2, time: startSeq + 2,
      data: { turn: 1, usage, cost },
    });
  }
  mod.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: startSeq + 3, time: startSeq + 3, data: { turn: 1, reason: 'completed' } });
}

/** Harvest every activity-log entry the module ever produced. */
function harvestLog(mod) {
  const seen = new Set();
  const out = [];
  for (const entry of mod.state().activityLog) {
    const key = `${entry.atMs}:${entry.employeeId}:${entry.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

const TURN_USAGE_FIXTURE = { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 };

// ---------------------------------------------------------------------------
// per-turn token attribution — the first-hand provider usage record
// ---------------------------------------------------------------------------

test('timeline attribution: a completed turn stamps usage onto its start and result rows', () => {
  const mod = makeModule();
  driveTurn(mod, 'sess-turn-1', { usage: TURN_USAGE_FIXTURE, cost: 0.0123 });
  const log = harvestLog(mod);
  const started = log.find((e) => e.kind === 'task-started');
  const done = log.find((e) => e.kind === 'result-completed');
  assert.ok(started && done, 'both turn boundary rows exist');
  for (const entry of [started, done]) {
    assert.deepEqual(entry.turnUsage, {
      input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0, total: 4600,
    }, 'the provider usage record rides the row');
    assert.equal(entry.turnCost, 0.0123, 'the per-turn money estimate rides the row');
    assert.ok(Number.isFinite(entry.turnDurationMs) && entry.turnDurationMs >= 0, 'the duration is non-negative');
  }
});

test('timeline attribution: a cancelled turn still stamps its usage', () => {
  const mod = makeModule();
  mod.ingestHarnessEvent({ sessionId: 'sess-cancel-1', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId: 'sess-cancel-1', type: 'turn/usage', seq: 2, time: 2, data: { turn: 1, usage: TURN_USAGE_FIXTURE, cost: 0.01 } });
  mod.ingestHarnessEvent({ sessionId: 'sess-cancel-1', type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: 'aborted' } });
  const log = harvestLog(mod);
  const cancelled = log.find((e) => e.kind === 'result-cancelled');
  assert.ok(cancelled, 'the cancelled terminal row exists');
  assert.equal(cancelled.turnUsage.total, 4600, 'the cancelled turn keeps its accounting');
});

test('timeline attribution: a turn with no provider usage stays unattributed (no invented numbers)', () => {
  const mod = makeModule();
  driveTurn(mod, 'sess-no-usage', { usage: null });
  const log = harvestLog(mod);
  for (const entry of log) {
    assert.equal(entry.turnUsage, undefined, `${entry.kind} carries no turn usage`);
    assert.equal(entry.turnCost, undefined);
  }
  // a zero bucket is dropped upstream (adapter) — same observable result
  const mod2 = makeModule();
  driveTurn(mod2, 'sess-zero-usage', { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  for (const entry of harvestLog(mod2)) {
    assert.equal(entry.turnUsage, undefined, 'zero usage never stamps');
  }
});

/** Tick the logical clock until no employee holds a binding (result
 * presentation flushed), or give up after a bounded number of ticks. */
function tickUntilReleased(mod, maxTicks = 4000) {
  for (let i = 0; i < maxTicks; i += 1) {
    mod.tickOnce();
    if (!mod.state().employees.some((e) => e.binding)) return true;
  }
  return false;
}

test('timeline attribution: concurrent sessions never mix their accounting', () => {
  const mod = makeModule();
  // Per-session journal seqs (the adapter watermark is per session, exactly
  // like the real journal stream).
  // session A opens a turn and accrues usage
  mod.ingestHarnessEvent({ sessionId: 'sess-a', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId: 'sess-a', type: 'turn/usage', seq: 2, time: 2, data: { turn: 1, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, cost: 0.001 } });
  // session B starts while A still holds the seat: it QUEUES (module
  // semantics — one root binding per seat), so its usage has no binding to
  // attribute to and must never leak into A's turn.
  mod.ingestHarnessEvent({ sessionId: 'sess-b', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId: 'sess-b', type: 'turn/usage', seq: 2, time: 2, data: { turn: 1, usage: { input: 7000, output: 700, cacheRead: 0, cacheWrite: 0 }, cost: 0.07 } });
  // A completes: only its own 110 tokens
  mod.ingestHarnessEvent({ sessionId: 'sess-a', type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: 'completed' } });
  const log = harvestLog(mod);
  const results = log.filter((e) => e.kind === 'result-completed');
  assert.equal(results.length, 1, 'only the seated session produced a result row');
  assert.equal(results[0].turnUsage.total, 110, "A's turn kept exactly its own accounting");
  for (const entry of log) {
    if (entry.turnUsage) assert.notEqual(entry.turnUsage.total, 7700, "B's queued usage never leaked");
  }
  // B's turn ends while queued: a queued terminal, still no result row
  mod.ingestHarnessEvent({ sessionId: 'sess-b', type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: 'completed' } });
  tickUntilReleased(mod);
  assert.equal(mod.state().employees.some((e) => e.binding), false, 'the seat is free again');
  assert.equal(harvestLog(mod).filter((e) => e.kind === 'result-completed').length, 1,
    'the queued session never produced a second result row');
});

test('timeline attribution: a second turn of the same session gets its own accumulator', () => {
  const mod = makeModule();
  driveTurn(mod, 'sess-two-turns', { usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.001, startSeq: 1 });
  assert.equal(tickUntilReleased(mod), true, 'turn 1 released before turn 2 starts');
  // Turn 2 of the same raw session binds under the derived turn-scoped
  // handle (S#t1); its journal seqs continue the session's stream.
  driveTurn(mod, 'sess-two-turns', { usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 }, cost: 0.005, startSeq: 5 });
  tickUntilReleased(mod);
  const results = harvestLog(mod).filter((e) => e.kind === 'result-completed');
  assert.equal(results.length, 2);
  assert.equal(results[0].turnUsage.total, 100, 'turn 1 keeps only turn 1');
  assert.equal(results[1].turnUsage.total, 550, 'turn 2 accrues fresh (derived turn-scoped handle)');
});

// ---------------------------------------------------------------------------
// adapter: turn/usage -> runtime/usage (numbers only, redactor-surviving)
// ---------------------------------------------------------------------------

test('adapter: turn/usage maps to a runtime/usage fact with only the numbers', () => {
  const outputs = [];
  const adapter = createRuntimeAdapter({
    sessionId: 'sess-adapter',
    clock: { nowMs: () => 1000 },
    onEvent: (output) => outputs.push(output),
  });
  const result = adapter.ingest({
    type: 'turn/usage', seq: 1, time: 1000,
    data: {
      turn: 3,
      usage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 },
      cost: 0.0123,
      // poison payload fields the office must never see
      message: 'FIXTURE-MESSAGE-TEXT', prompt: 'FIXTURE-PROMPT', sessionId: 'sess-FIXTURE',
    },
  });
  assert.equal(result.status, 'accepted');
  const facts = outputs.at(-1).facts;
  assert.deepEqual(facts, [{
    type: 'runtime/usage',
    usage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 },
    cost: 0.0123,
  }], 'the fact carries the §4-shaped bucket + the money estimate only');
});

test('adapter: a zero turn/usage bucket produces no fact', () => {
  const outputs = [];
  const adapter = createRuntimeAdapter({
    sessionId: 'sess-adapter-zero',
    clock: { nowMs: () => 1000 },
    onEvent: (output) => outputs.push(output),
  });
  adapter.ingest({ type: 'turn/usage', seq: 1, time: 1000, data: { turn: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 } });
  assert.deepEqual(outputs.at(-1).facts, [], 'no accounting, no fact');
});

test('adapter: the redacted payload keeps the usage numbers (key-shape safe)', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  const redacted = redactor.redactValue({ turn: 2, usage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 }, cost: 0.0123 });
  assert.deepEqual(redacted, { turn: 2, usage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 }, cost: 0.0123 },
    'the §4-shaped key names survive the shared redactor (unlike /token/-shaped keys)');
  // the historic trap: a key the redactor reads as a token count is dropped
  assert.equal(redactor.redactValue({ inputTokens: 3000 }).inputTokens, '[REDACTED:token-count]');
});

// ---------------------------------------------------------------------------
// priceUsageAt — per-turn money at the SAME rates as the §4 block
// ---------------------------------------------------------------------------

test('priceUsageAt: the per-turn estimate uses the usage-block rates', () => {
  const settings = { costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.04, costCacheWritePerM: 0 };
  const costSnap = { rates: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.04, cacheWritePerM: 0 } };
  // 3000 in / 600 out / 1000 cacheRead = the P1 fixture's exact arithmetic
  assert.equal(priceUsageAt(TURN_USAGE_FIXTURE, { costSnap, settings }), 0.0108);
  assert.equal(priceUsageAt(TURN_USAGE_FIXTURE, { settings }), 0.0108, 'settings fallback matches');
  assert.equal(priceUsageAt({}, { settings }), 0, 'empty usage prices at zero');
  // and the same bucket prices identically inside the daily block
  const block = buildOfficeUsage({
    collectData: { totals: { days: { '2026-09-23': TURN_USAGE_FIXTURE } } },
    costSnap,
    settings,
    nowMs: Date.UTC(2026, 8, 23, 2),
    dataAtMs: Date.UTC(2026, 8, 23, 2),
  });
  assert.equal(block.money.paid, 0.0108, 'one rates convention, two surfaces');
});

// ---------------------------------------------------------------------------
// main.js — the assistant/message translation layer (static contract)
// ---------------------------------------------------------------------------

test('main.js translates assistant/message usage into the office turn/usage envelope', () => {
  const src = read('src/main.js');
  assert.ok(src.includes("if (event.type === 'assistant/message') {"),
    'the office journal translation handles assistant/message');
  assert.ok(src.includes("type: 'turn/usage'"), 'it emits the turn/usage office envelope');
  assert.ok(src.includes('nonNegInt(usage.inputTokens)'), 'inputTokens -> input (non-negative int)');
  assert.ok(src.includes('nonNegInt(usage.outputTokens)'), 'outputTokens -> output');
  assert.ok(src.includes('nonNegInt(usage.cacheReadTokens)'), 'cacheReadTokens -> cacheRead');
  assert.ok(src.includes('nonNegInt(usage.cacheWriteTokens)'), 'cacheWriteTokens -> cacheWrite');
  assert.ok(src.includes('priceUsageAt(bucket,'), 'the per-turn money is priced at the shared rates');
  // the message content itself never crosses the boundary
  const branch = src.slice(src.indexOf("if (event.type === 'assistant/message') {"), src.indexOf("mod.ingestHarnessEvent({ sessionId, type: event.type"));
  assert.ok(!branch.includes('data.message'), 'the message text is never forwarded');
  assert.ok(!branch.includes('data.stream'), 'the model stream is never forwarded');
  // the first-hand source is documented where the translation happens
  assert.ok(src.includes('there is no separate usage record'), 'the first-hand evidence is cited inline');
});

// ---------------------------------------------------------------------------
// employee snapshot — presentation whitelist (tool phrase + de-identified title)
// ---------------------------------------------------------------------------

test('employee snapshot: tool phrase and de-identified task counter reach the projection', () => {
  const mod = makeModule();
  mod.ingestHarnessEvent({ sessionId: 'sess-staff', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId: 'sess-staff', type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash' } });
  const employee = mod.state().employees.find((e) => e.binding);
  assert.ok(employee, 'the running session binds an employee');
  assert.equal(employee.toolKind, 'bash', 'the raw tool kind stays available');
  assert.equal(employee.toolPhrase, '执行命令', 'the shared zh phrase (tool-phrases module) rides the snapshot');
  assert.equal(employee.taskSeq, 1, 'the de-identified task counter is the turn number for this employee');
  assert.equal(phrases.toolPhraseZhOf('bash'), employee.toolPhrase, 'one phrase source');
  // after the turn ends the phrase remains as the last observed tool
  mod.ingestHarnessEvent({ sessionId: 'sess-staff', type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: 'completed' } });
  const after = mod.state().employees.find((e) => e.employeeId === employee.employeeId);
  assert.equal(after.toolPhrase, '执行命令');
  assert.equal(after.taskSeq, 1);
});

test('employee snapshot: the whitelist extension survives the redactor and leaks no runtime text', () => {
  const mod = makeModule();
  mod.ingestHarnessEvent({ sessionId: 'sess-priv-p2', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  // the office envelope convention: only the tool NAME is translated in; a
  // stray arguments field must never reach the snapshot either way
  mod.ingestHarnessEvent({ sessionId: 'sess-priv-p2', type: 'tool/call', seq: 2, time: 2, data: { tool: 'bash', arguments: 'FIXTURE-ARGS' } });
  const employee = mod.state().employees.find((e) => e.binding);
  const serialized = JSON.stringify(mod.state());
  assert.equal(serialized.includes('FIXTURE-ARGS'), false, 'tool arguments never enter the snapshot');
  assert.equal(serialized.includes('sess-priv-p2'), false, 'the raw session id never leaves the module');
  assert.equal(typeof employee.toolPhrase, 'string');
  assert.equal(typeof employee.taskSeq, 'number');
});

// ---------------------------------------------------------------------------
// page controller — the six-block view models
// ---------------------------------------------------------------------------

function makeController(snapshotPatch = {}) {
  const snapshot = {
    employees: [],
    activityLog: [],
    pending: [],
    usage: null,
    sync: 'healthy',
    capabilities: {},
    ...snapshotPatch,
  };
  const bridge = {
    getState: async () => snapshot,
    updateSettings: async () => ({}),
    notifyVisibility: () => {},
  };
  const page = officePage.createOfficePageController({ bridge });
  page.applySnapshot(snapshot);
  return page;
}

test('staffRows: badge, de-identified title, tool phrase and 需要You badge', () => {
  const page = makeController({
    employees: [
      { employeeId: 'coder', displayName: '编码员', activity: 'working', binding: { source: 'root-default', confidence: 1 }, taskSeq: 3, toolPhrase: '编辑文件', queueCount: 0, toolKind: 'edit' },
      { employeeId: 'researcher', displayName: '研究员', activity: 'roaming', binding: null, taskSeq: 0, toolPhrase: '查档案', queueCount: 2, toolKind: 'read' },
    ],
    pending: [
      { id: 'evt-1', kind: 'approval', employeeId: 'coder', toolName: 'bash', summary: '执行命令', risk: 'medium', createdAtMs: 1 },
    ],
  });
  const rows = page.staffRows();
  assert.equal(rows.length, 2);
  const coder = rows.find((r) => r.employeeId === 'coder');
  assert.equal(coder.statusLabel, '工作');
  assert.equal(coder.taskTitle, '任务 #3', 'the de-identified title is a counter');
  assert.equal(coder.toolPhrase, '编辑文件');
  assert.equal(coder.needsYou, 1, 'the 需要你 badge counts this employee’s pending items');
  const researcher = rows.find((r) => r.employeeId === 'researcher');
  assert.equal(researcher.statusLabel, '巡游');
  assert.equal(researcher.taskTitle, null, 'idle employees carry no task title');
  assert.equal(researcher.toolPhrase, null, 'the tool phrase shows only while a task is bound');
  assert.equal(researcher.needsYou, 0);
  // a11y label carries the de-identified fields
  const label = page.accessibleLabelFor('coder').label;
  assert.ok(label.includes('任务 3') && label.includes('编辑文件'), 'the a11y label stays de-identified');
  assert.ok(!label.includes('任务 #'), 'no hashed/exact form in the a11y label');
});

test('pendingSummary: the inbox container exposes the count and the items (P3 adds actions)', () => {
  const page = makeController({
    pending: [
      { id: 'e1', kind: 'approval', employeeId: 'coder', toolName: 'rm', summary: '执行命令', risk: 'high', createdAtMs: 10 },
      { id: 'e2', kind: 'question', employeeId: null, toolName: 'ask_user_question', summary: '等待你回答', risk: 'low', createdAtMs: 20 },
    ],
  });
  const summary = page.pendingSummary();
  assert.equal(summary.count, 2);
  assert.deepEqual(summary.items.map((i) => [i.id, i.risk]), [['e1', 'high'], ['e2', 'low']]);
  const empty = makeController();
  assert.equal(empty.pendingSummary().count, 0);
  assert.deepEqual(empty.pendingSummary().items, []);
});

test('usageView: the §4 block becomes the ① display model; null stays honest', () => {
  const block = buildOfficeUsage({
    collectData: {
      totals: {
        days: {
          // today in UTC+8 is the fixture day below (fixed clock 10:00 CST)
          '2026-09-23': { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 },
        },
      },
    },
    costSnap: { rates: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.04, cacheWritePerM: 0 }, month: { cost: 40 } },
    settings: { costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.04, monthlyBudget: 100 },
    nowMs: Date.UTC(2026, 8, 23, 2),
    dataAtMs: Date.UTC(2026, 8, 23, 2),
  });
  const page = makeController({ usage: block });
  const view = page.usageView();
  assert.equal(view.dayKey, '2026-09-23');
  assert.equal(view.tokensTotal, 4600);
  assert.equal(view.moneyPaid, 0.0108);
  assert.equal(view.currency, 'CNY');
  assert.equal(view.savingsCacheRead, 0.002);
  assert.equal(view.savingsLocalModel, 0);
  assert.equal(view.savingsLocalModelBasis, 'cloud-equivalent');
  assert.deepEqual([view.budgetKind, view.budgetLimit, view.budgetUsed], ['monthly', 100, 40]);
  assert.equal(view.pricingBasis, 'api-key');
  assert.equal(view.pricingBasisLabel, officePage.USAGE_BASIS_LABELS['api-key']);
  assert.equal(view.staleAt, null);
  assert.equal(makeController().usageView(), null, 'no shell data yet -> null, not zeros');
});

test('activityLog: the turn attribution rides the page view model verbatim', () => {
  const page = makeController({
    activityLog: [
      { atMs: 1, employeeId: 'coder', kind: 'task-started', turnUsage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0, total: 4600 }, turnCost: 0.01084, turnDurationMs: 4200 },
      { atMs: 2, employeeId: 'coder', kind: 'result-completed', turnUsage: { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0, total: 4600 }, turnCost: 0.01084, turnDurationMs: 4200 },
      { atMs: 3, employeeId: 'researcher', kind: 'sleep-started' },
    ],
  });
  const entries = page.activityLog();
  assert.deepEqual(entries[0].turnUsage, { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0, total: 4600 });
  assert.equal(entries[1].turnCost, 0.01084);
  assert.equal(entries[1].turnDurationMs, 4200);
  assert.equal(entries[2].turnUsage, null, 'unattributed rows stay null');
  for (const entry of entries) {
    assert.ok(entry.label.length < 40, 'labels stay coarse');
  }
});

test('formatters: compact counts (千/万), money and durations', () => {
  const { formatCount, formatMoney, formatDuration } = officePage;
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(4600), '4.6 千');
  assert.equal(formatCount(46000), '4.6 万');
  assert.equal(formatCount(4600000), '460 万');
  assert.equal(formatCount(460000000), '4.60 亿');
  assert.equal(formatMoney(0), '¥0.00');
  assert.equal(formatMoney(0.01084), '¥0.01');
  assert.equal(formatMoney(10.84), '¥10.84');
  assert.equal(formatMoney(123.4), '¥123.4');
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(4200), '4s');
  assert.equal(formatDuration(65000), '1m 05s');
});

// ---------------------------------------------------------------------------
// office.html — the six IA blocks and the removed development-period texts
// ---------------------------------------------------------------------------

test('office.html renders the six-block panel in spec §3 order', () => {
  const html = read('src/office/office.html');
  const order = [
    'id="usage-block"',          // ① today's usage
    'id="employee-list-block"',  // ② staff status rows
    'id="pending-block"',        // ③ 待你处理 inbox (container + count)
    'id="activity-block"',       // ④ timeline
    'id="details"',              // ⑤ selected employee details (structure)
    'id="office-footer"',        // ⑥ footer (sync dot + reduced motion + theme)
  ];
  let cursor = -1;
  for (const id of order) {
    const at = html.indexOf(id);
    assert.ok(at !== -1, `${id} exists`);
    assert.ok(at > cursor, `${id} follows the spec §3 order`);
    cursor = at;
  }
  // ① dual display: tokens headline + money + the savings split + budget + stale
  for (const id of ['usage-tokens', 'usage-money', 'usage-save-cache', 'usage-save-local', 'usage-cloud', 'usage-budget', 'usage-progress-bar', 'usage-stale', 'usage-basis']) {
    assert.ok(html.includes(`id="${id}"`), `usage block carries ${id}`);
  }
  // ③ count badge + empty state (P3 adds the inline actions)
  assert.ok(html.includes('id="pending-count"'), 'the inbox count badge exists');
  assert.ok(html.includes('暂无待处理 ✓'), 'the inbox empty state is the spec text');
  // ④ per-turn attribution + the 更多 expansion (20 -> 100)
  assert.ok(html.includes('id="timeline-more"'), 'the timeline expansion control exists');
  assert.ok(html.includes('const TIMELINE_PAGE_SIZE = 20;'), 'default 20 rows');
  assert.ok(html.includes('const TIMELINE_MAX = 100;'), '更多 expands to 100');
  assert.ok(html.includes('entry.turnUsage'), 'rows render this turn’s attribution');
  // ⑥ minimal sync point
  assert.ok(html.includes('id="sync-dot"'), 'the footer sync dot exists');
});

test('office.html drops the development-period texts (spec §2)', () => {
  const html = read('src/office/office.html');
  assert.ok(!html.includes('id="sync-summary"'), 'the sync long text is gone (footer dot + tooltip)');
  assert.ok(!html.includes('同步：'), 'no header sync sentence remains');
  // the fallback diagnostics moved into the degraded dot tooltip; the visible
  // fallback note stays ONLY for a fatal boot failure
  assert.ok(html.includes('function noteDegraded('), 'degraded diagnostics flow to a tooltip');
  assert.ok(!html.includes('note.textContent = `角色包降级'), 'the pack diagnostic is no longer a visible paragraph');
  assert.ok(!html.includes('note.textContent = `布局降级'), 'the layout diagnostic is no longer a visible paragraph');
  assert.ok(!html.includes('note.textContent = `渲染降级'), 'the render diagnostic is no longer a visible paragraph');
  assert.ok(html.includes('详情走 office:diagnostics'), 'the tooltip points at the diagnostics channel');
  // the layout editor entry is no longer a header action (P5 deletes it)
  assert.ok(html.includes("document.getElementById('footer-tools').appendChild(layoutEditorButton);"),
    'the layout editor chip lives in the footer, out of the prominent spots');
  assert.ok(!html.includes("document.getElementById('office-overview').appendChild"),
    'nothing is appended to the header anymore');
  // the editor DOM and its wiring stay untouched (P5 removes them)
  assert.ok(html.includes('id="layout-editor"'), 'the layout editor DOM is untouched');
  assert.ok(html.includes('id="layout-canvas"'), 'the editor canvas is untouched');
});

test('office.html keeps all four legacy panel renders together behind the throttle', () => {
  const html = read('src/office/office.html');
  assert.match(html, /const PANEL_RENDER_INTERVAL_MS = 100;/);
  assert.match(html, /lastPanelRenderAtMs = now;\s*\n\s*renderOverview\(snapshot\);[\s\S]*?renderEmployeeList\(snapshot\);[\s\S]*?renderDetails\(\);[\s\S]*?renderActivity\(snapshot\);/,
    'the four legacy renders stay in order behind the throttle');
  assert.match(html, /renderActivity\(snapshot\);\s*\n\s*\/\/ P2 blocks[\s\S]*?renderUsageBlock\(snapshot\);[\s\S]*?renderPendingBlock\(snapshot\);/,
    'the P2 usage/pending renders ride the same cadence after them');
});

test('office.html follows the shell theme through the preload bridge (no new business channel)', () => {
  const html = read('src/office/office.html');
  assert.ok(html.includes('bridge.getTheme'), 'the theme is pulled once on boot');
  assert.ok(html.includes('bridge.onTheme'), 'theme pushes are consumed');
  assert.ok(html.includes("applyPageTheme('light')"), 'light is the default until the shell answers');
  const preload = read('src/office/office-preload.js');
  assert.ok(preload.includes("getTheme: () => ipcRenderer.invoke('shell:get-theme')"), 'the preload exposes getTheme');
  assert.ok(preload.includes("ipcRenderer.on('shell:theme'"), 'the preload exposes the theme push');
  // the seven whitelisted office business channels stay exactly seven
  for (const channel of ['office:state', 'office:dispatch', 'office:cancel', 'office:interrupt', 'office:settings', 'office:diagnostics', 'office:visibility']) {
    assert.ok(preload.includes(`'${channel}'`), `preload references ${channel}`);
  }
  assert.doesNotMatch(preload, /office:(?!(state|dispatch|cancel|interrupt|settings|diagnostics|visibility))/, 'no other office channels');
  assert.ok(preload.includes('contextBridge'), 'still a contextBridge surface');
});

test('office.css carries the dark theme tokens and the sync dot', () => {
  const css = read('src/office/office.css');
  assert.match(css, /\[data-theme="dark"\]\s*\{[\s\S]*?--panel-bg:/s, 'dark theme tokens exist');
  assert.match(css, /\.sync-dot\s*\{/, 'the sync dot is styled');
  assert.match(css, /\.sync-dot\[data-sync="stale"\]/, 'the late state is styled');
  assert.match(css, /\.sync-dot\[data-sync="resyncing"\]/, 'the reconnecting state is styled');
  assert.match(css, /.usage-progress-bar\s*\{/, 'the budget progress bar is styled');
  assert.match(css, /need-pulse/, 'the 需要你 pulse is styled');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?need-pulse/, 'the pulse respects reduced motion');
});

test('i18n: every §6 key the P2 panel renders exists in both dictionaries', () => {
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh/en dictionaries cover the same keys');
  for (const key of [
    'office.usage.today', 'office.usage.spent', 'office.usage.saved', 'office.usage.cache',
    'office.usage.local', 'office.usage.cloud', 'office.usage.budget', 'office.usage.stale',
    'office.usage.basis.apiKey', 'office.usage.basis.subscription',
    'office.pending.title', 'office.pending.empty', 'office.pending.approve', 'office.pending.reject',
    'office.pending.review', 'office.pending.modal.steps', 'office.pending.modal.impact',
    'office.pending.modal.approveOnce', 'office.timeline.more',
    'office.sync.ok', 'office.sync.late', 'office.sync.reconnecting',
  ]) {
    assert.ok(typeof STRINGS.zh[key] === 'string' && STRINGS.zh[key] !== '', `zh missing ${key}`);
    assert.ok(typeof STRINGS.en[key] === 'string' && STRINGS.en[key] !== '', `en missing ${key}`);
  }
  // the staff badge labels mirror the zh dictionary values the page shows
  assert.equal(STRINGS.zh['office.sync.late'], '同步迟到');
  assert.equal(STRINGS.en['office.sync.late'], 'Sync late');
});
