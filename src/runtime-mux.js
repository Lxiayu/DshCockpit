// src/runtime-mux.js — the 0.1.5+ /api/remote.mux multiplexed event client.
//
// dsh 0.1.2 replaced the two legacy event WebSockets (/api/events.host and
// /api/events.mux) plus POST /api/respond with ONE cookie-gated multiplexed
// stream (docs/strategy/2026-09-22-harness-upgrade-compat-plan.md §1.5):
//
//   WS  ws://127.0.0.1:<port>/api/remote.mux        (Cookie required, else 401)
//   →   {type:'open',   streamId, endpoint, payload:{args}}
//   ←   {type:'item',   streamId, value}
//       {type:'end',    streamId}
//       {type:'error',  streamId, error:{code,message,details}}
//
// Two logical streams matter to the shell:
//   - endpoint '$events'      global forwarded events; the FIRST item is
//                             {type:'ready', clientId, host:{home}} and every
//                             later item is {type:'emit'|'waterfall'|'cancel',…}
//   - endpoint 'session/follow' per-session durable journal; items are
//                             {type:'snapshot',…} once, then {type:'event',
//                             event:{type,seq,time,data}} records
//
// Answering a waterfall (approval / user question) is NOT a WS frame: it is a
// unary RPC  POST /api/$events/result  {clientId, eventId, outcome} — the
// clientId comes from the ready frame, the eventId from the waterfall frame.
//
// This module is pure Node (no Electron): the `ws` package is injected (or
// defaulted) so tests can drive a local WebSocketServer fixture. It owns
// reconnect/backoff and stream re-opening, so callers register streams once
// and never see a generation change.
'use strict';

const { randomUUID } = require('node:crypto');

const MUX_PATH = '/api/remote.mux';
const EVENTS_STREAM_ID = 's-events';
const EVENTS_ENDPOINT = '$events';
const RESULT_METHOD = '$events/result';

