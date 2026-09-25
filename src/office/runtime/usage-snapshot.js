'use strict';

// src/office/runtime/usage-snapshot.js — office `usage` block assembler (P1
// data pipeline of the office right-panel spec §4).
//
// The shell stays the single authority for usage ("usage = 壳侧唯一权威
// (cost.js / token-stats.js / balance)"): this module READS EXISTING caches and
// collects nothing new —
//   - tokens / cacheRead: the R4 per-day buckets inside the token-stats
//     collect() cache (main.js costCache.data.totals.days, bucketed by the
//     Beijing-calendar billing day — the same bucketing weekly-report and the
//     cost center use);
//   - money estimate rates: the cost center snapshot's `rates` when present
//     (shell:cost-info's own numbers), else the raw cost*PerM settings;
//   - budget: the monthly budget setting plus the cost center's month rollup
//     (the same figure checkBudget notifies on);
//   - the official balance snapshot only corroborates the metered-account
//     reading of `pricingBasis` (see below).
//
// Pure deterministic CommonJS: no Electron, no IO, no Date.now — the caller
// injects nowMs/dataAtMs. Returns null when the shell has no usage data yet,
// so the office snapshot can stay `usage: null` instead of showing invented
// zeros.
//
// Field semantics (spec §4):
//   dayKey      — Beijing-calendar billing day 'YYYY-MM-DD' (token-stats' own
//                 day bucketing, so the tokens and the key always agree).
//   tokens      — today's input / output / cacheRead counts and their total
//                 (the three displayed buckets; cacheWrite is not part of the
//                 §4 contract).
//   money.paid  — today's bucket priced at the estimate rates, CNY.
//   savings     — cacheRead saved = cache-hit tokens × the miss−hit gap (the
//                 flat-gap convention weekly-report.js uses for per-day rows:
//                 a day bucket carries no peak/offPeak split upstream).
//                 localModel = 0 with basis 'cloud-equivalent': the shell has
//                 no per-provider token source today (sessions are not
//                 attributed to local/cloud models anywhere in the log
//                 pipeline), so P1 pins the contract field at its zero
//                 baseline rather than inventing a number. The basis marker
//                 records the intended pricing convention for when a source
//                 lands.
//   budget      — monthly budget + month spend when configured, else none.
//   pricingBasis— 'api-key' | 'subscription'. Every money number here is a
//                 token estimate, so the honest P1 value is 'api-key'; a live
//                 official balance snapshot corroborates a metered account.
//                 The branch is written so a future subscription signal (a
//                 provider reporting plan billing) can flip it.
//   staleAt     — null while fresh; the epoch-ms instant the 60s staleness
//                 threshold was crossed once the usage data stops updating
//                 (the page shows "数据延迟" on non-null).

const { costOf } = require('../../cost.js');

const STALE_AFTER_MS = 60_000;
const CST_OFFSET_MS = 8 * 3_600_000;
const MB = 1_000_000;

/** Beijing-calendar billing day key — identical to token-stats' day bucketing
 * (`new Date(ev.time + 8h).toISOString().slice(0, 10)`). */
function billingDayKey(nowMs) {
  return new Date(nowMs + CST_OFFSET_MS).toISOString().slice(0, 10);
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Money is rounded to 4 decimals so repeated injections never churn the
 * snapshot with floating-point noise; display formatting happens in the UI. */
function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e4) / 1e4;
}

function ratesOf(input) {
  const snapRates = input.costSnap && input.costSnap.rates;
  if (snapRates && Number.isFinite(Number(snapRates.inputPerM))) {
    return {
      inputPerM: num(snapRates.inputPerM),
      outputPerM: num(snapRates.outputPerM),
      cacheReadPerM: num(snapRates.cacheReadPerM),
      cacheWritePerM: num(snapRates.cacheWritePerM),
    };
  }
  const s = input.settings || {};
  return {
    inputPerM: num(s.costInputPerM),
    outputPerM: num(s.costOutputPerM),
    cacheReadPerM: num(s.costCacheReadPerM),
    cacheWritePerM: num(s.costCacheWritePerM),
  };
}

