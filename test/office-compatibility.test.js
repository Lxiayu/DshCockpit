'use strict';

// Task 1 / SPEC-01 compatibility gate.
// RED: these assertions fail (MODULE_NOT_FOUND / missing exports) until
// scripts/office-harness-probe.js and scripts/office-pixi-smoke.js exist.
// The probe must normalize { type, seq, time, data }, record terminal reasons,
// pair subagents, mark pause/resume/preempt unsupported, report the
// session.follow/page/control stream capabilities, and never leak raw
// payloads, Session IDs, paths, token counts or secrets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const probe = require(path.join(ROOT, 'scripts', 'office-harness-probe.js'));
const smoke = require(path.join(ROOT, 'scripts', 'office-pixi-smoke.js'));

function fixtureReport() {
  return probe.runFixtureReplay();
}

test('harness probe normalizes the SessionEvent shape to coarse evidence', () => {
  const normalized = probe.normalizeHarnessEvent({
    type: 'agent/status',
    seq: 3,
    time: 42,
    data: { status: 'running', internal: { prompt: 'FIXTURE-SECRET' } },
  });
  assert.deepEqual(normalized, {
    type: 'agent/status',
    seq: 3,
    time: 42,
    dataKeys: ['internal', 'status'],
  });
  assert.equal(probe.normalizeHarnessEvent({ type: 'agent/status', seq: 1 }), null);
  assert.equal(probe.normalizeHarnessEvent(null), null);
  assert.equal(probe.normalizeHarnessEvent({ type: 'x', seq: '1', time: 0, data: {} }), null);
});

test('probe observes agent/status idle and running in the fixture replay', () => {
  const report = fixtureReport();
  assert.equal(report.source, 'fixture');
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.events.some((e) => e.type === 'agent/status'));
  assert.ok(report.agentStatuses.includes('idle'), 'idle observed');
  assert.ok(report.agentStatuses.includes('running'), 'running observed');
});

test('probe records terminal turn/end reasons and never guesses unknown ones', () => {
  const report = fixtureReport();
  assert.ok(report.terminalReasons.includes('completed'));
  assert.ok(report.terminalReasons.includes('aborted'));
  assert.deepEqual(
    probe.collectTerminalReasons([
      { type: 'turn/end', seq: 1, time: 0, data: { reason: 'mystery-value' } },
    ]),
    ['unknown:mystery-value']
  );
});

test('probe pairs subagent start/end by runId and records stopReason values', () => {
  const report = fixtureReport();
  assert.ok(report.subagentStopReasons.includes('completed'));
  const pairing = probe.pairSubagents([
    { type: 'subagent/start', seq: 1, time: 0, data: { runId: 'r1' } },
    { type: 'subagent/end', seq: 2, time: 1, data: { runId: 'r1', stopReason: 'completed' } },
    { type: 'subagent/end', seq: 3, time: 2, data: { runId: 'rX', stopReason: 'error' } },
  ]);
  assert.equal(pairing.paired, 1);
  assert.equal(pairing.unmatchedEnds, 1);
  assert.equal(pairing.unmatchedStarts, 0);
  assert.deepEqual(pairing.stopReasons, ['completed', 'error']);
});

test('probe marks pause/resume/preempt unsupported with stable evidence codes', () => {
  const report = fixtureReport();
  for (const key of ['pause', 'resume', 'preempt']) {
    assert.equal(report.controls[key].available, false, `${key} must be unavailable`);
    assert.match(report.controls[key].evidence, /PROBE_CONTROL_UNSUPPORTED/);
  }
  assert.equal(report.controls.cancel.available, true);
  assert.ok(report.controls.cancel.evidence.length > 0);
});

test('probe reports session follow/page/control stream capabilities with an evidence source', () => {
  const report = fixtureReport();
  for (const key of ['follow', 'page', 'control']) {
    assert.equal(typeof report.sessionStreams[key], 'boolean', `${key} reported`);
  }
  assert.match(String(report.sessionStreams.evidence), /research|fixture|not-runtime-verified/i);
});

