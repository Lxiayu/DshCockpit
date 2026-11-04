// src/mission/grant.js — Grant 持久授权记录（D10）。
// 纯逻辑 + 零 IO，可离线测试。
//
// 第一性原理：为什么需要 Grant 而不是"直接填个目录"
//
//   直觉做法：派发面板里放一个路径输入框，用户填 /Users/x/foo 就派过去。
//   这有三个致命问题：
//     ① 用户每次派发都要重新想"该派到哪"，而答案通常不变
//     ② 一次填错 = 团队在错误目录里写文件，而且**没有记录**说明是谁允许的
//     ③ 无法回答"这个团队现在被授权访问哪些目录"——而这个问题的答案
//        恰恰是用户敢不敢离开屏幕的前提
//
//   Grant 把"授权"从一次性的输入变成一个**有记录、可撤销、可审计的对象**：
//     一条 Grant = 一个工作区目录 + 读/写权限 + 授予人 + 时间 + 撤销标记。
//
//   派发不直接选目录，只能选一条**有效**的 Grant。这样：
//     · 用户只在"我要扩大授权范围"时才需要思考目录
//     · 每次派发都有据可查（哪个 Grant 被用了）
//     · 撤销之后，后续派发立即被拒绝
//
// 与官方权限的关系（D10 最后一条，**本轮实测已确认**）：
//   Grant 是我们的**产品层**授权记录，不替代 Harness 的权限预设。
//   S0 第四轮实测结论：官方权限**能读不能写**（无 remote 写表面）。
//   所以 Grant 决定"我们允许派发到哪里"，Harness 决定"会话实际能做什么"。
//   两者都生效才算授权成立 —— 而后者我们只能**显示**，不能设定。
'use strict';

/** Grant ID 格式，与 schema 的 contract.grantId 约束一致。 */
const GRANT_ID_RE = /^gr-[A-Za-z0-9][A-Za-z0-9-]*$/;

/** 权限档。**只有两档**：读、读写。
 *
 *  为什么不做第三档"完全权限"：D10 明确规定
 *  "完全权限不是 Grant 的一个取值，而是一个单独的全局模式"。
 *  把它塞进 Grant 会让"我授权你在这个目录读"和"我授权你控制整台机器"
 *  变成同一个旋钮上的两个档位 —— 那会让人误以为它们是同一类事。
 */
const GRANT_ACCESS = Object.freeze(['read', 'write']);

/** 授予人。**只能是用户** —— Lead、成员、Mission 都不能创建或提升 Grant。 */
const GRANT_GRANTORS = Object.freeze(['user']);

/** 撤销原因（闭集）。不记自由文本：撤销是安全动作，不该携带用户内容。 */
const GRANT_REVOKE_REASONS = Object.freeze([
  'user-revoked',    // 用户主动撤销
  'workspace-gone',  // 工作区不存在了
  'superseded',      // 被新的 Grant 取代
]);

/**
 * 校验一条 Grant。
 *
 * @param {object} g
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateGrant(g) {
  const errors = [];
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    return { ok: false, errors: ['grant must be an object'] };
  }

  if (typeof g.grantId !== 'string' || !GRANT_ID_RE.test(g.grantId)) {
    errors.push('grantId must look like "gr-<opaque>"');
  }
  if (!GRANT_GRANTORS.includes(g.grantedBy)) {
    errors.push(`grantedBy must be one of ${GRANT_GRANTORS.join('|')} (only the user may grant)`);
  }
  if (!GRANT_ACCESS.includes(g.access)) {
    errors.push(`access must be one of ${GRANT_ACCESS.join('|')}`);
  }
  if (!Number.isFinite(g.createdAtMs) || g.createdAtMs < 0) {
    errors.push('createdAtMs must be a non-negative finite number');
  }

  // 目录：**必须有**，但它是 Grant 的内部字段，不进 Mission 事实链。
  // 为什么 Grant 可以存目录而 Mission 不行：Grant 是"用户自己填的授权边界"，
  // 它本来就是关于目录的记录；Mission 存的是"授权引用"（grantId），
  // 这样 Mission 的事实链不含绝对路径。
  if (typeof g.workspaceDir !== 'string' || !g.workspaceDir) {
    errors.push('workspaceDir is required (the directory this grant authorises)');
  } else if (!g.workspaceDir.startsWith('/') && !/^[a-zA-Z]:/.test(g.workspaceDir)) {
    errors.push('workspaceDir must be an absolute path');
  } else if (g.workspaceDir.split(/[\\/]/).includes('..')) {
    errors.push('workspaceDir must not contain traversal segments');
  }

  // 撤销是单向的：一旦 revokedAtMs 有值，就不可恢复。
  // 为什么不做"恢复"：D10 规定"快照不随撤销复活"，
  // 撤销后要重新授权意味着**新建一条 Grant**，而不是把旧的翻回来。
  if (g.revokedAtMs !== undefined && g.revokedAtMs !== null) {
    if (!Number.isFinite(g.revokedAtMs) || g.revokedAtMs < 0) {
      errors.push('revokedAtMs must be a non-negative finite number when present');
    }
    if (g.revokedAtMs < g.createdAtMs) {
      errors.push('revokedAtMs cannot precede createdAtMs');
    }
    if (g.revokeReason !== undefined && g.revokeReason !== null
      && !GRANT_REVOKE_REASONS.includes(g.revokeReason)) {
      errors.push(`revokeReason must be one of ${GRANT_REVOKE_REASONS.join('|')}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 一条 Grant 现在是否有效。
 *
 * @param {object} g
 * @returns {boolean}
 */
