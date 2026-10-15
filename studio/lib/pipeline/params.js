'use strict';

// studio/lib/pipeline/params.js — the .params.json ACCOUNTING layer (R4).
//
// The breakpoint this closes: asset-provenance could answer "which file did this
// byte come from", but NOT "which model/tool, which parameters, which seed, which
// input bytes, which executor — and can I reproduce it". Every generation or
// conversion call the studio performs now lands ONE record in the action's ledger
// (content/characters/<id>/provenance/generation/<actionId>.params.json), through
// the SAME append-only write door the passport reads (lib/provenance.js).
//
// The contract a record must satisfy (REQUIRED_CALL_FIELDS — asserted by tests):
//   tool + toolVersion   which implementation ran (a name alone rots; the version
//                        is what makes the cache key and the record comparable)
//   agent                who executed it (the human's coding agent identity, so a
//                        record can be traced back to a session, not just a machine)
//   command              the ONE-LINE reproduce command — copy, paste, rerun
//   params + seed        the full parameter set (canonicalized into the cache key)
//   inputs[].sha256      the input file HASHES (content, not names)
//   outputs[].sha256     the output file HASHES (what verify() re-checks later)
//   recordedAt           when
//
// Secrets: the record is scanned with the export-boundary shape scanner
// (lib/scan.js) BEFORE anything is written. A hit refuses the write with
// SECRET_SHAPE_REFUSED and fingerprints only — the value never reaches disk.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const provenance = require('../provenance.js');
const scan = require('../scan.js');

const STUDIO_ROOT = path.resolve(__dirname, '..', '..');

/** Record kinds a CALL may use (same closed set as the ledger schema). */
const CALL_KINDS = Object.freeze(['image', 'video', 'frame-sheet']);

/**
 * The fields every call record must carry. `promptHash`/`seed`/`provider`/`model`
 * are conditional (a conversion call has no prompt; a local tool has no provider),
 * everything here is unconditional — a record missing one of these is refused,
 * because "we ran something" is not provenance.
 */
const REQUIRED_CALL_FIELDS = Object.freeze([
  'actionId', 'kind', 'tool', 'toolVersion', 'agent', 'command', 'recordedAt', 'inputs', 'outputs',
]);

/** Input/output roles (free-form strings, but these are the ones the studio writes). */
const ROLES = Object.freeze({
  SOURCE_VIDEO: 'source-video',
  SOURCE_FRAMES: 'source-frames',
  REFERENCE: 'reference',
  CLEANED_FRAMES: 'cleaned-frames',
  NORMALIZED_FRAMES: 'normalized-frames',
  QC_REPORT: 'qc-report',
  VIDEO: 'video',
});

let cachedToolVersion = null;

/** The studio's own tool version — read from its package.json, never hard-coded twice. */
function studioToolVersion() {
  if (cachedToolVersion) return cachedToolVersion;
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(STUDIO_ROOT, 'package.json'), 'utf8')).version || version;
  } catch { /* a studio tree without its package.json still records something honest */ }
  cachedToolVersion = `dsh-studio@${version}`;
  return cachedToolVersion;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * The executor identity. An external coding agent SHOULD set STUDIO_AGENT_ID (or
 * pass `agent`); the fallback names the CLI honestly instead of pretending.
 */
function resolveAgent(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 120);
  const fromEnv = env.STUDIO_AGENT_ID || env.AGENT_ID || null;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim().slice(0, 120);
  return 'studio-cli';
}

/**
 * Hash a file list into ledger input/output entries.
 * `{ path }` only → the file must exist (its content hash is computed on the spot);
 * an explicit sha256 is kept as given (cache bytes that no longer live at a path).
 * A missing file WITHOUT a hash is an ERROR — a call cannot have consumed bytes
 * that were never there, and inventing a hash is exactly what this module forbids.
 */
function hashFiles(entries, { label = 'files' } = {}) {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) return { ok: false, error: `${label} must be an array` };
  const out = [];
  for (const entry of entries) {
    const value = typeof entry === 'string' ? { path: entry } : entry;
    if (!value || typeof value !== 'object' || typeof value.path !== 'string' || !value.path.trim()) {
      return { ok: false, error: `${label} entry needs a path` };
    }
    const item = { path: value.path.trim() };
    let sha = typeof value.sha256 === 'string' && value.sha256 ? value.sha256.toLowerCase() : null;
    if (!sha) {
      try {
        if (fs.existsSync(item.path) && fs.statSync(item.path).isFile()) sha = sha256File(item.path);
      } catch { /* unreadable: handled below */ }
      if (!sha) return { ok: false, error: `${label} file not found (and no sha256 given): ${item.path}` };
    }
    item.sha256 = sha;
    if (typeof value.role === 'string' && value.role) item.role = value.role.slice(0, 60);
    if (typeof value.label === 'string' && value.label) item.label = value.label.slice(0, 120);
    out.push(item);
  }
  return out;
}

/**
 * Build one call record (strict out): validates, hashes, fills the identity
 * fields. Returns { ok:true, record } or { ok:false, error } — never a half shape.
 */
