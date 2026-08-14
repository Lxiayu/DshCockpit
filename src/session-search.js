// src/session-search.js — full-text search over session logs.
//
// v1: substring search over decoded session text (case-insensitive), cached by
// (size, mtime). Results carry a snippet around the first match and the
// session's cwd/date. A future version can switch to an FTS index.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { decodeSessionLog } = require('./token-stats');

const cache = new Map(); // path -> { size, mtimeMs, text }

function sessionFiles(root) {
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
      for (const suffix of ['.jsonl.zstd', '.jsonl']) {
        const f = path.join(projDir, ses.name, `session${suffix}`);
        if (fs.existsSync(f)) { out.push(f); break; }
      }
    }
  }
  return out;
}

/** Pull text out of a message event's blocks/content (best effort). */
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

function snippetAround(text, idx, radius = 90) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
}

/**
 * Search all sessions for `query` (case-insensitive substring).
 * @param {string} dshHome
 * @param {string} query
 * @param {number} limit
 * @returns {Array<{ file, id, cwd, mtimeMs, snippet, matchCount }>}
 */
function searchSessions(dshHome, query, limit = 20) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const root = path.join(dshHome, 'sessions');
  const results = [];
  for (const file of sessionFiles(root)) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    let hit = cache.get(file);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
      const text = decodeSessionLog(file);
      if (text === null) continue;
      hit = { size: st.size, mtimeMs: st.mtimeMs, text };
    if (cache.size > 50) { // cap the cache, drop the oldest
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(file, hit);
    }
    // search only message-event text
    const lowerText = hit.text.toLowerCase();
    const idx = lowerText.indexOf(q);
    if (idx === -1) continue;
    const count = lowerText.split(q).length - 1; // O(n), avoids quadratic counting
    let cwd = '';
    let id = '';
    const firstNl = hit.text.indexOf('\n');
    try {
      const meta = JSON.parse(firstNl === -1 ? hit.text : hit.text.slice(0, firstNl));
      if (typeof meta.cwd === 'string') cwd = meta.cwd;
      if (typeof meta.id === 'string') id = meta.id;
    } catch { /* ignore */ }
    results.push({
      file,
      id,
      cwd,
      mtimeMs: st.mtimeMs,
      snippet: snippetAround(hit.text, idx),
      matchCount: count,
    });
    if (results.length >= limit) break;
  }
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

module.exports = { searchSessions, extractText };
