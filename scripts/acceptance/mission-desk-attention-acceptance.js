'use strict';
// scripts/acceptance/mission-desk-attention-acceptance.js
// 待办区 + 离开期间 + 双主题 真机验收。
//
// 第一性原理：为什么这必须真机验
//
//   离线能证明源码里有 renderAttention、有 --att-bad-fg。
//   证明不了：
//     · 待办**真的在首屏可见**（可能在滚动区之外）
//     · 两种主题下**对比度都够**（浅色底上浅色字几乎看不见）
//     · 零待办时**真的显示"运行正常"**而不是空白
//     · 时间线**只列真实事件**（不是模型编的）

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-attention-acceptance');
const W = 380, H = 860;

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
  mission: { missionId: 'mis-1', title: 'DshCockpit Runtime 集成', intent: '完成 Agent Team 接入', status: 'active' },
  workstreams: [{ workstreamId: 'ws-1', title: 'Runtime Bridge', status: 'active', createdAtMs: Date.now() - 7200e3, updatedAtMs: Date.now() }],
  decisions: [{ decisionId: 'd-1', text: '暂不引入第二套 Harness', rationale: '官方已足够', status: 'accepted', decidedBy: 'user', decidedAtMs: Date.now() - 3600e3 }],
  questions: [{ questionId: 'q-1', text: '第二页做什么？', status: 'open', askedAtMs: Date.now() - 1800e3 }],
  deliverables: [{ deliverableId: 'del-1', label: '研究报告', relPath: 'docs/r.md', digest: 'sha256:abc', registeredAtMs: Date.now() - 600e3 }],
  taskRefs: [],
};
let LIVE = { available: true, observedAtMs: Date.now(), hasRunningAgent: true, pendingApprovals: 1, pendingQuestions: 1, awaitingUser: true };
function DELETE_LIVE_PENDING() {
  LIVE = { ...LIVE, pendingApprovals: 0, pendingQuestions: 0, awaitingUser: false };
}

// 每个场景可切换的待办 / 离开期间
let ATT = {
  ok: true, available: true, observedAtMs: Date.now(), total: 2,
  counts: { approval: 1, question: 1 },
  items: [
    { id: 'p1', kind: 'approval', risk: 'high', summary: '执行 rm -rf build', toolName: 'Bash', createdAtMs: Date.now() - 120e3 },
    { id: 'p2', kind: 'question', risk: 'low', summary: '要继续吗？', createdAtMs: Date.now() - 60e3 },
  ],
};
let SINCE = {
  ok: true, available: true, sinceMs: Date.now() - 3 * 3600e3, truncated: false, dropped: 0,
  entries: [
    { atMs: Date.now() - 3600e3, kind: 'decision', text: '暂不引入第二套 Harness', tone: 'ok' },
    { atMs: Date.now() - 1800e3, kind: 'question', text: '第二页做什么？', tone: 'warn' },
    { atMs: Date.now() - 600e3, kind: 'deliverable', text: '研究报告', tone: 'ok' },
  ],
};
const answered = [];
const seenCalls = [];

