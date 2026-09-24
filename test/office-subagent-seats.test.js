'use strict';

// Subagent SEATS — end-to-end through the REAL office module, driven by the
// SAME wiring main.js uses (`subagent-wiring.js` -> `ingestHarnessEvent`).
//
// This pins the whole closed loop that used to be broken in production:
//   real journal signal (catalog / workflow agent-start)  ->  classified seat
//   (researcher/coder/reviewer) or the collaborator FIFO  ->  work transition  ->
//   agent-end / settlement  ->  terminal result + release.
//
// Baseline contrast: BEFORE the wiring, only the root session's turn/start
// bound anyone (orchestrator); every subagent stayed roaming.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const { createSubagentWiring } = require('../src/office/runtime/subagent-wiring.js');
const { createRuntimeAdapter } = require('../src/office/runtime/runtime-adapter.js');
const { createEmployeeRegistry } = require('../src/office/runtime/employee-registry.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const PARENT = 'session-parent-seat';

function makeHarness() {
  const logLines = [];
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-subagent-seats-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: (line) => logLines.push(line),
  });
  // Exactly main.js's seam: translate -> (consumed ? nothing : generic ingest
  // that advances the adapter watermark) -> the live module.
  const wiring = createSubagentWiring({
    emit: (sessionId, value) => module.ingestHarnessEvent({
      sessionId, type: value.type, seq: value.seq ?? undefined, time: value.time, data: value.data,
    }),
    log: (line) => logLines.push(line),
  });
  function feed(event) {
    if (wiring.handleEvent(PARENT, event)) return true;
    module.ingestHarnessEvent({ sessionId: PARENT, type: event.type, seq: event.seq, time: event.time, data: event.data });
    return false;
  }
  return { module, wiring, feed, logLines };
}

function emp(module, id) {
  return module.state().employees.find((candidate) => candidate.employeeId === id);
}

function tickUntil(module, predicate, maxMs = 240000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    if (predicate(module.state())) return true;
  }
  return false;
}

/** Bind the root session to the orchestrator (turn/start -> agent/status). */
function startRoot(module) {
  assert.equal(module.ingestHarnessEvent({
    sessionId: PARENT, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' },
  }).status, 'accepted');
}

test('catalog with a coder label binds the coder seat and reaches work', () => {
  const { module, feed } = makeHarness();
  startRoot(module);
  assert.equal(feed({
    type: 'subagent/catalog', seq: 2, time: 2,
    data: { version: 0, childId: 'child-coder-1', childCreatedAt: 2, mode: 'one-shot', label: 'implement the parser' },
  }), true);

  const binding = module.debugRegistrySnapshot().bindings.find((b) => b.sessionId === 'child-coder-1');
  assert.ok(binding, 'the child is bound');
  assert.equal(binding.employeeId, 'coder');
  assert.equal(binding.releasedAt, null);

  assert.equal(tickUntil(module, (s) => {
    const coder = s.employees.find((e) => e.employeeId === 'coder');
    return coder && coder.transition && coder.transition.kind === 'task-start' && coder.transition.phase === 'work';
  }, 240000), true, 'the coder walks to the desk and reaches the work phase');
  const coder = emp(module, 'coder');
  assert.equal(coder.activity, 'working');
  assert.equal(coder.runtime, 'running');
});

test('unclassified catalog (no label) keeps the collaborator FIFO contract', () => {
  const { module, feed } = makeHarness();
  startRoot(module);
  feed({
    type: 'subagent/catalog', seq: 2, time: 2,
    data: { version: 0, childId: 'child-unknown-1', childCreatedAt: 2, mode: 'one-shot' },
  });
  const binding = module.debugRegistrySnapshot().bindings.find((b) => b.sessionId === 'child-unknown-1');
  assert.ok(binding);
  assert.equal(binding.employeeId, 'collaborator', 'no metadata -> the single collaborator seat');
});

test('three workflow agents land on three distinct seats, then end to completed', () => {
  const { module, feed } = makeHarness();
  startRoot(module);
  feed({ type: 'tool-workflow/run-start', seq: 2, time: 2, data: { runId: 'run-A', name: 'audit' } });
  const agents = [
    ['child-res', 1, 'research the venues'],
    ['child-cod', 2, 'implement the report'],
    ['child-rev', 3, 'review the report'],
  ];
  let seq = 3;
  for (const [child, member, label] of agents) {
    feed({ type: 'subagent/catalog', seq, time: seq, data: { childId: child, mode: 'one-shot' } });
    seq += 1;
    feed({
      type: 'tool-workflow/agent-start', seq, time: seq,
      data: { runId: 'run-A', seq: member, label, childId: child },
    });
    seq += 1;
  }
  const bindings = module.debugRegistrySnapshot().bindings.filter((b) => b.releasedAt === null);
  const seatById = Object.fromEntries(bindings.map((b) => [b.sessionId, b.employeeId]));
  assert.equal(seatById['child-res'], 'researcher');
  assert.equal(seatById['child-cod'], 'coder');
  assert.equal(seatById['child-rev'], 'reviewer');
  // orchestrator (root) and the three work seats are all occupied at once.
  assert.equal(new Set(bindings.map((b) => b.employeeId)).size, 4);

  // The first agent ends: its seat must present a completed result and release.
  for (const [child, member] of agents.map(([c, m]) => [c, m])) {
    feed({
      type: 'tool-workflow/agent-end', seq, time: seq,
      data: { runId: 'run-A', seq: member, outcome: 'completed' },
    });
    seq += 1;
  }
  assert.equal(tickUntil(module, (s) => {
    const res = s.employees.find((e) => e.employeeId === 'researcher');
    return res && res.lastResult && res.lastResult.outcome === 'completed';
  }, 240000), true, 'the researcher records a completed result');
  assert.equal(tickUntil(module, (s) => {
    const released = module.debugRegistrySnapshot().bindings.find((b) => b.sessionId === 'child-res');
    return released && released.releasedAt !== null;
  }, 240000), true, 'the researcher binding is released after the result presentation');
});

