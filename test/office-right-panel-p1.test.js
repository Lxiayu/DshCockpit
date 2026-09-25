'use strict';

// test/office-right-panel-p1.test.js — P1 data pipeline contract tests for the
// office right-panel rework (docs/strategy/2026-09-23-office-right-panel-spec.md
// §4 数据契约 / §5 审批危险分级 / §7 测试计划 / §8 P1 行).
//
// Covers, module-layer only (no Electron):
//   - classifyRisk() table-driven: low/medium/high each ≥3 cases, skewed toward
//     medium/high (approval requests naturally concentrate there), including
//     the danger-full-access fallback and every updated §5 high-risk category
//     (deletion / privilege escalation / dependency install or change /
//     mutating git / database & cloud CLI / secrets & config read-write /
//     out-of-workspace writes / sandbox widening).
//   - usage block: exact §4 field set + values assembled from the EXISTING
//     shell caches (token-stats day buckets, cost snapshot rates/rollups),
//     the stale marker semantics, and the no-data null.
//   - pending: add / idempotency on eventId / removal / sort order / the shared
//     answer surface (respondToRuntime delegation + removal on success).
//   - tool phrases: shared M5 extraction + §6 i18n key coverage (zh/en same
//     key sets).
//   - privacy: the injected blocks survive the redactor without leaking new
//     fields; task text structurally never enters a pending item.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const risk = require('../src/office/runtime/approval-risk.js');
const usageSnapshot = require('../src/office/runtime/usage-snapshot.js');
const phrases = require('../src/office/runtime/tool-phrases.js');
const { createPendingMirror } = require('../src/office/runtime/pending-mirror.js');
const officeModule = require('../src/office/office-module.js');
const { createPrivacyRedactor } = require('../src/office/runtime/privacy-redactor.js');
const { STRINGS } = require('../src/i18n.js');

const { classifyRisk } = risk;
const { buildOfficeUsage } = usageSnapshot;

// A fixed clock keeps dayKey / staleAt deterministic: 2026-09-23 10:00 Beijing.
const NOW_MS = Date.UTC(2026, 8, 23, 2, 0, 0); // = 2026-09-23T02:00Z = 10:00 CST
const BILLING_DAY = '2026-09-23';

function makeModule(overrides = {}) {
  return officeModule.createOfficeModule({
    seed: 'office-right-panel-p1-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    ...overrides,
  });
}

/** collect() cache output shaped like token-stats: totals.days carries the R4
 * per-day billing buckets. */
function collectFixture() {
  return {
    totals: {
      input: 4_000_000, output: 800_000, cacheRead: 1_000_000, cacheWrite: 0,
      peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      days: {
        '2026-09-22': { input: 1_000_000, output: 200_000, cacheRead: 0, cacheWrite: 0 },
        [BILLING_DAY]: { input: 3_000_000, output: 600_000, cacheRead: 1_000_000, cacheWrite: 0 },
      },
    },
    sessions: [],
    sessionCount: 3,
  };
}

function costSnapshotFixture() {
  return {
    today: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0, peakCost: 0 },
    week: { cost: 0 },
    month: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 40, peakCost: 0 },
    currency: '¥',
    rates: { inputPerM: 2, outputPerM: 8, cacheReadPerM: 0.04, cacheWritePerM: 0 },
  };
}

const SETTINGS_FIXTURE = {
  costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.04, costCacheWritePerM: 0,
  monthlyBudget: 100,
};

// ---------------------------------------------------------------------------
// classifyRisk — spec §5 table (low / medium / high, updated high-risk list)
// ---------------------------------------------------------------------------

