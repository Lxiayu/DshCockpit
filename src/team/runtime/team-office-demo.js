'use strict';

// src/team/runtime/team-office-demo.js — 开发模式 Team→Office 体验接通（工作包 A）。
//
// 纯 CommonJS：零 Electron / DOM / Pixi / fs / 网络 / 模型调用。它**不连接真实
// Harness，也不伪造 Harness session** —— 它用一份固定的、声明式的脚本直接驱动
// Team Runtime，再把 Team 事实经既有 bridge 送进既有 office 窄入口。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13
//
// 关键设计：
//   1. **Team Runtime 的时钟就是办公室的逻辑时钟** —— 从 office 的快照里读
//      `simulatedAtMs`。只有一个时钟、不读墙钟。
//   2. **驱动是一个独立的 unref pump 定时器** —— 刻意**不**用 `office.subscribe()`
//      驱动：办公室只在"墙钟 fire"和"事实摄入"时推送快照（`advanceOneTick` 本身
//      不推送），依赖推送节奏既脆弱又无法在无 Electron 的测试里确定性地驱动。
//      因此**不需要改 office-module.js**，也不需要新 IPC。
//   3. **默认关闭**：由 main.js 的 `DSH_DESKTOP_OFFICE_TEAM_DEMO=1` 门控；未设置时
//      本模块根本不会被 require。
//   4. **不让 renderer 成为事实作者**：这里只往 office 里送事实，office 快照是唯一
//      出口；UI/渲染层照旧只消费快照。
//   5. **脚本是声明式的**（不是闭包），因此可 replay、可断言、可写进测试。
//
// 这不是产品输入：demo 脚本永远不能当成生产 Harness 输入（见禁止清单）。

const { createTeamRuntime } = require('./team-runtime.js');
const { createTeamOfficeBridge } = require('./team-office-bridge.js');

// 可注入的定时器接缝（默认用全局）。测试注入 fake，从而**不依赖真实 50ms 等待**
// 就能证明"attach 起了定时器 / detach 清了定时器"。不引入第三方测试依赖。
function defaultTimers() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

const DEMO_JOB_ID = 'team-demo-1';
// 有界：只保留最近若干步的结构化证据（供报告/诊断，不无限增长）。
const HISTORY_CAP = 64;
// 开发驱动的轮询间隔（毫秒）。**不**要求与 office 的 16ms tick 对齐：脚本粒度是
// 数百毫秒，且 Team 时钟读的是 office 的逻辑时钟（办公室暂停时它冻结，脚本自然
// 停住）。unref：绝不拖住进程退出。
const DEMO_PUMP_INTERVAL_MS = 50;

/** 固定闭环脚本：researcher → artifact → completed → reviewer → attention →
 *  显式恢复 → completed → root completed。时间单位是办公室逻辑毫秒。 */
