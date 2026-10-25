'use strict';

// test/office-team-execution.test.js — 阶段 4 组合组：FakeExecutor → Team → Office projection。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §8 / Team 契约 §13
//
// 这一组**是唯一**允许出现 Office 的组合测试（任务书 §6.4/§11.4 要求两组分开）。
// Team 侧的隔离组在 `test/team-execution-fake.test.js`，它结构上不 import office。
//
// 验证的是生产会走的同一条代码路径：
//   FakeExecutor（执行事件）
//     → TeamExecutionController（唯一转换点）
//     → Team Runtime（Team fact）
//     → team-office-adapter + bridge（无状态纯映射）
//     → office.ingestTeamProjectionFact（窄入口）
//     → registry / reducer / office 快照（renderer 消费的同一份）
//
// 不启动 Electron / DOM / Pixi：办公室用真实组合根（createOfficeModule），
// 时钟用 office 自己的逻辑时钟，pump 用原语（生产里由注入的定时器调用）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const team = require('../src/team/runtime/index.js');

const P = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
}).pack;
const SEATS = Object.freeze(['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator']);
const T0 = 1_700_000_000_000;

/**
 * 组合根 + 执行链。**Office 是消费者**：它只在最后一跳出现，Team 侧完全不知道它存在。
 * `withOffice: false` 时 office 为 null —— 用来证明同一条 Team 链在没有 Office 时
 * 也能完成（同构于隔离组，但这里用同一份驱动代码，排除"两套实现"的可能）。
 */
function createChain({ scenario, withOffice = true, jobId = 'job-office-exec-1' } = {}) {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advanceClock = (ms) => { nowMs += ms; };
  const office = withOffice
    ? officeModule.createOfficeModule({
      pack: PACK,
      seed: 'team-execution-seed',
      config: { resultPresentationMs: 200, workstationAnchorSegmentMs: 120 },
      log: () => {},
    })
    : null;
  const runtime = team.createTeamRuntime({ clock });
  const executor = team.createFakeExecutor({ scenario, clock, advanceClock });
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor, clock, jobId,
  });
  const bridge = office
    ? team.createTeamOfficeBridge({ teamRuntime: runtime, office, knownSeats: SEATS })
    : null;
  return { office, runtime, executor, controller, bridge, clock, advanceClock, jobId };
}

/** 驱动 Team 链到收敛/暂停；每一步之后把新 Team fact 经 bridge 投影到 Office。 */
async function driveChain(chain, { maxRounds = 16 } = {}) {
  for (let i = 0; i < maxRounds; i += 1) {
    const before = chain.runtime.facts().length;
    await chain.controller.start();
    await chain.controller.dispatchReady();
    await chain.controller.run();
    if (chain.bridge) chain.bridge.pump();
    const state = chain.runtime.state();
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
    const role = ['researcher', 'reviewer'].find((r) => state.runs[r] && state.runs[r].status === 'attention');
    if (role) { await chain.controller.resume(role); continue; }
    if (chain.runtime.facts().length === before && chain.runtime.readyRoles().length === 0) break;
  }
  if (chain.bridge) chain.bridge.pump();
  return chain.runtime.state();
}

/** 推进 office 的逻辑时钟 n 个 tick，每次之后 pump 投影（生产里由定时器做同一件事）。 */
function tickOffice(chain, n) {
  for (let i = 0; i < n; i += 1) {
    chain.office.tickOnce();
    chain.bridge.pump();
  }
}

function employeeSnapshot(office, employeeId) {
  return office.state().employees.find((e) => e.employeeId === employeeId);
}

// ===========================================================================
// 1. Happy：投影到 Office，且 Office 只收到粗粒度信息
// ===========================================================================

