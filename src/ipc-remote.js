// src/ipc-remote.js — 手机遥控网关的 IPC 注册（Issue #22 Phase 1，第二个批次）。
//
// 第一性原理：为什么 remote 是第二个批次
//
//   它只依赖**一个**注入点（`remote` 对象），三个 handler 全是对该对象方法的
//   薄封装，且不触碰窗口/广播/生命周期。依赖集合小到可以从代码里一眼数清——
//   这正是小步提取该有的批次粒度。
//
//   三个 handler 的降级语义各有不同，且都是**有意的**，提取时必须原样保留：
//     · status  → 未启用时报告 {running:false, disabled:true}（面板要能显示）
//     · pairing → 未启用时返回 null（没有配对码就是没有）
//     · revoke  → 未启用时返回 null（无可撤销项）
//   把这三个都统一成 {ok:false} 会破坏设置页的既有判断逻辑。
'use strict';

/**
 * @param {object} ipcMain
 * @param {object} ctx
 * @param {object|null} ctx.remote  手机遥控网关实例（未启用时为 null）
 */
function registerRemoteIpc(ipcMain, ctx) {
  const { remote } = ctx;

  // phone remote-control gateway (settings window)
  ipcMain.handle('remote:status', () => (remote ? remote.status() : { running: false, disabled: true }));
  ipcMain.handle('remote:pairing', () => {
    if (!remote) return null;
    remote.refreshPairingCode();
    return remote.status();
  });
  ipcMain.handle('remote:revoke', () => (remote ? remote.revokeToken() : null));
}

module.exports = { registerRemoteIpc };
