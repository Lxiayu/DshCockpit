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

const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, Notification, shell, screen, globalShortcut, safeStorage, nativeTheme, clipboard } = require('electron');
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
const balance = require('./balance');
const { runHeadless } = require('./headless');
const { Scheduler } = require('./scheduler');
const { searchSessions } = require('./session-search');
const { RemoteControl, PAIR_PATH } = require('./remote-control');
const { createPublicRemote, buildPairUrl } = require('./public-remote');
const { createModelsManager, PRESETS: MODELS_PRESETS, OLLAMA_PRESET: MODELS_OLLAMA_PRESET } = require('./models-manager');
const compact = require('./compact');
const { createMemoryFiles } = require('./memory-files');
const { createPluginOpGuard, failureCode, shouldCleanupAfterFailure, summarizeOutput, inferStage, parsePnpmBlockedPackage, upsertOnlyBuiltDependencies, pickSubpackage, resolveDepKey, pruneBundles, sanitizeProfile } = require('./plugin-flow');
const { createSkillsManager, buildSkillsMarketPayload } = require('./skills');
const { createChannelManager } = require('./channels/channel-manager');
const { FeishuChannel } = require('./channels/receivers/feishu');
const { testFeishuConnection } = require('./channels/senders/feishu');
const { WecomChannel } = require('./channels/receivers/wecom');
const { testWecomConnection } = require('./channels/senders/wecom');
const { DingtalkChannel } = require('./channels/receivers/dingtalk');
const { testDingtalkConnection } = require('./channels/senders/dingtalk');

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
let publicRemote = null; // C7: Tailscale detection + cloudflared quick tunnel helper
let channelsMgr = null; // IM channels hub (C5 skeleton; constructed after app ready)
let loadingWindow = null;
let trayPeakTimer = null; // 1-minute tray refresh for the peak/off-peak countdown
let balanceMonitor = null; // official balance poller (constructed after app ready)
let balanceTimer = null; // 5-minute fallback poll for the balance monitor
let modelsMgr = null; // model provider panel state (constructed after app ready)
let compactTracker = null; // compaction watcher (C3, constructed after app ready)
let compactTimer = null; // 5-second compaction scan cadence
let sessionRunning = false; // live host/session-status frames (C3 busy check)
let guidedInstallInProgress = false;
let mainWindowPending = false; // guided first-run: runtime booting, main window not open yet
const pluginGuard = createPluginOpGuard(); // one dsh plugin op at a time (profile safety)
const skillsGuard = createPluginOpGuard(); // one skill install/upgrade at a time (atomic writes)
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
const balanceSnapshotFile = () => path.join(app.getPath('userData'), 'balance-snapshot.json');
const diagnosticsDir = () => path.join(app.getPath('userData'), 'diagnostics');
const TOKEN_POLL_MS = 5_000;

/** Parsed peak windows when peak pricing is enabled; null otherwise.
 * An invalid user string falls back to the DeepSeek default windows. */
function peakWindowsOf(cfg) {
  if (!cfg || !cfg.costPeakEnabled) return null;
  return cost.parseWindows(cfg.costPeakWindows) || cost.DEFAULT_WINDOWS;
}

/** One collect shared by the 5s poll, manual refresh, cost-info IPC and the
 * per-turn cost computation — always bucketed by the (default 9-12,14-18)
 * peak windows so the official matrix pricing gets its peak/off-peak split;
 * display paths still gate on costPeakEnabled, and one stable bucketing key
 * keeps the parse cache warm. */
async function collectStats() {
  const windows = cost.parseWindows(settings.get().costPeakWindows) || cost.DEFAULT_WINDOWS;
  return tokenStats.collect(dshHomeOf(), { windows });
}

const manager = new RuntimeManager({
  userDataDir: app.getPath('userData'),
  settings,
  log: (line) => log(line),
  resolveNodeBin: () => bestNodeBin(),
});

// AGENTS.md memory editor (C3): manages exactly the workspace + DSH_HOME
// files through a closed write whitelist (see src/memory-files.js)
const memory = createMemoryFiles({
  workspaceOf: () => settings.effective().workspace || os.homedir(),
  dshHomeOf,
});

