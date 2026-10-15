'use strict';

// studio/lib/dialogue/corpus.js — the dialogue corpus engine (P7, brief §7F).
//
// Two layers, exactly as the runtime reads them:
//   content/shared/dialogue/base.json               the shared library (by topic)
//   content/characters/<id>/dialogue/character.json the character's override layer
// and the runtime resolves a topic as: character override wins, otherwise the base.
//
// The engine is deliberately strict about the things a corpus gets wrong quietly:
//   * ids repeat (within a topic and across topics in one file),
//   * text is empty, absurdly long or a duplicate of another line,
//   * a placeholder `{name}` that no scope provides,
//   * `if` conditions that name an unknown key,
//   * weights that are zero/negative/non-integer,
//   * and the PRIVACY red line — a line must never carry a session/run id, a path or a
//     key-shaped string (studio/lib/scan.js does the shape work).
// `validateCorpus()` returns red/yellow findings with a fix per finding; a save refuses
// red ones (fail closed) and takes a byte-copy backup first.

const path = require('node:path');
const fs = require('node:fs');

const scan = require('../scan.js');

const LIMITS = Object.freeze({ maxTextLength: 60, minWeight: 1, maxWeight: 20, maxEntriesPerTopic: 60 });
const CONDITION_KEYS = Object.freeze([
  'timeOfDay', 'peerActivity', 'taskActive', 'activity', 'phase', 'taskOutcome', 'scene', 'zone', 'weather',
]);
// placeholders the runtime can interpolate (keep in step with the dialogue engine)
const PLACEHOLDERS = Object.freeze(['name', 'peer', 'topic', 'seat', 'task', 'count']);

function fileFor({ contentDir, characterId, layer }) {
  return layer === 'character'
    ? path.join(contentDir, 'characters', characterId, 'dialogue', 'character.json')
    : path.join(contentDir, 'shared', 'dialogue', 'base.json');
}

function read({ contentDir, characterId = 'whale-girl', layer = 'base' }) {
  const file = fileFor({ contentDir, characterId, layer });
  if (!fs.existsSync(file)) return { ok: false, code: 'CORPUS_FILE_MISSING', message: file, file };
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, file, text, doc: JSON.parse(text), layer };
  } catch (error) {
    return { ok: false, code: 'CORPUS_UNPARSEABLE', message: error.message, file, layer };
  }
}

function topicsOf(doc, layer) {
  return layer === 'character' ? (doc.overrides || {}) : (doc.topics || {});
}

// ---- validation ---------------------------------------------------------------

