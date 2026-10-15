'use strict';

// studio/lib/pipeline/triage.js — the HUMAN triage queue (R4).
//
// When a stage stays red after the automatic retry budget (1 attempt + up to
// maxRetries fixes), the item is QUEUED instead of looping forever or passing
// silently. The queue is a JSON file per action under the tool-output tree:
//
//   <contentDir>/build/triage/<actionId>.triage.json
//
// Each entry answers the four questions a human needs before touching anything:
//   WHICH STEP failed (stage), WHAT is wrong (code + reason + findings),
//   WHAT TO TRY (fix — the finding's own repair suggestion),
//   HOW MUCH was already spent (attempts / maxRetries / runs).
//
// State machine (two states, one edge):
//   open --resolve(id, note)--> resolved
// `resolve` requires a note (an unexplained resolution is not a resolution);
// resolving an unknown or already-resolved id fails closed. A stage that passes
// on a later run AUTO-resolves its matching open entries (recorded as such), so
// the queue empties itself as material gets fixed — nothing is silently dropped:
// every transition is written to the file.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const FILE_SUFFIX = '.triage.json';

function queuePath(contentDir, actionId) {
  return path.join(contentDir, 'build', 'triage', `${actionId}${FILE_SUFFIX}`);
}

function readQueue(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeQueue(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function createTriageQueue({ contentDir, actionId } = {}) {
  if (!contentDir || !actionId) {
    return { ok: false, error: 'contentDir and actionId are required' };
  }
  const file = queuePath(contentDir, actionId);
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(actionId) && !actionId.includes('..');

  function load() {
    if (!safeId) return { schemaVersion: SCHEMA_VERSION, actionId, entries: [] };
    const doc = readQueue(file);
    return doc || { schemaVersion: SCHEMA_VERSION, actionId, entries: [] };
  }

  function save(doc) {
    if (!safeId) return { ok: false, error: `unsafe actionId: ${JSON.stringify(actionId)}` };
    writeQueue(file, doc);
    return { ok: true, file };
  }

  function nextId(entries, stage, code) {
    const base = `${actionId}-${stage}-${code}`.replace(/[^A-Za-z0-9._-]/g, '_');
    let n = 1;
    for (const entry of entries) {
      const match = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`).exec(entry.id);
      if (match) n = Math.max(n, Number(match[1]) + 1);
    }
    return `${base}-${n}`;
  }

  /**
   * Queue (or update) a failing stage. Upsert by (stage, code): a second run of
   * the same failure grows `attempts`/`runs` on the SAME entry instead of piling
   * up duplicates — "已重试几次" must be one number, not a pile.
   */
  function open({ stage, code, severity = 'red', findings = [], attempts = 1, maxRetries = 3, needsHuman = true, reason = null, fix = null } = {}) {
    if (!stage || !code) return { ok: false, error: 'stage and code are required' };
    const doc = load();
    const existing = doc.entries.find((entry) => entry.stage === stage && entry.code === code && entry.status === 'open');
    const now = new Date().toISOString();
    const message = reason || (findings || []).map((row) => row.message).filter(Boolean).join(' / ') || code;
    const repair = fix || (findings || []).map((row) => row.fix).filter(Boolean).join(' / ') || 'see the finding codes';
    if (existing) {
      existing.attempts = Math.max(existing.attempts, Number(attempts) || 1);
      existing.maxRetries = Math.max(existing.maxRetries, Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 3);
      existing.runs += 1;
      existing.findings = findings || existing.findings;
      existing.reason = message;
      existing.fix = repair;
      existing.needsHuman = Boolean(needsHuman);
      existing.updatedAt = now;
      save(doc);
      return { ok: true, entry: existing, created: false, file };
    }
    const entry = {
      id: nextId(doc.entries, stage, code),
      actionId,
      stage,
      code,
      status: 'open',
      severity,
      attempts: Number.isFinite(Number(attempts)) ? Number(attempts) : 1,
      maxRetries: Number.isFinite(Number(maxRetries)) ? Number(maxRetries) : 3,
      runs: 1,
      needsHuman: Boolean(needsHuman),
      reason: message,
      fix: repair,
      findings: findings || [],
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      resolution: null,
    };
    doc.entries.push(entry);
    save(doc);
    return { ok: true, entry, created: true, file };
  }

  function list({ status = null } = {}) {
    const rows = load().entries.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return status ? rows.filter((entry) => entry.status === status) : rows;
  }

  function show(id) {
    return load().entries.find((entry) => entry.id === id) || null;
  }

  /** open → resolved. A note is mandatory: "fixed" without a why is not a record. */
  function resolve(id, { note = null, by = null } = {}) {
    if (!id) return { ok: false, error: 'id is required' };
    const text = typeof note === 'string' ? note.trim() : '';
    if (!text) return { ok: false, error: 'a resolution note is required (what did you change?)' };
    const doc = load();
    const entry = doc.entries.find((row) => row.id === id);
    if (!entry) return { ok: false, error: `unknown triage id: ${id}` };
    if (entry.status === 'resolved') return { ok: false, error: `already resolved at ${entry.resolvedAt}` };
    entry.status = 'resolved';
    entry.resolvedAt = new Date().toISOString();
    entry.resolution = { note: text.slice(0, 2000), by: by || 'human' };
    entry.updatedAt = entry.resolvedAt;
    save(doc);
    return { ok: true, entry, file };
  }

  /** A stage that now passes closes its own open entries (with an auto note). */
  function autoResolve({ stage = null, code = null } = {}) {
    const doc = load();
    const now = new Date().toISOString();
    const closed = [];
    for (const entry of doc.entries) {
      if (entry.status !== 'open') continue;
      if (stage && entry.stage !== stage) continue;
      if (code && entry.code !== code) continue;
      entry.status = 'resolved';
      entry.resolvedAt = now;
      entry.resolution = { note: `auto: ${entry.stage} passed on re-run — the material changed underneath this finding`, by: 'pipeline' };
      entry.updatedAt = now;
      closed.push(entry.id);
    }
    if (closed.length) save(doc);
    return { ok: true, closed, file };
  }

  function stats() {
    const entries = load().entries;
    return {
      file,
      total: entries.length,
      open: entries.filter((entry) => entry.status === 'open').length,
      resolved: entries.filter((entry) => entry.status === 'resolved').length,
      needsHuman: entries.filter((entry) => entry.status === 'open' && entry.needsHuman).length,
    };
  }

  return { ok: true, file, actionId, autoResolve, list, open, resolve, show, stats };
}

module.exports = { FILE_SUFFIX, SCHEMA_VERSION, createTriageQueue, queuePath };
