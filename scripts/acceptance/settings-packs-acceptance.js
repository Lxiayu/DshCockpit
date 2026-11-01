'use strict';
// scripts/acceptance/settings-packs-acceptance.js — 角色包 UI 真机验收（Issue #24）。
//
// 第一性原理：离线测试漏掉了什么，只有真机能抓到
//
//   我写了 13 项离线静态契约测试（i18n 完整性、preload↔IPC 一致、通道归属），
//   它们全绿。但真机一跑就发现 **rows: 0** —— 角色包列表根本没渲染。
//
//   根因不是我的新代码，而是一个**既有缺陷**：
//   `#page-office` 的 DOM 存在、导航按钮也存在，
//   但 `PAGES` 白名单漏了 'office' → showPage('office') 回退到 general。
//   也就是说 office 设置（睡眠/速度/隐私）在此之前**对用户不可达**。
//
//   离线测试看不到这个，因为它只查"字符串是否存在"。页面的**可到达性**
//   是一个运行时属性：标签页要真的被切换、IPC 要真的被调用、DOM 要真的被填充。
//
//   所以这个脚本验证的是"用户能不能看到并操作"：
//     1. office 页真的能被导航到（白名单修复的回归保护）
//     2. 角色包列表真的被填充（IPC 往返 + 渲染）
//     3. 内置包/使用中徽章正确
//     4. 两个导入按钮存在且可点
//     5. i18n 真的解析成中文（不是原始 key）
//
// 用法（需要图形会话）：
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
//     scripts/acceptance/settings-packs-acceptance.js

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'settings-packs-acceptance');
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function finish(code) {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'),
      JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
  } catch { /* best effort */ }
  app.exit(code);
}

// ---- 最小 IPC 桩：只实现页面启动时必需的通道 --------------------------------
const FAKE_PACKS = [
  { packId: 'deepseek-default', version: null, builtin: true, installPath: '/b', active: false },
  { packId: 'my-custom', version: '1.0.0', builtin: false, installPath: '/p', active: true },
];
function installStubs() {
  ipcMain.handle('shell:packs-list', () => ({ ok: true, packs: FAKE_PACKS }));
  ipcMain.handle('shell:packs-select', () => ({ ok: true }));
  ipcMain.handle('shell:packs-uninstall', () => ({ ok: true, fellBackToBuiltin: true }));
  ipcMain.handle('shell:packs-pick-folder', () => ({ ok: false, cancelled: true }));
  ipcMain.handle('shell:packs-pick-zip', () => ({ ok: false, cancelled: true }));
  // 页面启动时会被调到的其它通道（返回空壳即可，它们不是本 Issue 的对象）
  for (const ch of ['shell:get-settings', 'shell:office-settings-get', 'shell:get-theme',
    'shell:runtime-info', 'shell:quickask-shortcut-get', 'shell:notif-rules-get',
    'shell:storage-info', 'shell:diagnostics', 'shell:compat-status']) {
    ipcMain.handle(ch, () => ({ ok: true }));
  }
  ipcMain.handle('shell:log', () => ({ ok: true }));
}

async function main() {
  installStubs();
  const win = new BrowserWindow({
    width: 1280, height: 940, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'settings-preload.js'),
    },
  });
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadFile(path.join(REPO, 'src', 'settings.html'));
  await new Promise((r) => setTimeout(r, 1200));

  // ---- 1. office 页真的可达（既有缺陷的回归保护）----
  await ev("location.hash = '#/office'").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const pageActive = await ev(`(() => {
    const el = document.getElementById('page-office');
    return el ? el.classList.contains('active') : false;
  })()`).catch(() => false);
  record('the office page is actually reachable (PAGES whitelist)', pageActive,
    pageActive ? 'active' : 'showPage fell back — the page is unreachable for users');

  // ---- 2. 角色包列表被填充 ----
  const listInfo = await ev(`(() => {
    const list = document.getElementById('packs-list');
    if (!list) return { exists: false };
    return { exists: true, rows: list.children.length, text: list.textContent.trim().slice(0, 200) };
  })()`).catch((e) => ({ exists: false, error: String(e) }));
  record('the character pack list is populated', listInfo.rows >= 2, `rows=${listInfo.rows}`);

  // ---- 3. 徽章正确 ----
  record('the builtin pack is labelled as builtin', /内置/.test(listInfo.text || ''), listInfo.text || '');
  record('the active pack is labelled as in-use', /使用中/.test(listInfo.text || ''), listInfo.text || '');

  // ---- 4. 两个导入入口存在 ----
  const buttons = await ev(`(() => ({
    folder: !!document.getElementById('packs-import-folder'),
    zip: !!document.getElementById('packs-import-zip'),
    status: !!document.getElementById('packs-status'),
  }))()`).catch(() => ({}));
  record('both import entry points exist (folder + .zip)',
    buttons.folder && buttons.zip, JSON.stringify(buttons));

  // ---- 5. i18n 真的解析了（不是原始 key）----
  const i18nOk = await ev(`(() => {
    // 只看**渲染出的文本节点**是否含原始 key。
    // 注意：data-i18n 属性本身含 key，所以要排除属性——
    // 用可见文本而非 body.textContent 的整串匹配容易误报。
    const visible = (document.getElementById('page-office') || document.body).innerText || '';
    const t = document.querySelector('[data-i18n="packs_title"]');
    return {
      title: t ? t.textContent : null,
      // 真实的泄漏形态是用户看到 packs_xxx 字样
      rawKeyLeaked: /packs_[a-zA-Z]/.test(visible),
      visibleSample: visible.slice(0, 120),
    };
  })()`).catch(() => ({ rawKeyLeaked: true }));
  record('i18n resolves to real copy (no raw keys on screen)',
    !i18nOk.rawKeyLeaked, `title=${i18nOk.title}`);

  // ---- 6. 截图存证 ----
  try {
    // 先把角色包区滚入视野：capturePage 拍的是整个 viewport，
    // 而 office 页较长，不滚动会拍到空白区域（首版截图就拍到过）。
    await ev(`(() => {
      const sec = document.getElementById('packs-list');
      if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'center' });
    })()`).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'settings-packs.png'), image.toPNG());
    record('screenshot captured for visual review', image.getSize().width > 0,
      `${image.getSize().width}x${image.getSize().height}`);
  } catch (e) {
    record('screenshot captured for visual review', false, String(e));
  }

  win.destroy();
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  console.log(`EVIDENCE: ${EVIDENCE}`);
  finish(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(1); });
