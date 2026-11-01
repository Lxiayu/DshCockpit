// test/mission-brief.test.js — P1：Mission Brief（跨 Session 记忆的实际载体）。
//
// 第一性原理：Brief 是整个 Mission Core 的交付物
//
//   用户痛点：同一个项目开很多次会话，每次都要重新交代背景。
//   解决它的那个东西就是 Brief —— 下次会话 Agent 读到的就是它。
//
//   所以 Brief 的约束是**产品约束**，不是技术偏好：
//     1. 有字节预算（8KB）——它是注入模型上下文的，不是文档
//     2. 超预算时必须**按重要性丢弃**，不能随便切一半
//     3. 截断必须**明说**——静默丢弃会让 Agent 以为自己看到了全貌
//     4. Harness 快照必须标注 observedAtMs——否则陈旧状态会被当成当前状态
//     5. 确定性——同样输入同样输出，否则无法测试/diff/缓存
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { buildBrief, briefFingerprint, DEFAULT_MAX_BYTES, byteLen } = require('../src/mission/brief.js');
const projection = require('../src/mission/projection.js');

function mission(over = {}) {
  return {
    missionId: 'mis-a', title: '转型项目', intent: '把 DshCockpit 转成 Agent-first 工作空间',
    status: 'active', workspaceId: 'ws-1', createdAtMs: 100, updatedAtMs: 900,
    ...over,
  };
}

function buildView(extraEvents = [], missionOver = {}) {
  const events = [
    { seq: 1, type: 'mission.created', atMs: 100, payload: mission(missionOver) },
    ...extraEvents,
  ];
  const { projection: p } = projection.fold(events);
  return projection.missionView(p, 'mis-a');
}

// ------------------------------------------------------------- 内容完整性

test('brief: contains the mission title, intent and status', () => {
  const b = buildBrief(buildView());
  assert.match(b.text, /转型项目/);
  assert.match(b.text, /Agent-first 工作空间/, 'the user\'s own words must survive verbatim');
  assert.match(b.text, /status: active/);
});

test('brief: decisions keep their RATIONALE (that is what compaction destroys)', () => {
  const view = buildView([{
    seq: 2, type: 'decision.recorded', atMs: 200,
    payload: {
      decisionId: 'd1', missionId: 'mis-a', text: '用能力探测替代版本门禁',
      rationale: '版本号不是兼容性判据，POC 已证明 0.2.1 可用',
      status: 'accepted', decidedAtMs: 200, decidedBy: 'user',
    },
  }]);
  const b = buildBrief(view);
  assert.match(b.text, /用能力探测替代版本门禁/);
  assert.match(b.text, /why:.*POC 已证明/, 'a decision without WHY is useless next session');
});

test('brief: constraints are included and marked with their source', () => {
  const view = buildView([], {
    constraints: [
      { id: 'c1', text: '不许改 office 业务代码', source: 'user' },
      { id: 'c2', text: '优先最小改动', source: 'model' },
    ],
  });
  const b = buildBrief(view);
  assert.match(b.text, /不许改 office 业务代码/);
  assert.match(b.text, /proposed by model/, 'a model-proposed constraint must not look like a user rule');
});

