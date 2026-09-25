'use strict';

// test/office-render-wake-selfheal.test.js — 2026-09-25 唤醒自愈（P1）。
//
// 长稳报告缺陷（原话）："显示器唤醒/解锁后画面不会自愈：停在静止诊断态，要切
// 一次视图或点「重试渲染」（修法与方案已写清，未实施）"。
//
// 根因（探针实测，office-soak.js NOTE STATIC_WHILE_NOT_PRESENTED
// { code:"LOW_FPS_PERSISTENT", degraded:true, recoveryAttempts:0, screenLocked:true }）：
// 锁屏/息屏期间 Chromium 把页面节流到 ~1.3fps，而判据只区分「是否当前主视图」，
// 不区分「屏幕根本没有在呈现」——节流帧被当成持续低帧率锁进 static，且唤醒不产生
// 任何恢复沿（active 全程未变，setVisible(true) 永远走不到恢复分支）。
//
// 修法（两层，本文件逐条回归）：
//   ① 判据加「是否在呈现」层：main 进程 powerMonitor（lock-screen/unlock-screen/
//      suspend/resume，src/office/power-presentation.js）→ window-manager →
//      既有 office:visibility 载荷的 `presenting` 字段（无新通道，office:* 仍 8 个）
//      → 页面 → renderer.setPresenting。未呈现期间泵停 + 看门狗停 + 唤醒丢弃在途
//      窗口，恢复预算不消耗；
//   ② 唤醒沿（presenting false→true）恰好一次自动有界恢复（复用 attemptRecovery：
//      会话上限 3 仍生效、硬失败 WEBGL_INIT_FAILED / RENDERER_UNAVAILABLE 永不重试）。
//
// 全部驱动真实模块 + stub PIXI + 注入时钟/rAF/定时器：无真实定时器依赖（探针文件
// 轮询单测除外，单独标注）、无墙钟读取、无 Electron。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const officeRenderer = require('../src/office/render/pixi-office-renderer.js');
const officeLayout = require('../src/office/runtime/office-layout.js');
const officePage = require('../src/office/office-page.js');
const { wireOfficePresentationSignals } = require('../src/office/power-presentation.js');
const { createWindowManager } = require('../src/window-manager.js');

const LAYOUT_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
);
const OFFICE_POLICY = require('../src/office/render/fps-monitor.js').OFFICE_LOW_FPS_POLICY;

// ---------------------------------------------------------------------------
// Stub PIXI（与 office-render-foreground-recovery.test.js 同形：应用级 init 失败
// 门控 + 逐应用记录，测试可以精确数重建次数）
// ---------------------------------------------------------------------------

function makeStubPixi(options = {}) {
  const failInitFrom = Number.isInteger(options.failInitFrom) ? options.failInitFrom : Infinity;
  const record = { applications: [], destroyedApplications: [], destroyedTextures: 0, stateChanges: [] };

  class Observable {
    constructor(kind) {
      this.__kind = kind;
      this.__destroyed = false;
      this.children = [];
      this.parent = null;
      this.x = 0;
      this.y = 0;
      this.visible = true;
      this.alpha = 1;
      this.zIndex = 0;
      this.sortableChildren = false;
      this.eventMode = 'auto';
      this.cursor = 'default';
      this.hitArea = null;
      this.texture = null;
    }
    on() { return this; }
    addChild(...kids) {
      for (const kid of kids) {
        if (kid.parent) kid.parent.removeChild(kid);
        this.children.push(kid);
        kid.parent = this;
      }
      return kids[0];
    }
    removeChild(kid) {
      const i = this.children.indexOf(kid);
      if (i >= 0) this.children.splice(i, 1);
      if (kid) kid.parent = null;
      return kid;
    }
    sortChildren() {}
    destroy(opts) {
      this.__destroyed = true;
      for (const child of [...this.children]) {
        if (child && typeof child.destroy === 'function') child.destroy(opts);
      }
      this.children.length = 0;
      if (this.parent) this.parent.removeChild(this);
    }
  }
  class Container extends Observable {
    constructor() { super('Container'); }
  }
  class Sprite extends Observable {
    constructor(texture) { super('Sprite'); this.texture = texture || null; this.anchor = { set() {} }; this.scale = { set() {} }; }
  }
  class Graphics extends Observable {
    constructor() {
      super('Graphics');
      const chain = () => proxy;
      const proxy = new Proxy(this, { get(t, prop) { return prop in t ? t[prop] : chain; } });
      this.__proxy = proxy;
      return proxy;
    }
  }
  class Text extends Observable {
    constructor(text) { super('Text'); this.text = String(text); this.style = {}; this.anchor = { set() {} }; this.scale = { set() {} }; }
  }
  class Texture {
    constructor(id) { this.__id = id; this.width = 100; this.height = 100; }
    destroy() { record.destroyedTextures += 1; }
  }
  class Ticker {
    constructor() { this.started = false; }
    add() {}
    remove() {}
    start() { this.started = true; }
    stop() { this.started = false; }
  }
  class Application {
    constructor() {
      this.stage = new Container();
      this.ticker = new Ticker();
      this.renderer = { width: 0, height: 0, resize() {}, extract: { base64: async () => null } };
      this.canvas = { tagName: 'CANVAS', style: {}, parentNode: null };
      this.__destroyed = false;
      record.applications.push(this);
    }
    async init(opts) {
      const index = record.applications.indexOf(this);
      if (index >= failInitFrom) throw new Error(`stub init failure for application #${index} (${opts.preference})`);
      this.renderer.width = opts.width;
      this.renderer.height = opts.height;
    }
    destroy() { this.__destroyed = true; record.destroyedApplications.push(this); }
  }

  const PIXI = { Application, Container, Sprite, Graphics, Text, Texture, Ticker, VERSION: '8.5.2-stub' };
  return { PIXI, record };
}

