// test/main-startup-integrity.test.js — main.js 启动期的静态完整性检查。
//
// 第一性原理：这次踩的坑是"用了没导入的东西"
//
//   真实发生：TD-08 权限加固写了 `session.defaultSession`，但 `session`
//   不在 electron 的导入列表里。后果：
//
//     · 启动时抛 ReferenceError（被 unhandledRejection 吞掉）
//     · **权限加固从未生效**——安全默认值形同虚设
//     · 而离线测试全部通过（测试不会去跑真实的 app.whenReady 链）
//
//   这类错误的共同点：**语法正确、类型检查也过（JS 没有）、测试绿，
//   只有真跑才炸**。所以必须有一条"静态符号完整性"检查把常见情况挡住。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
// 去掉注释与字符串，避免把注释里提到的名字当成真实使用
// 只去注释，**不去字符串**：去字符串会连 require('electron') 一起吃掉。
const code = MAIN
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** main.js 从 electron 解构了哪些名字。 */
function electronImports() {
  const m = code.match(/const\s*\{([^}]+)\}\s*=\s*require\('electron'\)/);
  assert.ok(m, 'main.js must destructure from electron');
  return new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

test('startup integrity: `session` IS imported from electron (it is used by the hardening)', () => {
  // 这是本次真实事故：用了 session.defaultSession 但没导入。
  // 后果不是"报个错"，是**权限加固整套没生效**。
  assert.match(code, /session\.defaultSession/, 'the hardening must still use session.defaultSession');
  assert.ok(electronImports().has('session'),
    '`session` is used but not destructured from electron — the permission hardening would silently never安装');
});

test('startup integrity: every electron-ish symbol used at startup is imported', () => {
  // 一个粗粒度但有效的守卫：检查常见的 Electron 顶层符号。
  const wanted = ['app', 'BrowserWindow', 'ipcMain', 'dialog', 'shell', 'session', 'protocol'];
  const imports = electronImports();
  const used = wanted.filter((name) => new RegExp(`\\b${name}\\.`).test(code));
  const missing = used.filter((name) => !imports.has(name));
  assert.deepEqual(missing, [], `these are used but not imported from electron: ${missing.join(', ')}`);
});

test('startup integrity: unhandled rejections log the STACK (message alone loses the clue)', () => {
  // 本次排查一开始完全卡住，因为日志只有 "session is not defined"，
  // 没有栈。堆栈是可观测性的一部分，不是可选项。
  const handler = code.slice(code.indexOf("process.on('unhandledRejection'"), code.indexOf("process.on('uncaughtException'"));
  assert.match(handler, /\.stack/, 'the rejection handler must include the stack');
});

test('startup integrity: the permission hardening is installed before any window loads', () => {
  // TD-08 的核心要求：必须最早安装，晚于窗口加载就来不及。
  // indexOf 找到的是**第一个**出现处（可能是 require 或注释），
  // 所以从 `app.whenReady().then(` 开始切一段来断言顺序。
  const bootAt = code.indexOf('app.whenReady().then(');
  assert.ok(bootAt !== -1, 'the boot chain must exist');
  const boot = code.slice(bootAt, bootAt + 4000);
  const installAt = boot.indexOf('installPermissionHandlers');
  const windowAt = boot.indexOf('createWindow(');
  assert.ok(installAt !== -1, 'the hardening must be inside the boot chain');
  if (windowAt !== -1) {
    assert.ok(installAt < windowAt,
      'the permission handlers must be installed BEFORE the first window is created');
  }
});
