// src/runtime-pick.js — H5 runtime candidate priority (pure decision logic).
//
// After the upstream 0.1.1 credential-format change, a system-installed dsh
// is most likely the WRITER of ~/.dsh and understands its data layout, so the
// shell must prefer it over its own (possibly older) bundled seed whenever it
// is at least as new. Priority:
//   1. active pointer entry (already smoke-tested when activated)
//   2. system dsh (discovered on PATH) — when version >= bundled seed version
//   3. bundled seed (installer) — fallback for older/absent system installs
// Every non-active candidate must pass the caller-provided smoke guard
// (RuntimeManager.smokeTest) before it can win; a failing candidate falls
// through to the next one. Never throws.
'use strict';

const semver = require('semver');

/** Normalized sort key: valid semvers compare by semver, junk sorts last. */
function versionKey(version) {
  const coerced = semver.valid(String(version || '')) ? String(version) : (semver.coerce(String(version || '')) || null);
  return coerced;
}

/**
 * @param {object} deps
 * @param {object|null} deps.active   live active-pointer candidate {version, path}
 * @param {object|null} deps.system   discovered system candidate {version, path}
 * @param {object|null} deps.bundled  installer seed candidate {version, path}
 * @param {(cand: object) => Promise<boolean>} deps.smoke  guard for non-active candidates
 * @returns {Promise<{choice: 'active'|'system'|'bundled', candidate: object}|null>}
 */
async function pickRuntimeCandidate({ active = null, system = null, bundled = null, smoke }) {
  if (active && active.path) return { choice: 'active', candidate: active };
  const candidates = [];
  if (system && system.path) candidates.push({ choice: 'system', candidate: system });
  if (bundled && bundled.path) candidates.push({ choice: 'bundled', candidate: bundled });
  // newest first; unparseable versions sort last; ties keep the documented
  // order (system before bundled)
  candidates.sort((a, b) => {
    const ka = versionKey(a.candidate.version);
    const kb = versionKey(b.candidate.version);
    if (ka && kb) {
      if (!semver.eq(ka, kb)) return semver.rcompare(ka, kb);
      return a.choice === 'system' ? -1 : 1;
    }
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    return a.choice === 'system' ? -1 : 1;
  });
  for (const c of candidates) {
    try {
      if (await smoke(c.candidate)) return c;
    } catch { /* a throwing smoke counts as failed */ }
  }
  return null;
}

module.exports = { pickRuntimeCandidate, versionKey };
