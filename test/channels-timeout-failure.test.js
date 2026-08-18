// test/channels-timeout-failure.test.js — IM channels: failure & timeout paths.
//
// Targeted at the "what if it goes wrong" surface the happy-path suites
// (channels.test.js / channels-c6.test.js) don't exercise:
//   - channel-manager: testChannel error classification, outbound send failures
//     (transport error → disconnect → backoff), idempotent stop, offline
//     broadcast policy while connecting
//   - feishu: endpoint fetch failure and pre-open ws errors reject start()
//   - wecom: authentication timeout rejects start()
//   - dingtalk: gateway/open failure rejects start(); heartbeat death forces a
//     disconnect notification (reconnect state machine)
// Zero real sockets/network; timers, ws and fetch are injected.
'use strict';

const { test: it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChannelManager } = require('../src/channels/channel-manager');
const { FeishuChannel } = require('../src/channels/receivers/feishu');
const { WecomChannel } = require('../src/channels/receivers/wecom');
const { DingtalkChannel } = require('../src/channels/receivers/dingtalk');

// ---------------------------------------------------------------- helpers

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-channels-fail-'));
}

const flush = () => new Promise((r) => setImmediate(r));

function fakeTimers() {
  const pending = new Map();
  const delays = [];
  let seq = 0;
  return {
    delays,
    setTimeout(fn, ms) { seq += 1; pending.set(seq, fn); delays.push(ms); return seq; },
    clearTimeout(id) { pending.delete(id); },
    fire(id) { const fn = pending.get(id); if (fn) { pending.delete(id); fn(); } },
  };
}

function fakeSettings(initial = []) {
  const store = { imChannels: initial.map((c) => ({ allowFrom: [], enabled: false, ...c })) };
  return { get: () => store, patch: (p) => Object.assign(store, p) };
}

function makeManager(opts = {}) {
  const ft = fakeTimers();
  const settings = fakeSettings(opts.configs || []);
  const mgr = createChannelManager({
    userDataDir: opts.dir || tmpDir(),
    settings,
    safeStorage: null,
    log: () => {},
    lang: () => 'zh',
    timers: ft,
  });
  return { mgr, ft, settings };
}

/** WHATWG-style ws fake that auto-opens on construction. */
class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    setImmediate(() => { this.readyState = 1; if (this.onopen) this.onopen(); });
  }
  send(data) { this.sent.push(data); }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}
FakeWS.OPEN = 1;

