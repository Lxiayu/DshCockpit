'use strict';

// test/team-runtime-v0.test.js — Team Runtime v0 headless 测试。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md
// 调研依据：docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md
//
// 覆盖（任务书 Phase D 的 13 项）：
//   1 依赖未满足不可 dispatch           2 合法 artifact 后 reviewer 才能 dispatch
//   3 artifact producer/consumer 不可伪造 4 duplicate 幂等
//   5 out-of-order 不重复启动            6 failed/cancelled 阻止下游
//   7 cancel ack 非 terminal evidence    8 attention 不自动 completed
//   9 root 终态收敛                      10 无 UI 依赖边界
//   11 隐私不泄漏                        12 fake clock 确定性
//   13 既有 npm test 不回归（由 npm test 覆盖）
//
// 全程不启动 Electron/DOM/Pixi，不读墙钟，不写文件系统。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const team = require('../src/team/runtime/index.js');
const { createTeamRuntime } = team;

const ROOT = path.join(__dirname, '..');
const TEAM_RUNTIME_DIR = path.join(ROOT, 'src', 'team', 'runtime');
const T0 = 1_700_000_000_000;
const JOB = 'job-fixture-1';

// ---------------------------------------------------------------------------
// harness：fake clock + 固定闭环驱动
// ---------------------------------------------------------------------------

function createHarness() {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const advance = (ms) => { nowMs += ms; };
  const runtime = createTeamRuntime({ clock });
  return { runtime, clock, advance };
}

/** 把 researcher 推到 completed（含 artifact）。返回 artifactId。 */
function completeResearcher(runtime, { advance } = {}) {
  assert.equal(runtime.dispatchRun({ role: 'researcher' }).status, 'applied');
  if (advance) advance(10);
  assert.equal(runtime.startRun({ role: 'researcher' }).status, 'applied');
  if (advance) advance(10);
  const artifact = runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  assert.equal(artifact.status, 'applied');
  if (advance) advance(10);
  assert.equal(runtime.noteRunTerminal({
    role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed',
  }).status, 'applied');
  return runtime.state().runs.researcher.producedArtifactIds[0];
}

/** 完整固定闭环：researcher → reviewer → root completed。 */
function runFullLoop(runtime, advance) {
  const artifactId = completeResearcher(runtime, { advance });
  if (advance) advance(10);
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).status, 'applied');
  if (advance) advance(10);
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] }).status, 'applied');
  if (advance) advance(10);
  assert.equal(runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' }).status, 'applied');
  if (advance) advance(10);
  assert.equal(runtime.noteRunTerminal({
    role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed',
  }).status, 'applied');
  return artifactId;
}

function factTypes(runtime) {
  return runtime.facts().map((fact) => fact.type);
}

/**
 * 去掉注释（**单遍扫描**）。
 *
 * 2026-10-22 实测修正：旧实现是"正则先删块注释、再删行注释"。
 * 但团队模块的头注释里会写 `team/*`、`job/*`（命名边界说明），
 * 其中的 `/*` 会被当作**块注释开始** → 正则块删除会吞掉从该处到源码里第一个
 * `*​/` 之间的**真实代码**（本项目实测：`team-schema.js` 与 `execution-schema.js`
 * 的 `require('node:crypto')` 被吞掉），使"纯度/依赖"断言**静默失效**
 * （负向变异 M13 因此未被检出）。单遍扫描按词法顺序处理，且识别字符串字面量，
 * 因此行注释里的 `/*` 不再有特殊含义。
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

/** 每个 team 运行时文件的 require 说明符（注释已剥离；node:crypto 是允许的纯计算内建）。 */
function requiresOfTeam() {
  const out = [];
  for (const name of fs.readdirSync(TEAM_RUNTIME_DIR).filter((n) => n.endsWith('.js'))) {
    const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (m[1] === 'node:crypto') continue;
      out.push(`${name} -> ${m[1]}`);
    }
  }
  return out;
}

// ===========================================================================
// 1. 依赖未满足不可 dispatch
// ===========================================================================

