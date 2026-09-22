'use strict';

// src/office/layout-editor.js — Task 2 editor round trip.
//
// Pure draft editor over normalized [0,1] scene coordinates: no DOM, no
// filesystem, no network. The only dependency is the layout-assets catalog,
// which validates imported schema-v1 drafts (kind/asset/direction must match
// a declared asset). Import is atomic: any validation failure leaves the
// current draft, selection and undo/redo history untouched.
//
// schema-v1 round-trip contract:
// - load(draft) accepts schemaVersion 1 only; unknown top-level/item fields
//   are ignored on import and never re-emitted by toJSON
// - missing layer defaults by kind (larger draws in front); missing groupId
//   is inferred from the nearest desk in normalized space (exact ties are
//   rejected); desks own a group named after themselves
// - invalid/missing selectedId imports as null
// - Task E2c: locked/hidden/name are OPTIONAL schema-v1 item fields
//   (default false/false/null). locked freezes geometry + deletion, hidden
//   removes the item from the canvas while keeping it in the draft; unknown
//   values are rejected with stable codes, legacy drafts without the fields
//   keep importing unchanged.
// - Task E2e: groupNames is an OPTIONAL top-level field ({groupId: 名称}) —
//   display names for material groups; absent/null in legacy drafts → {}.
//   groupId semantics are UNCHANGED (desks own their group, nearest-desk
//   inference, rigid group drags); the name is display-only.
// - auto-generated draft-N ids continue past imported draft-N ids
// - toJSON whitelists id/kind/asset/position/scale/direction/layer/groupId/
//   locked/hidden/name per item and deep-copies everything

const { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS } = require('./layout-assets.js');

const LIMIT = Object.freeze({ min: 0, max: 1 });
const SCHEMA_VERSION = 1;
// Layer semantics (Task E2e, now load-bearing for paint order): the layer
// number is DEPTH — larger draws further FRONT (back → front). The editor
// page maps it to CSS z-index with the items array order as the same-value
// tiebreak. Locked by the layer-default tests. Task E2c: env props draft
// at 25 — in front of monitors/chairs, behind characters (a walking
// character covers the prop; the prop covers workstation furniture).
const DEFAULT_LAYER_BY_KIND = Object.freeze({ monitor: 10, chair: 20, prop: 25, character: 30, desk: 40 });
const AMBIGUITY_EPSILON = 1e-12;
const AUTO_ID_PATTERN = /^draft-(\d+)$/;
const GROUP_ID_PATTERN = /^group-(\d+)$/;
// Task E4.6: retired-palette (archived) entries stay import-whitelisted so
// legacy schema-v1 drafts keep loading; the shelf simply never offers them.
const ASSET_BY_ID = new Map([...LAYOUT_ASSETS, ...ARCHIVED_LAYOUT_ASSETS].map((asset) => [asset.id, asset]));

function snapToGrid(value, grid) {
  return grid > 0 ? Math.round(value / grid) * grid : value;
}

