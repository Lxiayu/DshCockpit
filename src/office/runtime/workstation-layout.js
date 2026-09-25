'use strict';

const REQUIRED_KINDS = Object.freeze(['desk', 'monitor', 'chair', 'character']);
const ASSET_BY_KIND = Object.freeze({
  desk: 'prop-desk-back-right-top',
  monitor: 'prop-monitor-back-right-top',
  chair: 'prop-chair-front-left-top',
  character: 'whale-girl-front',
});
const LAYER_BY_KIND = Object.freeze({
  desk: 'back-furniture',
  monitor: 'back-furniture',
  chair: 'back-furniture',
});
const AMBIGUITY_EPSILON = 1e-12;

function fail(code, detail) {
  throw new TypeError(detail ? `${code}: ${detail}` : code);
}

function isFinitePoint(point) {
  return point
    && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
    && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}

function validateItem(item, ids) {
  if (!item || typeof item !== 'object') fail('DRAFT_ITEM_INVALID');
  if (typeof item.id !== 'string' || item.id.length === 0) fail('DRAFT_ITEM_ID_INVALID');
  if (ids.has(item.id)) fail('DRAFT_ITEM_ID_DUPLICATE', item.id);
  ids.add(item.id);
  if (!REQUIRED_KINDS.includes(item.kind)) fail('DRAFT_ITEM_KIND_UNKNOWN', String(item.kind));
  if (item.asset !== ASSET_BY_KIND[item.kind]) fail('DRAFT_ITEM_ASSET_UNKNOWN', String(item.asset));
  if (!isFinitePoint(item.position)) fail('DRAFT_ITEM_POSITION_INVALID', item.id);
  if (!Number.isFinite(item.scale) || item.scale <= 0) fail('DRAFT_ITEM_SCALE_INVALID', item.id);
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function nearestDesk(item, desks) {
  const ranked = desks
    .map((desk) => ({ desk, distance: distanceSquared(item.position, desk.position) }))
    .sort((a, b) => a.distance - b.distance || a.desk.id.localeCompare(b.desk.id));
  if (ranked.length > 1 && Math.abs(ranked[0].distance - ranked[1].distance) <= AMBIGUITY_EPSILON) {
    fail('WORKSTATION_MEMBER_AMBIGUOUS', item.id);
  }
  return ranked[0].desk;
}

function averageOffset(groups, kind) {
  const sum = groups.reduce((result, group) => ({
    x: result.x + group[kind].position.x - group.desk.position.x,
    y: result.y + group[kind].position.y - group.desk.position.y,
  }), { x: 0, y: 0 });
  return Object.freeze({ x: sum.x / groups.length, y: sum.y / groups.length });
}

function templatePart(groups, kind) {
  const sample = groups[0][kind];
  const consistent = groups.every((group) => group[kind].asset === sample.asset && group[kind].scale === sample.scale);
  if (!consistent) fail('WORKSTATION_MEMBER_INCONSISTENT', kind);
  return Object.freeze({
    assetId: sample.asset,
    offset: kind === 'desk' ? Object.freeze({ x: 0, y: 0 }) : averageOffset(groups, kind),
    scale: sample.scale,
    layer: LAYER_BY_KIND[kind],
  });
}

function addPoint(origin, offset) {
  return Object.freeze({ x: origin.x + offset.x, y: origin.y + offset.y });
}

function normalizeWorkstationDraft(draft) {
  if (!draft || typeof draft !== 'object') fail('DRAFT_INVALID');
  if (draft.schemaVersion !== 1) fail('DRAFT_SCHEMA_UNSUPPORTED', String(draft.schemaVersion));
  if (!draft.scene || !Number.isFinite(draft.scene.width) || draft.scene.width <= 0
      || !Number.isFinite(draft.scene.height) || draft.scene.height <= 0) {
    fail('DRAFT_SCENE_INVALID');
  }
  if (!Array.isArray(draft.items)) fail('DRAFT_ITEMS_INVALID');

  const ids = new Set();
  for (const item of draft.items) validateItem(item, ids);
  const desks = draft.items.filter((item) => item.kind === 'desk');
  if (desks.length !== 6) fail('WORKSTATION_DESK_COUNT', String(desks.length));

  const groupsByDesk = new Map(desks.map((desk) => [desk, { desk }]));
  for (const item of draft.items) {
    if (item.kind === 'desk') continue;
    const group = groupsByDesk.get(nearestDesk(item, desks));
    if (group[item.kind]) fail('WORKSTATION_MEMBER_DUPLICATE', `${group.desk.id}:${item.kind}`);
    group[item.kind] = item;
  }

  const groups = [...groupsByDesk.values()];
  for (const group of groups) {
    for (const kind of REQUIRED_KINDS) {
      if (!group[kind]) fail('WORKSTATION_MEMBER_MISSING', `${group.desk.id}:${kind}`);
    }
  }
  groups.sort((a, b) => {
    const rowDelta = a.desk.position.y - b.desk.position.y;
    return Math.abs(rowDelta) > 0.08 ? rowDelta : a.desk.position.x - b.desk.position.x;
  });

  const seatOffset = averageOffset(groups, 'character');
  const template = Object.freeze({
    desk: templatePart(groups, 'desk'),
    monitor: templatePart(groups, 'monitor'),
    chair: templatePart(groups, 'chair'),
    seat: Object.freeze({ offset: seatOffset, scale: 1, layer: 'ground-entities' }),
  });
  const instances = Object.freeze(groups.map((group, index) => {
    const deskId = `desk-${index + 1}`;
    const position = Object.freeze({ ...group.desk.position });
    const seatPosition = addPoint(position, seatOffset);
    const approachPosition = addPoint(seatPosition, { x: 0.035, y: 0.045 });
    const leavePosition = addPoint(approachPosition, { x: 0, y: 0.04 });
    return Object.freeze({
      deskId,
      position,
      seat: Object.freeze({ id: deskId, position: seatPosition }),
      approach: Object.freeze({ id: `${deskId}-approach`, nodeId: `${deskId}-approach`, position: approachPosition }),
      leave: Object.freeze({ id: `${deskId}-leave`, nodeId: `${deskId}-leave`, position: leavePosition }),
    });
  }));

  return Object.freeze({ template, instances });
}

module.exports = { normalizeWorkstationDraft };
