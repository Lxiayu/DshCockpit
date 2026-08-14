// src/pluginmarket-preload.js — bridge for the plugin market window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshMarket', {
  search: (keyword) => ipcRenderer.invoke('plugins:search', keyword),
  action: (action, fullName) => ipcRenderer.invoke('shell:plugin-action', action, fullName),
  close: () => ipcRenderer.send('plugins:close'),
  getSettings: () => ipcRenderer.invoke('shell:get-settings'),
});
