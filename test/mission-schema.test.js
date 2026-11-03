// test/mission-schema.test.js — P1 Mission Core：schema 与投影的契约。
//
// 第一性原理：这组测试守护的是"语义不被腐坏"，不是"功能可用"
//
//   Mission Core 的失效方式不是崩溃，而是**静默的语义腐坏**：
//     · 把 Running（Harness 的事实）写进 Mission → 重启后状态撒谎
//     · 把 Focused（UI 偏好）当成 Mission 状态 → 两个事实作者
//     · 加"全局唯一 active"约束 → 用户想并行推进两个项目时被挡住
//
//   这些错误在写入时都看起来合理，几天后才表现为"状态不对但说不清哪里不对"。
//   所以这里锁死三类不变式：
//     1. 派生字段不得持久化（running / focused / sessionId / prompt…）
//     2. 多个 active Mission 必须允许共存（用户 2026-11-01 明确要求）
//     3. TaskRef 不得携带 status（任务状态是 Harness 的）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const schema = require('../src/mission/schema.js');
const projection = require('../src/mission/projection.js');

// ---------------------------------------------------------------- fixtures

function aMission(over = {}) {
  return {
    missionId: 'mis-alpha',
    title: '把 DshCockpit 转成 Agent-first 工作空间',
    intent: '用户原话目标',
    status: 'active',
    workspaceId: 'ws-1',
    createdAtMs: 1000,
    updatedAtMs: 2000,
    ...over,
  };
}

function aWorkstream(over = {}) {
  return {
    workstreamId: 'ws-upgrade',
    missionId: 'mis-alpha',
    title: 'Harness 0.2.x 升级',
    status: 'active',
    createdAtMs: 1000,
    updatedAtMs: 2000,
    ...over,
  };
}

function aDecision(over = {}) {
  return {
    decisionId: 'dec-1',
    missionId: 'mis-alpha',
    text: '用能力探测替代版本号门禁',
    rationale: '版本号不是兼容性判据；POC 已证明 0.2.1 可用',
    status: 'accepted',
    decidedAtMs: 1000,
    decidedBy: 'user',
    ...over,
  };
}

// --------------------------------------------------------- schema 硬约束

