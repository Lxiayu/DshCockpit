// src/search-preload.js — bridge for the session search window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshSearch', {
  query: (q) => ipcRenderer.invoke('search:query', q),
  close: () => ipcRenderer.send('search:close'),
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
});
