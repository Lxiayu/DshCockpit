'use strict';

// src/workbench/test/pipeline-panel.test.js — the pipeline panel's model and its
// wiring (workbench rectification, R5: 把生成流水线 S0–S8 接进工作台).
//
// The panel is a window onto the engine that lives in the main process
// (studio/lib/pipeline/**). Two claims are pinned here:
//
//   1. THE MODEL NEVER RECOMPUTES THE ENGINE'S ANSWERS. stageRows/cacheRows/qcReport
//      map the engine's own statuses (hit / miss / stale-upstream / ran / cached /
//      failed / blocked / retrying) onto labels and rows, and a stale-upstream stage
//      stays keyless because the engine says it is. The moment the panel starts
//      deciding cache hits on its own, these tests fail.
//   2. THE PANEL IS KEYBOARD-REACHABLE BY CONSTRUCTION: every control is a native
//      button/input/select/textarea (no div[role=button], no positive tabindex), so
//      选资产 → plan → run → 看报告 → resolve 分诊 is a Tab/Enter walk. The wiring
//      assertions read the shipped HTML/JS the way the boundary suite does.
//
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const WORKBENCH = path.join(ROOT, 'src', 'workbench');
const model = require('../app/pipeline-model.js');

// A registry shaped like the engine's own (studio/lib/pipeline/stages.js).
const REGISTRY = [
  { id: 'S0', name: 'reference-check', providerClass: null, consumes: ['reference'], produces: ['reference-facts'], paramKeys: [] },
  { id: 'S4', name: 'matting-cleanup', providerClass: null, consumes: ['frames'], produces: ['cleaned-frames'], paramKeys: ['options'] },
  { id: 'S5', name: 'quality-gate', providerClass: null, consumes: ['cleaned-frames'], produces: ['qc-report'], paramKeys: ['footLine'] },
  { id: 'S6', name: 'normalize', providerClass: null, consumes: ['cleaned-frames', 'qc-report'], produces: ['normalized-frames'], paramKeys: ['packCanvas'] },
  { id: 'S8', name: 'publish', providerClass: null, consumes: ['normalized-frames', 'qc-report'], produces: ['pack-entry'], paramKeys: [] },
];

const COLD_PLAN = {
  ok: true,
  stages: [
    { id: 'S4', name: 'matting-cleanup', status: 'miss', key: 'a'.repeat(64), reason: 'no cache entry for these inputs and parameters', params: {}, inputs: ['stage:S4', 'in:frames'] },
    { id: 'S5', name: 'quality-gate', status: 'stale-upstream', key: null, reason: 'upstream will re-run and its output (cleaned-frames) feeds this stage — the key cannot be known before that', params: { footLine: 296 }, inputs: [] },
    { id: 'S6', name: 'normalize', status: 'stale-upstream', key: null, reason: 'upstream will re-run and its output (cleaned-frames) feeds this stage', params: { packCanvas: 352 }, inputs: [] },
  ],
  params: {},
  wouldRun: ['S4', 'S5', 'S6'],
  wouldReuse: [],
  cache: { entries: 0, totalBytes: 0 },
};

const RUN_OUTCOME = {
  ok: false,
  stages: [
    { id: 'S4', name: 'matting-cleanup', status: 'ran', attempts: 1, ms: 42, key: 'b'.repeat(64), findings: [] },
    { id: 'S5', name: 'quality-gate', status: 'failed', attempts: 4, ms: 90, key: 'c'.repeat(64), message: 'the gate stayed red', findings: [{ severity: 'red', code: 'qc.opaque-background', message: 'every decoded pixel is opaque', fix: 'run the full matting order' }] },
    { id: 'S6', name: 'normalize', status: 'blocked', blockedBy: 'S5' },
  ],
  triage: [{ stage: 'S5', code: 'qc.opaque-background' }],
  queued: ['walk-left-S5-qc.opaque-background-1'],
  ran: ['S4'],
  cachedStages: [],
};

