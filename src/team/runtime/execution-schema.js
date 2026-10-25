'use strict';

// src/team/runtime/execution-schema.js — Worker Execution Contract v0 词表、身份派生与校验。
//
// 纯 CommonJS：零依赖（只有纯计算的 node:crypto），无 Electron / DOM / Pixi /
// fs / 网络 / office 模块 / team-runtime / LLM / 时钟读取 / timers / 随机数。
// 所有时间由调用方的 clock 提供；所有身份都是确定性派生。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md
//
// 命名边界：本模块**不占用** Harness 的 `team/*` 与 Team Runtime 的
// `job/*` / `run/*` / `artifact/*` 命名空间 —— 执行事实使用 `execution/*` 前缀。
//
// 分层立场（这是本层存在的唯一理由）：
//   执行后端是 ExecutionEvent 的**唯一作者**；Team Runtime 是 Team fact 的**唯一作者**。
//   两者之间只有一条单向转换（team-execution-controller.js），因此
//   "Team fact 是执行证据的函数" 是**结构性**成立的，而不是约定。
//
// 这个模块只负责"执行事实的形状与身份"，它：
//   - **不**判断依赖（Team 的权威）；
//   - **不**调用 Team 命令（controller 的职责）；
//   - **不**产生 terminal evidence 字符串给 Team 之外的人看（evidence 由
//     controller 从事件**构造**一次：`execution/<outcome>:<reason>`）；
//   - **不**接受未知字段：执行方**无法**自带 evidence、无法自带 Team 状态、
//     无法自带 artifactId（伪造面在结构上被关掉）。

const crypto = require('node:crypto');

const EXECUTION_SCHEMA_VERSION = 1;

// ---- 事件类型（最小集合；`execution/progress` 刻意不加入） --------------------
//
// 契约 §5.2：`execution/progress` 没有真实消费方，因此**不加入** —— 不做
// "看起来完整"的无意义事件。
const EXECUTION_EVENT_TYPES = Object.freeze([
  'execution/started',
  'execution/artifact',
  'execution/attention',
  'execution/completed',
  'execution/failed',
  'execution/cancel-requested',
  'execution/cancel-acknowledged',
  'execution/cancelled',
  'execution/crashed',
]);

// 终态：唯一能产生 Team terminal fact 的事件（且必须经 Team 命令 + evidence）。
const TERMINAL_EXECUTION_EVENT_TYPES = Object.freeze([
  'execution/completed',
  'execution/failed',
  'execution/cancelled',
]);
// 控制回执：**永远不是**终态。
const CONTROL_EXECUTION_EVENT_TYPES = Object.freeze([
  'execution/cancel-requested',
  'execution/cancel-acknowledged',
]);
// 非终态（既不终态也不控制回执）。
const NON_TERMINAL_EXECUTION_EVENT_TYPES = Object.freeze([
  'execution/started',
  'execution/artifact',
  'execution/attention',
  'execution/crashed',
]);

// 执行事实 → Team 结果类（只有终态事件有此映射）。
const TERMINAL_OUTCOME_BY_EVENT_TYPE = Object.freeze({
  'execution/completed': 'completed',
  'execution/failed': 'failed',
  'execution/cancelled': 'cancelled',
});

// 事件类型的默认 reason（粗粒度 token，绝不是模型文本或任务正文）。
const DEFAULT_REASON_BY_EVENT_TYPE = Object.freeze({
  'execution/started': null,
  'execution/artifact': null,
  'execution/attention': null,          // attention 必须显式给 reason（见下）
  'execution/completed': 'ok',
  'execution/failed': 'failed',
  'execution/cancel-requested': 'requested',
  'execution/cancel-acknowledged': 'acknowledged',
  'execution/cancelled': 'cancelled',
  // crash 的原因必须显式给出（默认值会让"为什么崩"不可观测）：null = 必填。
  'execution/crashed': null,
});

