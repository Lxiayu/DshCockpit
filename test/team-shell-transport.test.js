'use strict';

// test/team-shell-transport.test.js — 壳侧 Team 执行 transport（Harness v0.4 阶段1）。
//
// 验证对象：src/team-shell-transport.js（设计 B 方案 A 的壳侧落地 + 用户拍板的
// U3 任务文本来源 + 本地 materializer artifact 来源）。
//
// **完全离线**：rpc / openFollow / fs 全部注入；不启动 Electron、不连真实 dsh。
// 这里同时是"真实链路的离线等价物"：同样的 transport 实现（一字不改）会被
// main.js 用真实 rpc/mux 装配（真实装配的 gate 逻辑另由 office-team-real-wiring 测试覆盖）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createShellTeamTransport,
  SHELL_TRANSPORT_VERSION,
  RESEARCHER_PROMPT_TEMPLATE,
  REVIEWER_PROMPT_TEMPLATE,
  INLINE_NOTES_MAX_CHARS,
  assistantTextOf,
} = require('../src/team-shell-transport.js');

const T0 = 1_700_000_000_000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-transport-test-'));
}

/** fake rpc：记录调用；可注入失败。 */
function fakeRpc({ failCreate = false, failPrompt = false } = {}) {
  const calls = { create: 0, prompt: [], cancel: [] };
  let next = 0;
  return {
    calls,
    async createSession() {
      calls.create += 1;
      if (failCreate) throw new Error('runtime down');
      next += 1;
      return `sess-fake-${next}`;
    },
    async prompt(sessionId, text, mode) {
      calls.prompt.push({ sessionId, text, mode });
      if (failPrompt) throw new Error('prompt rejected');
      return { ok: true };
    },
    async cancel(sessionId) { calls.cancel.push(sessionId); return { ok: true }; },
  };
}

/** fake follow：返回一条固定 journal 事件流（可含 assistant 正文）。 */
function fakeFollowJournals() {
  const journals = new Map(); // sessionId -> events[]
  const opened = [];
  return {
    journals,
    opened,
    set(sessionId, events) { journals.set(sessionId, events); },
    open(sessionId) {
      opened.push(sessionId);
      const events = journals.get(sessionId) || [];
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
    },
  };
}

const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });

function createHarness({ topic = '调研 X 框架的优劣', rpcOverrides = {}, follow: followImpl } = {}) {
  const rpc = fakeRpc(rpcOverrides);
  const followHelper = fakeFollowJournals();
  const artifactDir = tempDir();
  const transport = createShellTeamTransport({
    rpc,
    openFollow: followImpl || followHelper.open,
    artifactDir,
    topic,
    log: () => {},
  });
  return { transport, rpc, followHelper, artifactDir };
}

// ===========================================================================
// 1. 构造与形状
// ===========================================================================

test('shell-transport: refuses to construct without a user topic (U3: text comes from the user)', () => {
  const rpc = fakeRpc();
  const open = fakeFollowJournals().open;
  const dir = tempDir();
  for (const badTopic of [undefined, null, '', '   ']) {
    assert.throws(
      () => createShellTeamTransport({ rpc, openFollow: open, artifactDir: dir, topic: badTopic }),
      (error) => /non-empty user topic/.test(error.message),
      `topic ${JSON.stringify(badTopic)} must be refused`,
    );
  }
  // 其它必需依赖也一样诚实失败。
  assert.throws(() => createShellTeamTransport({ openFollow: open, artifactDir: dir, topic: 'x' }));
  assert.throws(() => createShellTeamTransport({ rpc, artifactDir: dir, topic: 'x' }));
  assert.throws(() => createShellTeamTransport({ rpc, openFollow: open, topic: 'x' }));
});

