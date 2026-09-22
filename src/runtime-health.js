// src/runtime-health.js — runtime health posture for the container hardening
// (2026-09-23, "harness 可以坏、壳不能坏").
//
// The shell keeps working when the harness's event surface degrades — but a
// silent degradation is indistinguishable from a healthy install to the user.
// This module turns the three observable failure signals into ONE machine-
// readable posture (degraded + reasons) that the tray, the settings runtime
// page and the runtime-state diagnostics all render:
//
//   · feed-fail-streak    N consecutive feed/mux connection failures
//                         (3 by default — matches the existing "3 strikes" log)
//   · auth-fail-streak    N consecutive runtime cookie exchanges failing
//                         (the token→dsh-auth-* exchange; without it every
//                         /api route and the mux upgrade 401s)
//   · feed-disconnected   the mux has NOT been live for `disconnectMs`
//                         (30s by default) — the "看着正常其实没数据" case.
//                         Only meaningful on the mux protocol: the 0.1.1
//                         events.host is frame-silent while idle, so a
//                         silence timer there would false-alarm.
//
// Pure Node, clock-injected: main.js observes (noteFeedStart/noteFeedLive/
// noteFeedFailure/noteMuxState/reset) and renders snapshot(); the module owns
// no timers, no I/O and never throws.
'use strict';

const DEFAULT_FAIL_STREAK = 3;
const DEFAULT_DISCONNECT_MS = 30_000;

function isCookieFailure(err) {
  const message = String((err && err.message) || err || '').toLowerCase();
  return message.includes('cookie') || message.includes('credential');
}

function createRuntimeHealthMonitor({
  failStreak = DEFAULT_FAIL_STREAK,
  disconnectMs = DEFAULT_DISCONNECT_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const threshold = Math.max(1, Number(failStreak) || DEFAULT_FAIL_STREAK);
  const disconnect = Math.max(1_000, Number(disconnectMs) || DEFAULT_DISCONNECT_MS);

  let feedStartedAt = 0;   // last noteFeedStart()
  let lastLostAt = 0;      // feed last went (or stayed) not-live
  let feedFailStreak = 0;  // all failures
  let authFailStreak = 0;  // cookie-exchange failures (subset)
  let live = false;        // proven live right now
  let liveSeen = false;    // live at least once since the last start
  let muxSeen = false;     // noteMuxState() ever called (mux protocol only)
  let muxState = 'idle';

  function markLive(at) {
    live = true;
    liveSeen = true;
    feedFailStreak = 0;
    authFailStreak = 0;
    lastLostAt = 0;
    muxState = 'live';
    if (typeof log === 'function' && at !== undefined) log(`[runtime-health] feed live (${new Date(at).toISOString()})`);
  }

  function markLost(at) {
    live = false;
    if (!lastLostAt) lastLostAt = at;
  }

  /** A feed generation begins (runtime healthy / restart). */
  function noteFeedStart({ protocol = 'mux' } = {}) {
    feedStartedAt = now();
    lastLostAt = feedStartedAt;
    feedFailStreak = 0;
    authFailStreak = 0;
    live = false;
    liveSeen = false;
    muxState = protocol === 'mux' ? 'connecting' : 'legacy';
  }

  /** A feed frame proves the surface is delivering (mux ready / status frame). */
  function noteFeedLive() {
    markLive(now());
  }

  /** One connection failure. Cookie failures advance the AUTH streak only
   * (a failed token exchange is an auth problem with its own remedy — the
   * feed itself never got a chance to connect). */
  function noteFeedFailure(err) {
    const at = now();
    if (isCookieFailure(err)) authFailStreak += 1;
    else feedFailStreak += 1;
    markLost(at);
    return { feedFailStreak, authFailStreak };
  }

  /** The mux client's own state ('idle'|'connecting'|'live'|'reconnecting'|'closed'). */
  function noteMuxState(state) {
    muxSeen = true;
    if (state === 'live') {
      // repeated 'live' observations (the 5s tick) must not re-log; only a real
      // transition back to live is an event
      if (live) { muxState = 'live'; return muxState; }
      markLive(now());
      return muxState;
    }
    muxState = typeof state === 'string' && state ? state : 'unknown';
    markLost(now());
    return muxState;
  }

  /** Feed stopped (runtime restart / quit): forget everything. */
  function reset() {
    feedStartedAt = 0;
    lastLostAt = 0;
    feedFailStreak = 0;
    authFailStreak = 0;
    live = false;
    liveSeen = false;
    muxSeen = false;
    muxState = 'idle';
  }

  function snapshot(at = now()) {
    const reasons = [];
    if (feedFailStreak >= threshold) reasons.push('feed-fail-streak');
    if (authFailStreak >= threshold) reasons.push('auth-fail-streak');
    // The disconnect clock only runs on the mux protocol (liveSeen guards the
    // very first connect; a feed that never delivered anything yet is covered
    // by the fail-streak rules instead of a silence timer).
    const lostForMs = lastLostAt ? Math.max(0, at - lastLostAt) : 0;
    if (muxSeen && feedStartedAt > 0 && liveSeen && lastLostAt > 0 && lostForMs >= disconnect) {
      reasons.push('feed-disconnected');
    }
    return Object.freeze({
      degraded: reasons.length > 0,
      reasons: Object.freeze(reasons),
      feedLive: live,
      muxState,
      feedFailStreak,
      authFailStreak,
      feedLostForMs: lostForMs,
      threshold,
      disconnectMs: disconnect,
    });
  }

  return { noteFeedStart, noteFeedLive, noteFeedFailure, noteMuxState, reset, snapshot };
}

module.exports = { createRuntimeHealthMonitor, DEFAULT_FAIL_STREAK, DEFAULT_DISCONNECT_MS };
