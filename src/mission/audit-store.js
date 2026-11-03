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

/**
 * 审计记录的格式版本。
 *
 * 第一性原理：为什么版本号放在**每条记录**上，而不是文件头
 *
 *   直觉做法是文件第一行写 `{"v":1}` 当文件头。但审计文件有两个特性会毁掉它：
 *     · **轮转**：.1/.2 是整文件改名，文件头跟着走但语义变了
 *     · **追加 + 部分损坏**：某一行坏了，文件头可能正好在坏掉的那段
 *
 *   每行自带 `v` 则永远可用：读到哪一行，就知道那一行是哪个版本。
 *   代价是每条多约 6 字节 —— 对 512KB 上限来说可忽略。
 *
 * 变更规则：
 *   · 加**可选**字段 → 版本不变（旧读者忽略未知字段即可）
 *   · 改字段含义 / 删字段 / 加必填字段 → 版本 +1，并在读取时按版本解释
 */
const AUDIT_FORMAT_VERSION = 1;

/** 落盘允许的字段。**白名单**：名单外的一律不写。 */
const PERSISTED_FIELDS = Object.freeze([
  'action', 'reason', 'atMs', 'missionId', 'memberName', 'taskId',
]);

/** 审计文件的相对路径（相对 workspaceDir）。 */
const AUDIT_FILE_REL = path.join('.dsh', 'interventions.jsonl');

/** 读时上限：最多返回最近 N 条（这是**视图**上限，不是文件上限）。 */
const MAX_PERSISTED_ENTRIES = 500;

/**
 * 轮转阈值：单个文件超过这个大小就轮转。
 *
 * 为什么按**字节**而不是按条数：
 *   条数需要每次写都数行（O(n)），而审计是"用户点一下就要立刻落盘"的路径，
 *   不该在写的时候做全文件扫描。文件大小是 O(1) 就能拿到的。
 *
 * 512KB ≈ 数千条记录（每条约 100-150 字节）。对"我刚才做了什么"这个用途，
 * 这个跨度足够长；再老的历史价值递减，而磁盘占用会一直涨。
 */
const MAX_FILE_BYTES = 512 * 1024;

/** 保留几份历史（.1 / .2）。审计主要是查最近，两份足够回溯到上一轮工作。 */
const ROTATION_KEEP = 2;

/** 轮转后的备份路径：audit.jsonl -> audit.jsonl.1 -> audit.jsonl.2 */
function rotatedPath(file, index) {
  return index === 1 ? `${file}.1` : `${file}.${index}`;
}

/**
 * 按大小轮转审计文件。
 *
 * 为什么轮转而不是截断：
 *   截断会**删掉**最老的记录，而轮转把它们挪到 .1。
 *   用户翻上一轮工作留下的审计时还能找回来。
 *   代价是磁盘上最多保留 (ROTATION_KEEP + 1) 份 —— 有界。
 *
 * 为什么失败不影响写入：轮转是维护动作，不该让用户的操作失败。
 */
function rotateIfNeeded(file, { log = () => {}, maxBytes = MAX_FILE_BYTES } = {}) {
  try {
    if (!fs.existsSync(file)) return { rotated: false };
    const size = fs.statSync(file).size;
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : MAX_FILE_BYTES;
    if (size < limit) return { rotated: false };
    // 从最老的开始往后挪：.2 -> .3（覆盖）...，.1 -> .2，current -> .1
    //
    // 注意：这里**不需要**先删最老的备份。`fs.renameSync` 会覆盖已存在的目标
    // （实测量过），所以最后一次 rename 天然把最老的挤掉。
    //
    // 早期版本在这里写了一行 rmSync 删 .2 —— 变异测试证明它永远不影响结果
    // （删不删，备份数都是 2）。那种"看起来在保护"的冗余代码更危险：
    // 它让人以为有边界检查，实际真正起作用的是别处。
    for (let i = ROTATION_KEEP - 1; i >= 1; i -= 1) {
      const from = rotatedPath(file, i);
      const to = rotatedPath(file, i + 1);
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch { /* */ }
      }
    }
    try { fs.renameSync(file, rotatedPath(file, 1)); } catch { /* */ }
    return { rotated: true, size };
  } catch (err) {
    log(`[mission] audit rotate failed: ${err.message}`);
    return { rotated: false, reason: err.message };
  }
}

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
  const out = { v: AUDIT_FORMAT_VERSION, action: entry.action, atMs: entry.atMs };
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
function appendAudit(workspaceDir, entry, { log = () => {}, maxBytes } = {}) {
  const projected = projectForDisk(entry);
  if (!projected) return { ok: false, reason: 'entry is not persistable' };
  if (typeof workspaceDir !== 'string' || !workspaceDir) return { ok: false, reason: 'no workspace dir' };
  try {
    const file = auditFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 写入前先检查要不要轮转（按字节，O(1)）
    rotateIfNeeded(file, { log, maxBytes });
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
  const empty = { entries: [], badLines: 0, total: 0, newerVersions: 0 };
  if (typeof workspaceDir !== 'string' || !workspaceDir) return empty;
  let raw;
  try { raw = fs.readFileSync(auditFilePath(workspaceDir), 'utf8'); } catch { return empty; }
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries = [];
  let badLines = 0;
  let newerVersions = 0;
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { badLines += 1; continue; }
    // 版本识别：不认识**更新**的版本时要计数，而不是当垃圾丢掉。
    // 那意味着"用户装过更高版本的 app，或者降级了" —— 这是需要让人知道的事实。
    const v = Number.isFinite(parsed && parsed.v) ? parsed.v : AUDIT_FORMAT_VERSION;
    if (v > AUDIT_FORMAT_VERSION) { newerVersions += 1; continue; }
    const projected = projectForDisk(parsed);
    if (!projected) { badLines += 1; continue; }
    entries.push(projected);
  }
  const capped = entries.length > MAX_PERSISTED_ENTRIES
    ? entries.slice(entries.length - MAX_PERSISTED_ENTRIES) : entries;
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, capped.length) : capped.length;
  return {
    entries: capped.slice(capped.length - n),
    badLines,
    total: entries.length,
    newerVersions,
  };
}

module.exports = {
  PERSISTED_FIELDS,
  AUDIT_FORMAT_VERSION,
  MAX_PERSISTED_ENTRIES,
  MAX_FILE_BYTES,
  ROTATION_KEEP,
  rotateIfNeeded,
  AUDIT_FILE_REL,
  auditFilePath,
  projectForDisk,
  appendAudit,
  readAudit,
};