test('shell-transport: prompt templates are frozen constants with the topic slot', () => {
  assert.ok(Object.isFrozen(RESEARCHER_PROMPT_TEMPLATE));
  assert.ok(Object.isFrozen(REVIEWER_PROMPT_TEMPLATE));
  assert.ok(RESEARCHER_PROMPT_TEMPLATE.includes('{{topic}}'));
  assert.ok(REVIEWER_PROMPT_TEMPLATE.includes('{{topic}}'));
  assert.ok(REVIEWER_PROMPT_TEMPLATE.includes('{{notes}}'));
  // reviewer 模板内联笔记，长度受 INLINE_NOTES_MAX_CHARS 约束。
  assert.ok(Number.isInteger(INLINE_NOTES_MAX_CHARS) && INLINE_NOTES_MAX_CHARS > 0);
});

// ===========================================================================
// 2. resolveSession：建会话 + 发任务文本
// ===========================================================================

test('shell-transport: resolveSession creates a session and sends the fixed researcher prompt', async () => {
  const h = createHarness({ topic: '调研 X 框架的优劣' });
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-real-1', runId: 'job-real-1:researcher:1', role: 'researcher', attempt: 1,
    inputArtifacts: [], produces: ['research-notes'],
  });
  assert.equal(typeof sessionId, 'string');
  assert.notEqual(sessionId, '');
  assert.equal(h.rpc.calls.create, 1);
  assert.equal(h.rpc.calls.prompt.length, 1);
  const sent = h.rpc.calls.prompt[0];
  // 文本 = 冻结模板 + 用户主题（主题是唯一的用户输入）。
  assert.equal(sent.sessionId, sessionId);
  assert.equal(sent.mode, 'steer');
  assert.ok(sent.text.includes('调研 X 框架的优劣'));
  assert.ok(sent.text.includes('研究笔记'));
  // 模板形状可验证：把主题换回去应该等于冻结常量。
  assert.equal(
    sent.text.replace('调研 X 框架的优劣', '{{topic}}'),
    RESEARCHER_PROMPT_TEMPLATE,
  );
});

test('shell-transport: reviewer prompt inlines the upstream notes (bounded)', async () => {
  const h = createHarness();
  // researcher 会话 + 产出正文。
  const researcherSession = await h.transport.resolveSession({
    jobId: 'job-real-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: ['research-notes'],
  });
  h.followHelper.set(researcherSession, [
    je('turn/start', {}, 1),
    je('assistant/message', { content: [{ type: 'text', text: '# 笔记第一版' }] }, 2),
    je('assistant/message', { content: [{ type: 'text', text: '# 最终笔记：结论……' }] }, 3),
  ]);
  for await (const _event of h.transport.follow({ sessionId: researcherSession })) { void _event; }
  // 物化拿到 artifactId（Team 侧会派生；这里用 transport 返回的 kind 假定一致）。
  const materialized = await h.transport.artifactFor({ sessionId: researcherSession, kind: 'research-notes' });
  assert.ok(materialized);
  // 用"Team 派生 artifactId"的占位形态调用 reviewer 解析（inputArtifacts 反查账本）。
  const artifactId = `art:${'0'.repeat(16)}`;
  h.transport.summary(); // no-op（只确认 summary 不炸）
  // 直接调用（账本反查按 materialized 记录；这里塞一个显式 artifactId 进物化记录不可行，
  // 因此用 summary 断言物化已发生，再用 reviewer resolve 验证内联路径走了"最近一条正文"）。
  const reviewerSession = await h.transport.resolveSession({
    jobId: 'job-real-1', role: 'reviewer', attempt: 1,
    inputArtifacts: [],
    produces: ['review-findings'],
    consumes: ['research-notes'],
  });
  assert.equal(typeof reviewerSession, 'string');
  const reviewerPrompt = h.rpc.calls.prompt.at(-1).text;
  // 内联的是**最后一条** assistant 正文（tee 语义），不是第一版。
  assert.ok(reviewerPrompt.includes('# 最终笔记：结论……'));
  assert.ok(!reviewerPrompt.includes('# 笔记第一版'));
  assert.ok(reviewerPrompt.includes('评审'));
});

