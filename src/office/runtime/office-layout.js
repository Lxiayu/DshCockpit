'use strict';

// src/office/runtime/office-layout.js — Task 7 / SPEC-07.
//
// Pure accessor + validator for the office layout fixture
// (`src/office/fixtures/office-layout.json`). No Electron/Pixi/DOM/fs/network
// access: the fixture JSON is injected by the caller.
//
// Contracts (SPEC-07 / OFFICE-DESIGN-DISCUSSION decisions 8/33):
// - schemaVersion 1; canonical workstations use desk-1..desk-6 in two columns
//   by three rows; legacy schema-v1 fixtures without workstations remain valid
//   overall anchor is shifted slightly right/down while the left-top reserve
//   zone stays free of desks (future furniture area)
// - every node declares id/position/footprint/safeRadius/tags/capacity
// - the fixed layer order is Background -> Back Furniture -> Ground Entities
//   -> Front Occluders -> Effects/Labels
// - ground entities sort stably by the tuple (footY, layer, entityType, id)
// - furniture declares its layer explicitly; front occluders are flagged
//   `occluder: true` — occlusion is fixture-declared, never inferred from
//   texture content or alpha
// - `waypointGraph()` emits a movement-controller compatible graph
//   ({schemaVersion, nodes, edges})

const LAYOUT_SCHEMA_VERSION = 1;
const LAYER_ORDER = Object.freeze([
  'background',
  'back-furniture',
  'ground-entities',
  'front-occluders',
  'effects-labels',
]);
const DESK_IDS = Object.freeze(['desk-1', 'desk-2', 'desk-3', 'desk-4', 'desk-5', 'desk-6']);
const FURNITURE_LAYERS = Object.freeze(['background', 'back-furniture', 'front-occluders', 'effects-labels']);

function isPoint2(value) {
  return !!value
    && typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y);
}

function isFootprint(value) {
  return !!value
    && typeof value.width === 'number' && value.width > 0
    && typeof value.height === 'number' && value.height > 0;
}

