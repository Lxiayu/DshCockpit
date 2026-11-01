// src/window-hardening.js — 统一的窗口安全加固（TD-08 / TD-09）。
//
// 第一性原理：为什么必须"统一"而不是"逐个加"
//
//   审计发现 12 个窗口/视图的保护程度不一致：
//     · officeShellView / workView / workDockView / railView → will-navigate + setWindowOpenHandler ✓
//     · mainWindow / cockpitWindow / settingsWindow          → 部分缺失
//     · **harnessView**                                      → **两个都没有** ✗
//     · aux-windows（quickAsk/search/loading/missionDesk）   → 全缺 setWindowOpenHandler ✗
//
//   逐个加的失败模式是**新窗口会继续漏**——这个仓库已经有 4 次"后来才发现漏了"
//   的痕迹。正确做法是把加固变成**创建窗口的必经步骤**：
//   一个函数，所有窗口都调它，漏不掉。
//
// 第二性原理：为什么 harnessView 是最危险的那个
//
//   它是**唯一加载第三方代码**的视图（dsh 自己的 Web UI）。
//   其他视图加载的都是本仓的 HTML（我们已经控制其内容），
//   所以它们缺 handler 主要是"防御纵深不足"；
//   而 harnessView 缺 handler 是**直接暴露在第三方行为之下**：
//   如果 dsh UI 里有 window.open（新版本随时可能加），
//   Electron 会按**默认 webPreferences** 派生子窗口——
//   那意味着安全项不是我们决定的。这是"不是我们决定的" vs
//   "我们决定为不安全"的区别。
//
// 第三性原理：为什么权限处理器要默认全 deny
//
//   Electron 默认行为下，渲染进程可以请求摄像头/麦克风/地理位置/通知/
//   剪贴板读取/MIDI 等。对桌面壳来说这些**几乎都不该被无声授予**：
//     · 我们不是浏览器，用户没有"这个网站要麦克风"的心理预期
//     · 一旦授予，第三方 UI（dsh 或其插件）就能录音/读剪贴板
//   正确姿态：**默认 deny，白名单显式放行**，且放行要有记录。
//   宁可某个功能暂时不可用（用户会报），也不要静默授予敏感权限。
'use strict';

/**
 * 被允许的权限白名单。
 *
 * 目前为空——这是**有意的**。任何权限请求都应先被拒绝并记录，
 * 等确认真实需要时再逐条加入（并附上加入理由）。
 *
 * 加条目时必须写清楚：哪个 origin、哪个权限、为什么必须、
 * 不加会破坏什么功能。没有这四项就不该加。
 */
const PERMISSION_ALLOWLIST = Object.freeze([
  // 示例（当前为空集）：
  // { origin: 'file://', permission: 'clipboard-sanitized-write',
  //   reason: '设置页的"复制故障码"按钮需要写剪贴板', since: '2026-11-01' },
]);

/** 允许自动放行的权限名（空集 = 全部拒绝）。 */
const ALLOWED_PERMISSIONS = new Set(PERMISSION_ALLOWLIST.map((e) => e.permission));

/**
 * 统一加固一个 webContents。
 *
 * @param {object} webContents  Electron webContents（WebContentsView 或 BrowserWindow 的）
 * @param {object} [opts]
 * @param {string} [opts.label]        用于日志的窗口名
 * @param {Function} [opts.onExternal] 外链处理（默认拒绝；给 shell.openExternal 时只放行 http/https）
 * @param {Function} [opts.log]
 * @returns {{blocksNavigation:true, deniesWindows:true}}
 */
function hardenWebContents(webContents, opts = {}) {
  const { label = 'window', onExternal = null, log = () => {} } = opts;
  if (!webContents || typeof webContents.on !== 'function') {
    return { blocksNavigation: false, deniesWindows: false, reason: 'invalid webContents' };
  }

  // 1) 阻止页面内导航离开（本仓所有窗口都只应停留在自己的 loadFile/loadURL 目标）
  webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    log(`[hardening] ${label}: blocked navigation to ${String(url).slice(0, 120)}`);
  });

  // 2) 拒绝派生子窗口；外链交给显式回调（默认连回调都不给 = 纯拒绝）
  webContents.setWindowOpenHandler(({ url }) => {
    log(`[hardening] ${label}: blocked window.open → ${String(url).slice(0, 120)}`);
    if (typeof onExternal === 'function') {
      // 只把 http/https 交给调用方（file://、javascript:、data: 一律不传）
      try {
        const parsed = new URL(String(url));
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          onExternal(parsed.href);
        }
      } catch { /* malformed URL: drop it */ }
    }
    // **永远 deny**：即使转交了外链，也不让 Electron 派生子窗口。
    // 派生窗口的 webPreferences 由 Electron 默认值决定，安全项不可控。
    return { action: 'deny' };
  });

  // 3) 拒绝 webview 标签（本仓不使用 <webview>；允许它等于开一个绕过上述策略的口子）
  webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    log(`[hardening] ${label}: blocked <webview> attach`);
  });

  return { blocksNavigation: true, deniesWindows: true };
}

/**
 * 安装全局权限处理器（TD-08）。
 *
 * 必须在 app ready 之后、任何窗口加载之前调用一次。
 *
 * @param {object} session  Electron session（通常 session.defaultSession）
 * @param {object} [opts]
 * @param {Function} [opts.log]
 * @returns {{installed:boolean}}
 */
function installPermissionHandlers(session, opts = {}) {
  const { log = () => {} } = opts;
  if (!session || typeof session.setPermissionRequestHandler !== 'function') {
    return { installed: false, reason: 'session does not support permission handlers' };
  }

  const decide = (webContents, permission, requestingOrigin) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission);
    const label = requestingOrigin || (webContents && webContents.getURL ? safeUrl(webContents.getURL()) : 'unknown');
    if (!allowed) {
      // **只记录，不弹窗**：桌面壳里弹系统权限框会让用户困惑
      //（"这个应用为什么突然要麦克风"），而默认拒绝更安全也更安静。
      log(`[hardening] permission DENIED: ${permission} (origin=${label})`);
    } else {
      log(`[hardening] permission granted (allowlisted): ${permission} (origin=${label})`);
    }
    return allowed;
  };

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details && details.requestingUrl ? safeUrl(details.requestingUrl) : null;
    callback(decide(webContents, permission, origin));
  });

  // check handler 与 request handler 分离：有些 API 只走 check（例如
  // navigator.permissions.query），不装它会让策略出现"查询说允许、实际被拒"的不一致。
  if (typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      return decide(webContents, permission, requestingOrigin);
    });
  }

  return { installed: true };
}

function safeUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(url).slice(0, 80);
  }
}

module.exports = {
  PERMISSION_ALLOWLIST,
  ALLOWED_PERMISSIONS,
  hardenWebContents,
  installPermissionHandlers,
};
