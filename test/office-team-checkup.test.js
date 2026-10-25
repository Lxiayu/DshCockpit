'use strict';

// test/office-team-checkup.test.js — Team → Office 最小事实消费闭环（组合根）。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13
//
// 目标闭环（任务书 §3）：
//   researcher started -> working -> artifact available -> completed
//   -> reviewer started -> completed -> root Job completed
// 异常分支：
//   reviewer attention -> Office 显示 attention -> Team 显式恢复 -> completed
//   cancel-requested / cancel-acknowledged -> Office 不得提前释放或显示 completed
//
// 判定标准不是"角色动起来了"，而是：Team Runtime 产生事实，Office Runtime 诚实消费事实，
// 动画只表现事实、不制造事实。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const { TICK_MS } = officeModule;
const team = require('../src/team/runtime/index.js');
const { createTeamRuntime, createTeamOfficeBridge } = team;

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const OFFICE_SEATS = Object.freeze(['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator']);
const JOB = 'job-fixture-1';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function createHarness(options = {}) {
  let nowMs = 1_700_000_000_000;
  const clock = { nowMs: () => nowMs };
  const advance = (ms) => { nowMs += ms; };
  const office = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-team-checkup-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: () => {},
  });
  const runtime = createTeamRuntime({ clock });
  const bridge = createTeamOfficeBridge({
    teamRuntime: runtime,
    office,
    knownSeats: OFFICE_SEATS,
    ...(options.bridge || {}),
  });
  return { office, runtime, bridge, clock, advance };
}

function tickFor(office, ms) {
  const steps = Math.round(ms / TICK_MS);
  for (let i = 0; i < steps; i += 1) office.tickOnce();
}

function tickUntil(office, predicate, maxMs = 60000) {
  const steps = Math.round(maxMs / TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    office.tickOnce();
    if (predicate(office.state())) return true;
  }
  return false;
}

function emp(office, employeeId) {
  return office.state().employees.find((e) => e.employeeId === employeeId);
}

function bindingsFor(office, employeeId) {
  return office.debugRegistrySnapshot().bindings.filter((b) => b.employeeId === employeeId);
}

function activeBindingsFor(office, employeeId) {
  return bindingsFor(office, employeeId).filter((b) => b.releasedAt === null);
}

function diagCodes(office) {
  return office.diagnostics().diagnostics.map((d) => d.code);
}

/** 把 Team 推进到"researcher 正在工作"，并让 office 反映出来。 */
function startResearcher(h) {
  h.runtime.createJob({ jobId: JOB });
  h.runtime.dispatchRun({ role: 'researcher' });
  h.runtime.startRun({ role: 'researcher' });
  h.bridge.pump();
  tickFor(h.office, 400);
}

/** researcher 产出 artifact 并完成（office 侧走结果呈现窗口）。 */
function completeResearcher(h) {
  h.runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  h.bridge.pump();
  h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
  h.bridge.pump();
  tickFor(h.office, 600);
}

function startReviewer(h) {
  h.runtime.dispatchRun({ role: 'reviewer' });
  h.runtime.startRun({ role: 'reviewer', consumedArtifactIds: h.runtime.state().runs.researcher.producedArtifactIds });
  h.bridge.pump();
  tickFor(h.office, 400);
}

// ===========================================================================
// 1. 目标闭环
// ===========================================================================

