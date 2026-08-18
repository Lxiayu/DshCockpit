// test/channels-c6.test.js — platform protocol implementations (C6, v0.2.4).
//
// Mock-only coverage for the three IM channel adapters, zero real sockets:
//   - pbbp2 frame codec round-trips (feishu long connection wire format)
//   - feishu: tenant-token client + card builder + event parsing + the
//     3-second ACK behavior (feedback frame answers synchronously)
//   - wecom: SDK adapter (message.text + template_card_event routing) and the
//     button event_key {action, token} JSON dialect
//   - dingtalk: gateway/open probe, JSON stream frames (ping→pong, event→ACK),
//     bot-message parsing with sessionWebhook capture
//   - shared: one-shot-token button flows through each receiver → dispatcher,
//     credentials vault via the manager's configureSecrets/testChannel, and
//     disconnect→notify state reporting for the reconnect state machine.
'use strict';

const { test: it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { encodeFrame, decodeFrame, headerMap } = require('../src/channels/pbbp2');
const {
  createFeishuClient, buildFeishuCard, classifyFeishuError, testFeishuConnection,
} = require('../src/channels/senders/feishu');
const { FeishuChannel, parseFeishuEvent, extractServiceId } = require('../src/channels/receivers/feishu');
const {
  buildWecomCard, parseWecomEventKey, classifyWecomError,
} = require('../src/channels/senders/wecom');
const { WecomChannel, parseWecomMessage, parseWecomCardEvent } = require('../src/channels/receivers/wecom');
const {
  openGatewayConnection, classifyDingtalkError, testDingtalkConnection,
} = require('../src/channels/senders/dingtalk');
const {
  DingtalkChannel, parseDingtalkMessage, parseDingtalkCardCallback, buildAckFrame,
} = require('../src/channels/receivers/dingtalk');
const { OneShotTokens } = require('../src/channels/one-shot-tokens');
const { SessionBindings, createCommandDispatcher, parseCommandText } = require('../src/channels/receivers/base');
const { isAllowed } = require('../src/channels/allowlist');
const { createChannelManager } = require('../src/channels/channel-manager');

// ------------------------------------------------------------------ helpers

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-channels-c6-'));
}

const flush = () => new Promise((r) => setImmediate(r));

/** Minimal WHATWG-style WebSocket fake: on* handlers, capture sends. */
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    setImmediate(() => { this.readyState = 1; if (this.onopen) this.onopen(); });
  }
  send(data) { this.sent.push(data); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
  serverFrame(data) { if (this.onmessage) this.onmessage({ data }); }
}
FakeWS.OPEN = 1;

/** fetch stub: routes by URL prefix, records calls, never hits network. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) {
        const r = typeof handler === 'function' ? handler(url, opts) : handler;
        return r && typeof r.json === 'function' ? r : {
          status: r.status || 200,
          json: async () => (r.body !== undefined ? r.body : r),
        };
      }
    }
    return { status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function fakeSecretsStore(values = {}) {
  const map = new Map(Object.entries(values));
  return {
    get: (id) => (map.has(id) ? map.get(id) : null),
    set: (id, v) => { map.set(id, v); },
    remove: (id) => { map.delete(id); },
    has: (id) => map.has(id),
  };
}

/** A full inbound pipeline like main.js wires: adapter hooks → dispatcher. */
function makePipeline() {
  const tokens = new OneShotTokens();
  const sessions = new SessionBindings(path.join(tmpDir(), 'sessions.json'));
  const calls = { approval: [], question: [], prompts: [] };
  const dispatch = createCommandDispatcher({
    tokens,
    isAllowed,
    sessions,
    runPrompt: async (p) => { calls.prompts.push(p); return { ok: true, output: 'ok-out', durationMs: 10 }; },
    onApprovalDecision: (d) => { calls.approval.push(d); return { ok: true }; },
    onQuestionAnswer: (d) => { calls.question.push(d); return { ok: true }; },
    lang: () => 'zh',
    audit: () => {},
  }).dispatch;
  return { tokens, dispatch, calls };
}

// ------------------------------------------------------------------ pbbp2

