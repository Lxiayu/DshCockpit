'use strict';

// src/team/runtime/team-executor-demo.js — 开发模式 FakeExecutor 可见闭环（Harness v0.3 工作包 A）。
//
// 纯 CommonJS：零 Electron / DOM / Pixi / fs / 网络 / 模型调用。它**不连接真实
// Harness，也不伪造 Harness session**：它以 **FakeExecutor** 作为执行事实的来源，
// 经 **TeamExecutionController**（唯一转换点）产生 Team 事实，再经既有 bridge 送进
// 既有 office 窄入口。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md（§6/§7/§8 + §14 开发入口）
// 与旧 fixture 的区别（**这是本文件存在的全部理由**）：
//
//   旧 team-office-demo.js：固定脚本 **直接调用 Team 命令**（applyDemoOp）
//                          → Team facts 的作者是 fixture 自己。
//   本模块：               FakeExecutor 产出 **ExecutionEvent**
//                          → TeamExecutionController 把它转成 Team 命令
//                          → Team facts 的作者仍是 Team Runtime，且**是执行证据的函数**。
//
// 因此本模块与旧 demo：
//   1. **没有 require 边**（互不依赖，测试断言）；
//   2. 复用**同一个** bridge / office 窄入口（producer 侧不同、consumer 侧相同）；
//   3. 由**各自独立的**环境变量门控，并**互斥**（见 main.js 的冲突拒绝）。
//
// 边界（与旧 demo 同构的三条）：
//   - 开发期 fixture：**不是**生产 Harness 输入，**不是** Team 执行器；
//   - 默认关闭：由 main.js 的 `DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO=1` 门控，未设置时
//     本模块根本不会被 require；
//   - Office 只是 projection 消费者：**Office 是否打开/可见/tick 都不决定 Team 是否运行**
//     （由 headless 对照测试证明：withOffice / withoutOffice 的 Team fact log 逐字相同）。
//
// 时钟（关键设计，见 A3）：
//   - 演示时钟 = **注入基准时钟 + 本地偏移**。基准时钟在 Electron 里取自 office 的
//     逻辑时钟（`state().simulatedAtMs`），在测试里可注入 fake；
//   - 每次 pump 把本地偏移推进 `DEMO_TICK_MS`，FakeExecutor 的 `advanceMs` 也累加到
//     同一个偏移上 —— 因此**没有墙钟、没有真实等待**，全部确定性；
//   - 注意：取 office 逻辑时钟作**基准**是开发 fixture 的便利（A3 明确允许），
//     它**不**建立"Office 驱动 Team"的依赖：Team 链在没有 office 时用注入基准时钟
//     产生**逐字相同**的事实。

const { createTeamRuntime } = require('./team-runtime.js');
const { createTeamOfficeBridge } = require('./team-office-bridge.js');
const { createFakeExecutor } = require('./fake-executor.js');
const { createTeamExecutionController } = require('./team-execution-controller.js');
const { ROLES } = require('./team-schema.js');

// 可注入的定时器接缝（默认用全局）。测试注入 fake，从而**不依赖真实 50ms 等待**
// 就能证明"attach 起了定时器 / detach 清了定时器"。
function defaultTimers() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
}

const DEMO_JOB_ID = 'team-exec-demo-1';
// 开发驱动的轮询间隔（毫秒）。unref：绝不拖住进程退出。
const DEMO_PUMP_INTERVAL_MS = 50;
// 每次 pump 推进的**演示逻辑毫秒**（不是墙钟）：让"每小时钟 tick 一步"可观测，
// 且与真实定时器解耦 —— 测试里 pump N 次就得到确定的时间线。
const DEMO_TICK_MS = 350;
// 有界：只保留最近若干步的结构化证据（供报告/诊断，不无限增长）。
const HISTORY_CAP = 64;

/**
 * 场景目录（**声明式**：只有"何时与执行链交互"的驱动参数，没有事实内容）。
 *
 * 事实内容全部来自 FakeExecutor 的脚本（见 fake-executor.js 的 SCENARIOS）；
 * 这里只声明"这个场景里，宿主什么时候做一次控制动作"。两者职责分离是本模块的核心。
 *
 *   resumeAfterMs — 某 run 进入 attention 后，经过这么多演示毫秒由宿主**显式** resume
 *                   （模拟"用户点了批准"；attention **绝不会**自动完成）
 *   cancelAfterMs — researcher 开始运行后，经过这么多演示毫秒由宿主发出取消请求
 *   eventsPerPump — 每次 pump 最多消费几条执行事件（1 = 便于肉眼观察中间态，
 *                   例如 cancel 的"ack 后仍占座"）
 */
