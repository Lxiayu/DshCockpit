// src/backup.js — session/history backup (belt and suspenders on top of dsh's
// durable JSONL append log). Backs up sessions/ + settings.yaml into
// userData/backups/<timestamp>/, pruning to `keep` newest copies.
//
// Credentials (.credentials.yaml) are intentionally NOT backed up: plaintext
// copies of API keys are a liability; OS-keychain integration is planned.
//
// Windows+AV P1 (audit §3): the quit-time backup used to be a full `cpSync`
// of the whole session tree ON THE QUIT PATH — the main thread blocked on
// per-file content copies while the AV filter scanned every byte = "the app
// won't quit". backupDeltaNow() replaces it: an index.json in each backup
// records the source (size, mtimeMs) at backup time, and the quit path
// compares metadata only and copies the few changed files into the newest
// backup. Unchanged files are never re-read, so a quit is bounded by the
// delta; the union of the base copy + deltas is still a complete backup
// (proven by the integrity regression test). Files deleted in the source are
// retained in the backup — it is a backup, it never deletes.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const INCLUDED_KEYS = ['sessions', 'settings.yaml'];
const INDEX_FILE = 'index.json';

/** Relative POSIX path of every regular file under the included keys,
 * with { size, mtimeMs } per file (metadata only — no content reads). */
function scanSource(dshHome) {
  const files = {};
  for (const key of INCLUDED_KEYS) {
    const src = path.join(dshHome, key);
    let st;
    try { st = fs.statSync(src); } catch { continue; }
    if (st.isFile()) {
      files[key] = { size: st.size, mtimeMs: st.mtimeMs };
      continue;
    }
    if (!st.isDirectory()) continue;
    const walk = (dir, prefix) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue; // probe/temp files never backed up
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs, `${prefix}/${e.name}`);
        else if (e.isFile()) {
          try {
            const s = fs.statSync(abs);
            files[`${prefix}/${e.name}`] = { size: s.size, mtimeMs: s.mtimeMs };
          } catch { /* raced a delete */ }
        }
        // symlinks/others: skipped (dsh session trees are plain files)
      }
    };
    walk(src, key);
  }
  return files;
}

function writeIndex(dest, files) {
  fs.writeFileSync(
    path.join(dest, INDEX_FILE),
    JSON.stringify({ v: 1, at: new Date().toISOString(), files }, null, 2),
  );
}

function readIndex(dest) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dest, INDEX_FILE), 'utf8'));
    return parsed && parsed.v === 1 && parsed.files && typeof parsed.files === 'object' ? parsed : null;
  } catch { return null; }
}

/** Newest timestamped copy (sorted dir names), or null. */
function latestBackup(backupDir) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupDir)
      .filter((n) => { try { return fs.statSync(path.join(backupDir, n)).isDirectory(); } catch { return false; } })
      .sort();
  } catch { return null; }
  return dirs.length ? path.join(backupDir, dirs[dirs.length - 1]) : null;
}

function pruneOld(backupDir, keep, logLine) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupDir)
      .filter((n) => { try { return fs.statSync(path.join(backupDir, n)).isDirectory(); } catch { return false; } })
      .sort();
  } catch { return; }
  while (dirs.length > keep) {
    const old = dirs.shift();
    try { fs.rmSync(path.join(backupDir, old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  logLine(`[backup] pruned to ${keep} newest in ${backupDir}`);
}

/**
 * Copy DSH_HOME session/history files into backupDir and prune old copies.
 * Writes index.json (source snapshot) so backupDeltaNow can do an incremental
 * pass next time.
 * @returns {string} the backup directory that was written.
 */
function backupNow({ dshHome, backupDir, keep = 5, log }) {
  const logLine = log || (() => {});
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, stamp);
  const files = scanSource(dshHome);
  for (const rel of Object.keys(files)) {
    const src = path.join(dshHome, ...rel.split('/'));
    const target = path.join(dest, ...rel.split('/'));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    } catch (err) {
      logLine(`[backup] copy ${rel} failed: ${err.message}`);
    }
  }
  writeIndex(dest, files);
  pruneOld(backupDir, keep, logLine);
  logLine(`[backup] wrote ${dest} (kept ${keep} copies in ${backupDir})`);
  return dest;
}

/**
 * Incremental backup for the QUIT path (Windows+AV P1): metadata-only walk,
 * copies only files that changed since the newest backup, into that newest
 * backup, then refreshes its index. Falls back to a full backupNow when no
 * backup exists yet or the newest one predates index.json (one-time cost).
 * @returns {{ dest: string, mode: 'delta'|'full', copied: number, scanned: number }}
 */
function backupDeltaNow({ dshHome, backupDir, keep = 5, log }) {
  const logLine = log || (() => {});
  fs.mkdirSync(backupDir, { recursive: true });
  const latest = latestBackup(backupDir);
  const index = latest ? readIndex(latest) : null;
  if (!latest || !index) {
    const dest = backupNow({ dshHome, backupDir, keep, log: logLine });
    return { dest, mode: 'full', copied: -1, scanned: -1 };
  }
  const files = scanSource(dshHome);
  let copied = 0;
  for (const [rel, meta] of Object.entries(files)) {
    const prev = index.files[rel];
    if (prev && prev.size === meta.size && prev.mtimeMs === meta.mtimeMs) continue; // unchanged
    const src = path.join(dshHome, ...rel.split('/'));
    const target = path.join(latest, ...rel.split('/'));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
      copied += 1;
    } catch (err) {
      logLine(`[backup] copy ${rel} failed: ${err.message}`);
    }
  }
  writeIndex(latest, files); // index reflects the current source snapshot
  pruneOld(backupDir, keep, logLine);
  logLine(`[backup] incremental into ${latest} (${copied} file(s) copied, ${Object.keys(files).length} scanned)`);
  return { dest: latest, mode: 'delta', copied, scanned: Object.keys(files).length };
}

/** Summarize what's in the backup dir for the settings UI.
 *  Async: the latest copy's size walk used readdirSync+statSync per file,
 *  which pins the Electron main thread under Windows+AV — same sync-I/O trap
 *  as the old token/stat walkers. fsp keeps it off the hot path. index.json
 *  (bookkeeping, not backed-up data) is excluded from the size. */
async function backupInfo(backupDir) {
  let count = 0;
  let latest = null;
  let sizeMB = 0;
  try {
    const dirs = await fsp.readdir(backupDir);
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
          if (f === INDEX_FILE || f.endsWith(`/${INDEX_FILE}`) || f.endsWith(`\\${INDEX_FILE}`)) continue;
          try { total += (await fsp.stat(path.join(latestPath, f))).size; } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      sizeMB = Math.round((total / 1e6) * 10) / 10;
    }
  } catch { /* absent dir */ }
  return { dir: backupDir, count, latest, sizeMB };
}

module.exports = { backupNow, backupDeltaNow, backupInfo, INCLUDED_KEYS, INDEX_FILE };
