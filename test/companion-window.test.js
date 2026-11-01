// test/companion-window.test.js — P2.4 S3：Companion 窗口的生命周期与契约。
//
// 第一性原理：为什么小窗用独立 BrowserWindow 而不是子视图
//
//   验收标准要求「把办公室收成常驻小窗」，且主窗口收起后它仍在。
//   子视图（WebContentsView）随主窗口销毁 —— 做不到这一点。
//
//   代价是多一个渲染进程。所以必须守两条：
//     · 它加载的是**极简页面**，不加载 PixiJS（否则常驻成本不可接受）
//     · 它的 preload 只暴露 3 个方法（常驻窗口的每个 API 都是长期攻击面）
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const auxSrc = fs.readFileSync(path.join(ROOT, 'src', 'aux-windows.js'), 'utf8');
const companionHtml = fs.readFileSync(path.join(ROOT, 'src', 'companion.html'), 'utf8');
const companionJs = fs.readFileSync(path.join(ROOT, 'src', 'companion.js'), 'utf8');
const preloadRaw = fs.readFileSync(path.join(ROOT, 'src', 'companion-preload.js'), 'utf8');
// 断言只看代码：注释里写"它拿不到 office:dispatch"不等于代码能调它。
// （本项目已多次因为匹配到注释而误报——固定成习惯。）
const preloadSrc = preloadRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ============================================================ 窗口特性

test('companion window: it is an INDEPENDENT BrowserWindow (survives main close)', () => {
  // 子视图做不到"主窗口关闭后仍在"——这是验收标准的硬要求。
  assert.match(auxSrc, /function createCompanion\(\)/);
  assert.match(auxSrc, /companionWindow = new BrowserWindow\(/);
});

test('companion window: the chrome choices each have a reason', () => {
  const start = auxSrc.indexOf('function createCompanion()');
  const block = auxSrc.slice(start, start + 1800);
  assert.match(block, /frame:\s*false/, 'a persistent widget must not carry a title bar');
  assert.match(block, /alwaysOnTop:\s*true/, 'otherwise it disappears when the user switches apps');
  assert.match(block, /skipTaskbar:\s*true/, 'it is a widget, not a primary task');
  assert.match(block, /resizable:\s*false/, 'its content is one line of text');
});

test('companion window: it is hardened like every other window', () => {
  assert.match(auxSrc, /hardenWebContents\(companionWindow\.webContents/);
});

test('companion window: it does NOT load the PixiJS office page', () => {
  // 常驻窗口加载完整办公室 = PixiJS 常驻 = 成本不可接受。
  const start = auxSrc.indexOf('function createCompanion()');
  const block = auxSrc.slice(start, start + 1800);
  assert.match(block, /companion\.html/);
  assert.doesNotMatch(block, /office\.html/, 'the companion must not host the full office renderer');
  assert.doesNotMatch(block, /pixi/i);
});

test('companion window: create/push/close/has are all exported', () => {
  for (const fn of ['createCompanion', 'pushCompanionState', 'closeCompanion', 'hasCompanion', 'setCompanionVisible']) {
    assert.ok(auxSrc.includes(fn), `${fn} must be exported from aux-windows`);
  }
});

test('companion window: screen is optional (unit tests have no Electron screen)', () => {
  // 缺 screen 时跳过低定位，不抛错。
  const start = auxSrc.indexOf('function createCompanion()');
  const block = auxSrc.slice(start, start + 2200);
  assert.match(block, /if \(screen && typeof screen\.getPrimaryDisplay === 'function'\)/);
});

// ============================================================ 极简页面

test('companion page: it carries NO third-party scripts', () => {
  // CSP 也禁止，但静态断言能更早发现问题。
  assert.doesNotMatch(companionHtml, /<script[^>]*src=["'](?!\.\/companion\.js)/,
    'the only script may be companion.js');
});

test('companion page: the indicator colour is driven by data-kind', () => {
  // 只有真实待办才亮红；0 待办时不能亮（否则用户学会无视它）。
  assert.match(companionHtml, /data-kind="needs-you"\]\s*#dot\s*\{\s*background:\s*#ff5c5c/);
  assert.match(companionHtml, /body\[data-kind="idle"\]\s*#dot\s*\{\s*background:\s*#4ade80/);
});

test('companion page: it is draggable (a persistent widget must be movable)', () => {
  assert.match(companionHtml, /-webkit-app-region:\s*drag/);
});

test('companion renderer: it consumes `kind` and does NOT re-derive it', () => {
  // 两处推导迟早不一致（派生层说 idle，UI 还亮红）。
  const start = companionJs.indexOf('function render(state)');
  const block = companionJs.slice(start, start + 800);
  assert.match(block, /state\.kind/, 'it must read the derived kind');
  assert.doesNotMatch(block, /pendingCount\s*>\s*0\s*\?/, 'it must not re-decide whether attention is needed');
});

// ============================================================ preload 极简

test('companion preload: it exposes exactly three capabilities', () => {
  // 常驻窗口的每个 API 都是长期攻击面。
  const exposed = [];
  for (const m of preloadSrc.matchAll(/^\s{2}([a-zA-Z]+):/gm)) exposed.push(m[1]);
  assert.deepStrictEqual(exposed.sort(), ['expand', 'lastState', 'onLanguage', 'onState'],
    'exactly: two subscriptions + expand + a read-only cache getter');
});

test('companion preload: it does NOT expose office capability channels', () => {
  // 常驻挂件不该能 dispatch / 回答 pending / 改 settings。
  for (const forbidden of ['office:dispatch', 'office:pending', 'mission:', 'shell:save-settings', 'shell:work']) {
    assert.ok(!preloadSrc.includes(forbidden), `companion must not reach ${forbidden}`);
  }
});

test('companion preload: expand is the ONLY write-ish call', () => {
  const invokes = [...preloadSrc.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(invokes, ['companion:expand']);
});

// ============================================ 与主进程接线

test('companion wiring: state is pushed from the SAME office snapshot (single source)', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const subscribeStart = mainSrc.indexOf('officeModuleInstance.subscribe((snapshot) => {');
  assert.ok(subscribeStart !== -1);
  const block = mainSrc.slice(subscribeStart, subscribeStart + 900);
  assert.match(block, /pushCompanionState/, 'the companion rides the office snapshot broadcast');
  assert.match(block, /deriveCompanionState\(snapshot\)/, 'derived from the same snapshot, not a second source');
});
