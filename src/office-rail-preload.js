'use strict';

// src/office-rail-preload.js — the left function rail (M4 直启动, 2026-09-17;
// M4.2 follow-up: icon strip + accent). A scoped bridge only: the rail never
// touches the Harness and the office module keeps its seven `office:*`
// channels. Theme and accent are shell-side state: theme comes from the
// shell channels the cockpit established, accent is persisted by the main
// process in office-rail-state.json.

const { contextBridge, ipcRenderer } = require('electron');
// P1 English pass (2026-09-25): the rail's tooltips/labels resolve per
// language from the SHARED shell dictionary (src/i18n.js) through the same
// pattern as theme following (shell:get-language pull + shell:language push).
// A SANDBOXED preload cannot require repo files, so the tables are pulled once
// from the main process (shell:get-i18n; the single source stays src/i18n.js)
// and t() reproduces i18n.js's translate/fallback logic over them.

const languageListeners = new Set();
let I18N_TABLES = { zh: {}, en: {} };
const i18nTablesReady = ipcRenderer.invoke('shell:get-i18n')
  .then((tables) => { I18N_TABLES = tables; })
  .catch(() => I18N_TABLES); // a failed pull degrades to the key fallback
function translate(lang, key, vars) {
  let s = (I18N_TABLES[lang] && I18N_TABLES[lang][key]) || I18N_TABLES.en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
ipcRenderer.on('shell:language', (_e, value) => {
  for (const listener of languageListeners) {
    try { listener(value); } catch { /* listener errors never break the rail */ }
  }
});

contextBridge.exposeInMainWorld('officeRail', {
  // toggle the office: activates the office main-area view, or returns to the
  // harness view when the office is already active
  toggleOffice: () => ipcRenderer.invoke('office-rail:toggle-office'),
  // M4.2: switch the main area between the harness view and the office view
  switchView: (view) => ipcRenderer.invoke('office-rail:switch-view', view === 'office' ? 'office' : 'harness'),
  onViewState: (cb) => ipcRenderer.on('office-rail:view-state', (_e, value) => cb(value)),
  // rail accent (persisted by the main process; validated there too)
  setAccent: (accent) => ipcRenderer.invoke('office-rail:set-accent', typeof accent === 'string' ? accent : ''),
  onAccent: (cb) => ipcRenderer.on('office-rail:accent', (_e, value) => cb(value)),
  getState: () => ipcRenderer.invoke('office-rail:get-state'),
  onOfficeState: (cb) => ipcRenderer.on('office-rail:office-state', (_e, value) => cb(value)),
  getTheme: () => ipcRenderer.invoke('shell:get-theme'),
  onTheme: (cb) => ipcRenderer.on('shell:theme', (_e, value) => cb(value)),
  // P1 English pass: the shared shell dictionary (single source: src/i18n.js)
  // + the resolved shell language
  i18n: { t: translate, loaded: i18nTablesReady },
  getLanguage: () => ipcRenderer.invoke('shell:get-language'),
  onLanguage: (cb) => {
    if (typeof cb === 'function') languageListeners.add(cb);
    return () => languageListeners.delete(cb);
  },
});
