// src/channels/senders/dingtalk.js — DingTalk outbound helpers (C6).
//
// Stream Mode outbound facts (official protocol doc,
// open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol/):
//   - replies ride the per-message sessionWebhook the bot message carries
//     (valid until sessionWebhookExpiredTime): POST it with
//     { msgtype: 'markdown', markdown: { title, text } } — no access token
//     needed, no public callback URL.
//   - connection probe: POST /v1.0/gateway/connections/open with
//     clientId/clientSecret — the same call the receiver makes before dialing
//     the WebSocket; getting { endpoint, ticket } back proves the credentials.
//
// Cards: interactive card buttons need a public callback or a pre-registered
// card template; per plan C6 the DingTalk channel degrades to command text
// ("回复 批准 <token>" rides the formatter's text shape) — supportsCards is
// therefore false and this module only shapes markdown replies.
'use strict';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const GATEWAY_OPEN_PATH = '/v1.0/gateway/connections/open';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Map any failure to { kind: credentials|network|protocol, reason }. */
function classifyDingtalkError(err) {
  const status = err && err.status;
  const message = String((err && err.message) || err || '');
  if (status === 401 || status === 403) return { kind: 'credentials', reason: message };
  // gateway/open rejects bad clientId/Secret with errcode 401 / "invalid clientId"
  if (/invalid client|invalidClient|clientId|clientSecret|unauthorized|ticket/i.test(message)) {
    return { kind: 'credentials', reason: message };
  }
  if (/abort|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)) {
    return { kind: 'network', reason: message };
  }
  return { kind: 'protocol', reason: message };
}

/**
 * L1 credential probe: open a gateway connection slot. `fetchImpl` injectable
 * for tests. Never logs the clientSecret.
 */
async function openGatewayConnection({ clientId, clientSecret, fetchImpl, tag = 'DshCockpit', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!fetchImpl) throw Object.assign(new Error('dingtalk: fetch unavailable'), { status: 0 });
  let ac = null;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    ac = new AbortController();
    timer = setTimeout(() => ac.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const res = await fetchImpl(`${DINGTALK_API_BASE}${GATEWAY_OPEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        subscriptions: [
          { type: 'EVENT', subscriptionKeys: [] },
          { type: 'CALLBACK', subscriptionKeys: ['/v1.0/im/bot/messages/get', '/v1.0/card/instances/callback'] },
        ],
        tag,
      }),
      signal: ac ? ac.signal : undefined,
    });
    let body = null;
    try { body = typeof res.json === 'function' ? await res.json() : JSON.parse(res.body); } catch { /* non-JSON */ }
    if (res.status !== 200 || !body || !body.endpoint || !body.ticket) {
      throw Object.assign(
        new Error(`gateway/open failed: HTTP ${res.status} code=${body && (body.code !== undefined ? body.code : '')} ${body && body.message || ''}`.trim()),
        { status: res.status },
      );
    }
    return { endpoint: String(body.endpoint), ticket: String(body.ticket) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Credential probe for the settings page. */
async function testDingtalkConnection({ clientId, clientSecret, fetchImpl, timeoutMs = 8_000 }) {
  try {
    await openGatewayConnection({ clientId, clientSecret, fetchImpl, timeoutMs });
    return { ok: true };
  } catch (e) {
    const classified = classifyDingtalkError(e);
    return { ok: false, kind: classified.kind, reason: e.message };
  }
}

/**
 * Reply through a session webhook. Markdown carries the reply-instruction
 * text from the formatter (multi-line friendly).
 */
async function sendViaSessionWebhook({ sessionWebhook, title, text, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!sessionWebhook) throw new Error('dingtalk: no active session webhook');
  if (!fetchImpl) throw Object.assign(new Error('dingtalk: fetch unavailable'), { status: 0 });
  let ac = null;
  let timer = null;
  if (typeof AbortController !== 'undefined') {
    ac = new AbortController();
    timer = setTimeout(() => ac.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const res = await fetchImpl(String(sessionWebhook), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { title: String(title || 'DshCockpit'), text: String(text || '') } }),
      signal: ac ? ac.signal : undefined,
    });
    let body = null;
    try { body = typeof res.json === 'function' ? await res.json() : JSON.parse(res.body); } catch { /* non-JSON */ }
    if (res.status !== 200 || (body && body.errcode !== 0 && body.errcode !== undefined)) {
      throw Object.assign(
        new Error(`session webhook failed: HTTP ${res.status} errcode=${body && body.errcode} ${body && body.errmsg}`),
        { status: res.status },
      );
    }
    return body || {};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  DINGTALK_API_BASE,
  GATEWAY_OPEN_PATH,
  classifyDingtalkError,
  openGatewayConnection,
  testDingtalkConnection,
  sendViaSessionWebhook,
};
