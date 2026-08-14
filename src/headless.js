// src/headless.js — run a one-shot `dsh --profile headless <prompt>` in the
// background and capture the final answer. Shared by Quick Ask and the
// scheduler. Output goes to a log file via an fd (no pipes; sandbox-safe).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/**
 * @param {object} opts { dshBin, nodeBin: {bin, runAsNode}, dshHome, workspace, logDir, prompt }
 * @returns Promise<{ ok: boolean, output: string, durationMs: number }>
 */
function runHeadless(opts) {
  const outFile = path.join(opts.logDir, `headless-${Date.now()}.out`);
  let fd = -1;
  try { fd = fs.openSync(outFile, 'a'); } catch { /* ignore */ }
  return new Promise((resolve) => {
    const env = { ...process.env, DSH_HOME: opts.dshHome };
    if (opts.nodeBin.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const started = Date.now();
    let child;
    try {
      child = spawn(opts.nodeBin.bin, [opts.dshBin, '--profile', 'headless', opts.prompt], {
        env,
        cwd: opts.workspace,
        windowsHide: true,
        stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd],
      });
    } catch (e) {
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve({ ok: false, output: e.message, durationMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve({ ok: false, output: 'timeout', durationMs: Date.now() - started });
    }, opts.timeoutMs || 10 * 60 * 1000); // never hang a Quick Ask / scheduler slot forever
    child.on('error', (e) => {
      clearTimeout(timer);
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve({ ok: false, output: e.message, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      resolve({ ok: code === 0, output: out.trim(), durationMs: Date.now() - started });
    });
  });
}

module.exports = { runHeadless };
