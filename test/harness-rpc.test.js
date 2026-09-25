'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  selectLatestNonBlankSession,
  commandArgsForVersion,
  isArgumentShapeError,
  agentPresetOf,
  createHarnessRpcClient,
  createHarnessRpcWire,
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

test('commandArgsForVersion unifies on the 0.1.5 commands/execute shape (submittedAttachments, no rc branch)', () => {
  // The rc.8 `images` branch is retired: 0.1.5 rejects unknown fields and
  // 0.1.1 gets the legacy shape through the argument-shape fallback.
  assert.deepEqual(commandArgsForVersion('0.2.4-rc.7', 's1'), { agentId: 's1', line: '/compact', submittedAttachments: [] });
  assert.deepEqual(commandArgsForVersion('0.2.4-rc.8', 's1'), { agentId: 's1', line: '/compact', submittedAttachments: [] });
  assert.deepEqual(commandArgsForVersion('0.2.5', 's1'), { agentId: 's1', line: '/compact', submittedAttachments: [] });
  assert.deepEqual(commandArgsForVersion('', 's1'), { agentId: 's1', line: '/compact', submittedAttachments: [] });
});

test('argument-shape errors are retryable while network and business errors are not', () => {
  assert.equal(isArgumentShapeError({ code: 'invalid_arguments', message: 'unknown field images' }), true);
  assert.equal(isArgumentShapeError({ code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor: missing "request"' }), true);
  assert.equal(isArgumentShapeError({ code: 'permission', message: 'forbidden' }), false);
  assert.equal(isArgumentShapeError(new Error('network failed')), false);
});

test('agentPresetOf reads the 0.1.5 projections location and the legacy flat field', () => {
  // 0.1.5 real item shape (spike-verified): projections.values.agentPreset
  assert.equal(agentPresetOf({ sessionId: 's', projections: { asOfSeq: 2, values: { agentPreset: 'standard' } } }), 'standard');
  // 0.1.1 flat field still wins for a rolled-back runtime
  assert.equal(agentPresetOf({ sessionId: 's', agentPreset: 'coder' }), 'coder');
  assert.equal(agentPresetOf({ sessionId: 's' }), '');
  assert.equal(agentPresetOf(null), '');
});

// --- dual protocol: helpers ---------------------------------------------------

// A response fake that satisfies both readers: the wire client calls .json(),
// the compact client reads the own 'body' property first (readResponse).
const asResponse = (body, status = 200) => ({ status, body, json: async () => body, text: async () => JSON.stringify(body) });
const okEnvelope = (value) => asResponse({ type: 'server-response', rpcId: 'x', result: { ok: true, value } });
const recordingFetch = (respond) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null });
    return respond(calls.length - 1, calls);
  };
  return { calls, fetchImpl };
};
const fakeMux = (respond) => {
  const calls = [];
  return {
    calls,
    call: async (endpoint, args) => {
      calls.push({ endpoint, args });
      return respond(calls.length - 1, calls);
    },
  };
};

// --- 0.1.5 slash-endpoint wire protocol ---------------------------------------

test('wire slash protocol: listSessions posts session/list with args._request (spike-verified shape)', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope({ items: [{ sessionId: 's1', running: true }] }));
  const rpc = createHarnessRpcWire('http://127.0.0.1:1/', { fetchImpl, protocol: 'slash' });
  const sessions = await rpc.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1/api/session/list');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    type: 'client-request',
    rpcId: calls[0].body.rpcId,
    method: 'session/list',
    payload: { args: { _request: {} } },
  });
});

test('wire slash protocol: create/prompt/cancel use the request envelope with a minted requestId', async () => {
  const { calls, fetchImpl } = recordingFetch((i) => okEnvelope(i === 0 ? { sessionId: 'sess-9' } : { accepted: true }));
  const rpc = createHarnessRpcWire('http://x', { fetchImpl, protocol: 'slash' });
  assert.equal(await rpc.createSession(), 'sess-9');
  await rpc.prompt('sess-9', 'hello', 'steer');
  await rpc.cancel('sess-9');
  assert.equal(calls[0].body.method, 'session/create');
  assert.deepEqual(calls[0].body.payload.args, { request: {} });
  assert.equal(calls[1].body.method, 'session/prompt');
  assert.deepEqual(Object.keys(calls[1].body.payload.args.request).sort(), ['content', 'mode', 'requestId', 'sessionId']);
  assert.equal(calls[1].body.payload.args.request.sessionId, 'sess-9');
  assert.equal(calls[1].body.payload.args.request.mode, 'steer');
  assert.deepEqual(calls[1].body.payload.args.request.content, [{ type: 'text', text: 'hello' }]);
  assert.ok(typeof calls[1].body.payload.args.request.requestId === 'string' && calls[1].body.payload.args.request.requestId.length > 0);
  assert.equal(calls[2].body.method, 'session/cancel');
  assert.deepEqual(calls[2].body.payload.args, { request: { sessionId: 'sess-9' } });
});