// Skills (SKILL.md packs) manager (C4): pure-fs installs into
// <DSH_HOME>/skills — dsh hot-reloads them, so no runtime restart is ever
// triggered from this path. Repo zips stage under userData (never inside the
// skills root, where half-written trees would flash into the runtime).
const skillsMgr = createSkillsManager({
  dshHomeOf,
  stagingRoot: () => path.join(app.getPath('userData'), 'skills-staging'),
  log: (line) => log(line),
  progress: sendSkillsProgress,
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
  // Log rotation stats every file under logs/ — under Windows AV each stat is
  // amplified; it is housekeeping, so keep it off the boot path.
  setTimeout(pruneLogs, 10_000);
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
    // Hard timeout: `where.exe` under Windows AV can stall for seconds (each
    // PATH entry is a scanned directory); boot must never wait on it.
    const out = execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
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
  // Disk cache short-circuits the `where.exe` spawn entirely: one existsSync
  // (µs) vs. a process spawn (50-500ms under Windows AV). Entries are
  // validated before use and rewritten only after a live probe succeeds.
  const cached = _loadNodeDiskCache();
  if (cached && cached.bin && fs.existsSync(cached.bin)) return cached.bin;
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const fromPath = firstLineOf(whereCmd, ['node']);
  if (!fromPath) return null;
  if (!fs.existsSync(fromPath)) return null;
  let resolved;
  try { resolved = fs.realpathSync(fromPath); } catch { resolved = fromPath; }
  _saveNodeDiskCache(resolved);
  return resolved;
}

function nodeCacheFile() {
  return path.join(app.getPath('userData'), 'node-cache.json');
}

let _nodeDiskCache; // undefined = not loaded; null = absent/corrupt

function _loadNodeDiskCache() {
  if (_nodeDiskCache !== undefined) return _nodeDiskCache;
  try {
    const raw = JSON.parse(fs.readFileSync(nodeCacheFile(), 'utf8'));
    _nodeDiskCache = raw && typeof raw.bin === 'string' && raw.bin ? raw : null;
  } catch { _nodeDiskCache = null; }
  return _nodeDiskCache;
}

function _saveNodeDiskCache(bin) {
  _nodeDiskCache = { bin, ts: Date.now() };
  try {
    fs.mkdirSync(path.dirname(nodeCacheFile()), { recursive: true });
    fs.writeFileSync(nodeCacheFile(), JSON.stringify(_nodeDiskCache));
  } catch { /* best effort */ }
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
    // The active entry is already live, so bundle re-registration (reads
    // resources/ + the seed package.json — expensive under Windows AV) and
    // background materialization are not needed to boot; keep them off the
    // first-window path. Managed still wins inside entry() when it lands.
    setTimeout(() => { registerBundledRuntime(); materializeIfNeeded(); }, 1_000);
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

/**
 * Boot-time self-heal: drop bundle registrations whose third-party package is
 * missing from node_modules (a dangling reference makes the runtime throw on
 * every boot — the crash-loop case). Runs before each spawn; cheap because it
 * touches only the manifest plus one existsSync per third-party bundle.
 */
function selfHealProfile() {
  try {
    const dir = profileDirOf();
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(profilePackageJson(), 'utf8')); } catch { return; }
    const { pkg: cleaned, removed } = sanitizeProfile(pkg, (name) => {
      try {
        fs.accessSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
        return true;
      } catch { return false; }
    });
    if (!removed.length) return;
    writeProfilePackage(JSON.stringify(cleaned, null, 2) + '\n');
    try { fs.rmSync(path.join(dir, 'pnpm-lock.yaml'), { force: true }); } catch { /* ignore */ }
    log(`[shell] self-heal: removed dangling bundle(s) ${removed.join(', ')}`);
    notify(t(lang(), 'selfheal.title'), t(lang(), 'selfheal.body', { names: removed.join(', ') }));
    const cur = settings.get();
    const stillInstalled = new Set((cur.installedPlugins || [])
      .filter((p) => !removed.some((n) => n.endsWith(p.split('/')[1]) || p.endsWith(n))));
    settings.patch({ installedPlugins: [...stillInstalled] });
  } catch (e) {
    log(`[shell] self-heal skipped: ${e.message}`);
  }
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

  selfHealProfile();

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
        // crash loop: the runtime cannot boot — most likely a broken plugin.
        // Offer safe mode (official bundles only) right here instead of a bare
        // "gave up" notification the user cannot act on.
        notify(t(lang(), 'notify.runtimeExited'), t(lang(), 'notify.autoRestartStopped', { code, signal }));
        dialog.showMessageBox({
          type: 'error',
          title: APP_NAME,
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
  // The splash has served its purpose; close it as the real window appears.
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  const saved = windowState.load(windowStateFile());
  const bounds = safeBounds(saved) || { width: 1280, height: 840 };
  mainWindow = new BrowserWindow({
    ...bounds,
    backgroundColor: themeBackground(), // match the splash: no white flash before the web UI paints
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
    // 16:10-ish landscape: room for the planned sidebar (208px) + content
    // column (~680px) per UI-REDESIGN-RESEARCH.md §4.3, instead of the old
    // narrow tall strip.
    width: 960,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: themeBackground(),
    title: t(lang(), 'settings.title', { name: APP_NAME }),
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
// theme (dark/light; shared tokens in theme.css, dark is the CSS default)
// ---------------------------------------------------------------------------
/** Resolve the effective theme: themeMode 'system' (or invalid) follows the OS. */
function resolvedTheme() {
  const mode = settings.get().themeMode;
  if (mode === 'dark' || mode === 'light') return mode;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** Window base color for the resolved theme (must match --bg-app in theme.css). */
function themeBackground() {
  return resolvedTheme() === 'light' ? '#F5F5F7' : '#0A0A0C';
}

/** Push the resolved theme to every open shell window and repaint its base. */
function broadcastTheme() {
  const t = resolvedTheme();
  const bg = t === 'light' ? '#F5F5F7' : '#0A0A0C';
  for (const w of BrowserWindow.getAllWindows()) {
    w.setBackgroundColor(bg);
    w.webContents.send('shell:theme', t);
  }
}

nativeTheme.on('theme-changed', () => broadcastTheme());

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------
function updateTray() {
  if (!tray) return;
  const L = lang();
  const info = manager.getInfo();
  const pending = info.pendingVersion;
  const canRollback = info.installed && info.installed.length > 1;
  // peak/off-peak status line (only when split pricing is enabled)
  const cfg = settings.get();
  const windows = peakWindowsOf(cfg);
  const peakItems = [];
  if (windows) {
    const ps = cost.peakStatus(Date.now(), windows);
    const flatOut = cfg.costOutputPerM || 0;
    const peakOut = cfg.costPeakOutputPerM || 0;
    const hasPeakRate = !!(cfg.costPeakInputPerM || cfg.costPeakOutputPerM || cfg.costPeakCacheReadPerM || cfg.costPeakCacheWritePerM);
    const rate = ps.peak ? (hasPeakRate ? peakOut : flatOut) : flatOut;
    peakItems.push({
      label: ps.peak
        ? t(L, 'tray.peakOn', { r: rate, m: ps.nextChangeInMin })
        : t(L, 'tray.peakOff', { r: rate, m: ps.nextChangeInMin }),
      enabled: false,
    });
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t(L, 'tray.open'), click: () => showMain() },
    ...peakItems,
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
  if (!pending) throw new Error(t(lang(), 'update.noPending'));
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
  remote.setPublicMode(!!saved.remotePublic); // C7 posture follows the switch, no restart needed
  remote.stop();
  if (saved.remoteControl) {
    remote.setRuntimeUrl(runtimeUrl);
    remote.start({ port: saved.remotePort, compat: !!saved.remoteCompat })
      .then((s) => { if (!s.running) notify(t(lang(), 'notify.remoteFailed'), t(lang(), 'notify.remoteFailedBody')); })
      .catch((e) => log(`[remote] start failed: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// public remote access (C7): Tailscale detection + cloudflared quick tunnel
// ---------------------------------------------------------------------------
const PUBLIC_REMOTE_MODES = ['lan', 'tailscale', 'cloudflare'];

function publicRemoteModeLabel(mode) {
  const key = { lan: 'publicRemote.modeLan', tailscale: 'publicRemote.modeTailscale', cloudflare: 'publicRemote.modeCloudflare' }[mode];
  return key ? t(lang(), key) : String(mode);
}

/** Snapshot for the settings page: switch state, both detectors, tunnel, links. */
async function publicRemoteStatus(force = false) {
  const st = remote ? remote.status() : { running: false, port: null, secure: true, pairingCode: null };
  const mode = PUBLIC_REMOTE_MODES.includes(settings.get().remotePublicMode) ? settings.get().remotePublicMode : 'lan';
  const pub = !!settings.get().remotePublic;
  const [ts, cf, tunnel] = await Promise.all([
    publicRemote ? publicRemote.detectTailscale(force) : Promise.resolve(null),
    publicRemote ? publicRemote.detectCloudflared(force) : Promise.resolve(null),
    Promise.resolve(publicRemote ? publicRemote.tunnelStatus() : { running: false, url: null }),
  ]);
  const code = st.pairingCode;
  const pair = (base) => (base && code ? `${base}${PAIR_PATH}?c=${code}` : null);
  const tsReady = pub && mode === 'tailscale' && ts && ts.state === 'loggedIn' && st.running;
  return {
    publicMode: pub,
    mode,
    gateway: {
      running: st.running,
      port: st.port,
      secure: st.secure,
      pairingCode: code,
      pairingExpiresAt: st.pairingExpiresAt || null,
    },
    tailscale: ts,
    cloudflared: cf,
    tunnel,
    links: {
      lan: st.running && st.urls && st.urls.length ? pair(st.urls[0]) : null,
      tailscale: tsReady ? buildPairUrl(ts.ipv4, st.port, st.secure, code) : null,
      tailscaleDns: tsReady ? buildPairUrl(ts.dnsName, st.port, st.secure, code) : null,
      tunnel: tunnel && tunnel.url ? pair(tunnel.url) : null,
    },
  };
}

/** Enable public access — refuses to run without the renderer's explicit confirm. */
function enablePublicRemote(mode, confirmed) {
  if (confirmed !== true) return { ok: false, reason: 'confirm-required' };
  const m = PUBLIC_REMOTE_MODES.includes(mode) && mode !== 'lan' ? mode : 'tailscale';
  settings.patch({ remotePublic: true, remotePublicMode: m });
  if (remote) remote.setPublicMode(true); // also audits the switch via the gateway log
  log(`[remote] public access enabled (mode=${m})`);
  notify(t(lang(), 'notify.publicRemoteOn'), t(lang(), 'notify.publicRemoteOnBody', { mode: publicRemoteModeLabel(m) }));
  return { ok: true, mode: m };
}

/** Disable public access and take the temporary tunnel down with it. */
function disablePublicRemote() {
  settings.patch({ remotePublic: false });
  if (remote) remote.setPublicMode(false);
  if (publicRemote) publicRemote.stopTunnel(); // public exposure ends with the switch
  log('[remote] public access disabled');
  notify(t(lang(), 'notify.publicRemoteOff'), t(lang(), 'notify.publicRemoteOffBody'));
  return { ok: true };
}

/** Start a cloudflared quick tunnel to the running gateway port. */
async function startQuickTunnel() {
  if (!publicRemote) return { ok: false, reason: 'not-ready' };
  const st = remote ? remote.status() : null;
  if (!st || !st.running || !st.port) return { ok: false, reason: 'gateway-not-running' };
  const r = await publicRemote.startTunnel(st.port);
  if (r.ok) notify(t(lang(), 'notify.tunnelStarted'), t(lang(), 'notify.tunnelStartedBody', { url: r.url }));
  else notify(t(lang(), 'notify.tunnelFailed'), t(lang(), 'notify.tunnelFailedBody', { reason: r.reason }));
  return r;
}

function stopQuickTunnel() {
  if (!publicRemote) return { ok: false };
  publicRemote.stopTunnel();
  return { ok: true };
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
    broadcastTheme(); // a saved themeMode override may change every window
    updateTray();
    if (remote && (saved.remoteControl !== before.remoteControl || saved.remotePort !== before.remotePort || saved.remoteCompat !== before.remoteCompat)) {
      applyRemoteSettings(saved);
    }
    // C7: the public-access switch changes the gateway's auth posture, not
    // its listener — follow it live (and audit the transition there).
    if (remote && saved.remotePublic !== before.remotePublic) {
      remote.setPublicMode(!!saved.remotePublic);
    }
    return saved;
  });
  ipcMain.handle('shell:get-theme', () => resolvedTheme());
  ipcMain.handle('shell:pick-folder', async (_e, kind) => {
    const res = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: kind === 'workspace'
        ? t(lang(), 'dialog.pickWorkspace')
        : kind === 'skills' ? t(lang(), 'dialog.pickSkillDir') : t(lang(), 'dialog.pickDshHome'),
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
  // curated market from awesome-dsh-plugin (CC0); last-resort fallback to the
  // legacy topic search so the market never renders empty due to one outage
  ipcMain.handle('plugins:market', async (_e, force) => {
    try {
      return await marketPayload(Boolean(force));
    } catch (e) {
      log(`[shell] curated market unavailable (${e.message}); falling back to topic search`);
      try {
        return { ok: true, source: 'fallback', fetchedAt: 0, categories: [], plugins: await fetchPlugins('') };
      } catch (e2) {
        return { ok: false, reason: e2.message };
      }
    }
  });
  ipcMain.handle('shell:plugin-action', (_e, action, fullName) => pluginAction(action, fullName));
  // skills center (C4): market + installed in one payload; actions below
  ipcMain.handle('shell:skills-list', async (_e, force) => {
    try {
      const installed = skillsMgr.listInstalled();
      const { source, entries, fetchedAt } = await fetchMarketData(Boolean(force));
      const starMap = await fetchStarMap();
      const repos = new Set(installed.filter((s) => s.repo).map((s) => s.repo));
      return { ok: true, source, fetchedAt, installed, ...buildSkillsMarketPayload(entries, starMap, repos) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:skills-preview', (_e, fullName) => skillsAction('preview', fullName));
  ipcMain.handle('shell:skills-install', (_e, fullName, pick) => skillsAction('install', fullName, pick));
  ipcMain.handle('shell:skills-remove', (_e, name) => skillsAction('remove', name));
  ipcMain.handle('shell:skills-upgrade', (_e, name) => skillsAction('upgrade', name));
  ipcMain.handle('shell:skills-import', (_e, dir, pick) => skillsAction('import', dir, pick));
  ipcMain.handle('shell:profile-snapshots', () => {
    try {
      const base = profileSnapshotDir();
      return fs.readdirSync(base)
        .filter((d) => fs.existsSync(path.join(base, d, 'meta.json')))
        .sort()
        .reverse()
        .map((d) => {
          try { return { id: d, ...JSON.parse(fs.readFileSync(path.join(base, d, 'meta.json'), 'utf8')) }; }
          catch { return { id: d, time: '', label: d }; }
        });
    } catch { return []; }
  });
  ipcMain.handle('shell:restore-snapshot', (_e, id) => {
    try {
      restoreProfileSnapshot(String(id));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:safe-mode', () => {
    enterSafeMode();
    return { ok: true };
  });
  // manual fallback for "plugin installed but webUI did not refresh": same
  // restart the tray uses; refuse (instead of quitting) when no runtime exists
  ipcMain.handle('shell:restart-runtime', () => {
    if (!activeDshBin()) return { ok: false, reason: 'no runtime found' };
    restartRuntime();
    return { ok: true };
  });
  ipcMain.handle('shell:cost-info', async () => {
    const stats = await collectStats();
    return costSnapshot(stats);
  });
  // official account balance (C1): snapshot for display + forced refresh
  ipcMain.handle('shell:balance-info', () => ({
    snapshot: balanceMonitor ? balanceMonitor.snapshot() : null,
    threshold: balance.lowBalanceThreshold(settings.get().monthlyBudget || 0),
  }));
  ipcMain.handle('shell:balance-refresh', async () => {
    if (!balanceMonitor) return { ok: false, reason: 'not ready' };
    try {
      const snap = await balanceMonitor.refresh({ force: true });
      return snap ? { ok: true, snapshot: snap } : { ok: false, reason: 'DEEPSEEK_API_KEY not found' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:diagnostics-info', () => diagnosticsInfo());
  ipcMain.handle('shell:open-diagnostics', () => shell.openPath(diagnosticsDir()));
  ipcMain.handle('quickask:submit', (_e, prompt) => handleQuickAskSubmit(prompt));
  ipcMain.on('quickask:close', () => { if (quickAskWindow) quickAskWindow.close(); });
  ipcMain.handle('shell:scheduled-list', () => ({
    tasks: settings.get().scheduledTasks || [],
    running: [...scheduledRunning],
  }));
  ipcMain.handle('shell:scheduled-upsert', (_e, task) => {
    // sanitize: keep only known fields with sane types
    const kind = ['every', 'daily', 'weekly'].includes(task.kind) ? task.kind : 'every';
    const weeklyDay = Number(task.weeklyDay);
    const clean = {
      id: typeof task.id === 'string' && task.id ? task.id : undefined,
      name: typeof task.name === 'string' ? task.name.slice(0, 100) : t(lang(), 'scheduled.defaultName'),
      prompt: typeof task.prompt === 'string' ? task.prompt.slice(0, 4000) : '',
      templateId: typeof task.templateId === 'string' ? task.templateId.slice(0, 64) : undefined,
      kind,
      everySeconds: Math.max(60, Number(task.everySeconds) || 3600),
      dailyTime: /^\d{1,2}:\d{2}$/.test(task.dailyTime || '') ? task.dailyTime : '09:00',
      weeklyDay: Number.isInteger(weeklyDay) && weeklyDay >= 0 && weeklyDay <= 6 ? weeklyDay : 1,
      weeklyTime: /^\d{1,2}:\d{2}$/.test(task.weeklyTime || '') ? task.weeklyTime : '09:00',
      enabled: task.enabled !== false,
      nextRunAt: Number(task.nextRunAt) || undefined,
      lastRunAt: typeof task.lastRunAt === 'string' ? task.lastRunAt : undefined,
    };
    const list = settings.get().scheduledTasks || [];
    if (clean.id) {
      const idx = list.findIndex((t) => t.id === clean.id);
      if (idx !== -1) {
        const old = list[idx];
        // schedule semantics changed → drop the stale nextRunAt so the
        // scheduler recomputes from the new plan instead of firing at the
        // old (possibly already-due) moment
        const samePlan = old.kind === clean.kind
          && (clean.kind !== 'every' || old.everySeconds === clean.everySeconds)
          && (clean.kind !== 'daily' || old.dailyTime === clean.dailyTime)
          && (clean.kind !== 'weekly' || (old.weeklyDay === clean.weeklyDay && old.weeklyTime === clean.weeklyTime));
        if (!samePlan) clean.nextRunAt = undefined;
        list[idx] = { ...old, ...clean };
      } else list.push(clean);
    } else {
      clean.id = `task-${Date.now()}`;
      clean.nextRunAt = undefined; // fresh task: let the scheduler plan the first run
      list.push(clean);
    }
    settings.patch({ scheduledTasks: list });
    startScheduler();
    broadcastScheduled();
    return { ok: true, tasks: settings.get().scheduledTasks };
  });
  ipcMain.handle('shell:scheduled-remove', (_e, id) => {
    const list = (settings.get().scheduledTasks || []).filter((t) => t && t.id !== id);
    settings.patch({ scheduledTasks: list });
    startScheduler();
    broadcastScheduled();
    return { ok: true };
  });
  ipcMain.handle('shell:scheduled-history', () => settings.get().scheduledHistory || []);
  ipcMain.handle('shell:scheduled-clear-history', () => {
    settings.patch({ scheduledHistory: [] });
    broadcastScheduled();
    return { ok: true };
  });
  ipcMain.handle('shell:scheduled-run', async (_e, id) => {
    const task = (settings.get().scheduledTasks || []).find((tk) => tk && tk.id === id);
    if (!task) return { ok: false, reason: 'task not found' };
    if (scheduledRunning.has(id)) return { ok: false, reason: 'already running' };
    scheduledRunning.add(id);
    broadcastScheduled();
    try {
      const r = await runScheduledTask(task);
      return { ok: !!r.ok };
    } finally {
      scheduledRunning.delete(id);
      settings.save(); // persist any nextRunAt/lastRunAt mutation
      broadcastScheduled();
    }
  });
  // "create in chat": copy a guiding prompt, surface the main window, notify
  ipcMain.handle('shell:copy-and-show', (_e, text, title, body) => {
    clipboard.writeText(String(text || ''));
    showMain();
    if (title) notify(String(title), String(body || ''));
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

  // public remote access (C7): Tailscale detection + cloudflared quick tunnel.
  // Enabling demands the renderer's explicit second confirmation (public
  // network warning); the main process re-checks the flag and audits.
  ipcMain.handle('shell:public-remote-status', (_e, force) => publicRemoteStatus(!!force));
  ipcMain.handle('shell:public-remote-enable', (_e, mode, confirmed) => enablePublicRemote(mode, confirmed));
  ipcMain.handle('shell:public-remote-disable', () => disablePublicRemote());
  ipcMain.handle('shell:tunnel-start', () => startQuickTunnel());
  ipcMain.handle('shell:tunnel-stop', () => stopQuickTunnel());

  // IM channels (C5): settings-window surface. All channel state mutations run
  // in the main process; the renderer only renders statusAll() snapshots.
  ipcMain.handle('shell:channels-list', () => (channelsMgr ? { channels: channelsMgr.statusAll() } : { channels: [] }));
  ipcMain.handle('shell:channels-toggle', (_e, id, enabled) => (
    channelsMgr ? channelsMgr.toggle(String(id || ''), !!enabled) : { ok: false, reason: 'not ready' }
  ));
  ipcMain.handle('shell:channels-allowfrom', (_e, id, allowFrom) => (
    channelsMgr ? channelsMgr.setAllowFrom(String(id || ''), allowFrom) : { ok: false, reason: 'not ready' }
  ));
  // C6: credentials live in the main-process safeStorage vault; the renderer
  // sends field values, gets back booleans/result shapes only (never secrets)
  ipcMain.handle('shell:channels-configure', (_e, id, values) => (
    channelsMgr ? channelsMgr.configureSecrets(String(id || ''), values) : { ok: false, reason: 'not ready' }
  ));
  ipcMain.handle('shell:channels-test', (_e, id, values) => (
    channelsMgr ? channelsMgr.testChannel(String(id || ''), values) : { ok: false, reason: 'not ready' }
  ));

  // model provider panel (C2): test/fetch run in the main process so the API
  // key never crosses into the renderer — only result shapes go back
  ipcMain.handle('shell:models-list', () => (modelsMgr ? modelsMgr.list() : {
    presets: MODELS_PRESETS, ollamaPreset: MODELS_OLLAMA_PRESET, profiles: [], default: null,
  }));
  ipcMain.handle('shell:models-save', (_e, profile, apiKey) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    try {
      const r = modelsMgr.save(profile, apiKey);
      return r;
    } catch (e) {
      log(`[models] save failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:models-remove', (_e, id) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    try {
      const r = modelsMgr.remove(String(id || ''));
      if (r.ok) {
        notify(t(lang(), 'notify.modelsRemoved'), t(lang(), 'notify.modelsRemovedBody', { id: String(id || '') }));
      }
      return r;
    } catch (e) {
      log(`[models] remove failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('shell:models-test', async (_e, target) => {
    if (!modelsMgr) return { ok: false, kind: 'other', reason: 'not ready' };
    return modelsMgr.test(target || {});
  });
  ipcMain.handle('shell:ollama-status', async () => {
    if (!modelsMgr) return { installed: false, version: null, models: [], registered: false, reason: 'not ready' };
    return modelsMgr.ollamaStatus();
  });
  ipcMain.handle('shell:models-set-default', (_e, provider, model) => {
    if (!modelsMgr) return { ok: false, reason: 'not ready' };
    const r = modelsMgr.setDefault(provider, model);
    if (r.ok) {
      notify(t(lang(), 'notify.modelsDefaultSet'), t(lang(), 'notify.modelsDefaultSetBody', {
        provider: String(provider || ''), model: String(model || ''),
      }));
    }
    return r;
  });
  // Copy for the settings window (file:// pages have no navigator.clipboard).
  ipcMain.handle('shell:copy-text', (_e, text) => {
    if (typeof text === 'string' && text.length > 0 && text.length <= 4096) clipboard.writeText(text);
    return null;
  });
  ipcMain.on('search:close', () => { if (searchWindow) searchWindow.close(); });

  // injected window chrome
  ipcMain.on('chrome:open-settings', () => createSettingsWindow());
  ipcMain.on('chrome:refresh-tokens', async () => {
    try {
      const stats = await collectStats();
      pushTokens(stats);
      costSnapshot(stats);
    } catch (e) { log(`[shell] manual token refresh failed: ${e.message}`); }
  });
  ipcMain.on('chrome:set-workspace', (_e, ws) => setWorkspace(ws));
  ipcMain.on('chrome:report', (_e, info) => {
    log(`[shell] chrome placed at top=${info.top} right=${info.right} (controls found: ${info.found}, saved pos: ${info.saved})`);
  });
  ipcMain.on('chrome:compact-now', async () => { await compactNow(); }); // pill context menu (C3)

  // long-session center (C3): compaction + AGENTS.md memory files
  ipcMain.handle('shell:compact-now', async () => compactNow());
  ipcMain.handle('shell:compact-status', () => ({
    compacting: compactTracker ? compactTracker.isCompacting() : false,
    sessionRunning,
    last: compactTracker ? (compactTracker.history()[0] || null) : null,
  }));
  ipcMain.handle('shell:compact-history', () => (compactTracker ? compactTracker.history() : []));
  ipcMain.handle('shell:memory-get', (_e, scope) => memory.get(String(scope || '')));
  ipcMain.handle('shell:memory-save', async (_e, scope, content) => {
    const r = await memory.save(String(scope || ''), typeof content === 'string' ? content : '');
    if (r.ok) notify(t(lang(), 'memory.saved'), t(lang(), 'memory.savedBody', { path: r.path }));
    else log(`[memory] save failed: ${r.code} (${r.reason || ''})`);
    return r;
  });
  ipcMain.handle('shell:memory-delete', async (_e, scope) => {
    const r = await memory.remove(String(scope || ''));
    if (r.ok) notify(t(lang(), 'memory.deleted'), t(lang(), 'memory.deletedBody', { path: r.path }));
    else log(`[memory] delete failed: ${r.code} (${r.reason || ''})`);
    return r;
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

// topic keyword -> plugin-center category. Priority-ordered: the first rule
// whose keyword appears in the repo topics wins (case-insensitive exact
// match); repos hitting nothing fall back to 'other'.
// NOTE: real skin repos tag themselves 'web-ui'/'sidebar'/'tui'/'statusline'
// (they almost never use the literal topic 'theme'), so those live here.
const PLUGIN_CATEGORY_RULES = [
  ['theme', ['skin', 'theme', 'themes', 'dsh-web-ui', 'skin-center', 'appearance', 'web-ui', 'sidebar', 'statusline', 'tui', 'ui-theme']],
  ['skills', ['skills', 'skill', 'agent-skills', 'skill-generator', 'prompt-engineering', 'prompts']],
  ['workflow', ['workflow-automation', 'automation', 'task-board', 'kanban', 'chat-management', 'productivity', 'tasks']],
  ['memory', ['agent-memory', 'memory', 'context-database', 'rag', 'knowledge', 'context-engineering', 'vfs']],
  ['design', ['design', 'ui-generator', 'prototyping', 'design-systems', 'figma-alternative']],
  // fun before devtools: mascot/pet/pixel-art are stronger signals than a
  // generic 'cli'/'developer-tools' topic most repos also carry
  ['fun', ['pet', 'mascot', 'pixel-art', 'toy', 'game']],
  ['devtools', ['mcp', 'cli', 'developer-tools', 'testing', 'monitoring', 'observability', 'linters']],
];

// skin-flavored words that show up in repo *descriptions* when the repo has
// no recognizable topic (zh repos usually say 皮肤/主题 in the description)
const THEME_DESC_HINTS = /皮肤|主题|外观|\bskin\b|\bthemes?\b|\bappearance\b|\blook-and-feel\b/i;

/** Map GitHub topics (+ description fallback) to a plugin-center category. */
function categorize(topics, description) {
  const set = new Set((Array.isArray(topics) ? topics : []).map((t) => String(t).toLowerCase()));
  for (const [category, keywords] of PLUGIN_CATEGORY_RULES) {
    for (const k of keywords) if (set.has(k)) return category;
  }
  if (description && THEME_DESC_HINTS.test(String(description))) return 'theme';
  return 'other';
}

async function fetchPlugins(keyword) {
  // broad search: repos matching "<keyword> dsh" — covers plugins that never
  // tagged the dsh-plugin topic and are absent from the curated list
  const kw = String(keyword || '').trim().slice(0, 60);
  const q = kw ? `${kw} dsh` : 'topic:dsh-plugin';
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`;
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
    topics: Array.isArray(it.topics) ? it.topics : [],
    category: categorize(it.topics, it.description),
  }));
}

// ---- curated market (awesome-dsh-plugin, CC0-1.0) ---------------------------
const { parseAwesomeReadme, parseZhDescriptions, buildMarketPayload, isCacheFresh } = require('./market');
const MARKET_REPO = 'awesome-dsh-plugin/awesome-dsh-plugin';

async function fetchText(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'dsh-cockpit' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** One tolerant search-API call for star/update enrichment (not required). */
async function fetchStarMap() {
  try {
    const url = 'https://api.github.com/search/repositories?q=topic%3Adsh-plugin&per_page=100';
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cockpit' } });
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    for (const it of data.items || []) map[it.full_name] = { stars: it.stargazers_count || 0, updated: (it.updated_at || '').slice(0, 10) };
    return map;
  } catch {
    return {}; // stars are cosmetic — never fail the market because of them
  }
}

/**
 * Curated list with a 24h on-disk cache: fresh cache serves instantly; fetch
 * failures fall back to a stale cache rather than an empty market.
 */
async function fetchMarketData(force) {
  const cacheFile = path.join(app.getPath('userData'), 'market-cache.json');
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* no cache yet */ }
  if (!force && isCacheFresh(cache)) {
    return { source: 'cache', entries: cache.entries, fetchedAt: cache.fetchedAt };
  }
  try {
    const base = `https://raw.githubusercontent.com/${MARKET_REPO}/main`;
    const [en, zh] = await Promise.all([
      fetchText(`${base}/README.md`),
      fetchText(`${base}/README.zh.md`).catch(() => ''), // zh descriptions are optional
    ]);
    const entries = parseAwesomeReadme(en);
    if (!entries.length) throw new Error('curated list parse produced 0 plugins');
    const zhDesc = parseZhDescriptions(zh);
    for (const e of entries) e.descZh = zhDesc.get(e.fullName) || '';
    cache = { fetchedAt: Date.now(), entries };
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) { log(`[shell] market cache write failed: ${e.message}`); }
    return { source: 'live', entries, fetchedAt: cache.fetchedAt };
  } catch (e) {
    if (cache && Array.isArray(cache.entries) && cache.entries.length) {
      log(`[shell] market fetch failed (${e.message}); serving stale cache`);
      return { source: 'stale', entries: cache.entries, fetchedAt: cache.fetchedAt || 0 };
    }
    throw e;
  }
}

async function marketPayload(force) {
  const { source, entries, fetchedAt } = await fetchMarketData(force);
  const starMap = await fetchStarMap();
  const installed = new Set([...(settings.get().installedPlugins || []), ...parseProfilePlugins()]);
  return { ok: true, source, fetchedAt, ...buildMarketPayload(entries, starMap, installed) };
}

/** Run `dsh plugin --profile web <args>`; output to a log file (fd, sandbox-safe).
 * Resolves { ok, code: 'exit'|'timeout'|'spawn', output }. `onTail({stage,tail})`
 * streams incremental child output so the market UI can show live progress. */
function runDshPlugin(args, timeoutMs = 120_000, onTail = null) {
  const node = bestNodeBin();
  const binJs = activeDshBin();
  const dshHome = dshHomeOf();
  const outFile = path.join(ensureLogDir(), `plugin-${Date.now()}.out`);
  let fd = -1;
  try { fd = fs.openSync(outFile, 'a'); } catch { /* ignore */ }
  let fdOpen = fd !== -1;
  const closeFd = () => {
    if (!fdOpen) return;
    fdOpen = false;
    try { fs.closeSync(fd); } catch { /* ignore */ }
  };
  return new Promise((resolve) => {
    const env = { ...process.env, DSH_HOME: dshHome };
    if (node.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    let child;
    try {
      child = spawn(node.bin, [binJs, 'plugin', '--profile', 'web', ...args], {
        env, cwd: dshHome, windowsHide: true, stdio: fd === -1 ? 'ignore' : ['ignore', fd, fd],
      });
    } catch (e) {
      closeFd();
      resolve({ ok: false, code: 'spawn', output: e.message });
      return;
    }
    // incremental tail of the output file -> progress events for the market UI
    let tailBytes = 0;
    let tailTimer = null;
    const stopTail = () => { if (tailTimer) { clearInterval(tailTimer); tailTimer = null; } };
    if (onTail) {
      tailTimer = setInterval(() => {
        try {
          const buf = fs.readFileSync(outFile);
          if (buf.length > tailBytes) {
            const chunk = buf.slice(tailBytes).toString('utf8');
            tailBytes = buf.length;
            const lines = chunk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            onTail({ stage: inferStage(chunk), tail: lines.length ? lines[lines.length - 1].slice(0, 200) : '' });
          }
        } catch { /* file may not exist yet */ }
      }, 800);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      // escalate if the child tree ignores SIGTERM (stuck git/npm)
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
      stopTail();
      closeFd();
      resolve({ ok: false, code: 'timeout', output: 'timeout' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      stopTail();
      closeFd();
      resolve({ ok: false, code: 'spawn', output: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      stopTail();
      closeFd();
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      log(`[shell] dsh plugin ${args.join(' ')} -> exit ${code}`);
      resolve({ ok: code === 0, code: 'exit', output: out.slice(-2000) });
    });
  });
}

/** Forward plugin-install progress to the settings window (plugin center). */
function sendMarketProgress(info) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.webContents.send('plugins:progress', info); } catch { /* ignore */ }
  }
}

/** Forward skill install/upgrade progress (resolve → download → verify → write). */
function sendSkillsProgress(info) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try { settingsWindow.webContents.send('skills:progress', info); } catch { /* ignore */ }
  }
}

/** Map validation errors [{code, params}] to readable localized lines. */
function skillsErrorReason(errors) {
  return (Array.isArray(errors) ? errors : [])
    .map((e) => t(lang(), `skills.${e.code}`, e.params || {}))
    .join('；');
}

/** skills.js result codes are kebab-case ('plugin-form', 'no-source', …)
 * while the i18n keys are camelCase (skills.pluginForm) — bridge them. */
function skillsCodeKey(code) {
  return String(code || '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Serialized skill operations (install/upgrade/remove/import/preview).
 * Skills are pure files — no runtime restart here; dsh picks them up via its
 * skills watcher and they apply to new sessions. Bundle-plugin-form skill
 * packs (package.json + dsh bundle) are delegated to the plugin pipeline.
 */
async function skillsAction(op, arg, pick) {
  if (!skillsGuard.tryBegin(op, String(arg || ''))) {
    return { ok: false, code: 'busy', reason: t(lang(), 'skills.busy') };
  }
  try {
    let r;
    if (op === 'preview') r = await skillsMgr.preview(String(arg || ''));
    else if (op === 'install') r = await skillsMgr.install(String(arg || ''), pick === undefined ? null : pick);
    else if (op === 'remove') r = skillsMgr.remove(String(arg || ''));
    else if (op === 'upgrade') r = await skillsMgr.upgrade(String(arg || ''));
    else if (op === 'import') r = skillsMgr.importLocal(String(arg || ''));
    else r = { ok: false, code: 'invalid', reason: 'unknown op' };

    // bundle-plugin skill packs live in the plugin pipeline (restart applies)
    if (!r.ok && r.code === 'plugin-form' && op === 'install') {
      log(`[skills] ${arg} is a bundle-plugin skill pack; delegating to plugin install`);
      const pr = await pluginAction('add', String(arg));
      return { ...pr, delegated: 'plugin' };
    }

    if (!r.ok && Array.isArray(r.errors) && !r.reason) {
      r.reason = skillsErrorReason(r.errors) || t(lang(), `skills.${skillsCodeKey(r.code) || 'e1'}`);
    } else if (!r.ok && !r.reason && r.code) {
      const key = `skills.${skillsCodeKey(r.code)}`;
      const text = t(lang(), key);
      r.reason = text !== key ? text : r.code;
    }

    if (r.ok && op === 'remove') {
      notify(t(lang(), 'skills.removed'), t(lang(), 'skills.removedBody', { name: String(arg) }));
      log(`[skills] removed ${arg}`);
    } else if (r.ok && op !== 'preview') {
      const names = (r.installed || []).map((i) => i.name).join(', ') || String(arg);
      const warnings = (r.installed || []).flatMap((i) => i.warnings || []);
      const body = t(lang(), 'skills.installedBody', { name: names })
        + (warnings.length ? `\n${warnings.map((w) => t(lang(), `skills.${w.code}`, w.params || {})).join('\n')}` : '');
      notify(t(lang(), 'skills.installed'), body);
      log(`[skills] ${op} ok: ${names}`);
    } else if (!r.ok && r.code !== 'multi' && r.code !== 'busy' && op !== 'preview') {
      notify(t(lang(), 'skills.failed'), t(lang(), 'skills.failedBody', { name: String(arg), reason: r.reason || r.code }));
      log(`[skills] ${op} ${arg} failed (${r.code}): ${r.reason || ''}`);
    }
    return r;
  } finally {
    skillsGuard.release();
  }
}

/** Profile paths for the web runtime. */
function profileDirOf() { return path.join(dshHomeOf(), 'profiles', 'web'); }

function profilePackageJson() { return path.join(profileDirOf(), 'package.json'); }

/**
 * Write a file inside the profile dir, degrading through direct write →
 * temp+rename → shell copy. Some endpoint-security agents block node
 * processes from rewriting profile manifests by file name (npm supply-chain
 * protection); zsh redirection is typically exempt.
 */
function writeProfileFile(file, content) {
  try {
    fs.writeFileSync(file, content);
    return;
  } catch (e1) {
    log(`[shell] ${path.basename(file)} direct write failed (${e1.code}); trying temp+rename`);
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    return;
  } catch (e2) {
    log(`[shell] ${path.basename(file)} temp+rename failed (${e2.code}); trying shell copy`);
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  const { execFileSync } = require('node:child_process');
  const shell = process.platform === 'win32' ? 'cmd' : '/bin/zsh';
  const redirect = process.platform === 'win32'
    ? `type ${JSON.stringify(tmp)} > ${JSON.stringify(file)} & del ${JSON.stringify(tmp)}`
    : `cat ${JSON.stringify(tmp)} > ${JSON.stringify(file)} && rm -f ${JSON.stringify(tmp)}`;
  try {
    fs.writeFileSync(tmp, content);
    execFileSync(shell, process.platform === 'win32' ? ['/d', '/s', '/c', redirect] : ['-c', redirect]);
  } catch (e3) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e3;
  }
}

function writeProfilePackage(content) { writeProfileFile(profilePackageJson(), content); }

/** The profile manifest files captured by a snapshot (all tiny text files). */
const PROFILE_SNAPSHOT_FILES = ['package.json', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml'];
const PROFILE_SNAPSHOT_KEEP = 8;

function profileSnapshotDir() { return path.join(app.getPath('userData'), 'profile-snapshots'); }

/**
 * Capture the profile manifests before/after risky operations so the shell can
 * always roll a broken profile back (dangling bundles, bad patches, hostile
 * plugins) without touching runtime-managed node_modules.
 */
function snapshotProfile(label) {
  try {
    const dir = profileDirOf();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapDir = path.join(profileSnapshotDir(), `${stamp}-${label}`);
    fs.mkdirSync(snapDir, { recursive: true });
    let meta = { time: new Date().toISOString(), label };
    try {
      const pkg = JSON.parse(fs.readFileSync(profilePackageJson(), 'utf8'));
      meta.plugins = Object.keys(pkg.dependencies || {});
      meta.bundles = (pkg?.dsh?.profile?.bundles || []).length;
    } catch { /* manifest unreadable — snapshot anyway */ }
    for (const f of PROFILE_SNAPSHOT_FILES) {
      try { fs.copyFileSync(path.join(dir, f), path.join(snapDir, f)); } catch { /* absent file — skip */ }
    }
    fs.writeFileSync(path.join(snapDir, 'meta.json'), JSON.stringify(meta, null, 2));
    // retain the newest PROFILE_SNAPSHOT_KEEP snapshots
    const all = fs.readdirSync(profileSnapshotDir()).filter((d) => !d.startsWith('.')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - PROFILE_SNAPSHOT_KEEP))) {
      try { fs.rmSync(path.join(profileSnapshotDir(), old), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    log(`[shell] profile snapshot saved: ${stamp}-${label}`);
    return `${stamp}-${label}`;
  } catch (e) {
    log(`[shell] profile snapshot failed: ${e.message}`);
    return null;
  }
}

/** Restore a snapshot id captured by snapshotProfile; runtime restarts after. */
function restoreProfileSnapshot(id) {
  if (!/^[\w.-]+-[\w.-]+$/.test(id)) throw new Error('invalid snapshot id');
  const snapDir = path.join(profileSnapshotDir(), id);
  fs.accessSync(snapDir);
  snapshotProfile('pre-restore'); // safety net before mutating the profile
  const dir = profileDirOf();
  let restored = 0;
  for (const f of PROFILE_SNAPSHOT_FILES) {
    try {
      writeProfileFile(path.join(dir, f), fs.readFileSync(path.join(snapDir, f), 'utf8'));
      restored += 1;
    } catch { /* not in snapshot — leave current file */ }
  }
  try { fs.rmSync(path.join(dir, 'pnpm-lock.yaml'), { force: true }); } catch { /* ignore */ }
  log(`[shell] profile snapshot ${id} restored (${restored} files)`);
  restartRuntime();
  return restored;
}

/**
 * Reset the profile to the official minimum (base + web-app bundles, no
 * third-party deps). The rescue path when a plugin crashes the runtime: the
 * shell stays alive, so it can always offer this from settings or the
 * crash-loop dialog.
 */
function enterSafeMode() {
  snapshotProfile('pre-safe-mode');
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  };
  writeProfilePackage(JSON.stringify(pkg, null, 2) + '\n');
  const dir = profileDirOf();
  try { fs.rmSync(path.join(dir, 'pnpm-lock.yaml'), { force: true }); } catch { /* ignore */ }
  settings.patch({ installedPlugins: [] });
  log('[shell] safe mode: profile reset to official bundles only');
  restartRuntime();
  updateTray();
}

/**
 * Last-resort removal when `dsh plugin remove` fails (e.g. pnpm EPERM on
 * locked-down machines, or a collection repo whose root install left a
 * package without package.json that pnpm cannot uninstall). Prunes BOTH the
 * dependency entry AND the bundle registration (a dangling bundle reference
 * crashes the runtime on every boot), plus the node_modules directory and the
 * lockfile; the next `plugin add` re-resolves everything cleanly.
 */
function forcePrunePlugin(fullName) {
  const dir = profileDirOf();
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(profilePackageJson(), 'utf8')); } catch { /* missing/unreadable — still try dir removal */ }
  const deps = pkg.dependencies || {};
  // a root install and a subpackage install can both point at the same repo
  // (e.g. root residue after a failed prune) — drop every matching entry
  const keys = [];
  let k;
  while ((k = resolveDepKey(deps, fullName))) { keys.push(k); delete deps[k]; }
  if (!keys.length) keys.push(fullName.split('/')[1]);
  // candidate names for the bundle registration: dep keys plus each plugin's
  // real package name (may differ from the dep key)
  const names = [...keys];
  for (const key of keys) {
    try {
      const nm = JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', ...key.split('/'), 'package.json'), 'utf8')).name;
      if (nm) names.push(nm);
    } catch { /* already gone */ }
  }
  pruneBundles(pkg, names);
  if (!Object.keys(deps).length) delete pkg.dependencies;
  writeProfilePackage(JSON.stringify(pkg, null, 2) + '\n');
  for (const key of keys) {
    fs.rmSync(path.join(dir, 'node_modules', ...String(key).split('/')), { recursive: true, force: true });
  }
  try { fs.rmSync(path.join(dir, 'pnpm-lock.yaml'), { force: true }); } catch { /* ignore */ }
  log(`[shell] force-pruned plugin ${fullName} (deps ${keys.join(', ')}) from profile`);
  return keys[0];
}

/** Detect collection repos (no root package.json) and return their subpackage. */
async function findSubpackage(fullName) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-cockpit' };
  try {
    const repoRes = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
    if (!repoRes.ok) return null;
    const branch = (await repoRes.json()).default_branch || 'main';
    const treeRes = await fetch(`https://api.github.com/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers });
    if (!treeRes.ok) return null;
    return pickSubpackage((await treeRes.json()).tree || []);
  } catch (e) {
    log(`[shell] subpackage lookup failed for ${fullName}: ${e.message}`);
    return null;
  }
}

async function pluginAction(action, fullName) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return { ok: false, code: 'invalid', reason: 'invalid repo name' };
  // serialize: two concurrent dsh plugin ops would corrupt the web profile
  if (!pluginGuard.tryBegin(action, fullName)) {
    return { ok: false, code: 'busy', reason: t(lang(), 'plugin.busy') };
  }
  try {
    // snapshot the pre-operation profile: if the plugin breaks the runtime,
    // the settings page can roll back to this exact state
    snapshotProfile(action === 'remove' ? 'pre-remove' : 'pre-install');
    const arg = action === 'remove' ? 'remove' : 'add';
    // a collection repo installed from its subpackage records the subpackage's
    // real name as the dep key — resolve it so remove hits the right entry
    let depKey = fullName.split('/')[1];
    if (action === 'remove') {
      try {
        const deps = JSON.parse(fs.readFileSync(profilePackageJson(), 'utf8')).dependencies || {};
        depKey = resolveDepKey(deps, fullName) || depKey;
      } catch { /* fall back to repo name */ }
    }
    const spec = action === 'remove' ? depKey : `github:${fullName}`;
    let result = await runDshPlugin([arg, spec], 120_000, (info) => sendMarketProgress(info));
    // pnpm v10 refuses to run a git-hosted plugin's mandatory `prepare` build
    // unless the package is in onlyBuiltDependencies. Ecosystem fallback:
    // allowlist the blocked package in the profile's workspace yaml and retry
    // once (initProfile never rewrites the file, so the entry persists).
    if (!result.ok && action !== 'remove') {
      const pkg = parsePnpmBlockedPackage(result.output);
      if (pkg) {
        const yamlPath = path.join(profileDirOf(), 'pnpm-workspace.yaml');
        try {
          const cur = fs.readFileSync(yamlPath, 'utf8');
          const next = upsertOnlyBuiltDependencies(cur, pkg);
          if (next !== cur) fs.writeFileSync(yamlPath, next);
          log(`[shell] pnpm blocked build of ${pkg}; added to onlyBuiltDependencies, retrying`);
          sendMarketProgress({ stage: 'resolve', tail: `pnpm allowlist: ${pkg}` });
          result = await runDshPlugin([arg, spec], 120_000, (info) => sendMarketProgress(info));
        } catch (e) {
          log(`[shell] could not update pnpm allowlist: ${e.message}`);
        }
      }
    }
    if (!result.ok && action === 'remove') {
      // pnpm remove can fail on locked-down machines (EPERM on package.json)
      // or on collection-repo roots pnpm cannot uninstall — prune directly so
      // the user is never stuck with an unremovable entry
      log(`[shell] dsh plugin remove failed; force-pruning ${fullName} from profile`);
      sendMarketProgress({ stage: 'cleanup', tail: '' });
      try {
        forcePrunePlugin(fullName);
        result = { ok: true, code: 'exit', output: 'force-pruned' };
      } catch (e) {
        log(`[shell] force-prune failed: ${e.message}`);
      }
    }
    if (!result.ok && action !== 'remove') {
      const code = failureCode(result);
      const reason = code === 'timeout'
        ? t(lang(), 'plugin.timeout')
        : code === 'spawn'
          ? t(lang(), 'plugin.spawnFailed', { msg: result.output || '' })
          : (summarizeOutput(result.output) || 'plugin command failed');
      log(`[shell] plugin ${action} ${fullName} failed (${code}): ${reason}`);
      notify(t(lang(), 'plugin.failed'), t(lang(), 'plugin.failedBody', { name: fullName, reason }));
      // a failed install may leave a half-applied spec in the profile — remove
      // it so later installs start clean and the market stays truthful
      if (shouldCleanupAfterFailure(action)) {
        sendMarketProgress({ stage: 'cleanup', tail: '' });
        try { forcePrunePlugin(fullName); } catch (e) { log(`[shell] plugin cleanup after failed install left residue: ${fullName} (${e.message})`); }
      }
      return { ok: false, code, reason };
    }
    // Collection repos (skin collections like dsh-deep-whale) ship no root
    // package.json: the install "succeeds" but materializes loose files the
    // runtime cannot load. Detect that and retry once from the subpackage.
    if (action !== 'remove' && result.ok) {
      const rootPkg = path.join(profileDirOf(), 'node_modules', fullName.split('/')[1], 'package.json');
      if (!fs.existsSync(rootPkg)) {
        sendMarketProgress({ stage: 'resolve', tail: 'collection repo — locating subpackage' });
        const { sub, candidates } = await findSubpackage(fullName);
        if (sub) {
          log(`[shell] ${fullName} is a collection repo; installing subpackage ${sub}`);
          sendMarketProgress({ stage: 'resolve', tail: `subpackage: ${sub}` });
          try { forcePrunePlugin(fullName); } catch (e) { log(`[shell] could not prune root residue: ${e.message}`); }
          result = await runDshPlugin(['add', `github:${fullName}#path:${sub}`], 120_000, (info) => sendMarketProgress(info));
          if (!result.ok) {
            const reason = summarizeOutput(result.output) || 'subpackage install failed';
            log(`[shell] subpackage install failed: ${reason}`);
            try { forcePrunePlugin(fullName); } catch { /* best effort */ }
            notify(t(lang(), 'plugin.failed'), t(lang(), 'plugin.failedBody', { name: `${fullName} (${sub})`, reason }));
            return { ok: false, code: 'exit', reason };
          }
        } else {
          const list = (candidates || []).join(', ');
          const reason = t(lang(), 'plugin.collectionRepo') + (list ? `: ${list}` : '');
          log(`[shell] ${fullName} has no installable root or unique subpackage (${list || 'none found'})`);
          try { forcePrunePlugin(fullName); } catch { /* best effort */ }
          notify(t(lang(), 'plugin.failed'), t(lang(), 'plugin.failedBody', { name: fullName, reason }));
          return { ok: false, code: 'invalid', reason };
        }
      }
    }
    const cur = settings.get();
    const installed = new Set(cur.installedPlugins || []);
    if (action === 'remove') installed.delete(fullName); else installed.add(fullName);
    settings.patch({ installedPlugins: [...installed] });
    snapshotProfile(action === 'remove' ? 'post-remove' : 'post-install');
    // profile changed: reload the runtime so the plugin takes effect
    restartRuntime();
    updateTray();
    if (action === 'remove') {
      notify(t(lang(), 'plugin.removed'), t(lang(), 'plugin.removedBody', { name: fullName }));
    } else {
      notify(t(lang(), 'plugin.installed'), t(lang(), 'plugin.installedBody', { name: fullName }));
    }
    return { ok: true, restarted: true };
  } finally {
    pluginGuard.release();
  }
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
  // C3: context pressure = the prompt side of the MOST RECENT request's
  // usage (stats.current.lastUsage), not the session's cumulative input —
  // long sessions used to keep the pill yellow/red long after the actual
  // context had been compacted or was far from full.
  const pressure = tokenStats.pressureOf(cur);
  const windowSize = Math.max(1024, settings.get().contextWindow || 128000);
  const pressurePct = Math.min(100, Math.round((pressure / windowSize) * 100));
  // Send only what the pill needs — the full sessions array was being
  // serialized + shipped every tick (perf #4).
  mainWindow.webContents.send('chrome:tokens', {
    sessionCount: stats.sessionCount,
    current: cur, totals: tot,
    lang: lang(), needsSetup, pressurePct,
    compacting: compactTracker ? compactTracker.isCompacting() : false,
  });
}

// ---------------------------------------------------------------------------
// long-session center (C3): manual /compact trigger + compaction tracking
// ---------------------------------------------------------------------------
/** Trigger `/compact` in the main window's composer (official dsh command
 * path, idle-only upstream). Refused with a readable reason while the agent
 * is running a turn or a compaction is already in progress. */
async function compactNow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, code: 'no-window', reason: t(lang(), 'compact.noWindow') };
  }
  if (sessionRunning || (compactTracker && compactTracker.isCompacting())) {
    return { ok: false, code: 'busy', reason: t(lang(), 'compact.busy') };
  }
  const r = await compact.submitCompactCommand(mainWindow.webContents);
  if (!r.ok) {
    const reason = r.code === 'no-input' || r.code === 'inject'
      ? t(lang(), 'compact.injectFailed')
      : t(lang(), 'compact.failedBody', { code: r.code });
    log(`[compact] trigger failed: ${r.code}${r.detail ? ` (${r.detail})` : ''}`);
    notify(t(lang(), 'compact.failedTitle'), reason);
    return { ok: false, code: r.code, reason };
  }
  log(`[compact] /compact submitted via composer (${r.selector}, ${r.method})`);
  return { ok: true, selector: r.selector, method: r.method };
}