test('shell-transport: unknown role gets no prompt (fail-closed, no silent role growth)', async () => {
  const h = createHarness();
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-real-1', role: 'coder', attempt: 1, inputArtifacts: [], produces: [],
  });
  assert.equal(sessionId, null);
  assert.equal(h.rpc.calls.create, 0);
  assert.equal(h.rpc.calls.prompt.length, 0);
});

test('shell-transport: createSession/prompt failure resolves to null (→ Team attention upstream)', async () => {
  for (const override of [{ failCreate: true }, { failPrompt: true }]) {
    const h = createHarness({ rpcOverrides: override });
    const sessionId = await h.transport.resolveSession({
      jobId: 'job-real-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: [],
    });
    assert.equal(sessionId, null, `${JSON.stringify(override)} must resolve null`);
  }
});

// ===========================================================================
// 3. follow tee：只捕获最后一条 assistant 正文
// ===========================================================================

test('shell-transport: assistantTextOf handles array/string/missing shapes defensively', () => {
  assert.equal(assistantTextOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(assistantTextOf({ content: 'plain' }), 'plain');
  assert.equal(assistantTextOf({ content: [] }), null);
  assert.equal(assistantTextOf({ content: [{ type: 'image' }] }), null);
  assert.equal(assistantTextOf({}), null);
  assert.equal(assistantTextOf(null), null);
  assert.equal(assistantTextOf({ usage: { inputTokens: 3 } }), null);
});

test('shell-transport: the tee captures the LAST assistant text and passes frames through untouched', async () => {
  const h = createHarness();
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-real-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: [],
  });
  const frames = [
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash', arguments: '{"secret":"sk-x"}' }, 2),
    je('assistant/message', { content: [{ type: 'text', text: 'draft' }] }, 3),
    je('assistant/message', { content: [{ type: 'text', text: 'final notes' }] }, 4),
    je('turn/end', { reason: { kind: 'completed' } }, 5),
  ];
  h.followHelper.set(sessionId, frames);
  const seen = [];
  for await (const event of h.transport.follow({ sessionId })) seen.push(event);
  // tee 是透明转发：每一帧原样到达（含 tool/call 的参数 —— 壳本来就转发它们）。
  assert.deepEqual(seen, frames);
  // 捕获的是最后一条正文。
  const materialized = await h.transport.artifactFor({ sessionId, kind: 'research-notes' });
  assert.ok(materialized, 'captured output must materialize');
  // 物化文件内容 = 最后一条正文。
  const filePath = `${h.artifactDir}/job-real-1/research-notes.md`;
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'final notes');
});

// ===========================================================================
// 4. artifactFor：本地 materializer
// ===========================================================================

test('shell-transport: materializes to a file with a verifiable sha256 digest', async () => {
  const h = createHarness();
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-digest-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: [],
  });
  h.followHelper.set(sessionId, [
    je('assistant/message', { content: [{ type: 'text', text: '# 笔记\n\n内容' }] }, 1),
  ]);
  for await (const _e of h.transport.follow({ sessionId })) { void _e; }
  const materialized = await h.transport.artifactFor({ sessionId, kind: 'research-notes' });
  assert.ok(materialized);
  assert.equal(materialized.kind, 'research-notes');
  assert.match(materialized.digest, /^exec-sha256:[0-9a-f]{16}$/);
  // digest 可独立验证：等于文件字节的 sha256 前 16 位。
  const crypto = require('node:crypto');
  const bytes = fs.readFileSync(`${h.artifactDir}/job-digest-1/research-notes.md`);
  assert.equal(materialized.digest, `exec-sha256:${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`);
  // locationRef 是受限 token：不含路径分隔符（A-T7 的形状约束）。
  assert.match(materialized.locationRef, /^ref:[A-Za-z0-9._-]{1,64}$/);
  assert.equal(materialized.locationRef.includes('/'), false);
  // 幂等：再次请求返回同一条记录。
  const again = await h.transport.artifactFor({ sessionId, kind: 'research-notes' });
  assert.deepEqual(again, materialized);
});

