// src/balance.js — official DeepSeek account balance (C1, v0.2.4).
//
// Thin self-built layer over `GET https://api.deepseek.com/user/balance`
// (Bearer key). Pure logic (parsing / backoff / throttle / low-balance state
// machine / snapshot persistence) lives in plain functions so tests can run
// under plain node; `createMonitor()` wires them into one stateful object for
// the main process. The API key is read from (in priority order):
//   1. process env DEEPSEEK_API_KEY
//   2. <DSH_HOME>/.credentials.yaml  (key DEEPSEEK_API_KEY)
//   3. <DSH_HOME>/.env               (KEY=VALUE line)
// and is NEVER logged, persisted to settings or shipped over IPC — only the
// resulting snapshot is. Official error codes are 400/401/402/422/429/500/503
// (no 403); all failures share the same exponential backoff.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const FETCH_TIMEOUT_MS = 8_000;
const THROTTLE_MS = 5 * 60_000;        // min spacing between successful polls
const BACKOFF_BASE_MS = 5 * 60_000;    // 1x -> 2x -> 4x of the poll interval…
const BACKOFF_MAX_MS = 30 * 60_000;    // …capped at 30 minutes
const LOW_BALANCE_FLOOR = 5;           // ¥ — notify threshold floor
const LOW_BALANCE_BUDGET_PCT = 0.05;   // …or 5% of the monthly budget

/** Parse an official /user/balance response (object or JSON string) into a
 * snapshot {isAvailable, currency, total, granted, toppedUp, fetchedAt}.
 * balance_infos may hold a CNY and/or a USD entry — CNY wins (mainland
 * accounts top up in CNY and the price matrix is in ¥). Returns null for
 * payloads without any usable entry (missing array, all-NaN numbers, …). */
function parseBalanceResponse(body, fetchedAt) {
  let res = body;
  if (typeof body === 'string') {
    try { res = JSON.parse(body); } catch { return null; }
  }
  if (!res || !Array.isArray(res.balance_infos)) return null;
  const entries = res.balance_infos
    .filter((e) => e && typeof e === 'object')
    .map((e) => {
      const total = Number.parseFloat(e.total_balance);
      const granted = Number.parseFloat(e.granted_balance); // NOT grant_balance
      const toppedUp = Number.parseFloat(e.topped_up_balance);
      if (!Number.isFinite(total)) return null;
      return {
        currency: typeof e.currency === 'string' && e.currency ? e.currency : 'CNY',
        total,
        granted: Number.isFinite(granted) ? granted : 0,
        toppedUp: Number.isFinite(toppedUp) ? toppedUp : 0,
      };
    })
    .filter(Boolean);
  if (!entries.length) return null;
  const entry = entries.find((e) => e.currency === 'CNY') || entries[0];
  return {
    isAvailable: res.is_available === true,
    currency: entry.currency,
    total: entry.total,
    granted: entry.granted,
    toppedUp: entry.toppedUp,
    fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : Date.now(),
  };
}

/** Read DEEPSEEK_API_KEY with the priority env > credentials.yaml > .env.
 * `sources` is {env, credentialsPath, envPath}; each source is optional. */
function findApiKey(sources) {
  const s = sources || {};
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^['"]|['"]$/g, '') : '');
  const fromEnv = clean(s.env && s.env.DEEPSEEK_API_KEY);
  if (fromEnv) return fromEnv;
  for (const file of [s.credentialsPath, s.envPath]) {
    if (!file) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    // YAML `DEEPSEEK_API_KEY: sk-…` or dotenv `DEEPSEEK_API_KEY=sk-…`
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*[:=]\s*(\S+)\s*$/m);
    if (m) {
      const key = clean(m[1]);
      if (key) return key;
    }
  }
  return '';
}

/** Backoff delay after the n-th consecutive failure: 1x, 2x, 4x … of the
 * base interval, capped at BACKOFF_MAX_MS. `fails` starts at 1. */
function backoffDelayMs(fails, baseMs) {
  const base = baseMs || BACKOFF_BASE_MS;
  const mult = Math.pow(2, Math.max(0, fails - 1));
  return Math.min(base * mult, BACKOFF_MAX_MS);
}

/** True when a success happened too recently for another poll. */
function isThrottled(nowMs, lastSuccessAt, minIntervalMs) {
  if (!lastSuccessAt) return false;
  return nowMs - lastSuccessAt < (minIntervalMs || THROTTLE_MS);
}

/** Low-balance notify threshold: max(¥5, monthly budget x 5%). */
function lowBalanceThreshold(monthlyBudget) {
  const byBudget = (Number(monthlyBudget) || 0) * LOW_BALANCE_BUDGET_PCT;
  return Math.max(LOW_BALANCE_FLOOR, byBudget);
}

/** Low-balance dedup state machine. `state.notified` is true while we sit in
 * the already-notified below-threshold zone; a snapshot that is below (total
 * <= threshold OR is_available === false) fires exactly once per descent,
 * and recovering above the threshold re-arms the next descent. Returns the
 * next state plus a `fire` flag for this transition. */
