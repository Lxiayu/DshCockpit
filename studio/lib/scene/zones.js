'use strict';

// studio/lib/scene/zones.js — the walkability model (brief §7B: 区域而非线条).
//
// A scene declares where walking is allowed (walkable rects) and what stands in
// the way (obstacles with a mover radius). The navigation graph is DERIVED from
// that declaration (see ./waypoints.js) — the studio deliberately offers no
// hand-drawn polylines, because a hand-drawn path is not a source of truth.
//
// Everything here works in NORMALIZED scene coordinates [0,1]; the only pixel
// values are clearances (mover radius, aisle width), because those describe the
// character's body, not the scene.

const path = require('node:path');
const fs = require('node:fs');

const { pointRectDistancePx, fromNormalizedRect } = require('./geometry.js');

const DEFAULT_AISLE_WIDTH = 0.06;
const DEFAULT_MOVER_RADIUS = 0.02;
const DEFAULT_SAMPLE_STEP = 0.005;

function zonesFileFor(contentDir, sceneId) {
  return path.join(contentDir, 'scenes', sceneId, 'zones.json');
}

function loadZones({ contentDir, sceneId }) {
  const file = zonesFileFor(contentDir, sceneId);
  let zones;
  try {
    zones = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, code: error.code === 'ENOENT' ? 'ZONES_MISSING' : 'ZONES_UNPARSEABLE', file, message: error.message };
  }
  const violations = validateZones(zones);
  if (violations.length > 0) return { ok: false, code: 'ZONES_INVALID', file, zones, violations };
  return { ok: true, code: null, file, sceneId, zones, model: buildModel(zones) };
}

function validateZones(zones) {
  const violations = [];
  const push = (check, detail) => violations.push({ check, detail });
  if (!zones || typeof zones !== 'object' || Array.isArray(zones)) {
    return [{ check: 'zones.shape', detail: 'zones.json must be a JSON object' }];
  }
  if (zones.schemaVersion !== 1) push('zones.schemaVersion', `expected 1, got ${JSON.stringify(zones.schemaVersion)}`);
  if (typeof zones.scene !== 'string' || !zones.scene) push('zones.scene', 'scene id is required');
  const rectCheck = (entry, index, list) => {
    const rect = entry && entry.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || rect.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      push(`zones.${list}[${index}].rect`, 'rect must be [x, y, w, h] numbers');
      return;
    }
    const [x, y, w, h] = rect;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0000001 || y + h > 1.0000001) {
      push(`zones.${list}[${index}].rect`, `rect must stay inside the scene: [${rect.join(', ')}]`);
    }
  };
  if (!Array.isArray(zones.walkable) || zones.walkable.length === 0) push('zones.walkable', 'at least one walkable region is required');
  else zones.walkable.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') push(`zones.walkable[${index}]`, 'entry must be an object');
    else {
      if (entry.kind !== 'rect') push(`zones.walkable[${index}].kind`, 'only rect regions are supported');
      rectCheck(entry, index, 'walkable');
    }
  });
  if (zones.obstacles !== undefined) {
    if (!Array.isArray(zones.obstacles)) push('zones.obstacles', 'must be an array');
    else zones.obstacles.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') push(`zones.obstacles[${index}]`, 'entry must be an object');
      else {
        if (typeof entry.id !== 'string' || !entry.id) push(`zones.obstacles[${index}].id`, 'obstacle id is required');
        if (entry.kind !== 'rect') push(`zones.obstacles[${index}].kind`, 'only rect obstacles are supported');
        rectCheck(entry, index, 'obstacles');
        if (entry.radius !== undefined && !(typeof entry.radius === 'number' && entry.radius >= 0)) {
          push(`zones.obstacles[${index}].radius`, 'radius must be a non-negative number');
        }
      }
    });
  }
  return violations;
}