test('team-office: the fixed loop is visible in the office seat by seat', () => {
  const h = createHarness();
  // researcher started -> working
  startResearcher(h);
  const researcher = emp(h.office, 'researcher');
  assert.equal(researcher.runtime, 'running', 'researcher seat is running');
  assert.equal(researcher.activity, 'working');
  assert.equal(researcher.taskLabel, '执行任务中');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);
  // 依赖未满足：reviewer 座位没有任何绑定（Office 不伪造启动）。
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 0);

  // artifact available -> completed
  completeResearcher(h);
  assert.equal(emp(h.office, 'researcher').runtime, 'idle', 'researcher released after the result window');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0);
  assert.equal(diagCodes(h.office).includes('TEAM_ARTIFACT_AVAILABLE'), true, 'artifact stage hint is observable');

  // reviewer started -> completed
  startReviewer(h);
  const reviewer = emp(h.office, 'reviewer');
  assert.equal(reviewer.runtime, 'running');
  assert.equal(reviewer.activity, 'working');
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 1);

  h.runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  h.runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });
  h.bridge.pump();
  tickFor(h.office, 600);

  // root Job completed -> 汇总诊断（不新增 office runtime 枚举、不占座位）
  assert.equal(h.runtime.state().status, 'completed');
  assert.equal(diagCodes(h.office).includes('TEAM_JOB_COMPLETED'), true);
  assert.equal(emp(h.office, 'reviewer').runtime, 'idle');
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 0);
  assert.equal(activeBindingsFor(h.office, 'orchestrator').length, 0, 'root Job never occupies a seat');
  assert.equal(h.bridge.summary().counters.officeRejected, 0, 'no office-side rejection in the happy path');
  assert.deepEqual(h.bridge.summary().artifactKinds, { 'research-notes': 1, 'review-findings': 1 });
});

// ===========================================================================
// 2. attention 分支
// ===========================================================================

test('team-office: reviewer attention shows attention (never completed) and resumes on the same run', () => {
  const h = createHarness();
  startResearcher(h);
  completeResearcher(h);
  startReviewer(h);

  h.runtime.noteRunAttention({ role: 'reviewer', reason: 'needs-approval' });
  h.bridge.pump();
  tickFor(h.office, 400);
  const waiting = emp(h.office, 'reviewer');
  assert.equal(waiting.runtime, 'attention', 'office shows attention');
  assert.equal(waiting.lastResult, null, 'attention is not a result');
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 1, 'binding retained during attention');
  // 动画/时间都不会把它变成 completed。
  tickFor(h.office, 5000);
  assert.equal(emp(h.office, 'reviewer').runtime, 'attention');
  assert.equal(h.runtime.state().runs.reviewer.status, 'attention');
  assert.equal(h.runtime.state().status, 'attention');
  assert.equal(diagCodes(h.office).includes('TEAM_JOB_ATTENTION'), true);

  // Team 侧显式恢复（同一个 run，不新建 WorkerRun）。
  const runIdBefore = h.runtime.state().runs.reviewer.runId;
  h.runtime.startRun({ role: 'reviewer', consumedArtifactIds: h.runtime.state().runs.researcher.producedArtifactIds });
  h.bridge.pump();
  tickFor(h.office, 400);
  assert.equal(h.runtime.state().runs.reviewer.runId, runIdBefore, 'same WorkerRun resumed');
  assert.equal(emp(h.office, 'reviewer').runtime, 'running');
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 1, 'no duplicate binding on resume');

  // 继续到完成。
  h.runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  h.runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });
  h.bridge.pump();
  tickFor(h.office, 600);
  assert.equal(h.runtime.state().status, 'completed');
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 0);
});

// ===========================================================================
// 3. cancel 分支
// ===========================================================================

test('team-office: cancel ack never releases the seat; only terminal evidence does', () => {
  const h = createHarness();
  startResearcher(h);
  assert.equal(emp(h.office, 'researcher').runtime, 'running');

  h.runtime.requestCancel({ role: 'researcher' });
  h.bridge.pump();
  tickFor(h.office, 200);
  // 请求只是请求：绑定保留、seat 不释放、不 completed。
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1, 'cancel request keeps the binding');
  assert.equal(emp(h.office, 'researcher').runtime, 'running');
  assert.equal(emp(h.office, 'researcher').control, 'cancellationPending');

  h.runtime.noteCancelAcknowledged({ role: 'researcher' });
  h.bridge.pump();
  tickFor(h.office, 400);
  // 回执同样不释放、不 completed（这是 office 内核已实证的规则）。
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1, 'cancel ack must not release');
  assert.equal(emp(h.office, 'researcher').runtime, 'running');
  assert.equal(emp(h.office, 'researcher').lastResult, null);
  assert.equal(h.runtime.state().runs.researcher.status, 'running');

  // 只有真实终态才释放。
  h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'cancelled', evidence: 'turn/end:aborted' });
  h.bridge.pump();
  tickFor(h.office, 400);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0, 'terminal cancel releases the seat');
  assert.equal(emp(h.office, 'researcher').runtime, 'idle');
  assert.equal(emp(h.office, 'researcher').lastResult.outcome, 'cancelled');
});

