'use strict';

// src/office/runtime/follow-address.js — session/follow / session/page 的地址簿。
//
// 为什么需要它（0.1.5 一手事实，运行时源码 validateAddress）：
//   - 根会话用 `{kind:'session', sessionId}`；
//   - **子代理会话不能这样寻址**——运行时直接拒绝：
//       RemoteError('session/agent-busy', 'subagent Sessions require their
//       durable parent address', {reason:'use subagent delivery for this child session'})
//     正确形状是 `{kind:'subagent', parentSessionId, childSessionId, mode}`，且
//     `mode` 必须与子代理描述符一致（`continuable` / `one-shot`），`parentSessionId`
//     必须等于会话头的 `parentSession`（否则 subagent/unauthorized）。
//
// 症状（2026-09-25 长稳实测，0.1.5-rc.2）：壳把子会话当根会话开 follow，
// 流每 5s 被重开一次、每次报同一错误，直到子会话结束——日志风暴 + 子代理
// 自己的 journal（工具调用/轮次）从未进过办公室。
//
// 本模块只做"地址决策"这一件事，保持纯函数式（无 IO、无时钟）：
//   - 根会话 → root 地址；
//   - 已知子会话 + 已知 mode → subagent 地址；
//   - 已知子会话但 mode 未知 → null（**先别开流**，等父侧 journal 的
//     subagent/catalog 把 mode 带出来再开，别拿注定被拒的地址去打运行时）。
//
// 账本有界（cap + FIFO 淘汰）：follow 的目标集合本来就随会话生命周期滚动，
// 这里只跟"最近见到过的子会话"。

const SUBAGENT_MODES = Object.freeze(['continuable', 'one-shot']);

function isSubagentMode(value) {
  return typeof value === 'string' && SUBAGENT_MODES.includes(value);
}

/**
 * @param {{cap?: number}} [options]
 */
function createFollowAddressBook(options = {}) {
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : 64;
  /** childSessionId -> parentSessionId（来自 api-session/added 的 summary） */
  const childParents = new Map();
  /** childSessionId -> { parentSessionId, mode }（来自父侧 journal 的 wiring） */
  const childAddresses = new Map();

  function touch(map, key, value) {
    if (map.has(key)) map.delete(key); // 重新插入 = 刷新 LRU 位置
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  /** 会话列表/新增事件说"这是一个子会话"（origin==='subagent' 或带 parentSessionId）。 */
  function noteChildSession(sessionId, parentSessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    if (typeof parentSessionId !== 'string' || parentSessionId === '') return false;
    if (parentSessionId === sessionId) return false;
    touch(childParents, sessionId, parentSessionId);
    return true;
  }

  /** 父侧 journal 交代了子会话的可寻址身份（parent + mode）。 */
  function noteChildAddress(childSessionId, parentSessionId, mode) {
    if (typeof childSessionId !== 'string' || childSessionId === '') return false;
    if (typeof parentSessionId !== 'string' || parentSessionId === '') return false;
    if (parentSessionId === childSessionId) return false;
    if (!isSubagentMode(mode)) return false; // 不确定的 mode 绝不上地址（会被 subagent/unauthorized 拒）
    touch(childParents, childSessionId, parentSessionId);
    touch(childAddresses, childSessionId, { parentSessionId, mode });
    return true;
  }

  function forget(sessionId) {
    childParents.delete(sessionId);
    childAddresses.delete(sessionId);
  }

  /** 整个账本清空（follow feed 停止时调用；地址只为当次 feed 服务）。 */
  function forgetAll() {
    childParents.clear();
    childAddresses.clear();
  }

  function isKnownChild(sessionId) {
    return childParents.has(sessionId) || childAddresses.has(sessionId);
  }

  /**
   * 该会话的 follow/page 地址。
   * @returns {{kind:'session', sessionId:string} | {kind:'subagent', parentSessionId:string, childSessionId:string, mode:string} | null}
   *          null = 已知子会话但还不可寻址：调用方必须**跳过**它（不是退回根地址）。
   */
  function addressOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    const known = childAddresses.get(sessionId);
    if (known) return { kind: 'subagent', parentSessionId: known.parentSessionId, childSessionId: sessionId, mode: known.mode };
    if (isKnownChild(sessionId)) return null;
    return { kind: 'session', sessionId };
  }

  /** 诊断/测试用：只读快照。 */
  function debugState() {
    return {
      cap,
      children: [...childParents.keys()],
      addressable: [...childAddresses.entries()].map(([childSessionId, value]) => ({ childSessionId, ...value })),
    };
  }

  return { noteChildSession, noteChildAddress, forget, forgetAll, isKnownChild, addressOf, debugState };
}

module.exports = { createFollowAddressBook, isSubagentMode, SUBAGENT_MODES };
