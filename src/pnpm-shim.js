// src/pnpm-shim.js — guarantee a working `pnpm` command for dsh CLI children.
//
// Upstream `dsh plugin` runs spawnSync("pnpm", …) against the ambient PATH
// (lib/plugin-*.js). macOS .apps launched from Finder get a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) and Windows portable installs have none of
// the dev tooling either, so plugin install fails with "pnpm not found on
// PATH". We ship pnpm as a regular dependency and materialize tiny executable
// shims in userData, then prepend that directory to the child's PATH.
//
// H6 (follow the user's environment): pnpm stores are isolated by MAJOR — a
// node_modules tree created by pnpm 9/11 is hard-linked into store/v9|v11 and
// operating on it with pnpm 10 throws ERR_PNPM_UNEXPECTED_STORE. When the
// web profile's .modules.yaml records a different major, resolvePnpmForProfile()
// picks a matching pnpm (system PATH probe first, then an on-demand install of
// pnpm@<major> under userData/pnpm-runtime/<major>) instead of blindly using
// our bundled pnpm 10. The bundled copy stays the default fallback (H3).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHIM_VERSION = '2';
const BUNDLED_PNPM_MAJOR = 10; // what package.json ships (pnpm@^10)
const SYSTEM_PROBE_TIMEOUT_MS = 3_000;
const INSTALL_TIMEOUT_MS = 120_000;

// Fallbacks when the bundled copy cannot be found (e.g. exotic dev setups).
const FALLBACK_DIRS = process.platform === 'darwin'
  ? ['/opt/homebrew/bin', '/usr/local/bin']
  : [];

/** Rewrite packaged asar paths to their real unpacked location: a plain node
 * child cannot read inside app.asar, but electron-builder's asarUnput copies
 * live under app.asar.unpacked next to it. */
function mapAsarUnpack(p) {
  return String(p).split(`app.asar${path.sep}`).join(`app.asar.unpacked${path.sep}`);
}

/** Find node_modules/pnpm/bin/pnpm.cjs by walking up from `fromDir`. Returns
 * the asar-unmapped (child-process visible) absolute path or null. */
function bundledPnpmCjs(fromDir) {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (fs.existsSync(cand)) return mapAsarUnpack(cand);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shimDirOf(userDataDir, sub) {
  return sub !== undefined && sub !== null
    ? path.join(userDataDir, 'shims', String(sub))
    : path.join(userDataDir, 'shims');
}

/** Idempotent shim writer: rewrites only when inputs changed. */
function writeShims(dir, nodeBin, pnpmCjs) {
  const nixBody = `#!/bin/sh\nexec "${nodeBin}" "${pnpmCjs}" "$@"\n`;
  const winBody = `@echo off\r\n"${nodeBin}" "${pnpmCjs}" %*\r\n`;
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, `.v${SHIM_VERSION}.marker`);
  const want = JSON.stringify({ v: SHIM_VERSION, nodeBin, pnpmCjs });
  let cur = null;
  try { cur = fs.readFileSync(marker, 'utf8'); } catch { /* first run */ }
  if (cur !== want) {
    fs.writeFileSync(path.join(dir, 'pnpm'), nixBody, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'pnpm.cmd'), winBody);
    fs.writeFileSync(marker, want);
  }
  return dir;
}

/** Resolve a directory containing a runnable `pnpm`, creating one backed by
 * the bundled package when possible. Never throws — worst case null and the
 * child falls back to the ambient PATH (previous behaviour). */
function ensurePnpmShim({ userDataDir, nodeBin, fromDir } = {}) {
  try {
    const pnpmCjs = bundledPnpmCjs(fromDir || __dirname);
    if (pnpmCjs && userDataDir && nodeBin) {
      return writeShims(shimDirOf(userDataDir), nodeBin, pnpmCjs);
    }
  } catch { /* fall through */ }
  for (const dir of FALLBACK_DIRS) {
    try {
      if (fs.existsSync(path.join(dir, 'pnpm'))) return dir;
    } catch { /* ignore */ }
  }
  return null;
}

// --------------------------------------------------------------------------
// H6: profile-aware resolution
// --------------------------------------------------------------------------

/**
 * Read ONLY the packageManager metadata from <profileDir>/node_modules/.modules.yaml.
 * Regex-based (no YAML dependency); tolerates corepack hashes like
 * `pnpm@9.15.4+sha512.…`. Returns { major: number } or { major: null }
 * (absent / unparsable / non-pnpm manager → caller falls back to bundled).
 * The file's other contents are never interpreted or reported.
 */
function readProfilePnpmMajor(profileDir) {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'node_modules', '.modules.yaml'), 'utf8');
    const m = String(raw).match(/packageManager:\s*["']?pnpm@(\d+)\./);
    if (m) return { major: Number(m[1]) };
  } catch { /* absent or unreadable → bundled fallback */ }
  return { major: null };
}

/** True when <runtimeDir> already holds a usable pnpm of the wanted major. */
function cachedPnpmMatches(runtimeDir, major) {
  const cjs = path.join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!fs.existsSync(cjs)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules', 'pnpm', 'package.json'), 'utf8'));
    const m = String(pkg.version || '').match(/^(\d+)\./);
    return !!m && Number(m[1]) === major;
  } catch { return false; }
}

