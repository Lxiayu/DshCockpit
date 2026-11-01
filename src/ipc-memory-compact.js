// src/ipc-memory-compact.js — 长会话中心：AGENTS.md 记忆文件 + compaction（Issue #22 Phase 1）。
//
// 第一性原理：为什么 memory 与 compact 合并成一个批次
//
//   它们单独看都很小（3 + 3 个 handler），且理由不同：
//     · memory  → 依赖极少（memory/notify/t/lang/log），几乎零风险
//     · compact → 依赖 7 个（sessionRunning/compactTracker/getRuntimeUrl/
//                 manager/createHarnessRpcClient/harnessRpcDeps/log/notify）
//
//   但它们在**产品语义上是同一件事**：都是"长会话中心（C3）"的一部分——
//   compact 压缩上下文，memory 把结论落进 AGENTS.md。
//   分成两个文件会让"长会话中心"这个概念在代码里没有归属。
//
//   合并的代价只是多注入几个依赖；收益是这个域有一个明确的家。
//
// 第二性原理：为什么 compactNow 要搬（它不是纯接线）
//
//   它包含三段业务判断，都不是"转发"：
//     1. **busy 判定**：会话正在跑 或 已在压缩 → 拒绝（否则会与正在进行的
//        压缩打架，产生半成品上下文）
//     2. **runtime 未就绪判定**：没有 runtime URL → 返回 distinct code
//        'runtime-offline'（不是通用失败，UI 要区分"没开"和"失败了"）
//     3. **RPC 失败时发通知**：只 log 不通知的话用户点了没反应，会以为按钮坏了
//
//   留在 main.js 意味着下次改压缩语义还得翻 6000 行。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object} ctx.memory                createMemoryFiles() 实例
 * @param {Function} ctx.compactNow          执行一次 compaction
 * @param {Function} ctx.getCompactTracker   () => compactTracker | null
 * @param {Function} ctx.isSessionRunning    () => boolean
 * @param {Function} ctx.notify
 * @param {Function} ctx.t
 * @param {Function} ctx.lang
 * @param {Function} ctx.log
 */
function registerMemoryCompactIpc(ipcMain, ctx) {
  const { memory, compactNow, getCompactTracker, isSessionRunning, notify, t, lang, log } = ctx;

  // long-session center (C3): compaction + AGENTS.md memory files
  ipcMain.handle('shell:compact-now', async () => compactNow());
  ipcMain.handle('shell:compact-status', () => {
    const tracker = getCompactTracker();
    return {
      compacting: tracker ? tracker.isCompacting() : false,
      // sessionRunning 是实时求值 —— 缓存成常量会让"运行中"永远停在启动那一刻
      sessionRunning: isSessionRunning(),
      last: tracker ? (tracker.history()[0] || null) : null,
    };
  });
  ipcMain.handle('shell:compact-history', () => {
    const tracker = getCompactTracker();
    return tracker ? tracker.history() : [];
  });

  ipcMain.handle('shell:memory-get', (_e, scope) => memory.get(String(scope || '')));
  ipcMain.handle('shell:memory-save', async (_e, scope, content) => {
    const r = await memory.save(String(scope || ''), typeof content === 'string' ? content : '');
    if (r.ok) notify(t(lang(), 'memory.saved'), t(lang(), 'memory.savedBody', { path: r.path }));
    else log(`[memory] save failed: ${r.code} (${r.reason || ''})`);
    return r;
  });
  ipcMain.handle('shell:memory-delete', async (_e, scope) => {
    const r = await memory.remove(String(scope || ''));
    if (r.ok) notify(t(lang(), 'memory.deleted'), t(lang(), 'memory.deletedBody', { path: r.path }));
    else log(`[memory] delete failed: ${r.code} (${r.reason || ''})`);
    return r;
  });
}

module.exports = { registerMemoryCompactIpc };
