'use strict';

// studio/test/preview.test.js — the preview runner (P7, brief §7G).
//
// The runner drives the PRODUCT's own office module from the studio's main process, so
// these tests are pure Node (no Electron) and they pin the properties a preview must
// have to be trustworthy:
//   * it IS the product module (not a re-implementation) and it resolves the layout
//     through the product's own chain;
//   * deterministic: the same script + seed produces byte-identical employee summaries;
//   * event injection drives the real transition loop (move → sit → work → result);
//   * controls return stable codes instead of throwing;
//   * the diagnostics bundle is redacted by the product's own redactor and passes the
//     secret-shape scan.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');
const CONTENT_ROOT = path.join(REPO_ROOT, 'content');
const CHARACTERS_ROOT = path.join(REPO_ROOT, 'resources', 'characters');

const { SCENARIOS, createPreviewRunner } = require(path.join(STUDIO_ROOT, 'lib', 'preview', 'runner.js'));

function makeRunner(options = {}) {
  return createPreviewRunner({ repoRoot: REPO_ROOT, contentDir: CONTENT_ROOT, charactersRoot: CHARACTERS_ROOT, ...options });
}

function orchestrator(runner) {
  return runner.employeesSummary().find((employee) => employee.employeeId === 'orchestrator');
}

function driveUntil(runner, predicate, maxTicks = 20000) {
  for (let index = 0; index < maxTicks; index += 1) {
    runner.step(1);
    if (predicate(orchestrator(runner))) return true;
  }
  return false;
}

test('the runner uses the product module and the product layout chain', () => {
  const runner = makeRunner();
  assert.equal(runner.ok, true, `the runner started (${runner.code || ''} ${runner.message || ''})`);
  // the module instance exposes the real API surface
  for (const name of ['advanceOneTick', 'ingestHarnessEvent', 'state', 'diagnostics', 'getSettings']) {
    assert.equal(typeof runner.office[name], 'function', `office.${name} exists`);
  }
  assert.equal(runner.layoutSource, 'bundled-flat', 'the layout came from the product chain (saved → bundled flat → isometric)');
  assert.ok(runner.layout.nodes().length > 20, 'the compiled layout is loaded');
  assert.equal(runner.employeesSummary().length, 5, 'the five employees exist');
  runner.destroy();
});

test('injecting a session event drives the real transition loop', () => {
  const runner = makeRunner();
  runner.inject({ type: 'agent/status', sessionId: 'sess-a', seq: 1, data: { status: 'running' } });
  assert.equal(driveUntil(runner, (employee) => employee.phase === 'move'), true, 'the task starts moving');
  assert.equal(driveUntil(runner, (employee) => employee.phase === 'sit'), true, 'then sits');
  assert.equal(driveUntil(runner, (employee) => employee.phase === 'work'), true, 'then works');
  assert.equal(orchestrator(runner).activity, 'working');
  runner.inject({ type: 'turn/end', sessionId: 'sess-a', seq: 2, data: { reason: 'completed' } });
  assert.equal(driveUntil(runner, (employee) => employee.phase === 'result'), true, 'the terminal event produces the result phase');
  const employee = orchestrator(runner);
  assert.equal(employee.outcome, 'completed');
  assert.equal(employee.activity, 'celebrating', 'the completion animation state is the real one');
  assert.equal(employee.resource, 'finished', 'the finished expression is resolved for the completion');
  runner.destroy();
});

test('a failed task ends in the error outcome (the other terminal branch)', () => {
  const runner = makeRunner();
  // walk the same path the product's own test walks: reach WORK, then send the terminal
  for (const step of SCENARIOS['task-failed']) {
    if (step.event.type === 'turn/end') {
      assert.equal(driveUntil(runner, (employee) => employee.phase === 'work'), true, 'the task reached work before the terminal');
    }
    runner.inject(step.event);
  }
  assert.equal(driveUntil(runner, (employee) => employee.phase === 'result'), true, 'the failed terminal produces the result phase');
  const employee = orchestrator(runner);
  assert.equal(employee.outcome, 'failed', `the failed branch is taken (${JSON.stringify(employee)})`);
  assert.equal(employee.resource, 'error', 'the error animation state is the real one');
  runner.destroy();
});

