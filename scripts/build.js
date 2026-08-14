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
process.exit(r.status === null ? 1 : r.status);
