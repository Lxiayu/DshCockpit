// test/mission-turn-seq-tracker.test.js — turn → seq 映射（S5 凭证的前提）。
//
// 第一性原理：没有 seq 就没有凭证
//
//   官方 workspace/changes 事件的 payload **只有 {turn}**；
//   文件清单留在 Host 侧，按**事件的 seq** 索引。
//   而 seq 在事件信封上（event.seq），不在 payload 里。
//
//   所以不记 turn→seq，workStatus 只能说 claimed —— 用户永远等不到 verified。
//   这个追踪器就是让"可复核"成为可能的那一环。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const tst = require('../src/mission/turn-seq-tracker.js');

function changesEvent(turn, seq) {
  return { type: 'workspace/changes', seq, time: 1000, data: { turn } };
}

test('tracker: a workspace/changes event records turn → seq', () => {
  const t = tst.createTurnSeqTracker();
  const r = t.ingest(changesEvent(3, 29));
  assert.equal(r.recorded, true);
  assert.equal(r.turn, 3);
  assert.equal(r.seq, 29);
  assert.equal(t.seqForTurn(3), 29);
});

test('tracker: other event types are ignored (their seq means something else)', () => {
  // 用别的事件的 seq 去读 changes 会 404 或读到错的清单 —— 宁可没有。
  const t = tst.createTurnSeqTracker();
  t.ingest({ type: 'turn/end', seq: 5, data: { turn: 1 } });
  t.ingest({ type: 'tool/call', seq: 6, data: { turn: 1 } });
  assert.equal(t.seqForTurn(1), null);
  assert.equal(t.stats().ignored, 2);
  assert.equal(t.stats().turns, 0);
});

test('tracker: the LATEST event for a turn replaces the earlier one', () => {
  // 官方注释逐字："The latest event for one turn replaces earlier ones."
  // 所以覆盖是正确语义，不是数据丢失。
  const t = tst.createTurnSeqTracker();
  t.ingest(changesEvent(2, 10));
  t.ingest(changesEvent(2, 17));
  assert.equal(t.seqForTurn(2), 17, 'the later seq wins, per the official replacement rule');
});

test('tracker: an event without a numeric seq or turn is refused', () => {
  const t = tst.createTurnSeqTracker();
  assert.equal(t.ingest({ type: 'workspace/changes', data: { turn: 1 } }).recorded, false);
  assert.equal(t.ingest({ type: 'workspace/changes', seq: 9 }).recorded, false);
  assert.equal(t.ingest({ type: 'workspace/changes', seq: 9, data: { turn: 'x' } }).recorded, false);
  assert.equal(t.stats().turns, 0);
});

test('tracker: latest() points at the newest recorded turn', () => {
  const t = tst.createTurnSeqTracker();
  t.ingest(changesEvent(1, 4));
  t.ingest(changesEvent(2, 11));
  t.ingest(changesEvent(5, 30));
  assert.deepEqual(t.latest(), { turn: 5, seq: 30 });
});

test('tracker: the buffer is bounded', () => {
  const t = tst.createTurnSeqTracker({ cap: 3 });
  for (let i = 1; i <= 6; i += 1) t.ingest(changesEvent(i, i * 10));
  assert.equal(t.stats().turns, 3);
  assert.equal(t.seqForTurn(1), null, 'evicted');
  assert.equal(t.seqForTurn(6), 60);
});

test('tracker: degenerate input never throws', () => {
  const t = tst.createTurnSeqTracker();
  assert.doesNotThrow(() => t.ingest(null));
  assert.doesNotThrow(() => t.ingest({}));
  assert.doesNotThrow(() => t.ingest({ type: 'workspace/changes', seq: 1, data: null }));
  assert.equal(t.seqForTurn(NaN), null);
  assert.equal(t.latest(), null);
  assert.equal(tst.normalizeSeq('29'), null, 'a string seq is not a seq');
});
