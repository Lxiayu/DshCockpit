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
const http = require('node:http');

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



// ---------------------------------------------------------------------------
// A1 step 3: the full spawn/restart/kill lifecycle (moved verbatim from
// main.js; every external symbol is an injected dependency). Behaviour is
// statement-for-statement identical to the pre-extraction implementation.
// ---------------------------------------------------------------------------

const HEALTH_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 4_000;
// Since dsh 0.1.2 the printed line is the AUTHENTICATED url: the web app appends
// its process launch token (`?token=<launchToken>`) and answers an index request
// carrying neither the token nor the session cookie with 401 (see
// dsh-client-connection: authenticatedUrl / authorizeIndex). Capture the whole
// token — the clean origin is derived from it. The optional " (LAN: …)" suffix is
// separated by a space, so \S+ never swallows it.
const URL_LINE_RE = /dsh web: (\S+)/;

/**
 * Split the runtime's printed URL into { authUrl, origin }.
 * The auth URL is what the BrowserWindow loads (the runtime mints its session
 * cookie and redirects to `/`) and what the health probe must hit; the clean
 * origin is what every /api + WS consumer keeps using. Returns null for
 * anything that is not a loopback http(s) URL.
 */
function parseRuntimeUrl(raw) {
  try {
    const url = new URL(String(raw || '').replace(/[),.]+$/, ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    return { authUrl: url.href, origin: url.origin };
  } catch {
    return null;
  }
}

/**
 * @param {object} deps — see main.js construction site for the annotated list.
 * Behaviour contract: pass-through of the pre-extraction logic with these
 * substitutions only: runtimeStateController→stateController,
 * activeDshBin()→resolveDshBin(), settings.effective()→effectiveSettings(),
 * remote.setRuntimeUrl→onRemoteUrl, mainWindow cluster→hasMainWindow/
 * onHealthy, events-feed trio→startEventsFeed/stopEventsFeed/
 * resetEventsFeedLiveFlag, credential-format probe→isCredentialFormatIssue +
 * upgradeDialog, runUpdateCheck/applyPendingUpdate pair→upgradeNow.
 */
function createRuntimeSupervisor(deps) {
  const {
    app, dialog,
    log = () => {},
    t, lang, appName,
    stateController,
    resolveDshBin, describeDshBin, nodeCandidates, effectiveSettings,
    selfHealProfile, ensureLogDir, resolveNodeBin,
    onRemoteUrl = () => {},
    startEventsFeed = () => {}, stopEventsFeed = () => {}, resetEventsFeedLiveFlag = () => {},
    onHealthy = () => {}, hasMainWindow = () => false,
    isQuitting = () => false,
    recordCrash = () => {}, enterSafeMode = () => {},
    upgradeDialog = () => {}, isCredentialFormatIssue = () => false,
    bootTimingFile = null, // () => path — A3 boot baselines land here
    notify,
    envExtras = () => null, // () => object — v0.3.1: MCP secret env vars ride the runtime child env
  } = deps;

  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createRuntimeLogTailer } = require('./runtime-log-tail');

  let runtimeChild = null;
  let runtimeUrl = null;
  let runtimeAuthUrl = null; // token-carrying URL (page loads + health probe only)
  let runtimeLogPath = null;
  let urlPollTimer = null;
  const crashGuard = createCrashLoopGuard(); // healthy boot resets; 4th crash in 60s trips safe-mode

  function getRuntimeUrl() { return runtimeUrl; }
  function getRuntimeAuthUrl() { return runtimeAuthUrl; }
  function getRuntimeLogPath() { return runtimeLogPath; }

  function waitForHealth(url, timeoutMs = HEALTH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      const tick = () => {
        if (Date.now() > deadline) return finish(false);
        const req = http.get(url, (res) => {
          res.resume();
          // 200 = app served; 3xx = the browser-auth exchange answering the token
          // URL with its cookie-minting redirect (dsh 0.1.2+).
          if (res.statusCode === 200 || (res.statusCode >= 300 && res.statusCode < 400)) return finish(true);
          retry();
        });
        // H4: a server that accepts but never responds must not hang forever
        req.setTimeout(3000, () => { try { req.destroy(); } catch { /* ignore */ } retry(); });
        req.on('error', retry);
        function retry() {
          if (Date.now() > deadline) return finish(false);
          setTimeout(tick, 500);
        }
      };
      tick();
    });
  }

  function spawnRuntime() {
    const generation = stateController.begin('starting');
    // A3: boot timing baselines (spawn -> URL -> healthy) persisted to
    // userData/diagnostics/boot-timing.json so regressions have numbers.
    const bootTiming = { spawnAt: new Date().toISOString(), urlMs: null, healthyMs: null, url: null };
    const spawnT0 = Date.now();
    const dshBin = resolveDshBin();
    if (!dshBin) {
      dialog.showErrorBox(appName, t(lang(), 'dialog.noRuntime'));
      app.quit();
      return null;
    }
    const meta = describeDshBin(dshBin);
    const eff = effectiveSettings();
    const port = eff.port || 0;
    const dshHome = eff.dshHome || path.join(os.homedir(), '.dsh');
    const cwd = eff.workspace || os.homedir();

    selfHealProfile();

    try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* best effort */ }

    // The Harness web profile opens the system browser by default. DshCockpit
    // owns the desktop surface, so keep that handoff disabled and load the same
    // runtime URL in the Electron BrowserWindow below.
    const args = [dshBin, '--profile', 'web', '--port', String(port), '--no-open'];
    const candidates = nodeCandidates();

    // Runtime stdout/stderr go straight into a file via an fd (no pipes; the URL
    // line is discovered by tailing this file). Pipe capture is more fragile and
    // is blocked by the harness sandbox; see DESIGN.md §7.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    runtimeLogPath = path.join(ensureLogDir(), `runtime-${stamp}.out`);
    let outFd = -1;
    try { outFd = fs.openSync(runtimeLogPath, 'a'); } catch (err) { log(`[shell] cannot open runtime log: ${err.message}`); }

    log(`[shell] dsh bin:  ${dshBin}${meta && meta.version ? ` (v${meta.version})` : ''}`);
    log(`[shell] args:     ${args.slice(1).join(' ')}`);
    log(`[shell] DSH_HOME: ${dshHome}`);
    log(`[shell] cwd:      ${cwd}`);
    log(`[shell] runtime log: ${runtimeLogPath}`);

    // Tail the runtime log for the URL line (started once; survives retries).
    // Byte-offset bookkeeping lives in runtime-log-tail.js (unit tested).
    if (urlPollTimer) clearInterval(urlPollTimer);
    const urlTail = createRuntimeLogTailer(runtimeLogPath);
    let lastLogText = '';
    urlPollTimer = setInterval(() => {
      if (runtimeUrl) { clearInterval(urlPollTimer); urlPollTimer = null; return; }
      // never throws; '' when the log has not grown / is not readable yet
      const appended = urlTail.poll();
      if (appended) lastLogText += appended;
      const m = lastLogText.match(URL_LINE_RE);
      if (m) {
        if (!stateController.isCurrent(generation)) return;
        const parsed = parseRuntimeUrl(m[1]);
        if (!parsed) return; // unexpected line shape: keep tailing
        runtimeUrl = parsed.origin;
        runtimeAuthUrl = parsed.authUrl;
        clearTimeout(urlWatchdogTimer);
        crashGuard.reset(); // a healthy boot resets the auto-restart counter
        bootTiming.urlMs = Date.now() - spawnT0;
        bootTiming.url = runtimeUrl;
        log(`[shell] runtime URL: ${runtimeUrl}${runtimeAuthUrl === runtimeUrl ? '' : ' (authenticated)'}`);
        onRemoteUrl(runtimeAuthUrl); // gateway exchanges the token for the runtime cookie
        const bootUrl = runtimeAuthUrl;
        waitForHealth(bootUrl).then((ok) => {
          if (!stateController.isCurrent(generation) || runtimeAuthUrl !== bootUrl) return;
          if (!ok) {
            stateController.transition('offline', generation);
            return;
          }
          stateController.transition('healthy', generation);
          bootTiming.healthyMs = Date.now() - spawnT0;
          if (bootTimingFile) {
            try {
              fs.mkdirSync(path.dirname(bootTimingFile()), { recursive: true });
              fs.writeFileSync(bootTimingFile(), JSON.stringify(bootTiming, null, 2));
            } catch (err) { log(`[shell] boot timing write failed: ${err.message}`); }
          }
          log(`[perf] boot: URL in ${bootTiming.urlMs}ms, healthy in ${bootTiming.healthyMs}ms`);
          startEventsFeed();
          onHealthy(bootUrl);
        });
      }
    }, 500);

    // H5: when the log tail matches the credential-format signature, replace
    // the bare code/signal error with a root-cause dialog that offers the
    // standard update pipeline (check → install → smoke → activate → restart).
    const showCredentialUpgradeDialog = (message) => {
      log('[shell] credential format mismatch detected in runtime log');
      dialog.showMessageBox({
        type: 'error',
        title: appName,
        message: t(lang(), 'crash.credFormat.title'),
        detail: `${t(lang(), 'crash.credFormat.body')}\n\n${message}`,
        buttons: [t(lang(), 'crash.credFormat.upgradeNow'), t(lang(), 'crash.credFormat.later')],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response !== 0) { if (!hasMainWindow()) app.quit(); return; }
        deps.upgradeNow()
          .then((report) => {
            if (!report || !report.ok) return; // failure already surfaced by the pipeline
            return deps.applyPendingUpdate().catch((err) => notify(t(lang(), 'notify.applyFailed'), err.message));
          })
          .catch(() => { /* pipeline already notified */ });
      }).catch(() => { /* dialog failed — fall back to nothing */ });
    };

    const fail = (message) => {
      stateController.transition('offline', generation);
      if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; }
      clearTimeout(urlWatchdogTimer);
      if (outFd !== -1) { try { fs.closeSync(outFd); } catch { /* ignore */ } outFd = -1; }
      // pure display-layer enhancement: no signature → behave exactly as before
      if (isCredentialFormatIssue(runtimeLogPath)) {
        showCredentialUpgradeDialog(message);
        return;
      }
      if (!hasMainWindow()) {
        // boot-time failure: nothing to fall back to
        dialog.showErrorBox(appName, message);
        app.quit();
      } else {
        // runtime failure while the app is up: keep the shell alive (M8)
        dialog.showErrorBox(appName, message);
        notify(t(lang(), 'notify.runtimeExited'), message);
      }
    };

    // Boot watchdog: if the URL line never appears (slow machine, unexpected
    // runtime output format, …) the boot window must not spin silently forever
    // — surface a one-shot pointer to the log so the user can act. Cleared as
    // soon as the URL is found or this spawn generation ends.
    const BOOT_URL_WATCHDOG_MS = 8 * 60_000;
    let urlWatchdogTimer = setTimeout(() => {
      if (runtimeUrl || isQuitting() || !stateController.isCurrent(generation)) return;
      log('[shell] boot watchdog: no URL line after ' + Math.round(BOOT_URL_WATCHDOG_MS / 1000) + 's');
      notify(
        t(lang(), 'notify.bootUrlTimeout'),
        t(lang(), 'notify.bootUrlTimeoutBody', { min: Math.round(BOOT_URL_WATCHDOG_MS / 60_000), log: runtimeLogPath })
      );
    }, BOOT_URL_WATCHDOG_MS);

    let attempt = 0;
    let retrying = false;
    const launch = () => {
      const cand = candidates[Math.min(attempt, candidates.length - 1)];
      attempt += 1;
      retrying = false;
      log(`[shell] node attempt ${attempt}/${candidates.length}: ${cand.bin}${cand.runAsNode ? ' (electron-as-node)' : ''}`);
      const env = { ...process.env, DSH_HOME: dshHome };
      if (cand.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
      // v0.3.1 MCP: vault-decrypted secret env vars reach DSH-spawned MCP
      // servers via process inheritance — cordis.patch.yml stays plaintext-free
      const mcpEnv = envExtras();
      if (mcpEnv && typeof mcpEnv === 'object') Object.assign(env, mcpEnv);

      let child;
      try {
        child = spawn(cand.bin, args, {
          env,
          cwd,
          windowsHide: true,
          stdio: outFd === -1 ? 'ignore' : ['ignore', outFd, outFd],
        });
      } catch (err) {
        fail(t(lang(), 'dialog.spawnFailed', { msg: err.message }));
        return;
      }

      child.on('error', (err) => {
        log(`[runtime] spawn error: ${err.message}`);
        if (err && err.code === 'ENOENT' && attempt < candidates.length) {
          retrying = true;
          log('[shell] retrying with next node candidate');
          launch();
          return;
        }
        stateController.transition('offline', generation);
        fail(t(lang(), 'dialog.spawnFailed', { msg: err.message }));
      });
      child.on('close', (code, signal) => {
        const wasCurrent = runtimeChild === child;
        if (wasCurrent) runtimeChild = null;
        // close the runtime log fd regardless (H2: fd leak)
        if (outFd !== -1) { try { fs.closeSync(outFd); } catch { /* ignore */ } outFd = -1; }
        log(`[runtime] exited code=${code} signal=${signal}${wasCurrent ? '' : ' (superseded by restart)'}`);
        // A superseded child (killed by restart/update/rollback/workspace switch)
        // must NOT touch the NEW child's poller or state (H1).
        if (!wasCurrent || isQuitting() || retrying) return;
        runtimeUrl = null;
        runtimeAuthUrl = null;
        onRemoteUrl(null);
        stateController.transition('offline', generation);
        if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; }
        if (!hasMainWindow()) {
          fail(t(lang(), 'dialog.runtimeDied', { code, signal, path: runtimeLogPath }));
          return;
        }
        // crash guard: auto-restart with loop protection (max 3 in 60s);
        // a clean exit (code 0) or a manual restart is not a crash (M9)
        if (code !== 0) recordCrash(code, signal);
        // A1: every unexpected exit advances the rolling guard (legacy M9
        // semantics — a clean exit is not written to crash diagnostics but it
        // still consumes an auto-restart slot), keeping behaviour identical.
        const verdict = crashGuard.record();
        if (verdict.restart) {
          notify(t(lang(), 'notify.runtimeExited'), t(lang(), 'notify.autoRestart', { code, signal, attempt: verdict.attempt }));
          setTimeout(restartRuntime, 1_500);
        } else {
          // crash loop: the runtime cannot boot — most likely a broken plugin.
          // Offer safe mode (official bundles only) right here instead of a bare
          // "gave up" notification the user cannot act on.
          notify(t(lang(), 'notify.runtimeExited'), t(lang(), 'notify.autoRestartStopped', { code, signal }));
          dialog.showMessageBox({
            type: 'error',
            title: appName,
            message: t(lang(), 'crashloop.title'),
            detail: t(lang(), 'crashloop.body', { log: runtimeLogPath }),
            buttons: [t(lang(), 'crashloop.safeMode'), t(lang(), 'crashloop.later')],
            defaultId: 0,
            cancelId: 1,
          }).then(({ response }) => {
            if (response === 0) enterSafeMode();
          }).catch(() => { /* dialog failed — notifications already sent */ });
        }
      });

      runtimeChild = child;
      try {
        armWatchdog({ node: resolveNodeBin(), shellPid: process.pid, runtimePid: child.pid, log });
      } catch { /* ignore */ }
    };

    launch();
    return runtimeChild;
  }

  function restartRuntime() {
    log('[shell] restart requested');
    stateController.begin('restarting');
    stopEventsFeed();
    resetEventsFeedLiveFlag();
    if (runtimeChild) { runtimeChild.kill(); runtimeChild = null; }
    runtimeUrl = null;
    runtimeAuthUrl = null;
    onRemoteUrl(null); // gateway answers 503 until the new URL arrives
    spawnRuntime();
  }

  function killRuntime() {
    onRemoteUrl(null);
    if (!runtimeChild || runtimeChild.killed) return;
    stopEventsFeed();
    const child = runtimeChild;
    try { child.kill(); } catch { /* ignore */ }
    const start = Date.now();
    const wait = setInterval(() => {
      if (child.exitCode !== null || Date.now() - start > KILL_GRACE_MS) {
        clearInterval(wait);
        if (child.exitCode === null) {
          log('[shell] runtime did not exit in time, forcing kill');
          if (process.platform === 'win32') {
            const { execFileSync } = require('node:child_process');
            try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
          } else {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }
      }
    }, 200);
  }

  function getRuntimeChild() { return runtimeChild; }

  return { spawnRuntime, restartRuntime, killRuntime, getRuntimeUrl, getRuntimeAuthUrl, getRuntimeLogPath, getRuntimeChild };
}

module.exports = {
  createCrashLoopGuard,
  killTree,
  armWatchdog,
  createRuntimeSupervisor,
  parseRuntimeUrl,
  URL_LINE_RE,
  CRASH_WINDOW_MS,
  MAX_CRASHES,
};
