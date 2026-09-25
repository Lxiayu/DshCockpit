'use strict';

// test/office-right-panel-p3.test.js — P3 待你处理收件箱 contract tests for the
// office right-panel rework (docs/strategy/2026-09-23-office-right-panel-spec.md
// §3 块③ / §4 数据契约 detailRef / §5 审批危险分级 / §6 i18n / §7 测试计划 /
// §8 P3 行), cross-checked against 2026-09-23-approval-ux-cross-tool.md
// (审批期间阻塞输入框、权限请求不设超时、模态带撤销说明).
//
// Covers, module-layer only (no Electron):
//   - the office:pending IPC channel (the DELIBERATE eight-channel widening):
//     answer + detail payload validation, registration, and the module-side
//     gates (unknown pending ids are a no-op; the answer value is gated to the
//     harness outcome vocabulary per kind; the detail payload is
//     allowlist-normalized so a resolver bug cannot widen the boundary).
//   - classifyRisk: the §5 high row ④ sandbox-widening flag (derived by main.js
//     from the harness's own escalation reason phrasing) without changing the
//     P1 table behaviour.
//   - the shared answer surface: inline approve/reject, the danger modal's
//     仅本次批准/拒绝 and the question form all route through ONE
//     respondToRuntime delegation (no second implementation), and the pending
//     snapshot never carries command/question text (detailRef only).
//   - the page controller: answerPending / pendingDetail bridge calls and the
//     danger-modal view model (steps / impact / command / target / reversible /
//     no-args honesty).
//   - office.html: the modal DOM (role=dialog, no "always allow"), the inline
//     actions, the input blocking while the modal is open and Escape closing
//     without answering (approvals never time out).
//   - main.js wiring: the detailRef correlation (sessionId + callId →
//     same-turn tool/call arguments, with the session/page fallback) and the
//     journal capture that feeds it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const officeModule = require('../src/office/office-module.js');
const risk = require('../src/office/runtime/approval-risk.js');
const officePage = require('../src/office/office-page.js');
const { createPrivacyRedactor } = require('../src/office/runtime/privacy-redactor.js');
const { STRINGS } = require('../src/i18n.js');

const { classifyRisk } = risk;

const NOW_MS = Date.UTC(2026, 8, 23, 2, 0, 0);

function makeModule(overrides = {}) {
  return officeModule.createOfficeModule({
    seed: 'office-right-panel-p3-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// §5 high row ④ — the sandbox-widening flag (harness escalation ask)
// ---------------------------------------------------------------------------

test('classifyRisk: a sandbox-widening request is high regardless of tool/preset', () => {
  for (const input of [
    { toolName: 'bash', preset: 'workspace-write', sandboxWidening: true },
    { toolName: 'edit', preset: 'workspace-write', sandboxWidening: true },
    { toolName: 'ls', preset: 'read-only', sandboxWidening: true },
    { toolName: 'unknown-tool', preset: null, sandboxWidening: true },
  ]) {
    assert.equal(classifyRisk(input), 'high',
      `sandboxWidening must escalate ${JSON.stringify(input)} (§5 ④: 任何沙箱放宽请求)`);
  }
  // without the flag the P1 table is untouched (escalation only on the flag)
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'workspace-write', sandboxWidening: false }), 'medium');
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'workspace-write' }), 'medium');
  // junk values never escalate
  assert.equal(classifyRisk({ toolName: 'bash', preset: 'workspace-write', sandboxWidening: 'yes' }), 'medium');
});

test('office pending: the widening flag reaches classifyRisk through notePendingRequest', () => {
  const mod = makeModule();
  const plain = mod.notePendingRequest({
    eventId: 'evt-plain', kind: 'approval', sessionId: 's1', toolName: 'bash', preset: 'workspace-write', rpcId: 'evt-plain', atMs: NOW_MS,
  });
  assert.equal(plain.item.risk, 'medium', 'a sandboxed bash execution stays the inline approval');
  const widening = mod.notePendingRequest({
    eventId: 'evt-wide', kind: 'approval', sessionId: 's1', toolName: 'bash', preset: 'workspace-write',
    sandboxWidening: true, rpcId: 'evt-wide', atMs: NOW_MS + 1,
  });
  assert.equal(widening.item.risk, 'high', 'the harness escalation ask is the §5 high row ④ — the modal path');
  // the snapshot item shape is unchanged (no raw reason/session text rides
  // along). P1 English pass adds ONE fixed-vocabulary field: `summaryKey`, the
  // office.staff.currentTool.* key behind the summary phrase (stable label key
  // for the panel's per-language rendering — never runtime text).
  assert.deepEqual(Object.keys(widening.item).sort(), [
    'clientId', 'createdAtMs', 'detailRef', 'employeeId', 'eventId', 'id', 'kind',
    'risk', 'summary', 'summaryKey', 'toolName',
  ]);
  assert.equal(widening.item.summaryKey, 'command');
});

