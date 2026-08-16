// src/remote-control.js - phone remote-control gateway (shell-side secure proxy).
//
// The dsh runtime binds 127.0.0.1 only and its HTTP surface has NO auth, TLS,
// or origin policy (upstream is a single-user local service by design; see
// dsh-host-webserver README). This gateway is the ONE deliberate network
// exposure point:
//
//   phone browser --HTTPS(self-signed)--> [gateway, 0.0.0.0:port]
//     auth:   one-shot pairing code (10 min TTL) -> long-lived token cookie
//             (HttpOnly + Secure + SameSite=Lax; token stored encrypted via
//             Electron safeStorage, never in settings.json or backups)
//     HTTP:   proxied to  http://127.0.0.1:<runtime port>
//     WS:     upgrade is a raw TCP pipe to the runtime (frames stay opaque)
//
// The runtime keeps binding loopback: its unauthenticated surface never leaves
// this machine. Brute-force guard: 5 wrong pairing attempts lock an IP for
// 5 minutes. Logs never contain the token or pairing query strings.
'use strict';

const https = require('node:https');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = 'dsh_remote';
const PAIR_PATH = '/__dsh_pair';
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const CERT_DAYS = 397; // stay under the 398-day ceiling some mobile browsers enforce
const TOKEN_BYTES = 32; // 64 hex chars

/** LAN IPv4 candidates (sorted, deduped; virtual adapters included - the user picks). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push(ni.address);
    }
  }
  return [...new Set(out)].sort();
}

/** Remove one cookie from a Cookie header value; undefined when nothing remains. */
function stripCookieValue(header, name) {
  if (!header) return header;
  const kept = String(header).split(/;\s*/).filter((part) => {
    const eq = part.indexOf('=');
    return !(eq >= 0 && part.slice(0, eq).trim() === name);
  });
  return kept.length ? kept.join('; ') : undefined;
}

/** Constant-time string compare for fixed-length secrets (both must be hex here). */
function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Self-signed cert via node-forge; SAN covers localhost + every LAN IPv4. */
function generateCert(ips) {
  const forge = require('node-forge'); // lazy: dev/test may run without electron deps
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + CERT_DAYS * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'DshCockpit Remote' },
    { name: 'organizationName', value: 'DshCockpit' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...ips.map((ip) => ({ type: 7, ip })),
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey), ips };
}

/** Long-lived token persisted under userData, encrypted with safeStorage when available. */
class TokenStore {
  constructor(file, safeStorage, log) {
    this.file = file;
    this.safeStorage = safeStorage || null;
    this.log = log || (() => {});
    this.warned = false;
    this.value = this.load();
  }

  load() {
    let raw;
    try { raw = fs.readFileSync(this.file); } catch { return this.regenerate(); }
    try {
      const text = raw.toString('utf8');
      if (text.startsWith('plain:')) {
        if (!this.warned) { this.log('[remote] token stored unencrypted (safeStorage unavailable)'); this.warned = true; }
        return text.slice(6);
      }
      if (this.safeStorage && typeof this.safeStorage.decryptString === 'function') {
        return this.safeStorage.decryptString(raw) || this.regenerate();
      }
    } catch (e) {
      this.log(`[remote] token load failed (${e.message}); regenerating`);
    }
    return this.regenerate();
  }

