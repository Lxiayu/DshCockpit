// test/diagnostics-deps-wired.test.js — 诊断包的依赖链必须真的通。
//
// 第一性原理：三层"接线"，缺任何一层字段就是空的
//
//   诊断包里的 teamActivation 要能出现值，需要三件事同时成立：
//     ① diagnostics-bundle.js 读 `d.officeTeamActivation()`
//     ② main.js 的 deps 对象里**注入**了它
//     ③ 它背后的缓存**有人填充**（probeOfficeTeamActivation 被调用）
//
//   第 4172574 提交做到了 ①②，漏了 ③ ——
//   于是 d.officeTeamActivation() 一直返回 null（缓存从未被填），
//   诊断包里的 teamActivation 永远是空。
//
//   这比"没实现"更隐蔽：代码看起来完整、测试也是绿的
//   （diagnostics-bundle 的测试自己传 deps，测不到 main.js 漏了 ③）。
//   只有真的导出一份诊断包才会发现字段是空的 —— 而那时通常正在排障。
//
//   所以这里三层都查。
'use strict';

const { test } = require('node:test');
const { stripComments } = require('./helpers/source-scan.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUNDLE = fs.readFileSync(path.join(ROOT, 'src', 'diagnostics-bundle.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

/** 去掉整行注释（注释会大量提到依赖名，不剥会误判"已注入"）。 */
function stripLineComments(s) {
  // 委托给共享实现（行注释 / 行尾注释 / 块注释 全剔）
  return stripComments(s);
}

/** diagnostics-bundle 里访问的所有依赖名（`d.xxx` 形式）。 */
function requiredDeps() {
  const names = new Set();
  for (const m of BUNDLE.matchAll(/\bd\.([a-zA-Z][a-zA-Z0-9]*)\s*(?:\(|\?|&&|\|\||\.)/g)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/** main.js 里 createDiagnosticsBundle({...}) 的实参（括号配平）。 */
function injectedBlock() {
  const i = MAIN.indexOf('createDiagnosticsBundle({');
  assert.ok(i !== -1, 'main.js must call createDiagnosticsBundle with a deps object');
  const start = MAIN.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < MAIN.length; j += 1) {
    if (MAIN[j] === '{') depth += 1;
    else if (MAIN[j] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(start, j + 1);
    }
  }
  throw new Error('unbalanced braces in createDiagnosticsBundle deps');
}

test('deps: the audit finds a real dependency surface', () => {
  const deps = requiredDeps();
  assert.ok(deps.length >= 8, `expected a real dependency surface, found: ${deps.join(', ')}`);
});

test('deps: every dependency the bundle reads IS injected by main.js', () => {
  const block = stripLineComments(injectedBlock());
  const missing = requiredDeps().filter((name) => {
    const asKey = new RegExp(`(^|[{,\\s])${name}\\s*:`);
    const asShorthand = new RegExp(`(^|[{,\\s])${name}\\s*[,}]`);
    return !asKey.test(block) && !asShorthand.test(block);
  });
  assert.deepEqual(missing, [],
    `read by diagnostics-bundle.js but never injected — the field is silently empty `
    + `in every exported bundle:\n  ${missing.join('\n  ')}`);
});

test('deps: no dependency is injected TWICE (a duplicate key silently wins)', () => {
  // 我修这一项时不小心注入了第二次 —— JS 允许重复 key，后者覆盖前者且不报错。
  const block = stripLineComments(injectedBlock());
  const keys = [...block.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((m) => m[1]);
  const seen = new Set();
  const dupes = [];
  for (const k of keys) {
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  assert.deepEqual(dupes, [], `duplicate dependency keys (the later one silently wins): ${dupes.join(', ')}`);
});

test('deps: the teamActivation dependency is injected', () => {
  const block = stripLineComments(injectedBlock());
  assert.match(block, /officeTeamActivation\s*:/,
    'the bundle reads d.officeTeamActivation() — without the injection the field is always null');
});

test('deps: the cache it reads is actually FILLED somewhere (layer 3)', () => {
  // 这是真正漏掉过的那一层：注入存在，但它返回的缓存无人填充。
  const code = stripLineComments(MAIN);
  const calls = [...code.matchAll(/await probeOfficeTeamActivation\(\)/g)];
  assert.ok(calls.length >= 1,
    'probeOfficeTeamActivation must be CALLED somewhere — otherwise the cache stays null '
    + 'and teamActivation is empty even though the injection exists');
});

test('deps: the probe is triggered before the bundle is built', () => {
  // 顺序很重要：先打包再探测的话，这一次导出里仍然是空的。
  const code = stripLineComments(MAIN);
  const probeAt = code.indexOf('await probeOfficeTeamActivation()');
  const buildAt = code.indexOf('diagnosticsBundle.build(');
  assert.ok(probeAt !== -1 && buildAt !== -1, 'both must exist');
  assert.ok(probeAt < buildAt,
    'the probe must run BEFORE the bundle is built, otherwise this export still has no value');
});

test('deps: a failing probe must not break the bundle export', () => {
  // 打包本身比一项诊断重要得多。
  const code = stripLineComments(MAIN);
  const idx = code.indexOf('await probeOfficeTeamActivation()');
  const around = code.slice(Math.max(0, idx - 400), idx + 500);
  assert.match(around, /try\s*\{/,
    'the probe must be wrapped in try/catch — a probe failure cannot abort the export');
});