test('mission-schema: a well-formed Mission validates', () => {
  const r = schema.validateMission(aMission());
  assert.deepEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

test('mission-schema: "focused" is NOT a Mission status (it is a UI concept)', () => {
  // domain-model §2.1.1：Active/Focused/Running 是三件不同的事。
  // 把 focused 写进 status 会让"用户在看哪个"变成"这个项目是否还在推进"。
  const r = schema.validateMission(aMission({ status: 'focused' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /focused/.test(e) && /UI concept/.test(e)));
  assert.deepEqual(schema.MISSION_STATUSES, ['active', 'paused', 'completed', 'abandoned']);
});

test('mission-schema: derived fields must not be persisted (running is Harness-owned)', () => {
  for (const field of ['running', 'isFocused', 'awaitingUser', 'stale']) {
    const r = schema.validateMission(aMission({ [field]: true }));
    assert.strictEqual(r.ok, false, `${field} must be rejected`);
    assert.ok(r.errors.some((e) => e.includes(field)),
      `the error must name the offending field (${field})`);
  }
});

test('mission-schema: privacy fields are rejected even when nested', () => {
  // raw sessionId / prompt / 工具参数 / 产物内容 / 绝对路径 永不进 Mission。
  const r = schema.validateMission(aMission({
    meta: { lastRun: { sessionId: 'session-abc123' } },
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('meta.lastRun.sessionId')),
    'nested violations must be reported with their path');
});

test('mission-schema: lastSessionRef must be a DERIVED handle, never a raw id', () => {
  assert.deepEqual(schema.validateMission(aMission({ lastSessionRef: 'sess-h-a1b2c3' })).errors, []);
  const raw = schema.validateMission(aMission({ lastSessionRef: 'session-abc123' }));
  assert.strictEqual(raw.ok, false);
  assert.match(raw.errors.join(' '), /derived handle/);
});

test('mission-schema: intent is REQUIRED (never silently model-rewritten)', () => {
  // intent 是用户原话。允许它为空等于允许模型替用户重写目标。
  assert.strictEqual(schema.validateMission(aMission({ intent: '' })).ok, false);
  assert.strictEqual(schema.validateMission(aMission({ intent: undefined })).ok, false);
});

test('mission-schema: workspaceId is required (never an absolute path)', () => {
  assert.strictEqual(schema.validateMission(aMission({ workspaceId: '' })).ok, false);
  // 结构上只要求非空字符串；绝对路径的拦截在存储层（这里记录意图）
  assert.strictEqual(schema.validateMission(aMission({ workspaceId: 'ws-1' })).ok, true);
});

test('mission-schema: createdAt after updatedAt is rejected (impossible history)', () => {
  const r = schema.validateMission(aMission({ createdAtMs: 5000, updatedAtMs: 1000 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /after updatedAtMs/.test(e)));
});

test('mission-schema: constraints must declare who set them (user vs model)', () => {
  const r = schema.validateMission(aMission({
    constraints: [{ id: 'con-1', text: '不许改业务代码', source: 'nobody' }],
  }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /source must be "user" or "model"/.test(e)));
});

test('mission-schema: unknown entity types fail loudly (no silent pass)', () => {
  const r = schema.validateEntity('nonsense', {});
  assert.strictEqual(r.ok, false);
  assert.match(r.errors[0], /unknown entity type/);
});

// -------------------------------------------------- TaskRef 的所有权边界

test('mission-schema: a TaskRef must NOT carry status (task state is Harness-owned)', () => {
  // 这是"两个事实作者"最具体的例子：如果 Mission 也存 task status，
  // 那么 Harness 说 running、Mission 说 done 时，界面该信谁？
  const base = { taskRefId: 'tr-1', missionId: 'mis-alpha', workstreamId: 'ws-upgrade', harnessRef: 'exec-run:abc' };
  assert.deepEqual(schema.validateTaskRef(base).errors, []);
  const withStatus = schema.validateTaskRef({ ...base, status: 'running' });
  assert.strictEqual(withStatus.ok, false);
  assert.match(withStatus.errors.join(' '), /must NOT carry a status/);
});

test('mission-schema: a TaskRef may carry observedAtMs (a read timestamp, not a state)', () => {
  const r = schema.validateTaskRef({
    taskRefId: 'tr-1', missionId: 'm', workstreamId: 'w', harnessRef: 'x', observedAtMs: 1234,
  });
  assert.deepEqual(r.errors, []);
});

// ------------------------------------------------------------ Decision

test('mission-schema: a Decision without RATIONALE is rejected', () => {
  // "为什么这么决定"正是 compaction 会丢掉、下次会话最需要的东西。
  // 允许空 rationale 等于让 Shared Context 退化成一句结论。
  const r = schema.validateDecision(aDecision({ rationale: '' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.errors.join(' '), /WHY/);
});

test('mission-schema: a Decision must record who decided', () => {
  assert.strictEqual(schema.validateDecision(aDecision({ decidedBy: 'system' })).ok, false);
  assert.strictEqual(schema.validateDecision(aDecision({ decidedBy: 'user' })).ok, true);
  assert.strictEqual(schema.validateDecision(aDecision({ decidedBy: 'model' })).ok, true);
});

// ------------------------------------------------------------ Deliverable

test('mission-schema: a Deliverable rejects absolute paths and traversal', () => {
  const base = { deliverableId: 'd-1', missionId: 'm', label: 'report', digest: 'a'.repeat(32), registeredAtMs: 1 };
  assert.deepEqual(schema.validateDeliverable({ ...base, relPath: 'docs/report.md' }).errors, []);
  for (const evil of ['/etc/passwd', 'C:/Windows/x', '../../secrets', 'a/../../b']) {
    const r = schema.validateDeliverable({ ...base, relPath: evil });
    assert.strictEqual(r.ok, false, `${evil} must be rejected`);
  }
});

test('mission-schema: a Deliverable requires a content digest', () => {
  const base = { deliverableId: 'd-1', missionId: 'm', label: 'x', relPath: 'a.md', registeredAtMs: 1 };
  assert.strictEqual(schema.validateDeliverable(base).ok, false);
  assert.strictEqual(schema.validateDeliverable({ ...base, digest: 'not-hex!' }).ok, false);
});

// -------------------------------------------------------------- projection

test('projection: fold() is pure — the same events always give the same state', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
  ];
  const a = projection.fold(events);
  const b = projection.fold(events);
  assert.deepEqual(a.projection, b.projection);
});

test('projection: fold() does not mutate the input events', () => {
  const events = [{ seq: 1, type: 'mission.created', atMs: 100, payload: aMission() }];
  const snapshot = JSON.stringify(events);
  projection.fold(events);
  assert.strictEqual(JSON.stringify(events), snapshot);
});

test('projection: MULTIPLE active missions coexist (the user requirement)', () => {
  // 用户 2026-11-01 明确：Mission 必须支持多个同时 Active。
  // 数据层**不得**有任何"全局唯一 active"的约束。
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission({ missionId: 'mis-a', title: 'A' }) },
    { seq: 2, type: 'mission.created', atMs: 200, payload: aMission({ missionId: 'mis-b', title: 'B' }) },
    { seq: 3, type: 'mission.created', atMs: 300, payload: aMission({ missionId: 'mis-c', title: 'C', status: 'paused' }) },
  ];
  const { projection: p } = projection.fold(events);
  assert.strictEqual(Object.keys(p.missions).length, 3);
  const active = projection.activeMissions(p);
  assert.strictEqual(active.length, 2, 'two missions are active at the same time');
  assert.deepEqual(active.map((m) => m.missionId).sort(), ['mis-a', 'mis-b']);
});

test('projection: there is no soft/hard cap at the data layer (soft limit lives in the UI)', () => {
  // domain-model §2.1.1：建议 ≤10 是**软提示**，实现位置在 UI 层。
  // 数据层必须允许更多——否则用户被一个建议数字挡住。
  const events = [];
  for (let i = 0; i < 15; i += 1) {
    events.push({
      seq: i + 1, type: 'mission.created', atMs: 100 + i,
      payload: aMission({ missionId: `mis-${i}`, title: `M${i}` }),
    });
  }
  const { projection: p, skipped } = projection.fold(events);
  assert.strictEqual(skipped, 0);
  assert.strictEqual(projection.activeMissions(p).length, 15,
    '15 active missions must be representable — the soft limit is a UI hint, not a schema rule');
});

test('projection: mission.statusChanged updates status and updatedAtMs', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'mission.statusChanged', atMs: 500, payload: { missionId: 'mis-alpha', to: 'completed' } },
  ];
  const { projection: p } = projection.fold(events);
  assert.strictEqual(p.missions['mis-alpha'].status, 'completed');
  assert.strictEqual(p.missions['mis-alpha'].updatedAtMs, 500);
});

