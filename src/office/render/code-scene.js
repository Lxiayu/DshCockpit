'use strict';

// src/office/render/code-scene.js — P3.1 场景代码化（纯几何，零依赖）。
//
// 目标（P3 计划 §1/§4）：场景不再依赖"为每件东西准备一张贴图"，而是由一份
// 描述 + 一套主题调色板程序化绘制。这一层只回答"画哪些形状、用什么颜色"，
// 不接触 Pixi、不读快照、不产生事实——渲染器负责把形状落到 Graphics 上。
//
// 当前切片（P3.1 第一步，工位区）：地板/踢脚带/预留区。它是现有平面投影下
// 的替换件，默认关闭；等视觉方向（等轴测 / 平面）由用户拍板后，同一份描述
// 可以喂给等轴测投影，不需要重写主题与布局语义。
//
// 主题语言（与概念稿一致）：低饱和底色 + 细网格 + 一处强调色；暗色不是简单
// 反色，而是"夜间办公室"（更暗的地面、更暖的灯光带）。

const THEMES = Object.freeze({
  light: Object.freeze({
    id: 'light',
    floorA: 0xfaf9f6,
    floorB: 0xf3f2ee,
    grout: 0xe4e2dc,
    band: 0xecebe6,
    edge: 0xd9d7d0,
    zoneFill: 0xf1efe8,
    zoneStroke: 0xd8d4c9,
    // 2026-10-27（用户拍板「色块 + 材质细节」）：家具用同一套低饱和色，
    // 靠顶面/侧面/高光三条色阶做出材质，不引入贴图。
    wallTop: 0xf7f4ee,
    wall: 0xefece5,
    base: 0xe6e2d9,
    windowGlass: 0xdfeaf2,
    windowFrame: 0xcdc7bb,
    windowGlow: 0xfff1cf,
    deskTop: 0xe8dcc8,
    deskSide: 0xcbbba3,
    deskEdge: 0xa8967c,
    monitorBody: 0x4b5158,
    monitorScreen: 0xdbe7ee,
    monitorEdge: 0x3a3f45,
    chairSeat: 0xaeb9c4,
    chairBack: 0x8d99a6,
    plantLeaf: 0x7fa585,
    plantPot: 0xc8b6a5,
    receptionTop: 0xefeae0,
    receptionSide: 0xe3ded3,
    receptionEdge: 0xd2ccc0,
    sofa: 0x9aa7b8,
    sofaSeat: 0xb3bfcc,
    rug: 0xe9e2d6,
    counterTop: 0xd4dade,
    counterSide: 0xb6bec4,
  }),
  dark: Object.freeze({
    id: 'dark',
    // 2026-10-27 用户反馈：暖棕调"有些奇怪"，暗色改为中性灰（冷灰），
    // 只靠明度层次 + 窗光提亮；强调色仍由 accent 提供。
    floorA: 0x2b2d30,
    floorB: 0x26282b,
    grout: 0x34373b,
    band: 0x1b1c1e,
    edge: 0x3a3d41,
    zoneFill: 0x2f3236,
    zoneStroke: 0x44484d,
    wallTop: 0x212326,
    wall: 0x1c1d1f,
    base: 0x33363a,
    windowGlass: 0x3a4550,
    windowFrame: 0x4a4f55,
    windowGlow: 0xdfe8f0,
    deskTop: 0x46494d,
    deskSide: 0x373a3e,
    deskEdge: 0x26282b,
    monitorBody: 0x24272b,
    monitorScreen: 0x6f828f,
    monitorEdge: 0x1c1e21,
    chairSeat: 0x404347,
    chairBack: 0x33363a,
    plantLeaf: 0x566b5c,
    plantPot: 0x4a4a4c,
    receptionTop: 0x3d4044,
    receptionSide: 0x34373a,
    receptionEdge: 0x27292c,
    sofa: 0x3d4650,
    sofaSeat: 0x4a5560,
    rug: 0x343a40,
    counterTop: 0x3c4348,
    counterSide: 0x2e3438,
  }),
});

const ACCENTS = Object.freeze({
  indigo: 0x4f46e5,
  teal: 0x0f766e,
  clay: 0xb45309,
  rose: 0xbe123c,
  moss: 0x3f6212,
});

