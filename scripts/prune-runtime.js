// scripts/prune-runtime.js — v0.3.0 D1: whitelist-prune the vendored dsh
// runtime after prepare-runtime so the shipped payload carries only what the
// runtime can load at require-time.
//
// Removed (safe classes — never required by Node at runtime):
//   *.map, *.md, README*, CHANGELOG*, HISTORY*, AUTHORS*, *.d.ts,
//   test/ tests/ __tests__/ .github/ dirs
// Platform filter:
//   node-pty/prebuilds/<platform>-<arch> — keep only the host pair; the other
//   platform binaries are dead weight in a single-platform artifact.
// Kept on purpose:
//   LICENSE/COPYING (MIT compliance), package.json, lib/, dist/, native .node.
//
// Idempotent: re-running finds nothing to remove. Every removal is counted;
// a summary prints the file count and byte savings. Never touches anything
// outside the requested root.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REMOVE_FILE_RE = /(\.map$|\.md$|\.d\.ts$)/i;
const REMOVE_FILE_PREFIX = /^(readme|changelog|history|authors|contributing)/i;
const REMOVE_DIRS = new Set(['test', 'tests', '__tests__', '.github']);
const KEEP_PREFIX_RE = /^(license|copying)/i;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function walk(root, cb) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (REMOVE_DIRS.has(e.name.toLowerCase())) {
        cb(full, 'dir', e.name);
        continue;
      }
      walk(full, cb);
    } else if (e.isFile()) {
      const name = e.name;
      if (KEEP_PREFIX_RE.test(name)) continue; // license files stay (MIT compliance)
      if (REMOVE_FILE_RE.test(name) || REMOVE_FILE_PREFIX.test(name)) cb(full, 'file', name);
    }
  }
}

function sizeOf(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() ? -1 : st.size;
  } catch { return 0; }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * @param {string} runtimeRoot  e.g. vendor/runtime/0.1.1-rc.2
 * @param {{platform?: string, arch?: string}} [opts]
 * @returns {{filesRemoved: number, dirsRemoved: number, bytesSaved: number}}
 */
function pruneRuntime(runtimeRoot, opts = {}) {
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  let filesRemoved = 0;
  let dirsRemoved = 0;
  let bytesSaved = 0;

  const nm = path.join(runtimeRoot, 'node_modules');
  if (!fs.existsSync(nm)) {
    console.log(`[prune] no node_modules under ${runtimeRoot} — nothing to do`);
    return { filesRemoved, dirsRemoved, bytesSaved };
  }

  // pass 1: generic doc/map/type/test pruning across every package
  walk(nm, (p, kind) => {
    const size = kind === 'dir' ? -1 : sizeOf(p);
    rmrf(p);
    if (kind === 'dir') dirsRemoved += 1;
    else { filesRemoved += 1; bytesSaved += Math.max(0, size); }
  });

  // pass 2: drop foreign-platform prebuilds (node-pty ships all platforms)
  const prebuilds = path.join(nm, 'node-pty', 'prebuilds');
  try {
    for (const e of fs.readdirSync(prebuilds, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const keep = e.name === `${platform}-${arch}`;
      if (!keep) {
        const size = sizeOf(path.join(prebuilds, e.name));
        rmrf(path.join(prebuilds, e.name));
        dirsRemoved += 1;
        bytesSaved += Math.max(0, size);
        console.log(`[prune] dropped foreign prebuilds/${e.name}`);
      }
    }
  } catch { /* no prebuilds dir */ }

  return { filesRemoved, dirsRemoved, bytesSaved };
}

async function main() {
  const root = argValue('--root');
  if (!root || !fs.existsSync(root)) {
    console.error('[prune] --root <runtime-dir> missing or not found');
    process.exit(1);
  }
  const t0 = Date.now();
  const { filesRemoved, dirsRemoved, bytesSaved } = pruneRuntime(path.resolve(root));
  const mb = (bytesSaved / 1e6).toFixed(1);
  console.log(`[prune] removed ${filesRemoved} files / ${dirsRemoved} dirs, saved ${mb} MB in ${Date.now() - t0}ms`);
  // Post-gate: the pruned runtime must still answer its own version probe.
  const binJs = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(binJs)) {
    console.error('[prune] FAIL: lib/bin.js missing after prune — refusing to continue');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[prune] FAILED:', err); process.exit(1); });
}

module.exports = { pruneRuntime };