test('projection: mission.updated cannot change status mid-update (must use statusChanged)', () => {
  // 保留语义：状态变更是一个独立事实（有独立的 atMs 与原因），
  // 混进"改标题"里会让状态变更在历史里不可见。
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'mission.updated', atMs: 500, payload: { missionId: 'mis-alpha', title: '新标题', status: 'completed' } },
  ];
  const { projection: p } = projection.fold(events);
  assert.strictEqual(p.missions['mis-alpha'].title, '新标题');
  assert.strictEqual(p.missions['mis-alpha'].status, 'active', 'status must not change via the generic update');
});

test('projection: invalid payloads are SKIPPED and counted (not silently accepted)', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: { ...aMission(), status: 'focused' } }, // invalid
    { seq: 2, type: 'mission.created', atMs: 200, payload: aMission({ missionId: 'mis-ok' }) },
  ];
  const { projection: p, skipped } = projection.fold(events);
  assert.strictEqual(skipped, 1, 'the invalid event must be counted');
  assert.strictEqual(p.missions['mis-alpha'], undefined);
  assert.ok(p.missions['mis-ok'], 'the valid event still applies');
});

test('projection: unknown event types are skipped, not fatal (forward compatibility)', () => {
  // 未来版本写入的新事件不应让旧版本完全无法读取历史。
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'mission.futureThing', atMs: 200, payload: { missionId: 'mis-alpha' } },
    { seq: 3, type: 'workstream.created', atMs: 300, payload: aWorkstream() },
  ];
  const { projection: p, skipped } = projection.fold(events);
  assert.strictEqual(p.missions['mis-alpha'].title, aMission().title, 'known events still apply');
  assert.ok(p.workstreams['ws-upgrade']);
  assert.strictEqual(skipped, 1, 'the unknown event is reported as skipped');
});

