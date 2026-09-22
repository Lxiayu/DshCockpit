'use strict';

// src/office/runtime/asset-pack.js — Task 3 / SPEC-03 pure asset resolver.
//
// Deterministic CommonJS resolver over the Task 2 normalized pack schema
// (manifest.json + animation/anchors.json + animation/animations.json),
// supplied IN MEMORY by the caller. This module never reads files, never
// executes pack code, and has no Electron/Pixi/DOM/fs/network/clock access.
//
// Resolution order (SPEC-02 fallback chain):
//   1. dedicated animation  (walk-<direction>, or the state's own animation)
//   2. compatible static pose (state fallback chain, ending at `idle`)
//   3. compatible directional pose (side-left/right/back)
//   4. declared programmatic emphasis (manifest.fallback.allowProgrammaticEmphasis)
//
// Missing optional states are reported explicitly via `capabilityMissing`
// and, when nothing can cover them, code ANIMATION_CAPABILITY_MISSING —
// never a silent null. Malformed metadata yields stable diagnostic codes
// (PACK_MANIFEST_INVALID / PACK_GEOMETRY_INVALID / PACK_ASSET_MISSING /
// PACK_UNSAFE_ARCHIVE) instead of thrown errors. The `offline` state is never
// selectable: presence=present is a resident invariant (SPEC-00).
//
// Renderer-facing size contract (SPEC-02 / 决策 43):
//   visibleHeight = clamp(64, sceneHeight * 0.11, 180)
// One employee uses one computed visible height for every state, direction
// and walk frame, derived from the pack-level normalized `visibleBounds`.

const SCHEMA_VERSION = 1;
const DIRECTIONS = Object.freeze(['none', 'left', 'right', 'up', 'down']);
const WALK_DIRECTIONS = Object.freeze(['left', 'right', 'up', 'down']);
const SIDE_PREFERENCE = Object.freeze({
  left: Object.freeze(['side-left', 'side-right', 'side-back']),
  right: Object.freeze(['side-right', 'side-left', 'side-back']),
  up: Object.freeze(['side-back', 'side-left', 'side-right']),
  down: Object.freeze(['side-back', 'side-left', 'side-right']),
  none: Object.freeze(['side-back', 'side-left', 'side-right']),
});
// Required capabilities invalidate the pack (SPEC-02: idle + four walk
// directions). Missing optional capabilities only produce diagnostics.
const REQUIRED_STATES = Object.freeze(['idle']);
const REQUIRED_WALK_DIRECTIONS = WALK_DIRECTIONS;
const OPTIONAL_STATES = Object.freeze([
  'working', 'finished', 'warning', 'error', 'offline', 'sleeping', 'completed',
  'failed', 'attention', 'thinking', 'waiting', 'celebrating', 'chatting', 'side',
]);
// Static-pose fallback chains per requested state. Chains only contain
// non-directional states; when a chain is exhausted the directional side
// poses are tried (decision 31: 侧身/静态方向姿态), then programmatic
// emphasis. `thinking`/`chatting`/`walk` intentionally have no neutral
// static fallback so their documented directional poses apply.
const STATE_FALLBACK_CHAINS = Object.freeze({
  working: Object.freeze(['working']),
  thinking: Object.freeze(['thinking']),
  waiting: Object.freeze(['waiting', 'idle']),
  resting: Object.freeze(['resting', 'idle']),
  sleeping: Object.freeze(['sleeping', 'idle']),
  celebrating: Object.freeze(['celebrating', 'completed', 'finished', 'idle']),
  completed: Object.freeze(['completed', 'finished', 'idle']),
  failed: Object.freeze(['failed', 'error', 'idle']),
  attention: Object.freeze(['attention', 'warning', 'error', 'idle']),
  chatting: Object.freeze(['chatting']),
  roaming: Object.freeze(['idle']),
  idle: Object.freeze(['idle']),
  walk: Object.freeze([]),
});
const EMPHASIS_EFFECTS = Object.freeze({
  celebrating: 'bounce',
  completed: 'bounce',
  failed: 'shake',
  attention: 'shake',
});
const OFFLINE_STATE = 'offline';
const FALLBACK_FRAME_DURATION_MS = 1000;

const VISIBLE_HEIGHT = Object.freeze({ minPx: 64, sceneRatio: 0.11, maxPx: 180 });

