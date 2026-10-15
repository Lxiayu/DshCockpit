'use strict';

// src/workbench/app/problems.js — the ONE problems panel's aggregator (plan task
// T12: 「场景检查 12 条重复 SCENE_FURNITURE_OVERLAP 改为「按代码聚合 + 展开看明细」」).
//
// WHY this exists: every validator in this project returns its own findings list
// in its own shape — studio/lib/scene/conflicts.js pushes
// { code, severity, message, itemId, detail }, the pack guard pushes
// { check, detail, path }, the behaviour-graph validator pushes { check, detail }.
// Each list got its own tool panel, and the scene check's output was 12 rows of
// the SAME code SCENE_FURNITURE_OVERLAP pushing the useful summary
// (工位 6 · 座位 6 · 障碍 32) out of view. The plan's fix is ONE bottom panel fed
// by every validator (场景检查、发布校验、行为图检查、语料守卫、能力缺口), with
// the findings grouped BY CODE: 12 identical rows collapse into one row with a
// count that expands into its 12 details.
//
// This module is the AGGREGATOR ONLY and it is deliberately pure:
//   * no DOM, no IPC, no file system, no timers, no module-level state — two
//     containers (a Map of source → findings, a Set of listeners) live inside one
//     closure, so two stores never see each other;
//   * the caller's findings are NEVER mutated and never stored by reference: they
//     are normalised into fresh records on ingest ({ severity, code, message,
//     target } only), and get() hands out fresh copies of those again, so a
//     renderer can scribble on what it was given;
//   * it NEVER throws: a non-object finding, a non-array findings argument, a
//     missing code, a severity nobody has heard of and even a throwing listener
//     are all absorbed.
//
// What the panel still owns (NOT here, by design): rendering, the expand/collapse
// state of a group, and click-to-jump — the `target` records this module passes
// through untouched are exactly what the jump handler reads.

const PROBLEM_SEVERITIES = Object.freeze(['red', 'yellow', 'note']);

// Every validator invents its own severity vocabulary; the panel has three buckets.
const SEVERITY_ALIASES = Object.freeze({
  red: 'red', error: 'red', blocking: 'red',
  yellow: 'yellow', warn: 'yellow', warning: 'yellow',
  note: 'note', info: 'note', hint: 'note',
});

const SEVERITY_RANK = Object.freeze({ red: 0, yellow: 1, note: 2 });

// Only these target keys are passed through; anything else in the caller's target
// object is dropped, so the jump handler has a fixed contract.
const TARGET_KEYS = Object.freeze(['page', 'tab', 'itemId', 'nodeId', 'file']);

const SOURCE_FALLBACK = 'unknown';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A stable, injective identity for a group: (source, severity, code). JSON is used
// instead of a joined string so a source or code containing the separator can never
// make two different groups share a key.
function groupKey(source, severity, code) {
  return JSON.stringify([source, severity, code]);
}

// A source name that is missing, blank or not a string still needs a bucket — it
// lands under SOURCE_FALLBACK instead of being dropped (the finding is still real).
function sourceKeyOf(source) {
  if (typeof source === 'string' && source.trim() !== '') return source;
  if (source === undefined || source === null || source === '') return SOURCE_FALLBACK;
  return String(source);
}

function normaliseSeverity(value) {
  const alias = typeof value === 'string' ? SEVERITY_ALIASES[value.trim().toLowerCase()] : undefined;
  return alias || 'note';
}

