// src/loading-preload.js — progress bridge for the first-run loading window.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshLoading', {
  onProgress: (cb) => ipcRenderer.on('loading:progress', (_e, text) => cb(text)),
});
