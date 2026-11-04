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

// ---------------------------------------------------------------------------
// 团队侧对账（S3 中**不依赖架构切换**的那部分）
//
// 第一性原理：为什么需要它，尽管两侧各自都"有数据"
//
//   合同说"要做 A、B、C 三条验收"，团队任务板上可能只有 1 条任务。
//   两边都不报错 —— 但合起来意味着**团队只承诺了一件、漏了两件**。
//   用户看到的是一支"在忙"的团队，而没人告诉他承诺与执行对不上。
//
//   所以这里做的是**把两个事实源摆在一起**，只陈述差异，不判定对错：
//     · 合同有 3 条验收，任务板只有 1 条 → 陈述"2 条验收没有对应任务"
//     · 任务板有任务但合同没验收        → 陈述"有 1 个任务不在合同里"
//
//   为什么只陈述不判定：验收条件是否"已覆盖"需要语义理解，
//   而我们能做的是**字面可核对的匹配**。假装能判定对错会误导用户。
//   （这也是 receipt.js 里"verified 是人的判断"的同一条原则。）
// ---------------------------------------------------------------------------

/** 验收条件与任务的匹配强度。 */
const COVERAGE = Object.freeze([
  'covered',    // 任务的 subject/description 里能找到这条验收的文本片段
  'missing',    // 找不到
]);

/** 把文本归一化用于字面匹配：去空白、小写。 */
function normText(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, '').toLowerCase() : '';
}

/**
 * 判断一条验收条件是否被某个任务"字面覆盖"。
 *
 * 判据刻意保守：验收文本（归一化后）必须作为子串出现在任务的
 * subject 或 description 里。不用模糊匹配 —— 模糊匹配会产生
 * "看起来覆盖了"的假阳性，那比漏报更糟（用户会以为有保护）。
 */
function acceptanceCoveredByTask(acceptanceText, task) {
  if (!task || typeof task !== 'object') return false;
  const needle = normText(acceptanceText);
  if (!needle) return false;
  const hay = normText(task.subject) + '|' + normText(task.description);
  return hay.includes(needle);
}

/**
 * 合同与团队任务板对账。
 *
 * @param {object} input
 * @param {object|null} input.contract  Mission 合同
 * @param {object|null} input.team      agentTeam 投影
 * @returns {{
 *   available:boolean,
 *   reason?:string,
 *   acceptance:{total:number, covered:number, missing:Array<{text:string}>},
 *   orphanTasks:Array<{id:string, subject:string, status:string}>,
 *   taskCount:number,
 *   memberCount:number|null
 * }}
 */
function reconcileTeam({ contract, team } = {}) {
  const empty = {
    available: false,
    acceptance: { total: 0, covered: 0, missing: [] },
    orphanTasks: [],
    taskCount: 0,
    memberCount: null,
  };

  // 读不到团队投影 ≠ 没有团队。两者的区别必须保留 ——
  // 把"读不到"说成"没有任务"会让用户以为团队什么都没做。
  if (!team || typeof team !== 'object') {
    return { ...empty, reason: '读不到团队投影（不是"没有任务"）' };
  }
  const tasks = (Array.isArray(team.tasks) ? team.tasks : [])
    .filter((x) => x && typeof x === 'object' && x.status !== 'deleted');
  const members = Array.isArray(team.members) ? team.members : [];
  const memberCount = members.length;

  const acceptances = contract && Array.isArray(contract.acceptance)
    ? contract.acceptance.filter((a) => a && typeof a.text === 'string' && a.text.trim())
    : [];

  // 每条验收：找一个覆盖它的任务（找到即止）
  const coveredTaskIds = new Set();
  const missing = [];
  let covered = 0;
  for (const a of acceptances) {
    const hit = tasks.find((t2) => acceptanceCoveredByTask(a.text, t2));
    if (hit) {
      covered += 1;
      coveredTaskIds.add(hit.id);
    } else {
      missing.push({ text: a.text });
    }
  }

  // 不在任何验收覆盖范围内的任务：不判定它"多余"，
  // 只是陈述"它不在合同的验收里"——可能是探索性工作，也可能是跑偏了。
  const orphanTasks = tasks
    .filter((t3) => t3.id && !coveredTaskIds.has(t3.id))
    .map((t4) => ({ id: t4.id, subject: t4.subject || '', status: t4.status || '' }));

  return {
    available: true,
    acceptance: { total: acceptances.length, covered, missing },
    orphanTasks,
    taskCount: tasks.length,
    memberCount,
  };
}

/**
 * 把对账结果变成一句人话。**不允许把 missing 说成"已完成"。**
 *
 * @param {object} r reconcileTeam 的结果
 * @returns {string}
 */
function describeTeamReconcile(r) {
  if (!r || !r.available) return (r && r.reason) || '无法对账';
  const { total, covered, missing } = r.acceptance;
  if (total === 0) {
    return `合同还没有验收条件，团队任务板上有 ${r.taskCount} 个任务。`;
  }
  if (missing.length === 0) {
    return `合同的 ${total} 条验收都能在任务板上找到对应任务。`;
  }
  return `合同的 ${total} 条验收里，${covered} 条能在任务板上找到，`
    + `${missing.length} 条没有对应任务（不是"已完成"）。`;
}

module.exports = {
  INTERRUPTED_CONTRACT_STATES,
  reconcileContract,
  reconcileMissionView,
  dispatchProgress,
  COVERAGE,
  normText,
  acceptanceCoveredByTask,
  reconcileTeam,
  describeTeamReconcile,
};
