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

test('plugin.* market strings exist in both languages', () => {
  const keys = ['plugin.busy', 'plugin.timeout', 'plugin.spawnFailed',
    'plugin.installed', 'plugin.installedBody', 'plugin.removed', 'plugin.removedBody',
    'plugin.failed', 'plugin.failedBody'];
  for (const k of keys) {
    assert.ok(t('zh', k), `zh missing ${k}`);
    assert.ok(t('en', k), `en missing ${k}`);
  }
  assert.strictEqual(t('zh', 'plugin.failedBody', { name: 'a/b', reason: 'x' }), 'a/b：x');
  assert.strictEqual(t('en', 'plugin.failedBody', { name: 'a/b', reason: 'x' }), 'a/b: x');
});

test('container hardening strings exist in both languages (2026-09-23)', () => {
  // 降级可见化 + 自动回滚的用户可见文案（托盘 tooltip/菜单、设置页、通知）
  const keys = [
    'runtime.degradedTitle', 'runtime.degradedFeed', 'runtime.degradedAuth',
    'runtime.degradedDisconnected', 'runtime.degradedHint',
    'notify.runtimeDegraded', 'notify.runtimeDegradedBody',
    'notify.autoRollback', 'notify.autoRollbackBody',
  ];
  for (const k of keys) {
    assert.ok(t('zh', k), `zh missing ${k}`);
    assert.ok(t('en', k), `en missing ${k}`);
  }
  // the rollback notice must name the version the user fell back TO
  const body = t('zh', 'notify.autoRollbackBody', { v: '0.1.5-rc.2', n: 3, to: '0.1.1-rc.2' });
  assert.match(body, /0\.1\.5-rc\.2/);
  assert.match(body, /0\.1\.1-rc\.2/);
});
