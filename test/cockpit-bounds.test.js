'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MODE_SIZES, computeCockpitBounds } = require('../src/cockpit-bounds');

const main = { x: 100, y: 80, width: 1200, height: 800 };
const display = { x: 0, y: 0, width: 1920, height: 1080 };

test('rail is anchored inside the main window top-right edge', () => {
  const b = computeCockpitBounds(main, display, 'rail');
  assert.equal(b.width, MODE_SIZES.rail.width);
  assert.equal(b.height, MODE_SIZES.rail.height);
  assert.equal(b.x, main.x + main.width - b.width - 12);
  assert.equal(b.y, main.y + 10);
});

test('panel expands left and remains inside a negative-coordinate display', () => {
  const secondary = { x: -1440, y: -120, width: 1440, height: 900 };
  const b = computeCockpitBounds({ x: -1300, y: -50, width: 900, height: 700 }, secondary, 'panel');
  assert.ok(b.x >= secondary.x);
  assert.ok(b.y >= secondary.y);
  assert.ok(b.x + b.width <= secondary.x + secondary.width);
  assert.ok(b.y + b.height <= secondary.y + secondary.height);
});

test('small work areas clamp the requested viewport without negative bounds', () => {
  const tiny = { x: 10, y: 20, width: 260, height: 180 };
  const b = computeCockpitBounds({ x: 10, y: 20, width: 260, height: 180 }, tiny, 'onboarding');
  assert.ok(b.width <= tiny.width);
  assert.ok(b.height <= tiny.height);
  assert.ok(b.x >= tiny.x && b.y >= tiny.y);
});

test('custom viewport keeps stable mode dimensions within available space', () => {
  const b = computeCockpitBounds(main, display, 'peek', { width: 300, height: 210 });
  assert.equal(b.width, 300);
  assert.equal(b.height, 210);
});

test('task peek has a stable viewport and remains clamped to the work area', () => {
  assert.deepEqual(MODE_SIZES.taskpeek, { width: 350, height: 430 });
  const b = computeCockpitBounds(main, display, 'taskpeek');
  assert.equal(b.width, 350);
  assert.equal(b.height, 430);
  assert.ok(b.x >= display.x && b.x + b.width <= display.x + display.width);
  assert.ok(b.y >= display.y && b.y + b.height <= display.y + display.height);
});

test('a dragged rail offset is preserved and clamped inside the work area', () => {
  const main = { x: 100, y: 80, width: 1200, height: 800 };
  const work = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(computeCockpitBounds(main, work, 'rail', null, { x: -300, y: 120 }), {
    x: 740, y: 210, width: 248, height: 44,
  });
  assert.deepEqual(computeCockpitBounds(main, work, 'rail', null, { x: 9999, y: 9999 }), {
    x: 1192, y: 856, width: 248, height: 44,
  });
});