// ---------------------------------------------------------------------------
// 1. the stage table maps the engine's statuses, and never invents one
// ---------------------------------------------------------------------------

test('the stage table renders the engine statuses and the dependency edges', () => {
  const rows = model.stageRows({ registry: REGISTRY, plan: COLD_PLAN, chainIds: ['S4', 'S5', 'S6'] });
  assert.deepEqual(rows.map((row) => row.id), ['S0', 'S4', 'S5', 'S6', 'S8']);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  // a stage outside the chain says so instead of pretending a status
  assert.equal(byId.S0.status, 'off-chain');
  assert.equal(byId.S0.inChain, false);
  assert.equal(byId.S0.statusKey, null);
  // the plan's own statuses, verbatim
  assert.equal(byId.S4.status, 'miss');
  assert.equal(byId.S4.statusKey, 'pipeline.status.miss');
  assert.equal(byId.S5.status, 'stale-upstream');
  assert.equal(byId.S5.statusKey, 'pipeline.status.staleUpstream');
  // dependencies come from the registry's consumes/produces, not from a hardcoded list
  assert.deepEqual(byId.S5.dependsOn, ['S4']);
  // S6 reads the cleaned frames AND the QC report, so it waits on both producers
  assert.deepEqual(byId.S6.dependsOn, ['S4', 'S5']);
  // S8 packs the normalized frames and re-reads the QC report (the publish gate)
  assert.deepEqual(byId.S8.dependsOn, ['S6', 'S5']);
  assert.deepEqual(byId.S4.dependsOn, []);
});

test('a run answer replaces the plan statuses, and a blocked stage names its blocker', () => {
  const rows = model.stageRows({ registry: REGISTRY, plan: COLD_PLAN, run: RUN_OUTCOME, chainIds: ['S4', 'S5', 'S6'] });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.S4.status, 'ran');
  assert.equal(byId.S4.statusKey, 'pipeline.status.ran');
  assert.equal(byId.S4.attempts, 1);
  assert.equal(byId.S4.ms, 42);
  assert.equal(byId.S5.status, 'failed');
  assert.equal(byId.S5.statusKey, 'pipeline.status.failed');
  assert.equal(byId.S5.attempts, 4, 'the row says how much retry budget was spent');
  assert.equal(byId.S6.status, 'blocked');
  assert.equal(byId.S6.reason, 'blocked by S5');
});

// ---------------------------------------------------------------------------
// 2. the cache view passes the engine's dry walk through
// ---------------------------------------------------------------------------

test('the cache rows carry the engine reason, key and key params — recomputed nowhere', () => {
  const rows = model.cacheRows(COLD_PLAN);
  assert.deepEqual(rows.map((row) => row.id), ['S4', 'S5', 'S6']);
  assert.equal(rows[0].status, 'miss');
  assert.equal(rows[0].reason, COLD_PLAN.stages[0].reason);
  assert.equal(rows[0].key, 'a'.repeat(64));
  assert.deepEqual(rows[1].params, { footLine: 296 });
  assert.equal(rows[1].key, null, 'a stale-upstream stage has no key — the engine says so');
  assert.equal(rows[2].inputs.length, 0);
  assert.deepEqual(model.cacheRows(null), [], 'no plan yet is an empty view, not a crash');
});

test('the plan headline counts what will run and what is reused', () => {
  const summary = model.planSummary(COLD_PLAN, (key, params) => `${key}:${params.run}+${params.reuse}`);
  assert.deepEqual(summary.wouldRun, ['S4', 'S5', 'S6']);
  assert.deepEqual(summary.wouldReuse, []);
  assert.equal(summary.text, 'pipeline.planSummary:3+0');
  assert.equal(model.planSummary(null, () => 'x'), null);
});

// ---------------------------------------------------------------------------
// 3. the QC report
// ---------------------------------------------------------------------------

