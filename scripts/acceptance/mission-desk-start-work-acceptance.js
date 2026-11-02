'use strict';
// 「交给团队」真机验收 —— 解决"创建 Mission 后无事可做"
//
// 第一性原理：这个功能的存在理由就是用户的抱怨
//   "我创建了一个 mission，然后呢？没有反应了，我不知道下一步做什么。"
//
// 所以验收标准不是"按钮存在"，而是：
//   1. 用户能在**首屏**看到"下一步做什么"
//   2. 输入一句话就能真的把工作发出去（不是假成功）
//   3. 发出去之后**明确告诉用户去哪儿看**
//   4. 发给模型的文本带上了 Mission 的目标（否则 Agent 不知道在做哪个项目）

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-start-work-acceptance');
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

const MISSION = {
  missionId: 'mis-1', title: '调研 Agent Team 前沿', intent: '给我一份细致的报告',
  status: 'active',
  constraints: [{ id: 'c1', text: '不要自研 Harness', source: 'user' }],
};
const VIEW = {
  mission: MISSION, workstreams: [], decisions: [], questions: [], deliverables: [],
  taskRefs: [], findings: [], assumptions: [], evidences: [],
};
const LIVE = { available: true, observedAtMs: NOW, hasRunningAgent: false, pendingApprovals: 0, pendingQuestions: 0 };

let BOUND = { ok: true, bound: false, sessionId: null };
let WORK = { ok: true, bound: false, running: false };
const calls = [];

async function main() {
  ipcMain.handle('mission:invoke', (_e, action, payload) => {
    calls.push({ action, payload });
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...MISSION, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return { ok: true, available: true, total: 0, counts: {}, items: [] };
      case 'sinceLastSeen': return { ok: true, available: false, reason: 'never-seen', entries: [] };
      case 'sessionProjections': return { ok: true, available: false, reason: 'not wired' };
      case 'getBoundSession': return BOUND;
      case 'workStatus': return WORK;
      case 'startWork': {
        // 模拟真实后端：成功后变成已绑定
        BOUND = { ok: true, bound: true, sessionId: 'session-new-1234', boundAtMs: Date.now() };
        return { ok: true, sessionId: 'session-new-1234', delivered: true };
      }
      case 'markSeen': return { ok: true };
      case 'getBrief': return { ok: true, brief: { text: '# Mission: 调研 Agent Team 前沿' } };
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

  // ---- 1. 首屏就能看到"下一步做什么" ----
  const sw = await ev(`(() => {
    const box = document.querySelector('.start-work');
    if (!box) return { missing: true };
    const r = box.getBoundingClientRect();
    return {
      inViewport: r.top >= 0 && r.top < window.innerHeight,
      top: Math.round(r.top),
      head: (box.querySelector('.start-work-head') || {}).innerText || '',
      hint: (box.querySelector('.start-work-hint') || {}).innerText || '',
      hasInput: !!box.querySelector('.start-work-input'),
      hasButton: !!box.querySelector('.start-work-btn'),
      btnText: (box.querySelector('.start-work-btn') || {}).innerText || '',
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('the "交给团队" block is ABOVE the fold (the answer to "what next?")',
    sw.inViewport === true, `top=${sw.top}`);
  record('it has a clear heading', /交给团队/.test(sw.head || ''), sw.head || '');
  record('it explains what will happen', /会新开一个 Harness 会话|告诉团队/.test(sw.hint || ''), sw.hint || '');
  record('it has a one-line input (not a form)', sw.hasInput === true, '');
  record('it has ONE primary action', sw.hasButton === true && /交给团队/.test(sw.btnText || ''), sw.btnText || '');

  // ---- 2. 空输入不能发出去（防假成功）----
  const emptyClick = await ev(`(() => {
    const b = document.querySelector('.start-work-btn');
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 600));
  const emptyState = await ev(`(() => ({
    workCalls: ${JSON.stringify(calls.map((c) => c.action))},
    msg: (document.querySelector('.start-work-msg') || {}).innerText || '',
    msgIsErr: (document.querySelector('.start-work-msg') || {}).className || '',
  }))()`).catch(() => ({}));
  record('an EMPTY task is refused locally (never sent to the runtime)',
    !(emptyState.workCalls || []).includes('startWork'), '');
  record('and it tells the user why', /先写一句/.test(emptyState.msg || ''), emptyState.msg || '');
  void emptyClick;

  // ---- 3. 填一句话 → 真的发出去 ----
  const sent = await ev(`(() => {
    const ta = document.querySelector('.start-work-input');
    const b = document.querySelector('.start-work-btn');
    if (!ta || !b) return false;
    ta.value = '先调研 Agent Team 的前沿方案，输出对比报告';
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 1200));
  const afterSend = await ev(`(() => ({
    msg: (document.querySelector('.start-work-msg') || {}).innerText || '',
    msgCls: (document.querySelector('.start-work-msg') || {}).className || '',
    hasGoLink: !!document.querySelector('.start-work-link'),
    goText: (document.querySelector('.start-work-link') || {}).innerText || '',
  }))()`).catch(() => ({}));
  const startCall = calls.find((c) => c.action === 'startWork');
  record('a non-empty task really calls startWork', !!startCall, JSON.stringify(startCall && startCall.payload));
  record('the task text is sent verbatim', startCall && startCall.payload.task === '先调研 Agent Team 的前沿方案，输出对比报告', '');
  record('success gives EXPLICIT feedback (not silence)',
    /已交给团队/.test(afterSend.msg || ''), afterSend.msg || '');
  record('feedback is visually marked as success', /ok/.test(afterSend.msgCls || ''), afterSend.msgCls || '');

  // ---- 4. 发出去后告诉用户去哪儿看 ----
  record('after sending, it offers a way to SEE the execution',
    afterSend.hasGoLink === true, afterSend.goText || '');
  record('the link names the destination (Harness)',
    /Harness/.test(afterSend.goText || ''), afterSend.goText || '');

  // ---- 5. 发给模型的内容带上了 Mission 上下文 ----
  // （这是后端行为，但 UI 的 hint 必须让用户预期到）
  record('the hint tells the user the mission goal is carried over',
    /目标|带过去/.test(sw.hint || ''), sw.hint || '');

  // ---- 6. 已绑定后显示真实进度（不猜"完成"）----
  WORK = { ok: true, bound: true, available: true, turns: 3, steps: 17, hasRun: true };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const prog = await ev(`(() => {
    const p = document.querySelector('.start-work-progress');
    return {
      exists: !!p,
      line: (p && p.querySelector('.start-work-progress-line') || {}).innerText || '',
      hint: (p && p.querySelector('.start-work-progress-hint') || {}).innerText || '',
      full: p ? p.innerText : '',
    };
  })()`).catch(() => ({}));
  record('after binding, REAL progress is shown (turns/steps from the projection)',
    /3 轮/.test(prog.line || '') && /17 步/.test(prog.line || ''), prog.line || '');
  record('progress does NOT claim the task succeeded',
    /不代表任务已经达到/.test(prog.hint || ''), prog.hint || '');
  record('it never says 已完成 / 成功',
    !/已完成|成功了|完成成功/.test(prog.full || ''), prog.full || '');

  // ---- 6b. 未完成时如实说"还没有完成的轮次" ----
  WORK = { ok: true, bound: true, available: true, turns: 0, steps: 4, hasRun: false };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const noRun = await ev(`(document.querySelector('.start-work-progress-line') || {}).innerText || ''`).catch(() => '');
  record('with zero finished turns it says so honestly',
    /还没有完成的轮次/.test(noRun), noRun || '');

  // ---- 7. 截图 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 800));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `start-work-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
