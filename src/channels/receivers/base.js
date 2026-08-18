// src/channels/receivers/base.js — inbound command dispatcher (C5 skeleton).
//
// Inbound protocol v1 — every platform adapter (C6) parses its native
// callback/message into one of these commands and hands it to dispatch():
//
//   { type: 'approve', token }          approval card button / reply command
//   { type: 'deny',    token }          ditto, refused
//   { type: 'answer',  token, text }    question card reply
//   { type: 'text',    text }           free text → headless session (sticky)
//
// Admission runs BEFORE token redemption: the per-channel allowFrom list is
// checked first (pairing mode default = empty list = reject), so an
// unpaired sender cannot even burn a leaked token. Free text routes to the
// shared headless runner with per (channel, sender) session stickiness —
// the mapping persists so follow-up messages land in the same session.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('../../i18n');

// ------------------------------------------------------- session bindings

/**
 * Sticky `channel:senderId → sessionId` map, persisted as JSON so IM threads
 * keep their background session across shell restarts. Session ids are local
 * opaque handles (C6 wires them to dsh --resume style continuation).
 */
class SessionBindings {
  constructor(file) {
    this.file = file;
    this.map = new Map(); // 'channel:sender' -> { sessionId, updatedAt }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && typeof v.sessionId === 'string') this.map.set(k, { sessionId: v.sessionId, updatedAt: v.updatedAt || 0 });
      }
    } catch { /* first run */ }
  }

  key(channelId, senderId) { return `${channelId}:${senderId}`; }

  /** Existing session id, or a newly minted persisted one. */
  ensure(channelId, senderId) {
    const key = this.key(channelId, senderId);
    let rec = this.map.get(key);
    if (!rec) {
      rec = { sessionId: `ch-${crypto.randomBytes(8).toString('hex')}`, updatedAt: Date.now() };
      this.map.set(key, rec);
      this.save();
    }
    return rec.sessionId;
  }

  /** @returns {string|null} the session id when a binding exists. */
  get(channelId, senderId) {
    const rec = this.map.get(this.key(channelId, senderId));
    return rec ? rec.sessionId : null;
  }

  touch(channelId, senderId) {
    const rec = this.map.get(this.key(channelId, senderId));
    if (!rec) return;
    rec.updatedAt = Date.now();
    this.save();
  }

  save() {
    try {
      const out = {};
      for (const [k, v] of this.map) out[k] = v;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* best-effort: stickiness degrades to fresh sessions */ }
  }
}

// ------------------------------------------------------------ dispatcher

/**
 * @param {object} deps
 *   tokens: OneShotTokens            — approval/question token mint/redeem
 *   isAllowed(allowFrom, senderId)   — admission check (allowlist.js)
 *   runPrompt({channelId, senderId, text, sessionId}) → {ok, output, durationMs}
 *   onApprovalDecision({decision, tool})  → {ok, reason?}  (main-process hook)
 *   onQuestionAnswer({text})              → {ok, reason?}  (main-process hook)
 *   lang()                           — resolved UI language for replies
 *   audit(rec)                       — audit sink (no tokens/secrets inside)
 */
