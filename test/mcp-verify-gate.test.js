// test/mcp-verify-gate.test.js — windows-perf P1 #1: the MCP verification
// gate. Proves the AV-pain counters with spawn counts, without weakening the
// safety net (a bad config is still rejected and still rolls back).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMcpVerifyGate } = require('../src/mcp-verify-gate');
const mm = require('../src/mcp-manager');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-'));

const SERVER = (id) => ({
  id, name: id, serverName: id, transport: 'stdio',
  command: 'node', args: [id], envPlain: {}, envSecretKeys: [],
});

function makeManager(extra = {}) {
  const dir = tmpDir();
  let spawns = 0;
  const logs = [];
  const store = { mcpServers: [] };
  const settings = {
    get: () => ({ ...store }),
    patch: (p) => { Object.assign(store, p); },
  };
  const patchFile = path.join(dir, 'profiles', 'web', 'cordis.patch.yml');
  const mgr = mm.createMcpManager({
    settings,
    dshHome: () => dir,
    profileName: 'web',
    userDataDir: path.join(dir, 'userdata'),
    safeStorage: null,
    log: (l) => logs.push(l),
    platform: 'linux',
    runtimeVersionOf: () => '0.1.5-rc.2',
    verifyGateOpts: { delayMs: 5, maxWaitMs: 50 },
    dumpConfigVerify: extra.verify || (async () => { spawns += 1; return { ok: true }; }),
    ...extra.deps,
  });
  const spawnCount = () => spawns;
  return {
    mgr, settings, dir, logs, patchFile,
    spawns: () => spawns,
    bump: () => { spawns += 1; },
  };
}

// ------------------------------------------------------------- gate unit

test('gate merges concurrent writers into one spawn and answers them all', async () => {
  // fake clock + manual timer queue so the burst is deterministic
  let clock = 0;
  const timers = [];
  const schedule = (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; };
  const cancel = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const flush = () => {
    timers.sort((a, b) => a.at - b.at);
    const h = timers.shift();
    if (!h) return;
    clock = h.at;
    h.fn();
  };
  let spawns = 0;
  const gate = createMcpVerifyGate({
    spawnVerify: async () => { spawns += 1; return { ok: true }; },
    readText: () => null,
    runtimeVersion: () => 'rt-1',
    now: () => clock,
    schedule,
    cancel,
    log: () => {},
  });
  const p = Promise.all([
    gate.request('A', ''), gate.request('B', ''), gate.request('C', ''),
  ]);
  flush(); // fire the debounce timer → the single spawn runs
  const [r1, r2, r3] = await p;
  assert.strictEqual(spawns, 1, 'three writers, one spawn');
  assert.ok(r1.ok && r2.ok && r3.ok);
  assert.strictEqual(gate.verified().text, 'C', 'the LATEST text of the burst is what was verified');
});

test('a request arriving DURING a run is verified in a follow-up round, never by it', async () => {
  let clock = 0;
  const timers = [];
  const schedule = (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; };
  const cancel = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const flush = () => {
    timers.sort((a, b) => a.at - b.at);
    const h = timers.shift();
    if (!h) return;
    clock = h.at;
    h.fn();
  };
  const pending = [];
  let spawns = 0;
  const gate = createMcpVerifyGate({
    spawnVerify: () => { spawns += 1; return new Promise((res) => pending.push(res)); },
    readText: () => null,
    restore: () => true,
    runtimeVersion: () => 'rt-1',
    now: () => clock,
    schedule,
    cancel,
    log: () => {},
  });
  let r1Result = null;
  const r1 = gate.request('T1', '').then((r) => { r1Result = r; return r; });
  flush(); // burst 1 starts; spawn #1 in flight
  const r2 = gate.request('T2', 'T1'); // lands mid-run
  flush(); // burst 2 starts only after run 1 settles
  pending[0]({ ok: true }); // run 1 passes T1
  await r1;
  assert.strictEqual(r1Result.ok, true);
  pending[1]({ ok: true }); // run 2 passes T2
  await r2;
  assert.strictEqual(spawns, 2, 'the mid-run request paid its own spawn');
  assert.strictEqual(gate.verified().text, 'T2', 'follow-up verdict reflects the newest text');
});

test('skipped runs (no runtime / spawn error) are never cached as verified', async () => {
  let spawns = 0;
  let verdict = { ok: true, skipped: 'no-runtime' };
  const gate = createMcpVerifyGate({
    spawnVerify: async () => { spawns += 1; return verdict; },
    readText: () => null,
    schedule: (fn) => { fn(); return 0; }, // verify immediately
    cancel: () => {},
    log: () => {},
  });
  const r1 = await gate.request('same-text', '');
  assert.strictEqual(r1.skipped, 'no-runtime');
  assert.strictEqual(gate.verified(), null, 'a skip caches nothing');
  verdict = { ok: true };
  await gate.request('same-text', '');
  assert.strictEqual(spawns, 2, 'the same text spawns again after a skip');
});

test('reuse is keyed by content and invalidated by a runtime version change', async () => {
  let clock = 0;
  const timers = [];
  const schedule = (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; };
  const cancel = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const flush = () => {
    timers.sort((a, b) => a.at - b.at);
    const h = timers.shift();
    if (!h) return;
    clock = h.at;
    h.fn();
  };
  let spawns = 0;
  let rt = 'rt-1';
  const gate = createMcpVerifyGate({
    spawnVerify: async () => { spawns += 1; return { ok: true }; },
    readText: () => null,
    runtimeVersion: () => rt,
    now: () => clock,
    schedule,
    cancel,
    log: () => {},
  });
  const p1 = gate.request('X', '');
  flush();
  await p1;
  const reuse = await gate.request('X', ''); // reuse path: no timer involved
  assert.strictEqual(reuse.reused, true);
  assert.strictEqual(spawns, 1, 'identical text + same runtime → 0 spawns');
  rt = 'rt-2';
  const p3 = gate.request('X', '');
  flush();
  await p3;
  assert.strictEqual(spawns, 2, 'runtime version change invalidates the reuse');
  const reuse2 = await gate.request('X', '');
  assert.strictEqual(reuse2.reused, true);
  assert.strictEqual(spawns, 2);
});

