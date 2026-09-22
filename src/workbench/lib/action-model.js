'use strict';

// src/workbench/lib/action-model.js — the M1 action editor's pure model.
//
// Reads/writes the §6.2 action document (content/characters/whale-girl/
// actions/<id>.json) and owns every timeline operation: frame reorder
// (array order IS the play order — file names never participate, see the
// E5a-R1 lock), insert/remove, duration edits (null or 50–5000ms), loop
// toggle. Pure CommonJS: no DOM, no Electron, no clock; files enter only
// through injectable measure/resolve callbacks (saveActionDoc is the one
// deliberate fs helper for the editor's autosave).
//
// Invariants enforced here:
// - every op reports { changed } — "无变更不记录": no-change ops are no-ops
//   the session layer must not persist;
// - durations are null (inherit the pack default) or integers 50..5000;
// - validateActionForPublish produces the fail-closed publish rows (鞋线 ±1px
//   against geometry.footLine, 可见高 ±2px against the same-action median).

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DIRECTIONS = Object.freeze(['none', 'left', 'right', 'up', 'down']);
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 5000;
// The pack-wide default the runtime's animation-controller falls back to
// (character.defaults.frameDurationMs; frozen at 1000ms/frame).
const DEFAULT_FRAME_DURATION_MS = 1000;
const FOOT_TOLERANCE_PX = 1;
const HEIGHT_TOLERANCE_PX = 2;

class ActionModelError extends Error {
  constructor(code, message) {
    // The stable code travels IN the message so `assert.throws(fn, /CODE/)`
    // (and any log grep) can match it from the string representation alone.
    super(message ? `${code}: ${message}` : code);
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

// ---- document parsing / serialization --------------------------------------

// parseActionDoc(text | object) -> { ok, action } | { ok: false, code, message }
function parseActionDoc(input) {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      return { ok: false, code: 'ACTION_JSON_UNPARSEABLE', message: error.message };
    }
  }
  if (!isPlainObject(value)) return { ok: false, code: 'ACTION_SCHEMA_INVALID', message: 'action document must be an object' };
  if (value.schemaVersion !== SCHEMA_VERSION) return { ok: false, code: 'ACTION_SCHEMA_INVALID', message: `schemaVersion must be ${SCHEMA_VERSION}` };
  if (typeof value.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) {
    return { ok: false, code: 'ACTION_ID_INVALID', message: 'id must be a safe kebab-case component' };
  }
  if (typeof value.loop !== 'boolean') return { ok: false, code: 'ACTION_SCHEMA_INVALID', message: 'loop must be boolean' };
  if (!DIRECTIONS.includes(value.direction)) return { ok: false, code: 'ACTION_DIRECTION_INVALID', message: `direction must be one of ${DIRECTIONS.join('|')}` };
  if (!Array.isArray(value.frames)) return { ok: false, code: 'ACTION_SCHEMA_INVALID', message: 'frames must be an array' };
  if (!isPlainObject(value.geometry) || !Number.isInteger(value.geometry.footLine)) {
    return { ok: false, code: 'ACTION_SCHEMA_INVALID', message: 'geometry.footLine must be an integer' };
  }
  return { ok: true, action: value };
}