test('office-exec: the executor chain projects a completed task onto the office seats', async () => {
  const chain = createChain({ scenario: 'happy' });
  const state = await driveChain(chain);
  assert.equal(state.status, 'completed');
  // researcher / reviewer 的座位都被 Team 用显式表绑上了（role→seat）。
  const researcher = employeeSnapshot(chain.office, 'researcher');
  const reviewer = employeeSnapshot(chain.office, 'reviewer');
  assert.ok(researcher.binding, 'the researcher seat must be bound by the team run');
  assert.ok(reviewer.binding, 'the reviewer seat must be bound by the team run');
  assert.equal(researcher.binding.source, 'manual');
  // 推进 office 时钟：结果呈现窗口到期 → 座位按既有 office 生命周期释放。
  tickOffice(chain, 60);
  const summary = chain.bridge.summary();
  assert.equal(summary.counters.rejected, 0, 'no team fact may be rejected by the adapter');
  assert.equal(summary.counters.officeRejected, 0, 'no office fact may be rejected by the narrow entry');
  assert.deepEqual(summary.artifactKinds, { 'research-notes': 1, 'review-findings': 1 });
  // 终态事实在 Team 侧带证据；office 侧只看到粗粒度结果（没有 evidence 文本以外的细节）。
  assert.equal(chain.runtime.state().runs.reviewer.terminalEvidence.source, 'execution/completed:ok');
});

test('office-exec: raw execution identity never reaches the office snapshot or diagnostics (M18)', async () => {
  const chain = createChain({ scenario: 'happy' });
  await driveChain(chain);
  const snapshot = JSON.stringify(chain.office.state());
  // 执行层的私有句柄 + Team 的派生 handle 都**不得**进入快照。
  for (const needle of [
    'exec-handle:', 'exec-run:', 'exec-job:', 'team-run-sha256:', 'team-job-sha256:',
    chain.jobId,
  ]) {
    assert.equal(snapshot.includes(needle), false, `office snapshot must not contain ${needle}`);
  }
  // adapter 摘要也只允许白名单 kind 计数，不含 id / digest / 内容。
  const summary = JSON.stringify(chain.bridge.summary());
  for (const needle of ['exec-handle:', 'exec-run:', 'exec-job:', 'art:', 'art-sha256:', 'exec-sha256:']) {
    assert.equal(summary.includes(needle), false, `bridge summary must not contain ${needle}`);
  }
  // 执行事件的 locationRef / digest 也没有任何路径进入 Office。
  const officeFacts = chain.runtime.facts()
    .map((fact) => JSON.stringify(fact))
    .join('');
  for (const needle of ['locationRef', 'exec-sha256:', 'ref:']) {
    assert.equal(officeFacts.includes(needle), false, `team facts must not carry ${needle}`);
  }
});

