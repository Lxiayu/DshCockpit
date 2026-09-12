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

  /** True when the active runtime version equals the latest verified version. */
  function evaluate(currentVersion, data) {
    const latestVerified = data && typeof data.latestVerified === 'string' ? data.latestVerified : '';
    return {
      latestVerified,
      compatible: !!currentVersion && !!latestVerified && currentVersion === latestVerified,
    };
  }

  /**
   * Status for the UI. Never throws.
   * Returns { ok, enabled, source: 'live'|'cache'|'none', current, updatedAt,
   *           latestVerified, compatible, reason? }.
   */
  async function getStatus(force = false) {
    const currentVersion = String(getRuntimeVersion() || '');
    if (!getSettings().compatStatusEnabled) {
      return { ok: true, enabled: false, source: 'none', current: currentVersion, latestVerified: '', compatible: false };
    }
    const cached = readCache();
    const fresh = cached && (now() - cached.fetchedAt) < CACHE_TTL_MS;
    if (!force && fresh) {
      const ev = evaluate(currentVersion, cached.data);
      return { ok: true, enabled: true, source: 'cache', current: currentVersion, updatedAt: cached.data.updatedAt || '', ...ev };
    }
    try {
      const data = await fetchLive();
      writeCache(data);
      const ev = evaluate(currentVersion, data);
      return { ok: true, enabled: true, source: 'live', current: currentVersion, updatedAt: data.updatedAt || '', ...ev };
    } catch (err) {
      log(`[compat] live fetch failed (${err.message}); ${cached ? 'serving stale cache' : 'no cache available'}`);
      if (cached) {
        const ev = evaluate(currentVersion, cached.data);
        return { ok: true, enabled: true, source: 'cache', current: currentVersion, updatedAt: cached.data.updatedAt || '', ...ev };
      }
      return { ok: false, enabled: true, source: 'none', current: currentVersion, latestVerified: '', compatible: false, reason: err.message };
    }
  }

  return { getStatus, evaluate, cacheFile: cacheFile, DEFAULT_URL };
}

module.exports = { createCompatStatus, DEFAULT_URL, CACHE_TTL_MS };
