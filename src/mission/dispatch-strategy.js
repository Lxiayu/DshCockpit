// src/mission/dispatch-strategy.js — 派发策略的确定性判定（S2）。
// 纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么"要不要拆成多个成员"必须由确定性规则决定
//
//   2026-11-03 的对话里有一个反直觉的实证结论（Google Research 180 配置实验，
//   按博客摘要引用）：多 Agent 在可并行的任务上明显更好，在顺序推理任务上
//   反而更差。也就是说 **"起几个 Agent"不是性能旋钮，而是任务结构的函数**。
//
//   那么谁来判断任务结构？两种选择：
//
//     ✗ 再交给一个 LLM 判断
//       → 它会把"看起来很大"当成"可以并行"，而真正决定能否并行的是
//         **子任务之间有没有依赖、会不会改同一批文件**。
//         更糟的是，这个判断本身又变成一次不可复核的模型输出。
//
//     ✓ 用结构化事实 + 确定性规则
//       → 输入是合同的显式字段（有多少条独立验收条件、是否声明了依赖、
//         是否共用一个 Grant 目录），输出是可复现的策略。
//         同一份合同任何时候判定结果都一样 —— 这是"可复核"的前提。
//
//   本模块只做判定，不执行。用户永远可以覆盖结论（UI 上可选择），
//   但**默认值不能是"让模型看着办"**。
'use strict';

/**
 * 策略判定的输入。**全部是结构化事实**，没有自由文本。
 *
 * @typedef {object} StrategyInput
 * @property {object} [contract]        Mission 合同
 * @property {number} [taskCount]       已知的任务数（>1 表示已拆分）
 * @property {boolean} [hasDependencies] 合同/任务里是否声明了依赖边
 * @property {number} [sharedWriteScopes] 有多少任务声明了重叠的写入范围
 * @property {number} [memberBudget]    用户允许的最大成员数（默认 1）
 */

/** 判定结论的中文理由（闭集，不含用户内容）。 */
const STRATEGY_REASONS = Object.freeze({
  'single-no-team': '只有一个可交付单位，不需要团队',
  'single-dependent': '子任务之间存在依赖，顺序执行比并行更可靠',
  'single-shared-scope': '任务会改同一批文件，并行只会制造冲突',
  'sequential-chain': '有依赖但可拆成有序任务链',
  'parallel-independent': '多个验收条件相互独立，可以并行',
  'single-budget': '成员预算只允许一个执行者',
});

/**
 * 判定派发策略。
 *
 * 规则顺序刻意如此（先约束、后机会）：
 *   1. 预算不够 → 单成员（硬约束最高优先）
 *   2. 有共享写入范围 → 单成员（并行会冲突，这是最贵的错误）
 *   3. 有依赖 → 顺序链（可拆但不可并行）
 *   4. 多个独立验收条件 → 并行
 *   5. 其余 → 单成员
 *
 * @param {StrategyInput} input
 * @returns {{strategy:'single'|'sequential'|'parallel', reason:string, code:string}}
 */
function decideStrategy(input = {}) {
  const contract = input.contract && typeof input.contract === 'object' ? input.contract : null;
  const acceptance = contract && Array.isArray(contract.acceptance) ? contract.acceptance : [];
  const taskCount = Number.isFinite(input.taskCount) && input.taskCount > 0
    ? input.taskCount : acceptance.length;
  const memberBudget = Number.isFinite(input.memberBudget) ? input.memberBudget : 1;
  const hasDeps = input.hasDependencies === true;
  const sharedScopes = Number.isFinite(input.sharedWriteScopes) ? input.sharedWriteScopes : 0;

  // 1) 预算硬约束：只允许一个执行者时，任何"并行"都是空话。
  if (memberBudget <= 1) {
    return { strategy: 'single', code: 'single-budget', reason: STRATEGY_REASONS['single-budget'] };
  }

  // 2) 共享写入范围：并行改同一批文件 = 制造冲突。
  //    这条优先于"可以并行"，因为冲突的代价远高于并行的收益。
  if (sharedScopes > 0) {
    return { strategy: 'single', code: 'single-shared-scope', reason: STRATEGY_REASONS['single-shared-scope'] };
  }

  // 3) 有依赖：可以拆成有序任务链，但不能同时跑。
  if (hasDeps) {
    return taskCount > 1
      ? { strategy: 'sequential', code: 'sequential-chain', reason: STRATEGY_REASONS['sequential-chain'] }
      : { strategy: 'single', code: 'single-dependent', reason: STRATEGY_REASONS['single-dependent'] };
  }

  // 4) 多个独立验收条件：这才是适合并行的形状。
  if (acceptance.length > 1) {
    return { strategy: 'parallel', code: 'parallel-independent', reason: STRATEGY_REASONS['parallel-independent'] };
  }

  // 5) 其余一律单成员 —— 默认值必须是保守的。
  return { strategy: 'single', code: 'single-no-team', reason: STRATEGY_REASONS['single-no-team'] };
}

/**
 * 把判定结果与用户覆盖合并。
 *
 * 为什么需要这一层：规则可能判错（它只看结构化字段，看不到全局）。
 * 但覆盖必须是**显式**的，并留下痕迹，否则事后无法区分
 * "系统判的单成员"和"用户改成单成员"。
 *
 * @param {object} input
 * @param {object} input.decision     decideStrategy 的结果
 * @param {string} [input.override]   用户显式选择
 * @returns {{strategy:string, source:'rule'|'user', reason:string, code:string}}
 */
function resolveStrategy({ decision, override } = {}) {
  const d = decision && typeof decision === 'object' ? decision : decideStrategy();
  const STRATEGIES = ['single', 'sequential', 'parallel'];
  if (typeof override === 'string' && STRATEGIES.includes(override) && override !== d.strategy) {
    return {
      strategy: override,
      source: 'user',
      code: 'user-override',
      reason: '用户显式覆盖了规则判定',
    };
  }
  return { strategy: d.strategy, source: 'rule', code: d.code, reason: d.reason };
}

module.exports = {
  STRATEGY_REASONS,
  decideStrategy,
  resolveStrategy,
};
