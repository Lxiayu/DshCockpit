// src/mcp-connect.js — two-tier health checks for MCP servers (T1, v0.3.1).
//
// Tier 1 (auto, <2s): stdio → does the command resolve (which / where.exe)?
//                      remote → does the URL answer a HEAD?
// Tier 2 (manual): full MCP handshake in a short-lived child process —
//                  initialize → notifications/initialized → tools/list — then
//                  the child is killed. Results cached in memory for 5 minutes
//                  (VS Code's posture); the cache lives here, NOT in
//                  settings.json, so health probes cause zero disk writes.
//
// MCP stdio transport = newline-delimited JSON-RPC 2.0 over stdin/stdout.
// The probe process is fully independent of the DSH runtime, so testing a
// server never disturbs a running harness. Electron-free: spawn and fetch are
// injectable for tests.
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const TIER2_TIMEOUT_DEFAULT_MS = 15_000;
const TIER1_TIMEOUT_MS = 2_000;
const HEAD_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;
const PROTOCOL_VERSION = '2024-11-05';

// ------------------------------------------------------------ status helpers

function statusFor(tier1, tier2) {
  if (tier2) return tier2.ok ? 'healthy' : `error:${tier2.reason || 'handshake failed'}`;
  if (tier1) return tier1.ok ? tier1.status : `error:${tier1.reason || tier1.status || 'unreachable'}`;
  return 'unknown';
}

/** Resolve a command via where.exe (win) / which (posix); null when absent.
 * An absolute path is a file-existence question, not a PATH lookup: `where.exe`
 * rejects paths outright ("Invalid pattern is specified in path:pattern"), and
 * a full path is a perfectly valid MCP stdio command. */
function whichCommand(command, timeoutMs = TIER1_TIMEOUT_MS) {
  const cmd = String(command || '');
  if (path.isAbsolute(cmd)) {
    try { return Promise.resolve(fs.existsSync(cmd) ? cmd : null); } catch { return Promise.resolve(null); }
  }
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'where.exe' : 'which';
    let child;
    try {
      child = spawn(exe, [command], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim().split(/\r?\n/)[0]);
      else resolve(null);
    });
  });
}

/** HEAD/GET probe for remote endpoints (3s). */
function probeUrl(url, method = 'HEAD', timeoutMs = HEAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(url); } catch { resolve({ ok: false, reason: 'invalid url' }); return; }
    const mod = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!mod) { resolve({ ok: false, reason: 'unsupported protocol' }); return; }
    const req = mod.request(target, { method, timeout: timeoutMs, agent: false }, (res) => {
      res.resume();
      // 405 = endpoint alive but rejects HEAD — still "reachable"
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
    req.end();
  });
}

// ------------------------------------------------------------ JSON-RPC probe