// ===========================================================================
// 4. failed 不得触发 completed
// ===========================================================================

test('team-office: a failed run shows failed, never completed, and blocks the reviewer', () => {
  const h = createHarness();
  startResearcher(h);
  h.runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  h.bridge.pump();
  h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'failed', evidence: 'turn/end:error' });
  h.bridge.pump();
  // 呈现窗口内 runtime 必须是 failed（error 表情），不是 completed。
  tickFor(h.office, 100);
  const presenting = emp(h.office, 'researcher');
  assert.equal(presenting.runtime, 'failed');
  // 动画只表现事实：failed 必须走 error 表情，绝不能播 finished（completed 动画）。
  assert.notEqual(presenting.activity, 'celebrating', 'failed must not celebrate');
  assert.equal(presenting.activity, 'working');
  assert.notEqual(presenting.animation.resource, 'finished', 'failed must not play the finished expression');
  assert.equal(presenting.animation.resource, 'error');
  tickFor(h.office, 600);
  const done = emp(h.office, 'researcher');
  assert.equal(done.runtime, 'idle');
  assert.equal(done.lastResult.outcome, 'failed', 'the recorded result is failed');
  assert.notEqual(done.lastResult.outcome, 'completed');
  // 下游永不放行（Team 侧根本不 dispatch；Office 侧没有任何 reviewer 绑定）。
  assert.equal(h.runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  h.bridge.pump();
  assert.equal(activeBindingsFor(h.office, 'reviewer').length, 0);
  assert.equal(h.runtime.state().status, 'failed');
  assert.equal(diagCodes(h.office).includes('TEAM_JOB_FAILED'), true);
});

// ===========================================================================
// 3b. attention 的视觉投影（2026-10-23 收口：attention 不再退化成普通 working）
// ===========================================================================

test('team-office: attention projects to the attention/warning expression, not working', () => {
  // 修复前 animationStateFor() 把 running 与 attention 都映射成 'working'，
  // 落座后二者 animation.resource 完全相同 —— 事实忠实、表现把信息吞了。
  const h = createHarness();
  startResearcher(h);
  assert.equal(tickUntil(h.office, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'researcher');
    return e && e.transition && e.transition.kind === 'task-start'
      && e.transition.phase === 'work' && e.movement === 'stationary';
  }), true, 'researcher is seated at the workstation');

  const working = emp(h.office, 'researcher');
  assert.equal(working.runtime, 'running');
  assert.equal(working.animation.resource, 'working', 'baseline: running shows the working expression');

  h.runtime.noteRunAttention({ role: 'researcher', reason: 'needs-approval' });
  h.bridge.pump();
  tickFor(h.office, 300);
  const waiting = emp(h.office, 'researcher');
  assert.equal(waiting.runtime, 'attention');            // 1. runtime 是 attention
  assert.equal(waiting.lastResult, null);                // 2. 非终态：没有 result
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1); // 3. 绑定仍在
  assert.notEqual(waiting.animation.resource, 'working', 'attention must not look like working');
  assert.equal(waiting.animation.resource, 'warning', 'attention resolves to the warning expression');
});

test('team-office: a real Harness attention also projects to the warning expression', () => {
  // 两条路径共用同一个 animationStateFor 映射，所以 Harness 侧触发的 attention
  // （turn/end reason=blocked）同样不能退化成 working。
  const office = officeModule.createOfficeModule({
    pack: PACK, seed: 'office-team-checkup-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 }, log: () => {},
  });
  // 用生产同一条词表：main.js 把 0.1.5 的 turn/start 翻译成 agent/status running
  // （适配器只认后者，直接喂 turn/start 不会产生任何事实）。
  office.ingestHarnessEvent({ sessionId: 'sess-attn', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  tickFor(office, 400);
  // 等到 orchestrator 真正落座（位置事实优先：行走中仍显示行走）
  assert.equal(tickUntil(office, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'orchestrator');
    return e && e.transition && e.transition.kind === 'task-start'
      && e.transition.phase === 'work' && e.movement === 'stationary';
  }), true, 'orchestrator is seated at the workstation');
  office.ingestHarnessEvent({ sessionId: 'sess-attn', type: 'turn/end', seq: 2, time: 2, data: { reason: 'blocked' } });
  tickFor(office, 300);
  const e = emp(office, 'orchestrator');
  assert.equal(e.runtime, 'attention');
  assert.equal(e.lastResult, null);
  assert.notEqual(e.animation.resource, 'working', 'Harness attention must not look like working');
  assert.equal(e.animation.resource, 'warning');
});