// rAF 注入：与页面 requestAnimationFrame 相同的泵驱动形状。
function makeRaf() {
  const raf = {
    pending: null,
    handle: 0,
    fired: 0,
    canceled: 0,
    scheduleFrame(cb) {
      raf.handle += 1;
      raf.pending = { handle: raf.handle, cb };
      return raf.handle;
    },
    cancelFrame(handle) {
      raf.canceled += 1;
      if (raf.pending && raf.pending.handle === handle) raf.pending = null;
    },
  };
  return raf;
}

function makeClock() {
  return { nowMs: 0, now() { return this.nowMs; } };
}

function pumpAt(raf, clock, fps, frames) {
  const intervalMs = 1000 / fps;
  for (let i = 0; i < frames; i += 1) {
    clock.nowMs += intervalMs;
    const pending = raf.pending;
    if (pending) {
      raf.pending = null;
      raf.fired += 1;
      pending.cb();
    }
  }
}

// 「滞留帧」：门关上之前已经派发、取消没追上的回调（物理页面仍在出帧）。
function deliverStaleFrames(raf, clock, fps, frames) {
  const intervalMs = 1000 / fps;
  for (let i = 0; i < frames; i += 1) {
    clock.nowMs += intervalMs;
    const stale = raf.pending;
    if (stale) {
      raf.pending = null;
      raf.fired += 1;
      stale.cb();
    }
  }
}

// 可注入定时器（stall 看门狗用）。
function makeFakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    scheduled: 0,
    setTimeout(cb, ms) { id += 1; pending.set(id, { cb, ms }); return id; },
    clearTimeout(handle) { pending.delete(handle); },
    pendingCount: () => pending.size,
    fireAll() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, entry] of entries) entry.cb();
    },
  };
}

