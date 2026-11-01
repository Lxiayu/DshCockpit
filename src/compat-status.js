// src/compat-status.js — upstream compatibility status (R2, read-only).
//
// Consumes the JSON produced by the upstream-compat CI pipeline
// (docs/compat/compat-status.json on the master branch) and answers one
// question for the Settings → Updates page: is the ACTIVE runtime version the
// latest verified-compatible upstream release?
//
// Network results are cached under userData/compat-cache.json (C-4: new file)
// so a dead network never blanks the panel — it degrades to the stale cache.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const policy = require('./compat-policy.js');

const DEFAULT_URL = 'https://raw.githubusercontent.com/Lxiayu/DshCockpit/master/docs/compat/compat-status.json';
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refetch at most every 6h unless forced

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings       settings.get()
 * @param {() => string} deps.getRuntimeVersion active dsh runtime version ("0.1.0-rc.8")
 * @param {string} deps.userDataDir             cache lives here
 * @param {string} [deps.statusUrl]             override for tests / forks
 * @param {(url: string, opts: object) => Promise<{ok: boolean, status?: number, json: () => Promise<object>}>} [deps.fetchImpl]
 * @param {() => number} [deps.now]             injectable clock (tests)
 * @param {(line: string) => void} [deps.log]
 */
function createCompatStatus(deps) {
  const {
    getSettings,
    getRuntimeVersion,
    userDataDir,
    statusUrl = DEFAULT_URL,
    fetchImpl = (typeof fetch === 'function' ? fetch : null),
    now = () => Date.now(),
    log = () => {},
  } = deps || {};

  const cacheFile = () => path.join(userDataDir, 'compat-cache.json');

  function readCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      return raw && typeof raw === 'object' && raw.data ? raw : null;
    } catch { return null; }
  }

  function writeCache(data) {
    try {
      fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
      const tmp = `${cacheFile()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: now(), url: statusUrl, data }, null, 2));
      fs.renameSync(tmp, cacheFile());
    } catch (err) { log(`[compat] cache write failed: ${err.message}`); }
  }

  async function fetchLive() {
    if (!fetchImpl) throw new Error('no fetch implementation available');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ac && ac.abort(); } catch { /* ignore */ } }, FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(statusUrl, {
        signal: ac ? ac.signal : undefined,
        headers: { 'cache-control': 'no-cache' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== 'object') throw new Error('malformed compat payload');
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Evaluate the active runtime against the compatibility ledger.
   *
   * Issue #21 (2026-11-01): the old version answered ONE question —
   * "is current === latestVerified?" — and nothing else. That is how the app
   * kept advertising "already on the latest verified version" for three months
   * while CI had moved on: the ledger was stale, but equality alone still held.
   *
   * Now the answer separates three things that must never be conflated:
   *   verified  — the ledger records a passing run for that version (a FACT;
   *               **never** flips to false just because time passed)
   *   fresh     — is that conclusion recent enough to act on (DOES decay,
   *               at channel-dependent rates: prerelease 7d / stable 30d)
   *   compatible— current runtime == verified version AND the conclusion is fresh
   *
   * A stale-but-matching ledger reports `verifiedButStale` rather than
   * pretending either "all good" or "not verified".
   */
  function evaluate(currentVersion, data, nowMs) {
    const at = typeof nowMs === 'number' ? nowMs : now();
    return policy.evaluateLedger({
      currentVersion,
      ledger: data,
      verifiedVersion: data && typeof data.latestVerified === 'string' ? data.latestVerified : '',
      nowMs: at,
    });
  }

  /** Ledger-level freshness (independent of which version is active). */
  function freshness(ledger, nowMs) {
    const at = typeof nowMs === 'number' ? nowMs : now();
    return policy.ledgerFreshness(ledger, at);
  }

  /**
   * Status for the UI. Never throws.
   *
   * Returns { ok, enabled, source, current, updatedAt, latestVerified,
   *           compatible, verified, fresh, stale, verifiedButStale,
   *           ageDays, staleThresholdDays, ledgerStale, ledgerAgeDays, reason? }
   *
   * `compatible` is the ONLY field the UI may use to claim "you are on the
   * latest verified version". `verified` alone means "this version was verified
   * at some point" — it survives staleness and must never be rendered as a
   * failure.
   */
  async function getStatus(force = false) {
    const currentVersion = String(getRuntimeVersion() || '');
    if (!getSettings().compatStatusEnabled) {
      return {
        ok: true, enabled: false, source: 'none', current: currentVersion,
        latestVerified: '', compatible: false, verified: false, fresh: false,
        stale: true, verifiedButStale: false, ledgerStale: false,
      };
    }
    const cached = readCache();
    const cacheFresh = cached && (now() - cached.fetchedAt) < CACHE_TTL_MS;

    const decorate = (data, source) => {
      const ev = evaluate(currentVersion, data);
      const lf = freshness(data);
      return {
        ok: true,
        enabled: true,
        source,
        current: currentVersion,
        updatedAt: (data && data.updatedAt) || '',
        // ledger-level staleness: "this file has not been refreshed in a while",
        // independent of whether the active version matches
        ledgerStale: lf.known ? !lf.fresh : false,
        ledgerAgeDays: lf.known ? Math.floor(lf.ageDays) : null,
        ...ev,
      };
    };

    if (!force && cacheFresh) return decorate(cached.data, 'cache');
    try {
      const data = await fetchLive();
      writeCache(data);
      return decorate(data, 'live');
    } catch (err) {
      log(`[compat] live fetch failed (${err.message}); ${cached ? 'serving stale cache' : 'no cache available'}`);
      if (cached) return decorate(cached.data, 'cache');
      return {
        ok: false, enabled: true, source: 'none', current: currentVersion,
        latestVerified: '', compatible: false, verified: false, fresh: false,
        stale: true, verifiedButStale: false, ledgerStale: false, reason: err.message,
      };
    }
  }

  return { getStatus, evaluate, freshness, cacheFile: cacheFile, DEFAULT_URL };
}

module.exports = { createCompatStatus, DEFAULT_URL, CACHE_TTL_MS };
