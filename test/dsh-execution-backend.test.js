'use strict';

// test/dsh-execution-backend.test.js — 阶段 5：DeepSeek dsh 执行后端适配骨架。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §9
// 盘点：docs/research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md
//
// 本文件**完全离线**：不启动 Harness、不发网络请求、不读文件系统（除读源码做
// 结构性断言）、不启动 Electron/DOM/Pixi。
//
// 覆盖（任务书 §11 与 §9.4 放行标准）：
//   - dsh journal → execution/* 的映射逐条有据（含"刻意降级为 attention"的未知 reason）
//   - 不兼容点被明确列出（且是代码里的常量，不是文档里的散文）
//   - 不支持能力 fail-closed（未注入 transport → EXEC_TRANSPORT_UNAVAILABLE）
//   - Team 不依赖 dsh 专有字段（事件里没有 journal type / raw identity）
//   - 无网络测试可以验证事件转换
//   - **未接入真实网络**（结构性 + 运行时双向证明）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
const schema = require('../src/team/runtime/execution-schema.js');
const team = require('../src/team/runtime/index.js');

const ROOT = path.join(__dirname, '..');
const TEAM_RUNTIME_DIR = path.join(ROOT, 'src', 'team', 'runtime');
const T0 = 1_700_000_000_000;
const JOB = 'job-dsh-1';
const RUN = 'job-dsh-1:researcher:1';

/** 去掉注释（单遍词法扫描；理由见 worker-execution-contract.test.js 的同名帮助函数）。 */
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

/** 一条 0.1.5 journal 事件。 */
function journalEvent(type, data = {}, seq = 1) {
  return { type, seq, time: T0 + seq, data };
}

function createBackend(options = {}) {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advanceClock = (ms) => { nowMs += ms; };
  return backendModule.createDshExecutionBackend({ clock, advanceClock, ...options });
}

// ===========================================================================
// 1. 映射表：每条都有仓库内的来源
// ===========================================================================

test('dsh-backend: the mapping table is complete and every row cites a real in-repo source', () => {
  const rows = backendModule.DSH_EXECUTION_MAPPING;
  assert.ok(Array.isArray(rows) && rows.length > 0);
  // 每条必须声明 dsh 事实 / 来源 / 映射目标 / 是否已覆盖。
  for (const row of rows) {
    assert.equal(typeof row.dshFact, 'string');
    assert.equal(typeof row.source, 'string');
    assert.equal(typeof row.mapsTo, 'string');
    assert.equal(typeof row.covered, 'boolean');
    assert.ok(row.source.length > 0, `row "${row.dshFact}" must cite a source`);
  }
  // 任务书 §9.1 点名的 dsh 事实必须都在表里（逐条对齐）。
  const dshFacts = rows.map((r) => r.dshFact).join(' | ');
  for (const needle of [
    'session start', 'turn end completed', 'turn end failed', 'turn end blocked',
    'cancel ack', 'child session', 'artifact', 'crash / reconnect', 'approval',
  ]) {
    assert.ok(dshFacts.includes(needle), `mapping table must cover "${needle}"`);
  }
  // 已覆盖的行必须指向一个真实存在的 execution/* 事件类型或"execution identity"。
  for (const row of rows.filter((r) => r.covered)) {
    if (row.mapsTo.startsWith('execution/')) {
      assert.ok(schema.EXECUTION_EVENT_TYPES.includes(row.mapsTo),
        `row "${row.dshFact}" maps to a non-existent event type ${row.mapsTo}`);
    }
  }
  // 未覆盖的行必须被 gaps 解释（不允许"悄悄漏掉"）。
  for (const row of rows.filter((r) => !r.covered)) {
    assert.ok(
      backendModule.DSH_BACKEND_GAPS.some((g) => row.mapsTo.includes(g.capability)),
      `uncovered row "${row.dshFact}" (mapsTo="${row.mapsTo}") must be explained by a documented gap`,
    );
  }
});

