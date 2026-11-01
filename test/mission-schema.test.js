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
