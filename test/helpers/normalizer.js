'use strict';

// test/helpers/normalizer.js — the M1 deterministic import normalizer.
//
// P5 (2026-09-24): moved out of src/workbench/lib with the authoring block.
// Kept as TEST SUPPORT: office-asset-runtime.test.js pins the deterministic
// scale+translate contact measurement through measureContact().
//
// An imported frame is NEVER dropped into the character raw ("归一化是一等
// 公民", design §2.3): it is uniformly scaled and translated so it lands on
// the pack geometry exactly like the E5a passing-frame pipeline did —
// - one UNIFORM scale maps the source's visible body height onto the target
//   height (the same-action visible-height median);
// - one INTEGER translation places the source contact anchor (median x of the
//   alpha>=128 lowest row, that row itself) onto the pack anchor (178, 296) —
//   the shoe line therefore lands on geometry.footLine;
// - nothing else is touched: no cropping, no color work, no retouch (the
//   "不改美术内容" boundary — scale + integer translate only, deterministic).
//
// The result must re-measure within the M1 tolerances (shoe line ±1px, visible
// height ±2px) and the visible art must fit the 352² output canvas — anything
// else is rejected fail-closed with a violations list ({ok:false}), so the
// caller never inserts an unaligned frame.
//
// Sampling: premultiplied bilinear over the decoded RGBA (no dark-edge
// halos when body meets transparency), fixed weights — byte-identical output
// for identical input. Pure CommonJS, no DOM/Electron/fs.

const { decodePng, encodePng, alphaBounds } = require('./png-geometry.js');

const SHOE_ALPHA_THRESHOLD = 128; // the pack shoe-line rule (character-geometry)
const BOUNDS_ALPHA_THRESHOLD = 8; // the contentBbox visible-bounds rule
const FOOT_TOLERANCE_PX = 1; // same tolerance the publish validator enforces
const HEIGHT_TOLERANCE_PX = 2;

function violation(check, detail) {
  return { check, ok: false, detail: detail === undefined ? null : detail };
}

// The source contact anchor: median x of the alpha>=128 pixels on the lowest
// such row, and that row — the same "single-lowest-row-median" rule the pack
// pipeline's anchors.json detection records.
function measureContact(image) {
  const { width, height, data } = image;
  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width * 4;
    const xs = [];
    for (let x = 0; x < width; x += 1) {
      if (data[row + x * 4 + 3] >= SHOE_ALPHA_THRESHOLD) xs.push(x);
    }
    if (xs.length > 0) {
      xs.sort((a, b) => a - b);
      const mid = Math.floor(xs.length / 2);
      const medianX = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
      return { x: medianX, y };
    }
  }
  return null;
}

// Premultiplied bilinear sample of `image` at floating source coords.
function samplePremultiplied(image, sx, sy) {
  const { width, height, data } = image;
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const tx = sx - x0;
  const ty = sy - y0;
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return [0, 0, 0, 0];
    const o = (y * width + x) * 4;
    return [data[o], data[o + 1], data[o + 2], data[o + 3]];
  };
  const p00 = at(x0, y0);
  const p10 = at(x1, y0);
  const p01 = at(x0, y1);
  const p11 = at(x1, y1);
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const a = p00[3] * w00 + p10[3] * w10 + p01[3] * w01 + p11[3] * w11;
  if (a <= 0) return [0, 0, 0, 0];
  const r = (p00[0] * p00[3] * w00 + p10[0] * p10[3] * w10 + p01[0] * p01[3] * w01 + p11[0] * p11[3] * w11) / a;
  const g = (p00[1] * p00[3] * w00 + p10[1] * p10[3] * w10 + p01[1] * p01[3] * w01 + p11[1] * p11[3] * w11) / a;
  const b = (p00[2] * p00[3] * w00 + p10[2] * p10[3] * w10 + p01[2] * p01[3] * w01 + p11[2] * p11[3] * w11) / a;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [clamp(r), clamp(g), clamp(b), clamp(a)];
}

