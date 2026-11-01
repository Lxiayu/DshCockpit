// src/capability-packs/verify.js — Capability Pack 的验证执行器（P3 S2）。
//
// 第一性原理：为什么结果是四态而不是布尔
//
//   布尔只有"通过/不通过"两种，但真实验证有四种情况：
//
//   | 情况 | 布尔会怎么记 | 应该怎么记 |
//   |---|---|---|
//   | 命令跑通，退出码符合预期 | true | **passed** |
//   | 命令跑通但退出码不符 / 超时 | false | **failed** |
//   | 平台不支持，压根没跑 | false 或 true | **skipped** |
//   | 依赖命令不存在，无法运行 | false | **not-verified** |
//
//   把 skipped 记成 false 会让"不支持"看起来像"坏了"；
//   把 skipped 记成 true 就是本项目踩过的**Skip 冒充 Pass**。
//   两种都不行，所以必须四态。
//
// 第二性原理：为什么复用 command-runner 而不是自己 spawn
//
//   `src/work/command-runner.js` 已经处理了：超时 + SIGTERM→SIGKILL 升级、
//   输出上限、跨平台 shell（cmd.exe vs /bin/sh）、可注入 spawn（便于测试）。
//   重写一遍意味着这些细节要重新验证一遍。
'use strict';

/** 验证结果的四种状态。顺序 = 从好到坏，便于排序与展示。 */
const VERIFY_STATES = Object.freeze(['passed', 'failed', 'skipped', 'not-verified']);

/** 默认期望退出码。 */
const DEFAULT_EXPECT_EXIT_CODE = 0;

/**
 * 检查依赖命令是否可用（只在需要时才检查，不做全局探测）。
 *
 * 用 `command -v` / `where` 而不是自己拼 PATH——那是 shell 的职责。
 *
 * @returns {Promise<{available:boolean, missing:string[]}>}
 */
async function checkCommands(commands, runner) {
  const missing = [];
  for (const cmd of commands) {
    // 只接受安全的命令名（不含空格/分号/管道）——避免把 manifest 变成任意命令执行。
    if (!/^[A-Za-z0-9._-]+$/.test(cmd)) {
      missing.push(cmd);
      continue;
    }
    const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    const r = await runner.run({ command: probe, cwd: process.cwd() });
    if (!r || r.exitCode !== 0) missing.push(cmd);
  }
  return { available: missing.length === 0, missing };
}

/**
 * 执行一个 Pack 的 verify。
 *
 * @param {object} manifest  已通过 validateManifest 的 manifest
 * @param {object} opts
 * @param {object} opts.runner  command-runner 实例
 * @param {string} opts.platform  当前平台（便于测试注入）
 * @param {string} [opts.cwd]     在哪个目录跑（通常是工作区）
 * @param {Function} [opts.onProgress]
 * @returns {Promise<{state:string, reason:string|null, exitCode:number|null, output:string, durationMs:number}>}
 */
async function runVerify(manifest, opts = {}) {
  const { runner, platform = process.platform, cwd = process.cwd() } = opts;
  if (!runner || typeof runner.run !== 'function') {
    return result('not-verified', 'no command runner provided', null, '', 0);
  }

  const verify = (manifest && manifest.verify) || {};
  const requires = (manifest && manifest.requires) || {};

  // ---- 1. 平台检查：不支持时明确拒绝，不是失败 ----
  const platforms = Array.isArray(requires.platforms) ? requires.platforms : [];
  if (!platforms.includes(platform)) {
    return result('skipped',
      `supports ${platforms.join(', ') || '(none)'}, not ${platform}`, null, '', 0);
  }

  // ---- 2. 依赖命令检查：缺了就 not-verified（不是 failed）----
  const commands = Array.isArray(requires.commands) ? requires.commands : [];
  if (commands.length > 0) {
    const dep = await checkCommands(commands, runner);
    if (!dep.available) {
      return result('not-verified', `missing command(s): ${dep.missing.join(', ')}`, null, '', 0);
    }
  }

  // ---- 3. 执行 verify 命令 ----
  if (typeof verify.command !== 'string' || verify.command.trim() === '') {
    return result('not-verified', 'verify.command is empty', null, '', 0);
  }
  const expected = Number.isInteger(verify.expectExitCode) ? verify.expectExitCode : DEFAULT_EXPECT_EXIT_CODE;
  const started = Date.now();
  const r = await runner.run({
    command: verify.command,
    cwd,
    ...(Number.isInteger(verify.timeoutMs) ? { timeoutMs: verify.timeoutMs } : {}),
  });
  const durationMs = Number.isFinite(r && r.durationMs) ? r.durationMs : (Date.now() - started);

  // ---- 4. 结果判定 ----
  if (!r || typeof r !== 'object') {
    return result('not-verified', 'runner returned nothing', null, '', durationMs);
  }
  if (r.timedOut) {
    return result('failed', `timed out after ${durationMs}ms`, r.exitCode ?? null, tail(r.output), durationMs);
  }
  const exitCode = Number.isInteger(r.exitCode) ? r.exitCode : null;
  if (exitCode === null) {
    // 没有退出码通常意味着进程没能启动（权限/不存在）
    return result('not-verified', r.code || 'command could not run', null, tail(r.output), durationMs);
  }
  if (exitCode !== expected) {
    return result('failed', `exit code ${exitCode}, expected ${expected}`, exitCode, tail(r.output), durationMs);
  }
  return result('passed', null, exitCode, tail(r.output), durationMs);
}

function result(state, reason, exitCode, output, durationMs) {
  return { state, reason: reason || null, exitCode, output: output || '', durationMs: durationMs || 0 };
}

/** 只保留输出尾部（完整输出可能很大，且我们只需要失败原因）。 */
function tail(text) {
  const s = typeof text === 'string' ? text : '';
  const MAX = 2000;
  return s.length <= MAX ? s : `…${s.slice(-MAX)}`;
}

module.exports = {
  VERIFY_STATES,
  DEFAULT_EXPECT_EXIT_CODE,
  checkCommands,
  runVerify,
};
