// src/remote-control.js - phone remote-control gateway (shell-side secure proxy).
//
// The dsh runtime binds 127.0.0.1 only and its HTTP surface has NO auth, TLS,
// or origin policy (upstream is a single-user local service by design; see
// dsh-host-webserver README). This gateway is the ONE deliberate network
// exposure point:
//
//   phone browser --HTTPS(self-signed) or HTTP(compat)--> [gateway, 0.0.0.0:port]
//     auth:   one-shot pairing code (10 min TTL) -> long-lived token cookie
//             (HttpOnly + SameSite=Lax, +Secure over TLS; token stored encrypted
//             via Electron safeStorage, never in settings.json or backups)
//     HTTP:   proxied to  http://127.0.0.1:<runtime port>
//     WS:     upgrade is a raw TCP pipe to the runtime (frames stay opaque)
//
// Two transport modes, one port. Default HTTPS self-signed cert; the `compat`
// mode serves plain HTTP instead because WeChat/Douyin in-app browsers hard-block
// self-signed HTTPS with no user bypass, while system cameras (Safari/Chrome)
// allow a manual "continue" tap. Compat mode trades LAN-hop encryption for
// scanner reach; the pairing token then rides cleartext on the LAN.
//
// The runtime's /api trust fence refuses any request whose Origin header does
// not name the same authority as its Host. The phone browser legitimately
// attaches its own LAN origin (https://192.168.x.y:<gateway port>), so after
// the Host rewrite the two no longer match and every fetch POST and WS
// upgrade gets HTTP 403 (privileged methods like host.pickDirectory first,
// but session.list and the settings plane too). The gateway is the deliberate
// auth boundary — it only forwards token-authenticated requests — so it also
// rewrites Origin to the loopback runtime origin, making remote traffic
// byte-identical to what the desktop Electron window sends.
//
// The runtime keeps binding loopback: its unauthenticated surface never leaves
// this machine. Brute-force guard: 5 wrong pairing attempts lock an IP for
// 5 minutes. Logs never contain the token or pairing query strings.
//
// C7 public mode (setPublicMode, off by default): when the gateway is reached
// through a public path (Tailscale tailnet / cloudflared quick tunnel) the
// auth posture tightens — pairing TTL 5 min, cookie-less IP grant disabled
// (a proxied "IP" is the proxy itself and would admit everyone behind it),
// brute-force/session keys taken from trusted proxy headers only when the
// socket originates from loopback, and pairing/revoke events audited.
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
const PAIR_TTL_PUBLIC_MS = 5 * 60 * 1000; // public mode (C7): tightened from 10 min
const PAIR_MAX_FAILS = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const CERT_DAYS = 397; // stay under the 398-day ceiling some mobile browsers enforce
const TOKEN_BYTES = 32; // 64 hex chars
const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // paired-IP session fallback, sliding on activity
const MAX_GRANTS = 8; // distinct paired devices remembered at once

/**
 * LAN IPv4 candidates, best-first: real home/LAN ranges (192.168, 172.16-31)
 * before 10.x (often virtual overlays like ZeroTier/Tailscale), virtual CGNAT
 * (100.64-127, Tailscale) last. Deduped; the user still sees the full list in
 * settings, ordering only picks the default pairing-link target.
 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push(ni.address);
    }
  }
  const rank = (ip) => {
    const a = Number(ip.split('.')[0]);
    const b = Number(ip.split('.')[1]);
    if (ip.startsWith('192.168.')) return 0; // typical Wi-Fi/router LAN
    if (a === 172 && b >= 16 && b <= 31) return 1; // private LAN
    if (a === 10) return 2; // private, but also ZeroTier's favorite range
    if (a === 100 && b >= 64 && b <= 127) return 3; // CGNAT (Tailscale)
    return 1.5; // anything else (public/odd ranges) before overlays
  };
  return [...new Set(out)].sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
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

/** Loopback check for the socket-level source (local proxy scenario). */
function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Loose IP shape check for proxy-forwarded header values (XFF first hop /
 * CF-Connecting-IP). These values become map keys and log fields, so the
 * charset is pinned to IP characters only — anything else is treated as
 * "no usable header" and the socket address is used instead.
 */
