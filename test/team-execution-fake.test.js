'use strict';

// test/team-execution-fake.test.js — 阶段 2/3/4：FakeExecutor 纵向切片 + Team 调度接入。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §6/§7/§8
//
// **本文件完全不需要 Office**（任务书 §6.4 的第一组）：这里只创建
//   Team Runtime + FakeExecutor + TeamExecutionController
// 不 require office-module、不启动 Electron/DOM/Pixi、无网络、无真实等待。
// Office 组合验证在 `test/office-team-execution.test.js` —— 两组严格分开，
// 因此"Office 成了 Team 测试的隐含依赖"这种漂移会在本文件的 purity 断言里失败。
//
// 覆盖：四种场景（happy / attention-resume / failure / cancel）+ ordered 变体，
// 以及 duplicate / late / out-of-order / identity-mismatch / crash / replay。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const team = require('../src/team/runtime/index.js');

const ROOT = path.join(__dirname, '..');
const TEAM_RUNTIME_DIR = path.join(ROOT, 'src', 'team', 'runtime');
const T0 = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// harness：注入 clock + 确定性时钟推进（**不**等待真实时间）
// ---------------------------------------------------------------------------

function createHarness({ scenario, jobId = 'job-fake-1', controllerOptions = {} } = {}) {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advanceClock = (ms) => { nowMs += ms; };
  const runtime = team.createTeamRuntime({ clock });
  const executor = team.createFakeExecutor({ scenario, clock, advanceClock });
  const facts = [];
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime,
    executor,
    clock,
    jobId,
    onFact: (fact) => facts.push(fact),
    ...controllerOptions,
  });
  return { runtime, executor, controller, clock, advanceClock, facts, jobId };
}

/**
 * 驱动到"完成或暂停"。暂停点 = 执行侧在等外部输入（attention / cancel），
 * 或执行侧还在跑但当前没有缓冲事件（真实后端的正常语义）。
 *
 * `recoverables` 决定遇到 attention 时的处理：'resume'（显式恢复）或 'finish'（宿主判定不可恢复）。
 */
async function drive(h, { recoverables = 'resume', maxRounds = 16 } = {}) {
  const log = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const factsBefore = h.runtime.facts().length;
    await h.controller.start();
    await h.controller.dispatchReady();
    const result = await h.controller.run();
    log.push(...result.trace);
    const state = h.runtime.state();
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
    // attention 挂在哪个角色上 → 按策略处理（**必须显式**，没有自动收敛）。
    const role = ['researcher', 'reviewer'].find((r) => state.runs[r] && state.runs[r].status === 'attention');
    if (role) {
      const verdict = recoverables === 'finish'
        ? h.controller.finishCrashed(role)
        : await h.controller.resume(role);
      if (!verdict.ok) break;
      continue;
    }
    // 没有 attention 也没有任何进展（无新事实、无 ready role）→ 真正的暂停点。
    const progressed = h.runtime.facts().length > factsBefore;
    const hasReady = h.runtime.readyRoles().length > 0;
    if (!progressed && !hasReady) break;
  }
  return log;
}

function factTypes(h) {
  return h.runtime.facts().map((fact) => fact.type);
}

// ===========================================================================
// 1. 场景：Happy
// ===========================================================================

test('fake: happy path converges root to completed through the executor (no office)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await drive(h);
  const state = h.runtime.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  assert.deepEqual(factTypes(h), [
    'job/created',
    'run/dispatched', 'run/started', 'artifact/available', 'run/completed',
    'run/dispatched', 'run/started', 'artifact/available', 'run/completed',
    'job/completed',
  ]);
  // reviewer 消费了 researcher 的 artifact（handoff 完整）。
  const researcherArtifact = state.runs.researcher.producedArtifactIds[0];
  assert.deepEqual(state.runs.reviewer.consumedArtifactIds, [researcherArtifact]);
  // 每个终态 fact 都带来源限定的 evidence，且来源是执行事件。
  for (const role of ['researcher', 'reviewer']) {
    assert.equal(state.runs[role].terminalEvidence.source, 'execution/completed:ok');
  }
});

