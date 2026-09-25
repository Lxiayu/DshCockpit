'use strict';

// Task 8 / SPEC-08 — Office independent persistence, settings clamps, atomic
// writes, corruption recovery, history bounds and epoch rejection.
// RED: src/office/runtime/office-persistence.js does not exist yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persistence = require('../src/office/runtime/office-persistence.js');
const officeModule = require('../src/office/office-module.js');

const STATE_FILE = 'office-state.v1.json';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'office-persist-'));
}

function readFile(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function createStore(dir, options = {}) {
  return persistence.createOfficeStateStore({ userDataDir: dir, epoch: 1, ...options });
}

// ---- default schema and flags ------------------------------------------------

test('fresh store loads the default schema with both office flags false', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const state = store.get();
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.flags, { officeRuntimeEnabled: false, officePlaygroundEnabled: false });
  assert.deepEqual(state.settings, {
    sleepAfterMs: 300000,
    resultPresentationMs: 5000,
    sceneMinDimensionPerSecond: 0.046,
    userFrameDurationOverrideMs: null,
    reducedMotion: false,
    privacyMode: 'redacted',
  });
  assert.deepEqual(state.employees, []);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.activityLog, []);
  assert.deepEqual(state.bindings, []);
});

test('a store never enables office flags by itself', () => {
  const dir = tmpDir();
  const store = createStore(dir);
  assert.equal(store.get().flags.officeRuntimeEnabled, false);
  assert.equal(store.get().flags.officePlaygroundEnabled, false);
});

// ---- round-trip + migration ---------------------------------------------------

test('saved state round-trips through a fresh store', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.save({
    settings: { reducedMotion: true, resultPresentationMs: 8000 },
    employees: [{ employeeId: 'coder', role: 'coder', character: 'deepseek-default' }],
  });
  const reloaded = createStore(dir);
  const state = reloaded.get();
  assert.equal(state.settings.reducedMotion, true);
  assert.equal(state.settings.resultPresentationMs, 8000);
  // untouched settings keep defaults
  assert.equal(state.settings.sleepAfterMs, 300000);
  assert.equal(state.employees[0].employeeId, 'coder');
});

test('migration fills missing fields from a v0/partial file and clamps settings', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({
    settings: { sleepAfterMs: 5, privacyMode: 'full' },
    tasks: [{ employeeId: 'coder', kind: 'task-started' }],
  }));
  const store = createStore(dir);
  const state = store.get();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.settings.sleepAfterMs, 60000); // clamped to the 60s floor
  assert.equal(state.settings.privacyMode, 'full'); // explicit user choice survives
  assert.equal(state.settings.resultPresentationMs, 5000); // default filled
  assert.deepEqual(state.flags, { officeRuntimeEnabled: false, officePlaygroundEnabled: false });
  assert.equal(state.tasks.length, 1);
});

test('a future/unknown schemaVersion falls back to defaults with a diagnostic', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ schemaVersion: 99, settings: { privacyMode: 'full' } }));
  const store = createStore(dir);
  assert.equal(store.get().schemaVersion, 1);
  assert.equal(store.get().settings.privacyMode, 'redacted');
  assert.ok(store.diagnostics().some((d) => d.code === 'OFFICE_STATE_CORRUPT'));
});

// ---- atomic write and recovery -------------------------------------------------

test('writes are atomic: no temp files remain and the file is valid JSON', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.save({ settings: { reducedMotion: true } });
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.doesNotThrow(() => JSON.parse(readFile(dir, STATE_FILE)));
  // a last-good backup exists for corruption recovery
  assert.doesNotThrow(() => JSON.parse(readFile(dir, `${STATE_FILE}.bak`)));
});

test('corrupt main file recovers from the last valid backup', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.save({ settings: { reducedMotion: true } });
  fs.writeFileSync(path.join(dir, STATE_FILE), '{not-json');
  const reloaded = createStore(dir);
  assert.equal(reloaded.get().settings.reducedMotion, true);
  assert.ok(reloaded.diagnostics().some((d) => d.code === 'OFFICE_STATE_CORRUPT'));
});

