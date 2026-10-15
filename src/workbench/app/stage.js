'use strict';

// src/workbench/app/stage.js — THE STAGE: the canvas in the middle of the window.
//
// WHY this is its own module: the stage owns a coordinate space, a view transform, three
// layers and the drop routing — the part of the shell that any page may drive but none of
// them owns. Keeping it here (instead of inside the 3300-line renderer) is what lets the
// scene page, the run page and the action page share ONE picture without copy-paste.
//
// It is a dual module like i18n.js: a classic script in the page (window.wbStage) and
// require()-able from Node for tests.
//
// The caller injects the shell's own services (status line, page switching, the library
// rows, the furniture drop handler) so this file never reaches into the shell.

function createStage(deps) {
  const document = deps.document || (typeof window !== 'undefined' ? window.document : null);
  // gap #6: the stage's own prose (mode hints, drop routing, status lines) goes
  // through the shell's translator like every other string. It is INJECTED, not
  // imported: this module stays pure and require()-able in Node, and the shell
  // already passes its services in (setStatus, activateTab) — `t` is one more.
  const tr = typeof deps.t === 'function' ? deps.t : (key) => key;
// THE STAGE --------------------------------------------------------------
//
// One canvas in the middle. Two layers share one coordinate space (1280×840, the
// scene's logical size): the EDIT layer is the layout you can drag furniture onto,
// the RUN layer is the product's own render (the office page iframe, driven by the
// real office module). The stage owns the view (zoom/pan/fit) and the mode, so
// "点了运行却什么也看不见" cannot happen — running fits the view first.
//
// The office iframe is laid out by the browser itself; the page inside manages its
// own scene-frame math on resize exactly as in the product.
const stageRoot = document.getElementById('stage');
const stageViewport = document.getElementById('stage-viewport');
const stageWorld = document.getElementById('stage-world');
const stageEmpty = document.getElementById('stage-empty');
const stageHint = document.getElementById('stage-hint');
const stageZoomLabel = document.getElementById('stage-zoom');
const previewSlot = document.getElementById('preview-slot');
const stageState = {
  mode: 'edit',            // 'edit' | 'run'
  zoom: 1,
  x: 0,
  y: 0,
  width: 1280,             // the world's logical size (the scene's, once loaded)
  height: 840,
  hasScene: false,
  items: 0,
};
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 4;

function stageApply() {
  if (!stageWorld) return;
  stageWorld.style.transform = `translate(${stageState.x}px, ${stageState.y}px) scale(${stageState.zoom})`;
  if (stageZoomLabel) stageZoomLabel.textContent = `${Math.round(stageState.zoom * 100)}%`;
  stageWorld.style.width = `${stageState.width}px`;
  stageWorld.style.height = `${stageState.height}px`;
}
function stageSetWorld({ width, height, hasScene }) {
  if (Number.isFinite(width) && width > 0) stageState.width = width;
  if (Number.isFinite(height) && height > 0) stageState.height = height;
  if (hasScene !== undefined) stageState.hasScene = Boolean(hasScene);
  stageApply();
  stageUpdateEmpty();
}
function stageUpdateEmpty() {
  if (!stageEmpty) return;
  // the empty state is about the EDIT layer: in run mode the office page is there
  stageEmpty.hidden = !(stageState.mode === 'edit' && !stageState.hasScene && stageState.items === 0);
  // (bench and run both have a live picture, so the hint never shows there)
}
function stageFit() {
  const box = stageViewport ? stageViewport.getBoundingClientRect() : null;
  if (!box || box.width < 20 || box.height < 20) return;
  const margin = 16;
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min(
    (box.width - margin * 2) / stageState.width,
    (box.height - margin * 2) / stageState.height,
  )));
  stageState.zoom = Number(zoom.toFixed(4));
  stageState.x = Math.round((box.width - stageState.width * stageState.zoom) / 2);
  stageState.y = Math.round((box.height - stageState.height * stageState.zoom) / 2);
  stageApply();
}
function stageReset() {
  stageState.zoom = 1;
  stageState.x = 8;
  stageState.y = 8;
  stageApply();
}
function stageZoomBy(factor, anchor = null) {
  const box = stageViewport ? stageViewport.getBoundingClientRect() : null;
  const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, stageState.zoom * factor));
  if (Math.abs(next - stageState.zoom) < 1e-6) return;
  if (box && anchor) {
    // keep the point under the cursor fixed while zooming
    const px = (anchor.clientX - box.left - stageState.x) / stageState.zoom;
    const py = (anchor.clientY - box.top - stageState.y) / stageState.zoom;
    stageState.zoom = next;
    stageState.x = (anchor.clientX - box.left) - px * next;
    stageState.y = (anchor.clientY - box.top) - py * next;
  } else {
    stageState.zoom = next;
  }
  stageApply();
}
const STAGE_MODE_HINTS = {
  edit: () => tr('stage.hint.edit'),
  run: () => tr('stage.hint.run'),
  bench: () => tr('stage.hint.bench'),
};
function stageSetMode(mode, { silent = false } = {}) {
  const next = ['run', 'bench'].includes(mode) ? mode : 'edit';
  stageState.mode = next;
  stageRoot.dataset.mode = next;
  for (const [id, value] of [['btn-stage-mode-edit', next === 'edit'], ['btn-stage-mode-run', next === 'run']]) {
    const button = document.getElementById(id);
    if (button) button.setAttribute('aria-pressed', String(value));
  }
  if (stageHint) stageHint.textContent = STAGE_MODE_HINTS[next]();
  stageUpdateEmpty();
  // a mode switch always lands on a visible frame: that is the whole point of the fit
  stageFit();
  if (!silent) deps.setStatus(next === 'run' ? tr('stage.statusRun') : next === 'bench' ? tr('stage.statusBench') : tr('stage.statusEdit'));
  return next;
}
// gap #3: the comparison overlay is a VIEW flag, the same shape as the mode: the
// value lives on #stage[data-compare] and CSS decides what that means (the layer
// only shows over the RUN picture — in edit mode the scene canvas draws its own
// graph). The stage owns the attribute so no other module toggles a display.
function stageSetCompare(on) {
  stageRoot.dataset.compare = on ? 'on' : 'off';
  return stageRoot.dataset.compare === 'on';
}
function stageCompareOn() {
  return stageRoot.dataset.compare === 'on';
}
// gap #6: the mode hint is JS-set (it depends on the mode), so the attribute-driven
// translation pass cannot reach it — a language switch asks the stage to re-render it
function stageRefreshHint() {
  if (stageHint) stageHint.textContent = STAGE_MODE_HINTS[stageState.mode]();
  return stageState.mode;
}
// the scene canvas knows the real logical size; the stage follows it so the RUN layer
// and the EDIT layer can never disagree about the coordinate space
function stageAnnounce({ width, height, items, hasScene } = {}) {
  stageSetWorld({ width, height, hasScene });
  if (Number.isFinite(items)) { stageState.items = items; stageUpdateEmpty(); }
  return { ...stageState };
}

