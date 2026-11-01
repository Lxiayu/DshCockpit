// test/mission-board-chain.test.js — P2.3 端到端数据链路。
//
// 第一性原理：为什么需要这一层测试
//
//   前面三个套件分别测了：
//     · mission-board.test.js     —— 派生逻辑（手搓 projection）
//     · office-mission-board.test.js —— 隐私白名单（手搓输入）
//     · 快照集成（手搓 provider）
//
//   **全都是手搓的 projection**。真实链路是：
//     真实 Mission 事件 → store（JSONL）→ store.snapshot() → 派生 → 白名单 → 快照
//
//   手搓 fixture 的风险：它按我的**假设**构造，如果假设错了（字段名、
//   状态值、事件类型），三个套件全绿而真实链路是空的。
//
//   本文件就是那次验证的固化：我确实踩了这个坑——第一版用
//   `store.append({type, payload})` 调用（真实签名是 `append(type, payload)`），
//   且 decision/question 缺 status/decidedAtMs/askedAtMs 导致投影静默跳过。
//   **append 返回 ok，但投影里什么都没有。**
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMissionStore } = require('../src/mission/store.js');
const { buildMissionBoard } = require('../src/office/mission-board.js');
const { safeMissionBoard } = require('../src/office/office-mission-board.js');

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p23-chain-'));
}

/** 构造一个真实 Mission（走真实 store 写入路径）。 */
function seedMission(store) {
  const meta = { missionId: 'mis-real' };
  const results = [];
  results.push(store.append('mission.created', {
    missionId: 'mis-real', title: '真实链路验证', intent: '验证白板数据链路',
    status: 'active', workspaceId: 'ws', createdAtMs: 1, updatedAtMs: 1,
  }, meta));
  results.push(store.append('workstream.created', {
    workstreamId: 'ws-1', missionId: 'mis-real', title: 'W1', status: 'active',
    createdAtMs: 2, updatedAtMs: 2,
  }, meta));
  results.push(store.append('decision.recorded', {
    decisionId: 'd-1', missionId: 'mis-real', text: '用 JWT 做认证',
    rationale: '简单且够用', status: 'accepted', decidedAtMs: 3, decidedBy: 'user',
  }, meta));
  results.push(store.append('question.opened', {
    questionId: 'q-1', missionId: 'mis-real', text: '要支持 OAuth 吗',
    status: 'open', askedAtMs: 4,
  }, meta));
  return results;
}

test('chain: every seeded event is accepted by the real store', () => {
  // 这条先钉住"写入路径没问题"。append 返回 ok 是链路成立的前提。
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  const results = seedMission(store);
  for (const r of results) assert.strictEqual(r.ok, true, `append failed: ${JSON.stringify(r)}`);
});

test('chain: a REAL mission reaches the board with correct counts', () => {
  // 这是核心断言：真实 JSONL → 投影 → 派生 → 白名单 → 快照。
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  seedMission(store);
  const board = buildMissionBoard({
    projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now(),
  });
  assert.strictEqual(board.available, true, 'the board must see the seeded mission');
  assert.strictEqual(board.missions.length, 1);
  const m = board.missions[0];
  assert.strictEqual(m.missionId, 'mis-real');
  assert.strictEqual(m.label, '真实链路验证', 'the title survives as a label');
  assert.strictEqual(m.workstreamCount, 1);
  assert.strictEqual(m.activeWorkstreamCount, 1);
  assert.strictEqual(m.decisionCount, 1, 'a decision recorded through the real store must be counted');
  assert.strictEqual(m.openQuestionCount, 1, 'an open question must be counted as "needs you"');
});

test('chain: the privacy allowlist does not damage a REAL mission payload', () => {
  // 那个 [REDACTED:text] 坑的端到端回归保护。
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  seedMission(store);
  const snapshot = safeMissionBoard(buildMissionBoard({
    projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now(),
  }));
  assert.strictEqual(snapshot.missions[0].label, '真实链路验证');
  assert.doesNotMatch(JSON.stringify(snapshot), /REDACTED/);
});