test('fake: the fact log is produced by the executor, not by the controller (event count matches)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await drive(h);
  const state = h.runtime.state();
  // 每个 run：1 artifact + 1 started + 1 started-event + 1 terminal —— 由执行事件驱动。
  const sessions = h.controller.summary().sessions;
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session.terminal, true);
    assert.equal(session.consumed, 3, 'each fake run emits exactly 3 script events (started/artifact/completed)');
    assert.equal(session.applied, 3);
    assert.equal(session.lastSeq, 3);
  }
  // 事实条数与"执行事件条数 + 收敛事实"一致：证明没有凭空多出的事实。
  const appliedFromEvents = sessions.reduce((sum, s) => sum + s.applied, 0);
  assert.equal(appliedFromEvents, 6);
  assert.equal(h.runtime.facts().length, 10); // 6 + job/created + 2 dispatch + job/completed
  assert.equal(state.runs.researcher.attempt, 1);
});

// ===========================================================================
// 2. 场景：Attention → 显式 resume
// ===========================================================================

test('fake: attention blocks the root and never auto-completes; explicit resume converges', async () => {
  const h = createHarness({ scenario: 'attention-resume' });
  // 先跑到 attention 挂住（不做 resume）。
  await h.controller.start();
  await h.controller.dispatchReady();
  await h.controller.run();
  await h.controller.dispatchReady();
  await h.controller.run();
  let state = h.runtime.state();
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'attention', 'the executor drives the run into attention');
  assert.equal(state.status, 'attention', 'attention must block the root');
  assert.notEqual(state.status, 'completed', 'attention must NEVER auto-complete');
  // attention 不是终态：没有 endedAtMs / terminalEvidence。
  assert.equal(state.runs.reviewer.endedAtMs, null);
  assert.equal(state.runs.reviewer.terminalEvidence, null);

  // 继续推进但**不** resume：必须一直停在 attention（否则说明有人自动收敛）。
  for (let i = 0; i < 3; i += 1) {
    await h.controller.dispatchReady();
    await h.controller.run();
  }
  state = h.runtime.state();
  assert.equal(state.runs.reviewer.status, 'attention', 'attention must stay until an explicit resume');
  assert.equal(state.status, 'attention');

  // 显式 resume → 收敛 completed。
  assert.equal((await h.controller.resume('reviewer')).ok, true);
  await drive(h);
  state = h.runtime.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.runs.reviewer.terminalEvidence.source, 'execution/completed:ok');
  // 事实序列里 attention 之后**没有**第二个 terminal，只有一条 run/completed。
  const terminalFacts = factTypes(h).filter((t) => t === 'run/completed');
  assert.equal(terminalFacts.length, 2, 'exactly one terminal per run');
});

test('fake: attention survives replay (attention is a fact, not a timer)', async () => {
  const h = createHarness({ scenario: 'attention-resume' });
  await h.controller.start();
  await h.controller.dispatchReady();
  await h.controller.run();
  await h.controller.dispatchReady();
  await h.controller.run();
  const live = h.runtime.state();
  assert.equal(live.status, 'attention');
  // replay 产生逐字相同的状态（含 attention）—— 证明没有不在事实里的可变状态。
  const replayed = h.runtime.replay(h.runtime.facts());
  assert.deepEqual(replayed.runs.reviewer.status, live.runs.reviewer.status);
  assert.deepEqual(replayed.runs.reviewer.attention.reason, live.runs.reviewer.attention.reason);
  assert.equal(replayed.status, 'attention');
});

// ===========================================================================
// 3. 场景：Failure
// ===========================================================================

test('fake: failure fails the root and the reviewer never starts (dependency gate)', async () => {
  const h = createHarness({ scenario: 'failure' });
  await drive(h);
  const state = h.runtime.state();
  assert.equal(state.runs.researcher.status, 'failed');
  assert.equal(state.runs.reviewer.status, 'pending', 'reviewer must never start after an upstream failure');
  assert.equal(state.status, 'failed');
  // researcher 的 artifact **存在**（失败前产出了），但依赖判定只认 completed → 不放行。
  assert.equal(state.runs.researcher.producedArtifactIds.length, 1);
  assert.deepEqual([...h.runtime.readyRoles()], [], 'no role is ready after a failure');
  // 终态证据来自执行事件（不是"日志里有 error 字样"）。
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/failed:tool-error');
  assert.equal(state.runs.reviewer.terminalEvidence, null);
});

