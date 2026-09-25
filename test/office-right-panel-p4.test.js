'use strict';

// test/office-right-panel-p4.test.js — P4 选中员工「今日工作记录」+ 右栏打磨
// contract tests (docs/strategy/2026-09-23-office-right-panel-spec.md §3 块⑤ /
// §4 数据契约 / §6 i18n / §7 测试计划 / §8 P4 行), module-layer only (no Electron).
//
// Covers:
//   - ⑤ the per-employee day record: aggregation from the module's REAL sources
//     (task-started / result-* activity kinds, the P2 per-turn provider usage
//     attribution, the M5 tool/call facts), real-calendar-day scoping through
//     the main.js-injected realClock, the midnight rollover, the no-realClock
//     session-window fallback, the de-identified projection (phrase family
//     only) and the empty-record gate (no fabricated zeros).
//   - the eight polish items of §8 P4 (① neutral zero-count badge, ② keyboard
//     hint into tooltip/aria, ③ the compressed overview line, ④ the "harness
//     原文" tag, ⑤ the preset live refresh wiring in main.js) — asserted against
//     the real sources (office.html / office.css / src/main.js).
//   - the i18n family (office.record.* + office.pending.modal.raw) in both
//     dictionaries, and the still-exactly-eight office:* channels (P4 added no
//     channel: the record rides the existing office:state snapshot).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const officeModule = require('../src/office/office-module.js');
const officePage = require('../src/office/office-page.js');
const { STRINGS } = require('../src/i18n.js');
const { billingDayKey } = require('../src/office/runtime/usage-snapshot.js');
const phrases = require('../src/office/runtime/tool-phrases.js');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A fixed CST (UTC+8) mid-day instant: 2026-09-23T02:00:00Z = 10:00 local.
const NOW_MS = Date.UTC(2026, 8, 23, 2, 0, 0);
const DAY_KEY = billingDayKey(NOW_MS);
// 23:59:30 CST the same evening, and 00:00:30 CST the next morning (UTC+8).
const BEFORE_MIDNIGHT_MS = Date.UTC(2026, 8, 23, 15, 59, 30);
const AFTER_MIDNIGHT_MS = Date.UTC(2026, 8, 23, 16, 0, 30);

function makeModule(overrides = {}) {
  let now = NOW_MS;
  const mod = officeModule.createOfficeModule({
    seed: 'office-right-panel-p4-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    realClock: () => now,
    ...overrides,
  });
  // The test controls the wall clock; the module only reads it through the
  // injected reader (the simulation keeps its logical clock).
  return {
    mod,
    setNow: (ms) => { now = ms; },
    getNow: () => now,
  };
}

/** Drive one full turn: running -> tool call -> usage -> completed. Sequence
 * numbers are CONTIGUOUS (the runtime adapter drops out-of-order journal
 * events), so the usage slot keeps its number even when no usage is sent. */
function driveTurn(mod, sessionId, { tool = 'bash', usage, cost = 0, reason = 'completed', startSeq = 1 }) {
  let seq = startSeq - 1;
  const next = () => { seq += 1; return seq; };
  mod.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: next(), time: seq, data: { status: 'running' } });
  mod.ingestHarnessEvent({ sessionId, type: 'tool/call', seq: next(), time: seq, data: { tool } });
  if (usage) {
    mod.ingestHarnessEvent({
      sessionId, type: 'turn/usage', seq: next(), time: seq,
      data: { turn: 1, usage, cost },
    });
  }
  mod.ingestHarnessEvent({ sessionId, type: 'turn/end', seq: next(), time: seq, data: { turn: 1, reason } });
}

/** driveTurn + enough ticks for the result presentation to expire and the seat
 * FIFO to dispatch the next turn (root turns always bind the orchestrator;
 * without the ticks the second turn stays queued — a 进入队列 row, not a task). */
function driveTurnTicked(mod, sessionId, options) {
  driveTurn(mod, sessionId, options);
  for (let i = 0; i < 60; i += 1) mod.advanceOneTick();
}

