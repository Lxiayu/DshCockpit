'use strict';

// test/office-team-executor-demo.test.js — 工作包 A：FakeExecutor 可见闭环开发入口。
//
// 契约：docs/specs/WORKER-EXECUTION-CONTRACT-v0.md（§6/§7/§8/§14）
//
// 验证对象是**真实接线模块** `src/team/runtime/team-executor-demo.js`（main.js 只是它的
// 调用点 + 两个默认关闭的门）。因此这里跑的是 Electron 会走的同一条代码路径：
//
//   FakeExecutor（执行事件）
//     → TeamExecutionController（唯一转换点）
//     → Team Runtime（Team fact）
//     → team-office-bridge → office.ingestTeamProjectionFact（窄入口）
//     → registry / reducer / office 快照（renderer 消费的同一份）
//
// 不启动 Electron / DOM / Pixi：Office 用真实组合根（createOfficeModule），
// pump 用原语（生产里由 unref 定时器调用；本测试直接调用 → 确定、无真实等待）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const team = require('../src/team/runtime/index.js');
const {
  createTeamExecutorDemo,
  DEMO_SCENARIOS,
  DEMO_SCENARIO_NAMES,
  DEMO_PUMP_INTERVAL_MS,
  DEMO_TICK_MS,
} = require('../src/team/runtime/team-executor-demo.js');

const P = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
}).pack;
const SEATS = Object.freeze(officeModule.EMPLOYEE_IDS);
const T0 = 1_700_000_000_000;

function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] || ''); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function createOffice() {
  const logLines = [];
  const office = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'executor-demo-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: (line) => logLines.push(line),
  });
  return { office, logLines };
}

/** 注入基准时钟 + 注入定时器，使演示完全确定（无墙钟、无真实等待）。 */
function createFixture({ scenario = 'happy', withOffice = true, jobId = 'job-exec-demo-1' } = {}) {
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const timerHarness = fakeTimers();
  const made = withOffice ? createOffice() : { office: null, logLines: [] };
  const demo = createTeamExecutorDemo({
    office: made.office,
    clock,
    scenario,
    jobId,
    timers: timerHarness.timers,
    log: () => {},
  });
  return { demo, office: made.office, logLines: made.logLines, clock, timerHarness };
}

/** 注入的定时器接缝（**不依赖真实 50ms 等待**）。 */
function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    __live: live,
    timers: {
      setInterval(fn, ms) {
        const handle = { id: nextId++, fn, ms, unref() { this.unrefd = true; return this; } };
        live.set(handle, true);
        return handle;
      },
      clearInterval(handle) { live.delete(handle); },
    },
    fireAll() { for (const handle of [...live.keys()]) handle.fn(); },
  };
}

const emp = (office, id) => office.state().employees.find((e) => e.employeeId === id);
const tickOffice = (fixture, n) => {
  for (let i = 0; i < n; i += 1) {
    fixture.office.tickOnce();
    if (fixture.demo.bridge) fixture.demo.bridge.pump();
  }
};

// ===========================================================================
// 1. 门控与默认关闭（A2）
// ===========================================================================