test('a failed burst restores the newest never-rejected text, not a rejected one', async () => {
  let clock = 0;
  const timers = [];
  const schedule = (fn, ms) => { const h = { fn, at: clock + ms }; timers.push(h); return h; };
  const cancel = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const flush = () => {
    timers.sort((a, b) => a.at - b.at);
    const h = timers.shift();
    if (!h) return;
    clock = h.at;
    h.fn();
  };
  let disk = '';
  const pending = [];
  const restores = [];
  const gate = createMcpVerifyGate({
    spawnVerify: () => new Promise((res) => pending.push(res)),
    readText: () => disk,
    restore: (t) => { restores.push(t); disk = t; return true; },
    runtimeVersion: () => 'rt-1',
    now: () => clock,
    schedule,
    cancel,
    log: () => {},
  });
  // burst 1 (text B1, pre '') starts; burst 2 (text B2, pre B1) writes while it runs
  const r1 = gate.request('B1', '');
  flush();
  disk = 'B1';
  const r2 = gate.request('B2', 'B1');
  flush();
  disk = 'B2';
  pending[0]({ ok: false, reason: 'exit 1' }); // B1 rejected; disk holds B2 → no clobber
  await r1;
  assert.deepStrictEqual(restores, [], 'restore skipped: a newer write owns the disk');
  pending[1]({ ok: false, reason: 'exit 2' }); // B2 rejected too; pre B1 is rejected → walk to ''
  await r2;
  assert.deepStrictEqual(restores, [''], 'restore walked the bad chain back to the last clean state');
  assert.strictEqual(disk, '');
});

// ------------------------------------------------- manager integration

test('REGRESSION #1 (debounce): N parallel saves pay ONE dump-config spawn', async () => {
  const f = makeManager();
  const results = await Promise.all([
    f.mgr.save(SERVER('alpha'), {}),
    f.mgr.save(SERVER('bravo'), {}),
    f.mgr.save(SERVER('charlie'), {}),
  ]);
  assert.ok(results.every((r) => r.ok), `all saves succeeded: ${JSON.stringify(results.map((r) => r.reason || r.ok))}`);
  assert.strictEqual(f.spawns(), 1, `burst of 3 writes → exactly 1 spawn (got ${f.spawns()})`);
  const text = fs.readFileSync(f.patchFile, 'utf8');
  for (const id of ['mcp-alpha', 'mcp-bravo', 'mcp-charlie']) {
    assert.ok(text.includes(`- id: ${id}`), `final file contains ${id}`);
  }
});

test('REGRESSION #1 (reuse): an identical re-save spawns nothing', async () => {
  const f = makeManager();
  await f.mgr.save(SERVER('alpha'), {});
  assert.strictEqual(f.spawns(), 1);
  const r = await f.mgr.save(SERVER('alpha'), {}); // same content → upsert is byte-identical
  assert.strictEqual(r.ok, true);
  assert.strictEqual(f.spawns(), 1, 'already-verified text reused: 0 additional spawns');
  assert.ok(f.mgr.verifyGate.verified(), 'gate holds the verified text');
});

test('REGRESSION #1 (safety): a bad config is still blocked, restored once, settings untouched', async () => {
  const dir = tmpDir();
  let spawns = 0;
  const logs = [];
  const store = { mcpServers: [] };
  const settings = { get: () => ({ ...store }), patch: (p) => { Object.assign(store, p); } };
  const patchFile = path.join(dir, 'profiles', 'web', 'cordis.patch.yml');
  const marker = path.join(dir, 'MAKE-VERIFY-FAIL');
  const mgr = mm.createMcpManager({
    settings,
    dshHome: () => dir,
    profileName: 'web',
    userDataDir: path.join(dir, 'userdata'),
    safeStorage: null,
    log: (l) => logs.push(l),
    platform: 'linux',
    runtimeVersionOf: () => '0.1.5-rc.2',
    verifyGateOpts: { delayMs: 5, maxWaitMs: 50 },
    dumpConfigVerify: async () => {
      spawns += 1;
      return fs.existsSync(marker) ? { ok: false, reason: 'dump-config exit 1' } : { ok: true };
    },
  });
  await mgr.save(SERVER('good'), {}); // seed: verified text
  const goodText = fs.readFileSync(patchFile, 'utf8');
  fs.writeFileSync(marker, '1');
  const results = await Promise.all([
    mgr.save(SERVER('bad1'), {}),
    mgr.save(SERVER('bad2'), {}),
  ]);
  assert.ok(results.every((r) => !r.ok), 'every writer of the failed burst is rejected');
  assert.strictEqual(fs.readFileSync(patchFile, 'utf8'), goodText, 'file rolled back to exact pre-burst bytes');
  assert.strictEqual(settings.get().mcpServers.length, 1, 'settings untouched on failure');
  assert.strictEqual(f_restoreCount(logs), 1, 'rollback ran exactly once for the whole burst');
  assert.strictEqual(spawns, 2, 'seed spawn + one burst spawn');
  fs.rmSync(dir, { recursive: true, force: true });
});

function f_restoreCount(logs) {
  return logs.filter((l) => l.includes('restored the pre-burst')).length;
}
