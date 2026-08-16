// src/cost.js — token->cost estimation, daily history, and budget checks.
//
// Rates are user-configurable estimates (settings.costInputPerM etc.); the
// numbers shown are labeled as estimates, never as official billing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_MAX_DAYS = 90;

// Peak/off-peak pricing windows (Beijing time). Each entry is an hour range
// [start, end) — left-closed, right-open. Defaults follow DeepSeek's peak
// hours (9-12 and 14-18 Beijing time); user-configurable as a string.
const DEFAULT_WINDOWS = [[9, 12], [14, 18]];

// In-memory cache of the parsed history file so the 5s token poll does not
// re-read + JSON.parse the whole file every tick (perf #5). Keyed by path;
// invalidated by mtime. Cleared after updateHistory writes.
const historyCache = new Map(); // file -> { mtimeMs, history }

function todayKey() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function costOf(usage, rates) {
  const perM = (n, rate) => (n || 0) * (rate || 0) / 1e6;
  return perM(usage.input, rates.inputPerM)
    + perM(usage.output, rates.outputPerM)
    + perM(usage.cacheRead, rates.cacheReadPerM)
    + perM(usage.cacheWrite, rates.cacheWritePerM);
}

/** Parse a windows string like "9-12,14-18" into [[9,12],[14,18]] (Beijing
 * hours, left-closed/right-open). A single hour "9" means [9,10). Returns
 * null for anything invalid (out-of-range, NaN, empty). */
function parseWindows(str) {
  if (typeof str !== 'string' || !str.trim()) return null;
  const out = [];
  for (const segRaw of str.split(',')) {
    const seg = segRaw.trim();
    const m = seg.match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start + 1 : Number(m[2]);
    if (!(start >= 0 && start < 24) || !(end > start && end <= 24)) return null;
    out.push([start, end]);
  }
  return out.length ? out : null;
}

/** True when the epoch-ms timestamp falls inside a peak window (Beijing time). */
function isPeakTime(ms, windows) {
  if (!windows || !windows.length) return false;
  const h = Math.floor(((ms / 3_600_000) % 24 + 8 + 24) % 24);
  return windows.some(([s, e]) => h >= s && h < e);
}

/** Current peak state plus the minutes (floored) until the next window
 * boundary switch — drives the tray's "off-peak in Xm" line. */
function peakStatus(nowMs, windows) {
  const minuteOfDay = Math.floor(((nowMs / 60_000) % 1440 + 480 + 1440) % 1440);
  const hour = Math.floor(minuteOfDay / 60);
  const peak = isPeakTime(nowMs, windows);
  let nextChangeInMin = 0;
  if (peak) {
    let best = Infinity;
    for (const [s, e] of windows) {
      if (minuteOfDay >= s * 60 && minuteOfDay < e * 60) best = Math.min(best, e * 60 - minuteOfDay);
    }
    nextChangeInMin = best === Infinity ? 0 : Math.max(0, Math.floor(best));
  } else if (windows && windows.length) {
    let best = Infinity;
    for (const [s] of windows) {
      const d = (s * 60 - minuteOfDay + 1440) % 1440;
      if (d > 0) best = Math.min(best, d);
    }
    nextChangeInMin = best === Infinity ? 0 : Math.floor(best);
  }
  return { peak, hour, nextChangeInMin };
}

/** costOf split into peak/off-peak. When `totals` carries peak/offPeak
 * sub-buckets, the peak bucket is priced at `peakRates` (falling back to
 * `rates` when the peak rate set is empty) and off-peak at `rates`; without
 * sub-buckets everything is off-peak at flat rates. */
function costOfSplit(totals, rates, peakRates) {
  if (!totals || !totals.peak || !totals.offPeak) {
    const offPeak = costOf(totals, rates);
    return { peak: 0, offPeak, total: offPeak };
  }
  const hasPeakRate = peakRates
    && (peakRates.inputPerM || peakRates.outputPerM || peakRates.cacheReadPerM || peakRates.cacheWritePerM);
  const peak = costOf(totals.peak, hasPeakRate ? peakRates : rates);
  const offPeak = costOf(totals.offPeak, rates);
  return { peak, offPeak, total: peak + offPeak };
}

/** Load or create the daily history file (array of {date, input, output, cacheRead, cacheWrite, sessions, cost}). */
function loadHistory(file) {
  let st;
  try { st = fs.statSync(file); } catch {
    // file missing — drop any stale cache entry
    historyCache.delete(file);
    return [];
  }
  const hit = historyCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.history;
  let history = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) history = raw;
  } catch { /* first run / corrupt */ }
  // keep a defensive copy so callers can't mutate the cached array
  history = history.map((h) => ({ ...h }));
  historyCache.set(file, { mtimeMs: st.mtimeMs, history });
  return history;
}

/** Upsert today's entry; prune entries older than HISTORY_MAX_DAYS. */
function updateHistory(file, entry) {
  let history = loadHistory(file);
  const key = todayKey();
  const idx = history.findIndex((h) => h.date === key);
  if (idx === -1) history.push({ date: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0 });
  const cur = history[idx === -1 ? history.length - 1 : idx];
  cur.input = entry.input; cur.output = entry.output;
  cur.cacheRead = entry.cacheRead; cur.cacheWrite = entry.cacheWrite;
  cur.sessions = entry.sessions; cur.cost = entry.cost;
  cur.peakCost = entry.peakCost ?? 0;
  const cutoff = new Date(Date.now() - HISTORY_MAX_DAYS * 86_400_000);
  history = history.filter((h) => !h.date || new Date(h.date + 'T00:00:00') >= cutoff);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
  // refresh cache so the next loadHistory reuses the just-written data
  try {
    const st = fs.statSync(file);
    historyCache.set(file, { mtimeMs: st.mtimeMs, history: history.map((h) => ({ ...h })) });
  } catch { historyCache.delete(file); }
  return history;
}

/** Sum history over the last `days` days (most recent N distinct dates). */
function summarize(history, days) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0, peakCost: 0 };
  const seen = new Set();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (!h || !h.date) continue;
    if (seen.size >= days) break;
    seen.add(h.date);
    out.input += h.input || 0; out.output += h.output || 0;
    out.cacheRead += h.cacheRead || 0; out.cacheWrite += h.cacheWrite || 0;
    out.sessions += h.sessions || 0; out.cost += h.cost || 0;
    out.peakCost += h.peakCost || 0;
  }
  return out;
}

/** Check budget thresholds; returns the level crossed ('warn'|'exceed'|null). */
function budgetStatus(monthCost, budget) {
  if (!budget || budget <= 0) return null;
  const pct = monthCost / budget;
  if (pct >= 1) return 'exceed';
  if (pct >= 0.8) return 'warn';
  return null;
}

module.exports = { todayKey, costOf, loadHistory, updateHistory, summarize, budgetStatus, HISTORY_MAX_DAYS, DEFAULT_WINDOWS, parseWindows, isPeakTime, peakStatus, costOfSplit };