test('the QC report reads the S5 record: verdict, counts, fixes and strip severities', () => {
  const report = model.qcReport(RUN_OUTCOME);
  assert.equal(report.verdict, null, 'a failed gate with no verdict says so');
  assert.equal(report.red, 1);
  assert.equal(report.findings[0].code, 'qc.opaque-background');
  assert.equal(report.findings[0].fix, 'run the full matting order');
  assert.equal(report.findings[0].severityClass, 'bad');

  const green = model.qcReport({ stages: [{ id: 'S5', status: 'ran', ms: 12, metrics: { verdict: 'green' }, findings: [] }] });
  assert.equal(green.verdict, 'green');
  assert.equal(green.verdictKey, 'pipeline.verdict.green');
  assert.equal(green.verdictClass, 'ok');
  assert.equal(green.findings.length, 0);
  assert.equal(model.qcReport({ stages: [{ id: 'S4', status: 'ran' }] }), null, 'no S5 record, no report');
});

test('the QC findings become problems-strip entries that jump back to the stage', () => {
  const entries = model.findingsToProblems({
    actionId: 'walk-left',
    stageId: 'S5',
    findings: [{ severity: 'red', code: 'qc.opaque-background', message: 'opaque', fix: 'matte it', file: 'walk-left-b03.png' }],
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].severity, 'red');
  assert.equal(entries[0].code, 'qc.opaque-background');
  assert.match(entries[0].message, /^walk-left-b03\.png: /, 'the finding names the file it is about');
  assert.deepEqual(entries[0].target, { page: 'generation', tab: 'tab-pipeline', itemId: 'stage:S5' });
  assert.equal(entries[0].fix, 'matte it');
});

// ---------------------------------------------------------------------------
// 4. the form
// ---------------------------------------------------------------------------

test('the --only form parses, dedupes and refuses an unknown stage', () => {
  assert.deepEqual(model.parseStageList('s4, S5 ,s4'), { ok: true, stages: ['S4', 'S5'] });
  assert.deepEqual(model.parseStageList(''), { ok: true, stages: [] });
  const bad = model.parseStageList('S4,S9');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PIPELINE_UNKNOWN_STAGE');
  assert.deepEqual(bad.unknown, ['S9']);
});

test('the --params form takes a JSON object and refuses everything else', () => {
  assert.deepEqual(model.parseParams(''), { ok: true, params: {} });
  assert.deepEqual(model.parseParams('{"packCanvas":384}'), { ok: true, params: { packCanvas: 384 } });
  assert.equal(model.parseParams('{oops').code, 'PIPELINE_PARAMS_NOT_JSON');
  assert.equal(model.parseParams('[1,2]').code, 'PIPELINE_PARAMS_NOT_OBJECT');
  assert.equal(model.parseParams('"text"').code, 'PIPELINE_PARAMS_NOT_OBJECT');
});

test('the chain: an explicit --only wins; the default is local, with S8 only on request', () => {
  assert.deepEqual(model.chainFromForm({ only: 'S4,S5', publish: true }).stages, ['S4', 'S5'], 'an explicit chain never gains S8 by itself');
  assert.deepEqual(model.chainFromForm({}).stages, ['S4', 'S5', 'S6']);
  assert.deepEqual(model.chainFromForm({ publish: true }).stages, ['S4', 'S5', 'S6', 'S8'], 'writing resources/** is opt-in');
  assert.equal(model.chainFromForm({ only: 'SX' }).ok, false, 'a bad form never reaches the engine');
});

// ---------------------------------------------------------------------------
// 5. the run log and the triage queue
// ---------------------------------------------------------------------------

test('the run log is one line per engine record, in the engine own words', () => {
  const lines = model.runLogLines(RUN_OUTCOME.stages);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^S4 ran attempts=1 42ms$/);
  assert.match(lines[1], /^S5 failed attempts=4 90ms — the gate stayed red$/);
  assert.match(lines[2], /^S6 blocked$/);
});

