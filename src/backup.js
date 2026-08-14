// src/backup.js — session/history backup (belt and suspenders on top of dsh's
// durable JSONL append log). Backs up sessions/ + settings.yaml into
// userData/backups/<timestamp>/, pruning to `keep` newest copies.
//
// Credentials (.credentials.yaml) are intentionally NOT backed up: plaintext
// copies of API keys are a liability; OS-keychain integration is planned.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INCLUDED_KEYS = ['sessions', 'settings.yaml'];

/**
 * Copy DSH_HOME session/history files into backupDir and prune old copies.
 * @returns {string} the backup directory that was written.
 */
function backupNow({ dshHome, backupDir, keep = 5, log }) {
  const logLine = log || (() => {});
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, stamp);
  for (const key of INCLUDED_KEYS) {
    const src = path.join(dshHome, key);
    if (fs.existsSync(src)) {
      try {
        fs.cpSync(src, path.join(dest, key), { recursive: true });
      } catch (err) {
        logLine(`[backup] copy ${key} failed: ${err.message}`);
      }
    }
  }
  // prune to keep
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupDir)
      .filter((n) => { try { return fs.statSync(path.join(backupDir, n)).isDirectory(); } catch { return false; } })
      .sort();
  } catch { /* ignore */ }
  while (dirs.length > keep) {
    const old = dirs.shift();
    try { fs.rmSync(path.join(backupDir, old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  logLine(`[backup] wrote ${dest} (kept ${keep} copies in ${backupDir})`);
  return dest;
}

/** Summarize what's in the backup dir for the settings UI. */
function backupInfo(backupDir) {
  let count = 0;
  let latest = null;
  let sizeMB = 0;
  try {
    const dirs = fs.readdirSync(backupDir)
      .filter((n) => { try { return fs.statSync(path.join(backupDir, n)).isDirectory(); } catch { return false; } })
      .sort();
    count = dirs.length;
    if (dirs.length) {
      latest = dirs[dirs.length - 1];
      const latestPath = path.join(backupDir, latest);
      sizeMB = Math.round((fs.readdirSync(latestPath, { recursive: true }).reduce((acc, f) => {
        try { return acc + fs.statSync(path.join(latestPath, f)).size; } catch { return acc; }
      }, 0) / 1e6) * 10) / 10;
    }
  } catch { /* ignore */ }
  return { dir: backupDir, count, latest, sizeMB };
}

module.exports = { backupNow, backupInfo };
