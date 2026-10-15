'use strict';

// studio/lib/scene/geometry.js — the rect/point math the scene tools share.
//
// The two PROJECTION rules below are copied verbatim from the runtime compiler
// (src/office/runtime/office-layout-compiler.js artBoxPx / characterFootPx) on
// purpose: 工作台算出来的冲突必须与进程序一致 — a studio that invents its own
// geometry would validate a scene the runtime does not agree with. The
// foot-point rule is additionally cross-checked against the compiled flat
// fixture in studio/test/scene.test.js (exact equality with the desk node
// positions), so drift is caught mechanically.

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function rectOverlapArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function pointRectDistancePx(point, rect) {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.sqrt(dx * dx + dy * dy);
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// == office-layout-compiler.js artBoxPx (same formula, same defaults)
function artBoxPx(item, asset, draftWidths, scene) {
  const boxW = (draftWidths[item.kind] || 100) * item.scale;
  const bbox = (asset && asset.contentBbox) || { x: 0, y: 0, w: 1, h: 1 };
  const boxH = boxW * (bbox.h / bbox.w);
  return {
    x: item.position.x * scene.width - boxW / 2,
    y: item.position.y * scene.height - boxH / 2,
    width: boxW,
    height: boxH,
  };
}

// The character item is drawn on the pack's square canvas, so its art box is
// square; the calibrated foot point sits at CHARACTER_FOOT_RATIO inside it.
function characterBoxPx(item, draftWidths, scene) {
  const boxW = (draftWidths[item.kind] || 96) * item.scale;
  return {
    x: item.position.x * scene.width - boxW / 2,
    y: item.position.y * scene.height - boxW / 2,
    width: boxW,
    height: boxW,
  };
}

function characterFootPx(item, draftWidths, scene, footRatio) {
  const box = characterBoxPx(item, draftWidths, scene);
  return {
    x: box.x + footRatio.x * box.width,
    y: box.y + footRatio.y * box.height,
    box,
  };
}

function toNormalizedRect(rectPx, scene) {
  return {
    x: rectPx.x / scene.width,
    y: rectPx.y / scene.height,
    width: rectPx.width / scene.width,
    height: rectPx.height / scene.height,
  };
}

function fromNormalizedRect(rect, scene) {
  return {
    x: rect.x * scene.width,
    y: rect.y * scene.height,
    width: rect.width * scene.width,
    height: rect.height * scene.height,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  artBoxPx,
  centerOf,
  characterBoxPx,
  characterFootPx,
  distance,
  fromNormalizedRect,
  lerpPoint,
  pointRectDistancePx,
  rectOverlapArea,
  rectsOverlap,
  round2,
  toNormalizedRect,
};
