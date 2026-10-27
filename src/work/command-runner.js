'use strict';

// src/work/command-runner.js — 在工作区里执行验证命令（v0.7 P2 WP3）。
//
// 约束：
//   - cwd 固定为工作区（调用方保证）；这是"验证来自真实执行"的唯一来源；
//   - 有超时（默认 5 分钟）与输出上限（默认 256KB）；超时先 SIGTERM 再 SIGKILL；
//   - 只返回粗粒度结果 + 有界输出；命令原文由调用方决定是否落盘（工作区），
//     绝不进入 Team fact / Office 快照。

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 3_000;

function shellFor(platform) {
  if (platform === 'win32') return { bin: 'cmd.exe', args: ['/d', '/s', '/c'] };
  return { bin: '/bin/sh', args: ['-c'] };
}

/**
 * @param {object} deps
 * @param {Function} [deps.spawnImpl]
 * @param {string} [deps.platform]
 * @param {number} [deps.timeoutMs]
 * @param {number} [deps.maxOutputBytes]
 */
function createCommandRunner({
  spawnImpl = spawn,
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  /**
   * @returns {Promise<{ok, exitCode, signal, timedOut, durationMs, output, truncated}>}
   */
  function run({ command, cwd } = {}) {
    const text = typeof command === 'string' ? command.trim() : '';
    if (text === '') return Promise.resolve({ ok: false, code: 'VERIFY_COMMAND_REQUIRED' });
    if (typeof cwd !== 'string' || cwd === '') return Promise.resolve({ ok: false, code: 'VERIFY_CWD_REQUIRED' });
    const shell = shellFor(platform);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(shell.bin, [...shell.args, text], {
          cwd,
          env: { ...process.env },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ ok: false, code: 'VERIFY_SPAWN_FAILED', exitCode: null, signal: null, timedOut: false, durationMs: 0, output: String(error && error.message), truncated: false });
        return;
      }
      const chunks = [];
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;
      const collect = (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (bytes >= maxOutputBytes) { truncated = true; return; }
        const room = maxOutputBytes - bytes;
        if (buffer.length > room) { chunks.push(buffer.subarray(0, room)); bytes = maxOutputBytes; truncated = true; }
        else { chunks.push(buffer); bytes += buffer.length; }
      };
      if (child.stdout && child.stdout.on) child.stdout.on('data', collect);
      if (child.stderr && child.stderr.on) child.stderr.on('data', collect);

      const finish = (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: exitCode === 0 && !timedOut,
          code: timedOut ? 'VERIFY_TIMEOUT' : null,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          signal: signal || null,
          timedOut,
          durationMs: Date.now() - startedAt,
          output: Buffer.concat(chunks).toString('utf8'),
          truncated,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        // A shell that ignores SIGTERM must not pin the work item forever.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS).unref?.();
      }, timeoutMs);
      child.on && child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, code: 'VERIFY_SPAWN_FAILED', exitCode: null, signal: null, timedOut: false, durationMs: Date.now() - startedAt, output: String(error && error.message), truncated });
      });
      child.on && child.on('close', (code, signal) => finish(code, signal));
    });
  }

  return Object.freeze({ run, timeoutMs, maxOutputBytes });
}

module.exports = { createCommandRunner, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES };
