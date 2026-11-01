// test/ipc-misc-domains.test.js — Issue #22 Phase 1：plugins / search / quickask。
//
// 三个正交小域合并为一批。它们各自只有 1–2 个 handler，但都有
// **容易在提取中丢失的降级语义**：
//
//   plugins:search → 失败时 {ok:false, reason}，不抛
//   plugins:market → **两层** fallback：精选市场失败 → 回落 topic search →
//                    再失败才 {ok:false}。把两层塌成一层会让"精选市场挂了"
//                    直接变成"插件页面空白"，而实际还能用 topic search。
//   search:query   → 固定 20 条上限（不是调用方控制）
//   quickask:close → 是 `ipcMain.on`（单向、无返回值），**不是** handle。
//                    混用会让 renderer 的 send() 永远等不到响应。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerMiscDomainsIpc } = require('../src/ipc-misc-domains.js');

function fakeIpcMain() {
  const handles = new Map();
  const ons = new Map();
  return {
    handle(channel, fn) {
      if (handles.has(channel) || ons.has(channel)) throw new Error(`duplicate ${channel}`);
      handles.set(channel, fn);
    },
    on(channel, fn) {
      if (handles.has(channel) || ons.has(channel)) throw new Error(`duplicate ${channel}`);
      ons.set(channel, fn);
    },
    invoke(channel, ...args) {
      const fn = handles.get(channel);
      if (!fn) throw new Error(`no handle for ${channel}`);
      return fn({ sender: null }, ...args);
    },
    send(channel, ...args) {
      const fn = ons.get(channel);
      if (!fn) throw new Error(`no on-listener for ${channel}`);
      return fn({ sender: null }, ...args);
    },
    handleChannels() { return [...handles.keys()].sort(); },
    onChannels() { return [...ons.keys()].sort(); },
  };
}

function fakeCtx(overrides = {}) {
  const logs = [];
  const base = {
    fetchPlugins: async (kw) => [{ name: `plugin-for-${kw}` }],
    marketPayload: async (force) => ({ ok: true, source: 'curated', force, plugins: [] }),
    pluginAction: async (action, fullName) => ({ ok: true, action, fullName }),
    searchSessions: (home, q, limit) => ({ hits: [], home, q, limit }),
    dshHomeOf: () => '/tmp/dsh',
    handleQuickAskSubmit: async (prompt) => ({ ok: true, prompt }),
    closeQuickAsk: () => { logs.push('closed'); },
    log: (m) => { logs.push(m); },
  };
  return { ctx: { ...base, ...overrides }, logs };
}

function register(overrides) {
  const ipc = fakeIpcMain();
  const { ctx, logs } = fakeCtx(overrides);
  registerMiscDomainsIpc(ipc, ctx);
  return { ipc, logs };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-misc: registers 5 handles + 1 on-listener (the on/handle split is preserved)', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.handleChannels(), [
    'plugins:market', 'plugins:search', 'quickask:submit', 'search:query',
  ]);
  // quickask:close 是单向通道 —— 必须走 on()，不是 handle()
  assert.deepEqual(ipc.onChannels(), ['quickask:close'],
    'quickask:close must be a one-way listener; making it a handle breaks the renderer');
});

// -------------------------------------------------------------------- plugins

test('ipc-misc: plugins:search returns the plugin list', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('plugins:search', 'mcp');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.plugins[0].name, 'plugin-for-mcp');
});

test('ipc-misc: plugins:search converts a throwing fetcher into {ok:false}', async () => {
  const { ipc } = register({ fetchPlugins: async () => { throw new Error('npm offline'); } });
  const out = await ipc.invoke('plugins:search', 'x');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /npm offline/);
});

test('ipc-misc: plugins:market coerces the force flag to a boolean', async () => {
  let seen = null;
  const { ipc } = register({
    marketPayload: async (force) => { seen = force; return { ok: true }; },
  });
  await ipc.invoke('plugins:market', 'truthy');
  assert.strictEqual(seen, true);
});

test('ipc-misc: plugins:market falls back to topic search when the curated market fails', async () => {
  // 两层 fallback 的第一层：精选市场挂了不应让页面空白，
  // 而应回落到既有的 topic search。
  const { ipc, logs } = register({
    marketPayload: async () => { throw new Error('curated outage'); },
    fetchPlugins: async (kw) => [{ name: `fallback-${kw || 'all'}` }],
  });
  const out = await ipc.invoke('plugins:market', false);
  assert.strictEqual(out.ok, true, 'a curated outage must not blank the market');
  assert.strictEqual(out.source, 'fallback');
  assert.strictEqual(out.plugins[0].name, 'fallback-all');
  assert.ok(logs.some((l) => /curated market unavailable/.test(l)),
    'the outage must still be logged for post-mortem');
});

test('ipc-misc: plugins:market reports failure only when BOTH layers fail', async () => {
  const { ipc } = register({
    marketPayload: async () => { throw new Error('curated outage'); },
    fetchPlugins: async () => { throw new Error('search also down'); },
  });
  const out = await ipc.invoke('plugins:market', false);
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /search also down/);
});

// --------------------------------------------------------------------- search

test('ipc-misc: search:query caps results at 20 (the caller does not choose)', async () => {
  // 上限是主进程强制的，避免渲染进程用一个巨大的 limit 把主线程拖死。
  const { ipc } = register();
  const out = await ipc.invoke('search:query', 'foo');
  assert.strictEqual(out.limit, 20);
  assert.strictEqual(out.q, 'foo');
  assert.strictEqual(out.home, '/tmp/dsh');
});

// ------------------------------------------------------------------- quickask

test('ipc-misc: quickask:submit forwards the prompt and returns the result', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('quickask:submit', 'hello');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.prompt, 'hello');
});

test('ipc-misc: quickask:close is one-way (no return value expected)', () => {
  const { ipc, logs } = register();
  const ret = ipc.send('quickask:close');
  assert.strictEqual(ret, undefined, 'a one-way channel must not pretend to return data');
  assert.ok(logs.includes('closed'), 'the window must actually be closed');
});

// ---------------------------------------------------------------- 重复注册

test('ipc-misc: registering twice throws (no silent override)', () => {
  const ipc = fakeIpcMain();
  const { ctx } = fakeCtx();
  registerMiscDomainsIpc(ipc, ctx);
  assert.throws(() => registerMiscDomainsIpc(ipc, ctx), /duplicate/);
});
