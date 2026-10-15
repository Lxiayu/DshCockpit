'use strict';

// studio/main.js — the studio entry (npm run studio, from studio/).
//
// The studio boots the SAME shell as `npm run office:workbench` — one
// implementation, two entry points (src/workbench/app/boot.js). What differs is
// deliberately small and explicit:
//   - its own isolated userData (.studio-data/, never the real profile),
//   - its own window title and stdout contract (STUDIO_READY),
//   - its own IPC surface (studio:*) carrying the capability domains the
//     workbench entries do not have (P0: the asset passport).
//
// Boundaries: the product runtime is imported READ-ONLY (src/office/** through
// the office-runtime protocol); the product never imports this package.

const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { registerToolSchemes, startToolApp } = require(path.join(__dirname, '..', 'src', 'workbench', 'app', 'boot.js'));
const { createStudioServices } = require(path.join(__dirname, 'lib', 'studio-services.js'));

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.STUDIO_DATA_DIR
  ? path.resolve(process.env.STUDIO_DATA_DIR)
  : path.join(REPO_ROOT, '.studio-data');

const READY_TOKEN = 'STUDIO_READY';
const FAIL_TOKEN = 'STUDIO_BOOT_FAILED';
const WINDOW_TITLE = 'Office Studio';
const PROBE_TITLE = 'PROBE 临时数据（可关闭）';
const STUDIO_EVIDENCE_DIR = process.env.STUDIO_EVIDENCE_DIR ? path.resolve(process.env.STUDIO_EVIDENCE_DIR) : null;
// renderer errors seen during an evidence run (empty is the healthy case)
const studioConsoleErrors = [];
// the window the IPC handlers push to (set on boot)
let mainWindowRef = null;

registerToolSchemes(protocol, 'workbench');

function registerStudioIpc({ ipcMain, studio }) {
  ipcMain.handle('studio:info', () => studio.info());
  // project & assets (P1)
  ipcMain.handle('studio:project-info', () => studio.projectInfo());
  ipcMain.handle('studio:pack-export', (_event, options) => studio.packExport(options || {}));
  ipcMain.handle('studio:pack-inspect', (_event, options) => studio.packInspect(options || {}));
  ipcMain.handle('studio:pack-import', (_event, options) => studio.packImport(options || {}));
  ipcMain.handle('studio:pack-roundtrip', (_event, options) => studio.packRoundTrip(options || {}));
  // scene (P2): conflicts, the derived waypoint graph, zone re-sync
  ipcMain.handle('studio:scene-report', (_event, options) => studio.sceneReport(options || {}));
  ipcMain.handle('studio:scene-waypoints', (_event, options) => studio.sceneWaypoints(options || {}));
  ipcMain.handle('studio:scene-boxes', (_event, options) => studio.sceneBoxes(options || {}));
  ipcMain.handle('studio:scene-sync-zones', (_event, options) => studio.sceneSyncZones(options || {}));
  // the scene canvas editor (UI #1)
  ipcMain.handle('studio:scene-draft', (_event, options) => studio.sceneDraft(options || {}));
  ipcMain.handle('studio:scene-edit', (_event, options) => studio.sceneEdit(options || {}));
  ipcMain.handle('studio:scene-furniture', () => studio.sceneFurniture());
  // actions & the review bench (P3)
  ipcMain.handle('studio:action-list', () => studio.actionList());
  ipcMain.handle('studio:action-show', (_event, actionId) => studio.actionShow(actionId));
  ipcMain.handle('studio:action-bench', (_event, actionId) => studio.actionBench(actionId));
  ipcMain.handle('studio:action-gaps', () => studio.actionGaps());
  ipcMain.handle('studio:action-migrate', (_event, actionId) => studio.actionMigrate(actionId || null));
  ipcMain.handle('studio:action-publish', (_event, actionId) => studio.actionPublish(actionId));
  ipcMain.handle('studio:action-tag', (_event, input) => studio.actionTag(input || {}));
  ipcMain.handle('studio:action-event', (_event, input) => studio.actionEvent(input || {}));
  ipcMain.handle('studio:action-pingpong', (_event, input) => studio.actionPingPong(input || {}));
  ipcMain.handle('studio:action-notes', (_event, actionId) => studio.actionNoteList(actionId));
  ipcMain.handle('studio:action-note-add', (_event, input) => studio.actionNoteAdd(input || {}));
  ipcMain.handle('studio:action-note-resolve', (_event, input) => studio.actionNoteResolve(input || {}));
  ipcMain.handle('studio:action-notes-export', (_event, input) => studio.actionNotesExport(input || {}));
  // pipeline (P4): QC, matting, the cache and the provider registry
  ipcMain.handle('studio:pipeline-qc-action', (_event, options) => studio.pipelineQcAction(options || {}));
  ipcMain.handle('studio:pipeline-qc-video', (_event, options) => studio.pipelineQcVideo(options || {}));
  ipcMain.handle('studio:pipeline-matte', (_event, options) => studio.pipelineMatte(options || {}));
  ipcMain.handle('studio:pipeline-cache', (_event, options) => studio.pipelineCache(options || {}));
  ipcMain.handle('studio:pipeline-providers', () => studio.pipelineProviders());
  // the generation loop (R4/R5) as a service: the S0–S8 registry, the dry walk
  // (plan), the executed chain (run, with live progress pushed to the window) and
  // the human triage queue
  ipcMain.handle('studio:pipeline-stages', () => studio.pipelineStages());
  ipcMain.handle('studio:pipeline-plan', (_event, options) => studio.pipelinePlan(options || {}));
  ipcMain.handle('studio:pipeline-run', (event, options) => studio.pipelineRun({
    ...(options || {}),
    // every stage record is pushed to the window that asked, the way the gallery
    // progress is: the panel renders the log as the chain advances
    onStage: (record) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) sender.send('studio:pipeline-progress', record);
    },
  }));
  ipcMain.handle('studio:pipeline-triage-list', (_event, options) => studio.pipelineTriageList(options || {}));
  ipcMain.handle('studio:pipeline-triage-resolve', (_event, options) => studio.pipelineTriageResolve(options || {}));
  // behaviour graphs (P6) — the shared interpreter module
  ipcMain.handle('studio:graph-validate', (_event, options) => studio.graphValidate(options || {}));
  ipcMain.handle('studio:graph-run', (_event, options) => studio.graphRun(options || {}));
  ipcMain.handle('studio:graph-diff', (_event, options) => studio.graphDiff(options || {}));
  ipcMain.handle('studio:graph-feel', () => studio.graphFeel());
  // the graph canvas (UI #2)
  ipcMain.handle('studio:graph-list', () => studio.graphList());
  ipcMain.handle('studio:graph-read', (_event, options) => studio.graphRead(options || {}));
  ipcMain.handle('studio:graph-save', (_event, options) => studio.graphSave(options || {}));
  ipcMain.handle('studio:graph-move-node', (_event, options) => studio.graphMoveNode(options || {}));
  ipcMain.handle('studio:graph-auto-layout', (_event, options) => studio.graphAutoLayout(options || {}));
  // the video track (P5)
  ipcMain.handle('studio:video-plan', (_event, options) => studio.videoPlan(options || {}));
  ipcMain.handle('studio:video-encode', (_event, options) => studio.videoEncode(options || {}));
  ipcMain.handle('studio:video-probe-alpha', (_event, options) => studio.videoProbeAlpha(options || {}));
  ipcMain.handle('studio:video-ab', (_event, options) => studio.videoAb(options || {}));
  // the dialogue corpus (P7)
  ipcMain.handle('studio:dialogue-read', (_event, options) => studio.dialogueRead(options || {}));
  ipcMain.handle('studio:dialogue-validate', () => studio.dialogueValidate());
  ipcMain.handle('studio:dialogue-edit', (_event, options) => studio.dialogueEdit(options || {}));
  ipcMain.handle('studio:dialogue-save', (_event, options) => studio.dialogueSave(options || {}));
  ipcMain.handle('studio:dialogue-import-csv', (_event, options) => studio.dialogueImportCsv(options || {}));
  ipcMain.handle('studio:dialogue-say', (_event, options) => studio.dialogueSay(options || {}));
  // the preview runner (P7): the real office module under studio control
  ipcMain.handle('studio:preview-status', () => studio.previewStatus());
  ipcMain.handle('studio:preview-play', (_event, options) => studio.previewPlay(options || {}));
  ipcMain.handle('studio:preview-pause', () => studio.previewPause());
  ipcMain.handle('studio:preview-step', (_event, options) => studio.previewStep(options || {}));
  ipcMain.handle('studio:preview-inject', (_event, options) => studio.previewInject(options || {}));
  ipcMain.handle('studio:preview-control', (_event, options) => studio.previewControl(options || {}));
  ipcMain.handle('studio:preview-scenarios', () => studio.previewScenarios());
  ipcMain.handle('studio:preview-run-scenario', (_event, options) => studio.previewRunScenario(options || {}));
  ipcMain.handle('studio:preview-diagnostics', () => studio.previewDiagnostics());
  ipcMain.handle('studio:preview-snapshot', () => studio.previewSnapshot());
  ipcMain.handle('studio:preview-export', (_event, options) => studio.previewExportBundle(options || {}));
  // hot reload + page telemetry (P8)
  ipcMain.handle('studio:reload-content', () => studio.reloadContent());
  ipcMain.handle('studio:content-watch', (_event, options) => studio.watchContent({
    onEvent: (payload) => {
      // push the change to the window; the renderer decides what to refresh (and never
      // silently swaps the running simulation)
      if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.webContents.send('studio:content-changed', payload);
      if (options && typeof options.onEvent === 'function') options.onEvent(payload);
    },
  }));
  ipcMain.handle('studio:content-unwatch', () => studio.unwatchContent());
  ipcMain.handle('studio:preview-telemetry', () => studio.previewTelemetry());
  // the asset passport
  ipcMain.handle('studio:provenance-report', (_event, assetId) => studio.provenanceReport(assetId));
  ipcMain.handle('studio:provenance-verify', () => studio.provenanceVerify());
  ipcMain.handle('studio:provenance-index', (_event, options) => studio.provenanceIndex(options || {}));
  ipcMain.handle('studio:provenance-lost', () => studio.provenanceLost());
  ipcMain.handle('studio:params-ledger', (_event, actionId) => studio.paramsLedger(actionId));
  ipcMain.handle('studio:params-record', (_event, input) => studio.recordParams(input));
}

let previewPushStop = null;
// push-path telemetry: "the simulation pushes" must be a measured fact, not a claim
const previewPushStats = { calls: 0, sent: 0, skipped: 0, errors: 0, lastAtMs: null, lastTarget: null, lastError: null };

