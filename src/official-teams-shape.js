// src/official-teams-shape.js — 官方 Agent Teams 客户端视图的字段形状（Issue #23）。
//
// 背景：#23 一直标着"需真实模型调用验证"，是 P0 唯一未达成项。
// 但核实后发现：字段形状**不需要跑模型就能确认**——它写在官方包的
// TypeScript 类型定义里，位置固定、可逐字段核对。
//
//   @deepseek-ai/dsh-experimental-agent-team/lib/types/types.d.ts
//     · TeamProjection       — Session projection 的 `agentTeam` 载荷
//     · TeamMemberProjection — roster 的一行
//     · TeamTaskView         — task board 的一行（runtime 增强）
//     · TeamMemberPhase      — 'provisioning' | 'active' | 'failed'
//     · TeamTaskStatus       — 'pending' | 'in_progress' | 'completed' | 'deleted'
//
// 第一性原理：为什么要把类型定义变成代码里的常量
//
//   "我看过文档了"不能防止漂移。官方升级后字段变了，DshCockpit 的适配层
//   会静默读到 undefined，然后 Office 里就少了一个员工——没人会立刻发现。
//
//   所以把形状写成本模块的常量，并在 CI 里用真实的类型定义文件做**形状比对**。
//   官方一变，CI 先红，而不是用户先发现。
//
// 第二性原理：为什么不直接读 .d.ts 而要有常量
//
//   生产代码不该依赖官方包的安装路径（打包后可能不在）。
//   常量是运行时契约；比对脚本是 CI 检查。两者分工明确。
'use strict';

/** roster 一行的字段（顺序无关，但必须精确匹配）。 */
const TEAM_MEMBER_FIELDS = Object.freeze(['id', 'name', 'role', 'phase', 'error']);

/** task board 一行的字段。 */
const TEAM_TASK_FIELDS = Object.freeze([
  'id', 'revision', 'subject', 'description', 'status',
  'blockedBy', 'writeScopes', 'ownerName', 'ready', 'writeScopeWarnings',
]);

/** `agentTeam` projection 的顶层字段。 */
const TEAM_PROJECTION_FIELDS = Object.freeze(['members', 'tasks', 'failure']);

/** 成员生命周期（durable）。Lead 行恒为 active。 */
const TEAM_MEMBER_PHASES = Object.freeze(['provisioning', 'active', 'failed']);

/** 任务状态。注意 `deleted` 是软删，projection 里不会出现。 */
const TEAM_TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'completed', 'deleted']);

/** 成员角色。 */
const TEAM_MEMBER_ROLES = Object.freeze(['lead', 'teammate']);

/**
 * 校验一个 `agentTeam` projection 载荷的形状。
 *
 * 这是**形状**校验，不是业务校验：它回答"我能不能安全地读这些字段"，
 * 不回答"这个 Team 状态对不对"。
 *
 * 设计要点：
 *   · 多余字段**允许**（官方可能加字段，加字段不该让适配层崩）
 *   · 缺失必需字段**拒绝**（那才会让适配层读到 undefined）
 *   · 未知枚举值**报告但不崩**（降级成 unknown，让 Office 显示"未知"而不是消失）
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], value:object|null}}
 */
