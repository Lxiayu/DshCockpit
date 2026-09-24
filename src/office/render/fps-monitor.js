'use strict';

// src/office/render/fps-monitor.js — Blocker B / SPEC-07 runtime FPS
// observer. Pure deterministic CommonJS: no DOM, no Pixi, no timers, no
// wall-clock reads — the caller injects now() and calls frame() once per
// presented frame. This is NOT a simulation ticker: it only counts frames
// and can never advance movement, animation or any office state (the single
// office simulation clock stays in the main process).
//
// Degradation contract (SPEC-07, corrected 2026-09-24): when the observed
// presentation rate stays below thresholdFps for lowWindowLimit consecutive
// windows of windowFrames frames, the monitor latches degraded=true exactly
// once and reports the stable code LOW_FPS_PERSISTENT — distinct from
// WEBGL_INIT_FAILED / RENDERER_UNAVAILABLE. There is no automatic recovery:
// an unattended monitor stays degraded so the fallback diagnostic state
// remains stable. The ONE sanctioned re-arm is reset(), which the view
// owner calls explicitly when the office becomes the foreground view again
// (after a rebuild): it clears the latch and the in-flight window so the
// foreground windows can never inherit the previous measurement history.
// No timers, no wall-clock reads, no self-recovery path — reset() is the
// only way back, and only the renderer's bounded recovery policy calls it.

function createFpsMonitor(options) {
  const {
    thresholdFps = 30,
    windowFrames = 30,
    lowWindowLimit = 5,
    now = () => Date.now(),
    onDegrade = null,
  } = options || {};

  if (typeof now !== 'function') throw new TypeError('createFpsMonitor requires an injectable now()');
  if (!(thresholdFps > 0)) throw new TypeError('thresholdFps must be > 0');
  if (!(windowFrames > 0)) throw new TypeError('windowFrames must be > 0');
  if (!(lowWindowLimit > 0)) throw new TypeError('lowWindowLimit must be > 0');

  let degraded = false;
  let framesInWindow = 0;
  let windowStartMs = null;
  let consecutiveLowWindows = 0;

  function frame() {
    if (degraded) return degraded; // latched: inert after degradation
    const at = now();
    if (windowStartMs === null) windowStartMs = at;
    framesInWindow += 1;
    if (framesInWindow >= windowFrames) {
      const elapsedMs = Math.max(1, at - windowStartMs);
      const fps = (framesInWindow / elapsedMs) * 1000;
      if (fps < thresholdFps) {
        consecutiveLowWindows += 1;
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
    }
    return degraded;
  }

  // Re-arm the monitor (SPEC-07 correction, 2026-09-24): clears the degraded
  // latch AND discards the in-flight measurement window. Called by the view
  // owner at the foreground transition (renderer.setVisible(true)) and after
  // a bounded LOW_FPS_PERSISTENT recovery rebuild, so a fresh measurement
  // window starts from zero frames — frames delivered at background rate
  // (a detached view presents at ~1.3-7.9 fps) can never share a window with
  // foreground frames and latch the monitor artificially.
  function reset() {
    degraded = false;
    framesInWindow = 0;
    windowStartMs = null;
    consecutiveLowWindows = 0;
  }

  return {
    frame,
    reset,
    degraded: () => degraded,
    code: () => (degraded ? 'LOW_FPS_PERSISTENT' : null),
  };
}

module.exports = { createFpsMonitor, LOW_FPS_CODE: 'LOW_FPS_PERSISTENT' };