function broadcastCompactStatus() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('compact:status', {
      compacting: compactTracker ? compactTracker.isCompacting() : false,
      sessionRunning,
    });
  }
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
  const peakEnabled = !!cfg.costPeakEnabled;
  const peakRaw = peakEnabled ? {
    inputPerM: cfg.costPeakInputPerM || 0,
    outputPerM: cfg.costPeakOutputPerM || 0,
    cacheReadPerM: cfg.costPeakCacheReadPerM || 0,
    cacheWritePerM: cfg.costPeakCacheWritePerM || 0,
  } : null;
  // an all-zero peak rate set degrades to the flat rates (costOfSplit semantics)
  const hasPeakRate = !!(peakRaw && (peakRaw.inputPerM || peakRaw.outputPerM || peakRaw.cacheReadPerM || peakRaw.cacheWritePerM));
  const peakRates = hasPeakRate ? peakRaw : rates;
  const totalCost = peakEnabled
    ? cost.costOfSplit(stats.totals, rates, peakRates).total
    : cost.costOf(stats.totals, rates);
  const peakCostTotal = peakEnabled && stats.totals.peak ? cost.costOf(stats.totals.peak, peakRates) : 0;
  const perWorkspace = new Map();
  for (const s of stats.sessions) {
    const key = s.cwd || '(unknown)';
    if (!perWorkspace.has(key)) perWorkspace.set(key, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, peakCost: 0, sessions: 0 });
    const w = perWorkspace.get(key);
    w.input += s.usage.input; w.output += s.usage.output;
    w.cacheRead += s.usage.cacheRead; w.cacheWrite += s.usage.cacheWrite;
    // peak-aware per-workspace cost: same costOfSplit basis as the total so the
    // workspace rows reconcile with the today/week/month rows (review A-1)
    if (peakEnabled && s.usage.peak) {
      const sp = cost.costOfSplit(s.usage, rates, peakRates);
      w.cost += sp.total; w.peakCost += sp.peak;
    } else {
      w.cost += cost.costOf(s.usage, rates);
    }
    w.sessions += 1;
  }
  const now = Date.now();
  if (now - lastCostUpdateAt > 10 * 60 * 1000) {
    lastCostUpdateAt = now;
    cost.updateHistory(costHistoryFile(), {
      input: stats.totals.input, output: stats.totals.output,
      cacheRead: stats.totals.cacheRead, cacheWrite: stats.totals.cacheWrite,
      sessions: stats.sessionCount, cost: totalCost,
      peakCost: peakCostTotal,
    });
  }
  const history = cost.loadHistory(costHistoryFile());
  const month = cost.summarize(history, 30);
  checkBudget(month.cost);
  const windows = peakWindowsOf(cfg);
  const ps = windows ? cost.peakStatus(Date.now(), windows) : null;
  return {
    today: cost.summarize(history, 1),
    week: cost.summarize(history, 7),
    month,
    perWorkspace: [...perWorkspace.entries()].map(([cwd, v]) => ({ cwd, ...v })).sort((a, b) => b.cost - a.cost),
    currency: '¥',
    rates,
    lastTurn, // official-price cost of the most recent turn (C1)
    peak: {
      enabled: peakEnabled,
      isPeak: ps ? ps.peak : false,
      nextChangeInMin: ps ? ps.nextChangeInMin : 0,
      outputRate: peakEnabled && ps && ps.peak ? peakRates.outputPerM : rates.outputPerM,
    },
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
// per-turn cost at official prices (C1) + official account balance polling
// ---------------------------------------------------------------------------
let lastTurn = null;     // {cost, saved, inputTokens, outputTokens, cacheReadTokens, model, at}
let turnBaseline = null; // {file, totals} — usage of the active session at the previous turn end

/** Seed the turn baseline from the latest session so the first turn end after
 * boot reports only that turn (not the whole pre-existing session). */
function primeTurnBaseline(stats) {
  if (!stats || !stats.sessions || !stats.sessions.length || turnBaseline) return;
  let latest = null;
  for (const s of stats.sessions) if (!latest || s.mtimeMs > latest.mtimeMs) latest = s;
  if (latest) turnBaseline = { file: latest.file, totals: latest.usage };
}

function isZeroUsage(u) {
  return !u || (u.input === 0 && u.output === 0 && u.cacheRead === 0 && u.cacheWrite === 0);
}

/** Usage of one turn = latest session totals minus the baseline captured at
 * the previous turn end. A session without a baseline reports its whole
 * usage (correct for sessions created after boot; pre-existing ones were
 * primed above). Peak/offPeak sub-buckets are carried through when both
 * sides have them (the shared collect always buckets). */
function turnUsageDelta(latest) {
  const cur = latest.usage;
  if (!turnBaseline || turnBaseline.file !== latest.file) return cur;
  const base = turnBaseline.totals || {};
  const delta = {
    input: (cur.input || 0) - (base.input || 0),
    output: (cur.output || 0) - (base.output || 0),
    cacheRead: (cur.cacheRead || 0) - (base.cacheRead || 0),
    cacheWrite: (cur.cacheWrite || 0) - (base.cacheWrite || 0),
  };
  if (cur.peak && cur.offPeak && base.peak && base.offPeak) {
    delta.peak = {
      input: (cur.peak.input || 0) - (base.peak.input || 0),
      output: (cur.peak.output || 0) - (base.peak.output || 0),
      cacheRead: (cur.peak.cacheRead || 0) - (base.peak.cacheRead || 0),
      cacheWrite: (cur.peak.cacheWrite || 0) - (base.peak.cacheWrite || 0),
    };
    delta.offPeak = {
      input: (cur.offPeak.input || 0) - (base.offPeak.input || 0),
      output: (cur.offPeak.output || 0) - (base.offPeak.output || 0),
      cacheRead: (cur.offPeak.cacheRead || 0) - (base.offPeak.cacheRead || 0),
      cacheWrite: (cur.offPeak.cacheWrite || 0) - (base.offPeak.cacheWrite || 0),
    };
  }
  return delta;
}

let lastTurnEndAt = 0;
/** A turn just finished (host session-status running=false): compute this
 * turn's official-price cost + cache savings, then refresh the balance. */
async function onTurnEnd() {
  const now = Date.now();
  if (now - lastTurnEndAt < 5_000) return; // debounce repeated frames
  lastTurnEndAt = now;
  try {
    const stats = await collectStats();
    primeTurnBaseline(stats); // sessions created after the boot prime
    let latest = null;
    for (const s of stats.sessions) if (!latest || s.mtimeMs > latest.mtimeMs) latest = s;
    if (!latest) return;
    const delta = turnUsageDelta(latest);
    turnBaseline = { file: latest.file, totals: latest.usage };
    // zero delta = duplicate turn-end frame; negative = the log was rewritten
    // (resync) — in both cases keep the previous real lastTurn
    if (isZeroUsage(delta) || !delta || delta.input < 0 || delta.output < 0 || delta.cacheRead < 0) return;
    const tc = cost.turnCost(delta, cost.DEFAULT_MODEL);
    lastTurn = {
      cost: tc.cost, saved: tc.saved,
      inputTokens: tc.inputTokens, outputTokens: tc.outputTokens, cacheReadTokens: tc.cacheReadTokens,
      model: cost.DEFAULT_MODEL, at: now,
    };
    log(`[shell] turn cost: ¥${tc.cost.toFixed(4)} (cache saved ¥${tc.saved.toFixed(4)}, hit ${tc.cacheReadTokens} tok)`);
  } catch (e) {
    log(`[shell] turn cost failed: ${e.message}`);
  } finally {
    // billing has settled by now — this is the most meaningful poll moment;
    // the monitor self-throttles (5 min after a success) and backs off on errors
    if (balanceMonitor) balanceMonitor.refresh();
  }
}

/** Build the official-balance poller (key never leaves the main process). */
function initBalanceMonitor() {
  balanceMonitor = balance.createMonitor({
    snapshotFile: balanceSnapshotFile(),
    readKey: () => balance.findApiKey({
      env: process.env,
      credentialsPath: path.join(dshHomeOf(), '.credentials.yaml'),
      envPath: path.join(dshHomeOf(), '.env'),
    }),
    budgetOf: () => settings.get().monthlyBudget || 0,
    onLowBalance: (snap, threshold) => {
      const sym = snap.currency === 'USD' ? '$' : '¥';
      notify(t(lang(), 'notify.balanceLow'), t(lang(), 'notify.balanceLowBody', {
        amount: `${sym}${snap.total.toFixed(2)}`, threshold: `${sym}${threshold.toFixed(2)}`,
      }));
    },
    log,
  });
  // delayed first query (off the boot path) + 5-minute fallback polling
  setTimeout(() => { if (!quitting) balanceMonitor.refresh(); }, 15_000);
  balanceTimer = setInterval(() => { if (!quitting) balanceMonitor.refresh(); }, balance.THROTTLE_MS);
}

/** Compaction tracker (C3): scan the active session's JSONL for the
 * compaction/start|summary|end chain every 5s. The tick is stat-gated in
 * compact.js, so a quiet cycle costs one stat call, and the savings are
 * priced with the same bucketing the cost center uses. */
function initCompactTracking() {
  compactTracker = compact.createTracker({
    historyFile: path.join(app.getPath('userData'), 'compact-history.json'),
    dshHomeOf,
    windows: () => cost.parseWindows(settings.get().costPeakWindows) || cost.DEFAULT_WINDOWS,
    log,
    onStatus: () => broadcastCompactStatus(),
    onRecord: (rec) => {
      notify(t(lang(), 'notify.compactDone'), t(lang(), 'notify.compactDoneBody', {
        before: tokenStats.fmt(rec.beforeTokens || 0),
        after: tokenStats.fmt(rec.afterTokens || 0),
        saved: (rec.savedYuan || 0).toFixed(2),
      }));
      broadcastCompactStatus();
    },
  });
  compactTimer = setInterval(() => { if (!quitting) compactTracker.tick(); }, TOKEN_POLL_MS);
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
    backgroundColor: themeBackground(),
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
    backgroundColor: themeBackground(),
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
    show: true, // visible immediately — this is the boot feedback users stare at
    backgroundColor: themeBackground(), // cover the first paint; the page bg matches
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
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      if (pendingLoadingText) loadingWindow.webContents.send('loading:progress', pendingLoadingText);
      loadingWindow.webContents.send('loading:meta', { version: app.getVersion() });
    }
  });
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
/** Tell every open window the task list / history changed (auto-center UI). */
function broadcastScheduled() {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send('scheduled:changed'); } catch { /* ignore */ }
  }
}

