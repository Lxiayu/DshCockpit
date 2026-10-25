'use strict';

// test/team-execution-resume.test.js — v0.6 WP1：resume 执行侧闭环（控制器层）。
//
// 钉住的两个洞（2026-10-25 核实，计划 docs/specs/HARNESS-V0.6-PLAN-2026-10-25.md §2.1）：
//   洞 A（WP1a）：bind 阶段 attention（session-unavailable）后 sessions 无条目，
//        controller.resume() 第一行就 EXEC_HANDLE_UNKNOWN —— "继续"是死路。
//        v0.6：resume 对无会话的 attention = Team 先回 running，再重试执行器绑定。
//   洞 B（WP1b）：journal 流耗尽而无终态 → run 永远停在 running。
//        v0.6：后端合成 crashed(stream-ended) → Team attention → resume 重挂续流。
//
// 全部离线：可编程 transport（resolveSession 前置失败 + 每次 follow 的事件脚本）
// + 真实 dsh 后端 + 真实 controller。不启动 Electron、不发网络。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
const team = require('../src/team/runtime/index.js');

const T0 = 1_700_100_000_000;
const JOB = 'job-resume-1';

const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });

function streamOf(events) {
  let i = 0;
  return Object.freeze({
    [Symbol.asyncIterator]: () => ({
      next() {
        if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
        const value = events[i];
        i += 1;
        return Promise.resolve({ value: { ...value }, done: false });
      },
      return() { return Promise.resolve({ value: undefined, done: true }); },
    }),
  });
}

/**
 * 可编程 transport：
 *   resolveFailures —— resolveSession 的前置失败次数（模拟 dsh 不在/会话建不起来）
 *   followScript    —— 第 n 次 follow 交付的事件数组（重开即重放 + 新事件，真实语义）
 *   materialize     —— researcher 的 artifactFor 实现（默认给固定 digest）
 */
function createScriptedTransport({ resolveFailures = 0, followScript = [], materialize = true } = {}) {
  const calls = { resolve: [], follow: [], artifactFor: [] };
  let resolves = 0;
  let followIndex = 0;
  const transport = {
    async resolveSession(request) {
      calls.resolve.push(request);
      if (resolves < resolveFailures) {
        resolves += 1;
        return null; // → EXEC_TRANSPORT_UNAVAILABLE → Team attention（设计 B §4.9）
      }
      resolves += 1;
      return `sess-${request.role}-raw`;
    },
    follow({ sessionId }) {
      calls.follow.push(sessionId);
      const events = followScript[Math.min(followIndex, followScript.length - 1)] || [];
      followIndex += 1;
      return streamOf(events);
    },
    async cancel() { return { ok: true }; },
    async artifactFor({ role, kind }) {
      calls.artifactFor.push({ role, kind });
      if (!materialize || role !== 'researcher') return null;
      return { kind, digest: 'exec-sha256:' + 'c'.repeat(16), locationRef: 'ref:research-notes-r' };
    },
    describe: () => Object.freeze({ transport: 'scripted', network: false }),
  };
  return { transport, calls };
}

function createController({ transport, clock }) {
  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({ clock, transport });
  const executor = Object.freeze({
    startRun: (args) => backend.startRun(args),
    observe: (handle) => backend.observe(handle),
    cancel: (handle) => backend.cancel(handle),
    resume: (handle) => backend.resume(handle), // v0.6 起后端有 resume（端口可选方法）
    unsupported: Object.freeze(['recover']),
  });
  const controller = team.createTeamExecutionController({ teamRuntime: runtime, executor, clock, jobId: JOB });
  return { runtime, backend, controller };
}

/** 手动驱动（真实链路里是 drive() 循环）：dispatch ready → pump 事件，直到收敛或空转。 */
async function drive(controller, { maxSteps = 24 } = {}) {
  const trace = [];
  for (let i = 0; i < maxSteps; i += 1) {
    await controller.dispatchReady();
    const step = await controller.pumpOne();
    if (!step) break;
    trace.push(`${step.role}:${step.type}`);
    const status = step.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') break;
  }
  return trace;
}

// ===========================================================================
// 洞 A（WP1a）：bind 重试
// ===========================================================================

