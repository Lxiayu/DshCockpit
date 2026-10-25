'use strict';

// src/team/runtime/dsh-execution-backend.js — DeepSeek dsh 执行后端**最小适配骨架**（阶段 5）。
//
// 纯 CommonJS：零依赖（execution-schema / execution-port 两个纯同级模块），
// **无网络**、无 fs、无 Electron、无 ws、无 office、无 team-runtime、无 prompt 生成。
// 真实 I/O 一律经**注入的 transport**；未注入时所有控制调用 fail-closed 返回
// `EXEC_TRANSPORT_UNAVAILABLE`（诚实失败，而不是假装接通）。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md §9
// 盘点依据：docs/research/DSH-EXECUTION-BACKEND-COMPAT-2026-10.md（每个映射项都有
// 仓库内的源码位置，**没有一项来自推测**）。
//
// 本阶段的边界（任务书 §9.2）：
//   - 实现的是：**接口形状** + **事件映射** + **fake/injected transport** + 无网络单测
//     + 明确的 unsupported 能力清单；
//   - **不**实现：真实 session 启动、真实 follow 流、真实 cancel 的端到端接线。
//     原因见 DSH_BACKEND_GAPS：真实接线所需的"谁来决定 prompt / 哪个 session 对应哪个
//     Role"的边界尚未定稿，硬接会引入 prompt 生成与 raw 身份跨界。
//
// 隐私纪律（本文件是最容易越界的地方，因此逐条写死）：
//   - raw sessionId / raw runId **只**出现在 transport 调用参数里（主进程侧），
//     **绝不**出现在产出的 ExecutionEvent 上（事件只带 `exec-job:` / `exec-run:` 派生句柄）；
//   - journal 的 `data.arguments`（工具参数）、`data.content`（正文）**永不读取**
//     （与 main.js 的翻译层同一纪律：只取粗粒度字段）；
//   - 本文件**不**解析 journal 日志文本做正则匹配（禁止"把日志文本正则成 completed"）。

const {
  EXECUTION_SCHEMA_VERSION,
  EXECUTION_EVENT_TYPES,
  execJobRefFor,
  executionRefFor,
  validateExecutionEvent,
} = require('./execution-schema.js');
const { createExecutionHandle, normalizeCancelAck } = require('./execution-port.js');

const DSH_BACKEND_VERSION = 'dsh-execution-backend-0';

