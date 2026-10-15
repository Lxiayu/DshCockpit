'use strict';

// scripts/office-workbench.js — Workbench shell entry (npm run office:workbench).
//
// One Electron window, three panes:
//   left   = content/ resource tree (workbench renderer page)
//   center = PREVIEW FIELD: the real office page (office.html, ?editor=1)
//            embedded as a SAME-ORIGIN iframe — workbench://local/preview/
//            office.html, a tool-served copy of the product page (only its
//            CSP origin reference is rewritten for this copy). Its
//            "saved layout" route is answered with content/scenes/flat/
//            layout.json through a READ-ONLY store so the preview shows the
//            approved flat baseline and the baseline can never be written
//            back (D1/D5). The subframe receives the REAL office bridge —
//            this window's preload requires src/office/office-preload.js
//            verbatim.
//   right  = property inspector surface: geometry report, asset validator,
//            golden gallery with pixel/geometry diff.
//
// The app layer (protocol handler, service bundle, IPC surface, window boot)
// lives in src/workbench/app/**; this file only pins the legacy entry's
// vocabulary (userData, window title, stdout tokens, evidence modes) so the
// studio entry (studio/main.js) can share the exact same surface.
//
// Boundaries this launcher enforces (docs/notes/office-workbench-m0.md §3):
// - ISOLATED userData: .workbench-data/ in the repo — the real user profile
//   AND .office-editor-data/ are never read or written.
// - The workbench WRITES only content/build/** (gallery, reports) and
//   content/characters/** through the publish kernel.
//   content/scenes/flat/layout.json is read-only.
// - office:* IPC stays the launcher stub set (empty snapshot); the seven
//   channel semantics and the office preload whitelist are untouched.
// - The gallery renders through the REAL runtime renderer (pixi-office-
//   renderer via office.html) — read-only reuse, no renderer changes.
// - Window titles stay distinguishable: product `Agent Office`, probes
//   `PROBE 临时数据（可关闭）`, this shell `Office Workbench`.
//
// stdout contract: `OFFICE_WORKBENCH_READY` once both pages report ready —
// evidence probes wait on this line. Failures print
// `OFFICE_WORKBENCH_BOOT_FAILED <CODE>` to stderr and exit non-zero.
//
// Evidence mode: WORKBENCH_EVIDENCE_DIR=<dir> automates a full M0 sweep
// (screenshots, reports, two gallery runs with diff) into that directory and
// exits — used by the M0 verification, harmless otherwise.

