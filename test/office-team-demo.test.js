'use strict';

// test/office-team-demo.test.js — 工作包 A：Electron 最小体验接通。
//
// 验证对象是**真实接线模块** `src/team/runtime/team-office-demo.js`（main.js 只是
// 它的 3 行调用点 + 一个默认关闭的门）。因此这里跑的是生产会走的同一条代码路径：
//
//   固定 Team 脚本 -> Team Runtime -> bridge -> office.ingestTeamProjectionFact
//     -> employee registry / reducer -> office 快照（renderer 消费的同一份）
//
// 不启动 Electron / DOM / Pixi：办公室用真实组合根（`createOfficeModule`），
// 驱动用 **pump() 原语**（生产里由一个 unref 的 50ms 开发定时器调用；本测试直接调
// 用它，因此确定、不依赖真实定时器），时钟用办公室自己的逻辑时钟。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const team = require('../src/team/runtime/index.js');
const {
  createTeamOfficeDemo,
  DEMO_SCRIPT_HAPPY,
  DEMO_SCRIPT_CANCEL,
  DEMO_SCRIPT_FAILED,
} = team;

const P = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
}).pack;
const { TICK_MS } = officeModule;
const SEATS = Object.freeze(['orchestrator', 'researcher', 'coder', 'reviewer', 'collaborator']);

function createOffice() {
  const logLines = [];
  const office = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'team-demo-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: (line) => logLines.push(line),
  });
  return { office, logLines };
}

/**
 * 用**原语** pump() 驱动跑满整条脚本：每推进一个办公室 tick 就 pump 一次。
 * 这正是生产里开发定时器所做的事（attach() 只是把 pump 挂到定时器上），
 * 因此这里跑的是同一条代码路径，但是确定性的（无真实定时器）。
 */
function runScript(office, script, maxMs = 20000) {
  const demo = createTeamOfficeDemo({ office, script, knownSeats: SEATS });
  for (let i = 0; i < Math.round(maxMs / TICK_MS); i += 1) {
    office.tickOnce();
    demo.pump();
    if (demo.summary().done) break;
  }
  return demo;
}

/** 推进到指定的办公室逻辑毫秒（每个 tick pump 一次）。 */
function runTo(office, demo, untilMs, maxMs = 30000) {
  for (let i = 0; i < Math.round(maxMs / TICK_MS); i += 1) {
    office.tickOnce();
    demo.pump();
    if (office.state().simulatedAtMs >= untilMs) break;
  }
}

const emp = (office, id) => office.state().employees.find((e) => e.employeeId === id);
const active = (office, id) => office.debugRegistrySnapshot().bindings
  .filter((b) => b.employeeId === id && b.releasedAt === null).length;
const allBindings = (office) => office.debugRegistrySnapshot().bindings;

// ===========================================================================
// 0. 门控与默认关闭（不影响普通启动）
// ===========================================================================

