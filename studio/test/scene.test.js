'use strict';

// studio/test/scene.test.js — the scene validator (P2).
//
// The phase acceptance (brief §9 P2) has two halves and both are asserted here:
//   1. the tool must NOT cry wolf on the approved layout (the real content/scenes/
//      flat draft + zones validate with zero blocking findings);
//   2. it must BLOCK the three defect classes this project actually shipped —
//      工作位悬空 (floating seat), 家具重叠 (cross-station furniture overlap),
//      入口被堵 (blocked entrance) — each constructed here by mutating a copy of
//      the real draft.
// Plus the semantics parity locks: the studio's foot-point projection must
// reproduce the RUNTIME compiler's seat nodes exactly, and the edge sampling must
// use the runtime's own sampler.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');

const { createSceneServices } = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'index.js'));
const zonesLib = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'zones.js'));
const geometry = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'geometry.js'));
const conflictsLib = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'conflicts.js'));
const schema = require(path.join(STUDIO_ROOT, 'lib', 'layout-schema.js'));

const services = createSceneServices({ repoRoot: REPO_ROOT, contentDir: CONTENT_ROOT });
const REAL_DRAFT = JSON.parse(fs.readFileSync(path.join(CONTENT_ROOT, 'scenes', 'flat', 'layout.json'), 'utf8'));
const REAL_ZONES = zonesLib.loadZones({ contentDir: CONTENT_ROOT, sceneId: 'flat' });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validate({ draft = REAL_DRAFT, zones = REAL_ZONES, scene = { width: 1280, height: 840 } }) {
  const catalog = services.loadCatalog();
  return conflictsLib.validateScene({
    repoRoot: REPO_ROOT,
    draft,
    model: zones.model,
    scene,
    assets: catalog.assets,
    draftWidths: catalog.draftWidths,
    characterFootRatio: catalog.characterFootRatio,
    schemaValidator: schema.validateDraftSchema,
  });
}

// Candidate placements must be validated in the space the CHECKER looks at: a
// seat is judged by its FOOT POINT (position + the calibrated foot offset), not
// by the item centre — 30px of difference decides whether a spot is clear.
function freeSpotsForCharacter(model, awayFrom, { item, minDistancePx = 150, limit = 4 } = {}) {
  const scene = { width: 1280, height: 840 };
  const catalog = services.loadCatalog();
  // the probe keeps the REAL item's scale: the foot offset depends on it
  const probe = { ...(item || { kind: 'character', asset: 'whale-girl-front', scale: 1.98 }), position: { x: 0, y: 0 } };
  const found = [];
  for (let x = 0.06; x <= 0.94; x += 0.01) {
    for (let y = 0.06; y <= 0.94; y += 0.01) {
      probe.position = { x, y };
      const foot = geometry.characterFootPx(probe, catalog.draftWidths, scene, catalog.characterFootRatio);
      const footPoint = { x: foot.x / scene.width, y: foot.y / scene.height };
      if (!zonesLib.isFree(model, footPoint, scene)) continue;
      const far = awayFrom.every((other) => geometry.distance({ x: foot.x, y: foot.y }, other) >= minDistancePx);
      if (!far) continue;
      found.push({ x, y, foot: footPoint });
      if (found.length >= limit) return found;
    }
  }
  return found;
}

function codesOf(result, severity = null) {
  return result.violations.filter((violation) => !severity || violation.severity === severity).map((violation) => violation.code);
}

test('the real draft satisfies the schema copy and every asset resolves in the catalog', () => {
  const outcome = schema.validateDraftSchema(REAL_DRAFT);
  assert.equal(outcome.ok, true, `real draft validates (${outcome.code})`);
  assert.equal(outcome.count, 38);
  const catalog = services.loadCatalog();
  const missing = REAL_DRAFT.items.filter((item) => !catalog.assets.has(item.asset)).map((item) => item.asset);
  assert.deepEqual(missing, [], 'every draft asset id exists in the product catalog');
});