test('brief: only OPEN questions appear (answered ones are noise)', () => {
  const view = buildView([
    { seq: 2, type: 'question.opened', atMs: 200, payload: { questionId: 'q1', missionId: 'mis-a', text: '要不要升级?', status: 'open', askedAtMs: 200 } },
    { seq: 3, type: 'question.answered', atMs: 300, payload: { questionId: 'q1', answer: '要' } },
  ]);
  const b = buildBrief(view);
  assert.doesNotMatch(b.text, /## Open questions/, 'an answered question is no longer open');
});

test('brief: deliverables list paths and digest prefixes but NEVER inline content', () => {
  const view = buildView([{
    seq: 2, type: 'deliverable.registered', atMs: 200,
    payload: {
      deliverableId: 'd1', missionId: 'mis-a', label: 'POC 报告',
      relPath: 'docs/research/poc.md', digest: 'abcdef0123456789'.repeat(2), registeredAtMs: 200,
    },
  }]);
  const b = buildBrief(view);
  assert.match(b.text, /docs\/research\/poc\.md/);
  assert.match(b.text, /sha256:abcdef012345/, 'a digest prefix lets the agent verify without reading content');
});

// ------------------------------------------- Harness 快照必须标注时间

test('brief: Harness runtime state is labelled with observedAtMs (never presented as current truth)', () => {
  // Mission Core 不拥有 running/awaitingUser —— 只能读快照并标注时间。
  // 不标注的话，重启后 Brief 会把陈旧状态当成当前状态。
  const b = buildBrief(buildView(), {
    observed: { hasRunningAgent: true, pendingApprovals: 2, pendingQuestions: 1 },
    observedAtMs: 1700000000000,
  });
  assert.match(b.text, /observed at 2023-11-14T22:13:20\.000Z/);
  assert.match(b.text, /running=yes/);
  assert.match(b.text, /pendingApprovals=2/);
});

test('brief: without observedAtMs no live line is emitted (we cannot timestamp it, so we stay silent)', () => {
  const b = buildBrief(buildView(), { observed: { hasRunningAgent: true } });
  assert.doesNotMatch(b.text, /running=/, 'unlabelled live state would be a lie');
  assert.doesNotMatch(b.text, /observed at/);
});

// --------------------------------------------------------------- 预算

test('brief: the default budget is 8KB', () => {
  assert.strictEqual(DEFAULT_MAX_BYTES, 8 * 1024);
});

test('brief: a normal mission is well under budget', () => {
  const b = buildBrief(buildView());
  assert.ok(b.bytes < DEFAULT_MAX_BYTES);
  assert.strictEqual(b.truncated, false);
});

test('brief: a large mission is truncated to the budget', () => {
  const many = [];
  for (let i = 0; i < 120; i += 1) {
    many.push({
      seq: i + 2, type: 'decision.recorded', atMs: 1000 + i,
      payload: {
        decisionId: `d${i}`, missionId: 'mis-a',
        text: `决策 ${i}：${'很长的说明'.repeat(20)}`,
        rationale: `理由 ${i}：${'因为这样更好'.repeat(20)}`,
        status: 'accepted', decidedAtMs: 1000 + i, decidedBy: 'user',
      },
    });
  }
  const b = buildBrief(buildView(many), { maxBytes: 4096 });
  assert.ok(byteLen(b.text) <= 4096, `brief must respect the budget, got ${byteLen(b.text)}`);
  assert.strictEqual(b.truncated, true);
});

test('brief: truncation is DISCLOSED (silently dropping makes the agent think it saw everything)', () => {
  const many = [];
  for (let i = 0; i < 120; i += 1) {
    many.push({
      seq: i + 2, type: 'decision.recorded', atMs: 1000 + i,
      payload: {
        decisionId: `d${i}`, missionId: 'mis-a',
        text: `决策 ${i} ${'x'.repeat(200)}`, rationale: `理由 ${i} ${'y'.repeat(200)}`,
        status: 'accepted', decidedAtMs: 1000 + i, decidedBy: 'user',
      },
    });
  }
  const b = buildBrief(buildView(many), { maxBytes: 4096 });
  assert.match(b.text, /Brief truncated to 4096 bytes/);
  assert.match(b.text, /Omitted:/, 'the agent must be told what it is missing');
  assert.match(b.text, /Ask the user for specifics/, 'and told what to do about it');
});

test('brief: low-priority sections (deliverables) are dropped before high-priority ones', () => {
  // 预算紧张时，intent/constraints/decisions 必须优先于产物列表。
  const events = [
    {
      seq: 2, type: 'decision.recorded', atMs: 200,
      payload: {
        decisionId: 'd1', missionId: 'mis-a', text: '关键决策', rationale: '关键理由',
        status: 'accepted', decidedAtMs: 200, decidedBy: 'user',
      },
    },
  ];
  for (let i = 0; i < 40; i += 1) {
    events.push({
      seq: 3 + i, type: 'deliverable.registered', atMs: 300 + i,
      payload: {
        deliverableId: `dl${i}`, missionId: 'mis-a', label: `产物 ${i}`,
        relPath: `docs/file-${i}.md`, digest: 'c'.repeat(32), registeredAtMs: 300 + i,
      },
    });
  }
  const b = buildBrief(buildView(events), { maxBytes: 1200 });
  assert.match(b.text, /关键决策/, 'the decision must survive');
  assert.match(b.text, /转型项目/, 'the title must survive');
  assert.ok('deliverables' in b.dropped || !b.text.includes('## Deliverables'),
    'deliverables are the first thing to go');
});

test('brief: a tiny budget still produces something readable (never an empty string on truncation)', () => {
  const b = buildBrief(buildView(), { maxBytes: 64 });
  assert.ok(b.bytes <= 64);
  assert.ok(b.text.length > 0, 'a truncated brief must still contain the header, not nothing');
});

// --------------------------------------------------------------- 确定性

test('brief: identical input produces byte-identical output (testable / diffable / cacheable)', () => {
  const view = buildView([{
    seq: 2, type: 'decision.recorded', atMs: 200,
    payload: { decisionId: 'd1', missionId: 'mis-a', text: 'T', rationale: 'R', status: 'accepted', decidedAtMs: 200, decidedBy: 'user' },
  }]);
  const a = buildBrief(view);
  const b = buildBrief(view);
  assert.strictEqual(a.text, b.text);
  assert.strictEqual(briefFingerprint(a), briefFingerprint(b));
});

test('brief: a different mission produces a different fingerprint', () => {
  const a = buildBrief(buildView([], { title: '项目 A' }));
  const b = buildBrief(buildView([], { title: '项目 B' }));
  assert.notStrictEqual(briefFingerprint(a), briefFingerprint(b));
});

test('brief: an empty view yields an empty brief (no crash, no fake content)', () => {
  const b = buildBrief(null);
  assert.strictEqual(b.text, '');
  assert.strictEqual(b.empty, true);
  const b2 = buildBrief({ mission: null });
  assert.strictEqual(b2.empty, true);
});

// --------------------------------------------------------------- 隐私

test('brief: never contains an absolute path or a raw session id', () => {
  const view = buildView([
    {
      seq: 2, type: 'deliverable.registered', atMs: 200,
      payload: {
        deliverableId: 'd1', missionId: 'mis-a', label: '报告',
        relPath: 'docs/r.md', digest: 'a'.repeat(32), registeredAtMs: 200,
      },
    },
  ], { lastSessionRef: 'sess-h-deadbeef' });
  const b = buildBrief(view);
  assert.doesNotMatch(b.text, /\/Users\//);
  assert.doesNotMatch(b.text, /session-[0-9a-f]{8}/i, 'raw session ids must never appear');
  // lastSessionRef **不出现**在 Brief 里是正确的：Brief 是给 Agent 的上下文，
  // 派生句柄对模型没有意义（它无法解析 sess-h-*），只会浪费预算。
  // 需要时由 harness-reader 单独提供，不进 Brief。
});