// ---------------------------------------------------------------------------
// office:pending IPC — payload validation + registration (the 8th channel)
// ---------------------------------------------------------------------------

test('office:pending payload validation: answer and detail shapes', () => {
  const ok = (payload) => officeModule.validateOfficeIpcPayload('office:pending', payload);
  assert.deepEqual(ok({ action: 'detail', id: 'evt-1' }), { ok: true, value: { action: 'detail', id: 'evt-1' } });
  assert.deepEqual(ok({ action: 'answer', id: 'evt-1', value: 'allowed-once' }),
    { ok: true, value: { action: 'answer', id: 'evt-1', value: 'allowed-once' } });
  assert.equal(ok({ action: 'answer', id: 'evt-1', value: { answers: [{ id: 'q1', selected: ['main'] }] } }).ok, true,
    'a question answer batch is a valid value');
  // invalid shapes are rejected before reaching the module
  assert.equal(ok({ action: 'nope', id: 'x' }).ok, false);
  assert.equal(ok({ action: 'detail' }).ok, false, 'detail needs an id');
  assert.equal(ok({ action: 'detail', id: '' }).ok, false);
  assert.equal(ok({ action: 'detail', id: 'x'.repeat(129) }).ok, false);
  assert.equal(ok({ action: 'answer', id: 'evt-1' }).ok, false, 'answer needs a value');
  assert.equal(ok({ action: 'answer', id: 'evt-1', value: '' }).ok, false);
  assert.equal(ok({ action: 'answer', id: 'evt-1', value: 42 }).ok, false);
  assert.equal(ok({ action: 'answer', id: 'evt-1', value: 'allowed-once', extra: 1 }).ok, false, 'exact key set');
  assert.equal(ok({ id: 'evt-1', value: 'allowed-once' }).ok, false, 'action discriminator required');
  assert.equal(officeModule.validateOfficeIpcPayload('office:evil', { action: 'detail', id: 'x' }).ok, false);
});

