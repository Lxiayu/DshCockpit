'use strict';

// test/office-ux-mustfix.test.js — 2026-09-25 UX 审查「发版前必修」7 条的回归
// （docs/strategy/2026-09-25-ux-and-flow-review.md §③）。每条断言对应审查项：
//   ① B1/G1 安慰剂按钮真接线：cancel/followup 经注入的 controlRequest seam 复用
//     IM 已验证的 harness RPC（session/cancel、session/prompt steer）；失败与
//     interrupt 诚实拒绝，绝不产生"取消已请求"式假反馈。
//   ② F1/F2 键盘可达性：全局 keydown 只在非表单元素上接管（office.html 源回归；
//     真实行为由 Electron 探针实证，见证据目录 README）。
//   ③ B2 失败 reason 本地化映射（PENDING_FAIL_KEY_OF / pendingFailureView）。
//   ④ E2 i18n 同表重复键 lint 自检（lint 本体在 test/i18n.test.js）。
//   ⑤ D1 时间线空态 + A1 运行时重启后 pending 失效清理。
// 通道约束：office:* IPC 通道保持恰好 8 个（B1 的追加任务正文走既有
// office:dispatch 的可选 text 字段，无新通道）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const officePage = require('../src/office/office-page.js');
const { createHarnessRpcWire } = require('../src/harness-rpc.js');

const PROD_PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PROD_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

function makeModule(overrides = {}) {
  return officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-ux-mustfix-seed',
    config: { sleepAfterMs: 4000, resultPresentationMs: 500, chatCooldownMs: 1000, minDwellMs: 500 },
    ...overrides,
  });
}

function tickFor(module, ms) {
  const steps = Math.round(ms / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) module.tickOnce();
}

function bindRunning(module, sessionId) {
  module.ingestHarnessEvent({ sessionId, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const employee = module.state().employees.find((e) => e.binding);
  assert.ok(employee, 'running event binds a session');
  return employee.employeeId;
}

function logKinds(module) {
  return module.state().activityLog.map((entry) => entry.kind);
}

// ---------------------------------------------------------------------------
// ① B1/G1: the control buttons reach the REAL runtime RPC through the
//    controlRequest seam — and never fake success.
// ---------------------------------------------------------------------------

test('① cancel really reaches the runtime: controlRequest gets the bound session and the badge only appears after acceptance', async () => {
  const rpcCalls = [];
  const module = makeModule({
    // Mirror of main.js's seam: office RPC → createHarnessRpcWire().cancel →
    // POST /api/session/cancel (slash shape pinned in test/harness-rpc.test.js).
    controlRequest: async ({ sessionId, control }) => {
      rpcCalls.push({ sessionId, control });
      return { ok: true };
    },
  });
  tickFor(module, 50);
  const employeeId = bindRunning(module, 'sess-ux-cancel');

  const result = await module.cancel({ employeeId });
  assert.equal(result.ok, true, 'cancel succeeds when the runtime accepts');
  assert.deepEqual(rpcCalls, [{ sessionId: 'sess-ux-cancel', control: 'cancel' }],
    'the seam carries the BOUND session id — this is the handle session/cancel is fired at');
  const employee = module.state().employees.find((e) => e.employeeId === employeeId);
  assert.equal(employee.control, 'cancellationPending', 'badge appears ONLY after runtime acceptance');
  assert.ok(logKinds(module).includes('control-cancel'), 'timeline records the real request');
});

test('① failed cancel stays honest: no badge, no timeline line, localized failure code', async () => {
  const module = makeModule({
    controlRequest: async () => ({ ok: false, code: 'RUNTIME_OFFLINE', reason: 'runtime offline' }),
  });
  tickFor(module, 50);
  const employeeId = bindRunning(module, 'sess-ux-cancel-fail');
  const before = logKinds(module).filter((k) => k === 'control-cancel').length;

  const result = await module.cancel({ employeeId });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUNTIME_OFFLINE');
  assert.equal(result.reason, 'runtime offline');
  const employee = module.state().employees.find((e) => e.employeeId === employeeId);
  assert.equal(employee.control, 'none', 'NO cancellationPending on a failed request');
  assert.equal(logKinds(module).filter((k) => k === 'control-cancel').length, before,
    'no control-cancel timeline entry on failure');
});

test('① followup (追加任务) reaches session/prompt semantics: the task text rides the seam', async () => {
  const rpcCalls = [];
  const module = makeModule({
    controlRequest: async ({ sessionId, control, text }) => {
      rpcCalls.push({ sessionId, control, text });
      return { ok: true };
    },
  });
  tickFor(module, 50);
  const employeeId = bindRunning(module, 'sess-ux-followup');

  const result = await module.dispatch({ employeeId, text: '  追加：跑一遍回归测试  ' });
  assert.equal(result.ok, true);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].control, 'followup');
  assert.equal(rpcCalls[0].sessionId, 'sess-ux-followup');
  assert.equal(rpcCalls[0].text, '追加：跑一遍回归测试', 'trimmed task text rides the seam (steer prompt body)');
  assert.ok(logKinds(module).includes('dispatch-followup'), 'timeline records the follow-up');
});