const TURN_USAGE_FIXTURE = { input: 3000, output: 600, cacheRead: 1000, cacheWrite: 0 };

/** The employee whose record is non-null (the one the turn bound to). */
function recordedEmployee(mod) {
  return mod.state().employees.find((e) => e.record !== null) || null;
}

// ---------------------------------------------------------------------------
// ⑤ the day record — aggregation from real sources
// ---------------------------------------------------------------------------

test('record: a driven turn aggregates counts, usage, duration, tools and recent rows', () => {
  const { mod } = makeModule();
  driveTurn(mod, 'sess-record-1', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.0123 });
  const employee = recordedEmployee(mod);
  assert.ok(employee, 'the bound employee carries a record');
  const record = employee.record;
  assert.equal(record.dayKey, DAY_KEY, 'the record is scoped to the real UTC+8 day');
  assert.equal(record.tasks, 1, 'task-started counted');
  assert.equal(record.completed, 1, 'result-completed counted');
  assert.equal(record.failed, 0);
  assert.equal(record.cancelled, 0);
  // the per-turn provider usage attribution (P2 first-hand record) is the sum
  assert.deepEqual(record.usage, {
    input: 3000, output: 600, cacheRead: 1000, total: 4600, cost: 0.0123,
  }, 'the usage row is the turn attribution, never a day-bucket difference');
  assert.ok(record.durationMs >= 0, 'duration is the attributed turn duration');
  // de-identified 常用工具: the fixed zh phrase family + count, no tool name
  assert.equal(record.tools.length, 1);
  assert.equal(record.tools[0].phrase, phrases.toolPhraseZhOf('bash'));
  assert.equal(record.tools[0].count, 1);
  // P1 English pass: the stable office.staff.currentTool.* key rides the row
  // (still no raw tool name — 'key' is the fixed phrase vocabulary).
  assert.deepEqual(Object.keys(record.tools[0]).sort(), ['count', 'key', 'phrase'], 'no raw tool name rides the row');
  assert.equal(record.tools[0].key, phrases.toolPhraseKeyOf('bash'));
  // recent kinds: the turn boundaries (进入/落座/任务起止 family)
  const kinds = record.recent.map((row) => row.kind);
  assert.ok(kinds.includes('task-started'), 'the start row is in 今日动态');
  assert.ok(kinds.includes('result-completed'), 'the terminal row is in 今日动态');
  for (const row of record.recent) {
    assert.equal(billingDayKey(row.realMs), DAY_KEY, 'every recent row is from today');
  }
});

test('record: activity-log entries carry the real event instant beside the logical one', () => {
  const { mod } = makeModule();
  driveTurn(mod, 'sess-record-real', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.01 });
  const log = mod.state().activityLog;
  assert.ok(log.length > 0, 'the snapshot log tail has rows');
  for (const entry of log) {
    assert.equal(typeof entry.realMs, 'number', 'realMs is stamped on every entry');
    assert.ok(entry.realMs >= NOW_MS, 'realMs reads the injected clock');
    assert.equal(typeof entry.atMs, 'number', 'the logical stamp is untouched');
  }
});

