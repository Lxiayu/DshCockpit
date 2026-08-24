// src/cache-economics.js — R4 cache economics aggregation (pure functions).
//
// Consumes the token-stats collect() output (totals/sessions with per-day
// buckets, peak/offPeak splits) plus the user's price settings and answers
// one question: how much money did prompt-cache hits save, and where?
//
//   saved(tokens) = tokens / 1e6 × max(0, missPrice − hitPrice)
//   hitRate       = cacheRead / (cacheRead + input)      (0 when no events)
//
// Pricing mirrors cost.js conventions: flat prices always apply; the peak
// split only engages when costPeakEnabled (peak gap on peak-bucketed tokens,
// off-peak gap elsewhere). Per-day trend values use the flat gap — the month
// headline is exact via totals.peak/offPeak. Read-only: nothing here mutates
// its inputs.
'use strict';

const path = require('node:path');

const MB = 1_000_000;

/** Flat + peak price pair from a settings snapshot (defaults mirror cost.js). */
function pricingFromSettings(s) {
  const c = s || {};
  return {
    inputPerM: Number(c.costInputPerM) || 0,
    cacheReadPerM: Number(c.costCacheReadPerM) || 0,
    peakEnabled: !!c.costPeakEnabled,
    peakInputPerM: Number(c.costPeakInputPerM) || 0,
    peakCacheReadPerM: Number(c.costPeakCacheReadPerM) || 0,
  };
}

function gapFor(pricing) {
  return pricing.peakEnabled
    ? { peakGap: Math.max(0, pricing.peakInputPerM - pricing.peakCacheReadPerM), offPeakGap: Math.max(0, pricing.inputPerM - pricing.cacheReadPerM) }
    : { peakGap: Math.max(0, pricing.inputPerM - pricing.cacheReadPerM), offPeakGap: Math.max(0, pricing.inputPerM - pricing.cacheReadPerM) };
}

function savedOf(bucket, gapYuanPerM) {
  if (!bucket) return 0;
  return ((bucket.cacheRead || 0) / MB) * gapYuanPerM;
}

function hitRateOf(bucketLike) {
  const read = (bucketLike && bucketLike.cacheRead) || 0;
  const input = (bucketLike && bucketLike.input) || 0;
  const denom = read + input;
  return denom > 0 ? read / denom : 0; // division-by-zero safe
}

/** Workspace alias for display: basename of cwd, never a full path (R5-grade
 * desensitisation applies here too). */
function aliasSession(s) {
  const cwd = s && s.cwd ? String(s.cwd) : '';
  const base = cwd ? path.basename(cwd) : '';
  return base || 'unknown';
}

/**
 * @param {{totals: object, sessions: object[]}} data  token-stats collect() output
 * @param {object} pricing  pricingFromSettings() result
 * @param {object} [opts]
 * @param {string} [opts.month]  'YYYY-MM' filter for the headline card
 *   (defaults to the current UTC+8 month); days outside it are excluded from
 *   `month` but still included in `overall`/`byDay`
 */
function buildCacheEconomics(data, pricing, opts = {}) {
  const totals = data && data.totals ? data.totals : {};
  const sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
  const { peakGap, offPeakGap } = gapFor(pricing);

  // ---- overall + peak/off-peak split (exact)
  let overallSaved;
  if (pricing.peakEnabled) {
    overallSaved = savedOf(totals.peak, peakGap) + savedOf(totals.offPeak, offPeakGap);
  } else {
    overallSaved = savedOf(totals, offPeakGap);
  }
  const overall = {
    savedYuan: overallSaved,
    cacheReadTokens: totals.cacheRead || 0,
    inputTokens: totals.input || 0,
    hitRate: hitRateOf(totals),
    peakSavedYuan: pricing.peakEnabled ? savedOf(totals.peak, peakGap) : null,
    offPeakSavedYuan: pricing.peakEnabled ? savedOf(totals.offPeak, offPeakGap) : null,
  };

  // ---- per-day trend (flat-gap estimate; see module header)
  const byDayRaw = [];
  for (const [day, b] of Object.entries(totals.days || {})) {
    byDayRaw.push({
      day,
      savedYuan: ((b.cacheRead || 0) / MB) * offPeakGap,
      cacheReadTokens: b.cacheRead || 0,
      hitRate: hitRateOf(b),
    });
  }
  byDayRaw.sort((a, b) => (a.day < b.day ? -1 : 1));

  // ---- month headline (billing-aligned UTC+8 day keys)
  const nowD = new Date((opts.nowMs || Date.now()) + 8 * 3_600_000);
  const month = opts.month || nowD.toISOString().slice(0, 7);
  const inMonth = byDayRaw.filter((d) => d.day.slice(0, 7) === month);
  const hasDayData = byDayRaw.length > 0;
  const monthSaved = inMonth.reduce((acc, d) => acc + d.savedYuan, 0);
  const monthHit = {
    savedYuan: monthSaved,
    cacheReadTokens: inMonth.reduce((a, d) => a + d.cacheReadTokens, 0),
    hitRate: inMonth.length
      ? inMonth.reduce((a, d) => a + d.hitRate, 0) / inMonth.length
      : 0,
    approx: !hasDayData, // no day buckets at all → headline degrades to overall flat-gap estimate
  };
  if (monthHit.approx) {
    monthHit.savedYuan = overall.savedYuan;
    monthHit.hitRate = overall.hitRate;
    monthHit.cacheReadTokens = overall.cacheReadTokens;
  }

  // ---- per-session top 10 (desc by saved)
  const topSessions = sessions
    .map((s) => ({
      alias: aliasSession(s),
      savedYuan: pricing.peakEnabled
        ? savedOf(s.usage && s.usage.peak, peakGap) + savedOf(s.usage && s.usage.offPeak, offPeakGap)
        : savedOf(s.usage, offPeakGap),
      cacheReadTokens: (s.usage && s.usage.cacheRead) || 0,
      hitRate: hitRateOf(s.usage),
    }))
    .sort((a, b) => b.savedYuan - a.savedYuan)
    .slice(0, 10);

  return {
    schema: 1,
    pricing: { ...pricing, peakGap, offPeakGap },
    overall,
    month: monthHit,
    byDay: byDayRaw,
    topSessions,
  };
}

module.exports = { buildCacheEconomics, pricingFromSettings, hitRateOf, aliasSession, gapFor, savedOf, MB };
