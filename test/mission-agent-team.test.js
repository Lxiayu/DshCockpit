// test/mission-agent-team.test.js — agentTeam 投影的归一化（右栏团队区块的数据源）。
//
// 第一性原理：为什么这个纯函数值得一组测试
//
//   右栏"团队"区块看到的**一切**都来自 normalizeAgentTeam 的返回值。
//   它在两件事上一旦出错，右栏就会对用户撒谎，而且**看不出来**：
//
//     1. 把"没有 agentTeam key"归一化成 {members:[], tasks:[]}
//        → 右栏显示"团队 0 人"，而真相是"团队功能没启用"。
//          用户会以为团队真的没人，而不是"去设置里打开开关"。
//
//     2. 自己重算 ready / blockedBy
//        → 一旦与 Harness 的派生逻辑有一丝不同，两边会显示互相矛盾的状态，
//          那时没人知道哪个对（违反"事实作者唯一"铁律）。
//
//   所以这组测试锁的是**语义**，不是实现：
//     · 缺 key → null（不是空团队）
//     · ready / blockedBy / writeScopes 原样透传（不推导）
//     · failure 存在时不能假装是实时数据
//
//   测试数据全部取自 2026-11-04 真机探针实测输出
//   （docs/quality/harness-agent-team-probe-2026-11-04.md §4/§9.2），不是编的。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeAgentTeam } = require('../src/ipc-mission.js');

// ---------------------------------------------------------------------------
// 真机实测原样数据（2026-11-04，0.2.1-rc.5 + 真实模型）
// ---------------------------------------------------------------------------

/** 刚创建会话、还没让 Lead 建团队时的投影。 */
const OBSERVED_BASELINE = {
  members: [{ id: 'session-3a807568-2ce5-4ac7-bbe6-5334dc6d33cb', name: 'lead', role: 'lead', phase: 'active' }],
  tasks: [],
};

