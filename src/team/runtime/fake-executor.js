'use strict';

// src/team/runtime/fake-executor.js — 确定性 FakeExecutor（阶段 2 的纵向切片）。
//
// 纯 CommonJS：零依赖（只有 execution-schema / execution-port 两个纯同级模块），
// 无 Electron / DOM / Pixi / fs / 网络 / LLM / office / **team-runtime**。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §6
//
// 它是什么：
//   `startRun` → 一个**确定性脚本**的执行后端；`observe` 产出 ExecutionEvent 流；
//   `cancel` 产出 cancel-ack 并最终产出 `execution/cancelled`。
//
// 它**不是**什么（这几条是本次任务的红线，测试逐条钉住）：
//   1. **不写 Team fact** —— 本模块**不 require team-runtime**，也没有任何 Team 命令入口，
//      因此"FakeExecutor 直接写 Team"在结构上不可能（M14 变异的靶子）。
//   2. **不复刻 `team-office-demo.js` 的 `applyDemoOp`** —— demo 是"直接调 Team 命令"的
//      固定体验脚本；FakeExecutor 的事实来源只能是**执行事件**。两个模块之间没有
//      require 边（测试断言）。
//   3. **不需要 Office** —— 无时钟读取（时间来自注入 clock）、无 timers、无 tick 依赖。
//      引擎是 promise/microtask 驱动的：`observe()` 一被消费就推进，Office 关不关它都跑。
//
// 时间纪律：所有 `atMs` 来自注入的 clock。脚本每步可声明 `advanceMs`；FakeExecutor 调用
// 注入的 `advanceClock(ms)`（测试提供），因此时间线**确定**且无需真实等待。

const {
  EXECUTION_SCHEMA_VERSION,
  execJobRefFor,
  executionRefFor,
  validateExecutionEvent,
} = require('./execution-schema.js');
const {
  createExecutionHandle,
  normalizeCancelAck,
} = require('./execution-port.js');

// ---- 声明式场景（不是闭包 → 可 replay、可断言） ------------------------------
//
// 场景是 **role → 脚本** 的映射：researcher 产 `research-notes`、reviewer 产
// `review-findings`（Team 的 handoff contract 会拒绝错的 kind，因此同一个脚本
// 不能给两个角色用 —— 这也顺带证明"kind 归属校验是活的"）。
//
// 每一步的形状：
//   { op: 'started' | 'artifact' | 'attention' | 'completed' | 'failed' | 'cancelled'
//            | 'crashed' | 'wait-cancel' | 'wait-resume',
//     reason?, kind?, digest?, locationRef?, advanceMs? }
//
// `wait-cancel` / `wait-resume` 是**阻塞步**：脚本停在那里等外部输入
// （controller 的 cancel / resume），因此场景不会自己跑完。
const SCENARIO_HAPPY = Object.freeze({
  researcher: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'artifact', kind: 'research-notes', advanceMs: 300 }),
    Object.freeze({ op: 'completed', reason: 'ok', advanceMs: 600 }),
  ]),
  reviewer: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'artifact', kind: 'review-findings', advanceMs: 300 }),
    Object.freeze({ op: 'completed', reason: 'ok', advanceMs: 600 }),
  ]),
});

// 场景 §6.3 的第二条：researcher completed → reviewer attention → **显式 resume**
// → reviewer completed → root completed。
const SCENARIO_ATTENTION_RESUME = Object.freeze({
  researcher: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'artifact', kind: 'research-notes', advanceMs: 200 }),
    Object.freeze({ op: 'completed', reason: 'ok', advanceMs: 300 }),
  ]),
  reviewer: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'attention', reason: 'needs-approval', advanceMs: 200 }),
    Object.freeze({ op: 'wait-resume' }),
    Object.freeze({ op: 'artifact', kind: 'review-findings', advanceMs: 100 }),
    Object.freeze({ op: 'completed', reason: 'ok', advanceMs: 200 }),
  ]),
});