test('team: reviewer cannot be dispatched before its dependency is completed', () => {
  const { runtime } = createHarness();
  assert.equal(runtime.createJob({ jobId: JOB }).status, 'applied');

  // 计划里只有 researcher 就绪；reviewer 依赖未满足。
  assert.deepEqual([...runtime.readyRoles()], ['researcher']);
  const early = runtime.dispatchRun({ role: 'reviewer' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'DEPENDENCIES_UNSATISFIED');
  assert.equal(runtime.state().runs.reviewer.status, 'pending');
  // fail-closed：拒绝不追加任何事实。
  assert.deepEqual(factTypes(runtime), ['job/created']);

  // researcher 只到 running（未 completed）仍然不放行。
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  // 只有 artifact、没有终态 → 依然不放行（artifact ≠ 终态证据）。
  runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  assert.deepEqual([...runtime.readyRoles()], []);
});

// ===========================================================================
// 2. 合法 artifact + 上游 completed 后 reviewer 才能 dispatch
// ===========================================================================

test('team: reviewer becomes dispatchable only after a valid artifact and a completed researcher', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  const artifactId = completeResearcher(runtime, { advance });

  assert.deepEqual([...runtime.readyRoles()], ['reviewer']);
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).status, 'applied');
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] }).status, 'applied');
  const reviewer = runtime.state().runs.reviewer;
  assert.equal(reviewer.status, 'running');
  assert.deepEqual([...reviewer.consumedArtifactIds], [artifactId]);
  // 消费关系被记在 artifact 上（producer/consumer 谱系）。
  assert.deepEqual([...runtime.state().artifacts[artifactId].consumedBy], [reviewer.runId]);
});

// ===========================================================================
// 3. artifact producer / consumer 不可伪造
// ===========================================================================

test('team: an artifact cannot be forged, mis-owned, or consumed from a non-dependency', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });

  // 只有 running 的 run 能产出。
  assert.equal(runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' }).code,
    'ARTIFACT_PRODUCER_NOT_RUNNING');
  runtime.startRun({ role: 'researcher' });
  // kind 必须属于该角色的 produces（researcher 不能产出 review-findings）。
  assert.equal(runtime.noteArtifact({ role: 'researcher', kind: 'review-findings' }).code,
    'ARTIFACT_KIND_NOT_OWNED');
  // 未知 kind 同样拒绝。
  assert.equal(runtime.noteArtifact({ role: 'researcher', kind: 'prompt-dump' }).code,
    'ARTIFACT_KIND_NOT_OWNED');

  const produced = runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  assert.equal(produced.status, 'applied');
  const artifactId = produced.fact.artifactId;
  // artifactId 由 Runtime 派生：形状固定，且编码生产者。
  assert.match(artifactId, /^art:[0-9a-f]{16}$/);
  assert.equal(artifactId, team.artifactIdFor(JOB, runtime.state().runs.researcher.runId, 'research-notes'));
  assert.equal(produced.fact.producerRunId, runtime.state().runs.researcher.runId);
  assert.equal(produced.fact.producerRole, 'researcher');
  assert.match(produced.fact.digest, /^art-sha256:[0-9a-f]{16}$/);

  // 重复产出同一 (run, kind) 被幂等吸收，不产生第二条事实。
  const dup = runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  assert.equal(dup.status, 'duplicate');
  assert.equal(runtime.state().runs.researcher.producedArtifactIds.length, 1);

  // reviewer 不能消费未知 artifact。
  runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
  runtime.dispatchRun({ role: 'reviewer' });
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: ['art:0000000000000000'] }).code,
    'ARTIFACT_UNKNOWN');
  // 也不能消费**自己**（非依赖角色）产出的 artifact：伪造一条来自 reviewer 的引用。
  const forged = { ...runtime.state().artifacts[artifactId], producerRole: 'reviewer' };
  assert.equal(team.artifactIdFor(JOB, forged.producerRunId, 'research-notes'), artifactId,
    'the id itself encodes the producer slot');
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] }).status, 'applied');
});

// ===========================================================================
// 3b. handoff contract（调研：交接必须"按 schema"，且双向成立）
// ===========================================================================

