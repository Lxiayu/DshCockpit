'use strict';

// src/team/runtime/team-execution-controller.js — Team Runtime 与执行后端之间的**唯一**窄层。
//
// 纯 CommonJS：零依赖（team-runtime / execution-schema / execution-port 三个纯同级模块），
// 无 Electron / DOM / Pixi / fs / 网络 / LLM / **office**。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §7
//
// 它做什么（且只做这些）：
//   1. 从 Team state 找出**可 dispatch 的 run**（读 Team，不猜）；
//   2. 调 Team 的 `dispatchRun` / `startRun`（Team 是 run 生命周期的权威）；
//   3. 调 `executor.startRun`，绑定**唯一** executionHandle（一个 run 一个 handle）；
//   4. 消费 `executor.observe` 的事件流；
//   5. 按**静态转换表**把 ExecutionEvent 变成 Team 命令（唯一转换点）；
//   6. 把执行错误变成**结构化**结果（绝不静默吞掉）；
//   7. 把新产生的 Team fact 交给外部订阅者（`onFact`）—— 这是投影方向（Team → 外部）。
//
// 它**不**做什么（同样是硬规则，测试逐条钉住）：
//   - 不 import office / 不写 office 状态 / 不碰 renderer（本模块 require 闭包里没有 office）；
//   - 不读 dsh raw journal（那是阶段 5 的 backend 的职责，且必须经 transport 注入）；
//   - 不生成 prompt（本层根本没有这个参数）；
//   - **不**修改 Team reducer 内部状态（`state` 在 team-runtime 闭包里，外部不可触达）；
//   - 没有 evidence 时**绝不**制造完成（终态只能来自终态执行事件 + Team 命令的 evidence 校验）；
//   - 不用定时器、不读墙钟（时间来自注入 clock）。
//
// 控制方向：Team → Executor（startRun / cancel / recover / resume）。
// 事实方向：Executor → ExecutionEvent → Validator（本模块）→ Team 命令。

const {
  TERMINAL_OUTCOME_BY_EVENT_TYPE,
  CRASH_DEFAULT_TEAM_ACTION,
  CRASH_UNRECOVERABLE_EVIDENCE,
  execJobRefFor,
  executionRefFor,
  isTerminalEventType,
  validateExecutionEvent,
  assertExecutionIdentity,
  orderExecutionEvent,
  evidenceForExecutionEvent,
} = require('./execution-schema.js');
const { assertExecutorPort, assertExecutionHandle } = require('./execution-port.js');

const CONTROLLER_VERSION = 'team-execution-controller-1';
const DEFAULT_ATTEMPT = 1;
// 有界的结构化拒绝账本（稳定码 → 次数），与 office/adapter 同一纪律。
const REJECTION_CODES_MAX = 32;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {object} options
 * @param {object} options.teamRuntime  Team Runtime（唯一 Team 事实作者）
 * @param {object} options.executor     执行后端端口（WorkerExecutor）
 * @param {object} options.clock        { nowMs() }
 * @param {string} options.jobId        opaque job 句柄（调用方提供）
 * @param {Function} [options.onFact]   (teamFact) => void —— 投影方向的订阅者
 * @param {Function} [options.log]
 */
