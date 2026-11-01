'use strict';
// scripts/acceptance/mission-desk-structured-options-acceptance.js
// 结构化选项真机验收：右栏是否真的把"自由文本框"升级成"选项按钮"。
//
// 第一性原理：为什么必须真机验
//   离线能证明源码里有 findStructuredQuestion。
//   证明不了：
//     · 选项**真的渲染成按钮**了吗
//     · 点击**真的把 label 作为答案送出去**了吗
//     · 投影拿不到时**真的回落到自由文本**了吗（不能两种都显示）

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-structured-options-acceptance');
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
const LIVE = { available: true, observedAtMs: NOW, hasRunningAgent: true, pendingApprovals: 0, pendingQuestions: 1 };
const ATT_QUESTION = {
  ok: true, available: true, observedAtMs: NOW, total: 1,
  counts: { approval: 0, question: 1 },
  items: [{ id: 'call-1', kind: 'question', risk: 'medium', summary: '选择研究方法', createdAtMs: NOW - 60e3 }],
};
// 投影：带结构化选项
let PROJ = {
  ok: true, available: true, asOfSeq: 9, userQuestionsAvailable: true, settledCount: 0,
  agentPreset: 'standard',
  activeQuestions: [{
    callId: 'call-1', state: 'pending',
    questions: [{
      id: 'q1', question: '应该优先采用哪种研究方法？',
      detail: '这会影响后续三周的工作安排。',
      options: [
        { label: '实证研究：优先收集实验数据' },
        { label: '文献综述：优先梳理已有研究' },
        { label: '混合研究：两种方法结合' },
      ],
      multiSelect: false,
    }],
  }],
};
const answered = [];

async function main() {
  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return ATT_QUESTION;
      case 'sinceLastSeen': return { ok: true, available: false, reason: 'never-seen', entries: [] };
      case 'sessionProjections': return PROJ;
      case 'markSeen': return { ok: true };
      case 'getBrief': return { ok: true, brief: { text: '' } };
      case 'briefSyncState': return { ok: true, synced: false };
      default: return { ok: false, code: 'UNKNOWN_ACTION' };
    }
  });
  ipcMain.handle('office:pending', (_e, payload) => { answered.push(payload); return { ok: true }; });
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

  // ---- 1. 选项真的渲染成按钮 ----
  const opts = await ev(`(() => {
    const box = document.querySelector('.att-options');
    if (!box) return { missing: true };
    const btns = [...box.querySelectorAll('button')];
    return {
      count: btns.length,
      labels: btns.map((b) => b.textContent),
      visible: box.offsetParent !== null,
      hasFreeText: !!document.querySelector('.att-item-actions input'),
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('structured options render as BUTTONS (not a text box)', opts.missing !== true && opts.count === 3,
    JSON.stringify(opts.labels));
  record('the option labels come from the runtime projection', 
    (opts.labels || []).some((l) => /实证研究/.test(l)), '');
  record('options are visible', opts.visible === true, '');
  record('a custom-answer escape hatch is still offered (official allows free input)',
    opts.hasFreeText === true, '');

  // ---- 2. 点击选项 → 把 label 作为答案送出 ----
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.att-options button')]
      .find((x) => x.textContent.includes('文献综述'));
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 800));
  record('clicking an option sends the LABEL as the answer',
    answered.length > 0 && answered[0].value === '文献综述：优先梳理已有研究',
    JSON.stringify(answered[0] || null));
  record('the answer still uses the real office:pending payload shape',
    answered[0] && answered[0].action === 'answer' && answered[0].id === 'call-1', '');

  // ---- 3. 投影不可用时回落到自由文本 ----
  PROJ = { ok: true, available: false, reason: 'userQuestions projection not available' };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 1200));
  const fallback = await ev(`(() => ({
    hasOptions: !!document.querySelector('.att-options'),
    hasInput: !!document.querySelector('.att-item-actions input'),
    hasPrimaryBtn: !!document.querySelector('.att-item-actions button.att-btn.primary'),
  }))()`).catch(() => ({}));
  record('when projections are unavailable it FALLS BACK to free text',
    fallback.hasOptions === false && fallback.hasInput === true, JSON.stringify(fallback));
  record('the fallback keeps a primary "回答" button', fallback.hasPrimaryBtn === true, '');

  // ---- 4. 截图 ----
  PROJ = {
    ok: true, available: true, asOfSeq: 9, userQuestionsAvailable: true, settledCount: 0,
    agentPreset: 'standard',
    activeQuestions: [{
      callId: 'call-1', state: 'pending',
      questions: [{
        id: 'q1', question: '应该优先采用哪种研究方法？',
        detail: '这会影响后续三周的工作安排。',
        options: [
          { label: '实证研究：优先收集实验数据' },
          { label: '文献综述：优先梳理已有研究' },
          { label: '混合研究：两种方法结合' },
        ],
      }],
    }],
  };
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 900));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `structured-options-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
