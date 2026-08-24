// src/ipc-features.js — A1: IPC registration for the v0.3.0 feature domains
// (boot self-check, notification hub, weekly report, cache economics,
// upstream compat). Moved verbatim from main.js; every dependency arrives
// via the ctx object. The legacy shell handlers (86 of them) stay in
// main.js until their business domains are modularized (v0.4 plan).
'use strict';

/**
 * @param {object} ipcMain  electron ipcMain
 * @param {object} ctx — { bootCheck, nc, weeklyGet: () => weekly|null,
 *   channelsGet: () => channelsMgr|null, collectStats, buildCacheEconomics,
 *   pricingFromSettings, settingsGet, compatStatus, shellOpen, appGetPath,
 *   notify, t, lang, log }
 */
function registerFeatureIpc(ipcMain, ctx) {
  const {
    bootCheck, nc,
    weeklyGet, channelsGet,
    collectStats, buildCacheEconomics, pricingFromSettings,
    settingsGet, compatStatus,
    shellOpen, appGetPath,
    notify, t, lang, log,
  } = ctx;

  // R1 boot self-check (report contract in boot-check.js)
  ipcMain.handle('boot:report', () => ({ ok: true, report: bootCheck.readReport(), file: bootCheck.reportFile() }));
  ipcMain.handle('boot:rerun', async () => ({ ok: true, report: await bootCheck.runChecks() }));
  ipcMain.handle('boot:repair', async (_e, ids) => {
    const out = await bootCheck.repair(Array.isArray(ids) ? ids : undefined);
    if (out.repaired.length) notify(t(lang(), 'notify.bootRepairDone'), t(lang(), 'notify.bootRepairDoneBody', { items: out.repaired.join(', '), passed: out.report.summary.passed, total: out.report.summary.total }));
    return { ok: true, ...out };
  });
  // R6 notification hub history (searchable in Settings → Notifications)
  ipcMain.handle('notifications:list', (_e, query, kind, limit) => ({ ok: true, items: nc.list({ query, kind, limit }) }));
  ipcMain.handle('notifications:clear', () => nc.clear());
  // R5 weekly report (Wrapped card)
  ipcMain.handle('weekly:generate', async () => {
    try {
      const weekly = weeklyGet();
      const out = await (weekly ? weekly.generate() : Promise.reject(new Error('not ready')));
      return { ok: true, file: out.file, data: out.data };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('weekly:list', async () => {
    try {
      const weekly = weeklyGet();
      const data = await (weekly ? weekly.buildData() : Promise.reject(new Error('not ready')));
      return { ok: true, files: weekly ? weekly.listFiles() : [], preview: data };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  ipcMain.handle('weekly:open-dir', async () => { shellOpen(path.join(appGetPath('userData'), 'weekly')); return { ok: true }; });
  ipcMain.handle('weekly:push', async () => {
    try {
      const weekly = weeklyGet();
      if (!weekly) return { ok: false, reason: 'not ready' };
      const out = await weekly.generate();
      const zh = lang() !== 'en';
      const text = zh
        ? `📊 DSH 周报 ${out.data.weekLabel}\n花费 ¥${(out.data.costYuan || 0).toFixed(2)} · 定时任务 ${out.data.tasksDone} 次 · Quick Ask ${out.data.quickAsks} 次\n缓存节省 ¥${(out.data.cacheSavedYuan || 0).toFixed(2)}\n最活跃工作区：${out.data.topWorkspace || '—'}`
        : `📊 DSH Weekly ${out.data.weekLabel}\nSpend ¥${(out.data.costYuan || 0).toFixed(2)} · Scheduled runs ${out.data.tasksDone} · Quick Asks ${out.data.quickAsks}\nCache saved ¥${(out.data.cacheSavedYuan || 0).toFixed(2)}\nTop workspace: ${out.data.topWorkspace || '—'}\n(card: ${out.file})`;
      const channelsMgr = channelsGet();
      if (!channelsMgr) return { ok: false, reason: 'channels unavailable' };
      await channelsMgr.broadcastText(text);
      log('[weekly] pushed to IM channels');
      return { ok: true };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  // R4 cache economics (read-only aggregation over the shared collect() cache)
  ipcMain.handle('cache-economics:summary', async () => {
    try {
      const data = await collectStats(false);
      return { ok: true, ...buildCacheEconomics(data, pricingFromSettings(settingsGet())) };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  // R2 upstream compatibility status (read-only)
  ipcMain.handle('compat:status', () => compatStatus.getStatus());
}

module.exports = { registerFeatureIpc };
