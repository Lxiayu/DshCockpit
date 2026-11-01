// src/ipc-mcp.js — MCP 域的 IPC 注册（Issue #22 Phase 1，第一个提取批次）。
//
// 第一性原理：为什么先搬 MCP，而不是"shell:*"（74 个 handler 的大头）
//
//   小步提取的风险不在"搬多少行"，而在**未知耦合**。选第一个批次的标准是：
//     1. 依赖集合已知且小（能从代码里数清）
//     2. 不触碰窗口/生命周期/广播（那些跨域状态最难验证）
//     3. 有独立模块可挂（mcp-manager / mcp-registry / mcp-conn / mcp-import）
//     4. 通道集合冻结（11 个，改动会被契约快照抓到）
//
//   MCP 全部满足：它只依赖 5 个注入点，不碰窗口，四个子模块早已独立，
//   11 个通道稳定。shell:* 那 74 个涉及窗口重建/托盘/单实例，是最难的一批，
//   应该放在最后、且在有更多行为测试之后。
//
//   模式沿用 ipc-features.js：`registerMcpIpc(ipcMain, ctx)`，所有依赖通过 ctx
//   到达，模块本身不 require('electron')，因此可以在纯 Node 下测试。
//
// 行为等价性：本文件是**逐字搬运**，不改任何分支逻辑、错误文案或返回值形状。
// 唯一的改动是把 main.js 里的闭包变量换成 ctx 注入。
'use strict';

/**
 * @param {object} ipcMain  Electron ipcMain（测试时可注入假实现）
 * @param {object} ctx
 * @param {object|null} ctx.mcpMgr           MCP 服务器管理器
 * @param {object|null} ctx.mcpConn          连接/探测层（tier1/tier2）
 * @param {object|null} ctx.mcpReg           注册表（内置目录）
 * @param {object|null} ctx.mcpImp           导入器（扫描/准备）
 * @param {object|null} ctx.sessionWorkerClient  worker（mcp:usage 的日志解析）
 * @param {Function} ctx.dshHomeOf            返回 DSH home 路径
 * @param {Function} ctx.wrapForWindows       stdio 命令包装（Windows 兼容）
 * @param {Function} ctx.log                  日志
 */
function registerMcpIpc(ipcMain, ctx) {
  const {
    mcpMgr, mcpConn, mcpReg, mcpImp, sessionWorkerClient,
    dshHomeOf, wrapForWindows, log,
  } = ctx;

  // Secret values cross renderer→main exactly once (mcp:save) and are stored
  // in the safeStorage vault; list/get responses carry configured-flags only,
  // never values (same discipline as the models panel above).
  const mcpReady = () => (mcpMgr ? null : { ok: false, reason: 'not ready' });

  ipcMain.handle('mcp:list', () => (mcpMgr ? mcpMgr.listServers() : { ok: true, servers: [], patchBlockIds: [], patchFile: '' }));
  ipcMain.handle('mcp:get', (_e, id) => (mcpMgr ? mcpMgr.getServer(String(id || '')) : mcpReady()));
  ipcMain.handle('mcp:save', async (_e, input, secrets) => {
    const notReady = mcpReady();
    if (notReady) return notReady;
    try { return await mcpMgr.save(input || {}, secrets || {}); } catch (e) {
      log(`[mcp] save failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('mcp:remove', async (_e, id) => {
    const notReady = mcpReady();
    if (notReady) return notReady;
    try { return await mcpMgr.remove(String(id || '')); } catch (e) {
      log(`[mcp] remove failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('mcp:toggle', async (_e, id, enabled) => {
    const notReady = mcpReady();
    if (notReady) return notReady;
    try { return await mcpMgr.toggle(String(id || ''), !!enabled); } catch (e) {
      log(`[mcp] toggle failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('mcp:test', async (_e, target) => {
    if (!mcpConn || !mcpMgr) return { ok: false, reason: 'not ready' };
    try {
      const t = target || {};
      const stored = t.id ? mcpMgr.getServer(String(t.id)) : null;
      const server = t.transport ? t : (stored && stored.ok ? stored.server : null);
      if (!server) return { ok: false, reason: 'unknown server' };
      // the probe uses the WRAPPED command, exactly what the patch file runs
      const wrapped = server.transport === 'stdio' ? wrapForWindows(server.command, server.args) : server;
      return await mcpConn.tier2({ ...server, command: wrapped.command, args: wrapped.args || server.args }, (id, key) => mcpMgr.resolveSecret(id, key));
    } catch (e) {
      log(`[mcp] test failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('mcp:tier1', async (_e, id) => {
    if (!mcpConn || !mcpMgr) return { ok: false, status: 'error', reason: 'not ready' };
    const stored = mcpMgr.getServer(String(id || ''));
    return stored && stored.ok ? mcpConn.tier1(stored.server) : { ok: false, status: 'error', reason: 'unknown server' };
  });
  ipcMain.handle('mcp:registry', async (_e, query, category) => {
    if (!mcpReg) return { ok: true, items: [] };
    try { return { ok: true, items: await mcpReg.list(String(query || ''), String(category || 'all')) }; } catch (e) {
      return { ok: true, items: mcpReg.BUILTIN };
    }
  });
  ipcMain.handle('mcp:import-scan', () => (mcpImp ? { ok: true, sources: mcpImp.scanSources() } : { ok: true, sources: [] }));
  ipcMain.handle('mcp:import-run', async (_e, sourceKey, selectedNames, clipboardText) => {
    if (!mcpImp || !mcpMgr) return { ok: false, reason: 'not ready' };
    try {
      const existing = mcpMgr.listServers().servers.map((s) => s.id);
      const prep = mcpImp.prepare(String(sourceKey || ''), Array.isArray(selectedNames) ? selectedNames : null, clipboardText, existing);
      if (!prep.ok) return prep;
      const imported = [];
      const failed = [];
      for (const item of prep.items) {
        if (item.error) { failed.push({ name: item.name, reason: item.error }); continue; }
        const r = await mcpMgr.save(item.server, item.secrets || {});
        if (r.ok) imported.push(r.server.id);
        else failed.push({ name: item.name, reason: r.reason });
      }
      return { ok: true, imported, failed };
    } catch (e) {
      log(`[mcp] import failed: ${e.message}`);
      return { ok: false, reason: e.message };
    }
  });
  ipcMain.handle('mcp:usage', async (_e, days) => {
    // rides the session worker: zstd + log parsing never touch the main thread
    if (!sessionWorkerClient) return { ok: true, usage: { servers: {} } };
    try {
      const usage = await sessionWorkerClient.mcpUsage(dshHomeOf(), { maxFiles: 400 });
      return { ok: true, usage };
    } catch (e) {
      return { ok: true, usage: { servers: {} }, reason: e.message };
    }
  });
}

module.exports = { registerMcpIpc };
