// src/mission/deliverable.js — 产物登记与 digest 校验（P1）。
//
// 第一性原理：为什么"产物"需要单独一层，而不是丢进 Mission 的一个数组字段
//
//   Mission 的价值之一是"做完的工作能找回来"。但"找回来"有三个层次：
//     1. 知道有这个东西存在     → 一个 label 就够
//     2. 能找到它               → 需要相对路径（绝对路径是隐私边界且会失效）
//     3. 确认它还是当时那一个   → 需要 digest
//
//   只有 1 的索引是"日记"，只有 1+2 的索引是"书签"，1+2+3 才是**可验证的交付物**。
//   而第 3 点恰恰最容易被省掉——省掉之后，用户下次打开文件发现内容变了，
//   却没有任何东西告诉他"这不是当时确认过的那一版"。
//
//   所以本模块的核心是 digest：
//     · 登记时计算
//     · 校验时重算并比对
//     · 不一致时**明说"内容已变化"**，而不是沉默
//
// 依赖方向（mission-core.md §3.1 硬约束）：
//   **禁止 mission → work**（反向依赖）。所以这里**不复用**
//   src/work/workspace-store.js 的 isSafeRelPath / resolveInside，
//   而是重新实现一份更严格的版本。
//   重复 20 行代码 vs 打破依赖方向——前者是可接受的成本。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 单个产物的大小上限（避免把 GB 级文件读进内存算 digest）。 */
const MAX_HASH_BYTES = 64 * 1024 * 1024; // 64MB

/** digest 算法与截断长度。 */
const DIGEST_ALGO = 'sha256';
const DIGEST_HEX_LEN = 64;

/**
 * 词法相对路径校验（比 src/work 的版本更严格）。
 *
 * 拒绝：绝对路径、空段、`.`、`..`、Windows 盘符、UNC、控制字符。
 * 注意这是**词法**检查，不碰文件系统——所以它不会因为路径不存在而失败，
 * 也就不能替代 resolveInside 的物理检查。
 */
function isSafeRelPath(relPath) {
  if (typeof relPath !== 'string') return false;
  const s = relPath.trim();
  if (s === '') return false;
  if (path.isAbsolute(s)) return false;
  if (/^[A-Za-z]:[\\/]/.test(s)) return false;   // Windows drive
  if (/^\\\\/.test(s)) return false;             // UNC
  // 控制字符（含 NUL）不进路径
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  return s.split(/[\\/]+/).every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * 把相对路径解析到工作区内的绝对路径，并**物理**校验没有逃逸。
 *
 * 与纯词法检查的区别：词法通不过 `a/../b` 这种已经被拒了，但
 * **符号链接**可以绕过词法检查。所以这里额外用 realpath 比对。
 */
function resolveInside(rootPath, relPath) {
  if (!isSafeRelPath(relPath)) {
    throw new Error('deliverable path must be a safe workspace-relative string');
  }
  const abs = path.resolve(rootPath, relPath);
  const rel = path.relative(rootPath, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('deliverable path escapes the workspace');
  }
  // 物理校验：如果文件已存在，确认它的 realpath 仍在工作区内（防符号链接逃逸）
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(rootPath);
    const realRel = path.relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith(`..${path.sep}`) || path.isAbsolute(realRel)) {
      throw new Error('deliverable path escapes the workspace via a symbolic link');
    }
  } catch (err) {
    // 文件不存在（ENOENT）是合法的（登记一个还没生成的文件），其它错误上抛
    if (!err || err.code !== 'ENOENT') {
      if (err && /escapes the workspace/.test(err.message)) throw err;
      // realpath 的其它失败（权限等）不阻断登记
    }
  }
  return abs;
}

/** 计算文件 digest（流式，避免大文件占满内存）。 */
function hashFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    return { ok: false, reason: err.code === 'ENOENT' ? 'file does not exist' : err.message };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' };
  if (stat.size > MAX_HASH_BYTES) {
    return { ok: false, reason: `file too large to hash (${stat.size} > ${MAX_HASH_BYTES})` };
  }
  const buf = fs.readFileSync(absPath);
  return {
    ok: true,
    digest: crypto.createHash(DIGEST_ALGO).update(buf).digest('hex'),
    bytes: stat.size,
  };
}

