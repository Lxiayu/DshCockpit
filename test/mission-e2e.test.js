// test/mission-e2e.test.js — P1：Mission Core 端到端（不含 Electron）。
//
// 第一性原理：为什么需要这个套件，明明各层都有测试
//
//   各层测试验证的是"每一层自己对不对"。但 P1 的价值在于**整条链路**：
//     用户建 Mission → 记录决策 → 登记产物 → 下次会话读 Brief
//   这条链路上任何一环的语义漂移（比如 Brief 里丢了 rationale）都不会让
//   单层测试变红，却会直接毁掉"跨 Session 连续记忆"这个产品承诺。
//
//   所以这里用真实文件系统跑完整流程，断言**最终产物**：
//     · Brief 里必须能看到决策的"为什么"
//     · 关掉 store 重开后（模拟重启）Brief 必须一样
//     · 产物改动后 verify 必须报 modified 而不是静默通过
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerMissionIpc } = require('../src/ipc-mission.js');

function boot(ws, snapshot = null) {
  const handlers = new Map();
  registerMissionIpc({ handle: (c, f) => handlers.set(c, f) }, {
    workspaceDirOf: () => ws,
    snapshotOf: () => snapshot,
    clock: () => Date.now(),
  });
  return (action, payload) => handlers.get('mission:invoke')({}, action, payload);
}

test('e2e: a full mission lifecycle survives a restart with its WHY intact', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-me2e-'));
  fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'docs', 'plan.md'), '# 计划\n内容');

  // ---- 第一次"会话"：建项目、记决策、开问题、登记产物 ----
  let call = boot(ws);
  const created = await call('create', {
    title: '把 DshCockpit 转成 Agent-first 工作空间',
    intent: '用户原话：我不想每次开会话都重新交代背景',
    constraints: [{ id: 'con-1', text: '不许改 office 业务代码', source: 'user' }],
  });
  assert.strictEqual(created.ok, true);
  const missionId = created.missionId;

  const ws1 = await call('addWorkstream', { missionId, title: 'Mission Core' });
  assert.strictEqual(ws1.ok, true);

  const dec = await call('recordDecision', {
    missionId,
    text: '用 append-only JSONL 而不是 SQLite',
    rationale: '我们要的是追加+全量读，用不上关系查询；且避免原生依赖让打包复杂化',
    decidedBy: 'user',
  });
  assert.strictEqual(dec.ok, true);

  const q = await call('openQuestion', { missionId, text: '要不要现在升级 runtime 到 0.2.x?' });
  assert.strictEqual(q.ok, true);

  const deliv = await call('registerDeliverable', {
    missionId, label: 'P1 计划', relPath: 'docs/plan.md',
  });
  assert.strictEqual(deliv.ok, true);

  // ---- Brief 必须能回答"下次会话我需要知道什么" ----
  const brief1 = await call('getBrief', { missionId });
  assert.strictEqual(brief1.ok, true);
  assert.match(brief1.brief.text, /append-only JSONL/, 'the decision text must survive');
  assert.match(brief1.brief.text, /why:.*原生依赖/, 'the RATIONALE must survive — this is the whole point');
  assert.match(brief1.brief.text, /不许改 office 业务代码/, 'constraints must survive');
  assert.match(brief1.brief.text, /要不要现在升级/, 'open questions must survive');
  assert.match(brief1.brief.text, /docs\/plan\.md/, 'deliverable paths must survive');

  // ---- 模拟重启：全新 store 实例读同一份磁盘 ----
  call = boot(ws);
  const brief2 = await call('getBrief', { missionId });
  assert.strictEqual(brief2.brief.text, brief1.brief.text,
    'a restart must reproduce the brief byte-for-byte — otherwise "cross-session memory" is a lie');

  // ---- 产物校验 ----
  let ver = await call('verifyDeliverables', { missionId });
  assert.strictEqual(ver.counts.unchanged, 1);
  assert.strictEqual(ver.healthy, true);

  fs.writeFileSync(path.join(ws, 'docs', 'plan.md'), '# 计划\n内容改过了');
  ver = await call('verifyDeliverables', { missionId });
  assert.strictEqual(ver.counts.modified, 1, 'a changed artifact must be reported, not silently accepted');
  assert.strictEqual(ver.healthy, false);
});

test('e2e: multiple missions stay isolated and both keep their own WHY', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-me2e2-'));
  const call = boot(ws);

  const a = await call('create', { title: '项目 A', intent: '目标 A' });
  const b = await call('create', { title: '项目 B', intent: '目标 B' });
  await call('recordDecision', { missionId: a.missionId, text: 'A 的决定', rationale: 'A 的理由' });
  await call('recordDecision', { missionId: b.missionId, text: 'B 的决定', rationale: 'B 的理由' });

  const briefA = await call('getBrief', { missionId: a.missionId });
  const briefB = await call('getBrief', { missionId: b.missionId });
  assert.match(briefA.brief.text, /A 的决定/);
  assert.doesNotMatch(briefA.brief.text, /B 的决定/, 'missions must not leak into each other');
  assert.match(briefB.brief.text, /B 的决定/);
  assert.doesNotMatch(briefB.brief.text, /A 的决定/);

  const list = await call('list');
  assert.strictEqual(list.activeCount, 2, 'two active missions coexist');
});

test('e2e: pausing a mission removes it from the active count but keeps its history', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-me2e3-'));
  const call = boot(ws);
  const c = await call('create', { title: 'T', intent: 'I' });
  await call('recordDecision', { missionId: c.missionId, text: '历史决定', rationale: '历史理由' });

  await call('updateStatus', { missionId: c.missionId, to: 'paused' });
  const list = await call('list');
  assert.strictEqual(list.activeCount, 0, 'a paused mission is not active');

  // 但历史必须还在——paused 不是删除
  const brief = await call('getBrief', { missionId: c.missionId });
  assert.match(brief.brief.text, /历史决定/);
  assert.match(brief.brief.text, /status: paused/);
});

test('e2e: the live snapshot is timestamped end-to-end', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-me2e4-'));
  const call = boot(ws, { observedAtMs: 1700000000000, hasRunningAgent: true, pendingApprovals: 1 });
  const c = await call('create', { title: 'T', intent: 'I' });
  const got = await call('get', { missionId: c.missionId });
  assert.strictEqual(got.live.available, true);
  assert.strictEqual(got.live.observedAtMs, 1700000000000,
    'the snapshot timestamp must reach the UI — otherwise "running" reads as "now"');
  assert.strictEqual(got.live.awaitingUser, true);
});

test('e2e: a corrupt log is reported in diagnostics but does not block reading', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-me2e5-'));
  const call = boot(ws);
  const c = await call('create', { title: 'T', intent: 'I' });

  // 在日志末尾塞一行垃圾（模拟崩溃留下的半行）
  fs.appendFileSync(path.join(ws, '.dsh', 'mission', 'events.jsonl'), 'half a line');

  const call2 = boot(ws);
  const diag = await call2('diagnostics');
  assert.strictEqual(diag.ok, true);
  assert.strictEqual(diag.report.healthy, false, 'damage must be visible');
  assert.strictEqual(diag.report.badLines.length, 1);

  // 但已写入的数据仍然可读——损坏是局部的
  const got = await call2('get', { missionId: c.missionId });
  assert.strictEqual(got.ok, true, 'a trailing bad line must not make prior events unreadable');
});
