'use strict';

// test/work-view-wiring.test.js — v0.7 P1 WP3：工作台视图的接线与边界（源级）。
//
// 这类测试不做像素断言，只钉住一旦破坏就会"看起来能用其实没接上"的契约：
// 视图注册、通道、信任边界、i18n 覆盖、渲染安全。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const HTML = read('src/work/work.html');
const JS = read('src/work/work.js');
const PRELOAD = read('src/work/work-preload.js');
const WM = read('src/window-manager.js');
const MAIN = read('src/main.js');
const RAIL = read('src/office-rail.html');
const RAIL_PRELOAD = read('src/office-rail-preload.js');
const I18N = read('src/i18n.js');

test('work-view: the view ships its own page, styles, script and a scoped preload', () => {
  for (const file of ['src/work/work.html', 'src/work/work.css', 'src/work/work.js', 'src/work/work-preload.js']) {
    assert.ok(exists(file), `${file} must exist`);
  }
  // no inline script: the CSP stays meaningful
  assert.match(HTML, /script-src 'self'/);
  assert.match(HTML, /<script src="work\.js"><\/script>/);
  assert.doesNotMatch(HTML, /<script(?![^>]*src=)[^>]*>/, 'no inline <script> blocks');
  assert.doesNotMatch(HTML, /require\(|nodeIntegration/, 'the page never reaches node');
});

test('work-view: the main process hosts it as a sandboxed third main-area view', () => {
  const block = WM.slice(WM.indexOf('function showWorkShellView()'), WM.indexOf('function isWorkViewActive()'));
  assert.ok(block.length > 100, 'showWorkShellView exists');
  assert.match(block, /new WebContentsView\(\{/);
  assert.match(block, /contextIsolation: true/);
  assert.match(block, /nodeIntegration: false/);
  assert.match(block, /sandbox: true/);
  assert.match(block, /preload: path\.join\(__dirname, 'work', 'work-preload\.js'\)/);
  assert.match(block, /loadFile\(path\.join\(__dirname, 'work', 'work\.html'\)\)/);
  assert.match(block, /activeMainView = 'work';/);
  assert.match(block, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  // exported for the rail + the snapshot push
  assert.match(WM, /showWorkShellView, isWorkViewActive, sendToWorkView,/);
  // the view is torn down with the window (no zombie webContents)
  assert.match(WM, /officeShellView = null; \/\/ child views die with the window's contents\n      workView = null;/);
});

test('work-view: the rail offers a third entry and the switch reaches the view', () => {
  assert.match(RAIL, /id="work" class="tile" data-i18n-title="office\.rail\.work"/);
  assert.match(RAIL, /workBtn\.classList\.toggle\('on', activeView === 'work'\)/);
  assert.match(RAIL, /api\.switchView\('work'\)/);
  assert.match(RAIL_PRELOAD, /view === 'work' \? 'work' : view === 'office' \? 'office' : 'harness'/);
  assert.match(MAIN, /if \(view === 'work'\) \{\n      windowManager\.showWorkShellView\(\);/);
});

test('work-view: main owns the work IPC, the workspace and the artifact push', () => {
  assert.match(MAIN, /function registerShellWorkIpc\(ipcMain\)/);
  assert.match(MAIN, /const \{ createWorkIpc \} = require\('\.\/work\/work-ipc\.js'\)/);
  assert.match(MAIN, /work\.register\(ipcMain\)/);
  assert.match(MAIN, /registerShellWorkIpc\(ipcMain\);/);
  // artifacts land inside the workspace, never in userData for the workbench path
  assert.match(MAIN, /artifactDir: path\.join\(workspace\.path, '\.dsh', 'artifacts'\)/);
  assert.match(MAIN, /onArtifact: \(record, context\) => \{/);
  assert.match(MAIN, /controller\.sync\(teamState\)/);
  // the push channel is the shell's own namespace
  assert.match(MAIN, /sendToWorkView\('work:update', workStatusPayload\(\)\)/);
  assert.match(MAIN, /settings\.patch\(\{ workWorkspace: workspace\.path \}\)/);
});

test('work-view: the drive loop handles attention/blocked BEFORE blocking on the next event', () => {
  // 真机验收 2026-10-27：pumpOne 阻塞在已完成会话上 → 工作项永远 running。
  // 顺序必须: dispatchReady → 同步/检查终态/attention → 检查 blocked → 才 pumpOne。
  const dispatchAt = MAIN.indexOf('await controller.dispatchReady();');
  const statusAt = MAIN.indexOf("const preStatus = runtime.state().status;");
  const blockedAt = MAIN.indexOf('const blocked = controller.blocked();');
  const pumpAt = MAIN.indexOf('const step = await controller.pumpOne();');
  assert.ok(dispatchAt > -1 && statusAt > dispatchAt, 'status is checked right after dispatchReady');
  assert.ok(blockedAt > statusAt && pumpAt > blockedAt, 'blocked is checked before the blocking pump');
  assert.match(MAIN, /\['completed', 'failed', 'cancelled', 'attention'\]\.includes\(preStatus\)/);
  assert.match(MAIN, /onBlocked: \(blocked\) => \{\n        controller\.block\(blocked\);/);
});

test('work-view: cancelling a blocked chain abandons the shell item and detaches the chain', () => {
  assert.match(MAIN, /instance\.detach\(\);/);
  assert.match(MAIN, /controller\.snapshot\(\)\.active\) controller\.abandon\(\)/);
  assert.match(JS, /result\.abandoned \? tr\('work\.abandoned'\)/);
});

test('work-view: blocked reasons and the abandoned state are localized', () => {
  for (const key of ['work.status.abandoned', 'work.blocked.HANDOFF_INCOMPLETE', 'work.blocked.DISPATCH_REJECTED', 'work.blocked.generic']) {
    assert.equal(I18N.split(`'${key}':`).length - 1, 2, `both languages must define ${key}`);
  }
});

test('work-view: the renderer is text-only and talks through one channel', () => {
  assert.doesNotMatch(JS, /innerHTML/, 'user text and artifacts are rendered via textContent');
  assert.match(JS, /textContent = item\.goal/);
  assert.match(JS, /textContent = result\.text/);
  assert.match(JS, /compactMode = new URLSearchParams\(location\.search\)\.get\('compact'\) === '1'/);
  assert.doesNotMatch(JS, /require\(|process\.|localStorage/, 'the renderer has no node or storage access');
  const invokes = [...JS.matchAll(/action: '([a-z-]+)'/g)].map((m) => m[1]);
  // P3.3: 'focus' is the office→dock member focus (presentation emphasis on
  // existing artifacts), still one channel + action payload.
  assert.deepEqual([...new Set(invokes)].sort(), ['cancel', 'expand', 'focus', 'open-artifact', 'resume', 'retry', 'select-workspace', 'start', 'status']);
  assert.match(PRELOAD, /ipcRenderer\.invoke\('shell:work', payload\)/);
  assert.doesNotMatch(PRELOAD, /shell:work:[a-z-]+/, 'one channel + action payload, not a family of channels');
});

test('work-view: the preload exposes no direct fs/ipc passthrough', () => {
  assert.doesNotMatch(PRELOAD, /exposeInMainWorld\('workApi', \{\s*ipcRenderer/);
  assert.doesNotMatch(PRELOAD, /invoke: \(channel, payload\)/, 'the channel is fixed, not caller-chosen');
  assert.match(PRELOAD, /pickFolder: \(\) => ipcRenderer\.invoke\('shell:pick-folder', 'workspace'\)/);
});

test('work-view: every element id the renderer reaches for exists in the page', () => {
  const ids = new Set([...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...JS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 15, 'the renderer actually wires the page');
  for (const id of used) assert.ok(ids.has(id), `work.js reaches for #${id}, which work.html does not define`);
});

test('work-view: every static i18n key exists in both languages', () => {
  const keys = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) keys.add(m[1]);
  for (const key of keys) {
    const zh = I18N.includes(`'${key}':`);
    const enCount = I18N.split(`'${key}':`).length - 1;
    assert.equal(zh, true, `zh copy missing for ${key}`);
    assert.ok(enCount >= 2, `en copy missing for ${key}`);
  }
  // every status the controller can persist has a label
  for (const status of ['running', 'attention', 'completed', 'incomplete', 'failed', 'cancelled', 'interrupted', 'idle']) {
    assert.ok(I18N.includes(`'work.status.${status}':`), `missing label for status ${status}`);
  }
  // the artifact kinds the schemas accept have labels
  for (const kind of ['research-notes', 'review-findings', 'report']) {
    assert.ok(I18N.includes(`'work.kind.${kind}':`), `missing label for kind ${kind}`);
  }
});

test('work-view: the no-artifact gate is stated in the UI copy (not only in code)', () => {
  assert.match(HTML, /work\.artifacts\.empty/);
  assert.match(I18N, /未产出不会显示为完成/);
  assert.match(I18N, /never shown as completed/i);
});
