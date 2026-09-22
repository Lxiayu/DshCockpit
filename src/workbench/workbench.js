'use strict';

// src/workbench/workbench.js — the Workbench M0 shell renderer.
//
// Three panes: content/ tree (left), preview slot (center — a same-origin
// iframe hosting the tool-served copy of the office page), inspector tabs
// (right: geometry report / asset validator / golden gallery).
//
// Everything heavy (PNG measurement, validation, gallery rendering) runs in
// the main process; this file is presentation + selection plumbing only.

(() => {
  const bridge = window.workbenchBridge;
  const statusEl = document.getElementById('wb-status');
  if (!bridge) {
    if (statusEl) statusEl.textContent = 'workbench bridge missing（preload 未加载？）';
    return;
  }

  const setStatus = (text) => { statusEl.textContent = text || ''; };

  // ---- tabs ----
  const tabs = [
    ['tab-geometry', 'panel-geometry'],
    ['tab-actions', 'panel-actions'],
    ['tab-assets', 'panel-assets'],
    ['tab-gallery', 'panel-gallery'],
  ];
  for (const [tabId, panelId] of tabs) {
    document.getElementById(tabId).addEventListener('click', () => {
      for (const [otherTab, otherPanel] of tabs) {
        document.getElementById(otherTab).setAttribute('aria-pressed', String(otherTab === tabId));
        document.getElementById(otherPanel).hidden = otherPanel !== panelId;
      }
    });
  }

  // ---- center pane ----
  // The preview is a same-origin iframe laid out by the browser itself —
  // nothing to report or sync; the office page inside manages its own
  // scene-frame math on resize exactly as in the product.

  // ---- left pane: content/ resource tree ----
  const treeRoot = document.getElementById('tree-root');
  let selectedTreeFile = null;
  function buildTree(entries, container, depth) {
    for (const entry of entries) {
      if (entry.type === 'dir') {
        const dir = document.createElement('div');
        dir.className = 'tree-dir';
        const label = document.createElement('div');
        label.className = 'tree-dir-label';
        label.textContent = `${'· '.repeat(depth)}${entry.path.split('/').pop()}/`;
        dir.appendChild(label);
        const childBox = document.createElement('div');
        buildTree(entry.children || [], childBox, depth + 1);
        dir.appendChild(childBox);
        container.appendChild(dir);
      } else {
        const file = document.createElement('button');
        file.type = 'button';
        file.className = 'tree-file';
        file.textContent = `${'· '.repeat(depth)}${entry.path.split('/').pop()}${entry.bytes !== null && entry.bytes !== undefined ? `  (${entry.bytes}B)` : ''}`;
        file.dataset.path = entry.path;
        file.addEventListener('click', () => {
          for (const node of treeRoot.querySelectorAll('.tree-file.selected')) node.classList.remove('selected');
          file.classList.add('selected');
          selectedTreeFile = entry.path;
          refreshFileGeometry(entry.path);
        });
        container.appendChild(file);
      }
    }
  }
  bridge.contentTree().then((entries) => {
    treeRoot.replaceChildren();
    buildTree(entries, treeRoot, 0);
  }).catch((error) => {
    treeRoot.textContent = `content/ 树载入失败：${error.message}`;
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
      p.textContent = entry && entry.code ? `无法测量：${entry.code}` : '（无可测量的条目）';
      entryBody.appendChild(p);
      return;
    }
    const g = entry.geometry || entry;
    const drift = g.contentBboxDrift;
    entryBody.appendChild(renderKv([
      ['文件', entry.file || (entry.asset && entry.asset.src) || g.absPath],
      ['尺寸', g.width && g.height ? `${g.width}×${g.height}` : '—'],
      ['锚点', g.anchor ? `${g.anchor.x}, ${g.anchor.y}` : '—'],
      ['鞋线(α≥128)', g.footLine],
      ['可见宽/高', g.visibleWidth !== undefined ? `${g.visibleWidth} / ${g.visibleHeight}` : '—'],
      ['宽高比', g.aspect],
      ['bbox 漂移', drift ? drift.map((d) => `${d.key}:${d.delta >= 0 ? '+' : ''}${d.delta}`).join(' ') : (entry.asset && entry.asset.contentBbox ? '—' : '未声明')],
      ['状态', (g.red || (drift && drift.some((d) => Math.abs(d.delta) > 0.002))) ? '超差' : '通过', (g.red || (drift && drift.some((d) => Math.abs(d.delta) > 0.002))) ? 'bad' : 'ok'],
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
          ['文件', relPath],
          ['内容', entry.json ? `schemaVersion ${fmt(entry.json.schemaVersion)} · ${(entry.json.keys || []).join(', ')}` : '文本'],
        ]));
      }
    }).catch((error) => setStatus(`几何测量失败：${error.message}`));
  }

  // ---- right pane: geometry report ----
  const geometrySummary = document.getElementById('geometry-summary');
  const geometryBody = document.querySelector('#geometry-table tbody');
  const baseName = (file) => file.split('/').pop();

  function renderGeometryReport(report) {
    const medians = report.actions
      .filter((action) => action.medians)
      .map((action) => `${action.id} 中位：鞋线 ${action.medians.footLine} · 可见高 ${action.medians.visibleHeight}`)
      .join('｜');
    geometrySummary.textContent = `${medians}｜容差：鞋线±${report.tolerance.footPx}px / 高度±${report.tolerance.heightPx}px｜${report.totalFrames - report.redFrames}/${report.totalFrames} 帧通过`;
    geometryBody.replaceChildren(...report.rows.map((row) => {
      const tr = document.createElement('tr');
      tr.className = row.red ? 'red' : 'green';
      const cells = [
        `${row.action.replace('walk-', '')} · ${baseName(row.file)}`,
        row.anchor ? `${row.anchor.x},${row.anchor.y}` : '—',
        row.measured.footLine ?? row.measured.code ?? '—',
        row.measured.visibleHeight ?? '—',
        row.measured.visibleWidth ?? '—',
        row.measured.aspect ?? '—',
        row.deviation.footLine === null ? '—' : `${row.deviation.footLine > 0 ? '+' : ''}${row.deviation.footLine}`,
        row.deviation.visibleHeight === null ? '—' : `${row.deviation.visibleHeight > 0 ? '+' : ''}${row.deviation.visibleHeight}`,
        row.red ? '超差' : '通过',
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
    bridge.geometryReport().then(renderGeometryReport).catch((error) => setStatus(`几何报表失败：${error.message}`));
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
        ['草稿条目', `${item.id}（${item.kind} · layer ${item.layer} · scale ${item.scale}）`],
        ['位置', item.position ? `${Number(item.position.x).toFixed(3)}, ${Number(item.position.y).toFixed(3)}` : '—'],
        ['素材', entry && entry.asset ? `${entry.asset.label} · ${entry.asset.src}` : item.asset],
        ['尺寸', g && g.width ? `${g.width}×${g.height}` : (g && g.code) || '—'],
        ['锚点', g && g.anchor ? `${g.anchor.x}, ${g.anchor.y}` : '—'],
        ['鞋线(α≥128)', g ? g.footLine : '—'],
        ['可见宽/高', g && g.visibleWidth !== undefined ? `${g.visibleWidth} / ${g.visibleHeight}` : '—'],
        ['宽高比', g ? g.aspect : '—'],
        ['bbox 漂移', g && g.contentBboxDrift ? g.contentBboxDrift.map((d) => `${d.key}:${d.delta >= 0 ? '+' : ''}${d.delta}`).join(' ') : '未声明'],
        ['状态', g && g.red ? '超差' : '通过', g && g.red ? 'bad' : 'ok'],
      ]));
    }).catch(() => setStatus('选中条目几何测量失败'));
  });

  // ---- right pane: asset validator ----
  const assetSummary = document.getElementById('asset-summary');
  const assetBody = document.querySelector('#asset-table tbody');
  const mark = (ok) => (ok ? 'OK' : '✗');
  function renderAssetReport(rows) {
    const bad = rows.filter((row) => !row.ok);
    assetSummary.textContent = `${rows.length - bad.length}/${rows.length} 条通过${bad.length ? `：${bad.map((row) => row.id).join('、')}` : ''}`;
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
    bridge.assetReport().then(renderAssetReport).catch((error) => setStatus(`素材校验失败：${error.message}`));
  }
  document.getElementById('btn-refresh-assets').addEventListener('click', refreshAssetReport);
  refreshAssetReport();

  // publish validation (same kernel as scripts/workbench-publish.js)
  const publishResult = document.getElementById('publish-result');
  document.getElementById('btn-publish').addEventListener('click', () => {
    publishResult.textContent = '校验中…';
    bridge.publish().then((report) => {
      const lines = [`${report.ok ? 'OK — content/** 可发布' : `FAIL — ${report.violations.length} 项违规`}`, `扫描 ${report.filesScanned} 个文件`];
      for (const entry of report.entries) {
        lines.push(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.file} (${entry.checks.filter((c) => c.ok).length}/${entry.checks.length})`);
      }
      for (const violation of report.violations) {
        lines.push(`  [${violation.file}] ${violation.check}: ${typeof violation.detail === 'string' ? violation.detail : JSON.stringify(violation.detail)}`);
      }
      publishResult.textContent = lines.join('\n');
    }).catch((error) => {
      publishResult.textContent = `发布校验失败：${error.message}`;
    });
  });

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
  const actionTimeline = document.getElementById('action-timeline');
  const actionNewForm = document.getElementById('action-new-form');
  const actionNewId = document.getElementById('action-new-id');
  const actionNewDirection = document.getElementById('action-new-direction');
  const actionImportPath = document.getElementById('action-import-path');
  const actionImportName = document.getElementById('action-import-name');
  const actionImportResult = document.getElementById('action-import-result');
  const btnImportInsert = document.getElementById('btn-action-import-insert');
  const actionValidationBody = document.querySelector('#action-validation-table tbody');
  const actionPublishResult = document.getElementById('action-publish-result');
  const fmtMs = (value) => (value === null || value === undefined ? '默认' : `${value}ms`);

  let actionId = null;
  let actionFrames = [];      // [{index, file, basename, url, durationMs}]
  let actionValidation = null; // {ok, checks, rows}
  let actionDefaults = null;  // {defaultFrameDurationMs, packCanvas, packAnchor, footLine}
  let pendingImport = null;   // {sourcePath, name, index, dataUrl, metrics}
  let playback = null;        // {timer, actionId, frames, loop, defaultMs, startedAt, lastIndex}
  let stagedFor = null;       // {actionId, docStamp} — the draft pack the preview iframe booted from
  let stepIndex = 0;

  function previewWindow() {
    const frame = document.getElementById('preview-frame');
    return frame && frame.contentWindow ? frame.contentWindow : null;
  }
  function previewApi() {
    const win = previewWindow();
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
      displayName: '动作预览',
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
      const frame = document.getElementById('preview-frame');
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
      renderPublishBlock(`预览暂存被拒绝（不落盘）：\n${(staged.violations || []).map(formatViolation).join('\n')}`);
      return null;
    }
    if (!stagedFor || stagedFor.actionId !== actionId || stagedFor.docStamp !== docStamp) {
      const ready = await reloadPreviewForDraft();
      if (!ready) {
        setStatus('预览场未就绪（暂存包已写入 content/build/preview-pack）');
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
        actionPlayback.textContent = `播放中 · 帧 ${frameIndex + 1}/${playback.frames.length}`;
      }
    }, 80);
  });

  document.getElementById('btn-action-step').addEventListener('click', async () => {
    if (!actionId || actionFrames.length === 0) return;
    const docStamp = JSON.stringify(actionFrames.map((frame) => [frame.file, frame.durationMs])) + String(actionLoop.checked);
    const staged = await ensureDraftPreview(docStamp);
    if (!staged) return;
    stopPlaybackClock();
    const count = actionFrames.length;
    stepIndex = (stepIndex + 1) % count;
    if (pushPuppet(stepIndex)) actionPlayback.textContent = `逐帧 · 帧 ${stepIndex + 1}/${count}`;
  });

  document.getElementById('btn-action-stop').addEventListener('click', () => {
    stopPlaybackClock();
    stepIndex = 0;
    pushEmptyScene();
    actionPlayback.textContent = '已停止';
  });

  actionLoop.addEventListener('change', async () => {
    if (!actionId) return;
    await runActionOp('loop', { value: actionLoop.checked });
  });

  // ---- timeline render + ops ----

  function basename(file) {
    return file.split('/').pop();
  }

  function renderTimeline() {
    const cards = actionFrames.map((frame, index) => {
      const card = document.createElement('div');
      card.className = 'action-frame';
      card.draggable = true;
      card.dataset.index = String(index);
      card.dataset.file = frame.file;

      const badge = document.createElement('div');
      badge.className = 'action-frame-index';
      badge.textContent = `#${index + 1}${frame.durationMs === null || frame.durationMs === undefined ? '' : ` · ${frame.durationMs}ms`}`;

      const img = document.createElement('img');
      img.src = frame.url;
      img.alt = frame.basename;
      img.title = frame.file;

      const name = document.createElement('div');
      name.className = 'action-frame-name';
      name.textContent = frame.basename;
      name.title = frame.file;

      const ms = document.createElement('input');
      ms.type = 'number';
      ms.className = 'action-frame-ms';
      ms.min = String(bridge.actionModel.MIN_FRAME_MS);
      ms.max = String(bridge.actionModel.MAX_FRAME_MS);
      ms.placeholder = `默认 ${bridge.actionModel.DEFAULT_FRAME_DURATION_MS}ms`;
      ms.value = frame.durationMs === null || frame.durationMs === undefined ? '' : String(frame.durationMs);
      ms.title = '单帧时长（留空 = 包默认 1000ms；50–5000ms）';
      ms.addEventListener('change', () => {
        const raw = ms.value.trim();
        const value = raw === '' ? null : Number(raw);
        runActionOp('duration', { index, value });
      });

      const ops = document.createElement('div');
      ops.className = 'action-frame-ops';
      for (const [label, dir, title, enabled] of [
        ['←', -1, '前移一位', index > 0],
        ['→', 1, '后移一位', index < actionFrames.length - 1],
        ['✕', 0, '删除帧（只删序列引用，不删文件）', true],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.title = title;
        button.disabled = !enabled;
        button.addEventListener('click', () => {
          if (label === '✕') runActionOp('remove', { index });
          else runActionOp('move', { from: index, to: index + dir });
        });
        ops.appendChild(button);
      }

      card.append(badge, img, name, ms, ops);
      card.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', String(index));
        event.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragover', (event) => {
        event.preventDefault();
        card.classList.add('drag-over');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        card.classList.remove('drag-over');
        const from = Number(event.dataTransfer.getData('text/plain'));
        if (Number.isInteger(from)) runActionOp('move', { from, to: index });
      });
      return card;
    });

    const insertMarkers = [];
    for (let index = 0; index <= actionFrames.length; index += 1) {
      const marker = document.createElement('div');
      marker.className = 'action-insert';
      marker.textContent = '＋';
      marker.title = `在第 ${index + 1} 帧位置插入（先在下方导入并归一化）`;
      marker.addEventListener('click', () => {
        pendingImport = pendingImport && pendingImport.dataUrl ? { ...pendingImport, index } : null;
        actionImportName.placeholder = `插入位置：第 ${index + 1} 帧（留空自动编号）`;
        actionImportResult.replaceChildren();
        const hint = document.createElement('p');
        hint.className = 'wb-hint';
        hint.textContent = pendingImport ? '插入位置已更新 — 点击「插入到时间轴」' : `插入位置：第 ${index + 1} 帧 — 选择源 PNG 后点「归一化预览」`;
        actionImportResult.appendChild(hint);
      });
      insertMarkers.push(marker);
    }

    const nodes = [];
    for (let index = 0; index < cards.length; index += 1) {
      nodes.push(insertMarkers[index], cards[index]);
    }
    nodes.push(insertMarkers[cards.length]);
    if (cards.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'wb-hint';
      hint.textContent = '（空动作 — 用下方「导入帧」添加第一帧）';
      nodes.push(hint);
    }
    actionTimeline.replaceChildren(...nodes);
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
        row.red ? (row.code ? `异常 ${row.code}` : '超差') : '通过',
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
    actionSummary.textContent = `${actionId} · ${actionFrames.length} 帧 · 循环 ${actionLoop.checked ? '开' : '关'} · 一圈 ${total}ms · 校验 ${actionValidation && actionValidation.ok ? '全绿' : `${redCount} 红行（发布会被拒绝）`}`;
  }

  function applyActionState(payload) {
    actionFrames = payload.frames || [];
    actionValidation = payload.validation || null;
    actionDefaults = payload.defaults || actionDefaults;
    actionLoop.checked = Boolean(payload.doc && payload.doc.loop);
    renderTimeline();
    renderValidationTable();
    renderActionSummary();
  }

  async function runActionOp(op, payload) {
    if (!actionId) return;
    try {
      const outcome = await bridge.actionOp(actionId, op, payload);
      if (!outcome.ok) {
        setStatus(`操作被拒绝：${outcome.message || outcome.code}`);
        return;
      }
      applyActionState(outcome);
      if (!outcome.changed) setStatus('无变更（未记录）');
    } catch (error) {
      setStatus(`操作失败：${error.message}`);
    }
  }

  async function readAction(nextActionId) {
    actionId = nextActionId;
    const payload = await bridge.actionRead(actionId);
    if (!payload.ok) {
      setStatus(`动作载入失败：${payload.message || payload.code}`);
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
      option.textContent = `${entry.id}（${entry.frames.length} 帧）`;
      return option;
    }));
    const target = preferred && list.actions.some((entry) => entry.id === preferred) ? preferred : (list.actions[0] && list.actions[0].id);
    if (target) {
      actionSelect.value = target;
      await readAction(target);
    }
  }

  actionSelect.addEventListener('change', () => {
    stopPlaybackClock();
    pushEmptyScene();
    refreshActionList(actionSelect.value);
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
        setStatus(`新建动作被拒绝：${(outcome.violations || [{ detail: outcome.message || outcome.code }]).map((entry) => entry.detail).join('；')}`);
        return;
      }
      actionNewForm.hidden = true;
      actionNewId.value = '';
      await refreshActionList(id);
      setStatus(`动作 ${id} 已创建（content/actions/${id}.json）`);
    } catch (error) {
      setStatus(`新建动作失败：${error.message}`);
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
      setStatus('先填写源 PNG 路径');
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
      title.textContent = '归一化被拒绝（未写入任何文件）：';
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
    title.textContent = '归一化成功 — 预览（确定性：等比缩放 + 整数平移）';
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
      ['源', sourcePath],
      ['目标文件', outcome.name],
      ['插入位置', pendingImport.index === null ? '末尾（或点时间轴 ＋ 选位置）' : `第 ${pendingImport.index + 1} 帧`],
      ['鞋线（测得）', `${outcome.metrics.footLine}（Δ ${outcome.metrics.footLine - actionDefaults.footLine >= 0 ? '+' : ''}${outcome.metrics.footLine - actionDefaults.footLine}px 对 ${actionDefaults.footLine}）`],
      ['可见高（测得）', outcome.metrics.visibleHeight],
      ['缩放', outcome.metrics.scale.toFixed(4)],
      ['平移', `dx ${outcome.metrics.translation.dx}, dy ${outcome.metrics.translation.dy}`],
      ['状态', '可插入', 'ok'],
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
    try {
      const outcome = await bridge.actionImportInsert(actionId, pendingImport.sourcePath, name, pendingImport.index);
      if (!outcome.ok) {
        actionImportResult.replaceChildren();
        const title = document.createElement('p');
        title.className = 'bad';
        title.textContent = '插入被拒绝（未写入任何文件）：';
        actionImportResult.appendChild(title);
        for (const violation of outcome.violations || []) {
          const line = document.createElement('p');
          line.className = 'bad';
          line.textContent = `✗ ${formatViolation(violation)}`;
          actionImportResult.appendChild(line);
        }
        return;
      }
      setStatus(`已插入 ${outcome.file}（归一化 PNG 写入 content assets，尚未发布）`);
      await readAction(actionId);
    } catch (error) {
      setStatus(`插入失败：${error.message}`);
    }
  });

  document.getElementById('btn-action-validate').addEventListener('click', () => readAction(actionId));

  function renderPublishBlock(text) {
    actionPublishResult.textContent = text;
  }

  document.getElementById('btn-action-publish').addEventListener('click', async () => {
    if (!actionId) return;
    renderPublishBlock('发布中…（校验 → 备份 → 写 resources/** → provenance）');
    let outcome;
    try {
      outcome = await bridge.actionPublish(actionId);
    } catch (error) {
      renderPublishBlock(`发布失败：${error.message}`);
      return;
    }
    if (!outcome.ok) {
      const lines = ['发布被拒绝 — 不落盘（校验未全绿）：'];
      for (const violation of outcome.violations || []) lines.push(`  ✗ ${formatViolation(violation)}`);
      if (outcome.rolledBack) lines.push('  （写入中途失败 — 已从备份回滚）');
      renderPublishBlock(lines.join('\n'));
      setStatus(`发布被拒绝：${(outcome.violations || []).length} 项问题`);
      return;
    }
    if (outcome.noop) {
      renderPublishBlock('无变更 — 未写入（无备份、无 provenance）');
      setStatus('发布：无变更');
      return;
    }
    const summary = outcome.summary;
    const lines = [
      '已发布 ✓（resources/characters/deepseek-default）',
      `备份（可回滚）：${summary.backupDir}`,
      `provenance：${summary.provenancePath}`,
      `变更：${summary.changes.join('；')}`,
      `写入：${summary.rewritten.join(', ')}${summary.added.length ? `\n新增帧文件：${summary.added.join(', ')}` : ''}`,
    ];
    renderPublishBlock(lines.join('\n'));
    setStatus(`发布完成：${summary.backupDirRelative}`);
    refreshGeometryReport();
    bridge.contentTree().catch(() => {});
  });

  refreshActionList(new URLSearchParams(window.location.search).get('action')).catch((error) => {
    setStatus(`动作面板载入失败：${error.message}`);
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
      galleryProgress.textContent = '尚无金样运行 — 点击上方按钮生成第一轮基线';
      return;
    }
    galleryProgress.textContent = `${report.generatedAt} · ${report.baselineExisted ? '已与上一轮对比' : '第一轮：已建立基线'}${report.diff && report.diff.rows.length ? ` · ${report.diff.rows.length} 张图对比` : ''}`;
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
          ? '基线（首次运行，无对比）'
          : row.comparable === false
            ? `尺寸不一致（${row.reason}）`
            : `像素差 ${row.changedPixels}（${(row.diffRatio * 100).toFixed(4)}%）· maxΔ ${row.maxDelta}`;
        line.append(name, delta);
        galleryDiff.appendChild(line);
      }
      if (report.diff.geometry) {
        const line = document.createElement('div');
        line.className = `gallery-row ${report.diff.geometry.changedFrames > 0 ? 'bad' : 'ok'}`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = 'geometry.json（几何 diff）';
        const delta = document.createElement('span');
        delta.className = 'delta';
        delta.textContent = `${report.diff.geometry.frames.length} 帧中 ${report.diff.geometry.changedFrames} 帧几何变化`;
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
    galleryProgress.textContent = '金样渲染中…（3 档布局截图 + 4 张帧拼条 + diff）';
    bridge.generateGallery().then((outcome) => {
      galleryButton.disabled = false;
      if (!outcome.ok) {
        galleryProgress.textContent = `金样生成失败：${outcome.code} ${outcome.message || ''}`;
        return;
      }
      setStatus('金样图库已更新');
      return bridge.galleryStatus().then(renderGalleryStatus);
    }).catch((error) => {
      galleryButton.disabled = false;
      galleryProgress.textContent = `金样生成失败：${error.message}`;
    });
  });
  bridge.onGalleryProgress((data) => {
    if (data && data.step === 'rendering') galleryProgress.textContent = '金样渲染中…';
  });
})();
