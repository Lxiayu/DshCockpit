'use strict';

// Task 1 / SPEC-01 shared privacy redactor contract.
// RED: src/office/runtime/privacy-redactor.js does not exist yet.
// The redactor is pure deterministic CommonJS, reusable by SPEC-05 (adapter
// hashing) and SPEC-08 (diagnostics/persistence): it removes prompt text,
// tool arguments/results, Session IDs, paths, token counts and secrets while
// preserving coarse event/status fields.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createPrivacyRedactor, REDACTED } = require(
  path.join(ROOT, 'src', 'office', 'runtime', 'privacy-redactor.js')
);

test('redactText replaces prompt text with a stable deterministic placeholder', () => {
  const redactor = createPrivacyRedactor();
  assert.equal(redactor.redactText('please fix the login bug, use token 12345'), REDACTED.TEXT);
  assert.equal(
    redactor.redactText('please fix the login bug, use token 12345'),
    redactor.redactText('please fix the login bug, use token 12345')
  );
  assert.equal(redactor.redactText(''), '');
  assert.equal(redactor.redactText(null), '');
});

test('redactValue removes session ids, paths, tokens and secrets but keeps coarse enums', () => {
  const redactor = createPrivacyRedactor();
  const input = {
    status: 'running',
    reason: 'completed',
    type: 'tool/call',
    sessionId: 'sess-FIXTURE-001',
    runId: 'run-FIXTURE-1',
    cwd: '/Users/someone/secret-project',
    args: { command: 'rm -rf /', query: 'internal roadmap' },
    result: { output: 'FIXTURE-OUTPUT', tokens: 987654 },
    apiKey: 'sk-FIXTURE-SECRET',
    userMessage: 'FIXTURE-PROMPT',
    nested: { deeper: [{ secret: 'hunter2', note: 'note text' }] },
    count: 3,
  };
  const out = redactor.redactValue(input);
  assert.equal(out.status, 'running');
  assert.equal(out.reason, 'completed');
  assert.equal(out.type, 'tool/call');
  assert.equal(out.sessionId, REDACTED.SESSION);
  assert.equal(out.runId, REDACTED.SESSION);
  assert.equal(out.cwd, REDACTED.PATH);
  assert.equal(out.args.command, REDACTED.TEXT);
  assert.equal(out.result.tokens, REDACTED.TOKENS);
  assert.equal(out.apiKey, REDACTED.SECRET);
  assert.equal(out.userMessage, REDACTED.TEXT);
  assert.equal(out.nested.deeper[0].secret, REDACTED.SECRET);
  assert.equal(out.nested.deeper[0].note, REDACTED.TEXT);
  assert.equal(out.count, 3);

  // pure: input is never mutated
  assert.equal(input.args.command, 'rm -rf /');
  assert.equal(input.result.tokens, 987654);
  // deterministic
  assert.deepEqual(redactor.redactValue(input), out);
});

test('sensitive value shapes are redacted even when the key name is innocent', () => {
  const redactor = createPrivacyRedactor();
  assert.equal(redactor.redactValue({ note: '/Users/xia/program/dsh' }).note, REDACTED.PATH);
  assert.equal(
    redactor.redactValue({ note: 'sess-8f2c1a90-1234-4abc-9def-001122334455' }).note,
    REDACTED.SESSION
  );
  assert.equal(redactor.redactValue({ note: 'Bearer abc.def.ghi' }).note, REDACTED.SECRET);
  assert.equal(redactor.redactValue({ note: 'sk-live-abcdef123456' }).note, REDACTED.SECRET);
  assert.equal(redactor.redactValue({ note: 'run-FIXTURE-1' }).note, REDACTED.SESSION);
});

test('full mode keeps readable text but still strips session ids, paths and secrets', () => {
  const full = createPrivacyRedactor({ mode: 'full' });
  assert.equal(full.redactText('hello'), 'hello');
  assert.equal(full.redactValue({ userMessage: 'FIXTURE-PROMPT' }).userMessage, 'FIXTURE-PROMPT');
  assert.equal(full.redactValue({ sessionId: 'sess-FIXTURE-001' }).sessionId, REDACTED.SESSION);
  assert.equal(full.redactValue({ apiKey: 'sk-FIXTURE-SECRET' }).apiKey, REDACTED.SECRET);
  assert.equal(full.redactValue({ cwd: '/Users/someone/x' }).cwd, REDACTED.PATH);
});