// The runtime's fixture obstacles are normalized rects; the studio keeps the
// same shape and adds the declared per-obstacle radius when present.
function buildModel(zones) {
  const walkable = (zones.walkable || []).map((entry) => ({
    kind: entry.kind,
    rect: { x: entry.rect[0], y: entry.rect[1], width: entry.rect[2], height: entry.rect[3] },
    label: entry.label || null,
  }));
  const obstacles = (zones.obstacles || []).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    rect: { x: entry.rect[0], y: entry.rect[1], width: entry.rect[2], height: entry.rect[3] },
    radius: typeof entry.radius === 'number' ? entry.radius : null,
    workstation: entry.workstation || null,
    label: entry.label || null,
  }));
  const graph = zones.graph || {};
  const validation = zones.validation || {};
  return {
    walkable,
    obstacles,
    regions: Array.isArray(zones.regions) ? zones.regions.map((entry) => ({
      id: entry.id,
      label: entry.label || 'roaming',
      rect: { x: entry.rect[0], y: entry.rect[1], width: entry.rect[2], height: entry.rect[3] },
    })) : [],
    entries: Array.isArray(zones.entries) ? zones.entries.map((entry, index) => ({
      id: entry.id || `entry-${index + 1}`,
      point: { x: entry.at[0], y: entry.at[1] },
      label: entry.label || null,
    })) : [],
    aisleWidth: typeof graph.aisleWidth === 'number' ? graph.aisleWidth : DEFAULT_AISLE_WIDTH,
    derive: graph.derive || 'auto',
    sampleStep: typeof validation.sampleStep === 'number' ? validation.sampleStep : DEFAULT_SAMPLE_STEP,
    moverRadius: typeof validation.moverRadius === 'number' ? validation.moverRadius : DEFAULT_MOVER_RADIUS,
    exemptSameStation: validation.exemptSameStation !== false,
  };
}

function walkableBounds(model) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const region of model.walkable) {
    minX = Math.min(minX, region.rect.x);
    minY = Math.min(minY, region.rect.y);
    maxX = Math.max(maxX, region.rect.x + region.rect.width);
    maxY = Math.max(maxY, region.rect.y + region.rect.height);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function inWalkable(model, point) {
  return model.walkable.some((region) => (
    point.x >= region.rect.x && point.x <= region.rect.x + region.rect.width
    && point.y >= region.rect.y && point.y <= region.rect.y + region.rect.height
  ));
}

// Distance from a normalized point to the nearest obstacle edge, in PIXELS.
function clearancePx(model, point, scene) {
  const px = { x: point.x * scene.width, y: point.y * scene.height };
  let best = Infinity;
  for (const obstacle of model.obstacles) {
    const rectPx = fromNormalizedRect(obstacle.rect, scene);
    const distance = pointRectDistancePx(px, rectPx);
    const required = (obstacle.radius || 0) * Math.min(scene.width, scene.height);
    best = Math.min(best, distance - required);
  }
  return best;
}

// A point is free when it is inside the walkable region AND clear of every
// obstacle by at least the mover radius (plus the obstacle's own radius).
function isFree(model, point, scene) {
  if (!inWalkable(model, point)) return false;
  const radiusPx = model.moverRadius * Math.min(scene.width, scene.height);
  return clearancePx(model, point, scene) >= radiusPx;
}

function segmentFree(model, from, to, scene, samples = 24) {
  for (let step = 0; step <= samples; step += 1) {
    const t = step / samples;
    const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    if (!isFree(model, point, scene)) return false;
  }
  return true;
}

// Label precedence: a declared region wins, then the workstation area (a desk's
// art box DILATED by the aisle width — a free cell can never be inside the desk
// itself, since the desk is an obstacle; "at the desk" means standing beside it),
// then the roaming default.
function labelOfPoint(model, point, options = {}) {
  for (const region of model.regions) {
    const { rect } = region;
    if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) return region.label;
  }
  const margin = typeof options.workMargin === 'number' ? options.workMargin : model.aisleWidth;
  if (options.workRects && options.workRects.some((rect) => (
    point.x >= rect.x - margin && point.x <= rect.x + rect.width + margin
    && point.y >= rect.y - margin && point.y <= rect.y + rect.height + margin
  ))) return 'work';
  return 'roaming';
}

module.exports = {
  DEFAULT_AISLE_WIDTH,
  DEFAULT_MOVER_RADIUS,
  DEFAULT_SAMPLE_STEP,
  buildModel,
  clearancePx,
  inWalkable,
  isFree,
  labelOfPoint,
  loadZones,
  segmentFree,
  validateZones,
  walkableBounds,
  zonesFileFor,
};