test('probe output is redacted: no fixture prompt, payload, session id, path or token counts', () => {
  const report = fixtureReport();
  const json = JSON.stringify(report);
  const forbidden = [
    'FIXTURE-PROMPT',
    'FIXTURE-TOOL-ARG',
    'FIXTURE-TOOL-OUTPUT',
    'FIXTURE-SUBAGENT-TEXT',
    'sess-FIXTURE-001',
    'sess-FIXTURE-002',
    'run-FIXTURE-1',
    '/Users/FIXTURE',
    '987654',
  ];
  for (const secret of forbidden) {
    assert.ok(!json.includes(secret), `probe output leaked: ${secret}`);
  }
  assert.equal(report.redaction.prompts, 0);
  assert.equal(report.redaction.secrets, 0);
});

test('probe sequence observation, monotonicity and gap detection', () => {
  const report = fixtureReport();
  assert.deepEqual(report.sequence, { observed: true, monotonic: true, gaps: [] });
  const analyzed = probe.classifySequence([{ seq: 1 }, { seq: 2 }, { seq: 5 }, { seq: 4 }]);
  assert.equal(analyzed.observed, true);
  assert.equal(analyzed.monotonic, false);
  assert.deepEqual(analyzed.gaps, [3]);
});

test('probe status maps to stable exit codes', () => {
  assert.equal(probe.statusExitCode('passed'), 0);
  assert.equal(probe.statusExitCode('mismatch'), 4);
  assert.equal(probe.statusExitCode('failed'), 3);
  assert.equal(probe.statusExitCode('nonsense'), 3);
});

test('unreachable runtime is reported honestly as failed with PROBE_RUNTIME_UNAVAILABLE', async () => {
  const report = await probe.probeRuntime({
    baseUrl: 'http://127.0.0.1:9',
    timeoutMs: 250,
    fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  assert.equal(report.probeStatus, 'failed');
  assert.match(JSON.stringify(report), /PROBE_RUNTIME_UNAVAILABLE/);
});

test('pixi smoke stays an offline local-only Electron entrypoint with teardown calls', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'office-pixi-smoke.js'), 'utf8');
  assert.doesNotMatch(src, /https?:\/\//, 'no CDN or network URL');
  assert.match(src, /new BrowserWindow\(/);
  assert.match(src, /new Application\(/, 'one Pixi Application');
  assert.match(src, /new Sprite\(/, 'one Sprite');
  assert.match(src, /office-probe:\/\//, 'local app-scheme resource loading');
  assert.match(src, /destroy\(/);
  assert.doesNotMatch(src, /nodeIntegration:\s*true/);
});

test('pixi smoke report contract and failure codes', () => {
  assert.deepEqual(
    [...smoke.SMOKE_SCHEMA_KEYS].sort(),
    [
      'destroyed',
      'electronVersion',
      'estimatedRgbaBytes',
      'loadMs',
      'networkRequests',
      'pixiVersion',
      'renderer',
      'schemaVersion',
      'textureHeight',
      'textureWidth',
    ]
  );
  const ok = smoke.buildSmokeReport({
    pixiVersion: '8.5.2',
    electronVersion: '37.10.3',
    renderer: 'webgl',
    textureWidth: 8,
    textureHeight: 8,
    estimatedRgbaBytes: 256,
    loadMs: 12,
    destroyed: { sprite: true, application: true },
    networkRequests: 0,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.networkRequests, 0);
  assert.equal(ok.report.schemaVersion, 1);

  const leak = smoke.buildSmokeReport({
    ...ok.report,
    destroyed: { sprite: false, application: true },
  });
  assert.equal(leak.ok, false);
  assert.equal(leak.code, 'PIXI_DESTROY_LEAK');

  const network = smoke.buildSmokeReport({
    ...ok.report,
    networkRequests: 1,
  });
  assert.equal(network.ok, false);
  assert.equal(network.code, 'PIXI_NETWORK_REQUEST');

  const init = smoke.buildSmokeReport({
    ...ok.report,
    renderer: null,
    textureWidth: null,
    textureHeight: null,
    estimatedRgbaBytes: null,
  });
  assert.equal(init.ok, false);
  assert.equal(init.code, 'PIXI_INIT_FAILED');
});