test('corrupt main AND backup files fall back to defaults with OFFICE_STATE_CORRUPT', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, STATE_FILE), '{broken');
  fs.writeFileSync(path.join(dir, `${STATE_FILE}.bak`), '[also broken');
  const store = createStore(dir);
  assert.equal(store.get().schemaVersion, 1);
  assert.equal(store.get().settings.privacyMode, 'redacted');
  assert.ok(store.diagnostics().some((d) => d.code === 'OFFICE_STATE_CORRUPT'));
});

test('concurrent save requests are serialized: single writer, final state wins', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const writes = [];
  for (let i = 0; i < 20; i += 1) {
    writes.push(store.save({ activityLog: [{ atMs: i, kind: 'task-started', employeeId: 'coder' }] }));
  }
  await Promise.all(writes);
  const reloaded = createStore(dir);
  assert.equal(reloaded.get().activityLog.length, 1);
  assert.equal(reloaded.get().activityLog[0].atMs, 19);
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a failed write keeps the previous valid file and rejects', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.save({ settings: { reducedMotion: true } });
  const before = readFile(dir, STATE_FILE);
  // sabotage: replace the state file with a DIRECTORY so rename() must fail
  fs.rmSync(path.join(dir, STATE_FILE));
  fs.mkdirSync(path.join(dir, STATE_FILE));
  await assert.rejects(() => store.save({ settings: { reducedMotion: false } }), /OFFICE_STATE_WRITE_FAILED/);
  fs.rmSync(path.join(dir, STATE_FILE), { recursive: true });
  assert.equal(readFile(dir, STATE_FILE.replace('.json', '.json.bak')), before);
});

// ---- history bounds --------------------------------------------------------------

test('per-employee task history is capped at 50 and global activity at 200', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const tasks = [];
  for (let i = 0; i < 60; i += 1) tasks.push({ employeeId: 'coder', kind: 'task-started', atMs: i });
  for (let i = 0; i < 10; i += 1) tasks.push({ employeeId: 'reviewer', kind: 'task-started', atMs: i });
  const activityLog = [];
  for (let i = 0; i < 250; i += 1) activityLog.push({ employeeId: 'coder', kind: 'task-started', atMs: i });
  await store.save({ tasks, activityLog });
  const state = createStore(dir).get();
  assert.equal(state.tasks.filter((t) => t.employeeId === 'coder').length, 50);
  assert.equal(state.tasks.filter((t) => t.employeeId === 'reviewer').length, 10);
  // the most RECENT entries survive
  assert.equal(state.tasks.filter((t) => t.employeeId === 'coder')[0].atMs, 10);
  assert.equal(state.activityLog.length, 200);
  assert.equal(state.activityLog[0].atMs, 50);
});

// ---- epoch rejection --------------------------------------------------------------

test('bindings without an epoch are never persisted; old-epoch running bindings go stale on load', async () => {
  const dir = tmpDir();
  const store = createStore(dir, { epoch: 1 });
  await store.save({
    bindings: [
      { employeeId: 'orchestrator', epoch: 1, bindingSource: 'root', confidence: 1, boundAtMs: 10, releasedAtMs: null },
      { employeeId: 'coder', bindingSource: 'root', confidence: 1, boundAtMs: 5, releasedAtMs: null }, // no epoch: dropped
    ],
  });
  const onDisk = JSON.parse(readFile(dir, STATE_FILE));
  assert.equal(onDisk.bindings.length, 1);
  assert.equal(onDisk.bindings[0].employeeId, 'orchestrator');

  // next launch runs under a NEW epoch: the old running binding must not resume
  const nextEpoch = createStore(dir, { epoch: 2 });
  const state = nextEpoch.get();
  const active = state.bindings.filter((b) => b.releasedAtMs === null);
  assert.equal(active.length, 0);
  assert.ok(state.staleBindings.some((b) => b.employeeId === 'orchestrator'));
  assert.ok(nextEpoch.diagnostics().some((d) => d.code === 'OFFICE_STATE_EPOCH_REJECTED'));
});