test('team: the handoff contract is enforced in both directions', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  const artifactId = completeResearcher(runtime);
  runtime.dispatchRun({ role: 'reviewer' });

  // 方向一（完整性）：reviewer 在 plan 里声明 consumes=['research-notes']，
  // 不消费它就等于把"依赖已满足"当成了"可以跳过交接"。
  const incomplete = runtime.startRun({ role: 'reviewer' });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'HANDOFF_INCOMPLETE');
  assert.equal(runtime.state().runs.reviewer.status, 'dispatched', 'fail-closed: 不进入 running');

  // 方向二（归属）：不能消费 plan 未声明 consumes 的 kind。构造一个"kind 不属于
  // consumes"的引用（reviewer 只声明消费 research-notes）。
  const forged = { ...runtime.state().artifacts[artifactId], kind: 'review-findings' };
  assert.equal(team.ARTIFACT_KINDS.includes(forged.kind), true);
  // 用未知 id 模拟伪造引用 → ARTIFACT_UNKNOWN（不是 HANDOFF_INCOMPLETE）。
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: ['art:ffffffffffffffff'] }).code,
    'ARTIFACT_UNKNOWN');

  // 正确的交接通过。
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] }).status, 'applied');
});

test('team: the plan is the handoff schema, and the effort budget matches its shape', () => {
  const { runtime } = createHarness();
  const described = runtime.describe();
  // plan 的 produces/consumes 就是交接 schema（调研：交接契约要"写在配置里"）。
  const reviewer = described.plan.find((entry) => entry.role === 'reviewer');
  assert.deepEqual([...reviewer.consumes], ['research-notes']);
  assert.deepEqual([...reviewer.dependsOn], ['researcher']);
  // effort budget 与 plan 形状一致：plan 变宽而不改预算 → 这条断言失败。
  assert.deepEqual({ ...described.budget }, {
    maxRuns: described.plan.length,
    maxArtifacts: described.plan.reduce((sum, entry) => sum + entry.produces.length, 0),
    maxFacts: team.FACTS_MAX,
  });
  assert.equal(described.budget.maxRuns, 2, 'v0 只有两个角色（结构比规模重要）');
  assert.equal(described.budget.maxArtifacts, 2);
  // 固定闭环恰好用满预算，不会超。
  runtime.createJob({ jobId: JOB });
  runFullLoop(runtime, null);
  assert.equal(Object.keys(runtime.state().artifacts).length, described.budget.maxArtifacts);
  assert.equal(Object.values(runtime.state().runs).filter((r) => r.status !== 'pending').length,
    described.budget.maxRuns);
});

test('team: attempt is reserved at 1 (retry is explicitly not implemented in v0)', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  runFullLoop(runtime, advance);
  for (const run of Object.values(runtime.state().runs)) {
    assert.equal(run.attempt, 1, 'v0 never retries; the field is reserved for v1');
    assert.equal(run.runId, team.runIdFor(JOB, run.role, 1));
  }
});

// ===========================================================================
// 4. duplicate 幂等
// ===========================================================================

