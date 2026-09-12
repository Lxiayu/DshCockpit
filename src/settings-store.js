// src/settings-store.js — persisted shell settings (settings.json under userData)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeQuickAskShortcut } = require('./quickask-shortcut');
const LEGACY_TOKEN_WIDGET_KEY = ['token', 'Widget'].join('');

// Pre-V4.1 defaults that are wrong for today's models: DeepSeek moved to
// V4.1-Flash on 2026-09-10 (lower prices) with a 1M context window, so the old
// 128k window and V4-Flash rates overstate pressure ~8x and cost ~2x. A stored
// value that still equals the old default was never customized and is migrated
// in memory on every load; a user-edited value is left untouched. The file
// itself only changes on the next natural save.
const V41_MIGRATIONS = [
  ['contextWindow', 128000, 1000000],
  ['costInputPerM', 2, 1],
  ['costOutputPerM', 8, 4],
  ['costCacheReadPerM', 0.5, 0.02],
  ['costPeakInputPerM', 4, 2],
  ['costPeakOutputPerM', 16, 8],
  ['costPeakCacheReadPerM', 1, 0.04],
];

const DEFAULTS = {
  channel: 'rc',            // rc | latest | pinned
  pinnedVersion: '',        // used when channel === 'pinned'
  registry: 'https://registry.npmjs.org/',
  keepVersions: 2,
  workspace: '',            // '' = os.homedir()
  dshHome: '',              // '' = ~/.dsh
  port: 0,                  // 0 = OS-assigned
  trayOnClose: true,
  autoStart: false,
  checkUpdatesOnStartup: true,
  nodeBin: '',              // '' = auto-detect
  dshBin: '',               // '' = auto-detect
  language: 'system',       // zh | en | system (follow OS)
  themeMode: 'system',      // system | dark | light (shell theme)
  backupOnQuit: true,       // back up sessions when quitting
  backupKeep: 5,            // number of backups to retain
  cockpitOnboarded: false,  // first-run Cockpit recognition flow completed
  shellAutoUpdate: true,    // auto-check the shell itself for updates
  contextWindow: 1000000,   // assumed model context window (V4.1-Flash / V4-Pro are 1M)
  costInputPerM: 1,         // ¥ per 1M input tokens, cache-miss (estimate, user-adjustable)
  costOutputPerM: 4,        // ¥ per 1M output tokens
  costCacheReadPerM: 0.02,  // ¥ per 1M cache-hit tokens
  costCacheWritePerM: 0,    // official API bills cache writes at 0 (hit/miss/output only)
  costPeakEnabled: false,   // split pricing by peak/off-peak event time
  costPeakWindows: '9-12,14-18', // peak hour ranges (Beijing Mon-Fri, official)
  costPeakInputPerM: 2,     // peak ¥ per 1M input tokens (default = 2x off-peak)
  costPeakOutputPerM: 8,    // peak ¥ per 1M output tokens
  costPeakCacheReadPerM: 0.04, // peak ¥ per 1M cache-hit tokens
  costPeakCacheWritePerM: 0,// official API bills cache writes at 0
  monthlyBudget: 0,         // ¥/month budget; 0 = disabled
  quickAskHotkey: 'CommandOrControl+Alt+Space',
  scheduledTasks: [],       // { id, name, prompt, kind: every|daily|weekly, everySeconds?|dailyTime?|weeklyDay?+weeklyTime?, templateId?, enabled, nextRunAt, lastRunAt }
  scheduledHistory: [],     // last 50 scheduled-task runs: { id, taskId, name, startedAt, finishedAt, ok, durationMs, summary }
  recentWorkspaces: [],     // last used workspace dirs (tray quick switch)
  installedPlugins: [],     // plugins installed via the shell plugin market
  remoteControl: false,     // phone remote-control gateway (TLS proxy to the runtime)
  remotePort: 31780,        // gateway listen port (auto-increments on conflict)
  remoteCompat: true,       // serve the gateway over plain HTTP so WeChat/Douyin scanners can open it (LAN cleartext)
  remotePublic: false,      // C7 public-network access switch: OFF by default; enabling requires an explicit confirm (shell:public-remote-enable)
  remotePublicMode: 'lan',  // C7 access route: lan | tailscale | cloudflare
  modelProviders: [],       // model provider profiles (C2): { id, name, baseURL, apiKeyRef, models[], preset, ollama?, createdAt }
  imChannels: [],           // IM channel configs (C5): { id, type, enabled, allowFrom[] } — credentials stay in channel-secrets.json
  bootCheckOnStartup: true, // R1: run the boot self-check automatically at app start
  compatStatusEnabled: true, // R2: show upstream compatibility status in Settings → Updates
  notificationCenterEnabled: true, // R6: master switch; false = legacy direct-toast behaviour
  notifDndEnabled: false, // R6: do-not-disturb window (default off = pass-through)
  notifDndWindow: '23:00-07:00', // R6: DND window, HH:MM-HH:MM, may cross midnight
  notifFoldEnabled: false, // R6: fold identical toasts inside a 60s window (default off)
  notifKindsDisabled: [], // R6: subset of approval/completion/question/budget/system
  weeklyReportEnabled: false, // R5: auto-generate the Wrapped card every Monday morning
  weeklyReportPushIm: false, // R5: also push the generated card summary to configured IM channels
  mcpServers: [],           // MCP servers (T1/R3): { id, name, serverName, transport, command, args,
                            //   envPlain, envSecretKeys, url, headers, enabled, failOnStartupError,
                            //   startupTimeoutSec, toolTimeoutSec, source, origin, createdAt }
                            // Secret env VALUES live only in mcp-secrets.json (safeStorage vault)
};

