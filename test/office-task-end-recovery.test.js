'use strict';

// 2026-09-25 收尾状态修复 — 用户实测"任务结束后员工不回状态"回归组。
//
// 长稳探针（office-soak，2026-09-25 座位复现）钉出的事故链：
//   1. 同一会话的下一个 turn/start（子代理 settlement 触发的父会话续 turn）落在
//      上一轮的 result 呈现窗口内 → running 事实把 activity 拉回 working，而
//      pendingTerminal/resultUntilMs 未被取消，绑定停在 releasing；
//   2. 过期的呈现 _timer 在新 turn 中途触发 commitReleasedTerminal → 绑定被释放，
//      transition/complete 因 runtime=running 被减少器拒绝 → 座位卡在
//      working/未绑定（实测约 50s，movement 还是 moving）；
//   3. 该 turn 的 turn/end 因"无活动绑定"被整体丢弃 → 永不呈现、永不回收。
// 本组钉死三条不变量 + 一条壳日志契约：
//   ① turn 结束后 resultPresentationMs 内回到本地行为（含"子代理仍在跑"与
//      "下一 turn 在呈现窗口内开始"两个变体）；
//   ② celebrating 期间 movement 不得是 moving；
//   ③ 绑定已释放（registry 无活动绑定）时 activity 不得停在任务态
//      （working/thinking/waiting/celebrating）——取消路径同步归位；
//   ④ 每个子代理座位事件在壳日志留一行（id=/seat=/label=）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const { createSubagentWiring } = require('../src/office/runtime/subagent-wiring.js');
const { classifySubagent } = require('../src/office/runtime/subagent-classifier.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const PRESENTATION_MS = 300;
const LOCAL_ACTIVITIES = ['roaming', 'chatting', 'resting', 'sleeping'];
const TASK_ACTIVITIES = ['working', 'thinking', 'waiting', 'celebrating'];

function makeModule(config = {}) {
  return officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-task-end-recovery-seed',
    config: { resultPresentationMs: PRESENTATION_MS, workstationAnchorSegmentMs: 160, ...config },
  });
}

function tickFor(module, ms) {
  const steps = Math.round(ms / officeModule.TICK_MS);
  const samples = [];
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    samples.push(orch(module));
  }
  return samples;
}

function tickUntil(module, predicate, maxMs = 120000) {
  const steps = Math.round(maxMs / officeModule.TICK_MS);
  for (let i = 0; i < steps; i += 1) {
    module.tickOnce();
    if (predicate(module.state())) return true;
  }
  return false;
}

function orch(module) {
  return module.state().employees.find((e) => e.employeeId === 'orchestrator');
}

function bound(module) {
  // registry 视角的"绑定未释放"（快照 binding 字段非 null）
  return orch(module).binding !== null;
}

function assertLocalWhileUnbound(samples, context) {
  for (const o of samples) {
    if (o.binding === null) {
      assert.ok(
        LOCAL_ACTIVITIES.includes(o.activity),
        `${context}: unbound seat must show local behavior, got ${o.activity}/${o.movement}`
      );
    }
  }
}

function parkAtRoamNode(module) {
  const roamNodes = module.layout.nodes().filter((n) => n.tags.includes('roaming') && /^roam-/.test(n.id));
  const parked = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.movement === 'stationary'
      && roamNodes.some((n) => Math.hypot(o.position.x - n.position.x, o.position.y - n.position.y) < 0.02);
  });
  assert.equal(parked, true, 'precondition: orchestrator dwells at a roaming node');
}

// ---- ① turn 结束后必须回到本地行为 -----------------------------------------