// 地砖的逻辑尺寸（1280×840 参考场景下的像素）。实际尺寸随时随场景缩放，
// 但保持 32..96 px 的可见区间，避免窗口很小时糊成一片、很大时变成巨砖。
const REFERENCE_TILE_PX = 56;
const TILE_MIN_PX = 32;
const TILE_MAX_PX = 96;
// 地板带从墙体下沿开始（沿用现有 floor-band 的 0.32 约定）。
const FLOOR_TOP_RATIO = 0.32;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function themeOf(id) {
  return THEMES[id] || THEMES.light;
}

function accentOf(id) {
  return Number.isFinite(ACCENTS[id]) ? ACCENTS[id] : ACCENTS.indigo;
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the drawable description for one scene size.
 *
 * @param {object} input
 * @param {{width:number,height:number}} input.scene   live scene size in px
 * @param {object} [input.layout]                       office layout accessor
 * @param {string} [input.theme]                       'light' | 'dark'
 * @param {string} [input.accent]                      accent id
 * @param {number} [input.tilePx]                      tile edge in px
 * @param {number} [input.characterScale]              1 = SPEC-02 default; the
 *   approved P3.1 look uses 1.18 (clamped to [0.9, 1.4])
 * @returns {object} description (floor / walls / window / reception / zones /
 *   furniture colors / stats). Pure data: the renderer turns it into Graphics.
 */
function describeCodeScene(input) {
  const options = input || {};
  const width = positiveNumber(options.scene && options.scene.width, 1280);
  const height = positiveNumber(options.scene && options.scene.height, 840);
  const theme = themeOf(options.theme);
  const accent = options.accent && ACCENTS[options.accent] ? options.accent : 'indigo';
  const accentColor = accentOf(accent);
  const characterScale = clamp(
    typeof options.characterScale === 'number' && Number.isFinite(options.characterScale) && options.characterScale > 0
      ? options.characterScale
      : 1,
    0.9,
    1.4
  );

  const scale = clamp(Math.min(width / 1280, height / 840), 0.5, 1.6);
  const tilePx = Math.round(clamp(positiveNumber(options.tilePx, REFERENCE_TILE_PX * scale), TILE_MIN_PX, TILE_MAX_PX));
  const top = Math.round(height * FLOOR_TOP_RATIO);
  const columns = Math.max(1, Math.ceil(width / tilePx));
  const rows = Math.max(1, Math.ceil((height - top) / tilePx));

  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = column * tilePx;
      const y = top + row * tilePx;
      tiles.push({
        x,
        y,
        w: Math.min(tilePx, width - x),
        h: Math.min(tilePx, height - y),
        // The checker is a presentation accent, not a fact: an odd tile count
        // still alternates deterministically.
        fill: (row + column) % 2 === 0 ? theme.floorA : theme.floorB,
      });
    }
  }

  // Light falls off away from the window wall: 8 very low-alpha horizontal
  // bands. Steps of ~1% are invisible as banding but give the floor a distance
  // gradient instead of a flat checkerboard.
  const shadeBands = [];
  const SHADE_STEPS = 8;
  const shadeStepH = Math.max(1, Math.round((height - top) / SHADE_STEPS));
  for (let i = 0; i < SHADE_STEPS; i += 1) {
    const y = top + i * shadeStepH;
    const h = Math.min(shadeStepH, height - y);
    if (h <= 0) break;
    shadeBands.push({
      y,
      h,
      alpha: (theme.id === 'dark' ? 0.012 : 0.006) * i,
      color: theme.id === 'dark' ? 0x000000 : 0x7a7264,
    });
  }

  // ---- walls / window (the flat projection has one visible wall band) ------
  const wallH = top;
  const bands = [
    { y: 0, h: Math.round(wallH * 0.42), color: theme.wallTop },
    { y: Math.round(wallH * 0.42), h: Math.round(wallH * 0.34), color: theme.wall },
    { y: Math.round(wallH * 0.76), h: wallH - Math.round(wallH * 0.76), color: theme.wallTop },
  ].filter((band) => band.h > 0);
  const baseH = Math.max(3, Math.round(height * 0.006));
  // The top row of desks sits against the wall; the window lives on the free
  // left stretch of the wall so monitors never overlap the glass.
  const windowRect = {
    x: Math.round(width * 0.07),
    y: Math.round(wallH * 0.12),
    w: Math.round(width * 0.20),
    h: Math.round(wallH * 0.38),
  };
  const window = {
    ...windowRect,
    frame: theme.windowFrame,
    glass: theme.windowGlass,
    // Mullions split the glass into 3 panes (two vertical bars + one sill).
    mullions: [
      { x: windowRect.x + Math.round(windowRect.w / 3), y: windowRect.y, w: 2, h: windowRect.h },
      { x: windowRect.x + Math.round((windowRect.w * 2) / 3), y: windowRect.y, w: 2, h: windowRect.h },
    ],
    // Light spill on the floor under the window. Light theme gets a visible
    // warm band (the user said the previous one was nearly invisible); dark
    // keeps a much subtler cool-white pool. The second narrower band is a
    // cheap two-step gradient without shaders.
    glow: {
      x: Math.round(windowRect.x - width * 0.04),
      y: top,
      w: Math.round(windowRect.w + width * 0.08),
      h: Math.round(height * 0.08),
      color: theme.windowGlow,
      alpha: theme.id === 'dark' ? 0.10 : 0.26,
      inner: {
        x: Math.round(windowRect.x + windowRect.w * 0.18),
        y: top,
        w: Math.round(windowRect.w * 0.64),
        h: Math.round(height * 0.05),
        alpha: theme.id === 'dark' ? 0.06 : 0.16,
      },
    },
  };

  const zones = [];
  let reception = null;
  const layout = options.layout;
  const reserve = layout && typeof layout.reserveZone === 'function'
    ? layout.reserveZone()
    : (layout && typeof layout.reserve === 'function' ? layout.reserve() : null);
  if (reserve && typeof reserve === 'object') {
    const rx = Number(reserve.x);
    const ry = Number(reserve.y);
    const rw = Number(reserve.width);
    const rh = Number(reserve.height);
    if ([rx, ry, rw, rh].every((n) => Number.isFinite(n)) && rw > 0 && rh > 0) {
      const zoneX = rx * width;
      const zoneY = Math.max(ry * height, top);
      const zoneW = rw * width;
      const zoneH = rh * height;
      zones.push({
        id: 'reserve',
        x: zoneX,
        y: zoneY,
        w: zoneW,
        h: zoneH,
        fill: theme.zoneFill,
        stroke: theme.zoneStroke,
        accent: accentColor,
        accentAlpha: 0.10,
      });
      // "保留但弱化"（用户拍板）：门厅只留一条低矮的前台台面 + 地面分色，
      // 不做高墙、不占视觉重量；位置仍来自布局的预留区，不是写死坐标。
      const counterH = Math.max(10, Math.round(height * 0.018));
      reception = {
        x: zoneX,
        y: zoneY + zoneH - counterH,
        w: zoneW,
        h: counterH,
        top: theme.receptionTop,
        side: theme.receptionSide,
        edge: theme.receptionEdge,
        accent: accentColor,
      };
    }
  }

  return {
    theme: theme.id,
    accent,
    tilePx,
    characterScale,
    colors: { ...theme, accent: accentColor },
    // No floor lamp pools: without gradients a hard ellipse reads as a stain
    // rather than light. The warm window glow above is the night cue.
    lamps: [],
    floor: {
      x: 0,
      y: top,
      w: width,
      h: Math.max(0, height - top),
      tilePx,
      columns,
      rows,
      tiles,
      shadeBands,
    },
    walls: {
      x: 0,
      y: 0,
      w: width,
      h: wallH,
      bands,
      base: { x: 0, y: top - baseH, w: width, h: baseH, color: theme.base },
      window,
    },
    reception,
    zones,
    // A hairline where the wall meets the floor: it is what makes the scene
    // read as a room instead of a colored rectangle.
    edge: { x: 0, y: top, w: width, h: 2, color: theme.edge },
    stats: {
      tileCount: tiles.length,
      zoneCount: zones.length,
      width,
      height,
      hasReception: !!reception,
    },
  };
}

module.exports = {
  describeCodeScene,
  THEMES,
  ACCENTS,
  REFERENCE_TILE_PX,
  FLOOR_TOP_RATIO,
};