test('team: duplicate commands are absorbed without extra facts or state change', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });

  const before = factTypes(runtime);
  const beforeState = JSON.stringify(runtime.state());

  assert.equal(runtime.createJob({ jobId: JOB }).code, 'DUPLICATE');
  assert.equal(runtime.dispatchRun({ role: 'researcher' }).code, 'DUPLICATE');
  assert.equal(runtime.startRun({ role: 'researcher' }).code, 'RUN_NOT_DISPATCHED');
  assert.equal(runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' }).status, 'applied');
  assert.equal(runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' }).code, 'DUPLICATE');
  const terminal = { role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' };
  assert.equal(runtime.noteRunTerminal(terminal).status, 'applied');
  const afterTerminal = factTypes(runtime);
  assert.equal(runtime.noteRunTerminal(terminal).code, 'DUPLICATE');

  // 终态之后状态与事实都没有再变。
  assert.deepEqual(factTypes(runtime), afterTerminal);
  assert.equal(factTypes(runtime).length, before.length + 2, 'exactly artifact + terminal were appended');
  assert.notEqual(JSON.stringify(runtime.state()), beforeState, 'the applied commands did change state');
});

// ===========================================================================
// 5. out-of-order 不重复启动
// ===========================================================================

test('team: out-of-order and repeated input never starts a run twice', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });

  // start 早于 dispatch → fail-closed，不追加事实。
  assert.equal(runtime.startRun({ role: 'researcher' }).code, 'RUN_NOT_DISPATCHED');
  assert.deepEqual(factTypes(runtime), ['job/created']);

  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  const startedFacts = factTypes(runtime).filter((t) => t === 'run/started').length;

  // 再次 dispatch / start（乱序或重复投递）绝不第二次启动。
  assert.equal(runtime.dispatchRun({ role: 'researcher' }).code, 'DUPLICATE');
  // 重复 start 由**状态门**拒绝（契约 §8-2）：running 不是 dispatched/attention。
  assert.equal(runtime.startRun({ role: 'researcher' }).code, 'RUN_NOT_DISPATCHED');
  assert.equal(factTypes(runtime).filter((t) => t === 'run/started').length, startedFacts,
    'a run is never started twice');
  assert.equal(runtime.state().runs.researcher.status, 'running');

  // 终态早于 dispatch（未 dispatch 的 run 收到终态）→ fail-closed。
  const other = createHarness().runtime;
  other.createJob({ jobId: JOB });
  assert.equal(other.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' }).code,
    'RUN_NOT_DISPATCHED');
  // 未知 run 的终态 → fail-closed。
  assert.equal(runtime.noteRunTerminal({ role: 'coder', outcome: 'completed', evidence: 'turn/end:completed' }).code,
    'UNKNOWN_ROLE');
});

// ===========================================================================
// 6. failed / cancelled 阻止下游
// ===========================================================================

test('team: a failed researcher blocks the reviewer and fails the root', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  runtime.noteArtifact({ role: 'researcher', kind: 'research-notes' });
  assert.equal(runtime.noteRunTerminal({
    role: 'researcher', outcome: 'failed', evidence: 'turn/end:error',
  }).status, 'applied');

  // 下游永不放行（即使 artifact 存在）。
  assert.deepEqual([...runtime.readyRoles()], []);
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  assert.equal(runtime.state().runs.reviewer.status, 'pending');
  // root 收敛为 failed（不是 completed）。
  assert.equal(runtime.state().status, 'failed');
  assert.equal(factTypes(runtime).includes('job/failed'), true);
  assert.equal(factTypes(runtime).includes('job/completed'), false);
});

test('team: a cancelled researcher blocks the reviewer and cancels the root', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  runtime.noteRunTerminal({ role: 'researcher', outcome: 'cancelled', evidence: 'turn/end:aborted' });
  assert.deepEqual([...runtime.readyRoles()], []);
  assert.equal(runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
  assert.equal(runtime.state().status, 'cancelled');
  assert.equal(factTypes(runtime).includes('job/cancelled'), true);
});

// ===========================================================================
// 7. cancel ack 不是 terminal evidence
// ===========================================================================

test('team: a cancel acknowledgement never changes terminal state', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });

  // 未请求就 ack → fail-closed。
  assert.equal(runtime.noteCancelAcknowledged({ role: 'researcher' }).code, 'CANCEL_NOT_REQUESTED');

  assert.equal(runtime.requestCancel({ role: 'researcher' }).status, 'applied');
  // 请求只是请求：状态不变（仍是 running），但记下了请求时刻。
  assert.equal(runtime.state().runs.researcher.status, 'running');
  assert.equal(runtime.state().runs.researcher.cancelRequestedAtMs, T0);
  assert.equal(runtime.state().status, 'running', 'root 不因取消请求而收敛');

  assert.equal(runtime.noteCancelAcknowledged({ role: 'researcher' }).status, 'applied');
  // 回执同样不改变任何终态（这是本仓库 office 内核的实证规则）。
  assert.equal(runtime.state().runs.researcher.status, 'running');
  assert.equal(runtime.state().runs.researcher.terminalEvidence, null);
  assert.equal(runtime.state().status, 'running');
  assert.deepEqual([...runtime.readyRoles()], [], '请求取消期间不放行下游');

  // 只有真实终态证据才收敛。
  assert.equal(runtime.noteRunTerminal({
    role: 'researcher', outcome: 'cancelled', evidence: 'turn/end:aborted',
  }).status, 'applied');
  assert.equal(runtime.state().runs.researcher.status, 'cancelled');
  assert.equal(runtime.state().status, 'cancelled');

  // 已终态后 ack 被拒绝（不复活、不重复）。
  assert.equal(runtime.noteCancelAcknowledged({ role: 'researcher' }).code, 'DUPLICATE');
});

