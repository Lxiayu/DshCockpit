'use strict';

// src/office/render/pixi-office-renderer.js — Task 7 / SPEC-07.
//
// Pixi renderer for the flat 2D orthographic office. It is a PURE projection
// of Office snapshots: it never imports Harness/IPC/Electron, never subscribes
// to events, never advances the simulation. Every visible change enters through
// `applySnapshot(snapshot)` — the snapshot/derived view model produced by the
// main-process office module. User intent (selection) leaves through the
// return value of `hitTest` and is expressed by the page over office:* IPC.
//
// Contracts (SPEC-07 / decisions 33/34/43):
// - ONE Pixi Application per view; fixed layer order Background -> Back
//   Furniture -> Ground Entities -> Front Occluders -> Effects/Labels
// - ONE persistent Container + Sprite per employee for the whole view
//   lifetime: position/texture/animation updates swap content in place and
//   never destroy/recreate nodes
// - foot anchor: the node's logical position IS the foot point; sprite.x/y
//   place the frame's outputAnchor exactly on it. No CSS/offset compensation.
// - shared visible height clamp(64px, sceneHeight * 0.11, 180px) for every
//   employee and state; resize reprojects only (logical data lives in the
//   snapshot, the renderer just re-multiplies)
// - ground entities re-sort stably by (footY, layer, entityType, id) via the
//   layout accessor
// - placeholder furniture (desk backs/fronts/chairs) is deterministic Pixi
//   Graphics drawn from the fixture geometry — diagnostic placeholders, not
//   final art. Front occluders are fixture-declared.
// - init failure chain: WebGL -> Canvas -> static diagnostic presentation
//   (stable code `WEBGL_INIT_FAILED`), never a thrown error into the shell
// - pause()/resume() only stop/start the Pixi render ticker; there is no
//   renderer-owned logic ticker (the main process owns the single clock)
// - destroy() releases THIS view's owned textures and application; two views
//   never share mutable Pixi resources
// - runtime FPS observer (Task 9 blocker B / SPEC-07, corrected 2026-09-24):
//   when the caller arms `fpsMonitor`, a presentation-rate observer counts
//   rendered frames and degrades THIS view to the static diagnostic
//   presentation with the stable code `LOW_FPS_PERSISTENT` after sustained
//   sub-threshold windows. The observer never advances movement/animation and
//   never creates a simulation ticker.
//   - FOREGROUND GATING (2026-09-24 latch fix): the frame pump only runs while
//     this view is the foreground/active main view (`setVisible(true)`).
//     A detached view (syncShellViews() removeChildView while the harness is
//     active) still presents frames — its rAF pump keeps running because
//     backgroundThrottling is false — but only at ~1.3-7.9 fps; feeding those
//     to the monitor used to latch LOW_FPS_PERSISTENT after ~2 minutes in the
//     harness and permanently kill the scene. setVisible(false) stops the
//     pump (rendering itself is snapshot-push driven and unaffected); the
//     transition back to foreground RESETS the monitor window so detached-rate
//     frames can never mix into a foreground window.
//   - BOUNDED RECOVERY (2026-09-24, SPEC-07 contract correction): one rebuild
//     attempt per re-activation, at most 3 per session, and ONLY for the
//     recoverable LOW_FPS_PERSISTENT case. WEBGL_INIT_FAILED /
//     RENDERER_UNAVAILABLE are hard failures: a rebuild would just fail again,
//     so they are never retried.
//   - PRESENTATION GATE (2026-09-25 wake self-heal): the observer only measures
//     while the screen actually presents this view (`setPresenting`). Lock /
//     display-sleep / suspend throttles the page to ~1.3 fps (soak-measured);
//     those frames are an environment fact, not a renderer defect — the pump
//     and the stall watchdog stop while `presenting=false`, the in-flight
//     window is discarded on wake, and the recovery budget is never consumed
//     in that state. The wake edge (presenting false→true) AUTO-HEALS a
//     LOW_FPS_PERSISTENT static view with one bounded rebuild (same
//     attemptRecovery path, same session cap, hard failures still never
//     retried) — no view switch or manual retry needed.

const { createFpsMonitor } = require('./fps-monitor.js');
// P3.0: pure present-time interpolation between the two most recent snapshots.
// It decides WHERE a sprite is drawn, never what the office state is.
const { createPresentationClock } = require('./presentation-clock.js');
// P3.1: the code-drawn scene description (pure geometry + palette). Off by
// default — enabling it swaps the flat floor band for a programmatic floor.
const { describeCodeScene, ACCENTS } = require('./code-scene.js');
// P3.1b: a generated office layout (desks/monitors/chairs/lounge/kitchen) built
// from the seat anchors — the visual arrangement is no longer the old collage.
const { describeOffice } = require('./code-office.js');
// P3-I1: isometric projection kernel (pure). `projection:'iso'` is a preview.
const { fitCamera, project, unproject } = require('./iso-projection.js');
// P3-I2: isometric furniture in world coordinates (pure geometry).
const { describeIsoOffice } = require('./iso-office.js');

// Task E4: the shared catalog declares contentBbox (opaque-art bounds) and
// the draft depth for the flat furniture — the renderer consumes both.
const { layoutAssetById } = require('../layout-assets.js');

const DEFAULT_BACKGROUND = 0xe8eaec;
const COLORS = Object.freeze({
  floor: 0xf2f3f4,
  floorLine: 0xdfe2e5,
  reserveZone: 0xd8dde1,
  zoneOutline: 0xb9c0c6,
  deskWood: 0xb8bec3,
  deskTop: 0xd3d7da,
  deskFront: 0xaeb5ba,
  chair: 0x9da5ab,
  plant: 0x7f9b86,
  shelf: 0xa5adb2,
  shadow: 0x8f989e,
  selection: 0x1677a8,
  badge: 0xd18b16,
  badgeText: 0xffffff,
  markerChat: 0x6b7780,
  markerSleep: 0x5e819b,
});

const STATIC_FALLBACK_TEXT = '虚拟办公室渲染不可用，已切换到静态诊断模式（详情与日志仍可用）';
// M1 (windows-perf audit 2026-09-24): the static presentation is no longer a
// dead end for the recoverable low-frame-rate case — the renderer offers a
// visible retry that runs the SAME bounded rebuild the automatic recovery
// uses. These strings are part of the page-visible contract (the footer/hint
// text tests pin the words 「重试渲染」).
const STATIC_RETRY_LABEL = '重试渲染';
const STATIC_RETRY_HINT = '画面因持续低帧率已降级为静态诊断。点击「重试渲染」重新启用动画渲染（本会话最多 3 次）。';
const STATIC_RETRY_EXHAUSTED_LABEL = '重试次数已用尽';
const STATIC_RETRY_EXHAUSTED_HINT = '本会话的手动重试已用满（3 次）。可重启应用，或在分辨率/缩放较低时重试。';
const STATIC_RETRY_UNSUPPORTED_LABEL = '无法重试渲染';
const STATIC_RETRY_UNSUPPORTED_HINT = '渲染器不可用（WebGL 初始化失败等硬失败），重试不会成功；日志与面板仍可用。';

