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
const { isPeakTime } = require('./cost');

const ZSTD = '.jsonl.zstd';
const PLAIN = '.jsonl';

// path -> { size, mtimeMs, result, offset?, wkey }  (result carries totals +
// meta + mtimeMs; offset is the consumed byte boundary of a plain log —
// everything up to and including its last '\n'; wkey identifies the
// peak/off-peak bucketing the cached result was computed with).
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

/** Sum usage buckets over every event line of a decoded session log.
 * With `windows` (peak hour ranges, Beijing time), each usage event is also
 * bucketed into peak/offPeak by its `time` field (events without a time go
 * to offPeak); without windows both buckets stay zero and totals are
 * identical to the legacy behavior. */
function sumUsage(text, windows) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
  const peak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const offPeak = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const bucketed = !!(windows && windows.length);
  let lines = 0;
  // prompt side of the MOST RECENT usage event (context pressure basis, C3)
  let lastUsage = null;
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
    const ui = usage.inputTokens || 0, uo = usage.outputTokens || 0;
    const ucr = usage.cacheReadTokens || 0, ucw = usage.cacheWriteTokens || 0;
    input += ui; output += uo; cacheRead += ucr; cacheWrite += ucw;
    lastUsage = { input: ui, output: uo, cacheRead: ucr, cacheWrite: ucw };
    if (bucketed) {
      const dst = (typeof ev.time === 'number' && isPeakTime(ev.time, windows)) ? peak : offPeak;
      dst.input += ui; dst.output += uo; dst.cacheRead += ucr; dst.cacheWrite += ucw;
    }
    if (nl === -1) break;
  }
  return { input, output, cacheRead, cacheWrite, lines, peak, offPeak, lastUsage };
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

/** Stable key identifying the bucketing mode a cached result was built with. */
function windowsKey(windows) {
  return windows && windows.length ? JSON.stringify(windows) : '';
}

/** Read `length` bytes starting at `start` without loading the whole file. */
async function readFileRange(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Parse one session log; cached by (size, mtimeMs, bucketing). Async + non-blocking.
 * Plain .jsonl logs that only grew since the last parse are parsed
 * incrementally: only the new bytes are read and the newly completed lines
 * are summed on top of the cached totals (offset always sits just past the
 * last complete '\n', so a mid-write trailing line is picked up next tick).
 * Zstd logs and truncated/rewritten files are fully re-parsed.
 * Returns {totals, meta, mtimeMs} or null.
 */
async function parseSessionLogAsync(file, windows) {
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  const wkey = windowsKey(windows);
  const hit = parseCache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.wkey === wkey) return hit.result;
  const isPlain = !file.endsWith(ZSTD);
  if (isPlain && hit && typeof hit.offset === 'number'
    && st.size > hit.size && st.size > hit.offset && hit.wkey === wkey) {
    try {
      const grown = await readFileRange(file, hit.offset, st.size - hit.offset);
      const lastNl = grown.lastIndexOf('\n');
      if (lastNl === -1) {
        // only a partial line was appended; keep the old result and offset
        const result = { ...hit.result, mtimeMs: st.mtimeMs };
        parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset: hit.offset, wkey });
        return result;
      }
      const fresh = grown.slice(0, lastNl + 1); // complete lines only
      const inc = sumUsage(fresh, windows);
      // P1-1 (concurrent double-count): accumulate onto a SNAPSHOT of the
      // cached totals instead of mutating them in place — collectStats() has
      // several independent callers (5s poll, settings refresh, onTurnEnd,
      // manual refresh) that can both hit this branch during one growth
      // window; two in-place adds of the same new bytes would double-count
      // the session and leave the poisoned totals in the cache until restart.
      const base = hit.result.totals;
      const t = {
        input: base.input + inc.input,
        output: base.output + inc.output,
        cacheRead: base.cacheRead + inc.cacheRead,
        cacheWrite: base.cacheWrite + inc.cacheWrite,
        lines: base.lines + inc.lines,
        lastUsage: inc.lastUsage || base.lastUsage,
        peak: {
          input: (base.peak ? base.peak.input : 0) + inc.peak.input,
          output: (base.peak ? base.peak.output : 0) + inc.peak.output,
          cacheRead: (base.peak ? base.peak.cacheRead : 0) + inc.peak.cacheRead,
          cacheWrite: (base.peak ? base.peak.cacheWrite : 0) + inc.peak.cacheWrite,
        },
        offPeak: {
          input: (base.offPeak ? base.offPeak.input : 0) + inc.offPeak.input,
          output: (base.offPeak ? base.offPeak.output : 0) + inc.offPeak.output,
          cacheRead: (base.offPeak ? base.offPeak.cacheRead : 0) + inc.offPeak.cacheRead,
          cacheWrite: (base.offPeak ? base.offPeak.cacheWrite : 0) + inc.offPeak.cacheWrite,
        },
      };
      // A concurrent parse may have already consumed these bytes and replaced
      // the cache entry while we were reading — abandon our increment and let
      // the catch below fall through to a full re-parse.
      if (parseCache.get(file) !== hit) throw new Error('cache advanced concurrently; full re-parse');
      const result = { totals: t, meta: hit.result.meta, mtimeMs: st.mtimeMs };
      // byte length (not char length) keeps the offset valid for multi-byte logs
      parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset: hit.offset + Buffer.byteLength(fresh, 'utf8'), wkey });
      return result;
    } catch { /* reader raced a rewrite or a concurrent parse; full re-parse below */ }
  }
  let text;
  let offset;
  if (isPlain) {
    const buf = await fsp.readFile(file);
    text = buf.toString('utf8');
    const lastNl = buf.lastIndexOf(0x0a);
    offset = lastNl === -1 ? 0 : lastNl + 1;
  } else {
    text = await decodeSessionLogAsync(file);
    offset = undefined;
  }
  const result = text === null ? null : { totals: sumUsage(text, windows), meta: parseHeader(text), mtimeMs: st.mtimeMs };
  if (result !== null) {
    if (parseCache.size > 100) { // cap the cache, drop the oldest
      const first = parseCache.keys().next().value;
      if (first !== undefined) parseCache.delete(first);
    }
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result, offset, wkey });
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