test('① followup without text is refused (TEXT_REQUIRED), never sent as an empty prompt', async () => {
  const module = makeModule({ controlRequest: async () => ({ ok: true }) });
  tickFor(module, 50);
  const employeeId = bindRunning(module, 'sess-ux-empty');
  const result = await module.dispatch({ employeeId, text: '   ' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TEXT_REQUIRED');
  assert.ok(!logKinds(module).includes('dispatch-followup'), 'nothing recorded for an empty task');
});

test('① interrupt is honestly refused: CONTROL_UNWIRED, zero fake feedback, capability false', async () => {
  const rpcCalls = [];
  const module = makeModule({ controlRequest: async (req) => { rpcCalls.push(req); return { ok: true }; } });
  tickFor(module, 50);
  const employeeId = bindRunning(module, 'sess-ux-interrupt');

  const result = await module.interrupt({ employeeId });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CONTROL_UNWIRED', '0.1.5 has no interrupt counterpart — refused honestly');
  assert.equal(rpcCalls.length, 0, 'nothing sent to the runtime');
  assert.equal(module.state().capabilities.interrupt, false, 'capability bit stays false (button disabled)');
  assert.ok(!logKinds(module).includes('control-interrupt'), 'no control-interrupt timeline entry');
  assert.equal(module.state().employees.find((e) => e.employeeId === employeeId).control, 'none',
    'no cancellationPending from an interrupt');
});

test('① unbound employee: honest NOT_BOUND, no seam call (保留的诚实降级)', async () => {
  const rpcCalls = [];
  const module = makeModule({ controlRequest: async (req) => { rpcCalls.push(req); return { ok: true }; } });
  tickFor(module, 50);
  const result = await module.cancel({ employeeId: 'orchestrator' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_BOUND');
  assert.equal(rpcCalls.length, 0);
});

test('① end-to-end RPC shape: the seam impl (main.js style) fires POST /api/session/cancel and /api/session/prompt steer', async () => {
  // The exact seam main.js injects, driven against a recording fetch — proving
  // the button press ends at the REAL harness endpoints (slash protocol).
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { status: 200, json: async () => ({ result: { ok: true, value: {} } }) };
  };
  const makeOfficeControlRequest = (rpc) => async ({ sessionId, control, text }) => {
    if (control === 'cancel') { await rpc.cancel(sessionId); return { ok: true }; }
    if (control === 'followup') { await rpc.prompt(sessionId, text, 'steer'); return { ok: true }; }
    return { ok: false, code: 'CONTROL_UNSUPPORTED' };
  };
  const rpc = createHarnessRpcWire('http://127.0.0.1:1/', { fetchImpl, protocol: 'slash' });
  const controlRequest = makeOfficeControlRequest(rpc);

  await controlRequest({ sessionId: 'sess-e2e', control: 'cancel' });
  await controlRequest({ sessionId: 'sess-e2e', control: 'followup', text: '追加任务' });
  assert.equal(calls[0].url, 'http://127.0.0.1:1/api/session/cancel');
  assert.deepEqual(calls[0].body.payload.args, { request: { sessionId: 'sess-e2e' } });
  assert.equal(calls[1].url, 'http://127.0.0.1:1/api/session/prompt');
  assert.equal(calls[1].body.payload.args.request.mode, 'steer');
  assert.deepEqual(calls[1].body.payload.args.request.content, [{ type: 'text', text: '追加任务' }]);
});

// ---------------------------------------------------------------------------
// ② F1/F2: the global keydown handler must not swallow form-element keys
//    (source regression; real-shell behavior is probe-verified).
// ---------------------------------------------------------------------------

test('② office.html keydown: target filter guards button/input activation (F1/F2)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  const handlerStart = html.indexOf("document.addEventListener('keydown'");
  assert.ok(handlerStart !== -1, 'global keydown handler exists');
  const handler = html.slice(handlerStart, html.indexOf('});', handlerStart));
  // the filter must run BEFORE handleKeyEvent and cover buttons + form fields
  const guardAt = handler.indexOf("target.closest('button, input, textarea, select, a[href], [contenteditable]')");
  const handleAt = handler.indexOf('handleKeyEvent(event.key)');
  assert.ok(guardAt !== -1, 'interactive-target guard present (button/input/textarea/select/contenteditable)');
  assert.ok(handleAt !== -1, 'handleKeyEvent still drives scene/list navigation');
  assert.ok(guardAt < handleAt, 'the guard returns BEFORE navigation keys are taken over');
  assert.match(handler, /return;\s*\n\s*}\s*\n\s*const result = handleKeyEvent/, 'guard is an early return');
  // modal Escape handling stays ahead of the guard (Esc closes the modal from anywhere)
  const escapeAt = handler.indexOf("event.key === 'Escape'");
  assert.ok(escapeAt !== -1 && escapeAt < guardAt, 'modal Escape handling precedes the guard');
});

test('② page keyboard model unchanged: arrows/Enter/Space/Escape still drive the list when focused', async () => {
  const bridge = {
    getState: async () => ({
      employees: ['a', 'b'].map((id) => ({ employeeId: id, displayName: id, role: '', presence: 'present', runtime: 'unbound', activity: 'roaming', movement: 'stationary', sync: 'healthy', binding: null, queueCount: 0, waiting: [], taskLabel: null, lastResult: null })),
      activityLog: [], pending: [], usage: null, sync: 'healthy', capabilities: {},
    }),
  };
  const page = officePage.createOfficePageController({ bridge });
  await page.init();
  assert.deepEqual(page.handleKey({ key: 'ArrowDown' }), { action: 'focus', index: 1 });
  assert.deepEqual(page.handleKey({ key: ' ' }), { action: 'select', employeeId: 'b' });
  assert.deepEqual(page.handleKey({ key: 'Escape' }), { action: 'clear' });
});

// ---------------------------------------------------------------------------
// ③ B2: approval/question failure reasons localize instead of raw English.
// ---------------------------------------------------------------------------

test('③ known failure reasons map to office.pending.fail.* keys', () => {
  const cases = {
    'runtime offline': 'office.pending.fail.runtimeOffline',
    'runtime event feed offline': 'office.pending.fail.feedOffline',
    'no rpc id': 'office.pending.fail.unroutable',
    'unknown pending id': 'office.pending.fail.unroutable',
    'unsupported answer value': 'office.pending.fail.unsupported',
    'answer channel unavailable': 'office.pending.fail.channelUnavailable',
    'already-answering': 'office.pending.fail.alreadyAnswering',
  };
  for (const [reason, key] of Object.entries(cases)) {
    const view = officePage.pendingFailureView(reason);
    assert.equal(view.key, key, `reason "${reason}" maps to ${key}`);
    assert.equal(view.unknown, false);
    assert.equal(view.detail, reason, 'raw reason kept for the expandable technical details');
  }
  // case-insensitive + trimmed
  assert.equal(officePage.pendingFailureView('  Runtime Offline ').key, 'office.pending.fail.runtimeOffline');
});

test('③ unknown reasons stay honest: generic fallback + raw technical detail', () => {
  const view = officePage.pendingFailureView('some upstream gateway/arguments-invalid text');
  assert.equal(view.key, null);
  assert.equal(view.unknown, true);
  assert.equal(view.detail, 'some upstream gateway/arguments-invalid text');
  assert.equal(officePage.pendingFailureView(null).detail, null);
});

test('③ office.html renders failures through the mapping + modal-visible failure (A2)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /localizedPendingFailure/, 'card failure state resolves through the mapping');
  assert.match(html, /FMT\.pendingFailureView/, 'the shared page-module mapping table is used');
  assert.match(html, /renderPendingModalFailure/, 'modal gets the failure note (A2)');
  assert.match(html, /pending-modal-fail/, 'modal failure node styled/present');
  assert.match(html, /office\.pending\.technicalDetail/, 'expandable technical details copy wired');
  // the raw English reason must no longer be rendered verbatim as the card state
  assert.doesNotMatch(html, /pendingCardState\.set\(item\.id, \(res && res\.reason\)/,
    'raw reason no longer becomes the visible card text');
});

// ---------------------------------------------------------------------------
// ④ E2: duplicate-key lint self-test (the lint itself lives in i18n.test.js).
// ---------------------------------------------------------------------------

test('④ duplicate-key lint catches a repeated key in a synthetic table (self-test)', () => {
  const { collectDuplicateKeys } = require('./helpers/i18n-duplicate-key-lint.js');
  const synthetic = "const STRINGS = { zh: { 'a.b': '中文', 'a.b': 'english', 'c.d': 'x' }, en: { 'a.b': 'one' } };";
  const dups = collectDuplicateKeys(synthetic);
  assert.deepEqual(dups.zh, ['a.b x2'], 'the lint must fire on exactly the duplicated key');
  // and it stays silent on a duplicate-free table
  const clean = collectDuplicateKeys("const STRINGS = { zh: { 'a.b': '一', 'c.d': '二' }, en: { 'a.b': 'one' } };");
  assert.deepEqual(clean, {});
});

test('④ zh/en dictionaries expose the new must-fix keys in BOTH languages', () => {
  const { STRINGS } = require('../src/i18n');
  const keys = [
    'office.pending.fail.runtimeOffline', 'office.pending.fail.feedOffline',
    'office.pending.fail.unroutable', 'office.pending.fail.unsupported',
    'office.pending.fail.channelUnavailable', 'office.pending.fail.alreadyAnswering',
    'office.pending.technicalDetail', 'office.pending.expired',
    'office.timeline.empty', 'office.panel.dispatchPlaceholder', 'office.panel.dispatchSend',
    'office.panel.dispatchSent', 'office.panel.cancelSent', 'office.panel.interruptUnwiredTip',
    'office.control.failed', 'office.control.notBound', 'office.control.unwired',
  ];
  for (const key of keys) {
    assert.ok(STRINGS.zh[key], `zh missing ${key}`);
    assert.ok(STRINGS.en[key], `en missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// ⑤ D1 timeline empty state + A1 pending expiry after a runtime restart.
// ---------------------------------------------------------------------------

test('⑤ timeline has an empty state element wired in office.html (D1)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /id="activity-empty"/, 'empty-state element exists');
  assert.match(html, /data-i18n="office\.timeline\.empty"/, 'empty state resolves through the shared dictionary');
  assert.match(html, /activity-empty'\)\.hidden = entries\.length > 0/, 'renderActivity toggles it');
});

test('⑤ pending expiry: runtime restart clears dead cards and explains why (A1)', () => {
  const module = makeModule();
  tickFor(module, 50);
  // 启动期/空转期的 feed 停止（没有卡片可清）不置失效说明——说明行的语义是
  // "刚才那些卡为什么不见了"，没有卡片丢失就不打扰用户（真壳探针曾暴露此瑕疵）。
  const idleExpire = module.expirePendingFromRuntime();
  assert.equal(idleExpire.expired, 0);
  assert.equal(module.state().pendingInvalid, false, 'an empty expiry leaves no stale explanation');

  const note = (n) => module.notePendingRequest({
    kind: 'approval', eventId: `evt-${n}`, rpcId: `rpc-${n}`, sessionId: 'sess-ux-expire',
    toolName: 'bash', atMs: Date.now(),
  });
  assert.equal(note(1).ok, true);
  assert.equal(note(2).ok, true);
  assert.equal(module.state().pending.length, 2);

  const result = module.expirePendingFromRuntime();
  assert.equal(result.ok, true);
  assert.equal(result.expired, 2, 'both dead cards are removed');
  const snapshot = module.state();
  assert.equal(snapshot.pending.length, 0, 'nothing pending survives the runtime restart');
  assert.equal(snapshot.pendingInvalid, true, 'the snapshot explains the invalidation');
  assert.ok(snapshot.pendingInvalidAtMs !== null, 'invalidation stamped (logical)');

  // a new request clears the note (the panel returns to the normal empty state)
  assert.equal(note(3).ok, true);
  const after = module.state();
  assert.equal(after.pending.length, 1);
  assert.equal(after.pendingInvalid, false, 'explanation cleared once a live request arrived');
});

test('⑤ office.html shows the expired note instead of the plain empty state (A1)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /id="pending-expired"/, 'explanation element exists');
  assert.match(html, /data-i18n="office\.pending\.expired"/, 'explanation copy from the shared dictionary');
  assert.match(html, /snapshot && snapshot\.pendingInvalid/, 'renderPendingBlock keys off the module flag');
});

// ---------------------------------------------------------------------------
// Channel constraint: office:* stays EXACTLY eight (追加任务的 text 复用
// office:dispatch，无新通道)。
// ---------------------------------------------------------------------------

test('office:* channels stay at exactly eight; office:dispatch gains only an optional text field', () => {
  assert.equal(officeModule.OFFICE_IPC_CHANNELS.length, 8);
  const withText = officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder', text: '追加任务' });
  assert.equal(withText.ok, true);
  assert.deepEqual(withText.value, { employeeId: 'coder', text: '追加任务' });
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder', text: '   ' }).ok, false, 'blank text rejected');
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder', text: 'x'.repeat(2001) }).ok, false, 'text cap enforced');
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder', text: 42 }).ok, false, 'non-string text rejected');
  assert.equal(officeModule.validateOfficeIpcPayload('office:dispatch', { employeeId: 'coder' }).ok, true, 'bare form still valid');
  assert.equal(officeModule.validateOfficeIpcPayload('office:cancel', { employeeId: 'coder', text: 'x' }).ok, false, 'cancel stays single-field');
});