test('fake: a failed run never turns into completed (no silent success)', async () => {
  const h = createHarness({ scenario: 'failure' });
  await drive(h);
  const statuses = h.runtime.facts().map((fact) => fact.type);
  assert.equal(statuses.includes('run/completed'), false, 'a failed execution must never yield run/completed');
  assert.ok(statuses.includes('run/failed'));
  assert.ok(statuses.includes('job/failed'));
  // 执行侧也不再产出任何 completed 事件（脚本已耗尽）。
  const researcher = h.controller.handleFor('researcher');
  assert.equal(h.executor.state(researcher).terminalType, 'execution/failed');
});

// ===========================================================================
// 4. 场景：Cancel（请求 / ack / 真实终态三段分离）
// ===========================================================================

test('fake: cancel request and ack do NOT end the run; only the cancelled event does', async () => {
  const h = createHarness({ scenario: 'cancel' });
  await h.controller.start();
  await h.controller.dispatchReady();
  assert.equal((await h.controller.pumpOne()).type, 'execution/started');
  assert.equal(h.runtime.state().runs.researcher.status, 'running');

  // 取消请求 + ack：两者都**不**改变 run status。执行器会同时排入
  // cancel-requested / cancel-acknowledged / cancelled 三条，因此这里逐条 pump，
  // 以便分别断言"控制确认"与"真实终态"。
  const verdict = await h.controller.requestCancel('researcher');
  assert.equal(verdict.ok, true);
  assert.equal(verdict.acknowledged, true);

  const first = await h.controller.pumpOne();
  assert.equal(first.type, 'execution/cancel-requested');
  let state = h.runtime.state();
  assert.ok(factTypes(h).includes('run/cancel-requested'));
  assert.equal(state.runs.researcher.status, 'running', 'a cancel request must not end the run');
  assert.equal(typeof state.runs.researcher.cancelRequestedAtMs, 'number');

  const second = await h.controller.pumpOne();
  assert.equal(second.type, 'execution/cancel-acknowledged');
  state = h.runtime.state();
  assert.ok(factTypes(h).includes('run/cancel-acknowledged'));
  assert.equal(state.runs.researcher.status, 'running', 'a cancel ACK must never release the run');
  assert.equal(state.runs.researcher.endedAtMs, null, 'ack is not a terminal fact');
  assert.equal(factTypes(h).includes('run/cancelled'), false);

  // 真实 cancelled 事件到达 → 收敛 cancelled。
  const third = await h.controller.pumpOne();
  assert.equal(third.type, 'execution/cancelled');
  state = h.runtime.state();
  assert.equal(state.runs.researcher.status, 'cancelled');
  assert.equal(state.status, 'cancelled');
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/cancelled:cancelled');
  assert.ok(factTypes(h).includes('job/cancelled'));
});

test('fake: a cancel request after terminal is refused, not silently absorbed as a second terminal', async () => {
  const h = createHarness({ scenario: 'cancel' });
  await h.controller.start();
  await h.controller.dispatchReady();
  await h.controller.run();
  await h.controller.requestCancel('researcher');
  await h.controller.run();
  assert.equal(h.runtime.state().status, 'cancelled');
  // 再发一次 cancel：Team 侧拒绝（已终态），controller 结构化返回，不产生第二条终态。
  const again = await h.controller.requestCancel('researcher');
  assert.equal(again.ok, false);
  assert.equal(again.code, 'RUN_ALREADY_TERMINAL');
  const terminalCount = factTypes(h).filter((t) => t === 'run/cancelled').length;
  assert.equal(terminalCount, 1, 'exactly one cancelled terminal fact');
});

// ===========================================================================
// 5. Crash（显式策略：attention by default，宿主可收敛）
// ===========================================================================

test('fake: a crash becomes attention (never completed) and is recoverable or host-failed', async () => {
  const h = createHarness({ scenario: 'crash' });
  await h.controller.start();
  await h.controller.dispatchReady();
  await h.controller.run();
  let state = h.runtime.state();
  assert.equal(state.runs.researcher.status, 'attention', 'crash default policy = attention');
  assert.equal(state.status, 'attention');
  assert.equal(state.runs.researcher.terminalEvidence, null, 'crash is NOT a terminal fact');
  assert.equal(state.runs.researcher.attention.reason, 'executor-crashed');
  // 没有 completed 事实。
  assert.equal(factTypes(h).includes('run/completed'), false);
  // 宿主显式判定不可恢复 → failed，且证据是 crash 的来源限定字符串。
  const verdict = h.controller.finishCrashed('researcher');
  assert.equal(verdict.ok, true);
  state = h.runtime.state();
  assert.equal(state.runs.researcher.status, 'failed');
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/crashed:unrecoverable');
  assert.equal(state.status, 'failed');
});

