'use strict';

// src/work/work-preload.js — 工作台视图的受限桥（v0.7 P1）。
//
// 只暴露一个通道 `shell:work`（action 载荷）+ 文件夹选择 + 主题/语言跟随。
// 渲染进程不接触 fs / Team / 绝对路径以外的任何东西；绝对路径只来自状态载荷
// （工作区展示用）与 open/reveal 的副作用。

const { contextBridge, ipcRenderer } = require('electron');

const languageListeners = new Set();
const updateListeners = new Set();
let I18N_TABLES = { zh: {}, en: {} };
const i18nTablesReady = ipcRenderer.invoke('shell:get-i18n')
  .then((tables) => { I18N_TABLES = tables; })
  .catch(() => I18N_TABLES);

function translate(lang, key, vars) {
  let s = (I18N_TABLES[lang] && I18N_TABLES[lang][key]) || I18N_TABLES.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

ipcRenderer.on('shell:language', (_e, value) => {
  for (const listener of languageListeners) {
    try { listener(value); } catch { /* listener errors never break the view */ }
  }
});

contextBridge.exposeInMainWorld('workApi', {
  invoke: (payload) => ipcRenderer.invoke('shell:work', payload),
  pickFolder: () => ipcRenderer.invoke('shell:pick-folder', 'workspace'),
  onUpdate: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_e, value) => { try { cb(value); } catch { /* ignore */ } };
    updateListeners.add(listener);
    ipcRenderer.on('work:update', listener);
    return () => {
      updateListeners.delete(listener);
      ipcRenderer.removeListener('work:update', listener);
    };
  },
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, value) => cb(value)),
  getLanguage: () => ipcRenderer.invoke('shell:get-language'),
  onLanguage: (cb) => {
    if (typeof cb === 'function') languageListeners.add(cb);
    return () => languageListeners.delete(cb);
  },
  i18n: { t: translate, loaded: i18nTablesReady },
});
