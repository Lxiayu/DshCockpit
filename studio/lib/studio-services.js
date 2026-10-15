'use strict';

// studio/lib/studio-services.js — the studio's own service layer (main process).
//
// The workbench app layer (src/workbench/app/**) owns everything the tool has
// today: the content tree, geometry reports, the catalog validator, the golden
// gallery, the action timeline + publish kernel. The studio adds the capability
// domains the brief asks for (project & assets, provenance passport, scene
// editor, pipeline, behaviour graph, dialogue, diagnostics) here, so both
// entries keep one implementation per concern.
//
// P0 surface: info + the asset passport (studio/lib/provenance.js).
// Later phases register their own creators against the same bundle.

const path = require('node:path');
const fs = require('node:fs');
const provenance = require('./provenance.js');
const projectLib = require('./project.js');
const dshpack = require('./dshpack.js');
const { createSceneServices } = require('./scene/index.js');
const zoneSync = require('./scene/zone-sync.js');
const { createActionServices } = require('./actions/service.js');
const pipelineLib = require('./pipeline/stages.js');
const qcFramesLib = require('./pipeline/qc-frames.js');
const qcVideoLib = require('./pipeline/qc-video.js');
const mattingLib = require('./pipeline/matting.js');
const { createCache } = require('./pipeline/cache.js');
const { runPipeline, resolvePlan, stageParamsFor, stageReproduceCommand, inputPathsForRecord, outputPathsForRecord } = require('./pipeline/orchestrate.js');
const intakeLib = require('./pipeline/intake.js');
const triageLib = require('./pipeline/triage.js');
const paramsLib = require('./pipeline/params.js');
const providersLib = require('./providers.js');

// <repo>/studio/lib/studio-services.js → <repo> (where the tool tree lives)
const TOOL_ROOT = path.resolve(__dirname, '..', '..');

// The triage scan the CLI's `triage show/resolve` performs: one id, looked up
// across every action's queue (or the named one). Kept here so the panel resolves
// exactly the entries the CLI would find.
function findTriageEntry(contentDir, id, actionId = null) {
  const dir = path.join(contentDir, 'build', 'triage');
  let actions = [];
  if (actionId) actions = [String(actionId)];
  else {
    try {
      actions = fs.readdirSync(dir)
        .filter((name) => name.endsWith(triageLib.FILE_SUFFIX))
        .map((name) => name.slice(0, -triageLib.FILE_SUFFIX.length))
        .sort();
    } catch { actions = []; }
  }
  for (const action of actions) {
    const queue = triageLib.createTriageQueue({ contentDir, actionId: action });
    if (!queue.ok) continue;
    const entry = queue.show(id);
    if (entry) return { entry, actionId: action, file: queue.file };
  }
  return null;
}

const STUDIO_VERSION = '0.1.0';

// The behaviour-graph interpreter is the PRODUCT's shared module (src/office/...), so
// the studio imports the tool tree's copy — one implementation, two consumers.
const graphLib = require(path.join(TOOL_ROOT, 'src', 'office', 'behavior-graph', 'index.js'));
const videoLib = require('./video/action-video.js');
const { createGraphFileService } = require('./graph-file.js');
const corpusLib = require('./dialogue/corpus.js');
const { createPreviewRunner, SCENARIOS } = require('./preview/runner.js');
const alphaProbeLib = require('./pipeline/alpha-probe.js');

// The runtime probes (alpha measurement, A/B cadence) need a real Chromium, i.e. the
// repo's Electron dev dependency; every video call degrades with a stable code when
// it is missing instead of pretending.
function electronBinAvailable() {
  const bin = path.join(TOOL_ROOT, 'node_modules', '.bin', 'electron');
  return fs.existsSync(bin) ? bin : null;
}