/**
 * Price ONE turn/step usage bucket at the SAME local rates the §4 block uses
 * (the cost-center snapshot's rates when present, else the raw settings).
 * Kept beside buildOfficeUsage so the panel's per-turn money (timeline
 * attribution, P2) and its daily money can never diverge in basis.
 * @param {{input?: number, output?: number, cacheRead?: number, cacheWrite?: number}} usage
 * @param {{costSnap?: object, settings?: object}} [input]
 * @returns {number} CNY, rounded like the block's money fields.
 */
function priceUsageAt(usage, input = {}) {
  const bucket = {
    input: int(usage && usage.input),
    output: int(usage && usage.output),
    cacheRead: int(usage && usage.cacheRead),
    cacheWrite: int(usage && usage.cacheWrite),
  };
  return money(costOf(bucket, ratesOf(input)));
}

/**
 * @param {object} [input]
 * @param {object} [input.collectData]  token-stats collect() cache output
 *   (totals.days carries the R4 per-day buckets).
 * @param {object} [input.costSnap]     main.js costSnapshot() output (rates,
 *   month rollup).
 * @param {object} [input.balanceSnap]  official balance monitor snapshot
 *   ({isAvailable, currency, total, …}); only corroborates pricingBasis.
 * @param {object} [input.settings]     settings snapshot (cost*PerM, budget).
 * @param {number} [input.nowMs]        injected clock.
 * @param {number} [input.dataAtMs]     when the collect cache was last
 *   refreshed (main.js costCache.at); 0/unknown disables the stale marker.
 * @param {number} [input.staleAfterMs] staleness threshold (default 60s).
 * @returns {object|null} the spec §4 usage block, or null with no data yet.
 */
function buildOfficeUsage(input = {}) {
  const collectData = input.collectData || null;
  const costSnap = input.costSnap || null;
  if (!collectData && !costSnap) return null;
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const staleAfterMs = Number.isFinite(input.staleAfterMs) ? input.staleAfterMs : STALE_AFTER_MS;

  const dayKey = billingDayKey(nowMs);
  const days = (collectData && collectData.totals && collectData.totals.days) || {};
  const today = days[dayKey] || null;
  const bucket = {
    input: int(today && today.input),
    output: int(today && today.output),
    cacheRead: int(today && today.cacheRead),
    cacheWrite: int(today && today.cacheWrite),
  };
  const rates = ratesOf(input);
  const paid = costOf(bucket, rates);
  // Flat miss−hit gap over today's cache hits (weekly-report per-day
  // convention: the day bucket has no peak/offPeak split).
  const gap = Math.max(0, rates.inputPerM - rates.cacheReadPerM);
  const cacheSaved = (bucket.cacheRead / MB) * gap;

  const budget = num((input.settings || {}).monthlyBudget);
  const monthUsed = costSnap && costSnap.month ? num(costSnap.month.cost) : 0;

  const block = {
    dayKey,
    tokens: {
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      total: bucket.input + bucket.output + bucket.cacheRead,
    },
    money: { paid: money(paid), currency: 'CNY' },
    savings: {
      cacheRead: money(cacheSaved),
      localModel: 0,
      localModelBasis: 'cloud-equivalent',
    },
    budget: budget > 0
      ? { kind: 'monthly', limit: budget, used: money(monthUsed) }
      : { kind: 'none', limit: 0, used: 0 },
    pricingBasis: 'api-key',
    staleAt: null,
  };
  const dataAtMs = Number(input.dataAtMs);
  if (Number.isFinite(dataAtMs) && dataAtMs > 0 && nowMs - dataAtMs > staleAfterMs) {
    block.staleAt = dataAtMs + staleAfterMs;
  }
  return block;
}

module.exports = { buildOfficeUsage, priceUsageAt, billingDayKey, STALE_AFTER_MS };