// 失败：researcher failed → reviewer **永不启动**（依赖只有 completed 才放行）。
const SCENARIO_FAILURE = Object.freeze({
  researcher: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'artifact', kind: 'research-notes', advanceMs: 150 }),
    Object.freeze({ op: 'failed', reason: 'tool-error', advanceMs: 400 }),
  ]),
  reviewer: Object.freeze([]),
});

// 取消：started → 等 cancel 请求 → ack（**非终态**）→ 真实 cancelled（终态）。
const SCENARIO_CANCEL = Object.freeze({
  researcher: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'wait-cancel' }),
    Object.freeze({ op: 'cancelled', reason: 'cancelled', advanceMs: 500 }),
  ]),
  reviewer: Object.freeze([]),
});

// 崩溃：crash 是**非终态**执行事件（默认策略 → Team attention，可恢复）。
const SCENARIO_CRASH = Object.freeze({
  researcher: Object.freeze([
    Object.freeze({ op: 'started' }),
    Object.freeze({ op: 'crashed', reason: 'executor-crashed', advanceMs: 250 }),
  ]),
  reviewer: Object.freeze([]),
});

const SCENARIOS = Object.freeze({
  happy: SCENARIO_HAPPY,
  'attention-resume': SCENARIO_ATTENTION_RESUME,
  failure: SCENARIO_FAILURE,
  cancel: SCENARIO_CANCEL,
  crash: SCENARIO_CRASH,
});