async function runStudioEvidence(boot) {
  // P0 evidence sweep: prove the studio surface answers from the REAL repo —
  // the shell renders, and the studio IPC (passport) returns real data — then
  // exit. Deliberately small: later phases extend it with their own checks.
  const { writeJson, capturePageWithRetry, sleep } = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'gallery.js'));
  const fs = require('node:fs');
  const results = { mode: 'studio-evidence', startedAt: new Date().toISOString() };
  const note = (step, value) => {
    results[step] = value;
    // every note names the step it belongs to, so a failure or a hang always points at the
    // LAST thing the probe managed to record
    results.lastStep = step;
    try { writeJson(path.join(STUDIO_EVIDENCE_DIR, 'results.json'), results); } catch { /* best effort */ }
  };
  // ---- probe plumbing, declared ABOVE the try on purpose --------------------------
  //
  // The failure path needs these too. They used to live inside the try block, so the
  // moment a step failed the catch threw its own ReferenceError (`evaluate is not
  // defined`) — the run then hung with no error and no evidence, which hid the original
  // failure. A probe must be able to REPORT that it failed.
  const { services, mainWindow, officeFrame } = boot;
  let lastStep = 'start';
  // files the probe may write, with their pre-probe bytes: the failure path restores from here
  const contentBaseline = {};
  // R5: the pipeline panel's runs write two tool-output files the probe must hand back
  // exactly as it found them — the QC report (a GATE input: a red one blocks the publish)
  // and the triage queue (the human's list). Declared here so BOTH the success path and
  // the failure path can restore them.
  const qcReportFile = path.join(services.ctx.contentDir, 'build', 'qc', 'walk-left.qc.json');
  const triageFile = path.join(services.ctx.contentDir, 'build', 'triage', 'walk-left.triage.json');
  const restorePipelineFiles = () => {
    for (const file of [qcReportFile, triageFile]) {
      const baseline = contentBaseline[file];
      if (!baseline) continue;
      try {
        if (baseline.bytes === null) { if (fs.existsSync(file)) fs.rmSync(file); }
        else fs.writeFileSync(file, baseline.bytes);
      } catch { /* best effort before reporting */ }
    }
  };
  // persisted immediately (not at the next note) so a hang can be attributed from the file
  const step = (name) => {
    lastStep = name;
    results.lastStep = name;
    try { writeJson(path.join(STUDIO_EVIDENCE_DIR, 'results.json'), results); } catch { /* best effort */ }
  };
  // a probe that HANGS is worse than one that fails: name the step and time out, so a
  // blocked renderer becomes a recorded failure instead of a run nobody can kill
  const evaluate = (expression) => {
    const call = mainWindow.webContents.executeJavaScript(expression, true);
    return Promise.race([
      call,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`EVALUATE_TIMEOUT at step "${lastStep}": ${String(expression).slice(0, 120)}`)), 20000)),
    ]);
  };

  try {
    fs.mkdirSync(STUDIO_EVIDENCE_DIR, { recursive: true });
    note('dataDir', DATA_DIR);
    note('windowTitle', mainWindow.getTitle());
    note('studioInfo', services && services.studioInfo ? services.studioInfo() : null);

    const frame = officeFrame();
    note('previewReady', frame ? await frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true) : false);

    // the passport answers from the real content/pack trees
    const studio = boot.extension.studio;
    const report = studio.provenanceReport('walk-left');
    note('passportWalkLeft', {
      ok: report.ok,
      kind: report.kind,
      reproducible: report.reproducible,
      segments: (report.segments || []).map((segment) => ({ id: segment.id, status: segment.status })),
      frameCount: report.frames ? report.frames.length : null,
    });
    const verify = studio.provenanceVerify();
    note('passportVerifyCounts', verify.counts);
    const ledger = studio.paramsLedger('walk-left');
    note('paramsLedger', { ok: ledger.ok, dir: ledger.dir, recordCount: Array.isArray(ledger.records) ? ledger.records.length : null });

    // the renderer bridge answers too (the studio:info handshake)
    const bridgeInfo = await mainWindow.webContents.executeJavaScript('window.studioBridge ? window.studioBridge.info() : null', true);
    note('rendererBridgeInfo', bridgeInfo && { ok: bridgeInfo.ok, version: bridgeInfo.version, packId: bridgeInfo.packId });

    // the SHARED tool surface must answer inside the studio shell as well —
    // read-only calls prove the two entries really run one service layer.
    const actionRead = await mainWindow.webContents.executeJavaScript('window.workbenchBridge.actionRead("working-back")', true);
    note('sharedActionRead', {
      ok: actionRead.ok,
      frames: Array.isArray(actionRead.frames) ? actionRead.frames.length : null,
      hasValidation: Boolean(actionRead.validation),
    });
    const actionList = await mainWindow.webContents.executeJavaScript('window.workbenchBridge.actionList()', true);
    note('sharedActionList', { count: Array.isArray(actionList.actions) ? actionList.actions.length : null });
    const geometry = await mainWindow.webContents.executeJavaScript('window.workbenchBridge.geometryReport()', true);
    note('sharedGeometryRows', Array.isArray(geometry.rows) ? geometry.rows.length : null);
    const galleryStatus = await mainWindow.webContents.executeJavaScript('window.workbenchBridge.galleryStatus()', true);
    note('sharedGalleryStatus', { hasCurrent: galleryStatus.hasCurrent, hasPrevious: galleryStatus.hasPrevious });

    // P1: the project model and the .dshpack round trip, driven through the
    // panel's own service calls (export → import → per-file sha256 compare).
    const projectInfo = studio.projectInfo();
    note('projectInfo', {
      ok: projectInfo.ok, id: projectInfo.id, fileCount: projectInfo.fileCount,
      totalBytes: projectInfo.totalBytes, missing: projectInfo.missing.length, digest: projectInfo.digest,
    });
    const roundTrip = studio.packRoundTrip({});
    note('packRoundTrip', {
      ok: roundTrip.ok, stage: roundTrip.stage, files: roundTrip.files,
      beforeDigest: roundTrip.beforeDigest, afterDigest: roundTrip.afterDigest,
      packSha256: roundTrip.packSha256, changed: roundTrip.changed,
    });
    const viaBridge = await mainWindow.webContents.executeJavaScript('window.studioBridge.projectInfo()', true);
    note('rendererProjectInfo', { ok: viaBridge.ok, id: viaBridge.id, missing: viaBridge.missing.length });

    // P1 panel evidence: drive the REAL panel through the DOM (switch tab →
    // the passport table renders → the round-trip button runs) and capture it.
    const { waitUntil } = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'gallery.js'));
    step('passport-panel');
    await evaluate("document.getElementById('tab-passport').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-passport').hidden === false"), 15000, 'passport panel shown');
    await waitUntil(() => evaluate("document.getElementById('passport-project').textContent.includes('whale-office')"), 20000, 'project summary rendered');
    note('panelProjectText', await evaluate("document.getElementById('passport-project').textContent"));
    note('panelPassportRows', await evaluate("Array.from(document.querySelectorAll('#passport-table tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent))"));
    note('panelLedgerText', await evaluate("document.querySelector('#passport-ledger .wb-hint') ? document.querySelector('#passport-ledger .wb-hint').textContent : null"));
    await evaluate("document.getElementById('btn-pack-roundtrip').click()");
    await waitUntil(() => evaluate("document.getElementById('pack-roundtrip-result').textContent.includes('往返一致')"), 120000, 'round-trip result rendered');
    note('panelRoundTripText', await evaluate("document.getElementById('pack-roundtrip-result').textContent"));
    await sleep(400);
    const panelImage = await capturePageWithRetry(mainWindow.webContents, 'passport panel');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-passport-panel.png'), panelImage.toPNG());

    // P2 panel evidence: the scene validator, the derived waypoint graph and the
    // zone re-sync, all driven through the real DOM.
    await evaluate("document.getElementById('tab-scene').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-scene').hidden === false"), 15000, 'scene panel shown');
    await waitUntil(() => evaluate("document.getElementById('scene-summary').textContent.includes('场景') === false && document.getElementById('scene-summary').textContent.length > 20"), 30000, 'scene report rendered');
    note('sceneSummaryText', await evaluate("document.getElementById('scene-summary').textContent"));
    note('sceneRows', await evaluate("Array.from(document.querySelectorAll('#scene-table tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent))"));
    await evaluate("document.getElementById('btn-scene-waypoints').click()");
    await waitUntil(() => evaluate("document.getElementById('scene-waypoints').textContent.includes('节点')"), 30000, 'waypoints rendered');
    note('sceneWaypointsText', await evaluate("document.getElementById('scene-waypoints').textContent"));
    await evaluate("document.getElementById('btn-scene-sync').click()");
    await waitUntil(() => evaluate("document.getElementById('scene-sync-result').textContent.includes('漂移') || document.getElementById('scene-sync-result').textContent.includes('一致')"), 30000, 'sync dry run rendered');
    note('sceneSyncText', await evaluate("document.getElementById('scene-sync-result').textContent"));
    await sleep(300);
    const sceneImage = await capturePageWithRetry(mainWindow.webContents, 'scene panel');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-scene-panel.png'), sceneImage.toPNG());
    // P3 panel evidence: the review bench (frame strip + overlays + notes + gaps).
    // The probe WRITES one note and then removes the sidecar again, so the real
    // content tree is left exactly as it was (asserted below).
    const fsLib = require('node:fs');
    const BENCH_ACTION = 'walk-left'; // 15 frames: the strip, onion skin and foot-line rows have something to show
    const noteSidecar = path.join(REPO_ROOT, 'content', 'characters', 'whale-girl', 'actions', `${BENCH_ACTION}.notes.json`);
    const hadNotes = fsLib.existsSync(noteSidecar);
    await evaluate("document.getElementById('tab-bench').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-bench').hidden === false"), 15000, 'bench panel shown');
    await waitUntil(() => evaluate("document.querySelectorAll('#bench-action option').length > 0"), 30000, 'action list loaded');
    await evaluate(`(() => {
      const select = document.getElementById('bench-action');
      select.value = ${JSON.stringify(BENCH_ACTION)};
      select.dispatchEvent(new Event('change'));
    })()`);
    await waitUntil(() => evaluate("document.querySelectorAll('#bench-strip img').length > 5"), 30000, 'bench strip rendered');
    note('benchSummaryText', await evaluate("document.getElementById('bench-summary').textContent"));
    note('benchFrameCount', await evaluate("document.querySelectorAll('#bench-strip img').length"));
    note('benchFootLines', await evaluate("document.querySelectorAll('#bench-strip .bench-foot').length"));
    await evaluate("document.getElementById('bench-centroid').checked = true; document.getElementById('bench-centroid').dispatchEvent(new Event('change'))");
    note('benchCentroidMarkers', await evaluate("document.querySelectorAll('#bench-strip .bench-marker').length"));
    await evaluate("document.getElementById('bench-onion').checked = true; document.getElementById('bench-onion').dispatchEvent(new Event('change'))");
    note('benchGhosts', await evaluate("document.querySelectorAll('#bench-strip .bench-ghost').length"));
    if (!hadNotes) {
      await evaluate(`(() => {
        document.getElementById('bench-note-frame').value = '2';
        document.getElementById('bench-note-text').value = 'PROBE 批注（证据后自动清理）';
        document.getElementById('btn-bench-note-add').click();
      })()`);
      await waitUntil(() => evaluate("document.querySelectorAll('#bench-notes .gallery-row').length > 0"), 30000, 'note rendered');
      note('benchNoteRow', await evaluate("document.querySelector('#bench-notes .gallery-row').textContent"));
      const listed = studio.listNotes ? studio.listNotes('walk-left') : null;
      note('benchNotesOnDisk', listed ? listed.notes.length : null);
      fsLib.rmSync(noteSidecar, { force: true });
    }
    note('benchNoteSidecarCleaned', !fsLib.existsSync(noteSidecar));
    await evaluate("document.getElementById('btn-bench-gaps').click()");
    await waitUntil(() => evaluate("document.getElementById('bench-gaps').textContent.includes('必需') || document.getElementById('bench-gaps').textContent.includes('缺口')"), 30000, 'gaps rendered');
    note('benchGapsText', await evaluate("document.getElementById('bench-gaps').textContent"));

    // UI #3 evidence: the timeline — segments, playhead, scrub, play, ping-pong
    note('timelineSegments', await evaluate("document.querySelectorAll('#timeline-track .timeline-segment').length"));
    note('timelineReadout', await evaluate("document.getElementById('timeline-readout').textContent"));
    await evaluate("document.getElementById('btn-timeline-play').click()");
    await sleep(700);
    note('timelineAfterPlay', await evaluate("document.getElementById('timeline-readout').textContent"));
    await evaluate("document.getElementById('btn-timeline-play').click()");
    note('timelinePlayButton', await evaluate("document.getElementById('btn-timeline-play').textContent"));
    // scrub to 60% of the track with a pointer drag
    await evaluate(`(() => {
      const timeline = document.getElementById('bench-timeline');
      const rect = timeline.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width * 0.6);
      const y = Math.round(rect.top + rect.height / 2);
      timeline.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y }));
      timeline.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y }));
      timeline.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'mouse', clientX: x, clientY: y }));
    })()`);
    await sleep(200);
    note('timelineAfterScrub', await evaluate("document.getElementById('timeline-readout').textContent"));
    note('timelineCurrentTile', await evaluate("(document.querySelector('#bench-strip .bench-frame.current') || {}).textContent || null"));
    await evaluate("document.getElementById('btn-timeline-step').click()");
    note('timelineAfterStep', await evaluate("document.getElementById('timeline-readout').textContent"));
    await sleep(200);
    const timelineImage = await capturePageWithRetry(mainWindow.webContents, 'review bench timeline');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-bench-timeline.png'), timelineImage.toPNG());
    await sleep(300);
    const benchImage = await capturePageWithRetry(mainWindow.webContents, 'review bench');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-bench-panel.png'), benchImage.toPNG());

    // UI #1 evidence: drive the SCENE CANVAS through real pointer events — select an
    // item, drag it, watch the live validation, save, then RESTORE the file from the
    // backup the save itself produced (a probe must leave the tree exactly as it found
    // it, and the restore is verified byte-for-byte).
    const layoutPath = path.join(REPO_ROOT, 'content', 'scenes', 'flat', 'layout.json');
    const zonesPath = path.join(REPO_ROOT, 'content', 'scenes', 'flat', 'zones.json');
    const layoutBefore = fsLib.readFileSync(layoutPath);
    const zonesBefore = fsLib.readFileSync(zonesPath);
    await evaluate("document.getElementById('tab-scene').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-scene').hidden === false"), 15000, 'scene panel shown');
    await waitUntil(() => evaluate("document.querySelectorAll('#scene-canvas').length === 1 && document.getElementById('canvas-status').textContent.length > 0"), 20000, 'canvas ready');
    note('canvasInitialStatus', await evaluate("document.getElementById('canvas-status').textContent"));
    await sleep(600);
    note('canvasRowsAfterLoad', await evaluate("document.querySelectorAll('#scene-table tbody tr').length"));
    // select the pantry island by clicking its box centre (computed from the panel's own data)
    const pick = await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      const rect = canvas.getBoundingClientRect();
      const target = window.__probePick || null;
      return target ? { x: rect.left + (target.x * rect.width), y: rect.top + (target.y * rect.height) } : null;
    })()`);
    void pick;
    // fall back to a direct selection through the canvas hit test: click at the centre of
    // the island's art box, computed by the main process from the real catalog data
    const boxes = studio.sceneBoxes({});
    const island = boxes.items.find((item) => item.asset === 'flat-island');
    const sceneMeta = studio.sceneReport({}).scene;
    const islandCentre = { x: (island.box.x + island.box.width / 2) / sceneMeta.width, y: (island.box.y + island.box.height / 2) / sceneMeta.height };
    const pointFromNormalized = async (point) => evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round(rect.left + ${point.x} * rect.width), y: Math.round(rect.top + ${point.y} * rect.height) };
    })()`);
    const start = await pointFromNormalized(islandCentre);
    await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: ${start.x}, clientY: ${start.y} };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    })()`);
    note('canvasSelected', await evaluate("document.getElementById('canvas-selection').textContent"));
    // drag it 40 scene-px right and 20 down, in two moves, then release
    const step1 = await pointFromNormalized({ x: islandCentre.x + 0.03125, y: islandCentre.y + 0.02381 });
    await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: ${step1.x}, clientY: ${step1.y} }));
    })()`);
    note('canvasDragStatus', await evaluate("document.getElementById('canvas-status').textContent"));
    await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', clientX: ${step1.x}, clientY: ${step1.y} }));
    })()`);
    await waitUntil(() => evaluate("document.getElementById('canvas-status').textContent.includes('待保存') || document.getElementById('canvas-status').textContent.includes('违规')"), 20000, 'drag validated');
    note('canvasAfterDrag', await evaluate("document.getElementById('canvas-status').textContent"));
    note('canvasSceneRows', await evaluate("document.querySelectorAll('#scene-table tbody tr').length"));
    if (await evaluate("document.getElementById('canvas-status').textContent.includes('待保存')")) {
      await evaluate("document.getElementById('btn-canvas-save').click()");
      await waitUntil(() => evaluate("document.getElementById('canvas-status').textContent.includes('已保存') || document.getElementById('canvas-status').textContent.includes('拒绝')"), 30000, 'save settled');
      note('canvasSaveStatus', await evaluate("document.getElementById('canvas-status').textContent"));
      note('layoutChanged', !fsLib.readFileSync(layoutPath).equals(layoutBefore));
      const backups = fsLib.existsSync(path.join(REPO_ROOT, 'content', 'build', 'backups', 'layout'))
        ? fsLib.readdirSync(path.join(REPO_ROOT, 'content', 'build', 'backups', 'layout')).sort()
        : [];
      note('layoutBackupCount', backups.length);
      // RESTORE BOTH FILES the save touched (the layout AND the derived zones) from the
      // backups that same save produced, and prove byte-equality with the pre-probe state.
      // A probe that leaves the tree dirty is a probe that lies about what it verified.
      note('restoredFromBackup', (() => {
        const backupRoot = path.join(REPO_ROOT, 'content', 'build', 'backups', 'layout');
        const layoutBackup = backups.filter((name) => name.endsWith('-flat-layout.json')).pop();
        const zonesBackup = backups.filter((name) => name.endsWith('-flat-zones.json')).pop();
        if (!layoutBackup || !zonesBackup) return false;
        fsLib.copyFileSync(path.join(backupRoot, layoutBackup), layoutPath);
        fsLib.copyFileSync(path.join(backupRoot, zonesBackup), zonesPath);
        return fsLib.readFileSync(layoutPath).equals(layoutBefore) && fsLib.readFileSync(zonesPath).equals(zonesBefore);
      })());
      note('treeCleanAfterProbe', fsLib.readFileSync(layoutPath).equals(layoutBefore) && fsLib.readFileSync(zonesPath).equals(zonesBefore));
    }
    await sleep(300);
    const canvasImage = await capturePageWithRetry(mainWindow.webContents, 'scene canvas');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-scene-canvas.png'), canvasImage.toPNG());

    // UI #2 evidence: drive the BEHAVIOUR-GRAPH canvas — validate, select a node, drag it,
    // save (backup) and restore the file from that save's own backup.
    const graphFile = path.join(REPO_ROOT, 'content', 'graphs', 'local-behaviour.vgraph.json');
    const graphBefore = fsLib.readFileSync(graphFile);
    await evaluate("document.getElementById('tab-graph').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-graph').hidden === false"), 15000, 'graph panel shown');
    await waitUntil(() => evaluate("document.getElementById('graph-status').textContent.includes('节点')"), 30000, 'graph loaded');
    note('graphLoadStatus', await evaluate("document.getElementById('graph-status').textContent"));
    const graphRead = studio.graphRead({ name: 'local-behaviour.vgraph.json' });
    const layout = (graphRead.graph.meta && graphRead.graph.meta.layout) || studio.graphAutoLayout({ graph: graphRead.graph }).layout;
    const target = layout.do || { x: 0.5, y: 0.5 };
    const graphPoint = async (point) => evaluate(`(() => {
      const canvas = document.getElementById('graph-canvas');
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.round(rect.left + ((40 + ${point.x} * (canvas.width - 80)) / canvas.width) * rect.width),
        y: Math.round(rect.top + ((40 + ${point.y} * (canvas.height - 80)) / canvas.height) * rect.height),
      };
    })()`);
    const nodeAt = await graphPoint(target);
    await evaluate(`(() => {
      const canvas = document.getElementById('graph-canvas');
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 3, pointerType: 'mouse', clientX: ${nodeAt.x}, clientY: ${nodeAt.y} }));
    })()`);
    // The selected node's FIELDS are shown in the behaviour page's INSPECTOR (#panel-item-graph,
    // in #wb-right), not in the work area: T8 moved #graph-node-detail out of the canvas panel,
    // whose job is dragging. So this step proves "selecting a node shows its fields" where the
    // fields actually live — the inspector panel is visible on this page, and it carries the
    // clicked node's JSON.
    await waitUntil(() => evaluate("document.getElementById('panel-item-graph').hidden === false"), 15000, 'the behaviour inspector shows the selected node');
    const graphNodeDetail = await evaluate("document.getElementById('graph-node-detail').textContent");
    note('graphNodeSelected', graphNodeDetail.slice(0, 80));
    note('graphNodeFieldsShown', await evaluate("Boolean(document.getElementById('graph-node-detail').textContent.includes('\"id\"'))"));
    const dropAt = await graphPoint({ x: target.x + 0.1, y: target.y + 0.05 });
    await evaluate(`(() => {
      const canvas = document.getElementById('graph-canvas');
      canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, pointerType: 'mouse', clientX: ${dropAt.x}, clientY: ${dropAt.y} }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, pointerType: 'mouse', clientX: ${dropAt.x}, clientY: ${dropAt.y} }));
    })()`);
    await waitUntil(() => evaluate("document.getElementById('graph-status').textContent.includes('未保存')"), 15000, 'drag staged');
    note('graphDragStatus', await evaluate("document.getElementById('graph-status').textContent"));
    await evaluate("document.getElementById('btn-graph-save').click()");
    await waitUntil(() => evaluate("document.getElementById('graph-status').textContent.includes('已保存') || document.getElementById('graph-status').textContent.includes('拒绝') || document.getElementById('graph-status').textContent.includes('无变更')"), 30000, 'save settled');
    note('graphSaveStatus', await evaluate("document.getElementById('graph-status').textContent"));
    note('graphFileChanged', !fsLib.readFileSync(graphFile).equals(graphBefore));
    note('graphRestored', (() => {
      const dir = path.join(REPO_ROOT, 'content', 'build', 'backups', 'graphs');
      if (!fsLib.existsSync(dir)) return false;
      const backups = fsLib.readdirSync(dir).sort();
      if (backups.length === 0) return false;
      fsLib.copyFileSync(path.join(dir, backups[backups.length - 1]), graphFile);
      return fsLib.readFileSync(graphFile).equals(graphBefore);
    })());
    try {
      await evaluate("document.getElementById('btn-graph-run').click()");
    } catch (error) {
      note('graphRunClickError', String((error && error.message) || error));
      note('graphRunButtonExists', await evaluate("Boolean(document.getElementById('btn-graph-run'))"));
      note('graphHandlerAttached', await evaluate("typeof window.studioBridge.graphRun"));
    }
    try {
      await waitUntil(() => evaluate("document.getElementById('graph-run-result').textContent.includes('轨迹')"), 30000, 'graph run rendered');
      note('graphRunLines', await evaluate("document.getElementById('graph-run-result').textContent.split(String.fromCharCode(10)).length"));
    } catch (error) {
      note('graphRunRenderError', String((error && error.message) || error));
      note('graphRunText', (await evaluate("document.getElementById('graph-run-result').textContent")).slice(0, 200));
    }
    await evaluate("document.getElementById('btn-graph-diff').click()");
    await waitUntil(() => evaluate("document.getElementById('graph-diff-result').textContent.includes('段 vs 图')"), 30000, 'diff rendered');
    note('graphDiffFirstLine', (await evaluate("document.getElementById('graph-diff-result').textContent")).split(String.fromCharCode(10))[0]);
    await sleep(300);
    const graphImage = await capturePageWithRetry(mainWindow.webContents, 'graph canvas');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-graph-canvas.png'), graphImage.toPNG());

    // UX pass evidence: the workspace states — panes collapsed, rail tab switching, tree
    // filtering and keyboard navigation. No content is touched.
    const shellState = () => evaluate(`JSON.stringify({
      left: !document.body.classList.contains('wb-left-collapsed'),
      right: !document.body.classList.contains('wb-right-collapsed'),
      tab: (document.querySelector('#wb-tabs .wb-tab[aria-pressed="true"]') || {}).id || null,
      treeRows: document.querySelectorAll('#tree-root .tree-row').length,
      treeFiles: document.querySelectorAll('#tree-root .tree-row[data-type="file"]').length,
      summary: (document.getElementById('tree-summary') || {}).textContent || null,
    })`).then(JSON.parse);
    note('shellExpanded', await shellState());
    await evaluate("document.getElementById('btn-toggle-left').click()");
    await sleep(250);
    note('shellLeftCollapsed', await shellState());
    note('shellRailVisible', await evaluate("Boolean(document.getElementById('wb-rail-left')) && !document.getElementById('wb-rail-left').hidden"));
    await evaluate("document.getElementById('btn-toggle-right').click()");
    await sleep(250);
    note('shellBothCollapsed', await shellState());
    await evaluate("document.querySelector('#wb-rail-right .wb-rail-tab[data-tab=\"tab-bench\"]').click()");
    await sleep(300);
    note('shellRailTabSwitch', await shellState());
    await evaluate("document.getElementById('btn-toggle-left').click()");
    await sleep(250);
    // the IDE tree: expand all, then filter, then keyboard-walk to a file
    await evaluate("document.getElementById('btn-tree-expand').click()");
    await sleep(250);
    note('treeExpandedAll', await shellState());
    await evaluate(`(() => {
      const filter = document.getElementById('tree-filter');
      filter.value = 'walk-left';
      filter.dispatchEvent(new Event('input'));
    })()`);
    await sleep(250);
    note('treeFiltered', await shellState());
    note('treeFilteredFirstRow', await evaluate("(document.querySelector('#tree-root .tree-row') || {}).textContent || null"));
    // read the summary in the SAME expression that filters (proves the render is synchronous)
    note('treeError', await evaluate("window.__treeError || null"));
    note('treeSummaryAfterFilter', await evaluate(`(() => {
      const filter = document.getElementById('tree-filter');
      filter.value = 'working-back';
      filter.dispatchEvent(new Event('input'));
      return document.getElementById('tree-summary').textContent;
    })()`));
    await evaluate(`(() => {
      const root = document.getElementById('tree-root');
      root.focus();
      const keys = ['ArrowDown', 'ArrowDown', 'ArrowRight'];
      for (const key of keys) root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    })()`);
    await sleep(250);
    note('treeKeyboardFocus', await evaluate("(document.querySelector('#tree-root .tree-row.focused') || {}).textContent || null"));
    await evaluate("document.getElementById('tree-filter').value = ''; document.getElementById('tree-filter').dispatchEvent(new Event('input'))");
    await sleep(200);
    const shellImage = await capturePageWithRetry(mainWindow.webContents, 'workspace shell');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-workspace.png'), shellImage.toPNG());

    // P7 evidence: the dialogue corpus panel — two layers, the guard report, an edit
    // staged and saved (then restored from that save's own backup) and "say it".
    const baseCorpusFile = path.join(REPO_ROOT, 'content', 'shared', 'dialogue', 'base.json');
    const corpusBefore = fsLib.readFileSync(baseCorpusFile);
    await evaluate("document.getElementById('tab-dialogue').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-dialogue').hidden === false"), 15000, 'dialogue panel shown');
    await waitUntil(() => evaluate("document.querySelectorAll('#dialogue-topics .dialogue-topic').length > 0"), 30000, 'topics rendered');
    note('dialogueStatusBase', await evaluate("document.getElementById('dialogue-status').textContent"));
    note('dialogueTopics', await evaluate("document.querySelectorAll('#dialogue-topics .dialogue-topic').length"));
    // switch to the character layer and select a topic with an override
    await evaluate(`(() => {
      const select = document.getElementById('dialogue-layer');
      select.value = 'character';
      select.dispatchEvent(new Event('change'));
    })()`);
    await waitUntil(() => evaluate("document.getElementById('dialogue-status').textContent.includes('character')"), 20000, 'character layer loaded');
    note('dialogueStatusCharacter', await evaluate("document.getElementById('dialogue-status').textContent"));
    note('dialogueTableRows', await evaluate("document.querySelectorAll('#dialogue-table tbody tr').length"));
    // back to the base layer, add a line, save, verify, restore
    await evaluate(`(() => {
      const select = document.getElementById('dialogue-layer');
      select.value = 'base';
      select.dispatchEvent(new Event('change'));
    })()`);
    await waitUntil(() => evaluate("document.getElementById('dialogue-status').textContent.includes('base')"), 20000, 'base layer loaded again');
    await evaluate(`(() => {
      document.getElementById('dialogue-new-text').value = 'PROBE 临时台词（证据后还原）';
      document.getElementById('dialogue-new-weight').value = '2';
      document.getElementById('btn-dialogue-add').click();
    })()`);
    await waitUntil(() => evaluate("document.getElementById('dialogue-status').textContent.includes('已暂存')"), 20000, 'line staged');
    note('dialogueAdded', await evaluate("document.getElementById('dialogue-status').textContent"));
    // a RED line is refused at STAGE time (the guard runs on every edit, not only on
    // save): the line never enters the document, so the file cannot be dirtied at all
    await evaluate(`(() => {
      document.getElementById('dialogue-new-text').value = 'run_abcdef123456 挂了';
      document.getElementById('btn-dialogue-add').click();
    })()`);
    await waitUntil(() => evaluate("document.getElementById('dialogue-status').textContent.includes('加入被拒')"), 20000, 'red line refused at stage time');
    note('dialogueStageRefusal', await evaluate("document.getElementById('dialogue-status').textContent"));
    note('corpusFileUnchangedAfterRefusal', fsLib.readFileSync(baseCorpusFile).equals(corpusBefore));
    // now save the good line for real
    await evaluate("document.getElementById('btn-dialogue-save').click()");
    await waitUntil(() => evaluate("document.getElementById('dialogue-status').textContent.includes('已保存') || document.getElementById('dialogue-status').textContent.includes('被拒') || document.getElementById('dialogue-status').textContent.includes('无变更')"), 30000, 'save settled');
    note('dialogueSaveStatus', await evaluate("document.getElementById('dialogue-status').textContent"));
    note('corpusFileChanged', !fsLib.readFileSync(baseCorpusFile).equals(corpusBefore));
    note('corpusRestored', (() => {
      const dir = path.join(REPO_ROOT, 'content', 'build', 'backups', 'dialogue');
      if (!fsLib.existsSync(dir)) return false;
      const backups = fsLib.readdirSync(dir).sort();
      if (backups.length === 0) return false;
      fsLib.copyFileSync(path.join(dir, backups[backups.length - 1]), baseCorpusFile);
      return fsLib.readFileSync(baseCorpusFile).equals(corpusBefore);
    })());
    await evaluate("document.getElementById('btn-dialogue-say').click()");
    await waitUntil(() => evaluate("document.getElementById('dialogue-bubble').textContent.length > 2"), 20000, 'bubble rendered');
    note('dialogueSaidLine', await evaluate("document.getElementById('dialogue-bubble').textContent"));
    note('dialogueSayStatus', await evaluate("document.getElementById('dialogue-status').textContent"));
    await sleep(300);
    const corpusImage = await capturePageWithRetry(mainWindow.webContents, 'dialogue corpus');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-dialogue-panel.png'), corpusImage.toPNG());
    note('corpusTreeCleanAfterProbe', fsLib.readFileSync(baseCorpusFile).equals(corpusBefore));

    // P7 evidence (second half): the preview runner — the REAL office module drives the
    // embedded office page, the panel injects events, and the diagnostics bundle exports
    // redacted. The page side is queried too, so "the page really renders the runner's
    // snapshot" is asserted by the page itself rather than by our panel's text.
    await evaluate("document.getElementById('tab-preview').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-preview').hidden === false"), 15000, 'preview panel shown');
    await waitUntil(() => evaluate("document.querySelectorAll('#preview-table tbody tr').length > 0"), 30000, 'preview table rendered');
    note('previewStatusLine', await evaluate("document.getElementById('preview-status').textContent"));
    note('previewEmployeeRows', await evaluate("Array.from(document.querySelectorAll('#preview-table tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent))"));
    // the embedded page must see the SAME simulation (not the empty stub snapshot)
    const pageState = await (async () => {
      const frame = officeFrame();
      if (!frame) return null;
      return frame.executeJavaScript(`(() => {
        const api = window.__office && window.__office.api;
        const snapshot = api && typeof api.snapshot === 'function' ? api.snapshot() : null;
        return snapshot ? {
          employees: (snapshot.employees || []).length,
          first: (snapshot.employees || [])[0] ? { id: snapshot.employees[0].employeeId, activity: snapshot.employees[0].activity } : null,
          layoutSource: typeof api.runtimeLayoutSource === 'function' ? api.runtimeLayoutSource() : null,
        } : null;
      })()`, true).catch(() => null);
    })();
    note('previewPageState', pageState);
    // Run the task-complete script from the panel. The panel line "脚本 … 完成" only says the
    // SCRIPT ran; the claim that matters is that the MODULE processed the injected events and
    // reached a terminal result. So: stop the wall clock, run the script, then advance the
    // logical clock in bounded steps and record the tick the terminal appeared on — a
    // deterministic assertion instead of a wall-clock race (the P8 probe caught the race:
    // a stale 600ms poll could overwrite the panel line right after it was written).
    boot.extension.studio.previewPause();
    const clickAt = Date.now();
    await evaluate("document.getElementById('btn-preview-scenario-complete').click()");
    // the RESULT line (not the live status line, which every refresh re-renders)
    const resultText = () => evaluate("document.getElementById('preview-scenario-result').textContent");
    let scenarioText = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      scenarioText = await resultText();
      if (/完成|失败|done|failed/i.test(scenarioText)) break;
      await sleep(500);
    }
    note('previewScenarioStatus', { text: scenarioText, reportedAtMs: Date.now() - clickAt, ticks: boot.extension.studio.previewStatus().status.ticks });
    if (!/完成|失败|done|failed/i.test(scenarioText)) throw new Error(`scenario script never reported: ${scenarioText}`);
    const terminal = (snapshot) => {
      const row = (snapshot && snapshot.employees ? snapshot.employees : []).find((employee) => employee.employeeId === 'orchestrator');
      return row && row.lastResult ? { outcome: row.lastResult.outcome || null, activity: row.activity || null, phase: (row.transition && row.transition.phase) || null } : null;
    };
    let reached = null;
    for (let attempt = 0; attempt < 160 && !reached; attempt += 1) {
      boot.extension.studio.previewStep({ ticks: 25 });
      const statusNow = boot.extension.studio.previewStatus();
      const snapshotNow = boot.extension.studio.previewSnapshot();
      const found = terminal(snapshotNow.snapshot);
      if (found) reached = { ...found, ticks: statusNow.status.ticks, logicalMs: statusNow.status.logicalMs };
    }
    note('previewScenarioTerminal', reached || { reached: false, note: 'no terminal result within 4000 logical ticks after the script' });
    note('previewOrchestratorRow', await evaluate(`(() => {
      const row = [...document.querySelectorAll('#preview-table tbody tr')].find((tr) => tr.children[0].textContent === 'orchestrator');
      return row ? Array.from(row.children).map((td) => td.textContent) : null;
    })()`));
    // raw injection through the form
    await evaluate(`(() => {
      document.getElementById('preview-event-type').value = 'tool/call';
      document.getElementById('preview-session').value = 'sess-studio-probe';
      document.getElementById('preview-data').value = '{"tool":"read_file"}';
      document.getElementById('btn-preview-inject').click();
    })()`);
    await waitUntil(() => evaluate("document.getElementById('preview-status').textContent.includes('已注入') || document.getElementById('preview-status').textContent.includes('注入被拒')"), 30000, 'raw injection handled');
    note('previewInjectStatus', await evaluate("document.getElementById('preview-status').textContent"));
    // diagnostics bundle export
    await evaluate("document.getElementById('btn-preview-export').click()");
    await waitUntil(() => evaluate("document.getElementById('preview-export-result').textContent.includes('已导出') || document.getElementById('preview-export-result').textContent.includes('被拒')"), 30000, 'bundle exported');
    note('previewExportText', (await evaluate("document.getElementById('preview-export-result').textContent")).split(String.fromCharCode(10)).slice(0, 3));
    note('previewExportScanClean', (await evaluate("document.getElementById('preview-export-result').textContent")).includes('已导出'));
    await sleep(400);
    const previewImage = await capturePageWithRetry(mainWindow.webContents, 'preview runner');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-preview-runner.png'), previewImage.toPNG());

    // Visual pass evidence: the theme toggle really switches the tokens, both themes
    // render, and the empty states are in place. (The badge below is captured in dark,
    // so the screenshot set shows both.)
    const themeState = () => evaluate(`JSON.stringify({
      attr: document.body.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).getPropertyValue('--wb-bg').trim(),
      ink: getComputedStyle(document.body).getPropertyValue('--wb-ink').trim(),
      button: (document.getElementById('btn-theme') || {}).textContent || null,
      tabCount: document.querySelectorAll('#wb-tabs .wb-tab').length,
      tabWrap: getComputedStyle(document.getElementById('wb-tabs')).flexWrap,
      emptyBlocks: document.querySelectorAll('.wb-empty').length,
    })`).then(JSON.parse);
    note('themeSystem', await themeState());
    await evaluate("document.getElementById('btn-theme').click()");
    await sleep(200);
    note('themeLight', await themeState());
    await evaluate("document.getElementById('btn-theme').click()");
    await sleep(250);
    note('themeDark', await themeState());
    await evaluate("document.getElementById('tab-scene').click()");
    await sleep(300);
    const darkShot = await capturePageWithRetry(mainWindow.webContents, 'dark theme');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-theme-dark.png'), darkShot.toPNG());
    await evaluate("document.getElementById('btn-theme').click()");
    await sleep(200);
    note('themeBackToSystem', await themeState());
    await evaluate("document.getElementById('tab-preview').click()");
    await sleep(300);
    const lightShot = await capturePageWithRetry(mainWindow.webContents, 'light theme');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-theme-light.png'), lightShot.toPNG());

    // i18n evidence: the language control switches the whole chrome (attributes, titles,
    // placeholders and the JS-built empty states), not just one label.
    const langState = () => evaluate(`JSON.stringify({
      button: (document.getElementById('btn-lang') || {}).textContent || null,
      htmlLang: document.documentElement.lang,
      title: (document.getElementById('wb-title') || {}).textContent || null,
      tabScene: (document.getElementById('tab-scene') || {}).textContent || null,
      headPreview: (document.querySelector('#panel-preview h3') || {}).textContent || null,
      treeFilter: (document.getElementById('tree-filter') || {}).placeholder || null,
      leftTitle: (document.getElementById('btn-toggle-left') || {}).title || null,
    })`).then(JSON.parse);
    // the cycle is 跟随系统 → 中文 → English, so from 'system' it takes TWO clicks to reach
    // English (the first click pins Chinese explicitly)
    note('langSystem', await langState());
    await evaluate("document.getElementById('btn-lang').click()");
    await sleep(250);
    note('langExplicitChinese', await langState());
    await evaluate("document.getElementById('btn-lang').click()");
    await sleep(300);
    note('langEnglish', await langState());
    await evaluate("document.getElementById('tab-graph').click()");
    await sleep(350);
    note('langEnglishAfterTabSwitch', await langState());
    const englishShot = await capturePageWithRetry(mainWindow.webContents, 'english shell');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-lang-en.png'), englishShot.toPNG());
    await evaluate("document.getElementById('btn-lang').click()");
    await sleep(250);
    note('langBackToSystem', await langState());
    const backShot = await capturePageWithRetry(mainWindow.webContents, 'chinese shell');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-lang-zh.png'), backShot.toPNG());

    note('sceneServiceReport', (() => {
      const report = studio.sceneReport({});
      return {
        ok: report.ok,
        code: report.code || null,
        stats: report.stats || null,
        graphStats: report.graph ? report.graph.stats : null,
        stations: Array.isArray(report.stations) ? report.stations.length : null,
      };
    })());

    await sleep(400);
    const image = await capturePageWithRetry(mainWindow.webContents, 'studio shell');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-shell.png'), image.toPNG());

    // ---- P8 UX probes: palette · splitters · keyboard map · hot reload · telemetry ----
    //
    // Everything here is driven through the SHIPPED event wiring (synthetic DOM events +
    // real IPC + a real mtime bump), so a dead listener fails the probe instead of being
    // papered over by calling the handler directly.
    const paletteState = () => evaluate(`JSON.stringify({
      open: !document.getElementById('wb-palette').hidden,
      value: document.getElementById('wb-palette-input').value,
      items: [...document.querySelectorAll('#wb-palette-list .wb-palette-item')].map((el) => el.dataset.commandId || 'empty'),
      selected: (() => { const el = document.querySelector('#wb-palette-list .wb-palette-item[aria-selected="true"]'); return el ? el.dataset.commandId : null; })(),
      activeTab: (() => { const el = document.querySelector('#wb-tabs .wb-tab[aria-selected="true"]'); return el ? el.id : null; })(),
    })`).then(JSON.parse);
    const pressKey = (targetJs, spec) => evaluate(`(() => { const el = ${targetJs}; el.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(spec)})); return true; })()`);
    const pressGlobal = (spec) => evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(spec)})); return true; })()`);
    const widthState = () => evaluate(`JSON.stringify({
      cssLeft: getComputedStyle(document.body).getPropertyValue('--wb-left-w').trim(),
      cssRight: getComputedStyle(document.body).getPropertyValue('--wb-right-w').trim(),
      thumbLeft: document.getElementById('wb-splitter-left').style.left,
      stored: (() => { try { return (JSON.parse(localStorage.getItem('wb-shell-state-v1') || '{}').widths) || null; } catch { return null; } })(),
    })`).then(JSON.parse);
    const shellFlags = () => evaluate(`JSON.stringify({
      leftCollapsed: document.body.classList.contains('wb-left-collapsed'),
      rightCollapsed: document.body.classList.contains('wb-right-collapsed'),
      activeTab: (() => { const el = document.querySelector('#wb-tabs .wb-tab[aria-selected="true"]'); return el ? el.id : null; })(),
      railTabs: document.querySelectorAll('#wb-rail-right .wb-rail-tab').length,
    })`).then(JSON.parse);

    // 1) palette: open with the real shortcut, filter, run with Enter, close with Escape
    await pressGlobal({ key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await sleep(250);
    const paletteOpen = await paletteState();
    note('paletteOpened', { open: paletteOpen.open, count: paletteOpen.items.length, selected: paletteOpen.selected });
    const paletteShot = await capturePageWithRetry(mainWindow.webContents, 'command palette');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-palette.png'), paletteShot.toPNG());
    await evaluate(`(() => { const input = document.getElementById('wb-palette-input'); input.value = 'tab:'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(250);
    const paletteFiltered = await paletteState();
    note('paletteFiltered', {
      value: paletteFiltered.value,
      open: paletteFiltered.open,
      count: paletteFiltered.items.length,
      items: paletteFiltered.items.slice(0, 14),
      filteredDown: paletteFiltered.items.length < paletteOpen.items.length,
    });
    await pressKey(`document.getElementById('wb-palette-input')`, { key: 'ArrowDown', bubbles: true, cancelable: true });
    const paletteAfterDown = await paletteState();
    await pressKey(`document.getElementById('wb-palette-input')`, { key: 'Enter', bubbles: true, cancelable: true });
    await sleep(450);
    const paletteAfterEnter = await paletteState();
    note('paletteRunByEnter', {
      selectedIndexMoved: paletteAfterDown.selected !== paletteFiltered.selected,
      selected: paletteAfterDown.selected,
      openAfterRun: paletteAfterEnter.open,
      activeTab: paletteAfterEnter.activeTab,
      // the command id is `tab:<tabId>`; the tab it switches to drops the prefix
      ranTheSelectedCommand: paletteAfterEnter.open === false && paletteAfterEnter.activeTab === String(paletteAfterDown.selected).replace(/^tab:/, ''),
    });
    await pressGlobal({ key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await sleep(200);
    await pressKey(`document.getElementById('wb-palette-input')`, { key: 'Escape', bubbles: true, cancelable: true });
    await sleep(200);
    note('paletteEscapeCloses', { open: (await paletteState()).open });

    // 2) splitters: pointer drag, arrow-key steps, clamping, double-click reset, persistence
    note('widthsInitial', await widthState());
    const dragSplitter = (targetJs, from, to) => evaluate(`(() => { const el = ${targetJs};
      el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: ${from}, bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: ${to}, bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: ${to}, bubbles: true }));
      return true; })()`);
    await dragSplitter(`document.getElementById('wb-splitter-left')`, 268, 392);
    await sleep(250);
    note('widthsAfterDrag', await widthState());
    await pressKey(`document.getElementById('wb-splitter-left')`, { key: 'ArrowLeft', bubbles: true, cancelable: true });
    await pressKey(`document.getElementById('wb-splitter-left')`, { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true });
    await sleep(250);
    note('widthsAfterArrowKeys', await widthState());
    await dragSplitter(`document.getElementById('wb-splitter-left')`, 392, 900);
    await sleep(250);
    note('widthsClampedToMax', await widthState());
    await evaluate(`document.getElementById('wb-splitter-left').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(250);
    note('widthsAfterDoubleClick', await widthState());

    // 3) keyboard map: pane toggles and the digit tab jump
    note('shortcutsBefore', await shellFlags());
    await pressGlobal({ key: 'b', metaKey: true, bubbles: true, cancelable: true });
    await sleep(250);
    note('afterToggleLeftShortcut', await shellFlags());
    await pressGlobal({ key: 'b', metaKey: true, bubbles: true, cancelable: true });
    await sleep(200);
    await pressGlobal({ key: 'j', metaKey: true, bubbles: true, cancelable: true });
    await sleep(250);
    note('afterToggleRightShortcut', await shellFlags());
    await pressGlobal({ key: 'j', metaKey: true, bubbles: true, cancelable: true });
    await sleep(200);
    // the digit shortcut is expected to hit the Nth CHIP, so read the chip order from the
    // DOM instead of hardcoding a tool name (the order is a design decision, not a fact)
    const fourthChip = await evaluate("(document.querySelectorAll('#wb-tabs .wb-tab')[3] || {}).id || null");
    await pressGlobal({ key: '4', metaKey: true, bubbles: true, cancelable: true });
    await sleep(350);
    note('afterDigitShortcut', { ...(await shellFlags()), expectedChip: fourthChip });

    // 4) hot reload: the watcher is live, an mtime bump reaches the status line, and the
    //    file comes back byte-identical (this probe never edits content)
    note('hotReloadWatching', await evaluate(`(async () => { const outcome = await window.studioBridge.watchContent({}); return outcome && { ok: outcome.ok, already: !!outcome.already, roots: outcome.watching }; })()`));
    const watchedFile = path.join(services.ctx.contentDir, 'characters', 'whale-girl', 'character.json');
    const watchedBefore = fs.readFileSync(watchedFile);
    const statusBefore = await evaluate(`document.getElementById('wb-status').textContent`);
    // write the file's OWN bytes back: a real write event for the watcher, and content
    // that cannot drift (the byte-equality check below would fail otherwise)
    fs.writeFileSync(watchedFile, watchedBefore);
    const hotReloadStatus = await evaluate(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 12000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const text = document.getElementById('wb-status').textContent;
        if (/内容已变化|内容已更新/.test(text)) return text;
      }
      return document.getElementById('wb-status').textContent;
    })()`);
    const watchedAfter = fs.readFileSync(watchedFile);
    note('hotReloadEvent', {
      statusBefore,
      statusAfter: hotReloadStatus,
      reachedStatusLine: /内容已变化|内容已更新/.test(hotReloadStatus),
      byteIdentical: watchedBefore.equals(watchedAfter),
      bytes: watchedAfter.length,
    });
    // the ⌘R path: a full re-read that also refreshes the visible panel
    await pressGlobal({ key: 'r', metaKey: true, bubbles: true, cancelable: true });
    const reloadStatus = await evaluate(`(async () => {
      const started = Date.now();
      while (Date.now() - started < 12000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const text = document.getElementById('wb-status').textContent;
        if (/已重新读取|重新读取失败/.test(text)) return text;
      }
      return document.getElementById('wb-status').textContent;
    })()`);
    note('hotReloadReloadStatus', { text: reloadStatus, ok: /已重新读取/.test(reloadStatus) });

    // 5) page telemetry: the shell asks the PREVIEW PAGE what it renders with, and the
    //    answer travels into the diagnostics bundle
    const telemetryPlaceholder = await evaluate(`document.getElementById('preview-telemetry').textContent`);
    await evaluate(`document.getElementById('btn-preview-telemetry').click()`);
    const telemetryText = await evaluate(`(async () => {
      const el = document.getElementById('preview-telemetry');
      const placeholder = ${JSON.stringify(telemetryPlaceholder)};
      const started = Date.now();
      // wait for the READOUT, not the placeholder: the hint text also mentions "渲染后端"
      while (Date.now() - started < 12000) {
        if (el.textContent !== placeholder && /webgl|canvas2d|读取失败/.test(el.textContent)) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { text: el.textContent, className: el.className };
    })()`);
    note('rendererTelemetryReadout', { ...telemetryText, ok: /渲染后端/.test(telemetryText.text) });
    const bundleOut = `build/diagnostics/p8-probe-${Date.now()}.json`;
    const bundle = boot.extension.studio.previewExportBundle({ out: bundleOut, extra: { rendererTelemetry: await boot.extension.studio.previewTelemetry() } });
    let bundleShape = { ok: bundle.ok, code: bundle.code || null };
    if (bundle.ok) {
      const written = JSON.parse(fs.readFileSync(bundle.written, 'utf8'));
      bundleShape = {
        ok: true,
        bytes: bundle.bytes,
        hasRendererTelemetry: Boolean(written.rendererTelemetry),
        backend: written.rendererTelemetry ? written.rendererTelemetry.backend : null,
        rafPerSecond: written.rendererTelemetry ? written.rendererTelemetry.rafPerSecond : null,
        secretHits: bundle.hits || [],
      };
      fs.unlinkSync(bundle.written); // the probe never leaves artifacts behind
    }
    note('rendererTelemetryInBundle', bundleShape);

    // ---- R1 probes: the stage (canvas-first) · one tool at a time · drop-to-place ----
    //
    // The restructure's claims are about layout and interaction, so they are driven the
    // way a person drives them: real events on the real elements, and one probe that
    // really writes a layout through a drop — then restores it from the transaction's OWN
    // backups and proves the bytes came back.
    const stageState = () => evaluate(`JSON.stringify({
      mode: document.getElementById('stage').dataset.mode,
      zoom: document.getElementById('stage-zoom').textContent,
      transform: document.getElementById('stage-world').style.transform,
      worldSize: document.getElementById('stage-world').style.width + '×' + document.getElementById('stage-world').style.height,
      sceneLayerVisible: getComputedStyle(document.getElementById('stage-scene-layer')).display !== 'none',
      officeLayerVisible: getComputedStyle(document.getElementById('preview-slot')).display !== 'none',
      empty: !document.getElementById('stage-empty').hidden,
      visiblePanels: [...document.querySelectorAll('.wb-panel')].filter((el) => !el.hidden && el.offsetParent !== null).map((el) => el.id),
      toolName: (document.getElementById('inspector-tool') || {}).textContent || '',
      canvas: (() => { const el = document.getElementById('scene-canvas'); const box = el.getBoundingClientRect(); return { w: Math.round(box.width), h: Math.round(box.height) }; })(),
    })`).then(JSON.parse);
    note('stageOnLoad', await stageState());
    await evaluate("document.getElementById('btn-stage-fit').click()");
    await sleep(250);
    note('stageAfterFit', await stageState());
    await evaluate("document.getElementById('btn-stage-zoom-in').click(); document.getElementById('btn-stage-zoom-in').click()");
    await sleep(200);
    note('stageAfterZoomIn', await stageState());
    await evaluate(`(() => { const vp = document.getElementById('stage-viewport'); const box = vp.getBoundingClientRect();
      vp.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, clientX: box.left + 300, clientY: box.top + 200, bubbles: true, cancelable: true }));
      return true; })()`);
    await sleep(200);
    note('stageAfterWheel', await stageState());
    await evaluate(`(() => { const vp = document.getElementById('stage-viewport'); const box = vp.getBoundingClientRect();
      const at = (type, x, y) => vp.dispatchEvent(new PointerEvent(type, { pointerId: 3, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      at('pointerdown', box.left + 40, box.top + 40); at('pointermove', box.left + 120, box.top + 96); at('pointerup', box.left + 120, box.top + 96);
      return true; })()`);
    await sleep(200);
    note('stageAfterPan', await stageState());
    await evaluate("document.getElementById('btn-stage-reset').click()");
    const stageShot = await capturePageWithRetry(mainWindow.webContents, 'stage (edit mode)');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-stage-edit.png'), stageShot.toPNG());

    // the library palette is the PRODUCT catalog, as tiles you can drag
    note('stageLibrary', await evaluate(`JSON.stringify({
      tiles: document.querySelectorAll('#library-root .library-tile').length,
      draggable: [...document.querySelectorAll('#library-root .library-tile')].filter((el) => el.draggable).length,
      firstTile: (() => { const el = document.querySelector('#library-root .library-tile'); return el ? { asset: el.dataset.asset, label: el.querySelector('span').textContent, imgOk: el.querySelector('img').naturalWidth > 0 } : null; })(),
      summary: (document.getElementById('library-summary') || {}).textContent || '',
    })`).then(JSON.parse));

    // one tool at a time: switching tools never stacks panels
    for (const tab of ['tab-preview', 'tab-bench', 'tab-dialogue', 'tab-scene']) {
      await evaluate(`document.getElementById('${tab}').click()`);
      await sleep(260);
    }
    const afterTools = await stageState();
    note('stageOneToolAtATime', { visiblePanels: afterTools.visiblePanels, toolName: afterTools.toolName });

    // ---- R2-B probes: pages own the work area, the stage becomes a live dock ----------
    const pagePageState = () => evaluate(`JSON.stringify({
      page: document.body.dataset.page,
      pressed: [...document.querySelectorAll('#wb-activitybar .wb-page-btn')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.page),
      visiblePages: [...document.querySelectorAll('#wb-mainview .wb-page')].filter((v) => !v.hidden).map((v) => v.dataset.pageView),
      visibleChips: [...document.querySelectorAll('#wb-tabs .wb-tab')].filter((c) => c.offsetParent !== null).map((c) => c.id),
      dock: (() => { const el = document.getElementById('wb-dock'); const box = el.getBoundingClientRect(); return { w: Math.round(box.width), h: Math.round(box.height) }; })(),
      libraryVisible: getComputedStyle(document.getElementById('library-root')).display !== 'none',
      libraryDisplay: getComputedStyle(document.getElementById('library-root')).display,
      heights: {
        columns: Math.round(document.getElementById('wb-columns').getBoundingClientRect().height),
        center: Math.round(document.getElementById('wb-center').getBoundingClientRect().height),
        mainview: Math.round(document.getElementById('wb-mainview').getBoundingClientRect().height),
        dock: Math.round(document.getElementById('wb-dock').getBoundingClientRect().height),
        stage: Math.round(document.getElementById('stage').getBoundingClientRect().height),
      },
      centerStyle: (() => { const cs = getComputedStyle(document.getElementById('wb-center')); return { display: cs.display, flexDirection: cs.flexDirection, minHeight: cs.minHeight }; })(),
      leftPane: (() => { const el = document.getElementById('wb-left'); return { display: getComputedStyle(el).display, collapsed: document.body.classList.contains('wb-left-collapsed'), bodyClasses: document.body.className }; })(),
      dockStyle: (() => { const cs = getComputedStyle(document.getElementById('wb-dock')); return { flex: cs.flex, display: cs.display }; })(),
      stageMode: document.getElementById('stage').dataset.mode,
      runFrameAlive: (() => { const f = document.getElementById('preview-frame'); return Boolean(f && f.contentWindow); })(),
    })`).then(JSON.parse);
    // the pane state is REMEMBERED, so a previous probe can leave the left pane collapsed —
    // then every "is the palette visible" measurement is about a collapsed pane, not the page
    const leftCollapsed = await evaluate("document.body.classList.contains('wb-left-collapsed')");
    if (leftCollapsed) {
      await evaluate("document.getElementById('btn-toggle-left').click()");
      await sleep(300);
    }
    const pageLog = [];
    for (const page of ['animation', 'behaviour', 'dialogue', 'quality', 'observe']) {
      await evaluate(`document.getElementById('page-${page}').click()`);
      await sleep(400);
      pageLog.push(await pagePageState());
    }
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(400);
    pageLog.push(await pagePageState());
    note('pagesWalkThrough', pageLog);
    note('pagesInvariants', {
      onePageAtATime: pageLog.every((entry) => entry.visiblePages.length === 1 && entry.visiblePages[0] === entry.page),
      onePressedButton: pageLog.every((entry) => entry.pressed.length === 1 && entry.pressed[0] === entry.page),
      chipsBelongToThePage: pageLog.every((entry) => entry.visibleChips.length >= 1),
      stageNeverReloaded: pageLog.every((entry) => entry.runFrameAlive),
      dockShrinksOffCanvasPages: pageLog.filter((entry) => !['scene', 'observe'].includes(entry.page)).every((entry) => entry.dock.h < 420),
      // 场景 = canvas page: the stage owns the work area. 观测 (since T11) is NOT a canvas page
      // any more — it shows a full-width employee table with an ENLARGED live dock under it —
      // so the old "both fill" clause was replaced by one expectation per page rather than a
      // number tweaked to pass.
      sceneFillsTheDock: pageLog.filter((entry) => entry.page === 'scene').every((entry) => entry.dock.h > 420),
      observeDockIsEnlarged: pageLog.filter((entry) => entry.page === 'observe').every((entry) => entry.dock.h >= 300),
      libraryOnlyOnScene: pageLog.every((entry) => entry.libraryVisible === (entry.page === 'scene')),
    });

    // 运行 brings the product render up AND fits it — the "点了运行却看不见" case
    await evaluate("document.getElementById('btn-stage-mode-run').click()");
    await sleep(400);
    const inRun = await stageState();
    note('stageRunMode', { mode: inRun.mode, officeLayerVisible: inRun.officeLayerVisible, sceneLayerVisible: inRun.sceneLayerVisible, zoom: inRun.zoom });
    const runShot = await capturePageWithRetry(mainWindow.webContents, 'stage (run mode)');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-stage-run.png'), runShot.toPNG());
    await evaluate("document.getElementById('btn-stage-mode-edit').click()");
    await sleep(250);

    // ---- the drop that really writes: a furniture tile onto the canvas ----------
    //
    // This is the one probe in this batch that changes content. It restores from the
    // TRANSACTION'S OWN backups (layout + zones) and asserts byte-equality afterwards —
    // the same discipline the canvas probe follows.
    const layoutFile = path.join(services.ctx.contentDir, 'scenes', 'flat', 'layout.json');
    const zonesFile = path.join(services.ctx.contentDir, 'scenes', 'flat', 'zones.json');
    const beforeLayout = fs.readFileSync(layoutFile);
    const beforeZones = fs.readFileSync(zonesFile);
    contentBaseline[layoutFile] = { bytes: beforeLayout };
    contentBaseline[zonesFile] = { bytes: beforeZones };
    const itemsBefore = JSON.parse(beforeLayout.toString('utf8')).items.length;
    await evaluate(`(() => {
      const vp = document.getElementById('stage-viewport');
      const box = vp.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('application/x-wb-furniture', 'flat-sofa');
      vp.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, clientX: box.left + 260, clientY: box.top + 200, bubbles: true, cancelable: true }));
      vp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: box.left + 260, clientY: box.top + 200, bubbles: true, cancelable: true }));
      return true;
    })()`);
    // POLL for the write: the drop stages -> validates -> writes, and a fixed sleep raced it
    // (the run that found this left the test furniture on disk — the restore below is now
    // unconditional for exactly that reason)
    const beforeIds = new Set(JSON.parse(beforeLayout.toString('utf8')).items.map((item) => item.id));
    let itemsAfterDrop = [];
    let droppedItem = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await sleep(250);
      itemsAfterDrop = JSON.parse(fs.readFileSync(layoutFile, 'utf8')).items;
      droppedItem = itemsAfterDrop.find((item) => !beforeIds.has(item.id)) || null;
      if (droppedItem) break;
    }
    note('stageDropFurniture', {
      itemsBefore,
      itemsAfter: itemsAfterDrop.length,
      added: droppedItem ? { id: droppedItem.id, asset: droppedItem.asset, kind: droppedItem.kind, position: droppedItem.position } : null,
      canvasStatus: await evaluate("document.getElementById('canvas-status').textContent"),
      obstaclesAfter: JSON.parse(fs.readFileSync(zonesFile, 'utf8')).obstacles.length,
    });
    // dropping a DOCUMENT opens its tool (and never touches the layout)
    const beforeRefusal = fs.readFileSync(layoutFile);
    const dropPath = (filePath) => evaluate(`(() => {
      const vp = document.getElementById('stage-viewport');
      const dt = new DataTransfer();
      dt.setData('application/x-wb-path', ${JSON.stringify(filePath)});
      dt.setData('text/plain', ${JSON.stringify(filePath)});
      vp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 10, clientY: 10, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await dropPath('characters/whale-girl/character.json');
    await sleep(700);
    note('stageDropDocument', {
      status: await evaluate("document.getElementById('wb-status').textContent"),
      activePanel: await evaluate("(() => { const el = [...document.querySelectorAll('#wb-right .wb-panel')].find((node) => !node.hidden); return el ? el.id : null; })()"),
      layoutUnchanged: fs.readFileSync(layoutFile).equals(beforeRefusal),
    });
    // and something that is NOT a canvas thing is refused with the reason, writing nothing
    await dropPath('characters/whale-girl/provenance/notes.txt');
    await sleep(600);
    note('stageDropUnsupported', {
      status: await evaluate("document.getElementById('wb-status').textContent"),
      hint: await evaluate("document.getElementById('stage-hint').textContent"),
      layoutUnchanged: fs.readFileSync(layoutFile).equals(beforeRefusal),
    });

    // restore, unconditionally: remove every item the probe's own drop added, then prove the
    // bytes came back. This runs whether or not the drop was observed.
    const liveExtras = () => JSON.parse(fs.readFileSync(layoutFile, 'utf8')).items.filter((item) => !beforeIds.has(item.id)).map((item) => item.id);
    const extras = liveExtras();
    if (extras.length === 0) {
      note('stageDropRestore', { added: 0, alreadyClean: true, layoutByteIdentical: fs.readFileSync(layoutFile).equals(beforeLayout), zonesByteIdentical: fs.readFileSync(zonesFile).equals(beforeZones) });
    }
    for (const extraId of extras) {
      boot.extension.studio.sceneEdit({ sceneId: 'flat', edits: [{ itemId: extraId, remove: true }], save: true });
    }
    // the last resort is the transaction's OWN backup (byte copy of the file it replaced)
    if (!fs.readFileSync(layoutFile).equals(beforeLayout)) {
      const dir = path.join(services.ctx.contentDir, 'build', 'backups', 'layout');
      const newest = fs.readdirSync(dir).filter((name) => name.endsWith('flat-layout.json')).sort().pop();
      if (newest) fs.copyFileSync(path.join(dir, newest), layoutFile);
      const newestZones = fs.readdirSync(dir).filter((name) => name.endsWith('flat-zones.json')).sort().pop();
      if (newestZones && !fs.readFileSync(zonesFile).equals(beforeZones)) fs.copyFileSync(path.join(dir, newestZones), zonesFile);
      note('stageDropRestoreFromBackup', { file: newest || null, layoutByteIdentical: fs.readFileSync(layoutFile).equals(beforeLayout) });
    }
await evaluate("document.getElementById('tab-scene').click()");
    await sleep(300);

    // ---- R2-A probes: the runtime view really moves (T1) · the draft has its own frame (T2) ----
    //
    // The run layer is driven by PUSHES (the page pulls once at boot and then only re-renders
    // what arrives on office:state), so the assertion is: with the runner playing, the page's
    // own clock advances between two reads, and the pushes are counted INSIDE the frame.
    // NOTE: an earlier probe block pauses the runner, so this block plays it first — measuring
    // a paused simulation is exactly how a first version of this assertion reported "frozen".
    const readRunFrame = (expression) => {
      const frame = boot.officeFrame();
      return frame ? frame.executeJavaScript(expression, true).catch((error) => ({ error: String((error && error.message) || error) })) : null;
    };
    const playButton = await evaluate("document.getElementById('btn-preview-play').textContent");
    if (playButton && playButton.includes('播放')) {
      await evaluate("document.getElementById('btn-preview-play').click()");
      await sleep(400);
    }
    await readRunFrame("(() => { window.__r2Pushes = 0; window.officeBridge.onState(() => { window.__r2Pushes += 1; }); return true; })()");
    const runClockA = await readRunFrame('window.__office && window.__office.ready ? { at: window.__office.api.snapshot() ? window.__office.api.snapshot().simulatedAtMs : null, packId: window.__office.api.packId(), pushes: window.__r2Pushes } : null');
    await sleep(1000);
    const runClockB = await readRunFrame('window.__office && window.__office.ready ? { at: window.__office.api.snapshot() ? window.__office.api.snapshot().simulatedAtMs : null, packId: window.__office.api.packId(), pushes: window.__r2Pushes } : null');
    note('previewPushGrowth', {
      first: runClockA,
      second: runClockB,
      grew: Boolean(runClockA && runClockB && typeof runClockA.at === 'number' && typeof runClockB.at === 'number' && runClockB.at > runClockA.at),
      deltaMs: runClockA && runClockB && typeof runClockA.at === 'number' && typeof runClockB.at === 'number' ? runClockB.at - runClockA.at : null,
      pushesReceivedInFrame: runClockB ? runClockB.pushes : null,
      mainSent: services.previewPushStats ? services.previewPushStats().sent : null,
      note: 'the page has no poll loop: a growing simulatedAtMs can only come from office:state pushes',
    });
    note('previewPushStats', services.previewPushStats ? services.previewPushStats() : null);

    // which frames exist, and does targeted delivery reach them (both frames get an
    // independent counter; the ping also proves the pair we address is the real one)
    const frameTable = mainWindow.webContents.mainFrame.framesInSubtree.map((frame) => ({
      url: frame.url.replace(/\?.*$/, ''),
      query: (frame.url.split('?')[1] || ''),
      pair: [frame.processId, frame.routingId],
      isMainFrame: frame === mainWindow.webContents.mainFrame,
    }));
    for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
      if (!frame.url.includes('/preview/office.html')) continue;
      await frame.executeJavaScript("window.__r2Ping = 0; window.officeBridge && window.officeBridge.onState(() => { window.__r2Ping += 1; }); true", true).catch(() => {});
    }
    const pingPayload = { schemaVersion: 1, simulatedAtMs: 123456, paused: false, sync: 'healthy', scene: { referenceWidth: 1280, referenceHeight: 840 }, employees: [], activityLog: [], diagnostics: [], capabilities: {} };
    for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
      try { mainWindow.webContents.sendToFrame([frame.processId, frame.routingId], 'office:state', pingPayload); } catch { /* the receive table shows the outcome */ }
    }
    await sleep(400);
    const receiveTable = [];
    for (const frame of mainWindow.webContents.mainFrame.framesInSubtree) {
      if (!frame.url.includes('/preview/office.html')) continue;
      receiveTable.push({
        query: (frame.url.split('?')[1] || ''),
        received: await frame.executeJavaScript('window.__r2Ping', true).catch(() => 'n/a'),
      });
    }
    note('previewFrameTargeting', { frameTable, receiveTable });

    // T2: playing a draft must not touch the runtime frame. The marker we plant in the run
    // frame survives only if that frame was never reloaded.
    await readRunFrame("window.__r2Mark = 'alive'; true");
    const runFrameUrl = await readRunFrame('location.href');
    await evaluate("document.getElementById('tab-actions').click()");
    await sleep(400);
    // T7: the frame cards' second timeline (#action-timeline .action-frame) is gone — the
    // 动作 page has ONE timeline now, and its segments ARE the frames (one per frame, in
    // array order). The probe still proves the same thing: an action's frames are listed
    // and playable, through the single timeline's own elements.
    await waitUntil(() => evaluate("document.querySelectorAll('#timeline-track .timeline-segment').length > 0"), 20000, 'action timeline rendered');
    note('actionTimelineSegments', await evaluate("document.querySelectorAll('#timeline-track .timeline-segment').length"));
    note('actionTimelineIsTheOnlyOne', await evaluate("document.querySelectorAll('#action-timeline').length === 0 && document.querySelectorAll('#bench-timeline').length === 1"));
    await evaluate("document.getElementById('btn-action-play').click()");
    // the first draft play STAGES the pack and reloads the draft frame, so the puppet only
    // appears once that frame is back: poll for it instead of guessing a delay
    const readBench = (expression) => {
      const frame = boot.benchFrame ? boot.benchFrame() : null;
      return frame ? frame.executeJavaScript(expression, true).catch((error) => ({ error: String((error && error.message) || error) })) : null;
    };
    // NOTE: the action preview writes into the draft frame with applySnapshotManually —
    // a RENDERER-level call, so the page's own api.snapshot() (fed by pulls/pushes) keeps
    // reporting the pulled snapshot. The honest signal that the write landed is the shell's
    // playback readout, which only advances when pushPuppet() returned true.
    let playbackReadout = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      playbackReadout = await evaluate("document.getElementById('action-playback').textContent");
      if (playbackReadout && /播放中/.test(playbackReadout)) break;
      await sleep(250);
    }
    const benchProbe = await readBench(`(() => ({
      url: location.href,
      ready: Boolean(window.__office && window.__office.ready),
      packId: window.__office && window.__office.ready ? window.__office.api.packId() : null,
      pulledEmployees: window.__office && window.__office.ready && window.__office.api.snapshot() ? (window.__office.api.snapshot().employees || []).map((e) => e.employeeId) : null,
    }))()`);
    // the stage mode lives in the SHELL frame (the iframes have no #stage element)
    const shellStageMode = await evaluate("document.getElementById('stage').dataset.mode");
    const runMarker = await readRunFrame("window.__r2Mark || null");
    note('previewFrameDecoupling', {
      runFrameUrl,
      markerSurvivedDraftPlayback: runMarker === 'alive',
      bench: benchProbe,
      benchPackIsStaged: Boolean(benchProbe && benchProbe.packId === 'wb-staged'),
      runFrameIsProduction: Boolean(runClockB && runClockB.packId === 'deepseek-default'),
      stageShowedDraft: shellStageMode,
      playbackReadout: (playbackReadout || '').trim(),
      draftWriteLanded: Boolean(playbackReadout && /播放中/.test(playbackReadout)),
      note: 'the draft frame renders its own manual snapshots; the pulled list stays the simulation\'s, which is correct — two frames, two sources',
    });
    // staging stays preview-only: the production pack bytes must be untouched
    const productionPack = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'animation', 'animations.json');
    const stagedPack = path.join(services.ctx.contentDir, 'build', 'preview-pack', 'animations.json');
    note('stagedPackIsolation', {
      stagedExists: fs.existsSync(stagedPack),
      stagedBytes: fs.existsSync(stagedPack) ? fs.statSync(stagedPack).size : null,
      productionBytes: fs.existsSync(productionPack) ? fs.statSync(productionPack).size : null,
      productionDigest: fs.existsSync(productionPack) ? require('node:crypto').createHash('sha256').update(fs.readFileSync(productionPack)).digest('hex').slice(0, 16) : null,
    });
    await evaluate("document.getElementById('btn-action-stop').click()");
    await sleep(300);
    await evaluate("document.getElementById('btn-stage-mode-run').click()");
    await sleep(500);
    const afterDraft = await readRunFrame('window.__office && window.__office.ready ? { at: window.__office.api.snapshot() ? window.__office.api.snapshot().simulatedAtMs : null, marker: window.__r2Mark || null, pushes: window.__r2Pushes } : null');
    note('previewPushStillLiveAfterDraft', afterDraft);
    await evaluate("document.getElementById('tab-scene').click()");
    await sleep(250);

    // ---- R2-C probes: undo/redo (T3) and unsaved drafts surviving a reload (T5) ----
    //
    // Both are claims about SAFETY, so both are measured by what ends up on disk and in the
    // page state — not by whether a button looked enabled.
    const r2cLayoutFile = path.join(services.ctx.contentDir, 'scenes', 'flat', 'layout.json');
    const r2cZonesFile = path.join(services.ctx.contentDir, 'scenes', 'flat', 'zones.json');
    const r2cBaseline = fs.readFileSync(r2cLayoutFile);
    const r2cBaselineZones = fs.readFileSync(r2cZonesFile);
    contentBaseline[r2cLayoutFile] = { bytes: r2cBaseline };
    contentBaseline[r2cZonesFile] = { bytes: r2cBaselineZones };
    const baselineItems = JSON.parse(r2cBaseline.toString('utf8')).items.length;
    await evaluate("document.getElementById('tab-scene').click()");
    await sleep(400);
    // place a sofa by hand (same path the drop uses), then undo it
    await evaluate(`(async () => {
      const vp = document.getElementById('stage-viewport');
      const box = vp.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('application/x-wb-furniture', 'flat-sofa');
      vp.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: box.left + 220, clientY: box.top + 180, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(2000);
    const afterPlace = JSON.parse(fs.readFileSync(r2cLayoutFile, 'utf8')).items.length;
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }))");
    await sleep(2000);
    const afterUndo = fs.readFileSync(layoutFile);
    const undoState = { items: JSON.parse(afterUndo.toString('utf8')).items.length, byteIdenticalToBaseline: afterUndo.equals(r2cBaseline) };
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))");
    await sleep(2000);
    const afterRedo = JSON.parse(fs.readFileSync(r2cLayoutFile, 'utf8')).items.length;
    note('undoRedo', {
      baselineItems,
      afterPlace,
      afterUndo: undoState.items,
      undoRestoredBytes: undoState.byteIdenticalToBaseline,
      afterRedo,
      historySize: await evaluate("window.__wbHistory && window.__wbHistory.history ? JSON.stringify(window.__wbHistory.history.size()) : null"),
      note: 'undo replays through the same validated transaction (dry run -> validator -> backup -> write)',
    });
    // leave the layout exactly as we found it — UNCONDITIONALLY: undoing through the UI is
    // what the assertion above measures, and the cleanup must not depend on it having worked
    const r2cBaseIds = new Set(JSON.parse(r2cBaseline.toString('utf8')).items.map((item) => item.id));
    for (const extraId of JSON.parse(fs.readFileSync(r2cLayoutFile, 'utf8')).items.filter((item) => !r2cBaseIds.has(item.id)).map((item) => item.id)) {
      boot.extension.studio.sceneEdit({ sceneId: 'flat', edits: [{ itemId: extraId, remove: true }], save: true });
    }
    // both files, from the transaction's own byte backups: a removal that the validator
    // refuses leaves BOTH the layout and the derived zones as they were, so the last resort
    // has to cover both (this is how the zones.json leftover was found)
    // last resort = the bytes this probe recorded BEFORE it touched anything. ("The newest
    // backup" is not good enough: a previous probe's write can be newer than the baseline and
    // restoring it leaves the file just as dirty — that is how a leftover survived one run.)
    if (!fs.readFileSync(r2cLayoutFile).equals(r2cBaseline)) fs.writeFileSync(r2cLayoutFile, r2cBaseline);
    if (!fs.readFileSync(r2cZonesFile).equals(r2cBaselineZones)) fs.writeFileSync(r2cZonesFile, r2cBaselineZones);
    note('undoRedoRestored', {
      layoutByteIdentical: fs.readFileSync(r2cLayoutFile).equals(r2cBaseline),
      zonesByteIdentical: fs.readFileSync(r2cZonesFile).equals(r2cBaselineZones),
      items: JSON.parse(fs.readFileSync(r2cLayoutFile, 'utf8')).items.length,
    });

    // T5: an UNSAVED move must survive a full shell reload
    // select a REAL item, then drag it: a drag that hits nothing produces no pending edit and
    // the "draft survived" claim would be about nothing (the first version of this probe did
    // exactly that and reported a false negative)
    const moveOutcome = await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      canvas.focus();
      const box = canvas.getBoundingClientRect();
      const at = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 11, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      at('pointerdown', box.left + box.width * 0.35, box.top + box.height * 0.5);
      at('pointermove', box.left + box.width * 0.42, box.top + box.height * 0.5);
      at('pointerup', box.left + box.width * 0.42, box.top + box.height * 0.5);
      return document.getElementById('canvas-status').textContent;
    })()`);
    // the panel writes "待保存改动 N" through stageEdit, which also persists the draft
    let dirtyBeforeReload = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(250);
      dirtyBeforeReload = await evaluate("document.getElementById('canvas-status').textContent");
      if (dirtyBeforeReload.includes('待保存改动')) break;
    }
    note('unsavedMoveSetup', { afterDrag: moveOutcome, settled: dirtyBeforeReload, storeHasData: await evaluate("(() => { try { return Boolean(sessionStorage.getItem('wb-session-v1')); } catch { return null; } })()") });
    mainWindow.webContents.reload();
    await waitUntil(() => evaluate("document.getElementById('canvas-status') && document.getElementById('canvas-status').textContent.length > 0"), 30000, 'shell reloaded');
    await evaluate("document.getElementById('tab-scene').click()");
    await sleep(1500);
    note('draftSurvivesReload', {
      beforeReload: dirtyBeforeReload,
      afterReload: await evaluate("document.getElementById('canvas-status').textContent"),
      pendingRestored: await evaluate("document.getElementById('canvas-status').textContent.includes('已恢复未保存改动')"),
    });
    // and the layout on disk was never touched by the unsaved move
    note('draftNeverWroteDisk', { byteIdentical: fs.readFileSync(r2cLayoutFile).equals(r2cBaseline), items: JSON.parse(fs.readFileSync(r2cLayoutFile, 'utf8')).items.length });
    await evaluate("document.getElementById('btn-canvas-reload').click()");
    await sleep(600);

    // ---- R2-D1 probe: the selected item's property panel (T6) ------------------------
    //
    // Driven through the real form: select on the canvas -> the fields fill -> type a new x
    // -> press 应用 -> the edit is STAGED (not written): the canvas says 待保存改动 and the
    // file on disk is untouched until 保存布局.
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(500);
    const itemPanelState = () => evaluate(`JSON.stringify({
      panelVisible: !document.getElementById('panel-item').hidden,
      formVisible: !document.getElementById('item-body').hidden,
      noneVisible: !document.getElementById('item-none').hidden,
      meta: document.getElementById('item-prop-meta').textContent,
      x: document.getElementById('item-prop-x').value,
      y: document.getElementById('item-prop-y').value,
      scale: document.getElementById('item-prop-scale').value,
      layer: document.getElementById('item-prop-layer').value,
      hidden: document.getElementById('item-prop-hidden').checked,
      status: document.getElementById('item-prop-status').textContent,
      canvasStatus: document.getElementById('canvas-status').textContent,
    })`).then(JSON.parse);
    const beforeProps = await itemPanelState();
    // Select DETERMINISTICALLY: ask the service where the items are and click the first one's
    // centre. Fixed screen fractions broke as soon as an earlier probe panned the canvas —
    // the click landed on empty space, deselected, and the panel (correctly) said 未选中.
    const draftNow = boot.extension.studio.sceneDraft({});
    const pickMe = (draftNow.items || []).find((item) => item.box && item.box.width > 20 && !item.hidden) || (draftNow.items || [])[0];
    await evaluate(`(() => {
      const canvas = document.getElementById('scene-canvas');
      const box = canvas.getBoundingClientRect();
      const at = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: 21, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      at('pointerdown', box.left + box.width * ${pickMe ? pickMe.position.x.toFixed(4) : '0.5'}, box.top + box.height * ${pickMe ? pickMe.position.y.toFixed(4) : '0.5'});
      at('pointerup', box.left + box.width * ${pickMe ? pickMe.position.x.toFixed(4) : '0.5'}, box.top + box.height * ${pickMe ? pickMe.position.y.toFixed(4) : '0.5'});
      return true;
    })()`);
    await sleep(600);
    const selectedProps = await itemPanelState();
    // change x by a visible amount and apply
    await evaluate(`(() => {
      const input = document.getElementById('item-prop-x');
      const next = (Number(input.value) + 0.05).toFixed(4);
      input.value = next;
      document.getElementById('item-prop-apply').click();
      return next;
    })()`);
    await sleep(900);
    const appliedProps = await itemPanelState();
    note('itemPropertyPanel', {
      picked: pickMe ? { id: pickMe.id, kind: pickMe.kind, position: pickMe.position } : null,
      beforeSelection: { panelVisible: beforeProps.panelVisible, noneVisible: beforeProps.noneVisible },
      afterSelection: { formVisible: selectedProps.formVisible, meta: selectedProps.meta, x: selectedProps.x, y: selectedProps.y, scale: selectedProps.scale, layer: selectedProps.layer },
      afterApply: { x: appliedProps.x, status: appliedProps.status, canvasStatus: appliedProps.canvasStatus },
      stagedNotWritten: appliedProps.canvasStatus.includes('待保存'),
      diskUntouched: fs.readFileSync(path.join(services.ctx.contentDir, 'scenes', 'flat', 'layout.json')).equals(contentBaseline[path.join(services.ctx.contentDir, 'scenes', 'flat', 'layout.json')].bytes),
    });
    await evaluate("document.getElementById('btn-canvas-reload').click()");
    await sleep(600);
    note('itemPropertyPanelCleanup', { canvasStatus: await evaluate("document.getElementById('canvas-status').textContent") });

    // ---- R2-D2 probe: the problems strip aggregates and jumps (T12) ------------------
    //
    // The claim under test is the report's own example: the scene validator's wall of
    // repeated SCENE_FURNITURE_OVERLAP rows must render as ONE group that can be expanded,
    // and its findings must carry a target the strip can jump to.
    await evaluate("document.getElementById('tab-scene').click()");
    await sleep(600);
    const problemsState = () => evaluate(`JSON.stringify({
      summary: document.getElementById('problems-summary').textContent,
      sources: document.getElementById('problems-sources').textContent,
      groups: [...document.querySelectorAll('#wb-problems-body .wb-problem-group')].map((el) => ({
        code: el.querySelector('.wb-problem-code').textContent,
        severity: el.querySelector('.wb-problem-sev').textContent,
        count: el.querySelector('.wb-problem-count').textContent,
        source: el.querySelector('.wb-problem-source').textContent,
      })),
      detailsShown: document.querySelectorAll('#wb-problems-body .wb-problem-details').length,
      collapsed: document.body.classList.contains('wb-problems-collapsed'),
    })`).then(JSON.parse);
    const collapsedView = await problemsState();
    // expand the first group: the twelve rows appear as details, the group stays one line
    await evaluate("document.querySelector('#wb-problems-body .wb-problem-group').click()");
    await sleep(300);
    const expandedView = await problemsState();
    const detailCounts = await evaluate("document.querySelectorAll('#wb-problems-body .wb-problem-details .wb-problem-finding').length");
    note('problemsStrip', {
      collapsed: collapsedView,
      firstGroupExpandedDetails: detailCounts,
      detailsShownAfterExpand: expandedView.detailsShown,
      repeatedCodeCollapsedIntoOneGroup: collapsedView.groups.filter((group) => group.count.startsWith('×')).length >= 1
        && collapsedView.groups.length < (collapsedView.sources.includes('scene') ? 99 : 0),
      note: 'the report\'s example: 12 identical SCENE_FURNITURE_OVERLAP rows used to bury the summary',
    });
    // the toggle collapses the body (one click, and the strip keeps the summary line)
    await evaluate("document.getElementById('btn-problems-toggle').click()");
    await sleep(250);
    note('problemsCollapsed', { collapsed: (await problemsState()).collapsed, bodyDisplay: await evaluate("getComputedStyle(document.getElementById('wb-problems-body')).display") });
    await evaluate("document.getElementById('btn-problems-toggle').click()");
    await sleep(250);
    // a finding with a target jumps: use the graph page's validator, then jump back
    await evaluate("document.getElementById('page-behaviour').click()");
    await sleep(300);
    await evaluate("document.getElementById('btn-graph-validate').click()");
    await sleep(800);
    note('problemsJump', {
      graphFindings: await evaluate("(() => { const g = (window.__wbProblems.problems.get().sources || {}).graph; return g ? g.count : null; })()"),
      jumpWorks: await evaluate("(() => { try { return window.__wbProblems.jumpTo({ page: 'quality', tab: 'tab-geometry' }); } catch { return false; } })()"),
      pageAfterJump: await evaluate("document.body.dataset.page"),
      tabAfterJump: await evaluate("(document.querySelector('#wb-tabs .wb-tab[aria-pressed=\"true\"]') || {}).id || null"),
    });
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(300);

    // ---- R2-D5 probe: the quality page's run-all feeds the problems strip (T10) ------
    await evaluate("document.getElementById('page-quality').click()");
    await sleep(500);
    const qaBefore = await evaluate("JSON.stringify({ bar: Boolean(document.getElementById('qa-page-bar')), status: (document.getElementById('qa-run-status') || {}).textContent || null, packHidden: document.getElementById('pack-more-box') ? document.getElementById('pack-more-box').hidden : null, chips: [...document.querySelectorAll('#wb-tabs .wb-tab')].filter((c) => c.offsetParent !== null).map((c) => c.id) })");
    await evaluate("document.getElementById('btn-qa-run-all').click()");
    await waitUntil(() => evaluate("/完成|done|没跑起来/.test((document.getElementById('qa-run-status') || {}).textContent || '')"), 30000, 'run-all finished');
    const qaAfter = await evaluate(`JSON.stringify({
      status: document.getElementById('qa-run-status').textContent,
      sources: (window.__wbProblems && window.__wbProblems.problems) ? window.__wbProblems.problems.get().sources : null,
      summary: document.getElementById('problems-summary').textContent,
    })`);
    await evaluate("document.getElementById('btn-pack-more').click()");
    await sleep(250);
    const packHiddenAfter = await evaluate("document.getElementById('pack-more-box').hidden");
    note('qualityRunAll', {
      before: JSON.parse(qaBefore),
      after: JSON.parse(qaAfter),
      packDisclosureOpens: packHiddenAfter === false,
      note: 'one click runs the three local validators and every finding lands in the strip',
    });
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(300);

    // ---- R2-D7 probe: following an employee on the observe page (T11) ----------------
    //
    // The dock/table arrangement and the follow click are user-visible behaviour, so they get
    // measured rather than asserted in prose: click a row, the view must lock onto that
    // employee (the stage transform changes and the row is marked), then release it.
    await evaluate("document.getElementById('page-observe').click()");
    await sleep(600);
    const observeState = () => evaluate(`JSON.stringify({
      page: document.body.dataset.page,
      tableWide: (() => { const el = document.getElementById('preview-table'); const box = el.getBoundingClientRect(); return Math.round(box.width); })(),
      rows: document.querySelectorAll('#preview-table tbody tr').length,
      followed: [...document.querySelectorAll('#preview-table tbody tr.preview-row-followed')].map((tr) => tr.children[0].textContent),
      followStatus: (document.getElementById('preview-follow-status') || {}).textContent || null,
      transform: document.getElementById('stage-world').style.transform,
      dockH: Math.round(document.getElementById('wb-dock').getBoundingClientRect().height),
      controls: ['btn-preview-play', 'btn-preview-step', 'btn-preview-restart', 'preview-speed'].map((id) => document.querySelectorAll('#' + id).length),
    })`).then(JSON.parse);
    const observeBefore = await observeState();
    await evaluate("(() => { const row = document.querySelector('#preview-table tbody tr'); if (row) row.click(); return true; })()");
    await sleep(900);
    const observeFollowed = await observeState();
    await evaluate("(() => { const btn = document.getElementById('btn-preview-unfollow'); if (btn) btn.click(); return true; })()");
    await sleep(700);
    const observeReleased = await observeState();
    await sleep(1200);
    const observeSettled = await observeState();
    note('observePageLayout', {
      before: observeBefore,
      afterFollow: observeFollowed,
      afterRelease: observeReleased,
      settledTransform: observeSettled.transform,
      tableIsWide: observeBefore.tableWide > 420,
      controlsExistExactlyOnce: observeBefore.controls.every((count) => count === 1),
      followMovedTheView: observeFollowed.transform !== observeBefore.transform,
      followZoomedIn: (() => { const m = /scale\(([0-9.]+)\)/.exec(observeFollowed.transform); return m ? Number(m[1]) > 1 : false; })(),
      followMarkedTheRow: observeFollowed.followed.length > 0,
      followClearedTheRowMark: observeReleased.followed.length === 0,
      // the release must go back to a PANORAMA (zoom < 1), not merely move a little: the weak
      // version of this check passed on a 0.001 drift while the view stayed locked
      releaseReturnedToPanorama: (() => { const m = /scale\(([0-9.]+)\)/.exec(observeReleased.transform); return m ? Number(m[1]) < 1 : false; })(),
      releaseZoom: (() => { const m = /scale\(([0-9.]+)\)/.exec(observeReleased.transform); return m ? Number(m[1]) : null; })(),
    });
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(300);

    // ---- R5 probe: the pipeline panel (plan → run → cache → param → triage → passport) ----
    //
    // The panel's claim is that it is a window onto the ENGINE, so the probe drives it
    // the way a person does (page → plan → run → edit the form → resolve) and cross-checks
    // the rendered rows against the engine's own answer through the same bridge. Two
    // scenarios are measured, not asserted in prose:
    //   1. 命中缓存: run the real walk-left chain, run it again — the engine says zero
    //      execution the second time and the panel must show it;
    //   2. 改参数只重跑受影响段: packCanvas is an S6-only key parameter, so the re-walk
    //      must show S6 将执行 while the matting and the QC gate stay 命中缓存.
    // A QC-must-fail delivery (one fully opaque frame — matting cannot invent alpha)
    // then lands in the triage queue and is resolved through the panel's own button.
    step('pipeline-panel');
    // the QC report is a GATE input (a red report blocks the publish) and the triage
    // queue is the human's list: both are restored to their pre-probe bytes afterwards
    contentBaseline[qcReportFile] = { bytes: fs.existsSync(qcReportFile) ? fs.readFileSync(qcReportFile) : null };
    contentBaseline[triageFile] = { bytes: fs.existsSync(triageFile) ? fs.readFileSync(triageFile) : null };

    await evaluate("document.getElementById('page-generation').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-pipeline').hidden === false"), 15000, 'pipeline panel shown');
    // the nine stages come from the engine's own registry (S0–S8), and the action list
    // from the action services — a panel that invented its own stage table would fail here
    await waitUntil(() => evaluate("document.querySelectorAll('#pipeline-stages-table tbody tr').length === 9"), 20000, 'the nine stages rendered');
    await waitUntil(() => evaluate("document.getElementById('pipeline-action').options.length > 5"), 20000, 'the action list rendered');
    const pipelineStageRows = () => evaluate("Array.from(document.querySelectorAll('#pipeline-stages-table tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent))");
    const pipelineCacheRows = () => evaluate("Array.from(document.querySelectorAll('#pipeline-cache-rows .pipeline-cache-row')).map((el) => el.textContent)");
    const pipelineStatus = () => evaluate("document.getElementById('pipeline-status').textContent");
    const pipelineForm = () => evaluate(`JSON.stringify({
      action: document.getElementById('pipeline-action').value,
      only: document.getElementById('pipeline-only').value,
      params: document.getElementById('pipeline-params').value,
      reference: document.getElementById('pipeline-reference').value,
      delivery: document.getElementById('pipeline-delivery').value,
      force: document.getElementById('pipeline-force').checked,
      publish: document.getElementById('pipeline-publish').checked,
      record: document.getElementById('pipeline-record').checked,
    })`).then(JSON.parse);
    note('pipelineStagesOnBoot', {
      rows: await pipelineStageRows(),
      actions: await evaluate("document.getElementById('pipeline-action').options.length"),
      action: await evaluate("document.getElementById('pipeline-action').value"),
      planSummary: await evaluate("document.getElementById('pipeline-plan-summary').textContent"),
      cacheStats: await evaluate("document.getElementById('pipeline-cache-stats').textContent"),
    });

    // 1) PLAN: the dry walk. The rendered statuses must equal the engine's own answer
    //    for the same request (read back through the same bridge the panel uses).
    await evaluate("document.getElementById('btn-pipeline-plan').click()");
    await waitUntil(() => evaluate("/将跑 [0-9]+ 段|will run [0-9]+/.test(document.getElementById('pipeline-plan-summary').textContent || '')"), 30000, 'plan rendered');
    const planRows = await pipelineStageRows();
    const enginePlan = await evaluate(`(async () => {
      const answer = await window.studioBridge.pipelinePlan({ actionId: 'walk-left', stages: ['S4', 'S5', 'S6'] });
      return { ok: answer.ok, wouldRun: answer.plan.wouldRun, wouldReuse: answer.plan.wouldReuse, stages: answer.plan.stages.map((s) => ({ id: s.id, status: s.status, key: s.key })) };
    })()`);
    const statusOf = (id) => { const row = planRows.find((cells) => cells[0] === id); return row ? row[2] : null; };
    note('pipelinePlan', {
      summary: await evaluate("document.getElementById('pipeline-plan-summary').textContent"),
      status: await pipelineStatus(),
      rows: planRows,
      cacheRows: await pipelineCacheRows(),
      enginePlan,
      // the panel renders the engine's statuses verbatim (命中缓存 = hit, 将执行 = miss)
      panelMatchesEngine: enginePlan.stages.every((entry) => statusOf(entry.id) === ({ hit: '命中缓存', miss: '将执行', 'stale-upstream': '将执行（上游变更）' })[entry.status]),
      wouldRun: enginePlan.wouldRun,
      wouldReuse: enginePlan.wouldReuse,
    });
    const planShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline plan');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-plan.png'), planShot.toPNG());

    // 2) RUN: execute the real chain. The log grows per stage record as it happens.
    //    The force switch makes the execution deterministic on a warm cache (a repeated
    //    sweep would otherwise find every stage cached and prove nothing about running),
    //    and it exercises that form control at the same time.
    await evaluate(`(() => { const el = document.getElementById('pipeline-force'); el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(500);
    await evaluate("document.getElementById('btn-pipeline-run').click()");
    await waitUntil(() => evaluate("/PASS|BLOCKED/.test(document.getElementById('pipeline-status').textContent || '')"), 120000, 'pipeline run finished');
    const runLog = await evaluate("document.getElementById('pipeline-log').textContent");
    note('pipelineRun', {
      forced: true,
      form: await pipelineForm(),
      status: await pipelineStatus(),
      log: runLog,
      // the panel's run must not grow the real tree's ledger (the CLI policy, enforced)
      ledgerUntouched: !fs.existsSync(path.join(services.ctx.contentDir, 'characters', 'whale-girl', 'provenance', 'generation')),
      rows: await pipelineStageRows(),
      qcVerdict: await evaluate("document.getElementById('pipeline-qc-verdict').textContent"),
      problemsSource: await evaluate("(() => { const s = (window.__wbProblems.problems.get().sources || {}).pipeline; return s ? { count: s.count, bySeverity: s.bySeverity } : null; })()"),
    });
    const pipelineRunShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline run');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-run.png'), pipelineRunShot.toPNG());

    // 3) CACHE: back to the cache-aware mode — the very next run must execute nothing,
    //    because the forced run re-stored every entry. The engine's resolver says so and
    //    the panel's log must say the same thing (cached everywhere).
    await evaluate(`(() => { const el = document.getElementById('pipeline-force'); el.checked = false; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(700);
    await evaluate("document.getElementById('btn-pipeline-run').click()");
    await waitUntil(() => evaluate("/PASS|BLOCKED/.test(document.getElementById('pipeline-status').textContent || '')"), 120000, 'second pipeline run finished');
    const secondLog = await evaluate("document.getElementById('pipeline-log').textContent");
    note('pipelineCacheHit', {
      status: await pipelineStatus(),
      log: secondLog,
      rows: await pipelineStageRows(),
      cacheRows: await pipelineCacheRows(),
      everythingCached: /命中 3|cached 3/.test(await pipelineStatus()),
      ranNothing: !/S4 ran/.test(secondLog),
    });
    const cacheShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline cache hits');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-cache.png'), cacheShot.toPNG());

    // 4) PARAM: packCanvas is an S6-only key parameter — the re-walk (which the panel
    //    runs by itself, debounced) must re-run ONLY that segment.
    await evaluate(`(() => { const el = document.getElementById('pipeline-params'); el.value = '{"packCanvas":384}'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitUntil(() => evaluate("(() => { const rows = Array.from(document.querySelectorAll('#pipeline-cache-rows .pipeline-cache-row')); const s6 = rows.find((el) => el.dataset.stageId === 'S6'); const s4 = rows.find((el) => el.dataset.stageId === 'S4'); return s6 && s4 && /将执行|will run/.test(s6.textContent) && /命中缓存|cache hit/.test(s4.textContent); })()"), 30000, 'the re-walk re-runs only S6');
    note('pipelineParamRerun', {
      form: await pipelineForm(),
      cacheRows: await pipelineCacheRows(),
      summary: await evaluate("document.getElementById('pipeline-plan-summary').textContent"),
      onlyS6Reruns: await evaluate("(() => { const rows = Array.from(document.querySelectorAll('#pipeline-cache-rows .pipeline-cache-row')); return rows.filter((el) => /将执行|will run/.test(el.textContent)).map((el) => el.dataset.stageId); })()"),
    });
    const paramShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline parameter re-walk');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-param.png'), paramShot.toPNG());
    // back to the default parameters (the engine seeds packCanvas from the action)
    await evaluate(`(() => { const el = document.getElementById('pipeline-params'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(1200);

    // 5) TRIAGE: a QC-must-fail delivery (one fully opaque frame — no parameter in the
    //    fix table can repair "no alpha") goes to the queue, and the panel resolves it
    //    with the mandatory note. The delivery lives in a tmp dir; nothing in content/**
    //    is written by the probe itself (the queue and the QC report are tool output,
    //    restored below).
    const mustFailDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'r5-mustfail-'));
    const pngLib = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
    fs.writeFileSync(path.join(mustFailDir, 'must-fail-01.png'), pngLib.encodePng(Buffer.alloc(256 * 256 * 4, 255), 256, 256));
    await evaluate(`(() => {
      document.getElementById('pipeline-only').value = 'S4,S5';
      document.getElementById('pipeline-delivery').value = ${JSON.stringify(mustFailDir)};
      document.getElementById('pipeline-only').dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    await evaluate("document.getElementById('btn-pipeline-run').click()");
    await waitUntil(() => evaluate("/BLOCKED/.test(document.getElementById('pipeline-status').textContent || '')"), 120000, 'the must-fail delivery is blocked');
    const triageRowsBefore = await evaluate("Array.from(document.querySelectorAll('#pipeline-triage-list .pipeline-triage-row')).map((el) => el.textContent)");
    note('pipelineTriageQueued', {
      form: await pipelineForm(),
      status: await pipelineStatus(),
      log: await evaluate("document.getElementById('pipeline-log').textContent"),
      triageRows: triageRowsBefore,
      queueFile: await evaluate("document.getElementById('pipeline-triage-file').textContent"),
      qcVerdict: await evaluate("document.getElementById('pipeline-qc-verdict').textContent"),
      problemsSource: await evaluate("(() => { const s = (window.__wbProblems.problems.get().sources || {}).pipeline; return s ? { count: s.count, bySeverity: s.bySeverity } : null; })()"),
    });
    const triageShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline triage queue');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-triage.png'), triageShot.toPNG());

    // resolve it through the panel: select the entry, write the note, press the button
    await evaluate("(() => { const row = document.querySelector('#pipeline-triage-list .pipeline-triage-row'); if (row) row.click(); return Boolean(row); })()");
    await waitUntil(() => evaluate("/原因：|Why:/.test(document.getElementById('pipeline-triage-detail-text').textContent)"), 15000, 'the triage detail rendered');
    const detailBefore = await evaluate("document.getElementById('pipeline-triage-detail-text').textContent");
    // an empty note is refused (the engine fails closed, and so does the button)
    const emptyNoteRefused = await evaluate(`(async () => {
      document.getElementById('pipeline-triage-note').value = '   ';
      document.getElementById('btn-pipeline-triage-resolve').click();
      await new Promise((r) => setTimeout(r, 400));
      return document.getElementById('pipeline-triage-resolve-status').textContent;
    })()`);
    // click + read in ONE in-page step: the panel clears its own status line when it
    // re-renders the queue after the resolve, so a separate read would race it
    const resolveStatus = await evaluate(`(async () => {
      document.getElementById('pipeline-triage-note').value = 're-issued the frame with a real matte (probe)';
      document.getElementById('btn-pipeline-triage-resolve').click();
      // 8s, not 20: the evaluate wrapper itself races at 20s, and a loop that long
      // could never finish inside it
      const started = Date.now();
      while (Date.now() - started < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        const text = document.getElementById('pipeline-triage-resolve-status').textContent;
        if (/已解决|Resolved/.test(text)) return text;
      }
      return document.getElementById('pipeline-triage-resolve-status').textContent;
    })()`);
    note('pipelineTriageResolved', {
      detailBefore,
      emptyNoteRefused,
      emptyNoteRefusedIsTheGuard: /不能为空|cannot be empty/.test(emptyNoteRefused),
      resolveStatus,
      triageRows: await evaluate("Array.from(document.querySelectorAll('#pipeline-triage-list .pipeline-triage-row')).map((el) => el.textContent)"),
      status: await pipelineStatus(),
    });
    const resolveShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline triage resolved');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-resolve.png'), resolveShot.toPNG());
    await evaluate(`(() => {
      document.getElementById('pipeline-only').value = '';
      document.getElementById('pipeline-delivery').value = '';
      document.getElementById('pipeline-only').dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    fs.rmSync(mustFailDir, { recursive: true, force: true });

    // 6) PASSPORT: one button jumps to the passport panel with THIS asset, and the
    //    passport answers from the real trees (generation segment + the ledger line).
    await evaluate("document.getElementById('btn-pipeline-passport').click()");
    await waitUntil(() => evaluate("document.getElementById('panel-passport').hidden === false && document.getElementById('passport-summary').textContent.length > 10"), 30000, 'the passport answered for the pipeline asset');
    note('pipelinePassportJump', {
      status: await pipelineStatus(),
      passportAsset: await evaluate("document.getElementById('passport-asset').value"),
      passportSummary: await evaluate("document.getElementById('passport-summary').textContent"),
      passportRows: await evaluate("Array.from(document.querySelectorAll('#passport-table tbody tr')).map((tr) => Array.from(tr.children).map((td) => td.textContent))"),
      ledgerLine: await evaluate("document.querySelector('#passport-ledger .wb-hint') ? document.querySelector('#passport-ledger .wb-hint').textContent : null"),
    });
    const passportShot = await capturePageWithRetry(mainWindow.webContents, 'pipeline passport jump');
    fs.writeFileSync(path.join(STUDIO_EVIDENCE_DIR, 'studio-pipeline-passport.png'), passportShot.toPNG());

    // 7) KEYBOARD: the two front doors are palette commands, so the whole flow is
    //    reachable without a mouse (⌘K → 流水线：计划 → Enter re-plans the panel).
    await evaluate("document.getElementById('page-generation').click()");
    await sleep(400);
    await pressGlobal({ key: 'k', metaKey: true, bubbles: true, cancelable: true });
    await sleep(250);
    await evaluate(`(() => { const input = document.getElementById('wb-palette-input'); input.value = '流水线'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(250);
    const pipelinePalette = await paletteState();
    note('pipelineKeyboardPalette', {
      items: pipelinePalette.items,
      hasPlanCommand: pipelinePalette.items.includes('pipeline:plan'),
      hasRunCommand: pipelinePalette.items.includes('pipeline:run'),
    });
    await pressKey(`document.getElementById('wb-palette-input')`, { key: 'Enter', bubbles: true, cancelable: true });
    await waitUntil(() => evaluate("/将跑 [0-9]+ 段|will run [0-9]+/.test(document.getElementById('pipeline-plan-summary').textContent || '')"), 30000, 'the palette command re-planned');
    note('pipelineKeyboardPlanRan', { activeTab: await evaluate("(() => { const el = document.querySelector('#wb-tabs .wb-tab[aria-pressed=\"true\"]'); return el ? el.id : null; })()") });

    // restore the two tool-output files this probe's runs touched (the QC report is a
    // gate input, the triage queue is the human's list — neither keeps probe state)
    restorePipelineFiles();
    note('pipelineFilesRestored', {
      qcReport: fs.existsSync(qcReportFile) ? { bytes: fs.readFileSync(qcReportFile).length, byteIdentical: fs.readFileSync(qcReportFile).equals(contentBaseline[qcReportFile].bytes || Buffer.alloc(0)) } : null,
      triage: fs.existsSync(triageFile) ? { bytes: fs.readFileSync(triageFile).length } : null,
    });
    await evaluate("document.getElementById('page-scene').click()");
    await sleep(300);

    note('rendererConsoleErrors', studioConsoleErrors.slice(0, 8));
    note('finishedAt', new Date().toISOString());
    console.log('STUDIO_EVIDENCE_OK');
    app.exit(0);
  } catch (error) {
    results.error = String((error && error.stack) || error);
    results.failedStep = results.lastStep || null;
    // a failed sweep must still say WHY the renderer went quiet: a swallowed exception in
    // the shell is the usual cause of a timeout here, and the console has it
    results.rendererConsoleErrors = studioConsoleErrors.slice(0, 8);
    // A FAILING probe must not leave content dirty either: if anything the probe writes is
    // still different from the baseline it recorded, put the baseline's bytes back.
    try {
      for (const [file, baseline] of Object.entries(contentBaseline)) {
        // a null baseline means the probe CREATED the file: that case belongs to
        // restorePipelineFiles() below (Buffer.equals(null) would throw and abort
        // the whole restore — which is how a probe-leftover survived one run)
        if (!baseline || baseline.bytes === null || !fs.existsSync(file)) continue;
        if (!fs.readFileSync(file).equals(baseline.bytes)) {
          fs.writeFileSync(file, baseline.bytes);
          results.contentRestoredOnFailure = [...(results.contentRestoredOnFailure || []), path.basename(file)];
        }
      }
      // the pipeline panel's two tool-output files: a null baseline means the probe
      // CREATED them (a QC report it ran / a triage entry it queued) — those go away
      restorePipelineFiles();
    } catch { /* best effort before reporting */ }
    results.statusAtFailure = await evaluate("(() => { const el = document.getElementById('preview-status'); return el ? el.textContent : null; })()").catch(() => null);
    note('finishedAt', new Date().toISOString());
    console.error('STUDIO_EVIDENCE_FAILED', results.error);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  const boot = await startToolApp({
    app,
    protocol,
    ipcMain,
    BrowserWindow,
    config: {
      repoRoot: REPO_ROOT,
      dataDir: DATA_DIR,
      scheme: 'workbench',
      windowTitle: STUDIO_EVIDENCE_DIR ? PROBE_TITLE : WINDOW_TITLE,
      readyToken: READY_TOKEN,
      failToken: FAIL_TOKEN,
      shellPage: 'workbench.html',
      renderTitle: `${WINDOW_TITLE} · 金样渲染`,
      stubCode: 'OFFICE_STUDIO_STUB',
      onConsole: (event, level, message) => {
        if (level >= 2) {
          // level 3 = error in Chromium's console-message event; keep the tail so a
          // swallowed renderer exception cannot hide behind a "clean" evidence run
          studioConsoleErrors.push(String(message).slice(0, 300));
        }
      },
    },
    // officeFrame/benchFrame come from the boot layer (they resolve the two office frames by
    // pack id); forgetting to destructure officeFrame here made every push throw a
    // ReferenceError into the catch — the push telemetry caught what the guard hid.
    extend: async ({ services, ipcMain: ipcMainRef, mainWindow, officeFrame, benchFrame }) => {
      mainWindowRef = mainWindow;
      const studio = createStudioServices({
        repoRoot: REPO_ROOT,
        contentDir: services.ctx.contentDir,
        charactersRoot: services.ctx.charactersRoot,
        packId: services.libs.publisher.PACK_ID,
      });
      registerStudioIpc({ ipcMain: ipcMainRef, studio });
      // the renderer-side telemetry reader: the page reports its own backend and idle
      // repaint behaviour, which is exactly what "the renderer says" should mean.
      // NOTE: attach it to the STUDIO bundle (`studio`), not the workbench one (`services`) —
      // the wrong object made the app fail to boot with "setTelemetryReader is not a function".
      studio.setTelemetryReader(async () => {
        const frames = mainWindow ? mainWindow.webContents.mainFrame.framesInSubtree.filter((frame) => frame.url.includes('/preview/office.html')) : [];
        const frame = frames[0];
        if (!frame) return null;
        return frame.executeJavaScript(`(async () => {
          const canvas = document.querySelector('canvas');
          let backend = null;
          if (canvas) {
            backend = (() => {
              try { return canvas.getContext('webgl2') ? 'webgl2' : (canvas.getContext('webgl') ? 'webgl' : 'canvas2d'); } catch { return 'unknown'; }
            })();
          }
          // idle repaint: count rAF callbacks over 600ms while nothing is animating
          const frames = await new Promise((resolve) => {
            let count = 0;
            const started = performance.now();
            const step = () => {
              count += 1;
              if (performance.now() - started < 600) requestAnimationFrame(step);
              else resolve(count);
            };
            requestAnimationFrame(step);
          });
          const api = window.__office && window.__office.api;
          const snapshot = api && typeof api.snapshot === 'function' ? api.snapshot() : null;
          return {
            backend,
            canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
            rafPerSecond: Math.round(frames / 0.6),
            employees: snapshot ? (snapshot.employees || []).length : null,
            layoutSource: typeof api.runtimeLayoutSource === 'function' ? api.runtimeLayoutSource() : null,
            diagnostics: snapshot ? (snapshot.diagnostics || []).slice(-8) : [],
          };
        })()`, true).catch(() => null);
      });


      services.studioInfo = () => studio.info();
      services.previewPushStats = () => ({ ...previewPushStats });

      // The preview page must render the REAL simulation, not the empty stub snapshot the
      // boot layer installs: start the runner (the product's own office module) and serve
      // office:state from it. The other six office:* channels keep their stub answers
      // except dispatch/cancel/interrupt, which map onto the module's own controls.
      const started = studio.previewStart({});
      if (!started.ok) {
        console.error(`${FAIL_TOKEN} PREVIEW_RUNNER_UNAVAILABLE ${started.code || ''} ${started.message || ''}`);
      } else {
        ipcMainRef.removeHandler('office:state');
        ipcMainRef.handle('office:state', async () => {
          const current = studio.previewSnapshot();
          return { ok: true, snapshot: current.ok ? current.snapshot : null };
        });
        for (const [channel, kind] of [['office:dispatch', 'followup'], ['office:cancel', 'cancel'], ['office:interrupt', 'interrupt']]) {
          ipcMainRef.removeHandler(channel);
          ipcMainRef.handle(channel, () => studio.previewControl({ kind }));
        }
        // PUSH, not just pull (T1). The page pulls once at boot and then only re-renders
        // what arrives on `office:state` (src/office/office.html: getState → onState), so a
        // pull-only studio left the run layer showing a frozen boot snapshot while the
        // simulation kept running in this process. The runner already throttles pushes
        // (SNAPSHOT_PUSH_MS); forward them to the office frame's webContents — the same
        // fan-out the product does in src/main.js (broadcastToOfficeViews).
        previewPushStop = studio.previewSubscribe((snapshot) => {
          previewPushStats.calls += 1;
          previewPushStats.lastAtMs = snapshot ? snapshot.simulatedAtMs : null;
          try {
            const frame = officeFrame();            // the RUN layer's frame, never the draft's
            const windowRef = mainWindowRef;
            if (!frame || !windowRef || windowRef.isDestroyed()) { previewPushStats.skipped += 1; return; }
            // Targeted delivery: WebFrameMain has no send(), and webContents.send would fan
            // out to EVERY frame in the window — including the action editor's draft frame,
            // whose puppet snapshot must not be overwritten by the simulation (that is the
            // other half of the "two views fight over one picture" defect).
            windowRef.webContents.sendToFrame([frame.processId, frame.routingId], 'office:state', snapshot);
            previewPushStats.sent += 1;
            previewPushStats.lastTarget = [frame.processId, frame.routingId];
          } catch (error) {
            previewPushStats.errors += 1;
            previewPushStats.lastError = String((error && error.message) || error);
          }
        });
        studio.previewPlay({ speed: 1 });
      }
      return { studio };
    },
  });
  if (!boot) return; // startToolApp already reported and exited
  if (STUDIO_EVIDENCE_DIR) setTimeout(() => runStudioEvidence(boot), 1500);
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (error) => {
  console.error(`${FAIL_TOKEN} STUDIO_UNCAUGHT ${error && error.message}`);
  app.exit(1);
});