if (stageViewport) {
  // wheel = zoom at the cursor (the habitual canvas behaviour)
  stageViewport.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
    event.preventDefault();
    stageZoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { clientX: event.clientX, clientY: event.clientY });
  }, { passive: false });
  // pointer drag on the background = pan (dragging an ITEM is the scene canvas's own
  // business, so panning only starts when the gesture begins on the viewport itself)
  let pan = null;
  stageViewport.addEventListener('pointerdown', (event) => {
    if (event.target !== stageViewport && event.target !== stageWorld) return;
    if (event.button !== 0 && event.button !== 1) return;
    pan = { id: event.pointerId, x: event.clientX - stageState.x, y: event.clientY - stageState.y };
    stageViewport.classList.add('wb-panning');
    try { stageViewport.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
  });
  stageViewport.addEventListener('pointermove', (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    stageState.x = Math.round(event.clientX - pan.x);
    stageState.y = Math.round(event.clientY - pan.y);
    stageApply();
  });
  const endPan = (event) => {
    if (!pan || (event && event.pointerId !== pan.id)) return;
    pan = null;
    stageViewport.classList.remove('wb-panning');
  };
  stageViewport.addEventListener('pointerup', endPan);
  stageViewport.addEventListener('pointercancel', endPan);
  // keyboard: arrows pan, +/- zoom, 0 fits
  stageViewport.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 80 : 24;
    const pans = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (pans[event.key]) {
      event.preventDefault();
      stageState.x += pans[event.key][0];
      stageState.y += pans[event.key][1];
      stageApply();
      return;
    }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); stageZoomBy(1.15); }
    else if (event.key === '-' || event.key === '_') { event.preventDefault(); stageZoomBy(1 / 1.15); }
    else if (event.key === '0' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); stageFit(); }
  });
}
for (const [id, handler] of [
  ['btn-stage-fit', () => { stageFit(); deps.setStatus(tr('status.stageFit')); }],
  ['btn-stage-reset', () => { stageReset(); deps.setStatus(tr('stage.statusReset')); }],
  ['btn-stage-zoom-in', () => stageZoomBy(1.15)],
  ['btn-stage-zoom-out', () => stageZoomBy(1 / 1.15)],
  ['btn-stage-mode-edit', () => stageSetMode('edit')],
  ['btn-stage-mode-run', () => stageSetMode('run')],
  ['btn-stage-mode-bench', () => stageSetMode('bench')],
]) {
  const button = document.getElementById(id);
  if (button) button.addEventListener('click', handler);
}
document.getElementById('btn-stage-mode-edit')?.setAttribute('aria-pressed', 'true');
// the comparison overlay starts OFF, and the attribute is declared here so the
// CSS has a value to match from the first paint
if (stageRoot && !stageRoot.dataset.compare) stageRoot.dataset.compare = 'off';
stageApply();
stageUpdateEmpty();