const SNAPSHOT = {
  schemaVersion: 1,
  simulatedAtMs: 0,
  paused: false,
  sync: 'healthy',
  scene: { referenceWidth: 1280, referenceHeight: 840 },
  employees: [
    { employeeId: 'orchestrator', displayName: '调度员', position: { x: 0.36, y: 0.495 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'researcher', displayName: '研究员', position: { x: 0.56, y: 0.495 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'coder', displayName: '编码员', position: { x: 0.5, y: 0.6 }, activity: 'working', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 1, marker: null },
    { employeeId: 'reviewer', displayName: '评审员', position: { x: 0.36, y: 0.755 }, activity: 'resting', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 0, marker: null },
    { employeeId: 'collaborator', displayName: '协作者', position: { x: 0.56, y: 0.755 }, activity: 'roaming', animation: { resource: 'idle', frameIndex: 0 }, queueCount: 2, marker: null },
  ],
  activityLog: [],
  diagnostics: [],
  capabilities: {},
};

const FPS_CONFIG = { thresholdFps: 30, windowFrames: 30, lowWindowLimit: 5 };

async function createView({ PIXI, raf, clock, onStateChange = null, fpsConfig = FPS_CONFIG, timers = null }) {
  return officeRenderer.createOfficeRenderer({
    PIXI,
    layout: officeLayout.createOfficeLayout(LAYOUT_FIXTURE),
    pack: null,
    textures: new Map(),
    scene: { width: 1280, height: 840 },
    snapshot: SNAPSHOT,
    devicePixelRatio: 1,
    onStateChange,
    fpsMonitor: {
      ...fpsConfig,
      ...(timers ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout } : {}),
      now: () => clock.nowMs,
      scheduleFrame: raf.scheduleFrame,
      cancelFrame: raf.cancelFrame,
    },
  });
}

// 用真实监视器把视图推到 static LOW_FPS_PERSISTENT（帧计数窗口形状：5 窗 × 30 帧
// @20fps）。M1 阶梯：full 档第一次 latch 降档 low-cost（场景仍活），第二次 latch
// 到 static——与生产一致的真实锁存路径。
function latchForReal(view, raf, clock) {
  const windowsPerLatch = FPS_CONFIG.windowFrames * FPS_CONFIG.lowWindowLimit;
  const before = view.diagnostics().lowFpsEvents;
  let steps = 0;
  if (view.diagnostics().renderProfile === 'full') {
    pumpAt(raf, clock, 20, windowsPerLatch);
    steps += 1;
    assert.equal(view.diagnostics().lowFpsEvents, before + steps, 'the first latch happened');
    assert.equal(view.diagnostics().renderProfile, 'low-cost', 'M1: the first latch downgrades the render profile');
    assert.equal(view.mode, 'webgl', 'M1: the scene is still LIVE after the first latch');
  }
  pumpAt(raf, clock, 20, windowsPerLatch);
  steps += 1;
  assert.equal(view.diagnostics().lowFpsEvents, before + steps, 'the static latch happened');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT');
}

// ---------------------------------------------------------------------------
// ① 未呈现期间不计入低帧判据、不消耗恢复预算
// ---------------------------------------------------------------------------

test('wake gate: presenting=false stops the pump, the stale deliveries feed nothing, and the watchdog stays disarmed', async () => {
  const { PIXI } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const timers = makeFakeTimers();
  const view = await createView({
    PIXI, raf, clock, timers,
    fpsConfig: { ...OFFICE_POLICY, now: undefined },
  });
  assert.equal(view.mode, 'webgl');
  assert.equal(view.diagnostics().presenting, true, 'presenting defaults to true');
  assert.equal(timers.pendingCount(), 1, 'the stall watchdog is armed while presenting');

  // 锁屏：真信号沿 office:visibility 的 presenting 字段到达 renderer。
  await view.setPresenting(false);
  assert.equal(view.diagnostics().presenting, false);
  assert.equal(raf.pending, null, 'the pump was canceled');
  assert.equal(raf.canceled >= 1, true);
  assert.equal(timers.pendingCount(), 0, 'the stall watchdog is disarmed while not presenting');

  // 锁屏期间物理页面仍以 ~1.3fps 出帧（滞留回调也追不上门），看门狗永远不会被
  // 重新武装：监视器什么也收不到，窗口计数冻结，不产生低帧事件。
  const statsBefore = view.fpsMonitor.stats();
  deliverStaleFrames(raf, clock, 1.3, 260);
  for (let i = 0; i < 10; i += 1) { clock.nowMs += 60_000; timers.fireAll(); }
  assert.equal(raf.handle, 1, 'a stale pump callback never re-schedules while not presenting');
  assert.equal(timers.pendingCount(), 0, 'no watchdog re-arms itself while not presenting');
  const statsAfter = view.fpsMonitor.stats();
  assert.equal(statsAfter.windows, statsBefore.windows, 'no measurement window was touched while not presenting');
  assert.equal(statsAfter.degraded, false, 'the throttled frames latched nothing');
  assert.equal(view.diagnostics().lowFpsEvents, 0);
  assert.equal(view.mode, 'webgl', 'the scene stays live through the lock');

  // 唤醒（恢复同值调用是 no-op）：测量窗口重置、泵重arm、看门狗回来。
  await view.setPresenting(true);
  assert.equal(view.diagnostics().presenting, true);
  assert.equal(raf.pending !== null, true, 'the pump is re-armed on wake');
  assert.equal(timers.pendingCount(), 1, 'the watchdog is re-armed on wake');
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 0, 'the wake discards any in-flight window');
  pumpAt(raf, clock, 60, OFFICE_POLICY.windowFrames * 2);
  assert.equal(view.fpsMonitor.stats().windows > 0, true, 'windows advance again after wake');
  assert.equal(view.mode, 'webgl');
  view.destroy();
});

