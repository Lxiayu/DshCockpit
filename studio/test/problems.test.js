'use strict';

// studio/test/problems.test.js — the ONE problems panel's aggregator (plan task
// T12: 「按代码聚合 + 展开看明细」).
//
// The evidence that motivated it: the scene check produced 12 rows of the SAME
// code (SCENE_FURNITURE_OVERLAP) and pushed the useful summary (工位 6 · 座位 6 ·
// 障碍 32) out of view. The fix is one bottom panel fed by every validator, with
// the findings grouped by code — and THIS is that engine, tested straight through
// its public surface because the module is pure on purpose:
//   * 12 identical rows collapse into ONE group with count 12 and 12 details;
//   * distinct codes stay distinct, and the same code from two different
//     validators does NOT merge (the group identity is source × code × severity);
//   * severity aliases (error/warning/info/…) normalise into red/yellow/note;
//   * groups are ordered red → yellow → note, then count desc, then code asc;
//   * defensive shapes (null, a bare string, `check` instead of `code`, a
//     detail-only finding, a non-array findings argument) never throw;
//   * set() REPLACES a source, clear() drops one source or all of them;
//   * get() hands out copies, and a throwing subscriber stops nothing;
//   * target passthrough keeps exactly the keys that are present.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const {
  createProblems,
  PROBLEM_SEVERITIES,
} = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'problems.js'));

// The exact wall of rows from the evidence: one overlap per furniture pair, all
// with the same code, in the shape studio/lib/scene/conflicts.js pushes.
function overlapWall(count = 12) {
  return Array.from({ length: count }, (_, index) => ({
    code: 'SCENE_FURNITURE_OVERLAP',
    severity: 'red',
    message: `draft-${index} (flat-desk) overlaps draft-${index + 100} (flat-monitor) by 40 px²`,
    itemId: `draft-${index}`,
    detail: { with: `draft-${index + 100}`, areaPx2: 40 },
  }));
}

test('12 rows of the same code collapse into ONE group with count 12 and 12 details', () => {
  const problems = createProblems();
  const findings = overlapWall(12);
  problems.set('scene', findings);

  const state = problems.get();
  assert.equal(state.groups.length, 1, 'one group, not twelve rows');
  const group = state.groups[0];
  assert.equal(group.code, 'SCENE_FURNITURE_OVERLAP');
  assert.equal(group.severity, 'red');
  assert.equal(group.source, 'scene');
  assert.equal(group.count, 12, 'the group carries the count the summary needs');
  assert.equal(group.findings.length, 12, 'and the 12 details it expands into');
  assert.deepEqual(
    group.findings.map((finding) => finding.message),
    findings.map((finding) => finding.message),
    'the details survive in the order they arrived'
  );
  assert.equal(state.counts.red, 12);
  assert.equal(state.counts.total, 12);
  assert.equal(state.sources.scene.count, 12);
  assert.deepEqual(state.sources.scene.bySeverity, { red: 12, yellow: 0, note: 0 });
  assert.equal(problems.summaryLine(), '错误 12 · 提醒 0');
});

test('the group key is exactly the (source, severity, code) identity', () => {
  const problems = createProblems();
  problems.set('scene', [{ code: 'SCENE_ENTRY_BLOCKED', severity: 'red', message: 'entry 0 is walled off' }]);
  const group = problems.get().groups[0];
  assert.equal(group.key, JSON.stringify(['scene', 'red', 'SCENE_ENTRY_BLOCKED']));
});

test('distinct codes stay distinct and the same code from two sources does NOT merge', () => {
  const problems = createProblems();
  problems.set('scene', [
    { code: 'SCENE_ENTRY_BLOCKED', severity: 'red', message: 'entry 0 is walled off' },
    { code: 'SCENE_ENTRY_BLOCKED', severity: 'yellow', message: 'entry 1 stands in a prop' },
  ]);
  // the publish gate re-checks the very same layout and finds the very same problem
  problems.set('publish', [{ code: 'SCENE_ENTRY_BLOCKED', severity: 'red', message: 'the published layout still blocks the entry' }]);

  const state = problems.get();
  assert.equal(state.groups.length, 3, 'code × severity × source is the group identity');
  assert.equal(new Set(state.groups.map((group) => group.key)).size, 3, 'every key is unique');
  const sceneRed = state.groups.find((group) => group.source === 'scene' && group.severity === 'red');
  const publishRed = state.groups.find((group) => group.source === 'publish' && group.severity === 'red');
  assert.ok(sceneRed && publishRed);
  assert.notEqual(sceneRed.key, publishRed.key, 'two validators, two groups');
  assert.equal(sceneRed.count, 1);
  assert.equal(publishRed.count, 1);
  assert.equal(state.sources.scene.count, 2);
  assert.equal(state.sources.publish.count, 1);
});

