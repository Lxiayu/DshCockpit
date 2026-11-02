'use strict';
// 待办两层分类真机验收。
//
// 第一性原理：为什么要分两层
//   如果所有东西都用红框，用户会学会无视红色 —— 第一层就失效了。
//   所以必须验证：
//     · 第一层（需要决策）用红框，且可操作
//     · 第二层（执行提醒）**中性样式**，不抢注意力
//     · 零决策但有提醒时，仍然明确说"不用你决策"

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-attention-layers-acceptance');
const W = 380, H = 900;
const NOW = Date.now();

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

const VIEW = {
  mission: { missionId: 'mis-1', title: 'T', intent: 'I', status: 'active' },
  workstreams: [], decisions: [], questions: [], deliverables: [], taskRefs: [],
  findings: [], assumptions: [], evidences: [],
};
const LIVE = { available: true, observedAtMs: NOW, hasRunningAgent: true, pendingApprovals: 1, pendingQuestions: 0 };

let ATT = {
  ok: true, available: true, observedAtMs: NOW, total: 1, counts: { approval: 1, question: 0 },
  items: [{ id: 'p1', kind: 'approval', risk: 'high', summary: '执行 rm -rf build', toolName: 'Bash', createdAtMs: NOW - 60e3 }],
};
let PROJ = {
  ok: true, available: true, asOfSeq: 5, userQuestionsAvailable: true,
  activeQuestions: [], settledCount: 0, agentPreset: 'standard',
  inbox: { nextTurnCount: 2, nextStepCount: 0, preview: '先改接口' },
  permissionPreset: 'workspace-write',
};