test('wake gate: the pre-lock partial low window cannot poison the wake measurement (reset on the wake edge)', async () => {
  const { PIXI } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, raf, clock });
  // 锁屏前：1 个完整低窗口 + 半个在途窗口（consecutiveLowWindows=1）。
  pumpAt(raf, clock, 20, FPS_CONFIG.windowFrames + 10);
  assert.equal(view.fpsMonitor.stats().windows, 1);
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 1);

  await view.setPresenting(false);
  deliverStaleFrames(raf, clock, 1.3, 260); // 锁屏节流帧：一分不加
  await view.setPresenting(true);
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 0, 'the wake reset discarded the streak AND the in-flight window');
  assert.equal(view.fpsMonitor.stats().windows, 1, 'no new window was opened during the lock');
  // 唤醒后的健康测量从零开始：一个完整的高帧率窗口后依旧干净。
  pumpAt(raf, clock, 60, FPS_CONFIG.windowFrames * 5);
  assert.equal(view.fpsMonitor.degraded(), false);
  assert.equal(view.mode, 'webgl');
  view.destroy();
});

test('wake gate: (re)activating the view while the screen is NOT presenting consumes no recovery budget', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  latchForReal(view, raf, clock); // 静态 LOW_FPS_PERSISTENT
  assert.equal(view.diagnostics().recoveryAttempts, 0);

  // 锁屏期间视图被（自动化）切到前台再切回：未呈现，恢复必须被推迟而不是消费。
  await view.setPresenting(false);
  await view.setVisible(false);
  const reactivated = await view.setVisible(true);
  assert.equal(reactivated.recovery, 'none', 'no rebuild attempt while not presenting');
  assert.equal(record.applications.length, 1, 'no rebuild happened while not presenting');
  assert.equal(view.diagnostics().recoveryAttempts, 0, 'the budget is untouched');
  assert.equal(raf.pending, null, 'the pump is not armed while not presenting');

  // 唤醒沿接管：恰好一次恢复。
  const outcome = await view.setPresenting(true);
  assert.equal(outcome.recovery, 'recovered');
  assert.equal(view.mode, 'webgl');
  assert.equal(record.applications.length, 2, 'EXACTLY ONE rebuild, on the wake edge');
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  view.destroy();
});

// ---------------------------------------------------------------------------
// ② 唤醒触发恰好一次自动恢复（「已经是静态态」与「当时正常」两种开局）
// ---------------------------------------------------------------------------

test('wake self-heal: a wake edge rebuilds a latched static view EXACTLY once, with no user action', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const events = [];
  const view = await createView({ PIXI, record, raf, clock, onStateChange: (s) => events.push({ ...s }) });
  assert.equal(view.mode, 'webgl');

  // 开局 A：唤醒时视图已经停在 static LOW_FPS_PERSISTENT（长稳报告的实际形态）。
  latchForReal(view, raf, clock);
  assert.deepEqual(events.at(-1), { mode: 'static', diagnosticCode: 'LOW_FPS_PERSISTENT', recoveryAttempts: 0 });

  await view.setPresenting(false);
  const outcome = await view.setPresenting(true);
  assert.equal(outcome.recovery, 'recovered', 'the wake healed the view by itself');
  assert.equal(outcome.mode, 'webgl');
  assert.equal(view.mode, 'webgl', 'no view switch, no manual retry — the scene is back');
  assert.equal(view.diagnosticCode, null);
  assert.equal(record.applications.length, 2, 'EXACTLY ONE rebuild');
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  assert.equal(view.entities.size, 5, 'entities restored from the pushed snapshot');
  assert.equal(view.fpsMonitor.degraded(), false, 'the observer was re-armed fresh');
  assert.equal(raf.pending !== null, true, 'the pump is armed again');
  assert.deepEqual(events.at(-1), { mode: 'webgl', diagnosticCode: null, recoveryAttempts: 1 },
    'the shell-log report rode the existing onStateChange path');

  // 重复的唤醒同值调用（页面每次 visibility 事件都会重发 presenting）不再触发。
  await view.setPresenting(true);
  assert.equal(record.applications.length, 2, 'a redundant presenting=true never rebuilds again');
  assert.equal(view.diagnostics().recoveryAttempts, 1);

  // 再来一轮锁屏/唤醒（此时场景健康）：无恢复需要，预算不动。
  await view.setPresenting(false);
  deliverStaleFrames(raf, clock, 1.3, 260);
  const healthy = await view.setPresenting(true);
  assert.equal(healthy.recovery, 'none', 'a wake from a healthy scene attempts nothing');
  assert.equal(view.mode, 'webgl');
  assert.equal(record.applications.length, 2);
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  view.destroy();
});

