// src/mission/task-ref.js — TaskRef 的 harnessRef 派生（P4 S1）。
//
// 第一性原理：为什么 harnessRef 必须派生，不能直接存 sessionId
//
//   TaskRef 要回答"这次会话的 goal 属于哪个 Workstream"。
//   最直接的做法是把 Harness 的 sessionId 原样存进 Mission。
//
//   **但那条路是错的**，两个理由：
//
//   1. 隐私（AGENTS.md §2.4）：raw sessionId 不进 Mission 事实链。
//      Mission 的 events.jsonl 会长期留存在用户工作区里，
//      原样存 sessionId 等于把 Harness 的内部标识泄漏到一个
//      语义上不需要它的地方。
//
//   2. 边界（domain-model §2.3）：Mission 只"引用"执行单元，不"拥有"它。
//      存原始 id 会诱导后续代码去 Harness 反查、甚至缓存状态，
//      而那会制造第二个事实作者。
//
//   所以 harnessRef 是**派生句柄**：`sess-h-<digest>` 形式。
//   性质：
//     · 同输入同输出（幂等）—— 同一 session 同一 turn 得到同一个 ref
//     · 不可反推 —— 哈希前缀，不是加密（不需要，只要能标识）
//     · 有界 —— 定长，不会因为输入变长而膨胀
//
// 第二性原理：为什么要把 turn 也编码进去
//
//   一个 session 里可能发生多次"属于不同工作流"的执行。
//   只 hash sessionId 会让同一会话的所有 TaskRef 撞成一个。
//   所以 ref = hash(sessionId) 前缀 + turn 序号后缀。
'use strict';

const crypto = require('node:crypto');

/** 哈希前缀长度（十六进制字符数）。12 hex = 48 bit，碰撞概率对单用户场景足够低。 */
const REF_DIGEST_CHARS = 12;

/** turn 序号的合法范围（防止溢出成超长字符串）。 */
const MAX_TURN = 999999;

/** ref 的完整形状：sess-h-<12 hex>[:t<N>]。 */
const HARNESS_REF_RE = /^sess-h-[0-9a-f]{12}(?::t\d{1,6})?$/;

/**
 * 从一个 Harness 会话标识派生 harnessRef。
 *
 * @param {object} input
 * @param {string} input.sessionId  Harness 的 sessionId（原始值，只在内存里用）
 * @param {number} [input.turn]     turn 序号（0 基或 1 基由调用方约定，这里不校验语义）
 * @returns {{ok:true, ref:string} | {ok:false, code:string, reason:string}}
 */
function deriveHarnessRef({ sessionId, turn } = {}) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (sid === '') {
    return { ok: false, code: 'SESSION_ID_REQUIRED', reason: 'sessionId is required to derive a harnessRef' };
  }
  if (sid.length > 512) {
    // 防御：异常长的输入不该被接受（也避免哈希前的内存问题）
    return { ok: false, code: 'SESSION_ID_TOO_LONG', reason: 'sessionId is unreasonably long' };
  }
  let digest;
  try {
    digest = crypto.createHash('sha256').update(sid, 'utf8').digest('hex').slice(0, REF_DIGEST_CHARS);
  } catch (error) {
    return { ok: false, code: 'DERIVE_FAILED', reason: `hash failed: ${error && error.message}` };
  }
  let ref = `sess-h-${digest}`;
  if (turn !== undefined && turn !== null) {
    if (!Number.isInteger(turn) || turn < 0 || turn > MAX_TURN) {
      return { ok: false, code: 'TURN_INVALID', reason: `turn must be an integer in 0..${MAX_TURN}` };
    }
    ref += `:t${turn}`;
  }
  return { ok: true, ref };
}

/** 校验一个字符串是否是形状合法的 harnessRef。 */
function isValidHarnessRef(value) {
  return typeof value === 'string' && HARNESS_REF_RE.test(value);
}

/**
 * 构造一个完整的 TaskRef 实体（不落盘，只组装）。
 *
 * 刻意不接受 `status` —— schema 也会拒绝，这里更早挡住，
 * 让调用方立刻知道"任务状态不归 Mission 管"。
 *
 * @returns {{ok:true, taskRef:object} | {ok:false, code:string, reason:string}}
 */
function buildTaskRef({ missionId, workstreamId, taskRefId, sessionId, turn, kind, summary, observedAtMs } = {}) {
  const derived = deriveHarnessRef({ sessionId, turn });
  if (!derived.ok) return derived;

  const KINDS = ['session-turn', 'team-task', 'agent-job'];
  const k = kind === undefined || kind === null ? 'session-turn' : String(kind);
  if (!KINDS.includes(k)) {
    return { ok: false, code: 'KIND_INVALID', reason: `kind must be one of ${KINDS.join('|')}` };
  }

  return {
    ok: true,
    taskRef: {
      taskRefId: taskRefId || `tr-${crypto.randomBytes(6).toString('hex')}`,
      missionId,
      workstreamId,
      // 只存派生句柄，**绝不存 sessionId 原文**
      harnessRef: derived.ref,
      kind: k,
      summary: typeof summary === 'string' ? summary.slice(0, 200) : '',
      ...(Number.isFinite(observedAtMs) ? { observedAtMs } : {}),
    },
  };
}

module.exports = {
  REF_DIGEST_CHARS,
  MAX_TURN,
  HARNESS_REF_RE,
  deriveHarnessRef,
  isValidHarnessRef,
  buildTaskRef,
};
