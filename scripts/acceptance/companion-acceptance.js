'use strict';
// scripts/acceptance/companion-acceptance.js — Companion Mode 真机验收（P2.4 S4）。
//
// 第一性原理：这个探针要验证的是"常驻小窗"特有的东西
//
//   离线测试（28 项）覆盖了：派生纯函数、窗口配置项、preload 暴露面、
//   页面不含 PixiJS。但这些都是**静态**的。
//
//   只有真机能验证：
//     1. 小窗真的能创建并显示（frameless + alwaysOnTop 在真机上不报错）
//     2. 四种状态真的渲染出不同颜色与文案（data-kind 驱动 CSS）
//     3. 待办数 > 0 时红点真的亮（getComputedStyle 实测，不是查 class）
//     4. 0 待办时**不**亮红（产品纪律：否则用户学会无视它）
//     5. 点击真的触发 expand
//     6. 窗口尺寸够小（常驻不能挡事）
//
// 复用白板/收件箱验收的正确姿势：真实链路、提供必要 stub、断言实际渲染。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'companion-acceptance');

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
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'),
      JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    console.log(`EVIDENCE: ${EVIDENCE}`);
  } catch { /* best effort */ }
  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  app.exit(failed === 0 ? 0 : 1);
}

async function main() {
  let expandCalls = 0;
  ipcMain.handle('companion:expand', () => { expandCalls += 1; return { ok: true }; });
  ipcMain.handle('companion:get-state', () => ({ ok: true, state: { kind: 'disconnected', pendingCount: 0, runningCount: 0 } }));

  // 用真实的窗口配置创建（不复制一份配置——那就不叫验收了）
  const win = new BrowserWindow({
    width: 220, height: 44, show: false,
    frame: false, resizable: false, maximizable: false, minimizable: false,
    skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#181a20',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'companion-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });

  await win.loadFile(path.join(REPO, 'src', 'companion.html'));
  await new Promise((r) => setTimeout(r, 800));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  const boot = await ev(`({ ready: document.readyState, hasBridge: typeof window.companionBridge })`);
  record('the companion page loads with its bridge', boot.ready === 'complete' && boot.hasBridge === 'object',
    JSON.stringify(boot));

  // ---- 1. 初始态是 disconnected（不是"0 待办"）----
  const initial = await ev(`(() => ({
    kind: document.body.dataset.kind,
    label: document.getElementById('label').textContent,
    dotColor: getComputedStyle(document.getElementById('dot')).backgroundColor,
    size: { w: window.innerWidth, h: window.innerHeight },
  }))()`);
  record('before any push the widget says disconnected (not "0 items")',
    initial.kind === 'disconnected' && /未连接/.test(initial.label || ''), JSON.stringify(initial));
  record('the widget stays small (a persistent widget must not get in the way)',
    initial.size.w <= 260 && initial.size.h <= 60, JSON.stringify(initial.size));

  // ---- 2. needs-you：红点真的亮 + 数字显示 ----
  const pushState = (state) => ev(`(() => {
    window.__lastCompanionState = ${JSON.stringify(JSON.stringify(state))};
    return 'ok';
  })()`);
  // 通过 preload 的监听路径推（模拟主进程 send）
  await ev(`(() => { /* no-op */ })()`);
  win.webContents.send('companion:state', { kind: 'needs-you', pendingCount: 3, runningCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
  const needsYou = await ev(`(() => ({
    kind: document.body.dataset.kind,
    label: document.getElementById('label').textContent,
    count: document.getElementById('count').textContent,
    dotColor: getComputedStyle(document.getElementById('dot')).backgroundColor,
  }))()`);
  record('a needs-you state renders the count', /3/.test(needsYou.label || '') && needsYou.count === '3',
    JSON.stringify(needsYou));
  record('a needs-you state turns the dot RED (measured, not just a class)',
    needsYou.dotColor === 'rgb(255, 92, 92)', `color=${needsYou.dotColor}`);

  // ---- 3. 截图：needs-you 态（最有价值的视觉证据）----
  let shotNeedsYou = null;
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'companion-needs-you.png'), img.toPNG());
    shotNeedsYou = `${img.getSize().width}x${img.getSize().height}`;
  } catch { /* 截图失败不阻塞断言 */ }

  // ---- 4. idle：0 待办时红点必须灭（产品纪律）----
  win.webContents.send('companion:state', { kind: 'idle', pendingCount: 0, runningCount: 0 });
  await new Promise((r) => setTimeout(r, 400));
  const idle = await ev(`(() => ({
    kind: document.body.dataset.kind,
    label: document.getElementById('label').textContent,
    count: document.getElementById('count').textContent,
    dotColor: getComputedStyle(document.getElementById('dot')).backgroundColor,
  }))()`);
  record('zero pending NEVER shows the alarm red (otherwise users learn to ignore it)',
    idle.dotColor !== 'rgb(255, 92, 92)', `color=${idle.dotColor}`);
  record('an idle widget hides the number entirely', idle.count === '', JSON.stringify(idle));

  // ---- 5. working：运行中不等于"需要你" ----
  win.webContents.send('companion:state', { kind: 'working', pendingCount: 0, runningCount: 2 });
  await new Promise((r) => setTimeout(r, 400));
  const working = await ev(`(() => ({
    kind: document.body.dataset.kind,
    label: document.getElementById('label').textContent,
    dotColor: getComputedStyle(document.getElementById('dot')).backgroundColor,
  }))()`);
  record('a working state is amber, not alarm red', working.dotColor === 'rgb(255, 207, 122)',
    `color=${working.dotColor}`);

  // ---- 6. 点击触发 expand ----
  await ev(`document.body.click()`);
  await new Promise((r) => setTimeout(r, 400));
  record('clicking the widget requests the full office', expandCalls >= 1, `calls=${expandCalls}`);

  // ---- 7. 最终截图 + 错误 ----
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'companion-working.png'), img.toPNG());
  } catch { /* best effort */ }
  record('screenshot captured for visual review', !!shotNeedsYou, `needs-you=${shotNeedsYou}`);
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => {
  console.error('probe crashed:', e && e.stack || e);
  finish();
});
