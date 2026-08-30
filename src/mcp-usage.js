// src/mcp-usage.js — MCP usage observability (T1, v0.3.1). UNIQUE capability.
//
// DSH session logs record every tool invocation as `mcp__<server>__<tool>`.
// Scanning them yields per-server call counts and top tools — something none
// of the mainstream clients (Claude / Codex / VS Code) surface. This module
// runs INSIDE the session worker (never on the Electron main thread) and
// reuses the incremental (size, mtime) parse-cache pattern from token-stats:
// only grown plain-JSONL files are re-read, and only their new bytes.
//
// Performance contract (dual-platform review):
//   - raw-line regex first; JSON.parse only on the rare lines that match
//   - files capped (most recent N by mtime) and an overall byte ceiling per
//     run so a huge history cannot turn one settings-page visit into minutes
//   - zero synchronous fs on the main process path
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const MCP_RE = /\bmcp__([a-z0-9][a-z0-9-]{0,63})__([A-Za-z0-9_-]{1,64})\b/g;
const TIME_KEYS = ['timestamp', 'ts', 'time', 'createdAt'];
const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const parseCache = new Map(); // file → { size, mtimeMs, offset, perServer }

function emptyStats() {
  return { servers: {}, lastMs: 0, capped: false };
}

function bump(stats, serverName, toolName, ms) {
  let s = stats.servers[serverName];
  if (!s) { s = { toolCalls: 0, tools: {}, lastMs: 0 }; stats.servers[serverName] = s; }
  s.toolCalls += 1;
  s.tools[toolName] = (s.tools[toolName] || 0) + 1;
  if (ms && ms > s.lastMs) s.lastMs = ms;
  if (ms && ms > stats.lastMs) stats.lastMs = ms;
}

function extractTime(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of TIME_KEYS) {
    const v = obj[k];
    if (typeof v === 'number' && v > 0) return v < 1e12 ? v * 1000 : v; // s → ms
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
  }
  return 0;
}

/** Scan one raw text chunk; parse JSON only on lines that mention mcp__. */
function scanChunk(text, stats) {
  let start = 0;
  while (start < text.length) {
    let nl = text.indexOf('\n', start);
    if (nl === -1) nl = text.length;
    const line = text.slice(start, nl);
    start = nl + 1;
    if (!line.includes('mcp__')) continue;
    MCP_RE.lastIndex = 0;
    let matched = false;
    let m;
    while ((m = MCP_RE.exec(line)) !== null) {
      matched = true;
      let ms = 0;
      try { ms = extractTime(JSON.parse(line)); } catch { /* partial / non-json line */ }
      bump(stats, m[1], m[2], ms);
    }
    if (!matched) bump(stats, 'unknown', 'unknown', 0);
  }
}

function mergeInto(target, source) {
  for (const [k, v] of Object.entries(source.servers)) {
    let cur = target.servers[k];
    if (!cur) { cur = { toolCalls: 0, tools: {}, lastMs: 0 }; target.servers[k] = cur; }
    cur.toolCalls += v.toolCalls;
    cur.lastMs = Math.max(cur.lastMs, v.lastMs);
    for (const [t, c] of Object.entries(v.tools)) cur.tools[t] = (cur.tools[t] || 0) + c;
  }
  target.lastMs = Math.max(target.lastMs, source.lastMs);
  if (source.capped) target.capped = true;
}

