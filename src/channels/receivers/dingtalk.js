// src/channels/receivers/dingtalk.js — DingTalk Stream Mode channel (C6).
//
// Self-written protocol layer over the official Stream spec (no Node SDK
// exists; Python dingtalk-stream / Java app-stream-client are the reference
// implementations). Wire shape is JSON text frames on one WebSocket:
//
//   1. POST /v1.0/gateway/connections/open (clientId/Secret + subscriptions)
//      → { endpoint, ticket } — ticket is one-shot, 90s TTL, never stored
//   2. wss connect endpoint?ticket=…
//   3. server frames → route by payload:
//        payload.data === 'ping'              → mirror a 'pong' frame
//        topic /v1.0/im/bot/messages/get      → ACK + bot message (text;
//        sessionWebhook inside becomes the reply channel; group traffic
//        arrives @-prefixed → parseCommandText strips mentions)
//        topic /v1.0/card/instances/callback  → ACK + card button callback
//        (value = our {action, token} JSON when a card plugin sends one)
//   4. every routed frame is ACKed immediately ({code:'SUCCESS'} reply with
//      the original requestId/messageId) — the gate retries un-ACKed frames
//   5. close/error → hooks.notifyDisconnect → manager backoff loop
//
// Transport: the Node built-in WebSocket (WHATWG API, stable since Node 22 /
// Electron 37 main) — same choice as src/runtime-events.js; the `ws` npm
// package stays undeclared (only the official WeCom SDK pulls it).
//
// Outbound: markdown via sessionWebhook (senders/dingtalk.js). Buttons would
// need a public callback — per plan they degrade to command text, so
// supportsCards is false and the formatter's text shape (reply-instruction
// with the one-shot token) is what users see.
'use strict';

const crypto = require('node:crypto');
const {
  openGatewayConnection,
  sendViaSessionWebhook,
} = require('../senders/dingtalk');
const { parseCommandText, commandFromCardAction } = require('./base');

const HEARTBEAT_DEAD_MS = 120_000; // server pings ~30s; 4 missed → reconnect

/** Bot message payload.data → {senderId, command, webhook} | null. */
function parseDingtalkMessage(data) {
  if (!data || data.msgtype !== 'text' || !data.text) return null;
  const command = parseCommandText(data.text.content);
  if (!command) return null;
  return {
    senderId: String(data.senderStaffId || data.senderId || ''),
    webhook: data.sessionWebhook ? String(data.sessionWebhook) : null,
    webhookExpiresAt: Number(data.sessionWebhookExpiredTime) || 0,
    command,
  };
}

/** Card callback payload.data → {senderId, command} | null. */
function parseDingtalkCardCallback(data) {
  if (!data || typeof data !== 'object') return null;
  let value = null;
  const content = data.content || data.cardPrivateData || {};
  const params = content && content.params;
  // AI-card callbacks put button values in content.params (string or object)
  if (params && typeof params === 'object') value = params;
  else if (typeof params === 'string') { try { value = JSON.parse(params); } catch { value = { raw: params }; } }
  else if (typeof data.content === 'string') { try { value = JSON.parse(data.content); } catch { return null; } }
  const command = value ? commandFromCardAction(value) : null;
  if (!command) return null;
  return { senderId: String(data.senderStaffId || data.senderId || ''), command };
}

/** ACK frame for a routed server frame (requestId/messageId mirrored). */
function buildAckFrame(frame) {
  const h = (frame && frame.headers) || {};
  const ph = (frame && frame.payload && frame.payload.headers) || {};
  return {
    headers: {
      contentType: 'application/json',
      requestId: h.requestId || '',
      messageId: `ack-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`,
    },
    payload: {
      headers: { contentType: 'application/json', messageId: ph.messageId || '', timestamp: String(Date.now()) },
      data: {
        code: 'SUCCESS',
        message: 'success',
        headers: { contentType: 'application/json' },
        data: {},
        systemErrors: null,
      },
    },
  };
}

/** Pong frame for the server's keepalive ping. */
function buildPongFrame() {
  return {
    headers: { contentType: 'application/json' },
    payload: { headers: { contentType: 'application/json' }, data: 'pong' },
  };
}

/**
 * DingTalk channel per the manager contract. `deps` (tests only):
 * { WS, fetchImpl, now }. The default WS is the Node built-in WebSocket
 * (WHATWG handler API: onopen/onmessage/…).
 */
class DingtalkChannel {
  constructor({ id, type, config, secrets, log, hooks, deps } = {}) {
    this.id = id || 'dingtalk';
    this.type = type || 'dingtalk';
    this.config = config || {};
    this.secrets = secrets;
    this.log = log || (() => {});
    this.hooks = hooks || {};
    const injected = deps || {};
    this.WS = injected.WS || (typeof WebSocket === 'function' ? WebSocket : null);
    this.fetchImpl = injected.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.now = injected.now || (() => Date.now());
    // buttons need a public callback → degrade to command text (plan C6)
    this.supportsCards = false;

    this.ws = null;
    this.webhook = null;        // sticky reply target (sessionWebhook)
    this.webhookExpiresAt = 0;
    this.lastPingAt = 0;
    this.heartbeatTimer = null;
    this.stopped = false;
  }