test('severity aliases normalise into red/yellow/note and the counts add up', () => {
  const problems = createProblems();
  problems.set('gaps', [
    { code: 'A', severity: 'error', message: '' },
    { code: 'B', level: 'warning', detail: 'the alias key is `level`, the text is `detail`' },
    { code: 'C', severity: 'blocking', message: '' },
    { code: 'D', severity: 'info', message: '' },
    { code: 'E', severity: 'banana', message: 'nobody has heard of it' },
    { code: 'F', message: 'no severity at all' },
    { code: 'G', severity: 'ERROR', message: 'the lookup is case-insensitive' },
    { code: 'H', severity: 'hint', message: '' },
    { code: 'I', severity: null, level: 'warn', message: 'a null severity falls back to `level`' },
  ]);

  const state = problems.get();
  assert.equal(state.counts.red, 3);
  assert.equal(state.counts.yellow, 2);
  assert.equal(state.counts.note, 4);
  assert.equal(state.counts.total, 9);
  assert.equal(state.counts.red + state.counts.yellow + state.counts.note, state.counts.total, 'the three buckets cover the total');
  const byCode = new Map(state.groups.map((group) => [group.code, group.severity]));
  assert.equal(byCode.get('A'), 'red');
  assert.equal(byCode.get('B'), 'yellow');
  assert.equal(byCode.get('C'), 'red');
  assert.equal(byCode.get('D'), 'note');
  assert.equal(byCode.get('E'), 'note');
  assert.equal(byCode.get('F'), 'note');
  assert.equal(byCode.get('G'), 'red');
  assert.equal(byCode.get('H'), 'note');
  assert.equal(byCode.get('I'), 'yellow');
  const i = state.groups.find((group) => group.code === 'I');
  assert.equal(i.findings[0].message, 'a null severity falls back to `level`');
  const b = state.groups.find((group) => group.code === 'B');
  assert.equal(b.findings[0].message, 'the alias key is `level`, the text is `detail`');
  assert.deepEqual(PROBLEM_SEVERITIES, ['red', 'yellow', 'note']);
});

test('groups are ordered red → yellow → note, then count desc, then code asc', () => {
  const problems = createProblems();
  problems.set('mixed', [
    { code: 'AAA_NOTE', severity: 'note', message: '' },
    { code: 'MMM_YELLOW_ONCE', severity: 'yellow', message: '' },
    { code: 'ZZZ_YELLOW', severity: 'warn', message: '' },
    { code: 'ZZZ_YELLOW', severity: 'warn', message: '' },
    { code: 'ZZZ_RED_ONCE', severity: 'red', message: '' },
    { code: 'BBB_RED_ONCE', severity: 'red', message: '' },
    { code: 'AAA_RED_TWICE', severity: 'red', message: '' },
    { code: 'AAA_RED_TWICE', severity: 'red', message: '' },
  ]);

  const state = problems.get();
  assert.deepEqual(
    state.groups.map((group) => `${group.severity}:${group.code}:${group.count}`),
    [
      'red:AAA_RED_TWICE:2',
      'red:BBB_RED_ONCE:1',
      'red:ZZZ_RED_ONCE:1',
      'yellow:ZZZ_YELLOW:2',
      'yellow:MMM_YELLOW_ONCE:1',
      'note:AAA_NOTE:1',
    ],
    'severity first, then the biggest group, then the code — never the source order'
  );
});

test('defensive shapes: null, a string, `check` instead of `code`, only a `detail`', () => {
  const problems = createProblems();
  const findings = [
    null,
    'a bare string',
    42,
    { code: 'SCENE_FURNITURE_OVERLAP', severity: 'red', message: 'k' },
    { check: 'pack.entry-missing', detail: 'declared in the manifest but absent from the archive' },
    { detail: 'only a detail, no code, no severity' },
    [],
  ];
  assert.doesNotThrow(() => problems.set('scene', findings));
  const state = problems.get();
  assert.equal(state.counts.total, 3, 'only the plain objects survive');
  assert.deepEqual(
    state.groups.map((group) => group.code),
    ['SCENE_FURNITURE_OVERLAP', 'UNCODED', 'pack.entry-missing'],
  );
  const byCode = new Map(state.groups.map((group) => [group.code, group]));
  assert.equal(byCode.get('SCENE_FURNITURE_OVERLAP').severity, 'red');
  assert.equal(byCode.get('UNCODED').severity, 'note', 'a missing severity is a note');
  assert.equal(byCode.get('UNCODED').findings[0].message, 'only a detail, no code, no severity');
  assert.equal(byCode.get('pack.entry-missing').severity, 'note');
  assert.equal(byCode.get('pack.entry-missing').findings[0].message, 'declared in the manifest but absent from the archive');
  for (const group of state.groups) {
    assert.deepEqual(group.findings[0].target, {}, 'no target given ⇒ an empty one');
  }
});

