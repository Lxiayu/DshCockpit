'use strict';

// src/workbench/app/pipeline-model.js — the pipeline panel's PRESENTATION model.
//
// The panel (流水线, R5) is a window onto the generation loop engine that lives in
// the main process (studio/lib/pipeline/**). This module is the seam between the
// two, and it is deliberately PURE — no DOM, no IPC, no fs:
//
//   * it never recomputes anything the engine already answers. A plan arrives
//     from resolvePlan with each stage's status (hit / miss / stale-upstream),
//     its cache key and its WHY; a run arrives from runPipeline with the same
//     vocabulary plus ran/cached/failed/blocked/retrying. This module maps those
//     statuses onto labels and rows, and NOTHING else — the moment it starts
//     deciding cache hits on its own, the panel and the engine can disagree;
//   * the form parsing (--only, --params, the publish switch) lives here too, so
//     a test can pin what the panel sends without a renderer;
//   * every failure is a { ok: false, code } result, never a throw: the panel is
//     driven by real user input in text fields.
//
// Wiring is the caller's job: workbench.js calls the studio bridge, hands the
// answers here, and renders what comes back.

// The engine's own status vocabulary (orchestrate.js resolvePlan + runPipeline),
// mapped onto the dictionary keys the panel renders. A status nobody declared
// falls through to its own text — the panel shows the engine's word, not a guess.
const PLAN_STATUS_KEYS = Object.freeze({
  hit: 'pipeline.status.hit',
  miss: 'pipeline.status.miss',
  'stale-upstream': 'pipeline.status.staleUpstream',
  'unknown-stage': 'pipeline.status.unknownStage',
  blocked: 'pipeline.status.blocked',
});

const RUN_STATUS_KEYS = Object.freeze({
  ran: 'pipeline.status.ran',
  cached: 'pipeline.status.cached',
  failed: 'pipeline.status.failed',
  retrying: 'pipeline.status.retrying',
  blocked: 'pipeline.status.blocked',
  'unknown-stage': 'pipeline.status.unknownStage',
});

// The severity vocabulary the problems strip already speaks (app/problems.js).
const SEVERITY_CLASS = Object.freeze({ red: 'bad', yellow: 'warn', note: 'ok', green: 'ok' });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---- the stage table --------------------------------------------------------

/**
 * One row per registered stage, in registry order, carrying:
 *   · the dependency edges (which stages produce what this one consumes),
 *   · whether it is part of the chain the panel asked about,
 *   · its status from the LAST engine answer (plan or run) — or 'off-chain'.
 * `plan`/`run` are the raw engine payloads; they are read, never rewritten.
 */
function stageRows({ registry = [], plan = null, run = null, chainIds = [] } = {}) {
  const producers = new Map(); // produced input → stage id
  for (const stage of registry) {
    for (const produced of stage.produces || []) {
      if (!producers.has(produced)) producers.set(produced, stage.id);
    }
  }
  const planById = new Map((plan && plan.stages ? plan.stages : []).map((entry) => [entry.id, entry]));
  const runById = new Map((run && run.stages ? run.stages : []).map((entry) => [entry.id, entry]));
  const chain = new Set(chainIds || []);

  return registry.map((stage) => {
    const dependsOn = (stage.consumes || [])
      .map((input) => producers.get(input))
      .filter((id) => id && id !== stage.id);
    const planEntry = planById.get(stage.id) || null;
    const runEntry = runById.get(stage.id) || null;
    let status = 'off-chain';
    let reason = null;
    let key = null;
    let params = null;
    let outputs = null;
    let attempts = null;
    let ms = null;
    let findings = null;
    if (runEntry) {
      status = runEntry.status;
      reason = runEntry.message || null;
      key = runEntry.key || null;
      params = runEntry.inputs || null;
      attempts = runEntry.attempts ?? null;
      ms = runEntry.ms ?? null;
      findings = runEntry.findings || null;
      if (runEntry.status === 'blocked') reason = `blocked by ${runEntry.blockedBy}`;
    } else if (planEntry) {
      status = planEntry.status;
      reason = planEntry.reason || null;
      key = planEntry.key || null;
      params = planEntry.params || null;
      outputs = planEntry.outputs || null;
    }
    return {
      id: stage.id,
      name: stage.name,
      providerClass: stage.providerClass || null,
      consumes: (stage.consumes || []).slice(),
      produces: (stage.produces || []).slice(),
      paramKeys: (stage.paramKeys || []).slice(),
      dependsOn,
      inChain: chain.has(stage.id),
      status,
      reason,
      key,
      params,
      outputs,
      attempts,
      ms,
      findings,
      statusKey: (runEntry ? RUN_STATUS_KEYS : PLAN_STATUS_KEYS)[status] || null,
    };
  });
}

