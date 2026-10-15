'use strict';

// studio/lib/pipeline/orchestrate.js — the loop that turns stages into a pipeline:
// cache-aware execution + the QC feedback loop + the human triage list (brief §5).
//
//   1. every stage computes its cache key and is SKIPPED when the key hits
//      (改一步只重跑一步 — the acceptance asks for exactly this). The key covers
//      ONLY the parameters that stage consumes (`paramKeys`), so editing one
//      parameter re-runs the stages that read it and nothing upstream of them;
//   2. plan and run share ONE resolver (`stageKeyFor` + `resolvePlan`): the plan
//      printed before a run is the same walk the run performs, so they cannot
//      drift (the diff/apply discipline from bin/agent.js, applied to execution);
//   3. a cache hit RESTORES the chain (the cleaned/normalized frames come back
//      from the cache entry), so a second process re-running the same asset hits
//      every stage — not just the first one;
//   4. a stage that returns findings with a known fix gets ONE parameter
//      adjustment per retry, up to maxRetries (default 3 retries after the first
//      attempt);
//   5. when the retries are exhausted the item goes to the TRIAGE queue with the
//      evidence attached — never an infinite loop, never a silent pass.

const path = require('node:path');
const fs = require('node:fs');

const { createCache } = require('./cache.js');
const { STAGES, stageById } = require('./stages.js');
// the ledger's role vocabulary, so a record never spells a role differently from
// the ledger that validates it (orchestrate ← params, never the other way)
const paramsRoles = require('./params.js').ROLES;

// finding code → the parameter change to try next (the orchestrator's whole
// intelligence; everything else is measurement).
const FIX_TABLE = Object.freeze({
  'qc.residue-below-soles': { stage: 'S4', delta: { options: { nearBlackThreshold: 48, hardenAlphaMax: 128 } }, reason: 'widen the alpha hardening + near-black removal' },
  'qc.opaque-background': { stage: 'S4', delta: { options: { unpremultiply: true, harden: true, removeNearBlack: true } }, reason: 'run the full matting order' },
  'qc.height-drift': { stage: 'S6', delta: { targetHeight: null }, reason: 're-normalize against the action median' },
  'qc.foot-drift': { stage: 'S6', delta: { footLine: null }, reason: 're-align the sole line' },
  'qc.alpha-lost': { stage: 'S7', delta: {}, reason: 're-encode with alpha (format=yuva420p)' },
  'qc.duplicate-frame': { stage: 'S5', delta: {}, reason: 'a repeated frame cannot be fixed automatically — needs an author decision' },
  'qc.frame-gap': { stage: 'S5', delta: {}, reason: 'a missing frame must come from the source — triage' },
});

// The ctx fields that ARE parameters: seeding them means the cache key describes
// what actually executes (running with an explicit --params equal to the ctx
// default must hit the same entry as running without it).
const SEEDED_FROM_CTX = Object.freeze(['action', 'footLine', 'tolerancePx', 'packCanvas', 'packAnchor', 'fps', 'expectedSeries']);

function seedParams(ctx, params = {}) {
  const seeded = { ...(params || {}) };
  const set = (key, value) => {
    if (seeded[key] !== undefined || value === undefined || value === null) return;
    seeded[key] = value;
  };
  set('action', ctx.actionId);
  set('footLine', ctx.footLine);
  set('tolerancePx', ctx.tolerancePx);
  set('packCanvas', ctx.packCanvas);
  set('packAnchor', ctx.packAnchor);
  set('fps', ctx.fps);
  set('expectedSeries', ctx.expectedSeries);
  return seeded;
}

/** Only the parameters THIS stage reads enter its key (ComfyUI semantics). */
function pickParams(stage, params = {}) {
  const keys = stage.paramKeys || [];
  const picked = {};
  for (const key of keys) {
    if (params[key] !== undefined) picked[key] = params[key];
  }
  return picked;
}

function stageCacheName(stage) {
  return `${stage.id}-${stage.name}`;
}

