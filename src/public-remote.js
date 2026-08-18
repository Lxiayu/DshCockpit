// src/public-remote.js — public-network phone remote access (C7).
//
// Main route: Tailscale direct tailnet access. The phone joins the user's
// tailnet (free Personal plan: 6 users, unlimited devices) and reaches the
// EXISTING gateway at http://100.x.y.z:<port> exactly like a LAN client —
// the gateway itself needs zero changes. This module only DETECTS the local
// Tailscale install (three cross-checked signals) so the settings page can
// guide install/login and build the pairing URL.
//
// Aux route: cloudflared quick tunnel. `cloudflared tunnel --url
// http://127.0.0.1:<port>` yields a zero-account temporary
// https://*.trycloudflare.com URL (WS-capable, 200 in-flight requests, no
// SLA, URL changes on every start). We spawn it as a child process, parse
// the URL from its output, and kill it on stop / app quit (Windows gets the
// taskkill /T /F tree kill).
//
// Process discipline (the where.exe lesson, see main.js): every probe runs
// execFile asynchronously with a 3s hard timeout + windowsHide; detection
// results are cached in memory (60s) so the 5s settings-page poller stays
// cheap; nothing here runs on the boot path — detection is lazy and only
// triggered from the settings window.
'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const { PAIR_PATH } = require('./remote-control');

// Tailscale CLI candidate paths. macOS ships THREE documented variants:
// App Store (CLI embedded in the .app — MUST run with TAILSCALE_BE_CLI=1 or
// it opens the GUI window instead of answering), Standalone/pkg (its "CLI
// integration" lands in /usr/local/bin) and homebrew (both prefixes). The
// Windows installer adds its dir to PATH and defaults to Program Files.
// Unknown platforms get the generic PATH-first probe.
const TS_CLI_CANDIDATES = {
  darwin: [
    { file: '/opt/homebrew/bin/tailscale' },
    { file: '/usr/local/bin/tailscale' },
    { file: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', env: { TAILSCALE_BE_CLI: '1' } },
    { file: 'tailscale' },
  ],
  win32: [
    { file: 'tailscale' },
    { file: 'C:\\Program Files\\Tailscale\\tailscale.exe' },
  ],
  generic: [
    { file: 'tailscale' },
    { file: '/usr/local/bin/tailscale' },
    { file: '/usr/bin/tailscale' },
  ],
};

const CLOUDFLARED_CANDIDATES = {
  darwin: ['cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
  win32: ['cloudflared', 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'],
  generic: ['cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'],
};

const TS_API_URL = 'http://100.100.100.100/api/data';
const TS_DETECTION_TTL_MS = 60 * 1000;
const TS_API_TIMEOUT_MS = 3 * 1000;
const PROC_TIMEOUT_MS = 3 * 1000;
const TUNNEL_URL_TIMEOUT_MS = 10 * 1000;
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Unified execFile wrapper: never rejects; errors ride in { error }. */
function defaultExecFile(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => resolve({
      error: error || null,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    }));
  });
}

/** GET a URL, parse JSON, always resolve ({ ok: false, reason } on failure). */
function defaultHttpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: `http-${res.statusCode}` }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ ok: false, reason: 'bad-json' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', () => resolve({ ok: false, reason: 'error' }));
  });
}

/** Strip the trailing dot MagicDNS names carry ("host.tail4abc12.ts.net."). */
function stripTrailingDot(s) {
  if (typeof s !== 'string' || !s) return null;
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

/** First IPv4 in a TailscaleIPs list (v4 normally sorts first; stay safe). */
function pickTailscaleV4(ips) {
  for (const ip of ips || []) {
    if (typeof ip === 'string' && ip.includes('.')) return ip;
  }
  return null;
}

/**
 * CGNAT-range (100.64.0.0/10) interface address, or null. Corroboration
 * ONLY: RFC 6598 space is not Tailscale-exclusive (carrier NAT, other
 * overlays use it too), so it never proves an install on its own.
 */
function tailscaleIface(interfaces) {
  for (const list of Object.values(interfaces || {})) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const parts = ni.address.split('.');
      if (Number(parts[0]) === 100 && Number(parts[1]) >= 64 && Number(parts[1]) <= 127) return ni.address;
    }
  }
  return null;
}

/** Pairing URL for any host form (LAN IP / 100.x.y.z / MagicDNS name). */
function buildPairUrl(host, port, secure, code) {
  if (!host || !port || !code) return null;
  return `${secure ? 'https' : 'http'}://${host}:${port}${PAIR_PATH}?c=${encodeURIComponent(code)}`;
}