test('team-office: resume returns to running/working and does not redo binding side effects', () => {
  const h = createHarness();
  startResearcher(h);
  assert.equal(tickUntil(h.office, (state) => {
    const e = state.employees.find((x) => x.employeeId === 'researcher');
    return e && e.transition && e.transition.phase === 'work' && e.movement === 'stationary';
  }), true, 'researcher is seated');
  h.runtime.noteRunAttention({ role: 'researcher', reason: 'needs-approval' });
  h.bridge.pump();
  tickFor(h.office, 300);
  assert.equal(emp(h.office, 'researcher').animation.resource, 'warning');

  const taskSeqBefore = emp(h.office, 'researcher').taskSeq;
  h.runtime.startRun({ role: 'researcher' });   // 显式恢复
  h.bridge.pump();
  tickFor(h.office, 300);
  const resumed = emp(h.office, 'researcher');
  assert.equal(resumed.runtime, 'running', 'back to running');
  assert.equal(resumed.animation.resource, 'working', 'back to the working expression');
  assert.equal(resumed.taskSeq, taskSeqBefore, 'taskSeq unchanged by resume');
  assert.equal(h.office.state().activityLog.filter((e) => e.employeeId === 'researcher' && e.kind === 'task-started').length, 1);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);
});

test('team-office: completed / failed / cancelled expressions do not regress', () => {
  {
    const h = createHarness();
    startResearcher(h);
    h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
    h.bridge.pump();
    tickFor(h.office, 120);
    const w = emp(h.office, 'researcher');
    assert.equal(w.runtime, 'completed');
    assert.equal(w.animation.resource, 'finished');
    assert.equal(w.activity, 'celebrating');
  }
  {
    const h = createHarness();
    startResearcher(h);
    h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'failed', evidence: 'turn/end:error' });
    h.bridge.pump();
    tickFor(h.office, 120);
    const w = emp(h.office, 'researcher');
    assert.equal(w.runtime, 'failed');
    assert.equal(w.animation.resource, 'error');
    assert.notEqual(w.animation.resource, 'finished');
  }
  {
    const h = createHarness();
    startResearcher(h);
    h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'cancelled', evidence: 'turn/end:aborted' });
    h.bridge.pump();
    tickFor(h.office, 300);
    const w = emp(h.office, 'researcher');
    assert.equal(w.runtime, 'idle');
    assert.equal(w.lastResult.outcome, 'cancelled');
    assert.notEqual(w.animation.resource, 'warning');
  }
});

// ===========================================================================
// 4b. binding-created 副作用只执行一次（2026-10-22 体验验证实测缺陷的回归钉）
// ===========================================================================

test('team-office: one run-started executes binding-created exactly once (no double side effects)', () => {
  // 缺陷：run-started 分支曾同时调用 onBindingCreated(binding, effects) 与
  // applyRegistryEffects(effects) —— 后者对 dispatch-started 效果**再次**调用
  // onBindingCreated，导致 'task-started' 记两条、taskSeq +2、turnUsage 开两个
  // 累加器。office 自己的 applyFact 分类子代理路径只调用一次，这里必须同构。
  const h = createHarness();
  startResearcher(h);
  const researcherLog = h.office.state().activityLog.filter((e) => e.employeeId === 'researcher');
  assert.equal(researcherLog.filter((e) => e.kind === 'task-started').length, 1,
    'exactly one task-started per run start');
  assert.equal(emp(h.office, 'researcher').taskSeq, 1, 'taskSeq advances once per run');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);

  // attention -> resume 不得再执行一次 binding-created。
  h.runtime.noteRunAttention({ role: 'researcher', reason: 'needs-approval' });
  h.bridge.pump();
  tickFor(h.office, 300);
  assert.equal(emp(h.office, 'researcher').runtime, 'attention');
  h.runtime.startRun({ role: 'researcher' });
  h.bridge.pump();
  tickFor(h.office, 300);
  const afterResume = h.office.state().activityLog.filter((e) => e.employeeId === 'researcher');
  assert.equal(afterResume.filter((e) => e.kind === 'task-started').length, 1,
    'resume must not repeat binding-created');
  assert.equal(emp(h.office, 'researcher').taskSeq, 1, 'taskSeq unchanged by resume');
  assert.equal(emp(h.office, 'researcher').runtime, 'running');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);
});