function isGrantActive(g) {
  return validateGrant(g).ok
    && (g.revokedAtMs === undefined || g.revokedAtMs === null);
}

/**
 * 从 Grant 派生派发用的权限快照（D10："固化 Grant ID、单一主目录与权限快照"）。
 *
 * 第一性原理：为什么快照要在**派发那一刻**固化
 *
 *   如果派发只记 grantId，那么 Grant 后来被撤销或改权限时，
 *   已经发出的任务会**追溯性地**改变权限含义 —— 我们无法回答
 *   "当时它被授权做什么"。固化快照让每次派发是一个封闭的历史事实。
 *
 *   注意：快照**不含目录**。目录属于 Grant（可撤销的内部记录），
 *   快照只带 grantId + access。
 *
 * @param {object} g
 * @param {number} atMs
 * @returns {{ok:boolean, snapshot?:object, reason?:string}}
 */
function snapshotForDispatch(g, atMs) {
  if (!isGrantActive(g)) {
    return { ok: false, reason: 'grant is not active (revoked or invalid)' };
  }
  return {
    ok: true,
    snapshot: {
      grantId: g.grantId,
      access: g.access,
      capturedAtMs: Number.isFinite(atMs) ? atMs : Date.now(),
    },
  };
}

/**
 * 判断一次文件访问是否被某条 Grant 允许。
 *
 * 这是 Grant 的**执行面**：它决定"我们允许派发到哪里"。
 * 注意它**不**决定 Harness 实际上能不能做 —— 那由官方权限预设决定，
 * 而官方权限我们只能读不能写（S0 第四轮实测）。
 *
 * @param {object} g
 * @param {'read'|'write'} need
 * @param {string} targetPath
 * @returns {{allowed:boolean, reason:string}}
 */
function checkAccess(g, need, targetPath) {
  if (!isGrantActive(g)) return { allowed: false, reason: 'grant is not active' };
  if (!GRANT_ACCESS.includes(need)) return { allowed: false, reason: 'unknown access need' };
  // 读权限不能做写
  if (need === 'write' && g.access !== 'write') {
    return { allowed: false, reason: 'grant is read-only' };
  }
  if (typeof targetPath !== 'string' || !targetPath) {
    return { allowed: false, reason: 'target path is required' };
  }
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const t = norm(targetPath);
  const base = norm(g.workspaceDir);
  if (t.split('/').includes('..')) return { allowed: false, reason: 'target path must not traverse' };
  // 边界：必须是 base 本身或在 base 之下。
  // 用 base + '/' 比较，否则 /proj-evil 会被判成 /proj 的子目录。
  if (t !== base && !t.startsWith(base + '/')) {
    return { allowed: false, reason: 'target is outside the granted directory' };
  }
  return { allowed: true, reason: 'within the granted directory' };
}

module.exports = {
  GRANT_ID_RE,
  GRANT_ACCESS,
  GRANT_GRANTORS,
  GRANT_REVOKE_REASONS,
  validateGrant,
  isGrantActive,
  snapshotForDispatch,
  checkAccess,
};