test('dsh-backend: every mapping source citation points at an existing file and line', () => {
  // 防止"来源"退化成散文：引用里的 `src/....js:NNN` 必须真的存在且行号在范围内。
  const citations = backendModule.DSH_EXECUTION_MAPPING
    .flatMap((row) => [...row.source.matchAll(/src\/[\w./-]+\.js:(\d+)(?:-(\d+))?/g)])
    .map((m) => ({ file: m[0].split(':')[0], line: Number(m[1]), end: m[2] ? Number(m[2]) : Number(m[1]) }));
  assert.ok(citations.length >= 5, 'the table must carry concrete file:line citations');
  for (const citation of citations) {
    const file = path.join(ROOT, citation.file);
    assert.ok(fs.existsSync(file), `cited file must exist: ${citation.file}`);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.ok(citation.line >= 1 && citation.line <= lines.length,
      `${citation.file}:${citation.line} is outside the file (${lines.length} lines)`);
    assert.ok(citation.end <= lines.length, `${citation.file}:${citation.end} is outside the file`);
  }
});

test('dsh-backend: the gap list states each incompatibility with a level and an actionable detail', () => {
  const gaps = backendModule.DSH_BACKEND_GAPS;
  assert.ok(gaps.length >= 3, 'the incompatible points must be listed, not glossed');
  for (const gap of gaps) {
    assert.match(gap.code, /^DSH_[A-Z_]+$/);
    assert.equal(typeof gap.capability, 'string');
    assert.ok(gap.detail.length > 30, `gap ${gap.code} detail must explain why (not just "unsupported")`);
    assert.ok(['P0', 'P1', 'P2'].includes(gap.level), `gap ${gap.code} must carry a P-level`);
  }
  // 最关键的一条：dsh 没有"按 role 起会话"的原语 → 必须 P0（否则会被静默实现成 prompt 生成）。
  const roleGap = gaps.find((g) => g.code === 'DSH_SESSION_ROLE_BINDING_UNDECIDED');
  assert.ok(roleGap, 'the role→session gap must be documented');
  assert.equal(roleGap.level, 'P0');
  // artifact 与 crash 缺口必须存在（它们是"没有来源"的能力，不能假装支持）。
  assert.ok(gaps.some((g) => g.code === 'DSH_NO_NATIVE_ARTIFACT_EVENT'),
      'the (now-covered) artifact gap must still be documented as a residual constraint');
  assert.ok(gaps.some((g) => g.code === 'DSH_NO_CRASH_FACT'));
});

// ===========================================================================
// 2. journal → execution/* 纯映射
// ===========================================================================

test('dsh-backend: turn/start maps to execution/started', () => {
  const mapped = backendModule.mapDshJournalEvent(journalEvent('turn/start', {}));
  assert.equal(mapped.type, 'execution/started');
  assert.equal(mapped.code, null);
});

test('dsh-backend: turn/end reasons map exactly like the existing adapter verdict table', () => {
  // 逐条对齐 runtime-adapter.js:464-478 的既有判定（completed / error|failed /
  // blocked / aborted|interrupted|cancelled / 未知→attention）。
  const cases = [
    ['completed', 'execution/completed'],
    ['error', 'execution/failed'],
    ['failed', 'execution/failed'],
    ['blocked', 'execution/attention'],
    ['aborted', 'execution/cancelled'],
    ['interrupted', 'execution/cancelled'],
    ['cancelled', 'execution/cancelled'],
    // 未知 reason **有意**降级为 attention（绝不猜 failed）。
    ['max-tokens', 'execution/attention'],
    [undefined, 'execution/attention'],
    ['some-future-reason', 'execution/attention'],
  ];
  for (const [reason, expected] of cases) {
    const data = reason === undefined ? {} : { reason: { kind: reason } };
    const mapped = backendModule.mapDshJournalEvent(journalEvent('turn/end', data));
    assert.equal(mapped.type, expected, `reason ${String(reason)} must map to ${expected}`);
  }
  // 0.1.1 legacy 的裸字符串 reason 也要认。
  const legacy = backendModule.mapDshJournalEvent(journalEvent('turn/end', { reason: 'completed' }));
  assert.equal(legacy.type, 'execution/completed');
});

test('dsh-backend: attention/cancelled mappings never claim a completed outcome', () => {
  for (const reason of ['blocked', 'max-tokens', undefined, 'unknown']) {
    const data = reason === undefined ? {} : { reason: { kind: reason } };
    const mapped = backendModule.mapDshJournalEvent(journalEvent('turn/end', data));
    assert.notEqual(mapped.type, 'execution/completed', `reason ${String(reason)} must not be a completion`);
    assert.notEqual(mapped.type, 'execution/failed', `reason ${String(reason)} must not be a failure`);
  }
});

