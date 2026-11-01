'use strict';

// scripts/check-licenses.js — 许可证合规门禁（Issue #14）。
//
// 第一性原理：为什么这个脚本必须存在，以及为什么它检查三个**不同**的东西
//
//   用户的要求是"检查直接依赖、间接依赖和最终实际分发内容"。这三者不是同一件事，
//   把它们混成一个"依赖许可证检查"会漏掉三类真实风险：
//
//     1. 直接依赖（package.json 声明）—— 我们主动选的。
//        风险：有人随手 `npm i <某-AGPL-包>`，review 时只看功能不看 LICENSE。
//
//     2. 间接依赖（lockfile 里的传递依赖）—— 我们没有选它。
//        风险：一个 MIT 的直接依赖可能拖进来一个 AGPL 的传递依赖。
//        只看直接依赖会 100% 漏掉这种情况。
//
//     3. 最终实际分发内容（electron-builder 的 files 白名单 + asar）——
//        前两者都合规不代表打进安装包的东西合规。
//        风险：devDependencies 不进包（好），但 `files: ['src/**/*']` 之外的
//        运行时 require 仍可能把某个包带进 asar；反之，某些包声明在
//        dependencies 里但实际上没被 require（白担风险）。
//
//   第三个检查尤其重要，因为本项目的 DshCockpit 是 **MIT**，而我们要集成的
//   生态里存在 AGPL-3.0-only 的项目（Obelisk）、AGPL 主仓（OpenViking）、
//   以及专有 SDK（Live2D Cubism Core）。这些一旦被打进分发包，MIT 的授权
//   承诺就不再成立。
//
// 判定语义（保守，但不制造噪音）：
//   - 允许：permissive 家族（MIT/Apache-2.0/BSD/ISC/0BSD/Unlicense/CC0…）
//   - 拒绝：copyleft 传染性（AGPL/GPL/LGPL/SSPL/BUSL/EUPL 视情况）
//   - 需人工：NOASSERTION / 缺失 / 自定义（**不静默放过**，要么加例外要么失败）
//
// 例外必须**有依据**：每条例外要写 reason + 谁批准（见 LICENSE_EXCEPTIONS），
// 而不是简单加进 allowlist。这样下一个读到它的人知道为什么能放行。
//
// 用法：
//   node scripts/check-licenses.js                 # 全量三查
//   node scripts/check-licenses.js --json          # 机器可读输出
//   node scripts/check-licenses.js --self-test     # 验证判定逻辑

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 许可证策略
// ---------------------------------------------------------------------------

/** 直接放行：宽松许可，与 MIT 项目兼容。 */
const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'Unlicense', 'CC0-1.0', 'WTFPL', 'BSD-2-Clause',
  'BSD-3-Clause', 'Apache-2.0', 'BlueOak-1.0.0', 'Python-2.0', 'Zlib',
  'BSD-3-Clause-Clear', 'CC-BY-4.0', 'CC-BY-3.0', 'MIT*',
]);

/** 明确拒绝：传染性 copyleft 或商业限制。会直接让门禁失败。 */
const DENIED = new Set([
  'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'SSPL-1.0', 'BUSL-1.1', 'Commons-Clause', 'Elastic-2.0',
  'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-SA-4.0',
]);

/** 需要人工裁定：不自动拒绝，但也不放过。 */
function classify(license) {
  if (!license || typeof license !== 'string' || !license.trim()) return 'unknown';
  const raw = license.trim();
  // SPDX 表达式：取并集语义做保守判定
  //   "MIT OR Apache-2.0" → 可任选，只要有允许项就算 allowed
  //   "MIT AND GPL-3.0"   → 必须同时满足 → 按最严（denied）
  if (/\s+OR\s+/i.test(raw)) {
    const parts = raw.split(/\s+OR\s+/i).map((s) => s.replace(/[()]/g, '').trim());
    if (parts.some((p) => ALLOWED.has(p))) return 'allowed';
    if (parts.every((p) => DENIED.has(p))) return 'denied';
    return 'review';
  }
  if (/\s+AND\s+/i.test(raw)) {
    const parts = raw.split(/\s+AND\s+/i).map((s) => s.replace(/[()]/g, '').trim());
    if (parts.some((p) => DENIED.has(p))) return 'denied';
    if (parts.every((p) => ALLOWED.has(p))) return 'allowed';
    return 'review';
  }
  if (ALLOWED.has(raw)) return 'allowed';
  if (DENIED.has(raw)) return 'denied';
  return 'review';
}

// ---------------------------------------------------------------------------
// 例外清单（必须带依据，不允许无声放行）
// ---------------------------------------------------------------------------

/**
 * 结构：{ '<name>@<version-range-or-*>': { reason, approvedBy, since } }
 * 用途：某些 review 级许可证经确认可接受（例如某包只是构建期工具，
 *       或确有双重授权但我们读到了 Apache-2.0 分支）。
 */