const DEMO_SCRIPT_HAPPY = Object.freeze([
  Object.freeze({ atMs: 0, op: 'createJob' }),
  Object.freeze({ atMs: 300, op: 'dispatch', role: 'researcher' }),
  Object.freeze({ atMs: 600, op: 'start', role: 'researcher' }),
  Object.freeze({ atMs: 1500, op: 'artifact', role: 'researcher', kind: 'research-notes' }),
  Object.freeze({ atMs: 3000, op: 'terminal', role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' }),
  Object.freeze({ atMs: 3800, op: 'dispatch', role: 'reviewer' }),
  Object.freeze({ atMs: 4100, op: 'start', role: 'reviewer', consume: true }),
  Object.freeze({ atMs: 6000, op: 'attention', role: 'reviewer', reason: 'needs-approval' }),
  Object.freeze({ atMs: 9000, op: 'start', role: 'reviewer', consume: true }),
  Object.freeze({ atMs: 10000, op: 'artifact', role: 'reviewer', kind: 'review-findings' }),
  Object.freeze({ atMs: 12000, op: 'terminal', role: 'reviewer', outcome: 'completed', evidence: 'subagent/end:completed' }),
]);

/** 取消闭环脚本：cancel-requested / ack 都不释放，只有 terminal cancelled 才释放。 */
const DEMO_SCRIPT_CANCEL = Object.freeze([
  Object.freeze({ atMs: 0, op: 'createJob' }),
  Object.freeze({ atMs: 300, op: 'dispatch', role: 'researcher' }),
  Object.freeze({ atMs: 600, op: 'start', role: 'researcher' }),
  Object.freeze({ atMs: 1500, op: 'cancel-request', role: 'researcher' }),
  Object.freeze({ atMs: 2000, op: 'cancel-ack', role: 'researcher' }),
  Object.freeze({ atMs: 3500, op: 'terminal', role: 'researcher', outcome: 'cancelled', evidence: 'turn/end:aborted' }),
]);

/** 失败闭环脚本：failed 不得让 reviewer 启动。 */
const DEMO_SCRIPT_FAILED = Object.freeze([
  Object.freeze({ atMs: 0, op: 'createJob' }),
  Object.freeze({ atMs: 300, op: 'dispatch', role: 'researcher' }),
  Object.freeze({ atMs: 600, op: 'start', role: 'researcher' }),
  Object.freeze({ atMs: 1500, op: 'artifact', role: 'researcher', kind: 'research-notes' }),
  Object.freeze({ atMs: 3000, op: 'terminal', role: 'researcher', outcome: 'failed', evidence: 'turn/end:error' }),
]);

/** 把一条脚本操作应用到 Team Runtime（fail-closed：未知 op 不产生任何事实）。 */
function applyDemoOp(runtime, op, jobId) {
  switch (op.op) {
    case 'createJob':
      return runtime.createJob({ jobId });
    case 'dispatch':
      return runtime.dispatchRun({ role: op.role });
    case 'start': {
      let consumedArtifactIds = [];
      if (op.consume === true) {
        // 消费"我被依赖角色产出的"全部 artifact（由 Team 状态决定，不由脚本硬编码 id）。
        const state = runtime.state();
        const run = state.runs[op.role];
        const deps = run ? run.dependsOn : [];
        consumedArtifactIds = Object.values(state.artifacts)
          .filter((ref) => deps.includes(ref.producerRole))
          .map((ref) => ref.artifactId);
      }
      return runtime.startRun({ role: op.role, consumedArtifactIds });
    }
    case 'artifact':
      return runtime.noteArtifact({ role: op.role, kind: op.kind });
    case 'attention':
      return runtime.noteRunAttention({ role: op.role, reason: op.reason });
    case 'terminal':
      return runtime.noteRunTerminal({ role: op.role, outcome: op.outcome, evidence: op.evidence });
    case 'cancel-request':
      return runtime.requestCancel({ role: op.role });
    case 'cancel-ack':
      return runtime.noteCancelAcknowledged({ role: op.role });
    default:
      return Object.freeze({ ok: false, code: 'DEMO_OP_UNKNOWN' });
  }
}

/** 每步的结构化证据（不含任何 id / 文本，只有固定枚举与有界计数）。 */
function projectStep(office, op) {
  const state = office.state();
  return Object.freeze({
    op: op.op,
    role: op.role || null,
    teamJobStatus: null, // filled by the caller (it owns the runtime)
    office: state.employees.map((e) => Object.freeze({
      employeeId: e.employeeId,
      runtime: e.runtime,
      activity: e.activity,
      bound: !!e.binding,
      taskLabel: e.taskLabel,
      animation: e.animation.resource,
    })),
  });
}

/**
 * @param {object} options
 * @param {object} options.office   office 组合根（必须有 subscribe / state / ingestTeamProjectionFact）
 * @param {Array}  [options.script] 固定脚本，默认 DEMO_SCRIPT_HAPPY
 * @param {object} [options.roleToSeat] Role→Seat 显式表（默认用 adapter 常量）
 * @param {string[]} [options.knownSeats] office 座位白名单
 * @param {string} [options.jobId]
 * @param {Function} [options.log]
 */
function createTeamOfficeDemo(options = {}) {
  const office = options.office;
  if (!office || typeof office.subscribe !== 'function' || typeof office.state !== 'function') {
    throw new Error('createTeamOfficeDemo requires an office with subscribe() and state()');
  }
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timers = options.timers && typeof options.timers.setInterval === 'function'
    && typeof options.timers.clearInterval === 'function'
    ? options.timers
    : defaultTimers();
  const script = Array.isArray(options.script) ? options.script : DEMO_SCRIPT_HAPPY;
  const jobId = typeof options.jobId === 'string' && options.jobId !== '' ? options.jobId : DEMO_JOB_ID;

  // 唯一时钟：办公室的逻辑时钟（从它推送的快照里读）。
  const teamClock = { nowMs: () => currentSimulatedAtMs() };
  const runtime = createTeamRuntime({ clock: teamClock });
  const bridge = createTeamOfficeBridge({
    teamRuntime: runtime,
    office,
    ...(options.roleToSeat ? { roleToSeat: options.roleToSeat } : {}),
    ...(options.knownSeats ? { knownSeats: options.knownSeats } : {}),
    log,
  });

  let cursor = 0;          // 脚本位置
  let attached = false;
  let timer = null;        // 开发驱动定时器（仅 attach 时存在）
  let pumps = 0;
  const history = [];

  function currentSimulatedAtMs() {
    try {
      const snapshot = office.state();
      return snapshot && Number.isFinite(snapshot.simulatedAtMs) ? snapshot.simulatedAtMs : 0;
    } catch {
      return 0;
    }
  }

  function runDueOps(nowMs) {
    const applied = [];
    while (cursor < script.length && script[cursor].atMs <= nowMs) {
      const op = script[cursor];
      const verdict = applyDemoOp(runtime, op, jobId);
      if (!verdict || verdict.ok !== true) {
        log(`[team-demo] op ${op.op} rejected: ${verdict && verdict.code}`);
      }
      applied.push(op);
      cursor += 1;
    }
    return applied;
  }

  function pump() {
    const nowMs = currentSimulatedAtMs();
    const applied = runDueOps(nowMs);
    const results = bridge.pump();
    pumps += 1;
    if (applied.length > 0) {
      const step = projectStep(office, applied[applied.length - 1]);
      history.push(Object.freeze({
        ...step,
        teamJobStatus: runtime.state().status,
        atMs: nowMs,
        appliedOps: applied.map((op) => op.op),
      }));
      while (history.length > HISTORY_CAP) history.shift();
    }
    return Object.freeze({ appliedOps: applied.map((op) => op.op), results, atMs: nowMs });
  }

  /**
   * 生产入口：启动开发驱动（一个 unref 的定时器，每个 DEMO_PUMP_INTERVAL_MS 调一次
   * pump）。刻意**不**用 office.subscribe() 驱动 —— 快照只在"墙钟 fire"和"事实摄入"
   * 时推送（advanceOneTick 本身不推送），依赖推送节奏既脆弱又无法在无 Electron 的
   * 测试里确定性地驱动。pump() 才是原语：定时器和测试走的是同一条代码。
   */
  function attach() {
    if (attached) return Object.freeze({ ok: false, code: 'ALREADY_ATTACHED' });
    timer = timers.setInterval(() => { pump(); }, DEMO_PUMP_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref(); // 绝不拖住进程退出
    attached = true;
    log(`[team-demo] attached: fixed ${script.length}-step Team script -> office (dev-only, pump every ${DEMO_PUMP_INTERVAL_MS}ms)`);
    return Object.freeze({ ok: true });
  }

  function detach() {
    if (!attached) return Object.freeze({ ok: false, code: 'NOT_ATTACHED' });
    if (timer) timers.clearInterval(timer); // 清定时器：detach 后后台绝不再 pump
    timer = null;
    attached = false;
    return Object.freeze({ ok: true });
  }

  function summary() {
    return Object.freeze({
      jobId,
      scriptSteps: script.length,
      cursor,
      done: cursor >= script.length,
      pumps,
      teamJobStatus: runtime.state().status,
      teamFacts: runtime.facts().length,
      bridge: bridge.summary(),
      history: Object.freeze([...history]),
    });
  }

  return Object.freeze({
    attach,
    detach,
    pump,
    summary,
    describe: () => Object.freeze({
      demo: 'team-office-demo-1',
      jobId,
      scriptSteps: script.length,
      attached,
      clock: 'office-logical',
      driver: `dev-timer(pump every ${DEMO_PUMP_INTERVAL_MS}ms)`,
    }),
    runtime,
    bridge,
    DEMO_PUMP_INTERVAL_MS,
    // 仅供测试/诊断：当前定时器句柄是否存在（不暴露 pump 之外的内部状态）。
    hasLiveTimer: () => timer !== null,
  });
}

module.exports = {
  createTeamOfficeDemo,
  applyDemoOp,
  DEMO_JOB_ID,
  DEMO_SCRIPT_HAPPY,
  DEMO_SCRIPT_CANCEL,
  DEMO_SCRIPT_FAILED,
  HISTORY_CAP,
};