function createTeamExecutionController(options = {}) {
  const team = options.teamRuntime;
  if (!team || typeof team.createJob !== 'function' || typeof team.state !== 'function') {
    throw new Error('createTeamExecutionController requires a teamRuntime (createJob/state/facts)');
  }
  const clock = options.clock && typeof options.clock.nowMs === 'function'
    ? options.clock
    : { nowMs: () => 0 };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const onFact = typeof options.onFact === 'function' ? options.onFact : () => {};
  const jobId = options.jobId;
  if (typeof jobId !== 'string' || jobId === '') {
    throw new Error('createTeamExecutionController requires a non-empty jobId');
  }
  const executor = options.executor;
  const portVerdict = assertExecutorPort(executor);
  if (!portVerdict.ok) {
    throw new Error(`${portVerdict.code}: executor does not satisfy the WorkerExecutor port (missing: ${(portVerdict.missing || []).join(',')})`);
  }
  const hasPendingProbe = typeof executor.pendingCount === 'function';

  // 一个 role 一条 execution 会话（v0：每角色至多一个活跃 run）。
  const sessions = new Map(); // role -> session
  const rejections = new Map(); // 稳定码 -> 次数
  const ledger = [];           // 有界结构化事件链（供报告/诊断；无 id/文本）
  const LEDGER_CAP = 128;
  let factCursor = 0;          // 已交给订阅者的 Team fact 游标
  let steps = 0;

  function noteRejection(code) {
    rejections.set(code, (rejections.get(code) || 0) + 1);
    if (rejections.size > REJECTION_CODES_MAX) {
      rejections.delete(rejections.keys().next().value);
    }
    log(`[team-exec] rejected: ${code}`);
    return Object.freeze({ ok: false, code, applied: false });
  }

  function noteLedger(entry) {
    ledger.push(Object.freeze({ ...entry, atMs: clock.nowMs() }));
    while (ledger.length > LEDGER_CAP) ledger.shift();
  }

  function pumpProjection() {
    const facts = team.facts();
    for (; factCursor < facts.length; factCursor += 1) onFact(facts[factCursor]);
    return factCursor;
  }

  /** 消费侧：Team 是依赖判定的权威 —— 我们只问 "哪些 ready"。 */
  function readyRoles() {
    return typeof team.readyRoles === 'function' ? [...team.readyRoles()] : [];
  }

  /** 计算一个 role 在 startRun 时必须消费的 ArtifactRef 集合（来自 Team state，不由脚本硬编码）。 */
  function consumedArtifactIdsFor(role) {
    const state = team.state();
    const run = state.runs[role];
    if (!run) return [];
    const deps = run.dependsOn || [];
    return Object.values(state.artifacts)
      .filter((ref) => deps.includes(ref.producerRole))
      .map((ref) => ref.artifactId)
      .sort();
  }

  /** 该角色声明产出的 artifact kinds（来自 Team 的常量 plan；provider 中立，不是后端自己的知识）。 */
  function producesKindsFor(role) {
    if (typeof team.describe !== 'function') return [];
    const entry = (team.describe().plan || []).find((candidate) => candidate.role === role);
    return entry ? [...entry.produces] : [];
  }

  /** 该角色声明消费的 artifact kinds（同上；壳用它定位"内联哪份上游笔记进 prompt"）。 */
  function consumesKindsFor(role) {
    if (typeof team.describe !== 'function') return [];
    const entry = (team.describe().plan || []).find((candidate) => candidate.role === role);
    return entry ? [...entry.consumes] : [];
  }

  function makeExpected(role) {
    const runId = typeof team.state().runs[role]?.runId === 'string'
      ? team.state().runs[role].runId
      : null;
    return Object.freeze({
      jobRef: execJobRefFor(jobId),
      executionRef: executionRefFor(jobId, runId, DEFAULT_ATTEMPT),
      attempt: DEFAULT_ATTEMPT,
      runId,
    });
  }

  // ---- 事实方向：ExecutionEvent → Team 命令 ------------------------------------

  /**
   * 把一条**已通过形状/身份/顺序校验**的执行事件转成 Team 命令。
   * 终态 evidence 在此**构造一次**（`execution/<outcome>:<reason>`）；执行事件从不自带 evidence。
   */
  function commandForEvent(role, event) {
    switch (event.type) {
      case 'execution/started':
        return team.startRun({ role, consumedArtifactIds: consumedArtifactIdsFor(role) });
      case 'execution/artifact':
        return team.noteArtifact({ role, kind: event.kind });
      case 'execution/progress':
        return team.noteRunProgress({ role, phase: event.phase });
      case 'execution/attention':
      case 'execution/crashed': {
        const reason = event.type === 'execution/crashed'
          ? (event.reason || 'crashed')       // crash 默认策略：attention（非终态、可恢复）
          : event.reason;
        return team.noteRunAttention({ role, reason });
      }
      case 'execution/completed':
      case 'execution/failed':
      case 'execution/cancelled': {
        const outcome = TERMINAL_OUTCOME_BY_EVENT_TYPE[event.type];
        const evidence = evidenceForExecutionEvent(event);
        // 结构性保证：没有 evidence 就不可能产生终态（Team 也会二次拒绝）。
        if (!evidence) return noteRejection('EXEC_TERMINAL_EVIDENCE_REQUIRED');
        return team.noteRunTerminal({ role, outcome, evidence });
      }
      case 'execution/cancel-requested':
        return team.requestCancel({ role });
      case 'execution/cancel-acknowledged':
        return team.noteCancelAcknowledged({ role });
      default:
        // 未知类型：形状校验已经拒绝过；这里再兜一次（fail-closed，不产 fact）。
        return noteRejection('EXEC_EVENT_TYPE_UNKNOWN');
    }
  }

  /** 已终态的 Team 事实类型 → 会话是否需要停止消费。 */
  function isTerminalTeamOutcome(type) {
    return type === 'run/completed' || type === 'run/failed' || type === 'run/cancelled';
  }

  /**
   * 应用一条执行事件到 Team（**唯一**入口；公开是为了让真实后端的 push 模型也能复用，
   * 且让"晚到/重复事件"路径可被直接测试）。
   *
   * 顺序：形状 → 身份关联 → 顺序/重复 → 命令 → 投影。
   */
  function ingestExecutionEvent(role, rawEvent) {
    const session = sessions.get(role);
    if (!session) return noteRejection('EXEC_HANDLE_UNKNOWN');
    const checked = validateExecutionEvent(rawEvent);
    if (!checked.ok) return noteRejection(checked.code);
    const event = checked.event;
    const identity = assertExecutionIdentity(event, session.expected);
    if (!identity.ok) return noteRejection(identity.code);
    if (session.terminal) {
      // 终态之后的事件**绝不**再产生 Team fact（否则会有第二个 terminal）。
      noteLedger({ role, event: event.type, seq: event.seq, result: 'late-rejected' });
      return noteRejection('EXEC_HANDLE_TERMINAL');
    }
    const ordered = orderExecutionEvent(event, session.lastSeq);
    if (!ordered.ok) {
      noteLedger({ role, event: event.type, seq: event.seq, result: 'order-rejected', code: ordered.code });
      return noteRejection(ordered.code);
    }
    for (const diag of ordered.diagnostics) noteLedger({ role, event: event.type, seq: event.seq, result: 'diagnostic', code: diag });
    session.lastSeq = event.seq;
    session.applied += 1;
    const verdict = commandForEvent(role, event);
    if (!verdict || verdict.ok !== true) {
      noteLedger({ role, event: event.type, seq: event.seq, result: 'team-rejected', code: verdict && verdict.code });
      if (verdict && verdict.code) rejections.set(verdict.code, (rejections.get(verdict.code) || 0) + 1);
      return Object.freeze({ ok: false, code: verdict && verdict.code ? verdict.code : 'EXEC_EXECUTOR_ERROR', applied: false });
    }
    if (isTerminalTeamOutcome(`run/${TERMINAL_OUTCOME_BY_EVENT_TYPE[event.type]}`) || isTerminalEventType(event.type)) {
      session.terminal = true;
      session.terminalOutcome = TERMINAL_OUTCOME_BY_EVENT_TYPE[event.type];
      session.terminalEvidence = evidenceForExecutionEvent(event);
      session.terminalSeq = event.seq;
    }
    if (verdict.status === 'duplicate') {
      noteLedger({ role, event: event.type, seq: event.seq, result: 'duplicate' });
    } else {
      noteLedger({ role, event: event.type, seq: event.seq, result: 'applied' });
    }
    pumpProjection();
    return Object.freeze({ ok: true, code: null, applied: verdict.status !== 'duplicate', status: verdict.status, jobStatus: verdict.jobStatus });
  }

  // ---- 控制方向：Team → Executor ------------------------------------------------

  /**
   * bindExecution 的执行器绑定段（dispatch 之后）：startRun → observe → 会话登记。
   * v0.6（WP1a）起独立成函数：bind 阶段失败进 attention 后，`resume` 要**重试**这一段
   *（sessions 无条目 —— 洞 A：老实现 resume 第一行就 EXEC_HANDLE_UNKNOWN）。
   */
  async function bindExecutorFor(role) {
    const expected = makeExpected(role);
    let handle;
    try {
      // 契约 §3.1：startRun 可返回 Handle 或 Promise<Handle>（真实后端要建会话）。
      handle = await executor.startRun({
        jobId,
        runId: expected.runId,
        role,
        attempt: DEFAULT_ATTEMPT,
        inputArtifacts: consumedArtifactIdsFor(role).map((id) => ({ artifactId: id })),
        // 该角色声明要产出的 artifact kinds（来自 Team 的常量 plan，provider 中立）。
        // 后端用它决定"终态前要不要向 transport 要一次 materialized artifact"。
        produces: producesKindsFor(role),
        consumes: consumesKindsFor(role),
        // signal：形状兼容的**确定性**子集（无定时器，无 AbortController 依赖）。
        signal: Object.freeze({ aborted: false, reason: null }),
      });
    } catch (error) {
      const code = error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR';
      noteLedger({ role, event: 'startRun', result: 'executor-error', code });
      // 会话/transport 不可用 → Team attention（设计 B §4.9）：**不是 failed**
      //（任务从未开始，没有任何执行证据），也不是静默 pending（root 会永远悬空）。
      // attention 非终态、可观测、可显式恢复或取消。reason 是粗粒度 token（隐私边界）。
      if (code === 'EXEC_TRANSPORT_UNAVAILABLE') {
        const attended = team.noteRunAttention({ role, reason: 'session-unavailable' });
        pumpProjection();
        return Object.freeze({
          ok: false, code, status: attended.status === 'applied' ? 'attention' : attended.status,
          attentionReason: 'session-unavailable',
        });
      }
      return Object.freeze({ ok: false, code, status: 'executor-error' });
    }
    const handleVerdict = assertExecutionHandle(handle);
    if (!handleVerdict.ok) {
      noteLedger({ role, event: 'startRun', result: 'handle-rejected', code: handleVerdict.code });
      return Object.freeze({ ok: false, code: handleVerdict.code, status: 'handle-rejected' });
    }
    const observed = executor.observe(handle);
    if (!observed || typeof observed[Symbol.asyncIterator] !== 'function') {
      noteLedger({ role, event: 'observe', result: 'port-rejected', code: 'EXEC_PORT_SHAPE_INVALID' });
      return Object.freeze({ ok: false, code: 'EXEC_PORT_SHAPE_INVALID', status: 'observe-rejected' });
    }
    const session = {
      role,
      handle,
      expected,
      iterator: observed[Symbol.asyncIterator](),
      lastSeq: null,
      applied: 0,
      terminal: false,
      terminalOutcome: null,
      terminalEvidence: null,
      terminalSeq: null,
      cancelRequested: false,
      consumed: 0,
    };
    sessions.set(role, session);
    noteLedger({ role, event: 'bound', result: 'applied', seq: null });
    return Object.freeze({ ok: true, code: null, status: 'bound', handle });
  }

  /** 为一个**就绪**角色建立执行绑定（dispatch → Team startRun 前置 → executor.startRun）。 */
  async function bindExecution(role) {
    const existing = sessions.get(role);
    // 重复 dispatch 绝不启动第二个 Worker。
    //
    // **诚实的边界说明（2026-10-23 实测）**：v0 里这条守卫**当前不可达** ——
    // `readyRoles()` 只回报 `pending` 的 run，而 Team 没有"取消 dispatch"的命令，
    // 因此一个已绑定的角色永远不会再出现在 readyRoles 里，`bindExecution` 不会被
    // 第二次进入（有测试钉住这个可达性事实）。
    // 所以"一 run 一个 Worker"目前**单层**由 executor 的 `EXEC_ALREADY_BOUND` 保证
    //（`startRun` 里 `runs.has(handleId)` 即抛错）。
    // 本守卫保留，是为了将来 `attempt > 1` 的重新 dispatch 之类的新路径一旦出现，
    // 这里仍然是一个正确的拦截点；但它**不是**当前安全性的依赖。
    if (existing && !existing.terminal) {
      return Object.freeze({ ok: true, code: null, status: 'already-dispatched', handle: existing.handle });
    }
    const dispatched = team.dispatchRun({ role });
    if (!dispatched.ok || (dispatched.status !== 'applied' && dispatched.status !== 'duplicate')) {
      noteLedger({ role, event: 'dispatch', result: 'team-rejected', code: dispatched.code });
      return Object.freeze({ ok: false, code: dispatched.code || 'EXEC_UNSUPPORTED', status: dispatched.status });
    }
    return bindExecutorFor(role);
  }

  /** 启动：建 job（幂等）→ 把所有 ready 角色绑定执行。 */
  async function start() {
    const created = team.createJob({ jobId });
    if (!created.ok && created.status !== 'duplicate') {
      return noteRejection(created.code || 'JOB_NOT_CREATED');
    }
    pumpProjection();
    return dispatchReady();
  }

  async function dispatchReady() {
    const results = [];
    for (const role of readyRoles()) {
      results.push(Object.freeze({ role, ...(await bindExecution(role)) }));
    }
    return Object.freeze(results);
  }

  /** 从一个会话取下一个事件（不阻塞：没缓冲就返回 null）。 */
  async function pullOnce(session) {
    if (session.terminal) return null;
    if (hasPendingProbe) {
      const pending = executor.pendingCount(session.handle);
      if (!Number.isFinite(pending) || pending <= 0) return null;
    }
    const next = await session.iterator.next();
    if (next.done) return null;
    session.consumed += 1;
    return next.value;
  }

  /**
   * 推进一次：按 plan 顺序找**第一个**有缓冲事件的会话并应用它。
   * 返回 `{ role, type, status }` 或 null（无缓冲事件 = 阶段暂停：awaitingResume / awaitingCancel）。
   * 无 timers、无墙钟 —— "有没有事件"来自 executor 的确定性探针（或真实后端的流）。
   */
  async function pumpOne() {
    for (const session of sessions.values()) {
      const event = await pullOnce(session);
      if (!event) continue;
      steps += 1;
      const applied = ingestExecutionEvent(session.role, event);
      return Object.freeze({ role: session.role, type: event.type, seq: event.seq, status: applied.status || null, ok: applied.ok });
    }
    return null;
  }

  /**
   * 跑到"暂停"为止：Buffered 事件全部消费完（或 job 已收敛）。
   * 暂停点 = 执行侧在等外部输入（attention 等待显式 resume / cancel 等待 cancel 请求），
   * 或执行侧还在跑而当前没有缓冲事件（真实后端的正常语义）。
   */
  async function run({ maxSteps = 64 } = {}) {
    const trace = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const step = await pumpOne();
      if (!step) break;
      trace.push(step);
      const state = team.state();
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') break;
    }
    return Object.freeze({ trace: Object.freeze(trace), jobStatus: team.state().status });
  }

  /** 取消：Team 先记请求（请求 ≠ 终态），再让执行器取消；ack **不**改变 Team 状态。 */
  async function requestCancel(role) {
    const session = sessions.get(role);
    if (!session) return noteRejection('EXEC_HANDLE_UNKNOWN');
    const requested = team.requestCancel({ role });
    if (!requested.ok && requested.status !== 'duplicate') {
      return Object.freeze({ ok: false, code: requested.code, status: requested.status });
    }
    session.cancelRequested = true;
    pumpProjection();
    let ack;
    try {
      ack = await executor.cancel(session.handle);
    } catch (error) {
      noteLedger({ role, event: 'cancel', result: 'executor-error', code: error && error.code });
      return Object.freeze({ ok: false, code: error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR' });
    }
    noteLedger({ role, event: 'cancel', result: ack && ack.ok === false ? 'ack-rejected' : 'ack', code: ack && ack.code });
    // ack 之后仍然**不是终态**：Team 状态只能由后续 execution/cancelled 推动。
    return Object.freeze({ ok: true, code: null, acknowledged: !!(ack && ack.acknowledged), runStatus: team.state().runs[role]?.status || null });
  }

  /**
   * 显式恢复（attention → running）。两条路径（v0.6 WP1 闭环）：
   *
   *   1. **无会话**（attention 来自 bind 阶段的 EXEC_TRANSPORT_UNAVAILABLE —— executor
   *      从未启动，sessions 无条目）：Team 先 startRun（attention→running，Team 权威），
   *      再重试 `bindExecutorFor`。重试再失败 → 诚实回 attention（不 failed、不停 running）。
   *   2. **有会话**（attention 来自执行事件，如 crashed/blocked）：Team 先 startRun，
   *      再 `executor.resume(handle)` 让执行侧续跑。执行器续跑失败 → 诚实回滚 attention。
   *
   * 终态会话不可 resume（终态只能由终态执行事件推动，绝不复活）。
   */
  async function resume(role) {
    const session = sessions.get(role);
    if (!session) {
      const resumed = team.startRun({ role, consumedArtifactIds: consumedArtifactIdsFor(role) });
      if (!resumed.ok && resumed.status !== 'duplicate') {
        return Object.freeze({ ok: false, code: resumed.code, status: resumed.status });
      }
      pumpProjection();
      const bound = await bindExecutorFor(role);
      if (!bound.ok) return bound; // TRANSPORT_UNAVAILABLE 已在内部转回 attention
      return Object.freeze({ ok: true, code: null, runStatus: team.state().runs[role]?.status || null });
    }
    if (session.terminal) return noteRejection('EXEC_HANDLE_TERMINAL');
    const resumed = team.startRun({ role, consumedArtifactIds: consumedArtifactIdsFor(role) });
    if (!resumed.ok && resumed.status !== 'duplicate') {
      return Object.freeze({ ok: false, code: resumed.code, status: resumed.status });
    }
    pumpProjection();
    if (typeof executor.resume === 'function') {
      try {
        await executor.resume(session.handle);
      } catch (error) {
        const code = error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR';
        noteLedger({ role, event: 'resume', result: 'executor-error', code });
        // Team 已回 running，但执行侧续跑失败 —— 诚实回滚为 attention，
        // 绝不静默留在 running（那正是 v0.4 真实链路"停在 running"的洞）。
        const attended = team.noteRunAttention({ role, reason: 'resume-failed' });
        pumpProjection();
        return Object.freeze({
          ok: false, code,
          status: attended.status === 'applied' ? 'attention' : attended.status,
          attentionReason: 'resume-failed',
        });
      }
    }
    return Object.freeze({ ok: true, code: null, runStatus: team.state().runs[role]?.status || null });
  }

  /** crash 后的恢复尝试（端口边界保留；后端 unsupported 时明确返回，不假装成功）。 */
  async function recover(role) {
    const session = sessions.get(role);
    if (!session) return noteRejection('EXEC_HANDLE_UNKNOWN');
    if (session.terminal) return noteRejection('EXEC_HANDLE_TERMINAL');
    if (typeof executor.recover !== 'function') return noteRejection('EXEC_UNSUPPORTED');
    try {
      const result = await executor.recover(session.handle);
      noteLedger({ role, event: 'recover', result: result && result.ok ? 'applied' : 'unsupported', code: result && result.code });
      return Object.freeze({ ok: !!(result && result.ok), code: result && result.code ? result.code : null });
    } catch (error) {
      noteLedger({ role, event: 'recover', result: 'executor-error', code: error && error.code });
      return Object.freeze({ ok: false, code: error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR' });
    }
  }

  /**
   * 宿主显式把不可恢复的 crash 收敛为 failed。
   * 这是**唯一**能让 crash 变成终态的路径，且必须由宿主决定（不是执行层自动判断）。
   */
  function finishCrashed(role) {
    const session = sessions.get(role);
    if (!session) return noteRejection('EXEC_HANDLE_UNKNOWN');
    if (session.terminal) return noteRejection('EXEC_HANDLE_TERMINAL');
    const verdict = team.noteRunTerminal({
      role, outcome: 'failed', evidence: CRASH_UNRECOVERABLE_EVIDENCE,
    });
    if (!verdict.ok && verdict.status !== 'duplicate') return Object.freeze({ ok: false, code: verdict.code });
    session.terminal = true;
    session.terminalOutcome = 'failed';
    session.terminalEvidence = CRASH_UNRECOVERABLE_EVIDENCE;
    noteLedger({ role, event: 'finish-crashed', result: 'applied', code: null });
    pumpProjection();
    return Object.freeze({ ok: true, code: null, jobStatus: verdict.jobStatus });
  }

  /** 只读摘要：固定枚举 + 有界计数 + 白名单码。**不含** raw 身份 / 文本 / 内容。 */
  function summary() {
    const state = team.state();
    return Object.freeze({
      controller: CONTROLLER_VERSION,
      jobStatus: state.status,
      teamFacts: team.facts().length,
      projectedFacts: factCursor,
      steps,
      crashPolicy: CRASH_DEFAULT_TEAM_ACTION,
      sessions: Object.freeze([...sessions.values()].map((session) => Object.freeze({
        role: session.role,
        attempt: session.expected.attempt,
        consumed: session.consumed,
        applied: session.applied,
        lastSeq: session.lastSeq,
        terminal: session.terminal,
        terminalOutcome: session.terminalOutcome,
        terminalEvidence: session.terminalEvidence,
        cancelRequested: session.cancelRequested,
        runStatus: state.runs[session.role] ? state.runs[session.role].status : null,
      }))),
      rejections: Object.freeze(Object.fromEntries([...rejections].sort((a, b) => a[0].localeCompare(b[0])))),
      ledger: Object.freeze([...ledger]),
    });
  }

  function describe() {
    return Object.freeze({
      controller: CONTROLLER_VERSION,
      jobId,
      clock: 'injected',
      determinismProbe: hasPendingProbe,
      port: portVerdict.describe || null,
      supportsRecover: portVerdict.supportsRecover === true,
      direction: Object.freeze({
        control: 'team->executor',
        facts: 'executor->event->validator->team',
        projection: 'team->subscriber',
      }),
    });
  }

  return Object.freeze({
    // 生命周期
    start,
    dispatchReady,
    pumpOne,
    run,
    // 控制
    requestCancel,
    resume,
    recover,
    finishCrashed,
    // 事实入口（真实后端的 push 模型 / 晚到与重复事件的验证路径）
    ingestExecutionEvent,
    // 查询
    summary,
    describe,
    teamRuntime: team,
    executor,
    handleFor: (role) => {
      const session = sessions.get(role);
      return session ? session.handle : null;
    },
  });
}

module.exports = {
  createTeamExecutionController,
  CONTROLLER_VERSION,
};