const DEMO_SCENARIOS = Object.freeze({
  happy: Object.freeze({ eventsPerPump: 1 }),
  'attention-resume': Object.freeze({ eventsPerPump: 1, resumeAfterMs: 1_400 }),
  cancel: Object.freeze({ eventsPerPump: 1, cancelAfterMs: 1_050 }),
  failure: Object.freeze({ eventsPerPump: 1 }),
});

const DEMO_SCENARIO_NAMES = Object.freeze(Object.keys(DEMO_SCENARIOS));

function makeScenarioError(name) {
  const error = new Error(`DEMO_SCENARIO_UNKNOWN: unknown scenario "${name}"`);
  error.code = 'DEMO_SCENARIO_UNKNOWN';
  return error;
}

/**
 * @param {object} options
 * @param {object} [options.office]     office 组合根（有 subscribe/state/ingestTeamProjectionFact）。
 *                                      允许为 null → **不投影**（headless 对照用）。
 * @param {object} [options.clock]      基准时钟 { nowMs() }。缺省时从 office 快照取逻辑时钟。
 * @param {string} [options.scenario]   DEMO_SCENARIOS 的键（默认 'happy'）
 * @param {string} [options.jobId]      opaque job 句柄
 * @param {object} [options.timers]     注入的定时器接缝
 * @param {Function} [options.log]
 */
