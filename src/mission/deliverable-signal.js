// src/mission/deliverable-signal.js — 消费官方 `deliverables/presented` 事件（S5）。
// 纯函数，零 IO，可离线测试。
//
// 第一性原理：为什么"交付物"需要两个独立信号，而不能只有一个
//
//   我们有两种关于"团队产出了什么"的信息，它们的**可信度完全不同**：
//
//     ① 模型声称（`present` 工具调用）
//        → 官方 `deliverables/presented` 事件：{turn, callId, files:[{path, description}]}
//        → 这是"团队认为这是交付物"。但模型可能宣告一个空文件、一个过时的文件。
//
//     ② 实际变更（官方 workspace/changes）
//        → 通过 /api/changes.summary 读到逐文件增删行
//        → 这是"这次确实动了这些文件"。但"改了"不等于"这是要交付的东西"。
//
//   只信 ① → 模型可以宣告一个它没写过的文件（官方会校验它存在，但不校验内容对不对）
//   只信 ② → 一次调试改了 20 个文件，全都算交付物，噪音淹没真交付
//
//   所以两者**互补**：① 给出"意图"，② 给出"事实"。
//   本次实现的 merge 函数就是这一条：只有同时出现在两边，才能标为"有据可查的交付"。
//   只出现在 ① 的，标"团队声称交付但本次未检出变更"——如实说，不替它圆场。
'use strict';

/** 交付物的证据强度。**没有 `verified`** —— 验不验是人的判断，见 receipt.js。 */
const DELIVERABLE_EVIDENCE = Object.freeze([
  'claimed',   // 只有 present 声明，本次变更里没有这个文件
  'changed',   // 变更里有，但团队没有明确声明为交付物
  'both',      // 声明 + 变更都存在 —— 最可信的一类
]);

/**
 * 从 `deliverables/presented` 事件的 files 里取出规范化路径集合。
 *
 * 为什么按 **basename 之后相对路径的尾部** 匹配而不是全路径：
 * - present 记录的是**绝对路径**（官方注释："records absolute paths"）
 * - workspace/changes 给的是**相对 Session cwd 的路径**
 * 两者格式不同，直接比会全部不匹配。所以取规范化后的尾部做匹配，
 * 但**保留原始路径**供 UI 显示（不丢信息）。
 *
 * @param {Array<{path?:string, description?:string}>} files
 * @returns {Array<{rawPath:string, key:string, description:string|null}>}
 */
function normalizePresentedFiles(files) {
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const rawPath = typeof f.path === 'string' ? f.path : '';
    if (!rawPath) continue;
    out.push({
      rawPath,
      key: pathKey(rawPath),
      description: typeof f.description === 'string' && f.description ? f.description : null,
    });
  }
  return out;
}

/**
 * 把路径规范化为"可比较的键"：去掉前导分隔符、统一斜杠、小写（仅用于匹配）。
 *
 * 注意：**不解析 `..`**。一个带 `..` 的路径本身就可疑，
 * 我们不做归一化去"修正"它（那样会把可疑路径变成合法路径）。
 */
function pathKey(p) {
  if (typeof p !== 'string' || !p) return '';
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/**
 * 合并"团队声明"与"实际变更"，得出每个交付物的证据强度。
 *
 * @param {object} input
 * @param {Array} [input.presented]   normalizePresentedFiles 的结果
 * @param {Array} [input.changed]     workspace/changes summary 的 files
 * @returns {{items: Array, claimedOnly: number, changedOnly: number, both: number}}
 */
function mergeDeliverableEvidence({ presented, changed } = {}) {
  const decls = Array.isArray(presented) ? presented : [];
  const changes = Array.isArray(changed) ? changed : [];

  // 变更侧也建一份 key → 文件（相对路径，官方给的就是相对路径）
  const changedByKey = new Map();
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue;
    const p = typeof c.path === 'string' ? c.path : '';
    if (!p) continue;
    changedByKey.set(pathKey(p), c);
  }

  const items = [];
  const seenChangeKeys = new Set();

  for (const d of decls) {
    // 用"尾部匹配"：present 的绝对路径尾部应当等于 changes 的相对路径
    const match = findTailMatch(d.key, changedByKey);
    if (match) {
      seenChangeKeys.add(match.key);
      items.push({
        rawPath: d.rawPath,
        description: d.description,
        evidence: 'both',
        added: Number.isFinite(match.file.added) ? match.file.added : null,
        deleted: Number.isFinite(match.file.deleted) ? match.file.deleted : null,
      });
    } else {
      items.push({
        rawPath: d.rawPath,
        description: d.description,
        // 团队说交付了，但本次变更里没检出。**不替它圆场**。
        evidence: 'claimed',
        added: null,
        deleted: null,
      });
    }
  }

  // 变更里有、但没被声明为交付物的：不塞进交付物列表，只计数
  // （一次调试改 20 个文件不该全变成交付物）
  let changedOnly = 0;
  for (const key of changedByKey.keys()) {
    if (!seenChangeKeys.has(key)) changedOnly += 1;
  }

  const both = items.filter((i) => i.evidence === 'both').length;
  return {
    items,
    both,
    claimedOnly: items.length - both,
    changedOnly,
  };
}