/** 计算内存内容的 digest（测试/小内容用）。 */
function hashContent(content) {
  return crypto.createHash(DIGEST_ALGO).update(content, 'utf8').digest('hex');
}

/**
 * 登记一个产物。
 *
 * @returns {{ok:true, deliverable:object} | {ok:false, reason:string}}
 */
function registerDeliverable({ workspaceDir, missionId, label, relPath, now = Date.now(), extra = {} }) {
  if (!workspaceDir) return { ok: false, reason: 'workspaceDir is required' };
  if (!missionId) return { ok: false, reason: 'missionId is required' };
  if (!label || typeof label !== 'string') return { ok: false, reason: 'label is required' };
  if (!isSafeRelPath(relPath)) {
    return { ok: false, reason: 'relPath must be a safe workspace-relative path (no absolute paths, no "..")' };
  }

  let abs;
  try {
    abs = resolveInside(workspaceDir, relPath);
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const hashed = hashFile(abs);
  if (!hashed.ok) {
    // 允许登记"尚未生成"的文件吗？——不允许。
    // 产物索引的价值在于"能验证当时那一个"，没有内容就没有 digest，
    // 也就无法验证。登记一个 hash 不出来的文件等于制造虚假的确定性。
    return { ok: false, reason: `cannot hash deliverable: ${hashed.reason}` };
  }

  return {
    ok: true,
    deliverable: {
      deliverableId: extra.deliverableId || `dlv-${crypto.randomBytes(8).toString('hex')}`,
      missionId,
      label,
      relPath,
      digest: hashed.digest,
      bytes: hashed.bytes,
      registeredAtMs: now,
      ...extra,
    },
  };
}

/**
 * 校验一个已登记的产物是否仍然与登记时一致。
 *
 * 三种结果必须分开：
 *   unchanged → digest 相同
 *   modified  → 文件还在但内容变了（**最常见的真实情况**）
 *   missing   → 文件不在了
 *
 * 把它们合并成 ok/not-ok 会让用户无法判断"该重新确认还是该找回文件"。
 */
function verifyDeliverable({ workspaceDir, deliverable }) {
  if (!deliverable || !deliverable.relPath || !deliverable.digest) {
    return { status: 'invalid', reason: 'deliverable is missing relPath or digest' };
  }
  if (!isSafeRelPath(deliverable.relPath)) {
    return { status: 'invalid', reason: 'stored relPath is no longer a safe path' };
  }
  let abs;
  try {
    abs = resolveInside(workspaceDir, deliverable.relPath);
  } catch (err) {
    return { status: 'invalid', reason: err.message };
  }
  const hashed = hashFile(abs);
  if (!hashed.ok) {
    if (/does not exist/.test(hashed.reason)) {
      return { status: 'missing', reason: `file not found: ${deliverable.relPath}` };
    }
    return { status: 'unreadable', reason: hashed.reason };
  }
  if (hashed.digest === deliverable.digest) {
    return { status: 'unchanged', digest: hashed.digest, bytes: hashed.bytes };
  }
  return {
    status: 'modified',
    reason: 'content changed since registration',
    expected: deliverable.digest,
    actual: hashed.digest,
    bytes: hashed.bytes,
  };
}

/** 批量校验（一个 Mission 的所有产物）。 */
function verifyAll({ workspaceDir, deliverables }) {
  const results = (Array.isArray(deliverables) ? deliverables : []).map((d) => ({
    deliverableId: d.deliverableId,
    label: d.label,
    relPath: d.relPath,
    ...verifyDeliverable({ workspaceDir, deliverable: d }),
  }));
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  return {
    results,
    counts,
    // 只有全部 unchanged 才算健康。modified/missing 都必须让调用方看见。
    healthy: results.length === 0 || results.every((r) => r.status === 'unchanged'),
  };
}

module.exports = {
  MAX_HASH_BYTES,
  DIGEST_ALGO,
  DIGEST_HEX_LEN,
  isSafeRelPath,
  resolveInside,
  hashFile,
  hashContent,
  registerDeliverable,
  verifyDeliverable,
  verifyAll,
};
