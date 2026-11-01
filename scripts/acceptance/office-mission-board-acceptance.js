'use strict';
// scripts/acceptance/office-mission-board-acceptance.js — 项目白板真机验收（P2.3 S4）。
//
// 第一性原理：这个脚本验证的是**真实启动链路**，不是注入
//
//   上一轮我把这里做失败了，并且给出了一个**错误的诊断**：说
//   `latestSnapshot` 有三份作用域副本导致渲染不可验证。
//
//   真相是数据流一直是通的：
//     office:state → bridge.getState() → page.applySnapshot()
//       → onSnapshot 回调 → renderMissionBoard()
//
//   失败的真实原因全是**探针环境缺件**，逐层排查后一共 4 层：
//     1. 自定义协议必须 registerSchemesAsPrivileged，否则 CSP 拒绝 CSS/JS
//     2. office 页启动要 office:state / office:visibility，缺则 __office.ready=false
//     3. **页面订阅了 bridge.onState()**，每次推送都 applySnapshot，
//        会覆盖我手动注入的快照 —— 所以"注入后立即读"永远看到旧值
//     4. **tr() 走 officeBridge.i18n.t()**（共享词典），缺 shell:get-i18n
//        则所有文案是空串，白板标题和计数全空
//
//   第 3/4 条是上一轮误判的根源。教训：**先让真实链路跑通，再考虑注入**；
//   注入绕过订阅可以，但绕过 i18n 只会制造假失败。
//
// 所以本脚本**不注入快照**：让 stub 的 office:state 直接返回带白板的数据，
// 页面自然走完整启动链路。这才是有意义的验收。
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const path = require('node:path');
const REPO = '/Users/xia/program/dsh/DshCockpit';
const { createOfficeProtocolHandler } = require(path.join(REPO,'src','office','office-protocol.js'));
protocol.registerSchemesAsPrivileged([{scheme:'office-runtime',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);

const base = {
  schemaVersion:1, simulatedAtMs:Date.now(), paused:false, sync:'current',
  scene:{referenceWidth:1600,referenceHeight:900}, employees:[], activityLog:[],
  diagnostics:[], capabilities:{}, usage:null, pending:[], pendingInvalid:false,
};
const WITH_BOARD = {...base, missionBoard:{
  available:true, reason:null, observedAtMs:Date.now(), stale:false, moreCount:1,
  missions:[{missionId:'m1',label:'重构认证模块',status:'active',workstreamCount:3,activeWorkstreamCount:2,decisionCount:5,openQuestionCount:2,deliverableCount:1}],
  totals:{activeMissions:1,openQuestions:2,decisions:5}}};

app.whenReady().then(async () => {
  protocol.handle('office-runtime', createOfficeProtocolHandler({
    officeRoot: path.join(REPO,'src','office'), officeAssetsRoot: path.join(REPO,'src','office','assets'),
    charactersRoot: path.join(REPO,'resources','characters'), nodeModulesRoot: path.join(REPO,'node_modules'), layoutStore: null }));
  for(const ch of ['shell:log','shell:get-settings','shell:runtime-info','shell:get-language','shell:get-theme',
    'shell:office-focus','shell:office-present','shell:office-layout','shell:team','shell:open-mission-desk',
    'office:visibility','office:settings']) ipcMain.handle(ch,()=>({ok:true}));
  ipcMain.handle('office:state',()=>({ok:true,snapshot:WITH_BOARD}));
  // office 页的 tr() 通过 officeBridge.i18n.t() 读**共享词典**（src/i18n.js）。
  // 缺这个通道 → 所有文案返回空串（白板标题和计数都是空的，第一版就这样）。
  const I18N = require(path.join(REPO, 'src', 'i18n.js'));
  ipcMain.handle('shell:get-i18n', () => I18N.STRINGS);

  const win = new BrowserWindow({width:1400,height:1000,show:false,webPreferences:{
    contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(REPO,'src','office','office-preload.js')}});
  const errs=[]; win.webContents.on('console-message',(_e,l,m)=>{if(l>=2&&!/Security Warning/.test(m))errs.push(m);});
  await win.loadURL('office-runtime://local/office.html');
  await new Promise(r=>setTimeout(r,2000));
  const ev=(c)=>win.webContents.executeJavaScript(c,true);

  const boot = await ev(`({ready:!!(window.__office&&window.__office.ready),err:window.__office&&window.__office.error})`);
  console.log('BOOT', JSON.stringify(boot));
  if(!boot.ready){ console.log('ERRS', JSON.stringify(errs.slice(0,3))); app.exit(1); return; }

  // 不注入：验证**真实启动链路**（bridge.getState → page.applySnapshot → onSnapshot → renderMissionBoard）
  await new Promise(r=>setTimeout(r,800));
  const state = await ev(`(() => ({
    rows: document.getElementById('board-list').children.length,
    text: document.getElementById('board-list').textContent,
    unavailHidden: document.getElementById('board-unavailable').hidden,
    emptyHidden: document.getElementById('board-empty').hidden,
    staleHidden: document.getElementById('board-stale').hidden,
    moreHidden: document.getElementById('board-more').hidden,
    moreText: document.getElementById('board-more').textContent,
    title: (document.querySelector('#mission-board h2')||{}).textContent,
    needsYou: !!document.querySelector('.board-item-meta.needs-you'),
    needsYouColor: (() => {
      const el = document.querySelector('.board-item-meta.needs-you');
      return el ? getComputedStyle(el).color : null;
    })(),
  }))()`);

  const results = [];
  let failed = 0;
  const record = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: String(detail || '') });
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  record('the office page boots (__office.ready)', boot.ready === true, JSON.stringify(boot));

  record('the board renders the mission row', state.rows === 1, `rows=${state.rows}`);
  record('the mission label is shown', /重构认证模块/.test(state.text || ''), state.text);
  record('counting is rendered (workstreams + decisions)',
    /2\/3 条工作线/.test(state.text || '') && /5 条决策/.test(state.text || ''), state.text);
  record('"awaiting you" is surfaced', /2 个待回答/.test(state.text || ''), state.text);
  record('empty/unavailable hints stay hidden when data is ok',
    state.unavailHidden === true && state.emptyHidden === true, JSON.stringify(state));
  record('missions needing the user are visually highlighted',
    state.needsYou === true && state.needsYouColor !== null, `color=${state.needsYouColor}`);
  record('the "more missions" hint appears', state.moreHidden === false, state.moreText);
  record('i18n resolves the board copy', /项目白板/.test(state.title || ''), `title=${state.title}`);

  // ---- 截图存证 ----
  try {
    const fsx = require('node:fs');
    const osx = require('node:os');
    const dir = path.join(osx.tmpdir(), 'office-board-acceptance');
    fsx.mkdirSync(dir, { recursive: true });
    const image = await win.webContents.capturePage();
    fsx.writeFileSync(path.join(dir, 'office-board.png'), image.toPNG());
    fsx.writeFileSync(path.join(dir, 'results.json'),
      JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    record('screenshot captured for visual review', image.getSize().width > 0,
      `${image.getSize().width}x${image.getSize().height}`);
    console.log(`EVIDENCE: ${dir}`);
  } catch (e) {
    record('screenshot captured for visual review', false, String(e));
  }

  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);

  app.exit(failed === 0 ? 0 : 1);
}).catch(e=>{console.error('CRASH',e);app.exit(1);});