/** U-1/U-2/U-3 验证后的真实投影（含依赖边）。 */
const OBSERVED_WITH_DAG = {
  members: [
    { id: 'session-945b0000-0000-0000-0000-000000000000', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'e5c497e6-0000-0000-0000-000000000000', name: 'probeu', role: 'teammate', phase: 'active' },
  ],
  tasks: [
    {
      id: 'task-1', revision: 3, subject: 'probe-task-A-c68d', description: 'A',
      status: 'completed', ready: false, blockedBy: [], writeScopes: [], writeScopeWarnings: [],
    },
    {
      id: 'task-2', revision: 1, subject: 'probe-task-B-2953', description: 'B',
      status: 'pending', ready: true, blockedBy: ['task-1'], writeScopes: [], writeScopeWarnings: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. "没有团队" ≠ "空团队"
// ---------------------------------------------------------------------------

test('agentTeam: a missing projection key is null, NOT an empty team', () => {
  // 这是整个文件最重要的一条：0.2.1 装了团队包但没启用 bundle 时，
  // session/projections 里**根本没有** agentTeam 这个 key。
  // 若返回 {members:[],tasks:[]}，右栏会显示"团队 0 人"——一个假事实。
  assert.equal(normalizeAgentTeam(undefined), null);
  assert.equal(normalizeAgentTeam(null), null);
  assert.equal(normalizeAgentTeam({}), null, 'an object with neither collection is not a team');
  assert.equal(normalizeAgentTeam('nonsense'), null);
  assert.equal(normalizeAgentTeam(42), null);
});

test('agentTeam: a team holding only the Lead is still a real team (not null)', () => {
  // 刚创建会话时投影恰好就是这样：只有一个隐式 lead。
  // 它必须被**如实**表示（UI 可以据此说"团队还没派人"），
  // 而不是被当成"没有团队"。
  const v = normalizeAgentTeam(OBSERVED_BASELINE);
  assert.ok(v, 'a lead-only team is still a team');
  assert.equal(v.members.length, 1);
  assert.equal(v.members[0].name, 'lead');
  assert.equal(v.members[0].role, 'lead');
  assert.deepEqual(v.tasks, []);
  assert.equal(v.failure, null);
});

// ---------------------------------------------------------------------------
// 2. ready / blockedBy / writeScopes 原样透传（不重算）
// ---------------------------------------------------------------------------

test('agentTeam: blockedBy and ready pass through verbatim (we are not a second author)', () => {
  const v = normalizeAgentTeam(OBSERVED_WITH_DAG);
  const b = v.tasks.find((t) => t.id === 'task-2');

  // 实测值：B 依赖 A，A 未完成时 B 的 ready=false；
  // A 完成后官方把 B 改成 ready=true。我们必须与官方逐字一致。
  assert.deepEqual(b.blockedBy, ['task-1'], 'blockedBy must be the SAME ids the harness reported');
  assert.equal(b.ready, true, 'ready must be taken from the harness, never recomputed');

  const a = v.tasks.find((t) => t.id === 'task-1');
  assert.deepEqual(a.blockedBy, []);
  assert.equal(a.ready, false, 'a completed task is not "ready" — that is the harness\'s call');
  assert.equal(a.status, 'completed');
  assert.equal(a.revision, 3, 'revision is the CAS token; it must survive normalization');
});

test('agentTeam: absence of ownerName stays null instead of being invented', () => {
  // 实测里 tasks 没有 ownerName 字段（还没人认领）。
  // 若归一化成 '' 或 '未分配'，UI 就无法区分"真的没人"与"字段缺失"。
  const v = normalizeAgentTeam(OBSERVED_WITH_DAG);
  for (const t of v.tasks) {
    assert.equal(t.ownerName, null, `task ${t.id} has no ownerName in the observed payload`);
  }
});

test('agentTeam: writeScopeWarnings are preserved as advisory data', () => {
  // 官方语义：这是"可能冲突"的提示，不是锁。我们必须保留原文，
  // 让 UI 能说"可能存在冲突"而不是"已锁定"。
  const raw = {
    members: [{ id: 'm1', name: 'lead', role: 'lead', phase: 'active' }],
    tasks: [{
      id: 'task-9', revision: 1, subject: 's', status: 'in_progress',
      ready: true, blockedBy: [], writeScopes: ['src/'],
      writeScopeWarnings: ['src/ overlaps with task-3'],
    }],
  };
  const v = normalizeAgentTeam(raw);
  assert.deepEqual(v.tasks[0].writeScopeWarnings, ['src/ overlaps with task-3']);
  assert.deepEqual(v.tasks[0].writeScopes, ['src/']);
});

// ---------------------------------------------------------------------------
// 3. failure 不得被当成实时数据
// ---------------------------------------------------------------------------

test('agentTeam: a projection failure is surfaced, not swallowed', () => {
  // 官方注释：failure 有值时 members/tasks 停留在**最后一次有效状态**。
  // 如果丢掉 failure，UI 会把陈旧数据当实时数据展示。
  const v = normalizeAgentTeam({
    ...OBSERVED_WITH_DAG,
    failure: 'record rejected by persistence',
  });
  assert.equal(v.failure, 'record rejected by persistence');
});

// ---------------------------------------------------------------------------
// 4. 恶意/异常输入不得抛错
// ---------------------------------------------------------------------------

test('agentTeam: malformed member/task entries are dropped without throwing', () => {
  // 投影来自运行时，但壳层不能假设它永远well-formed
  // （实验性包，契约可变）。一条坏记录不该让整个右栏崩掉。
  const v = normalizeAgentTeam({
    members: [
      { id: 'good', name: 'ok', role: 'teammate', phase: 'active' },
      { name: 'no-id' },                    // 缺 id
      null,                                  // 空
      { id: 123 },                           // id 不是字符串
    ],
    tasks: [
      { id: 'task-ok', revision: 1, subject: 's', status: 'pending', ready: true, blockedBy: [], writeScopes: [], writeScopeWarnings: [] },
      { id: 'task-bad-revision', revision: 'NaN', subject: 'x', status: 'pending', ready: false, blockedBy: 'not-array', writeScopes: null, writeScopeWarnings: {} },
      null,
    ],
  });
  assert.equal(v.members.length, 1, 'only the well-formed member survives');
  assert.equal(v.members[0].id, 'good');
  assert.equal(v.tasks.length, 2, 'the task with a bad revision is coerced, not dropped');
  const bad = v.tasks.find((t) => t.id === 'task-bad-revision');
  assert.equal(bad.revision, 0, 'non-finite revision degrades to 0');
  assert.deepEqual(bad.blockedBy, [], 'non-array blockedBy degrades to empty');
  assert.deepEqual(bad.writeScopes, []);
  assert.deepEqual(bad.writeScopeWarnings, []);
});

test('agentTeam: unknown role falls back to teammate (never silently becomes lead)', () => {
  // 角色决定 UI 是否允许"停止这个成员"等操作。
  // 一个未知 role 若被当成 lead，会让用户以为自己能停掉协调者。
  const v = normalizeAgentTeam({
    members: [{ id: 'm1', name: 'x', role: 'supervisor', phase: 'active' }],
    tasks: [],
  });
  assert.equal(v.members[0].role, 'teammate');
});

// ---------------------------------------------------------------------------
// 5. 派发指令渲染（S2）—— 执行契约的传输格式
// ---------------------------------------------------------------------------
//
// 第一性原理：为什么这段文字需要测试
//
//   我们没有 remote 写表面（D11）。派发的唯一实现是"把合同渲染成一段指令，
//   让 Lead 去调 spawn_teammate / team_task_create"。这段文字因此不是 UI 文案，
//   而是**执行契约的传输格式**：它少写一条验收条件，Agent 就少负一份责任，
//   而且没有任何报错。

const { renderDispatchInstruction, parseDispatchKey, DISPATCH_KEY_PREFIX } = require('../src/ipc-mission.js');

const MISSION_BASE = {
  missionId: 'mis-alpha',
  title: '把 DshCockpit 变成指挥台',
  intent: '用户原话目标',
  constraints: [{ id: 'c1', text: '不改官方代码', source: 'user' }],
};

test('dispatch: the idempotency key is on the FIRST line and round-trips', () => {
  // 确认阶段靠首行标记匹配"这是同一次下达"。
  // 一旦位置漂移（比如前面插了标题），匹配就永远失败 → 重复派发。
  const text = renderDispatchInstruction({
    mission: MISSION_BASE, task: '做点什么', dispatchKey: 'k-123',
  });
  assert.ok(text.startsWith(`${DISPATCH_KEY_PREFIX}k-123]`),
    `first line must be the key marker, got: ${String(text.split('\n')[0])}`);
  assert.equal(parseDispatchKey(text), 'k-123');
});

test('dispatch: parseDispatchKey refuses text without the marker (never guesses)', () => {
  assert.equal(parseDispatchKey('随便一段话'), null);
  assert.equal(parseDispatchKey(''), null);
  assert.equal(parseDispatchKey(null), null);
  // 标记不在首行也不算
  assert.equal(parseDispatchKey('标题\n[mission-dispatch:k]'), null);
});

test('dispatch: every acceptance criterion appears verbatim in the instruction', () => {
  // Agent 只有「看见」某条验收才能为它负责。少了就等于合同没生效。
  const text = renderDispatchInstruction({
    mission: {
      ...MISSION_BASE,
      contract: {
        status: 'draft',
        acceptance: [
          { id: 'ac-1', text: 'npm test 全绿', kind: 'command', command: 'npm test' },
          { id: 'ac-2', text: '产出调研报告', kind: 'artifact', artifactRef: 'docs/report.md' },
          { id: 'ac-3', text: '我看过觉得可以', kind: 'manual' },
        ],
      },
    },
    task: '调研 Agent Team',
    dispatchKey: 'k-1',
  });
  assert.ok(text.includes('npm test 全绿'));
  assert.ok(text.includes('产出调研报告'));
  assert.ok(text.includes('我看过觉得可以'));
  // 验证方式也要写清楚，否则"验收"只是口号
  assert.ok(text.includes('`npm test`'), 'command kind must show the command to run');
  assert.ok(text.includes('docs/report.md'), 'artifact kind must name the artifact');
});

test('dispatch: a mission with no contract falls back to the old instruction shape', () => {
  // 升级不是迁移：老 Mission 没有 contract，派发必须照常工作。
  const text = renderDispatchInstruction({
    mission: MISSION_BASE, task: '做点什么', dispatchKey: 'k-2',
  });
  assert.ok(text.includes('【Mission】把 DshCockpit 变成指挥台'));
  assert.ok(text.includes('目标：用户原话目标'));
  assert.ok(text.includes('约束：不改官方代码'));
  assert.ok(text.includes('【本次任务】'));
  assert.ok(!text.includes('【验收条件】'), 'no contract → no acceptance section');
  assert.ok(!text.includes('【要求】'), 'no contract → no task-board requirement');
});

test('dispatch: with a contract the lead is told to put criteria on the task board', () => {
  // 只在对话里承诺 = 右栏和 Harness 都读不到。
  // 要求写进任务板，才能让"这次做到什么程度算完"成为双方可见的事实。
  const text = renderDispatchInstruction({
    mission: {
      ...MISSION_BASE,
      contract: {
        status: 'draft',
        acceptance: [{ id: 'ac-1', text: 'x', kind: 'manual' }],
      },
    },
    task: 't',
    dispatchKey: 'k-3',
  });
  assert.ok(text.includes('team_task_create'));
  assert.ok(text.includes('验收条件'));

  // 没有合同时不该要求建任务板（避免无意义的空任务）
  const noContract = renderDispatchInstruction({ mission: MISSION_BASE, task: 't', dispatchKey: 'k-4' });
  assert.ok(!noContract.includes('team_task_create'));
});

test('dispatch: a budget appears only when finite, and says "stop and report"', () => {
  const withBudget = renderDispatchInstruction({
    mission: {
      ...MISSION_BASE,
      contract: {
        status: 'draft',
        acceptance: [{ id: 'a', text: 'x', kind: 'manual' }],
        budget: { maxTokens: 50000 },
      },
    },
    task: 't', dispatchKey: 'k-5',
  });
  assert.ok(withBudget.includes('50000'));
  assert.ok(withBudget.includes('停下并汇报'));

  const noBudget = renderDispatchInstruction({
    mission: {
      ...MISSION_BASE,
      contract: { status: 'draft', acceptance: [{ id: 'a', text: 'x', kind: 'manual' }] },
    },
    task: 't', dispatchKey: 'k-6',
  });
  assert.ok(!noBudget.includes('【预算】'));
});

test('dispatch: degenerate inputs never throw and never invent content', () => {
  // 派发路径上抛异常 = 用户点了按钮什么都没发生。
  assert.doesNotThrow(() => renderDispatchInstruction());
  assert.doesNotThrow(() => renderDispatchInstruction({ mission: null, task: null, dispatchKey: null }));
  const empty = renderDispatchInstruction({});
  assert.equal(parseDispatchKey(empty), null, 'no key given → no key marker');
  assert.ok(empty.includes('【本次任务】'), 'structure survives degenerate input');
});
