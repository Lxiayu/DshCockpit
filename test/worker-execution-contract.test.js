'use strict';

// test/worker-execution-contract.test.js — Worker Execution Contract v0 契约测试（阶段 1）。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md
//
// 覆盖（任务书 §11.1 Contract tests）：
//   - interface shape（端口必需方法 / recover 的显式声明）
//   - event schema（9 种类型的必填字段 + 归一化幂等）
//   - unknown event fail-closed
//   - unknown field fail-closed（执行方不能自带 evidence / Team 状态 / artifactId）
//   - duplicate / out-of-order
//   - identity mismatch
//   - terminal evidence required（非终态事件**没有** evidence）
//   - 层级纯度：无 office / 无 timers / 无网络 / raw 身份不进事件
//
// 全程不启动 Electron / DOM / Pixi，不读墙钟，不写文件系统，不发网络请求。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const schema = require('../src/team/runtime/execution-schema.js');
const port = require('../src/team/runtime/execution-port.js');
const team = require('../src/team/runtime/index.js');

const ROOT = path.join(__dirname, '..');
const TEAM_RUNTIME_DIR = path.join(ROOT, 'src', 'team', 'runtime');
const T0 = 1_700_000_000_000;
const JOB = 'job-contract-1';
const RUN = 'job-contract-1:researcher:1';
const JOB_REF = schema.execJobRefFor(JOB);
const EXEC_REF = schema.executionRefFor(JOB, RUN, 1);

/** 一条最小合法事件（按类型补齐专属字段）。 */
function eventFor(type, extra = {}) {
  return {
    schemaVersion: schema.EXECUTION_SCHEMA_VERSION,
    type,
    jobRef: JOB_REF,
    executionRef: EXEC_REF,
    attempt: 1,
    seq: 1,
    atMs: T0,
    ...(type === 'execution/attention' ? { reason: 'needs-approval' } : {}),
    ...(type === 'execution/crashed' ? { reason: 'executor-crashed' } : {}),
    ...(type === 'execution/artifact' ? { kind: 'research-notes' } : {}),
    ...(type === 'execution/progress' ? { phase: 'search' } : {}),
    ...extra,
  };
}

