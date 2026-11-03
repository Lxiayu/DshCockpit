// test/mission-receipt-persistence.test.js — 凭证落盘（S5）。
//
// 第一性原理：为什么凭证必须落盘，而不是每次现读
//
//   官方的变更清单**只在 Session 存活期间可用**（Host 侧不持久）。
//   所以如果凭证只在 workStatus 时即时读取，那么 app 一重启、
//   或者会话一 dispose，"这次交付有没有依据"就永久丢失了 ——
//   用户历史里只剩下一句"团队说做完了"。
//
//   落盘的是**坐标**（sessionRef/seq/turn + 计数 + 相对路径清单），
//   不是变更内容。坐标过期后仍可回答"当时复核过什么"，只是不能重新复核。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createProjection, applyEvent } = require('../src/mission/projection.js');
const schema = require('../src/mission/schema.js');

function base(extra = {}) {
  return {
    missions: {
      'mis-a': {
        missionId: 'mis-a', title: 't', intent: 'i', status: 'active',
        workspaceId: 'ws-1', createdAtMs: 1, updatedAtMs: 2, ...extra,
      },
    },
    workstreams: {}, decisions: {}, questions: {}, deliverables: {},
    taskRefs: {}, findings: {}, assumptions: {}, evidences: {},
  };
}

const RECEIPT = {
  sessionRef: 'sess-h-abc123',
  seq: 29,
  turn: 3,
  total: 2,
  added: 15,
  deleted: 3,
  files: [{ path: 'src/a.js', added: 15, deleted: 3 }],
};

test('persistence: a validated receipt is attached to the mission', () => {
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: RECEIPT },
    atMs: 5000,
  });
  const m = next.missions['mis-a'];
  assert.ok(m.receipt, 'the mission must carry the receipt');
  assert.equal(m.receipt.seq, 29);
  assert.equal(m.receipt.total, 2);
  assert.equal(m.receipt.recordedAtMs, 5000);
});

test('persistence: an INVALID receipt is not applied (schema gates the log)', () => {
  // 关键：projection 遇到非法 payload 时 break（不抛错、不写入）。
  // 这是本项目既有约定 —— 但正因如此，"没写进去"必须能被测试发现。
  const withAbs = { ...RECEIPT, files: [{ path: '/Users/xia/proj/a.js', added: 1, deleted: 0 }] };
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: withAbs },
    atMs: 5000,
  });
  assert.equal(next.missions['mis-a'].receipt, undefined,
    'a receipt carrying an absolute path must never reach the fact chain');
});

test('persistence: a receipt with a raw sessionId is not applied', () => {
  const withRaw = { ...RECEIPT, sessionRef: 'session-9f2c' };
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: withRaw },
    atMs: 5000,
  });
  assert.equal(next.missions['mis-a'].receipt, undefined);
});

test('persistence: only the LATEST receipt is kept per mission', () => {
  // 攒一堆历史凭证会让 UI 无法回答"现在该信哪个"。
  let proj = base();
  proj = applyEvent(proj, {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: { ...RECEIPT, seq: 10, turn: 1 } },
    atMs: 1000,
  });
  proj = applyEvent(proj, {
    type: 'receipt.recorded',
    payload: { missionId: 'mis-a', receipt: { ...RECEIPT, seq: 29, turn: 3 } },
    atMs: 5000,
  });
  assert.equal(proj.missions['mis-a'].receipt.seq, 29, 'the newest coordinate wins');
  assert.equal(proj.missions['mis-a'].receipt.turn, 3);
});

test('persistence: a receipt for an unknown mission is ignored', () => {
  const next = applyEvent(base(), {
    type: 'receipt.recorded',
    payload: { missionId: 'nope', receipt: RECEIPT },
    atMs: 5000,
  });
  assert.equal(next.missions['nope'], undefined);
});

test('persistence: the event type is part of the frozen vocabulary', () => {
  // 事件类型是闭集。新增类型必须同时出现在 EVENT_TYPES 里，
  // 否则 replay 会静默丢弃它（本项目踩过同类坑：
  // taskRef append 曾被 schema 静默 break，功能看起来接了实际一条没存）。
  const { EVENT_TYPES } = require('../src/mission/projection.js');
  assert.ok(EVENT_TYPES.includes('receipt.recorded'),
    'a type missing from EVENT_TYPES would be silently dropped on replay');
});

test('persistence: schema rejects a receipt with no seq (unresolvable coordinate)', () => {
  const r = schema.validateReceipt({ sessionRef: 'sess-h-abc' });
  assert.equal(r.ok, false);
});