test('settlement notice closes a plain (non-workflow) subagent', () => {
  const { module, feed } = makeHarness();
  startRoot(module);
  feed({
    type: 'subagent/catalog', seq: 2, time: 2,
    data: { childId: 'child-plain-1', mode: 'one-shot', label: 'review the diff' },
  });
  assert.equal(module.debugRegistrySnapshot().bindings.find((b) => b.sessionId === 'child-plain-1').employeeId, 'reviewer');
  assert.equal(feed({
    type: 'user/message', seq: 3, time: 3,
    data: {
      content: [{ type: 'text', text: 'Background subagent child-plain-1 finished and will do no further work unless you send it more.' }],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-plain-1' },
    },
  }), true);
  assert.equal(tickUntil(module, (s) => {
    const r = s.employees.find((e) => e.employeeId === 'reviewer');
    return r && r.lastResult && r.lastResult.outcome === 'completed';
  }, 240000), true, 'the settlement notice produced a completed result');
});

test('baseline contrast: without the wiring a subagent catalog alone binds nobody', () => {
  // The PRE-FIX behavior: the raw catalog is ingested generically (adapter has
  // no case for it), so only the root orchestrator is bound.
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-subagent-baseline-seed',
    config: { resultPresentationMs: 300 },
  });
  module.ingestHarnessEvent({ sessionId: PARENT, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  module.ingestHarnessEvent({
    sessionId: PARENT, type: 'subagent/catalog', seq: 2, time: 2,
    data: { version: 0, childId: 'child-baseline', childCreatedAt: 2, mode: 'one-shot', label: 'implement it' },
  });
  const active = module.debugRegistrySnapshot().bindings.filter((b) => b.releasedAt === null);
  assert.deepEqual(active.map((b) => b.employeeId), ['orchestrator']);
});

// ---------------------------------------------------------------------------
// Adapter + registry contracts behind the seat wiring.
// ---------------------------------------------------------------------------

test('adapter: subagent/start carries role+mode, whitelisting the seat', () => {
  const out = [];
  const adapter = createRuntimeAdapter({
    sessionId: 'sess-adapter-seat',
    clock: { nowMs: () => 1700000000000 },
    onEvent: (o) => out.push(o),
  });
  adapter.ingest({ type: 'subagent/start', seq: 1, time: 1, data: { id: 'child-1', runId: 'run-1', role: 'coder', mode: 'one-shot' } });
  const fact = out[0].facts.find((f) => f.type === 'runtime/subagent-start');
  assert.equal(fact.role, 'coder');
  assert.equal(fact.mode, 'one-shot');

  // A non-whitelisted role (orchestrator/collaborator/garbage) is dropped.
  out.length = 0;
  adapter.ingest({ type: 'subagent/start', seq: 2, time: 2, data: { id: 'child-2', runId: 'run-2', role: 'orchestrator', mode: 'bogus' } });
  const fact2 = out[0].facts.find((f) => f.type === 'runtime/subagent-start');
  assert.equal(fact2.role, null, 'orchestrator is never a subagent seat');
  assert.equal(fact2.mode, null);
});

test('registry: registerClassifiedSubagent binds a work seat and rejects everything else', () => {
  const registry = createEmployeeRegistry({ clock: { nowMs: () => 100 } });
  registry.bindRootSession({ sessionId: 'root-1', nowMs: 1 });

  const ok = registry.registerClassifiedSubagent({ sessionId: 'child-ok', runId: 'run-x', employeeId: 'researcher', nowMs: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.binding.employeeId, 'researcher');

  for (const bad of ['orchestrator', 'collaborator', 'nope', null]) {
    const res = registry.registerClassifiedSubagent({ sessionId: `child-bad-${String(bad)}`, runId: 'r', employeeId: bad, nowMs: 3 });
    assert.equal(res.ok, false, `employeeId=${String(bad)}`);
    assert.equal(res.code, 'NOT_A_CLASSIFIED_SEAT');
  }

  // A busy seat queues FIFO instead of double-binding.
  const second = registry.registerClassifiedSubagent({ sessionId: 'child-busy', runId: 'run-y', employeeId: 'researcher', nowMs: 4 });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
  assert.equal(second.binding, null);
});

test('registry: unclassified subagents still go to the single collaborator FIFO', () => {
  const registry = createEmployeeRegistry({ clock: { nowMs: () => 100 } });
  registry.bindRootSession({ sessionId: 'root-2', nowMs: 1 });
  const res = registry.registerUnclassifiedSubagent({ sessionId: 'child-unclass', runId: 'run-z', nowMs: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.employeeId, 'collaborator');
  assert.equal(res.queued, true);
  assert.equal(registry.getCollaboratorQueueLength(), 1);
});