// ---------------------------------------------------------------------------
// 1. dsh 事件 → ExecutionEvent 映射表（**只读盘点结论的代码化**）
// ---------------------------------------------------------------------------
//
// 每一行的 `source` 都是仓库内的**现成**映射位置（不是猜测）：
//   - `turn/start`            → J.  main.js:4760-4762 翻成 agent/status{running}
//   - `turn/end reason`       → J.  main.js:4764-4772 取 data.reason.kind
//                                       runtime-adapter.js:464-478 判 completed/failed/attention/cancelled
//   - 取消 ack                → A.  adapter.noteCancelAcknowledged()（runtime-adapter.js:721-724），
//                                  由 office-module.js:3992-3995 在 cancel RPC 成功后合成（dsh **无** journal ack 事件）
//   - 子代理生命周期          → W.  subagent-wiring.js:170-246（catalog / tool-workflow/agent-* / subagent-settled）
//   - artifact                → GAP（journal 无产物事件）
//   - crash / reconnect       → GAP（main.js:4249-4257 / 1537-1574 只进 runtime-health，**刻意不产 office fact**）
//
const DSH_EXECUTION_MAPPING = Object.freeze([
  Object.freeze({
    dshFact: 'session start (turn/start)',
    source: 'src/main.js:4760-4762 -> runtime-adapter.js:449-462',
    mapsTo: 'execution/started',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'turn end completed (turn/end reason.kind=completed)',
    source: 'src/main.js:4764-4772 -> runtime-adapter.js:466-467',
    mapsTo: 'execution/completed',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'turn end failed (reason.kind=error|failed)',
    source: 'src/main.js:4764-4772 -> runtime-adapter.js:468-469',
    mapsTo: 'execution/failed',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'turn end blocked (reason.kind=blocked)',
    source: 'src/main.js:4764-4772 -> runtime-adapter.js:472-473',
    mapsTo: 'execution/attention',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'turn end unknown/missing reason',
    source: 'runtime-adapter.js:474-476（**有意**降级为 attention，绝不猜 failed）',
    mapsTo: 'execution/attention',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'turn end aborted/interrupted/cancelled',
    source: 'src/main.js:4764-4772 -> runtime-adapter.js:470-471',
    mapsTo: 'execution/cancelled',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'cancel ack (RPC unary success, **no journal event**)',
    source: 'office-module.js:3992-3995 合成 -> runtime-adapter.js:721-724',
    mapsTo: 'execution/cancel-acknowledged',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'child session lifecycle (subagent start/end)',
    source: 'src/office/runtime/subagent-wiring.js:170-246',
    mapsTo: 'execution identity (which run this belongs to)',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'approval request (mux waterfall / pending)',
    source: 'src/main.js:5018-5045 -> officeNotePending',
    mapsTo: 'execution/attention',
    note: '与 blocked 同义的上游：都需要人来处理，因此都落到 attention（非终态）',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'artifact',
    source: 'v1（2026-10-25 拍板）：壳侧本地 materializer —— transport.artifactFor() 在 '
      + 'turn/end completed 前提供 {digest, locationRef}；dsh journal 本身仍无产物事件',
    mapsTo: 'execution/artifact',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'crash / reconnect',
    source: 'v0.6（WP1b，2026-10-25）：journal follow 流耗尽而无终态 → 本后端合成 '
      + 'crashed(stream-ended)（受信来源 = 流本身的结束；进程级 crash 信号仍只走 '
      + 'runtime-health，见 gaps 残留项）',
    mapsTo: 'execution/crashed',
    covered: true,
  }),
  Object.freeze({
    dshFact: 'run identity (raw sessionId / raw runId)',
    source: 'raw 只存在于 main.js 与 office-module 内部（src/main.js:315；office-module.js:1486-1487）',
    mapsTo: 'derived handles exec-job: / exec-run: (never on the event)',
    covered: true,
  }),
]);

// 明确的缺口清单（fail-closed 的能力，不假装支持）。
const DSH_BACKEND_GAPS = Object.freeze([
  Object.freeze({
    code: 'DSH_NO_NATIVE_ARTIFACT_EVENT',
    capability: 'execution/artifact',
    detail: 'dsh journal/follow 流没有"产物可用"事件（v1 已由壳侧本地 materializer 经 '
      + 'transport.artifactFor 受控覆盖：后端仍是事件唯一作者，壳只提供物化事实，'
      + '不从模型自由文本猜）。残留约束：artifactFor 未注入或返回 null 时 fail-closed，'
      + '下游 HANDOFF_INCOMPLETE 挂起 —— 绝不伪造交接。',
    level: 'P2',
  }),
  Object.freeze({
    code: 'DSH_NO_CRASH_FACT',
    capability: 'execution/crashed',
    detail: 'v0.6 起由"流耗尽而无终态"代理覆盖（合成 crashed(stream-ended) → attention，'
      + '可显式 resume 重挂 follow 续流）。残留：进程级崩溃/重连信号（main.js:4249-4257、'
      + '1537-1574）仍只走 runtime-health —— "连接抖动"不会变成任务事实；需要更细的 crash '
      + '原因时必须先新增受信来源，不从日志文本猜。',
    level: 'P2',
  }),
  Object.freeze({
    code: 'DSH_SESSION_ROLE_BINDING_UNDECIDED',
    capability: 'startRun',
    detail: 'dsh 没有"按 Role 起一个会话"的原语：session 由用户/壳决定。因此本骨架要求宿主注入'
      + '`sessionFor({jobId,runId,role})`；未注入 → EXEC_TRANSPORT_UNAVAILABLE（不生成 prompt）。'
      + '把它交给本层等于让执行层生成 prompt，违反契约 §9.3。',
    level: 'P0',
  }),
  Object.freeze({
    code: 'DSH_NO_TOOL_FAILURE_DETAIL',
    capability: 'execution/failed（原因粒度）',
    detail: 'main.js 的 tool/call 翻译只保留工具名（src/main.js:4774-4782，参数原文永不进办公室），'
      + '因此工具失败只能体现为 turn/end 的粗粒度 reason；无法给出 per-tool 失败原因。',
    level: 'P2',
  }),
]);

