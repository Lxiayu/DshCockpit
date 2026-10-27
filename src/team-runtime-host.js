'use strict';

// src/team-runtime-host.js — 为工作区跑一个**专用** dsh runtime（v0.7 P2）。
//
// 为什么需要它：dsh 官方语义是"进程启动目录 = workspace 根"（README:20），没有
// 按会话切换 cwd 的接口。团队的 worker 要真正读写工作区，就必须让执行链跑在一个
// cwd = 任务工作区的 runtime 上；而主 harness runtime 的 cwd 是用户自己的 workspace，
// 不能为了团队重启/改道（会打断用户正在用的会话）。
//
// 隔离：
//   - 独立进程、独立端口、独立 token/cookie/mux；共享 DSH_HOME（会话按 cwd 分目录存放）；
//   - 只在有工作任务时存在；任务结束后按 idleStopMs 自动停掉；
//   - 不与主 runtime 共用 auth/mux/rpc 闭包（各自的 cookie 与流）。
//
// 可测性：spawn / health / auth / mux / rpc 全部可注入；默认实现才碰真实进程与网络。

const defaultSpawn = require('node:child_process').spawn;
const http = require('node:http');
const fs = require('node:fs');

const { parseRuntimeUrl, URL_LINE_RE, armWatchdog } = require('./runtime-supervisor.js');
const { createRuntimeAuth } = require('./runtime-auth.js');
const { createRuntimeMux } = require('./runtime-mux.js');
const { createHarnessRpcWire } = require('./harness-rpc.js');

const START_TIMEOUT_MS = 60_000;
const HEALTH_RETRY_MS = 500;
const KILL_GRACE_MS = 4_000;
const IDLE_STOP_MS = 60_000;
const LOG_TAIL_LINES = 40;

function codeError(code, message) {
  return Object.assign(new Error(message ? `${code}: ${message}` : code), { code });
}

function defaultHealth(authUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const tick = () => {
      if (Date.now() > deadline) return finish(false);
      const req = http.get(authUrl, (res) => {
        res.resume();
        if (res.statusCode === 200 || (res.statusCode >= 300 && res.statusCode < 400)) return finish(true);
        retry();
      });
      req.setTimeout(3000, () => { try { req.destroy(); } catch { /* ignore */ } retry(); });
      req.on('error', retry);
      function retry() {
        if (Date.now() > deadline) return finish(false);
        setTimeout(tick, HEALTH_RETRY_MS);
      }
    };
    tick();
  });
}

/**
 * @param {object} deps
 * @param {() => string} deps.dshBin   dsh bin.js 的绝对路径（延迟解析）
 * @param {() => {bin: string, runAsNode?: boolean}} deps.nodeBin
 * @param {() => string} deps.dshHome
 * @param {(message: string) => void} [deps.log]
 * @param {() => object|null} [deps.envExtras]  MCP secrets 等额外环境变量
 * @param {Function} [deps.spawnImpl]
 * @param {(authUrl: string, deadlineMs: number) => Promise<boolean>} [deps.healthImpl]
 * @param {Function} [deps.createAuth]
 * @param {Function} [deps.createMux]
 * @param {Function} [deps.createRpc]
 * @param {number} [deps.startTimeoutMs]
 * @param {number} [deps.idleStopMs]
 */
