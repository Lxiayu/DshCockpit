'use strict';

// src/team/runtime/team-runtime.js — Team Runtime v0（headless / 单根任务纵向闭环）。
//
// 纯 CommonJS：无 Electron / DOM / Pixi / fs / 网络 / LLM / prompt 模板 / 随机数。
// 所有时间来自注入的 clock；所有身份都是确定性派生。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md
//
// 架构立场（来自开源调研，见 docs/research/TEAM-RUNTIME-OSS-RESEARCH-2026-10.md）：
//   - 状态 = **append-only 事实日志的纯函数折叠**（Temporal Event History /
//     DeepSeek Harness durable session log / LangGraph 不可变 checkpoint 的共同立场）。
//     `state()` 是 `fold(facts)` 的产物，没有"独立存储的可变状态"。
//   - **请求事件 ≠ 终态事件**：`run/cancel-requested`、`run/cancel-acknowledged`
//     都不改变 status（Temporal ActivityTaskCancelRequested vs Canceled；本仓库
//     office 内核已实证同一规则）。
//   - **真终态 vs 依赖已满足**分开（Argo 的 Completed vs Fulfilled）：依赖判定只认
//     `completed`，failed/cancelled/attention 一律不放行。
//   - **artifact 是带生产者绑定的引用**（Argo `from: {{tasks.X…}}` + REAPI 内容寻址），
//     只传引用不传内容；消费者必须校验生产者（§6）。
//   - **不采用**消息传递式 handoff、LLM 委派、index/位置性关联、skip 填空占位放行。
//
// 本模块**不** import office-module，也不写 office 状态（契约 §10 责任矩阵）。

const {
  TEAM_SCHEMA_VERSION,
  ROLES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_OUTCOMES,
  JOB_CONVERGENCE_FACT_BY_STATUS,
  TEAM_V0_PLAN,
  TEAM_V0_BUDGET,
  DEFAULT_ATTEMPT,
  FACTS_MAX,
  EVIDENCE_MAX_CHARS,
  EVIDENCE_RE,
  ATTENTION_REASON_RE,
  runIdFor,
  artifactIdFor,
  digestFor,
  dedupeKeyFor,
  isNonEmptyString,
  isBoundedToken,
  planMatchesV0,
} = require('./team-schema.js');

const TEAM_RUNTIME_VERSION = 'team-runtime-1';

// ---------------------------------------------------------------------------
// 折叠：state = fold(facts)
// ---------------------------------------------------------------------------

function initialJobState(jobId) {
  return {
    jobId,
    createdAtMs: null,
    endedAtMs: null,
    terminalEvidence: null,
    lastConvergence: null,
    runs: {},       // role -> WorkerRun
    artifacts: {},  // artifactId -> ArtifactRef
  };
}

/**
 * Job 状态是**派生值**，不是存储值 —— 这是"state = fold(facts)"的直接体现：
 * 没有独立的可变状态可以过期。收敛（failed > cancelled > attention > completed）
 * 优先；否则只要有 run 不再是 pending 就是 running；什么都没开始就是 pending。
 *
 * 为什么必须派生：attention 被显式 resume 之后，收敛结果回到 null，job 必须自动
 * 回到 running。若把状态存下来，root 会永久卡在 attention（stale status）。
 */
function derivedJobStatus(state) {
  if (state.jobId === null) return 'pending';
  const converged = convergedJobStatus(state);
  if (converged !== null) return converged;
  const started = Object.values(state.runs).some((run) => run.status !== 'pending');
  return started ? 'running' : 'pending';
}

function newRun(jobId, role, planEntry) {
  return {
    runId: runIdFor(jobId, role, DEFAULT_ATTEMPT),
    jobId,
    role,
    attempt: DEFAULT_ATTEMPT,
    status: 'pending',
    dependsOn: [...planEntry.dependsOn],
    dispatchedAtMs: null,
    startedAtMs: null,
    endedAtMs: null,
    cancelRequestedAtMs: null,
    consumedArtifactIds: [],
    producedArtifactIds: [],
    terminalEvidence: null,
    attention: null,
  };
}

