'use strict';

// P1 运行时体检（2026-09-26）——三项办公室运行时体检的回归钉：
//   1) 诊断环退避：同码窗口合并（首现必留、重复折叠计数、他码不受挤占）、
//      窗口过期重开、阈值可配（0 = 旧行为）。驱动器是真实产品路径
//      （queued 子代理的终端证据 runId 校验失败 → RUN_ID_MISMATCH 诊断，
//      一次事件一条 = 实测 ROUTE_UNAVAILABLE 每 tick 一条的同频形态）。
//   2) 仿真时钟节流：墙钟驱动器的有界补步（落后多少补多少、封顶、丢陈账）
//      与诊断块（clockDiagnostics：fires/ticks/catchUp/behind/simPerWall）。
//      仿真语义不变：每个被驱动的 tick 仍然恒定 +16ms logicalMs。
//   3) 子代理座位的工具短语链路：子会话的 tool/call → 座位 toolKind/toolPhrase。
//      两条投递路径都要通：live 事件（main.js 预翻译 {tool}）与 follow 开窗/
//      resync 回放（0.1.5 journal 原始形状 {callId, name, arguments}）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');
const { createSubagentWiring } = require('../src/office/runtime/subagent-wiring.js');
const { createRuntimeAdapter } = require('../src/office/runtime/runtime-adapter.js');
const { TICK_MS } = require('../src/office/office-module.js');

