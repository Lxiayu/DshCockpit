// src/cost.js — token->cost estimation, daily history, and budget checks.
//
// Rates are user-configurable estimates (settings.costInputPerM etc.); the
// numbers shown are labeled as estimates, never as official billing.
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const HISTORY_MAX_DAYS = 90;

// Peak/off-peak pricing windows (Beijing time). Each entry is an hour range
// [start, end) — left-closed, right-open. Defaults follow DeepSeek's peak
// hours (9-12 and 14-18 Beijing time); user-configurable as a string.
const DEFAULT_WINDOWS = [[9, 12], [14, 18]];

// Official DeepSeek price matrix (¥ per 1M tokens): model x time-of-day.
// Peak pricing took effect 2026-08-17 00:00 Beijing time (peak hours above);
// peak = off-peak x 2 across every dimension. Cache writes are NOT billed by
// the official API (only hit/miss/output are), so cacheWritePerM is 0.
// Verified against api-docs.deepseek.com + billing research 2026-08-18;
// user-set cost*PerM settings keys still override these for the estimate
// views (manual override path kept intact).
const PRICE_MATRIX = {
  'deepseek-v4-flash': {
    offPeak: { inputPerM: 1.5, outputPerM: 4.5, cacheReadPerM: 0.05, cacheWritePerM: 0 },
    peak: { inputPerM: 3, outputPerM: 9, cacheReadPerM: 0.1, cacheWritePerM: 0 },
  },
  'deepseek-v4-pro': {
    offPeak: { inputPerM: 4.5, outputPerM: 13.5, cacheReadPerM: 0.15, cacheWritePerM: 0 },
    peak: { inputPerM: 9, outputPerM: 27, cacheReadPerM: 0.3, cacheWritePerM: 0 },
  },
};
const DEFAULT_MODEL = 'deepseek-v4-flash';

/** Map any model name to a PRICE_MATRIX key. The legacy deepseek-chat /
 * deepseek-reasoner names (retired 2026-07-24) mapped onto v4-flash, and any
 * unknown name prices conservatively at the flash tier. */
function normalizeModel(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('pro')) return 'deepseek-v4-pro';
  return 'deepseek-v4-flash';
}

/** Official rates (¥/1M) for a model and time-of-day; `isPeak` picks the
 * bucket. Always returns a complete rate set (never null). */
function modelRates(model, isPeak) {
  const m = PRICE_MATRIX[normalizeModel(model)];
  return isPeak ? m.peak : m.offPeak;
}

/** One turn's cost at official prices. `totals` carries dsh usage buckets —
 * input = cache-miss tokens, cacheRead = cache-hit tokens, output includes
 * reasoning tokens (billed at the output rate). When peak/offPeak sub-buckets
 * are present each bucket is priced in its own window; otherwise everything
 * is priced off-peak (events without a time bucket go off-peak upstream).
 * Also returns the cache savings: hit tokens priced at the hit rate instead
 * of the miss rate. */
function turnCost(totals, model) {
  const buckets = totals && totals.peak && totals.offPeak
    ? [['peak', true], ['offPeak', false]]
    : null;
  const list = buckets
    ? buckets.map(([k, isPeak]) => ({ usage: totals[k], rates: modelRates(model, isPeak) }))
    : [{ usage: totals, rates: modelRates(model, false) }];
  let cost = 0, saved = 0;
  let input = 0, output = 0, cacheRead = 0;
  for (const { usage, rates } of list) {
    const miss = usage.input || 0, hit = usage.cacheRead || 0, out = usage.output || 0;
    cost += (miss * rates.inputPerM + hit * rates.cacheReadPerM + out * rates.outputPerM
      + (usage.cacheWrite || 0) * rates.cacheWritePerM) / 1e6;
    saved += hit * (rates.inputPerM - rates.cacheReadPerM) / 1e6;
    input += miss; output += out; cacheRead += hit;
  }
  return { cost, saved, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead };
}

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

/** Load or create the daily history file (array of {date, input, output, cacheRead, cacheWrite, sessions, cost}).
 * Async so the disk read never blocks the main process's event loop (Windows AV
 * can stall sync reads for tens of ms; perf report P2/P3). */
async function loadHistory(file) {
  let st;
  try { st = await fsp.stat(file); } catch {
    // file missing — drop any stale cache entry
    historyCache.delete(file);
    return [];
  }
  const hit = historyCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.history;
  let history = [];
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (Array.isArray(raw)) history = raw;
  } catch { /* first run / corrupt */ }
  // keep a defensive copy so callers can't mutate the cached array
  history = history.map((h) => ({ ...h }));
  historyCache.set(file, { mtimeMs: st.mtimeMs, history });
  return history;
}

/** Upsert today's entry; prune entries older than HISTORY_MAX_DAYS. */
async function updateHistory(file, entry) {
  let history = await loadHistory(file);
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
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(history, null, 2));
    await fsp.rename(tmp, file);
  } catch { /* ignore */ }
  // refresh cache so the next loadHistory reuses the just-written data
  try {
    const st = await fsp.stat(file);
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

module.exports = { todayKey, costOf, loadHistory, updateHistory, summarize, budgetStatus, HISTORY_MAX_DAYS, DEFAULT_WINDOWS, parseWindows, isPeakTime, peakStatus, costOfSplit, PRICE_MATRIX, DEFAULT_MODEL, normalizeModel, modelRates, turnCost };