function createTeamExecutorDemo(options = {}) {
  const office = options.office && typeof options.office.state === 'function' ? options.office : null;
  const scenarioName = typeof options.scenario === 'string' && options.scenario !== ''
    ? options.scenario
    : 'happy';
  if (!DEMO_SCENARIOS[scenarioName]) throw makeScenarioError(scenarioName);
  const scenario = DEMO_SCENARIOS[scenarioName];
  const jobId = typeof options.jobId === 'string' && options.jobId !== '' ? options.jobId : DEMO_JOB_ID;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const timers = options.timers && typeof options.timers.setInterval === 'function'
    && typeof options.timers.clearInterval === 'function' ? options.timers : defaultTimers();
  // 基准时钟：显式注入优先；否则用 office 的逻辑时钟（开发便利）；再否则常量 0。
  const baseClock = options.clock && typeof options.clock.nowMs === 'function'
    ? options.clock
    : null;

  // ---- 演示时钟 = 基准 + 本地偏移（确定性、单调、无墙钟） ----------------------
  let localOffsetMs = 0;
  function baseNowMs() {
    if (baseClock) return baseClock.nowMs();
    if (!office) return 0;
    try {
      const snapshot = office.state();
      return snapshot && Number.isFinite(snapshot.simulatedAtMs) ? snapshot.simulatedAtMs : 0;
    } catch {
      return 0;
    }
  }
  const demoClock = Object.freeze({ nowMs: () => baseNowMs() + localOffsetMs });
  /** FakeExecutor 的 advanceMs **也**累加到同一个偏移：因此事件在演示时间上有先后，
   *  但**绝不**推进 office 自己的时钟（office 的 tick 仍由它自己的驱动决定）。 */
  const advanceDemoClock = (ms) => {
    if (Number.isFinite(ms) && ms > 0) localOffsetMs += ms;
  };

  // ---- 执行链：FakeExecutor → Controller → Team（← 事实方向） ------------------
  const runtime = createTeamRuntime({ clock: demoClock });
  const executor = createFakeExecutor({
    scenario: scenarioName,
    clock: demoClock,
    advanceClock: advanceDemoClock,
    log,
  });
  const controller = createTeamExecutionController({
    teamRuntime: runtime,
    executor,
    clock: demoClock,
    jobId,
    log,
  });
  // ---- 投影：Team → Office（← 表现方向；office 缺省时为 null） -----------------
  const bridge = office
    ? createTeamOfficeBridge({
      teamRuntime: runtime,
      office,
      knownSeats: Array.isArray(options.knownSeats) ? options.knownSeats : undefined,
      log,
    })
    : null;

  let pumps = 0;
  let attached = false;
  let timer = null;
  let pumping = false;          // 重入守卫：异步 pump 绝不并发
  let resumedRoles = new Set(); // 已做过 resume 的角色（每个角色只 resume 一次）
  let cancelRequested = false;
  const history = [];

  function teamState() {
    return runtime.state();
  }

  /**
   * 驱动钩子（**控制方向**：Team → Executor）。只做两件事：
   *   1. attention 的**显式**恢复（绝不自动完成）；
   *   2. 取消请求（请求 ≠ 终态）。
   * 时间来自演示时钟；是否该动作由 **Team 状态**（attention.atMs / startedAtMs）决定 ——
   * 不猜测、不看 UI。
   */
  async function applyDriverHooks() {
    const state = teamState();
    const nowMs = demoClock.nowMs();
    for (const role of ROLES) {
      const run = state.runs[role];
      if (!run) continue;
      if (scenario.resumeAfterMs !== undefined && run.status === 'attention' && run.attention) {
        if (!resumedRoles.has(role) && nowMs - run.attention.atMs >= scenario.resumeAfterMs) {
          resumedRoles = new Set([...resumedRoles, role]);
          const verdict = await controller.resume(role);
          log(`[team-exec-demo] simulated approval -> resume ${role}: ${verdict.ok ? 'ok' : verdict.code}`);
        }
      }
      if (scenario.cancelAfterMs !== undefined && role === 'researcher'
          && !cancelRequested && run.status === 'running' && Number.isFinite(run.startedAtMs)) {
        if (nowMs - run.startedAtMs >= scenario.cancelAfterMs) {
          cancelRequested = true;
          const verdict = await controller.requestCancel(role);
          log(`[team-exec-demo] simulated cancel request -> ${role}: ${verdict.ok ? 'ok' : verdict.code}`);
        }
      }
    }
  }

  /**
   * 一次驱动：推进演示时钟 → 驱动钩子 → 消费至多 `eventsPerPump` 条执行事件 →
   * 投影新事实 → 记一步证据。
   *
   * **原语**：生产里由开发定时器调用；测试直接调用（因此确定、不依赖真实定时器）。
   * 无墙钟、无 timers 依赖（定时器只在 attach 里出现，且只负责"多久调一次"）。
   */
  async function pump() {
    if (pumping) return Object.freeze({ ok: false, code: 'PUMP_IN_PROGRESS' });
    pumping = true;
    try {
      advanceDemoClock(DEMO_TICK_MS);            // 演示时间前进（与 office 时钟解耦）
      const factsBefore = runtime.facts().length;
      await controller.start();                  // createJob（幂等）+ dispatchReady
      await applyDriverHooks();                  // resume / cancel（控制方向）
      const applied = [];
      const budget = Number.isInteger(scenario.eventsPerPump) ? scenario.eventsPerPump : 1;
      for (let i = 0; i < budget; i += 1) {
        const step = await controller.pumpOne();
        if (!step) break;
        if (!step.ok) log(`[team-exec-demo] event rejected: ${step.code}`);
        applied.push({ role: step.role, type: step.type, status: step.status });
      }
      if (bridge) bridge.pump();                 // 投影新事实（无 office 时跳过）
      pumps += 1;
      const factsAfter = runtime.facts().length;
      if (factsAfter !== factsBefore || applied.length > 0) {
        const state = teamState();
        history.push(Object.freeze({
          pump: pumps,
          atMs: demoClock.nowMs(),
          jobStatus: state.status,
          applied: Object.freeze(applied),
          runs: Object.freeze(ROLES.map((role) => Object.freeze({
            role,
            status: state.runs[role] ? state.runs[role].status : null,
          }))),
        }));
        while (history.length > HISTORY_CAP) history.shift();
      }
      return Object.freeze({
        ok: true,
        code: null,
        pump: pumps,
        atMs: demoClock.nowMs(),
        applied: Object.freeze(applied),
        jobStatus: teamState().status,
      });
    } finally {
      pumping = false;
    }
  }

  /**
   * 是否还有**已排期但尚未到点**的驱动钩子（resume / cancel）。
   *
   * 这个判据是 `pumpUntilIdle` 正确性的关键：cancel 场景在执行侧"等 cancel 请求"
   * 时会**暂时没有可消费事件**，若把那一刻判成"idle 就停"，脚本就永远等不到驱动。
   * 因此"idle"的语义必须是"**既没有事件、也没有未来的驱动动作**"。
   */
  function driverPending() {
    const state = teamState();
    const nowMs = demoClock.nowMs();
    if (scenario.cancelAfterMs !== undefined && !cancelRequested) {
      const run = state.runs.researcher;
      if (run && run.status === 'running') return true;
      // 尚未 dispatch / start：驱动显然还在前头。
      if (run && (run.status === 'pending' || run.status === 'dispatched')) return true;
    }
    if (scenario.resumeAfterMs !== undefined) {
      for (const role of ROLES) {
        const run = state.runs[role];
        if (!run) continue;
        if (run.status === 'attention' && !resumedRoles.has(role)) return true;
        if (!resumedRoles.has(role) && (run.status === 'pending' || run.status === 'dispatched' || run.status === 'running')) {
          return true;
        }
      }
    }
    void nowMs;
    return false;
  }

  /** 驱动到"不再前进"（供测试与 headless 使用）：返回停止原因，不依赖定时器。 */
  async function pumpUntilIdle({ maxPumps = 96 } = {}) {
    for (let i = 0; i < maxPumps; i += 1) {
      const before = runtime.facts().length;
      const result = await pump();
      if (!result.ok) return Object.freeze({ reason: result.code, pumps: i });
      const state = teamState();
      if (['completed', 'failed', 'cancelled'].includes(state.status)) {
        return Object.freeze({ reason: 'terminal', pumps: i + 1 });
      }
      const progressed = runtime.facts().length > before || result.applied.length > 0;
      // 没有 attention 待恢复、没有排期的驱动动作、也没有新事实/新事件 → 真暂停点。
      if (!progressed && !driverPending()) return Object.freeze({ reason: 'idle', pumps: i + 1 });
    }
    return Object.freeze({ reason: 'max-pumps', pumps: maxPumps });
  }

  /**
   * 生产入口：启动开发驱动（一个 unref 定时器，每 DEMO_PUMP_INTERVAL_MS 调一次 pump）。
   * 定时器**只**决定"多久驱动一次"，不是事实来源；pump 才是原语。
   * 异步 pump 在定时器里以 fire-and-forget 方式运行，模块内部有重入守卫。
   */
  function attach() {
    if (attached) return Object.freeze({ ok: false, code: 'ALREADY_ATTACHED' });
    timer = timers.setInterval(() => {
      pump().catch((error) => log(`[team-exec-demo] pump failed: ${error && error.message}`));
    }, DEMO_PUMP_INTERVAL_MS);
    if (timer && typeof timer.unref === 'function') timer.unref(); // 绝不拖住进程退出
    attached = true;
    log(`[team-exec-demo] attached: FakeExecutor(${scenarioName}) -> controller -> team -> ${bridge ? 'bridge -> office' : 'headless'}; pump every ${DEMO_PUMP_INTERVAL_MS}ms`);
    return Object.freeze({ ok: true, scenario: scenarioName });
  }

  function detach() {
    if (!attached) return Object.freeze({ ok: false, code: 'NOT_ATTACHED' });
    if (timer) timers.clearInterval(timer);   // detach 后后台绝不再 pump
    timer = null;
    attached = false;
    return Object.freeze({ ok: true });
  }

  /** 只读摘要：固定枚举 + 有界计数 + 白名单码。**不含** raw 身份 / 文本 / 内容。 */
  function summary() {
    const state = teamState();
    return Object.freeze({
      demo: 'team-executor-demo-1',
      scenario: scenarioName,
      jobId,
      pumps,
      attached,
      jobStatus: state.status,
      teamFacts: runtime.facts().length,
      projection: bridge ? bridge.summary() : null,
      controller: controller.summary(),
      driver: Object.freeze({
        eventsPerPump: scenario.eventsPerPump,
        resumeAfterMs: scenario.resumeAfterMs === undefined ? null : scenario.resumeAfterMs,
        cancelAfterMs: scenario.cancelAfterMs === undefined ? null : scenario.cancelAfterMs,
        resumedRoles: Object.freeze([...resumedRoles].sort()),
        cancelRequested,
        localOffsetMs,
      }),
      history: Object.freeze([...history]),
    });
  }

  function describe() {
    return Object.freeze({
      demo: 'team-executor-demo-1',
      scenario: scenarioName,
      jobId,
      gate: 'DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO',
      producer: 'fake-executor-1',
      converter: 'team-execution-controller-1',
      projector: bridge ? 'team-office-bridge-1' : null,
      clock: baseClock ? 'injected-base' : (office ? 'office-logical-base' : 'zero-base'),
      tickMs: DEMO_TICK_MS,
      driver: `dev-timer(pump every ${DEMO_PUMP_INTERVAL_MS}ms, async)`,
      fixtures: Object.freeze([...DEMO_SCENARIO_NAMES]),
    });
  }

  return Object.freeze({
    // 生命周期
    attach,
    detach,
    // 原语
    pump,
    pumpUntilIdle,
    // 查询
    summary,
    describe,
    hasLiveTimer: () => timer !== null,
    // 显式暴露三段，便于测试断言"谁是作者 / 谁在消费"
    runtime,
    executor,
    controller,
    bridge,
    scenario: scenarioName,
    jobId,
    DEMO_TICK_MS,
    DEMO_PUMP_INTERVAL_MS,
  });
}

module.exports = {
  createTeamExecutorDemo,
  DEMO_SCENARIOS,
  DEMO_SCENARIO_NAMES,
  DEMO_JOB_ID,
  DEMO_TICK_MS,
  DEMO_PUMP_INTERVAL_MS,
  HISTORY_CAP,
};