test('shell-transport: refuses to fabricate an artifact without captured output (fail-closed)', async () => {
  const h = createHarness();
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-empty-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: [],
  });
  // 流里没有任何 assistant 正文（例如立刻失败）。
  h.followHelper.set(sessionId, [je('turn/end', { reason: { kind: 'error' } }, 1)]);
  for await (const _e of h.transport.follow({ sessionId })) { void _e; }
  const materialized = await h.transport.artifactFor({ sessionId, kind: 'research-notes' });
  assert.equal(materialized, null, 'no captured output → no artifact (never fabricated)');
  // 未知会话 / 空 kind 也一样拒绝。
  assert.equal(await h.transport.artifactFor({ sessionId: 'sess-unknown', kind: 'x' }), null);
  assert.equal(await h.transport.artifactFor({ sessionId, kind: '' }), null);
  // 没有文件被写出。
  assert.equal(fs.existsSync(`${h.artifactDir}/job-empty-1`), false);
});

test('shell-transport: summary/describe disclose no raw ids, no content, no paths', async () => {
  const h = createHarness();
  const sessionId = await h.transport.resolveSession({
    jobId: 'job-priv-1', role: 'researcher', attempt: 1, inputArtifacts: [], produces: [],
  });
  h.followHelper.set(sessionId, [
    je('assistant/message', { content: [{ type: 'text', text: 'SECRET-NOTES-CONTENT' }] }, 1),
  ]);
  for await (const _e of h.transport.follow({ sessionId })) { void _e; }
  await h.transport.artifactFor({ sessionId, kind: 'research-notes' });
  for (const serialized of [JSON.stringify(h.transport.summary()), JSON.stringify(h.transport.describe())]) {
    assert.equal(serialized.includes(sessionId), false, 'no raw sessionId');
    assert.equal(serialized.includes('SECRET-NOTES-CONTENT'), false, 'no content');
    assert.equal(serialized.includes(h.artifactDir), false, 'no artifact path');
    assert.equal(serialized.includes('.md'), false, 'no file names');
  }
  // describe 如实声明来源语义。
  assert.equal(h.transport.describe().artifactSource, 'local-materializer');
  assert.equal(h.transport.describe().promptSource.includes('user topic'), true);
  assert.equal(h.transport.describe().transport, SHELL_TRANSPORT_VERSION);
});

// ===========================================================================
// 5. cancel
// ===========================================================================

