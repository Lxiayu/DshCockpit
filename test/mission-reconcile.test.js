// test/mission-reconcile.test.js — 重启对账（S4）。
//
// 第一性原理：这组测试锁的是"不要在恐慌中撒谎"
//
//   重启对账最容易犯的两个错，方向相反但同样有害：
//     1. 把中断的派发当成**已完成** → 用户以为发出去了，其实没有
//     2. 把正在跑的工作当成**已失败** → 用户以为团队停了，其实只是自己看不见
//
//   第 2 条尤其危险：Harness 可能正在正常执行，我们因为重启失去了观测。
//   这时候宣布"失败了"，就是拿自己的失明当对方的过错。
//
//   所以这组测试钉死：只纠正**肯定不可能再推进**的状态，其余一律不动。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const reconcile = require('../src/mission/reconcile.js');

function aMission(over = {}) {
  return {
    missionId: 'mis-alpha',
    title: 't',
    intent: 'i',
    status: 'active',
    workspaceId: 'ws-1',
    createdAtMs: 1000,
    updatedAtMs: 2000,
    ...over,
  };
}

function aContract(over = {}) {
  return {
    status: 'draft',
    acceptance: [{ id: 'ac-1', text: '通过测试', kind: 'command', command: 'npm test' }],
    ...over,
  };
}

test('reconcile: a mission without a contract is untouched', () => {
  const r = reconcile.reconcileContract({ mission: aMission(), nowMs: 5000 });
  assert.equal(r.changed, false);
  assert.equal(r.contract, null);
});

test('reconcile: "dispatching" rolls back to draft after a restart', () => {
  // dispatching 的等待循环活在进程内存里；进程一死就没人推进它。
  // 它既没成功（无 taskRef），也不会继续 —— 必须回退，否则永远卡住。
  const r = reconcile.reconcileContract({
    mission: aMission({ contract: aContract({ status: 'dispatching' }) }),
    nowMs: 5000,
  });
  assert.equal(r.changed, true);
  assert.equal(r.contract.status, 'draft', 'must roll back to draft, not to active');
  assert.equal(r.contract.interruptedReason.includes('派发确认完成前退出'), true,
    'the rollback must explain WHY, or the user will think they did it');
  assert.equal(r.contract.interruptedAtMs, 5000);
});

test('reconcile: an "active" contract is NEVER downgraded by a restart', () => {
  // 这是本文件最重要的一条。
  // 合同进入 active 后，推进责任在 Harness。重启只让我们失去观测，
  // 不等于工作停了。因为自己看不见就宣布失败，是把失明当别人的过错。
  const r = reconcile.reconcileContract({
    mission: aMission({ contract: aContract({ status: 'active' }) }),
    nowMs: 5000,
  });
  assert.equal(r.changed, false, 'active must survive a restart untouched');
  assert.equal(r.contract.status, 'active');
});

test('reconcile: draft and ended are terminal-ish and stay put', () => {
  for (const status of ['draft', 'ended']) {
    const r = reconcile.reconcileContract({
      mission: aMission({ contract: aContract({ status }) }),
      nowMs: 5000,
    });
    assert.equal(r.changed, false, `${status} must not be rewritten on restart`);
    assert.equal(r.contract.status, status);
  }
});

test('reconcile: the rollback keeps every other contract field intact', () => {
  // 只改 status 和痕迹字段，验收条件/预算/Grant 都不能丢。
  const original = aContract({
    status: 'dispatching',
    budget: { maxTokens: 50000 },
    grantId: 'gr-abc',
    strategy: 'sequential',
  });
  const r = reconcile.reconcileContract({
    mission: aMission({ contract: original }), nowMs: 1,
  });
  assert.deepEqual(r.contract.acceptance, original.acceptance);
  assert.deepEqual(r.contract.budget, original.budget);
  assert.equal(r.contract.grantId, 'gr-abc');
  assert.equal(r.contract.strategy, 'sequential');
});

test('reconcile: reconcileMissionView emits ONE mission.updated event per fix', () => {
  // 对账层不写盘：只产出事件，由 store 的单写者通道落地。
  const view = { mission: aMission({ contract: aContract({ status: 'dispatching' }) }) };
  const r = reconcile.reconcileMissionView(view, 777);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'mission.updated');
  assert.equal(r.events[0].payload.missionId, 'mis-alpha');
  assert.equal(r.events[0].payload.contract.status, 'draft');
  assert.equal(r.reasons.length, 1);
});

test('reconcile: reconcileMissionView is silent when nothing needs fixing', () => {
  const view = { mission: aMission({ contract: aContract({ status: 'active' }) }) };
  const r = reconcile.reconcileMissionView(view, 777);
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.reasons, []);
});

test('reconcile: degenerate input never throws', () => {
  assert.doesNotThrow(() => reconcile.reconcileContract());
  assert.doesNotThrow(() => reconcile.reconcileContract({ mission: null }));
  assert.doesNotThrow(() => reconcile.reconcileContract({ mission: { contract: 'nonsense' } }));
  assert.doesNotThrow(() => reconcile.reconcileMissionView(null));
  assert.deepEqual(reconcile.reconcileMissionView(null).events, []);
});

test('reconcile: the interrupted-state list is closed and exported', () => {
  assert.deepEqual([...reconcile.INTERRUPTED_CONTRACT_STATES], ['dispatching']);
  assert.equal(reconcile.INTERRUPTED_CONTRACT_STATES.includes('active'), false,
    'active must never appear in the interrupted list');
});