const LICENSE_EXCEPTIONS = {
  // 示例（当前为空集）：
  // 'some-pkg@*': {
  //   reason: 'dual-licensed MIT OR Apache-2.0；上游 LICENSE 文件确认为 Apache-2.0 分支',
  //   approvedBy: 'Lxiayu',
  //   since: '2026-11-01',
  // },
};

function exceptionFor(name, license) {
  for (const key of Object.keys(LICENSE_EXCEPTIONS)) {
    const [exName, exVer] = key.split('@');
    if (exName !== name) continue;
    if (!exVer || exVer === '*' || exVer === license) return LICENSE_EXCEPTIONS[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 直接依赖：package.json 的 dependencies（devDependencies 不进分发包，单列）。 */
function directDependencies(pkg) {
  const out = [];
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    out.push({ name, version: range, kind: 'direct-prod' });
  }
  for (const [name, range] of Object.entries(pkg.devDependencies || {})) {
    out.push({ name, version: range, kind: 'direct-dev' });
  }
  return out;
}

/**
 * 从 lockfile 取**传递**依赖与其许可证。
 * lockfileVersion 3 的 packages map 形如 'node_modules/foo': {version, dev, license}。
 */
function lockfilePackages(lock) {
  const pkgs = (lock && lock.packages) || {};
  const out = [];
  for (const [key, meta] of Object.entries(pkgs)) {
    if (!key) continue; // 根条目
    const name = key.replace(/^.*node_modules\//, '');
    out.push({
      name,
      version: meta.version || '',
      license: meta.license || '',
      dev: !!meta.dev,
      key,
    });
  }
  return out;
}

/**
 * 最终分发内容：electron-builder 的 `files` 白名单决定什么进 asar。
 *
 * 这里不做 asar 解析（那需要真构建），只做两项高价值检查：
 *   a. 生产依赖里有哪些**没有出现在 lockfile 的非 dev 集合**中（声明/实际不符）
 *   b. 哪些生产依赖的许可证是 denied/review —— 这些才是真正要盯的
 * 构建后的 asar 内容核对由 verify-dist 之外的 Issue 跟踪（需真构建）。
 */
function distributionRisks(direct, lockPkgs) {
  const lockByName = new Map();
  for (const p of lockPkgs) {
    if (!lockByName.has(p.name)) lockByName.set(p.name, []);
    lockByName.get(p.name).push(p);
  }
  const issues = [];
  for (const d of direct) {
    if (d.kind !== 'direct-prod') continue;
    const entries = lockByName.get(d.name);
    if (!entries || entries.length === 0) {
      issues.push({ name: d.name, problem: 'declared in dependencies but absent from lockfile' });
      continue;
    }
    const prodEntry = entries.find((e) => !e.dev);
    if (!prodEntry) {
      issues.push({ name: d.name, problem: 'declared as production dependency but lockfile marks it dev-only' });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 主检查
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} [opts.root]
 * @returns {{ok:boolean, gates:object, failures:Array, reviews:Array, warnings:Array}}
 */
function check({ root = ROOT } = {}) {
  const pkg = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  if (!pkg) throw new Error(`cannot read package.json under ${root}`);
  if (!lock) throw new Error(`cannot read package-lock.json under ${root} (required for transitive licence audit)`);

  const failures = [];
  const reviews = [];
  const warnings = [];

  // --- Gate 1: 直接依赖 ---
  const direct = directDependencies(pkg);
  const lockPkgs = lockfilePackages(lock);
  const lockByName = new Map();
  for (const p of lockPkgs) {
    if (!lockByName.has(p.name)) lockByName.set(p.name, []);
    lockByName.get(p.name).push(p);
  }
  for (const d of direct) {
    const entries = lockByName.get(d.name) || [];
    const lic = (entries.find((e) => e.license) || {}).license || '';
    const verdict = classify(lic);
    const ex = exceptionFor(d.name, lic);

    // devDependencies 不进分发包（electron-builder 的 files 白名单只含 src/**），
    // 因此 copyleft 的构建工具不构成分发风险——**但仍然报告**，因为
    // "开发期依赖 AGPL"是需要注意的信号（贡献者的本地义务），只是不阻塞门禁。
    if (d.kind === 'direct-dev') {
      if (verdict === 'denied') {
        warnings.push(`dev ${d.name}: ${lic} —— 开发期依赖，不进分发包，不阻塞门禁；但贡献者本地使用需知晓`);
      } else if (verdict === 'review' || verdict === 'unknown') {
        warnings.push(`dev ${d.name}: ${lic || '(missing)'} —— 开发期依赖，不阻塞门禁`);
      }
      continue;
    }

    if (verdict === 'denied') {
      if (ex) warnings.push(`${d.kind} ${d.name}: ${lic} 已被例外放行（${ex.reason}）`);
      else failures.push({ gate: 'direct', name: d.name, license: lic, severity: 'denied', kind: d.kind });
    } else if (verdict === 'review' || verdict === 'unknown') {
      if (ex) warnings.push(`${d.kind} ${d.name}: ${lic || '(missing)'} 已被例外放行（${ex.reason}）`);
      else reviews.push({ gate: 'direct', name: d.name, license: lic || '(missing)', kind: d.kind });
    }
  }

  // --- Gate 2: 传递依赖（只看进包的生产树）---
  const prodLock = lockPkgs.filter((p) => !p.dev);
  for (const p of prodLock) {
    const verdict = classify(p.license);
    const ex = exceptionFor(p.name, p.license);
    if (verdict === 'denied') {
      if (ex) continue;
      failures.push({ gate: 'transitive', name: p.name, license: p.license, severity: 'denied', version: p.version });
    } else if (verdict === 'review' || verdict === 'unknown') {
      if (ex) continue;
      reviews.push({ gate: 'transitive', name: p.name, license: p.license || '(missing)', version: p.version });
    }
  }

  // --- Gate 3: 分发内容一致性 ---
  const distIssues = distributionRisks(direct, lockPkgs);
  for (const issue of distIssues) {
    warnings.push(`dist: ${issue.name} — ${issue.problem}`);
  }

  // 去重（同一包可能既是直接依赖又被传递扫到）
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      const k = `${x.name}|${x.license}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const uniqFailures = dedupe(failures);
  const uniqReviews = dedupe(reviews);

  return {
    ok: uniqFailures.length === 0 && uniqReviews.length === 0,
    blockedByDenied: uniqFailures.length > 0,
    gates: {
      direct: { count: direct.length, prod: direct.filter((d) => d.kind === 'direct-prod').length },
      transitive: { count: prodLock.length },
      distribution: { issues: distIssues.length },
    },
    failures: uniqFailures,
    reviews: uniqReviews,
    warnings,
  };
}

function printResult(result) {
  console.log(`[licenses] 直接依赖 ${result.gates.direct.count}（生产 ${result.gates.direct.prod}）/ 传递生产依赖 ${result.gates.transitive.count}`);
  if (result.failures.length) {
    console.error('[licenses] ❌ DENIED（传染性/商业限制，必须处理）:');
    for (const f of result.failures) {
      console.error(`  - [${f.gate}] ${f.name}${f.version ? `@${f.version}` : ''} → ${f.license}`);
    }
  }
  if (result.reviews.length) {
    console.error('[licenses] ⚠️ REVIEW（未知/特殊许可证，不允许静默放过）:');
    for (const r of result.reviews) {
      console.error(`  - [${r.gate}] ${r.name}${r.version ? `@${r.version}` : ''} → ${r.license}`);
    }
    console.error('  处理方式：确认合规后在 scripts/check-licenses.js 的 LICENSE_EXCEPTIONS 中');
    console.error('  添加带 reason + approvedBy + since 的条目，而不是静默忽略。');
  }
  for (const w of result.warnings) console.log(`[licenses] note  ${w}`);
  console.log(`[licenses] ${result.ok ? 'PASS' : 'FAIL'} — denied=${result.failures.length} review=${result.reviews.length}`);
}

function selfTest() {
  const assert = require('node:assert');
  // allowed
  assert.strictEqual(classify('MIT'), 'allowed');
  assert.strictEqual(classify('Apache-2.0'), 'allowed');
  assert.strictEqual(classify('BSD-3-Clause'), 'allowed');
  assert.strictEqual(classify('ISC'), 'allowed');
  // denied
  assert.strictEqual(classify('AGPL-3.0-only'), 'denied');
  assert.strictEqual(classify('GPL-3.0'), 'denied');
  assert.strictEqual(classify('SSPL-1.0'), 'denied');
  assert.strictEqual(classify('CC-BY-NC-SA-4.0'), 'denied');
  // review
  assert.strictEqual(classify(''), 'unknown');
  assert.strictEqual(classify('NOASSERTION'), 'review');
  assert.strictEqual(classify('Custom-Proprietary'), 'review');
  // SPDX expressions
  assert.strictEqual(classify('MIT OR Apache-2.0'), 'allowed', 'either-side is fine');
  assert.strictEqual(classify('MIT AND GPL-3.0'), 'denied', 'AND requires satisfying the strict side');
  assert.strictEqual(classify('(MIT OR GPL-3.0)'), 'allowed');
  console.log('[licenses] self-test OK');
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  const asJson = process.argv.includes('--json');
  const root = argValue('--root') || ROOT;
  let result;
  try {
    result = check({ root });
  } catch (err) {
    console.error(`[licenses] ERROR ${err.message}`);
    process.exit(2);
  }
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  // 只有 denied 让门禁失败？不 —— review 也不允许静默放过（用户明确要求）。
  // 但 review 全部来自"我们无法判定"，如果让它失败，CI 会在依赖更新时频繁红。
  // 折中：review 导致失败，但错误信息明确指引如何添加带依据的例外。
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { classify, check, selfTest, ALLOWED, DENIED, LICENSE_EXCEPTIONS };
