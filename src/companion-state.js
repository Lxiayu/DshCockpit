// src/companion-state.js — Companion Mode 的状态派生（P2.4 S1）。
//
// 第一性原理：常驻小窗到底该显示什么
//
//   用户在**不打开完整办公室**时，需要知道什么？
//
//   不是全部状态。用户切到别的应用工作时，只关心一件事：
//   「有没有需要我处理的事」。
//
//   推导链：
//     1. 用户不打开完整窗口 → 注意力在别处
//     2. 注意力在别处 → 只可能被**值得打断**的信息吸引
//     3. 值得打断的只有两类：
//        · 待你处理（pending 审批/提问）—— 阻塞了进展
//        · 正在运行的任务（running）—— 让用户知道"它还在干活"
//     4. 其余信息（谁在走动、今天用量、Mission 全貌）都不值得打断
//
//   所以本模块只派生**两个数字**和一个布尔：
//     pendingCount  待你处理的数量
//     runningCount  正在执行的员工数
//     hasAttention  是否有任何需要用户注意的事
//
// 第二性原理：为什么"不丢状态"不等于"显示所有状态"
//
//   路线图的验收标准是「把办公室收成常驻小窗，不丢状态」。
//   容易误读成"小窗里要能看到所有状态"——那是错的，会把 PixiJS 常驻。
//
//   "不丢状态"的真实含义是三件事（本模块只负责第 3 件）：
//     1. 窗口切换不重建渲染器（S3 负责）
//     2. 主窗口关闭后 Companion 仍在（S3 负责）
//     3. **数据不因形态变化而重置**（本模块负责：派生是纯函数，
//        同快照必然同结果，形态不影响数据）
//
// 第三性原理：为什么 0 待办不能显示警示红
//
//   这是本项目已经确立的纪律（见 office.html 的 need-zero 处理）。
//   常驻小窗比面板更严格：一个永远亮着红点的托盘图标会让用户
//   在两天内学会无视它——那时真正的告警也就失效了。
//   所以 hasAttention 是**显式的**，0 时必须为 false。
'use strict';

/**
 * 从 office 快照派生 Companion 状态。
 *
 * @param {object|null} snapshot  office:state 推来的快照
 * @returns {{available:boolean, pendingCount:number, runningCount:number,
 *            hasAttention:boolean, reason:string|null}}
 */
function deriveCompanionState(snapshot, nowMs) {
  // 注意 Array.isArray：数组也是 object，但空数组不是有效快照。
  // 不加这条会让 `deriveCompanionState([])` 报 available:true —— 一次真实的误报。
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    // 没有快照 ≠ 安静。如实报不可用，让小窗显示"未连接"而不是"0 待办"——
    // 后者会让用户以为一切正常。
    // urgency 显式 null：断线时不判断紧急度——它什么都不知道。
    // 给 normal 会暗示"看过了，不急"，那是编造。
    return { available: false, pendingCount: 0, runningCount: 0, hasAttention: false, urgency: null, reason: 'no-snapshot' };
  }

  const pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
  const employees = Array.isArray(snapshot.employees) ? snapshot.employees : [];

  const pendingCount = pending.length;
  // running 是状态机里的确定值（state-reducer.js RUNTIME_STATES）。
  // attention 也算"在忙"——它意味着该员工需要用户看一眼，但那条信息
  // 已经由 pendingCount 承载，所以这里只数 running，避免重复计数。
  const runningCount = employees.filter((e) => e && e.runtime === 'running').length;

  return {
    available: true,
    pendingCount,
    runningCount,
    // 只有真实的待办才算"需要你"。运行中的任务不打断用户——
    // 它只是让人安心，不是行动号召。
    hasAttention: pendingCount > 0,
    // "要不要现在看"——由 risk 与等待时长派生，不靠数量猜。
    urgency: deriveUrgency(pending, nowMs),
    reason: null,
  };
}

