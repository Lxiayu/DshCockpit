'use strict';

// src/office/runtime/subagent-classifier.js — subagent seat classification.
//
// Pure CommonJS: no Electron/Pixi/DOM/fs/network/Harness import, no clock, no
// randomness, no LLM call, no I/O. A deterministic table lookup over the
// STRUCTURED metadata a Harness subagent carries on its parent journal:
//
//   - label: a short display label. For a `subagent`-tool child the Harness
//     freezes the model-authored `description`; for a workflow child it is the
//     script's `label` (or the first prompt line, bounded to 48 chars by the
//     Harness). It is a bounded metadata field, NOT the task body.
//   - phase: an optional workflow phase title (same provenance as label).
//   - mode:  'one-shot' | 'continuable' (the catalog descriptor mode).
//   - provider: an optional provider id when the parent journal carries one.
//
// Design stance (deliberately conservative, fail-closed to collaborator):
//   - Only structured metadata is consulted; the subagent's prompt/task BODY is
//     never inspected, and no PII-level analysis of any text is performed. The
//     label/phase strings are matched against a fixed keyword table only.
//   - First matching ROLE in a fixed precedence order wins. Precedence is
//     explicit and documented (reviewer > coder > researcher) so a label like
//     "review the code" lands on reviewer, not on an accidental tie.
//   - Word-boundary matching for ASCII keywords avoids substring false
//     positives ("coder" never matches "encode", "fix" never matches "prefix").
//   - Anything unmatched, empty, non-string, over the length cap, or malformed
//     resolves to `collaborator` — the documented single-FIFO contract for
//     unclassified subagents. `orchestrator` is NEVER returned: a subagent is
//     by construction not the root scheduler, so its seat is one of the three
//     resident work seats or the collaborator seat.
//   - `mode` / `provider` are accepted inputs but never select a seat on their
//     own (a one-shot child is not "therefore" a coder); they are recorded for
//     diagnostics only. This keeps the classifier explainable: the only seat
//     signal is the bounded label/phase keyword table.

const COLLABORATOR_ID = 'collaborator';

// Label/phase longer than this is treated as unusable prose metadata and is
// never scanned (bounded work, bounded false-positive surface).
const LABEL_CHAR_CAP = 240;

// Fixed precedence order. Every entry: [seat, [ascii keywords...], [cjk
// keywords...]]. The FIRST entry with any match wins (so reviewer beats
// coder beats researcher on an ambiguous label like "review the code").
const RULES = Object.freeze([
  Object.freeze({
    seat: 'reviewer',
    rule: 'review',
    ascii: ['review', 'reviewer', 'reviewing', 'audit', 'verify', 'verification', 'inspect', 'inspection', 'critique', 'qa', 'validation', 'validate'],
    cjk: ['评审', '审核', '审查', '复核', '校验', '检验', '验收'],
  }),
  Object.freeze({
    seat: 'coder',
    rule: 'code',
    ascii: ['code', 'coder', 'coding', 'implement', 'implementation', 'implementing', 'refactor', 'refactoring', 'fix', 'bugfix', 'patch', 'develop', 'developer', 'build', 'script', 'compile', 'debug'],
    cjk: ['编码', '代码', '实现', '编写', '修复', '重构', '编译', '调试', '脚本', '开发'],
  }),
  Object.freeze({
    seat: 'researcher',
    rule: 'research',
    ascii: ['research', 'researcher', 'investigate', 'investigation', 'explore', 'exploration', 'survey', 'gather', 'collect', 'analysis', 'analyze', 'analyse', 'search'],
    cjk: ['调研', '研究', '调查', '检索', '搜集', '收集', '资料', '分析', '查找', '探索'],
  }),
]);

// Coarse enum whitelist so downstream privacy redaction keeps the seat value.
const CLASSIFIED_SEATS = Object.freeze(['researcher', 'coder', 'reviewer']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > LABEL_CHAR_CAP) return null;
  return trimmed;
}

// ASCII keyword match on word boundaries: a keyword never matches inside a
// longer alphanumeric run, so `fix` does not match `prefix` and `code` does not
// match `barcode`. Both sides are lower-cased; the label is bounded first.
function matchesAscii(haystackLower, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystackLower);
}

function matchesRule(text, rule) {
  const lower = text.toLowerCase();
  for (const keyword of rule.ascii) {
    if (matchesAscii(lower, keyword)) return true;
  }
  for (const keyword of rule.cjk) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

/**
 * Classify one subagent to a seat from structured metadata only.
 *
 * @param {object} input - { label?, phase?, mode?, provider? } (all optional).
 * @returns {Readonly<{employeeId: string, classified: boolean, rule: string|null, mode: string|null}>}
 *   `employeeId` is a resident work seat ('researcher'|'coder'|'reviewer') or
 *   the collaborator seat; `classified` is true only for the former; `rule`
 *   names the matched table row (or null); `mode` echoes the coarse mode.
 */
function classifySubagent(input) {
  const source = isPlainObject(input) ? input : {};
  const mode = source.mode === 'one-shot' || source.mode === 'continuable' ? source.mode : null;
  // The label is the primary signal; the workflow phase title is a secondary
  // one consulted only when no label is usable. Never the task body.
  const label = normalizeText(source.label);
  const phase = normalizeText(source.phase);
  const text = label || phase;
  if (text) {
    for (const rule of RULES) {
      if (matchesRule(text, rule)) {
        return Object.freeze({
          employeeId: rule.seat,
          classified: true,
          rule: rule.rule,
          mode,
        });
      }
    }
  }
  return Object.freeze({
    employeeId: COLLABORATOR_ID,
    classified: false,
    rule: null,
    mode,
  });
}

module.exports = {
  classifySubagent,
  CLASSIFIED_SEATS,
  RULES,
  LABEL_CHAR_CAP,
};
