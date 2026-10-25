'use strict';

// src/team/runtime/execution-port.js — WorkerExecutor 端口契约（形状 + handle）。
//
// 纯 CommonJS：零依赖，无 Electron / DOM / Pixi / fs / 网络 / office / team-runtime。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §5.1
//
// 端口（Team Runtime 只认识这个接口，不认识任何具体后端）：
//
//   const executor = {
//     startRun({ jobId, runId, role, attempt, inputArtifacts, signal }) => ExecutionHandle,
//     observe(executionHandle) => AsyncIterable<ExecutionEvent>,
//     cancel(executionHandle) => Promise<CancelAck>,
//     recover(executionHandle) => Promise<ExecutionHandle>,   // 边界保留（可 unsupported）
//   };
//
// 本模块只做两件事：
//   1. **形状校验** —— 一个"executor"是否满足端口契约（缺失方法 / 非函数 → fail-closed）；
//   2. **handle 规范化与校验** —— handle 是执行层的**私有**句柄，必须带派生身份，
//      且严禁携带 raw sessionId / raw runId / 任意 provider 对象。
//
// 它**不**实现任何执行逻辑（FakeExecutor 是独立模块，真实后端是另一个独立模块）。

const {
  EXEC_RUN_REF_RE,
  EXEC_JOB_REF_RE,
} = require('./execution-schema.js');

// 端口方法（第一批真正支持的三个 + 边界保留的一个）。
const EXECUTOR_METHODS = Object.freeze(['startRun', 'observe', 'cancel', 'recover', 'pendingCount']);
const REQUIRED_EXECUTOR_METHODS = Object.freeze(['startRun', 'observe', 'cancel']);
// 边界保留：允许显式声明"本后端不支持 recover"，但必须**明确**声明（不能静默缺失）。
const OPTIONAL_EXECUTOR_METHODS = Object.freeze(['recover', 'pendingCount']);
// 确定性宿主探针（可选）：`pendingCount(handle) => number|null`。
// 有它 → controller 的 `run()` 只消费"当前已缓冲"的事件，因此**确定性且不会挂住**
// （FakeExecutor 提供）；没有它 → controller 只能 await（真实流式后端的正确语义）。
const DETERMINISM_PROBE_METHODS = Object.freeze(['pendingCount']);

// handle 上允许出现的**全部**字段。raw id / provider 对象一律非法。
const HANDLE_FIELDS = Object.freeze([
  'handleId',      // 'exec-handle:<16hex>'（派生，唯一的绑定 key）
  'jobRef',
  'executionRef',
  'role',
  'attempt',
  'startedAtMs',
  'supportsRecover', // 显式能力声明（不是"缺失即不支持"的静默回退）
]);

const EXEC_HANDLE_PREFIX = 'exec-handle:';
const EXEC_HANDLE_RE = /^exec-handle:[0-9a-f]{16}$/;
// handleId 是 executionRef 的确定性映射（前缀替换），不是第二个身份来源。
const EXEC_RUN_REF_PREFIX_LEN = 'exec-run:'.length;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejected(code, extra) {
  return Object.freeze({ ok: false, code, ...(extra || {}) });
}

/**
 * 端口形状校验。**fail-closed**：
 *   - 缺少必需方法 → `EXEC_PORT_SHAPE_INVALID`（并列出缺哪几个）；
 *   - 必需方法不是函数 → `EXEC_PORT_SHAPE_INVALID`；
 *   - `recover` 要么是函数，要么必须显式声明为不支持（`unsupported: ['recover']`）——
 *     静默缺失会被判为形状非法，因为那会让"崩溃后能不能恢复"变成不可知。
 */
function assertExecutorPort(executor) {
  if (!isPlainObject(executor)) return rejected('EXEC_PORT_SHAPE_INVALID', { missing: [...REQUIRED_EXECUTOR_METHODS], invalid: [] });
  const missing = [];
  const invalid = [];
  for (const name of REQUIRED_EXECUTOR_METHODS) {
    if (!Object.prototype.hasOwnProperty.call(executor, name)) missing.push(name);
    else if (typeof executor[name] !== 'function') invalid.push(name);
  }
  if (missing.length > 0 || invalid.length > 0) {
    return rejected('EXEC_PORT_SHAPE_INVALID', { missing, invalid });
  }
  const hasRecover = typeof executor.recover === 'function';
  const declaredUnsupported = Array.isArray(executor.unsupported) && executor.unsupported.includes('recover');
  if (!hasRecover && !declaredUnsupported) {
    return rejected('EXEC_PORT_SHAPE_INVALID', { missing: ['recover'], invalid: [], hint: 'declare unsupported:["recover"]' });
  }
  return Object.freeze({
    ok: true,
    code: null,
    supportsRecover: hasRecover,
    describe: typeof executor.describe === 'function' ? executor.describe() : null,
  });
}