// ---- crash 策略（契约 §7。显式决定，不是"视情况"） ----------------------------
//
// 默认：crash → Team `attention`（非终态、可 recover）。理由：
//   - 绝不 completed（结构性保证：crash 不是终态事件类型）；
//   - attention 是既有语义中唯一"阻塞且可显式恢复"的状态；
//   - 收敛为 failed 必须由**宿主显式**调用（终态证据 `execution/crashed:unrecoverable`），
//     不能让执行层的崩溃自动变成"任务失败"这种业务判断。
const CRASH_DEFAULT_TEAM_ACTION = 'attention';
const CRASH_UNRECOVERABLE_EVIDENCE = 'execution/crashed:unrecoverable';

// ---- artifact 摘要（只有形状；内容与路径永不进入本层） -----------------------

// 执行侧的摘要形状（Team 侧另有自己的派生 digest，二者不互相冒充）。
const EXECUTION_DIGEST_PREFIX = 'exec-sha256:';
// 执行侧位置引用：**不透明、带前缀、无路径分隔符**（路径不可能通过形状校验）。
const EXECUTION_LOCATION_PREFIX = 'ref:';

// ---- 稳定拒绝码 --------------------------------------------------------------

const EXECUTION_CODES = Object.freeze([
  'EXEC_SCHEMA_VERSION_UNSUPPORTED',
  'EXEC_EVENT_SHAPE_INVALID',
  'EXEC_EVENT_TYPE_UNKNOWN',
  'EXEC_UNKNOWN_FIELD',
  'EXEC_IDENTITY_INVALID',
  'EXEC_IDENTITY_MISMATCH',
  'EXEC_ATTEMPT_INVALID',
  'EXEC_SEQUENCE_INVALID',
  'EXEC_DUPLICATE',
  'EXEC_OUT_OF_ORDER',
  'EXEC_REASON_INVALID',
  'EXEC_ARTIFACT_KIND_UNKNOWN',
  'EXEC_DIGEST_INVALID',
  'EXEC_LOCATION_INVALID',
  'EXEC_TERMINAL_EVIDENCE_REQUIRED',
  'EXEC_HANDLE_UNKNOWN',
  'EXEC_HANDLE_TERMINAL',
  'EXEC_ALREADY_BOUND',
  'EXEC_PORT_SHAPE_INVALID',
  'EXEC_TRANSPORT_UNAVAILABLE',
  'EXEC_UNSUPPORTED',
  'EXEC_CANCEL_NOT_REQUESTED',
  'EXEC_EXECUTOR_ERROR',
]);

// 非致命的稳定诊断（不 fail-closed，只观测）。
const EXECUTION_DIAGNOSTICS = Object.freeze([
  'EXEC_SEQUENCE_GAP',
  'EXEC_LATE_EVENT_AFTER_TERMINAL',
]);

// ---- 形状常量 ---------------------------------------------------------------

const EXEC_JOB_REF_PREFIX = 'exec-job:';
const EXEC_RUN_REF_PREFIX = 'exec-run:';
const EXEC_JOB_REF_RE = /^exec-job:[0-9a-f]{16}$/;
const EXEC_RUN_REF_RE = /^exec-run:[0-9a-f]{16}$/;
const EXEC_DIGEST_RE = /^exec-sha256:[0-9a-f]{16}$/;
const EXEC_LOCATION_RE = /^ref:[A-Za-z0-9._-]{1,64}$/;
// 粗粒度 reason（与 Team 契约的 ATTENTION_REASON_RE 同口径：小写 token，可含 `-`）。
const EXEC_REASON_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const EXEC_REASON_MAX_CHARS = 40;

// 允许出现在事件上的**全部**字段（白名单）。任何额外字段 → EXEC_UNKNOWN_FIELD。
// 这是"执行方不能自带 evidence / Team 状态 / artifactId"的结构性保证。
const EXECUTION_EVENT_FIELDS = Object.freeze([
  'type',
  'schemaVersion',
  'jobRef',
  'executionRef',
  'attempt',
  'seq',
  'atMs',
  'reason',
  'kind',
  'digest',
  'locationRef',
]);
// 只有 artifact 事件允许携带 kind / digest / locationRef。
const ARTIFACT_ONLY_FIELDS = Object.freeze(['kind', 'digest', 'locationRef']);