function resolveInputs({ stage, ctx }) {
  // The cache key consumes the REAL bytes the stage reads, so a stage is reused
  // exactly when its inputs did not move.
  const inputs = {};
  if (stage.consumes.includes('reference') && ctx.referencePath) inputs.reference = ctx.referencePath;
  if (stage.consumes.includes('frames') && ctx.frames) inputs.frames = ctx.frames.map((frame) => (typeof frame === 'string' ? frame : frame.abs)).filter(Boolean).sort();
  if (stage.consumes.includes('cleaned-frames') && ctx.cleanedFrames) inputs.cleanedFrames = ctx.cleanedFrames.map((frame) => (typeof frame === 'string' ? frame : frame.abs)).filter(Boolean).sort();
  if (stage.consumes.includes('normalized-frames') && ctx.normalizedFrames) inputs.normalizedFrames = ctx.normalizedFrames;
  if (stage.consumes.includes('action-video') && ctx.video) inputs.video = ctx.video;
  if (stage.consumes.includes('qc-report') && ctx.qcReportPath && fs.existsSync(ctx.qcReportPath)) inputs.qcReport = ctx.qcReportPath;
  if (stage.consumes.includes('turnaround-image') && ctx.turnaround) inputs.turnaround = ctx.turnaround;
  if (stage.consumes.includes('direction-bases') && ctx.directionBases) inputs.directionBases = ctx.directionBases;
  return inputs;
}

/**
 * THE shared key computation. plan and run both call this, so "what the plan
 * said would run" and "what ran" cannot disagree. `force` turns every lookup
 * into a miss (re-run everything on purpose).
 */
function stageKeyFor({ stage, ctx, params = {}, cache, force = false }) {
  const inputs = resolveInputs({ stage, ctx });
  const picked = pickParams(stage, params);
  const { key, parts } = cache.keyFor({ stage: stageCacheName(stage), params: picked, inputs });
  const hit = force ? { hit: false, reason: 'forced' } : cache.get({ stage: stageCacheName(stage), key });
  return { key, parts, inputs, params: picked, hit };
}

/**
 * A cache hit must behave like the stage ran: the chain it produced comes back
 * from the entry (files live inside the cache dir), so downstream keys are
 * computed over the SAME bytes the original run produced.
 */
function applyCachedChain(stage, ctx, hit) {
  const chain = (hit.meta && hit.meta.chain) || {};
  if (stage.id === 'S4') {
    const frames = Array.isArray(chain.cleanedFrames) && chain.cleanedFrames.length
      ? chain.cleanedFrames
      : (hit.outputs || []).map((abs) => ({ file: path.basename(abs), abs }));
    if (frames.length) ctx.cleanedFrames = frames;
  }
  if (stage.id === 'S6') {
    const frames = Array.isArray(chain.normalizedFrames) && chain.normalizedFrames.length
      ? chain.normalizedFrames
      : (hit.outputs || []).map((abs) => ({ file: path.basename(abs), abs }));
    if (frames.length) ctx.normalizedFrames = frames;
  }
}

/** Rebuild a stage outcome from a cache entry (so the caller cannot tell them apart). */
function outcomeFromCache(stage, hit) {
  const metrics = (hit.meta && hit.meta.note) || {};
  const outcome = { ok: true, cached: true, metrics };
  if (stage.id === 'S5') outcome.verdict = metrics.verdict || null;
  if (stage.id === 'S4' || stage.id === 'S6') {
    outcome.frames = (stage.id === 'S4' ? ctxFrames(hit, 'cleanedFrames') : ctxFrames(hit, 'normalizedFrames'));
  }
  if (stage.id === 'S7') outcome.out = (hit.outputs || [])[0] || null;
  return outcome;
}

function ctxFrames(hit, which) {
  const chain = (hit.meta && hit.meta.chain) || {};
  if (Array.isArray(chain[which]) && chain[which].length) {
    return chain[which].map((frame) => ({ file: frame.file, out: frame.abs }));
  }
  return (hit.outputs || []).map((abs) => ({ file: path.basename(abs), out: abs }));
}

/**
 * The dry walk: which stages will run, which hit the cache, and WHY. Executes
 * nothing, writes nothing. A stage whose upstream will re-run is reported as
 * such (its output bytes are not known yet — ComfyUI says the same thing).
 */
