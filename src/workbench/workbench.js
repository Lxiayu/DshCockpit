'use strict';

// src/workbench/workbench.js — the Workbench shell renderer.
//
// The shape of the window (R1): the canvas is the middle, the inspector is the right,
// the project tree and the asset palette are the left.
//
//   left    content tree (drag a file out) + 素材库 furniture tiles (drag onto the canvas)
//   center  THE STAGE — one canvas with two layers in one coordinate space:
//             edit  the layout you drag furniture into (#scene-canvas)
//             run   the product's own runtime view (#preview-frame, driven by the real
//                   office module) — no editor chrome, because the studio canvas IS the editor
//           its toolbar carries what you do TO the canvas: mode, view (fit/zoom/pan),
//           save/reload, and the run controls (play/step/restart/speed)
//   right   ONE tool at a time (grouped switcher): properties, validation and reports
//
// Everything heavy (PNG measurement, validation, gallery rendering) runs in the main
// process; this file is presentation + selection plumbing only.

(() => {
  const bridge = window.workbenchBridge;
  // The studio bridge is declared ONCE, here: any later block (hot reload, palette) may use
  // it, and a `const` declared further down would put every earlier use in the temporal dead
  // zone — the boot died with "Cannot access 'studio' before initialization" because of it.
  const studio = window.studioBridge || null;
  const statusEl = document.getElementById('wb-status');
  if (!bridge) {
    if (statusEl) statusEl.textContent = t('shell.bridgeMissing');
    return;
  }

  const setStatus = (text) => { statusEl.textContent = text || ''; };

  // ---- the bilingual dictionary: declared BEFORE the first block that speaks -----
  //
  // R2-E moved the panels' own prose into src/workbench/i18n.js, so t() is now called
  // from the very first block in this file (the problems strip renders on boot). The
  // dictionary plumbing therefore has to be initialised here, above it: a `const`
  // declared further down would put these calls in the temporal dead zone — the shell
  // would die on boot with "Cannot access 'i18n' before initialization", which is
  // exactly the failure mode the `stage` binding below is commented for.
  const SHELL_STATE_KEY = 'wb-shell-state-v1';
  const shellState = (() => {
    try {
      return {
        left: true, right: true, tab: 'tab-scene', theme: 'system', language: 'system',
        widths: { left: 268, right: 440 },
        ...JSON.parse(localStorage.getItem(SHELL_STATE_KEY) || '{}'),
      };
    } catch {
      return { left: true, right: true, tab: 'tab-scene', theme: 'system', language: 'system', widths: { left: 268, right: 440 } };
    }
  })();
  const saveShellState = () => {
    try { localStorage.setItem(SHELL_STATE_KEY, JSON.stringify(shellState)); } catch { /* private mode */ }
  };
  const themeButton = document.getElementById('btn-theme');
  const languageButton = document.getElementById('btn-lang');
  const i18n = window.wbI18n;
  const LANG_ORDER = ['system', 'zh', 'en'];

  // The dictionary lives in src/workbench/i18n.js (loaded before this script). Applying it
  // walks [data-i18n] / [data-i18n-title] / [data-i18n-placeholder], so translating the
  // chrome is one pass instead of a string hunt; JS-built strings call t() with a key.
  //
  // R2-E moved this file's panel prose into that dictionary. What deliberately stays
  // Chinese-only (each with its reason):
  //   · `app/problems.js`' own summary line (错误 N · 提醒 M) — that file is not one this
  //     task may touch; the strip's own group rendering below IS translated;
  //   · the QA finding messages (资产/几何) and the telemetry readout line — long
  //     composite sentences whose every fragment is a number, left as they were so the
  //     dictionary's key budget (studio/test/i18n.test.js: at most 1/3 unused) stays
  //     honest instead of hiding keys the contract cannot see used;
  //   · a handful of tooltips/labels in cold paths (library tile title, review-frame
  //     image title, centroid/median markers, the runaway "内容监听不可用" line);
  //   · the 观测 employee table's six <th> — pinned byte-for-byte by the boundary test;
  //   · non-prose values: the 中/EN glyph, 撤销 comparisons, the setCanvasStatus()
  //     heuristics' keywords.
  // Everything else routes through t(); zh is byte-identical to what it replaced.
  function activeLanguage() {
    return i18n ? i18n.resolveLanguage(shellState.language, typeof navigator !== 'undefined' ? navigator.language : 'zh') : 'zh';
  }
  function t(key, params = null) {
    return i18n ? i18n.t(key, activeLanguage(), params) : key;
  }

  // ---- shell state: which panes are open, which tab is active ----------------
  // The workbench is meant to be driven like a desktop workspace: both side panes
  // collapse (⌘/Ctrl+B for the tree, ⌘/Ctrl+J for the inspector) and the right rail
  // doubles as the tab switcher. The state is a UI preference, so it lives in
  // localStorage, not in content/.
  // The stage is created further down (app/stage.js), but page switching runs during boot
  // and from tab clicks, so the binding has to exist from here on. A `const stage` below
  // would put those earlier uses in the temporal dead zone — `typeof stage` throws on a TDZ
  // const, which is exactly how the passport panel stopped opening.
  let stage = null;
  // ⌘Z and the palette call this from the shell; the controller dispatches to the page
  // that owns the step (see app/history-controller.js).
  let historyStep = (direction) => ({ ok: false, code: 'HISTORY_UNAVAILABLE' });
  // gap #5: the drag ghost belongs to the scene page (it owns the canvas and the
  // transaction); the library tile and the stage's own dragleave/drop both need to
  // clear it, so the shell holds the slot and the scene page fills it.
  let hideDragGhost = () => {};

  // Undo/redo (T3) and the session store (T5). Both are pure modules (app/history.js,
  // app/store.js) with singleton instances per shell: an edit that goes through the
  // validated transaction also lands on the undo stack, and unsaved drafts survive a
  // reload through sessionStorage instead of dying with the closure.
  const history = window.wbHistory ? window.wbHistory.createHistory({ limit: 50 }) : null;
  // gap #1: the stack is shared, but the REPLAY belongs to the page that made the edit.
  // The controller keeps the registry (scene / animation / dialogue) and the top bar's
  // ↶ ↷ buttons in sync through onChange.
  const historyController = (history && window.wbHistoryController)
    ? window.wbHistoryController.createHistoryController({ history, onChange: () => refreshHistoryUi() })
    : null;
  if (historyController) {
    historyStep = async (direction) => {
      const outcome = await historyController.step(direction);
      // an empty stack is the one outcome no page restorer ever sees, so the shell
      // says so and the page that owns a status line answers (the scene page does)
      if (!outcome.ok && (outcome.code === 'HISTORY_EMPTY' || outcome.code === 'HISTORY_NO_REDO')) {
        window.dispatchEvent(new CustomEvent('wb:history-empty', { detail: { direction } }));
      }
      return outcome;
    };
    // the same handle the probe reads (window.__wbHistory.history.size()); the scene page
    // adds its own snapshot/restore helpers to it further down
    window.__wbHistory = { history, controller: historyController, historyStep };
  }
  // The top bar's two buttons are the history's own readout: ↶/↷ enabled exactly when
  // the stack can go that way, each tooltip naming the step it would perform. It reads
  // the controller, so it is correct on every page without any page having to tell it.
  function refreshHistoryUi() {
    const undoButton = document.getElementById('btn-history-undo');
    const redoButton = document.getElementById('btn-history-redo');
    if (!undoButton && !redoButton) return;
    const summary = historyController ? historyController.summary()
      : { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
    if (undoButton) {
      undoButton.disabled = !summary.canUndo;
      const title = summary.canUndo && summary.undoLabel
        ? t('history.undoTitle', { label: summary.undoLabel })
        : t('history.undoIdle');
      undoButton.title = title;
      undoButton.setAttribute('aria-label', title);
    }
    if (redoButton) {
      redoButton.disabled = !summary.canRedo;
      const title = summary.canRedo && summary.redoLabel
        ? t('history.redoTitle', { label: summary.redoLabel })
        : t('history.redoIdle');
      redoButton.title = title;
      redoButton.setAttribute('aria-label', title);
    }
  }
  const session = window.wbSessionStore ? window.wbSessionStore.createSessionStore({
    storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
    key: window.wbSessionStore.SESSION_KEY_DEFAULT,
    delayMs: 500,
  }) : null;
  window.addEventListener('pagehide', () => { try { session?.flush(); } catch { /* unloading */ } });

  // ---- the problems strip (T12): one place for every validator's findings ----------
  //
  // Grouped by code, not listed row by row: the scene validator alone produced twelve
  // identical SCENE_FURNITURE_OVERLAP rows that buried the one useful summary. A click on a
  // finding jumps to what it is about (page / tab / selected item).
  const problems = window.wbProblems ? window.wbProblems.createProblems() : null;
  {
    const body = document.getElementById('wb-problems-body');
    const summary = document.getElementById('problems-summary');
    const sources = document.getElementById('problems-sources');
    const toggle = document.getElementById('btn-problems-toggle');
    const SEV_LABEL = { red: t('problems.severity.red'), yellow: t('problems.severity.yellow'), note: t('problems.severity.note') };
    let expanded = new Set();

    const jumpTo = (target) => {
      if (!target) return false;
      if (target.page) goToPage(target.page);
      if (target.tab) activateTab(target.tab);
      if (target.itemId) window.dispatchEvent(new CustomEvent('wb:select-item', { detail: { itemId: target.itemId } }));
      return true;
    };
    const render = (payload) => {
      if (!body || !payload) return;
      if (summary) summary.textContent = problems ? problems.summaryLine() : '';
      if (sources) {
        sources.textContent = Object.entries(payload.sources).map(([name, info]) => `${name} ${info.count}`).join(' · ');
      }
      body.replaceChildren();
      if (payload.counts.total === 0) {
        const empty = document.createElement('p');
        empty.className = 'wb-hint';
        empty.textContent = t('problems.empty');
        body.appendChild(empty);
        return;
      }
      for (const group of payload.groups) {
        const row = document.createElement('div');
        row.className = 'wb-problem-group';
        row.setAttribute('role', 'listitem');
        row.dataset.groupKey = group.key;
        const sev = document.createElement('span');
        sev.className = `wb-problem-sev ${group.severity}`;
        sev.textContent = SEV_LABEL[group.severity] || group.severity;
        const code = document.createElement('span');
        code.className = 'wb-problem-code';
        code.textContent = group.code;
        const count = document.createElement('span');
        count.className = 'wb-problem-count';
        count.textContent = group.count > 1 ? `×${group.count}` : '';
        const source = document.createElement('span');
        source.className = 'wb-problem-source';
        source.textContent = group.source;
        row.append(sev, code, count, source);
        row.addEventListener('click', () => {
          if (expanded.has(group.key)) expanded.delete(group.key); else expanded.add(group.key);
          render(problems.get());
        });
        body.appendChild(row);
        if (!expanded.has(group.key)) continue;
        const details = document.createElement('div');
        details.className = 'wb-problem-details';
        for (const finding of group.findings) {
          const line = document.createElement('button');
          line.type = 'button';
          line.className = 'wb-problem-finding';
          line.textContent = finding.message || t('problems.noDetail');
          line.title = `${finding.code}${finding.target && finding.target.itemId ? ` · ${finding.target.itemId}` : ''}`;
          line.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!jumpTo(finding.target)) setStatus(t('problems.noTarget', { message: finding.message }));
          });
          details.appendChild(line);
        }
        body.appendChild(details);
      }
    };
    if (problems) problems.subscribe(render);
    toggle?.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('wb-problems-collapsed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = collapsed ? '▸' : '▾';
    });
    window.__wbProblems = { problems, render, jumpTo };
    if (problems) render(problems.get());
  }
  // READ THE LAST SESSION FIRST: the store starts empty in memory, and without restore() every
  // get() returns the defaults — which is exactly how "the draft came back" silently failed.
  const sessionRestore = (() => {
    try { return session ? session.restore() : { ok: false, code: 'STORE_UNAVAILABLE' }; } catch (error) { return { ok: false, code: 'STORE_CORRUPT', message: String(error && error.message) }; }
  })();

  const railLeft = document.getElementById('wb-rail-left');
  const railRight = document.getElementById('wb-rail-right');
  const toggleLeft = document.getElementById('btn-toggle-left');
  const toggleRight = document.getElementById('btn-toggle-right');

  function applyLanguage() {
    const language = activeLanguage();
    if (i18n) i18n.applyTranslations(document, language);
    if (languageButton) {
      languageButton.textContent = language === 'en' ? 'EN' : '中';
      languageButton.title = `${t('btn.language')}：${shellState.language}`;
      languageButton.setAttribute('aria-label', t('btn.language'));
    }
  }
  const THEME_ORDER = ['system', 'light', 'dark'];
  const THEME_LABEL = { system: t('theme.system'), light: t('theme.light'), dark: t('theme.dark') };

  function applyTheme() {
    // 'system' leaves data-theme off so the prefers-color-scheme block decides
    if (shellState.theme === 'system') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', shellState.theme);
    if (themeButton) {
      themeButton.textContent = shellState.theme === 'dark' ? '☾' : (shellState.theme === 'light' ? '☀' : '◐');
      themeButton.title = t('status.themeToggle', { theme: THEME_LABEL[shellState.theme] });
      themeButton.setAttribute('aria-label', t('status.theme', { theme: THEME_LABEL[shellState.theme] }));
    }
  }

  // ---- splitters: drag or arrow-key the two pane dividers ---------------------
  const WIDTH_LIMITS = { left: [200, 460], right: [320, 620] };
  const splitterLeft = document.getElementById('wb-splitter-left');
  const splitterRight = document.getElementById('wb-splitter-right');

  function applyWidths() {
    const widths = shellState.widths || { left: 268, right: 440 };
    document.body.style.setProperty('--wb-left-w', `${widths.left}px`);
    document.body.style.setProperty('--wb-right-w', `${widths.right}px`);
    if (splitterLeft) splitterLeft.style.left = `${widths.left}px`;
    if (splitterRight) splitterRight.style.right = `${widths.right}px`;
  }

  function setWidth(side, value, { persist = true } = {}) {
    const [min, max] = WIDTH_LIMITS[side];
    const next = Math.round(Math.min(max, Math.max(min, value)));
    shellState.widths = { ...(shellState.widths || {}), [side]: next };
    applyWidths();
    if (persist) saveShellState();
    return next;
  }

  function wireSplitter(element, side) {
    if (!element) return;
    let dragging = false;
    element.addEventListener('pointerdown', (event) => {
      dragging = true;
      element.dataset.dragging = 'true';
      try { element.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
      event.preventDefault();
    });
    element.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      setWidth(side, side === 'left' ? event.clientX : window.innerWidth - event.clientX);
    });
    element.addEventListener('pointerup', () => { dragging = false; delete element.dataset.dragging; });
    element.addEventListener('dblclick', () => setWidth(side, side === 'left' ? 268 : 440));
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 48 : 16);
      const current = (shellState.widths || {})[side] || (side === 'left' ? 268 : 440);
      // the left pane grows to the right; the right pane grows to the LEFT
      setWidth(side, side === 'left' ? current + delta : current - delta);
    });
  }
  wireSplitter(splitterLeft, 'left');
  wireSplitter(splitterRight, 'right');

  function applyShellState() {
    applyTheme();
    applyLanguage();
    applyWidths();
    document.body.classList.toggle('wb-left-collapsed', !shellState.left);
    document.body.classList.toggle('wb-right-collapsed', !shellState.right);
    railLeft.hidden = shellState.left;
    railRight.hidden = shellState.right;
    toggleLeft.setAttribute('aria-expanded', String(shellState.left));
    toggleRight.setAttribute('aria-expanded', String(shellState.right));
    for (const button of railRight.querySelectorAll('.wb-rail-tab')) {
      button.setAttribute('aria-pressed', String(button.dataset.tab === shellState.tab));
    }
  }

  function setShellState(patch) {
    Object.assign(shellState, patch);
    saveShellState();
    applyShellState();
  }

  applyShellState();
  if (themeButton) themeButton.addEventListener('click', () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(shellState.theme) + 1) % THEME_ORDER.length];
    setShellState({ theme: next });
    setStatus(t('status.theme', { theme: THEME_LABEL[next] }));
  });
  if (languageButton) languageButton.addEventListener('click', () => {
    const next = LANG_ORDER[(LANG_ORDER.indexOf(shellState.language) + 1) % LANG_ORDER.length];
    setShellState({ language: next });
    setStatus(t('status.language', {
      label: t('btn.language'),
      value: next === 'system' ? t('theme.system') : (next === 'en' ? t('status.langEn') : t('status.langZh')),
    }));
    // the history buttons' tooltips are built in JS (they name the step each button
    // would perform), so a language switch has to rebuild them — the static applier
    // has nothing to walk on these two
    refreshHistoryUi();
    // the stage's mode hint is JS-set for the same reason (it depends on the mode),
    // so the attribute-driven pass cannot reach it either
    if (stage && stage.refreshHint) stage.refreshHint();
  });
  // the top bar's ↶/↷: the same step() the palette and ⌘Z call
  document.getElementById('btn-history-undo')?.addEventListener('click', () => { historyStep('undo'); });
  document.getElementById('btn-history-redo')?.addEventListener('click', () => { historyStep('redo'); });
  refreshHistoryUi();
  toggleLeft.addEventListener('click', () => setShellState({ left: !shellState.left }));
  toggleRight.addEventListener('click', () => setShellState({ right: !shellState.right }));
  railLeft.querySelector('.wb-rail-expand').addEventListener('click', () => setShellState({ left: true }));
  for (const button of railRight.querySelectorAll('.wb-rail-expand')) button.addEventListener('click', () => setShellState({ right: true }));
  const lastTabOfPage = new Map();
  function goToPage(pageId) {
    // a page remembers which of its panels you were on (动作 has two, 质检 four)
    const tabForPage = lastTabOfPage.get(pageId) || defaultTabOfPage(pageId);
    if (tabForPage) activateTab(tabForPage);
    else setPage(pageId);
  }
  for (const button of document.querySelectorAll('#wb-activitybar .wb-page-btn')) {
    button.addEventListener('click', () => goToPage(button.dataset.page));
  }

  for (const button of railRight.querySelectorAll('.wb-rail-tab')) {
    button.addEventListener('click', () => {
      // clicking a rail icon opens the pane on that panel (and its page with it)
      setShellState({ right: true, tab: button.dataset.tab });
      activateTab(button.dataset.tab);
    });
  }
  // ---- the command palette (⌘/Ctrl+K) ----------------------------------------
  //
  // One table drives both the palette and the keyboard map, so a shortcut and its menu
  // entry cannot disagree. Every command calls the same service the panel button does.
  const palette = document.getElementById('wb-palette');
  const paletteInput = document.getElementById('wb-palette-input');
  const paletteList = document.getElementById('wb-palette-list');
  const panelRefresh = new Map();       // tab id → refresh function (registered by panels)
  let paletteSelection = 0;
  let paletteResults = [];

  function commands() {
    const list = [];
    for (const [tabId, , key] of tabs) {
      list.push({ id: `tab:${tabId}`, group: 'cmd.group.tab', label: t(`tab.${key}`), run: () => activateTab(tabId) });
    }
    for (const page of PAGES) {
      list.push({ id: `page:${page}`, group: 'cmd.group.page', label: `${t('cmd.page')}：${t(`page.${page}`)}`, run: () => goToPage(page) });
    }
    list.push({ id: 'view:problems', group: 'cmd.group.problems', label: t('cmd.problemsToggle'), run: () => document.getElementById('btn-problems-toggle').click() });
    list.push({ id: 'edit:undo', group: 'cmd.group.edit', label: t('cmd.undo'), run: () => historyStep('undo') });
    list.push({ id: 'edit:redo', group: 'cmd.group.edit', label: t('cmd.redo'), run: () => historyStep('redo') });
    list.push({ id: 'stage:fit', group: 'cmd.group.stage', label: t('cmd.stageFit'), run: () => { stage.fit(); setStatus(t('status.stageFit')); } });
    list.push({ id: 'stage:mode-edit', group: 'cmd.group.stage', label: t('cmd.stageEdit'), run: () => stage.setMode('edit') });
    list.push({ id: 'stage:mode-run', group: 'cmd.group.stage', label: t('cmd.stageRun'), run: () => stage.setMode('run') });
    list.push({ id: 'stage:reset', group: 'cmd.group.stage', label: t('cmd.stageReset'), run: () => { stage.reset(); setStatus(t('status.stageReset')); } });
    list.push({ id: 'pane:left', group: 'cmd.group.pane', label: `${t('btn.toggleLeft')}`, run: () => setShellState({ left: !shellState.left }) });
    list.push({ id: 'pane:right', group: 'cmd.group.pane', label: `${t('btn.toggleRight')}`, run: () => setShellState({ right: !shellState.right }) });
    list.push({ id: 'content:reload', group: 'cmd.group.content', label: t('cmd.reloadContent'), run: () => reloadContent() });
    list.push({ id: 'check:scene', group: 'cmd.group.check', label: t('cmd.sceneCheck'), run: async () => { activateTab('tab-scene'); const report = await studio.sceneReport({}); setStatus(t('status.sceneCheck', { red: report.stats ? report.stats.red : '?', yellow: report.stats ? report.stats.yellow : '?' })); } });
    list.push({ id: 'check:scene-sync', group: 'cmd.group.check', label: t('cmd.sceneSync'), run: async () => { const outcome = await studio.sceneSyncZones({ write: false }); setStatus(outcome.ok
          ? (outcome.exact
            ? t('status.zonesInSync')
            : t('status.zonesDrift', { added: outcome.changes.added.length, moved: outcome.changes.moved.length, removed: outcome.changes.removed.length }))
          : t('status.dryRunFailed', { code: outcome.code })); } });
    list.push({ id: 'check:gallery', group: 'cmd.group.check', label: t('cmd.gallery'), run: async () => { activateTab('tab-gallery'); const outcome = await bridge.generateGallery(); setStatus(outcome.ok ? t('status.galleryUpdated') : t('status.galleryFailed', { code: outcome.code })); const status = await bridge.galleryStatus(); if (typeof renderGalleryStatus === 'function') renderGalleryStatus(status); } });
    list.push({ id: 'check:graph', group: 'cmd.group.check', label: t('cmd.graphValidate'), run: async () => { activateTab('tab-graph'); const button = document.getElementById('btn-graph-validate'); if (button) button.click(); } });
    list.push({ id: 'check:graph-run', group: 'cmd.group.check', label: t('cmd.graphRun'), run: async () => { activateTab('tab-graph'); const button = document.getElementById('btn-graph-run'); if (button) button.click(); } });
    // T8: the graph editor's own two entries — the palette is where "加一个节点" is reachable
    // without hunting for the toolbar button, and the fit mirrors the stage's.
    list.push({ id: 'graph:add-node', group: 'cmd.group.behaviour', label: t('cmd.graphAddNode'), run: async () => { activateTab('tab-graph'); const button = document.getElementById('btn-graph-add-node'); if (button) button.click(); } });
    list.push({ id: 'graph:fit', group: 'cmd.group.behaviour', label: t('cmd.graphFit'), run: async () => { activateTab('tab-graph'); const button = document.getElementById('btn-graph-fit'); if (button) button.click(); } });
    list.push({ id: 'check:dialogue', group: 'cmd.group.check', label: t('cmd.dialogueValidate'), run: async () => { activateTab('tab-dialogue'); const outcome = await studio.dialogueValidate(); setStatus(t('status.corpusCheck', { ok: outcome.ok ? t('status.corpusCheckOk') : t('status.corpusCheckBad'), notes: outcome.findings.filter((finding) => finding.severity === 'yellow').length })); } });
    list.push({ id: 'preview:play', group: 'cmd.group.preview', label: t('cmd.previewPlay'), run: async () => { activateTab('tab-preview'); const button = document.getElementById('btn-preview-play'); if (button) button.click(); } });
    list.push({ id: 'preview:step', group: 'cmd.group.preview', label: t('cmd.previewStep'), run: async () => { activateTab('tab-preview'); const button = document.getElementById('btn-preview-step'); if (button) button.click(); } });
    list.push({ id: 'preview:restart', group: 'cmd.group.preview', label: t('cmd.previewRestart'), run: async () => { activateTab('tab-preview'); const button = document.getElementById('btn-preview-restart'); if (button) button.click(); } });
    for (const [id, scenario] of [['cmd.previewScenario.complete', 'task-complete'], ['cmd.previewScenario.failed', 'task-failed'], ['cmd.previewScenario.approval', 'approval-wait']]) {
      list.push({ id: `preview:scenario:${scenario}`, group: 'cmd.group.preview', label: `${t('cmd.previewScenario')}：${scenario}`, run: async () => { activateTab('tab-preview'); const map = { 'task-complete': 'btn-preview-scenario-complete', 'task-failed': 'btn-preview-scenario-failed', 'approval-wait': 'btn-preview-scenario-approval' }; const button = document.getElementById(map[scenario]); if (button) button.click(); } });
    }
    list.push({ id: 'data:telemetry', group: 'cmd.group.data', label: t('cmd.telemetry'), run: async () => { activateTab('tab-preview'); const button = document.getElementById('btn-preview-telemetry'); if (button) button.click(); } });
    list.push({ id: 'data:export', group: 'cmd.group.data', label: t('cmd.exportBundle'), run: async () => { activateTab('tab-preview'); const button = document.getElementById('btn-preview-export'); if (button) button.click(); } });
    // R5: the generation loop's two front doors — the palette is the keyboard path
    // into 选资产 → plan → run without touching the mouse
    list.push({ id: 'pipeline:plan', group: 'cmd.group.pipeline', label: t('cmd.pipelinePlan'), run: async () => { activateTab('tab-pipeline'); const button = document.getElementById('btn-pipeline-plan'); if (button) button.click(); } });
    list.push({ id: 'pipeline:run', group: 'cmd.group.pipeline', label: t('cmd.pipelineRun'), run: async () => { activateTab('tab-pipeline'); const button = document.getElementById('btn-pipeline-run'); if (button) button.click(); } });
    return list;
  }

  function renderPalette() {
    const needle = paletteInput.value.trim().toLowerCase();
    const all = commands();
    paletteResults = needle
      ? all.filter((command) => `${command.label} ${command.id} ${t(command.group)}`.toLowerCase().includes(needle))
      : all;
    paletteSelection = Math.min(paletteSelection, Math.max(0, paletteResults.length - 1));
    paletteList.replaceChildren();
    if (paletteResults.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'wb-palette-item disabled';
      empty.textContent = t('palette.empty');
      paletteList.appendChild(empty);
      return;
    }
    paletteResults.forEach((command, index) => {
      const item = document.createElement('li');
      item.className = 'wb-palette-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === paletteSelection));
      item.dataset.commandId = command.id;
      const label = document.createElement('span');
      label.textContent = command.label;
      const group = document.createElement('span');
      group.className = 'wb-palette-group';
      group.textContent = t(command.group);
      item.append(label, group);
      item.addEventListener('click', () => runCommand(index));
      paletteList.appendChild(item);
    });
  }

  function openPalette() {
    palette.hidden = false;
    paletteInput.value = '';
    paletteSelection = 0;
    renderPalette();
    paletteInput.focus();
  }

  function closePalette() {
    palette.hidden = true;
  }

  function runCommand(index) {
    const command = paletteResults[index];
    if (!command) return;
    closePalette();
    Promise.resolve(command.run()).catch((error) => setStatus(t('status.commandFailed', { message: String((error && error.message) || error) })));
  }

  paletteInput.addEventListener('input', () => { paletteSelection = 0; renderPalette(); });
  paletteInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); paletteSelection = Math.min(paletteResults.length - 1, paletteSelection + 1); renderPalette(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); paletteSelection = Math.max(0, paletteSelection - 1); renderPalette(); }
    else if (event.key === 'Enter') { event.preventDefault(); runCommand(paletteSelection); }
    else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  });
  palette.addEventListener('click', (event) => { if (event.target === palette) closePalette(); });

  window.addEventListener('keydown', (event) => {
    const meta = event.metaKey || event.ctrlKey;
    // Esc closes the palette even when focus sits in the page body
    if (event.key === 'Escape' && !palette.hidden) { closePalette(); return; }
    if (!meta) return;
    if (event.key === 'k' || event.key === 'p') { event.preventDefault(); palette.hidden ? openPalette() : closePalette(); return; }
    if (event.key === 'b') { event.preventDefault(); setShellState({ left: !shellState.left }); }
    if (event.key === 'j') { event.preventDefault(); setShellState({ right: !shellState.right }); }
    if (event.key === 'r') { event.preventDefault(); reloadContent(); return; }
    // ⌘/Ctrl+Z and ⇧⌘Z: the edit history. One stack for every page (scene layout,
    // action frames, corpus lines) — the controller dispatches each step to the page
    // that pushed it, and the top bar's ↶/↷ show what is available (app/history-controller.js).
    if (event.key === 'z' || event.key === 'Z') {
      // a text field's own undo wins: ⌘Z while typing in the property form (or any
      // input) is the browser's text undo, not the layout's — taking it over made a
      // half-typed coordinate silently revert the last placement
      const tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (event.target && event.target.isContentEditable)) return;
      event.preventDefault();
      historyStep(event.shiftKey ? 'redo' : 'undo');
      return;
    }
    // ⌘/Ctrl+1..0 jumps to a tab (the tenth is 0)
    if (/^[0-9]$/.test(event.key)) {
      const index = event.key === '0' ? 9 : Number(event.key) - 1;
      const entry = tabs[index];
      if (entry) { event.preventDefault(); setShellState({ right: true }); activateTab(entry[0]); }
    }
  });

  // ---- tabs ----
  // [tab id, panel id, i18n key suffix] — the key drives the chip label, the inspector
  // name and the palette entry. The ORDER is the switcher's order (and the digit
  // shortcuts'): canvas tools first, then material, behaviour, reports — so ⌘3 means the
  // same chip in the rail, in the switcher and in the palette.
  // [tab id, panel id, i18n key suffix, PAGE] — the page is the activity-bar task that owns
  // the panel. A page shows its own chips only, so the work area reads as one task at a time.
  const tabs = [
    ['tab-scene', 'panel-scene', 'scene', 'scene'],
    ['tab-preview', 'panel-preview', 'preview', 'observe'],
    ['tab-actions', 'panel-actions', 'actions', 'animation'],
    ['tab-bench', 'panel-bench', 'bench', 'animation'],
    ['tab-graph', 'panel-graph', 'graph', 'behaviour'],
    ['tab-dialogue', 'panel-dialogue', 'dialogue', 'dialogue'],
    ['tab-pipeline', 'panel-pipeline', 'pipeline', 'generation'],
    ['tab-assets', 'panel-assets', 'assets', 'quality'],
    ['tab-geometry', 'panel-geometry', 'geometry', 'quality'],
    ['tab-gallery', 'panel-gallery', 'gallery', 'quality'],
    ['tab-passport', 'panel-passport', 'passport', 'quality'],
  ];
  const PAGES = ['scene', 'animation', 'behaviour', 'dialogue', 'generation', 'quality', 'observe'];
  // The pages that own an inspector panel, and WHICH. Most panels live in the work area and
  // have nothing to inspect; 场景 owns the scene check AND the selected item's property
  // panel (T6), 行为 owns the selected graph node's field editor (T8), 语料 owns the
  // selected line's editor (T9). T11 moved the 观测 page's whole console (script / manual
  // events / the employee table / telemetry / the diagnostics bundle) into that page's
  // own work area, so 观测 now owns NO inspector panel either — the table is the page's
  // main view, not an inspector column. A page missing from this table shows the "nothing
  // to inspect" note instead of an unexplained empty column.
  const INSPECTOR_PANELS = {
    scene: ['panel-scene', 'panel-item'],
    behaviour: ['panel-item-graph'],
    dialogue: ['panel-item-dialogue'],
  };
  const pageOf = (tabId) => (tabs.find((entry) => entry[0] === tabId) || [])[3] || null;
  const defaultTabOfPage = (page) => (tabs.find((entry) => entry[3] === page) || [])[0] || null;
  // T11: the observe page's view lock on one employee. The dock is shared by every page, so
  // leaving 观测 ends the follow (a 2× view centred on an office position would fight the
  // 场景 canvas and the action bench for the same picture). The preview block assigns it —
  // and it has to be declared BEFORE the first setPage() call below, which reads it.
  let releaseFollowOnPageLeave = null;
  // ---- pages: which task the work area is showing ---------------------------------
  //
  // A page is not another tab: it decides WHAT the work area is. The canvas pages (场景 /
  // 观测) give it to the stage; the others show their own panel and the stage becomes a
  // dock. Nothing is removed from the DOM, so the running simulation survives every switch.
  function setPage(pageId, { silent = false } = {}) {
    const page = PAGES.includes(pageId) ? pageId : 'scene';
    document.body.dataset.page = page;
    for (const button of document.querySelectorAll('#wb-activitybar .wb-page-btn')) {
      button.setAttribute('aria-pressed', String(button.dataset.page === page));
    }
    for (const view of document.querySelectorAll('#wb-mainview .wb-page')) {
      view.hidden = view.dataset.pageView !== page;
    }
    // does this page have anything for the inspector? (the same table drives both)
    // 场景 owns TWO inspector panels — the validation tab (#panel-scene) and the selected
    // item's properties (#panel-item) — so the rule names both, and the property panel
    // follows the PAGE rather than the tab strip: it is not a tab, and it must not
    // survive a switch to a page whose work area has no selection to inspect.
    const ownedPanels = INSPECTOR_PANELS[page] || [];
    document.body.classList.toggle('wb-inspector-empty', ownedPanels.length === 0);
    const itemPanel = document.getElementById('panel-item');
    if (itemPanel) itemPanel.hidden = page !== 'scene';
    // T8: the behaviour page owns the selected node's field editor the same way — it is not
    // a tab, so it follows the PAGE and disappears on every page that has no selection
    const graphNodePanel = document.getElementById('panel-item-graph');
    if (graphNodePanel) graphNodePanel.hidden = page !== 'behaviour';
    // T9: and the 语料 page owns the selected line's editor the same way
    const dialogueItemPanel = document.getElementById('panel-item-dialogue');
    if (dialogueItemPanel) dialogueItemPanel.hidden = page !== 'dialogue';
    if (stage) stage.updateEmpty();
    // T11: following an employee is an 观测-page view lock, and the dock's picture belongs to
    // whichever page is looking at it — leaving the page releases the lock
    if (page !== 'observe' && releaseFollowOnPageLeave) releaseFollowOnPageLeave();
    if (!silent) setStatus(t('status.page', { page: t(`page.${page}`) }));
    return page;
  }

  function activateTab(tabId) {
    const ownerPage = pageOf(tabId);
    if (ownerPage && document.body.dataset.page !== ownerPage) setPage(ownerPage, { silent: true });
    // the panels' static chrome carries data-i18n attributes; re-applying after a switch
    // keeps a language chosen later in the session in force everywhere
    if (i18n) setTimeout(() => i18n.applyTranslations(document, activeLanguage()), 0);
    for (const [otherTab, otherPanel] of tabs) {
      const button = document.getElementById(otherTab);
      const active = otherTab === tabId;
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      document.getElementById(otherPanel).hidden = !active;
    }
    setShellState({ tab: tabId });
    const toolLabel = document.getElementById('inspector-tool');
    if (toolLabel) {
      const entry = tabs.find((candidate) => candidate[0] === tabId);
      toolLabel.textContent = entry ? t(`tab.${entry[2]}`) : '';
    }
    const railButton = document.querySelector(`.wb-rail-tab[data-tab="${tabId}"]`);
    if (railButton) for (const other of railRight.querySelectorAll('.wb-rail-tab')) other.setAttribute('aria-pressed', String(other === railButton));
  }

  for (const [tabId] of tabs) {
    const button = document.getElementById(tabId);
    button.addEventListener('click', () => activateTab(tabId));
    // ←/→ walk the tab strip when it has focus (the usual desktop tab affordance)
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = tabs.findIndex(([id]) => id === tabId);
      const next = (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      activateTab(tabs[next][0]);
      document.getElementById(tabs[next][0]).focus();
    });
  }

  // restore the remembered panel AND the page that owns it (the page decides the layout)
  setPage(pageOf(shellState.tab) || 'scene', { silent: true });
  // restore the remembered panel AND the page that owns it (the page decides the layout)
  if (pageOf(shellState.tab)) setPage(pageOf(shellState.tab), { silent: true });
  if (document.getElementById(shellState.tab)) activateTab(shellState.tab);

  // ---- hot reload: re-read content without restarting the studio ---------------
  //
  // The services read from disk per call, so a reload is "refresh what the panels show".
  // The preview runner deliberately does NOT auto-restart: a running simulation must not
  // change under the user's feet mid-observation — the status line says so instead
  // (运行预览需点「重开」才会用新内容 / 运行预览需「重开」应用).
  async function reloadContent({ silent = false } = {}) {
    const summary = await studio.reloadContent();
    if (!summary.ok) { setStatus(t('status.reloadFailed', { detail: summary.code })); return summary; }
    treeEntries = await bridge.contentTree();
    renderTree();
    const refresh = panelRefresh.get(shellState.tab);
    if (refresh) await refresh();
    if (!silent) {
      setStatus(t('status.reloaded', {
        withDocs: summary.actions.withDocs, count: summary.actions.count,
        corpus: summary.corpus.ok ? t('status.corpusCheckOk') : t('status.corpusCheckBad'),
        red: summary.scene.red, yellow: summary.scene.yellow,
      }) + (previewRunning ? t('status.reloadedNeedsRestart') : ''));
    }
    return summary;
  }
  let previewRunning = false;

  // the subscription lives on the STUDIO bridge (studio:content-changed); the shared
  // workbench bridge has no such channel, and an optional call on the wrong object would
  // swallow the event silently — which is exactly what the P8 probe caught.
  const contentChangedBridge = studio && studio.onContentChanged ? studio : bridge;
  contentChangedBridge.onContentChanged?.((payload) => {
    const names = (payload.paths || []).map((item) => item.split('/').pop()).slice(0, 3).join('、');
    setStatus(t('status.contentChanged', { count: payload.count, names: `${names}${payload.count > 3 ? '…' : ''}` }));
    reloadContent({ silent: true }).then((summary) => {
      if (summary.ok) setStatus(t('status.contentUpdated', {
        withDocs: summary.actions.withDocs, count: summary.actions.count,
        corpus: summary.corpus.ok ? 'ok' : t('status.corpusCheckBad'),
        red: summary.scene.red, yellow: summary.scene.yellow,
      }) + (previewRunning ? t('status.contentUpdatedNeedsRestart') : ''));
    }).catch((error) => setStatus(t('status.reloadFailed', { detail: error.message })));
  });
  studio.watchContent?.({}).then((outcome) => {
    if (!outcome || !outcome.ok) setStatus(`内容监听不可用：${(outcome && outcome.code) || 'unknown'}（改动后需手动「重新读取」）`);
  }).catch(() => {});

  // ---- THE STAGE (app/stage.js) ------------------------------------------------
  //
  // The canvas in the middle: one coordinate space (the scene's logical size), three layers
  // (edit / run / draft bench), the view transform and the drop routing. The module takes
  // the shell's services as arguments, so it never reaches into this file.
  stage = (window.wbStage ? window.wbStage.createStage({
    document: window.document,
    setStatus,
    activateTab,
    getLibraryRows: () => libraryRows,
    // gap #6: the stage module's own prose goes through the shell's dictionary —
    // injected, so app/stage.js stays a pure dual module
    t: (key, params) => t(key, params),
  }) : null);
  if (!stage) throw new Error('stage module missing (app/stage.js not loaded?)');

  // ---- left pane: the furniture library (a drop palette, not a list) ---------
  //
  // The catalog is the PRODUCT's (src/office/layout-assets.js through the service), so the
  // tiles you can drop are exactly the assets the runtime knows how to draw. A tile drags
  // onto the canvas and becomes a layout item — through the validated scene transaction,
  // never by writing files directly.
  const libraryRoot = document.getElementById('library-root');
  const librarySummary = document.getElementById('library-summary');
  let libraryRows = [];
  async function refreshLibrary() {
    if (!libraryRoot || !studio || !studio.sceneFurniture) {
      if (libraryRoot) libraryRoot.innerHTML = `<p class="wb-hint">${t('library.studioOnly')}</p>`;
      return { ok: false, code: 'LIBRARY_UNAVAILABLE' };
    }
    const outcome = await studio.sceneFurniture();
    if (!outcome.ok) {
      libraryRoot.innerHTML = `<p class="wb-hint">${t('library.loadFailed', { code: outcome.code })}</p>`;
      return outcome;
    }
    libraryRows = outcome.rows;
    libraryRoot.replaceChildren();
    for (const row of outcome.rows) {
      const tile = document.createElement('div');
      tile.className = 'library-tile';
      tile.draggable = true;
      tile.dataset.asset = row.asset;
      tile.title = `${row.label}\n拖到中间画布 = 放进布局（校验通过才写盘）`;
      const img = document.createElement('img');
      img.src = row.url;
      img.alt = row.label;
      img.draggable = false;
      const name = document.createElement('span');
      name.textContent = row.label;
      tile.append(img, name);
      tile.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('application/x-wb-furniture', row.asset);
        event.dataTransfer.setData('text/plain', row.asset);
        event.dataTransfer.effectAllowed = 'copy';
        // gap #5: dragover cannot read the dataTransfer back (the drag is still in
        // protected mode), so the tile tells the stage WHAT is being dragged — the
        // scene page then knows which art and which box to preview
        stage.noteFurnitureDrag(row);
        setStatus(t('library.tileDragging', { label: row.label }));
      });
      tile.addEventListener('dragend', () => {
        stage.noteFurnitureDrag(null);
        hideDragGhost();
      });
      tile.addEventListener('click', () => setStatus(t('library.tileClick', { label: row.label, asset: row.asset })));
      libraryRoot.appendChild(tile);
    }
    if (librarySummary) librarySummary.textContent = t('library.count', { n: outcome.rows.length });
    return outcome;
  }

  // ---- left pane: the content tree, IDE-style -------------------------------
  //
  // Rows behave like an editor's explorer: chevrons (and ←/→) expand and collapse,
  // ↑/↓ move the focus, Enter selects and hands the file to the inspector, typing in
  // the filter box narrows the tree, and the expansion state is remembered per
  // workspace in localStorage (a dev tool's own UI state, never content).
  const treeRoot = document.getElementById('tree-root');
  const treeFilter = document.getElementById('tree-filter');
  const treeSummary = document.getElementById('tree-summary');
  let selectedTreeFile = null;
  let treeEntries = [];
  let treeFocusPath = null;
  let treeRows = [];              // the rendered rows in visual order (for the keyboard)
  const TREE_STATE_KEY = 'wb-tree-state-v1';
  const treeState = (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(TREE_STATE_KEY) || '{}');
      return { expanded: new Set(parsed.expanded || []), filter: '' };
    } catch { return { expanded: new Set(), filter: '' }; }
  })();
  const saveTreeState = () => {
    try { localStorage.setItem(TREE_STATE_KEY, JSON.stringify({ expanded: [...treeState.expanded] })); } catch { /* private mode */ }
  };

  const FILE_ICON = (rawName) => {
    const name = typeof rawName === 'string' ? rawName : '';
    if (name.endsWith('.json')) return '⌘';
    if (name.endsWith('.png')) return '▩';
    if (name.endsWith('.md')) return '¶';
    if (name.endsWith('.webm') || name.endsWith('.mp4')) return '▶';
    return '·';
  };
  const formatSize = (bytes) => {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  // the filter keeps a file when its path matches, and every ancestor of a match
  function filterTree(entries, needle) {
    if (!needle) return entries;
    const keep = (entry) => {
      // a file either survives AS ITSELF or is dropped — returning the boolean would
      // put `true` into the tree and blow up the renderer on `entry.path.split`
      if (entry.type === 'file') return entry.path.toLowerCase().includes(needle) ? entry : null;
      const children = filterTree(entry.children || [], needle);
      if (children.length > 0) return { ...entry, children };
      return entry.path.toLowerCase().includes(needle) ? entry : null;
    };
    return entries.map(keep).filter(Boolean);
  }

  function renderTree() {
    const filtered = filterTree(treeEntries, treeState.filter);
    treeRows = [];
    treeRoot.replaceChildren();
    const walk = (entries, depth) => {
      if (!Array.isArray(entries)) {
        // a malformed node must be visible, not silent (it used to abort the render
        // halfway and leave the summary stale — the renderer console had the error)
        window.__treeError = `entries is not an array at depth ${depth}: ${JSON.stringify(entries).slice(0, 120)}`;
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.dataset.path = entry.path;
        row.dataset.type = entry.type;
        row.setAttribute('role', entry.type === 'dir' ? 'treeitem' : 'treeitem');
        const isDir = entry.type === 'dir';
        const expanded = isDir && (treeState.expanded.has(entry.path) || Boolean(treeState.filter));
        const twisty = document.createElement('span');
        twisty.className = 'tree-twisty';
        twisty.textContent = isDir ? (expanded ? '▾' : '▸') : '';
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = isDir ? '▤' : FILE_ICON(entry.path);
        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = entry.path.split('/').pop() + (isDir ? '/' : '');
        row.append(twisty, icon, name);
        if (!isDir) {
          const size = document.createElement('span');
          size.className = 'tree-size';
          size.textContent = formatSize(entry.bytes);
          row.appendChild(size);
        }
        row.style.paddingLeft = `${2 + depth * 12}px`;
        row.title = entry.path;
        if (!isDir) {
          // dragging a file out of the tree and onto the canvas (see app/stage.js)
          row.draggable = true;
          row.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData('application/x-wb-path', entry.path);
            event.dataTransfer.setData('text/plain', entry.path);
            event.dataTransfer.effectAllowed = 'copy';
            setStatus(t('tree.draggingFile', { path: entry.path }));
          });
        }
        if (!isDir && selectedTreeFile === entry.path) row.classList.add('selected');
        if (treeFocusPath === entry.path) row.classList.add('focused');
        row.addEventListener('click', () => {
          if (isDir) {
            if (treeState.expanded.has(entry.path)) treeState.expanded.delete(entry.path);
            else treeState.expanded.add(entry.path);
            saveTreeState();
          } else {
            selectedTreeFile = entry.path;
            refreshFileGeometry(entry.path);
          }
          treeFocusPath = entry.path;
          renderTree();
        });
        treeRoot.appendChild(row);
        treeRows.push({ path: entry.path, type: entry.type, expanded, entry });
        if (isDir && expanded) walk(entry.children || [], depth + 1);
      }
    };
    try {
      walk(filtered, 0);
    } catch (error) {
      window.__treeError = `${String((error && error.message) || error)} @ ${JSON.stringify({ path: (treeRows[treeRows.length - 1] || {}).path })}`;
      throw error;
    }
    const countFiles = (list) => list.reduce((sum, entry) => sum + (entry.type === 'file' ? 1 : countFiles(entry.children || [])), 0);
    const total = countFiles(treeEntries);
    const visible = countFiles(filtered);
    treeSummary.textContent = treeState.filter ? t('tree.summary', { visible, total }) : t('tree.summaryAll', { total });
    const selectedRow = treeRows.find((row) => row.path === treeFocusPath);
    if (selectedRow) treeRoot.setAttribute('aria-activedescendant', treeFocusPath);
  }

  function treeMoveFocus(delta) {
    if (treeRows.length === 0) return;
    const index = Math.max(0, treeRows.findIndex((row) => row.path === treeFocusPath));
    const next = Math.min(treeRows.length - 1, Math.max(0, index + delta));
    treeFocusPath = treeRows[next].path;
    renderTree();
  }

  treeRoot.addEventListener('keydown', (event) => {
    const current = treeRows.find((row) => row.path === treeFocusPath);
    if (!current) { treeFocusPath = treeRows[0] ? treeRows[0].path : null; renderTree(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); treeMoveFocus(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); treeMoveFocus(-1); return; }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (current.type === 'dir' && !current.expanded) { treeState.expanded.add(current.path); saveTreeState(); renderTree(); }
      else treeMoveFocus(1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (current.type === 'dir' && current.expanded) { treeState.expanded.delete(current.path); saveTreeState(); renderTree(); }
      else {
        const parent = current.path.includes('/') ? current.path.split('/').slice(0, -1).join('/') : null;
        if (parent) { treeFocusPath = parent; renderTree(); }
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (current.type === 'file') { selectedTreeFile = current.path; refreshFileGeometry(current.path); renderTree(); }
      else { if (current.expanded) treeState.expanded.delete(current.path); else treeState.expanded.add(current.path); saveTreeState(); renderTree(); }
    }
  });
  treeRoot.addEventListener('focus', () => { if (!treeFocusPath && treeRows[0]) { treeFocusPath = treeRows[0].path; renderTree(); } });

  treeFilter.addEventListener('input', () => {
    treeState.filter = treeFilter.value.trim().toLowerCase();
    renderTree();
    if (treeState.filter && treeRows[0]) treeFocusPath = treeRows[0].path;
  });
  document.getElementById('btn-tree-collapse').addEventListener('click', () => { treeState.expanded.clear(); saveTreeState(); renderTree(); });
  document.getElementById('btn-tree-expand').addEventListener('click', () => {
    const collect = (list) => { for (const entry of list) { if (entry.type === 'dir') { treeState.expanded.add(entry.path); collect(entry.children || []); } } };
    collect(treeEntries);
    saveTreeState();
    renderTree();
  });

  panelRefresh.set('tab-geometry', () => refreshGeometryReport());
  // the furniture palette is a studio-only surface (the catalog comes through the service)
  refreshLibrary().catch(() => {});
  panelRefresh.set('tab-assets', () => refreshAssetReport());

  bridge.contentTree().then((entries) => {
    treeEntries = entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'wb-empty';
      empty.textContent = t('empty.tree');
      treeRoot.replaceChildren(empty);
      treeSummary.textContent = t('tree.summaryEmpty');
      return;
    }
    // by default the first level is open, the rest is closed (an IDE's habit)
    for (const entry of entries) if (entry.type === 'dir' && treeState.expanded.size === 0) treeState.expanded.add(entry.path);
    renderTree();
  }).catch((error) => {
    treeRoot.textContent = t('tree.loadFailed', { message: error.message });
  });

  const entryBody = document.getElementById('entry-geometry-body');
  const fmt = (value) => (value === null || value === undefined ? '—' : String(value));

  function renderKv(rows) {
    const dl = document.createElement('dl');
    dl.className = 'wb-kv';
    for (const [key, value, cls] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = fmt(value);
      if (cls) dd.className = cls;
      dl.append(dt, dd);
    }
    return dl;
  }

  function renderEntryGeometry(entry) {
    entryBody.replaceChildren();
    if (!entry || entry.ok === false) {
      const p = document.createElement('p');
      p.className = 'wb-hint';
      p.textContent = entry && entry.code ? t('scene.entryFailed', { code: entry.code }) : t('scene.entryNothing');
      entryBody.appendChild(p);
      return;
    }
    const g = entry.geometry || entry;
    const drift = g.contentBboxDrift;
    entryBody.appendChild(renderKv([
      [t('kv.labelFile'), entry.file || (entry.asset && entry.asset.src) || g.absPath],
      [t('kv.labelSize'), g.width && g.height ? `${g.width}×${g.height}` : t('kv.labelUnset')],
      [t('kv.labelAnchor'), g.anchor ? `${g.anchor.x}, ${g.anchor.y}` : t('kv.labelUnset')],
      [t('kv.labelFootLine'), g.footLine],
      [t('kv.labelVisibleSize'), g.visibleWidth !== undefined ? `${g.visibleWidth} / ${g.visibleHeight}` : t('kv.labelUnset')],
      [t('kv.labelAspect'), g.aspect],
      [t('kv.labelBboxDrift'), drift ? drift.map((d) => `${d.key}:${d.delta >= 0 ? '+' : ''}${d.delta}`).join(' ') : (entry.asset && entry.asset.contentBbox ? t('kv.labelUnset') : t('kv.labelNotDeclared'))],
      [t('kv.labelState'), (g.red || (drift && drift.some((d) => Math.abs(d.delta) > 0.002))) ? t('state.labelBad') : t('state.labelOk'), (g.red || (drift && drift.some((d) => Math.abs(d.delta) > 0.002))) ? 'bad' : 'ok'],
    ]));
  }

  function refreshFileGeometry(relPath) {
    bridge.fileGeometry(relPath).then((entry) => {
      if (selectedTreeFile !== relPath) return;
      if (relPath.endsWith('.png')) {
        renderEntryGeometry({ ...entry, file: relPath });
      } else {
        entryBody.replaceChildren();
        entryBody.appendChild(renderKv([
          [t('kv.labelFile'), relPath],
          [t('kv.labelContent'), entry.json ? t('geometry.entryJson', { version: fmt(entry.json.schemaVersion), keys: (entry.json.keys || []).join(', ') }) : t('geometry.entryText')],
        ]));
      }
    }).catch((error) => setStatus(t('geometry.measureFailed', { message: error.message })));
  }

  // ---- right pane: geometry report ----
  const geometrySummary = document.getElementById('geometry-summary');
  const geometryBody = document.querySelector('#geometry-table tbody');
  const baseName = (file) => file.split('/').pop();

  function renderGeometryReport(report) {
    const medians = report.actions
      .filter((action) => action.medians)
      .map((action) => t('geometry.summaryAction', { id: action.id, foot: action.medians.footLine, height: action.medians.visibleHeight }))
      .join('｜');
    geometrySummary.textContent = t('geometry.summary', {
      medians, footPx: report.tolerance.footPx, heightPx: report.tolerance.heightPx,
      passed: report.totalFrames - report.redFrames, total: report.totalFrames,
    });
    geometryBody.replaceChildren(...report.rows.map((row) => {
      const tr = document.createElement('tr');
      tr.className = row.red ? 'red' : 'green';
      const cells = [
        t('geometry.cellFrame', { action: row.action.replace('walk-', ''), file: baseName(row.file) }),
        row.anchor ? `${row.anchor.x},${row.anchor.y}` : '—',
        row.measured.footLine ?? row.measured.code ?? '—',
        row.measured.visibleHeight ?? '—',
        row.measured.visibleWidth ?? '—',
        row.measured.aspect ?? '—',
        row.deviation.footLine === null ? '—' : `${row.deviation.footLine > 0 ? '+' : ''}${row.deviation.footLine}`,
        row.deviation.visibleHeight === null ? '—' : `${row.deviation.visibleHeight > 0 ? '+' : ''}${row.deviation.visibleHeight}`,
        row.red ? t('state.labelBad') : t('state.labelOk'),
      ];
      for (const [index, text] of cells.entries()) {
        const td = document.createElement('td');
        td.textContent = String(text);
        if (index === 8) td.className = `state ${row.red ? 'bad' : 'ok'}`;
        else if (index >= 2 && index <= 7) td.className = 'num';
        tr.appendChild(td);
      }
      return tr;
    }));
  }
  function refreshGeometryReport() {
    bridge.geometryReport().then(renderGeometryReport).catch((error) => setStatus(t('geometry.failed', { message: error.message })));
  }
  document.getElementById('btn-refresh-geometry').addEventListener('click', refreshGeometryReport);
  refreshGeometryReport();

  // preview selection → the 选中条目 block (asset geometry + draft facts)
  bridge.onPreviewSelection((data) => {
    if (!data || !data.ready || !data.item) return;
    const item = data.item;
    bridge.entryGeometry(item.asset).then((entry) => {
      entryBody.replaceChildren();
      const g = entry && entry.geometry ? entry.geometry : null;
      entryBody.appendChild(renderKv([
        [t('kv.labelDraftEntry'), `${item.id}（${item.kind} · layer ${item.layer} · scale ${item.scale}）`],
        [t('kv.labelPosition'), item.position ? `${Number(item.position.x).toFixed(3)}, ${Number(item.position.y).toFixed(3)}` : t('kv.labelUnset')],
        [t('kv.labelAsset'), entry && entry.asset ? `${entry.asset.label} · ${entry.asset.src}` : item.asset],
        [t('kv.labelSize'), g && g.width ? `${g.width}×${g.height}` : (g && g.code) || t('kv.labelUnset')],
        [t('kv.labelAnchor'), g && g.anchor ? `${g.anchor.x}, ${g.anchor.y}` : t('kv.labelUnset')],
        [t('kv.labelFootLine'), g ? g.footLine : t('kv.labelUnset')],
        [t('kv.labelVisibleSize'), g && g.visibleWidth !== undefined ? `${g.visibleWidth} / ${g.visibleHeight}` : t('kv.labelUnset')],
        [t('kv.labelAspect'), g ? g.aspect : t('kv.labelUnset')],
        [t('kv.labelBboxDrift'), g && g.contentBboxDrift ? g.contentBboxDrift.map((d) => `${d.key}:${d.delta >= 0 ? '+' : ''}${d.delta}`).join(' ') : t('kv.labelNotDeclared')],
        [t('kv.labelState'), g && g.red ? t('state.labelBad') : t('state.labelOk'), g && g.red ? 'bad' : 'ok'],
      ]));
    }).catch(() => setStatus(t('geometry.entryFailed')));
  });

  // ---- right pane: asset validator ----
  const assetSummary = document.getElementById('asset-summary');
  const assetBody = document.querySelector('#asset-table tbody');
  const mark = (ok) => (ok ? 'OK' : '✗');
  function renderAssetReport(rows) {
    const bad = rows.filter((row) => !row.ok);
    assetSummary.textContent = t('assets.summary', {
      ok: rows.length - bad.length, total: rows.length,
      bad: bad.length ? t('assets.summaryBad', { ids: bad.map((row) => row.id).join('、') }) : '',
    });
    assetBody.replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      if (!row.ok) tr.className = 'red';
      const cells = [`${row.id}（${row.kind}）`, mark(row.checks.exists), mark(row.checks.decode), mark(row.checks.alpha), mark(row.checks.path), row.checks.bbox ? 'OK' : '✗'];
      for (const [index, text] of cells.entries()) {
        const td = document.createElement('td');
        td.textContent = text;
        if (index >= 1) {
          td.className = `state ${text === 'OK' ? 'ok' : 'bad'}`;
          if (index === 5 && row.bboxDrift) td.title = row.bboxDrift.map((d) => `${d.key}:${d.delta}`).join(', ');
        }
        tr.appendChild(td);
      }
      return tr;
    }));
  }
  function refreshAssetReport() {
    bridge.assetReport().then(renderAssetReport).catch((error) => setStatus(t('assets.loadFailed', { message: error.message })));
  }
  document.getElementById('btn-refresh-assets').addEventListener('click', refreshAssetReport);
  refreshAssetReport();

  // publish validation (same kernel as scripts/workbench-publish.js)
  // The push into the problems strip is factored out of the click handler: T10's
  // "run all checks" runs the same validator through the same mapping, so both entry
  // points can never disagree about which source or which tab a finding points at.
  const publishResult = document.getElementById('publish-result');
  // the idle line comes from the dictionary: the element is JS-written, so it must not
  // carry a data-i18n that the tab-switch applier would wipe
  publishResult.textContent = t('assets.publishIdle');
  function renderPublishReport(report) {
    const findings = (report.violations || []).map((violation) => ({
      severity: 'red', code: violation.check || 'PUBLISH_INVALID',
      message: `${violation.file} ${typeof violation.detail === 'string' ? violation.detail : JSON.stringify(violation.detail)}`,
      target: { page: 'quality', tab: 'tab-assets' },
    }));
    window.__wbProblems?.problems?.set('publish', findings);
    const lines = [
      report.ok ? t('assets.publishOk') : t('assets.publishFail', { count: report.violations.length }),
      t('assets.publishScanned', { count: report.filesScanned }),
    ];
    for (const entry of report.entries) {
      lines.push(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.file} (${entry.checks.filter((c) => c.ok).length}/${entry.checks.length})`);
    }
    for (const violation of report.violations) {
      lines.push(`  [${violation.file}] ${violation.check}: ${typeof violation.detail === 'string' ? violation.detail : JSON.stringify(violation.detail)}`);
    }
    publishResult.textContent = lines.join('\n');
    return findings;
  }
  function runPublishValidation() {
    publishResult.textContent = t('assets.publishRunning');
    return bridge.publish().then(renderPublishReport).catch((error) => {
      publishResult.textContent = t('assets.publishFailed', { message: error.message });
      throw error;
    });
  }
  document.getElementById('btn-publish').addEventListener('click', () => { runPublishValidation().catch(() => {}); });

  // ---- T10: the 质检 page's ONE "run all checks" action -----------------------
  //
  // The four sub-views are read-only REPORTS over the same three local validators, so
  // the page owns one action that runs all of them: the catalog validator (资产校验),
  // the walk-frame geometry report (几何报表) and the publish validation. Each sub-view
  // keeps its own button; this one merely does the three together and pushes every
  // finding into the problems strip under a STABLE source, so the strip — not four
  // scattered tables — is where "is this quality bar met" gets answered.
  //
  // The visual baseline (视觉基线) is deliberately NOT in the list: it renders
  // screenshots and diffs pixels instead of validating, so "run all" stays fast and
  // writes nothing. It keeps its own button and its own sub-view.
  const qaRunAllButton = document.getElementById('btn-qa-run-all');
  const qaRunStatus = document.getElementById('qa-run-status');
  // One finding → the sub-view that explains it. The publish validator's findings point
  // at the sub-view whose table carries the per-entry breakdown (#panel-assets hosts it).
  const QA_TARGET = {
    assets: { page: 'quality', tab: 'tab-assets' },
    geometry: { page: 'quality', tab: 'tab-geometry' },
    publish: { page: 'quality', tab: 'tab-assets' },
  };

  function collectAssetProblems(rows) {
    return (rows || []).filter((row) => !row.ok).map((row) => {
      const failed = Object.entries(row.checks || {}).filter(([, ok]) => !ok).map(([name]) => name);
      return {
        severity: 'red',
        code: `ASSET_${failed.join('_').toUpperCase() || 'INVALID'}`,
        message: t('assets.problemMessage', {
          id: row.id, kind: row.kind,
          failed: failed.join('、') || t('assets.failedCheck'),
          src: row.src,
          drift: row.bboxDrift ? t('assets.bboxDrift', { drift: row.bboxDrift.map((d) => `${d.key}${d.delta >= 0 ? '+' : ''}${d.delta}`).join(' ') }) : '',
        }),
        target: QA_TARGET.assets,
      };
    });
  }

  function collectGeometryProblems(report) {
    const findings = [];
    for (const action of (report && report.actions) || []) {
      if (!action.missing) continue;
      findings.push({
        severity: 'red', code: 'GEOMETRY_ACTION_MISSING',
        message: `${action.id} 动作缺失——行走帧几何无从测量`,
        target: QA_TARGET.geometry,
      });
    }
    for (const row of (report && report.rows) || []) {
      if (!row.red) continue;
      const drift = row.deviation || {};
      const measured = row.measured || {};
      findings.push({
        severity: 'red', code: 'GEOMETRY_FRAME',
        message: `${row.action} ${baseName(row.file)}：鞋线 ${measured.footLine ?? '—'}（Δ${drift.footLine ?? '—'}）· 可见高 ${measured.visibleHeight ?? '—'}（Δ${drift.visibleHeight ?? '—'}）`,
        target: QA_TARGET.geometry,
      });
    }
    return findings;
  }

  async function runAllQualityChecks() {
    const steps = [
      {
        source: 'assets',
        run: async () => {
          const rows = await bridge.assetReport();
          renderAssetReport(rows);
          return collectAssetProblems(rows);
        },
      },
      {
        source: 'geometry',
        run: async () => {
          const report = await bridge.geometryReport();
          renderGeometryReport(report);
          return collectGeometryProblems(report);
        },
      },
      { source: 'publish', run: () => runPublishValidation() },
    ];
    if (qaRunAllButton) qaRunAllButton.disabled = true;
    if (qaRunStatus) { qaRunStatus.className = 'wb-note'; qaRunStatus.textContent = t('qa.run.running'); }
    const settled = await Promise.allSettled(steps.map((step) => step.run()));
    let red = 0; let yellow = 0; let note = 0; let refused = 0;
    settled.forEach((result, index) => {
      const findings = result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : [];
      if (result.status === 'rejected') refused += 1;
      // every source is set even when it is empty: a clean run REPLACES the previous
      // findings, so the strip can never show a stale red from an earlier run
      window.__wbProblems?.problems?.set(steps[index].source, findings);
      for (const finding of findings) {
        if (finding.severity === 'red') red += 1;
        else if (finding.severity === 'yellow') yellow += 1;
        else note += 1;
      }
    });
    if (qaRunAllButton) qaRunAllButton.disabled = false;
    if (qaRunStatus) {
      const clean = red + yellow + note === 0 && refused === 0;
      qaRunStatus.className = `wb-note ${clean ? 'ok' : 'bad'}`;
      qaRunStatus.textContent = refused > 0
        ? t('qa.result.refused', { refused })
        : t('qa.result', { red, yellow });
    }
    setStatus(refused > 0 ? t('qa.result.refused', { refused }) : t('qa.result', { red, yellow }));
    return { red, yellow, note, refused };
  }
  if (qaRunAllButton) qaRunAllButton.addEventListener('click', () => { runAllQualityChecks().catch(() => {}); });

  // ---- the ONE action timeline + the danger zone (T7) -------------------------
  //
  // The 动作 page used to carry TWO timelines over the same frames: the editor's
  // #action-timeline (draggable frame cards with a duration input each — the EDITOR) and
  // the bench's #bench-timeline (duration-proportional segments, playhead, note and event
  // markers — the SCRUBBER). One of them was a duplicate frame list, so the merge keeps
  // the scrubbing geometry and ADDS the editing affordances the cards had: drag a segment
  // (or ←/→ on a selected one) to REORDER, an inline duration input for the selected
  // frame, and ＋ insert positions between frames. Every write still goes through the same
  // action-op path the frame cards used (试算 → 校验 → 无变更不落盘): the renderer never
  // writes a file, and the frame order is the ARRAY order — never a filename sort.
  //
  // The node lives in the 动作 PAGE container rather than inside #panel-actions or
  // #panel-bench, so the two sub-views (编辑器 / 检查) share this one element and a chip
  // switch cannot leave a second frame axis behind.
  const actionTimeline = (() => {
    const timelineEl = document.getElementById('bench-timeline');
    const trackEl = document.getElementById('timeline-track');
    const playheadEl = document.getElementById('timeline-playhead');
    const readoutEl = document.getElementById('timeline-readout');
    const playButton = document.getElementById('btn-timeline-play');
    const speedSelect = document.getElementById('timeline-speed');
    const insertsEl = document.getElementById('timeline-inserts');
    const durationInput = document.getElementById('timeline-frame-duration');
    const frameNameEl = document.getElementById('timeline-frame-name');
    const actionLabel = document.getElementById('timeline-action');
    const stripEl = document.getElementById('bench-strip');
    let timeline = null;          // { durations, files, raw, totalMs, cycleMs, pingPong, events, notes }
    let playheadMs = 0;
    let playing = false;
    let playStartedAt = 0;
    let playStartedFrom = 0;
    let rafId = null;
    // the selected frame is tracked by FILE: an index goes stale on the very next reorder,
    // and a duration edit must still land on the frame the user pointed at
    let selectedFile = null;
    let lastFrames = [];
    let lastOptions = {};
    // the action editor registers its writers here (it owns runActionOp); the timeline
    // itself never touches a file — exactly like the frame cards it replaced
    const hooks = { move: null, duration: null, insert: null };

    const frameNameOf = (file) => String(file || '').split('/').pop();
    const offsetOf = (durations, index) => durations
      .slice(0, Math.max(0, Math.min(durations.length, Number(index) || 0)))
      .reduce((sum, value) => sum + value, 0);

    // Segments are proportional to each frame's duration (null ⇒ the pack default), event
    // frames and annotations get markers, and the model carries the RAW durations so the
    // editor can tell "unset" apart from "explicitly 1000ms".
    function timelineModelOf(frames, options = {}) {
      const defaultMs = Number(options.defaultMs) > 0 ? Number(options.defaultMs) : bridge.actionModel.DEFAULT_FRAME_DURATION_MS;
      const list = Array.isArray(frames) ? frames : [];
      const durations = list.map((frame) => {
        const value = frame && frame.durationMs;
        return value === null || value === undefined || !Number.isFinite(Number(value)) ? defaultMs : Number(value);
      });
      const totalMs = durations.reduce((sum, value) => sum + value, 0);
      const pingPong = options.pingPong === true && durations.length > 2;
      const cycleMs = pingPong ? totalMs * 2 - durations[0] - durations[durations.length - 1] : totalMs;
      return {
        actionId: options.actionId || null,
        defaultMs,
        durations,
        files: list.map((frame) => (frame && frame.file) || ''),
        raw: list.map((frame) => (frame && (frame.durationMs === undefined ? null : frame.durationMs)) || null),
        totalMs,
        cycleMs,
        pingPong,
        events: (options.events || []).map((event) => ({ ...event, ms: offsetOf(durations, event.frame) })),
        notes: (options.notes || []).filter((note) => !note.resolved).map((note) => ({ ...note, ms: offsetOf(durations, note.frame) })),
      };
    }

    // which frame index does the playhead sit on (ping-pong folds the middle backwards)
    function frameAtMs(ms) {
      if (!timeline) return 0;
      let t = timeline.cycleMs > 0 ? ((ms % timeline.cycleMs) + timeline.cycleMs) % timeline.cycleMs : 0;
      const order = timeline.pingPong
        ? [...timeline.durations.map((_, index) => index), ...timeline.durations.map((_, index) => index).slice(1, -1).reverse()]
        : timeline.durations.map((_, index) => index);
      for (const index of order) {
        if (t < timeline.durations[index]) return index;
        t -= timeline.durations[index];
      }
      return order[order.length - 1];
    }

    const selectedIndex = () => (timeline ? timeline.files.indexOf(selectedFile) : -1);

    function syncFrameEditor() {
      if (!durationInput) return;
      const index = selectedIndex();
      if (index < 0) {
        durationInput.value = '';
        durationInput.disabled = true;
        durationInput.placeholder = t('timeline.noSelection');
        if (frameNameEl) frameNameEl.textContent = '';
        return;
      }
      durationInput.disabled = false;
      durationInput.placeholder = t('timeline.durationDefault', { ms: timeline.defaultMs });
      durationInput.value = timeline.raw[index] === null || timeline.raw[index] === undefined ? '' : String(timeline.raw[index]);
      if (frameNameEl) frameNameEl.textContent = `#${index} ${frameNameOf(timeline.files[index])}`;
    }

    function renderTimeline() {
      if (!timeline) {
        trackEl.replaceChildren();
        insertsEl.replaceChildren();
        playheadEl.style.left = '0%';
        syncFrameEditor();
        return;
      }
      const current = frameAtMs(playheadMs);
      trackEl.replaceChildren();
      timeline.durations.forEach((duration, index) => {
        const segment = document.createElement('div');
        segment.className = `timeline-segment${index === current ? ' current' : ''}${timeline.files[index] === selectedFile ? ' selected' : ''}`;
        segment.style.flex = `${duration} 0 0`;
        segment.dataset.frame = String(index);
        segment.dataset.file = timeline.files[index] || '';
        segment.tabIndex = -1;
        segment.title = t('timeline.segmentTitle', { index, ms: duration });
        const label = document.createElement('span');
        label.className = 'timeline-frame-label';
        label.textContent = `#${index}${duration === timeline.defaultMs ? '' : ` ${duration}ms`}`;
        segment.appendChild(label);
        // drag to reorder: the frame cards' dragstart/drop, now on the segments
        segment.draggable = true;
        segment.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('text/plain', String(index));
          event.dataTransfer.effectAllowed = 'move';
        });
        segment.addEventListener('dragover', (event) => { event.preventDefault(); segment.classList.add('drag-over'); });
        segment.addEventListener('dragleave', () => segment.classList.remove('drag-over'));
        segment.addEventListener('drop', (event) => {
          event.preventDefault();
          segment.classList.remove('drag-over');
          const from = Number(event.dataTransfer.getData('text/plain'));
          if (Number.isInteger(from)) moveFrame(from, index);
        });
        segment.addEventListener('click', () => {
          selectedFile = segment.dataset.file || null;
          renderTimeline();
        });
        trackEl.appendChild(segment);
      });
      for (const note of timeline.notes) {
        const mark = document.createElement('span');
        mark.className = `timeline-note ${note.severity}`;
        mark.style.left = `${(note.ms / timeline.cycleMs) * 100}%`;
        mark.title = `#${note.frame} [${note.severity}] ${note.text}`;
        trackEl.appendChild(mark);
      }
      for (const event of timeline.events) {
        const mark = document.createElement('span');
        mark.className = 'timeline-event';
        mark.style.left = `${(event.ms / timeline.cycleMs) * 100}%`;
        const label = document.createElement('span');
        label.textContent = event.name;
        mark.appendChild(label);
        mark.title = `#${event.frame} ${event.name}`;
        trackEl.appendChild(mark);
      }
      // ＋ insert positions, one per boundary: the import section writes at the chosen
      // position, so the strip stays the single place to say "insert before this frame"
      insertsEl.replaceChildren();
      for (let index = 0; index <= timeline.durations.length; index += 1) {
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'timeline-insert';
        mark.textContent = '＋';
        mark.style.left = `${(offsetOf(timeline.durations, index) / Math.max(1, timeline.totalMs)) * 100}%`;
        mark.title = t('timeline.insertTitle', { n: index + 1 });
        mark.addEventListener('click', () => { if (hooks.insert) hooks.insert(index); });
        insertsEl.appendChild(mark);
      }
      const progress = timeline.cycleMs > 0 ? (playheadMs % timeline.cycleMs) / timeline.cycleMs : 0;
      playheadEl.style.left = `${progress * 100}%`;
      timelineEl.setAttribute('aria-valuemax', String(timeline.cycleMs));
      timelineEl.setAttribute('aria-valuenow', String(Math.round(playheadMs % Math.max(1, timeline.cycleMs))));
      readoutEl.textContent = `${Math.round(playheadMs % Math.max(1, timeline.cycleMs))}ms / ${timeline.cycleMs}ms`
        + t('timeline.readout.frame', { frame: frameAtMs(playheadMs) })
        + `${timeline.pingPong ? ' · ping-pong' : ''}`
        + (timeline.events.length ? t('timeline.readout.events', { events: timeline.events.map((event) => `#${event.frame}:${event.name}`).join(' ') }) : '')
        + (timeline.notes.length ? t('timeline.readout.notes', { notes: timeline.notes.length }) : '');
      // keep the frame strip in step with the playhead
      const tiles = stripEl ? stripEl.querySelectorAll('.bench-frame') : [];
      tiles.forEach((tile, index) => tile.classList.toggle('current', index === current));
      syncFrameEditor();
    }

    // 帧序＝数组序: the reorder writes through the action op (dry run → save), the same
    // path the frame cards used. The selection FOLLOWS the moved frame — moveFrame removes
    // it from `from` and re-inserts it at `to`, so the frame that moved is files[from].
    function moveFrame(from, to) {
      if (!timeline || from === to || to < 0 || to >= timeline.durations.length) return;
      selectedFile = timeline.files[from];
      if (hooks.move) hooks.move(from, to);
      renderTimeline();
    }

    function scrubTo(clientX) {
      if (!timeline) return;
      const rect = timelineEl.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      playheadMs = ratio * timeline.cycleMs;
      if (!playing) renderTimeline();
    }

    function stopPlaying() {
      playing = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      playButton.textContent = t('btn.timelinePlay');
    }

    function startPlaying() {
      if (!timeline || timeline.cycleMs === 0) return;
      playing = true;
      playButton.textContent = t('btn.timelinePause');
      playStartedAt = performance.now();
      playStartedFrom = playheadMs;
      const speed = Number(speedSelect.value) || 1;
      const step = (now) => {
        if (!playing) return;
        playheadMs = playStartedFrom + (now - playStartedAt) * speed;
        renderTimeline();
        rafId = requestAnimationFrame(step);
      };
      rafId = requestAnimationFrame(step);
    }

    function rebuild() {
      const keep = selectedFile;
      timeline = timelineModelOf(lastFrames, lastOptions);
      selectedFile = keep && timeline.files.includes(keep) ? keep : null;
      renderTimeline();
    }

    // the action editor's read feeds the model: one duration per frame, IN ARRAY ORDER
    function setFrames(frames, options = {}) {
      const previousId = lastOptions.actionId;
      const nextId = options.actionId !== undefined ? options.actionId : previousId;
      const changedAction = nextId !== previousId;
      // a different action carries different markers, so the PREVIOUS action's are dropped
      // and only what this very call carries is kept
      lastOptions = changedAction
        ? { ...options, notes: options.notes || [], events: options.events || [] }
        : { ...lastOptions, ...options };
      lastFrames = frames || [];
      if (changedAction) { stopPlaying(); playheadMs = 0; }
      if (actionLabel) actionLabel.textContent = nextId ? t('timeline.actionLabel', { id: nextId, frames: (lastFrames || []).length }) : '';
      rebuild();
    }

    // the bench read feeds the markers the editor's own read does not carry (events, notes,
    // ping-pong). An id the timeline is NOT showing is ignored rather than mixed in.
    function setMarkers(markers = {}) {
      if (markers.actionId && lastOptions.actionId && markers.actionId !== lastOptions.actionId) return;
      lastOptions = { ...lastOptions, ...markers };
      rebuild();
    }

    timelineEl.addEventListener('pointerdown', (event) => {
      stopPlaying();
      scrubTo(event.clientX);
      if (timelineEl.setPointerCapture) { try { timelineEl.setPointerCapture(event.pointerId); } catch { /* synthetic */ } }
    });
    timelineEl.addEventListener('pointermove', (event) => { if (event.buttons === 0) return; scrubTo(event.clientX); });
    timelineEl.addEventListener('keydown', (event) => {
      if (!timeline) return;
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); playing ? stopPlaying() : startPlaying(); return; }
      if (event.key === 'Escape') { selectedFile = null; renderTimeline(); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const selected = selectedIndex();
      if (selected >= 0) {
        // a selected frame: ←/→ reorder it (the cards' ←/→ buttons, same op)
        moveFrame(selected, selected + (event.key === 'ArrowRight' ? 1 : -1));
        return;
      }
      // nothing selected: ←/→ step the playhead (the scrubbing behaviour)
      const current = frameAtMs(playheadMs);
      const next = Math.min(timeline.durations.length - 1, Math.max(0, current + (event.key === 'ArrowRight' ? 1 : -1)));
      playheadMs = timeline.durations.slice(0, next).reduce((sum, value) => sum + value, 0);
      renderTimeline();
    });
    playButton.addEventListener('click', () => { playing ? stopPlaying() : startPlaying(); });
    document.getElementById('btn-timeline-step').addEventListener('click', () => {
      if (!timeline) return;
      stopPlaying();
      const next = (frameAtMs(playheadMs) + 1) % timeline.durations.length;
      playheadMs = timeline.durations.slice(0, next).reduce((sum, value) => sum + value, 0);
      renderTimeline();
    });
    document.getElementById('btn-timeline-reset').addEventListener('click', () => { stopPlaying(); playheadMs = 0; renderTimeline(); });
    speedSelect.addEventListener('change', () => { if (playing) { stopPlaying(); startPlaying(); } });
    if (durationInput) {
      durationInput.addEventListener('change', () => {
        const index = selectedIndex();
        if (index < 0 || !hooks.duration) return;
        const raw = String(durationInput.value || '').trim();
        hooks.duration(index, raw === '' ? null : Number(raw));
      });
    }

    return {
      setFrames, setMarkers,
      // the writer hooks the action editor owns; the timeline only decides WHAT changed
      onMove: (fn) => { hooks.move = fn; },
      onDuration: (fn) => { hooks.duration = fn; },
      onInsert: (fn) => { hooks.insert = fn; },
    };
  })();

  // ---- the DANGER ZONE: a two-click confirm, never a native modal ---------------
  //
  // Publishing and the v1→v2 migration write PRODUCTION bytes under resources/**. They
  // must not be one stray click away from a duration edit, so each button ARMS on the first
  // click (it then says what it is about to do) and only runs on the second one.
  // A native modal confirm dialog is deliberately NOT used: it blocks the renderer's own
  // probe and evidence path — the studio probe and the legacy launcher's M1 runs click
  // these very buttons. A button disarms itself after a few seconds, when it loses focus,
  // or when another danger button arms.
  const DANGER_ARM_MS = 5000;
  let armedDanger = null;   // { button, disarm } — at most one danger button is armed
  function wireDangerButton(button, run) {
    if (!button || typeof run !== 'function') return;
    let timer = null;
    button.dataset.idleLabel = button.textContent;
    const disarm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      button.classList.remove('armed');
      button.textContent = button.dataset.idleLabel || button.textContent;
      if (armedDanger && armedDanger.button === button) armedDanger = null;
    };
    button.addEventListener('click', async () => {
      if (armedDanger && armedDanger.button !== button) armedDanger.disarm();
      if (timer === null) {
        timer = setTimeout(disarm, DANGER_ARM_MS);
        armedDanger = { button, disarm };
        button.classList.add('armed');
        button.textContent = t('danger.confirm');
        setStatus(t('status.dangerArmed', { label: button.dataset.idleLabel }));
        return;
      }
      disarm();
      // a third click while the write is in flight is refused, not queued
      button.disabled = true;
      try { await run(); } finally { button.disabled = false; }
    });
    button.addEventListener('blur', disarm);
  }

  // ---- right pane: M1 action editor -----------------------------------------
  //
  // The session lives on disk (content/characters/whale-girl/actions/*.json):
  // every op goes through the main process (pure action-model ops + autosave
  // on changed only — 无变更不记录), so a restart resumes the draft exactly.
  // Playback pushes snapshots into the REAL preview renderer through the
  // same-origin office page API after the staged preview pack (draft order)
  // was served to its boot — the product renderer/animator stay untouched.

  const actionSelect = document.getElementById('action-select');
  const actionSummary = document.getElementById('action-summary');
  const actionLoop = document.getElementById('action-loop');
  const actionPlayback = document.getElementById('action-playback');
  const actionNewForm = document.getElementById('action-new-form');
  const actionNewId = document.getElementById('action-new-id');
  const actionNewDirection = document.getElementById('action-new-direction');
  const actionImportPath = document.getElementById('action-import-path');
  const actionImportName = document.getElementById('action-import-name');
  const actionImportResult = document.getElementById('action-import-result');
  const btnImportInsert = document.getElementById('btn-action-import-insert');
  const actionValidationBody = document.querySelector('#action-validation-table tbody');
  const actionPublishResult = document.getElementById('action-publish-result');
  renderPublishBlock(t('actions.publishIdle'));
  const fmtMs = (value) => (value === null || value === undefined ? t('actions.durationDefault') : `${value}ms`);

  let actionId = null;
  let actionFrames = [];      // [{index, file, basename, url, durationMs}]
  let actionDoc = null;       // the whole document — the undo unit for this page (gap #1)
  let actionValidation = null; // {ok, checks, rows}
  let actionDefaults = null;  // {defaultFrameDurationMs, packCanvas, packAnchor, footLine}
  let pendingImport = null;   // {sourcePath, name, index, dataUrl, metrics}
  let playback = null;        // {timer, actionId, frames, loop, defaultMs, startedAt, lastIndex}
  let stagedFor = null;       // {actionId, docStamp} — the draft pack the preview iframe booted from
  let stepIndex = 0;
  // What the problems strip knows about THIS action, in two buckets that both land under
  // the one 'actions' source: the publish validation (the panel's own table) and the
  // frame-geometry read the review bench produces. A bucket rebuilds its own half and
  // re-set()s the source, so neither one silently erases the other.
  let actionPublishProblems = [];
  let frameGeometryProblems = [];
  // The bench sub-view (studio entry) registers its reader here, so a selection in the
  // editor drives the review strip too: ONE selected action, TWO sub-views (T7).
  let benchFollow = null;

  // THE DRAFT FRAME (T2). The action editor used to reload #preview-frame — the same
  // iframe the runtime layer runs in — so playing a draft threw the running simulation's
  // page away. The draft now has its own frame (#bench-frame, ?pack=wb-staged); the
  // runtime frame is never reloaded by any code path in this file.
  function benchWindow() {
    const frame = document.getElementById('bench-frame');
    return frame && frame.contentWindow ? frame.contentWindow : null;
  }
  function previewApi() {
    const win = benchWindow();
    return win && win.__office && win.__office.ready ? win.__office.api : null;
  }

  function stopPlaybackClock() {
    if (playback && playback.timer) clearInterval(playback.timer);
    playback = null;
    actionPlayback.textContent = '';
  }

  function puppetEmployee(frameIndex) {
    const direction = actionDefaults && actionDefaults.direction ? actionDefaults.direction : 'none';
    return {
      employeeId: 'workbench-preview-puppet',
      displayName: t('bench.puppetName'),
      role: 'preview',
      presence: 'present',
      runtime: 'running',
      activity: 'working',
      movement: 'moving',
      control: '',
      sync: 'healthy',
      position: { x: 0.5, y: 0.62 },
      facing: direction === 'none' ? 'front' : direction,
      seatNodeId: null,
      binding: null,
      queueCount: 0,
      waiting: [],
      taskLabel: null,
      lastResult: null,
      marker: null,
      toolKind: null,
      animation: { resource: actionId, frameIndex, fallbackReason: null },
      presentation: null,
      transition: null,
      segment: null,
      preTaskNodeId: null,
      workstation: null,
    };
  }

  function pushPuppet(frameIndex) {
    const api = previewApi();
    if (!api) return false;
    api.applySnapshotManually({
      schemaVersion: 1,
      simulatedAtMs: 0,
      sync: 'healthy',
      scene: { referenceWidth: 1280, referenceHeight: 840 },
      employees: [puppetEmployee(frameIndex)],
      activityLog: [],
      diagnostics: [],
      capabilities: {},
    });
    return true;
  }

  function pushEmptyScene() {
    const api = previewApi();
    if (!api) return;
    api.applySnapshotManually({
      schemaVersion: 1,
      simulatedAtMs: 0,
      sync: 'healthy',
      scene: { referenceWidth: 1280, referenceHeight: 840 },
      employees: [],
      activityLog: [],
      diagnostics: [],
      capabilities: {},
    });
  }

  function reloadPreviewForDraft() {
    return new Promise((resolve) => {
      // deliberately #bench-frame: see the note above previewApi()
      const frame = document.getElementById('bench-frame');
      const win = frame.contentWindow;
      if (!win) return resolve(false);
      const deadline = Date.now() + 30000;
      win.location.reload();
      const poll = setInterval(() => {
        const api = previewApi();
        if (api) {
          clearInterval(poll);
          resolve(true);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          resolve(false);
        }
      }, 200);
    });
  }

  // The draft must be staged AND the preview reloaded whenever the doc changed
  // since the current staged boot (staging writes the draft pack the preview
  // boots from — production bytes are never touched by playback).
  async function ensureDraftPreview(docStamp) {
    const staged = await bridge.actionStage(actionId);
    if (!staged.ok) {
      renderPublishBlock(t('actions.stageRefused', { violations: (staged.violations || []).map(formatViolation).join('\n') }));
      return null;
    }
    if (!stagedFor || stagedFor.actionId !== actionId || stagedFor.docStamp !== docStamp) {
      const ready = await reloadPreviewForDraft();
      if (!ready) {
        setStatus(t('actions.stageNotReady'));
        return null;
      }
      stagedFor = { actionId, docStamp };
    }
    return staged;
  }

  function framesWithDurations(frames) {
    const defaultMs = (actionDefaults && actionDefaults.defaultFrameDurationMs) || bridge.actionModel.DEFAULT_FRAME_DURATION_MS;
    return frames.map((frame) => ({ durationMs: frame.durationMs === null || frame.durationMs === undefined ? defaultMs : frame.durationMs }));
  }

  document.getElementById('btn-action-play').addEventListener('click', async () => {
    if (!actionId) return;
    const docStamp = JSON.stringify(actionFrames.map((frame) => [frame.file, frame.durationMs])) + String(actionLoop.checked);
    const staged = await ensureDraftPreview(docStamp);
    if (!staged) return;
    stage.setMode('bench', { silent: true });
    stopPlaybackClock();
    const frames = framesWithDurations(actionFrames);
    playback = {
      timer: null,
      actionId,
      frames,
      loop: staged.loop,
      defaultMs: staged.defaultFrameDurationMs,
      startedAt: Date.now(),
      lastIndex: -1,
    };
    playback.timer = setInterval(() => {
      const { frameIndex } = bridge.actionModel.frameIndexAt(playback.frames, Date.now() - playback.startedAt, playback.loop, playback.defaultMs);
      if (frameIndex !== playback.lastIndex && pushPuppet(frameIndex)) {
        playback.lastIndex = frameIndex;
        actionPlayback.textContent = t('actions.playbackPlaying', { frame: frameIndex + 1, total: playback.frames.length });
      }
    }, 80);
  });

  document.getElementById('btn-action-step').addEventListener('click', async () => {
    if (!actionId || actionFrames.length === 0) return;
    const docStamp = JSON.stringify(actionFrames.map((frame) => [frame.file, frame.durationMs])) + String(actionLoop.checked);
    const staged = await ensureDraftPreview(docStamp);
    if (!staged) return;
    stage.setMode('bench', { silent: true });
    stopPlaybackClock();
    const count = actionFrames.length;
    stepIndex = (stepIndex + 1) % count;
    if (pushPuppet(stepIndex)) actionPlayback.textContent = t('actions.playbackStep', { frame: stepIndex + 1, total: count });
  });

  document.getElementById('btn-action-stop').addEventListener('click', () => {
    stopPlaybackClock();
    stepIndex = 0;
    pushEmptyScene();
    actionPlayback.textContent = t('actions.playbackStopped');
  });

  actionLoop.addEventListener('change', async () => {
    if (!actionId) return;
    await runActionOp('loop', { value: actionLoop.checked });
  });

  // ---- the page's ONE timeline, driven by the editor's own read ----------------
  //
  // The frame cards used to live here (#action-timeline): a second render of the same
  // frames, next to a timeline that already showed them. The axis is now the single
  // #bench-timeline at the top of the 动作 page, and this section only tells it WHAT
  // changed (which frames, in array order) and owns the writes — every op still runs
  // through the validated action-op path below (试算 → 校验 → 无变更不落盘), and the frame
  // order is the ARRAY order, never a filename sort.
  function basename(file) {
    return file.split('/').pop();
  }

  // Write-only: the timeline decides WHAT changed, this file decides it goes through the
  // action op (which returns the whole new state and re-renders).
  actionTimeline.onMove((from, to) => runActionOp('move', { from, to }));
  actionTimeline.onDuration((index, value) => runActionOp('duration', { index, value }));
  actionTimeline.onInsert((index) => {
    // the ＋ markers under the timeline pick WHERE an imported frame lands
    pendingImport = pendingImport && pendingImport.dataUrl ? { ...pendingImport, index } : null;
    actionImportName.placeholder = t('actions.insertPositionLabel', { n: index + 1 });
    actionImportResult.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'wb-hint';
    hint.textContent = pendingImport ? t('actions.insertHintUpdated') : t('actions.insertPositionHint', { n: index + 1 });
    actionImportResult.appendChild(hint);
  });

  // The publish validation and the frame-geometry findings are two halves of ONE source in
  // the problems strip: each push re-set()s 'actions' with both halves, so the strip is a
  // summary next to the panel's own table (which stays).
  function pushActionProblems() {
    window.__wbProblems?.problems?.set('actions', [...actionPublishProblems, ...frameGeometryProblems]);
  }

  function collectActionProblems(validation) {
    actionPublishProblems = [
      ...((validation && validation.checks) || [])
        .filter((check) => !check.ok)
        .map((check) => ({
          severity: 'red', code: check.check,
          message: `${actionId} ${typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}`,
          target: { page: 'animation', tab: 'tab-actions' },
        })),
      ...((validation && validation.rows) || [])
        .filter((row) => row.red)
        .map((row) => ({
          severity: 'red', code: row.code || 'geometry.frame',
          message: t('actions.frameGeometry', {
            index: row.index + 1, file: row.file,
            foot: row.footLine === null ? '—' : row.footLine, dFoot: row.dFoot,
            height: row.visibleHeight === null ? '—' : row.visibleHeight, dHeight: row.dHeight,
          }),
          target: { page: 'animation', tab: 'tab-actions' },
        })),
    ];
  }

  function renderValidationTable() {
    const rows = (actionValidation && actionValidation.rows) || [];
    actionValidationBody.replaceChildren(...rows.map((row) => {
      const tr = document.createElement('tr');
      tr.className = row.red ? 'red' : 'green';
      const cells = [
        `#${row.index + 1}`,
        basename(row.file || ''),
        row.footLine === null ? '—' : String(row.footLine),
        row.dFoot === null ? '—' : `${row.dFoot > 0 ? '+' : ''}${row.dFoot}`,
        row.visibleHeight === null ? '—' : String(row.visibleHeight),
        row.dHeight === null ? '—' : `${row.dHeight > 0 ? '+' : ''}${row.dHeight}`,
        fmtMs(actionFrames[row.index] ? actionFrames[row.index].durationMs : null),
        row.red ? (row.code ? t('state.labelCode', { code: row.code }) : t('state.labelBad')) : t('state.labelOk'),
      ];
      for (const [index, text] of cells.entries()) {
        const td = document.createElement('td');
        td.textContent = String(text);
        if (index === 7) td.className = `state ${row.red ? 'bad' : 'ok'}`;
        else if (index >= 2 && index <= 5) td.className = 'num';
        tr.appendChild(td);
      }
      return tr;
    }));
  }

  function renderActionSummary() {
    const total = actionFrames.reduce((sum, frame) => sum + (frame.durationMs === null || frame.durationMs === undefined ? (actionDefaults ? actionDefaults.defaultFrameDurationMs : 1000) : frame.durationMs), 0);
    const redCount = actionValidation ? actionValidation.rows.filter((row) => row.red).length : 0;
    actionSummary.textContent = t('actions.summary', {
      id: actionId, frames: actionFrames.length, loop: actionLoop.checked ? t('actions.summaryLoopOn') : t('actions.summaryLoopOff'),
      total,
      verdict: actionValidation && actionValidation.ok ? t('actions.summaryGreen') : t('actions.summaryRed', { red: redCount }),
    });
  }

  function applyActionState(payload) {
    actionFrames = payload.frames || [];
    actionValidation = payload.validation || null;
    actionDefaults = payload.defaults || actionDefaults;
    // gap #1: the WHOLE document is the undo unit for this page — the frame ops write it
    // to disk one edit at a time, so the snapshot the history stack replays is the doc
    // itself (restored through the action op's own restore, never around it)
    actionDoc = payload.doc ? JSON.parse(JSON.stringify(payload.doc)) : null;
    actionLoop.checked = Boolean(payload.doc && payload.doc.loop);
    collectActionProblems(actionValidation);
    pushActionProblems();
    // the timeline is fed from THIS read (array order, pack default) and the writes come
    // back through the same op that produced this payload
    actionTimeline.setFrames(actionFrames, {
      actionId,
      defaultMs: actionDefaults ? actionDefaults.defaultFrameDurationMs : undefined,
      pingPong: Boolean(payload.doc && payload.doc.pingPong),
      events: (payload.doc && payload.doc.events) || [],
    });
    renderValidationTable();
    renderActionSummary();
  }

  // the label a history step carries, per op — the top bar's tooltip names the step
  const ACTION_HISTORY_LABELS = {
    move: () => t('actions.historyMove'),
    duration: () => t('actions.historyDuration'),
    insert: () => t('actions.historyInsert'),
    remove: () => t('actions.historyRemove'),
    loop: () => t('actions.historyLoop'),
  };

  async function runActionOp(op, payload) {
    if (!actionId) return;
    // before/after are WHOLE-document snapshots: the op autosaves to disk, so the undo
    // entry has to be able to put the document back exactly as it stood
    const before = actionDoc ? JSON.parse(JSON.stringify(actionDoc)) : null;
    try {
      const outcome = await bridge.actionOp(actionId, op, payload);
      if (!outcome.ok) {
        setStatus(t('actions.opRefused', { message: outcome.message || outcome.code }));
        return;
      }
      applyActionState(outcome);
      if (!outcome.changed) { setStatus(t('actions.opNoChange')); return; }
      if (before && actionDoc && historyController) {
        historyController.push({
          label: (ACTION_HISTORY_LABELS[op] || (() => t('actions.historyEdit')))(),
          before,
          after: JSON.parse(JSON.stringify(actionDoc)),
          meta: { page: 'animation', actionId },
        });
      }
    } catch (error) {
      setStatus(t('actions.opFailed', { message: error.message }));
    }
  }

  // gap #1: the 动作 page's replay. The action ops autosave, so an undo is a WRITE too —
  // it goes through bridge.actionOp's restore op (the same writer + the model's own
  // parseActionDoc validation, see services.js), never a file copy.
  historyController?.register('animation', async (entry, direction) => {
    const target = direction === 'undo' ? entry.before : entry.after;
    const outcome = await bridge.actionOp(entry.meta.actionId, 'restore', { doc: target });
    if (!outcome.ok) {
      setStatus(t('actions.restoreRefused', { code: outcome.code, message: outcome.message || '' }));
      return outcome;
    }
    if (entry.meta.actionId === actionId) applyActionState(outcome);
    setStatus(t('actions.restored', {
      id: entry.meta.actionId,
      way: direction === 'undo' ? t('scene.historyLabelUndo') : t('scene.historyLabelRedo'),
    }));
    return outcome;
  });

  async function readAction(nextActionId) {
    actionId = nextActionId;
    const payload = await bridge.actionRead(actionId);
    if (!payload.ok) {
      setStatus(t('actions.loadFailed', { message: payload.message || payload.code }));
      return;
    }
    applyActionState(payload);
    actionImportResult.replaceChildren();
    pendingImport = null;
    btnImportInsert.disabled = true;
  }

  async function refreshActionList(preferred) {
    const list = await bridge.actionList();
    actionSelect.replaceChildren(...list.actions.map((entry) => {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = t('actions.optionLabel', { id: entry.id, frames: entry.frames.length });
      return option;
    }));
    const target = preferred && list.actions.some((entry) => entry.id === preferred) ? preferred : (list.actions[0] && list.actions[0].id);
    if (target) {
      actionSelect.value = target;
      await readAction(target);
      // the review sub-view follows the editor's selection: ONE selected action on the
      // 动作 page, so the shared timeline always shows the frames you are looking at
      if (benchFollow) { try { await benchFollow(target); } catch { /* the bench panel reports its own failures */ } }
    }
  }

  actionSelect.addEventListener('change', () => {
    stopPlaybackClock();
    pushEmptyScene();
    refreshActionList(actionSelect.value).catch((error) => setStatus(t('actions.panelLoadFailed', { message: error.message })));
  });

  document.getElementById('btn-action-new').addEventListener('click', () => {
    actionNewForm.hidden = !actionNewForm.hidden;
  });
  document.getElementById('btn-action-cancel-new').addEventListener('click', () => {
    actionNewForm.hidden = true;
  });
  document.getElementById('btn-action-create').addEventListener('click', async () => {
    const id = actionNewId.value.trim();
    try {
      const outcome = await bridge.actionNew(id, actionNewDirection.value);
      if (!outcome.ok) {
        setStatus(t('actions.newRefused', { details: (outcome.violations || [{ detail: outcome.message || outcome.code }]).map((entry) => entry.detail).join('；') }));
        return;
      }
      actionNewForm.hidden = true;
      actionNewId.value = '';
      await refreshActionList(id);
      setStatus(t('actions.created', { id }));
    } catch (error) {
      setStatus(t('actions.newFailed', { message: error.message }));
    }
  });

  // ---- import (normalize → preview → insert) ----

  function formatViolation(entry) {
    const detail = typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail);
    return `[${entry.file || entry.check}] ${entry.check}: ${detail}`;
  }

  document.getElementById('btn-action-import-preview').addEventListener('click', async () => {
    const sourcePath = actionImportPath.value.trim();
    if (!sourcePath || !actionId) {
      setStatus(t('actions.needSourcePath'));
      return;
    }
    actionImportResult.replaceChildren();
    let outcome;
    try {
      outcome = await bridge.actionImportPreview(actionId, sourcePath);
    } catch (error) {
      outcome = { ok: false, violations: [{ check: 'import', detail: error.message }] };
    }
    const title = document.createElement('p');
    actionImportResult.appendChild(title);
    if (!outcome.ok) {
      title.className = 'bad';
      title.textContent = t('actions.normaliseRefusedTitle');
      for (const violation of outcome.violations || []) {
        const line = document.createElement('p');
        line.className = 'bad';
        line.textContent = `✗ ${violation.check}: ${typeof violation.detail === 'string' ? violation.detail : JSON.stringify(violation.detail)}`;
        actionImportResult.appendChild(line);
      }
      pendingImport = null;
      btnImportInsert.disabled = true;
      return;
    }
    title.className = 'ok';
    title.textContent = t('actions.normaliseOkTitle');
    pendingImport = { sourcePath, name: outcome.name, index: null, dataUrl: outcome.dataUrl, metrics: outcome.metrics };
    btnImportInsert.disabled = false;
    if (!actionImportName.value.trim()) actionImportName.value = outcome.name;
    const row = document.createElement('div');
    row.className = 'import-row';
    const img = document.createElement('img');
    img.src = outcome.dataUrl;
    img.alt = 'normalized preview';
    const dl = document.createElement('dl');
    dl.className = 'import-kv';
    for (const [key, value, cls] of [
      [t('actions.importLabelSource'), sourcePath],
      [t('actions.importLabelTarget'), outcome.name],
      [t('actions.importLabelPosition'), pendingImport.index === null
        ? t('actions.importPositionEnd')
        : t('actions.importPositionAt', { n: pendingImport.index + 1 })],
      [t('actions.importLabelFootLine'), `${outcome.metrics.footLine}（Δ ${outcome.metrics.footLine - actionDefaults.footLine >= 0 ? '+' : ''}${outcome.metrics.footLine - actionDefaults.footLine}px 对 ${actionDefaults.footLine}）`],
      [t('actions.importLabelVisibleHeight'), outcome.metrics.visibleHeight],
      [t('actions.importLabelScale'), outcome.metrics.scale.toFixed(4)],
      [t('actions.importLabelTranslation'), `dx ${outcome.metrics.translation.dx}, dy ${outcome.metrics.translation.dy}`],
      [t('actions.importLabelState'), t('actions.importStateReady'), 'ok'],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = String(value);
      if (cls) dd.className = cls;
      dl.append(dt, dd);
    }
    row.append(img, dl);
    actionImportResult.appendChild(row);
  });

  btnImportInsert.addEventListener('click', async () => {
    if (!pendingImport || !actionId) return;
    const name = actionImportName.value.trim() || pendingImport.name;
    // an insert is an edit like a timeline move: the whole-document snapshot opens
    // before the write and commits after the re-read (gap #1)
    const importBefore = actionDoc ? JSON.parse(JSON.stringify(actionDoc)) : null;
    try {
      const outcome = await bridge.actionImportInsert(actionId, pendingImport.sourcePath, name, pendingImport.index);
      if (!outcome.ok) {
        actionImportResult.replaceChildren();
        const title = document.createElement('p');
        title.className = 'bad';
        title.textContent = t('actions.insertRefusedTitle');
        actionImportResult.appendChild(title);
        for (const violation of outcome.violations || []) {
          const line = document.createElement('p');
          line.className = 'bad';
          line.textContent = `✗ ${formatViolation(violation)}`;
          actionImportResult.appendChild(line);
        }
        return;
      }
      setStatus(t('actions.inserted', { file: outcome.file }));
      await readAction(actionId);
      if (importBefore && actionDoc && historyController) {
        historyController.push({
          label: t('actions.historyImport'),
          before: importBefore,
          after: JSON.parse(JSON.stringify(actionDoc)),
          meta: { page: 'animation', actionId },
        });
      }
    } catch (error) {
      setStatus(t('actions.insertFailed', { message: error.message }));
    }
  });

  document.getElementById('btn-action-validate').addEventListener('click', () => readAction(actionId));

  function renderPublishBlock(text) {
    actionPublishResult.textContent = text;
  }

  // 发布到 resources/** — a PRODUCTION write, so it lives in the danger zone behind a
  // two-click confirm (wireDangerButton above)
  async function publishSelectedAction() {
    if (!actionId) return;
    renderPublishBlock(t('actions.publishing'));
    let outcome;
    try {
      outcome = await bridge.actionPublish(actionId);
    } catch (error) {
      renderPublishBlock(t('actions.publishFailed', { message: error.message }));
      return;
    }
    if (!outcome.ok) {
      const lines = [t('actions.publishRefusedTitle')];
      for (const violation of outcome.violations || []) lines.push(`  ✗ ${formatViolation(violation)}`);
      if (outcome.rolledBack) lines.push(t('actions.publishRolledBack'));
      renderPublishBlock(lines.join('\n'));
      setStatus(t('actions.publishRefused', { count: (outcome.violations || []).length }));
      return;
    }
    if (outcome.noop) {
      renderPublishBlock(t('actions.publishNoop'));
      setStatus(t('actions.publishNoopStatus'));
      return;
    }
    const summary = outcome.summary;
    const lines = [
      t('actions.published'),
      t('actions.publishBackup', { dir: summary.backupDir }),
      t('actions.publishProvenance', { path: summary.provenancePath }),
      t('actions.publishChanges', { changes: summary.changes.join('；') }),
      t('actions.publishWritten', {
        files: summary.rewritten.join(', '),
        added: summary.added.length ? t('actions.publishAdded', { files: summary.added.join(', ') }) : '',
      }),
    ];
    renderPublishBlock(lines.join('\n'));
    setStatus(t('actions.publishDone', { dir: summary.backupDirRelative }));
    refreshGeometryReport();
    bridge.contentTree().catch(() => {});
  }

  wireDangerButton(document.getElementById('btn-action-publish'), publishSelectedAction);

  refreshActionList(new URLSearchParams(window.location.search).get('action')).catch((error) => {
    setStatus(t('actions.panelLoadFailed', { message: error.message }));
  });

  // ---- right pane: golden gallery ----
  const galleryProgress = document.getElementById('gallery-progress');
  const galleryDiff = document.getElementById('gallery-diff');
  const galleryFiles = document.getElementById('gallery-files');
  const galleryButton = document.getElementById('btn-generate-gallery');

  function renderGalleryStatus(status) {
    galleryDiff.replaceChildren();
    galleryFiles.replaceChildren();
    const report = status.diffReport;
    if (!report) {
      galleryProgress.textContent = t('gallery.empty');
      return;
    }
    galleryProgress.textContent = t('gallery.progressLine', {
      at: report.generatedAt,
      verdict: report.baselineExisted ? t('gallery.compared') : t('gallery.firstRound'),
      compared: report.diff && report.diff.rows.length ? t('gallery.comparedRows', { count: report.diff.rows.length }) : '',
    });
    if (report.diff) {
      for (const row of report.diff.rows) {
        const line = document.createElement('div');
        line.className = `gallery-row ${row.baseline === false ? 'ok' : (row.comparable === false || row.diffRatio > 0.01 ? 'bad' : 'ok')}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = row.image;
        const delta = document.createElement('span');
        delta.className = 'delta';
        delta.textContent = row.baseline === false
          ? t('gallery.rowBaseline')
          : row.comparable === false
            ? t('gallery.rowSize', { reason: row.reason })
            : t('gallery.rowPixels', { pixels: row.changedPixels, ratio: (row.diffRatio * 100).toFixed(4), max: row.maxDelta });
        line.append(name, delta);
        galleryDiff.appendChild(line);
      }
      if (report.diff.geometry) {
        const line = document.createElement('div');
        line.className = `gallery-row ${report.diff.geometry.changedFrames > 0 ? 'bad' : 'ok'}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = t('gallery.rowGeometry');
        const delta = document.createElement('span');
        delta.className = 'delta';
        delta.textContent = t('gallery.geometryChanged', { total: report.diff.geometry.frames.length, changed: report.diff.geometry.changedFrames });
        line.append(name, delta);
        galleryDiff.appendChild(line);
      }
    }
    // thumbnails of the current run (served read-only over workbench://)
    for (const image of [...(report.sizes || []), ...(report.strips || [])]) {
      const img = document.createElement('img');
      img.src = `workbench://local/content/build/gallery/current/${image}`;
      img.alt = image;
      img.title = image;
      galleryFiles.appendChild(img);
    }
  }
  bridge.galleryStatus().then(renderGalleryStatus).catch(() => {});

  galleryButton.addEventListener('click', () => {
    galleryButton.disabled = true;
    galleryProgress.textContent = t('gallery.rendering');
    bridge.generateGallery().then((outcome) => {
      galleryButton.disabled = false;
      if (!outcome.ok) {
        galleryProgress.textContent = t('gallery.failed', { message: `${outcome.code} ${outcome.message || ''}` });
        return;
      }
      setStatus(t('status.galleryUpdated'));
      return bridge.galleryStatus().then(renderGalleryStatus);
    }).catch((error) => {
      galleryButton.disabled = false;
      galleryProgress.textContent = t('gallery.failed', { message: error.message });
    });
  });
  bridge.onGalleryProgress((data) => {
    if (data && data.step === 'rendering') galleryProgress.textContent = t('gallery.renderingShort');
  });

  // ---- right pane: asset passport + project + .dshpack (studio entry only) --
  //
  // The passport answers "这套素材怎么来的、能不能复现" (§7A). Its services live
  // in the studio entry (studio/lib/provenance.js); under the legacy
  // office:workbench entry the bridge is absent and the panel says so instead
  // of failing halfway.
  const passportUnavailable = document.getElementById('passport-unavailable');
  const passportBody = document.getElementById('passport-body');
  if (!studio) {
    passportUnavailable.hidden = false;
    passportBody.hidden = true;
  } else {
    const STATUS_CLASS = { traceable: 'ok', 'traceable-in-history': 'warn', lost: 'bad', 'not-recorded': 'warn' };
    const projectEl = document.getElementById('passport-project');
    const summaryEl = document.getElementById('passport-summary');
    const tableBody = document.querySelector('#passport-table tbody');
    const findingsEl = document.getElementById('passport-findings');
    const ledgerEl = document.getElementById('passport-ledger');
    const assetInput = document.getElementById('passport-asset');
    const roundTripEl = document.getElementById('pack-roundtrip-result');
    roundTripEl.textContent = t('passport.roundTripIdle');
    const importEl = document.getElementById('pack-import-result');
    importEl.textContent = t('passport.importIdle');

    // T10: the .dshpack controls (export / round-trip / import) collapse behind a ⋯
    // disclosure. Importing and exporting write content, so they are not something to
    // keep next to a report you are only reading; the controls, their ids and the service
    // calls below are unchanged — only where they hide changed. The disclosure starts
    // CLOSED (hidden in the markup) and re-opens for as long as the page lives.
    const packMoreButton = document.getElementById('btn-pack-more');
    const packMoreBox = document.getElementById('pack-more-box');
    packMoreButton?.addEventListener('click', () => {
      if (!packMoreBox) return;
      const open = packMoreBox.hidden;
      packMoreBox.hidden = !open;
      packMoreButton.setAttribute('aria-expanded', String(open));
    });

    const evidenceText = (evidence) => {
      if (!evidence || typeof evidence !== 'object') return '';
      const parts = [];
      for (const [key, value] of Object.entries(evidence)) {
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) parts.push(`${key}×${value.length}`);
        else if (typeof value === 'object') parts.push(`${key}{${Object.keys(value).length}}`);
        else parts.push(`${key}=${String(value).slice(0, 24)}`);
      }
      return parts.join(' · ').slice(0, 160);
    };

    function renderProject(info) {
      if (!info.ok) {
        projectEl.textContent = t('passport.projectFailed', { message: `${info.code} ${info.message || ''}` });
        return;
      }
      projectEl.textContent = t('passport.projectText', {
        id: info.id, label: info.label, schema: info.schemaVersion,
        files: info.fileCount, mb: (info.totalBytes / 1048576).toFixed(2),
        actions: info.counts.actions, scenes: info.counts.scenes, characters: info.counts.characters,
        digest: info.digest.slice(0, 12),
        missing: info.missing.length ? t('passport.projectMissing', { count: info.missing.length }) : t('passport.projectComplete'),
      });
    }

    function renderReport(report) {
      tableBody.replaceChildren();
      findingsEl.replaceChildren();
      ledgerEl.replaceChildren();
      if (!report.ok) {
        summaryEl.textContent = t('passport.queryFailed', {
          message: report.error || '',
          known: report.known && report.known.length ? t('passport.queryKnown', { known: report.known.slice(0, 12).join(', ') }) : '',
        });
        return;
      }
      const verdict = {
        green: t('passport.verdictGreen'), yellow: t('passport.verdictYellow'), red: t('passport.verdictRed'),
      }[report.reproducible] || report.reproducible;
      summaryEl.textContent = t('passport.summary', { id: report.id, kind: report.kind, verdict });
      for (const segment of report.segments) {
        const row = document.createElement('tr');
        row.className = STATUS_CLASS[segment.status] || '';
        const cells = [
          segment.id,
          segment.status,
          evidenceText(segment.evidence),
          (segment.notes || []).join('；').slice(0, 120),
        ];
        for (const value of cells) {
          const cell = document.createElement('td');
          cell.textContent = value;
          row.appendChild(cell);
        }
        tableBody.appendChild(row);
      }
      for (const finding of report.findings || []) {
        const line = document.createElement('div');
        line.className = `gallery-row ${finding.level === 'red' ? 'bad' : finding.level === 'yellow' ? 'warn' : 'ok'}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${finding.level} · ${finding.code}`;
        const detail = document.createElement('span');
        detail.className = 'delta';
        detail.textContent = String(finding.message || '').slice(0, 220);
        line.append(name, detail);
        findingsEl.appendChild(line);
      }
    }

    async function refreshProject() {
      const info = await studio.projectInfo();
      renderProject(info);
      return info;
    }

    async function refreshAssetReport() {
      const assetId = (assetInput.value || '').trim() || 'walk-left';
      const report = await studio.provenanceReport(assetId);
      renderReport(report);
      // the generation-params ledger is the breakpoint this panel exists for
      const ledger = await studio.paramsLedger(assetId);
      const head = document.createElement('div');
      head.className = 'wb-panel-head';
      const title = document.createElement('h4');
      title.textContent = t('passport.ledgerTitle');
      head.appendChild(title);
      ledgerEl.appendChild(head);
      const line = document.createElement('p');
      line.className = 'wb-hint';
      line.textContent = ledger.ok && ledger.records.length
        ? t('passport.ledgerLine', { dir: ledger.dir, count: ledger.records.length })
        : t('passport.ledgerEmpty', { dir: ledger.dir, asset: assetId });
      ledgerEl.appendChild(line);
      if (ledger.ok && ledger.records.length) {
        const pre = document.createElement('pre');
        pre.className = 'wb-pre';
        pre.textContent = JSON.stringify(ledger.records.map((record) => ({
          recordedAt: record.recordedAt, kind: record.kind, provider: record.provider, model: record.model,
          promptHash: String(record.promptHash || '').slice(0, 12) + '…', seed: record.seed,
          outputs: (record.outputs || []).length,
        })), null, 2);
        ledgerEl.appendChild(pre);
      }
      return report;
    }

    document.getElementById('btn-project-refresh').addEventListener('click', () => {
      refreshProject().catch((error) => { projectEl.textContent = t('passport.projectFailed', { message: error.message }); });
    });
    document.getElementById('btn-passport-report').addEventListener('click', () => {
      refreshAssetReport().catch((error) => { summaryEl.textContent = t('passport.queryFailed', { message: error.message, known: '' }); });
    });
    assetInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') document.getElementById('btn-passport-report').click();
    });

    document.getElementById('btn-pack-roundtrip').addEventListener('click', () => {
      const button = document.getElementById('btn-pack-roundtrip');
      button.disabled = true;
      roundTripEl.textContent = t('passport.roundTripRunning');
      studio.packRoundTrip({}).then((outcome) => {
        button.disabled = false;
        if (!outcome.ok) {
          roundTripEl.textContent = t('passport.roundTripFailed', { stage: outcome.stage, detail: JSON.stringify(outcome.changed || outcome.detail || outcome).slice(0, 500) });
          setStatus(t('passport.roundTripFailedStatus'));
          return;
        }
        roundTripEl.textContent = [
          t('passport.roundTripOk'),
          t('passport.packFile', { file: outcome.packFile }),
          t('passport.packSha', { sha: outcome.packSha256 }),
          t('passport.contentDigest', { digest: outcome.beforeDigest }),
          t('passport.fileCount', { count: outcome.files }),
        ].join('\n');
        setStatus(t('passport.roundTripOkStatus'));
      }).catch((error) => {
        button.disabled = false;
        roundTripEl.textContent = t('passport.roundTripError', { message: error.message });
      });
    });

    document.getElementById('btn-pack-export').addEventListener('click', () => {
      const button = document.getElementById('btn-pack-export');
      button.disabled = true;
      studio.packExport({}).then((outcome) => {
        button.disabled = false;
        if (!outcome.ok) {
          roundTripEl.textContent = t('passport.exportRefused', {
            code: outcome.code,
            violations: outcome.violations
              ? t('passport.exportViolation', { details: outcome.violations.map((violation) => `  ✗ ${violation.path || ''} ${violation.check} ${violation.detail || ''}`).join('\n') })
              : '',
          });
          setStatus(t('passport.exportRefusedStatus', { code: outcome.code }));
          return;
        }
        roundTripEl.textContent = [
          t('passport.exportOk'),
          t('passport.exportFile', { file: outcome.out }),
          t('passport.exportSize', { mb: (outcome.bytes / 1048576).toFixed(2), entries: outcome.entries, sha: outcome.packSha256.slice(0, 16) }),
          t('passport.exportDigest', { digest: outcome.digest }),
        ].join('\n');
        setStatus(t('passport.exportOkStatus'));
      }).catch((error) => {
        button.disabled = false;
        roundTripEl.textContent = t('passport.exportError', { message: error.message });
      });
    });

    document.getElementById('btn-pack-import').addEventListener('click', () => {
      const file = document.getElementById('pack-import-path').value.trim();
      const dest = document.getElementById('pack-import-dest').value.trim();
      const overwrite = document.getElementById('pack-import-overwrite').checked;
      if (!file || !dest) {
        importEl.textContent = t('passport.importNeedPath');
        return;
      }
      importEl.textContent = t('passport.importing');
      studio.packImport({ file, dest, overwrite }).then((outcome) => {
        if (!outcome.ok) {
          importEl.textContent = t('passport.importRefused', {
            code: outcome.code, message: outcome.message || '',
            problems: (outcome.problems || []).map((problem) => t('passport.importProblem', { check: problem.check, path: problem.path || '', detail: problem.detail })).join('\n'),
          }).trim();
          setStatus(t('passport.importRefusedStatus', { code: outcome.code }));
          return;
        }
        importEl.textContent = t('passport.importOk', {
          dest: outcome.dest, files: outcome.counts.files,
          mb: (outcome.counts.bytes / 1048576).toFixed(2),
          id: outcome.manifest.id, schema: outcome.manifest.schemaVersion,
        });
        setStatus(t('passport.importOkStatus'));
      }).catch((error) => { importEl.textContent = t('passport.importError', { message: error.message }); });
    });

    refreshProject().catch((error) => { projectEl.textContent = t('passport.projectFailed', { message: error.message }); });
    refreshAssetReport().catch(() => {});

    // ---- the generation page: the S0–S8 pipeline panel (R5, studio entry only) --
    //
    // 把生成流水线接进工作台（handover §6-6，最大的空白面）。这个面板自己是空的：
    // 阶段注册表、干走计划、执行记录、QC 报告、分诊队列全部来自主进程里的引擎
    // （studio/lib/pipeline/**，经 studio:pipeline-* 服务），app/pipeline-model.js
    // 只做「引擎状态 → 面板行」的映射，绝不自己算一遍缓存或 QC。执行时每段的记录
    // 由 studio:pipeline-progress 推进来，日志按运行坞自己的状态行长出来。
    const pipelineModel = window.wbPipelineModel;
    const pipelineUnavailable = document.getElementById('pipeline-unavailable');
    const pipelineBody = document.getElementById('pipeline-body');
    if (!studio || !studio.pipelineStages || !pipelineModel) {
      pipelineUnavailable.hidden = false;
      pipelineBody.hidden = true;
    } else {
      const pipelineStatus = document.getElementById('pipeline-status');
      const pipelineLog = document.getElementById('pipeline-log');
      const pipelineStagesBody = document.querySelector('#pipeline-stages-table tbody');
      const pipelinePlanSummary = document.getElementById('pipeline-plan-summary');
      const pipelineCacheStats = document.getElementById('pipeline-cache-stats');
      const pipelineCacheRows = document.getElementById('pipeline-cache-rows');
      const pipelineQcVerdict = document.getElementById('pipeline-qc-verdict');
      const pipelineQcFindings = document.getElementById('pipeline-qc-findings');
      const pipelineAction = document.getElementById('pipeline-action');
      const pipelineOnly = document.getElementById('pipeline-only');
      const pipelineParams = document.getElementById('pipeline-params');
      const pipelineReference = document.getElementById('pipeline-reference');
      const pipelineDelivery = document.getElementById('pipeline-delivery');
      const pipelineForce = document.getElementById('pipeline-force');
      const pipelinePublish = document.getElementById('pipeline-publish');
      const pipelineRecord = document.getElementById('pipeline-record');
      const pipelineTriageListEl = document.getElementById('pipeline-triage-list');
      const pipelineTriageFile = document.getElementById('pipeline-triage-file');
      const pipelineTriageDetailText = document.getElementById('pipeline-triage-detail-text');
      const pipelineTriageNote = document.getElementById('pipeline-triage-note');
      const pipelineTriageResolveStatus = document.getElementById('pipeline-triage-resolve-status');
      const pipelinePlanButton = document.getElementById('btn-pipeline-plan');
      const pipelineRunButton = document.getElementById('btn-pipeline-run');

      // the panel's own state: the engine's last answers, never a derived copy
      let pipelineRegistry = [];
      let pipelineChain = [];
      let pipelinePlanDoc = null;
      let pipelineRunDoc = null;
      let pipelineTriageEntries = [];
      let pipelineSelectedTriage = null;
      let pipelineBusy = false;
      let pipelineLogRecords = [];
      let pipelineReplanTimer = null;
      let pipelineRepoRoot = null;

      const pipelineSay = (text) => { pipelineStatus.textContent = text || ''; setStatus(text || ''); };
      // the engine's statuses onto the shell's existing semantic classes (the CSS
      // tokens behind them are already contrast-checked)
      const pipelineStatusClass = (status) => ({ failed: 'bad', blocked: 'bad', retrying: 'warn', ran: 'ok', cached: 'ok', hit: 'ok' }[status] || '');
      const pipelineRel = (abs) => (pipelineRepoRoot && String(abs).startsWith(`${pipelineRepoRoot}/`) ? String(abs).slice(pipelineRepoRoot.length + 1) : String(abs));
      const pipelineFormError = (parsed) => {
        if (parsed.code === 'PIPELINE_UNKNOWN_STAGE') return t('pipeline.unknownStage', { unknown: parsed.unknown.join(',') });
        if (parsed.code === 'PIPELINE_PARAMS_NOT_JSON') return t('pipeline.paramsBad', { message: parsed.message });
        if (parsed.code === 'PIPELINE_PARAMS_NOT_OBJECT') return t('pipeline.paramsNotObject');
        return t('pipeline.planRefused', { message: parsed.code || 'unknown' });
      };
      // the form, read once per action: the chain and the params are validated HERE so a
      // typo never reaches the engine as a half-meaningful request
      const pipelineReadForm = () => {
        const chain = pipelineModel.chainFromForm({ only: pipelineOnly.value, publish: pipelinePublish.checked });
        if (!chain.ok) return { ok: false, message: pipelineFormError(chain) };
        const params = pipelineModel.parseParams(pipelineParams.value);
        if (!params.ok) return { ok: false, message: pipelineFormError(params) };
        return {
          ok: true,
          request: {
            actionId: pipelineAction.value,
            stages: chain.stages,
            params: params.params,
            force: pipelineForce.checked,
            reference: pipelineReference.value.trim() || null,
            deliveryDir: pipelineDelivery.value.trim() || null,
          },
        };
      };

      // ---- the stage table -----------------------------------------------------
      function pipelineRenderStages() {
        const rows = pipelineModel.stageRows({
          registry: pipelineRegistry,
          plan: pipelinePlanDoc,
          run: pipelineRunDoc,
          chainIds: pipelineChain,
        });
        pipelineStagesBody.replaceChildren();
        for (const row of rows) {
          const tr = document.createElement('tr');
          tr.dataset.stageId = row.id;
          const statusClass = pipelineStatusClass(row.status);
          if (statusClass) tr.classList.add(statusClass);
          if (!row.inChain) tr.classList.add('pipeline-off');
          const cells = [
            row.id,
            row.name,
            row.statusKey ? t(row.statusKey) : row.status,
            row.dependsOn.length ? t('pipeline.stageDepends', { ids: row.dependsOn.join(',') }) : '—',
            row.reason || (row.providerClass ? t('pipeline.stageProvider', { klass: row.providerClass }) : ''),
          ];
          for (const value of cells) {
            const cell = document.createElement('td');
            cell.textContent = value;
            tr.appendChild(cell);
          }
          tr.title = row.key ? t('pipeline.stageKey', { key: row.key }) : '';
          pipelineStagesBody.appendChild(tr);
        }
      }

      // ---- the cache view: the engine's own dry walk, row per stage -------------
      function pipelineRenderCache() {
        const rows = pipelineModel.cacheRows(pipelinePlanDoc);
        const stats = pipelinePlanDoc && pipelinePlanDoc.cache ? pipelinePlanDoc.cache : null;
        pipelineCacheStats.textContent = stats
          ? t('pipeline.cacheStats', { entries: stats.entries ?? 0, size: `${((stats.totalBytes ?? 0) / 1024).toFixed(1)} KiB` })
          : '';
        pipelineCacheRows.replaceChildren();
        if (!rows.length) {
          const empty = document.createElement('p');
          empty.className = 'wb-hint';
          empty.textContent = t('pipeline.cacheEmpty');
          pipelineCacheRows.appendChild(empty);
          return;
        }
        for (const row of rows) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `pipeline-cache-row ${pipelineStatusClass(row.status)}`.trim();
          button.dataset.stageId = row.id;
          const lines = [
            `${row.id} ${row.name} — ${row.statusKey ? t(row.statusKey) : row.status}`,
            row.reason,
            Object.keys(row.params).length ? t('pipeline.cacheParams', { params: JSON.stringify(row.params) }) : '',
            row.key ? t('pipeline.stageKey', { key: row.key.slice(0, 12) }) : '',
            row.inputs.length ? t('pipeline.cacheInputs', { count: row.inputs.length }) : '',
            row.outputs.length ? t('pipeline.cacheOutputs', { count: row.outputs.length }) : '',
          ];
          button.textContent = lines.filter(Boolean).join('\n');
          button.addEventListener('click', () => pipelineSelectStage(row.id));
          pipelineCacheRows.appendChild(button);
        }
      }

      // ---- the QC report --------------------------------------------------------
      function pipelineRenderQc() {
        const report = pipelineModel.qcReport(pipelineRunDoc);
        pipelineQcFindings.replaceChildren();
        if (!report) {
          pipelineQcVerdict.textContent = t('pipeline.qcIdle');
          return;
        }
        pipelineQcVerdict.textContent = t('pipeline.qcVerdict', {
          verdict: report.verdictKey ? t(report.verdictKey) : (report.verdict || '—'),
          red: report.red, yellow: report.yellow,
          ms: typeof report.ms === 'number' ? t('pipeline.qcMs', { ms: report.ms }) : '',
        });
        for (const finding of report.findings) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `pipeline-finding ${finding.severityClass}`;
          button.textContent = `${t(finding.severityKey)} · ${finding.code} — ${finding.message}`;
          if (finding.fix) {
            const fix = document.createElement('span');
            fix.className = 'pipeline-fix';
            fix.textContent = t('pipeline.qcFix', { fix: finding.fix });
            button.appendChild(fix);
          }
          button.addEventListener('click', () => pipelineSelectStage('S5'));
          pipelineQcFindings.appendChild(button);
        }
        if (!report.findings.length) {
          const clean = document.createElement('p');
          clean.className = 'wb-hint';
          clean.textContent = t('pipeline.qcClean');
          pipelineQcFindings.appendChild(clean);
        }
        // the SAME findings go to the bottom problems strip: grouped by code there,
        // and a click jumps back to the stage row (the strip's own contract)
        window.__wbProblems?.problems?.set('pipeline', pipelineModel.findingsToProblems({
          actionId: pipelineAction.value, findings: report.findings,
        }));
      }

      // ---- the triage queue ------------------------------------------------------
      function pipelineRenderTriage() {
        pipelineTriageListEl.replaceChildren();
        if (!pipelineTriageEntries.length) {
          const empty = document.createElement('p');
          empty.className = 'wb-hint';
          empty.textContent = t('pipeline.triage.empty');
          pipelineTriageListEl.appendChild(empty);
          return;
        }
        for (const row of pipelineTriageEntries) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `pipeline-triage-row ${row.statusClass}`;
          button.dataset.triageId = row.id;
          const lines = [
            `${row.statusKey ? t(row.statusKey) : row.status} · ${row.id}`,
            `${row.stage} ${row.code} · ${t('pipeline.triage.attempts', { attempts: row.attempts, max: row.maxRetries })}${row.needsHuman ? ` · ${t('pipeline.triage.needsHuman')}` : ''}`,
            t('pipeline.triage.reason', { reason: row.reason }),
            t('pipeline.triage.fix', { fix: row.fix }),
          ];
          if (row.resolution) {
            lines.push(row.resolution.by === 'pipeline'
              ? t('pipeline.triage.auto')
              : t('pipeline.triage.resolvedAt', { note: row.resolution.note, by: row.resolution.by, at: row.resolvedAt }));
          }
          button.textContent = lines.join('\n');
          button.addEventListener('click', () => pipelineSelectTriage(row.id));
          pipelineTriageListEl.appendChild(button);
        }
      }

      function pipelineSelectTriage(id) {
        const previous = pipelineSelectedTriage ? pipelineSelectedTriage.id : null;
        pipelineSelectedTriage = pipelineTriageEntries.find((row) => row.id === id) || null;
        for (const button of pipelineTriageListEl.querySelectorAll('.pipeline-triage-row')) {
          button.classList.toggle('selected', button.dataset.triageId === id);
        }
        const row = pipelineSelectedTriage;
        if (!row) {
          pipelineTriageDetailText.textContent = t('pipeline.triage.none');
          document.getElementById('btn-pipeline-triage-resolve').disabled = true;
          return;
        }
        pipelineTriageDetailText.textContent = [
          `${row.stage} ${row.code} · ${row.statusKey ? t(row.statusKey) : row.status}`,
          t('pipeline.triage.reason', { reason: row.reason }),
          t('pipeline.triage.fix', { fix: row.fix }),
          t('pipeline.triage.attempts', { attempts: row.attempts, max: row.maxRetries }),
          row.resolution
            ? (row.resolution.by === 'pipeline'
              ? t('pipeline.triage.auto')
              : t('pipeline.triage.resolvedAt', { note: row.resolution.note, by: row.resolution.by, at: row.resolvedAt }))
            : '',
        ].filter(Boolean).join('\n');
        document.getElementById('btn-pipeline-triage-resolve').disabled = row.status !== 'open';
        pipelineTriageNote.value = '';
        // the resolve outcome stays on screen until the selection moves: clearing it
        // on every re-select wiped the "已解决" line the moment the queue re-rendered
        if (previous !== id) pipelineTriageResolveStatus.textContent = '';
      }

      // a click on a QC finding (or a problems-strip jump) lands on the stage row
      function pipelineSelectStage(stageId) {
        const row = pipelineStagesBody.querySelector(`tr[data-stage-id="${stageId}"]`);
        if (!row) return;
        for (const other of pipelineStagesBody.querySelectorAll('tr')) other.classList.remove('selected');
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest' });
        pipelineSay(`${stageId} · ${row.children[2].textContent}`);
      }

      // ---- the two front doors: plan (dry walk) and run (execute) ---------------
      async function pipelineRefreshPlan({ quiet = false } = {}) {
        if (pipelineBusy) return null;
        const form = pipelineReadForm();
        if (!form.ok) { pipelineSay(form.message); return null; }
        pipelineChain = form.request.stages;
        if (!quiet) pipelineSay(t('pipeline.planRunning'));
        let answer;
        try {
          answer = await studio.pipelinePlan(form.request);
        } catch (error) {
          pipelineSay(t('pipeline.planFailed', { code: 'IPC_FAILED', message: String((error && error.message) || error) }));
          return null;
        }
        if (!answer.ok) {
          pipelinePlanDoc = null;
          pipelineSay(t('pipeline.planFailed', { code: answer.code || 'PLAN_FAILED', message: answer.message || '' }));
          pipelineRenderStages();
          pipelineRenderCache();
          return null;
        }
        pipelinePlanDoc = answer.plan;
        const summary = pipelineModel.planSummary(answer.plan, t);
        pipelinePlanSummary.textContent = summary ? summary.text : '';
        pipelineRenderStages();
        pipelineRenderCache();
        if (!quiet && summary) pipelineSay(summary.text);
        return answer;
      }

      async function pipelineExecute() {
        if (pipelineBusy) return null;
        const form = pipelineReadForm();
        if (!form.ok) { pipelineSay(form.message); return null; }
        pipelineBusy = true;
        pipelinePlanButton.disabled = true;
        pipelineRunButton.disabled = true;
        pipelineChain = form.request.stages;
        pipelineRunDoc = null;
        pipelineLogRecords = [];
        pipelineLog.textContent = '';
        pipelineSay(t('pipeline.runBusy', { done: 0, total: pipelineChain.length }));
        let answer;
        try {
          answer = await studio.pipelineRun({
            ...form.request,
            recordParams: pipelineRecord.checked,
          });
        } catch (error) {
          pipelineSay(t('pipeline.runFailed', { code: 'IPC_FAILED', message: String((error && error.message) || error) }));
          return null;
        } finally {
          pipelineBusy = false;
          pipelinePlanButton.disabled = false;
          pipelineRunButton.disabled = false;
        }
        if (!answer || !answer.outcome) {
          pipelineSay(t('pipeline.runFailed', { code: (answer && answer.code) || 'RUN_FAILED', message: (answer && answer.message) || '' }));
          return null;
        }
        pipelineRunDoc = answer.outcome;
        // the run's own records are the authoritative log (the live lines were the
        // same records as they arrived)
        pipelineLog.textContent = pipelineModel.runLogLines(answer.outcome.stages).join('\n');
        pipelineRenderStages();
        pipelineRenderQc();
        await pipelineRefreshTriage({ quiet: true });
        const ledgerLine = answer.ledger && answer.ledger.refused
          ? t('pipeline.runLedgerRefused', { code: answer.ledger.refused.code })
          : !answer.ledger || !answer.ledger.enabled
            ? t('pipeline.runLedgerOff')
            : answer.ledger.recorded.length
              ? t('pipeline.runLedgerRecorded', { stages: answer.ledger.recorded.join(',') })
              : t('pipeline.runLedgerSkipped');
        pipelineLog.textContent += `\n${ledgerLine}`;
        const headline = answer.outcome.ok
          ? t('pipeline.runPass', { ran: answer.outcome.ran.length, cached: answer.outcome.cachedStages.length })
          : t('pipeline.runBlocked', { triage: (answer.queued || []).length });
        pipelineSay(`${headline} · ${ledgerLine}`);
        // the cache moved: re-walk it so the cache view shows the new hits
        await pipelineRefreshPlan({ quiet: true });
        return answer;
      }

      async function pipelineRefreshTriage({ quiet = false } = {}) {
        let answer;
        try {
          answer = await studio.pipelineTriageList({ actionId: pipelineAction.value || null });
        } catch (error) {
          pipelineSay(t('pipeline.triage.loadFailed', { code: String((error && error.message) || error) }));
          return null;
        }
        if (!answer.ok) {
          pipelineSay(t('pipeline.triage.loadFailed', { code: answer.code || 'TRIAGE_LIST_FAILED' }));
          return null;
        }
        pipelineTriageEntries = pipelineModel.triageRows(answer.entries);
        pipelineTriageFile.textContent = t('pipeline.triage.file', { file: pipelineRel(answer.dir) });
        if (pipelineSelectedTriage && !pipelineTriageEntries.some((row) => row.id === pipelineSelectedTriage.id)) {
          pipelineSelectedTriage = null;
        }
        pipelineRenderTriage();
        if (pipelineSelectedTriage) pipelineSelectTriage(pipelineSelectedTriage.id);
        else pipelineSelectTriage(null);
        if (!quiet) {
          const open = pipelineTriageEntries.filter((row) => row.status === 'open').length;
          pipelineSay(t('pipeline.triage.refreshed', { open, resolved: pipelineTriageEntries.length - open }));
        }
        return answer;
      }

      // ---- the wiring ------------------------------------------------------------
      pipelinePlanButton.addEventListener('click', () => { pipelineRefreshPlan().catch(() => {}); });
      pipelineRunButton.addEventListener('click', () => { pipelineExecute().catch(() => {}); });
      document.getElementById('btn-pipeline-triage-refresh').addEventListener('click', () => { pipelineRefreshTriage().catch(() => {}); });
      document.getElementById('btn-pipeline-triage-resolve').addEventListener('click', async () => {
        const row = pipelineSelectedTriage;
        if (!row) { pipelineTriageResolveStatus.textContent = t('pipeline.triage.none'); return; }
        // the note is mandatory here AND in the engine (fail closed both sides)
        const refusal = pipelineModel.noteRefusal(pipelineTriageNote.value);
        if (refusal) {
          pipelineTriageResolveStatus.textContent = t('pipeline.triage.noteRequired');
          pipelineTriageNote.focus();
          return;
        }
        let answer;
        try {
          answer = await studio.pipelineTriageResolve({ id: row.id, note: pipelineTriageNote.value });
        } catch (error) {
          pipelineTriageResolveStatus.textContent = t('pipeline.triage.resolveFailed', { error: String((error && error.message) || error) });
          return;
        }
        if (!answer.ok) {
          pipelineTriageResolveStatus.textContent = t('pipeline.triage.resolveFailed', { error: answer.error || answer.code });
          return;
        }
        pipelineTriageResolveStatus.textContent = t('pipeline.triage.resolvedOk', { id: row.id });
        await pipelineRefreshTriage({ quiet: true });
        pipelineSelectTriage(row.id);
      });
      // 素材护照联动: the passport panel answers "这套素材怎么来的 + 复现命令 + 红黄绿";
      // this jump only names the asset, so the two panels can never disagree about it
      document.getElementById('btn-pipeline-passport').addEventListener('click', () => {
        const target = pipelineModel.passportTarget(pipelineAction.value);
        if (!target.ok) { pipelineSay(t('pipeline.planRefused', { message: 'no action selected' })); return; }
        activateTab('tab-passport');
        const input = document.getElementById('passport-asset');
        const button = document.getElementById('btn-passport-report');
        if (input) input.value = target.actionId;
        if (button) button.click();
        pipelineSay(t('pipeline.passportJumped', { id: target.actionId }));
      });

      // live re-walk: editing the form re-plans (debounced), so "改参数只重跑受影响段"
      // is visible without pressing anything
      const pipelineSchedulePlan = () => {
        if (pipelineReplanTimer) clearTimeout(pipelineReplanTimer);
        pipelineReplanTimer = setTimeout(() => { pipelineRefreshPlan({ quiet: true }).catch(() => {}); }, 400);
      };
      for (const element of [pipelineOnly, pipelineParams, pipelineReference, pipelineDelivery, pipelineForce, pipelinePublish]) {
        element.addEventListener('input', pipelineSchedulePlan);
        element.addEventListener('change', pipelineSchedulePlan);
      }
      pipelineAction.addEventListener('change', () => {
        // a different asset: the last run's QC findings and triage selection are not
        // about it any more — the strip says so by dropping the source
        window.__wbProblems?.problems?.clear('pipeline');
        pipelineRunDoc = null;
        pipelinePlanDoc = null;
        pipelineSelectedTriage = null;
        pipelineRenderQc();
        pipelineRefreshTriage({ quiet: true }).catch(() => {});
        pipelineRefreshPlan({ quiet: true }).catch(() => {});
      });

      // the problems strip's jump target: `stage:S5` selects that stage row
      window.addEventListener('wb:select-item', (event) => {
        const itemId = event.detail && event.detail.itemId;
        if (typeof itemId !== 'string' || !itemId.startsWith('stage:')) return;
        pipelineSelectStage(itemId.slice('stage:'.length));
      });

      // live progress: ONE listener for the shell's life; it logs only while a run
      // is in flight (the same pattern the gallery progress uses)
      studio.onPipelineProgress((record) => {
        if (!pipelineBusy) return;
        pipelineLogRecords.push(record);
        pipelineLog.textContent = pipelineModel.runLogLines(pipelineLogRecords).join('\n');
        pipelineSay(t('pipeline.runBusy', { done: pipelineLogRecords.length, total: pipelineChain.length }));
      });

      panelRefresh.set('tab-pipeline', () => pipelineRefreshPlan({ quiet: true }));

      // ---- boot: the registry, the action list, then the first dry walk ---------
      (async () => {
        pipelineLog.textContent = t('pipeline.logIdle');
        try {
          const info = await studio.info();
          pipelineRepoRoot = info && info.repoRoot ? info.repoRoot : null;
        } catch { /* a relative path is still honest */ }
        const registry = await studio.pipelineStages();
        pipelineRegistry = registry.ok ? registry.stages : [];
        pipelineRenderStages();
        const list = await studio.actionList();
        if (list.ok) {
          pipelineAction.replaceChildren();
          for (const action of list.actions) {
            const option = document.createElement('option');
            option.value = action.id;
            option.textContent = `${action.id}${action.inPack ? ` ${t('pipeline.actionInPack')}` : ''} · ${t('pipeline.actionFrames', { n: action.frames })}`;
            pipelineAction.appendChild(option);
          }
          if ([...pipelineAction.options].some((option) => option.value === 'walk-left')) pipelineAction.value = 'walk-left';
          pipelineSay(t('pipeline.actionsLoaded', { count: list.actions.length }));
        }
      })().catch((error) => { pipelineSay(t('pipeline.planFailed', { code: 'BOOT_FAILED', message: String((error && error.message) || error) })); });

      // The first dry walk waits for the page: 生成 is not the landing page, and a plan
      // nobody is looking at is work the shell should not do on every start (the boot
      // probe felt exactly that load). The registry and the action list ARE loaded at
      // boot — they are cheap reads and the stage table renders from them immediately.
      let pipelineBooted = false;
      const pipelineBootOnce = () => {
        if (pipelineBooted) return;
        pipelineBooted = true;
        pipelineRefreshPlan({ quiet: true }).catch(() => {});
        pipelineRefreshTriage({ quiet: true }).catch(() => {});
      };
      for (const id of ['tab-pipeline', 'page-generation']) {
        document.getElementById(id)?.addEventListener('click', () => setTimeout(pipelineBootOnce, 0));
      }
      // the shell can also RESTORE on the pipeline tab (localStorage) — no click happens
      if (shellState.tab === 'tab-pipeline') pipelineBootOnce();
    }

    // ---- right pane: scene validation + waypoint graph (P2) ------------------
    const sceneUnavailable = document.getElementById('scene-unavailable');
    const sceneBody = document.getElementById('scene-body');
    if (!studio || !studio.sceneReport) {
      sceneUnavailable.hidden = false;
      sceneBody.hidden = true;
    } else {
      const sceneSummary = document.getElementById('scene-summary');
      const sceneTableBody = document.querySelector('#scene-table tbody');
      const waypointsEl = document.getElementById('scene-waypoints');
      const syncEl = document.getElementById('scene-sync-result');
      syncEl.textContent = t('scene.syncIdle');
      const exportButton = document.getElementById('btn-scene-waypoints-export');
      const writeButton = document.getElementById('btn-scene-sync-write');

      function renderSceneReport(report) {
        window.__wbProblems?.problems?.set('scene', ((report && report.violations) || []).map((violation) => ({
          severity: violation.severity, code: violation.code, message: violation.message,
          target: { page: 'scene', tab: 'tab-scene', itemId: violation.itemId || null },
        })));
        sceneTableBody.replaceChildren();
        if (!report.ok && !report.stats) {
          sceneSummary.textContent = t('scene.reportLoadFailed', { message: `${report.code} ${report.message || ''}` });
          return;
        }
        const verdict = report.ok ? t('scene.reportVerdictOk') : t('scene.reportVerdictRed');
        sceneSummary.textContent = t('scene.reportSummary', {
          id: report.sceneId, width: report.scene.width, height: report.scene.height, verdict,
          stations: report.stats.stations, seats: report.stats.seats, obstacles: report.stats.obstacles,
          red: report.stats.red, yellow: report.stats.yellow,
          nodes: report.graph.stats.nodes, edges: report.graph.stats.edges,
        });
        for (const violation of report.violations) {
          const row = document.createElement('tr');
          row.className = violation.severity === 'red' ? 'bad' : 'warn';
          const cells = [
            violation.severity === 'red' ? t('scene.violationSeverityRed') : t('scene.violationSeverityWarn'),
            violation.code, violation.message,
          ];
          for (const value of cells) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
          }
          sceneTableBody.appendChild(row);
        }
      }

      async function refreshSceneReport() {
        const report = await studio.sceneReport({});
        renderSceneReport(report);
        return report;
      }

      document.getElementById('btn-scene-report').addEventListener('click', () => {
        refreshSceneReport().catch((error) => { sceneSummary.textContent = t('scene.checkFailed', { message: error.message }); });
      });

      document.getElementById('btn-scene-waypoints').addEventListener('click', () => {
        studio.sceneWaypoints({}).then((graph) => {
          if (!graph.ok) { waypointsEl.textContent = t('scene.waypointsFailed', { message: graph.code }); return; }
          waypointsEl.textContent = t('scene.waypointsText', {
            nodes: graph.nodes.length, edges: graph.edges.length, labels: JSON.stringify(graph.labels),
            components: graph.stats.components, isolated: graph.stats.isolated, largest: graph.stats.largestComponent,
            entries: graph.entries.length, blocked: graph.entries.filter((entry) => entry.blocked).length,
          });
          exportButton.disabled = false;
        }).catch((error) => { waypointsEl.textContent = t('scene.waypointsFailed', { message: error.message }); });
      });

      exportButton.addEventListener('click', () => {
        studio.sceneWaypoints({ write: 'build/waypoints/flat.waypoints.json' }).then((graph) => {
          waypointsEl.textContent = graph.written
            ? t('scene.waypointsExported', { file: graph.written, nodes: graph.nodes.length, edges: graph.edges.length })
            : t('scene.exportFailed', { message: graph.code || 'unknown' });
        }).catch((error) => { waypointsEl.textContent = t('scene.exportFailed', { message: error.message }); });
      });

      document.getElementById('btn-scene-sync').addEventListener('click', () => {
        studio.sceneSyncZones({ write: false }).then((outcome) => {
          if (!outcome.ok) { syncEl.textContent = t('scene.syncFailed', { message: `${outcome.code} ${outcome.message || ''}` }); return; }
          syncEl.textContent = [
            outcome.exact ? t('scene.syncExact') : t('scene.syncDrift'),
            t('scene.syncAdded', { count: outcome.changes.added.length, ids: outcome.changes.added.join(', ') || t('bench.gapNone') }),
            t('scene.syncMoved', { count: outcome.changes.moved.length, ids: outcome.changes.moved.join(', ') || t('bench.gapNone') }),
            t('scene.syncRemoved', { count: outcome.changes.removed.length, ids: outcome.changes.removed.join(', ') || t('bench.gapNone') }),
            t('scene.syncUnchanged', { count: outcome.changes.unchanged.length }),
          ].join('\n');
          writeButton.disabled = outcome.exact;
        }).catch((error) => { syncEl.textContent = t('scene.syncFailed', { message: error.message }); });
      });

      writeButton.addEventListener('click', () => {
        studio.sceneSyncZones({ write: true }).then((outcome) => {
          if (!outcome.ok) { syncEl.textContent = t('scene.syncWriteFailed', { message: `${outcome.code} ${outcome.message || ''}` }); return; }
          syncEl.textContent = outcome.noop
            ? t('scene.syncNoop')
            : t('scene.syncWritten', { file: outcome.file, backup: outcome.backup || t('scene.syncBackupNone') });
          writeButton.disabled = true;
          return refreshSceneReport();
        }).catch((error) => { syncEl.textContent = t('scene.syncWriteFailed', { message: error.message }); });
      });

      refreshSceneReport().catch((error) => { sceneSummary.textContent = t('scene.checkFailed', { message: error.message }); });

      // ---- scene canvas editor (UI #1) ----
      //
      // The edits live in `pending` until 保存: the canvas renders pending on top of the
      // on-disk draft, every change re-validates through the same service the CLI uses,
      // and a RED result is shown AND refused at save time (被拦住). 重新载入 drops
      // pending and re-reads the file.
      const canvas = document.getElementById('scene-canvas');
      const canvasStatus = document.getElementById('canvas-status');
      const selectionLabel = document.getElementById('canvas-selection');
      const scaleLabel = document.getElementById('canvas-scale-label');
      const showGraph = document.getElementById('canvas-show-graph');
      const showObstacles = document.getElementById('canvas-show-obstacles');
      const showSeats = document.getElementById('canvas-show-seats');
      let sceneState = null;
      let selectedId = null;
      const pending = new Map();      // itemId → { position?, scale?, hidden?, layer? }
      const images = new Map();
      // the selected item's property panel (T6) — the type-a-value half of the canvas
      const itemBody = document.getElementById('item-body');
      const itemForm = document.getElementById('item-prop-form');
      const itemNone = document.getElementById('item-none');
      const itemMeta = document.getElementById('item-prop-meta');
      const itemStatus = document.getElementById('item-prop-status');
      const propX = document.getElementById('item-prop-x');
      const propY = document.getElementById('item-prop-y');
      const propScale = document.getElementById('item-prop-scale');
      const propLayer = document.getElementById('item-prop-layer');
      const propName = document.getElementById('item-prop-name');
      const propHidden = document.getElementById('item-prop-hidden');
      // gap #2: the depth-band readout under the layer field
      const itemLayerBand = document.getElementById('item-layer-band');

      const assetUrl = (src) => `workbench://local/preview/${String(src).replace(/^\.\//, '')}`;

      function imageFor(src) {
        if (!src) return null;
        if (!images.has(src)) {
          const img = new Image();
          img.src = assetUrl(src);
          images.set(src, img);
        }
        const img = images.get(src);
        return img.complete && img.naturalWidth > 0 ? img : null;
      }

      // the on-disk draft with `pending` folded in (position/scale/hidden/layer)
      function effectiveItems() {
        if (!sceneState) return [];
        return sceneState.items.map((item) => {
          const edit = pending.get(item.id);
          if (!edit) return item;
          const scale = edit.scale === undefined ? (item.scale || 1) : edit.scale;
          const ratio = (item.scale || 1) === 0 ? 1 : scale / (item.scale || 1);
          const position = edit.position || item.position;
          const box = item.box ? {
            width: item.box.width * ratio,
            height: item.box.height * ratio,
            x: position.x * sceneState.scene.width - (item.box.width * ratio) / 2,
            y: position.y * sceneState.scene.height - (item.box.height * ratio) / 2,
          } : null;
          return { ...item, position, scale, hidden: edit.hidden === undefined ? item.hidden : edit.hidden, box };
        });
      }

      async function loadSceneDraft() {
        const draft = await studio.sceneDraft({});
        if (!draft.ok) { canvasStatus.textContent = t('scene.canvasStatusLoadFailed', { message: `${draft.code} ${draft.message || ''}` }); return null; }
        sceneState = {
          sceneId: draft.sceneId, scene: draft.scene, items: draft.items, graph: draft.graph,
          obstacles: draft.obstacles || [], seats: draft.seats || [],
        };
        pending.clear();
        // the stage follows the scene's logical size: the EDIT layer and the RUN layer
        // (the office page) then share one coordinate space
        stage.announce({ width: draft.scene.width, height: draft.scene.height, items: draft.items.length, hasScene: true });
        return draft;
      }

      function renderCanvas() {
        if (!sceneState) return;
        const { scene } = sceneState;
        const items = effectiveItems();
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#f7f8fa';
        ctx.fillRect(0, 0, scene.width, scene.height);
        ctx.strokeStyle = '#e6e9ee';
        ctx.lineWidth = 1;
        for (let x = 0; x <= scene.width; x += 64) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, scene.height); ctx.stroke(); }
        for (let y = 0; y <= scene.height; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(scene.width, y); ctx.stroke(); }
        if (showObstacles.checked) {
          // thin strokes, no fill (T12): 33 filled rectangles drowned the furniture they
          // describe. The data is still there, it just stopped shouting.
          ctx.strokeStyle = 'rgba(194, 58, 58, 0.35)';
          ctx.lineWidth = 1;
          for (const obstacle of sceneState.obstacles) {
            const r = obstacle.rect;
            ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
          }
        }
        for (const item of [...items].sort((a, b) => (a.layer || 0) - (b.layer || 0))) {
          if (!item.box || item.hidden) continue;
          const img = imageFor(item.src);
          if (img) {
            ctx.globalAlpha = item.missingAsset ? 0.4 : 1;
            ctx.drawImage(img, item.box.x, item.box.y, item.box.width, item.box.height);
            ctx.globalAlpha = 1;
          } else {
            ctx.fillStyle = 'rgba(47, 109, 179, 0.18)';
            ctx.fillRect(item.box.x, item.box.y, item.box.width, item.box.height);
          }
        }
        if (showSeats.checked && sceneState.seats.length > 0) {
          ctx.fillStyle = '#1d8a4e';
          for (const seat of sceneState.seats) {
            ctx.beginPath();
            ctx.arc(seat.point.x * scene.width, seat.point.y * scene.height, 6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (showGraph.checked && sceneState.graphNodes && sceneState.graphNodes.length) {
          ctx.strokeStyle = 'rgba(47, 109, 179, 0.5)';
          ctx.lineWidth = 2;
          const byId = new Map(sceneState.graphNodes.map((node) => [node.id, node]));
          for (const edge of sceneState.graphEdges || []) {
            const a = byId.get(edge.from);
            const b = byId.get(edge.to);
            if (!a || !b) continue;
            ctx.beginPath();
            ctx.moveTo(a.position.x * scene.width, a.position.y * scene.height);
            ctx.lineTo(b.position.x * scene.width, b.position.y * scene.height);
            ctx.stroke();
          }
          ctx.fillStyle = 'rgba(47, 109, 179, 0.9)';
          for (const node of sceneState.graphNodes) {
            ctx.beginPath();
            ctx.arc(node.position.x * scene.width, node.position.y * scene.height, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (selectedId) {
          const item = items.find((entry) => entry.id === selectedId);
          if (item && item.box) {
            ctx.strokeStyle = '#2f6db3';
            ctx.lineWidth = 3;
            ctx.setLineDash([8, 5]);
            ctx.strokeRect(item.box.x, item.box.y, item.box.width, item.box.height);
            ctx.setLineDash([]);
            ctx.fillStyle = '#2f6db3';
            ctx.font = '20px -apple-system, sans-serif';
            ctx.fillText(item.id, item.box.x, Math.max(20, item.box.y - 6));
          }
        }
      }

      // A result of something you DID stays readable. The default (live-selection) write is
      // suppressed for a few seconds after an explicit one, because a content change — the
      // very change you just made — triggers the hot-reload refresh, which re-reads the draft
      // and used to wipe "已放进布局：沙发" within a second (the R1 probe caught it).
      let canvasStatusStickyUntil = 0;
      function setCanvasStatus(extra = null) {
        const item = selectedId ? effectiveItems().find((entry) => entry.id === selectedId) : null;
        if (extra) {
          canvasStatusStickyUntil = Date.now() + 5000;
          canvasStatus.textContent = extra;
          canvasStatus.className = `wb-hint ${/违规|拒绝|失败/.test(extra) ? 'bad' : /预览|未保存/.test(extra) ? 'warn' : ''}`;
        } else {
          if (Date.now() < canvasStatusStickyUntil) { selectionLabel.textContent = item ? `${item.id} · ${item.kind}` : ''; return; }
          canvasStatus.className = 'wb-hint';
          canvasStatus.textContent = item
            ? t('scene.canvasStatusSelected', {
              id: item.id, asset: item.asset,
              x: item.position.x.toFixed(3), y: item.position.y.toFixed(3), pending: pending.size,
            })
            : t('scene.canvasStatusNone') + (pending.size ? t('scene.canvasStatusPending', { pending: pending.size }) : '');
        }
        selectionLabel.textContent = item ? t('scene.selectionLabel', { id: item.id, kind: item.kind }) : '';
        scaleLabel.textContent = (item && item.scale ? item.scale : 1).toFixed(2);
      }

      function canvasPointFromEvent(event) {
        const rect = canvas.getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) / rect.width) * sceneState.scene.width,
          y: ((event.clientY - rect.top) / rect.height) * sceneState.scene.height,
        };
      }

      function hitTest(point) {
        for (const item of [...effectiveItems()].sort((a, b) => (b.layer || 0) - (a.layer || 0))) {
          if (!item.box || item.hidden) continue;
          if (point.x >= item.box.x && point.x <= item.box.x + item.box.width
            && point.y >= item.box.y && point.y <= item.box.y + item.box.height) return item;
        }
        return null;
      }

      // record a pending edit and re-validate the WHOLE pending set (dry run)
      // ---- unsaved drafts survive a reload (T5) -------------------------------
      //
      // The pending edits are the one piece of work that exists NOWHERE else: not on disk,
      // not in a file — until now they died with the page. They go to the session store
      // (debounced 500ms inside it) and come back on boot with an explicit notice.
      function persistSceneDraft() {
        if (!session || !sceneState) return;
        session.patch('scene', {
          sceneId: sceneState.sceneId,
          selectedId: selectedId || null,
          pending: [...pending.entries()].map(([itemId, patch]) => ({ itemId, ...patch })),
        });
      }
      async function restoreSceneDraft() {
        if (!session || !sceneState) return { ok: false, code: 'STORE_UNAVAILABLE' };
        if (!sessionRestore.ok && sessionRestore.code === 'STORE_EMPTY') return { ok: false, code: 'STORE_EMPTY' };
        const draft = session.get('scene');
        if (!draft || !Array.isArray(draft.pending) || draft.pending.length === 0) return { ok: false, code: 'STORE_EMPTY' };
        if (draft.sceneId && draft.sceneId !== sceneState.sceneId) return { ok: false, code: 'STORE_OTHER_SCENE' };
        pending.clear();
        for (const entry of draft.pending) {
          const { itemId, ...patch } = entry;
          if (sceneState.items.some((item) => item.id === itemId)) pending.set(itemId, patch);
        }
        selectedId = draft.selectedId && sceneState.items.some((item) => item.id === draft.selectedId) ? draft.selectedId : null;
        renderCanvas();
        setCanvasStatus(t('scene.canvasStatusRestored', { pending: pending.size }));
        return { ok: true, restored: pending.size };
      }

      // A snapshot is everything the transaction needs to reproduce a draft item: the
      // layout file is small (38 items), so a whole-draft snapshot per edit costs nothing
      // and keeps the undo honest — restore replays through the SAME validator.
      function sceneSnapshot() {
        if (!sceneState) return null;
        return sceneState.items.map((item) => ({
          id: item.id, kind: item.kind, asset: item.asset, direction: item.direction ?? 'front',
          layer: item.layer ?? 30, hidden: Boolean(item.hidden),
          position: { x: item.position.x, y: item.position.y }, scale: item.scale ?? 1,
        }));
      }
      function rememberScene(label) {
        const before = sceneSnapshot();
        return () => {
          const after = sceneSnapshot();
          if (!before || !after || JSON.stringify(before) === JSON.stringify(after)) return null;
          // through the controller, not the raw stack: that is what keeps the top bar's
          // ↶/↷ in sync with every push
          return historyController ? historyController.push({ label, before, after, meta: { page: 'scene' } }) : null;
        };
      }
      // A MOVE is one step per gesture, not per pointermove and not per arrow keypress:
      // rememberScene() captures the draft BEFORE the change and returns the commit that
      // pushes {before, after}. A drag commits on pointerup; a burst of arrow nudges
      // coalesces into one step that commits MOVE_COALESCE_MS after the last press (a
      // 0.005 nudge is not something anyone wants to undo forty times). flushMoveStep()
      // runs first in every other history path, so a move never lands on the stack AFTER
      // the save that included it.
      const MOVE_COALESCE_MS = 900;
      let moveStep = null;   // { commit, timer }
      function beginMoveStep(label) {
        flushMoveStep();
        moveStep = { commit: rememberScene(label), timer: null };
      }
      function extendMoveStep() {
        if (!moveStep) return;
        if (moveStep.timer) clearTimeout(moveStep.timer);
        moveStep.timer = setTimeout(flushMoveStep, MOVE_COALESCE_MS);
      }
      function flushMoveStep() {
        if (!moveStep) return;
        const { commit, timer } = moveStep;
        moveStep = null;
        if (timer) clearTimeout(timer);
        commit();
      }
      // Restoring a snapshot is an EDIT, not a bypass: build the diff and send it through
      // sceneEdit (dry run → validator → backup → write).
      async function restoreScene(snapshot, label, direction = 'undo') {
        if (!sceneState || !Array.isArray(snapshot)) return { ok: false, code: 'RESTORE_NO_BASE' };
        const current = new Map(sceneState.items.map((item) => [item.id, item]));
        const wanted = new Map(snapshot.map((item) => [item.id, item]));
        const edits = [];
        for (const item of snapshot) {
          const now = current.get(item.id);
          if (!now) {
            edits.push({ add: { id: item.id, kind: item.kind, asset: item.asset, direction: item.direction, layer: item.layer, position: item.position, scale: item.scale } });
            continue;
          }
          const patch = {};
          if (Math.abs(now.position.x - item.position.x) > 1e-9 || Math.abs(now.position.y - item.position.y) > 1e-9) patch.position = item.position;
          if (Math.abs((now.scale ?? 1) - item.scale) > 1e-9) patch.scale = item.scale;
          if (Boolean(now.hidden) !== Boolean(item.hidden)) patch.hidden = item.hidden;
          if ((now.layer ?? 30) !== item.layer) patch.layer = item.layer;
          if (Object.keys(patch).length > 0) edits.push({ itemId: item.id, ...patch });
        }
        for (const item of sceneState.items) if (!wanted.has(item.id)) edits.push({ itemId: item.id, remove: true });
        if (edits.length === 0) return { ok: true, noop: true };
        const trial = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits, save: false });
        if (!trial.ok) {
          setCanvasStatus(t('scene.canvasStatusRefused', { label, code: trial.code, codes: (trial.violations || []).map((v) => v.code).slice(0, 3).join('、') }));
          return trial;
        }
        const written = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits, save: true });
        if (!written.ok) { setCanvasStatus(t('scene.canvasStatusRefused', { label, code: written.code, codes: '' })); return written; }
        pending.clear();
        await loadSceneDraft();
        renderCanvas();
        // the direction is a parameter, not a label comparison: in English the label
        // reads "Undo"/"Redo", and `label === '撤销'` quietly took the wrong branch
        setCanvasStatus(`${label} ✓ ${direction === 'undo' ? t('scene.canvasStatusUndone') : t('scene.canvasStatusRedone')}`);
        // the snapshot rewrote the draft under the form: refill, or the panel keeps showing
        // the values the step just replaced
        syncItemPanel();
        const report = await studio.sceneReport({});
        renderSceneReport(report);
        return written;
      }
      // gap #1: the scene page REGISTERS its replay with the shared controller instead
      // of replacing the shell's ⌘Z handler. The controller pops the stack, sees
      // meta.page === 'scene' and hands the entry here; the empty-stack case never
      // reaches a page, so the shell dispatches wb:history-empty and this page answers
      // it on its own status line (below).
      historyController?.register('scene', async (entry, direction) => {
        const target = direction === 'undo' ? entry.before : entry.after;
        const label = direction === 'undo' ? t('scene.historyLabelUndo') : t('scene.historyLabelRedo');
        return restoreScene(target, label, direction);
      });
      window.addEventListener('wb:history-empty', (event) => {
        const direction = event.detail && event.detail.direction;
        setCanvasStatus(direction === 'redo' ? t('scene.canvasStatusRedoNone') : t('scene.canvasStatusUndoNone'));
      });
      window.__wbHistory = {
        history,
        controller: historyController,
        sceneSnapshot,
        restoreScene,
        historyStep,
        rememberScene,
      };

      async function stageEdit(itemId, patch) {
        const current = pending.get(itemId) || {};
        pending.set(itemId, { ...current, ...patch });
        renderCanvas();
        const edits = [...pending.entries()].map(([id, value]) => ({ itemId: id, ...value }));
        const outcome = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits, save: false });
        if (!outcome.ok) {
          const reds = (outcome.violations || []).filter((violation) => violation.severity === 'red');
          const codes = [...new Set(reds.map((violation) => violation.code))].slice(0, 3).join('、');
          setCanvasStatus(t('scene.canvasStatusProblem', { code: outcome.code, codes: codes ? `（${codes}）` : '' }));
          if (outcome.report) renderSceneReport({ ...outcome.report, ok: false });
          return outcome;
        }
        setCanvasStatus(t('scene.canvasStatusStaged', { pending: pending.size }));
        persistSceneDraft();
        if (outcome.report) renderSceneReport(outcome.report);
        return outcome;
      }

      // a problem in the bottom strip can name the item it is about: selecting it here keeps
      // the jump self-contained (the strip does not know how the canvas works)
      window.addEventListener('wb:select-item', (event) => {
        const itemId = event.detail && event.detail.itemId;
        if (!sceneState || !itemId) return;
        if (!effectiveItems().some((item) => item.id === itemId)) return;
        selectedId = itemId;
        renderCanvas();
        setCanvasStatus();
      });

      canvas.addEventListener('pointerdown', (event) => {
        if (!sceneState) return;
        const point = canvasPointFromEvent(event);
        const item = hitTest(point);
        if (!item) { selectedId = null; renderCanvas(); setCanvasStatus(); syncItemPanel(); return; }
        selectedId = item.id;
        const items = effectiveItems();
        const current = items.find((entry) => entry.id === item.id);
        dragState = {
          itemId: item.id,
          grab: { x: point.x - current.position.x * sceneState.scene.width, y: point.y - current.position.y * sceneState.scene.height },
        };
        // the drag's undo step opens HERE (before anything moves); a click that moves
        // nothing commits a no-op, which rememberScene's own comparison discards
        beginMoveStep(t('scene.historyMove'));
        try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic events carry no pointerId */ }
        renderCanvas();
        setCanvasStatus();
        syncItemPanel();
      });

      canvas.addEventListener('pointermove', (event) => {
        if (!dragState || !sceneState) return;
        const point = canvasPointFromEvent(event);
        const x = Math.min(1, Math.max(0, (point.x - dragState.grab.x) / sceneState.scene.width));
        const y = Math.min(1, Math.max(0, (point.y - dragState.grab.y) / sceneState.scene.height));
        const current = pending.get(dragState.itemId) || {};
        pending.set(dragState.itemId, { ...current, position: { x, y } });
        renderCanvas();
        setCanvasStatus(t('scene.canvasStatusDragging', { id: dragState.itemId, x: x.toFixed(3), y: y.toFixed(3) }));
      });

      canvas.addEventListener('pointerup', async () => {
        if (!dragState) return;
        const itemId = dragState.itemId;
        dragState = null;
        const staged = pending.get(itemId);
        if (staged && staged.position) await stageEdit(itemId, { position: staged.position });
        // the gesture is over: one drag = one undo step
        flushMoveStep();
        syncItemPanel();
      });

      canvas.addEventListener('keydown', async (event) => {
        if (!selectedId || !sceneState) return;
        const items = effectiveItems();
        const item = items.find((entry) => entry.id === selectedId);
        if (!item) return;
        const step = event.shiftKey ? 0.05 : 0.005;
        const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
        if (!deltas[event.key]) return;
        event.preventDefault();
        // the first press of a burst opens the step, every press extends it: a run of
        // nudges coalesces into ONE undoable step
        if (!moveStep) beginMoveStep(t('scene.historyMove'));
        extendMoveStep();
        const [dx, dy] = deltas[event.key];
        await stageEdit(item.id, { position: { x: item.position.x + dx, y: item.position.y + dy } });
        syncItemPanel();
      });

      document.getElementById('btn-canvas-reload').addEventListener('click', async () => {
        // an in-flight move burst would otherwise commit a step whose "after" is the
        // reloaded file — the reload drops pending, so the burst ends here
        flushMoveStep();
        await loadSceneDraft();
        renderCanvas();
        session?.clean('scene');
        setCanvasStatus(t('scene.canvasStatusReloaded'));
        syncItemPanel();
      });

      document.getElementById('btn-canvas-save').addEventListener('click', async () => {
        if (!sceneState) return;
        if (pending.size === 0) { setCanvasStatus(t('scene.canvasStatusNoPending')); return; }
        // the moves that led here commit FIRST, so the stack reads: … → 移动 → 保存
        flushMoveStep();
        const commitHistory = rememberScene(t('scene.historySave', { count: pending.size }));
        const edits = [...pending.entries()].map(([id, value]) => ({ itemId: id, ...value }));
        const outcome = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits, save: true });
        if (!outcome.ok) {
          const codes = [...new Set((outcome.violations || []).map((violation) => violation.code))].slice(0, 4).join('、');
          setCanvasStatus(t('scene.canvasStatusSaveRefused', { code: outcome.code, codes }));
          if (outcome.report) renderSceneReport({ ...outcome.report, ok: false });
          return;
        }
        const count = edits.length;
        await loadSceneDraft();
        renderCanvas();
        setCanvasStatus(t('scene.canvasStatusSaved', {
          count,
          backup: outcome.backup ? outcome.backup.split('/').pop() : t('scene.canvasStatusBackupNone'),
        }));
        session?.clean('scene');
        commitHistory();
        const report = await studio.sceneReport({});
        renderSceneReport(report);
        // the write re-serializes the file, so the stored numbers the form displays are
        // worth re-reading: it now shows the saved values, not the draft ones
        syncItemPanel();
      });

      document.getElementById('btn-canvas-remove').addEventListener('click', async () => {
        if (!selectedId) { setCanvasStatus(t('scene.canvasStatusNoSelection')); return; }
        flushMoveStep();
        const commitHistory = rememberScene(t('scene.historyRemove'));
        const item = effectiveItems().find((entry) => entry.id === selectedId);
        if (!item) { setCanvasStatus(t('scene.canvasStatusGone')); return; }
        const trial = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits: [{ itemId: item.id, remove: true }], save: false });
        if (!trial.ok) {
          const codes = [...new Set((trial.violations || []).map((violation) => violation.code))].slice(0, 3).join('、');
          setCanvasStatus(t('scene.canvasStatusDeleteRefused', { code: trial.code, codes: codes ? `（${codes}）` : '' }));
          if (trial.report) renderSceneReport({ ...trial.report, ok: false });
          return;
        }
        const written = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits: [{ itemId: item.id, remove: true }], save: true });
        if (!written.ok) { setCanvasStatus(t('scene.canvasStatusDeleteRefused', { code: written.code, codes: '' })); return; }
        selectedId = null;
        await loadSceneDraft();
        renderCanvas();
        setCanvasStatus(t('scene.canvasStatusRemoved', {
          id: item.id, kind: item.kind,
          backup: written.backup ? written.backup.split('/').pop() : t('scene.canvasStatusBackupNone'),
        }));
        commitHistory();
        const report = await studio.sceneReport({});
        renderSceneReport(report);
        syncItemPanel();
      });

      document.getElementById('btn-canvas-hide').addEventListener('click', async () => {
        if (!selectedId) { setCanvasStatus(t('scene.canvasStatusNoSelection')); return; }
        const item = effectiveItems().find((entry) => entry.id === selectedId);
        await stageEdit(item.id, { hidden: !item.hidden });
        syncItemPanel();
      });
      document.getElementById('btn-canvas-smaller').addEventListener('click', async () => {
        if (!selectedId) { setCanvasStatus(t('scene.canvasStatusNoSelection')); return; }
        const item = effectiveItems().find((entry) => entry.id === selectedId);
        await stageEdit(item.id, { scale: Math.max(0.2, (item.scale || 1) * 0.95) });
        syncItemPanel();
      });
      document.getElementById('btn-canvas-bigger').addEventListener('click', async () => {
        if (!selectedId) { setCanvasStatus(t('scene.canvasStatusNoSelection')); return; }
        const item = effectiveItems().find((entry) => entry.id === selectedId);
        await stageEdit(item.id, { scale: Math.min(3, (item.scale || 1) * 1.05) });
        syncItemPanel();
      });

      // ---- the selected item's property panel (T6) ----
      //
      // Typing a value is the other half of "drag it on the canvas": the form reads the
      // item the canvas has selected — PENDING values folded in, so it always shows what
      // the canvas DRAWS, not what is on disk — and 应用 sends the patch through the SAME
      // stageEdit() the pointer, the arrow keys and the buttons above use (dry run →
      // validate → redraw → report in #canvas-status). The panel never touches the file:
      // 保存布局 stays the only writer, which is why applying is a deliberate press and
      // not an input event — a half-typed number can never reach the layout.
      // the same clamps the canvas uses: normalized 0..1 position, 0.2..3 scale (the ±
      // buttons step between exactly these bounds) and an INTEGER layer (the draw order)
      const ITEM_LIMITS = {
        position: { min: 0, max: 1 },
        scale: { min: 0.2, max: 3 },
        layer: { min: -9999, max: 9999, integer: true },
      };
      // the item the form is showing, and the EXACT strings it was filled with
      let panelItem = null;
      let panelFilled = {};

      // gap #2: the layer is DEPTH, and "45" alone does not say what covers what. The
      // band line under the field names the band a layer lands in, using the schema's
      // own five defaults (lib/depth-bands.js). It reads the FIELD, not the item, so
      // it answers while a value is being typed — it is a readout and stages nothing.
      const BAND_LABEL = {
        monitor: () => t('item.band.monitor'),
        chair: () => t('item.band.chair'),
        prop: () => t('item.band.prop'),
        character: () => t('item.band.character'),
        desk: () => t('item.band.desk'),
      };
      function renderLayerBand() {
        if (!itemLayerBand) return;
        const bands = window.wbDepthBands;
        const text = propLayer.value.trim();
        const value = text === '' ? NaN : Number(text);
        const band = bands && Number.isFinite(value) ? bands.bandOf(value) : null;
        if (!band) { itemLayerBand.textContent = t('item.bandLadder'); return; }
        if (band.kind === 'on') {
          itemLayerBand.textContent = t('item.bandOn', { layer: value, band: BAND_LABEL[band.band.kind](), bandLayer: band.band.layer });
        } else if (band.kind === 'between') {
          itemLayerBand.textContent = t('item.bandBetween', {
            layer: value, low: BAND_LABEL[band.band.kind](), lowLayer: band.band.layer,
            high: BAND_LABEL[band.above.kind](), highLayer: band.above.layer,
          });
        } else if (band.kind === 'front') {
          itemLayerBand.textContent = t('item.bandFront', { layer: value, band: BAND_LABEL[band.band.kind](), bandLayer: band.band.layer });
        } else {
          itemLayerBand.textContent = t('item.bandBelow', { layer: value, above: BAND_LABEL[band.above.kind](), aboveLayer: band.above.layer });
        }
      }

      // the selection, with pending folded in: the form shows the draft as drawn
      function currentItem() {
        if (!selectedId || !sceneState) return null;
        return effectiveItems().find((entry) => entry.id === selectedId) || null;
      }

      // Fill the form from the selection. With nothing selected the form gives way to a
      // one-line hint — an empty form invites typing into nothing.
      function syncItemPanel() {
        if (!sceneState) return;
        panelItem = currentItem();
        if (!panelItem) {
          panelFilled = {};
          itemNone.hidden = false;
          itemBody.hidden = true;
          itemMeta.textContent = '';
          itemStatus.textContent = '';
          if (itemLayerBand) itemLayerBand.textContent = '';
          return;
        }
        itemNone.hidden = true;
        itemBody.hidden = false;
        itemMeta.textContent = `${panelItem.id} · ${panelItem.kind} · ${panelItem.asset}`
          + `${pending.has(panelItem.id) ? ` · ${t('item.pending')}` : ''}`;
        panelFilled = {
          x: panelItem.position.x.toFixed(4),
          y: panelItem.position.y.toFixed(4),
          scale: (panelItem.scale ?? 1).toFixed(2),
          layer: String(panelItem.layer ?? 30),
          name: panelItem.name || '',
        };
        propX.value = panelFilled.x;
        propY.value = panelFilled.y;
        propScale.value = panelFilled.scale;
        propLayer.value = panelFilled.layer;
        propName.value = panelFilled.name;
        propHidden.checked = Boolean(panelItem.hidden);
        itemStatus.textContent = '';
        renderLayerBand();
      }

      // Read one number field with the canvas' own clamps. An empty or non-numeric field
      // is not a move: it keeps the value the item already has and the status line says so.
      // An untouched field (still the string we filled in) submits the EXACT stored
      // number — the display is rounded to four decimals, and applying THAT would stage a
      // move of its own (0.544413 → 0.5444).
      function readNumber(input, key, { min, max, integer = false }) {
        const stored = key === 'x' ? panelItem.position.x
          : key === 'y' ? panelItem.position.y
            : key === 'scale' ? (panelItem.scale ?? 1)
              : (panelItem.layer ?? 30);
        const text = input.value.trim();
        if (text === '' || text === panelFilled[key]) return { value: stored };
        const typed = Number(text);
        if (!Number.isFinite(typed)) return { value: stored, ignored: true };
        const rounded = integer ? Math.round(typed) : typed;
        const clamped = (integer && rounded !== typed) || rounded < min || rounded > max;
        return { value: Math.min(max, Math.max(min, rounded)), clamped };
      }

      // 应用: collect the form, clamp it the way the canvas does, then hand the patch to
      // stageEdit() — staged, dry-run validated, drawn immediately, reported in
      // #canvas-status, and still waiting for 保存布局 to reach the disk. The typed
      // values are an edit like any other, so they open an undo step (a refused apply
      // changes nothing and rememberScene's comparison discards the empty step).
      async function applyItemProps() {
        const item = currentItem();
        if (!item) { setCanvasStatus(t('scene.canvasStatusNoSelection')); return; }
        panelItem = item;
        flushMoveStep();
        const commitHistory = rememberScene(t('scene.historyProps'));
        const x = readNumber(propX, 'x', ITEM_LIMITS.position);
        const y = readNumber(propY, 'y', ITEM_LIMITS.position);
        const scale = readNumber(propScale, 'scale', ITEM_LIMITS.scale);
        const layer = readNumber(propLayer, 'layer', ITEM_LIMITS.layer);
        // the name has no patch in the scene transaction (sceneEdit takes position /
        // scale / hidden / layer only): refuse rather than drop a typed value on the floor
        const name = propName.value.trim();
        if (name !== (item.name || '') && name !== panelFilled.name) {
          itemStatus.textContent = t('item.nameLocked');
          itemStatus.className = 'wb-hint bad';
          return;
        }
        const patch = {};
        if (Math.abs(x.value - item.position.x) > 1e-9 || Math.abs(y.value - item.position.y) > 1e-9) patch.position = { x: x.value, y: y.value };
        if (Math.abs(scale.value - (item.scale ?? 1)) > 1e-9) patch.scale = scale.value;
        if (layer.value !== (item.layer ?? 30)) patch.layer = layer.value;
        if (propHidden.checked !== Boolean(item.hidden)) patch.hidden = propHidden.checked;
        if (Object.keys(patch).length === 0) {
          syncItemPanel();
          itemStatus.textContent = t('item.noChange');
          itemStatus.className = 'wb-hint';
          // nothing changed: the step stays empty and rememberScene discards it
          commitHistory();
          return;
        }
        const outcome = await stageEdit(item.id, patch);
        commitHistory();
        syncItemPanel();
        const notes = [];
        if (x.clamped || y.clamped || scale.clamped || layer.clamped) notes.push(t('item.clamped'));
        if (x.ignored || y.ignored || scale.ignored || layer.ignored) notes.push(t('item.ignored'));
        notes.unshift(outcome.ok ? t('item.applied') : t('item.refused'));
        itemStatus.textContent = notes.join(' · ');
        itemStatus.className = `wb-hint${outcome.ok ? '' : ' bad'}`;
      }

      document.getElementById('item-prop-apply').addEventListener('click', () => {
        applyItemProps().catch((error) => {
          itemStatus.textContent = t('item.crashed', { message: String((error && error.message) || error) });
          itemStatus.className = 'wb-hint bad';
        });
      });
      document.getElementById('item-prop-reset').addEventListener('click', () => {
        // throw away what is half-typed and show the item as it stands right now
        syncItemPanel();
        itemStatus.textContent = t('item.refill');
        itemStatus.className = 'wb-hint';
      });
      // Enter in a field applies too — a deliberate press, not a keystroke. novalidate
      // keeps the browser's own min/max bubble from swallowing the submit before our
      // (clamping, not refusing) validation runs.
      itemForm.addEventListener('submit', (event) => { event.preventDefault(); applyItemProps(); });
      // the band line follows the layer FIELD as it is typed: a readout, never a
      // staged edit (nothing here touches the draft — 应用 stays the only writer)
      propLayer.addEventListener('input', renderLayerBand);

      for (const toggle of [showGraph, showObstacles, showSeats]) {
        toggle.addEventListener('change', async () => {
          if (showGraph.checked && sceneState && !sceneState.graphNodes) {
            const graph = await studio.sceneWaypoints({});
            if (graph.ok) { sceneState.graphNodes = graph.nodes; sceneState.graphEdges = graph.edges; }
          }
          renderCanvas();
        });
      }

      // A furniture drop is an ADD through the same transaction as a move: dry-run first
      // (the panel shows what the validator says), then write, then re-read. A red result
      // is refused with its reasons — the drop never bypasses the gate.
      stage.setFurnitureDropHandler(async (assetId, point) => {
        flushMoveStep();
        const commitHistory = rememberScene(t('scene.historyDrop', { asset: assetId }));
        const row = (libraryRows || []).find((entry) => entry.asset === assetId);
        if (!row) {
          if (String(assetId).startsWith('characters/')) return stage.handleDrop(assetId, null);
          setStatus(t('scene.libraryMissing', { asset: assetId }));
          return { ok: false, code: 'FURNITURE_UNKNOWN', asset: assetId };
        }
        if (!sceneState) await loadSceneDraft();
        const position = point && Number.isFinite(point.x)
          ? { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) }
          : { x: 0.5, y: 0.5 };
        const edit = { add: { kind: row.kind, asset: row.asset, direction: row.direction, layer: 30, position } };
        const trial = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits: [edit], save: false });
        if (!trial.ok) {
          const codes = [...new Set((trial.violations || []).map((violation) => violation.code))].slice(0, 3).join('、');
          setCanvasStatus(t('scene.canvasStatusDropRefused', { code: trial.code, codes: codes ? `（${codes}）` : '' }));
          if (trial.report) renderSceneReport({ ...trial.report, ok: false });
          return { ok: false, code: trial.code || 'ADD_REFUSED', violations: trial.violations || [] };
        }
        const written = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits: [edit], save: true });
        if (!written.ok) {
          setCanvasStatus(t('scene.canvasStatusDropRefused', { code: written.code, codes: '' }));
          return { ok: false, code: written.code || 'ADD_REFUSED' };
        }
        await loadSceneDraft();
        renderCanvas();
        setCanvasStatus(t('scene.canvasStatusDropped', {
          label: row.label, asset: row.asset,
          x: position.x.toFixed(3), y: position.y.toFixed(3),
          backup: written.backup ? written.backup.split('/').pop() : t('scene.canvasStatusBackupNone'),
        }));
        const report = await studio.sceneReport({});
        renderSceneReport(report);
        setStatus(t('scene.canvasStatusPlaced', {
          label: row.label,
          red: report.stats ? report.stats.red : '?', yellow: report.stats ? report.stats.yellow : '?',
        }));
        commitHistory();
        return { ok: true, kind: 'furniture', asset: row.asset, itemId: (written.applied || []).map((entry) => entry.itemId)[0] || null };
      });

      let dragState = null;
      canvas.tabIndex = 0;

      // ---- gap #5: the drag landing preview ------------------------------------
      //
      // Before: you dragged a sofa, you let go, and only then did the validator say
      // no. Now the ghost answers first: a semi-transparent copy of the art at the
      // EXACT box the transaction would give it (the catalog's own draft width and
      // content box — the same numbers artBoxPx uses), coloured by the dry-run
      // verdict at that spot. A red ghost is the validator's refusal, seen before
      // the hand commits; the drop itself is unchanged and still the only writer.
      //
      // The dry run is the drop's own edit (add at the clamped, grid-snapped point)
      // with save:false — a read. It is cached per (asset, snapped point), because
      // dragover fires far more often than the answer changes.
      const dragGhost = document.getElementById('scene-drag-ghost');
      const dragVerdicts = new Map();   // `${asset}@${x},${y}` → { ok, codes }
      let dragVerdictSeq = 0;           // drops a slow answer that a newer position superseded
      function ghostCatalogBox(row) {
        const catalog = window.wbLayoutCatalog;
        if (!catalog || !row) return null;
        const described = catalog.boxOf(row.asset);
        if (!described) return null;
        return { draftWidth: catalog.draftWidths ? catalog.draftWidths[described.kind] : null, bbox: described.contentBbox };
      }
      function ghostBoxForRow(row, point) {
        const described = ghostCatalogBox(row);
        const scene = sceneState ? sceneState.scene : { width: 1280, height: 840 };
        const position = {
          x: Math.min(1, Math.max(0, Number(point && point.x) || 0)),
          y: Math.min(1, Math.max(0, Number(point && point.y) || 0)),
        };
        const box = window.wbDropGhost
          ? window.wbDropGhost.ghostBoxFor({ draftWidth: described ? described.draftWidth : null, bbox: described ? described.bbox : null, position, scale: 1, scene })
          : null;
        return { box, position };
      }
      function hideDragGhostNow() {
        if (!dragGhost) return;
        dragGhost.hidden = true;
        dragGhost.classList.remove('bad');
        dragGhost.replaceChildren();
        dragVerdictSeq += 1;   // any in-flight dry run is now stale
        // the next drag starts from a clean slate: the content may have changed
        // under a cached verdict (a save, a hot reload)
        dragVerdicts.clear();
      }
      hideDragGhost = hideDragGhostNow;
      stage.setDragEndHandler(() => hideDragGhostNow());
      async function verdictFor(row, position) {
        // the transaction snaps to its own grid, so the cache key is the SNAPPED
        // point: sub-grid movement cannot change the answer
        const snap = (value) => (Math.round(value / 0.005) * 0.005).toFixed(3);
        const key = `${row.asset}@${snap(position.x)},${snap(position.y)}`;
        if (dragVerdicts.has(key)) return dragVerdicts.get(key);
        const edit = { add: { kind: row.kind, asset: row.asset, direction: row.direction, layer: 30, position } };
        const outcome = await studio.sceneEdit({ sceneId: sceneState.sceneId, edits: [edit], save: false });
        const verdict = outcome.ok
          ? { ok: true }
          : { ok: false, code: outcome.code, codes: [...new Set((outcome.violations || []).filter((violation) => violation.severity === 'red').map((violation) => violation.code))].slice(0, 3).join('、') };
        dragVerdicts.set(key, verdict);
        return verdict;
      }
      async function showDragGhost(row, point) {
        if (!dragGhost || !sceneState || !row) return;
        const { box, position } = ghostBoxForRow(row, point);
        if (!box) return;
        if (dragGhost.firstElementChild === null || dragGhost.dataset.asset !== row.asset) {
          const img = document.createElement('img');
          img.src = row.url;
          img.alt = '';
          img.draggable = false;
          dragGhost.replaceChildren(img);
          dragGhost.dataset.asset = row.asset;
        }
        dragGhost.hidden = false;
        dragGhost.style.left = `${box.x}px`;
        dragGhost.style.top = `${box.y}px`;
        dragGhost.style.width = `${box.width}px`;
        dragGhost.style.height = `${box.height}px`;
        // the verdict is per (asset, point): a superseded answer must not recolour
        // the ghost the user is looking at now
        const seq = (dragVerdictSeq += 1);
        try {
          const verdict = await verdictFor(row, position);
          if (seq !== dragVerdictSeq || dragGhost.hidden) return;
          dragGhost.classList.toggle('bad', !verdict.ok);
          setCanvasStatus(verdict.ok
            ? t('scene.dropPreviewOk', { label: row.label })
            : t('scene.dropPreviewRefused', { label: row.label, code: verdict.code, codes: verdict.codes ? `（${verdict.codes}）` : '' }));
        } catch (error) {
          if (seq !== dragVerdictSeq) return;
          dragGhost.classList.remove('bad');
          setCanvasStatus(t('scene.dropPreviewFailed', { message: error.message }));
        }
      }
      stage.setDragPreviewHandler((row, point) => {
        showDragGhost(row, point).catch(() => {});
      });
      panelRefresh.set('tab-scene', async () => {
        // 脏则跳过刷新并提示 (T5): a content change from outside must not silently throw away
        // the user's unsaved edits — say so instead, and let them decide.
        if (pending.size > 0) {
          setCanvasStatus(t('scene.canvasStatusDirtySkip', { pending: pending.size }));
          return;
        }
        refreshSceneReport().catch(() => {});
        await loadSceneDraft();
        renderCanvas();
        setCanvasStatus();
        syncItemPanel();
      });
      loadSceneDraft()
        .then(() => restoreSceneDraft())
        .then((outcome) => {
          // the restored session carries its own selectedId: the form follows it, or the
          // panel would sit empty next to a canvas that already has a selection
          if (!outcome.ok) { renderCanvas(); setCanvasStatus(); syncItemPanel(); }
          else syncItemPanel();
        })
        .catch((error) => { canvasStatus.textContent = t('scene.canvasStatusLoadFailed', { message: error.message }); });
    }

    // ---- right pane: the review bench (P3) -----------------------------------
    const benchUnavailable = document.getElementById('bench-unavailable');
    const benchBody = document.getElementById('bench-body');
    if (!studio || !studio.actionBench) {
      benchUnavailable.hidden = false;
      benchBody.hidden = true;
      // the legacy entry has no real publish kernel and no migration: the danger zone's
      // bench buttons say so instead of doing nothing on a click
      for (const id of ['btn-bench-migrate', 'btn-bench-publish']) {
        const button = document.getElementById(id);
        if (button) {
          button.disabled = true;
          button.title = t('bench.legacyUnavailable');
        }
      }
    } else {
      const actionSelect = document.getElementById('bench-action');
      const summaryEl = document.getElementById('bench-summary');
      const stripEl = document.getElementById('bench-strip');
      const notesEl = document.getElementById('bench-notes');
      const gapsEl = document.getElementById('bench-gaps');
      gapsEl.textContent = t('bench.gapsIdle');
      const onionToggle = document.getElementById('bench-onion');
      const footToggle = document.getElementById('bench-footline');
      const centroidToggle = document.getElementById('bench-centroid');
      const pingToggle = document.getElementById('bench-pingpong');
      let benchState = null;

      // The 动作 page has ONE selected action: this sub-view reads and writes the same doc
      // the editor does, so a selection here carries the editor along (its list is the
      // content docs). A pack-only id has no doc, so the editor cannot follow and the
      // timeline stays on the doc it was last given — never a silent mix of two actions.
      const editorSelect = document.getElementById('action-select');
      function followEditorSelection(id) {
        if (!id || ![...editorSelect.options].some((option) => option.value === id)) return false;
        if (editorSelect.value !== id) editorSelect.value = id;
        readAction(id).catch((error) => setStatus(t('actions.loadFailed', { message: error.message })));
        return true;
      }

      function overlayFrame(frame, index, previous) {
        const box = document.createElement('div');
        box.className = `bench-frame${frame.ok ? '' : ' bad'}`;
        if (previous && onionToggle.checked) {
          const ghost = document.createElement('img');
          ghost.className = 'bench-ghost';
          ghost.src = previous.url;
          ghost.alt = '';
          box.appendChild(ghost);
        }
        const img = document.createElement('img');
        img.src = frame.url;
        img.alt = frame.basename;
        img.title = `${frame.basename}\n鞋线 ${frame.footLine}（Δ${frame.footLineDelta}）\n可见 ${frame.visibleWidth}×${frame.visibleHeight}\n质心 x=${frame.centroid ? frame.centroid.x : '-'} · 中位 x=${frame.medianX ?? '-'}`;
        box.appendChild(img);
        const scale = 352;
        if (footToggle.checked && frame.footLine !== null) {
          const line = document.createElement('span');
          line.className = 'bench-foot';
          line.style.top = `${(frame.footLine / scale) * 100}%`;
          box.appendChild(line);
        }
        const markers = [];
        if (centroidToggle.checked && frame.centroid) markers.push({ left: (frame.centroid.x / scale) * 100, cls: 'bench-centroid', label: `质心 x${frame.centroid.x}` });
        if (centroidToggle.checked && frame.medianX !== null) markers.push({ left: (frame.medianX / scale) * 100, cls: 'bench-median', label: `中位 x${frame.medianX}` });
        for (const marker of markers) {
          const dot = document.createElement('span');
          dot.className = `bench-marker ${marker.cls}`;
          dot.style.left = `${marker.left}%`;
          dot.title = marker.label;
          box.appendChild(dot);
        }
        const label = document.createElement('figcaption');
        label.textContent = `#${index} ${frame.basename.replace(/^walk-|^working-/, '').replace(/\.png$/, '')}`
          + `${frame.durationMs ? ` · ${frame.durationMs}ms` : ''}`
          + `${Math.abs(frame.footLineDelta || 0) > 0 ? ` · Δ${frame.footLineDelta}` : ''}`;
        box.appendChild(label);
        return box;
      }

      // ---- the shared timeline (T7) ---------------------------------------------
      //
      // This panel USED to own the second timeline: segments, playhead, scrub, play and
      // markers, rendered from the bench read. That was the duplicate of the editor's
      // frame cards, so the axis is now the page's single #bench-timeline (see the
      // actionTimeline module above) and this panel only feeds it what its own read
      // carries that the editor's does not: ping-pong, event frames and annotations.
      // The playhead is not touched here, so toggling an overlay cannot restart playback.

      function renderBench(bench) {
        benchState = bench;
        const s = bench.summary;
        summaryEl.textContent = t('bench.summary', { id: bench.actionId, schema: bench.schemaVersion, frames: s.frames, total: s.totalMs })
          + (s.pingPong ? t('bench.summaryPingPong', { cycle: s.cycleMs }) : '')
          + t('bench.summaryMedian', { median: bench.medianFootLine, declared: bench.declaredFootLine, tolerance: bench.tolerancePx })
          + t('bench.summaryRed', { red: bench.redFrames })
          + t('bench.summaryTags', { tags: s.tags.join(',') || t('bench.summaryNoTags') })
          + t('bench.summaryEvents', { events: s.events.length })
          + (bench.runtime.inSync ? t('bench.summaryInSync') : t('bench.summaryOutOfSync'));
        pingToggle.checked = s.pingPong === true;
        stripEl.replaceChildren();
        bench.frames.forEach((frame, index) => stripEl.appendChild(overlayFrame(frame, index, index > 0 ? bench.frames[index - 1] : null)));
        notesEl.replaceChildren();
        if (bench.notes.length === 0) {
          const hint = document.createElement('p');
          hint.className = 'wb-hint';
          hint.textContent = t('bench.notesEmpty');
          notesEl.appendChild(hint);
        }
        for (const note of bench.notes) {
          const row = document.createElement('div');
          row.className = `gallery-row ${note.resolved ? 'ok' : note.stale ? 'warn' : 'bad'}`;
          const name = document.createElement('span');
          name.className = 'name';
          name.textContent = t('bench.noteRow', {
            frame: note.frame, severity: note.severity,
            resolved: note.resolved ? t('bench.noteResolved') : '',
            stale: note.stale ? t('bench.noteStale') : '',
          });
          const text = document.createElement('span');
          text.className = 'delta';
          text.textContent = note.text;
          row.append(name, text);
          notesEl.appendChild(row);
        }
        // no renderTimeline() here on purpose: the shared timeline is fed in refreshBench(),
        // after both reads agree, so an overlay toggle cannot restart the playhead
      }

      async function refreshBench(actionId) {
        const id = actionId || actionSelect.value;
        if (!id) return null;
        const bench = await studio.actionBench(id);
        if (!bench.ok) { summaryEl.textContent = t('bench.loadFailed', { message: `${bench.code} ${bench.message || ''}` }); return null; }
        renderBench(bench);
        // the markers only this read carries (ping-pong, event frames, annotations), and the
        // frame-geometry findings that join the publish validation under the 'actions'
        // source in the problems strip
        actionTimeline.setMarkers({
          actionId: bench.actionId,
          pingPong: bench.summary.pingPong === true && bench.frames.length > 2,
          events: bench.summary.events || [],
          notes: bench.notes || [],
        });
        collectFrameGeometryProblems(bench);
        return bench;
      }

      async function loadActions(preferred) {
        const listed = await studio.actionList();
        actionSelect.replaceChildren();
        for (const row of listed.actions) {
          const option = document.createElement('option');
          option.value = row.id;
          option.textContent = `${row.id}${row.hasDoc ? '' : t('bench.optionPackOnly')}`;
          actionSelect.appendChild(option);
        }
        const target = preferred && listed.actions.some((row) => row.id === preferred) ? preferred : (listed.actions.find((row) => row.hasDoc) || listed.actions[0] || {}).id;
        if (target) {
          actionSelect.value = target;
          // the editor follows when it can (its list is the content docs; a pack-only id
          // has no doc to edit, and the timeline keeps the doc it was given)
          followEditorSelection(target);
          return refreshBench(target);
        }
        return null;
      }

      actionSelect.addEventListener('change', () => {
        followEditorSelection(actionSelect.value);
        refreshBench().catch((error) => { summaryEl.textContent = t('bench.loadFailed', { message: error.message }); });
      });
      document.getElementById('btn-bench-refresh').addEventListener('click', () => { refreshBench().catch((error) => { summaryEl.textContent = t('bench.loadFailed', { message: error.message }); }); });
      for (const toggle of [onionToggle, footToggle, centroidToggle]) {
        toggle.addEventListener('change', () => { if (benchState) renderBench(benchState); });
      }
      pingToggle.addEventListener('change', () => {
        studio.actionPingPong({ actionId: actionSelect.value, value: pingToggle.checked }).then((outcome) => {
          if (!outcome.ok) { summaryEl.textContent = t('bench.pingPongFailed', { message: `${outcome.code} ${outcome.message || ''}` }); return; }
          return refreshBench();
        }).catch((error) => { summaryEl.textContent = t('bench.pingPongFailed', { message: error.message }); });
      });
      // 迁移到 v2 — a PRODUCTION write (backup first), so it sits in the danger zone with a
      // two-click confirm
      function migrateSelectedAction() {
        return studio.actionMigrate(actionSelect.value).then((outcome) => {
          if (!outcome.ok) { summaryEl.textContent = t('bench.migrateFailed', { message: `${outcome.code} ${outcome.message || ''}` }); return; }
          summaryEl.textContent = outcome.noop ? t('bench.migrateNoop') : t('bench.migrated');
          return refreshBench();
        }).catch((error) => { summaryEl.textContent = t('bench.migrateFailed', { message: error.message }); });
      }
      // 发布（真发布内核）— the strongest write in the page, so it is the last button of the
      // danger zone and also needs the second click
      function publishBenchAction() {
        return studio.actionPublish(actionSelect.value).then((outcome) => {
          if (!outcome.ok) {
            summaryEl.textContent = t('bench.publishRefused', { message: `${outcome.code} ${(outcome.violations || []).map((violation) => violation.check).join(', ')}` });
            return;
          }
          summaryEl.textContent = outcome.noop ? t('bench.publishNoop') : t('bench.published', { backup: outcome.summary.backupDirRelative });
          return refreshBench();
        }).catch((error) => { summaryEl.textContent = t('bench.publishFailed', { message: error.message }); });
      }
      wireDangerButton(document.getElementById('btn-bench-migrate'), migrateSelectedAction);
      wireDangerButton(document.getElementById('btn-bench-publish'), publishBenchAction);
      document.getElementById('btn-bench-note-add').addEventListener('click', () => {
        const frame = Number(document.getElementById('bench-note-frame').value);
        const text = document.getElementById('bench-note-text').value;
        const severity = document.getElementById('bench-note-severity').value;
        const current = benchState && benchState.frames[frame];
        studio.actionNoteAdd({ actionId: actionSelect.value, frame, text, severity, file: current ? current.file : null }).then((outcome) => {
          if (!outcome.ok) { summaryEl.textContent = t('bench.noteFailed', { message: `${outcome.code} ${outcome.message || ''}` }); return; }
          document.getElementById('bench-note-text').value = '';
          return refreshBench();
        }).catch((error) => { summaryEl.textContent = t('bench.noteFailed', { message: error.message }); });
      });
      document.getElementById('btn-bench-note-export').addEventListener('click', () => {
        studio.actionNotesExport({ actionId: actionSelect.value, out: `build/notes/${actionSelect.value}.notes.json` }).then((outcome) => {
          if (!outcome.ok) { summaryEl.textContent = t('bench.exportFailed', { message: outcome.code }); return; }
          summaryEl.textContent = t('bench.notesExported', { written: outcome.written, count: outcome.notes.length });
        }).catch((error) => { summaryEl.textContent = t('bench.exportFailed', { message: error.message }); });
      });
      document.getElementById('btn-bench-gaps').addEventListener('click', () => {
        studio.actionGaps().then((report) => {
          window.__wbProblems?.problems?.set('gaps', (report.capabilities || [])
            .filter((row) => row.status !== 'complete' && row.required)
            .map((row) => ({
              severity: 'yellow', code: `GAP_${row.id || row.label}`, message: `${row.label}（${row.status}）${row.how ? ` ↳ ${row.how}` : ''}`,
              target: { page: 'animation', tab: 'tab-bench' },
            })));
          gapsEl.textContent = report.capabilities.map((row) => {
            const mark = row.status === 'complete' ? '✔' : row.status === 'partial' ? '~' : '✗';
            return t('bench.gapRow', {
              mark, label: row.label, status: row.status,
              required: row.required ? t('bench.gapRequired') : '',
              present: row.present.map((entry) => entry.id).join(' ') || t('bench.gapNone'),
              how: row.how ? t('bench.gapHow', { how: row.how }) : '',
            });
          }).join('\n');
        }).catch((error) => { gapsEl.textContent = t('bench.gapsFailed', { message: error.message }); });
      });

      // The frame GEOMETRY read — the second half of the 'actions' source in the problems
      // strip (the publish validation's half comes from the editor's own read). Same target,
      // so a click on either half lands on the 动作 tab where the table lives.
      function collectFrameGeometryProblems(bench) {
        frameGeometryProblems = (bench.frames || [])
          .filter((frame) => (
            !frame.ok
            || frame.footLine === null
            || Math.abs((frame.footLine === null ? 0 : frame.footLine) - (bench.medianFootLine === null ? 0 : bench.medianFootLine)) > bench.tolerancePx
          ))
          .map((frame) => ({
            severity: 'red', code: frame.code || 'geometry.frame',
            message: t('bench.frameGeometry', {
              index: frame.index + 1, file: frame.basename,
              foot: frame.footLine === null ? '—' : frame.footLine, dFoot: frame.footLineDelta,
              tolerance: bench.tolerancePx,
            }),
            target: { page: 'animation', tab: 'tab-actions' },
          }));
        pushActionProblems();
      }

      // the editor's refreshActionList() calls this so one selection drives both sub-views
      benchFollow = (id) => refreshBench(id);
      panelRefresh.set('tab-bench', () => loadActions(actionSelect.value));
      loadActions(null).catch((error) => { summaryEl.textContent = t('bench.loadFailed', { message: error.message }); });
    }

    // ---- right pane: the behaviour-graph canvas (UI #2 · T8) ------------------
    const graphUnavailable = document.getElementById('graph-unavailable');
    const graphBody = document.getElementById('graph-body');
    if (!studio || !studio.graphList) {
      graphUnavailable.hidden = false;
      graphBody.hidden = true;
    } else {
      const graphCanvas = document.getElementById('graph-canvas');
      const graphCanvasWrap = document.getElementById('graph-canvas-wrap');
      const graphStatus = document.getElementById('graph-status');
      const graphFileSelect = document.getElementById('graph-file');
      const showPorts = document.getElementById('graph-show-ports');
      const zoomReadout = document.getElementById('graph-zoom');
      const runResult = document.getElementById('graph-run-result');
      runResult.textContent = t('graph.runIdle');
      const diffResult = document.getElementById('graph-diff-result');
      diffResult.textContent = t('graph.diffIdle');
      const addForm = document.getElementById('graph-add-form');
      const addType = document.getElementById('graph-add-type');
      const addId = document.getElementById('graph-add-id');
      // the inspector's node editor (#panel-item-graph, in #wb-right): the FIELDS live
      // there, not in the work area — the canvas is for dragging, the inspector is for
      // typing values, and both write the same draft
      const graphNodeNone = document.getElementById('graph-node-none');
      const graphNodeBody = document.getElementById('graph-node-body');
      const graphNodeMeta = document.getElementById('graph-node-meta');
      const graphNodeForm = document.getElementById('graph-node-form');
      const graphNodeStatus = document.getElementById('graph-node-status');
      const nodeDetail = document.getElementById('graph-node-detail');

      const KIND_COLOUR = { trigger: '#b7791f', control: '#2f6db3', action: '#1d8a4e' };
      // the node box is 176×44, centred on its position; the ports sit on its edges
      const NODE_HALF = { w: 88, h: 22 };
      const PORT_HIT = 13;          // the grabbable strip around a port dot
      const ZOOM_MIN = 0.2;
      const ZOOM_MAX = 4;

      // The .vgraph vocabulary, MIRRORED from src/office/behavior-graph/schema.js — the
      // one validator the studio and the product share, and the authority on what a node
      // is. The renderer is a page, not a module: it cannot require() the product tree, so
      // this is a COPY — and studio/test/boundary.test.js asserts it equals the schema's
      // NODE_TYPES (types, fields, ports) and ACTIONS exactly. A type the schema accepts
      // can never be missing from the 加节点 dialog, and one it refuses can never appear.
      const GRAPH_NODE_FIELDS = {
        trigger: { event: 'string', every: 'number', once: 'boolean' },
        condition: { test: 'object' },
        wait: { ms: 'number', until: 'object', timeoutMs: 'number' },
        parallel: {},
        join: {},
        loop: { every: 'number', max: 'number' },
        subgraph: { graphId: 'string' },
        variable: { write: 'object', read: 'string' },
        action: { do: 'string', target: 'string', resource: 'string', facing: 'string', params: 'object' },
        dialogue: { topic: 'string', peer: 'string' },
        emotion: { state: 'string' },
        feel: { squash: 'object', mirror: 'boolean', crossfadeMs: 'number', stepSync: 'object' },
      };
      // the typed ports per type; only FLOW ports may be wired (the validator refuses the
      // rest), and a trigger's `out` is the only way a graph ever starts
      const GRAPH_NODE_PORTS = {
        trigger: { out: 'flow' },
        condition: { in: 'flow', true: 'flow', false: 'flow' },
        wait: { in: 'flow', out: 'flow' },
        parallel: { in: 'flow', out: 'flow' },
        join: { in: 'flow', out: 'flow' },
        loop: { in: 'flow', out: 'flow', exit: 'flow' },
        subgraph: { in: 'flow', out: 'flow' },
        variable: { in: 'flow', out: 'flow' },
        action: { in: 'flow', out: 'flow' },
        dialogue: { in: 'flow', out: 'flow' },
        emotion: { in: 'flow', out: 'flow' },
        feel: { in: 'flow', out: 'flow' },
      };
      const GRAPH_NODE_KIND = { trigger: 'trigger', condition: 'control', wait: 'control', parallel: 'control', join: 'control', loop: 'control', subgraph: 'control', variable: 'control', action: 'action', dialogue: 'action', emotion: 'action', feel: 'action' };
      const GRAPH_ACTIONS = ['walk.to', 'sit', 'stand', 'animation.set', 'video.play', 'bubble.show', 'task.accept', 'task.release', 'transition.start', 'transition.cancel', 'activity.set'];
      // A NEW node's defaults: every field the type declares, filled with a value the
      // schema accepts, so a created node is one 保存 away from the disk. A type whose
      // requirement is 'a|b' gets the first branch; `subgraph` and `variable` depend on the
      // graph itself and are filled in graphDefaultsFor().
      const GRAPH_NODE_DEFAULTS = {
        trigger: { every: 1000 },
        condition: { test: { left: 'idle', op: 'exists' } },
        wait: { ms: 1000 },
        parallel: {},
        join: {},
        loop: { every: 1000, max: 10 },
        subgraph: { graphId: '' },                    // → the open graph's own id
        variable: { write: { name: '', value: 0 } },  // → a declared variable's name
        action: { do: 'activity.set', resource: 'roaming' },
        dialogue: { topic: 'pantry' },
        emotion: { state: 'calm' },
        feel: { crossfadeMs: 120 },
      };
      // where 检查 / 运行 / 差异 findings are aimed
      const GRAPH_TARGET = { page: 'behaviour', tab: 'tab-graph' };

      let graphState = null;          // { name, file, graph, validation, dirty }
      let graphSelected = null;       // node id
      let graphSelectedEdge = null;   // index into graph.edges
      let graphDrag = null;           // { nodeId } while a node is being moved
      let graphPortDrag = null;       // { from, port, at } while an edge is being drawn
      let graphPan = null;            // { id, clientX, clientY, x, y } while panning
      // THE VIEW: canvas pixels → graph space. Node positions live in meta.layout
      // (0..1, presentation only); this transform is presentation too and never reaches
      // the graph — the stage's zoom/pan vocabulary, in the graph's own coordinate space.
      const graphView = { zoom: 1, x: 0, y: 0 };

      const nodeKind = (node) => GRAPH_NODE_KIND[node.type] || 'action';
      const nodeById = (id) => (graphState ? graphState.graph.nodes.find((node) => node.id === id) || null : null);

      function graphLayout() {
        if (!graphState) return {};
        const stored = (graphState.graph.meta && graphState.graph.meta.layout) || null;
        if (stored && Object.keys(stored).length > 0) return stored;
        // deterministic fallback so a graph without stored positions is still readable
        const columns = { trigger: 0, control: 1, action: 2 };
        const buckets = new Map();
        for (const node of graphState.graph.nodes) {
          const column = columns[nodeKind(node)] ?? 2;
          if (!buckets.has(column)) buckets.set(column, []);
          buckets.get(column).push(node);
        }
        const layout = {};
        for (const [column, nodes] of buckets) {
          nodes.forEach((node, index) => {
            layout[node.id] = { x: 0.06 + column * 0.32, y: Math.min(0.92, 0.08 + index * (0.84 / Math.max(1, nodes.length))) };
          });
        }
        return layout;
      }

      // a node's centre in GRAPH space: the layout is normalized, the canvas is the space
      function graphCentre(id, layout = graphLayout()) {
        const at = layout[id] || { x: 0.5, y: 0.5 };
        return { x: 40 + at.x * (graphCanvas.width - 80), y: 40 + at.y * (graphCanvas.height - 80) };
      }
      // The canvas is letterboxed by the browser into the wrap, so a client point maps
      // through the rect into BACKING-STORE pixels, then through the view into graph
      // space — the drawing and the hit-testing are then on the same numbers at any zoom.
      function graphPixel(event) {
        const rect = graphCanvas.getBoundingClientRect();
        return {
          x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * graphCanvas.width,
          y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * graphCanvas.height,
        };
      }
      function graphPoint(event) {
        const pixel = graphPixel(event);
        return { x: (pixel.x - graphView.x) / graphView.zoom, y: (pixel.y - graphView.y) / graphView.zoom };
      }
      // the graph-space point in the middle of what the viewport is showing
      function graphViewCentre() {
        return {
          x: (graphCanvas.width / 2 - graphView.x) / graphView.zoom,
          y: (graphCanvas.height / 2 - graphView.y) / graphView.zoom,
        };
      }
      function graphApply() {
        if (zoomReadout) zoomReadout.textContent = `${Math.round(graphView.zoom * 100)}%`;
      }
      // zoom about an anchor given in canvas pixels: the graph point under it stays put
      function graphZoomBy(factor, anchor = null) {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, graphView.zoom * factor));
        if (Math.abs(next - graphView.zoom) < 1e-6) return;
        if (anchor) {
          const gx = (anchor.x - graphView.x) / graphView.zoom;
          const gy = (anchor.y - graphView.y) / graphView.zoom;
          graphView.zoom = Number(next.toFixed(4));
          graphView.x = anchor.x - gx * graphView.zoom;
          graphView.y = anchor.y - gy * graphView.zoom;
        } else {
          graphView.zoom = Number(next.toFixed(4));
        }
        graphApply();
        renderGraphCanvas();
      }
      // FIT: every node on screen, centred — the same promise the stage makes ("a view
      // change always lands on a visible frame"), so a zoomed-away user is never stuck
      function graphFit() {
        if (!graphState) return;
        const W = graphCanvas.width;
        const H = graphCanvas.height;
        const margin = 48;
        const centres = graphState.graph.nodes.map((node) => graphCentre(node.id));
        if (centres.length === 0) {
          graphView.zoom = 1;
          graphView.x = 0;
          graphView.y = 0;
        } else {
          const minX = Math.min(...centres.map((point) => point.x)) - NODE_HALF.w - margin;
          const maxX = Math.max(...centres.map((point) => point.x)) + NODE_HALF.w + margin;
          const minY = Math.min(...centres.map((point) => point.y)) - NODE_HALF.h - margin;
          const maxY = Math.max(...centres.map((point) => point.y)) + NODE_HALF.h + margin;
          const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(
            W / Math.max(1, maxX - minX),
            H / Math.max(1, maxY - minY),
          )));
          graphView.zoom = Number(zoom.toFixed(4));
          graphView.x = Math.round((W - (maxX - minX) * graphView.zoom) / 2 - minX * graphView.zoom);
          graphView.y = Math.round((H - (maxY - minY) * graphView.zoom) / 2 - minY * graphView.zoom);
        }
        graphApply();
        renderGraphCanvas();
      }
      // The backing store follows the wrap (dpr aware), so the canvas can grow with the
      // work area WITHOUT stretching the drawing. The layout is normalized, so nothing
      // else depends on the pixel size — hit-testing reads the live size too.
      function graphResizeCanvas() {
        if (!graphCanvasWrap) return false;
        const rect = graphCanvasWrap.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return false;    // hidden page: keep the size
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const W = Math.max(320, Math.round(rect.width * dpr));
        const H = Math.max(180, Math.round(rect.height * dpr));
        if (graphCanvas.width === W && graphCanvas.height === H) return false;
        graphCanvas.width = W;
        graphCanvas.height = H;
        return true;
      }

      function renderGraphCanvas() {
        if (!graphState) return;
        const layout = graphLayout();
        const ctx = graphCanvas.getContext('2d');
        const W = graphCanvas.width;
        const H = graphCanvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#fbfcfd';
        ctx.fillRect(0, 0, W, H);
        // everything below is drawn in GRAPH space through the view transform, so a
        // constant apparent line width / font size divides by the zoom
        ctx.setTransform(graphView.zoom, 0, 0, graphView.zoom, graphView.x, graphView.y);
        const unit = 1 / graphView.zoom;
        const pointOf = (id) => graphCentre(id, layout);
        // edges first
        for (const [index, edge] of (graphState.graph.edges || []).entries()) {
          const from = pointOf(edge.from);
          const to = pointOf(edge.to);
          const port = edge.port || 'out';
          const selected = graphSelectedEdge === index;
          ctx.strokeStyle = selected ? '#c23a3a'
            : port === 'false' || port === 'exit' ? 'rgba(183, 121, 31, 0.85)' : 'rgba(47, 109, 179, 0.75)';
          ctx.lineWidth = (selected ? 3.5 : 2) * unit;
          ctx.beginPath();
          ctx.moveTo(from.x + NODE_HALF.w, from.y);
          ctx.lineTo(to.x - NODE_HALF.w, to.y);
          ctx.stroke();
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath();
          ctx.moveTo(to.x - NODE_HALF.w, to.y);
          ctx.lineTo(to.x - NODE_HALF.w - 12 * unit, to.y - 5 * unit);
          ctx.lineTo(to.x - NODE_HALF.w - 12 * unit, to.y + 5 * unit);
          ctx.closePath();
          ctx.fill();
          if (showPorts.checked && port !== 'out') {
            ctx.font = `${13 * unit}px -apple-system, sans-serif`;
            ctx.fillText(port, (from.x + to.x) / 2 - 8 * unit, (from.y + to.y) / 2 - 6 * unit);
          }
        }
        // the edge being drawn right now: from the port it started at to the cursor
        if (graphPortDrag && graphPortDrag.at) {
          const from = pointOf(graphPortDrag.from);
          ctx.strokeStyle = 'rgba(47, 109, 179, 0.9)';
          ctx.lineWidth = 2 * unit;
          ctx.setLineDash([6 * unit, 4 * unit]);
          ctx.beginPath();
          ctx.moveTo(from.x + NODE_HALF.w, from.y);
          ctx.lineTo(graphPortDrag.at.x, graphPortDrag.at.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // nodes
        for (const node of graphState.graph.nodes) {
          const at = pointOf(node.id);
          const kind = nodeKind(node);
          const selected = graphSelected === node.id;
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = selected ? '#c23a3a' : KIND_COLOUR[kind];
          ctx.lineWidth = (selected ? 3 : 2) * unit;
          const box = { x: at.x - NODE_HALF.w, y: at.y - NODE_HALF.h, w: NODE_HALF.w * 2, h: NODE_HALF.h * 2 };
          ctx.beginPath();
          ctx.roundRect ? ctx.roundRect(box.x, box.y, box.w, box.h, 8 * unit) : ctx.rect(box.x, box.y, box.w, box.h);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#26313a';
          ctx.font = `bold ${15 * unit}px -apple-system, sans-serif`;
          ctx.fillText(node.id, box.x + 10 * unit, box.y + 19 * unit);
          ctx.fillStyle = '#6b7784';
          ctx.font = `${13 * unit}px -apple-system, sans-serif`;
          const subtitle = node.type === 'action' ? `${node.do}${node.target ? ` → ${node.target}` : ''}`
            : node.type === 'trigger' ? (node.event || `every ${node.every}ms`)
              : node.type === 'wait' ? (node.ms ? `wait ${node.ms}ms` : `until ${node.until ? node.until.event : '?'}`)
                : node.type;
          ctx.fillText(String(subtitle).slice(0, 26), box.x + 10 * unit, box.y + 36 * unit);
        }
        // the ports, on top of the boxes: the grips an edge is dragged FROM and TO
        for (const node of graphState.graph.nodes) {
          for (const [, port] of Object.entries(graphPortPoints(node))) {
            ctx.fillStyle = port.out ? KIND_COLOUR[nodeKind(node)] : '#6b7784';
            ctx.fillRect(port.x - 4 * unit, port.y - 4 * unit, 8 * unit, 8 * unit);
          }
        }
        // the target port under the cursor is ringed, so "where will this land?" is visible
        if (graphPortDrag && graphPortDrag.at) {
          const target = graphInHit(graphPortDrag.at);
          if (target) {
            const port = graphPortPoints(target).in;
            ctx.strokeStyle = '#c23a3a';
            ctx.lineWidth = 2.5 * unit;
            ctx.beginPath();
            ctx.arc(port.x, port.y, 9 * unit, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }

      function setGraphStatus(text, cls = 'wb-hint') {
        graphStatus.className = cls;
        graphStatus.textContent = text;
      }

      // ---- the problems strip (T12): 检查 / 运行 / 差异 all report there -----------
      //
      // 检查 has always fed the 'graph' source. T8 adds the RUN and DIFF outcomes as
      // note/yellow entries aimed at this page's tab, so an outcome is one click away in
      // the panel the user already reads. A CLEAN run writes nothing: the strip earns its
      // attention by being quiet, so it clears its own source instead of adding a note.
      const graphSetProblems = (source, findings) => window.__wbProblems?.problems?.set(source, findings);
      function graphReportRunProblems(findings) {
        graphSetProblems('graph-run', (findings || []).map((finding) => ({
          severity: 'yellow',
          code: finding.code || 'GRAPH_RUN',
          message: finding.message || '',
          target: { ...GRAPH_TARGET },
        })));
      }
      function graphReportDiffProblems(entries) {
        graphSetProblems('graph-diff', (entries || []).map((entry) => ({
          severity: 'yellow',
          code: `GRAPH_DIFF_${String(entry.kind || 'DIVERGENCE').replace(/-/g, '_').toUpperCase()}`,
          message: `${entry.employeeId ? `${entry.employeeId} · ` : ''}${entry.kind || 'divergence'}`,
          target: { ...GRAPH_TARGET },
        })));
      }

      async function loadGraph(name) {
        const listed = await studio.graphList();
        if (!listed.ok) { setGraphStatus(t('graph.dirUnreadable', { code: listed.code || '' }), 'wb-hint bad'); return null; }
        graphFileSelect.replaceChildren();
        for (const entry of listed.graphs) {
          const option = document.createElement('option');
          option.value = entry.name;
          option.textContent = entry.ok
            ? t('graph.optionLabel', { name: entry.name, nodes: entry.nodes, edges: entry.edges })
            : `${entry.name}${t('graph.optionInvalid')}`;
          graphFileSelect.appendChild(option);
        }
        const target = name || (listed.graphs.find((entry) => entry.ok) || listed.graphs[0] || {}).name;
        if (!target) { setGraphStatus(t('graph.dirEmpty', { dir: listed.dir }), 'wb-hint warn'); return null; }
        graphFileSelect.value = target;
        const read = await studio.graphRead({ name: target });
        if (!read.ok) { setGraphStatus(t('graph.loadFailed', { message: `${read.code} ${read.message || ''}` }), 'wb-hint bad'); return null; }
        graphState = { name: target, file: read.file, graph: read.graph, validation: read.validation, dirty: false };
        graphSelected = null;
        graphSelectedEdge = null;
        graphPortDrag = null;
        graphPan = null;
        graphResizeCanvas();
        // a freshly opened file starts at 100% top-left, like the stage's 复位: what is on
        // screen is then exactly meta.layout, which keeps the file's own arrangement
        // readable before anyone touches the view
        graphView.zoom = 1;
        graphView.x = 0;
        graphView.y = 0;
        graphApply();
        syncGraphNodePanel();
        renderGraphCanvas();
        setGraphStatus(
          t('graph.loadStatus', {
            name: target,
            nodes: read.validation.stats.nodes, edges: read.validation.stats.edges,
            triggers: read.validation.stats.triggers, cycles: read.validation.stats.cycles,
            verdict: read.validation.ok ? t('graph.loadStatusOk') : t('graph.loadStatusBad'),
            checks: read.validation.ok ? '' : t('graph.validationChecks', { checks: read.validation.violations.map((violation) => violation.check).join('、') }),
          }),
          read.validation.ok ? 'wb-hint' : 'wb-hint bad',
        );
        return read;
      }

      // ---- hit-testing: node bodies, ports, edges --------------------------------
      function graphHitTest(point) {
        for (const node of graphState.graph.nodes) {
          const at = graphCentre(node.id);
          if (Math.abs(point.x - at.x) <= NODE_HALF.w && Math.abs(point.y - at.y) <= NODE_HALF.h) return node;
        }
        return null;
      }
      // The ports: outputs stacked down the right edge (one slot per flow port), the
      // single input on the left edge. These are the grips — an edge is dragged FROM an
      // output and TO an input, which is also the only shape the validator accepts.
      function graphPortPoints(node) {
        const at = graphCentre(node.id);
        const ports = GRAPH_NODE_PORTS[node.type] || { in: 'flow', out: 'flow' };
        const outs = Object.keys(ports).filter((name) => name !== 'in');
        const points = {};
        outs.forEach((name, index) => {
          points[name] = {
            x: at.x + NODE_HALF.w,
            y: at.y - NODE_HALF.h + ((index + 0.5) * (NODE_HALF.h * 2)) / Math.max(1, outs.length),
            out: true,
          };
        });
        if ('in' in ports) points.in = { x: at.x - NODE_HALF.w, y: at.y, out: false };
        return points;
      }
      function graphPortHit(point) {
        for (const node of graphState.graph.nodes) {
          for (const [name, port] of Object.entries(graphPortPoints(node))) {
            if (!port.out) continue;
            if (Math.abs(point.x - port.x) <= PORT_HIT && Math.abs(point.y - port.y) <= PORT_HIT) return { from: node.id, port: name };
          }
        }
        return null;
      }
      function graphInHit(point) {
        for (const node of graphState.graph.nodes) {
          const port = graphPortPoints(node).in;
          if (port && Math.abs(point.x - port.x) <= PORT_HIT + 8 && Math.abs(point.y - port.y) <= PORT_HIT) return node;
        }
        return null;
      }
      // click-to-select an edge: the LAST one drawn is on top, and the hit box is 8 graph
      // pixels around the segment
      function graphEdgeHit(point) {
        const edges = graphState.graph.edges || [];
        for (let index = edges.length - 1; index >= 0; index -= 1) {
          const from = graphCentre(edges[index].from);
          const to = graphCentre(edges[index].to);
          const ax = from.x + NODE_HALF.w;
          const ay = from.y;
          const bx = to.x - NODE_HALF.w;
          const by = to.y;
          const vx = bx - ax;
          const vy = by - ay;
          const lengthSq = vx * vx + vy * vy;
          // projection of the point onto the segment, clamped to its ends (a plain `t`
          // would shadow the i18n lookup — this one is the segment parameter)
          const along = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - ax) * vx + (point.y - ay) * vy) / lengthSq));
          const dx = point.x - (ax + vx * along);
          const dy = point.y - (ay + vy * along);
          if (Math.sqrt(dx * dx + dy * dy) <= 8) return index;
        }
        return null;
      }

      // ---- wiring an edge: the validator's own port rules ------------------------
      //
      // Can flow go from (fromId, port) into toId? The port rule is the validator's: the
      // source must have that FLOW port, and the target must accept incoming flow. The
      // other two refusals are the tool's own judgement (a self-loop can only be valid
      // through a wait/loop/trigger, and a repeated edge is never meaningful).
      function graphConnectRefusal(fromId, port, toId) {
        const from = nodeById(fromId);
        const to = nodeById(toId);
        if (!from || !to) return t('graph.edgeUnknownNode');
        if (fromId === toId) return t('graph.edge.self');
        const ports = GRAPH_NODE_PORTS[from.type] || {};
        if (!ports[port]) return `${fromId} has no port ${JSON.stringify(port)}`;
        const toPorts = GRAPH_NODE_PORTS[to.type] || {};
        if (!('in' in toPorts) && GRAPH_NODE_KIND[to.type] !== 'trigger') return `${toId} accepts no incoming flow`;
        if ((graphState.graph.edges || []).some((edge) => edge.from === fromId && (edge.port || 'out') === port && edge.to === toId)) {
          return t('graph.edge.duplicate');
        }
        return null;
      }
      function graphAddEdge(fromId, port, toId) {
        const refusal = graphConnectRefusal(fromId, port, toId);
        if (refusal) {
          setGraphStatus(`${t('graph.edge.refused')}${refusal}`, 'wb-hint bad');
          return false;
        }
        graphState.graph.edges = [...(graphState.graph.edges || []), { from: fromId, port, to: toId }];
        graphState.dirty = true;
        graphSelectedEdge = null;
        renderGraphCanvas();
        setGraphStatus(t('graph.edge.added', { from: fromId, to: toId, port }), 'wb-hint warn');
        return true;
      }

      // ---- deleting: the selected edge, or the selected node ----------------------
      //
      // Creating without deleting is a dead end, so 删除 takes the selected EDGE first and
      // falls back to the selected NODE together with every edge touching it. Both only
      // stage the draft: 保存 is still the only writer, and a graph the validator refuses
      // (deleting the last trigger, say) is stopped there with the validator's own message.
      function graphDeleteSelection() {
        if (!graphState) return;
        const edges = graphState.graph.edges || [];
        if (graphSelectedEdge !== null && edges[graphSelectedEdge]) {
          const edge = edges[graphSelectedEdge];
          graphState.graph.edges = edges.filter((_, index) => index !== graphSelectedEdge);
          graphSelectedEdge = null;
          graphState.dirty = true;
          renderGraphCanvas();
          setGraphStatus(t('graph.edge.deleted', { from: edge.from, to: edge.to }), 'wb-hint warn');
          return;
        }
        const node = graphSelectedNode();
        if (!node) { setGraphStatus(t('graph.delete.nothing'), 'wb-hint warn'); return; }
        const removed = edges.filter((edge) => edge.from === node.id || edge.to === node.id).length;
        graphState.graph.nodes = graphState.graph.nodes.filter((entry) => entry.id !== node.id);
        graphState.graph.edges = edges.filter((edge) => edge.from !== node.id && edge.to !== node.id);
        if (graphState.graph.meta && graphState.graph.meta.layout) delete graphState.graph.meta.layout[node.id];
        graphSelected = null;
        graphSelectedEdge = null;
        graphState.dirty = true;
        renderGraphCanvas();
        syncGraphNodePanel();
        setGraphStatus(t('graph.delete.node', { id: node.id, edges: removed }), 'wb-hint warn');
      }

      // ---- creating a node: the schema's types, its defaults, the view's centre -----
      function graphDefaultsFor(type) {
        const base = JSON.parse(JSON.stringify(GRAPH_NODE_DEFAULTS[type] || {}));
        if (type === 'subgraph') base.graphId = (graphState.graph && graphState.graph.id) || 'local-behaviour';
        if (type === 'variable') {
          const declared = ((graphState.graph && graphState.graph.variables) || [])[0];
          base.write = { name: declared ? declared.name : 'idle', value: 0 };
        }
        return base;
      }
      function graphNextNodeId(type) {
        const taken = new Set(graphState.graph.nodes.map((node) => node.id));
        let counter = 1;
        while (taken.has(`${type}-${counter}`)) counter += 1;
        return `${type}-${counter}`;
      }
      function graphFillAddForm() {
        // the options come from the MIRRORED schema table: one <optgroup> per kind, and
        // nothing outside it — a type the validator would refuse can never be offered
        addType.replaceChildren();
        for (const kind of ['trigger', 'control', 'action']) {
          const group = document.createElement('optgroup');
          group.label = t(`graph.kind.${kind}`);
          for (const [type, fields] of Object.entries(GRAPH_NODE_FIELDS)) {
            if (GRAPH_NODE_KIND[type] !== kind) continue;
            const option = document.createElement('option');
            option.value = type;
            const fieldNames = Object.keys(fields);
            option.textContent = fieldNames.length > 0 ? `${type}（${fieldNames.join(' · ')}）` : type;
            group.appendChild(option);
          }
          addType.appendChild(group);
        }
        addId.value = graphNextNodeId(addType.value);
      }
      function graphOpenAddForm() {
        addForm.hidden = false;
        graphFillAddForm();
        addId.focus();
        addId.select();
        setGraphStatus(t('graph.add.opened'), 'wb-hint');
      }
      // A new node lands at the centre of what the user is looking at, nudged aside if a
      // node already sits there — so it is never created off-screen or underneath one.
      function graphFreeSpot(centre) {
        const spot = { ...centre };
        for (let step = 0; step < 8; step += 1) {
          const taken = graphState.graph.nodes.some((node) => {
            const at = graphCentre(node.id);
            return Math.abs(at.x - spot.x) <= NODE_HALF.w + 8 && Math.abs(at.y - spot.y) <= NODE_HALF.h + 8;
          });
          if (!taken) break;
          spot.x += 130;
          if (spot.x > graphCanvas.width - 60) { spot.x = centre.x; spot.y += 56; }
        }
        return spot;
      }
      function graphCreateNode() {
        if (!graphState) return;
        const type = addType.value;
        const id = addId.value.trim();
        if (!id) { setGraphStatus(t('graph.add.idEmpty'), 'wb-hint bad'); addId.focus(); return; }
        if (graphState.graph.nodes.some((node) => node.id === id)) {
          setGraphStatus(t('graph.add.duplicate', { id }), 'wb-hint bad');
          addId.focus();
          return;
        }
        // FREEZE the layout first: with no stored positions the canvas falls back to an
        // auto-layout, so a save would then store this node and silently drop the rest of
        // the arrangement on screen (the same freeze a drag does)
        graphState.graph.meta = graphState.graph.meta || {};
        graphState.graph.meta.layout = { ...graphLayout() };
        const spot = graphFreeSpot(graphViewCentre());
        graphState.graph.meta.layout[id] = {
          x: Number(Math.min(1, Math.max(0, (spot.x - 40) / (graphCanvas.width - 80))).toFixed(5)),
          y: Number(Math.min(1, Math.max(0, (spot.y - 40) / (graphCanvas.height - 80))).toFixed(5)),
        };
        graphState.graph.nodes.push({ id, type, ...graphDefaultsFor(type) });
        graphSelected = id;
        graphSelectedEdge = null;
        graphState.dirty = true;
        addForm.hidden = true;
        renderGraphCanvas();
        syncGraphNodePanel();
        setGraphStatus(t('graph.add.created', { id, type }), 'wb-hint warn');
      }

      // ---- the inspector: the selected node's FIELDS ------------------------------
      //
      // A row per field the schema declares for the node's type, so the editor can never
      // offer a field the validator would ignore; `do` is a picker over the closed action
      // vocabulary. Applying stages the draft, then validates the WHOLE graph through the
      // same service 检查 uses: an invalid node is refused WITH THE VALIDATOR'S OWN
      // MESSAGE and the snapshot is restored, so nothing invalid is ever staged.
      function graphSelectedNode() {
        if (!graphState || !graphSelected) return null;
        return graphState.graph.nodes.find((node) => node.id === graphSelected) || null;
      }
      function syncGraphNodePanel() {
        const node = graphSelectedNode();
        if (!node) {
          graphNodeBody.hidden = true;
          graphNodeNone.hidden = false;
          nodeDetail.textContent = t('graph.node.detailHint');
          return;
        }
        graphNodeNone.hidden = true;
        graphNodeBody.hidden = false;
        graphNodeMeta.textContent = `${node.id} · ${node.type}${graphState.dirty ? ` · ${t('graph.node.unsaved')}` : ''}`;
        nodeDetail.textContent = JSON.stringify(node, null, 2);
        graphNodeForm.replaceChildren();
        for (const [field, kind] of Object.entries(GRAPH_NODE_FIELDS[node.type] || {})) {
          const row = document.createElement('label');
          row.className = 'wb-prop-row';
          const label = document.createElement('span');
          label.textContent = field;
          let input;
          if (field === 'do') {
            // the closed action vocabulary: a picker, never a free-text field
            input = document.createElement('select');
            for (const action of GRAPH_ACTIONS) {
              const option = document.createElement('option');
              option.value = action;
              option.textContent = action;
              input.appendChild(option);
            }
          } else if (kind === 'boolean') {
            input = document.createElement('input');
            input.type = 'checkbox';
          } else if (kind === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
          } else {
            input = document.createElement('input');
            input.type = 'text';
          }
          input.id = `graph-node-field-${field}`;
          input.dataset.field = field;
          input.dataset.kind = kind;
          const value = node[field];
          if (field === 'do') input.value = typeof value === 'string' ? value : GRAPH_ACTIONS[0];
          else if (kind === 'boolean') input.checked = Boolean(value);
          else if (kind === 'object') input.value = value === undefined ? '' : JSON.stringify(value);
          else input.value = value === undefined ? '' : String(value);
          if (kind === 'object') input.placeholder = t('graph.node.jsonPlaceholder');
          row.append(label, input);
          graphNodeForm.appendChild(row);
        }
        graphNodeStatus.textContent = '';
      }
      async function applyGraphNodeFields() {
        const node = graphSelectedNode();
        if (!node) {
          graphNodeStatus.textContent = t('graph.node.noneSelected');
          graphNodeStatus.className = 'wb-hint bad';
          return;
        }
        const snapshot = JSON.stringify(node);
        const patch = {};
        for (const input of graphNodeForm.querySelectorAll('input, select')) {
          const field = input.dataset.field;
          const kind = input.dataset.kind;
          if (kind === 'boolean') { patch[field] = input.checked; continue; }
          const text = input.value.trim();
          if (text === '') continue;    // an empty box keeps what the node already has
          if (kind === 'number') {
            const typed = Number(text);
            if (!Number.isFinite(typed)) {
              graphNodeStatus.textContent = t('graph.node.notNumber', { field });
              graphNodeStatus.className = 'wb-hint bad';
              return;
            }
            patch[field] = typed;
          } else if (kind === 'object') {
            let parsed;
            try { parsed = JSON.parse(text); }
            catch (error) {
              graphNodeStatus.textContent = t('graph.node.jsonBad', { field, message: String((error && error.message) || error) });
              graphNodeStatus.className = 'wb-hint bad';
              return;
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              graphNodeStatus.textContent = t('graph.node.objectNeeded', { field });
              graphNodeStatus.className = 'wb-hint bad';
              return;
            }
            patch[field] = parsed;
          } else {
            patch[field] = text;
          }
        }
        const unchanged = Object.entries(patch).every(([field, value]) => JSON.stringify(node[field]) === JSON.stringify(value));
        if (unchanged) {
          syncGraphNodePanel();
          graphNodeStatus.textContent = t('graph.node.noChange');
          graphNodeStatus.className = 'wb-hint';
          return;
        }
        Object.assign(node, patch);
        let outcome = null;
        try { outcome = await studio.graphValidate({ graph: graphState.graph }); }
        catch (error) {
          outcome = { ok: false, code: 'GRAPH_VALIDATE_FAILED', violations: [{ check: 'graph.validate', detail: String((error && error.message) || error) }] };
        }
        if (!outcome || !outcome.ok) {
          // refuse WITH the validator's own message, and unstage what was refused
          const restored = JSON.parse(snapshot);
          for (const key of Object.keys(node)) delete node[key];
          Object.assign(node, restored);
          syncGraphNodePanel();
          const first = ((outcome && outcome.violations) || [])[0] || {};
          graphNodeStatus.textContent = t('graph.node.invalidRefused', {
            check: first.check || (outcome && outcome.code) || 'GRAPH_INVALID',
            detail: first.detail || '',
          });
          graphNodeStatus.className = 'wb-hint bad';
          return;
        }
        graphState.validation = { ok: true, violations: [], stats: outcome.stats || null };
        graphState.dirty = true;
        renderGraphCanvas();
        syncGraphNodePanel();
        graphNodeStatus.textContent = t('graph.node.applied');
        graphNodeStatus.className = 'wb-hint';
      }

      // ---- the pointer: node drag · port drag · edge select · pan ------------------
      //
      // ONE pointerdown for the graph canvas. A second, older listener used to sit here; it
      // ran on every click after this one, re-rendering the canvas and overwriting the state
      // this handler had just set (found during R2 verification, removed).
      graphCanvas.addEventListener('pointerdown', (event) => {
        if (!graphState) return;
        if (event.button !== 0 && event.button !== 1) return;
        // one capture for every gesture, so a drag that leaves the canvas (the wrap is
        // small when zoomed in) still tracks; a bare click is unaffected
        try { graphCanvas.setPointerCapture(event.pointerId); } catch { /* synthetic event */ }
        const point = graphPoint(event);
        // 1) an OUTPUT port: start drawing an edge from it
        const port = graphPortHit(point);
        if (port) {
          graphPortDrag = { from: port.from, port: port.port, at: point };
          graphSelected = null;
          graphSelectedEdge = null;
          syncGraphNodePanel();
          renderGraphCanvas();
          return;
        }
        // 2) a node: select it, and move it on drag
        const node = graphHitTest(point);
        if (node) {
          graphSelected = node.id;
          graphSelectedEdge = null;
          // FREEZE the layout at drag start: with no stored positions the canvas falls
          // back to an auto-layout, so dragging one node must first materialise the
          // positions currently on screen — otherwise saving would store one node and
          // silently drop the rest of the arrangement.
          graphState.graph.meta = graphState.graph.meta || {};
          graphState.graph.meta.layout = { ...graphLayout() };
          graphDrag = { nodeId: node.id };
          syncGraphNodePanel();
          renderGraphCanvas();
          return;
        }
        // 3) an edge: a click selects it (Delete removes it)
        // 4) the empty canvas: clear the selection — and dragging HERE pans the view
        graphSelectedEdge = graphEdgeHit(point);
        graphSelected = null;
        syncGraphNodePanel();
        graphPan = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: graphView.x, y: graphView.y };
        graphCanvasWrap.classList.add('wb-panning');
        renderGraphCanvas();
      });

      graphCanvas.addEventListener('pointermove', (event) => {
        if (!graphState) return;
        if (graphPan && event.pointerId === graphPan.id) {
          const rect = graphCanvas.getBoundingClientRect();
          const scale = graphCanvas.width / Math.max(1, rect.width);
          graphView.x = graphPan.x + (event.clientX - graphPan.clientX) * scale;
          graphView.y = graphPan.y + (event.clientY - graphPan.clientY) * scale;
          renderGraphCanvas();
          return;
        }
        if (graphDrag) {
          const point = graphPoint(event);
          const x = Math.min(1, Math.max(0, (point.x - 40) / (graphCanvas.width - 80)));
          const y = Math.min(1, Math.max(0, (point.y - 40) / (graphCanvas.height - 80)));
          graphState.graph.meta.layout[graphDrag.nodeId] = { x: Number(x.toFixed(5)), y: Number(y.toFixed(5)) };
          graphState.dirty = true;
          renderGraphCanvas();
          setGraphStatus(t('graph.dragging', { id: graphDrag.nodeId, x: x.toFixed(3), y: y.toFixed(3) }), 'wb-hint warn');
          return;
        }
        if (graphPortDrag) {
          graphPortDrag.at = graphPoint(event);
          renderGraphCanvas();
          return;
        }
        // hover: the cursor says what a press would do here
        const point = graphPoint(event);
        graphCanvas.style.cursor = graphPan ? 'grabbing'
          : graphPortHit(point) ? 'crosshair'
            : graphHitTest(point) ? 'move'
              : 'grab';
      });

      const endGraphGesture = (event) => {
        const pointerId = event && typeof event.pointerId === 'number' ? event.pointerId : null;
        if (graphPan && (!pointerId || pointerId === graphPan.id)) {
          graphPan = null;
          graphCanvasWrap.classList.remove('wb-panning');
        }
        if (graphPortDrag) {
          const pending = graphPortDrag;
          graphPortDrag = null;
          if (event) {
            const target = graphInHit(graphPoint(event));
            if (target) graphAddEdge(pending.from, pending.port, target.id);
            else setGraphStatus(t('graph.edge.cancelled'), 'wb-hint');
          }
          renderGraphCanvas();
          return;
        }
        if (graphDrag) {
          graphDrag = null;
          if (graphState && graphState.dirty) {
            const count = Object.keys((graphState.graph.meta && graphState.graph.meta.layout) || {}).length;
            setGraphStatus(t('graph.layoutChanged', { count, file: graphFileSelect.value }), 'wb-hint warn');
          }
        }
      };
      graphCanvas.addEventListener('pointerup', endGraphGesture);
      graphCanvas.addEventListener('pointercancel', endGraphGesture);
      // wheel = zoom at the cursor, the same gesture the stage's viewport uses
      graphCanvas.addEventListener('wheel', (event) => {
        if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
        event.preventDefault();
        graphZoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, graphPixel(event));
      }, { passive: false });

      // Delete/Backspace removes the selection. Typing is never a delete: the handler
      // steps aside for inputs, selects, textareas and an open palette.
      window.addEventListener('keydown', (event) => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        const target = event.target;
        const tag = target && target.tagName ? target.tagName : '';
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (target && target.isContentEditable) return;
        if (palette && !palette.hidden) return;
        if (document.body.dataset.page !== 'behaviour') return;
        if (!graphState) return;
        event.preventDefault();
        graphDeleteSelection();
      });

      document.getElementById('btn-graph-reload').addEventListener('click', () => { loadGraph(graphFileSelect.value).catch((error) => setGraphStatus(t('graph.loadFailed', { message: error.message }), 'wb-hint bad')); });
      graphFileSelect.addEventListener('change', () => { loadGraph(graphFileSelect.value).catch(() => {}); });
      showPorts.addEventListener('change', () => renderGraphCanvas());

      document.getElementById('btn-graph-fit').addEventListener('click', () => {
        graphFit();
        setGraphStatus(t('graph.view.fit', { zoom: Math.round(graphView.zoom * 100) }), 'wb-hint');
      });
      document.getElementById('btn-graph-add-node').addEventListener('click', () => {
        if (addForm.hidden) graphOpenAddForm();
        else { addForm.hidden = true; }
      });
      addType.addEventListener('change', () => { addId.value = graphNextNodeId(addType.value); });
      // Enter in the id box creates — a deliberate press, like the inspector's Apply
      addId.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); graphCreateNode(); }
      });
      document.getElementById('btn-graph-add-confirm').addEventListener('click', () => graphCreateNode());
      document.getElementById('btn-graph-add-cancel').addEventListener('click', () => {
        addForm.hidden = true;
        setGraphStatus(t('graph.add.cancelled'), 'wb-hint');
      });
      document.getElementById('btn-graph-delete').addEventListener('click', () => graphDeleteSelection());

      document.getElementById('graph-node-apply').addEventListener('click', () => {
        applyGraphNodeFields().catch((error) => {
          graphNodeStatus.textContent = t('graph.node.crashed', { message: String((error && error.message) || error) });
          graphNodeStatus.className = 'wb-hint bad';
        });
      });
      document.getElementById('graph-node-refill').addEventListener('click', () => {
        // throw away what is half-typed and show the node as it stands right now
        syncGraphNodePanel();
        graphNodeStatus.textContent = t('graph.node.refill');
        graphNodeStatus.className = 'wb-hint';
      });
      // Enter in a field applies too — a deliberate press, not a keystroke. novalidate
      // keeps the browser's own number bubble from swallowing the submit first.
      graphNodeForm.addEventListener('submit', (event) => { event.preventDefault(); applyGraphNodeFields(); });

      document.getElementById('btn-graph-save').addEventListener('click', async () => {
        if (!graphState) return;
        // THE ONLY WRITER. graphSave validates first (schema + ports + cycles) and refuses
        // an invalid graph, leaving the file byte-identical — which is why creating a node,
        // wiring an edge and editing a field all just stage the draft this writes.
        const outcome = await studio.graphSave({ name: graphState.name, graph: graphState.graph, dryRun: false });
        if (!outcome.ok) {
          setGraphStatus(t('graph.saveRefused', {
            code: outcome.code,
            checks: (outcome.violations || []).map((violation) => violation.check).slice(0, 3).join('、'),
          }), 'wb-hint bad');
          return;
        }
        if (outcome.noop) { setGraphStatus(t('scene.syncNoop')); return; }
        graphState.dirty = false;
        setGraphStatus(t('graph.saved', {
          file: outcome.file.split('/').pop(),
          backup: outcome.backup ? t('graph.savedBackup', { backup: outcome.backup.split('/').pop() }) : '',
        }));
        syncGraphNodePanel();
      });

      document.getElementById('btn-graph-validate').addEventListener('click', async () => {
        if (!graphState) return;
        const outcome = await studio.graphValidate({ graph: graphState.graph });
        window.__wbProblems?.problems?.set('graph', (outcome.violations || []).map((violation) => ({
          severity: violation.severity || 'red', code: violation.check || 'GRAPH_INVALID', message: violation.detail || '',
          target: { page: 'behaviour', tab: 'tab-graph', nodeId: violation.nodeId || null },
        })));
        setGraphStatus(
          outcome.ok
            ? t('graph.validateOk', { nodes: outcome.stats.nodes, edges: outcome.stats.edges, triggers: outcome.stats.triggers, cycles: outcome.stats.cycles })
            : t('graph.validateBad', { checks: (outcome.violations || []).map((violation) => `${violation.check}（${violation.detail}）`).slice(0, 3).join('；') }),
          outcome.ok ? 'wb-hint' : 'wb-hint bad',
        );
        graphState.validation = { ok: outcome.ok, violations: outcome.violations, stats: outcome.stats || null };
      });

      document.getElementById('btn-graph-run').addEventListener('click', async () => {
        if (!graphState) return;
        let outcome;
        try {
          outcome = await studio.graphRun({ graph: graphState.graph, steps: 40, dtMs: 200, seed: 'studio-canvas' });
        } catch (error) {
          // an IPC failure must land in the panel, not in an unhandled rejection
          runResult.textContent = t('graph.runFailed', { message: String((error && error.message) || error) });
          graphReportRunProblems([{ code: 'GRAPH_RUN_CRASHED', message: String((error && error.message) || error) }]);
          return;
        }
        if (!outcome || !outcome.ok) {
          const code = (outcome && outcome.code) || 'GRAPH_RUN_FAILED';
          runResult.textContent = t('graph.runFailed', { message: code });
          // a run that could not go is a finding, not a silently empty panel
          const findings = outcome && outcome.violations
            ? outcome.violations.map((violation) => ({ code: violation.check || code, message: violation.detail || '' }))
            : [{ code, message: code }];
          graphReportRunProblems(findings);
          return;
        }
        const lines = outcome.trace.slice(-40).map((entry) => `${String(entry.atMs).padStart(6)}ms ${entry.kind}${entry.nodeId ? ` ${entry.nodeId}` : ''}${entry.do ? ` → ${entry.do}` : ''}${entry.iteration ? ` #${entry.iteration}` : ''}${entry.result !== undefined ? ` = ${entry.result}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
        runResult.textContent = [
          t('graph.runTrace', { count: lines.length }),
          ...lines,
          '',
          t('graph.runEffects', { effects: outcome.effects.map((effect) => effect.type).join(' → ') || t('bench.summaryNoTags') }),
          t('graph.runVars', { variables: JSON.stringify(outcome.state.variables) }),
        ].join('\n');
        // a CLEAN run adds no noise: it clears the run source instead of writing a note
        graphReportRunProblems([]);
      });

      document.getElementById('btn-graph-diff').addEventListener('click', async () => {
        if (!graphState) return;
        let report;
        try {
          report = await studio.graphDiff({ graph: graphState.graph, steps: 30 });
        } catch (error) {
          diffResult.textContent = t('graph.diffFailed', { message: String((error && error.message) || error) });
          graphReportDiffProblems([{ kind: 'diff-crashed', employeeId: String((error && error.message) || error) }]);
          return;
        }
        if (!report || report.ok === undefined) {
          diffResult.textContent = t('graph.diffUnavailable', { code: (report && report.code) || 'unknown' });
          graphReportDiffProblems([{ kind: 'diff-unavailable', employeeId: (report && report.code) || 'unknown' }]);
          return;
        }
        diffResult.textContent = [
          t('graph.diffHeader', {
            scheduler: report.rows.reduce((sum, row) => sum + row.schedulerRuns, 0),
            graph: report.rows.reduce((sum, row) => sum + row.graphRuns, 0),
            verdict: report.ok ? t('graph.diffMatch') : t('graph.diffDivergences', { count: report.divergences.length }),
          }),
          ...report.rows.map((row) => t('graph.diffRow', {
            id: row.employeeId,
            order: row.orderMatch ? t('graph.diffMatch') : t('graph.diffMismatch'),
            histogram: row.histogramMatch ? t('graph.diffMatch') : t('graph.diffMismatch'),
            delta: row.maxDurationDeltaMs,
          })),
          ...report.divergences.slice(0, 6).map((divergence) => `  ✗ ${divergence.kind} ${divergence.employeeId || ''}`),
        ].join('\n');
        // the divergences travel to the strip too (the panel lists the top six): a click
        // there jumps back to this page's tab
        graphReportDiffProblems(report.ok ? [] : report.divergences.slice(0, 6).map((entry) => ({ kind: entry.kind, employeeId: entry.employeeId })));
      });

      document.getElementById('btn-graph-layout').addEventListener('click', async () => {
        if (!graphState) return;
        const outcome = await studio.graphAutoLayout({ graph: graphState.graph });
        if (!outcome.ok) { setGraphStatus(t('graph.autoLayoutFailed', { code: outcome.code }), 'wb-hint bad'); return; }
        graphState.graph.meta = graphState.graph.meta || {};
        graphState.graph.meta.layout = outcome.layout;
        graphState.dirty = true;
        renderGraphCanvas();
        // the rearrangement lands on screen, the way the stage's mode switch fits its view
        graphFit();
        setGraphStatus(t('graph.autoLayoutDone'), 'wb-hint warn');
      });

      // the canvas grows with the page: the backing store follows the wrap (see
      // graphResizeCanvas), and the graph is redrawn at the new size
      if (typeof ResizeObserver === 'function' && graphCanvasWrap) {
        const graphResizeObserver = new ResizeObserver(() => { if (graphResizeCanvas()) renderGraphCanvas(); });
        graphResizeObserver.observe(graphCanvasWrap);
      } else {
        window.addEventListener('resize', () => { if (graphResizeCanvas()) renderGraphCanvas(); });
      }

      panelRefresh.set('tab-graph', () => loadGraph(graphFileSelect.value));
      loadGraph(null).catch((error) => setGraphStatus(t('graph.loadFailed', { message: error.message }), 'wb-hint bad'));
    }

    // ---- the centre pane: the dialogue corpus (P7 · T9: a full-width corpus editor) --
    //
    // T9 made this page a full-width editor: the topics became a narrow rail on the left,
    // the entry table takes the rest of the main area, the entry EDITOR moved into the
    // inspector (#panel-item-dialogue, in #wb-right), the CSV import hides behind a ⋯
    // disclosure, and 试说一句's bubble is overlaid on the runtime dock. The service is
    // still the ONLY writer: every edit stages (dialogueEdit → dry-run validate) and 保存
    // is the only thing that touches disk.
    const dialogueUnavailable = document.getElementById('dialogue-unavailable');
    const dialogueBody = document.getElementById('dialogue-body');
    const panelItemDialogue = document.getElementById('panel-item-dialogue');
    if (!studio || !studio.dialogueRead) {
      dialogueUnavailable.hidden = false;
      dialogueBody.hidden = true;
      if (panelItemDialogue) panelItemDialogue.hidden = true;
    } else {
      const layerSelect = document.getElementById('dialogue-layer');
      const dialogueStatus = document.getElementById('dialogue-status');
      const topicsEl = document.getElementById('dialogue-topics');
      const tableBody = document.querySelector('#dialogue-table tbody');
      // the CSV import: the same textarea and the same button, behind a ⋯ that starts CLOSED
      const csvMoreButton = document.getElementById('btn-dialogue-csv-more');
      const csvBox = document.getElementById('dialogue-csv-box');
      // the inspector's entry editor (#panel-item-dialogue, in #wb-right): the FIELDS live
      // there, not in the table — the table is a list you click, the inspector types values,
      // and both write the same staged draft
      const dialogueItemNone = document.getElementById('dialogue-item-none');
      const dialogueItemBody = document.getElementById('dialogue-item-body');
      const dialogueItemMeta = document.getElementById('dialogue-item-meta');
      const dialogueItemForm = document.getElementById('dialogue-item-form');
      const dialogueItemStatus = document.getElementById('dialogue-item-status');
      const dialogueItemText = document.getElementById('dialogue-item-text');
      const dialogueItemWeight = document.getElementById('dialogue-item-weight');
      const dialogueItemIf = document.getElementById('dialogue-item-if');
      const dialogueItemId = document.getElementById('dialogue-item-id');
      // the bubble is NOT a line of text in the work area: it is an overlay on the runtime
      // dock (where the characters are on screen) and it hides itself after limits.bubbleMs
      const bubbleOverlay = document.getElementById('dialogue-bubble-overlay');
      const bubbleEl = document.getElementById('dialogue-bubble');
      const bubbleWhoEl = document.getElementById('dialogue-bubble-who');
      const bubbleMetaEl = document.getElementById('dialogue-bubble-meta');
      const dockEl = document.getElementById('wb-dock');
      let dialogueState = null;      // { layer, doc, topics, validation, dirty }
      let selectedTopic = null;
      let selectedEntryId = null;    // the entry the inspector is editing
      let bubbleTimer = null;

      const setDialogueStatus = (text, cls = 'wb-hint') => { dialogueStatus.className = cls; dialogueStatus.textContent = text; };
      const setDialogueItemStatus = (text, cls = 'wb-hint') => {
        dialogueItemStatus.className = cls;
        dialogueItemStatus.textContent = text;
      };

      // gap #1: the corpus page's undo unit is the STAGED DOCUMENT — edits live in
      // dialogueState.doc until 保存 writes the file, so replaying a step is putting
      // the previous document back (a re-save then writes exactly that). rememberDoc()
      // captures the document before an edit and returns the commit that pushes the
      // step; a refused edit changes nothing and the comparison discards the step.
      function rememberDoc(label) {
        const before = dialogueState && dialogueState.doc ? JSON.parse(JSON.stringify(dialogueState.doc)) : null;
        return () => {
          if (!before || !dialogueState || !dialogueState.doc) return null;
          const after = JSON.parse(JSON.stringify(dialogueState.doc));
          if (JSON.stringify(before) === JSON.stringify(after)) return null;
          return historyController
            ? historyController.push({ label, before, after, meta: { page: 'dialogue', layer: dialogueState.layer } })
            : null;
        };
      }
      historyController?.register('dialogue', (entry, direction) => {
        if (!dialogueState) return { ok: false, code: 'DIALOGUE_NOT_LOADED' };
        const target = direction === 'undo' ? entry.before : entry.after;
        dialogueState.doc = JSON.parse(JSON.stringify(target));
        dialogueState.dirty = true;
        renderDialogue();
        setDialogueStatus(t('dialogue.historyRestored', {
          way: direction === 'undo' ? t('scene.historyLabelUndo') : t('scene.historyLabelRedo'),
        }), 'wb-hint warn');
        return { ok: true };
      });

      // the layer's bucket of topics, as the runtime reads it
      const bucketOf = (doc, layer) => (layer === 'character' ? (doc.overrides || {}) : (doc.topics || {}));

      // the entry the inspector edits: the selected row of the selected topic
      function selectedDialogueEntry() {
        if (!dialogueState || !selectedTopic) return null;
        const list = bucketOf(dialogueState.doc, dialogueState.layer)[selectedTopic] || [];
        return list.find((entry) => entry && entry.id === selectedEntryId) || null;
      }

      // conditions as text: `timeOfDay=morning, peerActivity=working` (a JSON object also
      // parses, for pasting one in). Empty means "no conditions".
      function conditionText(conditions) {
        if (!conditions || typeof conditions !== 'object') return '';
        const parts = Object.entries(conditions).map(([key, value]) => `${key}=${value === undefined ? '' : String(value)}`);
        return parts.join(', ');
      }
      function parseConditionText(text) {
        const raw = String(text || '').trim();
        if (raw === '') return { value: {} };
        if (raw.startsWith('{')) {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: t('dialogue.item.objectNeeded', { field: 'if' }) };
            return { value: parsed };
          } catch (error) {
            return { error: t('dialogue.item.jsonBad', { field: 'if', message: String((error && error.message) || error) }) };
          }
        }
        const value = {};
        for (const part of raw.split(',')) {
          const piece = part.trim();
          if (piece === '') continue;
          const at = piece.indexOf('=');
          if (at <= 0) return { error: t('dialogue.item.ifBad', { text: piece }) };
          value[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
        }
        if (Object.keys(value).length === 0) return { error: t('dialogue.item.ifBad', { text: raw }) };
        return { value };
      }

      function syncDialogueItemPanel() {
        if (!dialogueState) return;
        const entry = selectedDialogueEntry();
        if (!entry) {
          dialogueItemBody.hidden = true;
          dialogueItemNone.hidden = false;
          return;
        }
        dialogueItemNone.hidden = true;
        dialogueItemBody.hidden = false;
        // the id is read-only: ids are unique per file, so changing one is a new entry, not
        // an edit — this panel edits the LINE, not its identity
        dialogueItemMeta.textContent = `${selectedTopic} · ${entry.id}${dialogueState.dirty ? ` · ${t('dialogue.item.unsaved')}` : ''}`;
        dialogueItemText.value = entry.text || '';
        dialogueItemWeight.value = String(entry.weight === undefined ? 1 : entry.weight);
        dialogueItemIf.value = conditionText(entry.if);
        dialogueItemId.value = entry.id;
        setDialogueItemStatus(dialogueState.dirty ? t('dialogue.item.staged') : '');
      }

      function selectDialogueEntry(id) {
        selectedEntryId = id;
        for (const row of Array.from(tableBody.children)) {
          row.classList.toggle('dialogue-row-selected', row.dataset.entry === id);
        }
        syncDialogueItemPanel();
      }

      async function applyDialogueItemFields() {
        if (!dialogueState) return;
        const entry = selectedDialogueEntry();
        if (!entry) {
          setDialogueItemStatus(t('dialogue.item.noneSelected'), 'wb-hint bad');
          return;
        }
        const text = dialogueItemText.value.trim();
        if (text === '') {
          setDialogueItemStatus(t('dialogue.item.textEmpty'), 'wb-hint bad');
          return;
        }
        // an empty box keeps what the entry already has; the panel never stages a blank
        const patch = { text, weight: entry.weight === undefined ? 1 : entry.weight };
        const weightText = dialogueItemWeight.value.trim();
        if (weightText !== '') {
          const weight = Number(weightText);
          if (!Number.isInteger(weight) || weight < 1 || weight > 20) {
            setDialogueItemStatus(t('dialogue.item.notWeight'), 'wb-hint bad');
            return;
          }
          patch.weight = weight;
        }
        const conditions = parseConditionText(dialogueItemIf.value);
        if (conditions.error) {
          setDialogueItemStatus(conditions.error, 'wb-hint bad');
          return;
        }
        // conditions travel with the patch: an empty box CLEARS them (an entry that had none
        // keeps none, so an apply never bolts a bare `if: {}` onto a plain line)
        if (Object.keys(conditions.value).length > 0 || entry.if !== undefined) patch.if = conditions.value;
        const unchanged = text === entry.text
          && JSON.stringify(patch.weight) === JSON.stringify(entry.weight === undefined ? 1 : entry.weight)
          && JSON.stringify(patch.if || {}) === JSON.stringify(entry.if || {});
        if (unchanged) {
          setDialogueItemStatus(t('dialogue.item.noChange'));
          return;
        }
        // THE ONLY WRITER PATH: dialogueEdit re-reads the layer, applies the patch and
        // DRY-RUNS the guard — a red line (secret shape, run id, path, bad weight…) is
        // refused HERE, at stage time, and never enters the staged document
        const commitHistory = rememberDoc(t('dialogue.historyUpdate'));
        let outcome;
        try {
          outcome = await studio.dialogueEdit({
            layer: dialogueState.layer, op: 'update', topic: selectedTopic, id: entry.id, patch,
          });
        } catch (error) {
          setDialogueItemStatus(t('dialogue.item.crashed', { message: String((error && error.message) || error) }), 'wb-hint bad');
          return;
        }
        if (!outcome.ok) {
          // THE REFUSAL: a red finding (secret shape · run id · path · a bad weight) is
          // refused here, at stage time — the staged document is untouched, so the form is
          // refilled from what stands, and the reason is the guard's own code
          syncDialogueItemPanel();
          const first = (outcome.findings || [])[0] || {};
          const code = first.code || outcome.code || 'CORPUS_INVALID';
          const detail = String(first.detail || outcome.message || '').slice(0, 80);
          setDialogueItemStatus(t('dialogue.item.refused', { code, detail }), 'wb-hint bad');
          return;
        }
        dialogueState.doc = outcome.doc;
        dialogueState.validation = outcome.validation;
        dialogueState.dirty = true;
        commitHistory();
        renderDialogue();
        setDialogueItemStatus(t('dialogue.item.applied'));
      }

      function renderDialogue() {
        if (!dialogueState) return;
        const { doc, layer, validation } = dialogueState;
        const topics = Object.entries(bucketOf(doc, layer));
        // the rail: one row per topic, with its entry count; the current one is marked
        topicsEl.replaceChildren();
        for (const [topic, entries] of topics) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dialogue-topic';
          button.setAttribute('aria-pressed', String(topic === selectedTopic));
          const name = document.createElement('span');
          name.className = 'dialogue-topic-name';
          name.textContent = topic;
          const count = document.createElement('span');
          count.className = 'dialogue-topic-count';
          count.textContent = String(entries.length);
          button.append(name, count);
          button.addEventListener('click', () => {
            if (selectedTopic === topic) return;
            selectedTopic = topic;
            selectedEntryId = null;
            renderDialogue();
          });
          topicsEl.appendChild(button);
        }
        tableBody.replaceChildren();
        const rows = selectedTopic && bucketOf(doc, layer)[selectedTopic];
        if (!selectedTopic) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.className = 'wb-empty';
          cell.textContent = t('empty.dialogue');
          row.appendChild(cell);
          tableBody.appendChild(row);
        } else if ((rows || []).length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 5;
          cell.className = 'wb-empty';
          cell.textContent = t('dialogue.emptyTopicPrefix', { topic: selectedTopic }) + t('empty.dialogue.topic');
          row.appendChild(cell);
          tableBody.appendChild(row);
        } else {
          for (const entry of rows || []) {
            const row = document.createElement('tr');
            row.dataset.entry = entry.id;
            if (layer === 'character') row.className = 'dialogue-source-character';
            if (entry.id === selectedEntryId) row.classList.add('dialogue-row-selected');
            const cells = [entry.id, entry.text, String(entry.weight === undefined ? 1 : entry.weight), entry.if ? JSON.stringify(entry.if) : ''];
            for (const [index, value] of cells.entries()) {
              const cell = document.createElement('td');
              cell.textContent = value;
              if (index === 3) cell.className = 'dialogue-condition';
              row.appendChild(cell);
            }
            const actions = document.createElement('td');
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = t('dialogue.rowRemove');
            remove.addEventListener('click', async (event) => {
              // the row also selects — a delete must not also leave the inspector on a
              // line that has just gone
              event.stopPropagation();
              const commitHistory = rememberDoc(t('dialogue.historyRemove'));
              const outcome = await studio.dialogueEdit({ layer, op: 'remove', topic: selectedTopic, id: entry.id });
              if (!outcome.ok) { setDialogueStatus(t('dialogue.removeRefused', { code: outcome.code }), 'wb-hint bad'); return; }
              if (selectedEntryId === entry.id) selectedEntryId = null;
              dialogueState.doc = outcome.doc;
              dialogueState.dirty = true;
              commitHistory();
              renderDialogue();
              setDialogueStatus(t('dialogue.stagedRemove', { id: entry.id }), 'wb-hint warn');
            });
            actions.appendChild(remove);
            row.appendChild(actions);
            row.addEventListener('click', () => selectDialogueEntry(entry.id));
            tableBody.appendChild(row);
          }
        }
        // the guard report: red findings block the save, yellow ones are informed notes
        const reds = validation.findings.filter((finding) => finding.severity === 'red');
        const yellows = validation.findings.filter((finding) => finding.severity === 'yellow');
        window.__wbProblems?.problems?.set('dialogue', validation.findings.map((finding) => ({
          severity: finding.severity, code: finding.code, message: finding.detail || finding.message || '',
          target: { page: 'dialogue', tab: 'tab-dialogue' },
        })));
        setDialogueStatus(
          t('dialogue.statusLine', {
            layer,
            topics: topics.length,
            lines: topics.reduce((sum, [, list]) => sum + list.length, 0),
            check: reds.length ? t('dialogue.statusErrors', { count: reds.length }) : t('dialogue.statusNoErrors'),
            notes: yellows.length ? t('dialogue.statusNotes', { count: yellows.length }) : '',
            details: reds.length ? t('dialogue.statusRedDetails', { details: reds.slice(0, 2).map((finding) => `${finding.code}:${finding.detail}`).join('；') }) : '',
            dirty: dialogueState.dirty ? t('dialogue.statusDirty') : '',
          }),
          reds.length ? 'wb-hint bad' : (yellows.length || dialogueState.dirty ? 'wb-hint warn' : 'wb-hint'),
        );
        syncDialogueItemPanel();
      }

      async function loadDialogue(layer = layerSelect.value) {
        const read = await studio.dialogueRead({ layer });
        if (!read.ok) { setDialogueStatus(t('dialogue.loadFailed', { message: `${read.code} ${read.message || ''}` }), 'wb-hint bad'); return null; }
        dialogueState = { layer, doc: read.doc, validation: read.validation, dirty: false };
        const topics = Object.entries(bucketOf(read.doc, layer));
        selectedTopic = topics.length > 0 ? topics[0][0] : null;
        selectedEntryId = null;
        renderDialogue();
        return read;
      }

      // the CSV disclosure: import is a bulk operation, so it waits behind ⋯ until asked for
      csvMoreButton?.addEventListener('click', () => {
        if (!csvBox) return;
        const open = csvBox.hidden;
        csvBox.hidden = !open;
        csvMoreButton.setAttribute('aria-expanded', String(open));
      });

      layerSelect.addEventListener('change', () => { loadDialogue(layerSelect.value).catch((error) => setDialogueStatus(t('dialogue.loadFailed', { message: error.message }), 'wb-hint bad')); });
      document.getElementById('btn-dialogue-reload').addEventListener('click', () => { loadDialogue().catch(() => {}); });

      document.getElementById('btn-dialogue-add').addEventListener('click', async () => {
        if (!dialogueState || !selectedTopic) { setDialogueStatus(t('dialogue.noTopic'), 'wb-hint warn'); return; }
        const text = document.getElementById('dialogue-new-text').value.trim();
        const weight = Number(document.getElementById('dialogue-new-weight').value) || 1;
        if (!text) { setDialogueStatus(t('dialogue.textEmpty'), 'wb-hint warn'); return; }
        const id = `${selectedTopic}-${String(Date.now()).slice(-5)}`;
        const commitHistory = rememberDoc(t('dialogue.historyAdd'));
        const outcome = await studio.dialogueEdit({ layer: dialogueState.layer, op: 'add', topic: selectedTopic, entry: { id, text, weight } });
        if (!outcome.ok) { setDialogueStatus(t('dialogue.addRefused', { message: `${outcome.code} ${outcome.message || ''}` }), 'wb-hint bad'); return; }
        selectedEntryId = id;
        dialogueState.doc = outcome.doc;
        dialogueState.validation = outcome.validation;
        dialogueState.dirty = true;
        commitHistory();
        document.getElementById('dialogue-new-text').value = '';
        renderDialogue();
        setDialogueStatus(t('dialogue.staged', { id }), 'wb-hint warn');
      });

      document.getElementById('btn-dialogue-save').addEventListener('click', async () => {
        if (!dialogueState) return;
        const outcome = await studio.dialogueSave({ layer: dialogueState.layer, doc: dialogueState.doc });
        if (!outcome.ok) {
          setDialogueStatus(t('dialogue.saveRefused', {
            code: outcome.code,
            details: (outcome.findings || []).slice(0, 2).map((finding) => `${finding.code}:${finding.detail}`).join('；'),
          }), 'wb-hint bad');
          return;
        }
        if (outcome.noop) { setDialogueStatus(t('scene.syncNoop')); return; }
        dialogueState.dirty = false;
        renderDialogue();
        setDialogueStatus(t('dialogue.saved', {
          file: outcome.file.split('/').pop(),
          backup: outcome.backup ? t('dialogue.savedBackup', { backup: outcome.backup.split('/').pop() }) : '',
        }));
      });

      document.getElementById('btn-dialogue-csv').addEventListener('click', async () => {
        if (!dialogueState) return;
        const csv = document.getElementById('dialogue-csv').value;
        const outcome = await studio.dialogueImportCsv({ layer: dialogueState.layer, csv });
        if (!outcome.ok) { setDialogueStatus(t('dialogue.importRefused', { message: `${outcome.code} ${outcome.message || ''}` }), 'wb-hint bad'); return; }
        dialogueState.doc = outcome.doc;
        dialogueState.validation = outcome.validation;
        dialogueState.dirty = true;
        renderDialogue();
        setDialogueStatus(t('dialogue.importStaged', {
          added: outcome.added.length,
          skipped: outcome.skipped.length
            ? t('dialogue.importSkipped', { count: outcome.skipped.length, code: outcome.skipped[0].code })
            : '',
        }), 'wb-hint warn');
      });

      // 试说一句: the line goes ON THE DOCK, not into a paragraph here.
      const hideDockBubble = () => {
        if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
        if (bubbleOverlay) bubbleOverlay.hidden = true;
        dockEl?.classList.remove('wb-bubble-speaking');
      };
      const showDockBubble = (outcome) => {
        if (!bubbleOverlay) return;
        if (bubbleTimer) clearTimeout(bubbleTimer);
        bubbleOverlay.hidden = false;
        // the dock is highlighted while the bubble is up, so "the line attached to the
        // run layer" is visible rather than a claim in a status line
        dockEl?.classList.add('wb-bubble-speaking');
        // the corpus decides how long a bubble stays: limits.bubbleMs (the same number the
        // runtime uses), and the overlay honours it instead of picking its own timeout
        const ms = Number((outcome.limits && outcome.limits.bubbleMs) || (outcome.bubble && outcome.bubble.ms) || 3200);
        bubbleTimer = setTimeout(hideDockBubble, Math.max(400, ms));
      };

      document.getElementById('btn-dialogue-say').addEventListener('click', async () => {
        if (!selectedTopic) { setDialogueStatus(t('dialogue.noTopic'), 'wb-hint warn'); return; }
        const seed = document.getElementById('dialogue-say-seed').value || 'preview-1';
        const outcome = await studio.dialogueSay({ topic: selectedTopic, seed });
        if (!outcome.ok) { setDialogueStatus(t('dialogue.sayFailed', { code: outcome.code }), 'wb-hint bad'); return; }
        // the bubble text stays exactly what it was (the studio probe reads this element)
        bubbleEl.textContent = `「${outcome.line.text}」`;
        bubbleEl.title = t('dialogue.bubbleTitle', {
          source: outcome.source,
          weight: outcome.line.weight === undefined ? 1 : outcome.line.weight,
          ms: outcome.bubble.ms, chars: outcome.bubble.chars,
          cooldown: outcome.limits.cooldownMs, max: outcome.limits.maxConcurrent,
        });
        // "who" is what the preview can know: the topic being said, and — when the line came
        // from the override layer — the character that owns it (dialogueSay reports no
        // employee: the dock's own office page owns that, and this panel never talks to it)
        const character = outcome.source === 'character' && dialogueState.doc && dialogueState.doc.characterId
          ? dialogueState.doc.characterId
          : null;
        bubbleWhoEl.textContent = character ? `${outcome.topic} · ${character}` : String(outcome.topic);
        bubbleMetaEl.textContent = t('dialogue.bubbleMeta', {
          source: outcome.source,
          weight: outcome.line.weight === undefined ? 1 : outcome.line.weight,
          ms: outcome.bubble.ms,
        });
        showDockBubble(outcome);
        setDialogueStatus(t('dialogue.said', {
          source: outcome.source,
          pool: outcome.pick.pool, eligible: outcome.pick.eligible, seed,
          ms: outcome.bubble.ms,
        }));
      });

      document.getElementById('dialogue-item-apply').addEventListener('click', () => {
        applyDialogueItemFields().catch((error) => {
          setDialogueItemStatus(t('dialogue.item.crashed', { message: String((error && error.message) || error) }), 'wb-hint bad');
        });
      });
      document.getElementById('dialogue-item-refill').addEventListener('click', () => {
        // throw away what is half-typed and show the entry as it stands right now
        syncDialogueItemPanel();
        setDialogueItemStatus(t('dialogue.item.refill'));
      });
      // Enter in a field applies too — a deliberate press, not a keystroke
      dialogueItemForm.addEventListener('submit', (event) => { event.preventDefault(); applyDialogueItemFields(); });

      panelRefresh.set('tab-dialogue', () => loadDialogue(layerSelect.value));
      loadDialogue('base').catch((error) => setDialogueStatus(t('dialogue.loadFailed', { message: error.message }), 'wb-hint bad'));
    }

    // ---- the 观测 page: the employee table, the console's four sections, follow (T11) ----
    // The whole console used to be an inspector panel (a 440px column holding a 6-column
    // table and five stacked blocks). It is the observe page's own work area now: the table
    // is full width and the console's four jobs are four collapsed sections, so the first
    // screen is the picture (in the dock below) + the table. No id changed — only where the
    // node sits and whether a block is revealed.
    const previewUnavailable = document.getElementById('preview-unavailable');
    const previewBody = document.getElementById('preview-body');
    if (!studio || !studio.previewStatus) {
      previewUnavailable.hidden = false;
      previewBody.hidden = true;
    } else {
      const previewStatusEl = document.getElementById('preview-status');
      const previewTableBody = document.querySelector('#preview-table tbody');
      const previewExportResult = document.getElementById('preview-export-result');
      previewExportResult.textContent = t('preview.exportIdle');
      const playButton = document.getElementById('btn-preview-play');
      const followStatus = document.getElementById('preview-follow-status');
      const unfollowButton = document.getElementById('btn-preview-unfollow');
      let previewPoll = null;
      let previewPlaying = false;
      // T11 (handover §6-5): the employee the view is locked onto, by id. It survives the
      // 600ms table rebuilds because it lives here, not on the row.
      let followedEmployee = null;
      const FOLLOW_ZOOM = 2;          // the zoom an employee is watched at
      const FOLLOW_DEAD = { x: 48, y: 32 };   // drift before the view re-centres (px)
      // the stage's own zoom ceiling (app/stage.js ZOOM_MAX); staying clear of it is what
      // keeps the anchor factor from ever being a no-op
      const STAGE_ZOOM_CEILING = 3.94;

      const setPreviewStatus = (text, cls = 'wb-hint') => { previewStatusEl.className = cls; previewStatusEl.textContent = text; };
      const setFollowStatus = (text, cls = 'wb-note') => {
        if (!followStatus) return;
        followStatus.className = cls;
        followStatus.textContent = text;
      };

      // ---- FOLLOW: lock the dock's view onto one employee -------------------------
      // The stage exposes its transform as fit / zoom-at-a-point / state (app/stage.js:
      // there is no "centre on a point"). But zoom AT a point keeps THAT point fixed, so
      // the pivot that lands a world point on the centre of the viewport can be solved for:
      // one zoomBy() call, anchored at the pivot, puts the employee at the centre at the
      // zoom asked for. The view is the TOOL's business — this only reads the snapshot the
      // runner already pushed, and never reaches into the office frame.
      //
      // The employee positions are NORMALIZED (0..1) and the pivot maths is in the
      // scene's PIXELS, so the conversion happens HERE, once. It used to happen
      // nowhere: the raw 0..1 numbers went straight into the pivot, the view zoomed
      // to 2× as asked, and the employee landed ~1700px off-centre — the follow
      // "worked" (the transform moved, the row was marked) while the camera was
      // pointed at empty floor. Measured by the evidence driver (the employee's
      // screen offset vs the viewport centre, the same maths employeeScreenOffset
      // already uses for the dead zone).
      const stageViewportBox = () => {
        const element = document.getElementById('stage-viewport');
        return element ? element.getBoundingClientRect() : null;
      };
      // the pivot that centres the world point at zoomNext (see the note above). `translate`
      // is the stage's own x (for the x axis) or y (for the y axis) — they are solved the
      // same way, but with their own number, which is why it is a parameter.
      const centrePivot = (view, zoomNext, translate, world, centre) => (
        // a no-op factor is ignored by zoomBy, so an equal zoom has no pivot to solve for
        Math.abs(zoomNext - view.zoom) < 1e-9 ? 0
          : (translate / view.zoom - centre / zoomNext + world) / (1 / view.zoom - 1 / zoomNext)
      );
      // `position` is the employee's NORMALIZED position; the stage state carries the
      // scene's logical size, which is what turns it into the world point the pivot
      // maths needs.
      function stageCentreOn(position) {
        const box = stageViewportBox();
        if (!box || !position) return false;
        const before = stage.state();
        const worldX = (Number(position.x) || 0) * before.width;
        const worldY = (Number(position.y) || 0) * before.height;
        // an already-zoomed view cannot be re-anchored at the same zoom, so it is nudged by
        // 0.1%: invisible on screen, and the pivot maths still holds. The nudge is bounded
        // clear of the stage's own ceiling (where a clamp would make it a no-op), and a view
        // already sitting on that bound is nudged DOWN instead.
        let zoomNext = before.zoom < FOLLOW_ZOOM ? FOLLOW_ZOOM : before.zoom * 1.001;
        if (zoomNext > STAGE_ZOOM_CEILING) zoomNext = STAGE_ZOOM_CEILING;
        if (Math.abs(zoomNext - before.zoom) < 1e-9) zoomNext = before.zoom / 1.001;
        stage.zoomBy(zoomNext / before.zoom, {
          clientX: box.left + centrePivot(before, zoomNext, before.x, worldX, box.width / 2),
          clientY: box.top + centrePivot(before, zoomNext, before.y, worldY, box.height / 2),
        });
        return true;
      }
      function employeeScreenOffset(position, view, box) {
        if (!position || !box) return null;
        return {
          x: box.left + view.x + (Number(position.x) || 0) * view.width * view.zoom,
          y: box.top + view.y + (Number(position.y) || 0) * view.height * view.zoom,
        };
      }
      function markFollowedRow(employeeId) {
        for (const row of previewTableBody.children) {
          const on = Boolean(employeeId) && row.dataset.employee === employeeId;
          row.classList.toggle('preview-row-followed', on);
          row.setAttribute('aria-pressed', String(on));
        }
      }
      function releaseFollow({ silent = false, reason = null } = {}) {
        followedEmployee = null;
        if (unfollowButton) unfollowButton.hidden = true;
        setFollowStatus(silent ? '' : t('observe.released'), 'wb-note');
        markFollowedRow(null);
        // back to the panorama — the same fit every mode switch and 适应 uses
        stage.fit();
        if (reason) setStatus(reason);
      }
      function followEmployee(employee) {
        if (!employee) return;
        if (!employee.position) { setFollowStatus(t('observe.follow.noPosition', { id: employee.employeeId }), 'wb-note bad'); return; }
        followedEmployee = employee.employeeId;
        if (unfollowButton) unfollowButton.hidden = false;
        // the picture has to be the runtime one for a follow to mean anything
        if (stage.mode() !== 'run' && stage.mode() !== 'bench') stage.setMode('run', { silent: true });
        stageCentreOn(employee.position);
        markFollowedRow(employee.employeeId);
        const zoom = Math.round(stage.state().zoom * 100);
        setFollowStatus(t('observe.following', { id: employee.employeeId, zoom }), 'wb-note');
      }
      // called at the end of every status render (600ms while playing): re-mark the row and
      // re-centre when the employee has drifted out of the middle of the view
      function refreshFollow(payload) {
        if (!followedEmployee) return;
        const employee = (payload.employees || []).find((row) => row.employeeId === followedEmployee);
        if (!employee) { releaseFollow({ reason: t('observe.follow.gone', { id: followedEmployee }) }); return; }
        markFollowedRow(employee.employeeId);
        const box = stageViewportBox();
        const view = stage.state();
        const point = employeeScreenOffset(employee.position, view, box);
        if (!point || !box) return;
        if (Math.abs(point.x - (box.left + box.width / 2)) < FOLLOW_DEAD.x
          && Math.abs(point.y - (box.top + box.height / 2)) < FOLLOW_DEAD.y) return;
        stageCentreOn(employee.position);
        setFollowStatus(t('observe.following', { id: employee.employeeId, zoom: Math.round(stage.state().zoom * 100) }), 'wb-note');
      }
      if (unfollowButton) unfollowButton.addEventListener('click', () => releaseFollow());
      // the lock ends when the page does (the dock's picture belongs to the page looking at it)
      releaseFollowOnPageLeave = () => releaseFollow({ silent: true });

      // ---- gap #3: the EDIT/RUN comparison layer --------------------------------
      //
      // The follow lock answers "where is THIS employee"; the comparison answers the
      // other half — "what does the walk actually cross". It overlays the DERIVED
      // navigation graph (sceneWaypoints: the same ⛬ graph the runtime will walk)
      // and the workstations (the desks, which is what a station is derived from)
      // on the dock's runtime picture, plus the live employee dots on top. The
      // model is the pure module (app/compare.js); this is its wiring, and the
      // overlay's visibility is a stage view flag (#stage[data-compare]) — the
      // same one-source-of-truth rule the mode follows.
      const compareLayer = document.getElementById('stage-compare-layer');
      const compareButton = document.getElementById('btn-stage-compare');
      const compareStatus = document.getElementById('compare-status');
      // the derived half is cached: it changes only when the content does (a
      // content-changed refresh clears it), not on every 600ms poll
      let compareDerived = null;   // { width, height, nodes, edges, stations }
      let lastEmployees = [];      // the live half, refreshed by the same poll
      const setCompareStatus = (text, cls = 'wb-note') => {
        if (!compareStatus) return;
        compareStatus.className = cls;
        compareStatus.textContent = text;
      };
      async function loadCompareDerived() {
        const [graph, draft] = await Promise.all([
          studio.sceneWaypoints({}).catch(() => null),
          studio.sceneDraft({}).catch(() => null),
        ]);
        const scene = (draft && draft.scene) || (graph && graph.scene) || { width: 1280, height: 840 };
        const stations = (draft && Array.isArray(draft.items) ? draft.items : [])
          .filter((item) => item.kind === 'desk')
          .map((item) => ({ id: item.id, position: item.position }));
        compareDerived = {
          width: scene.width,
          height: scene.height,
          nodes: (graph && graph.nodes) || [],
          edges: (graph && graph.edges) || [],
          stations,
        };
        return compareDerived;
      }
      function renderCompare(employees) {
        if (!compareLayer || !stage.compareOn()) return null;
        if (!compareDerived) return null;
        const model = window.wbCompare
          ? window.wbCompare.buildCompareModel({ ...compareDerived, employees })
          : null;
        if (!model) return null;
        // the SVG lives in the scene's own coordinate space: the viewBox makes it
        // scale with #stage-world exactly like the canvas and the iframes do
        const parts = [`<svg viewBox="0 0 ${model.width} ${model.height}" aria-hidden="true">`];
        for (const edge of model.edges) {
          parts.push(`<line class="wb-compare-edge" x1="${edge.x1}" y1="${edge.y1}" x2="${edge.x2}" y2="${edge.y2}" />`);
        }
        for (const station of model.stations) {
          parts.push(`<circle class="wb-compare-station" cx="${station.x}" cy="${station.y}" r="10" />`);
        }
        for (const node of model.nodes) {
          parts.push(`<circle class="wb-compare-node" cx="${node.x}" cy="${node.y}" r="3" />`);
        }
        for (const employee of model.employees) {
          parts.push(`<circle class="wb-compare-employee" cx="${employee.x}" cy="${employee.y}" r="7" />`);
        }
        parts.push('</svg>');
        compareLayer.innerHTML = parts.join('');
        const counts = model.summary();
        setCompareStatus(t('observe.compareOn', counts));
        return model;
      }
      async function setCompare(on) {
        if (!stage.setCompare(on)) return;
        if (compareButton) compareButton.setAttribute('aria-pressed', String(on));
        if (!on) {
          if (compareLayer) compareLayer.innerHTML = '';
          setCompareStatus('');
          setStatus(t('observe.compareOff'));
          return;
        }
        // the overlay is about the RUNTIME picture, so turning it on brings the run
        // layer up (the same courtesy the play button pays)
        if (stage.mode() !== 'run' && stage.mode() !== 'bench') stage.setMode('run', { silent: true });
        setCompareStatus(t('observe.compareLoading'), 'wb-note');
        try {
          await loadCompareDerived();
        } catch (error) {
          setCompareStatus(t('observe.compareFailed', { message: error.message }), 'wb-hint bad');
          return;
        }
        renderCompare((await studio.previewStatus().catch(() => null) || { employees: [] }).employees || []);
      }
      if (compareButton) compareButton.addEventListener('click', () => {
        setCompare(!stage.compareOn()).catch((error) => setCompareStatus(t('observe.compareFailed', { message: error.message }), 'wb-hint bad'));
      });
      // a content change invalidates the derived half (the graph and the
      // workstations are derived from the layout/zones on disk): the next poll
      // re-fetches it, so the overlay can never show yesterday's graph
      studio.onContentChanged?.(() => { compareDerived = null; });

      function renderPreviewStatus(payload) {
        if (!payload || !payload.ok) {
          setPreviewStatus(t('preview.unavailable', { code: (payload && payload.code) || 'unknown' }), 'wb-hint bad');
          return;
        }
        const st = payload.status || {};
        const employees = payload.employees || [];
        setPreviewStatus(
          t('preview.statusLine', { layout: payload.layoutSource || '?', employees: employees.length })
          + t(st.playing ? 'preview.statusPlaying' : 'preview.statusPaused', { speed: st.speed || 1 })
          + t('preview.statusClock', { ms: st.logicalMs || 0, ticks: st.ticks || 0 })
          + t('preview.statusInjected', { count: st.injections || 0, seed: st.seed || t('preview.statusSeedNone') }),
        );
        previewTableBody.replaceChildren();
        if (employees.length === 0) {
          const row = document.createElement('tr');
          const cell = document.createElement('td');
          cell.colSpan = 6;
          cell.className = 'wb-empty';
          cell.textContent = t('empty.preview');
          row.appendChild(cell);
          previewTableBody.appendChild(row);
        }
        for (const employee of employees) {
          const row = document.createElement('tr');
          row.dataset.employee = employee.employeeId;
          row.tabIndex = 0;
          row.title = t('observe.followTitle', { id: employee.employeeId });
          row.setAttribute('aria-pressed', String(employee.employeeId === followedEmployee));
          const cells = [
            employee.employeeId,
            `${employee.activity || '—'}${employee.resource && employee.resource !== employee.activity ? ` · ${employee.resource}` : ''}`,
            employee.phase || '—',
            employee.outcome || '—',
            employee.segment || '—',
            employee.position ? `${employee.position.x.toFixed(3)}, ${employee.position.y.toFixed(3)}` : '—',
          ];
          for (const value of cells) {
            const cell = document.createElement('td');
            cell.textContent = String(value);
            row.appendChild(cell);
          }
          if (employee.bubble) {
            const cell = row.children[1];
            cell.textContent = t('preview.bubbleActivity', { activity: employee.activity || '', text: employee.bubble.text });
          }
          // a row is a follow affordance: click (or Enter/Space) toggles the view lock on
          // that employee. The row is rebuilt every 600ms, so the handler closes over THIS
          // render's employee and the lock itself lives in followedEmployee above.
          const toggleFollow = () => {
            if (followedEmployee === employee.employeeId) releaseFollow();
            else followEmployee(employee);
          };
          row.addEventListener('click', toggleFollow);
          row.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleFollow();
          });
          previewTableBody.appendChild(row);
        }
        previewPlaying = Boolean(st.playing);
        if (typeof previewRunning !== 'undefined') previewRunning = Boolean(st.playing) || (st.ticks || 0) > 0;
        playButton.textContent = previewPlaying ? t('btn.pause') : t('btn.play');
        refreshFollow(payload);
        // the comparison overlay's live half: the employee dots ride the same poll
        // the table does, so what the overlay shows is what the table says (and the
        // derived half is re-fetched only when the content changed under it)
        lastEmployees = employees;
        if (stage.compareOn()) {
          if (compareDerived) renderCompare(employees);
          else loadCompareDerived().then(() => renderCompare(lastEmployees)).catch(() => {});
        }
      }

      async function refreshPreview() {
        const payload = await studio.previewStatus();
        renderPreviewStatus(payload);
        return payload;
      }

      function startPolling() {
        if (previewPoll) return;
        previewPoll = setInterval(() => { refreshPreview().catch(() => {}); }, 600);
      }
      function stopPolling() {
        if (previewPoll) clearInterval(previewPoll);
        previewPoll = null;
      }

      // ---- the console's four sections: 一键脚本 / 手动发送事件 / 遥测 / 诊断包 ----
      // Each is its own disclosure and each starts CLOSED, so the observe page opens on the
      // picture and the table. The ids inside are the ones they have always been; a hidden
      // section is still in the DOM, which is why the probe's clicks keep working and why a
      // section never loses the state it was showing (the selected event type, a script
      // result, the last telemetry read) while it is collapsed.
      for (const buttonId of ['btn-preview-section-script', 'btn-preview-section-events', 'btn-preview-section-telemetry', 'btn-preview-section-bundle']) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        const box = document.getElementById(button.getAttribute('aria-controls'));
        if (!box) continue;
        const label = () => (button.querySelector('.wb-console-title') || {}).textContent || buttonId;
        button.addEventListener('click', () => {
          const open = button.getAttribute('aria-expanded') !== 'true';
          button.setAttribute('aria-expanded', String(open));
          box.hidden = !open;
          setStatus(`${open ? t('preview.sectionOpenedState') : t('preview.sectionCollapsedState')}：${label()}`);
        });
      }

      playButton.addEventListener('click', async () => {
        // hitting play is a request to SEE the animation: bring the run layer up and fit it
        if (!previewPlaying) stage.setMode('run', { silent: true });
        const outcome = previewPlaying
          ? await studio.previewPause()
          : await studio.previewPlay({ speed: Number(document.getElementById('preview-speed').value) || 1 });
        renderPreviewStatus({ ok: true, status: outcome.status, employees: (await studio.previewStatus()).employees, layoutSource: (await studio.previewStatus()).layoutSource });
        if (previewPlaying) startPolling(); else stopPolling();
      });
      document.getElementById('btn-preview-step').addEventListener('click', async () => {
        stage.setMode('run', { silent: true });
        const outcome = await studio.previewStep({ ticks: 16 });
        const payload = await studio.previewStatus();
        renderPreviewStatus({ ok: true, status: { ...payload.status, logicalMs: outcome.logicalMs, ticks: outcome.ticks }, employees: payload.employees, layoutSource: payload.layoutSource });
      });
      document.getElementById('btn-preview-restart').addEventListener('click', async () => {
        stage.setMode('run', { silent: true });
        const started = await studio.previewStart({});
        renderPreviewStatus({ ok: true, status: started.status, employees: started.employees, layoutSource: started.layoutSource });
        await studio.previewPlay({ speed: Number(document.getElementById('preview-speed').value) || 1 });
        startPolling();
      });
      document.getElementById('preview-speed').addEventListener('change', async () => {
        await studio.previewPlay({ speed: Number(document.getElementById('preview-speed').value) || 1 });
        startPolling();
        await refreshPreview();
      });
      for (const [id, scenario] of [['btn-preview-scenario-complete', 'task-complete'], ['btn-preview-scenario-failed', 'task-failed'], ['btn-preview-scenario-approval', 'approval-wait']]) {
        document.getElementById(id).addEventListener('click', async () => {
          setPreviewStatus(t('preview.scenario.running', { id: scenario }));
          const outcome = await studio.previewRunScenario({ id: scenario });
          if (!outcome.ok) {
            const failedLine = document.getElementById('preview-scenario-result');
            failedLine.className = 'wb-hint bad';
            failedLine.textContent = t('preview.scenario.failed', { code: outcome.code, message: outcome.message || '' });
            return;
          }
          stopPolling();
          // Drain one round trip: the scenario run blocks the main process for the whole
          // logical advance, so a poll issued just before it can resolve AFTER this handler
          // and overwrite the line below with the plain status — the P8 probe caught exactly
          // that race. IPC replies are ordered, so once this one lands every earlier poll has
          // already rendered and this write is the last word.
          await studio.previewStatus();
          const payload = await studio.previewStatus();
          renderPreviewStatus({ ok: true, status: payload.status, employees: outcome.employees, layoutSource: payload.layoutSource });
          // the result goes to its OWN line: #preview-status is live state and every refresh
          // (including a hot-reload refresh) re-renders it, which used to wipe this message
          // within a second — the P8 probe caught it the moment hot reload came alive
          const resultLine = document.getElementById('preview-scenario-result');
          resultLine.className = 'wb-hint good';
          resultLine.textContent = t('preview.scenario.done', { id: scenario, n: outcome.injected, ms: outcome.status.logicalMs });
        });
      }
      document.getElementById('btn-preview-inject').addEventListener('click', async () => {
        const type = document.getElementById('preview-event-type').value;
        const sessionId = document.getElementById('preview-session').value.trim() || 'sess-studio';
        const raw = document.getElementById('preview-data').value.trim();
        let data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (error) { setPreviewStatus(t('preview.jsonBad', { message: error.message }), 'wb-hint bad'); return; }
        }
        const outcome = await studio.previewInject({ type, sessionId, data });
        if (!outcome.ok) { setPreviewStatus(t('preview.injectRefused', { code: (outcome.result && outcome.result.code) || 'unknown' }), 'wb-hint bad'); return; }
        await refreshPreview();
        setPreviewStatus(t('preview.injected', { type, session: sessionId, result: JSON.stringify(outcome.result) }));
      });
      document.getElementById('btn-preview-export').addEventListener('click', async () => {
        const outcome = await studio.previewExport({ out: `build/diagnostics/preview-${Date.now()}.json` });
        if (!outcome.ok) { previewExportResult.textContent = t('preview.exportRefused', { hits: JSON.stringify(outcome.hits) }); return; }
        previewExportResult.textContent = [
          t('preview.exportOk'),
          t('preview.exportFile', { file: outcome.written }),
          t('preview.exportSize', { bytes: outcome.bytes, count: outcome.injections }),
          t('preview.exportTopLevel'),
        ].join('\n');
      });

      panelRefresh.set('tab-preview', () => refreshPreview());
      // the telemetry button + carrying the telemetry into the diagnostics bundle
      document.getElementById('btn-preview-telemetry').addEventListener('click', async () => {
        const telemetry = await studio.previewTelemetry();
        const el = document.getElementById('preview-telemetry');
        el.className = telemetry.ok ? 'wb-hint' : 'wb-hint bad';
        el.textContent = telemetry.ok
          ? `${t('telemetry.label')}：渲染后端 ${telemetry.backend} · 画布 ${telemetry.canvas ? `${telemetry.canvas.width}×${telemetry.canvas.height}` : '—'} · 空闲重绘 ${telemetry.rafPerSecond}/s · 页面布局源 ${telemetry.layoutSource || '—'} · 页面员工 ${telemetry.employees ?? '—'} · 页面诊断 ${telemetry.diagnostics.length} 条`
          : `${t('telemetry.label')}读取失败：${telemetry.code} ${telemetry.message || ''}`;
        return telemetry;
      });
      document.getElementById('btn-preview-export').addEventListener('click', async () => {
        const telemetry = await studio.previewTelemetry();
        const outcome = await studio.previewExport({ out: `build/diagnostics/preview-${Date.now()}.json`, extra: { rendererTelemetry: telemetry } });
        if (!outcome.ok) { previewExportResult.textContent = t('preview.exportRefused', { hits: JSON.stringify(outcome.hits) }); return; }
        previewExportResult.textContent = [
          t('preview.exportOkTelemetry'),
          t('preview.exportFile', { file: outcome.written }),
          t('preview.exportSizeSent', { bytes: outcome.bytes, count: outcome.injections }),
          t('preview.exportTelemetry', {
            telemetry: telemetry.ok
              ? `${telemetry.backend} · ${t('preview.telemetryIdle', { rate: telemetry.rafPerSecond })}`
              : (telemetry.code || t('preview.telemetryUnavailable')),
          }),
        ].join(String.fromCharCode(10));
      }, { once: true });
      refreshPreview().then((payload) => { if (payload.ok && payload.status.playing) startPolling(); }).catch((error) => setPreviewStatus(t('preview.statusFailed', { message: error.message }), 'wb-hint bad'));
    }
  }
})();