function looksLikeIp(v) {
  return /^[0-9a-fA-F.:]+$/.test(v) && (v.includes('.') || v.includes(':'));
}

/**
 * Inline polyfill for `crypto.randomUUID`, which browsers expose only in
 * secure contexts (https or localhost). The dsh web client mints every RPC
 * id with it, so on the compat-mode plain-HTTP origin the whole client dies
 * with "crypto.randomUUID is not a function". `crypto.getRandomValues` is
 * NOT secure-context-gated, so a version-4 UUID built from it restores the
 * client without weakening the pairing auth (the id is correlation-only).
 * Runs first: an inline classic script placed right after <head> executes
 * before the page's deferred/module scripts.
 */
// NOTE: keep this string syntactically self-contained - the unit test
// EXECUTES it in a vm with a stubbed crypto, so a syntax slip (like the
// stray `()` that shipped in the first version and made the whole script
// a silent no-op) fails the build instead of the phone.
const RANDOM_UUID_POLYFILL = '<script>if(window.crypto&&typeof window.crypto.randomUUID!=="function"){window.crypto.randomUUID=function(){var r=window.crypto.getRandomValues(new Uint8Array(16));r[6]=(r[6]&15)|64;r[8]=(r[8]&63)|128;function h(n){return(n<16?"0":"")+n.toString(16)}return h(r[0])+h(r[1])+h(r[2])+h(r[3])+"-"+h(r[4])+h(r[5])+"-"+h(r[6])+h(r[7])+"-"+h(r[8])+h(r[9])+"-"+h(r[10])+h(r[11])+h(r[12])+h(r[13])+h(r[14])+h(r[15])}};</script>';

