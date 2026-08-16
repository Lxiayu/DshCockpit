// src/quickask-preload.js — bridge for the Quick Ask window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshQuickAsk', {
  submit: (prompt) => ipcRenderer.invoke('quickask:submit', prompt),
  close: () => ipcRenderer.send('quickask:close'),
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, t) => cb(t)),
});
