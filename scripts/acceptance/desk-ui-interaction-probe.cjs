// scripts/acceptance/desk-ui-interaction-probe.cjs — 右栏交互探针。
//
// 第一性原理：截图只能证明"看起来对"，证明不了"点得动"
//
//   右栏有 50+ 个事件监听器，此前**一个都没被自动化验证过**。
//   渲染截图能证明布局、配色、文案正确，但**渲染时不执行任何回调** ——
//   所以"按钮存在但点了抛错"这类缺陷，截图完全看不出来。
//
//   这个探针已经抓到两个真实问题：
//     1. renderTeamTasks 没接 m 参数，任务行按钮回调引用 m → 点击抛
//        ReferenceError（按钮看着有，点了就崩）
//     2. 状态菜单的 document 监听器每次渲染都新增一个且永不清理
//
// 它验证 11 件事：加载无错、初始数据、折叠区展开、派发面板五字段、
// 验收条件加行、状态菜单开关、状态项触发 IPC、任务改写表单、
// 表单提交触发 IPC、成员转达表单、全程无 JS 错误。
//
// 用法：node scripts/acceptance/desk-ui-interaction-probe.cjs
// 2026-11-04 实测：11/11 通过。
// ---------------------------------------------------------------------------
// 右栏交互探针：模拟真实点击，验证 56 个监听器里高频的那些能工作。
// 此前只截图证明"看起来对"，从未证明"点得动"。
const { spawn } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const CHROME = '/Users/xia/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const REPO = '/Users/xia/program/dsh/DshCockpit';
const HTML = `${REPO}/src/mission-desk.html?dock=1`;
const now = Date.now();

// 记录所有 IPC 调用，用于验证"点击真的触发了 IPC"
const mission = {
  missionId: 'mis-1', title: '交互测试', intent: '验证点击', status: 'active',
  constraints: [], decisions: [], findings: [], assumptions: [], evidence: [],
  openQuestions: [], workstreams: [], taskRefs: [], deliverables: [],
  briefVersion: 1, createdAtMs: now - 3600e3, updatedAtMs: now,
};
const view = { mission, decisions: [], findings: [], assumptions: [], evidence: [], openQuestions: [], workstreams: [], taskRefs: [], deliverables: [], briefs: [], diagnostics: [] };
const mocks = {
  list: { ok: true, missions: [{ ...mission, live: { available: true } }], activeCount: 1 },
  get: { ok: true, view, live: { available: true, hasRunningAgent: false, pendingApprovals: 0, pendingQuestions: 0, observedAtMs: now } },
  attention: { ok: true, available: true, total: 0, items: [], rail: { header: { decisionCount: 0, reminderCount: 0, tone: 'calm' }, visible: { decisions: [], reminders: [] }, overflow: { decisions: 0 }, empty: { text: '团队运行正常，没有需要你处理的事。' } } },
  sinceLastSeen: { ok: true, available: true, entries: [] },
  sessionProjections: { ok: true, available: true, agentTeam: { members: [{ id: 'm0', name: 'lead', role: 'lead', phase: 'active' }, { id: 'm1', name: 'coder', role: 'teammate', phase: 'active' }], tasks: [{ id: 't1', revision: 2, subject: '测试任务', status: 'in_progress', ready: true, blockedBy: [], ownerName: 'coder' }] } },
  getBoundSession: { ok: true, bound: true },
  workStatus: { ok: true, available: true, bound: true, turns: 1, steps: 3, hasResponse: true, receipt: { state: 'claimed', description: 'x', reason: 'y' }, teamReconcile: { available: true, acceptance: { total: 0, covered: 0, missing: [] }, orphanTasks: [], taskCount: 1, memberCount: 2 } },
  listGrants: { ok: true, grants: [{ grantId: 'gr-a1', workspaceDir: '/w', access: 'write', grantedBy: 'user', createdAtMs: 1, active: true, revokedAtMs: null }], degraded: null },
  interventionHistory: { ok: true, entries: [], stats: {} },
};

