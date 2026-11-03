// test/mission-attention-action.test.js — attention action 的契约（S7 数据层接线）。
//
// 第一性原理：这个 action 决定右栏第一屏显示什么
//
//   380px 首屏只放得下 2-3 项。"哪几项占这几格"就是产品本身：
//   放错了，用户会错过真正阻塞团队的事，而去看一眼不重要的提醒。
//
//   这个 action 此前**完全没有测试**，而它同时服务两代 UI：
//   · 老 UI：读 items（全量）+ total + counts
//   · 新 UI（S7）：读 rail（分层 + 截断）
//
//   所以这里既要锁新语义，也要锁**向后兼容**——否则接线就等于破坏老 UI。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function makeInvoker({ snapshot, clock = () => 5000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-attention-'));
  const handlers = new Map();
  registerMissionIpc(
    { handle: (c, f) => handlers.set(c, f), removeHandler: () => {} },
    {
      workspaceDirOf: () => dir,
      clock,
      log: () => {},
      snapshotOf: snapshot === undefined ? () => null : () => snapshot,
    },
  );
  return { invoke: handlers.get('mission:invoke'), dir };
}

function snapshotWith(pendingItems) {
  return { observedAtMs: 4000, pendingItems };
}

test('attention: no snapshot is "unavailable", never an all-clear', async () => {
  // 最危险的空态：运行时没连上时告诉用户"没有需要你处理的事"。
  const { invoke, dir } = makeInvoker({ snapshot: null });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.ok, true);
    assert.equal(r.available, false);
    assert.deepEqual(r.items, []);
    // 关键：new UI 拿到的是 unknown，不是 calm
    assert.equal(r.rail.header.tone, 'unknown');
    assert.equal(r.rail.empty, null, 'absent data must not produce an "all clear" message');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: items stays FULL (backward compat) while rail truncates', async () => {
  // 这是接线时最容易破坏的一条：老 UI 用 total 计数、items 列表。
  // 若 items 被截断而 total 没变 → "说有三条只显示一条"。
  const items = Array.from({ length: 7 }, (_, i) => ({
    kind: 'approval', risk: 'high', createdAtMs: 100 + i, id: `a${i}`,
  }));
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith(items) });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.total, 7, 'total is the true count');
    assert.equal(r.items.length, 7, 'items must stay full for the legacy UI');
    assert.equal(r.rail.visible.decisions.length, 3, 'the new rail caps the first screen');
    assert.equal(r.rail.overflow.decisions, 4, 'hidden ones are counted, not lost');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: blocking decisions come before reminders in the compat list', async () => {
  // 老 UI 不认分层，但至少应该先看到阻塞的事。
  const items = [
    { kind: 'inbox', createdAtMs: 100 },
    { kind: 'approval', risk: 'high', createdAtMs: 200 },
    { kind: 'blocked', createdAtMs: 150 },
  ];
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith(items) });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.items[0].kind, 'approval', 'the blocking item must be first even for the legacy list');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: counts still separate approval from question (legacy contract)', async () => {
  const items = [
    { kind: 'approval', createdAtMs: 1 }, { kind: 'approval', createdAtMs: 2 },
    { kind: 'question', createdAtMs: 3 },
  ];
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith(items) });
  try {
    const r = await invoke(null, 'attention');
    assert.deepEqual(r.counts, { approval: 2, question: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: reminders alone are "calm", not "blocked"', async () => {
  const items = [{ kind: 'inbox', createdAtMs: 100 }];
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith(items) });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.rail.header.tone, 'calm');
    assert.equal(r.rail.header.decisionCount, 0);
    assert.equal(r.rail.header.reminderCount, 1);
    // 有提醒就不是"什么都没有"——不能显示"团队运行正常"
    assert.equal(r.rail.empty, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: an empty but AVAILABLE snapshot is the only all-clear', async () => {
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith([]) });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.available, true);
    assert.equal(r.rail.header.tone, 'calm');
    assert.ok(r.rail.empty, 'only a readable-and-empty source may say "nothing needs you"');
    assert.match(r.rail.empty.text, /运行正常/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('attention: unknown kinds are kept in the compat list but never counted as decisions', async () => {
  const items = [
    { kind: 'brand-new-kind', createdAtMs: 1 },
    { kind: 'approval', risk: 'medium', createdAtMs: 2 },
  ];
  const { invoke, dir } = makeInvoker({ snapshot: snapshotWith(items) });
  try {
    const r = await invoke(null, 'attention');
    assert.equal(r.rail.header.decisionCount, 1, 'unknown kinds must not inflate the decision count');
    assert.equal(r.items.length, 2, 'but the legacy list still carries them (no silent data loss)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
