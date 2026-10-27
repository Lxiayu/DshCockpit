'use strict';

// src/work/work-controller.js — 工作项状态机（v0.7 P1，壳侧纯逻辑）。
//
// 职责：把一次 Team 执行（job 级状态）映射成一个**用户可理解的工作项**，
// 并落下机械门禁：**没有产物就没有"完成"**。
//
// 边界：
//   - 只读 Team 的只读快照（state()），绝不写 Team fact、绝不推断 Team 内部状态；
//   - 产物登记由 transport 回调驱动（内容/路径只在壳内），本模块只保存引用与来源；
//   - 一切持久化经 workspace-store（索引），本模块不直接碰 fs。

const TERMINAL_TEAM_STATUS = Object.freeze(['completed', 'failed', 'cancelled']);
const ACTIVE_STATUS = Object.freeze(['running', 'attention']);
const STATUSES = Object.freeze([
  'running', 'attention', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted', 'abandoned',
]);

function freezeItem(item) {
  return Object.freeze({
    workItemId: item.workItemId,
    goal: item.goal,
    templateId: item.templateId,
    status: item.status,
    runRef: item.runRef === undefined ? null : item.runRef,
    startedAtMs: item.startedAtMs,
    finishedAtMs: item.finishedAtMs === undefined ? null : item.finishedAtMs,
    artifactRefs: Object.freeze([...(item.artifactRefs || [])]),
    phase: item.phase === undefined ? null : item.phase,
    blockedCode: item.blockedCode === undefined ? null : item.blockedCode,
  });
}

/**
 * @param {object} deps
 * @param {object} deps.store        createWorkspaceStore() 的实例
 * @param {object} deps.workspace    store.open() 的返回值
 * @param {() => number} [deps.nowMs]
 * @param {(message: string) => void} [deps.log]
 * @param {() => string} [deps.idFactory]  workItemId 生成（测试可注入确定性 id）
 */