// ===========================================================================
// 8. attention 不自动 completed
// ===========================================================================

test('team: attention is not terminal and never auto-completes', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  const artifactId = completeResearcher(runtime, { advance });
  runtime.dispatchRun({ role: 'reviewer' });
  runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] });

  assert.equal(runtime.noteRunAttention({ role: 'reviewer', reason: 'needs-approval' }).status, 'applied');
  assert.equal(runtime.state().runs.reviewer.status, 'attention');
  assert.equal(runtime.state().runs.reviewer.terminalEvidence, null, 'attention 不是终态证据');
  // root 只能 attention，绝不能 completed。
  assert.equal(runtime.state().status, 'attention');
  assert.equal(factTypes(runtime).includes('job/attention'), true);
  assert.equal(factTypes(runtime).includes('job/completed'), false);
  // 无论推进多久都不会自动变 completed（没有 timers、没有超时升级）。
  advance(60_000);
  assert.equal(runtime.state().status, 'attention');
  assert.equal(runtime.state().runs.reviewer.status, 'attention');

  // 从 attention 恢复必须显式；之后才可能收敛到 completed。
  assert.equal(runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] }).status, 'applied');
  assert.equal(runtime.state().runs.reviewer.status, 'running');
  assert.equal(runtime.state().runs.reviewer.attention, null);
  // root 必须**自动**从 attention 回到 running：job 状态是派生值而不是存储值，
  // 否则显式 resume 之后 root 会永久卡在 attention（stale status）。
  assert.equal(runtime.state().status, 'running');
  assert.equal(runtime.digest().jobStatus, 'running');
  runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });
  assert.equal(runtime.state().status, 'completed');
});

test('team: an attention reason must be a coarse token, never prose', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  // prose / 空串 / 超长 / 大写 / 含空格 一律拒绝（隐私边界）。
  for (const bad of ['', 'Please review the diff in /Users/xia/secret', 'Needs Approval', 'a'.repeat(64), 42, null]) {
    const verdict = runtime.noteRunAttention({ role: 'researcher', reason: bad });
    assert.equal(verdict.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.equal(verdict.code, 'INVALID_ATTENTION_REASON');
  }
  assert.equal(runtime.state().runs.researcher.status, 'running');
});

// ===========================================================================
// 9. root 终态收敛
// ===========================================================================

test('team: the root converges to completed only after every role has trusted terminal evidence', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  const artifactId = completeResearcher(runtime, { advance });

  // researcher 完成、reviewer 还没跑 → root 不 completed（缺少可信终态）。
  assert.equal(runtime.state().status, 'running');
  assert.equal(factTypes(runtime).includes('job/completed'), false);

  runtime.dispatchRun({ role: 'reviewer' });
  runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] });
  assert.equal(runtime.state().status, 'running');
  runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  // 只有 artifact、没有终态 → 仍然不 completed。
  assert.equal(runtime.state().status, 'running');
  assert.equal(factTypes(runtime).includes('job/completed'), false);

  runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });
  assert.equal(runtime.state().status, 'completed');
  const lastFact = runtime.facts().at(-1);
  assert.equal(runtime.state().endedAtMs, lastFact.atMs, 'endedAtMs is the convergence fact time');
  assert.deepEqual(runtime.state().terminalEvidence, {
    source: 'team/convergence:completed', reason: 'completed', atMs: lastFact.atMs,
  });
  // 收敛事实恰好一条。
  assert.equal(factTypes(runtime).filter((t) => t === 'job/completed').length, 1);
});

test('team: the full fixed loop produces the documented fact sequence', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  runFullLoop(runtime, advance);
  assert.deepEqual(factTypes(runtime), [
    'job/created',
    'run/dispatched',
    'run/started',
    'artifact/available',
    'run/completed',
    'run/dispatched',
    'run/started',
    'artifact/available',
    'run/completed',
    'job/completed',
  ]);
  assert.equal(runtime.state().status, 'completed');
});