const RISK_CASES = [
  // ---- low: read-only tools + ask_user_question ------------------------------
  { input: { toolName: 'read', preset: 'workspace-write' }, expect: 'low', why: 'read-only tool' },
  { input: { toolName: 'grep', preset: 'workspace-write' }, expect: 'low', why: 'grep is read-only' },
  { input: { toolName: 'fs-search', preset: 'read-only' }, expect: 'low', why: 'fs-search is read-only' },
  { input: { toolName: 'web-search', preset: 'read-only' }, expect: 'low', why: 'web-search is read-only' },
  { input: { toolName: 'ask_user_question', preset: 'workspace-write' }, expect: 'low', why: 'question tools render as an inline form' },
  { input: { toolName: 'ask_user_question', preset: 'danger-full-access' }, expect: 'low', why: 'a question is not execution — only 执行/写 escalate under full access' },

  // ---- medium: workspace writes + sandboxed execution ------------------------
  { input: { toolName: 'bash', preset: 'workspace-write' }, expect: 'medium', why: 'sandboxed execution (T2)' },
  { input: { toolName: 'bash', preset: 'read-only' }, expect: 'medium', why: 'a command may run without writes under read-only' },
  { input: { toolName: 'bash', command: 'ls -la', preset: 'workspace-write' }, expect: 'medium', why: 'read-only command inside the sandbox' },
  { input: { toolName: 'bash', command: 'git status', preset: 'workspace-write' }, expect: 'medium', why: 'read-only git subcommand stays eligible' },
  { input: { toolName: 'bash', command: 'npm test', preset: 'workspace-write' }, expect: 'medium', why: 'running tests is not an install' },
  { input: { toolName: 'edit', preset: 'workspace-write' }, expect: 'medium', why: 'workspace write' },
  { input: { toolName: 'write', preset: 'workspace-write' }, expect: 'medium', why: 'workspace write' },
  { input: { toolName: 'some-unknown-mcp-tool', preset: 'workspace-write' }, expect: 'medium', why: 'unknown tools fail closed to the inline approval' },
  { input: { toolName: 'git', preset: 'workspace-write' }, expect: 'medium', why: 'bare git tool name is execution, not a mutating subcommand' },

  // ---- high: the updated §5 explicit list -------------------------------------
  { input: { toolName: 'rm', preset: 'workspace-write' }, expect: 'high', why: 'deletion' },
  { input: { toolName: 'rmdir', preset: 'workspace-write' }, expect: 'high', why: 'deletion' },
  { input: { toolName: 'sudo', preset: 'workspace-write' }, expect: 'high', why: 'privilege escalation' },
  { input: { toolName: 'npm', preset: 'workspace-write' }, expect: 'high', why: 'dependency install/change' },
  { input: { toolName: 'pip', preset: 'workspace-write' }, expect: 'high', why: 'dependency install/change' },
  { input: { toolName: 'cargo', preset: 'workspace-write' }, expect: 'high', why: 'dependency install/change' },
  { input: { toolName: 'install_deps', preset: 'workspace-write' }, expect: 'high', why: 'install-shaped tool name' },
  { input: { toolName: 'psql', preset: 'workspace-write' }, expect: 'high', why: 'database CLI' },
  { input: { toolName: 'kubectl', preset: 'workspace-write' }, expect: 'high', why: 'cloud CLI' },
  { input: { toolName: 'aws', preset: 'workspace-write' }, expect: 'high', why: 'cloud CLI' },
  { input: { toolName: 'gcloud', preset: 'workspace-write' }, expect: 'high', why: 'cloud CLI' },
  { input: { toolName: 'read_env', preset: 'workspace-write' }, expect: 'high', why: 'secret/config read is high too' },
  { input: { toolName: 'edit_settings', preset: 'workspace-write' }, expect: 'high', why: 'settings write' },
  { input: { toolName: 'write_credentials', preset: 'workspace-write' }, expect: 'high', why: 'credentials write' },
  { input: { toolName: 'bash', command: 'rm -rf build/', preset: 'workspace-write' }, expect: 'high', why: 'deletion inside the command' },
  { input: { toolName: 'bash', command: 'sudo apt install nginx', preset: 'workspace-write' }, expect: 'high', why: 'privilege escalation + dependency install' },
  { input: { toolName: 'bash', command: 'pip install requests', preset: 'workspace-write' }, expect: 'high', why: 'dependency install' },
  { input: { toolName: 'bash', command: 'git push --force origin main', preset: 'workspace-write' }, expect: 'high', why: 'mutating git' },
  { input: { toolName: 'bash', command: 'git reset --hard HEAD~3', preset: 'workspace-write' }, expect: 'high', why: 'mutating git' },
  { input: { toolName: 'bash', command: 'git clean -fd', preset: 'workspace-write' }, expect: 'high', why: 'mutating git' },
  { input: { toolName: 'bash', command: 'kubectl delete pod web-1', preset: 'workspace-write' }, expect: 'high', why: 'cloud CLI' },
  { input: { toolName: 'bash', command: 'aws s3 rm s3://bucket/key', preset: 'workspace-write' }, expect: 'high', why: 'cloud CLI' },
  { input: { toolName: 'bash', command: 'cp .env .env.bak', preset: 'workspace-write' }, expect: 'high', why: 'secret file read/write' },
  { input: { toolName: 'edit', command: 'apply patch', targetPath: '/etc/hosts', workspacePath: '/Users/x/proj', preset: 'workspace-write' }, expect: 'high', why: 'write outside the workspace' },
  { input: { toolName: 'bash', preset: 'danger-full-access' }, expect: 'high', why: 'any execution under danger-full-access' },
  { input: { toolName: 'edit', preset: 'danger-full-access' }, expect: 'high', why: 'any write under danger-full-access' },
  { input: { toolName: 'mystery-tool', preset: 'danger-full-access' }, expect: 'high', why: 'unknown + full access = never assume state-free' },
  { input: { toolName: 'edit', preset: 'read-only' }, expect: 'high', why: 'write under read-only = sandbox widening request' },
  { input: { toolName: 'write', preset: 'read-only' }, expect: 'high', why: 'write under read-only = sandbox widening request' },
];

