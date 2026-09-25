'use strict';

// src/office/runtime/animation-controller.js — Task 3 / SPEC-03.
//
// Stateless animation selection over an explicit elapsed time. The frame
// clock is independent from movement: this module never advances a position,
// never reads a clock, and never infers Runtime state from image playback.
// Repeated calls with identical inputs return identical (frozen) results.
//
// Duration precedence (per frame):
//   userFrameDurationOverrideMs (when non-null)
//     > per-frame durationMs (when non-null)
//     > animation frameDurationMs (when present)
//     > pack defaultFrameDurationMs (when present)
//     > 1000ms fallback
//
// All state/direction -> resource resolution is delegated to asset-pack.js;
// missing optional states surface the pack's fallback reason unchanged.

const FALLBACK_FRAME_DURATION_MS = 1000;

function clampElapsed(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return elapsedMs;
}

function frameDurationMs({ frame, animationMeta, pack, userFrameDurationOverrideMs }) {
  if (userFrameDurationOverrideMs !== null && userFrameDurationOverrideMs !== undefined) {
    return userFrameDurationOverrideMs;
  }
  if (frame && frame.durationMs !== null && frame.durationMs !== undefined) {
    return frame.durationMs;
  }
  if (animationMeta && animationMeta.frameDurationMs !== null && animationMeta.frameDurationMs !== undefined) {
    return animationMeta.frameDurationMs;
  }
  if (pack && pack.defaultFrameDurationMs !== null && pack.defaultFrameDurationMs !== undefined) {
    return pack.defaultFrameDurationMs;
  }
  return FALLBACK_FRAME_DURATION_MS;
}

// Locates (frameIndex, frameElapsedMs) for one non-negative elapsed time by
// walking the declared durations. Frame boundaries belong to the NEXT frame
// (elapsed == boundary => frameElapsedMs restarts at 0), which keeps the
// mapping deterministic and loop-safe.
function locateFrame(durations, elapsedMs) {
  let remaining = elapsedMs;
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index] > 0 ? durations[index] : FALLBACK_FRAME_DURATION_MS;
    if (remaining < duration) return { frameIndex: index, frameElapsedMs: remaining };
    remaining -= duration;
  }
  const last = durations.length - 1;
  const lastDuration = durations[last] > 0 ? durations[last] : FALLBACK_FRAME_DURATION_MS;
  return { frameIndex: last, frameElapsedMs: lastDuration };
}

function loopedFrameIndex(durations, elapsedMs) {
  const total = durations.reduce((sum, duration) => sum + (duration > 0 ? duration : FALLBACK_FRAME_DURATION_MS), 0);
  let remaining = elapsedMs % total;
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index] > 0 ? durations[index] : FALLBACK_FRAME_DURATION_MS;
    if (remaining < duration) return { frameIndex: index, frameElapsedMs: remaining };
    remaining -= duration;
  }
  return { frameIndex: 0, frameElapsedMs: 0 };
}

function resolveAnimation(request) {
  const state = request ? request.state : undefined;
  const direction = request ? request.direction : undefined;
  const elapsedMs = clampElapsed(request ? request.elapsedMs : 0);
  const pack = request ? request.pack : null;
  const override =
    request && request.userFrameDurationOverrideMs !== undefined ? request.userFrameDurationOverrideMs : null;

  if (!pack || pack.ok === false || typeof pack.resolve !== 'function') {
    const code = pack && pack.code ? pack.code : 'PACK_INVALID';
    return Object.freeze({
      code,
      resource: null,
      animationId: null,
      frameIndex: 0,
      frameElapsedMs: 0,
      frameCount: 0,
      loop: false,
      emphasis: null,
      fallbackReason: code,
      capabilityMissing: Object.freeze([]),
    });
  }

  const selection = pack.resolve({ state, direction });
  if (selection.code !== 'RESOLVED') {
    return Object.freeze({
      code: selection.code,
      resource: null,
      animationId: null,
      frameIndex: 0,
      frameElapsedMs: 0,
      frameCount: 0,
      loop: false,
      emphasis: null,
      fallbackReason: selection.fallbackReason,
      capabilityMissing: selection.capabilityMissing,
    });
  }

  // Programmatic emphasis is not a frame sequence: it is a stable one-frame
  // effect marker that a renderer evaluates without touching positions.
  if (selection.emphasis) {
    return Object.freeze({
      code: 'RESOLVED',
      resource: null,
      animationId: null,
      frameIndex: 0,
      frameElapsedMs: 0,
      frameCount: 1,
      loop: false,
      emphasis: selection.emphasis,
      fallbackReason: selection.fallbackReason,
      capabilityMissing: selection.capabilityMissing,
    });
  }

  const animationMeta = pack.animation(selection.resource);
  if (!animationMeta || animationMeta.frames.length === 0) {
    return Object.freeze({
      code: 'ANIMATION_METADATA_INVALID',
      resource: selection.resource,
      animationId: selection.resource,
      frameIndex: 0,
      frameElapsedMs: 0,
      frameCount: 0,
      loop: false,
      emphasis: null,
      fallbackReason: 'ANIMATION_METADATA_INVALID',
      capabilityMissing: selection.capabilityMissing,
    });
  }

  const validOverride =
    override !== null && typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : null;
  const durations = animationMeta.frames.map((frame) => {
    if (validOverride !== null) return validOverride;
    if (frame.durationMs !== null && frame.durationMs > 0) return frame.durationMs;
    if (animationMeta.frameDurationMs !== null && animationMeta.frameDurationMs > 0) {
      return animationMeta.frameDurationMs;
    }
    if (pack.defaultFrameDurationMs !== null && pack.defaultFrameDurationMs > 0) {
      return pack.defaultFrameDurationMs;
    }
    return FALLBACK_FRAME_DURATION_MS;
  });

  const frameCount = animationMeta.frames.length;
  const located = selection.loop ? loopedFrameIndex(durations, elapsedMs) : locateFrame(durations, elapsedMs);

  return Object.freeze({
    code: 'RESOLVED',
    resource: selection.resource,
    animationId: selection.resource,
    frameIndex: located.frameIndex,
    frameElapsedMs: located.frameElapsedMs,
    frameCount,
    loop: selection.loop,
    emphasis: null,
    fallbackReason: selection.fallbackReason,
    capabilityMissing: selection.capabilityMissing,
  });
}

function createAnimationController() {
  return Object.freeze({
    resolve: Object.freeze((request) => resolveAnimation(request)),
  });
}

module.exports = {
  resolveAnimation,
  createAnimationController,
  FALLBACK_FRAME_DURATION_MS,
};