it('pbbp2: frame encode/decode round-trip preserves routing + payload bytes', () => {
  const payload = new Uint8Array(Buffer.from(JSON.stringify({ hello: '世界' }), 'utf8'));
  const frame = {
    SeqID: 42,
    LogID: 7,
    service: 123,
    method: 1,
    headers: [
      { key: 'type', value: 'event' },
      { key: 'log_id', value: 'log-1' },
    ],
    payloadEncoding: 'json',
    payloadType: 'application/json',
    payload,
    LogIDNew: 'new-log',
  };
  const wire = encodeFrame(frame);
  const back = decodeFrame(wire);
  assert.strictEqual(back.SeqID, 42);
  assert.strictEqual(back.LogID, 7);
  assert.strictEqual(back.service, 123);
  assert.strictEqual(back.method, 1);
  assert.strictEqual(back.payloadEncoding, 'json');
  assert.strictEqual(back.payloadType, 'application/json');
  assert.strictEqual(back.LogIDNew, 'new-log');
  assert.deepStrictEqual(headerMap(back), { type: 'event', log_id: 'log-1' });
  assert.deepStrictEqual(Buffer.from(back.payload).toString('utf8'), '{"hello":"世界"}');
});

it('pbbp2: unknown fields are skipped, empty frames decode to defaults', () => {
  assert.deepStrictEqual(headerMap(decodeFrame(Buffer.from([]))), {});
  const empty = decodeFrame(Buffer.from([]));
  assert.strictEqual(empty.SeqID, 0);
  assert.strictEqual(empty.payload.length, 0);
  // field 15 (unknown varint) + field 16 (unknown length-delimited) must not throw
  const buf = Buffer.from([0x78, 0x2a, 0x82, 0x01, 0x02, 0x41, 0x42]);
  const decoded = decodeFrame(buf);
  assert.strictEqual(decoded.SeqID, 0);
});

// ------------------------------------------------------------------ feishu

it('feishu sender: tenant token exchange, caching, and credential-error classification', async () => {
  const fetchImpl = fakeFetch({
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal': {
      body: { code: 0, tenant_access_token: 'T-1', expire: 3600 },
    },
  });
  const client = createFeishuClient({ appId: 'app', appSecret: 'sec', fetchImpl });
  assert.strictEqual(await client.getTenantAccessToken(), 'T-1');
  assert.strictEqual(fetchImpl.calls.length, 1, 'cached within expiry');
  assert.strictEqual(await client.getTenantAccessToken(), 'T-1');
  assert.strictEqual(fetchImpl.calls.length, 1);

  const bad = fakeFetch({
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal': {
      status: 200,
      body: { code: 99991663, msg: 'app secret invalid' },
    },
  });
  const r = await testFeishuConnection({ appId: 'a', appSecret: 'b', fetchImpl: bad });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'credentials');

  assert.strictEqual(classifyFeishuError(Object.assign(new Error('ECONNREFUSED'), {})).kind, 'network');
  assert.strictEqual(classifyFeishuError(Object.assign(new Error('weird'), { status: 401 })).kind, 'credentials');
  assert.strictEqual(classifyFeishuError(new Error('weird')).kind, 'protocol');
});

it('feishu card builder: approve/deny buttons embed {action, token} callback values', () => {
  const card = buildFeishuCard({
    title: '需要审批',
    body: '工具 Bash 请求权限',
    actions: [
      { id: 'approve', label: '批准', token: 'tok-abc' },
      { id: 'deny', label: '拒绝', token: 'tok-abc' },
      { id: 'answer', label: '回答', token: 'tok-abc' }, // answer stays text-only by design
    ],
  });
  assert.strictEqual(card.schema, '2.0');
  const action = card.body.elements.find((e) => e.tag === 'action');
  assert.strictEqual(action.actions.length, 2, 'answer action filtered to text');
  assert.deepStrictEqual(action.actions[0].behaviors[0].value, { action: 'approve', token: 'tok-abc' });
  assert.strictEqual(action.actions[1].type, 'danger');
});