test('the studio foot-point rule reproduces the RUNTIME compiler seat nodes exactly', () => {
  // src/office/fixtures/office-layout-flat.json is the byte-locked compiler output
  // of this very draft: if the studio's projection differs, the two disagree about
  // where the worker stands — this test is the parity lock.
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8'));
  const catalog = services.loadCatalog();
  const scene = { width: fixture.scene.referenceWidth, height: fixture.scene.referenceHeight };
  const stations = conflictsLib.deriveStations(REAL_DRAFT.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  const deskNodes = fixture.nodes.filter((node) => /^desk-\d+$/.test(node.id));
  assert.equal(deskNodes.length, stations.length, 'every compiled desk node has a derived station');
  const deltas = [];
  for (const station of stations) {
    const foot = geometry.characterFootPx(station.character, catalog.draftWidths, scene, catalog.characterFootRatio);
    const nearest = deskNodes
      .map((node) => ({ node, distance: geometry.distance({ x: node.position.x * scene.width, y: node.position.y * scene.height }, { x: foot.x, y: foot.y }) }))
      .sort((a, b) => a.distance - b.distance)[0];
    deltas.push(nearest.distance);
  }
  deltas.sort((a, b) => b - a);
  assert.ok(deltas[0] < 0.5, `every seat foot point lands on a compiled desk node (worst ${deltas[0].toFixed(4)}px)`);
});

test('the real, user-approved scene validates with ZERO blocking findings', () => {
  const result = validate({});
  assert.equal(result.ok, true, `no red findings (${JSON.stringify(codesOf(result, 'red'))})`);
  assert.equal(result.stats.red, 0);
  assert.equal(result.stats.stations, 6, 'six stations derived');
  assert.equal(result.stats.seats, 6);
  assert.equal(result.stats.undeclaredObstacles, 0, 'every workstation item and prop has a declared obstacle');
  // the yellow findings are honest advisories, not verdicts
  assert.ok(codesOf(result, 'yellow').includes('SCENE_FURNITURE_OVERLAP'), 'prop-on-prop stacking is reported for review');
  assert.ok(codesOf(result, 'yellow').includes('SCENE_EDGE_CLEARANCE_TIGHT'), 'aisle clearance below the runtime default is reported');
  for (const station of result.stations) {
    assert.ok(station.desk && station.monitor && station.character && station.chair, `${station.id} is complete`);
  }
});

test('DEFECT 1 工作位悬空 — a seat dragged away from its desk is blocked', () => {
  const draft = clone(REAL_DRAFT);
  const catalog = services.loadCatalog();
  const scene = { width: 1280, height: 840 };
  const stations = conflictsLib.deriveStations(draft.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  const victim = stations[0].character;
  const deskCenters = stations.map((station) => {
    const box = geometry.artBoxPx(station.desk, catalog.assets.get(station.desk.asset), catalog.draftWidths, scene);
    return geometry.centerOf(box);
  });
  const spots = freeSpotsForCharacter(REAL_ZONES.model, deskCenters, { item: victim, minDistancePx: 200, limit: 1 });
  assert.ok(spots.length > 0, 'the scene has an open floor area for this defect');
  victim.position = { x: spots[0].x, y: spots[0].y }; // open floor, far from any desk
  const result = validate({ draft });
  assert.equal(result.ok, false, 'the floating workstation is refused');
  const floating = result.violations.find((violation) => violation.code === 'SCENE_WORKSTATION_FLOATING');
  assert.ok(floating, `SCENE_WORKSTATION_FLOATING reported (${JSON.stringify(codesOf(result))})`);
  assert.equal(floating.severity, 'red');
  assert.match(floating.message, /outside every workstation|away from its desk|no free cell/,
    `the floating seat is named as such (${floating.message})`);
  assert.ok(result.violations.some((violation) => violation.code === 'SCENE_WORKSTATION_INCOMPLETE'),
    'the abandoned station is also reported incomplete');
});

test('DEFECT 1b 工作位悬空 — a seat standing inside foreign furniture is blocked', () => {
  const draft = clone(REAL_DRAFT);
  const catalog = services.loadCatalog();
  const scene = { width: 1280, height: 840 };
  const stations = conflictsLib.deriveStations(draft.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  // drop the pantry island ONTO the seat: the seat stays claimed by its station,
  // so the seat-clearance rule (not the orphan rule) is what must fire
  const island = draft.items.find((item) => item.asset === 'flat-island');
  assert.ok(island, 'the real draft has the island prop');
  const foot = geometry.characterFootPx(stations[0].character, catalog.draftWidths, scene, catalog.characterFootRatio);
  island.position = { x: foot.x / scene.width, y: foot.y / scene.height };
  const result = validate({ draft });
  assert.equal(result.ok, false);
  const floating = result.violations.find((violation) => violation.code === 'SCENE_WORKSTATION_FLOATING');
  assert.ok(floating, `SCENE_WORKSTATION_FLOATING reported (${JSON.stringify(codesOf(result))})`);
  assert.match(floating.message, /inside foreign furniture|only .*px from foreign furniture/,
    `the obstacle is named (${floating.message})`);
});

test('DEFECT 2 家具重叠 — two stations whose furniture collides are blocked', () => {
  const draft = clone(REAL_DRAFT);
  const catalog = services.loadCatalog();
  const scene = { width: 1280, height: 840 };
  const stations = conflictsLib.deriveStations(draft.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  // slide station-2's desk 64px into station-1's desk: two STATIONS collide.
  // (An exact overlap is refused even earlier — the schema's group inference
  // then reports DRAFT_GROUP_AMBIGUOUS, which the last test pins.)
  stations[1].desk.position = { x: stations[0].desk.position.x + 0.05, y: stations[0].desk.position.y };
  const result = validate({ draft });
  assert.equal(result.ok, false, 'cross-station furniture overlap is refused');
  const overlap = result.violations.find((violation) => violation.code === 'SCENE_FURNITURE_OVERLAP' && violation.severity === 'red');
  assert.ok(overlap, `a RED overlap is reported (${JSON.stringify(codesOf(result))})`);
  assert.equal(overlap.detail.stations.filter(Boolean).length, 2, 'the two colliding stations are named');
  assert.ok(overlap.detail.areaPx2 > 1000, `the penetration is measured (${overlap.detail.areaPx2} px²)`);
  assert.match(overlap.message, /overlaps/, 'the two colliding items are named');
});

test('DEFECT 3 入口被堵 — a declared entrance standing in furniture is blocked', () => {
  const island = REAL_DRAFT.items.find((item) => item.asset === 'flat-island');
  const zones = clone(REAL_ZONES.zones);
  zones.entries = [{ id: 'main-door', at: [island.position.x, island.position.y], label: '东侧入口' }];
  const loaded = { ok: true, zones, model: zonesLib.buildModel(zones) };
  const result = validate({ zones: loaded });
  assert.equal(result.ok, false, 'a blocked entrance is refused');
  const blocked = result.violations.find((violation) => violation.code === 'SCENE_ENTRY_BLOCKED');
  assert.ok(blocked, `SCENE_ENTRY_BLOCKED reported (${JSON.stringify(codesOf(result))})`);
  assert.match(blocked.message, /stands in furniture/);
  assert.ok(result.graph.entries.some((entry) => entry.id === 'main-door' && entry.blocked === true));
});

test('a declared entrance in free space is accepted and becomes a real graph entry', () => {
  const zones = clone(REAL_ZONES.zones);
  const scene = { width: 1280, height: 840 };
  const spots = freeSpotsForCharacter(REAL_ZONES.model, [], { minDistancePx: 0, limit: 60 });
  // spread the doors out: the leftmost, the rightmost and the lowest free spots
  const byX = [...spots].sort((a, b) => a.x - b.x);
  const byY = [...spots].sort((a, b) => a.y - b.y);
  const chosen = [byX[0], byX[byX.length - 1], byY[byY.length - 1]];
  const candidates = chosen
    .filter((spot) => spot)
    .filter((spot, index, list) => list.findIndex((other) => other.x === spot.x && other.y === spot.y) === index)
    .map((spot, index) => ({ id: `door-${index + 1}`, label: `入口${index + 1}`, point: spot.foot }));
  assert.ok(candidates.length >= 2, `the scene has free entrance spots (${candidates.length})`);
  zones.entries = candidates.map((entry) => ({ id: entry.id, at: [entry.point.x, entry.point.y], label: entry.label }));
  const loaded = { ok: true, zones, model: zonesLib.buildModel(zones) };
  const result = validate({ zones: loaded });
  assert.equal(result.violations.some((violation) => violation.code === 'SCENE_ENTRY_BLOCKED'), false, 'free entrances are not blocked');
  const entries = result.graph.entries;
  assert.equal(entries.length, candidates.length, 'multiple entrances are supported');
  for (const entry of entries) {
    assert.ok(entry.node, `${entry.id} resolved to a graph cell`);
    assert.equal(entry.blocked, false);
  }
});

test('the derived graph is honest about its shape and uses the runtime sampler', () => {
  const waypoints = services.waypoints({ sceneId: 'flat' });
  assert.equal(waypoints.ok, true);
  assert.equal(waypoints.schemaVersion, 1);
  assert.ok(waypoints.nodes.length > 50, `the lattice has cells (${waypoints.nodes.length})`);
  assert.ok(waypoints.edges.length > waypoints.nodes.length, 'the lattice is connected, not a point cloud');
  assert.equal(waypoints.stats.isolated, 0, 'no isolated cell survives the radius filter');
  for (const node of waypoints.nodes) {
    assert.ok(node.label, 'every cell carries a zone label');
    assert.ok(['roaming', 'work'].includes(node.label), `known label vocabulary (${node.label})`);
  }
  // work cells really are near desks
  assert.ok(waypoints.labels.work > 0, 'work cells exist near the desks');
  // no cell centre may sit inside a declared obstacle within the mover radius
  const scene = { width: 1280, height: 840 };
  for (const node of waypoints.nodes) {
    assert.equal(zonesLib.isFree(REAL_ZONES.model, node.position, scene), true, `${node.id} is free`);
  }
  // the edge check ran through the RUNTIME's sampler (its conflicts are empty on
  // a derivation that respects the declared model, and the tight-edge advisory
  // still finds the runtime-default violations)
  const result = validate({});
  assert.deepEqual(result.edgeConflicts, [], 'the derived graph respects the declared collision model');
  assert.ok(result.tightEdges.length > 0, 'the runtime default radius still flags tight aisles (advisory)');
});

test('furniture without an obstacle is blocked (walkers would walk through it)', () => {
  const zones = clone(REAL_ZONES.zones);
  zones.obstacles = zones.obstacles.filter((obstacle) => obstacle.id !== 'draft-53'); // the island
  const loaded = { ok: true, zones, model: zonesLib.buildModel(zones) };
  const result = validate({ zones: loaded });
  assert.equal(result.ok, false);
  const finding = result.violations.find((violation) => violation.code === 'SCENE_OBSTACLE_UNDECLARED');
  assert.ok(finding, `SCENE_OBSTACLE_UNDECLARED reported (${JSON.stringify(codesOf(result))})`);
  assert.equal(finding.severity, 'red');
  assert.equal(finding.itemId, 'draft-53', 'the uncovered item is named');
  assert.equal(result.stats.undeclaredObstacles, 1);
});

test('zone drift in both directions is blocked: a moved item AND the obstacle left behind', () => {
  const draft = clone(REAL_DRAFT);
  const island = draft.items.find((item) => item.asset === 'flat-island');
  island.position = { x: 0.35, y: 0.55 }; // moved, zones.json untouched
  const result = validate({ draft });
  assert.equal(result.ok, false);
  const undeclared = result.violations.find((violation) => violation.code === 'SCENE_OBSTACLE_UNDECLARED' && violation.itemId === island.id);
  const stale = result.violations.find((violation) => violation.code === 'SCENE_OBSTACLE_STALE');
  assert.ok(undeclared, `the moved item has no obstacle at its new position (${JSON.stringify(codesOf(result))})`);
  assert.ok(stale, 'the obstacle left behind is reported as a phantom');
  assert.equal(stale.detail.obstacleId, island.id);
  assert.equal(undeclared.severity, 'red');
  assert.equal(stale.severity, 'red');
});

test('zone-sync rebuilds the obstacles from the layout and closes the loop', () => {
  const zoneSync = require(path.join(STUDIO_ROOT, 'lib', 'scene', 'zone-sync.js'));
  const catalog = services.loadCatalog();
  const scene = { width: 1280, height: 840 };
  const stations = conflictsLib.deriveStations(REAL_DRAFT.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  const south = (draft) => conflictsLib.deriveStations(draft.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });

  // 1) on the approved scene the derivation reproduces the committed zones exactly
  const exact = zoneSync.syncZones({
    draft: REAL_DRAFT, zones: REAL_ZONES.zones, assets: catalog.assets, draftWidths: catalog.draftWidths, scene, stations,
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.exact, true, `the committed obstacles are exactly the derived ones (${JSON.stringify(exact.changes)})`);
  assert.deepEqual(exact.zones.obstacles, REAL_ZONES.zones.obstacles, 'same ids, same rects, same order');

  // 2) after moving an item, the sync names the change...
  const draft = clone(REAL_DRAFT);
  const island = draft.items.find((item) => item.asset === 'flat-island');
  island.position = { x: 0.35, y: 0.55 };
  const moved = zoneSync.syncZones({
    draft, zones: REAL_ZONES.zones, assets: catalog.assets, draftWidths: catalog.draftWidths, scene, stations: south(draft),
  });
  assert.equal(moved.exact, false);
  assert.deepEqual(moved.changes.moved, [island.id], `the moved obstacle is named (${JSON.stringify(moved.changes)})`);

  // 3) ...and applying it makes the scene validate again (the loop closes)
  const loaded = { ok: true, zones: moved.zones, model: zonesLib.buildModel(moved.zones) };
  const after = validate({ draft, zones: loaded });
  assert.equal(after.ok, true, `re-synced zones clear the finding (${JSON.stringify(codesOf(after, 'red'))})`);
  assert.equal(after.stats.undeclaredObstacles, 0);
  assert.equal(after.stats.staleObstacles, 0);

  // 4) and the author's intent is preserved (walkable / regions / entries / radii)
  assert.deepEqual(moved.zones.walkable, REAL_ZONES.zones.walkable);
  assert.deepEqual(moved.zones.validation, REAL_ZONES.zones.validation);
  assert.deepEqual(moved.zones.graph, REAL_ZONES.zones.graph);
});

test('an item pushed off the canvas is reported', () => {
  const draft = clone(REAL_DRAFT);
  // position must stay inside [0,1] (the schema enforces it) — the ART BOX is what
  // leaves the canvas: a prop at x=0.995 with a 120px-wide box pokes ~57px past the edge
  draft.items.find((item) => item.asset === 'flat-island').position = { x: 0.995, y: 0.5 };
  const result = validate({ draft });
  const finding = result.violations.find((violation) => violation.code === 'SCENE_ITEM_OUT_OF_BOUNDS');
  assert.ok(finding, `SCENE_ITEM_OUT_OF_BOUNDS reported (${JSON.stringify(codesOf(result))})`);
  assert.equal(finding.severity, 'yellow');
});

test('a draft the schema rejects never reaches geometry checks', () => {
  const draft = clone(REAL_DRAFT);
  draft.items[0].kind = 'not-a-kind';
  const result = validate({ draft });
  assert.equal(result.ok, false);
  assert.deepEqual(codesOf(result), ['SCENE_DRAFT_INVALID'], 'the schema verdict is the only finding');
  assert.equal(result.stats, null);
});

test('zones validation names every bad field', () => {
  const violations = zonesLib.validateZones({
    schemaVersion: 2,
    scene: '',
    walkable: [{ kind: 'polygon', rect: [0.1, 0.1] }],
    obstacles: [{ id: '', kind: 'circle', rect: [0, 0, 2, 2], radius: -1 }],
  });
  const checks = violations.map((violation) => violation.check);
  for (const expected of ['zones.schemaVersion', 'zones.scene', 'zones.walkable[0].kind', 'zones.walkable[0].rect', 'zones.obstacles[0].id', 'zones.obstacles[0].kind', 'zones.obstacles[0].rect', 'zones.obstacles[0].radius']) {
    assert.ok(checks.includes(expected), `${expected} reported (got ${checks.join(', ')})`);
  }
});

test('the schema refuses the naive desk-on-desk defect before geometry runs (DRAFT_GROUP_AMBIGUOUS)', () => {
  const draft = clone(REAL_DRAFT);
  const catalog = services.loadCatalog();
  const scene = { width: 1280, height: 840 };
  const stations = conflictsLib.deriveStations(draft.items, {
    assets: catalog.assets, draftWidths: catalog.draftWidths, scene, characterFootRatio: catalog.characterFootRatio,
  });
  stations[1].desk.position = { ...stations[0].desk.position };
  const result = validate({ draft });
  assert.equal(result.ok, false);
  assert.deepEqual(codesOf(result), ['SCENE_DRAFT_INVALID']);
  assert.equal(result.violations[0].detail.code, 'DRAFT_GROUP_AMBIGUOUS', 'the two desks at one spot make group inference ambiguous');
});
