// src/crash-reason.js — H5 startup-failure root-cause detection (pure text
// analysis, no Electron). Scans the tail of the runtime log for the known
// signature of the 0.1.0 → 0.1.1 credential-format break: a runtime that only
// understands the flat .credentials.yaml choking on the v1 (version+refs)
// nested layout. Deliberately conservative — every rule requires credential
// context so an unrelated crash never triggers the upgrade dialog.
'use strict';

const fs = require('node:fs');

/** How much of the log tail to inspect (crashes print the error last). */
const TAIL_CHARS = 16_000;

/**
 * True when the log text matches the credential-format-mismatch signature:
 *   - a YAML type rejection ("must be a string") in the credentials loader,
 *   - the upstream "pre-release flat layout" message emitted by NEW runtimes
 *     reading legacy files, or
 *   - a .credentials.yaml reference together with the v1 layout keywords.
 */
function detectCredentialFormatMismatch(text) {
  const s = String(text || '');
  if (!s) return false;
  if (/pre-release\s+flat\s+layout/i.test(s)) return true;
  const credCtx = /\.credentials\.yaml|credential/i.test(s);
  if (!credCtx) return false;
  if (/must be a string/i.test(s)) return true;
  if (/\brefs\b/i.test(s) && /\bversion\b/i.test(s)) return true;
  return false;
}

/** Read the last TAIL_CHARS characters of a log file; null when unreadable. */
function readLogTail(logPath) {
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_CHARS);
      const len = size - start;
      if (len <= 0) return '';
      const buf = Buffer.alloc(len);
      // fs.readSync returns the byte COUNT (a number). Destructuring it (the
      // v0.2.8 incident) yields undefined → NaN offsets / wrong slices. Both
      // known return shapes are normalized here.
      const ret = fs.readSync(fd, buf, 0, len, start);
      const bytesRead = typeof ret === 'number' ? ret : ((ret && Number.isFinite(ret.bytesRead)) ? ret.bytesRead : 0);
      if (!(bytesRead > 0)) return '';
      return buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

module.exports = { detectCredentialFormatMismatch, readLogTail, TAIL_CHARS };