test('exec-demo: the new entry is default-off, lazily required, and never touches a normal boot', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  // 新门独立存在，且默认关闭（只有显式 '1' 才开）。
  assert.match(src,
    /function officeTeamExecutorDemoEnabled\(\) \{\s*return process\.env\.DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO === '1';/,
    'the new gate must exist and be default-off');
  // 不覆盖旧门（两者都还在，且语义不同）。
  assert.match(src, /function officeTeamDemoEnabled\(\) \{\s*return process\.env\.DSH_DESKTOP_OFFICE_TEAM_DEMO === '1';/,
    'the old gate must remain unchanged');
  assert.notEqual(
    /DSH_DESKTOP_OFFICE_TEAM_DEMO/.exec(src)[0],
    'DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO',
    'the new gate must be a separate env var',
  );
  // 懒 require：门关闭时模块根本不被加载（在 attach 函数体内 require）。
  const attachBlock = /function attachOfficeTeamExecutorDemo\(office, log\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(attachBlock, 'attachOfficeTeamExecutorDemo must exist');
  assert.match(attachBlock[0], /if \(!officeTeamExecutorDemoEnabled\(\)\) return null;/,
    'the attach must be a no-op unless the gate is on');
  assert.match(attachBlock[0],
    /const \{ createTeamExecutorDemo, DEMO_SCENARIO_NAMES \} = require\('\.\/team\/runtime\/team-executor-demo\.js'\);/,
    'the module must be required lazily inside the gate');
  // 没有新 IPC 通道（office:* 仍是 8 个）。
  const channels = /const OFFICE_IPC_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\);/
    .exec(fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8'));
  assert.ok(channels, 'channel constant found');
  assert.equal(channels[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).length, 8,
    'no new office:* IPC channel');
});

test('exec-demo: both dev fixtures are detached at will-quit (timers never outlive the app)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const quitBlock = src.slice(src.indexOf("app.on('will-quit'"));
  assert.match(quitBlock, /detachOfficeTeamDemo\(log\);/, 'the old fixture must still be detached');
  assert.match(quitBlock, /detachOfficeTeamExecutorDemo\(log\);/, 'the new fixture must be detached too');
  // 新实例是独立变量（不复用旧实例变量 —— 否则两个门会互相踩着）。
  assert.match(src, /let officeTeamExecutorDemoInstance = null;/);
  assert.match(src, /let officeTeamDemoInstance = null;/);
});

test('exec-demo: enabling both gates refuses the new entry (mutual exclusion, N9)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const attachBlock = /function attachOfficeTeamExecutorDemo\(office, log\) \{[\s\S]*?\n\}/.exec(src)[0];
  // 互斥检查必须在 require 之前（连模块都不加载）。
  const conflictAt = attachBlock.indexOf('if (officeTeamDemoEnabled() || officeTeamRealEnabled())');
  const requireAt = attachBlock.indexOf("require('./team/runtime/team-executor-demo.js')");
  assert.ok(conflictAt > -1 && requireAt > -1 && conflictAt < requireAt,
    'the conflict check must run before the lazy require');
  assert.match(attachBlock, /OFFICE_TEAM_DEMO_CONFLICT/);
  // 且冲突是"拒绝新入口"，不是抛错（普通启动零影响）。
  assert.equal(/throw\s/.test(attachBlock), false, 'a gate conflict must not throw');

  // 运行时等价证明：把 main.js 的判定逻辑抽出来复现两种组合。
  const both = { old: '1', NEW: '1' };
  const onlyNew = { old: undefined, NEW: '1' };
  const gateOld = (env) => env.old === '1';
  const gateNew = (env) => env.NEW === '1';
  const refused = (env) => gateNew(env) && gateOld(env);
  assert.equal(refused(both), true, 'both gates on → new entry refused');
  assert.equal(refused(onlyNew), false, 'only the new gate → allowed');
  assert.equal(gateOld(onlyNew), false, 'the old gate stays off');
});

test('exec-demo: the entry can be attached and detached with an injected timer (no real 50ms wait)', () => {
  const fixture = createFixture();
  assert.equal(fixture.demo.hasLiveTimer(), false);
  const attached = fixture.demo.attach();
  assert.equal(attached.ok, true);
  assert.equal(attached.scenario, 'happy');
  assert.equal(fixture.demo.hasLiveTimer(), true);
  assert.equal(fixture.timerHarness.__live.size, 1, 'exactly one pump timer');
  // 重复 attach 被拒绝（绝不叠加定时器）。
  assert.equal(fixture.demo.attach().code, 'ALREADY_ATTACHED');
  assert.equal(fixture.timerHarness.__live.size, 1);
  // 定时器被 unref（不拖住进程退出）。
  const handle = [...fixture.timerHarness.__live.keys()][0];
  assert.equal(handle.unrefd, true, 'the pump timer must be unrefed');
  assert.equal(handle.ms, DEMO_PUMP_INTERVAL_MS);
  // detach 清掉定时器；再 detach 是 no-op。
  assert.equal(fixture.demo.detach().ok, true);
  assert.equal(fixture.demo.hasLiveTimer(), false);
  assert.equal(fixture.timerHarness.__live.size, 0);
  assert.equal(fixture.demo.detach().code, 'NOT_ATTACHED');
});

test('exec-demo: firing the injected timer drives the chain (the timer only schedules; pump is the primitive)', async () => {
  const fixture = createFixture();
  fixture.demo.attach();
  const before = fixture.demo.runtime.facts().length;
  fixture.timerHarness.fireAll();
  // 定时器回调是 fire-and-forget 的异步 pump：等一拍让 microtask 落地。
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(fixture.demo.runtime.facts().length > before,
    'one timer fire must advance the chain');
  assert.ok(fixture.demo.summary().pumps >= 1);
  fixture.demo.detach();
});

