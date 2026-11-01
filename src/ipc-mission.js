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
]);

function nowMs() { return Date.now(); }

/** Mission id 形状（与 schema 一致）：mis-<opaque>。 */
function isId(v) { return typeof v === 'string' && /^mis-[A-Za-z0-9][A-Za-z0-9-]*$/.test(v); }

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
    log = () => {},
  } = ctx;

  // 按 resolved 路径缓存 store：切换工作区时自动重建
  let cachedKey = null;
  let cachedStore = null;

  function storeFor(workspaceDir) {
    const key = path.resolve(String(workspaceDir));
    if (cachedKey !== key) {
      cachedStore = createMissionStore({ workspaceDir: key, now: clock, log });
      cachedKey = key;
    }
    return cachedStore;
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

    updateStatus(payload) {
      const r = requireStore();
      if (!r.ok) return r;
      const missionId = argString(payload.missionId);
      const to = argString(payload.to);
      if (!missionId) return fail('missionId is required', 'MISSION_ID_REQUIRED');
      if (!schema.MISSION_STATUSES.includes(to)) {
        return fail(`status must be one of ${schema.MISSION_STATUSES.join('|')} (note: "focused" is a UI concept)`, 'STATUS_INVALID');
      }
      const out = r.store.append('mission.statusChanged', { missionId, to }, { missionId });
      if (!out.ok) return fail(out.reason, 'MISSION_APPEND_FAILED');
      return { ok: true, missionId, status: to };
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
        activeQuestions: hasUserQuestions ? uq.active : [],
        settledCount: hasUserQuestions ? uq.settled.length : 0,
        // 其余投影按需透传（当前 UI 不用 tokenUsage，但保留以便将来）
        agentPreset: typeof values.agentPreset === 'string' ? values.agentPreset : null,
      };
    },

    attention() {
      let raw = null;
      try { raw = snapshotOf(); } catch { raw = null; }
      if (!raw) {
        return { ok: true, available: false, reason: 'no office snapshot', items: [], counts: { approval: 0, question: 0 } };
      }
      const items = Array.isArray(raw.pendingItems) ? raw.pendingItems : [];
      // 排序：高风险优先，然后久的优先。与 office 的 pendingSnapshot 同规则。
      const RISK_ORDER = { high: 0, medium: 1, low: 2 };
      const sorted = [...items].sort((a, b) => {
        const byRisk = (RISK_ORDER[a.risk] ?? 1) - (RISK_ORDER[b.risk] ?? 1);
        if (byRisk !== 0) return byRisk;
        const at = Number.isFinite(a.createdAtMs) ? a.createdAtMs : Infinity;
        const bt = Number.isFinite(b.createdAtMs) ? b.createdAtMs : Infinity;
        return at - bt;
      });
      const counts = { approval: 0, question: 0 };
      for (const it of items) {
        if (it.kind === 'approval') counts.approval += 1;
        else if (it.kind === 'question') counts.question += 1;
      }
      return {
        ok: true,
        available: true,
        observedAtMs: Number.isFinite(raw.observedAtMs) ? raw.observedAtMs : clock(),
        items: sorted,
        counts,
        // 零待办本身是有价值的信号（"团队运行正常"），UI 据此显示空状态
        total: items.length,
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

module.exports = { registerMissionIpc, MISSION_IPC_CHANNELS, ACTIONS };