function clamp(value) {
  const bounded = Math.min(LIMIT.max, Math.max(LIMIT.min, Number(value) || 0));
  return Math.round(bounded * 1000000) / 1000000;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

// Validates a schema-v1 draft and returns plain normalized items with layer
// defaults applied and group ids inferred. Throws only stable `code` errors.
function parseDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) fail('DRAFT_INVALID');
  if (draft.schemaVersion !== SCHEMA_VERSION) fail('DRAFT_SCHEMA_UNSUPPORTED');
  const draftScene = draft.scene;
  if (!draftScene || !Number.isFinite(draftScene.width) || draftScene.width <= 0
      || !Number.isFinite(draftScene.height) || draftScene.height <= 0) {
    fail('DRAFT_SCENE_INVALID');
  }
  if (!Array.isArray(draft.items)) fail('DRAFT_ITEMS_INVALID');

  const ids = new Set();
  const items = draft.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('DRAFT_ITEM_INVALID');
    if (typeof item.id !== 'string' || item.id.length === 0) fail('DRAFT_ITEM_ID_INVALID');
    if (ids.has(item.id)) fail('DRAFT_ITEM_ID_DUPLICATE');
    ids.add(item.id);
    const entry = ASSET_BY_ID.get(item.asset);
    if (!entry) fail('DRAFT_ITEM_ASSET_UNKNOWN');
    if (entry.kind !== item.kind) fail('DRAFT_ITEM_KIND_MISMATCH');
    const position = item.position;
    if (!position || !Number.isFinite(position.x) || position.x < 0 || position.x > 1
        || !Number.isFinite(position.y) || position.y < 0 || position.y > 1) {
      fail('DRAFT_ITEM_POSITION_INVALID');
    }
    if (!Number.isFinite(item.scale) || item.scale <= 0) fail('DRAFT_ITEM_SCALE_INVALID');
    if (item.direction !== entry.direction) fail('DRAFT_ITEM_DIRECTION_INVALID');
    if (item.layer !== undefined && item.layer !== null
        && (!Number.isFinite(item.layer) || item.layer < 0)) {
      fail('DRAFT_ITEM_LAYER_INVALID');
    }
    if (item.groupId !== undefined && item.groupId !== null
        && (typeof item.groupId !== 'string' || item.groupId.trim().length === 0)) {
      fail('DRAFT_ITEM_GROUP_INVALID');
    }
    // Task E2c: optional layers-panel fields. Missing/null means the default
    // (false/false/null); present values are strictly typed — legacy drafts
    // without the fields keep importing unchanged.
    if (item.locked !== undefined && item.locked !== null && typeof item.locked !== 'boolean') {
      fail('DRAFT_ITEM_LOCKED_INVALID');
    }
    if (item.hidden !== undefined && item.hidden !== null && typeof item.hidden !== 'boolean') {
      fail('DRAFT_ITEM_HIDDEN_INVALID');
    }
    if (item.name !== undefined && item.name !== null
        && (typeof item.name !== 'string' || item.name.trim().length === 0)) {
      fail('DRAFT_ITEM_NAME_INVALID');
    }
    return {
      id: item.id,
      kind: item.kind,
      asset: item.asset,
      position: { x: position.x, y: position.y },
      scale: item.scale,
      direction: item.direction,
      layer: item.layer === undefined || item.layer === null
        ? (DEFAULT_LAYER_BY_KIND[item.kind] ?? 0)
        : item.layer,
      groupId: item.groupId === undefined || item.groupId === null ? null : item.groupId,
      locked: item.locked === undefined || item.locked === null ? false : item.locked,
      hidden: item.hidden === undefined || item.hidden === null ? false : item.hidden,
      name: item.name === undefined || item.name === null ? null : item.name,
    };
  });

  const desks = items.filter((item) => item.kind === 'desk');
  if (desks.length === 0) fail('DRAFT_GROUP_NO_DESK');
  for (const item of items) {
    if (item.kind === 'desk') {
      item.groupId = item.id;
      continue;
    }
    if (item.groupId !== null) continue;
    const ranked = desks
      .map((desk) => ({
        id: desk.id,
        distance: (item.position.x - desk.position.x) ** 2 + (item.position.y - desk.position.y) ** 2,
      }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    if (ranked.length > 1 && Math.abs(ranked[0].distance - ranked[1].distance) <= AMBIGUITY_EPSILON) {
      fail('DRAFT_GROUP_AMBIGUOUS');
    }
    item.groupId = ranked[0].id;
  }

  // Task E3b: rigidGroups is OPTIONAL — {groupId: true}. Absent/null → {};
  // present values must be booleans (DRAFT_RIGID_GROUPS_INVALID).
  let rigidGroups = {};
  if (draft.rigidGroups !== undefined && draft.rigidGroups !== null) {
    if (!draft.rigidGroups || typeof draft.rigidGroups !== 'object' || Array.isArray(draft.rigidGroups)) {
      fail('DRAFT_RIGID_GROUPS_INVALID');
    }
    for (const [key, value] of Object.entries(draft.rigidGroups)) {
      if (typeof value !== 'boolean') fail('DRAFT_RIGID_GROUPS_INVALID');
      if (value) rigidGroups[key] = true;
    }
  }

  // Task E2a: selectedIds is OPTIONAL (schemaVersion stays 1). Present ->
  // filtered to unique known ids (an explicit empty array means NO selection);
  // absent -> derived from the legacy selectedId field. Primary = last entry.
  let selectedId;
  let selectedIds;
  if (Array.isArray(draft.selectedIds)) {
    selectedIds = [...new Set(draft.selectedIds.filter((id) => typeof id === 'string' && ids.has(id)))];
    selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
  } else {
    selectedId = typeof draft.selectedId === 'string' && ids.has(draft.selectedId) ? draft.selectedId : null;
    selectedIds = selectedId ? [selectedId] : [];
  }
  // Task E2e: groupNames is OPTIONAL — {groupId: 显示名}. Absent/null → {};
  // present values must be non-blank strings (DRAFT_GROUP_NAMES_INVALID).
  // Keys may reference any group id; unknown keys are harmless display data.
  let groupNames = {};
  if (draft.groupNames !== undefined && draft.groupNames !== null) {
    if (!draft.groupNames || typeof draft.groupNames !== 'object' || Array.isArray(draft.groupNames)) {
      fail('DRAFT_GROUP_NAMES_INVALID');
    }
    for (const [key, value] of Object.entries(draft.groupNames)) {
      if (typeof value !== 'string' || value.trim().length === 0) fail('DRAFT_GROUP_NAMES_INVALID');
      groupNames[key] = value;
    }
  }
  return { items, selectedId, selectedIds, groupNames, rigidGroups };
}

function createLayoutEditor({ scene }) {
  if (!scene || !(scene.width > 0) || !(scene.height > 0)) throw new TypeError('layout editor requires a positive scene');
  let nextId = 1;
  let items = [];
  let selectedId = null;
  let selectedIds = []; // Task E2a: full ordered selection, primary LAST
  let nudgeState = null; // Task E2a: merge window for arrow-key auto-repeat
  let groupNames = {}; // Task E2e: {groupId: 显示名}
  let nextGroupNumber = 1; // Task E2e: stable group-N ids
  let rigidGroups = {}; // Task E3b: {groupId: true} — "move as one" locks
  const undoStack = [];
  const redoStack = [];

  function snapshot() {
    return {
      items: clone(items),
      selectedId,
      selectedIds: [...selectedIds],
      nextId,
      groupNames: clone(groupNames),
      nextGroupNumber,
      rigidGroups: clone(rigidGroups),
    };
  }
  function restore(state) {
    items = clone(state.items);
    selectedId = state.selectedId;
    selectedIds = [...(state.selectedIds || [])];
    nextId = state.nextId;
    groupNames = clone(state.groupNames || {});
    nextGroupNumber = state.nextGroupNumber || 1;
    rigidGroups = clone(state.rigidGroups || {});
  }
  function record() {
    undoStack.push(snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    nudgeState = null; // a non-nudge mutation always breaks the merge chain
  }
  function find(id) {
    return items.find((item) => item.id === id) || null;
  }
  function autoId() {
    let candidate = `draft-${nextId++}`;
    while (items.some((item) => item.id === candidate)) candidate = `draft-${nextId++}`;
    return candidate;
  }
  function add(input = {}) {
    record();
    const item = {
      id: input.id || autoId(),
      kind: String(input.kind || 'prop'),
      asset: String(input.asset || 'unknown'),
      position: { x: clamp(input.x), y: clamp(input.y) },
      scale: Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1,
      direction: input.direction || 'front',
      layer: DEFAULT_LAYER_BY_KIND[input.kind] ?? 0,
      groupId: null,
      locked: false,
      hidden: false,
      name: null,
    };
    items.push(item);
    selectedId = item.id;
    selectedIds = [item.id];
    return clone(item);
  }
  function move(id, dxPx, dyPx, options = {}) {
    const item = find(id);
    // Task E2c: locked items are selectable (panel locate) but never movable —
    // inspector position edits count as dragging too (see moveTo).
    if (!item || item.locked) return null;
    let dxn = (Number(dxPx) || 0) / scene.width;
    let dyn = (Number(dyPx) || 0) / scene.height;
    if (options.grid) { dxn = snapToGrid(dxn, options.grid); dyn = snapToGrid(dyn, options.grid); }
    const nx = clamp(item.position.x + dxn);
    const ny = clamp(item.position.y + dyn);
    if (nx === item.position.x && ny === item.position.y) return clone(item); // 无实际变更不记录
    if (options.recordHistory !== false) record();
    item.position = { x: nx, y: ny };
    selectedId = id;
    if (!selectedIds.includes(id)) selectedIds = [id];
    return clone(item);
  }
  // Group moves apply ONE effective delta to every member: the requested
  // delta is truncated against the group's bounding box so no member leaves
  // [0,1] and relative offsets can never compress. A fully truncated move
  // (effective delta 0 on both axes) is a stable no-op that records no
  // history, so dragging against a wall never pollutes undo.
  function moveGroup(groupId, dxPx, dyPx, options = {}) {
    const members = items.filter((item) => item.groupId === groupId);
    if (members.length === 0) return null;
    // Task E2c semantic lock: a group with ANY locked member refuses the
    // WHOLE drag. Skipping locked members would tear the workstation apart
    // (group coherence is the reason groups exist), and a partial move can
    // never be un-done intuitively. Rejected calls record no history.
    if (members.some((item) => item.locked)) return null;
    const requestedDx = (Number(dxPx) || 0) / scene.width;
    const requestedDy = (Number(dyPx) || 0) / scene.height;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const item of members) {
      minX = Math.min(minX, item.position.x);
      maxX = Math.max(maxX, item.position.x);
      minY = Math.min(minY, item.position.y);
      maxY = Math.max(maxY, item.position.y);
    }
    let effectiveDx = Math.min(1 - maxX, Math.max(-minX, requestedDx));
    let effectiveDy = Math.min(1 - maxY, Math.max(-minY, requestedDy));
    if (options.grid) { effectiveDx = snapToGrid(effectiveDx, options.grid); effectiveDy = snapToGrid(effectiveDy, options.grid); }
    // Task E2b-R1: group drags gain the SAME smart-guide semantics as
    // applySelectionDelta — the moving bbox's left/centerX/right and
    // top/centerY/bottom snap to the nearest other-item line within the
    // threshold; matched lines are reported via dragGuides().
    lastDragGuides = { vertical: [], horizontal: [] };
    if (options.guides) {
      const extents = options.extents || {};
      const half = (item) => extents[item.id] || { x: 0, y: 0 };
      const thresholdX = Number.isFinite(options.guideThreshold) ? options.guideThreshold : 0;
      const thresholdY = Number.isFinite(options.guideThresholdY) ? options.guideThresholdY : thresholdX;
      const movingEdges = { x: [minX, (minX + maxX) / 2, maxX], y: [minY, (minY + maxY) / 2, maxY] };
      const candidatesX = [];
      const candidatesY = [];
      for (const item of items) {
        if (item.groupId === groupId) continue;
        const h = half(item);
        candidatesX.push(item.position.x - h.x, item.position.x, item.position.x + h.x);
        candidatesY.push(item.position.y - h.y, item.position.y, item.position.y + h.y);
      }
      const nearest = (edges, lines, threshold) => {
        let best = null;
        for (const edge of edges) {
          for (const line of lines) {
            const post = edge + effectiveDx;
            const diff = line - post;
            if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, line };
          }
        }
        return best;
      };
      const verticalBest = nearest(movingEdges.x, candidatesX, thresholdX);
      const horizontalBest = nearest(movingEdges.y, candidatesY, thresholdY);
      if (verticalBest) { effectiveDx += verticalBest.diff; lastDragGuides.vertical.push(verticalBest.line); }
      if (horizontalBest) { effectiveDy += horizontalBest.diff; lastDragGuides.horizontal.push(horizontalBest.line); }
    }
    if (effectiveDx === 0 && effectiveDy === 0) return clone(members);
    if (options.recordHistory !== false) record();
    for (const item of members) {
      item.position.x = clamp(item.position.x + effectiveDx);
      item.position.y = clamp(item.position.y + effectiveDy);
    }
    return clone(members);
  }
  // Task E2a: typed scale input is STRICT — values outside [0.2, 3] are
  // rejected (null); a same-value call is a no-op and records nothing.
  function setScale(id, scale, options = {}) {
    // Task E2c: locked items cannot be scaled either.
    const item = find(id);
    if (!item || item.locked || !Number.isFinite(scale) || scale < 0.2 || scale > 3) return null;
    if (item.scale === scale) return clone(item);
    if (options.recordHistory !== false) record();
    item.scale = scale;
    return clone(item);
  }

  // Task E2a: the multi-select analogue of moveGroup — ONE effective delta
  // truncated by the union bounding box of the selected positions, relative
  // offsets preserved; a fully truncated or zero move records nothing.
  function moveSelection(dxPx, dyPx, options = {}) {
    const dx = (Number(dxPx) || 0) / scene.width;
    const dy = (Number(dyPx) || 0) / scene.height;
    return applySelectionDelta(dx, dy, options);
  }

  let lastDragGuides = { vertical: [], horizontal: [] };
  function applySelectionDelta(dx, dy, options) {
    // Task E2a: moving a group member moves its WHOLE group — workstation
    // coherence wins over strict item selection, exactly like the single drag.
    const moveSet = new Set(selectedIds);
    for (const item of items) {
      if (moveSet.has(item.id) && item.groupId !== null) {
        for (const member of items) {
          if (member.groupId === item.groupId) moveSet.add(member.id);
        }
      }
    }
    const selected = items.filter((item) => moveSet.has(item.id));
    if (selected.length === 0) return null;
    // Task E2c: a multi-select drag (or arrow nudge) with ANY locked member —
    // directly selected or pulled in by group expansion — is rejected
    // atomically. Same contract as moveGroup: no partial moves, no history.
    if (selected.some((item) => item.locked)) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const item of selected) {
      minX = Math.min(minX, item.position.x);
      maxX = Math.max(maxX, item.position.x);
      minY = Math.min(minY, item.position.y);
      maxY = Math.max(maxY, item.position.y);
    }
    let effX = Math.min(1 - maxX, Math.max(-minX, dx));
    let effY = Math.min(1 - maxY, Math.max(-minY, dy));
    if (options.grid) { effX = snapToGrid(effX, options.grid); effY = snapToGrid(effY, options.grid); }
    // Task E2b: smart guides — the moving selection's left/centerX/right and
    // top/centerY/bottom snap to the NEAREST other-item line within the
    // threshold; matched lines are reported for the page to draw. Guides are
    // drag-only state, replaced by the next non-guide delta.
    lastDragGuides = { vertical: [], horizontal: [] };
    if (options.guides) {
      const extents = options.extents || {};
      const half = (item) => extents[item.id] || { x: 0, y: 0 };
      const thresholdX = Number.isFinite(options.guideThreshold) ? options.guideThreshold : 0;
      const thresholdY = Number.isFinite(options.guideThresholdY) ? options.guideThresholdY : thresholdX;
      const movingEdges = { x: [minX, (minX + maxX) / 2, maxX], y: [minY, (minY + maxY) / 2, maxY] };
      const candidatesX = [];
      const candidatesY = [];
      for (const item of items) {
        if (moveSet.has(item.id)) continue;
        const h = half(item);
        candidatesX.push(item.position.x - h.x, item.position.x, item.position.x + h.x);
        candidatesY.push(item.position.y - h.y, item.position.y, item.position.y + h.y);
      }
      const nearest = (edges, lines, threshold) => {
        let best = null;
        for (const edge of edges) {
          for (const line of lines) {
            const post = edge + effX;
            const diff = line - post;
            if (Math.abs(diff) <= threshold && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, line };
          }
        }
        return best;
      };
      const verticalBest = nearest(movingEdges.x, candidatesX, thresholdX);
      const horizontalBest = nearest(movingEdges.y, candidatesY, thresholdY);
      if (verticalBest) { effX += verticalBest.diff; lastDragGuides.vertical.push(verticalBest.line); }
      if (horizontalBest) { effY += horizontalBest.diff; lastDragGuides.horizontal.push(horizontalBest.line); }
    }
    if (effX === 0 && effY === 0) return null;
    if (options.recordHistory !== false) record();
    for (const item of selected) {
      item.position.x = clamp(item.position.x + effX);
      item.position.y = clamp(item.position.y + effY);
    }
    return selected.map(clone);
  }
  function dragGuides() {
    return { vertical: [...lastDragGuides.vertical], horizontal: [...lastDragGuides.horizontal] };
  }

  // Task E2b: alignment — every selected item's x (or y) moves to the shared
  // min/max/midpoint of the selection. One undo unit; no-change = no record.
  function alignSelection(mode) {
    const axis = mode === 'left' || mode === 'right' || mode === 'centerX' ? 'x'
      : mode === 'top' || mode === 'bottom' || mode === 'centerY' ? 'y' : null;
    if (!axis) return null;
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length < 2) return null;
    // Task E2c: aligning with a locked member in the selection is rejected
    // whole — silently aligning a subset would break the locked contract.
    if (selected.some((item) => item.locked)) return null;
    const values = selected.map((item) => item.position[axis]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const target = mode === 'left' || mode === 'top' ? min
      : mode === 'right' || mode === 'bottom' ? max
      : (min + max) / 2;
    if (selected.every((item) => item.position[axis] === target)) return null;
    record();
    for (const item of selected) item.position[axis] = target;
    return selected.map(clone);
  }

  // Task E2b: distribution — with >= 3 selected, the inner items move to the
  // equidistant positions between the outer pair along one axis. One undo
  // unit; an already-even or too-small selection records nothing.
  function distributeSelection(axis) {
    if (axis !== 'x' && axis !== 'y') return null;
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length < 3) return null;
    // Task E2c: distributing with a locked member in the selection is
    // rejected whole (atomic, like align).
    if (selected.some((item) => item.locked)) return null;
    const ordered = [...selected].sort((a, b) => a.position[axis] - b.position[axis]);
    const first = ordered[0].position[axis];
    const last = ordered[ordered.length - 1].position[axis];
    const step = (last - first) / (ordered.length - 1);
    const targets = ordered.map((item, index) => ({ item, target: first + step * index }));
    if (targets.every(({ item, target }) => item.position[axis] === target)) return null;
    record();
    for (const { item, target } of targets) item.position[axis] = target;
    return selected.map(clone);
  }

  // Task E2a: arrow-key nudges take NORMALIZED deltas (arrow = 0.001,
  // shift+arrow = 0.01) and merge into ONE undo unit while the same key
  // auto-repeats inside the 300ms window; another key or an expired window
  // starts a fresh unit. `now` is injected by the caller for determinism.
  const NUDGE_MERGE_MS = 300;
  // Task E2b: nudges deliberately pass NO grid/guides options — keyboard
  // stepping stays at the exact 0.001 / 0.01 precision.
  function nudgeSelection(dx, dy, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : 0;
    const key = typeof options.mergeKey === 'string' ? options.mergeKey : 'nudge';
    const merged = nudgeState !== null && nudgeState.key === key && now - nudgeState.at <= NUDGE_MERGE_MS;
    const moved = applySelectionDelta(Number(dx) || 0, Number(dy) || 0, { recordHistory: merged ? false : options.recordHistory });
    nudgeState = { key, at: now };
    return moved;
  }

  // Task E2a: uniform corner-handle scaling. The opposite corner stays fixed,
  // the center moves by the scale ratio, the target is clamped to [0.2, 3]
  // (clamp mode) or rejected when out of range (strict/typed mode), and the
  // result is bounded to the canvas via the caller-supplied normalized
  // half-extent. One scale value drives both axes — baked isometric art can
  // never stretch. A no-change call records nothing.
  function scaleItem(id, nextScale, options = {}) {
    const item = find(id);
    // Task E2c: locked items cannot be scaled from the corner handles.
    if (!item || item.locked || !Number.isFinite(nextScale)) return null;
    const target = options.clamp === false ? nextScale : Math.min(3, Math.max(0.2, nextScale));
    if (!Number.isFinite(target) || target < 0.2 || target > 3) return null;
    const ratio = target / item.scale;
    const corner = options.fixedCorner;
    let cx = item.position.x;
    let cy = item.position.y;
    if (corner && Number.isFinite(corner.x) && Number.isFinite(corner.y)) {
      cx = corner.x + (cx - corner.x) * ratio;
      cy = corner.y + (cy - corner.y) * ratio;
    }
    const extent = options.extent;
    // a half-extent >= 0.5 means the item cannot fit the canvas at all —
    // fall back to the coarse center clamp instead of an inverted range.
    const extentUsable = extent && Number.isFinite(extent.x) && Number.isFinite(extent.y)
      && extent.x > 0 && extent.y > 0 && extent.x < 0.5 && extent.y < 0.5;
    if (extentUsable) {
      cx = Math.min(1 - extent.x, Math.max(extent.x, cx));
      cy = Math.min(1 - extent.y, Math.max(extent.y, cy));
    } else {
      cx = clamp(cx);
      cy = clamp(cy);
    }
    if (target === item.scale && cx === item.position.x && cy === item.position.y) return clone(item);
    if (options.recordHistory !== false) record();
    item.scale = target;
    item.position = { x: cx, y: cy };
    return clone(item);
  }

  // Task E2a inspector: absolute position set (clamped, no-change = no record).
  function moveTo(id, x, y, options = {}) {
    const item = find(id);
    // Task E2c: typing coordinates is dragging by another name — locked
    // items keep their position until unlocked.
    if (!item || item.locked || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const nx = clamp(x);
    const ny = clamp(y);
    if (nx === item.position.x && ny === item.position.y) return clone(item);
    if (options.recordHistory !== false) record();
    item.position = { x: nx, y: ny };
    return clone(item);
  }

  function setItemLayer(id, layer, options = {}) {
    const item = find(id);
    if (!item || !Number.isFinite(layer) || layer < 0) return null;
    if (item.layer === layer) return clone(item);
    if (options.recordHistory !== false) record();
    item.layer = layer;
    return clone(item);
  }

  // Task E2a inspector: direction switches stay INSIDE the asset family — the
  // target asset is the current prefix + the new direction and must exist in
  // the catalog with the same kind. asset+direction are rewritten together;
  // id/groupId/kind are untouched. No-change switches record nothing.
  function setItemDirection(id, direction, options = {}) {
    const item = find(id);
    if (!item || typeof direction !== 'string' || direction.length === 0) return null;
    const prefix = item.asset.slice(0, item.asset.length - item.direction.length);
    const nextAsset = prefix + direction;
    const entry = ASSET_BY_ID.get(nextAsset);
    if (!entry || entry.kind !== item.kind || entry.direction !== direction) return null;
    if (nextAsset === item.asset) return clone(item);
    if (options.recordHistory !== false) record();
    item.asset = nextAsset;
    item.direction = direction;
    return clone(item);
  }
  function swap(id, offset) {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const target = index + offset;
    if (target < 0 || target >= items.length) return clone(items[index]);
    record();
    [items[index], items[target]] = [items[target], items[index]];
    return clone(items[target]);
  }

  // Task E2c — layers-panel metadata APIs. Each mutation is EXACTLY ONE undo
  // unit; a call that changes nothing (same value, unknown id, invalid input)
  // records nothing. They deliberately stay available on LOCKED items: the
  // locked contract freezes geometry + deletion (drag/scale/remove/align/
  // distribute/nudge), while naming, visibility and the lock flag itself are
  // panel metadata that must stay editable (otherwise a locked item could
  // never be unlocked or renamed).
  function setItemLocked(id, locked, options = {}) {
    const item = find(id);
    if (!item || typeof locked !== 'boolean') return null;
    if (item.locked === locked) return clone(item);
    if (options.recordHistory !== false) record();
    item.locked = locked;
    return clone(item);
  }
  function setItemHidden(id, hidden, options = {}) {
    const item = find(id);
    if (!item || typeof hidden !== 'boolean') return null;
    if (item.hidden === hidden) return clone(item);
    if (options.recordHistory !== false) record();
    item.hidden = hidden;
    return clone(item);
  }
  function renameItem(id, name, options = {}) {
    const item = find(id);
    if (!item) return null;
    // name is null (falls back to the asset label in the panel) or a
    // non-blank string; everything else is rejected untouched.
    const valid = name === null || (typeof name === 'string' && name.trim().length > 0);
    if (!valid) return null;
    if (item.name === name) return clone(item);
    if (options.recordHistory !== false) record();
    item.name = name;
    return clone(item);
  }

  // Task E2c — absolute z-order move. z-order IS the items array order
  // (index 0 paints first = backmost). The anchor lands at EXACTLY `index`
  // in the resulting array (absolute-move semantics); when a multi-select
  // block is dropped near the bottom edge it clamps up so it still fits
  // whole, internal order preserved. Bounds are validated against the
  // CURRENT length — out-of-range targets are rejected (null), never
  // clamped for single items. Multi-selection moves the CONTIGUOUS selected
  // block containing `id` as one unit; other blocks stay put. Locked items
  // remain reorderable: z-order is panel organization, not geometry. A call
  // that changes nothing records nothing.
  function moveItemToIndex(id, index, options = {}) {
    const from = items.findIndex((item) => item.id === id);
    if (from < 0) return null;
    if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
    const selectedSet = new Set(selectedIds);
    let first = from;
    let last = from;
    while (first > 0 && selectedSet.has(items[first - 1].id)) first -= 1;
    while (last < items.length - 1 && selectedSet.has(items[last + 1].id)) last += 1;
    const unit = items.slice(first, last + 1);
    const unitIds = new Set(unit.map((item) => item.id));
    const rest = items.filter((item) => !unitIds.has(item.id));
    // a block wider than the remaining items pins to the requested edge
    // (never a negative insertion index)
    const target = Math.max(0, Math.min(index, rest.length - (unit.length - 1)));
    const next = [...rest.slice(0, target), ...unit, ...rest.slice(target)];
    const unchanged = next.every((item, i) => item.id === items[i].id);
    if (unchanged) return unit.map(clone);
    if (options.recordHistory !== false) record();
    items = next;
    return items.filter((item) => unitIds.has(item.id)).map(clone);
  }

  // Task E3b — VISUAL depth order. Paint order is the (layer, array index)
  // pair, so the raw array buttons could never change occlusion between
  // items with DIFFERENT layers (the user feedback after E2e). These four ops
  // work on the visual full order instead:
  // - moveVisualUp/moveVisualDown: swap with the visual NEIGHBOUR — same
  //   layer → swap the array positions, different layers → swap the two layer
  //   VALUES (nothing else moves, z-index follows).
  // - bringVisualToFront/sendVisualToBack: lift beyond the current max (or
  //   below the min, clamped at 0) AND move the item to the array end/start
  //   so panel order, array order and paint order stay consistent.
  // Each op is EXACTLY ONE undo unit; a call at the visual edge (already
  // front/back) changes nothing and records nothing.
  function visualLess(a, b) {
    const ia = items.indexOf(a);
    const ib = items.indexOf(b);
    return a.layer < b.layer || (a.layer === b.layer && ia < ib);
  }
  function visualNeighbour(id, above) {
    const item = find(id);
    if (!item) return null;
    let neighbour = null;
    for (const other of items) {
      if (other === item) continue;
      const isNeighbourSide = above ? visualLess(item, other) : visualLess(other, item);
      if (!isNeighbourSide) continue;
      // keep the CLOSEST neighbour on the requested side: above → the
      // SMALLEST of those above; below → the LARGEST of those below.
      if (!neighbour || (above ? visualLess(other, neighbour) : visualLess(neighbour, other))) {
        neighbour = other;
      }
    }
    return neighbour;
  }
  function swapVisualWithNeighbour(item, neighbour) {
    if (neighbour.layer === item.layer) {
      const i = items.indexOf(item);
      const j = items.indexOf(neighbour);
      items[i] = neighbour;
      items[j] = item;
    } else {
      const layer = item.layer;
      item.layer = neighbour.layer;
      neighbour.layer = layer;
    }
  }
  function moveVisualUp(id, options = {}) {
    const item = find(id);
    if (!item) return null;
    const neighbour = visualNeighbour(id, true);
    if (!neighbour) return null;
    if (options.recordHistory !== false) record();
    swapVisualWithNeighbour(item, neighbour);
    return { item: clone(item), neighbour: clone(neighbour) };
  }
  function moveVisualDown(id, options = {}) {
    const item = find(id);
    if (!item) return null;
    const neighbour = visualNeighbour(id, false);
    if (!neighbour) return null;
    if (options.recordHistory !== false) record();
    swapVisualWithNeighbour(item, neighbour);
    return { item: clone(item), neighbour: clone(neighbour) };
  }
  function bringVisualToFront(id, options = {}) {
    const item = find(id);
    if (!item) return null;
    if (!visualNeighbour(id, true)) return null; // already the visual front
    if (options.recordHistory !== false) record();
    const maxLayer = items.reduce((max, other) => Math.max(max, other.layer), 0);
    item.layer = maxLayer + 1;
    items.splice(items.indexOf(item), 1);
    items.push(item);
    return clone(item);
  }
  function sendVisualToBack(id, options = {}) {
    const item = find(id);
    if (!item) return null;
    if (!visualNeighbour(id, false)) return null; // already the visual back
    if (options.recordHistory !== false) record();
    const minOthers = items.reduce((min, other) => (other === item ? min : Math.min(min, other.layer)), Infinity);
    item.layer = minOthers > 0 ? minOthers - 1 : Math.min(item.layer, minOthers);
    items.splice(items.indexOf(item), 1);
    items.unshift(item);
    return clone(item);
  }

  // Task E2e — material groups. A group is ONLY the marquee/drag/panel-section
  // unit: members keep painting by their own (layer, array order) depth, and
  // dragging any member still moves the whole group rigidly, refusing the
  // WHOLE move when any member is locked (both pre-existing semantics). Each
  // group op is EXACTLY ONE undo unit; a call that changes nothing records
  // nothing. groupId is NEVER rewritten by moves/edits (stable identity).
  function autoGroupId() {
    let candidate = `group-${nextGroupNumber}`;
    while (items.some((item) => item.groupId === candidate)) candidate = `group-${nextGroupNumber += 1}`;
    nextGroupNumber += 1;
    return candidate;
  }
  // 编组: every selected item joins ONE new stable group-N id. Existing
  // groupIds (desk groups, older material groups) are replaced for the
  // selected items only.
  function groupSelection(options = {}) {
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length === 0) return null;
    const groupId = autoGroupId();
    if (options.recordHistory !== false) record();
    for (const item of selected) item.groupId = groupId;
    return { groupId, items: selected.map(clone) };
  }
  // 解组: clears groupId on every SELECTED item that has one; selections
  // without groups (or an empty selection) are a no-op. Also serves as the
  // "移出某组" operation (leaving a group = groupId null).
  function ungroupSelection(options = {}) {
    const selected = items.filter((item) => selectedIds.includes(item.id) && item.groupId !== null);
    if (selected.length === 0) return null;
    if (options.recordHistory !== false) record();
    for (const item of selected) item.groupId = null;
    return selected.map(clone);
  }
  // 面板组头「解组」: clears groupId on the WHOLE group, selection untouched.
  function ungroupGroup(groupId, options = {}) {
    if (typeof groupId !== 'string' || groupId.length === 0) return null;
    const members = items.filter((item) => item.groupId === groupId);
    if (members.length === 0) return null;
    if (options.recordHistory !== false) record();
    for (const item of members) item.groupId = null;
    return members.map(clone);
  }
  // 将选中项加入既有组: the target group must exist (some item carries the
  // id); members already inside are skipped; nothing to change → no record.
  function addSelectionToGroup(groupId, options = {}) {
    if (typeof groupId !== 'string' || groupId.length === 0) return null;
    if (!items.some((item) => item.groupId === groupId)) return null;
    const targets = items.filter((item) => selectedIds.includes(item.id) && item.groupId !== groupId);
    if (targets.length === 0) return null;
    if (options.recordHistory !== false) record();
    for (const item of targets) item.groupId = groupId;
    return targets.map(clone);
  }
  // 组重命名: display-only (groupNames map); null clears the custom name so
  // the panel falls back to the raw groupId. One undo unit.
  function renameGroup(groupId, name, options = {}) {
    if (typeof groupId !== 'string' || groupId.length === 0) return null;
    const valid = name === null || (typeof name === 'string' && name.trim().length > 0);
    if (!valid) return null;
    if ((groupNames[groupId] ?? null) === name) return clone(groupNames);
    if (options.recordHistory !== false) record();
    if (name === null) delete groupNames[groupId];
    else groupNames[groupId] = name;
    return clone(groupNames);
  }

  // Task E3b — per-group "move as one" lock. LOOSE (default): dragging a
  // member on the canvas moves only that member; RIGID (locked): dragging a
  // member moves the whole group via moveGroup. Pure group metadata — one
  // undo unit, no-change records nothing. isGroupMoveRigid is what the page
  // consults per drag.
  function setGroupMoveRigid(groupId, rigid, options = {}) {
    if (typeof groupId !== 'string' || groupId.length === 0 || typeof rigid !== 'boolean') return null;
    if (!items.some((item) => item.groupId === groupId)) return null;
    if (!!rigidGroups[groupId] === rigid) return clone(rigidGroups);
    if (options.recordHistory !== false) record();
    if (rigid) rigidGroups[groupId] = true;
    else delete rigidGroups[groupId];
    return clone(rigidGroups);
  }
  function isGroupMoveRigid(groupId) {
    return !!rigidGroups[groupId];
  }

  function bringForward(id) {
    return swap(id, 1);
  }
  function sendBackward(id) {
    return swap(id, -1);
  }
  function remove(id) {
    const item = find(id);
    // Task E2c: locked items cannot be deleted (single-item path).
    if (!item || item.locked) return null;
    const index = items.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    record();
    const [removed] = items.splice(index, 1);
    selectedIds = selectedIds.filter((entry) => entry !== id);
    // Task E2a-R1: removing the primary falls the primary back to the last
    // remaining selected item — never ids-nonempty with primary=null.
    if (selectedId === id) selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    return clone(removed);
  }
  // Task E2a: clone every selected item (fresh auto ids, +0.01/+0.01); all
  // clones from one source group share ONE new group id; the clones become
  // the selection; exactly one undo unit. Task E2c: duplication is a
  // NON-destructive op, so locked items clone fine and the copies inherit
  // locked/hidden/name verbatim (a hidden source yields a hidden clone).
  function duplicateSelection() {
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length === 0) return [];
    record();
    const groupMapping = new Map();
    const clones = [];
    for (const item of selected) {
      const copied = clone(item);
      copied.id = autoId();
      copied.position = { x: clamp(item.position.x + 0.01), y: clamp(item.position.y + 0.01) };
      if (item.groupId !== null) {
        if (!groupMapping.has(item.groupId)) {
          let candidate = `copy-of-${item.groupId}`;
          let suffix = 2;
          const taken = (gid) => items.some((entry) => entry.groupId === gid)
            || clones.some((entry) => entry.groupId === gid)
            || [...groupMapping.values()].includes(gid);
          while (taken(candidate)) candidate = `copy-of-${item.groupId}-${suffix += 1}`;
          groupMapping.set(item.groupId, candidate);
        }
        copied.groupId = groupMapping.get(item.groupId);
      }
      clones.push(copied);
    }
    items.push(...clones);
    selectedIds = clones.map((entry) => entry.id);
    selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    return clones.map(clone);
  }

  function removeSelection() {
    const selected = items.filter((item) => selectedIds.includes(item.id));
    if (selected.length === 0) return [];
    // Task E2c: locked members survive deletion (删除 skips them, it is not
    // rejected whole — deleting a mixed box-selection should still clear the
    // unlocked rest). Locked survivors stay selected; an all-locked selection
    // is a no-op that records nothing.
    const removed = selected.filter((item) => !item.locked);
    if (removed.length === 0) return [];
    record();
    const removedIds = new Set(removed.map((item) => item.id));
    items = items.filter((item) => !removedIds.has(item.id));
    selectedIds = selectedIds.filter((entry) => !removedIds.has(entry));
    selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    return removed.map(clone);
  }

  // Task E2a: layer ops generalize swap() to SELECTION BLOCKS — each run of
  // consecutive selected items swaps one step as a unit; edge-blocked ops
  // change nothing and record nothing. One undo unit per call.
  function selectionBlocks(selectedSet) {
    const blocks = [];
    let index = 0;
    while (index < items.length) {
      if (!selectedSet.has(items[index].id)) { index += 1; continue; }
      const block = [];
      while (index < items.length && selectedSet.has(items[index].id)) { block.push(index); index += 1; }
      blocks.push(block);
    }
    return blocks;
  }
  function moveSelectionLayer(direction) {
    const selectedSet = new Set(selectedIds);
    const blocks = selectionBlocks(selectedSet);
    const swaps = [];
    if (direction > 0) {
      for (let b = blocks.length - 1; b >= 0; b -= 1) {
        const block = blocks[b];
        const next = block[block.length - 1] + 1;
        if (next >= items.length || selectedSet.has(items[next].id)) continue;
        for (let i = block[block.length - 1]; i >= block[0]; i -= 1) swaps.push([i, i + 1]);
      }
    } else {
      for (const block of blocks) {
        const prev = block[0] - 1;
        if (prev < 0 || selectedSet.has(items[prev].id)) continue;
        for (let i = block[0]; i <= block[block.length - 1]; i += 1) swaps.push([i, i - 1]);
      }
    }
    if (swaps.length === 0) return null;
    record(); // pre-mutation snapshot: undo must revert the whole block move
    for (const [a, b] of swaps) {
      const tmp = items[b];
      items[b] = items[a];
      items[a] = tmp;
    }
    return items.filter((item) => selectedSet.has(item.id)).map(clone);
  }
  function bringForwardSelection() { return moveSelectionLayer(1); }
  function sendBackwardSelection() { return moveSelectionLayer(-1); }

  // Task E2a: selection model — pure selection changes are NOT undo units
  // (undo/redo still RESTORES the selection carried by each snapshot).
  function selectionState() {
    return {
      ids: [...selectedIds],
      primaryId: selectedId,
      items: items.filter((item) => selectedIds.includes(item.id)).map(clone),
    };
  }
  function setSelection(ids) {
    const known = new Set(items.map((item) => item.id));
    selectedIds = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && known.has(id)))];
    selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    return selectionState();
  }
  function toggleSelection(id) {
    if (!items.some((item) => item.id === id)) return selectionState();
    if (selectedIds.includes(id)) {
      selectedIds = selectedIds.filter((entry) => entry !== id);
      selectedId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] : null;
    } else {
      selectedIds.push(id);
      selectedId = id;
    }
    return selectionState();
  }
  // Task E2c: hidden items are not canvas-present — select-all never picks
  // them up. They remain reachable through explicit panel selection.
  function selectAll() { return setSelection(items.filter((item) => !item.hidden).map((item) => item.id)); }
  // Task E2a: pressing a member of a LIVE multi-selection keeps the selection
  // (drag continues as a whole); the primary moves to the pressed item.
  function selectKeeping(id) {
    if (!items.some((item) => item.id === id)) return selectionState();
    selectedIds = selectedIds.filter((entry) => entry !== id);
    selectedIds.push(id);
    selectedId = id;
    return selectionState();
  }
  function clearSelection() {
    selectedIds = [];
    selectedId = null;
    return selectionState();
  }

  function load(draft, options = {}) {
    let parsed;
    try {
      parsed = parseDraft(draft);
    } catch (error) {
      return { ok: false, code: error && error.code ? error.code : 'DRAFT_INVALID' };
    }
    // Task 8: the production boot import passes recordHistory:false — the
    // initial layout is not a user edit, so undo/redo units stay the user's
    // group moves; a failed import records nothing either way.
    if (options.recordHistory !== false) record();
    items = parsed.items;
    selectedId = parsed.selectedId;
    selectedIds = parsed.selectedIds;
    groupNames = parsed.groupNames || {};
    rigidGroups = parsed.rigidGroups || {};
    for (const item of items) {
      const match = AUTO_ID_PATTERN.exec(item.id);
      if (match) nextId = Math.max(nextId, Number(match[1]) + 1);
      // Task E2e: generated group-N ids continue past imported ones
      const groupMatch = GROUP_ID_PATTERN.exec(item.groupId || '');
      if (groupMatch) nextGroupNumber = Math.max(nextGroupNumber, Number(groupMatch[1]) + 1);
    }
    return { ok: true, count: items.length };
  }
  function undo() {
    const state = undoStack.pop();
    if (!state) return selected();
    redoStack.push(snapshot());
    restore(state);
    return selected();
  }
  function redo() {
    const state = redoStack.pop();
    if (!state) return selected();
    undoStack.push(snapshot());
    restore(state);
    return selected();
  }
  function select(id) {
    return setSelection([id]);
  }
  function selected() { return selectedId ? clone(find(selectedId)) : null; }
  function toJSON() {
    return {
      schemaVersion: SCHEMA_VERSION,
      scene: { ...scene },
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        asset: item.asset,
        position: { x: item.position.x, y: item.position.y },
        scale: item.scale,
        direction: item.direction,
        layer: item.layer,
        groupId: item.groupId,
        locked: item.locked,
        hidden: item.hidden,
        name: item.name,
      })),
      selectedId,
      selectedIds: [...selectedIds],
      groupNames: clone(groupNames),
      rigidGroups: clone(rigidGroups),
    };
  }

  // Task 8: the stateless schema-v1 probe behind the production layout boot
  // priority chain (office-boot.resolveProductionLayoutDraft). Same rules as
  // load(), but it never touches editor state and returns a stable result
  // object instead of throwing.
  function validateDraftSchema(draft) {
    try {
      const parsed = parseDraft(draft);
      return { ok: true, count: parsed.items.length, code: null };
    } catch (error) {
      return { ok: false, count: 0, code: error && error.code ? error.code : 'DRAFT_INVALID' };
    }
  }

  const selection = selectionState; // Task E2a public alias
  return Object.freeze({
    add, move, moveGroup, setScale, bringForward, sendBackward, remove, load,
    undo, redo, select, selected, toJSON, validateDraftSchema,
    selection, setSelection, toggleSelection, selectAll, clearSelection, selectKeeping,
    moveSelection, duplicateSelection, removeSelection,
    bringForwardSelection, sendBackwardSelection,
    scaleItem, moveTo, setItemLayer, setItemDirection, nudgeSelection,
    alignSelection, distributeSelection, dragGuides,
    setItemLocked, setItemHidden, renameItem, moveItemToIndex,
    groupSelection, ungroupSelection, ungroupGroup, addSelectionToGroup, renameGroup,
    moveVisualUp, moveVisualDown, bringVisualToFront, sendVisualToBack,
    setGroupMoveRigid, isGroupMoveRigid,
  });
}