// ===========================================================================
// 5. 幂等：重复 start / 重复 terminal
// ===========================================================================

test('team-office: duplicate start does not rebind and duplicate terminal does not double-release', () => {
  const h = createHarness();
  startResearcher(h);
  const startedSummary = h.bridge.summary();
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);

  // 重复投递整条 Team 日志（replay）：不得重复绑定。
  h.bridge.replay();
  tickFor(h.office, 200);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1, 'replay must not rebind');
  assert.equal(emp(h.office, 'researcher').runtime, 'running', 'replay must not disturb the seat');
  assert.equal(h.bridge.summary().counters.duplicates > 0, true, 'the duplicate is absorbed, not re-applied');
  void startedSummary;

  // 重复 terminal：不得二次释放。
  h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
  h.bridge.pump();
  tickFor(h.office, 600);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0);
  const releasedAt = bindingsFor(h.office, 'researcher')[0].releasedAt;
  h.bridge.replay();  // 重放整条日志：终态那一条会再次到达
  tickFor(h.office, 400);
  const after = bindingsFor(h.office, 'researcher');
  assert.equal(after.length, 1, 'no second binding record for the same run');
  assert.equal(after[0].releasedAt, releasedAt, 'releasedAt is unchanged (no double release)');
});

// ===========================================================================
// 6. replay / 重复 / 乱序
// ===========================================================================

test('team-office: replaying the whole log into a fresh office reproduces the same final state', () => {
  const h = createHarness();
  h.runtime.createJob({ jobId: JOB });
  h.runtime.dispatchRun({ role: 'researcher' });
  h.runtime.startRun({ role: 'researcher' });
  h.runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  h.runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
  h.runtime.dispatchRun({ role: 'reviewer' });
  h.runtime.startRun({ role: 'reviewer', consumedArtifactIds: h.runtime.state().runs.researcher.producedArtifactIds });
  h.runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  h.runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });
  h.bridge.pump();
  tickFor(h.office, 1200);

  // 一个全新的 office：从日志头把整条链重放一遍（模拟重放/恢复）。
  const fresh = officeModule.createOfficeModule({
    pack: PACK, seed: 'office-team-checkup-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 }, log: () => {},
  });
  const freshBridge = createTeamOfficeBridge({
    teamRuntime: h.runtime, office: fresh, knownSeats: OFFICE_SEATS,
  });
  freshBridge.pump();
  tickFor(fresh, 1200);

  const observable = (office) => office.state().employees.map((e) => ({
    employeeId: e.employeeId, runtime: e.runtime, activity: e.activity, lastResult: e.lastResult,
  }));
  assert.deepEqual(observable(fresh), observable(h.office), 'replay reproduces the same final office state');
  assert.equal(freshBridge.summary().counters.rejected, 0);
});

test('team-office: an out-of-order terminal fails closed — no binding, no release, stable diagnostic', () => {
  const h = createHarness();
  // 直接投递一条终态（Office 侧从未见过这条 run 的 start）。
  const runHandle = team.runHandleFor
    ? null
    : null;
  void runHandle;
  const mapped = team.createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS })
    .mapFact({ jobId: JOB, type: 'run/completed', role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed', seq: 9, atMs: 1 });
  assert.equal(mapped.ok, true);
  const applied = h.office.ingestTeamProjectionFact(mapped.officeFacts[0]);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'TEAM_RUN_UNKNOWN', 'fail-closed: nothing to release');
  assert.equal(bindingsFor(h.office, 'researcher').length, 0, 'no binding was invented');
  assert.equal(diagCodes(h.office).includes('TEAM_RUN_UNKNOWN'), true, 'the failure is observable');
  // 随后顺序投递 start：正常绑定，且不会因为刚才的乱序而重复。
  startResearcher(h);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);
});