it('feishu receiver: 3-second rule — event frame ACKed synchronously, command routed async', async () => {
  const { tokens, dispatch, calls } = makePipeline();
  const token = tokens.issue({ kind: 'approval', tool: 'Bash' });

  const endpoints = fakeFetch({ 'https://open.feishu.cn/callback/ws/endpoint': { body: { endpoint: 'wss://gw/callback/ws/77' } } });
  const inbound = [];
  const hooks = {
    notifyDisconnect: () => {},
    onInbound: (msg) => { inbound.push(msg); return dispatch({ channelId: 'feishu', senderId: msg.senderId, allowFrom: ['ou_1'], command: msg.command }).then((r) => { inbound.reply = r; }); },
  };
  const ch = new FeishuChannel({
    id: 'feishu', config: {}, secrets: fakeSecretsStore({ feishu: JSON.stringify({ appId: 'a', appSecret: 'b' }) }),
    log: () => {}, hooks, deps: { WS: FakeWS, fetchImpl: endpoints, now: () => 1_000_000 },
  });
  await ch.start();
  assert.strictEqual(extractServiceId('wss://gw/callback/ws/77'), '77');
  assert.strictEqual(ch.service, '77');

  // bot text message carrying a text-command approval
  const eventBody = {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: { chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: `批准 ${token}` }) },
      sender: { sender_id: { open_id: 'ou_1' } },
    },
  };
  ch.handleFrame(encodeFrame({
    method: 1, service: 77,
    headers: [{ key: 'type', value: 'event' }, { key: 'log_id', value: 'L1' }],
    payload: new Uint8Array(Buffer.from(JSON.stringify(eventBody))),
  }));

  // synchronous ACK: feedback frame mirrored log_id + payload before any processing
  const ack = decodeFrame(ch.ws.sent[0]);
  assert.strictEqual(headerMap(ack).type, 'feedback');
  assert.strictEqual(headerMap(ack).log_id, 'L1');
  assert.deepStrictEqual(Buffer.from(ack.payload).toString(), JSON.stringify(eventBody));

  await flush(); await flush();
  assert.strictEqual(calls.approval.length, 1, 'text command reached the dispatcher');
  assert.strictEqual(calls.approval[0].decision, 'approve');
  assert.strictEqual(calls.approval[0].payload.tool, 'Bash');
  assert.strictEqual(ch.chatId, 'oc_1', 'sticky reply chat recorded');

  // card.action.trigger button with the same token semantics (fresh token)
  const tok2 = tokens.issue({ kind: 'approval', tool: 'Git' });
  const cardBody = {
    header: { event_type: 'card.action.trigger' },
    event: { operator: { open_id: 'ou_1' }, action: { value: { action: 'deny', token: tok2 } } },
  };
  ch.handleFrame(encodeFrame({
    method: 1, service: 77,
    headers: [{ key: 'type', value: 'event' }, { key: 'log_id', value: 'L2' }],
    payload: new Uint8Array(Buffer.from(JSON.stringify(cardBody))),
  }));
  await flush(); await flush();
  assert.strictEqual(calls.approval.length, 2);
  assert.strictEqual(calls.approval[1].decision, 'deny');

  // gate ping → mirrored pong
  ch.handleFrame(encodeFrame({ headers: [{ key: 'type', value: 'ping' }, { key: 'wait', value: '30000' }] }));
  const pong = decodeFrame(ch.ws.sent[ch.ws.sent.length - 1]);
  assert.strictEqual(headerMap(pong).type, 'pong');
  await ch.stop();
});

