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
// - runtime FPS observer (Task 9 blocker B / SPEC-07): when the caller arms
//   `fpsMonitor`, a presentation-rate observer counts rendered frames and
//   degrades THIS view to the static diagnostic presentation with the stable
//   code `LOW_FPS_PERSISTENT` after sustained sub-threshold windows. The
//   observer never advances movement/animation and never creates a simulation
//   ticker; there is no automatic recovery.

const { createFpsMonitor } = require('./fps-monitor.js');
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
    }
  }

  function buildLayers() {
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
  const ROLE_ORDER = Object.freeze({ main: 0, back: 1 });
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

  function drawFurnitureGraphics(graphics, item) {
    for (const [partName, rect] of Object.entries(item.parts || {})) {
      const x = rect.x * scene.width;
      const y = rect.y * scene.height;
      const w = rect.width * scene.width;
      const h = rect.height * scene.height;
      if (item.kind === 'zone-marker') {
        graphics.rect(x, y, w, h).fill({ color: COLORS.reserveZone, alpha: 0.5 });
        graphics.rect(x, y, w, h).stroke({ width: 1, color: COLORS.zoneOutline, alpha: 0.8 });
      } else if (partName === 'front') {
        graphics.roundRect(x, y, w, h, 3).fill({ color: COLORS.deskFront });
      } else if (item.kind === 'desk-back') {
        graphics.roundRect(x, y, w, h, 3).fill({ color: COLORS.deskTop });
      } else if (item.kind === 'chair') {
        graphics.roundRect(x, y, w, h, 4).fill({ color: COLORS.chair });
      } else if (item.kind === 'plant') {
        graphics.circle(x + w / 2, y + h / 2, Math.min(w, h) / 2).fill({ color: COLORS.plant });
      } else if (item.kind === 'shelf') {
        graphics.rect(x, y, w, h).fill({ color: COLORS.shelf });
      } else {
        graphics.rect(x, y, w, h).fill({ color: COLORS.deskWood });
      }
    }
  }

  function buildFurniture() {
    const floor = new PIXI.Graphics();
    floor.__furnitureId = 'floor-band';
    layers.background.addChild(floor);
    furnitureRecords.set('floor-band', { item: { id: 'floor-band', layer: 'background' }, node: floor, kind: 'floor' });

    // Explicit role order inside back-furniture: desk bodies (main) first,
    // then monitors/chairs (back). Within a role, flat items order by the
    // draft depth (layer 升序) with the fixture array order as tie-break;
    // the isometric fixture has no depth and keeps its array order. Fixture
    // order breaks ties within a role.
    const items = layout.furniture().map((item, index) => ({ item, index }));
    items.sort((a, b) => {
      const rank = (entry) => (entry.item.layer === 'front-occluders' ? 2 : ROLE_ORDER[furnitureRole(entry.item)]);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const depthA = typeof a.item.depth === 'number' ? a.item.depth : null;
      const depthB = typeof b.item.depth === 'number' ? b.item.depth : null;
      if (depthA !== null && depthB !== null && depthA !== depthB) return depthA - depthB;
      return a.index - b.index;
    });
    for (const { item } of items) {
      const layer = layers[item.layer];
      if (!layer) continue;
      const partEntries = Object.entries(item.parts || {});
      if (partEntries.length === 0) continue;
      const wantedAssetId = wantedAssetFor(item);
      const texture = wantedAssetId ? officeTextureMap.get(wantedAssetId) : null;
      if (texture && texture.width > 0 && texture.height > 0) {
        const sprite = new PIXI.Sprite(texture);
        sprite.__furnitureId = item.id;
        sprite.__furnitureRole = furnitureRole(item);
        sprite.anchor.set(0.5, 0.5);
        if (item.kind === 'monitor' && item.assetId === 'prop-monitor-back-right-top') {
          // Task 6b: a very light screen outline so the light-gray isometric
          // monitor stays discernible on the light office background (no dark
          // theme). Flat monitor art brings its own contrast — no outline.
          const outline = new PIXI.Graphics();
          outline.__role = 'monitor-contrast';
          outline.rect(150, 190, 725, 660).stroke({ width: 8, color: 0x74818c, alpha: 0.45 });
          sprite.addChild(outline);
        }
        // M4.1c: flat furniture (sortY) joins the ONE geometric pass with the
        // characters, ordered by its bottom edge — a walker in the corridor
        // (larger footY) draws over desks/chairs, while a seated body is
        // occluded by whatever stands in front of it. Everything else keeps
        // its explicit declared layer.
        const sortable = item.sortY === true;
        (sortable ? layers['ground-entities'] : layer).addChild(sprite);
        // Golden-workstation occlusion: the textured front panel mirrors the
        // desk body's rect so the desk reads as ONE piece while the front
        // copy still paints above characters (fixture-declared occluder).
        const mirrorId = /-front$/.test(item.id) ? `${item.id.replace(/-front$/, '')}-back` : null;
        const mirror = mirrorId ? furnitureRecords.get(mirrorId) : null;
        furnitureRecords.set(item.id, {
          item,
          node: sprite,
          kind: 'sprite',
          rect: partEntries[0][1],
          mirrorRect: mirror && mirror.rect ? mirror.rect : null,
          sortable,
        });
      } else {
        const graphics = new PIXI.Graphics();
        graphics.__furnitureId = item.id;
        graphics.__furnitureRole = furnitureRole(item);
        // M4.1c: a sortY item keeps its place in the geometric pass even when
        // its texture is missing — occlusion must not depend on whether art
        // loaded. Placeholders without sortY stay on their declared layer.
        const sortable = item.sortY === true;
        (sortable ? layers['ground-entities'] : layer).addChild(graphics);
        furnitureRecords.set(item.id, {
          item,
          node: graphics,
          kind: 'graphics',
          rect: partEntries[0][1],
          mirrorRect: null,
          sortable,
        });
        if (wantedAssetId) {
          const reason = texture
            ? 'TEXTURE_INVALID'
            : (loaderErrors.find((entry) => entry.assetId === wantedAssetId) || {}).reason || 'TEXTURE_NOT_PROVIDED';
          officeTextureMissing.push({
            furnitureId: item.id,
            assetId: wantedAssetId,
            code: 'OFFICE_TEXTURE_MISSING',
            reason,
          });
        }
      }
    }
    layoutFurniture();
    // Establish the geometric pass at BUILD time so occlusion never depends on
    // when the first snapshot push arrives.
    sortGround();
  }

  // Re-projects every persistent furniture node to the live scene size.
  // Sprites only get transform updates; Graphics redraw their rects in place.
  function layoutFurniture() {
    for (const record of furnitureRecords.values()) {
      if (record.kind === 'floor') {
        const bandY = scene.height * 0.32;
        record.node.clear();
        record.node.rect(0, bandY, scene.width, scene.height - bandY).fill({ color: COLORS.floorLine, alpha: 0.35 });
      } else if (record.kind === 'sprite') {
        const rect = record.mirrorRect || record.rect;
        const texture = record.node.texture;
        const asset = layoutAssetById(record.item.assetId);
        const bbox = asset && asset.contentBbox;
        if (bbox) {
          // Task E4 contentBbox viewport fit (mirrors the editor's art-box
          // contract): the OPAQUE ART fills the fixture rect exactly — the
          // sprite is scaled by the art width and shifted so the bbox center
          // lands on the rect center. The compiler derives the rect from the
          // same bbox, so the aspect always matches (no squash).
          const artScale = (rect.width * scene.width) / (bbox.w * texture.width);
          record.node.scale.set(artScale, artScale);
          record.node.x = (rect.x + rect.width / 2) * scene.width - (bbox.x + bbox.w / 2 - 0.5) * texture.width * artScale;
          record.node.y = (rect.y + rect.height / 2) * scene.height - (bbox.y + bbox.h / 2 - 0.5) * texture.height * artScale;
        } else {
          // Uniform scale fitted on the part rect's width, texture center on
          // the rect center: the part keeps its natural aspect (no squash) and
          // stays centered on its declared footprint. Height derives from the
          // texture aspect, mirroring the approved draft composition.
          const scale = (rect.width * scene.width) / texture.width;
          record.node.scale.set(scale, scale);
          record.node.x = (rect.x + rect.width / 2) * scene.width;
          record.node.y = (rect.y + rect.height / 2) * scene.height;
        }
      } else if (record.kind === 'graphics') {
        record.node.clear();
        drawFurnitureGraphics(record.node, record.item);
      }
    }
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
      const bubbleBg = new PIXI.Graphics();
      bubbleBg.__role = 'dialogue-bubble-bg';
      const bubbleText = new PIXI.Text('');
      bubbleText.__role = 'dialogue-bubble-text';
      bubbleText.style = { fontFamily: 'sans-serif', fontSize: 14, fill: 0x333344, wordWrap: true, wordWrapWidth: 180, breakWords: true };
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

  function updateEntity(record, employee) {
    record.__snapshot = employee;
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
    const visibleHeight = clamp(computeVisibleHeight(scene.height) * heightRatio, 64, 180);
    const geometryBounds = pack && pack.geometry ? pack.geometry.visibleBounds.height : 64;
    const scale = visibleHeight / geometryBounds;
    const frame = frameGeometryFor(employee);
    const footX = employee.position.x * scene.width;
    const footY = employee.position.y * scene.height;
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
    badge.x = footX + Math.max(14, visibleHeight * 0.26);
    badge.y = footY - visibleHeight - 10;

    const marker = record.__marker;
    if (employee.marker === 'chat-ellipsis') {
      marker.text = '…';
      marker.visible = true;
      marker.style = { fill: COLORS.markerChat, fontSize: Math.max(12, visibleHeight * 0.24) };
    } else if (employee.marker === 'sleep-zzz') {
      marker.text = 'Zzz';
      marker.visible = true;
      marker.style = { fill: COLORS.markerSleep, fontSize: Math.max(10, visibleHeight * 0.2) };
    } else {
      marker.visible = false;
    }
    marker.x = footX;
    marker.y = footY - visibleHeight - 12;

    // E5c dialogue bubble: rounded-rect speech bubble above the character's
    // head, visible only when the snapshot carries bubble text. The bg
    // Graphics and Text follow the entity like badge/marker.
    const bbBg = record.__bubbleBg;
    const bbText = record.__bubbleText;
    if (employee.bubble && employee.bubble.text) {
      bbText.text = employee.bubble.text;
      const btw = Math.max(bbText.width, 40);
      const bth = Math.max(bbText.height, 22);
      const bx = footX - btw / 2;
      const by = footY - visibleHeight - bth - 10;
      bbBg.clear();
      bbBg.roundRect(bx - 6, by - 6, btw + 12, bth + 12, 6)
        .fill({ color: 0xffffff, alpha: 0.94 })
        .stroke({ width: 1, color: 0x9ab0be });
      bbBg.visible = true;
      bbText.x = bx; bbText.y = by;
      bbText.visible = true;
    } else {
      bbText.visible = false;
      bbBg.visible = false;
    }
  }

  // The ACTUAL paint order of the merged ground pass, cached for tests and
  // real-shell probes: [{ id, kind, key }] with keys in scene px (bottom edge
  // for furniture, foot y for characters).
  let groundOrder = [];

  function sortGround() {
    const layer = layers['ground-entities'];
    const ordered = layout.sortGroundEntities(
      [...entities.values()]
        .filter((record) => record.container)
        .map((record) => ({
          footY: record.__snapshot ? record.__snapshot.position.y : 0,
          layer: 0,
          entityType: 'employee',
          id: record.employeeId,
          record,
        }))
    );
    // addChild moves an existing child to the top, so re-adding in sorted
    // order reorders the layer in place without recreating anything.
    for (const entry of ordered) layer.addChild(entry.record.container);

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
      });
    }
    if (furnitureEntries.length > 0) {
      const merged = [
        ...ordered.map((entry) => ({
          key: (entry.record.__snapshot ? entry.record.__snapshot.position.y : 0) * scene.height,
          node: entry.record.container,
          id: entry.id,
          kind: 'character',
        })),
        ...furnitureEntries,
      ];
      merged.sort((a, b) => (a.key - b.key) || String(a.id).localeCompare(String(b.id)));
      for (const entry of merged) layer.addChild(entry.node);
      groundOrder = merged.map((entry) => ({ id: entry.id, kind: entry.kind, key: entry.key }));
      return merged.map((entry) => entry.id);
    }
    groundOrder = ordered.map((entry) => ({
      id: entry.id,
      kind: 'character',
      key: (entry.record.__snapshot ? entry.record.__snapshot.position.y : 0) * scene.height,
    }));
    return ordered.map((entry) => entry.id);
  }

  // On-demand presentation: snapshot pushes mutate the stage and each push
  // renders once. This avoids any dependency on requestAnimationFrame timing
  // (hidden/background windows throttle rAF) and keeps a single render per
  // state change instead of a per-frame logic loop.
  function renderNow() {
    if (destroyed || mode === 'static' || !app) return;
    try { if (typeof app.render === 'function') app.render(); } catch { /* renderer gone */ }
  }

  function applySnapshot(snapshot) {
    if (destroyed || !snapshot || !Array.isArray(snapshot.employees)) return;
    currentSnapshot = snapshot;
    if (snapshot.scene && Number.isFinite(snapshot.scene.referenceWidth)) {
      // logical reference size only; projection keeps using the live scene
    }
    const seen = new Set();
    for (const employee of snapshot.employees) {
      if (!employee || !employee.employeeId) continue;
      seen.add(employee.employeeId);
      const record = entities.get(employee.employeeId) || createEntity(employee.employeeId);
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
    if (mode !== 'static') sortGround();
    renderNow();
  }

  // ---- public surface -------------------------------------------------------

  if (PIXI && typeof PIXI.Application === 'function') {
    const webgl = await tryInitApplication('webgl');
    if (webgl.ok) {
      app = webgl.app;
      mode = 'webgl';
    } else {
      diagnosticCode = 'WEBGL_INIT_FAILED';
      discardFailedApplication(webgl.app);
      const canvas = await tryInitApplication('canvas');
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
      buildFurniture();
      if (mount && app.canvas && mount.appendChild) mount.appendChild(app.canvas);
      app.ticker.stop(); // rendering happens on snapshot pushes, not on a clock
    } else {
      buildStaticFallback();
    }
  } else {
    diagnosticCode = 'RENDERER_UNAVAILABLE';
    mode = 'static';
    buildStaticFallback();
  }

  if (currentSnapshot) applySnapshot(currentSnapshot);
  if (selectionId && mode !== 'static') applySelection();

  // ---- runtime FPS observer (Task 9 blocker B / SPEC-07) --------------------
  // Presentation-rate observer only: it counts presented frames through an
  // injectable clock and NEVER advances movement, animation or any office
  // state — the single simulation clock stays in the main process. Sustained
  // sub-threshold presentation degrades THIS view to the static diagnostic
  // presentation (LOW_FPS_PERSISTENT, distinct from WEBGL_INIT_FAILED /
  // RENDERER_UNAVAILABLE). No automatic recovery: the diagnostic state stays
  // stable once degraded. When the caller does not arm `fpsMonitor`, nothing
  // is scheduled and behavior is unchanged.
  let monitor = null;
  let pumpHandle = null;
  let scheduleFrame = null;
  let cancelFrame = null;
  if (fpsMonitor && mode !== 'static') {
    scheduleFrame = fpsMonitor.scheduleFrame
      || (typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null);
    cancelFrame = fpsMonitor.cancelFrame
      || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : null);
  }
  function pump() {
    pumpHandle = null;
    if (destroyed || !monitor || monitor.degraded()) return;
    monitor.frame();
    schedulePump();
  }
  function schedulePump() {
    if (destroyed || !monitor || monitor.degraded() || pumpHandle !== null || !scheduleFrame) return;
    pumpHandle = scheduleFrame(pump);
  }
  function stopPump() {
    if (pumpHandle !== null && cancelFrame) {
      try { cancelFrame(pumpHandle); } catch { /* already canceled */ }
    }
    pumpHandle = null;
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
    for (const texture of textures.values()) {
      try { if (typeof texture.destroy === 'function') texture.destroy(true); } catch { /* already gone */ }
    }
    textures.clear();
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
    mode = 'static';
    buildStaticFallback();
    // Keep the exposed view surface consistent with the degraded state (the
    // view object captured these values at creation time).
    if (typeof view === 'object' && view) {
      view.mode = mode;
      view.diagnosticCode = diagnosticCode;
      view.staticElement = staticElement;
      view.app = app;
      view.stage = stage;
      view.layers = layers;
    }
  }
  if (fpsMonitor && mode !== 'static' && scheduleFrame) {
    monitor = createFpsMonitor({
      thresholdFps: fpsMonitor.thresholdFps,
      windowFrames: fpsMonitor.windowFrames,
      lowWindowLimit: fpsMonitor.lowWindowLimit,
      now: fpsMonitor.now,
      onDegrade: () => degradeToStatic('LOW_FPS_PERSISTENT'),
    });
    schedulePump();
  }

  function applySelection() {
    for (const [id, record] of entities) {
      if (record.__selectionRing) record.__selectionRing.visible = id === selectionId;
    }
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

    applySnapshot,

    resize({ width, height }) {
      if (destroyed) return;
      scene = { width, height };
      if (mode !== 'static' && app && app.renderer) app.renderer.resize(width, height);
      if (mode === 'static') return;
      // furniture nodes persist: resize only re-projects transforms/rects,
      // so sprite identity and texture references are never recreated
      if (layers) { layoutFurniture(); sortGround(); }
      if (currentSnapshot) applySnapshot(currentSnapshot);
      else renderNow();
    },

    setSelection(employeeId) {
      selectionId = employeeId || null;
      if (mode !== 'static') applySelection();
    },

    hitTest(px, py) {
      if (mode === 'static' || destroyed) return null;
      let best = null;
      let bestDistance = Infinity;
      for (const record of entities.values()) {
        if (!record.__snapshot) continue;
        const foot = record.__footPx;
        const distance = Math.hypot(foot.x - px, foot.y - py);
        const radius = Math.max(24, record.__layout.visibleHeight * 0.35);
        if (distance <= radius && distance < bestDistance) {
          best = record.employeeId;
          bestDistance = distance;
        }
      }
      return best;
    },

    setReducedMotion() {
      // The renderer has no autonomous motion to reduce (single-clock design);
      // reduced motion is enforced by the main-process simulator. Kept as a
      // stable API for the page.
    },

    pause() {
      if (destroyed || mode === 'static') return;
      paused = true;
      if (app && app.ticker) app.ticker.stop();
    },

    resume() {
      if (destroyed || mode === 'static') return;
      paused = false;
      if (app && app.ticker) app.ticker.start();
    },

    isPaused: () => paused,

    diagnostics() {
      return {
        mode,
        diagnosticCode,
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

  return view;
}

module.exports = {
  createOfficeRenderer,
  computeVisibleHeight,
  STATIC_FALLBACK_TEXT,
};
