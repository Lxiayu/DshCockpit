// src/channels/one-shot-tokens.js — one-shot tokens for IM approval/question
// callbacks (C5 skeleton).
//
// Every approval / question card carries a token minted here: crypto-random,
// single-use (redeem deletes it — a replayed callback reads as `unknown`),
// TTL 120s (dsh-overdrive / Claude Code Telegram bot convention). Tokens and
// payloads never enter logs; the audit trail records ids/reasons only.
'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 120 * 1000;
const TOKEN_BYTES = 16; // 32 hex chars

class OneShotTokens {
  /**
   * @param {{ ttlMs?: number, now?: () => number }} opts `now` is injectable
   *        so expiry is unit-testable without wall-clock sleeps.
   */
  constructor(opts = {}) {
    this.ttlMs = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
    this.now = opts.now || (() => Date.now());
    this.tokens = new Map(); // token -> { payload, expiresAt }
  }

  /** Mint a fresh token bound to `payload` (opaque to this class). */
  issue(payload) {
    this.prune();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    this.tokens.set(token, { payload, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * Consume a token exactly once.
   * @returns {{ ok: true, payload } | { ok: false, reason: 'unknown' | 'expired' }}
   *          `unknown` covers both never-issued and already-used tokens —
   *          burned-on-redeem means a replay is indistinguishable from a
   *          forgery, which is exactly the property we want.
   */
  redeem(token) {
    const key = String(token || '');
    const rec = this.tokens.get(key);
    if (!rec) return { ok: false, reason: 'unknown' };
    this.tokens.delete(key); // single-use: burn on redeem, success or not
    if (rec.expiresAt < this.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload: rec.payload };
  }

  /** Drop expired entries (called on issue; cheap at card-rate volumes). */
  prune() {
    const now = this.now();
    for (const [k, v] of this.tokens) {
      if (v.expiresAt < now) this.tokens.delete(k);
    }
  }

  get size() {
    this.prune();
    return this.tokens.size;
  }
}

module.exports = { OneShotTokens, DEFAULT_TTL_MS };
