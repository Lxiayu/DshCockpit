// src/mission/audit-store.js — 干预审计的落盘（S6）。
//
// 第一性原理：审计为什么要**独立文件**，而不是混进 Mission 的 events.jsonl
//
//   直觉做法是"反正都是 append-only，混一起省事"。但这两者语义不同：
//
//     events.jsonl         → Mission 的**状态来源**。每条事件都参与 fold，
//                            决定了 Mission 现在长什么样。
//     intervention audit   → 用户的**操作史**。它不改变 Mission 状态，
//                            只是回答"我刚才做了什么"。
//
//   混在一起的后果：
//     · projection 里要为审计写一堆 no-op 分支（"这类事件不改变状态"）
//     · 审计的保留策略（有界环，丢了就丢了）会污染日志的"永不删除"承诺
//     · 审计的隐私规则更严（连消息正文都不能有），混进去容易被顺手捎带
//
//   所以独立文件：`interventions.jsonl`，与 events.jsonl 并列，互不影响。
//
//   隐私：写入前做**白名单字段**投影。不是黑名单过滤 ——
//   白名单意味着"没在名单上的字段一律不落盘"，
//   将来有人给 entry 加字段也不会意外泄露。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 落盘允许的字段。**白名单**：名单外的一律不写。 */
const PERSISTED_FIELDS = Object.freeze([
  'action', 'reason', 'atMs', 'missionId', 'memberName', 'taskId',
]);

/** 审计文件的相对路径（相对 workspaceDir）。 */
const AUDIT_FILE_REL = path.join('.dsh', 'interventions.jsonl');

/** 落盘上限：超出后只读最近 N 行（文件本身不截断，避免"静默丢历史"的错觉）。 */
const MAX_PERSISTED_ENTRIES = 500;

function auditFilePath(workspaceDir) {
  return path.join(workspaceDir, AUDIT_FILE_REL);
}

/**
 * 把一条审计 entry 投影成**可落盘的形状**。
 *
 * 白名单过滤 + 类型校验。任何不认识/不合法的字段直接丢弃（返回 null 表示这条不能落）。
 *
 * @param {object} entry
 * @returns {object|null}
 */
function projectForDisk(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.action !== 'string' || !entry.action) return null;
  if (!Number.isFinite(entry.atMs)) return null;
  const out = { action: entry.action, atMs: entry.atMs };
  if (typeof entry.reason === 'string' && entry.reason) out.reason = entry.reason;
  if (typeof entry.missionId === 'string' && entry.missionId) out.missionId = entry.missionId;
  if (typeof entry.memberName === 'string' && entry.memberName) out.memberName = entry.memberName;
  if (typeof entry.taskId === 'string' && entry.taskId) out.taskId = entry.taskId;
  // 关键：**不是**从 entry 复制其余字段，而是只构造上面这些。
  // 所以 entry 上任何多余字段（哪怕将来有人加了 message 正文）都不会被写出。
  return out;
}

/**
 * 追加一条审计到磁盘。
 *
 * 永不抛错：审计失败不该让用户的操作失败
 * （用户停了团队，不能因为审计写不进去就报错回滚）。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
function appendAudit(workspaceDir, entry, { log = () => {} } = {}) {
  const projected = projectForDisk(entry);
  if (!projected) return { ok: false, reason: 'entry is not persistable' };
  if (typeof workspaceDir !== 'string' || !workspaceDir) return { ok: false, reason: 'no workspace dir' };
  try {
    const file = auditFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(projected)}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    log(`[mission] audit append failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * 读回最近的审计记录。
 *
 * 损坏行**跳过并计数**，不是整份丢弃 —— 一行坏了不该让整个审计史消失。
 *
 * @returns {{entries:object[], badLines:number, total:number}}
 */
function readAudit(workspaceDir, { limit = 50 } = {}) {
  const empty = { entries: [], badLines: 0, total: 0 };
  if (typeof workspaceDir !== 'string' || !workspaceDir) return empty;
  let raw;
  try { raw = fs.readFileSync(auditFilePath(workspaceDir), 'utf8'); } catch { return empty; }
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = [];
  let badLines = 0;
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { badLines += 1; continue; }
    const projected = projectForDisk(parsed);
    if (!projected) { badLines += 1; continue; }
    entries.push(projected);
  }
  const capped = entries.length > MAX_PERSISTED_ENTRIES
    ? entries.slice(entries.length - MAX_PERSISTED_ENTRIES) : entries;
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, capped.length) : capped.length;
  return { entries: capped.slice(capped.length - n), badLines, total: entries.length };
}

module.exports = {
  PERSISTED_FIELDS,
  MAX_PERSISTED_ENTRIES,
  AUDIT_FILE_REL,
  auditFilePath,
  projectForDisk,
  appendAudit,
  readAudit,
};
