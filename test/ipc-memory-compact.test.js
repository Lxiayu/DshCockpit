// test/ipc-memory-compact.test.js — Issue #22 Phase 1：长会话中心（C3）。
//
// 第一性原理：为什么 memory 与 compact 合并成一个批次
//
//   它们单独看都很小（3+3 个 handler），但**产品语义上是同一件事**：
//   compact 压缩上下文，memory 把结论落进 AGENTS.md——都是"长会话中心"。
//   分成两个文件会让这个概念在代码里没有归属。
//
// 第二性原理：为什么 compactNow 不是纯接线
//
//   它含三段业务判断：
//     1. busy 判定（会话在跑 或 已在压缩 → 拒绝）
//     2. runtime 未就绪 → 返回 distinct code 'runtime-offline'
//        （不是通用失败：UI 要区分"没开"和"失败了"）
//     3. RPC 失败时**必须发通知**（只 log 的话用户点了没反应，以为按钮坏了）
//
// 本套件特别锁住 sessionRunning 的**实时性**：
//   它是 mux session-status frame 更新的可变变量。
//   若注入时缓存成常量，"运行中"会永远停在启动那一刻，
//   于是 busy 判定永远失效——压缩会在会话运行中被触发。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerMemoryCompactIpc } = require('../src/ipc-memory-compact.js');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
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

function fakeCtx(over = {}) {
  const state = { notifications: [], logs: [], sessionRunning: false, tracker: null };
  const base = {
    memory: {
      get: (scope) => ({ ok: true, scope, exists: true, content: `# ${scope}` }),
      save: async (scope, content) => ({ ok: true, scope, path: `/ws/${scope}-AGENTS.md` }),
      remove: async (scope) => ({ ok: true, scope, path: `/ws/${scope}-AGENTS.md` }),
    },
    compactNow: async () => ({ ok: true, sessionId: 'sess-h-abc' }),
    getCompactTracker: () => state.tracker,
    // 关键：getter，不是常量
    isSessionRunning: () => state.sessionRunning,
    notify: (title, body) => { state.notifications.push({ title, body }); },
    t: (lang, key, vars) => (vars ? `${key}|${JSON.stringify(vars)}` : key),
    lang: () => 'zh',
    log: (m) => { state.logs.push(m); },
  };
  return { ctx: { ...base, ...over }, state };
}

function register(over) {
  const ipc = fakeIpcMain();
  const { ctx, state } = fakeCtx(over);
  registerMemoryCompactIpc(ipc, ctx);
  return { ipc, state };
}

// ------------------------------------------------------------------ 注册范围

test('ipc-memory-compact: registers the 6 long-session channels', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'shell:compact-history', 'shell:compact-now', 'shell:compact-status',
    'shell:memory-delete', 'shell:memory-get', 'shell:memory-save',
  ]);
});

// ------------------------------------------- sessionRunning 必须实时

test('ipc-memory-compact: compact-status reflects the LIVE sessionRunning value', async () => {
  // 这是最容易在提取中破坏的点：把 sessionRunning 当常量捕获，
  // 状态就永远停在启动那一刻，busy 判定随之失效。
  const { ipc, state } = register();

  state.sessionRunning = false;
  let out = await ipc.invoke('shell:compact-status');
  assert.strictEqual(out.sessionRunning, false);

  state.sessionRunning = true;
  out = await ipc.invoke('shell:compact-status');
  assert.strictEqual(out.sessionRunning, true, 'the status must re-read the live flag each call');

  state.sessionRunning = false;
  out = await ipc.invoke('shell:compact-status');
  assert.strictEqual(out.sessionRunning, false);
});

test('ipc-memory-compact: compact-status tolerates a null tracker', async () => {
  const { ipc, state } = register();
  state.tracker = null;
  const out = await ipc.invoke('shell:compact-status');
  assert.strictEqual(out.compacting, false);
  assert.strictEqual(out.last, null);
});

test('ipc-memory-compact: compact-status reports the most recent history entry', async () => {
  const { ipc, state } = register();
  state.tracker = {
    isCompacting: () => true,
    history: () => [{ atMs: 2 }, { atMs: 1 }],
  };
  const out = await ipc.invoke('shell:compact-status');
  assert.strictEqual(out.compacting, true);
  assert.deepStrictEqual(out.last, { atMs: 2 }, 'the newest entry, not the oldest');
});

