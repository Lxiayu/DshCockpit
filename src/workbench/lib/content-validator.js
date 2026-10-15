'use strict';

// src/workbench/lib/content-validator.js — the ONE content/** validation
// kernel, shared by scripts/workbench-publish.js (CLI, exit-code contract)
// and the workbench panel (发布校验 button). Fail-closed: every check answers
// {ok, detail}; a violation never aborts the walk — the report lists ALL of
// them (the publish contract lists every violation before exiting non-zero).
//
// M0 scope (docs/notes/office-workbench-m0.md §2):
// - coarse schema validation for every content JSON
// - referenced assets exist (character frames via the provenance source
//   pack; layout assets via the managed production catalog)
// - contentBbox vs freshly measured PNG alpha bounds: drift <= 0.002
// - path red lines: no fixtures/, photo/, artifacts/, file://, ..-escapes or
//   absolute filesystem paths anywhere inside content/**
// - M0 does NOT sync resources/** (publish = validate only, D5)

const fs = require('node:fs');
const path = require('node:path');

const { decodePngFile, alphaBounds } = require('./png-geometry.js');
const { measureFrameFile, buildWalkGeometryReport, REQUIRED_WALK_ACTIONS, REQUIRED_WALK_FRAMES } = require('./character-geometry.js');

const CONTENT_BBOX_DRIFT_LIMIT = 0.002;
const GEOMETRY_PX_TOLERANCE = 0.5; // declared px geometry must re-measure within half a pixel

