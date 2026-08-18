// src/channels/credentials.js — safeStorage vault for channel secrets.
//
// Same范式 as remote-control's TokenStore / models-manager's KeyVault (the
// shared pattern was kept local to avoid touching stable modules in C5):
// { channelId: base64(ciphertext) } in one JSON file under userData, atomic
// writes, `plain:`-prefixed base64 fallback when safeStorage is unavailable
// (logged once, never silent). Secrets never enter settings.json, backups
// or logs — status surfaces only booleans.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

class ChannelSecrets {
  /**
   * @param {string} file e.g. <userData>/channel-secrets.json
   * @param {object|null} safeStorage electron safeStorage (nullable in tests)
   * @param {(line: string) => void} log
   */
  constructor(file, safeStorage, log) {
    this.file = file;
    this.safeStorage = safeStorage || null;
    this.log = log || (() => {});
    this.warned = false;
    this.map = new Map(); // channelId -> Buffer (ciphertext or plain:-prefixed)
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.map.set(k, Buffer.from(String(v), 'base64'));
      // legacy file written before the 0600 rule: tighten on the read path
      // (best effort — never block secrets loading on a chmod failure)
      try { fs.chmodSync(file, 0o600); } catch { /* win: no-op */ }
    } catch { /* first run */ }
  }

  usable() {
    try {
      return !!this.safeStorage && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function'
        && (typeof this.safeStorage.isEncryptionAvailable !== 'function' || this.safeStorage.isEncryptionAvailable());
    } catch { return false; }
  }

  encode(plain) {
    if (this.usable()) return this.safeStorage.encryptString(plain);
    if (!this.warned) {
      this.warned = true;
      this.log('[channels] safeStorage unavailable; channel secrets stored base64-obfuscated only');
    }
    return Buffer.concat([Buffer.from('plain:', 'utf8'), Buffer.from(plain, 'utf8')]);
  }

  decode(buf) {
    try {
      const s = buf.toString('utf8');
      if (s.startsWith('plain:')) return s.slice(6);
      if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
        return this.safeStorage.decryptString(buf);
      }
    } catch { /* fall through */ }
    return null;
  }

  persist() {
    const out = {};
    for (const [k, v] of this.map) out[k] = v.toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // 0600 like .credentials.yaml: without safeStorage this file holds the
    // channel secrets in a merely base64-obfuscated form.
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* win: no-op */ }
    fs.renameSync(tmp, this.file);
  }

  /** Store (or replace) one channel's secret. Value never appears in logs. */
  set(channelId, secret) {
    this.map.set(String(channelId), this.encode(String(secret)));
    this.persist();
  }

  /** @returns {string|null} the decrypted secret, or null when absent/undecodable. */
  get(channelId) {
    const buf = this.map.get(String(channelId));
    return buf ? this.decode(buf) : null;
  }

  has(channelId) { return this.map.has(String(channelId)); }

  remove(channelId) {
    if (!this.map.delete(String(channelId))) return;
    this.persist();
  }
}

module.exports = { ChannelSecrets };
