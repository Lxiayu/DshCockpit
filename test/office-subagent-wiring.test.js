'use strict';

// Subagent wiring — real durable journal -> office module vocabulary.
//
// Pins the translation that was the production gap: `subagent/catalog` and
// `tool-workflow/agent-start|end` (the REAL durable signals) must become the
// adapter's `subagent/start` / `subagent/end` events, each emitted with the
// journal event's own seq so the adapter watermark stays contiguous.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSubagentWiring, settlementStopReason } = require('../src/office/runtime/subagent-wiring.js');

function harness(options = {}) {
  const emitted = [];
  const logs = [];
  const wiring = createSubagentWiring({
    emit: (sessionId, value) => emitted.push({ sessionId, ...value }),
    log: (line) => logs.push(line),
    ...options,
  });
  return { wiring, emitted, logs };
}

const PARENT = 'session-parent';
const CHILD = 'session-child-1';

test('catalog with a label seats the child directly on the classified seat', () => {
  const { wiring, emitted } = harness();
  const consumed = wiring.handleEvent(PARENT, {
    type: 'subagent/catalog', seq: 20, time: 1,
    data: { version: 0, childId: CHILD, childCreatedAt: 1, mode: 'one-shot', label: 'implement the parser' },
  });
  assert.equal(consumed, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'subagent/start');
  assert.equal(emitted[0].seq, 20);
  assert.equal(emitted[0].data.id, CHILD);
  assert.equal(emitted[0].data.runId, CHILD, 'catalog carries no runId: childId is the fallback');
  assert.equal(emitted[0].data.role, 'coder');
  assert.equal(emitted[0].data.mode, 'one-shot');
});

test('catalog without a label (plain collaborator) still seats as unclassified', () => {
  const { wiring, emitted } = harness();
  wiring.handleEvent(PARENT, {
    type: 'subagent/catalog', seq: 21, time: 1,
    data: { version: 0, childId: CHILD, childCreatedAt: 1, mode: 'one-shot' },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data.role, null, 'no metadata -> collaborator (null role)');
});

test('duplicate catalog is not re-emitted (dedupe) and falls through to the caller', () => {
  const { wiring, emitted } = harness();
  const ev = { type: 'subagent/catalog', seq: 20, time: 1, data: { childId: CHILD, mode: 'one-shot' } };
  assert.equal(wiring.handleEvent(PARENT, ev), true);
  assert.equal(wiring.handleEvent(PARENT, ev), false, 'second emission skipped -> caller ingests');
  assert.equal(emitted.length, 1);
});

test('workflow child: label-less catalog is deferred until agent-start, then seated by label', () => {
  const { wiring, emitted, logs } = harness();
  // run-start marks the session workflow-active
  assert.equal(wiring.handleEvent(PARENT, { type: 'tool-workflow/run-start', seq: 10, time: 1, data: { runId: 'run-1', name: 'audit' } }), false);
  // catalog carries no label -> deferred (no office event yet)
  assert.equal(wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 11, time: 2, data: { childId: CHILD, mode: 'one-shot' } }), false);
  assert.equal(emitted.length, 0);
  assert.ok(logs.some((l) => l.includes('catalog deferred')));
  // agent-start carries the label + member seq
  const consumed = wiring.handleEvent(PARENT, {
    type: 'tool-workflow/agent-start', seq: 12, time: 3,
    data: { runId: 'run-1', seq: 1, label: 'research the venues', childId: CHILD },
  });
  assert.equal(consumed, true);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'subagent/start');
  assert.equal(emitted[0].seq, 12);
  assert.equal(emitted[0].data.role, 'researcher');
  // agent-end pairs through (runId, member seq) and closes the child
  const ended = wiring.handleEvent(PARENT, {
    type: 'tool-workflow/agent-end', seq: 13, time: 4, data: { runId: 'run-1', seq: 1, outcome: 'completed' },
  });
  assert.equal(ended, true);
  assert.equal(emitted[1].type, 'subagent/end');
  assert.equal(emitted[1].seq, 13);
  assert.equal(emitted[1].data.id, CHILD);
  assert.equal(emitted[1].data.stopReason, 'completed');
});

test('workflow child gets its own seat (three labeled agents -> three distinct seats)', () => {
  const { wiring, emitted } = harness();
  wiring.handleEvent(PARENT, { type: 'tool-workflow/run-start', seq: 1, time: 1, data: { runId: 'r', name: 'w' } });
  const agents = [
    ['c1', 1, 'research the topic'],
    ['c2', 2, 'implement the function'],
    ['c3', 3, 'review the result'],
  ];
  let seq = 2;
  for (const [child, member, label] of agents) {
    wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq, time: seq, data: { childId: child, mode: 'one-shot' } });
    seq += 1;
    wiring.handleEvent(PARENT, { type: 'tool-workflow/agent-start', seq, time: seq, data: { runId: 'r', seq: member, label, childId: child } });
    seq += 1;
  }
  const starts = emitted.filter((e) => e.type === 'subagent/start');
  assert.deepEqual(starts.map((s) => s.data.role), ['researcher', 'coder', 'reviewer']);
  assert.deepEqual([...new Set(starts.map((s) => s.data.id))].length, 3);
});