test('wire slash protocol: page posts the address+throughSeq request; follow/control have no unary form', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope({ messages: [] }));
  const rpc = createHarnessRpcWire('http://x', { fetchImpl, protocol: 'slash' });
  await rpc.page('sess-1', 42);
  assert.equal(calls[0].body.method, 'session/page');
  assert.deepEqual(calls[0].body.payload.args, { request: { address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 42 } });
  await assert.rejects(rpc.follow('sess-1'), /session\/follow/);
  await assert.rejects(rpc.control('sess-1', {}), /session\/control/);
});

test('wire slash protocol: a live mux client is preferred over fetch (mux.call reuse)', async () => {
  const mux = fakeMux((i) => (i === 0
    ? { ok: true, value: { items: [{ sessionId: 's1', running: false }] } }
    : { ok: true, value: { accepted: true } }));
  let fetched = 0;
  const rpc = createHarnessRpcWire('http://x', {
    protocol: 'slash',
    mux,
    fetchImpl: async () => { fetched += 1; return okEnvelope({}); },
  });
  const sessions = await rpc.listSessions();
  await rpc.prompt('s1', 'hi', 'queue');
  assert.equal(fetched, 0, 'mux.call is the unary transport on 0.1.5; no second fetch stack');
  assert.equal(mux.calls[0].endpoint, 'session/list');
  assert.deepEqual(mux.calls[0].args, { _request: {} });
  assert.equal(mux.calls[1].endpoint, 'session/prompt');
  assert.equal(mux.calls[1].args.request.sessionId, 's1');
  assert.equal(mux.calls[1].args.request.mode, 'queue');
  assert.equal(sessions.length, 1);
});

test('wire slash protocol: mux failures surface as thrown errors', async () => {
  const mux = fakeMux(() => ({ ok: false, reason: 'session/not-found' }));
  const rpc = createHarnessRpcWire('http://x', { protocol: 'slash', mux });
  await assert.rejects(rpc.listSessions(), /session\/not-found/);
});

test('wire slash protocol: fetches carry the runtime cookie and retry once after a 401', async () => {
  let cookie = null;
  let seq = 0;
  const invalidations = [];
  const auth = {
    getCookie: async () => { if (!cookie) { seq += 1; cookie = `dsh-auth-x=c${seq}`; } return cookie; },
    invalidate: () => { invalidations.push(1); cookie = null; },
  };
  const { calls, fetchImpl } = recordingFetch((i) => (i === 0 ? asResponse({}, 401) : okEnvelope({ items: [] })));
  const rpc = createHarnessRpcWire('http://x', { fetchImpl, protocol: 'slash', auth });
  await rpc.listSessions();
  assert.equal(calls.length, 2, '401 triggers exactly one cookie re-exchange + retry');
  assert.equal(invalidations.length, 1);
  assert.equal(calls[0].headers.cookie, 'dsh-auth-x=c1');
  assert.equal(calls[1].headers.cookie, 'dsh-auth-x=c2');
});

test('wire legacy protocol stays the exact 0.1.1 dot-method path (rollback safety)', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope({ items: [] }));
  const rpc = createHarnessRpcWire('http://x', { fetchImpl }); // default: legacy
  await rpc.listSessions();
  await rpc.prompt('s1', 'hello', 'steer');
  await rpc.cancel('s1');
  assert.equal(calls[0].url, 'http://x/api/session.list');
  assert.equal(calls[0].body.method, 'session.list');
  assert.deepEqual(calls[0].body.payload, {}); // flat payload, no args envelope
  assert.equal(calls[1].body.method, 'session.prompt');
  assert.deepEqual(calls[1].body.payload, { sessionId: 's1', mode: 'steer', content: [{ type: 'text', text: 'hello' }] });
  assert.equal(calls[2].body.method, 'session.cancel');
  assert.deepEqual(calls[2].body.payload, { sessionId: 's1' });
});

// --- 0.1.5 slash-endpoint compact client --------------------------------------

