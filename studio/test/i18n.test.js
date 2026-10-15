'use strict';

// studio/test/i18n.test.js — the bilingual key-set contract (brief §11: 中英双语键集等价).
//
// The dictionary and the markup are two files that drift easily (a new button gets a
// Chinese label and no key; a key loses its English half). This suite parses BOTH and
// holds the line: every key carries both languages, no key is orphaned, and every key the
// HTML references exists — so a half-translated UI cannot pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
const JS = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');

test('every key carries both languages, with real text', () => {
  const keys = Object.keys(i18n.DICT);
  assert.ok(keys.length >= 40, `the dictionary covers the chrome (${keys.length} keys)`);
  const problems = [];
  for (const [key, entry] of Object.entries(i18n.DICT)) {
    for (const language of ['zh', 'en']) {
      const value = entry[language];
      if (typeof value !== 'string' || value.trim().length === 0) problems.push(`${key}.${language} is empty`);
      else if (entry.zh === entry.en && /[\u4e00-\u9fff]/.test(entry.zh)) problems.push(`${key}: the English side is still Chinese`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the key set is closed: no orphan entries, no missing ones', () => {
  const referenced = new Set();
  for (const match of HTML.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) referenced.add(match[1]);
  // A key is referenced whether the call passes parameters or not: `t('a.b')` AND
  // `t('a.b', { n: 1 })`. The old pattern required the closing paren immediately, so every
  // parameterised call counted as "unused" — which turned the ≤1/3 unused rule into a cap on
  // how much panel prose could be converted at all (R2-E hit exactly that wall).
  for (const match of JS.matchAll(/\bt\(\s*'([a-z][a-zA-Z0-9.-]+)'/g)) referenced.add(match[1]);
  const declared = new Set(Object.keys(i18n.DICT));
  const missing = [...referenced].filter((key) => !declared.has(key));
  assert.deepEqual(missing, [], `keys referenced but not declared: ${missing.join(', ')}`);
  // an unused key is not an error (the dictionary is also documentation), but it should be
  // rare — report the count so a big pile of dead keys gets noticed
  const unused = [...declared].filter((key) => !referenced.has(key));
  assert.ok(unused.length <= declared.size / 3, `most keys are actually used (${unused.length} unused of ${declared.size})`);
});

test('the markup carries the attributes the applier walks', () => {
  for (const attribute of ['data-i18n="', 'data-i18n-title="', 'data-i18n-placeholder="', 'data-i18n-aria-label="']) {
    assert.ok(HTML.includes(attribute), `${attribute} is used at least once`);
  }
  // the eleven tabs and the language control are translated, not hard-coded
  const tabKeys = [...HTML.matchAll(/id="tab-[a-z-]+"[^>]*data-i18n="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(tabKeys.length, 11, `all eleven tabs carry a key (${tabKeys.length})`);
  assert.match(HTML, /id="btn-lang"/, 'the language control exists');
});

test('resolution follows the preference, then the system locale, then Chinese', () => {
  assert.equal(i18n.resolveLanguage('en', 'zh-CN'), 'en', 'an explicit choice wins over the system');
  assert.equal(i18n.resolveLanguage('zh', 'en-US'), 'zh');
  assert.equal(i18n.resolveLanguage('system', 'en-GB'), 'en');
  assert.equal(i18n.resolveLanguage('system', 'zh-Hans'), 'zh');
  assert.equal(i18n.resolveLanguage('system', 'fr-FR'), 'zh', 'an unknown locale falls back to Chinese');
  assert.equal(i18n.t('tab.preview', 'en'), 'Preview');
  assert.equal(i18n.t('tab.preview', 'zh'), '运行预览');
  assert.equal(i18n.t('not.a.key', 'en'), 'not.a.key', 'a missing key shows itself instead of a blank');
});

test('the applier translates attributes, text and the document language', () => {
  // a minimal DOM stub: the applier only needs querySelectorAll + dataset
  const nodes = [
    { dataset: { i18n: 'head.scene' }, textContent: '' },
    { dataset: { i18nTitle: 'btn.toggleRight' }, title: '' },
    { dataset: { i18nPlaceholder: 'pane.tree.filter' }, placeholder: '' },
    { dataset: { i18nAriaLabel: 'btn.language' }, setAttribute: (key, value) => { nodes[3][key] = value; } },
  ];
  const stub = {
    documentElement: { lang: '' },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return [nodes[0]];
      if (selector === '[data-i18n-title]') return [nodes[1]];
      if (selector === '[data-i18n-placeholder]') return [nodes[2]];
      if (selector === '[data-i18n-aria-label]') return [nodes[3]];
      return [];
    },
  };
  const outcome = i18n.applyTranslations(stub, 'en');
  assert.equal(outcome.applied, 4);
  assert.match(nodes[0].textContent, /Scene canvas/);
  assert.match(nodes[1].title, /right pane/);
  assert.match(nodes[2].placeholder, /Filter files/);
  assert.equal(nodes[3]['aria-label'], 'Language');
  assert.equal(stub.documentElement.lang, 'en');
  assert.equal(i18n.applyTranslations(stub, 'zh').applied, 4);
  assert.equal(stub.documentElement.lang, 'zh-CN');
});
