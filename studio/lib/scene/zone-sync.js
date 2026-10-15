'use strict';

// studio/lib/scene/zone-sync.js — derive zones.obstacles from the CURRENT layout.
//
// The scene's walkability declaration and the layout are two files that can drift
// apart: move a desk in the editor and the old obstacle stays where the desk used
// to be (walkers avoid a phantom) while the new position is walkable (walkers walk
// through the desk). This module closes that loop the way §7B intends — 区域而非线条:
// the zones file keeps the author's INTENT (walkable region, regions, entries,
// radii) and its obstacles are DERIVED from the items' art boxes.
//
// It is a pure description: callers decide whether to write (the CLI `--write`,
// the panel button), and `changes` names exactly what would move.

const path = require('node:path');
const fs = require('node:fs');

const geometry = require('./geometry.js');
const zonesLib = require('./zones.js');

const OBSTACLE_ROLE = { desk: 'back', monitor: 'monitor', chair: 'chair' };

// One tolerance for "this obstacle still describes that item", shared with the
// validator (conflicts.js) so a scene can never be simultaneously in sync and
// reported as drifted.
const MATCH_TOLERANCE_PX = 8;
const SIZE_TOLERANCE_PX = 12;

function rectOf(item, { asset, draftWidths, scene }) {
  const box = geometry.artBoxPx(item, asset, draftWidths, scene);
  const normalized = geometry.toNormalizedRect(box, scene);
  return [
    Number(normalized.x.toFixed(6)),
    Number(normalized.y.toFixed(6)),
    Number(normalized.width.toFixed(6)),
    Number(normalized.height.toFixed(6)),
  ];
}

// Shape and ORDER mirror the committed content/scenes/flat/zones.json exactly:
// station furniture first (row-major desk ordinal, role order back → monitor →
// chair, `workstation` declared), then props in draft item order (workstation
// null). Round-tripping the approved scene therefore produces a byte-identical
// obstacles array — asserted by studio/test/scene.test.js.
function buildObstacles({ draft, assets, draftWidths, scene, stations }) {
  const ordered = [];
  const stationByItemId = new Map();
  const sortedStations = [...(stations || [])].sort((a, b) => (a.ordinal || 0) - (b.ordinal || 0));
  for (const station of sortedStations) {
    const ordinal = station.ordinal || Number(String(station.id).replace('station-', ''));
    for (const kind of ['desk', 'monitor', 'chair']) {
      const item = station[kind];
      if (!item) continue;
      stationByItemId.set(item.id, ordinal);
    }
  }
  for (const station of sortedStations) {
    const ordinal = station.ordinal || Number(String(station.id).replace('station-', ''));
    for (const kind of ['desk', 'monitor', 'chair']) {
      const item = station[kind];
      if (!item || item.hidden) continue;
      const asset = assets.get(item.asset);
      if (!asset) continue;
      ordered.push({
        id: `desk-${ordinal}-${OBSTACLE_ROLE[kind]}`,
        kind: 'rect',
        rect: rectOf(item, { asset, draftWidths, scene }),
        workstation: `desk-${ordinal}`,
      });
    }
  }
  for (const item of draft.items) {
    if (item.hidden || item.kind === 'character') continue;
    if (stationByItemId.has(item.id)) continue;
    const asset = assets.get(item.asset);
    if (!asset) continue;
    ordered.push({
      id: item.id,
      kind: 'rect',
      rect: rectOf(item, { asset, draftWidths, scene }),
      workstation: null,
    });
  }
  return ordered;
}

function rectsEqual(a, b, scene) {
  if (!a || !b || a.length !== b.length) return false;
  const px = [scene.width, scene.height, scene.width, scene.height];
  return a.every((value, index) => {
    const delta = Math.abs(value - b[index]) * px[index];
    // position within the matcher's tolerance, size within its size tolerance
    return delta <= (index < 2 ? MATCH_TOLERANCE_PX : SIZE_TOLERANCE_PX);
  });
}

// Keep the author's intent, replace the derived part.
function syncZones({ draft, zones, assets, draftWidths, scene, stations }) {
  const violations = zonesLib.validateZones(zones);
  if (violations.length > 0) return { ok: false, code: 'ZONES_INVALID', violations };
  const next = JSON.parse(JSON.stringify(zones));
  const derived = buildObstacles({ draft, assets, draftWidths, scene, stations });
  const before = new Map((zones.obstacles || []).map((obstacle) => [obstacle.id, obstacle.rect]));
  const after = new Map(derived.map((obstacle) => [obstacle.id, obstacle.rect]));
  const changes = { added: [], removed: [], moved: [], unchanged: [] };
  for (const [id, rect] of after) {
    if (!before.has(id)) changes.added.push(id);
    else if (!rectsEqual(before.get(id), rect, scene)) changes.moved.push(id);
    else changes.unchanged.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) changes.removed.push(id);
  next.obstacles = derived;
  return {
    ok: true,
    exact: changes.added.length === 0 && changes.removed.length === 0 && changes.moved.length === 0,
    zones: next,
    changes,
  };
}

function zonesFileFor(contentDir, sceneId) {
  return zonesLib.zonesFileFor(contentDir, sceneId);
}

// Write form: refuses to write when nothing changed (无变更不落盘), backs the
// previous file up next to the project's build area first.
function applyZonesSync({ contentDir, sceneId, zones, backupRoot }) {
  const file = zonesFileFor(contentDir, sceneId);
  const existed = fs.existsSync(file);
  if (existed) {
    const raw = fs.readFileSync(file, 'utf8');
    const current = JSON.parse(raw);
    if (JSON.stringify(current.obstacles || []) === JSON.stringify(zones.obstacles || [])) {
      return { ok: true, noop: true, file, backup: null };
    }
    if (backupRoot) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(backupRoot, `${stamp}-${sceneId}-zones.json`);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.writeFileSync(backupFile, raw);
      fs.writeFileSync(file, `${JSON.stringify(zones, null, 2)}\n`);
      return { ok: true, noop: false, file, backup: backupFile };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(zones, null, 2)}\n`);
  return { ok: true, noop: false, file, backup: null };
}

module.exports = {
  MATCH_TOLERANCE_PX,
  OBSTACLE_ROLE,
  SIZE_TOLERANCE_PX,
  applyZonesSync,
  buildObstacles,
  rectOf,
  syncZones,
  zonesFileFor,
};
