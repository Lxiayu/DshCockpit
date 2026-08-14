// test/i18n.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { t, resolveLanguage } = require('../src/i18n');

test('resolveLanguage honors explicit preference', () => {
  assert.strictEqual(resolveLanguage('zh'), 'zh');
  assert.strictEqual(resolveLanguage('en'), 'en');
});

test('resolveLanguage follows OS locale for system', () => {
  const prev = process.env.LANG;
  try {
    process.env.LANG = 'zh-CN';
    assert.strictEqual(resolveLanguage('system'), 'zh');
    process.env.LANG = 'en-US';
    assert.strictEqual(resolveLanguage('system'), 'en');
  } finally {
    if (prev === undefined) delete process.env.LANG; else process.env.LANG = prev;
  }
});

test('t() translates and substitutes vars', () => {
  assert.strictEqual(t('zh', 'tray.open'), '打开 DSH');
  assert.strictEqual(t('en', 'tray.open'), 'Open DSH');
  assert.strictEqual(t('zh', 'notify.upToDateBody', { v: '0.1.0-rc.6' }), '当前运行时 0.1.0-rc.6');
  assert.strictEqual(t('en', 'notify.downloading', { a: '1', b: '2' }), '1 → 2, downloading…');
});

test('t() falls back to en for unknown keys', () => {
  assert.strictEqual(t('zh', 'no.such.key'), 'no.such.key');
});

test('zh/en dictionaries cover the same keys', () => {
  const { STRINGS } = require('../src/i18n');
  const zhKeys = Object.keys(STRINGS.zh).sort();
  const enKeys = Object.keys(STRINGS.en).sort();
  assert.deepStrictEqual(zhKeys, enKeys, 'zh and en key sets must match');
});
