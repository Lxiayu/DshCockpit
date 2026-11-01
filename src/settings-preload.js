// src/settings-preload.js — bridge for the shell settings window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
  // Task 8 / SPEC-08: additive Office settings bridge (office-state.v1.json
  // only; never touches the legacy settings.json).
  getOfficeSettings: () => ipcRenderer.invoke('shell:office-settings-get'),
  saveOfficeSettings: (partial) => ipcRenderer.invoke('shell:office-settings-set', partial),
  saveSettings: (partial) => ipcRenderer.invoke('shell:save-settings', partial),
  getQuickAskShortcut: () => ipcRenderer.invoke('shell:quickask-shortcut-get'),
  setQuickAskShortcut: (value) => ipcRenderer.invoke('shell:quickask-shortcut-set', value),
  // renderer trace: page-open / async-render timings land in the main log
  log: (msg) => ipcRenderer.invoke('shell:log', msg),
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, t) => cb(t)),
  pickFolder: (kind) => ipcRenderer.invoke('shell:pick-folder', kind),
  runtimeInfo: () => ipcRenderer.invoke('shell:runtime-info'),
  // 容器加固（2026-09-23）：运行时降级姿态推送（主进程 5s tick，降级集合变化时）
  onRuntimeHealth: (cb) => ipcRenderer.on('runtime:health', (_e, h) => cb(h)),
  checkUpdate: () => ipcRenderer.invoke('shell:check-update'),
  applyUpdate: () => ipcRenderer.invoke('shell:apply-update'),
  rollback: () => ipcRenderer.invoke('shell:rollback'),
  openLogDir: () => ipcRenderer.invoke('shell:open-log-dir'),
  backupNow: () => ipcRenderer.invoke('shell:backup-now'),
  backupInfo: () => ipcRenderer.invoke('shell:backup-info'),
  storageInfo: () => ipcRenderer.invoke('shell:storage-info'),
  storageCleanup: () => ipcRenderer.invoke('shell:storage-cleanup'),
  setWorkspace: (ws) => ipcRenderer.invoke('shell:set-workspace', ws),
  pluginsList: () => ipcRenderer.invoke('shell:plugins-list'),
  pluginSearch: (kw) => ipcRenderer.invoke('plugins:search', kw),
  pluginMarket: (force) => ipcRenderer.invoke('plugins:market', force),
  pluginAction: (action, fullName) => ipcRenderer.invoke('shell:plugin-action', action, fullName),
  profileSnapshots: () => ipcRenderer.invoke('shell:profile-snapshots'),
  restoreSnapshot: (id) => ipcRenderer.invoke('shell:restore-snapshot', id),
  safeMode: () => ipcRenderer.invoke('shell:safe-mode'),
  onPluginProgress: (cb) => ipcRenderer.on('plugins:progress', (_e, d) => cb(d)),
  // skills center (C4): SKILL.md packs — market/installed list + actions
  skillsList: (force) => ipcRenderer.invoke('shell:skills-list', force),
  skillsPreview: (fullName) => ipcRenderer.invoke('shell:skills-preview', fullName),
  skillsInstall: (fullName, pick) => ipcRenderer.invoke('shell:skills-install', fullName, pick),
  skillsRemove: (name) => ipcRenderer.invoke('shell:skills-remove', name),
  skillsUpgrade: (name) => ipcRenderer.invoke('shell:skills-upgrade', name),
  skillsImport: (dir, pick) => ipcRenderer.invoke('shell:skills-import', dir, pick),
  onSkillsProgress: (cb) => ipcRenderer.on('skills:progress', (_e, d) => cb(d)),
  restartRuntime: () => ipcRenderer.invoke('shell:restart-runtime'),
  // R1 boot self-check (Settings → About): last report / rerun / one-click repair
  bootReport: () => ipcRenderer.invoke('boot:report'),
  bootRerun: () => ipcRenderer.invoke('boot:rerun'),
  bootRepair: (ids) => ipcRenderer.invoke('boot:repair', ids),
  // R2 upstream compatibility status (Settings → Updates, read-only)
  compatStatus: () => ipcRenderer.invoke('compat:status'),
  // R6 notification center history
  notificationsList: (query, kind, limit) => ipcRenderer.invoke('notifications:list', query, kind, limit),
  notificationsClear: () => ipcRenderer.invoke('notifications:clear'),
  // R4 cache economics (Settings → Cost)
  cacheEconomics: () => ipcRenderer.invoke('cache-economics:summary'),
  // H10 shell update check (Settings → Updates)
  shellCheckUpdate: () => ipcRenderer.invoke('shell:check-shell-update'),
  // R5 weekly report (Settings → Tasks & automation)
  weeklyGenerate: () => ipcRenderer.invoke('weekly:generate'),
  weeklyList: () => ipcRenderer.invoke('weekly:list'),
  weeklyOpenDir: () => ipcRenderer.invoke('weekly:open-dir'),
  weeklyPush: () => ipcRenderer.invoke('weekly:push'),
  costInfo: () => ipcRenderer.invoke('shell:cost-info'),
  balanceInfo: () => ipcRenderer.invoke('shell:balance-info'),
  balanceRefresh: () => ipcRenderer.invoke('shell:balance-refresh'),
  diagnosticsInfo: () => ipcRenderer.invoke('shell:diagnostics-info'),
  openDiagnostics: () => ipcRenderer.invoke('shell:open-diagnostics'),
  // P2 运维能力: 一键导出诊断包（Settings → About）。
  exportDiagnostics: () => ipcRenderer.invoke('shell:export-diagnostics'),
  scheduledList: () => ipcRenderer.invoke('shell:scheduled-list'),
  scheduledUpsert: (task) => ipcRenderer.invoke('shell:scheduled-upsert', task),
  scheduledRemove: (id) => ipcRenderer.invoke('shell:scheduled-remove', id),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remotePairing: () => ipcRenderer.invoke('remote:pairing'),
  remoteRevoke: () => ipcRenderer.invoke('remote:revoke'),
  // public remote access (C7): Tailscale detection, cloudflared quick tunnel,
  // and the confirmed-enable flow (the renderer passes confirmed=true only
  // after the public-network warning dialog)
  publicRemoteStatus: (force) => ipcRenderer.invoke('shell:public-remote-status', !!force),
  publicRemoteEnable: (mode, confirmed) => ipcRenderer.invoke('shell:public-remote-enable', mode, confirmed),
  publicRemoteDisable: () => ipcRenderer.invoke('shell:public-remote-disable'),
  tunnelStart: () => ipcRenderer.invoke('shell:tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('shell:tunnel-stop'),
  modelsList: () => ipcRenderer.invoke('shell:models-list'),
  modelsSave: (profile, apiKey) => ipcRenderer.invoke('shell:models-save', profile, apiKey),
  modelsRemove: (id) => ipcRenderer.invoke('shell:models-remove', id),
  modelsTest: (target) => ipcRenderer.invoke('shell:models-test', target),
  ollamaStatus: () => ipcRenderer.invoke('shell:ollama-status'),
  modelsSetDefault: (provider, model) => ipcRenderer.invoke('shell:models-set-default', provider, model),
  copyText: (text) => ipcRenderer.invoke('shell:copy-text', text),
  // MCP manager (v0.3.1 T1): CRUD / toggle / two-tier tests / registry /
  // universal import / usage. Secret env values are passed FORWARD once in
  // mcpSave(secrets) and never returned by any call (vault discipline).
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpGet: (id) => ipcRenderer.invoke('mcp:get', id),
  mcpSave: (server, secrets) => ipcRenderer.invoke('mcp:save', server, secrets),
  mcpRemove: (id) => ipcRenderer.invoke('mcp:remove', id),
  mcpToggle: (id, enabled) => ipcRenderer.invoke('mcp:toggle', id, enabled),
  mcpTest: (target) => ipcRenderer.invoke('mcp:test', target),
  mcpTier1: (id) => ipcRenderer.invoke('mcp:tier1', id),
  mcpRegistry: (query, category) => ipcRenderer.invoke('mcp:registry', query, category),
  mcpImportScan: () => ipcRenderer.invoke('mcp:import-scan'),
  mcpImportRun: (sourceKey, selectedNames, clipboardText) => ipcRenderer.invoke('mcp:import-run', sourceKey, selectedNames, clipboardText),
  mcpUsage: (days) => ipcRenderer.invoke('mcp:usage', days),
  scheduledRun: (id) => ipcRenderer.invoke('shell:scheduled-run', id),
  scheduledHistory: () => ipcRenderer.invoke('shell:scheduled-history'),
  scheduledClearHistory: () => ipcRenderer.invoke('shell:scheduled-clear-history'),
  copyAndShow: (text, title, body) => ipcRenderer.invoke('shell:copy-and-show', text, title, body),
  onScheduledChanged: (cb) => ipcRenderer.on('scheduled:changed', () => cb()),
  // long-session center (C3): compaction + AGENTS.md memory files
  compactNow: () => ipcRenderer.invoke('shell:compact-now'),
  compactStatus: () => ipcRenderer.invoke('shell:compact-status'),
  compactHistory: () => ipcRenderer.invoke('shell:compact-history'),
  onCompactStatus: (cb) => ipcRenderer.on('compact:status', (_e, s) => cb(s)),
  memoryGet: (scope) => ipcRenderer.invoke('shell:memory-get', scope),
  memorySave: (scope, content) => ipcRenderer.invoke('shell:memory-save', scope, content),
  memoryDelete: (scope) => ipcRenderer.invoke('shell:memory-delete', scope),
  // IM channels (C5 lifecycle + C6 credentials): card list / toggle /
  // allowlist; configure/test run in the main process so secrets never
  // persist or render in the settings window
  channelsList: () => ipcRenderer.invoke('shell:channels-list'),
  channelsToggle: (id, enabled) => ipcRenderer.invoke('shell:channels-toggle', id, enabled),
  // TD-32：第四参数 confirmOpen —— 扩展到全开放（`*`）需要显式二次确认
  channelsAllowFrom: (id, allowFrom, confirmOpen) =>
    ipcRenderer.invoke('shell:channels-allowfrom', id, allowFrom, confirmOpen === true),
  channelsConfigure: (id, values) => ipcRenderer.invoke('shell:channels-configure', id, values),
  channelsTest: (id, values) => ipcRenderer.invoke('shell:channels-test', id, values),
  onChannelsChanged: (cb) => ipcRenderer.on('channels:changed', () => cb()),
  // runtime install progress (update console): live frames from runUpdateCheck
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onCenterNavigate: (cb) => ipcRenderer.on('center:navigate', (_e, route) => cb({
    mode: route && route.mode === 'control' ? 'control' : 'settings',
    page: route && typeof route.page === 'string' ? route.page : '',
    intent: route && route.intent === 'new-task' ? 'new-task' : '',
  })),
  closeCenter: () => ipcRenderer.send('center:close'),
  returnToCockpit: () => ipcRenderer.send('center:return-cockpit'),
  // P1 Mission Core（Issue #12）：单通道 + action 判别式。
  // 这里只做一层转发，不做参数校验——校验在 src/ipc-mission.js（可纯 Node 测试）。
  // 为什么不在 preload 里逐个列出 14 个方法：那会让每次新增 action 都要改
  // preload（三处同步），而这层本来就没有语义。
  mission: (action, payload) => ipcRenderer.invoke('mission:invoke', action, payload),
});
