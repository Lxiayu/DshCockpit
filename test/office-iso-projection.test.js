'use strict';

// test/office-iso-projection.test.js — P3 等轴测投影内核（I0）。
//
// 判据：投影/反投影可逆、相机能把世界footprint 装进视口且居中、
// 深度键单调、排序稳定；全部是纯函数，不依赖 Pixi/Electron。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createCamera,
  fitCamera,
  project,
  unproject,
  projectPolygon,
  depthKey,
  sortByDepth,
} = require('../src/office/render/iso-projection.js');

test('iso: project/unproject round-trips on the ground plane', () => {
  const camera = createCamera({ originX: 480, originY: 120, scale: 300 });
  for (const point of [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.75 },
    { x: 1, y: 1 },
    { x: 0.5, y: 0.5, z: 0.3 },
  ]) {
    const screen = project(camera, point);
    const back = unproject(camera, screen, point.z || 0);
    assert.ok(Math.abs(back.x - point.x) < 1e-9, `x round-trip (${point.x})`);
    assert.ok(Math.abs(back.y - point.y) < 1e-9, `y round-trip (${point.y})`);
  }
});

test('iso: height lifts the point up the screen, never sideways', () => {
  const camera = createCamera({ originX: 0, originY: 0, scale: 100 });
  const ground = project(camera, { x: 0.4, y: 0.3, z: 0 });
  const lifted = project(camera, { x: 0.4, y: 0.3, z: 0.2 });
  assert.equal(lifted.x, ground.x);
  assert.ok(Math.abs((ground.y - lifted.y) - 0.2 * 100) < 1e-9);
});

test('iso: fitCamera keeps the whole footprint inside the viewport and centres it', () => {
  const camera = fitCamera({ width: 960, height: 630, worldWidth: 1, worldDepth: 1, maxHeight: 0.12, margin: 24 });
  const corners = [
    { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
    { x: 0.5, y: 0.5, z: 0.12 },
  ].map((point) => project(camera, point));
  for (const point of corners) {
    assert.ok(point.x >= 24 - 1e-6 && point.x <= 936 + 1e-6, `x inside: ${point.x}`);
    assert.ok(point.y >= 24 - 1e-6 && point.y <= 606 + 1e-6, `y inside: ${point.y}`);
  }
  // The diamond's horizontal centre is the viewport centre.
  const left = project(camera, { x: 0, y: 1 }).x;
  const right = project(camera, { x: 1, y: 0 }).x;
  assert.ok(Math.abs((left + right) / 2 - 480) < 1e-6);
});

test('iso: fitCamera scales down when the viewport shrinks', () => {
  const big = fitCamera({ width: 1280, height: 840, worldWidth: 1, worldDepth: 1 });
  const small = fitCamera({ width: 480, height: 320, worldWidth: 1, worldDepth: 1 });
  assert.ok(small.scale < big.scale);
  assert.ok(small.scale >= 1);
});

test('iso: depth key is monotone along the view direction and stable on ties', () => {
  assert.ok(depthKey({ x: 0.2, y: 0.2 }) < depthKey({ x: 0.6, y: 0.6 }));
  const entries = [
    { id: 'b', point: { x: 0.6, y: 0.6 } },
    { id: 'a', point: { x: 0.2, y: 0.2 } },
    { id: 'c', point: { x: 0.2, y: 0.2 } },
  ];
  assert.deepEqual(sortByDepth(entries).map((entry) => entry.id), ['a', 'c', 'b']);
  // The input array is not mutated.
  assert.equal(entries[0].id, 'b');
});

test('iso: malformed input never produces NaN', () => {
  const camera = createCamera();
  const projected = project(camera, { x: 'nope', y: undefined, z: null });
  assert.ok(Number.isFinite(projected.x) && Number.isFinite(projected.y));
  const back = unproject(camera, { x: NaN, y: undefined });
  assert.ok(Number.isFinite(back.x) && Number.isFinite(back.y));
  assert.deepEqual(projectPolygon(camera, null), []);
  assert.deepEqual(sortByDepth(null), []);
});
