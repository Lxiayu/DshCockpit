'use strict';

// studio/test/session-store.test.js — the workbench session store (rectification
// plan T5).
//
// The store is pure on purpose — no DOM, no IPC, no timers of its own and no
// direct sessionStorage access (the scheduler and the storage-like object are
// injected) — so what is tested here IS the whole module:
//   * set/patch/get round trip, and get() hands out a deep COPY;
//   * the dirty map: clean at rest, patch dirties its domain, clean() clears
//     just that one;
//   * a stub storage round trips a JSON blob between TWO stores, and the new one
//     reports the restored domains as dirty;
//   * restore() refuses unparseable, shape-wrong and foreign blobs (STORE_CORRUPT),
//     empty storage (STORE_EMPTY) and a missing backend (STORE_UNAVAILABLE) —
//     always without touching memory;
//   * restore() drops unknown extra keys and defaults a missing domain;
//   * no storage at all → the store still works, flush() says STORE_UNAVAILABLE;
//   * the INJECTED scheduler is what arms the debounce, and ONE window coalesces
//     every mutation into ONE flush (this is the coalescing contract asserted
//     here: schedule() is called once per window, the flush once);
//   * clear() empties memory and the storage, and supersedes an armed debounce so
//     a stale timer cannot resurrect the blob;
//   * a throwing listener is inert, and an unserialisable value makes flush()
//     report STORE_SERIALISE_FAILED without throwing and without losing state.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  createSessionStore,
  SESSION_KEY_DEFAULT,
  SESSION_DOMAINS,
} = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'store.js'));

// A storage stub shaped like window.sessionStorage (a Map underneath, plus
// call counters so tests can prove WHEN and HOW OFTEN the store touches it).
function createStubStorage() {
  const map = new Map();
  const stats = { gets: 0, writes: 0, removes: 0 };
  return {
    map,
    stats,
    getItem(key) {
      stats.gets += 1;
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      stats.writes += 1;
      map.set(key, String(value));
    },
    removeItem(key) {
      stats.removes += 1;
      map.delete(key);
    },
  };
}