function resolvePlan({ ctx, stageIds = ['S0', 'S4', 'S5', 'S6'], params = {}, cache = null, force = false }) {
  const store = cache || createCache({ repoRoot: ctx.repoRoot });
  const stageParams = seedParams(ctx, params);
  const stages = [];
  const dirtyOutputs = new Set();
  for (const id of stageIds) {
    const stage = stageById(id);
    if (!stage) {
      stages.push({ id, status: 'unknown-stage', reason: `no stage registered under ${id}` });
      continue;
    }
    const upstream = (stage.consumes || []).find((input) => dirtyOutputs.has(input));
    const probe = stageKeyFor({ stage, ctx, params: stageParams, cache: store, force });
    if (upstream) {
      stages.push({
        id: stage.id, name: stage.name, status: 'stale-upstream', key: null,
        reason: `upstream will re-run and its output (${upstream}) feeds this stage — the key cannot be known before that`,
        params: probe.params,
      });
      for (const produced of stage.produces || []) dirtyOutputs.add(produced);
      continue;
    }
    if (probe.hit.hit) {
      stages.push({
        id: stage.id, name: stage.name, status: 'hit', key: probe.key,
        reason: `inputs and parameters unchanged since ${(probe.hit.meta && probe.hit.meta.createdAt) || 'the recorded run'}`,
        params: probe.params, inputs: probe.parts, outputs: probe.hit.outputs,
      });
      applyCachedChain(stage, ctx, probe.hit);
      continue;
    }
    stages.push({
      id: stage.id, name: stage.name, status: force ? 'miss' : 'miss', key: probe.key,
      reason: force ? 'forced (--force): the cache is ignored on purpose' : 'no cache entry for these inputs and parameters',
      params: probe.params, inputs: probe.parts,
    });
    for (const produced of stage.produces || []) dirtyOutputs.add(produced);
  }
  return {
    ok: true,
    stages,
    params: stageParams,
    wouldRun: stages.filter((entry) => entry.status === 'miss' || entry.status === 'stale-upstream').map((entry) => entry.id),
    wouldReuse: stages.filter((entry) => entry.status === 'hit').map((entry) => entry.id),
    cache: store.stats(),
  };
}

function planPipeline(options) {
  return resolvePlan(options);
}

function inputForStage(stage, ctx, params = {}) {
  const pick = (key, fallback) => (params[key] !== undefined ? params[key] : fallback);
  if (stage.id === 'S0') return { referencePath: ctx.referencePath };
  if (stage.id === 'S1' || stage.id === 'S2' || stage.id === 'S3') return { ctx, params };
  if (stage.id === 'S4') return { frames: ctx.frames, outDir: ctx.cleanedDir, options: pick('options', ctx.mattingOptions || {}) };
  if (stage.id === 'S5') return { frames: ctx.cleanedFrames || ctx.frames, label: ctx.label || 'frames', footLine: pick('footLine', ctx.footLine ?? null), tolerancePx: pick('tolerancePx', ctx.tolerancePx ?? 1), expectedSeries: pick('expectedSeries', ctx.expectedSeries || null), video: ctx.video || null, expect: pick('expect', ctx.videoExpect || {}) };
  if (stage.id === 'S6') return { frames: ctx.cleanedFrames || ctx.frames, outDir: ctx.normalizedDir, footLine: pick('footLine', ctx.footLine ?? 296), packCanvas: pick('packCanvas', ctx.packCanvas ?? 352), packAnchor: pick('packAnchor', ctx.packAnchor || { x: 178, y: 296 }), targetHeight: pick('targetHeight', null) };
  if (stage.id === 'S7') return { frames: ctx.cleanedFrames || ctx.frames, outFile: ctx.webmOut || path.join(ctx.contentDir || '.', 'build', 'video', 'action.webm'), fps: pick('fps', ctx.fps || 24), crf: pick('crf', 40), size: pick('size', '640x360'), expectAlpha: pick('expectAlpha', true) };
  if (stage.id === 'S8') return { ctx, actionId: ctx.actionId };
  return { ctx, params };
}

/**
 * The fix to try for a set of findings. When the chain is known, a fix only
 * counts when its stage is part of it and sits at or before the failing stage —
 * "re-encode with alpha" is no fix when the encode is not in this run.
 */
function pickFix(findings, stageIds = null, index = Infinity) {
  for (const finding of findings) {
    const fix = FIX_TABLE[finding.code];
    if (!fix) continue;
    if (!stageIds) return fix;
    const fixIndex = stageIds.indexOf(fix.stage);
    if (fixIndex >= 0 && fixIndex <= index) return fix;
  }
  return null;
}