it('feishu receiver: gzip event payloads inflate; non-text messages ignored; disconnect reports', async () => {
  const zlib = require('node:zlib');
  const endpoints = fakeFetch({ 'https://open.feishu.cn/callback/ws/endpoint': { body: { endpoint: 'wss://gw/callback/ws/1' } } });
  const disconnects = [];
  const inbound = [];
  const ch = new FeishuChannel({
    id: 'feishu', config: {}, secrets: fakeSecretsStore({ feishu: JSON.stringify({ appId: 'a', appSecret: 'b' }) }),
    log: () => {}, hooks: { notifyDisconnect: () => disconnects.push(1), onInbound: (m) => inbound.push(m) },
    deps: { WS: FakeWS, fetchImpl: endpoints },
  });
  await ch.start();

  const body = {
    header: { event_type: 'im.message.receive_v1' },
    event: { message: { chat_id: 'oc', message_type: 'text', content: JSON.stringify({ text: '你好' }) }, sender: { sender_id: { open_id: 'ou' } } },
  };
  const gz = new Uint8Array(zlib.gunzipSync(zlib.gzipSync(Buffer.from(JSON.stringify(body)))));
  ch.handleFrame(encodeFrame({
    headers: [{ key: 'type', value: 'event' }, { key: 'compression', value: 'gzip' }],
    payload: gz,
  }));
  await flush();
  assert.strictEqual(inbound.length, 1);
  assert.deepStrictEqual(inbound[0].command, { type: 'text', text: '你好' });

  // image message → ignored
  ch.handleFrame(encodeFrame({
    headers: [{ key: 'type', value: 'event' }],
    payload: new Uint8Array(Buffer.from(JSON.stringify({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_id: 'oc', message_type: 'image', content: '{}' }, sender: { sender_id: { open_id: 'ou' } } },
    }))),
  }));
  await flush();
  assert.strictEqual(inbound.length, 1);

  // socket death after online → notifyDisconnect fires exactly once
  ch.ws.close();
  assert.strictEqual(disconnects.length, 1);
  await ch.stop();
});

// ------------------------------------------------------------------- wecom

