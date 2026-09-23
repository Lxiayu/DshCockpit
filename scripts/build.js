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

// D2 slim track: --slim hides the ENTIRE runtime seed for this build (the
// slim config has no extraResources entry for it). First launch of a slim
// install runs the guided registry install or picks up a system dsh.
const args = process.argv.slice(2); // module scope: the --win verification below needs it
const SLIM = args.includes('--slim');
let slimRuntimeHidden = false;
function hideRuntimeForSlim() {
  if (!SLIM || !fs.existsSync(RUNTIME_VENDOR)) return;
  try {
    fs.renameSync(RUNTIME_VENDOR, path.join(ROOT, 'vendor', '.runtime-hidden'));
    slimRuntimeHidden = true;
    console.log('[build] slim track: vendor/runtime hidden from extraResources');
  } catch (err) {
    console.error(`[build] could not hide vendor/runtime (${err.message}); continuing FULL`);
  }
}
function unhideRuntimeForSlim() {
  if (!slimRuntimeHidden) return;
  try { fs.renameSync(path.join(ROOT, 'vendor', '.runtime-hidden'), RUNTIME_VENDOR); } catch { /* best effort */ }
}
hideRuntimeForSlim();

// D1: prune the pinned seed (docs/maps/types/foreign prebuilds) BEFORE
// packaging — halves the file count the installer must write and users must
// delete; idempotent, and the E2E smoke below validates the pruned tree.
try {
  const pinned = pinnedRuntimeVersion();
  if (pinned) {
    const { pruneRuntime } = require('./prune-runtime');
    const stats = pruneRuntime(path.join(ROOT, 'vendor', 'runtime', pinned));
    if (stats.filesRemoved || stats.dirsRemoved) {
      console.log(`[build] pruned runtime ${pinned}: -${stats.filesRemoved} files / -${stats.dirsRemoved} dirs / -${(stats.bytesSaved / 1e6).toFixed(1)} MB`);
    }
  }
} catch (err) {
  console.error(`[build] runtime prune failed (packaging UNPRUNED tree): ${err.message}`);
}

// H7: normalize the legacy positional 'dir' into the --dir flag —
// 'electron-builder --mac --arm64 dir' fails with "Unknown argument: dir"
// while '--mac dir' and '--dir' both work. Normalizing keeps every
// invocation form working across all workflows.
const normalizedArgs = args.filter((a) => a !== '--slim').map((a) => (a === 'dir' ? '--dir' : a));

let result;
try {
  const cli = require.resolve('electron-builder/cli');
  // --slim selects the slim variant via env (see electron-builder.js)
  if (SLIM) process.env.DSH_BUILD_SLIM = '1';
  result = spawnSync(process.execPath, [cli, ...normalizedArgs], { stdio: 'inherit', cwd: ROOT });
} finally {
  // order matters: un-hiding vendor/runtime first gives the archived seeds
  // their destination directory back
  unhideRuntimeForSlim();
  restoreArchivedRuntimeSeeds(archivedSeeds);
}
if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);

// Post-build artifact verification: the portable zip must contain the app
// exe, app.asar, the updater feed and a non-empty bundled runtime seed
// (a broken seed is exactly the "cannot find dsh runtime (lib/bin.js)" bug).
// P5: the gates now also open app.asar (authoring block must be absent,
// production office surface + runtime materials must be present) and run on
// every track — win (zip/win-unpacked) and mac (.app/zip) alike, including
// the flagless `npm run build` (host default). Only artifacts of THIS build's
// version are checked, so stale zips left in dist/ by older builds are never
// failed against current gates; a build that produced nothing verifiable
// (e.g. a failed packaging) simply reports "skipping".
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
{
  const { verify } = require('./verify-dist');
  const pi = args.indexOf('--publish');
  const publishing = pi !== -1 && args[pi + 1] !== 'never';
  try {
    if (!verify({ requireUpdaterFeed: publishing, slim: SLIM, version: pkg.version })) process.exit(1);
  } catch (e) {
    console.error('[build] artifact verification failed:', e.message);
    process.exit(1);
  }
}