const EVENT_TYPE_BY_OP = Object.freeze({
  started: 'execution/started',
  artifact: 'execution/artifact',
  attention: 'execution/attention',
  completed: 'execution/completed',
  failed: 'execution/failed',
  cancelled: 'execution/cancelled',
  crashed: 'execution/crashed',
  // 控制面事件（由 cancel() 产出，不是脚本步）。
  'cancel-requested': 'execution/cancel-requested',
  'cancel-acknowledged': 'execution/cancel-acknowledged',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {object} options
 * @param {string} [options.scenario]        SCENARIOS 的键（默认 'happy'）
 * @param {Array}  [options.script]          显式脚本（覆盖 scenario）
 * @param {object} options.clock             { nowMs() }
 * @param {Function} [options.advanceClock]  (ms) => void —— 测试时钟推进（可选）
 * @param {Function} [options.log]
 */
function createFakeExecutor(options = {}) {
  const clock = options.clock && typeof options.clock.nowMs === 'function'
    ? options.clock
    : { nowMs: () => 0 };
  const advanceClock = typeof options.advanceClock === 'function' ? options.advanceClock : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const scenarioName = typeof options.scenario === 'string' ? options.scenario : 'happy';
  const scenarioDef = SCENARIOS[scenarioName] || SCENARIO_HAPPY;
  // 脚本解析优先级：显式 `script`（所有角色共用，供单角色测试）→ `scripts[role]`
  // → 场景定义里的 `roles[role]`（v0 只有 researcher / reviewer）。
  function scriptForRole(role) {
    if (Array.isArray(options.script)) return options.script;
    if (options.scripts && Array.isArray(options.scripts[role])) return options.scripts[role];
    return scenarioDef[role] || [];
  }

  const runs = new Map(); // handleId -> execution state
  let startCalls = 0;

  function execError(code, message) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
  }

  function requireState(handle) {
    const state = isPlainObject(handle) && typeof handle.handleId === 'string'
      ? runs.get(handle.handleId)
      : null;
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown or unbound execution handle');
    return state;
  }

  /**
   * 事件投递：**唯一**产出点。每条都过 schema 校验（fail-closed）—— 执行后端自己也
   * 不允许产出不合契约的事件，否则"契约"只是对下游的单向约束。
   */
  function push(state, op, stepDef) {
    const type = EVENT_TYPE_BY_OP[op];
    if (!type) throw execError('EXEC_UNSUPPORTED', `unknown script op "${op}"`);
    const advanceMs = Number.isFinite(stepDef && stepDef.advanceMs) ? stepDef.advanceMs : 0;
    if (advanceMs > 0) advanceClock(advanceMs);
    state.seq += 1;
    const raw = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      type,
      jobRef: state.jobRef,
      executionRef: state.executionRef,
      attempt: state.attempt,
      seq: state.seq,
      atMs: clock.nowMs(),
      ...(stepDef && stepDef.reason !== undefined ? { reason: stepDef.reason } : {}),
      ...(type === 'execution/artifact' ? { kind: stepDef.kind } : {}),
      ...(stepDef && stepDef.digest !== undefined ? { digest: stepDef.digest } : {}),
      ...(stepDef && stepDef.locationRef !== undefined ? { locationRef: stepDef.locationRef } : {}),
    };
    const checked = validateExecutionEvent(raw);
    if (!checked.ok) throw execError(checked.code, 'fake executor produced an invalid event');
    state.emitted += 1;
    state.pending.push(checked.event);
    if (checked.terminal) {
      state.terminal = true;
      state.terminalType = checked.event.type;
      // terminal 之后绝不再推进脚本：晚到事件必须由 controller 层观察为拒绝。
      state.scriptCursor = state.script.length;
    }
    state.waiters.splice(0, state.waiters.length).forEach((wake) => wake());
    return checked.event;
  }

  /** 推进脚本直到需要外部输入（cancel / resume）或脚本结束。 */
  function step(state) {
    while (state.scriptCursor < state.script.length) {
      const stepDef = state.script[state.scriptCursor];
      if (stepDef.op === 'wait-cancel') {
        state.awaitingCancel = true;
        return;
      }
      if (stepDef.op === 'wait-resume') {
        state.awaitingResume = true;
        return;
      }
      state.scriptCursor += 1;
      push(state, stepDef.op, stepDef);
    }
  }

  /** 消费掉一个已经满足的阻塞步（**必须**先跳过它，否则 step() 会再次停在同一处）。 */
  function consumeBlockingStep(state, op) {
    if (state.scriptCursor < state.script.length && state.script[state.scriptCursor].op === op) {
      state.scriptCursor += 1;
    }
  }

  function startRun({ jobId, runId, role, attempt, inputArtifacts } = {}) {
    startCalls += 1;
    const jobRef = execJobRefFor(jobId);
    const executionRef = executionRefFor(jobId, runId, attempt);
    if (!jobRef || !executionRef) {
      throw execError('EXEC_PORT_SHAPE_INVALID', 'startRun requires jobId/runId/attempt(+role)');
    }
    const handle = createExecutionHandle({
      jobRef, executionRef, role, attempt,
      startedAtMs: clock.nowMs(),
      supportsRecover: true,
    });
    if (!handle) throw execError('EXEC_IDENTITY_INVALID', 'cannot derive execution handle');
    // 重复 startRun 同一个 (job, run, attempt) 必须被拒绝（绝不启动第二个 Worker）。
    if (runs.has(handle.handleId)) {
      throw execError('EXEC_ALREADY_BOUND', 'execution already started for this run');
    }
    const state = {
      handle,
      jobRef,
      executionRef,
      attempt,
      role,
      script: scriptForRole(role).map((stepDef) => ({ ...stepDef })),
      scriptCursor: 0,
      seq: 0,
      emitted: 0,
      pending: [],
      waiters: [],
      terminal: false,
      terminalType: null,
      awaitingCancel: false,
      awaitingResume: false,
      cancelRequests: 0,
      acknowledged: false,
      inputArtifacts: Array.isArray(inputArtifacts) ? inputArtifacts.map((ref) => ({ ...ref })) : [],
    };
    runs.set(handle.handleId, state);
    step(state); // 立刻产出首批事件（不依赖任何外部 tick）
    log(`[fake-executor] startRun ${role} attempt=${attempt} -> ${handle.handleId}`);
    return handle;
  }

  /**
   * `AsyncIterable<ExecutionEvent>`：pull 模型；没有事件时等待，由投递唤醒。
   * **无定时器**（不需要 Office tick，也不需要真实时间等待）。
   */
  function observe(handle) {
    const state = requireState(handle);
    const iterator = {
      next() {
        if (state.pending.length > 0) {
          return Promise.resolve({ value: state.pending.shift(), done: false });
        }
        if (state.terminal) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          state.waiters.push(() => {
            if (state.pending.length > 0) resolve({ value: state.pending.shift(), done: false });
            else resolve({ value: undefined, done: true });
          });
        });
      },
      return() { return Promise.resolve({ value: undefined, done: true }); },
    };
    return Object.freeze({ [Symbol.asyncIterator]: () => iterator });
  }

  /** attention 的显式恢复入口（宿主决定"继续"时才调用）。 */
  function resume(handle) {
    const state = requireState(handle);
    if (!state.awaitingResume) return Object.freeze({ ok: false, code: 'EXEC_UNSUPPORTED' });
    state.awaitingResume = false;
    consumeBlockingStep(state, 'wait-resume');
    step(state);
    return Object.freeze({ ok: true, code: null });
  }

  /**
   * cancel：产出控制面事件（`cancel-requested` **与** `cancel-acknowledged`，
   * 两者都**不是终态**），返回 ack，然后让脚本继续（通常立刻产出
   * `execution/cancelled` = 真正的终态）。
   *
   * 为什么 ack 也是一个**事件**（而不是只作为返回值）：Team 必须能观察到
   * "回执已到但状态未变"这一步（`run/cancel-acknowledged` 事实）。只把它作为返回值
   * 会让 Team 侧少一条事实，闭环就不完整。
   */
  async function cancel(handle) {
    const state = requireState(handle);
    state.cancelRequests += 1;
    if (state.terminal) return Object.freeze({ acknowledged: false, code: 'EXEC_HANDLE_TERMINAL' });
    state.awaitingCancel = false;
    consumeBlockingStep(state, 'wait-cancel');
    push(state, 'cancel-requested', { reason: 'requested' });
    push(state, 'cancel-acknowledged', { reason: 'acknowledged' });
    state.acknowledged = true;
    const ack = normalizeCancelAck({ acknowledged: true, atMs: clock.nowMs(), reason: 'fake-executor' });
    step(state);
    return ack;
  }

  /** 边界保留：recover 有真实实现（继续同一 run，**不**新开 run）。 */
  async function recover(handle) {
    const state = requireState(handle);
    if (!state.awaitingResume) return Object.freeze({ ok: false, code: 'EXEC_UNSUPPORTED' });
    state.awaitingResume = false;
    consumeBlockingStep(state, 'wait-resume');
    step(state);
    return Object.freeze({ ok: true, code: null, handle: state.handle });
  }

  /** 确定性宿主探针：当前未被消费的事件条数（让 controller 的 run() 不挂住）。 */
  function pendingCount(handle) {
    const state = requireState(handle);
    return state.pending.length;
  }

  function runState(handle) {
    const run = requireState(handle);
    return Object.freeze({
      handleId: run.handle.handleId,
      attempt: run.attempt,
      seq: run.seq,
      emitted: run.emitted,
      pending: run.pending.length,
      terminal: run.terminal,
      terminalType: run.terminalType,
      awaitingCancel: run.awaitingCancel,
      awaitingResume: run.awaitingResume,
      acknowledged: run.acknowledged,
      cancelRequests: run.cancelRequests,
      inputArtifacts: run.inputArtifacts.length,
    });
  }

  return Object.freeze({
    // 端口（契约 §5.1）
    startRun,
    observe,
    cancel,
    recover,
    resume,
    pendingCount,
    unsupported: Object.freeze([]),
    // 诊断 / 测试
    state: runState,
    scriptFor: (handle) => requireState(handle).script.map((stepDef) => ({ ...stepDef })),
    stats: () => Object.freeze({ runs: runs.size, startCalls }),
    describe: () => Object.freeze({
      executor: 'fake-executor-1',
      scenario: Array.isArray(options.script) ? 'inline-script' : scenarioName,
      clock: 'injected',
      driver: 'promise (no timers, no office)',
    }),
  });
}

module.exports = {
  createFakeExecutor,
  SCENARIOS,
  SCENARIO_HAPPY,
  SCENARIO_ATTENTION_RESUME,
  SCENARIO_FAILURE,
  SCENARIO_CANCEL,
  SCENARIO_CRASH,
  EVENT_TYPE_BY_OP,
};