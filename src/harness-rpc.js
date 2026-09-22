'use strict';

const { randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;

class HarnessRpcError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'HarnessRpcError';
    this.code = code;
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

function sessionIdOf(session) {
  if (!session || typeof session !== 'object') return '';
  for (const key of ['id', 'sessionId', 'agentId']) {
    if (typeof session[key] === 'string' && session[key].trim()) return session[key].trim();
  }
  return '';
}

function updatedAtOf(session) {
  if (!session || typeof session !== 'object') return 0;
  for (const key of ['updatedAt', 'lastUpdatedAt', 'modifiedAt', 'lastActivityAt', 'createdAt']) {
    const value = session[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) return timestamp;
    }
  }
  return 0;
}

function isNonBlankSession(session) {
  if (!session || typeof session !== 'object' || !sessionIdOf(session)) return false;
  if (session.blank === true || session.isBlank === true || session.empty === true) return false;
  if (typeof session.messageCount === 'number' && session.messageCount <= 0) return false;
  if (typeof session.messagesCount === 'number' && session.messagesCount <= 0) return false;
  if (Array.isArray(session.messages) && session.messages.length === 0) return false;
  if (Array.isArray(session.turns) && session.turns.length === 0) return false;
  return true;
}

function selectLatestNonBlankSession(sessions) {
  const candidates = (Array.isArray(sessions) ? sessions : [])
    .filter(isNonBlankSession)
    .map((session, index) => ({ session, index, updatedAt: updatedAtOf(session) }));
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || b.index - a.index);
  return candidates.length ? candidates[0].session : null;
}

/** Agent-preset label of a session summary. 0.1.5 moved it out of the flat
 * summary into the projection hints (spike-verified:
 * `items[].projections.values.agentPreset`); 0.1.1 kept the flat field. */
function agentPresetOf(session) {
  if (!session || typeof session !== 'object') return '';
  if (typeof session.agentPreset === 'string' && session.agentPreset.trim()) return session.agentPreset.trim();
  const values = session.projections && session.projections.values;
  if (values && typeof values.agentPreset === 'string' && values.agentPreset.trim()) return values.agentPreset.trim();
  return '';
}

/** commands/execute args for the 0.1.5 shape (plan §4.2): the old `images`
 * parameter is gone and the gateway rejects unknown fields, so BOTH protocols
 * send `submittedAttachments` — the rc-number branch is retired. The `version`
 * parameter stays for call-site stability. */
function commandArgsForVersion(version, agentId) {
  return { agentId: String(agentId || ''), line: '/compact', submittedAttachments: [] };
}

/** 0.1.1 commands/execute args (rollback path): rc.8+ carries `images:[]`,
 * rc.7- omits it. Used as the argument-shape fallback when a rolled-back
 * runtime rejects the unified 0.1.5 shape. */
function legacyCommandArgsForVersion(version, agentId) {
  const args = { agentId: String(agentId || ''), line: '/compact' };
  const rc = String(version || '').match(/(?:^|[-.])rc\.(\d+)(?:$|[-.])/i);
  const includeImages = !rc || Number(rc[1]) >= 8;
  if (includeImages) args.images = [];
  return args;
}

function isArgumentShapeError(error) {
  if (!error) return false;
  const code = String(error.code || '').toLowerCase();
  if (['invalid_arguments', 'invalid-arguments', 'argument-shape', 'invalid_args', 'unknown_field', 'gateway/arguments-invalid'].includes(code)) return true;
  const message = String(error.message || error.reason || '').toLowerCase();
  return /unknown\s+(?:field|property)|unexpected\s+(?:field|property)|invalid\s+(?:argument|args|payload)|argument\s+(?:shape|count)|images|submittedattachments|arguments-invalid|do not match the descriptor/.test(message);
}

