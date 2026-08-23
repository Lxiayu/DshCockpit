// scripts/build.js — electron-builder wrapper.
// Local builds default DSH_REPO_OWNER/NAME to "local" so the publish config
// expands; real publish sets the env vars (see RELEASE.md) and passes --publish always.
'use strict';

process.env.DSH_REPO_OWNER = process.env.DSH_REPO_OWNER || 'local';
process.env.DSH_REPO_NAME = process.env.DSH_REPO_NAME || 'local';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_VENDOR = path.join(ROOT, 'vendor', 'runtime');
const RUNTIME_ARCHIVE = path.join(ROOT, 'vendor', '.archive');

/** The single source of truth for the bundled seed (same as prepare-runtime). */
function pinnedRuntimeVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).runtimeVersion || null;
  } catch { return null; }
}

/**
 * extraResources copies the WHOLE vendor/runtime directory into the artifact.
 * Local dev trees accumulate old seeds (e.g. rc.6 + rc.7 next to rc.2), which
 * would bloat the package by hundreds of MB and let findBundledRuntime pick a
 * stale version. Archive every non-pinned seed for the duration of the build,
 * then put them back — nothing is deleted.
 */
function archiveForeignRuntimeSeeds() {
  const pinned = pinnedRuntimeVersion();
  if (!pinned || !fs.existsSync(RUNTIME_VENDOR)) return [];
  const moved = [];
  for (const e of fs.readdirSync(RUNTIME_VENDOR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === pinned || e.name.startsWith('.')) continue;
    fs.mkdirSync(RUNTIME_ARCHIVE, { recursive: true });
    const to = path.join(RUNTIME_ARCHIVE, e.name);
    if (fs.existsSync(to)) { try { fs.rmSync(path.join(RUNTIME_VENDOR, e.name), { recursive: true, force: true }); } catch { /* keep going */ } continue; }
    try {
      fs.renameSync(path.join(RUNTIME_VENDOR, e.name), to);
      moved.push(e.name);
    } catch { /* cross-device fallback: leave it, builder copies it (local-only bloat) */ }
  }
  return moved;
}

function restoreArchivedRuntimeSeeds(moved) {
  for (const name of moved || []) {
    try { fs.renameSync(path.join(RUNTIME_ARCHIVE, name), path.join(RUNTIME_VENDOR, name)); }
    catch (err) { console.error(`[build] could not restore archived seed ${name}: ${err.message}`); }
  }
}

const archivedSeeds = archiveForeignRuntimeSeeds();
if (archivedSeeds.length) {
  console.log(`[build] archiving non-pinned runtime seeds for this build: ${archivedSeeds.join(', ')} (restored afterwards)`);
}

const args = process.argv.slice(2); // module scope: the --win verification below needs it
let result;
try {
  const cli = require.resolve('electron-builder/cli');
  result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: ROOT });
} finally {
  restoreArchivedRuntimeSeeds(archivedSeeds);
}
if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);

// Post-build artifact verification: the portable zip must contain the app
// exe, app.asar, the updater feed and a non-empty bundled runtime seed
// (a broken seed is exactly the "cannot find dsh runtime (lib/bin.js)" bug).
if (args.includes('--win')) {
  const { verify } = require('./verify-dist');
  const pi = args.indexOf('--publish');
  const publishing = pi !== -1 && args[pi + 1] !== 'never';
  try {
    if (!verify({ requireUpdaterFeed: publishing })) process.exit(1);
  } catch (e) {
    console.error('[build] artifact verification failed:', e.message);
    process.exit(1);
  }
}