/** Run one scheduled task headlessly, record history, notify. Shared by the
 *  scheduler tick and the "run now" button in the automation center. */
async function runScheduledTask(task) {
  const startedAt = new Date().toISOString();
  const result = await runHeadless({
    dshBin: activeDshBin(),
    nodeBin: bestNodeBin(),
    dshHome: dshHomeOf(),
    workspace: settings.effective().workspace || os.homedir(),
    logDir: ensureLogDir(),
    prompt: task.prompt || '',
  });
  const rec = {
    id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    taskId: task.id,
    name: task.name || task.id,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !!result.ok,
    durationMs: Math.round(result.durationMs || 0),
    summary: String(result.output || '').trim().slice(0, 400),
  };
  try {
    const hist = [rec, ...(settings.get().scheduledHistory || [])].slice(0, 50);
    settings.patch({ scheduledHistory: hist });
  } catch (e) {
    log(`[scheduler] history write failed: ${e.message}`);
  }
  log(`[scheduler] ${task.name || task.id} finished ok=${result.ok} (${Math.round(result.durationMs / 1000)}s)`);
  notify(
    t(lang(), 'notify.taskDone'),
    t(lang(), 'notify.scheduledDoneBody', { name: task.name || task.id, ok: result.ok ? '✓' : '✗' })
  );
  broadcastScheduled();
  return result;
}

