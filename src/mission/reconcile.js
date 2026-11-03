// src/mission/reconcile.js — 重启对账：把"上次进程留下的中间态"纠正成可继续的状态。
//
// 第一性原理：为什么这里需要的是"对账"，而不是 OpenMuse 那种"租约"
//
//   OpenMuse 的租约解决的是一个具体问题：**多个 worker 进程抢同一个任务**，
//   所以要用 leaseId + leaseUntil 保证同一时刻只有一个执行者，
//   并用 LostLeaseError 让被接管的旧 worker 立刻停手。
//
//   我们的场景不成立：
//     · 执行者是 Harness（官方），不是我们。我们没有"两个 worker 抢任务"。
//     · 我们不调度、不重试、不重跑 —— 那些是 Harness 的事。
//     · 我们唯一的持久状态是 Mission 自己的意图记录（合同、笔记）。
//
//   所以照搬 lease 是过度设计：引入 leaseId/心跳/续租/接管，却没有抢占场景，
//   只会增加一堆永远走不到的分支。真实问题只有一个：
//
//     **进程在中间态崩溃后，重启时那个中间态永远卡住。**
//
//   例如合同 status='dispatching'（正在派发）时进程被杀：
//   它既没派发成功（没有 taskRef），也不会再继续（没有代码去推进它）。
//   用户看到一份"正在派发"的合同，等一整天也不动 —— 而真相是它早就死了。
//
//   本模块只做一件事：判断哪些中间态**肯定不可能再推进**，把它们纠正成
//   一个诚实的状态，并说明"为什么被纠正"。不猜成功，也不静默丢弃。
'use strict';

/**
 * 进程重启时**不可能继续推进**的合同状态。
 *
 * 只有 `dispatching`：它表示"prompt 已发出，正在等投影确认"。
 * 那个等待循环活在进程内存里，进程一死就没了 —— 没有任何东西会再推进它。
 *
 * 为什么 `active` 不在列表里：合同一旦进入 active，推进责任在 Harness。
 * 重启后我们只是失去了观测，不等于工作停了（这一点极其重要：
 * 把 active 降级成失败，等于因为自己看不见就宣布对方没干活）。
 */
const INTERRUPTED_CONTRACT_STATES = Object.freeze(['dispatching']);

/**
 * 对账一份 Mission 的合同状态。
 *
 * @param {object} input
 * @param {object} input.mission       Mission 实体（含可选 contract）
 * @param {number} [input.nowMs]       当前时间
 * @returns {{changed: boolean, contract: object|null, reason: string|null}}
 *   纯函数：不写盘、不发事件。调用方决定要不要 append `mission.updated`。
 */
function reconcileContract({ mission, nowMs } = {}) {
  const m = mission && typeof mission === 'object' ? mission : null;
  const contract = m && m.contract && typeof m.contract === 'object' ? m.contract : null;
  if (!contract) return { changed: false, contract: null, reason: null };

  if (!INTERRUPTED_CONTRACT_STATES.includes(contract.status)) {
    return { changed: false, contract, reason: null };
  }

  // 回到 draft：这是**唯一不失真**的回落。
  //   · 不能回 active —— 派发没确认成功过，声称 active 就是撒谎
  //   · 不能回 ended  —— 它根本没结束，只是被打断了
  //   · draft 的语义正好是"这份合同还没生效"，用户可以重新派发
  const at = Number.isFinite(nowMs) ? nowMs : null;
  return {
    changed: true,
    contract: {
      ...contract,
      status: 'draft',
      // 留下痕迹：为什么它回到了 draft。没有这一行，用户会以为是自己改的。
      interruptedAtMs: at,
      interruptedReason: '进程在该合同派发确认完成前退出，已回退为未派发状态',
    },
    reason: 'dispatching was interrupted by a process exit; rolled back to draft',
  };
}

/**
 * 对账一个 Mission 视图（mission + 子实体），返回需要写回的事件列表。
 *
 * 故意**只返回事件**、不直接写：写盘要走 store 的单写者通道，
 * 对账层不该持有写权限（职责分离，也让本函数保持纯函数可测）。
 *
 * @param {object} view  missionView() 的结果
 * @param {number} [nowMs]
 * @returns {{events: object[], reasons: string[]}}
 */
function reconcileMissionView(view, nowMs) {
  const events = [];
  const reasons = [];
  const mission = view && view.mission ? view.mission : null;
  if (!mission) return { events, reasons };

  const contractResult = reconcileContract({ mission, nowMs });
  if (contractResult.changed) {
    events.push({
      type: 'mission.updated',
      payload: { missionId: mission.missionId, contract: contractResult.contract },
    });
    reasons.push(contractResult.reason);
  }
  return { events, reasons };
}

/**
 * 判断一份合同的派发是否"卡住了"（用于运行期，不只是重启）。
 *
 * 与重启对账的区别：这个是**运行中**的兜底。
 * 派发发出后我们轮询投影确认；如果超过合理时间还没确认，
 * 就应显示"已下达，未确认"，而不是一直转圈。
 *
 * @param {object} input
 * @param {object} input.contract      合同
 * @param {number} input.nowMs         当前时间
 * @param {number} input.dispatchedAtMs 派发时刻
 * @param {number} [input.timeoutMs]   超时阈值（默认 120s）
 * @returns {'dispatching'|'unconfirmed'}
 */
function dispatchProgress({ contract, nowMs, dispatchedAtMs, timeoutMs = 120000 } = {}) {
  if (!contract || contract.status !== 'dispatching') return 'dispatching';
  const start = Number.isFinite(dispatchedAtMs)
    ? dispatchedAtMs
    : (Number.isFinite(contract.dispatchedAtMs) ? contract.dispatchedAtMs : null);
  if (start === null || !Number.isFinite(nowMs)) return 'dispatching';
  return (nowMs - start) > timeoutMs ? 'unconfirmed' : 'dispatching';
}

module.exports = {
  INTERRUPTED_CONTRACT_STATES,
  reconcileContract,
  reconcileMissionView,
  dispatchProgress,
};
