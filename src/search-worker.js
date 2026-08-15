// src/search-worker.js — worker thread for session log search.
//
// Why a worker? On Windows, zstd logs are MB-sized and fzstd.decompress is a
// synchronous, CPU-bound pure-JS call. Running it on the Electron main
// thread blocks all IPC (input, settings, dialog…) for hundreds of ms per
// file, which is exactly the "未响应" jank users hit on Ctrl+K. Moving
// decode + toLowerCase + indexOf + split off the main thread eliminates the
// stall completely; the main thread only does async directory listing and
// result aggregation.
//
// Protocol (postMessage):
//   in : { id, files: string[], query: string, limit: number }
//   out: { id, results: Array<{ file, id, cwd, mtimeMs, snippet, matchCount }> }
// On any per-file error the file is skipped; the worker never throws.
'use strict';

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { decompress } = require('fzstd');

function snippetAround(text, idx, radius = 90) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

function decode(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.jsonl.zstd')) {
    try {
      return Buffer.from(decompress(new Uint8Array(buf))).toString('utf8');
    } catch {
      return null; // zstd frame error (log mid-write) -> skip
    }
  }
  return buf.toString('utf8');
}

parentPort.on('message', (msg) => {
  const { id, files, query, limit } = msg;
  const q = String(query || '').trim().toLowerCase();
  const results = [];
  if (q) {
    for (const file of files) {
      try {
        const text = decode(file);
        if (text === null) continue;
        const lower = text.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx === -1) continue;
        const count = lower.split(q).length - 1;
        let cwd = '';
        let sessId = '';
        const firstNl = text.indexOf('\n');
        try {
          const meta = JSON.parse(firstNl === -1 ? text : text.slice(0, firstNl));
          if (typeof meta.cwd === 'string') cwd = meta.cwd;
          if (typeof meta.id === 'string') sessId = meta.id;
        } catch { /* ignore */ }
        let st;
        try { st = fs.statSync(file); } catch { st = { mtimeMs: 0 }; }
        results.push({
          file, id: sessId, cwd, mtimeMs: st.mtimeMs,
          snippet: snippetAround(text, idx),
          matchCount: count,
        });
        if (results.length >= limit) break;
      } catch { /* skip file */ }
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
  parentPort.postMessage({ id, results });
});
