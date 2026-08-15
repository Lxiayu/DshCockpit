// src/session-search.js — full-text search over session logs.
//
// The heavy work (zstd decompress + toLowerCase + indexOf + split) runs in a
// worker thread (search-worker.js) so the Electron main thread is never
// pinned by MB-sized zstd logs. A fresh worker is spawned per query and
// terminated when done — the ~30ms spawn cost is negligible next to the
// 600ms input debounce, and it means no long-lived thread keeps tests
// (or shutdown) hanging.
'use strict';

const { Worker } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function sessionFilesAsync(root) {
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
 * Search all sessions for `query` (case-insensitive substring). The heavy
 * work runs in a worker thread — the main thread is never blocked.
 * @param {string} dshHome
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<{ file, id, cwd, mtimeMs, snippet, matchCount }>>}
 */
async function searchSessions(dshHome, query, limit = 20) {
  const q = String(query || '').trim();
  if (!q) return [];
  const root = path.join(dshHome, 'sessions');
  const files = await sessionFilesAsync(root);
  if (files.length === 0) return [];
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'search-worker.js'));
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
      w.terminate().catch(() => {});
    };
    w.on('message', ({ results }) => done(resolve, results || []));
    w.on('error', (err) => done(reject, err));
    w.postMessage({ id: 1, files, query: q, limit });
  });
}

/** Pull text out of a message event's blocks/content (best effort; for tests). */
function extractText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (!/message$/.test(String(ev.type))) return '';
  const data = ev.data;
  if (!data || typeof data !== 'object') return '';
  const source = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data.content) ? data.content : null;
  if (!source) return '';
  const parts = [];
  const walk = (node, depth) => {
    if (depth > 6 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    if (typeof node.text === 'string') parts.push(node.text);
    if (typeof node.arguments === 'string') parts.push(node.arguments);
    if (typeof node.name === 'string' && node.type === 'tool-call') parts.push(node.name);
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(source, 0);
  return parts.join(' ');
}

module.exports = { searchSessions, extractText };