function createCommandDispatcher(deps) {
  const d = deps || {};
  const audit = d.audit || (() => {});

  async function dispatch({ channelId, senderId, allowFrom, command }) {
    const lang = d.lang ? d.lang() : 'zh';
    if (!command || typeof command !== 'object') {
      return { ok: false, reply: t(lang, 'channels.rx.badCommand') };
    }
    if (!d.isAllowed(allowFrom, senderId)) {
      audit({ action: 'reject', reason: 'not-in-allowlist', channelId, senderId });
      return { ok: false, reply: t(lang, 'channels.rx.notAllowed') };
    }

    // ---- approval callbacks (one-shot token, burned on first use)
    if (command.type === 'approve' || command.type === 'deny') {
      const r = d.tokens.redeem(command.token);
      if (!r.ok) {
        audit({ action: 'reject', reason: `token-${r.reason}`, channelId, senderId });
        return { ok: false, reply: t(lang, r.reason === 'expired' ? 'channels.rx.tokenExpired' : 'channels.rx.tokenInvalid') };
      }
      const tool = r.payload && r.payload.tool ? r.payload.tool : '';
      // full payload rides along: C6 hooks answer the runtime's
      // POST /api/respond with the rpcId/sessionId/approvalId it carries
      const handled = d.onApprovalDecision ? d.onApprovalDecision({ decision: command.type, tool, payload: r.payload }) : { ok: false, reason: 'no-hook' };
      audit({ action: 'approval', decision: command.type, channelId, senderId, ok: handled.ok });
      if (handled && handled.ok) {
        return { ok: true, reply: t(lang, command.type === 'approve' ? 'channels.rx.approved' : 'channels.rx.denied') };
      }
      return { ok: false, reply: t(lang, 'channels.rx.hookFailed', { reason: (handled && handled.reason) || '' }) };
    }

    // ---- question answers (one-shot token)
    if (command.type === 'answer') {
      const r = d.tokens.redeem(command.token);
      if (!r.ok) {
        audit({ action: 'reject', reason: `token-${r.reason}`, channelId, senderId });
        return { ok: false, reply: t(lang, r.reason === 'expired' ? 'channels.rx.tokenExpired' : 'channels.rx.tokenInvalid') };
      }
      const handled = d.onQuestionAnswer ? d.onQuestionAnswer({ text: String(command.text || ''), payload: r.payload }) : { ok: false, reason: 'no-hook' };
      audit({ action: 'answer', channelId, senderId, ok: handled.ok });
      if (handled && handled.ok) return { ok: true, reply: t(lang, 'channels.rx.answerAccepted') };
      return { ok: false, reply: t(lang, 'channels.rx.hookFailed', { reason: (handled && handled.reason) || '' }) };
    }

    // ---- free text → sticky headless session
    if (command.type === 'text') {
      const text = String(command.text || '').trim();
      if (!text) return { ok: false, reply: t(lang, 'channels.rx.badCommand') };
      const sessionId = d.sessions.ensure(channelId, senderId);
      audit({ action: 'prompt', channelId, senderId, sessionId });
      let result;
      try {
        result = await d.runPrompt({ channelId, senderId, text, sessionId });
      } catch (e) {
        result = { ok: false, output: e.message, durationMs: 0 };
      }
      d.sessions.touch(channelId, senderId);
      const summary = String(result.output || '').slice(0, 600);
      return {
        ok: result.ok,
        reply: t(lang, 'channels.rx.promptDone', {
          ok: result.ok ? '✓' : '✗',
          sec: Math.max(1, Math.round((result.durationMs || 0) / 1000)),
          summary,
        }),
      };
    }

    return { ok: false, reply: t(lang, 'channels.rx.badCommand') };
  }

  return { dispatch };
}

// ------------------------------------------------------- text command parse

const COMMAND_WORDS = {
  approve: 'approve', deny: 'deny', answer: 'answer',
  批准: 'approve', 拒绝: 'deny', 回答: 'answer',
};

/**
 * Parse a raw IM text into an inbound v1 command. Text-command fallback is
 * how text-only transports (DingTalk, card-less replies) drive approvals:
 *   "approve <token>" / "deny <token>" / "answer <token> <text>" (中文等价：
 *   批准/拒绝/回答). Anything else is free text → the sticky headless session.
 * @returns {{type:'approve'|'deny', token} | {type:'answer', token, text} |
 *           {type:'text', text} | null}
 */
function parseCommandText(text) {
  const s = String(text || '').replace(/@[^\s@]+\s?/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/^(approve|deny|answer|批准|拒绝|回答)[\s:：]+([0-9a-f]{16,64})(?:[\s:：]+([\s\S]+))?$/i);
  if (!m) return { type: 'text', text: s };
  const cmd = COMMAND_WORDS[m[1].toLowerCase()] || COMMAND_WORDS[m[1]];
  if (cmd === 'answer') {
    if (!m[3] || !m[3].trim()) return { type: 'text', text: s }; // answer needs a payload
    return { type: 'answer', token: m[2], text: m[3].trim() };
  }
  return { type: cmd, token: m[2] };
}

/** Card/button callback payload ({action, token}) → inbound v1 command. */
function commandFromCardAction(value) {
  const v = value || {};
  const action = String(v.action || '');
  const token = String(v.token || '');
  if (!token || (action !== 'approve' && action !== 'deny' && action !== 'answer')) return null;
  if (action === 'answer' && !v.text) return null; // answers need text; card body explains the reply command
  return action === 'answer'
    ? { type: 'answer', token, text: String(v.text) }
    : { type: action, token };
}

module.exports = {
  SessionBindings,
  createCommandDispatcher,
  parseCommandText,
  commandFromCardAction,
};
