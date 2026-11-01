// test/ipc-features.test.js — Issue #22 Phase 0：已抽出域的行为测试。
//
// 第一性原理：为什么先测 ipc-features.js 而不是继续拆 main.js
//
//   src/ipc-features.js 是**唯一**已经用依赖注入抽出 main.js 的域
//   （`registerFeatureIpc(ipcMain, ctx)`），但在此之前**一个测试都没有**。
//   它同时也是一个范本：后续每个域都应该长成这个样子。
//
//   所以 Phase 0 的顺序是：
//     1. 先给"已抽出且依赖可注入"的模块建真实行为测试（本文件）
//     2. 再给 main.js 的通道集合建契约快照（ipc-contract.test.js）
//     3. 有了这两层安全网，才开始逐域提取
//
//   这符合用户要求："行为测试先行、小步提取，不进行一次性大规模重构"。
//
// 测试方式：用一个假的 ipcMain 收集注册的 handler，然后用可控的 ctx 直接调用。
// 全程不 require('electron')，在纯 Node 下跑。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { registerFeatureIpc } = require('../src/ipc-features.js');

const ROOT = path.join(__dirname, '..');

/**
 * 假的 ipcMain：记录 channel -> handler，并允许我们像 renderer 那样调用。
 * 这正是 DI 带来的可测试性 —— 不需要启动 Electron。
 */
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

