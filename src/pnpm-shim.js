// src/pnpm-shim.js — guarantee a working `pnpm` command for dsh CLI children.
//
// Upstream `dsh plugin` runs spawnSync("pnpm", …) against the ambient PATH
// (lib/plugin-*.js). macOS .apps launched from Finder get a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) and Windows portable installs have none of
// the dev tooling either, so plugin install fails with "pnpm not found on
// PATH". We ship pnpm as a regular dependency and materialize tiny executable
// shims in userData, then prepend that directory to the child's PATH.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SHIM_VERSION = '1';

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

function shimDirOf(userDataDir) {
  return path.join(userDataDir, 'shims');
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

/** Prepend helper kept exported for tests. */
function prependPath(dir, existing) {
  return existing ? `${dir}${path.delimiter}${existing}` : dir;
}

module.exports = { mapAsarUnpack, bundledPnpmCjs, shimDirOf, ensurePnpmShim, prependPath };