test('chain: decision text / rationale NEVER reach the board (privacy, end to end)', () => {
  // 白板只要 counts。决策正文和理由属于 Mission Desk。
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  seedMission(store);
  const serialized = JSON.stringify(safeMissionBoard(buildMissionBoard({
    projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now(),
  })));
  for (const secret of ['用 JWT 做认证', '简单且够用', '要支持 OAuth 吗']) {
    assert.ok(!serialized.includes(secret), `board leaked: ${secret}`);
  }
});

test('chain: multiple missions are ranked with the one needing you first', () => {
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  // A：更新更晚，但没有待答
  store.append('mission.created', { missionId: 'mis-a', title: 'A', intent: 'i', status: 'active',
    workspaceId: 'ws', createdAtMs: 1, updatedAtMs: 999 }, { missionId: 'mis-a' });
  // B：更新更早，但有 1 个待答
  store.append('mission.created', { missionId: 'mis-b', title: 'B', intent: 'i', status: 'active',
    workspaceId: 'ws', createdAtMs: 1, updatedAtMs: 1 }, { missionId: 'mis-b' });
  store.append('question.opened', { questionId: 'q-1', missionId: 'mis-b', text: '待答',
    status: 'open', askedAtMs: 5 }, { missionId: 'mis-b' });

  const board = buildMissionBoard({ projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now() });
  assert.strictEqual(board.missions[0].missionId, 'mis-b', 'the mission awaiting an answer ranks first');
});

test('chain: a mission that moved to completed leaves the board', () => {
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  store.append('mission.created', { missionId: 'mis-x', title: 'X', intent: 'i', status: 'active',
    workspaceId: 'ws', createdAtMs: 1, updatedAtMs: 1 }, { missionId: 'mis-x' });
  let board = buildMissionBoard({ projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now() });
  assert.strictEqual(board.missions.length, 1);

  // 字段名是 `to`（不是 status）—— 写错时 projection 静默 break，append 仍返回 ok。
  store.append('mission.statusChanged', { missionId: 'mis-x', to: 'completed' }, { missionId: 'mis-x' });
  board = buildMissionBoard({ projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now() });
  assert.strictEqual(board.missions.length, 0, 'completed missions are not board material');
  assert.strictEqual(board.reason, 'no-active-missions', 'and that is a normal empty state, not a failure');
});

test('chain: an empty workspace yields the honest empty state (not an error)', () => {
  const store = createMissionStore({ workspaceDir: tmpWorkspace() });
  const board = buildMissionBoard({ projection: store.snapshot(), observedAtMs: Date.now(), nowMs: Date.now() });
  assert.strictEqual(board.available, false);
  assert.strictEqual(board.reason, 'no-active-missions');
  assert.deepStrictEqual(board.missions, []);
});

test('chain: a corrupted JSONL line does not break the board', () => {
  // 真实世界的故障模式：日志文件被截断/写坏。白板必须还能显示能读的部分。
  const workspaceDir = tmpWorkspace();
  const store = createMissionStore({ workspaceDir });
  store.append('mission.created', { missionId: 'mis-ok', title: 'OK', intent: 'i', status: 'active',
    workspaceId: 'ws', createdAtMs: 1, updatedAtMs: 1 }, { missionId: 'mis-ok' });

  // 追加一行坏数据
  fs.appendFileSync(store.file, '{"seq":999,"type":"mission.created"\n');

  const fresh = createMissionStore({ workspaceDir });
  const board = buildMissionBoard({ projection: fresh.snapshot(), observedAtMs: Date.now(), nowMs: Date.now() });
  assert.strictEqual(board.missions.length, 1, 'the good event still counts');
  assert.strictEqual(board.missions[0].missionId, 'mis-ok');
});
