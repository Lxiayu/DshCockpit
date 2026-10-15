'use strict';

// studio/lib/actions/schema.js — action schema v2 (authoring) and the compile-down
// to the runtime's v1 pack entry.
//
// WHY TWO SHAPES: the production pack validator is STRICT — an animation entry
// carrying an unknown field fails with PACK_MANIFEST_INVALID (validate-character-pack.js
// ANIMATION_FIELDS). So the studio authors in v2 (tags, ping-pong, event frames,
// review notes) and compiles DOWN to exactly the runtime's shape on publish. The
// v1 fields keep their meaning byte-for-byte, which is what makes a v1 action
// publish identically to before this change (locked by studio/test/actions-v2.test.js).
//
// v2 additions (all optional; a v1 doc is a valid v2 doc):
//   pingPong  boolean  — playback mode: the studio's player and the review bench
//                        play forward then backward. NOT publishable: the runtime
//                        has no such field, and compiling it into a repeated frame
//                        list would break anchors.json (its frames map is keyed by
//                        file path, so a repeated file cannot be represented).
//                        Publishing a pingPong action therefore publishes the
//                        forward order and RECORDS the difference (see compileDown).
//   tags      string[] — free labels for the shelf / behaviour graphs ('walk',
//                        'front-facing', 'highlight', …). Kebab-case, deduped.
//   events    [{frame, name, data?}] — frame-anchored events (footstep, blink,
//                        prop-appear…). `frame` is the metadata INDEX (帧号锚定),
//                        never a filename.
//   notes     handled by ./notes.js (a sidecar file, so the action doc stays clean).

const DIRECTIONS = ['left', 'right', 'up', 'down', 'none'];
const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 5000;
const DEFAULT_FRAME_DURATION_MS = 1000;
const SCHEMA_VERSION = 2;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EVENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

// The runtime's animation-entry fields (validate-character-pack.js ANIMATION_FIELDS).
// P3 follow-up (2026-09-28): the pack now CARRIES the v2 metadata (tags / pingPong /
// events) — the runtime ignores what it does not read, and a later runtime can consume
// it without a format change. The list below is therefore the widened one.
const RUNTIME_ENTRY_FIELDS = ['direction', 'frames', 'loop', 'state', 'tags', 'pingPong', 'events'];
// The runtime's per-frame fields (ANIMATION_FRAME_FIELDS).
const RUNTIME_FRAME_FIELDS = ['anchor', 'durationMs', 'file', 'visibleBounds'];

function fail(code, detail = {}) {
  const error = new Error(`${code}${detail.reason ? `: ${detail.reason}` : ''}`);
  error.code = code;
  error.detail = detail;
  return error;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  return !value.split('/').includes('..');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---- parse -------------------------------------------------------------------

function parseActionDocV2(raw) {
  if (!isPlainObject(raw)) return { ok: false, code: 'ACTION_DOC_INVALID', message: 'the action doc must be a JSON object' };
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    return { ok: false, code: 'ACTION_SCHEMA_UNSUPPORTED', message: `action schemaVersion ${JSON.stringify(raw.schemaVersion)} (this studio reads 1 and 2)` };
  }
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id)) {
    return { ok: false, code: 'ACTION_ID_INVALID', message: 'action id must be kebab-case [a-z0-9-]' };
  }
  if (!DIRECTIONS.includes(raw.direction)) {
    return { ok: false, code: 'ACTION_DIRECTION_INVALID', message: `direction must be one of ${DIRECTIONS.join('|')}` };
  }
  if (typeof raw.loop !== 'boolean') return { ok: false, code: 'ACTION_LOOP_INVALID', message: 'loop must be a boolean' };
  if (!Array.isArray(raw.frames)) return { ok: false, code: 'ACTION_FRAMES_INVALID', message: 'frames must be an array' };
  const frames = [];
  for (const [index, frame] of raw.frames.entries()) {
    if (!isPlainObject(frame)) return { ok: false, code: 'ACTION_FRAME_INVALID', message: `frames[${index}] must be an object` };
    if (!isSafeRelativePath(frame.file)) return { ok: false, code: 'ACTION_FRAME_INVALID', message: `frames[${index}].file must be a safe relative path` };
    const durationMs = frame.durationMs === null || frame.durationMs === undefined ? null : frame.durationMs;
    if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs < MIN_FRAME_MS || durationMs > MAX_FRAME_MS)) {
      return { ok: false, code: 'ACTION_DURATION_INVALID', message: `frames[${index}].durationMs must be null or an integer in [${MIN_FRAME_MS}, ${MAX_FRAME_MS}]` };
    }
    frames.push({ file: frame.file, durationMs });
  }
  const geometry = isPlainObject(raw.geometry) ? raw.geometry : {};
  const footLine = Number.isInteger(geometry.footLine) ? geometry.footLine : 296;
  const tolerancePx = Number.isInteger(geometry.tolerancePx) ? geometry.tolerancePx : 1;

  const pingPong = raw.pingPong === true;
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const events = Array.isArray(raw.events) ? raw.events : [];

  const doc = {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    loop: raw.loop,
    pingPong,
    direction: raw.direction,
    frames,
    geometry: { footLine, tolerancePx },
    tags: tags.map((tag) => String(tag)),
    events: events.map((event) => ({ frame: event.frame, name: event.name, ...(event.data === undefined ? {} : { data: event.data }) })),
  };
  if (raw.createdAt) doc.createdAt = raw.createdAt;
  const validation = validateV2(doc);
  if (!validation.ok) return { ok: false, code: validation.violations[0].check, message: validation.violations[0].detail, violations: validation.violations };
  return { ok: true, doc, migratedFrom: raw.schemaVersion };
}

