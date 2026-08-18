// test/public-remote.test.js — C7 public remote: Tailscale three-signal
// detection, CLI candidate sweep, cloudflared quick tunnel lifecycle, pairing
// links, and the remote-control public-mode hardening (real client IP, TTL,
// cookie-less fallback disabled, audit trail).
//
// Everything external is mocked (execFile / spawn / local API / net
// interfaces); the audit-trail test drives a real compat-mode gateway over
// plain HTTP with X-Forwarded-For headers, the way a local cloudflared proxy
// would forward.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  createPublicRemote,
  buildPairUrl,
  tailscaleIface,
  stripTrailingDot,
  pickTailscaleV4,
  TS_CLI_CANDIDATES,
} = require('../src/public-remote');
const { RemoteControl, PAIR_PATH } = require('../src/remote-control');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-public-remote-test-'));
}

const enoent = () => Object.assign(new Error('spawn enoent'), { code: 'ENOENT' });
const TS_LOGGED_IN = JSON.stringify({
  Self: {
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    DNSName: 'macbook.tail4abc12.ts.net.',
  },
});
const LAN_IFACE = () => ({ en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }] });

/** A fake child process good enough for the tunnel manager (streams + kill). */
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.pid = 424242;
  let killed = false;
  c.kill = () => { killed = true; return true; };
  c.wasKilled = () => killed;
  return c;
}

// --------------------------------------------------------------- detection

test('detectTailscale: nothing found → notInstalled', async () => {
  const api = createPublicRemote({
    platform: 'darwin',
    execFile: async () => ({ error: enoent(), stdout: '', stderr: '' }),
    httpGetJson: async () => ({ ok: false, reason: 'error' }),
    netInterfaces: LAN_IFACE,
    fsExists: () => false,
  });
  const st = await api.detectTailscale(true);
  assert.strictEqual(st.state, 'notInstalled');
  assert.strictEqual(st.installed, false);
  assert.strictEqual(st.running, false);
  assert.strictEqual(st.loggedIn, false);
  assert.strictEqual(st.ipv4, null);
});

test('detectTailscale: CLI logged in → loggedIn with IP and MagicDNS (trailing dot stripped)', async () => {
  const api = createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args) => (args[0] === 'status'
      ? { error: null, stdout: TS_LOGGED_IN, stderr: '' }
      : { error: enoent(), stdout: '', stderr: '' }),
    httpGetJson: async () => ({ ok: false, reason: 'error' }),
    netInterfaces: LAN_IFACE,
    fsExists: (p) => p === '/opt/homebrew/bin/tailscale',
  });
  const st = await api.detectTailscale(true);
  assert.strictEqual(st.state, 'loggedIn');
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.running, true);
  assert.strictEqual(st.ipv4, '100.101.102.103');
  assert.strictEqual(st.dnsName, 'macbook.tail4abc12.ts.net');
  assert.strictEqual(st.cliPath, '/opt/homebrew/bin/tailscale');
});

test('detectTailscale: local API only (no CLI) → loggedIn via Self node', async () => {
  const urls = [];
  const api = createPublicRemote({
    platform: 'darwin',
    execFile: async () => ({ error: enoent(), stdout: '', stderr: '' }),
    httpGetJson: async (url) => {
      urls.push(url);
      return { ok: true, json: { Self: { TailscaleIPs: ['100.1.2.3'], DNSName: 'host.ts.net.' } } };
    },
    netInterfaces: LAN_IFACE,
    fsExists: () => false,
  });
  const st = await api.detectTailscale(true);
  assert.deepStrictEqual(urls, ['http://100.100.100.100/api/data']);
  assert.strictEqual(st.state, 'loggedIn');
  assert.strictEqual(st.ipv4, '100.1.2.3');
  assert.strictEqual(st.dnsName, 'host.ts.net');
  assert.strictEqual(st.cliPath, null);
});

