// src/channels/senders/feishu.js — Feishu outbound API client + card builder (C6).
//
// Transport facts (verified against the official long-connection docs and the
// MIT @larksuiteoapi/node-sdk ws-client, 2026-08):
//   - tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal
//     { app_id, app_secret } → { code, tenant_access_token, expire } (seconds)
//   - messages: POST /open-apis/im/v1/messages?receive_id_type=chat_id with
//     Bearer token; msg_type 'text' | 'interactive' (card JSON 2.0 as a
//     JSON-string `content` payload)
//   - interactive cards (schema 2.0) carry callback buttons whose `value`
//     object rides back on the card.action.trigger event over the same
//     long connection — buttons embed { action, token } so the receiver can
//     hand approve/deny straight to the dispatcher's one-shot token check.
//
// Errors are classified (credentials / network / protocol) so the settings
// page and the reconnect state machine can tell the user what broke; values
// never include the app secret.
'use strict';

const { t } = require('../../i18n');

const FEISHU_BASE = 'https://open.feishu.cn';
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_PATH = '/open-apis/im/v1/messages?receive_id_type=chat_id';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Map any failure to { kind: credentials|network|protocol, reason }. */
function classifyFeishuError(err) {
  const status = err && err.status;
  const message = String((err && err.message) || err || '');
  if (status === 401 || status === 403) return { kind: 'credentials', reason: message };
  if (err && err.code === 'app_secret_invalid') return { kind: 'credentials', reason: message };
  if (/abort|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) {
    return { kind: 'network', reason: message };
  }
  // feishu business codes: 99991663/99991661/99991664 = app/secret problems
  if (/9999166[134]/.test(message)) return { kind: 'credentials', reason: message };
  return { kind: 'protocol', reason: message };
}

/**
 * Generic card ({ title, body, actions:[{id,label,token}] }) → Feishu
 * interactive card JSON (schema 2.0). Only approve/deny actions become
 * callback buttons; answer-style actions stay text (the card body carries
 * the reply instruction from the formatter).
 */
function buildFeishuCard(card) {
  const buttons = ((card && card.actions) || [])
    .filter((a) => a && (a.id === 'approve' || a.id === 'deny'))
    .map((a) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: String(a.label || a.id) },
      type: a.id === 'approve' ? 'primary' : 'danger',
      behaviors: [{ type: 'callback', value: { action: a.id, token: a.token } }],
    }));
  const elements = [{ tag: 'markdown', content: String((card && card.body) || '') }];
  if (buttons.length) elements.push({ tag: 'action', actions: buttons });
  return {
    type: 'raw',
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: String((card && card.title) || '') } },
    body: { direction: 'vertical', elements },
  };
}

/**
 * Minimal Feishu OpenAPI client with tenant-token caching.
 * @param {object} deps
 *   fetchImpl(url, { method, headers, body, timeoutMs }) → { status, body }
 *   now() — injectable clock for token expiry tests
 */
function createFeishuClient({ appId, appSecret, fetchImpl, log, now }) {
  const fetchFn = fetchImpl;
  const clock = now || (() => Date.now());
  let token = null;       // { value, expiresAt }
  const logger = log || (() => {});

  async function request(path, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
    if (!fetchFn) throw Object.assign(new Error('feishu: fetch unavailable'), { status: 0 });
    let ac = null;
    let timer = null;
    if (typeof AbortController !== 'undefined') {
      ac = new AbortController();
      timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
    try {
      const res = await fetchFn(`${FEISHU_BASE}${path}`, {
        method,
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac ? ac.signal : undefined,
      });
      let parsed = null;
      try { parsed = typeof res.json === 'function' ? await res.json() : JSON.parse(res.body); } catch { /* non-JSON */ }
      return { status: res.status, body: parsed };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** tenant_access_token with ~60s early-expiry safety margin. */
  async function getTenantAccessToken(force) {
    if (!force && token && token.expiresAt - 60_000 > clock()) return token.value;
    const { status, body } = await request(TOKEN_PATH, {
      method: 'POST',
      body: { app_id: appId, app_secret: appSecret },
    });
    if (status !== 200 || !body || body.code !== 0 || !body.tenant_access_token) {
      throw Object.assign(
        new Error(`tenant_access_token failed: HTTP ${status} code=${body && body.code} ${body && body.msg}`),
        { status: status === 200 ? 403 : status, code: body && body.code },
      );
    }
    token = { value: body.tenant_access_token, expiresAt: clock() + (body.expire || 3600) * 1000 };
    logger('[channels] feishu tenant token refreshed');
    return token.value;
  }

  async function sendMessage(receiveId, msgType, contentObj) {
    let accessToken;
    try {
      accessToken = await getTenantAccessToken();
    } catch (e) {
      // one retry on a possibly-stale token, then classify
      try { accessToken = await getTenantAccessToken(true); } catch (e2) { throw e2; }
    }
    const { status, body } = await request(MESSAGE_PATH, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` },
      body: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(contentObj) },
    });
    if (status !== 200 || !body || body.code !== 0) {
      throw Object.assign(
        new Error(`send message failed: HTTP ${status} code=${body && body.code} ${body && body.msg}`),
        { status: status === 401 || status === 403 ? status : 0, code: body && body.code },
      );
    }
    return body;
  }

  return {
    getTenantAccessToken,
    sendText: (chatId, text) => sendMessage(chatId, 'text', { text: String(text || '') }),
    sendCard: (chatId, card) => sendMessage(chatId, 'interactive', buildFeishuCard(card)),
  };
}

/** Readable, localized description for a classified error. */
function describeFeishuError(lang, classified) {
  return t(lang, `channels.err.${classified.kind}`, { reason: classified.reason || '' });
}

/** L1 credential probe for the settings page: exchange the token once. */
async function testFeishuConnection({ appId, appSecret, fetchImpl, timeoutMs = 8_000 }) {
  try {
    const client = createFeishuClient({ appId, appSecret, fetchImpl });
    await client.getTenantAccessToken(true);
    return { ok: true };
  } catch (e) {
    const classified = classifyFeishuError(e);
    return { ok: false, kind: classified.kind, reason: e.message };
  }
}

module.exports = {
  createFeishuClient,
  buildFeishuCard,
  classifyFeishuError,
  describeFeishuError,
  testFeishuConnection,
  FEISHU_BASE,
};
