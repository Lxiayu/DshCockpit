// src/cost.js — token->cost estimation, daily history, and budget checks.
//
// Rates are user-configurable estimates (settings.costInputPerM etc.); the
// numbers shown are labeled as estimates, never as official billing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HISTORY_MAX_DAYS = 90;

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

/** Load or create the daily history file (array of {date, input, output, cacheRead, cacheWrite, sessions, cost}). */
function loadHistory(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch { /* first run / corrupt */ }
  return [];
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
  const cutoff = new Date(Date.now() - HISTORY_MAX_DAYS * 86_400_000);
  history = history.filter((h) => !h.date || new Date(h.date + 'T00:00:00') >= cutoff);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
  return history;
}

/** Sum history over the last `days` days (most recent N distinct dates). */
function summarize(history, days) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: 0 };
  const seen = new Set();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (!h || !h.date) continue;
    if (seen.size >= days) break;
    seen.add(h.date);
    out.input += h.input || 0; out.output += h.output || 0;
    out.cacheRead += h.cacheRead || 0; out.cacheWrite += h.cacheWrite || 0;
    out.sessions += h.sessions || 0; out.cost += h.cost || 0;
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

module.exports = { todayKey, costOf, loadHistory, updateHistory, summarize, budgetStatus, HISTORY_MAX_DAYS };