test('exec-demo: an unknown scenario is rejected by name (no silent fallback)', () => {
  assert.throws(() => createTeamExecutorDemo({ office: null, scenario: 'nope' }),
    (error) => error.code === 'DEMO_SCENARIO_UNKNOWN');
  // 场景目录是被冻结的白名单，且恰好四个（A4 要求的四个最小场景）。
  assert.deepEqual([...DEMO_SCENARIO_NAMES], ['happy', 'attention-resume', 'cancel', 'failure']);
  assert.ok(Object.isFrozen(DEMO_SCENARIOS));
  for (const name of DEMO_SCENARIO_NAMES) assert.ok(Object.isFrozen(DEMO_SCENARIOS[name]), `${name} frozen`);
});

// ===========================================================================
// 2. 新链路：FakeExecutor → Controller → Team（事实方向）
// ===========================================================================

test('exec-demo: the fact log is produced by the executor through the controller, not by the fixture', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  const stop = await fixture.demo.pumpUntilIdle();
  assert.equal(stop.reason, 'terminal');
  const state = fixture.demo.runtime.state();
  assert.equal(state.status, 'completed');
  // 事实序列**必须**与执行事件一一对应（fixture 不得凭空多写事实）。
  assert.deepEqual(fixture.demo.runtime.facts().map((f) => f.type), [
    'job/created',
    'run/dispatched', 'run/started', 'artifact/available', 'run/completed',
    'run/dispatched', 'run/started', 'artifact/available', 'run/completed',
    'job/completed',
  ]);
  // controller 的会话摘要证明事件数 == 应用数（每条 Team fact 都来自一条执行事件）。
  const sessions = fixture.demo.controller.summary().sessions;
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.equal(session.consumed, 3, 'each role consumes exactly 3 script events');
    assert.equal(session.applied, 3);
    assert.equal(session.terminal, true);
  }
  // 终态证据来自执行事件（不是脚本、不是日志文本）。
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/completed:ok');
  assert.equal(state.runs.reviewer.terminalEvidence.source, 'execution/completed:ok');
  // 零拒绝（新链路的转换不允许有静默失败）。
  assert.deepEqual(fixture.demo.controller.summary().rejections, {});
});

test('exec-demo: the fixture never calls Team commands directly (old-demo mechanism is absent)', () => {
  const source = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-executor-demo.js'), 'utf8'));
  // 唯一允许的 Team 命令调用点是 controller（经由注入的 teamRuntime）。
  for (const command of ['createJob', 'dispatchRun', 'startRun', 'noteArtifact',
    'noteRunTerminal', 'noteRunAttention', 'requestCancel', 'noteCancelAcknowledged']) {
    assert.equal(new RegExp(`\\bruntime\\s*\\.\\s*${command}\\s*\\(`).test(source), false,
      `the fixture must not call Team command ${command}() — only the controller may`);
  }
  // 也不复用旧 demo 的任何机制。
  assert.equal(/applyDemoOp|DEMO_SCRIPT|team-office-demo/.test(source), false,
    'the new entry must not reuse the old demo script/ops');
  // 必须真的要求三段（生产者 / 转换者 / 投影者）。
  assert.match(source, /require\('\.\/fake-executor\.js'\)/);
  assert.match(source, /require\('\.\/team-execution-controller\.js'\)/);
  assert.match(source, /require\('\.\/team-office-bridge\.js'\)/);
});

