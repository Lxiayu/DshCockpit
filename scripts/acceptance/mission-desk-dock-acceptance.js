'use strict';
// scripts/acceptance/mission-desk-dock-acceptance.js — 右栏 Mission Desk 真机验收。
//
// 第一性原理：右栏改造要证明的三件事
//
//   1. **它真的渲染成了 Mission Desk**（不是还显示"工作区 + 任务输入"）
//   2. **380px 下单列布局成立**（不是双栏被压扁）
//   3. **每个区块看到的数据都来自真实 IPC**（不是静态占位）
//
//   离线测 HTML 源码只能证明"写了"，证明不了"渲染出来是这样"。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-dock-acceptance');
const DOCK_WIDTH = 380;

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
  // 真实形状的 mission 数据（含所有本轮要展示的字段）
  const VIEW = {
    mission: { missionId: 'mis-1', title: 'DshCockpit Runtime 集成', intent: '完成 Agent Team 接入', status: 'active' },
    workstreams: [
      { workstreamId: 'ws-1', title: '技术调研', status: 'completed' },
      { workstreamId: 'ws-2', title: 'Runtime Bridge', status: 'in_progress' },
    ],
    decisions: [
      { decisionId: 'd-1', text: '暂不引入第二套 Harness', rationale: '官方已足够', status: 'accepted', decidedBy: 'user' },
      { decisionId: 'd-2', text: '右栏复用 mission-desk.html', rationale: '避免两份 UI 漂移', status: 'proposed', decidedBy: 'model' },
    ],
    questions: [{ questionId: 'q-1', text: '第二页做什么？', status: 'open' }],
    deliverables: [
      { deliverableId: 'del-1', path: 'docs/report.md', kind: 'markdown', digest: 'sha256:abc' },
    ],
    taskRefs: [{ ref: 'sess-h-abc123456789', kind: 'session-turn' }],
  };
  const LIVE = {
    available: true, observedAtMs: Date.now(), hasRunningAgent: true,
    pendingApprovals: 1, pendingQuestions: 1, awaitingUser: true, teamMemberCount: 3,
  };

  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'getBrief': return { ok: true, brief: { text: 'brief body' } };
      case 'briefSyncState': return { ok: true, synced: false };
      case 'listTaskRefs': return { ok: true, refs: VIEW.taskRefs };
      default: return { ok: false, code: 'UNKNOWN_ACTION' };
    }
  });
  for (const ch of ['shell:get-i18n', 'shell:get-settings', 'shell:get-theme',
    'shell:get-language', 'shell:log', 'shell:office-settings-get']) {
    ipcMain.handle(ch, () => (ch === 'shell:get-i18n'
      ? require(path.join(REPO, 'src', 'i18n.js')).STRINGS : { ok: true }));
  }

  const win = new BrowserWindow({
    width: DOCK_WIDTH, height: 820, show: false,
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

  // ---- 1. dock 模式真的生效 ----
  const mode = await ev(`(() => ({
    dockClass: document.body.classList.contains('dock'),
    picker: (() => { const p = document.getElementById('dockPicker'); return p ? getComputedStyle(p).display : 'missing'; })(),
    listDisplay: (() => { const l = document.getElementById('list'); return l ? getComputedStyle(l).display : 'missing'; })(),
  }))()`).catch((e) => ({ error: String(e) }));
  record('dock mode is active (body.dock)', mode.dockClass === true, JSON.stringify(mode));
  record('the Mission picker is visible in dock mode', mode.picker !== 'missing' && mode.picker !== 'none', String(mode.picker));

  // ---- 2. 单列布局成立（不是双栏被压扁）----
  const layout = await ev(`(() => {
    const list = document.getElementById('list').getBoundingClientRect();
    const detail = document.getElementById('detail').getBoundingClientRect();
    return {
      listW: Math.round(list.width), listH: Math.round(list.height),
      detailW: Math.round(detail.width), detailTop: Math.round(detail.top),
      listBottom: Math.round(list.bottom),
      docW: Math.round(document.documentElement.clientWidth),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  })()`).catch(() => ({}));
  record('the picker spans the full width (single column, not a squeezed双栏)',
    Math.abs(layout.listW - layout.docW) < 40, `list=${layout.listW} doc=${layout.docW}`);
  record('the detail pane sits BELOW the picker (vertical stack)', layout.detailTop >= layout.listBottom - 2,
    `detailTop=${layout.detailTop} listBottom=${layout.listBottom}`);
  record('there is no horizontal overflow at 380px', layout.overflowX === false, String(layout.overflowX));

  // ---- 3. 内容真的是 Mission Desk，不是旧的任务面板 ----
  const content = await ev(`(() => {
    const d = document.getElementById('detail');
    return { text: d ? d.innerText : '', html: d ? d.innerHTML.length : 0 };
  })()`).catch(() => ({}));
  const text = content.text || '';
  const titleWhere = await ev(`(() => ({
    picker: (document.getElementById('dockSelect') || {}).selectedOptions
      ? (document.getElementById('dockSelect').selectedOptions[0] || {}).text || '' : '',
  }))()`).catch(() => ({}));
  record('it shows the Mission title (in the dock picker)', /DshCockpit Runtime 集成/.test(titleWhere.picker || ''),
    titleWhere.picker || '');
  record('it shows the Mission intent', /完成 Agent Team 接入/.test(text), '');
  record('it shows workstreams', /技术调研|Runtime Bridge/.test(text), '');
  record('it shows decisions', /暂不引入第二套 Harness/.test(text), '');
  record('it no longer shows the old task panel ("先选一个工作区")',
    !/先选一个工作区/.test(text), '');
  record('it no longer shows the old task form', !/一句话说明你想完成的工作/.test(text), '');

  // ---- 4. 自动选中第一个 Mission（右栏打开即有内容）----
  const picked = await ev(`(() => {
    const s = document.getElementById('dockSelect');
    return { value: s ? s.value : null, count: s ? s.options.length : 0 };
  })()`).catch(() => ({}));
  record('a Mission is auto-selected so the dock opens with content',
    picked.value === 'mis-1' && picked.count === 1, JSON.stringify(picked));

  // ---- 5. 截图 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'dock-380.png'), img.toPNG());
    record('screenshot captured at 380px', img.getSize().width > 0, `${img.getSize().width}x${img.getSize().height}`);
  } catch (e) { record('screenshot captured at 380px', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
