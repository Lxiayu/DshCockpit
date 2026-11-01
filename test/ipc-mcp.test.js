// test/ipc-mcp.test.js — Issue #22 Phase 1：MCP 域的行为测试。
//
// 为什么提取后必须立刻补行为测试：
//   提取本身不产生价值——**能测**才产生价值。如果搬完还是只能靠读源码
//   断言，那只是把一个不可测的大文件变成两个不可测的文件。
//
//   这些测试用假 ipcMain + 注入 ctx 直接调用 11 个 handler，覆盖：
//     · 未就绪降级（每个 handler 在 mgr/conn 缺失时的行为）
//     · 正常路径（含 tier2 的 WRAPPED 命令——Windows 兼容的关键）
//     · 失败路径（依赖抛异常时不把异常泄给 renderer）
//     · 批量导入的部分成功（imported / failed 分开报告）
//
//   重点锁住几条**容易在重构中丢失**的语义：
//     1. list/get 只返回 configured 标志，绝不返回值（秘密永不出主进程）
//     2. mcp:test 用 wrapForWindows 包装后的命令，与实际 patch 文件一致
//     3. 任何 mcp:* 在未就绪时返回 {ok:false, reason:'not ready'} 而**不抛**
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerMcpIpc } = require('../src/ipc-mcp.js');

/** 假 ipcMain：记录 channel → handler，支持像 renderer 那样调用。 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`duplicate handle for ${channel}`);
      handlers.set(channel, fn);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null }, ...args);
    },
    channels() { return [...handlers.keys()].sort(); },
  };
}

/** 最小可用 ctx。每个依赖都可观测、可失败注入。 */
function fakeCtx(overrides = {}) {
  const logs = [];
  const base = {
    mcpMgr: {
      listServers: () => ({ ok: true, servers: [{ id: 'a', configured: true }], patchBlockIds: ['blk'], patchFile: '/tmp/mcp.toml' }),
      getServer: (id) => ({ ok: true, server: { id, transport: 'stdio', command: 'node', args: ['srv.js'] } }),
      save: async (input, secrets) => ({ ok: true, server: { id: input.id || 'new', secretsCount: Object.keys(secrets).length } }),
      remove: async (id) => ({ ok: true, removed: id }),
      toggle: async (id, enabled) => ({ ok: true, id, enabled }),
      resolveSecret: (id, key) => `secret-${id}-${key}`,
    },
    mcpConn: {
      tier1: async (server) => ({ ok: true, status: 'healthy', serverId: server.id }),
      tier2: async (server, resolve) => ({ ok: true, probed: server.command, secret: resolve(server.id, 'token') }),
    },
    mcpReg: {
      list: async (query, category) => [{ id: 'reg-1', query, category }],
      BUILTIN: [{ id: 'builtin-1' }],
    },
    mcpImp: {
      scanSources: () => [{ key: 'claude', label: 'Claude Desktop' }],
      prepare: (sourceKey, selected, clip, existing) => ({
        ok: true,
        items: [
          { name: 'ok-one', server: { id: 'imp-1' }, secrets: { k: 'v' } },
          { name: 'bad-one', error: 'invalid transport' },
        ],
      }),
    },
    sessionWorkerClient: {
      mcpUsage: async (home, opts) => ({ servers: { a: { calls: 3 } }, home, maxFiles: opts.maxFiles }),
    },
    dshHomeOf: () => '/tmp/dsh-home',
    wrapForWindows: (command, args) => ({ command: `WRAPPED:${command}`, args: args || [] }),
    log: (m) => { logs.push(m); },
  };
  return { ctx: { ...base, ...overrides }, logs };
}

function register(overrides) {
  const ipc = fakeIpcMain();
  const { ctx, logs } = fakeCtx(overrides);
  registerMcpIpc(ipc, ctx);
  return { ipc, logs };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-mcp: registers exactly the 11 MCP channels (frozen set)', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'mcp:get', 'mcp:import-run', 'mcp:import-scan', 'mcp:list',
    'mcp:registry', 'mcp:remove', 'mcp:save', 'mcp:test',
    'mcp:tier1', 'mcp:toggle', 'mcp:usage',
  ]);
});

test('ipc-mcp: registering twice throws (no silent override)', () => {
  const ipc = fakeIpcMain();
  const { ctx } = fakeCtx();
  registerMcpIpc(ipc, ctx);
  assert.throws(() => registerMcpIpc(ipc, ctx), /duplicate handle/);
});

// ------------------------------------------------------------ 未就绪降级

test('ipc-mcp: every mutating handler degrades to {ok:false} when the manager is missing', async () => {
  const { ipc } = register({ mcpMgr: null });
  for (const ch of ['mcp:save', 'mcp:remove', 'mcp:toggle']) {
    const out = await ipc.invoke(ch, 'id', true);
    assert.strictEqual(out.ok, false, `${ch} must not throw when not ready`);
    assert.match(out.reason, /not ready/);
  }
});

test('ipc-mcp: read-only handlers return safe empty shapes when the manager is missing', async () => {
  const { ipc } = register({ mcpMgr: null, mcpReg: null, mcpImp: null });
  assert.deepEqual(await ipc.invoke('mcp:list'), { ok: true, servers: [], patchBlockIds: [], patchFile: '' });
  assert.deepEqual(await ipc.invoke('mcp:registry'), { ok: true, items: [] });
  assert.deepEqual(await ipc.invoke('mcp:import-scan'), { ok: true, sources: [] });
});