test('dsh-backend: unmappable journal events produce no fact (canonicalize only, never invent)', () => {
  for (const [type, data] of [
    ['tool/call', { name: 'bash', arguments: { cmd: 'rm -rf /' } }],
    ['assistant/message', { content: 'model output text', usage: { inputTokens: 10 } }],
    ['turn/usage', { usage: {} }],
    ['subagent/catalog', { childId: 'child-1', label: 'research this' }],
    ['user/message', { content: 'secret user prompt' }],
    ['some/future/event', { whatever: true }],
  ]) {
    const mapped = backendModule.mapDshJournalEvent(journalEvent(type, data));
    assert.equal(mapped.type, null, `${type} must not produce an execution event`);
    assert.equal(mapped.code, null, `${type} is not an error, just unmapped`);
  }
  // 畸形输入 → 明确码。
  assert.equal(backendModule.mapDshJournalEvent(null).code, 'EXEC_EVENT_SHAPE_INVALID');
  assert.equal(backendModule.mapDshJournalEvent({}).code, 'EXEC_EVENT_SHAPE_INVALID');
  assert.equal(backendModule.mapDshJournalEvent({ type: '' }).code, 'EXEC_EVENT_SHAPE_INVALID');
});

test('dsh-backend: the coarse reason extractor reads ONLY data.reason (never content/arguments)', () => {
  // 结构性：reason 只可能来自 data.reason（.kind 或裸字符串）。
  assert.equal(backendModule.coarseReasonOf({ data: { reason: { kind: 'blocked' } } }), 'blocked');
  assert.equal(backendModule.coarseReasonOf({ data: { reason: 'aborted' } }), 'aborted');
  assert.equal(backendModule.coarseReasonOf({ data: { reason: { kind: 42 } } }), null);
  assert.equal(backendModule.coarseReasonOf({ data: {} }), null);
  assert.equal(backendModule.coarseReasonOf(null), null);
  // 正文/参数**不会**被当成 reason。
  assert.equal(backendModule.coarseReasonOf({ data: { content: 'completed soon', arguments: { x: 'failed' } } }), null);
  const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'dsh-execution-backend.js'), 'utf8'));
  assert.equal(/data\.(content|arguments|text|messages|prompt)/.test(source), false,
    'the backend must never read journal content/arguments/text/prompt fields');
});

// ===========================================================================
// 3. 端口行为：fail-closed 与"不得假装接通"
// ===========================================================================

test('dsh-backend: startRun fails closed when no transport is injected', async () => {
  const backend = createBackend(); // 无 transport
  await assert.rejects(
    () => backend.startRun({ jobId: JOB, runId: RUN, role: 'researcher', attempt: 1 }),
    (error) => error.code === 'EXEC_TRANSPORT_UNAVAILABLE',
  );
});

test('dsh-backend: startRun fails closed when the host has not decided which session to use', async () => {
  // 这是最关键的诚实性检查：dsh 没有"按 role 起会话"的原语，**本层也不生成 prompt**。
  // 没注入 sessionFor → 明确不支持，而不是自己编一个会话/提示词。
  const backend = createBackend({
    transport: backendModule.createInjectedTransport({ events: [] }),
  });
  await assert.rejects(
    () => backend.startRun({ jobId: JOB, runId: RUN, role: 'researcher', attempt: 1 }),
    (error) => error.code === 'EXEC_TRANSPORT_UNAVAILABLE' && /never generates prompts/.test(error.message),
  );
  // 结构性：本文件没有任何 prompt / 文本构造路径。
  const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'dsh-execution-backend.js'), 'utf8'));
  for (const pattern of [/prompt\s*[:=]/, /content\s*:\s*\[/, /createSession\s*\(/, /session\/create/]) {
    assert.equal(pattern.test(source), false, `the backend must not construct prompts/sessions (${pattern})`);
  }
});

test('dsh-backend: the fake transport with an empty stream yields no events (no invented completion)', async () => {
  const backend = createBackend({
    transport: backendModule.createInjectedTransport({ events: [] }),
    sessionFor: () => 'sess-host-provided',
  });
  const handle = await backend.startRun({ jobId: JOB, runId: RUN, role: 'researcher', attempt: 1 });
  assert.ok(handle);
  assert.equal(await backend.nextEvent(handle), null, 'an empty journal yields NO event (never a guess)');
});

