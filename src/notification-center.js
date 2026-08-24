// src/notification-center.js — R6 unified notification hub.
//
// Every shell notification flows through enqueue(): the event sources keep
// their logic, the hub decides whether the OS toast actually fires and keeps
// a searchable JSONL history. Design contract (PREDEV §3 B3/R6):
//   - default posture is PASS-THROUGH: with every rule off, behaviour is
//     byte-for-byte what it was before the hub existed
//   - rules: per-kind switches, do-not-disturb time window (default off),
//     same-key folding inside a 60s window (default off)
//   - history is always recorded while the hub is enabled (writing a file has
//     no user-visible difference); capped at MAX_HISTORY entries
//   - hub disabled entirely -> straight pass-through, no history, zero new
//     failure paths (C-6)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_HISTORY = 500;
const FOLD_WINDOW_MS = 60_000;
const KINDS = ['approval', 'completion', 'question', 'budget', 'system'];

/** Parse 'HH:MM-HH:MM' into minute numbers; supports windows crossing
 * midnight ('23:00-07:00'). Returns null on any malformed input. */
function parseDndWindow(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const toMin = (h, mm) => Number(h) * 60 + Number(mm);
  const start = toMin(m[1], m[2]);
  const end = toMin(m[3], m[4]);
  if (start > 1440 || end > 1440 || (m[1].length === 2 && Number(m[1]) > 23)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return null;
  return [start, end];
}

/** Is `minutes` (minutes since midnight) inside the parsed window? */
function inDndWindow(minutes, win) {
  if (!win) return false;
  const [s, e] = win;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // crosses midnight
}

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings        settings snapshot
 * @param {() => string} deps.historyFile        userData/notification-history.jsonl
 * @param {({title:string, body:string}) => void} deps.showSystem  OS toast sink
 * @param {() => number} [deps.now]              injectable clock (ms)
 * @param {(line:string)=>void} [deps.log]
 */
function createNotificationCenter({ getSettings, historyFile, showSystem, now = () => Date.now(), log = () => {} }) {
  let lastShownKey = null; // folding state: key of the last SHOWN toast
  let lastShownAt = 0;

  // ------------------------------------------------------------- history io
  function readEntries() {
    try {
      const raw = fs.readFileSync(historyFile(), 'utf8');
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
      return out;
    } catch { return []; }
  }

  function writeEntries(entries) {
    try {
      fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
      const tmp = `${historyFile()}.tmp`;
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
      fs.renameSync(tmp, historyFile());
    } catch (err) { log(`[notif] history write failed: ${err.message}`); }
  }

  /** Append one entry; cap the file at MAX_HISTORY by rewriting when over. */
  function appendHistory(entry) {
    const entries = readEntries();
    entries.push(entry);
    writeEntries(entries.length > MAX_HISTORY ? entries.slice(-MAX_HISTORY) : entries);
  }

  // ----------------------------------------------------------------- rules
  function evaluate(kind) {
    const cfg = getSettings() || {};
    if (Array.isArray(cfg.notifKindsDisabled) && cfg.notifKindsDisabled.includes(kind)) {
      return { shown: false, reason: 'kind-disabled' };
    }
    if (cfg.notifDndEnabled) {
      const win = parseDndWindow(cfg.notifDndWindow || '23:00-07:00');
      const d = new Date(now());
      const minutes = d.getHours() * 60 + d.getMinutes();
      if (inDndWindow(minutes, win)) return { shown: false, reason: 'dnd' };
    }
    return { shown: true, reason: '' };
  }

  // ------------------------------------------------------------------- api
  return {
    KINDS,

    /**
     * Route one notification. Always records history (while enabled), decides
     * whether the OS toast fires. Never throws.
     * @returns {{shown: boolean, reason: string}}
     */
    enqueue({ kind = 'system', title, body = '' }) {
      const safeKind = KINDS.includes(kind) ? kind : 'system';
      // master switch off → legacy behaviour exactly: direct toast, no rules,
      // no history file ever created (C-6: no new failure paths)
      if ((getSettings() || {}).notificationCenterEnabled === false) {
        try { showSystem({ title, body }); } catch (err) { log(`[notif] show failed: ${err.message}`); }
        return { shown: true, reason: 'hub-disabled-passthrough' };
      }
      const verdict = evaluate(safeKind);
      try {
        appendHistory({ ts: new Date(now()).toISOString(), kind: safeKind, title: String(title || ''), body: String(body), shown: verdict.shown });
      } catch (err) { log(`[notif] history failed: ${err.message}`); }

      if (!verdict.shown) return verdict;

      // folding: identical key within the window is suppressed (still in history)
      if ((getSettings() || {}).notifFoldEnabled) {
        const key = `${safeKind}:${String(title || '')}`;
        if (key === lastShownKey && now() - lastShownAt < FOLD_WINDOW_MS) {
          return { shown: false, reason: 'folded' };
        }
        lastShownKey = key;
        lastShownAt = now();
      }

      try { showSystem({ title, body }); } catch (err) { log(`[notif] show failed: ${err.message}`); }
      return { shown: true, reason: verdict.reason };
    },

    /** Searchable history, newest first. */
    list({ query = '', kind = '', limit = 100 } = {}) {
      const q = String(query).toLowerCase();
      let entries = readEntries().reverse(); // newest first
      if (kind && KINDS.includes(kind)) entries = entries.filter((e) => e.kind === kind);
      if (q) entries = entries.filter((e) => `${e.title}\n${e.body}`.toLowerCase().includes(q));
      return entries.slice(0, Math.max(1, Math.min(limit, 500)));
    },

    clear() {
      try { writeEntries([]); return { ok: true }; }
      catch (err) { return { ok: false, reason: err.message }; }
    },
  };
}

module.exports = { createNotificationCenter, parseDndWindow, inDndWindow, KINDS, MAX_HISTORY, FOLD_WINDOW_MS };