  /** @private secrets JSON string → { clientId, clientSecret } | null */
  readCredentials() {
    let raw = null;
    try { raw = this.secrets ? this.secrets.get(this.id) : null; } catch { /* vault unreadable */ }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.clientId && obj.clientSecret) return { clientId: String(obj.clientId), clientSecret: String(obj.clientSecret) };
    } catch { /* malformed JSON */ }
    return null;
  }

  async start() {
    this.stopped = false;
    if (!this.WS) throw new Error('dingtalk: WebSocket unavailable in this runtime');
    const creds = this.readCredentials();
    if (!creds) throw new Error('dingtalk: credentials missing (configure client id/secret first)');
    const { endpoint, ticket } = await openGatewayConnection({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      fetchImpl: this.fetchImpl,
    });
    await this.connect(`${endpoint}${endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`);
  }

  /** @private dial and wire frame handling. */
  connect(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WS(url);
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        this.lastPingAt = this.now();
        this.startHeartbeatWatch();
        this.log('[channels] dingtalk stream open');
        resolve();
      };
      ws.onmessage = (ev) => {
        // DingTalk Stream frames are JSON text; binary data is decoded UTF-8
        const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
        try { this.handleRawFrame(text); }
        catch (e) { this.log(`[channels] dingtalk frame error: ${e.message}`); }
      };
      ws.onerror = (ev) => {
        // built-in WS error events carry no useful message; credentials were
        // proven by gateway/open before the dial, so this is network-shaped
        const err = new Error(`dingtalk ws: ${(ev && ev.error && ev.error.message) || 'connection failed'}`);
        if (!settled) { settled = true; reject(Object.assign(err, { classified: { kind: 'network', reason: err.message } })); }
        else this.teardown();
      };
      ws.onclose = () => { if (settled) this.teardown(); };
    });
  }

  /** @private one JSON frame from the gate. */
  handleRawFrame(text) {
    let frame = null;
    try { frame = JSON.parse(text); } catch { return; }
    const payload = frame && frame.payload;
    const data = payload && payload.data;
    if (data === 'ping') {
      this.lastPingAt = this.now();
      this.sendJson(buildPongFrame());
      return;
    }
    const topic = (payload && payload.headers && payload.headers.topic) || '';
    if (topic !== '/v1.0/im/bot/messages/get' && topic !== '/v1.0/card/instances/callback') return;
    this.sendJson(buildAckFrame(frame)); // ACK first, then process
    this.lastPingAt = this.now();
    if (topic === '/v1.0/im/bot/messages/get') {
      const parsed = parseDingtalkMessage(data);
      if (parsed) {
        if (parsed.webhook) { this.webhook = parsed.webhook; this.webhookExpiresAt = parsed.webhookExpiresAt; }
        this.deliverInbound('message', parsed.senderId, parsed.command);
      }
      return;
    }
    const card = parseDingtalkCardCallback(data);
    if (card) this.deliverInbound('card', card.senderId, card.command);
  }

  /** @private shared inbound path. */
  deliverInbound(kind, senderId, command) {
    const sid = senderId || 'unknown';
    this.log(`[channels] dingtalk inbound ${kind} from ${sid}`);
    if (this.hooks && typeof this.hooks.onInbound === 'function') {
      try { this.hooks.onInbound({ channelId: this.id, senderId: sid, command }); }
      catch (e) { this.log(`[channels] dingtalk onInbound error: ${e.message}`); }
    }
  }

  /** @private server should ping ~30s; dead socket → force reconnect. */
  startHeartbeatWatch() {
    this.stopHeartbeatWatch();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.stopped) return;
      if (this.now() - this.lastPingAt > HEARTBEAT_DEAD_MS) {
        this.log('[channels] dingtalk heartbeat timeout; forcing reconnect');
        this.teardown();
      }
    }, 30_000);
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  stopHeartbeatWatch() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** @private detach the WHATWG handlers so callbacks stop firing. */
  detach(ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  /** @private socket died after having been online → notify the manager. */
  teardown() {
    this.stopHeartbeatWatch();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.detach(ws);
      try { ws.close(); } catch { /* ignore */ }
    }
    if (!this.stopped && this.hooks && typeof this.hooks.notifyDisconnect === 'function') {
      this.hooks.notifyDisconnect(this.id);
    }
  }

  sendJson(obj) {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async stop() {
    this.stopped = true;
    this.stopHeartbeatWatch();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.detach(ws);
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------- transport surface

  assertWebhook() {
    if (!this.webhook) throw new Error('dingtalk: no active session webhook to reply to');
    if (this.webhookExpiresAt && this.webhookExpiresAt < this.now()) {
      throw new Error('dingtalk: session webhook expired (send a new message first)');
    }
  }

  async sendText(text) {
    this.assertWebhook();
    return sendViaSessionWebhook({
      sessionWebhook: this.webhook,
      title: 'DshCockpit',
      text,
      fetchImpl: this.fetchImpl,
    });
  }

  async sendCard(card) {
    // degraded path: deliver the card as its markdown approximation
    const lines = [String((card && card.title) || ''), '', String((card && card.body) || '')];
    return this.sendText(lines.join('\n').trim());
  }
}

module.exports = {
  DingtalkChannel,
  parseDingtalkMessage,
  parseDingtalkCardCallback,
  buildAckFrame,
  buildPongFrame,
};