test('dsh-backend: a full journal sequence converts to the exact team effect through the controller', async () => {
  // 端到端但**离线**：注入的 transport 喂一段 journal，controller 把它变成 Team fact。
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const transport = backendModule.createInjectedTransport({
    events: [
      journalEvent('turn/start', {}, 1),
      journalEvent('tool/call', { name: 'bash', arguments: { secret: 'sk-x' } }, 2),
      journalEvent('assistant/message', { content: 'model text', usage: { inputTokens: 5 } }, 3),
      journalEvent('turn/end', { reason: { kind: 'completed' } }, 4),
    ],
    cancelAck: { ok: true },
  });
  const runtime = team.createTeamRuntime({ clock });
  // 适配器：把"nextEvent 拉一条 → 交给 controller"包成端口形状（这是接线层要做的事）。
  const backend = backendModule.createDshExecutionBackend({
    clock,
    transport,
    sessionFor: () => 'sess-host-provided',
  });
  const adapterExecutor = {
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    unsupported: ['recover'],
  };
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor: adapterExecutor, clock, jobId: JOB,
  });
  await controller.start();
  // 逐条 pump：journal 里 tool/call 与 assistant/message 被跳过（不产事实）。
  const trace = [];
  for (let i = 0; i < 6; i += 1) {
    const step = await controller.pumpOne();
    if (!step) break;
    trace.push(step.type);
  }
  assert.deepEqual(trace, ['execution/started', 'execution/completed']);
  assert.deepEqual(runtime.facts().map((f) => f.type), ['job/created', 'run/dispatched', 'run/started', 'run/completed']);
  assert.equal(runtime.state().runs.researcher.terminalEvidence.source, 'execution/completed:ok');
  // 隐私：journal 的工具参数（含看起来像密钥的值）与正文都没有进入 Team 事实。
  const facts = JSON.stringify(runtime.facts());
  for (const needle of ['sk-x', 'secret', 'model text', 'sess-host-provided', 'bash', 'tool/call', 'assistant/message']) {
    assert.equal(facts.includes(needle), false, `Team facts must not carry ${needle}`);
  }
});

test('dsh-backend: cancel acknowledges delivery without producing a terminal event', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const backend = createBackend({
    clock,
    transport: backendModule.createInjectedTransport({ events: [journalEvent('turn/start', {}, 1)], cancelAck: { ok: true } }),
    sessionFor: () => 'sess-host-provided',
  });
  const handle = await backend.startRun({ jobId: JOB, runId: RUN, role: 'researcher', attempt: 1 });
  const ack = await backend.cancel(handle);
  assert.equal(ack.acknowledged, true);
  // ack 只是回执：dsh **没有** journal ack 事件；终态仍需后续 turn/end。
  assert.equal('outcome' in ack, false);
  assert.equal('terminal' in ack, false);
  const events = [];
  for (let i = 0; i < 4; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    events.push(event.type);
  }
  assert.deepEqual(events, ['execution/started', 'execution/cancel-requested', 'execution/cancel-acknowledged']);
  assert.equal(events.includes('execution/cancelled'), false, 'no cancelled event exists in the journal');
});

test('dsh-backend: capability() honestly declares what it can and cannot produce', () => {
  const backend = createBackend({
    transport: backendModule.createInjectedTransport({ events: [] }),
    sessionFor: () => 'sess-host-provided',
  });
  const capability = backend.capability();
  assert.equal(capability.network, false);
  assert.equal(capability.supportsRecover, false, 'dsh backend declares no recover support');
  // 能产的与不能产的都是显式清单。
  assert.equal(capability.unsupportedEventTypes.includes('execution/artifact'), true);
  assert.equal(capability.unsupportedEventTypes.includes('execution/crashed'), true);
  assert.equal(capability.producibleEventTypes.includes('execution/artifact'), false);
  assert.equal(capability.producibleEventTypes.includes('execution/completed'), true);
  // 端口形状：recover 不在，但**显式声明** unsupported（不是静默缺失）。
  assert.equal(typeof backend.recover, 'undefined');
  assert.ok(backend.unsupported.includes('recover'));
  assert.equal(team.assertExecutorPort(backend).ok, true,
    'the dsh backend must satisfy the executor port shape (with an explicit unsupported stance)');
});