/**
 * 用"尾部匹配"在变更表里找对应文件。
 *
 * 为什么不是相等：present 给绝对路径 `/Users/x/proj/src/a.js`，
 * changes 给相对路径 `src/a.js`。相等永远失败。
 *
 * 匹配规则（**按段比较，短的一方必须完整贴在长的一方的尾部**）：
 *   声明 x/proj/a.js   vs 变更 a.js       → 匹配（尾部相同）
 *   声明 deep/dir/r.md vs 变更 report.md  → 匹配（尾部相同）
 *   声明 a/b.js        vs 变更 x/b.js     → 匹配（尾部 b.js 相同）
 *
 * 唯一不允许的是**空路径**。早期版本要求变更侧至少两段，理由是"防止裸名误配"；
 * 但实测发现那会把 `present('/abs/proj/a.js')` + `changes('a.js')` 这种
 * 完全正常的场景判成不匹配 —— 一个项目根下的文件在 changes 里本来就是裸名。
 *
 * 误配风险由**后面的多项检查**兜住，而不是靠拒绝短路径：
 * 单段名只在尾段完全相等时匹配，且我们只在"团队明确声明了它"时才建立关联。
 *
 * 若同一份变更路径能匹配到多个声明，取**尾段最长**的那个（更具体优先）。
 */
function findTailMatch(declaredKey, changedByKey) {
  if (!declaredKey) return null;
  // 先试完全相等（两者可能恰好都是相对路径）
  if (changedByKey.has(declaredKey)) {
    return { key: declaredKey, file: changedByKey.get(declaredKey) };
  }
  let best = null;
  let bestLen = 0;
  for (const [key, file] of changedByKey) {
    if (!key) continue;
    if (!endsWithSegments(declaredKey, key) && !endsWithSegments(key, declaredKey)) continue;
    const len = Math.min(declaredKey.split('/').length, key.split('/').length);
    if (len > bestLen) { bestLen = len; best = { key, file }; }
  }
  return best;
}

/** a 的尾部是否等于 b（按路径段比较；两者都非空才可能相等）。 */
function endsWithSegments(a, b) {
  const as = String(a).split('/').filter(Boolean);
  const bs = String(b).split('/').filter(Boolean);
  if (as.length === 0 || bs.length === 0) return false;
  if (bs.length > as.length) return false;
  const tail = as.slice(as.length - bs.length);
  return tail.join('/') === bs.join('/');
}

/**
 * 面向用户的一句话。**不得把 claimed 说成已交付。**
 * @param {object} item
 * @returns {string}
 */
function describeDeliverable(item) {
  if (!item || typeof item !== 'object') return '';
  const name = String(item.rawPath || '').split('/').filter(Boolean).pop() || item.rawPath || '(未命名)';
  if (item.evidence === 'both') {
    const counts = Number.isFinite(item.added) && Number.isFinite(item.deleted)
      ? `（+${item.added} / −${item.deleted}）` : '';
    return `${name}：团队声明交付，且本次确有变更${counts}`;
  }
  if (item.evidence === 'claimed') {
    return `${name}：团队声明交付，但本次变更中没有检出这个文件`;
  }
  return `${name}：本次有变更，但团队未声明为交付物`;
}

module.exports = {
  DELIVERABLE_EVIDENCE,
  normalizePresentedFiles,
  pathKey,
  mergeDeliverableEvidence,
  describeDeliverable,
};