test('classifyRisk: §5 table-driven cases (low/medium/high, medium+high skewed)', () => {
  const byLevel = { low: 0, medium: 0, high: 0 };
  for (const { input, expect, why } of RISK_CASES) {
    const actual = classifyRisk(input);
    assert.equal(actual, expect, `classifyRisk(${JSON.stringify(input)}) → ${actual}, want ${expect} (${why})`);
    byLevel[expect] += 1;
  }
  // spec §5 实施备注 2 + cross-tool memo §1 ③: samples must lean medium/high.
  assert.ok(byLevel.low >= 3, `low cases must be ≥3 (got ${byLevel.low})`);
  assert.ok(byLevel.medium >= 3, `medium cases must be ≥3 (got ${byLevel.medium})`);
  assert.ok(byLevel.high >= 3, `high cases must be ≥3 (got ${byLevel.high})`);
  assert.ok(byLevel.medium + byLevel.high > byLevel.low, 'approvals concentrate in medium/high');
});

test('classifyRisk: output vocabulary is exactly low|medium|high and inputs are pure', () => {
  for (const input of [
    {}, { toolName: null }, { toolName: '' }, { preset: 'nonsense' },
    { toolName: 'BASH', preset: 'Workspace-Write' },
  ]) {
    const out = classifyRisk(input);
    assert.ok(['low', 'medium', 'high'].includes(out), `unexpected level for ${JSON.stringify(input)}: ${out}`);
  }
  // same input → same output, and never throws on junk types
  const a = classifyRisk({ toolName: 'bash', preset: 'workspace-write' });
  const b = classifyRisk({ toolName: 'bash', preset: 'workspace-write' });
  assert.equal(a, b);
  assert.equal(classifyRisk({ toolName: 42, preset: 7 }), classifyRisk({ toolName: 42, preset: 7 }));
});

// ---------------------------------------------------------------------------
// tool phrases — shared M5 extraction + spec §6 i18n keys
// ---------------------------------------------------------------------------

test('tool phrases: M5 journal extraction is the single shared implementation', () => {
  assert.equal(phrases.toolNameOfJournalData({ name: 'bash' }), 'bash');
  assert.equal(phrases.toolNameOfJournalData({ tool: 'edit' }), 'edit');
  assert.equal(phrases.toolNameOfJournalData({ name: 'bash', tool: 'edit' }), 'bash', 'data.name wins on 0.1.5');
  assert.equal(phrases.toolNameOfJournalData({}), null);
  assert.equal(phrases.toolNameOfJournalData(null), null);
});

test('tool phrases: tool name → short zh phrase + §6 i18n key', () => {
  assert.equal(phrases.toolPhraseZhOf('bash'), '执行命令');
  assert.equal(phrases.toolPhraseZhOf('edit'), '编辑文件');
  assert.equal(phrases.toolPhraseZhOf('read'), '查档案');
  assert.equal(phrases.toolPhraseZhOf('web-search'), '检索');
  assert.equal(phrases.toolPhraseZhOf('ask_user_question'), '等待你回答');
  assert.equal(phrases.toolPhraseZhOf('totally-unknown'), '其他');
  assert.equal(phrases.toolPhraseZhOf(null), '其他');
  assert.equal(phrases.toolPhraseI18nKeyOf('bash'), 'office.staff.currentTool.command');
  assert.equal(phrases.toolPhraseI18nKeyOf('read'), 'office.staff.currentTool.search');
  assert.equal(phrases.questionSummaryZh(), '等待你回答');
});

test('tool phrases: command-named tools never fall back to 其他', () => {
  for (const tool of ['rm', 'sudo', 'npm', 'pip', 'psql', 'kubectl', 'aws', 'git']) {
    assert.equal(phrases.toolPhraseZhOf(tool), '执行命令', `${tool} must read as a command, not 其他`);
  }
});