/** The cache view: what will run, what is reused, and the engine's own reason. */
function cacheRows(plan) {
  if (!plan || !Array.isArray(plan.stages)) return [];
  return plan.stages.map((entry) => ({
    id: entry.id,
    name: entry.name || entry.id,
    status: entry.status,
    statusKey: PLAN_STATUS_KEYS[entry.status] || null,
    reason: entry.reason || '',
    key: entry.key || null,
    params: isPlainObject(entry.params) ? entry.params : {},
    inputs: Array.isArray(entry.inputs) ? entry.inputs : [],
    outputs: Array.isArray(entry.outputs) ? entry.outputs : [],
  }));
}

/** The plan's own headline: how many will run, how many are reused, cache stats. */
function planSummary(plan, t) {
  if (!plan || !Array.isArray(plan.stages)) return null;
  const wouldRun = plan.wouldRun || [];
  const wouldReuse = plan.wouldReuse || [];
  const stats = plan.cache || {};
  return {
    wouldRun,
    wouldReuse,
    text: t('pipeline.planSummary', {
      run: wouldRun.length,
      reuse: wouldReuse.length,
      runIds: wouldRun.join(',') || '—',
      reuseIds: wouldReuse.join(',') || '—',
      entries: stats.entries ?? 0,
    }),
  };
}

// ---- the QC report ----------------------------------------------------------

/** The S5 record's verdict + findings, in the shape the panel renders. */
function qcReport(run) {
  const stage = run && Array.isArray(run.stages)
    ? run.stages.filter((entry) => entry.id === 'S5').pop()
    : null;
  if (!stage) return null;
  const verdict = (stage.metrics && stage.metrics.verdict) || null;
  const findings = (stage.findings || []).map((finding) => ({
    severity: finding.severity || 'note',
    code: finding.code || 'UNCODED',
    message: finding.message || '',
    fix: finding.fix || null,
    file: finding.file || null,
    severityKey: `pipeline.severity.${finding.severity || 'note'}`,
    severityClass: SEVERITY_CLASS[finding.severity] || 'ok',
  }));
  return {
    stage: 'S5',
    status: stage.status,
    verdict,
    verdictKey: verdict ? `pipeline.verdict.${verdict}` : null,
    verdictClass: SEVERITY_CLASS[verdict] || 'ok',
    red: findings.filter((finding) => finding.severity === 'red').length,
    yellow: findings.filter((finding) => finding.severity === 'yellow').length,
    findings,
    ms: stage.ms ?? null,
  };
}

/**
 * The QC findings as problems-strip entries: one source ('pipeline'), grouped by
 * code like every other validator's, each with a jump target that selects the
 * stage row it came from (the strip's existing click-to-jump contract).
 */
function findingsToProblems({ actionId, findings = [], stageId = 'S5' } = {}) {
  return findings.map((finding) => ({
    severity: finding.severity || 'note',
    code: finding.code || 'UNCODED',
    message: finding.file ? `${finding.file}: ${finding.message || ''}` : (finding.message || ''),
    target: { page: 'generation', tab: 'tab-pipeline', itemId: `stage:${stageId}` },
    // the panel's own rows read these; the strip keeps severity/code/message/target
    fix: finding.fix || null,
    actionId: actionId || null,
  }));
}

// ---- the form ---------------------------------------------------------------

/**
 * The --only form: a comma list of stage ids. Order is preserved, duplicates
 * collapse, ids are upper-cased; anything that is not S0–S8 is refused with the
 * engine's own vocabulary rather than silently dropped.
 */