// ---- validate ----------------------------------------------------------------

function validateV2(doc) {
  const violations = [];
  const push = (check, detail) => violations.push({ check, detail });
  if (!isPlainObject(doc)) return { ok: false, violations: [{ check: 'action.shape', detail: 'doc must be an object' }] };
  if (doc.schemaVersion !== SCHEMA_VERSION) push('action.schemaVersion', `expected ${SCHEMA_VERSION}, got ${JSON.stringify(doc.schemaVersion)}`);
  if (typeof doc.pingPong !== 'boolean') push('action.pingPong', 'pingPong must be a boolean');
  if (!Array.isArray(doc.tags)) push('action.tags', 'tags must be an array');
  else {
    for (const tag of doc.tags) if (typeof tag !== 'string' || !TAG_PATTERN.test(tag)) push('action.tags[]', `tag must be kebab-case lowercase: ${JSON.stringify(tag)}`);
    if (new Set(doc.tags).size !== doc.tags.length) push('action.tags[]', 'tags must not repeat');
  }
  if (!Array.isArray(doc.events)) push('action.events', 'events must be an array');
  else {
    const frameCount = Array.isArray(doc.frames) ? doc.frames.length : 0;
    for (const [index, event] of doc.events.entries()) {
      if (!isPlainObject(event)) { push(`action.events[${index}]`, 'event must be an object'); continue; }
      if (!Number.isInteger(event.frame) || event.frame < 0 || event.frame >= Math.max(frameCount, 1)) {
        push(`action.events[${index}].frame`, `frame must be a metadata index in [0, ${Math.max(frameCount - 1, 0)}] (帧号锚定，不是文件名)`);
      }
      if (typeof event.name !== 'string' || !EVENT_PATTERN.test(event.name)) push(`action.events[${index}].name`, 'event name must be kebab-case');
      if (event.data !== undefined && !isPlainObject(event.data)) push(`action.events[${index}].data`, 'event data must be an object when present');
    }
  }
  if (doc.pingPong === true && frameCountOf(doc) < 3) {
    push('action.pingPong', `ping-pong needs at least 3 frames to read as a cycle (got ${frameCountOf(doc)})`);
  }
  return { ok: violations.length === 0, violations };
}

function frameCountOf(doc) {
  return Array.isArray(doc.frames) ? doc.frames.length : 0;
}

// ---- migrate v1 -> v2 --------------------------------------------------------

function migrateToV2(raw) {
  const parsed = parseActionDocV2({ ...raw, schemaVersion: raw.schemaVersion === 2 ? 2 : 1 });
  if (!parsed.ok) return parsed;
  return { ok: true, doc: parsed.doc, changed: raw.schemaVersion !== SCHEMA_VERSION };
}

// ---- compile down to the runtime entry ---------------------------------------