/** Default system-PATH probe: `pnpm --version` must exist AND match the
 * wanted major (only version-verified candidates are trusted). Returns the
 * directory containing the runnable pnpm, or null. */
async function defaultSystemProbe(major) {
  const { spawn, execFileSync } = require('node:child_process');
  const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const out = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32' });
    } catch { resolve(null); return; }
    let text = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, SYSTEM_PROBE_TIMEOUT_MS);
    child.stdout && child.stdout.on('data', (d) => { text += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? String(text).trim() : null); });
  });
  if (!out || !(new RegExp(`^${major}(\\.|$)`)).test(out)) return null;
  try {
    const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const line = execFileSync(whereCmd, [process.platform === 'win32' ? 'pnpm' : 'pnpm'],
      { encoding: 'utf8', timeout: SYSTEM_PROBE_TIMEOUT_MS, windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line) return path.dirname(line);
  } catch { /* fall through */ }
  return null;
}

/** Default on-demand installer: arborist reify of `pnpm@<major>.x` inside
 * userData/pnpm-runtime/<major> (no npm CLI in the Electron main process). */
async function arboristInstallRunner({ dest, major, cacheDir }) {
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, 'package.json'),
    JSON.stringify({ name: 'dsh-cockpit-pnpm-runtime', private: true, dependencies: { pnpm: `${major}.x` } }, null, 2)
  );
  const Arborist = require('@npmcli/arborist');
  const arb = new Arborist({
    path: dest,
    registry: process.env.DSH_DESKTOP_REGISTRY || 'https://registry.npmjs.org/',
    cache: cacheDir,
  });
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pnpm@${major}.x install timed out`)), INSTALL_TIMEOUT_MS);
  });
  try {
    await Promise.race([arb.reify({ save: false }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// Per-major concurrency lock: two simultaneous plugin ops trigger ONE install.
const _installLocks = new Map();
function installWithLock(key, fn) {
  if (_installLocks.has(key)) return _installLocks.get(key);
  const p = Promise.resolve().then(fn).finally(() => _installLocks.delete(key));
  _installLocks.set(key, p);
  return p;
}

/**
 * Decide which pnpm serves a plugin operation on this profile (never throws).
 * Decision tree (see PREDEV-FEATURES-REPORT §2.7 H6):
 *   1. .modules.yaml absent / unparsable / non-pnpm / major === bundled
 *        → bundled pnpm shim (H3 behaviour, zero network)
 *   2. system PATH has a VERSION-VERIFIED matching major → its directory
 *   3. cached or fresh install of pnpm@<major> under userData/pnpm-runtime/<major>
 *        → shim in userData/shims/<major>
 *   4. all failed → { error, major, reason } (caller renders i18n guidance)
 * @returns {Promise<{shimDir: string|null}|{error: string, major: number, reason?: string}>}
 */
async function resolvePnpmForProfile({
  profileDir,
  userDataDir,
  nodeBin,
  fromDir,
  systemProbe,
  installRunner,
} = {}) {
  const probe = systemProbe || defaultSystemProbe;
  const runner = installRunner || arboristInstallRunner;
  const { major } = readProfilePnpmMajor(profileDir);

  // Step 1/5: bundled pnpm 10 fallback (no .modules.yaml, non-pnpm, or major 10)
  if (!major || major === BUNDLED_PNPM_MAJOR) {
    const dir = ensurePnpmShim({ userDataDir, nodeBin, fromDir });
    // worst case shimDir=null keeps the previous ambient-PATH behaviour
    return { shimDir: dir || null };
  }

  // Step 2: system PATH with a verified matching major wins as-is
  try {
    const sysDir = await probe(major);
    if (sysDir) return { shimDir: sysDir };
  } catch { /* treat a throwing probe as "not found" */ }

  // Step 3: cached or fresh on-demand install, shims isolated per major
  const runtimeDir = path.join(userDataDir, 'pnpm-runtime', String(major));
  const cjs = path.join(runtimeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!cachedPnpmMatches(runtimeDir, major)) {
    try {
      await installWithLock(String(major), () => runner({
        dest: runtimeDir,
        major,
        cacheDir: path.join(userDataDir, 'npm-cache'),
      }));
    } catch (err) {
      return { error: 'install-failed', major, reason: err && err.message };
    }
  }
  if (!fs.existsSync(cjs)) {
    return { error: 'install-failed', major, reason: 'pnpm.cjs missing after install' };
  }
  try {
    if (!userDataDir || !nodeBin) return { shimDir: null };
    return { shimDir: writeShims(shimDirOf(userDataDir, major), nodeBin, mapAsarUnpack(cjs)) };
  } catch (err) {
    return { error: 'install-failed', major, reason: err && err.message };
  }
}

/** Prepend helper kept exported for tests. */
function prependPath(dir, existing) {
  return existing ? `${dir}${path.delimiter}${existing}` : dir;
}

module.exports = {
  mapAsarUnpack,
  bundledPnpmCjs,
  shimDirOf,
  ensurePnpmShim,
  prependPath,
  readProfilePnpmMajor,
  cachedPnpmMatches,
  resolvePnpmForProfile,
  defaultSystemProbe,
  arboristInstallRunner,
  SHIM_VERSION,
  BUNDLED_PNPM_MAJOR,
};
