'use strict';

// src/workbench/app/store.js — the workbench session store (rectification plan
// task T5, 2026-09-29).
//
// WHY this exists: src/workbench/workbench.js (~3300 lines of renderer) keeps
// its per-page editing state in plain closure variables — the scene `pending`
// Map of unsaved furniture moves, graphState.dirty, dialogueState.dirty and the
// action editor's in-flight draft. None of it survives a shell reload, no page
// has a beforeunload/pagehide handler, and the hot-reload refresh wipes the lot
// on purpose. T5's fix is ONE store every page shares:
//
//   未保存草稿持久化：统一 store 持有会话状态；变更（防抖 500ms）写 sessionStorage；
//   shell 启动时恢复并显示「已恢复未保存改动」；热重载刷新前先比对脏标记，脏则跳过
//   刷新并提示
//
// This module is the STORE ONLY, and it is deliberately pure — no DOM, no IPC,
// no file system, and no timers and no sessionStorage of its own:
//   * `schedule` and `storage` are INJECTED. The renderer passes its debounce
//     scheduler and window.sessionStorage; a test passes a manual scheduler and
//     a stub. That is what makes the 500ms debounce testable without waiting
//     500ms, and what lets a missing, throwing or full sessionStorage degrade
//     to a memory-only store instead of throwing into a live editor;
//   * every value is deep-copied IN and OUT, so neither the caller's object nor
//     a leaked get() result can mutate the store by accident;
//   * every failure is a { ok: false, code } result, never a throw;
//   * the store's dirty flags are per-instance session metadata. They are NOT
//     part of the persisted blob (restore() marks everything dirty by
//     definition) and clean() never writes.
//
// Wiring is the caller's job and not this module's: the shell creates ONE store,
// routes scene/graph/dialogue/action edits through patch(), calls clean() after
// a successful save, asks dirty().any before letting the hot-reload refresh
// through (脏则跳过刷新并提示) and flush()es on pagehide.

const SESSION_KEY_DEFAULT = 'wb-session-v1';
const SESSION_DELAY_MS_DEFAULT = 500;

// The four domains the shell owns today. The shapes are the shell's contract
// (src/workbench/workbench.js), not this module's guess:
//   scene    the unsaved furniture moves, as an ARRAY of edits. The shell's
//            closure holds a Map keyed by itemId and a Map is not
//            JSON-serialisable (it cannot survive a reload), so the caller
//            converts — e.g. [{ itemId, position, scale, hidden }];
//   graph    the graph document, whose `dirty` flag the shell already keeps;
//   dialogue the dialogue document, same story;
//   action   the action editor's in-flight draft identity.
// patch() may ADD further domains (see below); set() only accepts a domain the
// store already knows.
const DOMAIN_DEFAULTS = Object.freeze({
  scene: { pending: [], selectedId: null },
  graph: { dirty: false },
  dialogue: { dirty: false },
  action: { actionId: null, docStamp: null },
});
const SESSION_DOMAINS = Object.freeze(Object.keys(DOMAIN_DEFAULTS));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Deep copy of JSON-shaped data: arrays, plain objects, Dates go through a real
// copy; everything else (primitives, functions, BigInt) passes through as-is.
// It NEVER throws — a value JSON cannot serialise must stay storable long
// enough for flush() to report STORE_SERIALISE_FAILED, not blow up a get().
// Cycles cannot be persisted either, so they collapse to null instead of
// hanging; the WeakSet is unwound on the way out so shared (non-cyclic)
// references are still copied in place.
function deepCopy(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => deepCopy(entry, seen));
    if (value instanceof Date) return new Date(value.getTime());
    const copy = {};
    for (const name of Object.keys(value)) copy[name] = deepCopy(value[name], seen);
    return copy;
  } finally {
    seen.delete(value);
  }
}

function defaultDomainValue(domain) {
  return Object.prototype.hasOwnProperty.call(DOMAIN_DEFAULTS, domain) ? deepCopy(DOMAIN_DEFAULTS[domain]) : {};
}

// `bytes` is what actually landed in the storage: UTF-8 bytes when the platform
// can measure them (identical to .length for the ASCII JSON this writes when it
// cannot).
function byteLength(text) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  return text.length;
}

