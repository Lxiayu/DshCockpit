// src/office/office-desk-nav.js — 白板 → Mission Desk 的导航通道（2026-11-01）。
//
// 第一性原理：为什么办公室需要一个"非读"通道
//
//   铁律 5 说"办公室不是输入面"，意思是**不允许从办公室写状态**。
//   但"打开一个窗口"不是写状态——它和用户点菜单项等价。
//
//   而白板需要它：用户在办公室看到"某个 Mission 有 3 个未决问题"，
//   下一步动作必然是"去 Desk 看细节"。没有这个出口，白板就是死路。
//
// 第二性原理：为什么单独成模块，而不是塞在 office-module.js 里
//
//   office-module.js 有 4800 行硬上限（composition root 不该变巨石）。
//   这个功能是**窗口导航**，与办公室状态机无关，抽出来职责更单一。
//   同时也让"它不碰状态"这件事在文件边界上一目了然——
//   这个模块不 require 任何 store / reducer / projection。
'use strict';

/** 通道名（office:* 冻结集合的一员，见 test/ipc-contract.test.js）。 */
const OPEN_DESK_CHANNEL = 'office:open-desk';

/**
 * 处理一次 open-desk 请求。
 *
 * @param {object} deps
 * @param {string[]} deps.keys        payload 的键（必须为空）
 * @param {Function|null} deps.openDeskWindow  注入的窗口打开函数
 * @returns {{ok:boolean, code?:string, value?:object}}
 */
function handleOpenDesk({ keys, openDeskWindow }) {
  // 空 payload：这个通道不接受任何参数，避免它变成"什么都往里塞"的口子
  if (!Array.isArray(keys) || keys.length !== 0) {
    return { ok: false, code: 'PAYLOAD_INVALID' };
  }
  if (typeof openDeskWindow !== 'function') {
    // 如实降级：窗口管理器没接上就说不可用，不假装成功
    return { ok: false, code: 'DESK_UNAVAILABLE' };
  }
  try {
    openDeskWindow();
    return { ok: true, value: { opened: true } };
  } catch {
    return { ok: false, code: 'DESK_OPEN_FAILED' };
  }
}

module.exports = { OPEN_DESK_CHANNEL, handleOpenDesk };
