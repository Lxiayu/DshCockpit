'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dshCockpit', {
  getSnapshot: () => ipcRenderer.invoke('cockpit:get-snapshot'),
  setMode: (mode) => ipcRenderer.invoke('cockpit:set-mode', mode),
  setLanguage: (language) => ipcRenderer.invoke('cockpit:set-language', language),
  moveOffset: (dx, dy) => ipcRenderer.invoke('cockpit:move-offset', dx, dy),
  onSnapshot: (cb) => ipcRenderer.on('cockpit:snapshot', (_e, value) => cb(value)),
  onMode: (cb) => ipcRenderer.on('cockpit:mode', (_e, value) => cb(value)),
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, value) => cb(value)),
  completeOnboarding: () => ipcRenderer.invoke('cockpit:complete-onboarding'),
  openQuickAsk: () => ipcRenderer.invoke('cockpit:open-quick-ask'),
  openSearch: () => ipcRenderer.invoke('cockpit:open-search'),
  openControlPage: (page) => ipcRenderer.invoke('cockpit:open-center', 'control', page),
  openTasks: () => ipcRenderer.invoke('cockpit:open-center', 'control', 'tasks'),
  newTask: () => ipcRenderer.invoke('cockpit:new-task'),
  openSettings: () => ipcRenderer.invoke('cockpit:open-settings'),
  setWorkspaceFromFile: (file) => {
    try {
      const p = file ? webUtils.getPathForFile(file) : '';
      return p ? ipcRenderer.invoke('cockpit:set-workspace', p) : Promise.resolve({ ok: false, reason: 'directory required' });
    } catch (e) {
      return Promise.resolve({ ok: false, reason: e.message });
    }
  },
  close: () => ipcRenderer.send('cockpit:close'),
});