function samePoint(a, b) {
  return isPoint2(a) && isPoint2(b)
    && Math.abs(a.x - b.x) <= 1e-12
    && Math.abs(a.y - b.y) <= 1e-12;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// Stable comparator over the documented tuple.
function groundKey(entity) {
  return [
    typeof entity.footY === 'number' ? entity.footY : 0,
    entity.layer || 0,
    entity.entityType || '',
    String(entity.id || ''),
  ];
}

function compareGroundKeys(a, b) {
  const ka = groundKey(a);
  const kb = groundKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0; // stable: Array.prototype.sort is stable in Node >= 12
}

function validateOfficeLayout(fixture) {
  const errors = [];
  const push = (code, detail) => errors.push({ code, detail });

  if (!fixture || typeof fixture !== 'object') {
    return { ok: false, errors: [{ code: 'LAYOUT_MISSING' }] };
  }
  if (fixture.schemaVersion !== LAYOUT_SCHEMA_VERSION) push('SCHEMA_VERSION', String(fixture.schemaVersion));
  if (!isPoint2(fixture.scene) || fixture.scene.x !== undefined) {
    if (!fixture.scene || !Number.isFinite(fixture.scene.referenceWidth) || !Number.isFinite(fixture.scene.referenceHeight)) {
      push('SCENE_INVALID', 'referenceWidth/referenceHeight required');
    }
  }
  if (!Array.isArray(fixture.layers) || fixture.layers.join('>') !== LAYER_ORDER.join('>')) {
    push('LAYER_ORDER', JSON.stringify(fixture.layers || null));
  }
  const nodes = Array.isArray(fixture.nodes) ? fixture.nodes : [];
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) { push('NODE_ID', JSON.stringify(node)); continue; }
    if (ids.has(node.id)) push('NODE_DUPLICATE', node.id);
    ids.add(node.id);
    if (!isPoint2(node.position) || node.position.x < 0 || node.position.x > 1 || node.position.y < 0 || node.position.y > 1) {
      push('NODE_POSITION', node.id);
    }
    if (!isFootprint(node.footprint)) push('NODE_FOOTPRINT', node.id);
    if (typeof node.safeRadius !== 'number' || !(node.safeRadius >= 0)) push('NODE_SAFE_RADIUS', node.id);
    if (!Array.isArray(node.tags) || node.tags.length === 0) push('NODE_TAGS', node.id);
    if (!Number.isInteger(node.capacity) || node.capacity < 1) push('NODE_CAPACITY', node.id);
  }
  for (const deskId of DESK_IDS) {
    const desk = nodes.find((node) => node && node.id === deskId);
    if (!desk) { push('DESK_MISSING', deskId); continue; }
    if (!desk.tags.includes('desk')) push('DESK_TAGS', deskId);
  }
  const desks = DESK_IDS.map((id) => nodes.find((node) => node && node.id === id)).filter(Boolean);
  if (desks.length === 6) {
    if (fixture.workstations) {
      const xs = new Set(desks.map((desk) => Math.round(desk.position.x * 10)));
      const ys = new Set(desks.map((desk) => Math.round(desk.position.y * 10)));
      if (xs.size !== 2 || ys.size !== 3) push('DESK_GRID', `cols=${xs.size} rows=${ys.size}`);
      if (!fixture.layout || !fixture.layout.grid
          || fixture.layout.grid.columns !== 2 || fixture.layout.grid.rows !== 3) {
        push('DESK_GRID_METADATA', JSON.stringify(fixture.layout && fixture.layout.grid));
      }
      for (let index = 0; index < desks.length; index += 2) {
        if (!(desks[index].position.x < desks[index + 1].position.x)) push('DESK_ROW_ORDER', String(index / 2));
        if (index > 0 && !(desks[index - 2].position.y < desks[index].position.y)) push('DESK_COLUMN_ORDER', String(index / 2));
      }
    }
    const reserve = fixture.layout && fixture.layout.reserve;
    if (isFootprint(reserve) && typeof reserve.x === 'number') {
      for (const desk of desks) {
        const inside = desk.position.x >= reserve.x && desk.position.x <= reserve.x + reserve.width
          && desk.position.y >= reserve.y && desk.position.y <= reserve.y + reserve.height;
        if (inside) push('DESK_IN_RESERVE', desk.id);
      }
    } else {
      push('RESERVE_ZONE', 'layout.reserve required');
    }
  }
  const edges = Array.isArray(fixture.edges) ? fixture.edges : [];
  for (const edge of edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) push('EDGE_NODE', JSON.stringify(edge));
    else if (!Array.isArray(edge.behaviors) || edge.behaviors.length === 0) push('EDGE_BEHAVIORS', `${edge.from}>${edge.to}`);
  }
  const furniture = Array.isArray(fixture.furniture) ? fixture.furniture : [];
  const furnitureIds = new Set();
  for (const item of furniture) {
    if (!item || typeof item.id !== 'string' || !item.id) { push('FURNITURE_ID', JSON.stringify(item)); continue; }
    if (furnitureIds.has(item.id)) push('FURNITURE_DUPLICATE', item.id);
    furnitureIds.add(item.id);
    if (!LAYER_ORDER.includes(item.layer) || item.layer === 'ground-entities') push('FURNITURE_LAYER', item.id);
    if (!isFootprint(item.footprint)) push('FURNITURE_FOOTPRINT', item.id);
    if (!item.parts || typeof item.parts !== 'object') push('FURNITURE_PARTS', item.id);
  }
  const occluders = furniture.filter((item) => item && item.layer === 'front-occluders');
  if (occluders.length === 0 || !occluders.every((item) => item.occluder === true)) push('OCCLUDER_FLAGS', 'front occluders must set occluder:true');
  if (desks.length === 6 && occluders.length < 6) push('OCCLUDERS_MISSING', `front=${occluders.length}`);

  if (fixture.workstations !== undefined) {
    const workstations = fixture.workstations;
    if (!workstations || typeof workstations !== 'object' || workstations.schemaVersion !== 1) {
      push('WORKSTATIONS_SCHEMA', String(workstations && workstations.schemaVersion));
    } else {
      const template = workstations.template;
      for (const kind of ['desk', 'monitor', 'chair']) {
        const part = template && template[kind];
        if (!part || typeof part.assetId !== 'string' || !part.assetId
            || !isPoint2(part.offset) || !Number.isFinite(part.scale) || part.scale <= 0
            || !LAYER_ORDER.includes(part.layer)) push('WORKSTATION_TEMPLATE', kind);
      }
      if (!template || !template.seat || !isPoint2(template.seat.offset)) push('WORKSTATION_TEMPLATE', 'seat');
      const instances = Array.isArray(workstations.instances) ? workstations.instances : [];
      if (instances.length !== DESK_IDS.length) push('WORKSTATION_COUNT', String(instances.length));
      instances.forEach((instance, index) => {
        const deskId = DESK_IDS[index];
        if (!instance || instance.deskId !== deskId || !isPoint2(instance.position)) {
          push('WORKSTATION_INSTANCE', deskId);
          return;
        }
        const seat = instance.seat;
        const approach = instance.approach;
        const leave = instance.leave;
        const seatNode = seat && ids.has(seat.id) && nodes.find((node) => node.id === seat.id);
        const approachNode = approach && ids.has(approach.nodeId) && nodes.find((node) => node.id === approach.nodeId);
        const leaveNode = leave && ids.has(leave.nodeId) && nodes.find((node) => node.id === leave.nodeId);
        if (!seatNode || !samePoint(seat.position, seatNode.position)) push('WORKSTATION_SEAT_ANCHOR', deskId);
        if (!approachNode || !samePoint(approach.position, approachNode.position)) push('WORKSTATION_APPROACH_ANCHOR', deskId);
        if (!leaveNode || !samePoint(leave.position, leaveNode.position)) push('WORKSTATION_LEAVE_ANCHOR', deskId);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function createOfficeLayout(fixture) {
  const validation = validateOfficeLayout(fixture);
  if (!validation.ok) {
    throw new Error(`office-layout invalid: ${JSON.stringify(validation.errors)}`);
  }

  const nodes = Object.freeze(fixture.nodes.map((node) => Object.freeze({
    ...node,
    position: Object.freeze({ ...node.position }),
    footprint: Object.freeze({ ...node.footprint }),
    tags: Object.freeze([...node.tags]),
  })));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const edges = Object.freeze(fixture.edges.map((edge) => Object.freeze({
    ...edge,
    behaviors: Object.freeze([...edge.behaviors]),
  })));
  const furniture = Object.freeze(fixture.furniture.map((item) => Object.freeze({
    ...item,
    footprint: Object.freeze({ ...item.footprint }),
    parts: Object.freeze(Object.fromEntries(
      Object.entries(item.parts || {}).map(([part, rect]) => [part, Object.freeze({ ...rect })])
    )),
  })));
  const scene = Object.freeze({
    referenceWidth: fixture.scene.referenceWidth,
    referenceHeight: fixture.scene.referenceHeight,
  });
  const desks = DESK_IDS.map((id) => nodesById.get(id));
  const workstations = fixture.workstations
    ? deepFreeze(JSON.parse(JSON.stringify(fixture.workstations)))
    : null;
  const workstationByDesk = new Map((workstations && workstations.instances || []).map((instance) => [instance.deskId, instance]));

  return Object.freeze({
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    layers: () => [...LAYER_ORDER],
    scene: () => ({ ...scene }),
    nodes: () => nodes,
    edges: () => edges,
    furniture: () => furniture,
    desks: () => [...desks],
    workstations: () => workstations,
    workstation: (deskId) => workstationByDesk.get(deskId) || null,
    anchor: (deskId, kind) => {
      const workstation = workstationByDesk.get(deskId);
      return workstation && ['seat', 'approach', 'leave'].includes(kind) ? workstation[kind] : null;
    },
    nodeById: (id) => nodesById.get(id) || null,
    reserveZone: () => Object.freeze({ ...fixture.layout.reserve }),
    gridOffset: () => Object.freeze({ ...fixture.layout.offset }),
    waypointGraph: () => Object.freeze({ schemaVersion: LAYOUT_SCHEMA_VERSION, nodes, edges }),
    groundSortKey: (entity) => Object.freeze(groundKey(entity)),
    sortGroundEntities: (entities) => [...entities].sort(compareGroundKeys),
  });
}

module.exports = {
  LAYOUT_SCHEMA_VERSION,
  LAYER_ORDER,
  DESK_IDS,
  validateOfficeLayout,
  createOfficeLayout,
};