// ---------------------------------------------------------------------------
// 2. journal 事件 → ExecutionEvent（**纯函数**；无 I/O，可离线单测）
// ---------------------------------------------------------------------------

/** 从 0.1.5 journal 事件提取"粗粒度 reason"（与 main.js:4764-4772 同一取法）。 */
function coarseReasonOf(raw) {
  const data = raw && typeof raw.data === 'object' && raw.data !== null ? raw.data : {};
  const reason = data.reason;
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  if (typeof reason === 'string' && reason !== '') return reason;
  return null;
}

/**
 * 一条 journal 事件 → 0..1 条 `execution/*` **事件类型 + reason**（不含身份/序号/时间）。
 *
 * **fail-closed**：映射不到就返回 `{ type: null, code: null }`（"只 canonical 化、不产事实"，
 * 与 adapter 的 `mapEnvelope` 默认分支同一立场）。
 */
function mapDshJournalEvent(raw) {
  if (!raw || typeof raw.type !== 'string' || raw.type === '') {
    return Object.freeze({ type: null, reason: null, code: 'EXEC_EVENT_SHAPE_INVALID' });
  }
  if (raw.type === 'turn/start') {
    return Object.freeze({ type: 'execution/started', reason: null, code: null });
  }
  if (raw.type !== 'turn/end') {
    // 其它一切（tool/call、assistant/message、turn/usage、subagent/*…）在此**不**产生执行事件。
    return Object.freeze({ type: null, reason: null, code: null });
  }
  const reason = coarseReasonOf(raw);
  switch (reason) {
    case 'completed':
      return Object.freeze({ type: 'execution/completed', reason: 'ok', code: null });
    case 'error':
    case 'failed':
      return Object.freeze({ type: 'execution/failed', reason: 'failed', code: null });
    case 'blocked':
      return Object.freeze({ type: 'execution/attention', reason: 'blocked', code: null });
    case 'aborted':
    case 'interrupted':
    case 'cancelled':
      return Object.freeze({ type: 'execution/cancelled', reason: 'cancelled', code: null });
    default:
      // 未知/缺失 reason：**有意**降级为 attention（继承 adapter 的保守立场，绝不猜 failed）。
      return Object.freeze({ type: 'execution/attention', reason: 'unknown-reason', code: null });
  }
}

// ---------------------------------------------------------------------------
// 3. 注入 transport（fake transport；真实 transport 由壳提供）
// ---------------------------------------------------------------------------

/**
 * 一个**内存** transport：给测试与本地演练用。
 *   `events`: 预置的 raw journal 事件数组
 *   `cancelAck`: cancel() 的返回值（默认 { ok: true }）
 * 它**不发任何网络请求**，也不读文件。
 */
function createInjectedTransport(options = {}) {
  const events = Array.isArray(options.events) ? options.events.map((event) => ({ ...event })) : [];
  const cancelAck = options.cancelAck === undefined ? { ok: true } : options.cancelAck;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let opened = 0;
  let cancelled = 0;

  function follow({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw Object.assign(new Error('EXEC_TRANSPORT_UNAVAILABLE: follow requires a session handle'), {
        code: 'EXEC_TRANSPORT_UNAVAILABLE',
      });
    }
    opened += 1;
    let index = 0;
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        next() {
          if (index >= events.length) return Promise.resolve({ value: undefined, done: true });
          const value = events[index];
          index += 1;
          return Promise.resolve({ value: { ...value }, done: false });
        },
        return() { return Promise.resolve({ value: undefined, done: true }); },
      }),
    });
  }

  async function cancel({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return Object.freeze({ ok: false, code: 'EXEC_TRANSPORT_UNAVAILABLE' });
    }
    cancelled += 1;
    log(`[dsh-transport] cancel ${cancelAck && cancelAck.ok ? 'accepted' : 'refused'}`);
    return Object.freeze({ ...cancelAck });
  }

  return Object.freeze({
    follow,
    cancel,
    stats: () => Object.freeze({ opened, cancelled, events: events.length }),
    describe: () => Object.freeze({ transport: 'injected-memory', network: false, events: events.length }),
  });
}

