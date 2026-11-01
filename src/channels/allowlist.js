// src/channels/allowlist.js — inbound sender admission for IM channels.
//
// Pairing mode (default): an EMPTY allowFrom list rejects everyone — unknown
// chat/user ids must be admitted from the desktop first. A non-empty list
// admits exact ids, `prefix*` wildcards, and the `*` catch-all.
//
// 第一性原理：`*` 不是"一个配置值"，而是**安全模式的根本改变**（TD-32）。
//
//   三条准入形态，风险等级完全不同：
//
//   | 形态 | 含义 | 谁的消息能进来 |
//   |---|---|---|
//   | `[]`（空） | 配对模式（默认） | **没有人**。必须先从桌面端配对 |
//   | `['user_1', 'grp_*']` | 白名单 | 只有列表里的人 |
//   | `['*']` | **全开放** | **任何能给这个 bot 发消息的人** |
//
//   第三种的后果不是"方便一点"，而是：任何知道这个 bot 的人都
//   可以用 `runPrompt` 在**用户的工作区**里跑任意 prompt
//   （channel-manager → runHeadless，cwd = 用户 workspace）。
//   这等于把桌面应用的执行能力暴露给 IM 上的陌生人。
//
//   所以 `*` 必须被当作一个**显式的、需要二次确认的**开关，
//   而不是白名单列表里一个碰巧能输入的字符。本模块的职责：
//     1. 仍然支持 `*`（它是真实需求：内部团队的群机器人）
//     2. 但把它与普通条目**区分**出来，让上层能做二次确认
//     3. 提供 `describeRisk()` 让 UI/日志能说清楚"现在是什么模式"
'use strict';

/** 全开放标记。单独常量便于上层引用，避免到处写字符串字面量。 */
const OPEN_MARKER = '*';

/** 白名单条目上限（一个渠道卡片是人手编辑的，100 条足够）。 */
const MAX_ENTRIES = 100;

/**
 * 准入判定。
 *
 * 注意顺序：`*` 的判定放在最后，且**只有它确实存在时**才开放。
 * 这样即使将来有人加了别的通配逻辑，也不会意外变成全开放。
 *
 * @param {string[]} allowFrom per-channel whitelist entries
 * @param {string} senderId the platform user/chat id asking in
 * @returns {boolean}
 */
function isAllowed(allowFrom, senderId) {
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
  const id = String(senderId || '');
  if (!id) return false;
  const entries = allowFrom.map((e) => String(e || '').trim()).filter(Boolean);

  // 精确匹配与前缀通配优先（不依赖 `*` 的存在）
  for (const e of entries) {
    if (e === OPEN_MARKER) continue; // 全开放留到最后单独判定
    if (e === id) return true;
    if (e.endsWith('*') && id.startsWith(e.slice(0, -1))) return true;
  }

  // 全开放：只有显式写了 `*` 才生效
  return entries.includes(OPEN_MARKER);
}

/**
 * 判定一个 allowFrom 列表的风险模式。
 *
 * 上层（设置页 / 日志 / 诊断）用它来：
 *   · 在保存 `*` 时要求二次确认
 *   · 在渠道卡片上显示醒目的"全开放"标记
 *   · 在审计日志里说清楚当时的准入模式
 *
 * @returns {{mode:'pairing'|'allowlist'|'open', open:boolean, entryCount:number}}
 */
function describeRisk(allowFrom) {
  const entries = (Array.isArray(allowFrom) ? allowFrom : [])
    .map((e) => String(e || '').trim()).filter(Boolean);
  if (entries.length === 0) {
    return { mode: 'pairing', open: false, entryCount: 0 };
  }
  if (entries.includes(OPEN_MARKER)) {
    return { mode: 'open', open: true, entryCount: entries.length };
  }
  return { mode: 'allowlist', open: false, entryCount: entries.length };
}

/**
 * 判断这次改动是否在**扩大**准入范围到全开放。
 *
 * 用于"保存前二次确认"：只有真正变成全开放时才需要确认，
 * 其他改动（加白名单条目、改成配对模式）都是收敛或持平，不该打扰用户。
 *
 * @param {string[]} prev 改动前
 * @param {string[]} next 改动后
 * @returns {boolean}
 */
function widensToOpen(prev, next) {
  const before = describeRisk(prev);
  const after = describeRisk(next);
  return !before.open && after.open;
}

/** Normalize a user-edited whitelist (textarea, comma/newline separated). */
function parseAllowFrom(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;\n]+/);
  const out = [];
  for (const e of raw) {
    const v = String(e || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, MAX_ENTRIES);
}

module.exports = {
  OPEN_MARKER,
  MAX_ENTRIES,
  isAllowed,
  describeRisk,
  widensToOpen,
  parseAllowFrom,
};
