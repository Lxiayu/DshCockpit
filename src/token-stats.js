// src/token-stats.js — read token usage out of the session logs.
//
// Sessions live at <DSH_HOME>/sessions/<project-dir>/<session-id>/session.jsonl[.zstd]
// (dsh-session-persistence-jsonl layout). Provider-reported usage rides
// `assistant/message` events as `data.usage = { inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens }` (also `assistant/chunk` usage chunks).
//
// The web UI already shows a stats strip; this module gives the shell its own
// widget source of truth. Zstd logs are decompressed with fzstd (pure JS).
//
// Performance notes (win-jank fix):
//   - collect() is fully async and uses fs.promises everywhere — no
//     readFileSync/statSync on the hot path. The Electron main thread is
//     never pinned by token polling.
//   - parseSessionLogAsync() reads via fsp.readFile (non-blocking).
//   - Active sessions grow on every tick (cache miss → full re-read). To
//     keep polling cheap on MB-sized active logs, we read the file and
//     parse line-by-line via indexOf (no text.split('\n') giant array).
//   - statSync is gone from the poll path; only the session-search path
//     (user-triggered) still uses the sync walker/decode for simplicity.
//   - parseCache keyed by (size, mtimeMs); capped at 100 entries.
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { decompress } = require('fzstd');

const ZSTD = '.jsonl.zstd';
const PLAIN = '.jsonl';

// path -> { size, mtimeMs, result }  (result carries totals + meta + mtimeMs)
const parseCache = new Map();

function isEmptyTotals(r) {
  return r.input === 0 && r.output === 0 && r.cacheRead === 0 && r.cacheWrite === 0;
}

/** Parse the session header line (first JSON line) for meta (id, cwd, …). */
function parseHeader(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  try {
    const meta = JSON.parse(first);
    return { id: typeof meta.id === 'string' ? meta.id : undefined, cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined };
  } catch { return {}; }
}

/** Sum usage buckets over every event line of a decoded session log. */
function sumUsage(text) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  let lines = 0;
  let start = 0;
  // Walk line-by-line via indexOf instead of text.split('\n') — avoids
  // allocating a huge array for MB-sized session logs.
  while (start <= text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(start, end);
    start = end + 1;
    if (line.length === 0) {
      if (nl === -1) break;
      continue;
    }
    lines += 1;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    let usage = null;
    if (ev && ev.type === 'assistant/message' && ev.data && ev.data.usage) usage = ev.data.usage;
    else if (ev && ev.type === 'assistant/chunk' && ev.data && ev.data.chunk && ev.data.chunk.type === 'usage') usage = ev.data.chunk.usage;
    if (!usage) continue;
    input += usage.inputTokens || 0;
    output += usage.outputTokens || 0;
    cacheRead += usage.cacheReadTokens || 0;
    cacheWrite += usage.cacheWriteTokens || 0;
    if (nl === -1) break;
  }
  return { input, output, cacheRead, cacheWrite, lines };
}

/** Decode a session log file to text; null on failure. Used by session-search. */
function decodeSessionLog(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith(ZSTD)) {
    try {
      return Buffer.from(decompress(new Uint8Array(buf))).toString('utf8');
    } catch {
      return null; // zstd frame errors (e.g. log mid-write) -> skip this poll
    }
  }
  return buf.toString('utf8');
}

/** Async decode: read file without blocking the main thread. */
async function decodeSessionLogAsync(file) {
  const buf = await fsp.readFile(file);
  if (file.endsWith(ZSTD)) {
    try {
      return Buffer.from(decompress(new Uint8Array(buf))).toString('utf8');
    } catch {
      return null; // zstd frame errors (e.g. log mid-write) -> skip this poll
    }
  }
  return buf.toString('utf8');
}

/**
 * Parse one session log; cached by (size, mtimeMs). Async + non-blocking.
 * Returns {totals, meta, mtimeMs} or null.
 */
async function parseSessionLogAsync(file) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const hit = parseCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const text = await decodeSessionLogAsync(file);
  const result = text === null ? null : { totals: sumUsage(text), meta: parseHeader(text), mtimeMs: st.mtimeMs };
  if (result !== null) {
    if (parseCache.size > 100) { // cap the cache, drop the oldest
      const first = parseCache.keys().next().value;
      if (first !== undefined) parseCache.delete(first);
    }
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  }
  return result;
}

/** Sync walker — kept for session-search which is invoked from a user action. */
function walkSessionFiles(root) {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let sessions;
    try { sessions = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const ses of sessions) {
      if (!ses.isDirectory()) continue;
      const sesDir = path.join(projDir, ses.name);
      let found = null;
      try {
        const files = fs.readdirSync(sesDir);
        for (const n of files) {
          if (n === 'session.jsonl.zstd') { found = path.join(sesDir, n); break; }
          if (n === 'session.jsonl') { found = path.join(sesDir, n); }
        }
      } catch { /* ignore */ }
      if (found) out.push(found);
    }
  }
  return out;
}

/** Async walker — used by collect() so the main thread is not blocked on IO. */
async function walkSessionFilesAsync(root) {
  const out = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let sessions;
    try { sessions = await fsp.readdir(projDir, { withFileTypes: true }); } catch { continue; }
    for (const ses of sessions) {
      if (!ses.isDirectory()) continue;
      const sesDir = path.join(projDir, ses.name);
      let files;
      try { files = await fsp.readdir(sesDir); } catch { continue; }
      let found = null;
      for (const n of files) {
        if (n === 'session.jsonl.zstd') { found = path.join(sesDir, n); break; }
        if (n === 'session.jsonl') { found = path.join(sesDir, n); }
      }
      if (found) out.push(found);
    }
  }
  return out;
}

/**
 * Collect token usage across all sessions (fully async; never blocks main thread).
 * @param {string} dshHome
 * @returns {Promise<{ current: Totals|null, totals: Totals, sessionCount: number, sessions: Array }>}
 */
async function collect(dshHome) {
  const root = path.join(dshHome, 'sessions');
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const sessions = [];
  let sessionCount = 0;
  let current = null;
  let latestMtime = 0;
  const files = await walkSessionFilesAsync(root);
  for (const file of files) {
    const r = await parseSessionLogAsync(file);
    if (!r) continue;
    const usage = r.totals;
    sessionCount += 1;
    totals.input += usage.input; totals.output += usage.output;
    totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
    const mtimeMs = r.mtimeMs || 0;
    sessions.push({ file, cwd: r.meta.cwd, usage, mtimeMs });
    if (mtimeMs > latestMtime) { latestMtime = mtimeMs; current = usage; }
    // Yield between files so a large sessions tree can't pin the main thread.
    // (parseSessionLogAsync already uses fsp so each file is non-blocking, but
    // the yield keeps IPC responsive when there are many sessions.)
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { current, totals, sessionCount, sessions };
}

/** Format a token count compactly: 1234 -> "1.2k", 1234567 -> "1.2M". */
function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

module.exports = { collect, fmt, isEmptyTotals, decodeSessionLog, parseSessionLogAsync, walkSessionFiles };