const { app, protocol, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { registerToolSchemes, startToolApp } = require(path.join(__dirname, '..', 'src', 'workbench', 'app', 'boot.js'));
const { sleep, waitUntil, capturePageWithRetry, writeJson } = require(path.join(__dirname, '..', 'src', 'workbench', 'app', 'gallery.js'));

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.WORKBENCH_DATA_DIR
  ? path.resolve(process.env.WORKBENCH_DATA_DIR)
  : path.join(REPO_ROOT, '.workbench-data');
const CONTENT_DIR = path.join(REPO_ROOT, 'content');
const LIB_DIR = path.join(REPO_ROOT, 'src', 'workbench', 'lib');
const SOURCE_PACK_DIR = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default');

// The evidence sweeps below inspect reports directly; the interactive surface
// goes through the service bundle (services.*) built in startToolApp.
const libs = {
  png: require(path.join(LIB_DIR, 'png-geometry.js')),
  assets: require(path.join(LIB_DIR, 'asset-validator.js')),
  content: require(path.join(LIB_DIR, 'content-validator.js')),
  geometry: require(path.join(LIB_DIR, 'character-geometry.js')),
};

const EVIDENCE_DIR = process.env.WORKBENCH_EVIDENCE_DIR ? path.resolve(process.env.WORKBENCH_EVIDENCE_DIR) : null;
const M1_EVIDENCE_DIR = process.env.WORKBENCH_M1_EVIDENCE_DIR ? path.resolve(process.env.WORKBENCH_M1_EVIDENCE_DIR) : null;
const M1_EVIDENCE_PHASE = process.env.WORKBENCH_M1_PHASE === '2' ? 2 : 1;

const READY_TOKEN = 'OFFICE_WORKBENCH_READY';
const FAIL_TOKEN = 'OFFICE_WORKBENCH_BOOT_FAILED';
const WINDOW_TITLE = 'Office Workbench';
const PROBE_TITLE = 'PROBE 临时数据（可关闭）';
// The shared content layout store answers a preview 保存布局 PUT with this
// code (src/workbench/app/services.js): the flat baseline is read-only inside
// the tool. Pinned by test/office-ui.test.js.
const LAYOUT_READONLY_CODE = 'OFFICE_WORKBENCH_LAYOUT_READONLY';

// Privileged scheme declarations must precede app ready (same privileges as
// the cockpit and the standalone editor register).
registerToolSchemes(protocol, 'workbench');

let mainWindow = null;
let services = null;
let officeFrame = () => null;

function walkGeometryReport() {
  return services.walkGeometryReport();
}

function fail(code, error) {
  console.error(`${FAIL_TOKEN} ${code}${error ? ` ${error}` : ''}`);
  app.exit(1);
}

// ---------------------------------------------------------------------------

async function runEvidenceMode() {
  const results = { mode: 'evidence', startedAt: new Date().toISOString(), repoHead: null };
  const note = (step, value) => {
    results[step] = value;
    try { writeJson(path.join(EVIDENCE_DIR, 'results.json'), results); } catch { /* best effort */ }
  };
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    note('userData', DATA_DIR);
    // preview ready + editor auto-opened + panel data settled
    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    await sleep(3500);
    const previewFrame = officeFrame();
    if (!previewFrame) throw new Error('preview frame not found');
    const previewState = await previewFrame.executeJavaScript(`JSON.stringify({
      ready: Boolean(window.__office && window.__office.ready),
      runtimeLayoutSource: window.__office.api.runtimeLayoutSource(),
      layoutSource: window.__office.api.layoutSource(),
      editorOpen: (() => { const el = document.getElementById('layout-editor'); return !!el && !el.hidden; })(),
      draftItems: window.__office.api.layoutDraft().items.length,
      rendererMode: window.__office.api.rendererMode(),
    })`, true);
    note('preview', JSON.parse(previewState));

    // geometry + validators (the same services the panel consumes)
    const geometry = walkGeometryReport();
    note('geometry', {
      totalFrames: geometry.totalFrames,
      redFrames: geometry.redFrames,
      tolerance: geometry.tolerance,
      medians: geometry.actions.map((action) => ({ id: action.id, medians: action.medians })),
      rows: geometry.rows.map((row) => ({ action: row.action, file: row.file, measured: row.measured, deviation: row.deviation, red: row.red })),
    });
    const assetRows = libs.assets.catalogAssetRows(REPO_ROOT);
    note('assets', { total: assetRows.length, ok: assetRows.filter((row) => row.ok).length, bad: assetRows.filter((row) => !row.ok).map((row) => row.id) });
    const publish = libs.content.validateContentTree({ repoRoot: REPO_ROOT, contentDir: CONTENT_DIR });
    note('publish', { ok: publish.ok, filesScanned: publish.filesScanned, violations: publish.violations });

    // screenshots: the SAME-ORIGIN preview iframe composites into the shell
    // frame, so ONE capture carries the three panes (taken BEFORE the
    // offscreen gallery runs, which can transiently starve the compositor).
    // The preview crop doubles as the preview-field shot.
    await sleep(1200);
    const shellImage = await capturePageWithRetry(mainWindow.webContents, 'workbench shell');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-shell.png'), shellImage.toPNG());
    const iframeRect = await mainWindow.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('preview-frame');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`, true);
    if (iframeRect && iframeRect.width > 10) {
      const shell = libs.png.decodePng(shellImage.toPNG());
      const scale = shell.width / mainWindow.getContentSize()[0];
      const px = {
        x: Math.round(iframeRect.x * scale),
        y: Math.round(iframeRect.y * scale),
        w: Math.round(iframeRect.width * scale),
        h: Math.round(iframeRect.height * scale),
      };
      if (px.w > 0 && px.h > 0 && px.x + px.w <= shell.width && px.y + px.h <= shell.height) {
        const crop = cropImage(shell, px.x, px.y, px.w, px.h);
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-preview.png'), libs.png.encodePng(crop.data, crop.width, crop.height));
      }
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-three-pane.png'), shellImage.toPNG());
    }

    // right-panel tab shot: the validator red/green table (+ a publish run
    // through the panel button so the result block is populated)
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-assets').click()");
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-publish').click()");
    await sleep(2500);
    const assetsImage = await capturePageWithRetry(mainWindow.webContents, 'workbench assets tab');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-assets.png'), assetsImage.toPNG());

    // two gallery runs driven through the REAL panel button (the user path —
    // the panel refreshes itself from the button's outcome):
    // run 1 lays the baseline, run 2 diffs against it.
    const readDiffReport = () => JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'build', 'gallery', 'diff-report.json'), 'utf8'));
    const buttonReady = "!document.getElementById('btn-generate-gallery').disabled";
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-gallery').click()");
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-generate-gallery').click()");
    await waitUntil(() => mainWindow.webContents.executeJavaScript(buttonReady, true), 300000, 'gallery run 1 (panel button)');
    note('galleryRun1', readDiffReport());
    await mainWindow.webContents.executeJavaScript("document.getElementById('btn-generate-gallery').click()");
    await waitUntil(() => mainWindow.webContents.executeJavaScript(buttonReady, true), 300000, 'gallery run 2 (panel button)');
    note('galleryRun2', readDiffReport());

    // gallery tab now shows the updated diff report
    await sleep(600);
    const galleryImage = await capturePageWithRetry(mainWindow.webContents, 'workbench gallery tab');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'workbench-gallery.png'), galleryImage.toPNG());
    await mainWindow.webContents.executeJavaScript("document.getElementById('tab-geometry').click()");
    await sleep(300);

    // gallery artifacts copied into the evidence dir
    const galleryCurrent = path.join(CONTENT_DIR, 'build', 'gallery', 'current');
    if (fs.existsSync(galleryCurrent)) {
      fs.cpSync(galleryCurrent, path.join(EVIDENCE_DIR, 'gallery'), { recursive: true });
      const diffReport = path.join(CONTENT_DIR, 'build', 'gallery', 'diff-report.json');
      if (fs.existsSync(diffReport)) fs.copyFileSync(diffReport, path.join(EVIDENCE_DIR, 'gallery', 'diff-report.json'));
    }
    note('finishedAt', new Date().toISOString());
    console.log('OFFICE_WORKBENCH_EVIDENCE_OK');
    app.exit(0);
  } catch (error) {
    results.error = String((error && error.stack) || error);
    note('finishedAt', new Date().toISOString());
    console.error('OFFICE_WORKBENCH_EVIDENCE_FAILED', results.error);
    app.exit(1);
  }
}

// crop a rect out of an RGBA image (evidence preview crop)
function cropImage(image, x, y, w, h) {
  const out = libs.png.createImage(w, h, [24, 26, 30, 255]);
  for (let row = 0; row < h; row += 1) {
    const srcRow = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * w * 4, srcRow, srcRow + w * 4);
  }
  return out;
}

// ---- M1 evidence mode -------------------------------------------------------
//
// WORKBENCH_M1_EVIDENCE_DIR=<dir> (+ WORKBENCH_M1_PHASE=1|2) drives the REAL
// action panel through a full M1 verification sweep and exits:
//   phase 1 — timeline ops through the panel buttons, publish through the
//             panel button, before/after production pack snapshots;
//   phase 2 — persistence after a restart (the timeline must still show the
//             edited order), frame-stepped preview strips through the REAL
//             renderer, then the revert + re-publish (byte-identical restore)
//             and the backup-rollback verification.
// Probe discipline: temp userData is set by the launcher, results go to
// files, failures throw into the catch → console.error + app.exit(1); no
// assert inside the probe.

// T7: the timeline reorders by selecting a segment and pressing ←/→ (or by dragging it) —
// the legacy M1 evidence drives the keyboard path, which lands in the same handler.
function m1Key(selector, key) {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    return 'ok';
  })()`, true);
}

