'use strict';

// src/workbench/lib/pack-json.js — canonical pack JSON serialization (M1).
//
// The publish kernel rewrites resources/characters/deepseek-default/
// animation/{animations,anchors}.json. The hard contract: "仅对应动作条目；
// 其余动作逐字不动" — entries the editor never touched must stay BYTE-identical
// on disk. That only holds if the rewritten file uses the exact canonical form
// the pack pipeline already emits (scripts/office-assets/normalize-passing-
// frame.py → json.dumps(reorder_for_pack(doc), indent=2) + "\n"):
//
// - every OBJECT MAP is dumped with recursively SORTED keys, EXCEPT one:
//   anchors.json's top-level "frames" map, whose keys are the walk-frame files
//   in the animations.json METADATA order (the E5a-R1 lock — a sorted dump
//   would append "passing" after "04", the lexicographic trap);
// - indent 2, "key": value separators, trailing newline added by the caller;
// - numbers via the JS shortest round-trip form (identical to Python's repr
//   for every value in the pack), strings via JSON escaping.
//
// The self-check test (office-asset-runtime "M1 pack serializer") proves both
// committed pack files round-trip byte-identically through this serializer.

const PRESERVED_MAP_PATHS = Object.freeze(['frames']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function walk(value, depth, path) {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item, index) => `${indent}  ${walk(item, depth + 1, `${path}[${index}]`)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    // The ONLY insertion-ordered map is the anchors frames map (E5a-R1);
    // every other map sorts recursively. Array elements keep their array
    // order (the frame SEQUENCE lives in arrays — never sorted).
    const ordered = PRESERVED_MAP_PATHS.includes(path) ? keys : keys.slice().sort();
    const entries = ordered.map((key) => `${indent}  ${JSON.stringify(key)}: ${walk(value[key], depth + 1, path.length ? `${path}.${key}` : key)}`);
    return `{\n${entries.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

// canonicalPackJson(value) -> string WITHOUT the trailing newline
function canonicalPackJson(value) {
  return walk(value, 0, '');
}

module.exports = { canonicalPackJson, PRESERVED_MAP_PATHS };
