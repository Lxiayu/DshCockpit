'use strict';

// test/shell-update-notice.test.js — M5 (windows-perf audit 2026-09-24).
//
// The shell self-update pipeline used to answer every failure with a log line
// only; these tests pin the user-visible policy in src/shell-update-notice.js:
// a manual check always answers, an automatic offline check does not toast, a
// failing download (the case an unsigned exe + AV produces) does, and notices
// are rate-limited so a 4h auto-check cannot spam.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createShellUpdateNotifier, NOTICE_GAP_MS } = require('../src/shell-update-notice');

// Minimal t()/notify() doubles: the i18n key is the observable.
function harness({ nowMs = 0 } = {}) {
  const notifications = [];
  const logs = [];
  const clock = { now: nowMs };
  const notifier = createShellUpdateNotifier({
    notify: (title, body) => notifications.push({ title, body }),
    // t(key, vars) -> "key|json(vars)" so the assertions can see the key AND
    // the interpolated variables (the retry hint must reach the user).
    t: (lang, key, vars) => `${key}${vars ? `|${JSON.stringify(vars)}` : ''}`,
    lang: () => 'zh',
    now: () => clock.now,
    log: (line) => logs.push(line),
    version: () => '0.4.0',
  });
  return { notifier, notifications, logs, clock };
}

test('M5: a manual check failure is ALWAYS surfaced with the reason and the retry hint', () => {
  const h = harness();
  h.notifier.beginCheck(true);
  const decision = h.notifier.onError(new Error('net::ERR_CONNECTION_RESET'));
  assert.equal(decision.notified, true);
  assert.equal(decision.reason, 'failed');
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].title, /^notify\.shellUpdateFailed/);
  assert.match(h.notifications[0].body, /net::ERR_CONNECTION_RESET/, 'the real reason reaches the user');
  assert.equal(h.logs.some((l) => /surfaced to the user/.test(l)), true, 'the log still records it');
});

test('M5: the new i18n strings exist in both languages and name the actual retry affordance', () => {
  const { STRINGS } = require('../src/i18n');
  const zh = STRINGS.zh || STRINGS.cn || STRINGS['zh-CN'];
  const en = STRINGS.en;
  assert.ok(zh && en, 'both language tables resolve');
  for (const key of ['notify.shellUpdateFailed', 'notify.shellUpdateFailedBody',
    'notify.shellUpdateDownloadFailed', 'notify.shellUpdateDownloadFailedBody',
    'notify.shellUpToDate', 'notify.shellUpToDateBody']) {
    assert.ok(zh[key], `zh has ${key}`);
    assert.ok(en[key], `en has ${key}`);
  }
  assert.match(zh['notify.shellUpdateFailedBody'], /\{msg\}/, 'zh failure body interpolates the reason');
  assert.match(zh['notify.shellUpdateFailedBody'], /立即检查壳更新/, 'zh body names the retry entry the user has');
  assert.match(zh['notify.shellUpdateFailedBody'], /GitHub Releases/, 'zh body names the manual fallback');
  assert.match(en['notify.shellUpdateFailedBody'], /\{msg\}/);
  assert.match(en['notify.shellUpdateFailedBody'], /Check for shell update now/);
  assert.match(zh['notify.shellUpToDateBody'], /\{v\}/);
});

test('M5: a failing DOWNLOAD of an update we already found is surfaced even on an automatic check', () => {
  const h = harness();
  h.notifier.beginCheck(false);
  h.notifier.onAvailable({ version: '0.5.0' });
  const decision = h.notifier.onError(new Error('EPERM: operation not permitted (installer blocked)'));
  assert.equal(decision.notified, true);
  assert.equal(decision.reason, 'download-failed');
  assert.match(h.notifications[0].title, /^notify\.shellUpdateDownloadFailed/);
  assert.match(h.notifications[0].body, /EPERM/);
});

test('M5: an automatic offline check stays in the log (no toast) — and is rate-limited once it does speak up', () => {
  const h = harness();
  // 1) no update in flight: silent
  h.notifier.beginCheck(false);
  const silent = h.notifier.onError(new Error('ENOTFOUND github.com'));
  assert.equal(silent.notified, false);
  assert.equal(silent.reason, 'silent-auto-check');
  assert.equal(h.notifications.length, 0);
  assert.equal(h.logs.some((l) => /logged only/.test(l)), true, 'the failure is still logged');

  // 2) a download is failing: the first notice goes out...
  h.notifier.beginCheck(false);
  h.notifier.onAvailable({ version: '0.5.0' });
  assert.equal(h.notifier.onError(new Error('ECONNRESET during download')).notified, true);
  // ...a second one immediately after does not (rate limit)...
  h.notifier.beginCheck(false);
  h.notifier.onAvailable({ version: '0.5.0' });
  const limited = h.notifier.onError(new Error('ECONNRESET again'));
  assert.equal(limited.notified, false);
  assert.equal(limited.reason, 'rate-limited');
  // ...and after the window it does again.
  h.clock.now = NOTICE_GAP_MS;
  h.notifier.beginCheck(false);
  h.notifier.onAvailable({ version: '0.5.0' });
  assert.equal(h.notifier.onError(new Error('ECONNRESET later')).notified, true);
  assert.equal(h.notifications.length, 2);
});

test('M5: manual failures are never rate-limited (the user is looking at the button)', () => {
  const h = harness();
  for (let i = 0; i < 3; i += 1) {
    h.notifier.beginCheck(true);
    assert.equal(h.notifier.onError(new Error(`boom ${i}`)).notified, true);
  }
  assert.equal(h.notifications.length, 3);
});

test('M5: a manual check that finds nothing answers "up to date"; the automatic one stays silent', () => {
  const h = harness();
  h.notifier.beginCheck(true);
  assert.equal(h.notifier.onNotAvailable().notified, true);
  assert.match(h.notifications[0].title, /^notify\.shellUpToDate/);
  assert.match(h.notifications[0].body, /0\.4\.0/, 'the current version is named');
  h.notifier.beginCheck(false);
  assert.equal(h.notifier.onNotAvailable().notified, false);
  assert.equal(h.notifications.length, 1);
});

test('M5: a successful download clears the download-in-flight flag (no spurious "download failed" wording)', () => {
  const h = harness();
  h.notifier.beginCheck(true);
  h.notifier.onAvailable({ version: '0.5.0' });
  h.notifier.onDownloaded({ version: '0.5.0' });
  const decision = h.notifier.onError(new Error('post-download hiccup'));
  assert.equal(decision.notified, true);
  assert.equal(decision.reason, 'failed', 'a manual check failure after a completed download is a generic failure');
  assert.match(h.notifications[0].title, /^notify\.shellUpdateFailed$/);
});

test('M5 wiring: main.js routes every electron-updater event through the notifier (no silent log-only handler)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(src, /autoUpdater\.on\('error', \(e\) => \{\s*\n\s*log\(`\[shell\] updater: \$\{e && e\.message\}`\);\s*\n[\s\S]{0,200}shellUpdateNotice\(\)\.onError\(e\)/,
    'the error event surfaces a notice, not only a log line');
  assert.match(src, /autoUpdater\.on\('update-not-available', \(\) => \{[\s\S]{0,200}shellUpdateNotice\(\)\.onNotAvailable\(\)/);
  assert.match(src, /shellUpdateNotice\(\)\.beginCheck\(notifyUser\)/, 'the manual/auto flag reaches the policy');
  assert.match(src, /const \{ createShellUpdateNotifier \} = require\('\.\/shell-update-notice'\)/);
});
