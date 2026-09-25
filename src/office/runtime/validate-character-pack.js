'use strict';

// src/office/runtime/validate-character-pack.js — Task 2 / SPEC-02.
// Declarative, dependency-free character pack validator. It never executes
// pack content and never writes into the pack: validation-report.json is
// produced by the normalizer and treated as immutable diagnostic input.
//
// Pixel-level geometry (alpha thresholds, foot candidates) is measured by
// the workbench-side normalize-character.py with Pillow; this validator
// checks schema, paths, license, declared geometry consistency, PNG header
// sanity, size limits and pack safety with stable error codes.
//
// CLI: node src/office/runtime/validate-character-pack.js <packPath>
//
// P5 (2026-09-23) internalization: the character pack installer is PRODUCT
// code (src/office/runtime/character-pack-installer.js), so the validator it
// requires must live inside src/** — the packaged asar only ships src/**.
// It used to live at scripts/office-assets/ (the dev-only asset pipeline) and
// the require edge src/** -> scripts/** would have pointed at a file that does
// not exist in the artifact. Moved here; the assertions in
// test/office-packaging-boundary.test.js pin both facts.
//
//   prints one JSON object; exit 0 = valid, 4 = invalid, 3 = usage/internal.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'id',
  'version',
  'author',
  'license',
  'runtimeCompatibility',
  'geometry',
  'animations',
  'fallback',
]);
const GEOMETRY_TOP_FIELDS = Object.freeze([
  'schemaVersion',
  'sourceCanvas',
  'outputCanvas',
  'outputScale',
  'anchor',
  'visibleBounds',
  'frames',
]);
const GEOMETRY_FRAME_FIELDS = Object.freeze([
  'file',
  'sourceAnchor',
  'outputAnchor',
  'visibleBounds',
  'sourceCanvas',
  'sourceScale',
  'detection',
]);
const ANIMATIONS_TOP_FIELDS = Object.freeze(['schemaVersion', 'defaultFrameDurationMs', 'animations']);
const ANIMATION_FIELDS = Object.freeze(['state', 'direction', 'loop', 'frames']);
const ANIMATION_FRAME_FIELDS = Object.freeze(['file', 'durationMs', 'anchor', 'visibleBounds']);
const DIRECTIONS = Object.freeze(['none', 'left', 'right', 'up', 'down']);
const WALK_DIRECTIONS = Object.freeze(['left', 'right', 'up', 'down']);
const REQUIRED_STATES = Object.freeze(['idle']);
const REQUIRED_WALK_DIRECTIONS = WALK_DIRECTIONS;
const OPTIONAL_STATES = Object.freeze([
  'working', 'finished', 'warning', 'error', 'offline', 'sleeping', 'completed',
  'failed', 'attention', 'thinking', 'waiting', 'celebrating', 'chatting', 'side',
]);
const DEFAULT_FRAME_DURATION_MS = 1000;
const MAX_CANVAS_DIM = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_COUNT = 512;
const ALLOWED_EXTENSIONS = Object.freeze(['.png', '.json']);
const ROOT_ALLOWED_FILES = Object.freeze(['LICENSE', 'NOTICE']);
const ANCHOR_TOLERANCE_PX = 1;
const BANNED_GEOMETRY_KEYS = Object.freeze(['trim', 'rotate', 'spriteSourceSize', 'sourceSize']);
// packId/version become filesystem path segments after installation; restrict
// them to safe single components (also accepts semver-like versions).
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIntInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function pointInBounds(point, bounds) {
  return point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height;
}

function boundsInCanvas(bounds, canvas) {
  return (
    isIntInRange(bounds.x, 0, canvas.width - 1) &&
    isIntInRange(bounds.y, 0, canvas.height - 1) &&
    isIntInRange(bounds.width, 1, canvas.width) &&
    isIntInRange(bounds.height, 1, canvas.height) &&
    bounds.x + bounds.width <= canvas.width &&
    bounds.y + bounds.height <= canvas.height
  );
}

