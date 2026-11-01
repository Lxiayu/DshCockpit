// test/ci-gate.test.js — Issue #10：CI 门禁的四态诚实报告。
//
// 为什么单独测这个：
//   用户明确要求"Passed / Failed / Skipped / Todo 必须分开报告，不能把 Skip
//   计作 Pass"。这条要求此前在本仓库**被真实违反过**：
//   test/office-ui.test.js 的 E5a-R1 真机探针用 `if (process.env.CI) return;`
//   提前返回，于是 `CI=1 npm test` 报告 pass=1959 / skipped=0 ——
//   一个像素级契约一次都没执行，却和验证过的契约长得一模一样。
//
//   这些测试锁死三件事：
//     1. SKIP / TODO directive 必须从 PASS 中分离出来
//     2. "全 skip" 和 "零测试" 都不能算通过
//     3. 失败列表必须能被汇报（不能只给一个数字）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const { parseTap, verdictOf, renderSummary } = require('../scripts/ci-gate.js');

const ROOT = path.join(__dirname, '..');

function tap(lines) { return lines.join('\n'); }

// ------------------------------------------------------------------ parsing

test('parseTap: separates pass / skip / todo / fail (skip is NOT a pass)', () => {
  const r = parseTap(tap([
    'TAP version 13',
    '# Subtest: alpha',
    'ok 1 - alpha',
    '# Subtest: beta',
    'ok 2 - beta # SKIP no display available',
    '# Subtest: gamma',
    'ok 3 - gamma # TODO revisit',
    '# Subtest: delta',
    'not ok 4 - delta',
    '  ---',
    "  error: 'boom'",
    '  ...',
  ]));
  assert.strictEqual(r.pass, 1, 'only alpha truly passed');
  assert.strictEqual(r.skip, 1, 'beta is skipped, must not inflate pass');
  assert.strictEqual(r.todo, 1);
  assert.strictEqual(r.fail, 1);
  assert.deepStrictEqual(r.failures, ['delta']);
  assert.deepStrictEqual(r.skips, ['beta']);
});

test('parseTap: lowercase directives and trailing reasons are handled', () => {
  const r = parseTap(tap(['ok 1 - x # skip because reasons', 'ok 2 - y # todo']));
  assert.strictEqual(r.skip, 1);
  assert.strictEqual(r.todo, 1);
  assert.strictEqual(r.pass, 0);
});

test('parseTap: `not ok ... # SKIP` counts as skip, not failure (directive wins)', () => {
  const r = parseTap(tap(['not ok 1 - x # SKIP nope']));
  assert.strictEqual(r.fail, 0, 'a skipped test expressed as not-ok must not be reported as a failure');
  assert.strictEqual(r.skip, 1);
});

test('parseTap: nested/indented result lines do not double count', () => {
  // node:test emits indented subtest lines in some reporters; only column-0
  // `ok`/`not ok` are real test points.
  const r = parseTap(tap([
    'ok 1 - outer',
    '    ok 2 - inner (indented, not a top-level point)',
  ]));
  assert.strictEqual(r.pass, 1, 'indented lines must be ignored');
});

test('parseTap: an ESCAPED `# SKIP` inside a test name is not a directive', () => {
  // node --test escapes `#` in test names as `\#`. Our own parser tests have
  // such names, and without this guard a passing test got counted as skipped —
  // turning the gate itself into a source of noise.
  const r = parseTap(tap([
    'ok 1 - parseTap: `not ok ... \\# SKIP` counts as skip (directive wins)',
    'ok 2 - a real skipper # SKIP genuinely skipped',
  ]));
  assert.strictEqual(r.pass, 1, 'the test whose NAME mentions # SKIP must count as passed');
  assert.strictEqual(r.skip, 1);
  assert.deepStrictEqual(r.skips, ['a real skipper']);
});

// ------------------------------------------------------------------ verdict

test('verdictOf: an empty run is NOT a pass (silent zero-test must fail loudly)', () => {
  const v = verdictOf({ pass: 0, fail: 0, skip: 0, todo: 0 });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /no tests/);
});

