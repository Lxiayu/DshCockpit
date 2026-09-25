'use strict';

// test/office-rail.test.js — M4 直启动 (2026-09-17) → M4.2 (2026-09-17): the
// left function rail became an IN-WINDOW shell column. Source contracts for
// the rail page, its scoped preload, the shell composition in window-manager
// and the main-process IPC. The rail must stay scoped (zero powers beyond
// switching) and the shell window itself must never load page content.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('rail page is a 44px icon strip: two SVG tiles + the accent palette', () => {
  const html = read('src/office-rail.html');
  assert.match(html, /id="harness"/, 'the harness button exists');
  assert.match(html, /会话/, 'harness labelled in Chinese');
  assert.match(html, /id="office"/, 'the office button exists');
  assert.match(html, /办公室/, 'office labelled in Chinese');
  // icons are inline SVG on currentColor (emoji cannot follow the theme)
  const svgs = html.match(/<svg /g) || [];
  assert.ok(svgs.length >= 3, `inline SVG icons for both entries and the palette (${svgs.length})`);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji icons');
  // the accent palette: six swatches, persisted through the main process
  assert.match(html, /id="swatches"/, 'palette container exists');
  assert.match(html, /id="palette"/, 'palette toggle exists');
  assert.ok((html.match(/\{ id: '/g) || []).length >= 6, 'six accent choices');
  assert.match(html, /api\.setAccent\(/, 'the choice is persisted');
  // the follow-up removed the collapse control (44px is already minimal)
  assert.doesNotMatch(html, /id="collapse"/, 'no collapse control anymore');
  assert.match(html, /window\.officeRail/, 'talks through the scoped bridge only');
  assert.match(html, /Content-Security-Policy/, 'CSP declared');
  assert.doesNotMatch(html, /https?:\/\//, 'no network resources');
});

test('rail page follows the shell theme (light/dark/system) through the shell channel', () => {
  const html = read('src/office-rail.html');
  assert.match(html, /api\.getTheme\(\)/, 'the theme is pulled on load');
  assert.match(html, /api\.onTheme\(/, 'theme pushes are consumed');
  assert.match(html, /dataset\.theme = theme === 'light' \? 'light' : 'dark'/, 'the resolved theme drives html[data-theme]');
  assert.match(html, /\[data-theme="light"\]/, 'light tokens exist for the accent');
});

test('rail preload exposes only the switching surface (toggle/switch/accent/state/theme)', () => {
  const preload = read('src/office-rail-preload.js');
  for (const method of ['toggleOffice', 'switchView', 'setAccent', 'getState', 'onOfficeState', 'onViewState', 'onAccent', 'getTheme', 'onTheme']) {
    assert.match(preload, new RegExp(method), `${method} exposed`);
  }
  for (const channel of ["'office-rail:toggle-office'", "'office-rail:switch-view'", "'office-rail:set-accent'", "'office-rail:get-state'"]) {
    assert.ok(preload.includes(channel), `${channel} used`);
  }
  assert.doesNotMatch(preload, /setCollapsed/, 'the collapse surface is gone');
  // the rail never touches the office module's own channels or the harness
  assert.doesNotMatch(preload, /office:state|office:dispatch|office:settings/);
  assert.doesNotMatch(preload, /nodeIntegration|require\('fs'\)/);
});

test('window-manager composes the shell: the window loads nothing, views carry the pages', () => {
  const wm = read('src/window-manager.js');
  assert.match(wm, /WebContentsView,\s*screen/, 'WebContentsView injected as a dependency');
  assert.match(wm, /mainWindow\.contentView\.addChildView\(harnessView\)/, 'the harness page is a child view');
  assert.match(wm, /createRailView\(\)/, 'the rail view is part of the shell');
  assert.match(wm, /railView\.webContents\.loadFile\(path\.join\(__dirname, 'office-rail\.html'\)\)/, 'the rail loads its own page');
  assert.match(wm, /harnessView\.webContents\.loadURL\(url\)/, 'the harness view loads the runtime URL');
  // the shell window itself must NOT load content (no loadURL on mainWindow)
  const createBlock = wm.slice(wm.indexOf('function createWindow(url)'), wm.indexOf('function showMain()'));
  assert.doesNotMatch(createBlock, /mainWindow\.loadURL/, 'the window itself stays a pure shell');
  // geometry: rail owns a 44px left band, the main area follows, resize re-flows
  assert.match(wm, /const OFFICE_RAIL_WIDTH = 44;/, 'the strip is 44px');
  assert.match(wm, /railView\.setBounds\(\{ x: 0, y: 0, width: OFFICE_RAIL_WIDTH, height: content\.height \}\)/, 'rail pinned to the left edge at full height');
  assert.match(wm, /x: OFFICE_RAIL_WIDTH,/, 'the main area starts right of the rail');
  assert.doesNotMatch(wm, /COLLAPSED_WIDTH|setOfficeRailCollapsed/, 'the collapse mechanism is retired');
  assert.match(wm, /scheduleShellSync\(\)/, 'resize/maximize/fullscreen re-flow the shell');
  // switching keeps the office page alive in the background
  assert.match(wm, /removeChildView\(harnessView\)/, 'switching to the office detaches the harness view');
  assert.match(wm, /removeChildView\(officeShellView\)/, 'switching back detaches the office view');
  assert.match(wm, /did-first-visually-non-empty-paint/, 'the paint-ready timing moved to the harness view');
  // the M4 floating rail window is retired for good
  assert.doesNotMatch(wm, /officeRailWindow/, 'no floating rail window anymore');
  assert.doesNotMatch(wm, /new BrowserWindow\(\{\s*\.\.\.\(officeBounds/, 'the office is not an independent window anymore');
});

test('main process registers the switching IPC, the flag default and the rail state memory', () => {
  const main = read('src/main.js');
  for (const channel of ["'office-rail:toggle-office'", "'office-rail:switch-view'", "'office-rail:set-accent'", "'office-rail:get-state'"]) {
    assert.ok(main.includes(`ipcMain.handle(${channel}`), `${channel} handled in main`);
  }
  assert.match(main, /const OFFICE_RUNTIME_ENABLED = true;/, 'M4 default is ON');
  assert.match(main, /DSH_DESKTOP_OFFICE_RUNTIME !== '0'/, 'the env kill-switch exists');
  assert.match(main, /office-rail-state\.json/, 'rail state file (accent)');
  assert.match(main, /activeView: windowManager\.isOfficeViewActive\(\) \? 'office' : 'harness'/, 'the rail state reports the active view');
  assert.match(main, /broadcastToShellViews\('shell:theme', t\)/, 'the theme push reaches the shell VIEWS (never in getAllWindows)');
  assert.match(main, /\['indigo', 'sky', 'teal', 'amber', 'rose', 'slate'\]/, 'the accent is validated in the main process');
  assert.doesNotMatch(main, /office-rail:set-collapsed/, 'the collapse IPC is retired');
  assert.match(main, /showOfficeShellView\(\{/, 'opening the office means the main-area shell view');
  assert.doesNotMatch(main, /office-window-state\.json/, 'the independent office window memory is retired');
  assert.match(main, /\[office\] prewarmed pack \+ layout/, 'startup prewarm present');
  assert.match(main, /productionPackCache = result\.pack/, 'the pack loader is memoized for the prewarm');
});

// ---------------------------------------------------------------------------
// M6 P5.2 / rev2 P1-2（用户拍板）：默认视图 = office
// ---------------------------------------------------------------------------

test('办公室是启动默认视图，左栏切回会话工作台（DSH_DESKTOP_OPEN_OFFICE=0 回退）', () => {
  const src = read('src/main.js');
  assert.match(src, /if \(officeRuntimeEnabled\(\) && process\.env\.DSH_DESKTOP_OPEN_OFFICE !== '0'\) openOfficeView\(\);/,
    'boot opens the office view by default (M6 P5.2 拍板：默认视图 = office)');
  assert.doesNotMatch(src, /if \(process\.env\.DSH_DESKTOP_OPEN_OFFICE === '1'\) openOfficeView\(\);/,
    'the env-var-only call is gone — it left the flagship view behind a click');
  // 切回 harness 是真实状态变化（rail 的 switchView 落在这里）
  assert.match(read('src/window-manager.js'), /activeMainView = 'harness';/, 'the harness view is reachable from the rail');
});