// artifact kind 白名单与 Team 契约**同口径**（research-notes / review-findings）。
// 这里是执行层的**独立**接受契约常量：executor 的 kind 必须属于团队闭环允许的槽位，
// 否则 fail-closed（不做"未知 kind 当新槽位"这种扩张）。
const EXECUTION_ARTIFACT_KINDS = Object.freeze(['research-notes', 'review-findings']);

// ---- 身份派生（确定性；raw id 不跨界） ----------------------------------------

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 执行侧 job 句柄：`exec-job:<16hex>`。raw jobId 不出现在事件里。 */
function execJobRefFor(rawJobId) {
  if (typeof rawJobId !== 'string' || rawJobId === '') return null;
  return EXEC_JOB_REF_PREFIX + sha256Hex(rawJobId).slice(0, 16);
}

/** 执行侧 run 句柄：`exec-run:<16hex>`（jobId|runId|attempt 派生）。
 *  它是 **(job, run, attempt) 三元组**的编码 —— 因此"事件属于哪次尝试"可校验，
 *  且 raw runId 与 Team 的 `team-run-sha256:*` 都不出现在本层。 */
function executionRefFor(rawJobId, rawRunId, attempt) {
  if (typeof rawJobId !== 'string' || rawJobId === '') return null;
  if (typeof rawRunId !== 'string' || rawRunId === '') return null;
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return EXEC_RUN_REF_PREFIX + sha256Hex(`${rawJobId}|${rawRunId}|${attempt}`).slice(0, 16);
}

// ---- 校验 ------------------------------------------------------------------

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejected(code) {
  return Object.freeze({ ok: false, code, event: null, terminal: false, outcome: null, diagnostics: Object.freeze([]) });
}

function isKnownEventType(type) {
  return typeof type === 'string' && EXECUTION_EVENT_TYPES.includes(type);
}

function isTerminalEventType(type) {
  return TERMINAL_EXECUTION_EVENT_TYPES.includes(type);
}

/**
 * 形状校验（唯一入口）。**fail-closed**：任何不合法都返回 { ok:false, code }，
 * 绝不"猜测一条合法事件"。
 *
 * 校验顺序（每条都有独立稳定码，便于观测）：形状 → 类型 → 白名单字段 →
 * 身份形状 → attempt/seq/atMs → type 专属字段（kind/digest/location）→ reason。
 */
