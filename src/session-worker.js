'use strict';

// This module is deliberately free of Electron APIs. The Electron main
// process delegates session-log IO, zstd decompression, and JSON scanning here
// so a large history can never block window IPC.
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const tokenStats = require('./token-stats');
const compact = require('./compact');

const compactTextCache = new Map();
// Keep multi-MB decoded logs out of the cache: a giant active session would
// otherwise pin several full decoded copies in worker memory for its lifetime.
const MAX_CACHED_TEXT_LEN = 4 * 1024 * 1024;

async function decodeForCompaction(file) {
  let st;
  try { st = await fs.stat(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = compactTextCache.get(file);
  if (hit && hit.key === key) return hit.text;
  const text = await tokenStats.decodeSessionLogAsync(file);
  if (text !== null && text.length <= MAX_CACHED_TEXT_LEN) {
    if (compactTextCache.size >= 8) compactTextCache.delete(compactTextCache.keys().next().value);
    compactTextCache.set(file, { key, text });
  }
  return text;
}

async function handle(msg) {
  if (msg.op === 'collect') return tokenStats.collect(msg.dshHome, msg.options || {});
  if (msg.op === 'compact') {
    const active = msg.file;
    if (!active) return { records: [], open: null };
    const text = await decodeForCompaction(active);
    return text === null ? { records: [], open: null, unavailable: true } : compact.scanCompactions(text);
  }
  throw new Error(`unknown session worker operation: ${msg.op}`);
}

parentPort.on('message', (msg) => {
  Promise.resolve()
    .then(() => handle(msg))
    .then((result) => parentPort.postMessage({ id: msg.id, ok: true, result }))
    .catch((err) => parentPort.postMessage({ id: msg.id, ok: false, error: String(err && err.message || err) }));
});