test('wake self-heal: waking while the scene is healthy resumes measurement with a fresh window and attempts nothing', async () => {
  // 开局 B：唤醒时视图是正常的（锁屏前没 latch、锁屏期间也没 latch——修复后的常态）。
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  pumpAt(raf, clock, 20, FPS_CONFIG.windowFrames * 4); // 4 个低窗口，差 1 个 latch
  assert.equal(view.fpsMonitor.degraded(), false);

  await view.setPresenting(false);
  deliverStaleFrames(raf, clock, 1.3, 260);
  const outcome = await view.setPresenting(true);
  assert.equal(outcome.recovery, 'none');
  assert.equal(view.mode, 'webgl');
  assert.equal(record.applications.length, 1, 'no rebuild');
  assert.equal(view.diagnostics().recoveryAttempts, 0);
  // 唤醒重置了测量窗口：锁屏前的 4 连低窗口 streak 不能跨过唤醒沿。
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 0);
  // 唤醒后观测器仍是武装的：下一段真实的低帧率（5 连低窗口）照常走阶梯。
  pumpAt(raf, clock, 20, FPS_CONFIG.windowFrames * FPS_CONFIG.lowWindowLimit);
  assert.equal(view.diagnostics().lowFpsEvents, 1, 'the observer still catches genuine foreground degradation');
  assert.equal(view.diagnostics().renderProfile, 'low-cost');
  view.destroy();
});

test('wake self-heal: the wake heal works for a DETACHED (non-active) view too — pump stays disarmed', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  latchForReal(view, raf, clock);
  await view.setVisible(false); // harness 是当前主视图（办公室被摘出窗口）
  await view.setPresenting(false);

  const outcome = await view.setPresenting(true);
  assert.equal(outcome.recovery, 'recovered', 'the wake heals the background view (ready before the user switches back)');
  assert.equal(view.mode, 'webgl');
  assert.equal(record.applications.length, 2);
  assert.equal(raf.pending, null, 'a detached view still presents nothing — no pump');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ③ 会话上限仍然生效（唤醒自愈不绕过 3 次/会话）
// ---------------------------------------------------------------------------

test('wake self-heal: the per-session cap (3) still bounds wake rebuilds — the 4th wake stays exhausted and silent', async () => {
  const { PIXI, record } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    latchForReal(view, raf, clock);
    await view.setPresenting(false);
    const outcome = await view.setPresenting(true);
    assert.equal(outcome.recovery, 'recovered', `wake attempt ${attempt} recovers`);
    assert.equal(view.diagnostics().recoveryAttempts, attempt);
    assert.equal(record.applications.length, 1 + attempt);
  }

  // 第 4 次：会话预算耗尽——唤醒自愈同样不重建，稳定停在静态，无抖动。
  latchForReal(view, raf, clock);
  await view.setPresenting(false);
  const exhausted = await view.setPresenting(true);
  assert.equal(exhausted.recovery, 'exhausted');
  assert.equal(exhausted.mode, 'static');
  assert.equal(view.diagnosticCode, 'LOW_FPS_PERSISTENT', 'the diagnostic stays stable');
  assert.equal(record.applications.length, 4, 'the cap stopped the wake rebuild loop');
  assert.equal(view.diagnostics().recoveryAttempts, 3);

  await view.setPresenting(false);
  const again = await view.setPresenting(true);
  assert.equal(again.recovery, 'exhausted', 'further wakes stay silent too');
  assert.equal(record.applications.length, 4);
  view.destroy();
});

// ---------------------------------------------------------------------------
// ④ 硬失败不因唤醒而重试
// ---------------------------------------------------------------------------

test('wake self-heal: a rebuild that hits WEBGL_INIT_FAILED is never retried by later wakes', async () => {
  // boot 应用成功；每次重建应用都失败——唤醒自愈不允许绕过硬失败契约。
  const { PIXI, record } = makeStubPixi({ failInitFrom: 1 });
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI, record, raf, clock });
  assert.equal(view.mode, 'webgl');

  latchForReal(view, raf, clock);
  await view.setPresenting(false);
  const failed = await view.setPresenting(true);
  assert.equal(failed.recovery, 'failed');
  assert.equal(failed.mode, 'static');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED', 'a failed rebuild is a hard failure code');
  assert.equal(record.applications.length, 3, 'one rebuild attempt: webgl + canvas, both failed');
  assert.equal(view.diagnostics().recoveryAttempts, 1, 'the failed attempt still counts against the budget');

  // 后续唤醒沿不重试硬失败。
  await view.setPresenting(false);
  const second = await view.setPresenting(true);
  assert.equal(second.recovery, 'none', 'hard failures are never retried on wake');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'WEBGL_INIT_FAILED');
  assert.equal(record.applications.length, 3, 'no extra rebuild');
  assert.equal(view.diagnostics().recoveryAttempts, 1);
  view.destroy();
});