function startScheduler() {
  if (scheduler) scheduler.stop();
  scheduler = new Scheduler((line) => log(line));
  scheduler.start(settings.get().scheduledTasks || [], async (task) => {
    if (scheduledRunning.has(task.id)) return;
    scheduledRunning.add(task.id);
    broadcastScheduled();
    try {
      await runScheduledTask(task);
    } finally {
      scheduledRunning.delete(task.id);
      settings.save(); // persist updated nextRunAt / lastRunAt
      broadcastScheduled();
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
      sessionRunning = !!frame.running; // busy check for the manual /compact entry (C3)
      if (!eventsFeedLiveLogged) {
        eventsFeedLiveLogged = true;
        log(`[shell] events feed live (session ${frame.sessionId}, running=${frame.running})`);
      }
      if (frame.running === false) {
        onTaskDone();
        onTurnEnd(); // per-turn official cost + balance refresh (C1)
      }
    }
  }, onFeedError));
  // mux stream: approval / question frames while the window is hidden. Wire
  // frames are ServerRequest envelopes ({type:'server-request', rpcId,
  // payload}); older runtimes sent the bare frame — unwrap both shapes so
  // the rpcId (needed to answer /api/respond) survives either way.
  eventsFeed.push(connectEvents(base, '/api/events.mux', (frame) => {
    if (!frame) return;
    const payload = (frame.type === 'server-request' && frame.payload) ? frame.payload : frame;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'approval/requested') onApprovalRequested(payload, frame.rpcId);
    else if (payload.type === 'question/requested') onQuestionRequested(payload, frame.rpcId);
  }, onFeedError));
  log(`[shell] events feed -> ${base}api/events.{host,mux}`);
}