it('wecom: message and card-event parsing, button key dialect, card build, error classes', () => {
  const msg = parseWecomMessage({
    msgtype: 'text',
    text: { content: '@DshCockpit 批准 0123456789abcdef0123456789abcdef' },
    from: { userid: 'u1' },
  });
  assert.strictEqual(msg.senderId, 'u1');
  assert.strictEqual(msg.command.type, 'approve', 'mention stripped, command parsed');
  assert.strictEqual(msg.command.token, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(msg.replyTo, 'u1', 'DM replies target the userid');

  const group = parseWecomMessage({ msgtype: 'text', text: { content: 'hi' }, chatid: 'gc1', from: { userid: 'u1' } });
  assert.strictEqual(group.replyTo, 'gc1', 'group replies target the chatid');

  const card = parseWecomCardEvent({
    event: { eventtype: 'template_card_event', event_key: JSON.stringify({ action: 'approve', token: 'tok9' }) },
    from: { userid: 'u2' }, chatid: 'gc1',
  });
  assert.deepStrictEqual(card.command, { type: 'approve', token: 'tok9' });
  assert.strictEqual(parseWecomEventKey('garbage'), null);
  assert.strictEqual(parseWecomEventKey('approve|1234567890abcdef1234567890abcdef').action, 'approve', 'legacy pipe dialect');
  assert.strictEqual(parseWecomEventKey('approve|tok-not-hex'), null, 'non-hex token refused');

  const built = buildWecomCard({ title: '需要审批', body: 'B'.repeat(200), actions: [{ id: 'approve', label: '批准', token: 'tk' }, { id: 'deny', label: '拒绝', token: 'tk' }] });
  assert.strictEqual(built.card_type, 'button_interaction');
  assert.ok(built.sub_title_text.length <= 112, 'body clamped to the card budget');
  assert.strictEqual(built.button_list.length, 2);
  assert.deepStrictEqual(JSON.parse(built.button_list[0].key), { action: 'approve', token: 'tk' });
  assert.ok(built.task_id.includes('tk'), 'task_id derives from the unique token');
  assert.strictEqual(buildWecomCard({ title: 't', body: 'b' }).button_list, undefined, 'no actions → no buttons');

  assert.strictEqual(classifyWecomError(new Error('auth failed: bad secret')).kind, 'credentials');
  assert.strictEqual(classifyWecomError(new Error('connect ECONNREFUSED')).kind, 'network');
  assert.strictEqual(classifyWecomError(new Error('odd frame')).kind, 'protocol');
});

it('wecom channel: SDK adapter routes message.text and template_card_event into the pipeline', async () => {
  const { tokens, dispatch, calls } = makePipeline();
  const approvalToken = tokens.issue({ kind: 'approval', tool: 'Bash' });

  class FakeSDKClient extends EventEmitter {
    constructor(opts) { super(); this.opts = opts; this.sent = []; }
    connect() { setImmediate(() => this.emit('authenticated')); return this; }
    disconnect() { this.emit('disconnected', 'stopped'); }
    sendMessage(chatid, body) { this.sent.push({ chatid, body }); return Promise.resolve({}); }
  }
  const sdk = { WSClient: FakeSDKClient };

  const ch = new WecomChannel({
    id: 'wecom', config: {}, secrets: fakeSecretsStore({ wecom: JSON.stringify({ botId: 'b', secret: 's' }) }),
    log: () => {},
    hooks: {
      notifyDisconnect: () => {},
      onInbound: (m) => dispatch({ channelId: 'wecom', senderId: m.senderId, allowFrom: ['u1'], command: m.command }),
    },
    deps: { sdk },
  });
  await ch.start();

  ch.client.emit('message.text', { body: { msgtype: 'text', text: { content: `approve ${approvalToken}` }, chatid: 'gc1', from: { userid: 'u1' } } });
  await flush(); await flush();
  assert.strictEqual(calls.approval.length, 1);
  assert.strictEqual(calls.approval[0].payload.tool, 'Bash');

  const denyToken = tokens.issue({ kind: 'approval', tool: 'Git' });
  ch.client.emit('event.template_card_event', {
    body: { event: { eventtype: 'template_card_event', event_key: JSON.stringify({ action: 'deny', token: denyToken }) }, chatid: 'gc1', from: { userid: 'u1' } },
  });
  await flush(); await flush();
  assert.strictEqual(calls.approval.length, 2);
  assert.strictEqual(calls.approval[1].decision, 'deny');

  // outbound: text → markdown body, card → template_card body, to the sticky chat
  await ch.sendText('结果：完成');
  await ch.sendCard({ title: 't', body: 'b', actions: [] });
  assert.strictEqual(ch.client.sent.length, 2);
  assert.strictEqual(ch.client.sent[0].chatid, 'gc1');
  assert.strictEqual(ch.client.sent[0].body.msgtype, 'markdown');
  assert.strictEqual(ch.client.sent[1].body.msgtype, 'template_card');

  // stopped channel has no reply transport → readable rejection, never a
  // silent drop (the manager surfaces this as a send error state)
  await ch.stop();
  await assert.rejects(() => ch.sendText('x'), /no active chat/);
});

// ---------------------------------------------------------------- dingtalk

it('dingtalk sender: gateway/open probe + classified failures', async () => {
  const ok = fakeFetch({
    'https://api.dingtalk.com/v1.0/gateway/connections/open': { body: { endpoint: 'wss://wss-open-connection.dingtalk.com:443/connect', ticket: 'tk' } },
  });
  const r = await testDingtalkConnection({ clientId: 'c', clientSecret: 's', fetchImpl: ok });
  assert.deepStrictEqual(r, { ok: true });

  const bad = fakeFetch({
    'https://api.dingtalk.com/v1.0/gateway/connections/open': { status: 200, body: { code: 'invalidClientId', message: 'invalid client id' } },
  });
  const r2 = await testDingtalkConnection({ clientId: 'c', clientSecret: 's', fetchImpl: bad });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.kind, 'credentials');

  assert.strictEqual(classifyDingtalkError(Object.assign(new Error('x'), { status: 403 })).kind, 'credentials');
  assert.strictEqual(classifyDingtalkError(new Error('fetch failed: ECONNREFUSED')).kind, 'network');
  assert.strictEqual(classifyDingtalkError(new Error('strange')).kind, 'protocol');

  // the open call must carry the official {type, topic} subscriptions (B4)
  // and never log the secret
  const body = JSON.parse(ok.calls[0].body);
  assert.deepStrictEqual(body.subscriptions, [
    { type: 'EVENT', topic: '*' },
    { type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' },
    { type: 'CALLBACK', topic: '/v1.0/card/instances/callback' },
  ], 'subscriptions use the official {type, topic} shape');
  assert.strictEqual(body.clientId, 'c');
});

it('dingtalk receiver: official frames — ping echoes opaque, CALLBACK/EVENT ACK shapes, webhook capture, disconnect report', async () => {
  const { tokens, dispatch, calls } = makePipeline();
  const token = tokens.issue({ kind: 'approval', tool: 'Bash' });

  const open = fakeFetch({
    'https://api.dingtalk.com/v1.0/gateway/connections/open': { body: { endpoint: 'wss://dt/connect', ticket: 'tk1' } },
  });
  const disconnects = [];
  const ch = new DingtalkChannel({
    id: 'dingtalk', config: {}, secrets: fakeSecretsStore({ dingtalk: JSON.stringify({ clientId: 'c', clientSecret: 's' }) }),
    log: () => {},
    hooks: {
      notifyDisconnect: () => disconnects.push(1),
      onInbound: (m) => dispatch({ channelId: 'dingtalk', senderId: m.senderId, allowFrom: ['staff_1'], command: m.command }),
    },
    deps: { WS: FakeWS, fetchImpl: open },
  });
  await ch.start();
  assert.ok(ch.ws.url.includes('ticket=tk1'), 'endpoint URL carries the one-shot ticket');

  // server keepalive ping — official shape: SYSTEM frame whose data is a JSON
  // string carrying `opaque`; the response must echo it verbatim (B2) with
  // the request's messageId
  ch.handleRawFrame(JSON.stringify({
    type: 'SYSTEM',
    headers: { topic: 'ping', messageId: 'ping-1', contentType: 'application/json' },
    data: JSON.stringify({ opaque: 'abc-123' }),
  }));
  const pong = JSON.parse(ch.ws.sent[0]);
  assert.strictEqual(pong.code, 200);
  assert.strictEqual(pong.message, 'OK');
  assert.strictEqual(pong.headers.messageId, 'ping-1', 'ping response mirrors the request messageId');
  assert.strictEqual(pong.data, '{"opaque":"abc-123"}', 'opaque echoed verbatim');

  // bot message: official CALLBACK frame — data is a JSON string with the
  // @-mention + Chinese command + sessionWebhook
  ch.handleRawFrame(JSON.stringify({
    specVersion: '1.0',
    type: 'CALLBACK',
    headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'm-1', contentType: 'application/json' },
    data: JSON.stringify({
      msgtype: 'text',
      text: { content: ' @机器人 批准 ' + token },
      senderStaffId: 'staff_1',
      sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=xyz',
      sessionWebhookExpiredTime: Date.now() + 600_000,
    }),
  }));
  // ACK frame: official top-level response shape, messageId mirrored (B3)
  const ack = JSON.parse(ch.ws.sent[1]);
  assert.strictEqual(ack.code, 200);
  assert.strictEqual(ack.message, 'OK');
  assert.strictEqual(ack.headers.messageId, 'm-1');
  assert.deepStrictEqual(JSON.parse(ack.data), { response: {} }, 'CALLBACK data is {"response":{}}');
  await flush(); await flush();
  assert.strictEqual(calls.approval.length, 1, 'approved through the dispatcher');
  assert.strictEqual(ch.webhook, 'https://oapi.dingtalk.com/robot/sendBySession?session=xyz');

  // parse helpers: mention-stripping + card callback value routing
  const parsed = parseDingtalkMessage({ msgtype: 'text', text: { content: '@bot deny 0123456789abcdef0123456789abcdef' }, senderStaffId: 's2' });
  assert.strictEqual(parsed.command.type, 'deny');
  const card = parseDingtalkCardCallback({ content: { params: { action: 'answer', token: 'tk', text: 'yes' } }, senderStaffId: 's2' });
  assert.deepStrictEqual(card.command, { type: 'answer', token: 'tk', text: 'yes' });
  assert.strictEqual(parseDingtalkMessage({ msgtype: 'image' }), null);

  // EVENT frames ACK with {"status":"SUCCESS","message":"success"}
  const evt = buildAckFrame({ type: 'EVENT', headers: { messageId: 'e-1' } });
  assert.strictEqual(evt.code, 200);
  assert.strictEqual(evt.headers.messageId, 'e-1');
  assert.deepStrictEqual(JSON.parse(evt.data), { status: 'SUCCESS', message: 'success' });
  const cb = buildAckFrame({ type: 'CALLBACK', headers: { messageId: 'c-1' } });
  assert.strictEqual(cb.headers.messageId, 'c-1');
  assert.deepStrictEqual(JSON.parse(cb.data), { response: {} });

  // outbound via sessionWebhook: markdown body + official access-token header (B5)
  const send = fakeFetch({
    'https://oapi.dingtalk.com/robot/sendBySession': { body: { errcode: 0, errmsg: 'ok' } },
  });
  ch.fetchImpl = send;
  await ch.sendText('结果完成');
  assert.strictEqual(send.calls.length, 1);
  assert.strictEqual(send.calls[0].headers['x-acs-dingtalk-access-token'], 'c', 'Client ID sent as x-acs-dingtalk-access-token (B5)');
  assert.strictEqual(JSON.parse(send.calls[0].body).msgtype, 'markdown');

  // expired webhook refuses instead of firing a doomed request
  ch.webhookExpiresAt = 1;
  await assert.rejects(() => ch.sendText('late'), /expired/);

  ch.ws.close();
  assert.strictEqual(disconnects.length, 1);
  await ch.stop();
});