// ===========================================================================
// 7. 座位归属不变式
// ===========================================================================

test('team-office: one run never binds two seats and one seat never holds two runs', () => {
  const h = createHarness();
  startResearcher(h);
  const adapter = team.createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS });
  const researcherFact = adapter.mapFact({
    jobId: JOB, type: 'run/started', role: 'researcher', seq: 2, atMs: 1,
  }).officeFacts[0];
  // 同一个 runHandle 试图改绑到另一个座位：office 必须拒绝（一会话一绑定）。
  const rebound = h.office.ingestTeamProjectionFact({ ...researcherFact, seat: 'coder' });
  assert.equal(rebound.ok, false);
  assert.equal(activeBindingsFor(h.office, 'coder').length, 0, 'must not steal another seat');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 1);
  // 每个座位最多一条活跃绑定。
  for (const seat of OFFICE_SEATS) {
    assert.ok(activeBindingsFor(h.office, seat).length <= 1, `${seat} has at most one active binding`);
  }
});

// ===========================================================================
// 8. 隐私
// ===========================================================================

const SENTINELS = Object.freeze([
  'FIXTURE-PROMPT-tell-me-everything',
  '/Users/someone/secret-project',
  'sk-FIXTURESECRET0123456789',
  'run-RAW-FIXTURE-RUNID-1',
  'sess-RAW-FIXTURE-SESSION-1',
]);

test('team-office: no prompt, path, secret, raw session/run id or artifact content reaches the snapshot', () => {
  const h = createHarness();
  // 用带哨兵的 jobId 驱动（Team 侧接受任意有界 jobId）。
  const dirtyJobId = SENTINELS[4];
  h.runtime.createJob({ jobId: dirtyJobId });
  h.runtime.dispatchRun({ role: 'researcher' });
  h.runtime.startRun({ role: 'researcher' });
  h.runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  h.bridge.pump();
  tickFor(h.office, 400);

  const blobs = [
    JSON.stringify(h.office.state()),
    JSON.stringify(h.office.diagnostics()),
    JSON.stringify(h.bridge.summary()),
  ];
  for (const blob of blobs) {
    for (const sentinel of SENTINELS) {
      assert.equal(blob.includes(sentinel), false, `leaked: ${sentinel}`);
    }
  }
  // 快照里不允许出现派生 id（本阶段只传计数/kind/粗粒度摘要）。
  const snapshot = JSON.stringify(h.office.state());
  assert.equal(snapshot.includes('team-job-sha256:'), false);
  assert.equal(snapshot.includes('team-run-sha256:'), false);
  assert.equal(snapshot.includes('art:'), false);
  // 员工绑定投影只有 source/confidence。
  const researcher = emp(h.office, 'researcher');
  assert.deepEqual(Object.keys(researcher.binding).sort(), ['confidence', 'source']);
});

// ===========================================================================
// 9. 事实边界：Office 不制造事实
// ===========================================================================

test('team-office: the office never writes back to the Team runtime', () => {
  const h = createHarness();
  startResearcher(h);
  const before = JSON.stringify(h.runtime.digest());
  // 让办公室跑很久（动画/移动/闲聊全都在动）。
  tickFor(h.office, 30000);
  assert.equal(JSON.stringify(h.runtime.digest()), before,
    'office activity (animation/movement) must never create a Team fact');
  // 办公室侧的事实来源只有 ingestTeamProjectionFact 一个入口。
  assert.equal(typeof h.office.ingestTeamProjectionFact, 'function');
  assert.equal(typeof h.office.ingestHarnessEvent, 'function');
  // 快照里没有 Team 的 runtime 枚举（office 的 runtime 维度保持不变）。
  const reducer = require('../src/office/runtime/state-reducer.js');
  assert.deepEqual([...reducer.RUNTIME_STATES],
    ['unbound', 'idle', 'running', 'attention', 'completed', 'failed']);
  assert.equal([...reducer.RUNTIME_STATES].includes('dispatched'), false);
  assert.equal([...reducer.QUEUE_STATES].join(','), 'empty,queued');
});

