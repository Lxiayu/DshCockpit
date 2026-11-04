// src/mission/intervention-observation.js — 干预效果的观测（S6）。
// 纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么"干预生效了吗"需要一个专门的判定
//
//   我们下发了 `interrupt_agent`，但官方**不改变 `phase`** ——
//   phase 是生命周期（provisioning/active/failed），不是"在不在跑"。
//   所以"它停了吗"这个问题，协议层没有答案。
//
//   能拿到的只有间接信号：该成员负责任务的 **revision 是否还在变**。
//
//   但这里必须极其克制，因为同一个信号有两种解释：
//     · revision 不变 → 它停了？还是它在思考、在等审批、已经结束？
//     · revision 在变 → 它没停（这一条是**确定的**）
//
//   所以本模块只输出三态，且措辞严格：
//     'still-moving'  → revision 变了，**确定没停**
//     'quiet'         → revision 没变，**只能说"看起来停了"**
//     'unknown'       → 没有快照/读不到，**什么都不能说**
//
//   为什么不允许 'stopped' 这个状态：那是一个我们无法验证的断言。
//   把"看起来停了"说成"已停止"，会让用户以为安全了 —— 而这正是本项目
//   反复强调的底线（见 receipt.js：verified 是人的判断，不是数据信号）。
'use strict';

/** 观测结论。**故意没有 `stopped`** —— 那是我们验证不了的断言。 */
const OBSERVATION_STATES = Object.freeze(['still-moving', 'quiet', 'unknown']);

/**
 * 比较干预前后的任务快照。
 *
 * @param {object} input
 * @param {object|null} input.before  干预前快照 {atMs, tasks:[{id,revision,status}]}
 * @param {object|null} input.after   之后重拍的快照（同形状）
 * @returns {{state:string, changed:Array, unchanged:Array, reason:string}}
 */
function observeIntervention({ before, after } = {}) {
  const empty = { state: 'unknown', changed: [], unchanged: [], reason: '没有可对比的快照' };
  if (!before || typeof before !== 'object' || !Array.isArray(before.tasks)) return empty;
  if (!after || typeof after !== 'object' || !Array.isArray(after.tasks)) {
    return { ...empty, reason: '读不到干预后的团队状态' };
  }

  // 以 before 的任务为基准逐条比对（新出现的任务不算"变化"——
  // 它可能是别的成员新建的，与这次干预无关）
  const afterById = new Map();
  for (const t of after.tasks) {
    if (t && typeof t.id === 'string') afterById.set(t.id, t);
  }

  const changed = [];
  const unchanged = [];
  for (const b of before.tasks) {
    if (!b || typeof b.id !== 'string') continue;
    const a = afterById.get(b.id);
    if (!a) {
      // 任务消失了：可能是被删除。这是**变化**，不是"没变"。
      changed.push({ id: b.id, reason: 'task-disappeared', before: b, after: null });
      continue;
    }
    if (a.revision !== b.revision || a.status !== b.status) {
      changed.push({ id: b.id, reason: 'revision-or-status-changed', before: b, after: a });
    } else {
      unchanged.push(b.id);
    }
  }

  // before 里一个任务都没有 → 这个成员本来就没任务，
  // 无法用"任务变没变"来观测。必须说不知道，而不是说"停了"。
  if (unchanged.length === 0 && changed.length === 0) {
    return { state: 'unknown', changed: [], unchanged: [], reason: '干预前这个成员没有负责任务，无法用任务变化判断' };
  }

  if (changed.length > 0) {
    return {
      state: 'still-moving',
      changed,
      unchanged,
      reason: `干预后仍有 ${changed.length} 个任务在变化 —— 它可能还没停下`,
    };
  }
  return {
    state: 'quiet',
    changed: [],
    unchanged,
    reason: `干预后 ${unchanged.length} 个任务没有变化 —— 看起来停了（但不确定，它也可能在思考或等待）`,
  };
}

/**
 * 面向用户的一句话。**不允许把 quiet 说成"已停止"。**
 *
 * @param {object} o observeIntervention 的结果
 * @returns {string}
 */
function describeObservation(o) {
  if (!o || !o.state) return '';
  if (o.state === 'still-moving') {
    return '它可能还在动：干预后任务仍在变化。可以再等一下，或到团队里查看具体情况。';
  }
  if (o.state === 'quiet') {
    return '看起来停了：干预后任务没有变化。但这不是确认 —— 它也可能在思考或等待审批。';
  }
  return o.reason || '无法判断是否生效。';
}

module.exports = {
  OBSERVATION_STATES,
  observeIntervention,
  describeObservation,
};