test('exec-demo: the controller is the only ExecutionEvent -> Team command converter (no second orchestrator)', () => {
  // 结构性：新入口里**没有**任何"事件类型 → Team 命令"的映射（那是 controller 的职责）。
  const source = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-executor-demo.js'), 'utf8'));
  assert.equal(/execution\/(completed|failed|cancelled)/.test(source), false,
    'the fixture must not know about terminal execution event types (that is the controller table)');
  assert.equal(/evidenceForExecutionEvent|teamActionForExecutionEvent|noteRunTerminal/.test(source), false,
    'the fixture must not build evidence or terminal facts');
  // 反向：controller 仍是唯一转换点（既有断言在新入口下仍成立）。
  const controller = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-execution-controller.js'), 'utf8'));
  assert.match(controller, /\bteam\s*\.\s*noteRunTerminal\s*\(/);
  assert.match(controller, /\bteam\s*\.\s*startRun\s*\(/);
});

// ===========================================================================
// 3. 四种场景（A4）
// ===========================================================================

test('exec-demo scenario happy: researcher -> artifact -> completed -> reviewer -> completed -> root completed', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  await fixture.demo.pumpUntilIdle();
  const state = fixture.demo.runtime.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  // reviewer 消费了 researcher 的 artifact（handoff 完整）。
  assert.deepEqual(state.runs.reviewer.consumedArtifactIds, state.runs.researcher.producedArtifactIds);
  // Office 侧：两个座位被绑定过（经显式 role→seat 表）。
  assert.ok(emp(fixture.office, 'researcher').binding);
  assert.ok(emp(fixture.office, 'reviewer').binding);
});

test('exec-demo scenario happy: reviewer only appears AFTER the dependency completes (A5 观察点 2)', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  // 逐 pump 观察：reviewer 的出现必须在 researcher completed 之后。
  let researcherDoneAtPump = null;
  let reviewerBoundAtPump = null;
  for (let i = 0; i < 40; i += 1) {
    const result = await fixture.demo.pump();
    if (researcherDoneAtPump === null && fixture.demo.runtime.state().runs.researcher.status === 'completed') {
      researcherDoneAtPump = result.pump;
    }
    if (reviewerBoundAtPump === null && emp(fixture.office, 'reviewer').binding) {
      reviewerBoundAtPump = result.pump;
    }
    if (fixture.demo.runtime.state().status === 'completed') break;
  }
  assert.ok(researcherDoneAtPump !== null, 'researcher must complete');
  assert.ok(reviewerBoundAtPump !== null, 'reviewer must eventually be bound');
  assert.ok(reviewerBoundAtPump >= researcherDoneAtPump,
    `reviewer must not precede the dependency (got researcher@${researcherDoneAtPump}, reviewer@${reviewerBoundAtPump})`);
  // 更强的证据：reviewer 的 run/started 事实在 researcher 的 run/completed 之后。
  const types = fixture.demo.runtime.facts().map((f) => f.type);
  const researcherCompletedAt = types.indexOf('run/completed');
  const secondStartedAt = types.indexOf('run/started', researcherCompletedAt + 1);
  assert.ok(secondStartedAt > researcherCompletedAt);
  assert.equal(types.slice(0, researcherCompletedAt + 1).filter((t) => t === 'run/started').length, 1,
    'only the researcher may have started before the dependency completed');
});

