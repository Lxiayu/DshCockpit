'use strict';

// scripts/compat-policy.js — 兼容性账本的共享策略内核（单一时钟/阈值/结论来源）。
//
// 为什么要单独一个模块：
//   账本"信息链断裂"（Issue #21）的根因是**同一个判断散落在多处**：
//     - scripts/upstream-compat-report.js 写 latestVerified（只看 ok）
//     - src/compat-status.js 读并决定 compatible（只看版本相等）
//     - badge.json 由报告单独渲染（又一套逻辑）
//   三处各自演化 → 账本说"0.1.5 已验证"，CI 实际验证的是 0.2.1，UI 却显示"已是最新"。
//   本模块把「通道判定 / 陈旧阈值 / 四级结论 / verdict 派生」收敛为唯一的纯函数集合，
//   写端（report）与读端（compat-status）都从这里取，不允许各自实现。
//
// 设计约束（用户 2026-11-01 决策）：
//   1. 不采用统一 7 天过期：prerelease 7 天 / stable 30 天。
//   2. Verified 与 Fresh 是两个独立概念；**历史验证成功不得因时间流逝被改写成失败**。
//   3. 四级结论 Installed / Healthy / Compatible / Supported 不可互相推导，
//      verdict 取**最低级**，unknown / not-run 绝不当作 pass。
//
// 纯函数、零 IO、零依赖（不 require semver，避免 CI 早期依赖缺失）——可被 smoke、
// report、app 三方共用，也可被测试直接驱动。

const DAY_MS = 86400000;

/** 四级结论（有序：低 → 高）。未知与未跑必须与"通过"区分开。 */
const LEVELS = Object.freeze([
  'failed',     // 明确失败（比 unknown 更强的负信号）
  'unknown',    // 没验证过 / 无法判定
  'not-run',    // 明确没跑（与 unknown 语义不同：不是缺失而是决定不跑）
  'installed',  // 装上了
  'healthy',    // 能起来并服务
  'compatible', // 协议行为一致
  'supported',  // 我们承诺支持（人工签名）
]);

/** 只有这两个才算"通过"一级。unknown / not-run 永远不算。 */
const PASSING_LEVELS = Object.freeze(['installed', 'healthy', 'compatible', 'supported']);

/** 单门禁结果 → 等级。`ok===true` 才升级；其余一律回到 unknown/not-run/failed。 */
function levelOfGate(gate) {
  if (!gate || typeof gate !== 'object') return 'unknown';
  if (gate.result === 'not-run') return 'not-run';
  if (gate.result === 'unknown') return 'unknown';
  if (gate.ok === true || gate.result === 'pass') return 'pass';
  if (gate.ok === false || gate.result === 'fail') return 'failed';
  return 'unknown';
}

/**
 * 把一个平台条目合成 verdict —— **逐级递进**，不是"所有 gate 取最小值"。
 *
 * 为什么不能用最小值：如果按最小值，`protocol` 永远是 `unknown`（CI 不跑协议），
 * verdict 就永远停在 unknown，CI 连 healthy 都拿不到 —— 这会让整个账本失去意义。
 *
 * 正确语义是**"实际达到了哪一级"**：
 *   install 过        → installed
 *   + healthCheck 过  → healthy
 *   + protocol 过     → compatible
 *   + endToEnd 过     → compatible（证据更强但级别同名）
 *   + teamIntegration → supported（需人工签名，不由 CI 自动给出）
 *
 * 任一**必需**门禁明确 `fail` → 立刻停在 failed（负信号优先）。
 * `unknown`/`not-run` **不降级**，只是"不能再往上走"。
 */
function verdictFor(platformEntry) {
  if (!platformEntry || typeof platformEntry !== 'object') return 'unknown';

  const g = (name) => levelOfGate(platformEntry[name]);

  // 负信号优先：任何门禁明确失败 → 整条 failed
  for (const name of ['install', 'healthCheck', 'protocol', 'endToEnd', 'teamIntegration']) {
    if (g(name) === 'failed') return 'failed';
  }

  // 逐级递进
  if (g('install') !== 'pass') {
    // 连装都没过：区分"没跑"与"不知道"
    return g('install') === 'not-run' ? 'not-run' : 'unknown';
  }
  let level = 'installed';
  if (g('healthCheck') !== 'pass') return level;
  level = 'healthy';
  if (g('protocol') !== 'pass') return level;
  level = 'compatible';
  if (g('endToEnd') !== 'pass') return level;
  if (g('teamIntegration') !== 'pass') return level;
  // 到这一级需要人工签名，CI 不能自动声称 supported
  return 'supported';
}

/** verdict 是否是"至少到某一级"。用于 Supported 判定与旧账本兼容。 */
function atLeast(verdict, level) {
  const idx = LEVELS.indexOf(verdict);
  const need = LEVELS.indexOf(level);
  if (idx < 0 || need < 0) return false;
  return idx >= need;
}

/** 版本是否 prerelease（alpha/beta/rc 等）。用于选择陈旧阈值。 */
function isPrerelease(version) {
  return /-[0-9A-Za-z.-]+$/.test(String(version || ''));
}