function validateCorpus({ base, character = null }) {
  const findings = [];
  const push = (severity, code, detail, fix, where = {}) => findings.push({ severity, code, ...where, detail, fix });

  const checkLayer = (doc, layer) => {
    if (!doc || typeof doc !== 'object') { push('red', 'corpus.shape', `${layer} is not an object`, 'fix the file'); return; }
    if (doc.schemaVersion !== 1) push('red', 'corpus.schemaVersion', `${layer} schemaVersion ${JSON.stringify(doc.schemaVersion)}`, 'schemaVersion must be 1', { layer });
    const topics = topicsOf(doc, layer);
    const seenIds = new Map();      // entry id → topic (ids must be unique per file)
    const seenTexts = new Map();    // text → topic (duplicates waste the corpus)
    for (const [topic, entries] of Object.entries(topics)) {
      if (!Array.isArray(entries)) { push('red', 'corpus.topic-shape', `${layer}/${topic} is not an array`, 'a topic is an array of entries', { layer, topic }); continue; }
      if (entries.length > LIMITS.maxEntriesPerTopic) push('yellow', 'corpus.topic-large', `${layer}/${topic} has ${entries.length} entries`, `keep a topic under ${LIMITS.maxEntriesPerTopic} lines`, { layer, topic });
      for (const [index, entry] of entries.entries()) {
        const where = { layer, topic, index, id: entry && entry.id };
        if (!entry || typeof entry !== 'object') { push('red', 'corpus.entry-shape', `${layer}/${topic}[${index}] is not an object`, 'an entry is {id, text, weight}', where); continue; }
        if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(entry.id)) push('red', 'corpus.entry-id', `${layer}/${topic}[${index}] id ${JSON.stringify(entry.id)}`, 'ids are kebab-case, ≤32 chars', where);
        else if (seenIds.has(entry.id)) push('red', 'corpus.entry-id-duplicate', `${entry.id} also appears in ${seenIds.get(entry.id)}`, 'ids must be unique inside a file', where);
        else seenIds.set(entry.id, `${layer}/${topic}`);
        if (typeof entry.text !== 'string' || entry.text.trim().length === 0) push('red', 'corpus.entry-text', `${layer}/${topic}[${index}] has no text`, 'every line needs text', where);
        else {
          const text = entry.text.trim();
          if (text.length > LIMITS.maxTextLength) push('yellow', 'corpus.text-long', `${text.length} chars (limit ${LIMITS.maxTextLength}): ${text.slice(0, 24)}…`, 'a bubble that long cannot be read — split it or shorten it', where);
          const key = text.toLowerCase();
          if (seenTexts.has(key)) push('yellow', 'corpus.text-duplicate', `“${text.slice(0, 16)}” repeats ${seenTexts.get(key)}`, 'drop one of the two', where);
          else seenTexts.set(key, `${layer}/${topic}#${entry.id}`);
          // privacy red line: no ids, paths or key shapes in a line
          const scanOutcome = scan.scanForSecrets(text);
          if (!scanOutcome.ok) push('red', 'corpus.text-secret-shape', `“${text.slice(0, 24)}” carries a secret shape (${scanOutcome.hits.map((hit) => hit.code).join(',')})`, 'a bubble never carries a key', where);
          if (/(?:session|run|task)[-_][0-9a-f]{8,}/i.test(text)) push('red', 'corpus.text-identifier', `“${text.slice(0, 24)}” looks like a session/run id`, 'bubbles must not leak identities', where);
          if (/(?:\/Users\/|[A-Za-z]:\\\\)/.test(text)) push('red', 'corpus.text-path', `“${text.slice(0, 24)}” contains a filesystem path`, 'bubbles must not leak paths', where);
          for (const match of text.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
            if (!PLACEHOLDERS.includes(match[1])) push('yellow', 'corpus.placeholder-unknown', `{$match[1]} is not a known placeholder`, `the runtime can interpolate ${PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`, where);
          }
        }
        if (entry.weight !== undefined) {
          if (!Number.isInteger(entry.weight) || entry.weight < LIMITS.minWeight || entry.weight > LIMITS.maxWeight) {
            push('red', 'corpus.weight', `weight ${JSON.stringify(entry.weight)}`, `weights are integers in [${LIMITS.minWeight}, ${LIMITS.maxWeight}]`, where);
          }
        }
        if (entry.if !== undefined) {
          if (typeof entry.if !== 'object' || entry.if === null) push('red', 'corpus.if-shape', 'if must be an object', 'if is { key: value }', where);
          else {
            for (const key of Object.keys(entry.if)) {
              if (!CONDITION_KEYS.includes(key)) push('yellow', 'corpus.if-unknown-key', `if.${key} is not a known condition`, `known keys: ${CONDITION_KEYS.join(', ')}`, where);
            }
          }
        }
        if (entry.replyTo !== undefined && typeof entry.replyTo !== 'string') push('red', 'corpus.replyTo', 'replyTo must be an entry id string', 'fix the reference', where);
      }
    }
    return { topics: Object.keys(topics), entries: Object.values(topics).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0) };
  };

  const baseStats = checkLayer(base, 'base');
  const characterStats = character ? checkLayer(character, 'character') : null;

  // cross-layer: an override for a topic the base does not know is legal (it extends),
  // but it deserves a yellow note so the author knows the fallback is not the base
  if (characterStats && baseStats) {
    for (const topic of characterStats.topics) {
      if (!baseStats.topics.includes(topic)) {
        push('yellow', 'corpus.override-only-topic', `character/${topic} has no base topic`, 'the runtime will use the character layer alone for this topic — intended?', { layer: 'character', topic });
      }
    }
  }

  const reds = findings.filter((finding) => finding.severity === 'red');
  return {
    ok: reds.length === 0,
    findings,
    stats: { base: baseStats, character: characterStats },
    limits: LIMITS,
  };
}

// ---- edits (stage + save, with the same backup discipline as the other editors) ----

