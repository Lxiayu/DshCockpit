'use strict';

// src/office/render/fps-monitor.js — Blocker B / SPEC-07 runtime FPS
// observer. Pure deterministic CommonJS: no DOM, no Pixi, no timers, no
// wall-clock reads — the caller injects now() and calls frame() once per
// presented frame (and poll() from its own watchdog). This is NOT a
// simulation ticker: it only counts frames and can never advance movement,
// animation or any office state (the single office simulation clock stays in
// the main process).
//
// Degradation contract (SPEC-07; latch fix 2026-09-24; judgement rewrite
// 2026-09-24 — see docs/strategy/2026-09-24-office-perf-mustfix.md): when the
// observed presentation rate stays below thresholdFps for lowWindowLimit
// consecutive windows, the monitor latches degraded=true exactly once and
// reports the stable code LOW_FPS_PERSISTENT — distinct from
// WEBGL_INIT_FAILED / RENDERER_UNAVAILABLE. There is no automatic recovery
// inside the monitor: an unattended monitor stays degraded so the fallback
// diagnostic state remains stable. The ONE sanctioned re-arm is reset(),
// which the view owner calls explicitly (foreground transition, a bounded
// recovery rebuild, or a user-requested retry). No timers, no wall-clock
// reads, no self-recovery path.
//
// WINDOWS: two shapes, selected by windowMs.
// - windowMs = 0 (default, the pre-2026-09-24 shape): a window is
//   windowFrames frames long. Kept EXACTLY as before for every existing
//   caller and test.
// - windowMs > 0: a window is windowMs of WALL TIME (or windowFrames frames,
//   whichever comes first). This is the production office shape: the
//   judgement becomes "was the average presentation rate over the last
//   windowMs below thresholdFps" instead of "how fast did the last N frames
//   arrive", so a machine that renders at a steady 24-29 fps closes one
//   3s-window every 3s instead of one 0.5s-window every 0.5s. Rationale and
//   the Windows/AV context: the old shape latched a 15 fps machine in ~10s
//   and a 29 fps machine in ~5s, and the office screen went static — users
//   read that as "the office froze / not responding".
// - poll() closes an overdue window WITHOUT requiring a frame, so a renderer
//   that stops presenting entirely (0 frames: a hung rAF pump, a lost
//   context) still produces low windows and still latches. Under the old
//   frame-count shape a frozen renderer produced no windows at all and was
//   therefore never caught. poll() is a pure function of the injected clock —
//   the monitor itself still owns no timer (the view owner schedules it).

// Production office policy (2026-09-24 M1). Exported so the page config and
// the tests can only mean one thing; the renderer's createFpsMonitor defaults
// stay the historical 30/30/5 + frame windows for backward compatibility.
const OFFICE_LOW_FPS_POLICY = Object.freeze({
  thresholdFps: 20,     // "usable but slow" is not "broken": 20-30 fps keeps the scene live
  windowFrames: 240,    // upper bound on a window (>= 3s at 80 fps)
  windowMs: 3_000,      // the judgement window is 3 seconds of wall time
  lowWindowLimit: 4,    // 4 consecutive bad 3s windows = 12s of sustained sub-20fps
  // Renderer knobs (not monitor options; createFpsMonitor ignores them):
  // staticFloorFps — the static diagnostic presentation is reserved for a rate
  // that is not merely slow. A machine that keeps ≥10 fps stays on the living
  // low-cost profile instead of losing the scene; below it (or with no frames
  // at all) the static fallback is the honest answer.
  staticFloorFps: 10,
  stallMs: 3_000,       // the stall watchdog period (<= windowMs)
});
// The view owner's stall watchdog period: how often poll() is called while the
// frame pump is armed. Must be <= windowMs so an overdue window is never left
// open much past its deadline.
const OFFICE_STALL_POLL_MS = OFFICE_LOW_FPS_POLICY.stallMs;