// ---------------------------------------------------------------------------
// 4. DshExecutionBackend（端口形状 + 映射 + 注入 transport）
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.clock                  { nowMs() }
 * @param {object} options.transport              { follow, cancel }（**必须注入**，否则控制调用 fail-closed）
 * @param {Function} [options.sessionFor]         ({jobId, runId, role}) => sessionId|null
 *                                                **宿主决定**用哪个会话（本层不生成 prompt）
 * @param {Function} [options.advanceClock]
 * @param {Function} [options.log]
 */
function createDshExecutionBackend(options = {}) {
  const clock = options.clock && typeof options.clock.nowMs === 'function'
    ? options.clock
    : { nowMs: () => 0 };
  const advanceClock = typeof options.advanceClock === 'function' ? options.advanceClock : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const transport = options.transport && typeof options.transport.follow === 'function'
    && typeof options.transport.cancel === 'function' ? options.transport : null;
  const sessionFor = typeof options.sessionFor === 'function' ? options.sessionFor : null;

  const runs = new Map();
  let startCalls = 0;

  function execError(code, message) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
  }

  async function startRun({ jobId, runId, role, attempt, inputArtifacts, produces, consumes } = {}) {
    startCalls += 1;
    const jobRef = execJobRefFor(jobId);
    const executionRef = executionRefFor(jobId, runId, attempt);
    if (!jobRef || !executionRef) {
      throw execError('EXEC_PORT_SHAPE_INVALID', 'startRun requires jobId/runId/attempt/role');
    }
    // 诚实失败：未注入 transport 或宿主未指定会话时，**不**假装能跑。
    if (!transport) throw execError('EXEC_TRANSPORT_UNAVAILABLE', 'no transport injected');
    // 会话解析：v1 走 transport.resolveSession（壳持有，含"建会话+发任务文本"）；
    // 兼容旧接缝 options.sessionFor（只回答"用哪个会话"）。
    const resolveSession = typeof transport.resolveSession === 'function'
      ? transport.resolveSession
      : sessionFor;
    if (!resolveSession) {
      throw execError('EXEC_TRANSPORT_UNAVAILABLE',
        'no transport.resolveSession / sessionFor host hook (this layer never generates prompts)');
    }
    // raw sessionId 只在这条调用线上出现，绝不进入任何 ExecutionEvent。
    // resolveSession 可能是异步的（壳要建会话、发任务文本），也可能是同步的旧接缝
    //（options.sessionFor）—— 两种都兼容（契约 §3.1：startRun 可返回 Promise<Handle>）。
    const sessionId = await resolveSession({
      jobId, runId, role, attempt,
      inputArtifacts: Array.isArray(inputArtifacts) ? inputArtifacts : [],
      produces: Array.isArray(produces) ? [...produces] : [],
      consumes: Array.isArray(consumes) ? [...consumes] : [],
    });
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw execError('EXEC_TRANSPORT_UNAVAILABLE', 'host did not resolve a session for this role');
    }
    const handle = createExecutionHandle({
      jobRef, executionRef, role, attempt,
      startedAtMs: clock.nowMs(),
      supportsRecover: false, // dsh 后端**不**支持 recover（见 gaps）
    });
    if (!handle) throw execError('EXEC_IDENTITY_INVALID', 'cannot derive execution handle');
    if (runs.has(handle.handleId)) throw execError('EXEC_ALREADY_BOUND', 'execution already started');
    const stream = transport.follow({ sessionId });
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw execError('EXEC_PORT_SHAPE_INVALID', 'transport.follow must return an AsyncIterable');
    }
    runs.set(handle.handleId, {
      handle,
      sessionId,          // raw 只留在后端内部
      iterator: stream[Symbol.asyncIterator](),
      seq: 0,
      emitted: 0,
      terminal: false,
      terminalType: null,
      role,
      produces: Array.isArray(produces) ? [...produces] : [],
      consumes: Array.isArray(consumes) ? [...consumes] : [],
      artifactEmitted: false,
      // 有序发射队列（artifact 必须先于它的 completed 终态事件交付）。
      emissionQueue: [],
      // 控制面回执队列（**只有类型**；seq 在交付时分配，见 pullEvents）。
      receipts: [],
      deliveredJournalEvents: 0,
      // v0.6（WP1）：follow 无 resume cursor（重开即从头重放）——重挂后靠
      // journal 自身的单调 seq 去重吸收重放，只交付新事件。无数字 seq 的流不去重。
      lastJournalSeq: null,
      // v0.6（WP1b）：流耗尽合成 crashed 只发一次（幂等标志）。
      exhausted: false,
    });
    log(`[dsh-backend] startRun ${role} -> ${handle.handleId} (session bound in-process only)`);
    return handle;
  }

  /** 从 journal 事件构造一条通过 schema 校验的 ExecutionEvent（raw 不进事件）。 */
  function buildEvent(state, mapped) {
    if (!mapped.type) return null;
    state.seq += 1;
    const raw = {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      type: mapped.type,
      jobRef: state.handle.jobRef,
      executionRef: state.handle.executionRef,
      attempt: state.handle.attempt,
      seq: state.seq,
      atMs: clock.nowMs(),
      ...(mapped.reason ? { reason: mapped.reason } : {}),
      // artifact 专属字段（只有 materializer 路径会带；schema 只在 artifact 事件上放行）。
      ...(mapped.kind !== undefined ? { kind: mapped.kind } : {}),
      ...(mapped.digest !== undefined ? { digest: mapped.digest } : {}),
      ...(mapped.locationRef !== undefined ? { locationRef: mapped.locationRef } : {}),
    };
    const checked = validateExecutionEvent(raw);
    if (!checked.ok) throw execError(checked.code, 'dsh backend produced an invalid execution event');
    state.emitted += 1;
    if (checked.terminal) {
      state.terminal = true;
      state.terminalType = checked.event.type;
    }
    // 事件类型**不动**：journal 的原始 type 与 payload 都不出现在事件上。
    return checked.event;
  }

  /**
   * 终态前的 artifact 物化（v1 受信来源 = 壳侧本地 materializer，2026-10-25 用户拍板）。
   *
   * 顺序不变式：`execution/artifact` **必须**先于它的 `execution/completed` 交付 ——
   * Team 要求"只有 running 的 run 能产出 artifact"（`ARTIFACT_PRODUCER_NOT_RUNNING`），
   * 如果 completed 先到，artifact 会被拒绝且下游（reviewer）永远等不到交接。
   *
   * 事实作者边界：**后端仍是 execution/* 的唯一作者**。壳只通过
   * `transport.artifactFor({sessionId, role, kind})` 提供"内容已物化"的事实
   * （`{digest, locationRef}` 或 null）；**不**由壳直接发事件，也**不**从模型
   * 自由文本里猜（digest/locationRef 由壳计算/生成，见 team-shell-transport.js）。
   */
  async function materializeArtifactsBeforeTerminal(state, mapped) {
    if (mapped.type !== 'execution/completed') return;
    if (state.artifactEmitted || state.produces.length === 0) return;
    if (!transport || typeof transport.artifactFor !== 'function') return;
    for (const kind of state.produces) {
      let materialized = null;
      try {
        materialized = await transport.artifactFor({
          sessionId: state.sessionId, role: state.role, kind,
        });
      } catch (error) {
        log(`[dsh-backend] artifactFor refused for ${state.role}/${kind}: ${error && error.message}`);
        materialized = null;
      }
      if (!materialized) {
        // fail-closed：没有物化事实就**不**声明 artifact（Team 的 HANDOFF_INCOMPLETE
        // 会让下游不放行 —— 宁可挂在依赖上，也不伪造交接）。
        log(`[dsh-backend] no materialized artifact for ${state.role}/${kind}; handoff will be unsatisfied`);
        continue;
      }
      const artifactEvent = buildEvent(state, {
        type: 'execution/artifact',
        reason: null,
        kind: typeof materialized.kind === 'string' && materialized.kind !== '' ? materialized.kind : kind,
        ...(materialized.digest ? { digest: materialized.digest } : {}),
        ...(materialized.locationRef ? { locationRef: materialized.locationRef } : {}),
      });
      state.emissionQueue.push(artifactEvent);
      state.artifactEmitted = true;
    }
  }

  /**
   * 拉取一次：产出一条执行事件，或报告流已耗尽。
   *
   * 四条顺序规则（都是刻意的）：
   *   0. **有序发射队列最优先**：artifact（及其后续 completed）在物化时按序入队，
   *      必须先于一切新拉取的 journal 事件交付（保证 artifact→completed 的先后）。
   *   1. **控制面回执排在已交付的 journal 事件之后**：`cancel()` 只把回执**入队**，
   *      真正的 seq 在交付时分配。否则"取消回执"会插到 `execution/started` 之前，
   *      下游的顺序校验就会把 started 当成乱序（回执依赖 run 已开始，语义上也必须在其后）。
   *   2. **未映射的 journal 事件被跳过但**不**终止流**：tool/call、assistant/message
   *      等只 canonical 化（与 adapter 的默认分支同一立场），流要继续读到真正的
   *      turn/end —— 否则一次工具调用就会让整次执行"看起来结束"。
   *   3.（v0.6 WP1b）**流耗尽而无终态 → 恰好一条合成 `execution/crashed(stream-ended)`**：
   *      follow 无 resume cursor，"流结束了却没等到终态" = 丢失执行可见性（dsh 掉线/
   *      重启的等价物）。crash 默认策略（attention，非终态）由 controller 接手；
   *      显式 resume 后由 `resume()` 对同一会话重挂 follow 续流。绝不猜 failed。
   */
  async function pullEvents(handle) {
    const state = runs.get(handle.handleId);
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    // 规则 0：先交付已按序排好的事件（artifact → 它的 completed）。
    if (state.emissionQueue.length > 0) {
      const queued = state.emissionQueue.shift();
      return Object.freeze({ events: Object.freeze([queued]), done: false, skipped: 0 });
    }
    // 规则 1：已交付过至少一条 journal 事件之后，先交付排队的控制回执。
    if (state.receipts.length > 0 && state.deliveredJournalEvents > 0) {
      const receipt = state.receipts.shift();
      return Object.freeze({
        events: Object.freeze([buildEvent(state, receipt)]), done: false, skipped: 0,
      });
    }
    if (!state.terminal) {
      // 规则 2：循环拉取直到产出一条事件或流耗尽（跳过的只计数）。
      let skipped = 0;
      for (;;) {
        const next = await state.iterator.next();
        if (next.done) {
          // 流耗尽：若还有未交付的回执，先交付（终态之后也能观察到 ack）。
          if (state.receipts.length > 0) {
            const receipt = state.receipts.shift();
            return Object.freeze({
              events: Object.freeze([buildEvent(state, receipt)]), done: false, skipped,
            });
          }
          // 规则 3：无终态的耗尽 → 恰好一条合成 crashed（幂等）；再拉即 done。
          if (!state.exhausted) {
            state.exhausted = true;
            return Object.freeze({
              events: Object.freeze([
                buildEvent(state, { type: 'execution/crashed', reason: 'stream-ended' }),
              ]),
              done: false, skipped,
            });
          }
          return Object.freeze({ events: Object.freeze([]), done: true, skipped });
        }
        // 规则 2b（v0.6）：journal-seq 去重 —— 重挂 follow 后从头重放的旧事件
        //（seq ≤ 已交付的最大 journal seq）一律跳过。无数字 seq 的流保守放行。
        const rawSeq = next.value && typeof next.value.seq === 'number' && Number.isFinite(next.value.seq)
          ? next.value.seq
          : null;
        if (rawSeq !== null && state.lastJournalSeq !== null && rawSeq <= state.lastJournalSeq) {
          skipped += 1;
          continue;
        }
        if (rawSeq !== null) state.lastJournalSeq = rawSeq;
        const mapped = mapDshJournalEvent(next.value);
        if (!mapped.type) { skipped += 1; continue; }
        state.deliveredJournalEvents += 1;
        // 终态 completed 之前先物化 artifact（入 emissionQueue，下两次拉取按序交付）。
        await materializeArtifactsBeforeTerminal(state, mapped);
        if (state.emissionQueue.length > 0) {
          // 把 completed 也排队（在 artifact 之后），保持单出口的顺序语义。
          const terminalEvent = buildEvent(state, mapped);
          state.emissionQueue.push(terminalEvent);
          const first = state.emissionQueue.shift();
          return Object.freeze({ events: Object.freeze([first]), done: false, skipped });
        }
        return Object.freeze({
          events: Object.freeze([buildEvent(state, mapped)]), done: false, skipped,
        });
      }
    }
    // 终态之后：先清空未交付的回执，再把流剩余部分计数为 skipped（不再产终态）。
    if (state.receipts.length > 0) {
      const receipt = state.receipts.shift();
      return Object.freeze({
        events: Object.freeze([buildEvent(state, receipt)]), done: false, skipped: 0,
      });
    }
    let skipped = 0;
    for (;;) {
      const next = await state.iterator.next();
      if (next.done) break;
      skipped += 1;
    }
    return Object.freeze({ events: Object.freeze([]), done: true, skipped });
  }

  /**
   * `observe`：把"journal 流 → 执行事件流"包成 AsyncIterable。
   * 事件按需产出（pull 模型），**无 timers**。
   *
   * 注意一：`next()` **不能**因为一次"跳过"就判 done —— 未映射的 journal 事件不是
   * 流的结束，因此这里循环拉取直到真正产出一条事件或流确实耗尽。
   *
   * 注意二（v0.6 WP1b）：自然耗尽**不**闩死迭代器 —— 耗尽后 `pullEvents` 会快速
   * 幂等地返回 done，而 `resume()` 替换 `state.iterator` 后同一个 observe 迭代器
   * 必须能继续交付新事件（闭包 `closed` 只用于显式 `return()` 的消费方拆除）。
   * 闩死 `closed` 的旧实现会让 resume 后的 pumpOne 永远拿不到事件（实测踩过）。
   */
  function observe(handle) {
    const state = runs.get(handle.handleId);
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    let closed = false;
    const iterator = {
      async next() {
        if (closed) return { value: undefined, done: true };
        for (;;) {
          const result = await pullEvents(handle);
          if (result.events.length > 0) return { value: result.events[0], done: false };
          if (result.done) return { value: undefined, done: true };
        }
      },
      return() { closed = true; return Promise.resolve({ value: undefined, done: true }); },
    };
    return Object.freeze({ [Symbol.asyncIterator]: () => iterator });
  }

  /** 取下一个执行事件（null = 流当前没有新事实）。controller 的确定性拉取入口。
   *  注意：终态事件可能是**已构建但仍在队列里**（artifact → completed 按序交付），
   *  因此必须以"队列为空 + 已终态"判空，而不是一看到 terminal 就拒绝。 */
  async function nextEvent(handle) {
    const state = runs.get(handle.handleId);
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    if (state.emissionQueue.length > 0 || state.receipts.length > 0) {
      const result = await pullEvents(handle);
      return result.events.length > 0 ? result.events[0] : null;
    }
    if (state.terminal) return null;
    const result = await pullEvents(handle);
    return result.events.length > 0 ? result.events[0] : null;
  }

  /**
   * cancel：调用 transport 的 cancel RPC，成功后产出
   * `execution/cancel-requested` + `execution/cancel-acknowledged`（**都不是终态**）。
   * 注意：dsh **没有** journal ack 事件 —— ack 的来源是 RPC 一元响应
   * （office-module.js:3992-3995 的既有合成逻辑），本文件不伪造终态。
   */
  async function cancel(handle) {
    const state = runs.get(handle.handleId);
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    if (state.terminal) return Object.freeze({ acknowledged: false, code: 'EXEC_HANDLE_TERMINAL' });
    if (!transport) return Object.freeze({ acknowledged: false, code: 'EXEC_TRANSPORT_UNAVAILABLE' });
    let ack;
    try {
      ack = await transport.cancel({ sessionId: state.sessionId });
    } catch (error) {
      return Object.freeze({ acknowledged: false, code: error && error.code ? error.code : 'EXEC_EXECUTOR_ERROR' });
    }
    if (!ack || ack.ok !== true) {
      return Object.freeze({ acknowledged: false, code: (ack && ack.code) || 'EXEC_UNSUPPORTED' });
    }
    // 回执**入队**（不立刻分配 seq）：交付顺序由 pullEvents 保证 —— 必须排在
    // 已交付的 journal 事件之后，否则下游会把 started 当乱序。
    state.receipts.push({ type: 'execution/cancel-requested', reason: 'requested' });
    state.receipts.push({ type: 'execution/cancel-acknowledged', reason: 'acknowledged' });
    advanceClock(1); // 可注入的确定性推进（默认 no-op）
    return normalizeCancelAck({ acknowledged: true, atMs: clock.nowMs(), reason: 'dsh-transport' });
  }

  /**
   * resume（v0.6 WP1b）：attention 后的执行侧续跑 —— 对**同一会话**重挂 follow。
   *
   * - follow 无 resume cursor（重开即从头重放）：重放由 pullEvents 规则 2b 的
   *   journal-seq 去重吸收，只交付新事件；已入队的 emissionQueue/receipts 不受影响
   *   （规则 0/1 仍最优先）。
   * - 会话其实已跑完时，重挂回放会映射出 turn/end → 正常 completed（含 materializer）。
   * - 重挂后流立刻又结束且无新事件 → 下一次拉取会再合成一条 crashed(stream-ended)
   *   （"恢复后发现还是死的"保持可观测，绝不假装续跑成功）。
   * - 仅非终态会话可 resume；transport 未注入即诚实拒绝。
   */
  async function resume(handle) {
    const state = runs.get(handle.handleId);
    if (!state) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    if (state.terminal) throw execError('EXEC_HANDLE_TERMINAL', 'cannot resume a terminal execution');
    if (!transport) throw execError('EXEC_TRANSPORT_UNAVAILABLE', 'no transport injected');
    const stream = transport.follow({ sessionId: state.sessionId });
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw execError('EXEC_PORT_SHAPE_INVALID', 'transport.follow must return an AsyncIterable');
    }
    state.iterator = stream[Symbol.asyncIterator]();
    state.exhausted = false; // 新流重新计耗尽（再断流会再合成 crashed —— 诚实可观测）
    advanceClock(1); // 可注入的确定性推进（默认 no-op）
    return Object.freeze({ ok: true, resumed: true, atMs: clock.nowMs() });
  }

  function state(handle) {
    const run = runs.get(handle.handleId);
    if (!run) throw execError('EXEC_HANDLE_UNKNOWN', 'unknown execution handle');
    return Object.freeze({
      handleId: run.handle.handleId,
      role: run.role,
      seq: run.seq,
      emitted: run.emitted,
      terminal: run.terminal,
      terminalType: run.terminalType,
      produces: Object.freeze([...run.produces]),
      artifactEmitted: run.artifactEmitted,
      queued: run.emissionQueue.length,
      // **不**暴露 sessionId（raw 身份只在内层闭包里使用）。
    });
  }

  /** 能力自述：明确哪些事件类型本后端**能**产出（诚实清单）。 */
  function capability() {
    const hasMaterializer = !!(transport && typeof transport.artifactFor === 'function');
    // v0.6（WP1b）：crashed 由"流耗尽而无终态"合成 → 始终可产。
    const producible = EXECUTION_EVENT_TYPES.filter((type) => type !== 'execution/artifact' || hasMaterializer);
    return Object.freeze({
      backend: DSH_BACKEND_VERSION,
      transport: transport ? transport.describe() : null,
      network: false,
      transportInjected: transport !== null,
      sessionHook: typeof (transport && transport.resolveSession) === 'function' || sessionFor !== null,
      materializerHook: hasMaterializer,
      producibleEventTypes: Object.freeze(producible),
      unsupportedEventTypes: Object.freeze(hasMaterializer ? [] : ['execution/artifact']),
      supportsRecover: false,
      gaps: DSH_BACKEND_GAPS,
    });
  }

  return Object.freeze({
    // 端口（契约 §5.1）—— recover **不**实现，但显式声明 unsupported（不是静默缺失）。
    startRun,
    observe,
    nextEvent,
    cancel,
    resume,
    unsupported: Object.freeze(['recover']),
    // 诊断
    state,
    capability,
    mapping: DSH_EXECUTION_MAPPING,
    stats: () => Object.freeze({ runs: runs.size, startCalls }),
    describe: () => Object.freeze({
      backend: DSH_BACKEND_VERSION,
      clock: 'injected',
      transportInjected: transport !== null,
      sessionHookInjected: sessionFor !== null,
      driver: 'async iterator (no timers, no network)',
    }),
  });
}

module.exports = {
  createDshExecutionBackend,
  createInjectedTransport,
  mapDshJournalEvent,
  coarseReasonOf,
  DSH_EXECUTION_MAPPING,
  DSH_BACKEND_GAPS,
  DSH_BACKEND_VERSION,
};