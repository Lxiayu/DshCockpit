'use strict';

// studio/lib/scan.js — the export-boundary secret scan.
//
// 铁律 (brief §10.3): 密钥绝不入库/入日志/入导出物. Anything the studio is about
// to write — a .dshpack, a diagnostics bundle, a provenance record, a report —
// goes through this scan first, and a hit fails the write instead of leaking.
//
// The scan is shape-based on purpose: it never needs the key's value, so it can
// run on arbitrary text. Hits are reported as FINGERPRINTS (first 4 chars +
// length + sha256 prefix) so a report about a leak is not itself a leak.

const crypto = require('node:crypto');

// Placeholders that must not trip the scan (docs, tests, provider templates).
const PLACEHOLDER_HINTS = [
  'PLACEHOLDER', 'REDACTED', 'EXAMPLE', 'YOUR_KEY', 'YOUR-KEY', 'CHANGEME',
  'XXXX', '****', '<', '…', '...', 'test-', 'TEST_', 'dummy', 'DUMMY', 'sample',
];

const SECRET_SHAPES = [
  { code: 'SECRET_SK_PREFIX', pattern: /\bsk-[A-Za-z0-9_-]{8,}/g },
  { code: 'SECRET_BEARER_HEADER', pattern: /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}/g },
  // `\b` covers a query parameter AND a bare assignment (`token=…` in a log line or a
  // bubble) — the earlier pattern required a leading ? & space or quote and missed the
  // plain form (found by the corpus guard test)
  { code: 'SECRET_TOKEN_PARAM', pattern: /\btoken=([A-Za-z0-9._\-+/=]{8,})/g },
  { code: 'SECRET_COOKIE_HEADER', pattern: /\bcookie\s*[:=]\s*["']?[A-Za-z0-9._\-+/=%]{12,}/gi },
  { code: 'SECRET_KEY_ASSIGNMENT', pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*["']([^"']{12,})["']/gi },
  { code: 'SECRET_AUTH_HEADER', pattern: /\b(?:x-api-key|authorization)\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{12,}/gi },
];

function isPlaceholder(value) {
  const upper = String(value).toUpperCase();
  return PLACEHOLDER_HINTS.some((hint) => upper.includes(hint.toUpperCase()));
}

// A fingerprint identifies a secret without disclosing it:
// 'sk-a' + length + 12 hex chars of the sha256.
function fingerprint(value) {
  const text = String(value);
  const sha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
  const head = text.length >= 4 ? text.slice(0, 4) : 'x'.repeat(text.length);
  return `${head}…len=${text.length}sha=${sha}`;
}

function scanForSecrets(text) {
  const source = typeof text === 'string' ? text : String(text);
  const hits = [];
  for (const shape of SECRET_SHAPES) {
    shape.pattern.lastIndex = 0;
    let match;
    while ((match = shape.pattern.exec(source)) !== null) {
      const value = match[1] || match[0];
      if (isPlaceholder(value)) continue;
      hits.push({
        code: shape.code,
        index: match.index,
        // never the value itself — a leak report must not leak
        fingerprint: fingerprint(value),
      });
      if (match[0].length === 0) shape.pattern.lastIndex += 1; // defensive: no zero-width loop
    }
  }
  return { ok: hits.length === 0, hits, scannedBytes: source.length };
}

// Throwing form for write paths: refuse to write when a shape is found.
function assertNoSecrets(text, label) {
  const outcome = scanForSecrets(text);
  if (outcome.ok) return outcome;
  const codes = [...new Set(outcome.hits.map((hit) => hit.code))].join(',');
  const error = new Error(
    `SECRET_SHAPE_REFUSED ${label}: ${outcome.hits.length} hit(s) [${codes}] ` +
    outcome.hits.map((hit) => hit.fingerprint).join(' ')
  );
  error.code = 'SECRET_SHAPE_REFUSED';
  error.hits = outcome.hits;
  throw error;
}

module.exports = { SECRET_SHAPES, PLACEHOLDER_HINTS, fingerprint, scanForSecrets, assertNoSecrets };