test('set() REPLACES a source, clear() drops one source or everything', () => {
  const problems = createProblems();
  problems.set('scene', overlapWall(12));
  problems.set('scene', [{ code: 'SCENE_ENTRY_BLOCKED', severity: 'red', message: 'entry 0 is walled off' }]);
  let state = problems.get();
  assert.equal(state.sources.scene.count, 1, 'the second set replaced the first');
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].count, 1, 'the 12-row wall is gone');

  problems.set('publish', [{ check: 'pack.hash-mismatch', severity: 'error', detail: 'archive bytes hash 0abc… but the manifest declares 9fed…' }]);
  state = problems.get();
  assert.equal(state.counts.total, 2);
  assert.deepEqual(Object.keys(state.sources), ['scene', 'publish']);

  problems.clear('publish');
  state = problems.get();
  assert.equal(state.counts.total, 1);
  assert.equal(state.sources.publish, undefined, 'the cleared source disappears');
  assert.equal(state.sources.scene.count, 1, 'and only that one');

  // clearing something that was never set is a no-op, not a crash
  assert.doesNotThrow(() => problems.clear('dialogue'));
  assert.equal(problems.get().counts.total, 1);

  problems.clear();
  state = problems.get();
  assert.equal(state.counts.total, 0);
  assert.deepEqual(state.sources, {});
  assert.deepEqual(state.groups, []);
  assert.equal(problems.summaryLine(), '无问题');
});

test('set() with a non-array findings argument is an empty replacement, never a crash', () => {
  const problems = createProblems();
  problems.set('scene', overlapWall(12));
  for (const notAList of [null, undefined, 'a string', 7, { length: 12 }, true]) {
    assert.doesNotThrow(() => problems.set('scene', notAList));
    assert.equal(problems.get().counts.total, 0, `${JSON.stringify(notAList)} replaced the wall with nothing`);
    assert.equal(problems.get().sources.scene.count, 0, 'the source is still tracked, just empty');
  }
});

test('a source with no findings is counted but produces no group', () => {
  const problems = createProblems();
  problems.set('dialogue', []);
  const state = problems.get();
  assert.deepEqual(state.sources.dialogue, { count: 0, bySeverity: { red: 0, yellow: 0, note: 0 } });
  assert.deepEqual(state.groups, [], 'empty groups are not listed');
  assert.deepEqual(state.counts, { red: 0, yellow: 0, note: 0, total: 0 });
});

test('summaryLine() reads like the status bar', () => {
  const problems = createProblems();
  assert.equal(problems.summaryLine(), '无问题');

  problems.set('scene', Array.from({ length: 12 }, (_, index) => ({
    code: 'SCENE_FURNITURE_OVERLAP', severity: 'yellow', message: `row ${index}`,
  })));
  assert.equal(problems.summaryLine(), '错误 0 · 提醒 12');

  problems.set('graph', [
    { check: 'graph.node-unknown', severity: 'red', detail: 'no node teleport' },
    { check: 'graph.orphan', severity: 'warn', detail: 'an orphan node' },
    { check: 'graph.style', severity: 'note', detail: 'cosmetic' },
  ]);
  assert.equal(problems.summaryLine(), '错误 1 · 提醒 13 · 说明 1');
});