// ===========================================================================
// 4. 隐私与"未接真实网络"的双向证明
// ===========================================================================

test('dsh-backend: the skeleton never touches the network, fs, electron or the harness client', () => {
  const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'dsh-execution-backend.js'), 'utf8'));
  for (const spec of [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])) {
    assert.equal(/harness-rpc|runtime-mux|ws|node:fs|node:http|node:net|electron|office/.test(spec), false,
      `the skeleton must not pull in ${spec}`);
  }
  for (const pattern of [/\bfetch\s*\(/, /\bWebSocket\b/, /\bhttp\./, /\bDate\.now\s*\(/, /\bsetTimeout\s*\(/]) {
    assert.equal(pattern.test(source), false, `the skeleton must not use ${pattern}`);
  }
  // 结构性：真实的 dsh 接线（journal follow / runtime-mux / harness-rpc）不在本模块里，
  // 而是在壳侧 main.js（本任务**不**改它）。
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /runtimeMux\.onItem/, 'the shell still owns the real follow stream');
});

test('dsh-backend: it loads in plain Node with electron, ws and the mux unavailable', () => {
  const originalLoad = Module._load;
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (['electron', 'ws', 'pixi.js'].includes(request)) throw new Error(`${request} unavailable in this probe`);
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve('../src/team/runtime/dsh-execution-backend.js')];
    const reloaded = require('../src/team/runtime/dsh-execution-backend.js');
    assert.equal(typeof reloaded.createDshExecutionBackend, 'function');
  } finally {
    Module._load = originalLoad;
  }
});

test('dsh-backend: raw session identity stays inside the backend (never on an execution event)', async () => {
  const backend = createBackend({
    transport: backendModule.createInjectedTransport({ events: [journalEvent('turn/start', {}, 1)] }),
    sessionFor: () => 'sess-raw-should-not-leak',
  });
  const handle = await backend.startRun({ jobId: JOB, runId: RUN, role: 'researcher', attempt: 1 });
  const event = await backend.nextEvent(handle);
  const serialized = JSON.stringify(event);
  for (const needle of ['sess-raw-should-not-leak', 'sessionId', JOB, RUN]) {
    assert.equal(serialized.includes(needle), false, `execution event must not carry ${needle}`);
  }
  // handle 也不带 raw。
  const handleSerialized = JSON.stringify(handle);
  assert.equal(handleSerialized.includes('sess-raw-should-not-leak'), false);
  // backend 自己也不暴露 sessionId（state() 只给枚举与计数）。
  assert.equal('sessionId' in backend.state(handle), false);
});

test('dsh-backend: the backend cannot produce a team fact on its own (only the controller can)', () => {
  const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'dsh-execution-backend.js'), 'utf8'));
  assert.equal(/require\(\s*['"]\.\/team-runtime\.js['"]\s*\)/.test(source), false);
  for (const command of ['createJob', 'dispatchRun', 'startRun', 'noteArtifact', 'noteRunTerminal', 'noteRunAttention']) {
    assert.equal(new RegExp(`\\b(team|teamRuntime|runtime)\\s*\\.\\s*${command}\\s*\\(`).test(source), false,
      `the backend must not call Team command ${command}()`);
  }
});
// ===========================================================================
// 5. transport v1：resolveSession / artifactFor（本地 materializer 受信来源）
// ===========================================================================

/** 一个完整的 v1 fake transport：两个会话（researcher/reviewer）+ materializer。 */
function createV1Transport({ reviewerJournal = [], materialize = true, materializeReviewer = false } = {}) {
  const T0L = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0L + seq, data });
  const researcherJournal = [
    je('turn/start', {}, 1),
    je('tool/call', { name: 'web-search', arguments: '{"q":"x"}' }, 2),
    je('assistant/message', { content: '研究发现……（正文只留在壳侧）', usage: { inputTokens: 5 } }, 3),
    je('turn/end', { reason: { kind: 'completed' } }, 4),
  ];
  const calls = { resolve: [], artifactFor: [], cancel: [], follow: [] };
  const sessions = new Map([
    ['sess-researcher-raw', { events: researcherJournal, output: '# Research Notes\n\n结论：……' }],
    ['sess-reviewer-raw', { events: reviewerJournal, output: '# Review\n\n通过' }],
  ]);
  const transport = {
    resolveSession(request) {
      calls.resolve.push(request);
      return request.role === 'researcher' ? 'sess-researcher-raw' : 'sess-reviewer-raw';
    },
    follow({ sessionId }) {
      calls.follow.push(sessionId);
      const session = sessions.get(sessionId);
      const events = session ? session.events : [];
      let i = 0;
      return Object.freeze({
        [Symbol.asyncIterator]: () => ({
          next() {
            if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
            const value = events[i]; i += 1;
            return Promise.resolve({ value, done: false });
          },
          return() { return Promise.resolve({ value: undefined, done: true }); },
        }),
      });
    },
    async cancel({ sessionId }) { calls.cancel.push(sessionId); return { ok: true }; },
    async artifactFor({ sessionId, role, kind }) {
      calls.artifactFor.push({ role, kind });
      const session = sessions.get(sessionId);
      if (!session) return null;
      if (role === 'researcher' && materialize) {
        return {
          kind,
          digest: 'exec-sha256:' + 'a'.repeat(16),
          locationRef: 'ref:research-notes-v1',
        };
      }
      if (role === 'reviewer' && materializeReviewer) {
        return { kind, digest: 'exec-sha256:' + 'b'.repeat(16), locationRef: 'ref:review-findings-v1' };
      }
      return null;
    },
    describe: () => Object.freeze({ transport: 'v1-fake', network: false }),
  };
  return { transport, calls, sessions };
}