/** Insert a script immediately after the opening <head> tag (or before <body>/at the start as fallbacks). */
function injectAfterHead(html, script) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length);
  const body = /<body[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index) + script + html.slice(body.index);
  return script + html;
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
    // legacy file written before the 0600 rule: tighten on the read path
    // (best effort — a chmod failure must not block the gateway)
    try { fs.chmodSync(this.file, 0o600); } catch { /* win: no-op */ }
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
      // 0600 like .credentials.yaml: without safeStorage this file is the
      // only copy of the long-lived pairing token (plaintext fallback).
      fs.writeFileSync(tmp, payload, { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch { /* win: no-op */ }
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
    this.secure = true; // true = self-signed HTTPS, false = plain HTTP (scanner compat mode)
    this.runtimePort = null;
    this.publicMode = false; // C7: public-network posture (TTL/proxy-IP keys/no IP grant)
    this.pairing = null; // { code, expiresAt, used }
    this.pairFails = new Map(); // ip -> { fails, lockUntil }
    this.pairSucceededAt = null; // { ip, at } of the last success, for the stranded-pair diagnostic
    this.grants = new Map(); // ip -> expiresAt (cookie-less paired-device sessions)
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

  /**
   * Start listening on 0.0.0.0. Tries port..port+9 on EADDRINUSE.
   * `compat` serves plain HTTP: WeChat/Douyin in-app browsers white-screen
   * self-signed HTTPS (no user bypass), so the compat mode is the only way
   * those scanners can reach the app. Cleartext LAN hop in exchange.
   */
  async start(opts = {}) {
    if (this.server) return this.status();
    const want = Number(opts.port) > 0 ? Number(opts.port) : 0;
    const compat = !!opts.compat;
    let tls = null;
    if (!compat) tls = this.ensureCert();
    for (let attempt = 0; attempt < 10; attempt++) {
      const port = want === 0 ? 0 : want + attempt;
      const ok = await this.tryListen(port, compat, tls);
      if (ok) {
        this.port = this.server.address().port;
        this.secure = !compat;
        this.log(`[remote] gateway listening on 0.0.0.0:${this.port} (${compat ? 'http compat' : 'https'})`);
        return this.status();
      }
      if (!this.server && want === 0) break; // OS-assigned port failing is fatal
    }
    this.log(`[remote] gateway failed to listen (base port ${want})`);
    return this.status();
  }

  tryListen(port, compat, tls) {
    return new Promise((resolve) => {
      const server = compat
        ? http.createServer((req, res) => {
            try { this.onRequest(req, res); } catch (e) { this.log(`[remote] http handler error: ${e.message}`); try { res.destroy(); } catch { /* ignore */ } }
          })
        : https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
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

  /**
   * C7 public-network posture switch. Tightens the pairing TTL to 5 minutes,
   * disables the cookie-less IP session fallback, switches brute-force /
   * session keys to trusted proxy headers (see clientIp), and turns on audit
   * logging. Any pending pairing code is voided so a long-TTL LAN code can
   * never survive into public exposure.
   */
  setPublicMode(on) {
    const next = !!on;
    if (next === this.publicMode) return this.status();
    this.publicMode = next;
    this.pairing = null;
    // Log directly (not via audit()): by the time audit() runs, publicMode is
    // already false on disable and would swallow the "disabled" line.
    this.log(`[remote-audit] public-mode ${next ? 'enabled' : 'disabled'}`);
    return this.status();
  }

  /** Audit line, public mode only. Never contains the token or a pairing code. */
  audit(event, detail) {
    if (!this.publicMode) return;
    this.log(`[remote-audit] ${event}${detail ? ` ${detail}` : ''}`);
  }

  authorized(req) {
    const raw = String(req.headers.cookie || '');
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([A-Za-z0-9]+)`));
    if (m && safeEqualHex(m[1], this.tokens.value)) return true;
    // Public mode: no cookie-less IP fallback. Behind a tunnel every proxied
    // client shares the proxy's loopback key — granting it once would admit
    // everyone behind the proxy (RESEARCH §7.1-2). Token cookie only.
    if (this.publicMode) return false;
    // Cookie-less fallback: some in-app browsers (WeChat XWeb/X5) refuse to
    // store cookies for raw-IP hosts, so the token cookie never comes back.
    // Pairing therefore also grants the device's IP a sliding in-memory
    // session; LAN-grade trust (per-device source IP behind the home router),
    // cleared on revoke and app restart — see DESIGN.md §17.
    const ip = this.clientIp(req);
    const expiresAt = this.grants.get(ip);
    if (expiresAt === undefined) return false;
    if (expiresAt < Date.now()) {
      this.grants.delete(ip);
      return false;
    }
    this.grants.set(ip, Date.now() + GRANT_TTL_MS); // slide on activity
    return true;
  }

  /**
   * The client identity used for brute-force locks and IP sessions. In
   * public mode behind a local proxy (cloudflared quick tunnel / tailscale
   * serve), every proxied client shares the proxy's loopback remoteAddress —
   * so the real client IP is taken from CF-Connecting-IP / the first
   * X-Forwarded-For hop. Those headers are trusted ONLY when the socket
   * really originates from loopback (the proxy runs on this machine): a LAN
   * or tailnet client spoofing XFF over a direct connection must not forge
   * or dodge the brute-force lock. Direct tailnet connections (no proxy)
   * carry no such headers and keep using their own source address.
   */
  clientIp(req) {
    const remote = (req.socket && req.socket.remoteAddress) || 'unknown';
    if (this.publicMode && isLoopbackAddr(remote)) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && looksLikeIp(cf)) return cf.trim();
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string') {
        const first = xff.split(',')[0].trim();
        if (looksLikeIp(first)) return first;
      }
    }
    return remote;
  }

  pairingLocked(ip) {
    const rec = this.pairFails.get(ip);
    return !!(rec && rec.lockUntil > Date.now());
  }

  /** Mint a fresh one-shot pairing code (also callable when none is pending). */
  refreshPairingCode() {
    this.pairing = {
      code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'),
      // Public mode tightens the one-shot window from 10 to 5 minutes (C7).
      expiresAt: Date.now() + (this.publicMode ? PAIR_TTL_PUBLIC_MS : PAIR_TTL_MS),
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
      this.pairSucceededAt = { ip, at: Date.now() };
      this.log(`[remote] pairing succeeded (${ip})`);
      this.audit('pair-success', `ip=${ip}`);
      // Trust this device's IP as a session carrier: cookie-less browsers
      // (WeChat XWeb) never return the token cookie, so the grant below is
      // what keeps the phone inside the app after the landing page navigates.
      // NOT in public mode: behind a tunnel the "device IP" would be the
      // proxy's loopback address shared by every proxied client.
      if (!this.publicMode) {
        if (!this.grants.has(ip) && this.grants.size >= MAX_GRANTS) {
          this.grants.delete(this.grants.keys().next().value); // drop the oldest
        }
        this.grants.set(ip, Date.now() + GRANT_TTL_MS);
      }
      // Secure only over TLS: in compat (plain HTTP) mode a Secure cookie would
      // never be stored, breaking the just-paired session. A compat-paired
      // (non-Secure) cookie is still sent over https, so switching the mode
      // back does not force re-pairing.
      const flags = `Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`;
      // Answer with a landing page instead of a bare 302: some in-app mobile
      // browsers (WeChat XWeb/X5) are unreliable at storing cookies set on
      // redirect responses, which strands the phone on the pairing gate with
      // an already-consumed code. A document response stores the cookie first,
      // then a meta-refresh navigates to the app.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `${COOKIE_NAME}=${this.tokens.value}; ${flags}`,
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
      res.end(pairSuccessPage());
      return;
    }
    const rec = this.pairFails.get(ip) || { fails: 0, lockUntil: 0 };
    rec.fails += 1;
    if (rec.fails >= PAIR_MAX_FAILS) {
      rec.lockUntil = Date.now() + PAIR_LOCK_MS;
      rec.fails = 0;
      this.log(`[remote] pairing brute-force lock (${ip})`);
      this.audit('pair-lock', `ip=${ip}`);
    } else {
      this.audit('pair-fail', `ip=${ip} fails=${rec.fails}`);
    }
    this.pairFails.set(ip, rec);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
    res.end(pairingPage(true));
  }

  reject(req, res) {
    // Diagnostic: a device that paired seconds ago but reaches the pairing
    // gate again almost certainly dropped the cookie (in-app browser quirk);
    // log it once per incident so support can tell re-pairing from breakage.
    if (this.pairSucceededAt && this.pairSucceededAt.ip === this.clientIp(req)
      && Date.now() - this.pairSucceededAt.at < 60_000) {
      this.log(`[remote] paired device hit the pairing gate again within 60s (${this.clientIp(req)}); cookie likely dropped`);
      this.pairSucceededAt = null;
    }
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
    // Rewrite the browser's LAN origin to the runtime's loopback origin; the
    // runtime /api fence requires Origin (when attached) to match Host, and
    // the pairing-token check above is the trust boundary here.
    if (headers.origin) headers.origin = `http://127.0.0.1:${this.runtimePort}`;
    const cookieLeft = stripCookieValue(headers.cookie, COOKIE_NAME);
    if (cookieLeft) headers.cookie = cookieLeft;
    else delete headers.cookie;
    const up = http.request(
      // agent:false - fresh connection per request; the default agent's
      // keep-alive pool would pin sockets (and test processes) open.
      { host: '127.0.0.1', port: this.runtimePort, method: req.method, path: req.url, headers, agent: false },
      (ur) => {
        if (this.shouldInjectRandomUuidPolyfill(req, ur)) {
          this.injectRandomUuidPolyfill(ur, res);
          return;
        }
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

  /**
   * Whether one proxied response is an HTML document we can splice the
   * randomUUID polyfill into. The web client mints every RPC id with
   * `crypto.randomUUID()`, which browsers expose ONLY in secure contexts —
   * on plain HTTP (compat mode) the call throws and every API request dies
   * (no history, no workspace picking). getRandomValues is not gated, so a
   * tiny polyfill restores the client on insecure origins.
   */
  shouldInjectRandomUuidPolyfill(req, ur) {
    // GET only: HEAD carries no body, and answering one with the spliced
    // document would violate the protocol (WeChat prefetchers send HEADs).
    if (req.method !== 'GET' || ur.statusCode !== 200) return false;
    const ct = String(ur.headers['content-type'] || '');
    if (!ct.includes('text/html')) return false;
    const enc = String(ur.headers['content-encoding'] || '');
    return enc === '' || enc === 'identity'; // compressed bodies cannot be spliced
  }

  /** Buffer an HTML document, inject the polyfill after <head>, rewrite Content-Length. */
  injectRandomUuidPolyfill(ur, res) {
    const chunks = [];
    ur.on('data', (c) => chunks.push(c));
    ur.on('end', () => {
      const html = injectAfterHead(Buffer.concat(chunks).toString('utf8'), RANDOM_UUID_POLYFILL);
      const headers = { ...ur.headers };
      // The upstream streams chunked; a buffered body must switch to a
      // Content-Length frame. Keeping transfer-encoding alongside the new
      // content-length is a protocol error browsers reject outright.
      delete headers['transfer-encoding'];
      headers['content-length'] = String(Buffer.byteLength(html));
      // The runtime sends no cache policy on the document; in-app browsers
      // (WeChat XWeb) may keep serving a pre-polyfill copy otherwise. The
      // document is tiny - force revalidation.
      headers['cache-control'] = 'no-cache';
      res.writeHead(ur.statusCode, headers);
      res.end(html);
    });
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
      // Replay the upgrade request verbatim (frames stay opaque to us),
      // rewriting Host and Origin to the loopback runtime authority and
      // dropping our auth cookie before it reaches runtime. The Origin
      // rewrite matters: the runtime's upgrade fence applies the same
      // Host/Origin same-origin rule as /api, and the phone's Origin names
      // this gateway's LAN address.
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        let value = req.rawHeaders[i + 1];
        const lower = name.toLowerCase();
        if (lower === 'host') value = `127.0.0.1:${target}`;
        else if (lower === 'origin') value = `http://127.0.0.1:${target}`;
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
    const scheme = this.secure ? 'https' : 'http';
    return {
      running: this.running,
      port: this.port,
      secure: this.secure,
      publicMode: this.publicMode,
      urls: (this.running ? lanAddresses() : []).map((ip) => `${scheme}://${ip}:${this.port}`),
      pairingCode: pairing ? pairing.code : null,
      pairingExpiresAt: pairing ? pairing.expiresAt : null,
      tokenConfigured: this.tokens.value.length === TOKEN_BYTES * 2,
      runtimeReady: this.runtimePort !== null,
    };
  }

  /** Invalidate every paired device: new token, drop live clients and IP grants. */
  revokeToken() {
    this.tokens.value = this.tokens.regenerate();
    this.grants.clear();
    for (const sock of this.clientSockets) {
      try { sock.destroy(); } catch { /* ignore */ }
    }
    this.clientSockets.clear();
    this.audit('token-revoke');
    this.log('[remote] token revoked; all paired devices must re-pair');
    return this.status();
  }
}

/** Minimal pairing page (inline styles only; CSP forbids everything else). */
function pairingPage(canEnterCode) {
  const zh = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DshCockpit</title><style>body{font:14px/1.8 system-ui,sans-serif;background:#14171c;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{max-width:420px;padding:24px;border:1px solid #2d333b;border-radius:8px;background:#1c2128}input{font-size:20px;letter-spacing:.3em;padding:8px;width:100%;box-sizing:border-box;border:1px solid #2d333b;border-radius:6px;background:#14171c;color:#e6edf8}button{margin-top:12px;padding:8px 18px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-size:14px}p{color:#8b949e;font-size:12px}a{color:#58a6ff}</style></head><body><div><b>需要配对</b>'
    + (canEnterCode ? '<p>请输入桌面端 DshCockpit 设置中显示的 6 位配对码。</p><form method="GET" action="/__dsh_pair"><input name="c" maxlength="6" inputmode="numeric" autofocus><button>配对</button></form>' : '<p>当前没有有效配对码（可能已使用或已过期）。请在桌面端 DshCockpit 的 设置 → 手机远程控制 中点击「刷新配对码」，然后重新打开新的配对链接。</p>')
    + '</div></body></html>';
  return zh;
}

/**
 * Pairing-success landing page: the cookie rides a document response (stored
 * reliably even in in-app browsers that drop cookies set on 302s), then a
 * meta-refresh walks into the app. No JS, so the CSP needs no script-src.
 */
function pairSuccessPage() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/"><title>DshCockpit</title><style>body{font:14px/1.8 system-ui,sans-serif;background:#14171c;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{max-width:420px;padding:24px;border:1px solid #2d333b;border-radius:8px;background:#1c2128}a{color:#58a6ff}p{color:#8b949e;font-size:12px}</style></head><body><div><b>配对成功</b><p>正在进入 DshCockpit…（若未自动跳转，<a href="/">点此继续</a>）</p></div></body></html>';
}

module.exports = { RemoteControl, lanAddresses, stripCookieValue, PAIR_PATH, COOKIE_NAME };