function stopEventsFeed() {
  for (const feed of eventsFeed) {
    try { feed.close(); } catch { /* ignore */ }
  }
  eventsFeed = [];
  if (eventsRetryTimer) { clearTimeout(eventsRetryTimer); eventsRetryTimer = null; }
  // no live frames until the feed reconnects: drop the busy flag and any
  // compaction start orphaned by a runtime crash/restart (C3)
  sessionRunning = false;
  if (compactTracker) compactTracker.resetOpen();
}

function windowHidden() {
  return !mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized();
}

function onTaskDone() {
  const now = Date.now();
  if (now - lastTaskNotifyAt < 8_000) return; // debounce
  lastTaskNotifyAt = now;
  // IM push (C5): parallel to the system notification, debounced + queued
  // inside the channel manager; no-ops while no channel is enabled.
  if (channelsMgr) channelsMgr.broadcast({ kind: 'taskDone' });
  if (!windowHidden()) return; // user is watching
  notify(t(lang(), 'notify.taskDone'), t(lang(), 'notify.taskDoneBody'));
}

function onApprovalRequested(frame, rpcId) {
  const tool = frame.toolName || '';
  // IM push (C5/C6): approval cards carry a one-shot token (120s TTL) whose
  // payload keeps the runtime routing fields (rpcId/sessionId/approvalId) —
  // the token redemption hook answers POST /api/respond with them.
  if (channelsMgr) {
    channelsMgr.broadcast({
      kind: 'approval',
      tool,
      rpcId: rpcId || '',
      sessionId: frame.sessionId || '',
      approvalId: frame.approvalId || '',
    });
  }
  if (!windowHidden()) return;
  notify(t(lang(), 'notify.approval'), t(lang(), 'notify.approvalBody', { tool }));
}

