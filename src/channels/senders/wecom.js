// src/channels/senders/wecom.js — WeCom AI-Bot card builder + error mapping (C6).
//
// The heavy lifting (WebSocket, auth, heartbeat, reconnect internals, reply
// framing) lives in the official @wecom/aibot-node-sdk (MIT, pure JS, ~516KB
// on disk incl. types — verified, no native deps; pulls ws/axios/eventemitter3
// which ws is also reused by the feishu/dingtalk adapters). This module keeps
// only our dialect:
//
//   - buildWecomCard(): generic card → WeCom button_interaction template card.
//     Button clicks ride back as event.template_card_event with event_key =
//     our JSON {action, token} (button key budget is 1024B — plenty).
//   - classifyWecomError(): credentials / network / protocol buckets for the
//     settings page + reconnect state machine. SDK auth failures surface as
//     WSAuthFailureError or 'auth' reasons — never with the secret inside.
//   - testWecomConnection(): L1 probe = dial, await authenticated, disconnect.
'use strict';

const SUB_TITLE_MAX = 112; // WeCom template card sub_title_text budget

/** Generic card ({title, body, actions}) → WeCom button_interaction card. */
function buildWecomCard(card) {
  const actions = ((card && card.actions) || []).filter((a) => a && (a.id === 'approve' || a.id === 'deny'));
  const body = String((card && card.body) || '');
  const out = {
    card_type: 'button_interaction',
    main_title: { title: String((card && card.title) || '') },
    sub_title_text: body.length > SUB_TITLE_MAX ? `${body.slice(0, SUB_TITLE_MAX - 1)}…` : body,
  };
  if (actions.length) {
    out.button_list = actions.map((a) => ({
      text: String(a.label || a.id),
      style: a.id === 'deny' ? 3 : 1, // 1 primary, 3 danger
      key: JSON.stringify({ action: a.id, token: a.token }),
    }));
    // task_id must be unique per bot; the one-shot token is unique by design
    out.task_id = `dsh-${(actions[0] && actions[0].token) || Date.now().toString(36)}`;
  }
  return out;
}

/** Decode a button event_key back into the card action payload. */
function parseWecomEventKey(eventKey) {
  const s = String(eventKey || '');
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && v.action && v.token) return { action: String(v.action), token: String(v.token) };
  } catch { /* not JSON */ }
  const m = s.match(/^(approve|deny|answer)[:|]([0-9a-f]{16,64})$/i);
  return m ? { action: m[1].toLowerCase(), token: m[2] } : null;
}

/** Map any failure to { kind: credentials|network|protocol, reason }. */
function classifyWecomError(err) {
  const name = (err && err.constructor && err.constructor.name) || '';
  const message = String((err && err.message) || err || '');
  if (name === 'WSAuthFailureError' || /auth|secret|botid|unauthorized|401|403/i.test(message)) {
    return { kind: 'credentials', reason: message };
  }
  if (/abort|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|connect failed|network/i.test(message)) {
    return { kind: 'network', reason: message };
  }
  return { kind: 'protocol', reason: message };
}

/**
 * L1 credential probe: connect with the official SDK and wait for the
 * `authenticated` event (SDK exchanges botId+secret itself). `sdk` is
 * injectable so tests can pass a stub; production callers omit it.
 */
async function testWecomConnection({ botId, secret, sdk, timeoutMs = 8_000 }) {
  const mod = sdk || require('@wecom/aibot-node-sdk');
  let client = null;
  let timer = null;
  try {
    client = new mod.WSClient({ botId, secret, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const verdict = await new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, kind: 'network', reason: 'timeout' }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      client.once('authenticated', () => resolve({ ok: true }));
      client.once('disconnected', (reason) => resolve({ ok: false, kind: classifyWecomError(new Error(String(reason))).kind, reason: String(reason || '') }));
      try { client.connect(); } catch (e) { resolve({ ok: false, kind: 'protocol', reason: e.message }); }
    });
    return verdict;
  } catch (e) {
    const c = classifyWecomError(e);
    return { ok: false, kind: c.kind, reason: e.message };
  } finally {
    if (timer) clearTimeout(timer);
    try { if (client) client.disconnect(); } catch { /* already gone */ }
  }
}

module.exports = { buildWecomCard, parseWecomEventKey, classifyWecomError, testWecomConnection };
