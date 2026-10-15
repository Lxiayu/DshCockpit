'use strict';

// studio/lib/scene/index.js — the scene service bundle (the UI's single entry).
//
//   draft (layout.json) + zones (zones.json) + catalog
//        → validate (schema + conflicts + edge sampling, all runtime-consistent)
//        → derive waypoints (the ⛬ graph the runtime will walk)
//        → report (stats + violations) for the panel / CLI
//
// The scene EDITING gestures themselves (drag, snap, layers, hierarchy) remain
// the product layout editor's, which the studio preview embeds — the studio owns
// the validation and the graph, not a second editor (docs/architecture.md §6).

const path = require('node:path');
const fs = require('node:fs');

const TOOL_ROOT = path.resolve(__dirname, '..', '..', '..');
const schema = require('../layout-schema.js');
const geometry = require('./geometry.js');
const zonesLib = require('./zones.js');
const waypointsLib = require('./waypoints.js');
const conflictsLib = require('./conflicts.js');
const editorLib = require('./edit.js');

// The catalog belongs to the PRODUCT tree (read-only import). A studio pointed at
// a sandbox/exported project has no product tree next to it, so loading is lazy
// and its absence is a returned code, never a constructor crash.
function loadCatalog(repoRoot) {
  // The furniture catalog belongs to a PRODUCT tree: use the project's own when it
  // has one (an exported/other checkout), otherwise the studio's installation.
  const candidates = [path.join(repoRoot, 'src', 'office', 'layout-assets.js'), path.join(TOOL_ROOT, 'src', 'office', 'layout-assets.js')];
  let catalog = null;
  let lastError = null;
  for (const candidate of candidates) {
    try {
      catalog = require(candidate);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!catalog) {
    return { ok: false, code: 'SCENE_CATALOG_MISSING', message: `no product catalog under ${repoRoot} or the studio's own tree (${lastError ? lastError.code || lastError.message : 'unknown'})` };
  }
  const assets = new Map([...catalog.LAYOUT_ASSETS, ...catalog.ARCHIVED_LAYOUT_ASSETS].map((asset) => [asset.id, asset]));
  return { ok: true, code: null, assets, draftWidths: catalog.DRAFT_WIDTHS, characterFootRatio: catalog.CHARACTER_FOOT_RATIO };
}

function createSceneServices({ repoRoot, contentDir }) {
  let catalogCache = null;
  const catalog = () => {
    if (!catalogCache) catalogCache = loadCatalog(repoRoot);
    return catalogCache;
  };

  function layoutFile(sceneId) {
    return path.join(contentDir, 'scenes', sceneId, 'layout.json');
  }

  function sceneFile(sceneId) {
    return path.join(contentDir, 'scenes', sceneId, 'scene.json');
  }

  function loadSceneMeta(sceneId) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sceneFile(sceneId), 'utf8'));
      const logical = parsed.logical || {};
      return {
        ok: true,
        id: parsed.id || sceneId,
        label: parsed.label || sceneId,
        scene: { width: logical.width || 1280, height: logical.height || 840 },
        groundLine: parsed.groundLine ?? null,
        depthBands: parsed.depthBands || null,
        file: sceneFile(sceneId),
      };
    } catch (error) {
      return { ok: false, code: error.code === 'ENOENT' ? 'SCENE_MISSING' : 'SCENE_UNPARSEABLE', message: error.message, file: sceneFile(sceneId) };
    }
  }

  function loadDraft(sceneId) {
    try {
      return { ok: true, draft: JSON.parse(fs.readFileSync(layoutFile(sceneId), 'utf8')), file: layoutFile(sceneId) };
    } catch (error) {
      return { ok: false, code: error.code === 'ENOENT' ? 'LAYOUT_MISSING' : 'LAYOUT_UNPARSEABLE', message: error.message, file: layoutFile(sceneId) };
    }
  }

  function report({ sceneId = 'flat' } = {}) {
    const cat = catalog();
    if (!cat.ok) return { ok: false, code: cat.code, message: cat.message };
    const { assets, draftWidths, characterFootRatio } = cat;
    const meta = loadSceneMeta(sceneId);
    if (!meta.ok) return { ok: false, code: meta.code, message: meta.message };
    const draft = loadDraft(sceneId);
    if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
    const zones = zonesLib.loadZones({ contentDir, sceneId });
    if (!zones.ok) return { ok: false, code: zones.code, message: zones.message, violations: zones.violations || [] };

    const validation = conflictsLib.validateScene({
      repoRoot,
      draft: draft.draft,
      model: zones.model,
      scene: meta.scene,
      assets,
      draftWidths,
      characterFootRatio,
      schemaValidator: schema.validateDraftSchema,
    });
    return {
      ok: validation.ok,
      code: validation.ok ? null : 'SCENE_CONFLICTS',
      sceneId,
      scene: meta.scene,
      files: { layout: draft.file, zones: zones.file },
      violations: validation.violations,
      stats: validation.stats,
      stations: validation.stations,
      seats: validation.seats,
      graph: validation.graph,
      edgeConflicts: validation.edgeConflicts,
      tightEdges: validation.tightEdges,
    };
  }

  function waypoints({ sceneId = 'flat' } = {}) {
    const cat = catalog();
    if (!cat.ok) return { ok: false, code: cat.code, message: cat.message };
    const { assets, draftWidths } = cat;
    const meta = loadSceneMeta(sceneId);
    if (!meta.ok) return { ok: false, code: meta.code, message: meta.message };
    const draft = loadDraft(sceneId);
    const zones = zonesLib.loadZones({ contentDir, sceneId });
    if (!zones.ok) return { ok: false, code: zones.code, message: zones.message, violations: zones.violations || [] };
    // work rects need the draft (desks define the 'work' label)
    let workRects = [];
    if (draft.ok) {
      for (const item of draft.draft.items) {
        if (item.kind !== 'desk' || item.hidden) continue;
        const asset = assets.get(item.asset);
        if (!asset) continue;
        workRects.push(geometry.toNormalizedRect(geometry.artBoxPx(item, asset, draftWidths, meta.scene), meta.scene));
      }
    }
    const graph = waypointsLib.deriveWaypoints({ model: zones.model, scene: meta.scene, workRects });
    return {
      ok: graph.ok,
      code: graph.code,
      sceneId,
      schemaVersion: 1,
      scene: sceneId,
      nodes: graph.nodes,
      edges: graph.edges,
      entries: graph.entries,
      labels: graph.labels,
      stats: graph.stats,
      source: { layout: draft.ok ? draft.file : null, zones: zones.file },
    };
  }

  // art boxes for the panel's canvas overlay / item inspection
  function boxes({ sceneId = 'flat' } = {}) {
    const cat = catalog();
    if (!cat.ok) return { ok: false, code: cat.code, message: cat.message };
    const { assets, draftWidths } = cat;
    const meta = loadSceneMeta(sceneId);
    const draft = loadDraft(sceneId);
    if (!meta.ok || !draft.ok) return { ok: false, code: (meta.ok ? draft.code : meta.code) };
    const described = conflictsLib.boxesFor(draft.draft, { assets, draftWidths, scene: meta.scene });
    return {
      ok: true,
      sceneId,
      scene: meta.scene,
      items: described.map(({ item, asset, box }) => ({
        id: item.id,
        kind: item.kind,
        asset: item.asset,
        groupId: item.groupId || null,
        hidden: Boolean(item.hidden),
        position: item.position,
        scale: item.scale,
        direction: item.direction,
        box: box ? {
          x: Number(box.x.toFixed(2)), y: Number(box.y.toFixed(2)),
          width: Number(box.width.toFixed(2)), height: Number(box.height.toFixed(2)),
        } : null,
        missingAsset: !asset,
        // the canvas draws the real art: a workbench-served URL derived from the catalog
        src: asset && typeof asset.src === 'string' ? asset.src.replace(/^\.\//, '') : null,
      })),
    };
  }

  // NOTE: the object handed to the editor uses the CLOSURES, not the module-level
  // helpers with the same names (shorthand here would pass `loadCatalog(repoRoot)`
  // and crash with an undefined root — caught the moment the editor was smoked).
  const editor = editorLib.createSceneEditor({
    repoRoot,
    contentDir,
    scene: {
      loadSceneMeta,
      loadDraft,
      loadCatalog: () => {
        const cat = catalog();
        if (!cat.ok) throw Object.assign(new Error(cat.message), { code: cat.code });
        return { assets: cat.assets, draftWidths: cat.draftWidths, characterFootRatio: cat.characterFootRatio };
      },
      schema,
    },
  });

  return {
    editor,
    loadCatalog: () => {
      const cat = catalog();
      if (!cat.ok) throw Object.assign(new Error(cat.message), { code: cat.code });
      return { assets: cat.assets, draftWidths: cat.draftWidths, characterFootRatio: cat.characterFootRatio };
    },
    catalogStatus: () => {
      const cat = catalog();
      return cat.ok ? { ok: true, assets: cat.assets.size } : { ok: false, code: cat.code, message: cat.message };
    },
    loadSceneMeta,
    loadDraft,
    report,
    waypoints,
    boxes,
    schema,
  };
}

module.exports = { createSceneServices, loadCatalog };