const FIXTURE_PACK_ROOT = path.join(ROOT, 'src', 'office', 'fixtures', 'character-pack');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(FIXTURE_PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;

const PARENT = 'session-checkup-parent';

function makeHarness(options = {}) {
  const logLines = [];
  const module = officeModule.createOfficeModule({
    pack: PACK,
    seed: 'office-runtime-checkup-seed',
    config: { resultPresentationMs: 300, workstationAnchorSegmentMs: 160 },
    log: (line) => logLines.push(line),
    ...options,
  });
  const wiring = createSubagentWiring({
    emit: (sessionId, value) => module.ingestHarnessEvent({
      sessionId, type: value.type, seq: value.seq ?? undefined, time: value.time, data: value.data,
    }),
    log: (line) => logLines.push(line),
  });
  let seq = 0;
  function feed(type, data) {
    seq += 1;
    if (wiring.handleEvent(PARENT, { type, seq, time: seq, data })) return seq;
    module.ingestHarnessEvent({ sessionId: PARENT, type, seq, time: seq, data });
    return seq;
  }
  return { module, feed, logLines };
}

function diagEntries(module, code) {
  return module.diagnostics().diagnostics.filter((entry) => entry.code === code);
}

// ---- 1) 诊断环退避 ----------------------------------------------------------

/** 把三个分类座位占住，再排队第四个分类子代理（留一个可反复触发的
 * RUN_ID_MISMATCH 驱动器：queued 子代理收到 runId 不符的终端证据）。 */
function queueFourthClassifiedChild(feed) {
  feed('agent/status', { status: 'running' }); // orchestrator 上工
  feed('subagent/catalog', { version: 0, childId: 'child-researcher', childCreatedAt: 1, mode: 'one-shot', label: 'research the topic' });
  feed('subagent/catalog', { version: 0, childId: 'child-coder', childCreatedAt: 2, mode: 'one-shot', label: 'implement the parser' });
  feed('subagent/catalog', { version: 0, childId: 'child-reviewer', childCreatedAt: 3, mode: 'one-shot', label: 'review the code' });
  feed('subagent/catalog', { version: 0, childId: 'child-queued', childCreatedAt: 4, mode: 'one-shot', label: 'research more' });
  const queued = feed('agent/status', { status: 'running' }); // 任意事件推进（非必须，仅保序）
  void queued;
}

/** 每次调用 = 一条 RUN_ID_MISMATCH 诊断（真实产品路径：queued 子代理收到
 * runId 不符的 completed 终端证据，fail-closed 拒绝关闭队列项）。 */
function floodOnce(module, feed, salt) {
  feed('subagent/end', { id: 'child-queued', runId: `wrong-run-${salt}`, stopReason: 'completed' });
  void module;
}

test('diagnostics ring: same-code repeats fold into one counted entry (first occurrence kept)', () => {
  const { module, feed } = makeHarness();
  queueFourthClassifiedChild(feed);
  const firstAt = module.diagnostics().simulatedAtMs;
  const N = 50;
  for (let i = 0; i < N; i += 1) floodOnce(module, feed, i);

  const entries = diagEntries(module, 'RUN_ID_MISMATCH');
  assert.equal(entries.length, 1, `one folded entry, got ${entries.length}`);
  assert.equal(entries[0].count, N, 'the fold carries the FULL occurrence count');
  assert.equal(entries[0].atMs, firstAt, 'the FIRST occurrence instant is kept');
  assert.equal(entries[0].lastAtMs, firstAt, 'all repeats landed on the same logical instant');
  // 旧行为是 50 条：退避后环里只占 1 条——这就是"刷屏不再挤占窗口"的断言。
});

test('diagnostics ring: OTHER codes stay visible while one code floods', () => {
  const { module, feed } = makeHarness();
  queueFourthClassifiedChild(feed);
  for (let i = 0; i < 50; i += 1) {
    floodOnce(module, feed, i);
    if (i === 25) feed('agent/status', { status: 'bogus-status' }); // AGENT_STATUS_UNKNOWN 诊断
  }
  const unknown = diagEntries(module, 'AGENT_STATUS_UNKNOWN');
  assert.equal(unknown.length, 1, 'the interleaved low-frequency diagnostic survives');
  assert.equal(unknown[0].count, 1);
  const flooded = diagEntries(module, 'RUN_ID_MISMATCH');
  assert.equal(flooded.length, 1, 'the flood still folds to one entry');
  assert.equal(flooded[0].count, 50);
});

test('diagnostics ring: window expiry re-opens a new folded entry', () => {
  const { module, feed } = makeHarness();
  queueFourthClassifiedChild(feed);
  for (let i = 0; i < 10; i += 1) floodOnce(module, feed, i);
  // 推进逻辑时间越过默认窗口（5000ms / 16ms ≈ 313 tick）。
  for (let i = 0; i < 330; i += 1) module.tickOnce();
  for (let i = 0; i < 5; i += 1) floodOnce(module, feed, 100 + i);

  const entries = diagEntries(module, 'RUN_ID_MISMATCH');
  assert.equal(entries.length, 2, 'a new window after expiry');
  assert.equal(entries[0].count, 10);
  assert.equal(entries[1].count, 5);
  assert.ok(entries[1].atMs > entries[0].atMs, 'the second window starts later (logical time)');
});

test('diagnostics ring: dedupWindowMs=0 restores the legacy one-entry-per-occurrence ring', () => {
  const { module, feed } = makeHarness({ diagnosticsDedupWindowMs: 0 });
  queueFourthClassifiedChild(feed);
  for (let i = 0; i < 12; i += 1) floodOnce(module, feed, i);
  const entries = diagEntries(module, 'RUN_ID_MISMATCH');
  assert.equal(entries.length, 12, 'no merging: every occurrence takes a ring slot (the pre-fix flood shape)');
  for (const entry of entries) assert.equal(entry.count, 1);
});

test('diagnostics ring: custom window widens the fold; invalid values fall back to the default', () => {
  const { module, feed } = makeHarness({ diagnosticsDedupWindowMs: 1000 });
  queueFourthClassifiedChild(feed);
  for (let i = 0; i < 6; i += 1) floodOnce(module, feed, i);
  for (let i = 0; i < 40; i += 1) module.tickOnce(); // 640ms < 1000ms：仍在窗口内
  floodOnce(module, feed, 50);
  let entries = diagEntries(module, 'RUN_ID_MISMATCH');
  assert.equal(entries.length, 1, 'still one entry inside the custom window');
  assert.equal(entries[0].count, 7);

  const fallback = makeHarness({ diagnosticsDedupWindowMs: -3 });
  queueFourthClassifiedChild(fallback.feed);
  for (let i = 0; i < 8; i += 1) floodOnce(fallback.module, fallback.feed, i);
  entries = diagEntries(fallback.module, 'RUN_ID_MISMATCH');
  assert.equal(entries.length, 1, 'an invalid window falls back to the 5000ms default and folds');
  assert.equal(entries[0].count, 8);
});

// ---- 2) 仿真时钟：有界补步 + 诊断块 -----------------------------------------

function fakeClockHarness({ catchUp } = {}) {
  let wall = 0;
  const { module } = makeHarness({
    ...(catchUp === undefined ? {} : { clockMaxCatchUpTicks: catchUp }),
    realClock: () => wall,
  });
  return { module, setWall: (v) => { wall = v; }, getWall: () => wall };
}

test('clock driver: bounded catch-up runs extra fixed steps when the fire is late, drops the stale debt', () => {
  const h = fakeClockHarness();
  h.setWall(0);
  h.module.debugClockFire(); // 第一次 fire：只走常规 1 步，锚点 = 0
  let diag = h.module.clockDiagnostics();
  assert.equal(diag.fires, 1);
  assert.equal(diag.ticks, 1);
  assert.equal(diag.catchUpTicks, 0);

  h.setWall(200); // 一次 fire 迟到 184ms：补 2 步（封顶），陈账 136ms 丢弃
  h.module.debugClockFire();
  diag = h.module.clockDiagnostics();
  assert.equal(diag.fires, 2);
  assert.equal(diag.ticks, 4, '1 regular + 2 catch-up = 3 ticks this fire');
  assert.equal(diag.catchUpTicks, 2);
  assert.equal(diag.catchUpBatches, 1);
  assert.equal(diag.maxBehindMs, 184);
  assert.equal(diag.lateFires, 1, 'interval 200ms > 24ms threshold');
  assert.equal(diag.droppedDebtMs, 136, '200 - 3*16 = 152ms behind; 184ms debt - 48ms recovered = 136ms dropped');
  // 仿真时间只吃固定步：4 ticks = 64ms logicalMs，绝不因补步改步长。
  assert.equal(h.module.diagnostics().simulatedAtMs, 4 * TICK_MS);
});

test('clock driver: clockMaxCatchUpTicks=0 disables catch-up (legacy one step per fire)', () => {
  const h = fakeClockHarness({ catchUp: 0 });
  h.setWall(0);
  h.module.debugClockFire();
  h.setWall(200);
  h.module.debugClockFire();
  const diag = h.module.clockDiagnostics();
  assert.equal(diag.ticks, 2, 'one step per fire, no catch-up');
  assert.equal(diag.catchUpTicks, 0);
  assert.equal(diag.catchUpBatches, 0);
  assert.equal(diag.droppedDebtMs, 168, 'the debt beyond the regular step is dropped (184-16)');
});

test('clock driver: paused clock neither advances nor counts ticks; out-of-range cap falls back', () => {
  const h = fakeClockHarness({ catchUp: 99 }); // 越界 → 回落默认 2
  h.module.noteVisibility({ viewId: 'view-a', visible: true }); // 唯一可见视图
  h.module.noteVisibility({ viewId: 'view-a', visible: false }); // 全部隐藏 → 暂停
  h.setWall(0);
  h.module.debugClockFire();
  h.setWall(160);
  h.module.debugClockFire();
  const diag = h.module.clockDiagnostics();
  assert.equal(diag.ticks, 0, 'paused fires advance nothing');
  assert.equal(h.module.diagnostics().simulatedAtMs, 0);
  assert.equal(diag.maxCatchUpTicks, 2, 'invalid option falls back to the documented default');
});

test('clock diagnostics block: shape and simulatedPerWall ratio', () => {
  const h = fakeClockHarness();
  h.setWall(0);
  h.module.debugClockFire();
  h.setWall(320); // 迟到 304ms：补 2 步 → 本 fire 共 3 步，陈账 256ms 丢弃
  h.module.debugClockFire();
  const diag = h.module.clockDiagnostics();
  for (const key of ['running', 'tickMs', 'maxCatchUpTicks', 'fires', 'ticks', 'catchUpTicks', 'lateFires',
    'maxBehindMs', 'droppedDebtMs', 'tickBodyMaxMs', 'simulatedPerWall', 'eventLoop', 'gc']) {
    assert.ok(Object.prototype.hasOwnProperty.call(diag, key), `clock block carries ${key}`);
  }
  // 4 ticks = 64ms 仿真 / 320ms 墙钟 = 0.2x（这正是性能专项 0.83x 的度量位——
  // 有界补步把它从 0.83x 拉回接近 1.0x，但不能追回已丢弃的陈账）。
  assert.equal(diag.simulatedPerWall, 0.2);
  // office:diagnostics 响应带同一个块（不加新通道）。
  assert.equal(h.module.diagnostics().clock.simulatedPerWall, 0.2);
});

test('clock driver: real setInterval advances sim time at ~1.0x on an idle loop (catch-up on)', async () => {
  const { module } = makeHarness(); // 默认 clockMaxCatchUpTicks=2
  module.start();
  assert.equal(module.clockDiagnostics().running, true, 'start() marks the driver running');
  await new Promise((resolve) => setTimeout(resolve, 400));
  module.stop();
  const diag = module.clockDiagnostics();
  assert.ok(diag.fires >= 5, `the wall driver fired (${diag.fires})`);
  assert.ok(diag.ticks >= diag.fires, 'every fire runs at least one step');
  assert.ok(diag.simulatedPerWall !== null && diag.simulatedPerWall > 0.5 && diag.simulatedPerWall < 2.0,
    `idle sim/wall ratio near 1.0 (got ${diag.simulatedPerWall})`);
});

// ---- 3) 子代理座位的工具短语链路 ---------------------------------------------

function seatOf(module, id) {
  return module.state().employees.find((candidate) => candidate.employeeId === id);
}

test('tool phrase: LIVE child tool/call (pre-translated {tool}) lights the classified seat', () => {
  const { module, feed } = makeHarness();
  feed('agent/status', { status: 'running' });
  feed('subagent/catalog', { version: 0, childId: 'child-coder-live', childCreatedAt: 2, mode: 'one-shot', label: 'implement the parser' });
  const seq = module.ingestHarnessEvent({
    sessionId: 'child-coder-live', type: 'tool/call', seq: 1, time: 1, data: { tool: 'bash' },
  });
  assert.equal(seq.status, 'accepted');
  const coder = seatOf(module, 'coder');
  assert.equal(coder.toolKind, 'bash');
  assert.equal(coder.toolPhrase, '执行命令');
  assert.equal(coder.toolPhraseKey, 'command');
});

test('tool phrase: WINDOW replay of the raw 0.1.5 journal shape ({name}) lights the seat too', () => {
  const { module, feed } = makeHarness();
  feed('agent/status', { status: 'running' });
  feed('subagent/catalog', { version: 0, childId: 'child-coder-window', childCreatedAt: 2, mode: 'one-shot', label: 'implement the parser' });
  // follow 开窗/resync 回放路径：0.1.5 journal 记录原样交给模块（main.js 不翻译）。
  const res = module.ingestHarnessSnapshot({
    sessionId: 'child-coder-window',
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } } },
      { type: 'event', event: { type: 'tool/call', seq: 2, time: 11, data: { callId: 'c1', name: 'Read', arguments: { file_path: 'x' } } } },
      { type: 'event', event: { type: 'tool/call', seq: 3, time: 12, data: { callId: 'c2', name: 'bash', arguments: { command: 'ls' } } } },
    ],
  });
  assert.equal(res.ok, true, `snapshot accepted (${res.code || 'ok'})`);
  const coder = seatOf(module, 'coder');
  assert.equal(coder.toolKind, 'bash', 'the LAST replayed tool call wins');
  assert.equal(coder.toolPhrase, '执行命令');
  // 中间那条 Read 也真实发生过：日记录的常用工具计数包含两类（phrase/key 形态）。
  const toolKeys = ((coder.record && coder.record.tools) || []).map((t) => t.key);
  assert.ok(toolKeys.includes('search') && toolKeys.includes('command'), `both tools tallied: ${toolKeys}`);
});

