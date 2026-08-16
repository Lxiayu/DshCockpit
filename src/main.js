// src/main.js — DshCockpit shell (stage 2: shell settings UI + update pipeline)
//
// Responsibilities:
//   - single-instance lock, tray resident, settings window
//   - SettingsStore (settings.json) + RuntimeManager (runtime-state.json)
//   - spawn the active dsh runtime (`--profile web --port 0`), parse the URL
//     line from an fd-logged file, health-check, open/refresh the window
//   - update pipeline: registry check -> install via arborist -> smoke test ->
//     pending -> apply (live runtime switch) / rollback (with DSH_HOME snapshot)
//   - crash guard: notify + restart when the runtime exits unexpectedly
//
// Env overrides (win over settings; documented in README.md):
//   DSH_DESKTOP_DSH_BIN / DSH_DESKTOP_NODE_BIN / DSH_DESKTOP_DSH_HOME /
//   DSH_DESKTOP_WORKSPACE / DSH_DESKTOP_PORT / DSH_DESKTOP_NO_TRAY /
//   DSH_DESKTOP_USER_DATA
'use strict';

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, Notification, shell, screen, globalShortcut, safeStorage } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const { SettingsStore } = require('./settings-store');
const { RuntimeManager } = require('./runtime-manager');
const { t, resolveLanguage } = require('./i18n');
const { backupNow, backupInfo } = require('./backup');
const tokenStats = require('./token-stats');
const windowState = require('./window-state');
const { connectEvents } = require('./runtime-events');
const cost = require('./cost');
const { runHeadless } = require('./headless');
const { Scheduler } = require('./scheduler');
const { searchSessions } = require('./session-search');
const { RemoteControl } = require('./remote-control');

if (process.env.DSH_DESKTOP_USER_DATA) {
  // must happen before app is ready; keeps logs/state inside the workspace
  try { app.setPath('userData', process.env.DSH_DESKTOP_USER_DATA); } catch { /* ignore */ }
}

const APP_NAME = 'DshCockpit';
const APP_VERSION = require('../package.json').version;
const URL_LINE_RE = /dsh web: (https?:\/\/127\.0\.0\.1:\d+)/;
const HEALTH_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 4_000;

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let runtimeChild = null;
let runtimeUrl = null;
let quitting = false;
let logStream = null;
let runtimeLogPath = null;
let urlPollTimer = null;
let updateInFlight = false;
let tokenWidgetLogged = false;
let crashCount = 0;
let lastCrashAt = 0;
let eventsFeed = [];
let eventsRetryTimer = null;
let lastTaskNotifyAt = 0;
let eventsFeedLiveLogged = false;
let windowStateSaveTimer = null;
let lastCostUpdateAt = 0;
let quickAskWindow = null;
let quickAskRunning = false;
let searchWindow = null;
let scheduler = null;
let remote = null; // phone remote-control gateway (constructed after app ready)
let loadingWindow = null;
let pluginMarketWindow = null;
let guidedInstallInProgress = false;
let mainWindowPending = false; // guided first-run: runtime booting, main window not open yet
const scheduledRunning = new Set();
const budgetNotified = new Set();
const materializing = new Set();

const settings = new SettingsStore(app.getPath('userData'));
const noTray = process.env.DSH_DESKTOP_NO_TRAY === '1';
const lang = () => resolveLanguage(settings.get().language);
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const dshHomeOf = () => settings.effective().dshHome || path.join(os.homedir(), '.dsh');
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const costHistoryFile = () => path.join(app.getPath('userData'), 'cost-history.json');
const diagnosticsDir = () => path.join(app.getPath('userData'), 'diagnostics');
const TOKEN_POLL_MS = 5_000;

const manager = new RuntimeManager({
  userDataDir: app.getPath('userData'),
  settings,
  log: (line) => log(line),
  resolveNodeBin: () => bestNodeBin(),
});

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
function ensureLogDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(ensureLogDir(), `runtime-${stamp}.log`);
  logStream = fs.createWriteStream(file, { flags: 'a' });
  pruneLogs();
  log(`[shell] log file: ${file}`);
}

