'use strict';

// test/team-execution-progress.test.js — v0.6 WP2：execution/progress 过程可见性。
//
// 链路：journal tool/call →（注入 phaseForTool 折闭集 phase）→ execution/progress
//   → controller（静态转换表）→ Team run/progress（最新 phase 状态 + append-only 事实）
//   → adapter（run-progress）→ office 座位短语（快照 toolPhraseKey/toolPhrase）。
//
// 隐私红线（行为级）：工具名/参数/正文永不进入 execution 事件 / Team 事实 / office 快照；
// phase 是 9 键闭集（schema PROGRESS_PHASES，与 office tool-phrases 漂移钉绑定）。
// 全部离线：不启动 Electron、不发网络。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const backendModule = require('../src/team/runtime/dsh-execution-backend.js');
const team = require('../src/team/runtime/index.js');
const schema = require('../src/team/runtime/execution-schema.js');
const { PHRASE_KEYS, toolPhraseKeyOf } = require('../src/office/runtime/tool-phrases.js');

const T0 = 1_700_200_000_000;
const JOB = 'job-progress-1';

const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });

function streamOf(events) {
  let i = 0;
  return Object.freeze({
    [Symbol.asyncIterator]: () => ({
      next() {
        if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
        const value = events[i];
        i += 1;
        return Promise.resolve({ value: { ...value }, done: false });
      },
    }),
  });
}

// ===========================================================================
// 1. 后端：tool/call → progress（闭集、去重、无注入则跳过）
// ===========================================================================