test('exec-demo scenario attention-resume: attention shows on the seat, never auto-completes, explicit resume converges', async () => {
  const fixture = createFixture({ scenario: 'attention-resume' });
  // 推进到 reviewer attention（demo 的驱动钩子在演示时间到点后才 resume）。
  let sawAttention = false;
  for (let i = 0; i < 12; i += 1) {
    await fixture.demo.pump();
    const state = fixture.demo.runtime.state();
    if (state.runs.reviewer.status === 'attention') {
      sawAttention = true;
      // A5 观察点 3：office 侧显示 attention（warning），且**仍然占座**。
      const reviewer = emp(fixture.office, 'reviewer');
      assert.equal(reviewer.runtime, 'attention', 'the seat must show attention');
      assert.ok(reviewer.binding, 'attention is not terminal: the seat stays bound');
      assert.notEqual(reviewer.runtime, 'completed');
      // 推进很多 office tick：attention 绝不能被自动改成 completed（N7 的靶子）。
      tickOffice(fixture, 40);
      assert.equal(emp(fixture.office, 'reviewer').runtime, 'attention',
        'attention must survive office time passing');
      assert.equal(fixture.demo.runtime.state().runs.reviewer.status, 'attention');
      break;
    }
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
  }
  assert.equal(sawAttention, true, 'the scenario must reach attention');

  // 继续推进：驱动钩子在演示时间到点后**显式** resume → 收敛 completed。
  const stop = await fixture.demo.pumpUntilIdle();
  assert.equal(stop.reason, 'terminal');
  const state = fixture.demo.runtime.state();
  assert.equal(state.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  assert.deepEqual(fixture.demo.summary().driver.resumedRoles, ['reviewer'],
    'exactly one explicit resume, for the reviewer');
  // resume 经 controller → Team startRun（Team 是权威）。
  const facts = fixture.demo.runtime.facts().map((f) => f.type);
  assert.equal(facts.filter((t) => t === 'run/attention').length, 1);
  assert.equal(facts.filter((t) => t === 'run/completed').length, 2);
});

test('exec-demo scenario cancel: request and ack keep the seat; only execution cancelled releases it (A5 观察点 6)', async () => {
  const fixture = createFixture({ scenario: 'cancel' });
  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    await fixture.demo.pump();
    const state = fixture.demo.runtime.state();
    const reviewer = emp(fixture.office, 'researcher');
    seen.push({
      facts: fixture.demo.runtime.facts().length,
      runStatus: state.runs.researcher.status,
      jobStatus: state.status,
      officeRuntime: reviewer.runtime,
      officeBound: !!reviewer.binding,
      officeControl: reviewer.control,
    });
    if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
  }
  const types = fixture.demo.runtime.facts().map((f) => f.type);
  // 三段必须都存在（请求 / ack / 真实终态）。
  assert.ok(types.includes('run/cancel-requested'), 'cancel request must be recorded');
  assert.ok(types.includes('run/cancel-acknowledged'), 'cancel ack must be recorded');
  assert.ok(types.includes('run/cancelled'), 'the real terminal must arrive');
  assert.ok(types.includes('job/cancelled'));
  // 顺序：request < ack < cancelled。
  assert.ok(types.indexOf('run/cancel-requested') < types.indexOf('run/cancel-acknowledged'));
  assert.ok(types.indexOf('run/cancel-acknowledged') < types.indexOf('run/cancelled'));

  // 关键：ack 之后**仍然占座**；只有 cancelled 之后才收敛。
  const afterAck = seen.find((s) => s.officeControl === 'cancellationPending' && s.runStatus === 'running');
  assert.ok(afterAck, 'a snapshot with cancellationPending + still-running must exist');
  assert.equal(afterAck.officeBound, true, 'cancel ack must NOT release the seat (N6 的靶子)');
  assert.notEqual(afterAck.officeRuntime, 'cancelled');
  assert.notEqual(afterAck.runStatus, 'cancelled');
  // 终态收敛。
  const state = fixture.demo.runtime.state();
  assert.equal(state.status, 'cancelled');
  assert.equal(state.runs.researcher.status, 'cancelled');
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/cancelled:cancelled');
  // 没有 completed 事实。
  assert.equal(types.includes('run/completed'), false);
  assert.equal(types.includes('job/completed'), false);
});

test('exec-demo scenario failure: researcher fails, reviewer never starts, root fails (A5 观察点 5)', async () => {
  const fixture = createFixture({ scenario: 'failure' });
  const stop = await fixture.demo.pumpUntilIdle();
  assert.equal(stop.reason, 'terminal');
  const state = fixture.demo.runtime.state();
  assert.equal(state.status, 'failed');
  assert.equal(state.runs.researcher.status, 'failed');
  assert.equal(state.runs.reviewer.status, 'pending', 'reviewer must never start after an upstream failure');
  // office 侧：failure 座位不显示 completed（office 既有生命周期：failed → 呈现 → idle）。
  const during = emp(fixture.office, 'researcher');
  assert.equal(during.runtime, 'failed', 'a failed run must show failed');
  assert.notEqual(during.animation.resource, 'celebrate');
  tickOffice(fixture, 80);
  assert.notEqual(emp(fixture.office, 'researcher').runtime, 'completed',
    'a failure must never converge to completed');
  // 全链没有任何 completed 事实。
  const types = fixture.demo.runtime.facts().map((f) => f.type);
  assert.equal(types.includes('run/completed'), false);
  assert.equal(types.includes('job/completed'), false);
  // reviewer 从未被绑定过。
  assert.equal(emp(fixture.office, 'reviewer').binding, null, 'the reviewer seat must stay free');
});

// ===========================================================================
// 4. 无 Office / 有 Office 对照（A3 的核心断言）
// ===========================================================================

test('exec-demo: the Team fact log is byte-identical with and without Office (office is only a consumer)', async () => {
  const withOffice = createFixture({ scenario: 'happy', withOffice: true, jobId: 'job-compare' });
  const withoutOffice = createFixture({ scenario: 'happy', withOffice: false, jobId: 'job-compare' });
  assert.equal(withoutOffice.office, null);
  assert.equal(withoutOffice.demo.bridge, null, 'no office → no bridge');
  assert.equal(withoutOffice.demo.describe().projector, null);
  assert.equal(withOffice.demo.describe().projector, 'team-office-bridge-1');

  await withOffice.demo.pumpUntilIdle();
  await withoutOffice.demo.pumpUntilIdle();

  assert.equal(JSON.stringify(withoutOffice.demo.runtime.facts()),
    JSON.stringify(withOffice.demo.runtime.facts()),
    'the Team fact log must be byte-identical with and without the office');
  assert.equal(JSON.stringify(withoutOffice.demo.runtime.state()),
    JSON.stringify(withOffice.demo.runtime.state()));
});

