// scripts/build.js — electron-builder wrapper.
// Local builds default DSH_REPO_OWNER/NAME to "local" so the publish config
// expands; real publish sets the env vars (see RELEASE.md) and passes --publish always.
'use strict';

process.env.DSH_REPO_OWNER = process.env.DSH_REPO_OWNER || 'local';
process.env.DSH_REPO_NAME = process.env.DSH_REPO_NAME || 'local';

const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const cli = require.resolve('electron-builder/cli');
const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: __dirname + '/..' });
if (r.status !== 0) process.exit(r.status === null ? 1 : r.status);

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