test('record: failed and cancelled turns count into their own rows', () => {
  // Two separate modules: the seat FIFO queues a second turn behind the first
  // one's result presentation, and the cancelled terminal of a QUEUED turn is
  // a pre-existing module behaviour outside P4's scope — one turn per module
  // keeps this test about the record counters.
  const failedMod = makeModule();
  driveTurnTicked(failedMod.mod, 'sess-record-failed', { tool: 'bash', reason: 'error', usage: TURN_USAGE_FIXTURE, cost: 0.02 });
  const failed = recordedEmployee(failedMod.mod).record;
  assert.equal(failed.failed, 1, 'a turn/end error is a failed task');
  assert.equal(failed.tasks, 1);
  assert.equal(failed.completed, 0);
  assert.equal(failed.cancelled, 0);
  // the failed turn's attribution still accrued (the provider usage record is
  // real regardless of the outcome)
  assert.deepEqual(failed.usage, { input: 3000, output: 600, cacheRead: 1000, total: 4600, cost: 0.02 });
  assert.equal(failed.tools[0].phrase, phrases.toolPhraseZhOf('bash'));

  const cancelledMod = makeModule();
  driveTurnTicked(cancelledMod.mod, 'sess-record-cancelled', { tool: 'edit', reason: 'aborted' });
  const cancelled = recordedEmployee(cancelledMod.mod).record;
  assert.equal(cancelled.cancelled, 1, 'an aborted turn is a cancelled task');
  assert.equal(cancelled.tasks, 1);
  assert.equal(cancelled.failed, 0);
  // the cancelled turn carried no provider usage record — the row stays null
  assert.equal(cancelled.usage, null, 'no attribution -> null, never zeros');
  assert.equal(cancelled.tools[0].phrase, phrases.toolPhraseZhOf('edit'));
});

test('record: the recent rows are bounded to the cap', () => {
  const { mod } = makeModule();
  for (let i = 0; i < 4; i += 1) {
    driveTurnTicked(mod, `sess-record-bound-${i}`, { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.001, startSeq: i * 10 + 1 });
  }
  const record = recordedEmployee(mod).record;
  // 4 turns × (task-started + result-completed) = 8 rows, capped at 6
  assert.equal(record.recent.length, 6, 'the record timeline keeps the last 6 rows');
  assert.equal(record.tasks, 4, 'the counts are NOT capped — only the timeline rows are');
  assert.equal(record.completed, 4);
});

test('record: a queued turn shows up as 进入队列 in the timeline (not a task)', () => {
  const { mod } = makeModule();
  // Two running facts without ticks in between: the second one queues behind
  // the still-bound seat (the real seat-FIFO behaviour, not a fabrication).
  driveTurn(mod, 'sess-record-q1', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.01 });
  driveTurn(mod, 'sess-record-q2', { tool: 'bash', startSeq: 10 });
  const record = recordedEmployee(mod).record;
  assert.equal(record.tasks, 1, 'a queued turn is not a started task');
  const kinds = record.recent.map((row) => row.kind);
  assert.ok(kinds.includes('queued'), 'the queued turn leaves a 进入队列 row');
});

test('record: a midnight rollover resets the day record', () => {
  const { mod, setNow } = makeModule();
  setNow(BEFORE_MIDNIGHT_MS);
  driveTurnTicked(mod, 'sess-record-roll', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.01 });
  let record = recordedEmployee(mod).record;
  assert.equal(record.dayKey, billingDayKey(BEFORE_MIDNIGHT_MS));
  assert.equal(record.tasks, 1);
  // The clock crosses midnight UTC+8: the next snapshot must show a FRESH day
  // (the previous day's counts never leak into 今日).
  setNow(AFTER_MIDNIGHT_MS);
  const afterRollover = mod.state().employees.map((e) => e.record).filter(Boolean);
  assert.equal(afterRollover.length, 0, 'the rolled-over record is reset — yesterday never rides into today');
  // A new turn on the new day starts from zero
  driveTurnTicked(mod, 'sess-record-roll-2', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.02 });
  record = recordedEmployee(mod).record;
  assert.equal(record.dayKey, billingDayKey(AFTER_MIDNIGHT_MS));
  assert.equal(record.tasks, 1, 'the new day counts only its own task');
  assert.equal(record.usage.cost, 0.02, 'the new day carries only its own usage');
});