/**
 * Public-remote helper. All external effects (execFile/spawn/fs/net) are
 * injectable for tests; everything async, nothing on the boot path.
 */
function createPublicRemote(opts = {}) {
  const log = opts.log || (() => {});
  const platform = opts.platform || process.platform;
  const deps = {
    execFile: opts.execFile || defaultExecFile,
    spawn: opts.spawn || ((file, args, o) => spawn(file, args, o)),
    fsExists: opts.fsExists || ((p) => fs.existsSync(p)),
    netInterfaces: opts.netInterfaces || (() => os.networkInterfaces()),
    httpGetJson: opts.httpGetJson || defaultHttpGetJson,
    env: opts.env !== undefined ? opts.env : process.env,
  };
  const tunnelUrlTimeoutMs = opts.tunnelUrlTimeoutMs || TUNNEL_URL_TIMEOUT_MS;

  const state = {
    tsCache: null, tsProbe: null,
    cfCache: null, cfProbe: null,
    tunnelChild: null, tunnelUrl: null, cloudflaredBin: null,
  };

  function spawnOpts(extraEnv) {
    return { timeout: PROC_TIMEOUT_MS, windowsHide: true, env: { ...deps.env, ...(extraEnv || {}) } };
  }

  /** Signal C: CLI candidate sweep + `tailscale status --json`. */
  async function probeCli() {
    const cands = TS_CLI_CANDIDATES[platform] || TS_CLI_CANDIDATES.generic;
    for (const cand of cands) {
      // µs disk check before any spawn — ENOENT-only candidates on PATH
      // (bare name, no separator) are left to execFile to resolve.
      if ((cand.file.includes('/') || cand.file.includes('\\')) && !deps.fsExists(cand.file)) continue;
      const r = await deps.execFile(cand.file, ['status', '--json'], spawnOpts(cand.env));
      if (r.error && r.error.code === 'ENOENT') continue;
      if (!r.error && r.stdout) {
        try {
          const j = JSON.parse(r.stdout);
          const self = (j && j.Self) || null;
          const ipv4 = pickTailscaleV4(self && self.TailscaleIPs);
          if (ipv4) {
            return { cliPath: cand.file, loggedIn: true, ipv4, dnsName: stripTrailingDot(self.DNSName) };
          }
        } catch { /* unparseable status — treat as installed, no session */ }
      }
      // The binary exists (spawn answered, or failed with a non-ENOENT error
      // like "daemon not running" / logged out): Tailscale is installed.
      return { cliPath: cand.file, loggedIn: false, ipv4: null, dnsName: null };
    }
    return { cliPath: null, loggedIn: false, ipv4: null, dnsName: null };
  }

  /** Signal B: local API probe — needs no CLI and no admin rights. */
  async function probeApi() {
    const r = await deps.httpGetJson(TS_API_URL, TS_API_TIMEOUT_MS);
    if (!r.ok) return { reachable: false, ipv4: null, dnsName: null };
    const self = (r.json && (r.json.Self || r.json)) || null;
    return {
      reachable: true,
      ipv4: pickTailscaleV4(self && self.TailscaleIPs),
      dnsName: stripTrailingDot(self && self.DNSName),
    };
  }

  /** Signal A (corroboration) + B + C, reduced to one state. */
  async function detectNow() {
    const ifaceHint = tailscaleIface(deps.netInterfaces());
    const [api, cli] = await Promise.all([probeApi(), probeCli()]);
    const installed = !!cli.cliPath || api.reachable;
    const loggedIn = cli.loggedIn || (api.reachable && !!api.ipv4);
    const running = api.reachable || cli.loggedIn;
    return {
      state: !installed ? 'notInstalled' : (loggedIn ? 'loggedIn' : 'notLoggedIn'),
      installed,
      running,
      loggedIn,
      ipv4: cli.ipv4 || api.ipv4 || (loggedIn ? ifaceHint : null),
      dnsName: cli.dnsName || api.dnsName || null,
      cliPath: cli.cliPath,
      ifaceHint: !!ifaceHint,
      checkedAt: Date.now(),
    };
  }

  async function detectCloudflaredNow() {
    const cands = CLOUDFLARED_CANDIDATES[platform] || CLOUDFLARED_CANDIDATES.generic;
    for (const bin of cands) {
      if ((bin.includes('/') || bin.includes('\\')) && !deps.fsExists(bin)) continue;
      const r = await deps.execFile(bin, ['--version'], spawnOpts());
      if (r.error && r.error.code === 'ENOENT') continue;
      if (!r.error) {
        const m = /version\s+([0-9][^\s]*)/i.exec(`${r.stdout} ${r.stderr}`);
        state.cloudflaredBin = bin;
        return { installed: true, bin, version: m ? m[1] : null, checkedAt: Date.now() };
      }
    }
    state.cloudflaredBin = null;
    return { installed: false, bin: null, version: null, checkedAt: Date.now() };
  }

  const api = {
    /** Tailscale presence, three signals cross-checked; cached 60s. */
    async detectTailscale(force = false) {
      if (!force && state.tsCache && Date.now() - state.tsCache.checkedAt < TS_DETECTION_TTL_MS) return state.tsCache;
      if (state.tsProbe) return state.tsProbe; // share one in-flight probe across pollers
      state.tsProbe = detectNow();
      try { state.tsCache = await state.tsProbe; } finally { state.tsProbe = null; }
      return state.tsCache;
    },

    /** cloudflared presence; cached 60s. */
    async detectCloudflared(force = false) {
      if (!force && state.cfCache && Date.now() - state.cfCache.checkedAt < TS_DETECTION_TTL_MS) return state.cfCache;
      if (state.cfProbe) return state.cfProbe;
      state.cfProbe = detectCloudflaredNow();
      try { state.cfCache = await state.cfProbe; } finally { state.cfProbe = null; }
      return state.cfCache;
    },

    tunnelStatus() {
      return { running: !!state.tunnelChild, url: state.tunnelUrl };
    },

    /**
     * Start a cloudflared quick tunnel to the gateway port. Resolves with
     * { ok, url } once a https://*.trycloudflare.com URL shows up in the
     * child output (stdout or stderr — quick tunnels announce on stderr),
     * or { ok: false, reason } on timeout / early exit / spawn error.
     */
    async startTunnel(port) {
      if (state.tunnelChild) return { ok: true, url: state.tunnelUrl, alreadyRunning: true };
      const cf = await api.detectCloudflared(true); // manual action: bypass the cache
      if (!cf.installed) return { ok: false, reason: 'not-installed' };
      const bin = cf.bin;
      return new Promise((resolve) => {
        let child;
        try {
          child = deps.spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: deps.env,
          });
        } catch (e) {
          resolve({ ok: false, reason: `spawn-failed:${(e && e.code) || (e && e.message) || 'error'}` });
          return;
        }
        state.tunnelChild = child;
        state.tunnelUrl = null;
        let settled = false;
        let buf = '';
        const finish = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        const onData = (chunk) => {
          if (settled) return;
          buf += chunk.toString('utf8');
          if (buf.length > 65536) buf = buf.slice(-32768);
          const m = TUNNEL_URL_RE.exec(buf);
          if (m) {
            state.tunnelUrl = m[0];
            log(`[tunnel] quick tunnel up: ${m[0]}`);
            finish({ ok: true, url: m[0] });
          }
        };
        if (child.stdout) child.stdout.on('data', onData);
        if (child.stderr) child.stderr.on('data', onData);
        const timer = setTimeout(() => {
          log('[tunnel] no trycloudflare URL within timeout; killing');
          api.stopTunnel();
          finish({ ok: false, reason: 'url-timeout' });
        }, tunnelUrlTimeoutMs);
        child.on('error', (e) => {
          state.tunnelChild = null;
          state.tunnelUrl = null;
          finish({ ok: false, reason: e && e.code === 'ENOENT' ? 'not-installed' : 'spawn-failed' });
        });
        child.on('exit', () => {
          state.tunnelChild = null;
          state.tunnelUrl = null;
          finish({ ok: false, reason: 'exited' });
        });
      });
    },

    /** Kill the tunnel child; Windows gets the taskkill /T /F tree kill. */
    stopTunnel() {
      const child = state.tunnelChild;
      state.tunnelChild = null;
      state.tunnelUrl = null;
      if (!child) return;
      try { child.kill(); } catch { /* already gone */ }
      if (platform === 'win32' && child.pid) {
        // belt-and-suspenders tree kill: child.kill() on Windows can leave
        // grandchildren (cloudflared spawns none today, but never rely on it)
        deps.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], spawnOpts());
      }
      log('[tunnel] quick tunnel stopped');
    },
  };
  return api;
}

module.exports = {
  createPublicRemote,
  buildPairUrl,
  tailscaleIface,
  stripTrailingDot,
  pickTailscaleV4,
  TS_CLI_CANDIDATES,
  CLOUDFLARED_CANDIDATES,
  TS_API_URL,
};