test('demo: the wiring is default-off and cannot affect a normal boot', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // 门：默认关闭（只有显式 '1' 才开）。
  assert.match(src, /function officeTeamDemoEnabled\(\) \{\s*return process\.env\.DSH_DESKTOP_OFFICE_TEAM_DEMO === '1';/);
  assert.match(src, /if \(!officeTeamDemoEnabled\(\)\) return null;/,
    'the attach is a no-op unless the gate is on');
  // 懒 require：门关闭时模块根本不被加载。
  assert.match(src, /const \{ createTeamOfficeDemo \} = require\('\.\/team\/runtime\/team-office-demo\.js'\);/);
  // 不新增 IPC：office:* 通道仍是 8 个。
  const channelBlock = /const OFFICE_IPC_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(
    fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8')
  );
  assert.ok(channelBlock, 'channel constant found');
  const channels = channelBlock[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.equal(channels.length, 8, 'no new office:* IPC channel');
  // 不伪造 Harness session：demo 模块不引用 harness 适配器 / office-module。
  const demo = fs.readFileSync(path.join(ROOT, 'src', 'team/runtime/team-office-demo.js'), 'utf8');
  assert.equal(/harness/i.test(demo.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')), false,
    'the demo must not touch the Harness layer');
  assert.equal(/require\(['"]\.\.\/\.\.\/office/.test(demo), false, 'the demo must not require office internals');
});

// ---------------------------------------------------------------------------
// Task B：定时器生命周期（用注入的 fake timer，**不依赖真实 50ms 等待**）
// ---------------------------------------------------------------------------

function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    __live: live,
    setInterval(fn, ms) {
      const handle = { id: nextId++, fn, ms };
      live.set(handle, true);
      return handle;
    },
    clearInterval(handle) { live.delete(handle); },
  };
}

test('demo: attach/detach lifecycle is deterministic with an injected timer seam', () => {
  const { office } = createOffice();
  const timers = fakeTimers();
  const demo = createTeamOfficeDemo({ office, knownSeats: SEATS, timers });

  // 初始：没有定时器
  assert.equal(demo.hasLiveTimer(), false);
  assert.equal(demo.describe().attached, false);
  assert.equal(timers.__live.size, 0);

  // attach：起一个 50ms 的 unref 定时器（fake 记录得到）
  assert.equal(demo.attach().ok, true);
  assert.equal(demo.hasLiveTimer(), true);
  assert.equal(timers.__live.size, 1, 'exactly one pump timer');
  const [[handle]] = [...timers.__live.entries()];
  assert.equal(handle.ms, 50);
  assert.equal(typeof handle.fn, 'function');

  // 重复 attach：幂等，**不**起第二个定时器
  assert.equal(demo.attach().code, 'ALREADY_ATTACHED');
  assert.equal(timers.__live.size, 1, 'no second timer');

  // detach：清定时器
  assert.equal(demo.detach().ok, true);
  assert.equal(demo.hasLiveTimer(), false);
  assert.equal(timers.__live.size, 0, 'the timer is cleared');
  assert.equal(demo.describe().attached, false);

  // 重复 detach：幂等
  assert.equal(demo.detach().code, 'NOT_ATTACHED');
  assert.equal(timers.__live.size, 0);
});

test('demo: after detach the timer callback can no longer pump (no background driver)', () => {
  const { office } = createOffice();
  const timers = fakeTimers();
  const demo = createTeamOfficeDemo({ office, knownSeats: SEATS, timers });
  demo.attach();
  const [[handle]] = [...timers.__live.entries()];
  demo.detach();
  // 即使有人还拿着旧的回调引用调用它，pump 计数也不该被后台驱动推进 ——
  // 唯一的驱动来源就是那个已被 clear 的定时器。
  const pumpsBefore = demo.summary().pumps;
  office.tickOnce();
  office.tickOnce();
  assert.equal(demo.summary().pumps, pumpsBefore, 'nothing pumps after detach');
  // 手动 pump 仍然可用（原语），但这与"后台驱动"是两件事。
  demo.pump();
  assert.equal(demo.summary().pumps, pumpsBefore + 1);
  void handle;
});

test('demo: the default timers are the real globals and are unref-ed (no process pinning)', () => {
  // 用真实全局定时器验证 attach/unref 行为，但**不等待**：立刻 detach。
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, knownSeats: SEATS });
  assert.equal(demo.attach().ok, true);
  assert.equal(demo.hasLiveTimer(), true);
  assert.equal(demo.detach().ok, true);
  assert.equal(demo.hasLiveTimer(), false);
});

test('demo: attach is idempotent and detach stops the driver', () => {
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, knownSeats: SEATS });
  assert.equal(demo.describe().attached, false, 'not attached before attach()');
  assert.equal(demo.attach().ok, true);
  assert.equal(demo.describe().attached, true);
  assert.equal(demo.attach().code, 'ALREADY_ATTACHED', 'attach is idempotent');
  // 驱动是一个 unref 的 50ms 定时器；同步 tick 期间它不会触发，所以这里断言的是
  // **驱动契约**（pump 是原语、定时器只是把它挂上去），而不是等真实定时器。
  assert.match(demo.describe().driver, /^dev-timer\(pump every \d+ms\)$/);
  office.tickOnce();
  demo.pump();
  assert.ok(demo.summary().pumps > 0, 'pump() is the primitive the timer calls');
  assert.equal(demo.detach().ok, true);
  assert.equal(demo.detach().code, 'NOT_ATTACHED');
  assert.equal(demo.describe().attached, false);
  const pumpsAfterDetach = demo.summary().pumps;
  for (let i = 0; i < 50; i += 1) { office.tickOnce(); demo.pump(); }
  assert.equal(demo.summary().pumps, pumpsAfterDetach + 50, 'pump stays callable after detach');
});

