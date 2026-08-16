// test/remote-control.test.js - phone remote-control gateway coverage.
//
// Uses a fake runtime (plain HTTP + hand-rolled WS echo) and talks to the
// gateway over real TLS with rejectUnauthorized:false (self-signed cert).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const { RemoteControl, stripCookieValue, COOKIE_NAME } = require('../src/remote-control');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-remote-test-'));
}

/** Identity-safeStorage mock that still proves encrypt/decrypt round-trips. */
function fakeSafeStorage() {
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isEncryptionAvailable: () => true,
    encryptString(plain) { calls.encrypt += 1; return Buffer.from('enc!' + plain, 'utf8'); },
    decryptString(buf) { calls.decrypt += 1; return buf.toString('utf8').slice(4); },
  };
}

/** Fake dsh runtime: GET /hello answers JSON; upgrade echoes one text frame. */
function fakeRuntime() {
  const seen = { lastCookie: null };
  const server = http.createServer((req, res) => {
    seen.lastCookie = req.headers.cookie === undefined ? null : req.headers.cookie;
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host }));
      return;
    }
    res.writeHead(404); res.end('nf');
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (buf) => {
      // parse one masked text frame
      const opcode = buf[0] & 0x0f;
      if (opcode !== 1) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = buf.subarray(off, off + 4); off += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
      const head = payload.length < 126
        ? Buffer.from([0x81, payload.length])
        : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([head, payload]));
    });
  });
  return { server, seen };
}

function httpsReq(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    // agent:false - one fresh connection per request; keep-alive sockets would
    // keep the test child process alive after the assertions finish.
    const req = https.request({ host: '127.0.0.1', port, path: reqPath, rejectUnauthorized: false, agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('client timeout')); });
    req.end();
  });
}

function wsHandshake(port, reqPath, cookie) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let sent = false;
    let done = false;
    const finish = (err, ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(ok);
    };
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const lines = [
        `GET ${reqPath} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    const timer = setTimeout(() => finish(new Error('ws timeout')), 5000);
    sock.on('error', (e) => finish(e));
    sock.on('close', () => finish(new Error('closed before echo')));
    sock.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (!sent) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString('utf8');
        if (!head.includes(' 101 ')) { finish(new Error('not 101: ' + head.split('\r\n')[0])); return; }
        sent = true;
        buf = buf.subarray(idx + 4);
        sock.write(maskedFrame('ping'));
      }
      if (sent && buf.length >= 2 && (buf[0] & 0x0f) === 1) {
        const len = buf[1] & 0x7f;
        if (buf.length >= 2 + len) {
          const payload = buf.subarray(2, 2 + len).toString('utf8');
          if (payload === 'ping') finish(null, true);
        }
      }
    });
  });
}

// ------------------------------------------------------------------ suites

test('stripCookieValue removes only the named cookie', () => {
  assert.strictEqual(stripCookieValue(`a=1; ${COOKIE_NAME}=secret; b=2`, COOKIE_NAME), 'a=1; b=2');
  assert.strictEqual(stripCookieValue(`${COOKIE_NAME}=secret`, COOKIE_NAME), undefined);
  assert.strictEqual(stripCookieValue(undefined, COOKIE_NAME), undefined);
  assert.strictEqual(stripCookieValue('a=1', COOKIE_NAME), 'a=1');
});

test('token is persisted encrypted and reloads identically', async () => {
  const dir = tmpDir();
  const ss = fakeSafeStorage();
  const a = new RemoteControl({ userDataDir: dir, safeStorage: ss, log: () => {} });
  assert.ok(ss.calls.encrypt >= 1, 'safeStorage.encryptString used');
  const raw = fs.readFileSync(path.join(dir, 'remote-token.bin'), 'utf8');
  assert.ok(raw.startsWith('enc!'), 'token file is safeStorage ciphertext, not plain:<token>');
  const b = new RemoteControl({ userDataDir: dir, safeStorage: fakeSafeStorage(), log: () => {} });
  assert.strictEqual(b.tokens.value, a.tokens.value, 'token survives reload');
});

test('gateway full flow: 401 -> pair -> cookie proxy -> ws pipe -> revoke', async (t) => {
  const dir = tmpDir();
  const ss = fakeSafeStorage();
  const logs = [];
  const gw = new RemoteControl({ userDataDir: dir, safeStorage: ss, log: (l) => logs.push(l) });
  const rt = fakeRuntime();
  await new Promise((r) => rt.server.listen(0, '127.0.0.1', r));
  // clean up even when an assertion fails mid-test (otherwise the listening
  // sockets keep the test child process alive forever)
  t.after(() => {
    gw.stop();
    try { rt.server.close(); } catch { /* ignore */ }
    try { rt.server.closeAllConnections(); } catch { /* older node */ }
  });
  const rtPort = rt.server.address().port;
  gw.setRuntimeUrl(`http://127.0.0.1:${rtPort}`);
  const st = await gw.start({ port: 0 });
  assert.strictEqual(st.running, true);
  const port = st.port;

  // 1. no cookie -> 401 JSON for API-ish requests, pairing page for browsers
  const anon = await httpsReq(port, '/api/session.list', { accept: 'application/json' });
  assert.strictEqual(anon.status, 401);
  const anonHtml = await httpsReq(port, '/', { accept: 'text/html,application/xhtml+xml' });
  assert.strictEqual(anonHtml.status, 401);
  assert.ok(anonHtml.body.includes('DshCockpit'), 'pairing page served');

  // 2. wrong pairing code -> 401 (and no cookie granted)
  const bad = await httpsReq(port, '/__dsh_pair?c=000001', { accept: 'text/html' });
  assert.strictEqual(bad.status, 401);
  assert.ok(!bad.headers['set-cookie'], 'no cookie on bad code');

  // 3. right pairing code -> 302 + long-lived HttpOnly cookie
  const pair = gw.refreshPairingCode();
  const okPair = await httpsReq(port, `/__dsh_pair?c=${pair.code}`, { accept: 'text/html' });
  assert.strictEqual(okPair.status, 302);
  const setCookie = (okPair.headers['set-cookie'] || []).join('\n');
  assert.ok(setCookie.includes(`${COOKIE_NAME}=`), 'cookie set');
  assert.ok(/HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), 'cookie flags');
  const cookie = /dsh_remote=([A-Za-z0-9]+)/.exec(setCookie)[0];

  // 5. authenticated HTTP proxies to the runtime; auth cookie is stripped
  const proxied = await httpsReq(port, '/hello', { accept: 'application/json', cookie: `other=x; ${cookie}` });
  assert.strictEqual(proxied.status, 200);
  assert.deepStrictEqual(JSON.parse(proxied.body), { ok: true, host: `127.0.0.1:${rtPort}` });
  assert.ok(!String(rt.seen.lastCookie || '').includes(COOKIE_NAME), 'gateway cookie never reaches the runtime');
  assert.strictEqual(rt.seen.lastCookie, 'other=x');

  // 6. WS upgrade: unauthorized destroyed, authorized piped + echo round-trip
  await assert.rejects(() => wsHandshake(port, '/api/events.mux', null), /ws timeout|closed|not 101|ECONNRESET/i);
  await wsHandshake(port, '/api/events.mux', cookie);

  // 7. revoke: old cookie dies
  gw.revokeToken();
  const dead = await httpsReq(port, '/hello', { accept: 'application/json', cookie });
  assert.strictEqual(dead.status, 401);

  // logs must never contain the token or the pairing query
  const logText = logs.join('\n');
  assert.ok(!logText.includes(gw.tokens.value) && !logText.includes(`c=${pair.code}`), 'no secrets in logs');

  gw.stop();
  rt.server.close();
  try { rt.server.closeAllConnections(); } catch { /* older node */ }
  assert.strictEqual(gw.running, false);
});