function validateExecutionEvent(event) {
  if (!isPlainObject(event)) return rejected('EXEC_EVENT_SHAPE_INVALID');
  if (event.schemaVersion !== undefined
      && (!Number.isInteger(event.schemaVersion) || event.schemaVersion !== EXECUTION_SCHEMA_VERSION)) {
    return rejected('EXEC_SCHEMA_VERSION_UNSUPPORTED');
  }
  if (!isKnownEventType(event.type)) {
    return typeof event.type === 'string' && event.type !== ''
      ? rejected('EXEC_EVENT_TYPE_UNKNOWN')
      : rejected('EXEC_EVENT_SHAPE_INVALID');
  }
  // 字段白名单：执行方不能自带 evidence / Team 状态 / artifactId。
  for (const key of Object.keys(event)) {
    if (!EXECUTION_EVENT_FIELDS.includes(key)) return rejected('EXEC_UNKNOWN_FIELD');
    // artifact 专属字段只允许出现在 artifact 事件上。**但允许为 null** ——
    // 归一化后的事件会把它们显式补成 null，校验必须幂等（已归一化的事件再次校验仍合法）。
    // 非 null 的值仍然 fail-closed：执行方不能给非 artifact 事件塞 kind/digest/location。
    if (ARTIFACT_ONLY_FIELDS.includes(key) && event.type !== 'execution/artifact'
        && event[key] !== null && event[key] !== undefined) {
      return rejected('EXEC_UNKNOWN_FIELD');
    }
  }
  // 身份形状（派生句柄；raw id 无法通过）。
  if (typeof event.jobRef !== 'string' || !EXEC_JOB_REF_RE.test(event.jobRef)) {
    return rejected('EXEC_IDENTITY_INVALID');
  }
  if (typeof event.executionRef !== 'string' || !EXEC_RUN_REF_RE.test(event.executionRef)) {
    return rejected('EXEC_IDENTITY_INVALID');
  }
  if (!Number.isInteger(event.attempt) || event.attempt < 1) return rejected('EXEC_ATTEMPT_INVALID');
  if (!Number.isInteger(event.seq) || event.seq < 1) return rejected('EXEC_SEQUENCE_INVALID');
  if (typeof event.atMs !== 'number' || !Number.isFinite(event.atMs)) {
    return rejected('EXEC_EVENT_SHAPE_INVALID');
  }
  // artifact 专属字段。`null` 与缺失等价（归一化后的事件显式带 null，
  // 校验必须幂等 —— 已归一化的事件再次校验仍合法）。
  if (event.type === 'execution/artifact') {
    if (typeof event.kind !== 'string' || !EXECUTION_ARTIFACT_KINDS.includes(event.kind)) {
      return rejected('EXEC_ARTIFACT_KIND_UNKNOWN');
    }
    if (event.digest !== undefined && event.digest !== null
        && (typeof event.digest !== 'string' || !EXEC_DIGEST_RE.test(event.digest))) {
      return rejected('EXEC_DIGEST_INVALID');
    }
    if (event.locationRef !== undefined && event.locationRef !== null
        && (typeof event.locationRef !== 'string' || !EXEC_LOCATION_RE.test(event.locationRef))) {
      return rejected('EXEC_LOCATION_INVALID');
    }
  }
  // reason：可省略/为 null（用类型默认值）；给出时必须是粗粒度 token。
  let reason = DEFAULT_REASON_BY_EVENT_TYPE[event.type];
  if (event.reason !== undefined && event.reason !== null) {
    if (typeof event.reason !== 'string' || !EXEC_REASON_RE.test(event.reason)) {
      return rejected('EXEC_REASON_INVALID');
    }
    reason = event.reason;
  }
  // attention 与 crashed 必须显式带 reason（它们是"需要人来处理"的语义，
  // 默认值会让运维看不出原因；crash 默认值只用于 Team 侧的策略命名）。
  if ((event.type === 'execution/attention' || event.type === 'execution/crashed') && reason === null) {
    return rejected('EXEC_REASON_INVALID');
  }
  const normalized = Object.freeze({
    type: event.type,
    schemaVersion: EXECUTION_SCHEMA_VERSION,
    jobRef: event.jobRef,
    executionRef: event.executionRef,
    attempt: event.attempt,
    seq: event.seq,
    atMs: event.atMs,
    reason,
    kind: event.kind === undefined ? null : event.kind,
    digest: event.digest === undefined ? null : event.digest,
    locationRef: event.locationRef === undefined ? null : event.locationRef,
  });
  return Object.freeze({
    ok: true,
    code: null,
    event: normalized,
    terminal: isTerminalEventType(event.type),
    outcome: TERMINAL_OUTCOME_BY_EVENT_TYPE[event.type] || null,
    diagnostics: Object.freeze([]),
  });
}

/**
 * 身份关联校验：事件必须属于同一 (job, run, attempt)。
 * Team 契约 §7.4 的硬要求 —— 执行事件**必须**校验 job/run/attempt 关联。
 */
function assertExecutionIdentity(event, expected) {
  if (!isPlainObject(event) || !isPlainObject(expected)) return rejected('EXEC_IDENTITY_INVALID');
  if (event.jobRef !== expected.jobRef) return rejected('EXEC_IDENTITY_MISMATCH');
  if (event.executionRef !== expected.executionRef) return rejected('EXEC_IDENTITY_MISMATCH');
  if (event.attempt !== expected.attempt) return rejected('EXEC_IDENTITY_MISMATCH');
  return Object.freeze({ ok: true, code: null, event: null, terminal: false, outcome: null, diagnostics: Object.freeze([]) });
}

