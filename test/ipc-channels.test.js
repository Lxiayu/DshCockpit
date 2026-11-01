// test/ipc-channels.test.js — Issue #22 Phase 1：IM 通道域。
//
// 第一性原理：这是耦合最低的一批，但有一条纪律不能破
//
//   5 个 handler 全是对 channelsMgr 单个对象的薄封装——风险最低。
//   唯一的真实风险是 **C6 凭证纪律**：
//     credentials 存在于主进程的 safeStorage vault；
//     renderer 发送字段值，主进程只返回布尔/结果形状，**秘密值永不回传**。
//
//   这条纪律由 channelsMgr 实现，但 IPC 层很容易在"顺手"时破坏它
//   （比如为了调试把 values 回显到返回值里）。所以这里专门断言
//   任何 handler 的返回里都不出现传入的秘密值。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerChannelsIpc } = require('../src/ipc-channels.js');

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

const SECRET = 'sk-super-secret-token-value';

function fakeMgr() {
  return {
    statusAll: () => [
      { id: 'feishu', enabled: true, configured: true },
      { id: 'wecom', enabled: false, configured: false },
    ],
    toggle: (id, enabled) => ({ ok: true, id, enabled }),
    setAllowFrom: (id, allowFrom) => ({ ok: true, id, allowFrom }),
    // 真实的 configureSecrets 只回布尔：哪些字段已配置
    configureSecrets: (id, values) => ({
      ok: true,
      id,
      configured: Object.keys(values || {}).reduce((acc, k) => { acc[k] = true; return acc; }, {}),
    }),
    // 真实的 testChannel 只回探测结果，绝不回显凭证
    testChannel: (id, values) => ({ ok: true, id, reachable: true, credentialCount: Object.keys(values || {}).length }),
  };
}

function register(over = {}) {
  const ipc = fakeIpcMain();
  registerChannelsIpc(ipc, { channelsMgr: over.channelsMgr === undefined ? fakeMgr() : over.channelsMgr });
  return { ipc };
}

test('ipc-channels: registers exactly the 5 channel channels', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'shell:channels-allowfrom', 'shell:channels-configure', 'shell:channels-list',
    'shell:channels-test', 'shell:channels-toggle',
  ]);
});

// ------------------------------------------------------ 未就绪的形状差异

test('ipc-channels: channels-list degrades to an empty LIST, not an error envelope', async () => {
  // 面板要能渲染空列表。返回 {ok:false} 会让它显示错误态而不是"还没有配置"。
  const { ipc } = register({ channelsMgr: null });
  const out = await ipc.invoke('shell:channels-list');
  assert.deepStrictEqual(out, { channels: [] });
});

test('ipc-channels: the four mutations degrade to {ok:false, reason:"not ready"}', async () => {
  const { ipc } = register({ channelsMgr: null });
  for (const ch of ['shell:channels-toggle', 'shell:channels-allowfrom', 'shell:channels-configure', 'shell:channels-test']) {
    const out = await ipc.invoke(ch, 'feishu', 'x');
    assert.strictEqual(out.ok, false, `${ch} must report failure`);
    assert.strictEqual(out.reason, 'not ready');
  }
});

// ------------------------------------------------------------ 参数清理

test('ipc-channels: toggle coerces enabled to a boolean', async () => {
  const seen = [];
  const mgr = { ...fakeMgr(), toggle: (id, enabled) => { seen.push(enabled); return { ok: true }; } };
  const { ipc } = register({ channelsMgr: mgr });
  await ipc.invoke('shell:channels-toggle', 'feishu', 'truthy-but-not-boolean');
  assert.strictEqual(seen[0], true);
  await ipc.invoke('shell:channels-toggle', 'feishu', 0);
  assert.strictEqual(seen[1], false);
});

test('ipc-channels: a missing id becomes an empty string (never "undefined")', async () => {
  const seen = [];
  const mgr = { ...fakeMgr(), toggle: (id) => { seen.push(id); return { ok: true }; } };
  const { ipc } = register({ channelsMgr: mgr });
  await ipc.invoke('shell:channels-toggle');
  assert.strictEqual(seen[0], '', 'an absent id must not reach the manager as the string "undefined"');
});

test('ipc-channels: every handler stringifies a non-string id', async () => {
  const seen = [];
  const mgr = {
    ...fakeMgr(),
    toggle: (id) => { seen.push(['toggle', id]); return { ok: true }; },
    setAllowFrom: (id) => { seen.push(['allowfrom', id]); return { ok: true }; },
    configureSecrets: (id) => { seen.push(['configure', id]); return { ok: true }; },
    testChannel: (id) => { seen.push(['test', id]); return { ok: true }; },
  };
  const { ipc } = register({ channelsMgr: mgr });
  await ipc.invoke('shell:channels-toggle', 123, true);
  await ipc.invoke('shell:channels-allowfrom', 456, ['*']);
  await ipc.invoke('shell:channels-configure', 789, {});
  await ipc.invoke('shell:channels-test', 1011, {});
  assert.deepStrictEqual(seen, [
    ['toggle', '123'], ['allowfrom', '456'], ['configure', '789'], ['test', '1011'],
  ], 'numeric ids must be normalised to strings');
});

// --------------------------------------------------- C6 凭证纪律（关键）

test('ipc-channels: configure NEVER echoes secret values back', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:channels-configure', 'feishu', { appSecret: SECRET });
  assert.strictEqual(out.ok, true);
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes(SECRET),
    'the secret value must never appear in the IPC response — the renderer only needs to know WHICH fields are set');
  assert.deepStrictEqual(out.configured, { appSecret: true }, 'booleans are the contract');
});

test('ipc-channels: test NEVER echoes secret values back', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:channels-test', 'feishu', { appSecret: SECRET, appId: 'cli_123' });
  const serialised = JSON.stringify(out);
  assert.ok(!serialised.includes(SECRET), 'a connectivity test must not leak the credential it tested');
  assert.strictEqual(out.credentialCount, 2, 'counts are safe; values are not');
});

test('ipc-channels: list reports only configured FLAGS, never values', async () => {
  // statusAll() 的形状就是契约：enabled/configured 是布尔，没有秘密字段。
  const { ipc } = register();
  const out = await ipc.invoke('shell:channels-list');
  assert.strictEqual(out.channels.length, 2);
  for (const c of out.channels) {
    assert.strictEqual(typeof c.configured, 'boolean');
    assert.ok(!('appSecret' in c), 'status snapshots must not carry credential fields');
  }
});

// ------------------------------------------------------------ 转发语义

test('ipc-channels: allowFrom is forwarded verbatim (the manager owns validation)', async () => {
  const seen = [];
  const mgr = { ...fakeMgr(), setAllowFrom: (id, allowFrom) => { seen.push(allowFrom); return { ok: true }; } };
  const { ipc } = register({ channelsMgr: mgr });
  const policy = { mode: 'list', ids: ['u1', 'u2'] };
  await ipc.invoke('shell:channels-allowfrom', 'feishu', policy);
  assert.deepStrictEqual(seen[0], policy, 'the IPC layer must not reshape the policy');
});

test('ipc-channels: a manager result is returned unchanged (no re-wrapping)', async () => {
  const mgr = { ...fakeMgr(), toggle: () => ({ ok: true, changed: 'yes', extra: 42 }) };
  const { ipc } = register({ channelsMgr: mgr });
  const out = await ipc.invoke('shell:channels-toggle', 'feishu', true);
  assert.deepStrictEqual(out, { ok: true, changed: 'yes', extra: 42 });
});
