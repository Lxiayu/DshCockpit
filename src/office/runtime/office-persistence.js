'use strict';

// src/office/runtime/office-persistence.js — Task 8 / SPEC-08.
//
// The Office state store: the ONLY reader/writer of
// `userData/office-state.v1.json`. Main-process only; the renderer never
// touches this file. Boundaries:
// - Legacy `settings.json`, `runtime-state.json`, `sessions/` are never read
//   or written here.
// - No prompts, task bodies, tool args/results, raw errors, session ids,
//   token/context counts or secrets are ever persisted: every payload passes
//   through the shared privacy redactor (SPEC-01) before writing, in the
//   mode selected by settings.privacyMode (default `redacted`; secrets are
//   redacted in EVERY mode).
// - No paths, animation frames, chat locks, reservations or in-flight
//   transitions are persisted.
// - Bindings are persisted only as recoverable snapshots carrying an epoch;
//   a binding from an old epoch is never restored as running — it is demoted
//   to stale history.
//
// Write strategy: same-directory temp file + fsync (when available) +
// atomic rename; a copy of the last successful write is kept at
// `<file>.bak`. Writes are serialized through a single promise chain so
// readers never observe a half-written file. A failed write keeps the
// previous valid file.

const fs = require('node:fs');
const path = require('node:path');

const { createPrivacyRedactor } = require('./privacy-redactor.js');

const SCHEMA_VERSION = 1;
const STATE_FILE_NAME = 'office-state.v1.json';
// Task 8: the user-saved PRODUCTION layout draft lives in its own file so the
// office-state schema/migration stays untouched. Same atomic-write discipline
// as the state store; the renderer reaches it only through the
// office-runtime protocol route (main process stays the single writer).
const LAYOUT_FILE_NAME = 'office-layout.v1.json';
const TASK_HISTORY_PER_EMPLOYEE = 50;
const ACTIVITY_LOG_LIMIT = 200;

const DEFAULT_FLAGS = Object.freeze({
  // M4 直启动 (2026-09-17)：运行时开关默认 ON；playground 仍是开发工具默认 OFF
  officeRuntimeEnabled: true,
  officePlaygroundEnabled: false,
});

const DEFAULT_SETTINGS = Object.freeze({
  sleepAfterMs: 300000,
  resultPresentationMs: 5000,
  sceneMinDimensionPerSecond: 0.046, // 与 office-module DEFAULT_SETTINGS 同步（步频匹配）
  userFrameDurationOverrideMs: null,
  reducedMotion: false,
  privacyMode: 'redacted',
});

// SPEC-08 clamps: sleep 60s..24h; result presentation 1s..30s; speed positive
// with a product ceiling; frame override null or a sane positive integer.
const SETTINGS_BOUNDS = Object.freeze({
  sleepAfterMs: { type: 'int', min: 60000, max: 24 * 60 * 60 * 1000 },
  resultPresentationMs: { type: 'int', min: 1000, max: 30000 },
  sceneMinDimensionPerSecond: { type: 'number', min: 0.02, max: 0.6 },
  userFrameDurationOverrideMs: { type: 'intOrNull', min: 60, max: 2000 },
  reducedMotion: { type: 'boolean' },
  privacyMode: { type: 'enum', values: ['redacted', 'full'] },
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clampNumber(value, rule) {
  if (rule.type === 'boolean') return value === true;
  if (rule.type === 'enum') return rule.values.includes(value) ? value : null;
  if (rule.type === 'intOrNull') {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value)) return null;
    return Math.min(rule.max, Math.max(rule.min, value));
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const clamped = Math.min(rule.max, Math.max(rule.min, value));
  return rule.type === 'int' ? Math.round(clamped) : clamped;
}

// Returns a full settings object: known keys clamped, missing keys defaulted.
function normalizeSettings(raw) {
  const input = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(SETTINGS_BOUNDS)) {
    const rule = SETTINGS_BOUNDS[key];
    if (!(key in input)) {
      out[key] = DEFAULT_SETTINGS[key];
      continue;
    }
    const clamped = clampNumber(input[key], rule);
    out[key] = clamped === null && rule.type !== 'intOrNull' ? DEFAULT_SETTINGS[key] : clamped;
  }
  return out;
}