test('team-office: unknown mapped facts fail closed with a stable diagnostic', () => {
  const h = createHarness();
  const rejected = h.office.ingestTeamProjectionFact({ kind: 'run-teleported', identity: {} });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'TEAM_FACT_UNKNOWN_KIND');
  const noIdentity = h.office.ingestTeamProjectionFact({ kind: 'run-started', seat: 'researcher' });
  assert.equal(noIdentity.code, 'TEAM_IDENTITY_REQUIRED', 'missing identity is its own stable code');
  // 身份完整但座位未知（用 adapter 生成合法身份，再改 seat）。
  const adapter = team.createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS });
  const valid = adapter.mapFact({ jobId: JOB, type: 'run/started', role: 'researcher', seq: 2, atMs: 1 }).officeFacts[0];
  const unknownSeat = h.office.ingestTeamProjectionFact({ ...valid, seat: 'not-a-seat' });
  assert.equal(unknownSeat.code, 'TEAM_SEAT_UNKNOWN');
  const badJob = h.office.ingestTeamProjectionFact({ kind: 'job-status', identity: {}, jobStatus: 'teleported' });
  assert.equal(badJob.code, 'TEAM_IDENTITY_INVALID', 'identity is validated before the payload');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0, 'no seat was touched');
  // adapter 拒绝码白名单：未知码回落成稳定码，绝不让任意字符串进诊断环。
  const unknownCode = h.office.ingestTeamProjectionFact({ kind: 'adapter-rejected', code: 'ARBITRARY_STRING' });
  assert.equal(unknownCode.code, 'TEAM_FACT_SHAPE_INVALID');
  const knownCode = h.office.ingestTeamProjectionFact({ kind: 'adapter-rejected', code: 'TEAM_SEAT_UNMAPPED' });
  assert.equal(knownCode.code, 'TEAM_SEAT_UNMAPPED');
});

// ---------------------------------------------------------------------------
// P1（2026-10-19）：窄入口**独立**的身份形状门 —— 绕过 adapter 的伪造输入必须全部拒绝
// ---------------------------------------------------------------------------