test('resume V1: bind 失败→attention→transport 恢复→resume 重试绑定→任务走到 completed', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const researcherJournal = [
    je('turn/start', {}, 1),
    je('assistant/message', { content: '# Research Notes' }, 2),
    je('turn/end', { reason: { kind: 'completed' } }, 3),
  ];
  const reviewerJournal = [
    je('turn/start', {}, 1),
    je('turn/end', { reason: { kind: 'completed' } }, 2),
  ];
  const { transport, calls } = createScriptedTransport({
    resolveFailures: 1, // 第一次 resolveSession 失败（researcher bind）；resume 重试时恢复
    followScript: [researcherJournal, reviewerJournal],
  });
  const { runtime, controller } = createController({ transport, clock });

  const verdicts = await controller.start();
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].status, 'attention', 'bind 失败必须显式进 attention（不是 failed/pending）');
  assert.equal(runtime.state().runs.researcher.attention.reason, 'session-unavailable');
  assert.equal(controller.handleFor('researcher'), null, 'bind 失败时没有执行会话（这正是洞 A）');

  // 恢复：Team 先回 running（Team 权威），再重试执行器绑定 —— 不再是 EXEC_HANDLE_UNKNOWN。
  const resumed = await controller.resume('researcher');
  assert.equal(resumed.ok, true, `resume must re-bind, got ${JSON.stringify(resumed)}`);
  assert.equal(runtime.state().runs.researcher.status, 'running');
  assert.equal(runtime.state().runs.researcher.attention, null);
  // 重试解析 = 第二次 resolveSession（同 role 同 run；fresh session 是 transport 的决定）。
  assert.equal(calls.resolve.filter((r) => r.role === 'researcher').length, 2);

  await drive(controller);
  assert.equal(runtime.state().status, 'completed', '任务必须真正走到终态');
  assert.equal(runtime.state().runs.reviewer.status, 'completed');
});

test('resume V2: 重试仍失败 → 诚实回 attention（不是 failed、不是停在 running）', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport } = createScriptedTransport({
    resolveFailures: 2, // bind 一次 + resume 重试一次
    followScript: [],
  });
  const { runtime, controller } = createController({ transport, clock });

  await controller.start();
  assert.equal(runtime.state().runs.researcher.status, 'attention');

  const resumed = await controller.resume('researcher');
  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'EXEC_TRANSPORT_UNAVAILABLE');
  assert.equal(resumed.status, 'attention', '重试失败必须回到 attention（可再试/可观测）');
  assert.equal(runtime.state().runs.researcher.status, 'attention');
  assert.equal(runtime.state().runs.researcher.attention.reason, 'session-unavailable');
  const types = runtime.facts().map((f) => f.type);
  assert.equal(types.includes('run/failed'), false);
  assert.equal(types.includes('run/completed'), false);
});

test('resume 拒绝从未进入 attention 的 pending 角色（Team 权威门，不开旁路）', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport } = createScriptedTransport({ followScript: [] });
  const { runtime, controller } = createController({ transport, clock });
  await controller.start(); // researcher/reviewer 都 dispatch 了，但没人为 resume 过

  // reviewer 从未 attention、从未绑定 —— resume 不能成为绕过 dispatch 语义的旁路。
  const verdict = await controller.resume('reviewer');
  assert.equal(verdict.ok, false);
  assert.equal(runtime.state().runs.reviewer.status, 'pending');
  assert.equal(controller.handleFor('reviewer'), null);
});

// ===========================================================================
// 洞 B（WP1b）：流耗尽 → crashed → attention → 重挂续流
// ===========================================================================