test('recovery: orchestrator returns to local behavior within resultPresentationMs after turn end', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  module.ingestHarnessEvent({ sessionId: 'sess-rec', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const seated = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.transition && o.transition.kind === 'task-start' && o.transition.phase === 'work';
  });
  assert.equal(seated, true, 'precondition: orchestrator reached the work phase');

  module.ingestHarnessEvent({ sessionId: 'sess-rec', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const during = tickFor(module, PRESENTATION_MS);
  assert.ok(during.some((o) => o.activity === 'celebrating'), 'result presentation plays');
  const recovered = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return LOCAL_ACTIVITIES.includes(o.activity);
  }, PRESENTATION_MS + 200);
  assert.equal(recovered, true, 'local behavior resumes right after the presentation window');
  assertLocalWhileUnbound(tickFor(module, 2000), 'plain recovery');
});

test('recovery: next turn starting DURING the presentation window never wedges the seat (soak 2026-09-25)', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  module.ingestHarnessEvent({ sessionId: 'sess-wedge', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const moving = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.movement === 'moving';
  });
  assert.equal(moving, true, 'precondition: task walk in flight');

  // turn A ends mid-walk; its presentation window opens
  module.ingestHarnessEvent({ sessionId: 'sess-wedge', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  assert.equal(orch(module).activity, 'celebrating', 'presentation armed');

  // turn B starts while turn A's presentation is still armed (no ticks between)
  module.ingestHarnessEvent({ sessionId: 'sess-wedge', type: 'agent/status', seq: 3, time: 3, data: { status: 'running' } });
  assert.ok(bound(module), 'turn B binds (possibly a derived turn-scoped handle)');

  // the stale presentation timer must NOT release turn B's binding mid-turn:
  // sample every tick across the old window and well past it
  const samples = tickFor(module, PRESENTATION_MS + 1000);
  assertLocalWhileUnbound(samples, 'stale-window overlap');

  // turn B ends: it must present and recover (pre-fix it was dropped entirely —
  // the seat sat at working/unbound for ~50s in the soak)
  module.ingestHarnessEvent({ sessionId: 'sess-wedge', type: 'turn/end', seq: 4, time: 4, data: { reason: 'completed' } });
  const recovered = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return LOCAL_ACTIVITIES.includes(o.activity);
  }, PRESENTATION_MS + 400);
  assert.equal(recovered, true, 'turn B presentation commits and local behavior resumes');
  assert.ok(
    module.state().activityLog.some((e) => e.kind === 'result-superseded'),
    'the supersede is observable in the activity log'
  );
  assertLocalWhileUnbound(tickFor(module, 2000), 'post-wedge recovery');
});

test('recovery: orchestrator recovers while a classified subagent seat is still working', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  const PARENT = 'sess-parent-sub';
  module.ingestHarnessEvent({ sessionId: PARENT, type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  // classified subagent takes the researcher seat and keeps working
  module.ingestHarnessEvent({
    sessionId: PARENT, type: 'subagent/start', seq: 2, time: 2,
    data: { id: 'child-still-running', runId: 'child-still-running', mode: 'one-shot', role: 'researcher' },
  });
  const researcherWorking = tickUntil(module, (state) => {
    const r = state.employees.find((e) => e.employeeId === 'researcher');
    return r && r.activity === 'working' && r.binding !== null;
  });
  assert.equal(researcherWorking, true, 'precondition: researcher seat bound and working');

  module.ingestHarnessEvent({ sessionId: PARENT, type: 'turn/end', seq: 3, time: 3, data: { reason: 'completed' } });
  const recovered = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return LOCAL_ACTIVITIES.includes(o.activity);
  }, PRESENTATION_MS + 400);
  assert.equal(recovered, true, 'orchestrator returns to local behavior within the presentation window');
  const researcher = module.state().employees.find((e) => e.employeeId === 'researcher');
  assert.equal(researcher.activity, 'working', 'the subagent seat keeps working');
  assert.ok(researcher.binding !== null, 'the subagent binding is untouched by the parent release');
  assertLocalWhileUnbound(tickFor(module, 2000), 'parent recovery with subagent running');
});

// ---- ② celebrating 不得与 moving 并存 ---------------------------------------