function createStudioServices({ repoRoot, contentDir, charactersRoot, packId, projectRoot, packsDir }) {
  // The project root defaults to the content tree: that is what the repository's
  // project.json describes (see content/project.json and studio/docs/contracts.md).
  const root = path.resolve(projectRoot || contentDir || path.join(repoRoot, 'content'));
  // provenance.createProvenance takes the CHARACTER content directory
  // (content/characters/<id>) — the workbench service layer's contentDir is the
  // tree root (content/**), so the character directory is derived here.
  const characterDir = path.join(repoRoot, 'content', 'characters', provenance.DEFAULT_CHARACTER_ID);
  const passport = provenance.createProvenance({
    repoRoot,
    contentDir: characterDir,
    charactersRoot: charactersRoot || path.join(repoRoot, 'resources', 'characters'),
    officeRoot: path.join(repoRoot, 'resources', 'office'),
    photoRoot: path.join(repoRoot, 'photo'),
    packId: packId || provenance.DEFAULT_PACK_ID,
  });
  // Every write target the panels name is resolved through here: an absolute path is
  // taken as-is, a relative one means "inside the project tree". Resolving against the
  // process cwd was wrong — the studio runs as `electron studio/`, so relative paths
  // landed under studio/ (caught when a probe left studio/content/build/ behind).
  const resolveProjectPath = (target) => (path.isAbsolute(String(target)) ? path.resolve(String(target)) : path.resolve(root, String(target)));
  const packsOutDir = path.resolve(packsDir || path.join(repoRoot, 'content', 'build', 'packs'));
  // The stage cache lives next to the project data (disposable by design).
  const cacheStore = createCache({ repoRoot });
  // the preview runner lives for the life of the studio process (one simulation)
  let previewRunner = null;
  // the content watcher (hot reload) — one per process
  let contentWatcher = null;
  // the renderer-side telemetry reader (the main process owns the frame handle)
  let telemetryReader = null;
  const graphFiles = createGraphFileService({ repoRoot, contentDir: root });
  const scene = createSceneServices({ repoRoot, contentDir: root });
  const actions = createActionServices({
    repoRoot,
    contentDir: root,
    charactersRoot: charactersRoot || path.join(repoRoot, 'resources', 'characters'),
    // The publish kernel is TOOL code, so it resolves from the studio's own
    // installation (TOOL_ROOT) — a studio pointed at an exported project still
    // publishes with the same kernel. Project DATA keeps coming from repoRoot.
    publisher: require(path.join(TOOL_ROOT, 'src', 'workbench', 'lib', 'action-publisher.js')),
    characterId: provenance.DEFAULT_CHARACTER_ID,
  });

  function loadProject() {
    return projectLib.loadProject({ root });
  }

  // ---- the generation loop's shared preparation (R5) -------------------------
  //
  // ONE builder for plan and run: the chain context bin/pipeline.js builds (the
  // action's frames or the accepted delivery's, content-addressed staging under
  // content/build/pipeline/<action>/, the QC report where the publish gate reads
  // it) plus the intake door's triage bookkeeping. Two front doors, one chain —
  // which is what keeps "what the plan said would run" and "what ran" identical.

  // The stage chain: an explicit list wins (the panel's --only form, a comma
  // string or an array), otherwise the local default — S0 only with a reference,
  // S8 (the pack step) only when the caller asks for it (`publish: true`).
  function loopStageIds(stages, { hasReference = false, publish = false } = {}) {
    if (Array.isArray(stages) && stages.length) {
      return stages.map((id) => String(id).trim().toUpperCase()).filter(Boolean);
    }
    if (typeof stages === 'string' && stages.trim()) {
      return stages.split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
    }
    return [
      ...(hasReference ? ['S0'] : []),
      'S4', 'S5', 'S6',
      ...(publish ? ['S8'] : []),
    ];
  }

  function intakeSummary(intake) {
    if (!intake) return null;
    return {
      ok: intake.ok,
      code: intake.code,
      dir: intake.dir,
      accepted: intake.entries.length,
      refused: intake.refused.length,
      entries: intake.entries.map((entry) => ({ name: entry.name, kind: entry.kind, width: entry.width || null, height: entry.height || null, bytes: entry.bytes })),
      refusedNames: intake.refused.map((refusal) => ({ name: refusal.name, code: refusal.code, message: refusal.message })),
    };
  }

  function prepareLoop(options = {}) {
    const actionId = String(options.actionId || '');
    const bench = actions.bench(actionId);
    if (!bench.ok) {
      return {
        ok: false,
        code: bench.code || 'ACTION_NOT_FOUND',
        message: bench.message || `no action named ${actionId}`,
        actionId,
        note: '生成链按动作跑；office 目录资产没有流水线——它们的来源链见 provenance report <assetId>',
      };
    }
    const trees = {
      repoRoot,
      contentDir: root,
      charactersRoot: charactersRoot || path.join(repoRoot, 'resources', 'characters'),
    };
    const queue = triageLib.createTriageQueue({ contentDir: root, actionId });
    let userParams = {};
    if (options.params && typeof options.params === 'object' && !Array.isArray(options.params)) userParams = options.params;
    const referencePath = options.reference ? path.resolve(String(options.reference)) : null;
    const stageIds = loopStageIds(options.stages, { hasReference: Boolean(referencePath), publish: Boolean(options.publish) });

    // 1. 接收: the delivery door (the same gate bin/agent.js intake uses). A refused
    //    delivery is queued for triage and stops the chain — never carried forward.
    let frames = bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs }));
    let intake = null;
    if (options.deliveryDir) {
      const report = intakeLib.checkDelivery({ dir: path.resolve(String(options.deliveryDir)) });
      intake = {
        ok: report.ok, code: report.code || null, dir: report.dir, at: report.at,
        entries: report.entries || [], refused: report.refused || [], findings: report.findings || [],
      };
      for (const refusal of report.refused || []) {
        queue.open({
          stage: 'intake',
          code: refusal.code,
          severity: 'red',
          findings: refusal.findings || [{ severity: 'red', code: refusal.code, message: refusal.message, fix: refusal.fix }],
          attempts: 1,
          maxRetries: 0,
          needsHuman: true,
          reason: refusal.message,
          fix: refusal.fix || 'fix the delivery and hand it over again',
        });
      }
      if (!report.ok && report.code) {
        return { ok: false, code: report.code, message: report.message || report.dir, actionId, intake, queueFile: queue.file };
      }
      const delivered = (report.entries || []).filter((entry) => entry.kind === 'image');
      if (delivered.length) frames = delivered.map((entry) => ({ file: entry.name, abs: entry.abs }));
    }
    if (frames.length === 0) {
      return { ok: false, code: 'PIPELINE_NO_FRAMES', message: `${actionId}: 没有可入链的帧（交付目录里没有 PNG，动作也没有在盘帧）`, actionId, intake, queueFile: queue.file };
    }
    const ctx = {
      repoRoot: trees.repoRoot,
      contentDir: trees.contentDir,
      charactersRoot: trees.charactersRoot,
      frames,
      // 内容寻址暂存：<content>/build/pipeline/<action>/<段>-<key12>/ —— 参数不同落不同目录
      outRoot: path.join(root, 'build', 'pipeline', actionId),
      cleanedDir: path.join(root, 'build', 'pipeline', actionId, 'cleaned'),
      normalizedDir: path.join(root, 'build', 'pipeline', actionId, 'normalized'),
      qcReportPath: path.join(root, 'build', 'qc', `${actionId}.qc.json`),
      label: actionId,
      footLine: bench.declaredFootLine,
      tolerancePx: bench.tolerancePx,
      referencePath,
      allowNetwork: Boolean(options.allowNetwork),
      env: process.env,
      actionId,
    };
    return {
      ok: true,
      actionId,
      bench: {
        frames: bench.frames.length,
        declaredFootLine: bench.declaredFootLine ?? null,
        tolerancePx: bench.tolerancePx ?? null,
      },
      trees,
      queue,
      queueFile: queue.file,
      ctx,
      stageIds,
      userParams,
      force: Boolean(options.force),
      cache: cacheStore,
      intake,
    };
  }

  return {
    studioVersion: STUDIO_VERSION,
    repoRoot,
    contentDir,
    characterDir,
    projectRoot: root,
    packsOutDir,
    passport,
    project: projectLib,
    pack: dshpack,
    // the scene service bundle (validators + derivations) for callers that need
    // the primitives the panel's four buttons are built from
    scene,

    info() {
      const loaded = loadProject();
      return {
        ok: true,
        studio: true,
        version: STUDIO_VERSION,
        repoRoot,
        contentDir,
        characterDir,
        projectRoot: root,
        packsOutDir,
        packId: packId || provenance.DEFAULT_PACK_ID,
        segments: provenance.SEGMENTS,
        statuses: provenance.STATUSES,
        paramsDirRelative: provenance.PARAMS_DIR_RELATIVE,
        project: loaded.ok
          ? { id: loaded.project.id, label: loaded.project.label, schemaVersion: loaded.project.schemaVersion }
          : { error: loaded.code },
      };
    },

    // ---- project & assets (P1) ----
    projectInfo() {
      const loaded = loadProject();
      if (!loaded.ok) {
        return { ok: false, code: loaded.code, message: loaded.message, violations: loaded.violations || [], root };
      }
      const described = projectLib.describeProject({ root, project: loaded.project });
      return {
        ok: true,
        root,
        id: loaded.project.id,
        label: loaded.project.label,
        schemaVersion: loaded.project.schemaVersion,
        layout: loaded.project.layout,
        missing: projectLib.missingPaths(loaded.layout),
        digest: described.digest,
        totalBytes: described.totalBytes,
        counts: described.counts,
        bySuffix: described.bySuffix,
        fileCount: described.files.length,
      };
    },

    packExport({ out, dryRun = false } = {}) {
      const loaded = loadProject();
      if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
      const target = out ? path.resolve(String(out)) : path.join(packsOutDir, `${loaded.project.id}.dshpack`);
      const outcome = dshpack.exportPack({ root, project: loaded.project, out: target, dryRun });
      return { ...outcome, out: outcome.ok && !dryRun ? target : outcome.out };
    },

    packInspect({ file } = {}) {
      if (!file) return { ok: false, code: 'PACK_PATH_REQUIRED', message: 'file is required' };
      return dshpack.inspectPack({ file: path.resolve(String(file)) });
    },

    packImport({ file, dest, overwrite = false, dryRun = false } = {}) {
      if (!file) return { ok: false, code: 'PACK_PATH_REQUIRED', message: 'file is required' };
      if (!dest) return { ok: false, code: 'IMPORT_DEST_REQUIRED', message: 'dest is required' };
      return dshpack.importPack({ file: path.resolve(String(file)), dest: path.resolve(String(dest)), overwrite: Boolean(overwrite), dryRun: Boolean(dryRun) });
    },

    packRoundTrip({ tmpDir } = {}) {
      const loaded = loadProject();
      if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
      const workDir = tmpDir ? path.resolve(String(tmpDir)) : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dshpack-rt-'));
      try {
        return dshpack.verifyRoundTrip({ root, project: loaded.project, tmpDir: workDir });
      } finally {
        if (!tmpDir) fs.rmSync(workDir, { recursive: true, force: true });
      }
    },

    // ---- scene (P2): conflicts, the derived waypoint graph, zone re-sync ----
    sceneReport({ sceneId = 'flat' } = {}) {
      return scene.report({ sceneId: String(sceneId) });
    },

    sceneWaypoints({ sceneId = 'flat', write = null } = {}) {
      const graph = scene.waypoints({ sceneId: String(sceneId) });
      if (!graph.ok || !write) return graph;
      const target = resolveProjectPath(write);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(graph, null, 2)}\n`);
      return { ...graph, written: target };
    },

    sceneBoxes({ sceneId = 'flat' } = {}) {
      return scene.boxes({ sceneId: String(sceneId) });
    },

    // ---- the scene canvas editor (UI #1) ----
    sceneDraft({ sceneId = 'flat' } = {}) {
      const loaded = scene.editor.load(String(sceneId));
      if (!loaded.ok) return loaded;
      const boxes = scene.boxes({ sceneId: String(sceneId) });
      const report = scene.report({ sceneId: String(sceneId) });
      return {
        ok: true,
        sceneId: String(sceneId),
        file: loaded.file,
        scene: report.scene || { width: 1280, height: 840 },
        items: (boxes.ok ? boxes.items : []).map((item) => {
          const draftItem = loaded.draft.items.find((entry) => entry.id === item.id) || {};
          return { ...item, direction: draftItem.direction || null, layer: draftItem.layer ?? null };
        }),
        graph: report.graph || null,
        violations: report.violations || [],
        stats: report.stats || null,
        // the canvas draws the declared collision model and the seat points
        obstacles: (() => {
          const zones = require('./scene/zones.js').loadZones({ contentDir: root, sceneId: String(sceneId) });
          return zones.ok ? zones.model.obstacles.map((obstacle) => ({ id: obstacle.id, rect: {
            x: obstacle.rect.x * (report.scene ? report.scene.width : 1280),
            y: obstacle.rect.y * (report.scene ? report.scene.height : 840),
            width: obstacle.rect.width * (report.scene ? report.scene.width : 1280),
            height: obstacle.rect.height * (report.scene ? report.scene.height : 840),
          } })) : [];
        })(),
        seats: report.seats || [],
        grid: require('./scene/edit.js').GRID,
      };
    },

    // The furniture catalog, as a drop palette: the left pane shows these as tiles and a
    // drop turns one into a layout item. `url` is the same resolution the canvas uses
    // (./office-assets/flat/x.png → workbench://local/preview/office-assets/flat/x.png).
    sceneFurniture() {
      // catalogStatus() reports the miss without throwing; loadCatalog() then hands over
      // the map (its own contract is throw-on-missing, which the status call pre-empts)
      const status = scene.catalogStatus();
      if (!status.ok) return status;
      const catalog = scene.loadCatalog();
      const rows = [...catalog.assets.values()]
        .filter((asset) => asset.kind !== 'character' && asset.src)
        .map((asset) => ({
          asset: asset.id,
          kind: asset.kind,
          label: asset.label,
          direction: asset.direction || 'front',
          file: String(asset.src).split('/').pop(),
          bands: asset.layer || null,
          url: `workbench://local/preview/${String(asset.src).replace(/^\.\//, '')}`,
        }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh'));
      return { ok: true, rows, kinds: catalog.assets.size, status };
    },

    sceneEdit({ sceneId = 'flat', edits = [], save = false, allowRed = false } = {}) {
      const outcome = scene.editor.commit({
        sceneId: String(sceneId),
        edits: Array.isArray(edits) ? edits : [],
        dryRun: !save,
        allowRed: Boolean(allowRed),
      });
      if (!outcome.ok) return outcome;
      const draft = scene.editor.load(String(sceneId));
      return { ...outcome, draftVersion: draft.ok ? draft.draft.items.length : null };
    },

    // Rebuild zones.obstacles from the CURRENT layout (the fix path when the
    // validator reports SCENE_OBSTACLE_UNDECLARED / SCENE_OBSTACLE_STALE).
    sceneSyncZones({ sceneId = 'flat', write = false } = {}) {
      const meta = scene.loadSceneMeta(String(sceneId));
      if (!meta.ok) return { ok: false, code: meta.code, message: meta.message };
      const draft = scene.loadDraft(String(sceneId));
      if (!draft.ok) return { ok: false, code: draft.code, message: draft.message };
      const zones = require('./scene/zones.js').loadZones({ contentDir: root, sceneId: String(sceneId) });
      if (!zones.ok) return { ok: false, code: zones.code, message: zones.message, violations: zones.violations || [] };
      const catalog = scene.loadCatalog();
      const conflictsLib = require('./scene/conflicts.js');
      const stations = conflictsLib.deriveStations(draft.draft.items, {
        assets: catalog.assets,
        draftWidths: catalog.draftWidths,
        scene: meta.scene,
        characterFootRatio: catalog.characterFootRatio,
      });
      const synced = zoneSync.syncZones({
        draft: draft.draft,
        zones: zones.zones,
        assets: catalog.assets,
        draftWidths: catalog.draftWidths,
        scene: meta.scene,
        stations,
      });
      if (!synced.ok) return synced;
      if (!write) return { ...synced, written: null, file: zones.file };
      const applied = zoneSync.applyZonesSync({
        contentDir: root,
        sceneId: String(sceneId),
        zones: synced.zones,
        backupRoot: path.join(root, 'build', 'backups', 'zones'),
      });
      return { ...synced, ...applied, changes: synced.changes };
    },

    // ---- actions & review bench (P3) ----
    actions,

    actionList() {
      return actions.list();
    },

    actionShow(actionId) {
      return actions.show(String(actionId));
    },

    actionBench(actionId) {
      return actions.bench(String(actionId));
    },

    actionGaps() {
      return actions.gapReport();
    },

    actionMigrate(actionId) {
      return actionId ? actions.migrate(String(actionId)) : actions.migrateAll();
    },

    actionPublish(actionId) {
      return actions.publish(String(actionId));
    },

    // v2 authoring edits (tags / ping-pong / events) — the doc is the source of truth
    actionTag({ actionId, tag, remove = false } = {}) {
      const loaded = actions.readDoc(String(actionId));
      if (!loaded.ok) return loaded;
      const doc = loaded.doc;
      const value = String(tag || '').trim();
      if (!value) return { ok: false, code: 'TAG_REQUIRED', message: 'tag is required' };
      doc.tags = remove ? doc.tags.filter((entry) => entry !== value) : [...new Set([...doc.tags, value])];
      const validation = require('./actions/schema.js').validateV2(doc);
      if (!validation.ok) return { ok: false, code: validation.violations[0].check, message: validation.violations[0].detail, violations: validation.violations };
      fs.writeFileSync(loaded.file, `${JSON.stringify(doc, null, 2)}\n`);
      return { ok: true, tags: doc.tags, file: loaded.file };
    },

    actionEvent({ actionId, frame, name, remove = false } = {}) {
      const loaded = actions.readDoc(String(actionId));
      if (!loaded.ok) return loaded;
      const doc = loaded.doc;
      const schemaLib = require('./actions/schema.js');
      if (remove) {
        doc.events = doc.events.filter((event) => !(event.frame === Number(frame) && event.name === String(name)));
      } else {
        doc.events = [...doc.events, { frame: Number(frame), name: String(name) }];
      }
      const validation = schemaLib.validateV2(doc);
      if (!validation.ok) return { ok: false, code: validation.violations[0].check, message: validation.violations[0].detail, violations: validation.violations };
      fs.writeFileSync(loaded.file, `${JSON.stringify(doc, null, 2)}\n`);
      return { ok: true, events: doc.events, file: loaded.file };
    },

    actionPingPong({ actionId, value } = {}) {
      const loaded = actions.readDoc(String(actionId));
      if (!loaded.ok) return loaded;
      const doc = loaded.doc;
      doc.pingPong = Boolean(value);
      const schemaLib = require('./actions/schema.js');
      const validation = schemaLib.validateV2(doc);
      if (!validation.ok) return { ok: false, code: validation.violations[0].check, message: validation.violations[0].detail, violations: validation.violations };
      fs.writeFileSync(loaded.file, `${JSON.stringify(doc, null, 2)}\n`);
      return { ok: true, pingPong: doc.pingPong, file: loaded.file };
    },

    actionNoteList(actionId) {
      return actions.listNotes(String(actionId));
    },

    actionNoteAdd(input) {
      return actions.addNote({ ...input, actionId: String((input || {}).actionId) });
    },

    actionNoteResolve({ actionId, noteId, resolved = true } = {}) {
      return actions.resolveNote({ actionId: String(actionId), noteId: String(noteId), resolved });
    },

    actionNotesExport({ actionId, out } = {}) {
      const exported = actions.exportNotes(String(actionId));
      if (!exported.ok || !out) return exported;
      const target = resolveProjectPath(out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(exported, null, 2)}\n`);
      return { ...exported, written: target };
    },

    // ---- pipeline (P4): QC, matting, cache, providers ----
    pipelineQcAction({ actionId } = {}) {
      const bench = actions.bench(String(actionId));
      if (!bench.ok) return bench;
      return qcFramesLib.qcFrames({
        frames: bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs })),
        label: String(actionId),
        footLine: bench.declaredFootLine,
        tolerancePx: bench.tolerancePx,
      });
    },

    pipelineQcVideo({ file, expect = {} } = {}) {
      if (!file) return { ok: false, code: 'VIDEO_PATH_REQUIRED', message: 'file is required' };
      return qcVideoLib.qcVideo({ file: path.resolve(String(file)), expect: expect || {} });
    },

    pipelineMatte({ file, out = null, options = {} } = {}) {
      if (!file) return { ok: false, code: 'IMAGE_PATH_REQUIRED', message: 'file is required' };
      return mattingLib.cleanupFile({ absPath: path.resolve(String(file)), outPath: out ? path.resolve(String(out)) : null, options });
    },

    pipelineCache({ op = 'stats', stage = null } = {}) {
      if (op === 'clear') return cacheStore.clear({ stage: stage ? String(stage) : null });
      if (op === 'list') return { ok: true, rows: cacheStore.list({ stage: stage ? String(stage) : null }) };
      return { ok: true, stats: cacheStore.stats() };
    },

    pipelineProviders() {
      return { ok: true, entries: providersLib.describeRegistry(providersLib.DEFAULT_REGISTRY, process.env) };
    },

    // ---- the generation loop as a service (R5): plan / run / triage ------------
    //
    // bin/pipeline.js drives the same chain (接收 → 段 → 分诊 → 入账). The panel
    // gets it HERE, as a service: one implementation of the chain per concern, two
    // front doors. The engine is NOT re-implemented — resolvePlan/runPipeline stay
    // the only planners (plan and run cannot drift because they are the same walk),
    // triage.js the only queue, params.js the only ledger door, intake.js the only
    // delivery gate.

    /** The S0–S8 registry as the panel renders it: dependencies and cache-key params. */
    pipelineStages() {
      return {
        ok: true,
        stages: pipelineLib.STAGES.map((stage) => ({
          id: stage.id,
          name: stage.name,
          providerClass: stage.providerClass || null,
          consumes: (stage.consumes || []).slice(),
          produces: (stage.produces || []).slice(),
          paramKeys: (stage.paramKeys || []).slice(),
        })),
      };
    },

    /**
     * The chain context, built the way bin/pipeline.js builds it: the action's own
     * frames (or the accepted delivery's, through the intake door), content-addressed
     * staging under content/build/pipeline/<action>/, and the QC report where the
     * publish gate reads it. Nothing is executed here.
     */
    pipelinePrepare(options = {}) {
      return prepareLoop(options);
    },

    /** The dry walk: which stages will run, which hit the cache, and WHY. Executes nothing. */
    pipelinePlan(options = {}) {
      const prepared = prepareLoop(options);
      if (!prepared.ok) return prepared;
      const plan = resolvePlan({
        ctx: prepared.ctx,
        stageIds: prepared.stageIds,
        params: prepared.userParams,
        cache: prepared.cache,
        force: prepared.force,
      });
      return {
        ok: true,
        actionId: prepared.actionId,
        stageIds: prepared.stageIds,
        plan,
        bench: prepared.bench,
        intake: intakeSummary(prepared.intake),
        queueFile: prepared.queueFile,
        note: '（plan 只算不跑：不执行、不写缓存、不入账）',
      };
    },

    /**
     * Execute the chain. `onStage` receives every stage record as it happens (the
     * IPC layer pushes them to the window), and a failing stage's entry lands in
     * the triage queue with its evidence — the same run bin/pipeline.js performs.
     */
    pipelineRun(options = {}) {
      const prepared = prepareLoop(options);
      if (!prepared.ok) return prepared;
      const onStage = typeof options.onStage === 'function' ? options.onStage : null;
      const maxRetries = options.maxRetries === undefined ? 3 : Number(options.maxRetries);
      const outcome = runPipeline({
        ctx: prepared.ctx,
        stageIds: prepared.stageIds,
        params: prepared.userParams,
        maxRetries,
        cache: prepared.cache,
        force: prepared.force,
        triage: prepared.queue,
        onStage,
      });
      // 参数入账: the CLI's policy verbatim — a sandbox tree records automatically,
      // the repo's own tree only when the caller asks (the panel's checkbox). The
      // policy is ENFORCED here, not just reported: computing `enabled` and then
      // writing anyway is exactly how a "read-only by default" tree grows a ledger
      // (the R5 evidence probe caught that shape).
      const enabled = options.recordParams === undefined ? Boolean(process.env.STUDIO_CONTENT_DIR) : Boolean(options.recordParams);
      const recorded = [];
      let refused = null;
      if (enabled) {
        for (const stage of outcome.stages) {
          if (stage.status !== 'ran' || stage.id === 'S8') continue; // S8 的入账是发布台账自己
          const stageParams = stageParamsFor(stage.id, outcome.params);
          const result = paramsLib.recordCall({
            repoRoot: prepared.trees.repoRoot,
            characterId: provenance.DEFAULT_CHARACTER_ID,
            actionId: prepared.actionId,
          call: {
            kind: 'frame-sheet',
            tool: `studio/lib/pipeline/stages.js#${stage.id}`,
            command: stageReproduceCommand(prepared.actionId, stage.id, stageParams),
            agent: options.agent || null,
            params: stageParams,
            seed: null,
            inputs: inputPathsForRecord(stage, prepared.ctx),
            outputs: outputPathsForRecord(stage, prepared.ctx),
            note: `pipeline stage ${stage.id} (${stage.name})`,
          },
        });
        if (!result.ok) {
          refused = { code: result.code || 'LEDGER_REFUSED', error: result.error, fingerprints: result.fingerprints || [] };
          break;
        }
        if (!result.skipped) recorded.push(stage.id);
        }
      }
      return {
        ok: outcome.ok && !refused,
        actionId: prepared.actionId,
        stageIds: prepared.stageIds,
        outcome,
        queued: outcome.queued,
        queueFile: prepared.queueFile,
        bench: prepared.bench,
        intake: intakeSummary(prepared.intake),
        ledger: { enabled, recorded, refused },
        triage: prepared.queue.stats(),
      };
    },

    /** Every triage entry (one action, or all of them), newest first. */
    pipelineTriageList({ actionId = null, status = null } = {}) {
      const dir = path.join(root, 'build', 'triage');
      let ids = [];
      if (actionId) ids = [String(actionId)];
      else {
        try {
          ids = fs.readdirSync(dir)
            .filter((name) => name.endsWith(triageLib.FILE_SUFFIX))
            .map((name) => name.slice(0, -triageLib.FILE_SUFFIX.length))
            .sort();
        } catch { ids = []; }
      }
      const entries = [];
      for (const id of ids) {
        const queue = triageLib.createTriageQueue({ contentDir: root, actionId: id });
        if (!queue.ok) continue;
        for (const entry of queue.list({ status: status || null })) entries.push({ ...entry, file: queue.file });
      }
      entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return { ok: true, entries, dir, actionId: actionId ? String(actionId) : null };
    },

    /** open → resolved. The note is mandatory (the engine fails closed without one). */
    pipelineTriageResolve({ id = null, note = null, by = null, actionId = null } = {}) {
      const found = findTriageEntry(root, String(id || ''), actionId ? String(actionId) : null);
      if (!found) return { ok: false, code: 'TRIAGE_UNKNOWN', error: `unknown triage id: ${id}` };
      const queue = triageLib.createTriageQueue({ contentDir: root, actionId: found.actionId });
      const outcome = queue.resolve(found.entry.id, { note, by: by || null });
      if (!outcome.ok) return { ok: false, code: 'TRIAGE_RESOLVE_REFUSED', error: outcome.error };
      return { ok: true, entry: outcome.entry, file: outcome.file };
    },

    // ---- behaviour graphs (P6) — the SAME module the product can import ----
    graphValidate({ graph } = {}) {
      if (!graph) return { ok: false, code: 'GRAPH_REQUIRED', message: 'graph is required' };
      const outcome = graphLib.validateGraph(graph);
      return { ok: outcome.ok, stats: outcome.stats || null, violations: outcome.violations };
    },

    graphRun({ graph, seed = 'office-seed', employees = ['e1'], steps = 60, dtMs = 200, inject = [] } = {}) {
      if (!graph) return { ok: false, code: 'GRAPH_REQUIRED', message: 'graph is required' };
      const interpreter = graphLib.createInterpreter({ graph, seed, clock: () => 0, employees });
      if (!interpreter.ok) return { ok: false, code: 'GRAPH_INVALID', violations: interpreter.violations };
      interpreter.start();
      for (const event of inject) interpreter.inject(event);
      const ticks = [];
      for (let step = 0; step < steps; step += 1) ticks.push(interpreter.tick(dtMs));
      return { ok: true, summary: interpreter.summary(), state: interpreter.state(), trace: interpreter.trace(), effects: interpreter.effects() };
    },

    graphDiff({ graph, steps = 40, toleranceMs = 1500 } = {}) {
      if (!graph) return { ok: false, code: 'GRAPH_REQUIRED', message: 'graph is required' };
      const interpreter = graphLib.createInterpreter({ graph, seed: 'office-seed-1', clock: () => 0, employees: ['e1', 'e2'] });
      if (!interpreter.ok) return { ok: false, code: 'GRAPH_INVALID', violations: interpreter.violations };
      interpreter.start();
      const graphed = [];
      for (let step = 0; step < steps; step += 1) {
        interpreter.tick(1000);
        for (const entry of graphLib.diff.streamFromInterpreterTrace(interpreter.trace())) graphed.push(entry);
      }
      const scheduler = require(path.join(TOOL_ROOT, 'src', 'office', 'runtime', 'behavior-scheduler.js'));
      const movementModule = require(path.join(TOOL_ROOT, 'src', 'office', 'runtime', 'movement-controller.js'));
      const fixture = {
        version: 1,
        nodes: [
          { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
          { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
          { id: 'roam-1', position: { x: 0.25, y: 0.7 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
          { id: 'rest-1', position: { x: 0.15, y: 0.45 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
          { id: 'chat-a', position: { x: 0.35, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
        ],
        edges: [
          { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
          { from: 'hall', to: 'roam-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
          { from: 'hall', to: 'rest-1', behaviors: ['roaming', 'task', 'sleeping', 'chatting', 'resting'], bidirectional: true },
          { from: 'hall', to: 'chat-a', behaviors: ['roaming', 'task', 'sleeping', 'chatting'], bidirectional: true },
        ],
      };
      const clock = { nowMs: () => 0 };
      const movement = movementModule.createMovementController({ fixture: undefined, graph: fixture, clock });
      const engine = scheduler.createBehaviorScheduler({ graph: fixture, movement, clock, seed: 'office-seed-1', employeeIds: ['e1', 'e2'] });
      const scheduled = [];
      for (let step = 0; step < steps; step += 1) {
        for (const employeeId of ['e1', 'e2']) {
          const decision = engine.decide({ employeeId, nowMs: step * 1000, fromNodeId: 'hall' });
          if (decision && decision.activity) scheduled.push({ atMs: step * 1000, employeeId, activity: decision.activity });
        }
      }
      return graphLib.diff.diffStreams({ scheduled, graphed, toleranceMs });
    },

    // ---- the graph canvas (UI #2): the .vgraph files on disk ----
    graphList() {
      return graphFiles.list();
    },

    graphRead({ file = null, name = null } = {}) {
      return graphFiles.read({ file, name });
    },

    graphSave({ file = null, name = null, graph, dryRun = true } = {}) {
      return graphFiles.save({ file, name, graph, dryRun });
    },

    graphMoveNode({ graph, nodeId, x, y } = {}) {
      return graphFiles.moveNode({ graph, nodeId, x, y });
    },

    graphAutoLayout({ graph } = {}) {
      if (!graph) return { ok: false, code: 'GRAPH_REQUIRED', message: 'graph is required' };
      return { ok: true, layout: graphFiles.autoLayout({ graph }) };
    },

    graphFeel() {
      const feel = graphLib.feel;
      return {
        ok: true,
        constants: {
          squashAmplitude: feel.SQUASH_AMPLITUDE, squashMs: feel.SQUASH_MS, overshootCap: feel.OVERSHOOT_CAP,
          crossfadeMs: feel.CROSSFADE_MS, leadSec: feel.DEFAULT_LEAD_SEC, tailSec: feel.DEFAULT_TAIL_SEC,
        },
        squashCurve: [0, 0.225, 0.45, 0.7, 1].map((progress) => ({ progress, scale: feel.squashScale(progress) })),
        landing: [300, 900, 1500].map((speed) => ({ speedPxPerSec: speed, scale: feel.landingSquash(speed) })),
        source: '参数借用自同行拆解（dsh-pet，MIT 代码；素材与提示词未复制）— docs/strategy/2026-09-27-dsh-pet-teardown.md',
      };
    },

    // ---- the video track (P5) ----
    videoPlan({ actionId } = {}) {
      const shown = actions.show(String(actionId));
      if (!shown.ok) return shown;
      return videoLib.planTrack({ actionId: String(actionId), summary: shown.summary, tags: shown.doc.tags });
    },

    videoEncode({ actionId, out = null, size = null, fps = null, crf = null, verifyRuntime = true } = {}) {
      const bench = actions.bench(String(actionId));
      if (!bench.ok) return bench;
      const frames = bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs }));
      if (frames.length === 0) return { ok: false, code: 'ACTION_NO_FRAMES', message: String(actionId) };
      const target = out ? path.resolve(String(out)) : path.join(root, 'build', 'video', `${actionId}.webm`);
      return videoLib.encodeActionVideo({
        frames,
        outFile: target,
        size: size || undefined,
        fps: fps || undefined,
        crf: crf || undefined,
        verifyRuntime: Boolean(verifyRuntime && electronBinAvailable()),
        electronBin: electronBinAvailable(),
      });
    },

    videoProbeAlpha({ clip } = {}) {
      if (!clip) return { ok: false, code: 'VIDEO_PATH_REQUIRED', message: 'clip is required' };
      const bin = electronBinAvailable();
      if (!bin) return { ok: false, code: 'ELECTRON_BIN_MISSING', message: 'the runtime alpha probe needs the Electron dev dependency' };
      return alphaProbeLib.probeAlpha({ electronBin: bin, clip: path.resolve(String(clip)) });
    },

    videoAb({ actionId, frameMs = 200, measureMs = 2000 } = {}) {
      const bench = actions.bench(String(actionId));
      if (!bench.ok) return bench;
      const bin = electronBinAvailable();
      if (!bin) return { ok: false, code: 'ELECTRON_BIN_MISSING', message: 'the A/B needs the Electron dev dependency' };
      const frames = bench.frames.filter((frame) => frame.abs).map((frame) => ({ file: frame.file, abs: frame.abs }));
      return videoLib.abCompare({ actionId: String(actionId), frames, electronBin: bin, frameMs, measureMs, workDir: path.join(root, 'build', 'video-ab', String(actionId)) });
    },

    // ---- the dialogue corpus (P7) ----
    dialogueRead({ layer = 'base' } = {}) {
      const loaded = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer });
      if (!loaded.ok) return loaded;
      const validation = corpusLib.validateCorpus({
        base: layer === 'base' ? loaded.doc : corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'base' }).doc,
        character: layer === 'character' ? loaded.doc : corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'character' }).doc,
      });
      const topics = Object.entries(corpusLib.topicsOf(loaded.doc, layer)).map(([topic, entries]) => ({
        topic,
        entries: entries.length,
        weight: entries.reduce((sum, entry) => sum + (entry.weight || 1), 0),
      }));
      return { ok: true, layer, file: loaded.file, doc: loaded.doc, topics, validation, limits: loaded.doc.limits || null };
    },

    dialogueValidate() {
      const base = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'base' });
      const character = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'character' });
      if (!base.ok) return base;
      return corpusLib.validateCorpus({ base: base.doc, character: character.ok ? character.doc : null });
    },

    dialogueEdit({ layer = 'base', op = 'add', topic, entry = null, id = null, patch = null } = {}) {
      const loaded = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer });
      if (!loaded.ok) return loaded;
      let outcome;
      if (op === 'add') outcome = corpusLib.addEntry({ doc: loaded.doc, layer, topic: String(topic), entry });
      else if (op === 'update') outcome = corpusLib.updateEntry({ doc: loaded.doc, layer, topic: String(topic), id: String(id), patch: patch || {} });
      else if (op === 'remove') outcome = corpusLib.removeEntry({ doc: loaded.doc, layer, topic: String(topic), id: String(id) });
      else return { ok: false, code: 'DIALOGUE_OP_UNKNOWN', message: op };
      if (!outcome.ok) return outcome;
      const dry = corpusLib.save({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer, doc: outcome.doc, dryRun: true });
      if (!dry.ok) return dry;
      return { ...outcome, staged: true, validation: dry.validation };
    },

    dialogueSave({ layer = 'base', doc } = {}) {
      if (!doc) return { ok: false, code: 'CORPUS_REQUIRED', message: 'doc is required' };
      return corpusLib.save({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer, doc, dryRun: false });
    },

    dialogueImportCsv({ layer = 'base', csv } = {}) {
      const parsed = corpusLib.parseCsv(String(csv || ''));
      if (!parsed.ok) return parsed;
      const loaded = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer });
      if (!loaded.ok) return loaded;
      const merged = corpusLib.importRows({ doc: loaded.doc, layer, rows: parsed.rows });
      const dry = corpusLib.save({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer, doc: merged.doc, dryRun: true });
      if (!dry.ok) return dry;
      return { ok: true, staged: true, added: merged.added, skipped: merged.skipped, doc: merged.doc, validation: dry.validation };
    },

    // "说一遍": resolve a topic the way the runtime does and pick a line with a seed
    dialogueSay({ topic, seed = 'preview-1', context = {} } = {}) {
      const base = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'base' });
      const character = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'character' });
      if (!base.ok) return base;
      const resolved = corpusLib.resolveTopic({ base: base.doc, character: character.ok ? character.doc : null, topic: String(topic) });
      if (!resolved.ok) return resolved;
      const picked = corpusLib.pickEntry({ entries: resolved.entries, seed: String(seed), context: context || {} });
      const limits = base.doc.limits || { bubbleMs: 3200, maxConcurrent: 2, cooldownMs: 30000 };
      return {
        ok: true,
        topic: resolved.topic,
        source: resolved.source,
        fallbackUsed: resolved.source === 'base' && resolved.fallback === null,
        line: picked ? picked.entry : null,
        pick: picked ? { source: picked.source, eligible: picked.eligible, pool: picked.pool } : null,
        limits,
        bubble: picked ? {
          ms: limits.bubbleMs,
          // a rough reading pace so the bench can show what "the bubble is up" means
          chars: String(picked.entry.text).length,
          msPerChar: Number((limits.bubbleMs / Math.max(1, String(picked.entry.text).length)).toFixed(1)),
        } : null,
      };
    },

    // ---- the preview runner (P7): the REAL office module, driven from here ----
    previewStart({ config = null, seed = null } = {}) {
      if (previewRunner && typeof previewRunner.destroy === 'function') previewRunner.destroy();
      previewRunner = null;
      const runner = createPreviewRunner({
        repoRoot,
        contentDir: root,
        charactersRoot: charactersRoot || path.join(repoRoot, 'resources', 'characters'),
        seed: seed ? String(seed) : 'studio-preview-seed',
        config,
      });
      if (!runner.ok) return runner;
      previewRunner = runner;
      return { ok: true, layoutSource: runner.layoutSource, status: runner.status(), employees: runner.employeesSummary(), diagnostics: runner.diagnostics() };
    },

    previewStatus() {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return { ok: true, layoutSource: previewRunner.layoutSource, status: previewRunner.status(), employees: previewRunner.employeesSummary() };
    },

    // The runner's own snapshot stream (throttled inside the runner by SNAPSHOT_PUSH_MS).
    // The studio entry forwards it into the office frame so the picture moves with the
    // simulation instead of freezing at whatever the page pulled at boot.
    previewSubscribe(listener) {
      if (typeof listener !== 'function') return { ok: false, code: 'PREVIEW_SUBSCRIBE_INVALID' };
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      const unsubscribe = previewRunner.subscribe((_kind, payload) => listener(payload));
      return { ok: true, unsubscribe };
    },

    previewPlay({ speed = null } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return { ok: true, ...previewRunner.play(speed === null ? {} : { speed: Number(speed) }) };
    },

    previewPause() {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return { ok: true, ...previewRunner.pause() };
    },

    previewStep({ ticks = 1 } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return { ok: true, ...previewRunner.step(Number(ticks) || 1), employees: previewRunner.employeesSummary() };
    },

    previewInject({ type = 'agent/status', sessionId = 'sess-preview', seq = null, data = null } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      const outcome = previewRunner.inject({ type, sessionId, ...(seq === null ? {} : { seq: Number(seq) }), data: data || {} });
      return { ok: outcome.ok, result: outcome.result, event: outcome.event, employees: previewRunner.employeesSummary() };
    },

    previewControl({ kind = 'followup', employeeId = 'orchestrator' } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return previewRunner.control(String(kind), String(employeeId));
    },

    previewScenarios() {
      return { ok: true, scenarios: Object.entries(SCENARIOS).map(([id, steps]) => ({ id, steps: steps.length, events: steps.map((step) => step.event.type) })) };
    },

    // replay a scenario: inject each step after its delay, stepping the LOGICAL clock so
    // the result does not depend on wall time (the same reason the runner is deterministic)
    async previewRunScenario({ id } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      const steps = SCENARIOS[String(id)];
      if (!steps) return { ok: false, code: 'SCENARIO_UNKNOWN', message: `known: ${Object.keys(SCENARIOS).join(', ')}` };
      const results = [];
      let elapsed = 0;
      for (const step of steps) {
        const waitTicks = Math.max(0, Math.round((step.afterMs - elapsed) / previewRunner.TICK_MS));
        previewRunner.step(waitTicks);
        elapsed = step.afterMs;
        results.push(previewRunner.inject(step.event));
      }
      return { ok: true, id: String(id), injected: results.length, status: previewRunner.status(), employees: previewRunner.employeesSummary() };
    },

    previewDiagnostics() {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return previewRunner.diagnostics();
    },

    previewSnapshot() {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      return { ok: true, snapshot: previewRunner.snapshot() };
    },

    // ---- page-side render telemetry (P8): what the RENDERER reports, not what we assume ----
    //
    // The preview page is the real office page; its telemetry is read inside the frame (the
    // main process supplies the reader) so the diagnostics bundle carries the renderer's own
    // facts: which backend it got, whether the scene is idle-repainting, and the page's
    // diagnostics list.
    setTelemetryReader(reader) {
      telemetryReader = typeof reader === 'function' ? reader : null;
      return { ok: true, attached: Boolean(telemetryReader) };
    },

    async previewTelemetry() {
      if (!telemetryReader) return { ok: false, code: 'TELEMETRY_READER_MISSING' };
      try {
        const payload = await telemetryReader();
        return payload ? { ok: true, ...payload } : { ok: false, code: 'TELEMETRY_UNAVAILABLE' };
      } catch (error) {
        return { ok: false, code: 'TELEMETRY_FAILED', message: String((error && error.message) || error).slice(0, 200) };
      }
    },

    previewExportBundle({ out = null, extra = null } = {}) {
      if (!previewRunner) return { ok: false, code: 'PREVIEW_NOT_STARTED' };
      const bundle = previewRunner.exportBundle({ extra: extra && typeof extra === 'object' ? extra : {} });
      if (!out) return bundle;
      // A relative output path resolves against the PROJECT root, never the process cwd:
      // the studio is launched as `electron studio/`, so a relative path used to land the
      // bundle under studio/content/build/ (caught by git status after a probe run).
      const target = resolveProjectPath(out);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${bundle.text}
`);
      return { ...bundle, written: target };
    },

    // ---- hot reload (P8): content changes are watched, panels re-read on demand ----
    watchContent({ onEvent = null } = {}) {
      if (contentWatcher) return { ok: true, already: true, watching: contentWatcher.roots };
      const debounceMs = 400;
      const roots = [root, path.join(repoRoot, 'resources', 'characters', 'deepseek-default')];
      const pending = new Set();
      let timer = null;
      const emit = () => {
        timer = null;
        const paths = [...pending];
        pending.clear();
        if (onEvent) onEvent({ at: new Date().toISOString(), paths: paths.slice(0, 12), count: paths.length });
      };
      const watchers = [];
      for (const watchRoot of roots) {
        try {
          // recursive watching is available on macOS/Windows; a failure here degrades to
          // "no hot reload" rather than breaking the studio
          const watcher = fs.watch(watchRoot, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const relative = path.relative(root, path.join(watchRoot, String(filename)));
            if (relative.startsWith('build/') || relative.includes('/build/')) return; // tool output
            pending.add(relative);
            if (timer) clearTimeout(timer);
            timer = setTimeout(emit, debounceMs);
          });
          watcher.unref?.();
          watchers.push(watcher);
        } catch (error) {
          return { ok: false, code: 'CONTENT_WATCH_UNAVAILABLE', message: String(error.message).slice(0, 160), watching: [] };
        }
      }
      contentWatcher = { roots, watchers, stop: () => { for (const watcher of watchers) watcher.close(); } };
      return { ok: true, watching: roots };
    },

    unwatchContent() {
      if (!contentWatcher) return { ok: true, watching: false };
      contentWatcher.stop();
      contentWatcher = null;
      return { ok: true, watching: false };
    },

    // Re-read everything the panels show. The services already read from disk per call, so
    // this is a digest plus the reader caches that DO exist (the studio's own preview pack
    // staging and the project digest are recomputed; the runner is restarted separately
    // because a running simulation must not change under the user's feet).
    reloadContent() {
      const loaded = loadProject();
      const projectSummary = loadProject();
      const project = projectSummary.ok
        ? (() => {
          const described = projectLib.describeProject({ root, project: projectSummary.project });
          return { id: projectSummary.project.id, digest: described.digest, files: described.files.length };
        })()
        : null;
      const listed = actions.list();
      const baseCorpus = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'base' });
      const characterCorpus = corpusLib.read({ contentDir: root, characterId: provenance.DEFAULT_CHARACTER_ID, layer: 'character' });
      const corpusValidation = baseCorpus.ok
        ? corpusLib.validateCorpus({ base: baseCorpus.doc, character: characterCorpus.ok ? characterCorpus.doc : null })
        : { ok: false, findings: [{ severity: 'red', code: baseCorpus.code, detail: baseCorpus.message }] };
      const sceneReport = scene.report({ sceneId: 'flat' });
      return {
        ok: true,
        at: new Date().toISOString(),
        project,
        actions: { count: listed.actions.length, withDocs: listed.actions.filter((row) => row.hasDoc).length },
        corpus: { ok: corpusValidation.ok, findings: corpusValidation.findings.length, topics: corpusValidation.stats.base.topics.length },
        scene: { ok: sceneReport.ok, red: sceneReport.stats ? sceneReport.stats.red : null, yellow: sceneReport.stats ? sceneReport.stats.yellow : null },
      };
    },

    provenanceReport(assetId) {
      return passport.report(String(assetId));
    },

    provenanceVerify() {
      return passport.verify();
    },

    provenanceIndex({ out } = {}) {
      const target = out
        ? path.resolve(String(out))
        : path.join(repoRoot, 'studio', 'build', 'provenance-index.json');
      return passport.index({ out: target });
    },

    provenanceLost() {
      return passport.lost();
    },

    // The generation-params ledger (the breakpoint this port closes): tools that
    // generate art record their call parameters so segment 1 becomes provable.
    paramsLedger(actionId) {
      return provenance.readParamsLedger({
        repoRoot,
        characterId: provenance.DEFAULT_CHARACTER_ID,
        actionId: String(actionId),
      });
    },

    recordParams(input) {
      return passport.record(input || {});
    },
  };
}

module.exports = { STUDIO_VERSION, createStudioServices };