test('ipc-memory-compact: compact-history is empty when there is no tracker', async () => {
  const { ipc } = register();
  assert.deepStrictEqual(await ipc.invoke('shell:compact-history'), []);
});

test('ipc-memory-compact: compact-history forwards the tracker history', async () => {
  const { ipc, state } = register();
  state.tracker = { isCompacting: () => false, history: () => [{ atMs: 1 }, { atMs: 2 }] };
  const out = await ipc.invoke('shell:compact-history');
  assert.strictEqual(out.length, 2);
});

// --------------------------------------------------------- compactNow 契约

test('ipc-memory-compact: compact-now returns the busy verdict from the operation', async () => {
  // busy/runtime-offline 的判定在 compactNow 内部（那里能同时看到会话状态与
  // runtime URL）。IPC 层只负责转发 —— 在这里重复判定会导致两处规则漂移。
  const { ipc } = register({
    compactNow: async () => ({ ok: false, code: 'busy', reason: 'compact.busy' }),
  });
  const out = await ipc.invoke('shell:compact-now');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'busy');
});

test('ipc-memory-compact: compact-now surfaces runtime-offline as a DISTINCT code', async () => {
  // UI 要区分"没开 runtime"和"压缩失败了"——合并成一个 code 就没法给出正确引导。
  const { ipc } = register({
    compactNow: async () => ({ ok: false, code: 'runtime-offline', reason: 'compact.noWindow' }),
  });
  const out = await ipc.invoke('shell:compact-now');
  assert.strictEqual(out.code, 'runtime-offline');
});

test('ipc-memory-compact: compact-now passes success through unchanged', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:compact-now');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.sessionId, 'sess-h-abc');
});

// ------------------------------------------------------------- memory 域

test('ipc-memory-compact: memory-get forwards the scope', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:memory-get', 'project');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.scope, 'project');
});

test('ipc-memory-compact: a missing scope becomes an empty string (not "undefined")', async () => {
  let seen = null;
  const { ipc } = register({
    memory: { get: (scope) => { seen = scope; return { ok: true }; }, save: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
  });
  await ipc.invoke('shell:memory-get');
  assert.strictEqual(seen, '', 'a missing scope must degrade to "", never the literal "undefined"');
});

test('ipc-memory-compact: a successful save notifies with the file path', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:memory-save', 'project', '# 内容');
  assert.strictEqual(state.notifications.length, 1);
  assert.match(state.notifications[0].body, /\/ws\/project-AGENTS\.md/);
});

test('ipc-memory-compact: a FAILED save logs but does NOT notify', async () => {
  // 失败通知由 UI 的内联错误承担；再弹系统通知会重复打扰。
  const { ipc, state } = register({
    memory: {
      get: () => ({ ok: true }), remove: async () => ({ ok: true }),
      save: async () => ({ ok: false, code: 'denied', reason: 'path outside whitelist' }),
    },
  });
  const out = await ipc.invoke('shell:memory-save', 'project', 'x');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(state.notifications.length, 0, 'a failed save must not claim success via notification');
  assert.ok(state.logs.some((l) => /\[memory\] save failed/.test(l)), 'but it must be logged for post-mortem');
});

test('ipc-memory-compact: non-string content degrades to empty (never "undefined" text)', async () => {
  let seen = null;
  const { ipc } = register({
    memory: {
      get: () => ({ ok: true }), remove: async () => ({ ok: true }),
      save: async (scope, content) => { seen = content; return { ok: true, path: '/x' }; },
    },
  });
  await ipc.invoke('shell:memory-save', 'project', { not: 'a string' });
  assert.strictEqual(seen, '', 'a non-string payload must not reach the file as "[object Object]"');
});

test('ipc-memory-compact: memory-delete notifies on success and logs on failure', async () => {
  const ok = register();
  await ok.ipc.invoke('shell:memory-delete', 'global');
  assert.strictEqual(ok.state.notifications.length, 1);

  const fail = register({
    memory: {
      get: () => ({ ok: true }), save: async () => ({ ok: true }),
      remove: async () => ({ ok: false, code: 'delete', reason: 'EACCES' }),
    },
  });
  await fail.ipc.invoke('shell:memory-delete', 'global');
  assert.strictEqual(fail.state.notifications.length, 0);
  assert.ok(fail.state.logs.some((l) => /\[memory\] delete failed/.test(l)));
});