test('invariant: movement is never moving while celebrating (short turn ends mid-walk)', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  module.ingestHarnessEvent({ sessionId: 'sess-short', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const moving = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.movement === 'moving';
  });
  assert.equal(moving, true, 'precondition: walk-to-seat in flight when the turn ends');

  module.ingestHarnessEvent({ sessionId: 'sess-short', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  const samples = tickFor(module, PRESENTATION_MS + 100);
  const celebrated = samples.some((o) => o.activity === 'celebrating');
  assert.equal(celebrated, true, 'the result presentation still plays');
  for (const o of samples) {
    assert.ok(
      !(o.activity === 'celebrating' && o.movement === 'moving'),
      `celebrating must not coexist with moving (got ${o.activity}/${o.movement})`
    );
  }
  const recovered = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return LOCAL_ACTIVITIES.includes(o.activity);
  }, PRESENTATION_MS + 400);
  assert.equal(recovered, true, 'degraded end (never reached the seat) still recovers');
});

// ---- ③ bound=False ⇒ activity 不是任务态 ------------------------------------

test('invariant: a cancelled turn leaves the seat unbound AND out of task activities immediately', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  module.ingestHarnessEvent({ sessionId: 'sess-cancel', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const seated = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.transition && o.transition.kind === 'task-start' && o.transition.phase === 'work';
  });
  assert.equal(seated, true, 'precondition: working at the seat when the turn is cancelled');

  module.ingestHarnessEvent({ sessionId: 'sess-cancel', type: 'turn/end', seq: 2, time: 2, data: { reason: 'cancelled' } });
  const rightAfter = orch(module);
  assert.equal(rightAfter.binding, null, 'the binding is released synchronously');
  assert.ok(
    LOCAL_ACTIVITIES.includes(rightAfter.activity),
    `unbound seat must not rest on a task activity, got ${rightAfter.activity}`
  );
  assertLocalWhileUnbound(tickFor(module, 2000), 'after cancel');
});

test('invariant: unbound ⇒ local activity holds across a full task lifecycle sample', () => {
  const module = makeModule();
  parkAtRoamNode(module);
  module.ingestHarnessEvent({ sessionId: 'sess-full', type: 'agent/status', seq: 1, time: 1, data: { status: 'running' } });
  const seated = tickUntil(module, (state) => {
    const o = state.employees.find((e) => e.employeeId === 'orchestrator');
    return o && o.transition && o.transition.kind === 'task-start' && o.transition.phase === 'work';
  });
  assert.equal(seated, true);
  module.ingestHarnessEvent({ sessionId: 'sess-full', type: 'turn/end', seq: 2, time: 2, data: { reason: 'completed' } });
  // walk the whole recovery out (presentation + stand-up + leave route) sampling
  // every tick: whenever the registry binding is gone the activity must be local
  const samples = tickFor(module, PRESENTATION_MS + 8000);
  assertLocalWhileUnbound(samples, 'full lifecycle');
  const finalSamples = samples.slice(-20);
  assert.ok(
    finalSamples.every((o) => LOCAL_ACTIVITIES.includes(o.activity)),
    'the employee ends the lifecycle in local behavior'
  );
});

// ---- ④ 子代理座位事件的壳日志契约 -------------------------------------------

