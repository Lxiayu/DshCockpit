// src/ipc-misc-domains.js — 三个小域的 IPC 注册（Issue #22 Phase 1，第三批次）。
//
// plugins / search / quickask 各只有 1–2 个 handler，但它们的共同点是
// **依赖集合极小且完全正交**（互不引用），适合合并为一批：
//   · plugins  → fetchPlugins / marketPayload / pluginAction
//   · search   → searchSessions + dshHomeOf
//   · quickask → handleQuickAskSubmit + 一个 auxWindows 方法
//
// 合并的理由不是"省事"，而是这三个域单独提一次的价值不足以抵消
// 每次提取都要跑全量回归的成本；而它们彼此无耦合，合并也不会放大风险。
//
// 注意 quickask 有一个 `ipcMain.on`（单向通道），不是 handle——
// 提取时不能把两者混为一谈：`on` 没有返回值，`handle` 有。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {Function} ctx.fetchPlugins        按关键词搜索插件
 * @param {Function} ctx.marketPayload       精选市场（带 fallback）
 * @param {Function} ctx.pluginAction        插件操作（install/enable/…）
 * @param {Function} ctx.searchSessions      会话搜索
 * @param {Function} ctx.dshHomeOf           DSH home 路径
 * @param {Function} ctx.handleQuickAskSubmit Quick Ask 提交
 * @param {Function} ctx.closeQuickAsk       关闭 Quick Ask 窗口
 * @param {Function} ctx.log                 日志
 */
function registerMiscDomainsIpc(ipcMain, ctx) {
  const {
    fetchPlugins, marketPayload, pluginAction,
    searchSessions, dshHomeOf,
    handleQuickAskSubmit, closeQuickAsk,
    log,
  } = ctx;

  // ------------------------------------------------------------------ plugins
  ipcMain.handle('plugins:search', async (_e, keyword) => {
    try { return { ok: true, plugins: await fetchPlugins(keyword) }; }
    catch (e) { return { ok: false, reason: e.message }; }
  });
  // curated market from awesome-dsh-plugin (CC0); last-resort fallback to the
  // legacy topic search so the market never renders empty due to one outage
  ipcMain.handle('plugins:market', async (_e, force) => {
    try {
      return await marketPayload(Boolean(force));
    } catch (e) {
      log(`[shell] curated market unavailable (${e.message}); falling back to topic search`);
      try {
        return { ok: true, source: 'fallback', fetchedAt: 0, categories: [], plugins: await fetchPlugins('') };
      } catch (e2) {
        return { ok: false, reason: e2.message };
      }
    }
  });

  // ------------------------------------------------------------------- search
  ipcMain.handle('search:query', async (_e, q) => searchSessions(dshHomeOf(), q, 20));

  // ----------------------------------------------------------------- quickask
  ipcMain.handle('quickask:submit', (_e, prompt) => handleQuickAskSubmit(prompt));
  // 单向通道：`on` 不返回值，与上面的 `handle` 语义不同，不能互换。
  ipcMain.on('quickask:close', () => closeQuickAsk());
}

module.exports = { registerMiscDomainsIpc };
