'use strict';

// src/workbench/workbench-preload.js — the Workbench shell's own bridge.
//
// The workbench window runs with nodeIntegrationInSubFrames so the embedded
// PREVIEW iframe (workbench://local/preview/office.html — a tool-served copy
// of the product office page) receives the REAL product bridge: this preload
// requires src/office/office-preload.js verbatim, so the office page talks to
// exactly the same whitelisted officeBridge implementation as in the product
// — zero drift by construction. The product itself never loads this preload;
// its windows keep sandbox: true and the untouched office-preload.
//
// The workbench UI bridge is exposed on the TOP frame only.

const { contextBridge, ipcRenderer } = require('electron');

// Same file the product loads — the seven whitelisted office:* channels.
require('../office/office-preload.js');

if (window.top === window) {
  // The M1 action panel needs the pure timing model in the renderer (playback
  // drives the REAL preview renderer frame by frame). Workbench code may
  // import runtime/tool code — only the reverse is forbidden (M0 boundary).
  const actionModel = require('./lib/action-model.js');
  contextBridge.exposeInMainWorld('workbenchBridge', {
    // left pane: the content/ tree (build/ excluded)
    contentTree: () => ipcRenderer.invoke('workbench:content-tree'),
    // right pane: geometry report over walk-left/right frames
    geometryReport: () => ipcRenderer.invoke('workbench:geometry-report'),
    // geometry of one selected entry (catalog asset id or content file)
    entryGeometry: (assetId) => ipcRenderer.invoke('workbench:entry-geometry', assetId),
    fileGeometry: (relPath) => ipcRenderer.invoke('workbench:file-geometry', relPath),
    // right pane: the catalog validator rows (red/green table)
    assetReport: () => ipcRenderer.invoke('workbench:asset-report'),
    // the publish validation (= scripts/workbench-publish.js, in-process)
    publish: () => ipcRenderer.invoke('workbench:publish'),
    // golden gallery
    galleryStatus: () => ipcRenderer.invoke('workbench:gallery-status'),
    generateGallery: () => ipcRenderer.invoke('workbench:generate-gallery'),
    // M1 action editor: timeline session (disk-backed), import normalization,
    // staged preview pack and the publish kernel
    actionModel: {
      MIN_FRAME_MS: actionModel.MIN_FRAME_MS,
      MAX_FRAME_MS: actionModel.MAX_FRAME_MS,
      DEFAULT_FRAME_DURATION_MS: actionModel.DEFAULT_FRAME_DURATION_MS,
      frameIndexAt: actionModel.frameIndexAt,
    },
    actionList: () => ipcRenderer.invoke('workbench:action-list'),
    actionRead: (actionId) => ipcRenderer.invoke('workbench:action-read', actionId),
    actionOp: (actionId, op, payload) => ipcRenderer.invoke('workbench:action-op', actionId, op, payload || {}),
    actionNew: (id, direction) => ipcRenderer.invoke('workbench:action-new', id, direction),
    actionImportPreview: (actionId, sourcePath) => ipcRenderer.invoke('workbench:action-import-preview', actionId, sourcePath),
    actionImportInsert: (actionId, sourcePath, name, index) => ipcRenderer.invoke('workbench:action-import-insert', actionId, sourcePath, name, index),
    actionStage: (actionId) => ipcRenderer.invoke('workbench:action-stage', actionId),
    actionPublish: (actionId) => ipcRenderer.invoke('workbench:action-publish', actionId),
    // pushes
    onPreviewSelection: (callback) => ipcRenderer.on('workbench:preview-selection', (_event, data) => callback(data)),
    onGalleryProgress: (callback) => ipcRenderer.on('workbench:gallery-progress', (_event, data) => callback(data)),
  });
}