function m1Click(selector) {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    el.click();
    return 'ok';
  })()`, true);
}

async function m1WaitFor(expression, timeoutMs, label) {
  await waitUntil(async () => mainWindow.webContents.executeJavaScript(expression, true).catch(() => false), timeoutMs, label);
}

async function m1TimelineState() {
  return JSON.parse(await mainWindow.webContents.executeJavaScript(`JSON.stringify({
    action: document.getElementById('action-select') ? document.getElementById('action-select').value : null,
    // T7: one timeline — the frame cards became segments of #bench-timeline
    files: [...document.querySelectorAll('#bench-timeline .timeline-segment')].map((segment) => segment.dataset.file),
    loop: document.getElementById('action-loop') ? document.getElementById('action-loop').checked : null,
    summary: document.getElementById('action-summary') ? document.getElementById('action-summary').textContent : '',
  })`, true));
}

async function m1Screenshot(webContents, dir, name) {
  const image = await capturePageWithRetry(webContents, name);
  fs.writeFileSync(path.join(dir, name), image.toPNG());
  return image;
}

// Split a canonical animations.json into top-level entry blocks (indent-4
// `"id": {` … closing line) — the "其余动作逐字不动" check works on raw text.
function m1AnimationEntryBlocks(text) {
  const blocks = new Map();
  const lines = text.split('\n');
  let current = null;
  let buffer = [];
  for (const line of lines) {
    const start = /^    "([^"]+)": \{/.exec(line);
    if (start && current === null) {
      current = start[1];
      buffer = [line];
      continue;
    }
    if (current !== null) {
      buffer.push(line);
      if (line === '    },' || line === '    }') {
        blocks.set(current, buffer.join('\n'));
        current = null;
      }
    }
  }
  return blocks;
}

function m1PreviewRect() {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('preview-frame');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`, true);
}