// A manual scheduler: nothing runs until the test fires the armed callback, so
// the 500ms debounce costs no wall clock and its behaviour is observable.
function createManualScheduler() {
  const armed = [];
  return {
    armed,
    schedule(fn, ms) {
      const entry = { ms, done: false, fn: () => { entry.done = true; fn(); } };
      armed.push(entry);
      return entry;
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('set/patch/get round trip, and get() hands out a deep copy', () => {
  const store = createSessionStore({ storage: createStubStorage() });

  const replaced = store.set('scene', { pending: [{ itemId: 'draft-53', position: { x: 0.125, y: 0.5 } }], selectedId: 'draft-53' });
  assert.deepEqual(replaced, { ok: true, domain: 'scene' }, 'set() reports the domain it replaced');

  const scene = store.get('scene');
  assert.deepEqual(scene, { pending: [{ itemId: 'draft-53', position: { x: 0.125, y: 0.5 } }], selectedId: 'draft-53' }, 'the replaced domain round trips');

  // A caller poking the COPY must not reach the store — not at the top level and
  // not through a nested object.
  scene.pending.push({ itemId: 'draft-99' });
  scene.selectedId = 'draft-99';
  assert.deepEqual(store.get('scene').pending, [{ itemId: 'draft-53', position: { x: 0.125, y: 0.5 } }], 'a mutating caller cannot touch the store through a copy');
  assert.equal(store.get('scene').selectedId, 'draft-53', 'nor through a nested field');

  // ...and the value was copied IN, not filed by reference.
  const draft = { actionId: 'act-1', docStamp: 0 };
  assert.equal(store.set('action', draft).ok, true, 'set() accepts a known domain');
  draft.docStamp = 99;
  assert.equal(store.get('action').docStamp, 0, 'the store copied the value IN, so later caller edits are invisible');

  const patched = store.patch('graph', { dirty: true, name: 'floor.json' });
  assert.deepEqual(patched, { ok: true, domain: 'graph' }, 'patch() reports the domain it merged into');
  assert.deepEqual(store.get('graph'), { dirty: true, name: 'floor.json' }, 'patch() shallow-merges into the domain');
  assert.equal(store.get('scenes'), null, 'an unknown domain reads back as null, not as undefined');
});

test('dirty() transitions: a fresh store is clean, patch dirties, clean() clears just that domain', () => {
  const store = createSessionStore();
  assert.deepEqual(store.dirty(), {
    any: false,
    domains: { scene: false, graph: false, dialogue: false, action: false },
  }, 'a fresh store is clean across every known domain');

  store.patch('scene', { selectedId: 'draft-53' });
  store.patch('dialogue', { dirty: true });
  assert.deepEqual(store.dirty(), {
    any: true,
    domains: { scene: true, graph: false, dialogue: true, action: false },
  }, 'each patch dirties exactly its own domain');

  assert.deepEqual(store.clean('scene'), { ok: true, domain: 'scene', dirty: false }, 'clean() acknowledges the domain');
  assert.deepEqual(store.dirty(), {
    any: true,
    domains: { scene: false, graph: false, dialogue: true, action: false },
  }, 'clean() cleared just scene, dialogue is still dirty');
  assert.equal(store.clean('dialogue').ok, true);
  assert.equal(store.dirty().any, false, 'back to clean');

  assert.deepEqual(store.touch('graph'), { ok: true, domain: 'graph', dirty: true }, 'touch() acknowledges the domain');
  assert.equal(store.dirty().domains.graph, true, 'touch() dirties without touching the data');
  assert.deepEqual(store.get('graph'), { dirty: false }, 'touch() invents no value');

  assert.deepEqual(store.clean('no-such-domain'), { ok: false, code: 'STORE_DOMAIN_UNKNOWN' }, 'an unknown domain is refused');
  assert.deepEqual(store.touch('no-such-domain'), { ok: false, code: 'STORE_DOMAIN_UNKNOWN' }, 'touch() refuses an unknown domain too');
});

test('a mutation + flush() writes a JSON blob that a NEW store over the same storage restores as dirty', () => {
  const storage = createStubStorage();
  const store = createSessionStore({ storage, key: SESSION_KEY_DEFAULT });

  store.patch('scene', { pending: [{ itemId: 'draft-53', position: { x: 0.125, y: 0.5 } }], selectedId: 'draft-53' });
  store.patch('action', { actionId: 'act-7', docStamp: 3 });

  const flushed = store.flush();
  assert.equal(flushed.ok, true, `flush ok (${flushed.code || ''})`);
  assert.ok(flushed.bytes > 0, `flush reports the written size (${flushed.bytes})`);

  const raw = storage.map.get(SESSION_KEY_DEFAULT);
  assert.equal(typeof raw, 'string', 'the persisted blob is a JSON string under the default key');
  const blob = JSON.parse(raw);
  assert.deepEqual(blob.scene, { pending: [{ itemId: 'draft-53', position: { x: 0.125, y: 0.5 } }], selectedId: 'draft-53' }, 'the patched scene domain is in the blob');
  assert.equal(blob.action.docStamp, 3, 'so is the action domain');
  assert.deepEqual(blob.graph, { dirty: false }, 'the untouched graph domain rides along with its default shape');
  assert.equal(blob.dialogue.dirty, false, 'and so does dialogue');

  const revived = createSessionStore({ storage, key: SESSION_KEY_DEFAULT });
  assert.equal(revived.dirty().any, false, 'a fresh store over written storage is clean until it is asked to restore');
  const outcome = revived.restore();
  // the whole state is persisted, so every known domain comes back — and every
  // one of them is dirty, because restored work is unsaved work by definition
  assert.deepEqual(outcome, {
    ok: true,
    restored: true,
    domains: ['scene', 'graph', 'dialogue', 'action'],
    dirty: { scene: true, graph: true, dialogue: true, action: true },
  }, 'restore reports what it adopted and how it is dirty');
  assert.deepEqual(revived.get('scene'), blob.scene, 'the scene domain came back');
  assert.equal(revived.get('action').docStamp, 3, 'the action domain came back');
  assert.equal(revived.dirty().any, true, 'restored work is unsaved work by definition');
  assert.equal(storage.stats.writes, 1, 'restore() re-reads the blob, it never rewrites it');
  assert.equal(storage.stats.removes, 0, 'and never removes it');

  // the restored domains can be re-persisted as an identical blob by the new store
  const again = revived.flush();
  assert.equal(again.ok, true);
  assert.deepEqual(JSON.parse(storage.map.get(SESSION_KEY_DEFAULT)), blob, 'a flush of the restored state reproduces the blob');
});

test('restore() refuses unparseable, shape-wrong and foreign blobs without touching memory', () => {
  const storage = createStubStorage();
  const store = createSessionStore({ storage });
  store.patch('scene', { selectedId: 'draft-53' });
  const pristine = JSON.stringify({ scene: { pending: [], selectedId: 'draft-53' }, graph: { dirty: false }, dialogue: { dirty: false }, action: { actionId: null, docStamp: null } });

  const refusals = [
    ['{ this is not json', 'unparseable storage'],
    [JSON.stringify([1, 2, 3]), 'a JSON array is not a session'],
    [JSON.stringify('scene'), 'a JSON string is not a session'],
    [JSON.stringify(null), 'JSON null is not a session'],
    [JSON.stringify({ scene: 'nope' }), 'a domain of the wrong type'],
    [JSON.stringify({ someoneElse: { pending: [] } }), 'a blob carrying none of the four domains'],
  ];
  for (const [payload, why] of refusals) {
    storage.map.set(SESSION_KEY_DEFAULT, payload);
    assert.deepEqual(store.restore(), { ok: false, code: 'STORE_CORRUPT' }, `refused: ${why}`);
  }
  assert.deepEqual(store.get('scene'), { pending: [], selectedId: 'draft-53' }, 'every refusal left the in-memory state alone');
  assert.deepEqual(store.snapshot(), JSON.parse(pristine), 'and the whole in-memory snapshot is intact');
  assert.equal(store.dirty().any, true, 'refusals do not change the dirty map either');
  assert.equal(storage.stats.removes, 0, 'and never clean up after themselves');

  storage.map.delete(SESSION_KEY_DEFAULT);
  assert.deepEqual(store.restore(), { ok: false, code: 'STORE_EMPTY' }, 'an empty storage is EMPTY, not corrupt');
});

test('restore() drops unknown extra keys and defaults a domain missing from the blob', () => {
  const storage = createStubStorage();
  storage.map.set(SESSION_KEY_DEFAULT, JSON.stringify({
    scene: { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' },
    someoneElsesBlob: { untrusted: true },
  }));
  const store = createSessionStore({ storage });

  const outcome = store.restore();
  assert.equal(outcome.ok, true, `restore ok (${outcome.code || ''})`);
  assert.deepEqual(outcome.domains, ['scene'], 'only the domain the blob actually carried is reported');
  assert.deepEqual(store.get('scene'), { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' }, 'the known domain was adopted');
  assert.deepEqual(store.get('graph'), { dirty: false }, 'a known domain missing from the blob keeps its default');
  assert.deepEqual(store.get('action'), { actionId: null, docStamp: null }, 'action too');
  assert.equal('someoneElsesBlob' in store.snapshot(), false, 'an unknown extra key is dropped, not merged');
  assert.deepEqual(store.dirty().domains, { scene: true, graph: false, dialogue: false, action: false }, 'only the adopted domain is dirty');
});

test('with no storage at all the store still works in memory and flush() says so', () => {
  const store = createSessionStore(); // storage defaults to null: the graceful path
  assert.equal(store.set('scene', { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' }).ok, true, 'set() works without a backend');
  assert.deepEqual(store.get('scene').pending, [{ itemId: 'draft-53' }], 'get() works too');
  assert.equal(store.dirty().domains.scene, true, 'and dirty tracking is unaffected');

  assert.deepEqual(store.flush(), { ok: false, code: 'STORE_UNAVAILABLE' }, 'flush() without a backend reports STORE_UNAVAILABLE');
  assert.deepEqual(store.get('scene').selectedId, 'draft-53', 'the unavailable flush kept the state');

  assert.deepEqual(store.restore(), { ok: false, code: 'STORE_UNAVAILABLE' }, 'restore() too');
  const cleared = store.clear();
  assert.deepEqual(cleared, { ok: true, removed: false }, 'clear() still works, with nothing to remove');
  assert.deepEqual(store.get('scene'), { pending: [], selectedId: null }, 'memory is empty again');
});

test('the injected scheduler arms the debounce, and one window coalesces into ONE flush', () => {
  const storage = createStubStorage();
  const scheduler = createManualScheduler();
  const store = createSessionStore({ storage, schedule: scheduler.schedule, delayMs: 500 });
  assert.equal(scheduler.armed.length, 0, 'nothing is armed before the first mutation');

  store.patch('scene', { selectedId: 'one' });
  assert.equal(scheduler.armed.length, 1, 'the first mutation went through the INJECTED scheduler, not a timer of the store');
  assert.equal(scheduler.armed[0].ms, 500, 'armed with the configured delay');
  assert.equal(storage.stats.writes, 0, 'and wrote nothing yet — that is the whole point of the debounce');

  // Three quick patches = one debounce window (the documented coalescing
  // behaviour: schedule() is armed ONCE per window and flushes ONCE).
  store.patch('scene', { selectedId: 'two' });
  store.patch('dialogue', { dirty: true });
  assert.equal(scheduler.armed.length, 1, 'three quick patches armed the scheduler once, not once per patch');
  assert.equal(storage.stats.writes, 0, 'still nothing written');

  scheduler.armed[0].fn();
  assert.equal(scheduler.armed[0].done, true, 'the armed callback ran');
  assert.equal(storage.stats.writes, 1, 'the armed callback flushed exactly once');
  const blob = JSON.parse(storage.map.get(SESSION_KEY_DEFAULT));
  assert.equal(blob.scene.selectedId, 'two', 'the flush wrote the LATEST state, not the first patch');
  assert.equal(blob.dialogue.dirty, true, 'and carried the dialogue patch along');

  store.patch('graph', { dirty: true });
  assert.equal(scheduler.armed.length, 2, 'the next mutation re-armed a fresh debounce window');
  scheduler.armed[1].fn();
  assert.equal(storage.stats.writes, 2, 'and that window flushed once as well');
});

test('a manual flush() does not un-arm the debounce, and touch() does arm it', () => {
  const storage = createStubStorage();
  const scheduler = createManualScheduler();
  const store = createSessionStore({ storage, schedule: scheduler.schedule, delayMs: 500 });

  store.patch('scene', { selectedId: 'one' });
  assert.equal(store.flush().ok, true, 'an explicit flush writes immediately');
  assert.equal(storage.stats.writes, 1);
  scheduler.armed[0].fn();
  assert.equal(storage.stats.writes, 2, 'the armed callback still runs (idempotently writing the same state)');

  store.clean('scene');
  assert.equal(scheduler.armed.length, 1, 'clean() is pure metadata: it does not arm a flush');
  assert.equal(storage.stats.writes, 2, 'clean() wrote nothing');

  store.touch('graph');
  assert.equal(scheduler.armed.length, 2, 'touch() does arm a flush — marking dirty must persist');
  scheduler.armed[1].fn();
  assert.equal(storage.stats.writes, 3, 'that flush ran');
  assert.equal(JSON.parse(storage.map.get(SESSION_KEY_DEFAULT)).graph.dirty, false, 'the written value is the data, which touch() never changed');
});

test('without an injected scheduler the default one debounces on setTimeout', async () => {
  const storage = createStubStorage();
  const store = createSessionStore({ storage, delayMs: 5 });
  store.patch('scene', { selectedId: 'draft-53' });
  assert.equal(storage.stats.writes, 0, 'the default scheduler debounces too');

  await sleep(40);
  assert.equal(storage.stats.writes, 1, 'the timer fired once and wrote');
  assert.equal(JSON.parse(storage.map.get(SESSION_KEY_DEFAULT)).scene.selectedId, 'draft-53', 'with the final state');
});

test('with no setTimeout the default scheduler flushes inline', () => {
  const realSetTimeout = globalThis.setTimeout;
  const storage = createStubStorage();
  globalThis.setTimeout = undefined;
  try {
    const store = createSessionStore({ storage });
    store.patch('scene', { selectedId: 'draft-53' });
    assert.equal(storage.stats.writes, 1, 'without a timer platform the mutation persisted inline');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('clear() empties memory and (by default) the persisted copy, and cannot be resurrected by a stale timer', () => {
  const storage = createStubStorage();
  const scheduler = createManualScheduler();
  const store = createSessionStore({ storage, schedule: scheduler.schedule });

  store.patch('scene', { pending: [{ itemId: 'draft-53' }] });
  store.flush();
  assert.equal(storage.map.has(SESSION_KEY_DEFAULT), true, 'something was persisted');

  assert.deepEqual(store.clear(), { ok: true, removed: true }, 'clear() reports that it removed the persisted copy');
  assert.deepEqual(store.get('scene'), { pending: [], selectedId: null }, 'memory is back to the empty default');
  assert.deepEqual(store.dirty(), { any: false, domains: { scene: false, graph: false, dialogue: false, action: false } }, 'everything is clean');
  assert.equal(storage.map.has(SESSION_KEY_DEFAULT), false, 'the persisted copy is gone');
  assert.equal(storage.stats.removes, 1, 'removed through the injected storage');

  scheduler.armed[0].fn(); // the debounce armed BEFORE the clear
  assert.equal(storage.map.has(SESSION_KEY_DEFAULT), false, 'the stale timer did not resurrect the cleared blob');

  // and an explicit opt-out keeps the blob
  store.patch('scene', { selectedId: 'draft-53' });
  store.flush();
  assert.equal(storage.map.has(SESSION_KEY_DEFAULT), true, 'a new blob was written');
  assert.deepEqual(store.clear({ storageToo: false }), { ok: true, removed: false }, 'storageToo:false keeps the persisted copy');
  assert.equal(storage.stats.removes, 1, 'and really did not remove anything');
  assert.equal(storage.map.has(SESSION_KEY_DEFAULT), true, 'the blob survived');
  assert.deepEqual(store.get('scene'), { pending: [], selectedId: null }, 'memory was still emptied');
});

test('a throwing listener does not break the store or the other listeners', () => {
  const store = createSessionStore();
  const seen = [];
  store.subscribe(() => { throw new Error('the listener blew up'); }); // must be inert
  store.subscribe((event) => seen.push(event));

  store.patch('scene', { selectedId: 'draft-53' });
  store.clean('scene');
  assert.deepEqual(seen, [
    { domain: 'scene', dirty: true },
    { domain: 'scene', dirty: false },
  ], 'the store kept notifying after a listener threw, with the domain and its new flag');
  assert.equal(store.dirty().domains.scene, false, 'and kept working');

  const third = [];
  const off = store.subscribe((event) => third.push(event));
  store.patch('graph', { dirty: true });
  off();
  off(); // unsubscribing twice is a no-op, not a throw
  store.patch('dialogue', { dirty: true });
  assert.deepEqual(third, [{ domain: 'graph', dirty: true }], 'the unsubscribed listener stopped receiving events');
  assert.equal(store.get('dialogue').dirty, true, 'the store is unharmed throughout');

  store.subscribe('not a function'); // a bad listener is ignored, not a throw
  assert.equal(store.get('graph').dirty, true);
});

test('set() with an unknown domain is refused and changes nothing', () => {
  const storage = createStubStorage();
  const scheduler = createManualScheduler();
  const store = createSessionStore({ storage, schedule: scheduler.schedule });
  store.patch('scene', { selectedId: 'draft-53' });
  const before = store.snapshot();
  const beforeDirty = store.dirty();

  const outcome = store.set('scenee', { pending: [] });
  assert.deepEqual(outcome, { ok: false, code: 'STORE_DOMAIN_UNKNOWN' }, 'a typo is a refusal, not a new domain');
  assert.deepEqual(store.snapshot(), before, 'the state is untouched');
  assert.deepEqual(store.dirty(), beforeDirty, 'and so is the dirty map');
  assert.equal(scheduler.armed.length, 1, 'no extra debounce was armed');
  assert.equal(storage.stats.writes, 0, 'and nothing was written');
  assert.equal(store.get('scenee'), null, 'the typo never became a domain');
});

test('patch() may introduce a domain the store does not know yet, and it becomes first-class', () => {
  const store = createSessionStore({ storage: createStubStorage() });
  assert.equal(store.get('library'), null, 'not a known domain to begin with');

  assert.deepEqual(store.patch('library', { filter: '最近', page: 1 }), { ok: true, domain: 'library' }, 'patch() is the one way a new domain enters');
  assert.deepEqual(store.get('library'), { filter: '最近', page: 1 }, 'and it reads back');
  assert.equal(store.dirty().domains.library, true, 'the new domain takes part in dirty()');
  assert.equal(store.set('library', { filter: '全部', page: 2 }).ok, true, 'set() now accepts the introduced domain');
  assert.deepEqual(store.get('library'), { filter: '全部', page: 2 }, 'and set() replaces it wholesale');
});

test('a non-object value is refused instead of corrupting a domain', () => {
  const storage = createStubStorage();
  const store = createSessionStore({ storage });
  store.patch('scene', { selectedId: 'draft-53' });
  const before = store.snapshot();

  assert.deepEqual(store.set('scene', 'nope'), { ok: false, code: 'STORE_VALUE_INVALID' }, 'a string is not a domain');
  assert.deepEqual(store.set('scene', null), { ok: false, code: 'STORE_VALUE_INVALID' }, 'neither is null');
  assert.deepEqual(store.set('scene', []), { ok: false, code: 'STORE_VALUE_INVALID' }, 'an array is not a plain object');
  assert.deepEqual(store.patch('graph', 7), { ok: false, code: 'STORE_VALUE_INVALID' }, 'same for patch()');
  assert.deepEqual(store.snapshot(), before, 'nothing moved');
  assert.equal(storage.stats.writes, 0, 'and nothing was written');
});

test('an unserialisable value makes flush() report STORE_SERIALISE_FAILED without throwing', () => {
  const storage = createStubStorage();
  const store = createSessionStore({ storage });
  store.set('scene', { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' });
  assert.equal(store.flush().ok, true, 'the state started serialisable');
  const good = storage.map.get(SESSION_KEY_DEFAULT);

  store.patch('scene', { docStamp: 1n }); // a BigInt: JSON.stringify throws on it
  assert.equal(store.get('scene').docStamp, 1n, 'the unserialisable value is still in memory, kept intact');

  const failed = store.flush();
  assert.deepEqual(failed, { ok: false, code: 'STORE_SERIALISE_FAILED' }, 'the failure is a result, not a throw');
  assert.equal(storage.stats.writes, 1, 'nothing was overwritten');
  assert.equal(storage.map.get(SESSION_KEY_DEFAULT), good, 'the last good blob is exactly where it was');
  assert.deepEqual(store.get('scene').pending, [{ itemId: 'draft-53' }], 'the rest of the state is still there');

  // dropping the bad value restores persistence without losing anything else
  store.set('scene', { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' });
  assert.equal(store.flush().ok, true, 'flush() works again once the value is serialisable');
});

test('a storage that throws is reported, never thrown at the caller', () => {
  const hostile = {
    getItem() { throw new Error('cookies blocked'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('cookies blocked'); },
  };
  const store = createSessionStore({ storage: hostile });
  store.patch('scene', { selectedId: 'draft-53' });
  assert.deepEqual(store.restore(), { ok: false, code: 'STORE_UNAVAILABLE' }, 'a throwing getItem() is an unavailable storage');
  assert.deepEqual(store.flush(), { ok: false, code: 'STORE_WRITE_FAILED' }, 'a quota-exceeded setItem() is reported as a write failure');
  assert.deepEqual(store.clear(), { ok: true, removed: false }, 'a failing removeItem() is not a failure of clear()');
  assert.deepEqual(store.get('scene'), { pending: [], selectedId: null }, 'the store is still fully usable afterwards');
});

test('two stores never share state, and a reset domain is a real copy of the default', () => {
  const a = createSessionStore();
  const b = createSessionStore();
  a.set('scene', { pending: [{ itemId: 'draft-53' }], selectedId: 'draft-53' });
  assert.deepEqual(b.get('scene'), { pending: [], selectedId: null }, 'another instance is untouched');

  // through patch()'s merge path back to the empty shape, then corrupt the copy
  a.patch('scene', { pending: [], selectedId: null });
  a.get('scene').pending.push({ itemId: 'draft-99' });
  assert.deepEqual(a.get('scene'), { pending: [], selectedId: null }, 'the default is not shared with the returned copy');
  assert.deepEqual(b.get('scene'), { pending: [], selectedId: null }, 'nor with another instance');
  assert.deepEqual(SESSION_DOMAINS, ['scene', 'graph', 'dialogue', 'action'], 'the four domains are exported and fixed');
});