function cloneState(state) {
  const runs = {};
  for (const [role, run] of Object.entries(state.runs)) {
    runs[role] = {
      ...run,
      dependsOn: [...run.dependsOn],
      consumedArtifactIds: [...run.consumedArtifactIds],
      producedArtifactIds: [...run.producedArtifactIds],
      terminalEvidence: run.terminalEvidence ? { ...run.terminalEvidence } : null,
      attention: run.attention ? { ...run.attention } : null,
    };
  }
  const artifacts = {};
  for (const [id, ref] of Object.entries(state.artifacts)) {
    artifacts[id] = { ...ref, consumedBy: [...ref.consumedBy] };
  }
  return {
    ...state,
    runs,
    artifacts,
    terminalEvidence: state.terminalEvidence ? { ...state.terminalEvidence } : null,
  };
}

/** 纯函数折叠：一条 fact → 新状态。不改入参。 */
function fold(state, fact) {
  const next = cloneState(state);
  switch (fact.type) {
    case 'job/created': {
      next.jobId = fact.jobId;
      next.createdAtMs = fact.atMs;
      for (const entry of TEAM_V0_PLAN) next.runs[entry.role] = newRun(fact.jobId, entry.role, entry);
      break;
    }
    case 'run/dispatched': {
      const run = next.runs[fact.role];
      if (!run) break;
      run.status = 'dispatched';
      run.dispatchedAtMs = fact.atMs;
      break;
    }
    case 'run/started': {
      const run = next.runs[fact.role];
      if (!run) break;
      run.status = 'running';
      run.startedAtMs = fact.atMs;
      run.attention = null;
      run.consumedArtifactIds = [...fact.consumedArtifactIds];
      for (const id of fact.consumedArtifactIds) {
        const ref = next.artifacts[id];
        if (ref && !ref.consumedBy.includes(run.runId)) ref.consumedBy.push(run.runId);
      }
      break;
    }
    case 'artifact/available': {
      const run = next.runs[fact.producerRole];
      if (!run) break;
      next.artifacts[fact.artifactId] = {
        artifactId: fact.artifactId,
        jobId: fact.jobId,
        kind: fact.kind,
        producerRunId: fact.producerRunId,
        producerRole: fact.producerRole,
        digest: fact.digest,
        availableAtMs: fact.atMs,
        consumedBy: [],
      };
      if (!run.producedArtifactIds.includes(fact.artifactId)) run.producedArtifactIds.push(fact.artifactId);
      break;
    }
    case 'run/completed':
    case 'run/failed':
    case 'run/cancelled': {
      const run = next.runs[fact.role];
      if (!run) break;
      const outcome = fact.type.slice('run/'.length);
      run.status = outcome;
      run.endedAtMs = fact.atMs;
      run.terminalEvidence = { source: fact.evidence, reason: outcome, atMs: fact.atMs };
      break;
    }
    case 'run/attention': {
      const run = next.runs[fact.role];
      if (!run) break;
      run.status = 'attention';
      run.attention = { reason: fact.reason, atMs: fact.atMs };
      break;
    }
    case 'run/cancel-requested': {
      // 请求 ≠ 终态：只记时间，**不改 status**。
      const run = next.runs[fact.role];
      if (run) run.cancelRequestedAtMs = fact.atMs;
      break;
    }
    case 'run/cancel-acknowledged': {
      // 回执 ≠ 终态：**完全不改状态**（继承 office 内核的实证规则）。
      break;
    }
    case 'job/attention': {
      // attention 不是终态：不写 terminalEvidence、不写 endedAtMs。
      next.lastConvergence = { status: 'attention', atMs: fact.atMs };
      break;
    }
    case 'job/completed':
    case 'job/failed':
    case 'job/cancelled': {
      const status = fact.type.slice('job/'.length);
      next.lastConvergence = { status, atMs: fact.atMs };
      next.terminalEvidence = { source: fact.evidence, reason: status, atMs: fact.atMs };
      next.endedAtMs = fact.atMs;
      break;
    }
    default:
      break;
  }
  return next;
}