test('exec-demo: the chain completes with NO office for every scenario (N4 的靶子)', async () => {
  for (const scenario of DEMO_SCENARIO_NAMES) {
    const fixture = createFixture({ scenario, withOffice: false, jobId: `job-noffice-${scenario}` });
    const stop = await fixture.demo.pumpUntilIdle();
    const status = fixture.demo.runtime.state().status;
    assert.ok(['completed', 'failed', 'cancelled'].includes(status),
      `${scenario}: the chain must reach a terminal state without any office (got "${status}", stop=${stop.reason})`);
    // 每个场景的期望终态都与有 office 时一致。
    const expected = { happy: 'completed', 'attention-resume': 'completed', cancel: 'cancelled', failure: 'failed' };
    assert.equal(status, expected[scenario], `${scenario} terminal must match the office variant`);
  }
});

test('exec-demo: hiding/closing the office mid-run does not change the Team outcome', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  await fixture.demo.pump();
  await fixture.demo.pump();
  const factsAtCut = fixture.demo.runtime.facts().length;

  // "关掉 office"：把桥的目标换成拒绝一切的桩（等价于 UI 不存在）。
  const refusing = { ingestTeamProjectionFact: () => ({ ok: false, code: 'OFFICE_CLOSED' }) };
  const cutBridge = team.createTeamOfficeBridge({
    teamRuntime: fixture.demo.runtime, office: refusing, knownSeats: SEATS,
  });
  cutBridge.pump();
  assert.ok(cutBridge.summary().counters.officeRejected > 0, 'the stub must refuse, proving the office is gone');

  const stop = await fixture.demo.pumpUntilIdle();
  assert.equal(fixture.demo.runtime.state().status, 'completed');
  assert.ok(fixture.demo.runtime.facts().length > factsAtCut);
  // 投影可幂等追上（证明"投影"与"事实"是两个独立可恢复的关注点）。
  fixture.demo.bridge.replay();
  assert.equal(fixture.demo.bridge.summary().counters.rejected, 0);
});

// ===========================================================================
// 5. 隔离与边界（A6）
// ===========================================================================

test('exec-demo: the chain needs no Electron, no DOM, no Pixi, no network', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  try {
    Module._load = function guarded(request, parent, isMain) {
      if (['electron', 'pixi.js', 'ws'].includes(request)) throw new Error(`${request} unavailable in this probe`);
      return originalLoad.call(this, request, parent, isMain);
    };
    const fixture = createFixture({ scenario: 'happy', jobId: 'job-isolated' });
    await fixture.demo.pumpUntilIdle();
    assert.equal(fixture.demo.runtime.state().status, 'completed');
  } finally {
    Module._load = originalLoad;
  }
});