// ---------------------------------------------------------------------------
// 持久化（工作区级，独立于 Mission 事实链）
// ---------------------------------------------------------------------------
//
// 第一性原理：为什么 Grant 不存进 Mission 的 events.jsonl
//
//   Grant 是**工作区级**授权，不是某个 Mission 的状态：
//     · 一个 Grant 可以被多个 Mission 使用
//     · 撤销 Grant 时，所有引用它的 Mission 都受影响
//     · 删除某个 Mission 不该让授权失效
//
//   混进 Mission 日志会制造"这条 Grant 属于哪个 Mission"的伪问题，
//   而且 Mission 日志是 append-only 的，撤销语义（需要标记而非删除）
//   会把投影逻辑搞复杂。
//
//   所以独立文件：`<ws>/.dsh/grants.json`，小、可整体重写、易审计。
//   注意它**不是** append-only：Grant 数量很少（几条），整体重写最简单可靠。

const GRANTS_FILE_REL = '.dsh/grants.json';
const MAX_GRANTS = 100;

function grantsFilePath(workspaceDir) {
  return require('node:path').join(workspaceDir, GRANTS_FILE_REL);
}

/**
 * 读 Grant 表。损坏时返回空表并报告（不抛）。
 * @returns {{grants:object[], bad:boolean, reason?:string}}
 */
function loadGrants(workspaceDir) {
  const fs = require('node:fs');
  const empty = { grants: [], bad: false };
  if (typeof workspaceDir !== 'string' || !workspaceDir) return empty;
  let raw;
  try { raw = fs.readFileSync(grantsFilePath(workspaceDir), 'utf8'); } catch { return empty; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    return { grants: [], bad: true, reason: `grants file is not valid JSON: ${err.message}` };
  }
  const list = parsed && Array.isArray(parsed.grants) ? parsed.grants : [];
  // 逐条校验：坏掉的条目丢弃并计数，不让一条坏数据毁掉整张表
  const good = [];
  let dropped = 0;
  for (const g of list) {
    if (validateGrant(g).ok) good.push(g); else dropped += 1;
  }
  return { grants: good, bad: dropped > 0, reason: dropped ? `${dropped} invalid grant(s) dropped` : undefined };
}

/**
 * 写 Grant 表（整体重写）。
 * @returns {{ok:boolean, reason?:string}}
 */
function saveGrants(workspaceDir, grants, { log = () => {} } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
const { ensureSelfIgnore } = require('./workspace-dir');
  if (typeof workspaceDir !== 'string' || !workspaceDir) return { ok: false, reason: 'no workspace dir' };
  if (!Array.isArray(grants)) return { ok: false, reason: 'grants must be an array' };
  if (grants.length > MAX_GRANTS) {
    return { ok: false, reason: `too many grants (${grants.length} > ${MAX_GRANTS})` };
  }
  for (const g of grants) {
    const v = validateGrant(g);
    if (!v.ok) return { ok: false, reason: `invalid grant ${g && g.grantId}: ${v.errors[0]}` };
  }
  try {
    const file = grantsFilePath(workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 顺手让 .dsh/ 在自己的 .gitignore 里自我忽略 —— 否则用户的 git status
    // 会看到一堆我们写入的未跟踪文件（详见 workspace-dir.js 的第一性原理）。
    ensureSelfIgnore(path.join(workspaceDir, '.dsh'));
    // 先写临时文件再改名：避免写到一半崩溃导致整张表损坏。
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, grants }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    log(`[mission] grants save failed: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}

/**
 * 生成一个新的 Grant ID（随机、不可预测）。
 *
 * 为什么不用递增序号：Grant ID 会被写进 Mission 合同并可能出现在 UI 上。
 * 递增序号会泄露"这个工作区一共授权过几次"，而且两个工作区的 ID 会撞。
 */
function newGrantId(random = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 10; i += 1) s += alphabet[Math.floor(random() * alphabet.length)];
  return `gr-${s}`;
}

module.exports.GRANTS_FILE_REL = GRANTS_FILE_REL;
module.exports.MAX_GRANTS = MAX_GRANTS;
module.exports.grantsFilePath = grantsFilePath;
module.exports.loadGrants = loadGrants;
module.exports.saveGrants = saveGrants;
module.exports.newGrantId = newGrantId;
