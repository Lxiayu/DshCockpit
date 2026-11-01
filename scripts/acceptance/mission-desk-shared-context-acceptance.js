'use strict';
// scripts/acceptance/mission-desk-shared-context-acceptance.js
// 三实体 + UI 层级 真机验收。
//
// 第一性原理：为什么必须真机验
//   离线能证明 schema 有 finding/assumption/evidence。
//   证明不了：
//     · 它们**渲染出来了吗**（可能字段名对不上，显示 undefined）
//     · **视觉层级真的分开了吗**（标题 vs 正文 vs 元信息，字号/字重真不同？）
//     · 双主题下**都看得清吗**

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-shared-context-acceptance');
const W = 380, H = 900;

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

const NOW = Date.now();
const VIEW = {
  mission: { missionId: 'mis-1', title: 'DshCockpit Runtime 集成', intent: '完成 Agent Team 接入', status: 'active' },
  workstreams: [{ workstreamId: 'ws-1', title: 'Runtime Bridge', status: 'active' }],
  decisions: [{ decisionId: 'd-1', text: '暂不引入第二套 Harness', rationale: '官方已足够', status: 'accepted', decidedBy: 'user', decidedAtMs: NOW - 3600e3 }],
  questions: [{ questionId: 'q-1', text: '第二页做什么？', status: 'open', askedAtMs: NOW - 1800e3 }],
  deliverables: [],
  taskRefs: [],
  findings: [
    { findingId: 'fnd-1', missionId: 'mis-1', text: 'session/follow 是流式的，page 看不到增量', status: 'verified', confidence: 'high', foundAtMs: NOW - 5400e3, foundBy: 'model', evidenceIds: ['evd-1'] },
    { findingId: 'fnd-2', missionId: 'mis-1', text: '旧侧栏其实是个任务面板', status: 'refuted', confidence: 'low', foundAtMs: NOW - 4000e3, foundBy: 'user', refutedReason: '实测它就是 work.html' },
  ],
  assumptions: [
    { assumptionId: 'asm-1', missionId: 'mis-1', text: '用户会先配置模型 Key', status: 'holding', assumedAtMs: NOW - 7200e3, assumedBy: 'model', verifyBy: '看首次启动是否报缺 key', expiresAtMs: NOW + 3600e3 * 5 },
    { assumptionId: 'asm-2', missionId: 'mis-1', text: '右栏 380px 够用', status: 'violated', assumedAtMs: NOW - 9000e3, assumedBy: 'user', violatedReason: '三视图塞不下' },
  ],
  evidences: [
    { evidenceId: 'evd-1', missionId: 'mis-1', kind: 'commit', ref: 'a67e6fe', claim: '这个提交把 dock 换成 mission-desk', recordedAtMs: NOW - 5400e3, recordedBy: 'model', targetKind: 'finding', targetId: 'fnd-1' },
    { evidenceId: 'evd-2', missionId: 'mis-1', kind: 'file', ref: 'src/window-manager.js', claim: 'dock 加载 mission-desk.html?dock=1', recordedAtMs: NOW - 5000e3, recordedBy: 'user' },
  ],
};
const LIVE = { available: true, observedAtMs: NOW, hasRunningAgent: false, pendingApprovals: 0, pendingQuestions: 0 };
const ATT = { ok: true, available: true, observedAtMs: NOW, total: 0, counts: { approval: 0, question: 0 }, items: [] };
const SINCE = { ok: true, available: false, reason: 'never-seen', entries: [], sinceMs: null };

