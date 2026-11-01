// src/office/office-mission-board.js — 白板快照的白名单投影（P2.3 S3）。
//
// 第一性原理：为什么这层要独立成文件
//
//   office-module.js 有 4800 行硬上限。我第一版把 safeMissionBoard 写进去，
//   结果 4825 行 —— 门禁原话是「超限 = 需要拆分而不是继续堆」。
//
//   而拆分本身是对的：白板的**隐私边界**是一个独立的概念，
//   与 office-module 的组合职责无关。它值得被单独审查、单独测试。
//
// 第二性原理：为什么必须走显式白名单（而不是直接透传）
//
//   这是本项目踩过的真实坑。第一版把 missionBoard 放在快照的 `...rest`
//   里，被 `redactor.redactValue(rest)` 整体脱敏 → 标签变成 [REDACTED:text]。
//
//   原因：privacy-redactor 的 TEXT_KEY_RE 匹配 title/summary/text/content
//   等所有疑似正文的字段名。那是**正确的安全默认**。
//
//   正确的应对不是放宽脱敏器（那会让真正的正文泄漏），而是像 pending 一样
//   走**显式字段白名单**：哪些字段能进快照，由一个可审查的列表决定，
//   而不是"脱敏器恰好放过了什么"。
//
//   这条纪律的可检验形态就是下面的 ALLOWED_* 集合 —— 新增字段必须显式加入。
'use strict';

/** 白板顶层允许进快照的字段。 */
const ALLOWED_BOARD_FIELDS = Object.freeze([
  'available', 'reason', 'observedAtMs', 'stale', 'moreCount', 'missions', 'totals',
]);

/** 单个 Mission 允许进快照的字段。 */
const ALLOWED_MISSION_FIELDS = Object.freeze([
  'missionId', 'label', 'status',
  'workstreamCount', 'activeWorkstreamCount',
  'decisionCount', 'openQuestionCount', 'deliverableCount',
]);

/** 白板最多列出的 Mission 数（与 mission-board.MAX_BOARD_MISSIONS 对齐）。 */
const BOARD_MISSION_LIMIT = 3;

/** 标签的最大字符数（二次截断，防止 provider 传超长值）。 */
const MAX_LABEL_CHARS = 64;

const EMPTY_BOARD = Object.freeze({
  available: false,
  reason: 'not-provided',
  observedAtMs: null,
  stale: true,
  moreCount: 0,
  missions: [],
  totals: { activeMissions: 0, openQuestions: 0, decisions: 0 },
});

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function num(v) { return Number.isFinite(v) ? v : 0; }
function str(v, max) {
  const s = typeof v === 'string' ? v : '';
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * 把一个 provider 返回值投影成可进快照的白板块。
 *
 * 未知字段被**丢弃**（不是保留）—— 这是白名单的定义。
 */
function safeMissionBoard(value) {
  if (!isPlainObject(value)) return { ...EMPTY_BOARD, totals: { ...EMPTY_BOARD.totals } };

  const missions = Array.isArray(value.missions) ? value.missions.slice(0, BOARD_MISSION_LIMIT) : [];
  return {
    available: value.available === true,
    reason: typeof value.reason === 'string' ? value.reason : null,
    observedAtMs: Number.isFinite(value.observedAtMs) ? value.observedAtMs : null,
    stale: value.stale === true,
    moreCount: num(value.moreCount),
    missions: missions.map((m) => {
      const item = isPlainObject(m) ? m : {};
      return {
        missionId: str(item.missionId, 128),
        // label 是**短标签**，不是正文：它来自 mission-board 的截断结果。
        label: str(item.label, MAX_LABEL_CHARS),
        status: str(item.status, 32),
        workstreamCount: num(item.workstreamCount),
        activeWorkstreamCount: num(item.activeWorkstreamCount),
        decisionCount: num(item.decisionCount),
        openQuestionCount: num(item.openQuestionCount),
        deliverableCount: num(item.deliverableCount),
      };
    }),
    totals: isPlainObject(value.totals) ? {
      activeMissions: num(value.totals.activeMissions),
      openQuestions: num(value.totals.openQuestions),
      decisions: num(value.totals.decisions),
    } : { activeMissions: 0, openQuestions: 0, decisions: 0 },
  };
}

module.exports = {
  ALLOWED_BOARD_FIELDS,
  ALLOWED_MISSION_FIELDS,
  BOARD_MISSION_LIMIT,
  MAX_LABEL_CHARS,
  EMPTY_BOARD,
  safeMissionBoard,
};
