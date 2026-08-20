'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  selectLatestNonBlankSession,
  commandArgsForVersion,
  isArgumentShapeError,
  createHarnessRpcClient,
} = require('../src/harness-rpc');

test('selectLatestNonBlankSession ignores blank rows and chooses the newest usable session', () => {
  const session = selectLatestNonBlankSession([
    { id: 'blank', updatedAt: '2026-08-20T12:00:00Z', messageCount: 0 },
    { id: 'old', updatedAt: '2026-08-20T11:00:00Z', messageCount: 2 },
    { sessionId: 'new', updatedAt: '2026-08-20T11:30:00Z', messages: [{ role: 'user' }] },
    { id: 'newest', updatedAt: '2026-08-20T11:45:00Z', title: 'Active' },
  ]);
  assert.equal(session.id, 'newest');
});

test('commandArgsForVersion keeps rc.7 legacy shape and adds images for rc.8+', () => {
  assert.deepEqual(commandArgsForVersion('0.2.4-rc.7', 's1'), { agentId: 's1', line: '/compact' });
  assert.deepEqual(commandArgsForVersion('0.2.4-rc.8', 's1'), { agentId: 's1', line: '/compact', images: [] });
  assert.deepEqual(commandArgsForVersion('0.2.5', 's1'), { agentId: 's1', line: '/compact', images: [] });
});

test('argument-shape errors are retryable while network and business errors are not', () => {
  assert.equal(isArgumentShapeError({ code: 'invalid_arguments', message: 'unknown field images' }), true);
  assert.equal(isArgumentShapeError({ code: 'permission', message: 'forbidden' }), false);
  assert.equal(isArgumentShapeError(new Error('network failed')), false);
});

test('RPC client sends session/list and commands/execute envelopes to the stable endpoints', async () => {
  const requests = [];
  const client = createHarnessRpcClient({
    baseUrl: 'http://127.0.0.1:43123',
    version: '0.2.4-rc.8',
    rpcId: () => 'rpc-1',
    request: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/api/session.list')) {
        return { status: 200, body: { result: { sessions: [{ id: 's-new', updatedAt: 20, messageCount: 1 }] } } };
      }
      return { status: 200, body: { result: { ok: true } } };
    },
  });
  const result = await client.compactLatestSession();
  assert.deepEqual(result, { ok: true, sessionId: 's-new' });
  assert.equal(requests[0].url, 'http://127.0.0.1:43123/api/session.list');
  assert.deepEqual(requests[0].body, { type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { args: {} } });
  assert.equal(requests[1].url, 'http://127.0.0.1:43123/api/commands/execute');
  assert.deepEqual(requests[1].body, { type: 'client-request', rpcId: 'rpc-1', method: 'commands/execute', payload: { args: { agentId: 's-new', line: '/compact', images: [] } } });
});

test('RPC client reports a no-session failure without attempting commands/execute', async () => {
  let calls = 0;
  const client = createHarnessRpcClient({
    baseUrl: 'http://127.0.0.1:43123',
    request: async () => { calls += 1; return { status: 200, body: { sessions: [{ id: 'blank', blank: true }] } }; },
  });
  const result = await client.compactLatestSession();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-session');
  assert.equal(calls, 1);
});

test('RPC client retries once with legacy args only for an explicit argument-shape error', async () => {
  const bodies = [];
  const client = createHarnessRpcClient({
    baseUrl: 'http://127.0.0.1:43123',
    version: 'unknown',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body.payload.args);
      if (bodies.length === 1) return { status: 200, body: { error: { code: 'invalid_arguments', message: 'unknown field images' } } };
      return { status: 200, body: { result: { ok: true } } };
    },
  });
  const result = await client.executeCompact('s1');
  assert.equal(result.ok, true);
  assert.deepEqual(bodies, [
    { agentId: 's1', line: '/compact', images: [] },
    { agentId: 's1', line: '/compact' },
  ]);
});

test('RPC client does not retry HTTP, network, permission, or runtime business errors', async () => {
  for (const failure of [
    { status: 503, body: { error: { code: 'unavailable' } } },
    { throw: new Error('network failed') },
    { status: 403, body: { error: { code: 'permission' } } },
    { status: 200, body: { error: { code: 'busy', message: 'agent is running' } } },
  ]) {
    let calls = 0;
    const client = createHarnessRpcClient({
      baseUrl: 'http://127.0.0.1:43123',
      request: async () => { calls += 1; if (failure.throw) throw failure.throw; return failure; },
    });
    const result = await client.executeCompact('s1');
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
  }
});