/** Async walker — used by collect() so the main thread is not blocked on IO.
 * Cached per root for 5s: collect runs every 5s, so a brand-new session
 * shows up within ~10s worst case, and a quiet tick does zero directory IO. */
const WALK_TTL_MS = 5_000;
let walkCache = null; // { root, list, expiresAt }

async function walkSessionFilesAsync(root) {
  if (walkCache && walkCache.root === root && walkCache.expiresAt > Date.now()) return walkCache.list;
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
  walkCache = { root, list: out, expiresAt: Date.now() + WALK_TTL_MS };
  return out;
}

/**
 * Collect token usage across all sessions (fully async; never blocks main thread).
 * @param {string} dshHome
 * @param {{ windows?: Array<[number, number]> }} [opts] — peak windows; when
 *   given, totals and each session's usage also carry peak/offPeak buckets.
 * @returns {Promise<{ current: Totals|null, totals: Totals, sessionCount: number, sessions: Array }>}
 */
async function collect(dshHome, opts) {
  const windows = opts && opts.windows && opts.windows.length ? opts.windows : null;
  const root = path.join(dshHome, 'sessions');
  const totals = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const sessions = [];
  let sessionCount = 0;
  let current = null;
  let latestMtime = 0;
  const files = await walkSessionFilesAsync(root);
  for (const file of files) {
    const r = await parseSessionLogAsync(file, windows);
    if (!r) continue;
    const usage = r.totals;
    sessionCount += 1;
    totals.input += usage.input; totals.output += usage.output;
    totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
    if (usage.peak) {
      totals.peak.input += usage.peak.input || 0; totals.peak.output += usage.peak.output || 0;
      totals.peak.cacheRead += usage.peak.cacheRead || 0; totals.peak.cacheWrite += usage.peak.cacheWrite || 0;
    }
    if (usage.offPeak) {
      totals.offPeak.input += usage.offPeak.input || 0; totals.offPeak.output += usage.offPeak.output || 0;
      totals.offPeak.cacheRead += usage.offPeak.cacheRead || 0; totals.offPeak.cacheWrite += usage.offPeak.cacheWrite || 0;
    }
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

/** Context pressure of a session = the prompt side (input + cacheRead +
 * cacheWrite) of the MOST RECENT provider-reported usage — the size of the
 * last actual request, not the cumulative history. v0.2.4 (C3): the pill
 * previously summed the session's lifetime input, which on long sessions
 * read far above the real context occupancy. */
function pressureOf(usage) {
  const u = usage && usage.lastUsage;
  if (!u) return 0;
  return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
}

module.exports = {
  collect, fmt, isEmptyTotals, decodeSessionLog, decodeSessionLogAsync,
  parseSessionLogAsync, walkSessionFiles, walkSessionFilesAsync, pressureOf,
};
