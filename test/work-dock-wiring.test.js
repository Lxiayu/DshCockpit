'use strict';

// test/work-dock-wiring.test.js — v0.7 P1.5：工作坞 + 悬停呈现的接线与边界（源级）。
//
// 这些测试钉住"看起来接上了其实没接"的东西：坞的几何、布局推送、compact 模式、
// 悬停通道的 id 白名单、办公室 docked 浮动待办、以及呈现状态参与 tick。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WM = read('src/window-manager.js');
const MAIN = read('src/main.js');
const OFFICE_HTML = read('src/office/office.html');
const OFFICE_CSS = read('src/office/office.css');
const OFFICE_PRELOAD = read('src/office/office-preload.js');
const MODULE = read('src/office/office-module.js');
const WORK_JS = read('src/work/work.js');
const WORK_HTML = read('src/work/work.html');
const WORK_IPC = read('src/work/work-ipc.js');
const I18N = read('src/i18n.js');

test('dock: a 380px shell view sits at the right edge of the office view', () => {
  assert.match(WM, /const WORK_DOCK_WIDTH = 380;/);
  assert.match(WM, /let workDockView = null;/);
  const block = WM.slice(WM.indexOf('function showWorkDock()'), WM.indexOf('function sendOfficeDockLayout('));
  assert.match(block, /preload: path\.join\(__dirname, 'work', 'work-preload\.js'\)/);
  assert.match(block, /loadFile\(path\.join\(__dirname, 'work', 'work\.html'\), \{ query: \{ compact: '1' \} \}\)/);
  // geometry: office shrinks by exactly the dock width
  assert.match(WM, /const officeWidth = dockActive \? Math\.max\(0, mainArea\.width - WORK_DOCK_WIDTH\) : mainArea\.width;/);
  assert.match(WM, /x: mainArea\.x \+ officeWidth,/);
  // both work surfaces receive the same shell:work pushes
  assert.match(WM, /function sendToWorkView\(channel, payload\) \{[\s\S]{0,200}for \(const view of \[workView, workDockView\]\)/);
  // dock mode is announced to the office page and reverted when leaving
  assert.match(WM, /webContents\.send\('shell:office-layout', \{ dock: !!dock, width: WORK_DOCK_WIDTH \}\)/);
  assert.match(WM, /showWorkDock\(\);/);
  assert.match(WM, /sendOfficeDockLayout\(false\);/);
  assert.match(WM, /workDockView = null;/);
});

test('dock: the office page collapses its own panel and only shows pending', () => {
  assert.match(OFFICE_CSS, /body\.docked #office-panel \{/);
  assert.match(OFFICE_CSS, /body\.docked\.has-pending #office-panel \{ display: flex; \}/);
  for (const block of ['#usage-block', '#employee-list-block', '#activity-block', '#details']) {
    const asGroupItem = OFFICE_CSS.includes(`body.docked #office-panel > ${block},`);
    const asLastItem = OFFICE_CSS.includes(`body.docked #office-panel > ${block} { display: none; }`);
    assert.ok(asGroupItem || asLastItem, `${block} must be hidden in docked mode`);
  }
  assert.match(OFFICE_CSS, /body\.docked #office-panel > #pending-block \{ display: block; \}/);
  assert.match(OFFICE_HTML, /document\.body\.classList\.toggle\('has-pending', summary\.count > 0\)/);
  assert.match(OFFICE_HTML, /document\.body\.classList\.toggle\('docked', docked\)/);
  assert.match(OFFICE_PRELOAD, /onDockLayout: \(listener\) =>/);
});

test('dock: compact mode is the same page with an expand action', () => {
  assert.match(WORK_JS, /document\.body\.classList\.add\('compact'\)/);
  assert.match(WORK_HTML, /id="expandWork"/);
  assert.match(WORK_JS, /act\(\{ action: 'expand' \}\)/);
  assert.match(WORK_IPC, /if \(action === 'expand'\) return \{ ok: true, action \};/);
  assert.match(MAIN, /function expandWorkView\(\)/);
  assert.match(MAIN, /windowManager\.showWorkShellView\(\)/);
  assert.match(I18N, /'work\.expand': '展开全屏'/);
  assert.match(I18N, /'work\.expand': 'Expand'/);
});

test('hover: only whitelisted employee ids reach the simulation', () => {
  assert.match(OFFICE_PRELOAD, /present: \(employeeId\) => ipcRenderer\.invoke\('shell:office-present'/);
  const block = MAIN.slice(MAIN.indexOf("ipcMain.handle('shell:office-present'"), MAIN.indexOf("ipcMain.handle('office-rail:set-accent'"));
  assert.match(block, /const \{ EMPLOYEE_IDS \} = require\('\.\/office\/office-module\.js'\)/);
  assert.match(block, /!allowed\.includes\(employeeId\)/);
  assert.match(block, /setPresenting\(\{ employeeId, presenting: true \}\)/);
  assert.match(block, /setPresenting\(\{ presenting: false \}\)/);
});

test('hover: the card is built from snapshot fields only and hit-tests the scene', () => {
  assert.match(OFFICE_HTML, /stage\.addEventListener\('pointermove'/);
  assert.match(OFFICE_HTML, /renderer\.hitTest\(point\.x, point\.y\)/);
  assert.match(OFFICE_HTML, /const row = page\.staffRows\(\)\.find\(\(entry\) => entry\.employeeId === employeeId\)/);
  for (const field of ['row.nameKey', 'row.statusLabel', 'row.toolPhrase', 'row.taskTitle', 'employee.artifacts', 'employee.record']) {
    assert.ok(OFFICE_HTML.includes(field), `card reads ${field}`);
  }
  assert.doesNotMatch(OFFICE_HTML, /mc-[a-z]+[^]*?\.prompt/, 'no prompt field');
  assert.match(OFFICE_CSS, /\.member-card \{/);
  assert.match(OFFICE_CSS, /pointer-events: none;/);
  assert.match(OFFICE_HTML, /event\.key === 'Escape' && \(hoverPinned \|\| !cardEl\.hidden\)/);
});

test('hover: presenting pauses the simulation without writing facts', () => {
  assert.match(MODULE, /presenting: false,/);
  assert.match(MODULE, /function setPresenting\(\{ employeeId = null, presenting = false \} = \{\}\)/);
  assert.match(MODULE, /if \(rec\.presenting\) continue; \/\/ 悬停呈现：不产生新的走位\/闲聊决策/);
  assert.match(MODULE, /if \(rec\.presenting\) \{ segment\.startedAtMs \+= TICK_MS; continue; \}/);
  assert.match(MODULE, /if \(rec\.presenting\) continue; \/\/ 悬停呈现：原地停下（预约续期照常，避免被抢座）/);
  assert.match(MODULE, /presenting: !!rec\.presenting,/);
  // the presenting command returns a stable code for unknown seats
  assert.match(MODULE, /return Object\.freeze\(\{ ok: false, code: 'TEAM_SEAT_UNKNOWN' \}\);/);
});
