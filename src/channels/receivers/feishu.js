// src/channels/receivers/feishu.js — Feishu long-connection channel (C6).
//
// One class fulfilling the channel-manager implementation contract on top of
// the pieces built beside it: the pbbp2 frame codec (../pbbp2.js) and the
// outbound API client (../senders/feishu.js). Transport facts (official docs
// + MIT @larksuiteoapi/node-sdk ws-client, 2026-08):
//
//   - endpoint: GET /callback/ws/endpoint with AppId/AppSecret headers →
//     { endpoint } (or { data: { endpoint } } on older gates)
//   - the endpoint URL embeds the service id: .../callback/ws/<service>?…
//   - events arrive as pbbp2 frames whose payload may be gzip-compressed
//     (headers.compression === 'gzip') — inflate before JSON.parse
//   - 3-second rule: the gate expects an ACK per event frame; we answer the
//     matching `feedback` frame synchronously and process the body async,
//     so slow dispatch never trips the deadline
//   - gate liveness pings arrive as `ping` frames → mirrored `pong` frames
//
// Transport: the Node built-in WebSocket (WHATWG API, stable since Node 22 /
// Electron 37 main) — same choice as src/runtime-events.js; `ws` the npm
// package stays out of our dependency list (only the official WeCom SDK
// pulls it, for its own sockets).
//
// Inbound mapping (→ receiver base parse helpers → hooks.onInbound):
//   im.message.receive_v1   text message  → parseCommandText()
//   card.action.trigger     button value  → commandFromCardAction()
// Replies (manager onInbound → impl.sendText) go back to the chat the most
// recent inbound message came from — a channel talks to one controlling chat
// at a time, which is the entire remote-control use case.
'use strict';

const zlib = require('node:zlib');
const { encodeFrame, decodeFrame, headerMap } = require('../pbbp2');
const { createFeishuClient, FEISHU_BASE } = require('../senders/feishu');
const { parseCommandText, commandFromCardAction } = require('./base');

const ENDPOINT_PATH = '/callback/ws/endpoint';
const HEARTBEAT_CHECK_MS = 30_000;
const HEARTBEAT_DEAD_MS = 90_000; // no ping/pong/event for 90s → force reconnect

// ------------------------------------------------------------ payload parse

/**
 * A parsed event payload (JSON object) → inbound pieces, or null when the
 * event is not one this channel reacts to (non-text messages, other types).
 * Pure — unit-tested without a socket.
 * @returns {{kind:'message', senderId, chatId, command} |
 *           {kind:'card', senderId, command} | null}
 */
function parseFeishuEvent(body) {
  if (!body || typeof body !== 'object') return null;
  const header = body.header || {};
  const event = body.event || {};
  if (header.event_type === 'im.message.receive_v1') {
    const msg = event.message || {};
    if (!msg.chat_id || msg.message_type !== 'text') return null;
    let content = {};
    try { content = JSON.parse(String(msg.content || '{}')); } catch { /* malformed */ }
    const senderId = (event.sender && event.sender.sender_id && event.sender.sender_id.open_id) || '';
    const command = parseCommandText(content.text);
    if (!command) return null;
    return { kind: 'message', senderId, chatId: msg.chat_id, command };
  }
  if (header.event_type === 'card.action.trigger') {
    const value = event.action && event.action.value;
    const command = commandFromCardAction(value);
    if (!command) return null;
    const senderId = (event.operator && event.operator.open_id) || '';
    return { kind: 'card', senderId, command };
  }
  return null;
}

