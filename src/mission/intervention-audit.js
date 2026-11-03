// src/mission/intervention-audit.js — 人类干预的审计记录（S6 基础）。
// 纯函数 + 一个有界环形缓冲，零 IO，可离线测试。
//
// 第一性原理：为什么"干预"必须留痕，而且留的痕不能是 payload
//
//   干预是我们这个产品里**权力最不对称**的动作：
//   用户点一下就能停掉一支正在工作的团队、改掉它的任务、打断一个成员。
//   这类动作如果没有记录，出了问题时无法回答最基本的三问：
//     · 是谁停的？
//     · 什么时候停的？
//     · 停之前团队在做什么（哪个目标、哪个任务）？
//
//   但"留痕"有两种做法，只有一种是对的：
//
//     ✗ 记下完整内容（消息全文、任务描述、模型输出）
//       → 违反隐私铁律 §2.4；而且审计日志本身变成泄露面
//     ✓ 记下**动作 + 目标 + 闭集原因 + 时间**
//       → 足够追责，且不可能因为审计而泄露任务正文
//
//   所以本模块的自律是：**只接受闭集字段**。
//   `note` 这类自由文本故意不设计 —— 一旦开了口子，迟早有人往里塞 prompt。
'use strict';

/**
 * 允许记录的干预动作。**闭集**：新增一种必须同时更新这里与 UI。
 *
 * 命名规则：`<对象>.<动词>`，与 Mission 事件类型风格一致。
 */
const INTERVENTION_ACTIONS = Object.freeze([
  'mission.paused',        // 暂停整支团队
  'mission.resumed',       // 恢复
  'mission.stopped',       // 终止
  'member.messaged',       // 对成员发定向消息（只记"发了"，不记内容）
  'member.interrupted',    // 中断成员当前 turn
  'task.reassigned',       // 重分配任务
  'task.rewritten',        // 改写任务描述（只记"改了"，不记新旧文本）
  'contract.dispatched',   // 下发合同
  'contract.revoked',      // 撤回合同
]);

/**
 * 干预原因的闭集。
 *
 * 为什么不用自由文本：自由文本必然被塞进任务描述或消息内容，
 * 而这些正是隐私铁律禁止进日志的东西。闭集牺牲一点表达力，
 * 换来"审计日志永远不可能泄露任务正文"这个硬保证。
 */
const INTERVENTION_REASONS = Object.freeze([
  'user-request',      // 用户主动操作
  'drift-suspected',   // 怀疑偏航
  'conflict',          // 执行冲突
  'budget-exceeded',   // 超出预算
  'blocked',           // 被卡住
  'correctness',       // 结果不对
  'other',
]);

/** 环形缓冲上限。超出后丢最旧的 —— 审计是"最近发生了什么"，不是全量归档。 */
const MAX_AUDIT_ENTRIES = 200;

/**
 * 构造一条审计记录。**返回 null 表示拒绝**（动作/原因不在闭集里）。
 *
 * @param {object} input
 * @param {string} input.action     必须是 INTERVENTION_ACTIONS 之一
 * @param {string} [input.reason]   必须是 INTERVENTION_REASONS 之一
 * @param {string} [input.missionId]
 * @param {string} [input.memberName]  成员名（不是 sessionId —— 隐私）
 * @param {string} [input.taskId]      团队任务 id（官方 id，不含描述）
 * @param {number} [input.atMs]
 * @returns {object|null}
 */
function buildAuditEntry({ action, reason, missionId, memberName, taskId, atMs } = {}) {
  if (!INTERVENTION_ACTIONS.includes(action)) return null;
  // reason 可缺省（省略时表示"未说明"），但给了就必须在闭集里。
  if (reason !== undefined && reason !== null && !INTERVENTION_REASONS.includes(reason)) return null;

  const entry = {
    action,
    atMs: Number.isFinite(atMs) ? atMs : null,
  };
  if (reason) entry.reason = reason;
  if (typeof missionId === 'string' && missionId) entry.missionId = missionId;
  if (typeof memberName === 'string' && memberName) entry.memberName = memberName;
  if (typeof taskId === 'string' && taskId) entry.taskId = taskId;
  return entry;
}

/**
 * 有界审计日志。
 *
 * 为什么是内存环形缓冲而不是落盘：第一版只需要回答"刚才我做了什么"。
 * 落盘涉及格式版本、轮转、隐私扫描，是另一个工程。等 S6 真机验收后再说。
 *
 * @param {object} [options]
 * @param {number} [options.cap]
 */
function createInterventionLog({ cap = MAX_AUDIT_ENTRIES } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : MAX_AUDIT_ENTRIES;
  const entries = [];
  let dropped = 0;

  return {
    /**
     * 记录一次干预。返回是否被接受（闭集校验失败会被拒，不是抛错）。
     * @returns {{ok:boolean, entry?:object, code?:string}}
     */
    record(input) {
      const entry = buildAuditEntry(input);
      if (!entry) return { ok: false, code: 'INTERVENTION_NOT_ALLOWED' };
      entries.push(entry);
      while (entries.length > limit) { entries.shift(); dropped += 1; }
      return { ok: true, entry };
    },

    /** 最近 N 条，最新在后。 */
    recent(n = 20) {
      const k = Number.isFinite(n) && n > 0 ? Math.min(n, entries.length) : entries.length;
      return entries.slice(entries.length - k);
    },

    /** 按 missionId 过滤（用于某个 Mission 的干预历史）。 */
    forMission(missionId, n = 20) {
      const hits = entries.filter((e) => e.missionId === missionId);
      const k = Number.isFinite(n) && n > 0 ? Math.min(n, hits.length) : hits.length;
      return hits.slice(hits.length - k);
    },

    /** 统计（给诊断用，不含任何内容）。 */
    stats() {
      return { size: entries.length, cap: limit, dropped };
    },
  };
}

/**
 * 面向用户的一句话描述。闭集 → 闭集文案，不拼接任何用户内容。
 * @param {object} entry
 * @returns {string}
 */
function describeIntervention(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const LABELS = {
    'mission.paused': '暂停了团队',
    'mission.resumed': '恢复了团队',
    'mission.stopped': '终止了团队',
    'member.messaged': '给成员发了消息',
    'member.interrupted': '中断了成员',
    'task.reassigned': '重分配了任务',
    'task.rewritten': '改写了任务',
    'contract.dispatched': '下发了合同',
    'contract.revoked': '撤回了合同',
  };
  const base = LABELS[entry.action] || entry.action;
  const who = entry.memberName ? `（${entry.memberName}）` : '';
  return base + who;
}

module.exports = {
  INTERVENTION_ACTIONS,
  INTERVENTION_REASONS,
  MAX_AUDIT_ENTRIES,
  buildAuditEntry,
  createInterventionLog,
  describeIntervention,
};
