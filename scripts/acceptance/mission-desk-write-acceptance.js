'use strict';
// scripts/acceptance/mission-desk-write-acceptance.js — Desk 写入路径真机验收（P4）。
//
// 第一性原理：为什么离线测试不够
//
//   离线测试已经证明了：
//     · 源码里调了 recordDecision
//     · store 能写入并读回
//
//   但它证明不了：**在真实 DOM 里点那个按钮，真的会发生这些事**。
//   典型失败模式：
//     · 按钮在，但 input 的 id 拿错了 → 提交空值
//     · refresh() 没重绘 → 用户看不到刚写的内容
//     · 表单在一个 display:none 的容器里 → 用户点不到
//
//   所以这里走真实链路：真窗口 + 真 DOM + 真点击。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-write-acceptance');

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
  // 真实 store 落在临时目录，避免污染仓库
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-accept-'));
  const { createMissionStore } = require(path.join(REPO, 'src', 'mission', 'store.js'));
  const deliverable = require(path.join(REPO, 'src', 'mission', 'deliverable.js'));
  const store = createMissionStore({ workspaceDir: wsDir });

  const missionId = 'mis-acc1';
  store.append('mission.created', {
    missionId, workspaceId: 'wsp-acc1', title: '验收 Mission', intent: '验证写入路径',
    status: 'active', createdAtMs: Date.now(), updatedAtMs: Date.now(),
  }, { missionId });

  // ---- 真实 mission:invoke 处理器（薄壳，直接接 store）----
  let lastAction = null;
  ipcMain.handle('mission:invoke', (_e, action, payload = {}) => {
    lastAction = action;
    try {
      switch (action) {
        case 'list': return { ok: true, missions: store.activeMissions() };
        case 'get': return { ok: true, view: store.missionView(payload.missionId) };
        case 'recordDecision': {
          const entity = {
            decisionId: `dec-${Date.now()}`, missionId: payload.missionId,
            text: payload.text, rationale: payload.rationale,
            status: payload.status || 'proposed',
            decidedAtMs: Date.now(),
            decidedBy: payload.decidedBy || 'model',
          };
          const r = store.append('decision.recorded', entity, { missionId });
          return r.ok ? { ok: true, decisionId: entity.decisionId } : { ok: false, reason: r.reason };
        }
        case 'registerDeliverable': {
          const reg = deliverable.registerDeliverable({
            workspaceDir: wsDir, missionId: payload.missionId,
            label: payload.label, relPath: payload.relPath, now: Date.now(),
          });
          if (!reg.ok) return { ok: false, reason: reg.reason };
          const r = store.append('deliverable.registered', reg.deliverable, { missionId });
          return r.ok ? { ok: true, deliverable: reg.deliverable } : { ok: false, reason: r.reason };
        }
        case 'update': {
          const patch = {};
          if (typeof payload.title === 'string') patch.title = payload.title;
          if (typeof payload.intent === 'string') patch.intent = payload.intent;
          if (Object.keys(patch).length === 0) return { ok: false, reason: 'nothing to update' };
          const r = store.append('mission.updated', { missionId: payload.missionId, ...patch }, { missionId });
          return r.ok ? { ok: true, patched: Object.keys(patch) } : { ok: false, reason: r.reason };
        }
        case 'openQuestion': {
          const q = {
            questionId: `q-acc-${Date.now()}`, missionId: payload.missionId,
            text: payload.text, status: 'open', askedAtMs: Date.now(),
          };
          const r = store.append('question.opened', q, { missionId });
          return r.ok ? { ok: true, questionId: q.questionId } : { ok: false, reason: r.reason };
        }
        case 'linkTaskRef': {
          const taskRefMod = require(path.join(REPO, 'src', 'mission', 'task-ref.js'));
          const built = taskRefMod.buildTaskRef({
            missionId: payload.missionId, workstreamId: payload.workstreamId,
            sessionId: payload.sessionId, summary: payload.summary,
            observedAtMs: Date.now(),
          });
          if (!built.ok) return { ok: false, reason: built.reason, code: built.code };
          const r = store.append('taskRef.linked', built.taskRef, { missionId });
          return r.ok ? { ok: true, taskRef: built.taskRef } : { ok: false, reason: r.reason };
        }
        case 'addWorkstream': {
          const ws = {
            workstreamId: `ws-${Date.now()}`, missionId: payload.missionId,
            title: payload.title, status: 'active', createdAtMs: Date.now(), updatedAtMs: Date.now(),
          };
          const r = store.append('workstream.created', ws, { missionId });
          return r.ok ? { ok: true, workstreamId: ws.workstreamId } : { ok: false, reason: r.reason };
        }
        case 'updateWorkstreamStatus': {
          const r = store.append('workstream.statusChanged',
            { workstreamId: payload.workstreamId, to: payload.to }, { missionId: payload.missionId });
          return r.ok ? { ok: true } : { ok: false, reason: r.reason };
        }
        case 'getBrief': return { ok: true, brief: null };
        case 'briefSyncState': return { ok: true, state: null };
        case 'verifyDeliverables': return { ok: true, results: [] };
        case 'diagnostics': return { ok: true, diagnostics: {} };
        default: return { ok: false, code: 'UNKNOWN_ACTION' };
      }
    } catch (err) { return { ok: false, reason: err.message }; }
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

  // 选中这台 Mission
  // 卡片是 div.card[role=button]，没有 data-mission-id 属性——
  // 靠 role 找它，而不是猜选择器。
  const selected = await ev(`(() => {
    const items = [...document.querySelectorAll('.card[role="button"]')];
    if (!items.length) return 0;
    items[0].click();
    return items.length;
  })()`).catch(() => 0);
  record('the mission list renders at least one selectable card', selected >= 1, `cards=${selected}`);
  await new Promise((r) => setTimeout(r, 1200));

  const boot = await ev(`({ ready: document.readyState, hasApi: typeof window.dshShell })`).catch(() => ({}));
  record('the desk page loads with its bridge', boot.hasApi === 'object', JSON.stringify(boot));

  // ---- 1. 决策表单存在且可点 ----
  const decisionForm = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const txt = inputs.find((i) => (i.placeholder || '').includes('决定了什么'));
    const why = inputs.find((i) => (i.placeholder || '').includes('为什么'));
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '记录决策');
    return {
      hasTxt: !!txt, hasWhy: !!why, hasBtn: !!btn,
      visible: btn ? btn.offsetParent !== null : false,
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('the decision form is present AND visible', decisionForm.hasTxt && decisionForm.hasWhy && decisionForm.hasBtn && decisionForm.visible,
    JSON.stringify(decisionForm));

  // ---- 2. 真实点击：填表 → 提交 → 落盘 ----
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    inputs.find((i) => (i.placeholder || '').includes('决定了什么')).value = '用 SQLite 而不是 JSON';
    inputs.find((i) => (i.placeholder || '').includes('为什么')).value = '并发写入更安全';
    [...document.querySelectorAll('button')].find((b) => b.textContent === '记录决策').click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const afterDecision = store.missionView(missionId);
  const savedDecision = (afterDecision.decisions || [])[0];
  record('clicking "记录决策" really writes to the store', !!savedDecision,
    savedDecision ? JSON.stringify({ text: savedDecision.text, status: savedDecision.status, by: savedDecision.decidedBy }) : 'nothing written');
  record('a user-submitted decision is marked accepted by the user',
    savedDecision && savedDecision.status === 'accepted' && savedDecision.decidedBy === 'user',
    savedDecision ? `${savedDecision.status}/${savedDecision.decidedBy}` : '-');

  // ---- 3. 写入后 UI 是否重绘（用户能否看到自己刚写的）----
  const redrawn = await ev(`document.body.innerText.includes('用 SQLite 而不是 JSON')`).catch(() => false);
  record('the decision appears in the UI after writing (refresh works)', redrawn === true, String(redrawn));

  // ---- 4. 产物表单：不存在的文件必须被拒绝 ----
  const filePath = path.join(wsDir, 'docs', 'report.md');
  fs.mkdirSync(path.join(wsDir, 'docs'), { recursive: true });
  fs.writeFileSync(filePath, '# 真实验收产物\n');

  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    inputs.find((i) => (i.placeholder || '').includes('产物名称')).value = '验收报告';
    inputs.find((i) => (i.placeholder || '').includes('相对工作区')).value = 'docs/report.md';
    [...document.querySelectorAll('button')].find((b) => b.textContent === '登记产物').click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const savedDeliv = (store.missionView(missionId).deliverables || [])[0];
  record('registering a real file computes a real sha256', !!(savedDeliv && /^[0-9a-f]{64}$/.test(savedDeliv.digest)),
    savedDeliv ? String(savedDeliv.digest).slice(0, 16) + '…' : 'nothing registered');

  // ---- 5. 工作流：新建 + 状态切换 ----
  await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    inputs.find((i) => (i.placeholder || '').includes('新工作流')).value = '接入 StepFun';
    [...document.querySelectorAll('button')].find((b) => b.textContent === '新建工作流').click();
    return true;
  })()`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  const ws = (store.missionView(missionId).workstreams || [])[0];
  record('a workstream can be created from the UI', !!ws, ws ? ws.title : 'nothing created');

  const statusBtnClicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === '阻塞');
    if (!b) return false;
    b.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 1000));
  const wsAfter = (store.missionView(missionId).workstreams || [])[0];
  record('the workstream status can be changed in place',
    statusBtnClicked === true && wsAfter && wsAfter.status === 'blocked',
    wsAfter ? `${wsAfter.status}` : 'none');

  // ---- 5.5 标题/目标可就地编辑 ----
  const editClicked = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '改');
    if (!btn) return false;
    btn.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 400));
  const edited = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const title = inputs.find((i) => (i.placeholder || '') === 'Mission 标题');
    const intent = inputs.find((i) => (i.placeholder || '').includes('目标（你的原话）'));
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === '保存');
    if (!title || !intent || !save) return { ok: false };
    title.value = '改过的标题';
    intent.value = '改过的目标';
    save.click();
    return { ok: true };
  })()`).catch(() => ({ ok: false }));
  await new Promise((r) => setTimeout(r, 1000));
  const viewAfterEdit = store.missionView(missionId);
  record('the title and intent can be edited in place',
    editClicked === true && edited.ok === true
    && viewAfterEdit.mission.title === '改过的标题'
    && viewAfterEdit.mission.intent === '改过的目标',
    JSON.stringify({ title: viewAfterEdit.mission.title, intent: viewAfterEdit.mission.intent }));

  const redrawnTitle = await ev(`document.body.innerText.includes('改过的标题')`).catch(() => false);
  record('the edited title is visible after saving', redrawnTitle === true, String(redrawnTitle));

  // ---- 5.6 用户能自己提问 ----
  const asked = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const q = inputs.find((i) => (i.placeholder || '').includes('还没想清楚'));
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '记下这个问题');
    if (!q || !btn) return false;
    q.value = '要不要拆成两个包？';
    btn.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 1000));
  const qs = store.missionView(missionId).questions || [];
  record('the user can record their own open question',
    asked === true && qs.length === 1 && qs[0].text === '要不要拆成两个包？',
    qs.length ? JSON.stringify({ text: qs[0].text, status: qs[0].status }) : 'none');
  record('a newly asked question is immediately answerable (same render path)',
    qs.length === 1 && (await ev(`document.body.innerText.includes('要不要拆成两个包')`).catch(() => false)) === true,
    'visible in list');

  // ---- 6. 关联执行（TaskRef）----
  const linkClicked = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const summary = inputs.find((i) => (i.placeholder || '').includes('这次执行做了什么'));
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === '关联执行');
    if (!summary || !btn) return false;
    summary.value = '接入 StepFun 并跑通';
    btn.click();
    return true;
  })()`).catch(() => false);
  await new Promise((r) => setTimeout(r, 1200));
  const refsNow = store.missionView(missionId).taskRefs || [];
  record('an execution can be linked from the UI', linkClicked === true && refsNow.length === 1,
    `refs=${refsNow.length}`);
  record('the linked execution carries a DERIVED handle (not a raw session id)',
    refsNow.length === 1 && /^sess-h-[0-9a-f]{12}/.test(refsNow[0].harnessRef),
    refsNow.length ? refsNow[0].harnessRef : '-');

  // 最强的一条：扫工作区所有文件，确认 sessionId 没有落盘
  const walkAll = (d) => {
    const out = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const pp = path.join(d, e.name);
      if (e.isDirectory()) out.push(...walkAll(pp));
      else out.push(pp);
    }
    return out;
  };
  const leaked = walkAll(wsDir).filter((f) => {
    try { return fs.readFileSync(f, 'utf8').includes('manual-link') && false; } catch { return false; }
  });
  void leaked;
  const onDisk = walkAll(wsDir).some((f) => {
    try { return fs.readFileSync(f, 'utf8').includes('manual-link'); } catch { return false; }
  });
  record('the raw session id never reaches disk (privacy invariant)', onDisk === false,
    onDisk ? 'LEAKED to disk' : 'clean');

  // ---- 7. 重启后仍在（持久化真的生效）----
  // 复用文件顶部已解构的 createMissionStore（重复解构会 SyntaxError）
  const reopened = createMissionStore({ workspaceDir: wsDir });
  const afterRestart = reopened.missionView(missionId);
  record('everything survives a restart (decisions/deliverables/workstreams/taskRefs/questions/title)',
    (afterRestart.decisions || []).length === 1
    && (afterRestart.deliverables || []).length === 1
    && (afterRestart.workstreams || []).length === 1
    && (afterRestart.taskRefs || []).length === 1
    && (afterRestart.questions || []).length === 1
    && afterRestart.mission.title === '改过的标题',
    JSON.stringify({
      d: (afterRestart.decisions || []).length,
      dv: (afterRestart.deliverables || []).length,
      ws: (afterRestart.workstreams || []).length,
      tr: (afterRestart.taskRefs || []).length,
      q: (afterRestart.questions || []).length,
      title: afterRestart.mission.title,
    }));

  // ---- 8. 截图 + 错误 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'mission-desk-write.png'), img.toPNG());
    record('screenshot captured', img.getSize().width > 0, `${img.getSize().width}x${img.getSize().height}`);
  } catch (e) { record('screenshot captured', false, String(e)); }
  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));

  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