/** .../callback/ws/<service>?… → <service> ('0' when the URL has none). */
function extractServiceId(endpointUrl) {
  const m = String(endpointUrl || '').match(/\/callback\/ws\/([^/?#]+)/);
  return m ? m[1] : '0';
}

function headerList(map) {
  return Object.entries(map || {}).map(([key, value]) => ({ key, value: String(value) }));
}

// ------------------------------------------------------------- channel impl

/**
 * Feishu channel: long-connection receiver + card/text sender in one, per
 * the channel-manager contract `new Ctor({ id, type, config, secrets, log,
 * hooks })`. `deps` (tests only): { WS, fetchImpl, now }. The default WS is
 * the Node built-in WebSocket (WHATWG handler API: onopen/onmessage/…).
 */
class FeishuChannel {
  constructor({ id, type, config, secrets, log, hooks, deps } = {}) {
    this.id = id || 'feishu';
    this.type = type || 'feishu';
    this.config = config || {};
    this.secrets = secrets;
    this.log = log || (() => {});
    this.hooks = hooks || {};
    const injected = deps || {};
    this.WS = injected.WS || (typeof WebSocket === 'function' ? WebSocket : null);
    this.fetchImpl = injected.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.now = injected.now || (() => Date.now());
    this.supportsCards = true;

    this.ws = null;
    this.client = null;       // senders/feishu API client (token + messages)
    this.chatId = null;       // sticky reply target (last inbound chat)
    this.lastActiveAt = 0;
    this.heartbeatTimer = null;
    this.stopped = false;
  }

  /** @private secrets JSON string → { appId, appSecret } | null */
  readCredentials() {
    let raw = null;
    try { raw = this.secrets ? this.secrets.get(this.id) : null; } catch { /* vault unreadable */ }
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.appId && obj.appSecret) return { appId: String(obj.appId), appSecret: String(obj.appSecret) };
    } catch { /* malformed JSON */ }
    return null;
  }

  /** @private GET /callback/ws/endpoint (AppId/AppSecret headers). */
  async fetchEndpoint(appId, appSecret) {
    if (!this.fetchImpl) throw Object.assign(new Error('feishu: fetch unavailable'), { status: 0 });
    const res = await this.fetchImpl(`${FEISHU_BASE}${ENDPOINT_PATH}`, {
      method: 'GET',
      headers: { AppId: appId, AppSecret: appSecret },
    });
    const body = typeof res.json === 'function' ? await res.json() : res.body;
    const endpoint = body && (body.endpoint || (body.data && body.data.endpoint));
    if (!endpoint) {
      throw Object.assign(
        new Error(`ws endpoint failed: HTTP ${res.status} code=${body && body.code} ${body && body.msg}`),
        { status: res.status === 200 ? 403 : res.status, code: body && body.code },
      );
    }
    return String(endpoint);
  }

  async start() {
    this.stopped = false;
    if (!this.WS) throw new Error('feishu: WebSocket unavailable in this runtime');
    const creds = this.readCredentials();
    if (!creds) throw new Error('feishu: credentials missing (configure app_id/app_secret first)');
    this.client = createFeishuClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      fetchImpl: this.fetchImpl,
      log: this.log,
    });
    const endpoint = await this.fetchEndpoint(creds.appId, creds.appSecret);
    this.service = extractServiceId(endpoint);
    await this.connect(endpoint);
  }

  /** @private open the socket and wire frame handling. */
  connect(endpoint) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WS(endpoint);
      this.ws = ws;
      try { ws.binaryType = 'arraybuffer'; } catch { /* fake in tests may not care */ }
      ws.onopen = () => {
        settled = true;
        this.lastActiveAt = this.now();
        this.startHeartbeatWatch();
        this.log(`[channels] feishu ws open (service ${this.service})`);
        resolve();
      };
      ws.onmessage = (ev) => {
        try { this.handleFrame(Buffer.from(ev.data)); }
        catch (e) { this.log(`[channels] feishu frame error: ${e.message}`); }
      };
      ws.onerror = (ev) => {
        // built-in WS error events carry no useful message text; transport
        // failures here are network-shaped (credentials were proven by the
        // endpoint fetch before the dial)
        const err = new Error(`feishu ws: ${(ev && ev.error && ev.error.message) || 'connection failed'}`);
        if (!settled) { settled = true; reject(Object.assign(err, { classified: { kind: 'network', reason: err.message } })); }
        else this.teardown();
      };
      ws.onclose = () => { if (settled) this.teardown(); };
    });
  }

  /** @private route one decoded frame by its headers.type. */
  handleFrame(buf) {
    const frame = decodeFrame(buf);
    const headers = headerMap(frame);
    this.lastActiveAt = this.now();
    switch (headers.type) {
      case 'ping':
        this.send(encodeFrame({
          method: 0,
          service: Number(frame.service) || 0,
          headers: headerList({ type: 'pong', wait: headers.wait || '30000' }),
        }));
        return;
      case 'event': {
        // 3-second rule: ACK synchronously, then process async.
        this.send(encodeFrame({
          method: 0,
          service: Number(frame.service) || 0,
          headers: headerList({ type: 'feedback', log_id: headers.log_id || '' }),
          payload: frame.payload,
        }));
        this.processEvent(frame, headers);
        return;
      }
      default:
        return; // pong / control / unknown: nothing to do
    }
  }

  /** @private inflate + parse the event payload, hand the command upstream. */
  processEvent(frame, headers) {
    let payload = frame.payload || new Uint8Array(0);
    if (headers.compression === 'gzip' && payload.length) {
      try { payload = new Uint8Array(zlib.gunzipSync(Buffer.from(payload))); } catch { /* corrupt */ }
    }
    let body = null;
    try { body = JSON.parse(Buffer.from(payload).toString('utf8')); } catch { return; }
    const parsed = parseFeishuEvent(body);
    if (!parsed) return;
    if (parsed.chatId) this.chatId = parsed.chatId;
    const senderId = parsed.senderId || 'unknown';
    this.log(`[channels] feishu inbound ${parsed.kind} from ${senderId}`);
    if (this.hooks && typeof this.hooks.onInbound === 'function') {
      try { this.hooks.onInbound({ channelId: this.id, senderId, command: parsed.command }); }
      catch (e) { this.log(`[channels] feishu onInbound error: ${e.message}`); }
    }
  }

  /** @private gate liveness: kill dead sockets so the manager reconnects. */
  startHeartbeatWatch() {
    this.stopHeartbeatWatch();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.stopped) return;
      if (this.now() - this.lastActiveAt > HEARTBEAT_DEAD_MS) {
        this.log('[channels] feishu heartbeat timeout; forcing reconnect');
        this.teardown();
      }
    }, HEARTBEAT_CHECK_MS);
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

  send(buf) {
    if (this.ws && this.ws.readyState === this.WS.OPEN) this.ws.send(buf);
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

  async sendText(text) {
    if (!this.client || !this.chatId) throw new Error('feishu: no active chat to reply to');
    return this.client.sendText(this.chatId, text);
  }

  async sendCard(card) {
    if (!this.client || !this.chatId) throw new Error('feishu: no active chat to reply to');
    return this.client.sendCard(this.chatId, card);
  }
}

module.exports = {
  FeishuChannel,
  parseFeishuEvent,
  extractServiceId,
  headerList,
  ENDPOINT_PATH,
};