async function scanFile(file, isZstd, decode, stats) {
  let st;
  try { st = await fsp.stat(file); } catch { return; }
  const hit = parseCache.get(file);
  if (isZstd) {
    // zstd logs are fully re-parsed only when they changed (same as token-stats)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { mergeInto(stats, hit.perServer); return; }
    const text = decode ? await decode(file) : null;
    if (text === null) return;
    const fileStats = emptyStats();
    scanChunk(text, fileStats);
    if (parseCache.size > 300) parseCache.delete(parseCache.keys().next().value);
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, offset: null, perServer: fileStats });
    mergeInto(stats, fileStats);
    return;
  }
  // plain JSONL: incremental — read only the grown suffix past the last full line
  if (hit && hit.offset !== null && st.size === hit.size && st.mtimeMs === hit.mtimeMs) {
    mergeInto(stats, hit.perServer);
    return;
  }
  if (hit && hit.offset !== null && st.size > hit.size && st.size - hit.offset <= DEFAULT_MAX_BYTES) {
    try {
      const fh = await fsp.open(file, 'r');
      let merged = null;
      try {
        const grown = st.size - hit.offset;
        const buf = Buffer.alloc(grown);
        await fh.read(buf, 0, grown, hit.offset);
        const text = buf.toString('utf8');
        const lastNl = text.lastIndexOf('\n');
        if (lastNl !== -1) {
          const inc = emptyStats();
          scanChunk(text.slice(0, lastNl + 1), inc);
          if (parseCache.get(file) === hit) { // raced reads: first writer wins
            merged = emptyStats();
            mergeInto(merged, hit.perServer);
            mergeInto(merged, inc);
            parseCache.set(file, {
              size: st.size,
              mtimeMs: st.mtimeMs,
              offset: hit.offset + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'),
              perServer: merged,
            });
          } else {
            merged = null; // another scan advanced the cache — skip our slice
          }
        }
      } finally { await fh.close(); }
      if (merged) { mergeInto(stats, merged); return; }
      if (parseCache.get(file) && parseCache.get(file) !== hit) {
        mergeInto(stats, parseCache.get(file).perServer);
        return;
      }
      // partial-line growth → fall through to a full re-read below
    } catch { /* fall through to full re-read */ }
  }
  // full read (first pass, shrank, or grew past the byte ceiling)
  try {
    const buf = await fsp.readFile(file);
    if (buf.length > DEFAULT_MAX_BYTES) {
      stats.capped = true;
      scanChunk(buf.slice(buf.length - DEFAULT_MAX_BYTES).toString('utf8'), stats);
      return; // tail-scan: do not cache (a later incremental pass would miss data)
    }
    const text = buf.toString('utf8');
    const lastNl = buf.lastIndexOf(0x0a);
    const fileStats = emptyStats();
    scanChunk(lastNl === -1 ? text : text.slice(0, lastNl + 1), fileStats);
    if (parseCache.size > 300) parseCache.delete(parseCache.keys().next().value);
    parseCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, offset: lastNl === -1 ? 0 : lastNl + 1, perServer: fileStats });
    mergeInto(stats, fileStats);
  } catch { /* unreadable — skip */ }
}

/** Walk sessions and build the aggregate. `decode` injects zstd decoding
 * (the worker passes tokenStats.decodeSessionLogAsync). */
async function collect(dshHome, { maxFiles, decode } = {}) {
  const stats = emptyStats();
  const root = path.join(dshHome, 'sessions');
  const files = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return shape(stats, 0, 0); }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(root, proj.name);
    let sessions;
    try { sessions = await fsp.readdir(projDir, { withFileTypes: true }); } catch { continue; }
    for (const ses of sessions) {
      if (!ses.isDirectory()) continue;
      const sesDir = path.join(projDir, ses.name);
      let names;
      try { names = await fsp.readdir(sesDir); } catch { continue; }
      let zstd = null;
      let plain = null;
      for (const n of names) {
        if (n === 'session.jsonl.zstd') { zstd = path.join(sesDir, n); break; }
        if (n === 'session.jsonl') plain = path.join(sesDir, n);
      }
      const file = zstd || plain;
      if (file) files.push({ file, isZstd: !!zstd });
    }
  }
  // most recent first; a hard cap keeps one visit bounded
  const limit = Math.max(1, Math.min(2000, Number(maxFiles) || DEFAULT_MAX_FILES));
  const withMtime = [];
  for (const f of files) {
    try { withMtime.push({ ...f, mtimeMs: (await fsp.stat(f.file)).mtimeMs }); } catch { withMtime.push({ ...f, mtimeMs: 0 }); }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capped = withMtime.slice(0, limit);
  if (files.length > capped.length) stats.capped = true;
  for (const { file, isZstd } of capped) await scanFile(file, isZstd, decode, stats);
  return shape(stats, capped.length, files.length);
}

function shape(stats, scanned, total) {
  const servers = {};
  for (const [name, v] of Object.entries(stats.servers)) {
    if (v.toolCalls <= 0) continue;
    const topTools = Object.entries(v.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tool, count]) => ({ tool, count }));
    servers[name] = { toolCalls: v.toolCalls, lastUsedAt: v.lastMs || null, topTools };
  }
  return { servers, lastUsedAt: stats.lastMs || null, scannedFiles: scanned, totalFiles: total, capped: stats.capped };
}

/** Test hook: reset the incremental cache. */
function resetCache() { parseCache.clear(); }

module.exports = { collect, scanChunk, extractTime, resetCache, MCP_RE, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES };
