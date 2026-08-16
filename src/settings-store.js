// src/settings-store.js — persisted shell settings (settings.json under userData)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  backupOnQuit: true,       // back up sessions when quitting
  backupKeep: 5,            // number of backups to retain
  tokenWidget: true,        // show the in-window token widget
  shellAutoUpdate: true,    // auto-check the shell itself for updates
  contextWindow: 128000,    // assumed model context window for the pressure meter
  costInputPerM: 2,         // ¥ per 1M input tokens (estimate, user-adjustable)
  costOutputPerM: 8,        // ¥ per 1M output tokens
  costCacheReadPerM: 0.5,   // ¥ per 1M cache-read tokens
  costCacheWritePerM: 2,    // ¥ per 1M cache-write tokens
  costPeakEnabled: false,   // split pricing by peak/off-peak event time
  costPeakWindows: '9-12,14-18', // peak hour ranges, Beijing time
  costPeakInputPerM: 4,     // peak ¥ per 1M input tokens (default = 2x off-peak)
  costPeakOutputPerM: 16,   // peak ¥ per 1M output tokens
  costPeakCacheReadPerM: 1, // peak ¥ per 1M cache-read tokens
  costPeakCacheWritePerM: 4,// peak ¥ per 1M cache-write tokens
  monthlyBudget: 0,         // ¥/month budget; 0 = disabled
  quickAskHotkey: 'CommandOrControl+Alt+Space',
  scheduledTasks: [],       // { id, name, prompt, kind, everySeconds?|dailyTime?, enabled, nextRunAt, lastRunAt }
  recentWorkspaces: [],     // last used workspace dirs (tray quick switch)
  installedPlugins: [],     // plugins installed via the shell plugin market
  remoteControl: false,     // phone remote-control gateway (TLS proxy to the runtime)
  remotePort: 31780,        // gateway listen port (auto-increments on conflict)
};

const NUMERIC_KEYS = ['keepVersions', 'port', 'contextWindow', 'costInputPerM', 'costOutputPerM', 'costCacheReadPerM', 'costCacheWritePerM', 'costPeakInputPerM', 'costPeakOutputPerM', 'costPeakCacheReadPerM', 'costPeakCacheWritePerM', 'monthlyBudget', 'backupKeep', 'remotePort'];
const BOOLEAN_KEYS = ['trayOnClose', 'autoStart', 'checkUpdatesOnStartup', 'backupOnQuit', 'tokenWidget', 'shellAutoUpdate', 'costPeakEnabled', 'remoteControl'];
const STRING_KEYS = ['channel', 'pinnedVersion', 'registry', 'workspace', 'dshHome', 'nodeBin', 'dshBin', 'language', 'quickAskHotkey', 'costPeakWindows'];
const ARRAY_KEYS = ['recentWorkspaces', 'installedPlugins', 'scheduledTasks'];

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
    } catch {
      // first run or corrupt file: keep defaults
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
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
        if (typeof v === 'string') allowed[k] = v;
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

module.exports = { SettingsStore, DEFAULTS };