test('wake self-heal: RENDERER_UNAVAILABLE (no Pixi at all) is never woken into a rebuild', async () => {
  const raf = makeRaf();
  const clock = makeClock();
  const view = await createView({ PIXI: null, raf, clock });
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'RENDERER_UNAVAILABLE');

  await view.setPresenting(false);
  const outcome = await view.setPresenting(true);
  assert.equal(outcome.recovery, 'none');
  assert.equal(view.mode, 'static');
  assert.equal(view.diagnosticCode, 'RENDERER_UNAVAILABLE');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ③' 生产策略（时间窗 + 看门狗）：唤醒沿丢弃在途窗口（production shape 复核）
// ---------------------------------------------------------------------------

test('wake gate (production policy): a partial low-rate window open at lock time is discarded, not carried into the wake streak', async () => {
  const { PIXI } = makeStubPixi();
  const raf = makeRaf();
  const clock = makeClock();
  const timers = makeFakeTimers();
  const view = await createView({
    PIXI, raf, clock, timers,
    fpsConfig: { ...OFFICE_POLICY, now: undefined },
  });
  // 12fps 跑 4s：第一个 3s 窗以 ~12fps 关闭（低窗口，consecutive=1），第 2 窗开着。
  pumpAt(raf, clock, 12, 4 * 12);
  assert.equal(view.fpsMonitor.stats().windows, 1);
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 1);
  assert.equal(view.fpsMonitor.degraded(), false);

  await view.setPresenting(false);
  deliverStaleFrames(raf, clock, 1.3, 260);
  await view.setPresenting(true);
  assert.equal(view.fpsMonitor.stats().consecutiveLowWindows, 0, 'the wake reset the low streak');
  pumpAt(raf, clock, 60, OFFICE_POLICY.windowFrames * 2);
  assert.equal(view.fpsMonitor.degraded(), false, 'healthy post-wake frames never latch');
  assert.equal(view.mode, 'webgl');
  view.destroy();
});

// ---------------------------------------------------------------------------
// ⑤ 页面控制器：presenting 载荷 → renderer.setPresenting（缺省不触碰）
// ---------------------------------------------------------------------------

test('page controller: the push payload’s presenting flag drives renderer.setPresenting; legacy payloads touch nothing', async () => {
  const bridge = {
    calls: [],
    getState: async () => SNAPSHOT,
    notifyVisibility: (visible, renderer) => { bridge.calls.push([visible, renderer]); },
  };
  const presentingCalls = [];
  const renderer = {
    setVisible: () => Promise.resolve({ mode: 'webgl', diagnosticCode: null, recovery: 'none' }),
    setPresenting: (value) => { presentingCalls.push(value); return Promise.resolve({ mode: 'webgl', diagnosticCode: null, recovery: 'none' }); },
    diagnostics: () => ({ mode: 'webgl', diagnosticCode: null, recoveryAttempts: 0 }),
  };
  const page = officePage.createOfficePageController({ bridge, renderer });
  await page.init();

  page.handleVisibility({ visible: true, active: true, presenting: false });
  page.handleVisibility({ visible: true, active: true, presenting: true });
  page.handleVisibility({ visible: true, active: true, presenting: true }); // 同值重复（每次可见性事件都会重发）
  assert.deepEqual(presentingCalls, [false, true, true],
    'the controller forwards every presenting value verbatim — the DEDUP lives in the renderer (same-value calls are no-ops there)');

  // 旧载荷（无 presenting / 裸布尔）不触碰呈现门控——与 `active` 的向后兼容规则一致。
  page.handleVisibility({ visible: false, active: true });
  page.handleVisibility(false);
  assert.equal(presentingCalls.length, 3, 'absent presenting never calls setPresenting');
});

// ---------------------------------------------------------------------------
// ⑥ window-manager：呈现挂起经 office:visibility 载荷下发 + 去重
// ---------------------------------------------------------------------------

