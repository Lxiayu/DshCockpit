'use strict';

// src/office/power-presentation.js — 2026-09-25 唤醒自愈（P1，长稳报告缺陷：
// "显示器唤醒/解锁后画面不会自愈：停在静止诊断态，要切一次视图或点「重试渲染」"）。
//
// 把 Electron powerMonitor 的会话级电源信号（lock-screen / unlock-screen /
// suspend / resume）映射成一个布尔「办公室呈现被挂起」状态，交给
// window-manager.setOfficePresentationSuspended()——它经既有 office:visibility
// 推送载荷的 `presenting` 字段下发（没有新 IPC 通道，office:* 仍恰好 8 个）。
//
// 为什么需要它（探针实测，2026-09-25）：锁屏/息屏期间 Chromium 把页面节流到
// ~1.3fps，而渲染器的低帧率判据此前只区分「是否当前主视图」，不区分「屏幕根本
// 没有在呈现」，于是把节流帧误判为持续低帧率锁进 static 诊断态，且唤醒后不自愈。
// 修复分两层（判据与自愈都在 renderer，本模块只提供信号）：
//   1) 未呈现期间（presenting=false）观察器停表：泵停、看门狗停，唤醒时丢弃在途
//      窗口，恢复预算不消耗（renderer.setPresenting）；
//   2) 唤醒沿（presenting false→true）自动自愈：若正停在 LOW_FPS_PERSISTENT
//      静态诊断，自动尝试一次有界重建（与前台恢复共用 attemptRecovery：每次唤醒
//      至多 1 次、会话上限 3、硬失败永不重试）。
//
// 平台边界（诚实记录）：display-sleep-without-lock（只息屏不锁屏）在 Electron
// 公开 API 里没有可靠事件（powerMonitor 只发会话级信号；screen 的
// display-metrics-changed 不随息屏/唤醒触发）。这类场景不在本修复覆盖内；探针侧
// 用 ioreg/pmset 自行判呈现状态（scripts/office-soak.js presentedNow）。
//
// 可注入：测试传假 powerMonitor；证据运行不能真锁用户屏幕，经 probe() 驱动与真
// 事件完全相同的处理函数（main.js 里 DSH_OFFICE_POWER_PROBE 文件轮询，见下）。

function wireOfficePresentationSignals({
  powerMonitor = null,
  onSuspendedChanged = null,
  log = () => {},
  probeFile = null,
  readFileSync = null,
} = {}) {
  if (typeof onSuspendedChanged !== 'function') {
    return { isSuspended: () => false, probe: () => {}, stop: () => {} };
  }

  let suspended = false;
  // 唯一的状态迁移入口：真 powerMonitor 事件与证据探针都走这里。同值调用是
  // no-op——一次唤醒（unlock-screen + resume 同时到达）只产生一个下行沿，
  // 页面侧因此最多看到一次 presenting=false→true 的变化。
  const apply = (next, reason) => {
    const normalized = !!next;
    if (suspended === normalized) return;
    suspended = normalized;
    try { onSuspendedChanged(suspended); } catch { /* shell errors never break the wiring */ }
    try { log(`[office] power ${reason} → presentation ${suspended ? 'suspended' : 'resumed'}`); } catch { /* log best effort */ }
  };

  const subscriptions = [
    ['lock-screen', () => apply(true, 'lock-screen')],
    ['unlock-screen', () => apply(false, 'unlock-screen')],
    ['suspend', () => apply(true, 'suspend')],
    ['resume', () => apply(false, 'resume')],
  ];
  if (powerMonitor && typeof powerMonitor.on === 'function') {
    for (const [event, handler] of subscriptions) {
      try { powerMonitor.on(event, handler); } catch { /* platform without this event */ }
    }
  }

  // 证据探针（可选，默认关闭）：轮询 probeFile，内容 'locked' / 'unlocked' →
  // 与真 powerMonitor 事件完全相同的 apply()。只在 main.js 显式传入 probeFile
  // 时启动（DSH_OFFICE_POWER_PROBE=<file>）；250ms 轮询且 unref，不阻碍退出。
  let probeTimer = null;
  if (probeFile && typeof readFileSync === 'function') {
    probeTimer = setInterval(() => {
      try {
        const state = String(readFileSync(probeFile) || '').trim();
        if (state !== 'locked' && state !== 'unlocked') return;
        apply(state === 'locked', `probe:${state}`);
      } catch { /* file not written yet / gone */ }
    }, 250);
    if (typeof probeTimer.unref === 'function') probeTimer.unref();
  }

  return {
    isSuspended: () => suspended,
    // Evidence-only entry: drives the SAME handler the real events call.
    probe: (next, reason) => apply(next, reason || 'probe'),
    stop: () => {
      if (powerMonitor && typeof powerMonitor.removeListener === 'function') {
        for (const [event, handler] of subscriptions) {
          try { powerMonitor.removeListener(event, handler); } catch { /* ignore */ }
        }
      }
      if (probeTimer) clearInterval(probeTimer);
    },
  };
}

module.exports = { wireOfficePresentationSignals };
