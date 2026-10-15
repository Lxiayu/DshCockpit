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
  // The furniture catalog's GEOMETRY, read-only: the drag ghost needs the same
  // per-kind draft widths and content boxes the scene transaction uses to size a
  // placed item (studio/lib/scene/geometry.js artBoxPx), and the catalog is the
  // single source for both — the product's own editor consumes the same module.
  // Exposing two numbers and a bbox is not a second editor; it keeps the ghost
  // from ever drifting from what the transaction will actually place.
  const layoutAssets = require('../office/layout-assets.js');
  contextBridge.exposeInMainWorld('wbLayoutCatalog', {
    draftWidths: { ...layoutAssets.DRAFT_WIDTHS },
    boxOf: (assetId) => {
      const asset = layoutAssets.layoutAssetById(String(assetId));
      if (!asset) return null;
      return { kind: asset.kind, contentBbox: asset.contentBbox || null };
    },
  });
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

  // The studio entry (studio/main.js) registers this bridge's channels; the
  // office:workbench entry does not, so every call rejects there and callers
  // must treat a missing studio surface as "not running in the studio" rather
  // than an error. One preload keeps both entries on the same shell.
  contextBridge.exposeInMainWorld('studioBridge', {
    // the studio handshake: which capability domains this build carries
    info: () => ipcRenderer.invoke('studio:info'),
    // project & assets (P1): project.json + the .dshpack container
    projectInfo: () => ipcRenderer.invoke('studio:project-info'),
    packExport: (options) => ipcRenderer.invoke('studio:pack-export', options || {}),
    packInspect: (options) => ipcRenderer.invoke('studio:pack-inspect', options || {}),
    packImport: (options) => ipcRenderer.invoke('studio:pack-import', options || {}),
    packRoundTrip: (options) => ipcRenderer.invoke('studio:pack-roundtrip', options || {}),
    // scene (P2): conflict validation, the derived waypoint graph, zone re-sync
    sceneReport: (options) => ipcRenderer.invoke('studio:scene-report', options || {}),
    sceneWaypoints: (options) => ipcRenderer.invoke('studio:scene-waypoints', options || {}),
    sceneBoxes: (options) => ipcRenderer.invoke('studio:scene-boxes', options || {}),
    sceneSyncZones: (options) => ipcRenderer.invoke('studio:scene-sync-zones', options || {}),
    // the scene canvas editor: read the draft + boxes, apply edits (dry run or save)
    sceneDraft: (options) => ipcRenderer.invoke('studio:scene-draft', options || {}),
    sceneEdit: (options) => ipcRenderer.invoke('studio:scene-edit', options || {}),
    sceneFurniture: () => ipcRenderer.invoke('studio:scene-furniture'),
    // actions & the review bench (P3): schema v2, frame-anchored notes, publish
    actionList: () => ipcRenderer.invoke('studio:action-list'),
    actionShow: (actionId) => ipcRenderer.invoke('studio:action-show', actionId),
    actionBench: (actionId) => ipcRenderer.invoke('studio:action-bench', actionId),
    actionGaps: () => ipcRenderer.invoke('studio:action-gaps'),
    actionMigrate: (actionId) => ipcRenderer.invoke('studio:action-migrate', actionId || null),
    actionPublish: (actionId) => ipcRenderer.invoke('studio:action-publish', actionId),
    actionTag: (input) => ipcRenderer.invoke('studio:action-tag', input || {}),
    actionEvent: (input) => ipcRenderer.invoke('studio:action-event', input || {}),
    actionPingPong: (input) => ipcRenderer.invoke('studio:action-pingpong', input || {}),
    actionNotes: (actionId) => ipcRenderer.invoke('studio:action-notes', actionId),
    actionNoteAdd: (input) => ipcRenderer.invoke('studio:action-note-add', input || {}),
    actionNoteResolve: (input) => ipcRenderer.invoke('studio:action-note-resolve', input || {}),
    actionNotesExport: (input) => ipcRenderer.invoke('studio:action-notes-export', input || {}),
    // pipeline (P4): QC gates, matting cleanup, stage cache, provider registry
    pipelineQcAction: (options) => ipcRenderer.invoke('studio:pipeline-qc-action', options || {}),
    pipelineQcVideo: (options) => ipcRenderer.invoke('studio:pipeline-qc-video', options || {}),
    pipelineMatte: (options) => ipcRenderer.invoke('studio:pipeline-matte', options || {}),
    pipelineCache: (options) => ipcRenderer.invoke('studio:pipeline-cache', options || {}),
    pipelineProviders: () => ipcRenderer.invoke('studio:pipeline-providers'),
    // the generation loop (R4/R5): the S0–S8 registry, the dry walk, the executed
    // chain and the human triage queue — the pipeline panel's whole surface
    pipelineStages: () => ipcRenderer.invoke('studio:pipeline-stages'),
    pipelinePlan: (options) => ipcRenderer.invoke('studio:pipeline-plan', options || {}),
    pipelineRun: (options) => ipcRenderer.invoke('studio:pipeline-run', options || {}),
    pipelineTriageList: (options) => ipcRenderer.invoke('studio:pipeline-triage-list', options || {}),
    pipelineTriageResolve: (options) => ipcRenderer.invoke('studio:pipeline-triage-resolve', options || {}),
    // behaviour graphs (P6): validate / run / diff / feel over the shared module
    graphValidate: (options) => ipcRenderer.invoke('studio:graph-validate', options || {}),
    graphRun: (options) => ipcRenderer.invoke('studio:graph-run', options || {}),
    graphDiff: (options) => ipcRenderer.invoke('studio:graph-diff', options || {}),
    graphFeel: () => ipcRenderer.invoke('studio:graph-feel'),
    // the graph canvas (UI #2): list/read/save .vgraph files, move drawn nodes
    graphList: () => ipcRenderer.invoke('studio:graph-list'),
    graphRead: (options) => ipcRenderer.invoke('studio:graph-read', options || {}),
    graphSave: (options) => ipcRenderer.invoke('studio:graph-save', options || {}),
    graphMoveNode: (options) => ipcRenderer.invoke('studio:graph-move-node', options || {}),
    graphAutoLayout: (options) => ipcRenderer.invoke('studio:graph-auto-layout', options || {}),
    // the video track (P5): plan, VP9-alpha encode, runtime alpha probe, A/B
    videoPlan: (options) => ipcRenderer.invoke('studio:video-plan', options || {}),
    videoEncode: (options) => ipcRenderer.invoke('studio:video-encode', options || {}),
    videoProbeAlpha: (options) => ipcRenderer.invoke('studio:video-probe-alpha', options || {}),
    videoAb: (options) => ipcRenderer.invoke('studio:video-ab', options || {}),
    // the dialogue corpus (P7): two layers, guards, CSV import, and a seeded "say it"
    dialogueRead: (options) => ipcRenderer.invoke('studio:dialogue-read', options || {}),
    dialogueValidate: () => ipcRenderer.invoke('studio:dialogue-validate'),
    dialogueEdit: (options) => ipcRenderer.invoke('studio:dialogue-edit', options || {}),
    dialogueSave: (options) => ipcRenderer.invoke('studio:dialogue-save', options || {}),
    dialogueImportCsv: (options) => ipcRenderer.invoke('studio:dialogue-import-csv', options || {}),
    dialogueSay: (options) => ipcRenderer.invoke('studio:dialogue-say', options || {}),
    // the preview runner (P7): controls, event injection, diagnostics, redacted export
    previewStatus: () => ipcRenderer.invoke('studio:preview-status'),
    previewPlay: (options) => ipcRenderer.invoke('studio:preview-play', options || {}),
    previewPause: () => ipcRenderer.invoke('studio:preview-pause'),
    previewStep: (options) => ipcRenderer.invoke('studio:preview-step', options || {}),
    previewInject: (options) => ipcRenderer.invoke('studio:preview-inject', options || {}),
    previewControl: (options) => ipcRenderer.invoke('studio:preview-control', options || {}),
    previewScenarios: () => ipcRenderer.invoke('studio:preview-scenarios'),
    previewRunScenario: (options) => ipcRenderer.invoke('studio:preview-run-scenario', options || {}),
    previewDiagnostics: () => ipcRenderer.invoke('studio:preview-diagnostics'),
    previewSnapshot: () => ipcRenderer.invoke('studio:preview-snapshot'),
    previewExport: (options) => ipcRenderer.invoke('studio:preview-export', options || {}),
    // hot reload + page telemetry (P8)
    reloadContent: () => ipcRenderer.invoke('studio:reload-content'),
    watchContent: (options) => ipcRenderer.invoke('studio:content-watch', options || {}),
    unwatchContent: () => ipcRenderer.invoke('studio:content-unwatch'),
    previewTelemetry: () => ipcRenderer.invoke('studio:preview-telemetry'),
    onContentChanged: (callback) => ipcRenderer.on('studio:content-changed', (_event, data) => callback(data)),
    // the asset passport (studio/lib/provenance.js over the real trees)
    provenanceReport: (assetId) => ipcRenderer.invoke('studio:provenance-report', assetId),
    provenanceVerify: () => ipcRenderer.invoke('studio:provenance-verify'),
    provenanceIndex: (options) => ipcRenderer.invoke('studio:provenance-index', options || {}),
    provenanceLost: () => ipcRenderer.invoke('studio:provenance-lost'),
    // the generation-params ledger (the generation-call breakpoint)
    paramsLedger: (actionId) => ipcRenderer.invoke('studio:params-ledger', actionId),
    paramsRecord: (input) => ipcRenderer.invoke('studio:params-record', input),
    // the generation loop's live progress: one record per stage, as the chain runs
    onPipelineProgress: (callback) => ipcRenderer.on('studio:pipeline-progress', (_event, data) => callback(data)),
  });
}
