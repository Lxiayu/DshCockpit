// test/mission-dispatch-strategy.test.js — 派发策略的确定性判定（S2）。
//
// 第一性原理：这组测试守的是"默认值必须保守"
//
//   实证结论（Google Research 180 配置实验，按博客摘要引用）：
//   多 Agent 在可并行任务上更好，在顺序推理任务上反而更差。
//   所以"起几个 Agent"不是性能旋钮，而是任务结构的函数。
//
//   既然是结构的函数，就必须由**结构化事实**算出来，
//   而不是再交给一个 LLM 看着办 —— 那只是把不可复核的判断挪了个位置。
//
//   这组测试钉死两件事：
//     1. 默认必须是单成员（猜错的代价不对称：多起成员=浪费+冲突）
//     2. 冲突风险优先于并行机会（并行的收益远小于冲突的代价）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ds = require('../src/mission/dispatch-strategy.js');

function contractWith(...acceptance) {
  return { status: 'draft', acceptance };
}

test('strategy: no information at all defaults to a single member', () => {
  // 保守默认。空输入时起团队是纯浪费：没有可并行的证据，就不该并行。
  assert.equal(ds.decideStrategy().strategy, 'single');
  assert.equal(ds.decideStrategy({}).strategy, 'single');
  // 无预算声明时 memberBudget 默认 1，所以命中的是 single-budget 而不是
  // single-no-team —— 这也是保守的正确表现（未知预算 = 不许起团队）。
  assert.equal(ds.decideStrategy({}).code, 'single-budget');
  // 明确给了预算且任务简单，才走到 single-no-team
  assert.equal(ds.decideStrategy({ memberBudget: 4 }).code, 'single-no-team');
});

test('strategy: a budget of one member makes any parallel plan empty talk', () => {
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }, { id: 'c' }),
    memberBudget: 1,
  });
  assert.equal(r.strategy, 'single');
  assert.equal(r.code, 'single-budget',
    'budget is a hard constraint and must win over "these look parallelizable"');
});

test('strategy: shared write scopes beat parallelism (conflicts cost more)', () => {
  // 这条是最重要的防止"看起来能并行就并行"的规则。
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }),
    memberBudget: 4,
    sharedWriteScopes: 2,
  });
  assert.equal(r.strategy, 'single');
  assert.equal(r.code, 'single-shared-scope');
});

test('strategy: dependencies produce a sequential chain, not parallel members', () => {
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }),
    memberBudget: 4,
    hasDependencies: true,
    taskCount: 3,
  });
  assert.equal(r.strategy, 'sequential');
  assert.equal(r.code, 'sequential-chain');
});

test('strategy: a dependency with nothing to chain stays single', () => {
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }),
    memberBudget: 4,
    hasDependencies: true,
    taskCount: 1,
  });
  assert.equal(r.strategy, 'single');
  assert.equal(r.code, 'single-dependent');
});

test('strategy: independent acceptance criteria are the ONLY case for parallel', () => {
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }, { id: 'c' }),
    memberBudget: 4,
    hasDependencies: false,
    sharedWriteScopes: 0,
  });
  assert.equal(r.strategy, 'parallel');
  assert.equal(r.code, 'parallel-independent');
});

test('strategy: a single acceptance criterion is never parallel', () => {
  const r = ds.decideStrategy({
    contract: contractWith({ id: 'a' }),
    memberBudget: 4,
  });
  assert.equal(r.strategy, 'single');
});

test('strategy: rule order is constraint-first, opportunity-last', () => {
  // 同时满足"可并行"和"有共享范围"时，必须选单成员。
  const parallelButConflicting = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }, { id: 'c' }),
    memberBudget: 8,
    sharedWriteScopes: 1,
  });
  assert.equal(parallelButConflicting.strategy, 'single');

  // 预算不够时即使完全独立也只能单成员
  const parallelButPoor = ds.decideStrategy({
    contract: contractWith({ id: 'a' }, { id: 'b' }),
    memberBudget: 1,
    sharedWriteScopes: 0,
  });
  assert.equal(parallelButPoor.strategy, 'single');
});

test('strategy: every decision carries a closed-set reason code', () => {
  const codes = new Set();
  for (const input of [
    {},
    { memberBudget: 1 },
    { memberBudget: 4, sharedWriteScopes: 1 },
    { memberBudget: 4, hasDependencies: true, taskCount: 2 },
    { memberBudget: 4, contract: contractWith({ id: 'a' }, { id: 'b' }) },
  ]) {
    const r = ds.decideStrategy(input);
    codes.add(r.code);
    assert.ok(Object.prototype.hasOwnProperty.call(ds.STRATEGY_REASONS, r.code),
      `code ${r.code} must have a closed-set reason`);
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0);
  }
  assert.ok(codes.size >= 4, 'the rules must actually be distinguishable');
});

// ---------------------------------------------------------------------------
// 用户覆盖：允许改，但必须留下"是人改的"这个事实
// ---------------------------------------------------------------------------

test('override: a user choice wins but is marked as a user choice', () => {
  // 事后必须能区分"系统判的单成员"和"用户改成单成员"，
  // 否则无法评估规则本身准不准。
  const decision = ds.decideStrategy({}); // → single
  const r = ds.resolveStrategy({ decision, override: 'parallel' });
  assert.equal(r.strategy, 'parallel');
  assert.equal(r.source, 'user');
  assert.equal(r.code, 'user-override');
});

test('override: an invalid or identical override falls back to the rule', () => {
  const decision = ds.decideStrategy({}); // → single
  assert.equal(ds.resolveStrategy({ decision, override: 'auto-magic' }).source, 'rule');
  assert.equal(ds.resolveStrategy({ decision, override: 'single' }).source, 'rule',
    'choosing the same strategy is not an override');
  assert.equal(ds.resolveStrategy({ decision }).source, 'rule');
  assert.equal(ds.resolveStrategy({}).source, 'rule', 'no decision → compute one');
});

test('strategy: degenerate input never throws', () => {
  assert.doesNotThrow(() => ds.decideStrategy({ contract: 'nonsense' }));
  assert.doesNotThrow(() => ds.decideStrategy({ contract: { acceptance: 'nope' } }));
  assert.doesNotThrow(() => ds.resolveStrategy());
  assert.equal(ds.decideStrategy({ contract: { acceptance: 'nope' } }).strategy, 'single');
});