function summarizeOutcome(outcome) {
  if (!outcome) return null;
  const summary = {};
  if (outcome.verdict) summary.verdict = outcome.verdict;
  if (outcome.report) {
    if (outcome.report.frames) summary.frames = { verdict: outcome.report.frames.verdict, stats: outcome.report.frames.stats };
    if (outcome.report.video) summary.video = outcome.report.video.stats;
  }
  if (outcome.image) summary.image = outcome.image;
  if (outcome.frames && Array.isArray(outcome.frames)) summary.cleaned = outcome.frames.length;
  if (outcome.targetHeight) summary.targetHeight = outcome.targetHeight;
  if (outcome.probe) summary.probe = outcome.probe;
  return summary;
}

function collectOutputs(stage, outcome, ctx) {
  const outputs = {};
  const addDir = (label, dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isFile()) outputs[`${label}/${name}`] = abs;
    }
  };
  if (stage.id === 'S4') addDir('cleaned', ctx.cleanedDir);
  if (stage.id === 'S6') addDir('normalized', ctx.normalizedDir);
  if (stage.id === 'S7' && outcome.out && fs.existsSync(outcome.out)) outputs['video/action.webm'] = outcome.out;
  if (stage.id === 'S5' && ctx.qcReportPath) {
    const payload = JSON.stringify({ verdict: outcome.verdict, findings: outcome.findings, report: outcome.report }, null, 2);
    fs.mkdirSync(path.dirname(ctx.qcReportPath), { recursive: true });
    fs.writeFileSync(ctx.qcReportPath, `${payload}\n`);
    if (stage.consumes.includes('qc-report')) outputs['qc/report.json'] = ctx.qcReportPath;
  }
  return outputs;
}