function nextLowBalanceState(state, snapshot, threshold) {
  const notified = !!(state && state.notified);
  if (!snapshot) return { notified, fire: false };
  const below = snapshot.isAvailable === false || snapshot.total <= threshold;
  if (below && !notified) return { notified: true, fire: true };
  if (!below && notified) return { notified: false, fire: false };
  return { notified, fire: false };
}

/** Load the persisted snapshot; null when absent or corrupt. */
function loadSnapshot(file) {
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (snap && typeof snap.total === 'number' && typeof snap.fetchedAt === 'number') return snap;
    return null;
  } catch { return null; }
}

/** Persist a snapshot atomically (tmp + rename); best effort. */
function saveSnapshot(file, snapshot) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** Real transport: GET /user/balance with an 8s timeout. Resolves with the
 * parsed response body, rejects with a sanitized error (status/endpoint
 * only — the key must never appear in messages or logs). */
function fetchBalanceHttp(apiKey, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || FETCH_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = https.get(BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          // official codes: 400/401/402/422/429/500/503 (no 403)
          reject(new Error(`balance API HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('balance API timeout'));
    });
    req.on('error', (e) => reject(new Error(`balance API request failed: ${e.message}`)));
  });
}

/**
 * Stateful monitor for the main process. deps:
 *   - readKey(): string   — where the API key comes from (main wires env >
 *     credentials.yaml > .env); empty string = not configured
 *   - fetch(key): Promise<body> — transport (injectable for tests)
 *   - snapshotFile: string      — persistence path
 *   - budgetOf(): number        — monthly budget ¥ (drives the threshold)
 *   - onLowBalance(snap, threshold) — notification hook (fires once per
 *     descent below the threshold)
 *   - log(line)                 — shell log (messages carry no key material)
 *   - now(): number             — clock injection for tests
 * refresh({force}) is idempotent: one in-flight request at a time, 5-minute
 * throttle after a success, and consecutive failures back off 1x→2x→4x of
 * the poll interval capped at 30 minutes (force bypasses throttle+backoff,
 * never the in-flight guard).
 */
function createMonitor(deps) {
  const d = deps || {};
  const now = d.now || (() => Date.now());
  const log = d.log || (() => {});
  const fetchFn = d.fetch || fetchBalanceHttp;
  const state = {
    snapshot: d.snapshotFile ? loadSnapshot(d.snapshotFile) : null,
    lastSuccessAt: 0,
    fails: 0,
    blockedUntil: 0,
    low: { notified: false },
    inFlight: false,
    keyLogged: false,
  };
  async function refresh(opts) {
    if (state.inFlight) return state.snapshot;
    const force = !!(opts && opts.force);
    const t = now();
    if (!force) {
      if (isThrottled(t, state.lastSuccessAt)) return state.snapshot;
      if (state.blockedUntil && t < state.blockedUntil) return state.snapshot;
    }
    let key = '';
    try { key = d.readKey ? d.readKey() : ''; } catch { key = ''; }
    if (!key) {
      if (!state.keyLogged) {
        state.keyLogged = true;
        log('[balance] no DEEPSEEK_API_KEY found (env > .credentials.yaml > .env); balance polling idle');
      }
      return state.snapshot;
    }
    state.inFlight = true;
    try {
      const body = await fetchFn(key);
      const snap = parseBalanceResponse(body, now());
      if (!snap) throw new Error('balance API returned an unusable payload');
      state.fails = 0;
      state.blockedUntil = 0;
      state.lastSuccessAt = now();
      state.snapshot = snap;
      if (d.snapshotFile) saveSnapshot(d.snapshotFile, snap);
      const threshold = lowBalanceThreshold(d.budgetOf ? d.budgetOf() : 0);
      const low = nextLowBalanceState(state.low, snap, threshold);
      state.low = low;
      if (low.fire && d.onLowBalance) {
        try { d.onLowBalance(snap, threshold); } catch { /* notify must not break polling */ }
      }
      log(`[balance] ok: ${snap.currency} ${snap.total} (granted ${snap.granted} + topped-up ${snap.toppedUp}), available=${snap.isAvailable}`);
    } catch (e) {
      state.fails += 1;
      state.blockedUntil = now() + backoffDelayMs(state.fails);
      log(`[balance] fetch failed (${e.message}); retry in ${Math.round((state.blockedUntil - now()) / 60_000)} min`);
    } finally {
      state.inFlight = false;
    }
    return state.snapshot;
  }
  return {
    refresh,
    snapshot: () => state.snapshot,
    lowBalanceThresholdValue: () => lowBalanceThreshold(d.budgetOf ? d.budgetOf() : 0),
  };
}

module.exports = {
  BALANCE_URL,
  THROTTLE_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  LOW_BALANCE_FLOOR,
  parseBalanceResponse,
  findApiKey,
  backoffDelayMs,
  isThrottled,
  lowBalanceThreshold,
  nextLowBalanceState,
  loadSnapshot,
  saveSnapshot,
  fetchBalanceHttp,
  createMonitor,
};
