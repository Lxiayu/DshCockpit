'use strict';

// src/office/office-protocol.js — Task E2d: the office-runtime protocol
// handler, extracted VERBATIM from src/main.js so the cockpit main process
// and the standalone editor launcher (scripts/office-editor.js) share ONE
// routing table. Behaviour contract (locked by the office-boot protocol
// tests and the cockpit ui tests):
// - hostname must be `local`; anything else answers 404
// - office-layout.v1.json is the DYNAMIC route: GET/HEAD read the saved
//   layout through the store (200 / 404 missing / 409 corrupt), PUT
//   validates the schema-v1 envelope (422 invalid, 200 {ok:true} on save,
//   500 store code, 400 unparseable body), DELETE clears (200), anything
//   else is 405. The store responses never echo filesystem paths.
// - everything else resolves through the prefix routes (node_modules/,
//   office-assets/, characters/, then the office root); the resolved path
//   must stay inside its root (traversal guard) and exist as a file.
// - every 2xx answer carries an access-control-allow-origin for the scheme.
//
// 2026-09-24 (M2, windows-perf audit) — ASYNC + BOUNDED RESPONSE CACHE.
// The static routes used to do `existsSync + statSync + readFileSync` on the
// main process for EVERY request: the first office open is ~120 requests /
// ~21.3 MB (108 sprites + pixi.min.js 659 KB + 8 modules), and every one of
// those syscalls passes through the Windows AV filter driver on the browser
// UI thread, so the window could be marked "not responding" (0.5-2.5 s cold
// scan estimated; 27.3 ms warm on macOS for the pure read set). Electron's
// protocol.handle explicitly accepts a Promise<Response> — the local
// electron.d.ts typing says "Either a `Response` or a `Promise<Response>`
// can be returned" (protocol.handle) and the layout route below already
// answers Promises for PUT/DELETE — so the handler is now `async`: the
// syscalls move to the libuv threadpool (`fs/promises`) and never block the
// browser UI thread.
// On top of that, a bounded per-handler LRU keyed by the RESOLVED path caches
// the verified bytes: a hit costs ONE `stat` (mtimeMs + size revalidation)
// and no read at all, so a repeat open / a second view / a resize-triggered
// reload replays the whole sprite set from memory.
// Cache boundaries (deliberate, do not weaken):
// - only the STATIC prefix routes are cacheable; the layout route stays
//   `no-store` and is never cached (it is per-user data under userData)
// - the key is the resolved absolute path, so one handler instance can never
//   serve a path belonging to another root or another user's data dir
// - entries and bytes are both capped (LRU eviction), so the cache is bounded
//   by ~one office asset set and cannot grow with the session count
//
// createOfficeProtocolHandler({ officeRoot, officeAssetsRoot,
//   charactersRoot, nodeModulesRoot, layoutStore }) returns the handler.
// layoutStore is the office state store OR a () => store factory — the
// factory form is resolved PER REQUEST so the cockpit keeps its lazy store
// initialization (the store is never touched before the first layout
// request). The scheme stays fixed to office-runtime.

const path = require('node:path');
const fsp = require('node:fs/promises');

const OFFICE_RUNTIME_SCHEME = 'office-runtime';

// Bounded response cache. 192 entries / 32 MB covers the measured first-open
// set (~120 requests / 21.3 MB) with headroom for a second view's module
// loads, while staying a fixed ceiling regardless of how many times the page
// reloads. Bytes dominate the real memory bound; entries are a second guard.
const CACHE_MAX_ENTRIES = 192;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