test('deferred catalog with no claiming agent-start is flushed as unclassified at run-end', () => {
  const { wiring, emitted, logs } = harness();
  wiring.handleEvent(PARENT, { type: 'tool-workflow/run-start', seq: 1, time: 1, data: { runId: 'r', name: 'w' } });
  wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 2, time: 2, data: { childId: 'orphan', mode: 'one-shot' } });
  assert.equal(emitted.length, 0);
  assert.equal(wiring.handleEvent(PARENT, { type: 'tool-workflow/run-end', seq: 3, time: 3, data: { runId: 'r', stopReason: 'completed' } }), false);
  const starts = emitted.filter((e) => e.type === 'subagent/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].data.id, 'orphan');
  assert.equal(starts[0].data.role, null, 'flushed as unclassified (no label)');
  assert.equal(starts[0].seq, null, 'late flush uses an adapter-assigned sequence, not a stale journal seq');
  assert.ok(logs.some((l) => l.includes('flushed')));
});

test('settlement user/message closes a child that has a start (universal fallback)', () => {
  const { wiring, emitted } = harness();
  wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 5, time: 1, data: { childId: CHILD, mode: 'one-shot', label: 'code it' } });
  const consumed = wiring.handleEvent(PARENT, {
    type: 'user/message', seq: 9, time: 2,
    data: {
      content: [{ type: 'text', text: 'Background subagent x finished and will do no further work unless you send it more.' }],
      source: { kind: 'subagent-settled', form: 'notice', senderSessionId: CHILD },
    },
  });
  assert.equal(consumed, true);
  assert.equal(emitted[1].type, 'subagent/end');
  assert.equal(emitted[1].data.stopReason, 'completed');
});

test('settlement for an already-closed child does not double-emit', () => {
  const { wiring, emitted } = harness();
  wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 5, time: 1, data: { childId: CHILD, mode: 'one-shot' } });
  const start = { type: 'tool-workflow/agent-start', seq: 6, time: 1, data: { runId: 'r', seq: 1, label: 'x', childId: CHILD } };
  wiring.handleEvent(PARENT, start);
  wiring.handleEvent(PARENT, { type: 'tool-workflow/agent-end', seq: 7, time: 2, data: { runId: 'r', seq: 1, outcome: 'completed' } });
  const before = emitted.length;
  assert.equal(wiring.handleEvent(PARENT, {
    type: 'user/message', seq: 8, time: 3,
    data: { content: [], source: { kind: 'subagent-settled', senderSessionId: CHILD } },
  }), false);
  assert.equal(emitted.length, before);
});

test('unrelated events are never consumed (caller keeps the generic ingest)', () => {
  const { wiring, emitted } = harness();
  for (const type of ['turn/start', 'turn/end', 'tool/call', 'assistant/message', 'user/message', 'tool-workflow/run-start']) {
    assert.equal(wiring.handleEvent(PARENT, { type, seq: 1, time: 1, data: {} }), false, type);
  }
  assert.equal(emitted.length, 0);
});

test('agent-end without a paired agent-start falls through (no invented end)', () => {
  const { wiring, emitted } = harness();
  assert.equal(wiring.handleEvent(PARENT, { type: 'tool-workflow/agent-end', seq: 3, time: 1, data: { runId: 'r', seq: 1, outcome: 'completed' } }), false);
  assert.equal(emitted.length, 0);
});

test('settlementStopReason matches only the fixed harness templates', () => {
  assert.equal(settlementStopReason('Background subagent s finished and will do no further work unless you send it more.'), 'completed');
  assert.equal(settlementStopReason('Background subagent s was stopped before it finished.'), 'cancelled');
  assert.equal(settlementStopReason('Background subagent s failed before it finished.'), 'failed');
  assert.equal(settlementStopReason('Background subagent s ran out of room before it finished.'), 'failed');
  assert.equal(settlementStopReason('some other text'), null);
  assert.equal(settlementStopReason(''), null);
  assert.equal(settlementStopReason(null), null);
});

test('reset clears every ledger (feed restart)', () => {
  const { wiring, emitted } = harness();
  wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 1, time: 1, data: { childId: CHILD, mode: 'one-shot' } });
  wiring.reset();
  assert.equal(wiring.debugState().startedCount, 0);
  wiring.handleEvent(PARENT, { type: 'subagent/catalog', seq: 2, time: 2, data: { childId: CHILD, mode: 'one-shot' } });
  assert.equal(emitted.length, 2, 'the same child seats again after a feed restart');
});