function createTeamRuntimeHost({
  dshBin,
  nodeBin,
  dshHome,
  log = () => {},
  envExtras = () => null,
  spawnImpl = defaultSpawn,
  healthImpl = defaultHealth,
  createAuth = createRuntimeAuth,
  createMux = createRuntimeMux,
  createRpc = createHarnessRpcWire,
  armWatchdogImpl = armWatchdog,
  startTimeoutMs = START_TIMEOUT_MS,
  idleStopMs = IDLE_STOP_MS,
} = {}) {
  let current = null;   // { workspace, child, origin, authUrl, auth, mux, rpc, ready, exiting }
  let starting = null;  // { workspace, promise }

  function tailPush(tail, line) {
    const text = String(line || '').trim();
    if (!text) return;
    tail.push(text);
    while (tail.length > LOG_TAIL_LINES) tail.shift();
  }

  function killChild(instance) {
    const child = instance && instance.child;
    if (!child || instance.exiting) return;
    instance.exiting = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, KILL_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopInstance(instance, reason) {
    if (!instance) return;
    if (instance.idleTimer) { clearTimeout(instance.idleTimer); instance.idleTimer = null; }
    try { if (instance.mux && typeof instance.mux.close === 'function') instance.mux.close(); } catch { /* ignore */ }
    killChild(instance);
    if (current === instance) current = null;
    log(`[team-runtime] stopped (${reason})`);
  }

  function startFor(workspace) {
    const bin = dshBin();
    const node = nodeBin();
    if (typeof bin !== 'string' || bin === '') {
      throw codeError('TEAM_RUNTIME_BIN_MISSING');
    }
    try { fs.mkdirSync(workspace, { recursive: true }); } catch { /* validated earlier; best effort */ }
    const env = { ...process.env, DSH_HOME: dshHome() };
    const extras = envExtras();
    if (extras && typeof extras === 'object') Object.assign(env, extras);
    const args = [bin, '--profile', 'web', '--port', '0', '--no-open'];
    log(`[team-runtime] spawn (cwd=${workspace})`);

    return new Promise((resolve, reject) => {
      const instance = {
        workspace, child: null, origin: null, authUrl: null,
        auth: null, mux: null, rpc: null, ready: false, exiting: false, idleTimer: null,
      };
      const tail = [];
      let settled = false;
      const settleOk = (value) => { if (!settled) { settled = true; clearTimeout(startTimer); resolve(value); } };
      const settleErr = (error) => { if (!settled) { settled = true; clearTimeout(startTimer); reject(error); } };

      let child;
      try {
        child = spawnImpl(node.bin, args, {
          cwd: workspace,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(codeError('TEAM_RUNTIME_SPAWN_FAILED', error && error.message));
        return;
      }
      instance.child = child;
      current = instance;
      // The shell may be killed without firing will-quit (SIGTERM/force quit);
      // arm the same watchdog the main runtime uses so no orphan dsh survives.
      if (child.pid) {
        try { armWatchdogImpl({ node, shellPid: process.pid, runtimePid: child.pid, log }); } catch { /* best effort */ }
      }

      const onLine = (line) => {
        tailPush(tail, line);
        if (instance.authUrl) return;
        const match = String(line).match(URL_LINE_RE);
        if (!match) return;
        const parsed = parseRuntimeUrl(match[1]);
        if (!parsed) return;
        instance.origin = parsed.origin;
        instance.authUrl = parsed.authUrl;
        healthImpl(parsed.authUrl, startTimeoutMs).then((healthy) => {
          if (!healthy) {
            // settle first: killing the child emits 'exit' synchronously in tests
            // (and racy-fast in production) — the honest code is UNHEALTHY.
            settleErr(codeError('TEAM_RUNTIME_UNHEALTHY', tail.slice(-5).join(' | ')));
            stopInstance(instance, 'health-timeout');
            return;
          }
          const auth = createAuth({ log });
          auth.setAuthUrl(parsed.authUrl);
          const mux = createMux({ baseUrl: parsed.origin, auth, log });
          // runtime-mux 是显式连接（与主 feed 同一约定）：不 connect 就永远 ready 不了。
          if (mux && typeof mux.connect === 'function') mux.connect();
          const rpc = createRpc(parsed.origin, { protocol: 'slash', mux, auth });
          instance.auth = auth;
          instance.mux = mux;
          instance.rpc = rpc;
          instance.ready = true;
          log(`[team-runtime] ready at ${parsed.origin} (workspace-rooted)`);
          settleOk(Object.freeze({
            workspace,
            origin: parsed.origin,
            authUrl: parsed.authUrl,
            auth,
            mux,
            rpc,
          }));
        }).catch((error) => {
          settleErr(codeError('TEAM_RUNTIME_UNHEALTHY', error && error.message));
          stopInstance(instance, 'health-error');
        });
      };

      const startTimer = setTimeout(() => {
        settleErr(codeError('TEAM_RUNTIME_START_TIMEOUT'));
        stopInstance(instance, 'start-timeout');
      }, startTimeoutMs);

      if (child.stdout && typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
      if (child.stderr && typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) onLine(line);
        });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          for (const line of String(chunk).split(/\r?\n/)) tailPush(tail, line);
        });
      }
      child.on && child.on('error', (error) => {
        settleErr(codeError('TEAM_RUNTIME_SPAWN_FAILED', error && error.message));
      });
      child.on && child.on('exit', (code, signal) => {
        if (current === instance) current = null;
        instance.ready = false;
        if (!settled) {
          settleErr(codeError('TEAM_RUNTIME_EXITED', `code=${code} signal=${signal} ${tail.slice(-5).join(' | ')}`));
        } else {
          log(`[team-runtime] exited (code=${code} signal=${signal})`);
        }
      });
    });
  }

  /** 确保有一个 cwd = workspace 的 runtime；同工作区复用，不同工作区先停旧的。 */
  async function ensure(workspace) {
    if (typeof workspace !== 'string' || workspace === '') {
      throw codeError('TEAM_RUNTIME_WORKSPACE_REQUIRED');
    }
    if (current && current.ready && current.workspace === workspace) {
      if (current.idleTimer) { clearTimeout(current.idleTimer); current.idleTimer = null; }
      return current.publicValue || Object.freeze({
        workspace: current.workspace, origin: current.origin, authUrl: current.authUrl,
        auth: current.auth, mux: current.mux, rpc: current.rpc,
      });
    }
    if (starting) {
      if (starting.workspace === workspace) return starting.promise;
      await starting.promise.catch(() => {});
    }
    if (current) stopInstance(current, 'workspace-switch');
    const promise = startFor(workspace).then((value) => {
      if (current) current.publicValue = value;
      return value;
    }).finally(() => { starting = null; });
    starting = { workspace, promise };
    return promise;
  }

  /** 任务结束后调用：空闲一段时间自动停掉专用 runtime。 */
  function scheduleIdleStop() {
    const instance = current;
    if (!instance || !instance.ready) return;
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    instance.idleTimer = setTimeout(() => {
      if (current === instance) stopInstance(instance, 'idle');
    }, idleStopMs);
    if (typeof instance.idleTimer.unref === 'function') instance.idleTimer.unref();
  }

  function stop(reason = 'quit') {
    if (starting) { /* a pending start will settle/fail on its own; stop current below */ }
    if (current) stopInstance(current, reason);
    starting = null;
  }

  return Object.freeze({
    ensure,
    scheduleIdleStop,
    stop,
    status: () => Object.freeze({
      ready: !!(current && current.ready),
      workspace: current ? current.workspace : null,
      origin: current ? current.origin : null,
    }),
  });
}

module.exports = { createTeamRuntimeHost };
