'use strict';

// test/office-boot.test.js — Blocker A / SPEC-07 regression tests.
//
// RED: src/office/office-boot.js does not exist yet.
//
// Contract under test (SPEC-07 fallback chain, Task 9 blocker A): when the
// character pack (manifest/anchors/animations) is missing, unreadable or
// invalid, the office page boot MUST NOT reject into an unusable state.
// loadOfficePack() resolves a boot outcome in every case so the page can set
// an observable ready/diagnostic state, run the renderer in diagnostic
// placeholder mode (renderer fallbackReason PACK_MISSING), and keep the
// details panel, employee list and activity log usable. Stable codes follow
// the SPEC-02 vocabulary: PACK_MISSING, PACK_MANIFEST_INVALID,
// PACK_ASSET_MISSING, plus upstream validator codes passed through.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const boot = require('../src/office/office-boot.js');

const VALID_MANIFEST = { schemaVersion: 1, id: 'pack' };
const VALID_ANCHORS = { schemaVersion: 1 };
const VALID_ANIMATIONS = { schemaVersion: 1, animations: {} };
const FAKE_PACK = { id: 'pack', animations: {} };

function okAssetPack(pack) {
  return ({ manifest, anchors, animations }) => {
    assert.notEqual(manifest, undefined);
    assert.notEqual(anchors, undefined);
    assert.notEqual(animations, undefined);
    return { ok: true, pack };
  };
}

test('happy path: all three JSON documents load and the pack passes through', async () => {
  const calls = [];
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      calls.push(url);
      if (url.endsWith('manifest.json')) return VALID_MANIFEST;
      if (url.endsWith('anchors.json')) return VALID_ANCHORS;
      if (url.endsWith('animations.json')) return VALID_ANIMATIONS;
      throw new Error(`unexpected url ${url}`);
    },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(outcome.pack, FAKE_PACK);
  assert.equal(outcome.code, null);
  assert.equal(outcome.ok, true);
  // The page needs the raw documents for texture preloading.
  assert.deepEqual(outcome.manifest, VALID_MANIFEST);
  assert.deepEqual(outcome.anchors, VALID_ANCHORS);
  assert.deepEqual(outcome.animations, VALID_ANIMATIONS);
});

test('missing manifest (fetch/status failure) resolves PACK_MISSING, never rejects', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      if (url.endsWith('manifest.json')) { const e = new Error('manifest.json: 404'); e.status = 404; throw e; }
      return VALID_ANCHORS;
    },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(outcome.pack, null);
  assert.equal(outcome.code, 'PACK_MISSING');
  assert.equal(outcome.ok, false);
});

test('corrupt manifest (JSON parse error) resolves PACK_MANIFEST_INVALID, never rejects', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      if (url.endsWith('manifest.json')) {
        const e = new SyntaxError('Unexpected token in JSON');
        throw e;
      }
      return VALID_ANCHORS;
    },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(outcome.pack, null);
  assert.equal(outcome.code, 'PACK_MANIFEST_INVALID');
  assert.equal(outcome.ok, false);
});

test('missing anchors document resolves PACK_ASSET_MISSING, never rejects', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      if (url.endsWith('anchors.json')) { const e = new Error('anchors.json: 404'); e.status = 404; throw e; }
      if (url.endsWith('manifest.json')) return VALID_MANIFEST;
      return VALID_ANIMATIONS;
    },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(outcome.pack, null);
  assert.equal(outcome.code, 'PACK_ASSET_MISSING');
  assert.equal(outcome.ok, false);
});

test('corrupt animations document also resolves PACK_ASSET_MISSING', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      if (url.endsWith('animations.json')) throw new SyntaxError('bad json');
      if (url.endsWith('manifest.json')) return VALID_MANIFEST;
      return VALID_ANCHORS;
    },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(outcome.pack, null);
  assert.equal(outcome.code, 'PACK_ASSET_MISSING');
});

test('validator failure passes the upstream SPEC-02 code through unchanged', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      if (url.endsWith('manifest.json')) return VALID_MANIFEST;
      if (url.endsWith('anchors.json')) return VALID_ANCHORS;
      return VALID_ANIMATIONS;
    },
    createAssetPack: () => ({ ok: false, code: 'PACK_GEOMETRY_INVALID' }),
  });
  assert.equal(outcome.pack, null);
  assert.equal(outcome.code, 'PACK_GEOMETRY_INVALID');
  assert.equal(outcome.ok, false);
});