// The office STAGE canvas rect in SHELL coordinates (iframe rect + the
// canvas rect inside the same-origin office page) — the strip evidence crops
// exactly the rendered scene, not the surrounding panels.
async function m1StageRect() {
  const iframe = await m1PreviewRect();
  if (!iframe) return null;
  const inner = await officeFrame().executeJavaScript(`(() => {
    const canvas = document.querySelector('#stage-host canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`, true).catch(() => null);
  if (!inner) return iframe;
  return { x: iframe.x + inner.x, y: iframe.y + inner.y, width: inner.width, height: inner.height };
}

// Hide the in-preview layout editor so the stage fills the preview (the strip
// shows the scene, not the editor panels). Idempotent.
async function m1HidePreviewEditor() {
  const frame = officeFrame();
  if (!frame) return;
  await frame.executeJavaScript(`(() => {
    const el = document.getElementById('layout-editor');
    const api = window.__office && window.__office.api;
    if (el && !el.hidden && api && api.toggleLayoutEditor) { api.toggleLayoutEditor(); return 'hidden'; }
    return 'already';
  })()`, true).catch(() => null);
}

async function m1PreviewStrip(dir, name, steps) {
  const rect = await m1StageRect();
  const shellSize = mainWindow.getContentSize();
  const frames = [];
  for (const image of steps) {
    const shell = libs.png.decodePng(image.toPNG());
    const scale = shell.width / shellSize[0];
    const px = {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      w: Math.round(rect.width * scale),
      h: Math.round(rect.height * scale),
    };
    frames.push(cropImage(shell, px.x, px.y, px.w, px.h));
  }
  const gap = 8;
  const strip = libs.png.createImage(frames.reduce((sum, frame) => sum + frame.width + gap, gap), Math.max(...frames.map((frame) => frame.height)) + gap * 2, [24, 26, 30, 255]);
  let cursorX = gap;
  for (const frame of frames) {
    libs.png.blit(strip, frame, cursorX, gap);
    cursorX += frame.width + gap;
  }
  fs.writeFileSync(path.join(dir, name), libs.png.encodePng(strip.data, strip.width, strip.height));
}

