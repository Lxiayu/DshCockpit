// scripts/upstream-compat-report.js — aggregate per-platform compat smoke
// results into the repo's public compatibility artifacts (R2):
//   docs/compat/compat-status.json   machine-readable ledger (app + badge read this)
//   docs/compat/badge.json           shields.io endpoint payload (README badge)
//   docs/compat/<date>-<version>.md  human-readable run report (failure summaries included)
//   docs/compat/discussion-body.md   GitHub Discussion announcement template
// The Markdown conclusion is fully generated: a failing gate is annotated
// automatically with its reason, so "smoke failed" reports ship as fast as
// green ones (24h drill requirement).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');
const policy = require('./compat-policy.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'compat');
const MAX_RUNS = 30;

/** Short display form: 0.1.0-rc.8 → rc.8 (badge/report strings stay compact). */
function shortVersion(v) {
  const s = String(v || '');
  if (!semver.valid(s)) return s;
  const pre = semver.prerelease(s);
  return pre && pre.length ? pre.join('.') : s;
}

/** Merge one run into the existing ledger (dedupe by version+date, newest first, capped). */
function mergeRuns(existingRuns, run) {
  const runs = (Array.isArray(existingRuns) ? existingRuns : []).filter(
    (r) => !(r.version === run.version && r.date === run.date)
  );
  runs.unshift(run);
  return runs.slice(0, MAX_RUNS);
}

/** Highest version whose run passed on EVERY reported platform; null if none. */
function pickLatestVerified(runs) {
  const passing = (Array.isArray(runs) ? runs : [])
    .filter((r) => r.ok && r.platforms && Object.keys(r.platforms).length > 0
      && Object.values(r.platforms).every((v) => v === 'pass'))
    .map((r) => r.version)
    .filter((v) => semver.valid(v));
  if (!passing.length) return null;
  passing.sort(semver.rcompare);
  return passing[0];
}

/** shields.io endpoint payload. Failure turns the badge red with a ❌ note. */
function renderBadge(latestRun) {
  if (!latestRun || !latestRun.ok) {
    const v = latestRun && latestRun.version ? shortVersion(latestRun.version) : 'unknown';
    return { schemaVersion: 1, label: 'upstream', message: `❌ ${v} failed`, color: 'red' };
  }
  return { schemaVersion: 1, label: 'upstream', message: `✅ ${shortVersion(latestRun.version)} verified`, color: 'brightgreen' };
}

/** Human-readable Markdown report for a single verification run. */
function renderMarkdown(run) {
  const lines = [];
  lines.push(`# 上游兼容性快报 · ${run.version}`);
  lines.push('');
  lines.push(`- 日期：${run.date}`);
  lines.push(`- 结论：**${run.ok ? `✅ ${run.version} 验证通过` : `❌ ${run.version} 冒烟未通过`}**`);
  lines.push(`- 触发方式：${run.trigger || 'manual'}`);
  lines.push('');
  lines.push('| 平台 | install | dump-config | health-check | 结论 |');
  lines.push('|---|---|---|---|---|');
  for (const [platform, gates] of Object.entries(run.detail || {})) {
    const mark = (g) => (g && g.ok ? '✅' : '❌');
    const pass = gates.install.ok && gates.dumpConfig.ok && gates.healthCheck.ok;
    lines.push(`| ${platform} | ${mark(gates.install)} | ${mark(gates.dumpConfig)} | ${mark(gates.healthCheck)} | ${pass ? 'pass' : '**fail**'} |`);
  }
  const failures = [];
  for (const [platform, gates] of Object.entries(run.detail || {})) {
    for (const [gate, g] of Object.entries(gates)) {
      if (!g.ok) failures.push(`- \`${platform}/${gate}\`：${g.reason || 'failed'}`);
    }
  }
  if (failures.length) {
    lines.push('');
    lines.push('## 失败摘要');
    lines.push('');
    lines.push(...failures);
  } else {
    lines.push('');
    lines.push('全部平台三项门禁（安装 / `--dump-config` 冒烟 / HTTP 健康检查）通过，可安全升级。');
  }
  lines.push('');
  lines.push('> 由 upstream-compat CI 自动生成；徽章与设置页「上游兼容状态」读取同源 JSON。');
  lines.push('');
  return lines.join('\n');
}

/** GitHub Discussion announcement body (template built in, per spec). */
function renderDiscussionBody(run) {
  const head = run.ok
    ? `✅ DshCockpit 已验证 @deepseek-ai/dsh **${run.version}** 兼容（win + mac 双平台冒烟通过），可放心升级。`
    : `⚠️ @deepseek-ai/dsh **${run.version}** 在 DshCockpit 冒烟中未通过，升级前请先阅读失败摘要。`;
  const gateLines = [];
  for (const [platform, gates] of Object.entries(run.detail || {})) {
    const pass = gates.install.ok && gates.dumpConfig.ok && gates.healthCheck.ok;
    gateLines.push(`- ${platform}: ${pass ? '✅ pass' : '❌ fail'}`);
  }
  const failures = [];
  for (const [platform, gates] of Object.entries(run.detail || {})) {
    for (const [gate, g] of Object.entries(gates)) {
      if (!g.ok) failures.push(`- \`${platform}/${gate}\`：${g.reason || 'failed'}`);
    }
  }
  return [
    head,
    '',
    ...gateLines,
    ...(failures.length ? ['', '**失败摘要**', '', ...failures] : []),
    '',
    `完整报告见仓库 docs/compat/${run.date}-${run.version}.md 。`,
  ].join('\n');
}

/** Read every *.json verdict emitted by the smoke job from a directory. */
function loadResults(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { /* missing dir */ }
  const results = [];
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (data && data.schema === 1 && data.version !== undefined) results.push(data);
    } catch { /* skip unreadable artifacts */ }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Ledger schema 2（Issue #21）：把"装得上/起得来/能对话/我们支持"四级分开记录。
//
// 为什么必须是 2：
//   schema 1 只有一个布尔 `ok` + 一个 `latestVerified` 字符串，把四件事压成一件，
//   于是"CI 装上了健康检查过了"会被读成"兼容"，进而被读成"我们支持"。
//   实际发生过的事故：CI 天天验证 0.2.1 全绿，账本却停在 0.1.5，
//   而读取端用 `current === latestVerified` 判断 → 显示"已是最新"。
//
// schema 2 的硬约束：
//   - `latestVerified` 仍保留（向后兼容旧读取端），但语义收窄为"最近一次**全部通过**
//     的版本"；权威结论在 `recommended` + `entries`。
//   - 每条 entry 记录 releaseChannel（通道）与 runtimeVersion（版本）**两个独立维度**。
//   - 未知/未跑的 gate 一律写 unknown/not-run，**绝不**当作 pass。
// ---------------------------------------------------------------------------

const LEDGER_SCHEMA = 2;

/** 读旧账本；缺失/损坏都退回空结构（报告仍能产出，不因账本坏而失败）。 */
function loadLedger(statusFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

/**
 * 把 schema 1 的 runs[] 转成 schema 2 的 entries[]。
 * 关键：旧数据只做过 install/dumpConfig/healthCheck 三 gate，
 * 因此 **只能**证明到 healthy 级——绝不能升格成 compatible。
 */
function migrateRunsToEntries(runs) {
  return (Array.isArray(runs) ? runs : []).map((r) => {
    const platforms = [];
    for (const [platform, gates] of Object.entries(r.detail || {})) {
      const entry = {
        platform,
        install: gates.install ? { result: gates.install.ok ? 'pass' : 'fail', ms: gates.install.ms || 0, reason: gates.install.reason || '' } : { result: 'not-run', reason: 'legacy run has no install gate' },
        healthCheck: gates.healthCheck ? { result: gates.healthCheck.ok ? 'pass' : 'fail', ms: gates.healthCheck.ms || 0, reason: gates.healthCheck.reason || '' } : { result: 'not-run', reason: 'legacy run has no healthCheck gate' },
        // 旧账本从未验证协议行为 —— 明确写 unknown，不写 pass
        protocol: { result: 'unknown', reason: 'legacy CI did not exercise mux/RPC' },
        endToEnd: { result: 'not-run', reason: '' },
        teamIntegration: { result: 'not-run', reason: '' },
      };
      entry.verdict = policy.verdictFor(entry);
      platforms.push(entry);
    }
    return {
      releaseChannel: r.trigger === 'schedule' ? 'next' : 'explicit',
      runtimeVersion: r.version || '',
      resolvedVia: '',
      resolvedAt: r.date ? `${r.date}T00:00:00.000Z` : '',
      platforms,
      verifiedCommit: '',
      verifiedAt: r.date ? `${r.date}T00:00:00.000Z` : '',
      verifiedBy: 'ci:upstream-compat(legacy)',
      runId: '',
      unverified: [
        'mux 连接与 $events 帧形状',
        'session RPC 行为',
        '$events/result 回传',
        'journal 事件词表',
        'Team / Goal / workspace-changes 行为',
      ],
      ok: !!r.ok,
    };
  });
}

/** 从一次 smoke 结果集构建一条 schema 2 entry。 */
function buildEntry({ results, trigger, nowIso }) {
  const first = results[0] || {};
  const platforms = results.map((r) => {
    const g = r.gates || {};
    const entry = {
      platform: r.platform || 'unknown',
      install: g.install ? { result: g.install.ok ? 'pass' : 'fail', ms: g.install.ms || 0, reason: g.install.reason || '' } : { result: 'not-run', reason: 'no install gate' },
      healthCheck: g.healthCheck ? { result: g.healthCheck.ok ? 'pass' : 'fail', ms: g.healthCheck.ms || 0, reason: g.healthCheck.reason || '' } : { result: 'not-run', reason: 'no healthCheck gate' },
      // 这三个 gate 当前 CI **不执行** → 必须如实写 unknown/not-run
      protocol: { result: 'unknown', reason: 'CI does not exercise mux/RPC protocol' },
      endToEnd: { result: 'not-run', reason: '' },
      teamIntegration: { result: 'not-run', reason: '' },
    };
    entry.verdict = policy.verdictFor(entry);
    return entry;
  });
  const allHealthy = platforms.length > 0 && platforms.every((p) => policy.atLeast(p.verdict, 'healthy'));
  return {
    releaseChannel: String(first.resolveTag || (trigger === 'schedule' ? 'next' : 'explicit')),
    runtimeVersion: String(first.version || ''),
    resolvedVia: String(first.resolvedVia || ''),
    resolvedAt: first.startedAt || nowIso,
    platforms,
    verifiedCommit: String(process.env.GITHUB_SHA || '').slice(0, 7),
    verifiedAt: first.finishedAt || nowIso,
    verifiedBy: 'ci:upstream-compat',
    runId: String(process.env.GITHUB_RUN_ID || ''),
    unverified: [
      'mux 连接与 $events 帧形状（需 POC）',
      'session RPC 行为（需 POC）',
      '$events/result 回传（需 POC）',
      'journal 事件词表（需 POC）',
      'Team / Goal / workspace-changes 行为（需 POC）',
    ],
    ok: allHealthy,
  };
}

/** 只有"每个平台都至少 healthy"的 entry 才能成为 latestVerified 候选。 */
function pickVerifiedEntry(entries) {
  const viable = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.ok && Array.isArray(e.platforms) && e.platforms.length > 0
      && e.platforms.every((p) => policy.atLeast(p.verdict, 'healthy')))
    .filter((e) => semver.valid(e.runtimeVersion));
  if (!viable.length) return null;
  viable.sort((a, b) => semver.rcompare(a.runtimeVersion, b.runtimeVersion));
  return viable[0];
}

/**
 * 构建 schema 2 账本。
 * 保留 schema 1 的 `runs`/`latestVerified` 字段（旧读取端仍可用），
 * 同时写 `entries`/`recommended`/`policy` 作为权威。
 */
function buildLedgerV2({ existing, run, results, trigger, nowMs = Date.now() }) {
  const nowIso = new Date(nowMs).toISOString();
  const prev = existing && typeof existing === 'object' ? existing : {};

  // 既有 entries：优先用 schema2 的 entries，否则从旧 runs 迁移
  const prevEntries = Array.isArray(prev.entries) && prev.entries.length
    ? prev.entries.slice()
    : migrateRunsToEntries(prev.runs);

  const fresh = buildEntry({ results, trigger, nowIso });
  // 去重键：版本 + 平台集合（同版本同平台重跑 → 覆盖，不重复堆积）
  const keyOf = (e) => `${e.runtimeVersion}|${(e.platforms || []).map((p) => p.platform).sort().join(',')}`;
  const freshKey = keyOf(fresh);
  const entries = prevEntries.filter((e) => keyOf(e) !== freshKey);
  entries.unshift(fresh);

  const verified = pickVerifiedEntry(entries);

  // 向后兼容：schema 1 读取端只认 latestVerified + runs
  const runs = Array.isArray(prev.runs) ? mergeRuns(prev.runs, run) : [run];

  const ledger = {
    schema: LEDGER_SCHEMA,
    updatedAt: nowIso,
    // --- schema 1 兼容字段 ---
    latestVerified: verified ? verified.runtimeVersion : null,
    runs,
    // --- schema 2 权威字段 ---
    policy: {
      freshness: {
        prerelease: { staleAfterDays: 7 },
        stable: { staleAfterDays: 30 },
      },
      revalidateOn: policy.DEFAULT_POLICY.revalidateOn.slice(),
    },
    recommended: verified ? {
      version: verified.runtimeVersion,
      channel: verified.releaseChannel,
      // 只有 healthCheck 通过 → healthy；协议层未验证 → 不得声称 compatible
      supportedLevel: (() => {
        const worst = verified.platforms.reduce((acc, p) => (policy.LEVELS.indexOf(p.verdict) < policy.LEVELS.indexOf(acc) ? p.verdict : acc), 'supported');
        return worst;
      })(),
      since: verified.verifiedAt ? String(verified.verifiedAt).slice(0, 10) : '',
    } : null,
    entries,
  };
  return ledger;
}

/** badge 由账本派生（不再单独依赖"最近一次 run"）。 */
function renderBadgeV2(ledger) {
  const rec = ledger && ledger.recommended;
  if (!rec) {
    return { schemaVersion: 2, label: 'upstream', message: '\u274c not verified', color: 'red' };
  }
  const lvl = rec.supportedLevel === 'healthy' ? 'healthy' : (rec.supportedLevel || 'unknown');
  return {
    schemaVersion: 2,
    label: 'upstream',
    message: `\u2705 ${shortVersion(rec.version)} (${lvl})`,
    color: 'brightgreen',
  };
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const inDir = argValue('--in') || path.join(ROOT, '.compat-artifacts');
  const outDir = argValue('--out') || OUT_DIR;
  const trigger = argValue('--trigger') || (process.env.GITHUB_EVENT_NAME === 'schedule' ? 'schedule' : 'manual');
  const results = loadResults(inDir);
  if (!results.length) {
    console.error('[compat-report] no result JSONs found in', inDir);
    process.exit(1);
  }
  const date = new Date().toISOString().slice(0, 10);
  const detail = {};
  for (const r of results) detail[r.platform || 'unknown'] = r.gates;
  const version = results[0].version || argValue('--version') || '';
  const run = {
    schema: 1,
    version,
    date,
    ok: results.length > 0 && results.every((r) => r.ok),
    platforms: Object.fromEntries(results.map((r) => [r.platform || 'unknown', r.ok ? 'pass' : 'fail'])),
    reason: results.map((r) => (r.reason ? `${r.platform}: ${r.reason}` : '')).filter(Boolean).join('; '),
    trigger,
    detail,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const statusFile = path.join(outDir, 'compat-status.json');
  const existing = loadLedger(statusFile);
  const status = buildLedgerV2({ existing, run, results, trigger });
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'badge.json'), JSON.stringify(renderBadgeV2(status), null, 2) + '\n');
  const mdFile = path.join(outDir, `${date}-${version}.md`);
  fs.writeFileSync(mdFile, renderMarkdown(run));
  fs.writeFileSync(path.join(outDir, 'discussion-body.md'), renderDiscussionBody(run));

  console.log(`[compat-report] run recorded: ${version} ok=${run.ok}`);
  console.log(`[compat-report] latestVerified=${status.latestVerified || '(none)'}`);
  console.log(`[compat-report] wrote ${statusFile}, badge.json, ${path.basename(mdFile)}, discussion-body.md`);
}

if (require.main === module) {
  main().catch((err) => { console.error('[compat-report] FAILED:', err); process.exit(1); });
}

module.exports = {
  // schema 1 兼容导出（既有测试依赖）
  mergeRuns, pickLatestVerified, renderBadge, renderMarkdown, renderDiscussionBody, loadResults, shortVersion,
  // schema 2（Issue #21）
  LEDGER_SCHEMA, loadLedger, migrateRunsToEntries, buildEntry, buildLedgerV2, pickVerifiedEntry, renderBadgeV2,
};