test('outcome is a plain frozen object carrying the coarse diagnostic contract', async () => {
  const outcome = await boot.loadOfficePack({
    loadJson: async () => VALID_MANIFEST,
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(Object.isFrozen(outcome), true);
  for (const key of ['ok', 'pack', 'code']) {
    assert.equal(Object.prototype.hasOwnProperty.call(outcome, key), true, `missing key ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Task 4 — portable pack descriptor (production pack resolution boundary)
// ---------------------------------------------------------------------------

test('loadOfficePack resolves the built-in production pack through a portable descriptor', async () => {
  const calls = [];
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => {
      calls.push(url);
      if (url.endsWith('manifest.json')) return VALID_MANIFEST;
      if (url.endsWith('anchors.json')) return VALID_ANCHORS;
      if (url.endsWith('animations.json')) return VALID_ANIMATIONS;
      throw new Error(`unexpected url ${url}`);
    },
    createAssetPack: okAssetPack(FAKE_PACK),
    packId: 'deepseek-default',
  });
  assert.deepEqual(calls, [
    './characters/deepseek-default/manifest.json',
    './characters/deepseek-default/animation/anchors.json',
    './characters/deepseek-default/animation/animations.json',
  ], 'frame and metadata URLs are relative managed resources, never absolute paths');
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.descriptor, {
    id: 'deepseek-default',
    rootUrl: './characters/deepseek-default/',
    manifestUrl: './characters/deepseek-default/manifest.json',
    anchorsUrl: './characters/deepseek-default/animation/anchors.json',
    animationsUrl: './characters/deepseek-default/animation/animations.json',
  });
});

test('loadOfficePack defaults to the built-in production pack id', async () => {
  const calls = [];
  const outcome = await boot.loadOfficePack({
    loadJson: async (url) => { calls.push(url); if (url.endsWith('manifest.json')) return VALID_MANIFEST; if (url.endsWith('anchors.json')) return VALID_ANCHORS; return VALID_ANIMATIONS; },
    createAssetPack: okAssetPack(FAKE_PACK),
  });
  assert.equal(outcome.descriptor.id, 'deepseek-default');
  assert.equal(outcome.ok, true);
});

test('loadOfficePack rejects unsafe pack ids with a stable code and loads nothing', async () => {
  const loadJson = async () => { throw new Error('must not be called'); };
  for (const packId of ['../etc', 'a/b', '', null, 42, '.\\evil']) {
    const outcome = await boot.loadOfficePack({ loadJson, createAssetPack: okAssetPack(FAKE_PACK), packId });
    assert.equal(outcome.ok, false, `${JSON.stringify(packId)} must be rejected`);
    assert.equal(outcome.code, 'PACK_ID_INVALID');
    assert.equal(outcome.pack, null);
    assert.equal(outcome.descriptor, null);
  }
});

// ---------------------------------------------------------------------------
// Task 8 — production layout draft source priority (saved > built-in > none)
// ---------------------------------------------------------------------------

// Mini schema-v1 validator injected into the resolver: the page passes
// layout-schema.validateDraftSchema (full schema-v1 rules — P5/B-1 moved it
// out of the editor core); the tests pass a controllable probe so priority
// logic is isolated from the catalog.
function fakeValidator(validIds = new Set(['good'])) {
  return (draft) => {
    if (!draft || typeof draft !== 'object' || draft.schemaVersion !== 1) return { ok: false, code: 'DRAFT_SCHEMA_UNSUPPORTED' };
    return validIds.has(draft.id) ? { ok: true, count: 1 } : { ok: false, code: 'DRAFT_ITEM_ASSET_UNKNOWN' };
  };
}

test('resolveProductionLayoutDraft prefers a valid user-saved layout over the built-in draft', () => {
  const saved = { ok: true, draft: { id: 'good', schemaVersion: 1 } };
  const bundled = { ok: true, draft: { id: 'bad', schemaVersion: 1 } };
  const outcome = boot.resolveProductionLayoutDraft({ saved, bundled, validateDraftSchema: fakeValidator() });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'saved');
  assert.equal(outcome.code, null);
  assert.deepEqual(outcome.draft, saved.draft);
});

test('resolveProductionLayoutDraft falls back to the built-in draft when no layout was saved', () => {
  const outcome = boot.resolveProductionLayoutDraft({
    saved: { ok: false, missing: true },
    bundled: { ok: true, draft: { id: 'good', schemaVersion: 1 } },
    validateDraftSchema: fakeValidator(),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'bundled');
  assert.equal(outcome.code, null, 'a missing saved layout is the normal first-run case, never a diagnostic');
  assert.equal(outcome.draft, undefined === outcome.draft ? null : outcome.draft);
  assert.deepEqual(outcome.draft, { id: 'good', schemaVersion: 1 });
});

test('resolveProductionLayoutDraft degrades a present-but-invalid saved layout to the built-in draft with a stable diagnostic', () => {
  for (const saved of [
    { ok: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' },
    { ok: false, code: 'OFFICE_LAYOUT_SAVED_INVALID' },
    { ok: true, draft: { id: 'bad', schemaVersion: 1 } }, // parses, fails schema validation
  ]) {
    const outcome = boot.resolveProductionLayoutDraft({
      saved,
      bundled: { ok: true, draft: { id: 'good', schemaVersion: 1 } },
      validateDraftSchema: fakeValidator(),
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.source, 'bundled', `source falls back for saved=${JSON.stringify(saved)}`);
    assert.equal(outcome.code, 'OFFICE_LAYOUT_SAVED_INVALID', `stable diagnostic for saved=${JSON.stringify(saved)}`);
    assert.deepEqual(outcome.draft, { id: 'good', schemaVersion: 1 });
  }
});

test('resolveProductionLayoutDraft reports OFFICE_LAYOUT_UNAVAILABLE when every source fails', () => {
  const outcome = boot.resolveProductionLayoutDraft({
    saved: { ok: false, missing: true },
    bundled: { ok: false, missing: true },
    validateDraftSchema: fakeValidator(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.draft, null);
  assert.equal(outcome.source, null);
  assert.equal(outcome.code, 'OFFICE_LAYOUT_UNAVAILABLE');
});

test('resolveProductionLayoutDraft keeps the saved-layout diagnostic when even the built-in draft is broken', () => {
  const outcome = boot.resolveProductionLayoutDraft({
    saved: { ok: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' },
    bundled: { ok: true, draft: { id: 'bad', schemaVersion: 1 } },
    validateDraftSchema: fakeValidator(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'OFFICE_LAYOUT_SAVED_INVALID', 'the deeper diagnostic wins over the generic unavailable code');
});

test('resolveProductionLayoutDraft requires a validator and never throws on odd inputs', () => {
  assert.throws(() => boot.resolveProductionLayoutDraft({ saved: null, bundled: null }), /validateDraftSchema/);
  const outcome = boot.resolveProductionLayoutDraft({ saved: null, bundled: null, validateDraftSchema: fakeValidator() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'OFFICE_LAYOUT_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Task 8-R1 — response -> attempt classification: the corrupt-saved-layout
// diagnostics were unreachable from the page because EVERY non-2xx response
// was folded into `missing`. Only a 404 may be `missing`; 409/422/5xx and
// network failures are BROKEN attempts whose stable codes must survive into
// the resolver's page diagnostic.
// ---------------------------------------------------------------------------

test('classifyLayoutAttempt maps a 200 draft response to a valid attempt', () => {
  const draft = { schemaVersion: 1, items: [] };
  assert.deepEqual(
    boot.classifyLayoutAttempt({ status: 200, body: draft }),
    { ok: true, draft, missing: false, code: null }
  );
});

test('classifyLayoutAttempt maps 404 to the missing attempt with NO diagnostic', () => {
  assert.deepEqual(
    boot.classifyLayoutAttempt({ status: 404, body: null }),
    { ok: false, draft: null, missing: true, code: null }
  );
});

test('classifyLayoutAttempt maps 409/422/5xx/network failures to broken attempts carrying stable codes', () => {
  const corrupt = boot.classifyLayoutAttempt({ status: 409, body: { ok: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' } });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.missing, false, 'a corrupt saved file is broken, never missing');
  assert.equal(corrupt.code, 'OFFICE_LAYOUT_SAVED_CORRUPT', 'the transport code survives classification');
  assert.equal(corrupt.draft, null);

  const invalid = boot.classifyLayoutAttempt({ status: 422, body: { ok: false, code: 'OFFICE_LAYOUT_SAVED_INVALID' } });
  assert.equal(invalid.missing, false);
  assert.equal(invalid.code, 'OFFICE_LAYOUT_SAVED_INVALID');

  const serverError = boot.classifyLayoutAttempt({ status: 503, body: null });
  assert.equal(serverError.missing, false);
  assert.equal(serverError.code, 'OFFICE_LAYOUT_SAVED_INVALID', 'a 5xx without a body code falls back to the stable invalid code');

  const network = boot.classifyLayoutAttempt({ status: 0, body: null });
  assert.equal(network.missing, false, 'network failures are broken attempts, not missing files');
  assert.equal(network.code, 'OFFICE_LAYOUT_SAVED_INVALID');
});

test('classifyLayoutAttempt treats a 200 without a JSON body as a broken attempt', () => {
  for (const body of [null, undefined]) {
    const attempt = boot.classifyLayoutAttempt({ status: 200, body });
    assert.equal(attempt.ok, false, `a 200 with body=${String(body)} carries no layout`);
    assert.equal(attempt.missing, false);
    assert.equal(attempt.code, 'OFFICE_LAYOUT_SAVED_INVALID');
  }
});

test('the corrupt saved layout surfaces through the real pipeline: broken attempt yields the page diagnostic', () => {
  // exact Task 8 regression: the page folded the route's 409 into `missing`,
  // so savedBroken stayed false and layoutDiagnostic stayed null. With the
  // classified broken attempt the resolver must raise the degradation.
  const attempt = boot.classifyLayoutAttempt({ status: 409, body: { ok: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' } });
  const outcome = boot.resolveProductionLayoutDraft({
    saved: attempt,
    bundled: { ok: true, draft: { id: 'good', schemaVersion: 1 } },
    validateDraftSchema: fakeValidator(),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'bundled');
  assert.equal(outcome.code, 'OFFICE_LAYOUT_SAVED_INVALID', 'the page diagnostic is non-empty for a corrupt saved file');
});

// ---------------------------------------------------------------------------
// Task E2d — the office-runtime protocol handler, extracted from main.js into
// the shared office-protocol.js module (also used by the standalone editor
// launcher). These tests lock the behaviour contract VERBATIM: prefix
// parsing, traversal guard, content types, and every office-layout.v1.json
// status code. The handler is a pure function over (request, store) — no
// Electron is required, only the global Response.
//
// 2026-09-24 (M2, windows-perf audit): the handler is ASYNC — the static
// routes read through fs/promises and answer a Response behind an async
// cache revalidation instead of blocking the browser UI thread with
// existsSync/statSync/readFileSync per request. Electron's protocol.handle
// accepts Promise<Response> (electron.d.ts: "Either a `Response` or a
// `Promise<Response>` can be returned"); the layout route already returned
// Promises for PUT/DELETE before this change.
// ---------------------------------------------------------------------------

const { createOfficeProtocolHandler } = require('../src/office/office-protocol.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function protocolFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'office-protocol-'));
  const officeRoot = path.join(root, 'office');
  const officeAssetsRoot = path.join(root, 'office-assets');
  const charactersRoot = path.join(root, 'characters');
  const nodeModulesRoot = path.join(root, 'node_modules');
  for (const dir of [officeRoot, officeAssetsRoot, charactersRoot, path.join(nodeModulesRoot, 'pixi.js', 'dist')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(officeRoot, 'office.html'), '<html>office page</html>');
  fs.mkdirSync(path.join(officeRoot, 'runtime'));
  fs.writeFileSync(path.join(officeRoot, 'runtime', 'office-layout.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(officeAssetsRoot, 'prop-fixture.png'), 'png-bytes');
  fs.writeFileSync(path.join(charactersRoot, 'manifest.json'), '{"schemaVersion":1}');
  fs.writeFileSync(path.join(nodeModulesRoot, 'pixi.js', 'dist', 'pixi.min.js'), '// pixi');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside every root');
  return { root, officeRoot, officeAssetsRoot, charactersRoot, nodeModulesRoot };
}

function protocolRequest(url, method = 'GET', text = null) {
  return { url, method, text: async () => text };
}

const LOCAL = 'office-runtime://local';

test('E2d protocol: prefix routes resolve managed files with the cockpit content types', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot,
    officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot,
    nodeModulesRoot: fx.nodeModulesRoot,
    layoutStore: {},
  });
  const cases = [
    [`${LOCAL}/office.html`, 'text/html; charset=utf-8', '<html>office page</html>'],
    [`${LOCAL}/runtime/office-layout.js`, 'text/javascript; charset=utf-8', 'module.exports = {};'],
    [`${LOCAL}/office-assets/prop-fixture.png`, 'image/png', 'png-bytes'],
    [`${LOCAL}/characters/manifest.json`, 'application/json; charset=utf-8', '{"schemaVersion":1}'],
    [`${LOCAL}/node_modules/pixi.js/dist/pixi.min.js`, 'text/javascript; charset=utf-8', '// pixi'],
  ];
  for (const [url, contentType, body] of cases) {
    const response = await handler(protocolRequest(url));
    assert.equal(response.status, 200, `${url} resolves`);
    assert.equal(response.headers.get('content-type'), contentType, `${url} content type`);
    assert.equal(await response.text(), body, `${url} body`);
    assert.equal(response.headers.get('access-control-allow-origin'), 'office-runtime://local', `${url} CORS header`);
  }
});

test('E2d protocol: traversal guard, missing files, directories and foreign hostnames answer 404', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot,
    officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot,
    nodeModulesRoot: fx.nodeModulesRoot,
    layoutStore: {},
  });
  const notFound = [
    `${LOCAL}/office-assets/../secret.txt`, // literal traversal
    `${LOCAL}/office-assets/%2e%2e/secret.txt`, // encoded traversal (decodeURIComponent runs first)
    `${LOCAL}/office-assets/..%2fsecret.txt`,
    `${LOCAL}/office-assets/missing.png`,
    `${LOCAL}/runtime`, // a directory is not a file
    'office-runtime://evil/office.html', // hostname must be local
    `${LOCAL}/secret.txt`, // the fallback '' route is the office root — secret stays outside
  ];
  for (const url of notFound) {
    const response = await handler(protocolRequest(url));
    assert.equal(response.status, 404, `${url} must be 404`);
  }
});

function stubStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    loadSavedLayout: () => ({ ok: true, missing: false, code: null, draft: { schemaVersion: 1, items: [] }, ...(overrides.load || {}) }),
    saveSavedLayout: async (draft) => { calls.push(['save', draft]); return { ok: true, ...(overrides.save || {}) }; },
    deleteSavedLayout: async () => { calls.push(['delete']); return { ok: true }; },
  };
}

test('E2d protocol: office-layout.v1.json GET/HEAD answers 200 with the saved draft and no-store headers', async () => {
  const store = stubStore();
  const handler = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: store });
  const get = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`));
  assert.equal(get.status, 200);
  assert.deepEqual(JSON.parse(await get.text()), { schemaVersion: 1, items: [] });
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(get.headers.get('content-type'), 'application/json; charset=utf-8');
  const head = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'HEAD'));
  assert.equal(head.status, 200);
  const missing = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: stubStore({ load: { ok: false, missing: true } }) });
  assert.equal((await missing(protocolRequest(`${LOCAL}/office-layout.v1.json`))).status, 404, 'missing answers 404');
  const corrupt = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: stubStore({ load: { ok: false, missing: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT' } }) });
  const conflict = await corrupt(protocolRequest(`${LOCAL}/office-layout.v1.json`));
  assert.equal(conflict.status, 409, 'a corrupt saved layout is BROKEN, never folded into missing');
  assert.equal(JSON.parse(await conflict.text()).code, 'OFFICE_LAYOUT_SAVED_CORRUPT');
});

test('E2d protocol: office-layout.v1.json PUT validates the envelope and DELETE clears; unknown method 405', async () => {
  const store = stubStore();
  const handler = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: store });
  const good = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'PUT', '{"schemaVersion":1,"items":[]}'));
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true }, 'PUT success answers {ok:true} only — never a filesystem path');
  assert.deepEqual(store.calls[0], ['save', { schemaVersion: 1, items: [] }]);
  const failing = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: stubStore({ save: { ok: false, code: 'OFFICE_STATE_WRITE_FAILED' } }) });
  const failed = await failing(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'PUT', '{"schemaVersion":1}'));
  assert.equal(failed.status, 500);
  assert.equal(JSON.parse(await failed.text()).code, 'OFFICE_STATE_WRITE_FAILED');
  for (const [body, code] of [
    ['{"schemaVersion":2}', 422],
    ['[]', 422],
    ['null', 422],
    ['not json at all', 400],
  ]) {
    const response = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'PUT', body));
    assert.equal(response.status, code, `PUT ${body} -> ${code}`);
    assert.equal(JSON.parse(await response.text()).code, code === 422 ? 'OFFICE_LAYOUT_SAVED_INVALID' : 'OFFICE_LAYOUT_SAVED_CORRUPT');
    assert.equal(store.calls.length, 1, 'rejected PUTs never reach the store');
  }
  const deleted = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'DELETE'));
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.deepEqual(store.calls[1], ['delete']);
  const notAllowed = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'POST'));
  assert.equal(notAllowed.status, 405);
});