function addEntry({ doc, layer, topic, entry }) {
  const copy = JSON.parse(JSON.stringify(doc));
  const bucket = layer === 'character' ? (copy.overrides = copy.overrides || {}) : (copy.topics = copy.topics || {});
  if (!Array.isArray(bucket[topic])) bucket[topic] = [];
  // IDs are unique per FILE (that is what the guard enforces), so the editor must check
  // the whole layer rather than only the target topic — otherwise an add could stage a
  // duplicate that the save then refuses with a less helpful message.
  for (const [otherTopic, list] of Object.entries(bucket)) {
    if (!Array.isArray(list)) continue;
    if (list.some((existing) => existing.id === entry.id)) {
      return { ok: false, code: 'CORPUS_ID_TAKEN', message: `${entry.id} already exists in ${otherTopic}` };
    }
  }
  bucket[topic].push(entry);
  return { ok: true, doc: copy, topic, entry };
}

function updateEntry({ doc, layer, topic, id, patch }) {
  const copy = JSON.parse(JSON.stringify(doc));
  const bucket = layer === 'character' ? copy.overrides : copy.topics;
  const list = (bucket && bucket[topic]) || [];
  const target = list.find((existing) => existing.id === id);
  if (!target) return { ok: false, code: 'CORPUS_ENTRY_UNKNOWN', message: `no entry ${id} in ${topic}` };
  Object.assign(target, patch);
  return { ok: true, doc: copy, topic, entry: target };
}

function removeEntry({ doc, layer, topic, id }) {
  const copy = JSON.parse(JSON.stringify(doc));
  const bucket = layer === 'character' ? copy.overrides : copy.topics;
  const list = (bucket && bucket[topic]) || [];
  const index = list.findIndex((existing) => existing.id === id);
  if (index < 0) return { ok: false, code: 'CORPUS_ENTRY_UNKNOWN', message: `no entry ${id} in ${topic}` };
  list.splice(index, 1);
  return { ok: true, doc: copy };
}

// CSV: id,topic,text,weight,if.timeOfDay,if.peerActivity,replyTo  (header required, order free)
function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return { ok: false, code: 'CSV_EMPTY', message: 'a CSV needs a header and at least one row' };
  const splitRow = (line) => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quoted) {
        if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else current += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') { cells.push(current); current = ''; }
      else current += char;
    }
    cells.push(current);
    return cells.map((cell) => cell.trim());
  };
  // Column names match case-insensitively, but an `if.xxx` suffix keeps its own casing
  // (the condition keys are camelCase in the runtime — lowercasing turned timeOfDay into
  // timeofday and the guard then flagged a real column as unknown).
  const rawHeader = splitRow(lines[0]);
  const header = rawHeader.map((name) => name.toLowerCase());
  if (!header.includes('text')) return { ok: false, code: 'CSV_NO_TEXT_COLUMN', message: `the header needs a text column (got ${rawHeader.join(',')})` };
  if (!header.includes('topic')) return { ok: false, code: 'CSV_NO_TOPIC_COLUMN', message: 'the header needs a topic column' };
  const rows = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = splitRow(line);
    const row = {};
    rawHeader.forEach((rawName, cellIndex) => {
      const name = rawName.toLowerCase();
      const key = name.startsWith('if.') ? `if.${rawName.slice(3)}` : name;
      if (cells[cellIndex] !== undefined && cells[cellIndex] !== '') row[key] = cells[cellIndex];
    });
    if (!row.text) return { ok: false, code: 'CSV_ROW_NO_TEXT', message: `row ${index + 1} has no text` };
    const entry = { id: row.id || `${String(row.topic).slice(0, 8)}-csv-${String(index + 1).padStart(2, '0')}`, text: row.text };
    if (row.weight) entry.weight = Number(row.weight);
    const condition = {};
    for (const [key, value] of Object.entries(row)) {
      if (!key.startsWith('if.')) continue;
      condition[key.slice(3)] = /^-?\d+$/.test(value) ? Number(value) : (value === 'true' ? true : (value === 'false' ? false : value));
    }
    if (Object.keys(condition).length > 0) entry.if = condition;
    if (row.replyto) entry.replyTo = row.replyto;
    rows.push({ topic: row.topic, entry });
  }
  return { ok: true, rows };
}

