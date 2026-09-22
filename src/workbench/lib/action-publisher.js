'use strict';

// src/workbench/lib/action-publisher.js — the M1 publish kernel (D5) plus the
// staged preview pack the workbench plays through the real renderer.
//
// publishAction({ contentDir, charactersRoot, actionId }) — the ONLY code
// path in the tool that may write production bytes:
// - content is the source of truth: content/characters/whale-girl/
//   actions/<id>.json is validated (validateActionForPublish: shoe line ±1px
//   against geometry.footLine, visible height ±2px against the same-action
//   median, safe paths, durations 50..5000ms or null) — a failing action
//   publishes NOTHING (fail-closed, 不落盘);
// - on success it rewrites ONLY the target entry of
//   resources/characters/deepseek-default/animation/animations.json (every
//   other entry stays byte-identical — the canonical pack serializer), repairs
//   the anchors.json frames map to the NEW metadata order (the E5a-R1 lock —
//   file names never sort, array order is the play order), copies NEW frame
//   files from the character content assets into the pack, and rebuilds the
//   character.json action entry from freshly measured geometry;
// - every file it is about to modify is backed up FIRST under
//   content/build/backups/<timestamp>/ (pre-publish bytes — the rollback
//   path), and one append-only provenance entry lands under
//   content/characters/whale-girl/provenance/ (time / change summary /
//   backup path). 失败 = 不落盘：a mid-write error rolls the backups back.
// - an unchanged action is a no-op: { ok, noop: true } — no backup, no
//   provenance, no write ("无变更不记录").
//
// stagePreviewPack({ contentDir, charactersRoot, actionId }) writes the SAME
// rewritten pack pair under content/build/preview-pack/ (tool-owned,
// gitignored) so the workbench preview can boot the real office page against
// the edited sequence WITHOUT touching resources/**.
//
// Pure CommonJS (fs + the workbench libs); no DOM, no Electron.

const fs = require('node:fs');
const path = require('node:path');

const model = require('./action-model.js');
const { canonicalPackJson } = require('./pack-json.js');
const { measureFrameFile, median } = require('./character-geometry.js');

const PACK_ID = 'deepseek-default';
const SCHEMA_VERSION = 1;

// ---- paths ------------------------------------------------------------------

function packRootFor(charactersRoot) {
  return path.join(charactersRoot, PACK_ID);
}

function createPaths({ contentDir, charactersRoot }) {
  const characterDir = path.join(contentDir, 'characters', 'whale-girl');
  const packRoot = packRootFor(charactersRoot);
  return {
    contentDir,
    charactersRoot,
    characterDir,
    actionsDir: path.join(characterDir, 'actions'),
    characterJsonPath: path.join(characterDir, 'character.json'),
    assetsDir: path.join(characterDir, 'assets'),
    provenanceDir: path.join(characterDir, 'provenance'),
    packRoot,
    animationsPath: path.join(packRoot, 'animation', 'animations.json'),
    anchorsPath: path.join(packRoot, 'animation', 'anchors.json'),
    packAssetsDir: path.join(packRoot, 'assets'),
    backupsRoot: path.join(contentDir, 'build', 'backups'),
    previewPackDir: path.join(contentDir, 'build', 'preview-pack'),
  };
}

// The editor's frame resolution: content assets first (imported, not-yet-
// published frames), then the provenance pack. Returns null when unresolvable.
function resolveFramePath(paths, file) {
  if (typeof file !== 'string' || !model.isSafeRelativePath(file)) return null;
  const contentAsset = path.join(paths.assetsDir, file);
  try {
    if (fs.statSync(contentAsset).isFile()) return contentAsset;
  } catch { /* fall through to the pack */ }
  const packAsset = path.join(paths.packRoot, file);
  try {
    if (fs.statSync(packAsset).isFile()) return packAsset;
  } catch { /* unresolvable */ }
  return null;
}