test('registerOfficeIpc wires office:pending to the module answer + detail surface', async () => {
  const handles = new Map();
  const ipcMainStub = { handle(channel, handler) { handles.set(channel, handler); } };
  const answers = [];
  const mod = makeModule({
    answerRequest: async ({ rpcId, value }) => {
      answers.push({ rpcId, value });
      return { ok: true };
    },
    pendingDetail: (id) => (id === 'evt-live'
      ? { id, kind: 'approval', toolName: 'bash', command: 'touch ~/marker' }
      : null),
  });
  const registered = officeModule.registerOfficeIpc({ ipcMain: ipcMainStub, module: mod });
  assert.ok(registered.channels.includes('office:pending'), 'the channel is registered');
  mod.notePendingRequest({ eventId: 'evt-live', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-live', atMs: NOW_MS });

  const detail = await handles.get('office:pending')({}, { action: 'detail', id: 'evt-live' });
  assert.equal(detail.ok, true);
  assert.deepEqual(detail.detail, {
    id: 'evt-live', kind: 'approval', toolName: 'bash', reason: null, preset: null,
    command: 'touch ~/marker', commandSource: null, targetPath: null,
    requestedSandboxMode: null, questions: null, atMs: null, noToolArguments: false,
  });
  const unknown = await handles.get('office:pending')({}, { action: 'detail', id: 'evt-nope' });
  assert.deepEqual(unknown, { ok: false, code: 'UNKNOWN_PENDING_ID' }, 'unknown ids never leak existence');

  const answered = await handles.get('office:pending')({}, { action: 'answer', id: 'evt-live', value: 'allowed-once' });
  assert.deepEqual(answered, { ok: true });
  assert.deepEqual(answers, [{ rpcId: 'evt-live', value: 'allowed-once' }], 'the answer goes through the injected shared channel');
  assert.deepEqual(mod.state().pending, [], 'a successful answer removes the card from the snapshot');

  const bad = await handles.get('office:pending')({}, { action: 'answer', id: 'evt-live', value: 'allow-always' });
  assert.equal(bad.ok, false, 'a second answer of a removed card is a no-op');
});

// ---------------------------------------------------------------------------
// answerPending — the harness outcome vocabulary gate
// ---------------------------------------------------------------------------

test('answerPending: approvals accept exactly allowed-once|rejected (no allow-always exists)', async () => {
  const calls = [];
  const mod = makeModule({ answerRequest: async (req) => { calls.push(req); return { ok: true }; } });
  mod.notePendingRequest({ eventId: 'evt-v1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-v1', atMs: NOW_MS });
  for (const value of ['allow-always', 'allowed', 'ALLOWED-ONCE', '']) {
    const res = await mod.answerPending({ id: 'evt-v1', value });
    assert.equal(res.ok, false, `approval value ${JSON.stringify(value)} must be refused`);
    assert.equal(res.reason, 'unsupported answer value');
  }
  assert.equal(calls.length, 0, 'a refused value never reaches the runtime');
  assert.equal((await mod.answerPending({ id: 'evt-v1', value: 'allowed-once' })).ok, true);
  assert.deepEqual(calls, [{ rpcId: 'evt-v1', value: 'allowed-once', what: 'office pending answer (evt-v1)' }]);
});

test('answerPending: questions accept an answers batch and reject other shapes', async () => {
  const calls = [];
  const mod = makeModule({ answerRequest: async (req) => { calls.push(req); return { ok: true }; } });
  mod.notePendingRequest({ eventId: 'evt-q1', kind: 'question', sessionId: 's1', rpcId: 'evt-q1', atMs: NOW_MS });
  assert.equal((await mod.answerPending({ id: 'evt-q1', value: 'allowed-once' })).ok, false,
    'an approval outcome word is not a question answer');
  assert.equal((await mod.answerPending({ id: 'evt-q1', value: { answers: [] } })).ok, false);
  assert.equal((await mod.answerPending({ id: 'evt-q1', value: { answers: [{ selected: ['main'] }] } })).ok, false,
    'an answer entry needs its question id');
  assert.equal(calls.length, 0);
  const answers = [{ id: 'q1', selected: ['main'] }];
  assert.equal((await mod.answerPending({ id: 'evt-q1', value: { answers } })).ok, true);
  assert.deepEqual(calls, [{ rpcId: 'evt-q1', value: { answers }, what: 'office pending answer (evt-q1)' }]);
  assert.deepEqual(mod.state().pending, []);
});

// ---------------------------------------------------------------------------
// resolvePendingDetail — the spec §4 detailRef boundary
// ---------------------------------------------------------------------------

test('resolvePendingDetail: unknown ids, missing resolver and the allowlist normalization', async () => {
  const mod = makeModule();
  assert.deepEqual(await mod.resolvePendingDetail(''), { ok: false, code: 'DETAIL_ID_MISSING' });
  mod.notePendingRequest({ eventId: 'evt-d1', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-d1', atMs: NOW_MS });
  assert.deepEqual(await mod.resolvePendingDetail('evt-d1'), { ok: false, code: 'DETAIL_UNAVAILABLE' },
    'without an injected resolver the detail is unavailable (never fabricated)');
  assert.deepEqual(await mod.resolvePendingDetail('evt-nope'), { ok: false, code: 'UNKNOWN_PENDING_ID' });

  const withResolver = makeModule({
    pendingDetail: (id) => ({
      id,
      kind: 'approval',
      toolName: 'bash',
      command: 'x'.repeat(9000),
      // poison: fields outside the allowlist must never cross
      sessionId: 'sess-secret-1',
      arguments: 'rm -rf /',
      questions: [{ id: 'q', question: 'x' }],
      atMs: NOW_MS,
    }),
  });
  withResolver.notePendingRequest({ eventId: 'evt-d2', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-d2', atMs: NOW_MS });
  const res = await withResolver.resolvePendingDetail('evt-d2');
  assert.equal(res.ok, true);
  assert.equal(res.detail.sessionId, undefined, 'session ids never ride the detail');
  assert.equal(res.detail.arguments, undefined, 'only allowlisted fields cross');
  assert.equal(res.detail.questions, null, 'an approval detail carries no question batch');
  assert.ok(res.detail.command.length <= 4001, `the command is capped (got ${res.detail.command.length})`);
  assert.ok(res.detail.command.endsWith('…'), 'a truncated command says so');
});

test('resolvePendingDetail: a legacy 0.1.1 item is addressable by its derived id and rpcId', async () => {
  const mod = makeModule({
    pendingDetail: (id) => ({ id, kind: 'approval', toolName: 'bash', command: 'echo hi', noToolArguments: false }),
  });
  mod.notePendingRequest({ rpcId: 'rpc-legacy-9', kind: 'approval', sessionId: 's1', toolName: 'bash', atMs: NOW_MS });
  assert.equal(mod.state().pending[0].id, 'legacy:rpc-legacy-9');
  assert.equal((await mod.resolvePendingDetail('legacy:rpc-legacy-9')).ok, true);
  assert.equal((await mod.resolvePendingDetail('rpc-legacy-9')).ok, true, 'the raw rpcId form resolves too');
});

test('resolvePendingDetail: a throwing resolver degrades instead of breaking the page', async () => {
  const mod = makeModule({ pendingDetail: () => { throw new Error('resolver exploded'); } });
  mod.notePendingRequest({ eventId: 'evt-throw', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-throw', atMs: NOW_MS });
  assert.deepEqual(await mod.resolvePendingDetail('evt-throw'), { ok: false, code: 'DETAIL_UNAVAILABLE' });
});

test('resolvePendingDetail: an ASYNC resolver is awaited (a promise never reaches the normalizer)', async () => {
  // Regression: main.js's resolver is async (the session/page fallback is an
  // RPC). Calling it without awaiting let the promise through to the
  // allowlist normalizer, which read it as a kindless payload.
  const mod = makeModule({
    pendingDetail: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id, kind: 'approval', toolName: 'bash', command: 'echo async-ok', noToolArguments: false };
    },
  });
  mod.notePendingRequest({ eventId: 'evt-async', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-async', atMs: NOW_MS });
  const res = await mod.resolvePendingDetail('evt-async');
  assert.equal(res.ok, true);
  assert.equal(res.detail.command, 'echo async-ok', 'the awaited payload normalizes');
  const rejecting = makeModule({ pendingDetail: async () => { throw new Error('async resolver failed'); } });
  rejecting.notePendingRequest({ eventId: 'evt-async-bad', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-async-bad', atMs: NOW_MS });
  assert.deepEqual(await rejecting.resolvePendingDetail('evt-async-bad'), { ok: false, code: 'DETAIL_UNAVAILABLE' });
});

// ---------------------------------------------------------------------------
// the shared answer path — one implementation for panel and IM
// ---------------------------------------------------------------------------

test('pending answers: the inline buttons, the modal and the question form share respondToRuntime', async () => {
  const seen = [];
  const mod = makeModule({
    answerRequest: async ({ rpcId, value, what }) => {
      seen.push({ rpcId, value, what });
      return { ok: true };
    },
  });
  mod.notePendingRequest({ eventId: 'evt-inline', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-inline', atMs: NOW_MS });
  mod.notePendingRequest({ eventId: 'evt-modal', kind: 'approval', sessionId: 's1', toolName: 'rm', rpcId: 'evt-modal', atMs: NOW_MS + 1 });
  mod.notePendingRequest({ eventId: 'evt-form', kind: 'question', sessionId: 's1', rpcId: 'evt-form', atMs: NOW_MS + 2 });
  // inline approve
  assert.equal((await mod.answerPending({ id: 'evt-inline', value: 'allowed-once' })).ok, true);
  assert.equal((await mod.answerPending({ id: 'evt-nope', value: 'rejected' })).ok, false, 'unknown id');
  // modal approve-once / modal reject (same call, different card)
  assert.equal((await mod.answerPending({ id: 'evt-modal', value: 'rejected', what: 'office danger modal reject (evt-modal)' })).ok, true);
  // question form answer
  assert.equal((await mod.answerPending({ id: 'evt-form', value: { answers: [{ id: 'q1', selected: ['继续'] }] } })).ok, true);
  assert.deepEqual(seen.map((s) => s.rpcId), ['evt-inline', 'evt-modal', 'evt-form'],
    'every entry point routes through the one injected shared channel');
  assert.deepEqual(mod.state().pending, [], 'all three cards are gone after their answers');
});

test('pending answers: a refused answer keeps the card (nothing auto-resolves)', async () => {
  const mod = makeModule({ answerRequest: async () => ({ ok: false, reason: 'runtime refused' }) });
  mod.notePendingRequest({ eventId: 'evt-keep', kind: 'approval', sessionId: 's1', toolName: 'bash', rpcId: 'evt-keep', atMs: NOW_MS });
  assert.deepEqual(await mod.answerPending({ id: 'evt-keep', value: 'rejected' }), { ok: false, reason: 'runtime refused' });
  assert.equal(mod.state().pending.length, 1, 'the card stays — the request is still live');
  // P3 pages answer through page.answerPending only; the page never schedules a
  // fallback answer (permission requests always wait — cross-tool memo).
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  for (const match of html.matchAll(/set(?:Timeout|Interval)\(([^)]*)\)/g)) {
    assert.doesNotMatch(String(match[1]), /answerPending/, 'nothing in the page schedules an automatic answer');
  }
});

// ---------------------------------------------------------------------------
// privacy — the snapshot never carries detailRef payload text
// ---------------------------------------------------------------------------

test('privacy: the pending snapshot carries no command or question text (detailRef only)', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  const mod = makeModule({
    pendingDetail: () => ({ id: 'evt-p', kind: 'approval', toolName: 'bash', command: 'FIXTURE-COMMAND-rm -rf', reason: 'FIXTURE-REASON' }),
  });
  mod.notePendingRequest({ eventId: 'evt-p', kind: 'approval', sessionId: 'sess-priv-p3', toolName: 'bash', rpcId: 'evt-p', atMs: NOW_MS });
  mod.notePendingRequest({
    eventId: 'evt-pq', kind: 'question', sessionId: 'sess-priv-p3', rpcId: 'evt-pq', atMs: NOW_MS + 1,
    questions: [{ id: 'q1', question: 'FIXTURE-QUESTION-TEXT', options: [{ label: 'main' }] }],
  });
  const serialized = JSON.stringify(mod.state());
  assert.equal(serialized.includes('FIXTURE-COMMAND'), false, 'command text never enters the snapshot');
  assert.equal(serialized.includes('FIXTURE-REASON'), false, 'the harness reason never enters the snapshot');
  assert.equal(serialized.includes('FIXTURE-QUESTION'), false, 'the question body never enters the snapshot');
  assert.equal(serialized.includes('sess-priv-p3'), false);
  for (const item of mod.state().pending) {
    assert.equal(item.detailRef, 'office:pending-detail', 'the item points at the detailRef, not the data');
    assert.equal(item.command, undefined);
    assert.equal(item.questions, undefined);
  }
  // the redactor behaviour is unchanged (P1)
  assert.equal(redactor.redactValue({ note: 'FIXTURE' }).note, '[REDACTED:text]');
});

// ---------------------------------------------------------------------------
// page controller — bridge calls + the danger-modal view model
// ---------------------------------------------------------------------------

function makeController(snapshotPatch = {}, bridgeExtra = {}) {
  const snapshot = {
    employees: [], activityLog: [], pending: [], usage: null, sync: 'healthy', capabilities: {},
    ...snapshotPatch,
  };
  const calls = [];
  const bridge = {
    getState: async () => snapshot,
    updateSettings: async () => ({}),
    notifyVisibility: () => {},
    pending: async (payload) => { calls.push(payload); return bridgeExtra.pending ? bridgeExtra.pending(payload) : { ok: true }; },
  };
  const page = officePage.createOfficePageController({ bridge });
  page.applySnapshot(snapshot);
  return { page, calls, bridge };
}

test('page controller: answerPending and pendingDetail go through the office:pending bridge', async () => {
  const { page, calls } = makeController();
  assert.deepEqual(await page.answerPending('evt-1', 'allowed-once'), { ok: true });
  assert.deepEqual(calls.at(-1), { action: 'answer', id: 'evt-1', value: 'allowed-once' });
  assert.deepEqual(await page.answerPending('evt-2', 'rejected'), { ok: true });
  assert.deepEqual(calls.at(-1), { action: 'answer', id: 'evt-2', value: 'rejected' });
  assert.deepEqual(await page.pendingDetail('evt-1'), { ok: true });
  assert.deepEqual(calls.at(-1), { action: 'detail', id: 'evt-1' });
});

test('page controller: missing bridge degrades instead of throwing', async () => {
  const snapshot = { employees: [], activityLog: [], pending: [], usage: null, sync: 'healthy', capabilities: {} };
  const page = officePage.createOfficePageController({
    bridge: { getState: async () => snapshot, updateSettings: async () => ({}), notifyVisibility: () => {} },
  });
  assert.deepEqual(await page.answerPending('evt-1', 'rejected'), { ok: false, code: 'BRIDGE_MISSING' });
  assert.deepEqual(await page.pendingDetail('evt-1'), { ok: false, code: 'BRIDGE_MISSING' });
});

test('pendingModalModel: the danger modal shows steps, impact, command, reversibility and no-args honesty', () => {
  const item = {
    id: 'evt-high', kind: 'approval', employeeId: 'coder', toolName: 'bash',
    summary: '执行命令', risk: 'high', createdAtMs: 1,
  };
  // with a real detailRef payload (correlated command)
  const model = officePage.buildPendingModalModel({
    item,
    detail: {
      id: 'evt-high', kind: 'approval', toolName: 'bash', preset: 'workspace-write',
      reason: 'escalate sandbox to danger-full-access: create a marker outside the workspace',
      requestedSandboxMode: 'danger-full-access',
      command: 'touch ~/dsh-p3-e2e-marker.txt', commandSource: 'journal-tool-call', targetPath: null,
    },
  });
  assert.equal(model.approval, true);
  assert.equal(model.title, '高危操作 · 批准请求');
  assert.equal(model.agentPreset, 'workspace-write', 'the agent preset rides the modal verbatim (P4-R1: agent-presets axis, not a sandbox tier)');
  assert.ok(model.steps.some((s) => s.includes('escalate sandbox to danger-full-access')), 'the harness reason is the step');
  assert.ok(model.impact.includes('danger-full-access') && model.impact.includes('仅本次有效'), 'the impact names the widening');
  assert.equal(model.command, 'touch ~/dsh-p3-e2e-marker.txt', 'the REAL command text rides the modal');
  assert.equal(model.commandSource, 'journal-tool-call');
  assert.equal(model.noToolArguments, false);
  assert.match(model.reversibleNote, /未提供撤销路径/, '可逆性说明 always present (cross-tool memo: 高危模态必须带撤销说明)');
  assert.match(model.noAlwaysNote, /不支持记住此类授权/, 'no-always is stated, never offered');
  assert.match(model.blockedNote, /阻塞/, 'the blocked-composer note rides the modal');

  // without a detail (or an empty one) the modal says so — never fabricates a command
  const empty = officePage.buildPendingModalModel({ item, detail: null });
  assert.equal(empty.command, null);
  assert.equal(empty.noToolArguments, true);
  assert.match(empty.noArgsNote, /harness 未暴露该工具的参数/);
  // P4-R1: with no widening request there is NO sandbox fact to show — the
  // harness does not project the sandbox mode onto sessions, and the impact
  // line states that instead of guessing a tier from the agent preset.
  assert.match(empty.impact, /沙箱模式：harness 未投影/, 'the impact states the unprojected sandbox axis');
  assert.equal(empty.agentPreset, null, 'no agent preset -> the row is omitted, no "unknown" label');

  // target path rides the modal; the agent preset NEVER becomes a sandbox tier
  const write = officePage.buildPendingModalModel({
    item: { ...item, toolName: 'edit', risk: 'medium' },
    detail: { id: 'evt-high', kind: 'approval', toolName: 'edit', preset: 'workspace-write', targetPath: '/Users/x/proj/src/main.js' },
  });
  assert.equal(write.targetPath, '/Users/x/proj/src/main.js');
  assert.equal(write.agentPreset, 'workspace-write');
  assert.match(write.impact, /沙箱模式：harness 未投影/, 'P4-R1: a preset value is not inferred as a sandbox tier');
});

test('pendingModalModel: the question variant builds the answer form fields', () => {
  const model = officePage.buildPendingModalModel({
    item: { id: 'evt-q', kind: 'question', employeeId: null, toolName: 'ask_user_question', summary: '等待你回答', risk: 'low', createdAtMs: 1 },
    detail: {
      id: 'evt-q', kind: 'question',
      questions: [{ id: 'q1', question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }],
    },
  });
  assert.equal(model.approval, false);
  assert.equal(model.title, '提问');
  assert.equal(model.questions.length, 1);
  assert.deepEqual(model.questions[0].options.map((o) => o.label), ['main', 'dev']);
  assert.equal(model.noArgsNote, null, 'questions have no "arguments" ambiguity');
});

// ---------------------------------------------------------------------------
// office.html / office.css — the modal + inline actions + input blocking
// ---------------------------------------------------------------------------

test('office.html carries the P3 inbox actions and the danger modal', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  // ③ cards: inline approve/reject + the danger entry + the question entry
  assert.ok(html.includes("answerPendingCard(item, 'allowed-once')"), 'the inline approve button answers allowed-once');
  assert.ok(html.includes("answerPendingCard(item, 'rejected')"), 'the inline reject button answers rejected');
  // P1 English pass (2026-09-25): button copy resolves through the shared
  // dictionary (office.pending.review / office.pending.reviewAnswer).
  assert.ok(html.includes("review.textContent = tr('office.pending.review')"), 'high-risk cards open the modal instead of one-clicking');
  assert.ok(html.includes("review.textContent = tr('office.pending.reviewAnswer')"), 'question cards open the form');
  // the modal answers with the harness vocabulary only — NEVER "always allow"
  assert.ok(html.includes("answerPendingCard(pendingModalItem, 'allowed-once')"), '仅本次批准 = allowed-once');
  assert.ok(html.includes("answerPendingCard(pendingModalItem, 'rejected')"), '拒绝 = rejected');
  assert.ok(!/allow-always|always[- ]?allow/i.test(html), 'no always-allow anywhere in the page');
  // modal DOM: a real dialog that covers the panel only
  assert.ok(html.includes('id="pending-modal"'), 'the modal element exists');
  assert.match(html, /id="pending-modal"[^>]*role="dialog"[^>]*aria-modal="true"/, 'the modal is an aria-modal dialog');
  assert.ok(html.includes('pendingModalModel'), 'the page renders the shared modal view model');
  assert.ok(html.includes('page.pendingDetail(item.id)'), 'the command text is fetched through the detailRef per user action');
  // input blocking while the modal is open (spec §5 / cross-tool memo)
  assert.ok(html.includes('setPanelActionsBlocked(true)'), 'opening the modal blocks the panel action surface');
  assert.ok(html.includes('setPanelActionsBlocked(false)'), 'closing the modal unblocks it');
  assert.ok(html.includes("for (const id of ['btn-dispatch', 'btn-cancel', 'btn-interrupt'])"),
    '追加任务/请求取消/请求中断 are the blocked surface');
  assert.ok(html.includes("disabled = state === 'sending' || !!pendingModalItem"),
    'other cards cannot be answered while the modal is open');
  // approvals never time out: Escape closes the modal without answering
  assert.match(html, /if \(!pendingModalRoot\.hidden && event\.key === 'Escape'\) \{[\s\S]*?closePendingModal\(\);/,
    'Escape closes the modal and answers nothing');
  assert.ok(html.includes('closePendingModal(); // backdrop: answer nothing'), 'backdrop click answers nothing');
  // the shared answer entry is page.answerPending → office:pending → respondToRuntime
  assert.ok(html.includes('await page.answerPending(item.id, value)'), 'one answer implementation');
});

test('office.css styles the inbox actions and the blocking state', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.css'), 'utf8');
  assert.match(css, /\.pending-modal\s*\{/, 'the modal is styled');
  assert.match(css, /\.pending-modal-card\s*\{/, 'the modal card is styled');
  assert.match(css, /\.pending-btn-approve/, 'inline approve styled');
  assert.match(css, /\.pending-btn-reject/, 'inline reject styled');
  assert.match(css, /#office-panel\[data-pending-blocking="true"\] #details-actions button/,
    'the blocked composer state is styled');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?need-pulse/, 'reduced motion still respected');
});

// ---------------------------------------------------------------------------
// i18n — spec §6 office.pending.* keys, zh/en same table
// ---------------------------------------------------------------------------

test('i18n: every P3 office.pending key exists in BOTH dictionaries with identical key sets', () => {
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh/en dictionaries must cover the same keys');
  for (const key of [
    'office.pending.title', 'office.pending.empty', 'office.pending.approve', 'office.pending.reject',
    'office.pending.review', 'office.pending.modal.steps', 'office.pending.modal.impact',
    'office.pending.modal.approveOnce', 'office.pending.modal.title', 'office.pending.modal.question',
    'office.pending.modal.tool', 'office.pending.modal.agentPreset', 'office.pending.modal.reason',
    'office.pending.modal.command', 'office.pending.modal.target', 'office.pending.modal.reversible',
    'office.pending.modal.reversible.unknown', 'office.pending.modal.noArgs', 'office.pending.modal.noAlways',
    'office.pending.modal.blocked', 'office.pending.modal.escalate', 'office.pending.modal.sandbox.unprojected',
    'office.pending.question.submit', 'office.pending.question.custom',
  ]) {
    assert.ok(typeof STRINGS.zh[key] === 'string' && STRINGS.zh[key] !== '', `zh missing ${key}`);
    assert.ok(typeof STRINGS.en[key] === 'string' && STRINGS.en[key] !== '', `en missing ${key}`);
  }
  // the "no always allow" contract is visible in both dictionaries
  assert.match(STRINGS.zh['office.pending.modal.noAlways'], /仅提供一次性批准/);
  assert.match(STRINGS.en['office.pending.modal.noAlways'], /one-shot/);
});

// ---------------------------------------------------------------------------
// main.js wiring — the detailRef correlation and its evidence
// ---------------------------------------------------------------------------

test('main.js wires the P3 detailRef pipeline (correlation + capture + resolver)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // the module gets the injected resolver (the module stays pure)
  assert.ok(src.includes('pendingDetail: (id) => officeResolvePendingDetail(id),'),
    'the module receives the main-process detail resolver');
  // the approval/question arrival records the answerable context
  assert.ok(src.includes('noteOfficePendingDetail(record, {'), 'every waterfall arrival is recorded for the detailRef');
  assert.ok(src.includes('callId: (frame && (frame.callId || frame.approvalId)) || null,'),
    'the harness callId is the correlation key');
  // the journal tool/call capture (before the module gate — the module is lazy)
  assert.ok(src.includes('noteOfficeToolCallArgs(sessionId, event.data, event.time);'),
    'follow-journal tool/call records are captured for correlation');
  assert.ok(src.includes('officeFollowCursors.set(sessionId, Math.max(officeFollowCursors.get(sessionId) ?? -1, value.cursor));'),
    'the follow snapshot cursor is remembered for the session/page fallback');
  // the widening flag derivation cites its first-hand evidence
  assert.ok(src.includes('/^escalate sandbox to\\b/i.test(reason.trim())'),
    'the sandbox-widening flag is derived from the harness escalation reason');
  assert.ok(src.includes('dsh-sandbox'), 'the escalation phrasing evidence is cited inline');
  // the session of a mux waterfall request is the frame's agentId: an Agent id
  // IS its SessionId (dsh-agent `Agent.id: SessionId`), and the request payload
  // carries no session id of its own (first-hand ApprovalRequestEvent).
  assert.ok(src.includes('onApprovalRequested(request, value.eventId, value.agentId)'),
    'the approval frame passes its agentId through');
  assert.ok(src.includes('onQuestionRequested(request, value.eventId, value.agentId)'),
    'the question frame passes its agentId through');
  assert.ok(src.includes("function officeNotePending({ kind, frame, rpcId, agentId }) {"),
    'officeNotePending accepts the agentId');
  assert.ok(src.includes(": (typeof agentId === 'string' && agentId !== '' ? agentId : '');"),
    'the agentId resolves the pending session (employee binding + detailRef correlation)');
  // the callId-scan fallback covers a session-less frame
  assert.ok(src.includes('for (const [key, value] of officeToolCallArgs) {'),
    'a session-less approval still correlates by its unique callId');
  // the fallback RPC + the correlation lookup
  assert.ok(src.includes("mux.call('session/page'"), 'the session/page fallback re-reads the durable log tail');
  assert.ok(src.includes('officeToolCallArgs.get(`${detail.sessionId}#${detail.callId}`)'),
    'the correlation key is sessionId + callId');
  // the sandboxWidening input reaches classifyRisk
  assert.ok(src.includes('sandboxWidening,'), 'the flag rides the pending record');
});
