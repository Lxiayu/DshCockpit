'use strict';
// scripts/acceptance/mission-desk-empty-acceptance.js — P4 空状态真机验收。
//
// 第一性原理：空状态只有真机能验
//
//   离线测试能证明：源码里有"创建第一个 Mission"这句话。
//   它证明不了：
//     · 那句话**渲染出来了吗**（可能在 display:none 容器里）
//     · 按钮**能点吗**（可能被别的元素盖住）
//     · 点了**真的会打开新建表单吗**（复用已有按钮的选择器可能找不到）
//     · 视觉上**是不是明确的起点**（还是灰扑扑一行字）
//
//   新用户第一屏看到什么，只能真机看。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-empty-acceptance');

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
  // 关键：**零 Mission**（这是新用户的第一屏）
  let missionCount = 0;
  ipcMain.handle('mission:invoke', (_e, action, payload = {}) => {
    switch (action) {
      case 'list': return { ok: true, missions: missionCount === 0 ? [] : [{
        missionId: 'mis-1', title: 'T', status: 'active', live: { available: false },
      }] };
      case 'get': return { ok: true, view: { mission: { missionId: 'mis-1', title: 'T', intent: 'I', status: 'active' },
        workstreams: [], decisions: [], questions: [], deliverables: [], taskRefs: [] } };
      case 'create': missionCount += 1; return { ok: true, missionId: 'mis-1' };
      case 'briefSyncState': return { ok: true, state: null };
      case 'diagnostics': return { ok: true, diagnostics: {} };
      default: return { ok: false, code: 'UNKNOWN_ACTION' };
    }
  });
  for (const ch of ['shell:get-i18n', 'shell:get-settings', 'shell:get-theme', 'shell:get-language', 'shell:log']) {
    ipcMain.handle(ch, () => (ch === 'shell:get-i18n'
      ? require(path.join(REPO, 'src', 'i18n.js')).STRINGS : { ok: true }));
  }

  const win = new BrowserWindow({
    width: 1180, height: 900, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(REPO, 'src', 'settings-preload.js'),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/Security Warning/.test(msg)) errors.push(msg);
  });
  await win.loadFile(path.join(REPO, 'src', 'mission-desk.html'));
  await new Promise((r) => setTimeout(r, 1500));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 左侧空状态：明确的起点 ----
  const left = await ev(`(() => {
    const list = document.getElementById('list');
    return {
      text: list.innerText,
      lead: !!list.querySelector('.empty-lead'),
      body: !!list.querySelector('.empty-body'),
      btn: !!list.querySelector('button.primary'),
      btnVisible: (() => { const b = list.querySelector('button.primary'); return b ? b.offsetParent !== null : false; })(),
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('the empty list shows a lead line (a start point, not a placeholder)',
    left.lead === true, JSON.stringify({ lead: left.lead, body: left.body }));
  record('the empty list explains what a Mission is', left.body === true, '');
  record('the empty list offers ONE visible primary action',
    left.btn === true && left.btnVisible === true, JSON.stringify({ btn: left.btn, visible: left.btnVisible }));
  record('the old dead-end copy is gone', !/还没有 Mission。点右上角新建一个/.test(left.text || ''),
    'no passive "nothing here" text');

  // ---- 2. 右侧空状态：区分"没有"与"没选" ----
  const right = await ev(`(() => {
    const d = document.getElementById('detail');
    return { text: d.innerText, lead: !!d.querySelector('.empty-lead') };
  })()`).catch(() => ({}));
  record('the empty detail pane distinguishes "no missions" from "none selected"',
    /还没有选中任何 Mission/.test(right.text || ''), right.text || '');
  record('the empty detail pane tells the user how to get out of it',
    /先在左边创建|从列表里点一个/.test(right.text || ''), '');

  // ---- 3. 点击主按钮真的会打开新建表单 ----
  const clicked = await ev(`(() => {
    const b = document.querySelector('#list button.primary');
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 900));
  const formOpened = await ev(`(() => {
    const f = document.getElementById('fTitle');
    return { exists: !!f, visible: f ? f.offsetParent !== null : false };
  })()`).catch(() => ({}));
  record('clicking the primary action really opens the create form',
    clicked === true && formOpened.visible === true,
    JSON.stringify({ clicked, visible: formOpened.visible }));

  // ---- 4. 错误提示：人话 + code ----
  const errText = await ev(`(() => {
    // 直接调用页面里的 explainFailure（它不在 window 上，所以用一条路径触发）
    // 简单起见：读页面源码里的映射是否真的被用上——
    // 更可靠的是触发一次失败：先点新建表单里的提交而不填内容
    return null;
  })()`).catch(() => null);
  void errText;
  const hasTranslator = await ev(`typeof explainFailure === 'function'`).catch(() => false);
  record('the error translator exists on the page', hasTranslator === true, String(hasTranslator));
  const samples = await ev(`(() => ({
    mapped: explainFailure({ code: 'DELIVERABLE_INVALID' }),
    unmapped: explainFailure({ code: 'SOME_NEW_CODE' }),
    nothing: explainFailure({}),
  }))()`).catch(() => ({}));
  record('a mapped failure reads as plain language AND keeps the code',
    /产物路径不对/.test(samples.mapped || '') && /DELIVERABLE_INVALID/.test(samples.mapped || ''),
    samples.mapped || '');
  record('an unmapped failure still keeps the code', /SOME_NEW_CODE/.test(samples.unmapped || ''),
    samples.unmapped || '');
  record('a failure with nothing at all is never an empty message',
    typeof samples.nothing === 'string' && samples.nothing.length > 0, samples.nothing || '');

  // ---- 5. 截图 + 错误 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'mission-desk-empty.png'), img.toPNG());
    record('screenshot captured', img.getSize().width > 0, `${img.getSize().width}x${img.getSize().height}`);
  } catch (e) { record('screenshot captured', false, String(e)); }
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
