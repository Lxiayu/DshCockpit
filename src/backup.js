// src/backup.js — session/history backup (belt and suspenders on top of dsh's
// durable JSONL append log). Backs up sessions/ + settings.yaml into
// userData/backups/<timestamp>/, pruning to `keep` newest copies.
//
// Credentials (.credentials.yaml) are intentionally NOT backed up: plaintext
// copies of API keys are a liability; OS-keychain integration is planned.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
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

/** Summarize what's in the backup dir for the settings UI.
 *  Async: the latest copy's size walk used readdirSync+statSync per file,
 *  which pins the Electron main thread under Windows+AV — same sync-I/O trap
 *  as the old token/stat walkers. fsp keeps it off the hot path. */
async function backupInfo(backupDir) {
  let count = 0;
  let latest = null;
  let sizeMB = 0;
  let dirs = [];
  try { dirs = await fsp.readdir(backupDir); } catch { return { dir: backupDir, count, latest, sizeMB }; }
  const sub = [];
  for (const n of dirs) {
    try { if ((await fsp.stat(path.join(backupDir, n))).isDirectory()) sub.push(n); } catch { /* ignore */ }
  }
  sub.sort();
  count = sub.length;
  if (sub.length) {
    latest = sub[sub.length - 1];
    const latestPath = path.join(backupDir, latest);
    let total = 0;
    try {
      const files = await fsp.readdir(latestPath, { recursive: true });
      for (const f of files) {
        try { total += (await fsp.stat(path.join(latestPath, f))).size; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    sizeMB = Math.round((total / 1e6) * 10) / 10;
  }
  return { dir: backupDir, count, latest, sizeMB };
}

module.exports = { backupNow, backupInfo };