function stubBrowserWindowClass() {
  const instances = [];
  class StubWindow {
    constructor() {
      this.__destroyed = false;
      this.__visible = false;
      this.__minimized = false;
      this.__loadedUrls = [];
      this.__contentBounds = { x: 0, y: 0, width: 1280, height: 840 };
      this.handlers = new Map();
      instances.push(this);
      this.webContents = {
        loadURL: () => Promise.resolve(),
        loadFile: () => {},
        on: () => {},
        once: () => {},
        setWindowOpenHandler: () => {},
        reload: () => {},
        toggleDevTools: () => {},
      };
      this.contentView = {
        children: [],
        addChildView(v) { this.children.push(v); },
        removeChildView(v) { const i = this.children.indexOf(v); if (i >= 0) this.children.splice(i, 1); },
      };
    }
    on(event, cb) { this.handlers.set(event, cb); }
    loadURL(url) { this.__loadedUrls.push(url); return Promise.resolve(); }
    loadFile() {}
    getContentBounds() { return { ...this.__contentBounds }; }
    getBounds() { return { ...this.__contentBounds }; }
    setBounds() {}
    show() { this.__visible = true; if (this.handlers.has('show')) this.handlers.get('show')(); }
    hide() { this.__visible = false; if (this.handlers.has('hide')) this.handlers.get('hide')(); }
    isDestroyed() { return this.__destroyed; }
    isVisible() { return this.__visible; }
    isMinimized() { return this.__minimized; }
  }
  return { StubWindow, instances };
}

function stubViewClass(bucket) {
  return class StubView {
    constructor(opts) {
      this.opts = opts;
      this.bounds = null;
      this.sent = [];
      this.loaded = [];
      bucket.push(this);
      this.webContents = {
        loadURL: (url) => { this.loaded.push(url); return Promise.resolve(); },
        loadFile: () => {},
        send: (channel, payload) => { this.sent.push([channel, payload]); },
        on: () => {},
        once: () => {},
        setWindowOpenHandler: () => {},
        isDestroyed: () => false,
        close: () => {},
        reload: () => {},
        toggleDevTools: () => {},
      };
    }
    setBounds(bounds) { this.bounds = bounds; }
  };
}

function makeWindowManager(views) {
  const { StubWindow, instances } = stubBrowserWindowClass();
  const wm = createWindowManager({
    BrowserWindow: StubWindow,
    WebContentsView: stubViewClass(views),
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }), getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
    appName: 't', iconPath: () => null, themeBackground: () => '#000', resolvedTheme: 'dark',
    windowState: { load: () => null, save: () => {} }, windowStateFile: () => '/tmp/x',
    log: () => {}, t: () => 'x', lang: () => 'zh',
    settingsGet: () => ({}),
    getRuntimeUrl: () => '', getRuntimeChild: () => null,
    closeLoading: () => {}, startDeferredServices: () => {},
    computeCockpitBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    getCockpitRuntimeState: () => 'running', getUsageCache: () => null, costSnapshot: async () => null,
    getScheduledRunning: () => false, getRemoteStatus: () => ({}),
    appVersion: '0', dshHomeOf: () => '/tmp',
    buildSnapshot: () => ({}), runtimeInfo: () => ({}),
  });
  return { wm, instances };
}

test('window manager: presentation suspension rides the office:visibility payload (presenting field) and is deduplicated', () => {
  const views = [];
  const { wm, instances } = makeWindowManager(views);
  wm.createWindow('http://127.0.0.1:1/harness');
  const win = instances[0];
  win.show();
  const office = wm.showOfficeShellView({ url: 'office-runtime://local/office.html' });

  const visibilityPayloads = () => office.sent.filter(([channel]) => channel === 'office:visibility').map(([, payload]) => payload);
  const baseline = visibilityPayloads().at(-1);
  assert.equal(baseline.presenting, true, 'the baseline payload presents');
  assert.equal(baseline.visible, true);
  assert.equal(baseline.active, true);

  // 锁屏：载荷携带 presenting=false；同值重复调用不再推送（去重）。
  wm.setOfficePresentationSuspended(true);
  assert.equal(visibilityPayloads().at(-1).presenting, false);
  const countAfterLock = office.sent.length;
  wm.setOfficePresentationSuspended(true);
  assert.equal(office.sent.length, countAfterLock, 'a same-value call pushes nothing');

  // 唤醒：presenting=true（页面在这条推送上自愈）。
  wm.setOfficePresentationSuspended(false);
  assert.equal(visibilityPayloads().at(-1).presenting, true);
});

// ---------------------------------------------------------------------------
// ⑦ power-presentation：信号映射、去重、探针、可拆卸
// ---------------------------------------------------------------------------

function makeFakePowerMonitor() {
  const listeners = new Map();
  return {
    on(event, cb) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(cb); },
    removeListener(event, cb) { const arr = listeners.get(event) || []; const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1); },
    emit(event) { for (const cb of [...(listeners.get(event) || [])]) cb(); },
  };
}

