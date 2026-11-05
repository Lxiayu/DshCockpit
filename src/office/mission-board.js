// src/office/mission-board.js — 项目白板的数据派生（P2.3 S1）。
//
// 第一性原理：为什么这层是纯函数
//
//   办公室「项目白板」要显示 Mission 状态，但两个硬约束决定了它不能自己读：
//
//     1. office-module 受 pure-Node 门禁保护（禁止 fs/网络）
//     2. mission store 是 append-only JSONL，必须走 fs
//
//   所以数据流必然是：main.js（有 fs）→ 派生视图 → 注入 office-module。
//   本文件就是中间那一步：**纯函数，无 IO，可完全单测**。
//
//   把它独立出来的第二个理由：白板要显示什么，是一个**产品判断**，
//   不是 IO 问题。混在 main.js 里会让这个判断无法单独测试和演进。
//
// 第二性原理：为什么只显示 counts，不显示正文
//
//   白板是**概览**，不是详情页。三个理由：
//     · 视觉：一块白板放不下 intent 全文和每条决策的 rationale
//     · 隐私：正文越少进快照越好（repo-map.md 铁律 §2.4）
//     · 职责：详情属于 Mission Desk，白板的职责是"让你知道要不要点进去"
//
//   所以这里只派生数字和一两个短标识。文案截断也要在这里做，
//   而不是让渲染层自己截——那样每处截断规则会不一致。
//
// 第三性原理：为什么 stale 判定要在这里，不在渲染层
//
//   "数据过期了"是一个事实，不是一种样式。把它放在派生层：
//     · 可以单测（给定 observedAtMs 和 now，断言 stale）
//     · 渲染层只负责"stale 时怎么显示"，不负责"什么时候算 stale"
//   两者职责分开，阈值只有一个来源。
'use strict';

/** 白板最多显示几个 Mission（放不下更多，且概览不需要全量）。 */
const MAX_BOARD_MISSIONS = 3;

/** 标签在白板上的最大字符数（超长会破坏布局）。 */
const MAX_TITLE_CHARS = 40;

/**
 * 数据超过这个年龄就标记 stale。
 *
 * 30 秒的依据：Mission 状态变化是**分钟级**事件——用户改 Mission 标题、
 * 回答一个问题、加一条决策，都不是每秒发生的事。30 秒内的数据可以
 * 认为是"当前"；超过就必须明示不确定，不能让用户以为是实时的。
 */
const STALE_AFTER_MS = 30_000;

/** 截断到指定字符数，超出加省略号。 */
function truncate(text, maxChars) {
  const s = String(text == null ? '' : text);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars - 1)}…`;
}

/**
 * 从 Mission projection 派生白板数据。
 *
 * @param {object} opts
 * @param {object} opts.projection      mission/projection.js 的 projection
 * @param {number} opts.observedAtMs    这份数据是什么时候观测的（必填）
 * @param {number} [opts.nowMs]         当前时间（用于 stale 判定；省略则不算 stale）
 * @returns {object} 白板数据（可直接进 office 快照）
 */
function buildMissionBoard({ projection, observedAtMs, nowMs = null } = {}) {
  if (!Number.isFinite(observedAtMs)) {
    // 没有观测时间就无法判定新鲜度 —— 如实报不可用，而不是假装有数据。
    // （与 mission/harness-reader.js 的 normalizeSnapshot 同一纪律）
    return {
      available: false,
      reason: 'no-observation',
      observedAtMs: null,
      stale: true,
      missions: [],
      totals: { activeMissions: 0, openQuestions: 0, decisions: 0 },
    };
  }

  const missions = (projection && projection.missions) || {};
  const all = Object.values(missions);

  const active = all.filter((m) => m && m.status === 'active');
  // 排序：先按未答问题数降序（"需要你"的最该被看到），再按更新时间降序。
  // 这块白板的用途是"告诉你现在该关注什么"，不是"列出所有项目"。
  active.sort((a, b) => {
    const qa = openQuestionCountOf(projection, a.missionId);
    const qb = openQuestionCountOf(projection, b.missionId);
    if (qb !== qa) return qb - qa;
    return (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
  });

  const shown = active.slice(0, MAX_BOARD_MISSIONS).map((m) => {
    const view = missionCounts(projection, m.missionId);
    return {
      missionId: m.missionId,
      // 字段名是 `label` 而不是 `title`：privacy-redactor 的 TEXT_KEY_RE
      // 会把任何叫 title/summary/description 的字段当正文脱敏（这是正确的
      // 安全默认）。白板上这是一个**短标签**，不是 Mission 的完整标题，
      // 所以用 label 既准确又不挑战脱敏规则。
      label: truncate(m.title, MAX_TITLE_CHARS),
      status: m.status,
      workstreamCount: view.workstreamCount,
      activeWorkstreamCount: view.activeWorkstreamCount,
      decisionCount: view.decisionCount,
      openQuestionCount: view.openQuestionCount,
      deliverableCount: view.deliverableCount,
    };
  });

  const totals = shown.reduce((acc, m) => ({
    activeMissions: acc.activeMissions + 1,
    openQuestions: acc.openQuestions + m.openQuestionCount,
    decisions: acc.decisions + m.decisionCount,
  }), { activeMissions: 0, openQuestions: 0, decisions: 0 });

  return {
    available: active.length > 0,
    // available=false 但 observedAtMs 有值 = "读到了，只是当前没有 active Mission"，
    // 这与"读不到"必须能被区分（渲染层要显示不同的话）。
    reason: active.length > 0 ? null : 'no-active-missions',
    observedAtMs,
    stale: isStale(observedAtMs, nowMs),
    missions: shown,
    // 还有多少没显示（用户知道去 Desk 看全部）
    moreCount: Math.max(0, active.length - shown.length),
    totals,
  };
}

/** 一个 Mission 的各项计数。 */
function missionCounts(projection, missionId) {
  const workstreams = Object.values((projection && projection.workstreams) || {})
    .filter((w) => w && w.missionId === missionId);
  const questions = Object.values((projection && projection.questions) || {})
    .filter((q) => q && q.missionId === missionId);
  const decisions = Object.values((projection && projection.decisions) || {})
    .filter((d) => d && d.missionId === missionId);
  const deliverables = Object.values((projection && projection.deliverables) || {})
    .filter((d) => d && d.missionId === missionId);
  return {
    workstreamCount: workstreams.length,
    activeWorkstreamCount: workstreams.filter((w) => w.status === 'active').length,
    decisionCount: decisions.length,
    // 只有 status==='open' 的问题算"需要你"。已回答的不该占用白板的注意力。
    openQuestionCount: questions.filter((q) => q.status === 'open').length,
    deliverableCount: deliverables.length,
  };
}

function openQuestionCountOf(projection, missionId) {
  return missionCounts(projection, missionId).openQuestionCount;
}

/**
 * 数据是否过期。
 *
 * nowMs 省略时返回 false —— 因为"不知道现在几点"不等于"数据过期"。
 * 这样纯函数测试不需要传 now，而真实调用一定会传。
 */
function isStale(observedAtMs, nowMs) {
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return false;
  return (nowMs - observedAtMs) > STALE_AFTER_MS;
}

module.exports = {
  MAX_BOARD_MISSIONS,
  MAX_TITLE_CHARS,
  STALE_AFTER_MS,
  truncate,
  buildMissionBoard,
  missionCounts,
  isStale,
};
