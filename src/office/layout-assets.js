'use strict';

// src/office/layout-assets.js — the SINGLE shared manifest for layout assets.
// Both the layout editor (drafting UI) and the office renderer (golden
// workstation textures, Task 3) resolve their images and metadata from here,
// so the two surfaces can never drift into a second furniture list.
//
// Task E2c: the catalog is DATA-DRIVEN over two entry shapes produced from
// one declaration surface:
// - directional entries (`directional: true`): one id per direction variant
//   (`prop-<kind>-<direction>`), switchable inside the family via the editor
//   setItemDirection API;
// - single-image entries (`directional: false`): one id, one file, a declared
//   `direction: 'none'` that parseDraft enforces verbatim (direction switches
//   are rejected for these — there is no family to switch inside).
//
// URL contract: every managed prop URL is a relative ./office-assets/… png
// served from resources/office by the office-runtime protocol. Directional
// furniture lives under ./office-assets/layout-editor/, environment props sit
// at the ./office-assets/ root. No photo/, no artifacts/, no personal or
// absolute paths — the catalog tests lock this.

const DIRECTIONS = Object.freeze([
  ['front', '正面'],
  ['back', '背面'],
  ['left', '左侧'],
  ['right', '右侧'],
  ['front-left-top', '左前上'],
  ['front-right-top', '右前上'],
  ['back-left-top', '左后上'],
  ['back-right-top', '右后上'],
]);

// Renderer defaults for furniture sprites. `layer` matches the canonical
// office-layout furniture layers; `anchor` {x:0.5,y:0.5} mirrors the sprite
// fit policy: the texture center is placed on the part rect's center.
const PROP_LAYER = 'back-furniture';
const PROP_SCALE = 1;
const PROP_ANCHOR = Object.freeze({ x: 0.5, y: 0.5 });

// Kind registry (data-driven): label per kind in shelf/display order. The
// directional furniture kinds generate one entry per DIRECTIONS variant; the
// remaining kinds are single-image families.
const KIND_LABELS = Object.freeze({
  desk: '桌子',
  chair: '椅子',
  monitor: '显示器',
  character: '鲸鱼娘',
  prop: '道具',
});
const DIRECTIONAL_KINDS = Object.freeze(['desk', 'chair', 'monitor']);

const directionalPropAssets = DIRECTIONAL_KINDS.flatMap((kind) => DIRECTIONS.map(([direction, directionLabel]) => Object.freeze({
  id: `prop-${kind}-${direction}`,
  kind,
  label: KIND_LABELS[kind],
  direction,
  directionLabel,
  src: `./office-assets/layout-editor/prop-${kind}-${direction}.png`,
  layer: PROP_LAYER,
  scale: PROP_SCALE,
  anchor: PROP_ANCHOR,
  directional: true,
})));

// Drafting-only character images for the editor. Task 8: these resolve from
// the PRODUCTION character pack (resources/characters/deepseek-default) over
// the managed characters/ protocol route — the built-in pack ships the same
// frames as the test fixture, and the office page must never reference
// test-only trees. Runtime character frames still come from the active
// character pack; these entries carry the common metadata (bottom-center
// anchor = the conventional foot point).
const characterAssets = [
  ['front', '正面', './characters/deepseek-default/assets/expressions/idle.png'],
  ['back', '背面', './characters/deepseek-default/assets/animations/side/none/side-back.png'],
  ['left', '左侧', './characters/deepseek-default/assets/animations/side/none/side-left.png'],
  ['right', '右侧', './characters/deepseek-default/assets/animations/side/none/side-right.png'],
].map(([direction, directionLabel, src]) => Object.freeze({
  id: `whale-girl-${direction}`,
  kind: 'character',
  label: KIND_LABELS.character,
  direction,
  directionLabel,
  src,
  layer: 'ground-entities',
  scale: 1,
  anchor: Object.freeze({ x: 0.5, y: 1 }),
  directional: true,
}));