function onQuestionRequested(frame, rpcId) {
  // IM push (C5/C6): question cards carry a one-shot reply token (120s TTL)
  // keeping the rpcId/sessionId/question shape for the /api/respond answer.
  if (channelsMgr) {
    channelsMgr.broadcast({
      kind: 'question',
      question: (frame && frame.questions && frame.questions[0] && frame.questions[0].question) || '',
      rpcId: rpcId || '',
      sessionId: (frame && frame.sessionId) || '',
      questions: (frame && frame.questions) || [],
    });
  }
  if (!windowHidden()) return;
  notify(t(lang(), 'notify.question'), t(lang(), 'notify.questionBody'));
}

/**
 * Answer a pending runtime server-request (approval / question) through
 * POST /api/respond with a client-response echoing the mux rpcId. Runtime
 * business errors come back 200 + {accepted:false}; both shapes map to the
 * {ok, reason} the channel dispatcher replies with over IM.
 */
async function respondToRuntime({ rpcId, value, what }) {
  if (!runtimeUrl) return { ok: false, reason: 'runtime offline' };
  if (!rpcId || !value) {
    log(`[channels] ${what || 'respond'} dropped: missing runtime routing id`);
    return { ok: false, reason: 'no rpc id' };
  }
  try {
    const base = runtimeUrl.endsWith('/') ? runtimeUrl : `${runtimeUrl}/`;
    const res = await fetch(`${base}api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 200 && body && body.accepted === true) {
      log(`[channels] ${what || 'respond'} accepted by runtime`);
      return { ok: true };
    }
    const reason = (body && body.reason) || `HTTP ${res.status}`;
    log(`[channels] ${what || 'respond'} refused: ${reason}`);
    return { ok: false, reason };
  } catch (e) {
    log(`[channels] ${what || 'respond'} error: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ---------------------------------------------------------------------------
// shell self-update (electron-updater; packaged builds only)
// ---------------------------------------------------------------------------
let autoUpdater = null;
let _updaterInitTried = false;

function initAutoUpdater() {
  if (_updaterInitTried) return;
  _updaterInitTried = true;
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
  if (!autoUpdater) initAutoUpdater(); // lazy: tray click before the deferred init
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
    // C7 public-remote helper: pure detection + cloudflared child process
    // management; lazy, nothing probes until the settings window asks.
    publicRemote = createPublicRemote({ log });
    // C7 posture follows the persisted switch (off by default; a saved "on"
    // restores the tightened TTL / proxy-IP keys / no-IP-grant posture).
    remote.setPublicMode(!!settings.get().remotePublic);
    // Model provider panel (C2): same safeStorage-after-ready constraint as
    // the gateway above. All key writes/tests stay in this process.
    modelsMgr = createModelsManager({
      settings,
      dshHome: dshHomeOf,
      userDataDir: app.getPath('userData'),
      safeStorage,
      log,
    });
    if (settings.get().remoteControl) {
      remote.setRuntimeUrl(runtimeUrl);
      remote.start({ port: settings.get().remotePort, compat: !!settings.get().remoteCompat })
        .then((s) => { if (!s.running) notify(t(lang(), 'notify.remoteFailed'), t(lang(), 'notify.remoteFailedBody')); })
        .catch((e) => log(`[remote] start failed: ${e.message}`));
    }
    // IM channels hub (C5 skeleton + C6 protocol implementations). Same
    // safeStorage-after-ready constraint as the gateway; feishu/wecom/dingtalk
    // ship real adapters now, whatsapp stays a placeholder slot.
    channelsMgr = createChannelManager({
      settings,
      userDataDir: app.getPath('userData'),
      safeStorage,
      log,
      lang,
      // free text from IM → the shared headless runner (Quick Ask / scheduler
      // use the same path); sticky per (channel, sender) sessions live in the
      // channel manager itself
      runPrompt: ({ text }) => runHeadless({
        dshBin: activeDshBin(),
        nodeBin: bestNodeBin(),
        dshHome: dshHomeOf(),
        workspace: settings.effective().workspace || os.homedir(),
        logDir: ensureLogDir(),
        prompt: text,
      }),
      // Approval/question decisions verified via one-shot token land here and
      // are answered through the runtime's POST /api/respond (client-response
      // echoing the mux server-request rpcId — same wire the web UI uses).
      onApprovalDecision: ({ decision, tool, payload }) =>
        respondToRuntime({
          rpcId: payload && payload.rpcId,
          value: payload && payload.sessionId && payload.approvalId ? {
            sessionId: payload.sessionId,
            approvalId: payload.approvalId,
            outcome: decision === 'approve' ? 'allowed-once' : 'rejected',
          } : null,
          what: `approval ${decision} for "${tool || '(unknown tool)'}"`,
        }),
      onQuestionAnswer: ({ text: answer, payload }) => {
        // match the reply against the first question's option labels; a hit
        // becomes a selection, anything else rides `custom` free text
        const q = payload && Array.isArray(payload.questions) ? payload.questions[0] : null;
        const labels = (q && q.options || []).map((o) => o && o.label).filter(Boolean);
        const hit = labels.find((l) => l === String(answer || '').trim());
        const answers = [{
          id: (q && q.id) || 'unknown',
          selected: hit ? [hit] : [],
          ...(hit ? {} : { custom: String(answer || '') }),
        }];
        return respondToRuntime({
          rpcId: payload && payload.rpcId,
          value: payload && payload.sessionId ? { sessionId: payload.sessionId, answer: { answers } } : null,
          what: 'question answer',
        });
      },
    });
    channelsMgr.register('feishu', FeishuChannel, (c) => testFeishuConnection({ appId: c.appId, appSecret: c.appSecret }));
    channelsMgr.register('wecom', WecomChannel, (c) => testWecomConnection({ botId: c.botId, secret: c.secret }));
    channelsMgr.register('dingtalk', DingtalkChannel, (c) => testDingtalkConnection({ clientId: c.clientId, clientSecret: c.clientSecret }));
    // push channel state changes (online/offline/backoff) to every open window
    channelsMgr.onState(() => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { if (!w.isDestroyed()) w.webContents.send('channels:changed'); } catch { /* ignore */ }
      }
    });
    channelsMgr.startEnabled();
    broadcastTheme(); // push the resolved theme once settings are ready
    // Registry write on Windows; not needed before the first window.
    setTimeout(() => app.setLoginItemSettings({ openAtLogin: !!settings.get().autoStart }), 3_000);
    createTray();
    // refresh the tray's peak/off-peak countdown line once a minute (the
    // menu is only rebuilt when split pricing is actually enabled)
    trayPeakTimer = setInterval(() => {
      if (quitting || !tray || tray.isDestroyed()) return;
      if (settings.get().costPeakEnabled) updateTray();
    }, 60_000);
    // Splash on EVERY boot, not just guided first-run: without it Windows
    // users stare at a blank screen for the whole runtime boot (AV scans the
    // runtime's thousands of files). It closes in createWindow().
    try { createLoadingWindow(); } catch (err) { log('[shell] loading window failed: ' + err.message); }
    setLoading(t(lang(), 'loading.boot'));
    const runtimeReady = await ensureRuntimeWithGuide();
    // The guided flow may have quit the app (user choice / fatal error);
    // never continue a torn-down app (write-after-end crashes).
    if (quitting) return;
    if (runtimeReady) {
      // Reads the web profile's package.json (and may write settings) —
      // housekeeping, keep it off the first-window path.
      setTimeout(seedInstalledPlugins, 2_000);
      // The guided flow may have just closed its loading window; with no main
      // window open yet, window-all-closed would otherwise quit the app while
      // the runtime is still booting (M15). Hold quit until the window opens.
      mainWindowPending = true;
      spawnRuntime();
    }
    registerQuickAskHotkey();
    startScheduler();
    // official balance polling (C1): startup-delayed + every-5-min fallback;
    // turn ends hook in via onTurnEnd()
    initBalanceMonitor();
    // compaction tracking (C3): same 5s cadence as the token widget, stat-gated
    initCompactTracking();
    // require('electron-updater') pulls a large dependency tree out of the
    // asar (hundreds of files, each an AV scan on Windows) — defer it well
    // past the first window; checkShellUpdate() lazy-inits if user is faster.
    setTimeout(initAutoUpdater, 5_000);
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
        const stats = await collectStats();
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
      const stats = await collectStats();
      costSnapshot(stats);
      primeTurnBaseline(stats); // seed the per-turn cost baseline (C1)
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
    if (trayPeakTimer) { clearInterval(trayPeakTimer); trayPeakTimer = null; }
    if (balanceTimer) { clearInterval(balanceTimer); balanceTimer = null; }
    if (compactTimer) { clearInterval(compactTimer); compactTimer = null; }
    globalShortcut.unregisterAll();
    if (scheduler) scheduler.stop();
    if (remote) remote.stop();
    if (publicRemote) publicRemote.stopTunnel(); // C7: cloudflared child never outlives the app (taskkill /T /F inside)
    if (channelsMgr) channelsMgr.stopAll();
    if (logStream) logStream.end();
  });
}
