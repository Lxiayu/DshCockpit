'use strict';

// studio/lib/scene/conflicts.js — the scene conflict validator (brief §7B).
//
// This is the "被拦住" gate: the classes below are the defects this project has
// actually shipped and then repaired, checked mechanically before a scene may be
// exported or published:
//
//   SCENE_DRAFT_INVALID             the draft does not satisfy schema v1
//   SCENE_WORKSTATION_INCOMPLETE    a workstation is missing desk/monitor/character/chair
//   SCENE_WORKSTATION_FLOATING      工作位悬空 — the seat is outside the walkable
//                                   region, stands inside FOREIGN furniture, is not
//                                   backed by its own desk, or has no free cell near it
//   SCENE_WORKSTATION_UNREACHABLE   the seat's cell cannot reach any entry
//   SCENE_FURNITURE_OVERLAP         家具重叠 — art boxes of DIFFERENT stations overlap
//                                   (a station's own desk/monitor/chair/character stack
//                                    is intentional: desk < monitor < character < chair)
//   SCENE_ENTRY_BLOCKED             入口被堵 — a declared entry stands in furniture or
//                                   has no way out; a derived entry is isolated
//   SCENE_EDGE_BLOCKED              a derived edge passes through a DECLARED obstacle
//                                   (sampled by the RUNTIME's own sampleEdgeConflicts)
//   SCENE_OBSTACLE_UNDECLARED       yellow — an item is not covered by any declared
//                                   obstacle, so walkers do not avoid it
//   SCENE_ITEM_OUT_OF_BOUNDS        yellow — an art box leaves the logical scene
//   SCENE_ZONES_SPLIT               yellow — the free space forms several components
//
// Two semantics are deliberately RUNTIME-consistent:
//   * workstations are derived by POSITION (desks are the stations; the nearest
//     character/monitor/chair are claimed), because the real drafts link desks and
//     their furniture by position, not by groupId — the compiler assigns them the
//     same way (office-layout-compiler.js buildWorkstationGroups);
//   * the edge check calls the runtime's sampleEdgeConflicts, so clearance is the
//     runtime's rule and not a studio invention.

const path = require('node:path');

const geometry = require('./geometry.js');
const zoneSyncLib = require('./zone-sync.js');
const { inWalkable, isFree, clearancePx } = require('./zones.js');
const { deriveWaypoints, nearestNode, reachableFrom, connectedComponents } = require('./waypoints.js');

// A seat must be backed by its own desk: the foot point has to sit within this
// distance of the station's desk art box (normalized to the scene's shorter side).
// The same radius governs station membership: real stations claim their
// character/monitor/chair at 44–80px (measured), stations sit ~340px apart — so
// 0.14 · 840 = 118px claims the right furniture and REFUSES to adopt a neighbour's
// (which is what makes a dragged-away character report as floating instead of
// silently re-pairing the stations).
const SUPPORT_RADIUS_RATIO = 0.14;
// How far a seat may sit from the nearest free cell.
const SEAT_REACH_RATIO = 0.06;
// Inter-station penetration smaller than this is drawing overlap, not a defect.
const OVERLAP_TOLERANCE_PX2 = 25; // 5×5 px
const WORKSTATION_KINDS = ['desk', 'monitor', 'character', 'chair'];
// office-layout-compiler.js MOVER_RADIUS_RATIO: the radius the product assumes.
const RUNTIME_DEFAULT_MOVER_RADIUS = 0.04;

function runtimeCompiler(repoRoot) {
  return require(path.join(repoRoot, 'src', 'office', 'runtime', 'office-layout-compiler.js'));
}

function itemBox(item, asset, draftWidths, scene) {
  if (!asset) return null;
  return item.kind === 'character'
    ? geometry.characterBoxPx(item, draftWidths, scene)
    : geometry.artBoxPx(item, asset, draftWidths, scene);
}

function boxesFor(draft, { assets, draftWidths, scene }) {
  return draft.items
    .filter((item) => !item.hidden)
    .map((item) => ({ item, asset: assets.get(item.asset) || null, box: itemBox(item, assets.get(item.asset), draftWidths, scene) }));
}

function distanceToBox(pointPx, boxPx) {
  return geometry.pointRectDistancePx(pointPx, boxPx);
}