// normalizeImportFrame({ sourceBytes, targetHeight, footLine, packCanvas,
//   packAnchor }) ->
//   { ok, png, entry, metrics } — png is a packCanvas² RGBA Buffer ready to
//   store under the character content assets; entry mirrors the anchors.json
//   record shape (outputAnchor / sourceAnchor / sourceCanvas / sourceScale /
//   visibleBounds / detection) so the publish kernel can rebuild provenance.
// | { ok: false, violations: [{check, ok, detail}] } — nothing was produced.
function normalizeImportFrame({ sourceBytes, targetHeight, footLine, packCanvas, packAnchor }) {
  const violations = [];
  if (!Buffer.isBuffer(sourceBytes)) violations.push(violation('source.decodable', 'source bytes are not a Buffer'));
  if (!Number.isFinite(targetHeight) || targetHeight <= 0) violations.push(violation('target.height', String(targetHeight)));
  if (!Number.isInteger(footLine)) violations.push(violation('target.footLine', String(footLine)));
  if (!Number.isInteger(packCanvas) || packCanvas <= 0) violations.push(violation('target.canvas', String(packCanvas)));

  let image = null;
  if (Buffer.isBuffer(sourceBytes)) {
    try {
      image = decodePng(sourceBytes);
    } catch (error) {
      violations.push(violation('source.decodable', (error && error.code) || 'PNG_DECODE_FAILED'));
    }
  }
  if (!image) return { ok: false, violations };

  const bounds = alphaBounds(image, BOUNDS_ALPHA_THRESHOLD);
  if (!bounds) {
    violations.push(violation('body.visible', 'the source has no visible pixels (alpha>8) — nothing to normalize'));
    return { ok: false, violations };
  }
  const contact = measureContact(image);
  if (!contact) {
    violations.push(violation('body.contact', 'no alpha>=128 pixel found — the shoe line cannot be aligned'));
    return { ok: false, violations };
  }

  const sourceVisibleHeight = bounds.h;
  const scale = targetHeight / sourceVisibleHeight;
  if (!(scale > 0) || !Number.isFinite(scale)) {
    violations.push(violation('scale.uniform', `non-finite uniform scale from height ${sourceVisibleHeight} -> ${targetHeight}`));
    return { ok: false, violations };
  }

  // One uniform scale + one integer translation: the source contact anchor
  // maps onto the pack anchor, so the shoe line lands on geometry.footLine.
  const dx = Math.round(packAnchor.x - contact.x * scale);
  const dy = Math.round(packAnchor.y - contact.y * scale);
  // The visible art must land ENTIRELY inside the output canvas (transparent
  // margins may crop harmlessly — visible pixels may not).
  const artX0 = dx + bounds.x * scale;
  const artX1 = dx + (bounds.x + bounds.w - 1) * scale;
  const artY0 = dy + bounds.y * scale;
  const artY1 = dy + (bounds.y + bounds.h - 1) * scale;
  if (artX0 < -0.5 || artY0 < -0.5 || artX1 > packCanvas - 0.5 || artY1 > packCanvas - 0.5) {
    violations.push(violation('canvas.fit', `scaled visible art [${artX0.toFixed(1)},${artY0.toFixed(1)} .. ${artX1.toFixed(1)},${artY1.toFixed(1)}] does not fit the ${packCanvas}x${packCanvas} canvas (uniform scale ${scale.toFixed(4)})`));
    return { ok: false, violations };
  }

  // Render: inverse-map every output pixel through (scale, integer translate)
  // and premultiplied-bilinear sample the source. Output alpha>8 bounds and
  // the alpha>=128 shoe line are then RE-MEASURED on the result — the frame
  // is only accepted when it re-measures within the publish tolerances.
  const out = Buffer.alloc(packCanvas * packCanvas * 4);
  for (let y = 0; y < packCanvas; y += 1) {
    const sy = (y - dy) / scale;
    for (let x = 0; x < packCanvas; x += 1) {
      const sx = (x - dx) / scale;
      const [r, g, b, a] = samplePremultiplied(image, sx, sy);
      if (a === 0) continue;
      const o = (y * packCanvas + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  const outImage = { width: packCanvas, height: packCanvas, data: out };
  const outBounds = alphaBounds(outImage, BOUNDS_ALPHA_THRESHOLD);
  const outFoot = measureContact(outImage);
  if (!outBounds || !outFoot) {
    violations.push(violation('output.visible', 'the normalized output lost all visible pixels'));
    return { ok: false, violations };
  }
  if (Math.abs(outFoot.y - footLine) > FOOT_TOLERANCE_PX) {
    violations.push(violation('geometry.footLine', `normalized shoe line ${outFoot.y} is beyond ±${FOOT_TOLERANCE_PX}px of the target ${footLine}`));
  }
  if (Math.abs(outBounds.h - targetHeight) > HEIGHT_TOLERANCE_PX) {
    violations.push(violation('geometry.visibleHeight', `normalized visible height ${outBounds.h} is beyond ±${HEIGHT_TOLERANCE_PX}px of the target ${targetHeight}`));
  }
  if (violations.length > 0) return { ok: false, violations };

  const png = encodePng(out, packCanvas, packCanvas);
  const entry = {
    outputAnchor: { x: packAnchor.x, y: packAnchor.y },
    sourceAnchor: { x: contact.x, y: contact.y },
    sourceCanvas: { width: image.width, height: image.height },
    sourceScale: scale,
    // anchors.json convention: {x, y, width, height} (NOT the w/h of alphaBounds)
    visibleBounds: { x: outBounds.x, y: outBounds.y, width: outBounds.w, height: outBounds.h },
    detection: {
      contactRule: 'single-lowest-row-median',
      selectedRule: 'alpha128-body-bounds',
      scaleRule: 'uniform-height-match',
      translation: { dx, dy },
      sourceBounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
      note: 'M1 workbench import: uniform scale + integer translation, art untouched',
      verified: { footLine: outFoot.y, visibleHeight: outBounds.h, visibleWidth: outBounds.w },
    },
  };
  return {
    ok: true,
    png,
    entry,
    metrics: {
      footLine: outFoot.y,
      visibleHeight: outBounds.h,
      visibleWidth: outBounds.w,
      scale,
      translation: { dx, dy },
    },
  };
}

module.exports = {
  SHOE_ALPHA_THRESHOLD,
  BOUNDS_ALPHA_THRESHOLD,
  FOOT_TOLERANCE_PX,
  HEIGHT_TOLERANCE_PX,
  normalizeImportFrame,
  measureContact,
};