// ------------------------------------------------------- shared manager glue

it('transport: both dialing receivers default to the built-in WebSocket (no ws dependency)', () => {
  // Engineering constraint: `ws` the npm package is NOT a declared dependency
  // (only the official WeCom SDK pulls it for its own sockets); feishu and
  // dingtalk dial with the Node built-in WHATWG WebSocket instead.
  const feishu = new FeishuChannel({ id: 'feishu', config: {}, secrets: fakeSecretsStore(), log: () => {}, hooks: {} });
  const dingtalk = new DingtalkChannel({ id: 'dingtalk', config: {}, secrets: fakeSecretsStore(), log: () => {}, hooks: {} });
  assert.strictEqual(typeof WebSocket, 'function', 'runtime exposes the built-in WebSocket');
  assert.strictEqual(feishu.WS, WebSocket);
  assert.strictEqual(dingtalk.WS, WebSocket);
  assert.strictEqual(WebSocket.OPEN, 1);
});

it('manager: configureSecrets/hasSecrets/testChannel vault wiring + status surface', async () => {
  const dir = tmpDir();
  const settings = { imChannels: [], get: () => ({ imChannels: [] }), patch: () => {} };
  const logs = [];
  const mgr = createChannelManager({ userDataDir: dir, settings, safeStorage: null, log: (l) => logs.push(l), lang: () => 'zh' });

  const st0 = mgr.statusAll().find((c) => c.id === 'feishu');
  assert.strictEqual(st0.credentialsConfigured, false);
  assert.strictEqual(mgr.hasSecrets('feishu'), false);

  const saved = mgr.configureSecrets('feishu', { appId: 'a', appSecret: 'b' });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(mgr.hasSecrets('feishu'), true);
  assert.ok(mgr.statusAll().find((c) => c.id === 'feishu').credentialsConfigured);
  assert.ok(!logs.some((l) => l.includes('appSecret')), 'secrets never appear in logs');

  // testers route through the registered per-channel probe
  mgr.register('dingtalk', null, async (c) => (c.clientId === 'good' ? { ok: true } : { ok: false, kind: 'credentials', reason: 'bad id' }));
  assert.deepStrictEqual(await mgr.testChannel('dingtalk', { clientId: 'good' }), { ok: true });
  const bad = await mgr.testChannel('dingtalk', { clientId: 'bad' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.kind, 'credentials');
  const missing = await mgr.testChannel('dingtalk', null);
  assert.strictEqual(missing.ok, false, 'no stored credentials → readable failure');
  assert.strictEqual(mgr.configureSecrets('sms', {}).ok, false);
  assert.deepStrictEqual(mgr.configureSecrets('wecom', 'nope'), { ok: false, reason: 'bad-credentials' });

  // clear path
  assert.strictEqual(mgr.configureSecrets('feishu', null).ok, true);
  assert.strictEqual(mgr.hasSecrets('feishu'), false);
});

it('receiver→dispatcher: button and text commands flow through all three adapters with runtime routing fields', async () => {
  const dir = tmpDir();
  // production start paths only run for channels enabled in config (toggle /
  // startEnabled), so seed the store like the app would after a user enable
  const store = { imChannels: ['feishu', 'wecom', 'dingtalk'].map((id) => ({ id, type: id, enabled: true, allowFrom: [] })) };
  const approvals = [];
  const questions = [];
  const mgr = createChannelManager({
    userDataDir: dir,
    settings: { get: () => store, patch: (p) => Object.assign(store, p) },
    safeStorage: null,
    log: () => {},
    lang: () => 'zh',
    onApprovalDecision: (d) => { approvals.push(d); return { ok: true }; },
    onQuestionAnswer: (d) => { questions.push(d); return { ok: true }; },
  });

  // One recording implementation per platform slot; the manager wires hooks.
  const impls = {};
  const makeCtor = (name) => function Ctor({ hooks }) {
    impls[name] = this;
    this.hooks = hooks;
    this.supportsCards = true;
    this.cards = [];
    this.replies = [];
    this.start = async () => {};
    this.stop = async () => {};
    this.sendText = async (t) => { this.replies.push(t); };
    this.sendCard = async (c) => { this.cards.push(c); };
  };
  mgr.register('feishu', makeCtor('feishu'));
  mgr.register('wecom', makeCtor('wecom'));
  mgr.register('dingtalk', makeCtor('dingtalk'));
  mgr.setAllowFrom('feishu', 'ou_1');
  mgr.setAllowFrom('wecom', 'u1');
  mgr.setAllowFrom('dingtalk', 'staff_1');
  for (const id of ['feishu', 'wecom', 'dingtalk']) await mgr.startChannel(id);

  // broadcast: ONE token minted, shared by every channel's card buttons,
  // payload keeping the runtime routing fields for POST /api/respond
  mgr.broadcast({ kind: 'approval', tool: 'Bash', rpcId: 'rpc-1', sessionId: 's1', approvalId: 'ap1' });
  await flush(); await flush();
  for (const id of ['feishu', 'wecom', 'dingtalk']) {
    assert.strictEqual(impls[id].cards.length, 1, `${id} received the approval card`);
  }
  const token = impls.feishu.cards[0].actions.find((a) => a.id === 'approve').token;
  assert.ok(token, 'card actions embed the one-shot token');

  // button semantics: one adapter's click redeems the shared token
  impls.feishu.hooks.onInbound({ channelId: 'feishu', senderId: 'ou_1', command: { type: 'approve', token } });
  await flush(); await flush();
  assert.strictEqual(approvals.length, 1);
  assert.strictEqual(approvals[0].decision, 'approve');
  assert.strictEqual(approvals[0].tool, 'Bash');
  assert.strictEqual(approvals[0].payload.rpcId, 'rpc-1');
  assert.strictEqual(approvals[0].payload.sessionId, 's1');
  assert.strictEqual(approvals[0].payload.approvalId, 'ap1');

  // single-use: replaying the burned token through another adapter refuses
  impls.wecom.hooks.onInbound({ channelId: 'wecom', senderId: 'u1', command: { type: 'deny', token } });
  await flush(); await flush();
  assert.strictEqual(approvals.length, 1, 'token burned after first use');
  assert.ok(impls.wecom.replies.length >= 1, 'refusal replied in-band');

  // text-command semantics: question broadcast → 回答 <token> <text>
  mgr.broadcast({ kind: 'question', question: '用哪个分支？', rpcId: 'rpc-2', sessionId: 's2', questionId: 'q2' });
  await flush(); await flush();
  const qToken = impls.dingtalk.cards[1].actions.find((a) => a.id === 'answer').token;
  const cmd = parseCommandText(`回答 ${qToken} release`);
  assert.strictEqual(cmd.type, 'answer');
  impls.dingtalk.hooks.onInbound({ channelId: 'dingtalk', senderId: 'staff_1', command: cmd });
  await flush(); await flush();
  assert.strictEqual(questions.length, 1);
  assert.strictEqual(questions[0].text, 'release');
  assert.strictEqual(questions[0].payload.rpcId, 'rpc-2');

  mgr.stopAll();
});