// Workstations derived by position: every desk is a station; each of the other
// workstation kinds is claimed once, nearest desk first (the runtime's groups are
// assigned the same way).
// The committed `desk-N` vocabulary is ROW-MAJOR (desk-1..desk-6 read left-to-right,
// top-to-bottom in the compiled fixture), while the draft's item order is arbitrary.
// Naming stations after their row-major ordinal keeps derived obstacle ids equal to
// the committed ones — which is what makes a zone re-sync idempotent.
function assignStationOrdinals(desks, scene) {
  const withCenter = desks.map((desk) => {
    const position = desk.position;
    return { desk, x: position.x * scene.width, y: position.y * scene.height };
  });
  const rows = new Map();
  for (const entry of withCenter) {
    const key = Math.round(entry.y / 24); // 24px row bands: desks within one row share a band
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(entry);
  }
  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0])
    .flatMap(([, list]) => list.sort((a, b) => a.x - b.x))
    .map((entry) => entry.desk);
  const ordinalByDeskId = new Map(ordered.map((desk, index) => [desk.id, index + 1]));
  return ordinalByDeskId;
}

function deriveStations(items, { assets, draftWidths, scene, characterFootRatio, maxClaimPx = null }) {
  const claimLimit = typeof maxClaimPx === 'number'
    ? maxClaimPx
    : SUPPORT_RADIUS_RATIO * Math.min(scene.width, scene.height);
  const desks = items.filter((item) => item.kind === 'desk');
  const ordinalByDeskId = assignStationOrdinals(desks, scene);
  const stations = desks.map((desk) => ({
    id: `station-${ordinalByDeskId.get(desk.id)}`,
    ordinal: ordinalByDeskId.get(desk.id),
    desk,
    monitor: null,
    character: null,
    chair: null,
    members: [desk],
  }));
  const deskBox = (station) => {
    const asset = assets.get(station.desk.asset);
    return asset ? geometry.artBoxPx(station.desk, asset, draftWidths, scene) : null;
  };
  for (const kind of ['character', 'monitor', 'chair']) {
    const candidates = items.filter((item) => item.kind === kind);
    const taken = new Set();
    for (const station of stations) {
      const deskArt = deskBox(station);
      if (!deskArt) continue;
      const deskCenter = geometry.centerOf(deskArt);
      let best = null;
      let bestDistance = Infinity;
      for (const candidate of candidates) {
        if (taken.has(candidate.id)) continue;
        const asset = assets.get(candidate.asset);
        if (!asset) continue;
        const box = itemBox(candidate, asset, draftWidths, scene);
        const reference = kind === 'character' && characterFootRatio
          ? (() => { const foot = geometry.characterFootPx(candidate, draftWidths, scene, characterFootRatio); return { x: foot.x, y: foot.y }; })()
          : geometry.centerOf(box);
        const distance = geometry.distance(reference, deskCenter);
        if (distance > claimLimit) continue;
        if (distance < bestDistance) { bestDistance = distance; best = candidate; }
      }
      if (best) { taken.add(best.id); station[kind] = best; station.members.push(best); }
    }
  }
  return stations;
}

