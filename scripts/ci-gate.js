'use strict';

// scripts/ci-gate.js — CI 门禁的诚实四态汇总（Issue #10）。
//
// 第一性原理：为什么需要这个脚本，而不是"在 workflow 里跑 npm test"？
//
//   1. `node --test` 的退出码只有 0/1。它**不区分** "skipped" 和 "passed"，
//      也不告诉你有多少 todo。而本仓库恰恰有需要图形会话的 E 类测试
//      （test/office-ui.test.js 的 E5a-R1 真机探针）在 CI 下**显式 skip**。
//      如果只看退出码，一个 skip 掉的探针和一个通过的契约测试是同一件事——
//      这正是用户要求"不能把 Skip 计作 Pass"的原因。
//
//   2. release workflow 曾在 2026-09-26 移除测试门禁，理由是"像素类用例在
//      Windows runner 上挂死 >30min"。那条理由是**真实的**，但它导致的结论
//      （"那就别跑测试了"）是错的——正确结论是"把慢的/E 类的分出去，核心
//      部分仍然拦门"。本脚本的存在就是为了让那个区分变成数据而不是记忆。
//
//   所以本脚本做三件事：
//     a. 解析 TAP，得到真实的 pass / fail / skipped / todo 四态计数；
//     b. 按门禁类型分别报告，并用"是否有 fail"决定退出码（**skip 不失败**）；
//     c. 输出机器可读的 JSON 摘要（供 CI 上传 artifact / 后续比对），
//        并在有人试图把 skip 当 pass 报捷时，把数字摊开在 summary 里。
//
// 用法：
//   node scripts/ci-gate.js --tap-file <path> [--label core] [--out summary.json]
//   node scripts/ci-gate.js --self-test          # 用内联 fixture 验证解析器

const fs = require('node:fs');
const path = require('node:path');

/**
 * 解析 node --test 的 TAP 输出。
 *
 * 只关心测试点行：
 *   ok 12 - name        → 通过
 *   not ok 12 - name    → 失败
 *   ok 12 - name # SKIP → 跳过
 *   ok 12 - name # TODO → todo
 *
 * 注意 `not ok ... # SKIP` 也是可能的（显式 skip 但用 not ok 表达），
 * 按 directive 优先判定，避免把跳过误报成失败。
 */
function parseTap(text) {
  const counts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  const failures = [];
  const skips = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    // 匹配顶层与子测试的测试点行；忽略 "# Subtest:" 注释与缩进诊断块
    const m = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line);
    if (!m) continue;
    const status = m[1] === 'ok' ? 'pass' : 'fail';
    const rest = m[2];
    // TAP directive：# SKIP / # TODO（大小写不敏感，可能在原因文本后）
    //
    // 坑：测试**名字**里可能包含字面量 "# SKIP"（本仓库的解析器测试就是如此），
    // node --test 会把名字中的 `#` 转义成 `\#`。若不排除转义形式，会把一条
    // 正常通过的测试误报成 skipped —— 门禁本身就变成了噪音源。
    // 因此只在**未被转义**的 `#` 上匹配 directive。
    const dir = /(^|[^\\])#\s*(SKIP|TODO)\b/i.exec(rest);
    let name = rest;
    if (dir) {
      // dir[1] 是 `#` 前的那个字符（可能是空字符串），dir[2] 才是 directive 名。
      name = rest.slice(0, dir.index).trim().replace(/-\s*$/, '').trim();
      if (dir[2].toUpperCase() === 'SKIP') {
        counts.skip += 1;
        skips.push(name);
        continue;
      }
      counts.todo += 1;
      continue;
    }
    if (status === 'pass') counts.pass += 1;
    else {
      counts.fail += 1;
      failures.push(name);
    }
  }
  return { ...counts, failures, skips };
}

/**
 * 判定一个门禁是否通过。
 *
 * 规则（用户明确要求）：**Skip 不计作 Pass，但也不导致失败**。
 * 唯一让门禁失败的是 fail > 0。
 * 同时要求至少跑过一些东西（pass > 0），否则"零测试通过"会被当成绿。
 */
function verdictOf({ pass, fail, skip, todo }) {
  const total = pass + fail + skip + todo;
  if (total === 0) return { ok: false, reason: 'no tests were discovered (empty run is not a pass)' };
  if (fail > 0) return { ok: false, reason: `${fail} failing test(s)` };
  if (pass === 0) return { ok: false, reason: 'zero passing tests (all skipped/todo) — not a pass' };
  return { ok: true, reason: '' };
}