// Strict validation for user-driven updates: bad types/unknown keys are
// rejected (no silent clamp of garbage), valid numbers are clamped.
function validateSettingsPatch(partial) {
  if (!isPlainObject(partial)) return { ok: false, code: 'SETTINGS_INVALID' };
  const out = {};
  for (const key of Object.keys(partial)) {
    const rule = SETTINGS_BOUNDS[key];
    if (!rule) return { ok: false, code: 'SETTINGS_INVALID' };
    const value = partial[key];
    if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') return { ok: false, code: 'SETTINGS_INVALID' };
      out[key] = value;
    } else if (rule.type === 'enum') {
      if (!rule.values.includes(value)) return { ok: false, code: 'SETTINGS_INVALID' };
      out[key] = value;
    } else if (rule.type === 'intOrNull') {
      // null or a legal positive integer; a non-positive value clears the
      // override, a non-integer/non-number is rejected.
      if (value !== null && typeof value !== 'number') return { ok: false, code: 'SETTINGS_INVALID' };
      if (value !== null && !Number.isInteger(value)) return { ok: false, code: 'SETTINGS_INVALID' };
      if (value === null || value <= 0) out[key] = null;
      else out[key] = Math.min(rule.max, Math.max(rule.min, value));
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, code: 'SETTINGS_INVALID' };
      const clamped = Math.min(rule.max, Math.max(rule.min, value));
      out[key] = rule.type === 'int' ? Math.round(clamped) : clamped;
    }
  }
  return { ok: true, settings: out };
}

function normalizeFlags(raw) {
  const input = isPlainObject(raw) ? raw : {};
  return {
    officeRuntimeEnabled: input.officeRuntimeEnabled === true,
    officePlaygroundEnabled: input.officePlaygroundEnabled === true,
  };
}

// Read-time migration: any accepted input becomes a complete v1 state object
// (defaults filled, settings clamped). Returns null when the input cannot be
// migrated at all (non-object, or a NEWER schema we do not understand).
function migrateOfficeState(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) return null;
  const asArray = (value) => (Array.isArray(value) ? value.filter(isPlainObject) : []);
  return {
    schemaVersion: SCHEMA_VERSION,
    flags: normalizeFlags(raw.flags),
    settings: normalizeSettings(raw.settings),
    employees: asArray(raw.employees),
    tasks: asArray(raw.tasks),
    activityLog: asArray(raw.activityLog),
    bindings: asArray(raw.bindings),
  };
}

// Persist-time sanitizer: history bounds + privacy redaction. Pure.
function sanitizeForPersist(state, redactor) {
  const tasksByEmployee = new Map();
  for (const task of state.tasks) {
    const list = tasksByEmployee.get(task.employeeId) || [];
    list.push(task);
    tasksByEmployee.set(task.employeeId, list);
  }
  const tasks = [];
  for (const list of tasksByEmployee.values()) {
    tasks.push(...list.slice(-TASK_HISTORY_PER_EMPLOYEE));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    flags: { ...state.flags },
    settings: { ...state.settings },
    employees: redactor.redactValue(state.employees),
    tasks: redactor.redactValue(tasks),
    activityLog: redactor.redactValue(state.activityLog.slice(-ACTIVITY_LOG_LIMIT)),
    // Only recoverable binding snapshots: an epoch is mandatory, and no
    // session ids / paths / frames ever reach this structure by construction.
    bindings: redactor.redactValue(
      state.bindings.filter((binding) => Number.isInteger(binding.epoch))
    ),
  };
}

