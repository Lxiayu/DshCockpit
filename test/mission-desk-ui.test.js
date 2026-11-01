// test/mission-desk-ui.test.js — P1：Mission Desk 页面契约。
//
// 第一性原理：为什么给 HTML 写静态测试
//
//   Mission Desk 是 P1 的第一个用户可见界面。它的失效方式不是崩溃，
//   而是**误导**：
//     · 把 Running 和 Active 混在同一个徽章里 → 用户以为"我在看"= "它在跑"
//     · 实时状态不可用时显示灰点 → 用户以为"确定没在跑"，其实只是读不到
//     · 多个 active 被呈现成"当前项目" → 用户不知道可以并行
//
//   这些错误在代码 review 时都不显眼（只是几个 CSS class 和文案），
//   但直接决定用户对"项目连续性"的理解是否正确。
//
//   测试方式：静态检查 HTML 源码里的**结构性事实**（不是 DOM 行为——
//   那需要真机/Electron）。这能锁住设计意图不被随手改掉。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'mission-desk.html'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'settings-preload.js'), 'utf8');
const aux = fs.readFileSync(path.join(ROOT, 'src', 'aux-windows.js'), 'utf8');

// ---------------------------------------------------------------- 桥一致性

test('mission-desk: the page calls exactly the bridge the preload exposes', () => {
  assert.match(preload, /mission:\s*\(action,\s*payload\)\s*=>\s*ipcRenderer\.invoke\('mission:invoke'/,
    'the preload must forward to the single mission:invoke channel');
  assert.match(html, /window\.dshShell\.mission\(/,
    'the page must use that bridge');
});

test('mission-desk: the page never invents its own channel', () => {
  // 页面里不该出现 ipcRenderer 或写死的通道名——只有 dshShell.mission 这一条路。
  assert.doesNotMatch(html, /ipcRenderer/, 'the renderer must not touch ipcRenderer directly');
  assert.doesNotMatch(html, /'mission:[a-z-]+'/, 'no ad-hoc channel names in the page');
});

test('mission-desk: uses textContent, never innerHTML (no injection surface)', () => {
  // Mission 的 title/intent 是用户输入，直接 innerHTML 就是 XSS。
  assert.doesNotMatch(html, /innerHTML/, 'user-supplied text must never be parsed as HTML');
  assert.match(html, /createTextNode|textContent/, 'content must be inserted as text');
});

// ------------------------------------------- 三个轴必须视觉上分开

test('mission-desk: Active status and Running state are rendered in SEPARATE elements', () => {
  // domain-model §2.1.1：Active / Focused / Running 是三件不同的事。
  // 合并成一个徽章是最容易犯、最难发现的误导。
  assert.match(html, /class: 'badge ' \+ m\.status/, 'Mission status gets its own badge');
  assert.match(html, /class: 'live'/,
    'Harness state gets its own element, not folded into the status badge');
  // 四个 Mission 状态都必须有样式（没有 focused —— 它不是状态）
  for (const st of ['active', 'paused', 'completed', 'abandoned']) {
    assert.match(html, new RegExp(`\\.badge\\.${st}`), `status ${st} needs its own style`);
  }
  assert.doesNotMatch(html, /\.badge\.focused/, 'focused is a UI concept, not a Mission status');
});

test('mission-desk: Running state is ALWAYS shown with a relative timestamp', () => {
  // "Agent 在跑" 没有时间就是一句会被误读成"现在"的断言。
  assert.match(html, /function relativeTime\(/, 'a relative-time helper must exist');
  assert.match(html, /relativeTime\(live\.observedAtMs\)/, 'the live line must use it');
});

test('mission-desk: when no snapshot is available it says SO, instead of showing "not running"', () => {
  // 这是最关键的诚实性要求：
  //   不可用 ≠ 没有在跑。显示灰点会让用户得到一个"确定"的错误结论。
  assert.match(html, /实时状态不可用/,
    'the unavailable state must be stated in words');
  assert.match(html, /dot unknown/, 'and must not reuse the "off" dot shape');
  // 不允许在 unavailable 分支里渲染 "无 Agent"
  const unavailBlock = html.slice(html.indexOf('实时状态不可用') - 400, html.indexOf('实时状态不可用') + 200);
  assert.doesNotMatch(unavailBlock, /hasRunningAgent/, 'the unavailable branch must not report a running boolean');
});

// ---------------------------------------------------- 多 active 是常态

test('mission-desk: the UI never implies a single current project', () => {
  // 单数表述（"当前项目"）会让用户以为只能有一个 active。
  //
  // 注意：检查必须**排除注释**——设计注释里恰恰会出现"不做当前项目这种表述"
  // 这样的说明文字。若全文件匹配，会把正确的设计说明判成违规。
  const code = html
    .replace(/<!--[\s\S]*?-->/g, '')     // HTML 注释
    .replace(/\/\*[\s\S]*?\*\//g, '')  // 块注释
    .replace(/^\s*\/\/.*$/gm, '');       // 行注释
  assert.doesNotMatch(code, /当前项目/, 'no singular "current project" phrasing in rendered code');
  assert.match(html, /进行中 .*\/ 共/, 'the header must show a count, not a single selection');
});

test('mission-desk: the soft limit (>10 active) is a HINT, never a block', () => {
  // domain-model §2.1.1：建议 ≤10 是软提示，实现位置在 UI 层。
  // 它绝不能阻止创建——那是数据层/产品层的越界。
  assert.match(html, /active\.length > 10/, 'the soft limit is computed in the UI');
  assert.match(html, /这只是提醒，不影响创建/,
    'the hint must say it does not block');
  // 创建按钮不得因为数量而被禁用
  assert.doesNotMatch(html, /btnNew.*disabled\s*=\s*true/, 'creating must never be disabled by a count');
});

// --------------------------------------------------------- Brief 可见

test('mission-desk: the Brief is rendered as text (it is what the agent will read)', () => {
  assert.match(html, /Mission Brief/, 'the brief section must exist');
  assert.match(html, /state\.brief\.text/, 'the brief body must be rendered');
  assert.match(html, /已截断/, 'truncation must be disclosed to the user');
});

// --------------------------------------------------------- 产物三态

test('mission-desk: deliverable statuses are styled per state (modified is not "failed")', () => {
  for (const st of ['unchanged', 'modified', 'missing', 'invalid']) {
    assert.match(html, new RegExp(`\\.st-${st}`), `deliverable state ${st} needs distinct styling`);
  }
  assert.match(html, /内容已变化/, 'modified must be explained in words, not just a colour');
});

// ------------------------------------------------------------- 窗口

test('mission-desk: opens in its own window (settings.html is already 5918 lines)', () => {
  // TD-31：settings.html 5918 行 / 17 个页面挤一个文件。
  // 再往里加 Mission Desk 只会让那个文件继续膨胀。
  assert.match(aux, /missionDeskWindow/, 'a dedicated window must exist');
  assert.match(aux, /mission-desk\.html/, 'loading the dedicated page');
  assert.match(aux, /openMissionDesk/, 'and exposed for the IPC layer');
});

test('mission-desk: the window reuses the settings preload instead of adding a new surface', () => {
  // 每新增一个 preload 就多一处需要同步的 surface（TD-06/07 已记录 IPC 无冻结）。
  const block = aux.slice(aux.indexOf('function createMissionDesk'), aux.indexOf('function openMissionDesk'));
  assert.match(block, /preload: path\.join\(__dirname, 'settings-preload\.js'\)/);
  assert.doesNotMatch(block, /mission-desk-preload\.js/, 'no extra preload file');
});

test('mission-desk: the window hardens the renderer (contextIsolation + sandbox, no node)', () => {
  const block = aux.slice(aux.indexOf('function createMissionDesk'), aux.indexOf('function openMissionDesk'));
  assert.match(block, /contextIsolation: true/);
  assert.match(block, /nodeIntegration: false/);
  assert.match(block, /sandbox: true/);
  // 2026-11-01（TD-09）：单点加固后，窗口不再各自写 will-navigate，
  // 而是统一调 hardenWebContents。断言改为「必须走统一加固」——
  // 这不是放宽，而是更严：hardenWebContents 同时覆盖导航拦截、
  // window.open deny、<webview> 拦截三类保护（见 window-hardening.js）。
  assert.match(block, /hardenWebContents\(missionDeskWindow\.webContents/,
    'navigation must be blocked via the shared hardening helper, like every other window');
});

test('mission-desk: has a strict CSP', () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'self'/);
});

// --------------------------------------------------------- openDesk action

test('mission-desk: the openDesk action fails loudly when the opener is not wired', async () => {
  // 静默无反应（点了按钮什么都没发生）是最难排查的失败。
  const { registerMissionIpc } = require('../src/ipc-mission.js');
  const handlers = new Map();
  registerMissionIpc({ handle: (c, f) => handlers.set(c, f) }, {
    workspaceDirOf: () => '/tmp/x',
    openDeskWindow: null, // 故意不接
  });
  const out = await handlers.get('mission:invoke')({}, 'openDesk', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'WINDOW_NOT_WIRED');
});

test('mission-desk: openDesk calls the injected opener', async () => {
  const { registerMissionIpc } = require('../src/ipc-mission.js');
  const handlers = new Map();
  let opened = 0;
  registerMissionIpc({ handle: (c, f) => handlers.set(c, f) }, {
    workspaceDirOf: () => '/tmp/x',
    openDeskWindow: () => { opened += 1; },
  });
  const out = await handlers.get('mission:invoke')({}, 'openDesk', {});
  assert.strictEqual(out.ok, true);
  assert.strictEqual(opened, 1);
});

test('mission-desk: a throwing opener becomes {ok:false} with a reason', async () => {
  const { registerMissionIpc } = require('../src/ipc-mission.js');
  const handlers = new Map();
  registerMissionIpc({ handle: (c, f) => handlers.set(c, f) }, {
    workspaceDirOf: () => '/tmp/x',
    openDeskWindow: () => { throw new Error('display unavailable'); },
  });
  const out = await handlers.get('mission:invoke')({}, 'openDesk', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'WINDOW_FAILED');
  assert.match(out.reason, /display unavailable/);
});

// ------------------------------------- Brief → AGENTS.md 同步（P1 最后一环）

test('mission-desk: syncing the brief requires an explicit user action', () => {
  // 它会写入用户工作区的 AGENTS.md。自动写用户文件是越界行为——
  // 即使内容"有用"，用户也必须知道并同意。
  assert.match(html, /同步到 AGENTS\.md/, 'the action must be visible');
  assert.match(html, /不会覆盖你手写的内容/, 'and must state the safety property');
});

test('mission-desk: the sync state is shown honestly (synced vs not synced)', () => {
  assert.match(html, /已同步到 AGENTS\.md/, 'a synced state must be visible');
  assert.match(html, /撤销同步/, 'and reversible from the UI');
  assert.match(html, /briefSyncState/, 'the UI must read the real state, not assume');
});

test('mission-desk: sync state is scoped to the selected mission', () => {
  // 另一个 Mission 同步过，不代表当前这个同步过。
  assert.match(html, /syncState\.missionId === m\.missionId/);
});