// Path red lines for content/**: the workbench content tree may never point
// into user/photo/test/derived trees or anywhere outside the repo.
const RED_LINE_PATTERNS = [
  ['photo-tree', /(^|[^A-Za-z])photo\//],
  ['fixtures-tree', /(^|[^A-Za-z])fixtures\//],
  ['artifacts-tree', /(^|[^A-Za-z])artifacts\//],
  ['file-url', /file:\/\//],
  ['parent-escape', /\.\.\//],
  ['absolute-posix-path', /(^|[\s"'(:])\/(Users|home|tmp|var|etc|private)\//],
  ['windows-path', /[A-Za-z]:\\/],
];

function listFilesRecursive(root, skipDirs = new Set()) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(root);
  return out.sort();
}

function readJsonIfExists(absPath) {
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(absPath, 'utf8')) };
  } catch (error) {
    return { exists: fs.existsSync(absPath), value: null, error };
  }
}

// Resolves a managed catalog asset URL (./office-assets/... or
// ./characters/...) to its production file under repoRoot/resources — the
// same resolution the office-runtime protocol uses.
function resolveCatalogAssetPath(repoRoot, src) {
  if (src.startsWith('./office-assets/')) return path.join(repoRoot, 'resources', 'office', src.slice('./office-assets/'.length));
  if (src.startsWith('./characters/')) return path.join(repoRoot, 'resources', src.slice('./'.length));
  return null;
}

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), detail: detail === undefined ? null : detail };
}

// ---- per-file validators ----------------------------------------------------

function validateCharacterJson(repoRoot, absPath, json) {
  const checks = [];
  const packRoot = json && json.provenance && typeof json.provenance.sourcePack === 'string'
    ? path.resolve(repoRoot, json.provenance.sourcePack)
    : null;

  checks.push(check('schemaVersion', json && json.schemaVersion === 1, json && json.schemaVersion));
  checks.push(check('id', !!json && json.id === 'whale-girl', json && json.id));
  const pack = json && json.pack;
  checks.push(check('pack.canvas', !!pack && pack.canvas === 352, pack && pack.canvas));
  checks.push(check('pack.anchor', !!pack && pack.anchor && pack.anchor.x === 178 && pack.anchor.y === 296, pack && pack.anchor));
  checks.push(check('pack.footLine', !!pack && pack.footLine === 296, pack && pack.footLine));
  checks.push(check('defaults.frameDurationMs', !!json && json.defaults && json.defaults.frameDurationMs === 1000, json && json.defaults));
  checks.push(check('provenance.sourcePack', !!packRoot && fs.existsSync(packRoot), json && json.provenance));

  // Every action: frames exist + freshly measured geometry matches declared.
  const actions = json && Array.isArray(json.actions) ? json.actions : [];
  checks.push(check('actions.nonEmpty', actions.length > 0, actions.length));
  const resolveFrame = (character, frame) => (packRoot ? path.join(packRoot, frame.file) : path.resolve(path.dirname(absPath), frame.file));
  for (const action of actions) {
    const prefix = `action.${action.id}`;
    if (!action || typeof action.id !== 'string' || !Array.isArray(action.frames) || action.frames.length === 0) {
      checks.push(check(prefix, false, 'malformed action entry'));
      continue;
    }
    let framesOk = true;
    let geometryOk = true;
    const badFrames = [];
    for (const frame of action.frames) {
      if (!frame || typeof frame.file !== 'string') {
        framesOk = false;
        badFrames.push('(malformed)');
        continue;
      }
      const absFrame = resolveFrame(json, frame);
      const m = measureFrameFile(absFrame);
      if (!m.ok) {
        framesOk = false;
        badFrames.push(`${frame.file}:${m.code}`);
        continue;
      }
      const declared = frame.geometry || {};
      if (declared.footLine !== undefined && declared.footLine !== m.footLine) {
        geometryOk = false;
        badFrames.push(`${frame.file}:footLine ${declared.footLine}!=${m.footLine}`);
      }
      if (declared.visibleHeight !== undefined && declared.visibleHeight !== m.visibleHeight) {
        geometryOk = false;
        badFrames.push(`${frame.file}:height ${declared.visibleHeight}!=${m.visibleHeight}`);
      }
      if (declared.visibleWidth !== undefined && declared.visibleWidth !== m.visibleWidth) {
        geometryOk = false;
        badFrames.push(`${frame.file}:width ${declared.visibleWidth}!=${m.visibleWidth}`);
      }
    }
    checks.push(check(`${prefix}.framesExist`, framesOk, framesOk ? action.frames.length : badFrames.slice(0, 4)));
    checks.push(check(`${prefix}.geometryMatchesPng`, geometryOk, geometryOk ? 'all frames match' : badFrames.slice(0, 4)));
  }

  // 二代行走（2026-09-22）：四个方向都为逐帧序列，帧数按方向固定
  // （left/right/down 15 帧、up 14 帧 @83ms）；walk 几何报告必须全绿
  // （鞋线 ±1px / 可见高 ±2px）。
  for (const actionId of REQUIRED_WALK_ACTIONS) {
    const action = actions.find((entry) => entry && entry.id === actionId);
    const expected = REQUIRED_WALK_FRAMES[actionId.replace(/^walk-/, '')];
    checks.push(check(`walk.${actionId}.frames`, !!action && action.frames.length === expected, action ? action.frames.length : 'missing'));
  }
  const walkReport = buildWalkGeometryReport({ character: json, resolveFramePath: resolveFrame });
  checks.push(check('walk.geometryWithinTolerance', walkReport.totalFrames > 0 && walkReport.redFrames === 0, {
    totalFrames: walkReport.totalFrames,
    redFrames: walkReport.redFrames,
    tolerance: walkReport.tolerance,
    red: walkReport.rows.filter((row) => row.red).map((row) => row.file),
  }));

  // unionVisibleBounds across ALL action frames (alpha>8) vs declared.
  const allFramePaths = [];
  for (const action of actions) {
    for (const frame of action.frames || []) allFramePaths.push(resolveFrame(json, frame));
  }
  let union = null;
  for (const absFrame of allFramePaths) {
    const m = measureFrameFile(absFrame);
    if (!m.ok || !m.bounds) continue;
    union = union
      ? {
          x: Math.min(union.x, m.bounds.x),
          y: Math.min(union.y, m.bounds.y),
          w: Math.max(union.x + union.w, m.bounds.x + m.bounds.w) - Math.min(union.x, m.bounds.x),
          h: Math.max(union.y + union.h, m.bounds.y + m.bounds.h) - Math.min(union.y, m.bounds.y),
        }
      : { ...m.bounds };
  }
  const declaredUnion = pack && pack.unionVisibleBounds;
  const unionOk = !!union && !!declaredUnion
    && Math.abs(union.x - declaredUnion.x) <= GEOMETRY_PX_TOLERANCE
    && Math.abs(union.y - declaredUnion.y) <= GEOMETRY_PX_TOLERANCE
    && Math.abs(union.w - declaredUnion.w) <= GEOMETRY_PX_TOLERANCE
    && Math.abs(union.h - declaredUnion.h) <= GEOMETRY_PX_TOLERANCE;
  checks.push(check('pack.unionVisibleBounds', unionOk, { measured: union, declared: declaredUnion || null }));

  return checks;
}

function validateSceneJson(json) {
  const checks = [];
  checks.push(check('schemaVersion', !!json && json.schemaVersion === 1, json && json.schemaVersion));
  const logical = json && json.logical;
  checks.push(check('logical', !!logical && logical.width === 1280 && logical.height === 840, logical));
  checks.push(check('groundLine', !!json && json.groundLine === 0.62, json && json.groundLine));
  const expectedBands = { background: [0, 10], floor: [10, 20], furniture: [20, 40], character: [45], foreground: [50, 60] };
  const bands = json && json.depthBands;
  checks.push(check('depthBands', !!bands && JSON.stringify(bands) === JSON.stringify(expectedBands), bands));
  checks.push(check('tokens', !!json && typeof json.tokens === 'object' && json.tokens !== null, null));
  return checks;
}

function validateZonesJson(repoRoot, contentDir, json) {
  const checks = [];
  checks.push(check('schemaVersion', !!json && json.schemaVersion === 1, json && json.schemaVersion));
  const walkable = json && Array.isArray(json.walkable) ? json.walkable : [];
  const expectedWalkable = [{ kind: 'rect', rect: [0.06, 0.06, 0.88, 0.86] }];
  checks.push(check('walkable', walkable.length === 1 && JSON.stringify(walkable) === JSON.stringify(expectedWalkable), walkable));
  const validation = json && json.validation;
  checks.push(check('validation.sampleStep', !!validation && validation.sampleStep === 0.005, validation && validation.sampleStep));
  checks.push(check('validation.moverRadius', !!validation && validation.moverRadius === 0.02, validation && validation.moverRadius));
  checks.push(check('validation.exemptSameStation', !!validation && validation.exemptSameStation === true, validation && validation.exemptSameStation));

  // Obstacles are the M0 initial value derived from the layout's furniture
  // footprints (the E4 compiler derivation) — recompile and compare.
  const layoutPath = path.join(contentDir, 'scenes', 'flat', 'layout.json');
  const layout = readJsonIfExists(layoutPath);
  let furnitureById = null;
  if (layout.exists && layout.value) {
    try {
      const { compileOfficeLayout } = require(path.join(repoRoot, 'src', 'office', 'runtime', 'office-layout-compiler.js'));
      const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require(path.join(repoRoot, 'src', 'office', 'layout-assets.js'));
      const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8'));
      const compiled = compileOfficeLayout({
        draft: layout.value,
        assets: LAYOUT_ASSETS,
        draftWidths: DRAFT_WIDTHS,
        characterFoot: CHARACTER_FOOT_RATIO,
        topology: { nodes: fixture.nodes, edges: fixture.edges },
      });
      if (compiled.ok) {
        furnitureById = new Map(compiled.layout.furniture.map((item) => {
          const rect = Object.values(item.parts)[0];
          return [item.id, rect];
        }));
      } else {
        checks.push(check('obstacles.compileLayout', false, compiled.code));
      }
    } catch (error) {
      checks.push(check('obstacles.compileLayout', false, String(error.message || error).slice(0, 160)));
    }
  } else {
    checks.push(check('obstacles.compileLayout', false, 'layout.json missing or unparseable'));
  }

  if (furnitureById) {
    const obstacles = json && Array.isArray(json.obstacles) ? json.obstacles : [];
    const obstacleById = new Map(obstacles.map((entry) => [entry && entry.id, entry]));
    const problems = [];
    for (const [id, rect] of furnitureById) {
      const obstacle = obstacleById.get(id);
      if (!obstacle) {
        problems.push(`missing:${id}`);
        continue;
      }
      const rectNorm = obstacle.rect;
      if (!Array.isArray(rectNorm) || rectNorm.length !== 4) {
        problems.push(`rect:${id}`);
        continue;
      }
      const expected = [rect.x, rect.y, rect.width, rect.height];
      for (let i = 0; i < 4; i += 1) {
        if (Math.abs(rectNorm[i] - expected[i]) > CONTENT_BBOX_DRIFT_LIMIT) {
          problems.push(`${id}[${i}] ${rectNorm[i]}!=${expected[i]}`);
        }
      }
    }
    for (const id of obstacleById.keys()) {
      if (id && !furnitureById.has(id)) problems.push(`unknown:${id}`);
    }
    checks.push(check('obstacles.matchLayoutFootprints', problems.length === 0 && obstacles.length === furnitureById.size, problems.slice(0, 6).length ? problems.slice(0, 6) : { obstacles: obstacles.length, furniture: furnitureById.size }));
  }
  return checks;
}

function validateLayoutJson(repoRoot, absPath, json) {
  const checks = [];
  const editor = require(path.join(repoRoot, 'src', 'office', 'layout-editor.js')).createLayoutEditor({ scene: { width: 1280, height: 840 } });
  const probe = editor.validateDraftSchema(json);
  checks.push(check('validateDraftSchema', probe.ok === true, probe.ok ? { count: probe.count } : probe.code));

  // Every referenced catalog asset: exists + decodable + contentBbox drift.
  const { LAYOUT_ASSETS } = require(path.join(repoRoot, 'src', 'office', 'layout-assets.js'));
  const assetById = new Map(LAYOUT_ASSETS.map((asset) => [asset.id, asset]));
  const referenced = [...new Set((json && Array.isArray(json.items) ? json.items : []).map((item) => item && item.asset).filter(Boolean))];
  const problems = [];
  for (const assetId of referenced) {
    const asset = assetById.get(assetId);
    if (!asset) {
      problems.push(`unknown-asset:${assetId}`);
      continue;
    }
    const abs = resolveCatalogAssetPath(repoRoot, asset.src);
    if (!abs || !fs.existsSync(abs)) {
      problems.push(`missing:${assetId}`);
      continue;
    }
    let image;
    try {
      image = decodePngFile(abs);
    } catch (error) {
      problems.push(`decode:${assetId}:${error.code || 'failed'}`);
      continue;
    }
    if (asset.contentBbox) {
      const bounds = alphaBounds(image, 8);
      if (!bounds) {
        problems.push(`empty-alpha:${assetId}`);
        continue;
      }
      const measured = {
        x: bounds.x / image.width,
        y: bounds.y / image.height,
        w: bounds.w / image.width,
        h: bounds.h / image.height,
      };
      for (const key of ['x', 'y', 'w', 'h']) {
        if (Math.abs(measured[key] - asset.contentBbox[key]) > CONTENT_BBOX_DRIFT_LIMIT) {
          problems.push(`bbox:${assetId}.${key} ${asset.contentBbox[key]}!=${Number(measured[key].toFixed(6))}`);
        }
      }
    }
  }
  checks.push(check('referencedAssets', problems.length === 0, problems.length ? problems.slice(0, 8) : { assets: referenced.length }));
  return checks;
}

// ---- whole-tree validation ---------------------------------------------------

// validateContentTree({ repoRoot, contentDir }) ->
// { ok, generatedAt, filesScanned, entries: [{file, ok, checks}], violations }
function validateContentTree({ repoRoot, contentDir, generatedAt = null }) {
  const entries = [];
  const violations = [];
  const addEntry = (file, checks) => {
    const entry = { file, ok: checks.every((c) => c.ok), checks };
    entries.push(entry);
    for (const failed of checks.filter((c) => !c.ok)) {
      violations.push({ file, check: failed.name, detail: failed.detail });
    }
    return entry;
  };

  // workbench-owned output (build/) and the publish kernel's append-only
  // provenance/ history are machine-written tool outputs, not content source:
  // provenance entries intentionally carry the ABSOLUTE backup path (rollback
  // data), which the content red lines correctly forbid in human-authored
  // files. The provenance bytes are validated when the kernel writes them.
  const files = listFilesRecursive(contentDir, new Set(['build', 'provenance']));
  if (files.length === 0) {
    violations.push({ file: contentDir, check: 'contentTreeExists', detail: 'no files under content/ (build/ excluded)' });
  }

  // 1. path red lines over every text file (JSON + md).
  const redLineChecks = [];
  for (const abs of files) {
    const rel = path.relative(contentDir, abs);
    const ext = path.extname(abs);
    if (!['.json', '.md', '.txt'].includes(ext)) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [name, pattern] of RED_LINE_PATTERNS) {
      if (pattern.test(text)) redLineChecks.push(check(`${rel}:redline.${name}`, false, pattern.source));
    }
  }
  redLineChecks.push(check('redlines', redLineChecks.length === 0, redLineChecks.length ? `${redLineChecks.length - 1} violation(s)` : 'clean'));
  addEntry('path-redlines', redLineChecks);

  // 2. the four M0 scaffold units.
  const characterPath = path.join(contentDir, 'characters', 'whale-girl', 'character.json');
  const character = readJsonIfExists(characterPath);
  addEntry(path.relative(contentDir, characterPath), character.exists && character.value
    ? validateCharacterJson(repoRoot, characterPath, character.value)
    : [check('parse', false, character.exists ? 'unparseable JSON' : 'missing')]);

  const layoutPath = path.join(contentDir, 'scenes', 'flat', 'layout.json');
  const layout = readJsonIfExists(layoutPath);
  addEntry(path.relative(contentDir, layoutPath), layout.exists && layout.value
    ? validateLayoutJson(repoRoot, layoutPath, layout.value)
    : [check('parse', false, layout.exists ? 'unparseable JSON' : 'missing')]);

  const scenePath = path.join(contentDir, 'scenes', 'flat', 'scene.json');
  const scene = readJsonIfExists(scenePath);
  addEntry(path.relative(contentDir, scenePath), scene.exists && scene.value
    ? validateSceneJson(scene.value)
    : [check('parse', false, scene.exists ? 'unparseable JSON' : 'missing')]);

  const zonesPath = path.join(contentDir, 'scenes', 'flat', 'zones.json');
  const zones = readJsonIfExists(zonesPath);
  addEntry(path.relative(contentDir, zonesPath), zones.exists && zones.value
    ? validateZonesJson(repoRoot, contentDir, zones.value)
    : [check('parse', false, zones.exists ? 'unparseable JSON' : 'missing')]);

  const dialoguePath = path.join(contentDir, 'shared', 'dialogue', 'README.md');
  let dialogueOk = false;
  let dialogueDetail = 'missing';
  try {
    const text = fs.readFileSync(dialoguePath, 'utf8');
    dialogueOk = text.trim().length > 0;
    dialogueDetail = dialogueOk ? `${text.trim().length} chars` : 'empty';
  } catch {
    dialogueOk = false;
  }
  addEntry(path.relative(contentDir, dialoguePath), [check('placeholderPresent', dialogueOk, dialogueDetail)]);

  return {
    ok: violations.length === 0,
    generatedAt: generatedAt || new Date().toISOString(),
    filesScanned: files.length,
    entries,
    violations,
  };
}

module.exports = {
  CONTENT_BBOX_DRIFT_LIMIT,
  RED_LINE_PATTERNS,
  validateContentTree,
  resolveCatalogAssetPath,
  listFilesRecursive,
};
