'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');

test('cockpit renderer exposes the three-level shell entry points', () => {
  const html = read('cockpit.html');
  for (const id of ['rail', 'token', 'cockpit', 'settings', 'peek', 'panel', 'task-peek', 'onboarding']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-label="DshCockpit control center"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /data-action="quickask"/);
  assert.match(html, /data-action="tasks"/);
  assert.match(html, /data-action="cost"/);
  assert.doesNotMatch(html, /data-testid/);
});

test('Tasks opens a lightweight peek with status counts, timing, and explicit next actions', () => {
  const html = read('cockpit.html');
  for (const id of ['taskpeek-running', 'taskpeek-scheduled', 'taskpeek-completed', 'taskpeek-failed', 'taskpeek-list', 'taskpeek-new', 'taskpeek-manage']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /function renderTaskPeek\(/);
  assert.match(html, /nextRunAt/);
  assert.match(html, /lastRunAt/);
  assert.match(html, /a === 'tasks'[\s\S]*requestMode\('taskpeek'\)/);
  assert.match(html, /taskpeek-new'\)\.addEventListener\('click',[\s\S]*api\.newTask\(\)/);
  assert.match(html, /taskpeek-manage'\)\.addEventListener\('click',[\s\S]*api\.openTasks\(\)/);
});

test('onboarding keeps the real Rail visible, highlights its actual targets, and uses the owned logo', () => {
  const html = read('cockpit.html');
  assert.match(html, /function highlightOnboardingTarget\(/);
  assert.match(html, /highlightOnboardingTarget\('token'\)/);
  assert.match(html, /highlightOnboardingTarget\('cockpit'\)/);
  assert.match(html, /state\.mode === 'onboarding'/);
  assert.match(html, /classList\.add\('onboarding-highlight'\)/);
  assert.match(html, /src="assets\/cockpit-logo\.jpg"/);
  assert.match(html, /aria-label="DshCockpit logo"/);
  const asset = path.join(SRC, 'assets', 'cockpit-logo.jpg');
  assert.ok(fs.existsSync(asset), 'Cockpit logo asset must be copied into src/assets');
  assert.ok(fs.statSync(asset).size > 0, 'Cockpit logo asset must not be empty');
});

test('cockpit preload uses a narrow IPC bridge and resolves dropped files internally', () => {
  const preload = read('cockpit-preload.js');
  for (const api of ['getSnapshot', 'onSnapshot', 'completeOnboarding', 'openQuickAsk', 'openSearch', 'openControlPage', 'openTasks', 'newTask', 'openSettings', 'setLanguage', 'setWorkspaceFromFile', 'close']) assert.match(preload, new RegExp(`\\b${api}\\s*:`));
  assert.match(preload, /webUtils\.getPathForFile\(file\)/);
  assert.doesNotMatch(preload, /executeJavaScript|shell\.openPath|child_process/);
});

test('new-task center intent is allowlisted and consumed only after dirty navigation approval', () => {
  const main = read('main.js');
  const settings = read('settings.html');
  const preload = read('settings-preload.js');
  assert.match(main, /ipcMain\.handle\('cockpit:new-task'/);
  assert.match(main, /intent:\s*'new-task'/);
  assert.match(main, /center:navigate[^\n]*intent/);
  assert.match(settings, /const CENTER_INTENTS = new Set\(\['new-task'\]\)/);
  assert.match(settings, /if \(!confirmCenterExit\(\)\) return;[\s\S]*applyCenterMode\(mode, page\);[\s\S]*consumeCenterIntent\(route && route\.intent\)/);
  assert.match(settings, /function consumeCenterIntent\(intent\)[\s\S]*openAutoDialog\(/);
  assert.match(preload, /intent === 'new-task'/);
});

test('Harness preload contains no injected DshCockpit chrome', () => {
  const preload = read('preload.js');
  assert.doesNotMatch(preload, /appendChild|querySelector|querySelectorAll|document\.body|chrome:tokens|dsh-shell/);
  assert.doesNotMatch(read('main.js'), /mainWindow\.webContents\.send\('chrome:tokens'/);
  assert.doesNotMatch(read('main.js'), /chrome:|tokenWidget/);
  assert.match(read('main.js'), /parent:\s*mainWindow/);
  assert.match(read('main.js'), /cockpit:get-snapshot/);
  assert.match(read('main.js'), /cockpit:set-mode/);
  assert.match(read('main.js'), /cockpit:set-language/);
  assert.match(read('cockpit-preload.js'), /setMode:/);
});

test('Cockpit localizes rail, peek, panel, and onboarding copy with first-run language choice', () => {
  const html = read('cockpit.html');
  for (const key of ['language-picker', 'language-zh', 'language-en', 'peek-title', 'panel-title', 'input-label', 'output-label', 'cached-label', 'sessions-label', 'action-quickask']) {
    assert.match(html, new RegExp(`id="${key}"`));
  }
  assert.match(html, /const COPY = \{/);
  assert.match(html, /function applyLanguage\(language\)/);
  assert.match(html, /api\.setLanguage\(language\)/);
  assert.match(html, /shell\.language/);
});

test('quick ask and settings have explicit close affordances', () => {
  const quick = read('quickask.html');
  const settings = read('settings.html');
  assert.match(quick, /id="close"/);
  assert.match(quick, /dshQuickAsk\.close\(\)/);
  assert.match(quick, /quickask-title/);
  assert.match(quick, /title: '快速问答'/);
  assert.match(settings, /id="center-close"/);
  assert.match(settings, /id="center-return"/);
  assert.match(settings, /id="auto-dlg-close"/);
  assert.match(settings, /unsavedConfirm|Discard unsaved/);
});

test('task editing retains the dialog on save failure and guards routed navigation', () => {
  const settings = read('settings.html');
  assert.match(settings, /id="auto-dialog-status"/);
  assert.match(settings, /const dirty = centerDirty \|\| \(\$\('auto-dialog'\)\.open && auto\.dialogDirty\)/);

  const saveStart = settings.indexOf("$('auto-f-save').addEventListener");
  const saveEnd = settings.indexOf("$('auto-new').addEventListener", saveStart);
  const saveBlock = settings.slice(saveStart, saveEnd);
  assert.ok(saveBlock.indexOf('await window.dshShell.scheduledUpsert(task)') < saveBlock.indexOf("$('auto-dialog').close()"),
    'task dialog must only close after a successful save');
  assert.match(saveBlock, /setStatus\(dialogStatus,\s*tr\('saved_fail'\)/);
  for (const id of ['auto-f-name', 'auto-f-prompt', 'auto-f-kind', 'auto-f-time', 'auto-f-day', 'auto-f-every']) {
    assert.match(settings, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('(?:input|change)'`), `${id} must mark the task form dirty`);
  }
});

test('cockpit mode pushes are applied locally without echoing IPC and token polling is always active', () => {
  const cockpit = read('cockpit.html');
  const main = read('main.js');
  assert.match(cockpit, /function applyMode\(mode\)/);
  assert.match(cockpit, /function requestMode\(mode\)/);
  assert.match(cockpit, /api\.onMode\(applyMode\)/);
  assert.doesNotMatch(main, /if \(settings\.get\(\)\.tokenWidget\)\s*\{\s*setTimeout\(pollTokens/);
});

test('new Cockpit UI does not expose the legacy Harness-DOM compact action', () => {
  assert.doesNotMatch(read('cockpit.html'), /id="compact"|compactNow/);
  assert.doesNotMatch(read('cockpit-preload.js'), /compactNow|cockpit:compact-now/);
});

test('Cockpit exposes integrations and restores its rail when a center closes', () => {
  const cockpit = read('cockpit.html');
  const main = read('main.js');
  assert.match(cockpit, /data-action="plugins"[^>]*>[^<]*Integrations/);
  assert.match(main, /settingsWindow\.on\('closed',[\s\S]*?cockpitMode = returnPanel \? 'panel' : 'rail';[\s\S]*?showCockpitInactive\(\)/);
});

test('returning from the control center preserves the requested Cockpit panel mode', () => {
  const main = read('main.js');
  assert.match(main, /returnToCockpitPending/);
  assert.match(main, /const returnPanel = returnToCockpitPending;[\s\S]*?cockpitMode = returnPanel \? 'panel' : 'rail'/);
  assert.match(main, /returnToCockpitPending = true;[\s\S]*?settingsWindow\.close\(\)/);
});

test('center close and return routes honor dirty task dialogs before destroying the window', () => {
  const settings = read('settings.html');
  assert.match(settings, /function confirmCenterExit\(\)/);
  assert.match(settings, /const dirty = centerDirty \|\| \(\$\('auto-dialog'\)\.open && auto\.dialogDirty\)/);
  assert.match(settings, /center-close'\)\.addEventListener\('click', \(\) => \{ if \(confirmCenterExit\(\)\)/);
  assert.match(settings, /center-return'\)\.addEventListener\('click', \(\) => \{ if \(confirmCenterExit\(\)\)/);
});

test('Cockpit rail is a single flat draggable surface without stacked window shadows', () => {
  const cockpit = read('cockpit.html');
  const main = read('main.js');
  assert.match(cockpit, /id="drag-handle"/);
  assert.match(cockpit, /-webkit-app-region:\s*drag/);
  assert.match(cockpit, /button\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.doesNotMatch(cockpit, /box-shadow:\s*0 12px 36px|backdrop-filter/);
  assert.match(main, /hasShadow:\s*false/);
  assert.match(main, /cockpitOffset/);
  assert.match(main, /cockpitWindow\.on\('will-move'/);
});

test('Cockpit rail exposes a bordered, wide drag hit area with pointer-capture cleanup', () => {
  const cockpit = read('cockpit.html');
  assert.match(cockpit, /#rail #drag-handle\s*\{[^}]*width:\s*28px/s);
  assert.match(cockpit, /#rail\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(cockpit, /border-right:\s*1px solid var\(--border-1\)/);
  assert.match(cockpit, /setPointerCapture/);
  assert.match(cockpit, /pointercancel/);
  assert.match(cockpit, /lostpointercapture/);
  assert.match(cockpit, /is-dragging/);
});

test('startup keeps the loading surface until the real page is ready and uses packaged assets', () => {
  const main = read('main.js');
  const loading = read('loading.html');
  assert.match(main, /loadingWindow = new BrowserWindow\(\{[\s\S]*show:\s*false/);
  assert.match(main, /loadingWindow\.once\('ready-to-show',/);
  assert.match(main, /mainWindow\.once\('ready-to-show',/);
  assert.match(main, /did-fail-load/);
  assert.match(loading, /src="assets\/cockpit-logo\.jpg"/);
});

test('session-heavy startup paths use the worker and defer optional services', () => {
  const main = read('main.js');
  assert.match(main, /createSessionWorkerClient\(\)/);
  assert.match(main, /sessionWorkerClient\.collect\(/);
  assert.match(main, /scan:\s*sessionWorkerClient/);
  assert.match(main, /startDeferredServices\(\)/);
  assert.match(main, /deferredServicesStarted/);
  assert.match(main, /if \(!deferredServicesStarted\) \{ setTimeout\(startTokenPolling/);
});

test('Settings does not launch a recursive storage scan on every open', () => {
  const settings = read('settings.html');
  const start = settings.indexOf('function refreshInfo()');
  const end = settings.indexOf('async function pick(', start);
  assert.doesNotMatch(settings.slice(start, end), /storageInfo\(\)/);
  assert.match(settings, /if \(p === 'data'\)[^\n]*refreshStorageInfo/);

  const main = read('main.js');
  const scanStart = main.indexOf('async function dirSizeMBAsync');
  const scanEnd = main.indexOf('async function storageInfo', scanStart);
  assert.doesNotMatch(main.slice(scanStart, scanEnd), /recursive:\s*true/);
  assert.match(main.slice(scanStart, scanEnd), /fsp\.opendir/);
});

test('background update checks defer heavy runtime installs until the user asks', () => {
  const main = read('main.js');
  assert.match(main, /async function runUpdateCheck\(notifyUser,\s*\{\s*install\s*=\s*notifyUser/);
  assert.match(main, /runUpdateCheck\(false,\s*\{\s*install:\s*false\s*\}\)/);
  assert.match(main, /update available; install deferred/i);
});

test('runtime update progress distinguishes dependency resolution from package counts', () => {
  const main = read('main.js');
  const settings = read('settings.html');
  assert.match(main, /p\.phase === 'scripts' \? 'install scripts' : 'dependency tree'/);
  assert.doesNotMatch(main, /log\(`\[update\] installing: \$\{pkg \|\| 0\} packages/);
  assert.match(settings, /resolving dependency tree/);
});

test('application quit cancels runtime installation workers before runtime shutdown', () => {
  const main = read('main.js');
  assert.match(main, /manager\.cancelAllInstalls\(\);[\s\S]*?killRuntime\(\);/);
});

test('Cockpit snapshot construction has a short-lived cache for repeated IPC reads', () => {
  const main = read('main.js');
  assert.match(main, /let cockpitSnapshotCache\s*=\s*\{\s*at:\s*0/);
  assert.match(main, /now - cockpitSnapshotCache\.at/);
  assert.match(main, /cockpitSnapshotCache\s*=\s*\{\s*at:\s*now/);
});

test('runtime lifecycle is generation-guarded and routed through the state controller', () => {
  const main = read('main.js');
  assert.match(main, /createRuntimeStateController\(/);
  assert.match(main, /const generation = runtimeStateController\.begin\('starting'\)/);
  assert.match(main, /runtimeStateController\.transition\('healthy', generation\)/);
  assert.match(main, /runtimeStateController\.transition\('offline', generation\)/);
  assert.match(main, /runtimeStateController\.isCurrent\(generation\)/);
  assert.doesNotMatch(main, /^\s*cockpitRuntimeState\s*=\s*'(?:healthy|offline|restarting|starting)'/m);
});

test('desktop runtime disables Harness default-browser handoff', () => {
  const main = read('main.js');
  assert.match(main, /const args = \[dshBin, '--profile', 'web', '--port', String\(port\), '--no-open'\]/);
});

test('runtime consumers receive the controller state instead of inferring health from a version', () => {
  const main = read('main.js');
  assert.match(main, /runtime:\s*\{\s*state:\s*cockpitRuntimeState/);
  assert.match(main, /ipcMain\.handle\('shell:runtime-info'[\s\S]*?manager\.getInfo\(\)[\s\S]*?state:\s*cockpitRuntimeState/);
});

test('generic settings saves cannot bypass transactional Quick Ask shortcut IPC', () => {
  const main = read('main.js');
  const saveStart = main.indexOf("ipcMain.handle('shell:save-settings'");
  const saveEnd = main.indexOf("ipcMain.handle('shell:quickask-shortcut-get'");
  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.doesNotMatch(main.slice(saveStart, saveEnd), /settings\.patch\(partial/);
  assert.match(main.slice(saveStart, saveEnd), /delete\s+safePartial\.quickAskHotkey/);
  assert.match(main, /shell:quickask-shortcut-set/);
});

test('login item registration is guarded and only runs when auto-start changes', () => {
  const main = read('main.js');
  assert.match(main, /saved\.autoStart\s*!==\s*before\.autoStart/);
  assert.match(main, /process\.platform === 'darwin' && !app\.isPackaged/);
  assert.match(main, /try\s*\{\s*app\.setLoginItemSettings\(/);
  assert.match(main, /catch\s*\(err\)[\s\S]*login item/i);
});

test('cost snapshots reuse the last calculation for the same stats object', () => {
  const main = read('main.js');
  assert.match(main, /let latestCostSnapshot\s*=\s*\{\s*stats:\s*null/);
  assert.match(main, /latestCostSnapshot\.stats\s*===\s*stats/);
});

test('auxiliary Cockpit windows restore the rail after they close', () => {
  const main = read('main.js');
  assert.match(main, /quickAskWindow\.on\('closed',[\s\S]*?restoreCockpitRail\(\)/);
  assert.match(main, /searchWindow\.on\('closed',[\s\S]*?restoreCockpitRail\(\)/);
  assert.match(main, /function restoreCockpitRail\(\)/);
});

test('Quick Ask does not auto-close after a completed result merely because focus changes', () => {
  const quick = read('quickask.html');
  assert.match(quick, /let hasResult\s*=\s*false/);
  assert.match(quick, /hasResult\s*=\s*true/);
  assert.match(quick, /if \(!ta\.disabled && !hasResult\)/);
});

test('Quick Ask shutdown releases only its tracked accelerator', () => {
  const main = read('main.js');
  assert.match(main, /quickAskShortcut\.shutdown\(\)/);
  assert.doesNotMatch(main, /globalShortcut\.unregisterAll\(\)/);
});

test('Cockpit rail visibility is guarded across main-window restore and auxiliary focus', () => {
  const main = read('main.js');
  assert.match(main, /mainWindow\.on\('show',[\s\S]*?showCockpitInactive\(\)/);
  assert.match(main, /function showCockpitInactive\(\)[\s\S]*?quickAskWindow && !quickAskWindow\.isDestroyed\(\)/);
  assert.match(main, /function showCockpitInactive\(\)[\s\S]*?searchWindow && !searchWindow\.isDestroyed\(\)/);
});