function rpcLine(id, method, params) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`;
}

/**
 * Tier-2 stdio handshake. `spawnImpl` injectable; resolves
 * { ok, tools?, reason? } and always terminates the child.
 */
function probeStdio({ command, args, env, timeoutMs, spawnImpl }) {
  const doSpawn = spawnImpl || spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = doSpawn(command, args, {
        env: env ? { ...process.env, ...env } : undefined,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      resolve({ ok: false, reason: `spawn failed: ${e.message}` });
      return;
    }
    let buf = '';
    let tools = null;
    let failed = null;
    let initOk = false;
    const timer = setTimeout(() => {
      failed = failed || (initOk ? 'timeout waiting for tools/list' : 'timeout during initialize (first run may need to download dependencies)');
      finish();
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      if (failed) resolve({ ok: false, reason: failed });
      else if (!initOk) resolve({ ok: false, reason: 'no initialize response' });
      else if (tools === null) resolve({ ok: false, reason: 'no tools/list response' });
      else resolve({ ok: true, tools });
    };

    child.on('error', (e) => { failed = failed || `spawn: ${e.message}`; finish(); });
    child.on('close', () => { failed = failed || 'server exited before handshake completed'; finish(); });
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      // a broken server streaming without newlines must not balloon memory
      // (bounded by the timeout, but a busy process can push a lot in 15s)
      if (buf.length > 2_000_000) { failed = 'oversized response (no complete JSON-RPC message)'; finish(); return; }
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) { failed = `initialize: ${msg.error.message || 'rejected'}`; finish(); return; }
          initOk = true;
          try { child.stdin.write(rpcLine(null, 'notifications/initialized')); } catch { /* ignore */ }
          try { child.stdin.write(rpcLine(2, 'tools/list')); } catch { /* ignore */ }
        } else if (msg.id === 2) {
          if (msg.error) { failed = `tools/list: ${msg.error.message || 'rejected'}`; finish(); return; }
          tools = (msg.result && Array.isArray(msg.result.tools) ? msg.result.tools : [])
            .map((t) => (t && typeof t.name === 'string' ? t.name : null))
            .filter(Boolean);
          finish();
          return;
        }
      }
    });
    try {
      child.stdin.write(rpcLine(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'DshCockpit', version: '0.3.1' },
      }));
    } catch (e) {
      failed = `stdin: ${e.message}`;
      finish();
    }
  });
}

/** Tier-2 remote probe: a JSON-RPC POST (streamable-style endpoints answer;
 * SSE-only endpoints get a readable "verify in a session" message). */
function probeRemote(url, headers, timeoutMs, fetchImpl) {
  const doFetch = fetchImpl || ((u, opts) => new Promise((resolve, reject) => {
    let target;
    try { target = new URL(u); } catch { reject(new Error('invalid url')); return; }
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, { method: 'POST', headers: opts.headers, timeout: opts.timeoutMs, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 2_000_000) chunks.push(c); // initialize responses are tiny; cap the rest
      });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } reject(new Error('timeout')); });
    req.on('error', reject);
    req.end(opts.body);
  }));
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'DshCockpit', version: '0.3.1' } } });
    doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(headers || {}) }, body, timeoutMs })
      .then((res) => {
        if (!res.ok) {
          resolve({ ok: false, reason: res.status === 401 || res.status === 403 ? 'auth failed (check headers)' : `HTTP ${res.status}` });
          return;
        }
        const text = res.text || '';
        const dm = text.match(/"data":\s*(\{.*\})/s);
        let payload = null;
        try { payload = JSON.parse(dm ? dm[1] : text); } catch { /* sse frame or non-json */ }
        if (payload && payload.result) resolve({ ok: true, tools: [] });
        else resolve({ ok: true, tools: [], note: 'endpoint responded; full tool listing requires a live session' });
      })
      .catch((e) => resolve({ ok: false, reason: e.code || e.message }));
  });
}

// -------------------------------------------------------------------- facade

function createMcpConnect({ log, fetchImpl, spawnImpl } = {}) {
  const cache = new Map(); // id → { at, result }

  function cached(id) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result;
    return null;
  }
  function store(id, result) {
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    cache.set(id, { at: Date.now(), result });
  }

  return {
    /** Tier 1: silent quick check (list refresh). Never throws. */
    async tier1(server) {
      try {
        if (server.transport === 'stdio') {
          const found = await whichCommand(server.command);
          return found ? { ok: true, status: 'binaryFound', path: found } : { ok: false, status: 'commandNotFound', reason: 'command not found' };
        }
        const r = await probeUrl(server.url, 'HEAD');
        return r.ok ? { ok: true, status: 'reachable', status2: r.status } : { ok: false, status: 'unreachable', reason: r.reason };
      } catch (e) {
        return { ok: false, status: 'error', reason: e.message };
      }
    },

    /**
     * Tier 2: full handshake (manual button). `resolveSecret(id, key)` is the
     * manager's vault accessor; secret env values ride the child env here so
     * the probe matches what the runtime will do.
     */
    async tier2(server, resolveSecret) {
      const hit = cached(server.id);
      if (hit) return hit;
      const timeoutMs = Math.max(3, Math.min(120, Number(server.startupTimeoutSec) || 10)) * 1000;
      let result;
      if (server.transport === 'stdio') {
        const env = {};
        for (const k of server.envSecretKeys || []) {
          const v = resolveSecret ? resolveSecret(server.id, k) : null;
          if (v) env[k] = v;
        }
        for (const [k, v] of Object.entries(server.envPlain || {})) env[k] = v;
        result = await probeStdio({ command: server.command, args: server.args || [], env, timeoutMs, spawnImpl });
      } else {
        result = await probeRemote(server.url, server.headers || {}, timeoutMs, fetchImpl);
      }
      log(`[mcp] tier2 "${server.id}": ${result.ok ? `ok (${(result.tools || []).length} tools)` : result.reason}`);
      store(server.id, result);
      return result;
    },

    statusFor,
    clearCache(id) { if (id) cache.delete(id); else cache.clear(); },
  };
}

module.exports = {
  TIER2_TIMEOUT_DEFAULT_MS,
  TIER1_TIMEOUT_MS,
  CACHE_TTL_MS,
  PROTOCOL_VERSION,
  whichCommand,
  probeUrl,
  probeStdio,
  probeRemote,
  statusFor,
  createMcpConnect,
};