test('projection: sequence gaps are REPORTED (log damage must not look normal)', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 3, type: 'workstream.created', atMs: 300, payload: aWorkstream() }, // seq 2 missing
  ];
  const { gaps } = projection.fold(events);
  assert.strictEqual(gaps.length, 1);
  assert.deepEqual(gaps[0], { expected: 2, actual: 3 });
});

test('projection: an empty log yields an empty projection with lastSeq 0', () => {
  const { projection: p, skipped, gaps } = projection.fold([]);
  assert.strictEqual(skipped, 0);
  assert.deepEqual(gaps, []);
  assert.strictEqual(p.lastSeq, 0);
  assert.deepEqual(Object.keys(p.missions), []);
});

test('projection: missionView assembles the indexed children', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'workstream.created', atMs: 200, payload: aWorkstream() },
    { seq: 3, type: 'decision.recorded', atMs: 300, payload: aDecision() },
    { seq: 4, type: 'question.opened', atMs: 400, payload: { questionId: 'q-1', missionId: 'mis-alpha', text: '要不要升级？', status: 'open', askedAtMs: 400 } },
    { seq: 5, type: 'deliverable.registered', atMs: 500, payload: { deliverableId: 'd-1', missionId: 'mis-alpha', label: '报告', relPath: 'docs/r.md', digest: 'b'.repeat(32), registeredAtMs: 500 } },
  ];
  const { projection: p } = projection.fold(events);
  const view = projection.missionView(p, 'mis-alpha');
  assert.ok(view);
  assert.strictEqual(view.workstreams.length, 1);
  assert.strictEqual(view.decisions.length, 1);
  assert.strictEqual(view.questions.length, 1);
  assert.strictEqual(view.deliverables.length, 1);
  assert.strictEqual(projection.missionView(p, 'mis-ghost'), null);
});

test('projection: decision.superseded keeps the original and records the successor', () => {
  // Shared Context 的价值在"为什么改主意"。覆盖原 decision 就把它弄丢了。
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'decision.recorded', atMs: 200, payload: aDecision() },
    { seq: 3, type: 'decision.superseded', atMs: 300, payload: { decisionId: 'dec-1', supersededBy: 'dec-2' } },
  ];
  const { projection: p } = projection.fold(events);
  const d = p.decisions['dec-1'];
  assert.strictEqual(d.status, 'superseded');
  assert.strictEqual(d.supersededBy, 'dec-2');
  assert.strictEqual(d.rationale, aDecision().rationale, 'the original rationale survives');
});

test('projection: question.answered records the answer and the reply time', () => {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: aMission() },
    { seq: 2, type: 'question.opened', atMs: 200, payload: { questionId: 'q-1', missionId: 'mis-alpha', text: '?', status: 'open', askedAtMs: 200 } },
    { seq: 3, type: 'question.answered', atMs: 400, payload: { questionId: 'q-1', answer: '升级' } },
  ];
  const { projection: p } = projection.fold(events);
  assert.strictEqual(p.questions['q-1'].status, 'answered');
  assert.strictEqual(p.questions['q-1'].answer, '升级');
  assert.strictEqual(p.questions['q-1'].answeredAtMs, 400);
});

// ===========================================================================
// 交付合同（S2，2026-11-04）
//
// 第一性原理：合同要解决的问题不是"多填几个字段"，而是**把"算做完"的
// 判定权从执行者手里拿回人类一侧**。
//
//   没有合同时：Lead 收到一段文本，自己决定做多少、做到什么程度算完成。
//   合同存在时：人先写下验收条件，每条绑定一种可检查的验证方式。
//
// 所以这组测试锁三件事：
//   1. 没有验收条件的合同**不允许存在**（否则只是更长的 prompt）
//   2. 每条验收条件必须带可检查的判据（kind + 对应字段）
//   3. 合同里**不允许出现路径**（只能引用 Grant），否则破坏隐私铁律
// ===========================================================================

function aContract(over = {}) {
  return {
    status: 'draft',
    acceptance: [
      { id: 'ac-1', text: 'npm test 全绿', kind: 'command', command: 'npm test' },
    ],
    ...over,
  };
}

