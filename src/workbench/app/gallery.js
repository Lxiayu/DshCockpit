'use strict';

// src/workbench/app/gallery.js — the golden gallery (M0 §4): one run produces
// a deterministic render set under content/build/gallery/ through the REAL
// product renderer, then diffs it against the previous run.
//
//   layout-<w>x<h>.png          the compiled flat layout at three window sizes
//   walk-<dir>-frames-<z>x.png  walk-left/right frame strips at 1x/2x
//   geometry.json               the geometry report of THIS run
//
// and compares them against the PREVIOUS run (current/ → previous/): per-image
// pixel diff (+ red overlay maps) and a per-frame geometry diff, written to
// gallery/diff-report.json. The second run must be able to compare against the
// first — the first run simply records the baseline.
//
// This module needs real BrowserWindows (offscreen) — it is the only Electron
// dependency of the gallery path; the entry points pass in their window title
// vocabulary.

const path = require('node:path');
const fs = require('node:fs');

const GALLERY_SIZES = Object.freeze([[1582, 955], [1280, 840], [1100, 760]]);
const GALLERY_ZOOMS = Object.freeze([1, 2]);
const STRIP_FRAME_PX = 352; // the character canvas
const STRIP_GAP_PX = 16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripWindowSize(zoom) {
  const frames = 5;
  return {
    width: STRIP_FRAME_PX * zoom * frames + STRIP_GAP_PX * (frames - 1) + STRIP_GAP_PX * 2,
    height: STRIP_FRAME_PX * zoom + STRIP_GAP_PX * 2 + 34,
  };
}

async function waitUntil(evaluate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate().catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// capturePage can transiently fail ("Current display surface not available")
// right after offscreen runs or occlusion changes — request a repaint and
// retry instead of failing the whole run.
async function capturePageWithRetry(webContents, label, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const image = await webContents.capturePage().catch(() => null);
    if (image && !image.isEmpty()) return image;
    if (typeof webContents.invalidate === 'function') webContents.invalidate();
    await sleep(400);
  }
  throw new Error(`empty capture: ${label}`);
}

function writeJson(absPath, value) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

function diffGalleryDirs(png, previousDir, currentDir) {
  const names = fs.readdirSync(currentDir).filter((name) => name.endsWith('.png')).sort();
  const rows = [];
  const overlays = [];
  for (const name of names) {
    const current = png.decodePngFile(path.join(currentDir, name));
    const previousPath = path.join(previousDir, name);
    if (!fs.existsSync(previousPath)) {
      rows.push({ image: name, baseline: false });
      continue;
    }
    const previous = png.decodePngFile(previousPath);
    const diff = png.diffImages(previous, current);
    if (!diff.comparable) {
      rows.push({ image: name, comparable: false, reason: diff.reason });
      continue;
    }
    rows.push({ image: name, comparable: true, changedPixels: diff.changedPixels, totalPixels: diff.totalPixels, diffRatio: Math.round(diff.diffRatio * 1000000) / 1000000, maxDelta: diff.maxDelta });
    overlays.push({ name, overlay: diff.overlay, width: diff.width, height: diff.height });
  }
  let geometry = null;
  const prevGeoPath = path.join(previousDir, 'geometry.json');
  const curGeoPath = path.join(currentDir, 'geometry.json');
  if (fs.existsSync(prevGeoPath) && fs.existsSync(curGeoPath)) {
    const prevGeo = JSON.parse(fs.readFileSync(prevGeoPath, 'utf8'));
    const curGeo = JSON.parse(fs.readFileSync(curGeoPath, 'utf8'));
    const prevByFile = new Map(prevGeo.rows.map((row) => [row.file, row]));
    geometry = {
      frames: curGeo.rows.map((row) => {
        const before = prevByFile.get(row.file);
        return {
          file: row.file,
          footLine: { before: before ? before.measured.footLine : null, after: row.measured.footLine },
          visibleHeight: { before: before ? before.measured.visibleHeight : null, after: row.measured.visibleHeight },
          changed: !!before && (before.measured.footLine !== row.measured.footLine || before.measured.visibleHeight !== row.measured.visibleHeight),
        };
      }),
      changedFrames: 0,
    };
    geometry.changedFrames = geometry.frames.filter((frame) => frame.changed).length;
  }
  return { rows, geometry, overlays };
}

