// src/ipc-mission.js — Mission Core 的 IPC 接线（P1）。
//
// 第一性原理：为什么是"一个通道 + action 判别式"，而不是每个操作一个通道
//
//   本仓库已有两条先例：
//     · office:* 用 OFFICE_IPC_CHANNELS 冻结集合 + action 判别式（9 个通道覆盖 20+ 操作）
//     · shell:*  每个操作一个通道（74 个，是 main.js 过载的主因，TD-01）
//
//   Mission 的操作数是 10+（list / get / create / updateStatus / addWorkstream /
//   recordDecision / openQuestion / answerQuestion / registerDeliverable /
//   getBrief / verifyDeliverables）。若每个都开一个通道，会立刻复制 shell:* 的问题。
//   所以走 office:* 那条路：**单一通道 `mission:invoke` + `{action, payload}`**。
//
//   这样做的额外好处：通道集合冻结后（`MISSION_IPC_CHANNELS`），
//   `test/ipc-contract.test.js` 的契约快照能立刻发现任何通道漂移——
//   而新增 action 不需要改通道集合，不会产生假红。
//
// 第二性原理：为什么这里是"薄壳"，业务全在 src/mission/**
//
//   IPC 层只做三件事：参数形状校验、错误转成 {ok:false}、不泄露异常。
//   所有语义（校验/投影/预算/迁移）都在 mission 模块里，可被纯 Node 测试。
//   这保证 IPC 层可以极薄，且将来换传输（比如本地 socket）时不用重写业务。
//
// 依赖注入（不让 mission 依赖 Electron）：
//   workspaceDir 由组合根每次调用时提供（用户可能切换工作区），
//   所以这里不缓存 store —— 缓存会让"切换工作区后看不到新 Mission"变成隐蔽 bug。
//   但 store 内部有内存投影，重复 createMissionStore 会重复读日志。
//   折中：按 resolved 绝对路径做一级缓存，路径变化时自动失效。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createMissionStore } = require('./mission/store');
const reconcileModule = require('./mission/reconcile');
const receiptModule = require('./mission/receipt');
const railOrder = require('./mission/rail-order');
const dispatchConfirmModule = require('./mission/dispatch-confirm');
const dispatchStrategy = require('./mission/dispatch-strategy');
const interventionAudit = require('./mission/intervention-audit');
const auditStore = require('./mission/audit-store');
const brief = require('./mission/brief');
const deliverable = require('./mission/deliverable');
const harnessReader = require('./mission/harness-reader');
const migration = require('./mission/migration');
const schema = require('./mission/schema');
const taskRef = require('./mission/task-ref');
const briefSync = require('./mission/brief-sync');

/** 冻结的通道集合。新增 action **不需要**动这里。 */
const MISSION_IPC_CHANNELS = Object.freeze(['mission:invoke']);

/** 所有支持的 action。未知 action 明确失败（不静默返回空）。 */
const ACTIONS = Object.freeze([
  'list',                 // 列出当前工作区的 Mission（含 live 派生）
  'get',                  // 单个 Mission 的完整视图
  'create',               // 新建 Mission
  'updateStatus',         // 改 Mission 状态（active/paused/completed/abandoned）
  'update',               // 改标题等可写字段
  'addWorkstream',        // 新建 Workstream
  'updateWorkstreamStatus',
  'recordDecision',       // 记录决策（含 rationale）
  'openQuestion',
  'answerQuestion',
  'registerDeliverable',  // 登记产物（自动算 digest）
  'linkTaskRef',          // 关联一次 Harness 执行到某个 Workstream（只存派生句柄）
  'listTaskRefs',         // 只读：某个 Mission 关联了哪些执行
  'verifyDeliverables',   // 校验产物是否仍与登记时一致
  'getBrief',             // 生成 Mission Brief
  'diagnostics',          // 日志健康度 / 备份 / 归档状态 / 迁移计划
  'openDesk',             // 打开 Mission Desk 窗口
  'syncBrief',            // 把 Brief 写入 <workspace>/AGENTS.md（下次会话自动生效）
  'unsyncBrief',          // 移除 Brief 块（只删标记块，不删文件）
  'briefSyncState',       // 只读：当前 AGENTS.md 同步到了哪个 Mission
  'attention',            // 只读：需要用户处理的待办（从 office 快照聚合，不复制状态）
  'sinceLastSeen',        // 只读：上次查看该 Mission 之后发生的变化
  'markSeen',             // 只写 UI 偏好：记录"我刚刚看过这个 Mission"
  // Shared Context 三实体（2026-11-01）
  'recordFinding',
  'updateFindingStatus',
  'recordAssumption',
  'updateAssumptionStatus',
  'recordEvidence',
  'sessionProjections',   // 只读：向运行时要结构化投影（含 userQuestions.options）
  'bindSession',          // 只写 UI 绑定：把 Mission 关联到一个 Harness 会话
  'getBoundSession',      // 只读：这个 Mission 绑定了哪个会话
  'workStatus',           // 只读：这次执行跑到哪了（turns/steps/是否在跑）
  'harvestDeliverables',  // 从 Agent 回复里找**真实存在**的产物，登记成 Deliverable
  'confirmDispatch',      // 只读：派发后轮询"投影里有没有出现对应任务"（S2）
  'interventionHistory',  // 只读：最近的干预记录（S6，闭集字段，无内容）
  'interveneMember',      // S6：对成员转达消息 / 中断（经 Lead，非直连）
  'rewriteTask',          // S6：改写 / 重分配团队任务（带 CAS，经 Lead）
]);

function nowMs() { return Date.now(); }

/**
 * 给 user question 的 `detail` 加上长度上限。
 *
 * 为什么需要：detail 是 plan-review 的完整计划 markdown，可能非常长。
 * 它会穿过 IPC 到渲染层，而 380px 侧栏实际能展示的部分很有限。
 * 实测一个 5MB 的 detail 会原样透传，纯属浪费。
 *
 * 超出上限时截断并加 `detailTruncated: true` 标记 —— **不能静默丢**，
 * 否则用户会以为计划就这么多内容。
 */
const MAX_QUESTION_DETAIL_CHARS = 64 * 1024; // 64k 字符，足够放很长的计划

function trimQuestionDetail(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const questions = Array.isArray(entry.questions) ? entry.questions : null;
  if (!questions) return entry;
  return {
    ...entry,
    questions: questions.map((q) => {
      if (!q || typeof q !== 'object') return q;
      const detail = typeof q.detail === 'string' ? q.detail : null;
      if (detail === null || detail.length <= MAX_QUESTION_DETAIL_CHARS) return q;
      return {
        ...q,
        detail: detail.slice(0, MAX_QUESTION_DETAIL_CHARS),
        detailTruncated: true,
        detailFullLength: detail.length,
      };
    }),
  };
}

/**
 * 归一化 agentTeam 投影。
 *
 * 实测真实形状（2026-11-02，让 Lead 调 team_task_create 后拿到）：
 *
 *   { members: [{id,name,role,phase}],
 *     tasks: [{id,revision,subject,description,status,
 *              blockedBy:[],writeScopes:[],ready:boolean,writeScopeWarnings:[]}] }
 *
 * **只透传，不加工**：blockedBy / ready / writeScopes 都是官方算好的，
 * 我们不重新推导（那会变成第二个事实作者）。
 *
 * 缺 key 时返回 null —— 调用方据此**不显示团队区块**，
 * 而不是显示"0 个成员"。
 */
function normalizeAgentTeam(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const members = Array.isArray(raw.members) ? raw.members : null;
  const tasks = Array.isArray(raw.tasks) ? raw.tasks : null;
  if (members === null && tasks === null) return null;

  const normMembers = (members || [])
    .filter((m) => m && typeof m === 'object' && typeof m.id === 'string')
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : '',
      role: m.role === 'lead' ? 'lead' : 'teammate',
      phase: typeof m.phase === 'string' ? m.phase : 'active',
    }));

  const normTasks = (tasks || [])
    .filter((t) => t && typeof t === 'object' && typeof t.id === 'string')
    .map((t) => ({
      id: t.id,
      revision: Number.isFinite(t.revision) ? t.revision : 0,
      subject: typeof t.subject === 'string' ? t.subject : '',
      status: typeof t.status === 'string' ? t.status : 'pending',
      ownerName: typeof t.ownerName === 'string' ? t.ownerName : null,
      // 官方算好的，原样透传
      blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter((x) => typeof x === 'string') : [],
      ready: t.ready === true,
      writeScopes: Array.isArray(t.writeScopes) ? t.writeScopes.filter((x) => typeof x === 'string') : [],
      writeScopeWarnings: Array.isArray(t.writeScopeWarnings)
        ? t.writeScopeWarnings.filter((x) => typeof x === 'string') : [],
    }));

  return {
    members: normMembers,
    tasks: normTasks,
    // failure 有值时 members/tasks 会**停留在最后一次有效状态**——
    // 那时不能把任务列表标为实时（官方注释明确说了）。
    failure: typeof raw.failure === 'string' ? raw.failure : null,
  };
}

/**
 * 归一化 inbox 投影（排队中的用户输入）。
 *
 * 官方结构：`{ nextTurn: UserMessage[], nextStep: UserMessage[] }`
 *   · nextTurn = 等待后续单独执行的消息（用户排队交代的任务）
 *   · nextStep = 等待下一个 Agent 步骤的输入
 *
 * 为什么值得展示：用户连续交代几件事后，如果看不到队列，
 * 会误以为 Agent 没收到。这是**执行透明度**，不是任务管理。
 *
 * **只取计数和极简摘要**，不把完整消息搬进右栏（那是第二个聊天框）。
 */
function normalizeInbox(raw) {
  const empty = { nextTurnCount: 0, nextStepCount: 0, preview: null };
  if (!raw || typeof raw !== 'object') return empty;
  const turn = Array.isArray(raw.nextTurn) ? raw.nextTurn : [];
  const step = Array.isArray(raw.nextStep) ? raw.nextStep : [];
  const pickText = (m) => {
    if (!m || typeof m !== 'object') return null;
    if (typeof m.text === 'string' && m.text.trim()) return m.text.trim().slice(0, 80);
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          return part.text.trim().slice(0, 80);
        }
      }
    }
    return null;
  };
  return {
    nextTurnCount: turn.length,
    nextStepCount: step.length,
    // 只给第一条的摘要，用来让用户认出"这是我刚才交代的那件事"
    preview: pickText(turn[0]) || pickText(step[0]) || null,
  };
}

/** Mission id 形状（与 schema 一致）：mis-<opaque>。 */
function isId(v) { return typeof v === 'string' && /^mis-[A-Za-z0-9][A-Za-z0-9-]*$/.test(v); }

// ---------------------------------------------------------------------------
// 派发指令渲染（S2，2026-11-04）—— 纯函数，零 IO，可离线测试
//
// 第一性原理：为什么"派发"要是一个可测试的纯函数
//
//   我们没有 remote 写表面（D11：agent-team 不暴露 RPC），所以派发的**唯一**
//   实现方式是"给 Lead 发一段结构化指令，让它去调 spawn_teammate/team_task_create"。
//   这段文字因此不是 UI 文案，而是**执行契约的传输格式**：
//     它的每一个字段都必须能被测试断言，否则"合同写进去了没有"只能靠肉眼。
//
//   三个必须由测试锁住的语义：
//     1. 幂等键出现在**固定首行**（确认阶段靠它匹配，位置一漂移就匹配不上）
//     2. 验收条件必须逐条出现在指令里（否则 Agent 看不见就等于没有）
//     3. 没有合同时**退回旧行为**（不能因为新功能让老 Mission 派发失败）
// ---------------------------------------------------------------------------

/** 幂等键在指令首行的固定标记。**改动这个字符串会破坏所有已下达的确认匹配。** */
const DISPATCH_KEY_PREFIX = '[mission-dispatch:';

/**
 * 构造派发指令。
 *
 * @param {object} input
 * @param {object} input.mission       Mission 实体（title / intent / constraints / contract）
 * @param {string} input.task          本次任务描述（用户原话）
 * @param {string} input.dispatchKey   幂等键（同一次下达保持相同）
 * @returns {string} 要发给 Lead 的完整指令文本
 */