test('E2d protocol: layoutStore accepts a factory and stays lazy for static routes', async () => {
  const fx = protocolFixture();
  let constructions = 0;
  const factory = () => {
    constructions += 1;
    return stubStore();
  };
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot,
    officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot,
    nodeModulesRoot: fx.nodeModulesRoot,
    layoutStore: factory,
  });
  assert.equal(constructions, 0, 'the store is never touched at handler creation');
  assert.equal((await handler(protocolRequest(`${LOCAL}/office.html`))).status, 200);
  assert.equal(constructions, 0, 'static routes never build the store');
  assert.equal((await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`))).status, 200);
  assert.equal(constructions, 1, 'the first layout request resolves the factory');
  assert.equal((await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`))).status, 200);
  assert.equal(constructions, 2, 'each layout request re-resolves (the cockpit memoizes inside its own factory)');
});

test('E2d protocol: the REAL store round-trips saved layout bytes through the handler', async () => {
  const { createOfficeStateStore } = require('../src/office/runtime/office-persistence.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-protocol-store-'));
  const store = createOfficeStateStore({ userDataDir: dataDir, epoch: 1, log: () => {} });
  const handler = createOfficeProtocolHandler({ officeRoot: '/tmp', layoutStore: store });
  // missing first
  assert.equal((await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`))).status, 404);
  // PUT -> file exists on disk (office-layout.v1.json inside the data dir)
  const saved = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'PUT', JSON.stringify({ schemaVersion: 1, scene: { width: 1, height: 1 }, items: [] })));
  assert.equal(saved.status, 200);
  assert.equal(fs.existsSync(path.join(dataDir, 'office-layout.v1.json')), true, 'the saved layout lands in the dedicated data dir');
  // GET reads the same draft back
  const loaded = await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`));
  assert.equal(loaded.status, 200);
  assert.equal(JSON.parse(await loaded.text()).schemaVersion, 1);
  // DELETE removes the file again
  await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`, 'DELETE'));
  assert.equal(fs.existsSync(path.join(dataDir, 'office-layout.v1.json')), false, 'restore-default really deletes the saved file');
});

// ---------------------------------------------------------------------------
// M2 (windows-perf audit 2026-09-24) — the office-runtime protocol handler is
// async and caches verified bytes. First office open = ~120 requests / 21.3 MB
// of sprites; per-request existsSync+statSync+readFileSync on the browser UI
// thread is what a Windows AV filter turns into a "not responding" window.
// ---------------------------------------------------------------------------

test('M2 protocol: the handler answers a Promise (async contract) and the static routes never block on sync IO', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot, officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot, nodeModulesRoot: fx.nodeModulesRoot, layoutStore: {},
  });
  const pending = handler(protocolRequest(`${LOCAL}/office.html`));
  assert.ok(pending instanceof Promise, 'protocol.handle accepts Promise<Response>; the handler must return one');
  assert.equal((await pending).status, 200);
  // A 404 path is also async (uniform contract, no sync/sync split).
  assert.ok(handler(protocolRequest(`${LOCAL}/office-assets/missing.png`)) instanceof Promise);
});

test('M2 protocol: a repeat request is served from the cache without re-reading the file', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot, officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot, nodeModulesRoot: fx.nodeModulesRoot, layoutStore: {},
  });
  const url = `${LOCAL}/office-assets/prop-fixture.png`;
  const first = await handler(protocolRequest(url));
  assert.equal(await first.text(), 'png-bytes');
  assert.equal(handler.cacheStats().misses, 1, 'the first request read the file');
  assert.equal(handler.cacheStats().entries, 1);

  // Make the file unreadable: stat still works (the revalidation path), read
  // would throw. A 200 with the original bytes can only come from the cache.
  const file = path.join(fx.officeAssetsRoot, 'prop-fixture.png');
  const originalMode = fs.statSync(file).mode;
  fs.chmodSync(file, 0o000);
  try {
    const second = await handler(protocolRequest(url));
    assert.equal(second.status, 200, 'served from cache even though the file is unreadable');
    assert.equal(await second.text(), 'png-bytes');
    assert.equal(handler.cacheStats().hits, 1, 'the second request was a cache HIT');
    assert.equal(handler.cacheStats().misses, 1, 'no second read happened');
  } finally {
    fs.chmodSync(file, originalMode);
  }
});

test('M2 protocol: the cache revalidates on mtime/size and never serves a stale build asset', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot, officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot, nodeModulesRoot: fx.nodeModulesRoot, layoutStore: {},
  });
  const url = `${LOCAL}/office-assets/prop-fixture.png`;
  const file = path.join(fx.officeAssetsRoot, 'prop-fixture.png');
  assert.equal(await (await handler(protocolRequest(url))).text(), 'png-bytes');
  // Same size, new content (the classic stale-cache trap) + a fresh mtime.
  fs.writeFileSync(file, 'PNG-BYTES'); // same length, different bytes
  const changed = await handler(protocolRequest(url));
  assert.equal(await changed.text(), 'PNG-BYTES', 'a same-size rewrite must not be served from the cache');
  assert.equal(handler.cacheStats().misses, 2);
  // A deleted file drops its entry and answers 404 (never a ghost 200).
  fs.rmSync(file);
  const gone = await handler(protocolRequest(url));
  assert.equal(gone.status, 404);
  assert.equal(handler.cacheStats().entries, 0, 'the deleted path is evicted from the cache');
});

test('M2 protocol: the cache is bounded by entries (LRU) and the layout route is never cached', async () => {
  const fx = protocolFixture();
  const { CACHE_MAX_ENTRIES } = require('../src/office/office-protocol.js');
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot, officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot, nodeModulesRoot: fx.nodeModulesRoot,
    layoutStore: stubStore(),
  });
  for (let i = 0; i < CACHE_MAX_ENTRIES + 12; i += 1) {
    fs.writeFileSync(path.join(fx.officeAssetsRoot, `sprite-${i}.png`), `sprite-${i}`);
    const r = await handler(protocolRequest(`${LOCAL}/office-assets/sprite-${i}.png`));
    assert.equal(r.status, 200);
  }
  const stats = handler.cacheStats();
  assert.equal(stats.entries, CACHE_MAX_ENTRIES, 'the entry bound is the ceiling');
  assert.ok(stats.evictions >= 12, 'overflow evicted the oldest entries (LRU)');
  assert.ok(stats.bytes <= stats.maxBytes, 'the byte bound also holds');
  // Per-user data (the saved layout) must never enter the shared asset cache.
  await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`));
  await handler(protocolRequest(`${LOCAL}/office-layout.v1.json`));
  assert.equal(handler.cacheStats().entries, CACHE_MAX_ENTRIES, 'store-backed responses are not cached');
});

test('M2 protocol: cache keys are resolved paths — identical relative paths under different roots never collide', async () => {
  const fx = protocolFixture();
  const handler = createOfficeProtocolHandler({
    officeRoot: fx.officeRoot, officeAssetsRoot: fx.officeAssetsRoot,
    charactersRoot: fx.charactersRoot, nodeModulesRoot: fx.nodeModulesRoot, layoutStore: {},
  });
  fs.writeFileSync(path.join(fx.officeRoot, 'shared.png'), 'from-office-root');
  fs.writeFileSync(path.join(fx.charactersRoot, 'shared.png'), 'from-characters-root');
  const a = await handler(protocolRequest(`${LOCAL}/shared.png`));
  const b = await handler(protocolRequest(`${LOCAL}/characters/shared.png`));
  assert.equal(await a.text(), 'from-office-root');
  assert.equal(await b.text(), 'from-characters-root');
  // and both keep answering correctly on the cached path
  assert.equal(await (await handler(protocolRequest(`${LOCAL}/shared.png`))).text(), 'from-office-root');
  assert.equal(await (await handler(protocolRequest(`${LOCAL}/characters/shared.png`))).text(), 'from-characters-root');
});
