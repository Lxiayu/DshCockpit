// src/token-stats.js — read token usage out of the session logs.
//
// Sessions live at <DSH_HOME>/sessions/<project-dir>/<session-id>/session.jsonl[.zstd]
// (dsh-session-persistence-jsonl layout). Provider-reported usage rides
// `assistant/message` events as `data.usage = { inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens }` (also `assistant/chunk` usage chunks).
//
// The web UI already shows a stats strip; this module gives the shell its own
// widget source of truth. Zstd logs are decompressed with fzstd (pure JS).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decompress } = require('fzstd');

const ZSTD = '.jsonl.zstd';
const PLAIN = '.jsonl';

// path -> { size, mtimeMs, result }
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
  for (const line of text.split('\n')) {
    if (!line) continue;
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
  }
  return { input, output, cacheRead, cacheWrite, lines };
}

function decodeLog(file) {
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

/** Decode a session log file to text; null on failure. Shared with session-search. */
function decodeSessionLog(file) {
  return decodeLog(file);
}

/** Parse one session log; cached by (size, mtimeMs). Returns {totals, meta} or null. */
function parseSessionLog(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = parseCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.result;
  const text = decodeLog(file);
  const result = text === null ? null : { totals: sumUsage(text), meta: parseHeader(text) };
  if (result !== null) {
    if (parseCache.size > 100) { // cap the cache, drop the oldest
      const first = parseCache.keys().next().value;
      if (first !== undefined) parseCache.delete(first);
    }
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
  }
  return result;
}

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
      for (const suffix of [ZSTD, PLAIN]) {
        const f = path.join(projDir, ses.name, `session${suffix}`);
        if (fs.existsSync(f)) { out.push(f); break; }
      }
    }
  }
  return out;
}

/**
 * Collect token usage across all sessions.
 * @param {string} dshHome - the DSH_HOME directory.
 * @returns {{ current: Totals|null, totals: Totals, sessionCount: number, sessions: Array }}
 */
function collect(dshHome) {
  const root = path.join(dshHome, 'sessions');
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const sessions = [];
  let sessionCount = 0;
  let current = null;
  let latestMtime = 0;
  for (const file of walkSessionFiles(root)) {
    const r = parseSessionLog(file);
    if (!r) continue;
    const usage = r.totals;
    sessionCount += 1;
    totals.input += usage.input; totals.output += usage.output;
    totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
    sessions.push({ file, cwd: r.meta.cwd, usage, mtimeMs });
    if (mtimeMs > latestMtime) { latestMtime = mtimeMs; current = usage; }
  }
  return { current, totals, sessionCount, sessions };
}

/** Format a token count compactly: 1234 -> "1.2k", 1234567 -> "1.2M". */
function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

module.exports = { collect, fmt, isEmptyTotals, decodeSessionLog };
