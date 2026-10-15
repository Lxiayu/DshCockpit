'use strict';

// studio/lib/actions/service.js — the action/review service bundle (P3).
//
// One entry point for the bench, the CLI and the IPC surface:
//   list      — every action with its v2 summary, notes and publish state
//   show      — one action: doc (v2), summary, the runtime compile-down + what
//               the runtime cannot express, and its review notes
//   migrate   — v1 → v2 (writes the doc, backs the previous one up)
//   publish   — the REAL publish kernel (src/workbench/lib/action-publisher.js);
//               the studio only adds the v2→v1 diff report around it
//   notes     — frame-anchored review notes (./notes.js)
//   gaps      — 能力缺口检查 (./gaps.js)
//
// The publish kernel stays the single writer of the production pack: the studio
// never writes resources/** itself.

const path = require('node:path');
const fs = require('node:fs');

// <repo>/studio/lib/actions/service.js → <repo>: the measurement libraries the
// bench and the publish gate share live in the TOOL tree.
const TOOL_ROOT = path.resolve(__dirname, '..', '..', '..');

const schema = require('./schema.js');
const notes = require('./notes.js');
const gaps = require('./gaps.js');

// Alpha-weighted centroid + the median x of non-transparent pixels (the two
// centers the normalization pipeline reasons about).
function measureCenters(absPath) {
  if (!absPath) return null;
  try {
    const png = require(path.join(TOOL_ROOT, 'src', 'workbench', 'lib', 'png-geometry.js'));
    const image = png.decodePngFile(absPath);
    const data = image.data;
    let mass = 0;
    let sumX = 0;
    let sumY = 0;
    const xs = [];
    const threshold = 8; // the pipeline's bounds threshold
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const alpha = data[(y * image.width + x) * 4 + 3];
        if (alpha < threshold) continue;
        mass += alpha;
        sumX += x * alpha;
        sumY += y * alpha;
        xs.push(x);
      }
    }
    if (mass === 0) return null;
    xs.sort((a, b) => a - b);
    const mid = Math.floor(xs.length / 2);
    const medianX = xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid];
    return {
      centroid: { x: Number((sumX / mass).toFixed(2)), y: Number((sumY / mass).toFixed(2)) },
      medianX: Number(medianX.toFixed(2)),
      opaquePixels: xs.length,
    };
  } catch {
    return null;
  }
}

// Compares only the fields the runtime owns; the pack entry carries extras the
// studio never authors (anchor/visibleBounds are measured, state is derived).
function runtimeFieldsEqual(packEntry, compiledEntry) {
  const normalize = (entry) => ({
    direction: entry.direction,
    loop: entry.loop,
    frames: (entry.frames || []).map((frame) => ({
      file: frame.file,
      durationMs: frame.durationMs === undefined ? null : frame.durationMs,
    })),
    // v2 metadata is part of "is the pack up to date" since P3's follow-up: a tags-only
    // edit must read as 需发布, not as "一致".
    tags: Array.isArray(entry.tags) && entry.tags.length > 0 ? entry.tags : null,
    pingPong: entry.pingPong === true ? true : null,
    events: Array.isArray(entry.events) && entry.events.length > 0 ? entry.events : null,
  });
  return JSON.stringify(normalize(packEntry)) === JSON.stringify(normalize(compiledEntry));
}

