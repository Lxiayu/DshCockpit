'use strict';
// scripts/acceptance/capability-packs-acceptance.js — 能力包页面真机验收（P3 S7.5）。
//
// 第一性原理：这个页面最容易骗人的地方
//
//   离线测试能验证：通道注册对了、payload 校验对了、i18n 齐全。
//   只有真机能验证：
//     1. 页面真的可达（PAGES 白名单踩过坑）
//     2. 两个列表真的渲染（已安装 / 可安装）
//     3. **四态健康标真的显示不同文字**（skipped ≠ passed）
//     4. 点击安装真的走 IPC 并显示 verify 结果
//     5. 页面不自己判断状态（库说 failed，页面不能显示绿色）
//
// 复用 P2.3/P2.4 摸索出的正确姿势：真 stub、真 i18n、不手动注入。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'capability-packs-acceptance');

const results = [];
let failed = 0;
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function finish() {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    console.log(`EVIDENCE: ${EVIDENCE}`);
  } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  app.exit(failed === 0 ? 0 : 1);
}

const STUB_INSTALLED = [
  { id: 'workspace-verification', version: '1.0.0', title: '工作区验证', installedAtMs: Date.now(), health: 'passed' },
  { id: 'research-report', version: '1.0.0', title: '研究报告', installedAtMs: Date.now(), health: 'skipped' },
];
const STUB_AVAILABLE = [
  { id: 'workspace-verification', title: '工作区验证', version: '1.0.0', verifyCommand: 'node -v' },
  { id: 'research-report', title: '研究报告', version: '1.0.0', verifyCommand: 'node -v' },
];

async function main() {
  let installCalls = 0;
  let uninstallCalls = 0;
  let installResult = { ok: true, verifyState: 'passed' };

  ipcMain.handle('shell:capability-packs-list', () => ({ ok: true, packs: STUB_INSTALLED }));
  ipcMain.handle('shell:capability-packs-available', () => ({ ok: true, packs: STUB_AVAILABLE }));
  ipcMain.handle('shell:capability-packs-install', () => { installCalls += 1; return installResult; });
  ipcMain.handle('shell:capability-packs-uninstall', () => { uninstallCalls += 1; return { ok: true, clean: true }; });
  for (const ch of ['shell:log', 'shell:get-settings', 'shell:get-theme', 'shell:get-i18n',
    'shell:runtime-info', 'shell:quickask-shortcut-get', 'shell:office-settings-get',
    'shell:backup-info', 'shell:storage-info', 'shell:diagnostics', 'shell:compat-status',
    'shell:notif-rules-get', 'shell:notif-history', 'office:state', 'office:visibility']) {
    ipcMain.handle(ch, () => (ch === 'shell:get-i18n'
      ? require(path.join(REPO, 'src', 'i18n.js')).STRINGS
      : { ok: true }));
  }

  const win = new BrowserWindow({
    width: 1280, height: 940, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'settings-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });
  await win.loadFile(path.join(REPO, 'src', 'settings.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 页面可达（白名单回归）----
  await ev("location.hash = '#/capability-packs'").catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const pageState = await ev(`(() => {
    const el = document.getElementById('page-capability-packs');
    return { active: !!el && el.classList.contains('active'), hasNav: !!document.querySelector('[data-page="capability-packs"]') };
  })()`).catch((e) => ({ error: String(e) }));
  record('the capability-packs page is reachable (PAGES whitelist)', pageState.active === true, JSON.stringify(pageState));
  record('the nav entry exists', pageState.hasNav === true, String(pageState.hasNav));

  // ---- 2. 两个列表都渲染 ----
  const lists = await ev(`(() => ({
    installed: document.getElementById('packs-installed-list').children.length,
    available: document.getElementById('packs-available-list').children.length,
    installedText: document.getElementById('packs-installed-list').textContent,
    availableText: document.getElementById('packs-available-list').textContent,
  }))()`).catch((e) => ({ error: String(e) }));
  record('the installed list renders both packs', lists.installed === 2, `rows=${lists.installed}`);
  record('the available list renders both packs', lists.available === 2, `rows=${lists.available}`);

  // ---- 3. 四态健康标（skipped 不等于 passed）----
  const badges = await ev(`(() => {
    const rows = [...document.querySelectorAll('#packs-installed-list .packs-row')];
    return rows.map((r) => r.textContent);
  })()`).catch(() => []);
  const passedRow = badges.find((t) => /工作区验证/.test(t)) || '';
  const skippedRow = badges.find((t) => /研究报告/.test(t)) || '';
  record('a passed pack shows the passed badge', /通过/.test(passedRow), passedRow);
  record('a SKIPPED pack shows a DIFFERENT badge (skipped is not passed)',
    /已跳过/.test(skippedRow) && !/通过/.test(skippedRow), skippedRow);

  // ---- 4. 点击安装 → 走 IPC 并显示 verify 结果 ----
  const clicked = await ev(`(() => {
    const btn = document.querySelector('#packs-available-list .packs-row button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 800));
  const afterInstall = await ev(`document.getElementById('cap-packs-status').textContent`).catch(() => '');
  record('clicking install calls the IPC channel', clicked === true && installCalls >= 1, `calls=${installCalls}`);
  record('the install result surfaces the verify state', /verify|通过/.test(afterInstall || ''), afterInstall);

  // ---- 5. 失败时必须显示原因（不能只显示"失败"）----
  installResult = { ok: false, code: 'VERIFY_FAILED', reason: 'exit code 1', verifyState: 'failed', verifyReason: 'exit code 1' };
  await ev(`(() => {
    const btn = document.querySelector('#packs-available-list .packs-row button');
    if (btn) btn.click();
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  const afterFail = await ev(`document.getElementById('cap-packs-status').textContent`).catch(() => '');
  record('a failed install explains WHY (not just "failed")', /exit code 1/.test(afterFail || ''), afterFail);

  // ---- 6. 点击卸载 ----
  await ev(`(() => {
    const btn = document.querySelector('#packs-installed-list .packs-row button');
    if (btn) btn.click();
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  record('clicking uninstall calls the IPC channel', uninstallCalls >= 1, `calls=${uninstallCalls}`);

  // ---- 7. 截图 + i18n + 错误 ----
  const i18nOk = await ev(`(() => {
    const h = document.querySelector('#page-capability-packs h2');
    const t = h ? h.textContent : '';
    return { title: t, leaked: /packs_|nav_/.test(document.getElementById('page-capability-packs').innerText || '') };
  })()`).catch(() => ({}));
  record('i18n resolves (no raw keys on screen)', !!i18nOk.title && i18nOk.leaked === false, JSON.stringify(i18nOk));

  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'capability-packs.png'), img.toPNG());
    record('screenshot captured', img.getSize().width > 0, `${img.getSize().width}x${img.getSize().height}`);
  } catch (e) {
    record('screenshot captured', false, String(e));
  }
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