/** 执行 handle（执行层私有；**不是** Office 的绑定 key，也**不是** Team 的 runId）。 */
function createExecutionHandle({ jobRef, executionRef, role, attempt, startedAtMs, supportsRecover } = {}) {
  if (typeof jobRef !== 'string' || !EXEC_JOB_REF_RE.test(jobRef)) return null;
  if (typeof executionRef !== 'string' || !EXEC_RUN_REF_RE.test(executionRef)) return null;
  if (typeof role !== 'string' || role === '') return null;
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return Object.freeze({
    handleId: EXEC_HANDLE_PREFIX + executionRef.slice(EXEC_RUN_REF_PREFIX_LEN),
    jobRef,
    executionRef,
    role,
    attempt,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
    supportsRecover: supportsRecover === true,
  });
}

/** handle 校验（controller 与测试共用）：形状 + 字段白名单。 */
function assertExecutionHandle(handle) {
  if (!isPlainObject(handle)) return rejected('EXEC_HANDLE_UNKNOWN');
  for (const key of Object.keys(handle)) {
    if (!HANDLE_FIELDS.includes(key)) return rejected('EXEC_HANDLE_UNKNOWN', { field: key });
  }
  if (typeof handle.handleId !== 'string' || !EXEC_HANDLE_RE.test(handle.handleId)) {
    return rejected('EXEC_HANDLE_UNKNOWN');
  }
  if (typeof handle.jobRef !== 'string' || !EXEC_JOB_REF_RE.test(handle.jobRef)) {
    return rejected('EXEC_HANDLE_UNKNOWN');
  }
  if (typeof handle.executionRef !== 'string' || !EXEC_RUN_REF_RE.test(handle.executionRef)) {
    return rejected('EXEC_HANDLE_UNKNOWN');
  }
  if (typeof handle.role !== 'string' || handle.role === '') return rejected('EXEC_HANDLE_UNKNOWN');
  if (!Number.isInteger(handle.attempt) || handle.attempt < 1) return rejected('EXEC_HANDLE_UNKNOWN');
  // handleId 必须与 executionRef 一致（不能自造一个与身份无关的 handle）。
  if (handle.handleId !== EXEC_HANDLE_PREFIX + handle.executionRef.slice(EXEC_RUN_REF_PREFIX_LEN)) {
    return rejected('EXEC_HANDLE_UNKNOWN', { reason: 'handleId/executionRef mismatch' });
  }
  return Object.freeze({ ok: true, code: null, handle });
}

/** CancelAck 规范化：ack **只**证明投递，绝不是终态（契约 §8.4）。 */
function normalizeCancelAck(ack) {
  if (!isPlainObject(ack)) return Object.freeze({ ok: false, code: 'EXEC_PORT_SHAPE_INVALID', acknowledged: false });
  if (ack.acknowledged !== true) {
    return Object.freeze({ ok: false, code: ack.code || 'EXEC_UNSUPPORTED', acknowledged: false });
  }
  return Object.freeze({
    ok: true,
    code: null,
    acknowledged: true,
    atMs: Number.isFinite(ack.atMs) ? ack.atMs : null,
    reason: typeof ack.reason === 'string' && ack.reason !== '' ? ack.reason : null,
  });
}

module.exports = {
  EXECUTOR_METHODS,
  REQUIRED_EXECUTOR_METHODS,
  OPTIONAL_EXECUTOR_METHODS,
  DETERMINISM_PROBE_METHODS,
  HANDLE_FIELDS,
  EXEC_HANDLE_PREFIX,
  EXEC_HANDLE_RE,
  assertExecutorPort,
  createExecutionHandle,
  assertExecutionHandle,
  normalizeCancelAck,
};