test('dsh-backend v1: startRun passes the full plan context to transport.resolveSession', async () => {
  const { transport, calls } = createV1Transport();
  const backend = backendModule.createDshExecutionBackend({ clock: { nowMs: () => T0 }, transport });
  await backend.startRun({
    jobId: JOB, runId: RUN, role: 'researcher', attempt: 1,
    inputArtifacts: [{ artifactId: 'art:0000000000000001' }],
    produces: ['research-notes'],
  });
  assert.equal(calls.resolve.length, 1);
  const request = calls.resolve[0];
  assert.equal(request.jobId, JOB);
  assert.equal(request.runId, RUN);
  assert.equal(request.role, 'researcher');
  assert.equal(request.attempt, 1);
  assert.deepEqual(request.inputArtifacts, [{ artifactId: 'art:0000000000000001' }]);
  assert.deepEqual(request.produces, ['research-notes']);
});

test('dsh-backend v1: artifact is materialized and delivered BEFORE its completed terminal', async () => {
  const { transport, calls } = createV1Transport();
  const backend = backendModule.createDshExecutionBackend({ clock: { nowMs: () => T0 }, transport });
  const handle = await backend.startRun({
    jobId: JOB, runId: RUN, role: 'researcher', attempt: 1, produces: ['research-notes'],
  });
  const order = [];
  for (let i = 0; i < 6; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    order.push(event.type + (event.kind ? `:${event.kind}` : ''));
  }
  // 顺序不变式：started → artifact(research-notes) → completed。
  assert.deepEqual(order, ['execution/started', 'execution/artifact:research-notes', 'execution/completed']);
  // materializer 只被问了一次、只问了声明的 kind。
  assert.deepEqual(calls.artifactFor, [{ role: 'researcher', kind: 'research-notes' }]);
  // 事件带 digest/locationRef（且都不含 raw session）。
  const handleState = backend.state(handle);
  assert.equal(handleState.artifactEmitted, true);
  assert.equal(handleState.terminal, true);
});

test('dsh-backend v1: no materialized artifact → no artifact event (fail-closed, never fabricated)', async () => {
  const { transport, calls } = createV1Transport({ materialize: false });
  const backend = backendModule.createDshExecutionBackend({ clock: { nowMs: () => T0 }, transport });
  const handle = await backend.startRun({
    jobId: JOB, runId: RUN, role: 'researcher', attempt: 1, produces: ['research-notes'],
  });
  const order = [];
  for (let i = 0; i < 6; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    order.push(event.type);
  }
  // 仍然 completed（它自己的终态有证据），但**没有** artifact —— 下游会挂在依赖上。
  assert.deepEqual(order, ['execution/started', 'execution/completed']);
  assert.equal(backend.state(handle).artifactEmitted, false);
  assert.equal(calls.artifactFor.length, 1);
});

