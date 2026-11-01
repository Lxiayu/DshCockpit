// src/ipc-channels.js — IM 通道域的 IPC 注册（Issue #22 Phase 1，第五批次）。
//
// 第一性原理：这是目前耦合最低的一批
//
//   5 个 handler，全部是**对 channelsMgr 单个对象的薄封装**。
//   没有辅助函数、没有跨域依赖、不碰窗口/广播/生命周期。
//   这类域提取的边际收益最高、风险最低——应该优先做。
//
// 第二性原理：为什么降级形状仍然不统一
//
//   channelsMgr 在启动早期是 null。此时：
//     · channels-list → {channels: []}（面板要能渲染空列表，不能返回 {ok:false}）
//     · 其余四个       → {ok:false, reason:'not ready'}
//
//   这看起来"不统一"，但都是 UI 依赖的。测试锁住 list 的形状。
//
// 第三性原理：C6 凭证纪律必须原样保留
//
//   credentials 存在于主进程的 safeStorage vault：
//     · renderer 发送字段值
//     · 主进程返回布尔/结果形状
//     · **秘密值永不回传**
//   这条纪律由 channelsMgr 实现，但 IPC 层不能破坏它
//   （比如"顺手"把 values 回显到返回值里）。所以这里不做任何回显。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object|null} ctx.channelsMgr  IM 通道管理器（启动早期可能为 null）
 */
function registerChannelsIpc(ipcMain, ctx) {
  const { channelsMgr } = ctx;

  // IM channels (C5): settings-window surface. All channel state mutations run
  // in the main process; the renderer only renders statusAll() snapshots.
  ipcMain.handle('shell:channels-list', () => (channelsMgr ? { channels: channelsMgr.statusAll() } : { channels: [] }));
  ipcMain.handle('shell:channels-toggle', (_e, id, enabled) => (
    channelsMgr ? channelsMgr.toggle(String(id || ''), !!enabled) : { ok: false, reason: 'not ready' }
  ));
  // TD-32：allowFrom 的第四参数是 confirmOpen。
  // 只有"从非开放变成全开放"才需要它——见 channel-manager.setAllowFrom 的说明。
  ipcMain.handle('shell:channels-allowfrom', (_e, id, allowFrom, confirmOpen) => (
    channelsMgr
      ? channelsMgr.setAllowFrom(String(id || ''), allowFrom, { confirmOpen: confirmOpen === true })
      : { ok: false, reason: 'not ready' }
  ));
  // C6: credentials live in the main-process safeStorage vault; the renderer
  // sends field values, gets back booleans/result shapes only (never secrets)
  ipcMain.handle('shell:channels-configure', (_e, id, values) => (
    channelsMgr ? channelsMgr.configureSecrets(String(id || ''), values) : { ok: false, reason: 'not ready' }
  ));
  ipcMain.handle('shell:channels-test', (_e, id, values) => (
    channelsMgr ? channelsMgr.testChannel(String(id || ''), values) : { ok: false, reason: 'not ready' }
  ));
}

module.exports = { registerChannelsIpc };