test('get() hands out copies: the store survives a scribbling renderer', () => {
  const problems = createProblems();
  const findings = [{
    code: 'SCENE_ENTRY_BLOCKED', severity: 'red', message: 'entry 0 is walled off',
    target: { page: 'scene', tab: 'layout', itemId: 'draft-27' },
  }];
  problems.set('scene', findings);

  // 1) the caller's own array and objects are never kept by reference
  findings.push({ code: 'LATER', severity: 'red', message: 'added after the set' });
  findings[0].message = 'rewritten after the set';
  findings[0].target.itemId = 'hacked';
  let state = problems.get();
  assert.equal(state.sources.scene.count, 1, 'the caller cannot grow the store');
  assert.equal(state.groups[0].findings[0].message, 'entry 0 is walled off', 'nor rewrite its findings');
  assert.equal(state.groups[0].findings[0].target.itemId, 'draft-27', 'nor their targets');

  // 2) what get() returns is a copy too
  state.groups.length = 0;
  state.groups.push({ key: 'junk', code: 'JUNK', severity: 'note', source: 'x', count: 1, findings: [] });
  state.counts.red = 999;
  state.sources.scene.count = 999;
  state = problems.get();
  assert.equal(state.groups.length, 1, 'the returned list is not the store');
  assert.equal(state.groups[0].code, 'SCENE_ENTRY_BLOCKED');

  const group = problems.get().groups[0];
  group.count = 0;
  group.findings.length = 0;
  group.findings.push({ severity: 'note', code: 'HACKED', message: '', target: {} });
  const finding = problems.get().groups[0].findings[0];
  finding.message = 'rewritten';
  finding.target.itemId = 'hacked';

  state = problems.get();
  assert.equal(state.groups[0].count, 1, 'a group copy, not the group');
  assert.equal(state.groups[0].findings.length, 1, 'a findings copy, not the array');
  assert.equal(state.groups[0].findings[0].code, 'SCENE_ENTRY_BLOCKED');
  assert.notEqual(state.groups[0].findings[0].message, 'rewritten');
  assert.equal(state.groups[0].findings[0].target.itemId, 'draft-27');
  assert.equal(state.counts.red, 1);
});

test('a throwing subscriber is inert and does not stop the others', () => {
  const problems = createProblems();
  const seen = [];
  const offBoom = problems.subscribe(() => { throw new Error('a broken panel must not break the store'); });
  const offOk = problems.subscribe((payload) => seen.push(payload));

  problems.set('scene', [{ code: 'Z', severity: 'note', message: 'heard by the listener after the thrower' }]);
  assert.equal(seen.length, 1, 'the listener after the throwing one still ran');
  assert.deepEqual(seen[0], problems.get(), 'the subscriber sees exactly what get() returns');
  assert.equal(seen[0].counts.total, 1);
  assert.equal(seen[0].groups.length, 1);

  problems.clear('scene');
  assert.equal(seen.length, 2, 'every mutation notifies, including a clear');

  offOk();
  problems.set('scene', overlapWall(2));
  assert.equal(seen.length, 2, 'the unsubscribe works');

  // the throwing listener is still registered and still harmless
  assert.doesNotThrow(() => problems.set('scene', []));
  offBoom();
  assert.doesNotThrow(() => problems.set('scene', overlapWall(1)));
});

test('target passthrough keeps only the keys that are present', () => {
  const problems = createProblems();
  problems.set('scene', [
    { code: 'A', severity: 'red', message: '', target: { page: 'scene', tab: 'layout', itemId: 'draft-27', nodeId: null, file: undefined } },
    { code: 'B', severity: 'red', message: '', target: { page: 'publish' } },
    { code: 'C', severity: 'red', message: '' },
    { code: 'D', severity: 'red', message: '', target: 'not-an-object' },
    { code: 'E', severity: 'red', message: '', target: { page: 'graph', nodeId: 'do', file: 'content/graphs/local-behaviour.vgraph.json', junk: 'dropped' } },
  ]);

  const targets = new Map(problems.get().groups.map((group) => [group.code, group.findings[0].target]));
  assert.deepEqual(targets.get('A'), { page: 'scene', tab: 'layout', itemId: 'draft-27' }, 'null/undefined values are dropped');
  assert.deepEqual(targets.get('B'), { page: 'publish' }, 'whatever subset is present');
  assert.deepEqual(targets.get('C'), {}, 'no target ⇒ an empty one');
  assert.deepEqual(targets.get('D'), {}, 'a non-object target is ignored');
  assert.deepEqual(targets.get('E'), { page: 'graph', nodeId: 'do', file: 'content/graphs/local-behaviour.vgraph.json' }, 'unknown keys are dropped');
});

test('two stores never see each other (no module-level state)', () => {
  const a = createProblems();
  const b = createProblems();
  a.set('scene', overlapWall(12));
  assert.equal(b.get().counts.total, 0);
  assert.equal(b.get().groups.length, 0);
  assert.equal(b.summaryLine(), '无问题');
  b.set('publish', [{ code: 'X', severity: 'red', message: '' }]);
  assert.equal(a.get().counts.total, 12);
  assert.equal(a.get().sources.publish, undefined);
});