function createFpsMonitor(options) {
  const {
    thresholdFps = 30,
    windowFrames = 30,
    lowWindowLimit = 5,
    windowMs = 0,
    now = () => Date.now(),
    onDegrade = null,
  } = options || {};

  if (typeof now !== 'function') throw new TypeError('createFpsMonitor requires an injectable now()');
  if (!(thresholdFps > 0)) throw new TypeError('thresholdFps must be > 0');
  if (!(windowFrames > 0)) throw new TypeError('windowFrames must be > 0');
  if (!(lowWindowLimit > 0)) throw new TypeError('lowWindowLimit must be > 0');
  if (!(windowMs >= 0)) throw new TypeError('windowMs must be >= 0');

  let degraded = false;
  let framesInWindow = 0;
  let windowStartMs = null;
  let consecutiveLowWindows = 0;
  // Session telemetry (never affects the decision) — the behaviour table in the
  // mustfix doc and the runtime diagnostics read these.
  let totalWindows = 0;
  let lowWindows = 0;
  let lastFps = null;
  // Anchor for the "no frames at all" case: when no window is open, an overdue
  // poll measures from here. Set at creation, on every window close and by
  // reset(), so a stalled renderer can still latch.
  let lastFrameAtMs = now();

  function closeWindow(at, frames, elapsedMs) {
    const ms = Math.max(1, elapsedMs);
    const fps = (frames / ms) * 1000;
    lastFps = fps;
    totalWindows += 1;
    if (fps < thresholdFps) {
      consecutiveLowWindows += 1;
      lowWindows += 1;
    } else {
      consecutiveLowWindows = 0;
    }
    if (consecutiveLowWindows >= lowWindowLimit) {
      degraded = true;
      if (typeof onDegrade === 'function') {
        try { onDegrade('LOW_FPS_PERSISTENT'); } catch { /* observer errors never break the monitor */ }
      }
    }
    framesInWindow = 0;
    windowStartMs = null;
    lastFrameAtMs = at;
  }

  function frame() {
    if (degraded) return degraded; // latched: inert after degradation
    const at = now();
    if (windowStartMs === null) windowStartMs = at;
    framesInWindow += 1;
    const byFrames = framesInWindow >= windowFrames;
    const byTime = windowMs > 0 && (at - windowStartMs) >= windowMs;
    if (byFrames || byTime) closeWindow(at, framesInWindow, at - windowStartMs);
    return degraded;
  }

  // Closes an overdue window even when frames stopped arriving: 0 frames in
  // windowMs is 0 fps by construction. No-op for the frame-count shape
  // (windowMs === 0) and when the current window is not overdue yet.
  function poll() {
    if (degraded) return degraded;
    if (!(windowMs > 0)) return degraded;
    const at = now();
    const since = at - (windowStartMs !== null ? windowStartMs : lastFrameAtMs);
    if (since < windowMs) return degraded;
    closeWindow(at, framesInWindow, since);
    return degraded;
  }

  // Re-arm the monitor (SPEC-07 correction, 2026-09-24): clears the degraded
  // latch AND discards the in-flight measurement window. Called by the view
  // owner at the foreground transition (renderer.setVisible(true)), after a
  // bounded LOW_FPS_PERSISTENT recovery rebuild, and after a user-requested
  // retry — so a fresh measurement window starts from zero frames. Frames
  // delivered at background rate (a detached view presents at ~1.3-7.9 fps)
  // can never share a window with foreground frames and latch the monitor
  // artificially.
  function reset() {
    degraded = false;
    framesInWindow = 0;
    windowStartMs = null;
    consecutiveLowWindows = 0;
    lastFrameAtMs = now();
  }

  return {
    frame,
    poll,
    reset,
    degraded: () => degraded,
    code: () => (degraded ? 'LOW_FPS_PERSISTENT' : null),
    // Read-only telemetry for diagnostics()/probes: window counts, the last
    // measured rate and the active policy. Never used by the decision.
    stats: () => ({
      windows: totalWindows,
      lowWindows,
      consecutiveLowWindows,
      lastFps,
      degraded,
      thresholdFps,
      windowFrames,
      windowMs,
      lowWindowLimit,
    }),
  };
}

module.exports = {
  createFpsMonitor,
  LOW_FPS_CODE: 'LOW_FPS_PERSISTENT',
  OFFICE_LOW_FPS_POLICY,
  OFFICE_STALL_POLL_MS,
};