// ===========================================================================
// 6. duplicate / late / out-of-order / identity mismatch
// ===========================================================================

test('fake: a duplicate execution/completed produces no second terminal fact (M15)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await drive(h);
  const before = h.runtime.facts().length;
  const handle = h.controller.handleFor('researcher');
  const completedEvent = {
    schemaVersion: 1,
    type: 'execution/completed',
    jobRef: handle.jobRef,
    executionRef: handle.executionRef,
    attempt: 1,
    seq: 3,                  // 与真实 completed 同 seq
    atMs: h.clock.nowMs(),
    reason: 'ok',
  };
  const verdict = h.controller.ingestExecutionEvent('researcher', completedEvent);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'EXEC_HANDLE_TERMINAL', 'a late event on a terminal session is refused');
  assert.equal(h.runtime.facts().length, before, 'no fact may be appended for a late/duplicate terminal');
  const terminalFacts = factTypes(h).filter((t) => t === 'run/completed');
  assert.equal(terminalFacts.length, 2, 'exactly one terminal per run after a duplicate');
});

test('fake: a duplicate at the same seq is refused before the team is touched', async () => {
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  await h.controller.dispatchReady();
  // 手工投递 seq=1 两次（模拟后端的重复投递）。
  const handle = h.controller.handleFor('researcher');
  const started = {
    schemaVersion: 1, type: 'execution/started',
    jobRef: handle.jobRef, executionRef: handle.executionRef, attempt: 1, seq: 1, atMs: h.clock.nowMs(),
  };
  assert.equal(h.controller.ingestExecutionEvent('researcher', started).ok, true);
  const factsAfterFirst = h.runtime.facts().length;
  const dup = h.controller.ingestExecutionEvent('researcher', started);
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'EXEC_DUPLICATE');
  assert.equal(h.runtime.facts().length, factsAfterFirst, 'duplicate must not append a fact');
  // 同样的重复直接进 Team 也只得到 duplicate（双保险）。
  assert.equal(h.runtime.startRun({ role: 'researcher' }).code, 'RUN_NOT_DISPATCHED');
  assert.equal(h.controller.summary().rejections.EXEC_DUPLICATE, 1);
});

test('fake: an out-of-order (lower seq) event is refused and produces no fact', async () => {
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  await h.controller.dispatchReady();
  const handle = h.controller.handleFor('researcher');
  const mk = (seq, type, extra = {}) => ({
    schemaVersion: 1, type, jobRef: handle.jobRef, executionRef: handle.executionRef,
    attempt: 1, seq, atMs: h.clock.nowMs(), ...extra,
  });
  assert.equal(h.controller.ingestExecutionEvent('researcher', mk(1, 'execution/started')).ok, true);
  assert.equal(h.controller.ingestExecutionEvent('researcher', mk(2, 'execution/artifact', { kind: 'research-notes' })).ok, true);
  const before = h.runtime.facts().length;
  const late = h.controller.ingestExecutionEvent('researcher', mk(2, 'execution/artifact', { kind: 'research-notes' }));
  assert.equal(late.ok, false);
  assert.equal(late.code, 'EXEC_DUPLICATE');
  const goingBack = h.controller.ingestExecutionEvent('researcher', mk(1, 'execution/started'));
  assert.equal(goingBack.ok, false);
  assert.equal(goingBack.code, 'EXEC_OUT_OF_ORDER');
  assert.equal(h.runtime.facts().length, before);
});

test('fake: an event with a mismatched identity is refused (job / run / attempt)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  await h.controller.dispatchReady();
  const handle = h.controller.handleFor('researcher');
  const base = {
    schemaVersion: 1, type: 'execution/started',
    jobRef: handle.jobRef, executionRef: handle.executionRef, attempt: 1, seq: 1, atMs: h.clock.nowMs(),
  };
  const cases = [
    ['job', { ...base, jobRef: team.execJobRefFor('some-other-job') }],
    ['run', { ...base, executionRef: team.executionRefFor(h.jobId, 'job-fake-1:researcher:1', 2) }],
    ['attempt', { ...base, attempt: 2 }],
  ];
  for (const [label, event] of cases) {
    const verdict = h.controller.ingestExecutionEvent('researcher', event);
    assert.equal(verdict.ok, false, `${label} mismatch must be refused`);
    assert.equal(verdict.code, 'EXEC_IDENTITY_MISMATCH');
  }
  assert.equal(h.runtime.facts().length, 2, 'only job/created + run/dispatched exist');
});

