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
// createOfficeProtocolHandler({ officeRoot, officeAssetsRoot,
//   charactersRoot, nodeModulesRoot, layoutStore }) returns the handler.
// layoutStore is the office state store OR a () => store factory — the
// factory form is resolved PER REQUEST so the cockpit keeps its lazy store
// initialization (the store is never touched before the first layout
// request). The scheme stays fixed to office-runtime.

const path = require('node:path');
const fs = require('node:fs');

const OFFICE_RUNTIME_SCHEME = 'office-runtime';

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
  return (request) => {
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
      const abs = path.resolve(route.root, relPath);
      if (!abs.startsWith(path.resolve(route.root) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return new Response('not found', { status: 404 });
      }
      return new Response(fs.readFileSync(abs), {
        headers: { 'content-type': contentTypeFor(abs), 'access-control-allow-origin': `${OFFICE_RUNTIME_SCHEME}://local` },
      });
    }
    return new Response('not found', { status: 404 });
  };
}

module.exports = { createOfficeProtocolHandler };
