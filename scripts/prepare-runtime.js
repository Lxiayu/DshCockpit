// scripts/prepare-runtime.js — create the bundled runtime seed for packaging.
//
// electron-builder ships vendor/runtime/<version>/ via extraResources →
// resources/runtime/<version>/, so first launch needs no download. This script
// produces that seed. It must be DETERMINISTIC: the runtime version is pinned
// (never "latest from registry"), so a DeepSeek release (rc.9, rc.10, …) can
// never silently change what DshCockpit v0.2.5 bundles.
//
// Version resolution order (single source of truth = package.json "runtimeVersion"):
//   1. --version <v>
//   2. DSH_RUNTIME_VERSION env
//   3. package.json → runtimeVersion
//   4. --discover  (local dev only: use the dsh found on PATH; no pin check)
//   none of the above → hard error. CI must never auto-select registry latest.
//
// Behavior:
//   vendor/runtime/<version>/ exists AND validates  → cache hit, exit 0
//   exists but invalid                              → discard, reinstall
//   missing                                         → install into .staging/<version>,
//                                                    validate, atomic rename, exit 0
// Install happens via `npm install` (streams CI logs, hard timeout). The seed
// is only promoted to its final name after validation, so a failed/corrupt
// install never leaves a "complete-looking" runtime for the Actions cache.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'runtime');
const PACKAGE_NAME = '@deepseek-ai/dsh';
const INSTALL_TIMEOUT_MS = 40 * 60_000; // Windows cold install: allow up to 40min
const SELFCHECK_TIMEOUT_MS = 60_000;

function log(line) { console.log(`[Runtime] ${line}`); }

/** Total size of a directory tree in MB (rounded). */
function dirSizeMB(p) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else if (e.isFile()) total += fs.statSync(fp).size;
      }
    };
    walk(p);
  } catch { /* best effort */ }
  return Math.round(total / 1e6);
}

/** Read a --flag value from argv (null when absent). */
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

/**
 * Resolve the pinned runtime version.
 * CLI > env > package.json. Never falls back to "registry latest".
 */
function resolveVersion() {
  const fromCli = argValue('--version');
  if (fromCli) return fromCli;
  if (process.env.DSH_RUNTIME_VERSION) return process.env.DSH_RUNTIME_VERSION;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.runtimeVersion) return pkg.runtimeVersion;
  } catch { /* fall through */ }
  return null;
}

/**
 * Validate an installed runtime seed WITHOUT booting the harness:
 *  1. directory exists
 *  2/3. @deepseek-ai/dsh/package.json exists and version === expected
 *  4/5. lib/bin.js exists and is non-empty (truncation guard)
 *  6. lightweight self-check: `node bin.js --version` exits 0 with output
 */
function validateRuntime(dir, expectedVersion) {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'directory missing' };
  const pkgPath = path.join(dir, 'node_modules', PACKAGE_NAME, 'package.json');
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch { return { ok: false, reason: 'runtime package.json missing/unreadable' }; }
  if (pkg.version !== expectedVersion) {
    return { ok: false, reason: `version mismatch: ${pkg.version} != ${expectedVersion}` };
  }
  const binJs = path.join(dir, 'node_modules', PACKAGE_NAME, 'lib', 'bin.js');
  let size = 0;
  try { size = fs.statSync(binJs).size; } catch { return { ok: false, reason: 'bin.js missing' }; }
  if (size === 0) return { ok: false, reason: 'bin.js empty (truncated extraction?)' };
  try {
    const out = execFileSync(process.execPath, [binJs, '--version'], {
      encoding: 'utf8', timeout: SELFCHECK_TIMEOUT_MS, windowsHide: true,
    });
    if (!out || !out.trim()) return { ok: false, reason: 'self-check produced no output' };
  } catch (e) {
    return { ok: false, reason: `self-check failed: ${e.message || e}` };
  }
  return { ok: true };
}

