'use strict';

// M4.1g — idle behavior director (roaming/resting/chatting choice + left rest
// area roaming pool). RED: src/office/runtime/idle-director.js does not exist
// yet.
//
// Contracts under test:
// - deterministic: identical seed + call sequence => identical choices; an
//   injected rng replaces the seeded stream (no Math.random/Date.now anywhere)
// - random with preference: base probabilities roaming 60 / resting 25 /
//   chatting 15, but every activity carries a COOLDOWN so the same behavior is
//   never repeated back to back (resting twice in a row is impossible)
// - all-blocked (or zero-weight) choices degrade to roaming, never stall
// - left rest area: roaming targets may land left of the work columns
//   (x < boundary). The compiled flat layout's left wing (roam-8/roam-9) and
//   the canonical isometric left nodes resolve as that area without any
//   explicit tag; an explicit rest-area/lounge tag wins when a layout has one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const director = require('../src/office/runtime/idle-director.js');
const { createOfficeLayout } = require('../src/office/runtime/office-layout.js');

function makeGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'hall', position: { x: 0.5, y: 0.55 }, tags: ['roaming'], capacity: 4, safeRadius: 0.02 },
      { id: 'desk-1', position: { x: 0.2, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-2', position: { x: 0.4, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'desk-3', position: { x: 0.6, y: 0.2 }, tags: ['desk', 'sleeping'], capacity: 1, safeRadius: 0.04 },
      { id: 'roam-1', position: { x: 0.25, y: 0.7 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'roam-2', position: { x: 0.5, y: 0.8 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'rest-1', position: { x: 0.15, y: 0.45 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
      { id: 'rest-2', position: { x: 0.7, y: 0.65 }, tags: ['resting'], capacity: 1, safeRadius: 0.02 },
      { id: 'quiet-room', position: { x: 0.1, y: 0.9 }, tags: ['roaming'], capacity: 1, safeRadius: 0.02 },
      { id: 'chat-a', position: { x: 0.35, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
      { id: 'chat-b', position: { x: 0.45, y: 0.55 }, tags: ['chatting'], capacity: 1, safeRadius: 0.02 },
    ],
    edges: [
      { from: 'hall', to: 'desk-1', behaviors: ['roaming', 'sleeping'], bidirectional: true },
      { from: 'hall', to: 'desk-2', behaviors: ['roaming', 'sleeping'], bidirectional: true },
      { from: 'hall', to: 'desk-3', behaviors: ['roaming', 'sleeping'], bidirectional: true },
      { from: 'hall', to: 'roam-1', behaviors: ['roaming'], bidirectional: true },
      { from: 'hall', to: 'roam-2', behaviors: ['roaming'], bidirectional: true },
      { from: 'hall', to: 'rest-1', behaviors: ['resting'], bidirectional: true },
      { from: 'hall', to: 'rest-2', behaviors: ['resting'], bidirectional: true },
      { from: 'hall', to: 'quiet-room', behaviors: ['roaming'], bidirectional: true },
      { from: 'hall', to: 'chat-a', behaviors: ['chatting'], bidirectional: true },
      { from: 'hall', to: 'chat-b', behaviors: ['chatting'], bidirectional: true },
    ],
  };
}

function flatLayoutGraph() {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8')
  );
  return createOfficeLayout(fixture).waypointGraph();
}

function canonicalLayoutGraph() {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'fixtures', 'office-layout.json'), 'utf8')
  );
  return createOfficeLayout(fixture).waypointGraph();
}

test('module exposes the director factory and frozen defaults', () => {
  assert.equal(typeof director.createIdleDirector, 'function');
  assert.deepEqual(director.DEFAULT_PROBABILITIES, { roaming: 0.6, resting: 0.25, chatting: 0.15 });
  assert.ok(director.DEFAULT_COOLDOWNS_MS.resting > 0, 'resting carries a cooldown');
  assert.ok(director.DEFAULT_COOLDOWNS_MS.chatting > 0, 'chatting carries a cooldown');
  assert.equal(director.DEFAULT_COOLDOWNS_MS.roaming, 0, 'roaming is the filler: no cooldown');
  assert.ok(director.DEFAULT_LEFT_ROAM_BIAS > 0 && director.DEFAULT_LEFT_ROAM_BIAS < 1);
});

test('same seed and call sequence reproduce identical choices', () => {
  function replay(seed) {
    const d = director.createIdleDirector({ seed });
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      const at = i * 5000;
      const pick = d.choose({ employeeId: 'coder', atMs: at });
      d.note({ employeeId: 'coder', activity: pick.activity, atMs: at });
      out.push(`${pick.activity}@${at}`);
    }
    return out.join('|');
  }
  assert.equal(replay('seed-a'), replay('seed-a'));
  assert.notEqual(replay('seed-a'), replay('seed-b'));
});