// Task E2c: single-image environment props at the ./office-assets/ root.
// One file per prop, no direction variants (`direction: 'none'` is part of
// the draft contract — parseDraft rejects any other direction value for
// these ids and setItemDirection refuses to switch them).
//
// Occlusion note for the EDITOR default paint order: every env prop drafts
// at DEFAULT_LAYER_BY_KIND.prop = 25 (layout-editor.js) — above monitors (10)
// and chairs (20), below characters (30): a walking character covers the
// prop, the prop covers workstation monitors/chairs. The renderer band stays
// 'back-furniture' (furniture textures, same family as the directional
// props); special stacks (e.g. the desktop computer ON a desk) can be raised
// per item through the layer inspector.
const environmentPropAssets = [
  // file,                 中文标签,    遮挡说明
  ['prop-chair', '办公椅', '独立办公椅单图（背面视角）；角色行走时从前方遮挡'],
  ['prop-coffee-machine', '咖啡机', '台面设备，默认被角色遮挡'],
  ['prop-desk-monitor', '台式电脑', '桌面显示器+键鼠套装；叠在桌上时可经层级输入抬高'],
  ['prop-plant', '绿植', '地面盆栽，角色从前景遮挡'],
  ['prop-snacks', '零食盘', '桌面小物，默认被角色遮挡'],
  ['prop-toilet', '移动卫生间', '独立亭体，背景建筑类，角色从前方遮挡'],
  ['prop-treadmill', '跑步机', '地面健身器材，角色踩踏位由用户微调层级'],
  ['prop-water-bar', '水吧台', '柜台家具，角色从前方遮挡'],
  ['prop-water-cooler', '饮水机', '立式电器，角色从前方遮挡'],
  ['prop-whiteboard', '白板', '墙面背景件，位于道具默认层的典型背景'],
].map(([file, label]) => Object.freeze({
  id: file,
  kind: 'prop',
  label,
  direction: 'none',
  directionLabel: '固定',
  src: `./office-assets/${file}.png`,
  layer: PROP_LAYER,
  scale: PROP_SCALE,
  anchor: PROP_ANCHOR,
  directional: false,
}));