test('record: without a realClock the record is a session window, never labelled 今日', () => {
  const mod = officeModule.createOfficeModule({
    seed: 'office-right-panel-p4-no-clock',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
  });
  driveTurn(mod, 'sess-record-noclock', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.01 });
  const record = recordedEmployee(mod).record;
  assert.ok(record, 'the record still aggregates');
  assert.equal(record.dayKey, null, 'no real clock -> no day claim');
  assert.equal(record.tasks, 1, 'the counts still aggregate (session window)');
  for (const row of record.recent) {
    assert.equal(row.realMs, null, 'no real instant is fabricated');
  }
  // the page must not present a session window as 今日
  const vm = officePage.buildRecordViewModel(record);
  assert.equal(vm.dayKey, null);
  assert.equal(officePage.RECORD_TEXT.title, STRINGS.zh['office.record.title']);
  assert.equal(officePage.RECORD_TEXT.sessionNote, STRINGS.zh['office.record.sessionNote']);
});

test('record: an employee with nothing logged today has no record (no fabricated zeros)', () => {
  const { mod } = makeModule();
  // A fresh module with no events at all: every employee's record is null —
  // the page shows the empty state instead of a row of invented zeros.
  for (const employee of mod.state().employees) {
    assert.equal(employee.record, null, 'an idle employee on a fresh day shows no record at all');
  }
});

test('record: the projection keeps the module privacy boundary (no ids, no payload text)', () => {
  const { mod } = makeModule();
  driveTurn(mod, 'sess-record-privacy', { tool: 'bash', usage: TURN_USAGE_FIXTURE, cost: 0.01 });
  const record = recordedEmployee(mod).record;
  const json = JSON.stringify(record);
  // the session id and the tool NAME never cross the projection
  assert.ok(!json.includes('sess-record-privacy'), 'no session id');
  assert.ok(!json.includes('"bash"'), 'no raw tool name');
  // shape is fixed: numbers + controlled vocabularies only
  assert.deepEqual(Object.keys(record).sort(),
    ['cancelled', 'completed', 'dayKey', 'durationMs', 'failed', 'recent', 'tasks', 'tools', 'usage']);
  assert.deepEqual(Object.keys(record.recent[0]).sort(), ['atMs', 'kind', 'realMs']);
  // the allowlist extension is what lets `record` ride the redacted snapshot
  const raw = read('src/office/office-module.js');
  // P1 English pass: `chatPhase` joins the allowlist — a fixed 'walking' |
  // 'seated' | null vocabulary (the panel's chat-phase label key), never
  // runtime text.
  assert.match(raw, /'taskSeq', 'record', 'chatPhase'\]\)/, 'record/chatPhase are on the presentation allowlist (whitelist, not a bypass)');
});

// ---------------------------------------------------------------------------
// ⑤ the page view model
// ---------------------------------------------------------------------------

function makeController(record) {
  return officePage.createOfficePageController({
    bridge: {
      getState: async () => ({
        employees: [
          {
            employeeId: 'coder', displayName: '小林', role: '工程师', activity: 'working',
            runtime: 'running', presence: 'present', queueCount: 0, waiting: [], sync: 'healthy',
            control: 'none', binding: { source: 'root-default', confidence: 1 },
            taskLabel: '执行任务中', toolPhrase: '执行命令', taskSeq: 2, record,
          },
        ],
        activityLog: [], diagnostics: [], usage: null, pending: [], capabilities: {}, sync: 'healthy',
      }),
    },
  });
}