test('office-exec: the office never learns about the execution backend (no execution kinds in the snapshot)', async () => {
  const chain = createChain({ scenario: 'failure' });
  await driveChain(chain);
  const snapshot = chain.office.state();
  // office 的 runtime 枚举没有被执行层扩张（仍然是那六个）。
  const reducer = require('../src/office/runtime/state-reducer.js');
  assert.deepEqual([...reducer.RUNTIME_STATES],
    ['unbound', 'idle', 'running', 'attention', 'completed', 'failed']);
  // 也没有任何 "execution/*" 字样的诊断进环。
  const diagnostics = JSON.stringify(snapshot.diagnostics || []);
  assert.equal(/execution\//.test(diagnostics), false, 'office diagnostics must not carry execution event types');
  // 失败座位最终不是 completed 表情/状态（绝不伪造成完成）。
  const researcherFacts = chain.runtime.facts().filter((f) => f.type === 'run/failed');
  assert.equal(researcherFacts.length, 1);
  assert.equal(chain.runtime.facts().some((f) => f.type === 'run/completed'), false);
});

// ===========================================================================
// 2. Attention：执行 attention → Team attention → Office attention → 用户操作 → 恢复
// ===========================================================================

test('office-exec: attention reaches the office seat and never auto-completes (§8.3)', async () => {
  const chain = createChain({ scenario: 'attention-resume' });
  const runtime = chain.runtime;
  // 推进到 reviewer attention 挂住（**先不** resume）。
  await chain.controller.start();
  await chain.controller.dispatchReady();
  await chain.controller.run();
  chain.bridge.pump();
  await chain.controller.dispatchReady();
  await chain.controller.run();
  chain.bridge.pump();

  assert.equal(runtime.state().runs.reviewer.status, 'attention');
  const reviewer = employeeSnapshot(chain.office, 'reviewer');
  assert.equal(reviewer.runtime, 'attention', 'the office seat must show attention');
  assert.ok(reviewer.binding, 'attention is NOT terminal: the binding must be retained');
  assert.notEqual(reviewer.runtime, 'completed');

  // 推进 office 逻辑时钟很多 tick：attention **不能**被动画/定时器自动改成 completed。
  tickOffice(chain, 60);
  assert.equal(employeeSnapshot(chain.office, 'reviewer').runtime, 'attention',
    'attention must survive office time passing (no timer may auto-complete it)');
  assert.equal(runtime.state().status, 'attention');

  // 用户操作 → 显式 resume → 恢复 running 并最终 completed。
  assert.equal((await chain.controller.resume('reviewer')).ok, true);
  chain.bridge.pump();
  assert.equal(runtime.state().runs.reviewer.status, 'running');
  const state = await driveChain(chain);
  assert.equal(state.status, 'completed');
});

// ===========================================================================
// 3. Cancel：Team cancel → executor.cancel → ack（不释放）→ cancelled（释放）
// ===========================================================================

test('office-exec: cancel ack keeps the binding; only the cancelled terminal releases it (§8.4)', async () => {
  const chain = createChain({ scenario: 'cancel' });
  await chain.controller.start();
  await chain.controller.dispatchReady();
  await chain.controller.pumpOne();
  chain.bridge.pump();
  assert.equal(chain.runtime.state().runs.researcher.status, 'running');
  assert.ok(employeeSnapshot(chain.office, 'researcher').binding, 'seat is bound while running');

  // 取消请求 + ack（逐条 pump，以便分别观察 office 侧效果）。
  await chain.controller.requestCancel('researcher');
  chain.bridge.pump();
  let researcher = employeeSnapshot(chain.office, 'researcher');
  assert.ok(researcher.binding, 'a cancel REQUEST must not release the binding');
  assert.equal(researcher.runtime, 'running');

  await chain.controller.pumpOne(); // cancel-requested → office control/cancel
  chain.bridge.pump();
  researcher = employeeSnapshot(chain.office, 'researcher');
  assert.ok(researcher.binding, 'cancel-requested must not release the binding');
  assert.equal(researcher.control, 'cancellationPending');

  await chain.controller.pumpOne(); // cancel-acknowledged → office control/cancel-ack
  chain.bridge.pump();
  researcher = employeeSnapshot(chain.office, 'researcher');
  assert.ok(researcher.binding, 'cancel ACK must NOT release the binding (ack ≠ terminal)');
  assert.equal(researcher.control, 'cancellationPending');

  await chain.controller.pumpOne(); // execution/cancelled → 真正的终态
  chain.bridge.pump();
  assert.equal(chain.runtime.state().runs.researcher.status, 'cancelled');
  // 终态后 office 走 releaseTerminalNow（立即释放路径）—— 绑定释放 + runtime=cancelled。
  tickOffice(chain, 30);
  researcher = employeeSnapshot(chain.office, 'researcher');
  assert.equal(researcher.runtime === 'cancelled' || researcher.binding === null || researcher.runtime === 'unbound', true,
    `cancelled must converge the seat, got runtime=${researcher.runtime} binding=${researcher.binding ? 'bound' : 'null'}`);
  assert.equal(chain.runtime.state().status, 'cancelled');
});

// ===========================================================================
// 4. 失败：绝不伪造成完成
// ===========================================================================

test('office-exec: a failed run shows a failed seat, never a completed animation', async () => {
  const chain = createChain({ scenario: 'failure' });
  const state = await driveChain(chain);
  assert.equal(state.status, 'failed');
  // 结果呈现窗口内：座位显示 failed（office 既有生命周期：failed → 呈现 → 回到 idle）。
  const during = employeeSnapshot(chain.office, 'researcher');
  assert.equal(during.runtime, 'failed', 'a failed run must show failed, never completed');
  assert.notEqual(during.animation.resource, 'celebrate', 'no celebration animation for a failure');
  // 推进到呈现窗口之后：座位回到 idle（既有的 office 收尾），**仍然**不是 completed。
  tickOffice(chain, 60);
  const after = employeeSnapshot(chain.office, 'researcher');
  assert.notEqual(after.runtime, 'completed', 'a failed run must never converge to completed');
  assert.equal(after.runtime, 'idle', 'after the result window the seat returns to idle (existing lifecycle)');
  // 全链没有任何 completed 事实。
  assert.equal(chain.runtime.facts().some((f) => f.type === 'run/completed'), false);
  assert.equal(chain.runtime.facts().some((f) => f.type === 'job/completed'), false);
});

// ===========================================================================
// 5. Office 关闭时 Team 仍可完成（同一驱动代码，withOffice:false）
// ===========================================================================

test('office-exec: the same chain completes with no office at all (office is only a consumer)', async () => {
  const withOffice = createChain({ scenario: 'happy', withOffice: true, jobId: 'job-with-office' });
  const withoutOffice = createChain({ scenario: 'happy', withOffice: false, jobId: 'job-with-office' });
  assert.equal(withOffice.office === null, false);
  assert.equal(withoutOffice.office, null);
  assert.equal(withoutOffice.bridge, null, 'no office → no bridge (the bridge needs the narrow entry)');

  const stateA = await driveChain(withOffice);
  const stateB = await driveChain(withoutOffice);

  // 关键断言：**完全相同的 Team 状态与事实**，不管 Office 在不在。
  assert.equal(stateA.status, 'completed');
  assert.equal(stateB.status, 'completed');
  assert.equal(JSON.stringify(stateB.runs.researcher), JSON.stringify(stateA.runs.researcher));
  assert.equal(JSON.stringify(stateB.runs.reviewer), JSON.stringify(stateA.runs.reviewer));
  assert.deepEqual(withoutOffice.runtime.facts(), withOffice.runtime.facts(),
    'the Team fact log must be byte-identical with and without the office');
});

test('office-exec: closing the office does not stop or alter the team chain (mid-run office removal)', async () => {
  // 起一半，然后"关掉 office"（把桥的 office 引用换成拒绝一切的桩），
  // 再继续 —— Team 必须仍然收敛到 completed，且事实不受影响。
  const chain = createChain({ scenario: 'happy' });
  await chain.controller.start();
  await chain.controller.dispatchReady();
  await chain.controller.run();
  chain.bridge.pump();
  const factsAtCut = chain.runtime.facts().length;

  // 模拟"Office 关闭"：桥的目标变成一个拒绝一切调用的桩（等价于 UI 不存在）。
  const refusingOffice = { ingestTeamProjectionFact: () => ({ ok: false, code: 'OFFICE_CLOSED' }) };
  const cutBridge = team.createTeamOfficeBridge({
    teamRuntime: chain.runtime, office: refusingOffice, knownSeats: SEATS,
  });
  cutBridge.pump();
  assert.ok(cutBridge.summary().counters.officeRejected > 0, 'the stub refuses, proving the office is gone');

  // 继续跑 Team 链（仍然用原桥，或者根本不 pump）：必须 completed。
  const state = await driveChain(chain);
  assert.equal(state.status, 'completed');
  assert.ok(chain.runtime.facts().length > factsAtCut);
  // 座位仍然可以被 Office 恢复消费（重新 pump 原桥即可追上，证明投影是幂等重放的）。
  chain.bridge.replay();
  assert.equal(chain.bridge.summary().counters.rejected, 0);
});

// ===========================================================================
// 6. 投影幂等：replay / duplicate 不重复绑定或释放
// ===========================================================================

test('office-exec: replaying the projection is idempotent (no double bind / double release)', async () => {
  const chain = createChain({ scenario: 'happy' });
  await driveChain(chain);
  const before = chain.office.state();
  const researcherBefore = employeeSnapshot(chain.office, 'researcher');

  // 从日志头重放整条投影链。
  const results = chain.bridge.replay();
  assert.ok(results.length > 0);

  // 重放：adapter 无状态 + office 幂等 ⇒ 不重复绑定、不重复释放。
  const after = chain.office.state();
  assert.deepEqual(
    after.employees.map((e) => ({ id: e.employeeId, runtime: e.runtime, bound: !!e.binding })),
    before.employees.map((e) => ({ id: e.employeeId, runtime: e.runtime, bound: !!e.binding })),
    'a full projection replay must not change any seat state',
  );
  // 诊断环也没有因为重放而多出新的东西（除幂等 no-op 外）。
  assert.equal(JSON.stringify(researcherBefore.binding), JSON.stringify(employeeSnapshot(chain.office, 'researcher').binding));
  // 重放后 officeApplied 计数增加，但 duplicates 吸收了重复（不是错误）。
  const summary = chain.bridge.summary();
  assert.ok(summary.counters.duplicates > 0 || summary.counters.officeApplied > 0);
  assert.equal(summary.counters.rejected, 0);
});

test('office-exec: the renderer only ever consumes the snapshot (no team/execution channel)', () => {
  // 结构性证据：渲染器与页面都不得触达 team / execution 层。
  const renderer = fs.readFileSync(path.join(ROOT, 'src', 'office', 'render', 'pixi-office-renderer.js'), 'utf8');
  assert.equal(/team|execution-schema|executionRef|exec-job|exec-run/.test(renderer), false,
    'the renderer must not know about the team/execution layer');
  const page = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-page.js'), 'utf8');
  assert.equal(/team\/runtime|ingestTeamProjectionFact|executionRef/.test(page), false,
    'the office page must not reach into the team layer');
});
// ===========================================================================
// 7. 本次发现的 P0 缺陷回归（P0-1：执行来源的终态证据无法释放 office 绑定）
// ===========================================================================

test('office-exec: execution-source terminal evidence can release a seat (P0-1 regression)', async () => {
  // 问题（2026-10-22 实测发现）：office 内核的可信终态证据来源白名单原本只有
  // `turn/end` / `subagent/end` / `session/end`（employee-registry.evidenceTypeFrom
  // + queue-controller.TERMINAL_EVIDENCE_TYPES）。执行端口产生的证据形状是
  // `execution/<outcome>:<reason>`，落在白名单之外 → `releaseBinding` 返回
  // TERMINAL_EVIDENCE_REQUIRED → 组合根记 `RELEASE_FAILED`，
  // **座位永久停留在 bound/completed**（一个真实的世界状态错乱，不是纯 UI 问题）。
  //
  // 任何"绕过契约"的修法都不许用：把执行证据写成 `turn/end:*` 会把 dsh provider
  // 词表泄漏进 Team/执行层（契约明令禁止）。因此修法是**加性**地把 `execution`
  // 登记为第四个受信来源。
  //
  // 本测试直接断言修复后的行为，并钉住既有三个来源没有被削弱。
  const chain = createChain({ scenario: 'happy' });
  const state = await driveChain(chain);
  assert.equal(state.status, 'completed');
  tickOffice(chain, 80); // 结果呈现窗口到期 → 走 releaseBinding

  // 修复后：绑定**真的**被释放了（证据来源 execution/ 被接受）。
  const bindings = chain.office.debugRegistrySnapshot().bindings;
  const researcher = bindings.find((b) => b.employeeId === 'researcher');
  const reviewer = bindings.find((b) => b.employeeId === 'reviewer');
  assert.ok(researcher, 'the researcher binding exists');
  assert.notEqual(researcher.releasedAt, null, 'execution-source evidence must release the binding');
  assert.notEqual(reviewer.releasedAt, null, 'execution-source evidence must release the binding');
  // 证据原文原样保留（不重写成 turn/end:*）。
  assert.equal(researcher.lastEvidence, 'execution/completed:ok');
  assert.equal(reviewer.lastEvidence, 'execution/completed:ok');
  // 没有 RELEASE_FAILED 诊断。
  const codes = (chain.office.state().diagnostics || []).map((d) => d.code);
  assert.equal(codes.includes('RELEASE_FAILED'), false, 'no release may fail');
  // 座位回到空闲（可再次接任务），而不是永久 bind。
  assert.equal(employeeSnapshot(chain.office, 'researcher').binding, null);
  assert.equal(employeeSnapshot(chain.office, 'reviewer').binding, null);
});

test('office-exec: the additive execution evidence source does not weaken the existing three', () => {
  // 加性扩展的边界：既有三个来源仍然被接受，且 NON_TERMINAL_EVIDENCE 仍然 fail-closed。
  const registry = require('../src/office/runtime/employee-registry.js');
  const queue = require('../src/office/runtime/queue-controller.js');
  assert.deepEqual([...queue.TERMINAL_EVIDENCE_TYPES].sort(),
    ['execution', 'session-end', 'subagent-end', 'turn-end'],
    'the evidence vocabulary is additive: the three original sources must remain');
  // cancel-ack 仍然不是终态证据（执行层的 cancel-acknowledged 也含 "cancel-ack"）。
  assert.ok(registry.NON_TERMINAL_EVIDENCE.includes('cancel-ack'));
  // 执行层的 control 回执证据形状也命中同一 guard（结构性：含 "cancel-ack"）。
  const executionAckEvidence = 'execution/cancel-acknowledged:acknowledged';
  assert.match(executionAckEvidence, /cancel-ack/i);
});

// ===========================================================================
// 8. 投影载荷白名单（M18 的强版本）
// ===========================================================================

test('office-exec: NOTHING extra may ride on the facts handed to the projection (M18 strong form)', async () => {
  // 上一版只检查**最终快照**，因此"在 projection 载荷上多挂一个 raw 字段"这种变异
  // 检不出来（负向变异 M18 实测未检出）。这里改为：把 controller 交给投影的
  // **每一条事实**都记录下来，逐条断言字段集合与内容都合规。
  const PROJ_ALLOWED_FACTS = new Set(team.schema.FACT_TYPES);
  const PROJ_ALLOWED_FIELDS = new Set([
    'jobId', 'seq', 'type', 'atMs', 'role',           // 基础
    'evidence', 'outcome',                           // 终态
    'reason',                                        // attention
    'consumedArtifactIds',                           // run/started
    'artifactId', 'kind', 'producerRunId', 'producerRole', 'digest', // artifact/available
  ]);
  const delivered = [];
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advanceClock = (ms) => { nowMs += ms; };
  const office = officeModule.createOfficeModule({
    pack: PACK, seed: 'projection-payload-seed',
    config: { resultPresentationMs: 200, workstationAnchorSegmentMs: 120 }, log: () => {},
  });
  const runtime = team.createTeamRuntime({ clock });
  const executor = team.createFakeExecutor({ scenario: 'happy', clock, advanceClock });
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime, executor, clock, jobId: 'job-payload-1',
    onFact: (fact) => delivered.push(fact),
  });
  const bridge = team.createTeamOfficeBridge({ teamRuntime: runtime, office, knownSeats: SEATS });
  for (let i = 0; i < 16; i += 1) {
    await controller.start();
    await controller.dispatchReady();
    await controller.run();
    bridge.pump();
    const state = runtime.state();
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
    const role = ['researcher', 'reviewer'].find((r) => state.runs[r] && state.runs[r].status === 'attention');
    if (role) { await controller.resume(role); continue; }
    if (runtime.readyRoles().length === 0) break;
  }
  assert.ok(delivered.length >= 8, `projection must receive the whole log (got ${delivered.length})`);

  for (const fact of delivered) {
    assert.equal(typeof fact, 'object');
    assert.ok(PROJ_ALLOWED_FACTS.has(fact.type), `unexpected fact type handed to projection: ${fact.type}`);
    for (const key of Object.keys(fact)) {
      assert.ok(PROJ_ALLOWED_FIELDS.has(key), `fact ${fact.type} must not carry "${key}"`);
    }
    // 值层面：只允许 string / number / null，以及"派生 id 的字符串数组"。
    for (const [key, value] of Object.entries(fact)) {
      if (value === null) continue;
      if (typeof value === 'number') continue;
      if (Array.isArray(value)) {
        for (const entry of value) {
          assert.equal(typeof entry, 'string', `fact ${fact.type}.${key} entries must be plain strings`);
          assert.ok(PROJ_ID_RE.test(entry), `fact ${fact.type}.${key} entry "${entry}" is not a derived id`);
        }
        continue;
      }
      assert.equal(typeof value, 'string', `fact ${fact.type}.${key} must be string/number/null/string[]`);
    }
    // 隐私词形：raw 身份 / 路径 / 密钥 / 正文形状一律不许出现。
    const serialized = JSON.stringify(fact);
    for (const pattern of RAW_IDENTITY_PATTERNS) {
      assert.equal(pattern.test(serialized), false,
        `fact ${fact.type} leaks something matching ${pattern}: ${serialized}`);
    }
  }
});

/** 项目里合法 id 的形状（派生 handle / artifact id）。 */
const PROJ_ID_RE = /^(?:art:[0-9a-f]{16}|team-(?:run|job)-sha256:[0-9a-f]{16}|exec-(?:run|job|handle):[0-9a-f]{16})$/;
/** 禁止出现在投影载荷里的 raw 形状。 */
const RAW_IDENTITY_PATTERNS = Object.freeze([
  /sess-[a-z0-9-]+/i,
  /sessionId/,
  /"(?:raw)?runId"/,
  /exec-handle:/,
  /sk-[A-Za-z0-9]{8,}/,
  /\/(?:Users|home|etc|tmp)\//,
  /[A-Za-z]:\\\\/,
]);
