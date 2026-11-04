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
  attention: { ok: true, available: true, total: 2, items: [
    { kind: 'approval', id: 'ap1', summary: '执行 shell：npm test', toolName: 'shell', risk: 'high', createdAtMs: now - 60000 },
    { kind: 'question', id: 'q1', summary: '用哪个方案？', risk: 'medium', createdAtMs: now - 30000 },
  ], rail: { header: { decisionCount: 2, reminderCount: 0, tone: 'blocked' }, visible: { decisions: [], reminders: [] }, overflow: { decisions: 0 }, empty: null } },
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
      window.dshShell = {
        mission: async (action, payload) => {
          window.__ipcCalls.push({ action, payload });
          const m = ${JSON.stringify(mocks)};
          return m[action] ?? { ok: true };
        },
        // 审批/回答走**独立通道**（office:pending），不是 mission IPC。
        // 早期探针只 mock 了 mission，于是审批按钮一点就抛
        // "answerPending is not a function" —— 那是探针缺件，不是产品缺陷。
        answerPending: async (payload) => {
          window.__ipcCalls.push({ action: 'answerPending', payload });
          return { ok: true };
        },
        showView: () => {},
      };`,
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

  // 12) 审批按钮（允许/拒绝）真的发 IPC —— 这是用户最高频的动作
  const beforeApprove = await evalIn('(window.__ipcCalls||[]).length');
  const approveClicked = await evalIn(`(() => {
    const btns = [...document.querySelectorAll('.att-btn')];
    const allow = btns.find(b => b.textContent === '允许');
    if (!allow) return 'no allow button';
    allow.click();
    return 'clicked allow';
  })()`);
  await sleep(800);
  // 用累计列表：answerPending 之后会触发 refresh()，slice 会把挤出窗口
  const afterApprove = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  check('12. approval "allow" button calls IPC', String(approveClicked) === 'clicked allow' && afterApprove.includes('answerPending'),
    String(approveClicked) + ' | ' + afterApprove);

  // 13) 提问的回答按钮真的发 IPC
  const answerClicked = await evalIn(`(() => {
    const btns = [...document.querySelectorAll('.att-btn')];
    const ans = btns.find(b => b.textContent === '回答' || b.textContent === '发送');
    if (!ans) return 'no answer button';
    ans.click();
    return 'clicked ' + ans.textContent;
  })()`);
  await sleep(800);
  const afterAnswer = await evalIn('JSON.stringify((window.__ipcCalls||[]).map(c=>c.action))');
  check('13. question answer button calls IPC', String(answerClicked).startsWith('clicked') && afterAnswer.includes('answerPending'),
    String(answerClicked));

  // 14) 全程仍然无 JS 错误
  const errs3 = await evalIn('JSON.stringify(window.__errs || [])');
  check('14. still no JS errors after all interactions', errs3 === '[]', errs3);

  // 15) 文案不得指向 dock 模式下不存在的位置
  //
  // 这条守的是一个很具体的坑：早期空态文案写"先在左边创建"，
  // 但 dock 模式（右栏 380px）是**单栏**，根本没有左边 ——
  // 新用户第一眼看到的就是这句，而它指向一个不存在的地方。
  //
  // 这轮页面已选中 Mission，看不到空态分支，所以直接**读源码里渲染出来的字符串**
  // 做断言（运行时的 innerText 检查已在空态截图里人工确认过）。
  const copyCheck = await evalIn(`(() => {
    const body = document.body.innerText;
    const badHints = ['左边创建', '左侧列表'].filter(h => body.includes(h));
    return JSON.stringify({ badHints });
  })()`);
  const copyParsed = JSON.parse(copyCheck);
  check('15. runtime copy has no "left side" hints', copyParsed.badHints.length === 0, copyCheck);

  // 15b) 直接对源码断言：空态分支里不许出现"左边/左侧"
  //
  // 为什么在 Node 侧读文件而不是页面里 fetch：file:// 的 fetch 被 CORS 挡住。
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'src', 'mission-desk.html'), 'utf8');
  // ⚠️ 必须用**唯一**的锚点：`state.missions.length === 0` 在 renderDockPicker 里也出现一次，
  //    用 indexOf 会命中错的那处（那处的后续 900 字符里根本没有空态文案）。
  //    这里用空态分支独有的 'empty-lead' + '还没有 Mission' 组合定位。
  const idx = src.indexOf("text: '还没有选中任何 Mission'");
  const block = idx === -1 ? '' : src.slice(Math.max(0, idx - 300), idx + 700);
  // 关键：只检查 **dock 分支**（三元表达式 ? 之后、: 之前那段）。
  //   双栏模式下"左侧列表"是**正确**的说法，不该被判为问题。
  //   早期版本对整个 block 做检查，于是把正确的双栏文案也误报了。
  const dockBranches = [];
  for (const m of block.matchAll(/DOCK_MODE\s*\n?\s*\?\s*'([^']*(?:\\'[^']*)*)'/g)) {
    dockBranches.push(m[1]);
  }
  const dockText = dockBranches.join(' | ');
  const badCopy = ['左边创建', '左侧列表', '左边'].filter((h) => dockText.includes(h));
  check('15b. empty-state source does not say "left side"',
    idx !== -1 && badCopy.length === 0, JSON.stringify({ found: idx !== -1, badCopy }));

  // 16) 没有授权时，派发面板必须**就地**提供授权入口
  //
  // 这条守的是新用户会卡住的地方：早期文案写"先在下方「授权目录」里授权一个目录"，
  // 而那个折叠区在页面很下面（要滚过进展、团队、一堆折叠区）。
  // 用户此刻正在派发面板里，而指引把他送到一个要找很久的地方。
  // 正确做法：**"去哪里做"变成"就在这里做"**。
  // 本探针的 listGrants mock 返回了 1 条有效 Grant，所以看不到这个分支；
  // 这里直接查源码，确认兜底分支存在且指向就地授权。
  const fs2 = require('node:fs');
  const src2 = fs2.readFileSync(path.join(REPO, 'src', 'mission-desk.html'), 'utf8');
  const grantBlockStart = src2.indexOf('const refreshGrantOptions');
  const grantBlock = grantBlockStart === -1 ? '' : src2.slice(grantBlockStart, grantBlockStart + 2000);
  const hasInline = grantBlock.includes('buildInlineGrant()');
  const saysInPlace = grantBlock.includes('可以直接在这里授权');
  const hasOldBadHint = grantBlock.includes('先在下方「授权目录」');
  check('16. no-grant case offers an IN-PLACE authorization form',
    hasInline && saysInPlace && !hasOldBadHint,
    JSON.stringify({ hasInline, saysInPlace, hasOldBadHint }));

  // 17) 就地授权的表单真的会调 createGrant
  const grantFormBlock = src2.indexOf('const buildInlineGrant');
  const gf = grantFormBlock === -1 ? '' : src2.slice(grantFormBlock, grantFormBlock + 1500);
  check('17. the inline grant form calls createGrant', gf.includes("api('createGrant'"), '');

  // 18) 保存任务书后，派发面板不能自己消失
  //
  // 这是本轮抓到的真实缺陷：保存成功后调了 refresh()，整页重建 →
  //   ① 面板被折叠回初始状态（用户刚填的内容从视野消失）
  //   ② "任务书已保存"提示被冲掉
  //   ③ 「交给团队」按钮随之消失 —— 用户卡在"保存成功但没法继续"
  //
  // 这与 renderStartWork 里注释过的"先显示提示再刷新"是同一个坑，在新代码里复发了。
  const fs3 = require('node:fs');
  const src3 = fs3.readFileSync(path.join(REPO, 'src', 'mission-desk.html'), 'utf8');
  const saveIdx = src3.indexOf("msg.textContent = '任务书已保存");
  const saveBlock = saveIdx === -1 ? '' : src3.slice(saveIdx, saveIdx + 900);
  // 先剥掉注释再判断 —— 注释里恰好写着 "不能 await refresh()"，
  // 直接正则会把它也算成违规（测试自己的误判）。
  const saveCode = saveBlock.split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n');
  const callsRefresh = /await\s+refresh\(\)/.test(saveCode);
  check('18. saving the task book does NOT wipe the panel (no refresh right after)', !callsRefresh,
    callsRefresh ? 'a refresh() here would fold the panel and hide the button' : '');

  // 19) 派发结果必须留在界面上（不能只靠一次 alert）
  const hasPersistBar = src3.includes("id: 'last-dispatch'") || src3.includes("id: 'last-dispatch',");
  const usesAlertAsOnlyFeedback = /else\s*\{[\s\S]{0,80}alert\(dispatchLine\)/.test(src3);
  check('19. dispatch result persists in the UI', hasPersistBar && !usesAlertAsOnlyFeedback,
    JSON.stringify({ hasPersistBar, usesAlertAsOnlyFeedback }));

  // 20) 任务书形态下 input 可能为 null，必须防护
  const hasNullGuard = /if \(input\) input\.value = ''/.test(src3);
  check('20. null input is guarded (task-book mode has no chat box)', hasNullGuard,
    hasNullGuard ? '' : 'input.value = \'\' without a guard throws in task-book mode');

  // 21) 折叠状态必须跨刷新保留
  //
  // 用户展开「交付物」看内容 → 随手记一条决策（会触发 refresh）→
  // 交付物自动合上，而他甚至不知道是谁合上的。
  // 折叠状态是**用户的意图**，不是渲染产物，不该被刷新抹掉。
  const persistCheck = await evalIn(`(async () => {
    const heads = [...document.querySelectorAll('.coll-head')];
    const target = heads.find(h => {
      const body = h.nextElementSibling;
      return body && body.style.display === 'none';
    });
    if (!target) return JSON.stringify({ skipped: 'no collapsed section' });
    const title = target.querySelector('.coll-title').textContent;
    target.click();
    const openedNow = target.nextElementSibling.style.display;

    // 用**真实**的刷新触发点：提交一条决策（它会 await refresh()）
    const decisionBtn = [...document.querySelectorAll('button')]
      .find(b => b.textContent === '记录决策');
    let refreshed = false;
    if (decisionBtn) {
      const inputs = [...document.querySelectorAll('input')];
      const txt = inputs.find(i => (i.placeholder || '').includes('决定了什么'));
      const why = inputs.find(i => (i.placeholder || '').includes('为什么'));
      if (txt && why) {
        txt.value = 'e2e 测试决策';
        why.value = 'e2e 测试理由';
        decisionBtn.click();
        refreshed = true;
      }
    }
    await new Promise(r => setTimeout(r, 900));

    const again = [...document.querySelectorAll('.coll-head')]
      .find(h => h.querySelector('.coll-title').textContent === title);
    const stillOpen = again ? again.nextElementSibling.style.display : 'gone';
    return JSON.stringify({ title, openedNow, stillOpen, refreshed });
  })()`);
  const pc = JSON.parse(persistCheck);
  check('21. collapse state survives a real refresh',
    pc.skipped ? false : (pc.openedNow === 'block' && pc.stillOpen === 'block'),
    String(persistCheck));

  // 22) 展开的表单在刷新后是否还存在（用户正在填的内容会不会被冲掉）
  const formCheck = await evalIn(`(async () => {
    // 打开任务改写表单并填入内容
    const btn = [...document.querySelectorAll('.task-op')].find(b => b.textContent === '改写');
    if (!btn) return JSON.stringify({ skipped: 'no rewrite button' });
    btn.click();
    await new Promise(r => setTimeout(r, 200));
    const input = document.querySelector('.task-rw-input');
    if (!input) return JSON.stringify({ skipped: 'form did not open' });
    input.value = '用户正在输入的内容';

    // 触发真实刷新
    const decisionBtn = [...document.querySelectorAll('button')].find(b => b.textContent === '记录决策');
    let refreshed = false;
    if (decisionBtn) {
      const inputs = [...document.querySelectorAll('input')];
      const txt = inputs.find(i => (i.placeholder || '').includes('决定了什么'));
      const why = inputs.find(i => (i.placeholder || '').includes('为什么'));
      if (txt && why) { txt.value = 'x'; why.value = 'y'; decisionBtn.click(); refreshed = true; }
    }
    await new Promise(r => setTimeout(r, 900));
    return JSON.stringify({
      refreshed,
      formStillOpen: !!document.querySelector('.task-rw-form'),
      textPreserved: (document.querySelector('.task-rw-input') || {}).value || null,
    });
  })()`);
  const fc = JSON.parse(formCheck);
  check('22. an open inline form survives a refresh (with its input)',
    fc.skipped ? false : (fc.formStillOpen && fc.textPreserved === '用户正在输入的内容'),
    String(formCheck));

  // 23) 所有用户可见的错误都必须经 explainFailure，不得直接透出 r.reason
  //
  // 第一性原理：r.reason 是**给开发者看的**（可能含 code、字段名、内部术语）。
  // explainFailure 才会给出人话 + 可执行建议。绕过它 = 用户看到技术黑话，
  // 而且 alert 一关就没了。
  const fs4 = require('node:fs');
  const src4 = fs4.readFileSync(path.join(REPO, 'src', 'mission-desk.html'), 'utf8');
  const code4 = src4.split('\n').filter((ln) => !ln.trim().startsWith('//')).join('\n');
  const rawAlerts = [...code4.matchAll(/alert\(\s*\(?\s*r\s*(?:&&\s*r\.reason|&&\s*r\.reason\s*\|\||\.reason)/g)];
  check('23. no user-facing error bypasses explainFailure', rawAlerts.length === 0,
    rawAlerts.length ? `found ${rawAlerts.length} raw alert(r.reason)` : '');

  // 24) 失败提示不得再引用 dock 模式下不存在的"左侧栏"
  const leftRefs = [...code4.matchAll(/['"][^'"]*左侧栏[^'"]*['"]/g)];
  check('24. failure copy does not reference a non-existent "left sidebar"', leftRefs.length === 0,
    leftRefs.length ? leftRefs.map((m) => m[0]).join(' | ') : '');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) { console.log('FAILED:'); for (const f of failed) console.log('  - ' + f.name + (f.detail ? ': ' + f.detail : '')); }
  c.close();
  chrome.kill('SIGKILL');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); try { chrome.kill('SIGKILL'); } catch {} process.exit(1); });
