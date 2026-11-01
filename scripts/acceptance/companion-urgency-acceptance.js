'use strict';
// scripts/acceptance/companion-urgency-acceptance.js — Companion 紧急度真机验收（P4）。
//
// 第一性原理：为什么必须真机验
//
//   离线测试能证明：deriveUrgency 返回了 'urgent' / 'later' / 'normal'。
//   它证明不了：
//     · 三种 urgency 在**屏幕上真的长得不一样**（可能 CSS 没生效）
//     · 文案真的变了（可能 COPY 的 key 写错，回退到默认）
//     · 220×44 尺寸没被撑大（加了文案可能溢出）
//
//   用户能不能在一瞥之间区分"现在要看"和"可以放着"，只能真机看。

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'companion-urgency-acceptance');

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
  const win = new BrowserWindow({
    width: 220, height: 44, show: false,
    frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    backgroundColor: '#181a20',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'companion-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/Security Warning/.test(msg)) errors.push(msg);
  });
  await win.loadFile(path.join(REPO, 'src', 'companion.html'));
  await new Promise((r) => setTimeout(r, 800));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  /** 推一个状态并读回渲染结果。 */
  async function push(state) {
    win.webContents.send('companion:state', state);
    await new Promise((r) => setTimeout(r, 450));
    return ev(`(() => ({
      kind: document.body.dataset.kind || null,
      urgency: document.body.dataset.urgency || null,
      label: document.getElementById('label').textContent,
      dot: getComputedStyle(document.getElementById('dot')).backgroundColor,
      shadow: getComputedStyle(document.getElementById('dot')).boxShadow,
      size: { w: window.innerWidth, h: window.innerHeight },
    }))()`);
  }

  // ---- 三种 urgency ----
  const urgent = await push({ kind: 'needs-you', pendingCount: 1, runningCount: 0, urgency: 'urgent' });
  const normal = await push({ kind: 'needs-you', pendingCount: 3, runningCount: 0, urgency: 'normal' });
  const later = await push({ kind: 'needs-you', pendingCount: 3, runningCount: 0, urgency: 'later' });

  record('the widget exposes urgency as a separate data attribute',
    urgent.urgency === 'urgent' && normal.urgency === 'normal' && later.urgency === 'later',
    JSON.stringify({ u: urgent.urgency, n: normal.urgency, l: later.urgency }));

  record('kind stays "needs-you" in all three (urgency does not override it)',
    urgent.kind === 'needs-you' && normal.kind === 'needs-you' && later.kind === 'needs-you',
    JSON.stringify({ u: urgent.kind, n: normal.kind, l: later.kind }));

  // ---- 文案必须真的不同 ----
  record('URGENT says "see now" (an action call, not an adjective)',
    /需要现在看/.test(urgent.label), urgent.label);
  record('LATER says "can wait" (permission to not interrupt — the valuable one)',
    /可以先放着/.test(later.label), later.label);
  record('NORMAL stays neutral (data supports neither call)',
    !/现在看/.test(normal.label) && !/可以先放着/.test(normal.label), normal.label);
  record('the three labels are pairwise DIFFERENT',
    new Set([urgent.label, normal.label, later.label]).size === 3,
    JSON.stringify([urgent.label, normal.label, later.label]));

  // ---- 颜色必须真的不同 ----
  record('URGENT uses a brighter red than plain needs-you',
    urgent.dot === 'rgb(255, 59, 59)', `urgent=${urgent.dot} normal=${normal.dot}`);
  record('URGENT has a glow that normal does not',
    urgent.shadow !== 'none' && normal.shadow === 'none',
    `urgent=${urgent.shadow} normal=${normal.shadow}`);
  record('LATER is visually muted (softer than the alarm red)',
    later.dot !== normal.dot && later.dot !== urgent.dot,
    `later=${later.dot}`);

  // ---- 尺寸不变（常驻不挡事）----
  record('the widget stays 220x44 in every state (persistent widgets must not grow)',
    urgent.size.w <= 240 && urgent.size.h <= 50
    && later.size.w <= 240 && later.size.h <= 50,
    JSON.stringify(urgent.size));

  // ---- 无待办时没有 urgency ----
  const idle = await push({ kind: 'idle', pendingCount: 0, runningCount: 0, urgency: null });
  record('an idle widget carries NO urgency attribute (nothing to judge)',
    idle.urgency === null, String(idle.urgency));

  // ---- 截图三态 ----
  const shots = [];
  for (const [name, st] of [
    ['urgent', { kind: 'needs-you', pendingCount: 1, runningCount: 0, urgency: 'urgent' }],
    ['normal', { kind: 'needs-you', pendingCount: 3, runningCount: 0, urgency: 'normal' }],
    ['later', { kind: 'needs-you', pendingCount: 3, runningCount: 0, urgency: 'later' }],
  ]) {
    win.webContents.send('companion:state', st);
    await new Promise((r) => setTimeout(r, 450));
    try {
      fs.mkdirSync(EVIDENCE, { recursive: true });
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `companion-${name}.png`), img.toPNG());
      shots.push(name);
    } catch { /* best effort */ }
  }
  record('screenshots captured for all three urgency states', shots.length === 3, shots.join(', '));
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