// saveActionDoc(absPath, action) — the editor's autosave: canonical sorted
// keys, indent 2, trailing newline (same shape the pack files use).
function saveActionDoc(absPath, action) {
  const probe = parseActionDoc(action);
  if (!probe.ok) throw new ActionModelError(probe.code, probe.message);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(action, null, 2)}\n`);
  return absPath;
}

function cloneAction(action) {
  return JSON.parse(JSON.stringify(action));
}

// ---- timeline operations (mutate the given action, report `changed`) -------
//
// The caller owns the document (the launcher's editing session). Each op
// returns { changed, action }; a no-op reports changed=false and leaves the
// frames untouched so the session layer can honour "无变更不记录".

function moveFrame(action, from, to) {
  const length = action.frames.length;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= length || to >= length || from === to) {
    return { changed: false, action };
  }
  const [entry] = action.frames.splice(from, 1);
  action.frames.splice(to, 0, entry);
  return { changed: true, action };
}

function insertFrame(action, index, file, durationMs = null) {
  const probe = checkedFrame(file, durationMs);
  if (!probe.ok) throw new ActionModelError(probe.code, probe.message);
  const at = Number.isInteger(index) ? Math.max(0, Math.min(action.frames.length, index)) : action.frames.length;
  action.frames.splice(at, 0, { file: probe.file, durationMs: probe.durationMs });
  return { changed: true, action, index: at };
}

function removeFrame(action, index) {
  if (!Number.isInteger(index) || index < 0 || index >= action.frames.length) {
    return { changed: false, action, removed: null };
  }
  const [removed] = action.frames.splice(index, 1);
  return { changed: true, action, removed };
}

function checkedFrame(file, durationMs) {
  if (!isSafeRelativePath(file)) return { ok: false, code: 'FRAME_FILE_UNSAFE', message: `unsafe frame path: ${JSON.stringify(file)}` };
  const duration = checkedDuration(durationMs);
  if (!duration.ok) return duration;
  return { ok: true, file, durationMs: duration.value };
}

function checkedDuration(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_FRAME_MS || value > MAX_FRAME_MS) {
    return { ok: false, code: 'FRAME_DURATION_INVALID', message: `durationMs must be null or an integer ${MIN_FRAME_MS}..${MAX_FRAME_MS} (got ${String(value)})` };
  }
  return { ok: true, value };
}

function setFrameDuration(action, index, value) {
  if (!Number.isInteger(index) || index < 0 || index >= action.frames.length) {
    return { changed: false, action };
  }
  const duration = checkedDuration(value);
  if (!duration.ok) throw new ActionModelError(duration.code, duration.message);
  const normalized = duration.value;
  if (action.frames[index].durationMs === normalized) return { changed: false, action };
  action.frames[index].durationMs = normalized;
  return { changed: true, action };
}

function setLoop(action, value) {
  if (typeof value !== 'boolean') throw new ActionModelError('LOOP_INVALID', 'loop must be boolean');
  if (action.loop === value) return { changed: false, action };
  action.loop = value;
  return { changed: true, action };
}

// ---- timing (mirrors src/office/runtime/animation-controller.js) -----------
//
// Duration precedence per frame: frame.durationMs > the character default
// (1000ms). Frame boundaries belong to the NEXT frame; non-loop playback
// clamps to the last frame.

function frameIndexAt(frames, elapsedMs, loop, defaultMs = DEFAULT_FRAME_DURATION_MS) {
  const durations = frames.map((frame) => (frame.durationMs !== null && frame.durationMs !== undefined ? frame.durationMs : defaultMs));
  let remaining = elapsedMs;
  if (loop) {
    const total = durations.reduce((sum, duration) => sum + duration, 0);
    remaining = total > 0 ? elapsedMs % total : 0;
  }
  for (let index = 0; index < durations.length; index += 1) {
    if (remaining < durations[index]) return { frameIndex: index, frameElapsedMs: remaining };
    remaining -= durations[index];
  }
  const last = durations.length - 1;
  return { frameIndex: last, frameElapsedMs: durations[last] };
}

// ---- validation -------------------------------------------------------------

function check(name, ok, detail) {
  return { check: name, ok: Boolean(ok), detail: detail === undefined ? null : detail };
}

// validateActionForPublish(action, { resolveFramePath, measureFrame }) ->
// { ok, checks: [{check, ok, detail}], rows: [per-frame geometry rows] }
//
// resolveFramePath(file) -> absolute path or null; measureFrame(absPath) ->
// { ok, footLine, visibleHeight, visibleWidth } (the shared character-geometry
// measurement: shoe line = lowest row with alpha>=128, bounds alpha>8).
function validateActionForPublish(action, { resolveFramePath, measureFrame }) {
  const checks = [];
  const rows = [];
  const schema = parseActionDoc(action);
  checks.push(check('schema', schema.ok, schema.ok ? null : schema.message));
  checks.push(check('frames.nonEmpty', Array.isArray(action.frames) && action.frames.length > 0, Array.isArray(action.frames) ? action.frames.length : 0));

  const measured = [];
  const resolveFailures = [];
  for (const frame of action.frames || []) {
    const safe = isSafeRelativePath(frame && frame.file);
    if (!safe) {
      resolveFailures.push(`${(frame && frame.file) || '(missing)'}: unsafe path`);
      measured.push({ ok: false, code: 'FRAME_FILE_UNSAFE' });
      continue;
    }
    const abs = resolveFramePath(frame.file);
    if (!abs) {
      resolveFailures.push(`${frame.file}: not found (content assets + pack)`);
      measured.push({ ok: false, code: 'FRAME_FILE_MISSING' });
      continue;
    }
    const m = measureFrame(abs);
    measured.push(m.ok ? m : { ok: false, code: m.code || 'MEASURE_FAILED' });
  }
  checks.push(check('frames.resolve', resolveFailures.length === 0, resolveFailures.length ? resolveFailures.slice(0, 4) : `${action.frames.length} files resolved`));

  const durationFailures = [];
  for (const [index, frame] of (action.frames || []).entries()) {
    const duration = checkedDuration(frame && frame.durationMs);
    if (!duration.ok) durationFailures.push(`#${index}: ${frame.durationMs}`);
  }
  checks.push(check('frames.durations', durationFailures.length === 0, durationFailures.length ? durationFailures.slice(0, 4) : 'null or 50..5000ms'));

  // geometry rows: shoe line ±1px against geometry.footLine, visible height
  // ±2px against the same-action median (the M0 tolerances).
  const okFrames = measured.filter((m) => m.ok && m.footLine !== null);
  const medianHeight = okFrames.length ? medianOf(okFrames.map((m) => m.visibleHeight)) : null;
  const footLine = isPlainObject(action.geometry) && Number.isInteger(action.geometry.footLine) ? action.geometry.footLine : null;
  for (const [index, m] of measured.entries()) {
    const file = (action.frames[index] || {}).file;
    if (!m.ok) {
      rows.push({ index, file, ok: m.ok, code: m.code, footLine: null, visibleHeight: null, visibleWidth: null, dFoot: null, dHeight: null, red: true });
      continue;
    }
    const dFoot = footLine !== null ? m.footLine - footLine : null;
    const dHeight = medianHeight !== null ? m.visibleHeight - medianHeight : null;
    const red = dFoot === null || dHeight === null || Math.abs(dFoot) > FOOT_TOLERANCE_PX || Math.abs(dHeight) > HEIGHT_TOLERANCE_PX;
    rows.push({
      index,
      file,
      ok: true,
      code: null,
      footLine: m.footLine,
      visibleHeight: m.visibleHeight,
      visibleWidth: m.visibleWidth,
      dFoot,
      dHeight,
      red,
    });
  }
  checks.push(check('geometry.footLineWithinTolerance', rows.every((row) => row.dFoot === null || Math.abs(row.dFoot) <= FOOT_TOLERANCE_PX), { footLine, tolerancePx: FOOT_TOLERANCE_PX }));
  checks.push(check('geometry.heightWithinTolerance', rows.every((row) => row.dHeight === null || Math.abs(row.dHeight) <= HEIGHT_TOLERANCE_PX), { medianHeight, tolerancePx: HEIGHT_TOLERANCE_PX }));
  checks.push(check('geometry.rowsGreen', rows.length > 0 && rows.every((row) => !row.red), { rows: rows.length, red: rows.filter((row) => row.red).length }));

  return { ok: checks.every((entry) => entry.ok) && rows.every((row) => !row.red), checks, rows };
}

function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// stateForAction(action) — the pack state an action publishes under: the four
// walk ids map to the shared 'walk' state; everything else publishes as its
// own optional state.
function stateForAction(action) {
  const match = /^walk-(left|right|up|down)$/.exec(action.id);
  return match ? 'walk' : action.id;
}

module.exports = {
  SCHEMA_VERSION,
  DIRECTIONS,
  MIN_FRAME_MS,
  MAX_FRAME_MS,
  DEFAULT_FRAME_DURATION_MS,
  FOOT_TOLERANCE_PX,
  HEIGHT_TOLERANCE_PX,
  ActionModelError,
  parseActionDoc,
  saveActionDoc,
  cloneAction,
  moveFrame,
  insertFrame,
  removeFrame,
  setFrameDuration,
  setLoop,
  frameIndexAt,
  validateActionForPublish,
  stateForAction,
  isSafeRelativePath,
};
