'use strict';

// studio/lib/pipeline/cache.js — the content-addressed stage cache (brief §5
// cross-stage requirement: 改一步只重跑一步, ComfyUI semantics).
//
// A stage's cache key is a pure function of what the stage consumes:
//   key = sha256(stage | params | inputs[path:sha256] | toolVersion)
// so touching an unrelated file cannot invalidate it, and re-running the pipeline
// after one edit re-executes exactly the stages whose inputs moved.
//
// Layout: <repo>/.studio-cache/<stage>/<key>/{meta.json, output files}
// The cache is disposable by design: deleting the directory costs time, never data.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CACHE_DIR_NAME = '.studio-cache';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(absPath) {
  return sha256(fs.readFileSync(absPath));
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function createCache({ repoRoot, toolVersion = 'studio-0.1.0', cacheDir = null }) {
  const root = path.resolve(cacheDir || path.join(repoRoot, CACHE_DIR_NAME));

  // A value's cache identity: an existing FILE contributes its CONTENT hash, and
  // arrays/objects are walked recursively — otherwise a stage consuming a list of
  // frames would be keyed by file NAMES and an edited frame would not invalidate it
  // (found by the P4 acceptance test, which edits one frame and expects a re-run).
  function describeValue(value) {
    if (typeof value === 'string') {
      try {
        if (fs.existsSync(value) && fs.statSync(value).isFile()) return `file:${sha256File(value)}`;
      } catch { /* a race with a deleted file is just a literal then */ }
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(describeValue).join(',')}]`;
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${describeValue(value[key])}`).join(',')}}`;
  }

  // inputs: an object of {label: absPath | literal | [absPath]}. Files hash by
  // content, so a re-saved identical file does NOT invalidate the cache.
  function keyFor({ stage, params = {}, inputs = {} }) {
    const parts = [`stage:${stage}`, `tool:${toolVersion}`, `params:${canonical(params)}`];
    for (const name of Object.keys(inputs).sort()) {
      parts.push(`in:${name}=${describeValue(inputs[name])}`);
    }
    return { key: sha256(parts.join('\n')), parts };
  }

  function entryDir(stage, key) {
    return path.join(root, stage, key);
  }

  // Look up a cached stage result. `verify` re-hashes the recorded outputs, so a
  // hand-edited cache entry is a MISS rather than a lie.
  function get({ stage, key, verify = true }) {
    const dir = entryDir(stage, key);
    const metaPath = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaPath)) return { hit: false, dir };
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      return { hit: false, dir, reason: 'CACHE_META_UNPARSEABLE' };
    }
    if (verify) {
      for (const output of meta.outputs || []) {
        const abs = path.join(dir, output.name);
        if (!fs.existsSync(abs)) return { hit: false, dir, reason: 'CACHE_OUTPUT_MISSING' };
        if (output.sha256 && sha256File(abs) !== output.sha256) return { hit: false, dir, reason: 'CACHE_OUTPUT_CHANGED' };
      }
    }
    return { hit: true, dir, meta, outputs: (meta.outputs || []).map((output) => path.join(dir, output.name)) };
  }

  // Store a stage result: every output is copied into the entry (bytes first, then
  // the meta record), so a crash mid-write can only leave an incomplete entry,
  // never a corrupt hit.
  function put({ stage, key, meta = {}, outputs = {} }) {
    const dir = entryDir(stage, key);
    fs.mkdirSync(dir, { recursive: true });
    const recorded = [];
    for (const [name, source] of Object.entries(outputs)) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
      fs.writeFileSync(target, bytes);
      recorded.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const record = {
      schemaVersion: 1,
      stage,
      key,
      toolVersion,
      createdAt: new Date().toISOString(),
      ...meta,
      outputs: recorded,
    };
    fs.writeFileSync(path.join(dir, 'meta.json.tmp'), `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(path.join(dir, 'meta.json.tmp'), path.join(dir, 'meta.json'));
    return { dir, meta: record };
  }

  function stats() {
    const stages = {};
    let totalBytes = 0;
    let entries = 0;
    if (!fs.existsSync(root)) return { root, stages, entries: 0, totalBytes: 0 };
    for (const stage of fs.readdirSync(root)) {
      const stageDir = path.join(root, stage);
      if (!fs.statSync(stageDir).isDirectory()) continue;
      let stageEntries = 0;
      let stageBytes = 0;
      for (const key of fs.readdirSync(stageDir)) {
        const dir = path.join(stageDir, key);
        if (!fs.statSync(dir).isDirectory()) continue;
        stageEntries += 1;
        for (const name of fs.readdirSync(dir)) {
          const abs = path.join(dir, name);
          if (fs.statSync(abs).isFile()) stageBytes += fs.statSync(abs).size;
        }
      }
      stages[stage] = { entries: stageEntries, bytes: stageBytes };
      entries += stageEntries;
      totalBytes += stageBytes;
    }
    return { root, stages, entries, totalBytes };
  }

  function clear({ stage = null } = {}) {
    if (!fs.existsSync(root)) return { ok: true, removed: 0 };
    const target = stage ? path.join(root, stage) : root;
    if (!fs.existsSync(target)) return { ok: true, removed: 0 };
    const before = stats().entries;
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, removed: stage ? (before - stats().entries) : before };
  }

  function list({ stage = null } = {}) {
    const rows = [];
    if (!fs.existsSync(root)) return rows;
    const stages = stage ? [stage] : fs.readdirSync(root);
    for (const name of stages) {
      const stageDir = path.join(root, name);
      if (!fs.existsSync(stageDir) || !fs.statSync(stageDir).isDirectory()) continue;
      for (const key of fs.readdirSync(stageDir)) {
        const metaPath = path.join(stageDir, key, 'meta.json');
        if (!fs.existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          rows.push({ stage: name, key, createdAt: meta.createdAt, outputs: (meta.outputs || []).length, params: meta.params || null, note: meta.note || null });
        } catch { /* skip an unreadable entry */ }
      }
    }
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  return { root, canonical, describeValue, entryDir, get, keyFor, list, put, stats, clear };
}

module.exports = { CACHE_DIR_NAME, canonical, createCache, sha256, sha256File };
