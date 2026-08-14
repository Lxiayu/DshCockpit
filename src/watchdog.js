// src/watchdog.js — orphan reaper for the runtime child.
//
// Spawned detached by the shell (ELECTRON_RUN_AS_NODE). Every 2s it checks
// whether the shell's main process is still alive; if the shell dies hard
// (crash, taskkill /F), it tree-kills the runtime child so no orphaned dsh
// server keeps running.
//
// Usage: node watchdog.js <shellPid> <runtimePid>
'use strict';

const { spawnSync } = require('node:child_process');

const shellPid = Number(process.argv[2]);
const runtimePid = Number(process.argv[3]);

function shellAlive() {
  try {
    process.kill(shellPid, 0);
    return true;
  } catch {
    return false;
  }
}

setInterval(() => {
  if (shellAlive()) return;
  // shell is gone: terminate the runtime process tree
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(runtimePid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(runtimePid, 'SIGKILL'); } catch { /* ignore */ }
  }
  process.exit(0);
}, 2_000);