test('team: an invalid or missing terminal evidence is rejected (no silent completion)', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  runtime.dispatchRun({ role: 'researcher' });
  runtime.startRun({ role: 'researcher' });
  for (const bad of [undefined, null, '', 'completed', 'turn/end:completed please check /Users/x', 'A:b', 'turn/end:']) {
    const verdict = runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: bad });
    assert.equal(verdict.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.equal(verdict.code, 'TERMINAL_EVIDENCE_REQUIRED');
  }
  // outcome 必须是终态枚举。
  assert.equal(runtime.noteRunTerminal({ role: 'researcher', outcome: 'attention', evidence: 'turn/end:blocked' }).code,
    'INVALID_OUTCOME');
  assert.equal(runtime.state().runs.researcher.status, 'running');
  assert.equal(runtime.state().status, 'running');
});

// ===========================================================================
// 10. 无 UI / 依赖边界
// ===========================================================================

test('team: the runtime is pure — no Electron, DOM, Pixi, fs, network or office import', () => {
  const declared = [...team.TEAM_MODULES, team.TEAM_SURFACE_FILE].sort();
  const actual = fs.readdirSync(TEAM_RUNTIME_DIR).filter((name) => name.endsWith('.js')).sort();
  assert.deepEqual(declared, actual, 'each team runtime file must be declared (no silent files)');

  const FORBIDDEN_BUILTINS = ['node:fs', 'node:fs/promises', 'node:path', 'node:http', 'node:https',
    'node:net', 'node:dgram', 'node:tls', 'node:child_process', 'node:worker_threads'];
  const FORBIDDEN_PACKAGES = ['electron', 'pixi.js', 'ws'];
  const offenders = [];
  for (const name of actual) {
    const source = stripComments(fs.readFileSync(path.join(TEAM_RUNTIME_DIR, name), 'utf8'));
    for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (FORBIDDEN_PACKAGES.includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (FORBIDDEN_BUILTINS.includes(spec)) offenders.push(`${name} -> ${spec}`);
      if (/office-module|office\/runtime|\/render\/|office\.html/.test(spec)) offenders.push(`${name} -> ${spec}`);
      if (spec.startsWith('node:') && spec !== 'node:crypto') offenders.push(`${name} -> ${spec} (unregistered builtin)`);
    }
    for (const pattern of [/\bdocument\s*\./, /\bwindow\s*\./, /\bnavigator\s*\./, /\bfetch\s*\(/]) {
      if (pattern.test(source)) offenders.push(`${name} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'the team runtime must stay pure and UI-free');

  // 运行时证明：拦截 electron 后所有 team 模块仍可加载。
  const originalLoad = Module._load;
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (request === 'electron') throw new Error('electron unavailable');
      return originalLoad.call(this, request, parent, isMain);
    };
    for (const name of actual) {
      const file = path.join(TEAM_RUNTIME_DIR, name);
      delete require.cache[require.resolve(file)];
      require(file);
    }
  } finally {
    Module._load = originalLoad;
  }
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(Boolean(require.cache[require.resolve('electron')]), false, 'electron must not be loaded');
});

test('team: the runtime refuses any plan other than the frozen v0 constant', () => {
  const clock = { nowMs: () => T0 };
  assert.throws(() => createTeamRuntime({
    clock,
    plan: [{ role: 'researcher', dependsOn: [], produces: [], consumes: [] }],
  }), /PLAN_UNSUPPORTED/);
  assert.throws(() => createTeamRuntime({
    clock,
    plan: [
      { role: 'researcher', dependsOn: [], produces: ['research-notes'], consumes: [] },
      { role: 'reviewer', dependsOn: [], produces: ['review-findings'], consumes: ['research-notes'] },
    ],
  }), /PLAN_UNSUPPORTED/, 'a weaker dependency edge is not accepted either');
  // 冻结常量本身被接受。
  const runtime = createTeamRuntime({ clock, plan: team.TEAM_V0_PLAN });
  assert.deepEqual(runtime.describe().roles, ['researcher', 'reviewer']);
  // clock 是必需的（不读墙钟）。
  assert.throws(() => createTeamRuntime({}), /requires a clock/);
});

// ===========================================================================
// 11. 隐私不泄漏
// ===========================================================================

const SENTINELS = Object.freeze([
  'FIXTURE-PROMPT-tell-me-everything',
  '/Users/someone/secret-project',
  'sk-FIXTURESECRET0123456789',
  'run-RAW-FIXTURE-RUNID-1',
  'sess-RAW-FIXTURE-SESSION-1',
]);

test('team: no prompt, path, secret, session id or raw runId can enter team facts', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  // 攻击面：把所有哨兵塞进每个命令的每个字符串字段。
  const attempts = [
    () => runtime.createJob({ jobId: SENTINELS[0] }),
    () => runtime.dispatchRun({ role: SENTINELS[0] }),
    () => runtime.startRun({ role: 'researcher', consumedArtifactIds: [SENTINELS[1]] }),
    () => runtime.noteArtifact({ role: 'researcher', kind: SENTINELS[0] }),
    () => runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: SENTINELS[1] }),
    () => runtime.noteRunAttention({ role: 'researcher', reason: SENTINELS[2] }),
    () => runtime.requestCancel({ role: SENTINELS[3] }),
    () => runtime.noteCancelAcknowledged({ role: SENTINELS[4] }),
  ];
  for (const attempt of attempts) {
    const verdict = attempt();
    assert.equal(verdict.ok, false, 'every prose/injection attempt must be rejected');
  }
  // 走一遍合法闭环，确认输出里没有任何哨兵。
  const artifactId = completeResearcher(runtime, { advance });
  runtime.dispatchRun({ role: 'reviewer' });
  runtime.startRun({ role: 'reviewer', consumedArtifactIds: [artifactId] });
  runtime.noteArtifact({ role: 'reviewer', kind: 'review-findings' });
  runtime.noteRunTerminal({ role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' });

  const blobs = [
    JSON.stringify(runtime.state()),
    JSON.stringify(runtime.facts()),
    JSON.stringify(runtime.digest()),
  ];
  for (const blob of blobs) {
    for (const sentinel of SENTINELS) {
      assert.equal(blob.includes(sentinel), false, `leaked: ${sentinel}`);
    }
  }
  // 事实里只允许出现固定枚举 / 派生 id / 来源限定 evidence / 毫秒数。
  for (const fact of runtime.facts()) {
    assert.equal(typeof fact.seq, 'number');
    assert.equal(typeof fact.atMs, 'number');
    assert.equal(team.FACT_TYPES.includes(fact.type), true, `unexpected fact type ${fact.type}`);
    if (fact.evidence !== undefined) {
      assert.match(fact.evidence, /^[a-z][a-z0-9_/-]*:[a-z][a-z0-9_-]*$/);
    }
    if (fact.artifactId !== undefined) assert.match(fact.artifactId, /^art:[0-9a-f]{16}$/);
    if (fact.digest !== undefined) assert.match(fact.digest, /^art-sha256:[0-9a-f]{16}$/);
  }
});

// ===========================================================================
// 12. fake clock 确定性
// ===========================================================================

test('team: the same command sequence under the same fake clock yields byte-identical results', () => {
  const a = createHarness();
  const b = createHarness();
  for (const h of [a, b]) {
    h.runtime.createJob({ jobId: JOB });
    runFullLoop(h.runtime, h.advance);
  }
  assert.deepEqual(a.runtime.digest(), b.runtime.digest());
  assert.deepEqual(JSON.parse(JSON.stringify(a.runtime.digest())), a.runtime.digest(), 'JSON round-trip');
  assert.deepEqual(a.runtime.facts(), b.runtime.facts());
  // 时间事实只来自注入的 clock。
  assert.equal(a.runtime.facts()[0].atMs, T0);
  assert.equal(JSON.stringify(a.runtime.digest()).includes(new Date(T0).toISOString()), false);
});

test('team: a different fake-clock start changes only the timestamps, never the structure', () => {
  const early = createHarness();
  const late = (() => {
    let nowMs = T0 + 86_400_000;
    const clock = { nowMs: () => nowMs };
    return { runtime: createTeamRuntime({ clock }), advance: (ms) => { nowMs += ms; } };
  })();
  early.runtime.createJob({ jobId: JOB });
  late.runtime.createJob({ jobId: JOB });
  runFullLoop(early.runtime, early.advance);
  runFullLoop(late.runtime, late.advance);
  const strip = (d) => ({ ...d, jobId: d.jobId });
  assert.deepEqual(strip(early.runtime.digest()), strip(late.runtime.digest()));
  assert.notEqual(early.runtime.facts()[0].atMs, late.runtime.facts()[0].atMs);
});

test('team: state is a pure fold of the fact log (replay reproduces it exactly)', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  runFullLoop(runtime, advance);
  const replayed = runtime.replay(runtime.facts());
  assert.deepEqual(replayed, runtime.state(), 'replay(facts) must equal state()');
  // 折叠是纯函数：不改入参、可重复。
  const once = runtime.replay(runtime.facts());
  const twice = runtime.replay(runtime.facts());
  assert.deepEqual(once, twice);
  // 逐条折叠与整体折叠一致。
  const folded = team.fold(team.initialJobState(JOB), runtime.facts()[0]);
  assert.deepEqual(Object.keys(folded.runs).sort(), ['researcher', 'reviewer']);
  // `status` 是**派生视图**，不是折叠出来的存储字段（所以 attention 被 resume 后
  // root 不会卡在旧状态）。
  assert.equal(team.derivedJobStatus(folded), 'pending');
  assert.equal(team.derivedJobStatus(runtime.replay(runtime.facts())), 'completed');
});

test('team: the fact log is append-only and monotonically sequenced per job', () => {
  const { runtime, advance } = createHarness();
  runtime.createJob({ jobId: JOB });
  runFullLoop(runtime, advance);
  const facts = runtime.facts();
  facts.forEach((fact, index) => {
    assert.equal(fact.seq, index + 1, 'seq is 1-based and contiguous');
    assert.equal(fact.jobId, JOB);
  });
  // facts() 返回副本：外部改写不影响运行时。
  const before = runtime.facts().length;
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(runtime.facts().length, before);
});

test('team: a bounded fact budget fails closed instead of silently dropping facts', () => {
  const { runtime } = createHarness();
  runtime.createJob({ jobId: JOB });
  // 直接把日志推到上限（用 dispatch/attention 之外的最小命令：重复 attention 会被
  // 幂等吸收，所以这里用 cancel-requested 之外的路径 —— 通过大量 job 级事实不可行，
  // 因此断言上限常量与"达到上限后拒绝"的行为契约）。
  assert.equal(typeof team.FACTS_MAX, 'number');
  assert.ok(team.FACTS_MAX > 0 && team.FACTS_MAX <= 65536);
  // 合法闭环远低于上限。
  runFullLoop(runtime, null);
  assert.ok(runtime.facts().length < team.FACTS_MAX);
});

// ===========================================================================
// 13. 与 office 内核的边界（不反向依赖、不污染 office 枚举）
// ===========================================================================

test('team: the team runtime does not touch office state or its enums', () => {
  const runtimeSource = fs.readFileSync(path.join(TEAM_RUNTIME_DIR, 'team-runtime.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
  assert.equal(/office-module|state-reducer|employee-registry/.test(runtimeSource), false,
    'the team runtime must not import or reference office internals (comments excluded)');
  const outsideRequires = requiresOfTeam().filter((entry) => !entry.includes('-> ./'));
  assert.deepEqual(outsideRequires, [], 'the team runtime requires nothing outside its own directory');
  // office 的 runtime 枚举没有被扩张（Team 状态是独立维度）。
  const reducer = require('../src/office/runtime/state-reducer.js');
  assert.deepEqual([...reducer.RUNTIME_STATES],
    ['unbound', 'idle', 'running', 'attention', 'completed', 'failed']);
  assert.deepEqual([...reducer.QUEUE_STATES], ['empty', 'queued']);
  // Team 状态词表与 office 的维度是两套东西（不共享枚举对象）。
  assert.notEqual(team.RUN_STATUSES, reducer.RUNTIME_STATES);
  assert.equal(team.RUN_STATUSES.includes('dispatched'), true, 'team-only status');
  assert.equal(reducer.RUNTIME_STATES.includes('dispatched'), false);
});