test('tool phrase: a replayed window-only session keeps the real tool name (was tool:null pre-fix)', () => {
  const { module, feed } = makeHarness();
  feed('agent/status', { status: 'running' });
  feed('subagent/catalog', { version: 0, childId: 'child-coder-window2', childCreatedAt: 2, mode: 'one-shot', label: 'implement the parser' });
  // 修复前的形状钉：开窗里唯一的 tool/call 以 0.1.5 原始形状（data.name）到达，
  // 旧映射产出 tool:null → 座位 toolKind 被写成 null（更糟：还会清掉已有值）。
  const res = module.ingestHarnessSnapshot({
    sessionId: 'child-coder-window2',
    records: [
      { type: 'event', event: { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c0', name: 'Grep', arguments: {} } } },
    ],
  });
  assert.equal(res.ok, true);
  const coder = seatOf(module, 'coder');
  // 大写开头的工具名在快照里被隐私 redactor 涂成粗粒度文本（既有一等约束，
  // 非 本次改动），但短语 key 必须是真实的 'read' → search 家族——修复前这里
  // 是 tool:null → 'other'/null。
  assert.equal(coder.toolPhraseKey, 'search');
  assert.equal(coder.toolPhrase, '查档案');
});

test('tool phrase: adapter maps BOTH tool/call shapes identically (unit pin on the fix)', () => {
  const outputs = [];
  const adapter = createRuntimeAdapter({
    sessionId: 's',
    onEvent: (output) => outputs.push(output),
  });
  adapter.ingest({ type: 'tool/call', seq: 1, time: 1, data: { tool: 'Legacy' } });
  adapter.ingest({ type: 'tool/call', seq: 2, time: 2, data: { callId: 'c', name: 'Modern', arguments: {} } });
  const tools = outputs.map((o) => o.facts.find((f) => f.type === 'runtime/tool')).map((f) => f.tool);
  assert.deepEqual(tools, ['Legacy', 'Modern']);
});

test('office:* IPC channels stay exactly eight (no new channel for the checkup work)', () => {
  // 通道名单来自模块源码常量；这里以快照断言钉死（体检工作全部复用现有通道）。
  const source = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office-module.js'), 'utf8');
  const match = /const OFFICE_IPC_CHANNELS = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(source);
  assert.ok(match, 'channel constant found');
  const channels = match[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(channels, [
    'office:state', 'office:dispatch', 'office:cancel', 'office:interrupt',
    'office:settings', 'office:diagnostics', 'office:visibility', 'office:pending',
  ]);
});
