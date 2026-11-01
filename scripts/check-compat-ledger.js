'use strict';

// scripts/check-compat-ledger.js — 兼容性账本一致性检查（Issue #21 的"防复发"门禁）。
//
// 为什么需要这个脚本：
//   PR #7 卡了三个月没人合，账本停在 0.1.5，而 CI 天天验证 0.2.1 全绿。
//   结果：设置页显示"已是最新已验证版本"，实际落后一个大版本。
//   单靠"记得更新账本"不可靠 —— 必须有一个**机械检查**在 CI 与本地都能跑。
//
// 检查内容（任一失败即退出码 1）：
//   1. 账本可解析且 schema 合法（1 或 2）
//   2. schema 2 必需字段齐全（policy / recommended / entries）
//   3. 每条 entry：runtimeVersion 是合法 semver、releaseChannel 非空、
//      platforms 非空、verdict 与各 gate 自洽（不得由 unknown/not-run 推出 pass）
//   4. `latestVerified` 必须与 `recommended.version` 一致（schema 2）
//   5. badge.json 与账本派生结果一致（防止 badge 手写漂移）
//   6. 账本 `updatedAt` 超过阈值时**告警**（不失败 —— 陈旧是 fresh 问题不是错误，
//      但必须让 CI 输出里看得见，避免再次静默陈旧）
//
// 用法：
//   node scripts/check-compat-ledger.js              # 默认检查 docs/compat/
//   node scripts/check-compat-ledger.js --dir <dir>  # 指定目录（测试用）
//   node scripts/check-compat-ledger.js --strict-fresh  # 陈旧也视为失败（可选）

const fs = require('node:fs');
const path = require('node:path');
const policy = require('../src/compat-policy.js');
const semver = require('semver');

const ROOT = path.join(__dirname, '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function has(flag) { return process.argv.includes(flag); }

/** 收集错误与警告，最后统一报告。 */
function createReport() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(msg) { errors.push(msg); },
    warn(msg) { warnings.push(msg); },
    get ok() { return errors.length === 0; },
  };
}

/** 校验单个 platform 条目内部的 verdict 自洽性。 */
function checkPlatformVerdict(entry, entryLabel, rep) {
  const expected = policy.verdictFor(entry);
  if (entry.verdict !== expected) {
    rep.error(`${entryLabel}: verdict "${entry.verdict}" != recomputed "${expected}"（gate 与结论不自洽）`);
  }
  // unknown / not-run 绝不能被写成 passing level
  const gateNames = ['install', 'healthCheck', 'protocol', 'endToEnd', 'teamIntegration'];
  for (const name of gateNames) {
    const gate = entry[name];
    if (!gate) continue;
    const lv = policy.levelOfGate(gate);
    // 若某 gate 是 unknown/not-run，但其后所有 gate 都是 pass，
    // 说明有人把"没验证"当成了"验证通过"——这是我们最想拦住的错误。
    if (lv !== 'pass' && (gate.result === 'pass' || gate.ok === true)) {
      rep.error(`${entryLabel}/${name}: result=${JSON.stringify(gate.result)} 与 ok=${gate.ok} 矛盾`);
    }
  }
  if (policy.atLeast(entry.verdict, 'compatible')) {
    // 声称 compatible 及以上，必须有 protocol 通过
    if (policy.levelOfGate(entry.protocol) !== 'pass') {
      rep.error(`${entryLabel}: verdict="${entry.verdict}" 但 protocol gate 未通过（不得越级声称兼容）`);
    }
  }
  if (entry.verdict === 'supported') {
    if (policy.levelOfGate(entry.teamIntegration) !== 'pass') {
      rep.error(`${entryLabel}: verdict="supported" 但 teamIntegration 未通过`);
    }
  }
}