function createWorkController({ store, workspace, nowMs = () => Date.now(), log = () => {}, idFactory } = {}) {
  if (!store || typeof store.readIndex !== 'function') throw new Error('work controller needs a workspace store');
  if (!workspace || typeof workspace.path !== 'string') throw new Error('work controller needs an open workspace');

  let seq = 0;
  const nextId = idFactory || (() => {
    seq += 1;
    return `wi-${nowMs()}-${seq}`;
  });
  let currentId = null; // 只允许一个活动工作项（P1）

  // 重启恢复：上次进程留下的 running/attention 项没有活着的执行链 —— 如实标为 interrupted。
  (function reconcileStaleItems() {
    const index = store.readIndex(workspace);
    let changed = false;
    for (const item of index.items) {
      if (ACTIVE_STATUS.includes(item.status)) {
        item.status = 'interrupted';
        item.finishedAtMs = null;
        changed = true;
      }
    }
    if (changed) {
      store.flush(workspace);
      log('[work] stale running items marked interrupted');
    }
  }());

  function indexItems() {
    return store.readIndex(workspace).items;
  }

  function activeItem() {
    if (currentId === null) return null;
    return indexItems().find((item) => item.workItemId === currentId) || null;
  }

  function begin({ goal, templateId = 'research-review' } = {}) {
    const text = typeof goal === 'string' ? goal.trim() : '';
    if (text === '') return Object.freeze({ ok: false, code: 'WORK_GOAL_REQUIRED' });
    const active = activeItem();
    if (active && ACTIVE_STATUS.includes(active.status)) {
      return Object.freeze({ ok: false, code: 'WORK_BUSY' });
    }
    const item = {
      workItemId: nextId(),
      goal: text,
      templateId,
      status: 'running',
      runRef: null,
      startedAtMs: nowMs(),
      finishedAtMs: null,
      artifactRefs: [],
      phase: null,
    };
    store.appendItem(workspace, item);
    currentId = item.workItemId;
    log('[work] work item started');
    return Object.freeze({ ok: true, code: null, item: freezeItem(item) });
  }

  /** transport 物化成功后的回调：登记产物并挂到当前工作项。 */
  function onArtifact(record, context = {}) {
    const item = activeItem();
    if (!item) return Object.freeze({ ok: false, code: 'WORK_ITEM_NONE' });
    try {
      store.registerArtifact(workspace, {
        jobId: context.jobId,
        kind: record.kind,
        role: context.role,
        runRef: context.runRef === undefined ? null : context.runRef,
        attempt: context.attempt === undefined ? null : context.attempt,
        digest: record.digest,
        artifactPath: record.artifactPath,
        bytes: record.bytes,
      });
      const key = `${context.jobId}:${record.kind}`;
      store.attachArtifactToItem(workspace, item.workItemId, key);
      return Object.freeze({ ok: true, code: null, key });
    } catch (error) {
      log(`[work] artifact registration failed: ${error && error.message}`);
      return Object.freeze({ ok: false, code: error && error.code ? error.code : 'WORK_ARTIFACT_INVALID' });
    }
  }

  function phaseOf(teamState) {
    if (!teamState || teamState.status !== 'running') return null;
    for (const run of Object.values(teamState.runs || {})) {
      if (run && run.status === 'running' && run.progress && typeof run.progress.phase === 'string') {
        return run.progress.phase;
      }
    }
    return null;
  }

  /**
   * 把 Team 状态同步到当前工作项。**幂等**：无变化不写盘。
   * 门禁：Team completed 但没有任何产物 → incomplete（UI 不得显示"完成"）。
   */
  function sync(teamState) {
    const item = activeItem();
    if (!item) return Object.freeze({ ok: false, code: 'WORK_ITEM_NONE' });
    const teamStatus = teamState && typeof teamState.status === 'string' ? teamState.status : null;
    if (teamStatus === null) return Object.freeze({ ok: true, code: null, changed: false });
    const phase = phaseOf(teamState);
    let next = item.status;
    if (teamStatus === 'pending' || teamStatus === 'running') next = 'running';
    else if (teamStatus === 'attention') next = 'attention';
    else if (teamStatus === 'completed') next = item.artifactRefs.length > 0 ? 'completed' : 'incomplete';
    else if (teamStatus === 'failed') next = 'failed';
    else if (teamStatus === 'cancelled') next = 'cancelled';
    const patch = {};
    if (next !== item.status) patch.status = next;
    if (phase !== item.phase) patch.phase = phase;
    if (next !== 'attention' && item.blockedCode) patch.blockedCode = null;
    const terminal = next === 'completed' || next === 'incomplete' || next === 'failed' || next === 'cancelled';
    if (terminal && item.finishedAtMs === null) patch.finishedAtMs = nowMs();
    if (Object.keys(patch).length === 0) return Object.freeze({ ok: true, code: null, changed: false });
    try {
      store.updateItem(workspace, item.workItemId, patch);
    } catch (error) {
      return Object.freeze({ ok: false, code: error && error.code ? error.code : 'WORK_ITEM_UPDATE_FAILED' });
    }
    return Object.freeze({ ok: true, code: null, changed: true });
  }

  /**
   * 执行链被 Team 门禁挡住（如 HANDOFF_INCOMPLETE）：Team v0 没有 job 级 attention 命令，
   * 因此壳把它呈现为"需要你处理 + 原因码"，而不是让它永远显示 running。
   */
  function block({ role = null, code = null } = {}) {
    const item = activeItem();
    if (!item) return Object.freeze({ ok: false, code: 'WORK_ITEM_NONE' });
    if (['completed', 'incomplete', 'failed', 'cancelled', 'abandoned'].includes(item.status)) {
      return Object.freeze({ ok: false, code: 'WORK_ITEM_TERMINAL' });
    }
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'DISPATCH_REJECTED';
    store.updateItem(workspace, item.workItemId, { status: 'attention', blockedCode: safeCode, phase: null });
    log(`[work] work item blocked: ${safeCode}`);
    return Object.freeze({ ok: true, code: null, blockedCode: safeCode, role });
  }

  /** 用户显式放弃（壳层状态；不伪造任何 Team 终态）。 */
  function abandon() {
    const item = activeItem();
    if (!item) return Object.freeze({ ok: false, code: 'WORK_ITEM_NONE' });
    store.updateItem(workspace, item.workItemId, {
      status: 'abandoned', finishedAtMs: nowMs(), phase: null, blockedCode: null,
    });
    // currentId 保留：UI 仍然显示"已放弃"这一项；active 由状态推导（不再活跃）。
    log('[work] work item abandoned by the user');
    return Object.freeze({ ok: true, code: null });
  }

  /** 取消/停止后没有 Team 终态时的显式收口（仍走同一门禁）。 */
  function finish(status) {
    if (!TERMINAL_TEAM_STATUS.includes(status) && status !== 'incomplete') {
      return Object.freeze({ ok: false, code: 'WORK_STATUS_INVALID' });
    }
    return sync({ status: status === 'incomplete' ? 'completed' : status, runs: {} });
  }

  /** 快照：给工作台视图的**全部**内容（路径只在这里出现；不进入 Team/Office）。 */
  function snapshot() {
    const index = store.readIndex(workspace);
    const artifacts = index.artifacts.map((entry) => Object.freeze({
      key: entry.key,
      ref: entry.ref,
      kind: entry.kind,
      producerRole: entry.producerRole,
      digest: entry.digest,
      bytes: entry.bytes === undefined ? null : entry.bytes,
      createdAtMs: entry.createdAtMs,
    }));
    const items = index.items.map(freezeItem);
    const current = currentId === null ? null : items.find((item) => item.workItemId === currentId) || null;
    return Object.freeze({
      workspace: Object.freeze({
        id: workspace.workspaceId,
        // 壳 → 工作台视图；文档已声明这个字段的出界范围（不进 Team fact / Office 快照）。
        displayPath: workspace.displayPath,
      }),
      items: Object.freeze(items),
      artifacts: Object.freeze(artifacts),
      current: current,
      active: !!(current && ACTIVE_STATUS.includes(current.status)),
    });
  }

  return Object.freeze({
    begin,
    onArtifact,
    sync,
    block,
    abandon,
    finish,
    snapshot,
    currentItemId: () => currentId,
    // 诊断：只有计数与稳定码
    describe: () => Object.freeze({ current: currentId !== null, items: indexItems().length }),
  });
}

module.exports = { createWorkController, STATUSES, TERMINAL_TEAM_STATUS, ACTIVE_STATUS };