test('power presentation wiring: lock/suspend suspend, unlock/resume resume, duplicate events are no-ops, stop() detaches', () => {
  const powerMonitor = makeFakePowerMonitor();
  const changes = [];
  const logs = [];
  const wiring = wireOfficePresentationSignals({
    powerMonitor,
    onSuspendedChanged: (suspended) => changes.push(suspended),
    log: (line) => logs.push(line),
  });

  powerMonitor.emit('lock-screen');
  assert.deepEqual(changes, [true]);
  assert.match(logs.at(-1), /\[office\] power lock-screen → presentation suspended/);
  powerMonitor.emit('suspend'); // 已挂起：同值 no-op（解锁+唤醒同到的双信号只算一次）
  assert.equal(changes.length, 1);
  powerMonitor.emit('unlock-screen');
  assert.deepEqual(changes, [true, false]);
  assert.match(logs.at(-1), /\[office\] power unlock-screen → presentation resumed/);
  powerMonitor.emit('resume');
  powerMonitor.emit('resume');
  assert.equal(changes.length, 2, 'duplicate resume events change nothing');

  // 探针驱动与真事件完全相同的处理函数（证据运行不能真锁屏幕）。
  wiring.probe(true, 'probe:locked');
  assert.deepEqual(changes, [true, false, true]);
  wiring.probe(true, 'probe:locked');
  assert.equal(changes.length, 3, 'the probe dedupes too');
  assert.equal(wiring.isSuspended(), true);

  wiring.stop();
  powerMonitor.emit('unlock-screen');
  assert.equal(changes.length, 3, 'stop() detached every listener');
  assert.equal(wiring.isSuspended(), true, 'stop() does not mutate state');
});

test('power presentation wiring: a missing callback or monitor degrades to an inert wiring', () => {
  const inert = wireOfficePresentationSignals({});
  assert.equal(typeof inert.probe, 'function');
  assert.equal(inert.isSuspended(), false);
  inert.probe(true); // never throws
  const powerMonitor = makeFakePowerMonitor();
  const noMonitorWiring = wireOfficePresentationSignals({ powerMonitor: null, onSuspendedChanged: () => {} });
  noMonitorWiring.probe(false);
  powerMonitor.emit('lock-screen'); // 没接线：无副作用
});

test('power presentation wiring: the probe file polling drives the same handler (evidence-only, real-timer)', async () => {
  // 仅证据路径的单测：真实 250ms 轮询 + 真实 700ms 等待（唯一一处真实定时器，
  // 单独标注）。生产路径（powerMonitor 事件）在上面是纯同步断言。
  const probeFile = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'office-wake-probe-')), 'power-state');
  fs.writeFileSync(probeFile, 'locked\n');
  const powerMonitor = makeFakePowerMonitor();
  const changes = [];
  const wiring = wireOfficePresentationSignals({
    powerMonitor,
    onSuspendedChanged: (suspended) => changes.push(suspended),
    probeFile,
    readFileSync: (file) => fs.readFileSync(file, 'utf8'),
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(changes, [true], 'the poll saw "locked" and suspended presentation');
  fs.writeFileSync(probeFile, 'unlocked');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.deepEqual(changes, [true, false], 'the poll saw "unlocked" and resumed');
  wiring.stop();
  fs.rmSync(path.dirname(probeFile), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ⑧ office.html + main.js 接线（源码即集成点，house style）
// ---------------------------------------------------------------------------

test('office.html: the presenting flag is tracked page-side and rides every visibility payload', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'office', 'office.html'), 'utf8');
  assert.match(html, /let officePresenting = true;/, 'presenting defaults to true before the first push');
  assert.match(html, /officePresenting = !\(payload && payload\.presenting === false\);/, 'the push payload updates the presenting flag');
  assert.match(html, /visibility\(\{ visible: document\.visibilityState === 'visible', active: officeActive, presenting: officePresenting \}\)/, 'visibilitychange carries presenting');
  assert.match(html, /page\.handleVisibility\(\{ visible: document\.visibilityState === 'visible', active: officeActive, presenting: officePresenting \}\)/, 'renderer state reports carry presenting too');
});

test('main.js: powerMonitor is wired to the shell presentation state with the evidence probe hook', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(main, /const \{ app, BrowserWindow,[^}]*\bpowerMonitor\b[^}]*\} = require\('electron'\);/, 'powerMonitor is imported from electron');
  assert.match(main, /wireOfficePresentationSignals\(\{/, 'the presentation wiring is instantiated');
  assert.match(main, /onSuspendedChanged: \(suspended\) => windowManager\.setOfficePresentationSuspended\(suspended\)/, 'the wiring feeds the window manager');
  assert.match(main, /DSH_OFFICE_POWER_PROBE/, 'the evidence probe hook is env-guarded');
});