function checkEntry(entry, idx, rep) {
  const label = `entries[${idx}](${entry && entry.runtimeVersion ? entry.runtimeVersion : '?'})`;
  if (!entry || typeof entry !== 'object') { rep.error(`${label}: 不是对象`); return; }
  if (!semver.valid(entry.runtimeVersion)) {
    rep.error(`${label}: runtimeVersion "${entry.runtimeVersion}" 不是合法 semver`);
  }
  if (!String(entry.releaseChannel || '').trim()) {
    rep.error(`${label}: releaseChannel 为空（通道与版本必须分开记录）`);
  }
  if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
    rep.error(`${label}: platforms 为空（没有平台结果的 entry 不能作为验证证据）`);
  } else {
    entry.platforms.forEach((p, pi) => {
      if (!p || typeof p !== 'object') { rep.error(`${label}/platforms[${pi}]: 不是对象`); return; }
      const plabel = `${label}/${p.platform || `platforms[${pi}]`}`;
      if (!String(p.platform || '').trim()) rep.error(`${plabel}: platform 为空`);
      checkPlatformVerdict(p, plabel, rep);
    });
  }
  if (!String(entry.verifiedBy || '').trim()) {
    rep.error(`${label}: verifiedBy 为空（必须能追溯到 ci: / poc: / human:）`);
  } else if (!/^(ci|poc|human):/.test(entry.verifiedBy)) {
    rep.warn(`${label}: verifiedBy "${entry.verifiedBy}" 未使用 ci:/poc:/human: 前缀`);
  }
  if (!Array.isArray(entry.unverified)) {
    rep.warn(`${label}: unverified 不是数组（建议显式列出未验证项，空数组=声称全验证）`);
  } else if (entry.unverified.length === 0) {
    rep.warn(`${label}: unverified 为空数组 —— 请确认确实已全量验证`);
  }
}

/** 校验 schema 1 账本（旧格式，只做最小检查）。 */
function checkSchema1(ledger, rep) {
  if (!Array.isArray(ledger.runs)) { rep.error('schema 1: runs 不是数组'); return; }
  if (ledger.latestVerified !== null && !semver.valid(ledger.latestVerified)) {
    rep.error(`schema 1: latestVerified "${ledger.latestVerified}" 不是合法 semver`);
  }
  rep.warn('schema 1 账本：缺少 entries/policy/recommended，建议升级到 schema 2（run: node scripts/upstream-compat-report.js 或迁移脚本）');
}

/** 校验 schema 2 账本。 */
function checkSchema2(ledger, rep) {
  if (!ledger.policy || typeof ledger.policy !== 'object') {
    rep.error('schema 2: 缺少 policy');
  } else {
    const f = ledger.policy.freshness;
    if (!f || !f.prerelease || !f.stable) {
      rep.error('schema 2: policy.freshness 必须同时定义 prerelease 与 stable');
    } else {
      const pre = Number(f.prerelease.staleAfterDays);
      const sta = Number(f.stable.staleAfterDays);
      if (!(pre > 0) || !(sta > 0)) rep.error('schema 2: staleAfterDays 必须为正数');
      if (pre >= sta) rep.error(`schema 2: prerelease(${pre}d) 阈值必须小于 stable(${sta}d)`);
    }
  }

  if (!Array.isArray(ledger.entries)) {
    rep.error('schema 2: 缺少 entries 数组');
    return;
  }
  ledger.entries.forEach((e, i) => checkEntry(e, i, rep));

  // latestVerified 必须与 recommended 一致
  const rec = ledger.recommended;
  if (rec === null || rec === undefined) {
    if (ledger.latestVerified) {
      rep.error(`schema 2: recommended 为 null 但 latestVerified="${ledger.latestVerified}"（必须一致）`);
    }
  } else {
    if (!rec.version || !semver.valid(rec.version)) {
      rep.error(`schema 2: recommended.version "${rec.version}" 不是合法 semver`);
    }
    if (ledger.latestVerified !== rec.version) {
      rep.error(`schema 2: latestVerified="${ledger.latestVerified}" != recommended.version="${rec.version}"（读取端会看到不一致的真相）`);
    }
    const match = ledger.entries.find((e) => e.runtimeVersion === rec.version);
    if (!match) {
      rep.error(`schema 2: recommended.version="${rec.version}" 在 entries 中找不到对应记录`);
    } else if (rec.supportedLevel !== undefined) {
      const levels = policy.LEVELS;
      const actual = match.platforms.reduce(
        (acc, p) => (levels.indexOf(p.verdict) < levels.indexOf(acc) ? p.verdict : acc),
        'supported',
      );
      if (rec.supportedLevel !== actual) {
        rep.error(`schema 2: recommended.supportedLevel="${rec.supportedLevel}" 与条目实际最低级 "${actual}" 不符`);
      }
    }
  }
}