/** 最小可用 ctx：每个依赖都可观测，失败可注入。 */
function fakeCtx(overrides = {}) {
  const calls = { notify: [], shellOpen: [] };
  const base = {
    bootCheck: {
      readReport: () => ({ summary: { passed: 3, total: 3 } }),
      reportFile: () => '/tmp/boot-report.json',
      runChecks: async () => ({ summary: { passed: 4, total: 4 }, deep: true }),
      repair: async (ids) => ({ repaired: ids || ['credentials'], report: { summary: { passed: 4, total: 4 } } }),
    },
    nc: {
      list: ({ query, kind, limit } = {}) => [{ id: 1, query, kind, limit }],
      clear: () => ({ cleared: 2 }),
    },
    weeklyGet: () => null,
    channelsGet: () => null,
    collectStats: () => ({ tokens: 1 }),
    buildCacheEconomics: () => ({ month: { savedYuan: 1.5 } }),
    pricingFromSettings: () => ({ peakEnabled: false }),
    settingsGet: () => ({ lang: 'zh' }),
    compatStatus: { getStatus: async () => ({ ok: true, compatible: true }) },
    shellOpen: (p) => { calls.shellOpen.push(p); },
    appGetPath: (k) => `/tmp/${k}`,
    notify: (title, body) => { calls.notify.push({ title, body }); },
    t: (lang, key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`,
    lang: () => 'zh',
    log: () => {},
  };
  return { ctx: { ...base, ...overrides }, calls };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-features: registers exactly the feature domains it owns (no creep)', () => {
  const ipc = fakeIpcMain();
  const { ctx } = fakeCtx();
  registerFeatureIpc(ipc, ctx);
  assert.deepEqual(ipc.channels(), [
    'boot:repair', 'boot:report', 'boot:rerun',
    'cache-economics:summary',
    'compat:status',
    'notifications:clear', 'notifications:list',
    'weekly:generate', 'weekly:list', 'weekly:open-dir', 'weekly:push',
  ], 'the feature domain owns 5 namespaces: boot / cache-economics / compat / notifications / weekly');
});

test('ipc-features: registering twice throws (no silent override)', () => {
  const ipc = fakeIpcMain();
  const { ctx } = fakeCtx();
  registerFeatureIpc(ipc, ctx);
  assert.throws(() => registerFeatureIpc(ipc, ctx), /duplicate handle/);
});

// ------------------------------------------------------------------ boot 域

test('boot:report returns the cached report and its file path', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx().ctx);
  const out = await ipc.invoke('boot:report');
  assert.strictEqual(out.ok, true);
  assert.deepEqual(out.report.summary, { passed: 3, total: 3 });
  assert.strictEqual(out.file, '/tmp/boot-report.json');
});

test('boot:rerun always runs a DEEP check', async () => {
  let sawDeep = null;
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({
    bootCheck: {
      readReport: () => ({}), reportFile: () => '',
      runChecks: async (opts) => { sawDeep = opts && opts.deep; return { summary: { passed: 1, total: 1 } }; },
      repair: async () => ({ repaired: [], report: { summary: {} } }),
    },
  }).ctx);
  await ipc.invoke('boot:rerun');
  assert.strictEqual(sawDeep, true, 'a manual rerun must be a full deep check, not a shallow one');
});

test('boot:repair notifies the user when something was actually repaired', async () => {
  const { ctx, calls } = fakeCtx();
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, ctx);
  const out = await ipc.invoke('boot:repair', ['credentials']);
  assert.strictEqual(out.ok, true);
  assert.deepEqual(out.repaired, ['credentials']);
  assert.strictEqual(calls.notify.length, 1, 'a completed repair must surface a notification');
});

test('boot:repair does NOT notify when nothing was repaired (no noise)', async () => {
  const { ctx, calls } = fakeCtx({
    bootCheck: {
      readReport: () => ({}), reportFile: () => '', runChecks: async () => ({}),
      repair: async () => ({ repaired: [], report: { summary: { passed: 4, total: 4 } } }),
    },
  });
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, ctx);
  await ipc.invoke('boot:repair', []);
  assert.strictEqual(calls.notify.length, 0, 'an empty repair must stay silent');
});

test('boot:repair tolerates a non-array ids argument (defensive)', async () => {
  let received = 'unset';
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({
    bootCheck: {
      readReport: () => ({}), reportFile: () => '', runChecks: async () => ({}),
      repair: async (ids) => { received = ids; return { repaired: [], report: { summary: {} } }; },
    },
  }).ctx);
  await ipc.invoke('boot:repair', 'not-an-array');
  assert.strictEqual(received, undefined, 'a non-array must degrade to "repair everything" (undefined), not crash');
});

// ------------------------------------------------------- notifications 域

test('notifications:list forwards the query/kind/limit triple unchanged', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx().ctx);
  const out = await ipc.invoke('notifications:list', 'deploy', 'error', 10);
  assert.strictEqual(out.ok, true);
  assert.deepEqual(out.items[0], { id: 1, query: 'deploy', kind: 'error', limit: 10 });
});

test('notifications:clear returns the hub result', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx().ctx);
  const out = await ipc.invoke('notifications:clear');
  assert.deepEqual(out, { cleared: 2 });
});

// ------------------------------------------------------------ weekly 域

test('weekly:generate reports {ok:false} with a reason when the weekly service is not ready', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => null }).ctx);
  const out = await ipc.invoke('weekly:generate');
  assert.strictEqual(out.ok, false, 'a missing service must be an honest failure, not a fake success');
  assert.match(out.reason, /not ready/);
});

test('weekly:generate surfaces the generated file and data', async () => {
  const weekly = {
    generate: async () => ({ file: '/tmp/weekly.md', data: { weekLabel: '2026-W44', costYuan: 12.3, tasksDone: 2, quickAsks: 5, cacheSavedYuan: 1.1, topWorkspace: 'proj' } }),
    buildData: async () => ({ weekLabel: '2026-W44' }),
    listFiles: () => ['/tmp/weekly.md'],
  };
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => weekly }).ctx);
  const out = await ipc.invoke('weekly:generate');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.file, '/tmp/weekly.md');
  assert.strictEqual(out.data.weekLabel, '2026-W44');
});

test('weekly:open-dir opens the weekly directory under userData', async () => {
  const { ctx, calls } = fakeCtx();
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, ctx);
  const out = await ipc.invoke('weekly:open-dir');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.shellOpen.length, 1);
  assert.match(calls.shellOpen[0], /weekly$/, 'must open <userData>/weekly');
});

test('weekly:push reports not-ready instead of throwing', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => null }).ctx);
  const out = await ipc.invoke('weekly:push');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /not ready/);
});

test('weekly:push renders a Chinese summary when lang() is zh', async () => {
  const weekly = {
    generate: async () => ({ file: '/tmp/w.md', data: { weekLabel: '2026-W44', costYuan: 1, tasksDone: 1, quickAsks: 1, cacheSavedYuan: 0, topWorkspace: 'p' } }),
    buildData: async () => ({}), listFiles: () => [],
  };
  let sent = null;
  const channelsMgr = { broadcastText: async (text) => { sent = text; } };
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => weekly, lang: () => 'zh', channelsGet: () => channelsMgr }).ctx);
  const out = await ipc.invoke('weekly:push');
  assert.strictEqual(out.ok, true);
  assert.ok(sent, 'the summary must actually be broadcast');
  assert.match(sent, /周报/, 'zh summary must be Chinese');
});

test('weekly:push renders an English summary when lang() is en', async () => {
  const weekly = {
    generate: async () => ({ file: '/tmp/w.md', data: { weekLabel: '2026-W44', costYuan: 1, tasksDone: 1, quickAsks: 1, cacheSavedYuan: 0, topWorkspace: 'p' } }),
    buildData: async () => ({}), listFiles: () => [],
  };
  let sent = null;
  const channelsMgr = { broadcastText: async (text) => { sent = text; } };
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => weekly, lang: () => 'en', channelsGet: () => channelsMgr }).ctx);
  const out = await ipc.invoke('weekly:push');
  assert.strictEqual(out.ok, true);
  assert.match(sent, /Weekly/, 'en summary must be English');
});

test('weekly:push reports channels-unavailable instead of throwing', async () => {
  const weekly = {
    generate: async () => ({ file: '/tmp/w.md', data: { weekLabel: 'W44', costYuan: 0, tasksDone: 0, quickAsks: 0, cacheSavedYuan: 0, topWorkspace: '' } }),
    buildData: async () => ({}), listFiles: () => [],
  };
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ weeklyGet: () => weekly, channelsGet: () => null }).ctx);
  const out = await ipc.invoke('weekly:push');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /channels unavailable/);
});

// ----------------------------------------------------- cache / compat 域

test('cache-economics:summary maps the builder output into the IPC shape', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({ buildCacheEconomics: () => ({ month: { savedYuan: 9.9 }, byDay: [] }) }).ctx);
  const out = await ipc.invoke('cache-economics:summary');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.month.savedYuan, 9.9);
});

test('cache-economics:summary converts a throwing builder into {ok:false}', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({
    buildCacheEconomics: () => { throw new Error('corrupt session log'); },
  }).ctx);
  const out = await ipc.invoke('cache-economics:summary');
  assert.strictEqual(out.ok, false, 'a throwing dependency must not propagate to the renderer');
  assert.match(out.reason, /corrupt session log/);
});

test('compat:status passes the compatStatus result straight through', async () => {
  const ipc = fakeIpcMain();
  registerFeatureIpc(ipc, fakeCtx({
    compatStatus: { getStatus: async () => ({ ok: true, compatible: false, verified: true, fresh: false }) },
  }).ctx);
  const out = await ipc.invoke('compat:status');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.verified, true);
  assert.strictEqual(out.fresh, false, 'the three-state verdict must survive the IPC boundary');
});

// ------------------------------------------------------------ DI 完整性

test('ipc-features: a missing required dependency fails loudly at registration', () => {
  const ipc = fakeIpcMain();
  // 缺 t/lang 会让 handler 在**调用时**才炸——但缺 ipcMain 必须立刻炸。
  assert.throws(() => registerFeatureIpc(null, {}), /Cannot read|undefined|null/);
});