function runPipeline({
  ctx,
  stageIds = ['S0', 'S4', 'S5', 'S6'],
  params = {},
  maxRetries = 3,
  cache = null,
  force = false,
  onStage = null,
  triage = null,
} = {}) {
  const store = cache || createCache({ repoRoot: ctx.repoRoot });
  const run = [];
  const triageEntries = [];
  const queued = [];
  let stageParams = seedParams(ctx, params);
  // executions per stage id — the retry budget is spent by the stage that FAILED,
  // counted across the rewinds a fix causes
  const executions = new Map();

  let index = 0;
  while (index < stageIds.length) {
    const id = stageIds[index];
    const stage = stageById(id);
    if (!stage) {
      run.push({ id, status: 'unknown-stage' });
      if (onStage) onStage(run[run.length - 1]);
      index += 1;
      continue;
    }

    let outcome = null;
    let key = null;
    let keyParts = null;
    let cachedHit = null;
    let rewoundTo = null;
    const started = Date.now();
    while (true) {
      // the cache is consulted for the CURRENT parameters every time, so a retry
      // that lands on parameters an earlier run already succeeded with reuses
      // that entry instead of recomputing it
      const probe = stageKeyFor({ stage, ctx, params: stageParams, cache: store, force });
      key = probe.key;
      keyParts = probe.parts;
      // Content-addressed staging: when the caller gives an `outRoot`, the stage
      // writes into `<outRoot>/<stage>-<key12>/`. A re-run with DIFFERENT
      // parameters therefore lands in a different directory, so a recorded output
      // hash stays verifiable against its own bytes — "same path, different
      // bytes" then means exactly one thing: someone edited the file.
      if (ctx.outRoot && (stage.id === 'S4' || stage.id === 'S6' || stage.id === 'S7')) {
        const dir = path.join(ctx.outRoot, `${stage.id}-${key.slice(0, 12)}`);
        if (stage.id === 'S4') ctx.cleanedDir = dir;
        if (stage.id === 'S6') ctx.normalizedDir = dir;
        if (stage.id === 'S7') ctx.webmOut = path.join(dir, 'action.webm');
      }
      if (probe.hit.hit) {
        cachedHit = probe.hit;
        outcome = outcomeFromCache(stage, probe.hit);
        break;
      }
      executions.set(stage.id, (executions.get(stage.id) || 0) + 1);
      outcome = stage.run({ ctx, params: stageParams, ...inputForStage(stage, ctx, stageParams) });
      if (outcome.ok) break;
      // A fixable finding gets ONE parameter change. The fix usually belongs to a
      // DIFFERENT stage than the one that detected it (the QC gate sees the
      // residue; the matting clears it), so the chain REWINDS to the fix's stage
      // and runs forward again — that is the automatic retry, and it is capped:
      // at most maxRetries retries per failing stage, then the item is queued.
      const fix = pickFix(outcome.findings || [], stageIds, index);
      const fixIndex = fix ? stageIds.indexOf(fix.stage) : -1;
      const spent = executions.get(stage.id) || 1;
      if (!fix || fixIndex < 0 || fixIndex > index || spent > maxRetries) break;
      stageParams = { ...stageParams, ...fix.delta };
      rewoundTo = fix.stage;
      index = fixIndex;
      break;
    }
    const attempt = executions.get(stage.id) || 0;
    const ms = Date.now() - started;
    if (rewoundTo !== null) {
      // the failed attempt bought a parameter change: the chain rewinds and runs
      // forward again — this record says so, it is not a failure yet
      const retry = {
        id: stage.id, name: stage.name, status: 'retrying', attempts: attempt, ms, key,
        code: outcome ? outcome.code || null : null,
        findings: (outcome && outcome.findings) || [],
        note: `fix applied; rewinding to ${rewoundTo}`,
      };
      run.push(retry);
      if (onStage) onStage(retry);
      continue;
    }
    const record = {
      id: stage.id,
      name: stage.name,
      status: outcome && outcome.ok ? (cachedHit ? 'cached' : 'ran') : 'failed',
      attempts: attempt,
      ms,
      key,
      inputs: keyParts,
      code: outcome ? outcome.code || null : null,
      message: outcome ? outcome.message || null : null,
      findings: (outcome && outcome.findings) || [],
      outputs: outcome && outcome.out ? [outcome.out] : undefined,
      metrics: summarizeOutcome(outcome),
    };
    if (outcome && outcome.ok) {
      if (cachedHit) {
        record.cachedOutputs = cachedHit.outputs;
        // THE CHAIN: a hit still restores what the stage produced, so downstream
        // keys are computed over the same bytes as the run that filled the cache
        applyCachedChain(stage, ctx, cachedHit);
      } else {
        // persist the stage outputs so a later run can reuse them
        const outputs = collectOutputs(stage, outcome, ctx);
        const chain = {};
        if (stage.id === 'S4' && Array.isArray(outcome.frames)) chain.cleanedFrames = outcome.frames.filter((frame) => frame.out).map((frame) => ({ file: frame.file, abs: frame.out }));
        if (stage.id === 'S6' && Array.isArray(outcome.frames)) chain.normalizedFrames = outcome.frames.filter((frame) => frame.out).map((frame) => ({ file: frame.file, abs: frame.out }));
        store.put({ stage: stageCacheName(stage), key, meta: { params: pickParams(stage, stageParams), note: record.metrics, chain }, outputs });
        record.stored = Object.keys(outputs);
        if (stage.id === 'S4' && Array.isArray(outcome.frames)) {
          ctx.cleanedFrames = outcome.frames.filter((frame) => frame.out).map((frame) => ({ file: frame.file, abs: frame.out }));
        }
        if (stage.id === 'S6' && Array.isArray(outcome.frames)) {
          ctx.normalizedFrames = outcome.frames.filter((frame) => frame.out).map((frame) => ({ file: frame.file, abs: frame.out }));
        }
      }
      if (stage.id === 'S5') ctx.qcVerdict = outcome.verdict;
      // a stage that passes closes its own open triage entries (recorded as auto)
      if (triage && typeof triage.autoResolve === 'function') {
        const closed = triage.autoResolve({ stage: stage.id });
        if (closed && closed.closed && closed.closed.length) record.autoResolved = closed.closed;
      }
    } else {
      const blocking = (record.findings || []).filter((finding) => finding.severity === 'red');
      const entry = {
        stage: stage.id,
        code: record.code,
        attempts: attempt,
        maxRetries,
        findings: blocking.length > 0 ? blocking : record.findings,
        needsHuman: blocking.some((finding) => !FIX_TABLE[finding.code] || Object.keys(FIX_TABLE[finding.code].delta).length === 0),
        reason: record.message || (blocking.length > 0 ? blocking : record.findings).map((finding) => finding.message).join(' / '),
        fix: (blocking.length > 0 ? blocking : record.findings).map((finding) => finding.fix).filter(Boolean).join(' / '),
      };
      triageEntries.push(entry);
      if (triage && typeof triage.open === 'function') {
        const opened = triage.open({
          stage: entry.stage,
          code: entry.code || entry.findings.map((finding) => finding.code)[0] || 'stage-failed',
          severity: 'red',
          findings: entry.findings,
          attempts: entry.attempts,
          maxRetries: entry.maxRetries,
          needsHuman: entry.needsHuman,
          reason: entry.reason,
          fix: entry.fix,
        });
        if (opened && opened.ok) queued.push(opened.entry.id);
      }
    }
    run.push(record);
    if (onStage) onStage(record);
    if (!outcome || !outcome.ok) {
      // downstream stages depend on this output: they are REPORTED as blocked
      // (nothing runs), and the chain stops here
      for (let rest = index + 1; rest < stageIds.length; rest += 1) {
        const downstream = stageById(stageIds[rest]);
        const blocked = { id: stageIds[rest], name: downstream ? downstream.name : null, status: 'blocked', blockedBy: stage.id };
        run.push(blocked);
        if (onStage) onStage(blocked);
      }
      break;
    }
    index += 1;
  }

  return {
    ok: triageEntries.length === 0,
    stages: run,
    triage: triageEntries,
    queued,
    cache: store.stats(),
    params: stageParams,
    ran: run.filter((entry) => entry.status === 'ran').map((entry) => entry.id),
    cachedStages: run.filter((entry) => entry.status === 'cached').map((entry) => entry.id),
  };
}