test('recordFor: the controller exposes the record view model', async () => {
  const record = {
    dayKey: DAY_KEY, tasks: 3, completed: 2, failed: 1, cancelled: 0,
    usage: { input: 100, output: 20, cacheRead: 5, total: 125, cost: 0.0123 },
    durationMs: 42000,
    tools: [{ phrase: '执行命令', count: 4 }, { phrase: '编辑文件', count: 2 }],
    recent: [
      { kind: 'task-started', atMs: 1000, realMs: NOW_MS },
      { kind: 'result-completed', atMs: 5000, realMs: NOW_MS + 4000 },
      { kind: 'sleep-started', atMs: 9000, realMs: NOW_MS + 8000 },
    ],
  };
  const page = makeController(record);
  await page.init();
  page.select('coder');
  const vm = page.recordFor('coder');
  assert.equal(vm.dayKey, DAY_KEY);
  assert.deepEqual([vm.tasks, vm.completed, vm.failed, vm.cancelled], [3, 2, 1, 0]);
  assert.equal(vm.usage.total, 125);
  assert.equal(vm.usage.cost, 0.0123);
  assert.equal(vm.durationMs, 42000);
  // P1 English pass: the VM row carries the stable key (null for fixtures
  // without one) beside the zh fallback phrase.
  assert.deepEqual(vm.tools, [
    { phrase: '执行命令', key: null, count: 4 },
    { phrase: '编辑文件', key: null, count: 2 },
  ]);
  assert.deepEqual(vm.recent.map((r) => r.label), ['开始任务', '任务完成', '开始小憩'], 'kinds map to the coarse labels');
  assert.equal(vm.recent[0].realMs, NOW_MS);
  assert.equal(page.recordFor('nobody'), null, 'an unknown employee has no record');
});

test('recordFor: empty and unattributed records degrade honestly', async () => {
  const empty = makeController(null);
  await empty.init();
  empty.select('coder');
  assert.equal(empty.recordFor('coder'), null, 'no record at all -> null (the page shows the empty state)');
  const unattributed = makeController({
    dayKey: DAY_KEY, tasks: 1, completed: 0, failed: 0, cancelled: 0,
    usage: null, durationMs: 0, tools: [], recent: [{ kind: 'task-started', atMs: 10, realMs: NOW_MS }],
  });
  await unattributed.init();
  unattributed.select('coder');
  const vm = unattributed.recordFor('coder');
  assert.equal(vm.usage, null, 'a turn with no provider usage stays null — never zeros');
  assert.equal(vm.tools.length, 0, 'no tool calls -> no 常用工具 row');
  assert.equal(vm.recent.length, 1);
});