test('fake: raw identity smuggled into an event is refused at the schema boundary (M18)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  await h.controller.dispatchReady();
  const handle = h.controller.handleFor('researcher');
  const before = h.runtime.facts().length;
  for (const extra of [
    { sessionId: 'sess-child-raw-1' },
    { runId: 'job-fake-1:researcher:1' },
    { provider: { runId: 'raw' } },
    { evidence: 'execution/completed:ok' },
  ]) {
    const verdict = h.controller.ingestExecutionEvent('researcher', {
      schemaVersion: 1, type: 'execution/completed',
      jobRef: handle.jobRef, executionRef: handle.executionRef, attempt: 1, seq: 1, atMs: h.clock.nowMs(),
      ...extra,
    });
    assert.equal(verdict.ok, false, `${Object.keys(extra)[0]} must be refused`);
    assert.equal(verdict.code, 'EXEC_UNKNOWN_FIELD');
  }
  assert.equal(h.runtime.facts().length, before);
  // 事实里也没有 raw 身份（除 jobId 这个内部句柄，它按契约本来就在 Team 事实里）。
  const serialized = JSON.stringify(h.runtime.facts());
  for (const needle of ['sess-child-raw-1', 'exec-run:', 'exec-handle:', 'exec-job:']) {
    assert.equal(serialized.includes(needle), false, `Team facts must not contain ${needle}`);
  }
});

// ===========================================================================
// 7. 幂等：重复 dispatch / 重复 start 绝不启动第二个 Worker
// ===========================================================================

test('fake: repeated dispatch never starts a second worker (one handle per run)', async () => {
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  const first = h.controller.handleFor('researcher');
  assert.ok(first);
  const callsAfterFirst = h.executor.stats().startCalls;
  // 再调 5 次 start / dispatchReady：绝不第二次 startRun。
  for (let i = 0; i < 5; i += 1) {
    await h.controller.start();
    await h.controller.dispatchReady();
  }
  assert.equal(h.executor.stats().startCalls, callsAfterFirst,
    'repeated dispatch must not start a second execution');
  assert.equal(h.controller.handleFor('researcher').handleId, first.handleId);
  // 一个 run 一个 handle：handleId 与 executionRef 一一对应。
  assert.equal(h.controller.handleFor('researcher').handleId, `exec-handle:${first.executionRef.slice('exec-run:'.length)}`);
});

test('fake: the controller guard is NOT what protects us — the executor is (reachability fact)', async () => {
  // 2026-10-23 负向变异 N10 的实测结论：把 controller 里"已绑定则不重复绑定"的守卫删掉，
  // 测试**仍然全绿** —— 说明该守卫在当前流程里**不可达**，安全性的实际承担者是
  // executor 的 `EXEC_ALREADY_BOUND`。这里把这个可达性事实钉住，防止有人误以为
  // "一 run 一个 Worker"由 controller 的双层结构保证。
  //
  // 事实 1：一个角色被 dispatch 后，`readyRoles()` 永远不再回报它（Team 没有取消 dispatch）。
  const h = createHarness({ scenario: 'happy' });
  await h.controller.start();
  assert.deepEqual([...h.runtime.readyRoles()], [],
    'a dispatched role must never be ready again — so bindExecution is not re-entered');
  const callsBefore = h.executor.stats().startCalls;
  for (let i = 0; i < 5; i += 1) { await h.controller.start(); await h.controller.dispatchReady(); }
  assert.equal(h.executor.stats().startCalls, callsBefore,
    'no code path re-enters the binding (the guard is unreachable in v0)');

  // 事实 2：真正拦住第二次启动的是 executor（同一 (job,run,attempt) 已绑定即抛错）。
  assert.throws(
    () => h.executor.startRun({ jobId: h.jobId, runId: 'job-fake-1:researcher:1', role: 'researcher', attempt: 1 }),
    (error) => error.code === 'EXEC_ALREADY_BOUND',
  );
  // 事实 3：即使绕过 controller 直接调 executor，也**不会**产生第二个 Team 事实。
  const factsBefore = h.runtime.facts().length;
  try { h.executor.startRun({ jobId: h.jobId, runId: 'job-fake-1:researcher:1', role: 'researcher', attempt: 1 }); } catch { /* expected */ }
  assert.equal(h.runtime.facts().length, factsBefore,
    'a refused second execution must not append any Team fact');
});