// Task E3a: the FLAT-2D pilot furniture (user-drawn front-facing art) lives
// in a dedicated flat/ namespace so the ids can never collide with the
// isometric directional variants (prop-<kind>-<direction>). They reuse the
// EXISTING kinds on purpose: that inherits the calibrated default depth
// (monitor 10 / chair 20 / desk 40), the shelf display width and the
// renderer furniture band; direction is declared verbatim ('front'/'back')
// and direction switches are refused (directional: false, single image).
//
// Task E3d: the pilot PNGs are 1024×1024 with LARGE transparent margins
// (the opaque art covers only ~50–66% linearly), which made canvas items
// read smaller than placed and panel thumbnails read almost blank. Each
// entry therefore declares `contentBbox` — the opaque-art bounding box
// normalized inside the PNG, measured ONCE from the alpha channel with
// threshold 8 (a catalog test re-measures the PNG and locks the values to
// ±0.002). Renderers use it to crop the margins WITHOUT touching the PNG
// bytes; assets without contentBbox render exactly as before.
const flatFurnitureAssets = [
  // id, file, kind, 中文标签, direction, contentBbox {x,y,w,h}（归一化美术包围盒）
  ['flat-desk', 'prop-desk-front.png', 'desk', '桌子（平面）', 'front', { x: 0.0927734, y: 0.234375, w: 0.8261719, h: 0.5488281 }],
  ['flat-monitor', 'prop-monitor-front.png', 'monitor', '显示器（平面）', 'front', { x: 0.0908203, y: 0.1669922, w: 0.8105469, h: 0.6591797 }],
  ['flat-chair', 'prop-chair-back.png', 'chair', '椅子（平面·背视）', 'back', { x: 0.2548828, y: 0.0976563, w: 0.4882813, h: 0.8085938 }],
  // 左半区/公共区家具（v6–v11 生成批次；contentBbox 由 alpha>8 实测，防漂移测试 ±0.002 锁定）
  ['flat-water-bar', 'flat-water-bar.png', 'prop', '水吧台（平面）', 'front', { x: 0.2294922, y: 0.3662109, w: 0.5517578, h: 0.390625 }],
  ['flat-water-cooler', 'flat-water-cooler.png', 'prop', '饮水机（平面）', 'front', { x: 0.4082031, y: 0.1396484, w: 0.1816406, h: 0.7294922 }],
  ['flat-coffee-machine', 'flat-coffee-machine.png', 'prop', '咖啡机（平面）', 'front', { x: 0.3339844, y: 0.1943359, w: 0.3261719, h: 0.625 }],
  ['flat-snack-plate', 'flat-snack-plate.png', 'prop', '零食盘（平面）', 'front', { x: 0.1679688, y: 0.296875, w: 0.6640625, h: 0.4160156 }],
  ['flat-rice-cooker', 'flat-rice-cooker.png', 'prop', '电饭煲（平面）', 'front', { x: 0.2421875, y: 0.2841797, w: 0.5117188, h: 0.5556641 }],
  ['flat-rice-bowl', 'flat-rice-bowl.png', 'prop', '米饭碗·鲸鱼标（平面）', 'front', { x: 0.2021484, y: 0.3564453, w: 0.625, h: 0.4013672 }],
  ['flat-whiteboard', 'flat-whiteboard.png', 'prop', '白板（平面）', 'front', { x: 0.2939453, y: 0.1005859, w: 0.4121094, h: 0.7939453 }],
  ['flat-plant-monstera', 'flat-plant-monstera.png', 'prop', '龟背竹（平面）', 'front', { x: 0.3027344, y: 0.2089844, w: 0.3818359, h: 0.5927734 }],
  ['flat-plant-snake', 'flat-plant-snake.png', 'prop', '虎皮兰（平面）', 'front', { x: 0.3095703, y: 0.109375, w: 0.3427734, h: 0.7587891 }],
  ['flat-plant-succulent', 'flat-plant-succulent.png', 'prop', '多肉（平面）', 'front', { x: 0.3388672, y: 0.2939453, w: 0.3232422, h: 0.46875 }],
  ['flat-plant-a', 'flat-plant-a.png', 'prop', '绿植·陶盆（平面）', 'front', { x: 0.2441406, y: 0.1289062, w: 0.5195312, h: 0.7216797 }],
  ['flat-plant-b', 'flat-plant-b.png', 'prop', '绿植·花盆（平面）', 'front', { x: 0.3037109, y: 0.2324219, w: 0.3916016, h: 0.5605469 }],
  ['flat-sofa', 'flat-sofa.png', 'prop', '沙发（平面）', 'front', { x: 0.1308594, y: 0.2597656, w: 0.7421875, h: 0.4775391 }],
  ['flat-coffee-table', 'flat-coffee-table.png', 'prop', '茶几（平面）', 'front', { x: 0.1943359, y: 0.3320312, w: 0.6083984, h: 0.3447266 }],
  ['flat-island', 'flat-island.png', 'prop', '岛台（平面）', 'front', { x: 0.1230469, y: 0.2998047, w: 0.7529297, h: 0.3964844 }],
  ['flat-vending-right', 'flat-vending-right.png', 'prop', '贩卖机·右前1/3（平面）', 'front', { x: 0.2939453, y: 0.1591797, w: 0.4121094, h: 0.6855469 }],
  ['flat-vending-a', 'flat-vending-a.png', 'prop', '贩卖机·A门朝左（平面）', 'front', { x: 0.3115234, y: 0.125, w: 0.3740234, h: 0.7353516 }],
  ['flat-vending-b', 'flat-vending-b.png', 'prop', '贩卖机·B纯侧面（平面）', 'front', { x: 0.3808594, y: 0.1708984, w: 0.2412109, h: 0.6894531 }],
  ['flat-vending-c', 'flat-vending-c.png', 'prop', '贩卖机·C门朝右（平面）', 'front', { x: 0.3125, y: 0.1269531, w: 0.3710938, h: 0.7275391 }],
  ['flat-desk-phone', 'flat-desk-phone.png', 'prop', '座机电话·左视（平面）', 'front', { x: 0.1533203, y: 0.3613281, w: 0.6669922, h: 0.3232422 }],
].map(([id, file, kind, label, direction, contentBbox]) => Object.freeze({
  id,
  kind,
  label,
  direction,
  directionLabel: DIRECTIONS.find(([name]) => name === direction)[1],
  src: `./office-assets/flat/${file}`,
  layer: PROP_LAYER,
  scale: PROP_SCALE,
  anchor: PROP_ANCHOR,
  directional: false,
  ...(contentBbox ? { contentBbox: Object.freeze(contentBbox) } : {}),
}));

