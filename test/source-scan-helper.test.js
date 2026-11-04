// test/source-scan-helper.test.js — 源码扫描辅助模块自身的测试。
//
// 第一性原理：被十几个门禁共用的工具，必须自己先被验证
//
//   如果 stripComments() 有 bug，所有用它的断言都会失真 ——
//   而且失真的方向通常是"看着绿"，比红更危险。
//
//   本项目已经因为"各写各的剥注释实现"出过四次误判，
//   那四次的共同点是：实现只剔 `// 行注释`，块注释和行尾注释原封不动。
//   所以这里逐条钉住三种形式。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stripComments, codeHas, codeSlice } = require('./helpers/source-scan.js');

test('strip: full-line // comments are removed', () => {
  const src = 'const a = 1;\n// api(\'markSeen\')\nconst b = 2;';
  const out = stripComments(src);
  assert.equal(out.includes('markSeen'), false);
  assert.equal(out.includes('const a = 1;'), true);
  assert.equal(out.includes('const b = 2;'), true);
});

test('strip: TRAILING // comments are removed (this form was missed before)', () => {
  // 第 50 轮实测：mission-desk.html 里有 7 处这种行尾注释。
  const src = "if (!team) return null;   // 不能 api('markSeen')";
  const out = stripComments(src);
  assert.equal(out.includes('markSeen'), false,
    'a trailing comment must not leak into the scanned code');
  assert.equal(out.includes('return null;'), true);
});

test('strip: BLOCK comments are removed (95 of them existed; none were handled)', () => {
  const src = "const a = 1;\n/* 这里绝不能调 api('markSeen') */\nconst b = 2;";
  const out = stripComments(src);
  assert.equal(out.includes('markSeen'), false,
    'block comments must not leak into the scanned code');
  assert.equal(out.includes('const a = 1;'), true);
  assert.equal(out.includes('const b = 2;'), true);
});

test('strip: multi-line block comments are removed and line count is preserved', () => {
  // 行号必须保持 —— 断言里常用 indexOf 比位置。
  const src = "const a = 1;\n/* line1\n   api('x')\n   line3 */\nconst b = 2;";
  const out = stripComments(src);
  assert.equal(out.includes("api('x')"), false);
  assert.equal(out.split('\n').length, src.split('\n').length,
    'line count must be preserved so position-based assertions stay valid');
});

test('strip: code that merely looks like a comment inside a string is left alone', () => {
  // 我们不做完整词法分析，但至少不能把明显的代码字符串吃掉。
  const src = "const url = 'http://example.com';";
  const out = stripComments(src);
  assert.equal(out.includes('http://example.com'), true);
});

test('codeHas: it answers about CODE, not raw text', () => {
  const src = "// api('markSeen')\nconst x = 1;";
  assert.equal(codeHas(src, "api('markSeen')"), false,
    'a commented-out call is not a call');
  assert.equal(codeHas(stripComments(src) + "api('markSeen')", "api('markSeen')"), true);
});

test('codeHas: it accepts a RegExp and does not mutate lastIndex', () => {
  const src = 'const a = 1;';
  const re = /const/g;
  // 连调两次结果必须一致（g 标志的 lastIndex 陷阱）
  assert.equal(codeHas(src, re), true);
  assert.equal(codeHas(src, re), true);
});

test('codeSlice: it returns a de-commented slice of a named block', () => {
  const src = "function f() {\n  // api('markSeen')\n  return 1;\n}";
  const out = codeSlice(src, 'function f() {', 100);
  assert.equal(out.includes('markSeen'), false);
  assert.equal(out.includes('return 1;'), true);
});

test('codeSlice: a missing marker yields empty (never throws)', () => {
  assert.equal(codeSlice('const a = 1;', 'not-there', 50), '');
});

test('strip: degenerate input never throws', () => {
  assert.doesNotThrow(() => stripComments(null));
  assert.doesNotThrow(() => stripComments(undefined));
  assert.equal(stripComments(null), '');
  assert.equal(stripComments(123), '');
});

test('strip: an unterminated block comment does not swallow the rest forever', () => {
  // 未闭合时应当到末尾为止，而不是抛错或死循环。
  const src = 'const a = 1;\n/* never closed\nconst b = 2;';
  const out = stripComments(src);
  assert.equal(out.includes('const a = 1;'), true);
  assert.equal(out.includes('const b = 2;'), false, 'everything after an unterminated block is inside it');
});