/**
 * 去掉注释（**单遍词法扫描**，识别字符串字面量）。
 *
 * 为什么不能"正则先删块注释再删行注释"：本层模块的头注释会写 `team/*`、`job/*`
 * 这类命名空间说明，其中的 `/*` 会被正则当成块注释开始，吞掉随后的**真实代码**，
 * 使依赖/纯度断言静默失效（2026-10-22 负向变异 M13 实测未检出，已修）。
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] || ''); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function requiresOf(source) {
  const out = [];
  for (const m of stripComments(source).matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

// ===========================================================================
// 1. 词表与身份派生
// ===========================================================================

test('exec-contract: the event vocabulary is frozen and matches the contract (10 types)', () => {
  assert.deepEqual([...schema.EXECUTION_EVENT_TYPES], [
    'execution/started',
    'execution/artifact',
    'execution/progress',
    'execution/attention',
    'execution/completed',
    'execution/failed',
    'execution/cancel-requested',
    'execution/cancel-acknowledged',
    'execution/cancelled',
    'execution/crashed',
  ]);
  // v0.6（WP2）：`execution/progress` 加入 —— 消费方已出现（办公室座位过程短语），
  // 只携带闭集 phase；工具参数/正文仍然结构性禁止。
  assert.equal(schema.EXECUTION_EVENT_TYPES.includes('execution/progress'), true);
  assert.ok(Object.isFrozen(schema.EXECUTION_EVENT_TYPES));
  // 终态只有三个；控制回执绝不是终态。
  assert.deepEqual([...schema.TERMINAL_EXECUTION_EVENT_TYPES],
    ['execution/completed', 'execution/failed', 'execution/cancelled']);
  assert.deepEqual([...schema.CONTROL_EXECUTION_EVENT_TYPES],
    ['execution/cancel-requested', 'execution/cancel-acknowledged']);
  for (const type of schema.CONTROL_EXECUTION_EVENT_TYPES) {
    assert.equal(schema.isTerminalEventType(type), false, `${type} must not be terminal`);
  }
  // 三种分类互斥且覆盖全部类型。
  const union = [
    ...schema.TERMINAL_EXECUTION_EVENT_TYPES,
    ...schema.CONTROL_EXECUTION_EVENT_TYPES,
    ...schema.NON_TERMINAL_EXECUTION_EVENT_TYPES,
  ].sort();
  assert.deepEqual(union, [...schema.EXECUTION_EVENT_TYPES].sort());
  assert.equal(new Set(union).size, union.length, 'event classifications must be disjoint');
});

test('exec-contract: identity handles are deterministic derived refs (raw ids never appear)', () => {
  assert.equal(typeof JOB_REF, 'string');
  assert.match(JOB_REF, schema.EXEC_JOB_REF_RE);
  assert.match(EXEC_REF, schema.EXEC_RUN_REF_RE);
  // 决定性：同输入同输出。
  assert.equal(schema.execJobRefFor(JOB), JOB_REF);
  assert.equal(schema.executionRefFor(JOB, RUN, 1), EXEC_REF);
  // raw jobId / raw runId 不在句柄里。
  assert.equal(JOB_REF.includes(JOB), false);
  assert.equal(EXEC_REF.includes(RUN), false);
  assert.equal(EXEC_REF.includes('researcher'), false);
  // attempt 参与派生（三次尝试必须是三个不同 handle）。
  const refs = new Set([1, 2, 3].map((a) => schema.executionRefFor(JOB, RUN, a)));
  assert.equal(refs.size, 3, 'attempt must be part of the execution identity');
  // 非法输入 → null（fail-closed，不猜）。
  for (const bad of [undefined, null, '', 42, {}]) {
    assert.equal(schema.execJobRefFor(bad), null, `jobId ${String(bad)} must fail closed`);
    assert.equal(schema.executionRefFor(JOB, bad, 1), null, `runId ${String(bad)} must fail closed`);
  }
  // attempt 必须是 >= 1 的整数（42 是合法的尝试号，但 0 / 小数 / 字符串 / null 不是）。
  for (const badAttempt of [0, -1, 1.5, '1', null, undefined, {}]) {
    assert.equal(schema.executionRefFor(JOB, RUN, badAttempt), null, `attempt ${String(badAttempt)} must fail closed`);
  }
  assert.equal(typeof schema.executionRefFor(JOB, RUN, 42), 'string');
});

test('exec-contract v0.6: PROGRESS_PHASES is the shared phrase vocabulary (drift pin)', () => {
  // 本层与 office/tool-phrases 各持一份闭集（本层不能 require office 路径 —— 纯度门），
  // 这个钉子保证两份永不漂移。
  const { PHRASE_KEYS } = require('../src/office/runtime/tool-phrases.js');
  assert.deepEqual([...schema.PROGRESS_PHASES], [...PHRASE_KEYS]);
  for (const phase of schema.PROGRESS_PHASES) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/progress', { phase }));
    assert.equal(verdict.ok, true, `phase ${phase} must validate`);
  }
});

test('exec-contract v0.6: progress requires a closed-set phase; other events cannot carry one', () => {
  // 缺 phase → EXEC_PHASE_INVALID（progress 的 phase 是必填）。
  const missing = schema.validateExecutionEvent(eventFor('execution/progress', { phase: undefined }));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'EXEC_PHASE_INVALID');
  // 闭集之外的 phase（例如把**原始工具名**当 phase 塞进来）→ EXEC_PHASE_INVALID。
  // 这是隐私边界的行为级保证：工具名/参数不可能经 phase 溜进事件。
  const raw = schema.validateExecutionEvent(eventFor('execution/progress', { phase: 'bash' }));
  assert.equal(raw.ok, false);
  assert.equal(raw.code, 'EXEC_PHASE_INVALID');
  // 非 progress 事件带 phase → EXEC_UNKNOWN_FIELD（白名单）。
  const smuggled = schema.validateExecutionEvent(eventFor('execution/started', { phase: 'search' }));
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.code, 'EXEC_UNKNOWN_FIELD');
  // 归一化幂等：phase 字段被显式补齐后再校验仍合法。
  const once = schema.validateExecutionEvent(eventFor('execution/progress'));
  assert.equal(once.ok, true);
  assert.equal(once.event.phase, 'search');
  const twice = schema.validateExecutionEvent(once.event);
  assert.equal(twice.ok, true, `idempotent revalidation: ${twice.code}`);
});

test('exec-contract: crash policy is an explicit decision, not "it depends"', () => {
  assert.equal(schema.CRASH_DEFAULT_TEAM_ACTION, 'attention');
  // crash 不是终态事件类型 —— 因此它**不可能**产生 Team terminal fact。
  assert.equal(schema.isTerminalEventType('execution/crashed'), false);
  // 唯一把 crash 收敛为 failed 的路径是宿主的显式证据。
  assert.match(schema.CRASH_UNRECOVERABLE_EVIDENCE, /^[a-z][a-z0-9_/-]+:[a-z][a-z0-9_-]+$/);
});

// ===========================================================================
// 2. event schema（形状校验）
// ===========================================================================

test('exec-contract: every declared event type validates with its required fields', () => {
  for (const type of schema.EXECUTION_EVENT_TYPES) {
    const verdict = schema.validateExecutionEvent(eventFor(type));
    assert.equal(verdict.ok, true, `${type} should validate: ${verdict.code}`);
    const event = verdict.event;
    // 必填字段齐备。
    assert.equal(event.type, type);
    assert.equal(event.jobRef, JOB_REF);
    assert.equal(event.executionRef, EXEC_REF);
    assert.equal(event.attempt, 1);
    assert.equal(event.seq, 1);
    assert.equal(event.atMs, T0);
    assert.ok(Object.isFrozen(verdict.event), 'normalized event must be frozen');
    // 终态性由 schema 判定（不是调用方自称）。
    assert.equal(verdict.terminal, schema.isTerminalEventType(type));
  }
});

test('exec-contract: validation is idempotent (a normalized event validates again)', () => {
  for (const type of schema.EXECUTION_EVENT_TYPES) {
    const once = schema.validateExecutionEvent(eventFor(type));
    assert.equal(once.ok, true, `${type} first pass: ${once.code}`);
    const twice = schema.validateExecutionEvent(once.event);
    assert.equal(twice.ok, true, `${type} second pass must be idempotent: ${twice.code}`);
    assert.deepEqual({ ...twice.event }, { ...once.event });
  }
});

test('exec-contract: unknown event types fail closed (no guessed event)', () => {
  const unknown = schema.validateExecutionEvent(eventFor('execution/heartbeat'));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'EXEC_EVENT_TYPE_UNKNOWN');
  assert.equal(unknown.event, null, 'a rejected event must not carry a normalized event');
  const noType = schema.validateExecutionEvent({ jobRef: JOB_REF, executionRef: EXEC_REF, attempt: 1, seq: 1, atMs: T0 });
  assert.equal(noType.ok, false);
});

test('exec-contract: the executor cannot smuggle evidence, team state or artifact ids', () => {
  // 未知字段一律拒绝 —— 这是"执行方不能自带終态证据"的结构性保证。
  for (const extra of [
    { evidence: 'execution/completed:ok' },
    { teamStatus: 'completed' },
    { artifactId: 'art:deadbeefdeadbeef' },
    { outcome: 'completed' },
    { role: 'researcher' },
    { runStatus: 'completed' },
    { prompt: 'hello' },
    { sessionId: 'sess-raw-value' },
    { content: 'model output' },
    { arguments: { cmd: 'rm -rf /' } },
  ]) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/completed', extra));
    assert.equal(verdict.ok, false, `field ${Object.keys(extra)[0]} must be rejected`);
    assert.equal(verdict.code, 'EXEC_UNKNOWN_FIELD');
  }
  // 白名单本身是冻结的。
  assert.ok(Object.isFrozen(schema.EXECUTION_EVENT_FIELDS));
  assert.equal(schema.EXECUTION_EVENT_FIELDS.includes('evidence'), false);
});

test('exec-contract: artifact-only fields are refused on non-artifact events (but null is fine, idempotently)', () => {
  // 非 artifact 事件带**非 null** kind/digest/location → 拒绝。
  for (const extra of [{ kind: 'research-notes' }, { digest: 'exec-sha256:0123456789abcdef' }, { locationRef: 'ref:abc' }]) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/completed', extra));
    assert.equal(verdict.ok, false, `${Object.keys(extra)[0]} on non-artifact must be rejected`);
    assert.equal(verdict.code, 'EXEC_UNKNOWN_FIELD');
  }
  // 归一化补的 null 允许再次通过（幂等，见上一条测试）。
  const normalized = schema.validateExecutionEvent(eventFor('execution/completed'));
  assert.equal(normalized.event.kind, null);
  assert.equal(schema.validateExecutionEvent(normalized.event).ok, true);
});

test('exec-contract: artifact kind must belong to the frozen team slot vocabulary', () => {
  const ok = schema.validateExecutionEvent(eventFor('execution/artifact', { kind: 'review-findings' }));
  assert.equal(ok.ok, true);
  for (const badKind of ['research_note', 'REVIEW-FINDINGS', 'prompt', '', 'artifact-v2']) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/artifact', { kind: badKind }));
    assert.equal(verdict.ok, false, `kind "${badKind}" must be rejected`);
    assert.equal(verdict.code, 'EXEC_ARTIFACT_KIND_UNKNOWN');
  }
});

test('exec-contract: digest and location are opaque shapes — a path can never pass', () => {
  const digestOk = schema.validateExecutionEvent(eventFor('execution/artifact', { digest: 'exec-sha256:0123456789abcdef' }));
  assert.equal(digestOk.ok, true);
  for (const bad of ['sha256:0123456789abcdef', '0123456789abcdef', 'exec-sha256:ZZZ', 'exec-md5:0123456789abcdef']) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/artifact', { digest: bad }));
    assert.equal(verdict.ok, false, `digest "${bad}" must be rejected`);
    assert.equal(verdict.code, 'EXEC_DIGEST_INVALID');
  }
  const refOk = schema.validateExecutionEvent(eventFor('execution/artifact', { locationRef: 'ref:abc-123_X' }));
  assert.equal(refOk.ok, true);
  // 路径形状（`/`、`..`、空白、超长）不可能通过。
  for (const bad of ['/etc/passwd', 'C:\\Users\\me', '../../secret', 'ref:../../secret', 'ref:has space', 'ref:' + 'a'.repeat(65), 'file:///tmp/x']) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/artifact', { locationRef: bad }));
    assert.equal(verdict.ok, false, `locationRef "${bad}" must be rejected`);
    assert.equal(verdict.code, 'EXEC_LOCATION_INVALID');
  }
});

test('exec-contract: reason is a coarse token — prose can never pass', () => {
  const ok = schema.validateExecutionEvent(eventFor('execution/completed', { reason: 'tool-error' }));
  assert.equal(ok.ok, true);
  for (const bad of [
    'Tool Error', 'needs approval', 'a'.repeat(41), 'UPPER', 'has:colon',
    'The model said it failed', 'why did it fail?', '<html>', 'a\nb',
  ]) {
    const verdict = schema.validateExecutionEvent(eventFor('execution/failed', { reason: bad }));
    assert.equal(verdict.ok, false, `reason "${bad}" must be rejected`);
    assert.equal(verdict.code, 'EXEC_REASON_INVALID');
  }
  // reason 与 Team 契约的 attention reason **同口径**（同一正则来源），
  // 因此执行层的 reason 一定能被 Team 接受 —— 口径一致而不是"看起来差不多"。
  assert.equal(schema.EXEC_REASON_RE.source, team.schema.ATTENTION_REASON_RE.source);
  assert.equal(schema.EXEC_REASON_MAX_CHARS, 40);
  // attention / crashed **必须**显式给 reason（不接受默认值）。
  for (const type of ['execution/attention', 'execution/crashed']) {
    const missing = schema.validateExecutionEvent({
      schemaVersion: 1, type, jobRef: JOB_REF, executionRef: EXEC_REF, attempt: 1, seq: 1, atMs: T0,
    });
    assert.equal(missing.ok, false, `${type} without reason must be rejected`);
    assert.equal(missing.code, 'EXEC_REASON_INVALID');
  }
});

test('exec-contract: identity fields are validated (raw ids cannot stand in for derived handles)', () => {
  const raw = schema.validateExecutionEvent({
    schemaVersion: 1, type: 'execution/completed',
    jobRef: 'job-contract-1', executionRef: 'job-contract-1:researcher:1',
    attempt: 1, seq: 1, atMs: T0,
  });
  assert.equal(raw.ok, false, 'raw jobId/runId must not pass as refs');
  assert.equal(raw.code, 'EXEC_IDENTITY_INVALID');
  // attempt / seq / atMs 形状。
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { attempt: 0 })).code, 'EXEC_ATTEMPT_INVALID');
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { seq: 0 })).code, 'EXEC_SEQUENCE_INVALID');
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { atMs: 'now' })).code, 'EXEC_EVENT_SHAPE_INVALID');
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { atMs: Number.NaN })).code, 'EXEC_EVENT_SHAPE_INVALID');
  // schemaVersion。
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { schemaVersion: 2 })).code, 'EXEC_SCHEMA_VERSION_UNSUPPORTED');
  assert.equal(schema.validateExecutionEvent(eventFor('execution/completed', { schemaVersion: 1 })).ok, true);
});

// ===========================================================================
// 3. 身份关联 / 顺序 / 重复（纯函数）
// ===========================================================================

test('exec-contract: identity mismatch fails closed on job / run / attempt', () => {
  const expected = { jobRef: JOB_REF, executionRef: EXEC_REF, attempt: 1 };
  const good = schema.validateExecutionEvent(eventFor('execution/completed')).event;
  assert.equal(schema.assertExecutionIdentity(good, expected).ok, true);
  assert.equal(
    schema.assertExecutionIdentity({ ...good, jobRef: schema.execJobRefFor('other-job') }, expected).code,
    'EXEC_IDENTITY_MISMATCH',
  );
  assert.equal(
    schema.assertExecutionIdentity({ ...good, executionRef: schema.executionRefFor(JOB, RUN, 2) }, expected).code,
    'EXEC_IDENTITY_MISMATCH',
  );
  assert.equal(
    schema.assertExecutionIdentity({ ...good, attempt: 2 }, expected).code,
    'EXEC_IDENTITY_MISMATCH',
  );
});

test('exec-contract: duplicate and out-of-order events are fail-closed; gaps are a diagnostic', () => {
  const e = (seq) => schema.validateExecutionEvent(eventFor('execution/started', { seq })).event;
  // 首条事件总是合法。
  assert.equal(schema.orderExecutionEvent(e(1), null).ok, true);
  // 同 seq → duplicate。
  assert.equal(schema.orderExecutionEvent(e(3), 3).code, 'EXEC_DUPLICATE');
  // 更小 seq → out-of-order。
  assert.equal(schema.orderExecutionEvent(e(2), 5).code, 'EXEC_OUT_OF_ORDER');
  // 连续前进 → 合法、无诊断。
  const contiguous = schema.orderExecutionEvent(e(6), 5);
  assert.equal(contiguous.ok, true);
  assert.deepEqual([...contiguous.diagnostics], []);
  // 前跳 → 合法但记诊断（后端可能全局编号）。
  const gap = schema.orderExecutionEvent(e(9), 5);
  assert.equal(gap.ok, true);
  assert.deepEqual([...gap.diagnostics], ['EXEC_SEQUENCE_GAP']);
});

test('exec-contract: evidence exists ONLY for terminal events (structural "no evidence, no terminal")', () => {
  for (const type of schema.TERMINAL_EXECUTION_EVENT_TYPES) {
    const event = schema.validateExecutionEvent(eventFor(type)).event;
    const evidence = schema.evidenceForExecutionEvent(event);
    assert.equal(typeof evidence, 'string');
    // evidence = `execution/<outcome>:<reason>`，命中 Team 契约的 EVIDENCE_RE。
    assert.match(evidence, /^execution\/[a-z]+:[a-z][a-z0-9_-]{0,39}$/);
    assert.match(evidence, team.schema.EVIDENCE_RE, 'evidence must satisfy the Team contract shape');
    assert.ok(evidence.length <= team.schema.EVIDENCE_MAX_CHARS);
  }
  for (const type of [...schema.CONTROL_EXECUTION_EVENT_TYPES, ...schema.NON_TERMINAL_EXECUTION_EVENT_TYPES]) {
    const event = schema.validateExecutionEvent(eventFor(type)).event;
    assert.equal(schema.evidenceForExecutionEvent(event), null,
      `${type} must not be able to produce evidence`);
    // attention 例外：它**不是**终态，因此也没有 evidence（只是 Team 的 attention reason）。
    if (type === 'execution/attention') assert.equal(schema.isTerminalEventType(type), false);
  }
});

test('exec-contract: the conversion table maps every event to exactly one team action', () => {
  for (const type of schema.EXECUTION_EVENT_TYPES) {
    const action = schema.teamActionForExecutionEvent({ type });
    assert.equal(typeof action, 'string', `${type} must have a team action`);
  }
  // 终态三类 → note-terminal；控制回执 → 各自的动作（且都不是 terminal）。
  assert.equal(schema.teamActionForExecutionEvent({ type: 'execution/completed' }), 'note-terminal');
  assert.equal(schema.teamActionForExecutionEvent({ type: 'execution/cancel-acknowledged' }), 'note-cancel-ack');
  // crash 默认策略 → attention（不是 note-terminal）。
  assert.equal(schema.teamActionForExecutionEvent({ type: 'execution/crashed' }), 'note-attention');
  assert.notEqual(schema.teamActionForExecutionEvent({ type: 'execution/crashed' }), 'note-terminal');
  // 未知 → null（fail-closed 上游）。
  assert.equal(schema.teamActionForExecutionEvent({ type: 'execution/heartbeat' }), null);
  assert.equal(schema.teamActionForExecutionEvent(null), null);
});

test('exec-contract: the stable code and diagnostic vocabularies are frozen and sorted-by-use', () => {
  assert.ok(Object.isFrozen(schema.EXECUTION_CODES));
  assert.ok(Object.isFrozen(schema.EXECUTION_DIAGNOSTICS));
  assert.equal(new Set(schema.EXECUTION_CODES).size, schema.EXECUTION_CODES.length);
  // 契约里点名的码必须都在。
  for (const code of [
    'EXEC_EVENT_TYPE_UNKNOWN', 'EXEC_UNKNOWN_FIELD', 'EXEC_IDENTITY_INVALID',
    'EXEC_IDENTITY_MISMATCH', 'EXEC_DUPLICATE', 'EXEC_OUT_OF_ORDER',
    'EXEC_TERMINAL_EVIDENCE_REQUIRED', 'EXEC_HANDLE_TERMINAL',
    'EXEC_ALREADY_BOUND', 'EXEC_PORT_SHAPE_INVALID', 'EXEC_TRANSPORT_UNAVAILABLE',
  ]) {
    assert.ok(schema.EXECUTION_CODES.includes(code), `missing stable code ${code}`);
  }
});

// ===========================================================================
// 4. 端口形状（interface shape）
// ===========================================================================

test('exec-contract: the executor port requires startRun/observe/cancel and an explicit recover stance', () => {
  // 形状完全合法。
  const good = { startRun() {}, observe() {}, cancel() {}, recover() {} };
  const verdict = port.assertExecutorPort(good);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.supportsRecover, true);

  // 缺必需方法 → 明确列出缺哪个。
  const missingCancel = port.assertExecutorPort({ startRun() {}, observe() {}, recover() {} });
  assert.equal(missingCancel.ok, false);
  assert.equal(missingCancel.code, 'EXEC_PORT_SHAPE_INVALID');
  assert.deepEqual(missingCancel.missing, ['cancel']);

  // 必需方法不是函数 → invalid（与 missing 区分）。
  const notFn = port.assertExecutorPort({ startRun() {}, observe: 42, cancel() {}, recover() {} });
  assert.equal(notFn.ok, false);
  assert.deepEqual(notFn.invalid, ['observe']);

  // recover 缺失但**显式声明**不支持 → 合法（前面的 4.x 单测里 cancel/ack 走这条路）。
  const declared = port.assertExecutorPort({ startRun() {}, observe() {}, cancel() {}, unsupported: ['recover'] });
  assert.equal(declared.ok, true);
  assert.equal(declared.supportsRecover, false);

  // recover 缺失且**没有**声明 → 形状非法（不允许静默缺失：那会让"崩溃能否恢复"不可知）。
  const silent = port.assertExecutorPort({ startRun() {}, observe() {}, cancel() {} });
  assert.equal(silent.ok, false);
  assert.equal(silent.code, 'EXEC_PORT_SHAPE_INVALID');

  // 非对象。
  assert.equal(port.assertExecutorPort(null).code, 'EXEC_PORT_SHAPE_INVALID');
  assert.equal(port.assertExecutorPort('executor').code, 'EXEC_PORT_SHAPE_INVALID');
});

test('exec-contract: the execution handle is a derived internal handle with a frozen field whitelist', () => {
  const handle = port.createExecutionHandle({
    jobRef: JOB_REF, executionRef: EXEC_REF, role: 'researcher', attempt: 1, startedAtMs: T0, supportsRecover: true,
  });
  assert.ok(Object.isFrozen(handle));
  assert.match(handle.handleId, port.EXEC_HANDLE_RE);
  assert.deepEqual(Object.keys(handle).sort(), [...port.HANDLE_FIELDS].sort(),
    'handle field set is frozen');
  assert.equal(port.assertExecutionHandle(handle).ok, true);
  // handleId 与 executionRef 必须一致（不能自造身份无关的 handle）。
  assert.equal(
    port.assertExecutionHandle({ ...handle, handleId: 'exec-handle:ffffffffffffffff' }).code,
    'EXEC_HANDLE_UNKNOWN',
  );
  // 额外字段（例如 raw sessionId / provider 对象）一律拒绝。
  assert.equal(
    port.assertExecutionHandle({ ...handle, sessionId: 'sess-raw' }).code,
    'EXEC_HANDLE_UNKNOWN',
  );
  assert.equal(
    port.assertExecutionHandle({ ...handle, provider: { token: 'sk-x' } }).code,
    'EXEC_HANDLE_UNKNOWN',
  );
  // 非法派生输入。
  assert.equal(port.createExecutionHandle({ jobRef: 'job-1', executionRef: EXEC_REF, role: 'researcher', attempt: 1 }), null);
  assert.equal(port.createExecutionHandle({ jobRef: JOB_REF, executionRef: EXEC_REF, role: '', attempt: 1 }), null);
});

test('exec-contract: a cancel ack is normalized and can NEVER be a terminal outcome', () => {
  assert.deepEqual({ ...port.normalizeCancelAck({ acknowledged: true, atMs: T0, reason: 'x' }) },
    { ok: true, code: null, acknowledged: true, atMs: T0, reason: 'x' });
  assert.equal(port.normalizeCancelAck({ acknowledged: false }).acknowledged, false);
  assert.equal(port.normalizeCancelAck(null).ok, false);
  // ack 的字段集合里没有 outcome / terminal。
  const ack = port.normalizeCancelAck({ acknowledged: true });
  assert.equal('outcome' in ack, false);
  assert.equal('terminal' in ack, false);
});

// ===========================================================================
// 5. 层级纯度：无 office / 无 timers / 无网络 / 无第二套事实日志
// ===========================================================================

test('exec-contract: the new execution layer has no office edge, no timers, no network, no fs', () => {
  const NEW_MODULES = [
    'execution-schema.js', 'execution-port.js', 'fake-executor.js',
    'team-execution-controller.js', 'dsh-execution-backend.js',
  ];
  const offenders = [];
  for (const name of NEW_MODULES) {
    const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    for (const spec of requiresOf(source)) {
      if (/office|render|\/main\.js|electron|pixi|ws$/.test(spec)) offenders.push(`${name} -> ${spec}`);
      if (spec.startsWith('node:') && spec !== 'node:crypto') offenders.push(`${name} -> ${spec}`);
    }
    // 无 timers / 无墙钟 / 无网络 / 无 DOM。
    for (const pattern of [
      /\bsetTimeout\s*\(/, /\bsetInterval\s*\(/, /\bDate\.now\s*\(/,
      /\bfetch\s*\(/, /\bdocument\s*\./, /\bwindow\s*\./, /\bXMLHttpRequest\b/,
    ]) {
      if (pattern.test(source)) offenders.push(`${name} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [],
    'execution layer must be pure: no office/render/electron/fs/timers/network/DOM/wall-clock');
});

test('exec-contract: only the controller may call Team commands (the single conversion point)', () => {
  // M14 的靶子：executor / backend 一旦能触达 Team 命令，"执行事实"就退化成"某人写的状态"。
  // 结构性证据有两条：
  //   1. 这些文件**不 require** team-runtime（也就拿不到 runtime 对象）；
  //   2. 这些文件里**没有**任何指向 Team 命令的调用点（`team.<cmd>(` / `runtime.<cmd>(`）。
  const NON_CONVERTERS = ['execution-schema.js', 'execution-port.js', 'fake-executor.js', 'dsh-execution-backend.js'];
  const TEAM_COMMANDS = [
    'createJob', 'dispatchRun', 'startRun', 'noteArtifact', 'noteRunTerminal',
    'noteRunAttention', 'requestCancel', 'noteCancelAcknowledged',
  ];
  const offenders = [];
  for (const name of NON_CONVERTERS) {
    const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    for (const spec of requiresOf(source)) {
      if (/team-runtime|team-office-demo/.test(spec)) offenders.push(`${name} -> require(${spec})`);
    }
    for (const command of TEAM_COMMANDS) {
      // 只匹配"通过某个 runtime 引用调用 Team 命令"的形状；本层自己的端口方法
      // （如 fake-executor 的 startRun）不算 —— 它产出的是事件，不是 Team fact。
      const viaBinding = new RegExp(`\\b(team|teamRuntime|runtime|teamR|this\\.team)\\s*\\.\\s*${command}\\s*\\(`);
      if (viaBinding.test(source)) offenders.push(`${name} calls Team command ${command}() via a binding`);
    }
  }
  assert.deepEqual(offenders, [],
    'the executor/backend/schema must not reach Team commands; only team-execution-controller may');

  // 反向证据：controller 确实**是**那个唯一转换点（它 require team-runtime 吗？不 ——
  // 它通过注入拿到 runtime，但它是唯一出现 Team 命令调用的文件）。
  const controllerSource = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'team-execution-controller.js'), 'utf8'));
  for (const command of ['dispatchRun', 'startRun', 'noteRunTerminal', 'requestCancel', 'noteCancelAcknowledged']) {
    assert.ok(
      new RegExp(`\\bteam\\s*\\.\\s*${command}\\s*\\(`).test(controllerSource),
      `controller must be the single conversion point (expected team.${command}())`,
    );
  }
});

test('exec-contract: no module introduces a second fact log or a second terminal rule', () => {
  // 执行层的事件不是"事实日志"：它没有 append-only 账本、没有 seq 权威、
  // 没有自己的终态状态机（终态由 Team 判定）。这里用结构性检查钉住：
  // 执行层不得导出任何"journal/facts/log"式 API。
  const surface = team.executionSchema;
  assert.equal(typeof surface.validateExecutionEvent, 'function');
  for (const forbidden of ['appendFact', 'facts', 'journal', 'state', 'fold', 'replay']) {
    assert.equal(forbidden in surface, false, `execution-schema must not export ${forbidden}`);
  }
  // 全仓只有一处 Team 事实作者：team-runtime 的 facts()（已在 team-runtime-v0 门禁里断言）。
  // 这里再断言：Team 事实类型集合没有被执行层扩张。
  assert.deepEqual([...team.schema.FACT_TYPES], [
    'job/created', 'run/dispatched', 'run/started', 'run/progress', 'artifact/available',
    'run/completed', 'run/failed', 'run/cancelled', 'run/attention',
    'run/cancel-requested', 'run/cancel-acknowledged',
    'job/completed', 'job/failed', 'job/cancelled', 'job/attention',
  ]);
});

test('exec-contract: the team runtime manifest declares every new module (no silent files)', () => {
  const declared = [...team.TEAM_MODULES, team.TEAM_SURFACE_FILE].sort();
  const actual = fs.readdirSync(TEAM_RUNTIME_DIR).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(declared, actual,
    'each execution-layer file must be declared in src/team/runtime/index.js');
  for (const name of ['execution-schema.js', 'execution-port.js', 'fake-executor.js',
    'team-execution-controller.js', 'dsh-execution-backend.js']) {
    assert.ok(team.TEAM_MODULES.includes(name), `${name} must be in TEAM_MODULES`);
  }
});

test('exec-contract: the execution layer loads in plain Node with electron unavailable', () => {
  const originalLoad = Module._load;
  const failures = [];
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (request === 'electron') throw new Error('electron is unavailable in this probe');
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const name of ['execution-schema.js', 'execution-port.js', 'fake-executor.js',
      'team-execution-controller.js', 'dsh-execution-backend.js']) {
      const file = path.join(TEAM_RUNTIME_DIR, name);
      try {
        delete require.cache[require.resolve(file)];
        require(file);
      } catch (error) {
        failures.push(`${name}: ${error && error.message}`);
      }
    }
  } finally {
    Module._load = originalLoad;
  }
  assert.deepEqual(failures, []);
});
// ===========================================================================
// 6. 门禁自身的健全性（防"断言静默失效"，2026-10-22 负向变异 M13 的经验）
// ===========================================================================

test('exec-contract: the comment stripper used by the purity gates is not blind (regression)', () => {
  // 背景：旧实现"正则先删块注释、再删行注释"，当**行注释里出现 `/*`**
  // （本层模块头注释会写 `team/*`、`job/*`）时，它被视为块注释开始，
  // 于是从该处到源码里第一个 `*/` 之间的**真实代码被吞掉** ——
  // 素性/依赖断言因此静默失效（M13 变异实测未检出）。
  const sample = [
    '// header mentions team/* and job/* namespaces',
    "const a = require('node:crypto');",
    "const b = require('./team-runtime.js');",   // 注释里出现 /* 之后仍必须被看到
    '/* a real block comment */',
    "const c = require('electron');",
  ].join('\n');
  const stripped = stripComments(sample);
  const specs = [...stripped.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(specs, ['node:crypto', './team-runtime.js', 'electron'],
    'the stripper must see every require (a comment containing "/*" must not swallow code)');
  // 反向：真正的块注释仍要被移除（否则会有误报）。
  assert.equal(/a real block comment/.test(stripped), false);
  assert.equal(/header mentions/.test(stripped), false);

  // 并且：对**真实的**团队模块，剥离后必须仍能看见每个模块的 require
  // （team-schema / execution-schema 的 require('node:crypto') 是这条的实证靶子）。
  for (const name of ['team-schema.js', 'execution-schema.js', 'fake-executor.js', 'dsh-execution-backend.js']) {
    const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    assert.ok(requiresOf(source).length > 0, `${name} must expose its requires after stripping`);
  }
  assert.ok(requiresOf(stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'team-schema.js'), 'utf8')))
    .includes('node:crypto'), 'team-schema.js must expose require("node:crypto")');
});

test('exec-contract: an office import injected into ANY team module is caught by the purity gate (M13)', () => {
  // 直接把"注入 office require"这一变异**在测试里复现**，证明门禁真的会失败。
  // 这比"依赖某个具体文件的静态检查"更强：它对每个模块逐个验证。
  const OFFICE_SAMPLE = "const _office = require('../../office/office-module.js');";
  for (const name of team.TEAM_MODULES) {
    const real = fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8');
    const mutated = `${OFFICE_SAMPLE}\n${real}`;
    const specs = requiresOf(stripComments(mutated));
    assert.ok(specs.some((spec) => /office-module|office\/runtime/.test(spec)),
      `${name}: an injected office import must be visible to the gate`);
  }
});

// ===========================================================================
// 7. 证据来源白名单一致性（A-T9：机械防止 P0-1 复发）
// ===========================================================================

test('exec-contract: every execution terminal evidence prefix is trusted by the office kernel (A-T9)', () => {
  // 背景（P0-1，2026-10-22 实测）：office 内核的受信终态证据来源白名单原本只有
  // turn-end / subagent-end / session-end，而执行层的证据形状是 `execution/<outcome>:<reason>`。
  // 结果：Team 完成 run → office `releaseBinding` 返回 TERMINAL_EVIDENCE_REQUIRED
  //      → 组合根记 RELEASE_FAILED → **座位永久停留 bound**（无报错，只有一条诊断）。
  //
  // 本测试把这个"两处白名单必须同步"的纪律**机械化**：从执行层**实际会产生的**
  // 终态证据里取出前缀，断言 office 内核的两个白名单都认得它。这样将来引入新的
  // 执行证据命名空间（例如 worker/*、sandbox/*）时，忘记同步会立刻变红灯，
  // 而不是变成一个静默的"Team 已完成、座位永久占用"。
  const registry = require('../src/office/runtime/employee-registry.js');
  const queue = require('../src/office/runtime/queue-controller.js');
  const officeEpisode = require('../src/office/office-module.js');
  void officeEpisode;

  // ① 执行层**真的**会产生的终态证据（用 schema 的公开入口构造，而不是猜字符串）。
  const terminalEvidences = schema.TERMINAL_EXECUTION_EVENT_TYPES.map((type) => {
    const event = schema.validateExecutionEvent({
      schemaVersion: 1, type, jobRef: JOB_REF, executionRef: EXEC_REF, attempt: 1, seq: 1, atMs: T0,
    }).event;
    return schema.evidenceForExecutionEvent(event);
  }).filter((evidence) => typeof evidence === 'string');
  assert.equal(terminalEvidences.length, 3, 'there must be exactly three terminal evidence strings');

  // ② 每个证据的**来源前缀**（`<source>:<reason>` 的第一段）。
  const prefixes = [...new Set(terminalEvidences.map((evidence) => evidence.split(':')[0]))];
  assert.deepEqual(prefixes, ['execution/completed', 'execution/failed', 'execution/cancelled'],
    'terminal evidences must use the execution/* namespace (never a provider vocabulary)');

  // ③ office 内核必须接受这些前缀 —— 两个白名单都要认得（P0-1 的两个改动点）。
  for (const evidence of terminalEvidences) {
    // 经 queue-controller 的公开常量：它的 evidenceType 由内核从 evidence 字符串推出。
    const derived = queue.TERMINAL_EVIDENCE_TYPES.find((type) => evidence.includes(`${type}/`) || evidence.includes(type));
    assert.ok(derived, `queue-controller must trust a source usable by "${evidence}"`);
    // registry 的白名单是通过它自己的导出常量声明的（NON_TERMINAL_EVIDENCE 反证）。
    assert.equal(registry.NON_TERMINAL_EVIDENCE.some((token) => evidence.includes(token)), false,
      `"${evidence}" must not look like a delivery acknowledgement`);
  }
  // ④ 反向：执行层的 control 回执**必须**被两个白名单都拒绝（ack ≠ terminal）。
  const ackEvent = schema.validateExecutionEvent({
    schemaVersion: 1, type: 'execution/cancel-acknowledged',
    jobRef: JOB_REF, executionRef: EXEC_REF, attempt: 1, seq: 1, atMs: T0,
  }).event;
  assert.equal(schema.evidenceForExecutionEvent(ackEvent), null,
    'a control receipt must not be able to produce evidence at all');
  // 结构性：即使有人手工把 ack 拼成证据，它也必须命中 NON_TERMINAL_EVIDENCE。
  const forgedAck = 'execution/cancel-acknowledged:acknowledged';
  assert.equal(registry.NON_TERMINAL_EVIDENCE.some((token) => forgedAck.includes(token)), true,
    'a forged ack evidence must still be refused by the office kernel');
});

test('exec-contract: the two office evidence whitelists stay in sync with each other (A-T9 structural)', () => {
  // 第二个方向：两个白名单**互相**一致（同源纪律）。
  const registrySource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'office', 'runtime', 'employee-registry.js'), 'utf8'));
  const queueSource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'office', 'runtime', 'queue-controller.js'), 'utf8'));
  const queue = require('../src/office/runtime/queue-controller.js');

  // employee-registry 用 `lowered.includes('<source>')` 形状声明它信任的来源。
  const registrySources = [...registrySource.matchAll(/lowered\.includes\('([^']+)'\)/g)]
    .map((m) => m[1])
    .filter((token) => token.includes('/') || token.includes('-'));
  assert.ok(registrySources.length >= 4, `employee-registry must declare its trusted sources (got ${registrySources.length})`);

  // queue-controller 的每个来源都必须在 registry 里也被认得（形状归一化后比较）。
  const normalize = (token) => token.replace(/[/-]/g, '');
  const registryNormalized = new Set(registrySources.map(normalize));
  for (const type of queue.TERMINAL_EVIDENCE_TYPES) {
    assert.ok(registryNormalized.has(normalize(type)),
      `queue-controller trusts "${type}" but employee-registry does not declare it — the two whitelists drifted`);
  }
  // 反向：registry 声明的每个来源都必须被 queue-controller 覆盖。
  const queueNormalized = new Set([...queue.TERMINAL_EVIDENCE_TYPES].map(normalize));
  for (const source of registrySources) {
    assert.ok(queueNormalized.has(normalize(source)),
      `employee-registry trusts "${source}" but queue-controller does not — the two whitelists drifted`);
  }
  // 且 queue-controller 的来源声明是一处**冻结常量**（不是散落的字符串）。
  assert.match(queueSource, /const TERMINAL_EVIDENCE_TYPES = Object\.freeze\(\[/);
});