function createOfficeStateStore(options = {}) {
  const {
    userDataDir,
    epoch = 0,
    log = () => {},
  } = options;
  if (!userDataDir) throw new TypeError('createOfficeStateStore requires userDataDir');

  const file = path.join(userDataDir, STATE_FILE_NAME);
  const backupFile = `${file}.bak`;
  const diagnosticsLog = [];
  let writeChain = Promise.resolve();
  let tmpCounter = 0;

  function noteDiagnostic(code) {
    diagnosticsLog.push({ code });
    if (diagnosticsLog.length > 100) diagnosticsLog.splice(0, diagnosticsLog.length - 100);
    log(`[office-state] ${code}`);
  }

  function parseStateFile(target) {
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      return { ok: false, missing: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false };
    }
    const migrated = migrateOfficeState(parsed);
    return migrated ? { ok: true, state: migrated } : { ok: false };
  }

  // Applies the epoch gate AFTER migration: active bindings from an old epoch
  // become stale history and are never restored as running.
  function applyEpochGate(state) {
    const active = [];
    const staleBindings = [];
    const history = [];
    for (const binding of state.bindings) {
      if (binding.releasedAtMs !== null && binding.releasedAtMs !== undefined) {
        history.push(binding);
      } else if (binding.epoch === epoch) {
        active.push(binding);
      } else {
        staleBindings.push({ ...binding, stale: true });
        noteDiagnostic('OFFICE_STATE_EPOCH_REJECTED');
      }
    }
    return { ...state, bindings: [...history, ...active], staleBindings };
  }

  function loadState() {
    const primary = parseStateFile(file);
    if (primary.ok) return applyEpochGate(primary.state);
    if (!primary.missing) {
      noteDiagnostic('OFFICE_STATE_CORRUPT');
      const backup = parseStateFile(backupFile);
      if (backup.ok) return applyEpochGate(backup.state);
      if (!backup.missing) noteDiagnostic('OFFICE_STATE_CORRUPT');
    }
    return applyEpochGate(migrateOfficeState({}));
  }

  let current = loadState();

  function redactor() {
    return createPrivacyRedactor({ mode: current.settings.privacyMode });
  }

  // Single-writer serialization: every save queues behind the previous one.
  function save(patch = {}) {
    const run = writeChain.then(() => {
      const merged = {
        ...current,
        ...Object.fromEntries(
          Object.entries(patch).filter(([key]) => ['flags', 'settings', 'employees', 'tasks', 'activityLog', 'bindings'].includes(key))
        ),
        settings: normalizeSettings({ ...current.settings, ...(isPlainObject(patch.settings) ? patch.settings : {}) }),
        flags: normalizeFlags({ ...current.flags, ...(isPlainObject(patch.flags) ? patch.flags : {}) }),
      };
      const persistable = sanitizeForPersist(merged, redactor());
      const tmp = `${file}.tmp-${process.pid}-${tmpCounter += 1}`;
      try {
        fs.mkdirSync(userDataDir, { recursive: true });
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeFileSync(fd, JSON.stringify(persistable, null, 2));
          try { fs.fsyncSync(fd); } catch { /* fsync unavailable: rename is still atomic */ }
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        noteDiagnostic('OFFICE_STATE_WRITE_FAILED');
        throw new Error(`OFFICE_STATE_WRITE_FAILED: ${error && error.message}`);
      }
      // last-good backup for corruption recovery (best effort, never fatal)
      try { fs.copyFileSync(file, backupFile); } catch { /* low-permission dirs */ }
      current = applyEpochGate({ ...persistable, staleBindings: [] });
      return Object.freeze({ ok: true });
    });
    writeChain = run.catch(() => {}); // a failed write never blocks the queue
    return run;
  }

  async function updateSettings(partial) {
    const validation = validateSettingsPatch(partial);
    if (!validation.ok) return Object.freeze({ ok: false, code: validation.code });
    await save({ settings: { ...current.settings, ...validation.settings } });
    return Object.freeze({ ok: true, settings: { ...current.settings } });
  }

  // ---- Task 8: the saved production layout (office-layout.v1.json) ---------
  // Full schema-v1 CONTENT validation lives in the page (layout-editor
  // validateDraftSchema with the asset catalog); this layer only guards the
  // envelope (object + schemaVersion) and never throws.

  function loadSavedLayout() {
    let raw;
    try {
      raw = fs.readFileSync(path.join(userDataDir, LAYOUT_FILE_NAME), 'utf8');
    } catch {
      return { ok: false, missing: true, code: null, draft: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, missing: false, code: 'OFFICE_LAYOUT_SAVED_CORRUPT', draft: null };
    }
    if (!isPlainObject(parsed) || parsed.schemaVersion !== 1) {
      return { ok: false, missing: false, code: 'OFFICE_LAYOUT_SAVED_INVALID', draft: null };
    }
    return { ok: true, missing: false, code: null, draft: parsed };
  }

  function saveSavedLayout(draft) {
    if (!isPlainObject(draft)) {
      return Promise.resolve(Object.freeze({ ok: false, code: 'OFFICE_LAYOUT_SAVED_INVALID' }));
    }
    const run = writeChain.then(() => {
      const tmp = `${path.join(userDataDir, LAYOUT_FILE_NAME)}.tmp-${process.pid}-${tmpCounter += 1}`;
      try {
        fs.mkdirSync(userDataDir, { recursive: true });
        const fd = fs.openSync(tmp, 'w');
        try {
          fs.writeFileSync(fd, JSON.stringify(draft, null, 2));
          try { fs.fsyncSync(fd); } catch { /* fsync unavailable: rename is still atomic */ }
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, path.join(userDataDir, LAYOUT_FILE_NAME));
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        noteDiagnostic('OFFICE_STATE_WRITE_FAILED');
        return Object.freeze({ ok: false, code: 'OFFICE_STATE_WRITE_FAILED' });
      }
      return Object.freeze({ ok: true, file: path.join(userDataDir, LAYOUT_FILE_NAME) });
    });
    writeChain = run.catch(() => {});
    return run;
  }

  function deleteSavedLayout() {
    const run = writeChain.then(() => {
      try { fs.rmSync(path.join(userDataDir, LAYOUT_FILE_NAME), { force: true }); } catch { /* best effort */ }
      return Object.freeze({ ok: true });
    });
    writeChain = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    file,
    get: () => current,
    save,
    updateSettings,
    redactor,
    diagnostics: () => diagnosticsLog.slice(),
    loadSavedLayout,
    saveSavedLayout,
    deleteSavedLayout,
  });
}

module.exports = {
  createOfficeStateStore,
  migrateOfficeState,
  sanitizeForPersist,
  normalizeSettings,
  validateSettingsPatch,
  DEFAULT_FLAGS,
  DEFAULT_SETTINGS,
  SETTINGS_BOUNDS,
  SCHEMA_VERSION,
  STATE_FILE_NAME,
  LAYOUT_FILE_NAME,
  TASK_HISTORY_PER_EMPLOYEE,
  ACTIVITY_LOG_LIMIT,
};