/** Run npm as a child process: streams progress to CI logs, hard timeout. */
function execNpm(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    // shell:true required on Windows — spawn() cannot exec .cmd scripts directly
    // (EINVAL), and npm on all platforms is a shell/CLI shim.
    const child = spawn(npmCmd, args, { cwd, stdio: 'inherit', windowsHide: true, shell: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      reject(new Error(`npm install timed out after ${Math.round(timeoutMs / 60000)}min`));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install exited with code ${code}`));
    });
  });
}

/** Fresh npm install of the pinned version into `dest` (staging dir). */
async function installFromRegistry(version, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'),
    JSON.stringify({ name: 'dsh-runtime-seed', private: true, dependencies: { [PACKAGE_NAME]: version } }, null, 2));
  fs.writeFileSync(path.join(dest, '.npmrc'),
    ['registry=https://registry.npmjs.org/', 'fund=false', 'audit=false', 'loglevel=http', 'maxsockets=10'].join('\n') + '\n');
  await execNpm(['install', '--no-audit', '--no-fund'], dest, INSTALL_TIMEOUT_MS);
}

/** Local-dev only: discover a dsh install on PATH (no pin check). */
function discoverDshVersion() {
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  let shim = null;
  try {
    shim = execFileSync(whereCmd, ['dsh'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch { /* not found */ }
  if (!shim) return null;
  const root = path.dirname(path.dirname(shim));
  const pkgPath = path.join(root, 'node_modules', PACKAGE_NAME, 'package.json');
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null; } catch { return null; }
}

async function run() {
  const version = resolveVersion();
  if (!version) {
    if (process.argv.includes('--discover')) {
      const discovered = discoverDshVersion();
      if (!discovered) {
        console.error('[Runtime] --discover: no dsh found on PATH');
        process.exit(1);
      }
      log(`local dev: using discovered dsh ${discovered}`);
      return runWith(discovered);
    }
    console.error('[Runtime] no runtime version specified.');
    console.error('  Pass --version <v>, set DSH_RUNTIME_VERSION, or add "runtimeVersion" to package.json.');
    console.error('  CI must NOT auto-select the registry latest version.');
    process.exit(1);
  }
  return runWith(version);
}

async function runWith(version) {
  const dest = path.join(VENDOR, version);
  log(`version: ${version}`);
  log(`platform: ${process.platform}-${process.arch}`);

  // ---- cache hit path ----
  if (fs.existsSync(dest)) {
    const hit = validateRuntime(dest, version);
    if (hit.ok) {
      log('cache: hit');
      log('validating... ok');
      log(`ready (${dirSizeMB(dest)} MB)`);
      return;
    }
    // cached but broken — never trust a restored cache blindly
    log(`cache: hit but invalid (${hit.reason}) — discarding`);
    fs.rmSync(dest, { recursive: true, force: true });
  }

  // ---- cache miss path: install into staging, validate, atomic promote ----
  log('cache: miss');
  log(`installing... (cold build; npm timeout ${Math.round(INSTALL_TIMEOUT_MS / 60000)}min)`);
  const staging = path.join(VENDOR, '.staging', version);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  try {
    await installFromRegistry(version, staging);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true }); // never leave a half seed
    console.error(`[Runtime] install failed: ${e.message}`);
    process.exit(1);
  }
  const check = validateRuntime(staging, version);
  if (!check.ok) {
    fs.rmSync(staging, { recursive: true, force: true });
    console.error(`[Runtime] validation failed after install: ${check.reason}`);
    process.exit(1);
  }
  log('validating... ok');
  fs.mkdirSync(VENDOR, { recursive: true });
  fs.renameSync(staging, dest);
  log(`ready (${dirSizeMB(dest)} MB)`);
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { console.error('[Runtime] FAILED:', e); process.exit(1); });
}

module.exports = { resolveVersion, validateRuntime, dirSizeMB, argValue };