/** 生成 markdown 摘要（写进 GITHUB_STEP_SUMMARY，人一眼能看）。 */
function renderSummary(gates) {
  const lines = [];
  lines.push('## CI 门禁结果');
  lines.push('');
  lines.push('| 门禁 | 结果 | Passed | Failed | Skipped | Todo |');
  lines.push('|---|---|---|---|---|---|');
  for (const g of gates) {
    const v = verdictOf(g);
    lines.push(`| ${g.label} | ${v.ok ? '✅ pass' : `❌ fail（${v.reason}）`} | ${g.pass} | ${g.fail} | ${g.skip} | ${g.todo} |`);
  }
  lines.push('');
  const anyFail = gates.some((g) => !verdictOf(g).ok);
  lines.push(anyFail
    ? '**结论：失败。** 失败项必须修复后才能合并。'
    : '**结论：通过。**（注意：Skipped 不计入 Passed；上方数字为准。）');
  const allSkips = gates.flatMap((g) => (g.skips || []).map((s) => `- ${g.label}: ${s}`));
  if (allSkips.length) {
    lines.push('');
    lines.push('<details><summary>被跳过的测试（需人工确认是否合理）</summary>');
    lines.push('');
    lines.push(...allSkips);
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function has(flag) { return process.argv.includes(flag); }

function selfTest() {
  const assert = require('node:assert');
  // 通过 + 跳过 + todo + 失败 四种状态
  const tap = [
    'TAP version 13',
    'ok 1 - a passing test',
    'ok 2 - a skipped test # SKIP needs a display',
    'ok 3 - a todo test # TODO later',
    'not ok 4 - a failing test',
    '  ---',
    "  error: 'boom'",
    '  ...',
    'ok 5 - another pass',
  ].join('\n');
  const r = parseTap(tap);
  assert.strictEqual(r.pass, 2, 'two real passes');
  assert.strictEqual(r.skip, 1, 'skip counted separately, NOT as pass');
  assert.strictEqual(r.todo, 1, 'todo counted separately');
  assert.strictEqual(r.fail, 1, 'one failure');
  assert.deepStrictEqual(r.failures, ['a failing test']);

  // 全跳过必须判失败（"零通过"不是通过）
  const allSkip = parseTap(['ok 1 - x # SKIP', 'ok 2 - y # SKIP'].join('\n'));
  assert.strictEqual(verdictOf(allSkip).ok, false, 'all-skipped must not be a pass');

  // 空运行必须判失败
  assert.strictEqual(verdictOf(parseTap('')).ok, false, 'empty run must not be a pass');

  // 只有跳过+通过 → 通过（skip 不阻塞）
  const mixed = parseTap(['ok 1 - x # SKIP', 'ok 2 - y'].join('\n'));
  assert.strictEqual(verdictOf(mixed).ok, true, 'skip alongside passes is acceptable');
  assert.strictEqual(mixed.pass, 1);
  assert.strictEqual(mixed.skip, 1, 'and the numbers stay honest');

  console.log('[ci-gate] self-test OK');
}

function main() {
  if (has('--self-test')) { selfTest(); return; }

  const tapFile = argValue('--tap-file');
  const label = argValue('--label') || 'core tests';
  const outFile = argValue('--out');

  if (!tapFile) {
    console.error('[ci-gate] --tap-file is required (or use --self-test)');
    process.exit(2);
  }
  let text;
  try { text = fs.readFileSync(tapFile, 'utf8'); }
  catch (err) {
    console.error(`[ci-gate] cannot read TAP file ${tapFile}: ${err.message}`);
    process.exit(2);
  }

  const counts = parseTap(text);
  const gate = { label, ...counts };
  const verdict = verdictOf(counts);

  // 控制台四态报告 —— 明确区分，绝不合并
  console.log(`[ci-gate] ${label}: passed=${counts.pass} failed=${counts.fail} skipped=${counts.skip} todo=${counts.todo}`);
  if (counts.skip > 0) {
    console.log(`[ci-gate] NOTE: ${counts.skip} test(s) were SKIPPED — these are NOT counted as passed:`);
    for (const s of counts.skips.slice(0, 20)) console.log(`  - ${s}`);
    if (counts.skips.length > 20) console.log(`  ... and ${counts.skips.length - 20} more`);
  }
  if (counts.failures.length) {
    console.error('[ci-gate] FAILURES:');
    for (const f of counts.failures.slice(0, 30)) console.error(`  - ${f}`);
  }

  const summary = renderSummary([gate]);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n'); } catch { /* non-fatal */ }
  }

  if (outFile) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), gates: [gate] }, null, 2) + '\n');
    } catch (err) { console.error(`[ci-gate] cannot write ${outFile}: ${err.message}`); }
  }

  console.log(`[ci-gate] ${verdict.ok ? 'PASS' : `FAIL — ${verdict.reason}`}`);
  process.exit(verdict.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = { parseTap, verdictOf, renderSummary };
