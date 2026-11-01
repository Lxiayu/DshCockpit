// src/ipc-capability-packs.js — Capability Pack 的 IPC 域（P3 S7.1）。
//
// 第一性原理：为什么通道名不叫 packs-*
//
//   `shell:packs-*` 已经被**角色包**（character pack，Issue #24）占用。
//   两者是完全不同的东西：
//     · 角色包 → 办公室外观（ZIP 导入，442 行安装器）
//     · 能力包 → 能力声明（manifest + verify）
//
//   所以用完整的 `capability-packs` 前缀。缩写（cpacks）虽然短，
//   但下一个人看到 `shell:cpacks-list` 不会知道它指什么——
//   命名清晰比省几个字符重要。
//
// 第二性原理：为什么只给 4 个通道
//
//   本阶段（P3.5）的用户入口只做三件事：看、装、卸。
//   远程安装、包编辑、版本升级都**没有真实需求**（AGENTS.md §2.6）。
//   加通道很容易，但每个通道都是长期维护面。
'use strict';

/** 通道集合（冻结；IPC 契约快照会钉住它）。 */
const CAPABILITY_PACKS_IPC_CHANNELS = Object.freeze([
  'shell:capability-packs-list',      // 已安装列表 + 健康状态
  'shell:capability-packs-available', // 内置可用包（capability-packs/ 目录）
  'shell:capability-packs-install',   // 安装一个内置包
  'shell:capability-packs-uninstall', // 卸载
]);

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {Function} ctx.installerOf  () => installer 实例（延迟求值：可能尚未初始化）
 * @param {Function} ctx.availableOf  () => 可用包清单（内置目录扫描结果）
 * @param {Function} [ctx.log]
 */
function registerCapabilityPacksIpc(ipcMain, ctx) {
  const { installerOf, availableOf, log = () => {} } = ctx;

  // 注意：ipcMain.handle 的回调签名是 (event, ...args)。
  // guard 只剥掉 event 再往下传，所以 fn 收到的是 (installer, ...args)。
  // 第一版 fn 写成 (installer, _e2, packId)，把 event 当成了参数——
  // packId 变成了事件对象，于是永远 PACK_ID_INVALID。
  const guard = (fn) => async (_e, ...args) => {
    try {
      const installer = installerOf();
      if (!installer) {
        // 如实降级：初始化失败就说不可用，不假装成功
        return { ok: false, code: 'PACKS_UNAVAILABLE' };
      }
      return await fn(installer, ...args);
    } catch (error) {
      log(`[packs] ipc failed: ${error && error.message}`);
      return { ok: false, code: 'PACKS_INTERNAL', message: error && error.message };
    }
  };

  ipcMain.handle('shell:capability-packs-list', guard(async (installer) => {
    const listed = installer.list();
    if (!listed.ok) return listed;
    // 健康检查需要 manifest；内置目录里的包可以直接取
    const available = availableOf();
    const manifestsById = {};
    for (const entry of available) {
      if (entry.manifest) manifestsById[entry.id] = entry.manifest;
    }
    const health = await installer.healthCheck(manifestsById);
    const healthById = {};
    for (const r of (health.results || [])) healthById[r.id] = r.state;
    return {
      ok: true,
      packs: listed.packs.map((p) => ({
        id: p.id,
        version: p.version,
        title: p.title,
        installedAtMs: p.installedAtMs,
        // 健康状态由 healthCheck 给出；查不到就如实标 not-verified
        health: healthById[p.id] || 'not-verified',
      })),
    };
  }));

  ipcMain.handle('shell:capability-packs-available', async () => {
    try {
      const available = availableOf();
      return {
        ok: true,
        packs: available.map((e) => ({
          id: e.id,
          title: e.manifest ? e.manifest.title : e.id,
          version: e.manifest ? e.manifest.version : null,
          verifyCommand: e.manifest && e.manifest.verify ? e.manifest.verify.command : null,
        })),
      };
    } catch (error) {
      return { ok: false, code: 'PACKS_INTERNAL', message: error && error.message };
    }
  });

  ipcMain.handle('shell:capability-packs-install', guard(async (installer, packId) => {
    const id = typeof packId === 'string' ? packId.trim() : '';
    if (!id) return { ok: false, code: 'PACK_ID_INVALID' };
    const found = availableOf().find((entry) => entry.id === id);
    if (!found || !found.manifest) {
      return { ok: false, code: 'PACK_NOT_FOUND', reason: `no built-in pack named "${id}"` };
    }
    const r = await installer.install(found.manifest);
    // 把 verify 细节带回给 UI：用户要看到"为什么失败"
    return {
      ok: r.ok,
      code: r.code,
      reason: r.reason,
      verifyState: r.verify ? r.verify.state : null,
      verifyReason: r.verify ? r.verify.reason : null,
    };
  }));

  ipcMain.handle('shell:capability-packs-uninstall', guard(async (installer, packId) => {
    const id = typeof packId === 'string' ? packId.trim() : '';
    if (!id) return { ok: false, code: 'PACK_ID_INVALID' };
    const r = installer.uninstall(id);
    // 卸载后立刻确认无残留——这是"安装=记录"设计带来的可验证性
    const clean = r.ok ? installer.assertClean(id) : { clean: false, reason: null };
    return { ok: r.ok, code: r.code, clean: clean.clean, cleanReason: clean.reason };
  }));

  return { channels: [...CAPABILITY_PACKS_IPC_CHANNELS] };
}

module.exports = { CAPABILITY_PACKS_IPC_CHANNELS, registerCapabilityPacksIpc };