// Task E4.6: the 8-direction ISOMETRIC family is retired from the editor
// palette (the flat-2D rework replaced it). The entries stay RESOLVABLE
// through layoutAssetById — the isometric fallback renderer path and legacy
// schema-v1 drafts still reference them — and the PNG files stay on disk;
// they simply never appear on the shelf again.
const ARCHIVED_LAYOUT_ASSETS = Object.freeze(directionalPropAssets);

const LAYOUT_ASSETS = Object.freeze([...characterAssets, ...environmentPropAssets, ...flatFurnitureAssets]);
const ARCHIVED_ASSETS_BY_ID = new Map(ARCHIVED_LAYOUT_ASSETS.map((asset) => [asset.id, asset]));
const LAYOUT_ASSETS_BY_ID = new Map(LAYOUT_ASSETS.map((asset) => [asset.id, asset]));

// Task E3d: the editor's per-kind shelf width is SCENE-REFERENCE pixels (the
// 1280-wide logical scene), not screen pixels — a desk drafts 180 scene px
// wide whatever the window. Task E4: the runtime layout compiler derives
// furniture footprints from the SAME numbers, so the catalog is the single
// source (office.html consumes this instead of its own local copy).
const DRAFT_WIDTHS = Object.freeze({
  desk: 180,
  chair: 110,
  monitor: 105,
  character: 96,
  prop: 120,
});

// Task E4: the whale-girl character frames are drawn on a square canvas whose
// calibrated foot point (production pack anchors.json, side-back frame
// outputAnchor {x:178, y:296} of 352) is where the runtime employee's foot
// lands. The layout compiler uses this ratio to project a draft character
// item onto the workstation seat anchor; the catalog test locks the ratio
// against the pack file so the two can never drift.
const CHARACTER_CANVAS = 352;
const CHARACTER_FOOT_RATIO = Object.freeze({
  x: 178 / CHARACTER_CANVAS,
  y: 296 / CHARACTER_CANVAS,
});

// Ordered [kind, label] pairs for data-driven shelf/panel UIs.
const LAYOUT_KINDS = Object.freeze(Object.entries(KIND_LABELS).map(([kind, label]) => Object.freeze([kind, label])));

// Stable miss: unknown asset ids resolve to null so callers can raise
// OFFICE_TEXTURE_MISSING instead of guessing a URL from an id. Archived
// (retired-palette) entries stay resolvable for the fallback renderer path.
function layoutAssetById(assetId) {
  return LAYOUT_ASSETS_BY_ID.get(assetId) || ARCHIVED_ASSETS_BY_ID.get(assetId) || null;
}

module.exports = { LAYOUT_ASSETS, ARCHIVED_LAYOUT_ASSETS, LAYOUT_KINDS, layoutAssetById, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO };
