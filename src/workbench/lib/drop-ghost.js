'use strict';

// src/workbench/lib/drop-ghost.js — where a dropped furniture item would land,
// in the scene's own pixels (workbench UX rectification, gap #5: 拖拽落点预览).
//
// A furniture drop used to be a leap of faith: you dragged, you let go, and only
// THEN did the validator tell you the placement was refused. The ghost closes
// that gap — a semi-transparent copy of the art at the exact box the transaction
// would give it, so the eye can judge the landing before the hand commits.
//
// The maths is the transaction's own (studio/lib/scene/geometry.js artBoxPx):
// the box is `draftWidth * scale` wide and `draftWidth * scale * bbox.h/bbox.w`
// tall, centred on the item's position. The catalog is the single source for
// both numbers — this module takes them as arguments and never re-declares them,
// so there is nothing here to drift from the product's.

// The scene's logical size. A missing one is a programming error at the call
// site, not something to guess at here — but dividing by zero would draw the
// ghost at NaN, so the fallback is the flat scene's size.
// (Named for THIS module: app/compare.js declares its own SCENE_FALLBACK, and
// two classic scripts sharing one global scope make a second `const` of the
// same name a SyntaxError that kills the whole file.)
const DROP_SCENE_FALLBACK = Object.freeze({ width: 1280, height: 840 });

// `draftWidth` is the catalog's per-kind shelf width in SCENE-REFERENCE pixels
// (the 1280-wide logical scene), `bbox` the asset's normalized content box
// ({x, y, w, h} inside the PNG), `position` the normalized 0..1 drop point.
function ghostBoxFor({ draftWidth, bbox = null, position, scale = 1, scene } = {}) {
  // a missing draft width is NOT zero (Number(null) is 0): it falls back to the
  // prop shelf width, the widest common case in the catalog
  const rawWidth = draftWidth === null || draftWidth === undefined || draftWidth === '' ? NaN : Number(draftWidth);
  const scaleFactor = Number.isFinite(Number(scale)) ? Number(scale) : 1;
  const width = Math.max(1, (Number.isFinite(rawWidth) ? rawWidth : 120) * scaleFactor);
  const bboxW = bbox && Number(bbox.w) > 0 ? Number(bbox.w) : 1;
  const bboxH = bbox && Number(bbox.h) >= 0 ? Number(bbox.h) : 1;
  const height = Math.max(1, width * (bboxH / bboxW));
  const size = scene && Number(scene.width) > 0 ? scene : DROP_SCENE_FALLBACK;
  const px = Number(position && position.x) || 0;
  const py = Number(position && position.y) || 0;
  return {
    x: px * size.width - width / 2,
    y: py * size.height - height / 2,
    width,
    height,
  };
}

const wbDropGhostApi = { SCENE_FALLBACK: DROP_SCENE_FALLBACK, ghostBoxFor };
// dual module (the house pattern, see i18n.js): require()-able from Node AND
// loadable as a classic script in the page.
if (typeof window !== 'undefined') window.wbDropGhost = wbDropGhostApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbDropGhostApi;