// ---- dropping files from the tree onto the canvas ---------------------------
//
// The tree is the palette of things you can put on the canvas. What a drop means is
// decided by the file, and nothing is invented: furniture goes INTO the layout through
// the same validated transaction the canvas uses, an action frame opens the frame
// inspector, a document opens its tool. Anything else is refused WITH the reason.
function extensionOf(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filePath || ''));
  return match ? match[1].toLowerCase() : '';
}
const DOCUMENT_TOOLS = [
  { match: /^scenes\/[^/]+\/layout\.json$/, tool: 'tab-scene', what: () => tr('drop.what.layout') },
  { match: /^scenes\/[^/]+\/scene\.json$/, tool: 'tab-scene', what: () => tr('drop.what.scene') },
  { match: /^scenes\/[^/]+\/zones\.json$/, tool: 'tab-scene', what: () => tr('drop.what.zones') },
  { match: /^graphs\/.*\.vgraph\.json$/, tool: 'tab-graph', what: () => tr('drop.what.graph') },
  { match: /^actions\/[^/]+\.json$/, tool: 'tab-actions', what: () => tr('drop.what.action') },
  { match: /^dialogue\/.*\.(json|csv)$/, tool: 'tab-dialogue', what: () => tr('drop.what.dialogue') },   // .csv = the batch-import file
  { match: /^project\.json$/, tool: 'tab-passport', what: () => tr('drop.what.project') },
  { match: /character\.json$/, tool: 'tab-passport', what: () => tr('drop.what.character') },
];
function actionIdFromPath(filePath) {
  const frame = /assets\/actions\/([^/]+)\//.exec(String(filePath));
  if (frame) return frame[1];
  const doc = /(?:^|\/)actions\/([^/]+)\.json$/.exec(String(filePath));
  return doc ? doc[1] : null;
}
function dropPointInWorld(event) {
  const box = stageViewport.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left - stageState.x) / stageState.zoom) / stageState.width,
    y: ((event.clientY - box.top - stageState.y) / stageState.zoom) / stageState.height,
  };
}
async function handleStageDrop(filePath, event) {
  const path0 = String(filePath || '');
  const ext = extensionOf(path0);
  const point = event ? dropPointInWorld(event) : null;
  // 1) furniture images go into the layout (the only drop that writes content)
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) && dropFurnitureHandler) {
    const outcome = await dropFurnitureHandler(path0, point);
    if (outcome) return outcome;
  }  // 2) an action frame: show it frame by frame in the bench
  const actionId = actionIdFromPath(path0);
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext) && actionId) {
    deps.activateTab('tab-bench');
    const select = document.getElementById('bench-action');
    if (select && [...select.options].some((option) => option.value === actionId)) {
      select.value = actionId;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    deps.setStatus(tr('drop.openedReview', { id: actionId }));
    return { ok: true, kind: 'action-frame', actionId };
  }
  // 3) documents open their tool
  for (const entry of DOCUMENT_TOOLS) {
    if (entry.match.test(path0)) {
      deps.activateTab(entry.tool);
      const graphSelect = document.getElementById('graph-file');
      if (entry.tool === 'tab-graph' && graphSelect) {
        const options = [...graphSelect.options];
        const match = options.find((option) => path0.endsWith(String(option.value)));
        if (match) { graphSelect.value = match.value; graphSelect.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      deps.setStatus(tr('drop.opened', { what: entry.what(), name: path0.split('/').pop() }));
      return { ok: true, kind: 'document', tool: entry.tool };
    }
  }
  const message = tr('drop.unsupported', { name: path0.split('/').pop() });
  deps.setStatus(message);
  if (stageHint) stageHint.textContent = message;
  return { ok: false, kind: 'unsupported', code: 'DROP_UNSUPPORTED', path: path0 };
}
let dropFurnitureHandler = null;      // wired by the scene block (it owns the asset catalog)
// gap #5: the drag landing preview's wiring — the tile records what is dragged, the
// scene page draws it, and both are cleared when the gesture ends
let draggedFurniture = null;          // the furniture row being dragged (or null)
let dragPreviewHandler = null;        // (row, point) → draw the ghost
let dragEndHandler = null;            // () → hide the ghost

if (stageViewport) {
  stageViewport.addEventListener('dragover', (event) => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    stageViewport.classList.add('wb-drop-active');
    // gap #5: the landing preview. dragover cannot read the dataTransfer (the drag
    // is still in protected mode), so the tile that STARTED the drag told us what
    // it is (noteFurnitureDrag); this hands the point to the page that owns the
    // scene, which draws the ghost and colours it by the validator's verdict.
    if (draggedFurniture && dragPreviewHandler && stageState.mode === 'edit') {
      dragPreviewHandler(draggedFurniture, dropPointInWorld(event));
    }
  });
  stageViewport.addEventListener('dragleave', (event) => {
    if (event.target === stageViewport) {
      stageViewport.classList.remove('wb-drop-active');
      if (dragEndHandler) dragEndHandler();
    }
  });
  stageViewport.addEventListener('drop', async (event) => {
    event.preventDefault();
    stageViewport.classList.remove('wb-drop-active');
    // the ghost has said its piece the moment the drop lands: the handler below
    // draws the real item (or refuses it), so the preview goes away first
    if (dragEndHandler) dragEndHandler();
    const furnitureAsset = event.dataTransfer ? event.dataTransfer.getData('application/x-wb-furniture') : '';
    if (furnitureAsset && dropFurnitureHandler) {
      await dropFurnitureHandler(furnitureAsset, dropPointInWorld(event));
      return;
    }
    const filePath = event.dataTransfer ? (event.dataTransfer.getData('application/x-wb-path') || event.dataTransfer.getData('text/plain')) : '';
    if (!filePath) return;
    await handleStageDrop(filePath, event);
  });
}

  return {
    // view
    apply: stageApply,
    fit: stageFit,
    reset: stageReset,
    zoomBy: stageZoomBy,
    setWorld: stageSetWorld,
    announce: stageAnnounce,
    updateEmpty: stageUpdateEmpty,
    // modes + routing
    setMode: stageSetMode,
    mode: () => stageState.mode,
    // the comparison overlay's flag (gap #3): the attribute lives on #stage, so
    // this is the only door to it
    setCompare: stageSetCompare,
    compareOn: stageCompareOn,
    // gap #6: re-render the mode hint (a language switch re-translates the chrome,
    // but this line is JS-set, so it has to be asked)
    refreshHint: stageRefreshHint,
    state: () => ({ ...stageState }),
    dropPointInWorld,
    handleDrop: handleStageDrop,
    setFurnitureDropHandler: (handler) => { dropFurnitureHandler = handler; },
    // gap #5: the drag landing preview. The library tile records WHAT is being
    // dragged (dragstart cannot be read back during dragover); the scene page
    // registers the preview handler that draws it. Both are cleared together.
    noteFurnitureDrag: (row) => { draggedFurniture = row || null; },
    furnitureDrag: () => draggedFurniture,
    setDragPreviewHandler: (handler) => { dragPreviewHandler = handler; },
    setDragEndHandler: (handler) => { dragEndHandler = handler; },
    DOCUMENT_TOOLS,
  };
}

const wbStageApi = { createStage };
if (typeof window !== 'undefined') window.wbStage = wbStageApi;
if (typeof module !== 'undefined' && module.exports) module.exports = wbStageApi;
