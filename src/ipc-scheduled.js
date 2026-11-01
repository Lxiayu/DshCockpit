// src/ipc-scheduled.js — 定时任务域的 IPC 注册（Issue #22 Phase 1，第三批次）。
//
// 第一性原理：为什么 scheduled 值得搬（它不只是"读配置"）
//
//   表面看这 6 个 handler 只是 shell:scheduled-*，实际包含**实质业务逻辑**：
//
//   1. **计划语义变更时必须丢弃 nextRunAt**（upsert 里那段 samePlan 判断）
//      —— 若保留旧 nextRunAt，调度器会在"旧计划的时间点"触发，
//         而用户已经改成新计划了。这是最难在 review 中发现的 bug 类型。
//
//   2. **run 的并发去重**（scheduledRunning 集合）
//      —— 同一任务不能同时跑两次；finally 里必须清理并落盘 nextRunAt/lastRunAt。
//
//   3. **每次变更都要重启调度器 + 广播**
//      —— 少了任何一个，UI 会显示过期状态或任务不再触发。
//
//   这些都是"域知识"，不是"接线"。留在 main.js 意味着下次改调度语义还得翻
//   6200 行——那就没有真正解耦。所以整组搬。
//
// 依赖全部注入（settings / scheduledRunning / startScheduler / broadcastScheduled /
// runScheduledTask / notify / t / lang），模块本身不 require('electron')。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object} ctx.settings            SettingsStore（get/patch/save）
 * @param {Set}    ctx.scheduledRunning    正在运行的任务 id 集合
 * @param {Function} ctx.startScheduler    重建调度器
 * @param {Function} ctx.broadcastScheduled 广播当前任务列表
 * @param {Function} ctx.runScheduledTask  执行一个任务
 * @param {Function} ctx.notify
 * @param {Function} ctx.t
 * @param {Function} ctx.lang
 */
function registerScheduledIpc(ipcMain, ctx) {
  const { settings, scheduledRunning, startScheduler, broadcastScheduled, runScheduledTask, notify, t, lang } = ctx;

  ipcMain.handle('shell:scheduled-list', () => ({
    tasks: settings.get().scheduledTasks || [],
    running: [...scheduledRunning],
  }));

  ipcMain.handle('shell:scheduled-upsert', (_e, task) => {
    // sanitize: keep only known fields with sane types
    const kind = ['every', 'daily', 'weekly'].includes(task.kind) ? task.kind : 'every';
    const weeklyDay = Number(task.weeklyDay);
    const clean = {
      id: typeof task.id === 'string' && task.id ? task.id : undefined,
      name: typeof task.name === 'string' ? task.name.slice(0, 100) : t(lang(), 'scheduled.defaultName'),
      prompt: typeof task.prompt === 'string' ? task.prompt.slice(0, 4000) : '',
      templateId: typeof task.templateId === 'string' ? task.templateId.slice(0, 64) : undefined,
      kind,
      everySeconds: Math.max(60, Number(task.everySeconds) || 3600),
      dailyTime: /^\d{1,2}:\d{2}$/.test(task.dailyTime || '') ? task.dailyTime : '09:00',
      weeklyDay: Number.isInteger(weeklyDay) && weeklyDay >= 0 && weeklyDay <= 6 ? weeklyDay : 1,
      weeklyTime: /^\d{1,2}:\d{2}$/.test(task.weeklyTime || '') ? task.weeklyTime : '09:00',
      enabled: task.enabled !== false,
      nextRunAt: Number(task.nextRunAt) || undefined,
      lastRunAt: typeof task.lastRunAt === 'string' ? task.lastRunAt : undefined,
    };
    const list = settings.get().scheduledTasks || [];
    if (clean.id) {
      const idx = list.findIndex((tk) => tk.id === clean.id);
      if (idx !== -1) {
        const old = list[idx];
        // schedule semantics changed → drop the stale nextRunAt so the
        // scheduler recomputes from the new plan instead of firing at the
        // old (possibly already-due) moment
        const samePlan = old.kind === clean.kind
          && (clean.kind !== 'every' || old.everySeconds === clean.everySeconds)
          && (clean.kind !== 'daily' || old.dailyTime === clean.dailyTime)
          && (clean.kind !== 'weekly' || (old.weeklyDay === clean.weeklyDay && old.weeklyTime === clean.weeklyTime));
        if (!samePlan) clean.nextRunAt = undefined;
        list[idx] = { ...old, ...clean };
      } else list.push(clean);
    } else {
      clean.id = `task-${Date.now()}`;
      clean.nextRunAt = undefined; // fresh task: let the scheduler plan the first run
      list.push(clean);
    }
    settings.patch({ scheduledTasks: list });
    startScheduler();
    broadcastScheduled();
    return { ok: true, tasks: settings.get().scheduledTasks };
  });

  ipcMain.handle('shell:scheduled-remove', (_e, id) => {
    const list = (settings.get().scheduledTasks || []).filter((tk) => tk && tk.id !== id);
    settings.patch({ scheduledTasks: list });
    startScheduler();
    broadcastScheduled();
    return { ok: true };
  });

  ipcMain.handle('shell:scheduled-history', () => settings.get().scheduledHistory || []);

  ipcMain.handle('shell:scheduled-clear-history', () => {
    settings.patch({ scheduledHistory: [] });
    broadcastScheduled();
    return { ok: true };
  });

  ipcMain.handle('shell:scheduled-run', async (_e, id) => {
    const task = (settings.get().scheduledTasks || []).find((tk) => tk && tk.id === id);
    if (!task) return { ok: false, reason: 'task not found' };
    if (scheduledRunning.has(id)) return { ok: false, reason: 'already running' };
    scheduledRunning.add(id);
    broadcastScheduled();
    try {
      const r = await runScheduledTask(task);
      return { ok: !!r.ok };
    } finally {
      // 无论成功失败都要清理并落盘 —— 否则 UI 会永远显示"运行中"，
      // 而且 nextRunAt/lastRunAt 的变更会丢失。
      scheduledRunning.delete(id);
      settings.save(); // persist any nextRunAt/lastRunAt mutation
      broadcastScheduled();
    }
  });
}

module.exports = { registerScheduledIpc };