function readJsonIfExists(absPath) {
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(absPath, 'utf8')) };
  } catch (error) {
    return { exists: fs.existsSync(absPath), value: null, error };
  }
}

function violation(file, check, detail) {
  return { file, check, detail: detail === undefined ? null : detail };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- validation -------------------------------------------------------------

// validateForPublish(paths, doc) -> { ok, validation } with the violations
// list shaped for the UI (one row per failed check / red geometry frame).
function validateForPublish(paths, doc) {
  const validation = model.validateActionForPublish(doc, {
    resolveFramePath: (file) => resolveFramePath(paths, file),
    measureFrame: (absPath) => measureFrameFile(absPath),
  });
  const violations = [];
  for (const entry of validation.checks) {
    if (!entry.ok) violations.push(violation(`actions/${doc.id}.json`, entry.check, entry.detail));
  }
  for (const row of validation.rows) {
    if (row.red) {
      violations.push(violation(row.file, 'geometry.frame', {
        index: row.index,
        code: row.code,
        footLine: row.footLine,
        dFoot: row.dFoot,
        visibleHeight: row.visibleHeight,
        dHeight: row.dHeight,
      }));
    }
  }
  return { ok: validation.ok, validation, violations };
}

// ---- pack shape builders ----------------------------------------------------

// For frame files the pack does not know yet (freshly imported): measure the
// content asset and synthesize an anchors.json-style record. outputAnchor is
// the pack anchor because the normalizer aligned the shoe line onto it.
function synthesizeAnchorEntry(paths, file, packAnchors) {
  const abs = resolveFramePath(paths, file);
  const measured = abs ? measureFrameFile(abs) : { ok: false };
  if (!measured.ok || !measured.bounds) return null;
  const fallbackAnchor = packAnchors && packAnchors.anchor
    ? { ...packAnchors.anchor }
    : { x: Math.round((packAnchors.outputCanvas.width - 1) / 2), y: measured.footLine };
  return {
    outputAnchor: fallbackAnchor,
    sourceAnchor: { x: fallbackAnchor.x, y: measured.footLine },
    sourceCanvas: { width: measured.width, height: measured.height },
    sourceScale: 1,
    // anchors.json convention: {x, y, width, height} (NOT the w/h of alphaBounds)
    visibleBounds: { x: measured.bounds.x, y: measured.bounds.y, width: measured.bounds.w, height: measured.bounds.h },
    detection: {
      contactRule: 'single-lowest-row-median',
      selectedRule: 'workbench-normalized-import',
      note: 'M1 workbench import: uniform scale + integer translation (normalizer.js)',
    },
  };
}

// buildPackEntry(paths, doc, oldEntry, packAnchors) -> the animations.json
// entry for the edited action: the pack shape is preserved (state kept, per-
// frame anchor/visibleBounds carried over), the FRAMES follow the doc order
// with the edited durations. New files get freshly measured metadata.
function buildPackEntry(paths, doc, oldEntry, packAnchors) {
  const oldFrames = new Map(((oldEntry && oldEntry.frames) || []).map((frame) => [frame.file, frame]));
  const frames = doc.frames.map((frame) => {
    const durationMs = frame.durationMs === null || frame.durationMs === undefined ? null : frame.durationMs;
    const old = oldFrames.get(frame.file);
    if (old) return { ...old, durationMs, file: frame.file };
    const entry = synthesizeAnchorEntry(paths, frame.file, packAnchors);
    return {
      anchor: entry ? { ...entry.outputAnchor } : null,
      durationMs,
      file: frame.file,
      visibleBounds: entry ? { ...entry.visibleBounds } : null,
    };
  });
  return {
    direction: doc.direction,
    frames,
    loop: doc.loop,
    state: oldEntry && typeof oldEntry.state === 'string' ? oldEntry.state : model.stateForAction(doc),
  };
}

// rebuildAnchorsFrames(oldFrames, files, synthesized) -> a NEW frames map in
// which the action's files appear exactly in the metadata (play) order at the
// position of the block's first key; every other key keeps its relative
// order. This is the E5a-R1 invariant: anchors key order === metadata order.
function rebuildAnchorsFrames(oldFrames, files, synthesized) {
  const targetSet = new Set(files);
  const result = {};
  let emitted = false;
  for (const key of Object.keys(oldFrames)) {
    if (targetSet.has(key)) {
      if (!emitted) {
        for (const file of files) {
          result[file] = Object.prototype.hasOwnProperty.call(oldFrames, file)
            ? oldFrames[file]
            : synthesized[file];
        }
        emitted = true;
      }
      // skip the old position — the block was emitted in metadata order
    } else {
      result[key] = oldFrames[key];
    }
  }
  if (!emitted) {
    for (const file of files) {
      result[file] = Object.prototype.hasOwnProperty.call(oldFrames, file)
        ? oldFrames[file]
        : synthesized[file];
    }
  }
  return result;
}

function anchorsOrderOf(framesMap, files) {
  const targetSet = new Set(files);
  return Object.keys(framesMap).filter((key) => targetSet.has(key));
}

// ---- character.json rebuild -------------------------------------------------

function rebuildCharacterAction(paths, characterDoc, doc) {
  const actions = Array.isArray(characterDoc.actions) ? characterDoc.actions.slice() : null;
  if (!actions) return { actions: null, entry: null };
  const measured = doc.frames.map((frame) => {
    const abs = resolveFramePath(paths, frame.file);
    return abs ? measureFrameFile(abs) : { ok: false };
  });
  const feet = measured.filter((m) => m.ok && m.footLine !== null).map((m) => m.footLine);
  const medianFoot = feet.length ? median(feet) : null;
  const frames = doc.frames.map((frame, index) => {
    const m = measured[index];
    const fallback = (frame && frame.geometry) || {};
    return {
      file: frame.file,
      geometry: {
        footLine: m.ok && m.footLine !== null ? m.footLine : (fallback.footLine !== undefined ? fallback.footLine : null),
        visibleWidth: m.ok ? m.visibleWidth : (fallback.visibleWidth !== undefined ? fallback.visibleWidth : null),
        visibleHeight: m.ok ? m.visibleHeight : (fallback.visibleHeight !== undefined ? fallback.visibleHeight : null),
      },
    };
  });
  const index = actions.findIndex((entry) => entry && entry.id === doc.id);
  const base = index >= 0 ? actions[index] : null;
  const entry = {
    ...(base || {}),
    id: doc.id,
    loop: doc.loop,
    direction: doc.direction,
    frames,
    geometry: {
      ...((base && base.geometry) || {}),
      footLine: medianFoot !== null ? medianFoot : ((base && base.geometry && base.geometry.footLine) !== undefined ? base.geometry.footLine : null),
    },
  };
  if (index >= 0) actions[index] = entry;
  else {
    // keep the character.json actions array sorted by id (its existing order)
    const insertAt = actions.findIndex((candidate) => candidate && candidate.id > doc.id);
    if (insertAt >= 0) actions.splice(insertAt, 0, entry);
    else actions.push(entry);
  }
  return { actions, entry };
}

// ---- write helpers ----------------------------------------------------------

function writePackJson(absPath, value) {
  fs.writeFileSync(absPath, `${canonicalPackJson(value)}\n`);
}

// ---- the publish kernel -----------------------------------------------------

// publishAction({ contentDir, charactersRoot, actionId }) ->
//   { ok: true, noop: true }                            — unchanged, nothing written
//   { ok: true, noop: false, summary }                  — published (backup + provenance)
//   { ok: false, violations, code? }                    — refused, nothing written
function publishAction({ contentDir, charactersRoot, actionId }) {
  const paths = createPaths({ contentDir, charactersRoot });
  const docRel = `actions/${actionId}.json`;

  const docFile = readJsonIfExists(path.join(paths.actionsDir, `${actionId}.json`));
  if (!docFile.exists || !docFile.value) {
    return { ok: false, violations: [violation(docRel, 'action.parse', docFile.exists ? 'unparseable JSON' : 'missing')], code: 'ACTION_DOC_MISSING' };
  }
  const parsed = model.parseActionDoc(docFile.value);
  if (!parsed.ok) {
    return { ok: false, violations: [violation(docRel, 'action.parse', parsed.message)], code: parsed.code };
  }
  const doc = parsed.action;

  const { ok, violations } = validateForPublish(paths, doc);
  if (!ok) return { ok: false, violations, code: 'ACTION_VALIDATION_FAILED' };

  const animationsFile = readJsonIfExists(paths.animationsPath);
  const anchorsFile = readJsonIfExists(paths.anchorsPath);
  if (!animationsFile.exists || !animationsFile.value || !anchorsFile.exists || !anchorsFile.value) {
    return { ok: false, violations: [violation('animation/', 'pack.readable', 'animations.json/anchors.json missing or unparseable')], code: 'PACK_READ_FAILED' };
  }
  const packAnimations = animationsFile.value;
  const packAnchors = anchorsFile.value;
  const oldEntry = packAnimations.animations ? packAnimations.animations[actionId] : null;
  const files = doc.frames.map((frame) => frame.file);

  // New/changed content assets that must sync into the pack (art updates and
  // freshly imported frames). Bytes-equal files are skipped (no-op friendly).
  const fileOps = [];
  for (const file of files) {
    const contentAsset = path.join(paths.assetsDir, file);
    const packAsset = path.join(paths.packRoot, file);
    let contentBytes = null;
    try {
      contentBytes = fs.readFileSync(contentAsset);
    } catch {
      contentBytes = null; // not a content asset — the pack copy is the source
    }
    if (!contentBytes) continue;
    let packBytes = null;
    try {
      packBytes = fs.readFileSync(packAsset);
    } catch {
      packBytes = null;
    }
    if (!packBytes || !packBytes.equals(contentBytes)) {
      fileOps.push({ kind: packBytes ? 'overwrite' : 'add', file, src: contentAsset, dst: packAsset });
    }
  }

  const newEntry = buildPackEntry(paths, doc, oldEntry, packAnchors);
  const entryChanged = !oldEntry
    || oldEntry.loop !== doc.loop
    || oldEntry.direction !== doc.direction
    || !deepEqual(
      (oldEntry.frames || []).map((frame) => ({ file: frame.file, durationMs: frame.durationMs === undefined ? null : frame.durationMs })),
      doc.frames.map((frame) => ({ file: frame.file, durationMs: frame.durationMs === undefined ? null : frame.durationMs }))
    );
  // a frame may appear more than once in the sequence (deliberate repeats are
  // legal); anchors map keys are inherently unique, so the E5a-R1 invariant
  // compares against the UNIQUE metadata order — otherwise a duplicated frame
  // makes every publish look like it needs an order repair (never a no-op).
  const desiredOrder = [...new Set(files)];
  const currentOrder = anchorsOrderOf(packAnchors.frames || {}, files);
  const anchorsChanged = !deepEqual(currentOrder, desiredOrder);
  const animationsChanged = entryChanged;
  if (!animationsChanged && !anchorsChanged && fileOps.length === 0) {
    return { ok: true, noop: true, summary: { actionId, frames: files.length, checked: 'identical to the pack' } };
  }

  // character.json: rebuild the target action entry from fresh measurements.
  const characterFile = readJsonIfExists(paths.characterJsonPath);
  const characterDoc = characterFile.exists && characterFile.value ? characterFile.value : null;
  let characterChanged = false;
  let rebuiltActions = null;
  if (characterDoc) {
    const rebuilt = rebuildCharacterAction(paths, characterDoc, doc);
    if (rebuilt.actions) {
      rebuiltActions = rebuilt.actions;
      characterChanged = !deepEqual(characterDoc.actions, rebuilt.actions);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(paths.backupsRoot, timestamp);

  // ---- write phase (all reads and diffs are done; failures roll back) ------
  const backups = []; // { file, backupAbs }
  const added = []; // pack-relative paths created
  const rewritten = [];
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = (absPath, name) => {
      const backupAbs = path.join(backupDir, name);
      fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
      fs.copyFileSync(absPath, backupAbs);
      backups.push({ file: absPath, backupAbs });
    };
    if (fileOps.some((op) => op.kind === 'overwrite')) {
      for (const op of fileOps.filter((candidate) => candidate.kind === 'overwrite')) backup(op.dst, path.join('assets', op.file));
    }
    if (animationsChanged) backup(paths.animationsPath, 'animations.json');
    if (anchorsChanged) backup(paths.anchorsPath, 'anchors.json');
    if (characterChanged) backup(paths.characterJsonPath, 'character.json');

    for (const op of fileOps) {
      fs.mkdirSync(path.dirname(op.dst), { recursive: true });
      fs.copyFileSync(op.src, op.dst);
      if (op.kind === 'add') added.push(op.file);
      rewritten.push(op.file);
    }
    if (animationsChanged) {
      const nextAnimations = {
        ...packAnimations,
        animations: { ...packAnimations.animations, [actionId]: newEntry },
      };
      writePackJson(paths.animationsPath, nextAnimations);
      rewritten.push('animation/animations.json');
    }
    if (anchorsChanged) {
      const synthesized = {};
      for (const file of files) {
        if (!Object.prototype.hasOwnProperty.call(packAnchors.frames || {}, file)) {
          synthesized[file] = synthesizeAnchorEntry(paths, file, packAnchors);
        }
      }
      const nextAnchors = {
        ...packAnchors,
        frames: rebuildAnchorsFrames(packAnchors.frames || {}, files, synthesized),
      };
      writePackJson(paths.anchorsPath, nextAnchors);
      rewritten.push('animation/anchors.json');
    }
    if (characterChanged) {
      fs.writeFileSync(paths.characterJsonPath, `${JSON.stringify({ ...characterDoc, actions: rebuiltActions }, null, 2)}\n`);
      rewritten.push('character.json');
    }
  } catch (error) {
    // 失败 = 不落盘：restore every pre-publish byte, remove created files.
    for (const entry of backups) {
      try { fs.copyFileSync(entry.backupAbs, entry.file); } catch { /* best effort */ }
    }
    for (const file of added) {
      try { fs.unlinkSync(path.join(paths.packRoot, file)); } catch { /* best effort */ }
    }
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, code: 'PUBLISH_WRITE_FAILED', violations: [violation(docRel, 'publish.write', String((error && error.message) || error))], rolledBack: true };
  }

  const changes = [];
  if (fileOps.length > 0) changes.push(`sync ${fileOps.length} frame file(s) into the pack (${fileOps.map((op) => op.kind).join(', ')})`);
  if (animationsChanged) changes.push('animations.json: the target action entry rewritten (order/durations/loop/direction)');
  if (anchorsChanged) changes.push('anchors.json: frames key order repaired to the new metadata order (E5a-R1)');
  if (characterChanged) changes.push('character.json: the action entry rebuilt from freshly measured geometry');

  const provenanceEntry = {
    schemaVersion: SCHEMA_VERSION,
    actionId,
    packId: PACK_ID,
    publishedAt: new Date().toISOString(),
    backupDir, // absolute — operational data; the content red-line scan skips provenance/
    backupDirRelative: path.relative(paths.contentDir, backupDir),
    summary: changes.join('; '),
    frames: files,
    files: { rewritten, added },
    changes,
  };
  fs.mkdirSync(paths.provenanceDir, { recursive: true });
  const provenancePath = path.join(paths.provenanceDir, `${timestamp}-${actionId}.json`);
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenanceEntry, null, 2)}\n`);

  return {
    ok: true,
    noop: false,
    summary: {
      actionId,
      backupDir,
      backupDirRelative: provenanceEntry.backupDirRelative,
      provenancePath,
      changes,
      rewritten,
      added,
      animationsChanged,
      anchorsChanged,
      characterChanged,
    },
  };
}

// ---- staged preview pack -----------------------------------------------------

// stagePreviewPack({ contentDir, charactersRoot, actionId }) -> { ok, frames,
// loop, direction, defaultFrameDurationMs, animationsPath, anchorsPath } —
// writes content/build/preview-pack/{animations,anchors}.json carrying the
// EDITED play order so the workbench preview boots the real office page with
// the draft sequence (production bytes untouched). Fails closed on validation.
function stagePreviewPack({ contentDir, charactersRoot, actionId }) {
  const paths = createPaths({ contentDir, charactersRoot });
  const docFile = readJsonIfExists(path.join(paths.actionsDir, `${actionId}.json`));
  if (!docFile.exists || !docFile.value) {
    return { ok: false, violations: [violation(`actions/${actionId}.json`, 'action.parse', docFile.exists ? 'unparseable JSON' : 'missing')], code: 'ACTION_DOC_MISSING' };
  }
  const parsed = model.parseActionDoc(docFile.value);
  if (!parsed.ok) {
    return { ok: false, violations: [violation(`actions/${actionId}.json`, 'action.parse', parsed.message)], code: parsed.code };
  }
  const doc = parsed.action;
  const { ok, violations } = validateForPublish(paths, doc);
  if (!ok) return { ok: false, violations, code: 'ACTION_VALIDATION_FAILED' };

  const animationsFile = readJsonIfExists(paths.animationsPath);
  const anchorsFile = readJsonIfExists(paths.anchorsPath);
  if (!animationsFile.exists || !animationsFile.value || !anchorsFile.exists || !anchorsFile.value) {
    return { ok: false, violations: [violation('animation/', 'pack.readable', 'animations.json/anchors.json missing or unparseable')], code: 'PACK_READ_FAILED' };
  }
  const packAnimations = animationsFile.value;
  const packAnchors = anchorsFile.value;
  const files = doc.frames.map((frame) => frame.file);
  const newEntry = buildPackEntry(paths, doc, packAnimations.animations ? packAnimations.animations[actionId] : null, packAnchors);
  const synthesized = {};
  for (const file of files) {
    if (!Object.prototype.hasOwnProperty.call(packAnchors.frames || {}, file)) {
      synthesized[file] = synthesizeAnchorEntry(paths, file, packAnchors);
    }
  }
  const stagedAnimations = {
    ...packAnimations,
    animations: { ...packAnimations.animations, [actionId]: newEntry },
  };
  const stagedAnchors = {
    ...packAnchors,
    frames: rebuildAnchorsFrames(packAnchors.frames || {}, files, synthesized),
  };
  fs.mkdirSync(paths.previewPackDir, { recursive: true });
  writePackJson(path.join(paths.previewPackDir, 'animations.json'), stagedAnimations);
  writePackJson(path.join(paths.previewPackDir, 'anchors.json'), stagedAnchors);
  return {
    ok: true,
    actionId,
    frames: files,
    loop: doc.loop,
    direction: doc.direction,
    defaultFrameDurationMs: typeof packAnimations.defaultFrameDurationMs === 'number' ? packAnimations.defaultFrameDurationMs : model.DEFAULT_FRAME_DURATION_MS,
    animationsPath: path.join(paths.previewPackDir, 'animations.json'),
    anchorsPath: path.join(paths.previewPackDir, 'anchors.json'),
  };
}

module.exports = {
  PACK_ID,
  createPaths,
  resolveFramePath,
  validateForPublish,
  buildPackEntry,
  rebuildAnchorsFrames,
  publishAction,
  stagePreviewPack,
};