  regenerate() {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      let payload;
      let usable = false;
      try {
        usable = !!this.safeStorage && typeof this.safeStorage.encryptString === 'function'
          && (typeof this.safeStorage.isEncryptionAvailable !== 'function' || this.safeStorage.isEncryptionAvailable());
      } catch { usable = false; }
      if (usable) payload = this.safeStorage.encryptString(token);
      else payload = Buffer.from(`plain:${token}`, 'utf8');
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[remote] token persist failed: ${e.message}`);
    }
    return token;
  }
}

/**
 * The remote-control gateway. Construct after app ready (safeStorage needs it);
 * call setRuntimeUrl() whenever the runtime URL appears/changes so both the
 * HTTP proxy and active WS pipes follow it, and start()/stop() from settings.
 */
class RemoteControl {
  /** @param {{ userDataDir: string, log?: (line: string) => void, safeStorage?: object }} opts */
  constructor(opts) {
    this.userDataDir = opts.userDataDir;
    this.log = opts.log || (() => {});
    this.tokens = new TokenStore(path.join(opts.userDataDir, 'remote-token.bin'), opts.safeStorage, this.log);
    this.server = null;
    this.port = null;
    this.runtimePort = null;
    this.pairing = null; // { code, expiresAt, used }
    this.pairFails = new Map(); // ip -> { fails, lockUntil }
    this.clientSockets = new Set();
    this.certFile = path.join(opts.userDataDir, 'remote-cert.json');
  }

  get running() { return !!this.server; }

  /** Ensure a cached self-signed cert covering the current LAN addresses. */
  ensureCert() {
    const ips = lanAddresses();
    let cached = null;
    try { cached = JSON.parse(fs.readFileSync(this.certFile, 'utf8')); } catch { /* none yet */ }
    const covers = cached && Array.isArray(cached.ips) && ips.every((ip) => cached.ips.includes(ip));
    if (cached && covers && cached.cert && cached.key) return cached;
    const fresh = generateCert(ips);
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.writeFileSync(this.certFile, JSON.stringify(fresh));
    } catch (e) { this.log(`[remote] cert persist failed: ${e.message}`); }
    this.log(`[remote] generated self-signed cert (SAN: ${ips.join(', ') || 'loopback only'})`);
    return fresh;
  }

  /** Start listening on 0.0.0.0. Tries port..port+9 on EADDRINUSE. */
  async start(opts = {}) {
    if (this.server) return this.status();
    const want = Number(opts.port) > 0 ? Number(opts.port) : 0;
    const { cert, key } = this.ensureCert();
    for (let attempt = 0; attempt < 10; attempt++) {
      const port = want === 0 ? 0 : want + attempt;
      const ok = await this.tryListen(port, cert, key);
      if (ok) {
        this.port = this.server.address().port;
        this.log(`[remote] gateway listening on 0.0.0.0:${this.port}`);
        return this.status();
      }
      if (!this.server && want === 0) break; // OS-assigned port failing is fatal
    }
    this.log(`[remote] gateway failed to listen (base port ${want})`);
    return this.status();
  }

  tryListen(port, cert, key) {
    return new Promise((resolve) => {
      const server = https.createServer({ cert, key }, (req, res) => {
        try { this.onRequest(req, res); } catch (e) { this.log(`[remote] http handler error: ${e.message}`); try { res.destroy(); } catch { /* ignore */ } }
      });
      server.on('upgrade', (req, socket, head) => {
        try { this.onUpgrade(req, socket, head); } catch (e) { this.log(`[remote] upgrade handler error: ${e.message}`); try { socket.destroy(); } catch { /* ignore */ } }
      });
      server.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') { try { server.close(); } catch { /* ignore */ } resolve(false); return; }
        this.log(`[remote] server error: ${e.message}`);
        try { server.close(); } catch { /* ignore */ }
        if (this.server === server) this.server = null;
        resolve(false);
      });
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        resolve(true);
      });
    });
  }

  stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const sock of this.clientSockets) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.clientSockets.clear();
    try { server.close(); } catch { /* ignore */ }
    try { server.closeAllConnections(); } catch { /* older node: sockets die on destroy above */ }
    this.log('[remote] gateway stopped');
  }

  /**
   * Track the runtime URL (http://127.0.0.1:<port>); null while it is down.
   * A changed port means the old runtime is gone: drop piped clients so phone
   * browsers reconnect immediately instead of hanging on dead sockets.
   */
  setRuntimeUrl(url) {
    const before = this.runtimePort;
    this.runtimePort = null;
    if (url) {
      try { this.runtimePort = Number(new URL(url).port) || null; } catch { this.runtimePort = null; }
    }
    if (before !== null && before !== this.runtimePort) {
      for (const sock of this.clientSockets) {
        try { sock.destroy(); } catch { /* ignore */ }
      }
      this.clientSockets.clear();
      this.log(`[remote] runtime target changed ${before} -> ${this.runtimePort}`);
    }
  }

  // ------------------------------------------------------------------ auth

  authorized(req) {
    const raw = String(req.headers.cookie || '');
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([A-Za-z0-9]+)`));
    if (!m) return false;
    return safeEqualHex(m[1], this.tokens.value);
  }

  clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  pairingLocked(ip) {
    const rec = this.pairFails.get(ip);
    return !!(rec && rec.lockUntil > Date.now());
  }

  /** Mint a fresh one-shot pairing code (also callable when none is pending). */
  refreshPairingCode() {
    this.pairing = {
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      expiresAt: Date.now() + PAIR_TTL_MS,
      used: false,
    };
    return this.pairing;
  }

  validPairingCode() {
    if (!this.pairing || this.pairing.used || this.pairing.expiresAt < Date.now()) return null;
    return this.pairing;
  }

  // ------------------------------------------------------------- http side

  onRequest(req, res) {
    let pathname = '/';
    try { pathname = new URL(req.url, 'https://localhost').pathname; } catch { /* keep '/' */ }
    if (pathname === PAIR_PATH) {
      this.handlePair(req, res);
      return;
    }
    if (!this.authorized(req)) {
      this.reject(req, res);
      return;
    }
    this.proxyHttp(req, res);
  }

  handlePair(req, res) {
    const ip = this.clientIp(req);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }
    if (this.pairingLocked(ip)) {
      this.log(`[remote] pairing rejected: ip locked (${ip})`);
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('too many attempts; wait a few minutes');
      return;
    }
    let code = '';
    try { code = String(new URL(req.url, 'https://localhost').searchParams.get('c') || '').slice(0, 32); } catch { code = ''; }
    const pending = this.validPairingCode();
    if (pending && safeEqualHex(code, pending.code)) {
      pending.used = true;
      this.pairFails.delete(ip);
      this.log(`[remote] pairing succeeded (${ip})`);
      res.writeHead(302, {
        'set-cookie': `${COOKIE_NAME}=${this.tokens.value}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
        location: '/',
      });
      res.end();
      return;
    }
    const rec = this.pairFails.get(ip) || { fails: 0, lockUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= PAIR_MAX_FAILS) {
      rec.lockUntil = Date.now() + PAIR_LOCK_MS;
      rec.fails = 0;
      this.log(`[remote] pairing brute-force lock (${ip})`);
    }
    this.pairFails.set(ip, rec);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    res.end(pairingPage(true));
  }

  reject(req, res) {
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/html')) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
      res.end(pairingPage(this.validPairingCode() !== null));
      return;
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }

  proxyHttp(req, res) {
    if (!this.runtimePort) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('runtime not ready yet; retry shortly');
      return;
    }
    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${this.runtimePort}`;
    const cookieLeft = stripCookieValue(headers.cookie, COOKIE_NAME);
    if (cookieLeft) headers.cookie = cookieLeft;
    else delete headers.cookie;
    const up = http.request(
      // agent:false - fresh connection per request; the default agent's
      // keep-alive pool would pin sockets (and test processes) open.
      { host: '127.0.0.1', port: this.runtimePort, method: req.method, path: req.url, headers, agent: false },
      (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      },
    );
    up.on('error', (e) => {
      this.log(`[remote] proxy upstream error: ${e.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('runtime unreachable');
      } else {
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
    req.pipe(up);
  }

  // -------------------------------------------------------------- ws side

  onUpgrade(req, socket, head) {
    if (!this.authorized(req)) {
      socket.destroy();
      return;
    }
    if (!this.runtimePort) {
      socket.destroy();
      return;
    }
    this.clientSockets.add(socket);
    socket.on('close', () => {
      this.clientSockets.delete(socket);
      try { up.destroy(); } catch { /* ignore */ } // outbound socket is process-held
    });
    const target = this.runtimePort;
    const up = net.connect(target, '127.0.0.1', () => {
      // Replay the upgrade request verbatim (frames stay opaque to us), only
      // rewriting Host and dropping our auth cookie before it reaches runtime.
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === 'host') value = `127.0.0.1:${target}`;
        else if (lower === 'cookie') {
          const left = stripCookieValue(value, COOKIE_NAME);
          if (!left) continue; // no cookies left: drop the header entirely
          value = left;
        }
        lines.push(`${name}: ${value}`);
      }
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => { try { socket.destroy(); } catch { /* ignore */ } });
    up.on('close', () => { try { socket.destroy(); } catch { /* ignore */ } });
    socket.on('error', () => { try { up.destroy(); } catch { /* ignore */ } });
  }

  // ---------------------------------------------------------------- status

  /** Snapshot for the settings window; never includes the token itself. */
  status() {
    const pairing = this.validPairingCode();
    return {
      running: this.running,
      port: this.port,
      urls: (this.running ? lanAddresses() : []).map((ip) => `https://${ip}:${this.port}`),
      pairingCode: pairing ? pairing.code : null,
      pairingExpiresAt: pairing ? pairing.expiresAt : null,
      tokenConfigured: this.tokens.value.length === TOKEN_BYTES * 2,
      runtimeReady: this.runtimePort !== null,
    };
  }

  /** Invalidate every paired device: new token, drop live clients. */
  revokeToken() {
    this.tokens.value = this.tokens.regenerate();
    for (const sock of this.clientSockets) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.clientSockets.clear();
    this.log('[remote] token revoked; all paired devices must re-pair');
    return this.status();
  }

  /** QR PNG data URL for a pairing URL (lazy-loads the qrcode package). */
  async qrDataUrl(text) {
    const QRCode = require('qrcode');
    return QRCode.toDataURL(text, { margin: 1, width: 240 });
  }
}

/** Minimal pairing page (inline styles only; CSP forbids everything else). */
function pairingPage(canEnterCode) {
  const zh = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DshCockpit</title><style>body{font:14px/1.8 system-ui,sans-serif;background:#14171c;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{max-width:420px;padding:24px;border:1px solid #2d333b;border-radius:8px;background:#1c2128}input{font-size:20px;letter-spacing:.3em;padding:8px;width:100%;box-sizing:border-box;border:1px solid #2d333b;border-radius:6px;background:#14171c;color:#e6edf8}button{margin-top:12px;padding:8px 18px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:14px}p{color:#8b949e;font-size:12px}</style></head><body><div><b>需要配对</b>'
    + (canEnterCode ? '<p>请输入桌面端 DshCockpit 设置中显示的 6 位配对码。</p><form method="GET" action="/__dsh_pair"><input name="c" maxlength="6" inputmode="numeric" autofocus><button>配对</button></form>' : '<p>当前没有有效配对码。请在桌面端 DshCockpit 的 设置 → 手机远程控制 中点击「刷新配对码」，然后扫码或输入新配对码。</p>')
    + '</div></body></html>';
  return zh;
}

module.exports = { RemoteControl, lanAddresses, stripCookieValue, PAIR_PATH, COOKIE_NAME };

