'use strict';

// P3.5: the character pack ships a 1px near-white "art box" guide line on each
// frame's visibleBounds perimeter. The office page strips that ring when it
// builds the texture; these tests pin the pixel contract (what may and may not
// be cleared) and the bounds handling.

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripGuideRing, isGuidePixel } = require('../src/office/render/frame-hygiene.js');

function makeFrame(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3];
  }
  return data;
}

const at = (data, width, x, y) => {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

function paintRing(data, width, bounds, rgba) {
  const x0 = bounds.x;
  const y0 = bounds.y;
  const x1 = bounds.x + bounds.width - 1;
  const y1 = bounds.y + bounds.height - 1;
  const set = (x, y) => {
    const i = (y * width + x) * 4;
    data[i] = rgba[0]; data[i + 1] = rgba[1]; data[i + 2] = rgba[2]; data[i + 3] = rgba[3];
  };
  for (let x = x0; x <= x1; x += 1) { set(x, y0); set(x, y1); }
  for (let y = y0 + 1; y < y1; y += 1) { set(x0, y); set(x1, y); }
}

const BOUNDS = { x: 10, y: 12, width: 20, height: 16 };

test('clears the faint near-white ring on the declared bounds', () => {
  const width = 64;
  const data = makeFrame(width, 64);
  paintRing(data, width, BOUNDS, [255, 255, 255, 90]);

  const cleared = stripGuideRing(data, width, BOUNDS);

  // 20 top + 20 bottom + 14 left + 14 right (corners belong to the rows).
  assert.equal(cleared, 2 * BOUNDS.width + 2 * (BOUNDS.height - 2));
  assert.deepEqual(at(data, width, BOUNDS.x, BOUNDS.y), [0, 0, 0, 0]);
  assert.deepEqual(at(data, width, BOUNDS.x + 5, BOUNDS.y), [0, 0, 0, 0]);
  assert.deepEqual(at(data, width, BOUNDS.x + BOUNDS.width - 1, BOUNDS.y + 8), [0, 0, 0, 0]);
});

test('keeps opaque art that touches the ring', () => {
  const width = 64;
  const data = makeFrame(width, 64);
  paintRing(data, width, BOUNDS, [255, 255, 255, 255]);

  assert.equal(stripGuideRing(data, width, BOUNDS), 0);
  assert.deepEqual(at(data, width, BOUNDS.x, BOUNDS.y), [255, 255, 255, 255]);
});

test('keeps faint pixels that are not near-white', () => {
  const width = 64;
  const data = makeFrame(width, 64);
  paintRing(data, width, BOUNDS, [80, 120, 220, 70]);

  assert.equal(stripGuideRing(data, width, BOUNDS), 0);
  assert.deepEqual(at(data, width, BOUNDS.x, BOUNDS.y), [80, 120, 220, 70]);
});

test('keeps fully transparent and near-opaque near-white pixels', () => {
  assert.equal(isGuidePixel(255, 255, 255, 0), false);
  assert.equal(isGuidePixel(255, 255, 255, 128), false);
  assert.equal(isGuidePixel(255, 255, 255, 127), true);
  assert.equal(isGuidePixel(239, 255, 255, 70), false);
});

test('is idempotent', () => {
  const width = 64;
  const data = makeFrame(width, 64);
  paintRing(data, width, BOUNDS, [252, 253, 250, 102]);

  assert.ok(stripGuideRing(data, width, BOUNDS) > 0);
  assert.equal(stripGuideRing(data, width, BOUNDS), 0);
});

test('ignores missing, malformed and out-of-bounds rects', () => {
  const width = 32;
  const data = makeFrame(width, 32);
  assert.equal(stripGuideRing(data, width, null), 0);
  assert.equal(stripGuideRing(null, width, BOUNDS), 0);
  assert.equal(stripGuideRing(data, width, { x: -1, y: 0, width: 4, height: 4 }), 0);
  assert.equal(stripGuideRing(data, width, { x: 0, y: 0, width: 0, height: 4 }), 0);
  assert.equal(stripGuideRing(data, width, { x: 30, y: 30, width: 8, height: 8 }), 0);
});