test('the triage rows answer the four questions, and the note guard matches the engine', () => {
  const rows = model.triageRows([{
    id: 'walk-left-S5-qc.frame-gap-1', actionId: 'walk-left', stage: 'S5', code: 'qc.frame-gap',
    status: 'open', severity: 'red', attempts: 4, maxRetries: 3, runs: 2, needsHuman: true,
    reason: 'the series has a hole: number(s) 3 missing', fix: 'restore the missing frame',
    findings: [{ severity: 'red', code: 'qc.frame-gap', message: 'hole' }], createdAt: '2026-10-15T00:00:00.000Z',
  }]);
  assert.equal(rows[0].attempts, 4);
  assert.equal(rows[0].maxRetries, 3);
  assert.equal(rows[0].needsHuman, true);
  assert.equal(rows[0].statusKey, 'pipeline.triage.open');
  assert.equal(rows[0].statusClass, 'bad');
  assert.match(rows[0].reason, /hole/);
  assert.match(rows[0].fix, /restore/);

  assert.equal(model.noteRefusal('re-issued c03'), null, 'a real note passes');
  assert.equal(model.noteRefusal('').code, 'PIPELINE_NOTE_REQUIRED');
  assert.equal(model.noteRefusal('   ').code, 'PIPELINE_NOTE_REQUIRED', 'whitespace is not a note');
  assert.equal(model.noteRefusal(undefined).code, 'PIPELINE_NOTE_REQUIRED');
});

test('the passport jump only names the asset the panel is looking at', () => {
  assert.deepEqual(model.passportTarget('walk-left'), { ok: true, actionId: 'walk-left' });
  assert.deepEqual(model.passportTarget('  '), { ok: false, actionId: null });
});

// ---------------------------------------------------------------------------
// 6. the shipped wiring: the panel exists, is keyboard-reachable, and is driven
//    by the engine through the studio bridge (never a second implementation)
// ---------------------------------------------------------------------------