test('formatClock: real wall time (local zone) with the logical fallback', () => {
  const ms = Date.UTC(2026, 8, 23, 2, 0, 0);
  const expected = (() => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
  assert.equal(officePage.formatClock(ms), expected, 'a real instant renders as local wall time');
  assert.equal(officePage.formatClock(ms, 12345), expected, 'the real instant wins over the logical stamp');
  assert.equal(officePage.formatClock(null, 0), '00:00:00', 'no real clock -> the historical logical display');
  assert.equal(officePage.formatClock(undefined, 3661000), '01:01:01', 'the fallback keeps the ISO-UTC convention');
  assert.equal(officePage.formatClock(null, null), '--:--:--');
});

test('activityLog: realMs rides the page view model (timeline wall-clock render)', async () => {
  const page = makeController(null);
  page.applySnapshot({
    employees: [{
      employeeId: 'coder', displayName: '小林', role: '工程师', activity: 'working', runtime: 'running',
      presence: 'present', queueCount: 0, waiting: [], sync: 'healthy', control: 'none',
      binding: null, toolPhrase: null, taskSeq: 0, record: null,
    }],
    activityLog: [{ atMs: 42, realMs: NOW_MS, employeeId: 'coder', kind: 'task-started' }],
    diagnostics: [], usage: null, pending: [], capabilities: {}, sync: 'healthy',
  });
  const entries = page.activityLog();
  assert.equal(entries[0].realMs, NOW_MS, 'the real instant reaches the timeline renderer');
  assert.equal(entries[0].atMs, 42, 'the logical stamp is untouched');
  // a null realMs (no injected clock) stays null instead of NaN
  page.applySnapshot({
    employees: [], activityLog: [{ atMs: 7, employeeId: 'coder', kind: 'task-started' }],
    diagnostics: [], usage: null, pending: [], capabilities: {}, sync: 'healthy',
  });
  assert.equal(page.activityLog()[0].realMs, null);
});

// ---------------------------------------------------------------------------
// the §8 P4 polish items (asserted against the real sources)
// ---------------------------------------------------------------------------

test('polish ①: the pending count badge is neutral at zero (red is for >0 only)', () => {
  const html = read('src/office/office.html');
  assert.match(html, /countEl\.classList\.toggle\('need-zero', summary\.count === 0\)/, 'the zero state toggles a neutral class');
  const css = read('src/office/office.css');
  assert.match(css, /\.need-badge\.need-zero\s*\{[^}]*color:\s*var\(--text-dim\)/s, 'the neutral badge is dim, not red');
  assert.match(css, /\.need-badge\.need-zero\s*\{[\s\S]*?background:\s*transparent/s, 'no red fill at zero');
  assert.match(css, /\.need-badge\s*\{[\s\S]*?background:\s*var\(--need\)/s, 'the red fill stays for the >0 badge');
});

test('polish ②: the keyboard hint lives in the list tooltip/aria label, not a visible line', () => {
  const html = read('src/office/office.html');
  assert.ok(!html.includes('<p class="hint">方向键移动焦点'), 'the didactic visible hint is gone');
  // P1 English pass: the hint rides the data-i18n key (filled per language).
  assert.match(html, /id="employee-list"[^>]*data-i18n-title="office\.panel\.staffListAria"/, 'the hint rides the list title key');
  // P1 English pass: the aria label rides the data-i18n key (filled per language).
  assert.match(html, /id="employee-list"[^>]*data-i18n-aria="office\.panel\.staffListAria"/, 'screen readers still get the keyboard contract');
});

test('polish ③: the overview line is compressed (the constant 在岗 count is gone)', () => {
  const html = read('src/office/office.html');
  assert.ok(!html.includes('在岗 ${overview.presentCount}'), 'the constant present-count line is removed');
  // P1 English pass: the one-liner is the office.overview.summary template.
  assert.match(html, /tr\('office\.overview\.summary', \{ r: overview\.runningCount, q: overview\.queuedCount \}\)/, 'the compressed one-liner keeps the two real counts');
  assert.match(html, /presence[\s\S]{0,80}恒为|恒为 'present'/, 'the reason is documented in the source');
  const css = read('src/office/office.css');
  assert.match(css, /#overview-summary\s*\{[^}]*color:\s*var\(--text-dim\)/s, 'the compressed line is dimmed (weight moves to the usage block)');
});

test('polish ④: the harness raw text carries the 「harness 原文」 tag in the modal', () => {
  const html = read('src/office/office.html');
  assert.match(html, /function rawTag\(\)/, 'the tag renderer exists');
  assert.match(html, /dd\.append\(modalText\(step\), rawTag\(\)\)/, 'the steps row (harness reason) is tagged');
  assert.match(html, /dd\.append\(pre, rawTag\(\)\)/, 'the 命令原文 row is tagged');
  assert.equal(officePage.PENDING_MODAL_TEXT.rawTag, STRINGS.zh['office.pending.modal.raw']);
  const css = read('src/office/office.css');
  assert.match(css, /\.pending-modal-raw-tag\s*\{/, 'the tag is styled as a weak chip');
});

test('P4-R1 axis: the agent preset shows verbatim; the sandbox mode is stated as unprojected', () => {
  // First-hand (user-verified on the installed 0.1.5-rc.2): session/list's
  // `agentPreset` is the AGENT composition preset (dsh-agent-presets, real
  // value `standard`) — a different axis from the permission presets
  // (read-only / workspace-write / danger-full-access), whose `sandboxMode` the
  // harness does NOT project onto sessions. So `standard` is a legal real
  // value, never relabelled "unknown", and never mapped to a sandbox tier.
  const model = officePage.buildPendingModalModel({
    item: { kind: 'approval', risk: 'medium', toolName: 'bash', summary: 'x' },
    detail: { id: 'e1', kind: 'approval', toolName: 'bash', preset: 'standard', reason: 'r' },
  });
  assert.equal(model.agentPreset, 'standard', 'the real agent preset rides the modal verbatim');
  assert.match(model.impact, /沙箱模式：harness 未投影/, 'no sandbox inference from the agent preset');
  assert.ok(!/未知/.test(model.impact), 'the unprojected note is not an "unknown" relabel');
  const html = read('src/office/office.html');
  // P1 English pass: the row term resolves through the dictionary key map.
  assert.match(html, /MT\('agentPreset'\)/, 'the modal row term is the agent-preset label');
  assert.ok(!html.includes('PENDING_MODAL_TXT.preset,'), 'the old 权限预设 row term is gone');
  assert.ok(!/权限预设/.test(html) && !/权限预设/.test(read('src/i18n.js')), 'no 权限预设 label remains');
  // an absent agent preset omits the row instead of showing 未知
  const absent = officePage.buildPendingModalModel({
    item: { kind: 'approval', risk: 'medium', toolName: 'bash', summary: 'x' },
    detail: { id: 'e2', kind: 'approval', toolName: 'bash', preset: null, reason: 'r' },
  });
  assert.equal(absent.agentPreset, null, 'no agent preset -> the row is omitted (no fabricated value)');
  // the widening case still names the real target mode (the only observable
  // sandbox fact)
  const widening = officePage.buildPendingModalModel({
    item: { kind: 'approval', risk: 'high', toolName: 'bash', summary: 'x' },
    detail: { id: 'e3', kind: 'approval', toolName: 'bash', preset: 'standard', reason: 'escalate sandbox to danger-full-access: x', requestedSandboxMode: 'danger-full-access' },
  });
  assert.match(widening.impact, /danger-full-access 运行/, 'a real widening request names the target mode');
});

test('P4-R1 axis: classifyRisk treats `standard` as a non-tier (behaviour unchanged)', () => {
  const { classifyRisk } = require('../src/office/runtime/approval-risk.js');
  // `standard` is an agent-axis value: it must NOT escalate like
  // danger-full-access and must NOT trip the read-only write rule. The result
  // is exactly the class-based outcome — identical to classifying without any
  // preset at all (the conservative path the P1 table already pins).
  for (const tool of ['bash', 'edit', 'ls']) {
    assert.equal(classifyRisk({ toolName: tool, preset: 'standard' }), classifyRisk({ toolName: tool }),
      `standard must not change the verdict for ${tool}`);
  }
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'standard' }), 'medium');
  assert.equal(classifyRisk({ toolName: 'edit', preset: 'standard' }), 'medium');
  assert.equal(classifyRisk({ toolName: 'ls', preset: 'standard' }), 'low');
  // the real tiers still behave exactly as before (the rename touched no logic)
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'danger-full-access' }), 'high');
  assert.equal(classifyRisk({ toolName: 'edit', preset: 'read-only' }), 'high');
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'workspace-write' }), 'medium');
  // no code path maps `standard` to a sandbox tier anywhere in the office surface
  for (const file of ['src/office/office-page.js', 'src/office/runtime/approval-risk.js', 'src/main.js']) {
    assert.ok(!/standard[^\n]*(read-only|workspace-write|danger-full-access)/.test(read(file)), `${file} must not map standard to a tier`);
  }
});

