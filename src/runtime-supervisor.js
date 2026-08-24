// src/runtime-supervisor.js — runtime supervision primitives (A1, first
// extraction from main.js): crash-loop accounting, cross-platform process
// tree teardown, and detached watchdog arming.
//
// Crash-loop contract (unchanged behaviour, now unit-testable):
//   - a crash is any non-zero runtime exit
//   - crashes older than WINDOW_MS (60s) fall out of the count
//   - up to MAX_CRASHES (3) auto-restarts are allowed inside the window;
//   - recordHealthy() clears the counter (a good boot resets the guard)
'use strict';

const path = require('node:path');

const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

/**
 * Rolling crash-loop guard.
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {number} [deps.windowMs]
 * @param {number} [deps.maxCrashes]
 */
function createCrashLoopGuard({ now = () => Date.now(), windowMs = CRASH_WINDOW_MS, maxCrashes = MAX_CRASHES } = {}) {
  let count = 0;
  let lastAt = 0;
  return {
    /** Record one crash. Returns { restart, attempt } — restart=false once
     * the loop guard trips (max crashes inside the window). */
    record() {
      const t = now();
      if (t - lastAt > windowMs) count = 0; // window elapsed → fresh start
      lastAt = t;
      count += 1;
      return { restart: count <= maxCrashes, attempt: count };
    },
    /** A healthy boot resets the guard. */
    reset() { count = 0; lastAt = 0; },
    get count() { return count; },
  };
}

/** Kill a whole process tree, cross-platform. Never throws.
 * win32: taskkill /T /F (child processes otherwise survive);
 * unix:  SIGKILL the detached process group, falling back to the child. */
function killTree(child) {
  if (!child || child.killed && child.exitCode !== null) { /* best effort */ }
  try {
    if (process.platform === 'win32' && child.pid) {
      const { spawn } = require('node:child_process');
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* not a group leader */ }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  } catch { /* best effort */ }
}

/**
 * Arm the detached reaper: if the shell dies hard, the watchdog reaps the
 * runtime so no orphan keeps serving on loopback. Never throws.
 * @param {object} deps
 * @param {(pid: number) => string} [deps.watchdogScript] path to watchdog.js
 * @param {{bin: string, runAsNode: boolean}} deps.node
 * @param {number} deps.shellPid
 * @param {number} deps.runtimePid
 * @param {(line: string) => void} [deps.log]
 */
function armWatchdog({ watchdogScript = path.join(__dirname, 'watchdog.js'), node, shellPid, runtimePid, log = () => {} }) {
  try {
    const { spawn } = require('node:child_process');
    const env = { ...process.env };
    if (node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const wd = spawn(node.bin, [watchdogScript, String(shellPid), String(runtimePid)], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    });
    wd.unref();
    log(`[shell] watchdog armed (shell=${shellPid}, runtime=${runtimePid})`);
    return true;
  } catch (e) {
    log(`[shell] watchdog spawn failed: ${e.message}`);
    return false;
  }
}

module.exports = { createCrashLoopGuard, killTree, armWatchdog, CRASH_WINDOW_MS, MAX_CRASHES };
