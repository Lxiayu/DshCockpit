// test/window-hardening.test.js — TD-08 / TD-09：窗口安全加固。
//
// 第一性原理：为什么必须"统一"而不是"逐个加"
//
//   审计发现 12 个窗口/视图的保护程度不一致——harnessView 两个 handler
//   都没有，aux-windows 的 4 个窗口全缺 setWindowOpenHandler。
//   逐个加的失败模式是**新窗口会继续漏**，而这个仓库已经有 4 次
//   "后来才发现漏了"的痕迹。
//
//   所以正确的形态是：一个函数，所有窗口创建时都调它，漏不掉。
//   测试要能证明"没有窗口绕过它"。
//
// 第二性原理：为什么权限默认全 deny
//
//   桌面壳不是浏览器，用户没有"这个网站要麦克风"的心理预期。
//   一旦授予，第三方 UI（dsh 或其插件）就能录音/读剪贴板。
//   宁可某个功能暂时不可用（用户会报），也不要静默授予敏感权限。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const hardening = require('../src/window-hardening.js');

const ROOT = path.join(__dirname, '..');

/** 假的 webContents：记录注册的 handler，便于断言"装了什么"。 */
function fakeWebContents() {
  const handlers = new Map();
  let openHandler = null;
  return {
    on(event, cb) { handlers.set(event, cb); },
    setWindowOpenHandler(fn) { openHandler = fn; },
    fire(event, ...args) { const cb = handlers.get(event); return cb ? cb(...args) : undefined; },
    openWindow(url) { return openHandler ? openHandler({ url }) : null; },
    getURL() { return 'file:///app/index.html'; },
    hasOpenHandler() { return !!openHandler; },
  };
}

/** 假的 event 对象，记录是否 preventDefault。 */
function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

// ------------------------------------------------------------ 导航拦截

test('hardening: will-navigate is always blocked', () => {
  const wc = fakeWebContents();
  hardening.hardenWebContents(wc, { label: 't' });
  const e = fakeEvent();
  wc.fire('will-navigate', e, 'https://evil.example.com');
  assert.strictEqual(e.prevented, true, 'navigation must be prevented');
});

test('hardening: window.open is always DENIED even when an external handler exists', () => {
  // 关键：转交外链 ≠ 允许派生子窗口。
  // 派生窗口的 webPreferences 由 Electron 默认值决定，安全项不可控。
  const wc = fakeWebContents();
  const opened = [];
  hardening.hardenWebContents(wc, { label: 't', onExternal: (u) => opened.push(u) });

  const result = wc.openWindow('https://example.com/doc');
  assert.deepStrictEqual(result, { action: 'deny' }, 'the child window must be denied');
  assert.deepStrictEqual(opened, ['https://example.com/doc'], 'but the link is handed to the external handler');
});

test('hardening: only http/https reach the external handler', () => {
  // file:// / javascript: / data: 绝不能交给 shell.openExternal ——
  // 那是把"打开链接"变成"执行本地文件"。
  const wc = fakeWebContents();
  const opened = [];
  hardening.hardenWebContents(wc, { label: 't', onExternal: (u) => opened.push(u) });

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
    wc.openWindow(bad);
  }
  assert.deepStrictEqual(opened, [], 'non-http(s) URLs must never be forwarded');

  wc.openWindow('https://ok.example.com/x');
  assert.strictEqual(opened.length, 1, 'a legitimate https link does pass through');
});

test('hardening: <webview> attach is blocked', () => {
  const wc = fakeWebContents();
  hardening.hardenWebContents(wc, { label: 't' });
  const e = fakeEvent();
  wc.fire('will-attach-webview', e);
  assert.strictEqual(e.prevented, true, 'a <webview> would bypass all the above policies');
});

test('hardening: an invalid webContents is reported, not thrown', () => {
  const out = hardening.hardenWebContents(null, {});
  assert.strictEqual(out.blocksNavigation, false);
  assert.match(out.reason, /invalid/);
});

// ------------------------------------------------------------ 权限处理器

function fakeSession() {
  const state = { requestHandler: null, checkHandler: null };
  return {
    setPermissionRequestHandler(fn) { state.requestHandler = fn; },
    setPermissionCheckHandler(fn) { state.checkHandler = fn; },
    request(permission, origin) {
      let answer = null;
      state.requestHandler(fakeWebContents(), permission, (v) => { answer = v; }, { requestingUrl: origin });
      return answer;
    },
    check(permission, origin) {
      return state.checkHandler(fakeWebContents(), permission, origin);
    },
    hasHandlers() { return !!state.requestHandler && !!state.checkHandler; },
  };
}