test('compact client slash protocol: session/list and commands/execute use matching slash path+method', async () => {
  const { calls, fetchImpl } = recordingFetch((i) => (i === 0
    ? okEnvelope({ items: [{ sessionId: 's-new', updatedAt: 20, messageCount: 1 }] })
    : okEnvelope({ accepted: true })));
  const client = createHarnessRpcClient({ baseUrl: 'http://127.0.0.1:43123', protocol: 'slash', rpcId: () => 'rpc-1', request: fetchImpl });
  const result = await client.compactLatestSession();
  assert.deepEqual(result, { ok: true, sessionId: 's-new' });
  assert.equal(calls[0].url, 'http://127.0.0.1:43123/api/session/list');
  assert.deepEqual(calls[0].body, { type: 'client-request', rpcId: 'rpc-1', method: 'session/list', payload: { args: { _request: {} } } });
  assert.equal(calls[1].url, 'http://127.0.0.1:43123/api/commands/execute');
  assert.deepEqual(calls[1].body.payload.args, { agentId: 's-new', line: '/compact', submittedAttachments: [] });
});

test('compact client slash protocol: a live mux client drives both endpoints (no fetch)', async () => {
  const mux = fakeMux((i) => (i === 0
    ? { ok: true, value: { items: [{ sessionId: 's-new', updatedAt: 20, messageCount: 1 }] } }
    : { ok: true, value: { accepted: true } }));
  let fetched = 0;
  const client = createHarnessRpcClient({
    baseUrl: 'http://127.0.0.1:43123',
    protocol: 'slash',
    mux,
    request: async () => { fetched += 1; return okEnvelope({}); },
  });
  const result = await client.compactLatestSession();
  assert.deepEqual(result, { ok: true, sessionId: 's-new' });
  assert.equal(fetched, 0);
  assert.equal(mux.calls[0].endpoint, 'session/list');
  assert.deepEqual(mux.calls[0].args, { _request: {} });
  assert.equal(mux.calls[1].endpoint, 'commands/execute');
  assert.deepEqual(mux.calls[1].args, { agentId: 's-new', line: '/compact', submittedAttachments: [] });
});

test('compact client slash protocol: fetch carries the cookie and retries once after a 401', async () => {
  let cookie = null;
  let seq = 0;
  const invalidations = [];
  const auth = {
    getCookie: async () => { if (!cookie) cookie = `dsh-auth-y=c${++seq}`; return cookie; },
    invalidate: () => { invalidations.push(1); cookie = null; },
  };
  const { calls, fetchImpl } = recordingFetch((i) => (i === 0 ? asResponse({}, 401) : okEnvelope({ items: [{ sessionId: 's1', updatedAt: 20, messageCount: 1 }] })));
  const client = createHarnessRpcClient({ baseUrl: 'http://127.0.0.1:43123', protocol: 'slash', auth, request: fetchImpl });
  const sessions = await client.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(invalidations.length, 1);
  assert.equal(calls[0].headers.cookie, 'dsh-auth-y=c1');
  assert.equal(calls[1].headers.cookie, 'dsh-auth-y=c2');
});

// --- 0.1.1 legacy compact client (unchanged behavior) --------------------------

test('RPC client sends session/list and commands/execute envelopes to the legacy endpoints', async () => {
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
  assert.deepEqual(requests[1].body.payload.args, { agentId: 's-new', line: '/compact', submittedAttachments: [] });
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
    version: 'unknown', // no rc token → the 0.1.1 default carries images:[]
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body.payload.args);
      if (bodies.length === 1) return { status: 200, body: { error: { code: 'invalid_arguments', message: 'unknown field submittedAttachments' } } };
      return { status: 200, body: { result: { ok: true } } };
    },
  });
  const result = await client.executeCompact('s1');
  assert.equal(result.ok, true);
  assert.deepEqual(bodies, [
    { agentId: 's1', line: '/compact', submittedAttachments: [] },
    { agentId: 's1', line: '/compact', images: [] },
  ]);
});

test('RPC client falls back to the rc.7 bare shape for an argument-shape error on rc.7-', async () => {
  const bodies = [];
  const client = createHarnessRpcClient({
    baseUrl: 'http://127.0.0.1:43123',
    version: '0.2.4-rc.7',
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body.payload.args);
      if (bodies.length === 1) return { status: 200, body: { error: { code: 'invalid_arguments', message: 'unknown field submittedAttachments' } } };
      return { status: 200, body: { result: { ok: true } } };
    },
  });
  const result = await client.executeCompact('s1');
  assert.equal(result.ok, true);
  assert.deepEqual(bodies, [
    { agentId: 's1', line: '/compact', submittedAttachments: [] },
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