function validateTeamProjection(raw) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['agentTeam projection must be an object'], warnings, value: null };
  }

  // ---- 顶层 ----
  if (!Array.isArray(raw.members)) errors.push('members must be an array');
  if (!Array.isArray(raw.tasks)) errors.push('tasks must be an array');
  if ('failure' in raw && raw.failure !== undefined && typeof raw.failure !== 'string') {
    errors.push('failure must be a string when present');
  }

  const members = [];
  for (const [i, m] of (Array.isArray(raw.members) ? raw.members : []).entries()) {
    if (!m || typeof m !== 'object') { errors.push(`members[${i}] must be an object`); continue; }
    for (const f of ['id', 'name', 'role', 'phase']) {
      if (!(f in m)) errors.push(`members[${i}] missing "${f}"`);
    }
    if (m.role !== undefined && !TEAM_MEMBER_ROLES.includes(m.role)) {
      warnings.push(`members[${i}].role has unknown value "${m.role}"`);
    }
    if (m.phase !== undefined && !TEAM_MEMBER_PHASES.includes(m.phase)) {
      // 未知 phase 不崩：降级成 unknown，Office 显示"未知"而不是让员工消失。
      warnings.push(`members[${i}].phase has unknown value "${m.phase}"`);
    }
    members.push({
      id: m.id,
      name: m.name,
      role: TEAM_MEMBER_ROLES.includes(m.role) ? m.role : 'teammate',
      phase: TEAM_MEMBER_PHASES.includes(m.phase) ? m.phase : 'unknown',
      error: typeof m.error === 'string' ? m.error : undefined,
    });
  }

  const tasks = [];
  for (const [i, t] of (Array.isArray(raw.tasks) ? raw.tasks : []).entries()) {
    if (!t || typeof t !== 'object') { errors.push(`tasks[${i}] must be an object`); continue; }
    for (const f of ['id', 'subject', 'status']) {
      if (!(f in t)) errors.push(`tasks[${i}] missing "${f}"`);
    }
    if (t.status !== undefined && !TEAM_TASK_STATUSES.includes(t.status)) {
      warnings.push(`tasks[${i}].status has unknown value "${t.status}"`);
    }
    tasks.push({
      id: t.id,
      revision: Number.isInteger(t.revision) ? t.revision : null,
      subject: typeof t.subject === 'string' ? t.subject : '',
      status: TEAM_TASK_STATUSES.includes(t.status) ? t.status : 'unknown',
      blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
      writeScopes: Array.isArray(t.writeScopes) ? t.writeScopes : [],
      ownerName: typeof t.ownerName === 'string' ? t.ownerName : undefined,
      ready: t.ready === true,
      writeScopeWarnings: Array.isArray(t.writeScopeWarnings) ? t.writeScopeWarnings : [],
    });
  }

  if (errors.length > 0) return { ok: false, errors, warnings, value: null };
  return {
    ok: true,
    errors,
    warnings,
    value: { members, tasks, failure: typeof raw.failure === 'string' ? raw.failure : undefined },
  };
}

/**
 * 把官方 projection 映射成 Office 能用的最小事实。
 *
 * 隐私边界：只保留**已经在客户端视图里**的字段。
 * 不透传 id（SessionId 是 raw sessionId，隐私规则 §2.4 禁止进 Office 快照）。
 */
function toOfficeTeamFacts(projection) {
  const v = validateTeamProjection(projection);
  if (!v.ok) return { ok: false, errors: v.errors, facts: null };
  const p = v.value;
  return {
    ok: true,
    errors: [],
    warnings: v.warnings,
    facts: {
      memberCount: p.members.length,
      // 只数状态，不带 id/name —— Office 只需要"几个人在什么阶段"
      phaseCounts: {
        provisioning: p.members.filter((m) => m.phase === 'provisioning').length,
        active: p.members.filter((m) => m.phase === 'active').length,
        failed: p.members.filter((m) => m.phase === 'failed').length,
        unknown: p.members.filter((m) => m.phase === 'unknown').length,
      },
      taskCounts: {
        pending: p.tasks.filter((t) => t.status === 'pending').length,
        inProgress: p.tasks.filter((t) => t.status === 'in_progress').length,
        completed: p.tasks.filter((t) => t.status === 'completed').length,
      },
      // 有 failure = Team 卡住了，这是 Office 该显示"需要你"的信号
      hasFailure: typeof p.failure === 'string' && p.failure !== '',
    },
  };
}

module.exports = {
  TEAM_MEMBER_FIELDS,
  TEAM_TASK_FIELDS,
  TEAM_PROJECTION_FIELDS,
  TEAM_MEMBER_PHASES,
  TEAM_TASK_STATUSES,
  TEAM_MEMBER_ROLES,
  validateTeamProjection,
  toOfficeTeamFacts,
};
