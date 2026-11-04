// test/preload-channel-parity.test.js — preload 暴露的通道必须有主进程 handler。
//
// 第一性原理：这是一条"点了没反应"的静默失败路径
//
//   preload 通过 contextBridge 把 `invoke('xxx')` 暴露给渲染进程。
//   如果主进程没有注册对应的 `ipcMain.handle('xxx')`，那么渲染进程调用它时：
//     · 不会在加载时报错（preload 只是闭包，不校验目标）
//     · 不会在 UI 上提示（Promise 会 reject 成 "No handler registered"）
//     · 表现就是**按钮点了没反应** —— 而控制台之外没有任何线索
//
//   TD-20 记的就是这条：无 preload↔main 通道一致性测试。
//
//   难点：`office:*` 是**动态注册**的 —— office-module 里
//     for (const channel of OFFICE_IPC_CHANNELS) ipcMain.handle(channel, ...)
//   静态扫描 `ipcMain.handle('...')` 抓不到它。
//   所以要同时认静态注册和动态清单两种方式。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { stripComments } = require('./helpers/source-scan.js');

/** 递归收集 src/ 下的 .js 源码。 */
function srcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith('.js')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  // studio/ 是**独立子项目**（有自己的 AGENTS.md / bin / 测试），
  // 但它的 preload（src/workbench/workbench-preload.js）暴露的 studio:* 通道
  // 是在 studio/main.js 里注册的。漏掉这个目录会误报 76 个"死通道" ——
  // 我第一版就是这样，几乎得出"整个 workbench 都失效了"的错误结论。
  walk(path.join(ROOT, 'studio'));
  return out;
}

const FILES = srcFiles().map((p) => ({ rel: path.relative(ROOT, p), code: stripComments(fs.readFileSync(p, 'utf8')) }));

/** 所有 preload 文件暴露的通道（invoke / send）。 */
function exposedChannels() {
  const set = new Set();
  for (const f of FILES) {
    if (!f.rel.includes('preload')) continue;
    for (const m of f.code.matchAll(/\b(?:invoke|send)\(\s*'([^']+)'/g)) set.add(m[1]);
    for (const m of f.code.matchAll(/\b(?:invoke|send)\(\s*"([^"]+)"/g)) set.add(m[1]);
  }
  return [...set].sort();
}

/** 主进程注册的通道：静态 handle/on + 动态清单里的字面量。 */
function registeredChannels() {
  const set = new Set();
  for (const f of FILES) {
    if (f.rel.includes('preload')) continue;
    for (const m of f.code.matchAll(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/g)) set.add(m[1]);
    for (const m of f.code.matchAll(/ipcMain\.(?:handle|on)\(\s*"([^"]+)"/g)) set.add(m[1]);
    // 动态注册的通道清单：这些是**主进程会注册**的，不是 preload 侧
    for (const m of f.code.matchAll(/(?:OFFICE_IPC_CHANNELS|SHELL_CHANNELS|IPC_CHANNELS)\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/g)) {
      for (const c of m[1].matchAll(/'([^']+)'/g)) set.add(c[1]);
    }
  }
  return set;
}

test('parity: the scan actually sees a real channel surface', () => {
  // 自检：如果解析方式变了、扫出来是空的，下面几条会全绿 —— 那是最糟的假绿。
  const exposed = exposedChannels();
  const registered = registeredChannels();
  assert.ok(exposed.length >= 50,
    `expected a real preload channel surface, found only ${exposed.length}`);
  assert.ok(registered.size >= 50,
    `expected a real handler surface, found only ${registered.size}`);
});

test('parity: every channel a preload exposes has a main-process handler', () => {
  const registered = registeredChannels();
  const missing = exposedChannels().filter((c) => !registered.has(c));
  assert.deepEqual(missing, [],
    `these channels are exposed by a preload but nothing handles them — `
    + `the renderer call will reject silently and the UI will just do nothing:\n  ${missing.join('\n  ')}`);
});

test('parity: the office channel list is registered dynamically (not literally handled)', () => {
  // 这条解释上一条为什么需要认两种注册方式：office:* 是循环注册的。
  // 如果有人把动态注册改回静态、或改了循环，这条会提醒去看。
  const office = FILES.find((f) => f.rel.endsWith(path.join('office', 'office-module.js')));
  assert.ok(office, 'office-module must exist');
  assert.match(office.code, /for \(const channel of OFFICE_IPC_CHANNELS\)/,
    'office channels are registered in a loop over OFFICE_IPC_CHANNELS — the parity scan depends on it');
});

test('parity: every exposed channel belongs to a domain that the main process actually serves', () => {
  // 第一版写的是"前缀必须在白名单里" —— 而白名单只能靠人列举，
  // 实测立刻误报了 8 个合法通道（compat: / notifications: / office-rail: / plugins: …）。
  // 手写白名单的问题还是那个：**把判断责任放在最容易过时的地方**。
  //
  // 改成从实际注册面反推：一个域前缀只要**在主进程侧出现过**就算合法。
  // 这样新开一个域不会误报，而"preload 暴露了一个主进程从没服务过的域"
  // 仍然会被抓到 —— 那才是真正要防的情况。
  const registered = [...registeredChannels()];
  const servedPrefixes = new Set(registered.map((c) => `${c.split(':')[0]}:`));
  const orphans = exposedChannels()
    .filter((c) => !servedPrefixes.has(`${c.split(':')[0]}:`));
  assert.deepEqual(orphans, [],
    `these channels have a domain the main process never serves at all — `
    + `likely a typo or an abandoned surface:\n  ${orphans.join('\n  ')}`);
});
