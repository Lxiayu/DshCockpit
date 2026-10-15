'use strict';

// studio/lib/scene/edit.js — the scene editing service (P2's UI half).
//
// The canvas panel edits through THIS module so the rules cannot drift from the CLI:
// every edit is applied to a copy of the draft, the schema and the conflict validator
// run again, and the file is written only when the result is clean. A red finding
// refuses the save (被拦住) — the panel shows the violation and the user undoes.
//
// Writes are auditable: a backup lands in content/build/backups/layout/ before the file
// is replaced, and "no change" is a no-op (无变更不落盘), exactly like the publish
// kernel.

const path = require('node:path');
const fs = require('node:fs');

const geometry = require('./geometry.js');
const conflicts = require('./conflicts.js');
const zoneSync = require('./zone-sync.js');
const zonesLib = require('./zones.js');

const GRID = 0.005;              // the canvas snap step (0.5% of the scene)
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;

function roundToGrid(value) {
  return Math.round(value / GRID) * GRID;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

// The layout file has a house style (the product editor wrote it). Re-serializing with a
// fixed indent turned a one-item move into a ~900-line diff; detecting the existing
// indent keeps content diffs reviewable.
function detectIndent(text, fallback = 2) {
  const match = /\n(\s+)"/.exec(text);
  if (!match) return fallback;
  const whitespace = match[1];
  return whitespace.includes('\t') ? '\t' : whitespace.length;
}

function serializeLike(text, value) {
  const indent = detectIndent(text);
  const trailingNewline = text.endsWith('\n');
  return `${JSON.stringify(value, null, indent)}${trailingNewline ? '\n' : ''}`;
}

function createSceneEditor({ repoRoot, contentDir, scene }) {
  const layoutPath = (sceneId) => path.join(contentDir, 'scenes', sceneId, 'layout.json');
  const backupRoot = path.join(contentDir, 'build', 'backups', 'layout');

  function load(sceneId) {
    const file = layoutPath(sceneId);
    if (!fs.existsSync(file)) return { ok: false, code: 'LAYOUT_MISSING', file };
    try {
      return { ok: true, file, draft: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      return { ok: false, code: 'LAYOUT_UNPARSEABLE', message: error.message, file };
    }
  }

  // The full report for a draft that is not (yet) on disk — the panel calls this after
  // every mutation, so what you see is what the gate will say.
  //
  // The walkability declaration is DERIVED from the layout (区域而非线条), so moving
  // furniture must carry the obstacle refresh with it: without the sync every move would
  // be refused as SCENE_OBSTACLE_STALE/UNDECLARED. `synced` is what a save writes.
  function evaluate({ sceneId, draft, zones = null }) {
    const meta = scene.loadSceneMeta(sceneId);
    if (!meta.ok) return { ok: false, code: meta.code, message: meta.message };
    const loadedZones = zones || zonesLib.loadZones({ contentDir, sceneId });
    if (!loadedZones.ok) return { ok: false, code: loadedZones.code, message: loadedZones.message, violations: loadedZones.violations || [] };
    const catalog = scene.loadCatalog();
    const stations = conflicts.deriveStations(draft.items, {
      assets: catalog.assets,
      draftWidths: catalog.draftWidths,
      scene: meta.scene,
      characterFootRatio: catalog.characterFootRatio,
    });
    const synced = zoneSync.syncZones({
      draft,
      zones: loadedZones.zones,
      assets: catalog.assets,
      draftWidths: catalog.draftWidths,
      scene: meta.scene,
      stations,
    });
    const model = synced.ok ? zonesLib.buildModel(synced.zones) : loadedZones.model;
    const validation = conflicts.validateScene({
      repoRoot,
      draft,
      model,
      scene: meta.scene,
      assets: catalog.assets,
      draftWidths: catalog.draftWidths,
      characterFootRatio: catalog.characterFootRatio,
      schemaValidator: scene.schema.validateDraftSchema,
    });
    return {
      ok: validation.ok,
      // the panel renders the SAME shape the CLI's `report` returns — sceneId/scene
      // included, or the renderer throws halfway and the findings table ends up empty
      // (exactly what the canvas probe caught on the first save).
      sceneId,
      scene: meta.scene,
      files: { layout: layoutPath(sceneId), zones: zonesLib.zonesFileFor(contentDir, sceneId) },
      violations: validation.violations,
      stats: validation.stats,
      graph: validation.graph,
      stations: validation.stations,
      seats: validation.seats,
      edgeConflicts: validation.edgeConflicts,
      tightEdges: validation.tightEdges,
      zones: synced.ok ? { zones: synced.zones, exact: synced.exact, changes: synced.changes } : null,
    };
  }

  // A fresh item id in the file's own house style (draft-27, draft-28, …): the product
  // editor writes those, and a mismatched convention would show up as a diff on every
  // later save from the product side.
  function nextDraftId(items) {
    let max = 0;
    for (const item of items) {
      const match = /^draft-(\d+)$/.exec(String(item.id || ''));
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `draft-${max + 1}`;
  }

  // Dropping a furniture image on the canvas is an ADD, and it travels through the same
  // transaction as a move: the copy is mutated, zones are re-derived from the items, the
  // conflict validator runs, and a red result refuses the write. Nothing about the add
  // path bypasses the gate.
  function addItem({ draft, spec }) {
    const id = spec.id || nextDraftId(draft.items);
    if (draft.items.some((entry) => entry.id === id)) return { ok: false, code: 'ADD_ID_TAKEN', id };
    const item = {
      id,
      kind: spec.kind,
      asset: spec.asset,
      position: {
        x: Number(clamp01(roundToGrid(spec.position ? spec.position.x : 0.5)).toFixed(6)),
        y: Number(clamp01(roundToGrid(spec.position ? spec.position.y : 0.5)).toFixed(6)),
      },
      scale: Number(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(spec.scale) || 1)).toFixed(6)),
      direction: spec.direction || 'front',
      layer: Number.isFinite(Number(spec.layer)) ? Number(spec.layer) : 30,
      groupId: id,
      locked: false,
      hidden: false,
      name: spec.name || null,
    };
    draft.items.push(item);
    return { ok: true, item };
  }

  // Removing an item must not leave dangling references behind (the product editor keeps
  // selectedId / groupNames / rigidGroups in the same file).
  function removeItem({ draft, itemId }) {
    const index = draft.items.findIndex((entry) => entry.id === itemId);
    if (index < 0) return { ok: false, code: 'REMOVE_ITEM_UNKNOWN', itemId };
    const [removed] = draft.items.splice(index, 1);
    if (draft.groupNames && typeof draft.groupNames === 'object') delete draft.groupNames[itemId];
    if (Array.isArray(draft.rigidGroups)) {
      draft.rigidGroups = draft.rigidGroups
        .map((group) => (Array.isArray(group) ? group.filter((id) => id !== itemId) : group))
        .filter((group) => !Array.isArray(group) || group.length > 1);
    }
    if (draft.selectedId === itemId) draft.selectedId = null;
    if (Array.isArray(draft.selectedIds)) draft.selectedIds = draft.selectedIds.filter((id) => id !== itemId);
    return { ok: true, item: removed };
  }

  // Apply edits to a COPY. Three shapes:
  //   { itemId, position?, scale?, hidden?, layer? }   move/resize/hide
  //   { add: { kind, asset, position, direction, layer, scale } }   place a new item
  //   { itemId, remove: true }                          delete an item
  function applyEdits({ draft, edits }) {
    const next = JSON.parse(JSON.stringify(draft));
    const applied = [];
    const violations = [];
    for (const edit of edits) {
      if (edit.add) {
        const added = addItem({ draft: next, spec: edit.add });
        if (!added.ok) { violations.push({ check: 'edit.add-failed', detail: `${added.code} ${added.id || ''}` }); continue; }
        applied.push({ itemId: added.item.id, changed: true, before: null, added: added.item });
        continue;
      }
      const item = next.items.find((entry) => entry.id === edit.itemId);
      if (!item) { violations.push({ check: 'edit.item-unknown', detail: `no item ${edit.itemId}` }); continue; }
      if (edit.remove) {
        const removed = removeItem({ draft: next, itemId: edit.itemId });
        if (!removed.ok) { violations.push({ check: 'edit.remove-failed', detail: removed.code }); continue; }
        applied.push({ itemId: edit.itemId, changed: true, before: null, removed: removed.item });
        continue;
      }
      const before = { position: { ...item.position }, scale: item.scale, hidden: Boolean(item.hidden), layer: item.layer };
      if (edit.position) {
        // A re-staged IDENTICAL position is not a change (grid snapping must not turn a
        // no-op into an edit — the on-disk positions are not on the grid).
        const moved = Math.abs(edit.position.x - item.position.x) > 1e-9 || Math.abs(edit.position.y - item.position.y) > 1e-9;
        if (moved) {
          const x = clamp01(roundToGrid(edit.position.x));
          const y = clamp01(roundToGrid(edit.position.y));
          item.position = { x: Number(x.toFixed(6)), y: Number(y.toFixed(6)) };
        }
      }
      if (edit.scale !== undefined) {
        const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(edit.scale)));
        if (Number.isFinite(scale) && scale !== item.scale) item.scale = Number(scale.toFixed(6));
      }
      if (edit.hidden !== undefined) item.hidden = Boolean(edit.hidden);
      if (edit.layer !== undefined && Number.isFinite(Number(edit.layer))) item.layer = Number(edit.layer);
      const changed = before.position.x !== item.position.x || before.position.y !== item.position.y
        || before.scale !== item.scale || before.hidden !== Boolean(item.hidden) || before.layer !== item.layer;
      applied.push({ itemId: edit.itemId, changed, before });
    }
    return { draft: next, applied, violations };
  }

  // dryRun: evaluate only; otherwise write when the result is clean AND something changed.
  function commit({ sceneId, edits = [], dryRun = true, allowRed = false }) {
    const loaded = load(sceneId);
    if (!loaded.ok) return loaded;
    const applied = applyEdits({ draft: loaded.draft, edits });
    if (applied.violations.length > 0) return { ok: false, code: 'EDIT_INVALID', violations: applied.violations };
    const changed = applied.applied.some((entry) => entry.changed);
    const report = evaluate({ sceneId, draft: applied.draft });
    if (!report.ok && report.violations) {
      const reds = report.violations.filter((violation) => violation.severity === 'red');
      if (reds.length > 0 && !allowRed) {
        return {
          ok: false,
          code: 'SCENE_CONFLICTS',
          // 被拦住：the edit is refused, the file is untouched, and the reasons travel back
          violations: reds,
          report,
          changed,
        };
      }
    }
    if (!changed) return { ok: true, noop: true, report, changed: false, file: loaded.file };
    // `applied` travels with the dry run too: a drop needs the new item's id (and the
    // canvas needs to know WHICH item an edit touched) before anything is written
    if (dryRun) return { ok: true, dryRun: true, report, changed: true, file: loaded.file, draft: applied.draft, applied: applied.applied, zonesChanges: report.zones ? report.zones.changes : null };
    fs.mkdirSync(backupRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(backupRoot, `${stamp}-${sceneId}-layout.json`);
    // a backup is a BYTE copy of the file being replaced (re-serializing would lose the
    // original formatting/trailing newline and make "restore" a rewrite, not a restore)
    fs.copyFileSync(loaded.file, backup);
    fs.writeFileSync(loaded.file, serializeLike(fs.readFileSync(loaded.file, 'utf8'), applied.draft));
    // the obstacles travel with the layout: one transaction, two files, both auditable
    let zonesFile = null;
    let zonesBackup = null;
    if (report.zones && !report.zones.exact) {
      const zonesPath = zonesLib.zonesFileFor(contentDir, sceneId);
      zonesBackup = path.join(backupRoot, `${stamp}-${sceneId}-zones.json`);
      if (fs.existsSync(zonesPath)) fs.writeFileSync(zonesBackup, fs.readFileSync(zonesPath));
      const appliedZones = zoneSync.applyZonesSync({ contentDir, sceneId, zones: report.zones.zones, backupRoot });
      zonesFile = appliedZones.file;
    }
    return { ok: true, dryRun: false, changed: true, file: loaded.file, backup, zonesFile, zonesBackup, report, applied: applied.applied };
  }

  return { applyEdits, backupRoot, commit, evaluate, load, layoutPath };
}

module.exports = { GRID, MAX_SCALE, MIN_SCALE, clamp01, createSceneEditor, detectIndent, roundToGrid, serializeLike };
