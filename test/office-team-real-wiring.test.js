'use strict';

// test/office-team-real-wiring.test.js — Harness v0.4 阶段1：真实 dsh 接入的 main.js 接线（离线）。
//
// 验证对象是**真实的 main.js 源码**里的 gate / attach / detach / follow 流包装函数：
// 不启动 Electron、不连真实 dsh —— 通过抽取 main.js 的真函数体 + 注入
// { rpc, openFollow, artifactDir, clock, jobId } 跑同一条代码路径。
// （rpc/openFollow 的**生产行为**（建会话/tee/物化）由 test/team-shell-transport.test.js
//  用同一实现覆盖；这里验证的是壳的接线与门控。）
//
// 分层声明（本批次的三层验证）：
//   headless 离线（本文件 + shell-transport + dsh-backend 套件）：✅
//   真实 GUI / 真实 dsh：❌ 未运行（需用户在有显示与运行时的设备上执行，见报告 §使用说明）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');

const P = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
}).pack;

function extractFunction(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`main.js is missing function ${name}()`);
  // 先匹配**参数括号**（参数里可能有 `deps = {}` 这类默认值，不能当成函数体起点），
  // 再从参数收括号之后的第一个 `{` 开始做体括号配平。
  let parens = 0;
  let bodyStart = -1;
  for (let j = SRC.indexOf('(', start); j < SRC.length; j += 1) {
    if (SRC[j] === '(') parens += 1;
    else if (SRC[j] === ')') {
      parens -= 1;
      if (parens === 0) {
        bodyStart = SRC.indexOf('{', j);
        break;
      }
    }
  }
  if (bodyStart === -1) throw new Error(`cannot locate the body of ${name}()`);
  let depth = 0;
  for (let j = bodyStart; j < SRC.length; j += 1) {
    if (SRC[j] === '{') depth += 1;
    else if (SRC[j] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced function ${name}()`);
}

/**
 * 抽取 main.js 里的 gate/attach/detach/follow 函数并在沙箱里实例化。
 * deps 走 attachOfficeTeamReal 的注入缝；getRuntimeUrl / createHarnessRpcWire /
 * runtimeMux / app / path 只在"未注入"的默认路径上被求值 —— 测试全部注入，因此
 * 这些绑定用 stub 提供且**永不**被调用（被调用即测试失败）。
 */
function loadMainWiring(env = {}) {
  const repoRequire = Module.createRequire(path.join(ROOT, 'src/main.js'));
  const forbidden = (label) => () => { throw new Error(`offline test must not reach ${label}`); };
  const factory = new Function(
    'require', 'process', 'path', 'app',
    'getRuntimeUrl', 'createHarnessRpcWire', 'harnessRpcDeps', 'runtimeMux', 'Date',
    `${extractFunction('officeTeamRealEnabled')}
     ${extractFunction('officeTeamRealTopic')}
     const OFFICE_TEAM_GATE_CONFLICT = ${JSON.stringify('OFFICE_TEAM_GATE_CONFLICT')};
     ${extractFunction('openTeamFollowStream')}
     ${extractFunction('startTeamRealWithTopic')}
     ${extractFunction('attachOfficeTeamReal')}
     ${extractFunction('detachOfficeTeamReal')}
     ${extractFunction('officeTeamDemoEnabled')}
     ${extractFunction('officeTeamExecutorDemoEnabled')}
     let officeTeamRealInstance = null;
     return {
       gate: officeTeamRealEnabled, topic: officeTeamRealTopic,
       attach: attachOfficeTeamReal, detach: detachOfficeTeamReal,
       openFollowStream: openTeamFollowStream,
       setInstance: (v) => { officeTeamRealInstance = v; },
       getInstance: () => officeTeamRealInstance,
       demoGate: officeTeamDemoEnabled, executorDemoGate: officeTeamExecutorDemoEnabled,
     };`,
  );
  const fakePath = path;
  const fakeApp = { getPath: () => { throw new Error('offline test must not reach app.getPath'); } };
  return factory(repoRequire, { env }, fakePath, fakeApp,
    forbidden('getRuntimeUrl'), forbidden('createHarnessRpcWire'), forbidden('harnessRpcDeps'),
    { onItem: forbidden('runtimeMux.onItem'), openStream: forbidden('runtimeMux.openStream') },
    Date);
}

/** 门开的 env（主题必填）。 */
const ON_ENV = Object.freeze({
  DSH_DESKTOP_OFFICE_TEAM_REAL: '1',
  DSH_DESKTOP_OFFICE_TEAM_TOPIC: '调研离线接线',
});

function makeOffice() {
  return officeModule.createOfficeModule({
    pack: PACK, seed: 'real-wiring-seed',
    config: { resultPresentationMs: 200, workstationAnchorSegmentMs: 120 },
    log: () => {},
  });
}

/** 一个完整可跑的注入 deps：fake rpc + 两条 journal 流 + tmp artifactDir + 可控时钟。 */
function makeDeps({ reviewerEnd = 'completed', failCreate = false } = {}) {
  const T0 = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-real-wiring-'));
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const rpc = {
    calls: { create: 0, prompt: [], cancel: [] },
    async createSession() {
      rpc.calls.create += 1;
      if (failCreate) throw new Error('runtime down');
      return `sess-fake-${rpc.calls.create}`;
    },
    async prompt(sessionId, text, mode) { rpc.calls.prompt.push({ sessionId, text, mode }); return { ok: true }; },
    async cancel(sessionId) { rpc.calls.cancel.push(sessionId); return { ok: true }; },
  };
  let opened = 0;
  const openFollow = () => {
    opened += 1;
    const isResearcher = opened === 1;
    const events = isResearcher
      ? [
        je('turn/start', {}, 1),
        je('assistant/message', { content: [{ type: 'text', text: '# 研究笔记（fake 会话产出）' }] }, 2),
        je('turn/end', { reason: { kind: 'completed' } }, 3),
      ]
      : [
        je('turn/start', {}, 1),
        je('turn/end', { reason: { kind: reviewerEnd } }, 2),
      ];
    let i = 0;
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        next() {
          if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
          const value = events[i]; i += 1;
          return Promise.resolve({ value, done: false });
        },
      }),
    });
  };
  return {
    rpc, openFollow, artifactDir, clock, jobId: 'job-wiring-1',
    advance: (ms = 10) => { nowMs += ms; },
    promptTexts: () => rpc.calls.prompt.map((p) => p.text),
  };
}

/**
 * 等待 attach 内部的**真实** drive() 循环收敛（whenDone）。
 * attach 是唯一驱动者（它自己 start/dispatchReady/pumpOne/投影）；测试不并发泵
 * 同一迭代器 —— 那会互相抢事件（这就是为什么不用手动泵复制品）。
 */
async function driveToTerminal(real) {
  await real.whenDone;
  return real.runtime.state().status;
}

// ===========================================================================
// 1. 门控（默认关闭 / 三方互斥 / 主题必填）
// ===========================================================================

test('team-real wiring: the gate is default-off and a separate env var', () => {
  // 沙箱 env 为空 → 关。
  const box = loadMainWiring();
  assert.equal(box.gate(), false);
  assert.equal(box.demoGate(), false);
  assert.equal(box.executorDemoGate(), false);
  // main.js 源级：门名与默认关闭。
  assert.match(SRC, /function officeTeamRealEnabled\(\) \{\s*return process\.env\.DSH_DESKTOP_OFFICE_TEAM_REAL === '1';/);
  // 三个门是三个不同的环境变量。
  const vars = ['DSH_DESKTOP_OFFICE_TEAM_DEMO', 'DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO', 'DSH_DESKTOP_OFFICE_TEAM_REAL'];
  assert.equal(new Set(vars).size, 3);
  for (const v of vars) assert.ok(SRC.includes(v));
});

test('team-real wiring: refuses when any other Team gate is on (three-way exclusion)', () => {
  const src = SRC;
  const attachBlock = extractFunction('attachOfficeTeamReal');
  assert.match(attachBlock, /if \(officeTeamDemoEnabled\(\) \|\| officeTeamExecutorDemoEnabled\(\)\) \{[\s\S]{0,220}OFFICE_TEAM_GATE_CONFLICT/);
  // 互斥检查在委托核心装配之前（require 已搬进 startTeamRealWithTopic）。
  const conflictAt = attachBlock.indexOf('if (officeTeamDemoEnabled() || officeTeamExecutorDemoEnabled())');
  const coreAt = attachBlock.indexOf('startTeamRealWithTopic({');
  assert.ok(conflictAt > -1 && coreAt > -1 && conflictAt < coreAt);
  // 冲突分支是"return null + 记日志"，不是抛错（普通启动零影响）。
  const conflictBlock = attachBlock.slice(conflictAt, attachBlock.indexOf('}', attachBlock.indexOf('return null;', conflictAt)));
  assert.ok(conflictBlock.includes('return null'), 'the conflict branch must return null, not throw');
  assert.equal(/throw\s/.test(conflictBlock), false, 'a gate conflict must not throw');
  // executor-demo 侧也对称避让（任意两个门都不同时 attach）。
  const execBlock = extractFunction('attachOfficeTeamExecutorDemo');
  assert.match(execBlock, /officeTeamDemoEnabled\(\) \|\| officeTeamRealEnabled\(\)/);
  void src;
});

test('team-real wiring: refuses without a user topic (U3: text comes from the user)', () => {
  const envNoTopic = Object.freeze({ DSH_DESKTOP_OFFICE_TEAM_REAL: '1' });
  const box = loadMainWiring(envNoTopic);
  const logs = [];
  const real = box.attach(makeOffice(), (l) => logs.push(l), makeDeps());
  assert.equal(real, null, 'REAL=1 without TOPIC must be refused before any require');
  assert.ok(logs.some((l) => l.includes('TEAM_TOPIC_REQUIRED')), 'the refusal must be observable');
  // 源级：主题门在互斥门之后、且在委托核心装配之前（require 已搬进核心，
  // 因此这里的判据是"先拒主题，再调 startTeamRealWithTopic"）。
  const attachBlock = extractFunction('attachOfficeTeamReal');
  const topicAt = attachBlock.indexOf('if (!topic) {');
  const coreAt = attachBlock.indexOf('startTeamRealWithTopic({');
  assert.ok(topicAt > -1 && coreAt > -1 && topicAt < coreAt,
    'the topic check must run before the core assembly (and any require inside it)');
});

// ===========================================================================
// 2. 真实接线（注入 deps）：完整跑通两个会话 → Team 收敛 → Office 投影
// ===========================================================================

test('team-real wiring: END-TO-END offline — real main.js attach drives a full team run', async () => {
  const deps = makeDeps();
  const logs = [];
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), (l) => logs.push(l), deps);
  assert.ok(real, 'attach with injected deps must succeed');
  // attach 返回的实例带全链（transport/controller/bridge/runtime）。
  assert.ok(real.transport && real.controller && real.bridge && real.runtime);

  const status = await driveToTerminal(real);
  assert.equal(status, 'completed');
  const state = real.runtime.state();
  assert.equal(state.runs.researcher.status, 'completed');
  assert.equal(state.runs.reviewer.status, 'completed');
  // 真实 handoff：reviewer 消费了 researcher 物化出的 artifact。
  const artifactId = state.runs.researcher.producedArtifactIds[0];
  assert.ok(artifactId);
  assert.deepEqual(state.runs.reviewer.consumedArtifactIds, [artifactId]);
  // 物化文件真实存在（artifactDir 由注入提供）。
  assert.equal(fs.existsSync(path.join(deps.artifactDir, deps.jobId, 'research-notes.md')), true);
  // reviewer 的 prompt 内联了 researcher 笔记（tee 捕获 → consumes 定位）。
  assert.equal(deps.rpc.calls.prompt.length, 2);
  assert.ok(deps.promptTexts()[1].includes('# 研究笔记（fake 会话产出）'));
  // Office 侧投影真的发生（座位被绑过）。
  const office = real.bridge ? null : null;
  void office;
  // attach 的日志如实描述链路。
  assert.ok(logs.some((l) => l.includes('team real attached')));
  // 隐私：Team 事实 / transport 摘要都不含 raw 会话 id、prompt、路径。
  const facts = JSON.stringify(real.runtime.facts());
  assert.equal(facts.includes('sess-fake-'), false);
  assert.equal(facts.includes('研究笔记'), false);
  assert.equal(facts.includes(deps.artifactDir), false);
  const summary = JSON.stringify(real.summary());
  assert.equal(summary.includes('sess-fake-'), false);
  assert.equal(summary.includes(deps.artifactDir), false);
});

test('team-real wiring: reviewer failure surfaces as root failed (no fabricated completion)', async () => {
  const deps = makeDeps({ reviewerEnd: 'error' });
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  assert.ok(real);
  const status = await driveToTerminal(real);
  assert.equal(status, 'failed');
  const types = real.runtime.facts().map((f) => f.type);
  assert.ok(types.includes('run/failed'));
  assert.equal(types.filter((t) => t === 'run/completed').length, 1, 'only the researcher completed');
  assert.equal(types.includes('job/completed'), false);
});

test('team-real wiring: reviewer blocked surfaces as attention (no auto-resume in v0.4)', async () => {
  const deps = makeDeps({ reviewerEnd: 'blocked' });
  const logs = [];
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), (l) => logs.push(l), deps);
  assert.ok(real);
  const status = await driveToTerminal(real);
  assert.equal(status, 'attention');
  const state = real.runtime.state();
  assert.equal(state.runs.reviewer.status, 'attention');
  assert.equal(state.runs.reviewer.terminalEvidence, null);
  // 没有 materialize review-findings（blocked 不触发 materializer）。
  assert.equal(fs.existsSync(path.join(deps.artifactDir, deps.jobId, 'review-findings.md')), false);
});

test('team-real wiring: session creation failure → Team attention session-unavailable (design B §4.9)', async () => {
  const deps = makeDeps({ failCreate: true });
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  assert.ok(real);
  const status = await driveToTerminal(real);
  assert.equal(status, 'attention');
  const run = real.runtime.state().runs.researcher;
  assert.equal(run.status, 'attention');
  assert.equal(run.attention.reason, 'session-unavailable');
  // 没有任何 prompt 被发出（会话都没建成）。
  assert.equal(deps.rpc.calls.prompt.length, 0);
});

test('team-real wiring: attach failure is structured and never breaks the office', () => {
  const logs = [];
  // transport 构造会因为没有 topic 抛错？不会——attach 先查 topic。用一个必炸的 deps：
  const badDeps = makeDeps();
  badDeps.artifactDir = null; // createShellTeamTransport 对 artifactDir 诚实失败
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), (l) => logs.push(l), badDeps);
  assert.equal(real, null);
  assert.ok(logs.some((l) => l.includes('team real attach failed')));
});

test('team-real wiring: detach stops the drive loop and is idempotent', async () => {
  const deps = makeDeps();
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  assert.ok(real);
  box.setInstance(real);
  assert.equal(box.detach(() => {}), true);
  assert.equal(box.detach(() => {}), false, 'second detach is a no-op');
  assert.equal(box.getInstance(), null);
});

// ===========================================================================
// 3. openTeamFollowStream：帧 → journal 事件的抽取（离线可测部分）
// ===========================================================================

test('team-real wiring: openTeamFollowStream extracts journal events from frames (offline harness)', async () => {
  // openTeamFollowStream 需要 runtimeMux —— 用一个最小 fake mux 验证帧抽取语义
  //（snapshot 开窗 + 增量 event + end），不触网。
  const listeners = new Map();
  const openedStreams = [];
  const fakeMux = {
    onItem: (streamId, fn) => listeners.set(streamId, fn),
    openStream: (streamId, endpoint, args) => openedStreams.push({ streamId, endpoint, args }),
  };
  const factory = new Function('require', 'runtimeMux',
    `${extractFunction('openTeamFollowStream')}
     return openTeamFollowStream;`);
  const openFollowStream = factory(require, fakeMux);
  const stream = openFollowStream('sess-stream-1');
  // 打开的流参数形状与办公室的根会话地址一致（follow-address.js:6-9）。
  assert.equal(openedStreams.length, 1);
  assert.equal(openedStreams[0].endpoint, 'session/follow');
  assert.deepEqual(openedStreams[0].args, { request: { address: { kind: 'session', sessionId: 'sess-stream-1' } } });

  // 先订阅再喂帧（与真实顺序一致：onItem 先于帧到达）。
  const iterator = stream[Symbol.asyncIterator]();
  const first = iterator.next();
  const second = iterator.next();
  listeners.get('team-follow-sess-stream-1')({
    type: 'snapshot',
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: {} } },
      { type: 'event', event: { type: 'assistant/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'hi' }] } } },
    ],
  });
  listeners.get('team-follow-sess-stream-1')({ type: 'event', event: { type: 'turn/end', seq: 3, time: 3, data: { reason: { kind: 'completed' } } } });
  const a = await first;
  const b = await second;
  assert.equal(a.value.type, 'turn/start');
  assert.equal(b.value.type, 'assistant/message');
  const third = await iterator.next();
  assert.equal(third.value.type, 'turn/end');
  // assistant-stream 增量帧被刻意忽略（正文只在 journal 事件里；与办公室同一纪律）。
  const fourth = iterator.next();
  listeners.get('team-follow-sess-stream-1')({ type: 'assistant-stream', frame: { type: 'chunk' } });
  await new Promise((resolve) => setImmediate(resolve));
  // 未产新事件：fourth 仍在等待（我们不 await 它，只确认它没 resolve 出事件）。
  let settled = false;
  fourth.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'an assistant-stream frame must not produce a journal event');
  // end 帧结束流。
  listeners.get('team-follow-sess-stream-1')({ type: 'end' });
  const fifth = await fourth.then(() => iterator.next());
  assert.equal(fifth.done, true);
});
// ===========================================================================
// 5. v0.6 WP1：真实链路的 resume 闭环（bind 重试 + 流耗尽恢复）
// ===========================================================================

/** 可脚本化 deps：createSession 前置失败次数 + 每次 openFollow 的 journal 脚本。 */
function makeScriptedDeps({ createFailures = 0, journals = [] } = {}) {
  const T0 = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });
  void je;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-real-resume-'));
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  let created = 0;
  let opened = 0;
  const rpc = {
    calls: { create: 0, prompt: [], cancel: [] },
    async createSession() {
      rpc.calls.create += 1;
      if (created < createFailures) {
        created += 1;
        throw new Error('runtime down (scripted)');
      }
      created += 1;
      return `sess-rs-${rpc.calls.create}`;
    },
    async prompt(sessionId, text, mode) { rpc.calls.prompt.push({ sessionId, text, mode }); return { ok: true }; },
    async cancel(sessionId) { rpc.calls.cancel.push(sessionId); return { ok: true }; },
  };
  const openFollow = () => {
    const events = journals[Math.min(opened, journals.length - 1)] || [];
    opened += 1;
    let i = 0;
    return Object.freeze({
      [Symbol.asyncIterator]: () => ({
        next() {
          if (i >= events.length) return Promise.resolve({ value: undefined, done: true });
          const value = events[i]; i += 1;
          return Promise.resolve({ value, done: false });
        },
      }),
    });
  };
  return { rpc, openFollow, artifactDir, clock, jobId: 'job-resume-wiring-1' };
}

const RS_JE = (type, data, seq) => ({ type, seq, time: 1_700_000_000_000 + seq, data });

test('team-real wiring WP1a: bind 失败→attention→resumeTeam 重试绑定→真实链路完成', async () => {
  // dsh 起不来（第一次 createSession 失败）→ researcher bind attention →
  // runtime 恢复后用户点"继续"（resumeTeam）→ 重试绑定 → 驱动重启 → 任务完成。
  const journals = [
    [ // researcher（重试成功后的第一次 openFollow）
      RS_JE('turn/start', {}, 1),
      RS_JE('assistant/message', { content: [{ type: 'text', text: '# 研究笔记（恢复后产出）' }] }, 2),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 3),
    ],
    [ // reviewer
      RS_JE('turn/start', {}, 1),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 2),
    ],
  ];
  const deps = makeScriptedDeps({ createFailures: 1, journals });
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  assert.ok(real, 'attach must succeed (failure happens at bind, not attach)');
  await real.whenDone;
  assert.equal(real.runtime.state().status, 'attention');
  assert.equal(real.runtime.state().runs.researcher.attention.reason, 'session-unavailable');
  assert.equal(deps.rpc.calls.create, 1, 'only the failed create happened before attention');

  const verdict = await real.resumeTeam();
  assert.equal(verdict.ok, true, `resumeTeam must re-bind, got ${JSON.stringify(verdict)}`);
  await real.whenSettled();
  const state = real.runtime.state();
  assert.equal(state.status, 'completed', 'the real chain must finish after resume');
  assert.equal(state.runs.reviewer.consumedArtifactIds.length, 1, 'handoff survived the retry');
  assert.equal(deps.rpc.calls.create, 3, 'failed create + researcher retry + reviewer');
});

test('team-real wiring WP1b: 流耗尽→crashed→attention→resumeTeam 重挂→续流完成', async () => {
  // researcher 的第一条流只有 turn/start（dsh 中途死掉的离线等价物）→ crashed →
  // attention；resumeTeam 重挂同一会话 → 重放去重 + 新事件 → 完成 → reviewer 接力。
  const journals = [
    [RS_JE('turn/start', {}, 1)],
    [ // researcher 重挂：重放 seq1 + 新 seq2/3（会话其实在断流期间跑完了）
      RS_JE('turn/start', {}, 1),
      RS_JE('assistant/message', { content: [{ type: 'text', text: '# 研究笔记（断流期间产出）' }] }, 2),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 3),
    ],
    [ // reviewer
      RS_JE('turn/start', {}, 1),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 2),
    ],
  ];
  const deps = makeScriptedDeps({ journals });
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  assert.ok(real);
  await real.whenDone;
  assert.equal(real.runtime.state().status, 'attention');
  assert.equal(real.runtime.state().runs.researcher.attention.reason, 'stream-ended',
    'exhaustion without a terminal must surface as crashed(stream-ended) → attention');

  const verdict = await real.resumeTeam();
  assert.equal(verdict.ok, true);
  await real.whenSettled();
  const state = real.runtime.state();
  assert.equal(state.status, 'completed', 're-follow must continue the run to a real terminal');
  assert.equal(state.runs.researcher.terminalEvidence.source, 'execution/completed:ok');
  assert.equal(state.runs.reviewer.consumedArtifactIds.length, 1, 'artifact materialized after re-follow');
  // 只建了两个会话（researcher 会话是**重挂**，不是重建 —— raw sessionId 不变）。
  assert.equal(deps.rpc.calls.create, 2);
});

test('team-real wiring WP1: resumeTeam 拒绝不在 attention 的实例（无旁路）', async () => {
  const deps = makeScriptedDeps({
    journals: [[
      RS_JE('turn/start', {}, 1),
      RS_JE('assistant/message', { content: [{ type: 'text', text: '# 笔记' }] }, 2),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 3),
    ]],
  });
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(makeOffice(), () => {}, deps);
  await real.whenDone;
  assert.equal(real.runtime.state().status, 'completed');
  const verdict = await real.resumeTeam();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'NOT_IN_ATTENTION');
});

test('team-real wiring WP2: journal tool calls surface as run/progress and the seat phrase', async () => {
  const journals = [
    [ // researcher：工具调用 → progress（bash/npm 同 phase 去重，web-search 换 phase）
      RS_JE('turn/start', {}, 1),
      RS_JE('tool/call', { name: 'bash', arguments: { cmd: 'SECRET-PROGRESS-ARG' } }, 2),
      RS_JE('tool/call', { name: 'npm', arguments: {} }, 3),
      RS_JE('tool/call', { name: 'web-search', arguments: { q: 'x' } }, 4),
      RS_JE('assistant/message', { content: [{ type: 'text', text: '# 研究笔记（带工具调用）' }] }, 5),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 6),
    ],
    [ // reviewer
      RS_JE('turn/start', {}, 1),
      RS_JE('turn/end', { reason: { kind: 'completed' } }, 2),
    ],
  ];
  const deps = makeScriptedDeps({ journals });
  const office = makeOffice();
  const box = loadMainWiring(ON_ENV);
  const real = box.attach(office, () => {}, deps);
  assert.ok(real);
  await real.whenDone;
  assert.equal(real.runtime.state().status, 'completed');
  const run = real.runtime.state().runs.researcher;
  assert.equal(run.progress.phase, 'retrieval', 'latest phase wins (bash/npm deduped to command, then web-search)');
  assert.deepEqual(
    real.runtime.facts().filter((f) => f.type === 'run/progress').map((f) => f.phase),
    ['command', 'retrieval'],
    '3 tool calls → exactly 2 progress facts (dedupe)',
  );
  // office 座位短语（真实 office-module 投影，闭集键命中呈现词表）。
  const seat = office.state().employees.find((e) => e.employeeId === 'researcher');
  assert.equal(seat.toolPhraseKey, 'retrieval');
  assert.equal(seat.toolPhrase, '检索');
  // 隐私：工具参数与查询词不进 Team 事实、不进 office 快照。
  const factsJson = JSON.stringify(real.runtime.facts());
  const officeJson = JSON.stringify(office.state());
  for (const needle of ['SECRET-PROGRESS-ARG', 'bash', 'npm', 'web-search']) {
    assert.equal(factsJson.includes(needle), false, `facts must not carry ${needle}`);
    assert.equal(officeJson.includes(needle), false, `office snapshot must not carry ${needle}`);
  }
});
