// src/mission/receipt.js — 工作凭证（Work Receipt）：把"官方说这次改了什么"变成
// 可绑定、可失效的凭证。纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么"完成"需要凭证，而凭证需要坐标
//
//   没有凭证时，"完成"只能来自 Agent 的自我报告。而自我报告的问题是它
//   **无法被证伪**：Agent 说做完了，你只能选择信或不信。
//
//   凭证要解决的是可证伪性：它必须绑定一个**别人也能独立复核的坐标**。
//   在 DSH 里这个坐标是 `{sessionId, seq}` —— 即某条 `workspace/changes`
//   事件的位置。用这个坐标去问 Host，得到的是官方算出来的文件清单与增删行数，
//   **不是模型说的话**。
//
//   由此推出三条设计约束（也是本模块存在的理由）：
//     1. 凭证必须带坐标（sessionId + seq），否则无法复核
//     2. 凭证必须能**失效**：文件改了、Host 重启了、session 被 dispose 了，
//        旧凭证就不该继续显示"已验证"
//     3. 凭证不能自己算 diff —— 官方给什么就是什么，重算是第二个事实作者
//
//   为什么不做成"存一份文件内容快照"：隐私铁律 §2.4 禁止产物内容进 Mission。
//   我们只存坐标与计数，内容留在 Host。
'use strict';

/**
 * 凭证的三种状态。**这是给用户看的语义，不是内部状态**。
 *
 * - `claimed`  团队声称完成，但没有任何可复核的坐标（最弱，必须显式标注）
 * - `verified` 有一个有效坐标，且 Host 仍能提供该坐标的变更清单
 * - `stale`    曾经有过坐标，但已无法复核（Host 重启 / session dispose / 文件又变了）
 *
 * 为什么没有 `done`：完成是人的判断，不是系统的判断。
 * 系统最多能说"我看到这次改了这些文件，并且清单还在"。把 `verified`
 * 直接显示成"完成"就又把判断权交回给了机器。
 */
const RECEIPT_STATES = Object.freeze(['claimed', 'verified', 'stale']);

/**
 * 从官方 `workspace/changes` 事件 + summary 构造一个凭证坐标。
 *
 * @param {object} input
 * @param {string} input.sessionRef  派生句柄（sess-h-…），**不是 raw sessionId**
 * @param {number} input.seq         `workspace/changes` 事件的 seq
 * @param {number} input.turn        该事件声明的 turn 号
 * @param {object} [input.summary]   官方 summary（未读到时可缺省）
 * @returns {object} 凭证对象（可直接存进 Mission 的 deliverable.receipt）
 */
function buildReceiptCoordinate({ sessionRef, seq, turn, summary } = {}) {
  const coord = {
    sessionRef: typeof sessionRef === 'string' ? sessionRef : null,
    seq: Number.isFinite(seq) ? seq : null,
    turn: Number.isFinite(turn) ? turn : null,
  };
  // 有 summary 就带上官方给的计数；没有就如实为 null（不填 0 —— 0 是"确实没改"）。
  if (summary && typeof summary === 'object') {
    coord.total = Number.isFinite(summary.total) ? summary.total : null;
    coord.added = Number.isFinite(summary.added) ? summary.added : null;
    coord.deleted = Number.isFinite(summary.deleted) ? summary.deleted : null;
    // 文件清单：只留 path/display 与计数。**绝不存内容**。
    coord.files = Array.isArray(summary.files)
      ? summary.files
        .filter((f) => f && typeof f === 'object' && typeof f.path === 'string')
        .map((f) => ({
          path: f.path,
          display: typeof f.display === 'string' ? f.display : f.path,
          added: Number.isFinite(f.added) ? f.added : 0,
          deleted: Number.isFinite(f.deleted) ? f.deleted : 0,
          ...(f.binary === true ? { binary: true } : {}),
          ...(f.oversized === true ? { oversized: true } : {}),
        }))
      : null;
  }
  return coord;
}

/**
 * 凭证是否"可复核"——即有没有一个可以拿去问 Host 的坐标。
 *
 * 注意：坐标存在 ≠ 凭证有效。Host 可能已经忘了（重启/session dispose）。
 * 本函数只回答"结构上是否可以尝试复核"，实际有效性由调用方去问 Host。
 *
 * @param {object} receipt
 * @returns {boolean}
 */
function isReceiptAddressable(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  const hasRef = typeof receipt.sessionRef === 'string' && receipt.sessionRef !== '';
  const hasSeq = Number.isFinite(receipt.seq) && receipt.seq >= 0;
  return hasRef && hasSeq;
}

/**
 * 派生凭证状态。
 *
 * @param {object} input
 * @param {object|null} input.receipt    凭证坐标（可能为 null）
 * @param {boolean} input.resolvable     调用方刚从 Host 复核的结果：坐标还能不能读到
 * @returns {'claimed'|'verified'|'stale'}
 */
function deriveReceiptState({ receipt, resolvable } = {}) {
  if (!isReceiptAddressable(receipt)) return 'claimed';
  return resolvable === true ? 'verified' : 'stale';
}

/**
 * 面向用户的一句话说明。**不允许把 stale 说成已通过**。
 *
 * @param {object} input
 * @returns {string}
 */
function describeReceipt({ receipt, resolvable } = {}) {
  const state = deriveReceiptState({ receipt, resolvable });
  if (state === 'claimed') {
    return '团队声称完成，未提供可复核的变更坐标';
  }
  const n = receipt && Number.isFinite(receipt.total) ? receipt.total : null;
  const counts = receipt && Number.isFinite(receipt.added) && Number.isFinite(receipt.deleted)
    ? `（+${receipt.added} / −${receipt.deleted}）` : '';
  if (state === 'verified') {
    const turnText = Number.isFinite(receipt.turn) ? `第 ${receipt.turn} 轮` : '本轮';
    return n === null
      ? `已复核：${turnText}的变更清单可用`
      : `已复核：${turnText}改了 ${n} 个文件${counts}`;
  }
  // stale：坐标曾经有，但现在读不到。必须说清楚"什么时候的凭证失效了"。
  return '变更凭证已失效（Host 已不再提供该坐标），需要重新复核';
}

module.exports = {
  RECEIPT_STATES,
  buildReceiptCoordinate,
  isReceiptAddressable,
  deriveReceiptState,
  describeReceipt,
};