// ===========================================================================
// 1–8. 八项必须验证
// ===========================================================================

test('demo: (1,2) researcher starts on its seat and reviewer never appears early', () => {
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, script: DEMO_SCRIPT_HAPPY, knownSeats: SEATS });
  runTo(office, demo, 700);
  assert.equal(emp(office, 'researcher').runtime, 'running', 'researcher running on its seat');
  assert.equal(active(office, 'researcher'), 1);
  assert.equal(emp(office, 'researcher').taskLabel, '执行任务中');
  // reviewer 依赖未满足：office 侧零绑定（Office 没有自行判断依赖）
  assert.equal(active(office, 'reviewer'), 0);
  assert.equal(allBindings(office).filter((b) => b.releasedAt === null).length, 1,
    'exactly one seat is occupied while the dependency is unmet');
  // Team 侧此时也确实还没 dispatch reviewer
  assert.equal(demo.runtime.dispatchRun({ role: 'reviewer' }).code, 'DEPENDENCIES_UNSATISFIED');
});

test('demo: (3,4) attention holds, and resume keeps the same run and binding', () => {
  const { office } = createOffice();
  const demo = runScript(office, DEMO_SCRIPT_HAPPY);
  // 脚本在 6000ms 落 attention、9000ms 显式恢复；跑满后 reviewer 已 completed。
  assert.equal(demo.summary().done, true);
  const history = demo.summary().history;
  const attentionStep = history.find((s) => s.teamJobStatus === 'attention');
  assert.ok(attentionStep, 'the attention step is recorded in the structured evidence');
  assert.equal(attentionStep.office.find((e) => e.employeeId === 'reviewer').runtime, 'attention');
  // 恢复用的是同一个 run（脚本没有新建 WorkerRun）
  assert.equal(demo.runtime.state().runs.reviewer.attempt, 1);
  assert.equal(allBindings(office).filter((b) => b.employeeId === 'reviewer').length, 1,
    'resume created no second binding');
  // binding-created 副作用只执行一次（上一轮修的缺陷，这里再钉一次）
  assert.equal(office.state().activityLog.filter((e) => e.employeeId === 'reviewer' && e.kind === 'task-started').length, 1);
});

test('demo: (5) completed / failed / cancelled look different', () => {
  const happy = createOffice();
  runScript(happy.office, DEMO_SCRIPT_HAPPY);
  const failed = createOffice();
  runScript(failed.office, DEMO_SCRIPT_FAILED);
  const cancelled = createOffice();
  runScript(cancelled.office, DEMO_SCRIPT_CANCEL);

  // completed: 结果窗口里 celebrating + finished 表情
  {
    const g = createOffice();
    const demo = createTeamOfficeDemo({ office: g.office, knownSeats: SEATS });
    g.office.tickOnce(); demo.pump();
    demo.runtime.createJob({ jobId: 'x' });
    demo.runtime.dispatchRun({ role: 'researcher' });
    demo.runtime.startRun({ role: 'researcher' });
    demo.pump();
    for (let i = 0; i < Math.round(300 / TICK_MS); i += 1) { g.office.tickOnce(); demo.pump(); }
    demo.runtime.noteRunTerminal({ role: 'researcher', outcome: 'completed', evidence: 'turn/end:completed' });
    demo.pump();
    for (let i = 0; i < Math.round(120 / TICK_MS); i += 1) { g.office.tickOnce(); demo.pump(); }
    const w = emp(g.office, 'researcher');
    assert.equal(w.runtime, 'completed');
    assert.equal(w.activity, 'celebrating');
    assert.equal(w.animation.resource, 'finished');
  }
  // failed: error 表情，且 lastResult 是 failed
  {
    const g = createOffice();
    const demo = createTeamOfficeDemo({ office: g.office, script: DEMO_SCRIPT_FAILED, knownSeats: SEATS });
    demo.attach();
    for (let i = 0; i < Math.round(3400 / TICK_MS); i += 1) { g.office.tickOnce(); demo.pump(); if (demo.summary().done) break; }
    const w = emp(g.office, 'researcher');
    assert.equal(w.runtime, 'failed');
    assert.equal(w.animation.resource, 'error');
    assert.equal(w.lastResult.outcome, 'failed');
    assert.equal(demo.runtime.state().status, 'failed');
    // reviewer 从未启动
    assert.equal(active(g.office, 'reviewer'), 0);
    assert.equal(allBindings(g.office).filter((b) => b.employeeId === 'reviewer').length, 0);
  }
  // cancelled: 立即释放，lastResult 是 cancelled
  {
    const g = createOffice();
    const demo = createTeamOfficeDemo({ office: g.office, script: DEMO_SCRIPT_CANCEL, knownSeats: SEATS });
    demo.attach();
    for (let i = 0; i < Math.round(4200 / TICK_MS); i += 1) { g.office.tickOnce(); demo.pump(); if (demo.summary().done) break; }
    const w = emp(g.office, 'researcher');
    assert.equal(w.runtime, 'idle');
    assert.equal(w.lastResult.outcome, 'cancelled');
    assert.equal(active(g.office, 'researcher'), 0);
    assert.equal(demo.runtime.state().status, 'cancelled');
  }
  void happy; void failed; void cancelled;
});