// ---------------------------------------------------------------------------
// the ledger view of ONE executed stage (shared by bin/pipeline.js and the
// studio service, so the CLI and the panel cannot record different calls)
// ---------------------------------------------------------------------------

/** Only the parameters THIS stage declares enter its record (its own cache key's params). */
function stageParamsFor(stageId, params = {}) {
  const stage = stageById(stageId);
  if (!stage) return {};
  return pickParams(stage, params);
}

/** The one-click reproduce command for one stage, exactly as the ledger stores it. */
function stageReproduceCommand(actionId, stageId, params) {
  return ['node', 'studio/bin/pipeline.js', 'run', actionId, '--only', stageId, '--params', JSON.stringify(params)].join(' ');
}

// The ledger's input/output entries: the stage's real input bytes and the files it
// wrote. Paths come from the ctx (the chain), hashes are computed by the ledger.
function inputPathsForRecord(stage, ctx) {
  const frames = stage.id === 'S4' ? ctx.frames : (ctx.cleanedFrames || ctx.frames);
  const list = (frames || []).map((frame) => ({ path: typeof frame === 'string' ? frame : frame.abs, role: stage.id === 'S4' ? paramsRoles.SOURCE_FRAMES : paramsRoles.CLEANED_FRAMES }));
  if (stage.id === 'S5' && ctx.qcReportPath && fs.existsSync(ctx.qcReportPath)) {
    // S5 consumes the frames; the report it WRITES is its output, not its input
    return list;
  }
  if (stage.id === 'S6' && ctx.qcReportPath && fs.existsSync(ctx.qcReportPath)) {
    return [...list, { path: ctx.qcReportPath, role: paramsRoles.QC_REPORT }];
  }
  return list;
}

function outputPathsForRecord(stage, ctx) {
  if (stage.id === 'S4') return (ctx.cleanedFrames || []).map((frame) => ({ path: frame.abs, role: paramsRoles.CLEANED_FRAMES }));
  if (stage.id === 'S5' && ctx.qcReportPath && fs.existsSync(ctx.qcReportPath)) return [{ path: ctx.qcReportPath, role: paramsRoles.QC_REPORT }];
  if (stage.id === 'S6') return (ctx.normalizedFrames || []).map((frame) => ({ path: frame.abs, role: paramsRoles.NORMALIZED_FRAMES }));
  if (stage.id === 'S7' && ctx.webmOut && fs.existsSync(ctx.webmOut)) return [{ path: ctx.webmOut, role: paramsRoles.VIDEO }];
  return [];
}

module.exports = {
  FIX_TABLE,
  SEEDED_FROM_CTX,
  applyCachedChain,
  collectOutputs,
  inputForStage,
  inputPathsForRecord,
  outputPathsForRecord,
  pickParams,
  planPipeline,
  resolveInputs,
  resolvePlan,
  runPipeline,
  seedParams,
  stageKeyFor,
  stageParamsFor,
  stageReproduceCommand,
  summarizeOutcome,
};