test('verdictOf: all-skipped is NOT a pass', () => {
  const v = verdictOf({ pass: 0, fail: 0, skip: 12, todo: 0 });
  assert.strictEqual(v.ok, false, 'skipping everything must never look green');
  assert.match(v.reason, /zero passing/);
});

test('verdictOf: skips alongside real passes are acceptable (skip does not block)', () => {
  const v = verdictOf({ pass: 100, fail: 0, skip: 3, todo: 1 });
  assert.strictEqual(v.ok, true);
});

test('verdictOf: any failure fails the gate even if most passed', () => {
  const v = verdictOf({ pass: 1958, fail: 1, skip: 0, todo: 0 });
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /1 failing/);
});

// ------------------------------------------------------------------ summary

test('renderSummary: the four states are displayed separately, never merged', () => {
  const md = renderSummary([{ label: 'unit', pass: 10, fail: 1, skip: 2, todo: 3, skips: ['slow probe'] }]);
  assert.match(md, /Passed/);
  assert.match(md, /Failed/);
  assert.match(md, /Skipped/);
  assert.match(md, /Todo/);
  // the counts must appear as their own columns
  assert.match(md, /\| unit \|.*\| 10 \| 1 \| 2 \| 3 \|/);
  // skipped names are surfaced for human review
  assert.match(md, /slow probe/);
});

test('renderSummary: states the skipped-not-passed rule explicitly on a green run', () => {
  const md = renderSummary([{ label: 'unit', pass: 5, fail: 0, skip: 1, todo: 0, skips: ['x'] }]);
  assert.match(md, /Skipped 不计入 Passed/);
});

// ---------------------------------------------------------------- CLI e2e

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cig-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function runGate(tapPath, label = 'unit') {
  try {
    const out = execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'ci-gate.js'),
      '--tap-file', tapPath, '--label', label,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

test('CLI: exits 0 when there are passes and no failures', () => {
  const p = tmpFile('ok.tap', tap(['ok 1 - a', 'ok 2 - b # SKIP x']));
  const r = runGate(p);
  assert.strictEqual(r.code, 0, r.out);
  // one real pass + one skip: the report must NOT say passed=2
  assert.match(r.out, /passed=1/, 'the skipped test must not be counted as passed');
  assert.match(r.out, /skipped=1/);
});

test('CLI: exits 1 and names the failures when something fails', () => {
  const p = tmpFile('bad.tap', tap(['ok 1 - a', 'not ok 2 - broken thing']));
  const r = runGate(p);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /FAILURES/);
  assert.match(r.out, /broken thing/);
});

test('CLI: exits 1 on an all-skipped run (never reports green)', () => {
  const p = tmpFile('allskip.tap', tap(['ok 1 - a # SKIP', 'ok 2 - b # SKIP']));
  const r = runGate(p);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /zero passing/);
});

test('CLI: --self-test is wired (guards the shipped example against drift)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ci-gate.js'), '--self-test'], { encoding: 'utf8' });
  assert.match(out, /self-test OK/);
});

// --------------------------------------------------- regression: the probe

test('REGRESSION: the E5a-R1 real-shell probe reports as SKIPPED under CI, not as a pass', () => {
  // This is the exact defect Issue #10 surfaced: the test body used a bare
  // `return`, so `CI=1` swallowed it into the pass count.
  const src = fs.readFileSync(path.join(ROOT, 'test', 'office-ui.test.js'), 'utf8');
  const probeBlock = src.slice(src.indexOf('E5a-R1 real shell'));
  assert.ok(probeBlock.length > 0, 'the E5a-R1 probe must still exist');
  assert.match(probeBlock, /t\.skip\(/, 'the probe must use an explicit t.skip() directive');
  assert.doesNotMatch(
    probeBlock.slice(0, 2000),
    /if \(process\.env\.CI\) return;/,
    'a bare `return` under CI hides the probe from the report — use t.skip() instead',
  );
});
