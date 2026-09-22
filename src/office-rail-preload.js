'use strict';

// src/office-rail-preload.js — the left function rail (M4 直启动, 2026-09-17;
// M4.2 follow-up: icon strip + accent). A scoped bridge only: the rail never
// touches the Harness and the office module keeps its seven `office:*`
// channels. Theme and accent are shell-side state: theme comes from the
// shell channels the cockpit established, accent is persisted by the main
// process in office-rail-state.json.

const { contextBridge, ipcRenderer } = require('electron');

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
});