function computeVisibleHeight(sceneHeight) {
  if (typeof sceneHeight !== 'number' || !Number.isFinite(sceneHeight) || sceneHeight <= 0) {
    return VISIBLE_HEIGHT.minPx;
  }
  return Math.min(
    VISIBLE_HEIGHT.maxPx,
    Math.max(VISIBLE_HEIGHT.minPx, sceneHeight * VISIBLE_HEIGHT.sceneRatio)
  );
}

function computeSpriteScale(geometry, visibleHeight) {
  if (!geometry || !geometry.visibleBounds || !(geometry.visibleBounds.height > 0)) return null;
  return visibleHeight / geometry.visibleBounds.height;
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function isPoint(point) {
  return !!point && Number.isInteger(point.x) && Number.isInteger(point.y);
}

function isBounds(bounds) {
  return (
    !!bounds &&
    Number.isInteger(bounds.x) &&
    Number.isInteger(bounds.y) &&
    isPositiveInt(bounds.width) &&
    isPositiveInt(bounds.height)
  );
}

function pointInCanvas(point, canvas) {
  return point.x >= 0 && point.y >= 0 && point.x < canvas.width && point.y < canvas.height;
}

function boundsInCanvas(bounds, canvas) {
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= canvas.width &&
    bounds.y + bounds.height <= canvas.height
  );
}

function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

function diagnosticResult(code, errors) {
  return Object.freeze({
    code,
    resource: null,
    animationId: null,
    state: null,
    direction: 'none',
    frameCount: 0,
    loop: false,
    emphasis: null,
    fallbackReason: code,
    capabilityMissing: Object.freeze([]),
    missingCapabilities: Object.freeze([]),
    errors: Object.freeze((errors || []).map((error) => Object.freeze({ ...error }))),
  });
}