// M1 render profiles (the degrade ladder's stages). Stage 0 is the historical
// behaviour; stage 1 is the low-cost profile. Read at render time, so a
// downgrade needs no Pixi rebuild and therefore loses no texture or art.
const RENDER_PROFILES = Object.freeze([
  // 2026-09-25：full 档同样跳过"可视签名未变"的重画（同像素零收益）；仍不加频率上限。
  Object.freeze({ id: 'full', maxRenderHz: 0, skipUnchanged: true }),
  Object.freeze({ id: 'low-cost', maxRenderHz: 30, skipUnchanged: true }),
]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function computeVisibleHeight(sceneHeight) {
  return clamp(Math.round(sceneHeight * 0.11 * 100) / 100, 64, 180);
}

async function createOfficeRenderer(options) {
  const {
    PIXI = null,
    layout = null,
    pack = null,
    textures = new Map(),
    officeTextures = new Map(),
    officeTextureErrors = [],
    texturedWorkstations = [],
    scene: initialScene = { width: 1280, height: 840 },
    snapshot: initialSnapshot = null,
    mount = null,
    createFallbackElement = null,
    devicePixelRatio = 1,
    fpsMonitor = null,
    // 2026-09-24: invoked whenever the renderer mode / diagnostic code changes
    // (LOW_FPS_PERSISTENT latch, bounded-recovery rebuild attempts, hard
    // failures), so the page can forward the state to the shell log and the
    // footer degrade dot. View-owner plumbing only — never called from the
    // simulation path.
    onStateChange = null,
    // P3.0 presentation clock. Defaults to the host's requestAnimationFrame and
    // performance.now; tests inject both. `enabled:false` restores the historical
    // "paint on snapshot pushes only" behaviour exactly.
    presentation = null,
    // P3.1 code-drawn scene. `{ enabled:false, theme:'light', accent:'indigo' }`
    // by default: the shipping look is unchanged until the visual direction is
    // approved. Enabled, the floor is drawn from the layout description (tiles,
    // wall/floor edge, reserve zone) instead of a single translucent band.
    codeScene = null,
    // P3-I1 preview: 'flat' (default, shipping) or 'iso' (isometric room shell).
    projection = null,
  } = options || {};

  if (!layout || typeof layout.waypointGraph !== 'function') {
    throw new TypeError('createOfficeRenderer requires a validated office layout');
  }

  let scene = { width: initialScene.width, height: initialScene.height };
  let mode = 'static';
  let diagnosticCode = null;
  let app = null;
  let stage = null;
  let layers = null;
  let staticElement = null;
  let destroyed = false;
  let paused = false;
  let selectionId = null;
  let currentSnapshot = initialSnapshot;
  const entities = new Map(); // employeeId -> entity record (persistent)
  // 2026-09-24 latch fix: the frame pump runs only while this view is the
  // foreground (active main-area) view. Production creates the office as the
  // active view; the first office:visibility push corrects this if the view
  // was opened into the background.
  let foreground = true;
  // 2026-09-25 唤醒自愈：`presenting` =「屏幕正在把本视图呈现给人看」。生产信号：
  // main 进程 powerMonitor（lock-screen/unlock-screen/suspend/resume，经
  // src/office/power-presentation.js）→ window-manager → office:visibility 载荷的
  // `presenting` 字段 → 页面 → setPresenting()。默认 true：从未收到推送的调用方
  // （旧测试/旧页面）保持历史行为。锁屏/息屏/挂起期间 Chromium 把页面节流到
  // ~1.3fps（长稳实测）——那是环境事实，不是渲染缺陷：观察器在此期间停表
  // （泵停 + 看门狗停），恢复预算不消耗，唤醒沿丢弃在途窗口并自动自愈。
  let presenting = true;

  // ---- M1 (windows-perf audit 2026-09-24): low-cost RENDER PROFILE ----------
  // The first LOW_FPS_PERSISTENT latch no longer kills the scene. The office
  // snapshot push runs at ~62.5 Hz and every push redraws the whole scene, so
  // on a slow machine the render work itself is what starves rAF. Stage 0 is
  // the historical render-everything behaviour; stage 1 coalesces redraws to
  // `maxRenderHz` (default 30) and SKIPS redraws whose visual signature did not
  // change (the office is idle most of the time). This drops the render cost
  // without touching the Pixi application, the textures or the art — a rebuild
  // would lose the character/furniture textures (placeholder art), which is
  // exactly the trade-off the user rejected in the 2026-09-24 latch-fix
  // decision record. Only if stage 1 STILL cannot hold thresholdFps does the
  // view fall to the static diagnostic presentation.
  // (RENDER_PROFILES itself is module scope so tests can read the stages.)
  let renderProfileIndex = 0;
  let lastRenderAtMs = null;
  let lastRenderSignature = null;
  // 2026-09-25（性能）：上次真正执行 addChild 的节点序列（节点引用，不是 id）。
  let lastAppliedGroundNodes = null;
  // 2026-09-25：真实执行的 GPU 重绘总次数（renderNow 里 app.render 实际跑过的次数）。
  // 只增不减，diagnostics().paintCount 暴露——"可视变化才重画"契约的可测计数。
  let paintCount = 0;
  let pendingRenderSnapshot = null;
  // Injectable clocks/timers so tests and evidence harnesses stay deterministic
  // (production uses the monitor's clock and the global setTimeout).
  const clockNow = (fpsMonitor && typeof fpsMonitor.now === 'function') ? fpsMonitor.now : () => Date.now();
  const scheduleTimeout = (fpsMonitor && typeof fpsMonitor.setTimeout === 'function')
    ? fpsMonitor.setTimeout
    : (typeof setTimeout === 'function' ? (cb, ms) => setTimeout(cb, ms) : null);
  const cancelTimeout = (fpsMonitor && typeof fpsMonitor.clearTimeout === 'function')
    ? fpsMonitor.clearTimeout
    : (typeof clearTimeout === 'function' ? (id) => clearTimeout(id) : null);
  const stallPollMs = (fpsMonitor && Number(fpsMonitor.stallMs) > 0)
    ? Number(fpsMonitor.stallMs)
    : ((fpsMonitor && Number(fpsMonitor.windowMs) > 0) ? Number(fpsMonitor.windowMs) : 0);
  // M1 static floor: 0 (default) keeps the last ladder stage terminal, exactly
  // like the historical policy. The office page arms 10: a scene that still
  // presents >= 10 fps keeps the living low-cost profile instead of losing the
  // picture (static diagnostics are for "not presenting", not for "slow").
  const staticFloorFps = (fpsMonitor && Number(fpsMonitor.staticFloorFps) > 0)
    ? Number(fpsMonitor.staticFloorFps)
    : 0;
  let stallTimer = null;
  let lowFpsEvents = 0;
  let manualRetryAttempts = 0;
  const MANUAL_RETRY_LIMIT_PER_SESSION = 3;
  // Assigned once the `view` object exists (the static fallback element may be
  // built before it, and its retry button must call back into the view).
  let onStaticRetryRequest = null;

  // ---- P3.0 presentation clock (double buffer + frame pump) -----------------
  // The snapshot push stays the ONLY source of facts. This pump only moves the
  // already-drawn characters along the segment between the last two pushed
  // samples, so an irregular push cadence no longer shows up as a stutter.
  // Disabled automatically when the host has no requestAnimationFrame (Node
  // tests, static presentations), which keeps the historical paint-per-push
  // behaviour byte-for-byte.
  const presentationOptions = presentation || {};
  const hostScheduleFrame = typeof presentationOptions.scheduleFrame === 'function'
    ? presentationOptions.scheduleFrame
    : (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
  const hostCancelFrame = typeof presentationOptions.cancelFrame === 'function'
    ? presentationOptions.cancelFrame
    : (typeof cancelAnimationFrame === 'function' ? (handle) => cancelAnimationFrame(handle) : null);
  const presentationNow = typeof presentationOptions.now === 'function'
    ? presentationOptions.now
    : (typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now());
  const presentationClock = presentationOptions.enabled !== false && typeof hostScheduleFrame === 'function'
    ? createPresentationClock({ maxGapMs: presentationOptions.maxGapMs })
    : null;
  let presentationFrameHandle = null;
  let presentationFrames = 0;

  // P3.1 scene switch (see the option block above). Read at draw time, so a
  // resize reprojects the code scene with the new geometry.
  const codeSceneOptions = {
    enabled: !!(codeScene && codeScene.enabled === true),
    theme: codeScene && typeof codeScene.theme === 'string' ? codeScene.theme : 'light',
    accent: codeScene && typeof codeScene.accent === 'string' ? codeScene.accent : 'indigo',
    tilePx: codeScene && Number.isFinite(codeScene.tilePx) ? codeScene.tilePx : null,
    // Approved P3.1 proportion: characters 1.18x the SPEC-02 default. Only the
    // code scene changes it (the shipping look keeps the frozen band).
    characterScale: codeScene && Number.isFinite(codeScene.characterScale) ? codeScene.characterScale : 1,
    // 2026-10-27 exploration (user: "大胆一些，用代码生成一整套布局"): the
    // generated layout is a preview, NOT the default — the textured scene is
    // still the accepted look. `?officeLayout=generated` opts in.
    generatedFurniture: !!(codeScene && codeScene.generatedFurniture === true),
  };
  let codeSceneStats = null;
  let codeSceneDescription = null;
  let officeDescription = null;
  const projectionMode = projection === 'iso' ? 'iso' : 'flat';
  let isoCamera = null;
  // P3-I2: persistent iso furniture nodes, one Graphics per box so the ground
  // pass can interleave them with the characters by (x + y).
  const isoFurniture = new Map();
  let isoDescription = null;
  let isoShadowNode = null;
  // The furniture art is baked for the light room. In the warm dark theme it is
  // multiplied down to a warm mid-tone so it reads as the same furniture under
  // lamp light instead of glowing white cut-outs.
  let furnitureTint = codeSceneOptions.enabled && codeSceneOptions.theme === 'dark' ? 0x878b8f : null;
  // Monitors carry a light rectangular bezel; in the dark room that reads as a
  // bright wireframe, so they get a deeper tint than desks and chairs.
  function furnitureTintFor(item) {
    if (furnitureTint === null) return null;
    const kind = item && item.kind;
    if (kind === 'monitor') return 0x6f7377;
    if (kind === 'chair') return 0x7a7e82;
    return furnitureTint;
  }

  // ---- P3.3 drag (presentation only) ---------------------------------------
  // Dragging moves the DRAWN character, never the simulated one: no snapshot is
  // written and no office:* message is sent. On release the offset eases back
  // to wherever the simulation already put the character (which may have kept
  // walking during the drag).
  const DRAG_RETURN_MS = 260;
  const dragState = { employeeId: null, baseFoot: null, dx: 0, dy: 0, release: null };

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function clearDrag() {
    dragState.employeeId = null;
    dragState.baseFoot = null;
    dragState.dx = 0;
    dragState.dy = 0;
    dragState.release = null;
  }

  // Where this entity should be DRAWN at `nowMs`: the presentation sample,
  // overridden by the drag offset (or the return easing).
  function displayFootOf(record, sample, nowMs) {
    const target = footScreenOf(sample);
    const targetX = target.x;
    const targetY = target.y;
    if (dragState.employeeId !== record.employeeId) return { x: targetX, y: targetY };
    if (dragState.release) {
      const elapsed = nowMs - dragState.release.at;
      const t = elapsed <= 0 ? 0 : (elapsed >= DRAG_RETURN_MS ? 1 : elapsed / DRAG_RETURN_MS);
      const eased = easeOutCubic(t);
      const from = dragState.release.from;
      return {
        x: from.x + (targetX - from.x) * eased,
        y: from.y + (targetY - from.y) * eased,
      };
    }
    return { x: dragState.baseFoot.x + dragState.dx, y: dragState.baseFoot.y + dragState.dy };
  }

  function stopPresentationFrames() {
    if (presentationFrameHandle !== null && typeof hostCancelFrame === 'function') {
      try { hostCancelFrame(presentationFrameHandle); } catch { /* already gone */ }
    }
    presentationFrameHandle = null;
  }

  // ---------------------------------------------------------------------------

  // ---- init chain: webgl -> canvas -> static -------------------------------

  async function tryInitApplication(preference) {
    const candidate = new PIXI.Application();
    try {
      await candidate.init({
        width: scene.width,
        height: scene.height,
        background: DEFAULT_BACKGROUND,
        backgroundAlpha: 1,
        antialias: true,
        preference,
        preserveDrawingBuffer: true,
        resolution: clamp(Number(devicePixelRatio) || 1, 1, 3),
        autoDensity: true,
      });
      return { ok: true, app: candidate };
    } catch (error) {
      return { ok: false, app: candidate, error };
    }
  }

  function discardFailedApplication(candidate) {
    try { if (candidate) candidate.destroy(true, { children: true, texture: false }); } catch { /* not initialized */ }
  }

  // M1: the static presentation gets a VISIBLE, clickable way back for the one
  // case that can actually recover (LOW_FPS_PERSISTENT). Built only when the
  // renderer itself owns a real DOM element (production: office.html does not
  // pass createFallbackElement) — a caller-supplied stub element is left
  // untouched, exactly as before.
  let staticRetryButton = null;
  function attachStaticRetry(el) {
    if (!el || typeof el.appendChild !== 'function') return;
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.createElement !== 'function') return;
    if (typeof el.querySelector === 'function' && el.querySelector('.office-static-retry')) return;
    const row = doc.createElement('div');
    row.className = 'office-static-retry';
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'office-static-retry-btn';
    button.textContent = STATIC_RETRY_LABEL;
    button.addEventListener('click', () => {
      if (typeof onStaticRetryRequest === 'function') onStaticRetryRequest();
    });
    const hint = doc.createElement('p');
    hint.className = 'office-static-retry-hint';
    hint.textContent = STATIC_RETRY_HINT;
    row.appendChild(button);
    row.appendChild(hint);
    el.appendChild(row);
    staticRetryButton = button;
    refreshStaticRetry();
  }

  // Keeps the retry affordance honest: hidden-by-disabled for a hard failure
  // (WEBGL_INIT_FAILED / RENDERER_UNAVAILABLE — a rebuild would fail the same
  // way) and after the per-session manual budget is spent.
  function refreshStaticRetry() {
    if (!staticRetryButton) return;
    const recoverable = diagnosticCode === 'LOW_FPS_PERSISTENT';
    const left = MANUAL_RETRY_LIMIT_PER_SESSION - manualRetryAttempts;
    const usable = recoverable && left > 0;
    if ('disabled' in staticRetryButton) staticRetryButton.disabled = !usable;
    staticRetryButton.textContent = usable ? STATIC_RETRY_LABEL
      : (recoverable ? STATIC_RETRY_EXHAUSTED_LABEL : STATIC_RETRY_UNSUPPORTED_LABEL);
    try {
      staticRetryButton.title = usable ? STATIC_RETRY_HINT
        : (recoverable ? STATIC_RETRY_EXHAUSTED_HINT : STATIC_RETRY_UNSUPPORTED_HINT);
    } catch { /* non-DOM stub */ }
  }

  function buildStaticFallback() {
    if (typeof createFallbackElement === 'function') {
      staticElement = createFallbackElement();
    } else if (mount && typeof document !== 'undefined') {
      staticElement = document.createElement('div');
    }
    if (staticElement) {
      staticElement.className = 'office-static-fallback';
      if (staticElement.dataset) staticElement.dataset.diagnosticCode = diagnosticCode;
      staticElement.textContent = STATIC_FALLBACK_TEXT;
      if (typeof staticElement.setAttribute === 'function') staticElement.setAttribute('role', 'status');
      if (mount && staticElement.tagName === 'DIV' && mount.appendChild) mount.appendChild(staticElement);
      attachStaticRetry(staticElement);
    }
  }

  function buildLayers() {
    // 新容器 = 旧节点都不在册：顺序账本必须失效（否则重建后跳过重排 → 新画布空着）
    lastAppliedGroundNodes = null;
    stage = app.stage;
    const layerIds = layout.layers();
    layers = {};
    for (const layerId of layerIds) {
      const container = new PIXI.Container();
      container.__layerId = layerId;
      layers[layerId] = container;
      stage.addChild(container);
    }
    // camelCase aliases for page code readability (same containers)
    const alias = {
      background: 'background',
      backFurniture: 'back-furniture',
      groundEntities: 'ground-entities',
      frontOccluders: 'front-occluders',
      effectsLabels: 'effects-labels',
    };
    for (const [key, kebab] of Object.entries(alias)) {
      if (layers[kebab]) layers[key] = layers[kebab];
    }
  }

  // ---- furniture (Task 3: managed textures + reversible placeholders) ------
  //
  // Canonical workstations declare their furniture as fixture items with a
  // managed layout-assets assetId. Calibrated workstations (texturedWorksta
  // tions — golden scope is desk-1 only until visual approval) render their
  // parts as textured sprites fitted to the fixture part rect; everything
  // else keeps the deterministic Graphics placeholder path. Furniture nodes
  // are built ONCE per view and only re-project on resize, so sprite
  // identity is stable for the whole view lifetime. Paint roles are explicit:
  // 'main' desk body under 'back' monitor/chair, both behind ground
  // entities; 'front' occluders live on the front-occluders layer above.
  // Each view owns its officeTextures map — destroying this view releases
  // exactly these textures and never touches another view's resources.

  const officeTextureMap = officeTextures instanceof Map ? officeTextures : new Map();
  const loaderErrors = Array.isArray(officeTextureErrors) ? officeTextureErrors : [];
  const calibratedDesks = Array.isArray(texturedWorkstations) ? texturedWorkstations : [];
  const furnitureRecords = new Map(); // furnitureId -> record (persistent nodes)
  const officeTextureMissing = [];

  function furnitureRole(item) {
    if (item.layer === 'front-occluders') return 'front';
    if (item.kind === 'desk-back') return 'main';
    return 'back';
  }

  // The managed assetId for a furniture item whose sprite should come from
  // the shared officeTextures map. Workstation parts keep the golden
  // calibration gate (uncalibrated desks stay reversible placeholders); flat
  // items (props and flat furniture) always resolve from the catalog.
  function wantedAssetFor(item) {
    if (!item.assetId || !layoutAssetById(item.assetId)) return null;
    const match = /^(desk-[1-6])-/.exec(item.id || '');
    if (match) return calibratedDesks.includes(match[1]) ? item.assetId : null;
    return item.assetId;
  }

  // 2026-10-29：drawFurnitureGraphics（旧贴图路径的占位图形绘制）已随旧路径移除。

  function buildFurniture({ recordMissing = true } = {}) {
    const floor = new PIXI.Graphics();
    floor.__furnitureId = 'floor-band';
    layers.background.addChild(floor);
    furnitureRecords.set('floor-band', { item: { id: 'floor-band', layer: 'background' }, node: floor, kind: 'floor' });

    // Explicit role order inside back-furniture: desk bodies (main) first,
    // then monitors/chairs (back). Within a role, flat items order by the
    // draft depth (layer 升序) with the fixture array order as tie-break;
    // the isometric fixture has no depth and keeps its array order. Fixture
    // order breaks ties within a role.
    // 2026-10-29（用户拍板）：旧贴图家具绘制路径已整体移除，办公室只保留
    // 代码化 2.5D 一版。这里不再遍历 layout.furniture() 生成 sprite/graphics
    // 节点 —— 全部家具由 buildOfficeDescription() + drawOfficeGroupNode() 用
    // PIXI.Graphics 现场绘制，并在 sortOfficeGround() 里做一次画家算法排序。
    // floor 与 shadows/edges 两个容器仍然保留：它们是新旧共用的承载节点。
    // P3.4: grounding + material overlays. They live under/over the furniture
    // sprites but only exist in the code scene, so the shipping look never
    // gains extra nodes.
    if (codeSceneOptions.enabled) {
      const shadows = new PIXI.Graphics();
      shadows.__furnitureId = 'furniture-shadows';
      layers.background.addChild(shadows);
      furnitureRecords.set('furniture-shadows', {
        item: { id: 'furniture-shadows', layer: 'background' }, node: shadows, kind: 'shadows',
      });
      const edges = new PIXI.Graphics();
      edges.__furnitureId = 'furniture-edges';
      layers['back-furniture'].addChild(edges);
      furnitureRecords.set('furniture-edges', {
        item: { id: 'furniture-edges', layer: 'back-furniture' }, node: edges, kind: 'edges',
      });
      // 2.5D coded office: the legacy furniture art is hidden; every desk,
      // chair, prop and decoration is drawn from code in one painter pass.
      // `kind: 'code'` records must be hidden too: they are the legacy fixture
      // monitors redrawn as bezel+screen+stand, and leaving them visible put a
      // second, offset monitor behind the generated one (the stray dark hook
      // left of the screen, 2026-10-28).
      if (codeSceneOptions.generatedFurniture) {
        for (const record of furnitureRecords.values()) {
          if ((record.kind === 'sprite' || record.kind === 'graphics' || record.kind === 'code') && record.node) {
            record.node.visible = false;
          }
        }
      }
      if (projectionMode === 'iso') {
        for (const record of furnitureRecords.values()) {
          if (record.kind !== 'floor' && record.node) record.node.visible = false;
        }
      }
    }
    layoutFurniture();
    // Establish the geometric pass at BUILD time so occlusion never depends on
    // when the first snapshot push arrives.
    sortGround();
  }

  // P3.1: environment only. Furniture keeps its existing art path — replacing
  // the calibrated desk/kitchen sprites with flat code shapes was tried on
  // 2026-10-27 and read as a regression (giant material blobs), so the
  // "colour blocks + material detail" language is applied to the room
  // (floor/wall/window/reception), where the art had no detail to lose.
  function drawCodeScene(node) {
    const generated = codeSceneOptions.generatedFurniture;
    const dark = codeSceneOptions.theme === 'dark';
    const description = describeCodeScene({
      scene,
      layout,
      theme: codeSceneOptions.theme,
      accent: codeSceneOptions.accent,
      // The coded office wants a calmer floor: larger, lower-contrast tiles so
      // the furniture (not the grid) is the subject. P3 pushed the checker all
      // the way down to 0.10 — grout lines now carry the tile module, so the
      // alternation only has to break up the flat fill.
      tilePx: codeSceneOptions.tilePx || (generated ? Math.round(scene.height * 0.115) : null),
      checkerContrast: generated ? 0.10 : 1,
      // Generated mode moves the window into the wall gap between the kitchen
      // and the left desk column: tall props no longer climb in front of the
      // glass, and the light pool lands on open floor.
      //
      // 2026-10-28 第三轮：窗宽 0.20 → 0.13 并右移至 0.305，把墙面让给茶水间
      // （用户拍板"减小窗户大小来增大茶水间"）。窗右缘 0.435 < 桌子左缘 0.451，
      // 仍然不会和显示器打架。
      windowX: generated ? 0.305 : undefined,
      windowW: generated ? 0.13 : undefined,
      characterScale: codeSceneOptions.characterScale,
    });
    codeSceneDescription = description;
    codeSceneStats = { ...description.stats, theme: description.theme, accent: description.accent, tilePx: description.tilePx };
    const c = description.colors;
    // Wall band: three horizontal steps read as wall / mid / floor-edge light.
    node.rect(0, 0, scene.width, scene.height).fill({ color: c.wall });
    node.rect(description.floor.x, description.floor.y, description.floor.w, description.floor.h)
      .fill({ color: c.floorB });
    // P3: floor as LARGE TILES with 1px grout, not a checkerboard. The old
    // checker (tilePx≈0.09H, contrast 0.35) painted 136 alternating squares
    // across the whole room; at that size the alternation reads as blotches,
    // especially in the dark theme where it looked like stains. Grout lines do
    // the describing instead: they state the tile module without adding
    // contrast, and the checker is now barely-there (0.10).
    for (const tile of description.floor.tiles) {
      node.rect(tile.x, tile.y, tile.w, tile.h).fill({ color: tile.fill });
    }
    const grout = dark ? 0x1f2124 : description.colors.grout;
    for (const tile of description.floor.tiles) {
      node.rect(tile.x, tile.y, tile.w, 1).fill({ color: grout, alpha: dark ? 0.55 : 0.75 });
      node.rect(tile.x, tile.y, 1, tile.h).fill({ color: grout, alpha: dark ? 0.45 : 0.65 });
    }
    // Distance falloff: the floor gets darker away from the window wall.
    for (const band of description.floor.shadeBands) {
      node.rect(0, band.y, scene.width, band.h).fill({ color: band.color, alpha: band.alpha });
    }
    for (const band of description.walls.bands) {
      node.rect(0, band.y, description.walls.w, band.h).fill({ color: band.color });
    }
    // P3: skirting board where the wall meets the floor — 4–6px dark band with
    // a 1px lit top edge. Without it the wall and floor meet in a colour seam
    // and the room loses its base.
    const base = description.walls.base;
    node.rect(base.x, base.y, base.w, base.h).fill({ color: base.color });
    const skirtH = Math.max(3, Math.round(scene.height * 0.010));
    node.rect(0, description.floor.y - skirtH, scene.width, skirtH)
      .fill({ color: mixHex(base.color, 0x000000, 0.18) });
    node.rect(0, description.floor.y - skirtH, scene.width, 1)
      .fill({ color: 0xffffff, alpha: dark ? 0.05 : 0.22 });
    // Window: frame, glass, mullions, then a warm pool of light on the floor.
    const win = description.walls.window;
    // P3 (2026-10-28): the wall needs architecture, not three colour bands.
    // Order: frame shadow → sill → glass → reflection → frame → mullions.
    // Sill first (it sits against the wall, behind the glass plane).
    const sillH = Math.max(3, Math.round(win.h * 0.055));
    node.rect(win.x - 8, win.y + win.h + 2, win.w + 16, sillH)
      .fill({ color: mixHex(win.frame, 0xffffff, dark ? 0.06 : 0.16) });
    node.rect(win.x - 8, win.y + win.h + 2, win.w + 16, 1)
      .fill({ color: 0xffffff, alpha: dark ? 0.08 : 0.40 });
    node.rect(win.x - 8, win.y + win.h + 2 + sillH, win.w + 16, 2)
      .fill({ color: 0x000000, alpha: dark ? 0.34 : 0.14 });
    // Reveal shadow around the opening: the wall is thicker than the glass.
    node.rect(win.x - 3, win.y - 3, win.w + 6, win.h + 6).fill({ color: win.frame });
    node.rect(win.x - 3, win.y - 3, win.w + 6, 2).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.12 });
    node.rect(win.x - 3, win.y - 3, 2, win.h + 6).fill({ color: 0x000000, alpha: dark ? 0.26 : 0.10 });
    node.rect(win.x, win.y, win.w, win.h).fill({ color: win.glass });
    // Glass reflection: two diagonal bands (low alpha; a single hard band read
    // as a sticker). Drawn on the glass so the window looks like a surface.
    for (let i = 0; i < 2; i += 1) {
      const bandW = win.w * (i === 0 ? 0.20 : 0.11);
      const startX = win.x + win.w * (i === 0 ? 0.12 : 0.52);
      node.moveTo(startX, win.y + win.h)
        .lineTo(startX + bandW, win.y + win.h)
        .lineTo(startX + bandW + win.w * 0.24, win.y)
        .lineTo(startX + win.w * 0.24, win.y)
        .closePath()
        .fill({ color: 0xffffff, alpha: dark ? 0.035 : (i === 0 ? 0.16 : 0.10) });
    }
    // Outdoor hint: a soft lighter band at the top = sky, so the glass is not a
    // flat fill. Two nested bands give falloff without a gradient.
    node.rect(win.x, win.y, win.w, Math.round(win.h * 0.42))
      .fill({ color: 0xffffff, alpha: dark ? 0.03 : 0.16 });
    node.rect(win.x, win.y, win.w, Math.round(win.h * 0.20))
      .fill({ color: 0xffffff, alpha: dark ? 0.04 : 0.14 });
    for (const bar of win.mullions) node.rect(bar.x, bar.y, bar.w, bar.h).fill({ color: win.frame });
    // Mullion shading: a 1px dark line to the right of each bar.
    for (const bar of win.mullions) {
      node.rect(bar.x + bar.w, bar.y, 1, bar.h).fill({ color: 0x000000, alpha: dark ? 0.22 : 0.08 });
    }
    // Transom rail near the top: a third horizontal division.
    const transomY = win.y + Math.round(win.h * 0.18);
    node.rect(win.x, transomY, win.w, 2).fill({ color: win.frame });
    node.rect(win.x, transomY + 2, win.w, 1).fill({ color: 0x000000, alpha: dark ? 0.20 : 0.08 });
    // Ellipses, not rectangles: three overlapping soft pools read as light
    // spill; a rectangular band reads as a yellow placemat.
    for (const band of win.glow.bands) {
      node.ellipse(band.x + band.w / 2, band.y + band.h / 2, band.w / 2, band.h / 2)
        .fill({ color: win.glow.color, alpha: band.alpha });
    }
    // P3: wall decoration — a clock and a whiteboard on OPEN wall.
    //
    // 用户（2026-10-28 第二轮）："钟表的位置，把它放到两列办公桌的中上位置的墙上，
    // 现在这个位置和办公桌挤到一起了。"
    //
    // The clock now lives in the CORRIDOR BETWEEN the two desk columns and high
    // on the wall. Derived from the real layout rather than hard-coded: the left
    // column ends at world x ≈0.637 and the right column starts at ≈0.711, so the
    // gap centre is ≈0.674 (the clock is the only thing there, nothing overlaps).
    // `clockX` may be overridden by the page for other layouts.
    const clockR = Math.max(7, Math.round(scene.height * 0.020));
    const clockX = Math.round(scene.width * 0.674);
    // "中上位置" = upper part of the wall band, not floating at the ceiling.
    const clockY = Math.round(description.walls.h * 0.38);
    node.circle(clockX, clockY, clockR + 2).fill({ color: 0x000000, alpha: dark ? 0.35 : 0.10 });
    node.circle(clockX, clockY, clockR + 1).fill({ color: mixHex(win.frame, 0x000000, 0.22) });
    node.circle(clockX, clockY, clockR).fill({ color: dark ? 0xd7dade : 0xfbfaf7 });
    node.circle(clockX, clockY, clockR).stroke({ width: 1, color: 0x000000, alpha: 0.22 });
    // 12 tick marks; 4 are longer (the quarters).
    for (let i = 0; i < 12; i += 1) {
      const a = (Math.PI * 2 * i) / 12 - Math.PI / 2;
      const inner = clockR * (i % 3 === 0 ? 0.62 : 0.78);
      node.moveTo(clockX + Math.cos(a) * inner, clockY + Math.sin(a) * inner)
        .lineTo(clockX + Math.cos(a) * clockR * 0.90, clockY + Math.sin(a) * clockR * 0.90)
        .stroke({ width: 1, color: 0x2b3038, alpha: dark ? 0.55 : 0.62 });
    }
    // Hands at a fixed 10:10 — deterministic, and the classic clock pose.
    const hourA = -Math.PI / 2 + (10 + 10 / 60) * (Math.PI * 2) / 12;
    const minA = -Math.PI / 2 + 10 * (Math.PI * 2) / 60;
    node.moveTo(clockX, clockY)
      .lineTo(clockX + Math.cos(hourA) * clockR * 0.52, clockY + Math.sin(hourA) * clockR * 0.52)
      .stroke({ width: 2, color: 0x23272e, alpha: 0.85 });
    node.moveTo(clockX, clockY)
      .lineTo(clockX + Math.cos(minA) * clockR * 0.78, clockY + Math.sin(minA) * clockR * 0.78)
      .stroke({ width: 1, color: 0x23272e, alpha: 0.85 });
    node.circle(clockX, clockY, Math.max(1.2, clockR * 0.08)).fill({ color: 0x23272e });
    // Whiteboard: light panel, frame, two marker strokes, a tray and a marker.
    // Sits on the wall right of the last desk column (x > 0.81), where nothing
    // is drawn in front of it.
    const wbW = Math.round(scene.width * 0.145);
    const wbH = Math.round(description.walls.h * 0.30);
    const wbX = Math.round(scene.width * 0.835);
    const wbY = Math.round(description.walls.h * 0.24);
    node.rect(wbX - 2, wbY - 2, wbW + 4, wbH + 4).fill({ color: mixHex(win.frame, 0x000000, 0.10) });
    node.rect(wbX, wbY, wbW, wbH).fill({ color: dark ? 0x8d949a : 0xfcfdfd });
    node.rect(wbX, wbY, wbW, 1).fill({ color: 0xffffff, alpha: dark ? 0.06 : 0.5 });
    node.rect(wbX, wbY + wbH - 1, wbW, 1).fill({ color: 0x000000, alpha: 0.16 });
    // Two deterministic marker strokes (the accent colour, low alpha).
    const stroke = mixHex(c.accent, dark ? 0x000000 : 0xffffff, dark ? 0.35 : 0.25);
    node.moveTo(wbX + wbW * 0.10, wbY + wbH * 0.30)
      .lineTo(wbX + wbW * 0.44, wbY + wbH * 0.30)
      .lineTo(wbX + wbW * 0.58, wbY + wbH * 0.52)
      .stroke({ width: 2, color: stroke, alpha: dark ? 0.55 : 0.42 });
    node.moveTo(wbX + wbW * 0.10, wbY + wbH * 0.68)
      .lineTo(wbX + wbW * 0.34, wbY + wbH * 0.68)
      .stroke({ width: 2, color: stroke, alpha: dark ? 0.40 : 0.30 });
    // Marker tray + a marker lying on it.
    node.rect(wbX, wbY + wbH, wbW, Math.max(2, Math.round(wbH * 0.10)))
      .fill({ color: mixHex(win.frame, 0x000000, 0.16) });
    node.rect(wbX + wbW * 0.30, wbY + wbH + 1, Math.max(4, wbW * 0.16), 2)
      .fill({ color: stroke, alpha: 0.75 });
    node.rect(wbX, wbY + wbH, wbW, 1).fill({ color: 0xffffff, alpha: dark ? 0.05 : 0.28 });


    // Reception (user decision): a low counter + a faint floor colour split.
    // The tint stays light so the zone never reads as a blank patch.
    for (const zone of description.zones) {
      node.rect(zone.x, zone.y, zone.w, zone.h).fill({ color: zone.fill, alpha: 0.55 });
      node.rect(zone.x, zone.y, zone.w, 2).fill({ color: zone.accent, alpha: 0.35 });
    }

    // Reception kept but weakened: one low counter along the reserve zone's
    // near edge, with a top face and a front edge — no tall wall.
    const reception = description.reception;
    if (reception) {
      node.rect(reception.x, reception.y, reception.w, reception.h).fill({ color: reception.side });
      node.rect(reception.x, reception.y, reception.w, Math.max(2, Math.round(reception.h * 0.45)))
        .fill({ color: reception.top });
      node.rect(reception.x, reception.y + reception.h - 2, reception.w, 2).fill({ color: reception.edge });
      node.rect(reception.x, reception.y, 3, reception.h).fill({ color: reception.accent, alpha: 0.35 });
    }

    node.rect(description.edge.x, description.edge.y, description.edge.w, description.edge.h)
      .fill({ color: description.edge.color });
  }

  // P3.4: code-drawn monitor (bezel + screen + stand). It replaces only the
  // monitor art in the code scene; the rect comes from the fixture.
  // 2026-10-29：drawCodeMonitor（旧路径的 monitor 重绘）已随旧路径移除。


  function buildOfficeDescription() {
    const workstations = typeof layout.workstations === 'function' ? layout.workstations() : null;
    const instances = workstations && Array.isArray(workstations.instances) ? workstations.instances : [];
    const seats = instances.map((instance) => {
      const position = instance && instance.seat && instance.seat.position;
      if (!position) return null;
      return { id: instance.deskId || (instance.seat && instance.seat.id) || 'desk', x: position.x, y: position.y };
    }).filter(Boolean);
    return describeOffice({
      scene,
      seats,
      reserve: typeof layout.reserveZone === 'function' ? layout.reserveZone() : null,
    });
  }

  function sceneColors() {
    if (codeSceneDescription && codeSceneDescription.colors) return codeSceneDescription.colors;
    const description = describeCodeScene({
      scene,
      layout,
      theme: codeSceneOptions.theme,
      accent: codeSceneOptions.accent,
      tilePx: codeSceneOptions.tilePx,
      characterScale: codeSceneOptions.characterScale,
    });
    codeSceneDescription = description;
    return description.colors;
  }

  // ---- P3-I1: isometric preview ------------------------------------------
  function rebuildIsoCamera() {
    isoCamera = fitCamera({
      width: scene.width,
      height: scene.height,
      worldWidth: 1,
      worldDepth: 1,
      maxHeight: 0.34,
      margin: 20,
    });
    return isoCamera;
  }

  // Screen position of a world point (normalized office coordinates).
  function footScreenOf(position) {
    if (!position) return { x: 0, y: 0 };
    if (projectionMode !== 'iso') {
      return { x: position.x * scene.width, y: position.y * scene.height };
    }
    if (!isoCamera) rebuildIsoCamera();
    return project(isoCamera, { x: position.x, y: position.y, z: 0 });
  }

  function isoPoint(x, y, z) {
    return project(isoCamera || rebuildIsoCamera(), { x, y, z });
  }

  function fillIsoPolygon(node, points, fill, stroke, width, alpha, strokeAlpha) {
    const projected = points.map((point) => isoPoint(point.x, point.y, point.z || 0));
    if (projected.length < 3) return;
    node.moveTo(projected[0].x, projected[0].y);
    for (let i = 1; i < projected.length; i += 1) node.lineTo(projected[i].x, projected[i].y);
    node.lineTo(projected[0].x, projected[0].y);
    if (fill !== undefined && fill !== null) node.fill({ color: fill, alpha: alpha === undefined ? 1 : alpha });
    if (stroke !== undefined && stroke !== null) {
      node.stroke({ width: width || 1, color: stroke, alpha: strokeAlpha === undefined ? 1 : strokeAlpha });
    }
  }

  // The I1 room shell: diamond floor, two walls, window, baseboard, light pool.
  function drawIsoRoom(node) {
    const c = sceneColors();
    if (!isoCamera) rebuildIsoCamera();
    const H = 0.34;
    // Floor diamond.
    fillIsoPolygon(node, [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ], c.floorB);
    // Tile grid (two families of lines).
    const step = 0.1;
    for (let i = 1; i < 10; i += 1) {
      const t = i * step;
      fillIsoPolygon(node, [{ x: t, y: 0 }, { x: t, y: 1 }], null, c.grout, 1);
      fillIsoPolygon(node, [{ x: 0, y: t }, { x: 1, y: t }], null, c.grout, 1);
    }
    // Back wall (y = 0) and left wall (x = 0).
    fillIsoPolygon(node, [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 1, y: 0, z: H }, { x: 0, y: 0, z: H },
    ], c.wallTop, c.edge, 1);
    fillIsoPolygon(node, [
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      { x: 0, y: 1, z: H }, { x: 0, y: 0, z: H },
    ], c.wall, c.edge, 1);
    // Baseboards.
    fillIsoPolygon(node, [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 1, y: 0, z: 0.02 }, { x: 0, y: 0, z: 0.02 },
    ], c.base);
    fillIsoPolygon(node, [
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
      { x: 0, y: 1, z: 0.02 }, { x: 0, y: 0, z: 0.02 },
    ], c.base);

    // Window on the back wall (x 0.34..0.72, z 0.12..0.28).
    const wx0 = 0.34;
    const wx1 = 0.72;
    const wz0 = 0.12;
    const wz1 = 0.28;
    fillIsoPolygon(node, [
      { x: wx0, y: 0, z: wz0 }, { x: wx1, y: 0, z: wz0 },
      { x: wx1, y: 0, z: wz1 }, { x: wx0, y: 0, z: wz1 },
    ], c.windowGlass, c.windowFrame, 1);
    const wm = (wx0 + wx1) / 2;
    fillIsoPolygon(node, [{ x: wm, y: 0, z: wz0 }, { x: wm, y: 0, z: wz1 }], null, c.windowFrame, 1);
    // Light pool spilling from the window onto the floor. Flat fills cannot
    // gradient, so the pool is a few nested bands fading with distance — the
    // cheap stand-in for a soft falloff that still reads as window light.
    const bands = 5;
    const reach = 0.30;
    const dark = codeSceneOptions.theme === 'dark';
    for (let i = bands; i >= 1; i -= 1) {
      const t = i / bands;
      const depth = reach * t;
      const inset = 0.02 * t;
      fillIsoPolygon(node, [
        { x: wx0 + inset, y: 0, z: 0 }, { x: wx1 - inset, y: 0, z: 0 },
        { x: wx1 - inset - 0.03 * t, y: depth, z: 0 }, { x: wx0 + inset + 0.03 * t, y: depth, z: 0 },
      ], c.windowGlow, null, 1, (dark ? 0.055 : 0.075) * (1 - t * 0.6));
    }
  }

  // ---- P3-I2: isometric furniture -----------------------------------------
  // Face palette per material: top / front (y = y1) / side (x = x1). The
  // camera looks from +x +y, so those are the two visible box faces.
  function isoPalette() {
    const c = sceneColors();
    const accent = ACCENTS[codeSceneOptions.accent] || ACCENTS.indigo;
    return {
      accent,
      tones: {
        desk: { top: c.deskTop, front: c.deskFront, side: c.deskSide, edge: c.deskEdge },
        deskSide: { top: c.deskSide, front: c.deskSide, side: c.deskEdge, edge: c.deskEdge },
        monitor: { top: c.monitorBody, front: c.monitorScreen, side: c.monitorEdge, edge: c.monitorEdge },
        monitorEdge: { top: c.monitorEdge, front: c.monitorEdge, side: c.monitorEdge, edge: c.monitorEdge },
        chairSeat: { top: c.chairSeat, front: c.chairBack, side: c.chairBack, edge: c.deskEdge },
        chairBack: { top: c.chairBack, front: c.chairBack, side: c.chairSeat, edge: c.deskEdge },
        accent: { top: accent, front: accent, side: accent, edge: accent },
        rug: { top: c.rug, front: c.rug, side: c.rug, edge: c.edge },
        sofaFront: { top: c.sofa, front: c.sofaFront, side: c.sofa, edge: c.edge },
        sofaSeat: { top: c.sofaSeat, front: c.sofaSeat, side: c.sofaFront, edge: c.edge },
        sofa: { top: c.sofa, front: c.sofaFront, side: c.sofaFront, edge: c.edge },
        counter: { top: c.counterTop, front: c.counterFront, side: c.counterSide, edge: c.edge },
        counterSide: { top: c.counterSide, front: c.counterSide, side: c.counterSide, edge: c.edge },
        plantPot: { top: c.plantPot, front: c.plantPot, side: c.plantPot, edge: c.edge },
        plantLeaf: { top: c.plantLeaf, front: c.plantLeaf, side: c.plantLeaf, edge: c.edge },
      },
    };
  }

  function isoQuad(node, points, fill, alpha) {
    fillIsoPolygon(node, points, fill, null, 1, alpha);
  }

  // One box: the two camera-facing walls plus the top, in painter order.
  function drawIsoBox(node, part) {
    if (!part) return;
    const palette = isoPalette();
    const tone = palette.tones[part.tone] || palette.tones.desk;
    const { x0, y0, x1, y1, z0, z1 } = part;
    // x = x1 (front-right) and y = y1 (front-left) are the visible walls.
    isoQuad(node, [
      { x: x1, y: y1, z: z0 }, { x: x1, y: y0, z: z0 },
      { x: x1, y: y0, z: z1 }, { x: x1, y: y1, z: z1 },
    ], tone.side);
    isoQuad(node, [
      { x: x0, y: y1, z: z0 }, { x: x1, y: y1, z: z0 },
      { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 },
    ], tone.front);
    isoQuad(node, [
      { x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 },
    ], tone.top);
    // A hairline seam on the top face: without it low-contrast materials
    // (desk on floor, sofa on rug) merge into one silhouette.
    fillIsoPolygon(node, [
      { x: x0, y: y0, z: z1 }, { x: x1, y: y0, z: z1 },
      { x: x1, y: y1, z: z1 }, { x: x0, y: y1, z: z1 },
    ], null, tone.edge, 1, 1, codeSceneOptions.theme === 'dark' ? 0.28 : 0.4);
    drawIsoDetail(node, part, tone, palette);
  }

  // Surface details are drawn AFTER the box faces inside the same Graphics,
  // offset a hair along the normal so they cannot z-fight with the face.
  function drawIsoDetail(node, part, tone, palette) {
    const { x0, y0, x1, y1, z0, z1 } = part;
    const edge = tone.edge;
    const lift = 0.0006;
    if (part.detail === 'screen') {
      const ix = (x1 - x0) * 0.08;
      const iz = (z1 - z0) * 0.12;
      isoQuad(node, [
        { x: x0 + ix, y: y1 + lift, z: z0 + iz }, { x: x1 - ix, y: y1 + lift, z: z0 + iz },
        { x: x1 - ix, y: y1 + lift, z: z1 - iz }, { x: x0 + ix, y: y1 + lift, z: z1 - iz },
      ], palette.tones.monitor.front);
      isoQuad(node, [
        { x: x0 + ix, y: y1 + lift * 2, z: z0 + iz }, { x: x1 - ix, y: y1 + lift * 2, z: z0 + iz },
        { x: x1 - ix, y: y1 + lift * 2, z: z1 - iz }, { x: x0 + ix, y: y1 + lift * 2, z: z1 - iz },
      ], edge, 0.18);
    } else if (part.detail === 'keys') {
      for (let i = 1; i <= 3; i += 1) {
        const t = y0 + ((y1 - y0) * i) / 4;
        isoQuad(node, [
          { x: x0 + 0.004, y: t, z: z1 + lift }, { x: x1 - 0.004, y: t, z: z1 + lift },
          { x: x1 - 0.004, y: t + 0.0015, z: z1 + lift }, { x: x0 + 0.004, y: t + 0.0015, z: z1 + lift },
        ], edge, 0.35);
      }
    } else if (part.detail === 'drawer') {
      for (const t of [0.35, 0.68]) {
        const z = z0 + (z1 - z0) * t;
        isoQuad(node, [
          { x: x0 + 0.004, y: y1 + lift, z }, { x: x1 - 0.004, y: y1 + lift, z },
          { x: x1 - 0.004, y: y1 + lift, z: z + 0.0012 }, { x: x0 + 0.004, y: y1 + lift, z: z + 0.0012 },
        ], edge, 0.5);
      }
    } else if (part.detail === 'sink') {
      isoQuad(node, [
        { x: x0 + 0.006, y: y0 + (y1 - y0) * 0.18, z: z1 + lift },
        { x: x1 - 0.006, y: y0 + (y1 - y0) * 0.18, z: z1 + lift },
        { x: x1 - 0.006, y: y0 + (y1 - y0) * 0.52, z: z1 + lift },
        { x: x0 + 0.006, y: y0 + (y1 - y0) * 0.52, z: z1 + lift },
      ], palette.tones.counterSide.top);
    } else if (part.detail === 'machine') {
      isoQuad(node, [
        { x: x0 + 0.006, y: y1 + lift, z: z0 + 0.008 },
        { x: x1 - 0.006, y: y1 + lift, z: z0 + 0.008 },
        { x: x1 - 0.006, y: y1 + lift, z: z0 + 0.030 },
        { x: x0 + 0.006, y: y1 + lift, z: z0 + 0.030 },
      ], edge, 0.55);
    } else if (part.detail === 'counter' || part.detail === 'table') {
      isoQuad(node, [
        { x: x0, y: y1 + lift, z: z1 - 0.001 }, { x: x1, y: y1 + lift, z: z1 - 0.001 },
        { x: x1, y: y1 + lift, z: z1 }, { x: x0, y: y1 + lift, z: z1 },
      ], edge, 0.45);
    } else if (part.detail === 'mug') {
      const inset = 0.002;
      isoQuad(node, [
        { x: x0 + inset, y: y0 + inset, z: z1 + lift }, { x: x1 - inset, y: y0 + inset, z: z1 + lift },
        { x: x1 - inset, y: y1 - inset, z: z1 + lift }, { x: x0 + inset, y: y1 - inset, z: z1 + lift },
      ], palette.accent);
    } else if (part.detail === 'panel') {
      isoQuad(node, [
        { x: x0 + 0.004, y: y1 + lift, z: z0 + 0.004 }, { x: x1 - 0.004, y: y1 + lift, z: z0 + 0.004 },
        { x: x1 - 0.004, y: y1 + lift, z: z0 + 0.006 }, { x: x0 + 0.004, y: y1 + lift, z: z0 + 0.006 },
      ], edge, 0.5);
    } else if (part.detail === 'sofa-base') {
      const mid = (x0 + x1) / 2;
      isoQuad(node, [
        { x: mid, y: y0 + 0.006, z: z1 + lift }, { x: mid + 0.0015, y: y0 + 0.006, z: z1 + lift },
        { x: mid + 0.0015, y: y1 - 0.006, z: z1 + lift }, { x: mid, y: y1 - 0.006, z: z1 + lift },
      ], edge, 0.35);
    }
  }

  // Contact shadows for the iso furniture: one Graphics on the background
  // layer, under every box. Only footprint-defining parts cast one — legs,
  // panels, drawers and props sit inside their parent's footprint and would
  // double-darken the same patch. The offset is toward +y (the window is on
  // the back wall), so shadows read as cast away from the light.
  const ISO_SHADOW_CAST = 0.012;
  function drawIsoShadows(description) {
    if (!isoShadowNode) {
      isoShadowNode = new PIXI.Graphics();
      isoShadowNode.__isoShadow = true;
      layers.background.addChild(isoShadowNode);
    }
    isoShadowNode.clear();
    const dark = codeSceneOptions.theme === 'dark';
    const alpha = dark ? 0.34 : 0.13;
    for (const part of description.parts) {
      const casts = part.kind === 'desk'
        || part.kind === 'table'
        || part.kind === 'counter'
        || part.kind === 'machine'
        || part.kind === 'plant'
        || (part.kind === 'chair' && part.id.endsWith('-chair-seat'));
      if (!casts) continue;
      const x0 = part.x0 + 0.006;
      const x1 = part.x1 - 0.006;
      const y0 = part.y0 + 0.006;
      const y1 = part.y1 - 0.006;
      if (x1 <= x0 || y1 <= y0) continue;
      fillIsoPolygon(isoShadowNode, [
        { x: x0, y: y0 + ISO_SHADOW_CAST, z: 0 },
        { x: x1, y: y0 + ISO_SHADOW_CAST, z: 0 },
        { x: x1, y: y1 + ISO_SHADOW_CAST, z: 0 },
        { x: x0, y: y1 + ISO_SHADOW_CAST, z: 0 },
      ], 0x000000, null, 1, alpha);
    }
  }

  function buildIsoDescription() {
    const workstations = typeof layout.workstations === 'function' ? layout.workstations() : null;
    const instances = workstations && Array.isArray(workstations.instances) ? workstations.instances : [];
    const seats = instances.map((instance) => {
      const position = instance && instance.seat && instance.seat.position;
      if (!position) return null;
      return { id: instance.deskId || (instance.seat && instance.seat.id) || 'desk', x: position.x, y: position.y };
    }).filter(Boolean);
    return describeIsoOffice({ seats });
  }

  // Creates/redraws one Graphics per box and re-sorts the ground pass so the
  // boxes interleave with the characters by (x + y).
  function layoutIsoFurniture() {
    if (projectionMode !== 'iso' || !codeSceneOptions.enabled) return;
    if (!isoCamera) rebuildIsoCamera();
    const description = buildIsoDescription();
    isoDescription = description;
    const layer = layers['ground-entities'];
    const seen = new Set();
    for (const part of description.parts) {
      seen.add(part.id);
      let record = isoFurniture.get(part.id);
      if (!record) {
        const node = new PIXI.Graphics();
        node.__isoPartId = part.id;
        layer.addChild(node);
        record = { node, part };
        isoFurniture.set(part.id, record);
      }
      record.part = part;
      record.node.clear();
      drawIsoBox(record.node, part);
    }
    for (const [id, record] of [...isoFurniture]) {
      if (seen.has(id)) continue;
      record.node.destroy();
      isoFurniture.delete(id);
    }
    drawIsoShadows(description);
    sortIsoGround();
  }

  function sortIsoGround() {
    const layer = layers['ground-entities'];
    const entries = [];
    const bands = isoDescription && Array.isArray(isoDescription.stations) ? isoDescription.stations : [];
    for (const record of entities.values()) {
      if (!record.container) continue;
      const point = record.__snapshot ? record.__snapshot.position : null;
      let key = point ? (point.x + point.y) : 0;
      // Seated bodies draw just before their desk, so the desk slab and its
      // modesty panel cover the legs — the same "seated bodies sit behind"
      // reading the flat renderer gets from its station re-keying.
      if (point) {
        for (const band of bands) {
          if (point.x < band.x0 || point.x > band.x1) continue;
          if (point.y < band.y0 || point.y > band.y1) continue;
          key = band.key;
          break;
        }
      }
      entries.push({ key, node: record.container, id: record.employeeId, kind: 'character' });
    }
    for (const record of isoFurniture.values()) {
      const part = record.part;
      entries.push({
        key: part.sortKey === undefined ? part.depth : part.sortKey,
        node: record.node,
        id: part.id,
        kind: 'furniture',
      });
    }
    entries.sort((a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id)));
    applyGroundOrder(layer, entries);
    return entries.map((entry) => entry.id);
  }

  // ---- 2.5D coded furniture (2026-10-27) ---------------------------------
  // The user's call: furniture and props are generated in code instead of
  // being collaged from image assets. Every part is an axis-aligned box drawn
  // as a top face + a front face; the flat projection keeps the camera where
  // it is (no skewed view) and reads height by lifting the footprint upward.
  // One Graphics per group, sorted with the characters by the group's
  // front-bottom edge, so occlusion is a property of geometry, not layers.
  const officeGroups = new Map();
  let officeShadowNode = null;

  function mixHex(a, b, t) {
    const k = Math.min(1, Math.max(0, t));
    const ar = (a >> 16) & 0xff; const ag = (a >> 8) & 0xff; const ab = a & 0xff;
    const br = (b >> 16) & 0xff; const bg = (b >> 8) & 0xff; const bb = b & 0xff;
    return (Math.round(ar + (br - ar) * k) << 16)
      | (Math.round(ag + (bg - ag) * k) << 8)
      | Math.round(ab + (bb - ab) * k);
  }

  function officeTone(tone) {
    const c = sceneColors();
    const dark = codeSceneOptions.theme === 'dark';
    const accent = ACCENTS[codeSceneOptions.accent] || ACCENTS.indigo;
    const paper = dark ? 0x4b4e52 : 0xffffff;
    // Metal, keycaps, mesh and glass are *material* families shared by every
    // object in the kit (2026-10-28 refinement). Deriving them from the theme
    // instead of hard-coding 0xRRGGBB keeps one light direction and one
    // saturation budget: nothing may out-shine the wood it stands on.
    const metalTop = dark ? 0x4e5359 : 0xccd1d6;
    const metalFront = dark ? 0x3b4045 : 0xa8afb6;
    const steelTop = dark ? 0x3a3e43 : 0xb4bac0;
    const steelFront = dark ? 0x2c3034 : 0x8f979e;
    const keycapTop = dark ? 0x585c61 : 0xeceef0;
    const keycapFront = dark ? 0x44484d : 0xd2d7db;
    const meshTop = dark ? 0x3a3d40 : 0x6b7784;
    const meshFront = dark ? 0x2c2f32 : 0x525e6a;
    const tones = {
      desk: { top: c.deskTop, front: c.deskFront },
      deskSide: { top: c.deskSide, front: c.deskSide },
      deskFront: { top: c.deskFront, front: c.deskSide },
      monitor: { top: c.monitorBody, front: c.monitorEdge },
      monitorEdge: { top: c.monitorEdge, front: c.monitorEdge },
      // Brushed metal: one step brighter than the monitor shell so handles,
      // legs and the monitor neck separate from the body they sit on.
      metal: { top: metalTop, front: metalFront },
      steel: { top: steelTop, front: steelFront },
      keycap: { top: keycapTop, front: keycapFront },
      mesh: { top: meshTop, front: meshFront },
      chairSeat: { top: c.chairSeat, front: c.chairBack },
      chairBack: { top: c.chairBack, front: c.chairBack },
      sofa: { top: c.sofa, front: c.sofaFront },
      sofaBack: { top: c.sofa, front: c.sofa },
      sofaSeat: { top: c.sofaSeat, front: c.sofaFront },
      counterFront: { top: c.counterFront, front: c.counterFront },
      counterTop: { top: c.counterTop, front: c.counterTop },
      counterSide: { top: c.counterSide, front: c.counterSide },
      plantPot: { top: c.plantPot, front: c.plantPot },
      // 第二种盆色：4 个物种如果都用同一个米色盆，一眼就是复用（2026-10-28）。
      plantPotAlt: {
        top: mixHex(c.plantPot, dark ? 0x9aa0a6 : 0xe8e4dc, dark ? 0.26 : 0.62),
        front: mixHex(c.plantPot, dark ? 0x9aa0a6 : 0xe8e4dc, dark ? 0.26 : 0.62),
      },
      plantLeaf: { top: c.plantLeaf, front: c.plantLeaf },
      plantLeafAlt: {
        top: mixHex(c.plantLeaf, dark ? 0x000000 : 0x2f4a36, dark ? 0.30 : 0.22),
        front: mixHex(c.plantLeaf, dark ? 0x000000 : 0x2f4a36, dark ? 0.30 : 0.22),
      },
      rug: { top: c.rug, front: c.rug },
      paper: { top: paper, front: paper },
      accent: { top: accent, front: accent },
      // Softer accent for pillows/lamp shades: never a saturated UI chip.
      accentSoft: { top: mixHex(accent, dark ? 0x000000 : 0xffffff, 0.55), front: mixHex(accent, dark ? 0x000000 : 0xffffff, 0.65) },
      // Sticky notes: the accent desaturated most of the way to paper, so a
      // note reads as coloured stationery, not as a UI swatch.
      sticky: {
        top: mixHex(accent, paper, dark ? 0.62 : 0.74),
        front: mixHex(accent, paper, dark ? 0.54 : 0.66),
      },
      // Ceramic (mugs, crockery): even further toward paper. The reviewer
      // measured the old raw-accent mug at saturation 0.68 while every other
      // object sits at 0.16–0.18 — that gap is exactly what made it read as a
      // UI chip. 0.80/0.84 lands at sat ≈0.13–0.16, in family with the rest.
      ceramic: {
        top: mixHex(accent, paper, dark ? 0.74 : 0.84),
        front: mixHex(accent, paper, dark ? 0.68 : 0.80),
      },
      // A lamp shade is warm material even in a neutral room; reusing the
      // accent made it read as a lavender UI chip.
      lampShade: {
        top: dark ? 0x6b604e : 0xf4e7c8,
        front: dark ? 0x584f40 : 0xe8d5ab,
      },
    };
    const base = tones[tone] || tones.desk;
    // Four shades per material: lit top, plain front, shade edge, plus the
    // top lip highlight. Every object in the kit uses the same four steps, so
    // the scene reads as one material system instead of N pasted rectangles.
    return {
      top: base.top,
      front: base.front,
      edge: mixHex(base.front, 0x000000, dark ? 0.28 : 0.18),
      lip: mixHex(base.top, 0xffffff, dark ? 0.06 : 0.30),
      glow: mixHex(base.top, 0xffffff, dark ? 0.03 : 0.14),
    };
  }

  // Deterministic texture seed. The renderer is a pure projection of the
  // snapshot: the same part must paint the same grain every frame, so every
  // pseudo-random offset is hashed out of the part id instead of Math.random().
  function hash01(seed) {
    let h = 2166136261 >>> 0;
    const text = String(seed);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------------
  // Material textures (2026-10-28 refinement).
  //
  // The user's verdict on the first prototype was "几个色块简单拼接". A flat
  // rectangle is the problem; a rectangle plus a *material* is the fix. These
  // four helpers are the whole vocabulary — wood, stone, fabric and paper —
  // each one only ever draws low-alpha lines or dots so the silhouette stays
  // the subject and the texture never becomes a pattern.
  // ---------------------------------------------------------------------

  // Wood grain: 4–6 straight-ish lines running along the slab's long axis,
  // plus one faint knot. Lines are 1px and ≤0.16 alpha: visible at 1:1, gone
  // at a glance — which is exactly what "material" means at this size.
  function woodGrain(node, part, tone, dark) {
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const y = part.y0 * H - part.z1 * H;
    const d = Math.max(2, (part.y1 - part.y0) * H);
    if (w < 24 || d < 5) return;
    const lines = 5;
    const alpha = dark ? 0.13 : 0.10;
    for (let i = 0; i < lines; i += 1) {
      const seed = hash01(`${part.id}:grain:${i}`);
      const gy = y + 2 + (d - 4) * ((i + 0.35 + seed * 0.3) / lines);
      const startX = x + 2 + w * 0.03 * seed;
      const len = w * (0.42 + seed * 0.42);
      // A 1px-high run with a 1px step in the middle reads as grain rather
      // than as a ruled line.
      const midX = startX + len * 0.55;
      node.rect(startX, gy, Math.max(2, midX - startX), 1)
        .fill({ color: tone.edge, alpha });
      node.rect(midX, gy + (seed > 0.5 ? 0 : 1), Math.max(2, startX + len - midX), 1)
        .fill({ color: tone.edge, alpha: alpha * 0.8 });
    }
    // One faint knot on the right third: the single asymmetry that stops the
    // grain from looking machine-printed.
    const knot = hash01(`${part.id}:knot`);
    node.ellipse(x + w * (0.62 + knot * 0.18), y + d * (0.34 + knot * 0.30),
      Math.max(1, w * 0.016), Math.max(0.8, d * 0.07))
      .fill({ color: tone.edge, alpha: dark ? 0.16 : 0.11 });
  }

  // Brushed metal: the review's sharpest material finding (2026-10-28) was that
  // a fridge is 64% one flat colour with a single 1px highlight — "it differs
  // from stone only in lightness". Metal needs three things that stone does not
  // have: a directional sheen band, a bright edge reflection, and a dark seam.
  // All are low-alpha so the object still reads as one colour.
  function drawMetalSurface(node, part, tone, dark, x, y, w, h) {
    if (w < 6 || h < 6) return;
    // Sheen: a broad vertical band offset from centre (the window side).
    const bandX = x + w * 0.22;
    const bandW = Math.max(2, w * 0.16);
    node.rect(bandX, y + 1, bandW, Math.max(2, h - 2))
      .fill({ color: tone.lip, alpha: dark ? 0.10 : 0.34 });
    // A second, narrower band: brushed metal has two highlights, not one.
    node.rect(x + w * 0.60, y + 1, Math.max(1, w * 0.07), Math.max(2, h - 2))
      .fill({ color: tone.lip, alpha: dark ? 0.07 : 0.22 });
    // Edge reflections: a bright line on the lit side, dark on the other.
    node.rect(x, y + 1, 1, Math.max(2, h - 2)).fill({ color: tone.lip, alpha: dark ? 0.18 : 0.55 });
    node.rect(x + w - 1, y + 1, 1, Math.max(2, h - 2)).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.16 });
    // Horizontal brush strokes: 2–3 faint lines make it "drawn", not "flat".
    for (let i = 1; i <= 2; i += 1) {
      const gy = y + (h * i) / 3;
      node.rect(x + 2, gy, Math.max(1, w - 4), 1).fill({ color: tone.edge, alpha: dark ? 0.12 : 0.08 });
    }
  }

  // Stone: specks + a migration vein. The review found the counter top to be
  // 78% one colour, and stone that is uniform reads as plastic (2026-10-28).
  // Three features separate stone from flat grey: larger mineral flecks at two
  // sizes, one long low-alpha vein across the slab, and a per-tile tonal shift.
  function stoneSpecks(node, part, tone, dark) {
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const y = part.y0 * H - part.z1 * H;
    const d = Math.max(2, (part.y1 - part.y0) * H);
    if (w < 20 || d < 5) return;
    // Mineral flecks: 14, at two sizes and both directions (dark and light).
    for (let i = 0; i < 14; i += 1) {
      const a = hash01(`${part.id}:stone:${i}`);
      const b = hash01(`${part.id}:stone2:${i}`);
      const big = i % 4 === 0;
      const sw = big ? 1.6 + b * 1.4 : 0.8 + b * 0.8;
      const sh = big ? 1.2 + a : 0.7 + a * 0.7;
      node.rect(x + 2 + a * (w - 5), y + 2 + b * (d - 5), sw, sh)
        .fill({ color: i % 3 === 0 ? tone.edge : tone.lip, alpha: dark ? 0.26 : 0.34 });
    }
    // One migration vein: a shallow diagonal, brighter than the flecks.
    node.moveTo(x + w * 0.08, y + d * 0.72)
      .lineTo(x + w * 0.34, y + d * 0.52)
      .lineTo(x + w * 0.52, y + d * 0.58)
      .lineTo(x + w * 0.78, y + d * 0.30)
      .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.16 : 0.30 });
    // Panel-to-panel tonal shift: stone slabs are never one batch.
    const shift = hash01(`${part.id}:slab`);
    node.rect(x, y, w, d).fill({ color: shift > 0.5 ? 0xffffff : 0x000000, alpha: 0.022 });
  }

  // Fabric: 3–4 seams plus a soft inner shading band. Used by cushions, sofa
  // seats and the mesh back, where "same flat colour" was reading as plastic.
  function fabricSeams(node, part, tone, dark, count) {
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const y = part.y0 * H - part.z1 * H;
    const d = Math.max(2, (part.y1 - part.y0) * H);
    if (w < 16 || d < 4) return;
    const seams = count || 3;
    for (let i = 1; i <= seams; i += 1) {
      const sy = y + (d * i) / (seams + 1);
      node.rect(x + 2, sy, Math.max(2, w - 4), 1)
        .fill({ color: tone.edge, alpha: dark ? 0.26 : 0.18 });
    }
    // Cushion softness: a lit band along the back and a shadowed band along
    // the front edge, so the pad has a dome instead of a flat top.
    node.rect(x + 1, y + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.34 });
    node.rect(x + 1, y + d - 2, Math.max(1, w - 2), 1).fill({ color: tone.edge, alpha: dark ? 0.30 : 0.20 });
  }

  // Paper: stacked sheets, one folded corner, a few text lines. Drawn on the
  // top face of the papers box so the stack keeps one silhouette.
  function paperStack(node, part, tone, dark) {
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const y = part.y0 * H - part.z1 * H;
    const d = Math.max(2, (part.y1 - part.y0) * H);
    if (w < 14 || d < 8) return;
    // Two lower sheets peeking out at a deterministic offset.
    const ox = Math.max(1, Math.round(w * 0.035));
    const oy = Math.max(1, Math.round(d * 0.06));
    node.rect(x + ox, y + oy, w - ox, d - oy)
      .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.12 : 0.06) });
    node.rect(x + ox * 2, y + oy * 2, w - ox * 2, d - oy * 2)
      .fill({ color: tone.front });
    // Folded top-right corner: a small triangle of the sheet underneath.
    const fold = Math.max(3, Math.min(w, d) * 0.16);
    node.moveTo(x + w - fold, y)
      .lineTo(x + w, y)
      .lineTo(x + w, y + fold)
      .closePath()
      .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.22 : 0.12) });
    // Text lines: 3, indented, unequal — paragraphs, not a rule set.
    const lineColor = dark ? 0x000000 : 0x5b6470;
    node.rect(x + ox * 2 + 2, y + oy * 2 + Math.max(3, d * 0.16), w * 0.62, 1)
      .fill({ color: lineColor, alpha: dark ? 0.30 : 0.16 });
    node.rect(x + ox * 2 + 2, y + oy * 2 + Math.max(5, d * 0.34), w * 0.78, 1)
      .fill({ color: lineColor, alpha: dark ? 0.26 : 0.13 });
    node.rect(x + ox * 2 + 2, y + oy * 2 + Math.max(7, d * 0.52), w * 0.44, 1)
      .fill({ color: lineColor, alpha: dark ? 0.22 : 0.11 });
  }

  // A soft contact shadow on the floor: two nested ellipses, never one hard
  // one. One ellipse reads as a stain; two read as falloff.
  function floorContact(node, cx, cy, rx, ry, strength) {
    const dark = codeSceneOptions.theme === 'dark';
    const a = (dark ? 0.20 : 0.055) * (strength === undefined ? 1 : strength);
    node.ellipse(cx, cy, rx, ry).fill({ color: 0x000000, alpha: a });
    node.ellipse(cx, cy, rx * 0.62, ry * 0.62).fill({ color: 0x000000, alpha: a * 0.85 });
  }

  // A throw pillow is one rounded square standing on the seat, leaning back.
  // It is drawn as a single face (no box top) because a cushion has no
  // readable top plane at this size — the box path made it look like a cube
  // with a lid (2026-10-28).
  function drawPillow(node, part, tone) {
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(3, (part.x1 - part.x0) * W);
    // Use the full box height on screen (the pillow leans on the back cushion).
    const baseY = part.y1 * H - part.z0 * H;
    const topY = part.y1 * H - part.z1 * H;
    const h = Math.max(4, baseY - topY);
    const r = Math.max(3, Math.min(w, h) * 0.38);
    // Contact shadow on the seat.
    node.ellipse(x + w / 2, baseY - 1, w * 0.55, Math.max(1.5, h * 0.16))
      .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.10 });
    // Body.
    node.roundRect(x, topY, w, h, r).fill({ color: tone.front });
    // Domed face: an inset rounded rect, lighter, offset toward the light.
    node.roundRect(x + w * 0.10, topY + h * 0.12, w * 0.80, h * 0.76, r * 0.72)
      .fill({ color: tone.top, alpha: dark ? 0.34 : 0.62 });
    // Lit top edge and shaded bottom edge (one light source, same as everything
    // else in the kit).
    node.roundRect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(1, h * 0.20), r * 0.8)
      .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.44 });
    node.roundRect(x + 1, topY + h - Math.max(2, h * 0.18), Math.max(1, w - 2), Math.max(2, h * 0.18), r * 0.6)
      .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.12 });
    // Centre crease with a soft button in the middle.
    node.rect(x + w * 0.5, topY + h * 0.22, 1, Math.max(1, h * 0.50))
      .fill({ color: tone.edge, alpha: dark ? 0.34 : 0.20 });
    node.circle(x + w * 0.5, topY + h * 0.50, Math.max(1, Math.min(w, h) * 0.055))
      .fill({ color: tone.edge, alpha: dark ? 0.30 : 0.18 });
    // Silhouette.
    node.roundRect(x, topY, w, h, r).stroke({ width: 1, color: 0x000000, alpha: dark ? 0.30 : 0.16 });
  }

  // A leaf is drawn from SIMPLE primitives only: a rotated ellipse for the
  // blade plus a triangle for the point, both filled in the same colour.
  //
  // Why not a sampled contour: two attempts at a 20-point custom outline
  // (moveTo/lineTo/closePath, then poly()) both rendered with pale slivers
  // punched through the blade — the floor and its grout showed through. The
  // polygon was verified non-self-intersecting offline, so the breakage comes
  // from reusing one Graphics path across the fill/stroke sequence in Pixi v8.
  // Simple primitives are one shape per call and cannot hit that state at all.
  // 4 种叶形，由 geometry 的 `part.family` 选择（2026-10-28 第二轮）。
  // 上一版所有物种共用"椭圆 + 尖三角"，所以 4 盆绿植看起来是同一张贴纸。
  // 全部只用简单图元（ellipse / poly / 直线），避开自建路径在 Pixi v8 上
  // 复用路径状态打洞的坑（见 §9.3 第 5 条）。
  function drawLeaf(node, part, tone) {
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const cx = (part.x0 + part.x1) / 2 * W;
    const rx = Math.max(2, (part.x1 - part.x0) / 2 * W);
    const cy = (part.y0 + part.y1) / 2 * H - part.z1 * H;
    const ry = Math.max(2, (part.y1 - part.y0) / 2 * H);
    const tilt = typeof part.tilt === 'number' ? part.tilt : 0;
    const family = part.family || 'broad';
    const edgeA = dark ? 0.40 : 0.26;
    // 叶下投影：所有叶形共用。
    node.ellipse(cx, cy + ry * 0.52, rx * 0.70, ry * 0.32)
      .fill({ color: 0x000000, alpha: dark ? 0.20 : 0.07 });

    if (family === 'sword') {
      // 虎皮兰：细长直立剑形叶。细高椭圆 + 更长的尖端，几乎不横向展开。
      const tipX = cx + tilt * rx * 0.55;
      const tipY = cy - ry * 1.05;
      node.ellipse(cx, cy, rx, ry).fill({ color: tone.front });
      node.poly([
        cx - rx * 0.80, cy - ry * 0.50,
        tipX, tipY,
        cx + rx * 0.80, cy - ry * 0.50,
      ]).fill({ color: tone.front });
      // 剑叶的特征：两侧各一条纵向浅色边（虎皮兰的镶边）。
      node.moveTo(cx - rx * 0.72, cy + ry * 0.72)
        .lineTo(tipX - rx * 0.10, tipY + ry * 0.10)
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.14 : 0.34 });
      node.moveTo(cx + rx * 0.72, cy + ry * 0.72)
        .lineTo(tipX + rx * 0.06, tipY + ry * 0.10)
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.10 : 0.24 });
      // 中央叶脉。
      node.moveTo(cx, cy + ry * 0.85).lineTo(tipX, tipY + ry * 0.10)
        .stroke({ width: 1, color: tone.edge, alpha: edgeA });
      node.ellipse(cx, cy, rx, ry).stroke({ width: 1, color: tone.edge, alpha: edgeA });
    } else if (family === 'rosette') {
      // 多肉：贴地莲座。每片是短胖的椭圆，尖端朝外上方，层叠出花心。
      const tipX = cx + tilt * rx * 0.9;
      const tipY = cy - ry * 0.30;
      node.ellipse(cx, cy, rx, ry).fill({ color: tone.front });
      node.poly([
        cx - rx * 0.85, cy - ry * 0.30,
        tipX, tipY,
        cx + rx * 0.85, cy - ry * 0.30,
      ]).fill({ color: tone.front });
      // 莲座的厚叶感：一条亮脊 + 一条暗底。
      node.ellipse(cx - rx * 0.16, cy - ry * 0.16, rx * 0.40, ry * 0.36)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.26 });
      node.ellipse(cx, cy + ry * 0.34, rx * 0.72, ry * 0.26)
        .fill({ color: 0x000000, alpha: dark ? 0.22 : 0.10 });
      node.ellipse(cx, cy, rx, ry).stroke({ width: 1, color: tone.edge, alpha: edgeA });
    } else if (family === 'round') {
      // 榕树：小圆叶，几乎没有尖，叶柄短。
      const tipX = cx + tilt * rx * 0.30;
      node.ellipse(cx, cy, rx, ry).fill({ color: tone.front });
      node.ellipse(cx + tilt * rx * 0.24, cy - ry * 0.16, rx * 0.72, ry * 0.78)
        .fill({ color: tone.front });
      node.ellipse(cx - rx * 0.18, cy - ry * 0.22, rx * 0.44, ry * 0.40)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.26 });
      node.moveTo(cx, cy + ry * 0.30).lineTo(tipX, cy - ry * 0.30)
        .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.34 : 0.22 });
      node.ellipse(cx, cy, rx, ry).stroke({ width: 1, color: tone.edge, alpha: edgeA });
    } else {
      // 龟背竹 / 阔叶：宽椭圆 + 尖头 + 叶脉，叶缘要有几个裂口暗示。
      const tipX = cx + tilt * rx * 0.70;
      const tipY = cy - ry * 1.10;
      node.ellipse(cx, cy, rx, ry).fill({ color: tone.front });
      node.poly([
        cx - rx * 0.78, cy - ry * 0.52,
        tipX, tipY,
        cx + rx * 0.78, cy - ry * 0.52,
      ]).fill({ color: tone.front });
      // 龟背竹的裂口：沿叶缘两侧各两个深色缺口（不是真的挖洞，靠低 alpha
      // 的短线暗示，避免再次触发路径打洞）。
      const notch = Math.max(1, rx * 0.10);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i += 1) {
          const ny = cy - ry * (0.10 + i * 0.42);
          node.moveTo(cx + side * rx * 0.92, ny)
            .lineTo(cx + side * (rx * 0.92 - notch), ny + ry * 0.16)
            .stroke({ width: Math.max(1, rx * 0.10), color: tone.edge, alpha: dark ? 0.30 : 0.20 });
        }
      }
      // 亮脊 + 中脉 + 两条侧脉。
      node.ellipse(cx - rx * 0.24, cy - ry * 0.30, rx * 0.44, ry * 0.38)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.24 });
      node.moveTo(cx - rx * 0.10, cy + ry * 0.60).lineTo(tipX, tipY + ry * 0.14)
        .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.42 : 0.30 });
      for (let i = 1; i <= 2; i += 1) {
        const t = i / 3;
        const vx = cx - rx * 0.08 + (tipX - (cx - rx * 0.08)) * t;
        const vy = cy + ry * 0.48 + (tipY - (cy + ry * 0.48)) * t;
        node.moveTo(vx, vy).lineTo(vx - rx * 0.40, vy + ry * 0.28)
          .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.24 : 0.17 });
        node.moveTo(vx, vy).lineTo(vx + rx * 0.36, vy + ry * 0.24)
          .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.22 : 0.15 });
      }
      node.ellipse(cx, cy, rx, ry).stroke({ width: 1, color: tone.edge, alpha: edgeA });
    }
  }

  // Tapered pot: wider at the rim than the base, with a rim band, a soil
  // ellipse, a rim highlight and a shadow under the pot. The old version was a
  // trapezoid with one ellipse; it read as a bucket of brown paint.
  function drawPot(node, part, tone) {
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const d = Math.max(2, (part.y1 - part.y0) * H);
    const h = Math.max(2, (part.z1 - part.z0) * H);
    const frontY = part.y1 * H - part.z1 * H;
    const topY = part.y0 * H - part.z1 * H;
    const rimH = Math.max(2, Math.round(h * 0.16));
    const flare = w * 0.10;
    // Floor shadow first.
    node.ellipse(x + w / 2, frontY + h, w * 0.62, Math.max(1.5, d * 0.30))
      .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.09 });
    // Body: rim wider than base (a tapered pot).
    node.moveTo(x + flare, frontY)
      .lineTo(x + w - flare, frontY)
      .lineTo(x + w - flare * 2.2, frontY + h)
      .lineTo(x + flare * 2.2, frontY + h)
      .closePath()
      .fill({ color: tone.front });
    // Vertical form shading: lit left third, shaded right third.
    node.moveTo(x + flare, frontY)
      .lineTo(x + flare + w * 0.16, frontY)
      .lineTo(x + flare * 2.2 + w * 0.14, frontY + h)
      .lineTo(x + flare * 2.2, frontY + h)
      .closePath()
      .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.28 });
    node.moveTo(x + w - flare - w * 0.14, frontY)
      .lineTo(x + w - flare, frontY)
      .lineTo(x + w - flare * 2.2, frontY + h)
      .lineTo(x + w - flare * 2.2 - w * 0.10, frontY + h)
      .closePath()
      .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.12 });
    // Rim band: a slightly lighter collar around the mouth.
    node.rect(x + flare * 0.6, frontY, w - flare * 1.2, rimH)
      .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.08 : 0.18) });
    node.rect(x + flare * 0.6, frontY + rimH, w - flare * 1.2, 1)
      .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    // Pot mouth: rim ellipse then the soil inside it. The soil must be clearly
    // SMALLER than the rim, or the mouth reads as a hole punched through the
    // pot (found at 1:1, 2026-10-28).
    const mouthY = topY + Math.max(1, d * 0.42);
    node.ellipse(x + w / 2, mouthY, w / 2 - flare * 0.4, Math.max(1, d * 0.34))
      .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.10 : 0.22) });
    node.ellipse(x + w / 2, mouthY + Math.max(0.5, d * 0.04), w * 0.34, Math.max(1, d * 0.20))
      .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.55 : 0.42) });
    // Soil texture: 3 deterministic flecks.
    for (let i = 0; i < 3; i += 1) {
      const a = hash01(`${part.id}:soil:${i}`);
      node.rect(x + w * (0.40 + a * 0.20), mouthY - d * 0.02 + a * d * 0.06, 1, 1)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.22 });
    }
    node.ellipse(x + w / 2, mouthY, w / 2 - flare * 0.4, Math.max(1, d * 0.34))
      .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.22 : 0.55 });
  }

  // Square tapered pot (succulent). A straight-sided square planter has a very
  // different silhouette from the round tapered pot, which is what breaks the
  // "all four plants are the same sticker" impression (2026-10-28).
  function drawPotSquare(node, part, tone) {
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(2, (part.x1 - part.x0) * W);
    const d = Math.max(2, (part.y1 - part.y0) * H);
    const h = Math.max(2, (part.z1 - part.z0) * H);
    const frontY = part.y1 * H - part.z1 * H;
    const topY = part.y0 * H - part.z1 * H;
    const rimH = Math.max(2, Math.round(h * 0.14));
    const taper = w * 0.06;
    // Floor shadow.
    node.rect(x + taper, frontY + h, w - taper * 2, 1).fill({ color: 0x000000, alpha: dark ? 0.24 : 0.08 });
    // A SHALLOW square planter (h≈19px, d≈14px) has almost no readable top
    // face — drawing a full top-face rect just produced a dark "window" punched
    // through the planter at 1:1 (2026-10-28). So: front face + a thin rim
    // strip at the top, and the soil is implied by the rim's dark inner line.
    // This is the same trick the round pot uses, minus the ellipse.
    // Body: straight walls, slight taper (a square planter, not a bucket).
    node.moveTo(x, frontY)
      .lineTo(x + w, frontY)
      .lineTo(x + w - taper, frontY + h)
      .lineTo(x + taper, frontY + h)
      .closePath()
      .fill({ color: tone.front });
    // Left-lit / right-shaded walls.
    node.moveTo(x, frontY).lineTo(x + w * 0.26, frontY)
      .lineTo(x + w * 0.26 - taper + 1, frontY + h).lineTo(x + taper, frontY + h)
      .closePath().fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
    node.moveTo(x + w * 0.74, frontY).lineTo(x + w, frontY)
      .lineTo(x + w - taper, frontY + h).lineTo(x + w * 0.74 - taper + 1, frontY + h)
      .closePath().fill({ color: 0x000000, alpha: dark ? 0.26 : 0.12 });
    // Rim strip: a lit band at the top edge, then a dark soil line just under
    // it. The pair reads as "the planter is open and full of soil" without
    // needing a top face at all.
    node.rect(x, frontY, w, rimH).fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.10 : 0.24) });
    node.rect(x, frontY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.16 : 0.46 });
    node.rect(x + w * 0.10, frontY + rimH * 0.55, w - w * 0.20, Math.max(1, Math.round(rimH * 0.45)))
      .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.52 : 0.38) });
    node.rect(x, frontY + rimH, w, 1).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
  }

  // Five-star office-chair base seen from above: a hub disc, five tapered
  // spokes and five casters. The old version (one ellipse + five even lines)
  // read as a dark asterisk; taper + caster highlight is what makes it a
  // mechanism.
  function drawChairStar(node, part, tone) {
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const cx = (part.x0 + part.x1) / 2 * W;
    const cy = (part.y0 + part.y1) / 2 * H;
    const rx = Math.max(4, (part.x1 - part.x0) / 2 * W);
    const ry = Math.max(2.5, (part.y1 - part.y0) / 2 * H * 0.62);
    // Ground occlusion under the whole star.
    node.ellipse(cx, cy + ry * 0.30, rx * 1.06, ry * 0.78)
      .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.075 });
    // Spokes first (under the hub), drawn as tapered quads.
    for (let i = 0; i < 5; i += 1) {
      const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const ex = cx + Math.cos(angle) * rx * 0.94;
      const ey = cy + Math.sin(angle) * ry * 0.94;
      const halfBase = Math.max(1.2, rx * 0.15);
      const halfTip = Math.max(0.8, rx * 0.08);
      const nx = Math.cos(angle + Math.PI / 2);
      const ny = Math.sin(angle + Math.PI / 2);
      node.moveTo(cx + nx * halfBase, cy + ny * halfBase * 0.62)
        .lineTo(ex + nx * halfTip, ey + ny * halfTip * 0.62)
        .lineTo(ex - nx * halfTip, ey - ny * halfTip * 0.62)
        .lineTo(cx - nx * halfBase, cy - ny * halfBase * 0.62)
        .closePath()
        .fill({ color: tone.front });
      // Lit top edge of each spoke: one consistent light direction.
      node.moveTo(cx + nx * halfBase, cy + ny * halfBase * 0.62)
        .lineTo(ex + nx * halfTip, ey + ny * halfTip * 0.62)
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.16 : 0.45 });
    }
    // Central hub: disc + collar.
    node.ellipse(cx, cy, rx * 0.26, ry * 0.26).fill({ color: tone.top });
    node.ellipse(cx, cy, rx * 0.26, ry * 0.26).stroke({ width: 1, color: tone.edge, alpha: 0.6 });
    node.ellipse(cx - rx * 0.06, cy - ry * 0.07, rx * 0.12, ry * 0.12)
      .fill({ color: tone.lip, alpha: dark ? 0.20 : 0.55 });
    // Casters: dark wheel + 1px highlight + its own tiny contact shadow.
    for (let i = 0; i < 5; i += 1) {
      const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const wx = cx + Math.cos(angle) * rx * 0.94;
      const wy = cy + Math.sin(angle) * ry * 0.94;
      const wr = Math.max(1.4, rx * 0.11);
      node.ellipse(wx, wy + wr * 0.34, wr * 1.05, wr * 0.52)
        .fill({ color: 0x000000, alpha: dark ? 0.34 : 0.14 });
      node.circle(wx, wy, wr).fill({ color: dark ? 0x15171a : 0x23262a, alpha: 0.92 });
      node.circle(wx - wr * 0.24, wy - wr * 0.28, Math.max(0.6, wr * 0.32))
        .fill({ color: 0xffffff, alpha: dark ? 0.20 : 0.30 });
    }
  }

  // One box: front face, top face, seam, then surface details.
  function drawOfficePart(node, part) {
    const c = sceneColors();
    const dark = codeSceneOptions.theme === 'dark';
    const W = scene.width;
    const H = scene.height;
    const x = part.x0 * W;
    const w = Math.max(1, (part.x1 - part.x0) * W);
    const d = Math.max(1, (part.y1 - part.y0) * H);
    const h = Math.max(1, (part.z1 - part.z0) * H);
    const topY = part.y0 * H - part.z1 * H;
    const frontY = part.y1 * H - part.z1 * H;
    const tone = officeTone(part.tone);
    const radius = (part.kind === 'chair-seat' || part.kind === 'chair-back'
      || part.kind === 'rug' || part.kind === 'plant-leaf') ? Math.min(w, h) * 0.22 : 0;

    // Plants are the one soft silhouette in the kit: leaves and pots must not
    // show box faces or they read as stacked green cubes.
    if (part.kind === 'plant-leaf') {
      drawLeaf(node, part, tone);
      return;
    }
    if (part.kind === 'plant-pot' && part.detail === 'pot-square') {
      drawPotSquare(node, part, tone);
      return;
    }
    if (part.kind === 'plant-pot') {
      drawPot(node, part, tone);
      return;
    }
    if (part.kind === 'plant-tray') {
      // Tray disc under the pot.
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.5, d * 0.5)
        .fill({ color: mixHex(tone.front, 0x000000, 0.18) });
      node.ellipse(x + w / 2, topY + d * 0.5 - 1, w * 0.34, d * 0.30)
        .fill({ color: tone.lip, alpha: 0.18 });
      return;
    }
    if (part.kind === 'pillow') {
      // Pillows are a SOFT object like leaves: they must not show box faces.
      // Drawing them through the generic box path produced a cube with a lid
      // (the top face and the front face at different heights). A pillow is one
      // rounded square leaning against the back cushion, lit from the top-left.
      drawPillow(node, part, tone);
      return;
    }
    if (part.kind === 'plant-stem') {
      // Stem: a 2px tapered stroke from the pot mouth into the leaf cluster.
      const sx = (part.x0 + part.x1) / 2 * W;
      const sBase = part.y1 * H - part.z0 * H;
      const sTop = part.y1 * H - part.z1 * H;
      node.moveTo(sx, sBase)
        .lineTo(sx + (part.tilt || 0) * 3, sTop)
        .stroke({ width: 2, color: tone.front });
      node.moveTo(sx, sBase)
        .lineTo(sx + (part.tilt || 0) * 3, sTop)
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.16 : 0.34 });
      return;
    }
    if (part.kind === 'chair-star' || part.detail === 'chair-star') {
      drawChairStar(node, part, tone);
      return;
    }

    // Front face.
    if (h > 0.5) {
      if (radius > 0) node.roundRect(x, frontY, w, h + radius, radius).fill({ color: tone.front });
      else node.rect(x, frontY, w, h).fill({ color: tone.front });
      // A darker plinth line grounds the object on the floor.
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.35 : 0.16 });
    }
    // Top face.
    if (radius > 0) node.roundRect(x, topY, w, d, radius).fill({ color: tone.top });
    else node.rect(x, topY, w, d).fill({ color: tone.top });
    // Lit lip along the back of the top face + the seam between faces: the
    // pair is what gives the slab a thickness instead of a pasted rectangle.
    if (d > 2) node.rect(x + 1, topY, Math.max(0, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.22 : 0.55 });
    node.rect(x, topY + d - 1, w, 1).fill({ color: tone.edge, alpha: dark ? 0.55 : 0.7 });

    const detail = part.detail;
    if (!detail) {
      // Metal parts without their own detail branch (lamp pole, gas lift, hand
      // rails) still get the brushed-metal treatment; without it they read as
      // flat grey sticks, which the review flagged.
      if (part.tone === 'metal' || part.tone === 'steel') {
        drawMetalSurface(node, part, tone, dark, x, frontY, w, h);
      }
      return;
    }
    const inset = Math.max(1, Math.min(w, d) * 0.08);
    if (detail === 'desk-top') {
      // P0-A (2026-10-28): the slab is the single biggest surface in frame, so
      // it carries the wood. Order is deliberate — grain first, then the lit
      // lip and the front edge last, so the texture never pokes past the
      // silhouette.
      node.rect(x + 1, topY + 1, w - 2, 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.40 });
      woodGrain(node, part, tone, dark);
      // Bevel: 1px lit lip on the back and both ends, 1px shaded lip on the
      // front. Four hairlines are what give a slab a chamfered edge instead of
      // a cut-out rectangle.
      node.rect(x, topY, 1, d).fill({ color: tone.lip, alpha: dark ? 0.08 : 0.30 });
      node.rect(x + w - 1, topY, 1, d).fill({ color: tone.lip, alpha: dark ? 0.06 : 0.22 });
      // Front edge: 2px dark band + 1px lit line above it (the chamfer catch).
      const edgeH = Math.max(2, Math.round(h * 0.30));
      node.rect(x, frontY + h - edgeH, w, edgeH)
        .fill({ color: tone.edge, alpha: dark ? 0.36 : 0.24 });
      node.rect(x, frontY + h - edgeH - 1, w, 1)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.42 });
      // Under-slab occlusion: the deepest part of the shadow is against the
      // back edge (the wall side), fading toward the front.
      const aoH = Math.max(3, Math.round(h * 0.55));
      for (let i = 0; i < 3; i += 1) {
        node.rect(x, frontY + h + i * Math.max(2, aoH / 3), w - i * 2, Math.max(2, aoH / 3))
          .fill({ color: 0x000000, alpha: (dark ? 0.16 : 0.055) * (1 - i * 0.32) });
      }
    } else if (detail === 'desk-leg') {
      // Side boards: a 1px lit edge on the outside, a 1px shadow on the inside,
      // and a dark foot pad where the board meets the floor. Without the foot
      // pad the board looks pasted onto the carpet.
      node.rect(x, frontY + 1, 1, h - 2).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.22 });
      node.rect(x + w - 1, frontY + 1, 1, h - 2).fill({ color: 0x000000, alpha: dark ? 0.20 : 0.07 });
      node.rect(x, frontY + h - 2, w, 2).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.14 });
    } else if (detail === 'panel') {
      // Modesty panel: hangs from the slab, never reaches the floor, and has a
      // vertical seam. A panel that touched the floor turned the desk into a
      // cabinet (2026-10-27 defect #1) — keep the gap.
      node.rect(x + 1, frontY + 1, 1, h - 2).fill({ color: 0x000000, alpha: dark ? 0.2 : 0.06 });
      node.rect(x + w * 0.5, frontY + 2, 1, Math.max(1, h - 4)).fill({ color: tone.edge, alpha: dark ? 0.30 : 0.20 });
      node.rect(x, frontY + h - 2, w, 2).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.12 });
    } else if (detail === 'drawer') {
      // Three drawers. Each is inset on three sides (a 1px dark line top/left/
      // right), carries a brushed bar pull with a lit line under it, and the
      // bottom drawer sits on a recessed plinth. This is the "it has a reason
      // to look like this" detail the flat version was missing.
      const rows = 3;
      const plinth = Math.max(2, Math.round(h * 0.07));
      const bodyH = h - plinth;
      for (let i = 0; i < rows; i += 1) {
        const ry = frontY + (bodyH * i) / rows;
        const rh = bodyH / rows;
        // Inset shadow: top edge darkest, then the two sides.
        node.rect(x + 1, ry, w - 2, 1).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
        node.rect(x + 1, ry + 1, 1, rh - 2).fill({ color: 0x000000, alpha: dark ? 0.22 : 0.09 });
        node.rect(x + w - 2, ry + 1, 1, rh - 2).fill({ color: 0x000000, alpha: dark ? 0.22 : 0.09 });
        // Bar pull: 2px metal bar with a 1px bright top and a dark drop below.
        const pullW = Math.max(6, Math.round(w * 0.42));
        const pullX = x + (w - pullW) / 2;
        const pullY = ry + rh * 0.46;
        node.rect(pullX, pullY, pullW, 2).fill({ color: officeTone('metal').front });
        node.rect(pullX, pullY, pullW, 1).fill({ color: officeTone('metal').lip, alpha: dark ? 0.28 : 0.72 });
        node.rect(pullX, pullY + 2, pullW, 1).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
      }
      // Recessed plinth.
      node.rect(x + 2, frontY + bodyH, w - 4, plinth).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
    } else if (detail === 'screen') {
      // P0-B: a monitor is a *bezel*, a *glass*, and a *lit panel*, in that
      // order. The old version was a dark rectangle with a pale rectangle on
      // it — a sticker. Now: 3px bezel, 1px inner chamfer, inset glass, a
      // window bar, code-line hints, a dock, a diagonal reflection, and a
      // power LED.
      const bezel = Math.max(2, Math.round(Math.min(w, h) * 0.055));
      const gx = x + bezel;
      const gy = frontY + bezel;
      const gw = Math.max(2, w - bezel * 2);
      const gh = Math.max(2, h - bezel * 2.2);
      // Inner chamfer: a lit 1px line just inside the bezel catches the window
      // light, which is what separates "plastic frame" from "black rectangle".
      node.rect(x + 1, frontY + 1, w - 2, 1).fill({ color: tone.lip, alpha: dark ? 0.16 : 0.34 });
      node.rect(x + 1, frontY + 1, 1, h - 2).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.26 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.4 : 0.2 });
      // Glass.
      node.rect(gx, gy, gw, gh).fill({ color: c.monitorScreen, alpha: dark ? 0.88 : 1 });
      // Screen content hints — deliberately low contrast. Specific glyphs would
      // turn into unreadable noise at this size; a window bar, three unequal
      // code lines and a dock are enough for the eye to read "a working
      // screen".
      const ink = dark ? 0x1b2a33 : 0x4a6673;
      node.rect(gx, gy, gw, Math.max(1, Math.round(gh * 0.13))).fill({ color: ink, alpha: dark ? 0.30 : 0.16 });
      const lineH = Math.max(1, Math.round(gh * 0.045));
      const lineAlpha = dark ? 0.22 : 0.12;
      node.rect(gx + gw * 0.06, gy + gh * 0.26, gw * 0.46, lineH).fill({ color: ink, alpha: lineAlpha });
      node.rect(gx + gw * 0.06, gy + gh * 0.38, gw * 0.62, lineH).fill({ color: ink, alpha: lineAlpha * 0.9 });
      node.rect(gx + gw * 0.12, gy + gh * 0.50, gw * 0.40, lineH).fill({ color: ink, alpha: lineAlpha * 0.8 });
      node.rect(gx + gw * 0.06, gy + gh * 0.62, gw * 0.54, lineH).fill({ color: ink, alpha: lineAlpha * 0.7 });
      node.rect(gx + gw * 0.06, gy + gh * 0.80, gw * 0.30, Math.max(1, Math.round(gh * 0.06)))
        .fill({ color: ink, alpha: (dark ? 0.24 : 0.13) });
      // Glass reflection: one diagonal band, two steps, very low alpha. Drawn
      // after the content so the screen looks like it is *behind* glass.
      const bandW = Math.max(3, Math.round(gw * 0.16));
      node.moveTo(gx + gw * 0.10, gy + gh)
        .lineTo(gx + gw * 0.10 + bandW, gy + gh)
        .lineTo(gx + gw * 0.44 + bandW, gy)
        .lineTo(gx + gw * 0.44, gy)
        .closePath()
        .fill({ color: 0xffffff, alpha: dark ? 0.055 : 0.075 });
      node.moveTo(gx + gw * 0.52, gy + gh)
        .lineTo(gx + gw * 0.52 + Math.max(2, bandW * 0.5), gy + gh)
        .lineTo(gx + gw * 0.76 + Math.max(2, bandW * 0.5), gy)
        .lineTo(gx + gw * 0.76, gy)
        .closePath()
        .fill({ color: 0xffffff, alpha: dark ? 0.035 : 0.05 });
      // Power LED, bottom-right of the bezel. Brighter in the dark room.
      node.rect(x + w - bezel - 1, frontY + h - Math.max(2, bezel * 0.7), 2, 1)
        .fill({ color: dark ? 0x9fe8b4 : 0x5fae74, alpha: dark ? 0.95 : 0.75 });
      // Screen drop shadow on the bezel's lower inner edge.
      node.rect(gx, gy + gh, gw, Math.max(1, Math.round(bezel * 0.6))).fill({ color: 0x000000, alpha: 0.28 });
    } else if (detail === 'monitor-foot') {
      // Elliptical foot plate: lit top, shadow underneath.
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.52, d * 0.5).fill({ color: tone.top });
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.52, d * 0.5)
        .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.5 : 0.4 });
      node.ellipse(x + w / 2, topY + d * 0.5 - 1, w * 0.30, d * 0.22)
        .fill({ color: tone.lip, alpha: dark ? 0.16 : 0.42 });
    } else if (detail === 'monitor-neck') {
      // Two metal steps: a lit left edge and a shaded right edge make the neck
      // read as a cylinder rather than a bar.
      node.rect(x, frontY, Math.max(1, w * 0.34), h).fill({ color: tone.lip, alpha: dark ? 0.16 : 0.5 });
      node.rect(x + w - Math.max(1, w * 0.30), frontY, Math.max(1, w * 0.30), h)
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    } else if (detail === 'cable') {
      // Desk cable: two segments approximating a slack drop from the monitor
      // foot to the back of the slab.
      const cw = Math.max(1, Math.round(w));
      node.rect(x, frontY, cw, Math.max(1, Math.round(h * 0.5))).fill({ color: tone.edge, alpha: dark ? 0.7 : 0.5 });
      node.rect(x + Math.max(1, cw * 0.3), frontY + Math.round(h * 0.4), Math.max(1, Math.round(cw * 0.6)), Math.max(1, Math.round(h * 0.6)))
        .fill({ color: tone.edge, alpha: dark ? 0.6 : 0.42 });
    } else if (detail === 'keys') {
      // P0-C keyboard: a case lip, a recessed key well, then a real key grid
      // (10 × 3 caps with a 1px gap) plus a space bar. Three ruled lines read
      // as a barcode; a grid reads as a keyboard.
      const lip = Math.max(1, Math.round(Math.min(w, d) * 0.10));
      node.rect(x + 1, topY + 1, w - 2, d - 2).fill({ color: tone.edge, alpha: dark ? 0.30 : 0.14 });
      const cols = 11;
      const rows = 3;
      const wellX = x + lip;
      const wellY = topY + lip;
      const wellW = Math.max(4, w - lip * 2);
      const wellD = Math.max(3, d - lip * 2 - Math.max(2, d * 0.22));
      const capW = wellW / cols;
      const capH = wellD / rows;
      for (let r = 0; r < rows; r += 1) {
        for (let cidx = 0; cidx < cols; cidx += 1) {
          const cx = wellX + cidx * capW;
          const cy = wellY + r * capH;
          node.rect(cx + 0.4, cy + 0.4, Math.max(1, capW - 1), Math.max(1, capH - 1))
            .fill({ color: tone.top, alpha: dark ? 0.55 : 0.85 });
        }
      }
      // Space bar: one wide cap on the bottom row.
      node.rect(wellX + capW * 3, wellY + capH * 2.2, capW * 5, Math.max(1, capH * 0.72))
        .fill({ color: tone.top, alpha: dark ? 0.60 : 0.9 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
    } else if (detail === 'mouse') {
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.5, d * 0.5).fill({ color: tone.top });
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.5, d * 0.5)
        .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.45 : 0.32 });
      node.rect(x + w / 2 - 0.5, topY + d * 0.18, 1, Math.max(1, d * 0.34)).fill({ color: tone.edge, alpha: 0.6 });
      node.circle(x + w / 2, topY + d * 0.40, Math.max(1, w * 0.10)).fill({ color: c.monitorEdge, alpha: 0.75 });
    } else if (detail === 'papers') {
      paperStack(node, part, tone, dark);
    } else if (detail === 'sticky') {
      // Two overlapping notes with a curled corner and a 1px shadow.
      node.rect(x + 2, topY + 2, w - 2, d - 2).fill({ color: officeTone('sticky').front, alpha: 0.95 });
      node.rect(x + 1, topY + 1, w - 4, d - 4).fill({ color: officeTone('sticky').top, alpha: 0.98 });
      node.moveTo(x + w - 4, topY + 1)
        .lineTo(x + w - 1, topY + 4)
        .lineTo(x + w - 1, topY + 1)
        .closePath()
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.10 });
      node.rect(x + 3, topY + d * 0.36, Math.max(2, w * 0.5), 1).fill({ color: 0x000000, alpha: 0.16 });
      node.rect(x + 3, topY + d * 0.62, Math.max(2, w * 0.34), 1).fill({ color: 0x000000, alpha: 0.13 });
    } else if (detail === 'pen') {
      // Pen cup: tapered body, dark mouth (top ellipse), three pens of unequal
      // height with 1px caps. A flat circle was reading as a dot.
      node.moveTo(x + 1, frontY)
        .lineTo(x + w - 1, frontY)
        .lineTo(x + w, frontY + h)
        .lineTo(x, frontY + h)
        .closePath()
        .fill({ color: tone.front });
      node.rect(x + 1, frontY, Math.max(1, w - 2), Math.max(1, Math.round(h * 0.14)))
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.30 });
      const mouthY = topY + Math.max(1, Math.round(h * 0.10));
      node.ellipse(x + w / 2, mouthY, w * 0.42, Math.max(1, Math.round(h * 0.12)))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.5 : 0.35) });
      // Pens inside: three stems, two caps, deterministic tilt.
      const stems = [
        { dx: -0.22, top: 0.74, color: c.accent || 0x4f46e5 },
        { dx: 0.04, top: 0.88, color: 0xb45309 },
        { dx: 0.24, top: 0.62, color: 0x0f766e },
      ];
      stems.forEach((stem, i) => {
        const sx = x + w / 2 + stem.dx * w;
        const sy = frontY - Math.round(h * 0.30);
        node.rect(sx, sy, Math.max(1, Math.round(w * 0.10)), Math.max(2, Math.round(h * 0.42)))
          .fill({ color: stem.color, alpha: dark ? 0.72 : 0.85 });
        node.rect(sx, sy, Math.max(1, Math.round(w * 0.10)), 1)
          .fill({ color: 0xffffff, alpha: dark ? 0.20 : 0.45 });
        if (i === 1) {
          node.rect(sx - 1, sy - 1, Math.max(2, Math.round(w * 0.16)), 1)
            .fill({ color: 0x000000, alpha: 0.25 });
        }
      });
    } else if (detail === 'mug') {
      // P0-C mug: body, lit rim, dark interior ellipse, a handle in two
      // segments on the right, and a shadow on the desk under it.
      node.ellipse(x + w * 0.5, topY + d * 0.55, w * 0.62, d * 0.30)
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.12 });
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      // Vertical glaze highlight: a mug is round, so it needs a cylinder read.
      node.rect(x + Math.max(1, w * 0.12), frontY + 1, Math.max(1, w * 0.14), h - 2)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.38 });
      node.rect(x + w - Math.max(1, w * 0.18), frontY + 1, Math.max(1, w * 0.12), h - 2)
        .fill({ color: 0x000000, alpha: dark ? 0.24 : 0.10 });
      // Rim + coffee surface.
      const rimY = topY + Math.max(1, Math.round(d * 0.18));
      node.ellipse(x + w / 2, rimY, w * 0.52, Math.max(1, Math.round(d * 0.34)))
        .fill({ color: tone.front });
      node.ellipse(x + w / 2, rimY, w * 0.40, Math.max(1, Math.round(d * 0.26)))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.42 : 0.30) });
      node.ellipse(x + w / 2, rimY, w * 0.52, Math.max(1, Math.round(d * 0.34)))
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.30 : 0.65 });
      // Handle: two segments on the right side.
      const hx = x + w;
      node.moveTo(hx - 1, frontY + h * 0.28).lineTo(hx + Math.max(1, w * 0.22), frontY + h * 0.34)
        .stroke({ width: Math.max(1, Math.round(w * 0.10)), color: tone.front });
      node.moveTo(hx + Math.max(1, w * 0.22), frontY + h * 0.34).lineTo(hx - 1, frontY + h * 0.66)
        .stroke({ width: Math.max(1, Math.round(w * 0.10)), color: tone.front });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    } else if (detail === 'lamp-base') {
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.52, d * 0.5).fill({ color: tone.top });
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.52, d * 0.5)
        .stroke({ width: 1, color: tone.edge, alpha: 0.5 });
      node.ellipse(x + w / 2, topY + d * 0.5 - 1, w * 0.26, d * 0.2)
        .fill({ color: tone.lip, alpha: dark ? 0.18 : 0.5 });
    } else if (detail === 'lamp-pole') {
      node.rect(x, frontY, Math.max(1, w * 0.4), h).fill({ color: tone.lip, alpha: dark ? 0.2 : 0.55 });
      node.rect(x + w - Math.max(1, w * 0.3), frontY, Math.max(1, w * 0.3), h)
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    } else if (detail === 'lamp-shade') {
      // 圆台形灯罩（2026-10-28 第二轮）。上一版是"梯形 + 一条亮带"，放大后
      // 看起来像一块米色方块。真实布艺灯罩的关键：上口比下口窄（正梯形）、
      // 底部开口是**椭圆**（能看到罩内的暖光）、罩体有竖向褶皱、下沿一圈亮边。
      const topW = w * 0.62;
      const topInset = (w - topW) / 2;
      const shadeTop = frontY;
      const shadeBot = frontY + h;
      // 灯罩投在墙/地上的暖光晕（罩体之外）。
      node.ellipse(x + w / 2, shadeBot - h * 0.1, w * 0.95, h * 0.75)
        .fill({ color: tone.top, alpha: dark ? 0.08 : 0.12 });
      // 罩体：正梯形（上窄下宽）。
      node.moveTo(x + topInset, shadeTop)
        .lineTo(x + w - topInset, shadeTop)
        .lineTo(x + w, shadeBot)
        .lineTo(x, shadeBot)
        .closePath()
        .fill({ color: tone.front, alpha: 0.98 });
      // 上口：一条窄的受光边（罩顶收口）。
      node.rect(x + topInset, shadeTop, topW, Math.max(1, Math.round(h * 0.10)))
        .fill({ color: tone.top, alpha: dark ? 0.45 : 0.95 });
      // 底部开口：**不画**开孔椭圆（2026-10-28 第二轮第二次修正）。
      // 这个灯罩只有约 52×19px；任何"开口椭圆"在这里都退化成一只扁平的
      // 亮色圆盘（一次像飞碟、一次像盘子），因为垂直半径只有 ~5px。
      // 真实小灯罩从正面偏上看，看到的是：罩底一圈更暗的布沿 + 内部一点暖光。
      // 所以只用一条暗色布沿 + 一条窄暖光带，不画椭圆。
      const hemH = Math.max(2, Math.round(h * 0.14));
      node.rect(x + Math.round(w * 0.03), shadeBot - hemH, w - Math.round(w * 0.06), hemH)
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.30 : 0.16) });
      // 内部暖光：紧贴布沿上方的一条窄亮带（比罩体亮，比顶部受光带暗）。
      node.rect(x + Math.round(w * 0.08), shadeBot - hemH - 2, w - Math.round(w * 0.16), 2)
        .fill({ color: mixHex(tone.top, 0xffffff, dark ? 0.10 : 0.30), alpha: dark ? 0.55 : 0.80 });
      node.rect(x + Math.round(w * 0.03), shadeBot - 1, w - Math.round(w * 0.06), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.24 : 0.10 });
      // 竖向褶皱：3 条很淡的竖线（布艺的垂坠感），不能画成扇骨。
      for (let i = 1; i <= 3; i += 1) {
        const t = i / 4;
        const tx = x + topInset + topW * t;
        const bx = x + w * t;
        node.moveTo(tx, shadeTop + Math.round(h * 0.16))
          .lineTo(bx, shadeBot - hemH)
          .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.10 : 0.07 });
      }
      // 下沿高光 + 底部投影，让罩体有厚度。
      node.rect(x, shadeBot - 2, w, 1).fill({ color: 0xffffff, alpha: dark ? 0.10 : 0.26 });
      node.ellipse(x + w / 2, shadeBot + 1, w * 0.50, Math.max(1, d * 0.16))
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.08 });
    } else if (detail === 'chair-back') {
      // 2026-10-28 第二轮：按旧贴图素材 prop-chair-back.png 的**背面视角**重建。
      //
      // 参考素材的读法（1024² 白底图）：一块上宽下窄的梯形背框（顶角圆角
      // 明显、底部收进坐垫）、框内一整片微凹的布面、两侧各一根竖直扶手柱
      // 顶着圆角扶手垫、背框下沿一道横向收边、中间气压杆、五星脚 + 5 个滚轮。
      //
      // 上一版画的是"深色网面 + 交叉斜纹 + 头枕横杆"，在多色家具里像第二个
      // 显示器；而且靠背只有 40px 宽，被 168px 宽的角色完全挡住。现在靠背
      // 94px 宽、且比角色两侧各露出约 27px，才读得出"她坐在一把椅子上"。
      const pad = Math.max(2, Math.round(w * 0.045));
      const rTop = Math.max(4, w * 0.10);
      // 外框：上宽下窄的梯形（背面视角最关键的一条轮廓）。
      const insetBottom = w * 0.055;
      const bodyPath = () => node.moveTo(x + rTop, frontY)
        .lineTo(x + w - rTop, frontY)
        .lineTo(x + w, frontY + rTop)
        .lineTo(x + w - insetBottom, frontY + h)
        .lineTo(x + insetBottom, frontY + h)
        .lineTo(x, frontY + rTop)
        .closePath();
      bodyPath().fill({ color: tone.front });
      // 框内布面：四周内缩、略暗，带一条横向中缝。
      const innerX = x + pad + 1;
      const innerW = Math.max(3, w - (pad + 1) * 2);
      const innerY = frontY + pad + 1;
      const innerH = Math.max(3, h - (pad + 1) * 2.2);
      node.roundRect(innerX, innerY, innerW, innerH, Math.max(2, rTop * 0.7))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.30 : 0.20) });
      // 布面穹顶：中线左右各一条更亮的竖带，做出绷紧的布。
      node.roundRect(innerX + 1, innerY + 1, Math.max(2, innerW * 0.42), Math.max(2, innerH - 2), 2)
        .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.10 : 0.16), alpha: dark ? 0.30 : 0.55 });
      node.roundRect(innerX + innerW * 0.54, innerY + 1, Math.max(2, innerW * 0.42), Math.max(2, innerH - 2), 2)
        .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.06 : 0.10), alpha: dark ? 0.22 : 0.38 });
      // 中缝：比布料暗一档的 1px 竖线，从框顶到底。
      node.rect(x + w / 2 - 0.5, innerY + 1, 1, Math.max(1, innerH - 2))
        .fill({ color: tone.edge, alpha: dark ? 0.40 : 0.26 });
      // 外框倒角：顶边受光最亮，左右两侧亮/暗对立（光来自窗侧 = 左上）。
      node.moveTo(x + rTop, frontY + 1)
        .lineTo(x + w - rTop, frontY + 1)
        .stroke({ width: Math.max(1, pad * 0.7), color: tone.lip, alpha: dark ? 0.20 : 0.62 });
      node.rect(x + 1, frontY + rTop, Math.max(1, pad * 0.5), Math.max(2, h - rTop * 2))
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.42 });
      node.rect(x + w - Math.max(1, pad * 0.5), frontY + rTop, Math.max(1, pad * 0.5), Math.max(2, h - rTop * 2))
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.16 });
      // 背框下沿收边：一道阴影 + 一道亮线，把"靠背"和下面的坐垫分开。
      const hemH = Math.max(2, Math.round(h * 0.07));
      node.rect(x + insetBottom, frontY + h - hemH, w - insetBottom * 2, hemH)
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.34 : 0.22) });
      node.rect(x + insetBottom, frontY + h - hemH, w - insetBottom * 2, 1)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.34 });
      // 整体轮廓线，让它在浅色背景上有边界。
      bodyPath().stroke({ width: 1, color: tone.edge, alpha: dark ? 0.45 : 0.28 });
    } else if (detail === 'chair-arm') {
      // 扶手：一根竖柱 + 一块圆角扶手垫（参考素材里最显眼的侧面特征）。
      // 画在角色之后，所以只会从角色两侧露出来。
      const postW = Math.max(2, Math.round(w * 0.40));
      const postX = x + (w - postW) / 2;
      const padH = Math.max(2, Math.round(h * 0.16));
      // 柱
      node.rect(postX, frontY + padH, postW, Math.max(2, h - padH)).fill({ color: tone.front });
      node.rect(postX, frontY + padH, Math.max(1, postW * 0.35), Math.max(2, h - padH))
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.36 });
      node.rect(postX + postW - Math.max(1, postW * 0.3), frontY + padH, Math.max(1, postW * 0.3), Math.max(2, h - padH))
        .fill({ color: 0x000000, alpha: dark ? 0.28 : 0.14 });
      // 扶手垫：圆角、顶部受光、底部出阴影
      node.roundRect(x, frontY, w, padH + 2, Math.max(2, padH * 0.55)).fill({ color: tone.top });
      node.roundRect(x + 1, frontY + 1, Math.max(1, w - 2), Math.max(1, Math.round(padH * 0.5)), 2)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.42 });
      node.rect(x + 1, frontY + padH + 1, Math.max(1, w - 2), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.15 });
    } else if (detail === 'cushion') {
      // P0-D seat pan. Three separate defects were fixed here (2026-10-28):
      //
      //  1. TONE TRAP: for `chairBack` the lit top and the front shade are the
      //     SAME colour, so a "dome" built from tone.top adds nothing.
      //  2. A big rounded rect with a dark rim reads as a *box lid*.
      //  3. A LIGHT pad under a DARK mesh back reads as two unrelated objects.
      //
      // The fix is a trapezoid (a real seat pan narrows toward the back), in
      // the same dark family as the backrest, with a sheen only on the crown
      // and a curved waterfall over the front lip.
      const narrow = Math.max(2, w * 0.13);       // taper at the rear edge
      const r = Math.max(2.5, Math.min(w, d) * 0.30);
      const shell = mixHex(tone.front, 0x000000, dark ? 0.34 : 0.22);
      const crown = mixHex(tone.front, 0xffffff, dark ? 0.12 : 0.20);
      const crownLit = mixHex(tone.front, 0xffffff, dark ? 0.18 : 0.30);
      // Path helper: rear edge inset by `taper`, front edge full width.
      // Returns `node` so the caller can chain .fill()/.stroke().
      const panPath = (x0, y0, ww, dd, taper) => node.moveTo(x0 + taper, y0)
        .lineTo(x0 + ww - taper, y0)
        .lineTo(x0 + ww - taper * 0.25, y0 + dd * 0.55)
        .lineTo(x0 + ww, y0 + dd - r * 0.4)
        .lineTo(x0 + ww - r, y0 + dd)
        .lineTo(x0 + r, y0 + dd)
        .lineTo(x0, y0 + dd - r * 0.4)
        .lineTo(x0 + taper * 0.25, y0 + dd * 0.55)
        .closePath();
      // Seat shell (dark, same family as the mesh back).
      panPath(x, topY, w, d, narrow).fill({ color: shell });
      // Upholstered crown: concentric insets stepping toward the sheen.
      for (let i = 1; i <= 3; i += 1) {
        const inset = i * 2.1;
        if (w - inset * 2 < 4 || d - inset * 2 < 3) break;
        panPath(x + inset, topY + inset * 0.7, w - inset * 2, d - inset * 1.4, narrow * 0.82)
          .fill({ color: i === 3 ? crownLit : crown, alpha: dark ? 0.55 : 0.85 });
      }
      // Backrest occlusion: the rear third sits in the back's shadow.
      node.moveTo(x + narrow, topY)
        .lineTo(x + w - narrow, topY)
        .lineTo(x + w - narrow * 0.86, topY + d * 0.26)
        .lineTo(x + narrow * 1.14, topY + d * 0.26)
        .closePath()
        .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.15 });
      // Waterfall front: the pad curls over the shell, brightest where it
      // catches the window light.
      node.roundRect(x + 1, frontY, Math.max(1, w - 2), Math.max(2, h), Math.max(1, r * 0.5))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.10 : 0.05) });
      node.roundRect(x + 3, frontY, Math.max(1, w - 6), 1, 1)
        .fill({ color: crownLit, alpha: dark ? 0.45 : 0.80 });
      // Silhouette rim: keeps the pad off the floor behind it.
      panPath(x, topY, w, d, narrow).stroke({ width: 1, color: 0x000000, alpha: dark ? 0.36 : 0.22 });
      node.rect(x + 2, frontY + h - 1, Math.max(1, w - 4), 1).fill({ color: 0x000000, alpha: dark ? 0.32 : 0.16 });
    } else if (detail === 'gas-lift') {
      // Gas cylinder: two diameter steps, a dust cover at the top, a lit side
      // and a shaded side. A single grey stick is what the eye rejects.
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      const lit = Math.max(1, Math.round(w * 0.34));
      node.rect(x, frontY, lit, h).fill({ color: tone.lip, alpha: dark ? 0.20 : 0.55 });
      node.rect(x + w - lit, frontY, lit, h).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
      // Dust cover / upper sleeve.
      const sleeveH = Math.max(2, Math.round(h * 0.16));
      node.rect(x - 1, frontY, w + 2, sleeveH).fill({ color: tone.top });
      node.rect(x - 1, frontY + sleeveH, w + 2, 1).fill({ color: 0x000000, alpha: dark ? 0.35 : 0.18 });
    } else if (detail === 'counter-doors') {
      // P1: four doors with real separations, recessed panel edges, bar pulls,
      // and a 4px recessed plinth. Three doors with two hairlines was the
      // "grey wardrobe" look.
      const cols = 4;
      const plinth = Math.max(2, Math.round(h * 0.06));
      const bodyH = Math.max(2, h - plinth);
      for (let i = 0; i < cols; i += 1) {
        const dx = x + (w * i) / cols;
        const dw = w / cols;
        // Door gap: 2px dark + 1px lit lip below it (the carcass edge).
        if (i > 0) {
          node.rect(dx - 1, frontY + 2, 2, bodyH - 4).fill({ color: 0x000000, alpha: dark ? 0.42 : 0.22 });
          node.rect(dx + 1, frontY + 2, 1, bodyH - 4).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
        }
        // Recessed panel: a 1px darker inset on all four sides of the door.
        node.rect(dx + 2, frontY + 3, Math.max(1, dw - 4), 1).fill({ color: 0x000000, alpha: dark ? 0.26 : 0.11 });
        node.rect(dx + 2, frontY + bodyH - 4, Math.max(1, dw - 4), 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.22 });
        // Bar pull: horizontal, with a lit top edge and a dark drop shadow.
        const pullW = Math.max(5, Math.round(dw * 0.42));
        const pullX = dx + (dw - pullW) / 2;
        const pullY = frontY + bodyH * 0.22;
        node.rect(pullX, pullY, pullW, 2).fill({ color: officeTone('metal').front });
        node.rect(pullX, pullY, pullW, 1).fill({ color: officeTone('metal').lip, alpha: dark ? 0.30 : 0.80 });
        node.rect(pullX, pullY + 2, pullW, 1).fill({ color: 0x000000, alpha: dark ? 0.32 : 0.15 });
      }
      // Recessed toe kick.
      node.rect(x, frontY + bodyH, w, plinth).fill({ color: 0x000000, alpha: dark ? 0.36 : 0.18 });
      node.rect(x, frontY + bodyH, w, 1).fill({ color: 0x000000, alpha: dark ? 0.45 : 0.24 });
    } else if (detail === 'counter-top') {
      // Stone slab: specks, a 1px chamfer on the front, a lit back edge and a
      // shaded front thickness. Stone reads through *speckle*, not colour.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.55 });
      stoneSpecks(node, part, tone, dark);
      const frontThick = Math.max(2, Math.round(h * 0.55));
      node.rect(x, frontY + h - frontThick, w, frontThick).fill({ color: tone.edge, alpha: dark ? 0.42 : 0.30 });
      node.rect(x, frontY + h - frontThick, w, 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.40 });
      // Chamfer highlight along the two front corners.
      node.rect(x, frontY + h - frontThick, 1, frontThick).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
      node.rect(x + w - 1, frontY + h - frontThick, 1, frontThick).fill({ color: 0x000000, alpha: dark ? 0.24 : 0.10 });
    } else if (detail === 'upstand') {
      // Tiled upstand against the wall: one lit top line, one shadow at the
      // bottom where it meets the slab.
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      node.rect(x + 1, topY, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.14 : 0.50 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
    } else if (detail === 'faucet-base') {
      node.ellipse(x + w / 2, topY + d * 0.5, w * 0.62, Math.max(1, d * 0.5))
        .fill({ color: tone.front });
      node.ellipse(x + w / 2, topY + d * 0.5 - 0.5, w * 0.36, Math.max(1, d * 0.26))
        .fill({ color: tone.lip, alpha: dark ? 0.20 : 0.60 });
    } else if (detail === 'faucet-riser') {
      // Vertical pipe: lit left third, shaded right third.
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      node.rect(x, frontY, Math.max(1, w * 0.36), h).fill({ color: tone.lip, alpha: dark ? 0.24 : 0.70 });
      node.rect(x + w - Math.max(1, w * 0.30), frontY, Math.max(1, w * 0.30), h)
        .fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
      // Collar at the base.
      node.rect(x - 1, frontY + h - 2, w + 2, 2).fill({ color: tone.top });
    } else if (detail === 'faucet-spout') {
      // Horizontal spout with a downturn nozzle: the L-bend is what makes a
      // faucet a faucet (a straight bar reads as a handle).
      const armH = Math.max(2, Math.round(h * 0.55));
      node.rect(x, frontY, w, armH).fill({ color: tone.front });
      node.rect(x, frontY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.24 : 0.70 });
      // Nozzle: short vertical drop at the far end.
      const nW = Math.max(2, Math.round(w * 0.30));
      node.rect(x + w - nW, frontY + armH, nW, Math.max(2, Math.round(h * 0.75)))
        .fill({ color: tone.front });
      node.rect(x + w - nW, frontY + armH, 1, Math.max(2, Math.round(h * 0.75)))
        .fill({ color: tone.lip, alpha: dark ? 0.18 : 0.50 });
      // Dark opening at the nozzle tip.
      node.rect(x + w - nW, frontY + armH + Math.max(1, Math.round(h * 0.7)), nW, 1)
        .fill({ color: 0x000000, alpha: dark ? 0.5 : 0.28 });
      node.rect(x, frontY + armH - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    } else if (detail === 'sink') {
      // Recessed basin: a dark well, an inner wall that is lighter at the top
      // (the basin walls catch light), a drain with a cross, and a lit rim.
      const ix = x + inset;
      const iy = topY + inset * 0.9;
      const iw = Math.max(2, w - inset * 2);
      const id = Math.max(2, d - inset * 1.8);
      node.roundRect(ix, iy, iw, id, 3).fill({ color: mixHex(tone.front, 0x000000, dark ? 0.55 : 0.38) });
      // Inner wall: lighter band on the back edge = the basin has depth.
      node.roundRect(ix + 1, iy + 1, iw - 2, Math.max(1, id * 0.22), 2)
        .fill({ color: tone.front, alpha: dark ? 0.30 : 0.45 });
      // Side walls.
      node.rect(ix + 1, iy + 1, 1, id - 2).fill({ color: tone.front, alpha: dark ? 0.22 : 0.35 });
      node.rect(ix + iw - 2, iy + 1, 1, id - 2).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.16 });
      // Drain: circle + cross.
      const dx2 = ix + iw / 2;
      const dy2 = iy + id * 0.62;
      const dr = Math.max(1.5, Math.min(iw, id) * 0.09);
      node.circle(dx2, dy2, dr).fill({ color: mixHex(tone.front, 0x000000, 0.45) });
      node.rect(dx2 - dr, dy2, dr * 2, 1).fill({ color: tone.lip, alpha: 0.5 });
      node.rect(dx2, dy2 - dr, 1, dr * 2).fill({ color: tone.lip, alpha: 0.5 });
      // Lit rim: 1px highlight all round, brighter on the window side.
      node.roundRect(ix, iy, iw, id, 3).stroke({ width: 1, color: tone.lip, alpha: dark ? 0.20 : 0.55 });
    } else if (detail === 'machine') {
      // Espresso machine: body, a lit front panel, group head, two buttons, a
      // drip tray with grate lines, and a milk-frother wand on the side.
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      // Lit top / control panel.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(2, Math.round(h * 0.20)))
        .fill({ color: tone.top, alpha: dark ? 0.55 : 0.95 });
      // Buttons: two small dots on the panel.
      for (let i = 0; i < 2; i += 1) {
        node.circle(x + w * (0.30 + i * 0.40), topY + Math.max(2, h * 0.11), Math.max(1, Math.min(w, h) * 0.045))
          .fill({ color: i === 0 ? 0x9fe8b4 : 0xd98a8a, alpha: dark ? 0.9 : 0.8 });
      }
      // Group head: the portafilter boss, protruding from the front.
      const ghW = Math.max(3, Math.round(w * 0.34));
      const ghH = Math.max(3, Math.round(h * 0.16));
      node.rect(x + (w - ghW) / 2, frontY + h * 0.40, ghW, ghH).fill({ color: tone.edge });
      node.rect(x + (w - ghW) / 2, frontY + h * 0.40, ghW, 1).fill({ color: tone.lip, alpha: dark ? 0.16 : 0.45 });
      node.rect(x + (w - ghW) / 2 - 2, frontY + h * 0.40 + ghH - 1, ghW + 4, 2)
        .fill({ color: 0x000000, alpha: dark ? 0.35 : 0.18 });
      // Drip tray: recessed bar with grate lines.
      const trayY = frontY + h - Math.max(4, Math.round(h * 0.14));
      node.rect(x + 2, trayY, Math.max(1, w - 4), Math.max(2, h - (trayY - frontY)))
        .fill({ color: tone.edge, alpha: 0.85 });
      for (let i = 0; i < 4; i += 1) {
        node.rect(x + 4 + i * ((w - 8) / 4), trayY + 1, 1, Math.max(1, (h - (trayY - frontY)) - 2))
          .fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
      }
      // Milk-frother wand on the right edge.
      node.rect(x + w - 2, frontY + h * 0.46, 2, Math.max(3, h * 0.30)).fill({ color: officeTone('metal').front });
      node.rect(x + w - 2, frontY + h * 0.46, 1, Math.max(3, h * 0.30)).fill({ color: officeTone('metal').lip, alpha: 0.6 });
    } else if (detail === 'espresso-cup') {
      // A cup on the drip tray: body, dark rim, a handle.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(1, h - 1)).fill({ color: tone.front });
      node.ellipse(x + w / 2, topY + Math.max(1, d * 0.22), w * 0.34, Math.max(1, d * 0.20))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.45 : 0.32) });
      node.rect(x + w, topY + h * 0.32, Math.max(1, w * 0.14), Math.max(1, h * 0.34))
        .fill({ color: tone.front });
    } else if (detail === 'cutting-board') {
      // 砧板：一块薄木条 + 圆孔 + 木纹。
      node.roundRect(x, topY, w, Math.max(2, d), Math.max(1, d * 0.4)).fill({ color: tone.top });
      woodGrain(node, part, tone, dark);
      // 挂孔
      node.circle(x + w * 0.86, topY + d * 0.5, Math.max(1, d * 0.20))
        .fill({ color: mixHex(tone.front, 0x000000, 0.45) });
      // 前沿厚度
      node.rect(x, topY + d - 1, w, 1).fill({ color: tone.edge, alpha: dark ? 0.4 : 0.3 });
      node.rect(x, topY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.45 });
    } else if (detail === 'jar') {
      // 调料罐：罐身 + 盖子 + 标签 + 高光。矮而窄，只占十几像素。
      node.rect(x + 1, frontY, Math.max(1, w - 2), h).fill({ color: tone.front });
      // 受光面
      node.rect(x + 1, frontY, Math.max(1, Math.round(w * 0.30)), h)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.42 });
      // 盖
      const lidH = Math.max(1, Math.round(h * 0.22));
      node.rect(x, frontY, w, lidH).fill({ color: officeTone('metal').front });
      node.rect(x, frontY, w, 1).fill({ color: officeTone('metal').lip, alpha: dark ? 0.2 : 0.7 });
      // 标签
      node.rect(x + 2, frontY + lidH + Math.max(1, h * 0.22), Math.max(1, w - 4), Math.max(1, h * 0.26))
        .fill({ color: 0xffffff, alpha: dark ? 0.10 : 0.34 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.3 : 0.14 });
    } else if (detail === 'upper-cabinet') {
      // 吊柜（2026-10-28 第四轮）：两块门 + 门缝 + 拉手 + 底部收边 + 顶面。
      // 顶面必须画（z 抬升后从上往下看得到），但只画一条窄带就够了。
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      // 顶面：一条受光窄带
      node.rect(x, topY, w, Math.max(2, Math.round(d * 0.55)))
        .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.10 : 0.26) });
      node.rect(x, topY + Math.max(2, Math.round(d * 0.55)), w, 1)
        .fill({ color: tone.edge, alpha: dark ? 0.4 : 0.28 });
      // 两扇门：中间一道门缝（2px 暗 + 1px 亮）
      const mid = x + w / 2;
      node.rect(mid - 1, frontY + 1, 2, Math.max(1, h - 2)).fill({ color: 0x000000, alpha: dark ? 0.42 : 0.22 });
      node.rect(mid + 1, frontY + 1, 1, Math.max(1, h - 2)).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
      // 每扇门的内凹面板 + 竖向拉手
      for (const [dx, dw] of [[x + 2, w / 2 - 4], [mid + 2, w / 2 - 4]]) {
        if (dw > 4) {
          node.rect(dx, frontY + 2, dw, 1).fill({ color: 0x000000, alpha: dark ? 0.26 : 0.11 });
          node.rect(dx, frontY + h - 3, dw, 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.22 });
        }
      }
      // 拉手：两扇门靠中缝一侧各一根竖条
      for (const hx of [mid - 6, mid + 3]) {
        node.rect(hx, frontY + h * 0.42, 3, Math.max(4, h * 0.30))
          .fill({ color: officeTone('metal').front });
        node.rect(hx, frontY + h * 0.42, 1, Math.max(4, h * 0.30))
          .fill({ color: officeTone('metal').lip, alpha: dark ? 0.28 : 0.80 });
      }
      // 底部收边 + 顶底阴影
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.40 : 0.20 });
      node.rect(x, frontY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.40 });
    } else if (detail === 'dish-rack') {
      // 沥水架：一个托盘 + 3 条竖栅 + 两片立着的碟子。
      node.rect(x, frontY, w, Math.max(2, Math.round(h * 0.30))).fill({ color: tone.front });
      node.rect(x, frontY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.16 : 0.55 });
      for (let i = 1; i <= 3; i += 1) {
        node.rect(x + (w * i) / 4, frontY + Math.round(h * 0.30), 1, Math.max(1, Math.round(h * 0.55)))
          .fill({ color: tone.edge, alpha: dark ? 0.35 : 0.24 });
      }
      // 两片碟子：竖椭圆
      for (let i = 0; i < 2; i += 1) {
        node.ellipse(x + w * (0.34 + i * 0.32), topY + d * 0.55,
          Math.max(1.5, w * 0.16), Math.max(2, d * 0.42))
          .fill({ color: mixHex(tone.front, 0xffffff, dark ? 0.10 : 0.35) });
      }
    } else if (detail === 'kettle') {
      // 电热水壶：壶身（梯形）+ 壶盖 + 把手 + 底座。
      const flare = Math.max(1, w * 0.08);
      node.moveTo(x + flare, frontY)
        .lineTo(x + w - flare, frontY)
        .lineTo(x + w, frontY + h)
        .lineTo(x, frontY + h)
        .closePath()
        .fill({ color: tone.front });
      // 受光面
      node.moveTo(x + flare, frontY).lineTo(x + flare + w * 0.30, frontY)
        .lineTo(x + w * 0.30, frontY + h).lineTo(x, frontY + h)
        .closePath().fill({ color: tone.lip, alpha: dark ? 0.14 : 0.40 });
      // 壶盖
      node.ellipse(x + w / 2, topY + Math.max(1, d * 0.30), w * 0.44, Math.max(1, d * 0.26))
        .fill({ color: tone.top });
      // 把手：右侧两段
      node.moveTo(x + w - 1, frontY + h * 0.22).lineTo(x + w + Math.max(2, w * 0.20), frontY + h * 0.34)
        .stroke({ width: Math.max(1, w * 0.10), color: tone.edge });
      node.moveTo(x + w + Math.max(2, w * 0.20), frontY + h * 0.34).lineTo(x + w - 1, frontY + h * 0.62)
        .stroke({ width: Math.max(1, w * 0.10), color: tone.edge });
      // 底座
      node.rect(x - 1, frontY + h - 2, w + 2, 2).fill({ color: tone.edge, alpha: dark ? 0.6 : 0.45 });
    } else if (detail === 'fridge') {
      // Appliance read: two door split with a real gap (shadow + lit lip),
      // two vertical bar handles with highlights, a brand plate, a plinth and
      // a top edge that catches the light.
      //
      // The review measured this face as 64% one flat colour — "a blank
      // vertical rectangle" in the silhouette test. Brushed-metal sheen first,
      // then the door geometry on top of it.
      drawMetalSurface(node, part, tone, dark, x, frontY, w, h);
      // Top edge.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.45 });
      // Door split: freezer above, fridge below.
      const split = frontY + h * 0.42;
      node.rect(x + 1, split, w - 2, 2).fill({ color: 0x000000, alpha: dark ? 0.48 : 0.26 });
      node.rect(x + 1, split + 2, w - 2, 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.34 });
      // Vertical bar handles, one per door, on the same side.
      const hW = Math.max(2, Math.round(w * 0.055));
      const hX = x + w * 0.14;
      const handles = [
        { y0: frontY + h * 0.10, len: h * 0.16 },
        { y0: split + h * 0.06, len: h * 0.20 },
      ];
      handles.forEach((spec) => {
        node.rect(hX, spec.y0, hW, spec.len).fill({ color: officeTone('metal').front });
        node.rect(hX, spec.y0, Math.max(1, hW * 0.4), spec.len)
          .fill({ color: officeTone('metal').lip, alpha: dark ? 0.28 : 0.85 });
        node.rect(hX + hW, spec.y0, 1, spec.len).fill({ color: 0x000000, alpha: dark ? 0.32 : 0.16 });
      });
      // Brand plate: a small low-contrast rectangle, upper area.
      node.rect(x + w * 0.52, frontY + h * 0.14, Math.max(3, w * 0.16), Math.max(2, h * 0.020))
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.40 });
      // Recessed plinth.
      node.rect(x + 1, frontY + h - Math.max(3, h * 0.03), w - 2, Math.max(2, h * 0.03))
        .fill({ color: 0x000000, alpha: dark ? 0.40 : 0.20 });
    } else if (detail === 'shelf') {
      // Wall shelf: 2px board, lit top, shadowed underside, two L brackets.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.14 : 0.50 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.40 : 0.20 });
      // Brackets at both ends: horizontal arm + vertical leg.
      const bW = Math.max(3, Math.round(w * 0.045));
      for (const bx of [x + Math.max(2, w * 0.05), x + w - Math.max(2, w * 0.05) - bW]) {
        node.rect(bx, frontY + h, bW, 2).fill({ color: officeTone('metal').front });
        node.rect(bx + bW - 2, frontY + h, 2, Math.max(3, h * 2.2)).fill({ color: officeTone('metal').front, alpha: 0.9 });
      }
    } else if (detail === 'cup') {
      // Shelf cup: body, dark mouth, handle, 1px shadow on the shelf.
      node.rect(x, topY + Math.max(1, d * 0.28), w, Math.max(2, h - d * 0.28)).fill({ color: tone.front });
      node.ellipse(x + w / 2, topY + Math.max(1, d * 0.28), w * 0.5, Math.max(1, d * 0.22))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.45 : 0.30) });
      node.ellipse(x + w / 2, topY + Math.max(1, d * 0.28), w * 0.5, Math.max(1, d * 0.22))
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.20 : 0.55 });
      node.rect(x + w, topY + Math.max(1, d * 0.34), Math.max(1, w * 0.16), Math.max(1, h * 0.34))
        .fill({ color: tone.front });
      node.rect(x, topY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.35 : 0.16 });
    } else if (detail === 'sofa-leg') {
      // Short block foot with a lit top and a floor shadow.
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      node.rect(x, frontY, w, 1).fill({ color: tone.lip, alpha: dark ? 0.14 : 0.40 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.36 : 0.18 });
    } else if (detail === 'sofa-base') {
      // Plinth: dark, recessed, with a lit top lip under the seat cushions.
      node.rect(x + 2, frontY + 2, Math.max(1, w - 4), 1).fill({ color: 0x000000, alpha: 0.14 });
      node.rect(x, frontY + h - 2, w, 2).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.10 });
      node.rect(x, topY + 1, w, 1).fill({ color: tone.lip, alpha: dark ? 0.08 : 0.22 });
    } else if (detail === 'sofa-back') {
      // 2026-10-28 第八轮：靠背原本在中央画了一条**深色竖缝**（alpha 0.20–0.30），
      // 在 1:1 下像把靠背劈成两块板。真实双人沙发的靠背是两片软垫**贴在一起**，
      // 缝是浅压痕而不是黑线。所以：缝改成极淡的 1px、两侧各加一条受光肋，
      // 顶部圆角收边、底边压出与坐垫的接触阴影。
      const r = Math.max(3, Math.min(w, h) * 0.14);
      node.roundRect(x, frontY, w, Math.max(1, h + inset), r).fill({ color: tone.front });
      // 顶部圆角受光（靠背上沿滚边）
      node.roundRect(x + 1, frontY + 1, Math.max(1, w - 2), Math.max(2, Math.round(h * 0.14)), r * 0.8)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.32 });
      // 中缝：浅压痕（两条 1px，一亮一暗，模拟两片垫子贴合）
      const seamX = x + w * 0.5;
      node.rect(seamX, frontY + Math.max(3, h * 0.22), 1, Math.max(2, h * 0.58))
        .fill({ color: tone.edge, alpha: dark ? 0.16 : 0.10 });
      node.rect(seamX + 1, frontY + Math.max(3, h * 0.22), 1, Math.max(2, h * 0.58))
        .fill({ color: tone.lip, alpha: dark ? 0.08 : 0.18 });
      // 两片垫子各自微微鼓起：中央偏外各一条淡亮带
      for (const side of [-1, 1]) {
        const bx = x + w * (side < 0 ? 0.26 : 0.74);
        node.roundRect(bx - Math.max(2, w * 0.10), frontY + h * 0.26,
          Math.max(2, w * 0.20), Math.max(2, h * 0.44), 2)
          .fill({ color: tone.lip, alpha: dark ? 0.06 : 0.14 });
      }
      // 与坐垫的接触阴影
      node.rect(x, frontY + h - Math.max(2, Math.round(h * 0.10)), w, Math.max(2, Math.round(h * 0.10)))
        .fill({ color: 0x000000, alpha: dark ? 0.24 : 0.11 });
      // 顶面：一条受光窄边
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.46 });
    } else if (detail === 'sofa-skirt') {
      // Skirt: soft vertical folds, dark, with a lit top edge.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
      const folds = 5;
      for (let i = 1; i < folds; i += 1) {
        node.rect(x + (w * i) / folds, frontY + 1, 1, Math.max(1, h - 2))
          .fill({ color: 0x000000, alpha: dark ? 0.18 : 0.08 });
      }
      node.rect(x, frontY + h - 2, w, 2).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.14 });
    } else if (detail === 'sofa-arm') {
      // 2026-10-29 第十轮（用户："沙发扶手仍是硬方块，可以改成圆柱滚边"）。
      //
      // 真实布艺沙发的扶手是一个**圆柱滚边**：正视看是一段半圆（顶盖），
      // 下面接一段垂直的扶手立面。原来整块画成一个圆角矩形，所以读起来是方块。
      //
      // 尺寸（实测）：扶手 21×37px。所以：
      //   - 上半段 roll 直径 = 扶手宽 = 21px（半高 10.5px）
      //   - 下半段 27px 垂直立面
      // 圆柱的体积靠三样东西：顶面椭圆、圆柱侧面的横向明暗渐变（左亮右暗）、
      // 以及底部与沙发座面相接的接触阴影。
      // 关键几何（实测）：扶手 w=21px、正面高 36.5px、**顶面深 56.7px**。
      // 顶面比宽度大得多，所以**不能画正圆**（正圆会被顶面拉扁、且盖住立面）。
      // 正确的 2.5D 读法：顶面上是一条**纵向圆柱带**（从后到前贯穿整个扶手深度），
      // 它的正面表现就是立在顶面前后方向的一根「圆管」，宽度 = 扶手宽。
      const tubeR = Math.max(2, w / 2);          // 圆管半径 = 扶手宽的一半
      // 圆管放在顶面**前部**（靠近观者那侧），后面留出扶手台面 —— 这样读作
      // "扶手顶上的圆滚边"，而不是整块被一根管子替换。
      const tubeH = Math.max(3, Math.min(w, d) * 0.62);
      const tubeTop = topY + Math.max(0, d - tubeH) * 0.55;
      const wallTop = topY + d * 0.72;            // 立面从顶面后段开始，被管子压住上缘
      const wallH = Math.max(2, frontY + h - wallTop);
      // ---- 扶手立面（圆管下方）：比滚边暗一档
      node.rect(x, wallTop, w, wallH).fill({ color: mixHex(tone.front, 0x000000, dark ? 0.12 : 0.06) });
      //   立面横向明暗：左侧受光（窗在左），右侧渐暗
      node.rect(x, wallTop, Math.max(1, Math.round(w * 0.36)), wallH)
        .fill({ color: tone.front, alpha: dark ? 0.50 : 0.66 });
      node.rect(x + w - Math.max(2, Math.round(w * 0.30)), wallTop, Math.max(2, Math.round(w * 0.30)), wallH)
        .fill({ color: 0x000000, alpha: dark ? 0.24 : 0.12 });
      // ---- 圆柱带（顶面上的纵向圆管）
      //   用一条横跨整个深度的圆角矩形 + 内部竖向明暗渐变来表现"圆管"。
      node.roundRect(x, tubeTop, w, tubeH, tubeR * 0.92)
        .fill({ color: tone.front });
      //   圆柱母线高光：管子左 1/3 一条竖向亮带
      node.roundRect(x + Math.max(1, w * 0.12), tubeTop + 1,
        Math.max(1, w * 0.30), Math.max(2, tubeH - 2), 1)
        .fill({ color: tone.lip, alpha: dark ? 0.14 : 0.42 });
      //   管子右 1/4 暗面
      node.roundRect(x + w - Math.max(2, w * 0.28), tubeTop + 1,
        Math.max(1, w * 0.24), Math.max(2, tubeH - 2), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.13 });
      //   管子两端：顶端一小段亮弧（圆管的头），底端一道暗弧（与立面的接缝）
      node.ellipse(x + tubeR, tubeTop + Math.max(1, tubeH * 0.22), tubeR * 0.86, Math.max(1.2, tubeH * 0.22))
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.30 });
      node.rect(x + 1, tubeTop + tubeH - 1, Math.max(1, w - 2), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.14 });
      //   滚边轮廓：左上亮、右下暗
      node.roundRect(x, tubeTop, w, tubeH, tubeR * 0.92)
        .stroke({ width: 1, color: tone.edge, alpha: dark ? 0.34 : 0.20 });
      // ---- 与坐垫相接的内侧接触阴影（靠座位的那一侧）
      const innerSide = (part.x0 * scene.width < (scene.width * 0.5)) ? 'right' : 'left';
      const shadeX = innerSide === 'right' ? x + w - 2 : x;
      node.rect(shadeX, wallTop, 2, wallH)
        .fill({ color: 0x000000, alpha: dark ? 0.20 : 0.09 });
      // ---- 扶手底部落地阴影
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.30 : 0.14 });
    } else if (detail === 'sofa-cushion') {
      // 2026-10-28 第八轮（用户："那两个椭圆矩形放在那里，感觉怪怪的，
      // 不像坐垫"）。根因是两个叠加的错误：
      //   1. 圆角半径 min(w,d)*0.34 —— 坐垫 89×24px 时半径 13px，超过深度一半，
      //      直接变成药丸/胶囊；
      //   2. 外面又加了一圈 1px 深色描边，像贴纸轮廓。
      //
      // 真实沙发坐垫的读法：一块**近方形**的软垫，边角只有轻微倒角（2–3px），
      // 靠背一侧压出阴影、前沿有瀑布式圆边、中间一道浅浅的分缝。
      // 所以：小圆角 + 无描边 + 靠背侧阴影 + 前缘高光。
      const r = Math.max(1.5, Math.min(3, Math.min(w, d) * 0.10));   // 轻微倒角，不是胶囊
      // tone.top 与 tone.front 在 sofaSeat 材质下是**两个不同色**（top 是浅灰蓝、
      // front 是更深的沙发灰）。坐垫抬起来的那块受光面必须用 top，否则整块垫子
      // 和靠背一个颜色、看不出是软垫（2026-10-28 第八轮）。
      const cushionFace = tone.top;
      const cushionSide = mixHex(cushionFace, 0x000000, dark ? 0.20 : 0.12);
      // 底座（垫子本体）：立面比顶面深一档，做出厚度。
      node.roundRect(x, frontY, w, Math.max(2, h), r).fill({ color: cushionSide });
      // 顶面：主体（受光的布面）
      node.roundRect(x, topY, w, d, r).fill({ color: cushionFace });
      // 蓬松感：顶面中上部一条更亮的宽带（坐垫被坐压后中间鼓起的部分）。
      const puffH = Math.max(2, Math.round(d * 0.46));
      node.roundRect(x + 1, topY + 1, Math.max(2, w - 2), puffH, r)
        .fill({ color: tone.top, alpha: dark ? 0.30 : 0.62 });
      // 靠背侧的压迫阴影：贴着后排的那条暗带，把垫子「压进」沙发。
      const pressH = Math.max(2, Math.round(d * 0.22));
      node.rect(x + 1, topY, Math.max(2, w - 2), pressH)
        .fill({ color: 0x000000, alpha: dark ? 0.24 : 0.11 });
      // 中间分缝：1px 暗线，两端各留 3px 不顶边（真实坐垫的缝不会切到角）。
      node.rect(x + w / 2, topY + Math.max(2, d * 0.18), 1, Math.max(2, d * 0.66))
        .fill({ color: tone.edge, alpha: dark ? 0.30 : 0.18 });
      // 前缘瀑布：一条窄的亮边 + 一条暗缝，表现垫子向前卷过底座。
      node.rect(x + 2, frontY, Math.max(2, w - 4), 1)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.38 });
      node.rect(x + 2, frontY + Math.max(1, h - 1), Math.max(2, w - 4), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.12 });
    } else if (detail === 'magazine-stack') {
      // 一摞杂志（2026-10-28 第九轮）。盒子的 z 已经是 6 层厚（0.007 ≈ 4.4px），
      // 所以在正面画出 4 本侧边，顶面画最上面那本的封面。
      //
      // 关键是"堆叠感"：每本都有 1px 错位 + 轻微旋转感（用 x 偏移模拟），
      // 侧面各有一条纸的亮边与暗缝，最上面那本封面有一块低 alpha 图块。
      const layers = 4;
      const bookH = Math.max(1, Math.floor(h / layers));
      for (let i = 0; i < layers; i += 1) {
        // 逐层错位：越靠下的书越往左一点，模拟堆放时的不整齐。
        const shift = (layers - 1 - i) * 1;
        const by = frontY + i * bookH;
        const bw = Math.max(2, w - shift);
        const bx = x + shift;
        // 纸页侧边：底色 + 底边暗缝
        node.rect(bx, by, bw, Math.max(1, bookH - 1))
          .fill({ color: i % 2 === 0 ? tone.front : mixHex(tone.front, 0x000000, dark ? 0.08 : 0.04) });
        // 每本顶边一条亮线 = 纸张边缘
        node.rect(bx, by, bw, 1).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.34 });
        // 层间阴影
        node.rect(bx, by + Math.max(1, bookH - 1), bw, 1)
          .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.13 });
      }
      // 最上面那本的封面：顶面 + 一块图片区 + 标题条。
      // 封面必须**比纸色深**，否则在浅木色茶几上看不见边界（第一版用 tone.front
      // = paper 白，整摞糊成一片白）。
      const topShift = (layers - 1) * 1;
      const tw = Math.max(2, w - topShift);
      const tx = x + topShift;
      const coverTone = officeTone('accentSoft');
      const coverBase = mixHex(coverTone.front, dark ? 0x000000 : 0xffffff, dark ? 0.30 : 0.10);
      node.rect(tx, topY, tw, Math.max(1, d)).fill({ color: coverBase });
      node.rect(tx, topY, tw, 1).fill({ color: tone.lip, alpha: dark ? 0.14 : 0.50 });
      // 封面图块（低 alpha 的色块 = 一张照片，不画具体内容）
      node.rect(tx + 2, topY + 2, Math.max(2, tw * 0.42), Math.max(1, d * 0.40))
        .fill({ color: officeTone('accentSoft').front, alpha: dark ? 0.32 : 0.28 });
      // 标题条 + 第二行
      node.rect(tx + tw * 0.52, topY + 2, Math.max(2, tw * 0.40), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.16 });
      node.rect(tx + tw * 0.52, topY + 4, Math.max(2, tw * 0.28), 1)
        .fill({ color: 0x000000, alpha: dark ? 0.20 : 0.12 });
      // 顶面轮廓
      node.rect(tx, topY, tw, Math.max(1, d)).stroke({ width: 1, color: tone.edge, alpha: dark ? 0.34 : 0.22 });
      // 整摞的接地阴影（在桌面上的投影）
      node.ellipse(x + w * 0.5, frontY + h + 1, w * 0.52, Math.max(1, 2))
        .fill({ color: 0x000000, alpha: dark ? 0.22 : 0.08 });
    } else if (detail === 'table-leg') {
      node.rect(x, frontY, w, h).fill({ color: tone.front });
      node.rect(x, frontY, Math.max(1, w * 0.4), h).fill({ color: tone.lip, alpha: dark ? 0.14 : 0.40 });
      node.rect(x, frontY + h - 2, w, 2).fill({ color: 0x000000, alpha: dark ? 0.32 : 0.14 });
    } else if (detail === 'magazine') {
      // Two offset sheets with a folded corner and a cover image block.
      const ox = Math.max(1, Math.round(w * 0.06));
      const oy = Math.max(1, Math.round(d * 0.10));
      node.rect(x + ox, topY + oy, Math.max(1, w - ox), Math.max(1, d - oy))
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.12 : 0.05) });
      node.rect(x, topY, Math.max(1, w - ox), Math.max(1, d - oy)).fill({ color: tone.front });
      // Fold at the near corner.
      node.moveTo(x + w - ox * 2, topY + d - oy)
        .lineTo(x + w - ox, topY + d - oy)
        .lineTo(x + w - ox, topY + d - oy * 2)
        .closePath()
        .fill({ color: mixHex(tone.front, 0x000000, dark ? 0.22 : 0.12) });
      // Cover block: one low-alpha rectangle = a photo, not text.
      node.rect(x + 2, topY + 2, Math.max(2, w * 0.44), Math.max(1, d * 0.36))
        .fill({ color: officeTone('accentSoft').front, alpha: dark ? 0.35 : 0.30 });
      node.rect(x + 3, topY + d * 0.62, Math.max(2, w * 0.50), 1).fill({ color: 0x000000, alpha: dark ? 0.24 : 0.14 });
    } else if (detail === 'remote') {
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(1, d - 2)).fill({ color: tone.front });
      // Two buttons + an IR window.
      node.circle(x + w * 0.5, topY + d * 0.38, Math.max(0.8, Math.min(w, d) * 0.14))
        .fill({ color: mixHex(tone.front, 0xffffff, 0.25), alpha: 0.7 });
      node.circle(x + w * 0.5, topY + d * 0.66, Math.max(0.8, Math.min(w, d) * 0.14))
        .fill({ color: mixHex(tone.front, 0xffffff, 0.25), alpha: 0.7 });
      node.rect(x + w * 0.5 - 1, topY + d - 2, 2, 1).fill({ color: 0xff6b6b, alpha: 0.5 });
    } else if (detail === 'rug') {
      // Woven rug: outer frame, inner frame, weave lines and short fringe.
      node.roundRect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(1, d - 2), 6)
        .stroke({ width: 2, color: tone.edge, alpha: dark ? 0.45 : 0.34 });
      node.roundRect(x + 7, topY + 7, Math.max(1, w - 14), Math.max(1, d - 14), 4)
        .stroke({ width: 1, color: tone.lip, alpha: dark ? 0.10 : 0.28 });
      // Weave: 5 low-alpha lines along the length.
      for (let i = 1; i <= 5; i += 1) {
        node.rect(x + 10, topY + (d * i) / 6, Math.max(1, w - 20), 1)
          .fill({ color: tone.edge, alpha: dark ? 0.10 : 0.07 });
      }
      // Fringe on the two short ends: 2px tufts every 6px.
      for (let fx = x + 6; fx < x + w - 6; fx += 6) {
        node.rect(fx, topY + 2, 2, 3).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
        node.rect(fx, topY + d - 5, 2, 3).fill({ color: tone.lip, alpha: dark ? 0.10 : 0.30 });
      }
    } else if (detail === 'table') {
      // Coffee table top: 4px slab with a chamfer and a front edge.
      node.rect(x + 1, topY + 1, Math.max(1, w - 2), 1).fill({ color: tone.lip, alpha: dark ? 0.08 : 0.40 });
      woodGrain(node, part, tone, dark);
      const edgeH = Math.max(2, Math.round(h * 0.55));
      node.rect(x, frontY + h - edgeH, w, edgeH).fill({ color: tone.edge, alpha: dark ? 0.38 : 0.24 });
      node.rect(x, frontY + h - edgeH, w, 1).fill({ color: tone.lip, alpha: dark ? 0.12 : 0.36 });
      node.rect(x, frontY + h - 1, w, 1).fill({ color: 0x000000, alpha: dark ? 0.34 : 0.16 });
    } else if (detail === 'paper-lines') {
      node.rect(x + 2, topY + 2, Math.max(1, w - 4), 1).fill({ color: 0x000000, alpha: 0.25 });
      node.rect(x + 2, topY + 5, w * 0.55, 1).fill({ color: 0x000000, alpha: 0.2 });
    } else if (detail === 'pillow') {
      // Throw pillow: rounded square, domed face, centre crease, corner dents
      // and a soft shadow where it leans on the back cushion. At 31×18px it has
      // to read as fabric, so the corners are the whole story.
      const r = Math.max(4, Math.min(w, h) * 0.42);
      // Shadow cast onto the seat/back behind it.
      node.roundRect(x + 2, frontY + 2, Math.max(1, w - 2), Math.max(1, h), r)
        .fill({ color: 0x000000, alpha: dark ? 0.26 : 0.10 });
      // Body.
      node.roundRect(x, frontY, w, h, r).fill({ color: tone.front });
      // Domed face (inset, lighter) — the pillow's volume.
      node.roundRect(x + 2, frontY + 2, Math.max(1, w - 4), Math.max(1, h - 4), r * 0.72)
        .fill({ color: tone.top, alpha: dark ? 0.30 : 0.55 });
      // Top face sliver: pillows lean, so the top reads as a lit edge.
      node.roundRect(x + 1, topY + 1, Math.max(1, w - 2), Math.max(1, d - 2), r * 0.7)
        .fill({ color: tone.lip, alpha: dark ? 0.12 : 0.42 });
      // Centre crease: a vertical line that stops short of the corners.
      node.rect(x + w * 0.5, frontY + h * 0.24, 1, Math.max(1, h * 0.46))
        .fill({ color: tone.edge, alpha: dark ? 0.38 : 0.24 });
      // Corner dents: two dark notches at opposite corners.
      for (const [dx, dy] of [[0.22, 0.24], [0.78, 0.74]]) {
        node.circle(x + w * dx, frontY + h * dy, Math.max(1, Math.min(w, h) * 0.11))
          .fill({ color: tone.edge, alpha: dark ? 0.16 : 0.10 });
      }
      // Silhouette.
      node.roundRect(x, frontY, w, h, r).stroke({ width: 1, color: 0x000000, alpha: dark ? 0.30 : 0.15 });
    }
  }

  // Contact shadow per group: two nested soft ellipses under each defining
  // footprint. One hard ellipse read as a stain (2026-10-27 §10.7); two
  // nested ones read as falloff.
  const OFFICE_SHADOW_ALPHA = { light: 0.075, dark: 0.26 };
  // 2026-10-28 第三轮：绿植改用图片素材（用户授权："如果确认如绿植这些你很难
  // 精细化的用代码生成，那后面就回退到使用图片素材"）。
  //
  // 设计取舍：
  //   - 结构类家具（桌/椅/显示器/台面/沙发）需要跟角色一起参与逐件遮挡排序，
  //     素材反而是负担，继续代码绘制。
  //   - 绿植是静态落地装饰，只按组排序（整组一个画家键），用素材没有代价，
  //     而素材在叶体积、陶土质感、叶脉密度上明显比代码版好。
  //
  // 回退契约：纹理缺失（离线测试、素材未打包）时回退到代码绘制路径，所以
  // `describeOffice` 仍产出完整的 parts，渲染结果不会变成空白。
  function officeSpriteTexture(assetId) {
    if (!assetId) return null;
    const texture = officeTextureMap.get(assetId);
    if (!texture || !(texture.width > 0) || !(texture.height > 0)) return null;
    return texture;
  }

  function buildOfficeGroupNode(entry) {
    if (entry.sprite && officeSpriteTexture(entry.sprite.assetId)) {
      const sprite = new PIXI.Sprite(officeSpriteTexture(entry.sprite.assetId));
      sprite.__officeGroupSprite = entry.sprite.assetId;
      return sprite;
    }
    return new PIXI.Graphics();
  }

  // 把精灵图按"盆底 = 组的前下边缘"落位。
  //
  // Anchor 用 (0.5, 1) 会让**纹理画布底边**贴地，而 1024² 素材的盆栽四周还有
  // 大片空白（contentBbox 只占中间一部分），结果植物悬在地面上方、接触阴影
  // 留在脚下（2026-10-28 实测）。所以这里按 contentBbox 计算真实的"盆底"位置：
  // 把内容底边对到锚点，而不是画布底边。
  function paintOfficeGroupSprite(node, entry) {
    const spec = entry.sprite;
    const texture = node && node.texture;
    if (!spec || !texture || !(texture.width > 0)) return;
    const asset = layoutAssetById(spec.assetId);
    const bbox = asset && asset.contentBbox ? asset.contentBbox : null;
    const anchorX = spec.footX * scene.width;
    const anchorY = spec.footY * scene.height;
    // 目标高度 = 屏幕像素高度；按内容高度换算缩放（内容占比 < 1 时纹理整体更大）。
    const contentH = bbox ? bbox.h : 1;
    const contentW = bbox ? bbox.w : 1;
    const scale = Math.max(0.01, (spec.height * scene.height) / (texture.height * contentH));
    node.scale.set(scale, scale);
    node.anchor.set(0.5, 1);
    node.x = anchorX;
    // 内容底边落在 anchorY：画布底边要再往下 (1 - bbox.y - bbox.h)。
    node.y = anchorY + (1 - (bbox ? bbox.y + bbox.h : 1)) * texture.height * scale;
    // 诊断/测试用：素材在屏幕上的实际占位（内容盒，不含画布留白）。
    node.__officeSpriteBox = {
      w: texture.width * contentW * scale,
      h: texture.height * contentH * scale,
    };
    // 暗色主题：素材是按亮房画的，直接贴会像发光的白剪影。乘一个中性灰
    // 让它们落进夜景。注意 tint 是**乘算**，所以只能压暗、不能提亮。
    // 亮色主题必须显式复位成白色，否则从暗色切回来会残留灰调。
    if (codeSceneOptions.theme === 'dark') {
      node.tint = 0x6f7479;
    } else if (node.tint !== undefined) {
      node.tint = 0xffffff;
    }
  }

  function drawOfficeGroupShadow(node, entry) {
    const casts = entry.kind === 'station-desk'
      || entry.kind === 'station-back'
      || entry.kind === 'lounge-sofa'
      || entry.kind === 'lounge-table'
      || entry.kind === 'lounge-lamp'
      || entry.kind === 'kitchen'
      || entry.kind === 'plant';
    if (!casts) return;
    const dark = codeSceneOptions.theme === 'dark';
    const parts = entry.parts.filter((part) => (
      part.kind === 'desk-top' || part.kind === 'sofa' || part.kind === 'table'
      || part.kind === 'counter' || part.kind === 'fridge' || part.kind === 'plant-pot'
      || part.kind === 'chair-base' || part.detail === 'chair-star'
    ));
    for (const part of parts) {
      const x = part.x0 * scene.width;
      const w = (part.x1 - part.x0) * scene.width;
      const y = part.y1 * scene.height;
      const isChair = part.kind === 'chair-base';
      const rx = isChair ? w * 0.72 : w * 0.50;
      const ry = isChair
        ? Math.max(3, (part.y1 - part.y0) * scene.height * 0.34)
        : Math.max(3, (part.y1 - part.y0) * scene.height * 0.22);
      const a = dark ? OFFICE_SHADOW_ALPHA.dark : OFFICE_SHADOW_ALPHA.light;
      node.ellipse(x + w / 2, y - 1, rx, ry).fill({ color: 0x000000, alpha: a });
      node.ellipse(x + w / 2, y - 1, rx * 0.60, ry * 0.60).fill({ color: 0x000000, alpha: a * 0.85 });
    }
  }

  function layoutOfficeGroups() {
    if (projectionMode !== 'flat' || !codeSceneOptions.enabled || !codeSceneOptions.generatedFurniture) return;
    const description = officeDescription || buildOfficeDescription();
    if (!description) return;
    if (!officeShadowNode) {
      officeShadowNode = new PIXI.Graphics();
      officeShadowNode.__furnitureId = 'generated-office-shadows';
      layers.background.addChild(officeShadowNode);
    }
    officeShadowNode.clear();
    const layer = layers['ground-entities'];
    const seen = new Set();
    for (const entry of description.groups) {
      seen.add(entry.id);
      let record = officeGroups.get(entry.id);
      if (!record) {
        // 2026-10-28 第三轮：带 `sprite` 描述的组（目前只有绿植）优先用图片
        // 素材渲染。素材是 PIXI.Sprite（不是 Graphics），所以节点类型跟着
        // 描述走；纹理缺失时 `buildOfficeGroupNode` 会退回 Graphics。
        const node = buildOfficeGroupNode(entry);
        node.__officeGroupId = entry.id;
        layer.addChild(node);
        record = { node, group: entry };
        officeGroups.set(entry.id, record);
      }
      record.group = entry;
      if (record.node && typeof record.node.clear === 'function') {
        record.node.clear();
        for (const part of entry.parts) drawOfficePart(record.node, part);
      } else {
        paintOfficeGroupSprite(record.node, entry);
      }
      drawOfficeGroupShadow(officeShadowNode, entry);
    }
    for (const [id, record] of [...officeGroups]) {
      if (seen.has(id)) continue;
      record.node.destroy();
      officeGroups.delete(id);
    }
    sortOfficeGround();
  }

  // One painter pass: furniture groups and characters keyed by their
  // front-bottom edge. No station re-keying here (unlike the legacy collage):
  // the character art faces the camera and every station piece lives behind
  // the seat, so a body keyed by its own foot point is in front of its chair
  // and desk and behind anything closer to the camera. That IS the anti-穿模
  // property the collage lacked: occlusion comes from geometry, not layers.
  // 2.5D 代码家具的画家算法。
  //
  // 2026-10-28 第五轮：这里补回了**坐姿角色重挂**（旧贴图路径在 `sortGround`
  // 的 M4.1h 段落里有等价逻辑，代码化分支一直漏着）。
  //
  // 需要它是因为用户给的顺序是「椅子 > 鲸鱼娘 > 桌子」，而角色只用脚点一个键：
  //   - 站着/路过：脚点键天然正确（越靠下越靠前），不许动；
  //   - 坐在工位里：脚点落在桌子底边附近，纯脚点排序会让她有时被桌板盖住。
  //
  // 所以只对**脚点落在自己工位带内**的角色，把键抬到工位堆叠键之上、
  // 但仍严格低于椅子键 —— 这样"椅子压角色、角色压桌子"在任何一张工位上
  // 都恒成立，而走廊行人与绕后的角色不受影响。
  function sortOfficeGround() {
    const layer = layers['ground-entities'];
    const groups = [...officeGroups.values()];
    const entries = [];
    for (const record of entities.values()) {
      if (!record.container) continue;
      const point = record.__snapshot ? record.__snapshot.position : null;
      const key = point ? point.y * scene.height : 0;
      entries.push({ key, node: record.container, id: record.employeeId, kind: 'character', point });
    }
    for (const record of groups) {
      entries.push({ key: record.group.key * scene.height, node: record.node, id: record.group.id, kind: 'furniture' });
    }
    // 工位识别：组 id 形如 `<seatId>-back` / `<seatId>-desk`。
    const stations = new Map();
    for (const record of groups) {
      const match = /-([a-z]+)$/.exec(record.group.id || '');
      if (!match || (match[1] !== 'back' && match[1] !== 'desk')) continue;
      const prefix = record.group.id.slice(0, match.index);
      if (!stations.has(prefix)) stations.set(prefix, { back: null, desk: null, stackKey: -Infinity });
      stations.get(prefix)[match[1]] = record.group;
    }
    const stationList = [...stations.values()].filter((st) => st.back && st.desk);
    for (const st of stationList) {
      // 堆叠键 = 工位里除椅子之外最高的那个键（通常是桌面道具/显示器）。
      st.stackKey = Math.max(st.desk.key, st.back.key - 1);
      for (const g of groups) {
        if (!g.group.id.startsWith(`${st.desk.id.slice(0, -'-desk'.length)}-`)) continue;
        if (g.group.id.endsWith('-back')) continue;
        st.stackKey = Math.max(st.stackKey, g.group.key);
      }
    }
    for (const entry of entries) {
      if (entry.kind !== 'character' || !entry.point) continue;
      for (const st of stationList) {
        const deskParts = st.desk.parts;
        const back = st.back;
        const x0 = Math.min(...deskParts.map((p) => p.x0));
        const x1 = Math.max(...deskParts.map((p) => p.x1));
        const yTop = Math.min(...back.parts.map((p) => p.y0));
        const yBot = Math.max(...deskParts.map((p) => p.y1));
        if (entry.point.x < x0 || entry.point.x > x1) continue;
        if (entry.point.y < yTop || entry.point.y > yBot) continue;
        // 抬到 堆叠键之上、椅子键之下：椅子仍压角色，角色压桌子。只升不降。
        const target = Math.min((st.stackKey + 0.5 / scene.height) * scene.height, back.key * scene.height - 0.5);
        if (target > entry.key) entry.key = target;
        break;
      }
    }
    entries.sort((a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id)));
    applyGroundOrder(layer, entries);
    return entries.map((entry) => entry.id);
  }

  // P3.4: a soft contact shadow under every furniture footprint. It is what
  // makes the art sit ON the floor instead of being a hard-edged cut-out.
  function drawFurnitureGrounding(node) {
    // The generated office hides the legacy furniture; its shadows must not
    // survive as ghost blobs (2026-10-27, first generated-scene screenshot).
    if (officeDescription || projectionMode === 'iso') return;
    const dark = codeSceneOptions.theme === 'dark';
    for (const record of furnitureRecords.values()) {
      if (record.kind !== 'sprite' && record.kind !== 'graphics') continue;
      if (record.item && record.item.kind === 'zone-marker') continue;
      const rect = record.mirrorRect || record.rect;
      if (!rect) continue;
      const x = rect.x * scene.width;
      const y = rect.y * scene.height;
      const w = rect.width * scene.width;
      const h = rect.height * scene.height;
      const cx = x + w / 2;
      const cy = y + h * 0.93;
      node.ellipse(cx, cy, Math.max(6, w * 0.46), Math.max(3, h * 0.14))
        .fill({ color: 0x000000, alpha: dark ? 0.20 : 0.06 });
      node.ellipse(cx, cy, Math.max(4, w * 0.30), Math.max(2, h * 0.08))
        .fill({ color: 0x000000, alpha: dark ? 0.14 : 0.045 });
    }
  }

  // P3.4: material edges. A lit top edge + a shaded bottom edge gives the flat
  // desk art a slab thickness, so the rectangle reads as furniture rather than
  // a pasted box. Drawn above the back-furniture sprites, under the characters.
  function drawFurnitureEdges(node) {
    if (officeDescription || projectionMode === 'iso') return;
    const dark = codeSceneOptions.theme === 'dark';
    for (const record of furnitureRecords.values()) {
      if (record.kind !== 'sprite' && record.kind !== 'graphics') continue;
      if (record.item && record.item.layer !== 'back-furniture') continue;
      const rect = record.rect;
      if (!rect) continue;
      const x = rect.x * scene.width;
      const y = rect.y * scene.height;
      const w = rect.width * scene.width;
      const h = rect.height * scene.height;
      const kind = record.item && record.item.kind;
      if (kind === 'desk-back') {
        node.rect(x + 1, y, Math.max(0, w - 2), 1).fill({ color: 0xffffff, alpha: dark ? 0.10 : 0.55 });
        node.rect(x + 1, y + h - 2, Math.max(0, w - 2), 2).fill({ color: 0x000000, alpha: dark ? 0.22 : 0.07 });
        node.rect(x, y + 1, 1, Math.max(0, h - 2)).fill({ color: 0xffffff, alpha: dark ? 0.05 : 0.22 });
      } else if (kind === 'monitor') {
        node.rect(x + w * 0.10, y + 1, w * 0.80, 1).fill({ color: 0xffffff, alpha: dark ? 0.08 : 0.30 });
      }
    }
  }

  // Re-projects every persistent furniture node to the live scene size.
  // Sprites only get transform updates; Graphics redraw their rects in place.
  function layoutFurniture() {
    if (projectionMode === 'iso') officeDescription = null;
    else if (codeSceneOptions.enabled && codeSceneOptions.generatedFurniture) officeDescription = buildOfficeDescription();
    for (const record of furnitureRecords.values()) {
      if (record.kind === 'floor') {
        record.node.clear();
        if (projectionMode === 'iso') {
          drawIsoRoom(record.node);
        } else if (codeSceneOptions.enabled) {
          drawCodeScene(record.node);
        } else {
          const bandY = scene.height * 0.32;
          record.node.rect(0, bandY, scene.width, scene.height - bandY).fill({ color: COLORS.floorLine, alpha: 0.35 });
        }
      } else if (record.kind === 'code') {
        // 2026-10-29：'code' 记录来自旧贴图路径的 monitor 重绘，该路径已移除。
        record.node.clear();
      } else if (record.kind === 'shadows') {
        record.node.clear();
        if (codeSceneOptions.enabled) drawFurnitureGrounding(record.node);
      } else if (record.kind === 'edges') {
        record.node.clear();
        if (codeSceneOptions.enabled) drawFurnitureEdges(record.node);
      }
      // 2026-10-29：'sprite' / 'graphics' 记录来自已移除的旧贴图路径，
      // layoutFurniture 不再需要处理它们。
    }
    // I2: iso furniture lives on the ground layer as one node per box, sorted
    // with the characters; the flat furniture nodes above are hidden.
    layoutIsoFurniture();
    // 2.5D coded office: one node per group, also on the ground layer.
    layoutOfficeGroups();
  }

  // ---- entity lifecycle (persistent nodes) ---------------------------------

  function frameGeometryFor(employee) {
    const animation = employee.animation || {};
    const resource = animation.resource || 'idle';
    const frameIndex = animation.frameIndex || 0;
    if (pack && typeof pack.frameGeometry === 'function' && animation.resource) {
      try {
        const frame = pack.frameGeometry(resource, frameIndex);
        if (frame && frame.file) {
          return { file: frame.file, anchor: frame.outputAnchor, fallbackReason: animation.fallbackReason || null };
        }
      } catch { /* fall through to placeholder */ }
    }
    return { file: null, anchor: { x: 16, y: 30 }, fallbackReason: animation.fallbackReason || (pack ? 'TEXTURE_MISSING' : 'PACK_MISSING') };
  }

  function createEntity(employeeId) {
    const record = {
      employeeId,
      __snapshot: null,
      __layout: { visibleHeight: computeVisibleHeight(scene.height), scale: 1 },
      __frameAnchor: { x: 0, y: 0 },
      __fallbackReason: null,
      __placeholder: false,
    };
    if (mode !== 'static') {
      const container = new PIXI.Container();
      container.__employeeId = employeeId;

      const shadow = new PIXI.Graphics();
      shadow.__role = 'shadow';

      const placeholder = new PIXI.Graphics();
      placeholder.__role = 'placeholder-body';

      // Real Pixi rejects a null texture at render time; EMPTY is the safe
      // placeholder until the first frame texture is assigned.
      const emptyTexture = PIXI.Texture && PIXI.Texture.EMPTY ? PIXI.Texture.EMPTY : null;
      const sprite = new PIXI.Sprite(emptyTexture);
      sprite.anchor.set(0, 0);
      sprite.__role = 'character';

      const ring = new PIXI.Graphics();
      ring.__role = 'selection-ring';
      ring.visible = false;

      container.addChild(shadow, placeholder, sprite);
      // Task 9: the selection ring is INTERACTION OVERLAY — it lives on the
      // topmost layer (with the badge/marker) so desk-front occluders can
      // never paint over the selection state. Coordinates are stage-absolute
      // (the container never moves), so no placement math changes.
      layers['effects-labels'].addChild(ring);
      layers['ground-entities'].addChild(container);

      // Persistent Effects/labels nodes: they live on the top layer and follow
      // the entity every update (queue badge, non-text activity marker).
      const badge = new PIXI.Text('0');
      badge.__role = 'queue-badge';
      badge.anchor = badge.anchor || {}; badge.anchor = { set(v) { this.__v = v; } };
      badge.visible = false;
      const marker = new PIXI.Text('');
      marker.__role = 'activity-marker';
      marker.anchor = marker.anchor || {}; marker.anchor = { set(v) { this.__v = v; } };
      marker.visible = false;
      layers['effects-labels'].addChild(badge, marker);

      // E5c dialogue bubble: rounded-rect speech bubble on the top layer,
      // visible only when the employee carries bubble text. Positioned above
      // the character's head in updateEntity; follows the entity like badge.
      // 2026-10-30（用户："聊天气泡样式太死板"）：重做视觉。
      // 旧版是纯白圆角矩形 + 1px 灰边，没有指向说话人的尾巴、没有层次、
      // 深色主题下依然白得刺眼。新版：
      //   - 圆角更大（10px）+ 上浅下深的双层面板，边缘更软
      //   - 底部一条**指向说话人头部的尾巴**，明确"谁在说"
      //   - 按主题取色（浅色：暖白+淡青边；深色：深灰蓝+冷边），不再刺眼
      //   - 文字用系统中文字体栈并略微加粗，小字号下更清楚
      const bubbleBg = new PIXI.Graphics();
      bubbleBg.__role = 'dialogue-bubble-bg';
      const bubbleText = new PIXI.Text('');
      bubbleText.__role = 'dialogue-bubble-text';
      // 2026-10-30 二次重设计（用户："新气泡和旧版差不多，再设计一下"）：
      // 第一版只是"圆角大一点 + 加个尾巴"，视觉上仍是一块平白板子。
      // 这一版按鲸鱼娘的社区形象（蓝色、海洋、软萌）做成**水泡感气泡**：
      //   - 海蓝双色渐变面板（上浅下深），像一颗被光照到的水泡
      //   - 外圈一圈更淡的"水膜"描边 + 顶部一道高光
      //   - 尾巴做成水滴形（三阶递减），不再是生硬的小三角
      //   - 文字用深蓝墨色、15px、行高更松，读起来更软
      bubbleText.style = {
        fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        fontSize: 15,
        fontWeight: '600',
        fill: 0x1e3a5f,
        wordWrap: true,
        wordWrapWidth: 176,
        breakWords: true,
        lineHeight: 21,
        align: 'left',
      };
      bubbleText.visible = false;
      layers['effects-labels'].addChild(bubbleBg, bubbleText);
      record.__bubbleBg = bubbleBg;
      record.__bubbleText = bubbleText;

      record.container = container;
      record.__sprite = sprite;
      record.__placeholderG = placeholder;
      record.__shadow = shadow;
      record.__selectionRing = ring;
      record.__badge = badge;
      record.__marker = marker;
      record.__footPx = { x: 0, y: 0 };
    }
    entities.set(employeeId, record);
    return record;
  }

  // P3.0: every node that updateEntity draws in stage-absolute coordinates is
  // translated by the interpolation pump INSTEAD of being redrawn. Resetting
  // the offsets here means a fresh snapshot always redraws from a clean origin.
  function resetEntityOffsets(record) {
    // 容器本身仍然归零（它是 ground-entities 里的相对位移承载者）。
    if (record.container && record.container.position
        && typeof record.container.position.set === 'function') {
      record.container.position.set(0, 0);
    }
    // effects 层的偏移只清记录，不动节点的绝对坐标
    //（节点坐标由 updateEntity 重新按绝对场景坐标写入）。
    record.__effectsOffset = { x: 0, y: 0 };
  }

  // Moves the already-drawn entity to an interpolated foot point. Everything
  // inside `container` (shadow, placeholder, sprite) shares one translation;
  // the ring/badge/marker/bubble live on the effects layer and are offset by
  // the same delta, so the whole label cluster stays attached to the feet.
  function placeEntity(record, sample, nowMs) {
    if (!record || !record.container || !record.__placedAt) return false;
    const foot = displayFootOf(record, sample, nowMs);
    const footX = foot.x;
    const footY = foot.y;
    const dx = footX - record.__placedAt.x;
    const dy = footY - record.__placedAt.y;
    const moved = Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01;
    // Always write the offset (including the settle-to-zero frame): the
    // previous frame's translation must be cleared, never left behind.
    record.container.position.set(dx, dy);
    // 2026-10-30（用户报"气泡文字跑到页面左上角"的真因）：
    // 原来这里对 badge/marker/bubble 也调用 `position.set(dx, dy)`。
    // 但 `dx/dy` 是**相对上一帧的快照位移**，而这些节点在 updateEntity 里
    // 是用**绝对场景坐标**绘制的（badge.x = footX + …、bbText.x = bx + …）。
    // 于是插值一跑，它们的绝对坐标就被写成纯位移量：驻留时 dx=dy=0，
    // 气泡文字直接被搬到了画布左上角 (0,0) —— 正是用户截图里看到的现象。
    //
    // 正确做法：这里的节点**不直接位移**，只把偏移量记到 record 上，
    // 由 updateEntity 在绝对坐标上叠加（见 effectsOffsetOf 的用法）。
    record.__effectsOffset = { x: dx, y: dy };
    // hitTest must follow the drawing, not the snapshot.
    record.__footPx = { x: footX, y: footY };
    // 身体盒同样要跟着画出来的位置走（拖拽/插值期间不能停在快照位置，
    // 否则鼠标点在"画出来的角色"身上却命不中）。
    if (record.__bodyBox) {
      const bx = footX - record.__bodyBox.x0 + (record.__placedAt ? record.__placedAt.x - footX : 0);
      const prevFoot = record.__bodyBox;
      const w = prevFoot.x1 - prevFoot.x0;
      const h = prevFoot.y1 - prevFoot.y0;
      record.__bodyBox = { x0: footX - w / 2, x1: footX + w / 2, y0: footY - h, y1: footY };
    }
    return moved;
  }

  // Applies the interpolated position of every entity at `nowMs`. Returns true
  // when at least one entity actually moved (i.e. a repaint is worth doing).
  function applyPresentationFrame(nowMs) {
    if (!presentationClock) {
      // No presentation clock (e.g. a headless harness): only a drag needs
      // per-frame placement, and it uses the snapshot position as the sample.
      if (!dragState.employeeId) return false;
      const dragged = entities.get(dragState.employeeId);
      if (!dragged || !dragged.__snapshot) return false;
      return placeEntity(dragged, dragged.__snapshot.position, nowMs);
    }
    let moved = false;
    for (const sample of presentationClock.sample(nowMs)) {
      const record = entities.get(sample.employeeId);
      if (record && placeEntity(record, sample, nowMs)) moved = true;
    }
    return moved;
  }

  function schedulePresentationFrame() {
    if (!presentationClock || presentationFrameHandle !== null) return;
    if (destroyed || paused || mode === 'static' || !foreground || !presenting) return;
    try {
      presentationFrameHandle = hostScheduleFrame(presentationTick);
    } catch {
      presentationFrameHandle = null;
    }
  }

  function presentationTick() {
    presentationFrameHandle = null;
    if (destroyed || !presentationClock || paused || mode === 'static' || !foreground || !presenting) return;
    presentationFrames += 1;
    const nowMs = presentationNow();
    const wasReleasing = dragState.release !== null;
    if (dragState.release && nowMs - dragState.release.at >= DRAG_RETURN_MS) clearDrag();
    if (applyPresentationFrame(nowMs) || wasReleasing) renderNow();
    // Keep the pump alive while something is between samples OR a dragged
    // character is still returning to its post; an idle office costs nothing.
    if (dragState.release || presentationClock.interpolating(nowMs)) schedulePresentationFrame();
  }

  function updateEntity(record, employee) {
    resetEntityOffsets(record);
    record.__snapshot = employee;
    // 2026-10-30：呈现时钟的插值偏移（相对上一帧快照），叠加到所有
    // effects-labels 节点的**绝对**坐标上。见 placeEntity 的说明。
    const fxOffset = record.__effectsOffset || { x: 0, y: 0 };
    if (mode === 'static') return;

    // Task E5a-R2: the editor-composed character height. The snapshot carries
    // a height RATIO over the linear default (see office-module's mapping:
    // ratio = DRAFT_WIDTHS.character × composedScale × unionH / packCanvas
    // / (refH × 0.11)); both the default and the composed height scale
    // linearly with the live scene height, so multiplying here keeps the
    // composed size at every window size. The final height clamps to the
    // SPEC-02 band [64, 180] — extreme drafts can never render a giant or a
    // dot (draft scales outside roughly [0.85, 2.38] at 840 hit the clamps).
    const presentation = employee.presentation || null;
    const heightRatio = presentation && Number.isFinite(presentation.heightRatio) && presentation.heightRatio > 0
      ? presentation.heightRatio
      : 1;
    const visibleHeight = clamp(
      computeVisibleHeight(scene.height) * (codeSceneOptions.enabled ? codeSceneOptions.characterScale : 1) * heightRatio,
      64,
      180
    );
    const geometryBounds = pack && pack.geometry ? pack.geometry.visibleBounds.height : 64;
    const scale = visibleHeight / geometryBounds;
    const frame = frameGeometryFor(employee);
    const foot = footScreenOf(employee.position);
    const footX = foot.x;
    const footY = foot.y;
    record.__layout = { visibleHeight, scale };
    record.__frameAnchor = { ...frame.anchor };
    record.__fallbackReason = frame.fallbackReason;
    record.__footPx = { x: footX, y: footY };

    const emptyTexture = PIXI && PIXI.Texture && PIXI.Texture.EMPTY ? PIXI.Texture.EMPTY : null;
    const texture = frame.file ? textures.get(frame.file) || emptyTexture : emptyTexture;
    const sprite = record.__sprite;
    const placeholder = record.__placeholderG;
    if (frame.file && texture && texture !== emptyTexture) {
      if (sprite.texture !== texture) sprite.texture = texture;
      sprite.scale.set(scale);
      sprite.x = footX - frame.anchor.x * scale;
      sprite.y = footY - frame.anchor.y * scale;
      sprite.visible = true;
      placeholder.visible = false;
      record.__placeholder = false;
    } else {
      // Placeholder body: deterministic silhouette, foot-anchored like real
      // art. The sprite keeps the exact anchor math so the projection contract
      // holds with or without textures.
      sprite.visible = false;
      placeholder.clear();
      const w = visibleHeight * 0.42;
      const h = visibleHeight;
      placeholder.roundRect(footX - w / 2, footY - h, w, h, w * 0.3).fill({ color: COLORS.chair, alpha: 0.9 });
      placeholder.circle(footX, footY - h * 0.82, w * 0.26).fill({ color: COLORS.markerChat, alpha: 0.9 });
      placeholder.visible = true;
      record.__placeholder = true;
      sprite.scale.set(scale);
      sprite.x = footX - frame.anchor.x * scale;
      sprite.y = footY - frame.anchor.y * scale;
    }

    // 2026-10-30（用户："把脚下圆形交互区改成鲸鱼娘全身，但不超过身体边界"）：
    // 记录这只角色的**身体包围盒**（屏幕像素），供 hitTest 做矩形命中。
    // 用精灵当前的实际占位算：可见高度 visibleHeight + 纹理宽高比推出的宽度；
    // 没有纹理（占位像素图）时用占位体的 0.42 宽。
    // 盒子以脚点为底边中心、向上 visibleHeight，横向按纹理长宽比收窄，
    // 所以"能点到的就是画出来的那个人"，不会延伸到空白处。
    {
      const tex = record.__sprite && record.__sprite.texture;
      const texW = tex && tex.width ? tex.width : 0;
      const texH = tex && tex.height ? tex.height : 0;
      let bodyW = visibleHeight * 0.42;
      if (texW > 0 && texH > 0) {
        // 角色立绘很"瘦"：真实可见宽度约为纹理宽的 55%（两侧是透明留白）。
        bodyW = (texW / texH) * visibleHeight * 0.55;
      }
      bodyW = Math.max(20, Math.min(bodyW, visibleHeight * 1.2));
      record.__bodyBox = {
        x0: footX - bodyW / 2,
        x1: footX + bodyW / 2,
        y0: footY - visibleHeight,
        y1: footY,
      };
    }
    const shadow = record.__shadow;
    shadow.clear();
    shadow.circle(footX, footY, Math.max(6, visibleHeight * 0.16)).fill({ color: COLORS.shadow, alpha: 0.35 });

    const ring = record.__selectionRing;
    ring.clear();
    if (selectionId === record.employeeId) {
      ring.circle(footX, footY, Math.max(14, visibleHeight * 0.3)).stroke({ width: 2, color: COLORS.selection, alpha: 0.95 });
      ring.visible = true;
    } else {
      ring.visible = false;
    }

    const badge = record.__badge;
    const count = employee.queueCount || 0;
    badge.text = String(count);
    badge.visible = count > 0;
    badge.x = footX + Math.max(14, visibleHeight * 0.26) + fxOffset.x;
    badge.y = footY - visibleHeight - 10 + fxOffset.y;

    const marker = record.__marker;
    if (employee.marker === 'chat-ellipsis') {
      marker.text = '…';
      marker.visible = true;
      // 2026-09-25（性能）：Pixi v8 的 style setter 没有同值保护（每次都新建
      // TextStyle → 文本重栅格化 + 纹理重上传），62.5Hz 下每个带标记的员工每秒
      // 被重栅格化 ~62 次。只在"标记种类/字号真的变了"时写 style。
      const markerStyleKey = `chat:${Math.max(12, Math.round(visibleHeight * 0.24))}`;
      if (record.__markerStyleKey !== markerStyleKey) {
        record.__markerStyleKey = markerStyleKey;
        marker.style = { fill: COLORS.markerChat, fontSize: Math.max(12, visibleHeight * 0.24) };
      }
    } else if (employee.marker === 'sleep-zzz') {
      marker.text = 'Zzz';
      marker.visible = true;
      const markerStyleKey = `sleep:${Math.max(10, Math.round(visibleHeight * 0.2))}`;
      if (record.__markerStyleKey !== markerStyleKey) {
        record.__markerStyleKey = markerStyleKey;
        marker.style = { fill: COLORS.markerSleep, fontSize: Math.max(10, visibleHeight * 0.2) };
      }
    } else {
      marker.visible = false;
    }
    marker.x = footX + fxOffset.x;
    marker.y = footY - visibleHeight - 12 + fxOffset.y;

    // E5c dialogue bubble: rounded-rect speech bubble above the character's
    // head, visible only when the snapshot carries bubble text. The bg
    // Graphics and Text follow the entity like badge/marker.
    const bbBg = record.__bubbleBg;
    const bbText = record.__bubbleText;
    if (employee.bubble && employee.bubble.text) {
      bbText.text = employee.bubble.text;
      const dark = codeSceneOptions && codeSceneOptions.theme === 'dark';
      const padX = 9;
      const padY = 6;
      const btw = Math.max(bbText.width, 32);
      const bth = Math.max(bbText.height, 18);
      const boxW = btw + padX * 2;
      const boxH = bth + padY * 2;
      const bx = footX - boxW / 2;
      // 抬高一点，避免压住角色头顶；尾巴占 7px
      const by = footY - visibleHeight - boxH - 16;
      const tailH = 7;
      const tailW = 7;
      const tailX = Math.min(Math.max(footX, bx + 10), bx + boxW - 10 - tailW);

      // 海蓝水泡配色：浅色主题用"奶白→浅海蓝"，深色主题用"深海军蓝→蓝紫"。
      const faceTop = dark ? 0x2f3d78 : 0xf2f8ff;
      const faceBottom = dark ? 0x1d2650 : 0xd8ebfb;
      const faceAlpha = dark ? 0.94 : 0.97;
      const edge = dark ? 0x7f93c9 : 0x8fc0e0;
      const rim = dark ? 0x4a5c96 : 0xb9ddf0;
      const inkDark = 0xdfe9fb;

      bbBg.clear();
      // Graphics 用局部绘制坐标，插值偏移通过它自身的 position 承载
      //（它的局部坐标是相对盒子起点的，不是绝对场景坐标）。
      if (bbBg.position && typeof bbBg.position.set === 'function') bbBg.position.set(fxOffset.x, fxOffset.y);
      // 尾巴（先画，被主体压住一部分，看起来是从气泡里伸出来的）。
      // 只用 roundRect 拼出来：PIXI 8 的 Graphics.poly/moveTo 在渲染器测试的
      // stub 里没有实现，而 roundRect 是这条代码路径一直在用、两边都支持的原语。
      // 三级递减宽度 = 视觉上的小三角，够自然且零兼容风险。
      // 尾巴：水滴形（4 阶递减，比 3 阶更柔）
      const tailSteps = 4;
      for (let ti = 0; ti < tailSteps; ti += 1) {
        const w = Math.max(2, tailW * (1 - ti / tailSteps) * 1.25);
        const ty = by + boxH - 2 + (tailH / tailSteps) * ti;
        const c = ti < 2 ? faceBottom : faceBottom;
        bbBg.roundRect(footX - w / 2, ty, w, tailH / tailSteps + 1.5, Math.min(3, w / 2))
          .fill({ color: c, alpha: faceAlpha });
      }
      // 主体：上浅下深的三段叠色，模拟水泡受光
      bbBg.roundRect(bx, by, boxW, boxH, 12).fill({ color: faceTop, alpha: faceAlpha });
      bbBg.roundRect(bx, by + boxH * 0.45, boxW, boxH * 0.55, 12).fill({ color: faceBottom, alpha: faceAlpha * 0.95 });
      // 顶部高光：一条内缩的亮弧（用圆角矩形近似）
      bbBg.roundRect(bx + 4, by + 3, Math.max(6, boxW - 8), Math.max(3, boxH * 0.26), 6)
        .fill({ color: dark ? 0x6f86c8 : 0xffffff, alpha: dark ? 0.16 : 0.72 });
      // 外圈水膜边 + 内圈亮边
      bbBg.roundRect(bx, by, boxW, boxH, 12).stroke({ width: 1.6, color: edge, alpha: dark ? 0.62 : 0.92 });
      bbBg.roundRect(bx + 1.5, by + 1.5, boxW - 3, boxH - 3, 10.5).stroke({ width: 0.8, color: rim, alpha: dark ? 0.34 : 0.6 });
      bbBg.visible = true;
      bbText.x = bx + padX + fxOffset.x;
      bbText.y = by + padY + fxOffset.y;
      if (typeof bbText.style === 'object' && bbText.style) bbText.style.fill = dark ? inkDark : 0x1e3a5f;
      if (globalThis.__bubbleDiagCount === undefined) globalThis.__bubbleDiagCount = 0;
      if (globalThis.__bubbleDiagCount < 3 && typeof window !== 'undefined') {
        globalThis.__bubbleDiagCount += 1;
        console.log('[bubble-diag] text= + bbText.text +  x=' + bbText.x + ' y=' + bbText.y + ' w=' + bbText.width + ' h=' + bbText.height + ' bx=' + bx + ' by=' + by + ' footY=' + footY); }

      bbText.visible = true;
    } else {
      bbText.visible = false;
      bbBg.visible = false;
    }
    // The interpolation base: this snapshot's foot point, drawn before any
    // presentation offset is applied.
    record.__placedAt = { x: footX, y: footY };
  }

  // The ACTUAL paint order of the merged ground pass, cached for tests and
  // real-shell probes: [{ id, kind, key }] with keys in scene px (bottom edge
  // for furniture, foot y for characters).
  let groundOrder = [];

  function sortGround() {
    // I2: in the isometric preview the ground pass is one painter's algorithm
    // over furniture boxes and characters keyed by (x + y) — the flat
    // station-band re-keying below is meaningless there.
    if (projectionMode === 'iso') return sortIsoGround();
    // 2.5D coded office: the same idea in flat projection (front-bottom edge).
    if (codeSceneOptions.enabled && codeSceneOptions.generatedFurniture) return sortOfficeGround();
    const layer = layers['ground-entities'];
    const ordered = layout.sortGroundEntities(
      [...entities.values()]
        .filter((record) => record.container)
        .map((record) => ({
          footY: record.__snapshot
            ? (projectionMode === 'iso'
              ? (record.__snapshot.position.x + record.__snapshot.position.y)
              : record.__snapshot.position.y)
            : 0,
          layer: 0,
          entityType: 'employee',
          id: record.employeeId,
          record,
        }))
    );

    // M4.1c: interleave the sortY furniture of the SAME container by its
    // bottom edge (screen px), so the world reads as one painter's-algorithm
    // pass: farther (smaller bottom edge) first, nearest last. Characters are
    // placed by footY in the same units.
    const furnitureEntries = [];
    for (const record of furnitureRecords.values()) {
      if (!record.sortable || !record.rect) continue;
      if (record.kind !== 'sprite' && record.kind !== 'graphics') continue;
      const rect = record.mirrorRect || record.rect;
      furnitureEntries.push({
        key: (rect.y + rect.height) * scene.height,
        node: record.node,
        id: record.item.id,
        kind: 'furniture',
        item: record.item,
        rect,
      });
    }
    // 2026-09-22 fix（用户报的图层 bug）：坐在支撑面上的物件（岛台上的电饭煲/米饭碗、
    // 茶几上的电话机…）底边在支撑物底边**之上**，纯底边排序会让支撑物盖住它们。
    // 做法：把这类物件重挂到"最近的下方支撑物的**实际绘制键** + 0.5"。
    // 必须迭代到不动点：支撑物自己也可能被重挂（茶几→水吧），只跑一遍会让先处理的
    // 子物件又落回支撑物之下。键只增不减，因此必然收敛（上限取条目数轮）。
    for (let round = 0; round < furnitureEntries.length; round += 1) {
      let changed = false;
      const rekeyOrder = [...furnitureEntries].sort((a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id)));
      for (const entry of rekeyOrder) {
        // 只对"道具"（kind:'prop'）做重挂：桌子本体/显示器/椅子不与支撑物叠加，
        // 把它们也纳入会破坏"走廊行人压在工位之上"（角色与家具的穿插契约）。
        if (!entry.item || entry.item.kind !== 'prop') continue;
        const footX = entry.rect.x + entry.rect.width / 2;
        const footY = entry.rect.y + entry.rect.height;
        let support = null;
        for (const candidate of furnitureEntries) {
          if (candidate === entry) continue;
          const cRect = candidate.rect;
          if (candidate.key <= entry.key + 0.5) continue;                  // 支撑物必须画在更近处（键更大）
          if (footX < cRect.x || footX > cRect.x + cRect.width) continue;  // 落点需在其水平跨度内
          if (footY < cRect.y - 0.02) continue;                           // 支撑面需在落点之下（允许 2% 场景高余量）
          if (footY > cRect.y + cRect.height) continue;                    // 落点不能低于支撑物底边
          if (!support || candidate.key < support.key) support = candidate;
        }
        if (support) {
          const next = support.key + 0.5;
          if (next > entry.key + 0.25) { entry.key = next; changed = true; }
        }
      }
      if (!changed) break;
    }

    if (furnitureEntries.length > 0) {
      // M4.1h（2026-09-22，用户实测截图反馈）："他工位的桌子图层比鲸鱼娘的图层要高"——
      // 坐在自己工位上的角色被桌体盖住（生产场景 960×630 下中间排 desk-4 整张桌子把
      // 角色压住，其余工位也只差 2~4px）。根因：坐姿角色的排序键是脚点（座位锚点），
      // 而锚点恰好落在桌体底边附近，纯底边排序等于抛硬币。修法与上面 prop 的"支撑物
      // +0.5"同一机制，对象从道具扩展到坐姿角色：脚点落在工位带内的角色按她工位的
      // 堆叠键重挂。工位带 = 桌体的 x 跨度 ×（桌体顶边 → 椅子底边）；堆叠键 = 桌体/
      // 显示器/桌面上家具的底边最大值。只升不降，且必须仍低于椅子键：
      //   - 桌体/显示器在她下面 → 不再被桌面盖住，且保证 ≥0.5px 的稳定余量；
      //   - 椅子底边在堆叠键之下约 60px → 椅背照旧遮住她的下半身（"seated bodies
      //     sit behind" 契约不破坏；重挂键取 min(堆叠键+0.5, 椅子键-0.5)，草稿把
      //     椅子放得再高也恒 < 椅子键，契约在任何草稿下都成立）；
      //   - 走廊行人脚点在椅底更下方（或根本不在工位带内）→ 键不变，仍盖住整张工位
      //     （"the corridor walker draws AFTER the desk" 契约不破坏）；
      //   - 从桌后绕行的角色脚点在桌体顶边之上 → 不在工位带内 → 键不变，仍被桌子
      //     盖住（绕到桌后的读法不变）。
      const stationStacks = new Map(); // prefix -> { back, monitor, chair, stackKey }
      for (const entry of furnitureEntries) {
        const match = /-([a-z]+)$/.exec(entry.id || '');
        if (!match || (match[1] !== 'back' && match[1] !== 'monitor' && match[1] !== 'chair')) continue;
        const prefix = entry.id.slice(0, match.index);
        if (!stationStacks.has(prefix)) stationStacks.set(prefix, { back: null, monitor: null, chair: null, stackKey: -Infinity });
        stationStacks.get(prefix)[match[1]] = entry;
      }
      for (const station of stationStacks.values()) {
        // 缺桌体或椅子的工位不判带（椅子是坐姿遮挡契约的一端，缺了就不重挂）。
        if (!station.back || !station.chair) continue;
        station.stackKey = Math.max(
          station.back.key,
          station.monitor ? station.monitor.key : -Infinity
        );
        // 工位带内、最终排在桌体之后的其它家具（例如被上面 prop 规则重挂到桌体的
        // 道具）也属于这个工位的堆叠：坐姿角色坐在整组构图前面，只让椅子压她。
        for (const other of furnitureEntries) {
          if (other === station.back || other === station.monitor || other === station.chair) continue;
          if (other.key <= station.stackKey || other.key >= station.chair.key) continue;
          const centerX = other.rect.x + other.rect.width / 2;
          if (centerX < station.back.rect.x || centerX > station.back.rect.x + station.back.rect.width) continue;
          station.stackKey = other.key;
        }
      }
      const characterEntries = ordered.map((entry) => ({
        key: (entry.record.__snapshot ? entry.record.__snapshot.position.y : 0) * scene.height,
        node: entry.record.container,
        id: entry.id,
        kind: 'character',
        record: entry.record,
      }));
      for (const entry of characterEntries) {
        const point = entry.record.__snapshot ? entry.record.__snapshot.position : null;
        if (!point) continue;
        for (const station of stationStacks.values()) {
          const back = station.back.rect;
          const chair = station.chair.rect;
          if (point.x < back.x || point.x > back.x + back.width) continue;      // 水平落在桌体跨度内
          if (point.y < back.y || point.y > chair.y + chair.height) continue;   // 桌体顶边 ~ 椅子底边
          // 重挂键 = min(堆叠键 + 0.5, 椅子键 - 0.5)：正常工位（椅子底边在堆叠键
          // 之下约 60px）取堆叠键 + 0.5；草稿若把椅子放得太高（椅子键 - 0.5 反而更
          // 小）就贴着椅子底下取，仍然 > 堆叠键里她原本被盖住的键、且恒 < 椅子键
          // （"seated bodies sit behind" 契约不被任何草稿破坏）。只升不降。
          const target = Math.min(station.stackKey + 0.5, station.chair.key - 0.5);
          if (target > entry.key) entry.key = target;
          break;
        }
      }
      // 2026-09-25（性能）：排序结果与上次**真正挂载**的节点序列完全相同时跳过重排。
      // Pixi 的 addChild 对已在册的节点是"摘下再挂上"（每推 ~38 次），而静止或正常
      // 走动时绘制顺序几乎不变（脚点只在越过别人时才改变相对次序）。用**节点引用**
      // 比较而不是 id：恢复重建后同一 id 是新的节点对象，必须重新挂载（否则新画布空着）。
      const merged = [...characterEntries, ...furnitureEntries];
      merged.sort((a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id)));
      applyGroundOrder(layer, merged);
      return merged.map((entry) => entry.id);
    }
    // 无可排序家具的草稿：角色-only 终序（与旧行为一致——脚点序）。
    const charactersOnly = ordered.map((entry) => ({
      key: (entry.record.__snapshot ? entry.record.__snapshot.position.y : 0) * scene.height,
      node: entry.record.container,
      id: entry.id,
      kind: 'character',
    }));
    applyGroundOrder(layer, charactersOnly);
    return ordered.map((entry) => entry.id);
  }

  // 2026-09-25 回归修复（用户实测：启动/落座时角色与椅子重叠部分闪烁）：
  // 地面层的**唯一**重挂入口。旧实现把"角色-only 的 addChild 前置循环"无条件跑一遍
  // （把所有角色摘下挂到层顶=家具之上），再由 merged 循环恢复穿插序；性能优化给
  // merged 循环加"序未变就跳过"后，这个前置循环的副作用失去了恢复步骤——只要
  // 计算序与账本一致（大多数推送），角色就被留在**所有家具之上**，直到某次真正
  // 越序才短暂恢复，于是角色↔椅子/桌子的遮挡来回翻（闪烁）。修法：先算出**最终**
  // 序（merged 或角色-only），再和真实挂载账本（节点引用）比对，有且仅有差异时
  // 才重挂一次——层的实际 children 序从此恒等于计算序，账本永远不会再"说谎"。
  function applyGroundOrder(layer, finalEntries) {
    const applied = lastAppliedGroundNodes;
    const sameOrder = applied !== null
      && applied.length === finalEntries.length
      && finalEntries.every((entry, index) => applied[index] === entry.node);
    if (!sameOrder) {
      // addChild moves an existing child to the top, so re-adding in sorted
      // order reorders the layer in place without recreating anything.
      for (const entry of finalEntries) layer.addChild(entry.node);
      lastAppliedGroundNodes = finalEntries.map((entry) => entry.node);
    }
    groundOrder = finalEntries.map((entry) => ({ id: entry.id, kind: entry.kind, key: entry.key }));
    return sameOrder;
  }

  // On-demand presentation: snapshot pushes mutate the stage and each push
  // renders once. This avoids any dependency on requestAnimationFrame timing
  // (hidden/background windows throttle rAF) and keeps a single render per
  // state change instead of a per-frame logic loop.
  function renderNow() {
    if (destroyed || mode === 'static' || !app) return;
    // 2026-09-25（性能专项）：视图被切到后台（harness 为当前主视图）时**不做 GPU 重绘**
    // ——画布不在窗口里，没人看得见，而快照推送仍是 62.5Hz。状态照常写进节点
    // （applySnapshot），回到前台时 setVisible(true) 会失效可视签名并补画一次。
    if (!foreground) return;
    // 真实 GPU 重绘计数（diagnostics().paintCount）：回归测试用它断言"静态场景零重绘"
    // 与"可视变化必重画"，探针用它做修复前后的性能对照。
    paintCount += 1;
    try { if (typeof app.render === 'function') app.render(); } catch { /* renderer gone */ }
  }

  // ---- M1: the per-snapshot render path, gated by the render profile -------
  // Stage 0 (full) sorts the ground order and renders on every pushed snapshot
  // whose VISIBLE state changed; stage 1 (low-cost) additionally coalesces to
  // maxRenderHz. Nothing here changes what the entities contain — only how
  // often the pixels are produced — so a downgrade never costs art or state.
  //
  // 2026-09-25（性能专项，用户实测长时间挂机发热）：绘制是"快照推送驱动"的
  // ~62.5Hz，而**没有变化的那一推**同样是全量重排 + 重画（GPU 7.9% + 渲染进程
  // 8.4% 单核，探针实测）。因此把"可视签名不变就跳过"同时用于两档，并把逐员工
  // 签名作为单一真源（场景签名=选择态+各员工签名）。
  //
  // entitySignature 必须覆盖 updateEntity 真正画出来的一切：贴图帧（resource/
  // frameIndex/fallbackReason）、缩放（presentation.heightRatio）、脚点、徽标
  // （queueCount）、标记（marker）、气泡（bubble.text）、选环（selectionId）。
  // 位置按 1e3 量化：亚像素移动不重画（0.001 场景单位 ≈ 1px 的千分之一）。
  function entitySignature(employee) {
    const p = employee.position || {};
    const a = employee.animation || {};
    const presentation = employee.presentation || null;
    const heightRatio = presentation && Number.isFinite(presentation.heightRatio) && presentation.heightRatio > 0
      ? presentation.heightRatio
      : 1;
    return `${Math.round((Number(p.x) || 0) * 1000)}:${Math.round((Number(p.y) || 0) * 1000)}`
      + `:${a.resource || ''}:${Number(a.frameIndex) || 0}:${a.fallbackReason || ''}`
      + `:${heightRatio}:${employee.marker || ''}:${Number(employee.queueCount) || 0}`
      + `:${employee.bubble && employee.bubble.text ? employee.bubble.text : ''}`
      + `:${selectionId === employee.employeeId ? 1 : 0}`;
  }

  function visualSignature(snapshot) {
    let sig = selectionId ? `sel:${selectionId};` : '';
    const employees = snapshot && Array.isArray(snapshot.employees) ? snapshot.employees : [];
    for (const e of employees) {
      if (!e || !e.employeeId) continue;
      sig += `${e.employeeId}:${entitySignature(e)};`;
    }
    // 实体**集合**也要进签名：快照里消失的员工会被 destroy，但画布上还留着旧像素，
    // 必须重画一次（否则"跳过的重画"就等于把已被移除的角色留在画面上）。
    sig += `|ids:${[...entities.keys()].join(',')}`;
    return sig;
  }

  function renderScene(snapshot) {
    const profile = RENDER_PROFILES[renderProfileIndex] || RENDER_PROFILES[0];
    if (profile.skipUnchanged) {
      const sig = visualSignature(snapshot);
      if (sig === lastRenderSignature) return; // nothing visible changed
    }
    if (profile.maxRenderHz > 0) {
      const nowMs = clockNow();
      if (lastRenderAtMs !== null && nowMs - lastRenderAtMs < 1000 / profile.maxRenderHz) {
        // Too soon: skip this redraw WITHOUT recording the signature, so the
        // next push re-evaluates and paints the accumulated state. Pushes are
        // continuous (~62.5 Hz), so the picture is at most one slot stale.
        return;
      }
      lastRenderAtMs = nowMs;
    }
    if (mode !== 'static') sortGround();
    if (profile.skipUnchanged) lastRenderSignature = visualSignature(snapshot);
    renderNow();
  }

  function applySnapshot(snapshot) {
    if (destroyed || !snapshot || !Array.isArray(snapshot.employees)) return;
    currentSnapshot = snapshot;
    // Buffer this push as the new interpolation target. `nowMs` is read once so
    // the capture and the first frame of this push share one timestamp.
    const nowMs = presentationNow();
    if (presentationClock) presentationClock.capture(snapshot, nowMs);
    if (snapshot.scene && Number.isFinite(snapshot.scene.referenceWidth)) {
      // logical reference size only; projection keeps using the live scene
    }
    const seen = new Set();
    for (const employee of snapshot.employees) {
      if (!employee || !employee.employeeId) continue;
      seen.add(employee.employeeId);
      // 2026-09-24 latch fix: a snapshot that lands while the view is static
      // (the office:state pushes keep flowing during a bounded-recovery
      // rebuild's init await) creates records WITHOUT Pixi nodes. Such a
      // record can never be updated in place — rebuild its nodes instead of
      // throwing on the missing sprite.
      const existing = entities.get(employee.employeeId);
      const record = existing && existing.container ? existing : createEntity(employee.employeeId);
      // 2026-09-25（性能）：该员工的可视签名没变（且节点齐备）时跳过 updateEntity
      // ——shadow/ring/placeholder 的 Graphics 重建与 badge/marker/bubble 的文本
      // 写入在 62.5Hz 下是纯浪费（探针实测每秒上千次几何重建）。位置量化相等时
      // 仍把最新快照挂上 record：sortGround 用它的 footY 排序。
      const sig = entitySignature(employee);
      if (record.__sig === sig && record.container) {
        record.__snapshot = employee;
        continue;
      }
      record.__sig = sig;
      updateEntity(record, employee);
    }
    // An employee that truly left the snapshot is removed; residents never do.
    for (const [id, record] of [...entities]) {
      if (!seen.has(id)) {
        if (record.container) {
          record.container.destroy({ children: true });
          record.__badge.destroy();
          record.__marker.destroy();
          record.__selectionRing.destroy();
        }
        entities.delete(id);
      }
    }
    // P3.0: paint at the interpolated point, then keep the frame pump running
    // for as long as the samples are still converging. renderScene() below may
    // skip the repaint (visual signature unchanged), but a moving entity always
    // changes its quantized foot point, so the first frame of a push paints.
    if (presentationClock) {
      applyPresentationFrame(nowMs);
      if (presentationClock.interpolating(nowMs)) schedulePresentationFrame();
    }
    // M1: the render profile decides whether this push paints (full profile:
    // always, exactly as before).
    renderScene(snapshot);
  }

  // ---- init chain: webgl -> canvas -> static (shared by boot and recovery) --
  // Returns the live mode ('webgl' | 'canvas' | 'static'); leaves `app`,
  // `stage`, `layers` and `diagnosticCode` consistent with it. `recordMissing`
  // is false on the recovery rebuild: the furniture texture load diagnostics
  // were already reported at boot and must not be duplicated.
  async function initApplication({ recordMissing = true } = {}) {
    if (!PIXI || typeof PIXI.Application !== 'function') {
      diagnosticCode = 'RENDERER_UNAVAILABLE';
      mode = 'static';
      buildStaticFallback();
      return mode;
    }
    const webgl = await tryInitApplication('webgl');
    if (destroyed) { discardFailedApplication(webgl.app); return 'static'; }
    if (webgl.ok) {
      app = webgl.app;
      mode = 'webgl';
    } else {
      diagnosticCode = 'WEBGL_INIT_FAILED';
      discardFailedApplication(webgl.app);
      const canvas = await tryInitApplication('canvas');
      if (destroyed) { discardFailedApplication(canvas.app); return 'static'; }
      if (canvas.ok) {
        app = canvas.app;
        mode = 'canvas';
      } else {
        discardFailedApplication(canvas.app);
        app = null;
        mode = 'static';
      }
    }
    if (mode !== 'static') {
      buildLayers();
      buildFurniture({ recordMissing });
      if (mount && app.canvas && mount.appendChild) mount.appendChild(app.canvas);
      app.ticker.stop(); // rendering happens on snapshot pushes, not on a clock
      // 2026-09-25（性能）：可视签名的跳过逻辑必须在新画布上失效——否则重建后
      // 的第一次 applySnapshot 会因为"场景没变"而跳过重画，新画布停在空白。
      lastRenderSignature = null;
    } else {
      buildStaticFallback();
    }
    return mode;
  }

  // Keeps the exposed view object in sync with the live renderer state (the
  // view captured these values at creation time).
  function syncViewSurface() {
    if (typeof view === 'object' && view) {
      view.mode = mode;
      view.diagnosticCode = diagnosticCode;
      view.staticElement = staticElement;
      view.app = app;
      view.stage = stage;
      view.layers = layers;
    }
  }

  function notifyStateChange() {
    if (typeof onStateChange !== 'function') return;
    try { onStateChange({ mode, diagnosticCode, recoveryAttempts }); } catch { /* observer errors never break the renderer */ }
  }

  // ---- public surface -------------------------------------------------------

  await initApplication();

  if (currentSnapshot) applySnapshot(currentSnapshot);
  if (selectionId && mode !== 'static') applySelection();

  // ---- runtime FPS observer (Task 9 blocker B / SPEC-07) --------------------
  // Presentation-rate observer only: it counts presented frames through an
  // injectable clock and NEVER advances movement, animation or any office
  // state — the single simulation clock stays in the main process. Sustained
  // sub-threshold presentation degrades THIS view to the static diagnostic
  // presentation (LOW_FPS_PERSISTENT, distinct from WEBGL_INIT_FAILED /
  // RENDERER_UNAVAILABLE). When the caller does not arm `fpsMonitor`, nothing
  // is scheduled and behavior is unchanged.
  //
  // 2026-09-24 latch fix: the pump is gated on `foreground`. While the view is
  // NOT the active main-area view (detached from the window by
  // syncShellViews()), no frames are fed — a detached view still presents at
  // 1.3-7.9 fps and feeding those frames latched LOW_FPS_PERSISTENT after
  // ~2 minutes in the harness, permanently killing the scene. The foreground
  // transition resets the monitor window so detached-rate frames can never
  // share a measurement window with foreground frames.
  let monitor = null;
  let pumpHandle = null;
  let scheduleFrame = null;
  let cancelFrame = null;
  // Bounded LOW_FPS_PERSISTENT recovery (SPEC-07 contract correction): at most
  // ONE rebuild attempt per re-activation and 3 per view session. The counter
  // is exposed through diagnostics() so the shell log records every attempt.
  const RECOVERY_LIMIT_PER_SESSION = 3;
  let recoveryAttempts = 0;
  let rebuildInFlight = null;
  if (fpsMonitor && mode !== 'static') {
    scheduleFrame = fpsMonitor.scheduleFrame
      || (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
    cancelFrame = fpsMonitor.cancelFrame
      || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : null);
  }
  function pump() {
    pumpHandle = null;
    if (destroyed || !foreground || !presenting || !monitor || monitor.degraded()) return;
    monitor.frame();
    schedulePump();
  }
  function schedulePump() {
    if (destroyed || !foreground || !presenting || !monitor || monitor.degraded() || pumpHandle !== null || !scheduleFrame) return;
    pumpHandle = scheduleFrame(pump);
    armStallPoll();
  }
  function stopPump() {
    if (pumpHandle !== null && cancelFrame) {
      try { cancelFrame(pumpHandle); } catch { /* already canceled */ }
    }
    pumpHandle = null;
    stopStallPoll();
  }
  // ---- M1: stall watchdog --------------------------------------------------
  // The monitor is pure (no timers), so the view owner polls it: while the pump
  // is armed, an overdue window is closed even when NO frame arrived. A
  // renderer that stops presenting entirely (dead rAF pump, lost context) used
  // to be invisible to the observer under frame-count windows; now it produces
  // 0-fps windows and still reaches the degrade ladder. Armed only when the
  // policy asks for it (stallMs/windowMs > 0), so legacy configs schedule
  // nothing.
  function armStallPoll() {
    if (!monitor || !stallPollMs || !scheduleTimeout || stallTimer !== null) return;
    if (destroyed || !foreground || !presenting || monitor.degraded()) return;
    stallTimer = scheduleTimeout(() => {
      stallTimer = null;
      if (destroyed || !foreground || !presenting || !monitor || monitor.degraded()) return;
      // poll() routes a latch through the monitor's onDegrade → handleLowFpsLatch
      // exactly like frame() does. The return value must NOT be handled here as
      // well: that would walk the ladder twice for one latch.
      if (typeof monitor.poll === 'function') monitor.poll();
      // Self-sustaining while the view is foreground: a dead rAF pump (no frame
      // callback ever fires, so schedulePump() is never re-entered) must still
      // be able to walk the degrade ladder.
      if (destroyed || !foreground || !monitor || monitor.degraded()) return;
      armStallPoll();
    }, stallPollMs);
  }
  function stopStallPoll() {
    if (stallTimer !== null && cancelTimeout) {
      try { cancelTimeout(stallTimer); } catch { /* already gone */ }
    }
    stallTimer = null;
  }
  function resetMonitor() {
    // Re-arms the observer with a fresh measurement window. Only ever called
    // at the foreground transition, after a render-profile downgrade, and after
    // a successful recovery rebuild — the monitor never re-arms itself.
    if (monitor && typeof monitor.reset === 'function') monitor.reset();
  }

  // ---- M1: the degrade ladder ---------------------------------------------
  // A LOW_FPS_PERSISTENT latch means "this view cannot hold thresholdFps right
  // now". Throwing the scene away (static diagnostics, no art) is the LAST
  // resort, not the first response:
  //   1. step down to the low-cost render profile — the full art and state are
  //      kept, fewer pixels per second are produced (no Pixi rebuild);
  //   2. if the low-cost profile still cannot hold the rate, settle in the
  //      static diagnostic presentation — but ONLY if the measured rate is
  //      below staticFloorFps. A scene that still presents ~10+ fps is "slow",
  //      not "broken": it stays on the living low-cost profile (the footer dot
  //      explains the downgrade and the static fallback's 「重试渲染」 remains
  //      the manual road back).
  // Returns the step that was taken: 'render-profile' | 'kept-low-cost' |
  // 'static'.
  function handleLowFpsLatch() {
    lowFpsEvents += 1;
    if (renderProfileIndex < RENDER_PROFILES.length - 1) {
      renderProfileIndex = Math.min(RENDER_PROFILES.length - 1, renderProfileIndex + 1);
      resetMonitor();   // the downgraded profile gets its own fair measurement window
      schedulePump();
      syncViewSurface();
      notifyStateChange();
      return 'render-profile';
    }
    const stats = monitor && typeof monitor.stats === 'function' ? monitor.stats() : null;
    const measured = stats && typeof stats.lastFps === 'number' ? stats.lastFps : null;
    if (staticFloorFps > 0 && measured !== null && measured >= staticFloorFps) {
      resetMonitor();
      schedulePump();
      syncViewSurface();
      notifyStateChange();
      return 'kept-low-cost';
    }
    degradeToStatic('LOW_FPS_PERSISTENT');
    return 'static';
  }

  function degradeToStatic(code) {
    if (destroyed || mode === 'static') return;
    diagnosticCode = code;
    stopPump();
    for (const record of entities.values()) {
      if (record.container) {
        try { record.container.destroy({ children: true, texture: false }); } catch { /* already gone */ }
        try { if (record.__badge && record.__badge.destroy) record.__badge.destroy(); } catch { /* already gone */ }
        try { if (record.__marker && record.__marker.destroy) record.__marker.destroy(); } catch { /* already gone */ }
      }
    }
    entities.clear();
    // 2026-09-25（用户实测：点「重新渲染」后办公室变成灰块/无贴图场景）：
    // 注入的美术贴图**不能在这里释放**。`textures`（角色帧）与 `officeTextureMap`
    // （家具素材）由办公室页面在 boot 时一次性加载并注入本视图，页面从不重建它们；
    // 而 degradeToStatic 之后可能发生有界恢复重建、或用户点「重试渲染」——两条路径
    // 都要靠这两张 map 重新贴图。旧实现在这里把两张 map 里的 texture 逐个 destroy
    // 再 clear，于是恢复出来的场景只剩占位图（家具 32 件全灰块、角色空贴图）。
    // 复现：latch 到 static → retryRendering → officeTextureCount 15→0、
    // texturedFurniture 32→0、placeholderFurniture 0→32（真壳探针，见
    // docs/archive/strategy/2026-09-25-v0.4.0-release-verification.md）。
    // 真正的释放点是 destroy()（视图销毁）——那里的语义不变。
    if (app) {
      // Pixi's destroy() leaves the canvas in the DOM (removeView defaults to
      // false). Detach it here so a later bounded-recovery rebuild mounts
      // exactly one canvas and the static fallback owns the stage.
      try {
        if (app.canvas && app.canvas.parentNode) app.canvas.parentNode.removeChild(app.canvas);
      } catch { /* host already gone */ }
      try { app.destroy(true, { children: true, texture: false }); } catch { /* already gone */ }
    }
    app = null;
    stage = null;
    layers = null;
    mode = 'static';
    buildStaticFallback();
    // Hard failures are not retryable — the retry affordance must say so
    // instead of offering an action that cannot work.
    refreshStaticRetry();
    // Keep the exposed view surface consistent with the degraded state (the
    // view object captured these values at creation time).
    syncViewSurface();
    notifyStateChange();
  }

  // ---- bounded recovery from LOW_FPS_PERSISTENT (2026-09-24) ---------------
  // Rebuild the Pixi application, layers and furniture, then restore the
  // entities from the last pushed snapshot (degradeToStatic already cleared
  // entities/textures; the snapshot is the only source of entity truth, and
  // it keeps flowing from the single main-process clock). ONE attempt per
  // re-activation, at most RECOVERY_LIMIT_PER_SESSION per session, and ONLY
  // for LOW_FPS_PERSISTENT: WEBGL_INIT_FAILED / RENDERER_UNAVAILABLE are hard
  // failures (a fresh application would fail exactly the same way), so they
  // stay static forever on purpose.
  async function rebuildRenderer() {
    if (destroyed) return 'failed';
    if (staticElement && typeof staticElement.remove === 'function') {
      try { staticElement.remove(); } catch { /* host already gone */ }
    }
    staticElement = null;
    // Boots the shared init chain (webgl -> canvas -> static): it builds the
    // layers + furniture, mounts the fresh canvas and stops the ticker.
    const next = await initApplication({ recordMissing: false });
    if (destroyed) return 'failed';
    if (next === 'static') {
      // The rebuild hit a HARD failure (WEBGL_INIT_FAILED — initApplication
      // already set diagnosticCode and built the static fallback). That code
      // is never retried by the recovery policy.
      syncViewSurface();
      notifyStateChange();
      return 'failed';
    }
    diagnosticCode = null;
    // A half-rebuilt view must never stay "live": if anything below throws
    // (e.g. a host/Pixi hiccup), tear the fresh application down and settle
    // in the static diagnostic presentation with a stable hard-failure code
    // instead of leaving mode='webgl' over a broken stage.
    try {
      if (currentSnapshot) applySnapshot(currentSnapshot);
      if (selectionId) applySelection();
      resetMonitor(); // fresh measurement window for the rebuilt view
      schedulePump();
    } catch {
      degradeToStatic('RENDERER_UNAVAILABLE');
      return 'failed';
    }
    syncViewSurface();
    notifyStateChange();
    return 'recovered';
  }

  // Returns 'recovered' | 'failed' | 'exhausted' | 'none'. `none` means no
  // attempt was warranted (already live, or a hard-failure code).
  function attemptRecovery() {
    if (destroyed) return 'none';
    if (mode !== 'static') return 'none';
    if (diagnosticCode !== 'LOW_FPS_PERSISTENT') return 'none'; // hard failure: never retry
    if (recoveryAttempts >= RECOVERY_LIMIT_PER_SESSION) return 'exhausted';
    recoveryAttempts += 1;
    if (!rebuildInFlight) {
      rebuildInFlight = rebuildRenderer()
        .catch(() => 'failed') // never throws into the page
        .finally(() => { rebuildInFlight = null; });
    }
    return rebuildInFlight;
  }

  if (fpsMonitor && mode !== 'static' && scheduleFrame) {
    monitor = createFpsMonitor({
      thresholdFps: fpsMonitor.thresholdFps,
      windowFrames: fpsMonitor.windowFrames,
      lowWindowLimit: fpsMonitor.lowWindowLimit,
      // M1: 0 (absent) keeps the historical frame-count windows; the office
      // page arms a time window (OFFICE_LOW_FPS_POLICY).
      windowMs: fpsMonitor.windowMs,
      now: fpsMonitor.now,
      // M1: the latch no longer goes straight to static — the ladder steps down
      // to the low-cost render profile first and only then falls back.
      onDegrade: () => handleLowFpsLatch(),
    });
    schedulePump();
  }

  function applySelection() {
    for (const [id, record] of entities) {
      if (record.__selectionRing) record.__selectionRing.visible = id === selectionId;
    }
  }

  // ---- M1: user-requested retry -------------------------------------------
  // The static presentation is not a dead end: the user gets a visible
  // 「重试渲染」 entry (built into the fallback element) that runs the SAME
  // bounded rebuild the automatic recovery uses. It has its OWN per-session
  // budget (the automatic policy's 3 per session / 1 per activation is
  // untouched) and restores the full render profile, because a user asking for
  // the scene back wants the full-quality scene. Returns
  // 'recovered' | 'failed' | 'exhausted' | 'none' | 'none(not-static)'.
  function retryRendering() {
    if (destroyed) return Promise.resolve('none');
    if (mode !== 'static') return Promise.resolve('none');
    if (diagnosticCode !== 'LOW_FPS_PERSISTENT') return Promise.resolve('none'); // hard failure: a rebuild cannot help
    if (manualRetryAttempts >= MANUAL_RETRY_LIMIT_PER_SESSION) {
      refreshStaticRetry();
      return Promise.resolve('exhausted');
    }
    manualRetryAttempts += 1;
    renderProfileIndex = 0;
    refreshStaticRetry();
    if (!rebuildInFlight) {
      rebuildInFlight = rebuildRenderer()
        .catch(() => 'failed') // never throws into the page
        .finally(() => { rebuildInFlight = null; });
    }
    return rebuildInFlight;
  }

  const view = {
    mode,
    diagnosticCode,
    app,
    stage,
    layers,
    entities,
    staticElement,
    // Armed FPS observer (null when the caller did not arm fpsMonitor).
    // Exposed so tests and evidence harnesses can drive injected frames.
    fpsMonitor: monitor,

    // M1: the visible retry entry runs this (the fallback element's button is
    // wired to it in attachStaticRetry).
    retryRendering,

    applySnapshot,

    resize({ width, height }) {
      if (destroyed) return;
      scene = { width, height };
      if (mode !== 'static' && app && app.renderer) app.renderer.resize(width, height);
      if (mode === 'static') return;
      // furniture nodes persist: resize only re-projects transforms/rects,
      // so sprite identity and texture references are never recreated.
      // The iso camera must be rebuilt BEFORE anything projects through it.
      if (projectionMode === 'iso') rebuildIsoCamera();
      if (layers) { layoutFurniture(); sortGround(); }
      // 2026-09-25（性能）：缩放是"投影变了、快照没变"——两处跳过逻辑都必须失效：
      // 场景可视签名（强制重画一次）与逐员工签名（强制重投影脚点/缩放/字号）。
      lastRenderSignature = null;
      for (const record of entities.values()) record.__sig = null;
      if (projectionMode === 'iso') {
        if (currentSnapshot) presentationClock && presentationClock.reset();
      }
      if (currentSnapshot) applySnapshot(currentSnapshot);
      else renderNow();
    },

    setSelection(employeeId) {
      selectionId = employeeId || null;
      if (mode !== 'static') applySelection();
    },

    // 2026-10-30（用户："原来脚下有个圆形交互区，改成鼠标放到鲸鱼娘全身"）：
    // 旧实现是**以脚点为圆心的圆**（半径 0.35 可见高度），于是只有点到角色
    // 脚下那块地面才命中，点上半身尤其是头部完全没反应 —— 与"看着点在身上
    // 却没反应"的直觉严重不符。
    //
    // 新实现用 updateEntity 记下的 `__bodyBox`（角色立绘的真实矩形占位）：
    // 鼠标落在角色身体的任意部位都命中，且**不会超出身体边界**（盒子就是
    // 画出来的那个人；两侧透明留白已经按纹理长宽比收窄掉了）。
    //
    // 重叠时按"离盒中心最近"挑一个；盒内再按纵向位置做一点权重，让点头部
    // 更倾向选这一个人而不是身后经过的另一个。
    hitTest(px, py) {
      if (mode === 'static' || destroyed) return null;
      let best = null;
      let bestScore = Infinity;
      for (const record of entities.values()) {
        if (!record.__snapshot) continue;
        const box = record.__bodyBox;
        if (!box) {
          // 兜底：还没画过身体盒的（极端早期帧）仍用旧圆形判定
          const foot = record.__footPx;
          if (!foot) continue;
          const d = Math.hypot(foot.x - px, foot.y - py);
          if (d <= Math.max(24, record.__layout.visibleHeight * 0.35) && d < bestScore) {
            best = record.employeeId;
            bestScore = d;
          }
          continue;
        }
        if (px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1) continue;
        const cx = (box.x0 + box.x1) / 2;
        const cy = (box.y0 + box.y1) / 2;
        const halfH = Math.max(1, (box.y1 - box.y0) / 2);
        // 纵向归一化距离（0 = 身体中线，1 = 头顶/脚底），横向按像素
        const score = Math.abs(px - cx) + Math.abs(py - cy) / halfH * 12;
        if (score < bestScore) {
          best = record.employeeId;
          bestScore = score;
        }
      }
      return best;
    },

    // P3.1: the shell theme switch. The page calls this on every theme push;
    // the scene re-tints furniture and redraws its floor/walls in place.
    setSceneTheme(theme) {
      if (destroyed || !codeSceneOptions.enabled) return { ok: false, code: 'CODE_SCENE_DISABLED' };
      const next = theme === 'dark' ? 'dark' : 'light';
      if (next === codeSceneOptions.theme) return { ok: true, theme: next };
      codeSceneOptions.theme = next;
      furnitureTint = next === 'dark' ? 0x878b8f : null;
      for (const record of furnitureRecords.values()) {
        if (record.kind !== 'sprite' || !record.node) continue;
        const tint = furnitureTintFor(record.item);
        record.node.tint = tint === null ? 0xffffff : tint;
      }
      layoutFurniture();
      lastRenderSignature = null;
      renderNow();
      return { ok: true, theme: next };
    },

    // ---- P3.3 drag (presentation only) ------------------------------------
    // The caller (page) converts pointer pixels to scene pixels. Nothing here
    // touches the simulation: the character is drawn at base + offset and, on
    // release, eases back to wherever the snapshot already says it is.
    beginDrag(employeeId) {
      if (destroyed || mode === 'static') return null;
      const record = entities.get(employeeId);
      if (!record || !record.container || !record.__footPx) return null;
      dragState.employeeId = employeeId;
      dragState.baseFoot = { x: record.__footPx.x, y: record.__footPx.y };
      dragState.dx = 0;
      dragState.dy = 0;
      dragState.release = null;
      return { x: dragState.baseFoot.x, y: dragState.baseFoot.y };
    },

    dragTo(dx, dy) {
      if (!dragState.employeeId || dragState.release) return false;
      const nx = Number(dx);
      const ny = Number(dy);
      dragState.dx = Number.isFinite(nx) ? nx : 0;
      dragState.dy = Number.isFinite(ny) ? ny : 0;
      applyPresentationFrame(presentationNow());
      renderNow();
      return true;
    },

    // 2026-10-30（用户："拖拽后会回到原来的位置，我想拖到哪就停到哪"）：
    // 原来这里是 "presentation only" —— 松手后缓动回快照位置（见下方 release
    // 分支），用户的拖拽等于白做。现在改为把**拖拽落点**回报给页面，由页面
    // 调 office:place 把它写回模拟位置，角色就真的停在放手的地方。
    //
    // 返回值新增 `dropPosition`（归一化场景坐标）。仍保留 from（脚点屏幕像素）
    // 以兼容既有调用方与测试。
    endDrag() {
      if (!dragState.employeeId) return null;
      const draggedId = dragState.employeeId;
      const record = entities.get(draggedId);
      const from = record && record.__footPx ? { x: record.__footPx.x, y: record.__footPx.y } : null;
      // 放手处 = 快照脚点（__placedAt）+ 本次拖拽的累计位移。
      // __placedAt 记的是"这一帧快照的位置"（不含拖拽偏移，偏移由容器
      // position 承载），所以拖拽量必须显式加回来。
      const placed = record && record.__placedAt ? record.__placedAt : from;
      const dropPx = placed
        ? { x: placed.x + (dragState.dx || 0), y: placed.y + (dragState.dy || 0) }
        : null;
      const dropPosition = dropPx
        ? { x: dropPx.x / Math.max(1, scene.width), y: dropPx.y / Math.max(1, scene.height) }
        : null;
      if (!presentationClock || !from) {
        // No animation pump: snap back to the simulation position immediately.
        clearDrag();
        if (record && record.__snapshot) {
          placeEntity(record, record.__snapshot.position, presentationNow());
          renderNow();
        }
        return { from, dropPosition, employeeId: draggedId };
      }
      dragState.release = { from, at: presentationNow() };
      dragState.baseFoot = null;
      dragState.dx = 0;
      dragState.dy = 0;
      schedulePresentationFrame();
      return { from, dropPosition, employeeId: draggedId };
    },

    isDragging: () => dragState.employeeId !== null,

    dragOffset: () => (dragState.employeeId
      ? { dx: dragState.dx, dy: dragState.dy, releasing: dragState.release !== null }
      : null),

    setReducedMotion() {
      // The renderer has no autonomous motion to reduce (single-clock design);
      // reduced motion is enforced by the main-process simulator. Kept as a
      // stable API for the page.
    },

    // 2026-09-24 latch fix: `visible` means "this view is the foreground /
    // active main-area view" — the office:visibility payload's `active` flag,
    // NOT the window visibility flag (a hidden window stops rAF entirely, so
    // it cannot feed the monitor anyway; and a detached view still presents
    // frames at background rate, which is what used to latch the monitor).
    //   false -> stopPump(): the presentation-rate observer stops counting.
    //     Rendering is snapshot-push driven (app.ticker stays stopped), so the
    //     picture is unaffected while the simulation keeps updating in the
    //     main process. backgroundThrottling is deliberately NOT touched — it
    //     keeps the page's boot/snapshot pump alive in the background.
    //   true  -> on a real false->true transition: reset the monitor's
    //     measurement window (detached-rate frames must never share a window
    //     with foreground frames) and re-arm the pump; if the view is sitting
    //     in the static LOW_FPS_PERSISTENT diagnostic, attempt ONE bounded
    //     recovery rebuild (at most once per activation, 3 per session).
    // Returns a promise that resolves to
    //   { mode, diagnosticCode, recovery: 'none'|'recovered'|'failed'|'exhausted' }.
    // It never rejects: a failed rebuild stays static with a stable code.
    setVisible(visible) {
      const next = !!visible;
      if (destroyed) return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
      if (!next) {
        foreground = false;
        stopPump();
        stopPresentationFrames();
        return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
      }
      const becameForeground = !foreground;
      foreground = true;
      // Returning to the foreground resumes the presentation pump too: a push
      // that arrived while detached left an un-finished interpolation segment.
      if (presentationClock && presentationClock.interpolating(presentationNow())) schedulePresentationFrame();
      if (!becameForeground) {
        // Already foreground (e.g. a window focus event): never a new attempt.
        return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
      }
      // 回前台必须补画一次：后台期间 renderNow() 被跳过（没人看得见），画布内容停在
      // 切走那一刻；失效可视签名让下一次推送（≤16ms）重画。
      lastRenderSignature = null;
      // 2026-09-25 唤醒自愈：屏幕未呈现（锁屏/息屏/挂起）期间不尝试恢复、不重arm
      // 泵——恢复预算不得在无人观看时消耗；唤醒沿（setPresenting(true)）接管这两
      // 件事（丢弃在途窗口 + 自愈/重arm）。
      if (mode === 'static' && diagnosticCode === 'LOW_FPS_PERSISTENT' && presenting) {
        return Promise.resolve(attemptRecovery()).then((recovery) => ({ mode, diagnosticCode, recovery }));
      }
      resetMonitor();
      if (presenting) schedulePump();
      return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
    },

    // 2026-09-25 唤醒自愈：`presenting` 表示「屏幕正在呈现本视图」（office:visibility
    // 载荷的 `presenting` 字段，main 进程 powerMonitor 信号的下游）。
    //   false -> 泵停 + 看门狗停：观察器在锁屏/息屏/挂起期间什么也不计量（节流帧
    //     是环境事实，不是渲染缺陷），恢复预算也不消耗。在途测量窗口保持打开，
    //     唤醒时由 resetMonitor() 丢弃。
    //   true  -> 唤醒/重新呈现（false→true 沿）：若视图正停在 LOW_FPS_PERSISTENT
    //     静态诊断，自动尝试一次有界重建——复用 attemptRecovery（每次唤醒至多
    //     1 次、会话上限 3、硬失败 WEBGL_INIT_FAILED/RENDERER_UNAVAILABLE 永不
    //     重试，与前台恢复共用同一份预算与路径），用户无需切视图或点「重试渲染」；
    //     否则丢弃节流期的在途窗口并重arm泵。重复的同值调用是 no-op（一次唤醒
    //     只有一个下行沿，unlock-screen 与 resume 同时到达也只算一次）。
    // 返回 { mode, diagnosticCode, recovery }，与 setVisible 同形，不 reject。
    setPresenting(value) {
      const next = !!value;
      if (destroyed || next === presenting) {
        return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
      }
      presenting = next;
      if (!next) {
        stopPump();
        stopPresentationFrames();
        return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
      }
      if (mode === 'static' && diagnosticCode === 'LOW_FPS_PERSISTENT') {
        return Promise.resolve(attemptRecovery()).then((recovery) => ({ mode, diagnosticCode, recovery }));
      }
      resetMonitor();
      schedulePump();
      if (presentationClock && presentationClock.interpolating(presentationNow())) schedulePresentationFrame();
      return Promise.resolve({ mode, diagnosticCode, recovery: 'none' });
    },

    pause() {
      if (destroyed || mode === 'static') return;
      paused = true;
      stopPresentationFrames();
      if (app && app.ticker) app.ticker.stop();
    },

    resume() {
      if (destroyed || mode === 'static') return;
      paused = false;
      if (app && app.ticker) app.ticker.start();
      if (presentationClock && presentationClock.interpolating(presentationNow())) schedulePresentationFrame();
    },

    isPaused: () => paused,

    diagnostics() {
      return {
        mode,
        diagnosticCode,
        // 2026-09-24 latch-fix observability: the bounded-recovery budget is
        // part of the renderer state the shell log records.
        recoveryAttempts,
        // 2026-09-25：累计真实重绘次数（"静态场景零重绘"回归判据 + 性能对照口径）。
        paintCount,
        // M1 observability: the render-profile stage (the degrade ladder), the
        // manual retry budget and the low-fps event count, plus the observer's
        // own window telemetry. Never affects the decision.
        renderProfile: (RENDER_PROFILES[renderProfileIndex] || RENDER_PROFILES[0]).id,
        renderProfileIndex,
        lowFpsEvents,
        manualRetryAttempts,
        // 2026-09-25 唤醒自愈：呈现门控的当前值（探针/证据用它核对「锁屏期间停表」）。
        presenting,
        // P3.0 observability: whether the presentation pump exists at all and
        // how many interpolated frames it has drawn. `enabled:false` (or a host
        // without rAF) is the historical paint-on-push behaviour.
        presentation: {
          enabled: !!presentationClock,
          frames: presentationFrames,
          scheduled: presentationFrameHandle !== null,
          interpolating: presentationClock ? presentationClock.interpolating(presentationNow()) : false,
          buffers: presentationClock ? presentationClock.stats() : null,
        },
        // P3.1: the code-drawn scene switch + the geometry it last produced.
        projection: projectionMode,
        codeScene: {
          enabled: codeSceneOptions.enabled,
          theme: codeSceneOptions.theme,
          accent: codeSceneOptions.accent,
          characterScale: codeSceneOptions.enabled ? codeSceneOptions.characterScale : 1,
          codeMonitorCount: codeSceneOptions.enabled
            ? [...furnitureRecords.values()].filter((record) => record.kind === 'code').length
            : 0,
          generatedFurniture: codeSceneOptions.generatedFurniture,
          generatedDesks: codeSceneOptions.enabled && officeDescription ? officeDescription.stats.deskCount : 0,
          generatedLounge: !!(codeSceneOptions.enabled && officeDescription && officeDescription.stats.hasLounge),
          generatedKitchen: !!(codeSceneOptions.enabled && officeDescription && officeDescription.stats.hasKitchen),
          generatedGroups: codeSceneOptions.enabled && officeDescription ? officeDescription.stats.groupCount : 0,
          generatedParts: codeSceneOptions.enabled && officeDescription ? officeDescription.stats.partCount : 0,
          ...(codeSceneStats || {}),
          // I2: iso furniture is only present in the preview projection.
          isoFurniture: projectionMode === 'iso' && isoDescription ? { ...isoDescription.stats } : null,
          isoPartNodeCount: isoFurniture.size,
        },
        fps: monitor && typeof monitor.stats === 'function' ? monitor.stats() : null,
        foreground,
        scene: { ...scene },
        devicePixelRatio: clamp(Number(devicePixelRatio) || 1, 1, 3),
        entityCount: entities.size,
        textureCount: textures.size,
        officeTextureCount: officeTextureMap.size,
        officeTextureMissing: officeTextureMissing.length,
        visibleHeight: computeVisibleHeight(scene.height),
        packMissing: !pack,
      };
    },

    // Task 3 golden-workstation diagnostics: which furniture parts render
    // from managed textures, which fell back to placeholders, and the stable
    // OFFICE_TEXTURE_MISSING entries (asset id + loader reason) for anything
    // declared by a calibrated workstation but not usable.
    officeDiagnostics() {
      const textured = [];
      const placeholder = [];
      for (const record of furnitureRecords.values()) {
        if (record.kind === 'sprite') textured.push(record.item.id);
        if (record.kind === 'graphics') placeholder.push(record.item.id);
      }
      return {
        code: officeTextureMissing.length > 0 ? 'OFFICE_TEXTURE_MISSING' : null,
        missing: officeTextureMissing.map((entry) => ({ ...entry })),
        texturedFurniture: textured,
        placeholderFurniture: placeholder,
      };
    },

    // Explicit paint order for furniture nodes (back-furniture bottom-up,
    // then front occluders): the order children were mounted in.
    groundPaintOrder() {
      return groundOrder.map((entry) => ({ ...entry }));
    },

    furniturePaintOrder() {
      return [...furnitureRecords.values()]
        .filter((record) => record.kind === 'sprite' || record.kind === 'graphics')
        .map((record) => ({
          id: record.item.id,
          role: furnitureRole(record.item),
          layer: record.item.layer,
          // The container the node actually lives in: sortY items paint inside
          // the merged ground-entities pass, everything else on its declared layer.
          paintsIn: record.node && record.node.parent ? record.node.parent.__layerId : null,
          sortY: record.sortable === true,
          textured: record.kind === 'sprite',
          // Live scene-px rect (diagnostics for probes/tests that check occlusion).
          rectPx: record.rect ? {
            x: (record.mirrorRect || record.rect).x * scene.width,
            y: (record.mirrorRect || record.rect).y * scene.height,
            width: (record.mirrorRect || record.rect).width * scene.width,
            height: (record.mirrorRect || record.rect).height * scene.height,
          } : null,
        }));
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPresentationFrames();
      if (presentationClock) presentationClock.reset();
      stopPump();
      for (const record of furnitureRecords.values()) {
        if (record.node) {
          try { record.node.destroy({ children: true }); } catch { /* already gone */ }
        }
      }
      furnitureRecords.clear();
      for (const record of entities.values()) {
        if (record.container) {
          try { record.container.destroy({ children: true, texture: false }); } catch { /* already gone */ }
          try { if (record.__badge.destroy) record.__badge.destroy(); } catch { /* already gone */ }
          try { if (record.__marker.destroy) record.__marker.destroy(); } catch { /* already gone */ }
          try { if (record.__selectionRing.destroy) record.__selectionRing.destroy(); } catch { /* already gone */ }
        }
      }
      entities.clear();
      for (const texture of textures.values()) {
        try { if (typeof texture.destroy === 'function') texture.destroy(true); } catch { /* already gone */ }
      }
      for (const texture of officeTextureMap.values()) {
        try { if (typeof texture.destroy === 'function') texture.destroy(true); } catch { /* already gone */ }
      }
      officeTextureMap.clear();
      if (app) {
        try { app.destroy(true, { children: true, texture: false }); } catch { /* already gone */ }
      }
      app = null;
      stage = null;
      layers = null;
    },

    get __destroyed() { return destroyed; },
  };

  // The static fallback's retry button (built by buildStaticFallback before the
  // view object existed) calls back into the view's manual retry entry.
  onStaticRetryRequest = () => { retryRendering(); };

  return view;
}

module.exports = {
  createOfficeRenderer,
  computeVisibleHeight,
  STATIC_FALLBACK_TEXT,
  STATIC_RETRY_LABEL,
  STATIC_RETRY_HINT,
  STATIC_RETRY_EXHAUSTED_LABEL,
  STATIC_RETRY_UNSUPPORTED_LABEL,
  RENDER_PROFILES,
};
