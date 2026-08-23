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
  let status = { schema: 1, updatedAt: new Date().toISOString(), latestVerified: null, runs: [] };
  try { status = { ...status, ...JSON.parse(fs.readFileSync(statusFile, 'utf8')) }; } catch { /* first run */ }
  status.runs = mergeRuns(status.runs, run);
  status.latestVerified = pickLatestVerified(status.runs);
  status.updatedAt = new Date().toISOString();
  fs.writeFileSync(statusFile, JSON.stringify(status, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'badge.json'), JSON.stringify(renderBadge(run), null, 2) + '\n');
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

module.exports = { mergeRuns, pickLatestVerified, renderBadge, renderMarkdown, renderDiscussionBody, loadResults, shortVersion };
