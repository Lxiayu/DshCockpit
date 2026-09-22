'use strict';

// src/office/office-preload.js — Task 7 / SPEC-07.
//
// The ONLY bridge between the office page and the main process. It exposes a
// narrow promise API over exactly the seven whitelisted invoke channels
// (office:state/dispatch/cancel/interrupt/settings/diagnostics/visibility);
// there are no raw send/on business channels. The main process
// re-validates every payload (schema + size limit + privacy redactor); the
// size guard here is defense in depth, not the authority.

const { contextBridge, ipcRenderer } = require('electron');

// Mirror of office-module.js OFFICE_IPC_CHANNELS (kept literal so the preload
// never imports main-process modules).
const ALLOWED_CHANNELS = Object.freeze([
  'office:state',
  'office:dispatch',
  'office:cancel',
  'office:interrupt',
  'office:settings',
  'office:diagnostics',
  'office:visibility',
]);

const MAX_PAYLOAD_BYTES = 8 * 1024;

function sanityCheckPayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('office payload must be a plain object');
  }
  const serialized = JSON.stringify(payload);
  if (typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new RangeError('office payload too large');
  }
  return payload;
}

function invokeAllowed(channel, payload) {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    return Promise.resolve({ ok: false, code: 'CHANNEL_UNKNOWN' });
  }
  let safe;
  try {
    safe = sanityCheckPayload(payload);
  } catch (error) {
    return Promise.resolve({ ok: false, code: error instanceof RangeError ? 'PAYLOAD_TOO_LARGE' : 'PAYLOAD_INVALID' });
  }
  return ipcRenderer.invoke(channel, safe);
}

const visibilityListeners = new Set();
const stateListeners = new Set();
ipcRenderer.on('office:visibility', (_event, payload) => {
  for (const listener of visibilityListeners) {
    try { listener(payload); } catch { /* listener errors never break the page */ }
  }
});
// Main-process push of the shared snapshot (one clock, up to two views).
ipcRenderer.on('office:state', (_event, snapshot) => {
  for (const listener of stateListeners) {
    try { listener(snapshot); } catch { /* listener errors never break the page */ }
  }
});

contextBridge.exposeInMainWorld('officeBridge', {
  getState: () => invokeAllowed('office:state', {}),
  dispatch: (payload) => invokeAllowed('office:dispatch', payload),
  cancel: (payload) => invokeAllowed('office:cancel', payload),
  interrupt: (payload) => invokeAllowed('office:interrupt', payload),
  getSettings: () => invokeAllowed('office:settings', { action: 'get' }),
  updateSettings: (settings) => invokeAllowed('office:settings', { action: 'set', settings }),
  getDiagnostics: () => invokeAllowed('office:diagnostics', {}),
  notifyVisibility: (visible) => invokeAllowed('office:visibility', { visible }),
  onVisibilityPush: (listener) => {
    if (typeof listener === 'function') visibilityListeners.add(listener);
    return () => visibilityListeners.delete(listener);
  },
  onState: (listener) => {
    if (typeof listener === 'function') stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
});
