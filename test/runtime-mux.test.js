// test/runtime-mux.test.js — the 0.1.5 /api/remote.mux client contract.
// Fixture: a local http + ws server speaking the real wire shapes from
// docs/strategy/2026-09-22-harness-upgrade-compat-plan.md §1.5/§9. No real
// harness is contacted.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const { createRuntimeMux, EVENTS_STREAM_ID } = require('../src/runtime-mux.js');

const READY_VALUE = { type: 'ready', clientId: 'cid-ready-1', host: { home: '/tmp/home' } };

/** Local fixture: upgrades carry whatever cookie the client sends; the
 * `$events` open is answered with the ready frame automatically, everything
 * else is driven explicitly through sendTo/closeConn. */
function startFixture() {
  const state = {
    connections: [], // { ws, cookie, opens: [], closed: false }
    results: [], // { body, cookie }
    resultStatus: [], // shift() per POST; default 200
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/$events/result') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        state.results.push({ body: JSON.parse(raw), cookie: req.headers.cookie || null });
        const status = state.resultStatus.length ? state.resultStatus.shift() : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: JSON.parse(raw).rpcId,
          result: status === 200 ? { ok: true, value: { accepted: true } } : { ok: false, error: { code: 'unauthorized', message: 'no' } },
        }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const conn = { ws, cookie: req.headers.cookie || null, opens: [], closed: false };
    state.connections.push(conn);
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (frame.type === 'open') {
        conn.opens.push(frame);
        if (frame.endpoint === '$events') {
          ws.send(JSON.stringify({ type: 'item', streamId: frame.streamId, value: READY_VALUE }));
        }
      }
    });
    ws.on('close', () => { conn.closed = true; });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${port}`,
        sendTo: (conn, frame) => { if (!conn.closed) conn.ws.send(JSON.stringify(frame)); },
        closeConn: (conn) => { conn.ws.close(); },
        // Force-teardown: wss.close() alone waits for every client to finish
        // its closing handshake, so a test that fails/times out before
        // mux.close() would hang the whole suite in this callback forever.
        // Terminate the sockets, drop the connections, and resolve no matter
        // what (the resolve is idempotent).
        stop: () => new Promise((done) => {
          for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
          try { server.closeAllConnections(); } catch { /* ignore */ }
          try { wss.close(); } catch { /* ignore */ }
          try { server.close(() => done()); } catch { done(); }
          setTimeout(done, 1_000).unref();
        }),
      });
    });
  });
}

function fakeAuth(cookie = 'dsh-auth-test=signature-1') {
  const auth = {
    cookie,
    invalidated: 0,
    async getCookie() { return auth.cookie; },
    invalidate() { auth.invalidated += 1; auth.cookie = `dsh-auth-test=signature-${auth.invalidated + 1}`; },
  };
  return auth;
}

async function waitFor(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('handshake carries the browser cookie and auto-opens $events (ready → clientId)', async () => {
  const fx = await startFixture();
  try {
    const auth = fakeAuth();
    const readyFrames = [];
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth, log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    mux.onReady((value) => readyFrames.push(value));
    mux.connect();

    await waitFor(() => mux.clientId, 'clientId from the ready frame');
    assert.equal(mux.clientId, 'cid-ready-1');
    assert.equal(mux.state, 'live');
    assert.equal(readyFrames.length, 1);
    assert.deepEqual(readyFrames[0], READY_VALUE);

    const conn = fx.state.connections[0];
    assert.equal(conn.cookie, 'dsh-auth-test=signature-1', 'upgrade carries the runtime cookie');
    const eventsOpen = conn.opens.find((f) => f.endpoint === '$events');
    assert.ok(eventsOpen, '$events is opened automatically');
    assert.equal(eventsOpen.streamId, EVENTS_STREAM_ID);
    assert.deepEqual(eventsOpen.payload, { args: {} });
    mux.close();
  } finally {
    await fx.stop();
  }
});

test('item frames dispatch to the stream listener; ready is not re-dispatched', async () => {
  const fx = await startFixture();
  try {
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    const items = [];
    mux.onItem('session-follow-s1', (value) => items.push(value));
    mux.openStream('session-follow-s1', 'session/follow', {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: false },
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'mux live');

    const conn = fx.state.connections[0];
    const openFrame = conn.opens.find((f) => f.streamId === 'session-follow-s1');
    assert.ok(openFrame, 'registered stream is opened once ready');
    assert.deepEqual(openFrame.payload.args, {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: false },
    });

    fx.sendTo(conn, {
      type: 'item', streamId: 'session-follow-s1',
      value: { type: 'event', event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } },
    });
    fx.sendTo(conn, {
      type: 'item', streamId: 'session-follow-s1',
      value: { type: 'snapshot', cursor: 3, records: [{ type: 'event', event: { type: 'turn/end', seq: 2, time: 4, data: { reason: 'completed' } } }] },
    });
    await waitFor(() => items.length === 2, 'both item values dispatched');
    assert.deepEqual(items[0], { type: 'event', event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } });
    assert.equal(items[1].type, 'snapshot');
    mux.close();
  } finally {
    await fx.stop();
  }
});

test('reconnect re-opens every registered stream (caller sees no generation change)', async () => {
  const fx = await startFixture();
  try {
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    mux.onItem('session-follow-s1', () => {});
    mux.openStream('session-follow-s1', 'session/follow', {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: false },
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'first generation live');
    assert.equal(fx.state.connections.length, 1);

    fx.closeConn(fx.state.connections[0]);
    await waitFor(() => fx.state.connections.length === 2, 'mux reconnected on its own');
    const second = fx.state.connections[1];
    assert.equal(second.cookie, 'dsh-auth-test=signature-1', 'reconnect handshake re-uses the cookie');
    await waitFor(() => mux.clientId === 'cid-ready-1', 'ready frame on the new generation');
    const reopened = second.opens.find((f) => f.streamId === 'session-follow-s1');
    assert.ok(reopened, 'registered stream is re-opened after reconnect');
    assert.equal(reopened.endpoint, 'session/follow');
    assert.equal(mux.attempts, 0, 'a healthy generation resets the backoff counter');

    // close() is final: no third connection after the socket dies again
    mux.close();
    fx.closeConn(second);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fx.state.connections.length, 2, 'close() stops reconnecting');
    assert.equal(mux.state, 'closed');
  } finally {
    await fx.stop();
  }
});

test('isStreamOpen reports the real open state: host end flips it, re-open restores it', async () => {
  const fx = await startFixture();
  try {
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    const opensBefore = () => fx.state.connections.reduce((n, c) => n + c.opens.length, 0);
    mux.onItem('session-follow-s1', () => {});
    mux.openStream('session-follow-s1', 'session/follow', {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: false },
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'mux live');
    const conn = fx.state.connections[0];
    assert.equal(mux.isStreamOpen('session-follow-s1'), true, 'open once ready');
    assert.equal(mux.isStreamOpen('session-follow-nope'), false, 'unknown streams are not open');

    // The host ends the follow stream: the caller's reconcile must see it as
    // NOT open (a real change worth re-opening) — this is what the office
    // follow tick uses to avoid needless re-opens (session/follow has no
    // resume cursor, so every needless open restarts the opening window).
    fx.sendTo(conn, { type: 'end', streamId: 'session-follow-s1' });
    await waitFor(() => mux.isStreamOpen('session-follow-s1') === false, 'host end observed');
    const opensAtEnd = opensBefore();
    mux.openStream('session-follow-s1', 'session/follow', {
      request: { address: { kind: 'session', sessionId: 's1' }, assistantStream: false },
    });
    await waitFor(() => opensBefore() === opensAtEnd + 1, 'the re-open after a host end is a real wire open');
    assert.equal(mux.isStreamOpen('session-follow-s1'), true, 'open again after the explicit re-open');

    mux.closeStream('session-follow-s1');
    assert.equal(mux.isStreamOpen('session-follow-s1'), false, 'a closed stream is not open');
    mux.close();
  } finally {
    await fx.stop();
  }
});

test('sendResult posts the exact $events/result envelope with the cookie', async () => {
  const fx = await startFixture();
  try {
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'mux live');

    const res = await mux.sendResult({ eventId: 'evt-42', outcome: { kind: 'result', value: 'allowed-once' } });
    assert.deepEqual(res, { ok: true, value: { accepted: true } });
    assert.equal(fx.state.results.length, 1);
    const { body, cookie } = fx.state.results[0];
    assert.equal(cookie, 'dsh-auth-test=signature-1', 'result RPC carries the cookie');
    assert.equal(body.type, 'client-request');
    assert.equal(body.method, '$events/result');
    assert.match(body.rpcId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body.payload, {
      args: { clientId: 'cid-ready-1', eventId: 'evt-42', outcome: { kind: 'result', value: 'allowed-once' } },
    });

    // not ready yet (no clientId) degrades to a refusal, never a throw
    const early = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    const refused = await early.sendResult({ eventId: 'evt-1', outcome: { kind: 'result', value: 'rejected' } });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /not ready/);
    early.close();
    mux.close();
  } finally {
    await fx.stop();
  }
});

test('a 401 on the result RPC invalidates the cookie and retries once', async () => {
  const fx = await startFixture();
  try {
    fx.state.resultStatus.push(401); // first POST is rejected, second succeeds
    const auth = fakeAuth();
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth, log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'mux live');

    const res = await mux.sendResult({ eventId: 'evt-7', outcome: { kind: 'result', value: 'allowed-once' } });
    assert.deepEqual(res, { ok: true, value: { accepted: true } });
    assert.equal(auth.invalidated, 1, 'one invalidate on 401');
    assert.equal(fx.state.results.length, 2, 'retried exactly once');
    assert.equal(fx.state.results[0].cookie, 'dsh-auth-test=signature-1');
    assert.equal(fx.state.results[1].cookie, 'dsh-auth-test=signature-2', 'retry rides the re-exchanged cookie');
    mux.close();
  } finally {
    await fx.stop();
  }
});

test('a dead runtime backs off and recovers when it comes back', async () => {
  const fx = await startFixture();
  try {
    const errors = [];
    const mux = createRuntimeMux({
      baseUrl: fx.baseUrl, auth: fakeAuth(), log: () => {}, WebSocketImpl: require('ws').WebSocket,
      reconnectMs: 20, maxBackoffMs: 40,
      onError: (err) => errors.push(err),
    });
    mux.connect();
    await waitFor(() => mux.state === 'live', 'first generation live');
    fx.closeConn(fx.state.connections[0]);
    await waitFor(() => mux.state === 'live' && fx.state.connections.length === 2, 'recovered');
    assert.ok(errors.length >= 1, 'the caller is told about the interruption');
    assert.match(String(errors[0].message), /closed/);
    mux.close();
  } finally {
    await fx.stop();
  }
});