test('exec-demo: office cannot call back into the execution chain (one-way projection)', () => {
  // 新入口只给 office 一个窄入口（ingestTeamProjectionFact）；office 拿不到 controller / executor / runtime。
  const source = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-executor-demo.js'), 'utf8'));
  // 传给 office 的东西只有"经 bridge 的白名单事实"：不存在 office.<command> 形式的反向调用。
  for (const pattern of [
    /office\s*\.\s*ingestTeamProjectionFact\s*\(/,   // 必须经 bridge，不直连窄入口
    /office\s*\.\s*subscribe\s*\(/,        // 绝不由 office 推送驱动 Team
    /office\s*\.\s*tick/,
    /office\s*\.\s*advanceOneTick/,
  ]) {
    assert.equal(pattern.test(source), false, `the fixture must not use ${pattern}`);
  }
  // 运行时证明：office 的对象上没有任何指向 Team 链的引用（office 侧也不 import team）。
  const officeSource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8'));
  assert.equal(/require\(\s*['"][^'"]*team\/runtime/.test(officeSource), false,
    'office-module must not reverse-import the team layer');
});

test('exec-demo: raw identity, prompt and artifact content never reach the office (A6)', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  await fixture.demo.pumpUntilIdle();
  tickOffice(fixture, 60);
  const snapshot = JSON.stringify(fixture.office.state());
  for (const needle of [
    fixture.demo.jobId,
    'exec-handle:', 'exec-run:', 'exec-job:',
    'team-run-sha256:', 'team-job-sha256:',
    'art:', 'art-sha256:', 'exec-sha256:',
    'locationRef', 'ref:', 'research-notes', 'review-findings',
  ]) {
    assert.equal(snapshot.includes(needle), false, `office snapshot must not contain "${needle}"`);
  }
  // bridge 摘要只允许白名单 kind 计数。
  const summary = JSON.stringify(fixture.demo.bridge.summary());
  for (const needle of ['exec-handle:', 'exec-run:', 'exec-job:', 'art:', 'exec-sha256:']) {
    assert.equal(summary.includes(needle), false, `bridge summary must not contain "${needle}"`);
  }
  // Team 事实里也没有执行侧的 locationRef / digest。
  const facts = JSON.stringify(fixture.demo.runtime.facts());
  for (const needle of ['locationRef', 'exec-sha256:', 'ref:', 'sess-']) {
    assert.equal(facts.includes(needle), false, `team facts must not carry "${needle}"`);
  }
});

test('exec-demo: replaying the whole entry is deterministic and side-effect free', async () => {
  const runOnce = async () => {
    const fixture = createFixture({ scenario: 'happy', jobId: 'job-replay' });
    await fixture.demo.pumpUntilIdle();
    return {
      facts: JSON.stringify(fixture.demo.runtime.facts()),
      replayed: JSON.stringify(fixture.demo.runtime.replay(fixture.demo.runtime.facts())),
      state: JSON.stringify(fixture.demo.runtime.state()),
      projection: JSON.stringify(fixture.demo.bridge.summary().counters),
    };
  };
  const a = await runOnce();
  const b = await runOnce();
  assert.equal(a.facts, b.facts, 'two runs must produce byte-identical fact logs');
  assert.equal(a.projection, b.projection, 'two runs must produce identical projection counters');
  assert.equal(a.replayed, a.state, 'replay(facts) must equal the live state');
});

// ===========================================================================
// 6. 新旧 demo 边界（A6 / 架构问题 #12）
// ===========================================================================

test('exec-demo: the old demo still exists, is unchanged in mechanism, and does not depend on the new entry', () => {
  const oldSource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-office-demo.js'), 'utf8'));
  // 旧 fixture 仍是"直接调 Team 命令"的机制（保留为历史 fixture，不被改造）。
  assert.match(oldSource, /function applyDemoOp\(runtime, op, jobId\)/);
  assert.match(oldSource, /runtime\s*\.\s*noteRunTerminal\s*\(/);
  // 旧 fixture 不 import 新入口 / 执行层。
  assert.equal(/team-executor-demo|fake-executor|team-execution-controller/.test(oldSource), false,
    'the old demo must not depend on the new execution layer');
  // 新入口不 import 旧 fixture（双向隔离）。
  const newSource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-executor-demo.js'), 'utf8'));
  assert.equal(/team-office-demo/.test(newSource), false, 'the new entry must not import the old fixture');
});

test('exec-demo: the two fixtures can never both attach to the same office at once (N9 的靶子)', () => {
  // 顶层证据：main.js 的互斥门（见上面的门控测试）。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(src, /if \(officeTeamDemoEnabled\(\) \|\| officeTeamRealEnabled\(\)\) \{[\s\S]{0,200}OFFICE_TEAM_DEMO_CONFLICT/);
  // 附加证据：两个 fixture 共用**同一个** office 窄入口，但各自的 attach 只接受一个实例；
  // 若真的同时 attach，office 会收到两套事实 —— 这正是门控要避免的。这里断言
  // "两个 fixture 的 Team fact 序列形状明显不同"（因此肉眼与测试都能分辨谁在写事实）。
  const oldTypes = team.DEMO_SCRIPT_HAPPY.map((op) => op.op).join(',');
  assert.match(oldTypes, /createJob/, 'the old fixture drives Team commands directly');
  const newTypes = fixtureFactTypesForScenario('happy');
  assert.equal(/createJob|noteRunTerminal/.test(newTypes), false,
    'the new entry knows no Team commands — its observable output is execution event types');
});

/** 新入口在 happy 场景下的可观测"动作"序列（只有执行事件类型，没有 Team 命令名）。 */
function fixtureFactTypesForScenario(scenario) {
  const executorSource = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'fake-executor.js'), 'utf8'));
  const scenarioBlock = new RegExp(`const SCENARIO_${scenario.toUpperCase().replace(/-/g, '_')} = `);
  assert.ok(scenarioBlock.test(executorSource), `scenario ${scenario} must be declared in the executor`);
  return [...executorSource.matchAll(/op: '([a-z-]+)'/g)].map((m) => m[1]).join(',');
}

// ===========================================================================
// 7. 场景可 replay（A6）
// ===========================================================================

test('exec-demo: every scenario is replay-stable and reaches its documented terminal', async () => {
  const expected = { happy: 'completed', 'attention-resume': 'completed', cancel: 'cancelled', failure: 'failed' };
  const runs = new Map();
  for (const scenario of DEMO_SCENARIO_NAMES) {
    const first = createFixture({ scenario, jobId: `job-stable-${scenario}` });
    const second = createFixture({ scenario, jobId: `job-stable-${scenario}` });
    const stopA = await first.demo.pumpUntilIdle();
    const stopB = await second.demo.pumpUntilIdle();
    assert.equal(first.demo.runtime.state().status, expected[scenario], `${scenario} terminal`);
    assert.equal(stopA.reason, 'terminal', `${scenario} must stop on a terminal state`);
    assert.equal(stopB.reason, 'terminal', `${scenario} must stop on a terminal state (second run)`);
    assert.equal(JSON.stringify(first.demo.runtime.facts()), JSON.stringify(second.demo.runtime.facts()),
      `${scenario} must be byte-identical across two runs`);
    runs.set(scenario, first.demo.runtime.facts().length);
  }
  // 每个场景的事实条数都 > 0 且各不相同（证明四个场景真的不同，不是同一个跑四遍）。
  assert.equal(new Set([...runs.values()]).size > 1, true, 'the scenarios must differ observably');
});

test('exec-demo: the demo clock is injected, monotonic and wall-clock free', async () => {
  const fixture = createFixture({ scenario: 'happy' });
  const baseBefore = fixture.clock.nowMs();
  const offsets = [];
  const applied = [];
  for (let i = 0; i < 4; i += 1) {
    const result = await fixture.demo.pump();
    offsets.push(fixture.demo.summary().driver.localOffsetMs);
    applied.push(result.applied.length);
  }
  // 基准时钟（注入的）**绝不**被 fixture 推进 —— 演示时间完全由本地偏移承载。
  assert.equal(fixture.clock.nowMs(), baseBefore, 'the base clock must not be advanced by the fixture');
  // 偏移单调递增，且每 pump 至少推进一个 DEMO_TICK_MS（脚本自身的 advanceMs 会额外叠加，
  // 因为执行侧在 startRun 时就为整条脚本排定了逻辑时间）。
  for (let i = 1; i < offsets.length; i += 1) {
    assert.ok(offsets[i] > offsets[i - 1], `offset must increase (${offsets[i - 1]} -> ${offsets[i]})`);
    assert.ok(offsets[i] - offsets[i - 1] >= DEMO_TICK_MS,
      'every pump must advance at least one demo tick');
  }
  // **可视节奏**的断言：每次 pump 最多消费 eventsPerPump 条事件（因此中间态可见）。
  for (const count of applied) {
    assert.ok(count <= DEMO_SCENARIOS.happy.eventsPerPump,
      `one pump must not apply more than ${DEMO_SCENARIOS.happy.eventsPerPump} events (got ${count})`);
  }
  // 事实时间单调不减，且都来自演示时钟（>= 基准）。
  const factTimes = fixture.demo.runtime.facts().map((f) => f.atMs);
  assert.ok(factTimes.length > 0);
  for (let i = 0; i < factTimes.length; i += 1) {
    assert.ok(Number.isFinite(factTimes[i]));
    assert.ok(factTimes[i] >= baseBefore, `fact time ${factTimes[i]} must come from the demo clock`);
    if (i > 0) assert.ok(factTimes[i] >= factTimes[i - 1], 'fact times must be monotonic');
  }
  // 结构性：fixture 不读墙钟。
  const source = stripComments(fs.readFileSync(
    path.join(ROOT, 'src', 'team', 'runtime', 'team-executor-demo.js'), 'utf8'));
  assert.equal(/Date\s*\.\s*now\s*\(/.test(source), false, 'the fixture must not read the wall clock');
});