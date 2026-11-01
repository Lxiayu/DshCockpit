// test/ipc-scheduled.test.js — Issue #22 Phase 1：定时任务域。
//
// 第一性原理：为什么 scheduled 不只是"读配置"
//
//   这 6 个 handler 里藏着三段域知识，它们都不是"接线"：
//
//   1. **计划语义变更时必须丢弃 nextRunAt**
//      用户把"每 3600 秒"改成"每 60 秒"，若保留旧 nextRunAt，调度器会在
//      **旧计划的时间点**触发。这个 bug 在 UI 上完全看不出来（任务列表正常），
//      只会表现为"改了计划但不按新计划跑"。
//
//   2. **run 的并发去重 + finally 清理**
//      同一任务不能同时跑两次；且无论成功失败都要落盘 nextRunAt/lastRunAt，
//      否则 UI 永远显示"运行中"。
//
//   3. **每次变更都要重启调度器 + 广播**
//      少了重启 → 任务不再触发；少了广播 → UI 显示过期状态。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerScheduledIpc } = require('../src/ipc-scheduled.js');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, fn) {
      if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
      handlers.set(channel, fn);
    },
    invoke(channel, ...args) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn({ sender: null }, ...args);
    },
    channels() { return [...handlers.keys()].sort(); },
  };
}

function fakeCtx(over = {}) {
  const state = {
    data: { scheduledTasks: [], scheduledHistory: [] },
    patches: [], saves: 0, restarts: 0, broadcasts: 0,
    running: new Set(),
  };
  const base = {
    settings: {
      get: () => ({ ...state.data }),
      patch: (p) => { state.patches.push(p); Object.assign(state.data, p); },
      save: () => { state.saves += 1; },
    },
    scheduledRunning: state.running,
    startScheduler: () => { state.restarts += 1; },
    broadcastScheduled: () => { state.broadcasts += 1; },
    runScheduledTask: async () => ({ ok: true }),
    notify: () => {},
    t: (lang, key) => key,
    lang: () => 'zh',
  };
  return { ctx: { ...base, ...over }, state };
}

function register(over) {
  const ipc = fakeIpcMain();
  const { ctx, state } = fakeCtx(over);
  registerScheduledIpc(ipc, ctx);
  return { ipc, state };
}

test('ipc-scheduled: registers exactly the 6 scheduled channels', () => {
  const { ipc } = register();
  assert.deepEqual(ipc.channels(), [
    'shell:scheduled-clear-history', 'shell:scheduled-history', 'shell:scheduled-list',
    'shell:scheduled-remove', 'shell:scheduled-run', 'shell:scheduled-upsert',
  ]);
});

// ------------------------------------------- 计划语义变更（最隐蔽的 bug）

test('ipc-scheduled: changing the schedule DISCARDS the stale nextRunAt', async () => {
  // 用户把 every 3600 → every 60。若保留旧 nextRunAt，会在旧时间点触发。
  const { ipc, state } = register();
  state.data.scheduledTasks = [
    { id: 't1', kind: 'every', everySeconds: 3600, name: 'old', nextRunAt: 999999 },
  ];
  await ipc.invoke('shell:scheduled-upsert', { id: 't1', kind: 'every', everySeconds: 60, name: 'new' });

  const saved = state.data.scheduledTasks.find((tk) => tk.id === 't1');
  assert.strictEqual(saved.everySeconds, 60, 'the new plan is stored');
  assert.strictEqual(saved.nextRunAt, undefined,
    'the stale nextRunAt MUST be dropped — otherwise it fires at the old moment');
});

test('ipc-scheduled: an UNCHANGED plan does NOT clear nextRunAt that the caller passed back', async () => {
  // 注意既有行为：upsert 会从**入参**重建 nextRunAt（`Number(task.nextRunAt) || undefined`），
  // 不是从旧记录继承。所以"保留计划"要求调用方把 nextRunAt 传回来
  // （设置页确实是这么做的：它先拿到完整任务对象再提交）。
  // 这里锁住的是：计划未变时，传回来的 nextRunAt 不会被清掉。
  const { ipc, state } = register();
  state.data.scheduledTasks = [
    { id: 't1', kind: 'every', everySeconds: 3600, name: 'n', nextRunAt: 12345 },
  ];
  await ipc.invoke('shell:scheduled-upsert', {
    id: 't1', kind: 'every', everySeconds: 3600, name: 'n2', nextRunAt: 12345,
  });
  const saved = state.data.scheduledTasks.find((tk) => tk.id === 't1');
  assert.strictEqual(saved.nextRunAt, 12345, 'an identical plan keeps the schedule it was given');
  assert.strictEqual(saved.name, 'n2', 'but other fields still update');
});

test('ipc-scheduled: changing only the KIND also discards nextRunAt', async () => {
  const { ipc, state } = register();
  state.data.scheduledTasks = [{ id: 't1', kind: 'every', everySeconds: 3600, nextRunAt: 555 }];
  await ipc.invoke('shell:scheduled-upsert', { id: 't1', kind: 'daily', dailyTime: '08:00' });
  const saved = state.data.scheduledTasks.find((tk) => tk.id === 't1');
  assert.strictEqual(saved.nextRunAt, undefined, 'a kind change is a plan change');
});

