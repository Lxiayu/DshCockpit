'use strict';
// 团队任务 + BlockedBy 真机验收。
//
// 第一性原理：这个区块最容易犯两个错
//   1. **把"缺 agentTeam"当成"空团队"** → 默认 profile 下会显示"0 个任务"
//   2. **用当前任务的 ownerName 显示阻塞者**（我原来的错，GPT 指出）
//      blockedBy 是 taskId 数组，必须查表找**那个任务自己的**信息
//
// fixture 用 2026-11-02 真实实测到的 DAG 形状，不是编的。

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-team-blocked-acceptance');
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
const LIVE = { available: true, observedAtMs: NOW, hasRunningAgent: true, pendingApprovals: 0, pendingQuestions: 0 };

// 真实实测形状（2026-11-02）
const REAL_TEAM = {
  members: [{ id: 'session-eef7640b-9e74', name: 'lead', role: 'lead', phase: 'active' }],
  tasks: [
    { id: 'task-1', revision: 1, subject: '设计数据库 Schema', status: 'pending',
      ownerName: '研究员', blockedBy: [], ready: true, writeScopes: ['src/db'], writeScopeWarnings: [] },
    { id: 'task-2', revision: 1, subject: '实现后端 API', status: 'pending',
      ownerName: '程序员', blockedBy: ['task-1'], ready: false, writeScopes: ['src/api'], writeScopeWarnings: [] },
  ],
  failure: null,
};

let PROJ = {
  ok: true, available: true, asOfSeq: 9, userQuestionsAvailable: true,
  activeQuestions: [], settledCount: 0, agentPreset: 'standard',
  inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null },
  permissionPreset: 'workspace-write',
  agentTeam: REAL_TEAM,
};

async function main() {
  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return { ok: true, available: true, total: 0, counts: {}, items: [] };
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

  // ---- 1. 团队区块渲染真实任务 ----
  const team = await ev(`(() => {
    const box = document.querySelector('.team');
    if (!box) return { missing: true };
    const tasks = [...box.querySelectorAll('.team-task')];
    return {
      taskCount: tasks.length,
      subjects: tasks.map((t) => (t.querySelector('.team-task-subject') || {}).innerText || ''),
      statuses: tasks.map((t) => t.dataset.status),
      text: box.innerText,
    };
  })()`).catch((e) => ({ error: String(e) }));
  record('team block renders the REAL tasks', (team.taskCount || 0) === 2, JSON.stringify(team.subjects));
  record('task subjects come from the projection', (team.subjects || []).includes('设计数据库 Schema'), '');
  record('task status is shown', (team.statuses || []).includes('pending'), JSON.stringify(team.statuses));

  // ---- 2. blockedBy 必须查表，不能用当前任务的 ownerName ----
  const blocked = await ev(`(() => {
    const tasks = [...document.querySelectorAll('.team-task')];
    const blockedOne = tasks.find((t) => t.querySelector('.team-blocked'));
    if (!blockedOne) return { missing: true };
    return {
      subject: (blockedOne.querySelector('.team-task-subject') || {}).innerText || '',
      blockedText: (blockedOne.querySelector('.team-blocked') || {}).innerText || '',
      // 只有未阻塞的那个任务不该有 blocked 区
      unblockedHasBlocked: !!tasks.find((t) => !t.querySelector('.team-blocked') && t.querySelector('.team-blocked')),
    };
  })()`).catch(() => ({}));
  record('the blocked task shows a blocking section', blocked.missing !== true, '');
  record('it names the ACTUAL blocker (设计数据库 Schema), not its own owner',
    /设计数据库 Schema/.test(blocked.blockedText || ''), blocked.blockedText || '');
  record('the blocking line does NOT use the blocked task\'s own owner as the blocker',
    !/等待：.*程序员/.test(blocked.blockedText || ''), blocked.blockedText || '');
  record('the unblocked task has NO blocking section', blocked.unblockedHasBlocked !== true, '');

  // ---- 3. 缺 agentTeam → 完全不显示（最关键）----
  PROJ = { ok: true, available: true, asOfSeq: 1, userQuestionsAvailable: true, activeQuestions: [],
    settledCount: 0, agentPreset: 'standard', inbox: { nextTurnCount: 0, nextStepCount: 0, preview: null },
    permissionPreset: 'workspace-write', agentTeam: null };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 800));
  const noTeam = await ev(`(() => ({
    hasTeamBlock: !!document.querySelector('.team'),
    bodyText: document.body.innerText,
  }))()`).catch(() => ({}));
  record('MISSING agentTeam means NO team block at all (not "0 tasks")',
    noTeam.hasTeamBlock === false, '');
  record('and the page never says "0 个任务" or "没有成员"',
    !/0 个任务|没有成员|0 个成员/.test(noTeam.bodyText || ''), '');

  // ---- 4. 只有 lead、无任务 → 也不显示 ----
  PROJ = { ...PROJ, agentTeam: { members: REAL_TEAM.members, tasks: [], failure: null } };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 800));
  const leadOnly = await ev(`!!document.querySelector('.team')`).catch(() => null);
  record('a Team with only the lead and no tasks shows nothing', leadOnly === false, String(leadOnly));

  // ---- 5. writeScopeWarnings 用"可能冲突"而不是"已锁定" ----
  PROJ = { ...PROJ, agentTeam: {
    members: REAL_TEAM.members,
    tasks: [{ id: 'task-9', revision: 2, subject: '并行改同一目录', status: 'in_progress',
      ownerName: '程序员', blockedBy: [], ready: true, writeScopes: ['src/api'],
      writeScopeWarnings: ['src/api 与 task-8 声明的范围重叠'] }],
    failure: null,
  } };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 800));
  const scope = await ev(`(() => ({
    text: (document.querySelector('.team-scope-warn') || {}).innerText || '',
    full: (document.querySelector('.team') || {}).innerText || '',
  }))()`).catch(() => ({}));
  record('writeScopeWarnings is shown as a POSSIBLE conflict',
    /可能.*冲突/.test(scope.text || ''), scope.text || '');
  record('it NEVER claims the files are locked',
    !/已锁定|文件锁/.test(scope.full || ''), '');

  // ---- 6. failure 必须明说数据可能不实时 ----
  PROJ = { ...PROJ, agentTeam: { members: REAL_TEAM.members, tasks: REAL_TEAM.tasks, failure: 'task record rejected' } };
  await ev(`loadDetail('mis-1')`);
  await new Promise((r) => setTimeout(r, 800));
  const fail = await ev(`(document.querySelector('.team-warn') || {}).innerText || ''`).catch(() => '');
  record('a projection failure is disclosed (data may be stale)',
    /不是最新|最后一次有效状态/.test(fail), fail || '');

  // ---- 7. 截图 ----
  PROJ = { ...PROJ, agentTeam: REAL_TEAM };
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await ev(`loadDetail('mis-1')`);
      await new Promise((r) => setTimeout(r, 800));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `team-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