test('detectTailscale: binary answers but no session → notLoggedIn (both CLI shapes)', async () => {
  // shape A: `status --json` succeeds but has no Self/TailscaleIPs (NeedsLogin)
  const a = createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args) => (args[0] === 'status'
      ? { error: null, stdout: '{"BackendState":"NeedsLogin"}', stderr: '' }
      : { error: enoent(), stdout: '', stderr: '' }),
    httpGetJson: async () => ({ ok: false, reason: 'error' }),
    netInterfaces: LAN_IFACE,
    fsExists: () => true,
  });
  const sa = await a.detectTailscale(true);
  assert.strictEqual(sa.state, 'notLoggedIn');
  assert.strictEqual(sa.installed, true);
  assert.strictEqual(sa.ipv4, null);
  // shape B: CLI exists but the daemon errors (non-ENOENT spawn failure)
  const b = createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args) => (args[0] === 'status'
      ? { error: Object.assign(new Error('failed to connect'), { code: 'ECONNREFUSED' }), stdout: '', stderr: 'x' }
      : { error: enoent(), stdout: '', stderr: '' }),
    httpGetJson: async () => ({ ok: false, reason: 'error' }),
    netInterfaces: LAN_IFACE,
    fsExists: () => true,
  });
  const sb = await b.detectTailscale(true);
  assert.strictEqual(sb.state, 'notLoggedIn');
  assert.strictEqual(sb.installed, true);
});

test('CLI candidate sweep: macOS three variants + PATH, App CLI runs with TAILSCALE_BE_CLI=1', async () => {
  assert.deepStrictEqual(
    TS_CLI_CANDIDATES.darwin.map((c) => c.file),
    ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'],
  );
  assert.deepStrictEqual(TS_CLI_CANDIDATES.darwin[2].env, { TAILSCALE_BE_CLI: '1' });
  assert.ok(TS_CLI_CANDIDATES.win32.some((c) => c.file === 'C:\\Program Files\\Tailscale\\tailscale.exe'));

  // fsExists prunes absent absolute paths; only the .app CLI (present) is
  // spawned, and it must receive the headless env.
  const seen = [];
  const api = createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args, opts) => {
      seen.push({ file, env: opts && opts.env });
      return { error: enoent(), stdout: '', stderr: '' };
    },
    httpGetJson: async () => ({ ok: false, reason: 'error' }),
    netInterfaces: LAN_IFACE,
    fsExists: (p) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  });
  await api.detectTailscale(true);
  assert.strictEqual(seen.length, 2); // .app CLI first, then the bare PATH name
  assert.strictEqual(seen[0].file, '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.strictEqual(seen[0].env.TAILSCALE_BE_CLI, '1');
  assert.ok(seen[1].env.TAILSCALE_BE_CLI === undefined); // PATH probe stays plain
});

test('detectTailscale: results cached 60s, force re-probes', async () => {
  let probes = 0;
  const mk = () => createPublicRemote({
    platform: 'darwin',
    execFile: async () => { probes += 1; return { error: enoent(), stdout: '', stderr: '' }; },
    httpGetJson: async () => { probes += 1; return { ok: false, reason: 'error' }; },
    netInterfaces: LAN_IFACE,
    fsExists: () => false,
  });
  const api = mk();
  await api.detectTailscale(true); // cold probe (4 CLI candidates + 1 API)
  const afterCold = probes;
  await api.detectTailscale(false); // cache hit
  await api.detectTailscale(false);
  assert.strictEqual(probes, afterCold);
  await api.detectTailscale(true); // forced re-probe
  assert.strictEqual(probes, afterCold * 2);
});

// --------------------------------------------------------------- cloudflared

