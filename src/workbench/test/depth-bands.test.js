'use strict';

// src/workbench/test/depth-bands.test.js — the layer→depth-band readout
// (workbench UX rectification, gap #2: 选中物件的数值属性).
//
// The layout's layer is DEPTH (larger draws further front) and the product schema
// pins a default per kind: monitor 10 · chair 20 · prop 25 · character 30 ·
// desk 40. The inspector's band line must say which band a typed number lands in
// — exactly on a band, between two, in front of everything, or behind the first.
// Run with:  node --test "src/workbench/test/*.test.js"

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEPTH_BANDS, bandOf } = require('../lib/depth-bands.js');

test('the bands are the schema\'s own defaults, in paint order', () => {
  assert.deepEqual(DEPTH_BANDS.map((band) => [band.kind, band.layer]), [
    ['monitor', 10], ['chair', 20], ['prop', 25], ['character', 30], ['desk', 40],
  ]);
});

test('a layer exactly on a band names that band', () => {
  for (const band of DEPTH_BANDS) {
    const result = bandOf(band.layer);
    assert.equal(result.kind, 'on', `${band.layer} is the ${band.kind} band itself`);
    assert.equal(result.band.kind, band.kind);
    assert.equal(result.above, null);
  }
});

test('a layer between two bands names both neighbours', () => {
  const between = bandOf(35);
  assert.equal(between.kind, 'between');
  assert.equal(between.band.kind, 'character');
  assert.equal(between.above.kind, 'desk');
  // 10 < layer < 20 is still "between monitor and chair", not "on chair"
  const low = bandOf(15);
  assert.equal(low.kind, 'between');
  assert.equal(low.band.kind, 'monitor');
  assert.equal(low.above.kind, 'chair');
});

test('above the top band is "in front of everything"', () => {
  const front = bandOf(45);
  assert.equal(front.kind, 'front');
  assert.equal(front.band.kind, 'desk');
  assert.equal(front.above, null);
});

test('below the first band is "behind the monitor band"', () => {
  const below = bandOf(5);
  assert.equal(below.kind, 'below');
  assert.equal(below.band, null);
  assert.equal(below.above.kind, 'monitor');
});

test('a non-number has no band (the caller falls back to the ladder)', () => {
  // Number('') and Number(null) are 0 — treating those as "layer 0" would put a
  // blank field in front of the monitor band, so they are rejected outright
  assert.equal(bandOf(''), null);
  assert.equal(bandOf('   '), null);
  assert.equal(bandOf(null), null);
  assert.equal(bandOf(undefined), null);
  assert.equal(bandOf('abc'), null);
  assert.equal(bandOf(NaN), null);
  assert.equal(bandOf(Infinity), null);
});