async function main() {
  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return ATT;
      case 'sinceLastSeen': return { ok: true, available: false, reason: 'never-seen', entries: [] };
      case 'sessionProjections': return PROJ;
      case 'markSeen': return { ok: true };
      case 'getBrief': return { ok: true, brief: { text: '' } };
      case 'briefSyncState': return { ok: true, synced: false };
      default: return { ok: false, code: 'UNKNOWN_ACTION' };
    }
  });
  ipcMain.handle('office:pending', () => ({ ok: true }));
  for (const ch of ['shell:get-i18n', 'shell:get-settings', 'shell:get-theme',
    'shell:get-language', 'shell:log', 'shell:office-settings-get']) {
    ipcMain.handle(ch, () => (ch === 'shell:get-i18n'
      ? require(path.join(REPO, 'src', 'i18n.js')).STRINGS : { ok: true }));
  }

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'settings-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/Security Warning/.test(msg)) errors.push(msg);
  });
  await win.loadFile(path.join(REPO, 'src', 'mission-desk.html'), { query: { dock: '1' } });
  await new Promise((r) => setTimeout(r, 1800));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 两层同时存在，但样式必须不同 ----
  const twoLayers = await ev(`(() => {
    const att = document.querySelector('.att');
    const rem = document.querySelector('.att-reminders');
    if (!att || !rem) return { attMissing: !att, remMissing: !rem };
    const cs = getComputedStyle(att);
    const remRow = document.querySelector('.att-rem');
    return {
      attBorder: cs.borderColor,
      headText: (att.querySelector('.att-head') || {}).innerText || '',
      remHead: (document.querySelector('.att-rem-head') || {}).innerText || '',
      remTitle: (document.querySelector('.att-rem-title') || {}).innerText || '',
      remTone: remRow ? remRow.dataset.tone : null,
      // 第一层有红边框，第二层没有自己的边框
      remHasOwnBorder: remRow ? getComputedStyle(remRow).borderWidth : null,
      attItemCount: att.querySelectorAll('.att-item').length,
      remCount: att.querySelectorAll('.att-rem').length,
    };
  })()`).catch((e) => ({ error: String(e) }));

  record('layer 1 (decisions) is rendered', (twoLayers.attItemCount || 0) === 1, '');
  record('layer 2 (execution reminders) is rendered', (twoLayers.remCount || 0) === 1, '');
  record('layer 1 header says 需要你决策', /需要你决策/.test(twoLayers.headText || ''), twoLayers.headText || '');
  record('layer 2 header explicitly says "不需要你决策"',
    /不需要你决策/.test(twoLayers.remHead || ''), twoLayers.remHead || '');
  record('layer 2 shows the REAL inbox count', /2 条/.test(twoLayers.remTitle || ''), twoLayers.remTitle || '');
  record('layer 2 rows have NO own border (visually lighter than layer 1)',
    twoLayers.remHasOwnBorder === '0px', String(twoLayers.remHasOwnBorder));

  // ---- 2. 零决策但有提醒 ----
  ATT = { ok: true, available: true, observedAtMs: NOW, total: 0, counts: { approval: 0, question: 0 }, items: [] };
  LIVE.pendingApprovals = 0;
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const clearWithRem = await ev(`(() => {
    const att = document.querySelector('.att');
    return {
      cls: att ? att.className : '',
      head: (att && att.querySelector('.att-head') || {}).innerText || '',
      hasRem: !!document.querySelector('.att-reminders'),
      msg: (att && att.querySelector('.att-clear-msg') || {}).innerText || '',
    };
  })()`).catch(() => ({}));
  record('zero decisions + reminders: header says NO decision needed',
    /没有需要你决策/.test(clearWithRem.head || ''), clearWithRem.head || '');
  record('zero decisions + reminders: still shows the reminders', clearWithRem.hasRem === true, '');
  record('zero decisions + reminders: explicitly says no action needed',
    /不需要你处理/.test(clearWithRem.msg || ''), clearWithRem.msg || '');
  record('zero decisions uses the calm style (att-clear, not att-present)',
    /att-clear/.test(clearWithRem.cls || ''), clearWithRem.cls || '');

  // ---- 3. 完全零数据：不编造提醒 ----
  PROJ = { ok: true, available: true, asOfSeq: 1, userQuestionsAvailable: true, activeQuestions: [], settledCount: 0, agentPreset: 'standard', inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null }, permissionPreset: 'workspace-write' };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const nothing = await ev(`(() => ({
    hasRem: !!document.querySelector('.att-reminders'),
    head: (document.querySelector('.att-head') || {}).innerText || '',
  }))()`).catch(() => ({}));
  record('when there is genuinely nothing, NO reminder block is fabricated',
    nothing.hasRem === false, '');
  record('and it says the team is running normally', /团队运行正常/.test(nothing.head || ''), nothing.head || '');

  // ---- 4. 权限风险提醒 ----
  PROJ = { ok: true, available: true, asOfSeq: 2, userQuestionsAvailable: true, activeQuestions: [], settledCount: 0, agentPreset: 'standard', inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null }, permissionPreset: 'danger-full-access' };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const perm = await ev(`(() => {
    const rows = [...document.querySelectorAll('.att-rem')];
    return { count: rows.length, tones: rows.map((r) => r.dataset.tone),
             text: rows.map((r) => r.innerText).join(' | ') };
  })()`).catch(() => ({}));
  record('danger-full-access produces a permission warning',
    (perm.count || 0) === 1 && /完整访问权限/.test(perm.text || ''), perm.text || '');
  record('the permission warning uses the warn tone (not the info tone)',
    (perm.tones || [])[0] === 'warn', JSON.stringify(perm.tones));

  // ---- 5. 截图 ----
  ATT = {
    ok: true, available: true, observedAtMs: NOW, total: 1, counts: { approval: 1, question: 0 },
    items: [{ id: 'p1', kind: 'approval', risk: 'high', summary: '执行 rm -rf build', toolName: 'Bash', createdAtMs: NOW - 60e3 }],
  };
  PROJ = { ok: true, available: true, asOfSeq: 5, userQuestionsAvailable: true, activeQuestions: [], settledCount: 0, agentPreset: 'standard', inbox: { nextTurnCount: 2, nextStepCount: 0, preview: '先改接口' }, permissionPreset: 'danger-full-access' };
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 800));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `layers-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