// The default debounce: the store never touches a timer itself, it asks this.
// With no timer platform at all the write happens inline, because a mutation
// that cannot be deferred must still be persisted.
function defaultSchedule(fn, ms) {
  if (typeof setTimeout === 'function') return setTimeout(fn, ms);
  fn();
  return null;
}

// A storage-like object is anything with getItem/setItem. Anything else
// (null, a stub without the methods) means memory-only, which is the graceful
// degradation path — not an error.
function usableStorage(candidate) {
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate.getItem !== 'function' || typeof candidate.setItem !== 'function') return null;
  return candidate;
}

function createSessionStore({ storage = null, key = SESSION_KEY_DEFAULT, schedule = null, delayMs = SESSION_DELAY_MS_DEFAULT } = {}) {
  const backend = usableStorage(storage);
  const scheduler = typeof schedule === 'function' ? schedule : defaultSchedule;

  // `domains` starts at the four known ones; patch() may add more, and an added
  // domain is first-class from then on (get/set/touch/clean/dirty all see it).
  const domains = new Set(SESSION_DOMAINS);
  const state = {};
  const dirtyMap = new Map(); // domain → boolean (never persisted)
  const listeners = new Set();

  // Coalescing (防抖): at most ONE armed flush per window. `epoch` invalidates
  // an armed flush when clear()/restore() has since superseded it — there is no
  // cancel API, so the callback checks before it writes.
  let inFlight = false;
  let epoch = 0;

  function seedState() {
    for (const domain of SESSION_DOMAINS) {
      state[domain] = defaultDomainValue(domain);
      dirtyMap.set(domain, false);
    }
  }
  seedState();

  function known(domain) {
    return typeof domain === 'string' && domains.has(domain);
  }

  function notify(domain, flag) {
    // Snapshot the listener set: a listener may unsubscribe while being called.
    for (const listener of Array.from(listeners)) {
      try {
        listener({ domain, dirty: flag });
      } catch {
        // A broken listener must not break the store, and must not stop the
        // others either.
      }
    }
  }

  function scheduleFlush() {
    if (inFlight) return; // already armed inside this debounce window
    const armedAtEpoch = epoch;
    inFlight = true;
    try {
      scheduler(() => {
        inFlight = false;
        if (epoch !== armedAtEpoch) return; // clear()/restore() superseded us
        flush(); // the SAME path a manual flush() takes; the result is internal
      }, delayMs);
    } catch {
      // A scheduler that refuses to run must not eat the mutation it was meant
      // to persist; the next mutation re-arms.
      inFlight = false;
    }
  }

  // `arm` is false for clean(): cleaning is pure in-memory metadata (the dirty
  // flags are never persisted), so it must not wake the debounce up.
  function mutate(domain, next, flag, { arm = true } = {}) {
    state[domain] = next;
    dirtyMap.set(domain, flag);
    notify(domain, flag);
    if (arm) scheduleFlush();
  }

  function get(domain) {
    if (!known(domain)) return null;
    return deepCopy(state[domain]);
  }

  function set(domain, value) {
    if (!known(domain)) return { ok: false, code: 'STORE_DOMAIN_UNKNOWN' };
    if (!isPlainObject(value)) return { ok: false, code: 'STORE_VALUE_INVALID' };
    // Wholesale replace (patch() is the merge). A missing key is gone: set()
    // does not know about the domain's shape and must not invent keys.
    mutate(domain, deepCopy(value), true);
    return { ok: true, domain };
  }

  function patch(domain, partial) {
    if (typeof domain !== 'string') return { ok: false, code: 'STORE_DOMAIN_UNKNOWN' };
    if (!isPlainObject(partial)) return { ok: false, code: 'STORE_VALUE_INVALID' };
    // Shallow merge, and the one way a NEW domain enters the store (a caller may
    // need a domain the four do not cover without touching this module).
    domains.add(domain);
    if (!dirtyMap.has(domain)) dirtyMap.set(domain, false);
    mutate(domain, { ...state[domain], ...deepCopy(partial) }, true);
    return { ok: true, domain };
  }

  function touch(domain) {
    if (!known(domain)) return { ok: false, code: 'STORE_DOMAIN_UNKNOWN' };
    // touch() arms a flush because the whole point of marking dirty is that the
    // next debounce must write it.
    mutate(domain, state[domain], true);
    return { ok: true, domain, dirty: true };
  }

  function clean(domain) {
    if (!known(domain)) return { ok: false, code: 'STORE_DOMAIN_UNKNOWN' };
    // No flush here: the dirty flags are not persisted, so cleaning changes
    // nothing on disk. An already-armed debounce still writes the DATA, which
    // is what it should do.
    mutate(domain, state[domain], false, { arm: false });
    return { ok: true, domain, dirty: false };
  }

  function dirty() {
    const domainsOut = {};
    let any = false;
    for (const domain of domains) {
      const flag = dirtyMap.get(domain) === true;
      domainsOut[domain] = flag;
      if (flag) any = true;
    }
    return { any, domains: domainsOut };
  }

  function flush() {
    if (!backend) return { ok: false, code: 'STORE_UNAVAILABLE' };
    let json;
    try {
      json = JSON.stringify(state);
    } catch {
      // The in-memory state is untouched: the caller keeps working and can
      // decide what to do about the unserialisable value.
      return { ok: false, code: 'STORE_SERIALISE_FAILED' };
    }
    try {
      backend.setItem(key, json);
    } catch {
      // QuotaExceededError and friends: reported, never thrown.
      return { ok: false, code: 'STORE_WRITE_FAILED' };
    }
    return { ok: true, bytes: byteLength(json) };
  }

  function restore() {
    if (!backend) return { ok: false, code: 'STORE_UNAVAILABLE' };
    let raw;
    try {
      raw = backend.getItem(key);
    } catch {
      return { ok: false, code: 'STORE_UNAVAILABLE' };
    }
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, code: 'STORE_EMPTY' };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, code: 'STORE_CORRUPT' };
    }
    if (!isPlainObject(parsed)) return { ok: false, code: 'STORE_CORRUPT' };
    const present = SESSION_DOMAINS.filter((domain) => Object.prototype.hasOwnProperty.call(parsed, domain));
    if (present.length === 0) return { ok: false, code: 'STORE_CORRUPT' };
    for (const domain of present) {
      if (!isPlainObject(parsed[domain])) return { ok: false, code: 'STORE_CORRUPT' };
    }
    // Everything validated: adopt wholesale. Unknown extra keys are DROPPED
    // (refused, not merged — a blob written by someone else stays theirs), a
    // known domain missing from the blob keeps its default, and every adopted
    // domain is dirty: restored work is unsaved work by definition. Nothing is
    // written back (restore() never re-persists what it just read).
    epoch += 1;
    for (const domain of domains) {
      state[domain] = defaultDomainValue(domain);
      dirtyMap.set(domain, false);
    }
    for (const domain of present) {
      state[domain] = deepCopy(parsed[domain]);
      dirtyMap.set(domain, true);
    }
    for (const domain of present) notify(domain, true);
    return { ok: true, restored: true, domains: present, dirty: dirty().domains };
  }

  function clear({ storageToo = true } = {}) {
    epoch += 1; // any armed debounce is now stale and must not resurrect the blob
    for (const domain of Array.from(domains)) {
      state[domain] = defaultDomainValue(domain);
      dirtyMap.set(domain, false);
    }
    let removed = false;
    if (storageToo && backend && typeof backend.removeItem === 'function') {
      try {
        backend.removeItem(key);
        removed = true;
      } catch {
        removed = false;
      }
    }
    for (const domain of Array.from(domains)) notify(domain, false);
    return { ok: true, removed };
  }

  function snapshot() {
    return deepCopy(state);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener); // calling it twice is a no-op
    };
  }

  return {
    get,
    set,
    patch,
    dirty,
    touch,
    clean,
    flush,
    restore,
    clear,
    snapshot,
    subscribe,
  };
}

// dual module (the house pattern, see i18n.js): require()-able from Node AND loadable as a
// classic script in the page, where a bare `module.exports` would be a ReferenceError.
const wbSessionStoreApi = { SESSION_KEY_DEFAULT, SESSION_DELAY_MS_DEFAULT, SESSION_DOMAINS, createSessionStore };
if (typeof window !== 'undefined') window.wbSessionStore = wbSessionStoreApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbSessionStoreApi;
