// test/balance.test.js — official balance layer (C1, v0.2.4)
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const balance = require('../src/balance');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-balance-'));

// ------------------------------------------------------- response parsing

test('parseBalanceResponse prefers CNY and reads granted_balance (not grant_balance)', () => {
  const body = {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '20.00', granted_balance: '0.00', topped_up_balance: '20.00' },
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  };
  const snap = balance.parseBalanceResponse(body, 123);
  assert.strictEqual(snap.currency, 'CNY');
  assert.strictEqual(snap.total, 110);
  assert.strictEqual(snap.granted, 10);
  assert.strictEqual(snap.toppedUp, 100);
  assert.strictEqual(snap.isAvailable, true);
  assert.strictEqual(snap.fetchedAt, 123);
});

test('parseBalanceResponse handles USD-only accounts and JSON strings', () => {
  const raw = JSON.stringify({
    is_available: false,
    balance_infos: [{ currency: 'USD', total_balance: '1.5', granted_balance: '1.5', topped_up_balance: '0' }],
  });
  const snap = balance.parseBalanceResponse(raw, 7);
  assert.strictEqual(snap.currency, 'USD');
  assert.strictEqual(snap.total, 1.5);
  assert.strictEqual(snap.isAvailable, false); // surfaced for the red banner
});

test('parseBalanceResponse rejects malformed payloads', () => {
  for (const bad of [
    'not json', {}, null, { is_available: true }, { balance_infos: [] },
    { balance_infos: 'x' },
    { balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] },
    { balance_infos: [{ currency: 'CNY', granted_balance: '1' }] }, // no total
  ]) {
    assert.strictEqual(balance.parseBalanceResponse(bad, 0), null, `expected null for ${JSON.stringify(bad)}`);
  }
  // granted/topped-up may degrade to 0 when the total parses
  const partial = balance.parseBalanceResponse({ balance_infos: [{ currency: 'CNY', total_balance: '5' }] }, 0);
  assert.strictEqual(partial.total, 5);
  assert.strictEqual(partial.granted, 0);
  assert.strictEqual(partial.toppedUp, 0);
});

// ------------------------------------------------------ backoff & throttle

test('backoffDelayMs doubles 1x→2x→4x of the base, capped at 30 minutes', () => {
  const base = 5 * 60_000;
  assert.strictEqual(balance.backoffDelayMs(1, base), 5 * 60_000);
  assert.strictEqual(balance.backoffDelayMs(2, base), 10 * 60_000);
  assert.strictEqual(balance.backoffDelayMs(3, base), 20 * 60_000);
  assert.strictEqual(balance.backoffDelayMs(4, base), 30 * 60_000); // 40 min capped
  assert.strictEqual(balance.backoffDelayMs(50, base), 30 * 60_000);
  // default base = the 5-minute poll interval
  assert.strictEqual(balance.backoffDelayMs(1), balance.BACKOFF_BASE_MS);
});

test('isThrottled guards the 5-minute window after a success', () => {
  const T = 1_000_000; // non-zero: 0 is the "never succeeded" sentinel
  assert.strictEqual(balance.isThrottled(T, 0, 300_000), false); // never succeeded
  assert.strictEqual(balance.isThrottled(T + 4 * 60_000, T, 300_000), true);
  assert.strictEqual(balance.isThrottled(T + 5 * 60_000, T, 300_000), false);
  assert.strictEqual(balance.isThrottled(1 + 299_999, 1), true); // default window
  assert.strictEqual(balance.isThrottled(1 + 300_000, 1), false);
});

// --------------------------------------------------- low-balance threshold

test('lowBalanceThreshold = max(¥5, monthly budget × 5%)', () => {
  assert.strictEqual(balance.lowBalanceThreshold(0), 5);
  assert.strictEqual(balance.lowBalanceThreshold(40), 5); // 40×5% = 2 < 5
  assert.strictEqual(balance.lowBalanceThreshold(200), 10);
  assert.strictEqual(balance.lowBalanceThreshold(1000), 50);
});

test('nextLowBalanceState fires once per descent and re-arms on recovery', () => {
  let state = { notified: false };
  const th = 5;
  const snap = (total, isAvailable = true) => ({ total, isAvailable });
  state = balance.nextLowBalanceState(state, snap(100), th);
  assert.deepStrictEqual(state, { notified: false, fire: false }); // above: quiet
  state = balance.nextLowBalanceState(state, snap(4.9), th);
  assert.deepStrictEqual(state, { notified: true, fire: true });   // crossing down: notify
  state = balance.nextLowBalanceState(state, snap(3), th);
  assert.deepStrictEqual(state, { notified: true, fire: false });  // still below: dedup
  state = balance.nextLowBalanceState(state, snap(50), th);
  assert.deepStrictEqual(state, { notified: false, fire: false }); // recovered: re-arm
  state = balance.nextLowBalanceState(state, snap(1), th);
  assert.deepStrictEqual(state, { notified: true, fire: true });   // next descent fires again
  // is_available=false counts as below even with a high total
  state = balance.nextLowBalanceState({ notified: false }, snap(999, false), th);
  assert.deepStrictEqual(state, { notified: true, fire: true });
  // no snapshot (fetch failed) never changes the state
  assert.deepStrictEqual(balance.nextLowBalanceState({ notified: true }, null, th), { notified: true, fire: false });
});

// ------------------------------------------------------------- key lookup