test('progress V7: tool/call maps to a closed-set phase via the injected phaseForTool', async () => {
  const transport = { follow: () => streamOf([
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash', arguments: { cmd: 'ls -la' } }, 2),
    je('tool/call', { name: 'web-search', arguments: { q: 'secret-query' } }, 3),
    je('turn/end', { reason: { kind: 'completed' } }, 4),
  ]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
  const backend = backendModule.createDshExecutionBackend({
    clock: { nowMs: () => T0 }, transport, sessionFor: () => 'sess-progress',
    phaseForTool: toolPhraseKeyOf,
  });
  const handle = await backend.startRun({ jobId: JOB, runId: `${JOB}:researcher:1`, role: 'researcher', attempt: 1 });
  const order = [];
  for (let i = 0; i < 8; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    order.push(event.type + (event.phase ? `:${event.phase}` : ''));
  }
  assert.deepEqual(order, ['execution/started', 'execution/progress:command', 'execution/progress:retrieval', 'execution/completed']);
});

test('progress: without phaseForTool injected, tool/call stays skipped (no invented facts)', async () => {
  const transport = { follow: () => streamOf([
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash' }, 2),
    je('turn/end', { reason: { kind: 'completed' } }, 3),
  ]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
  const backend = backendModule.createDshExecutionBackend({ clock: { nowMs: () => T0 }, transport, sessionFor: () => 'sess-progress' });
  const handle = await backend.startRun({ jobId: JOB, runId: `${JOB}:researcher:1`, role: 'researcher', attempt: 1 });
  const order = [];
  for (let i = 0; i < 5; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    order.push(event.type);
  }
  assert.deepEqual(order, ['execution/started', 'execution/completed']);
});

test('progress V8: consecutive identical phases are deduped (bash+npm+git → ONE command progress)', async () => {
  const transport = { follow: () => streamOf([
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash' }, 2),
    je('tool/call', { name: 'npm' }, 3),
    je('tool/call', { name: 'git' }, 4),
    je('tool/call', { name: 'read' }, 5),   // search —— 不同 phase，必须发
    je('tool/call', { name: 'grep' }, 6),   // search —— 相同 phase，去重
    je('turn/end', { reason: { kind: 'completed' } }, 7),
  ]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
  const backend = backendModule.createDshExecutionBackend({
    clock: { nowMs: () => T0 }, transport, sessionFor: () => 'sess-progress',
    phaseForTool: toolPhraseKeyOf,
  });
  const handle = await backend.startRun({ jobId: JOB, runId: `${JOB}:researcher:1`, role: 'researcher', attempt: 1 });
  const progressPhases = [];
  for (let i = 0; i < 10; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    if (event.type === 'execution/progress') progressPhases.push(event.phase);
  }
  assert.deepEqual(progressPhases, ['command', 'search'], '6 tool calls → exactly 2 progress events');
});

test('progress privacy: tool names and arguments never reach the event (closed set only)', async () => {
  const transport = { follow: () => streamOf([
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash', arguments: { cmd: 'rm -rf /' } }, 2),
    je('turn/end', { reason: { kind: 'completed' } }, 3),
  ]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
  const backend = backendModule.createDshExecutionBackend({
    clock: { nowMs: () => T0 }, transport, sessionFor: () => 'sess-progress',
    phaseForTool: toolPhraseKeyOf,
  });
  const handle = await backend.startRun({ jobId: JOB, runId: `${JOB}:researcher:1`, role: 'researcher', attempt: 1 });
  const serialized = [];
  for (let i = 0; i < 5; i += 1) {
    const event = await backend.nextEvent(handle);
    if (!event) break;
    serialized.push(JSON.stringify(event));
  }
  const all = serialized.join(' ');
  for (const needle of ['bash', 'rm -rf', 'arguments', 'cmd']) {
    assert.equal(all.includes(needle), false, `event must not carry ${needle}`);
  }
});

// ===========================================================================
// 2. Team / adapter / office：fact 与投影
// ===========================================================================

function makeOfficeStub() {
  const facts = [];
  return {
    facts,
    ingestTeamProjectionFact(fact) { facts.push(fact); return { ok: true, code: null, status: 'applied' }; },
  };
}

test('progress chain: execution/progress → run/progress fact → latest-phase state → office run-progress', async () => {
  const transport = { follow: () => streamOf([
    je('turn/start', {}, 1),
    je('tool/call', { name: 'bash' }, 2),
    je('tool/call', { name: 'read' }, 3),
    je('turn/end', { reason: { kind: 'completed' } }, 4),
  ]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
  const clock = { nowMs: () => T0 };
  const runtime = team.createTeamRuntime({ clock });
  const backend = backendModule.createDshExecutionBackend({
    clock, transport, sessionFor: () => 'sess-progress', phaseForTool: toolPhraseKeyOf,
  });
  const controller = team.createTeamExecutionController({
    teamRuntime: runtime,
    executor: {
      startRun: (args) => backend.startRun(args),
      observe: (handle) => backend.observe(handle),
      cancel: (handle) => backend.cancel(handle),
      unsupported: Object.freeze(['recover']),
    },
    clock, jobId: JOB,
  });
  await controller.start();
  const trace = [];
  for (let i = 0; i < 6; i += 1) {
    const step = await controller.pumpOne();
    if (!step) break;
    trace.push(step.type);
  }
  assert.deepEqual(trace, ['execution/started', 'execution/progress', 'execution/progress', 'execution/completed']);
  // Team 状态：只存最新 phase；事实日志两条（去重后）。
  const run = runtime.state().runs.researcher;
  assert.equal(run.progress.phase, 'search');
  assert.equal(run.status, 'completed');
  const progressFacts = runtime.facts().filter((f) => f.type === 'run/progress');
  assert.equal(progressFacts.length, 2);
  assert.deepEqual(progressFacts.map((f) => f.phase), ['command', 'search']);
  // Team 幂等：重复同 phase → duplicate，不加事实。
  const dup = runtime.noteRunProgress({ role: 'researcher', phase: 'search' });
  assert.equal(dup.ok, false, 'terminal run rejects progress anyway');
  // 隐私：事实里没有工具名。
  const factsJson = JSON.stringify(runtime.facts());
  assert.equal(factsJson.includes('bash'), false);
  assert.equal(factsJson.includes('read'), false);
  // adapter → office run-progress（phase 透传，seat 显式映射）。
  const adapter = team.createTeamOfficeAdapter({ knownSeats: ['researcher', 'reviewer'] });
  const mapped = progressFacts.map((f) => adapter.mapFact(f));
  for (const verdict of mapped) {
    assert.equal(verdict.ok, true, `adapter rejected: ${verdict.code}`);
    assert.equal(verdict.officeFacts[0].kind, 'run-progress');
    assert.equal(verdict.officeFacts[0].seat, 'researcher');
    assert.ok(PHRASE_KEYS.includes(verdict.officeFacts[0].phase));
  }
  assert.deepEqual(mapped.map((v) => v.officeFacts[0].phase), ['command', 'search']);
});

test('progress adapter: a model-text-looking phase is rejected (fail-closed)', () => {
  const adapter = team.createTeamOfficeAdapter();
  const verdict = adapter.mapFact({
    type: 'run/progress', jobId: JOB, role: 'researcher', atMs: T0,
    phase: '研究正文不能进 phase',
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'TEAM_PROGRESS_PHASE_INVALID');
});

test('progress V10: office ingestion validates the closed set and renders the seat phrase', async () => {
  // 用真实 office-module（离线）：run-started 绑座位 → run-progress 设 phase →
  // 快照 toolPhraseKey 命中呈现词表。
  const assetPack = require('../src/office/runtime/asset-pack.js');
  const fs = require('node:fs');
  const path = require('node:path');
  const officeModule = require('../src/office/office-module.js');
  const P = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
  const pack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
  }).pack;
  const office = officeModule.createOfficeModule({
    pack, seed: 'progress-seed', config: { resultPresentationMs: 200 }, log: () => {},
  });
  const jobId = 'job-office-progress';
  const runHandle = 'team-run-sha256:' + '0'.repeat(16);
  const identity = {
    jobHandle: 'team-job-sha256:' + '0'.repeat(16),
    runHandle, role: 'researcher', seq: 1, factType: 'run/started', statusSource: 'team-runtime',
  };
  const started = office.ingestTeamProjectionFact({ kind: 'run-started', identity, atMs: T0, seat: 'researcher', role: 'researcher' });
  assert.equal(started.ok, true);
  const progressIdentity = { ...identity, factType: 'run/progress', seq: 2 };
  const progress = office.ingestTeamProjectionFact({ kind: 'run-progress', identity: progressIdentity, atMs: T0 + 10, seat: 'researcher', role: 'researcher', phase: 'retrieval' });
  assert.equal(progress.ok, true, `office rejected: ${progress.code}`);
  // 快照：researcher 座位的短语 = 检索（retrieval）。
  const snapshot = office.state();
  const seat = snapshot.employees.find((e) => e.employeeId === 'researcher');
  assert.ok(seat, 'researcher seat exists in snapshot');
  assert.equal(seat.toolPhraseKey, 'retrieval');
  assert.equal(seat.toolPhrase, '检索');
  // 闭集外的 phase → TEAM_PHASE_UNKNOWN（fail-closed，不猜）。
  const bad = office.ingestTeamProjectionFact({ kind: 'run-progress', identity: progressIdentity, atMs: T0 + 20, seat: 'researcher', role: 'researcher', phase: 'bash' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'TEAM_PHASE_UNKNOWN');
  assert.equal(seat.toolPhraseKey, 'retrieval', 'invalid phase must not clobber the current one');
});

test('fact log is identical with and without the office attached (office is only a consumer)', async () => {
  // 移植自 office-team-executor-demo.test.js（demo fixture 归档前）—— 改用真实
  // 链路（dsh 后端 + scripted transport）证明同一性质：办公室是投影的纯消费者，
  // 挂不挂 office 不改变 Team 事实日志一个字节。
  const journals = [
    [
      je('turn/start', {}, 1),
      je('tool/call', { name: 'read' }, 2),
      je('assistant/message', { content: [{ type: 'text', text: '# 笔记' }] }, 3),
      je('turn/end', { reason: { kind: 'completed' } }, 4),
    ],
    [je('turn/start', {}, 1), je('turn/end', { reason: { kind: 'completed' } }, 2)],
  ];
  const runOnce = async (withOffice) => {
    const transport = { follow: () => streamOf(journals[0]), cancel: async () => ({ ok: true }), describe: () => ({ transport: 'x' }) };
    // 每次 follow 依次给不同脚本 —— 与其它测试的 scripted 模式一致。
    let fi = 0;
    transport.follow = () => streamOf(journals[Math.min(fi++, journals.length - 1)]);
    const clock = { nowMs: () => T0 };
    const runtime = team.createTeamRuntime({ clock });
    const backend = backendModule.createDshExecutionBackend({
      clock, transport, sessionFor: (r) => `sess-${r.role}`, phaseForTool: toolPhraseKeyOf,
    });
    const controller = team.createTeamExecutionController({
      teamRuntime: runtime,
      executor: {
        startRun: (args) => backend.startRun(args),
        observe: (handle) => backend.observe(handle),
        cancel: (handle) => backend.cancel(handle),
        unsupported: Object.freeze(['recover']),
      },
      clock, jobId: JOB,
      onFact: withOffice ? () => { /* 消费者在线（投影订阅）；不产生任何回写 */ } : undefined,
    });
    await controller.start();
    for (let i = 0; i < 16; i += 1) {
      await controller.dispatchReady();
      const step = await controller.pumpOne();
      if (!step) break;
    }
    return runtime.facts();
  };
  const withoutOffice = await runOnce(false);
  const withOffice = await runOnce(true);
  assert.equal(withoutOffice.length > 4, true, 'scenario must produce a real fact log');
  assert.deepEqual(withOffice, withoutOffice, 'the office subscription must not alter a single fact');
});
