// src/session-files.js — generation-aware session log discovery (session format V3).
//
// dsh-session-persistence-jsonl keeps immutable generations side by side inside
// each session directory (dsh 0.1.5 / session format V3):
//
//   session.jsonl[.zstd]      released v0 (no version infix)
//   session.v1.jsonl[.zstd]   released v1
//   session.v2.jsonl[.zstd]   released v2
//   session.v3.jsonl[.zstd]   current generation
//
// The runtime reads the HIGHEST numeric generation; older generations are kept
// byte-for-byte (the migration writes a sibling file, it never rewrites the
// source). Readers that hardcode `session.jsonl.zstd` therefore read a stale
// generation — or nothing at all for a v3-only session — and readers that sum
// every generation double-count. Exactly one file per session directory is the
// contract; this module is the single place that implements it.
'use strict';

/** Session log names: session[.vN].jsonl[.zstd] — v0 carries no version infix.
 * Only canonical names count: `session.v0.*` (version-zero-tagged), uppercase
 * and leading-zero tags, and the backend's same-directory temp files are all
 * non-canonical by design (see dsh-session-persistence-jsonl format helpers). */
const SESSION_FILE_RE = /^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$/;

/** Generation number of a file name, or null when it is not a session log. */
function generationOf(name) {
  const m = SESSION_FILE_RE.exec(String(name || ''));
  if (!m) return null;
  return m[1] === undefined ? 0 : Number(m[1]);
}

/**
 * Newest-generation session log among `names` (basenames), or null.
 * One root holds one encoding, so both encodings of the same generation should
 * never coexist; zstd still wins if a directory ever contains both.
 */
function pickSessionFile(names) {
  let best = null;
  let bestGen = -1;
  for (const name of Array.isArray(names) ? names : []) {
    const gen = generationOf(name);
    if (gen === null) continue;
    const isZstd = String(name).endsWith('.zstd');
    const bestIsZstd = !!(best && String(best).endsWith('.zstd'));
    if (gen > bestGen || (gen === bestGen && isZstd && !bestIsZstd)) {
      best = name;
      bestGen = gen;
    }
  }
  return best;
}

module.exports = { SESSION_FILE_RE, generationOf, pickSessionFile };