// The published entry carries ONLY the runtime's fields. `dropped` names what the
// authoring doc had that the runtime cannot express, so a publish can record the
// difference instead of silently losing it.
function compileDown(doc) {
  const entry = {
    direction: doc.direction,
    frames: doc.frames.map((frame) => ({ durationMs: frame.durationMs === undefined ? null : frame.durationMs, file: frame.file })),
    loop: doc.loop,
  };
  // mirror of action-publisher.buildPackEntry: metadata travels WHEN present, so a v1
  // doc compiles to a v1 entry byte-for-byte (no invented keys)
  if (Array.isArray(doc.tags) && doc.tags.length > 0) entry.tags = [...doc.tags];
  if (doc.pingPong === true) entry.pingPong = true;
  if (Array.isArray(doc.events) && doc.events.length > 0) {
    entry.events = doc.events.map((event) => ({ frame: event.frame, name: event.name, ...(event.data === undefined ? {} : { data: event.data }) }));
  }
  const dropped = [];
  // Nothing is dropped any more: the pack carries tags / pingPong / events (P3
  // follow-up). A field whose VALUE the runtime cannot act on is still not "lost" —
  // it travels, and whether a runtime READS it is that runtime's business.
  //
  // `pingPong` keeps one honest caveat: the pack stores the flag, but the order is the
  // forward order (a repeated file cannot be represented in anchors.frames, which is
  // keyed by file path). A consumer that honours pingPong must reverse the list itself.
  const notes = [];
  if (doc.pingPong === true) notes.push({ field: 'pingPong', note: 'carried as a flag; the frame list is the forward order (anchors.frames cannot key a repeated file)' });
  const schemaViolations = Object.keys(entry).filter((key) => !RUNTIME_ENTRY_FIELDS.includes(key));
  const frameViolations = entry.frames.flatMap((frame) => Object.keys(frame).filter((key) => !RUNTIME_FRAME_FIELDS.includes(key)));
  return { entry, dropped, notes, runtimeSafe: schemaViolations.length === 0 && frameViolations.length === 0 };
}

// ---- facts the bench shows -----------------------------------------------------

function summarize(doc) {
  const frames = doc.frames || [];
  const durations = frames.map((frame) => frame.durationMs === null || frame.durationMs === undefined ? DEFAULT_FRAME_DURATION_MS : frame.durationMs);
  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const cycleMs = doc.pingPong && frames.length > 2 ? totalMs * 2 - durations[0] - durations[durations.length - 1] : totalMs;
  const events = (doc.events || []).slice().sort((a, b) => a.frame - b.frame);
  return {
    id: doc.id,
    schemaVersion: doc.schemaVersion,
    direction: doc.direction,
    loop: doc.loop,
    pingPong: doc.pingPong === true,
    frames: frames.length,
    totalMs,
    cycleMs,
    defaultedFrames: durations.filter((value) => value === DEFAULT_FRAME_DURATION_MS).length,
    tags: doc.tags || [],
    events: events.map((event) => ({ frame: event.frame, name: event.name, file: frames[event.frame] ? frames[event.frame].file : null })),
    atMs: frames.map((frame, index) => ({ frame: index, file: frame.file, startMs: durations.slice(0, index).reduce((sum, value) => sum + value, 0) })),
  };
}

// Playback index for the bench: ping-pong wraps through the reversed middle.
function frameIndexAt(doc, elapsedMs) {
  const frames = doc.frames || [];
  if (frames.length === 0) return { index: null, cycleMs: 0 };
  const durations = frames.map((frame) => frame.durationMs === null || frame.durationMs === undefined ? DEFAULT_FRAME_DURATION_MS : frame.durationMs);
  const forward = durations.reduce((sum, value) => sum + value, 0);
  const cycle = doc.pingPong && frames.length > 2 ? forward * 2 - durations[0] - durations[durations.length - 1] : forward;
  let t = cycle > 0 ? ((elapsedMs % cycle) + cycle) % cycle : 0;
  const order = doc.pingPong && frames.length > 2
    ? [...frames.map((_, index) => index), ...frames.map((_, index) => index).slice(1, -1).reverse()]
    : frames.map((_, index) => index);
  for (const index of order) {
    if (t < durations[index]) return { index, cycleMs: cycle, offsetMs: t, order };
    t -= durations[index];
  }
  return { index: order[order.length - 1], cycleMs: cycle, offsetMs: t, order };
}

module.exports = {
  DEFAULT_FRAME_DURATION_MS,
  DIRECTIONS,
  MAX_FRAME_MS,
  MIN_FRAME_MS,
  RUNTIME_ENTRY_FIELDS,
  RUNTIME_FRAME_FIELDS,
  SCHEMA_VERSION,
  compileDown,
  frameCountOf,
  frameIndexAt,
  isSafeRelativePath,
  migrateToV2,
  parseActionDocV2,
  summarize,
  validateV2,
};