/** Rotate old shell/runtime logs: keep the newest N of each kind. */
function pruneLogs(keep = 10) {
  try {
    const dir = ensureLogDir();
    const files = fs.readdirSync(dir)
      .map((n) => {
        const p = path.join(dir, n);
        let m = 0;
        try { m = fs.statSync(p).mtimeMs; } catch { /* ignore */ }
        return { n, p, m };
      })
      .filter((f) => /^(runtime|plugin|headless)-\d{4}-\d{2}-\d{2}T.*\.(log|out)$/.test(f.n))
      .sort((a, b) => b.m - a.m);
    const groups = new Map();
    for (const f of files) {
      const ext = f.n.endsWith('.out') ? 'out' : 'log';
      if (!groups.has(ext)) groups.set(ext, []);
      groups.get(ext).push(f);
    }
    for (const list of groups.values()) {
      for (const f of list.slice(keep)) {
        try { fs.rmSync(f.p, { force: true }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function log(line) {
  const ts = new Date().toISOString();
  const msg = `${ts} ${line}`;
  console.log(msg);
  // guard against write-after-end (app quitting while async boot code still logs)
  if (logStream && !logStream.writableEnded) logStream.write(msg + '\n');
}

function notify(title, body) {
  if (Notification.isSupported()) {
    try { new Notification({ title, body }).show(); } catch { /* ignore */ }
  }
  log(`[shell] notify: ${title} — ${body}`);
}

// ---------------------------------------------------------------------------
// binary resolution
// ---------------------------------------------------------------------------
function firstLineOf(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true });
    const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return line || null;
  } catch {
    return null;
  }
}

// Module-level cache for the system node lookup. On Windows each `where.exe`
// spawn is ~50-200ms (AV overhead) and these are called on every runtime
// spawn, quick-ask, scheduled task and plugin run (perf P3). The cache is
// keyed by the configured nodeBin (empty string when unset) and invalidated
// only when settings change — which in practice means "resolve once per boot".
let _nodeBinCache = null;
let _nodeCandidatesCache = null;
let _nodeLookupKey = undefined;

function _resolveNodeFromPath() {
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const fromPath = firstLineOf(whereCmd, ['node']);
  if (!fromPath) return null;
  if (!fs.existsSync(fromPath)) return null;
  try { return fs.realpathSync(fromPath); } catch { return fromPath; }
}

/** Best system node; falls back to Electron's bundled node (production path). */
function bestNodeBin() {
  const key = settings.effective().nodeBin || '';
  if (_nodeLookupKey !== key) { _nodeLookupKey = key; _nodeBinCache = null; _nodeCandidatesCache = null; }
  if (_nodeBinCache) return _nodeBinCache;
  if (key) { _nodeBinCache = { bin: key, runAsNode: false }; return _nodeBinCache; }
  const resolved = _resolveNodeFromPath();
  _nodeBinCache = resolved ? { bin: resolved, runAsNode: false } : { bin: process.execPath, runAsNode: true };
  return _nodeBinCache;
}

/** All node candidates, most robust first. */
function nodeCandidates() {
  const key = settings.effective().nodeBin || '';
  if (_nodeLookupKey !== key) { _nodeLookupKey = key; _nodeBinCache = null; _nodeCandidatesCache = null; }
  if (_nodeCandidatesCache) return _nodeCandidatesCache;
  const list = [];
  const push = (bin, runAsNode) => {
    if (bin && !list.some((c) => c.bin === bin && c.runAsNode === runAsNode)) list.push({ bin, runAsNode });
  };
  if (key) {
    push(key, false);
  } else {
    const resolved = _resolveNodeFromPath();
    if (resolved) push(resolved, false);
    push(process.execPath, true);
  }
  _nodeCandidatesCache = list;
  return list;
}

/** Resolve dsh's lib/bin.js from PATH shim (used to bootstrap the runtime registry). */
function discoverDshBin() {
  if (process.env.DSH_DESKTOP_DSH_BIN && fs.existsSync(process.env.DSH_DESKTOP_DSH_BIN)) {
    return process.env.DSH_DESKTOP_DSH_BIN;
  }
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const shim = firstLineOf(whereCmd, ['dsh']);
  if (shim) {
    const binDir = path.dirname(shim);
    const installRoot = path.dirname(binDir); // node_modules
    const candidate = path.join(installRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(candidate)) return candidate;
    const candidate2 = path.join(path.dirname(installRoot), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(candidate2)) return candidate2;
  }
  return null;
}

/** bin.js -> { installRoot, pkgDir, version } or null. */
function dshBinMeta(binJs) {
  if (!binJs) return null;
  const m = String(binJs).match(/^(.*[\\/])node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
  if (!m) return null;
  const installRoot = m[1].replace(/[\\/]$/, '');
  const pkgDir = path.join(installRoot, 'node_modules', '@deepseek-ai', 'dsh');
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  return { installRoot, pkgDir, version };
}

/**
 * Make sure a runtime version is registered. Order: existing entry -> bundled
 * seed (installer, instant) -> discovered install (npx/global). Then kicks off
 * background materialization so the app never depends on ephemeral paths.
 */
function ensureRuntimeRegistered() {
  manager.revalidate(); // drop entries pointing at moved/deleted installs
  const info = manager.getInfo();
  if (info.activeVersion && manager.entry(info.activeVersion)) {
    registerBundledRuntime(); // prefer the bundle when present (managed wins inside entry())
    materializeIfNeeded();
    return true;
  }
  // nothing active: bundled seed first (instant), then discovered install
  if (registerBundledRuntime()) {
    materializeIfNeeded();
    return true;
  }
  const binJs = discoverDshBin();
  const meta = dshBinMeta(binJs);
  if (!meta) {
    log('[shell] no dsh runtime found to bootstrap');
    return false;
  }
  const version = meta.version || 'unknown';
  log(`[shell] bootstrap runtime ${version} from ${meta.installRoot}`);
  manager.bootstrapFrom(meta.installRoot, version);
  materializeIfNeeded();
  return true;
}

/** Make the active runtime owned (managed dir or bundled seed) in the background. */
async function materializeIfNeeded() {
  const info = manager.getInfo();
  const active = info.activeVersion ? manager.entry(info.activeVersion) : null;
  if (!active || active.source === 'managed' || active.source === 'bundled' || materializing.has(active.version)) return;
  materializing.add(active.version);
  try {
    // prefer the bundled seed: instant, no registry download, no copy
    const bundle = findBundledRuntime();
    if (bundle && bundle.version === active.version) {
      registerBundledRuntime();
      log(`[shell] runtime ${active.version} served from bundled seed`);
      updateTray();
      return;
    }
    log(`[shell] materializing runtime ${active.version} into managed dir (background, registry)`);
    const entry = await manager.installVersion(active.version);
    const smoke = await manager.smokeTest(entry);
    if (!smoke.ok) {
      if (!manager.state.broken.includes(active.version)) manager.state.broken.push(active.version);
      manager.state.knownIssues[active.version] = smoke.reason || `smoke failed (exit ${smoke.exitCode})`;
      manager.saveState();
      log(`[shell] materialized copy failed smoke; keeping bootstrap fallback: ${smoke.reason}`);
      return;
    }
    log(`[shell] runtime ${active.version} materialized -> ${entry.path} (next launch uses it)`);
    updateTray();
  } catch (err) {
    log(`[shell] materialize failed (keeping bootstrap fallback): ${err.message}`);
  } finally {
    materializing.delete(active.version);
  }
}

// ---------------------------------------------------------------------------
// runtime child
// ---------------------------------------------------------------------------
function activeDshBin() {
  const info = manager.getInfo();
  const entry = info.activeVersion ? manager.entry(info.activeVersion) : null;
  if (entry) {
    const binJs = path.join(entry.path, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(binJs)) return binJs;
  }
  return discoverDshBin();
}

function spawnRuntime() {
  const dshBin = activeDshBin();
  if (!dshBin) {
    dialog.showErrorBox(APP_NAME, t(lang(), 'dialog.noRuntime'));
    app.quit();
    return null;
  }
  const meta = dshBinMeta(dshBin);
  const eff = settings.effective();
  const port = eff.port || 0;
  const dshHome = eff.dshHome || path.join(os.homedir(), '.dsh');
  const cwd = eff.workspace || os.homedir();

  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* best effort */ }

  const args = [dshBin, '--profile', 'web', '--port', String(port)];
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
  // Skip the readFileSync when the file has not grown since the last poll
  // (perf #8): on slow disks / long runtimes this avoids re-reading a
  // multi-MB file every 500ms during the boot window.
  if (urlPollTimer) clearInterval(urlPollTimer);
  let lastLogSize = -1;
  let lastLogText = '';
  urlPollTimer = setInterval(() => {
    if (runtimeUrl) { clearInterval(urlPollTimer); urlPollTimer = null; return; }
    let st;
    try { st = fs.statSync(runtimeLogPath); } catch { return; }
    if (st.size === lastLogSize) return; // no new bytes since last poll
    lastLogSize = st.size;
    try { lastLogText = fs.readFileSync(runtimeLogPath, 'utf8'); } catch { return; }
    const m = lastLogText.match(URL_LINE_RE);
    if (m) {
      runtimeUrl = m[1];
      crashCount = 0; // a healthy boot resets the auto-restart counter
      log(`[shell] runtime URL: ${runtimeUrl}`);
      if (remote) remote.setRuntimeUrl(runtimeUrl); // phone gateway follows the runtime port
      waitForHealth(runtimeUrl).then((ok) => {
        if (!ok) return;
        startEventsFeed();
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(runtimeUrl);
        else createWindow(runtimeUrl);
      });
    }
  }, 500);

  const fail = (message) => {
    if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; }
    if (outFd !== -1) { try { fs.closeSync(outFd); } catch { /* ignore */ } outFd = -1; }
    if (!mainWindow) {
      // boot-time failure: nothing to fall back to
      dialog.showErrorBox(APP_NAME, message);
      app.quit();
    } else {
      // runtime failure while the app is up: keep the shell alive (M8)
      dialog.showErrorBox(APP_NAME, message);
      notify(t(lang(), 'notify.runtimeExited'), message);
    }
  };

  let attempt = 0;
  let retrying = false;
  const launch = () => {
    const cand = candidates[Math.min(attempt, candidates.length - 1)];
    attempt += 1;
    retrying = false;
    log(`[shell] node attempt ${attempt}/${candidates.length}: ${cand.bin}${cand.runAsNode ? ' (electron-as-node)' : ''}`);
    const env = { ...process.env, DSH_HOME: dshHome };
    if (cand.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';

    let child;
    try {
      child = spawn(cand.bin, args, {
        env,
        cwd,
        windowsHide: true,
        stdio: outFd === -1 ? 'ignore' : ['ignore', outFd, outFd],
      });
    } catch (err) {
      fail(`启动运行时失败: ${err.message}`);
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
      if (!wasCurrent || quitting || retrying) return;
      if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; }
      if (!mainWindow) {
        fail(t(lang(), 'dialog.runtimeDied', { code, signal, path: runtimeLogPath }));
        return;
      }
      // crash guard: auto-restart with loop protection (max 3 in 60s);
      // a clean exit (code 0) or a manual restart is not a crash (M9)
      if (code !== 0) recordCrash(code, signal);
      const now = Date.now();
      if (now - lastCrashAt > 60_000) crashCount = 0;
      lastCrashAt = now;
      crashCount += 1;
      if (crashCount <= 3) {
        notify(t(lang(), 'notify.runtimeExited'), t(lang(), 'notify.autoRestart', { code, signal, attempt: crashCount }));
        setTimeout(restartRuntime, 1_500);
      } else {
        notify(t(lang(), 'notify.runtimeExited'), t(lang(), 'notify.autoRestartStopped', { code, signal }));
      }
    });

    runtimeChild = child;
    try { spawnWatchdog(child.pid); } catch { /* ignore */ }
  };

  launch();
  return runtimeChild;
}

/** Spawn a detached watchdog that reaps the runtime if this shell dies hard. */
function spawnWatchdog(runtimePid) {
  try {
    const node = bestNodeBin();
    const env = { ...process.env };
    if (node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    const wd = spawn(node.bin, [path.join(__dirname, 'watchdog.js'), String(process.pid), String(runtimePid)], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    });
    wd.unref();
    log(`[shell] watchdog armed (shell=${process.pid}, runtime=${runtimePid})`);
  } catch (e) {
    log(`[shell] watchdog spawn failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// health check
// ---------------------------------------------------------------------------
function waitForHealth(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const tick = () => {
      if (Date.now() > deadline) return finish(false);
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return finish(true);
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

// ---------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------
function createWindow(url) {
  mainWindowPending = false; // the main window is (about to be) open
  const saved = windowState.load(windowStateFile());
  const bounds = safeBounds(saved) || { width: 1280, height: 840 };
  mainWindow = new BrowserWindow({
    ...bounds,
    title: APP_NAME,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(url);
  mainWindow.on('close', (e) => {
    if (!quitting && !noTray && settings.get().trayOnClose && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // persist window bounds (debounced)
  const saveBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) windowState.save(windowStateFile(), mainWindow.getBounds());
  };
  mainWindow.on('resize', () => {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(saveBounds, 500);
  });
  mainWindow.on('move', () => {
    clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(saveBounds, 500);
  });
  mainWindow.on('close', saveBounds);

  if (tray) tray.setToolTip(`${APP_NAME} — ${runtimeUrl || 'starting…'}`);
}

/** Keep restored bounds at least partially visible on some display. */
function safeBounds(saved) {
  if (!saved) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 40 && saved.y < a.y + a.height - 40
      && saved.x + saved.width > a.x + 40 && saved.y + saved.height > a.y + 40;
  });
  return ok ? saved : null;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 740,
    height: 880,
    title: `${APP_NAME} 设置`,
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log(`[settings:console] ${message} (${sourceId}:${line})`);
  });
  log('[shell] settings window opened');
  return settingsWindow;
}

function iconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'icon.png');
  return path.join(__dirname, '..', 'resources', 'icon.png');
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------
function updateTray() {
  if (!tray) return;
  const L = lang();
  const info = manager.getInfo();
  const pending = info.pendingVersion;
  const canRollback = info.installed && info.installed.length > 1;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t(L, 'tray.open'), click: () => showMain() },
    { label: t(L, 'tray.settings'), click: () => createSettingsWindow() },
    { label: t(L, 'tray.quickAsk'), accelerator: settings.get().quickAskHotkey || '', click: () => createQuickAsk() },
    { type: 'separator' },
    {
      label: t(L, 'tray.checkUpdates'),
      click: async () => { await runUpdateCheck(true); },
    },
    {
      label: pending ? `${t(L, 'tray.applyUpdate')}（${info.activeVersion} → ${pending}）` : t(L, 'tray.applyUpdate'),
      enabled: !!pending,
      click: async () => {
        try { await applyPendingUpdate(); } catch (err) { notify(t(L, 'notify.applyFailed'), err.message); }
      },
    },
    {
      label: t(L, 'tray.rollback'),
      enabled: canRollback,
      click: async () => {
        try { await doRollback(); } catch (err) { notify(t(L, 'notify.rollbackFailed'), err.message); }
      },
    },
    { type: 'separator' },
    { label: t(L, 'tray.restartRuntime'), click: restartRuntime },
    {
      label: t(L, 'tray.checkShellUpdate'),
      click: () => checkShellUpdate(true),
    },
    {
      label: t(L, 'tray.workspaces'),
      submenu: (settings.get().recentWorkspaces || []).filter(Boolean).length
        ? settings.get().recentWorkspaces.filter(Boolean).map((ws) => ({
            label: ws,
            type: 'checkbox',
            checked: settings.get().workspace === ws,
            click: () => setWorkspace(ws),
          }))
        : [{ label: t(L, 'tray.noWorkspaces'), enabled: false }],
    },
    { label: t(L, 'tray.devtools'), click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools(); } },
    { type: 'separator' },
    { label: t(L, 'tray.runtime', { v: info.activeVersion || '—' }), enabled: false },
    { label: t(L, 'tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (noTray) return;
  const nativeImage = require('electron').nativeImage;
  const baseIcon = nativeImage.createFromPath(iconPath());
  if (process.platform === 'darwin') {
    // macOS menu bar icon. The bundled icon.png is a 512x512 RGBA app icon
    // with an opaque background — using it as a template image (Electron's
    // default for small icons) renders it as a solid block because the whole
    // alpha channel is fully opaque. Show it as a colored icon instead:
    // resize to 22x22 (the standard menubar size) and explicitly opt out of
    // template mode so macOS shows the original artwork.
    const resized = baseIcon.resize({ width: 22, height: 22 });
    resized.setTemplateImage(false);
    tray = new Tray(resized);
  } else {
    tray = new Tray(baseIcon.resize({ width: 16, height: 16 }));
  }
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showMain());
  updateTray();
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function restartRuntime() {
  log('[shell] restart requested');
  stopEventsFeed();
  eventsFeedLiveLogged = false;
  if (runtimeChild) { runtimeChild.kill(); runtimeChild = null; }
  runtimeUrl = null;
  if (remote) remote.setRuntimeUrl(null); // gateway answers 503 until the new URL arrives
  spawnRuntime();
}

/**
 * Minimal application menu: keeps keyboard shortcuts alive (Ctrl+R reload,
 * Ctrl+Shift+I devtools, Ctrl+Shift+O open-in-browser, Ctrl+, settings, Ctrl+Q
 * quit) while the menu bar itself stays hidden (autoHideMenuBar on the window).
 */
function buildAppMenu() {
  const L = lang();
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { label: t(L, 'tray.settings'), accelerator: 'Cmd+,', click: () => createSettingsWindow() },
        { type: 'separator' },
        { role: 'quit', label: t(L, 'tray.quit') },
      ],
    }] : []),
    {
      label: t(L, 'menu.file'),
      submenu: [
        { label: t(L, 'tray.settings'), accelerator: 'CmdOrCtrl+,', click: () => createSettingsWindow() },
        { label: t(L, 'menu.search'), accelerator: 'CmdOrCtrl+K', click: () => createSearchWindow() },
        { type: 'separator' },
        { label: t(L, 'tray.quit'), accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    // Edit menu: required on macOS so Cmd+C/V/X/A route into the webContents.
    // Without these roles the OS menu has no copy/paste handlers and every
    // edit shortcut silently does nothing — both directions of clipboard break.
    { role: 'editMenu' },
    {
      label: t(L, 'menu.view'),
      submenu: [
        { label: t(L, 'menu.reload'), accelerator: 'CmdOrCtrl+R', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); } },
        { label: t(L, 'menu.devtools'), accelerator: 'CmdOrCtrl+Shift+I', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.toggleDevTools(); } },
        { label: t(L, 'menu.openBrowser'), accelerator: 'CmdOrCtrl+Shift+O', click: () => { if (runtimeUrl) shell.openExternal(runtimeUrl); } },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// update pipeline
// ---------------------------------------------------------------------------
async function runUpdateCheck(notifyUser) {
  if (updateInFlight || guidedInstallInProgress) return { ok: false, reason: 'already running' };
  updateInFlight = true;
  try {
    const report = await manager.checkForUpdate();
    if (!report.ok) {
      if (notifyUser) notify(t(lang(), 'notify.updateFailed'), report.reason);
      return report;
    }
    if (!report.available) {
      if (notifyUser) {
        notify(t(lang(), 'notify.upToDate'), t(lang(), 'notify.upToDateBody', { v: report.current }));
      }
      updateTray();
      return report;
    }
    notify(t(lang(), 'notify.newVersion'), t(lang(), 'notify.downloading', { a: report.current, b: report.target }));
    const entry = await manager.installVersion(report.target);
    const smoke = await manager.smokeTest(entry);
    if (!smoke.ok) {
      if (!manager.state.broken.includes(report.target)) manager.state.broken.push(report.target);
      manager.state.knownIssues[report.target] = smoke.reason || `smoke test failed (exit ${smoke.exitCode})`;
      manager.saveState();
      notify(
        t(lang(), 'notify.smokeFailed'),
        t(lang(), 'notify.smokeFailedBody', { v: report.target, reason: smoke.reason || smoke.exitCode, c: report.current })
      );
      updateTray();
      return { ...report, installed: false, smoke: false };
    }
    manager.state.pendingVersion = report.target;
    manager.saveState();
    notify(t(lang(), 'notify.ready'), t(lang(), 'notify.readyBody', { a: report.current, b: report.target }));
    updateTray();
    return { ...report, installed: true, smoke: true };
  } catch (err) {
    if (notifyUser) notify(t(lang(), 'notify.updateFailed'), err.message);
    return { ok: false, reason: err.message };
  } finally {
    updateInFlight = false;
  }
}

async function applyPendingUpdate() {
  const pending = manager.state.pendingVersion;
  if (!pending) throw new Error('没有待应用的更新');
  const { previous } = await manager.activate(pending);
  log(`[shell] applied update: ${previous} -> ${pending}`);
  restartRuntime();
  updateTray();
  return { previous, current: pending };
}

async function doRollback() {
  const { from, to } = await manager.rollback();
  log(`[shell] rolled back: ${from} -> ${to}`);
  restartRuntime();
  updateTray();
  return { from, to };
}

// ---------------------------------------------------------------------------
// IPC (settings window)
// ---------------------------------------------------------------------------
/** Restart/stop the phone gateway after its settings changed. */
function applyRemoteSettings(saved) {
  if (!remote) return;
  remote.stop();
  if (saved.remoteControl) {
    remote.setRuntimeUrl(runtimeUrl);
    remote.start({ port: saved.remotePort })
      .then((s) => { if (!s.running) notify(t(lang(), 'notify.remoteFailed'), t(lang(), 'notify.remoteFailedBody')); })
      .catch((e) => log(`[remote] start failed: ${e.message}`));
  }
}

function registerIpc() {
  ipcMain.handle('shell:get-settings', () => ({
    ...settings.get(),
    shellVersion: APP_VERSION,
    resolvedLanguage: lang(),
    needsSetup: !fs.existsSync(path.join(dshHomeOf(), '.credentials.yaml')),
  }));
  ipcMain.handle('shell:save-settings', (_e, partial) => {
    const before = settings.get();
    const saved = settings.patch(partial || {});
    app.setLoginItemSettings({ openAtLogin: !!saved.autoStart });
    // log only the changed keys, never values (M12: no prompts/secrets in logs)
    log(`[shell] settings saved keys: ${Object.keys(partial || {}).join(', ')}`);
    updateTray();
    if (remote && (saved.remoteControl !== before.remoteControl || saved.remotePort !== before.remotePort)) {
      applyRemoteSettings(saved);
    }
    return saved;
  });
  ipcMain.handle('shell:pick-folder', async (_e, kind) => {
    const res = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: kind === 'workspace' ? '选择工作区目录' : '选择 DSH_HOME 目录',
    });
    return res.canceled ? null : { path: res.filePaths[0] };
  });
  ipcMain.handle('shell:runtime-info', () => manager.getInfo());
  ipcMain.handle('shell:check-update', () => runUpdateCheck(true));
  ipcMain.handle('shell:apply-update', () => applyPendingUpdate());
  ipcMain.handle('shell:rollback', () => doRollback());
  ipcMain.handle('shell:open-log-dir', () => shell.openPath(ensureLogDir()));
  ipcMain.handle('shell:backup-now', () => {
    const dest = backupNow({
      dshHome: dshHomeOf(),
      backupDir: backupDir(),
      keep: settings.get().backupKeep,
      log,
    });
    notify(t(lang(), 'notify.backupDone'), t(lang(), 'notify.backupDoneBody', { dir: dest }));
    return backupInfo(backupDir());
  });
  ipcMain.handle('shell:backup-info', () => backupInfo(backupDir()));
  ipcMain.handle('shell:set-workspace', (_e, ws) => setWorkspace(ws));
  ipcMain.handle('shell:storage-info', async () => storageInfo());
  ipcMain.handle('shell:storage-cleanup', async () => storageCleanup());
  ipcMain.handle('shell:plugins-list', async () => {
    try { return { ok: true, plugins: await fetchPlugins() }; }
    catch (e) { return { ok: false, reason: e.message }; }
  });
  ipcMain.handle('plugins:search', async (_e, keyword) => {
    try { return { ok: true, plugins: await fetchPlugins(keyword) }; }
    catch (e) { return { ok: false, reason: e.message }; }
  });
  ipcMain.on('plugins:close', () => { if (pluginMarketWindow) pluginMarketWindow.close(); });
  ipcMain.on('plugins:open', () => createPluginMarketWindow());
  ipcMain.handle('shell:plugin-action', (_e, action, fullName) => pluginAction(action, fullName));
  ipcMain.handle('shell:cost-info', async () => {
    const stats = await tokenStats.collect(dshHomeOf());
    return costSnapshot(stats);
  });
  ipcMain.handle('shell:diagnostics-info', () => diagnosticsInfo());
  ipcMain.handle('shell:open-diagnostics', () => shell.openPath(diagnosticsDir()));
  ipcMain.handle('quickask:submit', (_e, prompt) => handleQuickAskSubmit(prompt));
  ipcMain.on('quickask:close', () => { if (quickAskWindow) quickAskWindow.close(); });
  ipcMain.handle('shell:scheduled-list', () => settings.get().scheduledTasks || []);
  ipcMain.handle('shell:scheduled-upsert', (_e, task) => {
    // sanitize: keep only known fields with sane types
    const clean = {
      id: typeof task.id === 'string' && task.id ? task.id : undefined,
      name: typeof task.name === 'string' ? task.name.slice(0, 100) : '任务',
      prompt: typeof task.prompt === 'string' ? task.prompt.slice(0, 4000) : '',
      kind: task.kind === 'daily' ? 'daily' : 'every',
      everySeconds: Math.max(60, Number(task.everySeconds) || 3600),
      dailyTime: /^\d{1,2}:\d{2}$/.test(task.dailyTime || '') ? task.dailyTime : '09:00',
      enabled: task.enabled !== false,
      nextRunAt: Number(task.nextRunAt) || undefined,
      lastRunAt: typeof task.lastRunAt === 'string' ? task.lastRunAt : undefined,
    };
    const list = settings.get().scheduledTasks || [];
    if (clean.id) {
      const idx = list.findIndex((t) => t.id === clean.id);
      if (idx !== -1) list[idx] = { ...list[idx], ...clean };
      else list.push(clean);
    } else {
      clean.id = `task-${Date.now()}`;
      list.push(clean);
    }
    settings.patch({ scheduledTasks: list });
    startScheduler();
    return { ok: true, tasks: settings.get().scheduledTasks };
  });
  ipcMain.handle('shell:scheduled-remove', (_e, id) => {
    const list = (settings.get().scheduledTasks || []).filter((t) => t.id !== id);
    settings.patch({ scheduledTasks: list });
    startScheduler();
    return { ok: true };
  });
  ipcMain.handle('search:query', async (_e, q) => searchSessions(dshHomeOf(), q, 20));

  // phone remote-control gateway (settings window)
  ipcMain.handle('remote:status', () => (remote ? remote.status() : { running: false, disabled: true }));
  ipcMain.handle('remote:pairing', () => {
    if (!remote) return null;
    remote.refreshPairingCode();
    return remote.status();
  });
  ipcMain.handle('remote:revoke', () => (remote ? remote.revokeToken() : null));
  ipcMain.handle('remote:qr', async (_e, text) => (
    remote && typeof text === 'string' && /^https:\/\/[A-Za-z0-9.:\\-]+$/.test(text) ? remote.qrDataUrl(text) : null
  ));
  ipcMain.on('search:close', () => { if (searchWindow) searchWindow.close(); });

  // injected window chrome
  ipcMain.on('chrome:open-settings', () => createSettingsWindow());
  ipcMain.on('chrome:refresh-tokens', async () => {
    try {
      const stats = await tokenStats.collect(dshHomeOf());
      pushTokens(stats);
      costSnapshot(stats);
    } catch (e) { log(`[shell] manual token refresh failed: ${e.message}`); }
  });
  ipcMain.on('chrome:set-workspace', (_e, ws) => setWorkspace(ws));
  ipcMain.on('chrome:report', (_e, info) => {
    log(`[shell] chrome placed at top=${info.top} right=${info.right} (controls found: ${info.found}, saved pos: ${info.saved})`);
  });
}

/** Switch the runtime workspace and restart. */
function setWorkspace(ws) {
  if (typeof ws !== 'string' || !ws.trim()) return { ok: false, reason: 'invalid path' };
  const cur = settings.get();
  const recents = [ws.trim(), ...(cur.recentWorkspaces || []).filter((w) => w && w !== ws.trim())].slice(0, 8);
  settings.patch({ workspace: ws.trim(), recentWorkspaces: recents });
  log(`[shell] workspace -> ${ws.trim()}`);
  restartRuntime();
  updateTray();
  return { ok: true, workspace: ws.trim() };
}

/** Total size of a directory tree in MB (rounded). Async — uses fsp so the
 *  main thread is never blocked by AV scanning each statSync. */
async function dirSizeMBAsync(p) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(p, { recursive: true }); } catch { return 0; }
  for (const f of entries) {
    try { const st = await fsp.stat(path.join(p, f)); total += st.size; } catch { /* ignore */ }
  }
  return Math.round((total / 1e6) * 10) / 10;
}

async function storageInfo() {
  const ud = app.getPath('userData');
  const defs = [
    { name: 'sessions', path: path.join(dshHomeOf(), 'sessions') },
    { name: 'backups', path: backupDir() },
    { name: 'runtimes', path: path.join(ud, 'runtime') },
    { name: 'logs', path: path.join(ud, 'logs') },
    { name: 'npm-cache', path: path.join(ud, 'npm-cache') },
  ];
  // Compute sizes concurrently so the total wall time is one tree walk
  // instead of N sequential ones (each is non-blocking anyway via fsp).
  const sizes = await Promise.all(defs.map((d) => dirSizeMBAsync(d.path)));
  const items = defs.map((d, i) => ({ name: d.name, path: d.path, sizeMB: sizes[i] }));
  return { items, totalMB: Math.round(items.reduce((a, i) => a + i.sizeMB, 0) * 10) / 10 };
}

async function storageCleanup() {
  const [logsBefore, backupsBefore] = await Promise.all([
    dirSizeMBAsync(path.join(app.getPath('userData'), 'logs')),
    dirSizeMBAsync(backupDir()),
  ]);
  const before = logsBefore + backupsBefore;
  pruneLogs(10);
  // prune backups beyond keep
  const keep = Math.max(1, settings.get().backupKeep || 5);
  let dirs = [];
  try {
    dirs = fs.readdirSync(backupDir())
      .filter((n) => { try { return fs.statSync(path.join(backupDir(), n)).isDirectory(); } catch { return false; } })
      .sort();
  } catch { /* ignore */ }
  while (dirs.length > keep) {
    const old = dirs.shift();
    try { fs.rmSync(path.join(backupDir(), old), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const [logsAfter, backupsAfter] = await Promise.all([
    dirSizeMBAsync(path.join(app.getPath('userData'), 'logs')),
    dirSizeMBAsync(backupDir()),
  ]);
  const after = logsAfter + backupsAfter;
  return { ok: true, freedMB: Math.max(0, Math.round((before - after) * 10) / 10) };
}

// ---------------------------------------------------------------------------
// plugin market (GitHub dsh-plugin topic)
// ---------------------------------------------------------------------------
/** Parse plugins actually installed in the web profile's package.json (github: specs). */
function parseProfilePlugins() {
  const pkg = path.join(dshHomeOf(), 'profiles', 'web', 'package.json');
  try {
    const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    const out = new Set();
    for (const spec of Object.values(data.dependencies || {})) {
      const s = String(spec);
      let m = s.match(/^github:([\w.-]+\/[\w.-]+)/);
      if (!m) m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
      if (m) out.add(m[1]);
    }
    return [...out];
  } catch { return []; }
}

/** Merge profile-installed plugins into the shell's local record. */
function seedInstalledPlugins() {
  const profile = parseProfilePlugins();
  if (!profile.length) return;
  const cur = settings.get();
  const merged = new Set([...(cur.installedPlugins || []), ...profile]);
  if (merged.size !== (cur.installedPlugins || []).length) {
    settings.patch({ installedPlugins: [...merged] });
    log(`[shell] seeded ${profile.length} installed plugin(s) from profile`);
  }
}

async function fetchPlugins(keyword) {
  const q = 'topic:dsh-plugin' + (keyword ? ' ' + String(keyword).trim().slice(0, 60) : '');
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=30`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cockpit' } });
  } catch (e) {
    throw new Error(`GitHub API unreachable: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const data = await res.json();
  const installed = new Set([...(settings.get().installedPlugins || []), ...parseProfilePlugins()]);
  return (data.items || []).map((it) => ({
    fullName: it.full_name,
    description: (it.description || '').slice(0, 200),
    stars: it.stargazers_count || 0,
    updated: (it.updated_at || '').slice(0, 10),
    url: it.html_url,
    installed: installed.has(it.full_name),
  }));
}

/** Run `dsh plugin --profile web <args>`; output to a log file (fd, sandbox-safe). */
function runDshPlugin(args, timeoutMs = 300_000) {
  const node = bestNodeBin();
  const binJs = activeDshBin();
  const dshHome = dshHomeOf();
  const outFile = path.join(ensureLogDir(), `plugin-${Date.now()}.out`);
  let fd = -1;
  try { fd = fs.openSync(outFile, 'a'); } catch { /* ignore */ }
  return new Promise((resolve) => {
    const env = { ...process.env, DSH_HOME: dshHome };
    if (node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = spawn(node.bin, [binJs, 'plugin', '--profile', 'web', ...args], {
        env, cwd: dshHome, windowsHide: true, stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd],
      });
    } catch (e) {
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve({ ok: false, output: e.message });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, output: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve({ ok: false, output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (fd !== -1) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      log(`[shell] dsh plugin ${args.join(' ')} -> exit ${code}`);
      resolve({ ok: code === 0, output: out.slice(-2000) });
    });
  });
}

async function pluginAction(action, fullName) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return { ok: false, reason: 'invalid repo name' };
  const arg = action === 'remove' ? 'remove' : 'add';
  const spec = action === 'remove' ? fullName : `github:${fullName}`;
  const result = await runDshPlugin([arg, spec]);
  if (!result.ok) return { ok: false, reason: result.output || 'plugin command failed' };
  const cur = settings.get();
  const installed = new Set(cur.installedPlugins || []);
  if (action === 'remove') installed.delete(fullName); else installed.add(fullName);
  settings.patch({ installedPlugins: [...installed] });
  // profile changed: reload the runtime so the plugin takes effect
  restartRuntime();
  updateTray();
  return { ok: true };
}
function pushTokens(stats) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!stats) return; // async collect now drives all callers; no sync fallback
  if (!tokenWidgetLogged) {
    tokenWidgetLogged = true;
    log(`[shell] token widget: ${stats.sessionCount} session(s), current in=${stats.current ? stats.current.input : 0} out=${stats.current ? stats.current.output : 0}`);
  }
  const needsSetup = !fs.existsSync(path.join(dshHomeOf(), '.credentials.yaml'));
  const cur = stats.current;
  const tot = stats.totals;
  const pressure = cur ? cur.input + cur.cacheRead + cur.cacheWrite : 0;
  const windowSize = Math.max(1024, settings.get().contextWindow || 128000);
  const pressurePct = Math.min(100, Math.round((pressure / windowSize) * 100));
  // Send only what the pill needs — the full sessions array was being
  // serialized + shipped every tick (perf #4).
  mainWindow.webContents.send('chrome:tokens', {
    sessionCount: stats.sessionCount,
    current: cur, totals: tot,
    lang: lang(), needsSetup, pressurePct,
  });
}

// ---------------------------------------------------------------------------
// cost center (token -> ¥ estimate, daily history, budget alerts)
// ---------------------------------------------------------------------------
function todayMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function costSnapshot(stats) {
  if (!stats) return; // async collect now drives all callers; no sync fallback
  const cfg = settings.get();
  const rates = {
    inputPerM: cfg.costInputPerM || 0,
    outputPerM: cfg.costOutputPerM || 0,
    cacheReadPerM: cfg.costCacheReadPerM || 0,
    cacheWritePerM: cfg.costCacheWritePerM || 0,
  };
  const perWorkspace = new Map();
  for (const s of stats.sessions) {
    const key = s.cwd || '(unknown)';
    if (!perWorkspace.has(key)) perWorkspace.set(key, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 0 });
    const w = perWorkspace.get(key);
    w.input += s.usage.input; w.output += s.usage.output;
    w.cacheRead += s.usage.cacheRead; w.cacheWrite += s.usage.cacheWrite;
    w.cost += cost.costOf(s.usage, rates); w.sessions += 1;
  }
  const totalCost = cost.costOf(stats.totals, rates);
  const now = Date.now();
  if (now - lastCostUpdateAt > 10 * 60 * 1000) {
    lastCostUpdateAt = now;
    cost.updateHistory(costHistoryFile(), {
      input: stats.totals.input, output: stats.totals.output,
      cacheRead: stats.totals.cacheRead, cacheWrite: stats.totals.cacheWrite,
      sessions: stats.sessionCount, cost: totalCost,
    });
  }
  const history = cost.loadHistory(costHistoryFile());
  const month = cost.summarize(history, 30);
  checkBudget(month.cost);
  return {
    today: cost.summarize(history, 1),
    week: cost.summarize(history, 7),
    month,
    perWorkspace: [...perWorkspace.entries()].map(([cwd, v]) => ({ cwd, ...v })).sort((a, b) => b.cost - a.cost),
    currency: '¥',
    rates,
  };
}

function checkBudget(monthCost) {
  const budget = settings.get().monthlyBudget || 0;
  const status = cost.budgetStatus(monthCost, budget);
  if (!status) return;
  const key = `${todayMonthKey()}:${status}`;
  if (budgetNotified.has(key)) return;
  budgetNotified.add(key);
  const pct = Math.round((monthCost / budget) * 100);
  if (status === 'exceed') {
    notify(t(lang(), 'notify.budgetExceed'), t(lang(), 'notify.budgetExceedBody', { pct }));
  } else {
    notify(t(lang(), 'notify.budgetWarn'), t(lang(), 'notify.budgetWarnBody', { pct }));
  }
}

// ---------------------------------------------------------------------------
// crash diagnostics
// ---------------------------------------------------------------------------
function recordCrash(code, signal) {
  try {
    const dir = diagnosticsDir();
    fs.mkdirSync(dir, { recursive: true });
    let tail = '';
    try { tail = fs.readFileSync(runtimeLogPath, 'utf8').split('\n').slice(-20).join('\n'); } catch { /* ignore */ }
    const rec = {
      ts: new Date().toISOString(), code, signal,
      activeVersion: manager.getInfo().activeVersion,
      logPath: runtimeLogPath,
      logTail: tail,
    };
    fs.writeFileSync(path.join(dir, `crash-${Date.now()}.json`), JSON.stringify(rec, null, 2));
  } catch (e) {
    log(`[shell] crash record failed: ${e.message}`);
  }
}

function diagnosticsInfo() {
  let count = 0;
  try { count = fs.readdirSync(diagnosticsDir()).filter((f) => f.endsWith('.json')).length; } catch { /* ignore */ }
  return { crashCount: count, dir: diagnosticsDir() };
}

// ---------------------------------------------------------------------------
// Quick Ask (global hotkey -> background headless run)
// ---------------------------------------------------------------------------
function createQuickAsk() {
  if (quickAskWindow && !quickAskWindow.isDestroyed()) {
    quickAskWindow.show();
    quickAskWindow.focus();
    return quickAskWindow;
  }
  quickAskWindow = new BrowserWindow({
    width: 460,
    height: 190,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'quickask-preload.js'),
    },
  });
  quickAskWindow.loadFile(path.join(__dirname, 'quickask.html'));
  quickAskWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  quickAskWindow.once('ready-to-show', () => quickAskWindow.show());
  quickAskWindow.on('closed', () => { quickAskWindow = null; });
  return quickAskWindow;
}

function createSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    searchWindow.show();
    searchWindow.focus();
    return searchWindow;
  }
  searchWindow = new BrowserWindow({
    width: 520,
    height: 420,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'search-preload.js'),
    },
  });
  searchWindow.loadFile(path.join(__dirname, 'search.html'));
  searchWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  searchWindow.once('ready-to-show', () => searchWindow.show());
  searchWindow.on('closed', () => { searchWindow = null; });
  return searchWindow;
}

function createPluginMarketWindow() {
  if (pluginMarketWindow && !pluginMarketWindow.isDestroyed()) {
    pluginMarketWindow.show();
    pluginMarketWindow.focus();
    return pluginMarketWindow;
  }
  pluginMarketWindow = new BrowserWindow({
    width: 560,
    height: 520,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'pluginmarket-preload.js'),
    },
  });
  pluginMarketWindow.loadFile(path.join(__dirname, 'pluginmarket.html'));
  pluginMarketWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  pluginMarketWindow.once('ready-to-show', () => pluginMarketWindow.show());
  pluginMarketWindow.on('closed', () => { pluginMarketWindow = null; });
  return pluginMarketWindow;
}

// ---------------------------------------------------------------------------
// guided first run (no runtime anywhere: install from the registry)
// ---------------------------------------------------------------------------
let pendingLoadingText = null;

function createLoadingWindow() {
  if (loadingWindow && !loadingWindow.isDestroyed()) { loadingWindow.focus(); return loadingWindow; }
  loadingWindow = new BrowserWindow({
    width: 480,
    height: 260,
    frame: false,
    resizable: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'loading-preload.js'),
    },
  });
  loadingWindow.loadFile(path.join(__dirname, 'loading.html'));
  loadingWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  // re-send the latest text once the page is ready (setLoading may have been
  // called before the renderer registered its IPC listener)
  loadingWindow.webContents.once('did-finish-load', () => {
    if (pendingLoadingText && loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.webContents.send('loading:progress', pendingLoadingText);
    }
  });
  loadingWindow.once('ready-to-show', () => loadingWindow.show());
  loadingWindow.on('closed', () => { loadingWindow = null; pendingLoadingText = null; });
  return loadingWindow;
}

function setLoading(text) {
  pendingLoadingText = text;
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.webContents.send('loading:progress', text);
}

/**
 * Find the runtime bundled into the installer (resources/runtime/<version>).
 * Returns { version, path } or null (dev mode / no seed).
 */
function findBundledRuntime() {
  try {
    const root = path.join(process.resourcesPath, 'runtime');
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const seed = path.join(root, d.name);
      const binJs = path.join(seed, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      let size = 0;
      try { size = fs.statSync(binJs).size; } catch { continue; }
      if (size === 0) continue; // truncated extraction leaves zero-byte files
      if (!bundledVersionMatches(seed, d.name)) continue; // tampered/truncated seed
      return { version: d.name, path: seed };
    }
  } catch { /* not packaged or no seed */ }
  return null;
}

/** The seed's package.json version must agree with its directory name. */
function bundledVersionMatches(seed, dirName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(seed, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
    return pkg.version === dirName;
  } catch {
    return false;
  }
}

/**
 * Register the bundled runtime (installer seed) as an entry — run in place,
 * zero copy, zero network. Existing managed entries keep priority.
 */
function registerBundledRuntime() {
  const bundle = findBundledRuntime();
  if (!bundle) return null;
  const entry = manager.registerBundled(bundle);
  if (entry) log(`[shell] using bundled runtime ${entry.version} at ${entry.path}`);
  return entry;
}

async function ensureRuntimeWithGuide() {
  if (ensureRuntimeRegistered()) return true;
  // brand-new machine with NO dsh and NO usable bundle: registry install (rare)
  log('[shell] guided first-run: no usable runtime found, installing from the registry');
  try {
    createLoadingWindow();
    log('[shell] guided first-run: loading window up');
  } catch (err) {
    // A window failure must not abort the install attempt (M14)
    log('[shell] guided first-run: loading window failed: ' + err.message);
  }
  setLoading(hasBrokenBundle()
    ? t(lang(), 'loading.bundleBroken')
    : t(lang(), 'loading.step1'));
  try {
    guidedInstallInProgress = true;
    log('[shell] guided first-run: checking registry for target version');
    const check = await manager.checkForUpdate();
    log('[shell] guided first-run: check ok=' + check.ok + ' available=' + check.available + (check.target ? ' target=' + check.target : ''));
    const target = check.available ? check.target : (manager.getInfo().activeVersion || null);
    if (!target) throw new Error(t(lang(), 'loading.noVersion'));
    setLoading(t(lang(), 'loading.step2', { v: target }));
    log('[shell] guided first-run: installing ' + target + ' (this can take a while)');
    const entry = await manager.installVersion(target);
    setLoading(t(lang(), 'loading.step3'));
    const smoke = await manager.smokeTest(entry);
    if (!smoke.ok) throw new Error(smoke.reason || `smoke exit ${smoke.exitCode}`);
    await manager.activate(target);
    log(`[shell] guided first-run: installed runtime ${target} from the registry`);
    setLoading(t(lang(), 'loading.done'));
    setTimeout(() => { if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close(); }, 800);
    return true;
  } catch (err) {
    log(`[shell] guided first-run failed: ${err.message}`);
    setLoading(t(lang(), 'loading.failed', { msg: err.message }));
    return false;
  } finally {
    guidedInstallInProgress = false;
  }
}

/** resources/runtime exists but holds no valid seed (broken/truncated extraction). */
function hasBrokenBundle() {
  try {
    const root = path.join(process.resourcesPath, 'runtime');
    if (!fs.existsSync(root)) return false;
    return !findBundledRuntime();
  } catch { return false; }
}

function registerQuickAskHotkey() {
  const hotkey = settings.get().quickAskHotkey;
  if (!hotkey) return;
  try {
    globalShortcut.unregister(hotkey);
    const ok = globalShortcut.register(hotkey, () => createQuickAsk());
    log(`[shell] quick-ask hotkey ${ok ? 'registered' : 'FAILED'}: ${hotkey}`);
  } catch (e) {
    log(`[shell] quick-ask hotkey error: ${e.message}`);
  }
}

async function handleQuickAskSubmit(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, output: 'empty prompt' };
  if (quickAskRunning) return { ok: false, output: 'busy' };
  quickAskRunning = true;
  try {
    const result = await runHeadless({
      dshBin: activeDshBin(),
      nodeBin: bestNodeBin(),
      dshHome: dshHomeOf(),
      workspace: settings.effective().workspace || os.homedir(),
      logDir: ensureLogDir(),
      prompt: prompt.trim(),
    });
    notify(t(lang(), 'notify.quickAskDone'), t(lang(), 'notify.quickAskDoneBody', { ok: result.ok ? '✓' : '✗' }));
    return result;
  } finally {
    quickAskRunning = false;
  }
}

// ---------------------------------------------------------------------------
// scheduled tasks
// ---------------------------------------------------------------------------
function startScheduler() {
  if (scheduler) scheduler.stop();
  scheduler = new Scheduler((line) => log(line));
  scheduler.start(settings.get().scheduledTasks || [], async (task) => {
    if (scheduledRunning.has(task.id)) return;
    scheduledRunning.add(task.id);
    try {
      const result = await runHeadless({
        dshBin: activeDshBin(),
        nodeBin: bestNodeBin(),
        dshHome: dshHomeOf(),
        workspace: settings.effective().workspace || os.homedir(),
        logDir: ensureLogDir(),
        prompt: task.prompt || '',
      });
      log(`[scheduler] ${task.name || task.id} finished ok=${result.ok} (${Math.round(result.durationMs / 1000)}s)`);
      notify(
        t(lang(), 'notify.taskDone'),
        t(lang(), 'notify.scheduledDoneBody', { name: task.name || task.id, ok: result.ok ? '✓' : '✗' })
      );
    } finally {
      scheduledRunning.delete(task.id);
      settings.save(); // persist updated nextRunAt / lastRunAt
    }
  });
  log('[shell] scheduler started');
}

// ---------------------------------------------------------------------------
// task-completion + approval/question notifications (runtime event streams)
// ---------------------------------------------------------------------------
function startEventsFeed() {
  stopEventsFeed();
  if (!runtimeUrl || quitting) return;
  const base = runtimeUrl.endsWith('/') ? runtimeUrl : `${runtimeUrl}/`;
  const onFeedError = (err) => {
    log(`[shell] events feed error: ${err.message}`);
    if (quitting) return;
    clearTimeout(eventsRetryTimer);
    eventsRetryTimer = setTimeout(startEventsFeed, 3_000);
  };
  // host stream: session running state (task done)
  eventsFeed.push(connectEvents(base, '/api/events.host', (frame) => {
    if (frame && frame.type === 'host/session-status') {
      if (!eventsFeedLiveLogged) {
        eventsFeedLiveLogged = true;
        log(`[shell] events feed live (session ${frame.sessionId}, running=${frame.running})`);
      }
      if (frame.running === false) onTaskDone();
    }
  }, onFeedError));
  // mux stream: approval / question frames while the window is hidden
  eventsFeed.push(connectEvents(base, '/api/events.mux', (frame) => {
    if (!frame) return;
    if (frame.type === 'approval/requested') onApprovalRequested(frame);
    else if (frame.type === 'question/requested') onQuestionRequested(frame);
  }, onFeedError));
  log(`[shell] events feed -> ${base}api/events.{host,mux}`);
}

function stopEventsFeed() {
  for (const feed of eventsFeed) {
    try { feed.close(); } catch { /* ignore */ }
  }
  eventsFeed = [];
  if (eventsRetryTimer) { clearTimeout(eventsRetryTimer); eventsRetryTimer = null; }
}

function windowHidden() {
  return !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized();
}

function onTaskDone() {
  const now = Date.now();
  if (now - lastTaskNotifyAt < 8_000) return; // debounce
  lastTaskNotifyAt = now;
  if (!windowHidden()) return; // user is watching
  notify(t(lang(), 'notify.taskDone'), t(lang(), 'notify.taskDoneBody'));
}

function onApprovalRequested(frame) {
  if (!windowHidden()) return;
  const tool = frame.toolName || '';
  notify(t(lang(), 'notify.approval'), t(lang(), 'notify.approvalBody', { tool }));
}

function onQuestionRequested() {
  if (!windowHidden()) return;
  notify(t(lang(), 'notify.question'), t(lang(), 'notify.questionBody'));
}

// ---------------------------------------------------------------------------
// shell self-update (electron-updater; packaged builds only)
// ---------------------------------------------------------------------------
let autoUpdater = null;

function initAutoUpdater() {
  if (!app.isPackaged) {
    log('[shell] updater: dev mode, skipping');
    return;
  }
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      log(`[shell] updater: update available ${info && info.version}`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      log(`[shell] updater: downloaded ${info && info.version}`);
      promptInstallShellUpdate(info);
    });
    autoUpdater.on('error', (e) => log(`[shell] updater: ${e && e.message}`));
    log('[shell] updater initialized');
    if (settings.get().shellAutoUpdate) {
      // check shortly after boot, then every 4 hours
      setTimeout(() => checkShellUpdate(false), 10_000);
      setInterval(() => checkShellUpdate(false), 4 * 60 * 60 * 1000);
    }
  } catch (e) {
    log(`[shell] updater init failed: ${e.message}`);
  }
}

/** Release notes from the updater info (string or array, markdown-ish). */
function releaseNotesText(info) {
  if (!info || !info.releaseNotes) return '';
  const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes : [info.releaseNotes];
  return notes.map((n) => (typeof n === 'string' ? n : (n && n.note) || '')).join('\n\n').slice(0, 1500);
}

async function promptInstallShellUpdate(info) {
  if (!autoUpdater) return;
  const L = lang();
  const detail = [t(L, 'updateDialogDetail'), releaseNotesText(info)].filter(Boolean).join('\n\n');
  const { response } = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    buttons: [t(L, 'updateDialogRestart'), t(L, 'updateDialogLater')],
    defaultId: 0,
    cancelId: 1,
    title: t(L, 'updateDialogTitle'),
    message: t(L, 'updateDialogMsg', { v: info && info.version ? info.version : '' }),
    detail,
  });
  if (response === 0) {
    try { autoUpdater.quitAndInstall(); } catch (e) { log(`[shell] updater quitAndInstall failed: ${e.message}`); }
  } else {
    notify(t(lang(), 'notify.shellUpdate'), t(lang(), 'notify.shellUpdateBody'));
  }
}

function checkShellUpdate(notifyUser) {
  if (!autoUpdater) {
    if (notifyUser) notify(t(lang(), 'notify.updateFailed'), 'updater unavailable');
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => {
    log(`[shell] updater check failed: ${e && e.message}`);
    if (notifyUser) notify(t(lang(), 'notify.updateFailed'), String((e && e.message) || e));
  });
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------
function killRuntime() {
  if (remote) remote.setRuntimeUrl(null);
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
          try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
        } else {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
    }
  }, 200);
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.dshcockpit.app');
    // No visible File/Edit menu bar (autoHideMenuBar hides it), but the menu
    // keeps keyboard accelerators alive (Ctrl+R / Ctrl+Shift+I / Ctrl+, …).
    buildAppMenu();
    openLog();
    if (!fs.existsSync(iconPath())) log('[shell] warning: resources/icon.png missing');
    registerIpc();
    // Phone remote-control gateway: constructed here because safeStorage needs
    // the app to be ready. The runtime URL may still be null while booting -
    // setRuntimeUrl() below feeds it as soon as the URL line appears.
    remote = new RemoteControl({ userDataDir: app.getPath('userData'), safeStorage, log });
    if (settings.get().remoteControl) {
      remote.setRuntimeUrl(runtimeUrl);
      remote.start({ port: settings.get().remotePort })
        .then((s) => { if (!s.running) notify(t(lang(), 'notify.remoteFailed'), t(lang(), 'notify.remoteFailedBody')); })
        .catch((e) => log(`[remote] start failed: ${e.message}`));
    }
    app.setLoginItemSettings({ openAtLogin: !!settings.get().autoStart });
    createTray();
    const runtimeReady = await ensureRuntimeWithGuide();
    // The guided flow may have quit the app (user choice / fatal error);
    // never continue a torn-down app (write-after-end crashes).
    if (quitting) return;
    if (runtimeReady) {
      seedInstalledPlugins();
      // The guided flow may have just closed its loading window; with no main
      // window open yet, window-all-closed would otherwise quit the app while
      // the runtime is still booting (M15). Hold quit until the window opens.
      mainWindowPending = true;
      spawnRuntime();
    }
    registerQuickAskHotkey();
    startScheduler();
    initAutoUpdater();
    if (process.env.DSH_DESKTOP_OPEN_SETTINGS === '1') createSettingsWindow();

    // token widget: one collect per tick shared by the widget and the cost
    // center (M7: avoid double full scans every 5s).
    // Implemented as setTimeout recursion so a slow collect can never overlap
    // with the next tick (perf #1 + #3); collect() is async and yields
    // between files so the main thread is never pinned.
    let tokenPollBusy = false;
    const pollTokens = async () => {
      if (tokenPollBusy || quitting) return;
      tokenPollBusy = true;
      try {
        const stats = await tokenStats.collect(dshHomeOf());
        pushTokens(stats);
        costSnapshot(stats);
      } catch (e) {
        log(`[shell] token poll failed: ${e.message}`);
      } finally {
        tokenPollBusy = false;
        if (!quitting) setTimeout(pollTokens, TOKEN_POLL_MS);
      }
    };
    if (settings.get().tokenWidget) {
      setTimeout(pollTokens, 2_000);
    }
    setTimeout(async () => {
      const stats = await tokenStats.collect(dshHomeOf());
      costSnapshot(stats);
      const diag = diagnosticsInfo();
      if (diag.crashCount > 0) {
        notify(t(lang(), 'notify.crashReminder'), t(lang(), 'notify.crashReminderBody', { n: diag.crashCount }));
      }
    }, 8_000);

    // background update check (does not block boot)
    if (settings.get().checkUpdatesOnStartup) {
      setTimeout(() => { runUpdateCheck(false); }, 15_000);
    }
  });

  app.on('window-all-closed', () => {
    if (mainWindowPending) return; // runtime still booting; the main window opens soon
    if (noTray || quitting || !settings.get().trayOnClose) app.quit();
  });

  // macOS: clicked the dock icon (or activated via Spotlight/Launchpad) while
  // the app is still running. Without this, hiding the main window on close
  // (trayOnClose=true) leaves the user unable to bring it back via the dock —
  // they had to quit and relaunch. Re-show the hidden window, or recreate it
  // if it was actually destroyed.
  app.on('activate', () => {
    if (quitting) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (runtimeUrl) {
      createWindow(runtimeUrl);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    // back up history before the runtime is torn down (sessions are durable
    // JSONL, this is a belt-and-suspenders safety net; see DESIGN.md §15)
    if (settings.get().backupOnQuit) {
      try {
        backupNow({ dshHome: dshHomeOf(), backupDir: backupDir(), keep: settings.get().backupKeep, log });
      } catch (err) {
        log(`[shell] quit backup failed: ${err.message}`);
      }
    }
    killRuntime();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (scheduler) scheduler.stop();
    if (remote) remote.stop();
    if (logStream) logStream.end();
  });
}