test('demo: (6) cancel ack does not make the character leave early', () => {
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, script: DEMO_SCRIPT_CANCEL, knownSeats: SEATS });
  runTo(office, demo, 2600);
  assert.equal(emp(office, 'researcher').runtime, 'running', 'still running after ack');
  assert.equal(emp(office, 'researcher').control, 'cancellationPending');
  assert.equal(active(office, 'researcher'), 1, 'the seat is still occupied');
  assert.equal(emp(office, 'researcher').lastResult, null, 'no result yet');
  assert.equal(demo.runtime.state().runs.researcher.status, 'running');
  // 只有 terminal 才释放
  runTo(office, demo, 3800);
  assert.equal(active(office, 'researcher'), 0, 'terminal cancel released the seat');
  assert.equal(emp(office, 'researcher').lastResult.outcome, 'cancelled');
});

test('demo: (7) 30 seconds of office activity adds no Team fact', () => {
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, script: DEMO_SCRIPT_HAPPY, knownSeats: SEATS });
  runTo(office, demo, 14000);
  const factsBefore = demo.runtime.facts().length;
  const digestBefore = JSON.stringify(demo.runtime.digest());
  // 让办公室继续跑 30 秒（脚本早已跑完，期间只有本地行为/移动/动画）
  const states = new Set();
  for (let i = 0; i < Math.round(30000 / TICK_MS); i += 1) {
    office.tickOnce();
    for (const e of office.state().employees) states.add(`${e.employeeId}:${e.activity}:${e.movement}`);
  }
  assert.equal(demo.runtime.facts().length, factsBefore, 'no new Team fact in 30s');
  assert.equal(JSON.stringify(demo.runtime.digest()), digestBefore, 'Team digest unchanged');
  assert.ok(states.size > 3, `the office really was active (${states.size} distinct states)`);
});

test('demo: the Team fact log is EXACTLY the script projection — nothing else can author a fact', () => {
  // 这条是"动画/UI 永远不成为事实作者"的最强守卫：Team 日志必须是脚本的确定性投影。
  // 任何来自 office 快照、动画、UI 或第三方的注入都会让序列多出一项而失败。
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, script: DEMO_SCRIPT_HAPPY, knownSeats: SEATS });
  runTo(office, demo, 14000);
  assert.equal(demo.summary().done, true);
  assert.deepEqual(demo.runtime.facts().map((f) => f.type), [
    'job/created',
    'run/dispatched',
    'run/started',
    'artifact/available',
    'run/completed',
    'run/dispatched',
    'run/started',
    'run/attention',
    'job/attention',      // 收敛事实（自动派生）
    'run/started',        // 显式恢复
    'artifact/available',
    'run/completed',
    'job/completed',      // 收敛事实（自动派生）
  ], 'the Team log is the deterministic projection of the script');
  assert.equal(demo.runtime.facts().length, 13);
  // seq 连续且从 1 开始（事实身份稳定）
  demo.runtime.facts().forEach((f, i) => assert.equal(f.seq, i + 1));

  // 再从 office 侧注入一个**别的**事实源（模拟 Harness 事件 / UI 操作 / 动画回调）：
  // Team 日志必须一个字都不变。
  const before = JSON.stringify(demo.runtime.digest());
  office.ingestHarnessEvent({ sessionId: 'sess-other', type: 'turn/start', seq: 1, time: 1, data: {} });
  office.tickOnce();
  demo.pump();
  assert.equal(demo.runtime.facts().length, 13, 'a Harness event must not author a Team fact');
  assert.equal(JSON.stringify(demo.runtime.digest()), before, 'Team digest unchanged by office-side activity');
});