function runtimeOrigin(baseUrl) {
  let parsed;
  try { parsed = new URL(String(baseUrl || '')); } catch { throw new HarnessRpcError('runtime-url', 'invalid runtime URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname) {
    throw new HarnessRpcError('runtime-url', 'runtime URL must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function endpoint(origin, pathname) {
  return new URL(pathname, `${origin}/`).toString();
}

async function defaultRequest(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const status = Number(response && response.status);
  let body;
  if (response && Object.prototype.hasOwnProperty.call(response, 'body')) body = response.body;
  else if (response && typeof response.json === 'function') {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new HarnessRpcError('response-size', 'runtime response is too large');
    try { body = text ? JSON.parse(text) : {}; } catch { throw new HarnessRpcError('response-json', 'runtime returned invalid JSON'); }
  } else body = response || {};
  return { status: Number.isFinite(status) ? status : 200, body: body || {} };
}

function rpcErrorFromBody(status, body) {
  const error = body && (body.error || (body.result && body.result.error));
  if (status < 200 || status >= 300) {
    const code = error && error.code ? error.code : `http-${status}`;
    const message = error && (error.message || error.reason) || `runtime HTTP ${status}`;
    return new HarnessRpcError(code, message, { status });
  }
  if (error) {
    return new HarnessRpcError(error.code || 'runtime-error', error.message || error.reason || 'runtime request failed', { status });
  }
  if (body && body.accepted === false) return new HarnessRpcError(body.code || 'rejected', body.reason || 'runtime rejected request', { status });
  if (body && body.result && body.result.ok === false) return new HarnessRpcError(body.result.code || 'rejected', body.result.reason || 'runtime rejected request', { status });
  return null;
}

/** Wrap a request impl with the runtime browser cookie + a single 401
 * self-heal (invalidate → re-exchange → retry). Mirrors runtime-mux's unary
 * call() so the fetch fallback behaves like the mux transport. */
function createAuthedFetch({ request, auth }) {
  if (!auth || typeof auth.getCookie !== 'function') return request;
  return async function authedRequest(url, options) {
    const withCookie = async () => {
      const headers = { ...(options && options.headers) };
      const cookie = await auth.getCookie();
      if (cookie) headers.cookie = cookie;
      return request(url, { ...options, headers });
    };
    const first = await withCookie();
    if (first && first.status === 401 && typeof auth.invalidate === 'function') {
      auth.invalidate();
      return withCookie(); // token is process-stable: the re-exchange succeeds
    }
    return first;
  };
}

function extractSessions(body) {
  const candidates = [
    body && body.sessions,
    body && body.result && body.result.sessions,
    body && body.result && body.result.value && body.result.value.items,
    body && body.result && body.result.items,
    body && body.value && body.value.items,
    body && body.items,
    body && body.data && body.data.sessions,
    body && Array.isArray(body.result) ? body.result : null,
    Array.isArray(body) ? body : null,
  ];
  return candidates.find(Array.isArray) || [];
}

/** Compact-oriented RPC client with the 0.1.1 ↔ 0.1.5 dual stack (plan §4.2):
 *  - protocol 'slash' (0.1.5): slash endpoints (`session/list`, `commands/
 *    execute`) with descriptor-shaped args; a live mux client is preferred as
 *    the unary transport (cookie + 401 self-heal already live there), with a
 *    cookie-gated fetch fallback for when the event feed is down.
 *  - protocol 'legacy' (0.1.1, default): the original dot-method paths stay
 *    byte-identical so a rolled-back runtime keeps working. */
function createHarnessRpcClient(options) {
  const opts = options || {};
  const origin = runtimeOrigin(opts.baseUrl);
  const version = opts.version || '';
  const protocol = opts.protocol === 'slash' ? 'slash' : 'legacy';
  const mux = opts.mux && typeof opts.mux.call === 'function' ? opts.mux : null;
  const request = protocol === 'slash'
    ? createAuthedFetch({ request: opts.request || defaultRequest, auth: opts.auth || null })
    : (opts.request || defaultRequest);
  const makeRpcId = typeof opts.rpcId === 'function' ? opts.rpcId : () => randomUUID();

  async function post(method, args, legacyPath) {
    if (protocol === 'slash' && mux) {
      // Normalize the mux unary result into the response-body shape the fetch
      // path produces, so callers (extractSessions, error mapping) stay
      // protocol-agnostic.
      const res = await mux.call(method, args);
      if (res && res.ok) return { result: { ok: true, value: res.value } };
      throw new HarnessRpcError((res && res.code) || 'runtime-error', (res && res.reason) || `RPC ${method} failed`);
    }
    // 0.1.5 enforces method === path endpoint (`/api/session/list`); the old
    // `/api/session.list` style only exists on 0.1.1.
    const pathname = protocol === 'slash' ? `/api/${method}` : legacyPath;
    const body = { type: 'client-request', rpcId: String(makeRpcId()), method, payload: { args } };
    let response;
    try {
      response = await request(endpoint(origin, pathname), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new HarnessRpcError(error && error.code === 'ABORT_ERR' ? 'timeout' : 'network', error && error.message || 'runtime request failed', { cause: error });
    }
    const decoded = await readResponse(response);
    const error = rpcErrorFromBody(decoded.status, decoded.body);
    if (error) throw error;
    return decoded.body;
  }

  async function listSessions() {
    // 0.1.5 descriptor: args = {_request:{}}; 0.1.1 accepts the flat {}.
    return extractSessions(await post('session/list', protocol === 'slash' ? { _request: {} } : {}, '/api/session.list'));
  }

  async function executeCompact(agentId) {
    // Primary attempt carries the 0.1.5 shape. On an explicit argument-shape
    // rejection (a rolled-back 0.1.1 that rejects submittedAttachments) retry
    // once with the version-matched legacy args.
    const primary = commandArgsForVersion(version, agentId);
    try {
      await post('commands/execute', primary, '/api/commands/execute');
      return { ok: true };
    } catch (error) {
      if (!isArgumentShapeError(error)) return { ok: false, code: error.code || 'runtime-error', reason: error.message };
      try {
        await post('commands/execute', legacyCommandArgsForVersion(version, agentId), '/api/commands/execute');
        return { ok: true };
      } catch (retryError) {
        return { ok: false, code: retryError.code || 'runtime-error', reason: retryError.message };
      }
    }
  }

  async function compactLatestSession() {
    let sessions;
    try { sessions = await listSessions(); }
    catch (error) { return { ok: false, code: error.code || 'runtime-error', reason: error.message }; }
    const session = selectLatestNonBlankSession(sessions);
    const sessionId = sessionIdOf(session);
    if (!sessionId) return { ok: false, code: 'no-session', reason: 'no active non-blank session' };
    const result = await executeCompact(sessionId);
    return result.ok ? { ok: true, sessionId } : { ...result, sessionId };
  }

  return { listSessions, executeCompact, compactLatestSession };
}

module.exports = {
  selectLatestNonBlankSession,
  commandArgsForVersion,
  legacyCommandArgsForVersion,
  isArgumentShapeError,
  agentPresetOf,
  createHarnessRpcClient,
  createHarnessRpcWire,
};


// ---------------------------------------------------------------------------
// Wire-level RPC client: dual protocol (plan §4.2, docs/strategy/
// 2026-09-22-harness-upgrade-compat-plan.md §1.4/§4.2).
//
// 0.1.1 (protocol 'legacy', the default): POST /api/<dot method> with a flat
//   payload — kept byte-identical so a rolled-back runtime keeps working.
// 0.1.5 (protocol 'slash'): POST /api/<namespace/method> with
//   payload.args = the endpoint descriptor's named parameters
//   (session/list → {_request:{}}, session/create|prompt|cancel|page →
//   {request:{…}}) and the browser cookie on every request. When a live mux
//   client is injected the unary calls ride mux.call (cookie + 401 self-heal
//   already implemented there); otherwise the same wire shape goes out over a
//   cookie-gated fetch with one 401 retry.
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');

function wireRpcId() { return 'rpc-' + crypto.randomBytes(6).toString('hex'); }

/**
 * Wire client for the live runtime.
 * legacy: POST /api/<method>  body {type:'client-request', rpcId, method, payload}
 * slash : POST /api/<endpoint>  body {…, payload:{args:<named params>}}
 * resp:   { result: { ok, value | error } }
 * @param {string} baseUrl
 * @param {{ fetchImpl?: Function, timeoutMs?: number, protocol?: 'legacy'|'slash',
 *           mux?: {call:Function}|null, auth?: {getCookie:Function,invalidate?:Function}|null }} [deps]
 */
function createHarnessRpcWire(baseUrl, { fetchImpl, timeoutMs = 15_000, protocol = 'legacy', mux = null, auth = null } = {}) {
  const slash = protocol === 'slash';
  const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
  const authedFetch = slash ? createAuthedFetch({ request: doFetch, auth }) : doFetch;
  const muxClient = mux && typeof mux.call === 'function' ? mux : null;
  const origin = String(baseUrl || '').replace(/\/+$/, '');

  async function rpc(method, payload = {}) {
    // 0.1.1 wire: dot method endpoint, flat payload.
    const id = wireRpcId();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
    try {
      const res = await doFetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload }),
        signal: ac ? ac.signal : undefined,
      });
      const body = await res.json();
      const result = body && body.result ? body.result : {};
      if (!result.ok) {
        const reason = result.error && result.error.message ? result.error.message : `RPC ${method} failed`;
        throw Object.assign(new Error(reason), { code: result.error && result.error.code });
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 0.1.5 wire: slash endpoint + descriptor-shaped named args. */
  async function rpcSlash(method, args = {}) {
    if (muxClient) {
      const res = await muxClient.call(method, args);
      if (res && res.ok) return res.value;
      throw Object.assign(new Error((res && res.reason) || `RPC ${method} failed`), { code: (res && res.code) || 'runtime-error' });
    }
    const id = wireRpcId();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
    try {
      const res = await authedFetch(`${origin}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: id, method, payload: { args } }),
        signal: ac ? ac.signal : undefined,
      });
      const body = await res.json();
      const result = body && body.result ? body.result : {};
      if (!result.ok) {
        const reason = result.error && result.error.message ? result.error.message : `RPC ${method} failed`;
        throw Object.assign(new Error(reason), { code: result.error && result.error.code });
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  // session/history was removed on 0.1.5 (split into the session/follow stream
  // + the session/page unary) and session/follow|control are streams: they have
  // no unary form on the slash protocol.
  const noUnary = (method) => async () => {
    throw new HarnessRpcError('unsupported', `${method} has no unary form on 0.1.5; use the runtime-mux streams instead`);
  };

  return {
    rpc,
    rpcSlash,
    listSessions: slash
      ? () => rpcSlash('session/list', { _request: {} }).then((v) => (v && v.items) || [])
      : () => rpc('session.list').then((v) => (v && v.items) || []),
    createSession: slash
      ? () => rpcSlash('session/create', { request: {} }).then((v) => v && v.sessionId)
      : () => rpc('session.create').then((v) => v.sessionId),
    prompt: slash
      ? (sessionId, text, mode = 'steer') =>
        rpcSlash('session/prompt', { request: { requestId: wireRpcId(), sessionId, mode, content: [{ type: 'text', text }] } })
      : (sessionId, text, mode = 'steer') =>
        rpc('session.prompt', { sessionId, mode, content: [{ type: 'text', text }] }),
    cancel: slash
      ? (sessionId) => rpcSlash('session/cancel', { request: { sessionId } })
      : (sessionId) => rpc('session.cancel', { sessionId }),
    history: slash
      ? noUnary('session/history')
      : (sessionId) => rpc('session.history', { sessionId }).then((v) => (v && v.events) || []),
    // SPEC-05 (Task 6): probe-proven session stream transports used only by the
    // Office runtime adapter's snapshot/resync composition. On the slash
    // protocol the journal reads ride the mux streams instead (main.js opens
    // session/follow directly); page stays available as the unary backfill.
    page: slash
      ? (sessionId, throughSeq) => rpcSlash('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq } })
      : (sessionId, throughSeq) => rpc('session.page', { sessionId, throughSeq }),
    follow: slash ? noUnary('session/follow') : (sessionId) => rpc('session.follow', { sessionId }),
    control: slash ? noUnary('session/control') : (sessionId, payload) => rpc('session.control', { sessionId, payload }),
  };
}