test('an injected rng makes the choice fully deterministic without any seed', () => {
  const script = [0.05, 0.95, 0.5, 0.7, 0.99, 0.2];
  let index = 0;
  const scripted = () => script[index++ % script.length];
  const d = director.createIdleDirector({ rng: scripted });
  const picks = [];
  for (let i = 0; i < 6; i += 1) {
    // far apart in time so no cooldown blocks anything: the pick follows the
    // injected roll alone (0.05/0.5/0.2 -> roaming, 0.95/0.99 -> chatting,
    // 0.7 -> resting)
    picks.push(d.choose({ employeeId: 'coder', atMs: i * 600000 }).activity);
  }
  assert.deepEqual(picks, ['roaming', 'chatting', 'roaming', 'resting', 'chatting', 'roaming']);
});

test('resting never repeats back to back: the cooldown blocks the second pick', () => {
  const d = director.createIdleDirector({ seed: 'rest-repeat' });
  d.note({ employeeId: 'coder', activity: 'resting', atMs: 0 });
  for (let at = 1000; at <= director.DEFAULT_COOLDOWNS_MS.resting - 1000; at += 1000) {
    const pick = d.choose({ employeeId: 'coder', atMs: at });
    assert.notEqual(pick.activity, 'resting',
      `resting must stay on cooldown inside ${director.DEFAULT_COOLDOWNS_MS.resting}ms (at ${at})`);
    assert.equal(pick.weights.resting.blocked, true);
  }
  const cooled = d.choose({ employeeId: 'coder', atMs: director.DEFAULT_COOLDOWNS_MS.resting + 1 });
  assert.equal(cooled.weights.resting.blocked, false, 'resting is available again after the cooldown');
});

test('a long run never repeats resting (or chatting) on consecutive decisions', () => {
  const d = director.createIdleDirector({ seed: 'long-run' });
  let previous = null;
  let resting = 0;
  let chatting = 0;
  let roaming = 0;
  for (let i = 0; i < 400; i += 1) {
    const at = i * 5000; // 5s cadence, well inside the cooldowns
    const pick = d.choose({ employeeId: 'coder', atMs: at });
    if (pick.activity === 'resting') {
      resting += 1;
      assert.notEqual(previous, 'resting', 'no resting immediately after resting');
    }
    if (pick.activity === 'chatting') {
      chatting += 1;
      assert.notEqual(previous, 'chatting', 'no chatting immediately after chatting');
    }
    roaming += pick.activity === 'roaming' ? 1 : 0;
    previous = pick.activity;
    d.note({ employeeId: 'coder', activity: pick.activity, atMs: at });
  }
  assert.ok(resting > 5, `resting still happens (${resting})`);
  assert.ok(chatting > 5, `chatting still happens (${chatting})`);
  assert.ok(roaming > resting, `roaming stays the preferred filler (${roaming} vs ${resting})`);
});

test('every activity blocked (or zero weight) degrades to roaming, never a stall', () => {
  const zero = director.createIdleDirector({ seed: 'zero', probabilities: { roaming: 0, resting: 0, chatting: 0 } });
  const pick = zero.choose({ employeeId: 'coder', atMs: 0 });
  assert.equal(pick.activity, 'roaming');
  assert.equal(pick.reason, 'idle-director:fallback');

  const cooldownOnly = director.createIdleDirector({ seed: 'cooled', cooldownsMs: { roaming: 60000, resting: 60000, chatting: 60000 } });
  cooldownOnly.note({ employeeId: 'coder', activity: 'resting', atMs: 0 });
  const blocked = cooldownOnly.choose({ employeeId: 'coder', atMs: 1000 });
  assert.equal(blocked.activity, 'roaming', 'nothing choosable => roaming fallback');
});