/** fetch stub: routes by URL prefix; anything unmatched → 404. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET' });
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
  };
}

// ------------------------------------------------ manager failure surfaces

it('manager.testChannel: missing credentials → kind=credentials', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: false }] });
  mgr.register('feishu', function C() { this.start = async () => {}; }, async () => ({ ok: true }));
  const r = await mgr.testChannel('feishu', undefined); // no stored secrets either
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'credentials');
});

it('manager.testChannel: no test path registered → kind=protocol', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: false }] });
  mgr.register('feishu', function C() { this.start = async () => {}; }); // no tester
  mgr.configureSecrets('feishu', { appId: 'a', appSecret: 'b' });
  const r = await mgr.testChannel('feishu', undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'protocol');
  assert.match(r.reason, /no-test-path/);
});

it('manager.testChannel: tester throw → kind=protocol with the message', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: false }] });
  mgr.register('feishu', function C() { this.start = async () => {}; }, async () => { throw new Error('probe blew up'); });
  mgr.configureSecrets('feishu', { appId: 'a', appSecret: 'b' });
  const r = await mgr.testChannel('feishu', undefined);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'protocol');
  assert.match(r.reason, /probe blew up/);
});

it('manager: an outbound send failure takes the channel down into backoff', async () => {
  const { mgr, ft } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  function FailSender() {
    this.start = async () => {};
    this.stop = async () => {};
    this.supportsCards = true;
    this.sendCard = async () => { throw new Error('transport write failed'); };
    this.sendText = async () => { throw new Error('transport write failed'); };
  }
  mgr.register('feishu', FailSender);
  const r = await mgr.startChannel('feishu');
  assert.strictEqual(r.ok, true);
  const before = ft.delays.length;
  mgr.broadcast({ kind: 'taskDone' });
  await flush(); await flush(); await flush();
  assert.ok(ft.delays.length > before, 'reconnect scheduled after send failure');
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'backoff');
  mgr.stopAll();
});

it('manager.stopChannel is idempotent for a channel that never started', () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: false }] });
  assert.doesNotThrow(() => mgr.stopChannel('feishu'));
  const st = mgr.statusAll().find((c) => c.id === 'feishu').status;
  assert.strictEqual(st.state, 'offline');
});

it('manager: approval/question broadcast while connecting is dropped, not queued', async () => {
  const { mgr } = makeManager({ configs: [{ id: 'feishu', enabled: true }] });
  // a slow impl: start() never settles during the broadcast
  mgr.register('feishu', function SlowCtor() {
    this.start = () => new Promise(() => {}); // never resolves
    this.stop = async () => {};
  });
  mgr.startChannel('feishu'); // fire-and-forget: stuck in connecting
  await flush();
  mgr.broadcast({ kind: 'approval', tool: 'Bash' });
  mgr.broadcast({ kind: 'question', question: 'q?' });
  await flush();
  assert.strictEqual(mgr.queue.size, 0, 'approval/question never queue (dead buttons)');
  assert.ok(mgr.queue.droppedCount >= 2, 'dropped and audited');
  mgr.stopAll();
});

// ------------------------------------------------------------ feishu fails

it('feishu: endpoint fetch failure rejects start() with a readable error', async () => {
  const ch = new FeishuChannel({
    id: 'feishu', config: {}, secrets: fakeSecretsStore({ feishu: JSON.stringify({ appId: 'a', appSecret: 's' }) }),
    log: () => {}, hooks: {},
    deps: { WS: FakeWS, fetchImpl: fakeFetch() }, // 404 for the endpoint
  });
  await assert.rejects(ch.start(), /ws endpoint failed: HTTP 404/);
});

it('feishu: ws error before open rejects start() (network-shaped)', async () => {
  class BrokenWS {
    constructor() {
      this.readyState = 0; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      setImmediate(() => { if (this.onerror) this.onerror({ error: new Error('ECONNREFUSED') }); });
    }
  }
  const ch = new FeishuChannel({
    id: 'feishu', config: {}, secrets: fakeSecretsStore({ feishu: JSON.stringify({ appId: 'a', appSecret: 's' }) }),
    log: () => {}, hooks: {},
    deps: {
      WS: BrokenWS,
      fetchImpl: fakeFetch({ 'https://open.feishu.cn/callback/ws/endpoint': { status: 200, body: { endpoint: 'wss://gw/x' } } }),
    },
  });
  await assert.rejects(ch.start(), /feishu ws:/);
});

// -------------------------------------------------------------- wecom fails

it('wecom: authentication timeout rejects start()', async () => {
  const sdk = {
    WSClient: class {
      constructor() { this._cbs = {}; }
      once(ev, cb) { this._cbs[ev] = cb; }
      connect() { /* never authenticates nor disconnects */ }
    },
  };
  const ch = new WecomChannel({
    id: 'wecom', config: {}, secrets: fakeSecretsStore({ wecom: JSON.stringify({ botId: 'b', secret: 's' }) }),
    log: () => {}, hooks: {},
    deps: { sdk, authTimeoutMs: 30 },
  });
  await assert.rejects(ch.start(), /authenticate timeout/);
});

// ----------------------------------------------------------- dingtalk fails

it('dingtalk: gateway/open probe failure rejects start()', async () => {
  const ch = new DingtalkChannel({
    id: 'dingtalk', config: {}, secrets: fakeSecretsStore({ dingtalk: JSON.stringify({ clientId: 'c', clientSecret: 's' }) }),
    log: () => {}, hooks: {},
    deps: { WS: FakeWS, fetchImpl: fakeFetch() }, // gateway 404
  });
  await assert.rejects(ch.start());
});

it('dingtalk: heartbeat death forces a disconnect notification', async () => {
  let clock = 1_000_000;
  const down = [];
  const ch = new DingtalkChannel({
    id: 'dingtalk', config: {}, secrets: fakeSecretsStore({ dingtalk: JSON.stringify({ clientId: 'c', clientSecret: 's' }) }),
    log: () => {},
    hooks: { notifyDisconnect: (id) => down.push(id) },
    deps: {
      WS: FakeWS,
      fetchImpl: fakeFetch({ 'https://api.dingtalk.com/v1.0/gateway/connections/open': { body: { endpoint: 'wss://g/x', ticket: 'tk' } } }),
      now: () => clock,
      heartbeatIntervalMs: 20,
    },
  });
  await ch.start();
  assert.strictEqual(ch.lastPingAt, clock, 'last ping timestamp set on open');
  clock += 200_000; // well past HEARTBEAT_DEAD_MS (120s)
  await new Promise((r) => setTimeout(r, 60)); // let the 20ms heartbeat tick fire
  assert.ok(down.includes('dingtalk'), 'notifyDisconnect fired after heartbeat death');
  ch.stop();
});
