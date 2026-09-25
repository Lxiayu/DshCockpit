'use strict';

// src/office/runtime/pending-mirror.js — pre-module pending mirror (P1 data
// pipeline, docs/strategy/2026-09-23-office-right-panel-spec.md §4).
//
// The office module is created lazily (the first time the office view opens),
// so runtime waterfall requests (approval/request, user-questions/request) can
// arrive while no module exists — and "the approval that arrived before you
// opened the office" is exactly the one the user most needs to see, along with
// the "需要你" badge. This mirror is the holding pen for that window:
//
//   - lightweight and bounded (default 50 entries, oldest evicted) — it stores
//     the normalized arrival record only, never a simulation, never a tick;
//   - idempotent on the arrival's stable id (eventId, else rpcId): a
//     re-delivered event never occupies two slots;
//   - seeded into the office module the moment it is created (main.js
//     ensureOfficeModule), after which the module is the single live store and
//     the mirror stays empty;
//   - removable by any id the runtime echoes back (the waterfall eventId on
//     0.1.5 mux, the server-request rpcId on 0.1.1), so an answer that lands
//     through the shared respondToRuntime path before the module exists drops
//     the mirrored request instead of resurrecting it on seed.
//
// Pure deterministic CommonJS: no Electron, DOM, filesystem or clock access
// (the caller stamps atMs).

const DEFAULT_LIMIT = 50;

/** The stable mirror key of an arrival record: the waterfall eventId when the
 * runtime supplies one, else the routing rpcId. */
function keyOf(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.eventId === 'string' && record.eventId !== '') return record.eventId;
  if (typeof record.rpcId === 'string' && record.rpcId !== '') return record.rpcId;
  return null;
}

function createPendingMirror(options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : DEFAULT_LIMIT;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const records = new Map(); // mirror key -> normalized arrival record

  return {
    limit,

    size() {
      return records.size;
    },

    has(key) {
      return records.has(key);
    },

    /** Record one arrival. The record is stored verbatim (normalized by the
     * caller); this function only enforces the stable-id contract and the
     * bound. @returns {{ok: boolean, status?: 'added'|'duplicate', key?: string,
     * record?: object, code?: string}} */
    note(record) {
      const key = keyOf(record);
      if (!key) return { ok: false, code: 'EVENT_ID_MISSING' };
      if (records.has(key)) {
        return { ok: true, status: 'duplicate', key, record: records.get(key) };
      }
      while (records.size >= limit) {
        const oldest = records.keys().next().value;
        records.delete(oldest);
        log(`[office] pending mirror backlog truncated (dropped ${oldest})`);
      }
      records.set(key, record);
      return { ok: true, status: 'added', key, record };
    },

    /** Remove by any runtime-echoed id (eventId or rpcId). Returns the removed
     * record, or null. */
    resolve(id) {
      if (typeof id !== 'string' || id === '') return null;
      if (!records.has(id)) return null;
      const record = records.get(id);
      records.delete(id);
      return record;
    },

    /** Replay every held record into the office module's notePendingRequest
     * and hand the live store over to it. Records the module REJECTS (it
     * validates kind/shape itself) stay in the mirror rather than being lost.
     * @returns {{seeded: number, failed: number}} */
    seed(noteRequest) {
      if (typeof noteRequest !== 'function') return { seeded: 0, failed: records.size };
      let seeded = 0;
      let failed = 0;
      for (const [key, record] of [...records]) {
        let res = null;
        try {
          res = noteRequest(record);
        } catch (error) {
          res = null;
          log(`[office] pending mirror seed failed for ${key}: ${error && error.message}`);
        }
        if (res && res.ok) {
          records.delete(key); // the module owns this request from now on
          seeded += 1;
        } else {
          failed += 1;
        }
      }
      return { seeded, failed };
    },

    /** Drop everything (used by tests and by a module teardown). */
    clear() {
      records.clear();
    },

    /** Defensive copy of the held records (main-process debugging only; never
     * part of any snapshot). */
    records() {
      return [...records.values()].map((record) => ({ ...record }));
    },
  };
}

module.exports = { createPendingMirror, keyOf, DEFAULT_LIMIT };