test('fake: the executor itself refuses a second startRun for the same run (defence in depth)', () => {
  const h = createHarness({ scenario: 'happy' });
  const handle = h.executor.startRun({ jobId: h.jobId, runId: 'job-fake-1:researcher:1', role: 'researcher', attempt: 1 });
  assert.ok(handle);
  assert.throws(
    () => h.executor.startRun({ jobId: h.jobId, runId: 'job-fake-1:researcher:1', role: 'researcher', attempt: 1 }),
    (error) => error.code === 'EXEC_ALREADY_BOUND',
  );
});

test('fake: the whole scenario is replay-stable (same facts -> same state, twice)', async () => {
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    const h = createHarness({ scenario: 'happy', jobId: 'job-replay-1' });
    await drive(h);
    runs.push({
      facts: JSON.stringify(h.runtime.facts()),
      state: JSON.stringify(h.runtime.state()),
      replayed: JSON.stringify(h.runtime.replay(h.runtime.facts())),
    });
  }
  assert.equal(runs[0].facts, runs[1].facts, 'two identical runs must produce byte-identical fact logs');
  assert.equal(runs[0].state, runs[1].state);
  assert.equal(runs[0].replayed, runs[0].state, 'replay(facts) must equal the live state');
});

// ===========================================================================
// 8. 隔离：Team 侧测试不依赖 Office / Electron / DOM / Pixi / 网络
// ===========================================================================

test('fake: the whole chain completes with no office, no electron, no DOM, no network', async () => {
  // 结构性证据：本文件的 require 集合里没有 office / electron。
  const source = fs.readFileSync(__filename, 'utf8');
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  for (const spec of requires) {
    assert.equal(/office|electron|pixi/.test(spec), false, `this Team-side test must not pull in ${spec}`);
  }
  // 运行时证据：拦截 electron 后整条链仍然完成。
  const Module = require('node:module');
  const originalLoad = Module._load;
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (request === 'electron' || request === 'pixi.js') throw new Error(`${request} is unavailable in this probe`);
      return originalLoad.call(this, request, parent, isMain);
    };
    const h = createHarness({ scenario: 'happy', jobId: 'job-isolated-1' });
    await drive(h);
    assert.equal(h.runtime.state().status, 'completed');
  } finally {
    Module._load = originalLoad;
  }
});

test('fake: the executor and controller never require the office demo (demo is not a production input)', () => {
  const strip = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  for (const name of ['fake-executor.js', 'team-execution-controller.js', 'dsh-execution-backend.js']) {
    const code = strip(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    assert.equal(/team-office-demo/.test(code), false, `${name} must not require the dev demo script`);
  }
  // demo 与 FakeExecutor 的机制必须不同：demo 直接调 Team 命令（applyDemoOp），
  // FakeExecutor 只产事件。这里把"demo 有 applyDemoOp、executor 没有"钉住。
  const demoSource = strip(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'team-office-demo.js'), 'utf8'));
  assert.ok(/function applyDemoOp/.test(demoSource), 'demo keeps its own direct-command fixture');
  const fakeSource = strip(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'fake-executor.js'), 'utf8'));
  assert.equal(/applyDemoOp|DEMO_SCRIPT/.test(fakeSource), false,
    'FakeExecutor must not reuse the demo script/ops');
});

test('fake: the dev demo still works unchanged (regression: this task did not repurpose it)', () => {
  // demo 的存在与用途不变：仍是固定脚本 fixture，仍直接驱动 Team 命令。
  assert.equal(typeof team.createTeamOfficeDemo, 'function');
  assert.equal(Array.isArray(team.DEMO_SCRIPT_HAPPY), true);
  assert.equal(team.DEMO_SCRIPT_HAPPY.every((op) => typeof op.op === 'string'), true);
});