test('same-epoch active bindings are restored; released ones stay history', async () => {
  const dir = tmpDir();
  const store = createStore(dir, { epoch: 7 });
  await store.save({
    bindings: [
      { employeeId: 'orchestrator', epoch: 7, bindingSource: 'root', confidence: 1, boundAtMs: 1, releasedAtMs: null },
      { employeeId: 'coder', epoch: 7, bindingSource: 'heuristic', confidence: 0.5, boundAtMs: 2, releasedAtMs: 3, outcome: 'completed' },
    ],
  });
  const reloaded = createStore(dir, { epoch: 7 });
  const state = reloaded.get();
  assert.equal(state.bindings.filter((b) => b.releasedAtMs === null).length, 1);
  assert.equal(state.bindings.length, 2);
  assert.deepEqual(state.staleBindings, []);
});

// ---- settings clamp -----------------------------------------------------------------

test('updateSettings clamps every setting to its documented range', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const result = await store.updateSettings({
    sleepAfterMs: 1, // below 60s floor
    resultPresentationMs: 999999, // above 30s ceiling
    sceneMinDimensionPerSecond: -3, // must be positive
    userFrameDurationOverrideMs: 0, // null or positive int
  });
  assert.equal(result.ok, true);
  const s = result.settings;
  assert.equal(s.sleepAfterMs, 60000);
  assert.equal(s.resultPresentationMs, 30000);
  assert.ok(s.sceneMinDimensionPerSecond > 0);
  assert.equal(s.userFrameDurationOverrideMs, null);
  // upper clamps too
  const hi = await store.updateSettings({ sleepAfterMs: 10 * 24 * 60 * 60 * 1000 });
  assert.equal(hi.settings.sleepAfterMs, 24 * 60 * 60 * 1000);
});

test('updateSettings rejects unknown keys and bad types without touching the file', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.save({});
  const before = readFile(dir, STATE_FILE);
  const bad = await store.updateSettings({ sleepAfterMs: 'fast' });
  assert.equal(bad.ok, false);
  const unknown = await store.updateSettings({ evilKey: 1 });
  assert.equal(unknown.ok, false);
  assert.equal(readFile(dir, STATE_FILE), before);
});

test('settings changes apply at the next decision point and never rewrite the persisted schema', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.updateSettings({ resultPresentationMs: 12000 });
  const onDisk = JSON.parse(readFile(dir, STATE_FILE));
  assert.equal(Object.keys(onDisk.settings).includes('frameDurationOverrideMs'), false);
  assert.equal(onDisk.settings.userFrameDurationOverrideMs, null);
});

// ---- legacy field compatibility (Task 7 naming) ----------------------------------------

test('office module accepts legacy frameDurationOverrideMs one-way and never persists it', () => {
  const module = officeModule.createOfficeModule({ layout: require('../src/office/fixtures/office-layout.json') });
  const legacy = module.validateSettings({ frameDurationOverrideMs: 120 });
  assert.equal(legacy.ok, true);
  const applied = module.updateSettings({ frameDurationOverrideMs: 120 });
  assert.equal(applied.ok, true);
  const settings = module.getSettings();
  assert.equal(settings.userFrameDurationOverrideMs, 120);
  assert.equal('frameDurationOverrideMs' in settings, false);
  module.destroy();
});

test('office module exposes userFrameDurationOverrideMs in defaults and validates it', () => {
  const module = officeModule.createOfficeModule({ layout: require('../src/office/fixtures/office-layout.json') });
  assert.equal(module.getSettings().userFrameDurationOverrideMs, null);
  assert.equal(module.validateSettings({ userFrameDurationOverrideMs: 120 }).ok, true);
  assert.equal(module.validateSettings({ userFrameDurationOverrideMs: 5 }).ok, false);
  assert.equal(module.validateSettings({ userFrameDurationOverrideMs: null }).ok, true);
  module.destroy();
});