function importRows({ doc, layer, rows }) {
  let next = doc;
  const added = [];
  const skipped = [];
  for (const { topic, entry } of rows) {
    const outcome = addEntry({ doc: next, layer, topic, entry });
    if (!outcome.ok) { skipped.push({ topic, id: entry.id, code: outcome.code }); continue; }
    next = outcome.doc;
    added.push({ topic, id: entry.id });
  }
  return { ok: true, doc: next, added, skipped };
}

// ---- save ---------------------------------------------------------------------

function detectIndent(text, fallback = 2) {
  const match = /\n(\s+)"/.exec(text);
  if (!match) return fallback;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

function save({ contentDir, characterId = 'whale-girl', layer = 'base', doc, dryRun = true, backupRoot = null }) {
  const loaded = read({ contentDir, characterId, layer });
  if (!loaded.ok) return loaded;
  const validation = validateCorpus({
    base: layer === 'base' ? doc : read({ contentDir, characterId, layer: 'base' }).doc,
    character: layer === 'character' ? doc : null,
  });
  if (!validation.ok) {
    const reds = validation.findings.filter((finding) => finding.severity === 'red');
    return { ok: false, code: 'CORPUS_INVALID', findings: reds, validation };
  }
  const before = loaded.text;
  const after = `${JSON.stringify(doc, null, detectIndent(before))}${before.endsWith('\n') ? '\n' : ''}`;
  if (before === after) return { ok: true, noop: true, file: loaded.file, validation };
  if (dryRun) return { ok: true, dryRun: true, changed: true, file: loaded.file, validation };
  const root = backupRoot || path.join(contentDir, 'build', 'backups', 'dialogue');
  fs.mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, `${stamp}-${path.basename(loaded.file)}`);
  fs.copyFileSync(loaded.file, backup);
  fs.writeFileSync(loaded.file, after);
  return { ok: true, dryRun: false, changed: true, file: loaded.file, backup, validation };
}

// ---- what the runtime would say (the panel's preview) --------------------------

// Resolve a topic the way the dialogue engine does: the character layer wins per topic.
function resolveTopic({ base, character, topic }) {
  const fromCharacter = character && character.overrides ? character.overrides[topic] : null;
  const fromBase = base && base.topics ? base.topics[topic] : null;
  if (!fromCharacter && !fromBase) return { ok: false, code: 'CORPUS_TOPIC_UNKNOWN', message: topic, known: [...new Set([...Object.keys((base && base.topics) || {}), ...Object.keys((character && character.overrides) || {})])].sort() };
  return {
    ok: true,
    topic,
    source: fromCharacter ? 'character' : 'base',
    entries: JSON.parse(JSON.stringify(fromCharacter || fromBase)),
    fallback: fromCharacter ? fromBase || null : null,
  };
}

// A deterministic pick (seeded) so the preview is reproducible — the runtime's own
// weights, the same idea as the behaviour graph's picker.
function pickEntry({ entries, seed = 'preview', context = {} }) {
  const eligible = entries.filter((entry) => {
    if (!entry.if) return true;
    return Object.entries(entry.if).every(([key, value]) => context[key] === undefined || context[key] === value);
  });
  const pool = eligible.length > 0 ? eligible : entries;
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, entry) => sum + (entry.weight || 1), 0);
  let roll = (() => {
    let state = 2166136261;
    for (const char of String(seed)) { state ^= char.charCodeAt(0); state = Math.imul(state, 16777619); }
    return () => {
      state = Math.imul(state ^ (state >>> 15), 2246822507);
      state = Math.imul(state ^ (state >>> 13), 3266489909);
      return ((state ^= state >>> 16) >>> 0) / 4294967296;
    };
  })();
  let value = roll() * total;
  for (const entry of pool) {
    value -= entry.weight || 1;
    if (value <= 0) return { entry, source: entry.if ? 'conditional' : 'always', eligible: eligible.length, pool: pool.length };
  }
  return { entry: pool[pool.length - 1], source: 'fallback', eligible: eligible.length, pool: pool.length };
}

module.exports = {
  CONDITION_KEYS,
  LIMITS,
  PLACEHOLDERS,
  addEntry,
  detectIndent,
  fileFor,
  importRows,
  parseCsv,
  pickEntry,
  read,
  removeEntry,
  resolveTopic,
  save,
  topicsOf,
  updateEntry,
  validateCorpus,
};
