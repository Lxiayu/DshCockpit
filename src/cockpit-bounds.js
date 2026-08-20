'use strict';

const MODE_SIZES = Object.freeze({
  rail: Object.freeze({ width: 248, height: 44 }),
  peek: Object.freeze({ width: 320, height: 230 }),
  taskpeek: Object.freeze({ width: 350, height: 430 }),
  panel: Object.freeze({ width: 380, height: 600 }),
  onboarding: Object.freeze({ width: 420, height: 420 }),
});

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function computeCockpitBounds(mainBounds, displayWorkArea, mode, viewport, offset) {
  const main = mainBounds || {};
  const display = displayWorkArea || {};
  const requested = viewport || MODE_SIZES[mode] || MODE_SIZES.rail;
  const displayX = finite(display.x, 0);
  const displayY = finite(display.y, 0);
  const displayW = Math.max(1, finite(display.width, requested.width));
  const displayH = Math.max(1, finite(display.height, requested.height));
  const width = Math.min(Math.max(1, finite(requested.width, MODE_SIZES.rail.width)), displayW);
  const height = Math.min(Math.max(1, finite(requested.height, MODE_SIZES.rail.height)), displayH);
  const mainX = finite(main.x, displayX);
  const mainY = finite(main.y, displayY);
  const mainW = Math.max(1, finite(main.width, displayW));
  const dx = finite(offset && offset.x, 0);
  const dy = finite(offset && offset.y, 0);
  const top = mainY + 10 + dy;
  const right = mainX + mainW - width - 12 + dx;
  const x = Math.max(displayX, Math.min(right, displayX + displayW - width));
  const y = Math.max(displayY, Math.min(top, displayY + displayH - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = { MODE_SIZES, computeCockpitBounds };