test('detectCloudflared: installed (version parsed) and not installed', async () => {
  const yes = createPublicRemote({
    platform: 'darwin',
    // PATH probe misses; the homebrew absolute-path candidate answers.
    execFile: async (file, args) => (args[0] === '--version' && file === '/opt/homebrew/bin/cloudflared'
      ? { error: null, stdout: 'cloudflared version 2025.1.0 (built 2026-01-01-0000 UTC)\n', stderr: '' }
      : { error: enoent(), stdout: '', stderr: '' }),
    fsExists: (p) => p === '/opt/homebrew/bin/cloudflared',
  });
  const cf = await yes.detectCloudflared(true);
  assert.strictEqual(cf.installed, true);
  assert.strictEqual(cf.bin, '/opt/homebrew/bin/cloudflared');
  assert.strictEqual(cf.version, '2025.1.0');

  // PATH-first: a bare-name hit wins before any absolute path is tried.
  const onPath = createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args) => (args[0] === '--version'
      ? { error: null, stdout: 'cloudflared version 2025.1.0', stderr: '' }
      : { error: enoent(), stdout: '', stderr: '' }),
    fsExists: () => false,
  });
  assert.strictEqual((await onPath.detectCloudflared(true)).bin, 'cloudflared');

  const no = createPublicRemote({
    platform: 'darwin',
    execFile: async () => ({ error: enoent(), stdout: '', stderr: '' }),
    fsExists: () => false,
  });
  assert.strictEqual((await no.detectCloudflared(true)).installed, false);
});

function cloudflaredReady(spawnImpl, extra = {}) {
  return createPublicRemote({
    platform: 'darwin',
    execFile: async (file, args) => (args[0] === '--version'
      ? { error: null, stdout: 'cloudflared version 2025.1.0', stderr: '' }
      : { error: enoent(), stdout: '', stderr: '' }),
    fsExists: () => true,
    spawn: spawnImpl,
    ...extra,
  });
}

test('quick tunnel: parses the trycloudflare URL, reuses a running tunnel, stop kills the child', async () => {
  const spawns = [];
  let child;
  const api = cloudflaredReady((file, args, opts) => {
    spawns.push({ file, args, opts });
    child = fakeChild();
    setTimeout(() => child.stderr.emit('data', Buffer.from(
      '2026 INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):\n'
        + '2026 INF |  https://random-words-here.trycloudflare.com                                             |\n',
    )), 5);
    return child;
  });
  const r = await api.startTunnel(31780);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://random-words-here.trycloudflare.com');
  assert.strictEqual(spawns.length, 1);
  assert.deepStrictEqual(spawns[0].args, ['tunnel', '--url', 'http://127.0.0.1:31780']);
  assert.strictEqual(spawns[0].opts.windowsHide, true);
  assert.deepStrictEqual(api.tunnelStatus(), { running: true, url: 'https://random-words-here.trycloudflare.com' });
  // second start reuses the live child instead of spawning another
  const again = await api.startTunnel(31780);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyRunning, true);
  assert.strictEqual(spawns.length, 1);
  api.stopTunnel();
  assert.ok(child.wasKilled());
  assert.deepStrictEqual(api.tunnelStatus(), { running: false, url: null });
});

test('quick tunnel: no URL in time → url-timeout and the child is killed', async () => {
  const api = cloudflaredReady(() => fakeChild(), { tunnelUrlTimeoutMs: 40 });
  const r = await api.startTunnel(31780);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'url-timeout');
  assert.deepStrictEqual(api.tunnelStatus(), { running: false, url: null });
});

test('quick tunnel: child exits before a URL → exited; cloudflared missing → not-installed', async () => {
  const gone = cloudflaredReady(() => {
    const c = fakeChild();
    setTimeout(() => c.emit('exit', 1), 5);
    return c;
  });
  const r1 = await gone.startTunnel(31780);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'exited');

  const missing = createPublicRemote({
    platform: 'darwin',
    execFile: async () => ({ error: enoent(), stdout: '', stderr: '' }),
    fsExists: () => false,
    spawn: () => { throw new Error('must not spawn'); },
  });
  const r2 = await missing.startTunnel(31780);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'not-installed');
});

test('stopTunnel on win32: tree-kills via taskkill /T /F', async () => {
  const kills = [];
  const api = createPublicRemote({
    platform: 'win32',
    execFile: async (file, args) => {
      if (file === 'taskkill') { kills.push(args); return { error: null, stdout: '', stderr: '' }; }
      return args[0] === '--version'
        ? { error: null, stdout: 'cloudflared version 2025.1.0', stderr: '' }
        : { error: enoent(), stdout: '', stderr: '' };
    },
    fsExists: () => true,
    spawn: () => {
      const c = fakeChild();
      setTimeout(() => c.stderr.emit('data', Buffer.from('https://win-tunnel.trycloudflare.com')), 5);
      return c;
    },
  });
  const r = await api.startTunnel(31780);
  assert.strictEqual(r.ok, true);
  api.stopTunnel();
  assert.strictEqual(kills.length, 1);
  assert.deepStrictEqual(kills[0], ['/pid', '424242', '/T', '/F']);
});