function createRuntimeMux({
  baseUrl,
  auth,
  log = () => {},
  WebSocketImpl = null,
  fetchImpl = globalThis.fetch,
  reconnectMs = 3000,
  maxBackoffMs = 60000,
  onError = null,
} = {}) {
  if (!baseUrl) throw new Error('createRuntimeMux requires baseUrl');
  if (!auth || typeof auth.getCookie !== 'function') {
    throw new Error('createRuntimeMux requires auth (createRuntimeAuth)');
  }
  const WS = WebSocketImpl || require('ws').WebSocket;
  const wsUrl = String(baseUrl).replace(/^http/, 'ws').replace(/\/+$/, '') + MUX_PATH;
  const httpBase = String(baseUrl).replace(/\/+$/, '') + '/';

  // streamId -> { endpoint, args, listeners:Set<fn> } — survives reconnects.
  const streams = new Map();
  // streams opened on the CURRENT connection (cleared on every reconnect).
  const opened = new Set();
  const readyListeners = new Set();

  let socket = null;
  let connected = false; // socket open on the current generation
  let ready = false; // $events ready frame seen on the current generation
  let clientIdValue = null;
  let stateValue = 'idle';
  let closed = false;
  let attempts = 0;
  let reconnectTimer = null;

  function setState(next) { stateValue = next; }

  function emitError(err) {
    if (typeof onError !== 'function') return;
    try { onError(err instanceof Error ? err : new Error(String(err))); } catch { /* listener errors never break the mux */ }
  }

  // -- wire ---------------------------------------------------------------------

  function send(frame) {
    if (!socket || !connected) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (e) {
      log(`[mux] send failed: ${e && e.message || e}`);
      return false;
    }
  }

  function sendOpen(streamId, endpoint, args) {
    const ok = send({ type: 'open', streamId, endpoint, payload: { args: args || {} } });
    if (ok) opened.add(streamId);
    return ok;
  }

  /** Open every registered stream that is not open on this connection yet.
   * Called on ready (the connection is proven live) — this is what makes a
   * reconnect transparent to callers. */
  function openRegisteredStreams() {
    for (const [streamId, stream] of streams) {
      if (streamId === EVENTS_STREAM_ID) continue; // opened on socket open
      if (opened.has(streamId)) continue;
      if (!stream.endpoint) continue; // listener-only registration: never open
      sendOpen(streamId, stream.endpoint, stream.args);
    }
  }

  function dispatchItem(streamId, value) {
    if (value && value.type === 'ready') {
      clientIdValue = typeof value.clientId === 'string' ? value.clientId : null;
      ready = true;
      attempts = 0; // a ready frame proves this connection is healthy
      setState('live');
      log(`[mux] ready (clientId ${clientIdValue ? clientIdValue.slice(0, 8) : '?'})`);
      for (const cb of readyListeners) {
        try { cb(value); } catch { /* listener errors never break the mux */ }
      }
      openRegisteredStreams();
      return;
    }
    const stream = streams.get(streamId);
    if (!stream) return;
    for (const cb of stream.listeners) {
      try { cb(value); } catch (e) { log(`[mux] listener for ${streamId} failed: ${e && e.message || e}`); }
    }
  }

  function onMessage(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch { return; } // malformed frame: skip
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'item') {
      dispatchItem(frame.streamId, frame.value);
      return;
    }
    if (frame.type === 'end') {
      log(`[mux] stream ${frame.streamId} ended by host`);
      opened.delete(frame.streamId);
      // The global event stream ending means the connection lost its event
      // source: rebuild it. A per-session stream ending is left to the
      // caller's reconciliation (re-opening a journal the host just closed
      // would only loop).
      if (frame.streamId === EVENTS_STREAM_ID) scheduleReconnect('event stream ended');
      return;
    }
    if (frame.type === 'error') {
      const err = frame.error || {};
      log(`[mux] stream ${frame.streamId} error: ${err.code || 'unknown'} ${err.message || ''}`);
      opened.delete(frame.streamId);
      if (frame.streamId === EVENTS_STREAM_ID) scheduleReconnect(`event stream error (${err.code || 'unknown'})`);
      return;
    }
    // 'open'/'cancel' are client→host only; anything else is ignored.
  }

  function detachSocket() {
    if (!socket) return;
    try { socket.removeAllListeners && socket.removeAllListeners(); } catch { /* ignore */ }
    try { socket.close(); } catch { /* ignore */ }
    socket = null;
    connected = false;
    ready = false;
    opened.clear();
  }

  function scheduleReconnect(cause) {
    if (closed) return;
    if (reconnectTimer) return; // one pending reconnect at a time
    attempts += 1;
    const delay = Math.min(maxBackoffMs, reconnectMs * 2 ** (attempts - 1));
    setState('reconnecting');
    log(`[mux] ${cause}; reconnecting in ${delay}ms (attempt ${attempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // unref: a forgotten close() must never pin the host process (tests,
    // CLI tools). The Electron main loop keeps the timer alive regardless.
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function onSocketClose() {
    if (closed) return;
    connected = false;
    ready = false;
    opened.clear();
    emitError(new Error('mux socket closed'));
    scheduleReconnect('socket closed');
  }

  function onSocketError(err) {
    if (closed) return;
    // ws always follows 'error' with 'close'; the close handler reports the
    // interruption once (a double report would double-count the fail streak).
    log(`[mux] socket error: ${err && err.message || err}`);
  }

  async function connect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) detachSocket(); // a second connect() never leaks the old socket
    setState(attempts > 0 ? 'reconnecting' : 'connecting');
    let cookie = null;
    try {
      cookie = await auth.getCookie();
    } catch (e) {
      emitError(e instanceof Error ? e : new Error(String(e)));
      scheduleReconnect('cookie exchange threw');
      return;
    }
    if (closed) return;
    if (!cookie) {
      // No cookie (runtime not up / token exchange failing): the handshake
      // would 401. Retry on the backoff — the auth URL is process-stable, so
      // the next attempt re-exchanges.
      emitError(new Error('runtime cookie unavailable'));
      scheduleReconnect('no runtime cookie');
      return;
    }
    try {
      socket = new WS(wsUrl, { headers: { cookie } });
    } catch (e) {
      socket = null;
      emitError(e instanceof Error ? e : new Error(String(e)));
      scheduleReconnect('websocket construction failed');
      return;
    }
    socket.on('open', () => {
      connected = true;
      ready = false;
      opened.clear();
      // The global event stream is opened first; its ready frame proves the
      // generation is live and triggers the re-open of every other stream.
      sendOpen(EVENTS_STREAM_ID, EVENTS_ENDPOINT, {});
    });
    socket.on('message', onMessage);
    socket.on('error', onSocketError);
    socket.on('close', onSocketClose);
  }

  // -- public surface -----------------------------------------------------------

  function openStream(streamId, endpoint, args) {
    if (typeof streamId !== 'string' || streamId === '' || streamId === EVENTS_STREAM_ID) return false;
    if (typeof endpoint !== 'string' || endpoint === '') return false;
    let stream = streams.get(streamId);
    if (!stream) {
      stream = { endpoint, args: args || {}, listeners: new Set() };
      streams.set(streamId, stream);
    } else {
      stream.endpoint = endpoint;
      if (args !== undefined) stream.args = args;
    }
    // Live and past ready: open now. Otherwise the registration is queued and
    // flushed by openRegisteredStreams() when the next ready frame lands.
    if (connected && ready && !opened.has(streamId)) sendOpen(streamId, endpoint, stream.args);
    return true;
  }

  function closeStream(streamId) {
    if (!streams.has(streamId)) return false;
    streams.delete(streamId);
    opened.delete(streamId);
    send({ type: 'cancel', streamId });
    return true;
  }

  /** Whether the stream is registered AND open on the CURRENT connection.
   * False after a host end/error frame or a reconnect — the signal the caller
   * needs to re-open (a real change) instead of re-opening every reconcile
   * tick (a refresh, which the follow contract would punish with a fresh
   * opening window). */
  function isStreamOpen(streamId) {
    return streams.has(streamId) && opened.has(streamId);
  }

  function onItem(streamId, cb) {
    if (typeof cb !== 'function') return () => {};
    let stream = streams.get(streamId);
    if (!stream) {
      // Registering a listener before the stream itself is allowed (the mux
      // dispatches by streamId; openStream fills the rest in).
      stream = { endpoint: '', args: {}, listeners: new Set() };
      streams.set(streamId, stream);
    }
    stream.listeners.add(cb);
    return () => stream.listeners.delete(cb);
  }

  function onReady(cb) {
    if (typeof cb !== 'function') return () => {};
    readyListeners.add(cb);
    return () => readyListeners.delete(cb);
  }

  /** Unary gateway RPC (e.g. session/list, session/page) over HTTP with the
   * browser cookie; 401 invalidates the cookie and retries once. */
  async function call(endpoint, args = {}) {
    if (closed) return { ok: false, reason: 'mux closed' };
    const body = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const cookie = await auth.getCookie();
      if (!cookie) return { ok: false, reason: 'runtime cookie unavailable' };
      let res;
      try {
        res = await fetchImpl(`${httpBase}api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(body),
        });
      } catch (e) {
        return { ok: false, reason: e && e.message || String(e) };
      }
      if (res.status === 401 && attempt === 1) {
        auth.invalidate(); // stale cookie: re-exchange and retry once
        continue;
      }
      const payload = await res.json().catch(() => ({}));
      const result = payload && payload.result;
      if (res.status === 200 && result && result.ok === true) return { ok: true, value: result.value };
      const error = result && result.error;
      return { ok: false, reason: (error && (error.message || error.code)) || `HTTP ${res.status}` };
    }
    return { ok: false, reason: 'unauthorized after cookie re-exchange' };
  }

  /** Answer a pending waterfall (approval / user question) through
   * POST /api/$events/result with the ready-frame clientId. */
  async function sendResult({ eventId, outcome } = {}) {
    if (closed) return { ok: false, reason: 'mux closed' };
    if (!clientIdValue) return { ok: false, reason: 'mux not ready (no clientId)' };
    if (typeof eventId !== 'string' || eventId === '') return { ok: false, reason: 'missing eventId' };
    return call(RESULT_METHOD, { clientId: clientIdValue, eventId, outcome: outcome || { kind: 'result' } });
  }

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    detachSocket();
    streams.clear();
    opened.clear();
    readyListeners.clear();
    clientIdValue = null;
    setState('closed');
  }

  return {
    connect,
    openStream,
    closeStream,
    isStreamOpen,
    onItem,
    onReady,
    call,
    sendResult,
    close,
    get clientId() { return clientIdValue; },
    get state() { return stateValue; },
    get attempts() { return attempts; },
  };
}

module.exports = { createRuntimeMux, EVENTS_STREAM_ID, EVENTS_ENDPOINT, MUX_PATH };
