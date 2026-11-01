// src/mission/harness-reader.js — 只读消费 Harness 状态（P1）。
//
// 第一性原理：这里为什么是"只读"，且为什么必须有 observedAtMs
//
//   Mission Core 与 Harness 的边界（domain-model §2.1.4）：
//     Harness 拥有：running / awaitingUser / task status / goal phase
//     Mission 拥有：status(active/paused/…) / decisions / questions / deliverables
//
//   所以 Mission **不能**维护"我正在跑"的标志位——那会立刻制造第二个事实作者，
//   而重启后两个作者会给出不同答案。
//
//   正确做法：每次需要时**读** Harness 快照，并标注**读到的时间**。
//   标注时间不是可选礼仪，是正确性要求：
//     · 没有 observedAtMs，"running=true" 会被读成"现在正在跑"
//     · 有了它，UI 才能显示"3 分钟前观察到有 Agent 在跑"
//
//   本模块**不自己连 mux**。它接收一个已经归一化的快照对象
//   （由组合根从 runtimeMux / runtime-health / office 投影中提取），
//   然后把它翻译成 Mission 关心的那几个布尔/计数。
//
//   为什么不让 mission 直接读 mux：那会让 mission 依赖 Electron 运行时，
//   破坏"mission 是纯 Node"的门禁（mission-core.md §3.1）。依赖注入是
//   保持这条边界唯一可行的方式。
'use strict';

/**
 * Harness 快照的**输入契约**。组合根负责填充。
 * 所有字段可选——缺失即视为"未知"，而不是"false"。
 */
const SNAPSHOT_FIELDS = Object.freeze([
  'hasRunningAgent',      // 当前是否有 Agent 正在执行（来自 mux 事件流/office 投影）
  'pendingApprovals',     // 待审批数
  'pendingQuestions',     // 待回答数
  'activeSessionHandle',  // 派生句柄 sess-h-*（**不是** raw sessionId）
  'goalPhase',            // dsh-goal 的 phase（active/paused/blocked/complete）
  'teamMemberCount',      // Agent Teams 成员数（0.2.x 才有）
]);

/**
 * 把原始快照归一化成 Mission 侧的安全形状。
 *
 * 关键：**只保留白名单字段**，并丢弃一切可能的隐私内容。
 * 组合根可能不小心把 raw sessionId 塞进来——这里兜住。
 *
 * @param {object} raw
 * @param {number} observedAtMs  必填。没有时间戳的快照不可用。
 */
function normalizeSnapshot(raw, observedAtMs) {
  if (!Number.isFinite(observedAtMs)) {
    // 没有时间戳的快照**不可用**：它会被读成"当前状态"，而实际上是过去某一刻。
    return { ok: false, reason: 'observedAtMs is required — an untimestamped snapshot would be read as current truth' };
  }
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = { observedAtMs };

  if (typeof input.hasRunningAgent === 'boolean') out.hasRunningAgent = input.hasRunningAgent;
  for (const key of ['pendingApprovals', 'pendingQuestions', 'teamMemberCount']) {
    const n = Number(input[key]);
    out[key] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  if (typeof input.activeSessionHandle === 'string'
      && /^sess-h-[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.activeSessionHandle)) {
    out.activeSessionHandle = input.activeSessionHandle;
  }
  if (typeof input.goalPhase === 'string' && input.goalPhase) {
    out.goalPhase = input.goalPhase;
  }

  return { ok: true, snapshot: out };
}

/**
 * 派生一个 Mission 的"实时视图"。
 *
 * 注意返回值里每个字段都只能用于**展示**，且必须与 observedAtMs 一起展示。
 * 它**不能**被写回 Mission 实体（schema.js 的黑名单会拒绝）。
 */
function deriveLiveView(view, snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.observedAtMs)) {
    return {
      available: false,
      reason: 'no timestamped Harness snapshot available',
    };
  }

  const live = {
    available: true,
    observedAtMs: snapshot.observedAtMs,
    // Mission 自身的 active 状态（这是我们拥有的）
    missionActive: !!(view && view.mission && view.mission.status === 'active'),
    // Harness 的事实（我们只读）
    hasRunningAgent: snapshot.hasRunningAgent === true,
    pendingApprovals: snapshot.pendingApprovals || 0,
    pendingQuestions: snapshot.pendingQuestions || 0,
  };

  // "等你决定" 是派生概念：有待审批或待回答就是 true
  live.awaitingUser = live.pendingApprovals > 0 || live.pendingQuestions > 0;

  // "这一刻有人在为这个 Mission 干活" = Mission active && 有 running agent
  // 注意：这是**近似**——Harness 不知道事件属于哪个 Mission。
  // 我们在有 activeSessionHandle 时才合并，否则只说"某个会话在跑"。
  live.runningForThisMission = live.missionActive && live.hasRunningAgent && false;
  if (live.missionActive && live.hasRunningAgent && snapshot.activeSessionHandle) {
    const lastRef = view && view.mission ? view.mission.lastSessionRef : null;
    // 只有当这个会话句柄确实是这个 Mission 上次记录的会话时，才敢说"为它而跑"
    live.runningForThisMission = !!lastRef && lastRef === snapshot.activeSessionHandle;
  }

  return live;
}

/**
 * 判断一个 Mission 是否"这周没动"（纯派生，不持久化）。
 *
 * domain-model §2.1.4 明确：这个状态是派生的，不存。
 * 存下来就会变成第二个事实作者。
 */
function staleness(view, nowMs, staleAfterDays = 7) {
  if (!view || !view.mission) return { stale: false, daysSinceUpdate: null };
  const updated = Number(view.mission.updatedAtMs);
  if (!Number.isFinite(updated) || !Number.isFinite(nowMs)) {
    return { stale: false, daysSinceUpdate: null, reason: 'cannot compute without both timestamps' };
  }
  const days = (nowMs - updated) / (24 * 60 * 60 * 1000);
  return {
    stale: days > staleAfterDays,
    daysSinceUpdate: Math.floor(days),
    staleAfterDays,
  };
}

/**
 * 汇总一个 Workspace 内所有 Mission 的实时视图。
 * 用于 Mission 列表页：一次性算完所有 Mission 的 running/awaiting/stale。
 */
function deriveWorkspaceLive(views, snapshot, nowMs, staleAfterDays = 7) {
  const list = Array.isArray(views) ? views.filter(Boolean) : [];
  return list.map((view) => ({
    missionId: view.mission.missionId,
    title: view.mission.title,
    status: view.mission.status,
    live: deriveLiveView(view, snapshot),
    staleness: staleness(view, nowMs, staleAfterDays),
  }));
}

module.exports = {
  SNAPSHOT_FIELDS,
  normalizeSnapshot,
  deriveLiveView,
  deriveWorkspaceLive,
  staleness,
};