function renderDispatchInstruction({ mission, task, dispatchKey } = {}) {
  const m = mission && typeof mission === 'object' ? mission : {};
  const lines = [];

  // 1) 固定首行：幂等键。确认阶段用 DISPATCH_KEY_PREFIX 匹配，
  //    所以它必须在第一行、且格式稳定。
  if (typeof dispatchKey === 'string' && dispatchKey) {
    lines.push(`${DISPATCH_KEY_PREFIX}${dispatchKey}]`);
  }

  // 2) 任务书主体
  lines.push('【Mission】' + (m.title || m.missionId || '(未命名)'));
  if (m.intent) lines.push('目标：' + m.intent);
  const constraints = Array.isArray(m.constraints) ? m.constraints.filter((c) => c && c.text) : [];
  for (const c of constraints) lines.push('约束：' + c.text);

  // 3) 合同：验收条件逐条列出，并明确要求 Agent 把它们落到任务板上。
  //    为什么逐条列而不是概括：Agent 只有「看见」某条验收才能为它负责；
  //    概括成"按合同验收"等于什么都没说。
  const contract = m.contract && typeof m.contract === 'object' ? m.contract : null;
  if (contract && Array.isArray(contract.acceptance) && contract.acceptance.length > 0) {
    lines.push('');
    lines.push('【验收条件】以下每一条都必须被验证，未通过不算完成：');
    contract.acceptance.forEach((a, i) => {
      if (!a || typeof a.text !== 'string') return;
      let line = `${i + 1}. ${a.text}`;
      if (a.kind === 'command' && typeof a.command === 'string') {
        line += `（验证方式：执行 \`${a.command}\`，退出码 0 才算通过）`;
      } else if (a.kind === 'artifact' && typeof a.artifactRef === 'string') {
        line += `（验证方式：产出文件 ${a.artifactRef} 并确认存在）`;
      } else if (a.kind === 'manual') {
        line += '（验证方式：由人确认）';
      }
      lines.push(line);
    });
    if (contract.budget && Number.isFinite(contract.budget.maxTokens)) {
      lines.push('');
      lines.push(`【预算】最多 ${contract.budget.maxTokens} tokens，超出请停下并汇报。`);
    }
  }

  // 4) 本次任务
  lines.push('');
  lines.push('【本次任务】');
  lines.push(typeof task === 'string' ? task : '');

  // 5) 落板要求：把验收条件写进团队任务板，而不是只在对话里承诺。
  //    这样右栏与 Harness 都能读到"这次做到什么程度算完"。
  if (contract && Array.isArray(contract.acceptance) && contract.acceptance.length > 0) {
    lines.push('');
    lines.push('【要求】请用 team_task_create 把上面的验收条件写进团队任务板'
      + '（subject 概括任务，description 里逐条列出验收条件），然后再开始执行。');
  }

  // 6) 派发策略（S2）：由**确定性规则**算出"该由几个人做"，而不是让模型自己看着办。
  //
  //    实证结论（Google Research 180 配置实验，按博客摘要引用）：
  //    多 Agent 在可并行任务上更好，顺序推理任务上反而更差。
  //    所以"起几个成员"是任务结构的函数，不是性能旋钮。
  //
  //    为什么把结论写进指令而不是只存字段：Lead 是唯一能调 spawn_teammate 的角色。
  //    我们不告诉它该几个人，它就会按自己的直觉起团队 —— 而那个直觉往往倾向于
  //    "多派几个人显得努力"。
  if (contract) {
    // 冲突信号必须传进去：合同里若声明了重叠的写入范围，
    // "并行"就是错的（冲突代价远高于并行收益）。漏传会让这条规则静默失效。
    const decided = dispatchStrategy.decideStrategy({
      contract,
      memberBudget: Number.isFinite(contract.maxMembers) ? contract.maxMembers : 4,
      sharedWriteScopes: Number.isFinite(contract.sharedWriteScopes) ? contract.sharedWriteScopes : 0,
      hasDependencies: contract.hasDependencies === true,
    });
    const resolved = dispatchStrategy.resolveStrategy({
      decision: decided,
      override: contract.strategy,
    });
    lines.push('');
    lines.push('【执行规模】' + resolved.reason);
    if (resolved.strategy === 'single') {
      lines.push('请自己完成，**不要**派生 teammate（这个任务没有可并行的独立部分）。');
    } else if (resolved.strategy === 'sequential') {
      lines.push('可以拆成有序任务链，但同一时刻只让一个成员执行（有依赖）。');
    } else if (resolved.strategy === 'parallel') {
      lines.push('验收条件相互独立，可以派生成员并行推进；每个成员负责一组独立验收条件。');
    }
    if (resolved.source === 'user') {
      lines.push('（执行规模是用户明确指定的，以此为准。）');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 成员干预指令（S6 纠偏）—— 纯函数
//
// 第一性原理：为什么"对成员说话"必须经 Lead，而不是直接发给成员
//
//   协议层的硬约束（S0 实测，D11）：agent-team 没有 remote 写表面。
//   send_message / interrupt_agent 只存在于**模型侧工具**里。
//   也就是说：壳层没有"直接对某个 teammate 说话"的能力。
//
//   这看起来是限制，但它和官方的团队语义是一致的：Lead 是协调者，
//   所有对成员的干预都应经它转达 —— 否则成员会收到两个来源的指令
//   （用户的 + Lead 的），而它无法判断谁优先。
//
//   所以我们的产品动作是：把用户的意图**渲染成给 Lead 的指令**，
//   由 Lead 决定怎么转达。这既符合协议，也避免了"越过 Lead 指挥成员"
//   导致的状态不一致。
//
//   关键：**用户的原文必须原样传下去**，我们只加必要的框架
//   （目标成员、要做什么），不改写、不概括。改写会让用户的话失真。
// ---------------------------------------------------------------------------

/**
 * 渲染"对某个成员采取干预"的指令。
 *
 * @param {object} input
 * @param {'message'|'interrupt'} input.kind
 * @param {string} input.memberName   目标成员名（协议层的 target）
 * @param {string} [input.message]    kind=message 时的原文（**不改写**）
 * @param {string} [input.reason]     用户给出的原因（可选，用于审计与上下文）
 * @returns {string}
 */
function renderMemberIntervention({ kind, memberName, message, reason } = {}) {
  const lines = [];
  const name = typeof memberName === 'string' ? memberName.trim() : '';

  if (kind === 'interrupt') {
    lines.push(`【干预】请用 interrupt_agent 中断成员 "${name}" 当前这一轮。`);
    lines.push('只中断它正在做的事，不要停掉整个团队，也不要删除它的任务。');
    if (reason) lines.push(`原因：${reason}`);
    lines.push('中断后一句话汇报：它当时在做什么、停在了哪里。');
    return lines.join('\n');
  }

  // kind === 'message'
  lines.push(`【干预】请用 send_message 把下面这段话转达给成员 "${name}"。`);
  lines.push('不要改写、不要概括、不要替它执行。原样转达即可。');
  if (reason) lines.push(`这么说的原因：${reason}`);
  lines.push('');
  lines.push('【要转达的原话】');
  lines.push(typeof message === 'string' ? message : '');
  lines.push('');
  lines.push('转达后一句话说明：消息已发出（不代表对方已处理）。');
  return lines.join('\n');
}

/**
 * 构造一次执行的凭证（S5）。
 *
 * 第一性原理：为什么凭证必须"两步都成功"才算 verified
 *
 *   用户问的是"我能不能信这件事做完了"。回答它需要一条**可复核的坐标**：
 *   去官方那里按坐标取回变更清单，看到了才叫复核过。
 *
 *   少任何一步都只能叫 claimed：
 *     · 没有 seq   → 不知道去哪取（不是"没变更"）
 *     · 有 seq 但读不到 → 可能是 Session 已 dispose（官方清单不持久）
 *   把这两种都说成"没变更"是在撒谎；说成"已复核"更是。
 *
 * @param {object} input
 * @param {object|null} input.bound      绑定信息 {sessionId}
 * @param {number|null} input.lastTurn
 * @param {string} input.lastResponse
 * @returns {Promise<{state:string, description:string, reason:string, turn?:number|null, total?:number|null}>}
 */
async function buildReceiptFor({ bound, lastTurn, lastResponse, deps = {} } = {}) {
  // 依赖显式传入，不靠闭包。
  // 教训：这个函数原本是模块级的，却直接引用了 registerMissionIpc 参数里的
  // seqOfTurn/changesSummaryOf —— 那是**闭包外**的标识符，永远是 undefined，
  // 于是凭证永远停在 claimed，而且不报错（静默失效）。
  // 现在把依赖作为参数传，谁调用谁负责提供。
  const { seqOfTurn, changesSummaryOf } = deps;
  const claimReason = (lastResponse && String(lastResponse).length > 0)
    ? '团队已给出回复，但尚未绑定可复核的变更坐标'
    : '团队尚未产出可复核的结果';

  // 未绑定会话 → 没有执行，不伪造凭证
  if (!bound || !bound.sessionId) {
    return { state: 'claimed', description: '尚未开始执行，没有可复核的内容', reason: '这个 Mission 还没有绑定执行会话' };
  }

  // ① 取 seq
  let seq = null;
  if (typeof seqOfTurn === 'function') {
    try { seq = seqOfTurn(bound.sessionId, lastTurn); } catch { seq = null; }
  }
  if (!Number.isFinite(seq)) {
    return {
      state: 'claimed',
      description: '团队已给出回复，但尚未绑定可复核的变更坐标',
      reason: '还没有观测到这一轮的变更事件（可能刚结束，或运行时未连接）',
    };
  }

  // ② 按 seq 读清单
  let summary = null;
  let readFailed = null;
  if (typeof changesSummaryOf === 'function') {
    try {
      const res = await changesSummaryOf(bound.sessionId, seq);
      if (res && res.ok) summary = res.value;
      else readFailed = (res && res.reason) || 'unknown';
    } catch (err) {
      readFailed = err.message;
    }
  } else {
    readFailed = 'changesSummaryOf is not wired';
  }

  if (!summary) {
    return {
      state: 'claimed',
      description: '团队已给出回复，但变更清单读不到',
      reason: `有变更坐标（seq=${seq}）但读取失败：${readFailed || '未知原因'}`,
      turn: lastTurn,
    };
  }

  // 拿到了真实清单 → 可复核。
  //
  // sessionRef 必须是**派生句柄**（sess-h-…），不能是 raw sessionId，
  // 也不能是占位字符串 —— schema.validateReceipt 会拒绝后者，
  // 届时整个凭证静默不落盘（这正是本项目反复踩的坑）。
  const refOut = taskRef.deriveHarnessRef({ sessionId: bound.sessionId });
  if (!refOut.ok) {
    return {
      state: 'claimed',
      description: '团队已给出回复，但无法生成可复核的引用',
      reason: `派生引用失败：${refOut.reason || refOut.code}`,
    };
  }
  const derived = receiptModule.buildReceiptCoordinate({
    sessionRef: refOut.ref, seq, turn: lastTurn, summary,
  });
  const state = receiptModule.deriveReceiptState({ receipt: derived, resolvable: true });
  return {
    state,
    description: receiptModule.describeReceipt({ receipt: derived, resolvable: true }),
    reason: summary.total === 0
      ? '已复核：这一轮没有文件变更（团队可能只是回答了一个问题）'
      : `已复核：这一轮变更了 ${summary.total} 个文件`,
    turn: lastTurn,
    total: Number.isFinite(summary.total) ? summary.total : null,
    // 可落盘的坐标（由调用方决定是否 append）。只在 verified 时给出。
    coordinate: derived,
  };
}

/**
 * 渲染"改写/重分配团队任务"的指令（S6）。
 *
 * 第一性原理：为什么任务修改也必须经 Lead，而不是我们直接写
 *
 *   S0 实测（D11 + 本轮复核）：`dsh-experimental-agent-team` 包里
 *   只有 index.js 和 types，**没有 typert/remote 表面**。
 *   也就是说壳层没有任何"直接改任务板"的 RPC。
 *
 *   唯一的写路径是：发指令给 Lead，由它调 team_task_update。
 *   所以这个函数渲染的是**意图**，不是执行。
 *
 *   CAS 的诚实处理（U-4 实测：过期 revision 会被拒绝，状态完全不变）：
 *   我们把 expectedRevision 显式写进指令，让 Lead 用当前值。
 *   如果它在提交前被别人改过，官方会拒绝 —— 那是**正确的行为**，
 *   我们不做"自动重试覆盖"，因为那等于替用户决定"谁赢"。
 *
 * @param {object} input
 * @param {'edit'|'reassign'} input.kind
 * @param {string} input.taskId
 * @param {number} input.expectedRevision
 * @param {string} [input.subject]       kind=edit 时的新标题
 * @param {string} [input.description]   kind=edit 时的新描述
 * @param {string} [input.owner]         kind=reassign 时的新负责人
 * @param {string} [input.reason]
 * @returns {string}
 */
function renderTaskRewriteInstruction({ kind, taskId, expectedRevision, subject, description, owner, reason } = {}) {
  const lines = [];
  const id = typeof taskId === 'string' ? taskId.trim() : '';
  const rev = Number.isFinite(expectedRevision) ? expectedRevision : null;

  if (kind === 'reassign') {
    const to = typeof owner === 'string' ? owner.trim() : '';
    lines.push(`【干预】请用 team_task_update 把任务 ${id} 重新分配。`);
    lines.push(`action: reassign，owner: "${to}"，expectedRevision: ${rev === null ? '（用你读到的最新值）' : rev}`);
    lines.push('只改负责人，不要改写任务内容，也不要改它的依赖关系。');
  } else {
    lines.push(`【干预】请用 team_task_update 改写任务 ${id}。`);
    lines.push(`action: edit，expectedRevision: ${rev === null ? '（用你读到的最新值）' : rev}`);
    lines.push('');
    lines.push('【新的任务内容】');
    if (typeof subject === 'string' && subject.trim()) lines.push(`标题：${subject.trim()}`);
    if (typeof description === 'string' && description.trim()) {
      lines.push('描述：');
      lines.push(description);
    }
    lines.push('');
    lines.push('按上面给的内容改写，不要自己增补需求。');
  }
  if (reason) lines.push(`原因：${reason}`);

  // CAS 的诚实说明：被拒绝是正确的，不要绕过
  lines.push('');
  lines.push('如果 expectedRevision 过期而被拒绝，**不要重试**，'
    + '直接告诉我"任务已被别人改过，请重新查看后再改"。');
  return lines.join('\n');
}

/** 从一段指令文本里取出幂等键；没有则 null。 */
function parseDispatchKey(text) {
  if (typeof text !== 'string') return null;
  const firstLine = text.split('\n', 1)[0] || '';
  if (!firstLine.startsWith(DISPATCH_KEY_PREFIX) || !firstLine.endsWith(']')) return null;
  const key = firstLine.slice(DISPATCH_KEY_PREFIX.length, -1);
  return key || null;
}

// ---------------------------------------------------------------------------
// lastSeenAtMs —— UI 偏好，不是项目事实
//
// 第一性原理：为什么它不能写进 Mission 实体
//
//   Mission 事件日志是**事实记录**：谁在什么时候决定了什么。
//   "我上次看这个 Mission 是什么时候"不是事实，是**本机的浏览偏好**。
//
//   schema.js 的 FORBIDDEN_PERSISTED_FIELDS 已经把 focused 这类
//   UI 偏好列进黑名单，理由相同：一旦写进项目数据，就会跟着 Mission
//   同步给别的机器、别的用户，而它对别人毫无意义。
//
//   所以存 `<workspace>/.dsh/ui-seen.json`，与 office-state 同级。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mission ↔ Harness 会话绑定
//
// 第一性原理：为什么需要它
//
//   用户创建 Mission 后**无事可做**——这是最严重的产品问题。
//   Mission 只能"记录"工作，不能"启动"工作。
//
//   启动工作需要一个 Harness 会话。但 Mission 按隐私规则**不存 raw sessionId**
//   （只存派生句柄 sess-h-*），所以绑定必须存别处。
//
//   存 `<workspace>/.dsh/mission-sessions.json`，与 ui-seen.json 同级。
//   理由同 lastSeenAtMs：这是**本机的执行绑定**，不是项目事实，
//   不该进事件日志（否则会跟着项目同步给别人，而对别人毫无意义）。
// ---------------------------------------------------------------------------

const BIND_FILE = 'mission-sessions.json';

function bindFilePath(workspaceDir) {
  return path.join(workspaceDir, '.dsh', BIND_FILE);
}

function readBindMap(workspaceDir) {
  try {
    const raw = fs.readFileSync(bindFilePath(workspaceDir), 'utf8');
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed.sessions === 'object' && parsed.sessions ? parsed.sessions : {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof k === 'string' && v && typeof v === 'object' && typeof v.sessionId === 'string') {
        out[k] = { sessionId: v.sessionId, boundAtMs: Number.isFinite(v.boundAtMs) ? v.boundAtMs : 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeBindMap(workspaceDir, map) {
  const dir = path.join(workspaceDir, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const file = bindFilePath(workspaceDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: map }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const SEEN_FILE = 'ui-seen.json';

function seenFilePath(workspaceDir) {
  return path.join(workspaceDir, '.dsh', SEEN_FILE);
}

function readSeenMap(workspaceDir) {
  try {
    const raw = fs.readFileSync(seenFilePath(workspaceDir), 'utf8');
    const parsed = JSON.parse(raw);
    const map = parsed && typeof parsed.seen === 'object' && parsed.seen ? parsed.seen : {};
    const out = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof k === 'string' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    // 读不到 = 没看过。不猜、不报错（首次运行就是这种状态）。
    return {};
  }
}

function readSeenAt(workspaceDir, missionId) {
  const v = readSeenMap(workspaceDir)[missionId];
  return Number.isFinite(v) ? v : null;
}

function writeSeenAt(workspaceDir, missionId, atMs) {
  const map = readSeenMap(workspaceDir);
  map[missionId] = atMs;
  const dir = path.join(workspaceDir, '.dsh');
  fs.mkdirSync(dir, { recursive: true });
  const file = seenFilePath(workspaceDir);
  const tmp = `${file}.tmp`;
  // 原子写：先写临时文件再 rename，避免半截 JSON 让下次读失败
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, seen: map }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function argString(v) { return typeof v === 'string' ? v.trim() : ''; }

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {Function} ctx.workspaceDirOf   () => 当前工作区绝对路径（每次调用时求值）
 * @param {Function} [ctx.snapshotOf]     () => Harness 原始快照（可缺）
 * @param {Function} [ctx.clock]          () => Date.now()
 * @param {Function} [ctx.openDeskWindow] () => void  打开 Mission Desk 窗口
 * @param {Function} [ctx.log]
 */
function registerMissionIpc(ipcMain, ctx) {
  const {
    workspaceDirOf,
    snapshotOf = () => null,
    clock = nowMs,
    openDeskWindow = null,
    // 只读的运行时投影获取器（由 main.js 注入，内部走 mux.call）。
    // 注入而不是直接 require mux：ipc-mission 保持纯 Node 可测。
    projectionsOf = null,
    // 启动/续接 Harness 会话的能力（由 main.js 注入，内部走 harness-rpc）。
    // 这是解决"创建 Mission 后无事可做"的核心：Mission 必须能**启动工作**，
    // 而不只是记录工作。
    ensureSession = null,   // (missionId) => Promise<{ok, sessionId}>
    promptSession = null,   // (sessionId, text) => Promise<{ok, reason?}>
    cancelSession = null,   // (sessionId) => Promise<{ok, reason?}>  停止执行（S6）
    seqOfTurn = null,       // (sessionId, turn) => seq|null   变更清单的坐标（S5）
    changesSummaryOf = null, // (sessionId, seq) => Promise<{ok, value?}>  读变更清单（S5）
    log = () => {},
  } = ctx;

  // 按 resolved 路径缓存 store：切换工作区时自动重建
  let cachedKey = null;
  let cachedStore = null;

  // 干预审计日志（S6）：进程内的有界环，回答"刚才我做了什么"。
  // 不落盘：落盘涉及格式版本/轮转/隐私扫描，是独立工程。
  const interventionLog = interventionAudit.createInterventionLog();

  /**
   * 记录一次干预：内存环 + 磁盘镜像。
   *
   * 第一性原理：为什么要两份
   *
   *   内存环 —— 让"刚才我做了什么"能在毫秒内读回来，UI 不用等 IO。
   *   磁盘   —— 让它在重启之后还在。审计的全部价值就在"事后回看"，
   *             只活一次进程的审计等于没有审计。
   *
   *   落盘失败**不影响**记录成功：用户停了团队，不能因为审计写不进去而报错。
   *   但失败会被 log 出来，不静默。
   */
  function recordIntervention(workspaceDir, input) {
    const r = interventionLog.record(input);
    if (r && r.ok && r.entry) {
      auditStore.appendAudit(workspaceDir, r.entry, { log });
    }
    return r;
  }

  function storeFor(workspaceDir) {
    const key = path.resolve(String(workspaceDir));
    if (cachedKey !== key) {
      cachedStore = createMissionStore({ workspaceDir: key, now: clock, log });
      cachedKey = key;
      // 重启对账（S4）：把上次进程留下的、肯定不可能再推进的中间态纠正掉。
      //
      // 为什么放在"store 刚建好"这一刻：这是进程生命周期里唯一确定
      // "之前那个进程已经死了"的时点。放在别处（比如每次读取时）会重复对账，
      // 而且无法区分"重启"和"运行中"。
      //
      // 为什么失败不阻断：对账是修复动作，不是使用前提。
      // 一份卡住的合同不该让整个 Mission 面板打不开。
      try { reconcileOnLoad(cachedStore); } catch (err) {
        log(`[mission] reconcile on load failed: ${err.message}`);
      }
    }
    return cachedStore;
  }

  /**
   * 执行一次性重启对账。**只在 store 刚创建时调用**。
   *
   * 写盘走 store.append 的单写者通道；对账逻辑本身是纯函数
   * （src/mission/reconcile.js），这里只负责把它的结论落地。
   *
   * @param {object} store createMissionStore 的返回值
   */
  function reconcileOnLoad(store) {
    let missions;
    try { missions = store.listMissions(); } catch { return; }
    if (!Array.isArray(missions)) return;
    let fixed = 0;
    for (const row of missions) {
      const missionId = row && row.missionId;
      if (!isId(missionId)) continue;
      let view;
      try { view = store.missionView(missionId); } catch { continue; }
      if (!view) continue;
      const result = reconcileModule.reconcileMissionView(view, clock());
      for (const event of result.events) {
        try {
          const appended = store.append(event.type, event.payload, { atMs: clock() });
          if (appended) fixed += 1;
          else log(`[mission] reconcile append rejected for ${missionId}`);
        } catch (err) {
          log(`[mission] reconcile append threw for ${missionId}: ${err.message}`);
        }
      }
      for (const reason of result.reasons) log(`[mission] reconciled ${missionId}: ${reason}`);
    }
    if (fixed > 0) log(`[mission] reconcile on load fixed ${fixed} stuck contract state(s)`);
  }

  /** 统一的错误包装：任何异常都不泄露给 renderer。 */
  function fail(reason, code) {
    return { ok: false, reason: String(reason || 'unknown error'), ...(code ? { code } : {}) };
  }

  /** 取 store 或返回"没有工作区"的失败。 */
  function requireStore() {
    let dir;
    try {
      dir = workspaceDirOf();
    } catch (err) {
      return { ok: false, reason: `cannot resolve workspace: ${err.message}` };
    }
    if (!dir || typeof dir !== 'string') {
      return { ok: false, reason: 'no workspace selected' };
    }
    try {
      return { ok: true, store: storeFor(dir), workspaceDir: path.resolve(dir) };
    } catch (err) {
      return { ok: false, reason: `cannot open mission store: ${err.message}` };
    }
  }

  /** 把 Harness 原始快照归一化（只读，且必须带时间戳）。 */
  function currentSnapshot() {
    let raw;
    try {
      raw = snapshotOf();
    } catch {
      return null;
    }
    if (!raw) return null;
    const at = Number(raw.observedAtMs);
    const norm = harnessReader.normalizeSnapshot(raw, Number.isFinite(at) ? at : clock());
    return norm.ok ? norm.snapshot : null;
  }

  // ---------------------------------------------------------------- actions

  const handlers = {
    list() {
      const r = requireStore();
      if (!r.ok) return r;
      const missions = r.store.listMissions();
      const views = missions.map((m) => r.store.missionView(m.missionId)).filter(Boolean);
      const snap = currentSnapshot();
      const rows = harnessReader.deriveWorkspaceLive(views, snap, clock());
      return {
        ok: true,
        missions: rows,
        // 软上限提示由 UI 决定怎么呈现；数据层只如实报数（domain-model §2.1.1）
        activeCount: rows.filter((x) => x.status === 'active').length,
      };
    },

    get(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      if (!view) return fail(`mission not found: ${missionId}`, 'MISSION_NOT_FOUND');
      return { ok: true, view, live: harnessReader.deriveLiveView(view, currentSnapshot()) };
    },

    create(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const at = clock();
      const id = argString(payload.missionId) || `mis-${randomId()}`;
      const entity = {
        missionId: id,
        title: argString(payload.title),
        intent: argString(payload.intent),
        status: payload.status || 'active',
        workspaceId: argString(payload.workspaceId) || `ws-${hashOf(r.workspaceDir)}`,
        createdAtMs: at,
        updatedAtMs: at,
        constraints: Array.isArray(payload.constraints) ? payload.constraints : [],
      };
      const check = schema.validateMission(entity);
      if (!check.ok) return fail(`invalid mission: ${check.errors.join('; ')}`, 'MISSION_INVALID');
      const out = r.store.append('mission.created', entity);
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, missionId: id, event: out.event };
    },

    /**
     * 对某个团队成员采取干预（S6）：转达消息，或中断它当前的 turn。
     *
     * 第一性原理：为什么这里是"下令"而不是"执行"
     *
     *   D11 的硬约束：agent-team 没有 remote 写表面，send_message /
     *   interrupt_agent 只存在于模型侧工具。壳层不能直接对成员说话。
     *
     *   所以这个 action 的语义是**下达干预意图**，不是"已完成干预"。
     *   它把指令发给 Lead，由 Lead 转达。我们无法确认 Lead 是否照做 ——
     *   这一点必须如实回报（delivered: true 只表示 prompt 被接受）。
     *
     *   如果假装"已中断成功"，用户会以为团队停了，而实际还在跑。
     */
    async interveneMember(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload && payload.missionId);
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const kind = argString(payload && payload.kind);
      if (kind !== 'message' && kind !== 'interrupt') {
        return fail('kind must be "message" or "interrupt"', 'INTERVENTION_KIND_INVALID');
      }
      const memberName = argString(payload && payload.memberName);
      if (!memberName) return fail('memberName is required', 'MEMBER_NAME_REQUIRED');
      const message = argString(payload && payload.message);
      if (kind === 'message' && !message) {
        return fail('message is required when kind=message', 'MESSAGE_REQUIRED');
      }
      if (kind === 'message' && message.length > 4000) {
        return fail('message is too long (4000 chars max)', 'MESSAGE_TOO_LONG');
      }
      const why = argString(payload && payload.reason);

      // 必须已绑定会话：没有会话就没有团队，也就没有成员可干预。
      const bound = readBindMap(r.workspaceDir)[missionId];
      if (!bound || !bound.sessionId) {
        return fail('this mission has no bound session yet', 'SESSION_NOT_BOUND');
      }
      if (typeof promptSession !== 'function') {
        return fail('runtime session wiring is not available', 'RUNTIME_NOT_WIRED');
      }

      const text = renderMemberIntervention({
        kind, memberName, message, reason: why,
      });
      let sent;
      try {
        sent = await promptSession(bound.sessionId, text);
      } catch (err) {
        return fail(`cannot reach the team: ${err.message}`, 'PROMPT_FAILED');
      }
      if (!sent || !sent.ok) {
        return fail((sent && sent.reason) || 'the runtime rejected the instruction', 'PROMPT_FAILED');
      }

      // 审计：只记动作与目标，**不记消息正文**（隐私铁律 §2.4）
      const auditResult = recordIntervention(r.workspaceDir, {
        action: kind === 'message' ? 'member.messaged' : 'member.interrupted',
        // 干预由用户发起，所以 reason 恒为 user-request。
        // 用户的自由文本原因**不进审计**（闭集设计：审计里不出现任何用户内容），
        // 它只出现在发给 Lead 的指令里，用于让团队理解上下文。
        reason: 'user-request',
        missionId,
        memberName,
        atMs: clock(),
      });

      return {
        ok: true,
        // 措辞故意保守：只表示指令已发出，不表示成员已收到/已照做。
        delivered: true,
        audited: auditResult.ok === true,
        // 用户必须知道这是间接路径
        note: kind === 'interrupt'
          ? '已请 Lead 中断该成员。Lead 是否执行、成员何时停下，以团队状态为准。'
          : '已请 Lead 转达。这代表指令已发出，不代表对方已处理。',
      };
    },

    /**
     * 改写或重分配一个团队任务（S6）。
     *
     * 第一性原理：为什么这个 action 带 expectedRevision 参数
     *
     *   用户在看右栏时读到的是**某个时刻的**任务状态。等他把新内容填好、
     *   点提交，中间可能已经过了几秒 —— 期间成员可能已经改过这个任务。
     *
     *   如果我们不带 revision，Lead 会用"它读到的值"去改，
     *   于是**用户的修改会静默覆盖成员的修改**，而且没人知道。
     *
     *   所以 UI 把读到的 revision 传上来，我们写进指令。
     *   过期就让它被拒绝 —— 那是正确行为，不是错误。
     */
    async rewriteTask(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload && payload.missionId);
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const kind = argString(payload && payload.kind);
      if (kind !== 'edit' && kind !== 'reassign') {
        return fail('kind must be "edit" or "reassign"', 'TASK_REWRITE_KIND_INVALID');
      }
      const taskId = argString(payload && payload.taskId);
      if (!taskId) return fail('taskId is required', 'TASK_ID_REQUIRED');
      const expectedRevision = Number.isFinite(payload && payload.expectedRevision)
        ? payload.expectedRevision : null;
      const subject = argString(payload && payload.subject);
      const description = argString(payload && payload.description);
      const owner = argString(payload && payload.owner);
      const why = argString(payload && payload.reason);

      if (kind === 'edit' && !subject && !description) {
        return fail('edit needs a subject or a description', 'TASK_EDIT_EMPTY');
      }
      if (kind === 'reassign' && !owner) {
        return fail('reassign needs an owner', 'TASK_OWNER_REQUIRED');
      }
      if (description && description.length > 8000) {
        return fail('description is too long (8000 chars max)', 'TASK_DESCRIPTION_TOO_LONG');
      }

      const bound = readBindMap(r.workspaceDir)[missionId];
      if (!bound || !bound.sessionId) {
        return fail('this mission has no bound session yet', 'SESSION_NOT_BOUND');
      }
      if (typeof promptSession !== 'function') {
        return fail('runtime session wiring is not available', 'RUNTIME_NOT_WIRED');
      }

      const text = renderTaskRewriteInstruction({
        kind, taskId, expectedRevision, subject, description, owner, reason: why,
      });
      let sent;
      try {
        sent = await promptSession(bound.sessionId, text);
      } catch (err) {
        return fail(`cannot reach the team: ${err.message}`, 'PROMPT_FAILED');
      }
      if (!sent || !sent.ok) {
        return fail((sent && sent.reason) || 'the runtime rejected the instruction', 'PROMPT_FAILED');
      }

      // 审计：只记动作与任务 id，**不记新旧文本**（隐私铁律）
      const auditResult = recordIntervention(r.workspaceDir, {
        action: kind === 'reassign' ? 'task.reassigned' : 'task.rewritten',
        reason: 'user-request',
        missionId,
        taskId,
        atMs: clock(),
      });

      return {
        ok: true,
        delivered: true,
        audited: auditResult.ok === true,
        note: '已请 Lead 改写。任务板是否真的变了，以团队状态为准（过期 revision 会被拒绝）。',
      };
    },

    /**
     * 只读：最近的干预记录（S6 审计）。
     *
     * 只回传闭集字段（动作/原因/成员名/任务 id/时间），
     * 不含任何任务正文或消息内容 —— 审计本身不能成为泄露面。
     */
    interventionHistory(payload) {
      const missionId = argString(payload && payload.missionId);
      const limit = Number.isFinite(payload && payload.limit) ? payload.limit : 20;

      const shape = (e) => ({
        action: e.action,
        reason: e.reason || null,
        atMs: e.atMs,
        memberName: e.memberName || null,
        taskId: e.taskId || null,
        // 给人看的一句话（闭集文案，不含用户内容）
        description: interventionAudit.describeIntervention(e),
      });

      // 优先读磁盘：它是**持久真相**，包含重启前发生的干预。
      //
      // 为什么不用"内存 ∪ 磁盘"的去重合并：磁盘是内存的镜像
      // （见 recordIntervention），所以内存里的条目磁盘上一定也有。
      // 做并集只会引入"按 atMs 去重"这种容易出错的逻辑，而收益为零。
      // 唯一例外是落盘失败的那一刻 —— 那种情况下内存里有、磁盘上没有，
      // 我们选择**以磁盘为准**：宁可让用户看到"这条没记下来"，
      // 也不要让他以为审计完整（诚实优先于好看）。
      const workspaceDir = workspaceDirOf();
      const disk = auditStore.readAudit(workspaceDir, { limit: Math.max(limit, 200) });
      let entries = disk.entries;
      if (missionId) entries = entries.filter((e) => e.missionId === missionId);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);

      return {
        ok: true,
        entries: entries.map(shape),
        stats: {
          ...interventionLog.stats(),
          // 磁盘侧的实况：总数、坏行、以及"内存比磁盘多几条"（落盘失败信号）
          disk: {
            total: disk.total,
            badLines: disk.badLines,
            // 有"更新格式"的记录时说明用户装过更高版本（或降级了）。
            // 这不是错误，但用户该知道有记录没显示出来。
            newerVersions: disk.newerVersions || 0,
            memoryRows: missionId
              ? interventionLog.forMission(missionId, 10000).length
              : interventionLog.stats().entries,
          },
        },
      };
    },

    async updateStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      const to = argString(payload.to);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      if (!schema.MISSION_STATUSES.includes(to)) {
        return fail(`status must be one of ${schema.MISSION_STATUSES.join('|')} (note: "focused" is a UI concept)`, 'STATUS_INVALID');
      }

      // 先停执行，再改状态。
      //
      // 第一性原理：**状态字段不能替代刹车。**
      // 改这个字段之前，用户点"暂停"后团队仍在写文件 —— 界面显示已暂停，
      // 实际还在跑。那比没有暂停按钮更糟：他以为自己已经安全了。
      //
      // 顺序也是有意的：先 cancel 再 append。
      // 如果 append 失败，执行已经停了（多停一次无害）；
      // 反过来若先 append 成功而 cancel 失败，就会出现"状态说停了、实际在跑"，
      // 那正是我们要消除的谎。
      let stopped = null;
      const shouldStop = to === 'paused' || to === 'abandoned';
      if (shouldStop) {
        const bound = readBindMap(r.workspaceDir)[missionId];
        if (bound && bound.sessionId) {
          if (typeof cancelSession === 'function') {
            try {
              const c = await cancelSession(bound.sessionId);
              stopped = c && c.ok ? 'cancelled' : 'cancel-failed';
              if (!stopped || stopped === 'cancel-failed') {
                log(`[mission] updateStatus: cancel failed for ${missionId}: ${(c && c.reason) || 'unknown'}`);
              }
            } catch (err) {
              stopped = 'cancel-failed';
              log(`[mission] updateStatus: cancel threw for ${missionId}: ${err.message}`);
            }
          } else {
            stopped = 'not-wired';
            log('[mission] updateStatus: cancelSession is not wired — execution may continue');
          }
        } else {
          // 没绑定会话 = 没有在执行。这不是失败，是"没有需要停的东西"。
          stopped = 'not-running';
        }
      }

      const out = r.store.append('mission.statusChanged', { missionId, to }, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');

      // 审计：干预必须留痕（只记动作与闭集原因，不记任何内容）
      if (shouldStop) {
        recordIntervention(r.workspaceDir, {
          action: to === 'paused' ? 'mission.paused' : 'mission.stopped',
          reason: 'user-request',
          missionId,
          atMs: clock(),
        });
      }

      return {
        ok: true, missionId, status: to,
        // 如实回报：执行是否真的停了。UI 必须显示它，不能假装。
        stopped,
      };
    },

    update(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const patch = {};
      if (typeof payload.title === 'string') patch.title = argString(payload.title);
      if (typeof payload.intent === 'string') patch.intent = argString(payload.intent);
      if (payload.currentFocusWorkstreamId !== undefined) {
        patch.currentFocusWorkstreamId = payload.currentFocusWorkstreamId;
      }
      if (Object.keys(patch).length === 0) return fail('nothing to update', 'MISSION_PATCH_EMPTY');
      // status 刻意不允许从这里改：状态变更是独立事实，必须走 statusChanged
      const out = r.store.append('mission.updated', { missionId, ...patch }, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, missionId, patched: Object.keys(patch) };
    },

    addWorkstream(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const at = clock();
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        workstreamId: argString(payload.workstreamId) || `ws-${randomId()}`,
        missionId,
        title: argString(payload.title),
        status: payload.status || 'active',
        createdAtMs: at,
        updatedAtMs: at,
      };
      const check = schema.validateWorkstream(entity);
      if (!check.ok) return fail(`invalid workstream: ${check.errors.join('; ')}`, 'WORKSTREAM_INVALID');
      const out = r.store.append('workstream.created', entity, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, workstreamId: entity.workstreamId };
    },

    updateWorkstreamStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const workstreamId = argString(payload.workstreamId);
      const to = argString(payload.to);
      if (!workstreamId) return fail('workstreamId is required', 'WORKSTREAM_ID_REQUIRED');
      if (!schema.WORKSTREAM_STATUSES.includes(to)) {
        return fail(`status must be one of ${schema.WORKSTREAM_STATUSES.join('|')}`, 'STATUS_INVALID');
      }
      const out = r.store.append('workstream.statusChanged', { workstreamId, to }, { missionId: payload.missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, workstreamId, status: to };
    },

    recordDecision(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        decisionId: argString(payload.decisionId) || `dec-${randomId()}`,
        missionId,
        text: argString(payload.text),
        rationale: argString(payload.rationale),
        // ---- 治理漏洞修复（2026-11-01，审计 B-4）----
        //
        // 原来这里是 `payload.status || 'accepted'` 与 `|| 'user'`。
        // 后果：任何调用方（包括未来的模型）**只要不传**这两个字段，
        // 写出来的就是"用户已接受的决策"。
        //
        // user-journeys §5.4 明确要求「Agent 不能直接把东西标为已定决策」，
        // 但那只是文档。现在把它变成代码：
        //   · status 默认 'proposed' —— 提议，不是已接受
        //   · decidedBy 默认 'model'  —— 来源未知时按"模型提议"处理，
        //     让"是用户拍的板"成为一个需要显式声明的动作
        //
        // 这是**故意的 fail-safe**：宁可把一个真实用户决策标成"待确认"，
        // 也不要让模型幻觉悄悄变成用户共识。
        status: payload.status || 'proposed',
        decidedAtMs: clock(),
        decidedBy: payload.decidedBy || 'model',
      };
      const check = schema.validateDecision(entity);
      if (!check.ok) return fail(`invalid decision: ${check.errors.join('; ')}`, 'DECISION_INVALID');
      const out = r.store.append('decision.recorded', entity, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, decisionId: entity.decisionId };
    },

    openQuestion(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        questionId: argString(payload.questionId) || `q-${randomId()}`,
        missionId,
        text: argString(payload.text),
        status: 'open',
        askedAtMs: clock(),
      };
      const check = schema.validateOpenQuestion(entity);
      if (!check.ok) return fail(`invalid question: ${check.errors.join('; ')}`, 'QUESTION_INVALID');
      const out = r.store.append('question.opened', entity, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, questionId: entity.questionId };
    },

    answerQuestion(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const questionId = argString(payload.questionId);
      // 注意：必须 trim 后判空。纯空白的答案（"   "）不是一个答案，
      // 存进去会让"这个问题解决了"变成谎言。
      const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
      if (!questionId) return fail('questionId is required', 'QUESTION_ID_REQUIRED');
      if (!answer) return fail('answer is required', 'ANSWER_REQUIRED');
      const out = r.store.append('question.answered', { questionId, answer }, { missionId: payload.missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, questionId };
    },

    linkTaskRef(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const workstreamId = argString(payload.workstreamId);
      if (!workstreamId) return fail('workstreamId is required', 'WORKSTREAM_ID_REQUIRED');

      // ---- 隐私边界：调用方传 sessionId，我们只存派生句柄 ----
      //
      // 第一版设计若直接把 sessionId 存进 TaskRef，会：
      //   1. 违反 AGENTS.md §2.4（raw sessionId 不进 Mission 事实链）
      //   2. 诱导后续代码去 Harness 反查甚至缓存状态 → 两个事实作者
      //
      // 所以这里**只接受 sessionId 用于派生**，落盘的是 `sess-h-<digest>`。
      const built = taskRef.buildTaskRef({
        missionId,
        workstreamId,
        taskRefId: argString(payload.taskRefId) || undefined,
        sessionId: argString(payload.sessionId),
        turn: Number.isInteger(payload.turn) ? payload.turn : undefined,
        kind: argString(payload.kind) || undefined,
        summary: argString(payload.summary),
        observedAtMs: Number.isFinite(payload.observedAtMs) ? payload.observedAtMs : clock(),
      });
      if (!built.ok) return fail(built.reason, built.code);

      // schema 会再挡一次 status —— 但这里先显式拒绝，给出更清楚的理由。
      // 「TaskRef 不存状态机」是硬边界：状态归 Harness，两个作者 = 撒谎的状态。
      if (payload.status !== undefined) {
        return fail(
          'TaskRef must not carry a status — task state is Harness-owned (two owners = lying state)',
          'TASK_REF_STATUS_FORBIDDEN',
        );
      }

      const out = r.store.append('taskRef.linked', built.taskRef, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, taskRef: built.taskRef };
    },

    listTaskRefs(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      return { ok: true, taskRefs: view.taskRefs || [] };
    },

    /** 记录一条 Finding（我们发现了什么）。 */
    recordFinding(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        findingId: argString(payload.findingId) || `fnd-${randomId()}`,
        missionId,
        text: argString(payload.text),
        status: payload.status || 'unverified',
        // 置信度只允许三档。不允许 73% 这种虚假精确。
        confidence: payload.confidence || 'medium',
        foundAtMs: Number.isFinite(payload.foundAtMs) ? payload.foundAtMs : clock(),
        // 与 decision 同规则：来源未声明时按"模型发现"，不冒充用户结论
        foundBy: payload.foundBy === 'user' ? 'user' : 'model',
        evidenceIds: [],
      };
      if (argString(payload.workstreamId)) entity.workstreamId = argString(payload.workstreamId);
      const v = schema.validateFinding(entity);
      if (!v.ok) return fail(v.errors.join('; '), 'FINDING_INVALID');
      const w = r.store.append('finding.recorded', entity, { atMs: entity.foundAtMs });
      if (!w.ok) return fail(w.reason || 'append failed', 'MISSION_APPEND_FAILED');
      return { ok: true, findingId: entity.findingId };
    },

    /** 改 Finding 状态。refuted 必须给理由。 */
    updateFindingStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const findingId = argString(payload.findingId);
      if (!findingId) return fail('findingId is required', 'FINDING_ID_REQUIRED');
      const to = argString(payload.to);
      if (!schema.FINDING_STATUSES.includes(to)) {
        return fail(`status must be one of ${schema.FINDING_STATUSES.join('|')}`, 'STATUS_INVALID');
      }
      if (to === 'refuted' && !argString(payload.reason)) {
        return fail('refuting a finding requires a reason', 'REFUTED_REASON_REQUIRED');
      }
      const w = r.store.append('finding.statusChanged', {
        findingId, to, reason: argString(payload.reason) || null, atMs: clock(),
      }, { atMs: clock() });
      if (!w.ok) return fail(w.reason || 'append failed', 'MISSION_APPEND_FAILED');
      return { ok: true };
    },

    /** 记录一个 Assumption（我们暂时假设什么）。 */
    recordAssumption(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        assumptionId: argString(payload.assumptionId) || `asm-${randomId()}`,
        missionId,
        text: argString(payload.text),
        status: payload.status || 'unverified',
        assumedAtMs: Number.isFinite(payload.assumedAtMs) ? payload.assumedAtMs : clock(),
        assumedBy: payload.assumedBy === 'user' ? 'user' : 'model',
        // 怎么验证还成立——这是假设该有的伴随信息
        verifyBy: argString(payload.verifyBy) || null,
        // 过期时间：可选。给了就会被 UI 标成"快过期"
        expiresAtMs: Number.isFinite(payload.expiresAtMs) ? payload.expiresAtMs : null,
      };
      const v = schema.validateAssumption(entity);
      if (!v.ok) return fail(v.errors.join('; '), 'ASSUMPTION_INVALID');
      const w = r.store.append('assumption.recorded', entity, { atMs: entity.assumedAtMs });
      if (!w.ok) return fail(w.reason || 'append failed', 'MISSION_APPEND_FAILED');
      return { ok: true, assumptionId: entity.assumptionId };
    },

    /** 改 Assumption 状态。violated 必须给理由。 */
    updateAssumptionStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const assumptionId = argString(payload.assumptionId);
      if (!assumptionId) return fail('assumptionId is required', 'ASSUMPTION_ID_REQUIRED');
      const to = argString(payload.to);
      if (!schema.ASSUMPTION_STATUSES.includes(to)) {
        return fail(`status must be one of ${schema.ASSUMPTION_STATUSES.join('|')}`, 'STATUS_INVALID');
      }
      if (to === 'violated' && !argString(payload.reason)) {
        return fail('violating an assumption requires a reason', 'VIOLATED_REASON_REQUIRED');
      }
      const w = r.store.append('assumption.statusChanged', {
        assumptionId, to, reason: argString(payload.reason) || null, atMs: clock(),
      }, { atMs: clock() });
      if (!w.ok) return fail(w.reason || 'append failed', 'MISSION_APPEND_FAILED');
      return { ok: true };
    },

    /**
     * 记录一条 Evidence（凭什么相信）。
     *
     * 关键约束：**只存引用不存内容**。ref 是相对路径 / commit / URL / 命令，
     * 绝不是文件内容本身（隐私边界 + 事件日志会爆炸）。
     * targetKind/targetId 让它挂到某个 decision/finding/assumption 上。
     */
    recordEvidence(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entity = {
        evidenceId: argString(payload.evidenceId) || `evd-${randomId()}`,
        missionId,
        kind: argString(payload.kind) || 'observation',
        ref: argString(payload.ref),
        // claim 必填：没有 claim 的证据只是一个链接，不支持任何结论
        claim: argString(payload.claim),
        recordedAtMs: Number.isFinite(payload.recordedAtMs) ? payload.recordedAtMs : clock(),
        recordedBy: payload.recordedBy === 'user' ? 'user' : 'model',
        targetKind: argString(payload.targetKind) || null,
        targetId: argString(payload.targetId) || null,
      };
      const v = schema.validateEvidence(entity);
      if (!v.ok) return fail(v.errors.join('; '), 'EVIDENCE_INVALID');
      const w = r.store.append('evidence.recorded', entity, { atMs: entity.recordedAtMs });
      if (!w.ok) return fail(w.reason || 'append failed', 'MISSION_APPEND_FAILED');
      return { ok: true, evidenceId: entity.evidenceId };
    },

    registerDeliverable(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const reg = deliverable.registerDeliverable({
        workspaceDir: r.workspaceDir,
        missionId,
        label: argString(payload.label),
        relPath: argString(payload.relPath),
        now: clock(),
      });
      if (!reg.ok) return fail(reg.reason, 'DELIVERABLE_INVALID');
      const out = r.store.append('deliverable.registered', reg.deliverable, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, deliverable: reg.deliverable };
    },

    verifyDeliverables(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      if (!view) return fail(`mission not found: ${missionId}`, 'MISSION_NOT_FOUND');
      // 三种状态（unchanged/modified/missing）原样透出——UI 需要分别处置
      return { ok: true, ...deliverable.verifyAll({ workspaceDir: r.workspaceDir, deliverables: view.deliverables }) };
    },

    getBrief(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      if (!view) return fail(`mission not found: ${missionId}`, 'MISSION_NOT_FOUND');
      const snap = currentSnapshot();
      const b = brief.buildBrief(view, {
        maxBytes: Number.isFinite(Number(payload.maxBytes)) ? Number(payload.maxBytes) : undefined,
        observed: snap || undefined,
        observedAtMs: snap ? snap.observedAtMs : undefined,
      });
      return { ok: true, brief: b };
    },

    diagnostics() {
      const r = requireStore();
      if (!r.ok) return r;
      return {
        ok: true,
        report: r.store.report(),
        archive: r.store.archiveStatus(),
        migration: migration.planFile(r.store.file),
        workspaceDir: r.workspaceDir,
      };
    },

    // ---- Brief → AGENTS.md 同步（P1 最后一环）----
    //
    // 为什么是写 AGENTS.md 而不是拦截 Session 注入：壳是 dsh web UI 的容器，
    // 用户直接在官方 UI 里发 prompt，壳不接管输入面（铁律 5）。
    // 而 dsh-agent-instructions 每次 Session 启动都会读 <workspace>/AGENTS.md——
    // 写进去就自动生效，零侵入。
    syncBrief(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      if (!view) return fail(`mission not found: ${missionId}`, 'MISSION_NOT_FOUND');

      const snap = currentSnapshot();
      const b = brief.buildBrief(view, {
        observed: snap || undefined,
        observedAtMs: snap ? snap.observedAtMs : undefined,
      });
      if (b.empty) return fail('brief is empty — nothing to sync', 'BRIEF_EMPTY');

      const out = briefSync.syncToWorkspace({
        workspaceDir: r.workspaceDir,
        briefText: b.text,
        meta: {
          missionId,
          missionCount: Object.keys(r.store.snapshot().missions).length,
          fingerprint: brief.briefFingerprint(b),
        },
      });
      if (!out.ok) return fail(out.reason, 'BRIEF_SYNC_FAILED');
      return { ok: true, action: out.action, file: out.file, bytes: b.bytes, truncated: b.truncated };
    },

    unsyncBrief() {
      const r = requireStore();
      if (!r.ok) return r;
      const out = briefSync.unsyncFromWorkspace({ workspaceDir: r.workspaceDir });
      if (!out.ok) return fail(out.reason, 'BRIEF_UNSYNC_FAILED');
      return { ok: true, action: out.action, file: out.file };
    },

    briefSyncState() {
      const r = requireStore();
      if (!r.ok) return r;
      const out = briefSync.inspect({ workspaceDir: r.workspaceDir });
      if (!out.ok) return fail(out.reason, 'BRIEF_INSPECT_FAILED');
      return { ok: true, ...out };
    },

    /**
     * 需要用户处理的待办。
     *
     * 数据来自 office 快照（Harness 的事实），**这里只读不复制**。
     * 为什么不走 normalizeSnapshot：那是隐私白名单，会丢掉 pendingItems
     * 明细；而待办明细正是这个 action 存在的理由（"哪几件事"而不只是"几件"）。
     * 但透传的字段仍然受 office 的 PENDING_ALLOWLIST 约束，不会有原始 prompt。
     */
    /**
     * 向运行时要结构化会话投影。
     *
     * 为什么需要它：0.2.1 新增 `session/projections`，一次调用就返回
     * `userQuestions.active[].questions[]`——里面带 `options` / `multiSelect` /
     * `intent(plan-review)`，正是我们右栏缺的结构化交互能力。
     *
     * 关键约束（不伪造）：
     *   · 投影是**投影插件**提供的。插件未加载时 `values` 里没有该 key。
     *   · 所以这里**必须**如实报告 available，不能假装拿到了。
     *   · 调用方（右栏）在 available:false 时回落到 office 快照路径。
     */
    async sessionProjections(payload) {
      // sessionId 可选：不传时由注入方选择"当前被 follow 的会话"。
      // 原因是 Mission 按隐私规则不存 raw sessionId，右栏拿不到它。
      const sessionId = argString(payload && payload.sessionId);
      if (typeof projectionsOf !== 'function') {
        return { ok: true, available: false, reason: 'runtime projections are not wired' };
      }
      let res;
      try {
        res = await projectionsOf(sessionId);
      } catch (err) {
        return { ok: true, available: false, reason: `projections failed: ${err.message}` };
      }
      if (!res || !res.ok) {
        return { ok: true, available: false, reason: (res && res.reason) || 'projections unavailable' };
      }
      const values = res.value && res.value.values ? res.value.values : null;
      if (!values) {
        return { ok: true, available: false, reason: 'projection payload has no values' };
      }
      // 投影插件是否提供 userQuestions —— 缺了就是没启用，如实说
      const uq = values.userQuestions;
      const hasUserQuestions = !!uq && typeof uq === 'object'
        && Array.isArray(uq.active) && Array.isArray(uq.settled);
      return {
        ok: true,
        available: true,
        asOfSeq: Number.isFinite(res.value.asOfSeq) ? res.value.asOfSeq : null,
        userQuestionsAvailable: hasUserQuestions,
        // 只有 active 的问题需要用户处理；settled 是历史
        //
        // ⚠️ activeQuestions 里带 `detail`（plan-review 的计划 markdown）。
        // 2026-11-02 复查发现原来**没有任何长度上限**：一个 5MB 的 detail
        // 会原样穿过 IPC 到渲染层（实测确认），造成序列化开销 + 渲染层内存占用
        // + 展开时的卡顿。而 plan-review 在 380px 侧栏里最多也就看几千字。
        //
        // 这里做个上限：超出的部分截断并**显式标记**，让 UI 知道"没显示全"，
        // 而不是静默丢内容（那会让用户以为计划就这么短）。
        activeQuestions: hasUserQuestions ? uq.active.map(trimQuestionDetail) : [],
        settledCount: hasUserQuestions ? uq.settled.length : 0,
        // 其余投影按需透传（当前 UI 不用 tokenUsage，但保留以便将来）
        agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : null,

        // ---- Team 投影（只读；启用实验性 profile 时才有）------------------
        //
        // 第一性原理：**缺 agentTeam 不等于空团队**。GPT 第三轮列了五种状态，
        // 我们必须区分，否则会把"没启用"误报成"团队没人"：
        //   · profile 没启用 Team
        //   · session 不属于 Team
        //   · 投影尚未加载
        //   · 读取失败
        //   · 投影存在但确实没成员/任务
        //
        // 这里只能可靠区分"有没有这个 key"。其余交给 UI 按 available 处理。
        agentTeam: normalizeAgentTeam(values.agentTeam),

        // ---- 第二层「团队执行提醒」的数据源 ------------------------------
        //
        // 第一性原理：待办不能只有一个红框。GPT 第三轮指出应分两层——
        //   · 需要你决策：human question / approval / plan-review
        //   · 团队执行提醒：依赖阻塞、文件冲突、排队输入、长时间无进展
        //
        // 我们手上**有真实数据**的第二层信号只有两个：
        //   1. inbox 排队输入（用户交代了但 agent 还没处理）——用户会误以为没收到
        //   2. permissions 是 danger-full-access 时的风险提示
        // 其余（blockedBy / writeScopes）要等 team profile 启用，本轮不做。
        //
        // 关键：**没有数据就不编**。这两个字段都只有真实来源。
        inbox: normalizeInbox(values.inbox),
        permissionPreset: typeof values.permissions === 'object' && values.permissions
          ? (typeof values.permissions.currentValue === 'string' ? values.permissions.currentValue : null)
          : null,
      };
    },

    /**
     * 把 Mission 绑定到一个 Harness 会话。
     *
     * 通常不需要手动调——`startWork` 会自动绑定。
     * 这里暴露出来是为了让 UI 能在"我要用已有会话"时手动指定。
     */
    bindSession(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const sessionId = argString(payload && payload.sessionId);
      if (!sessionId) return fail('sessionId is required', 'SESSION_ID_REQUIRED');
      try {
        const map = readBindMap(r.workspaceDir);
        map[missionId] = { sessionId, boundAtMs: clock() };
        writeBindMap(r.workspaceDir, map);
      } catch (err) {
        return fail(`cannot bind session: ${err.message}`, 'BIND_WRITE_FAILED');
      }
      return { ok: true, sessionId };
    },

    /** 这个 Mission 绑定了哪个会话（UI 用来显示"去 Harness 继续"）。 */
    getBoundSession(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const entry = readBindMap(r.workspaceDir)[missionId];
      if (!entry) return { ok: true, bound: false, sessionId: null };
      return { ok: true, bound: true, sessionId: entry.sessionId, boundAtMs: entry.boundAtMs };
    },

    /**
     * 从 Agent 的回复里"收获"真实存在的产物。
     *
     * 第一性原理：为什么必须校验文件真实存在
     *
     *   Agent 说"我生成了报告 docs/report.md"——**这句话本身不是证据**。
     *   文件可能：
     *     · 根本没创建
     *     · 创建在别的目录
     *     · 被后续步骤删了
     *
     *   所以这里做三件事：
     *     1. 从回复预览里抽出**看起来像路径**的片段
     *     2. **逐个校验文件真的存在**（fs.stat）
     *     3. 只有真实存在的才登记，并算真实 sha256
     *
     *   不存在的一律跳过，并在返回值里如实报告 skipped，
     *   让 UI 能告诉用户"Agent 提到但没找到"。
     *
     * 为什么不做"自动全量登记"：那是把 Agent 的自述当事实。
     * 我们只接受**能验证**的部分。
     */
    async harvestDeliverables(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      if (typeof projectionsOf !== 'function') return fail('runtime not wired', 'RUNTIME_NOT_WIRED');

      const bound = readBindMap(r.workspaceDir)[missionId];
      if (!bound || !bound.sessionId) return fail('no session bound to this mission', 'NOT_BOUND');

      let res;
      try {
        res = await projectionsOf(bound.sessionId);
      } catch (err) {
        return fail(`cannot read projections: ${err.message}`, 'PROJECTION_FAILED');
      }
      if (!res || !res.ok) return fail('projection unavailable', 'PROJECTION_FAILED');

      const values = (res.value && res.value.values) || {};
      const outline = Array.isArray(values.turnOutline) ? values.turnOutline : [];
      if (outline.length === 0) return { ok: true, added: [], skipped: [], reason: 'no turns yet' };

      // 只看最后一轮的回复（历史轮次的产物可能已经被后续步骤改掉）
      const last = outline[outline.length - 1];
      const text = typeof last.response === 'string' ? last.response : '';
      if (!text) return { ok: true, added: [], skipped: [], reason: 'no response yet' };

      // 抽路径：只认常见的代码/文档扩展名，避免把 "v1.2" 当成文件
      const candidates = text.match(/[\w./-]+\.(?:md|markdown|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|txt|html|css|py|sh|toml)\b/g) || [];
      const unique = [...new Set(candidates)]
        // 过滤明显不是路径的：纯文件名不算（不知道在哪），带 .. 的不算（隐私边界）
        .filter((p) => p.includes('/'))
        .filter((p) => !p.startsWith('/') && !p.includes('..') && !/^[A-Za-z]:/.test(p))
        .slice(0, 10);

      const workspaceDir = r.workspaceDir;
      const added = [];
      const skipped = [];

      for (const relPath of unique) {
        const abs = path.join(workspaceDir, relPath);
        let stat = null;
        try { stat = fs.statSync(abs); } catch { /* 不存在 */ }
        if (!stat || !stat.isFile()) {
          // Agent 提到了但文件不在 —— 如实记录，不登记
          skipped.push({ relPath, reason: 'file not found in workspace' });
          continue;
        }

        // ★ 符号链接防护（2026-11-02 复查发现）。
        //
        //   statSync 会**跟随**符号链接，所以工作区里一个指向外部的链接
        //   （比如 docs/link.md -> /Users/me/.ssh/id_rsa）会被当成"存在的文件"，
        //   接着我们会读它的内容算 sha256 —— 等于把工作区外的内容泄露进 Mission。
        //
        //   实测确认过：在 workspace 里建 symlink 指向外部文件，
        //   statSync().isFile() 返回 true，readFileSync 能读到明文。
        //
        //   两道防护：
        //     1. lstat 拒绝符号链接本身
        //     2. realpath 二次确认最终路径仍在工作区内（防链接套链接）
        let lst = null;
        try { lst = fs.lstatSync(abs); } catch { /* 上面已处理 */ }
        if (lst && lst.isSymbolicLink()) {
          skipped.push({ relPath, reason: 'symbolic link (refused: may point outside the workspace)' });
          continue;
        }
        let real = null;
        try { real = fs.realpathSync(abs); } catch { /* 不存在 */ }
        if (!real) {
          skipped.push({ relPath, reason: 'file not found in workspace' });
          continue;
        }
        let realWs = null;
        try { realWs = fs.realpathSync(workspaceDir); } catch { realWs = workspaceDir; }
        // 必须真的在工作区**里面**：realWs + 分隔符 作为前缀
        const inside = real === realWs || real.startsWith(realWs + path.sep);
        if (!inside) {
          skipped.push({ relPath, reason: 'resolves outside the workspace' });
          continue;
        }
        // 已有同路径的 Deliverable 就跳过（幂等）
        const view = r.store.missionView(missionId);
        const exists = view && view.deliverables.some((d) => d.relPath === relPath);
        if (exists) { skipped.push({ relPath, reason: 'already registered' }); continue; }

        let digest = null;
        try {
          digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        } catch { /* 读不了 */ }
        if (!digest) { skipped.push({ relPath, reason: 'cannot read file' }); continue; }

        try {
          r.store.append('deliverable.registered', {
            deliverableId: `dlv-${randomId()}`,
            missionId,
            label: path.basename(relPath),
            relPath,
            digest,
            registeredAtMs: clock(),
            // 来源标注：这是从 Agent 回复里收获的，不是用户手填的
            source: 'harvested-from-agent',
          }, { atMs: clock() });
          added.push({ relPath, digest: digest.slice(0, 16), bytes: stat.size });
        } catch (err) {
          skipped.push({ relPath, reason: `append failed: ${err.message}` });
        }
      }

      return {
        ok: true,
        added,
        skipped,
        // 明确报告"Agent 提到了什么但我们没找到"——这是诚实的关键
        mentionedTotal: unique.length,
      };
    },

    /**
     * 这次执行跑到哪了 —— 只读，从 Harness 投影取真实进度。
     *
     * 第一性原理：用户点了「交给团队」之后，最想知道的是
     *   "它在跑吗？跑到哪了？完事了吗？"
     *
     * 如果没有这个，用户只能自己切到 Harness 视图翻聊天记录。
     * 而这个信息投影里**已经有**（sessionStats.turns/steps），
     * 不需要我们监听事件、也不需要写第二个聊天框。
     *
     * **不猜**：turns>0 只代表有 turn 结束过，不代表任务成功。
     * 成功与否要用户自己判断——我们只报事实。
     */
    async workStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const bound = readBindMap(r.workspaceDir)[missionId];
      if (!bound || !bound.sessionId) {
        return { ok: true, bound: false, running: false };
      }
      if (typeof projectionsOf !== 'function') {
        return { ok: true, bound: true, available: false, reason: 'runtime not wired' };
      }
      let res;
      try {
        res = await projectionsOf(bound.sessionId);
      } catch (err) {
        return { ok: true, bound: true, available: false, reason: err.message };
      }
      if (!res || !res.ok) {
        return { ok: true, bound: true, available: false, reason: (res && res.reason) || 'projection unavailable' };
      }
      const values = (res.value && res.value.values) || {};
      const stats = values.sessionStats && typeof values.sessionStats === 'object' ? values.sessionStats : {};
      const turns = Number.isFinite(stats.turns) ? stats.turns : 0;
      const steps = Number.isFinite(stats.steps) ? stats.steps : 0;

      // turnOutline 是判断"完成"的**准确信号**：
      //   官方注释明确说 response「commits at turn/end」——
      //   也就是**只有在 turn 结束时才有值**。
      //   所以「最后一个 turn 的 response 非空」= Agent 真的给出了回复。
      //
      // 这比 turns>0 更准：turns 只说明有 turn 结束过，
      // 而 response 非空说明**那一轮有 assistant 文本产出**。
      const outline = Array.isArray(values.turnOutline) ? values.turnOutline : [];
      const last = outline.length > 0 ? outline[outline.length - 1] : null;
      const lastResponse = last && typeof last.response === 'string' ? last.response : '';
      const lastPrompt = last && typeof last.prompt === 'string' ? last.prompt : '';
      const lastTurn = last && Number.isFinite(last.turn) ? last.turn : null;

      // "在跑" 从 inbox 和 userQuestions 推断？不行——那是猜。
      // 官方给的是 sessionListMetadata/status。这里只用 stats 的变化：
      // turns 和 steps 都大于 0 说明至少跑过；是否正在跑需要外部信号，
      // 所以**不声称在跑**，只报数字。
      return {
        ok: true,
        bound: true,
        available: true,
        turns,
        steps,
        // 有 turn 结束过 = 至少完整跑过一轮
        hasRun: turns > 0,
        // Agent 真的给出回复了（turn/end 才提交）
        hasResponse: lastResponse.length > 0,
        lastTurn,
        // 预览是有长度上限的（官方为窄栏卡片设计），所以**不是完整回复**
        lastPromptPreview: lastPrompt || null,
        lastResponsePreview: lastResponse || null,
        // ---- 交付凭证（S5）-------------------------------------------------
        //
        // 第一性原理：用户看 workStatus 真正想问的是"我该不该信"，
        // 而不是"跑了几轮"。turns/steps 只证明有人在动，不证明做完了。
        //
        // 凭证的坐标来自官方 workspace/changes 事件的 seq —— 但这个 action
        // 只读投影，拿不到事件。所以这里**如实返回 claimed**：
        // "团队有回复，但没有可复核的变更坐标"。
        //
        // 这比"看起来跑完了就显示已完成"诚实：一个 turn 正常结束，
        // 完全可能什么都没改（只是回答了一个问题），也可能改了一堆东西。
        //
        // S5（2026-11-04）：凭证不再写死 resolvable:false。
        // 现在走两步真实读取：
        //   ① seqOfTurn  —— 官方 workspace/changes 事件的 seq（事件流已记录）
        //   ② changesSummaryOf —— 按 seq 读那份变更清单
        // 两步任何一步失败都如实降级，**不猜**（读不到 ≠ 没变更）。
        receipt: await (async () => {
          const built = await buildReceiptFor({
            bound, lastTurn, lastResponse,
            deps: { seqOfTurn, changesSummaryOf },
          });
          // 落盘（S5）：只有 verified 的凭证才值得写进事实链。
          //
          // 为什么只落 verified：claimed 的含义是"我们没能复核" ——
          // 它不是一次交付事实，而是一次观测缺口。
          // 把观测缺口写进不可篡改的日志，等于把噪音固化成历史。
          //
          // 为什么在这里落而不是在事件流里：凭证是我们**读官方数据后得出**的，
          // 不是官方事件本身，事件流里没有"凭证"这个概念。
          if (built && built.state === 'verified' && built.coordinate) {
            try {
              r.store.append('receipt.recorded',
                { missionId, receipt: built.coordinate }, { missionId });
            } catch { /* 落盘失败不该让 workStatus 失败：读取本身已成功 */ }
          }
          // coordinate 是内部落盘用的形状，不回传给 UI（UI 只看 state/description）
          const { coordinate, ...visible } = built;
          return visible;
        })(),
        observedAtMs: clock(),
      };
    },

    /**
     * **启动工作**——这是 Mission 从"记录器"变成"发生器"的那个 action。
     *
     * 第一性原理：用户创建 Mission 后不知道下一步做什么，因为
     * Mission 只能记录、不能启动。这个 action 补上那个缺失的环节：
     *
     *   1. 拿到（或创建）这个 Mission 的 Harness 会话
     *   2. 把「任务描述 + Mission Brief」通过 session/prompt 发过去
     *   3. 绑定 sessionId 到 Mission（存本机绑定文件，不进事件日志）
     *
     * 为什么把 Brief 一起发：Agent 在新会话里是"失忆"的。
     * AGENTS.md 里的 Brief 会在**会话启动时**被读取——但如果会话已经存在，
     * 它不会再读。所以显式把目标/边界带上，保证 Agent 知道自己在做什么项目。
     */
    async startWork(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const task = argString(payload && payload.task);
      if (!task) return fail('需要告诉团队要做什么', 'TASK_REQUIRED');
      if (typeof ensureSession !== 'function' || typeof promptSession !== 'function') {
        return fail('runtime session wiring is not available', 'RUNTIME_NOT_WIRED');
      }

      const view = r.store.missionView(missionId);
      if (!view) return fail('mission not found', 'MISSION_NOT_FOUND');

      // 1) 会话：优先复用已绑定的，否则新建
      let sessionId = null;
      const bound = readBindMap(r.workspaceDir)[missionId];
      if (bound && bound.sessionId) {
        sessionId = bound.sessionId;
      } else {
        let made;
        try {
          made = await ensureSession(missionId);
        } catch (err) {
          return fail(`cannot open a session: ${err.message}`, 'SESSION_CREATE_FAILED');
        }
        if (!made || !made.ok || !made.sessionId) {
          return fail((made && made.reason) || 'cannot open a session', 'SESSION_CREATE_FAILED');
        }
        sessionId = made.sessionId;
        try {
          const map = readBindMap(r.workspaceDir);
          map[missionId] = { sessionId, boundAtMs: clock() };
          writeBindMap(r.workspaceDir, map);
        } catch (err) {
          // 绑定失败不该让整个启动失败——会话已经在跑
          log(`[mission] bind after create failed: ${err.message}`);
        }
      }

      // 2) 把任务 + Mission 上下文发过去
      //
      // 为什么要带上下文：新会话里 Agent 不知道这个 Mission 的目标和边界。
      // AGENTS.md 的 Brief 只在**会话启动时**被读；已存在的会话不会重读。
      //
      // S2（2026-11-04）：改为调用 renderDispatchInstruction —— 同一段文本现在
      // 还会带上合同（验收条件/预算）与固定首行的幂等键。没有合同时输出与旧行为
      // 完全一致（除首行多了幂等键），所以老 Mission 的派发不受影响。
      const m = view.mission;
      const dispatchKey = String(payload && payload.dispatchKey ? payload.dispatchKey : '').trim()
        || `mis-${randomId()}`;
      const text = renderDispatchInstruction({ mission: m, task, dispatchKey });

      let sent;
      try {
        sent = await promptSession(sessionId, text);
      } catch (err) {
        return fail(`cannot send to the team: ${err.message}`, 'PROMPT_FAILED');
      }
      if (!sent || !sent.ok) {
        return fail((sent && sent.reason) || 'the runtime rejected the prompt', 'PROMPT_FAILED');
      }

      // 3) 记一条 TaskRef，让 Mission 知道"有一次执行发生了"
      //    注意：只存派生句柄，不存 raw sessionId（隐私规则）
      try {
        // ⚠️ deriveHarnessRef 返回的是 { ok, ref } **对象**，不是字符串。
        // 2026-11-02 复查发现：这里原来把整个对象当 ref 用，
        // 于是 isValidHarnessRef(对象) === false，条件永远不成立 ——
        // **TaskRef 从来没被写入过**，而且没有任何报错（完全静默失效）。
        const derived = taskRef.deriveHarnessRef({ sessionId });
        const ref = derived && derived.ok ? derived.ref : null;
        if (ref && taskRef.isValidHarnessRef(ref)) {
          // ⚠️ schema 要求 workstreamId 必填。startWork 时 Mission 可能还没有
          //    任何 workstream —— 那样就无法记 TaskRef。
          //
          //    2026-11-02 复查发现：原来既用错了字段名（ref 而非 harnessRef），
          //    又漏了 workstreamId，于是 append 被 schema **静默 break 掉**
          //    （projection.js 里是 `if (!validate) break;`，不抛错）。
          //    结果是"功能看起来接了，实际一条都没存"。
          //
          //    处理：有 workstream 就记在该 workstream 下；没有就跳过并**留日志**，
          //    不再静默失败。
          const view0 = r.store.missionView(missionId);
          const ws0 = view0 && Array.isArray(view0.workstreams) && view0.workstreams.length
            ? view0.workstreams[0] : null;
          if (!ws0) {
            log('[mission] startWork: no workstream yet, skipping the taskRef (nothing lost: the session is bound)');
          } else {
            const appended = r.store.append('taskRef.linked', {
              taskRefId: `tr-${randomId()}`,
              missionId,
              workstreamId: ws0.workstreamId,
              harnessRef: ref,
              summary: task.slice(0, 200),
              observedAtMs: clock(),
            }, { atMs: clock() });
            if (appended === false) log('[mission] startWork: taskRef append was REJECTED by the store');
          }
        }
      } catch (err) {
        log(`[mission] task ref append failed: ${err.message}`);
      }

      // 返回 dispatchKey，让 UI 能拿去轮询"投影里有没有出现对应任务"（S2 派发确认）。
      //
      // 为什么不持久化它：派发确认是**一次尝试的短期状态**，
      // 不是 Mission 的长期事实。持久化会逼我们扩展 schema（TaskRef 还要求
      // workstreamId 必填，没 workstream 时根本记不下来），成本远大于收益。
      //
      // 为什么不返回 raw sessionId：隐私规则（AGENTS.md §2.4）。
      // sessionId 只在这一层用，UI 拿到的是派发键 —— 它不含任何会话身份。
      return { ok: true, sessionId, delivered: true, dispatchKey };
    },

    /**
     * 派发确认（S2）：prompt 已下达，但**不知道模型有没有真的照做**。
     *
     * 第一性原理：为什么这个 action 必须存在
     *
     *   D11 的事实：agent-team 没有 remote 写表面。我们派发的唯一方式是
     *   发一段结构化指令，让模型自己去调 spawn_teammate / team_task_create。
     *   于是"下令成功"与"事情发生"之间出现了一条我们看不见的缝。
     *
     *   没有这个 action 时，UI 只能说"已下达"然后什么都不显示 ——
     *   用户不知道团队到底动没动。有了它，UI 可以回答：
     *   任务建好了 / 还没建好 / 建的是别的任务 / 运行时拒绝了。
     *
     * 判据只有一个：团队投影里有没有出现带我们这个 dispatchKey 的任务。
     * 不做任何推断（比如"turns 增加了所以大概建了"）。
     */
    async confirmDispatch(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload && payload.missionId);
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const dispatchKey = argString(payload && payload.dispatchKey);
      if (!dispatchKey) return fail('dispatchKey is required', 'DISPATCH_KEY_REQUIRED');
      const startedAtMs = Number.isFinite(payload && payload.startedAtMs)
        ? payload.startedAtMs : null;
      const promptRejected = payload && payload.promptRejected === true;

      // 团队投影来自绑定会话。读不到就是读不到 —— 不猜"大概建好了"。
      let team = null;
      const bound = readBindMap(r.workspaceDir)[missionId];
      if (bound && bound.sessionId && typeof projectionsOf === 'function') {
        try {
          const res = await projectionsOf(bound.sessionId);
          if (res && res.ok && res.value && res.value.values) {
            // 复用同一份归一化：右栏与确认逻辑必须看到完全一样的团队形状
            team = normalizeAgentTeam(res.value.values.agentTeam);
          }
        } catch { team = null; }
      }

      const verdict = dispatchConfirmModule.evaluateDispatch({
        dispatchKey, team, startedAtMs, nowMs: clock(), promptRejected,
      });
      return {
        ok: true,
        state: verdict.state,
        description: dispatchConfirmModule.describeDispatchState(verdict.state, verdict.reason),
        reason: verdict.reason,
        // 只回传任务的**标识与状态**，不回传 description 正文（隐私）
        task: verdict.task ? {
          id: verdict.task.id,
          subject: verdict.task.subject,
          status: verdict.task.status,
          ready: verdict.task.ready === true,
        } : null,
        observedAtMs: clock(),
      };
    },

    attention() {
      let raw = null;
      try { raw = snapshotOf(); } catch { raw = null; }
      // 没有快照 ≠ 没有待办。
      //
      // 这是最危险的空态：运行时没连上时告诉用户"没有需要你处理的事"，
      // 用户会以为一切安好，而真相是我们什么都没看到。
      // 所以 available:false 一路传下去，由 UI 渲染"未连接"。
      if (!raw) {
        return {
          ok: true, available: false, reason: 'no office snapshot',
          items: [], counts: { approval: 0, question: 0 },
          // rail-order 的 unknown tone 会沿用它；不给 empty 文案
          rail: { header: { decisionCount: 0, reminderCount: 0, tone: 'unknown' },
            visible: { decisions: [], reminders: [] }, overflow: { decisions: 0 }, empty: null },
        };
      }
      const items = Array.isArray(raw.pendingItems) ? raw.pendingItems : [];
      // 分级 + 排序抽到 src/mission/rail-order.js（可离线测试）。
      //
      // 为什么不用原来那段内联排序：它只区分 approval/question 两类，
      // 且"哪几项进首屏 2-3 格"这个决定无法被测试。而 380px 首屏放几项
      // 恰恰就是产品本身——放错了用户会错过真正阻塞团队的事。
      const rail = railOrder.assembleRailAttention({ items, nowMs: clock() });
      // 老 UI 用的顺序：决策层在前、提醒层在后，但**不截断**。
      const ordered = railOrder.orderAttentionItems(items, clock());
      const orderedForCompat = [...ordered.decisions, ...ordered.reminders, ...ordered.dropped];

      const counts = { approval: 0, question: 0 };
      for (const it of items) {
        if (it.kind === 'approval') counts.approval += 1;
        else if (it.kind === 'question') counts.question += 1;
      }
      return {
        ok: true,
        available: true,
        observedAtMs: Number.isFinite(raw.observedAtMs) ? raw.observedAtMs : clock(),
        // 向后兼容：老 UI 按 items（**全量**）与 total 渲染。
        //
        // 关键：这里必须是全量，不能是 rail.visible（那是截断到首屏几项的）。
        // 老 UI 用 total 做计数、用 items 做列表；一旦 items 被截断而 total 没变，
        // 就会出现"说有三条、只显示一条"的不一致。
        // 截断只发生在 rail.visible，供 S7 的新 UI 使用。
        items: orderedForCompat,
        counts,
        total: items.length,
        // 新增：分层结果。S7 的 UI 直接消费它。
        rail,
      };
    },

    /**
     * 上次查看这个 Mission 之后发生了什么。
     *
     * 第一性原理：先定义"离开"。
     *   · 上次关闭应用 → 用户可能整天开着，不准
     *   · 上次右栏可见 → 切视图就触发，噪音大
     *   · **上次查看这个 Mission** → 语义准确（focus 概念已存在）
     * 选第三个。
     *
     * 关键约束：**只从真实事件派生，不调用模型生成摘要。**
     * 用户要的是"发生了什么"，不是"模型猜测发生了什么"。
     */
    sinceLastSeen(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const view = r.store.missionView(missionId);
      if (!view) return fail('mission not found', 'MISSION_NOT_FOUND');

      const seenAt = readSeenAt(r.workspaceDir, missionId);
      if (!Number.isFinite(seenAt)) {
        return { ok: true, available: false, reason: 'never-seen', entries: [], sinceMs: null };
      }

      const entries = [];
      const push = (atMs, kind, text, tone) => {
        if (Number.isFinite(atMs) && atMs > seenAt) entries.push({ atMs, kind, text, tone });
      };

      for (const d of view.decisions || []) {
        push(d.decidedAtMs, 'decision', d.text, 'ok');
      }
      for (const q of view.questions || []) {
        if (q.status === 'open') push(q.askedAtMs, 'question', q.text, 'warn');
        else if (q.status === 'answered') push(q.answeredAtMs, 'answer', `${q.text} → ${q.answer || ''}`, 'ok');
      }
      for (const w of view.workstreams || []) {
        push(w.createdAtMs, 'workstream', w.title, 'info');
        if (w.updatedAtMs > (w.createdAtMs || 0) && w.status !== 'active') {
          push(w.updatedAtMs, 'workstream-status', `${w.title} → ${w.status}`, 'info');
        }
      }
      for (const d of view.deliverables || []) {
        push(d.registeredAtMs, 'deliverable', d.label, 'ok');
      }
      if (view.mission && Number.isFinite(view.mission.updatedAtMs)) {
        push(view.mission.updatedAtMs, 'mission', `Mission 更新（${view.mission.status}）`, 'info');
      }

      entries.sort((a, b) => a.atMs - b.atMs);
      // 太多条会变成流水账——只给最近 N 条，并如实说明被截断
      const LIMIT = 12;
      const truncated = entries.length > LIMIT;
      const shown = truncated ? entries.slice(-LIMIT) : entries;

      return {
        ok: true,
        available: true,
        sinceMs: seenAt,
        entries: shown,
        truncated,
        dropped: truncated ? entries.length - LIMIT : 0,
      };
    },

    /**
     * 记录"我刚刚看过这个 Mission"。
     *
     * **存储位置：UI 偏好，不进 Mission 事件日志。**
     * schema.js 的 FORBIDDEN_PERSISTED_FIELDS 明确禁止把 focused 这类
     * UI 偏好写进项目数据，lastSeenAtMs 是同一类东西。
     */
    markSeen(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = payload && payload.missionId;
      if (!isId(missionId)) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      const at = Number.isFinite(payload.atMs) ? payload.atMs : clock();
      try {
        writeSeenAt(r.workspaceDir, missionId, at);
      } catch (err) {
        return fail(`cannot record last-seen: ${err.message}`, 'SEEN_WRITE_FAILED');
      }
      return { ok: true, atMs: at };
    },

    openDesk() {
      // 窗口打开失败要返回明确原因，而不是静默无反应
      if (typeof openDeskWindow !== 'function') {
        return fail('Mission Desk window opener is not wired', 'WINDOW_NOT_WIRED');
      }
      try {
        openDeskWindow();
        return { ok: true };
      } catch (err) {
        return fail(`cannot open Mission Desk: ${err.message}`, 'WINDOW_FAILED');
      }
    },
  };

  // --------------------------------------------------------------- register

  ipcMain.handle('mission:invoke', async (_e, action, payload) => {
    const act = argString(action);
    if (!act) return fail('action is required', 'ACTION_REQUIRED');
    if (!Object.prototype.hasOwnProperty.call(handlers, act)) {
      // 未知 action 明确失败——静默返回 {} 会让 UI 显示空列表并让人以为"没有数据"
      return fail(`unknown action: ${act}`, 'ACTION_UNKNOWN');
    }
    try {
      const out = await handlers[act](payload || {});
      return out;
    } catch (err) {
      // 任何未预料的异常都不泄露给 renderer，但要留日志供事后归因
      log(`[mission] action ${act} failed: ${err && err.message ? err.message : err}`);
      return fail(err && err.message ? err.message : String(err), 'ACTION_THREW');
    }
  });
}

// ---------------------------------------------------------------------------
// 小工具（不引入依赖）
// ---------------------------------------------------------------------------

function randomId() {
  return require('node:crypto').randomBytes(6).toString('hex');
}

function hashOf(text) {
  return require('node:crypto').createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

// normalizeAgentTeam 是纯函数，导出仅供离线测试。
// 它决定右栏"团队区块"看到什么：一旦它把"没有团队"归一化成"空团队"，
// 或者擅自重算 ready/blockedBy，右栏就会显示与 Harness 不一致的事实。
module.exports = {
  registerMissionIpc,
  MISSION_IPC_CHANNELS,
  ACTIONS,
  normalizeAgentTeam,
  // 纯函数导出仅供离线测试（派发指令是执行契约的传输格式，必须可断言）
  renderDispatchInstruction,
  parseDispatchKey,
  DISPATCH_KEY_PREFIX,
};