test('findApiKey priority: env > .credentials.yaml > .env', () => {
  const dir = tmpDir();
  const cred = path.join(dir, '.credentials.yaml');
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(cred, 'OTHER: x\nDEEPSEEK_API_KEY: "sk-from-cred"\n');
  fs.writeFileSync(envFile, 'DEEPSEEK_API_KEY=sk-from-env\n');
  const sources = { env: {}, credentialsPath: cred, envPath: envFile };
  assert.strictEqual(balance.findApiKey(sources), 'sk-from-cred'); // no env → credentials
  assert.strictEqual(balance.findApiKey({ ...sources, env: { DEEPSEEK_API_KEY: 'sk-from-env-var' } }), 'sk-from-env-var');
  assert.strictEqual(balance.findApiKey({ credentialsPath: cred }), 'sk-from-cred');
  assert.strictEqual(balance.findApiKey({ envPath: envFile }), 'sk-from-env');
  assert.strictEqual(balance.findApiKey({ env: {} }), ''); // nothing configured
  assert.strictEqual(balance.findApiKey({ credentialsPath: path.join(dir, 'missing') }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------ persistence

test('snapshot save/load roundtrip; corrupt files yield null', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'balance-snapshot.json');
  assert.strictEqual(balance.loadSnapshot(file), null); // absent
  const snap = { isAvailable: true, currency: 'CNY', total: 12.5, granted: 2.5, toppedUp: 10, fetchedAt: 42 };
  assert.strictEqual(balance.saveSnapshot(file, snap), true);
  assert.deepStrictEqual(balance.loadSnapshot(file), snap);
  fs.writeFileSync(file, '{corrupt');
  assert.strictEqual(balance.loadSnapshot(file), null);
  fs.writeFileSync(file, JSON.stringify({ total: 'x', fetchedAt: 1 }));
  assert.strictEqual(balance.loadSnapshot(file), null); // wrong types
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------- monitor state machine

test('monitor: throttle after success, backoff after failure, in-flight dedup', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'balance-snapshot.json');
  let t = 1_000_000;
  let calls = 0;
  let fail = false;
  const okBody = JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '80.00', granted_balance: '0', topped_up_balance: '80.00' }],
  });
  const monitor = balance.createMonitor({
    snapshotFile: file,
    readKey: () => 'sk-test',
    budgetOf: () => 0,
    fetch: async () => { calls += 1; if (fail) throw new Error('HTTP 503'); return okBody; },
    log: () => {},
    now: () => t,
  });
  // t: first refresh fetches; a concurrent second call rides along (in-flight)
  const p1 = monitor.refresh();
  const p2 = monitor.refresh();
  await Promise.all([p1, p2]);
  assert.strictEqual(calls, 1);
  assert.strictEqual(monitor.snapshot().total, 80);
  assert.strictEqual(balance.loadSnapshot(file).total, 80); // persisted
  // t+1min: throttled (5 min after success)
  t += 60_000;
  await monitor.refresh();
  assert.strictEqual(calls, 1);
  // t+6min: allowed again, but now failing → backoff 1x = 5 min
  t += 5 * 60_000;
  fail = true;
  await monitor.refresh();
  assert.strictEqual(calls, 2);
  assert.strictEqual(monitor.snapshot().total, 80); // last good snapshot kept
  // t+7min: inside the backoff window → skipped
  t += 60_000;
  await monitor.refresh();
  assert.strictEqual(calls, 2);
  // t+12min: backoff expired → retried, fails again → backoff 2x = 10 min
  t += 5 * 60_000;
  await monitor.refresh();
  assert.strictEqual(calls, 3);
  // force bypasses throttle and backoff
  fail = false;
  await monitor.refresh({ force: true });
  assert.strictEqual(calls, 4);
  assert.strictEqual(monitor.snapshot().total, 80);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('monitor: low-balance notification fires once per descent (budget-aware)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'balance-snapshot.json');
  let t = 0;
  let total = 80;
  const notified = [];
  const monitor = balance.createMonitor({
    snapshotFile: file,
    readKey: () => 'sk-test',
    budgetOf: () => 200, // threshold = max(5, 10) = ¥10
    fetch: async () => JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: String(total), granted_balance: '0', topped_up_balance: String(total) }],
    }),
    onLowBalance: (snap, threshold) => notified.push([snap.total, threshold]),
    log: () => {},
    now: () => t,
  });
  await monitor.refresh({ force: true });
  assert.deepStrictEqual(notified, []); // 80 > 10
  total = 9.5;
  t += 10 * 60_000;
  await monitor.refresh({ force: true });
  assert.deepStrictEqual(notified, [[9.5, 10]]); // crossing down fires
  total = 8;
  t += 10 * 60_000;
  await monitor.refresh({ force: true });
  assert.deepStrictEqual(notified, [[9.5, 10]]); // deduped while below
  total = 120;
  t += 10 * 60_000;
  await monitor.refresh({ force: true }); // recovery re-arms silently
  total = 3;
  t += 10 * 60_000;
  await monitor.refresh({ force: true });
  assert.deepStrictEqual(notified, [[9.5, 10], [3, 10]]); // second descent fires
  fs.rmSync(dir, { recursive: true, force: true });
});

test('monitor without an API key stays idle and keeps the persisted snapshot', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'balance-snapshot.json');
  balance.saveSnapshot(file, { isAvailable: true, currency: 'CNY', total: 7, granted: 0, toppedUp: 7, fetchedAt: 1 });
  let calls = 0;
  const logs = [];
  const monitor = balance.createMonitor({
    snapshotFile: file,
    readKey: () => '',
    fetch: async () => { calls += 1; return '{}'; },
    log: (l) => logs.push(l),
    now: () => 0,
  });
  const snap = await monitor.refresh({ force: true });
  assert.strictEqual(calls, 0); // never fetches without a key
  assert.strictEqual(snap.total, 7); // offline display of the last snapshot
  assert.ok(logs.some((l) => l.includes('DEEPSEEK_API_KEY')));
  assert.ok(logs.every((l) => !l.includes('sk-'))); // key material never logged
  fs.rmSync(dir, { recursive: true, force: true });
});
