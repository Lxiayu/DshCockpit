// test/runtime-health.test.js — the runtime health monitor contract (2026-09-23
// container hardening). The monitor is a pure clock-injected state machine: it
// turns feed/mux/cookie observations into the machine-readable reasons the tray,
// the settings page and the diagnostics write consume. No Electron, no network.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createRuntimeHealthMonitor } = require('../src/runtime-health.js');

/** Deterministic clock: every tick(ms) advances the injected now(). */
function fixture({ failStreak = 3, disconnectMs = 30_000 } = {}) {
  let t = 1_000_000;
  const logs = [];
  const monitor = createRuntimeHealthMonitor({
    failStreak,
    disconnectMs,
    now: () => t,
    log: (line) => logs.push(line),
  });
  return { monitor, logs, tick: (ms) => { t += ms; } };
}

test('three consecutive feed failures trip the degraded flag (A1)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  assert.strictEqual(f.monitor.snapshot().degraded, false, 'a fresh feed is not degraded');
  f.monitor.noteFeedFailure(new Error('socket closed'));
  f.monitor.noteFeedFailure(new Error('socket closed'));
  assert.deepStrictEqual(f.monitor.snapshot().reasons, []);
  const third = f.monitor.noteFeedFailure(new Error('socket closed'));
  assert.strictEqual(third.feedFailStreak, 3);
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, true);
  assert.deepStrictEqual(snap.reasons, ['feed-fail-streak']);
});

test('a live frame resets the failure streak and clears the degraded flag (A1)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedFailure(new Error('socket closed'));
  f.monitor.noteFeedFailure(new Error('socket closed'));
  f.monitor.noteFeedFailure(new Error('socket closed'));
  assert.strictEqual(f.monitor.snapshot().degraded, true);
  f.monitor.noteFeedLive();
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, false);
  assert.deepStrictEqual(snap.reasons, []);
  assert.strictEqual(snap.feedLive, true);
  assert.strictEqual(snap.feedFailStreak, 0);
});

test('cookie exchange failures are classified as auth failures and degrade (A1)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedFailure(new Error('runtime cookie unavailable'));
  f.monitor.noteFeedFailure(new Error('websocket error (/api/remote.mux)'));
  f.monitor.noteFeedFailure(new Error('runtime cookie unavailable'));
  // 2 auth + 1 transport failure: below both streaks, nothing reported
  assert.strictEqual(f.monitor.snapshot().degraded, false);
  f.monitor.noteFeedFailure(new Error('runtime cookie unavailable'));
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, true);
  assert.deepStrictEqual(snap.reasons, ['auth-fail-streak']);
  assert.strictEqual(snap.authFailStreak, 3);
  assert.strictEqual(snap.feedFailStreak, 1, 'a cookie failure is not double-counted as a transport failure');
});

test('a mux that stays non-live past the 30s threshold marks the feed disconnected (A3)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedLive();
  // the runtime goes blind: the mux client reports 'reconnecting'
  f.monitor.noteMuxState('reconnecting');
  f.tick(29_000);
  assert.deepStrictEqual(f.monitor.snapshot().reasons, [], 'below 30s nothing is reported');
  f.tick(2_000); // 31s total
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.feedLostForMs, 31_000);
  assert.deepStrictEqual(snap.reasons, ['feed-disconnected']);
  assert.strictEqual(snap.degraded, true);
});

test('recovery (the mux goes live again) clears the disconnect hint automatically (A3)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedLive();
  f.monitor.noteMuxState('reconnecting');
  f.tick(45_000);
  assert.deepStrictEqual(f.monitor.snapshot().reasons, ['feed-disconnected']);
  f.monitor.noteMuxState('live'); // reconnected + ready frame observed
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, false);
  assert.deepStrictEqual(snap.reasons, []);
  assert.strictEqual(snap.feedLostForMs, 0);
  assert.strictEqual(snap.feedLive, true);
});

test('the legacy feed (no mux state ever observed) never trips the disconnect rule', () => {
  // 0.1.1 events.host is frame-silent while idle: only the explicit fail streak
  // may degrade it, never a silence timer.
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'legacy' });
  f.tick(600_000);
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.feedLive, false);
  assert.strictEqual(snap.degraded, false);
  assert.deepStrictEqual(snap.reasons, []);
});

test('a legacy feed that never delivers anything still degrades on repeated failures', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'legacy' });
  for (let i = 0; i < 3; i += 1) f.monitor.noteFeedFailure(new Error('websocket closed (/api/events.host)'));
  assert.deepStrictEqual(f.monitor.snapshot().reasons, ['feed-fail-streak']);
});

test('both failure families can be reported together', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedLive();
  f.monitor.noteMuxState('reconnecting');
  f.tick(31_000);
  for (let i = 0; i < 3; i += 1) f.monitor.noteFeedFailure(new Error('runtime cookie unavailable'));
  const snap = f.monitor.snapshot();
  // deterministic order: fail streaks first, then the disconnect timer
  assert.deepStrictEqual(snap.reasons, ['auth-fail-streak', 'feed-disconnected']);
  assert.strictEqual(snap.degraded, true);
});

test('reset() clears every streak and clock (runtime restart / feed stop)', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteFeedLive();
  f.monitor.noteFeedFailure(new Error('x'));
  f.monitor.noteFeedFailure(new Error('x'));
  f.monitor.noteFeedFailure(new Error('runtime cookie unavailable'));
  f.monitor.noteMuxState('reconnecting');
  f.tick(31_000);
  assert.strictEqual(f.monitor.snapshot().degraded, true);
  f.monitor.reset();
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, false);
  assert.deepStrictEqual(snap.reasons, []);
  assert.strictEqual(snap.feedFailStreak, 0);
  assert.strictEqual(snap.authFailStreak, 0);
  assert.strictEqual(snap.feedLostForMs, 0);
  assert.strictEqual(snap.feedLive, false);
});

test('snapshot() is frozen, stable and carries the mux state', () => {
  const f = fixture();
  f.monitor.noteFeedStart({ protocol: 'mux' });
  f.monitor.noteMuxState('connecting');
  const a = f.monitor.snapshot();
  const b = f.monitor.snapshot();
  assert.deepStrictEqual(a, b);
  assert.strictEqual(Object.isFrozen(a), true);
  assert.strictEqual(a.muxState, 'connecting');
});

test('a fresh monitor (no feed yet) reports nothing', () => {
  const f = fixture();
  const snap = f.monitor.snapshot();
  assert.strictEqual(snap.degraded, false);
  assert.deepStrictEqual(snap.reasons, []);
  assert.strictEqual(snap.feedLive, false);
  assert.strictEqual(snap.feedLostForMs, 0);
  assert.strictEqual(snap.muxState, 'idle');
});
