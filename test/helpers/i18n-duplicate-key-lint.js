'use strict';

// test/helpers/i18n-duplicate-key-lint.js — 2026-09-25 UX 必修（E2）测试支持。
//
// JS 对象字面量的重复键会被静默覆盖（后声明胜出），运行时的 STRINGS 对象看不
// 出来——zh 表里 `plugin.gitMissing` 曾被一行英文重复声明覆盖（中文用户在插件
// Git 缺失时看到英文报错），还有一整块先英文后中文的重复声明。所以这条 lint
// 直接扫描 src/i18n.js 源码：字符串与注释感知的扫描器，收集每个语言表 depth=1
// 的键声明，报告重复。
//
// 纯 Node，无依赖；test/i18n.test.js 用它跑生产词典，test/office-ux-mustfix.
// test.js 用合成源自证 lint 真的会触发（一个永不报警的 lint 没有价值）。

/** Character scanner over a source region that knows about JS string literals
 * (', ", ` with escapes) AND comments (// to EOL, /* ... *\/) — copy text and
 * comments inside the tables must never disturb brace/quote accounting. */
function createScanner(source, start, end) {
  let i = start;
  const skipNoise = () => {
    for (;;) {
      const ch = source[i];
      if (ch === '/' && source[i + 1] === '/') {
        while (i < end && source[i] !== '\n') i += 1;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < end && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
      return;
    }
  };
  return {
    pos: () => i,
    next() {
      skipNoise();
      if (i >= end) return null;
      const ch = source[i];
      if (ch === '\'' || ch === '"' || ch === '`') {
        const quote = ch;
        i += 1;
        let text = '';
        while (i < end) {
          if (source[i] === '\\') { text += source[i + 1]; i += 2; continue; }
          if (source[i] === quote) break;
          text += source[i];
          i += 1;
        }
        i += 1; // closing quote
        return { type: 'string', quote, text };
      }
      i += 1;
      return { type: 'char', ch };
    },
  };
}

/** Scan one `{ ... }` object-literal region (between `open` and `close`) and
 * return the depth-1 keys in source order. */
function literalKeysInRegion(source, open, close) {
  const scanner = createScanner(source, open + 1, close);
  const keys = [];
  let depth = 1;
  let expectKey = true;
  for (;;) {
    const token = scanner.next();
    if (token === null) break;
    if (token.type === 'string') {
      if (depth === 1 && expectKey) { keys.push(token.text); expectKey = false; }
      continue;
    }
    const ch = token.ch;
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; expectKey = true; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; continue; }
    if (ch === ',' && depth === 1) { expectKey = true; continue; }
    if (ch === ':' && depth === 1) { expectKey = false; continue; }
  }
  return keys;
}

/** Find the `{ table: { ... } }` region for one language key and return
 * [openIndex, closeIndex] of the table's own braces. */
function tableRegion(source, lang) {
  const marker = new RegExp(`\\b${lang}:\\s*\\{`).exec(source);
  if (!marker) throw new Error(`STRINGS.${lang} table not found`);
  const open = source.indexOf('{', marker.index);
  const scanner = createScanner(source, open, source.length);
  let depth = 0;
  for (;;) {
    const token = scanner.next();
    if (token === null) throw new Error(`unbalanced braces in STRINGS.${lang}`);
    if (token.type !== 'char') continue;
    if (token.ch === '{') depth += 1;
    else if (token.ch === '}') {
      depth -= 1;
      if (depth === 0) return [open, scanner.pos() - 1];
    }
  }
}

/** Collect duplicate depth-1 keys per language table.
 * @returns {Record<string, string[]>} lang -> ["key xN", ...] (empty object
 * when every table is duplicate-free). */
function collectDuplicateKeys(source, langs = ['zh', 'en']) {
  const duplicates = {};
  for (const lang of langs) {
    const [open, close] = tableRegion(source, lang);
    const keys = literalKeysInRegion(source, open, close);
    const seen = new Map();
    for (const key of keys) seen.set(key, (seen.get(key) || 0) + 1);
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
    if (dups.length) duplicates[lang] = dups;
  }
  return duplicates;
}

module.exports = { collectDuplicateKeys, literalKeysInRegion, tableRegion };