const userDataDir = mkdtempSync(path.join(tmpdir(), 'chrome-ui-'));
const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
  '--headless', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--window-size=380,1400', 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); const l = await r.json(); if (l && l.length) return l; } catch {}
    await sleep(200);
  }
  throw new Error('chrome did not start');
}
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
    ws.addEventListener('open', () => resolve({
      send(m, p = {}) { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p })); }); },
      close() { ws.close(); },
    }));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
    });
    ws.addEventListener('error', reject);
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const tg = await targets();
  const c = await cdp((tg.find((x) => x.type === 'page') || tg[0]).webSocketDebuggerUrl);
  await c.send('Page.enable'); await c.send('Runtime.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 1400, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__ipcCalls = []; window.__errs = [];
      window.addEventListener('unhandledrejection', (e) => window.__errs.push('REJ:' + String(e.reason && (e.reason.message || e.reason))));
      window.onerror = (m, s, l) => window.__errs.push('ERR:' + m + '@' + l);
      window.dshShell = { mission: async (action, payload) => {
        window.__ipcCalls.push({ action, payload });
        const m = ${JSON.stringify(mocks)};
        return m[action] ?? { ok: true };
      } };`,
  });
  await c.send('Page.navigate', { url: `file://${HTML}` });
  await sleep(1500);

  const evalIn = async (expr) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  // 1) 页面无 JS 错误
  const errs = await evalIn('JSON.stringify(window.__errs || [])');
  check('1. no JS errors on load', errs === '[]', errs);

  // 2) 初始 IPC 调用完整
  const initialCalls = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  check('2. initial data loaded', initialCalls.includes('"list"') && initialCalls.includes('"get"'), initialCalls);

  // 3) 折叠区可展开
  const collapsed = await evalIn(`(() => { const b = document.querySelectorAll('.coll-head'); if (!b.length) return 'no collapsible'; b[0].click(); return document.querySelectorAll('.coll-body').length; })()`);
  check('3. collapsible expands on click', collapsed !== 'no collapsible' && Number(collapsed) > 0, String(collapsed));

  // 4) 派发入口可展开，且渲染出任务书
  const opened = await evalIn(`(() => { const b = document.querySelector('.start-work-open'); if (!b) return 'no trigger'; b.click(); return document.querySelectorAll('.dp-field').length; })()`);
  check('4. dispatch panel opens with 5 fields', Number(opened) === 5, `fields=${opened}`);

  // 5) 验收条件可加行
  const accRows = await evalIn(`(() => { const b = document.querySelector('.dp-add'); if (!b) return -1; const before = document.querySelectorAll('.dp-acc-row').length; b.click(); return document.querySelectorAll('.dp-acc-row').length - before; })()`);
  check('5. "add acceptance" appends a row', Number(accRows) === 1, `added=${accRows}`);

  // 6) 状态徽标可展开菜单（一次点击；两次会 toggle 回去，那是正确行为）
  await evalIn(`(() => { const b = document.querySelector('.mhead-badge'); b.click(); return true; })()`);
  await sleep(250);
  const statusMenu = await evalIn(`(() => { const m = document.querySelector('.mhead-status-menu'); return m ? m.style.display : 'no menu'; })()`);
  check('6. status badge opens menu', statusMenu === 'block', String(statusMenu));

  // 7) 点击状态项真的发 IPC
  const beforeCalls = await evalIn('(window.__ipcCalls||[]).length');
  await evalIn(`(() => { const o = document.querySelector('.mhead-status-opt'); if (o) o.click(); return true; })()`);
  await sleep(800);
  const sawUpdate = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  check('7. clicking a status option calls updateStatus', sawUpdate.includes('"updateStatus"'), sawUpdate);

  // 8) 任务行「改写」打开内联表单
  const rwForm = await evalIn(`(() => { const b = document.querySelector('.task-op'); if (!b) return 'no task op'; b.click(); return document.querySelectorAll('.task-rw-form').length; })()`);
  check('8. task "rewrite" opens inline form', Number(rwForm) >= 1, `forms=${rwForm}`);

  // 9) 表单提交真的发 rewriteTask
  const before2 = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  await evalIn(`(() => { const i = document.querySelector('.task-rw-input'); if (i) i.value = '新标题'; const a = document.querySelectorAll('.task-rw-actions .task-op'); if (a[0]) a[0].click(); return true; })()`);
  await sleep(600);
  const after2 = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  check('9. submitting the form calls rewriteTask', after2.includes('"rewriteTask"'), after2);

  // 10) 成员「转达消息」打开表单
  const msgForm = await evalIn(`(() => { const bs = [...document.querySelectorAll('.member-op')]; const b = bs.find(x=>x.textContent.includes('转达')); if (!b) return 'no msg btn'; b.click(); return document.querySelectorAll('.member-msg-form').length; })()`);
  check('10. member "relay message" opens form', Number(msgForm) >= 1, `forms=${msgForm}`);

  // 11) 全程无 JS 错误
  const errs2 = await evalIn('JSON.stringify(window.__errs || [])');
  check('11. still no JS errors after interactions', errs2 === '[]', errs2);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')); }
  c.close();
  chrome.kill('SIGKILL');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); try { chrome.kill('SIGKILL'); } catch {} process.exit(1); });