test('ipc-scheduled: a NEW task never carries a nextRunAt (scheduler plans it)', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:scheduled-upsert', { kind: 'every', everySeconds: 120, nextRunAt: 1 });
  const saved = state.data.scheduledTasks[0];
  assert.match(saved.id, /^task-\d+$/, 'a new task gets a generated id');
  assert.strictEqual(saved.nextRunAt, undefined);
});

// ------------------------------------------------------- 输入清理

test('ipc-scheduled: upsert sanitises hostile input instead of trusting it', async () => {
  const { ipc, state } = register();
  await ipc.invoke('shell:scheduled-upsert', {
    kind: 'nonsense',
    everySeconds: -5,
    dailyTime: 'not-a-time',
    weeklyDay: 99,
    name: 'x'.repeat(500),
    prompt: 'y'.repeat(9000),
    enabled: 'yes', // truthy but not `false`
  });
  const saved = state.data.scheduledTasks[0];
  assert.strictEqual(saved.kind, 'every', 'an unknown kind falls back to every');
  // Math.max(60, Number(-5) || 3600) → -5 是有限数，所以取 max(60, -5) = 60
  // 即"钳到最小值 60 秒"，而不是回落到默认 3600。这是既有行为，如实锁定。
  assert.strictEqual(saved.everySeconds, 60, 'a non-positive interval is clamped to the 60s floor');
  assert.strictEqual(saved.dailyTime, '09:00', 'a malformed time falls back');
  assert.strictEqual(saved.weeklyDay, 1, 'an out-of-range weekday falls back to Monday');
  assert.strictEqual(saved.name.length, 100, 'name is capped');
  assert.strictEqual(saved.prompt.length, 4000, 'prompt is capped');
  assert.strictEqual(saved.enabled, true, 'only an explicit false disables');
});

test('ipc-scheduled: every configured mutation restarts the scheduler AND broadcasts', async () => {
  // 少重启 → 任务不再触发；少广播 → UI 显示过期状态
  const { ipc, state } = register();
  await ipc.invoke('shell:scheduled-upsert', { name: 'a' });
  assert.strictEqual(state.restarts, 1);
  assert.strictEqual(state.broadcasts, 1);

  await ipc.invoke('shell:scheduled-remove', 'task-1');
  assert.strictEqual(state.restarts, 2);
  assert.strictEqual(state.broadcasts, 2);

  await ipc.invoke('shell:scheduled-clear-history');
  assert.strictEqual(state.broadcasts, 3, 'clearing history also needs a broadcast');
});

// ----------------------------------------------------------- 运行与去重

test('ipc-scheduled: running a missing task fails clearly', async () => {
  const { ipc } = register();
  const out = await ipc.invoke('shell:scheduled-run', 'ghost');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /task not found/);
});

test('ipc-scheduled: a task already running is rejected (no double-run)', async () => {
  const { ipc, state } = register();
  state.data.scheduledTasks = [{ id: 't1', kind: 'every', everySeconds: 60 }];
  state.running.add('t1');
  const out = await ipc.invoke('shell:scheduled-run', 't1');
  assert.strictEqual(out.ok, false);
  assert.match(out.reason, /already running/);
});

test('ipc-scheduled: a successful run clears the running flag and persists', async () => {
  const { ipc, state } = register();
  state.data.scheduledTasks = [{ id: 't1', kind: 'every', everySeconds: 60 }];
  const out = await ipc.invoke('shell:scheduled-run', 't1');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(state.running.has('t1'), false, 'the flag must be cleared');
  assert.strictEqual(state.saves, 1, 'nextRunAt/lastRunAt mutations must be persisted');
});

test('ipc-scheduled: a FAILED run still clears the flag and persists (finally block)', async () => {
  // 不清理的话 UI 会永远显示"运行中"。
  const { ipc, state } = register({
    runScheduledTask: async () => ({ ok: false, reason: 'boom' }),
  });
  state.data.scheduledTasks = [{ id: 't1', kind: 'every', everySeconds: 60 }];
  const out = await ipc.invoke('shell:scheduled-run', 't1');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(state.running.has('t1'), false, 'the flag must be cleared even on failure');
  assert.strictEqual(state.saves, 1, 'and the state must still be persisted');
});

test('ipc-scheduled: a THROWING run task does not leak the exception', async () => {
  const { ipc, state } = register({
    runScheduledTask: async () => { throw new Error('task exploded'); },
  });
  state.data.scheduledTasks = [{ id: 't1', kind: 'every', everySeconds: 60 }];
  await assert.rejects(() => ipc.invoke('shell:scheduled-run', 't1'), /task exploded/);
  assert.strictEqual(state.running.has('t1'), false, 'the finally block must still run');
});

test('ipc-scheduled: list reports both tasks and the running set', async () => {
  const { ipc, state } = register();
  state.data.scheduledTasks = [{ id: 'a' }];
  state.running.add('a');
  const out = await ipc.invoke('shell:scheduled-list');
  assert.strictEqual(out.tasks.length, 1);
  assert.deepStrictEqual(out.running, ['a']);
});

test('ipc-scheduled: history and clear-history behave as a pair', async () => {
  const { ipc, state } = register();
  state.data.scheduledHistory = [{ id: 'h1' }];
  assert.strictEqual((await ipc.invoke('shell:scheduled-history')).length, 1);
  await ipc.invoke('shell:scheduled-clear-history');
  assert.deepStrictEqual(state.data.scheduledHistory, []);
});
