// src/mission/rail-order.js — 右栏"需要你"的排序与分级（S7 数据层）。
// 纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么右栏的排序必须是一个可测试的纯函数
//
//   右栏 380px，首屏只放得下 2-3 项。**"哪几项占这 2-3 格"就是产品本身**：
//   放错了，用户会错过真正阻塞团队的事，而去看一眼不重要的提醒。
//
//   现状的问题不是"没有排序"，而是排序规则内联在渲染代码里
//   （src/ipc-mission.js 的 attention() 与 mission-desk.html），
//   导致三条关键判断**无法被测试**：
//     · 哪些属于"需要你"，哪些只是"执行提醒"
//     · 同一层里谁先谁后
//     · 空的时候该说什么
//
//   而这三条恰恰是 2026-11-03 对话里反复出现的病根：
//   "如果所有东西都标红，用户会学会无视红色"。
//
//   所以把它抽出来，用测试钉死分级与排序。
'use strict';

/**
 * 第一层：需要你决策。判据是**阻塞团队**——不处理，团队就走不下去。
 */
const DECISION_KINDS = Object.freeze([
  'approval',      // 动作授权
  'question',      // 向人提问
  'plan-review',   // 计划待批
  'conflict',      // 执行冲突（两个成员改同一文件）
]);

/**
 * 第二层：执行提醒。判据是**不阻塞**，但看不见会误判。
 *
 * 这一层**不能**用红框、不能进"需要你"的计数。混在一起的代价是
 * 第一层被稀释，用户开始无视所有红色。
 */
const REMINDER_KINDS = Object.freeze([
  'inbox',         // 用户交代了但还没被处理
  'permission-risk', // 当前是 danger-full-access
  'blocked',       // 任务被前置阻塞（不是等人，是等别的任务）
  'stale-owner',   // 任务归属者可能已失效
]);

/** 同一层内的次序。小 = 更要紧。 */
const KIND_PRIORITY = Object.freeze({
  approval: 0,      // 阻塞团队，且涉及风险动作
  conflict: 1,      // 阻塞团队，且已产生不一致
  'plan-review': 2, // 阻塞团队，但在开始前
  question: 3,      // 阻塞团队，等待信息
  'permission-risk': 10,
  blocked: 11,
  inbox: 12,
  'stale-owner': 13,
});

/** 风险档。缺失时按 medium 处理（保守：不把未知当低风险）。 */
const RISK_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });

/**
 * 判断一条待办属于哪一层。
 * @param {object} item
 * @returns {'decision'|'reminder'|null} null = 不认识，调用方应丢弃或降级
 */
function classifyAttentionItem(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = typeof item.kind === 'string' ? item.kind : '';
  if (DECISION_KINDS.includes(kind)) return 'decision';
  if (REMINDER_KINDS.includes(kind)) return 'reminder';
  return null;
}

/**
 * 排序：先分层，再层内排序。
 *
 * 层内排序（decision 层）：风险高 → 等得久 → 同类内按 kind 优先级。
 * 为什么先看风险：一个 high 风险的审批比一个 medium 的提问更该被先看到，
 * 哪怕提问更早。
 *
 * 为什么"等得久"排第二：它代表成本在累积（团队被卡着）。
 *
 * @param {object[]} items
 * @param {number} [nowMs]
 * @returns {{decisions:object[], reminders:object[], dropped:object[]}}
 */
function orderAttentionItems(items, nowMs) {
  const list = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const decisions = [];
  const reminders = [];
  const dropped = [];

  for (const item of list) {
    const layer = classifyAttentionItem(item);
    if (layer === 'decision') decisions.push(item);
    else if (layer === 'reminder') reminders.push(item);
    else dropped.push(item); // 不认识的不猜，交给调用方决定要不要显示
  }

  const ageOf = (it) => (Number.isFinite(it.createdAtMs) ? it.createdAtMs : Infinity);
  const riskOf = (it) => (RISK_ORDER[it.risk] ?? RISK_ORDER.medium);
  const kindOf = (it) => (KIND_PRIORITY[it.kind] ?? 99);

  decisions.sort((a, b) => {
    const byRisk = riskOf(a) - riskOf(b);
    if (byRisk !== 0) return byRisk;
    const byAge = ageOf(a) - ageOf(b);
    if (byAge !== 0) return byAge;
    return kindOf(a) - kindOf(b);
  });
  // 提醒层只按时间：它们不阻塞，新旧就够了。
  reminders.sort((a, b) => ageOf(a) - ageOf(b));

  return { decisions, reminders, dropped };
}

/**
 * 生成右栏首屏要显示什么。
 *
 * @param {object} input
 * @param {object[]} input.items
 * @param {number} [input.maxDecisions] 首屏最多显示几项（默认 3）
 * @param {number} [nowMs]
 * @returns {{
 *   header: {decisionCount:number, reminderCount:number, tone:'blocked'|'calm'|'unknown'},
 *   visible: {decisions:object[], reminders:object[]},
 *   overflow: {decisions:number},
 *   empty: null|{text:string}
 * }}
 */
function assembleRailAttention({ items, maxDecisions = 3, nowMs } = {}) {
  // 数据源缺席（undefined/null）≠ 没有待办。
  //
  // 这是最危险的一种空态：运行时没连上时显示"团队运行正常，没有需要你处理的事"，
  // 用户会以为一切安好，而真相是我们什么都没看到。
  // 所以来源缺席必须单独成一种 tone，让 UI 去渲染"未连接"。
  if (!Array.isArray(items)) {
    return {
      header: { decisionCount: 0, reminderCount: 0, tone: 'unknown' },
      visible: { decisions: [], reminders: [] },
      overflow: { decisions: 0 },
      empty: null,
    };
  }
  const { decisions, reminders } = orderAttentionItems(items, nowMs);
  const tone = decisions.length > 0 ? 'blocked' : 'calm';
  return {
    header: {
      decisionCount: decisions.length,
      reminderCount: reminders.length,
      tone,
    },
    visible: {
      decisions: decisions.slice(0, maxDecisions),
      reminders: reminders.slice(0, 2),
    },
    overflow: { decisions: Math.max(0, decisions.length - maxDecisions) },
    // 空态只在**真的什么都没有**时给；"有提醒但无需决策"不是空态。
    empty: decisions.length === 0 && reminders.length === 0
      ? { text: '团队运行正常，没有需要你处理的事。' }
      : null,
  };
}

module.exports = {
  DECISION_KINDS,
  REMINDER_KINDS,
  KIND_PRIORITY,
  classifyAttentionItem,
  orderAttentionItems,
  assembleRailAttention,
};