// Task E2b: pure canvas view transform for the editor page. Coordinates:
// px/py are canvas CSS pixels (the canvas element itself is never
// transformed); nx/ny are draft-normalized [0,1]. zoomAt keeps the canvas
// point under the cursor fixed while the scale changes.
function createCanvasView(width, height) {
  if (!width || !(width > 0) || !height || !(height > 0)) throw new TypeError('createCanvasView requires positive sizes');
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const clampScale = (value) => Math.min(8, Math.max(0.2, value));
  const view = {
    get: () => ({ scale, tx, ty }),
    set(next = {}) {
      if (next.scale !== undefined) scale = clampScale(next.scale);
      if (next.tx !== undefined) tx = next.tx;
      if (next.ty !== undefined) ty = next.ty;
      return view.get();
    },
    zoomAt(px, py, factor) {
      const s2 = clampScale(scale * (Number.isFinite(factor) && factor > 0 ? factor : 1));
      const pointX = Number(px) || 0;
      const pointY = Number(py) || 0;
      tx = pointX - (pointX - tx) * (s2 / scale);
      ty = pointY - (pointY - ty) * (s2 / scale);
      scale = s2;
      return view.get();
    },
    panBy(dx, dy) {
      tx += Number(dx) || 0;
      ty += Number(dy) || 0;
      return view.get();
    },
    reset() {
      scale = 1;
      tx = 0;
      ty = 0;
      return view.get();
    },
    // Task E2b-R1: re-baseline the coordinate space to the LIVE canvas size
    // (the canvas box varies with the window; the scene reference does not).
    // Invalid sizes are ignored so a transient 0x0 rect never corrupts math.
    setSize(nextWidth, nextHeight) {
      if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || nextWidth <= 0 || nextHeight <= 0) return view.get();
      width = nextWidth;
      height = nextHeight;
      return view.get();
    },
    getSize: () => ({ width, height }),
    toNormalized(px, py) {
      return { x: (px - tx) / (scale * width), y: (py - ty) / (scale * height) };
    },
    toCanvas(nx, ny) {
      return { x: tx + nx * scale * width, y: ty + ny * scale * height };
    },
  };
  return view;
}

module.exports = { createLayoutEditor, createCanvasView };