/**
 * 顺序/重复校验（纯函数，账本由调用方保持）。
 *   - `lastSeq === null` → 首次，合法；
 *   - `seq <= lastSeq` → 重复（同 seq）或乱序（更小）—— 两者**都** fail-closed，
 *     因为执行事件只能单调递增；
 *   - `seq > lastSeq + 1` → 合法但记 `EXEC_SEQUENCE_GAP` 诊断（后端可能全局编号）。
 */
function orderExecutionEvent(event, lastSeq) {
  const diagnostics = [];
  if (lastSeq === null || lastSeq === undefined) {
    return Object.freeze({ ok: true, code: null, event: null, terminal: false, outcome: null, diagnostics: Object.freeze([]) });
  }
  if (event.seq === lastSeq) return rejected('EXEC_DUPLICATE');
  if (event.seq < lastSeq) return rejected('EXEC_OUT_OF_ORDER');
  if (event.seq > lastSeq + 1) diagnostics.push('EXEC_SEQUENCE_GAP');
  return Object.freeze({
    ok: true, code: null, event: null, terminal: false, outcome: null,
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * terminal evidence（**由本层构造一次**，执行事件从不自带）：
 *   `execution/<outcome>:<reason>` —— 命中 Team 契约的 `EVIDENCE_RE`。
 * 非终态事件返回 null（因此"没有证据就不能终态"是结构性的）。
 */
function evidenceForExecutionEvent(event) {
  if (!isPlainObject(event) || !isTerminalEventType(event.type)) return null;
  const outcome = event.type.slice('execution/'.length);
  const reason = typeof event.reason === 'string' && event.reason !== ''
    ? event.reason
    : DEFAULT_REASON_BY_EVENT_TYPE[event.type];
  if (reason === null || reason === undefined) return null;
  const evidence = `${event.type}:${reason}`;
  return evidence.length <= 120 ? evidence : `${event.type}:unknown`;
}

/** 一条执行事件对 Team 的**建议动作**（转换表；controller 是唯一执行者）。 */
function teamActionForExecutionEvent(event) {
  if (!isPlainObject(event)) return null;
  switch (event.type) {
    case 'execution/started': return 'start-run';
    case 'execution/artifact': return 'note-artifact';
    case 'execution/attention': return 'note-attention';
    case 'execution/completed':
    case 'execution/failed':
    case 'execution/cancelled': return 'note-terminal';
    case 'execution/cancel-requested': return 'request-cancel';
    case 'execution/cancel-acknowledged': return 'note-cancel-ack';
    case 'execution/crashed': return 'note-attention'; // crash 默认策略见 CRASH_DEFAULT_TEAM_ACTION
    default: return null;                              // 未知 → null（fail-closed 的上游）
  }
}

module.exports = {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_EVENT_TYPES,
  TERMINAL_EXECUTION_EVENT_TYPES,
  CONTROL_EXECUTION_EVENT_TYPES,
  NON_TERMINAL_EXECUTION_EVENT_TYPES,
  TERMINAL_OUTCOME_BY_EVENT_TYPE,
  DEFAULT_REASON_BY_EVENT_TYPE,
  CRASH_DEFAULT_TEAM_ACTION,
  CRASH_UNRECOVERABLE_EVIDENCE,
  EXECUTION_DIGEST_PREFIX,
  EXECUTION_LOCATION_PREFIX,
  EXECUTION_CODES,
  EXECUTION_DIAGNOSTICS,
  EXEC_JOB_REF_PREFIX,
  EXEC_RUN_REF_PREFIX,
  EXEC_JOB_REF_RE,
  EXEC_RUN_REF_RE,
  EXEC_DIGEST_RE,
  EXEC_LOCATION_RE,
  EXEC_REASON_RE,
  EXEC_REASON_MAX_CHARS,
  EXECUTION_EVENT_FIELDS,
  ARTIFACT_ONLY_FIELDS,
  EXECUTION_ARTIFACT_KINDS,
  sha256Hex,
  execJobRefFor,
  executionRefFor,
  isKnownEventType,
  isTerminalEventType,
  validateExecutionEvent,
  assertExecutionIdentity,
  orderExecutionEvent,
  evidenceForExecutionEvent,
  teamActionForExecutionEvent,
};