test('shell-log contract: every subagent seat event leaves one diagnosable line (id=/seat=/label=)', () => {
  const logs = [];
  const emitted = [];
  const wiring = createSubagentWiring({
    emit: (sessionId, event) => emitted.push({ sessionId, event }),
    log: (line) => logs.push(line),
  });
  wiring.handleEvent('sess-log', {
    type: 'subagent/catalog', seq: 1, time: 1,
    data: { version: 0, childId: 'child-log-1', childCreatedAt: 1, mode: 'one-shot', label: '深度研究竞品\n第二行' },
  });
  wiring.handleEvent('sess-log', {
    type: 'user/message', seq: 2, time: 2,
    data: { source: { kind: 'subagent-settled', senderSessionId: 'child-log-1', summary: 'finished and will do no further work' } },
  });
  const startLine = logs.find((l) => l.includes('[office] subagent start'));
  const endLine = logs.find((l) => l.includes('[office] subagent end'));
  assert.ok(startLine, 'a start line exists');
  assert.match(startLine, /\[office\] subagent start id=child-lo/, 'start line carries the child id');
  assert.match(startLine, /seat=researcher/, 'start line names the seat');
  assert.match(startLine, /mode=one-shot/, 'start line names the mode');
  assert.match(startLine, /label="深度研究竞品 第二行"/, 'start line carries the bounded single-line label');
  assert.ok(endLine, 'an end line exists');
  assert.match(endLine, /\[office\] subagent end id=child-lo/, 'end line carries the child id');
  assert.match(endLine, /reason=completed via=subagent-settled/, 'end line carries the stop reason and source');

  // the SHELL must wire the log seam: main.js passes its shell `log` into the
  // wiring (static contract — the seat story must land in the shell log file)
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const wiringSrc = fs.readFileSync(path.join(ROOT, 'src', 'office', 'runtime', 'subagent-wiring.js'), 'utf8');
  assert.match(mainSrc, /createSubagentWiring\(\{[\s\S]*?log: \(line\) => log\(line\)/, 'main.js feeds the shell log into the wiring');
  assert.match(wiringSrc, /subagent start id=/, 'the wiring emits the id=/seat= start line');
  assert.match(wiringSrc, /subagent end id=/, 'the wiring emits the id= end line');
});

// ---- ⑤ 分类器 label → 座位对照表 --------------------------------------------

test('classifier: label -> seat reference table (incl. Chinese labels, 2026-09-25 extension)', () => {
  // [label, expected seat, classified] — 每行一张"这轮子代理会坐哪"的对照
  const TABLE = [
    // reviewer（评审/质检）
    ['review the diff', 'reviewer', true],
    ['verify the migration result', 'reviewer', true],
    ['check the implementation', 'reviewer', true], // 2026-09-25 扩充: check
    ['检查代码', 'reviewer', true], // 2026-09-25 扩充: 检查
    ['审核合同条款', 'reviewer', true],
    // coder（编码/实现）
    ['implement the parser', 'coder', true],
    ['编码实现导出功能', 'coder', true],
    ['optimize the hot loop', 'coder', true], // 2026-09-25 扩充: optimize
    ['性能优化', 'coder', true], // 2026-09-25 扩充: 优化
    ['migrate the schema', 'coder', true], // 2026-09-25 扩充: migrate
    ['数据库迁移', 'coder', true], // 2026-09-25 扩充: 迁移
    // researcher（调研/检索）
    ['deep research the vendor landscape', 'researcher', true], // 深度研究类
    ['深度研究竞品格局', 'researcher', true],
    ['triage the failing suites', 'researcher', true], // 2026-09-25 扩充: triage
    ['排查失败原因', 'researcher', true], // 2026-09-25 扩充: 排查
    ['定位性能瓶颈', 'researcher', true], // 2026-09-25 扩充: 定位
    ['gather sources', 'researcher', true],
    // fail-closed → collaborator（既有契约不放宽）
    ['summarize the findings', 'collaborator', false], // 被 fail-closed 契约显式钉住
    ['与用户头脑风暴', 'collaborator', false],
    ['encode the payload', 'collaborator', false], // 词边界：code 不咬 encode
    ['prefix normalization', 'collaborator', false], // fix 不咬 prefix
    ['barcode scan', 'collaborator', false], // code 不咬 barcode
    ['', 'collaborator', false],
    [undefined, 'collaborator', false],
  ];
  for (const [label, seat, classified] of TABLE) {
    const verdict = classifySubagent({ label });
    assert.equal(verdict.employeeId, seat, `label=${JSON.stringify(label)}`);
    assert.equal(verdict.classified, classified, `label=${JSON.stringify(label)}`);
  }
});