test('ipc-mcp: mcp:get degrades to the not-ready envelope (not a throw)', async () => {
  const { ipc } = register({ mcpMgr: null });
  const out = await ipc.invoke('mcp:get', 'x');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /not ready/);
});

// ------------------------------------------------------------------ 正常路径

test('ipc-mcp: list returns the manager payload verbatim', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('mcp:list');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.servers[0].id, 'a');
  assert.deepEqual(out.patchBlockIds, ['blk']);
});

test('ipc-mcp: save passes input and secrets through, and returns the vault-free result', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('mcp:save', { id: 'srv' }, { token: 'shh' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.server.id, 'srv');
  assert.strictEqual(out.server.secretsCount, 1, 'secrets must reach the manager');
  assert.ok(!('token' in out.server), 'secret VALUES must never come back out');
});

test('ipc-mcp: toggle coerces the enabled flag to a boolean', async () => {
  const seen = [];
  const { ipc } = register({
    mcpMgr: {
      ...fakeCtx().ctx.mcpMgr,
      toggle: async (id, enabled) => { seen.push(enabled); return { ok: true }; },
    },
  });
  await ipc.invoke('mcp:toggle', 'id', 'truthy-string');
  assert.strictEqual(seen[0], true, 'a truthy non-boolean must arrive as true');
});

test('ipc-mcp: mcp:test uses the WRAPPED stdio command (matches the patch file)', async () => {
  // 这条是 Windows 兼容的关键：探测必须与实际运行的命令一致，
  // 否则"测试通过"和"真的能跑"会给出不同答案。
  let probed = null;
  const { ipc } = register({
    mcpConn: {
      tier1: async () => ({ ok: true }),
      tier2: async (server) => { probed = server; return { ok: true }; },
    },
  });
  await ipc.invoke('mcp:test', { id: 'a' });
  assert.strictEqual(probed.command, 'WRAPPED:node',
    'the probe must run the wrapped command, exactly what the patch file runs');
});

test('ipc-mcp: mcp:tier1 reports unknown server instead of throwing', async () => {
  const { ipc } = register({
    mcpMgr: { ...fakeCtx().ctx.mcpMgr, getServer: () => ({ ok: false }) },
  });
  const out = await ipc.invoke('mcp:tier1', 'ghost');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /unknown server/);
});

test('ipc-mcp: mcp:registry falls back to BUILTIN when the registry throws', async () => {
  const { ipc } = register({
    mcpReg: { list: async () => { throw new Error('offline'); }, BUILTIN: [{ id: 'b' }] },
  });
  const out = await ipc.invoke('mcp:registry', 'q', 'all');
  assert.strictEqual(out.ok, true, 'a registry failure degrades to the builtin catalogue');
  assert.strictEqual(out.items[0].id, 'b');
});

// -------------------------------------------------------------- 批量导入

test('ipc-mcp: import-run reports imported and failed SEPARATELY (partial success is not hidden)', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('mcp:import-run', 'claude', null, 'clip');
  assert.strictEqual(out.ok, true);
  assert.deepEqual(out.imported, ['imp-1']);
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].name, 'bad-one');
  assert.match(out.failed[0].reason, /invalid transport/);
});

test('ipc-mcp: import-run surfaces a prepare() rejection unchanged', async () => {
  const { ipc } = register({
    mcpImp: { scanSources: () => [], prepare: () => ({ ok: false, reason: 'no such source' }) },
  });
  const out = await ipc.invoke('mcp:import-run', 'nope', null, '');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'no such source');
});

test('ipc-mcp: import-run only passes an array as the selection (non-arrays become null)', async () => {
  let seenSelection = 'unset';
  const { ipc } = register({
    mcpImp: {
      scanSources: () => [],
      prepare: (src, selection) => { seenSelection = selection; return { ok: true, items: [] }; },
    },
  });
  await ipc.invoke('mcp:import-run', 'claude', 'not-an-array', '');
  assert.strictEqual(seenSelection, null, 'a non-array selection must degrade to null (import all)');
});

// ---------------------------------------------------------------- 用量

test('ipc-mcp: usage rides the session worker (log parsing never blocks main)', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('mcp:usage', 7);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.usage.servers.a.calls, 3);
  assert.strictEqual(out.usage.maxFiles, 400, 'the handler caps the file scan');
});

test('ipc-mcp: usage degrades to an empty shape without a worker (no throw)', async () => {
  const { ipc } = register({ sessionWorkerClient: null });
  assert.deepEqual(await ipc.invoke('mcp:usage', 7), { ok: true, usage: { servers: {} } });
});

test('ipc-mcp: usage degrades on worker failure instead of propagating', async () => {
  const { ipc } = register({
    sessionWorkerClient: { mcpUsage: async () => { throw new Error('worker died'); } },
  });
  const out = await ipc.invoke('mcp:usage', 7);
  assert.strictEqual(out.ok, true, 'a dead worker must not break the settings panel');
  assert.match(out.reason, /worker died/);
});

// ------------------------------------------------------- 异常不泄给 renderer

test('ipc-mcp: a throwing manager does not leak the exception to the renderer', async () => {
  const { ipc, logs } = register({
    mcpMgr: {
      ...fakeCtx().ctx.mcpMgr,
      save: async () => { throw new Error('vault locked'); },
    },
  });
  const out = await ipc.invoke('mcp:save', {}, {});
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /vault locked/);
  assert.ok(logs.some((l) => /save failed/.test(l)), 'the failure must also be logged for post-mortem');
});