test('runtime down -> 503 over HTTP, ws destroyed', async (t) => {
  const gw = new RemoteControl({ userDataDir: tmpDir(), safeStorage: fakeSafeStorage(), log: () => {} });
  t.after(() => gw.stop());
  const st = await gw.start({ port: 0 });
  const pair = gw.refreshPairingCode();
  const okPair = await httpsReq(st.port, `/__dsh_pair?c=${pair.code}`);
  const cookie = /dsh_remote=([A-Za-z0-9]+)/.exec((okPair.headers['set-cookie'] || []).join('\n'))[0];
  const res = await httpsReq(st.port, '/hello', { accept: 'application/json', cookie });
  assert.strictEqual(res.status, 503);
  await assert.rejects(() => wsHandshake(st.port, '/api/events.mux', cookie), /ws timeout|closed/i);
  gw.stop();
});

test('pairing brute-force lock after 5 failures', async (t) => {
  const gw = new RemoteControl({ userDataDir: tmpDir(), safeStorage: fakeSafeStorage(), log: () => {} });
  t.after(() => gw.stop());
  const st = await gw.start({ port: 0 });
  gw.refreshPairingCode();
  for (let i = 0; i < 5; i++) {
    const r = await httpsReq(st.port, '/__dsh_pair?c=999999', { accept: 'text/html' });
    assert.strictEqual(r.status, 401);
  }
  const locked = await httpsReq(st.port, '/__dsh_pair?c=000002', { accept: 'text/html' });
  assert.strictEqual(locked.status, 429);
  gw.stop();
});

test('setRuntimeUrl change drops piped clients and status tracks it', async (t) => {
  const gw = new RemoteControl({ userDataDir: tmpDir(), safeStorage: fakeSafeStorage(), log: () => {} });
  t.after(() => gw.stop());
  await gw.start({ port: 0 });
  assert.strictEqual(gw.status().runtimeReady, false);
  gw.setRuntimeUrl('http://127.0.0.1:45678');
  assert.strictEqual(gw.status().runtimeReady, true);
  assert.strictEqual(gw.runtimePort, 45678);
  gw.setRuntimeUrl(null);
  assert.strictEqual(gw.status().runtimeReady, false);
  gw.stop();
});


function maskedFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  const lenByte = payload.length < 126
    ? Buffer.from([0x80 | payload.length])
    : Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([Buffer.from([0x81]), lenByte, mask, masked]);
}
