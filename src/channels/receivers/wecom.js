// src/channels/receivers/wecom.js — WeCom AI-Bot channel (C6).
//
// Wraps the official @wecom/aibot-node-sdk WSClient behind the
// channel-manager implementation contract. The SDK owns the WebSocket:
// connect() dials, authenticates (botId+secret), heartbeats and retries —
// we map its events onto our hooks:
//
//   message.text            → parseCommandText() → hooks.onInbound
//   event.template_card_event (event_key = our {action, token} JSON)
//                           → commandFromCardAction() → hooks.onInbound
//   disconnected            → hooks.notifyDisconnect (manager backoff loop)
//
// Outbound goes through the SDK's主动发送 channel sendMessage(chatid, …):
// markdown for text (20KB budget vs text's tighter limits) and
// button_interaction template cards from buildWecomCard(). The reply target
// is the chat/user the most recent inbound message came from (chatid for
// groups, from.userid for DMs — per SDK doc).
'use strict';

const { buildWecomCard, parseWecomEventKey } = require('../senders/wecom');
const { parseCommandText, commandFromCardAction } = require('./base');

const QUIET_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };
const AUTH_TIMEOUT_MS = 15_000;

/** Inbound SDK text frame body → {senderId, replyTo, command} | null. */
function parseWecomMessage(body) {
  if (!body || body.msgtype !== 'text' || !body.text) return null;
  const senderId = (body.from && body.from.userid) || '';
  const command = parseCommandText(body.text.content);
  if (!command) return null;
  return { senderId, replyTo: body.chatid || senderId, command };
}

/** Inbound template_card_event body → {senderId, replyTo, command} | null. */
function parseWecomCardEvent(body) {
  const ev = body && body.event;
  if (!ev || ev.eventtype !== 'template_card_event') return null;
  const action = parseWecomEventKey(ev.event_key);
  if (!action) return null;
  const command = commandFromCardAction(action);
  if (!command) return null;
  const senderId = (body.from && body.from.userid) || '';
  return { senderId, replyTo: body.chatid || senderId, command };
}

/**
 * WeCom channel per the manager contract. `deps` (tests only):
 * { sdk } — the @wecom/aibot-node-sdk module (or a stub).
 */
class WecomChannel {
  constructor({ id, type, config, secrets, log, hooks, deps } = {}) {
    this.id = id || 'wecom';
    this.type = type || 'wecom';
    this.config = config || {};
    this.secrets = secrets;
    this.log = log || (() => {});
    this.hooks = hooks || {};
    const injected = deps || {};
    this.sdk = injected.sdk || require('@wecom/aibot-node-sdk');
    this.supportsCards = true;

    this.client = null;
    this.replyTo = null; // sticky chatid/userid of the last inbound message
    this.stopped = false;
  }

  /** @private secrets JSON string → { botId, secret } | null */
  readCredentials() {
    let raw = null;
    try { raw = this.secrets ? this.secrets.get(this.id) : null; } catch { /* vault unreadable */ }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.botId && obj.secret) return { botId: String(obj.botId), secret: String(obj.secret) };
    } catch { /* malformed JSON */ }
    return null;
  }

  async start() {
    this.stopped = false;
    const creds = this.readCredentials();
    if (!creds) throw new Error('wecom: credentials missing (configure bot id/secret first)');
    const client = new this.sdk.WSClient({ botId: creds.botId, secret: creds.secret, logger: QUIET_LOGGER });
    this.client = client;

    const up = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wecom: authenticate timeout')), AUTH_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      client.once('authenticated', () => { clearTimeout(timer); resolve(); });
      client.once('disconnected', (reason) => {
        clearTimeout(timer);
        reject(new Error(`wecom: ${String(reason || 'connection closed during auth')}`));
      });
      try { client.connect(); } catch (e) { clearTimeout(timer); reject(e); }
    });

    // 'disconnected' after auth → manager reconnect loop. The SDK retries
    // internally too; we still report so state + offline queue react.
    client.on('disconnected', (reason) => {
      this.log(`[channels] wecom disconnected (${String(reason || 'unknown')})`);
      if (!this.stopped && this.hooks && typeof this.hooks.notifyDisconnect === 'function') {
        this.hooks.notifyDisconnect(this.id);
      }
    });

    client.on('message.text', (frame) => {
      const parsed = parseWecomMessage(frame && frame.body);
      if (!parsed) return;
      this.deliverInbound('message', parsed);
    });

    client.on('event.template_card_event', (frame) => {
      const parsed = parseWecomCardEvent(frame && frame.body);
      if (!parsed) return;
      this.deliverInbound('card', parsed);
    });

    this.log('[channels] wecom authenticated');
    return up;
  }

  /** @private shared inbound path for both message and card events. */
  deliverInbound(kind, parsed) {
    if (parsed.replyTo) this.replyTo = parsed.replyTo;
    const senderId = parsed.senderId || 'unknown';
    this.log(`[channels] wecom inbound ${kind} from ${senderId}`);
    if (this.hooks && typeof this.hooks.onInbound === 'function') {
      try { this.hooks.onInbound({ channelId: this.id, senderId, command: parsed.command }); }
      catch (e) { this.log(`[channels] wecom onInbound error: ${e.message}`); }
    }
  }

  async stop() {
    this.stopped = true;
    if (this.client) {
      try { this.client.disconnect(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  // ---------------------------------------------------- transport surface

  assertReady() {
    if (!this.client || !this.replyTo) throw new Error('wecom: no active chat to reply to');
  }

  async sendText(text) {
    this.assertReady();
    // markdown buys a 20KB budget vs 'text'; content is plain either way
    return this.client.sendMessage(this.replyTo, {
      msgtype: 'markdown',
      markdown: { content: String(text || '') },
    });
  }

  async sendCard(card) {
    this.assertReady();
    return this.client.sendMessage(this.replyTo, {
      msgtype: 'template_card',
      template_card: buildWecomCard(card),
    });
  }
}

module.exports = { WecomChannel, parseWecomMessage, parseWecomCardEvent };