// ---- privacyMode in module settings ---------------------------------------------------

test('office module settings accept privacyMode redacted/full, default redacted', () => {
  const module = officeModule.createOfficeModule({ layout: require('../src/office/fixtures/office-layout.json') });
  assert.equal(module.getSettings().privacyMode, 'redacted');
  assert.equal(module.validateSettings({ privacyMode: 'full' }).ok, true);
  assert.equal(module.validateSettings({ privacyMode: 'everything' }).ok, false);
  module.destroy();
});

test('delayed effect: updating settings mid-run notes SETTINGS_APPLY_NEXT_DECISION', () => {
  const module = officeModule.createOfficeModule({ layout: require('../src/office/fixtures/office-layout.json') });
  const result = module.updateSettings({ resultPresentationMs: 12000, sleepAfterMs: 120000 });
  assert.equal(result.ok, true);
  const diag = module.diagnostics();
  assert.ok(diag.diagnostics.some((d) => d.code === 'SETTINGS_APPLY_NEXT_DECISION'));
  module.destroy();
});

// ---- IPC facade: persist-first ordering (P1 review fix) -------------------------

function createIpcHarness(storeOverride) {
  const module = officeModule.createOfficeModule({ layout: require('../src/office/fixtures/office-layout.json') });
  const store = storeOverride || createStore(tmpDir());
  const facade = {
    ...module,
    updateSettings: (partial) => officeModule.persistOfficeSettings(module, store, partial),
  };
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  officeModule.registerOfficeIpc({ ipcMain, module: facade, enabled: true });
  return { module, store, handlers };
}

test('office:settings IPC persists first and surfaces write failure without touching memory', async () => {
  const failingStore = {
    async updateSettings() { throw new Error('OFFICE_STATE_WRITE_FAILED: disk full'); },
  };
  const { module, handlers } = createIpcHarness(failingStore);
  const before = module.getSettings().resultPresentationMs;
  const res = await handlers.get('office:settings')(null, { action: 'set', settings: { resultPresentationMs: 9000 } });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'OFFICE_STATE_WRITE_FAILED');
  // persist-first: a failed write must not leave the in-memory settings changed
  assert.equal(module.getSettings().resultPresentationMs, before);
  module.destroy();
});

test('office:settings IPC success path persists only persistable keys, then applies', async () => {
  const { module, store, handlers } = createIpcHarness();
  const res = await handlers.get('office:settings')(null, {
    action: 'set',
    settings: { resultPresentationMs: 9000, chatDurationMs: 20000 },
  });
  assert.equal(res.ok, true);
  assert.equal(module.getSettings().resultPresentationMs, 9000);
  assert.equal(module.getSettings().chatDurationMs, 20000);
  // only SPEC-08 schema keys reach the persisted file (chatDurationMs is runtime-only)
  const persisted = store.get().settings;
  assert.equal(persisted.resultPresentationMs, 9000);
  assert.equal('chatDurationMs' in persisted, false);
  module.destroy();
});

// ---- legacy settings.json / runtime-state.json / sessions are never touched ---

test('legacy settings.json / runtime-state.json / sessions are never touched', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"channel":"rc"}');
  fs.writeFileSync(path.join(dir, 'runtime-state.json'), '{"pid":1}');
  fs.mkdirSync(path.join(dir, 'sessions'));
  fs.writeFileSync(path.join(dir, 'sessions', 'a.json'), '{"s":1}');
  const store = createStore(dir);
  await store.save({ settings: { reducedMotion: true } });
  await store.updateSettings({ resultPresentationMs: 9000 });
  assert.equal(readFile(dir, 'settings.json'), '{"channel":"rc"}');
  assert.equal(readFile(dir, 'runtime-state.json'), '{"pid":1}');
  assert.equal(readFile(dir, path.join('sessions', 'a.json')), '{"s":1}');
  // the office file contains no legacy settings keys
  const office = JSON.parse(readFile(dir, STATE_FILE));
  assert.equal('channel' in office, false);
  assert.equal('workspace' in office, false);
});