// ------------------------------------------------------------ pairing links

test('buildPairUrl: IP and MagicDNS forms, scheme, encoding, null guards', () => {
  assert.strictEqual(buildPairUrl('100.101.102.103', 31780, false, '123456'), `http://100.101.102.103:31780${PAIR_PATH}?c=123456`);
  assert.strictEqual(buildPairUrl('macbook.tail4abc12.ts.net', 31780, true, '654321'), `https://macbook.tail4abc12.ts.net:31780${PAIR_PATH}?c=654321`);
  assert.strictEqual(buildPairUrl('100.1.2.3', 31780, false, 'a b'), `http://100.1.2.3:31780${PAIR_PATH}?c=a%20b`);
  assert.strictEqual(buildPairUrl(null, 31780, false, '123'), null);
  assert.strictEqual(buildPairUrl('1.2.3.4', 0, false, '123'), null);
  assert.strictEqual(buildPairUrl('1.2.3.4', 31780, false, ''), null);
});

test('iface + helpers: CGNAT corroboration, MagicDNS dot strip, v4 pick', () => {
  assert.strictEqual(tailscaleIface({ utun4: [{ family: 'IPv4', address: '100.101.102.103', internal: false }] }), '100.101.102.103');
  assert.strictEqual(tailscaleIface({ en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }] }), null);
  assert.strictEqual(tailscaleIface({ lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
  assert.strictEqual(stripTrailingDot('host.ts.net.'), 'host.ts.net');
  assert.strictEqual(stripTrailingDot('host.ts.net'), 'host.ts.net');
  assert.strictEqual(stripTrailingDot(''), null);
  assert.strictEqual(pickTailscaleV4(['fd7a:115c:a1e0::1', '100.1.2.3']), '100.1.2.3');
  assert.strictEqual(pickTailscaleV4([]), null);
});

// ------------------------------------------- remote-control public-mode core

function mkRc(logs) {
  return new RemoteControl({ userDataDir: tmpDir(), safeStorage: null, log: (l) => logs.push(l) });
}

function fakeReq(headers, remoteAddress) {
  return { headers, socket: { remoteAddress } };
}

test('clientIp: public mode trusts CF-Connecting-IP / XFF only from loopback sockets', () => {
  const rc = mkRc([]);
  // LAN mode: proxy headers are NEVER honored, even from loopback
  assert.strictEqual(rc.clientIp(fakeReq({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1')), '127.0.0.1');
  rc.setPublicMode(true);
  // CF-Connecting-IP wins over XFF
  assert.strictEqual(rc.clientIp(fakeReq({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' }, '::ffff:127.0.0.1')), '203.0.113.9');
  // first XFF hop
  assert.strictEqual(rc.clientIp(fakeReq({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, '127.0.0.1')), '198.51.100.7');
  // garbage header values fall back to the socket address
  assert.strictEqual(rc.clientIp(fakeReq({ 'x-forwarded-for': 'garbage' }, '127.0.0.1')), '127.0.0.1');
  assert.strictEqual(rc.clientIp(fakeReq({ 'cf-connecting-ip': 'nope' }, '127.0.0.1')), '127.0.0.1');
  // non-loopback socket (direct tailnet client): headers are not trusted
  assert.strictEqual(rc.clientIp(fakeReq({ 'x-forwarded-for': '1.2.3.4' }, '100.64.0.5')), '100.64.0.5');
  // no headers at all
  assert.strictEqual(rc.clientIp(fakeReq({}, '127.0.0.1')), '127.0.0.1');
});

test('public-mode switch: default OFF, audited toggle, LAN pairing code voided, TTL 10→5 min', () => {
  const logs = [];
  const rc = mkRc(logs);
  assert.strictEqual(rc.publicMode, false); // hard default
  const lan = rc.refreshPairingCode();
  const lanTtl = lan.expiresAt - Date.now();
  assert.ok(lanTtl <= 10 * 60 * 1000 && lanTtl > 9 * 60 * 1000, `LAN TTL ~10min, got ${lanTtl}ms`);
  rc.setPublicMode(true);
  assert.strictEqual(rc.publicMode, true);
  assert.strictEqual(rc.pairing, null); // a long-TTL LAN code must not survive into public exposure
  assert.ok(logs.includes('[remote-audit] public-mode enabled'));
  const pub = rc.refreshPairingCode();
  const pubTtl = pub.expiresAt - Date.now();
  assert.ok(pubTtl <= 5 * 60 * 1000 && pubTtl > 4 * 60 * 1000, `public TTL ~5min, got ${pubTtl}ms`);
  // idempotent toggles do not spam audit lines
  rc.setPublicMode(true);
  assert.strictEqual(logs.filter((l) => l.includes('public-mode enabled')).length, 1);
  rc.setPublicMode(false);
  assert.ok(logs.includes('[remote-audit] public-mode disabled'));
});

test('authorized: public mode drops the cookie-less IP grant, token cookie still works', () => {
  const logs = [];
  const rc = mkRc(logs);
  const req = { headers: { cookie: '' }, socket: { remoteAddress: '192.168.1.9' } };
  rc.grants.set('192.168.1.9', Date.now() + 60_000);
  assert.strictEqual(rc.authorized(req), true); // LAN mode: the grant carries the session
  rc.setPublicMode(true);
  assert.strictEqual(rc.authorized(req), false); // public mode: token cookie only
  const okReq = { headers: { cookie: `dsh_remote=${rc.tokens.value}` }, socket: { remoteAddress: '192.168.1.9' } };
  assert.strictEqual(rc.authorized(okReq), true);
});

// ------------------------------------------------- gateway-level audit trail

function httpGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET', agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

test('gateway audit trail: pair fail/lock/success + revoke, real client IP, no secrets in logs', async () => {
  const logs = [];
  const rc = new RemoteControl({ userDataDir: tmpDir(), safeStorage: null, log: (l) => logs.push(l) });
  const st = await rc.start({ port: 0, compat: true }); // plain HTTP gateway
  assert.strictEqual(st.running, true);
  try {
    rc.setPublicMode(true);
    const code = rc.refreshPairingCode().code;
    // 5 wrong codes from one proxied client → each fail audited with the REAL
    // IP from XFF, the 5th trips the lock, the 6th gets HTTP 429
    for (let i = 0; i < 5; i++) {
      const r = await httpGet(st.port, `${PAIR_PATH}?c=000000`, { 'x-forwarded-for': '203.0.113.5' });
      assert.strictEqual(r.status, 401);
    }
    assert.ok(logs.includes('[remote-audit] pair-fail ip=203.0.113.5 fails=1'));
    assert.ok(logs.includes('[remote-audit] pair-lock ip=203.0.113.5'));
    const locked = await httpGet(st.port, `${PAIR_PATH}?c=000000`, { 'x-forwarded-for': '203.0.113.5' });
    assert.strictEqual(locked.status, 429);
    // a different client is unaffected and pairs with the right code
    const ok = await httpGet(st.port, `${PAIR_PATH}?c=${code}`, { 'cf-connecting-ip': '198.51.100.7' });
    assert.strictEqual(ok.status, 200);
    assert.ok(logs.includes('[remote-audit] pair-success ip=198.51.100.7'));
    assert.ok(ok.headers['set-cookie'] && ok.headers['set-cookie'][0].startsWith('dsh_remote='));
    // revoke audits too
    rc.revokeToken();
    assert.ok(logs.includes('[remote-audit] token-revoke'));
    // the audit trail must never contain the pairing code or the token
    const joined = logs.join('\n');
    assert.ok(!joined.includes(code), 'pairing code leaked into logs');
    assert.ok(!joined.includes(rc.tokens.value), 'token leaked into logs');
  } finally {
    rc.stop();
  }
});