async function main() {
  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return ATT;
      case 'sinceLastSeen': return SINCE;
      case 'markSeen': seenCalls.push(Date.now()); return { ok: true, atMs: Date.now() };
      case 'getBrief': return { ok: true, brief: { text: 'b' } };
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

  // ---- 1. 待办置顶且首屏可见 ----
  const att = await ev(`(() => {
    const a = document.querySelector('.att');
    if (!a) return { missing: true };
    const r = a.getBoundingClientRect();
    const items = [...a.querySelectorAll('.att-item')];
    return {
      cls: a.className,
      top: Math.round(r.top),
      inViewport: r.top >= 0 && r.top < window.innerHeight,
      text: a.innerText,
      itemCount: items.length,
      risks: items.map((i) => i.dataset.risk),
      kinds: items.map((i) => i.dataset.kind),
      buttons: items.map((i) => [...i.querySelectorAll('button')].map((b) => b.textContent)),
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('the attention block exists and is ABOVE the fold', att.inViewport === true, `top=${att.top}`);
  // 文案在 2026-11-02 的两层分类里从"需要你处理"改成"需要你决策"——
  // 因为第二层是"执行提醒"，用"处理"会和它混。
  record('it says "需要你决策" with a count', /需要你决策/.test(att.text || ''), '');
  record('high risk is listed FIRST (order carries meaning)', (att.risks || [])[0] === 'high',
    JSON.stringify(att.risks));
  record('each todo card can be acted on (not display-only)',
    (att.buttons || []).every((b) => b.length > 0), JSON.stringify(att.buttons));

  // ---- 2. 离开期间时间线 ----
  const tl = await ev(`(() => {
    const t = document.querySelector('.tl');
    if (!t) return { missing: true };
    const lis = [...t.querySelectorAll('.tl-list li')];
    return {
      text: t.innerText,
      count: lis.length,
      tones: lis.map((l) => l.dataset.tone),
      hasTime: /上次查看/.test(t.innerText),
    };
  })()`).catch(() => ({}));
  record('the "while you were away" timeline exists', tl.missing !== true, '');
  record('it lists the real events (decision/question/deliverable)', (tl.count || 0) === 3, `count=${tl.count}`);
  record('it shows when you last looked', tl.hasTime === true, '');
  record('entries carry tone (ok/warn/info) for visual scanning',
    (tl.tones || []).length > 0, JSON.stringify(tl.tones));

  // ---- 3. 点击"允许"真的送回 Harness ----
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('.att-btn')].find((x) => x.textContent === '允许');
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 900));
  record('clicking "允许" sends a REAL answer to the Harness channel', answered.length > 0,
    JSON.stringify(answered[0] || null));
  record('the answer uses the REAL payload shape {action,id,value}',
    answered[0] && answered[0].action === 'answer' && 'id' in answered[0] && 'value' in answered[0],
    JSON.stringify(answered[0] || null));

  // ---- 4. 双主题对比度 ----
  async function contrast(mode) {
    await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
    await new Promise((r) => setTimeout(r, 350));
    return ev(`(() => {
      function lum(c) {
        const m = c.match(/\\d+(\\.\\d+)?/g);
        if (!m) return null;
        const [r, g, b] = m.slice(0, 3).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      function ratio(fg, bg) {
        const a = lum(fg), b = lum(bg);
        if (a === null || b === null) return null;
        const hi = Math.max(a, b), lo = Math.min(a, b);
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      }
      const cs = getComputedStyle(document.body);
      const bg = cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).backgroundColor : cs.backgroundColor;
      const out = { bodyBg: bg, samples: {} };
      for (const sel of ['.att-item-text', '.att-item-meta', '.tl-fg', '.tl-list li', '.att-head']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        out.samples[sel] = ratio(getComputedStyle(el).color, bg);
      }
      return out;
    })()`);
  }
  const dark = await contrast('dark');
  const light = await contrast('light');
  record('DARK theme: attention text contrast >= 4.5:1',
    (dark.samples['.att-item-text'] || 0) >= 4.5, JSON.stringify(dark.samples));
  record('LIGHT theme: attention text contrast >= 4.5:1',
    (light.samples['.att-item-text'] || 0) >= 4.5, JSON.stringify(light.samples));
  record('LIGHT theme: timeline text contrast >= 4.5:1',
    (light.samples['.tl-list li'] || 0) >= 4.5, String(light.samples['.tl-list li']));

  // ---- 5. 零待办 = 明确信号，不是空白 ----
  ATT = { ok: true, available: true, observedAtMs: Date.now(), total: 0, counts: { approval: 0, question: 0 }, items: [] };
  SINCE = { ok: true, available: false, reason: 'never-seen', entries: [], sinceMs: null };
  // 零待办时 live 也必须归零，否则页面会（正确地）显示"数据不一致"而不是"运行正常"。
  // 这是上一版 fixture 自相矛盾的地方——页面没撒谎，是 fixture 编错了。
  DELETE_LIVE_PENDING();
  await ev(`document.documentElement.setAttribute('data-theme', 'dark')`);
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 900));
  const clear = await ev(`(() => {
    const a = document.querySelector('.att');
    return { text: a ? a.innerText : '', cls: a ? a.className : '', tlExists: !!document.querySelector('.tl') };
  })()`).catch(() => ({}));
  record('zero todos shows an EXPLICIT "all clear" message (not blank)',
    /团队运行正常/.test(clear.text || ''), clear.text || '');
  record('zero todos is visually distinct from has-todos', /att-clear/.test(clear.cls || ''), clear.cls || '');
  record('never-seen means NO timeline (not an empty box)', clear.tlExists === false, '');

  // ---- 6. 截图：两主题 × 两状态 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await new Promise((r) => setTimeout(r, 300));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `dock-${mode}-clear.png`), img.toPNG());
    }
    // 回到有 todo 的状态再截一次
    ATT = { ok: true, available: true, observedAtMs: Date.now(), total: 2, counts: { approval: 1, question: 1 }, items: [
      { id: 'p1', kind: 'approval', risk: 'high', summary: '执行 rm -rf build', toolName: 'Bash', createdAtMs: Date.now() - 120e3 },
      { id: 'p2', kind: 'question', risk: 'low', summary: '要继续吗？', createdAtMs: Date.now() - 60e3 },
    ] };
    SINCE = { ok: true, available: true, sinceMs: Date.now() - 3 * 3600e3, truncated: false, dropped: 0, entries: [
      { atMs: Date.now() - 3600e3, kind: 'decision', text: '暂不引入第二套 Harness', tone: 'ok' },
      { atMs: Date.now() - 1800e3, kind: 'question', text: '第二页做什么？', tone: 'warn' },
      { atMs: Date.now() - 600e3, kind: 'deliverable', text: '研究报告', tone: 'ok' },
    ] };
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 700));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `dock-${mode}-todo.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark/light × clear/todo');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('markSeen was called (so next open can compute "since")', seenCalls.length > 0, String(seenCalls.length));
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