function createAssetPack(input) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });

  const manifest = input && input.manifest;
  const anchors = input && input.anchors;
  const animations = input && input.animations;

  // ---- manifest ----------------------------------------------------------
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'PACK_MANIFEST_INVALID', errors: [{ code: 'PACK_MANIFEST_INVALID', message: 'manifest must be an object' }] };
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    fail('PACK_MANIFEST_INVALID', `manifest.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (typeof manifest.id !== 'string' || !manifest.id) {
    fail('PACK_MANIFEST_INVALID', 'manifest.id is required');
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail('PACK_MANIFEST_INVALID', 'manifest.version is required');
  }
  if (typeof manifest.license !== 'string' || !manifest.license) {
    fail('PACK_MANIFEST_INVALID', 'manifest.license is required');
  }
  const fallback = manifest.fallback && typeof manifest.fallback === 'object' && !Array.isArray(manifest.fallback)
    ? manifest.fallback
    : {};
  const allowStaticPose = fallback.allowStaticPose !== false;
  const allowProgrammaticEmphasis = fallback.allowProgrammaticEmphasis === true;

  // ---- geometry (anchors.json is the sole geometry authority) -------------
  let geometry = null;
  if (!anchors || typeof anchors !== 'object' || Array.isArray(anchors)) {
    fail('PACK_GEOMETRY_INVALID', 'anchors must be an object');
  } else {
    if (anchors.schemaVersion !== SCHEMA_VERSION) {
      fail('PACK_GEOMETRY_INVALID', `anchors.schemaVersion must be ${SCHEMA_VERSION}`);
    }
    const sourceCanvas = anchors.sourceCanvas;
    const outputCanvas = anchors.outputCanvas;
    if (!sourceCanvas || !isPositiveInt(sourceCanvas.width) || !isPositiveInt(sourceCanvas.height)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.sourceCanvas must be positive integers');
    }
    if (!outputCanvas || !isPositiveInt(outputCanvas.width) || !isPositiveInt(outputCanvas.height)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.outputCanvas must be positive integers');
    }
    if (typeof anchors.outputScale !== 'number' || !(anchors.outputScale > 0)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.outputScale must be a positive number');
    }
    if (outputCanvas && isPositiveInt(outputCanvas.width)) {
      if (!isPoint(anchors.anchor) || !pointInCanvas(anchors.anchor, outputCanvas)) {
        fail('PACK_GEOMETRY_INVALID', 'anchors.anchor must be inside outputCanvas');
      }
      if (!isBounds(anchors.visibleBounds) || !boundsInCanvas(anchors.visibleBounds, outputCanvas)) {
        fail('PACK_GEOMETRY_INVALID', 'anchors.visibleBounds must be inside outputCanvas');
      }
      const anchorFrames = anchors.frames && typeof anchors.frames === 'object' && !Array.isArray(anchors.frames)
        ? anchors.frames
        : {};
      for (const file of Object.keys(anchorFrames)) {
        if (!isSafeRelativePath(file)) {
          fail('PACK_UNSAFE_ARCHIVE', `anchors frame path is not a safe relative path: ${file}`);
          continue;
        }
        const entry = anchorFrames[file];
        if (!entry || typeof entry !== 'object') {
          fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}] must be an object`);
          continue;
        }
        if (entry.outputAnchor !== undefined && entry.outputAnchor !== null) {
          if (!isPoint(entry.outputAnchor) || !pointInCanvas(entry.outputAnchor, outputCanvas)) {
            fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}].outputAnchor must be inside outputCanvas`);
          }
        }
        if (entry.visibleBounds !== undefined && entry.visibleBounds !== null) {
          if (!isBounds(entry.visibleBounds) || !boundsInCanvas(entry.visibleBounds, outputCanvas)) {
            fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}].visibleBounds must be inside outputCanvas`);
          }
        }
      }
    }
    geometry = anchors;
  }

  // ---- animations (animations.json is the sole frame/timing authority) ----
  const byId = new Map();
  const byState = new Map();
  let defaultFrameDurationMs = null;
  if (!animations || typeof animations !== 'object' || Array.isArray(animations)) {
    fail('PACK_MANIFEST_INVALID', 'animations must be an object');
  } else {
    if (animations.schemaVersion !== SCHEMA_VERSION) {
      fail('PACK_MANIFEST_INVALID', `animations.schemaVersion must be ${SCHEMA_VERSION}`);
    }
    if (animations.defaultFrameDurationMs !== undefined && animations.defaultFrameDurationMs !== null) {
      if (!isPositiveInt(animations.defaultFrameDurationMs) || animations.defaultFrameDurationMs > 60000) {
        fail('PACK_MANIFEST_INVALID', 'animations.defaultFrameDurationMs must be a positive integer (ms)');
      } else {
        defaultFrameDurationMs = animations.defaultFrameDurationMs;
      }
    }
    const entries = animations.animations && typeof animations.animations === 'object' && !Array.isArray(animations.animations)
      ? animations.animations
      : null;
    if (!entries || Object.keys(entries).length === 0) {
      fail('PACK_MANIFEST_INVALID', 'animations.animations must be a non-empty object');
    } else {
      for (const id of Object.keys(entries)) {
        const animation = entries[id];
        if (!animation || typeof animation !== 'object' || Array.isArray(animation)) {
          fail('PACK_MANIFEST_INVALID', `animations[${id}] must be an object`);
          continue;
        }
        if (typeof animation.state !== 'string' || !animation.state) {
          fail('PACK_MANIFEST_INVALID', `animations[${id}].state is required`);
          continue;
        }
        if (!DIRECTIONS.includes(animation.direction)) {
          fail('PACK_MANIFEST_INVALID', `animations[${id}].direction must be one of ${DIRECTIONS.join('|')}`);
          continue;
        }
        if (typeof animation.loop !== 'boolean') {
          fail('PACK_MANIFEST_INVALID', `animations[${id}].loop must be boolean`);
          continue;
        }
        if (!Array.isArray(animation.frames) || animation.frames.length === 0) {
          fail('PACK_MANIFEST_INVALID', `animations[${id}].frames must be a non-empty array`);
          continue;
        }
        if (
          animation.frameDurationMs !== undefined &&
          animation.frameDurationMs !== null &&
          (!isPositiveInt(animation.frameDurationMs) || animation.frameDurationMs > 60000)
        ) {
          fail('PACK_MANIFEST_INVALID', `animations[${id}].frameDurationMs must be null or a positive integer (ms)`);
          continue;
        }
        const frames = [];
        let framesValid = true;
        for (const frame of animation.frames) {
          if (!frame || typeof frame !== 'object') {
            fail('PACK_MANIFEST_INVALID', `animations[${id}] frames must be objects`);
            framesValid = false;
            break;
          }
          if (!isSafeRelativePath(frame.file)) {
            fail('PACK_UNSAFE_ARCHIVE', `animations[${id}] frame path is not a safe relative path: ${JSON.stringify(frame.file)}`);
            framesValid = false;
            break;
          }
          if (frame.durationMs !== undefined && frame.durationMs !== null) {
            if (!isPositiveInt(frame.durationMs) || frame.durationMs > 60000) {
              fail('PACK_MANIFEST_INVALID', `animations[${id}] frame durationMs must be null or 1..60000`);
              framesValid = false;
              break;
            }
          }
          frames.push(Object.freeze({ file: frame.file, durationMs: frame.durationMs === undefined ? null : frame.durationMs }));
        }
        if (!framesValid) continue;
        const meta = Object.freeze({
          id,
          state: animation.state,
          direction: animation.direction,
          loop: animation.loop,
          frameDurationMs: animation.frameDurationMs === undefined ? null : animation.frameDurationMs,
          frames: Object.freeze(frames),
        });
        byId.set(id, meta);
        if (!byState.has(meta.state)) byState.set(meta.state, []);
        byState.get(meta.state).push(meta);
      }
    }
  }

  // ---- capability requirements -------------------------------------------
  const states = new Set(byState.keys());
  for (const state of REQUIRED_STATES) {
    if (!states.has(state)) fail('PACK_ASSET_MISSING', `required state missing: ${state}`);
  }
  for (const direction of REQUIRED_WALK_DIRECTIONS) {
    if (!states.has('walk') || !byId.has(`walk-${direction}`)) {
      fail('PACK_ASSET_MISSING', `required walk direction missing: ${direction}`);
    }
  }
  const missingCapabilities = OPTIONAL_STATES.filter((state) => !states.has(state));

  if (errors.length > 0) {
    const first = errors[0];
    return { ok: false, code: first.code, errors: Object.freeze(errors.map((error) => Object.freeze({ ...error }))) };
  }

  const packGeometry = Object.freeze({
    sourceCanvas: Object.freeze({ ...anchors.sourceCanvas }),
    outputCanvas: Object.freeze({ ...anchors.outputCanvas }),
    outputScale: anchors.outputScale,
    anchor: Object.freeze({ ...anchors.anchor }),
    visibleBounds: Object.freeze({ ...anchors.visibleBounds }),
  });
  const anchorFrames = anchors.frames && typeof anchors.frames === 'object' ? anchors.frames : {};

  function findStatic(state) {
    const candidates = byState.get(state);
    if (!candidates) return null;
    for (const meta of candidates) {
      if (meta.direction === 'none') return meta.id;
    }
    return null;
  }

  function findDedicated(state, direction) {
    if (state === 'walk') {
      if (direction === null || !WALK_DIRECTIONS.includes(direction)) return null;
      return byId.has(`walk-${direction}`) ? `walk-${direction}` : null;
    }
    if (state === 'side') {
      const preference = SIDE_PREFERENCE[direction || 'none'] || SIDE_PREFERENCE.none;
      for (const id of preference) {
        if (byId.has(id)) return id;
      }
      return null;
    }
    const candidates = byState.get(state);
    if (!candidates || candidates.length === 0) return null;
    if (byId.has(state)) return state;
    return candidates[0].id;
  }

  function resolved(meta, extras) {
    return Object.freeze({
      code: 'RESOLVED',
      resource: meta.id,
      animationId: meta.id,
      state: meta.state,
      direction: meta.direction,
      frameCount: meta.frames.length,
      loop: meta.loop,
      emphasis: null,
      fallbackReason: null,
      capabilityMissing: Object.freeze([]),
      missingCapabilities: Object.freeze(missingCapabilities.slice()),
      frameDurations: Object.freeze(meta.frames.map((frame) => frame.durationMs)),
      ...extras,
    });
  }

  function capabilityMissingResult(state, code, reason) {
    return Object.freeze({
      code,
      resource: null,
      animationId: null,
      state,
      direction: 'none',
      frameCount: 0,
      loop: false,
      emphasis: null,
      fallbackReason: reason,
      capabilityMissing: Object.freeze([state]),
      missingCapabilities: Object.freeze(missingCapabilities.slice()),
    });
  }

  function resolve({ state, direction } = {}) {
    if (errors.length > 0) return diagnosticResult(errors[0].code, errors);
    if (typeof state !== 'string' || !state) {
      return capabilityMissingResult(state || null, 'ANIMATION_STATE_INVALID', 'ANIMATION_STATE_INVALID');
    }
    if (state === OFFLINE_STATE) {
      return capabilityMissingResult(state, 'ANIMATION_CAPABILITY_MISSING', 'OFFLINE_NOT_A_RESIDENT_STATE');
    }
    const normalizedDirection =
      state === 'walk'
        ? (direction !== undefined && direction !== null && WALK_DIRECTIONS.includes(direction) ? direction : null)
        : (direction !== undefined && direction !== null && DIRECTIONS.includes(direction) ? direction : 'none');
    const missing = Object.freeze(states.has(state) ? [] : [state]);

    // 1. dedicated animation
    const dedicatedId = findDedicated(state, normalizedDirection);
    if (dedicatedId) return resolved(byId.get(dedicatedId), {});

    // 2. compatible static pose
    if (allowStaticPose) {
      const chain = STATE_FALLBACK_CHAINS[state] || ['idle'];
      for (const candidate of chain) {
        if (candidate === 'walk' || candidate === 'side') continue;
        const staticId = findStatic(candidate);
        if (staticId) {
          return resolved(byId.get(staticId), { fallbackReason: 'STATIC_POSE_FALLBACK', capabilityMissing: missing });
        }
      }
    }

    // 3. compatible directional pose
    if (allowStaticPose) {
      const preference = SIDE_PREFERENCE[normalizedDirection || 'none'] || SIDE_PREFERENCE.none;
      for (const id of preference) {
        const meta = byId.get(id);
        if (meta && meta.state === 'side') {
          return resolved(meta, { fallbackReason: 'DIRECTIONAL_POSE_FALLBACK', capabilityMissing: missing });
        }
      }
    }

    // 4. declared programmatic emphasis
    if (allowProgrammaticEmphasis && EMPHASIS_EFFECTS[state]) {
      const baseId = findStatic('idle') || findStatic('working') || null;
      return Object.freeze({
        code: 'RESOLVED',
        resource: null,
        animationId: null,
        baseResource: baseId,
        state,
        direction: normalizedDirection || 'none',
        frameCount: 1,
        loop: false,
        emphasis: EMPHASIS_EFFECTS[state],
        fallbackReason: 'PROGRAMMATIC_EMPHASIS_FALLBACK',
        capabilityMissing: missing,
        missingCapabilities: Object.freeze(missingCapabilities.slice()),
        frameDurations: Object.freeze([null]),
      });
    }

    return capabilityMissingResult(state, 'ANIMATION_CAPABILITY_MISSING', 'ANIMATION_CAPABILITY_MISSING');
  }

  function animation(id) {
    return byId.get(id) || null;
  }

  function frameGeometry(animationId, frameIndex) {
    const meta = byId.get(animationId);
    if (!meta) return Object.freeze({ code: 'ANIMATION_NOT_FOUND' });
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= meta.frames.length) {
      return Object.freeze({ code: 'FRAME_INDEX_OUT_OF_RANGE' });
    }
    const file = meta.frames[frameIndex].file;
    const entry = anchorFrames[file] || null;
    return Object.freeze({
      file,
      sourceCanvas: entry && entry.sourceCanvas ? Object.freeze({ ...entry.sourceCanvas }) : packGeometry.sourceCanvas,
      outputCanvas: packGeometry.outputCanvas,
      outputScale: packGeometry.outputScale,
      sourceAnchor: entry && entry.sourceAnchor ? Object.freeze({ ...entry.sourceAnchor }) : null,
      outputAnchor: entry && entry.outputAnchor ? Object.freeze({ ...entry.outputAnchor }) : packGeometry.anchor,
      visibleBounds: entry && entry.visibleBounds ? Object.freeze({ ...entry.visibleBounds }) : packGeometry.visibleBounds,
    });
  }

  const pack = {
    id: manifest.id,
    manifest: Object.freeze({ ...manifest }),
    geometry: packGeometry,
    defaultFrameDurationMs,
    resolve: Object.freeze(resolve),
    animation: Object.freeze(animation),
    frameGeometry: Object.freeze(frameGeometry),
    missingCapabilities: Object.freeze(() => missingCapabilities.slice()),
  };
  return { ok: true, code: 'OK', pack: Object.freeze(pack) };
}

module.exports = {
  createAssetPack,
  computeVisibleHeight,
  computeSpriteScale,
  VISIBLE_HEIGHT,
  FALLBACK_FRAME_DURATION_MS,
};