const HTML = fs.readFileSync(path.join(WORKBENCH, 'workbench.html'), 'utf8');
const JS = fs.readFileSync(path.join(WORKBENCH, 'workbench.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(WORKBENCH, 'workbench-preload.js'), 'utf8');
const panelHtml = HTML.slice(HTML.indexOf('id="page-view-generation"'), HTML.indexOf('id="page-view-quality"'));

test('the generation page and its pipeline chip exist and are bound to each other', () => {
  assert.match(HTML, /id="page-generation" class="wb-page-btn" data-page="generation"/, 'the activity bar has the generation task');
  assert.match(HTML, /id="page-view-generation" class="wb-page" data-page-view="generation"/, 'the page container exists');
  assert.match(HTML, /id="tab-pipeline" class="wb-tab" data-page="generation"/, 'the chip is bound to the page');
  assert.match(HTML, /id="panel-pipeline" class="wb-panel"/, 'the panel exists');
  assert.match(HTML, /class="wb-rail-tab" data-tab="tab-pipeline"/, 'the rail can switch to it while collapsed');
  // the shell knows the page and the chip (four sources of truth stay one table)
  assert.match(JS, /\['tab-pipeline', 'panel-pipeline', 'pipeline', 'generation'\]/, 'the tabs table carries the chip');
  assert.match(JS, /PAGES = \[[^\]]*'generation'/, 'PAGES knows the page');
});

test('every pipeline control is a native focusable element (keyboard-reachable)', () => {
  // the ids a keyboard user walks: 选资产 → plan → run → 看报告 → resolve 分诊
  const NATIVE = /^<(button|input|select|textarea)\b/;
  const PANEL_CONTROLS = [
    'pipeline-action', 'pipeline-only', 'pipeline-params', 'pipeline-reference', 'pipeline-delivery',
    'pipeline-force', 'pipeline-publish', 'pipeline-record', 'btn-pipeline-plan', 'btn-pipeline-run',
    'btn-pipeline-triage-refresh', 'btn-pipeline-passport', 'pipeline-triage-note',
    'btn-pipeline-triage-resolve',
  ];
  for (const id of PANEL_CONTROLS) {
    const match = new RegExp(`<(button|input|select|textarea)\\b[^>]*id="${id}"`).exec(panelHtml);
    assert.ok(match, `${id} is a native control (matched ${match && match[1]})`);
    assert.ok(NATIVE.test(`<${match[1]}`), `${id} is focusable without a tabindex hack`);
    assert.ok(!/tabindex="[1-9]/.test(match[0]), `${id} carries no positive tabindex`);
  }
  // no click-only divs: everything a mouse can click, a keyboard can reach
  assert.ok(!/role="button"/.test(panelHtml), 'no div[role=button] stand-ins in the panel');
  // the rendered rows are buttons too (stage rows selectable from the cache view and
  // the QC findings, triage rows selectable in the queue)
  assert.match(JS, /button\.className = `pipeline-cache-row/, 'cache rows are buttons');
  assert.match(JS, /button\.className = `pipeline-finding/, 'QC finding rows are buttons');
  assert.match(JS, /button\.className = `pipeline-triage-row/, 'triage rows are buttons');
  // the command palette carries the two front doors, so ⌘K → Enter runs them
  assert.match(JS, /id: 'pipeline:plan'/, 'the palette can plan');
  assert.match(JS, /id: 'pipeline:run'/, 'the palette can run');
});

test('the panel is wired to the engine services, and re-implements none of them', () => {
  for (const call of ['pipelineStages()', 'pipelinePlan(', 'pipelineRun(', 'pipelineTriageList(', 'pipelineTriageResolve(', 'onPipelineProgress(']) {
    assert.ok(JS.includes(call), `the renderer calls ${call}`);
  }
  for (const channel of ['studio:pipeline-stages', 'studio:pipeline-plan', 'studio:pipeline-run', 'studio:pipeline-triage-list', 'studio:pipeline-triage-resolve', 'studio:pipeline-progress']) {
    assert.ok(JS.includes(channel) || PRELOAD.includes(channel), `the bridge carries ${channel}`);
  }
  // the panel's model is the pure module, loaded as a classic script before the renderer
  assert.match(HTML, /<script src="\.\/app\/pipeline-model\.js"><\/script>/, 'the model module is loaded');
  assert.match(JS, /window\.wbPipelineModel/, 'the renderer uses the model module');
  // and the model never decides a cache hit: no status is invented in the panel
  for (const invented of ['cacheHit', 'isCached', 'wouldHit']) {
    assert.ok(!JS.includes(invented), `the renderer never computes ${invented} itself`);
  }
});

test('the QC findings land in the problems strip and jump back to the stage row', () => {
  assert.match(JS, /\.problems\?\.set\('pipeline'/, 'the findings feed the bottom strip under their own source');
  assert.match(JS, /\.problems\?\.clear\('pipeline'\)/, 'switching the asset drops the stale source');
  assert.match(JS, /itemId\.startsWith\('stage:'\)/, 'the strip jump target selects a stage row');
});

test('the run log and status line follow the dock pattern, not a new widget', () => {
  // the log is the same wb-pre block the other panels use, and the status line goes
  // through the shell's own setStatus (the dock toolbar's pattern)
  assert.match(HTML, /<pre id="pipeline-log" class="wb-pre"/, 'the log is the house pre block');
  assert.match(JS, /const pipelineSay = \(text\) => \{ pipelineStatus\.textContent = text \|\| ''; setStatus\(text \|\| ''\); \}/, 'the panel status line is the shell status line');
  assert.match(JS, /panelRefresh\.set\('tab-pipeline'/, 'a hot reload refreshes the panel like every other');
});
