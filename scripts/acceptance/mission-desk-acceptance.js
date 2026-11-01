'use strict';
// scripts/acceptance/mission-desk-acceptance.js — Mission Desk 真机验收探针（P1）。
//
// 第一性原理：离线测试已经覆盖了什么，真机还需要验证什么
//
//   已经由离线的 192 项 Mission 测试覆盖（不需要真机）：
//     · schema / projection / event-log / store / brief / deliverable / migration
//     · IPC 的 18 个 action 的参数校验与降级
//     · Brief 同步进 AGENTS.md 的数据安全（用户手写内容永不丢失）
//
//   只能由真机验证的（离线测不到）：
//     1. **Mission Desk 窗口能否真的打开并渲染**（loadFile 路径、CSP、preload 桥）
//     2. **三个轴在视觉上是否真的分开**（.badge vs .live 的 DOM 结构）
//     3. **"实时状态不可用"是否真的显示为文字**（而不是灰点）
//     4. **窗口加固是否生效**（contextIsolation/sandbox、无 node 全局）
//     5. **导航是否被拦截**（will-navigate）
//
//   这些失败在离线测试里全都是绿的——因为它们测的是源码字符串，不是运行时行为。
//
// 用法（需要一个有图形会话的环境）：
//   npx electron scripts/acceptance/mission-desk-acceptance.js
//
// 输出：
//   /tmp/mission-desk-acceptance/  ← 截图 + results.json
//   退出码 0 = 全部通过；1 = 有失败项
//
// 设计约束（与仓库既有探针一致）：
//   · 只读地验证，不写用户的真实工作区（用临时目录做 workspace）
//   · 失败要**具体**：报告哪一项、期望什么、实际什么
//   · 不在 CI 里跑（CI 无图形会话），但脚本本身可以被离线测试静态检查

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const EVIDENCE = path.join(os.tmpdir(), 'mission-desk-acceptance');
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail || '') });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function finish(code) {
  try {
    fs.mkdirSync(EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE, 'results.json'), JSON.stringify({ passed: failed === 0, failed, results }, null, 2));
    console.log(`\nEVIDENCE: ${EVIDENCE}`);
  } catch { /* best effort */ }
  app.exit(code);
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true });

  // 隔离工作区：验收不碰用户真实数据
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-acceptance-ws-'));

  // 最小 IPC 桩：只实现 Mission Desk 需要的 mission:invoke
  // （真机验收关注的是**渲染与窗口行为**，不是 IPC 语义——那已有 33 项测试覆盖）
  const seeded = {
    missionId: 'mis-acceptance',
    title: '验收用 Mission',
    intent: '验证 Mission Desk 能正确呈现三个轴',
    status: 'active',
    workspaceId: 'ws-acceptance',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    constraints: [{ id: 'con-1', text: '不许改业务代码', source: 'user' }],
  };
  ipcMain.handle('mission:invoke', async (_e, action) => {
    switch (action) {
      case 'list':
        return {
          ok: true,
          activeCount: 1,
          missions: [{
            missionId: seeded.missionId, title: seeded.title, status: 'active',
            // 关键：故意让 live 不可用，验证 UI 是否如实说"不可用"而非"未运行"
            live: { available: false },
          }],
        };
      case 'get':
        return {
          ok: true,
          view: { mission: seeded, workstreams: [], decisions: [], questions: [], deliverables: [], taskRefs: [] },
          live: { available: false },
        };
      case 'getBrief':
        return { ok: true, brief: { text: '# Brief\n## Intent\n验证用', bytes: 24, truncated: false, sections: ['header', 'intent'], empty: false } };
      case 'briefSyncState':
        return { ok: true, exists: false, synced: false, missionId: null };
      default:
        return { ok: true };
    }
  });

  const win = new BrowserWindow({
    width: 1040, height: 720, show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(REPO, 'src', 'settings-preload.js'),
    },
  });

  // 记录被拦截的导航（will-navigate）
  let navBlocked = 0;
  win.webContents.on('will-navigate', (e) => { e.preventDefault(); navBlocked += 1; });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[renderer error] ${message}`);
  });

  await win.loadFile(path.join(REPO, 'src', 'mission-desk.html'));
  await new Promise((r) => setTimeout(r, 1200)); // 等首帧 + 异步 IPC 回来

  const evalJs = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 页面真的渲染了 ----
  const title = await evalJs('document.querySelector("header h1").textContent').catch(() => '');
  record('window renders the Mission Desk header', /Mission Desk/.test(title), title);

  // ---- 2. preload 桥存在 ----
  const bridge = await evalJs('typeof (window.dshShell && window.dshShell.mission)').catch(() => 'missing');
  record('preload bridge `dshShell.mission` is exposed', bridge === 'function', bridge);

  // ---- 3. 列表渲染出 Mission ----
  const cards = await evalJs('document.querySelectorAll("#list .card").length').catch(() => 0);
  record('the mission list renders at least one card', cards >= 1, `cards=${cards}`);

  // ---- 4. 三个轴分开：status 徽章与 live 行是两个独立元素 ----
  const axes = await evalJs(`(() => {
    const card = document.querySelector('#list .card');
    if (!card) return { ok: false, why: 'no card' };
    const badge = card.querySelector('.badge');
    const live = card.querySelector('.live');
    return {
      ok: !!badge && !!live && badge !== live,
      badgeText: badge ? badge.textContent : null,
      liveText: live ? live.textContent : null,
      sameNode: badge === live,
    };
  })()`).catch((e) => ({ ok: false, why: String(e) }));
  record('Mission status and Harness state are SEPARATE elements', axes.ok,
    `badge="${axes.badgeText}" live="${axes.liveText}" sameNode=${axes.sameNode}`);

  // ---- 5. 不可用时如实说"不可用"（而不是灰点/未运行）----
  const honest = await evalJs(`document.querySelector('#list .live') ? document.querySelector('#list .live').textContent : ''`).catch(() => '');
  record('unavailable live state is stated in words', /不可用/.test(honest),
    honest || '(empty)');

  // ---- 6. 没有渲染出"无 Agent"这种确定的错误信息 ----
  record('unavailable state does NOT claim "no agent running"', !/无 Agent/.test(honest), honest);

  // ---- 7. focused 不是 Mission 状态：页面里没有 focused 徽章 ----
  const focused = await evalJs(`document.querySelectorAll('.badge.focused').length`).catch(() => 0);
  record('no "focused" badge exists (it is a UI concept, not a Mission status)', focused === 0, `count=${focused}`);

  // ---- 8. 窗口加固：renderer 里没有 node 全局 ----
  const noNode = await evalJs(`typeof require === 'undefined' && typeof process === 'undefined'`).catch(() => false);
  record('renderer has NO node globals (sandbox + contextIsolation)', noNode === true, String(noNode));

  // ---- 9. 导航被拦截 ----
  await evalJs(`try { window.location.href = 'https://example.com'; } catch (e) {}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const stillHere = await evalJs(`location.protocol === 'file:'`).catch(() => false);
  record('navigation away from the page is blocked', stillHere === true && navBlocked >= 1,
    `blocked=${navBlocked} protocol=${await evalJs('location.protocol').catch(() => '?')}`);

  // ---- 10. 截图存证 ----
  try {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(EVIDENCE, 'mission-desk.png'), image.toPNG());
    record('screenshot captured for visual review', image.getSize().width > 0,
      `${image.getSize().width}x${image.getSize().height}`);
  } catch (e) {
    record('screenshot captured for visual review', false, String(e));
  }

  win.destroy();
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`\n${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`} (${results.length} checks)`);
  finish(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  console.error('probe crashed:', e && e.stack || e);
  finish(1);
});
