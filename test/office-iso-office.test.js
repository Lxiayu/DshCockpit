'use strict';

// I2: isometric furniture geometry. These tests pin the functional contract
// (a desk behind the seat, a chair under it, decor never on a workstation) and
// the painter ordering relationships the renderer relies on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { describeIsoOffice, SIZES } = require('../src/office/render/iso-office.js');

const FIXTURE = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'office-layout-flat.json');

function fixtureSeats() {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return fixture.workstations.instances.map((instance) => ({
    id: instance.deskId,
    x: instance.seat.position.x,
    y: instance.seat.position.y,
  }));
}

function stationParts(parts, seatId) {
  return parts.filter((part) => part.id.startsWith(`${seatId}-`));
}

function contains(part, x, y) {
  return x >= part.x0 && x <= part.x1 && y >= part.y0 && y <= part.y1;
}

test('iso office: every fixture seat gets a desk behind it and a chair under it', () => {
  const seats = fixtureSeats();
  const office = describeIsoOffice({ seats });

  assert.equal(office.stats.stationCount, 6);
  assert.equal(office.stats.deskCount, 6);
  assert.equal(office.stats.chairCount, 12); // backrest + cushion per seat

  for (const seat of seats) {
    const parts = stationParts(office.parts, seat.id);
    const desk = parts.find((part) => part.kind === 'desk');
    const chairSeat = parts.find((part) => part.id === `${seat.id}-chair-seat`);
    const chairBack = parts.find((part) => part.id === `${seat.id}-chair-back`);
    const monitor = parts.find((part) => part.id === `${seat.id}-monitor`);

    assert.ok(desk && chairSeat && chairBack && monitor, `station ${seat.id} is incomplete`);
    // Desk sits behind (smaller y) the seated body and spans the seat column.
    assert.ok(desk.y1 <= seat.y, `desk front edge must stay behind the seat (${seat.id})`);
    assert.ok(seat.x > desk.x0 && seat.x < desk.x1, `seat must be inside the desk span (${seat.id})`);
    // The cushion contains the foot point; the backrest is behind it.
    assert.ok(contains(chairSeat, seat.x, seat.y), `chair cushion must contain the seat point (${seat.id})`);
    assert.ok(chairBack.y1 <= chairSeat.y1, `backrest must sit behind the cushion (${seat.id})`);
    // Monitor stands on the desk top.
    assert.ok(Math.abs(monitor.z0 - SIZES.desk.top) < 0.02, `monitor must stand on the desk (${seat.id})`);
  }
});

test('iso office: painter keys put the seated body between desk and cushion', () => {
  const seats = fixtureSeats();
  const office = describeIsoOffice({ seats });
  for (const seat of seats) {
    const parts = stationParts(office.parts, seat.id);
    const byId = (suffix) => parts.find((part) => part.id === `${seat.id}-${suffix}`);
    const desk = byId('desk');
    const monitor = byId('monitor');
    const back = byId('chair-back');
    const cushion = byId('chair-seat');
    const characterDepth = seat.x + seat.y;

    assert.ok(monitor.depth < desk.depth, `monitor must draw behind the desk top (${seat.id})`);
    assert.ok(desk.depth < characterDepth, `desk must draw behind the character (${seat.id})`);
    assert.ok(back.depth < characterDepth, `backrest must draw behind the character (${seat.id})`);
    // The cushion stays behind the body (a seated person covers it); its front
    // edge still reaches past the foot point so the seat reads under her.
    assert.ok(back.depth < cushion.depth, `cushion must draw in front of the backrest (${seat.id})`);
    assert.ok(cushion.y1 > seat.y, `cushion must extend in front of the foot point (${seat.id})`);
  }
});

test('iso office: heights are positive and inside the room walls', () => {
  const office = describeIsoOffice({ seats: fixtureSeats() });
  for (const part of office.parts) {
    assert.ok(part.z1 > part.z0, `${part.id} must have positive height`);
    assert.ok(part.z0 >= 0 && part.z1 <= 0.34, `${part.id} height out of the room (${part.z0}..${part.z1})`);
    assert.ok(part.x0 >= 0.01 && part.x1 <= 0.99, `${part.id} leaves the room in x`);
    assert.ok(part.y0 >= 0 && part.y1 <= 1, `${part.id} leaves the room in y`);
  }
});

test('iso office: ids are unique and the output is deterministic', () => {
  const seats = fixtureSeats();
  const a = describeIsoOffice({ seats });
  const b = describeIsoOffice({ seats: seats.map((seat) => ({ ...seat })) });
  assert.deepEqual(a, b);
  const ids = new Set(a.parts.map((part) => part.id));
  assert.equal(ids.size, a.parts.length);
});

test('iso office: decor never overlaps a workstation footprint', () => {
  const seats = fixtureSeats();
  const office = describeIsoOffice({ seats });
  const stations = seats.map((seat) => {
    const parts = stationParts(office.parts, seat.id);
    return {
      x0: Math.min(...parts.map((part) => part.x0)),
      y0: Math.min(...parts.map((part) => part.y0)),
      x1: Math.max(...parts.map((part) => part.x1)),
      y1: Math.max(...parts.map((part) => part.y1)),
    };
  });
  const decor = office.parts.filter((part) => !seats.some((seat) => part.id.startsWith(`${seat.id}-`)));
  assert.ok(decor.length > 0, 'the fixture leaves room for decoration');
  for (const part of decor) {
    for (const station of stations) {
      const overlaps = !(part.x1 <= station.x0 + 1e-9 || station.x1 <= part.x0 + 1e-9
        || part.y1 <= station.y0 + 1e-9 || station.y1 <= part.y0 + 1e-9);
      assert.equal(overlaps, false, `${part.id} overlaps a workstation`);
    }
  }
});

test('iso office: a crowded room drops decoration instead of overdrawing desks', () => {
  // A 5×5 grid of workstations covers every decor candidate.
  const seats = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      seats.push({ id: `s${row}${col}`, x: 0.1 + col * 0.2, y: 0.1 + row * 0.2 });
    }
  }
  const office = describeIsoOffice({ seats });
  assert.equal(office.stats.stationCount, 25);
  assert.equal(office.stats.lounge, false);
  assert.equal(office.stats.kitchen, false);
  assert.equal(office.stats.plantCount, 0);
  for (const part of office.parts) {
    assert.ok(seats.some((seat) => part.id.startsWith(`${seat.id}-`)), `${part.id} slipped into a full room`);
  }
});

test('iso office: malformed seats are ignored and duplicate ids are made unique', () => {
  const office = describeIsoOffice({
    seats: [
      { id: 'dup', x: 0.5, y: 0.4 },
      { id: 'dup', x: 0.7, y: 0.4 },
      { id: 'out', x: 2, y: 0.5 },
      null,
      { x: 'nope', y: 0.2 },
    ],
  });
  assert.equal(office.stats.stationCount, 2);
  const ids = new Set(office.parts.map((part) => part.id));
  assert.equal(ids.size, office.parts.length);
  assert.ok([...ids].some((id) => id.startsWith('dup#')));
});