/** root 收敛状态：failed > cancelled > attention > completed（契约 §7-5）。
 *  未收敛（还有 run 未终态）返回 null。 */
function convergedJobStatus(state) {
  const runs = Object.values(state.runs);
  if (runs.length === 0) return null;
  if (runs.some((run) => run.status === 'failed')) return 'failed';
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled';
  if (runs.some((run) => run.status === 'attention')) return 'attention';
  if (runs.every((run) => run.status === 'completed')) return 'completed';
  return null;
}

function frozenState(state) {
  const runs = {};
  for (const [role, run] of Object.entries(state.runs)) {
    runs[role] = Object.freeze({
      ...run,
      dependsOn: Object.freeze([...run.dependsOn]),
      consumedArtifactIds: Object.freeze([...run.consumedArtifactIds]),
      producedArtifactIds: Object.freeze([...run.producedArtifactIds]),
      terminalEvidence: run.terminalEvidence ? Object.freeze({ ...run.terminalEvidence }) : null,
      attention: run.attention ? Object.freeze({ ...run.attention }) : null,
    });
  }
  const artifacts = {};
  for (const [id, ref] of Object.entries(state.artifacts)) {
    artifacts[id] = Object.freeze({ ...ref, consumedBy: Object.freeze([...ref.consumedBy]) });
  }
  return Object.freeze({
    schemaVersion: TEAM_SCHEMA_VERSION,
    ...state,
    status: derivedJobStatus(state),
    runs: Object.freeze(runs),
    artifacts: Object.freeze(artifacts),
    terminalEvidence: state.terminalEvidence ? Object.freeze({ ...state.terminalEvidence }) : null,
  });
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

function createTeamRuntime(options = {}) {
  const clock = options.clock && typeof options.clock.nowMs === 'function' ? options.clock : null;
  if (!clock) throw new Error('createTeamRuntime requires a clock with nowMs()');
  const now = () => clock.nowMs();

  // v0 只接受冻结的常量计划：任何其它形状都是"自动拆解"的入口，一律拒绝。
  if (options.plan !== undefined && !planMatchesV0(options.plan)) {
    const error = new Error('PLAN_UNSUPPORTED: Team v0 only accepts TEAM_V0_PLAN');
    error.code = 'PLAN_UNSUPPORTED';
    throw error;
  }

  let facts = Object.freeze([]);
  let state = initialJobState(null);
  const seenDedupeKeys = new Set();

  function applied(fact = null, convergence = null) {
    return Object.freeze({
      ok: true, status: 'applied', code: null, fact, convergence, jobStatus: derivedJobStatus(state),
    });
  }

  function duplicate() {
    return Object.freeze({
      ok: true, status: 'duplicate', code: 'DUPLICATE', fact: null, jobStatus: derivedJobStatus(state),
    });
  }

  function rejected(code) {
    return Object.freeze({ ok: false, status: 'rejected', code, fact: null, jobStatus: derivedJobStatus(state) });
  }

  /** 追加一条 fact（唯一写入口）：fold 进状态、记入日志、记 dedupeKey。 */
  function appendFact(fact) {
    const withSeq = Object.freeze({ ...fact, seq: facts.length + 1 });
    facts = Object.freeze([...facts, withSeq]);
    state = fold(state, withSeq);
    seenDedupeKeys.add(dedupeKeyFor([
      withSeq.jobId, withSeq.role, withSeq.type, withSeq.outcome, withSeq.evidence, withSeq.kind,
    ]));
    return withSeq;
  }

  /** root 收敛：状态变了才追加一条 job/* 事实（因此 root 终态永远是子 run 事实
   *  的函数，而不是调用方能声明的）。 */
  function converge() {
    const desired = convergedJobStatus(state);
    if (desired === null) return null;
    // 已经记录过同一个收敛结果就不再重复追加（attention 可被 resume 后再收敛）。
    if (state.lastConvergence && state.lastConvergence.status === desired) return null;
    const type = JOB_CONVERGENCE_FACT_BY_STATUS[desired];
    if (!type) return null;
    return appendFact({
      jobId: state.jobId, type, atMs: now(), evidence: `team/convergence:${desired}`,
    });
  }

  function guardFactBudget() {
    return facts.length < FACTS_MAX;
  }

  function roleEntry(role) {
    return TEAM_V0_PLAN.find((entry) => entry.role === role) || null;
  }

  function runOf(role) {
    return state.runs[role] || null;
  }

  // ---- 命令：createJob -----------------------------------------------------

  function createJob({ jobId } = {}) {
    if (!isBoundedToken(jobId)) return rejected('JOB_NOT_CREATED');
    // 同一个 jobId 的重复创建是幂等的；换一个 jobId 才是"已存在"。
    if (state.jobId !== null) {
      return state.jobId === jobId ? duplicate() : rejected('JOB_ALREADY_EXISTS');
    }
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({ jobId, type: 'job/created', atMs: now() });
    return applied(fact);
  }

  // ---- 命令：dispatch / start ---------------------------------------------

  function dispatchRun({ role } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    if (run.status !== 'pending') {
      // 重复 dispatch 绝不第二次启动（幂等 + 乱序要求）。
      return seenDedupeKeys.has(dedupeKeyFor([state.jobId, role, 'run/dispatched']))
        ? duplicate()
        : rejected('RUN_NOT_PENDING');
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return rejected('RUN_ALREADY_TERMINAL');
    const unmet = unsatisfiedDependencies(run);
    if (unmet !== null) return rejected(unmet);
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({ jobId: state.jobId, role, type: 'run/dispatched', atMs: now() });
    return applied(fact);
  }

  function startRun({ role, consumedArtifactIds = [] } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    // 状态门是唯一的"绝不第二次启动"保证（契约 §8-2）：只有 dispatched 可以首次
    // 启动，只有 attention 可以显式 resume；running/completed/failed/cancelled 一律
    // 拒绝。这里**不**用 dedupeKey —— 否则 attention 之后的显式 resume 会被幂等账本
    // 误判为重复，root 就永远无法从 attention 恢复。
    if (run.status !== 'dispatched' && run.status !== 'attention') return rejected('RUN_NOT_DISPATCHED');
    if (!Array.isArray(consumedArtifactIds)) return rejected('ARTIFACT_NOT_CONSUMABLE');
    const entry = roleEntry(role);
    for (const id of consumedArtifactIds) {
      const ref = state.artifacts[id];
      if (!ref) return rejected('ARTIFACT_UNKNOWN');
      // handoff contract（调研：artifact 交接必须"按 schema"）：消费者只能消费自己在
      // plan 里声明过 `consumes` 的 kind。
      if (!entry.consumes.includes(ref.kind)) return rejected('ARTIFACT_NOT_CONSUMABLE');
      // 生产者不可伪造：必须来自**被依赖角色**，且 producerRunId 与派生式一致。
      if (!run.dependsOn.includes(ref.producerRole)) return rejected('ARTIFACT_NOT_CONSUMABLE');
      if (ref.producerRunId !== runIdFor(state.jobId, ref.producerRole, DEFAULT_ATTEMPT)) {
        return rejected('ARTIFACT_NOT_CONSUMABLE');
      }
    }
    // handoff contract 的**完整性**方向：plan 声明要消费的每个 kind 都必须真的被消费
    // （否则"依赖已满足"可以靠只消费一部分来伪造）。
    for (const kind of entry.consumes) {
      const supplied = consumedArtifactIds.some((id) => {
        const ref = state.artifacts[id];
        return ref !== undefined && ref.kind === kind;
      });
      if (!supplied) return rejected('HANDOFF_INCOMPLETE');
    }
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({
      jobId: state.jobId, role, type: 'run/started', atMs: now(),
      consumedArtifactIds: [...consumedArtifactIds],
    });
    return applied(fact);
  }

  /** 依赖判定（契约 §5.2）：每个 dependsOn 必须 **completed**，且每个 consumes
   *  的 kind 都有来自被依赖角色的 artifact。返回 null 表示满足，否则返回拒绝码。 */
  function unsatisfiedDependencies(run) {
    for (const dep of run.dependsOn) {
      const depRun = runOf(dep);
      if (!depRun || depRun.status !== 'completed') return 'DEPENDENCIES_UNSATISFIED';
    }
    const entry = roleEntry(run.role);
    for (const kind of entry.consumes) {
      const satisfied = Object.values(state.artifacts).some(
        (ref) => ref.kind === kind && run.dependsOn.includes(ref.producerRole)
      );
      if (!satisfied) return 'DEPENDENCIES_UNSATISFIED';
    }
    return null;
  }

  /** 可被 dispatch 的角色（派生查询，不是状态）。 */
  function readyRoles() {
    if (state.jobId === null) return Object.freeze([]);
    const out = [];
    for (const entry of TEAM_V0_PLAN) {
      const run = runOf(entry.role);
      if (run && run.status === 'pending' && unsatisfiedDependencies(run) === null) out.push(entry.role);
    }
    return Object.freeze(out);
  }

  // ---- 命令：artifact -----------------------------------------------------

  function noteArtifact({ role, kind } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    const entry = roleEntry(role);
    if (!entry) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    // 只有 running 的 run 能产出 artifact。
    if (run.status !== 'running') return rejected('ARTIFACT_PRODUCER_NOT_RUNNING');
    // kind 必须属于该角色的 produces。
    if (!entry.produces.includes(kind)) return rejected('ARTIFACT_KIND_NOT_OWNED');
    const artifactId = artifactIdFor(state.jobId, run.runId, kind);
    if (state.artifacts[artifactId]) return duplicate();
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({
      jobId: state.jobId,
      role,
      type: 'artifact/available',
      atMs: now(),
      artifactId,
      kind,
      producerRunId: run.runId,
      producerRole: role,
      digest: digestFor(state.jobId, run.runId, kind, run.producedArtifactIds.length),
    });
    return applied(fact);
  }

  // ---- 命令：终态 / attention / cancel ------------------------------------

  function noteRunTerminal({ role, outcome, evidence } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    if (!TERMINAL_OUTCOMES.includes(outcome)) return rejected('INVALID_OUTCOME');
    // 终态证据必须是来源限定的非空字符串（`<source-event>:<coarse-reason>`）。
    if (!isNonEmptyString(evidence) || evidence.length > EVIDENCE_MAX_CHARS || !EVIDENCE_RE.test(evidence)) {
      return rejected('TERMINAL_EVIDENCE_REQUIRED');
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      // 每个 run 恰好一个终态事实（Temporal/Argo 的单一终态不变式）。
      return run.status === outcome ? duplicate() : rejected('RUN_ALREADY_TERMINAL');
    }
    if (run.status === 'pending') return rejected('RUN_NOT_DISPATCHED');
    const key = dedupeKeyFor([state.jobId, role, `run/${outcome}`, evidence]);
    if (seenDedupeKeys.has(key)) return duplicate();
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({
      jobId: state.jobId, role, type: `run/${outcome}`, atMs: now(), outcome, evidence,
    });
    const convergence = converge();
    return applied(fact, convergence);
  }

  function noteRunAttention({ role, reason } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    // reason 必须是粗粒度 token（privacy：模型文本/任务正文永远进不来）。
    if (!isNonEmptyString(reason) || !ATTENTION_REASON_RE.test(reason)) {
      return rejected('INVALID_ATTENTION_REASON');
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return rejected('RUN_ALREADY_TERMINAL');
    if (run.status === 'pending') return rejected('RUN_NOT_DISPATCHED');
    if (run.status === 'attention' && run.attention && run.attention.reason === reason) return duplicate();
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    const fact = appendFact({ jobId: state.jobId, role, type: 'run/attention', atMs: now(), reason });
    const convergence = converge();
    return applied(fact, convergence);
  }

  function requestCancel({ role } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    if (TERMINAL_RUN_STATUSES.includes(run.status)) return rejected('RUN_ALREADY_TERMINAL');
    if (run.status === 'pending') return rejected('RUN_NOT_DISPATCHED');
    const key = dedupeKeyFor([state.jobId, role, 'run/cancel-requested']);
    if (seenDedupeKeys.has(key)) return duplicate();
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    // **不改 status**：请求只是请求（契约 §7-3）。
    const fact = appendFact({ jobId: state.jobId, role, type: 'run/cancel-requested', atMs: now() });
    return applied(fact);
  }

  function noteCancelAcknowledged({ role } = {}) {
    if (state.jobId === null) return rejected('JOB_NOT_CREATED');
    if (!roleEntry(role)) return rejected('UNKNOWN_ROLE');
    const run = runOf(role);
    if (!run) return rejected('UNKNOWN_RUN');
    if (run.cancelRequestedAtMs === null) return rejected('CANCEL_NOT_REQUESTED');
    const key = dedupeKeyFor([state.jobId, role, 'run/cancel-acknowledged']);
    if (seenDedupeKeys.has(key)) return duplicate();
    if (!guardFactBudget()) return rejected('FACTS_LIMIT_REACHED');
    // **绝不改变 status**：回执不是终态证据（契约 §7-3）。
    const fact = appendFact({ jobId: state.jobId, role, type: 'run/cancel-acknowledged', atMs: now() });
    return applied(fact);
  }

  // ---- 查询 ---------------------------------------------------------------

  function jobState() {
    return frozenState(state);
  }

  function listFacts() {
    return Object.freeze([...facts]);
  }

  /** 重放：把给定事实序列折叠成状态（不改变本实例）。用于证明
   *  `state()` 是事实的纯函数（确定性 + 可重放）。 */
  function replay(factList) {
    let replayed = initialJobState(null);
    for (const fact of factList) replayed = fold(replayed, fact);
    return frozenState(replayed);
  }

  /** 稳定摘要（可比较、可 JSON 往返、不依赖日志文本）。 */
  function digest() {
    return {
      runtime: TEAM_RUNTIME_VERSION,
      schemaVersion: TEAM_SCHEMA_VERSION,
      jobId: state.jobId,
      jobStatus: derivedJobStatus(state),
      facts: facts.length,
      runs: TEAM_V0_PLAN.map((entry) => {
        const run = runOf(entry.role);
        return {
          role: entry.role,
          status: run ? run.status : null,
          attempt: run ? run.attempt : null,
          cancelRequested: run ? run.cancelRequestedAtMs !== null : null,
          attentionReason: run && run.attention ? run.attention.reason : null,
          produced: run ? run.producedArtifactIds.length : 0,
          consumed: run ? run.consumedArtifactIds.length : 0,
          evidence: run && run.terminalEvidence ? run.terminalEvidence.source : null,
        };
      }),
      artifacts: Object.values(state.artifacts)
        .map((ref) => ({ kind: ref.kind, producerRole: ref.producerRole, consumedBy: ref.consumedBy.length }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
      factTypes: facts.map((fact) => fact.type),
    };
  }

  return Object.freeze({
    // 命令
    createJob,
    dispatchRun,
    startRun,
    noteArtifact,
    noteRunTerminal,
    noteRunAttention,
    requestCancel,
    noteCancelAcknowledged,
    // 查询
    state: jobState,
    facts: listFacts,
    readyRoles,
    replay,
    digest,
    describe: () => Object.freeze({
      runtime: TEAM_RUNTIME_VERSION,
      schemaVersion: TEAM_SCHEMA_VERSION,
      roles: Object.freeze([...ROLES]),
      plan: TEAM_V0_PLAN,
      budget: TEAM_V0_BUDGET,
    }),
  });
}

module.exports = {
  createTeamRuntime,
  TEAM_RUNTIME_VERSION,
  fold,
  convergedJobStatus,
  derivedJobStatus,
  initialJobState,
};
