'use strict';

// test/office-code-office.test.js — P3.1b 代码生成的办公室布局（纯几何）。
//
// 用户 2026-10-27："家具布置是受素材限制拼的，用代码生成一整套布局，大胆一些"。
// 判据：桌/椅/显示器围绕功能锚点（seat）生成，装饰区只落在空闲空间，
// 同一输入输出稳定，越界被夹紧。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { describeOffice, DESK, MONITOR, CHAIR } = require('../src/office/render/code-office.js');

const SEATS = [
  { id: 'desk-1', x: 0.5435, y: 0.2958 },
  { id: 'desk-2', x: 0.7345, y: 0.3000 },
  { id: 'desk-3', x: 0.5400, y: 0.5600 },
  { id: 'desk-4', x: 0.7320, y: 0.5650 },
  { id: 'desk-5', x: 0.5380, y: 0.8200 },
  { id: 'desk-6', x: 0.7310, y: 0.8250 },
];

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

test('generated office: every seat gets a desk, monitor and chair aligned to it', () => {
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  assert.equal(office.workstations.length, 6);
  assert.equal(office.stats.desks, 6);

  for (const station of office.workstations) {
    const { seat, desk, monitor, chair } = station;
    // Desk is centred on the seat and sits just above it.
    assert.ok(Math.abs((desk.x + desk.w / 2) - seat.x) < 1e-9, `${station.seatId}: desk centred`);
    assert.ok(desk.y + desk.h <= seat.y + 0.01, `${station.seatId}: desk stays behind the seat`);
    assert.ok(desk.y + desk.h >= seat.y - 0.02, `${station.seatId}: desk meets the seat`);
    // Monitor on the far edge of the desk, centred on it.
    assert.ok(Math.abs((monitor.x + monitor.w / 2) - seat.x) < 1e-9);
    assert.ok(monitor.y + monitor.h <= desk.y + 0.03, 'monitor sits on the desk top');
    // Chair centred on the seat and spanning it.
    assert.ok(Math.abs((chair.x + chair.w / 2) - seat.x) < 1e-9);
    assert.ok(chair.y <= seat.y && chair.y + chair.h >= seat.y, 'the chair spans the seat point');
    // Desk keyboard is inside the desk.
    assert.ok(station.keyboard.x >= desk.x && station.keyboard.x + station.keyboard.w <= desk.x + desk.w);
  }
});

test('generated office: decorative zones never overlap a workstation', () => {
  const office = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  assert.ok(office.lounge, 'a lounge zone exists in the free lower-left');
  assert.ok(office.kitchen, 'a kitchen counter exists in the free upper-left');
  const boxes = office.workstations.map((s) => ({
    x: Math.min(s.chair.x, s.desk.x),
    y: s.monitor.y,
    w: Math.max(s.chair.x + s.chair.w, s.desk.x + s.desk.w) - Math.min(s.chair.x, s.desk.x),
    h: (s.chair.y + s.chair.h) - s.monitor.y,
  }));
  for (const box of boxes) {
    assert.equal(overlaps(office.lounge.rug, box), false, 'lounge clear of desks');
    assert.equal(overlaps(office.kitchen, box), false, 'kitchen clear of desks');
  }
  assert.equal(overlaps(office.lounge.rug, office.kitchen), false, 'lounge and kitchen are separate');
});

test('generated office: deterministic and independent of input order', () => {
  const a = describeOffice({ scene: { width: 960, height: 630 }, seats: SEATS });
  const reversed = describeOffice({ scene: { width: 960, height: 630 }, seats: [...SEATS].reverse() });
  assert.deepEqual(a.workstations.map((s) => s.seatId), reversed.workstations.map((s) => s.seatId));
  assert.deepEqual(a.workstations[0].desk, reversed.workstations[0].desk);
});

test('generated office: empty / malformed seats produce an empty but valid layout', () => {
  const empty = describeOffice({ scene: { width: 960, height: 630 }, seats: [] });
  assert.equal(empty.workstations.length, 0);
  assert.equal(empty.stats.desks, 0);
  const junk = describeOffice({
    scene: { width: 960, height: 630 },
    seats: [null, { x: 'nope', y: 0.2 }, { x: 2, y: 0.2 }, { x: 0.5, y: 0.5 }],
  });
  assert.equal(junk.workstations.length, 1, 'only valid normalized seats survive');
});

test('generated office: edge seats are clamped inside the scene', () => {
  const office = describeOffice({
    scene: { width: 960, height: 630 },
    seats: [{ id: 'edge', x: 0.005, y: 0.03 }],
  });
  const { desk, monitor } = office.workstations[0];
  assert.ok(desk.x >= 0.01 && desk.x + desk.w <= 0.99);
  assert.ok(monitor.y >= 0.01);
  // The constants stay the documented ones (a scene retune must be deliberate).
  assert.equal(DESK.w, 0.118);
  assert.equal(MONITOR.w, 0.076);
  assert.equal(CHAIR.h, 0.118);
});