function samePoint(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

function sameBounds(a, b) {
  return (
    !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function validateRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 256) return 'invalid path';
  if (rel.includes('\0')) return 'NUL byte in path';
  if (rel.includes('\\')) return 'backslash in path';
  if (rel.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(rel)) return 'drive-absolute path';
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return 'traversal or empty segment';
  return null;
}

function listPackFiles(packPath) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, relPath);
      else if (entry.isFile()) out.push({ rel: relPath, abs, size: fs.statSync(abs).size });
      else out.push({ rel: relPath, abs, size: 0, special: true });
    }
  };
  walk(packPath, '');
  return out;
}

// Parses just enough of a PNG to verify the signature and IHDR dimensions.
function readPngHeader(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(33);
    const read = fs.readSync(fd, head, 0, 33, 0);
    if (read < 33) return { error: 'file too short for a PNG' };
    const signature = head.subarray(0, 8);
    const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!signature.equals(expected)) return { error: 'not a PNG file' };
    if (head.readUInt32BE(8) !== 13 || head.toString('ascii', 12, 16) !== 'IHDR') {
      return { error: 'first chunk is not IHDR' };
    }
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    const bitDepth = head[24];
    const colorType = head[25];
    return { width, height, bitDepth, colorType };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateCharacterPack(packPath, options) {
  const opts = options || {};
  const maxCanvasDim = opts.maxCanvasDim || MAX_CANVAS_DIM;
  const maxFileBytes = opts.maxFileBytes || MAX_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes || MAX_TOTAL_BYTES;
  const maxFileCount = opts.maxFileCount || MAX_FILE_COUNT;

  const errors = [];
  const warnings = [];
  const capabilitiesMissing = [];
  const fail = (code, message) => errors.push({ code, message });

  let files;
  try {
    files = listPackFiles(packPath);
  } catch (error) {
    return {
      ok: false,
      result: 'invalid',
      errors: [{ code: 'PACK_LOAD_FAILED', message: `cannot read pack directory: ${error.message}` }],
      warnings,
      capabilitiesMissing,
    };
  }

  // ---- pack safety -------------------------------------------------------
  if (files.length > maxFileCount) {
    fail('PACK_UNSAFE_ARCHIVE', `pack contains ${files.length} files (limit ${maxFileCount})`);
  }
  let totalBytes = 0;
  const fileMap = new Map();
  for (const file of files) {
    if (file.special) {
      fail('PACK_UNSAFE_ARCHIVE', `non-regular file in pack: ${file.rel}`);
      continue;
    }
    const pathError = validateRelativePath(file.rel);
    if (pathError) {
      fail('PACK_UNSAFE_ARCHIVE', `${file.rel}: ${pathError}`);
      continue;
    }
    const ext = path.extname(file.rel).toLowerCase();
    const isRootMeta = ROOT_ALLOWED_FILES.includes(file.rel);
    if (!isRootMeta && !ALLOWED_EXTENSIONS.includes(ext)) {
      fail('PACK_UNSAFE_ARCHIVE', `disallowed file type in pack: ${file.rel}`);
      continue;
    }
    if (file.size > maxFileBytes) {
      fail('PACK_ASSET_TOO_LARGE', `${file.rel} is ${file.size} bytes (limit ${maxFileBytes})`);
    }
    totalBytes += file.size;
    fileMap.set(file.rel, file);
  }
  if (totalBytes > maxTotalBytes) {
    fail('PACK_ASSET_TOO_LARGE', `pack total size ${totalBytes} bytes (limit ${maxTotalBytes})`);
  }

  // ---- required files ----------------------------------------------------
  for (const required of ['manifest.json', 'LICENSE', 'NOTICE']) {
    if (!fileMap.has(required)) fail('PACK_MANIFEST_INVALID', `missing required file: ${required}`);
  }
  if (errors.some((e) => e.code === 'PACK_MANIFEST_INVALID' || e.code === 'PACK_UNSAFE_ARCHIVE')) {
    return { ok: false, result: 'invalid', errors, warnings, capabilitiesMissing };
  }

  const readJson = (rel, code) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(packPath, rel), 'utf8'));
    } catch (error) {
      fail(code, `${rel}: invalid JSON (${error.message})`);
      return null;
    }
  };

  // ---- manifest ----------------------------------------------------------
  const manifest = readJson('manifest.json', 'PACK_MANIFEST_INVALID');
  if (manifest) {
    const keys = Object.keys(manifest).sort();
    const expected = [...MANIFEST_FIELDS].sort();
    const unknown = keys.filter((k) => !expected.includes(k));
    const missing = expected.filter((k) => !keys.includes(k));
    const geometryInline = keys.filter((k) =>
      ['anchor', 'visibleBounds', 'canvas', 'sourceCanvas', 'outputCanvas', 'outputScale', 'frames'].includes(k)
    );
    if (unknown.length) fail('PACK_MANIFEST_INVALID', `unknown manifest fields: ${unknown.join(', ')}`);
    if (missing.length) fail('PACK_MANIFEST_INVALID', `missing manifest fields: ${missing.join(', ')}`);
    if (geometryInline.length) {
      fail('PACK_MANIFEST_INVALID', `geometry fields must live in ${manifest.geometry || 'animation/anchors.json'}, not inline: ${geometryInline.join(', ')}`);
    }
    if (manifest.schemaVersion !== SCHEMA_VERSION) {
      fail('PACK_MANIFEST_INVALID', `schemaVersion must be ${SCHEMA_VERSION}`);
    }
    for (const field of ['author', 'license']) {
      if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
        fail('PACK_MANIFEST_INVALID', `manifest.${field} must be a non-empty string`);
      }
    }
    for (const field of ['id', 'version']) {
      if (typeof manifest[field] !== 'string' || !IDENTITY_PATTERN.test(manifest[field])) {
        fail(
          'PACK_MANIFEST_INVALID',
          `manifest.${field} must match ${IDENTITY_PATTERN.source} (safe single path component; no separators, traversal, drive prefixes or NUL)`
        );
      }
    }
    if (isPlainObject(manifest.runtimeCompatibility) && manifest.runtimeCompatibility.schema !== SCHEMA_VERSION) {
      fail('PACK_MANIFEST_INVALID', 'runtimeCompatibility.schema must be 1');
    }
    if (manifest.geometry !== 'animation/anchors.json') {
      fail('PACK_MANIFEST_INVALID', 'manifest.geometry must point to animation/anchors.json');
    }
    if (manifest.animations !== 'animation/animations.json') {
      fail('PACK_MANIFEST_INVALID', 'manifest.animations must point to animation/animations.json');
    }
    if (isPlainObject(manifest.fallback)) {
      for (const key of Object.keys(manifest.fallback)) {
        if (!['allowStaticPose', 'allowProgrammaticEmphasis'].includes(key) || typeof manifest.fallback[key] !== 'boolean') {
          fail('PACK_MANIFEST_INVALID', `manifest.fallback.${key} is not an allowed fallback flag`);
        }
      }
    }
  }

  // ---- anchors.json (sole geometry authority) -----------------------------
  const anchors = readJson('animation/anchors.json', 'PACK_GEOMETRY_INVALID');
  let anchorFrames = null;
  if (anchors) {
    const unknownTop = Object.keys(anchors).filter((k) => !GEOMETRY_TOP_FIELDS.includes(k));
    const banned = Object.keys(anchors).filter((k) => BANNED_GEOMETRY_KEYS.includes(k));
    if (banned.length) fail('PACK_GEOMETRY_INVALID', `atlas trim/rotate metadata is forbidden in v1: ${banned.join(', ')}`);
    if (unknownTop.length) fail('PACK_GEOMETRY_INVALID', `unknown anchors.json fields: ${unknownTop.join(', ')}`);
    if (anchors.schemaVersion !== SCHEMA_VERSION) fail('PACK_GEOMETRY_INVALID', `anchors.schemaVersion must be ${SCHEMA_VERSION}`);
    const sc = anchors.sourceCanvas;
    const oc = anchors.outputCanvas;
    if (!isPlainObject(sc) || !isIntInRange(sc.width, 1, maxCanvasDim) || !isIntInRange(sc.height, 1, maxCanvasDim)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.sourceCanvas dimensions out of range');
    }
    if (!isPlainObject(oc) || !isIntInRange(oc.width, 1, maxCanvasDim) || !isIntInRange(oc.height, 1, maxCanvasDim)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.outputCanvas dimensions out of range');
    }
    if (isPlainObject(sc) && isPlainObject(oc) && Number.isFinite(anchors.outputScale)) {
      const expectedScale = oc.width / sc.width;
      if (Math.abs(anchors.outputScale - expectedScale) > 1e-9) {
        fail('PACK_GEOMETRY_INVALID', `anchors.outputScale ${anchors.outputScale} does not equal outputCanvas.width/sourceCanvas.width (${expectedScale})`);
      }
    } else if (!Number.isFinite(anchors.outputScale)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.outputScale must be a number');
    }
    const packAnchor = anchors.anchor;
    if (!isPlainObject(packAnchor) || !isIntInRange(packAnchor.x, 0, (oc ? oc.width : maxCanvasDim) - 1) || !isIntInRange(packAnchor.y, 0, (oc ? oc.height : maxCanvasDim) - 1)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.anchor must be a point inside the output canvas');
    }
    if (!isPlainObject(anchors.visibleBounds) || (isPlainObject(oc) && !boundsInCanvas(anchors.visibleBounds, oc))) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.visibleBounds must sit inside the output canvas');
    }
    anchorFrames = anchors.frames;
    if (!isPlainObject(anchorFrames)) {
      fail('PACK_GEOMETRY_INVALID', 'anchors.frames must be an object');
      anchorFrames = null;
    } else {
      for (const [file, entry] of Object.entries(anchorFrames)) {
        const pathError = validateRelativePath(file);
        if (pathError) {
          fail('PACK_GEOMETRY_INVALID', `anchors.frames key ${file}: ${pathError}`);
          continue;
        }
        if (!isPlainObject(entry)) {
          fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}] must be an object`);
          continue;
        }
        if (entry.file !== undefined && entry.file !== file) {
          const entryPathError = validateRelativePath(entry.file);
          if (entryPathError) fail('PACK_UNSAFE_ARCHIVE', `anchors.frames[${file}].file: ${entryPathError}`);
          else fail('PACK_GEOMETRY_CONFLICT', `anchors.frames[${file}].file does not match its key`);
        }
        const unknownFrame = Object.keys(entry).filter((k) => !GEOMETRY_FRAME_FIELDS.includes(k));
        const frameBanned = Object.keys(entry).filter((k) => BANNED_GEOMETRY_KEYS.includes(k));
        if (frameBanned.length) fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}] carries forbidden atlas metadata: ${frameBanned.join(', ')}`);
        if (unknownFrame.length) fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}] unknown fields: ${unknownFrame.join(', ')}`);
        if (!fileMap.has(file)) fail('PACK_ASSET_MISSING', `anchors.frames references missing file: ${file}`);
        else if (file.endsWith('.png')) {
          const header = readPngHeader(path.join(packPath, file));
          if (header.error) fail('PACK_GEOMETRY_INVALID', `${file}: ${header.error}`);
          else if (isPlainObject(oc) && (header.width !== oc.width || header.height !== oc.height)) {
            fail('PACK_GEOMETRY_INVALID', `${file} is ${header.width}x${header.height} but anchors.outputCanvas is ${oc.width}x${oc.height}`);
          } else if (header.colorType !== 6) {
            fail('PACK_GEOMETRY_INVALID', `${file} must be RGBA PNG (colorType 6), got ${header.colorType}`);
          }
        }
        if (isPlainObject(entry) && isPlainObject(oc)) {
          const outAnchor = entry.outputAnchor;
          if (!isPlainObject(outAnchor) || !isIntInRange(outAnchor.x, 0, oc.width - 1) || !isIntInRange(outAnchor.y, 0, oc.height - 1)) {
            fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}].outputAnchor must sit inside the output canvas`);
          }
          if (!isPlainObject(entry.visibleBounds) || !boundsInCanvas(entry.visibleBounds, oc)) {
            fail('PACK_GEOMETRY_INVALID', `anchors.frames[${file}].visibleBounds must sit inside the output canvas`);
          }
        }
      }
    }
  }

  // ---- animations.json (sole frame order/timing authority) ----------------
  const animationsDoc = readJson('animation/animations.json', 'PACK_MANIFEST_INVALID');
  const referencedFiles = new Set();
  if (animationsDoc) {
    const unknownTop = Object.keys(animationsDoc).filter((k) => !ANIMATIONS_TOP_FIELDS.includes(k));
    const banned = Object.keys(animationsDoc).filter((k) => BANNED_GEOMETRY_KEYS.includes(k));
    if (banned.length) fail('PACK_GEOMETRY_INVALID', `atlas trim/rotate metadata is forbidden in v1: ${banned.join(', ')}`);
    if (unknownTop.length) fail('PACK_MANIFEST_INVALID', `unknown animations.json fields: ${unknownTop.join(', ')}`);
    if (animationsDoc.schemaVersion !== SCHEMA_VERSION) fail('PACK_MANIFEST_INVALID', `animations.schemaVersion must be ${SCHEMA_VERSION}`);
    if (animationsDoc.defaultFrameDurationMs !== DEFAULT_FRAME_DURATION_MS) {
      fail('PACK_MANIFEST_INVALID', `animations.defaultFrameDurationMs must be ${DEFAULT_FRAME_DURATION_MS}`);
    }
    const animations = animationsDoc.animations;
    if (!isPlainObject(animations)) fail('PACK_MANIFEST_INVALID', 'animations.animations must be an object');
    else {
      const statesSeen = new Set();
      const walkDirectionsSeen = new Set();
      for (const [name, animation] of Object.entries(animations)) {
        if (!isPlainObject(animation)) {
          fail('PACK_MANIFEST_INVALID', `animations[${name}] must be an object`);
          continue;
        }
        const unknownAnim = Object.keys(animation).filter((k) => !ANIMATION_FIELDS.includes(k));
        if (unknownAnim.length) fail('PACK_MANIFEST_INVALID', `animations[${name}] unknown fields: ${unknownAnim.join(', ')}`);
        if (typeof animation.state !== 'string' || !animation.state) fail('PACK_MANIFEST_INVALID', `animations[${name}].state required`);
        else statesSeen.add(animation.state);
        if (!DIRECTIONS.includes(animation.direction)) fail('PACK_MANIFEST_INVALID', `animations[${name}].direction must be one of ${DIRECTIONS.join('|')}`);
        if (typeof animation.loop !== 'boolean') fail('PACK_MANIFEST_INVALID', `animations[${name}].loop must be boolean`);
        if (!Array.isArray(animation.frames) || animation.frames.length === 0) {
          fail('PACK_MANIFEST_INVALID', `animations[${name}].frames must be a non-empty array`);
          continue;
        }
        const resolvedAnchors = [];
        for (const frame of animation.frames) {
          if (!isPlainObject(frame)) {
            fail('PACK_MANIFEST_INVALID', `animations[${name}] frames must be objects`);
            continue;
          }
          const unknownFrame = Object.keys(frame).filter((k) => !ANIMATION_FRAME_FIELDS.includes(k));
          if (unknownFrame.length) fail('PACK_MANIFEST_INVALID', `animations[${name}] frame unknown fields: ${unknownFrame.join(', ')}`);
          const file = frame.file;
          const pathError = validateRelativePath(file || '');
          if (pathError) {
            fail('PACK_UNSAFE_ARCHIVE', `animations[${name}] frame path: ${file}: ${pathError}`);
            continue;
          }
          referencedFiles.add(file);
          if (!fileMap.has(file)) {
            fail('PACK_ASSET_MISSING', `animations[${name}] references missing file: ${file}`);
          } else if (file.endsWith('.png')) {
            const header = readPngHeader(path.join(packPath, file));
            if (header.error) fail('PACK_GEOMETRY_INVALID', `${file}: ${header.error}`);
            else if (header.colorType !== 6) fail('PACK_GEOMETRY_INVALID', `${file} must be RGBA PNG`);
          }
          if (frame.durationMs !== null && frame.durationMs !== undefined) {
            if (!isIntInRange(frame.durationMs, 1, 60000)) {
              fail('PACK_MANIFEST_INVALID', `animations[${name}] frame durationMs must be null or 1..60000`);
            }
          }
          // geometry consistency with anchors.json (sole authority)
          const declared = anchorFrames && anchorFrames[file];
          const resolvedAnchor = frame.anchor || (declared && declared.outputAnchor) || (anchors && anchors.anchor);
          const resolvedBounds = frame.visibleBounds || (declared && declared.visibleBounds) || (anchors && anchors.visibleBounds);
          if (frame.anchor) {
            const expected = declared && declared.outputAnchor ? declared.outputAnchor : anchors && anchors.anchor;
            if (!samePoint(frame.anchor, expected)) {
              fail('PACK_GEOMETRY_CONFLICT', `animations[${name}] frame ${file} anchor conflicts with anchors.json (sole geometry authority)`);
            }
          }
          if (frame.visibleBounds) {
            const expectedBounds = declared && declared.visibleBounds ? declared.visibleBounds : anchors && anchors.visibleBounds;
            if (!sameBounds(frame.visibleBounds, expectedBounds)) {
              fail('PACK_GEOMETRY_CONFLICT', `animations[${name}] frame ${file} visibleBounds conflict with anchors.json`);
            }
          }
          if (resolvedAnchor) resolvedAnchors.push(resolvedAnchor);
        }
        if (animation.state === 'walk' && WALK_DIRECTIONS.includes(animation.direction)) {
          walkDirectionsSeen.add(animation.direction);
        }
        if (animation.state === 'walk' && WALK_DIRECTIONS.includes(animation.direction) && resolvedAnchors.length >= 2) {
          let maxX = 0;
          let maxY = 0;
          for (const a of resolvedAnchors) {
            for (const b of resolvedAnchors) {
              maxX = Math.max(maxX, Math.abs(a.x - b.x));
              maxY = Math.max(maxY, Math.abs(a.y - b.y));
            }
          }
          if (maxX > ANCHOR_TOLERANCE_PX || maxY > ANCHOR_TOLERANCE_PX) {
            fail('PACK_GEOMETRY_INVALID', `walk-${animation.direction} foot anchors drift ${maxX}px/${maxY}px (tolerance ±${ANCHOR_TOLERANCE_PX}px)`);
          }
        }
      }
      for (const state of REQUIRED_STATES) {
        if (!statesSeen.has(state)) fail('PACK_ASSET_MISSING', `required state missing: ${state}`);
      }
      for (const direction of REQUIRED_WALK_DIRECTIONS) {
        if (!walkDirectionsSeen.has(direction)) fail('PACK_ASSET_MISSING', `required walk direction missing: ${direction}`);
      }
      for (const state of OPTIONAL_STATES) {
        if (!statesSeen.has(state)) capabilitiesMissing.push(state);
      }
      if (capabilitiesMissing.length) {
        warnings.push(`ANIMATION_CAPABILITY_MISSING: ${capabilitiesMissing.join(', ')}`);
      }
    }
  }

  // ---- manifest-external assets -------------------------------------------
  const allowedFiles = new Set(['manifest.json', 'LICENSE', 'NOTICE', 'animation/anchors.json', 'animation/animations.json']);
  for (const rel of fileMap.keys()) {
    if (allowedFiles.has(rel)) continue;
    if (referencedFiles.has(rel)) continue;
    if (anchorFrames && anchorFrames[rel]) continue;
    if (rel.startsWith('assets/')) {
      const headerOk = rel.endsWith('.png');
      if (!headerOk) continue; // non-png under assets already flagged as unsafe
      fail('PACK_UNSAFE_ARCHIVE', `manifest-external file not referenced by pack metadata: ${rel}`);
    }
  }

  const result = errors.length ? 'invalid' : 'passed';
  return { ok: errors.length === 0, result, errors, warnings, capabilitiesMissing };
}

module.exports = { validateCharacterPack, DEFAULT_FRAME_DURATION_MS, ANCHOR_TOLERANCE_PX };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.log(JSON.stringify({ ok: false, result: 'invalid', errors: [{ code: 'PACK_LOAD_FAILED', message: 'usage: validate-character-pack.js <packPath>' }] }));
    process.exit(3);
  }
  let outcome;
  try {
    outcome = validateCharacterPack(target);
  } catch (error) {
    outcome = { ok: false, result: 'invalid', errors: [{ code: 'PACK_LOAD_FAILED', message: String(error && error.message) }] };
  }
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.ok ? 0 : 4);
}
