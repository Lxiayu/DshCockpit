'use strict';

// Subagent seat classifier — table-driven contracts.
//
// The classifier maps BOUNDED STRUCTURED METADATA (label/phase/mode) to a seat
// and is deliberately conservative: only the three resident work seats can be
// returned, everything unmatched/ambiguous/malformed fails closed to the
// collaborator seat, and `orchestrator` is never a subagent seat.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifySubagent, CLASSIFIED_SEATS, LABEL_CHAR_CAP } = require('../src/office/runtime/subagent-classifier.js');

// [label, expected employeeId, expected classified]
const TABLE = [
  // ---- reviewer ----
  ['review the function', 'reviewer', true],
  ['code review', 'reviewer', true],
  ['Audit the migration', 'reviewer', true],
  ['评审该函数', 'reviewer', true],
  ['复核结果', 'reviewer', true],
  ['verify the output', 'reviewer', true],
  // ---- coder ----
  ['implement the parser', 'coder', true],
  ['write a python script', 'coder', true],
  ['fix the login bug', 'coder', true],
  ['refactor utils', 'coder', true],
  ['编码实现', 'coder', true],
  ['编写函数', 'coder', true],
  ['修复缺陷', 'coder', true],
  // ---- researcher ----
  ['research top 3 attractions', 'researcher', true],
  ['investigate flaky tests', 'researcher', true],
  ['gather sources', 'researcher', true],
  ['调研杭州旅游三大看点', 'researcher', true],
  ['检索资料', 'researcher', true],
  // ---- fail-closed to collaborator ----
  ['', 'collaborator', false],
  [null, 'collaborator', false],
  [undefined, 'collaborator', false],
  [42, 'collaborator', false],
  ['summarize the findings', 'collaborator', false],
  ['与用户头脑风暴', 'collaborator', false],
  ['encode the payload', 'collaborator', false], // ascii keyword must be word-bounded
  ['prefix normalization', 'collaborator', false], // 'fix' must not match 'prefix'
  ['barcode scan', 'collaborator', false], // 'code' must not match 'barcode'
];

test('classifier: table-driven seat mapping', () => {
  for (const [label, employeeId, classified] of TABLE) {
    const verdict = classifySubagent({ label });
    assert.equal(verdict.employeeId, employeeId, `label=${JSON.stringify(label)}`);
    assert.equal(verdict.classified, classified, `label=${JSON.stringify(label)}`);
  }
});

test('classifier: precedence reviewer > coder > researcher on ambiguous labels', () => {
  // "review the code" matches reviewer(review) AND coder(code): reviewer wins.
  assert.equal(classifySubagent({ label: 'review the code' }).employeeId, 'reviewer');
  // "code research" matches coder AND researcher: coder wins.
  assert.equal(classifySubagent({ label: 'code research helper' }).employeeId, 'coder');
});

test('classifier: orchestrator is never a subagent seat', () => {
  for (const label of ['orchestrate the work', 'plan and schedule', '调度', '编排任务', 'coordinator']) {
    const verdict = classifySubagent({ label });
    assert.notEqual(verdict.employeeId, 'orchestrator', `label=${label}`);
    assert.equal(verdict.employeeId, 'collaborator');
    assert.equal(verdict.classified, false);
  }
});

test('classifier: phase is a secondary signal used only when label is unusable', () => {
  // label absent -> phase decides
  assert.equal(classifySubagent({ phase: 'review phase' }).employeeId, 'reviewer');
  // label wins over phase
  assert.equal(classifySubagent({ label: 'research it', phase: 'review phase' }).employeeId, 'researcher');
  // label present but unmatched -> does NOT fall back to phase (label is the
  // primary signal; a present-but-unmatched label means "no classification")
  assert.equal(classifySubagent({ label: 'summarize', phase: 'review phase' }).employeeId, 'collaborator');
});

test('classifier: over-cap labels are refused (no scan, fail closed)', () => {
  const long = `research ${'x'.repeat(LABEL_CHAR_CAP)}`;
  assert.equal(classifySubagent({ label: long }).employeeId, 'collaborator');
});

test('classifier: mode is echoed but never selects a seat on its own', () => {
  assert.equal(classifySubagent({ mode: 'one-shot' }).employeeId, 'collaborator');
  assert.equal(classifySubagent({ mode: 'continuable' }).employeeId, 'collaborator');
  assert.equal(classifySubagent({ label: 'research x', mode: 'continuable' }).mode, 'continuable');
  assert.equal(classifySubagent({ label: 'research x', mode: 'bogus' }).mode, null);
});

test('classifier: output is frozen and only the three work seats are classifiable', () => {
  assert.deepEqual([...CLASSIFIED_SEATS], ['researcher', 'coder', 'reviewer']);
  const verdict = classifySubagent({ label: 'code it' });
  assert.equal(Object.isFrozen(verdict), true);
  assert.equal(verdict.rule, 'code');
});

test('classifier: tolerates non-object input without throwing', () => {
  for (const input of [undefined, null, 'label', 7, []]) {
    assert.equal(classifySubagent(input).employeeId, 'collaborator');
  }
});
