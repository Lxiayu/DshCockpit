// src/channels/receivers/dingtalk.js — DingTalk Stream Mode channel (C6).
//
// Self-written protocol layer over the official Stream spec. An official
// Node SDK exists (`dingtalk-stream-sdk-nodejs`, npm, open-dingtalk
// org — v2.0.4); we keep the hand-rolled transport (no extra dependency,
// same built-in WebSocket policy as runtime-events.js) and follow the
// official protocol documents (open.dingtalk.com/document/direction/
// stream-mode-protocol-access-description + open-dingtalk.github.io/
// developerpedia/docs/learn/stream/protocol/). Wire shape is JSON text
// frames on one WebSocket:
//
//   1. POST /v1.0/gateway/connections/open (clientId/Secret + subscriptions
//      [{type,topic}]) → { endpoint, ticket } — ticket is one-shot, 90s TTL,
//      never stored
//   2. wss connect endpoint?ticket=…
//   3. server frames (top-level {type, headers:{topic,messageId,…}, data}):
//        headers.topic === 'ping'              → echo `opaque` verbatim
//        topic /v1.0/im/bot/messages/get      → ACK {code,message,headers,
//        data} + bot message (text; sessionWebhook inside becomes the reply
//        channel; group traffic arrives @-prefixed → parseCommandText strips
//        mentions)
//        topic /v1.0/card/instances/callback  → ACK + card button callback
//        (value = our {action, token} JSON when a card plugin sends one)
//   4. every routed frame is ACKed immediately with the official response
//      shape ({code:200, message:'OK', headers:{messageId (from the request)},
//      data}) — CALLBACK data {"response":{}}, EVENT data
//      {"status":"SUCCESS"} — the gate retries un-ACKed EVENT frames
//   5. close/error → hooks.notifyDisconnect → manager backoff loop
//
// Transport: the Node built-in WebSocket (WHATWG API, stable since Node 22 /
// Electron 37 main) — same choice as src/runtime-events.js; the `ws` npm
// package stays undeclared (only the official WeCom SDK pulls it).
//
// Outbound: markdown via sessionWebhook (senders/dingtalk.js) — replies carry
// the official SDK's `x-acs-dingtalk-access-token` header (Client ID; the
// protocol doc leaves the header unspecified — 以官方文档为准，需真机验证).
// Buttons would need a public callback — per plan they degrade to command
// text, so supportsCards is false and the formatter's text shape
// (reply-instruction with the one-shot token) is what users see.
'use strict';

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

/**
 * ACK frame for a routed server frame (B3). Official response shape
 * (developerpedia "协议描述" 响应示例): top-level
 * { code: 200, message: 'OK', headers: { messageId (mirror the request's),
 *   contentType: 'application/json' }, data: <JSON string> }.
 *  - CALLBACK frames (bot message / card callback) → data {"response":{}}
 *    ("机器人消息的响应中，只需要标识成功失败即可，钉钉服务端暂时不用该 data 字段")
 *  - EVENT frames → data {"status":"SUCCESS","message":"success"} (status
 *    必填：SUCCESS 消费成功 / LATER 消费失败)
 * messageId comes from the received frame's headers (report §3.2: "响应
 * 的时候将此信息回传给服务端").
 */
function buildAckFrame(frame) {
  const h = (frame && frame.headers) || {};
  const type = (frame && frame.type) || '';
  const data = type === 'EVENT'
    ? JSON.stringify({ status: 'SUCCESS', message: 'success' })
    : JSON.stringify({ response: {} });
  return {
    code: 200,
    message: 'OK',
    headers: { contentType: 'application/json', messageId: h.messageId || '' },
    data,
  };
}

/**
 * Ping keepalive response (B2). Official protocol: the ping request's data
 * is a JSON string carrying `opaque` (developerpedia "ping 请求处理") and the
 * response must echo it verbatim — "响应的数据必须和推送的数据完全一致，并且响应的
 * messageId和请求的messageId必须保持一致". Fall back to a 'pong' echo when no
 * opaque is present (以官方文档为准，需真机验证).
 */
function buildPingResponseFrame(headers, data) {
  const h = headers || {};
  let payload;
  if (data && typeof data === 'object' && data.opaque !== undefined) {
    payload = JSON.stringify({ opaque: data.opaque });
  } else if (typeof data === 'string' && data) {
    payload = data; // already the raw echo
  } else {
    payload = JSON.stringify({ opaque: '' });
  }
  return {
    code: 200,
    message: 'OK',
    headers: { contentType: 'application/json', messageId: h.messageId || '' },
    data: payload,
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
    this.clientId = '';         // used for the sessionWebhook access-token header (B5)
    this.heartbeatIntervalMs = injected.heartbeatIntervalMs || 30_000; // tests
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
    if (!creds) {
      const err = new Error('dingtalk: credentials missing (configure client id/secret first)');
      err.permanent = true; // config problem — no point auto-reconnecting
      throw err;
    }
    this.clientId = creds.clientId;
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

  /** @private one JSON frame from the gate. Official push shape (B2/B3):
   * top-level { type, headers: {topic, messageId, contentType, time}, data }
   * where data is a JSON string (developerpedia "协议描述"). */
  handleRawFrame(text) {
    let frame = null;
    try { frame = JSON.parse(text); } catch { return; }
    const headers = (frame && frame.headers) || {};
    const topic = headers.topic || '';
    let data = frame && frame.data;
    // the pushed data is a JSON string; parse it for routing, but the ping
    // handler needs the raw string to echo back verbatim
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* keep the raw string */ }
    }
    if (topic === 'ping') {
      this.lastPingAt = this.now();
      this.sendJson(buildPingResponseFrame(headers, data));
      return;
    }
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
    }, this.heartbeatIntervalMs);
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
      // official Node SDK example sends the access-token header (B5); the
      // protocol doc doesn't specify it — 以官方文档为准，需真机验证
      accessToken: this.clientId,
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
  buildPingResponseFrame,
  buildPongFrame: buildPingResponseFrame, // legacy alias
};