// ---- fallback: corrupt state still yields a usable shell --------------------------------

test('corrupt state still produces a working office module (static/placeholder fallback)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, STATE_FILE), '###garbage###');
  const store = createStore(dir);
  assert.equal(store.get().schemaVersion, 1); // defaults, no crash
  const module = officeModule.createOfficeModule({
    layout: require('../src/office/fixtures/office-layout.json'),
    pack: null, // pack/texture/WebGL failure path: placeholder mode
    config: store.get().settings,
  });
  const snapshot = module.state();
  assert.equal(snapshot.employees.length > 0, true);
  module.destroy();
});

// ---------------------------------------------------------------------------
// Task 8 — the saved production layout (office-layout.v1.json)
// ---------------------------------------------------------------------------

const VALID_LAYOUT = {
  schemaVersion: 1,
  scene: { width: 1280, height: 840 },
  items: [
    { id: 'desk-a', kind: 'desk', asset: 'prop-desk-back-right-top', position: { x: 0.3, y: 0.3 }, scale: 1, direction: 'back-right-top' },
  ],
};

test('fresh store reports the saved layout as missing (first run)', () => {
  const store = createStore(tmpDir());
  const missing = store.loadSavedLayout();
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.equal(missing.code, null, 'a missing saved layout is not a diagnostic');
  assert.equal(missing.draft, null);
});

test('saveSavedLayout round-trips the layout JSON and loadSavedLayout returns it verbatim', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  const saveResult = await store.saveSavedLayout(VALID_LAYOUT);
  assert.equal(saveResult.ok, true);
  assert.equal(saveResult.file, path.join(dir, 'office-layout.v1.json'));
  const loaded = store.loadSavedLayout();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.missing, false);
  assert.equal(loaded.code, null);
  assert.deepEqual(loaded.draft, VALID_LAYOUT);
  // the layout file is separate from office-state.v1.json and leaves no temp files
  assert.equal(fs.existsSync(path.join(dir, 'office-layout.v1.json')), true);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp')), []);
});

test('a corrupt saved layout resolves OFFICE_LAYOUT_SAVED_CORRUPT instead of JSON garbage', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.saveSavedLayout(VALID_LAYOUT);
  fs.writeFileSync(path.join(dir, 'office-layout.v1.json'), '{not json', 'utf8');
  const loaded = store.loadSavedLayout();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'OFFICE_LAYOUT_SAVED_CORRUPT');
  assert.equal(loaded.draft, null);
});

test('a structurally invalid saved layout (non-object JSON) resolves OFFICE_LAYOUT_SAVED_INVALID', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.saveSavedLayout(VALID_LAYOUT);
  fs.writeFileSync(path.join(dir, 'office-layout.v1.json'), '[1,2,3]', 'utf8');
  const loaded = store.loadSavedLayout();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.code, 'OFFICE_LAYOUT_SAVED_INVALID');
});

test('saveSavedLayout rejects a non-object draft with OFFICE_LAYOUT_SAVED_INVALID before touching the disk', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  for (const bad of [null, 'x', 42, [VALID_LAYOUT]]) {
    const result = await store.saveSavedLayout(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(result.code, 'OFFICE_LAYOUT_SAVED_INVALID');
  }
  assert.equal(fs.existsSync(path.join(dir, 'office-layout.v1.json')), false, 'nothing is written for invalid drafts');
});

test('saveSavedLayout overwrites atomically and leaves no temp files in userData', async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.saveSavedLayout(VALID_LAYOUT);
  const updated = JSON.parse(JSON.stringify(VALID_LAYOUT));
  updated.items[0].position.x = 0.6;
  const second = await store.saveSavedLayout(updated);
  assert.equal(second.ok, true);
  assert.deepEqual(store.loadSavedLayout().draft.items[0].position, { x: 0.6, y: 0.3 });
  // no temp files leak into userData
  const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});