test('polish ⑤: main.js refreshes session presets live (seed tick + detail fetch)', () => {
  const main = read('src/main.js');
  assert.match(main, /realClock: \(\) => Date\.now\(\)/, 'main.js injects the real clock for the day record');
  assert.match(main, /officeRefreshSessionPreset\(sessionId\)/, 'the detail resolver can refresh a preset live');
  assert.match(main, /if \(officePresetResyncDue\(\)\) seedOfficeFollowFromSessionList\(\);/, 'the follow heartbeat re-lists ≈every 60s');
  assert.match(main, /officePresetResyncTick % 12 === 0/, 'the re-list cadence is bounded (12 × 5s)');
  // the refresh failure path stays honest — no invented preset
  assert.match(main, /catch \{ \/\* advisory: the modal falls back to the honest unknown note \*\/ \}/);
  // no new office:* IPC channel for P4: exactly the eight P1–P3 channels
  assert.deepEqual([...officeModule.OFFICE_IPC_CHANNELS].sort(), [
    'office:cancel', 'office:diagnostics', 'office:dispatch', 'office:interrupt',
    'office:pending', 'office:settings', 'office:state', 'office:visibility',
  ]);
});

test('⑥ consistency: the record rows and the modal tag ride the shared tokens (dark-safe)', () => {
  const css = read('src/office/office.css');
  // every new rule must reference theme tokens, never hardcoded colors
  for (const rule of ['.record-line', '.record-recent', '.record-day', '.pending-modal-raw-tag', '.need-badge.need-zero']) {
    const idx = css.indexOf(rule);
    assert.ok(idx >= 0, `${rule} is styled`);
    const block = css.slice(idx, css.indexOf('}', idx));
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(block), `${rule} uses tokens only (dark theme safe)`);
  }
  // reduced motion covers the P2 progress bar too (P4 pass)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.usage-progress-bar \{ transition: none; \}/);
});