test('dsh-backend v1: failure and blocked never trigger the materializer', async () => {
  const T0L = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0L + seq, data });
  for (const [label, endReason] of [['failed', 'error'], ['blocked', 'blocked']]) {
    const { transport, calls } = createV1Transport();
    transport.follow = ({ sessionId }) => {
      const events = [je('turn/start', {}, 1), je('turn/end', { reason: { kind: endReason } }, 2)];
      let i = 0;
      return Object.freeze({
        [Symbol.asyncIterator]: () => ({
          next() {
            if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
            const value = events[i]; i += 1;
            return Promise.resolve({ value, done: false });
          },
        }),
      });
    };
    const backend = backendModule.createDshExecutionBackend({ clock: { nowMs: () => T0 }, transport });
    const handle = await backend.startRun({
      jobId: JOB, runId: RUN, role: 'researcher', attempt: 1, produces: ['research-notes'],
    });
    const order = [];
    for (let i = 0; i < 4; i += 1) {
      const event = await backend.nextEvent(handle);
      if (!event) break;
      order.push(event.type);
    }
    assert.equal(calls.artifactFor.length, 0, `${label} must never materialize`);
    assert.equal(order.includes('execution/artifact'), false, `${label} must not emit an artifact`);
    void sessionIdUnused;
  }
  function sessionIdUnused() {}
});

test('dsh-backend v1: END-TO-END offline — two sessions through the controller to a real handoff', async () => {
  // 这是 v0.4 真实链路的离线等价物：两个 dsh 会话 → 执行事件 → Team → root completed，
  // 且 reviewer 真的消费了 researcher 的 materialized artifact（handoff 完整）。
  const T0L = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0L + seq, data });
  const { transport } = createV1Transport({
    reviewerJournal: [
      je('turn/start', {}, 1),
      je('turn/end', { reason: { kind: 'completed' } }, 2),
    ],
    materialize: true,
  });
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({ clock, transport });
  const adapterExecutor = {
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    unsupported: ['recover'],
  };
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor: adapterExecutor, clock, jobId: JOB,
  });
  await controller.start();
  for (let i = 0; i < 12; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    nowMs += 10;
  }
  const state = runtime.state();
  assert.equal(state.status, 'completed', 'root must converge with a REAL handoff');
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  // handoff：reviewer 消费了 researcher 的 artifact（Team 派生的 artifactId）。
  const artifactId = state.runs.researcher.producedArtifactIds[0];
  assert.ok(artifactId, 'researcher must have produced an artifact');
  assert.deepEqual(state.runs.reviewer.consumedArtifactIds, [artifactId]);
  // 事实序列包含 artifact/available（在 run/completed 之前）。
  const types = runtime.facts().map((f) => f.type);
  assert.ok(types.includes('artifact/available'));
  assert.ok(types.indexOf('artifact/available') < types.indexOf('run/completed'));
  // 隐私：raw 会话 id 不进 Team 事实。
  const facts = JSON.stringify(runtime.facts());
  assert.equal(facts.includes('sess-researcher-raw'), false);
  assert.equal(facts.includes('sess-reviewer-raw'), false);
});

test('dsh-backend v1: session-unavailable becomes Team attention (design B §4.9)', async () => {
  // 宿主拒绝解析会话 → EXEC_TRANSPORT_UNAVAILABLE → controller 转 Team attention
  //（不是 failed、不是静默 pending），可观测且可恢复。
  const { transport } = createV1Transport();
  transport.resolveSession = () => null; // 宿主说"没会话可用"
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({ clock, transport });
  const adapterExecutor = {
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    unsupported: ['recover'],
  };
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor: adapterExecutor, clock, jobId: JOB,
  });
  const verdicts = await controller.start();
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].status, 'attention');
  const state = runtime.state();
  assert.equal(state.runs.researcher.status, 'attention');
  assert.equal(state.runs.researcher.attention.reason, 'session-unavailable');
  assert.equal(state.status, 'attention');
  // 没有 failed / completed / artifact —— 任务从未开始，就没有执行证据。
  const types = runtime.facts().map((f) => f.type);
  assert.equal(types.includes('run/failed'), false);
  assert.equal(types.includes('run/completed'), false);
  assert.equal(types.includes('artifact/available'), false);
});
