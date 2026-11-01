// test/source-ref.test.js — Issue #17：抗漂移的源码引用。
//
// 为什么这个模块值得单独测试：
//   契约表（DSH_EXECUTION_MAPPING）声称"这条映射的依据在代码哪里"。
//   用行号表达这件事是错的：插一个空行就让所有后续引用错位，而且**没有信号**。
//   本仓库真实发生过——5 处 `src/main.js:4760-4762` 之类的引用今天指向
//   `guidedInstallInProgress` 和 `hasBrokenBundle`，与 turn 事件毫无关系，
//   而原有测试只检查"行号 ≤ 文件行数"，所以这个漂移从未被发现。
//
//   这里锁死三件事：
//     1. 引用用符号 + 片段表达，行号漂移不影响
//     2. 符号被重命名/删除 → 红（真实的契约变化，应该红）
//     3. 片段被改写 → 红（需要人工确认契约是否仍然成立）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sr = require('../scripts/source-ref.js');

const ROOT = path.join(__dirname, '..');

function tmpFixture(content, name = 'fixture.js') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-srcref-'));
  fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

// ------------------------------------------------------------- 片段规范化

test('normalizeFragment: trims edges, unifies CRLF, trims each line', () => {
  assert.strictEqual(sr.normalizeFragment('  a\r\n   b  \n'), 'a\nb');
  assert.strictEqual(sr.normalizeFragment(''), '');
  assert.strictEqual(sr.normalizeFragment(null), '');
});

test('fragmentDigest: stable across whitespace-only differences', () => {
  const a = sr.fragmentDigest('const x = 1;');
  const b = sr.fragmentDigest('  const x = 1;  \n');
  assert.strictEqual(a, b, 'cosmetic whitespace must not change the digest');
});

test('fragmentDigest: changes when the code actually changes', () => {
  assert.notStrictEqual(sr.fragmentDigest('const x = 1;'), sr.fragmentDigest('const x = 2;'));
});

test('makeRef: rejects an empty fragment (a ref with no evidence is meaningless)', () => {
  assert.throws(() => sr.makeRef({ file: 'a.js', symbol: 'x', fragment: '   ' }), /non-empty fragment/);
});

test('makeRef: produces a frozen, self-consistent object', () => {
  const ref = sr.makeRef({ file: 'a.js', symbol: 'fn', fragment: 'return 1;' });
  assert.ok(Object.isFrozen(ref));
  assert.strictEqual(ref.digest, sr.fragmentDigest('return 1;'));
});

// ------------------------------------------------------------- 符号定位

test('resolveSymbol: finds function / const / class declarations', () => {
  const src = [
    'function alpha() {}',
    'const beta = 1;',
    'class Gamma {}',
    'async function delta() {}',
  ].join('\n');
  assert.ok(sr.resolveSymbol(src, 'alpha'));
  assert.ok(sr.resolveSymbol(src, 'beta'));
  assert.ok(sr.resolveSymbol(src, 'Gamma'));
  assert.ok(sr.resolveSymbol(src, 'delta'));
  assert.strictEqual(sr.resolveSymbol(src, 'nope'), null);
});

test('resolveSymbol: reports the START line of the symbol', () => {
  const src = 'line1\nline2\nfunction target() {}\n';
  const loc = sr.resolveSymbol(src, 'target');
  assert.strictEqual(loc.startLine, 3);
});

// ------------------------------------------------------------- 校验语义

test('verifyRef: passes when symbol exists and fragment is present', () => {
  const dir = tmpFixture('function fn() {\n  return 42;\n}\n');
  const ref = sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' });
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.located.startLine, 1);
});

test('verifyRef: LINE DRIFT does not break the ref (the whole point)', () => {
  const dir = tmpFixture('\n\n\n\nfunction fn() {\n  return 42;\n}\n');
  // Same content, now starting 4 lines later. A line-number citation would be
  // broken; a symbol+fragment citation must still verify.
  const ref = sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' });
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, true, 'shifting lines must not invalidate a symbol-based ref');
  assert.strictEqual(r.located.startLine, 5, 'and it should still locate it correctly');
});

test('verifyRef: a renamed symbol fails (real contract change => must be red)', () => {
  const dir = tmpFixture('function renamedFn() {\n  return 42;\n}\n');
  const ref = sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' });
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /no longer defined/);
});

test('verifyRef: a deleted symbol fails even if its body text still exists elsewhere', () => {
  const dir = tmpFixture('// fn was removed\nconst other = () => {\n  return 42;\n};\n');
  const ref = sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' });
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, false, 'symbol presence is checked independently of the fragment');
});

test('verifyRef: a rewritten fragment fails (needs human review)', () => {
  const dir = tmpFixture('function fn() {\n  return 43;\n}\n');
  const ref = sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' });
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /fragment no longer present/);
});

test('verifyRef: a missing file fails with a readable reason', () => {
  const ref = sr.makeRef({ file: 'nope.js', symbol: 'x', fragment: 'anything' });
  const r = sr.verifyRef(ref, fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-empty-')));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /cannot read/);
});

test('verifyRef: a ref whose digest was hand-edited is rejected', () => {
  const dir = tmpFixture('function fn() {\n  return 42;\n}\n');
  const ref = { ...sr.makeRef({ file: 'fixture.js', symbol: 'fn', fragment: 'return 42;' }), digest: 'deadbeefdeadbeef' };
  const r = sr.verifyRef(ref, dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /does not match its own fragment/);
});

test('verifyRefs: aggregates failures instead of stopping at the first', () => {
  const dir = tmpFixture('function good() { return 1; }\n');
  const good = sr.makeRef({ file: 'fixture.js', symbol: 'good', fragment: 'return 1;' });
  const bad1 = sr.makeRef({ file: 'fixture.js', symbol: 'ghost', fragment: 'return 1;' });
  const bad2 = sr.makeRef({ file: 'fixture.js', symbol: 'good', fragment: 'return 999;' });
  const r = sr.verifyRefs([good, bad1, bad2], dir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failures.length, 2, 'both failures must be reported');
});

// --------------------------------------------------- 真实仓库的端到端守护

test('REAL: every DSH_EXECUTION_MAPPING ref verifies against this repository', () => {
  const backend = require('../src/team/runtime/dsh-execution-backend.js');
  const refs = backend.DSH_EXECUTION_MAPPING.flatMap((r) => r.refs || []);
  assert.ok(refs.length >= 8, `expected a real citation set, got ${refs.length}`);
  const r = sr.verifyRefs(refs, ROOT);
  assert.deepEqual(r.failures.map((f) => `${f.ref.file} :: ${f.ref.symbol} :: ${f.reason}`), []);
});

test('REAL: the mapping table no longer contains any bare line-number citation', () => {
  const backend = require('../src/team/runtime/dsh-execution-backend.js');
  const hits = backend.DSH_EXECUTION_MAPPING
    .flatMap((row) => [...String(row.source).matchAll(/\.js:\d+/g)]);
  assert.deepEqual(hits.map((m) => m[0]), [],
    'line-number citations drift silently; use symbol + fragment refs instead');
});