function contentTypeFor(abs) {
  if (abs.endsWith('.html')) return 'text/html; charset=utf-8';
  if (abs.endsWith('.css')) return 'text/css; charset=utf-8';
  if (abs.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (abs.endsWith('.json')) return 'application/json; charset=utf-8';
  if (abs.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function createOfficeProtocolHandler({ officeRoot, officeAssetsRoot, charactersRoot, nodeModulesRoot, layoutStore }) {
  const routes = [
    { prefix: 'node_modules/', root: nodeModulesRoot },
    { prefix: 'office-assets/', root: officeAssetsRoot },
    { prefix: 'characters/', root: charactersRoot },
    { prefix: '', root: officeRoot },
  ];
  // Insertion-ordered Map used as an LRU: a hit re-inserts the key, eviction
  // drops the oldest keys until both bounds hold.
  const cache = new Map(); // abs -> { mtimeMs, size, contentType, body }
  let cacheBytes = 0;
  const cacheStats = { hits: 0, misses: 0, evictions: 0 };

  function remember(abs, entry) {
    const existing = cache.get(abs);
    if (existing) {
      cacheBytes -= existing.body.length;
      cache.delete(abs);
    }
    cache.set(abs, entry);
    cacheBytes += entry.body.length;
    while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      const stale = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= stale.body.length;
      cacheStats.evictions += 1;
    }
  }

  const handler = async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    // Task 8: the user-saved production layout (office-layout.v1.json) is
    // served from userData through the store — GET reads, PUT validates the
    // envelope and saves, DELETE clears. The main process stays the ONLY
    // writer; the seven office:* IPC channels remain untouched.
    if (rel === 'office-layout.v1.json') {
      const store = typeof layoutStore === 'function' ? layoutStore() : layoutStore;
      const jsonHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': `${OFFICE_RUNTIME_SCHEME}://local`,
        'cache-control': 'no-store',
      };
      if (request.method === 'GET' || request.method === 'HEAD') {
        const loaded = store.loadSavedLayout();
        if (loaded.ok) return new Response(JSON.stringify(loaded.draft), { headers: jsonHeaders });
        if (loaded.missing) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ ok: false, code: loaded.code }), { status: 409, headers: jsonHeaders });
      }
      if (request.method === 'PUT') {
        return request.text().then((text) => {
          const parsed = JSON.parse(text);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 1) {
            return new Response(JSON.stringify({ ok: false, code: 'OFFICE_LAYOUT_SAVED_INVALID' }), { status: 422, headers: jsonHeaders });
          }
          return store.saveSavedLayout(parsed).then((result) => new Response(
            // Task 8-R1: answer {ok:true} only — never echo the userData path.
            JSON.stringify(result.ok ? { ok: true } : { ok: false, code: result.code }),
            { status: result.ok ? 200 : 500, headers: jsonHeaders }
          ));
        }).catch(() => new Response(JSON.stringify({ ok: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' }), { status: 400, headers: jsonHeaders }));
      }
      if (request.method === 'DELETE') {
        return store.deleteSavedLayout().then(() => new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders }));
      }
      return new Response('method not allowed', { status: 405 });
    }
    for (const route of routes) {
      if (!rel.startsWith(route.prefix)) continue;
      const relPath = rel.slice(route.prefix.length);
      // Traversal guard stays a pure path computation (synchronous, no IO).
      const abs = path.resolve(route.root, relPath);
      if (!abs.startsWith(path.resolve(route.root) + path.sep)) {
        return new Response('not found', { status: 404 });
      }
      const headersFor = (type) => ({
        'content-type': type,
        'access-control-allow-origin': `${OFFICE_RUNTIME_SCHEME}://local`,
      });
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        cache.delete(abs); // a deleted file must not be served from memory
        return new Response('not found', { status: 404 });
      }
      if (!stat.isFile()) return new Response('not found', { status: 404 });
      // Revalidate: mtime + size. A rebuild or in-place edit changes at least
      // one of them; anything else is the same immutable build asset.
      const hit = cache.get(abs);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        cacheStats.hits += 1;
        cache.delete(abs); // LRU touch
        cache.set(abs, hit);
        return new Response(hit.body, { headers: headersFor(hit.contentType) });
      }
      let body;
      try {
        body = await fsp.readFile(abs);
      } catch {
        return new Response('not found', { status: 404 });
      }
      // Cache only when the validator is UNCHANGED across the read. If the
      // file moved under us (a dev rebuild, a re-pack), we still answer these
      // bytes but do NOT pin them: the next request re-reads and the cache
      // self-heals. This is what keeps a stale build asset from ever becoming
      // a permanent cache hit.
      let fresh = stat;
      try { fresh = await fsp.stat(abs); } catch { /* keep the first stat */ }
      const contentType = contentTypeFor(abs);
      cacheStats.misses += 1;
      if (fresh.mtimeMs === stat.mtimeMs && fresh.size === stat.size) {
        remember(abs, { mtimeMs: stat.mtimeMs, size: stat.size, contentType, body });
      }
      return new Response(body, { headers: headersFor(contentType) });
    }
    return new Response('not found', { status: 404 });
  };

  // Observability (no IPC channel): a field probe or a test can read the cache
  // behaviour directly off the handler. `bytes` is the live bound the LRU
  // keeps under CACHE_MAX_BYTES.
  handler.cacheStats = () => ({
    hits: cacheStats.hits,
    misses: cacheStats.misses,
    evictions: cacheStats.evictions,
    entries: cache.size,
    bytes: cacheBytes,
    maxEntries: CACHE_MAX_ENTRIES,
    maxBytes: CACHE_MAX_BYTES,
  });
  return handler;
}

module.exports = { createOfficeProtocolHandler, CACHE_MAX_ENTRIES, CACHE_MAX_BYTES };