/**
 * 小窗要显示的一行文案（内容由调用方本地化，这里只给"种类"）。
 *
 * 为什么不直接返回字符串：i18n 在主进程有 lang()，但小窗页面自己
 * 也有一份语言状态。返回种类让两边都能本地化，避免两处语言不一致。
 */
function companionSummary(state) {
  const s = state || {};
  if (!s.available) return { kind: 'disconnected', pendingCount: 0, runningCount: 0, urgency: null };
  if (s.pendingCount > 0) {
    return {
      kind: 'needs-you',
      pendingCount: s.pendingCount,
      runningCount: s.runningCount,
      // urgency 由 deriveCompanionState 一并算出（需要 pending 原始列表）
      urgency: s.urgency || null,
    };
  }
  if (s.runningCount > 0) return { kind: 'working', pendingCount: 0, runningCount: s.runningCount, urgency: null };
  return { kind: 'idle', pendingCount: 0, runningCount: 0, urgency: null };
}

// ---------------------------------------------------------------------------
// urgency —— "要不要现在看"（P4 Companion 信息增强）
//
// 第一性原理：小窗只该回答一个问题
//
//   用户在别的应用里看到小窗，要决定的是：**现在切过去吗？**
//   只有"3 件"这个数字答不了这个问题——3 件低风险提问可以等，
//   1 件高风险审批必须马上看。**同样是 3 件，紧急程度可能相反。**
//
// 第二性原理：紧急度必须从真实信号派生
//
//   最容易犯的错是"数量多就急"，或者直接用红色。
//   但那样是**编造状态**——颜色的语义不来自真实数据。
//
//   可用的真实信号（都已在快照里，不需要新通道）：
//     · risk 等级（'high' | 'medium' | 'low'）
//     · 等待时长（createdAtMs 距今）
//
// 第三性原理："可以稍后"比"紧急"更有价值
//
//   "紧急"用户自己会感觉到（红点在那儿）。
//   "可以稍后"是**用户自己判断不出来的**——他看不到 risk 和等待时长。
//   一个只会喊"有 3 件"的工具会让人每次都切过去看；
//   能说"3 件都不急"的才真的省注意力——**那才是常驻小窗的价值**。
// ---------------------------------------------------------------------------

/** 超过这个时长且全是低风险 → 判定"可以稍后"。 */
const LATER_AFTER_MS = 10 * 60 * 1000;

/** urgency 的三种取值。null 表示"无需判断"（没有待办）。 */
const URGENCIES = Object.freeze(['urgent', 'normal', 'later']);

/**
 * 从 pending 列表派生 urgency。
 *
 * **只用真实信号**：high risk / 等待时长。不看数量。
 *
 * @param {Array} pending      office 快照里的 pending 列表
 * @param {number} [nowMs]     当前时间（便于测试注入）
 * @returns {'urgent'|'normal'|'later'|null}
 */
function deriveUrgency(pending, nowMs) {
  const list = Array.isArray(pending) ? pending : [];
  if (list.length === 0) return null;

  // 1) 有任何 high risk → 必须现在看。这一条优先于所有其他判断。
  const hasHigh = list.some((p) => p && p.risk === 'high');
  if (hasHigh) return 'urgent';

  // 2) 全部是低风险且已经等了很久 → 可以稍后。
  //    注意用 Math.min（最早的那条）判断"等待最久的等了多久"。
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ages = list
    .map((p) => (p && Number.isFinite(p.createdAtMs) ? now - p.createdAtMs : null))
    .filter((a) => a !== null);
  if (ages.length === list.length) {
    const oldest = Math.max(...ages);
    const allLow = list.every((p) => p && p.risk === 'low');
    if (allLow && oldest >= LATER_AFTER_MS) return 'later';
  }

  // 3) 其余：中性。不催也不安抚——因为数据不支持任何一边的结论。
  return 'normal';
}

module.exports = { deriveCompanionState, companionSummary, deriveUrgency, URGENCIES, LATER_AFTER_MS };
