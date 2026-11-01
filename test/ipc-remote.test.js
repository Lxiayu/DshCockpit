// test/ipc-remote.test.js — Issue #22 Phase 1：手机遥控网关的行为测试。
//
// 这组测试的重点不是"能不能调到"，而是**三个 handler 的降级语义互不相同，
// 且都必须原样保留**。这是提取时最容易"顺手统一"而破坏的地方：
//
//   remote:status  → 未启用时 {running:false, disabled:true}  （面板要显示状态）
//   remote:pairing → 未启用时 null                            （没有配对码就是没有）
//   remote:revoke  → 未启用时 null                            （无可撤销项）
//
// 如果把三个都统一成 {ok:false}，设置页的既有判断（`if (!pairing)`）
// 会从"没启用"变成"启用了但没码"，行为就变了。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerRemoteIpc } = require('../src/ipc-remote.js');

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

test('ipc-remote: registers exactly the 3 remote channels', () => {
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote: null });
  assert.deepEqual(ipc.channels(), ['remote:pairing', 'remote:revoke', 'remote:status']);
});

test('ipc-remote: status reports disabled when no gateway is running (panel still renders)', () => {
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote: null });
  assert.deepEqual(ipc.invoke('remote:status'), { running: false, disabled: true },
    'the settings panel needs a renderable shape, not a throw');
});

test('ipc-remote: pairing returns null (not an empty object) when disabled', () => {
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote: null });
  assert.strictEqual(ipc.invoke('remote:pairing'), null,
    'the UI distinguishes "no pairing" via null; an object would look like a live code');
});

test('ipc-remote: revoke returns null when disabled', () => {
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote: null });
  assert.strictEqual(ipc.invoke('remote:revoke'), null);
});

test('ipc-remote: status passes the gateway payload through unchanged', () => {
  const calls = [];
  const remote = {
    status: () => ({ running: true, port: 1234, token: 'redacted-by-ui' }),
    refreshPairingCode: () => calls.push('refresh'),
    revokeToken: () => calls.push('revoke'),
  };
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote });
  const out = ipc.invoke('remote:status');
  assert.deepEqual(out, { running: true, port: 1234, token: 'redacted-by-ui' });
  assert.deepEqual(calls, [], 'status must not have side effects');
});

test('ipc-remote: pairing ROTATES the code before returning status', () => {
  // 这是 pairing 与 status 的唯一区别：它必须是**有副作用**的。
  // 若提取时误写成直接返回 status()，配对码就不会刷新，用户会拿到过期码。
  const order = [];
  const remote = {
    status: () => { order.push('status'); return { running: true, pairing: 'NEW' }; },
    refreshPairingCode: () => { order.push('refresh'); },
    revokeToken: () => {},
  };
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote });
  const out = ipc.invoke('remote:pairing');
  assert.deepEqual(order, ['refresh', 'status'], 'refresh MUST happen before status is read');
  assert.strictEqual(out.pairing, 'NEW');
});

test('ipc-remote: revoke calls the gateway and returns its result', () => {
  let revoked = false;
  const remote = {
    status: () => ({}),
    refreshPairingCode: () => {},
    revokeToken: () => { revoked = true; return { ok: true, revoked: 1 }; },
  };
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote });
  const out = ipc.invoke('remote:revoke');
  assert.strictEqual(revoked, true);
  assert.deepEqual(out, { ok: true, revoked: 1 });
});

test('ipc-remote: registering twice throws (no silent override)', () => {
  const ipc = fakeIpcMain();
  registerRemoteIpc(ipc, { remote: null });
  assert.throws(() => registerRemoteIpc(ipc, { remote: null }), /duplicate handle/);
});
