'use strict';

// src/office/behavior-graph/feel.js — the feel layer as pure functions (brief §4.4).
//
// Parameters are borrowed from the peer project's teardown (dsh-pet, MIT code; its
// ASSETS and prompts are explicitly off-limits — only the structure and the numbers
// are reused, with attribution — see docs/strategy/2026-09-27-dsh-pet-teardown.md):
//
//   squash        0.55 amplitude, 220ms, first 45% ease-in then easeOutBack
//                 (c1 = 1.70158, overshoot capped at 1.12)
//   landing       300px/s → 0.8 (light) … 1500px/s → 0.55 (heavy)
//   mirror        scaleX(-1) flips a direction without a second asset
//   crossfade     0.18s between two clips (dual buffer, alpha)
//   displacement  driven by PLAYBACK TIME (leadSec/tailSec), so the step rhythm
//                 cannot drift from the animation
//
// Everything here is a pure function of numbers: the studio's A/B and the product's
// renderer can both call it and get the same transforms.

const SQUASH_AMPLITUDE = 0.55;
const SQUASH_MS = 220;
const EASE_IN_SHARE = 0.45;
const BACK_C1 = 1.70158;
const OVERSHOOT_CAP = 1.12;
const LANDING_SPEED_LIGHT = 300;
const LANDING_SPEED_HEAVY = 1500;
const LANDING_SCALE_LIGHT = 0.8;
const LANDING_SCALE_HEAVY = 0.55;
const CROSSFADE_MS = 180;
const DEFAULT_LEAD_SEC = 2;
const DEFAULT_TAIL_SEC = 2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// easeOutBack with the classic c1; capped so a big overshoot cannot look rubbery.
function easeOutBack(t, c1 = BACK_C1) {
  const u = t - 1;
  const value = 1 + (c1 + 1) * u * u * u + c1 * u * u;
  return Math.min(value, OVERSHOOT_CAP);
}

// The squash curve: `progress` 0…1 of the squash window.
function squashScale(progress) {
  const t = clamp(progress, 0, 1);
  if (t < EASE_IN_SHARE) {
    const u = t / EASE_IN_SHARE;
    return 1 - SQUASH_AMPLITUDE * (u * u);            // ease-in down
  }
  const u = (t - EASE_IN_SHARE) / (1 - EASE_IN_SHARE);
  const eased = easeOutBack(u);
  return (1 - SQUASH_AMPLITUDE) + SQUASH_AMPLITUDE * eased;  // easeOutBack up
}

// The landing amplitude depends on how fast the body arrives (px/s).
function landingSquash(speedPxPerSec) {
  const t = clamp((speedPxPerSec - LANDING_SPEED_LIGHT) / (LANDING_SPEED_HEAVY - LANDING_SPEED_LIGHT), 0, 1);
  return LANDING_SCALE_LIGHT + (LANDING_SCALE_HEAVY - LANDING_SCALE_LIGHT) * t;
}

// One transform for a squash impulse at time `elapsedMs` after landing.
function squashTransform({ elapsedMs, speedPxPerSec = LANDING_SPEED_LIGHT, mirrored = false, sizePx = 462 }) {
  const amplitude = landingSquash(speedPxPerSec);
  const progress = clamp(elapsedMs / SQUASH_MS, 0, 1);
  // scale the amplitude by the landing weight, keep the curve shape
  const scaleY = 1 - (1 - squashScale(progress)) * (amplitude / LANDING_SCALE_HEAVY) * (LANDING_SCALE_HEAVY / 1);
  const scaleX = 1 + (1 - scaleY) * 0.8;               // volume-ish preservation
  return {
    scaleX: Number(scaleX.toFixed(4)),
    scaleY: Number(scaleY.toFixed(4)),
    mirror: mirrored,
    // the transform the renderer applies: scaleX(-1) xor scaleY(s)
    css: `scale(${mirrored ? -1 : 1}, ${Number(scaleY.toFixed(4))})`,
  };
}

// Two-clip crossfade: returns the alpha of the NEW clip at `elapsedMs` into the fade.
function crossfadeAlpha({ elapsedMs, durationMs = CROSSFADE_MS }) {
  const t = clamp(elapsedMs / durationMs, 0, 1);
  return { incoming: Number(t.toFixed(4)), outgoing: Number((1 - t).toFixed(4)), done: t >= 1 };
}

// Displacement driven by playback time (never by a separate timer):
// static for the leading segment, linear in the middle, stopped for the tail.
function displacementForPlayback({ currentTimeSec, clipDurationSec, distancePx, leadSec = DEFAULT_LEAD_SEC, tailSec = DEFAULT_TAIL_SEC }) {
  const span = Math.max(0, clipDurationSec - leadSec - tailSec);
  if (span === 0 || distancePx === 0) return { progress: 0, offsetPx: 0, phase: 'static' };
  if (currentTimeSec <= leadSec) return { progress: 0, offsetPx: 0, phase: 'lead' };
  if (currentTimeSec >= clipDurationSec - tailSec) return { progress: 1, offsetPx: distancePx, phase: 'tail' };
  const progress = (currentTimeSec - leadSec) / span;
  return { progress: Number(progress.toFixed(5)), offsetPx: Number((distancePx * progress).toFixed(3)), phase: 'moving' };
}

// Distance scaling by body size (the peer scales a 462px reference).
function scaledDistance(distancePx, sizePx, referencePx = 462) {
  return Number((distancePx * (sizePx / referencePx)).toFixed(3));
}

module.exports = {
  BACK_C1,
  CROSSFADE_MS,
  DEFAULT_LEAD_SEC,
  DEFAULT_TAIL_SEC,
  EASE_IN_SHARE,
  LANDING_SCALE_HEAVY,
  LANDING_SCALE_LIGHT,
  LANDING_SPEED_HEAVY,
  LANDING_SPEED_LIGHT,
  OVERSHOOT_CAP,
  SQUASH_AMPLITUDE,
  SQUASH_MS,
  clamp,
  crossfadeAlpha,
  displacementForPlayback,
  easeOutBack,
  landingSquash,
  scaledDistance,
  squashScale,
  squashTransform,
};