function parseStageList(text) {
  const raw = typeof text === 'string' ? text : '';
  const ids = raw.split(',').map((token) => token.trim().toUpperCase()).filter(Boolean);
  const known = new Set(['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return { ok: false, code: 'PIPELINE_UNKNOWN_STAGE', unknown };
  const seen = new Set();
  const ordered = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return { ok: true, stages: ordered };
}

/** The --params form: a JSON OBJECT (the engine seeds the rest from the action). */
function parseParams(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { ok: true, params: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: 'PIPELINE_PARAMS_NOT_JSON', message: String((error && error.message) || error) };
  }
  if (!isPlainObject(parsed)) return { ok: false, code: 'PIPELINE_PARAMS_NOT_OBJECT' };
  return { ok: true, params: parsed };
}

/**
 * The chain the panel sends: the --only list when there is one, else the local
 * default (S4,S5,S6) with S8 appended only when the publish switch is on — the
 * same conservative default the workbench uses everywhere (writing resources/**
 * is a danger-zone action, never a default).
 */
function chainFromForm({ only = '', publish = false } = {}) {
  const parsed = parseStageList(only);
  if (!parsed.ok) return parsed;
  if (parsed.stages.length) return { ok: true, stages: parsed.stages };
  return { ok: true, stages: publish ? ['S4', 'S5', 'S6', 'S8'] : ['S4', 'S5', 'S6'] };
}

// ---- the run log (the dock's own status pattern, one line per record) -------

/** One log line per stage record, in the engine's own words. */
function runLogLines(records = []) {
  return records.map((record) => {
    const head = `${record.id} ${record.status}`;
    const spent = record.attempts ? ` attempts=${record.attempts}` : '';
    const time = typeof record.ms === 'number' ? ` ${record.ms}ms` : '';
    const verdict = record.metrics && record.metrics.verdict ? ` verdict=${record.metrics.verdict}` : '';
    // a retry record carries `note` (the fix it applied), a failure carries `message`
    const note = record.note || record.message || null;
    const tail = note ? ` — ${note}` : '';
    return `${head}${spent}${time}${verdict}${tail}`;
  });
}

// ---- the triage queue -------------------------------------------------------

/** The queue rows the panel lists: the four questions a human needs, in order. */
function triageRows(entries = []) {
  return entries.map((entry) => ({
    id: entry.id,
    actionId: entry.actionId || null,
    stage: entry.stage,
    code: entry.code,
    status: entry.status,
    statusKey: entry.status === 'open' ? 'pipeline.triage.open' : 'pipeline.triage.resolved',
    statusClass: entry.status === 'open' ? 'bad' : 'ok',
    severity: entry.severity || 'red',
    attempts: entry.attempts ?? 0,
    maxRetries: entry.maxRetries ?? 0,
    runs: entry.runs ?? 0,
    needsHuman: Boolean(entry.needsHuman),
    reason: entry.reason || '',
    fix: entry.fix || '',
    findings: Array.isArray(entry.findings) ? entry.findings : [],
    createdAt: entry.createdAt || null,
    resolvedAt: entry.resolvedAt || null,
    resolution: entry.resolution || null,
  }));
}

/** The resolve button's own guard — the engine enforces the same rule fail-closed. */
function noteRefusal(note) {
  return typeof note === 'string' && note.trim().length > 0
    ? null
    : { ok: false, code: 'PIPELINE_NOTE_REQUIRED' };
}

// ---- the passport jump ------------------------------------------------------

/**
 * What the 素材护照 button needs: the action id the panel is looking at. The
 * passport panel itself does the rest (provenance report + the params ledger) —
 * this only names the asset, so the two panels cannot describe different assets.
 */
function passportTarget(actionId) {
  const id = typeof actionId === 'string' ? actionId.trim() : '';
  return { ok: Boolean(id), actionId: id || null };
}

const pipelineModelApi = {
  PLAN_STATUS_KEYS,
  RUN_STATUS_KEYS,
  cacheRows,
  chainFromForm,
  findingsToProblems,
  noteRefusal,
  parseParams,
  parseStageList,
  passportTarget,
  planSummary,
  qcReport,
  runLogLines,
  stageRows,
  triageRows,
};
if (typeof window !== 'undefined') window.wbPipelineModel = pipelineModelApi;
if (typeof module !== 'undefined' && module.exports) module.exports = pipelineModelApi;