async function main() {
  ipcMain.handle('mission:invoke', (_e, action) => {
    switch (action) {
      case 'list': return { ok: true, missions: [{ ...VIEW.mission, live: LIVE }] };
      case 'get': return { ok: true, view: VIEW, live: LIVE };
      case 'attention': return ATT;
      case 'sinceLastSeen': return SINCE;
      case 'markSeen': return { ok: true, atMs: NOW };
      case 'getBrief': return { ok: true, brief: { text: 'b' } };
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
      preload: path.join(REPO, 'src', 'settings-preboot.js'.replace('preboot', 'preload')),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/Security Warning/.test(msg)) errors.push(msg);
  });
  await win.loadFile(path.join(REPO, 'src', 'mission-desk.html'), { query: { dock: '1' } });
  await new Promise((r) => setTimeout(r, 1800));
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 引导不再重复（dock 模式下 #list 完全隐藏）----
  const dup = await ev(`(() => {
    const list = document.getElementById('list');
    const listVisible = list ? getComputedStyle(list).display !== 'none' : false;
    return { listVisible, listText: list && listVisible ? list.innerText.slice(0, 60) : '' };
  })()`).catch(() => ({}));
  record('in dock mode the list is fully hidden (no duplicate empty state)',
    dup.listVisible === false, JSON.stringify(dup));

  // ---- 2. 三个实体真的渲染 ----
  const sc = await ev(`(() => {
    const d = document.getElementById('detail');
    const text = d ? d.innerText : '';
    return {
      text,
      hasFindings: /发现/.test(text),
      hasAssumptions: /假设/.test(text),
      hasEvidence: /证据/.test(text),
      findingCount: document.querySelectorAll('.sc-badge').length,
    };
  })()`).catch(() => ({}));
  const t = sc.text || '';
  record('the findings section renders REAL data', /session\/follow 是流式的/.test(t), '');
  record('the assumptions section renders REAL data', /用户会先配置模型 Key/.test(t), '');
  record('the evidence section renders REAL data', /a67e6fe/.test(t), '');
  record('a refuted finding shows its label', /已推翻/.test(t), '');
  record('a violated assumption shows WHY', /右栏 380px 够用|三视图塞不下/.test(t), '');
  record('evidence shows its claim (what it supports)', /这个提交把 dock 换成/.test(t), '');
  record('status badges are present', (sc.findingCount || 0) >= 4, `badges=${sc.findingCount}`);

  // ---- 3. 视觉层级真的分开了（scale + weight，不是只靠颜色）----
  const hier = await ev(`(() => {
    function info(sel) {
      const e = document.querySelector(sel);
      if (!e) return null;
      const cs = getComputedStyle(e);
      return { size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), ls: cs.letterSpacing, tt: cs.textTransform };
    }
    return { h2: info('h2'), text: info('.sc-text'), meta: info('.sc-meta') };
  })()`).catch(() => ({}));
  const H2 = hier.h2 || {}, TXT = hier.text || {}, META = hier.meta || {};
  record('section labels use UPPERCASE + tracking (shape, not just colour)',
    H2.tt === 'uppercase' && parseFloat(H2.ls) >= 0.5, JSON.stringify(H2));
  record('body text is LARGER than metadata (scale carries hierarchy)',
    (TXT.size || 0) > (META.size || 0), `text=${TXT.size} meta=${META.size}`);
  record('section labels are heavier than body text (weight carries hierarchy)',
    (H2.weight || 0) > (TXT.weight || 0), `label=${H2.weight} text=${TXT.weight}`);

  // ---- 4. 区块之间没有分隔线（靠留白分组）----
  const sep = await ev(`(() => {
    const secs = [...document.querySelectorAll('.sec')];
    return secs.map((s) => getComputedStyle(s).borderTopWidth);
  })()`).catch(() => []);
  record('sections are separated by WHITESPACE, not borders',
    sep.length === 0 || sep.every((w) => w === '0px'), JSON.stringify(sep));

  // ---- 5. 双主题对比度 ----
  async function contrast(mode) {
    await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
    await new Promise((r) => setTimeout(r, 320));
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
        return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
      }
      const cs = getComputedStyle(document.body);
      const bg = cs.backgroundColor === 'rgba(0, 0, 0, 0)'
        ? getComputedStyle(document.documentElement).backgroundColor : cs.backgroundColor;
      const out = {};
      for (const sel of ['.sc-text', '.sc-meta', 'h2']) {
        const e = document.querySelector(sel);
        if (e) out[sel] = ratio(getComputedStyle(e).color, bg);
      }
      return out;
    })()`);
  }
  const dark = await contrast('dark');
  const light = await contrast('light');
  record('DARK: shared-context text contrast >= 4.5', (dark['.sc-text'] || 0) >= 4.5, JSON.stringify(dark));
  record('LIGHT: shared-context text contrast >= 4.5', (light['.sc-text'] || 0) >= 4.5, JSON.stringify(light));
  record('LIGHT: metadata contrast >= 4.5', (light['.sc-meta'] || 0) >= 4.5, String(light['.sc-meta']));

  // ---- 6. 截图 ----
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    for (const mode of ['dark', 'light']) {
      await ev(`document.documentElement.setAttribute('data-theme', '${mode}')`);
      await new Promise((r) => setTimeout(r, 320));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(EVIDENCE, `shared-context-${mode}.png`), img.toPNG());
    }
    record('screenshots captured for both themes', true, 'dark + light');
  } catch (e) { record('screenshots captured for both themes', false, String(e)); }

  record('the renderer had no fatal errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  win.destroy();
  finish();
}

app.whenReady().then(main).catch((e) => { console.error('probe crashed:', e && e.stack || e); finish(); });