function validateScene({
  repoRoot,
  draft,
  model,
  scene,
  assets,
  draftWidths,
  characterFootRatio,
  schemaValidator,
}) {
  const violations = [];
  const push = (code, severity, message, detail = {}) => violations.push({ code, severity, message, ...detail });
  const short = Math.min(scene.width, scene.height);
  const supportRadiusPx = SUPPORT_RADIUS_RATIO * short;
  const seatReachPx = SEAT_REACH_RATIO * short;

  const schema = schemaValidator ? schemaValidator(draft) : { ok: true, count: (draft.items || []).length };
  if (!schema.ok) {
    push('SCENE_DRAFT_INVALID', 'red', `draft rejected by the schema validator (${schema.code})`, { detail: { code: schema.code } });
    return { ok: false, violations, stats: null, graph: null, edgeConflicts: [] };
  }

  const items = draft.items.filter((item) => !item.hidden);
  const boxes = boxesFor(draft, { assets, draftWidths, scene });
  const boxById = new Map(boxes.map((entry) => [entry.item.id, entry.box]));
  const stations = deriveStations(items, { assets, draftWidths, scene, characterFootRatio });
  const stationByItemId = new Map();
  const stationCenters = new Map();
  for (const station of stations) {
    for (const member of station.members) stationByItemId.set(member.id, station.id);
    const deskBox = boxById.get(station.desk.id);
    if (deskBox) stationCenters.set(station.id, geometry.centerOf(deskBox));
  }
  // Obstacle ids come in two vocabularies: workstation furniture is `desk-N-back`
  // (optionally with a declared `workstation` field) and props carry their draft
  // id. Only declared WORKSTATION furniture can belong to a station; a prop is
  // nobody's furniture, so a prop standing on a seat is a real defect (which is
  // how a dropped object is caught). Station furniture is matched to a station by
  // position, because the `desk-N` vocabulary predates the derived indices.
  const isStationFurnitureId = (obstacle) => Boolean(obstacle.workstation) || /^desk-\d+-(back|monitor|chair)$/.test(String(obstacle.id));
  const stationOfObstacle = (obstacle) => {
    if (stationByItemId.has(obstacle.id)) return stationByItemId.get(obstacle.id);
    if (!isStationFurnitureId(obstacle)) return null;
    const center = geometry.centerOf(geometry.fromNormalizedRect(obstacle.rect, scene));
    let best = null;
    let bestDistance = Infinity;
    for (const [id, deskCenter] of stationCenters) {
      const distance = geometry.distance(center, deskCenter);
      if (distance < bestDistance) { bestDistance = distance; best = id; }
    }
    return best;
  };

  // ---- completeness ----------------------------------------------------------
  for (const station of stations) {
    const missing = ['monitor', 'character', 'chair'].filter((kind) => !station[kind]);
    if (missing.length > 0) {
      push('SCENE_WORKSTATION_INCOMPLETE', 'red', `workstation at desk ${station.desk.id} is missing ${missing.join('/')}`, {
        groupId: station.id, itemId: station.desk.id, detail: { missing },
      });
    }
  }

  // ---- orphaned workstation furniture (工作位悬空) ------------------------------
  // Anything of a workstation kind that no desk can claim stands outside every
  // workstation: the desk was moved away, or the item was dragged into the open.
  for (const item of items) {
    if (!['character', 'monitor', 'chair'].includes(item.kind)) continue;
    if (stationByItemId.has(item.id)) continue;
    const box = boxById.get(item.id);
    const reference = item.kind === 'character' && characterFootRatio && box
      ? geometry.characterFootPx(item, draftWidths, scene, characterFootRatio)
      : (box ? geometry.centerOf(box) : null);
    let nearest = null;
    let nearestDistance = Infinity;
    if (reference) {
      for (const [id, deskCenter] of stationCenters) {
        const distance = geometry.distance({ x: reference.x, y: reference.y }, deskCenter);
        if (distance < nearestDistance) { nearestDistance = distance; nearest = id; }
      }
    }
    push('SCENE_WORKSTATION_FLOATING', 'red',
      item.kind === 'character'
        ? `character ${item.id} stands outside every workstation (nearest desk ${nearest || '-'} at ${Number.isFinite(nearestDistance) ? nearestDistance.toFixed(0) : '?'}px; a seat must be within ${supportRadiusPx.toFixed(0)}px)`
        : `${item.kind} ${item.id} belongs to no workstation (nearest desk ${nearest || '-'} at ${Number.isFinite(nearestDistance) ? nearestDistance.toFixed(0) : '?'}px)`,
      { itemId: item.id, detail: { kind: item.kind, nearest, distancePx: Number.isFinite(nearestDistance) ? Number(nearestDistance.toFixed(1)) : null, claimRadiusPx: Number(supportRadiusPx.toFixed(1)) } });
  }

  // ---- the derived graph -----------------------------------------------------
  const workRects = stations.map((station) => boxById.get(station.desk.id)).filter(Boolean)
    .map((box) => geometry.toNormalizedRect(box, scene));
  const graph = deriveWaypoints({ model, scene, workRects });
  if (!graph.ok) push('SCENE_ZONES_EMPTY', 'red', 'the walkable region yields no free cells — nothing can walk', { detail: { code: graph.code } });

  // ---- 工作位悬空 -------------------------------------------------------------
  const seats = [];
  for (const station of stations) {
    if (!station.character) continue;
    const foot = geometry.characterFootPx(station.character, draftWidths, scene, characterFootRatio);
    const footPoint = { x: foot.x / scene.width, y: foot.y / scene.height };
    const seat = { stationId: station.id, itemId: station.character.id, point: footPoint, footPx: { x: foot.x, y: foot.y } };
    seats.push(seat);

    if (!inWalkable(model, footPoint)) {
      push('SCENE_WORKSTATION_FLOATING', 'red', `workstation ${station.id}: the seat foot point is outside the walkable region`, {
        groupId: station.id, itemId: station.character.id, detail: { point: footPoint },
      });
      continue;
    }

    // Occupancy is GEOMETRY, not declaration: the seat is judged against the other
    // items' current art boxes (a prop dropped on a seat must be caught even when
    // the zones file was not updated).
    const foreignBoxes = boxes.filter((entry) => (
      entry.box && entry.item.kind !== 'character'
      && stationByItemId.get(entry.item.id) !== station.id
    ));
    const radiusPx = model.moverRadius * short;
    const footPxPoint = { x: foot.x, y: foot.y };
    let nearestForeign = null;
    let nearestDistance = Infinity;
    for (const entry of foreignBoxes) {
      const distance = distanceToBox(footPxPoint, entry.box);
      if (distance < nearestDistance) { nearestDistance = distance; nearestForeign = entry.item.id; }
    }
    if (nearestDistance < radiusPx) {
      push('SCENE_WORKSTATION_FLOATING', 'red',
        nearestDistance <= 0
          ? `workstation ${station.id}: the seat foot point stands inside foreign furniture (${nearestForeign})`
          : `workstation ${station.id}: the seat is only ${nearestDistance.toFixed(1)}px from foreign furniture (${nearestForeign}); needs ${radiusPx.toFixed(1)}px`,
        {
          groupId: station.id,
          itemId: station.character.id,
          detail: {
            point: footPoint,
            clearancePx: Number(nearestDistance.toFixed(2)),
            needsPx: Number(radiusPx.toFixed(2)),
            nearest: nearestForeign,
          },
        });
      continue;
    }

    // supported by its own desk?
    const deskBoxPx = boxById.get(station.desk.id);
    if (deskBoxPx) {
      const support = distanceToBox({ x: foot.x, y: foot.y }, deskBoxPx);
      if (support > supportRadiusPx) {
        push('SCENE_WORKSTATION_FLOATING', 'red',
          `workstation ${station.id}: the seat is ${support.toFixed(0)}px away from its desk — the work position floats`,
          { groupId: station.id, itemId: station.character.id, detail: { point: footPoint, supportDistancePx: Number(support.toFixed(1)), supportRadiusPx: Number(supportRadiusPx.toFixed(1)) } });
        continue;
      }
    }

    // near a free cell, and that cell must reach an entry
    const nearest = nearestNode(graph.nodes, footPoint);
    if (!nearest || geometry.distance(nearest.position, footPoint) > seatReachPx) {
      push('SCENE_WORKSTATION_FLOATING', 'red',
        `workstation ${station.id}: no free cell within ${seatReachPx.toFixed(0)}px of the seat`,
        { groupId: station.id, itemId: station.character.id, detail: { point: footPoint, nearest: nearest ? nearest.id : null } });
      continue;
    }
    seat.node = nearest.id;
    const entryNodes = graph.entries.map((entry) => entry.node).filter(Boolean);
    if (entryNodes.length > 0 && !reachableFrom(graph.nodes, graph.edges, entryNodes).has(nearest.id)) {
      push('SCENE_WORKSTATION_UNREACHABLE', 'red',
        `workstation ${station.id}: the seat cell ${nearest.id} cannot reach any entry`,
        { groupId: station.id, itemId: station.character.id, detail: { node: nearest.id } });
    }
  }

  // ---- 家具重叠（跨工位/道具） ---------------------------------------------------
  for (let a = 0; a < boxes.length; a += 1) {
    for (let b = a + 1; b < boxes.length; b += 1) {
      const first = boxes[a];
      const second = boxes[b];
      if (!first.box || !second.box) continue;
      const firstStation = stationByItemId.get(first.item.id);
      const secondStation = stationByItemId.get(second.item.id);
      // same station: the desk/monitor/character/chair stack is intentional
      if (firstStation && firstStation === secondStation) continue;
      const area = geometry.rectOverlapArea(first.box, second.box);
      if (area > OVERLAP_TOLERANCE_PX2) {
        // A prop standing ON another prop (a rice bowl on the island counter, a
        // plant on the table) is a composition, not a defect — it is reported for
        // review. Two workstations whose furniture collides is the defect class
        // this project actually shipped (cross-station clipping), so that one blocks.
        const severity = firstStation && secondStation && firstStation !== secondStation ? 'red' : 'yellow';
        push('SCENE_FURNITURE_OVERLAP', severity,
          `${first.item.id} (${first.item.asset}) overlaps ${second.item.id} (${second.item.asset}) by ${Math.round(area)} px²`,
          {
            itemId: first.item.id,
            detail: {
              with: second.item.id,
              areaPx2: Math.round(area),
              stations: [firstStation || null, secondStation || null],
              tolerancePx2: OVERLAP_TOLERANCE_PX2,
            },
          });
      }
    }
  }

  // ---- 入口被堵 ---------------------------------------------------------------
  for (const entry of graph.entries) {
    if (entry.blocked) {
      push('SCENE_ENTRY_BLOCKED', 'red', `entry ${entry.id} stands in furniture`, { detail: { entryId: entry.id, at: entry.at } });
      continue;
    }
    if (!entry.node) {
      push('SCENE_ENTRY_BLOCKED', 'red', `entry ${entry.id} has no free cell — it is walled off`, { detail: { entryId: entry.id, at: entry.at } });
      continue;
    }
    const degree = graph.edges.filter((edge) => edge.from === entry.node || edge.to === entry.node).length;
    if (degree === 0) {
      push('SCENE_ENTRY_BLOCKED', 'red', `entry ${entry.id} is isolated: cell ${entry.node} has no way out`, { detail: { entryId: entry.id, node: entry.node } });
    }
  }

  // ---- 画布越界 + 障碍未声明（黄） -------------------------------------------------
  for (const { item, asset, box } of boxes) {
    if (!box) {
      push('SCENE_ITEM_ASSET_UNKNOWN', 'red', `${item.id} references unknown asset ${item.asset}`, { itemId: item.id, detail: { asset: item.asset } });
      continue;
    }
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.width > scene.width + 0.5 || box.y + box.height > scene.height + 0.5) {
      push('SCENE_ITEM_OUT_OF_BOUNDS', 'yellow', `${item.id} (${item.asset}) leaves the logical scene`, {
        itemId: item.id,
        detail: { box: { x: Number(box.x.toFixed(1)), y: Number(box.y.toFixed(1)), w: Number(box.width.toFixed(1)), h: Number(box.height.toFixed(1)) } },
      });
    }
  }

  // Obstacle <-> item correspondence is matched BY GEOMETRY (the id vocabularies
  // differ: station furniture is `desk-N-*`, props keep their draft id). The
  // approved scene matches 32/32 exactly, so both directions are hard gates:
  //   * furniture with no obstacle  -> walkers walk through it   (red)
  //   * an obstacle with no item    -> walkers avoid a phantom   (red)
  // The fix path is one command: rebuild the obstacles from the current layout
  // (scene/zone-sync.js, surfaced as 重建障碍 in the panel and the CLI).
  const MATCH_TOLERANCE_PX = zoneSyncLib.MATCH_TOLERANCE_PX;
  const SIZE_TOLERANCE_PX = zoneSyncLib.SIZE_TOLERANCE_PX;
  const furniture = boxes.filter((entry) => entry.box && entry.item.kind !== 'character');
  const declared = model.obstacles.map((obstacle) => {
    const box = geometry.fromNormalizedRect(obstacle.rect, scene);
    return { obstacle, box, center: geometry.centerOf(box) };
  });
  const claimedObstacles = new Set();
  const undeclared = [];
  for (const entry of furniture) {
    const center = geometry.centerOf(entry.box);
    let best = null;
    for (const candidate of declared) {
      const distance = geometry.distance(center, candidate.center);
      if (!best || distance < best.distance) best = { distance, candidate };
    }
    const matched = best
      && best.distance <= MATCH_TOLERANCE_PX
      && Math.abs(entry.box.width - best.candidate.box.width) <= SIZE_TOLERANCE_PX
      && Math.abs(entry.box.height - best.candidate.box.height) <= SIZE_TOLERANCE_PX;
    if (matched) claimedObstacles.add(best.candidate.obstacle.id);
    else undeclared.push({ itemId: entry.item.id, asset: entry.item.asset, nearestObstacle: best ? best.candidate.obstacle.id : null, offsetPx: best ? Number(best.distance.toFixed(1)) : null });
  }
  for (const entry of undeclared) {
    push('SCENE_OBSTACLE_UNDECLARED', 'red',
      `${entry.itemId} (${entry.asset}) has no declared obstacle at its current position — walkers would walk through it`,
      { itemId: entry.itemId, detail: { nearestObstacle: entry.nearestObstacle, offsetPx: entry.offsetPx, fix: 'rebuild obstacles from the layout' } });
  }
  const staleObstacles = declared.filter((entry) => !claimedObstacles.has(entry.obstacle.id));
  for (const entry of staleObstacles) {
    push('SCENE_OBSTACLE_STALE', 'red',
      `obstacle ${entry.obstacle.id} matches no item at its position — walkers would avoid a phantom`,
      { detail: { obstacleId: entry.obstacle.id, rect: entry.obstacle.rect, fix: 'rebuild obstacles from the layout' } });
  }

  // ---- 连通性 ----------------------------------------------------------------
  const components = graph.ok ? connectedComponents(graph.nodes, graph.edges) : [];
  if (components.length > 1) {
    const sizes = components.map((component) => component.length).sort((a, b) => b - a);
    push('SCENE_ZONES_SPLIT', 'yellow',
      `the free space forms ${components.length} components (largest ${sizes[0]}, smallest ${sizes[sizes.length - 1]}) — check for sealed aisles`,
      { detail: { componentSizes: sizes.slice(0, 8), largest: sizes[0], total: graph.nodes.length } });
  }

  // ---- 边采样：复用运行时采样器 ----------------------------------------------------
  let edgeConflicts = [];
  let tightEdges = [];
  if (graph.ok) {
    const fixture = {
      scene: { referenceWidth: scene.width, referenceHeight: scene.height },
      nodes: graph.nodes.map((node) => ({ id: node.id, position: node.position })),
      edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      // the DECLARED collision model is the authority for walkability (区域而非线条):
      // the sampler verifies the derived graph truly respects it
      furniture: model.obstacles.map((obstacle) => ({
        id: obstacle.id,
        parts: { rect: obstacle.rect },
      })),
    };
    const compiler = runtimeCompiler(repoRoot);
    // (1) the DECLARED model — the derivation must respect the radius the scene
    //     declares (zones.validation.moverRadius); a hit here is a derivation bug.
    edgeConflicts = compiler.sampleEdgeConflicts(fixture, { mode: 'flat', moverRadiusRatio: model.moverRadius });
    for (const conflict of edgeConflicts) {
      push('SCENE_EDGE_BLOCKED', 'red', `edge ${conflict.edge} passes through ${conflict.furnitureId}`, {
        detail: { edge: conflict.edge, furnitureId: conflict.furnitureId, point: conflict.point, moverRadius: model.moverRadius },
      });
    }
    // (2) the RUNTIME's default radius — advisory, never blocking: the product's
    //     compiler samples at MOVER_RADIUS_RATIO (0.04) and its nodes carry
    //     safeRadius ≈ 0.045, so a scene declaring less walks with less clearance
    //     than the product assumes. Reported so the author can decide.
    tightEdges = compiler.sampleEdgeConflicts(fixture, { mode: 'flat', moverRadiusRatio: RUNTIME_DEFAULT_MOVER_RADIUS });
    if (tightEdges.length > 0) {
      push('SCENE_EDGE_CLEARANCE_TIGHT', 'yellow',
        `${tightEdges.length} derived edge(s) are tighter than the runtime's default mover radius (${RUNTIME_DEFAULT_MOVER_RADIUS}) — the scene declares ${model.moverRadius}`,
        { detail: { sample: tightEdges.slice(0, 5), declaredMoverRadius: model.moverRadius, runtimeDefault: RUNTIME_DEFAULT_MOVER_RADIUS } });
    }
  }

  const reds = violations.filter((violation) => violation.severity === 'red');
  return {
    ok: reds.length === 0,
    violations,
    edgeConflicts,
    tightEdges,
    seats,
    stations: stations.map((station) => ({
      id: station.id,
      desk: station.desk.id,
      monitor: station.monitor ? station.monitor.id : null,
      character: station.character ? station.character.id : null,
      chair: station.chair ? station.chair.id : null,
    })),
    graph: {
      stats: graph.stats,
      labels: graph.labels,
      entries: graph.entries.map((entry) => ({ id: entry.id, node: entry.node, blocked: entry.blocked, source: entry.source })),
    },
    stats: {
      items: items.length,
      stations: stations.length,
      seats: seats.length,
      obstacles: model.obstacles.length,
      undeclaredObstacles: undeclared.length,
      staleObstacles: staleObstacles.length,
      red: reds.length,
      yellow: violations.length - reds.length,
    },
  };
}

module.exports = {
  OVERLAP_TOLERANCE_PX2,
  assignStationOrdinals,
  SEAT_REACH_RATIO,
  SUPPORT_RADIUS_RATIO,
  WORKSTATION_KINDS,
  boxesFor,
  deriveStations,
  validateScene,
};
