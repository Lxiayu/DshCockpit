// src/channels/allowlist.js — inbound sender admission for IM channels.
//
// Pairing mode (default): an EMPTY allowFrom list rejects everyone — unknown
// chat/user ids must be admitted from the desktop first (C6 adds the pairing
// card; the skeleton stays closed by default). A non-empty list admits exact
// ids, `prefix*` wildcards, and the `*` catch-all (open mode, opt-in).
'use strict';

/** @param {string[]} allowFrom per-channel whitelist entries
 *  @param {string} senderId the platform user/chat id asking in */
function isAllowed(allowFrom, senderId) {
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) return false;
  const id = String(senderId || '');
  if (!id) return false;
  return allowFrom.some((entry) => {
    const e = String(entry || '').trim();
    if (!e) return false;
    if (e === '*') return true;
    if (e === id) return true;
    if (e.endsWith('*')) return id.startsWith(e.slice(0, -1));
    return false;
  });
}

/** Normalize a user-edited whitelist (textarea, comma/newline separated). */
function parseAllowFrom(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;\n]+/);
  const out = [];
  for (const e of raw) {
    const v = String(e || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 100); // sanity ceiling; a channel card is human-edited
}

module.exports = { isAllowed, parseAllowFrom };
