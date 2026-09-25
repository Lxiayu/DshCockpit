'use strict';

// src/office/layout-schema.js — schema-v1 draft validation (pure module).
//
// P5/B-1 (2026-09-23): the production-required slice of the layout EDITOR
// core moved here (docs/strategy/2026-09-23-p5-deletion-inventory.md §3).
// The production boot chain (office.html ->
// office-boot.resolveProductionLayoutDraft, the saved > bundled layout
// priority gate) only ever needed this stateless validator — never the
// editor UI. This module is that single source of truth.
//
// Purity: no DOM, no Electron, no Pixi, no filesystem, no network. The only
// dependency is the layout-assets catalog, which validates imported
// schema-v1 drafts (kind/asset/direction must match a declared asset).
//
// schema-v1 validation contract (moved verbatim from layout-editor.js):
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
// - Task E3b: rigidGroups is OPTIONAL — {groupId: true}.
//
// The editor core (src/office/layout-editor.js) requires this module for
// parseDraft + validateDraftSchema so one implementation serves both the
// production boot chain and the (workbench-bound) editing surface.

const { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS } = require('./layout-assets.js');

const SCHEMA_VERSION = 1;
// Layer semantics (Task E2e, now load-bearing for paint order): the layer
// number is DEPTH — larger draws further FRONT (back → front). The editor
// page maps it to CSS z-index with the items array order as the same-value
// tiebreak. Locked by the layer-default tests. Task E2c: env props draft
// at 25 — in front of monitors/chairs, behind characters (a walking
// character covers the prop; the prop covers workstation furniture).
const DEFAULT_LAYER_BY_KIND = Object.freeze({ monitor: 10, chair: 20, prop: 25, character: 30, desk: 40 });
const AMBIGUITY_EPSILON = 1e-12;
// Task E4.6: retired-palette (archived) entries stay import-whitelisted so
// legacy schema-v1 drafts keep loading; the shelf simply never offers them.
const ASSET_BY_ID = new Map([...LAYOUT_ASSETS, ...ARCHIVED_LAYOUT_ASSETS].map((asset) => [asset.id, asset]));

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

// Task 8: the stateless schema-v1 probe behind the production layout boot
// priority chain (office-boot.resolveProductionLayoutDraft). Same rules as
// the editor's load(), but it never touches editor state and returns a
// stable result object instead of throwing.
function validateDraftSchema(draft) {
  try {
    const parsed = parseDraft(draft);
    return { ok: true, count: parsed.items.length, code: null };
  } catch (error) {
    return { ok: false, count: 0, code: error && error.code ? error.code : 'DRAFT_INVALID' };
  }
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_LAYER_BY_KIND,
  AMBIGUITY_EPSILON,
  ASSET_BY_ID,
  parseDraft,
  validateDraftSchema,
};
