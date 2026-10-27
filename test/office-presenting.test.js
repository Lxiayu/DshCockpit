'use strict';

// test/office-presenting.test.js — v0.7 P1.5：悬停呈现（暂停 + 转正面，纯呈现）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const assetPack = require('../src/office/runtime/asset-pack.js');
const officeModule = require('../src/office/office-module.js');

function makeOffice() {
  const P = path.join(__dirname, '..', 'src', 'office', 'fixtures', 'character-pack');
  const pack = assetPack.createAssetPack({
    manifest: JSON.parse(fs.readFileSync(path.join(P, 'manifest.json'), 'utf8')),
    anchors: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'anchors.json'), 'utf8')),
    animations: JSON.parse(fs.readFileSync(path.join(P, 'animation', 'animations.json'), 'utf8')),
  }).pack;
  return officeModule.createOfficeModule({ pack, seed: 'presenting-seed', log: () => {} });
}

function seatOf(office, id) {
  return office.state().employees.find((entry) => entry.employeeId === id);
}

test('presenting: the hovered employee freezes in place, faces front, and only one is presented', () => {
  const office = makeOffice();
  const ids = office.state().employees.map((entry) => entry.employeeId);
  const first = ids[0];
  const second = ids[1];
  const before = seatOf(office, first).position;
  const result = office.setPresenting({ employeeId: first, presenting: true });
  assert.equal(result.ok, true);
  assert.equal(result.presenting, first);
  const seat = seatOf(office, first);
  assert.equal(seat.presenting, true);
  assert.equal(seat.facing, 'down', 'front-facing');
  for (let i = 0; i < 20; i += 1) office.advanceOneTick();
  const after = seatOf(office, first);
  assert.deepEqual({ x: after.position.x, y: after.position.y }, { x: before.x, y: before.y },
    'a presented employee does not move while hovered');
  assert.equal(after.presenting, true);

  // switching the hover target clears the previous one
  assert.equal(office.setPresenting({ employeeId: second, presenting: true }).ok, true);
  assert.equal(seatOf(office, first).presenting, false);
  assert.equal(seatOf(office, second).presenting, true);

  // release clears everything
  const cleared = office.setPresenting({ presenting: false });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.presenting, null);
  assert.equal(office.state().employees.some((entry) => entry.presenting), false);
});

test('presenting: an unknown seat fails closed and changes nothing', () => {
  const office = makeOffice();
  const before = office.state().employees.map((entry) => entry.presenting);
  const verdict = office.setPresenting({ employeeId: 'no-such-seat', presenting: true });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'TEAM_SEAT_UNKNOWN');
  assert.deepEqual(office.state().employees.map((entry) => entry.presenting), before);
});
