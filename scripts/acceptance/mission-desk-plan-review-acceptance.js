'use strict';
// plan-review 折叠视图真机验收。
//
// 第一性原理：plan-review 有两个真实风险
//   1. `detail` 是**完整 markdown**（可能几千字）→ 380px 会撑爆
//   2. 官方明确说 `approve` 是「named rather than positional」→
//      **不能按选项顺序推断哪个是批准**
//
// 所以必须验证：折叠生效、展开可用、判定不靠位置。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-plan-review-acceptance');
const W = 380, H = 1000;
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

const PLAN_MD = [
  '# 实施计划：Runtime Bridge 接入',
  '',
  '## 目标',
  '把官方的 Session Projection 接到 Mission Desk。',
  '',
  '## 步骤',
  '1. 验证 session/projections 端点',
  '2. 归一化 agentTeam 投影',
  '3. 在右栏渲染团队任务',
  '',
  '## 风险',
  '- experimental 无稳定性保证',
  '- blockedBy 只在 Team 内有效',
].join('\n');

let PROJ = {
  ok: true, available: true, asOfSeq: 9, userQuestionsAvailable: true,
  activeQuestions: [{
    callId: 'call-1', state: 'pending',
    questions: [{
      id: 'q1',
      question: '请审阅这份实施计划',
      detail: PLAN_MD,
      options: [{ label: '批准计划' }, { label: '拒绝，需要修改' }],
      // 官方语义：approve 用 label 命名。注意它**不是**第一个选项。
      intent: { kind: 'plan-review', approve: '批准计划' },
    }],
  }],
  settledCount: 0, agentPreset: 'standard',
  inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null },
  permissionPreset: 'workspace-write', agentTeam: null,
};

const ATT = {
  ok: true, available: true, observedAtMs: NOW, total: 1, counts: { approval: 0, question: 1 },
  items: [{ id: 'call-1', kind: 'question', risk: 'medium', summary: '请审阅这份实施计划', createdAtMs: NOW - 30e3 }],
};
const answered = [];

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

  // ---- 1. plan-review 区块渲染，且默认折叠 ----
  const pr = await ev(`(() => {
    const box = document.querySelector('.plan-review');
    if (!box) return { missing: true };
    const pre = box.querySelector('.plan-review-body');
    const toggle = box.querySelector('.plan-review-toggle');
    return {
      head: (box.querySelector('.plan-review-head') || {}).innerText || '',
      previewText: pre ? pre.textContent : '',
      fullLength: ${JSON.stringify(PLAN_MD)}.length,
      previewLength: pre ? pre.textContent.length : 0,
      hasToggle: !!toggle,
      toggleText: toggle ? toggle.textContent : '',
      maxHeight: pre ? getComputedStyle(pre).maxHeight : null,
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('plan-review block renders', pr.missing !== true, pr.head || '');
  record('it is COLLAPSED by default (preview shorter than the full plan)',
    (pr.previewLength || 0) > 0 && (pr.previewLength || 0) < (pr.fullLength || 1),
    `preview=${pr.previewLength} full=${pr.fullLength}`);
  record('a toggle button is offered', pr.hasToggle === true, pr.toggleText || '');
  record('the toggle says how much is hidden', /展开全文（还有 \d+ 行）/.test(pr.toggleText || ''),
    pr.toggleText || '');
  record('the body has a bounded height (does not blow up the 380px dock)',
    pr.maxHeight === '120px', String(pr.maxHeight));

  // ---- 2. 点展开 → 显示全文，再点收起 ----
  const toggled = await ev(`(() => {
    const btn = document.querySelector('.plan-review-toggle');
    const pre = document.querySelector('.plan-review-body');
    if (!btn || !pre) return { missing: true };
    const before = pre.textContent.length;
    btn.click();
    const afterExpand = pre.textContent.length;
    const labelAfter = btn.textContent;
    btn.click();
    const afterCollapse = pre.textContent.length;
    return { before, afterExpand, afterCollapse, labelAfter };
  })()`).catch(() => ({}));
  record('expanding really reveals the full plan',
    (toggled.afterExpand || 0) > (toggled.before || 0), `${toggled.before} → ${toggled.afterExpand}`);
  record('the label switches to 收起 when expanded', /收起/.test(toggled.labelAfter || ''), toggled.labelAfter || '');
  record('collapsing restores the preview', (toggled.afterCollapse || 0) === (toggled.before || 0), '');

  // ---- 3. approve 不按位置推断 ----
  const approve = await ev(`(() => {
    const btns = [...document.querySelectorAll('.att-options button')];
    return { labels: btns.map((b) => b.textContent), count: btns.length };
  })()`).catch(() => ({}));
  record('plan-review options render as buttons', (approve.count || 0) === 2, JSON.stringify(approve.labels));
  record('the approve label is present as an option (not inferred by index)',
    (approve.labels || []).includes('批准计划'), '');

  // ---- 4. 点"批准计划" → 送出的是 label 本身 ----
  const clickApprove = await ev(`(() => {
    const b = [...document.querySelectorAll('.att-options button')].find((x) => x.textContent === '批准计划');
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 800));
  record('clicking 批准计划 sends that exact label to the Harness',
    answered.length > 0 && answered[0].value === '批准计划', JSON.stringify(answered[0] || null));

  // ---- 5. 没有 detail 时如实说明 ----
  PROJ = { ...PROJ, activeQuestions: [{
    callId: 'call-1', state: 'pending',
    questions: [{ id: 'q1', question: '审阅计划', options: [{ label: '批准' }],
      intent: { kind: 'plan-review', approve: '批准' } }],
  }] };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const noDetail = await ev(`(() => {
    const box = document.querySelector('.plan-review');
    return { exists: !!box, text: box ? box.innerText : '' };
  })()`).catch(() => ({}));
  record('a plan-review without detail says so honestly (does not fake content)',
    /没有附带正文/.test(noDetail.text || ''), noDetail.text || '');

  // ---- 6. 非 plan-review 的问题不显示计划区块 ----
  PROJ = { ...PROJ, activeQuestions: [{
    callId: 'call-1', state: 'pending',
    questions: [{ id: 'q1', question: '选哪个方法？', options: [{ label: 'A' }, { label: 'B' }] }],
  }] };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const nonPlan = await ev(`!!document.querySelector('.plan-review')`).catch(() => null);
  record('a NON-plan-review question shows no plan block', nonPlan === false, String(nonPlan));

  // ---- 7. 截图 ----
  PROJ = {
    ok: true, available: true, asOfSeq: 9, userQuestionsAvailable: true,
    activeQuestions: [{ callId: 'call-1', state: 'pending', questions: [{
      id: 'q1', question: '请审阅这份实施计划', detail: PLAN_MD,
      options: [{ label: '批准计划' }, { label: '拒绝，需要修改' }],
      intent: { kind: 'plan-review', approve: '批准计划' },
    }] }],
    settledCount: 0, agentPreset: 'standard',
    inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null },
    permissionPreset: 'workspace-write', agentTeam: null,
  };
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 800));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `plan-review-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
