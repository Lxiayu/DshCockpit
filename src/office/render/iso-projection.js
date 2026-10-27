'use strict';

// src/office/render/iso-projection.js — P3 等轴测投影内核（I0，纯函数）。
//
// 2:1 dimetric：世界坐标 (x, y, z) → 屏幕 CSS 像素。
//   sx = originX + (x - y) * scale
//   sy = originY + (x + y) * scale * 0.5 - z * scale
// 反投影（屏幕 → 地面 z=0，用于命中测试）：
//   s = (x + y), d = (x - y)
//   s = 2 * (sy - originY + z * scale) / scale
//   d = (sx - originX) / scale
//   x = (s + d) / 2, y = (s - d) / 2
//
// 这个模块只做坐标换算：不读快照、不碰 Pixi、不产生事实。相机由调用方按
// 视口尺寸创建，窗口变化时重建即可（不要把相机状态写回布局）。

const DEPTH_EPSILON = 1e-6;

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Depth key used by the painter's algorithm (smaller = farther). */
function depthKey(point) {
  if (!point) return 0;
  return finite(point.x, 0) + finite(point.y, 0) + finite(point.z, 0) * DEPTH_EPSILON;
}

/**
 * Create a camera. `origin` is where world (0,0,0) lands on screen.
 *
 * @param {{originX:number,originY:number,scale:number}} input
 */
function createCamera(input) {
  const options = input || {};
  const scale = finite(options.scale, 64);
  return Object.freeze({
    originX: finite(options.originX, 0),
    originY: finite(options.originY, 0),
    scale: scale > 0 ? scale : 64,
  });
}

/**
 * Fit a camera so a world footprint [0..worldWidth, 0..worldDepth] with the
 * given maximum height stays inside `width`x`height` with `margin` px on each
 * side, and is centred.
 *
 * @param {object} input
 * @param {number} input.width   viewport width (CSS px)
 * @param {number} input.height  viewport height (CSS px)
 * @param {number} [input.worldWidth=1]   world x extent
 * @param {number} [input.worldDepth=1]   world y extent
 * @param {number} [input.maxHeight=0]    tallest z in world units
 * @param {number} [input.margin=0]
 */
function fitCamera(input) {
  const options = input || {};
  const width = Math.max(1, finite(options.width, 1280));
  const height = Math.max(1, finite(options.height, 840));
  const worldWidth = Math.max(0.0001, finite(options.worldWidth, 1));
  const worldDepth = Math.max(0.0001, finite(options.worldDepth, 1));
  const maxHeight = Math.max(0, finite(options.maxHeight, 0));
  const margin = Math.max(0, finite(options.margin, 0));

  const projectedWidth = worldWidth + worldDepth;
  const projectedHeight = (worldWidth + worldDepth) * 0.5 + maxHeight;
  const availWidth = Math.max(1, width - margin * 2);
  const availHeight = Math.max(1, height - margin * 2);
  const scale = Math.max(1, Math.min(availWidth / projectedWidth, availHeight / projectedHeight));

  // Bounding box of the projected footprint with y flipped to screen space:
  // top-left of the diamond is world (0, worldDepth); right-most is (worldWidth, 0).
  const minX = (0 - worldDepth) * scale;
  const maxX = worldWidth * scale;
  const minY = 0 - maxHeight * scale;
  const maxY = (worldWidth + worldDepth) * 0.5 * scale;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const originX = margin + (availWidth - spanX) / 2 - minX;
  const originY = margin + (availHeight - spanY) / 2 - minY;
  return createCamera({ originX, originY, scale });
}

/** World (x, y, z) → screen (CSS px). */
function project(camera, point) {
  if (!camera || !point) return { x: 0, y: 0 };
  const x = finite(point.x, 0);
  const y = finite(point.y, 0);
  const z = finite(point.z, 0);
  return {
    x: camera.originX + (x - y) * camera.scale,
    y: camera.originY + (x + y) * camera.scale * 0.5 - z * camera.scale,
  };
}

/** Screen (CSS px) → world ground point at height `z` (default 0). */
function unproject(camera, screen, z = 0) {
  if (!camera || !screen) return { x: 0, y: 0 };
  const sx = finite(screen.x, camera.originX);
  const sy = finite(screen.y, camera.originY);
  const depth = finite(z, 0);
  const sum = (2 * (sy - camera.originY + depth * camera.scale)) / camera.scale;
  const diff = (sx - camera.originX) / camera.scale;
  return { x: (sum + diff) / 2, y: (sum - diff) / 2 };
}

/** Project a list of {x,y,z} to screen points (polygon helper). */
function projectPolygon(camera, points) {
  if (!Array.isArray(points)) return [];
  return points.map((point) => project(camera, point));
}

/** Stable painter's-algorithm sort (farther first, ties by `id`). */
function sortByDepth(entries) {
  if (!Array.isArray(entries)) return [];
  return [...entries]
    .map((entry) => ({ entry, key: depthKey(entry && entry.point) }))
    .sort((a, b) => {
      if (a.key !== b.key) return a.key - b.key;
      const idA = a.entry && a.entry.id != null ? String(a.entry.id) : '';
      const idB = b.entry && b.entry.id != null ? String(b.entry.id) : '';
      return idA < idB ? -1 : (idA > idB ? 1 : 0);
    })
    .map((item) => item.entry);
}

module.exports = {
  createCamera,
  fitCamera,
  project,
  unproject,
  projectPolygon,
  depthKey,
  sortByDepth,
};