test('P1: the narrow entry rejects forged identities even when the adapter is bypassed', () => {
  const h = createHarness();
  const forged = [
    ['arbitrary runHandle', { runHandle: 'arbitrary-string', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['raw runId as a compat format', { runHandle: 'job-fixture-1:researcher:1', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['raw session id', { runHandle: 'sess-RAW-FIXTURE-SESSION-1', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['wrong prefix (pairingHandle)', { runHandle: 'run-sha256:0123456789abcdef', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['wrong prefix (artifact)', { runHandle: 'art:0123456789abcdef', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['too short', { runHandle: 'team-run-sha256:0123', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['too long', { runHandle: 'team-run-sha256:0123456789abcdef0', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['uppercase hex', { runHandle: 'team-run-sha256:0123456789ABCDEF', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['wrong statusSource', { runHandle: 'team-run-sha256:0123456789abcdef', role: 'researcher', factType: 'run/started', statusSource: 'harness', seq: 1 }],
    ['missing statusSource', { runHandle: 'team-run-sha256:0123456789abcdef', role: 'researcher', factType: 'run/started', seq: 1 }],
    ['unknown role', { runHandle: 'team-run-sha256:0123456789abcdef', role: 'planner', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['unknown factType', { runHandle: 'team-run-sha256:0123456789abcdef', role: 'researcher', factType: 'run/teleported', statusSource: 'team-runtime', seq: 1 }],
    ['null role on a seat-scoped fact', { runHandle: 'team-run-sha256:0123456789abcdef', role: null, factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['forged jobHandle', { runHandle: 'team-run-sha256:0123456789abcdef', jobHandle: 'raw-job-id', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
    ['non-integer seq', { runHandle: 'team-run-sha256:0123456789abcdef', role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: '1' }],
    ['runHandle not a string', { runHandle: 42, role: 'researcher', factType: 'run/started', statusSource: 'team-runtime', seq: 1 }],
  ];
  for (const [label, identity] of forged) {
    const verdict = h.office.ingestTeamProjectionFact({ kind: 'run-started', seat: 'researcher', identity });
    assert.equal(verdict.ok, false, label);
    assert.equal(verdict.code, 'TEAM_IDENTITY_INVALID', label);
  }
  // 身份根本不是对象 → 另一个稳定码（"缺失"与"非法"分开，便于诊断）。
  const notAnObject = h.office.ingestTeamProjectionFact({
    kind: 'run-started', seat: 'researcher', identity: 'team-run-sha256:0123456789abcdef',
  });
  assert.equal(notAnObject.ok, false);
  assert.equal(notAnObject.code, 'TEAM_IDENTITY_REQUIRED');
  // 伪造输入不得产生任何副作用：不建绑定、不释放座位、不进快照。
  assert.equal(bindingsFor(h.office, 'researcher').length, 0, 'no binding was invented');
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0);
  assert.equal(JSON.stringify(h.office.state()).includes('team-run-sha256:'), false);
  assert.equal(JSON.stringify(h.office.state()).includes('arbitrary-string'), false);
  // 且失败是可观测的（不静默）。
  assert.equal(diagCodes(h.office).includes('TEAM_IDENTITY_INVALID'), true);
});

test('P1: a valid identity still passes, and job-status may legitimately carry no run', () => {
  const h = createHarness();
  const adapter = team.createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS });
  // 正对照：adapter 产出的身份被接受。
  const started = adapter.mapFact({ jobId: JOB, type: 'run/started', role: 'researcher', seq: 2, atMs: 1 }).officeFacts[0];
  assert.equal(h.office.ingestTeamProjectionFact(started).ok, true);
  // job-status 是关于 Job 的：runHandle 允许为 null（它不是伪造，是"没有 run"）。
  const jobStatus = adapter.mapFact({ jobId: JOB, type: 'job/completed', seq: 9, atMs: 1, evidence: 'team/convergence:completed' }).officeFacts[0];
  assert.equal(jobStatus.identity.runHandle, null);
  assert.equal(h.office.ingestTeamProjectionFact(jobStatus).ok, true);
  // 但 job-status 若**带** runHandle，也必须是合法形状。
  const forgedJob = { ...jobStatus, identity: { ...jobStatus.identity, runHandle: 'raw-run-id' } };
  assert.equal(h.office.ingestTeamProjectionFact(forgedJob).code, 'TEAM_IDENTITY_INVALID');
});

test('P1: the office entry does not import the Team layer (layering is one-way)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  assert.equal(/require\(\s*['"]\.\.\/\.\.\/team\//.test(source), false,
    'office must not require the Team layer — the Team layer requires office (injected)');
  // office 自带身份契约常量（不 import adapter 的常量，两个边界保持解耦）。
  assert.match(source, /team-run-sha256:\[0-9a-f\]\{16\}/);
  assert.match(source, /'team-runtime'/);
});

test('team-office: adapter mapping failures are observable in the office diagnostics', () => {
  const h = createHarness();
  const broken = team.createTeamOfficeAdapter({ knownSeats: OFFICE_SEATS, roleToSeat: {} });
  const brokenBridge = createTeamOfficeBridge({
    teamRuntime: h.runtime, office: h.office, knownSeats: OFFICE_SEATS, roleToSeat: {},
  });
  void broken;
  h.runtime.createJob({ jobId: JOB });
  h.runtime.dispatchRun({ role: 'researcher' });
  h.runtime.startRun({ role: 'researcher' });
  brokenBridge.pump();
  tickFor(h.office, 200);
  // 显式表缺项 → fail-closed，且 office 侧留下稳定诊断（不静默）。
  assert.equal(brokenBridge.summary().counters.rejected > 0, true);
  assert.equal(diagCodes(h.office).includes('TEAM_SEAT_UNMAPPED'), true);
  assert.equal(activeBindingsFor(h.office, 'researcher').length, 0, 'unmapped role binds nothing');
});