test('left rest area resolves from the real layout graphs', () => {
  const flatGraph = flatLayoutGraph();
  const flat = director.resolveLeftAreaNodeIds(flatGraph);
  // M4.1h: the compiled flat layout DECLARES its break area (rest-area tags on
  // the six left-column nodes), and an explicit declaration REPLACES the
  // geometric guess — the geometric rule survives for layouts that declare
  // nothing (the canonical isometric fixture below). roam-6/roam-7 were only in
  // the old pool through that guess: they sit right of the left half.
  assert.deepEqual(flat, ['roam-10', 'roam-11', 'roam-12', 'roam-13', 'roam-15', 'roam-16'],
    'the compiled flat layout break area is the six tagged left-column nodes');
  for (const id of flat) {
    const node = flatGraph.nodes.find((entry) => entry.id === id);
    assert.ok(node.position.x < 0.5, `${id} is in the left half`);
  }
  assert.equal(director.leftPreferenceActive(flatGraph), true,
    'the flat layout break area always gets the preference (the old minority-share cliff is gone)');
  // the old cliff: a left pool that grew past half of the roaming candidates
  // used to switch the preference OFF. It is now unconditionally on.
  assert.equal(director.leftPreferenceActive(canonicalLayoutGraph()), true,
    'the preference no longer depends on the left/right share of the pool');

  const canonicalGraph = canonicalLayoutGraph();
  const canonical = director.resolveLeftAreaNodeIds(canonicalGraph);
  assert.ok(canonical.includes('roam-1') && canonical.includes('roam-5'),
    `canonical left nodes resolve as the rest area (${canonical.join(',')})`);
  for (const id of canonical) {
    const node = canonicalGraph.nodes.find((entry) => entry.id === id);
    assert.ok(node.position.x < director.corridorBoundaryX(canonicalGraph),
      `${id} is left of the corridor mid`);
  }
  // the canonical layout's left area is a minority of its ring too, so the
  // preference applies there as well (the rule is about the SHARE of the pool,
  // not about which layout runs)
  assert.equal(director.leftPreferenceActive(canonicalGraph), true,
    'a minority left pool gets the preference in every layout');

  const test = director.resolveLeftAreaNodeIds(makeGraph());
  assert.deepEqual(test, ['quiet-room', 'roam-1'], 'the synthetic graph resolves its left nodes');
});

test('an explicit rest-area declaration replaces the geometric guess', () => {
  const graph = makeGraph();
  graph.nodes.push({ id: 'couch-spot', position: { x: 0.9, y: 0.1 }, tags: ['roaming', 'rest-area'], capacity: 1, safeRadius: 0.02 });
  const left = director.resolveLeftAreaNodeIds(graph);
  // M4.1h: an explicit declaration WINS ENTIRELY (it used to be unioned with the
  // geometric left). The union made a declared layout mix in nodes that are not
  // in the break area at all — on the compiled flat layout it dragged the
  // bottom-aisle transit node into the "left" target pool.
  assert.deepEqual(left, ['couch-spot'], 'an explicitly declared break area is exactly those nodes');
  // restAreaTaggedNodeIds is the strict, tag-only pool the break-area promises
  // (the longer roam hold) are keyed on, so a synthetic graph never inherits
  // them by accident.
  assert.deepEqual(director.restAreaTaggedNodeIds(graph), ['couch-spot']);
  // a layout with NO declaration keeps the geometric rule (iso + graph)
  assert.deepEqual(director.restAreaTaggedNodeIds(makeGraph()), []);
  assert.ok(director.resolveLeftAreaNodeIds(makeGraph()).includes('quiet-room'));
});

test('corridorBoundaryX is the mid x of the roaming ring', () => {
  const flatGraph = flatLayoutGraph();
  const flat = director.corridorBoundaryX(flatGraph);
  const roamXs = flatGraph.nodes
    .filter((node) => node.tags.includes('roaming') && !node.id.startsWith('desk-'))
    .map((node) => node.position.x)
    .sort((a, b) => a - b);
  const expected = roamXs.length % 2 === 1
    ? roamXs[(roamXs.length - 1) / 2]
    : (roamXs[roamXs.length / 2 - 1] + roamXs[roamXs.length / 2]) / 2;
  assert.equal(flat, expected, 'the boundary is the ring median');
  // desk/workstation nodes (approach/leave are roaming-tagged) and the M4.1h
  // transit-only wing nodes (roam-8/roam-9/roam-14 — they carry no `roaming`
  // tag, so their x never votes on the boundary) are excluded
  assert.equal(flatGraph.nodes.filter((node) => node.tags.includes('roaming') && !node.id.startsWith('desk-')).length, 13);
  // no roaming nodes at all: pure geometry fallback (median of node xs)
  const noRoam = { nodes: [{ id: 'a', position: { x: 0.1 }, tags: ['desk'] }, { id: 'b', position: { x: 0.4 }, tags: ['desk'] }, { id: 'c', position: { x: 0.9 }, tags: ['desk'] }], edges: [] };
  assert.equal(director.corridorBoundaryX(noRoam), 0.4);
});

test('the left roam bias is a seeded preference, roughly the configured share', () => {
  const d = director.createIdleDirector({ seed: 'bias', leftRoamBias: 0.5 });
  let left = 0;
  const draws = 4000;
  for (let i = 0; i < draws; i += 1) {
    if (d.prefersLeftArea({ employeeId: `emp-${i % 5}` })) left += 1;
  }
  const share = left / draws;
  assert.ok(Math.abs(share - 0.5) < 0.05, `left preference share ${share}`);
});

test('the director source avoids Date.now and Math.random', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'office', 'runtime', 'idle-director.js'), 'utf8');
  assert.doesNotMatch(source, /Math\.random|Date\.now/);
});