const NUMERIC_KEYS = ['keepVersions', 'port', 'contextWindow', 'costInputPerM', 'costOutputPerM', 'costCacheReadPerM', 'costCacheWritePerM', 'costPeakInputPerM', 'costPeakOutputPerM', 'costPeakCacheReadPerM', 'costPeakCacheWritePerM', 'monthlyBudget', 'backupKeep', 'remotePort'];
const BOOLEAN_KEYS = ['trayOnClose', 'autoStart', 'checkUpdatesOnStartup', 'backupOnQuit', 'cockpitOnboarded', 'shellAutoUpdate', 'costPeakEnabled', 'remoteControl', 'remoteCompat', 'remotePublic', 'bootCheckOnStartup', 'compatStatusEnabled', 'notificationCenterEnabled', 'notifDndEnabled', 'notifFoldEnabled', 'weeklyReportEnabled', 'weeklyReportPushIm'];
const STRING_KEYS = ['channel', 'pinnedVersion', 'registry', 'workspace', 'dshHome', 'nodeBin', 'dshBin', 'language', 'themeMode', 'quickAskHotkey', 'costPeakWindows', 'remotePublicMode', 'notifDndWindow'];
const ARRAY_KEYS = ['recentWorkspaces', 'installedPlugins', 'scheduledTasks', 'scheduledHistory', 'modelProviders', 'imChannels', 'notifKindsDisabled', 'mcpServers'];

class SettingsStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
      delete this.data[LEGACY_TOKEN_WIDGET_KEY];
      for (const [key, from, to] of V41_MIGRATIONS) {
        if (this.data[key] === from) this.data[key] = to;
      }
    } catch {
      // first run or corrupt file: keep defaults
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // surfaced via the IPC rejection; also log for post-mortem from the shell log
      console.error(`[settings] save failed (${this.file}):`, err.message);
      throw err;
    }
  }

  get() {
    return { ...this.data };
  }

  patch(partial) {
    // whitelist + type validation (IPC defense in depth; M2)
    const allowed = {};
    for (const [k, v] of Object.entries(partial || {})) {
      if (!(k in DEFAULTS)) continue;
      if (NUMERIC_KEYS.includes(k)) {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) allowed[k] = n;
      } else if (BOOLEAN_KEYS.includes(k)) {
        allowed[k] = !!v;
      } else if (STRING_KEYS.includes(k)) {
        if (k === 'quickAskHotkey') {
          const hotkey = normalizeQuickAskShortcut(v);
          if (hotkey !== null) allowed[k] = hotkey;
        } else if (typeof v === 'string') allowed[k] = v;
      } else if (ARRAY_KEYS.includes(k)) {
        if (Array.isArray(v)) allowed[k] = v;
      }
    }
    this.data = { ...this.data, ...allowed };
    this.save();
    return this.get();
  }

  /** Settings merged with env overrides (env wins; used for testing). */
  effective() {
    return {
      ...this.data,
      workspace: process.env.DSH_DESKTOP_WORKSPACE || this.data.workspace,
      dshHome: process.env.DSH_DESKTOP_DSH_HOME || this.data.dshHome,
      port: process.env.DSH_DESKTOP_PORT !== undefined ? Number(process.env.DSH_DESKTOP_PORT) : this.data.port,
      nodeBin: process.env.DSH_DESKTOP_NODE_BIN || this.data.nodeBin,
      dshBin: process.env.DSH_DESKTOP_DSH_BIN || this.data.dshBin,
    };
  }
}

module.exports = { SettingsStore, DEFAULTS, V41_MIGRATIONS };