test('⑥ consistency: the modal blocked-composer note renders from the view model (P3 defect fixed)', () => {
  // Regression: pre-P4 office.html read PENDING_MODAL_TXT.blockedNote, but the
  // page module's text object key is `blocked` — the note (spec §5: the
  // composer is blocked while an approval waits) silently rendered EMPTY since
  // P3. The note now rides the view model like every other modal row.
  const html = read('src/office/office.html');
  assert.ok(!html.includes('PENDING_MODAL_TXT.blockedNote'), 'the stale key reference is gone');
  assert.match(html, /document\.getElementById\('pending-modal-blocked'\)\.textContent = model\.blockedNote/, 'the note comes from the modal view model');
  const model = officePage.buildPendingModalModel({ item: { kind: 'approval', risk: 'high', toolName: 'bash', summary: 'x' } }, null);
  assert.match(model.blockedNote, /阻塞/, 'the view model carries the blocked note');
});

// ---------------------------------------------------------------------------
// i18n — the P4 key family (zh/en parity)
// ---------------------------------------------------------------------------

test('i18n: every P4 key the panel renders exists in both dictionaries', () => {
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh/en dictionaries cover the same keys');
  for (const key of [
    'office.record.title', 'office.record.empty', 'office.record.tasks', 'office.record.completed',
    'office.record.failed', 'office.record.cancelled', 'office.record.usage', 'office.record.duration',
    'office.record.tools', 'office.record.timeline', 'office.record.note', 'office.record.sessionNote',
    'office.pending.modal.raw', 'office.pending.modal.agentPreset', 'office.pending.modal.sandbox.unprojected',
  ]) {
    assert.ok(typeof STRINGS.zh[key] === 'string' && STRINGS.zh[key] !== '', `zh missing ${key}`);
    assert.ok(typeof STRINGS.en[key] === 'string' && STRINGS.en[key] !== '', `en missing ${key}`);
  }
});

test('office.html renders the record block inside the details block (five-block detail order)', () => {
  const html = read('src/office/office.html');
  assert.match(html, /<div id="details-record">/, 'the record container exists');
  assert.match(html, /id="record-counts"/, 'the counts row exists');
  assert.match(html, /id="record-usage"/, 'the usage row exists');
  assert.match(html, /id="record-tools"/, 'the tools row exists');
  assert.match(html, /id="record-recent"/, 'the recent timeline exists');
  // P1 English pass: the empty state rides the data-i18n key.
  assert.match(html, /id="record-empty"[^>]*data-i18n="office\.record\.empty"/, 'the empty state is honest');
  // the record sits between the queue line and the action buttons
  const detailsIdx = html.indexOf('id="details-queue"');
  const recordIdx = html.indexOf('id="details-record"');
  const actionsIdx = html.indexOf('id="details-actions"');
  assert.ok(detailsIdx < recordIdx && recordIdx < actionsIdx, 'queue → record → actions order');
});
