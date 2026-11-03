// src/mission/turn-seq-tracker.js — 记录 turn → seq 的映射（S5 凭证需要）。
// 纯逻辑 + 有界内存，零 IO，可离线测试。
//
// 第一性原理：为什么凭证离不开 seq
//
//   官方 `workspace/changes` 事件的 payload **只有 {turn}**（读 .d.ts 确认）。
//   文件清单不在事件里，它留在 Host 侧，按**事件的 seq** 索引：
//     GET /api/changes.summary?sessionId=&seq=<event.seq>
//
//   而 seq 在**事件信封**上（event.seq），不在 payload 里。
//   所以要让"某个 turn 的变更清单"可被复核，我们必须先记住 turn → seq。
//
//   不记会怎样：workStatus 只能说 claimed（"有回复但没有可复核的坐标"），
//   用户永远等不到 verified。这正是上一版的状态。
//
//   记了之后，凭证坐标才完整：{sessionRef, seq, turn}。
//   其中 sessionRef 是派生句柄（不是 raw sessionId），seq 与 turn 来自官方事实。
'use strict';

/** 有界容量：只保留最近 N 个 turn 的 seq。 */
const MAX_TURNS_KEPT = 64;

/**
 * 归一化 seq：官方是品牌类型 SessionSeq，实际是数字。
 * 非有限数一律视为无效（不猜）。
 */
function normalizeSeq(seq) {
  return Number.isFinite(seq) ? seq : null;
}

/**
 * 创建 turn→seq 跟踪器。
 *
 * 只吃 `workspace/changes` 事件（它同时带 turn 与 seq）。
 * 其它事件即使有 seq 也不记 —— 它们的 seq 对应的是别的记录，
 * 拿来读 changes 会 404 或读到错的清单。
 */
function createTurnSeqTracker({ cap = MAX_TURNS_KEPT } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : MAX_TURNS_KEPT;
  /** turn -> seq */
  const byTurn = new Map();
  const order = [];
  let ignored = 0;

  return {
    /**
     * 吃一条 journal 事件。
     *
     * @param {object} event  事件信封（含 type / seq / data）
     * @returns {{recorded:boolean, turn:number|null, seq:number|null}}
     */
    ingest(event) {
      if (!event || typeof event !== 'object') { ignored += 1; return { recorded: false, turn: null, seq: null }; }
      // 只认 workspace/changes：别的类型 seq 语义不同
      if (event.type !== 'workspace/changes') {
        ignored += 1;
        return { recorded: false, turn: null, seq: null };
      }
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const turn = Number.isFinite(data.turn) ? data.turn : null;
      const seq = normalizeSeq(event.seq);
      if (turn === null || seq === null) {
        ignored += 1;
        return { recorded: false, turn: null, seq: null };
      }

      if (!byTurn.has(turn)) {
        order.push(turn);
        while (order.length > limit) {
          const old = order.shift();
          byTurn.delete(old);
        }
      }
      // 同一 turn 后来居上：官方注释说"The latest event for one turn replaces earlier ones"。
      // 所以覆盖是**正确的**，不是丢失。
      byTurn.set(turn, seq);
      return { recorded: true, turn, seq };
    },

    /** 某个 turn 的 seq；没有则 null。 */
    seqForTurn(turn) {
      if (!Number.isFinite(turn)) return null;
      const v = byTurn.get(turn);
      return Number.isFinite(v) ? v : null;
    },

    /** 最新的一个 (turn, seq)；没有则 null。 */
    latest() {
      if (order.length === 0) return null;
      const turn = order[order.length - 1];
      const seq = byTurn.get(turn);
      return Number.isFinite(seq) ? { turn, seq } : null;
    },

    stats() {
      return { turns: byTurn.size, cap: limit, ignored };
    },

    clear() {
      byTurn.clear();
      order.length = 0;
      ignored = 0;
    },
  };
}

module.exports = {
  MAX_TURNS_KEPT,
  normalizeSeq,
  createTurnSeqTracker,
};