async function runM1EvidenceMode() {
  const dir = M1_EVIDENCE_DIR;
  const phase = M1_EVIDENCE_PHASE;
  const results = { mode: 'm1-evidence', phase, startedAt: new Date().toISOString(), userData: DATA_DIR };
  const note = (step, value) => {
    results[step] = value;
    try { writeJson(path.join(dir, `results-phase${phase}.json`), results); } catch { /* best effort */ }
  };
  const animationsPath = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'animation', 'animations.json');
  const anchorsPath = path.join(REPO_ROOT, 'resources', 'characters', 'deepseek-default', 'animation', 'anchors.json');
  const copyProduction = (sub) => {
    const out = path.join(dir, sub);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(animationsPath, path.join(out, 'animations.json'));
    fs.copyFileSync(anchorsPath, path.join(out, 'anchors.json'));
    return out;
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    await waitUntil(async () => {
      const frame = officeFrame();
      return frame ? frame.executeJavaScript('Boolean(window.__office && window.__office.ready)', true).catch(() => false) : false;
    }, 90000, 'preview boot');
    await sleep(3000);
    await m1WaitFor(`document.getElementById('tab-actions') !== null`, 15000, 'actions tab');
    await m1Click('#tab-actions');
    await m1WaitFor(`document.querySelectorAll('#bench-timeline .timeline-segment').length > 0`, 20000, 'action timeline render');
    await sleep(1200);

    if (phase === 1) {
      // 1) timeline before/after through the REAL panel buttons
      const before = await m1TimelineState();
      note('timelineBefore', before);
      await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-before.png');
      // move the passing frame (index 2) up one — the exact op of the M1 story
      await m1Click('#bench-timeline .timeline-segment[data-frame="2"]');
      await m1Key('#bench-timeline .timeline-segment[data-frame="2"]', 'ArrowLeft');
      await sleep(1200);
      const after = await m1TimelineState();
      note('timelineAfter', after);
      if (JSON.stringify(after.files) === JSON.stringify(before.files)) throw new Error('timeline reorder did not change the card order');
      await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-after.png');

      // 2) publish through the panel button; capture production before/after
      const beforeDir = copyProduction('production-before');
      note('productionBeforeDir', beforeDir);
      await m1Click('#btn-action-publish');   // T7: 危险操作要点两次（第一次只是武装）
      await m1Click('#btn-action-publish');
      await m1WaitFor(`/已发布|无变更|被拒绝/.test(document.getElementById('action-publish-result').textContent)`, 60000, 'publish completion');
      await sleep(800);
      const publishText = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-publish-result').textContent`, true);
      note('publishResult', publishText);
      if (!publishText.includes('已发布')) throw new Error(`publish did not succeed: ${publishText}`);
      const afterDir = copyProduction('production-after');
      note('productionAfterDir', afterDir);

      // 3) diff proof: ONLY the target action entry changed
      const beforeText = fs.readFileSync(animationsPath, 'utf8');
      const beforeBlocks = m1AnimationEntryBlocks(fs.readFileSync(path.join(beforeDir, 'animations.json'), 'utf8'));
      const afterBlocks = m1AnimationEntryBlocks(beforeText);
      const changedIds = [...afterBlocks.keys()].filter((id) => beforeBlocks.get(id) !== afterBlocks.get(id));
      const missingIds = [...beforeBlocks.keys()].filter((id) => !afterBlocks.has(id));
      note('animationsDiff', { changedIds, missingIds, expectedOnly: ['walk-left'] });
      if (JSON.stringify(changedIds) !== JSON.stringify(['walk-left']) || missingIds.length > 0) {
        throw new Error(`unexpected animations.json changes: ${JSON.stringify({ changedIds, missingIds })}`);
      }
      const beforeAnchors = JSON.parse(fs.readFileSync(path.join(beforeDir, 'anchors.json'), 'utf8'));
      const afterAnchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
      const declared = JSON.parse(beforeText).animations['walk-left'].frames.map((frame) => frame.file);
      const leftKeys = Object.keys(afterAnchors.frames).filter((file) => file.includes('/walk/left/'));
      note('anchorsOrder', { leftKeys, declared, match: JSON.stringify(leftKeys) === JSON.stringify(declared) });
      if (JSON.stringify(leftKeys) !== JSON.stringify(declared)) throw new Error('anchors key order does not follow the new metadata order');

      // 4) backups + provenance on disk
      const backupsRoot = path.join(CONTENT_DIR, 'build', 'backups');
      const backupDirs = fs.readdirSync(backupsRoot).sort();
      const provenanceDir = path.join(CONTENT_DIR, 'characters', 'whale-girl', 'provenance');
      const provenanceFiles = fs.readdirSync(provenanceDir).filter((name) => name.endsWith('.json')).sort();
      note('backups', { dirs: backupDirs, provenanceFiles });
      if (backupDirs.length === 0 || provenanceFiles.length === 0) throw new Error('publish did not record backup/provenance');
      const latestBackup = path.join(backupsRoot, backupDirs[backupDirs.length - 1]);
      const backupAnimations = fs.readFileSync(path.join(latestBackup, 'animations.json'));
      const preAnimations = fs.readFileSync(path.join(beforeDir, 'animations.json'));
      note('backupMatchesPrePublish', backupAnimations.equals(preAnimations));
      if (!backupAnimations.equals(preAnimations)) throw new Error('the backup is not the pre-publish bytes');
      const provenance = JSON.parse(fs.readFileSync(path.join(provenanceDir, provenanceFiles[provenanceFiles.length - 1]), 'utf8'));
      note('provenanceEntry', provenance);

      await m1Screenshot(mainWindow.webContents, dir, 'm1-publish-result.png');
      note('finishedAt', new Date().toISOString());
      console.log('OFFICE_WORKBENCH_M1_EVIDENCE_OK');
      app.exit(0);
      return;
    }

    // ---- phase 2: persistence + preview playback + revert + rollback proof --
    const phase1 = JSON.parse(fs.readFileSync(path.join(dir, 'results-phase1.json'), 'utf8'));
    const persisted = await m1TimelineState();
    const match = JSON.stringify(persisted.files) === JSON.stringify(phase1.timelineAfter.files);
    note('persistenceCheck', { expected: phase1.timelineAfter.files, actual: persisted.files, match });
    if (!match) throw new Error('the edited sequence did not survive the workbench restart');
    await m1Screenshot(mainWindow.webContents, dir, 'm1-timeline-after-restart.png');

    // the strips show the SCENE: hide the in-preview layout editor
    await m1HidePreviewEditor();
    await sleep(800);

    // frame-stepped preview strips through the REAL renderer (staged draft pack).
    // The FIRST step click stages the draft pack and reloads the preview iframe
    // (which auto-reopens the layout editor via ?editor=1) — hide the editor
    // only AFTER that reload so the strip shows the scene itself.
    async function stripFor(action, name) {
      await mainWindow.webContents.executeJavaScript(`(() => {
        const select = document.getElementById('action-select');
        select.value = ${JSON.stringify(action)};
        select.dispatchEvent(new Event('change'));
        return select.value;
      })()`, true);
      await sleep(1500);
      const steps = [];
      for (let index = 0; index < 5; index += 1) {
        await m1Click('#btn-action-step');
        await sleep(900); // staging + (first) staged reload + snapshot push settle
        if (index === 0) {
          await m1HidePreviewEditor();
          await sleep(600);
        }
        steps.push(await capturePageWithRetry(mainWindow.webContents, `${name} step ${index + 1}`));
      }
      await m1PreviewStrip(dir, name, steps);
      const playbackText = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-playback').textContent`, true);
      const stageRect = await m1StageRect();
      note(`strip_${action}`, { playback: playbackText, stageRect, frames: steps.length });
      await m1Click('#btn-action-stop');
      await sleep(400);
    }
    await stripFor('walk-left', 'm1-preview-play-walk-left.png');

    // live playback shot (the clock-driven path)
    await m1Click('#btn-action-play');
    await sleep(1600);
    await m1Screenshot(mainWindow.webContents, dir, 'm1-preview-playing.png');
    await m1Click('#btn-action-stop');
    await sleep(400);

    await stripFor('walk-right', 'm1-preview-play-walk-right.png');

    // revert through the panel — idempotent: only when the edited order is live
    await mainWindow.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('action-select');
      select.value = 'walk-left';
      select.dispatchEvent(new Event('change'));
      return select.value;
    })()`, true);
    await sleep(1200);
    const beforeRevert = await m1TimelineState();
    let revertedNow = JSON.stringify(beforeRevert.files) === JSON.stringify(phase1.timelineAfter.files);
    if (revertedNow) {
      await m1Click('#bench-timeline .timeline-segment[data-frame="1"]');
      await m1Key('#bench-timeline .timeline-segment[data-frame="1"]', 'ArrowRight');
      await sleep(1200);
    }
    const reverted = await m1TimelineState();
    note('timelineReverted', { files: reverted.files, revertedNow });
    if (JSON.stringify(reverted.files) !== JSON.stringify(phase1.timelineBefore.files)) {
      throw new Error(`revert did not restore the original order: ${JSON.stringify(reverted.files)}`);
    }

    // re-publish → the production pack must be byte-identical to the ORIGINAL
    let revertPublishResult = 'skipped — the draft already matches the original order';
    if (revertedNow) {
      await m1Click('#btn-action-publish');   // T7: 危险操作要点两次（第一次只是武装）
      await m1Click('#btn-action-publish');
      await m1WaitFor(`/已发布|无变更|被拒绝/.test(document.getElementById('action-publish-result').textContent)`, 60000, 'revert publish completion');
      await sleep(800);
      revertPublishResult = await mainWindow.webContents.executeJavaScript(`document.getElementById('action-publish-result').textContent`, true);
      if (!revertPublishResult.includes('已发布')) throw new Error(`revert publish did not succeed: ${revertPublishResult}`);
    }
    note('revertPublishResult', revertPublishResult);
    const restoredAnimations = fs.readFileSync(animationsPath);
    const originalAnimations = fs.readFileSync(path.join(dir, 'production-before', 'animations.json'));
    const restoredAnchors = fs.readFileSync(anchorsPath);
    const originalAnchors = fs.readFileSync(path.join(dir, 'production-before', 'anchors.json'));
    note('rollbackVerification', {
      animationsByteIdentical: restoredAnimations.equals(originalAnimations),
      anchorsByteIdentical: restoredAnchors.equals(originalAnchors),
    });
    if (!restoredAnimations.equals(originalAnimations) || !restoredAnchors.equals(originalAnchors)) {
      throw new Error('the re-publish did not restore the original production bytes');
    }
    // the FIRST backup still holds the original bytes — the manual rollback path
    const backupsRoot = path.join(CONTENT_DIR, 'build', 'backups');
    const backupDirs = fs.readdirSync(backupsRoot).sort();
    const firstBackupAnimations = fs.readFileSync(path.join(backupsRoot, backupDirs[0], 'animations.json'));
    note('backups', { dirs: backupDirs, firstBackupHoldsOriginalBytes: firstBackupAnimations.equals(originalAnimations) });
    if (!firstBackupAnimations.equals(originalAnimations)) throw new Error('the first backup does not hold the original bytes');

    await m1Screenshot(mainWindow.webContents, dir, 'm1-final-state.png');
    note('finishedAt', new Date().toISOString());
    console.log('OFFICE_WORKBENCH_M1_EVIDENCE_OK');
    app.exit(0);
  } catch (error) {
    results.error = String((error && error.stack) || error);
    note('finishedAt', new Date().toISOString());
    console.error('OFFICE_WORKBENCH_M1_EVIDENCE_FAILED', results.error);
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
      // evidence/probe runs mark the window per the probe discipline (临时数据,
      // 可关闭); the interactive tool keeps its 'Office Workbench' title —
      // the three title vocabularies stay distinguishable (M0 §2).
      windowTitle: EVIDENCE_DIR || M1_EVIDENCE_DIR ? PROBE_TITLE : WINDOW_TITLE,
      readyToken: READY_TOKEN,
      failToken: FAIL_TOKEN,
      shellPage: 'workbench.html',
      renderTitle: `${WINDOW_TITLE} · 金样渲染`,
    },
  });
  if (!boot) return; // startToolApp already reported and exited
  mainWindow = boot.mainWindow;
  services = boot.services;
  officeFrame = boot.officeFrame;
  if (EVIDENCE_DIR) {
    // give the renderer's first report fetch + editor auto-open a beat
    setTimeout(() => runEvidenceMode(), 1500);
  } else if (M1_EVIDENCE_DIR) {
    // M1 evidence sweep (WORKBENCH_M1_PHASE=1 edit+publish, 2 persist+play+revert)
    setTimeout(() => runM1EvidenceMode(), 1500);
  }
});

app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (error) => fail('OFFICE_WORKBENCH_UNCAUGHT', error && error.message));