// ---------------------------------------------------------------------------
// 运行期兜底：派发超时应显示"已下达，未确认"，而不是一直转圈
// ---------------------------------------------------------------------------

test('dispatchProgress: a fresh dispatch is still "dispatching"', () => {
  const contract = { status: 'dispatching', dispatchedAtMs: 1000 };
  assert.equal(reconcile.dispatchProgress({ contract, nowMs: 2000 }), 'dispatching');
});

test('dispatchProgress: past the timeout it becomes "unconfirmed" (not failed)', () => {
  // 关键区别：超时 ≠ 失败。prompt 可能已经被接受，只是投影还没反映出来，
  // 或者模型还没开始动作。说"失败"会让用户重复派发，制造重复任务。
  const contract = { status: 'dispatching', dispatchedAtMs: 1000 };
  assert.equal(
    reconcile.dispatchProgress({ contract, nowMs: 1000 + 121000, timeoutMs: 120000 }),
    'unconfirmed',
  );
});

test('dispatchProgress: no dispatch timestamp means we cannot judge — keep dispatching', () => {
  assert.equal(reconcile.dispatchProgress({ contract: { status: 'dispatching' }, nowMs: 999999 }), 'dispatching');
  assert.equal(reconcile.dispatchProgress({ contract: { status: 'draft' }, nowMs: 1 }), 'dispatching');
  assert.doesNotThrow(() => reconcile.dispatchProgress());
});

// ---------------------------------------------------------------------------
// 集成：重启对账真的会在 store 加载时执行（不是只有纯函数对）
// ---------------------------------------------------------------------------
//
// 第一性原理：纯函数测试通过 ≠ 功能接上了。
//   本项目已经有过"功能看起来接了，实际一条都没存"的教训
//   （TaskRef 的 append 被 schema 静默 break 掉，详见 ipc-mission.js 的注释）。
//   所以这里走真实的 registerMissionIpc 路径，验证对账**确实被执行**。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMissionStore } = require('../src/mission/store.js');
const { registerMissionIpc } = require('../src/ipc-mission.js');

function freshWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-reconcile-test-'));
}

function makeInvoker(dir, clockMs, logs) {
  const handlers = new Map();
  const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn), removeHandler: () => {} };
  registerMissionIpc(fakeIpc, {
    workspaceDirOf: () => dir,
    clock: () => clockMs,
    log: (m) => { if (logs) logs.push(m); },
    snapshotOf: () => null,
  });
  return handlers.get('mission:invoke');
}

test('integration: a stuck "dispatching" contract is fixed when the store loads', async () => {
  const dir = freshWorkspace();
  try {
    // 上一个进程留下：合同卡在 dispatching
    const s1 = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s1.append('mission.created', {
      missionId: 'mis-a', title: 't', intent: 'i', status: 'active', workspaceId: 'ws-1',
      createdAtMs: 1, updatedAtMs: 2,
      contract: { status: 'dispatching', acceptance: [{ id: 'a1', text: '通过', kind: 'manual' }] },
    });

    // 新进程首次访问 → 触发对账
    const logs = [];
    const invoke = makeInvoker(dir, 5000, logs);
    const r = await invoke(null, 'get', { missionId: 'mis-a' });
    assert.equal(r.ok, true);
    const c = r.view.mission.contract;
    assert.equal(c.status, 'draft', 'the stuck dispatch must be rolled back');
    assert.deepEqual(c.acceptance, [{ id: 'a1', text: '通过', kind: 'manual' }],
      'rollback must not lose the contract content');
    assert.ok(c.interruptedReason, 'the rollback must leave a trace');
    assert.ok(logs.some((l) => /reconcil/.test(l)), 'the fix must be observable in logs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: an "active" contract survives a reload untouched', async () => {
  const dir = freshWorkspace();
  try {
    const s1 = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s1.append('mission.created', {
      missionId: 'mis-b', title: 't', intent: 'i', status: 'active', workspaceId: 'ws-1',
      createdAtMs: 1, updatedAtMs: 2,
      contract: { status: 'active', acceptance: [{ id: 'a1', text: 'x', kind: 'manual' }] },
    });

    const invoke = makeInvoker(dir, 5000, null);
    const r = await invoke(null, 'get', { missionId: 'mis-b' });
    assert.equal(r.view.mission.contract.status, 'active',
      'a running contract must not be declared failed just because we restarted');
    assert.equal(r.view.mission.contract.interruptedReason, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration: reconciliation is idempotent across repeated loads', async () => {
  const dir = freshWorkspace();
  try {
    const s1 = createMissionStore({ workspaceDir: dir, now: () => 1000, log: () => {} });
    s1.append('mission.created', {
      missionId: 'mis-c', title: 't', intent: 'i', status: 'active', workspaceId: 'ws-1',
      createdAtMs: 1, updatedAtMs: 2,
      contract: { status: 'dispatching', acceptance: [{ id: 'a1', text: 'x', kind: 'manual' }] },
    });

    // 第一次加载 → 修复
    await makeInvoker(dir, 5000, null)(null, 'get', { missionId: 'mis-c' });
    // 第二次加载（新进程）→ 不应再写任何东西（已经是 draft 了）
    const logs2 = [];
    const r2 = await makeInvoker(dir, 6000, logs2)(null, 'get', { missionId: 'mis-c' });
    assert.equal(r2.view.mission.contract.status, 'draft');
    assert.ok(!logs2.some((l) => /fixed \d+ stuck/.test(l)),
      'a second load must not "fix" anything again (idempotent)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
