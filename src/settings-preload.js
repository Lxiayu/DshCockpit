// src/settings-preload.js — bridge for the shell settings window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('shell:save-settings', partial),
  pickFolder: (kind) => ipcRenderer.invoke('shell:pick-folder', kind),
  runtimeInfo: () => ipcRenderer.invoke('shell:runtime-info'),
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
  pluginAction: (action, fullName) => ipcRenderer.invoke('shell:plugin-action', action, fullName),
  costInfo: () => ipcRenderer.invoke('shell:cost-info'),
  diagnosticsInfo: () => ipcRenderer.invoke('shell:diagnostics-info'),
  openDiagnostics: () => ipcRenderer.invoke('shell:open-diagnostics'),
  scheduledList: () => ipcRenderer.invoke('shell:scheduled-list'),
  scheduledUpsert: (task) => ipcRenderer.invoke('shell:scheduled-upsert', task),
  scheduledRemove: (id) => ipcRenderer.invoke('shell:scheduled-remove', id),
});