test('hardening: both permission handlers are installed (request AND check)', () => {
  // 只装 request 会让 navigator.permissions.query 报"允许"而实际被拒——
  // 策略不一致比全拒绝更难排查。
  const session = fakeSession();
  const out = hardening.installPermissionHandlers(session, {});
  assert.strictEqual(out.installed, true);
  assert.strictEqual(session.hasHandlers(), true);
});

test('hardening: EVERY permission is denied by default (empty allowlist)', () => {
  const session = fakeSession();
  hardening.installPermissionHandlers(session, {});
  for (const perm of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal']) {
    assert.strictEqual(session.request(perm, 'file:///app/index.html'), false,
      `${perm} must be denied — a desktop shell silently granting it is wrong`);
  }
});

test('hardening: the allowlist is empty AND documented (adding an entry requires a reason)', () => {
  assert.deepStrictEqual([...hardening.ALLOWED_PERMISSIONS], [],
    'no permission may be allowed without an explicit, justified entry');
  for (const entry of hardening.PERMISSION_ALLOWLIST) {
    assert.ok(entry.reason && entry.reason.length > 10, 'every allowance must explain itself');
    assert.ok(entry.origin, 'and name the origin it applies to');
  }
});

test('hardening: denials are LOGGED (a silent deny is indistinguishable from a bug)', () => {
  const logs = [];
  const session = fakeSession();
  hardening.installPermissionHandlers(session, { log: (m) => logs.push(m) });
  session.request('media', 'file:///app/x');
  assert.ok(logs.some((l) => /permission DENIED: media/.test(l)), 'the denial must be traceable');
});

test('hardening: a session without handler support is reported, not thrown', () => {
  const out = hardening.installPermissionHandlers({}, {});
  assert.strictEqual(out.installed, false);
  assert.match(out.reason, /does not support/);
});

// --------------------------------------- 仓库级：没有窗口绕过加固

test('hardening: EVERY window/view in the repo goes through hardenWebContents', () => {
  // 这是本套件最重要的一条：证明"漏一个"不可能发生。
  const files = ['src/window-manager.js', 'src/aux-windows.js'];
  const violations = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 任何内联的 will-navigate / setWindowOpenHandler 都算绕过统一加固
    const inlineNav = (src.match(/\.on\('will-navigate'/g) || []).length;
    const inlineOpen = (src.match(/\.setWindowOpenHandler\(/g) || []).length;
    if (inlineNav > 0) violations.push(`${rel}: ${inlineNav} inline will-navigate`);
    if (inlineOpen > 0) violations.push(`${rel}: ${inlineOpen} inline setWindowOpenHandler`);
  }
  assert.deepStrictEqual(violations, [],
    'windows must be hardened via the shared helper, not ad-hoc — '
    + 'ad-hoc handlers are how 4 windows were missed before');
});

test('hardening: the third-party UI view (harnessView) IS hardened', () => {
  // 它加载 dsh 自己的 Web UI —— 唯一加载第三方代码的视图。
  // 它此前两个 handler 都没有，是最危险的一个缺口。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'window-manager.js'), 'utf8');
  const idx = src.indexOf('harnessView = new WebContentsView');
  assert.ok(idx !== -1);
  const after = src.slice(idx, idx + 1200);
  assert.match(after, /hardenWebContents\(harnessView\.webContents/,
    'harnessView must be hardened right where it is created');
});

test('hardening: every aux window (quickAsk/search/loading/missionDesk) is hardened', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'aux-windows.js'), 'utf8');
  for (const name of ['quickAskWindow', 'searchWindow', 'loadingWindow', 'missionDeskWindow']) {
    assert.match(src, new RegExp(`hardenWebContents\\(${name}\\.webContents`),
      `${name} must be hardened`);
  }
});

test('hardening: the global permission handler is installed at app-ready (before any window)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const ready = src.indexOf('app.whenReady()');
  const install = src.indexOf('installPermissionHandlers(session.defaultSession');
  assert.ok(install !== -1, 'the handler must be installed');
  assert.ok(install > ready, 'and it must be inside the ready callback');
  // 必须早于 registerIpc（窗口/IPC 注册都在它之后）
  const registerIpc = src.indexOf('registerIpc();', ready);
  assert.ok(install < registerIpc, 'the handler must be installed BEFORE any window can load');
});