// code → check → kind, first one that actually names something wins; a finding with
// no name at all still has to be listable, so it becomes UNCODED.
function normaliseCode(finding) {
  for (const key of ['code', 'check', 'kind']) {
    const value = finding[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return 'UNCODED';
}

// message → detail → text. The scene validator carries a human `message` AND a
// structured `detail` object; the pack/graph guards carry the human text in
// `detail`. Message wins, and whatever is found is coerced to a string so the
// panel can always render it.
function normaliseMessage(finding) {
  for (const key of ['message', 'detail', 'text']) {
    const value = finding[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isPlainObject(value) || Array.isArray(value)) {
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
  }
  return '';
}

function normaliseTarget(value) {
  const target = {};
  if (!isPlainObject(value)) return target;
  for (const key of TARGET_KEYS) {
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    target[key] = entry;
  }
  return target;
}

function normaliseFinding(finding) {
  if (!isPlainObject(finding)) return null;
  // `severity` wins; `level` is read when it is missing (or null/empty — present
  // but valueless counts as missing for every field this module reads).
  const declared = finding.severity;
  const severity = declared !== undefined && declared !== null && declared !== '' ? declared : finding.level;
  return {
    severity: normaliseSeverity(severity),
    code: normaliseCode(finding),
    message: normaliseMessage(finding),
    target: normaliseTarget(finding.target),
  };
}

// A full copy of a normalised record — shallow is enough because every value in it
// is either a primitive or the flat `target` object rebuilt here.
function copyFinding(finding) {
  return {
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    target: { ...finding.target },
  };
}

// red first, then the biggest group, then the code (so two groups of equal weight
// never swap places between runs). Node's Array#sort is stable, so the leftovers
// keep the order the sources were first set in.
function compareGroups(a, b) {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  if (b.count !== a.count) return b.count - a.count;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  return 0;
}

function createProblems() {
  const bySource = new Map(); // source → normalised findings, in first-set order
  const listeners = new Set();

  function get() {
    const sources = {};
    const counts = { red: 0, yellow: 0, note: 0, total: 0 };
    for (const [source, findings] of bySource) {
      const bySeverity = { red: 0, yellow: 0, note: 0 };
      for (const finding of findings) bySeverity[finding.severity] += 1;
      sources[source] = { count: findings.length, bySeverity };
      counts.red += bySeverity.red;
      counts.yellow += bySeverity.yellow;
      counts.note += bySeverity.note;
      counts.total += findings.length;
    }
    return { sources, counts, groups: buildGroups() };
  }

  // ONE group per (source, code, severity) — the 「按代码聚合」 behaviour.
  function buildGroups() {
    const groups = new Map();
    for (const [source, findings] of bySource) {
      for (const finding of findings) {
        const key = groupKey(source, finding.severity, finding.code);
        let group = groups.get(key);
        if (!group) {
          group = { key, code: finding.code, severity: finding.severity, source, count: 0, findings: [] };
          groups.set(key, group);
        }
        group.count += 1;
        group.findings.push(copyFinding(finding));
      }
    }
    return Array.from(groups.values()).sort(compareGroups);
  }

  // The same payload get() returns, after every mutation. A listener that throws is
  // inert: the panel it belongs to is broken, the store is not, and the listeners
  // queued after it still hear about the change.
  function notify() {
    if (listeners.size === 0) return;
    const payload = get();
    for (const listener of Array.from(listeners)) {
      try {
        listener(payload);
      } catch {
        // a broken panel must not break the store
      }
    }
  }

  // REPLACE one source's findings. A non-array `findings` (null, undefined, an
  // array-like object, anything) is an empty replacement — never a crash, and it
  // still removes whatever that source had before.
  function set(source, findings) {
    const list = Array.isArray(findings) ? findings : [];
    const normalised = [];
    for (const finding of list) {
      const entry = normaliseFinding(finding);
      if (entry) normalised.push(entry);
    }
    bySource.set(sourceKeyOf(source), normalised);
    notify();
    return get();
  }

  function clear(source = null) {
    if (source === null || source === undefined) bySource.clear();
    else bySource.delete(sourceKeyOf(source));
    notify();
    return get();
  }

  // What a status bar shows directly. `说明` only appears when there is something
  // to explain, so a clean-but-warned scene reads 「错误 0 · 提醒 12」.
  function summaryLine() {
    const { counts } = get();
    if (counts.total === 0) return '无问题';
    const parts = [`错误 ${counts.red}`, `提醒 ${counts.yellow}`];
    if (counts.note > 0) parts.push(`说明 ${counts.note}`);
    return parts.join(' · ');
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { set, get, clear, summaryLine, subscribe };
}

const wbProblemsApi = { createProblems, PROBLEM_SEVERITIES };
if (typeof window !== 'undefined') window.wbProblems = wbProblemsApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbProblemsApi;
