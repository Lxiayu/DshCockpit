// src/search-preload.js — bridge for the session search window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSearch', {
  query: (q) => ipcRenderer.invoke('search:query', q),
  close: () => ipcRenderer.send('search:close'),
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, t) => cb(t)),
});