function buildCallRecord(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'call must be an object' };
  const actionId = input.actionId;
  if (typeof actionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(actionId) || actionId.includes('..') || actionId.length > 120) {
    return { ok: false, error: `invalid actionId: ${JSON.stringify(actionId)}` };
  }
  const kind = input.kind === undefined || input.kind === null ? 'frame-sheet' : String(input.kind);
  if (!CALL_KINDS.includes(kind)) return { ok: false, error: `invalid kind: ${JSON.stringify(input.kind)} (expected ${CALL_KINDS.join('|')})` };
  const tool = typeof input.tool === 'string' && input.tool.trim() ? input.tool.trim() : null;
  if (!tool) return { ok: false, error: 'tool is required (which implementation ran)' };
  const toolVersion = typeof input.toolVersion === 'string' && input.toolVersion.trim() ? input.toolVersion.trim() : studioToolVersion();
  const agent = resolveAgent(input.agent, input.env);
  const command = typeof input.command === 'string' && input.command.trim() ? input.command.trim() : null;
  if (!command) return { ok: false, error: 'command is required (the one-line reproduce command)' };
  if (command.length > 2000) return { ok: false, error: 'command is unreasonably long (>2000 chars)' };

  const inputs = hashFiles(input.inputs, { label: 'inputs' });
  if (!Array.isArray(inputs)) return inputs;
  const outputs = hashFiles(input.outputs, { label: 'outputs' });
  if (!Array.isArray(outputs)) return outputs;

  const record = {
    schemaVersion: provenance.PARAMS_SCHEMA_VERSION,
    actionId,
    recordedAt: typeof input.recordedAt === 'string' && input.recordedAt.trim() ? input.recordedAt.trim() : new Date().toISOString(),
    kind,
    tool: tool.slice(0, 200),
    toolVersion: toolVersion.slice(0, 120),
    agent,
    command: command,
  };
  if (input.provider !== undefined && input.provider !== null) record.provider = String(input.provider).slice(0, 120);
  if (input.model !== undefined && input.model !== null) record.model = String(input.model).slice(0, 200);
  // prompt: hash by default; the text only lands when explicitly asked for
  const prompt = typeof input.prompt === 'string' ? input.prompt : null;
  if (prompt !== null) {
    record.promptHash = typeof input.promptHash === 'string' && input.promptHash ? input.promptHash : provenance.hashPrompt(prompt);
    if (input.storePromptText === true) record.prompt = prompt;
  } else if (typeof input.promptHash === 'string' && input.promptHash) {
    record.promptHash = input.promptHash;
  }
  if (input.params !== undefined && input.params !== null) record.params = input.params;
  if (input.seed !== undefined && input.seed !== null) record.seed = input.seed;
  if (typeof input.note === 'string' && input.note.trim()) record.note = input.note.trim().slice(0, 400);
  record.inputs = inputs;
  record.outputs = outputs;
  return { ok: true, record };
}

/** Field completeness check (what tests assert; what recordCall enforces). */
function missingCallFields(record) {
  if (!record || typeof record !== 'object') return [...REQUIRED_CALL_FIELDS];
  return REQUIRED_CALL_FIELDS.filter((field) => record[field] === undefined || record[field] === null || record[field] === '');
}

/**
 * The one-click reproduce command for a record: the command it was run with.
 * (Same rule as the passport: a record without a command cannot be reproduced
 * from the ledger alone — and we say so instead of synthesizing a guess.)
 */
const reproduceCommand = provenance.reproduceCommand;

/** Same call, same bytes: a dedupe key over (tool, version, params, input hashes). */
function callFingerprint(record) {
  const inputShas = (record.inputs || []).map((entry) => entry.sha256).sort();
  const outputShas = (record.outputs || []).map((entry) => entry.sha256).sort();
  return crypto.createHash('sha256').update([
    record.tool, record.toolVersion, canonical(record.params || null),
    inputShas.join(','), outputShas.join(','),
  ].join('\u0000')).digest('hex');
}

/**
 * Record one call into the action's ledger (append-only, through the passport's
 * own write door). Secret-shaped payloads are refused BEFORE the write; an
 * identical call (same tool+params+input bytes) is skipped, so re-running an
 * unchanged pipeline does not grow the ledger.
 */
function recordCall({ repoRoot, characterId, actionId, call, dedupe = true } = {}) {
  if (!repoRoot) return { ok: false, error: 'repoRoot is required' };
  const built = buildCallRecord({ ...(call || {}), actionId: actionId || (call || {}).actionId });
  if (!built.ok) return { ok: false, error: built.error };
  const missing = missingCallFields(built.record);
  if (missing.length) return { ok: false, error: `incomplete call record (missing: ${missing.join(', ')})` };

  // the secret scan runs on the EXACT bytes that would be written
  const serialized = JSON.stringify(built.record);
  const secretScan = scan.scanForSecrets(serialized);
  if (!secretScan.ok) {
    return {
      ok: false,
      code: 'SECRET_SHAPE_REFUSED',
      error: `refusing to write the params ledger: ${secretScan.hits.length} secret-shaped string(s) [${[...new Set(secretScan.hits.map((hit) => hit.code))].join(',')}] — remove the credential and record again`,
      hits: secretScan.hits,
      fingerprints: secretScan.hits.map((hit) => hit.fingerprint),
    };
  }

  if (dedupe) {
    const existing = provenance.readParamsLedger({ repoRoot, characterId, actionId: built.record.actionId });
    const fingerprint = callFingerprint(built.record);
    if (existing.ok && existing.records.some((row) => callFingerprint(row) === fingerprint)) {
      return { ok: true, skipped: true, reason: 'identical-call-already-recorded', file: existing.file, record: built.record };
    }
  }

  const written = provenance.writeParamsRecord({
    repoRoot,
    characterId,
    actionId: built.record.actionId,
    record: built.record,
  });
  if (!written.ok) return { ok: false, error: written.error, code: written.code };
  return { ok: true, skipped: false, file: written.file, record: written.record };
}

module.exports = {
  CALL_KINDS,
  REQUIRED_CALL_FIELDS,
  ROLES,
  buildCallRecord,
  callFingerprint,
  hashFiles,
  missingCallFields,
  recordCall,
  reproduceCommand,
  resolveAgent,
  studioToolVersion,
};