/** badge 必须能从账本派生（防止手写漂移）。 */
function checkBadge(ledger, badge, rep) {
  if (!badge || typeof badge !== 'object') { rep.error('badge.json 不可解析'); return; }
  if (ledger.schema === 2) {
    const rec = ledger.recommended;
    if (badge.schemaVersion !== undefined && badge.schemaVersion < 2) {
      rep.warn(`badge.schemaVersion=${badge.schemaVersion}，账本已是 schema 2，建议重新派生`);
    }
    const msg = String(badge.message || '');
    if (rec && rec.version) {
      const short = (() => {
        const pre = semver.prerelease(rec.version);
        return pre && pre.length ? pre.join('.') : rec.version;
      })();
      if (!msg.includes(short)) {
        rep.error(`badge.message="${msg}" 不包含当前 recommended 版本 "${short}"（badge 与账本不一致）`);
      }
    } else if (rec === null && !/not verified/.test(msg)) {
      rep.error(`badge.message="${msg}" 但账本 recommended 为 null`);
    }
  }
}

/**
 * 主检查函数（可被测试直接调用）。
 * @returns {{ok:boolean, errors:string[], warnings:string[], ledger:object|null, freshness:object}}
 */
function check({ dir, nowMs = Date.now(), strictFresh = false } = {}) {
  const target = dir || path.join(ROOT, 'docs', 'compat');
  const rep = createReport();
  const statusFile = path.join(target, 'compat-status.json');
  const badgeFile = path.join(target, 'badge.json');

  let ledger = null;
  try {
    ledger = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch (err) {
    rep.error(`compat-status.json 不可读/不可解析: ${err.message}`);
    return { ok: false, errors: rep.errors, warnings: rep.warnings, ledger: null, freshness: { known: false } };
  }

  const schema = Number(ledger.schema);
  if (schema === 2) checkSchema2(ledger, rep);
  else if (schema === 1) checkSchema1(ledger, rep);
  else rep.error(`未知账本 schema: ${ledger.schema}`);

  // badge 一致性
  let badge = null;
  try { badge = JSON.parse(fs.readFileSync(badgeFile, 'utf8')); } catch { /* 下面报错 */ }
  if (badge) checkBadge(ledger, badge, rep);
  else rep.error('badge.json 缺失或不可解析（徽章必须由账本派生）');

  // 陈旧：告警（默认不失败）
  const fresh = policy.ledgerFreshness(ledger, nowMs);
  if (fresh.known && !fresh.fresh) {
    const msg = `账本已 ${Math.floor(fresh.ageDays)} 天未更新（阈值 ${fresh.thresholdDays}d）—— 结论可能不可靠，请在 CI 中确认自动回写是否仍在工作`;
    if (strictFresh) rep.error(msg); else rep.warn(msg);
  } else if (!fresh.known) {
    rep.warn('账本 updatedAt 无法解析（无法判断新鲜度）');
  }

  return { ok: rep.ok, errors: rep.errors, warnings: rep.warnings, ledger, freshness: fresh };
}

function main() {
  const dir = argValue('--dir');
  const result = check({ dir, strictFresh: has('--strict-fresh') });
  for (const w of result.warnings) console.warn(`[compat-ledger] WARN  ${w}`);
  for (const e of result.errors) console.error(`[compat-ledger] ERROR ${e}`);
  const freshTxt = result.freshness && result.freshness.known
    ? `age=${Math.floor(result.freshness.ageDays)}d threshold=${result.freshness.thresholdDays}d fresh=${result.freshness.fresh}`
    : 'freshness=unknown';
  console.log(`[compat-ledger] ${result.ok ? 'PASS' : 'FAIL'} (${freshTxt}, ${result.errors.length} errors, ${result.warnings.length} warnings)`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { check, checkEntry, checkSchema2, checkBadge };
