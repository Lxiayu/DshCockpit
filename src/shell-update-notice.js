'use strict';

// src/shell-update-notice.js — M5 (windows-perf audit 2026-09-24).
//
// The shell self-update pipeline (electron-updater, main.js initAutoUpdater)
// answered every failure with ONE log line — `autoUpdater.on('error', e =>
// log(...))` — and there was no other surface: the settings page promises
// 「结果将通过系统通知告知」 and the only affordances are the tray menu item and
// the settings button. So a blocked download / failed check was invisible to
// the user, and the blocked-download case is exactly what an unsigned exe
// downloading itself runs into (audit §4.2 / §4.4).
//
// This module owns ONLY the decision "does this update event become a user
// -visible notification, and with which wording". It builds no new mechanism:
// the caller passes the existing notify() sink (the R6 notification hub → OS
// toast + searchable history) and the existing i18n helper. The rules:
//   - a MANUAL check (tray 「检查壳更新」 / settings 「立即检查壳更新」) always
//     answers: failure → "壳更新失败" with the reason and the retry hint;
//     no update → "已是最新版本"
//   - an AUTOMATIC check (boot + every 4h) stays in the log unless an update we
//     already found is failing (a download/install error the user expects to
//     succeed) — an offline background check must not toast
//   - at most ONE notice per NOTICE_GAP_MS for automatic failures; manual ones
//     are never rate-limited (the user is looking at the button)
//
// createShellUpdateNotifier({ notify, t, lang, now, log, version }) returns
// { beginCheck, endCheck, onAvailable, onDownloaded, onNotAvailable, onError }.
// The event methods return a small decision record so tests can assert the
// policy without an Electron/updater harness.

const NOTICE_GAP_MS = 10 * 60_000;

function createShellUpdateNotifier({
  notify,
  t,
  lang,
  now = () => Date.now(),
  log = () => {},
  version = () => '',
  gapMs = NOTICE_GAP_MS,
} = {}) {
  if (typeof notify !== 'function') throw new TypeError('createShellUpdateNotifier requires notify()');
  if (typeof t !== 'function' || typeof lang !== 'function') {
    throw new TypeError('createShellUpdateNotifier requires t() and lang()');
  }
  let userInitiated = false;
  let downloading = false;
  let lastNotifiedAt = null; // no automatic notice has gone out yet

  return {
    /** A check is starting: `manual` = tray/settings, not the periodic one. */
    beginCheck(manual) {
      userInitiated = !!manual;
      downloading = false;
    },
    /** The check settled (the 'error'/'update-not-available' event wins first). */
    endCheck() {
      userInitiated = false;
    },
    /** update-available: autoDownload=true means the download starts now. */
    onAvailable(info) {
      downloading = true;
      return { notified: false, download: true, version: info && info.version ? info.version : '' };
    },
    onDownloaded(info) {
      downloading = false;
      return { notified: false, download: false, version: info && info.version ? info.version : '' };
    },
    /** update-not-available: only a manual check gets an answer. */
    onNotAvailable() {
      downloading = false;
      if (!userInitiated) return { notified: false, reason: 'up-to-date-auto' };
      const L = lang();
      notify(t(L, 'notify.shellUpToDate'), t(L, 'notify.shellUpToDateBody', { v: version() }));
      return { notified: true, reason: 'up-to-date' };
    },
    /**
     * The updater's 'error' event (or a rejected checkForUpdates()). Returns
     * whether a notice was shown; the log line is written either way.
     */
    onError(err) {
      const msg = String((err && err.message) || err || 'unknown error');
      const wasDownloading = downloading;
      downloading = false;
      const manual = userInitiated;
      if (!manual && !wasDownloading) {
        log(`[shell] updater: failure logged only (automatic check, no download in flight): ${msg}`);
        return { notified: false, reason: 'silent-auto-check', download: false };
      }
      if (!manual && lastNotifiedAt !== null && now() - lastNotifiedAt < gapMs) {
        log(`[shell] updater: failure notice suppressed (within ${Math.round(gapMs / 60000)}min window): ${msg}`);
        return { notified: false, reason: 'rate-limited', download: true };
      }
      lastNotifiedAt = now();
      const downloadFailure = wasDownloading && !manual;
      const L = lang();
      const titleKey = downloadFailure ? 'notify.shellUpdateDownloadFailed' : 'notify.shellUpdateFailed';
      const bodyKey = downloadFailure ? 'notify.shellUpdateDownloadFailedBody' : 'notify.shellUpdateFailedBody';
      notify(t(L, titleKey), t(L, bodyKey, { msg }));
      log(`[shell] updater: failure surfaced to the user (${titleKey}): ${msg}`);
      return { notified: true, reason: downloadFailure ? 'download-failed' : 'failed', download: downloadFailure };
    },
  };
}

module.exports = { createShellUpdateNotifier, NOTICE_GAP_MS };
