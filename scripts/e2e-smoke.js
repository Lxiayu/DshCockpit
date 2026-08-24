// scripts/e2e-smoke.js — artifact-level end-to-end smoke gate (A2).
//
// Launches a PACKAGED DshCockpit binary exactly like a user would (isolated
// userData, no tray), waits for the boot URL line in the shell log, probes
// the served HTTP endpoint, then shuts everything down. Exit 0 = the artifact
// boots and serves; any timeout/crash prints the log tail and exits non-zero.
// This is the gate that would have caught the v0.2.9 build.js regression and
// the v0.2.8 "准备中 forever" poller bug before reaching users.
//
// Usage:
//   node scripts/e2e-smoke.js --app <path-to-launchable-binary> [--timeout 180000]
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const appPath = argValue('--app');
const TIMEOUT_MS = Number(argValue('--timeout')) || 180_000;
if (!appPath || !fs.existsSync(appPath)) {
  console.error(`[e2e] --app path missing or not found: ${appPath}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-ud-'));
const logsDir = path.join(userDataDir, 'logs');
let urlLineSeen = false;
let healthOk = false;

console.log(`[e2e] app: ${appPath}`);
console.log(`[e2e] userData: ${userDataDir}`);

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
  } catch { /* already gone */ }
}

function tailAllLogs(limitBytes = 4000) {
  let out = '';
  try {
    for (const f of fs.readdirSync(logsDir).filter((n) => n.endsWith('.log'))) {
      const buf = fs.readFileSync(path.join(logsDir, f));
      out += `\n----- ${f} -----\n` + buf.slice(Math.max(0, buf.length - limitBytes)).toString('utf8');
    }
  } catch { /* logs dir may not exist yet */ }
  return out;
}

function extractUrls(text) {
  const out = [];
  for (const m of String(text).matchAll(/runtime URL: (https?:\/\/127\.0\.0\.1:\d+)/g)) out.push(m[1]);
  return out;
}

/** Read all shell logs incrementally; returns the newest URL seen (or null). */
let consumed = new Map(); // file -> bytes consumed
function pollForUrl() {
  let files = [];
  try { files = fs.readdirSync(logsDir).filter((n) => n.endsWith('.log')); } catch { return null; }
  for (const name of files) {
    const full = path.join(logsDir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    const from = consumed.get(full) || 0;
    if (st.size <= from) continue;
    let fd = -1;
    try {
      fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(st.size - from);
      const ret = fs.readSync(fd, buf, 0, buf.length, from);
      const n = typeof ret === 'number' ? ret : ((ret && ret.bytesRead) || 0);
      consumed.set(full, from + n);
      const urls = extractUrls(buf.toString('utf8', 0, n));
      if (urls.length) return urls[urls.length - 1];
    } catch { /* retry next tick */ }
    finally { if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  }
  return null;
}

function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(3000, () => { try { req.destroy(); } catch { /* ignore */ } resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const startedAt = Date.now();
  const child = spawn(appPath, [], {
    env: { ...process.env, DSH_DESKTOP_USER_DATA: userDataDir, DSH_DESKTOP_NO_TRAY: '1' },
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  console.log(`[e2e] spawned pid=${child.pid}`);

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  const deadline = startedAt + TIMEOUT_MS;
  let lastUrl = null;

  while (Date.now() < deadline) {
    if (exited && !urlLineSeen) {
      console.error(`[e2e] FAIL: app exited early code=${exited.code} signal=${exited.signal}`);
      console.error(tailAllLogs());
      killTree(child);
      process.exit(1);
    }
    if (!urlLineSeen) {
      const url = pollForUrl();
      if (url) {
        urlLineSeen = true;
        lastUrl = url;
        console.log(`[e2e] URL line found after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${url}`);
      }
    } else if (await probe(lastUrl)) {
      healthOk = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!urlLineSeen) {
    console.error('[e2e] FAIL: URL line never appeared');
    killTree(child);
    console.error(tailAllLogs());
    process.exit(1);
  }
  if (!healthOk) {
    console.error(`[e2e] FAIL: ${lastUrl} never returned 200`);
    killTree(child);
    console.error(tailAllLogs());
    process.exit(1);
  }

  // Updater-feed gate (D5): the packaged app must carry an app-update.yml
  // pointing at the real repo — 'owner: local' means the CI env was missing
  // and the in-app updater would 404 forever.
  const resourcesDir = path.join(path.dirname(appPath), '..', 'Resources');
  const feedPath = process.platform === 'win32'
    ? path.join(path.dirname(appPath), 'resources', 'app-update.yml')
    : path.join(resourcesDir, 'app-update.yml');
  try {
    const feed = fs.readFileSync(feedPath, 'utf8');
    if (/owner:\s*local\b/.test(feed)) {
      console.error('[e2e] FAIL: app-update.yml points at the placeholder "local" repo (CI env DSH_REPO_OWNER/DSH_REPO_NAME missing)');
      killTree(child);
      process.exit(1);
    }
    console.log(`[e2e] updater feed ok: ${feed.split('\n').filter((l) => /owner|repo/.test(l)).join(' ').trim()}`);
  } catch {
    console.error(`[e2e] FAIL: app-update.yml missing at ${feedPath} (in-app auto-update would be dead)`);
    killTree(child);
    process.exit(1);
  }

  // Graceful-shutdown gate: SIGTERM must produce a clean quit (before-quit ->
  // window close -> backup -> exit) within 15s. A crash dialog or hung
  // close-handler here is exactly the class of bug users see on exit.
  console.log('[e2e] sending SIGTERM for graceful shutdown');
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const exitDeadline = Date.now() + 15_000;
  while (!exited && Date.now() < exitDeadline) await new Promise((r) => setTimeout(r, 200));
  if (!exited) {
    console.error('[e2e] FAIL: app did not exit within 15s of SIGTERM');
    killTree(child);
    console.error(tailAllLogs());
    process.exit(1);
  }
  if (exited.code !== 0 && exited.signal !== 'SIGTERM') {
    console.error(`[e2e] FAIL: app exited code=${exited.code} signal=${exited.signal} during shutdown`);
    process.exit(1);
  }
  console.log(`[e2e] PASS: booted, served ${lastUrl}, health 200, clean shutdown (${((Date.now() - startedAt) / 1000).toFixed(1)}s total)`);
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

main().catch((err) => { console.error('[e2e] FAILED:', err.message); process.exit(1); });