test('contract: a mission without a contract stays valid (upgrade is not a migration)', () => {
  // 老数据没有 contract 字段。新能力不得强迫旧 Mission 改形状，
  // 否则升级就等于一次数据迁移，而迁移总会有人失败。
  const r = schema.validateMission(aMission());
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('contract: a contract with NO acceptance criteria is rejected', () => {
  // 这是整个合同模型的存在理由：
  // 「完成」如果没有判据，就必然回到"Agent 说了算"。
  const r = schema.validateMission(aMission({ contract: aContract({ acceptance: [] }) }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /at least one criterion/.test(e)),
    `expected a "cannot decide when done" error, got: ${r.errors.join('; ')}`);
});

test('contract: every acceptance kind must carry its own checkable criterion', () => {
  // kind=command 却没有 command，等于"我说要验证但不说什么算通过"。
  const noCommand = schema.validateMission(aMission({
    contract: aContract({ acceptance: [{ id: 'ac-1', text: '通过测试', kind: 'command' }] }),
  }));
  assert.equal(noCommand.ok, false);
  assert.ok(noCommand.errors.some((e) => /command is required/.test(e)));

  // kind=artifact 却没有 artifactRef，同理。
  const noArtifact = schema.validateMission(aMission({
    contract: aContract({ acceptance: [{ id: 'ac-1', text: '产出报告', kind: 'artifact' }] }),
  }));
  assert.equal(noArtifact.ok, false);
  assert.ok(noArtifact.errors.some((e) => /artifactRef is required/.test(e)));

  // manual 不需要额外字段：它本来就是"人自己看"。
  const manual = schema.validateMission(aMission({
    contract: aContract({ acceptance: [{ id: 'ac-1', text: '我看着可以', kind: 'manual' }] }),
  }));
  assert.equal(manual.ok, true, manual.errors.join('; '));
});

test('contract: an invented acceptance kind is rejected (the vocabulary is closed)', () => {
  // 如果允许模型发明 "agent-says-so" 这种 kind，合同立刻退化成自我报告。
  const r = schema.validateMission(aMission({
    contract: aContract({
      acceptance: [{ id: 'ac-1', text: 'x', kind: 'agent-says-so' }],
    }),
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /kind must be one of/.test(e)));
});

test('contract: paths are forbidden — only a Grant reference may name a directory', () => {
  // 隐私铁律：绝对路径与 cwd 不得持久化。
  // 合同如果要指目录，只能指向我们自己的 Grant 记录。
  const withCwd = schema.validateMission(aMission({ contract: aContract({ cwd: '/Users/someone/project' }) }));
  assert.equal(withCwd.ok, false, 'a raw cwd must be rejected by the forbidden-field scan');

  const withBadGrant = schema.validateMission(aMission({ contract: aContract({ grantId: '/tmp/x' }) }));
  assert.equal(withBadGrant.ok, false);
  assert.ok(withBadGrant.errors.some((e) => /grantId must look like/.test(e)));

  const goodGrant = schema.validateMission(aMission({ contract: aContract({ grantId: 'gr-abc123' }) }));
  assert.equal(goodGrant.ok, true, goodGrant.errors.join('; '));
});

test('contract: budget accepts zero (meaning "spend nothing") but rejects negatives and NaN', () => {
  const zero = schema.validateMission(aMission({ contract: aContract({ budget: { maxTokens: 0 } }) }));
  assert.equal(zero.ok, true, 'zero is a legitimate budget');

  const negative = schema.validateMission(aMission({ contract: aContract({ budget: { maxTokens: -1 } }) }));
  assert.equal(negative.ok, false);

  const nan = schema.validateMission(aMission({ contract: aContract({ budget: { maxTokens: NaN } }) }));
  assert.equal(nan.ok, false);

  const absent = schema.validateMission(aMission({ contract: aContract() }));
  assert.equal(absent.ok, true, 'no budget means unlimited, which is allowed');
});

test('contract: status is a closed set and draft is distinct from active', () => {
  for (const status of ['draft', 'dispatching', 'active', 'ended']) {
    const r = schema.validateMission(aMission({ contract: aContract({ status }) }));
    assert.equal(r.ok, true, `status ${status} must be accepted: ${r.errors.join('; ')}`);
  }
  const bad = schema.validateMission(aMission({ contract: aContract({ status: 'running' }) }));
  assert.equal(bad.ok, false, '"running" is a Harness fact, not a contract state');
});

test('contract: strategy is one of the three deterministic outcomes', () => {
  for (const strategy of ['single', 'sequential', 'parallel']) {
    const r = schema.validateMission(aMission({ contract: aContract({ strategy }) }));
    assert.equal(r.ok, true, `strategy ${strategy} must be accepted`);
  }
  const bad = schema.validateMission(aMission({ contract: aContract({ strategy: 'auto-magic' }) }));
  assert.equal(bad.ok, false);
});

test('contract: validateContract is exported and rejects non-objects without throwing', () => {
  assert.equal(typeof schema.validateContract, 'function');
  assert.deepEqual(schema.validateContract(null), ['contract must be an object']);
  assert.deepEqual(schema.validateContract('nope'), ['contract must be an object']);
  // 脏数据不得抛异常（schema 层的既有契约）
  assert.doesNotThrow(() => schema.validateContract({ acceptance: [null, 42, {}] }));
});

test('contract: the closed vocabularies are exported so the UI cannot invent values', () => {
  assert.deepEqual([...schema.ACCEPTANCE_KINDS], ['command', 'artifact', 'manual']);
  assert.deepEqual([...schema.CONTRACT_STATUSES], ['draft', 'dispatching', 'active', 'ended']);
  assert.deepEqual([...schema.DISPATCH_STRATEGIES], ['single', 'sequential', 'parallel']);
});

// ---------------------------------------------- 凭证坐标的持久化校验（S5）

test('schema: a well-formed receipt coordinate is accepted', () => {
  // 凭证要回答"我能不能复核这次交付"，所以它必须**持久化一个可寻址的坐标**。
  const r = schema.validateReceipt({
    sessionRef: 'sess-h-abc123',
    seq: 29,
    turn: 3,
    total: 2,
    added: 15,
    deleted: 3,
    files: [{ path: 'src/a.js', added: 15, deleted: 3 }],
  });
  assert.equal(r.ok, true, r.errors.join('; '));
});

test('schema: a raw sessionId as sessionRef is REFUSED (privacy §2.4)', () => {
  // 这是最容易犯的错：凭证要指向会话，手一滑就把 raw id 存进去了。
  const r = schema.validateReceipt({ sessionRef: 'session-9f2c-...', seq: 29 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /derived handle/.test(e)));
});

test('schema: absolute paths in the file list are REFUSED (privacy §2.4)', () => {
  const abs = schema.validateReceipt({
    sessionRef: 'sess-h-abc', seq: 1, files: [{ path: '/Users/xia/proj/a.js' }],
  });
  assert.equal(abs.ok, false);
  assert.ok(abs.errors.some((e) => /must be relative/.test(e)));

  const win = schema.validateReceipt({
    sessionRef: 'sess-h-abc', seq: 1, files: [{ path: 'C:\\Users\\x\\a.js' }],
  });
  assert.equal(win.ok, false);
});

test('schema: traversal in the file list is REFUSED', () => {
  const r = schema.validateReceipt({
    sessionRef: 'sess-h-abc', seq: 1, files: [{ path: 'a/../../etc/passwd' }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /traversal/.test(e)));
});

test('schema: seq is mandatory (a coordinate without it cannot be resolved)', () => {
  const r = schema.validateReceipt({ sessionRef: 'sess-h-abc' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /seq/.test(e)));
});

test('schema: negative or non-numeric counts are refused, not coerced to 0', () => {
  // 0 是"确实没改"，负数是脏数据。两者不能混。
  const r = schema.validateReceipt({
    sessionRef: 'sess-h-abc', seq: 1, total: -1, added: 'x',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /total/.test(e)));
  assert.ok(r.errors.some((e) => /added/.test(e)));
});

test('schema: the receipt validator rejects privacy-forbidden keys anywhere inside', () => {
  const r = schema.validateReceipt({
    sessionRef: 'sess-h-abc', seq: 1, cwd: '/Users/xia/proj',
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /privacy-forbidden/.test(e)));
});
