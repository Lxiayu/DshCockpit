'use strict';

// studio/lib/pipeline/matting.js — S4: the matting post-process, with the ORDER
// enforced in code (brief §3: unpremultiply → harden → de-near-black, in that
// order; getting it wrong is how black fringes and ghosts appear).
//
// This is the studio's own implementation on purpose: the python kit in photo/
// stays the reference for the user's own runs, but a pipeline stage must be
// callable, testable and cacheable from the tool. Every step is a pure function
// over an RGBA buffer, so a QC report can name exactly what changed.

const path = require('node:path');

const NEAR_BLACK_MAX = 32;      // a pixel counts as "near black" when all channels are below this
const HARDEN_ALPHA_MAX = 96;    // alpha below this is snapped to 0 when it is an isolated halo
const DEFAULTS = Object.freeze({
  unpremultiply: true,
  harden: true,
  removeNearBlack: true,
  trimBelowSoles: true,
  nearBlackThreshold: NEAR_BLACK_MAX,
  hardenAlphaMax: HARDEN_ALPHA_MAX,
  // tint removal: a green-screen residual shows as G much larger than R and B
  greenTintMax: 0,
});

function rgbaImage(png, absPath) {
  const image = png.decodePngFile(absPath);
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

function cloneImage(image) {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) };
}

// The source of a black fringe: a premultiplied matte keeps the background's
// colour in the RGB channels where alpha is low. Dividing the colour back out
// (and clamping) is what "unpremultiply" means here.
function unpremultiply(image) {
  const out = cloneImage(image);
  let touched = 0;
  for (let index = 0; index < out.data.length; index += 4) {
    const alpha = out.data[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const factor = 255 / alpha;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = Math.round(out.data[index + channel] * factor);
      out.data[index + channel] = Math.min(255, value);
    }
    touched += 1;
  }
  return { image: out, stats: { unpremultipliedPixels: touched } };
}

// Snap the faint halo ring to fully transparent and the solid core to opaque:
// this removes the semi-transparent "ghost" ring a soft key leaves behind.
function harden(image, options = {}) {
  const max = options.hardenAlphaMax === undefined ? DEFAULTS.hardenAlphaMax : options.hardenAlphaMax;
  const out = cloneImage(image);
  let cleared = 0;
  let solidified = 0;
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const offset = (y * out.width + x) * 4;
      const alpha = out.data[offset + 3];
      if (alpha === 0 || alpha === 255) continue;
      // an isolated faint pixel with no solid neighbour is halo, not content
      let solidNeighbour = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= out.width || ny >= out.height) continue;
        if (out.data[(ny * out.width + nx) * 4 + 3] >= 200) { solidNeighbour = true; break; }
      }
      if (!solidNeighbour && alpha <= max) {
        out.data[offset + 3] = 0;
        cleared += 1;
      } else if (alpha >= 128) {
        out.data[offset + 3] = 255;
        solidified += 1;
      }
    }
  }
  return { image: out, stats: { haloPixelsCleared: cleared, corePixelsSolidified: solidified } };
}

// Near-black residue is the classic "black edge": after unpremultiply the fringe
// turns dark, so the LAST step is to drop dark pixels that carry little alpha.
function removeNearBlack(image, options = {}) {
  const threshold = options.nearBlackThreshold === undefined ? DEFAULTS.nearBlackThreshold : options.nearBlackThreshold;
  const out = cloneImage(image);
  let removed = 0;
  for (let index = 0; index < out.data.length; index += 4) {
    const alpha = out.data[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const r = out.data[index];
    const g = out.data[index + 1];
    const b = out.data[index + 2];
    if (r <= threshold && g <= threshold && b <= threshold) {
      out.data[index + 3] = 0;
      removed += 1;
    }
  }
  return { image: out, stats: { nearBlackPixelsRemoved: removed } };
}


// The fourth step, and the one that actually kills the wash line: below the SOLE
// LINE nothing but matte residue ever lives (the project's own foot-line definition
// is "the lowest row with main-body alpha ≥ 128"). This step clears everything under
// that row — a full-width low-alpha belt is not removable by a per-pixel halo rule,
// because every pixel in it has a neighbour (measured on the gen-1 frames: 8–9 rows
// at α≈102 survive harden+de-near-black, and exactly this step removes them).
function trimBelowSoles(image, options = {}) {
  const threshold = options.soleAlphaThreshold === undefined ? 128 : options.soleAlphaThreshold;
  const out = cloneImage(image);
  let soleRow = -1;
  for (let y = out.height - 1; y >= 0 && soleRow < 0; y -= 1) {
    for (let x = 0; x < out.width; x += 1) {
      if (out.data[(y * out.width + x) * 4 + 3] >= threshold) { soleRow = y; break; }
    }
  }
  if (soleRow < 0) return { image: out, stats: { soleRow: null, trimmedPixels: 0 } };
  let trimmed = 0;
  for (let y = soleRow + 1; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const offset = (y * out.width + x) * 4;
      if (out.data[offset + 3] === 0) continue;
      out.data[offset + 3] = 0;
      trimmed += 1;
    }
  }
  return { image: out, stats: { soleRow, trimmedPixels: trimmed } };
}

// The order is the contract: renaming these steps or reordering the calls is a
// behaviour change and must show up in the cache key (see stages.js).
// The first three are the documented pipeline order (brief §3: unpremultiply →
// harden → 去近黑). `trimBelowSoles` runs LAST as a belt-and-braces cut: after the
// three steps the only thing that can still sit below the soles is matte residue.
const STEP_ORDER = Object.freeze(['unpremultiply', 'harden', 'removeNearBlack', 'trimBelowSoles']);

function cleanup(image, options = {}) {
  const config = { ...DEFAULTS, ...options };
  let current = cloneImage(image);
  const steps = [];
  for (const step of STEP_ORDER) {
    if (config[step] === false) { steps.push({ step, skipped: true }); continue; }
    const outcome = step === 'unpremultiply' ? unpremultiply(current)
      : step === 'harden' ? harden(current, config)
        : step === 'removeNearBlack' ? removeNearBlack(current, config)
          : trimBelowSoles(current, config);
    current = outcome.image;
    steps.push({ step, ...outcome.stats });
  }
  return { image: current, steps, order: STEP_ORDER };
}

function cleanupFile({ absPath, outPath = null, options = {} }) {
  const png = require(path.join(__dirname, '..', '..', '..', 'src', 'workbench', 'lib', 'png-geometry.js'));
  if (!require('node:fs').existsSync(absPath)) return { ok: false, code: 'MATTING_SOURCE_MISSING', message: absPath };
  const image = rgbaImage(png, absPath);
  const outcome = cleanup(image, options);
  const bytes = png.encodePng(outcome.image.data, outcome.image.width, outcome.image.height);
  if (outPath) {
    require('node:fs').mkdirSync(require('node:path').dirname(outPath), { recursive: true });
    require('node:fs').writeFileSync(outPath, bytes);
  }
  return { ok: true, bytes, steps: outcome.steps, order: outcome.order, width: outcome.image.width, height: outcome.image.height };
}

module.exports = {
  DEFAULTS,
  HARDEN_ALPHA_MAX,
  NEAR_BLACK_MAX,
  STEP_ORDER,
  cleanup,
  cleanupFile,
  harden,
  removeNearBlack,
  trimBelowSoles,
  unpremultiply,
};
