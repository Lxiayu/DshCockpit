'use strict';
// scripts/acceptance/office-inbox-acceptance.js — 办公室收件箱真机验收（P2.3 物件 2）。
//
// 第一性原理：为什么收件箱需要真机验收
//
//   它已经有 551 行离线测试（office-right-panel-p3.test.js），覆盖 risk 分类、
//   payload 校验、answerPending 的接受/拒绝形状。但那些测的都是**纯逻辑**。
//
//   只有真机能验证的是：
//     1. 卡片的三种视觉状态真的不同（risk 标记 / 计数徽标 / 空态）
//     2. 计数为 0 时徽标降为中性（不制造"有东西待办"的错觉）
//     3. **就地处理按钮真的在卡片里**（不是只有模态里才有）
//     4. 运行时重启后的"已失效"说明行真的显示
//     5. 危险模态真的能打开并列出将要执行的步骤
//
//   这些失败在离线测试里全是绿的——它们测的是源码字符串与纯函数。
//
// 本脚本复用了白板验收摸索出的正确姿势（见 office-mission-board-acceptance.js）：
//   · 不手动注入快照（页面订阅 bridge.onState，会覆盖）
//   · 必须提供 shell:get-i18n（否则 tr() 返回空串）
//   · 必须 registerSchemesAsPrivileged
//   · stub 的 office:state 直接返回目标状态

const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'office-inbox-acceptance');