test('tool phrases: every phrase key exists in BOTH dictionaries with identical key sets', () => {
  for (const key of phrases.PHRASE_KEYS) {
    const i18nKey = phrases.TOOL_PHRASE_I18N_KEY[key];
    assert.ok(i18nKey.startsWith('office.staff.currentTool.'), `phrase key out of the §6 family: ${i18nKey}`);
    assert.ok(typeof STRINGS.zh[i18nKey] === 'string' && STRINGS.zh[i18nKey] !== '', `zh missing ${i18nKey}`);
    assert.ok(typeof STRINGS.en[i18nKey] === 'string' && STRINGS.en[i18nKey] !== '', `en missing ${i18nKey}`);
  }
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh/en dictionaries must cover the same keys');
  // spec §6 additions are all present in both dictionaries
  for (const key of [
    'office.usage.today', 'office.usage.spent', 'office.usage.saved', 'office.usage.cache',
    'office.usage.local', 'office.usage.cloud', 'office.usage.budget', 'office.usage.stale',
    'office.usage.basis.apiKey', 'office.usage.basis.subscription',
    'office.pending.title', 'office.pending.empty', 'office.pending.approve',
    'office.pending.reject', 'office.pending.review', 'office.pending.modal.steps',
    'office.pending.modal.impact', 'office.pending.modal.approveOnce',
    'office.timeline.more',
    'office.sync.ok', 'office.sync.late', 'office.sync.reconnecting',
  ]) {
    assert.ok(key in STRINGS.zh, `zh missing ${key}`);
    assert.ok(key in STRINGS.en, `en missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// usage block — spec §4 contract, assembled from existing shell caches
// ---------------------------------------------------------------------------

test('usage block: exact §4 field set and values from the existing caches', () => {
  const block = buildOfficeUsage({
    collectData: collectFixture(),
    costSnap: costSnapshotFixture(),
    balanceSnapshot: { isAvailable: true, currency: 'CNY', total: 42, granted: 60, toppedUp: 2, fetchedAt: NOW_MS },
    settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS,
    dataAtMs: NOW_MS,
  });
  assert.deepEqual(Object.keys(block).sort(), [
    'budget', 'dayKey', 'money', 'pricingBasis', 'savings', 'staleAt', 'tokens',
  ]);
  assert.equal(block.dayKey, BILLING_DAY, 'dayKey is the UTC+8 billing day');
  // today = 3_000_000 in / 600_000 out / 1_000_000 cacheRead (yesterday excluded)
  assert.deepEqual(block.tokens, { input: 3_000_000, output: 600_000, cacheRead: 1_000_000, total: 4_600_000 });
  // money = 3_000_000/1e6*2 + 600_000/1e6*8 + 1_000_000/1e6*0.04 = 6 + 4.8 + 0.04
  assert.deepEqual(block.money, { paid: 10.84, currency: 'CNY' });
  // cache savings = 1_000_000/1e6 * (2 - 0.04)
  assert.equal(block.savings.cacheRead, 1.96);
  assert.equal(block.savings.localModel, 0, 'no per-provider token source exists yet');
  assert.equal(block.savings.localModelBasis, 'cloud-equivalent');
  assert.deepEqual(block.budget, { kind: 'monthly', limit: 100, used: 40 });
  assert.equal(block.pricingBasis, 'api-key');
  assert.equal(block.staleAt, null, 'fresh data has no stale marker');
});

test('usage block: staleAt marks the 60s threshold crossing and nothing else', () => {
  const fresh = buildOfficeUsage({
    collectData: collectFixture(), costSnap: costSnapshotFixture(), settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS, dataAtMs: NOW_MS - 59_000,
  });
  assert.equal(fresh.staleAt, null, '59s old data is still fresh');
  const stale = buildOfficeUsage({
    collectData: collectFixture(), costSnap: costSnapshotFixture(), settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS, dataAtMs: NOW_MS - 90_000,
  });
  assert.equal(stale.staleAt, NOW_MS - 90_000 + 60_000, 'staleAt is the instant the 60s threshold was crossed');
  const unknown = buildOfficeUsage({
    collectData: collectFixture(), costSnap: costSnapshotFixture(), settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS, dataAtMs: 0,
  });
  assert.equal(unknown.staleAt, null, 'unknown refresh time never claims staleness');
});

test('usage block: no data → null (the snapshot stays honest instead of showing zeros)', () => {
  assert.equal(buildOfficeUsage({}), null);
  assert.equal(buildOfficeUsage({ collectData: null, costSnap: null, settings: SETTINGS_FIXTURE }), null);
});

test('usage block: budget degrades to none without a configured budget; rates fall back to settings', () => {
  const noBudget = buildOfficeUsage({
    collectData: collectFixture(), settings: { costInputPerM: 2, costOutputPerM: 8, costCacheReadPerM: 0.04 },
    nowMs: NOW_MS, dataAtMs: NOW_MS,
  });
  assert.deepEqual(noBudget.budget, { kind: 'none', limit: 0, used: 0 });
  // rates without a cost snapshot come from settings: same 10.84 estimate
  assert.equal(noBudget.money.paid, 10.84);
  const noToday = buildOfficeUsage({
    collectData: { totals: { days: { '2026-09-22': { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } } } },
    settings: SETTINGS_FIXTURE, nowMs: NOW_MS, dataAtMs: NOW_MS,
  });
  assert.deepEqual(noToday.tokens, { input: 0, output: 0, cacheRead: 0, total: 0 });
  assert.equal(noToday.money.paid, 0);
});

// ---------------------------------------------------------------------------
// office module: usage / pending snapshot blocks
// ---------------------------------------------------------------------------

test('office snapshot: usage/pending start empty and carry the injected block verbatim', () => {
  const mod = makeModule();
  const before = mod.state();
  assert.equal(before.usage, null, 'usage is null until the shell injects data');
  assert.deepEqual(before.pending, [], 'pending starts empty');

  assert.deepEqual(mod.setUsageSnapshot({ nonsense: true }), { ok: false, code: 'USAGE_INVALID' });
  assert.equal(mod.state().usage, null, 'a rejected block leaves the snapshot at null');

  const block = buildOfficeUsage({
    collectData: collectFixture(), costSnap: costSnapshotFixture(), settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS, dataAtMs: NOW_MS,
  });
  assert.deepEqual(mod.setUsageSnapshot(block), { ok: true });
  const after = mod.state();
  assert.deepEqual(after.usage, block, 'the injected block reaches state() with the §4 contract intact');
  assert.equal(after.usage.tokens.total, 4_600_000, 'token counts survive (aggregate usage is spec-authorized)');
});

test('office pending: approval request writes the exact §4 contract item', () => {
  const mod = makeModule();
  const res = mod.notePendingRequest({
    eventId: 'evt-approval-1',
    kind: 'approval',
    sessionId: 'sess-not-bound',
    toolName: 'bash',
    preset: 'workspace-write',
    rpcId: 'evt-approval-1',
    clientId: 'client-abc-123',
    atMs: NOW_MS,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'added');
  const [item] = mod.state().pending;
  assert.deepEqual(Object.keys(item).sort(), [
    'clientId', 'createdAtMs', 'detailRef', 'employeeId', 'eventId', 'id', 'kind',
    'risk', 'summary', 'toolName',
  ]);
  assert.equal(item.id, 'evt-approval-1');
  assert.equal(item.eventId, 'evt-approval-1');
  assert.equal(item.clientId, 'client-abc-123');
  assert.equal(item.kind, 'approval');
  assert.equal(item.toolName, 'bash');
  assert.equal(item.summary, '执行命令');
  assert.equal(item.detailRef, 'office:pending-detail');
  assert.equal(item.risk, 'medium');
  assert.equal(item.createdAtMs, NOW_MS);
  assert.equal(item.employeeId, null, 'no live binding → no employee');
});

test('office pending: idempotent per eventId — a re-delivery never duplicates', () => {
  const mod = makeModule();
  const first = mod.notePendingRequest({ eventId: 'evt-1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-1', atMs: NOW_MS });
  const again = mod.notePendingRequest({ eventId: 'evt-1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-1', atMs: NOW_MS });
  assert.equal(first.status, 'added');
  assert.equal(again.ok, true);
  assert.equal(again.status, 'duplicate', 'same eventId → duplicate, not a second card');
  assert.equal(mod.state().pending.length, 1);
  // a DIFFERENT event for the same session still lands
  mod.notePendingRequest({ eventId: 'evt-2', kind: 'approval', sessionId: 's1', toolName: 'edit', rpcId: 'evt-2', atMs: NOW_MS + 10 });
  assert.equal(mod.state().pending.length, 2);
});

test('office pending: questions carry no runtime text and classify low', () => {
  const mod = makeModule();
  mod.notePendingRequest({
    eventId: 'evt-q-1', kind: 'question', sessionId: 's1', rpcId: 'evt-q-1',
    // poison payload: the question body must never reach the snapshot
    questions: [{ id: 'q1', question: 'FIXTURE-QUESTION which branch?', options: [{ label: 'main' }] }],
    atMs: NOW_MS,
  });
  const [item] = mod.state().pending;
  assert.equal(item.kind, 'question');
  assert.equal(item.summary, '等待你回答');
  assert.equal(item.risk, 'low');
  assert.equal(item.toolName, 'ask_user_question', 'a question pending is an ask_user_question by definition');
  const serialized = JSON.stringify(mod.state());
  assert.equal(serialized.includes('FIXTURE-QUESTION'), false, 'the question body never enters the snapshot');
  assert.equal(serialized.includes('which branch'), false);
});

test('office pending: the bound employee is resolved from the registry', () => {
  const mod = makeModule();
  // A running turn binds the session to a resident employee (registry root binding).
  mod.ingestHarnessEvent({
    sessionId: 'sess-bound-1', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' },
  });
  const bound = mod.notePendingRequest({
    eventId: 'evt-b-1', kind: 'approval', sessionId: 'sess-bound-1', toolName: 'bash', rpcId: 'evt-b-1', atMs: NOW_MS,
  });
  const employeeId = bound.item.employeeId;
  assert.ok(typeof employeeId === 'string' && employeeId.length > 0, 'a live binding resolves an employee');
  assert.ok(['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator'].includes(employeeId));
  const serialized = JSON.stringify(mod.state());
  assert.equal(serialized.includes('sess-bound-1'), false, 'the raw session id never leaves the module');
});

test('office pending: sorted by risk desc then age asc (spec §3 rule)', () => {
  const mod = makeModule();
  mod.notePendingRequest({ eventId: 'evt-low', kind: 'question', sessionId: 's1', rpcId: 'evt-low', atMs: NOW_MS });
  mod.notePendingRequest({ eventId: 'evt-med', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-med', atMs: NOW_MS + 1 });
  mod.notePendingRequest({ eventId: 'evt-high-1', kind: 'approval', sessionId: 's1', toolName: 'rm', rpcId: 'evt-high-1', atMs: NOW_MS + 2 });
  mod.notePendingRequest({ eventId: 'evt-high-0', kind: 'approval', sessionId: 's1', toolName: 'sudo', rpcId: 'evt-high-0', atMs: NOW_MS + 3 });
  assert.deepEqual(mod.state().pending.map((item) => item.id), [
    'evt-high-1', 'evt-high-0', 'evt-med', 'evt-low',
  ]);
});

test('office pending: removal by eventId or routing rpcId, and the backlog stays bounded', () => {
  const mod = makeModule();
  mod.notePendingRequest({ eventId: 'evt-mux-1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-mux-1', atMs: NOW_MS });
  mod.notePendingRequest({ eventId: '', kind: 'approval', sessionId: 's1', toolName: 'edit', rpcId: 'rpc-legacy-7', atMs: NOW_MS + 1 });
  assert.equal(mod.state().pending.length, 2);
  const removed = mod.resolvePending('evt-mux-1');
  assert.equal(removed.id, 'evt-mux-1');
  assert.equal(mod.state().pending.length, 1);
  // the legacy item is answerable through its rpcId (0.1.1 server-request id)
  const legacy = mod.state().pending[0];
  assert.equal(legacy.eventId, null);
  assert.equal(mod.resolvePending('rpc-legacy-7').id, legacy.id);
  assert.deepEqual(mod.state().pending, []);
  assert.equal(mod.resolvePending('never-seen'), null, 'unknown ids are a no-op');

  for (let i = 0; i < 60; i += 1) {
    mod.notePendingRequest({ eventId: `evt-cap-${i}`, kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: `evt-cap-${i}`, atMs: NOW_MS + i });
  }
  assert.equal(mod.state().pending.length, 50, 'the pending list is capped (oldest dropped)');
  assert.equal(mod.state().pending[0].id, 'evt-cap-10');
});

test('office pending: invalid requests are rejected without touching the list', () => {
  const mod = makeModule();
  assert.equal(mod.notePendingRequest(null).ok, false);
  assert.equal(mod.notePendingRequest({ eventId: 'x', kind: 'side-quest' }).code, 'KIND_INVALID');
  assert.equal(mod.notePendingRequest({ kind: 'approval' }).code, 'EVENT_ID_MISSING', 'neither eventId nor rpcId → no stable id');
  assert.deepEqual(mod.state().pending, []);
});

test('office pending: the shared answer surface delegates to respondToRuntime and removes on success', async () => {
  const calls = [];
  const mod = makeModule({
    answerRequest: async ({ rpcId, value, what }) => {
      calls.push({ rpcId, value, what });
      return { ok: true };
    },
  });
  mod.notePendingRequest({ eventId: 'evt-ans-1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-ans-1', atMs: NOW_MS });
  const res = await mod.answerPending({ id: 'evt-ans-1', value: 'allowed-once' });
  assert.deepEqual(res, { ok: true });
  assert.equal(calls.length, 1, 'the panel answer goes through the injected shared channel');
  assert.equal(calls[0].rpcId, 'evt-ans-1', 'the routing id is the waterfall eventId');
  assert.equal(calls[0].value, 'allowed-once');
  assert.deepEqual(mod.state().pending, [], 'a successful answer removes the pending item');
});

test('office pending: a refused answer keeps the item pending', async () => {
  const mod = makeModule({ answerRequest: async () => ({ ok: false, reason: 'runtime refused' }) });
  mod.notePendingRequest({ eventId: 'evt-ans-2', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-ans-2', atMs: NOW_MS });
  const res = await mod.answerPending({ id: 'evt-ans-2', value: 'rejected' });
  assert.deepEqual(res, { ok: false, reason: 'runtime refused' });
  assert.equal(mod.state().pending.length, 1, 'still pending — the request is still live');
  const missing = await mod.answerPending({ id: 'evt-nope', value: 'rejected' });
  assert.equal(missing.ok, false);
  const noChannel = makeModule();
  noChannel.notePendingRequest({ eventId: 'evt-ans-3', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-ans-3', atMs: NOW_MS });
  const unavailable = await noChannel.answerPending({ id: 'evt-ans-3', value: 'allowed-once' });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'answer channel unavailable');
});

// ---------------------------------------------------------------------------
// privacy: the new blocks survive the redactor without leaking new fields
// ---------------------------------------------------------------------------

test('privacy: usage aggregates and pending handles survive redaction; prose does not', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  const block = buildOfficeUsage({
    collectData: collectFixture(), costSnap: costSnapshotFixture(), settings: SETTINGS_FIXTURE,
    nowMs: NOW_MS, dataAtMs: NOW_MS,
  });
  const safeUsage = redactor.redactValue(block);
  assert.equal(safeUsage.dayKey, BILLING_DAY, 'the billing-day key is a coarse bucket, not an identifier');
  assert.deepEqual(safeUsage.tokens, block.tokens, 'aggregate token counts survive');
  assert.equal(safeUsage.money.currency, 'CNY');
  assert.equal(safeUsage.pricingBasis, 'api-key');
  assert.equal(safeUsage.savings.localModelBasis, 'cloud-equivalent');
  assert.equal(redactor.redactValue({ dayKey: BILLING_DAY }).dayKey, BILLING_DAY);
  // the coarse enums the P1 blocks need are whitelisted, but prose still dies
  assert.equal(redactor.redactValue({ note: 'FIXTURE-TASK-TEXT' }).note, '[REDACTED:text]');
  assert.equal(redactor.redactValue({ cwd: '/Users/x/secret-project' }).cwd, '[REDACTED:path]');
  assert.equal(redactor.redactValue({ sessionId: 'sess-FIXTURE-001' }).sessionId, '[REDACTED:session-id]');

  const mod = makeModule();
  mod.setUsageSnapshot(block);
  mod.notePendingRequest({
    eventId: 'evt-priv-1', kind: 'approval', sessionId: 'sess-priv-1', toolName: 'bash',
    rpcId: 'evt-priv-1', clientId: 'client-0f3a9c11-22b4-4d5e-8f70-1a2b3c4d5e6f', atMs: NOW_MS,
  });
  const snapshot = mod.state();
  assert.deepEqual(snapshot.usage, block, 'the module projection keeps the §4 block intact');
  assert.equal(snapshot.pending[0].eventId, 'evt-priv-1');
  assert.equal(snapshot.pending[0].clientId, 'client-0f3a9c11-22b4-4d5e-8f70-1a2b3c4d5e6f',
    'the shell-owned answer handle survives the projection');
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('sess-priv-1'), false, 'no raw session id');
  assert.equal(/"sessionId"/.test(serialized), false, 'no sessionId field at all');
  assert.equal(serialized.includes('/Users/'), false, 'no absolute paths');
  assert.equal(serialized.includes('FIXTURE'), false, 'no fixture prose anywhere');
});

// ---------------------------------------------------------------------------
// pre-module pending mirror — requests that arrive before the office opens
// ---------------------------------------------------------------------------

/** One normalized arrival record, exactly what main.js officeNotePending builds
 * before handing it to the mirror (or the live module). */
function arrival(eventId, kind, { rpcId, sessionId = 'sess-mirror-1', toolName, preset = 'workspace-write', atMs = NOW_MS, clientId = 'mux-client-42' } = {}) {
  return { eventId, rpcId: rpcId || eventId, kind, sessionId, toolName, preset, clientId, atMs };
}

test('pre-module mirror: arrivals before the office opens are seeded in risk order', () => {
  const mirror = createPendingMirror({});
  const mod = makeModule();
  // A live binding first: the seed must resolve the employee like a live arrival.
  mod.ingestHarnessEvent({
    sessionId: 'sess-bound-2', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' },
  });
  // 3 approvals + 1 question arrive while NO office module exists.
  assert.equal(mirror.note(arrival('evt-m-1', 'approval', { toolName: 'bash', atMs: NOW_MS })).status, 'added');
  assert.equal(mirror.note(arrival('evt-m-2', 'question', { atMs: NOW_MS + 1 })).status, 'added');
  assert.equal(mirror.note(arrival('evt-m-3', 'approval', { toolName: 'rm', atMs: NOW_MS + 2 })).status, 'added');
  assert.equal(mirror.note(arrival('evt-m-4', 'approval', {
    toolName: 'bash', sessionId: 'sess-bound-2', preset: 'danger-full-access', atMs: NOW_MS + 3,
  })).status, 'added');
  assert.equal(mirror.size(), 4);

  // The office view opens now: create + seed. All four are waiting, sorted by
  // the same risk-desc / age-asc rule as live arrivals.
  const result = mirror.seed((record) => mod.notePendingRequest(record));
  assert.deepEqual(result, { seeded: 4, failed: 0 });
  assert.equal(mirror.size(), 0, 'the module is the live store after seeding');
  const pending = mod.state().pending;
  assert.deepEqual(pending.map((item) => [item.id, item.risk, item.summary]), [
    ['evt-m-3', 'high', '执行命令'],
    ['evt-m-4', 'high', '执行命令'],   // bash under danger-full-access
    ['evt-m-1', 'medium', '执行命令'],
    ['evt-m-2', 'low', '等待你回答'],
  ]);
  // the seeded bound item resolves its employee, the unbound ones stay null
  const boundItem = pending.find((item) => item.id === 'evt-m-4');
  assert.ok(typeof boundItem.employeeId === 'string' && boundItem.employeeId.length > 0,
    'the seed resolves the employee like a live arrival');
  assert.equal(pending.find((item) => item.id === 'evt-m-1').employeeId, null);
});

test('pre-module mirror: a record the module rejects stays in the mirror instead of vanishing', () => {
  const mirror = createPendingMirror({});
  const mod = makeModule();
  mirror.note(arrival('evt-m-ok', 'approval', { toolName: 'bash' }));
  mirror.note(arrival('evt-m-bad', 'side-quest', { toolName: 'bash' }));
  const result = mirror.seed((record) => mod.notePendingRequest(record));
  assert.deepEqual(result, { seeded: 1, failed: 1 });
  assert.equal(mirror.size(), 1, 'the rejected record is retained');
  assert.equal(mirror.has('evt-m-bad'), true);
  assert.equal(mod.state().pending.length, 1);
});

test('pre-module mirror: idempotent before AND after the module takes over', () => {
  const mirror = createPendingMirror({});
  const record = arrival('evt-m-idem', 'approval', { toolName: 'bash' });
  assert.equal(mirror.note(record).status, 'added');
  assert.equal(mirror.note(record).status, 'duplicate', 'a re-delivered event never occupies two slots');
  assert.equal(mirror.size(), 1);
  const mod = makeModule();
  assert.equal(mirror.seed((r) => mod.notePendingRequest(r)).seeded, 1);
  assert.equal(mod.state().pending.length, 1);
  // the live module keeps the same idempotency for the same eventId
  assert.equal(mod.notePendingRequest(record).status, 'duplicate');
  assert.equal(mod.state().pending.length, 1);
  // and re-seeding an emptied mirror changes nothing
  assert.equal(mirror.seed((r) => mod.notePendingRequest(r)).seeded, 0);
  assert.equal(mod.state().pending.length, 1);
});

test('pre-module mirror: answering before the office opens removes it from the mirror (and it never resurrects)', () => {
  const mirror = createPendingMirror({});
  mirror.note(arrival('evt-m-ans', 'approval', { toolName: 'bash' }));
  mirror.note(arrival('evt-m-keep', 'approval', { toolName: 'edit' }));
  // The shared answer path resolves the runtime id before any module exists.
  assert.equal(mirror.resolve('evt-m-ans').eventId, 'evt-m-ans');
  assert.equal(mirror.resolve('evt-m-ans'), null, 'unknown ids are a no-op');
  assert.equal(mirror.size(), 1);
  // Later seeding never resurrects the answered request.
  const mod = makeModule();
  mirror.seed((record) => mod.notePendingRequest(record));
  assert.deepEqual(mod.state().pending.map((item) => item.id), ['evt-m-keep']);
  // The mirrored store is empty now, so the live module's own answer path (the
  // shared respondToRuntime delegation) is what clears items from here on —
  // covered by the shared-answer-surface test above.
});

test('pre-module mirror: the bound is the shared 50 and evicts oldest first', () => {
  const mirror = createPendingMirror({});
  for (let i = 0; i < 60; i += 1) {
    mirror.note(arrival(`evt-cap-${i}`, 'approval', { toolName: 'bash', atMs: NOW_MS + i }));
  }
  assert.equal(mirror.limit, 50, 'same cap as the module');
  assert.equal(mirror.size(), 50);
  assert.equal(mirror.has('evt-cap-0'), false, 'oldest evicted first');
  assert.equal(mirror.has('evt-cap-10'), true);
  const mod = makeModule();
  assert.equal(mirror.seed((record) => mod.notePendingRequest(record)).seeded, 50);
  assert.equal(mod.state().pending.length, 50);
  assert.equal(mod.state().pending[0].id, 'evt-cap-10');
});

test('pre-module mirror: arrivals without a stable id are rejected', () => {
  const mirror = createPendingMirror({});
  assert.equal(mirror.note(null).ok, false);
  assert.equal(mirror.note({ kind: 'approval', sessionId: 's' }).ok, false);
  assert.equal(mirror.note({ kind: 'approval', sessionId: 's' }).code, 'EVENT_ID_MISSING');
  assert.equal(mirror.resolve(''), null);
  assert.equal(mirror.size(), 0);
  // rpcId-only arrivals (0.1.1) are held under the rpcId
  assert.equal(mirror.note({ rpcId: 'rpc-1', kind: 'approval', sessionId: 's', toolName: 'bash' }).ok, true);
  assert.equal(mirror.has('rpc-1'), true);
});

// ---------------------------------------------------------------------------
// main.js wiring — the shell side of the P1 pipeline (static contract pins)
// ---------------------------------------------------------------------------

test('main.js wires the P1 pipeline into the shared paths', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // usage: assembled after every cost snapshot, from the existing caches
  assert.ok(src.includes('injectOfficeUsage(stats);'), 'the token poll injects the office usage block');
  assert.ok(src.includes('buildOfficeUsage({'), 'main.js assembles the block (no new collection)');
  // pending: mirrored at arrival, removed through the shared answer path
  // (P3 passes the frame's agentId — an Agent id IS its SessionId — so the
  // pending item binds to the employee and correlates its detailRef).
  assert.ok(src.includes("officeNotePending({ kind: 'approval', frame, rpcId, agentId });"), 'approval requests mirror into pending');
  assert.ok(src.includes("officeNotePending({ kind: 'question', frame, rpcId, agentId });"), 'question requests mirror into pending');
  assert.ok(src.includes('officeResolvePending(rpcId);'), 'answers remove pending through respondToRuntime');
  assert.ok(src.includes('officeResolvePending(value.eventId);'), 'host revocations remove pending too');
  // pre-module mirror: held before the first office view, seeded at creation,
  // resolved through the same shared answer path
  assert.ok(src.includes('const officePendingMirror = createPendingMirror({ log });'), 'main.js owns the bounded mirror');
  assert.ok(src.includes('officePendingMirror.note(record);'), 'arrivals with no live module land in the mirror');
  assert.ok(src.includes('seedOfficePendingMirror(officeModuleInstance);'), 'the module is seeded when it is created');
  assert.ok(src.includes('officePendingMirror.resolve(id);'), 'answers/revocations clear the mirror too');
  // the panel answer surface IS respondToRuntime (one shared implementation)
  assert.ok(src.includes('answerRequest: ({ rpcId, value, what }) => respondToRuntime({ rpcId, value, what }),'),
    'the office module answers through the same respondToRuntime the IM path uses');
  // M5 tool-name extraction now comes from the shared module
  assert.ok(src.includes('data: { tool: toolNameOfJournalData(data) },'), 'the M5 tool extraction is shared');
});