function createActionServices({ repoRoot, contentDir, charactersRoot, publisher, characterId = 'whale-girl' }) {
  const paths = publisher.createPaths({ contentDir, charactersRoot });
  const actionsDir = paths.actionsDir;
  const backupsRoot = path.join(contentDir, 'build', 'backups', 'actions');

  function docPath(actionId) {
    return path.join(actionsDir, `${actionId}.json`);
  }

  function readDoc(actionId) {
    const file = docPath(actionId);
    if (!fs.existsSync(file)) return { ok: false, code: 'ACTION_DOC_MISSING', message: `no actions/${actionId}.json` };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return { ok: false, code: 'ACTION_JSON_UNPARSEABLE', message: error.message };
    }
    const parsed = schema.parseActionDocV2(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, file, raw, doc: parsed.doc, migratedFrom: parsed.migratedFrom };
  }

  function listActionIds() {
    let names = [];
    try {
      names = fs.readdirSync(actionsDir).filter((name) => name.endsWith('.json') && !name.endsWith('.notes.json'));
    } catch {
      names = [];
    }
    const fromContent = names.map((name) => name.slice(0, -'.json'.length));
    const packIds = [];
    try {
      const packAnimations = JSON.parse(fs.readFileSync(paths.animationsPath, 'utf8'));
      packIds.push(...Object.keys(packAnimations.animations || {}));
    } catch { /* pack unreadable: content-only view */ }
    return [...new Set([...fromContent, ...packIds])].sort();
  }

  function list() {
    const rows = [];
    for (const actionId of listActionIds()) {
      const loaded = readDoc(actionId);
      const packEntry = packEntryFor(actionId);
      const listed = notes.listNotes({ actionsDir, actionId, frames: loaded.ok ? loaded.doc.frames : null });
      rows.push({
        id: actionId,
        hasDoc: loaded.ok,
        // the RAW schema version on disk (the parsed doc is always normalised to v2)
        schemaVersion: loaded.ok ? loaded.raw.schemaVersion : null,
        frames: loaded.ok ? loaded.doc.frames.length : (packEntry ? packEntry.frames.length : 0),
        direction: loaded.ok ? loaded.doc.direction : (packEntry ? packEntry.direction : null),
        loop: loaded.ok ? loaded.doc.loop : (packEntry ? packEntry.loop : null),
        pingPong: loaded.ok ? loaded.doc.pingPong : null,
        tags: loaded.ok ? loaded.doc.tags : [],
        events: loaded.ok ? loaded.doc.events.length : 0,
        totalMs: loaded.ok ? schema.summarize(loaded.doc).totalMs : null,
        inPack: Boolean(packEntry),
        openNotes: listed.ok ? listed.open : null,
        staleNotes: listed.ok ? listed.stale : null,
      });
    }
    return { ok: true, actions: rows };
  }

  function packEntryFor(actionId) {
    try {
      const packAnimations = JSON.parse(fs.readFileSync(paths.animationsPath, 'utf8'));
      return packAnimations.animations ? packAnimations.animations[actionId] || null : null;
    } catch {
      return null;
    }
  }

  function show(actionId) {
    const loaded = readDoc(actionId);
    if (!loaded.ok) return loaded;
    const compiled = schema.compileDown(loaded.doc);
    const packEntry = packEntryFor(actionId);
    const listed = notes.listNotes({ actionsDir, actionId, frames: loaded.doc.frames });
    return {
      ok: true,
      file: loaded.file,
      migratedFrom: loaded.migratedFrom,
      doc: loaded.doc,
      summary: schema.summarize(loaded.doc),
      runtime: {
        entry: compiled.entry,
        runtimeSafe: compiled.runtimeSafe,
        dropped: compiled.dropped,
        packFrames: packEntry ? packEntry.frames.map((frame) => frame.file) : null,
        docFrames: loaded.doc.frames.map((frame) => frame.file),
        frameOrderMatches: packEntry
          ? JSON.stringify(packEntry.frames.map((frame) => frame.file)) === JSON.stringify(loaded.doc.frames.map((frame) => frame.file))
          : false,
        // inSync = the PACK reflects the DOC for every runtime field (order, per-frame
        // duration, direction, loop). A changed duration with an unchanged frame list
        // is exactly the case that must read as "publish me".
        inSync: packEntry ? runtimeFieldsEqual(packEntry, compiled.entry) : false,
      },
      notes: listed.ok ? listed.notes : [],
      notesFile: listed.file || null,
    };
  }

  // v1 → v2 (idempotent; writes only when something changes — 无变更不落盘)
  function migrate(actionId) {
    const loaded = readDoc(actionId);
    if (!loaded.ok) return loaded;
    if (loaded.doc.schemaVersion === schema.SCHEMA_VERSION && loaded.raw.schemaVersion === schema.SCHEMA_VERSION) {
      return { ok: true, actionId, noop: true, file: loaded.file };
    }
    const backup = path.join(backupsRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${actionId}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, `${JSON.stringify(loaded.raw, null, 2)}\n`);
    fs.writeFileSync(loaded.file, `${JSON.stringify(loaded.doc, null, 2)}\n`);
    return { ok: true, actionId, noop: false, file: loaded.file, backup, doc: loaded.doc };
  }

  function migrateAll() {
    const migrated = [];
    const skipped = [];
    for (const actionId of listActionIds()) {
      const outcome = migrate(actionId);
      if (!outcome.ok) { skipped.push({ actionId, code: outcome.code }); continue; }
      if (outcome.noop) skipped.push({ actionId, code: 'ALREADY_V2' });
      else migrated.push(actionId);
    }
    return { ok: true, migrated, skipped };
  }

  // The REAL publish kernel writes the pack; the studio reports the v2→v1 drop.
  function publish(actionId) {
    const loaded = readDoc(actionId);
    const compiled = loaded.ok ? schema.compileDown(loaded.doc) : { entry: null, dropped: [], runtimeSafe: false };
    const outcome = publisher.publishAction({ contentDir, charactersRoot, actionId });
    return {
      ...outcome,
      runtime: { dropped: compiled.dropped, runtimeSafe: compiled.runtimeSafe },
      schemaVersion: loaded.ok ? loaded.doc.schemaVersion : null,
    };
  }

  function stage(actionId) {
    return publisher.stagePreviewPack({ contentDir, charactersRoot, actionId });
  }

  // The review bench's data: per-frame measurements (the SAME measurement code the
  // publish gate uses), the notes attached to each frame, and the playback facts.
  function bench(actionId) {
    const loaded = readDoc(actionId);
    if (!loaded.ok) return loaded;
    const geometry = require(path.join(TOOL_ROOT, 'src', 'workbench', 'lib', 'character-geometry.js'));
    const doc = loaded.doc;
    const measured = doc.frames.map((frame, index) => {
      const abs = publisher.resolveFramePath(paths, frame.file);
      const outcome = abs ? geometry.measureFrameFile(abs) : { ok: false, code: 'FRAME_PATH_UNRESOLVED' };
      // the SAME two-root resolution the editor uses: a content asset wins over
      // the pack (imported frames are reviewable before they are published)
      const contentAsset = path.join(paths.assetsDir, frame.file);
      const url = fs.existsSync(contentAsset)
        ? `workbench://local/content/characters/${characterId}/assets/${frame.file}`
        : `workbench://local/pack/${frame.file}`;
      // The bench visualises TWO centers because the pipeline distinguishes them:
      // the alpha-weighted CENTROID (where the mass is — props pull it) and the
      // MEDIAN of the non-transparent x (what normalization aligns). Showing both
      // is how a reviewer sees drift the geometry gate tolerates.
      const centers = measureCenters(abs);
      return {
        index,
        file: frame.file,
        basename: frame.file.split('/').pop(),
        durationMs: frame.durationMs,
        url,
        abs,
        ok: outcome.ok === true,
        code: outcome.code || null,
        footLine: outcome.ok ? outcome.footLine : null,
        visibleHeight: outcome.ok ? outcome.visibleHeight : null,
        visibleWidth: outcome.ok ? outcome.visibleWidth : null,
        centroid: centers ? centers.centroid : null,
        medianX: centers ? centers.medianX : null,
      };
    });
    const footLines = measured.filter((frame) => frame.footLine !== null).map((frame) => frame.footLine);
    const median = (values) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    const medianFoot = median(footLines);
    const listed = notes.listNotes({ actionsDir, actionId, frames: doc.frames });
    return {
      ok: true,
      actionId,
      schemaVersion: doc.schemaVersion,
      summary: schema.summarize(doc),
      frames: measured.map((frame) => ({
        ...frame,
        footLineDelta: frame.footLine === null || medianFoot === null ? null : frame.footLine - medianFoot,
      })),
      medianFootLine: medianFoot,
      declaredFootLine: doc.geometry.footLine,
      tolerancePx: doc.geometry.tolerancePx,
      redFrames: measured.filter((frame) => (
        !frame.ok
        || frame.footLine === null
        || Math.abs((frame.footLine ?? medianFoot) - medianFoot) > doc.geometry.tolerancePx
      )).length,
      notes: listed.ok ? listed.notes : [],
      runtime: {
        dropped: schema.compileDown(doc).dropped.map((entry) => entry.field),
        inSync: (() => {
          const packEntry = packEntryFor(actionId);
          return packEntry ? runtimeFieldsEqual(packEntry, schema.compileDown(doc).entry) : false;
        })(),
      },
    };
  }

  function gapReport() {
    const actionIds = listActionIds();
    const summaries = [];
    for (const actionId of actionIds) {
      const loaded = readDoc(actionId);
      if (loaded.ok) summaries.push(schema.summarize(loaded.doc));
    }
    return gaps.capabilityReport({ actionIds, actionSummaries: summaries });
  }

  return {
    paths,
    actionsDir,
    backupsRoot,
    characterId,
    list,
    show,
    readDoc,
    listActionIds,
    packEntryFor,
    migrate,
    migrateAll,
    publish,
    stage,
    gapReport,
    bench,
    // notes surface
    addNote: (input) => notes.addNote({ actionsDir, ...input }),
    listNotes: (actionId) => {
      const loaded = readDoc(actionId);
      return notes.listNotes({ actionsDir, actionId, frames: loaded.ok ? loaded.doc.frames : null });
    },
    resolveNote: (input) => notes.resolveNote({ actionsDir, ...input }),
    exportNotes: (actionId) => {
      const loaded = readDoc(actionId);
      if (!loaded.ok) return loaded;
      return notes.exportNotes({
        actionsDir,
        actionId,
        frames: loaded.doc.frames,
        summary: schema.summarize(loaded.doc),
      });
    },
    schema,
    notesLib: notes,
    gapsLib: gaps,
  };
}

module.exports = { createActionServices };
