// test/office-i18n-completeness.test.js — 用到的 i18n key 必须都在字典里。
//
// 第一性原理：缺一个 key，界面上就是一片空白
//
//   office.html 的 tr() 对未知 key 返回**空字符串**：
//     const tr = (key) => { ...; return !s || s === key ? '' : s; };
//   而 applyI18n 直接 `el.textContent = tr(...)` ——
//   于是 key 缺失不是"显示英文原文"，而是**把那个元素清空**。
//
//   而且它不会抛错、不会留日志。界面上只是少了一行字，
//   谁也不会注意到 —— 除非有人正好去找那句话。
//
//   本轮实测：office.html 用了 114 个 key，其中 2 个不在字典里
//     · office.usage.basis.api-key  （字典里是 apiKey，拼写不一致）
//     · office.usage.moneyTitle     （完全没定义）
//
//   所以这里机械地查一遍。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { stripComments } = require('./helpers/source-scan.js');

const HTML = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8'));
const I18N = fs.readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8');

/** 页面用到的静态 i18n key（data-i18n* 属性 + tr('...') 字面量）。 */
function usedKeys() {
  const keys = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-title|-aria|-placeholder)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of HTML.matchAll(/\btr\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of HTML.matchAll(/\btr\(\s*"([^"]+)"/g)) keys.add(m[1]);
  return [...keys].sort();
}

/** 字典里定义了哪些 key（引号包裹的完整 key）。 */
function definedKeys() {
  const keys = new Set();
  for (const m of I18N.matchAll(/'(office\.[a-zA-Z0-9_.]+)'\s*:/g)) keys.add(m[1]);
  for (const m of I18N.matchAll(/"(office\.[a-zA-Z0-9_.]+)"\s*:/g)) keys.add(m[1]);
  return keys;
}

test('i18n: the scan actually sees a real key surface', () => {
  const used = usedKeys();
  assert.ok(used.length >= 80,
    `expected a real i18n surface in office.html, found only ${used.length} keys`);
  assert.ok(definedKeys().size >= 80,
    'expected a real dictionary, found too few keys');
});

test('i18n: every static key used by office.html exists in the dictionary', () => {
  const defined = definedKeys();
  // 末尾带点的 key 是**动态家族前缀**（`office.staff.currentTool.${x}`），
  // 正则会把模板字面量的后半段截掉、只留到点为止。
  // 它们由下一条断言逐个成员校验，这里先排除，否则是测试自己的误报。
  const missing = usedKeys()
    .filter((k) => !k.endsWith('.'))
    .filter((k) => !defined.has(k));
  assert.deepEqual(missing, [],
    `these keys are used by office.html but not defined — tr() returns '' for them, `
    + `so the element is silently BLANKED:\n  ${missing.join('\n  ')}`);
});

test('i18n: keys ending in a dot are dynamic families, not typos', () => {
  // `office.staff.currentTool.${summaryKey}` 这种模板拼接会被正则抓成
  // `office.staff.currentTool.`（末尾带点）。它是合法的动态家族，
  // 需要单独验证它的**每个成员**都在字典里，而不是把它当缺失。
  const dynamicFamilies = usedKeys().filter((k) => k.endsWith('.'));
  const defined = definedKeys();
  for (const fam of dynamicFamilies) {
    const members = [...defined].filter((k) => k.startsWith(fam));
    assert.ok(members.length >= 2,
      `dynamic family ${fam}* has ${members.length} members in the dictionary — `
      + `it looks like a typo rather than a family`);
  }
});

test('i18n: the tool-phrase family is complete for every runtime phrase key', () => {
  // office.html 自己拼 `office.staff.currentTool.${summaryKey}`，
  // 而 tool-phrases.js 的 PHRASE_KEYS 是这套词表的来源。
  // 两者必须一一对应 —— 少一个就是一格空白。
  const { PHRASE_KEYS } = require('../src/office/runtime/tool-phrases.js');
  const defined = definedKeys();
  const missing = PHRASE_KEYS
    .map((k) => `office.staff.currentTool.${k}`)
    .filter((k) => !defined.has(k));
  assert.deepEqual(missing, [],
    `runtime can emit these phrase keys but the dictionary has no copy for them:\n  ${missing.join('\n  ')}`);
});

test('i18n: both languages define the same office.* keys', () => {
  // 少一个语言就是"切到英文时这一行空了"。
  //
  // ⚠️ 这条断言第一版写的是找 `const ZH` / `const EN` —— 而实际结构是
  //   `const STRINGS = { zh: {...}, en: {...} }`，两个标记都不存在，
  //   于是它**静默 return 了**，永远是绿的。
  //   这就是"测试自己假绿"的典型 —— 空断言比没有断言更危险，
  //   因为它让人以为这块被守着了。
  //   现在找不到结构就**失败**，而不是跳过。
  const zhStart = I18N.indexOf('\n  zh: {');
  const enStart = I18N.indexOf('\n  en: {');
  assert.ok(zhStart !== -1 && enStart !== -1,
    'i18n.js structure changed — this gate must be updated, not skipped');
  const zhBlock = I18N.slice(zhStart, enStart);
  const enBlock = I18N.slice(enStart);
  const zh = new Set([...zhBlock.matchAll(/'(office\.[a-zA-Z0-9_.]+)'\s*:/g)].map((m) => m[1]));
  const en = new Set([...enBlock.matchAll(/'(office\.[a-zA-Z0-9_.]+)'\s*:/g)].map((m) => m[1]));
  assert.ok(zh.size >= 80 && en.size >= 80,
    `expected real dictionaries, zh=${zh.size} en=${en.size}`);
  const onlyZh = [...zh].filter((k) => !en.has(k));
  const onlyEn = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(onlyZh, [], `defined in zh but missing from en:\n  ${onlyZh.join('\n  ')}`);
  assert.deepEqual(onlyEn, [], `defined in en but missing from zh:\n  ${onlyEn.join('\n  ')}`);
});
