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

const path = require('node:path');
const { createMissionStore } = require('./mission/store');
const brief = require('./mission/brief');
const deliverable = require('./mission/deliverable');
const harnessReader = require('./mission/harness-reader');
const migration = require('./mission/migration');
const schema = require('./mission/schema');
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
  'verifyDeliverables',   // 校验产物是否仍与登记时一致
  'getBrief',             // 生成 Mission Brief
  'diagnostics',          // 日志健康度 / 备份 / 归档状态 / 迁移计划
  'openDesk',             // 打开 Mission Desk 窗口
  'syncBrief',            // 把 Brief 写入 <workspace>/AGENTS.md（下次会话自动生效）
  'unsyncBrief',          // 移除 Brief 块（只删标记块，不删文件）
  'briefSyncState',       // 只读：当前 AGENTS.md 同步到了哪个 Mission
]);

function nowMs() { return Date.now(); }

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