/** 默认通道分级（可被账本 policy 覆盖）。 */
const DEFAULT_POLICY = Object.freeze({
  freshness: {
    prerelease: { staleAfterDays: 7 },
    stable: { staleAfterDays: 30 },
  },
  revalidateOn: [
    'runtime-major-minor-change',
    'adapter-contract-change',
    'lockfile-change',
    'test-matrix-change',
  ],
});

/**
 * 该版本的陈旧阈值（天）。
 * @param {string} version 被验证的 runtime 版本
 * @param {object} [policy] 账本 policy（缺省用 DEFAULT_POLICY）
 */
function staleThresholdDays(version, policy) {
  const p = (policy && policy.freshness) || DEFAULT_POLICY.freshness;
  const band = isPrerelease(version) ? p.prerelease : p.stable;
  const n = Number(band && band.staleAfterDays);
  if (Number.isFinite(n) && n > 0) return n;
  return isPrerelease(version) ? 7 : 30;
}

/** 解析 updatedAt → ms；无法解析返回 NaN（调用方必须把它当作"未知"而非 0）。 */
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 计算账本条目的 freshness —— **不修改任何"验证成功"的事实**。
 *
 * 返回：
 *   verified  布尔 —— 该版本是否有过通过记录（事实，**永不因时间变成 false**）
 *   fresh     布尔 —— 该结论现在是否足够新（会随时间变 false）
 *   stale     === !fresh（向后兼容旧字段名）
 *   ageDays   数字  —— 无法解析时为 Infinity
 */
function evaluateFreshness({ version, verifiedAt, policy, nowMs = Date.now() }) {
  const threshold = staleThresholdDays(version, policy);
  const at = parseTime(verifiedAt);
  const ageMs = Number.isFinite(at) ? (nowMs - at) : NaN;
  const ageDays = Number.isFinite(ageMs) ? ageMs / DAY_MS : Infinity;
  const fresh = Number.isFinite(ageDays) && ageDays <= threshold;
  return {
    thresholdDays: threshold,
    ageDays,
    fresh,
    stale: !fresh,
  };
}

/**
 * 读取端核心判断：当前 runtime 相对账本的状态。
 *
 * **关键纪律**：`compatible` 只有在「版本匹配 且 结论新鲜」时才为 true；
 * 但 `verified` 独立存在——账本陈旧时我们说"曾经验证过但需复验"，
 * 而**不是**把它改写成"未验证/失败"。
 */
function evaluateLedger({ currentVersion, ledger, verifiedVersion, policy, nowMs = Date.now() }) {
  const data = ledger && typeof ledger === 'object' ? ledger : {};
  const latestVerified = typeof verifiedVersion === 'string'
    ? verifiedVersion
    : (typeof data.latestVerified === 'string' ? data.latestVerified : '');
  const effectivePolicy = policy || data.policy || DEFAULT_POLICY;

  const verifiedAt = data.verifiedAt || data.updatedAt || '';
  const fr = evaluateFreshness({ version: latestVerified, verifiedAt, policy: effectivePolicy, nowMs });

  const verified = !!latestVerified; // 事实：账本里确实有通过记录
  const versionMatches = !!currentVersion && !!latestVerified && currentVersion === latestVerified;
  const stale = fr.stale;
  const threshold = fr.thresholdDays;

  let reason = '';
  if (!latestVerified) reason = 'compat ledger has no verified version yet';
  else if (!versionMatches) reason = 'active runtime differs from latest verified version';
  else if (stale) {
    reason = `compat ledger is ${Number.isFinite(fr.ageDays) ? Math.floor(fr.ageDays) : '?'} days old `
      + `(threshold ${threshold}d for this channel); re-verification recommended`;
  }

  return {
    latestVerified,
    verifiedAt,
    ageDays: fr.ageDays,
    staleThresholdDays: threshold,
    verified,                                  // 永不因时间变 false
    fresh: fr.fresh,                           // 会随时间变 false
    stale,                                     // = !fresh
    compatible: versionMatches && !stale,      // 只有"匹配且新鲜"才可说"已是最新"
    verifiedButStale: versionMatches && stale, // "曾经验证过，但需复验"
    reason,
  };
}

/** 账本整体是否陈旧（用于 UI 顶部提示，与具体版本无关）。 */
function ledgerFreshness(ledger, nowMs = Date.now()) {
  const data = ledger && typeof ledger === 'object' ? ledger : {};
  const verifiedAt = data.updatedAt || '';
  const at = parseTime(verifiedAt);
  if (!Number.isFinite(at)) return { known: false, ageDays: Infinity, fresh: false };
  // 账本整体用 stable 档（30 天）判断：它是"这份文件多久没更新"，不是版本结论
  const threshold = 30;
  const ageDays = (nowMs - at) / DAY_MS;
  return { known: true, ageDays, thresholdDays: threshold, fresh: ageDays <= threshold };
}

module.exports = {
  DAY_MS,
  LEVELS,
  PASSING_LEVELS,
  DEFAULT_POLICY,
  levelOfGate,
  verdictFor,
  atLeast,
  isPrerelease,
  staleThresholdDays,
  parseTime,
  evaluateFreshness,
  evaluateLedger,
  ledgerFreshness,
};