test('redactEvent keeps only type/seq/time and data key names', () => {
  const redactor = createPrivacyRedactor();
  const out = redactor.redactEvent({
    type: 'tool/call',
    seq: 2,
    time: 5,
    data: { tool: 'bash', args: { command: 'rm -rf /' }, sessionId: 'sess-9' },
  });
  assert.deepEqual(out, {
    type: 'tool/call',
    seq: 2,
    time: 5,
    dataKeys: ['args', 'sessionId', 'tool'],
  });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('rm -rf'), 'no tool payload');
  assert.ok(!json.includes('sess-9'), 'no session id');
});

test('redactor is pure CommonJS: no electron, pixi, fs or network usage', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src', 'office', 'runtime', 'privacy-redactor.js'),
    'utf8'
  );
  assert.match(src, /['"]use strict['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]electron['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]pixi/);
  assert.doesNotMatch(src, /require\(\s*['"]node:fs['"]/);
  assert.doesNotMatch(src, /require\(\s*['"]fs['"]/);
  assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest/);
});

// ---------------------------------------------------------------------------
// 2026-10-18 边界测试：短 token 与身份字段（Team 第二阶段接入前的显式口径）
//
// 实测口径（下表即当前行为，逐条钉住）：
//   - 值形状（classifyByShape）优先：secret / UUID / 长 hex / `sess-`|`run-`|`agent-`|`rpc-`
//     前缀 / 路径 → 一律脱敏，与 key 名无关；
//   - 否则按 key 名的固定清单判断（session|runid|agentid|conversation|path|token|text…）；
//   - 否则按**枚举形状**放行：`^[a-z][a-z0-9_/-]{0,31}$`（≤32 字符）原样保留；
//   - 超过 32 字符且不匹配任何形状 → [REDACTED:text]。
//
// 结论（重要，不要"顺手改"）：`id` / `childId` **不在** session key 清单里，因此**短小写
// 不透明 id**（如 `child-y`）会被当作粗粒度枚举原样保留。这条口径同时是"工具名 bash 可见、
// 事件类型 tool/call 可见、状态枚举可见"的原因 —— 它是有意设计，不是遗漏。
// 见契约 §12「短 token 边界」。
// ---------------------------------------------------------------------------

test('boundary: which identity KEY names are covered, and which are not', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  const SHORT = 'child-y'; // 形状与粗粒度枚举无法区分
  // **已覆盖**（命中 SESSION_KEY_RE 的 key 清单 session|runid|run_id|agentid|agent_id|conversation）：
  // 即使值是短 token 也被强制脱敏。
  for (const covered of ['runId', 'run_id', 'sessionId', 'session_id', 'agentId', 'workerRunId', 'producerRunId']) {
    assert.equal(redactor.redactValue({ [covered]: SHORT })[covered], REDACTED.SESSION, covered);
  }
  // **未覆盖（已记录的缺口）**：这些 key 不在 session 清单里，于是短 token 原样保留。
  // 其中 `id` / `childId` 正是 subagent payload 里**子会话 id** 所在的位置。
  for (const gap of ['id', 'childId', 'child_id', 'artifactId', 'jobId']) {
    assert.equal(redactor.redactValue({ [gap]: SHORT })[gap], SHORT, gap);
  }
  // 32 字符是枚举形状的上界：32 保留、33 越界。
  const at32 = 'abcdefghijklmnopqrstuvwxyzabcdef';
  assert.equal(redactor.redactValue({ id: at32 }).id, at32);
  assert.equal(redactor.redactValue({ id: `${at32}g` }).id, REDACTED.TEXT);
});

test('boundary: our own derived ids do not survive the shape rules (phase-2 input)', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  // 这条是给第二阶段的设计输入：Team/office 的派生 id 都带 `:` 或 `-`，
  // **既不属于枚举形状，也不属于 session 值形状**（art: 前缀不在 sess/run/agent/rpc 清单里）。
  assert.equal(redactor.redactValue({ artifactId: 'art:0123456789abcdef' }).artifactId, REDACTED.TEXT);
  assert.equal(redactor.redactValue({ pairingHandle: 'run-sha256:0123456789abcdef' }).pairingHandle,
    REDACTED.SESSION);
  // 结论：第二阶段若要把这些 id 放进办公室快照，必须先做一次**显式的**词表变更
  // （按字段语义放行），而不是指望形状规则放行；否则快照里只会看到占位符。
  // v0 的立场是"快照只放计数/摘要，不放 id"，因此当前无需变更。
});

test('boundary: prefixed / UUID / long-hex identifiers are always redacted by shape', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  // 真实 Harness 的 session/child id 形状：带前缀或 UUID → 与 key 名无关地脱敏。
  for (const realistic of [
    'sess-child-y',
    'run-abc12345',
    'session-12345678',
    'agent-xyz98765',
    '550e8400-e29b-41d4-a716-446655440000',
    '0123456789abcdef0123',
  ]) {
    assert.equal(redactor.redactValue({ id: realistic }).id, REDACTED.SESSION, realistic);
    assert.equal(redactor.redactValue({ innocent: realistic }).innocent, REDACTED.SESSION, realistic);
    assert.equal(redactor.redactValue(realistic), REDACTED.SESSION, realistic);
  }
});

test('boundary: the enum allowance is load-bearing for tool names, event types and statuses', () => {
  const redactor = createPrivacyRedactor({ mode: 'redacted' });
  // 这些必须保持可见，否则办公室面板（工具短语/状态/时间线）会失去全部信息。
  for (const kept of ['bash', 'grep', 'edit', 'tool/call', 'turn/end', 'agent/status',
    'completed', 'aborted', 'running', 'idle', 'one-shot', 'continuable', '2026-10-18']) {
    assert.equal(redactor.redactValue({ tool: kept }).tool, kept, kept);
    assert.equal(redactor.redactValue({ value: kept }).value, kept, kept);
  }
});

test('boundary: redaction is an INPUT to eventId, so changing it changes fingerprints', () => {
  // 这是"不要顺手改脱敏器"的硬理由：adapter 的 eventId = sha256(... + canonicalJson(
  // REDACTED payload))。改脱敏规则 → 改 eventId → 改去重/水位行为（对进行中的会话
  // 尤其敏感）。因此脱敏变更必须作为独立变更并评估指纹影响。
  const { createRuntimeAdapter } = require('../src/office/runtime/runtime-adapter.js');
  const T0 = 1_700_000_000_000;
  const clock = { nowMs: () => T0 };
  const run = (data) => {
    const out = [];
    const adapter = createRuntimeAdapter({ sessionId: 's', clock, onEvent: (o) => out.push(o), onMessage: () => {} });
    const verdict = adapter.ingest({ type: 'tool/call', seq: 1, time: 1, data });
    return verdict.envelope;
  };
  // 同输入 → 同 eventId（确定性）。
  assert.equal(run({ tool: 'bash' }).eventId, run({ tool: 'bash' }).eventId);
  // 短的、会被当作枚举放行的身份值 → 会进入 payload → 会改变 eventId（即"泄漏面"
  // 与"指纹面"是同一个面）。
  const withShortId = run({ tool: 'bash', id: 'child-y' });
  const withoutId = run({ tool: 'bash' });
  assert.equal(withShortId.payload.id, 'child-y', 'documented gap: short id survives');
  assert.notEqual(withShortId.eventId, withoutId.eventId, 'and therefore changes the fingerprint');
  // 真实形状的 id 不会出现在 payload 里，也不参与指纹（被占位符取代）。
  const withRealId = run({ tool: 'bash', id: 'sess-child-y' });
  assert.equal(withRealId.payload.id, '[REDACTED:session-id]');
  assert.equal(JSON.stringify(withRealId.payload).includes('sess-child-y'), false);
});