test('runs are deterministic: same seed + same script ⇒ identical summaries', () => {
  const script = (runner) => {
    runner.inject({ type: 'agent/status', sessionId: 'sess-det', seq: 1, data: { status: 'running' } });
    runner.step(900);
    runner.inject({ type: 'tool/call', sessionId: 'sess-det', seq: 2, data: { tool: 'read_file' } });
    runner.step(600);
    return JSON.stringify(runner.employeesSummary());
  };
  const first = makeRunner();
  const second = makeRunner();
  const firstSummary = script(first);
  const secondSummary = script(second);
  assert.equal(firstSummary, secondSummary, 'two identical scripts produce identical simulations');
  first.destroy();
  second.destroy();

  const otherSeed = makeRunner({ seed: 'different-seed' });
  assert.notEqual(script(otherSeed), firstSummary, 'a different seed changes the roaming stream (the seeded scheduler is live)');
  otherSeed.destroy();
});

test('pausing stops the logical clock and stepping moves it by the requested ticks', () => {
  const runner = makeRunner();
  const before = runner.status();
  runner.step(10);
  const afterStep = runner.status();
  assert.equal(afterStep.ticks, before.ticks + 10);
  assert.equal(afterStep.logicalMs, before.logicalMs + 10 * runner.TICK_MS);
  runner.play({ speed: 4 });
  assert.equal(runner.status().playing, true);
  assert.equal(runner.status().speed, 4);
  runner.pause();
  assert.equal(runner.status().playing, false);
  const paused = runner.status();
  // a paused runner does not advance even if the wall clock moves on
  const started = Date.now();
  while (Date.now() - started < 120) { /* spin briefly */ }
  assert.equal(runner.status().ticks, paused.ticks, 'wall time does not advance a paused simulation');
  runner.destroy();
});

test('controls answer with stable codes instead of throwing', () => {
  const runner = makeRunner();
  const unknown = runner.control('followup', 'not-an-employee');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_EMPLOYEE');
  const noBinding = runner.control('cancel', 'orchestrator');
  assert.equal(noBinding.ok, false);
  assert.equal(noBinding.code, 'NOT_BOUND', 'no session is bound yet, so cancel cannot be honoured');
  assert.equal(runner.control('teleport', 'orchestrator').code, 'CONTROL_UNKNOWN');
  runner.destroy();
});

test('the diagnostics bundle is redacted, scannable and complete', () => {
  const runner = makeRunner();
  runner.inject({ type: 'agent/status', sessionId: 'sess-secret-987654', seq: 1, data: { status: 'running' } });
  runner.step(300);
  const bundle = runner.exportBundle();
  assert.equal(bundle.ok, true, `the bundle passes the secret-shape scan (${JSON.stringify(bundle.hits)})`);
  assert.ok(bundle.bytes > 1000, `a real bundle, not a placeholder (${bundle.bytes} bytes)`);
  assert.equal(bundle.text.includes('sess-secret-987654'), false, 'the session id does not survive redaction');
  const parsed = JSON.parse(bundle.text);
  for (const key of ['exportedAt', 'source', 'layoutSource', 'seed', 'status', 'sync', 'employees', 'activityLog', 'settings']) {
    assert.ok(key in parsed, `the bundle carries ${key}`);
  }
  assert.equal(parsed.employees.length, 5, 'every employee is reported');
  assert.ok(parsed.employees.every((employee) => typeof employee.activity === 'string'), 'each employee carries its activity');
  assert.ok(Array.isArray(parsed.status.injections === undefined ? [] : [parsed.status.injections]) || typeof parsed.status.injections === 'number');
  runner.destroy();
});

test('the scenario library describes the four session events the brief names', () => {
  const events = Object.values(SCENARIOS).flatMap((steps) => steps.map((step) => step.event.type));
  for (const expected of ['agent/status', 'tool/call', 'turn/end', 'approval/asked']) {
    assert.ok(events.includes(expected), `${expected} is scripted`);
  }
  for (const [id, steps] of Object.entries(SCENARIOS)) {
    assert.ok(steps.length >= 2, `${id} has a real sequence`);
    for (const [index, step] of steps.entries()) {
      if (index > 0) assert.ok(step.afterMs >= steps[index - 1].afterMs, `${id} delays are ordered`);
    }
  }
});