test('resume V3: 流耗尽→crashed→attention→resume 重挂→重放去重→续流到 completed', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport, calls } = createScriptedTransport({
    followScript: [
      [je('turn/start', {}, 1)], // researcher follow#1：start 后断流（dsh 掉线的离线等价物）
      // researcher follow#2（resume 重挂）：重放 seq1 + 新事件 seq2/3
      [je('turn/start', {}, 1), je('assistant/message', { content: '笔记…' }, 2), je('turn/end', { reason: { kind: 'completed' } }, 3)],
      [ // reviewer
        je('turn/start', {}, 1),
        je('turn/end', { reason: { kind: 'completed' } }, 2),
      ],
    ],
  });
  const { runtime, controller } = createController({ transport, clock });

  await controller.start();
  const trace = [];
  for (let i = 0; i < 4; i += 1) {
    const step = await controller.pumpOne();
    if (!step) break;
    trace.push(step.type);
  }
  assert.deepEqual(trace, ['execution/started', 'execution/crashed']);
  assert.equal(runtime.state().runs.researcher.status, 'attention', 'crash 默认策略 → attention');
  assert.equal(runtime.state().runs.researcher.attention.reason, 'stream-ended');

  const resumed = await controller.resume('researcher');
  assert.equal(resumed.ok, true);
  const resumeTrace = await drive(controller);
  // 重放的 journal started 不得再次交付（journal-seq 去重的行为级证明，
  // 对应变异"去掉去重"必须红：trace 会出现 researcher:execution/started）。
  assert.equal(resumeTrace.includes('researcher:execution/started'), false);
  assert.equal(runtime.state().status, 'completed');
  // 重挂的是同一会话；重放的 started 被去重（fact 里只有一次 run/started）。
  const followRoles = calls.follow.map((id) => id);
  assert.deepEqual(followRoles, ['sess-researcher-raw', 'sess-researcher-raw', 'sess-reviewer-raw']);
  const startedFacts = runtime.facts().filter((f) => f.type === 'run/started' && f.role === 'researcher');
  // 恰好两条：execution/started 事件一条 + resume 的 Team startRun（attention→running）一条。
  // 重放的 journal started **不得**产生第三条（journal-seq 去重生效的证明）。
  assert.equal(startedFacts.length, 2,
    'replayed journal must not produce a third run/started fact');
});

test('resume V5: 终态后 resume 被拒绝，不产生第二个终态 fact', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport } = createScriptedTransport({
    followScript: [[
      je('turn/start', {}, 1),
      je('turn/end', { reason: { kind: 'completed' } }, 2),
    ]],
  });
  const { runtime, controller } = createController({ transport, clock });
  await controller.start();
  await drive(controller);
  const completedFacts = () => runtime.facts().filter((f) => f.type === 'run/completed').length;

  const before = completedFacts();
  const verdict = await controller.resume('researcher');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'EXEC_HANDLE_TERMINAL');
  assert.equal(completedFacts(), before, 'terminal stays final');
});

test('resume 后再次断流 → 再次 crashed → 仍在 attention（不假装续跑成功）', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport } = createScriptedTransport({
    followScript: [
      [je('turn/start', {}, 1)],
      [je('turn/start', {}, 1)], // 重挂后仍无新事件（会话还是死的）
    ],
  });
  const { runtime, controller } = createController({ transport, clock });
  await controller.start();
  await controller.pumpOne(); // started
  const crashed = await controller.pumpOne();
  assert.equal(crashed.type, 'execution/crashed');
  await controller.resume('researcher');
  const crashedAgain = await controller.pumpOne();
  assert.equal(crashedAgain.type, 'execution/crashed');
  assert.equal(runtime.state().runs.researcher.status, 'attention');
  assert.equal(runtime.state().status, 'attention');
});

test('executor.resume 抛错 → 诚实回滚 attention（绝不静默留在 running）', async () => {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const { transport } = createScriptedTransport({
    followScript: [[je('turn/start', {}, 1), je('turn/end', { reason: { kind: 'blocked' } }, 2)]],
  });
  const { runtime: runtime0, backend, controller: controller0 } = createController({ transport, clock });
  void runtime0; void controller0; // 共用同一个 backend（会话/runs 状态在后端闭包里）
  const runtime2 = team.createTeamRuntime({ clock });
  const controller2 = team.createTeamExecutionController({
    teamRuntime: runtime2,
    executor: {
      startRun: (args) => backend.startRun(args),
      observe: (handle) => backend.observe(handle),
      cancel: (handle) => backend.cancel(handle),
      resume: async () => { throw Object.assign(new Error('refollow failed'), { code: 'EXEC_TRANSPORT_UNAVAILABLE' }); },
      unsupported: Object.freeze(['recover']),
    },
    clock, jobId: JOB,
  });
  await controller2.start();
  await controller2.pumpOne(); // started
  await controller2.pumpOne(); // blocked → attention
  assert.equal(runtime2.state().runs.researcher.status, 'attention');

  const verdict = await controller2.resume('researcher');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'EXEC_TRANSPORT_UNAVAILABLE');
  assert.equal(verdict.status, 'attention', 'executor refusal must roll back to attention');
  assert.equal(runtime2.state().runs.researcher.status, 'attention');
  assert.equal(runtime2.state().runs.researcher.attention.reason, 'resume-failed');
});