test('demo: (8) the snapshot carries no raw id, artifact content or path', () => {
  const { office } = createOffice();
  const demo = createTeamOfficeDemo({ office, script: DEMO_SCRIPT_HAPPY, knownSeats: SEATS });
  runTo(office, demo, 13000);
  // Office 表面（快照 + 诊断）绝不允许出现这些。
  const officeBlobs = [JSON.stringify(office.state()), JSON.stringify(office.diagnostics())];
  for (const forbidden of ['team-job-sha256:', 'team-run-sha256:', 'art:', 'run-sha256:',
    'research-notes', 'review-findings', 'prompt', '/Users/']) {
    for (const blob of officeBlobs) {
      assert.equal(blob.includes(forbidden), false, `office surface leaked ${forbidden}`);
    }
  }
  // demo/bridge 摘要是**桥自己的只读诊断面**（不是 office 表面）：允许出现白名单
  // artifact kind（计数），但**不允许**出现任何 id。这条边界本身要被钉住。
  const demoBlob = JSON.stringify(demo.summary());
  for (const forbidden of ['team-job-sha256:', 'team-run-sha256:', 'art:', 'run-sha256:', 'prompt', '/Users/']) {
    assert.equal(demoBlob.includes(forbidden), false, `demo summary leaked ${forbidden}`);
  }
  assert.deepEqual(demo.summary().bridge.artifactKinds, { 'research-notes': 1, 'review-findings': 1 },
    'the bridge summary carries only the whitelisted kind COUNTS');
  // 员工绑定投影只有 source/confidence
  const researcher = emp(office, 'researcher');
  if (researcher.binding) assert.deepEqual(Object.keys(researcher.binding).sort(), ['confidence', 'source']);
});

// ===========================================================================
// 结构化快照证据（写到 tmpdir，供报告引用；测试本身不断言文件内容）
// ===========================================================================

test('demo: emits a structured snapshot evidence file for the report', () => {
  const out = [];
  for (const [name, script] of [['happy', DEMO_SCRIPT_HAPPY], ['failed', DEMO_SCRIPT_FAILED], ['cancel', DEMO_SCRIPT_CANCEL]]) {
    const { office } = createOffice();
    const demo = runScript(office, script);
    out.push({
      scenario: name,
      scriptSteps: script.length,
      teamJobStatus: demo.runtime.state().status,
      teamFacts: demo.runtime.facts().map((f) => `${f.seq}:${f.type}`),
      bridge: demo.summary().bridge,
      bindings: office.debugRegistrySnapshot().bindings.map((b) => `${b.employeeId}:${b.releasedAt === null ? 'active' : 'released'}`).sort(),
      employees: office.state().employees.map((e) => `${e.employeeId}:${e.runtime}/${e.activity}`),
      steps: demo.summary().history,
    });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-demo-evidence-'));
  const file = path.join(dir, 'team-office-demo-snapshots.json');
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  assert.ok(fs.statSync(file).size > 500, 'evidence file written');
  // 三个场景都收敛到各自的终态
  assert.deepEqual(out.map((o) => o.teamJobStatus), ['completed', 'failed', 'cancelled']);
  // happy 路径零拒绝
  assert.equal(out[0].bridge.counters.rejected, 0);
  assert.equal(out[0].bridge.counters.officeRejected, 0);
});
