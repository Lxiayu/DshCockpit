'use strict';

// src/office/render/fps-monitor.js — Blocker B / SPEC-07 runtime FPS
// observer. Pure deterministic CommonJS: no DOM, no Pixi, no timers, no
// wall-clock reads — the caller injects now() and calls frame() once per
// presented frame. This is NOT a simulation ticker: it only counts frames
// and can never advance movement, animation or any office state (the single
// office simulation clock stays in the main process).
//
// Degradation contract (SPEC-07): when the observed presentation rate stays
// below thresholdFps for lowWindowLimit consecutive windows of windowFrames
// frames, the monitor latches degraded=true exactly once and reports the
// stable code LOW_FPS_PERSISTENT — distinct from WEBGL_INIT_FAILED /
// RENDERER_UNAVAILABLE. There is no automatic recovery: a degraded monitor
// stays degraded so the fallback diagnostic state remains stable.

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

  return {
    frame,
    degraded: () => degraded,
    code: () => (degraded ? 'LOW_FPS_PERSISTENT' : null),
  };
}

module.exports = { createFpsMonitor, LOW_FPS_CODE: 'LOW_FPS_PERSISTENT' };
