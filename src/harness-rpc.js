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

function commandArgsForVersion(version, agentId) {
  const args = { agentId: String(agentId || ''), line: '/compact' };
  const rc = String(version || '').match(/(?:^|[-.])rc\.(\d+)(?:$|[-.])/i);
  const includeImages = !rc || Number(rc[1]) >= 8;
  if (includeImages) args.images = [];
  return args;
}

function isArgumentShapeError(error) {
  if (!error) return false;
  const code = String(error.code || '').toLowerCase();
  if (['invalid_arguments', 'invalid-arguments', 'argument-shape', 'invalid_args', 'unknown_field'].includes(code)) return true;
  const message = String(error.message || error.reason || '').toLowerCase();
  return /unknown\s+(?:field|property)|unexpected\s+(?:field|property)|invalid\s+(?:argument|args|payload)|argument\s+(?:shape|count)|images/.test(message);
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

function extractSessions(body) {
  const candidates = [
    body && body.sessions,
    body && body.result && body.result.sessions,
    body && body.data && body.data.sessions,
    body && Array.isArray(body.result) ? body.result : null,
    Array.isArray(body) ? body : null,
  ];
  return candidates.find(Array.isArray) || [];
}

function createHarnessRpcClient(options) {
  const opts = options || {};
  const origin = runtimeOrigin(opts.baseUrl);
  const request = opts.request || defaultRequest;
  const makeRpcId = typeof opts.rpcId === 'function' ? opts.rpcId : () => randomUUID();
  const version = opts.version || '';

  async function post(pathname, method, args) {
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
    return extractSessions(await post('/api/session.list', 'session/list', {}));
  }

  async function executeCompact(agentId) {
    const primary = commandArgsForVersion(version, agentId);
    try {
      await post('/api/commands/execute', 'commands/execute', primary);
      return { ok: true };
    } catch (error) {
      if (!isArgumentShapeError(error)) return { ok: false, code: error.code || 'runtime-error', reason: error.message };
      const alternate = primary.images ? { agentId: primary.agentId, line: primary.line } : { ...primary, images: [] };
      try {
        await post('/api/commands/execute', 'commands/execute', alternate);
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
  isArgumentShapeError,
  createHarnessRpcClient,
};
