// src/mission/dispatch-confirm.js — 派发确认（S2）。
// 纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么"接口返回成功"不等于"派发成功"
//
//   我们在 S0 拿到了一个关键事实（D11）：agent-team **没有 remote 写表面**。
//   派发的唯一实现是给 Lead 发一段结构化指令，让模型自己去调
//   spawn_teammate / team_task_create。
//
//   于是产生了一个以前不存在的状态：**指令已下达，但不知道有没有被执行**。
//
//   模型可能：
//     · 立刻照做（投影里马上出现任务）
//     · 理解偏了，建了别的任务（投影里有任务，但不是我们要的那个）
//     · 拒绝或跑偏，什么都没建（投影毫无变化）
//     · 还在想（投影暂时没变化）
//
//   把这四种情况混成"成功/失败"两种，就是在撒谎。所以本模块定义四种状态，
//   判据只有一个：**投影里有没有出现我们那个幂等键对应的任务**。
//
//   这也是为什么派发指令的首行必须是 `[mission-dispatch:<key>]` ——
//   没有它就无法区分"模型建了我要求的任务"和"模型建了别的任务"。
'use strict';

/**
 * 派发结果状态。**四种，不是两种**。
 *
 * - `confirmed`   投影里出现了带我们这个 key 的任务 → 真的派发成功
 * - `unconfirmed` 已下达，超时仍未见 → 可能还在排队，也可能失败。**不能叫失败**
 * - `rejected`    prompt 被运行时拒绝 → 明确失败
 * - `pending`     还没到超时，继续等
 */
const DISPATCH_STATES = Object.freeze(['pending', 'confirmed', 'unconfirmed', 'rejected']);

/** 默认确认超时：120 秒（模型派生成员 + 建任务需要时间）。 */
const DEFAULT_CONFIRM_TIMEOUT_MS = 120000;

/**
 * 在团队投影里找"由某次派发创建的任务"。
 *
 * 判据：任务的 subject 或 description 里出现派发键。
 * 为什么用包含而不是相等：模型会在 subject 里加自己的描述，
 * 要求它一字不差地复述 key 是不现实的。但 key 是随机串，不会误匹配。
 *
 * @param {object|null} team   agentTeam 投影
 * @param {string} dispatchKey
 * @returns {object|null} 命中的任务，或 null
 */
function findDispatchedTask(team, dispatchKey) {
  if (!team || typeof team !== 'object') return null;
  if (typeof dispatchKey !== 'string' || !dispatchKey) return null;
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    if (t.status === 'deleted') continue;
    const subject = typeof t.subject === 'string' ? t.subject : '';
    const description = typeof t.description === 'string' ? t.description : '';
    if (subject.includes(dispatchKey) || description.includes(dispatchKey)) return t;
  }
  return null;
}

/**
 * 判定一次派发的当前状态。
 *
 * @param {object} input
 * @param {string} input.dispatchKey
 * @param {object|null} input.team        最新 agentTeam 投影（null = 读不到）
 * @param {number} [input.startedAtMs]    下达时刻
 * @param {number} [input.nowMs]
 * @param {number} [input.timeoutMs]
 * @param {boolean} [input.promptRejected] 运行时明确拒绝了 prompt
 * @returns {{state:string, task:object|null, reason:string}}
 */
function evaluateDispatch({
  dispatchKey, team, startedAtMs, nowMs, timeoutMs = DEFAULT_CONFIRM_TIMEOUT_MS, promptRejected,
} = {}) {
  // 运行时明确拒绝 → 这是唯一可以叫"失败"的情况
  if (promptRejected === true) {
    return { state: 'rejected', task: null, reason: '运行时拒绝了下达（prompt 未被接受）' };
  }
  const hit = findDispatchedTask(team, dispatchKey);
  if (hit) {
    return {
      state: 'confirmed',
      task: hit,
      reason: `投影中出现对应任务（${hit.id}，status=${hit.status}）`,
    };
  }
  // 投影读不到（null）与"投影里没有"是两件事，但对"确认"的结论相同：
  // 都不能说成功。区别只在措辞。
  const elapsed = (Number.isFinite(nowMs) && Number.isFinite(startedAtMs))
    ? (nowMs - startedAtMs) : 0;
  if (elapsed >= timeoutMs) {
    return {
      state: 'unconfirmed',
      task: null,
      reason: team === null || team === undefined
        ? '已下达，但读不到团队投影，无法确认'
        : `已下达，${Math.round(elapsed / 1000)}s 内投影未出现对应任务`,
    };
  }
  return { state: 'pending', task: null, reason: '等待投影出现对应任务' };
}

/**
 * 面向用户的一句话。**措辞是承诺的一部分**。
 *
 * 特别地：`unconfirmed` 绝不能说成"失败"——
 * 那会让用户重复派发，凭空制造重复任务。
 *
 * @param {string} state
 * @param {string} [reason]
 * @returns {string}
 */
function describeDispatchState(state, reason) {
  const base = {
    pending: '已下达，正在确认…',
    confirmed: '派发成功：团队已建好对应任务',
    unconfirmed: '已下达，但尚未确认（可稍后刷新查看，不要重复派发）',
    rejected: '派发失败：运行时未接受这次下达',
  }[state] || state;
  return reason ? `${base}（${reason}）` : base;
}

module.exports = {
  DISPATCH_STATES,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  findDispatchedTask,
  evaluateDispatch,
  describeDispatchState,
};