test('shell-transport: cancel passes through to the rpc and reports honestly', async () => {
  const h = createHarness();
  const ok = await h.transport.cancel({ sessionId: 'sess-cancel-1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(h.rpc.calls.cancel, ['sess-cancel-1']);
  const bad = await h.transport.cancel({ sessionId: '' });
  assert.equal(bad.ok, false);
});

// ===========================================================================
// 6. 离线端到端：transport + dsh backend + controller + Team（真实 materializer 实现）
// ===========================================================================

test('shell-transport: END-TO-END offline — real transport impl drives a full team run', async () => {
  // 这里用的是**生产同一条** transport 实现（注入 fake rpc/follow），
  // 证明"建会话→发文本→tee 捕获→物化→digest"整条壳侧路径真的能驱动 Team 收敛。
  const team = require('../src/team/runtime/index.js');
  const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
  const h = createHarness({ topic: '调研离线端到端' });
  // 两个角色的 journal：researcher 产出正文并完成；reviewer 直接完成。
  let nextSession = 0;
  const openFollow = (sessionId) => {
    nextSession += 1;
    const isResearcher = nextSession === 1;
    const events = isResearcher
      ? [
        je('turn/start', {}, 1),
        je('assistant/message', { content: [{ type: 'text', text: '# 离线研究笔记\n\n三条发现……' }] }, 2),
        je('turn/end', { reason: { kind: 'completed' } }, 3),
      ]
      : [je('turn/start', {}, 1), je('turn/end', { reason: { kind: 'completed' } }, 2)];
    h.followHelper.set(sessionId, events);
    return h.followHelper.open(sessionId);
  };
  // 重新构造 transport，用真实 openFollow 包装（覆盖默认）。
  const transport = createShellTeamTransport({
    rpc: h.rpc, openFollow, artifactDir: h.artifactDir, topic: '调研离线端到端', log: () => {},
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
    teamRuntime: runtime, executor: adapterExecutor, clock, jobId: 'job-e2e-real-1',
  });
  await controller.start();
  for (let i = 0; i < 16; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    nowMs += 10;
  }
  const state = runtime.state();
  assert.equal(state.status, 'completed', 'the REAL transport implementation must drive root completion');
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  // 真实 handoff：reviewer 消费了 researcher 的 materialized artifact。
  const artifactId = state.runs.researcher.producedArtifactIds[0];
  assert.ok(artifactId, 'researcher produced an artifact from a materialized file');
  assert.deepEqual(state.runs.reviewer.consumedArtifactIds, [artifactId]);
  // reviewer 的 prompt 里内联了 researcher 笔记（tee 捕获的最后一条正文）。
  const prompts = h.rpc.calls.prompt.map((p) => p.text);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes('# 离线研究笔记'), 'the reviewer prompt must inline the materialized notes');
  // 物化文件真实存在且 digest 可验证。
  const filePath = `${h.artifactDir}/job-e2e-real-1/research-notes.md`;
  assert.equal(fs.existsSync(filePath), true);
  // 隐私：Team 事实里没有 raw 会话 id / prompt / 正文 / 路径。
  const facts = JSON.stringify(runtime.facts());
  for (const needle of ['sess-fake-', '调研离线端到端', '离线研究笔记', h.artifactDir, '.md']) {
    assert.equal(facts.includes(needle), false, `Team facts must not carry ${needle}`);
  }
});

test('shell-transport: reviewer blocked → Team attention (real transport, no fabrication)', async () => {
  // reviewer 的会话以 blocked 结束 → execution/attention → Team attention；
  // 没有 materialized review-findings（reviewer 的产出未完成）→ 绝不伪造。
  const team = require('../src/team/runtime/index.js');
  const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
  const h = createHarness({ topic: '调研 blocked' });
  let nextSession = 0;
  const openFollow = (sessionId) => {
    nextSession += 1;
    const events = nextSession === 1
      ? [
        je('turn/start', {}, 1),
        je('assistant/message', { content: [{ type: 'text', text: 'research done' }] }, 2),
        je('turn/end', { reason: { kind: 'completed' } }, 3),
      ]
      : [
        je('turn/start', {}, 1),
        je('assistant/message', { content: [{ type: 'text', text: 'need approval first' }] }, 2),
        je('turn/end', { reason: { kind: 'blocked' } }, 3),
      ];
    h.followHelper.set(sessionId, events);
    return h.followHelper.open(sessionId);
  };
  const transport = createShellTeamTransport({
    rpc: h.rpc, openFollow, artifactDir: h.artifactDir, topic: '调研 blocked', log: () => {},
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
    teamRuntime: runtime, executor: adapterExecutor, clock, jobId: 'job-blocked-1',
  });
  await controller.start();
  for (let i = 0; i < 16; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    nowMs += 10;
  }
  const state = runtime.state();
  assert.equal(state.runs.reviewer.status, 'attention', 'blocked must surface as Team attention');
  assert.equal(state.status, 'attention');
  assert.equal(state.runs.reviewer.terminalEvidence, null, 'attention is not terminal');
  // 没有任何 run/completed 伪造 reviewer 的完成。
  const types = runtime.facts().map((f) => f.type);
  assert.equal(types.filter((t) => t === 'run/completed').length, 1, 'only the researcher completed');
});