async function generateGallery({
  BrowserWindow,
  repoRoot,
  contentDir,
  scheme = 'workbench',
  packId = 'deepseek-default',
  renderTitle = 'Office Workbench · 金样渲染',
  libs,
  walkGeometryReport,
  sizes = GALLERY_SIZES,
  zooms = GALLERY_ZOOMS,
}) {
  const galleryRoot = path.join(contentDir, 'build', 'gallery');
  const staging = path.join(galleryRoot, `.staging-${process.pid}`);
  const current = path.join(galleryRoot, 'current');
  const previous = path.join(galleryRoot, 'previous');
  const baselineExisted = fs.existsSync(current);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  let renderWindow = null;
  try {
    // 1) flat layout × 3 window sizes through the REAL office page (the
    // content layout is served read-only at the saved-layout route, so the
    // page compiles exactly the approved baseline).
    renderWindow = new BrowserWindow({
      width: sizes[0][0],
      height: sizes[0][1],
      useContentSize: true,
      // OFFSCREEN rendering: shown windows are clamped to the visible frame
      // by macOS (probed: a 1582×955 window collapses to the 1470×815
      // workarea), which would crop the golden shots. Offscreen captures are
      // exact at any size and keep WebGL compositing (rendererMode probed
      // 'webgl'), so the golden images stay true to the product renderer.
      show: false,
      title: renderTitle,
      webPreferences: {
        preload: path.join(repoRoot, 'src', 'office', 'office-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        offscreen: true,
      },
    });
    renderWindow.on('page-title-updated', (event) => event.preventDefault());
    await renderWindow.loadURL(`office-runtime://local/office.html?pack=${packId}`);
    await waitUntil(() => renderWindow.webContents.executeJavaScript('Boolean(window.__office && window.__office.ready)', true), 60000, 'gallery office page boot');
    const layoutSource = await renderWindow.webContents.executeJavaScript('window.__office.api.runtimeLayoutSource()', true);
    for (const [w, h] of sizes) {
      renderWindow.setContentSize(w, h);
      await sleep(700); // letterbox + deferred resize pass settle
      const image = await capturePageWithRetry(renderWindow.webContents, `layout ${w}x${h}`);
      fs.writeFileSync(path.join(staging, `layout-${w}x${h}.png`), image.toPNG());
    }
    renderWindow.destroy();
    renderWindow = null;

    // 2) walk-left/right frame strips ×2 zooms, composed by the tool strip page
    // from the pack frames + the character.json foot line.
    for (const direction of ['left', 'right']) {
      for (const zoom of zooms) {
        const { width, height } = stripWindowSize(zoom);
        const stripWindow = new BrowserWindow({
          width, height, useContentSize: true, show: false,
          title: renderTitle,
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, offscreen: true },
        });
        stripWindow.on('page-title-updated', (event) => event.preventDefault());
        try {
          await stripWindow.loadURL(`${scheme}://local/gallery-strip.html?dir=${direction}&zoom=${zoom}`);
          await waitUntil(() => stripWindow.webContents.executeJavaScript(
            'Boolean(window.__stripReady === true && document.querySelectorAll("#strip img").length === 5 && document.querySelectorAll("#strip img[data-error]").length === 0)',
            true
          ), 30000, `strip ${direction} ${zoom}x`);
          const stripError = await stripWindow.webContents.executeJavaScript('window.__stripError || null', true);
          if (stripError) throw new Error(`strip data failed: ${stripError}`);
          await sleep(250);
          const image = await capturePageWithRetry(stripWindow.webContents, `strip ${direction} ${zoom}x`);
          fs.writeFileSync(path.join(staging, `walk-${direction}-frames-${zoom}x.png`), image.toPNG());
        } finally {
          stripWindow.destroy();
        }
      }
    }

    // 3) this run's geometry snapshot (the geometry diff source of truth)
    writeJson(path.join(staging, 'geometry.json'), walkGeometryReport());

    // 4) promote: current → previous, staging → current, then diff.
    if (baselineExisted) {
      fs.rmSync(previous, { recursive: true, force: true });
      fs.renameSync(current, previous);
    }
    fs.renameSync(staging, current);
    const diffResult = baselineExisted ? diffGalleryDirs(libs.png, previous, current) : { rows: [], geometry: null, overlays: [] };
    const diff = { rows: diffResult.rows, geometry: diffResult.geometry };
    const report = {
      generatedAt: new Date().toISOString(),
      baselineExisted,
      layoutSource,
      sizes: sizes.map(([w, h]) => `layout-${w}x${h}.png`),
      strips: zooms.flatMap((zoom) => ['left', 'right'].map((direction) => `walk-${direction}-frames-${zoom}x.png`)),
      diff,
    };
    writeJson(path.join(galleryRoot, 'diff-report.json'), report);
    // diff overlays live OUTSIDE current/ so they never join the golden set
    const diffDir = path.join(galleryRoot, 'diff');
    fs.rmSync(diffDir, { recursive: true, force: true });
    if (baselineExisted) {
      fs.mkdirSync(diffDir, { recursive: true });
      for (const entry of diff.rows) {
        const overlay = diffResult.overlays.find((candidate) => candidate.name === entry.image);
        if (overlay) fs.writeFileSync(path.join(diffDir, entry.image), libs.png.encodePng(overlay.overlay, overlay.width, overlay.height));
      }
    }
    return { ok: true, baselineExisted, report };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, code: 'OFFICE_WORKBENCH_GALLERY_FAILED', message: String((error && error.message) || error) };
  } finally {
    if (renderWindow) renderWindow.destroy();
  }
}

module.exports = {
  GALLERY_SIZES,
  GALLERY_ZOOMS,
  sleep,
  waitUntil,
  capturePageWithRetry,
  writeJson,
  stripWindowSize,
  diffGalleryDirs,
  generateGallery,
};
