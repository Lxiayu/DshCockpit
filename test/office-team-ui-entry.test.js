'use strict';

// test/office-team-ui-entry.test.js — Harness v0.5（首次体验最小版）：办公室 Team 任务发起入口。
//
// 验证对象是**真实的 main.js 源码**里的 gate / payload 校验 / shell:team 处理器 /
// startTeamRealWithTopic 核心，以及 office-preload 的 team() 方法与 office-page
// 控制器的三个控制方法。不启动 Electron、不连真实 dsh（rpc/openFollow/fs 注入）。
//
// 架构断言（本入口的立身之本）：
//   1. 通道是 shell:team（shell 自有命名空间），office:* 通道集合仍冻结为 8 个；
//   2. office-module.js 零改动（require 冻结 + 行数上限都保持）；
//   3. renderer 只发"用户意图"（控制），不写事实 —— 页面方法与 office:cancel 同构；
//   4. 主题（用户文本）不进 Team 事实 / office 快照 / status 返回。

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
  let parens = 0;
  let bodyStart = -1;
  for (let j = SRC.indexOf('(', start); j < SRC.length; j += 1) {
    if (SRC[j] === '(') parens += 1;
    else if (SRC[j] === ')') {
      parens -= 1;
      if (parens === 0) { bodyStart = SRC.indexOf('{', j); break; }
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

function stripComments(source) {
  let out = ''; let i = 0; const n = source.length;
  while (i < n) {
    const ch = source[i]; const next = source[i + 1];
    if (ch === '/' && next === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 2; out += ' '; continue; }
    if (ch === '/' && next === '/') { while (i < n && source[i] !== '\n') i += 1; out += ' '; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch; out += ch; i += 1;
      while (i < n) { if (source[i] === '\\') { out += source[i] + (source[i + 1] || ''); i += 2; continue; } out += source[i]; if (source[i] === q) { i += 1; break; } i += 1; }
      continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/**
 * 沙箱装配 main.js 的真函数。测试通过注入替换 rpc/openFollow，因此
 * getRuntimeUrl / createHarnessRpcWire / runtimeMux / app 的默认路径永不求值。
 */
function loadWiring(env = {}, office = null) {
  const repoRequire = Module.createRequire(path.join(ROOT, 'src/main.js'));
  const forbidden = (label) => () => { throw new Error(`offline test must not reach ${label}`); };
  const factory = new Function(
    'require', 'process', 'path', 'app', 'officeModuleInstance',
    'getRuntimeUrl', 'createHarnessRpcWire', 'harnessRpcDeps', 'runtimeMux', 'Date',
    `${extractFunction('officeTeamRealEnabled')}
     ${extractFunction('officeTeamExecutorDemoEnabled')}
     ${extractFunction('officeTeamDemoEnabled')}
     ${extractFunction('officeTeamRealTopic')}
     ${extractFunction('officeTeamUiEnabled')}
     const OFFICE_TEAM_GATE_CONFLICT = ${JSON.stringify('OFFICE_TEAM_GATE_CONFLICT')};
     const OFFICE_TEAM_UI_TOPIC_MAX = 2000;
     ${extractFunction('officeTeamRealStatus')}
     ${extractFunction('validateShellTeamPayload')}
     ${extractFunction('startTeamRealWithTopic')}
     ${extractFunction('registerShellTeamIpc')}
     let officeTeamRealInstance = null;
     return {
       gateReal: officeTeamRealEnabled, gateUi: officeTeamUiEnabled,
       gateDemo: officeTeamDemoEnabled, gateExec: officeTeamExecutorDemoEnabled,
       envTopic: officeTeamRealTopic,
       status: officeTeamRealStatus, validate: validateShellTeamPayload,
       start: startTeamRealWithTopic, register: registerShellTeamIpc,
       getInstance: () => officeTeamRealInstance,
       setInstance: (v) => { officeTeamRealInstance = v; },
     };`,
  );
  return factory(repoRequire, { env }, path,
    { getPath: () => { throw new Error('offline test must not reach app.getPath'); } },
    office,
    forbidden('getRuntimeUrl'), forbidden('createHarnessRpcWire'), forbidden('harnessRpcDeps'),
    { onItem: forbidden('runtimeMux.onItem'), openStream: forbidden('runtimeMux.openStream') },
    Date);
}

function makeOffice() {
  return officeModule.createOfficeModule({
    pack: PACK, seed: 'ui-entry-seed',
    config: { resultPresentationMs: 200, workstationAnchorSegmentMs: 120 },
    log: () => {},
  });
}

/** fake mux 式 IPC 注册器：收集 handler，可调用。 */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    call(channel, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: {} }, payload);
    },
  };
}

/** 可注入 deps：两条 fake 会话流 + tmp artifactDir + 可控时钟。 */
function makeDeps({ reviewerEnd = 'completed' } = {}) {
  const T0 = 1_700_000_000_000;
  const je = (type, data, seq) => ({ type, seq, time: T0 + seq, data });
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-ui-entry-'));
  let nowMs = T0;
  const clock = { nowMs: () => nowMs };
  const rpc = {
    calls: { create: 0, prompt: [], cancel: [] },
    async createSession() { rpc.calls.create += 1; return `sess-ui-${rpc.calls.create}`; },
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
        je('assistant/message', { content: [{ type: 'text', text: '# UI 链路研究笔记' }] }, 2),
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
  return { rpc, openFollow, artifactDir, clock, jobId: 'job-ui-1' };
}

const UI_ENV = Object.freeze({
  DSH_DESKTOP_OFFICE_TEAM_UI: '1',
  DSH_DESKTOP_OFFICE_TEAM_TOPIC_SECRET: 'x',
});

// ===========================================================================
// 1. 通道与门控
// ===========================================================================

test('team-ui: the channel is shell:team — office:* stays frozen at 8 channels', () => {
  assert.match(SRC, /ipcMain\.handle\('shell:team'/);
  const channels = /const OFFICE_IPC_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\);/
    .exec(fs.readFileSync(path.join(ROOT, 'src/office/office-module.js'), 'utf8'));
  assert.ok(channels);
  const list = channels[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.equal(list.length, 8, 'office:* must stay at exactly 8 channels');
  assert.equal(list.includes('office:team'), false);
  // preload 暴露的是 shell 通道直通（与 getTheme 同模式），不走 office 白名单。
  const preload = fs.readFileSync(path.join(ROOT, 'src/office/office-preload.js'), 'utf8');
  assert.match(preload, /team: \(payload\) => ipcRenderer\.invoke\('shell:team', payload\)/);
});

test('team-ui: the UI gate is default-off and independent of the env REAL gate', () => {
  const box = loadWiring({});
  assert.equal(box.gateUi(), false);
  assert.equal(box.gateReal(), false);
  assert.match(SRC, /function officeTeamUiEnabled\(\) \{\s*return process\.env\.DSH_DESKTOP_OFFICE_TEAM_UI === '1';/);
  // 第四个门是独立 env 变量。
  const vars = ['DSH_DESKTOP_OFFICE_TEAM_DEMO', 'DSH_DESKTOP_OFFICE_TEAM_EXECUTOR_DEMO',
    'DSH_DESKTOP_OFFICE_TEAM_REAL', 'DSH_DESKTOP_OFFICE_TEAM_UI'];
  assert.equal(new Set(vars).size, 4);
  for (const v of vars) assert.ok(SRC.includes(v));
});

test('team-ui: office-module.js is untouched by this feature (frozen requires + ceiling)', () => {
  // 本特性允许改的文件：main.js / office-preload.js / office-page.js / 测试。
  // office-module.js 一行都不该动 —— 冻结门禁继续成立（在 boundary 套件里逐字钉住，
  // 这里再从"本特性视角"断言一次：不包含 shell:team、不包含 team(。
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/office/office-module.js'), 'utf8'));
  assert.equal(src.includes('shell:team'), false);
  assert.equal(/function officeTeamUi|TEAM_UI/.test(src), false);
  const lines = fs.readFileSync(path.join(ROOT, 'src/office/office-module.js'), 'utf8').split('\n').length;
  assert.ok(lines <= 4800, `office-module.js is ${lines} lines (ceiling 4800)`);
});

// ===========================================================================
// 2. 载荷校验（validateShellTeamPayload）
// ===========================================================================

test('team-ui: payload validation is fail-closed with stable codes', () => {
  const box = loadWiring({});
  const v = box.validate;
  // 非对象 / 数组 / null。
  for (const bad of [null, 'x', 42, [], undefined]) {
    assert.equal(v(bad).code, 'PAYLOAD_INVALID', `${String(bad)} must be invalid`);
  }
  // 未知 action。
  assert.equal(v({ action: 'teleport' }).code, 'ACTION_UNKNOWN');
  assert.equal(v({}).code, 'ACTION_UNKNOWN');
  // status / resume 无参数要求。
  assert.equal(v({ action: 'status' }).ok, true);
  assert.equal(v({ action: 'resume' }).ok, true);
  // start：主题非空、trim、上限。
  assert.equal(v({ action: 'start', topic: '' }).code, 'TOPIC_REQUIRED');
  assert.equal(v({ action: 'start', topic: '   ' }).code, 'TOPIC_REQUIRED');
  assert.equal(v({ action: 'start', topic: 42 }).code, 'TOPIC_REQUIRED');
  assert.equal(v({ action: 'start', topic: 'x'.repeat(2001) }).code, 'TOPIC_TOO_LONG');
  const ok = v({ action: 'start', topic: '  调研主题  ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.topic, '调研主题', 'topic must be trimmed, not rewritten');
  assert.equal(v({ action: 'start', topic: 'x'.repeat(2000) }).ok, true);
});

// ===========================================================================
// 3. shell:team 处理器（抽取真函数 + fake ipcMain）
// ===========================================================================

test('team-ui: status reflects gate and active state without the topic', async () => {
  const box = loadWiring(UI_ENV);
  assert.deepEqual({ ...box.status() }, {
    ok: true, code: null, enabled: true, active: false, jobStatus: null, attentionRole: null,
  });
  // 无实例时 enabled=false 的门。
  const off = loadWiring({});
  assert.equal(off.status().enabled, false);
});

test('team-ui: start creates a real team through the core and reports status', async () => {
  const office = makeOffice();
  const box = loadWiring(UI_ENV, office);
  const ipc = fakeIpcMain();
  const logs = [];
  const deps = makeDeps();
  box.register(ipc, (l) => logs.push(l), deps);
  const result = await ipc.call('shell:team', { action: 'start', topic: '调研主题' });
  assert.equal(result.ok, true);
  assert.equal(result.active, true);
  assert.equal(box.getInstance() !== null, true, 'the core must register the instance');
  // 两条 prompt 真的发出（researcher 模板 + reviewer 内联）。
  await box.getInstance().whenDone;
  assert.equal(deps.rpc.calls.prompt.length, 2);
  assert.ok(deps.rpc.calls.prompt[0].text.includes('调研主题'));
  assert.ok(deps.rpc.calls.prompt[1].text.includes('# UI 链路研究笔记'));
  // 终态。
  const after = await ipc.call('shell:team', { action: 'status' });
  assert.equal(after.jobStatus, 'completed');
  // 物化文件真实存在。
  assert.equal(fs.existsSync(path.join(deps.artifactDir, deps.jobId, 'research-notes.md')), true);
});

test('team-ui: start refuses when the UI gate is off / env REAL on / already active / office missing', async () => {
  // 门关。
  {
    const box = loadWiring({}, makeOffice());
    const ipc = fakeIpcMain();
    box.register(ipc, () => {});
    const r = await ipc.call('shell:team', { action: 'start', topic: 'x' });
    assert.equal(r.code, 'TEAM_UI_DISABLED');
    assert.equal(box.getInstance(), null);
  }
  // env REAL 门同开（单实例：真实 Team 只能有一个来源）。
  {
    const env = { ...UI_ENV, DSH_DESKTOP_OFFICE_TEAM_REAL: '1' };
    const box = loadWiring(env, makeOffice());
    const ipc = fakeIpcMain();
    box.register(ipc, () => {});
    const r = await ipc.call('shell:team', { action: 'start', topic: 'x' });
    assert.equal(r.code, 'TEAM_ALREADY_ACTIVE');
  }
  // office 未就绪。
  {
    const box = loadWiring(UI_ENV, null);
    const ipc = fakeIpcMain();
    box.register(ipc, () => {});
    const r = await ipc.call('shell:team', { action: 'start', topic: 'x' });
    assert.equal(r.code, 'OFFICE_NOT_READY');
  }
  // 已有活动实例：核心的单实例守卫拒绝（TEAM_START_FAILED），且**不替换**在跑的实例。
  // 注意这里注入**有效** deps（rpc/follow 都能跑）—— 否则拒绝会来自 rpc 默认路径的
  // 失败而不是守卫本身，测试就测不到守卫（负向变异 U4 实测教训）。
  {
    const office = makeOffice();
    const box = loadWiring(UI_ENV, office);
    const existing = { detach: () => ({ ok: true }), runtime: { state: () => ({ runs: {}, status: 'running' }) } };
    box.setInstance(existing);
    const ipc = fakeIpcMain();
    const workingDeps = makeDeps();
    box.register(ipc, () => {}, workingDeps);
    const r = await ipc.call('shell:team', { action: 'start', topic: 'x' });
    assert.equal(r.code, 'TEAM_START_FAILED');
    assert.equal(box.getInstance(), existing, 'a running team must never be replaced');
    // 守卫生效的直接证据：没有任何新会话被创建（deps 完全可用却未被动用）。
    assert.equal(workingDeps.rpc.calls.create, 0, 'the guard must refuse before any session is created');
  }
});

test('team-ui: resume routes ONLY when a run is in attention', async () => {
  const office = makeOffice();
  const box = loadWiring(UI_ENV, office);
  const ipc = fakeIpcMain();
  box.register(ipc, () => {});
  // 无实例。
  assert.equal((await ipc.call('shell:team', { action: 'resume' })).code, 'TEAM_NOT_ACTIVE');
  // 有实例但不在 attention。
  const resumed = [];
  box.setInstance({
    detach: () => ({ ok: true }),
    runtime: { state: () => ({ status: 'running', runs: { researcher: { status: 'running' } } }) },
    controller: { resume: async (role) => { resumed.push(role); return { ok: true }; } },
  });
  assert.equal((await ipc.call('shell:team', { action: 'resume' })).code, 'NOT_IN_ATTENTION');
  assert.deepEqual(resumed, []);
  // 在 attention → resume 那个角色。
  box.setInstance({
    detach: () => ({ ok: true }),
    runtime: { state: () => ({ status: 'attention', runs: { researcher: { status: 'completed' }, reviewer: { status: 'attention' } } }) },
    controller: { resume: async (role) => { resumed.push(role); return { ok: true }; } },
  });
  const ok = await ipc.call('shell:team', { action: 'resume' });
  assert.equal(ok.ok, true);
  assert.deepEqual(resumed, ['reviewer']);
});

test('team-ui: blocked reviewer → attention → resume through the full real chain', async () => {
  // 完整链：UI start → reviewer blocked → status 显示 attention → resume → 完成。
  const office = makeOffice();
  const box = loadWiring(UI_ENV, office);
  const ipc = fakeIpcMain();
  const deps = makeDeps({ reviewerEnd: 'blocked' });
  box.register(ipc, () => {}, deps);
  const result = await ipc.call('shell:team', { action: 'start', topic: '调研主题' });
  assert.equal(result.ok, true);
  const instance = box.getInstance();
  await instance.whenDone;
  let status = await ipc.call('shell:team', { action: 'status' });
  assert.equal(status.jobStatus, 'attention');
  assert.equal(status.attentionRole, 'reviewer');
  // 恢复：controller.resume → Team startRun(attention→running) → executor.resume
  //（FakeExecutor 语义；真实链路中 resume 的执行侧语义见契约 §7.5）。
  // 这里 deps 的 reviewer 流已耗尽 —— resume 后 Team 回 running 且无新事件，
  // 驱动循环停在 running（诚实：等待真实执行侧的后续事件）。
  const resumeResult = await ipc.call('shell:team', { action: 'resume' });
  // resume 的 Team 侧命令必须成功（角色回 running）。
  assert.equal(resumeResult.ok, true, `resume failed: ${resumeResult.code}`);
  const state = instance.runtime.state();
  assert.equal(state.runs.reviewer.status, 'running', 'explicit resume must return the run to running');
  assert.equal(state.runs.reviewer.terminalEvidence, null);
});

// ===========================================================================
// 4. 隐私：主题（用户文本）不进 Team 事实 / status / office 快照
// ===========================================================================

test('team-ui: the topic never reaches Team facts, status, or the office snapshot', async () => {
  const office = makeOffice();
  const box = loadWiring(UI_ENV, office);
  const ipc = fakeIpcMain();
  const deps = makeDeps();
  box.register(ipc, () => {}, deps);
  await ipc.call('shell:team', { action: 'start', topic: 'TOPIC-SECRET-XYZ' });
  const instance = box.getInstance();
  await instance.whenDone;
  // Team 事实。
  const facts = JSON.stringify(instance.runtime.facts());
  assert.equal(facts.includes('TOPIC-SECRET-XYZ'), false);
  // status 返回：既不含主题原文（值级），也**根本没有** topic 字段（结构级 ——
  // 值级断言在 env 主题为空时会漏检，负向变异 U6 实测教训）。
  const statusResult = await ipc.call('shell:team', { action: 'status' });
  assert.equal('topic' in statusResult, false, 'status must not carry a topic field at all');
  const status = JSON.stringify(statusResult);
  assert.equal(status.includes('TOPIC-SECRET-XYZ'), false);
  // office 快照。
  const snapshot = JSON.stringify(office.state());
  assert.equal(snapshot.includes('TOPIC-SECRET-XYZ'), false);
  // 主题只出现在 prompt（壳→dsh 的调用参数）里。
  assert.ok(deps.rpc.calls.prompt[0].text.includes('TOPIC-SECRET-XYZ'));
});

// ===========================================================================
// 5. 页面控制器 API（真实 office-page 控制器 + 注入桥）
// ===========================================================================

test('team-ui: the page controller exposes team control with the same shape as cancel', async () => {
  const { createOfficePageController } = require('../src/office/office-page.js');
  const calls = [];
  const bridge = {
    getState: async () => null,
    cancel: async (p) => { calls.push(['cancel', p]); return { ok: true }; },
    team: async (p) => { calls.push(['team', p]); return { ok: true, active: false }; },
  };
  const page = createOfficePageController({ bridge });
  // 缺桥：BRIDGE_MISSING（与 cancel 同构的守卫）。
  const bare = createOfficePageController({ bridge: { getState: async () => null } });
  assert.equal((await bare.teamStatus()).code, 'BRIDGE_MISSING');
  assert.equal((await bare.teamStart('x')).code, 'BRIDGE_MISSING');
  assert.equal((await bare.teamResume()).code, 'BRIDGE_MISSING');
  // 形状收敛：status/resume 无参；start 非空/trim/上限，不生成不改写。
  await page.teamStatus();
  await page.teamResume();
  await page.teamStart('  主题  ');
  // 与 cancel 同构：返回 {ok:false, code}，不抛错。
  const empty = await page.teamStart('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'TOPIC_REQUIRED');
  const tooLong = await page.teamStart('x'.repeat(2001));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'TOPIC_TOO_LONG');
  assert.deepEqual(calls, [
    ['team', { action: 'status' }],
    ['team', { action: 'resume' }],
    ['team', { action: 'start', topic: '主题' }],
  ]);
  // 页面仍是 require-free（既有边界）。
  const pageSrc = fs.readFileSync(path.join(ROOT, 'src/office/office-page.js'), 'utf8');
  assert.equal(stripComments(pageSrc).match(/require\(/g), null, 'office-page must stay require-free');
});

test('team-ui: the page controller sends control only — no snapshot writes, no fact paths', () => {
  // 结构性：页面方法只调 bridge.team（控制通道），不存在任何写入快照/事实的路径。
  const pageSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/office/office-page.js'), 'utf8'));
  const teamBlock = pageSrc.slice(pageSrc.indexOf('async teamStatus()'), pageSrc.indexOf('async teamResume()', pageSrc.indexOf('async teamStatus()')));
  for (const pattern of [/ingest/, /noteRun/, /dispatchRun/, /createJob/, /applySnapshot/]) {
    assert.equal(pattern.test(teamBlock), false, `team control must not touch ${pattern}`);
  }
});
// ===========================================================================
// 6. 可见 UI：office.html 卡片骨架 + i18n 双语 + 结构性边界
// ===========================================================================

test('team-ui: the office panel carries the team card skeleton (hidden by default)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/office/office.html'), 'utf8');
  // 卡片存在且默认隐藏（enabled=false 时不渲染）。
  assert.match(html, /<section id="team-block"[^>]*hidden/);
  // 主题输入（唯一用户文本）+ 开始 + 继续。
  assert.match(html, /id="team-topic-input"[^>]*maxlength="2000"/);
  assert.match(html, /id="team-start-button"/);
  assert.match(html, /id="team-resume-button"/);
  // 状态只显示粗粒度枚举文案（i18n 键），不存在显示主题正文的节点。
  const block = html.slice(html.indexOf('id="team-block"'), html.indexOf('employee-list-block'));
  assert.equal(/team-topic-echo|topic-text|team-topic-value/.test(block), false,
    'the card must not carry a node for echoing the topic text');
  // 静态文案全部走共享词典（office.html 的既有纪律：无 CJK 字面量）。
  for (const m of block.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) {
    assert.match(m[1], /^office\.(team|panel)\./);
  }
});

test('team-ui: i18n carries both languages for every team key (no drift)', () => {
  const i18n = require('../src/i18n.js');
  const zh = i18n.STRINGS.zh;
  const en = i18n.STRINGS.en;
  const keys = Object.keys(zh).filter((k) => k.startsWith('office.team.') || k === 'office.panel.teamAria');
  assert.ok(keys.length >= 11, `expected the team copy set, got ${keys.length}`);
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh missing ${key}`);
    assert.equal(typeof en[key], 'string', `en missing ${key}`);
    assert.notEqual(zh[key], '', `zh empty ${key}`);
    assert.notEqual(en[key], '', `en empty ${key}`);
  }
  // html 引用的每个 team 键都在词典里。
  const html = fs.readFileSync(path.join(ROOT, 'src/office/office.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-placeholder)?="(office\.(?:team|panel\.teamAria)[^"]*)"/g)) {
    assert.ok(zh[m[1]], `html references missing key ${m[1]}`);
  }
});

test('team-ui: the card queries control state via shell:team — never from the snapshot', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/office/office.html'), 'utf8');
  const blockStart = html.indexOf('Harness v0.5：团队任务卡');
  const block = html.slice(blockStart, html.indexOf('function renderAll()', blockStart));
  // 状态来自 shell:team status（控制面），不是快照字段。
  assert.match(block, /bridge\.team\(\{ action: 'status' \}\)/);
  // 主题只随 submit 发送；错误/状态只显示词典文案。
  assert.match(block, /bridge\.team\(\{ action: 'start', topic \}\)/);
  assert.match(block, /tr\('office\.team\.error\.topicRequired'\)/);
  // 渲染函数不触碰任何 Team/执行内部（快照里也没有这些字段）。
  for (const pattern of [/runtime\.state|controller\.|teamRuntime|executionRef|exec-run/]) {
    assert.equal(pattern.test(block), false, `the card must not reach ${pattern}`);
  }
  // **不得伪造状态**：卡片只画 shell:team 返回的事实；缓存为空就是隐藏/空态，
  // 不允许兜底编一个"运行中"（负向变异 U10 实测教训 —— 假状态会让用户以为
  // 团队在干活，这正是本产品最忌讳的"动画伪装执行"）。
  assert.equal(/jobStatus\s*:\s*['"]/.test(block), false,
    'the card must never synthesize a status object (no fallback literals)');
});
