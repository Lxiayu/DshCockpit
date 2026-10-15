'use strict';

// src/workbench/app/ipc.js — the tool IPC surface, registered by every
// workbench entry point (scripts/office-workbench.js, studio/main.js).
//
// The channels and their answers are the M0/M1 contract the renderer
// (src/workbench/workbench.js) and the evidence probes rely on; the module
// only needs an ipcMain and a services bundle (./services.js), so a new entry
// point can never silently register a different surface.

const CHANNELS = Object.freeze([
  'workbench:content-tree',
  'workbench:geometry-report',
  'workbench:asset-report',
  'workbench:entry-geometry',
  'workbench:file-geometry',
  'workbench:publish',
  'workbench:gallery-status',
  'workbench:generate-gallery',
  'workbench:action-list',
  'workbench:action-read',
  'workbench:action-op',
  'workbench:action-new',
  'workbench:action-import-preview',
  'workbench:action-import-insert',
  'workbench:action-stage',
  'workbench:action-publish',
]);

const path = require('node:path');
const fs = require('node:fs');

function registerToolIpc({ ipcMain, services, getWindow = () => null }) {
  const { ctx, libs } = services;

  ipcMain.handle('workbench:content-tree', () => services.listContentTree());
  ipcMain.handle('workbench:geometry-report', () => services.walkGeometryReport());
  ipcMain.handle('workbench:asset-report', () => services.catalogAssetRows());
  ipcMain.handle('workbench:entry-geometry', (_event, assetId) => services.entryGeometryForAsset(String(assetId)));
  ipcMain.handle('workbench:file-geometry', (_event, relPath) => {
    const clean = String(relPath).replace(/\\/g, '/');
    const abs = path.resolve(ctx.contentDir, clean);
    if (!abs.startsWith(ctx.contentDir + path.sep)) return { ok: false, code: 'PATH_ESCAPES_CONTENT' };
    if (clean.endsWith('.png')) return { ok: true, file: clean, geometry: libs.geometry.measureEntry({ absPath: abs }) };
    if (clean.endsWith('.json')) {
      try {
        const parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
        return { ok: true, file: clean, json: { schemaVersion: parsed.schemaVersion ?? null, keys: Object.keys(parsed) } };
      } catch (error) {
        return { ok: false, code: 'JSON_UNPARSEABLE', message: error.message };
      }
    }
    return { ok: true, file: clean, text: true };
  });
  ipcMain.handle('workbench:publish', () => services.validateContentTree());
  ipcMain.handle('workbench:gallery-status', () => {
    const galleryRoot = path.join(ctx.contentDir, 'build', 'gallery');
    const status = {
      galleryRoot,
      hasCurrent: fs.existsSync(path.join(galleryRoot, 'current')),
      hasPrevious: fs.existsSync(path.join(galleryRoot, 'previous')),
      diffReport: null,
    };
    const diffPath = path.join(galleryRoot, 'diff-report.json');
    if (fs.existsSync(diffPath)) status.diffReport = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
    return status;
  });
  ipcMain.on('workbench:report-preview-rect', () => { /* deprecated no-op: the preview is a same-origin iframe now */ });
  ipcMain.handle('workbench:generate-gallery', async (event) => {
    const windowWebContents = getWindow() ? getWindow().webContents : null;
    const progress = (step) => {
      if (windowWebContents && !windowWebContents.isDestroyed() && event.sender === windowWebContents) {
        windowWebContents.send('workbench:gallery-progress', { step });
      }
    };
    progress('rendering');
    const outcome = await services.generateGallery();
    progress(outcome.ok ? 'done' : 'failed');
    return outcome;
  });

  // ---- M1 action editor IPC ----
  ipcMain.handle('workbench:action-list', () => services.actionList());
  ipcMain.handle('workbench:action-read', (_event, actionId) => services.actionRead(String(actionId)));
  ipcMain.handle('workbench:action-op', (_event, actionId, op, payload) => {
    try {
      return services.actionOp(String(actionId), String(op), payload || {});
    } catch (error) {
      return { ok: false, code: 'ACTION_OP_FAILED', message: String((error && error.message) || error) };
    }
  });
  ipcMain.handle('workbench:action-new', (_event, id, direction) => services.actionNew(id, direction));
  ipcMain.handle('workbench:action-import-preview', (_event, actionId, sourcePath, name) => {
    try {
      return services.importPreview(String(actionId), String(sourcePath), typeof name === 'string' ? name : '');
    } catch (error) {
      return { ok: false, violations: [{ file: String(sourcePath), check: 'import.failed', detail: String((error && error.message) || error) }] };
    }
  });
  ipcMain.handle('workbench:action-import-insert', (_event, actionId, sourcePath, name, index) => {
    try {
      return services.importInsert(String(actionId), String(sourcePath), String(name), Number.isInteger(index) ? index : null);
    } catch (error) {
      return { ok: false, violations: [{ file: String(sourcePath), check: 'import.failed', detail: String((error && error.message) || error) }] };
    }
  });
  ipcMain.handle('workbench:action-stage', (_event, actionId) => {
    try {
      return services.stageAction(String(actionId));
    } catch (error) {
      return { ok: false, violations: [{ file: `actions/${actionId}.json`, check: 'stage.failed', detail: String((error && error.message) || error) }] };
    }
  });
  ipcMain.handle('workbench:action-publish', (_event, actionId) => {
    try {
      return services.publishAction(String(actionId));
    } catch (error) {
      return { ok: false, violations: [{ file: `actions/${actionId}.json`, check: 'publish.failed', detail: String((error && error.message) || error) }] };
    }
  });
}

module.exports = { CHANNELS, registerToolIpc };