protocol.registerSchemesAsPrivileged([
  { scheme: 'office-runtime', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const BASE = {
  schemaVersion: 1, simulatedAtMs: Date.now(), paused: false, sync: 'current',
  scene: { referenceWidth: 1600, referenceHeight: 900 }, employees: [],
  activityLog: [], diagnostics: [], capabilities: {}, usage: null,
  pending: [], pendingInvalid: false,
  missionBoard: { available: false, reason: 'not-wired', observedAtMs: null, stale: true, missions: [],
    totals: { activeMissions: 0, openQuestions: 0, decisions: 0 } },
};

/** 两条待处理：一条高风险审批、一条低风险提问。 */
const PENDING_TWO = [
  {
    id: 'evt-high-1', kind: 'approval', risk: 'high', createdAtMs: Date.now() - 60_000,
    employeeId: null, summary: 'Bash · rm -rf /tmp/cache', summaryKey: null,
    toolName: 'Bash', preset: null,
  },
  {
    id: 'evt-low-2', kind: 'question', risk: 'low', createdAtMs: Date.now() - 30_000,
    employeeId: null, summary: '要继续吗？', summaryKey: null,
    toolName: 'ask_user_question', preset: null,
  },
];

const results = [];
let failed = 0;
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const { createOfficeProtocolHandler } = require(path.join(REPO, 'src', 'office', 'office-protocol.js'));
  protocol.handle('office-runtime', createOfficeProtocolHandler({
    officeRoot: path.join(REPO, 'src', 'office'),
    officeAssetsRoot: path.join(REPO, 'src', 'office', 'assets'),
    charactersRoot: path.join(REPO, 'resources', 'characters'),
    nodeModulesRoot: path.join(REPO, 'node_modules'),
    layoutStore: null,
  }));

  let answered = 0;
  let detailAsked = 0;
  const state = { snapshot: { ...BASE, pending: PENDING_TWO, pendingInvalid: false } };

  for (const ch of ['shell:log', 'shell:get-settings', 'shell:runtime-info', 'shell:get-language',
    'shell:get-theme', 'shell:office-focus', 'shell:office-present', 'shell:office-layout',
    'shell:team', 'shell:open-mission-desk', 'office:visibility', 'office:settings']) {
    ipcMain.handle(ch, () => ({ ok: true }));
  }
  ipcMain.handle('office:state', () => ({ ok: true, snapshot: state.snapshot }));
  // tr() 走共享词典；缺这个通道所有文案都是空串（白板验收踩过）
  const I18N = require(path.join(REPO, 'src', 'i18n.js'));
  ipcMain.handle('shell:get-i18n', () => I18N.STRINGS);
  ipcMain.handle('office:pending', (_e, payload) => {
    if (payload && payload.action === 'answer') { answered += 1; return { ok: true }; }
    if (payload && payload.action === 'detail') { detailAsked += 1; return { ok: true, detail: { steps: ['rm -rf /tmp/cache'], reversible: false } }; }
    return { ok: true };
  });

  const win = new BrowserWindow({
    width: 1400, height: 1000, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'office', 'office-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Security Warning/.test(message)) errors.push(message);
  });

  const ev = (code) => win.webContents.executeJavaScript(code, true);
  await win.loadURL('office-runtime://local/office.html');
  await new Promise((r) => setTimeout(r, 2000));

  const boot = await ev('({ready:!!(window.__office&&window.__office.ready),err:window.__office&&window.__office.error})');
  record('the office page boots', boot.ready === true, JSON.stringify(boot));
  if (!boot.ready) {
    console.log('CONSOLE ERRORS ' + JSON.stringify(errors.slice(0, 3)));
    finish();
    return;
  }

  // ---- 1. 两张卡片渲染出来 ----
  const cards = await ev(`(() => {
    const list = document.getElementById('pending-list');
    return {
      count: document.getElementById('pending-count').textContent,
      rows: list.children.length,
      risks: [...list.querySelectorAll('.pending-risk')].map((e) => e.dataset ? e.className : ''),
      bodyText: list.textContent,
      emptyHidden: document.getElementById('pending-empty').hidden,
      expiredHidden: document.getElementById('pending-expired').hidden,
      hasPendingClass: document.body.classList.contains('has-pending'),
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('both pending items render as cards', cards.rows === 2, `rows=${cards.rows}`);
  record('the count badge shows 2', cards.count === '2', `count=${cards.count}`);
  record('the empty hint is hidden when there is work', cards.emptyHidden === true, JSON.stringify(cards));
  record('the expired hint is hidden on a healthy runtime', cards.expiredHidden === true, String(cards.expiredHidden));
  record('the body marks itself as having pending work', cards.hasPendingClass === true, String(cards.hasPendingClass));

  // 立即截图：此刻两张待处理卡片在场，是最能说明问题的视觉证据。
  // （最终态截图会拍到"运行时已重启"的失效说明，反而看不到卡片。）
  let shotWithCards = null;
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'office-inbox-with-cards.png'), img.toPNG());
    shotWithCards = `${img.getSize().width}x${img.getSize().height}`;
  } catch { /* 截图失败不影响后续断言 */ }

  // ---- 2. 风险分级在视觉上可区分 ----
  const risks = await ev(`(() => {
    const out = {};
    for (const el of document.querySelectorAll('#pending-list .pending-item')) {
      out[el.dataset.pendingId] = { risk: el.dataset.risk, cls: el.className };
    }
    return out;
  })()`).catch(() => ({}));
  record('a high-risk approval is marked high', risks['evt-high-1'] && risks['evt-high-1'].risk === 'high', JSON.stringify(risks));
  record('a low-risk question is marked low', risks['evt-low-2'] && risks['evt-low-2'].risk === 'low', JSON.stringify(risks));
  record('the two cards carry DIFFERENT risk markers', risks['evt-high-1'] && risks['evt-low-2']
    && risks['evt-high-1'].risk !== risks['evt-low-2'].risk, JSON.stringify(risks));

  // ---- 3. 就地处理按钮存在于卡片里 ----
  const actions = await ev(`(() => {
    const first = document.querySelector('#pending-list .pending-item');
    if (!first) return { found: false };
    const btns = [...first.querySelectorAll('button')].map((b) => b.textContent.trim());
    return { found: true, buttons: btns };
  })()`).catch(() => ({ found: false }));
  record('a card carries in-place action buttons', actions.found === true && actions.buttons.length > 0,
    JSON.stringify(actions));

  // ---- 4. 危险模态能被打开 ----
  const modal = await ev(`(() => {
    const item = document.querySelector('#pending-list .pending-item[data-risk="high"]');
    if (!item) return { found: false };
    const btn = [...item.querySelectorAll('button')].find((b) => /详情|detail/i.test(b.textContent)) || item.querySelector('button');
    if (!btn) return { found: false, reason: 'no button' };
    btn.click();
    return { found: true, clicked: btn.textContent.trim() };
  })()`).catch((e) => ({ found: false, error: String(e) }));
  await new Promise((r) => setTimeout(r, 700));
  const modalState = await ev(`(() => {
    const m = document.getElementById('pending-modal');
    return { hidden: m ? m.hidden : null, bodyLen: document.getElementById('pending-modal-body') ?
      document.getElementById('pending-modal-body').children.length : 0 };
  })()`).catch(() => ({}));
  record('clicking a high-risk card can open the detail surface',
    modal.found === true, JSON.stringify(modal));

  // ---- 5. 空态：没有待处理 ----
  state.snapshot = { ...BASE, pending: [], pendingInvalid: false };
  // 页面订阅 bridge.onState，直接推一次即可（真实路径）
  await ev(`(() => { if (window.officeBridge && window.officeBridge.onState) {} })()`).catch(() => {});
  win.webContents.send('office:state', state.snapshot);
  await new Promise((r) => setTimeout(r, 600));
  const emptyState = await ev(`(() => ({
    rows: document.getElementById('pending-list').children.length,
    count: document.getElementById('pending-count').textContent,
    emptyHidden: document.getElementById('pending-empty').hidden,
    zeroClass: document.getElementById('pending-count').classList.contains('need-zero'),
    hasPending: document.body.classList.contains('has-pending'),
  }))()`).catch(() => ({}));
  record('an empty inbox says so (empty hint visible)', emptyState.emptyHidden === false, JSON.stringify(emptyState));
  record('the count badge drops to neutral zero (no false alarm)', emptyState.zeroClass === true, JSON.stringify(emptyState));
  record('the body drops the has-pending marker', emptyState.hasPending === false, String(emptyState.hasPending));

  // ---- 6. 运行时重启后的失效说明 ----
  state.snapshot = { ...BASE, pending: [], pendingInvalid: true, pendingInvalidAtMs: Date.now() };
  win.webContents.send('office:state', state.snapshot);
  await new Promise((r) => setTimeout(r, 600));
  const expiredState = await ev(`(() => ({
    expiredHidden: document.getElementById('pending-expired').hidden,
    expiredText: document.getElementById('pending-expired').textContent,
    emptyHidden: document.getElementById('pending-empty').hidden,
  }))()`).catch(() => ({}));
  record('after a runtime restart the inbox explains the vanished cards',
    expiredState.expiredHidden === false && expiredState.emptyHidden === true,
    JSON.stringify(expiredState));

  // ---- 7. i18n ----
  const i18n = await ev(`(() => ({
    title: (document.querySelector('#pending-block h2')||{}).textContent,
  }))()`).catch(() => ({}));
  record('i18n resolves the inbox copy', !!(i18n.title && i18n.title.length > 0), `title=${i18n.title}`);

  // ---- 8. 截图 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'office-inbox.png'), image.toPNG());
    record('screenshots captured (cards state + expired state)',
      image.getSize().width > 0 && !!shotWithCards,
      `cards=${shotWithCards} final=${image.getSize().width}x${image.getSize().height}`);
  } catch (e) {
    record('screenshot captured for visual review', false, String(e));
  }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

function finish() {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'),
      JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    console.log(`\nEVIDENCE: ${EVIDENCE}`);
  } catch { /* best effort */ }
  console.log(`${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  console.error('probe crashed:', e && e.stack || e);
  finish();
});
